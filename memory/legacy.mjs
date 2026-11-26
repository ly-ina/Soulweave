/**
 * memory/legacy.mjs —— 旧 meow 库只读挂载（第三刀）。
 *
 * 只做两件事：体检（有哪些七层表、各多少条）和给 search.mjs 提供状态。
 * 不建表、不写库、不开写连接；旧库不存在或没有七层表都返回 ok:false，不抛错。
 */
import { existsSync } from '../io.mjs'
import { openDatabase } from '../storage/index.mjs'

export const LEGACY_LAYERS = ['soul', 'user', 'rules', 'project', 'fact', 'lesson', 'topic']

function safeCount(db, table, where = '') {
  try {
    const row = db.prepare(`select count(*) c from ${table} ${where}`).get()
    return Number(row?.c ?? 0)
  } catch {
    return null
  }
}

/** 体检旧库：返回 {ok, path, tables, counts, total, memories, note}。 */
export function inspectLegacyDb(dbPath) {
  const path = String(dbPath ?? '')
  if (!path || !existsSync(path)) {
    return { ok: false, path, tables: [], counts: {}, total: 0, memories: 0, note: '旧库不存在' }
  }
  let db
  try {
    db = openDatabase(path, { readOnly: true })
    const names = new Set(
      db.prepare("select name from sqlite_master where type='table'").all().map((row) => String(row.name)),
    )
    const tables = LEGACY_LAYERS.filter((name) => names.has(name))
    if (tables.length === 0) {
      return { ok: false, path, tables: [], counts: {}, total: 0, memories: 0, note: '没有七层表（不是 meow 库）' }
    }
    const counts = {}
    let total = 0
    for (const table of tables) {
      const active = names.has(table) ? safeCount(db, table, "where status = 'active'") : null
      const all = safeCount(db, table) ?? 0
      counts[table] = { active: active ?? all, all }
      total += active ?? all
    }
    const memories = names.has('memories') ? safeCount(db, 'memories') ?? 0 : 0
    return { ok: true, path, tables, counts, total, memories, note: '' }
  } catch (error) {
    return { ok: false, path, tables: [], counts: {}, total: 0, memories: 0, note: String(error?.message ?? error) }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}
