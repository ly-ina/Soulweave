/**
 * core/soul-index.mjs —— soul-index 原文库检索（纯 JS，不 spawn python）。
 *
 * 背景（2026-11-26）：这条路原来跑 query.py，靠子进程 + Python 才通。
 * 1.0 要能脱离 Node，等于把「原文库检索」整条砍掉——纳说「缺了这个会很难受」。
 * 但看一眼 query.py 就会发现它只干三件事：读 dict.json、查 sqlite 的 msg_fts、
 * 拼摘要。重复实现一遍约 200 行，换来的是：只要有 sqlite 驱动 + 能读文件，
 * 任何宿主都能检索原文库。
 *
 * 与 query.py 的差异（有意为之）：
 *   - 不做 maybe_refresh()。刷新要跑 node dump.mjs + python build.py，那是宿主的
 *     事；本模块只读现有索引，并回 stale 标记让上层决定要不要刷新。
 *   - 不打印、不 exit。结果一律走返回值。
 *
 * 检索策略与 query.py 保持一致（改这里要同步改 query.py，或干脆退役它）：
 *   1. 长词（>=3 字）走 FTS5 trigram，bm25 排序
 *   2. 短词（<3 字）走 LIKE，按命中词数 + 时间倒序 + 正文长度
 *   3. 中文长词切二元组再 LIKE 兜底（trigram 对「跨词」不友好）
 *   4. 全空则用原始 token LIKE
 */
import { existsSync, readFileSync } from '../io.mjs'
import { openReadonly } from '../storage/index.mjs'

/** 「今天 / 昨晚 / 前天」直接折算成时间窗的起止（本地日历日）。 */
const DAY_WORDS = [
  ['今天', 0],
  ['今日', 0],
  ['昨晚', 1],
  ['昨天', 1],
  ['前天', 2],
  ['大前天', 3],
]

const SEP = /[\s,，、。;；:：/|｜\\()（）[\]【】「」『』"”]+/
const CJK = /^[\u4e00-\u9fff]$/

function isCjk(ch) {
  return CJK.test(ch)
}

/** 中文二元组：只有相邻两字都是汉字才取。 */
export function cjkBigrams(s) {
  const out = []
  const text = String(s ?? '')
  for (let i = 0; i < text.length - 1; i += 1) {
    const bg = text.slice(i, i + 2)
    if (isCjk(bg[0]) && isCjk(bg[1])) out.push(bg)
  }
  return out
}

/** dict.json 的 groups 展开成「任一词 → 同组其它词」的双向表。读不到就当没有同义词。 */
export function loadSynonyms(dictPath) {
  const map = new Map()
  if (!dictPath || !existsSync(dictPath)) return map
  try {
    const raw = JSON.parse(readFileSync(dictPath, 'utf8'))
    const groups = Array.isArray(raw?.groups) ? raw.groups : []
    for (const group of groups) {
      if (!Array.isArray(group)) continue
      for (const word of group) {
        const key = String(word ?? '')
        if (!key) continue
        if (!map.has(key)) map.set(key, new Set())
        for (const other of group) {
          if (other !== word) map.get(key).add(String(other))
        }
      }
    }
  } catch {
    /* dict 坏了不影响检索，只是没有同义词 */
  }
  return map
}

/** 词 → 它自己 + 词内同义替换（长词里夹着同义词也能换掉）。 */
export function expandWord(word, synonyms) {
  const out = new Set([word])
  for (const [key, alts] of synonyms ?? []) {
    if (!key || !word.includes(key)) continue
    for (const alt of alts) out.add(word.split(key).join(alt))
  }
  return out
}

/** 把命中位置附近 160 字抠出来，压成一行。 */
export function makeSnip(text, words, width = 160) {
  const src = String(text ?? '')
  let pos = -1
  for (const w of words ?? []) {
    if (!w) continue
    const p = src.indexOf(w)
    if (p >= 0 && (pos < 0 || p < pos)) pos = p
  }
  if (pos < 0) pos = 0
  const start = Math.max(0, pos - 40)
  return src.slice(start, start + width).replace(/\n/g, ' ')
}

/** 本地日历日的时间窗 [from, to) 毫秒。 */
function dayRange(now, offsetDays) {
  const base = new Date(now)
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() - offsetDays, 0, 0, 0, 0)
  const end = new Date(start.getTime())
  end.setDate(end.getDate() + 1)
  return [start.getTime(), end.getTime()]
}

