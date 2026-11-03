/**
 * 模块 A：记忆 cue 化（二期）。
 *
 * 目标：每条记忆保留 3–5 个**触发词**（不是摘要、不是首句），检索时先匹配 cue，
 * 命中才去读整条正文；cue 写不进 3 个词的就留空，等报告里点名。
 *
 * 硬约束（交办单 §2 / §5）：
 * - 只读 7 张原表的现有列，不改列、不改结构（别的插件直连这些表）。
 * - cue 落在新表 `cue(entry_id, table_name, cue, generated_at, method)`。
 * - 生成只许用规则（keywords 字段 + 标题去停用词），不调模型。
 * - 写库前必须 `VACUUM INTO` 备份；默认 preview，append 才动。
 * - 不 delete 任何行（红线 1）。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const MEMORY_TABLES = Object.freeze(['soul', 'rules', 'user', 'project', 'fact', 'topic', 'lesson'])
export const CUE_TABLE = 'cue'
export const MIN_TOKENS = 3
export const MAX_TOKENS = 5

/** 停用词：只挡虚词与口水词，不挡实义词（挡多了 cue 会退化成摘要）。 */
const STOPWORDS = new Set(
  (
    '的 了 是 在 和 与 就 也 都 而 及 或 把 被 让 给 对 从 到 为 以 这 那 个 些 上 下 里 中 不 没 很 更 最 ' +
    '会 能 要 有 我 你 他 她 它 们 之 其 该 条 种 件 事 做 用 说 看 想 一个 已经 可以 因为 所以 但是 如果 ' +
    '然后 现在 时候 问题 东西 关于 一下 这样 那样 什么 怎么 如何 还是 不是 就是 只是 需要 应该 可能 ' +
    'the a an and or of to in on for with is are was were be been it this that these those'
  ).split(/\s+/),
)

function isStop(word) {
  return STOPWORDS.has(String(word).toLowerCase())
}

