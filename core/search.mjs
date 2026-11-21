/**
 * core/search.mjs —— 记忆后端与检索（meow / builtin / none），零宿主依赖。
 *
 * 2026-11-19 解耦第 10 块（提前搬，probe 需要 searchMemory）：从 index.js 原样搬出，逻辑未改。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as builtinMemory from '../memory/builtin.mjs'
import { readCueMap, scoreCue } from './cue.mjs'
import { readInjectionRows } from './tier.mjs'
import * as whenMemory from '../memory/when.mjs'
import { asText, clip, tableColumns } from './text.mjs'
import { MEMORY_HEAD_LIMIT, MEMORY_LEVELS } from './constants.mjs'
import { normalizeConfig } from './config.mjs'
import { countResidentEntries, loadCorrectedLessons, loadMemoryHeads, loadPendingItems } from './budget.mjs'

export function wordsOf(query) {
  return asText(query).toLowerCase().split(/\s+/).filter(Boolean)
}

export function hitAll(text, words) {
  const lower = String(text ?? '').toLowerCase()
  return words.every((word) => lower.includes(word))
}

export function snippetAround(text, words, size = 90) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  const lower = value.toLowerCase()
  const first = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0]
  if (first === undefined) return clip(value, size)
  const start = Math.max(0, first - 20)
  return clip(value.slice(start, start + size), size)
}

/**
 * 记忆后端（§A）：`builtin`（默认，自带最小 schema）｜`meow`（本机七层库）｜`none`（全空不报错）。
 * 统一接口：`{ id, available, listHeads, search, listTier, putCue }`，
 * 另外补了 `listPending / listCorrectedLessons / countResident` 三个上层要用的读法（加法，不改已有语义）。
 *
 * 兼容口子：`builtin` 指向的库如果其实是 meow 的老库（有 soul/user 表、没有 memories 表），
 * 自动按 meow 语义读——这样 check.mjs 里那些临时 meow 靶子不用改。
 */
function createMeowBackend(cfg) {
  return {
    id: 'meow',
    dbPath: cfg.memoryDbPath,
    available: existsSync(cfg.memoryDbPath),
    listHeads: (limit = MEMORY_HEAD_LIMIT) => loadMemoryHeads(cfg.memoryDbPath, limit),
    listPending: (limit = 3) => loadPendingItems(cfg.memoryDbPath, limit),
    search: (query, limit = 5) => searchMemoryMeow(cfg, wordsOf(query), limit),
    listTier: (limit = 200) => {
      const read = readInjectionRows(cfg.memoryDbPath)
      return read.ok ? (read.rows ?? []).slice(0, limit) : []
    },
    putCue: () => ({ ok: false, error: 'meow 后端请走 soul_cue（cue.mjs）' }),
    listCorrectedLessons: (limit = 200) => loadCorrectedLessons(cfg.memoryDbPath, limit),
    countResident: () => countResidentEntries(cfg.memoryDbPath),
  }
}

function createBuiltinBackend(cfg) {
  const dbPath = cfg.memoryDbPath
  return {
    id: 'builtin',
    dbPath,
    available: true,
    listHeads: (limit = MEMORY_HEAD_LIMIT) => builtinMemory.listHeads(dbPath, limit),
    listPending: (limit = 3) => builtinMemory.listPending(dbPath, limit),
    search: (query, limit = 5) =>
      builtinMemory.search(dbPath, String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean), limit),
    listTier: (limit = 200) => builtinMemory.listTier(dbPath, limit),
    putCue: (id, cue) => builtinMemory.putCue(dbPath, id, cue),
    listCorrectedLessons: (limit = 200) => builtinMemory.listCorrectedLessons(dbPath, limit),
    countResident: () => builtinMemory.countResident(dbPath),
  }
}

function createNoneBackend(cfg) {
  const empty = { entries: [], note: '记忆后端已关闭（memoryBackend: none）' }
  return {
    id: 'none',
    dbPath: cfg.memoryDbPath,
    available: false,
    listHeads: () => [],
    listPending: () => [],
    search: () => empty,
    listTier: () => [],
    putCue: () => ({ ok: false, error: 'memoryBackend: none 不写 cue' }),
    listCorrectedLessons: () => [],
    countResident: () => 0,
  }
}

export function createMemoryBackend(config = {}) {
  const cfg = config && config.tierBudgetResolved ? config : normalizeConfig(config)
  if (cfg.memoryBackend === 'none') return createNoneBackend(cfg)
  if (cfg.memoryBackend === 'meow') return createMeowBackend(cfg)
  if (builtinMemory.looksLikeMeowDb(cfg.memoryDbPath)) return createMeowBackend(cfg)
  return createBuiltinBackend(cfg)
}

export function searchMemory(options, words, limit) {
  const backend = options && typeof options.search === 'function' && options.id ? options : createMemoryBackend(options)
  return backend.search(words.join(' '), limit)
}

