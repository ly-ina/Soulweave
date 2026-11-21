/**
 * memory/when.mjs —— 情境签名 when_ctx。
 *
 * 2026-11-21 第 1 条：让记忆条目带「什么时候该想起我」。
 * 2026-11-21 第 3 条：加命中计数 hit_count / bad_count / last_hit，给反馈调权攒数据。
 * 与待办原文的一处偏离：不改 meow 的七张条目表加列，改用独立表 when_index。
 *   1. 旧行一个字节不动，回滚只需 DROP TABLE；
 *   2. 不碰 memory_remember 的工具 schema 和 i18n 文案，写入面不扩；
 *   3. join 一次的成本在 11ms 的检索里可以忽略。
 * 只依赖 node:sqlite（方向约束：memory 不 import core）。
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export const WHEN_TABLE = 'when_index'
export const WHEN_KEYS = Object.freeze(['tool', 'pathPattern', 'timeWindow'])

/** 计数列：老库建表时没有，ensureWhenTable 会补。 */
const WHEN_COUNTER_COLUMNS = [
  ['hit_count', 'integer not null default 0'],
  ['bad_count', 'integer not null default 0'],
  ['last_hit', 'integer'],
]

/** 只留认识的键；值统一成字符串或字符串数组。 */
export function normalizeWhen(raw) {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const key of WHEN_KEYS) {
    const value = raw[key]
    if (value == null) continue
    if (Array.isArray(value)) {
      const list = value.map((item) => String(item).trim()).filter(Boolean)
      if (list.length > 0) out[key] = list
      continue
    }
    const text = String(value).trim()
    if (text !== '') out[key] = text
  }
  return Object.keys(out).length === 0 ? null : out
}

export function ensureWhenTable(db) {
  db.exec(`create table if not exists ${WHEN_TABLE} (
    level text not null,
    entry_id text not null,
    when_ctx text not null,
    updated_at integer,
    hit_count integer not null default 0,
    bad_count integer not null default 0,
    last_hit integer,
    primary key (level, entry_id)
  )`)
  // 老库（只建过 when_ctx 那一版）补计数列。alter 不幂等，所以先用 pragma 看缺哪列。
  let have = new Set()
  try {
    have = new Set(db.prepare(`pragma table_info(${WHEN_TABLE})`).all().map((row) => String(row.name)))
  } catch { /* pragma 不可用时直接跳过补列，不影响主键写入 */ }
  for (const [name, decl] of WHEN_COUNTER_COLUMNS) {
    if (have.has(name)) continue
    try {
      db.exec(`alter table ${WHEN_TABLE} add column ${name} ${decl}`)
    } catch { /* 并发补列时另一路已加上，忽略 */ }
  }
}

function openWrite(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return null
  try {
    return new DatabaseSync(dbPath)
  } catch {
    return null
  }
}