/** 中文按 2–8 字保留，英文/数字按词保留；其它字符丢弃。 */
function cleanToken(value) {
  const word = String(value ?? '')
    .replace(/[`"'“”‘’（）()【】\[\]{}<>《》「」『』、，。；：！？,.;:!?|/\\~+=*#$@%^&]+/g, ' ')
    .trim()
  if (word === '') return ''
  if (/^[\x20-\x7e]+$/.test(word)) {
    const lower = word.toLowerCase()
    if (lower.length < 2 || lower.length > 24) return ''
    return isStop(lower) ? '' : lower
  }
  const cjk = word.replace(/\s+/g, '')
  if (cjk.length < 2 || cjk.length > 8) return ''
  return isStop(cjk) ? '' : cjk
}

function dedupe(list) {
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (item === '' || seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

/** 标题拆词：先去标点，再把虚词当分隔符切开，留下 2–8 字的实义片段。 */
export function tokensFromTitle(title) {
  const text = String(title ?? '').replace(/^关于[:：]\s*/, '')
  if (text.trim() === '') return []
  const stopPattern = [...STOPWORDS].filter((w) => /^[\u4e00-\u9fff]+$/.test(w)).sort((a, b) => b.length - a.length)
  const pieces = text.split(/[\s，。；：、！？,.;:!?（）()【】\[\]「」『』/\\|]+/)
  const out = []
  for (const piece of pieces) {
    let rest = piece
    for (const stop of stopPattern) {
      if (rest === stop) {
        rest = ''
        break
      }
      rest = rest.split(stop).join('|')
    }
    for (const chunk of rest.split('|')) {
      const token = cleanToken(chunk)
      if (token !== '') out.push(token)
    }
  }
  return out
}

/** 从 keywords 字段拆词；逗号/空格/顿号都算分隔符。 */
export function tokensFromKeywords(keywords) {
  return String(keywords ?? '')
    .split(/[\s,，、;；|/]+/)
    .map(cleanToken)
    .filter((word) => word !== '')
}

/**
 * 规则生成 cue：keywords 优先，不够 3 个再拿标题补，最后补项目名。
 * 返回 `{ cue, tokens, method }`；凑不满 3 个时 cue 为空字符串、method 记 `empty`。
 */
export function buildCue(row = {}) {
  const fromKeywords = tokensFromKeywords(row.keywords)
  let tokens = dedupe(fromKeywords)
  let method = fromKeywords.length >= MIN_TOKENS ? 'keywords' : 'mixed'
  if (tokens.length < MAX_TOKENS) {
    tokens = dedupe([...tokens, ...tokensFromTitle(row.title)])
  }
  if (tokens.length < MIN_TOKENS) {
    const project = cleanToken(row.project)
    if (project !== '' && project !== '全局') tokens = dedupe([...tokens, project])
  }
  tokens = tokens.slice(0, MAX_TOKENS)
  if (tokens.length < MIN_TOKENS) return { cue: '', tokens, method: 'empty' }
  if (method === 'mixed' && tokens.length === fromKeywords.length && fromKeywords.length >= MIN_TOKENS) method = 'keywords'
  return { cue: tokens.join(' '), tokens, method }
}

/** 读表列；表不存在时返回空数组（不同层级的表列不一致，§2 已查证）。 */
export function tableColumns(db, table) {
  if (!/^[a-z_]+$/i.test(table)) return []
  try {
    return db.prepare(`pragma table_info(${table})`).all().map((row) => String(row.name))
  } catch {
    return []
  }
}

export function cueTableExists(db) {
  try {
    const row = db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(CUE_TABLE)
    return Boolean(row)
  } catch {
    return false
  }
}

/**
 * 只读扫描：给出「哪些条目会有 cue、哪些留空」。不动库。
 * refresh=true 时把已有 cue 也重算（默认只补缺）。
 */
export function planCues(dbPath, { refresh = false } = {}) {
  if (!existsSync(dbPath)) return { ok: false, error: `记忆库不存在：${dbPath}`, plan: [] }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const plan = []
  let already = 0
  try {
    const existing = cueTableExists(db)
      ? new Map(db.prepare(`select table_name, entry_id, cue from ${CUE_TABLE}`).all().map((r) => [`${r.table_name}#${r.entry_id}`, String(r.cue ?? '')]))
      : new Map()
    for (const table of MEMORY_TABLES) {
      const cols = tableColumns(db, table)
      if (cols.length === 0) continue
      const pick = ['id', 'status']
      for (const optional of ['title', 'content', 'keywords', 'project']) if (cols.includes(optional)) pick.push(optional)
      let rows
      try {
        rows = db.prepare(`select ${pick.join(', ')} from ${table}`).all()
      } catch {
        continue
      }
      for (const row of rows) {
        if (String(row.status ?? 'active') !== 'active') continue
        const key = `${table}#${row.id}`
        const has = existing.has(key) && existing.get(key) !== ''
        if (has && !refresh) {
          already += 1
          continue
        }
        const built = buildCue({
          title: row.title ?? '',
          content: row.content ?? '',
          keywords: row.keywords ?? '',
          project: row.project ?? '',
        })
        plan.push({ table, id: String(row.id), title: String(row.title ?? '').slice(0, 40), ...built })
      }
    }
  } finally {
    db.close()
  }
  const withCue = plan.filter((item) => item.cue !== '')
  const empty = plan.filter((item) => item.cue === '')
  return {
    ok: true,
    plan,
    withCue,
    empty,
    stats: { total: plan.length, withCue: withCue.length, empty: empty.length, already },
  }
}

function sqlQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`
}

/**
 * 真写：先 `VACUUM INTO` 备份，再建表 upsert。返回备份路径与实际写入条数。
 * 任何一步失败都抛错，不半途而废（备份失败就不写）。
 */
export function applyCues(dbPath, stateDir, items) {
  const backupDir = join(stateDir, 'backup')
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  let backup = join(backupDir, `memory-cue-${stamp}.db`)
  let suffix = 0
  while (existsSync(backup)) backup = join(backupDir, `memory-cue-${stamp}-${++suffix}.db`)
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`VACUUM INTO ${sqlQuote(backup)}`)
    if (!existsSync(backup) || statSync(backup).size === 0) {
      throw new Error(`备份未生成或为空：${backup}`)
    }
    db.exec(
      `create table if not exists ${CUE_TABLE} (` +
        'entry_id text not null, table_name text not null, cue text not null, generated_at text not null, method text not null, ' +
        'primary key (entry_id, table_name))',
    )
    const at = new Date().toISOString()
    const stmt = db.prepare(
      `insert into ${CUE_TABLE} (entry_id, table_name, cue, generated_at, method) values (?, ?, ?, ?, ?) ` +
        'on conflict(entry_id, table_name) do update set cue = excluded.cue, generated_at = excluded.generated_at, method = excluded.method',
    )
    let written = 0
    db.exec('begin immediate')
    try {
      for (const item of items) {
        if (!item || item.cue === '') continue
        stmt.run(item.id, item.table, item.cue, at, item.method)
        written += 1
      }
      db.exec('commit')
    } catch (error) {
      try {
        db.exec('rollback')
      } catch {
        /* ignore */
      }
      throw error
    }
    return { backup, written, at }
  } finally {
    db.close()
  }
}

/** 读 cue 表成 Map(`表#id` → tokens[])；表不存在返回 null（调用方据此走旧路径）。 */
export function readCueMap(db) {
  if (!cueTableExists(db)) return null
  const map = new Map()
  for (const row of db.prepare(`select entry_id, table_name, cue from ${CUE_TABLE}`).all()) {
    const tokens = String(row.cue ?? '').split(/\s+/).filter(Boolean)
    if (tokens.length > 0) map.set(`${row.table_name}#${row.entry_id}`, tokens)
  }
  return map
}

/**
 * cue 命中打分：查询词与 cue token 互相包含都算命中（"manifest" 命中 "manifest.jsonl"）。
 * 单字查询不参与互相包含，避免「的」这种把什么都捞出来。
 */
export function scoreCue(tokens, words) {
  let matched = 0
  for (const word of words) {
    const hit = tokens.some((token) => {
      const lower = token.toLowerCase()
      if (lower === word) return true
      if (word.length < 2) return false
      return lower.includes(word) || word.includes(lower)
    })
    if (hit) matched += 1
  }
  return matched
}

/** 渲染 preview 文本（工具与 check 共用，避免两套说法）。 */
export function renderPlan(result, limit = 10) {
  if (!result.ok) return result.error
  const { stats, withCue, empty } = result
  const head = `【soul_cue · ${result.mode === 'append' ? '已写' : '预览'}】本次待生成 ${stats.total} 条（有 ${stats.withCue} 条、留空 ${stats.empty} 条）；已有 cue ${stats.already ?? 0} 条`
  const lines = [head]
  for (const item of withCue.slice(0, limit)) lines.push(`· ${item.table}#${item.id} → ${item.cue}（${item.method}）`)
  if (withCue.length > limit) lines.push(`……另有 ${withCue.length - limit} 条未显示`)
  if (empty.length > 0) {
    lines.push(`留空（凑不满 ${MIN_TOKENS} 个词）：${empty.slice(0, limit).map((item) => `${item.table}#${item.id}`).join('、')}${empty.length > limit ? ` 等 ${empty.length} 条` : ''}`)
  }
  return lines.join('\n')
}

/** 全量重算的便捷入口（preview 不写库）。 */
export function runCue(dbPath, stateDir, { mode = 'preview', refresh = false, limit = 10 } = {}) {
  const plan = planCues(dbPath, { refresh })
  if (!plan.ok) return { ok: false, mode, text: plan.error, stats: null }
  const text = renderPlan({ ...plan, mode }, limit)
  if (mode !== 'append') return { ok: true, mode: 'preview', text, stats: plan.stats }
  if (plan.withCue.length === 0) return { ok: true, mode: 'append', text: `${text}\n没有需要写入的条目（已有 cue ${plan.stats.already} 条被跳过）`, stats: plan.stats }
  const written = applyCues(dbPath, stateDir, plan.withCue)
  return {
    ok: true,
    mode: 'append',
    text: `${text}\n已写 ${written.written} 条；备份 ${written.backup}`,
    stats: plan.stats,
    backup: written.backup,
  }
}

/** cue 表规模（给报告和 README 用）。 */
export function cueStats(dbPath) {
  if (!existsSync(dbPath)) return { total: 0, tables: 0, bytes: 0 }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (!cueTableExists(db)) return { total: 0, tables: 0, bytes: 0 }
    const total = Number(db.prepare(`select count(*) as n from ${CUE_TABLE}`).get()?.n ?? 0)
    const tables = Number(db.prepare(`select count(distinct table_name) as n from ${CUE_TABLE}`).get()?.n ?? 0)
    return { total, tables, bytes: 0 }
  } finally {
    db.close()
  }
}

export default { buildCue, planCues, applyCues, readCueMap, scoreCue, runCue, cueStats, MAX_TOKENS, MIN_TOKENS }