function formatWhen(ms) {
  if (!ms) return '??'
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/**
 * 在原文库里检索。
 *
 * @param {{dbPath:string, dictPath?:string, query:string, limit?:number, includeTool?:boolean, onlyTool?:boolean, rawOnly?:boolean, noTool?:boolean, now?:number}} options
 * @returns {object} `{ok, entries, note, degraded, reason?, stale?}`；
 *   `entries` 每条是 `{when, role, origin, sid, seq, snippet, score}`。
 */
export function searchSoulIndex(options = {}) {
  const dbPath = String(options.dbPath ?? '')
  const query = String(options.query ?? '').trim()
  const limit = Math.max(1, Math.min(50, Number(options.limit ?? 8) || 8))
  const now = Number(options.now ?? Date.now())

  if (!query) return { ok: true, entries: [], note: '查询为空', degraded: false }
  if (!dbPath) return { ok: false, entries: [], note: '原文库未配置（缺 dbPath）', degraded: true, reason: 'no-db' }

  const db = openReadonly(dbPath)
  if (!db) {
    return {
      ok: false,
      entries: [],
      note: '原文库打不开：没有可用的存储驱动，或库文件不存在',
      degraded: true,
      reason: 'db-unavailable',
    }
  }

  // 原文库检索以顺序扫描为主（2 字中文词用不上 trigram 索引）。
  // mmap 让 12 万行的 LIKE 从 ~300ms 降到 ~120ms，大页缓存再省一点重复扫描。
  try {
    db.exec('PRAGMA mmap_size=268435456; PRAGMA cache_size=-32768')
  } catch {
    /* 驱动不支持 pragma 就算了，不影响检索 */
  }

  try {
    return { ok: true, ...runQuery(db, { ...options, query, limit, now }), degraded: false }
  } catch (e) {
    return { ok: false, entries: [], note: '原文库查询失败：' + (e?.message || e), degraded: true, reason: 'query-failed' }
  } finally {
    try {
      db.close()
    } catch {
      /* 关不掉不影响结果 */
    }
  }
}

function runQuery(db, options) {
  const { query, limit, now, dictPath = '', includeTool = false, onlyTool = false, rawOnly = false, noTool = false } = options
  const synonyms = loadSynonyms(dictPath)

  const where = []
  if (onlyTool) where.push("m.origin = 'tool'")
  else if (!includeTool) where.push("m.origin <> 'tool'")
  if (noTool) where.push("m.role <> 'tool'")
  if (rawOnly) where.push("m.origin = 'raw'")

  let text = query
  // 时间窗单独收着，不直接塞进 LIKE 的 SQL：一旦带上 m.time 条件，
  // SQLite 就不再走「主键倒序 + 命中即停」，会退化成全表扫（今天+压缩从 10ms 变 280ms）。
  // 所以按 id 倒序取一批候选，时间窗在 JS 里过滤。
  const timeWindows = []
  for (const [word, offset] of DAY_WORDS) {
    if (!text.includes(word)) continue
    const [from, to] = dayRange(now, offset)
    timeWindows.push([from, to])
    text = text.split(word).join(' ')
  }
  text = text.trim() || query

  const timeSql = timeWindows.map(([f, t]) => 'm.time >= ' + f + ' AND m.time < ' + t).join(' AND ')
  const filterSql = (where.length > 0 ? ' AND ' + where.join(' AND ') : '') + (timeSql ? ' AND ' + timeSql : '')
  const tokens = text.split(SEP).filter(Boolean)
  const phrases = new Set([query])
  for (const token of tokens) {
    for (const p of expandWord(token, synonyms)) phrases.add(p)
  }
  const longPhrases = [...phrases].filter((p) => p.length >= 3).sort()
  const shortPhrases = [...phrases].filter((p) => p.length < 3).sort()
  const bigrams = [...new Set(tokens.flatMap((t) => cjkBigrams(t)))].sort()
  const allWords = [...new Set([...phrases, ...bigrams])].sort()

  const rows = []
  const seen = new Set()
  const add = (list) => {
    for (const row of list) {
      const key = String(row.sid) + '#' + String(row.seq)
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
  }

  const fts = (expr, n) => {
    const sql =
      'SELECT m.sid, m.seq, m.time, m.role, m.origin, m.text, bm25(msg_fts) AS score ' +
      'FROM msg_fts JOIN messages m ON m.id = msg_fts.rowid ' +
      'WHERE msg_fts MATCH ?' + filterSql + ' ORDER BY bm25(msg_fts) LIMIT ?'
    return db.prepare(sql).all(expr, n)
  }

  // 2 字中文词用不上 trigram 索引，只能 LIKE。旧写法是全表扫再按
  // 「命中词数 + 时间」排序：12 万行要 250ms。改成按主键倒序扫、
  // 凑够候选就停——常用词（压缩/巡检/纳）几毫秒到十几毫秒就出结果；
  // 冷门词才退化成全表扫（那是它本来就该付的代价）。
  // 代价：只在最近 want 条命中里按「命中词数」重排，而不是全库。
  // 原文库是「回忆最近发生过什么」的地方，这个取舍值得。
  const like = (words, n) => {
    if (words.length === 0) return []
    const cond = words.map(() => 'm.lex LIKE ?').join(' OR ')
    const score = words.map(() => '(CASE WHEN m.lex LIKE ? THEN 1 ELSE 0 END)').join(' + ')
    const condParams = []
    for (const w of words) condParams.push('%' + w + '%')
    for (const w of words) condParams.push('%' + w + '%')
    const cols = 'SELECT m.sid, m.seq, m.time, m.role, m.origin, m.text, (' + score + ') AS score '
    // 有时间窗时只取 n 条：窗口内命中本来就少，取多了（48）会凑不满，
    // SQLite 得扫完整表才能确认「没有更多」——今天+压缩从 5ms 变 255ms。
    // 有时间窗时只取 n 条：窗口内命中本来就少，取多了（48）会凑不满，
    // SQLite 得扫完整表才能确认「没有更多」——今天+压缩从 5ms 变 255ms。
    const want = timeWindows.length > 0 ? n : Math.min(400, Math.max(n * 6, 48))
    const byScore = (rows) =>
      rows.sort(
        (a, b) =>
          Number(b.score ?? 0) - Number(a.score ?? 0) ||
          Number(b.time ?? 0) - Number(a.time ?? 0) ||
          String(a.text ?? '').length - String(b.text ?? '').length,
      )
    // 主键倒序 + LIMIT：SQLite 从最新一条往回扫，凑够 want 条命中就停。
    // 带时间窗（今天/昨天）也一样——最近的数据就在文件尾部，扫得很浅。
    const rows = db
      .prepare(cols + 'FROM messages m WHERE (' + cond + ')' + filterSql + ' ORDER BY m.id DESC LIMIT ?')
      .all(...condParams, want)
    return byScore(rows).slice(0, n)
  }

  if (longPhrases.length > 0) {
    try {
      const expr = longPhrases.map((p) => '"' + p.split('"').join('""') + '"').join(' OR ')
      add(fts(expr, limit))
    } catch {
      /* FTS 不可用（某些驱动的 fts5 没编进来）→ 全靠 LIKE */
    }
  }
  if (rows.length < limit && shortPhrases.length > 0) add(like(shortPhrases, limit))
  if (rows.length < limit && bigrams.length > 0) add(like(bigrams, limit))
  if (rows.length === 0 && tokens.length > 0) add(like(tokens, limit))

  const entries = rows.slice(0, limit).map((row) => ({
    when: formatWhen(row.time),
    role: String(row.role ?? ''),
    origin: String(row.origin ?? ''),
    sid: String(row.sid ?? ''),
    seq: Number(row.seq ?? 0),
    snippet: makeSnip(row.text, allWords),
    score: Number(row.score ?? 0),
  }))

  return {
    entries,
    note: entries.length === 0 ? '原文库里没有这些词' : '',
    stale: isStale(db, now),
  }
}

/** 索引最新一条比 now 落后超过 30 分钟 → 提醒上层该刷新了。 */
function isStale(db, now, staleAfterMs = 30 * 60 * 1000) {
  try {
    // MAX(time) 没有索引，12 万行要 130ms；按主键倒序取最后一条是 O(log n)。
    // dump 是按时间顺序追加的，最后一条的 time 就是最新时间。
    const row = db.prepare('SELECT time AS t FROM messages ORDER BY id DESC LIMIT 1').get()
    const newest = Number(row?.t ?? 0)
    if (!newest) return true
    return now - newest > staleAfterMs
  } catch {
    return true
  }
}