export function putWhen(dbPath, level, id, when) {
  const norm = normalizeWhen(when)
  if (!norm) return { ok: false, error: 'when 为空，或没有认识的键（tool / pathPattern / timeWindow）' }
  const db = openWrite(dbPath)
  if (!db) return { ok: false, error: '记忆库打不开' }
  try {
    ensureWhenTable(db)
    db.prepare(
      `insert into ${WHEN_TABLE} (level, entry_id, when_ctx, updated_at) values (?, ?, ?, ?)
       on conflict(level, entry_id) do update set when_ctx = excluded.when_ctx, updated_at = excluded.updated_at`,
    ).run(String(level), String(id), JSON.stringify(norm), Date.now())
    return { ok: true, level: String(level), id: String(id), when: norm }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

export function removeWhen(dbPath, level, id) {
  const db = openWrite(dbPath)
  if (!db) return { ok: false, error: '记忆库打不开' }
  try {
    ensureWhenTable(db)
    const info = db.prepare(`delete from ${WHEN_TABLE} where level = ? and entry_id = ?`).run(String(level), String(id))
    return { ok: true, removed: Number(info.changes ?? 0) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/**
 * 命中的一次记账。dry-run 也要记 —— 不记就白等几天。
 * @returns {{ok:boolean, changes?:number, error?:string}}
 */
export function bumpWhenHit(dbPath, level, id, now = Date.now()) {
  const db = openWrite(dbPath)
  if (!db) return { ok: false, error: '记忆库打不开' }
  try {
    ensureWhenTable(db)
    const info = db.prepare(
      `update ${WHEN_TABLE} set hit_count = coalesce(hit_count, 0) + 1, last_hit = ? where level = ? and entry_id = ?`,
    ).run(Number(now), String(level), String(id))
    return { ok: true, changes: Number(info.changes ?? 0) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/** 误报手动标注：这条不该被触发。 */
export function markWhenBad(dbPath, level, id) {
  const db = openWrite(dbPath)
  if (!db) return { ok: false, error: '记忆库打不开' }
  try {
    ensureWhenTable(db)
    const info = db.prepare(
      `update ${WHEN_TABLE} set bad_count = coalesce(bad_count, 0) + 1 where level = ? and entry_id = ?`,
    ).run(String(level), String(id))
    return { ok: true, changes: Number(info.changes ?? 0) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/** 读整张 when_index；表不存在返回空 Map（老库不报错）。 */
export function readWhenMap(db) {
  const map = new Map()
  try {
    const rows = db.prepare(`select level, entry_id, when_ctx from ${WHEN_TABLE}`).all()
    for (const row of rows) {
      try {
        const norm = normalizeWhen(JSON.parse(String(row.when_ctx)))
        if (norm) map.set(`${row.level}#${row.entry_id}`, norm)
      } catch { /* 单行坏了不影响别的 */ }
    }
  } catch { /* 表不存在 */ }
  return map
}

/** 命中统计（只读，给 tools/when-stats.mjs 用）。 */
export function readWhenStats(dbPath) {
  const db = openWrite(dbPath)
  if (!db) return { ok: false, error: '记忆库打不开' }
  try {
    ensureWhenTable(db)
    const rows = db.prepare(
      `select level, entry_id, when_ctx, hit_count, bad_count, last_hit, updated_at
       from ${WHEN_TABLE} order by coalesce(hit_count, 0) desc, coalesce(last_hit, 0) desc`,
    ).all()
    return { ok: true, rows: rows.map((row) => ({ ...row, hit_count: Number(row.hit_count ?? 0), bad_count: Number(row.bad_count ?? 0) })) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/** 单条查。 */
export function getWhen(dbPath, level, id) {
  const db = openWrite(dbPath)
  if (!db) return null
  try {
    const row = db.prepare(`select when_ctx from ${WHEN_TABLE} where level = ? and entry_id = ?`).get(String(level), String(id))
    if (!row) return null
    return normalizeWhen(JSON.parse(String(row.when_ctx)))
  } catch {
    return null
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

function wildcardMatch(pattern, text) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp(`^${escaped}$`, 'i').test(text)
  } catch {
    return false
  }
}

/**
 * 纯函数：这条记忆的 when 跟当前情境对不对得上。
 * @returns {'hit'|'miss'|null} null = 这条没签情境，按老路走
 */
export function matchWhen(whenCtx, ctx = {}) {
  if (!whenCtx) return null
  const tool = String(ctx.tool ?? '')
  const path = String(ctx.path ?? ctx.pathPattern ?? '')
  const timeWindow = String(ctx.timeWindow ?? '')
  let checked = 0
  if (whenCtx.tool) {
    if (!tool) return 'miss'
    checked += 1
    // 2026-11-21 修：tool 和 pathPattern 一样支持 `|` 分隔（原来只支持数组，字符串里的 | 被当成字面量）。
    const list = (Array.isArray(whenCtx.tool) ? whenCtx.tool : [whenCtx.tool])
      .flatMap((item) => String(item).split('|'))
      .map((item) => item.trim())
      .filter(Boolean)
    if (!list.some((pattern) => wildcardMatch(pattern, tool))) return 'miss'
  }
  if (whenCtx.pathPattern) {
    if (!path) return 'miss'
    checked += 1
    const list = String(whenCtx.pathPattern).split('|').map((part) => part.trim()).filter(Boolean)
    if (!list.some((pattern) => wildcardMatch(pattern, path))) return 'miss'
  }
  if (whenCtx.timeWindow) {
    if (!timeWindow) return 'miss'
    checked += 1
    if (String(whenCtx.timeWindow) !== timeWindow) return 'miss'
  }
  return checked === 0 ? null : 'hit'
}

/** 当前时间 → morning / afternoon / evening / night。 */
export function timeWindowOf(date = new Date()) {
  const hour = date.getHours()
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}