export function searchMemoryMeow(options, words, limit) {
  const dbPath = options.memoryDbPath
  if (!existsSync(dbPath)) return { entries: [], note: '记忆库不存在' }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    // 模块 A：cue 表存在时先走 cue 匹配，只在候选命中后才去读正文（二期 §2.3）。
    // 表不存在（老库/首次安装）保持一期行为，不做静默降级。
    const cueMap = readCueMap(db)
    if (cueMap !== null) return searchMemoryByCue(db, words, limit, cueMap, tableColumns)
    const scored = []
    for (const level of MEMORY_LEVELS) {
      const cols = tableColumns(db, level)
      if (cols.length === 0) continue
      const pick = ['id', 'status', 'content']
      for (const optional of ['title', 'keywords', 'project']) if (cols.includes(optional)) pick.push(optional)
      let rows
      try {
        rows = db.prepare(`select ${pick.join(', ')} from ${level}`).all()
      } catch {
        continue
      }
      for (const row of rows) {
        if (String(row.status ?? 'active') !== 'active') continue
        const title = String(row.title ?? '')
        const content = String(row.content ?? '')
        const keywords = String(row.keywords ?? '')
        const project = String(row.project ?? '')
        const blob = `${title} ${content} ${keywords} ${project}`
        const lowerBlob = blob.toLowerCase()
        const matched = words.filter((word) => lowerBlob.includes(word)).length
        // 命中词数是第一排序键：全中的排前面，但只中一半的也不直接丢（「记忆 部署」这种
        // 跨条目的查询在严格 AND 下会全灭，实际是两条分开的记忆各中一个）。
        // 下限取一半：三词查询只中一个常见词（如「支付」）的不算命中，否则什么都能搜出东西。
        const need = words.length <= 1 ? 1 : Math.ceil(words.length * 0.5)
        if (matched < need) continue
        let score = matched * 10
        score += words.filter((word) => keywords.toLowerCase().includes(word)).length * 3
        score += words.filter((word) => title.toLowerCase().includes(word)).length * 2
        score += words.filter((word) => content.toLowerCase().includes(word)).length
        scored.push({
          score,
          loc: `记忆库/${level}#${row.id}`,
          snippet: snippetAround(content !== '' ? content : title, words),
        })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return { entries: scored.slice(0, limit).map(({ loc, snippet }) => ({ loc, snippet })), note: '' }
  } catch (error) {
    return { entries: [], note: `记忆库读取失败：${String(error?.message ?? error)}` }
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

export function scoreOf(matched, words, entry, content = '') {
  let score = matched * 10
  score += words.filter((word) => entry.keywords.toLowerCase().includes(word)).length * 3
  score += words.filter((word) => entry.title.toLowerCase().includes(word)).length * 2
  score += words.filter((word) => (entry.project ?? '').toLowerCase().includes(word)).length
  if (content !== '') score += words.filter((word) => content.toLowerCase().includes(word)).length
  return score
}

/**
 * cue 路径的检索（二期模块 A §2.3）：先只用 cue / 标题 / keywords / 项目打分，
 * 命中者才批量取正文做摘要，「未命中就整表读正文」被去掉。
 * 没有 cue 的行（凑不满 3 个触发词）在候选不足时补一次**受限**正文扫描
 * （最多 limit×50 行），否则 cue 空值会把老记忆变成搜不到——这是刻意的折中，写进报告。
 */
/**
 * 情境检索（2026-11-21 第 1 条）：不靠词，靠「现在在干什么」。
 * 只返回签过 when 且命中的条目；没签 when 的一律不出现——它是精确召回，
 * 不是相似度检索的替代品。ctx = { tool, path, timeWindow }。
 */
export function searchMemoryByContext(cfg, ctx = {}, limit = 5) {
  const dbPath = cfg?.memoryDbPath
  if (!dbPath || !existsSync(dbPath)) return { entries: [], note: '记忆库不存在', scanned: 0 }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const whenMap = whenMemory.readWhenMap(db)
    if (whenMap.size === 0) return { entries: [], note: '还没有条目签过 when', scanned: 0 }
    // 2026-11-21 优化：原来全表扫（实测 1427 条），改成只查签过 when 的那几条。
    // when_index 的 key 是 `${level}#${id}`，按 level 分组后 where id in (...)。
    const byLevel = new Map()
    for (const key of whenMap.keys()) {
      const cut = String(key).indexOf('#')
      if (cut <= 0) continue
      const level = String(key).slice(0, cut)
      const id = String(key).slice(cut + 1)
      if (!byLevel.has(level)) byLevel.set(level, [])
      byLevel.get(level).push(id)
    }
    const out = []
    let scanned = 0
    for (const [level, ids] of byLevel) {
      if (!MEMORY_LEVELS.includes(level) || ids.length === 0) continue
      const cols = tableColumns(db, level)
      if (cols.length === 0) continue
      const pick = ['id']
      for (const optional of ['title', 'content', 'keywords', 'project', 'importance', 'status']) {
        if (cols.includes(optional)) pick.push(optional)
      }
      let rows
      try {
        const placeholders = ids.map(() => '?').join(', ')
        rows = db.prepare(`select ${pick.join(', ')} from ${level} where id in (${placeholders})`).all(...ids)
      } catch {
        continue
      }
      for (const row of rows) {
        scanned += 1
        if (String(row.status ?? 'active') !== 'active') continue
        const when = whenMap.get(`${level}#${row.id}`)
        if (!when) continue
        if (whenMemory.matchWhen(when, ctx) !== 'hit') continue
        out.push({
          loc: `记忆库/${level}#${row.id}`,
          level,
          title: String(row.title ?? ''),
          snippet: snippetAround(String(row.content ?? row.title ?? ''), []),
          importance: Number(row.importance ?? 1),
          when,
        })
      }
    }
    out.sort((a, b) => b.importance - a.importance)
    return { entries: out.slice(0, limit), note: `when 命中 ${out.length} 条 / 扫描 ${scanned}`, scanned }
  } catch (error) {
    return { entries: [], note: `情境检索失败：${String(error?.message ?? error)}`, scanned: 0 }
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

export function searchMemoryByCue(db, words, limit, cueMap, columnsOf = tableColumns) {
  const need = words.length <= 1 ? 1 : Math.ceil(words.length * 0.5)
  const picked = []
  const bare = []
  for (const level of MEMORY_LEVELS) {
    const cols = columnsOf(db, level)
    if (cols.length === 0) continue
    const pick = ['id', 'status']
    for (const optional of ['title', 'keywords', 'project']) if (cols.includes(optional)) pick.push(optional)
    let rows
    try {
      rows = db.prepare(`select ${pick.join(', ')} from ${level}`).all()
    } catch {
      continue
    }
    for (const row of rows) {
      if (String(row.status ?? 'active') !== 'active') continue
      const entry = {
        level,
        id: String(row.id),
        title: String(row.title ?? ''),
        keywords: String(row.keywords ?? ''),
        project: String(row.project ?? ''),
      }
      const tokens = cueMap.get(`${level}#${entry.id}`)
      if (!tokens || tokens.length === 0) {
        bare.push(entry)
        continue
      }
      const matched = scoreCue(tokens, words)
      if (matched < need) continue
      picked.push({ ...entry, matched, score: scoreOf(matched, words, entry) })
    }
  }

  const extra = []
  let scanned = 0
  if (picked.length < limit) {
    const budget = limit * 50
    for (const entry of bare) {
      if (scanned >= budget) break
      const cols = columnsOf(db, entry.level)
      if (!cols.includes('content')) continue
      let row
      try {
        row = db.prepare(`select content from ${entry.level} where id = ?`).get(entry.id)
      } catch {
        continue
      }
      scanned += 1
      const content = String(row?.content ?? '')
      const blob = `${entry.title} ${content} ${entry.keywords} ${entry.project}`.toLowerCase()
      const matched = words.filter((word) => blob.includes(word)).length
      if (matched < need) continue
      extra.push({ ...entry, content, matched, score: scoreOf(matched, words, entry, content) + 1 })
    }
  }

  const merged = [...picked, ...extra].sort((a, b) => b.score - a.score).slice(0, limit)
  const missing = merged.filter((entry) => entry.content === undefined)
  const contents = new Map()
  if (missing.length > 0) {
    const byLevel = new Map()
    for (const entry of missing) {
      if (!byLevel.has(entry.level)) byLevel.set(entry.level, [])
      byLevel.get(entry.level).push(entry.id)
    }
    for (const [level, ids] of byLevel) {
      try {
        const rows = db
          .prepare(`select id, content from ${level} where id in (${ids.map(() => '?').join(',')})`)
          .all(...ids)
        for (const row of rows) contents.set(`${level}#${row.id}`, String(row.content ?? ''))
      } catch {
        /* 取不到正文就退回标题，不算失败 */
      }
    }
  }

  const entries = merged.map((entry) => {
    const text = entry.content ?? contents.get(`${entry.level}#${entry.id}`) ?? ''
    return { loc: `记忆库/${entry.level}#${entry.id}`, snippet: snippetAround(text || entry.title, words) }
  })
  return { entries, note: '', cueHits: picked.length, contentHits: extra.length, scanned }
}

/**
 * 解析封存源模块（§B）：显式路径优先 → 包名 import → 用 profile 的 node_modules 解析包名。
 * 三处都失败就返回 `{module:null}`，由调用方写进 note，不再有写死的同级目录回落。
 */
