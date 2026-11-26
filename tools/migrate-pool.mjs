#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/migrate-pool.mjs —— 把旧库里的内容池（memories/todos/versions）搬进独立 builtin 库。
 *
 * 用法：
 *   node tools/migrate-pool.mjs --from <旧库> --to <新库> [--dry-run]
 *
 * 只读旧库；新库不存在就建。按 id INSERT OR IGNORE，不覆盖新库已有条目，不删旧库。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { ensureDb } from '../memory/builtin.mjs'

const argOf = (name, fallback = '') => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : fallback
}
const from = argOf('--from')
const to = argOf('--to')
const dryRun = process.argv.includes('--dry-run')
if (!from || !to) {
  console.error('用法：node tools/migrate-pool.mjs --from <旧库> --to <新库> [--dry-run]')
  process.exit(2)
}
if (!existsSync(from)) {
  console.error(`旧库不存在：${from}`)
  process.exit(2)
}

const target = ensureDb(to)
if (!target) {
  console.error(`无法创建新库：${to}`)
  process.exit(1)
}
target.close()

const db = new DatabaseSync(to)
try {
  db.exec(`attach database '${from.replace(/'/g, "''")}' as src`)
  const srcTables = new Set(db.prepare("select name from src.sqlite_master where type='table'").all().map((row) => String(row.name)))
  const report = {}
  for (const table of ['memories', 'todos', 'memory_versions']) {
    if (!srcTables.has(table)) {
      report[table] = { copied: 0, skipped: '旧库没有这张表' }
      continue
    }
    const srcCols = db.prepare(`pragma src.table_info(${table})`).all().map((row) => String(row.name))
    const dstCols = db.prepare(`pragma table_info(${table})`).all().map((row) => String(row.name))
    const cols = srcCols.filter((col) => dstCols.includes(col))
    if (cols.length === 0) {
      report[table] = { copied: 0, skipped: '没有共同列' }
      continue
    }
    const before = Number(db.prepare(`select count(*) c from ${table}`).get()?.c ?? 0)
    if (!dryRun) {
      db.exec(`insert or ignore into ${table} (${cols.join(',')}) select ${cols.join(',')} from src.${table}`)
    }
    const after = Number(db.prepare(`select count(*) c from ${table}`).get()?.c ?? 0)
    const srcCount = Number(db.prepare(`select count(*) c from src.${table}`).get()?.c ?? 0)
    report[table] = { source: srcCount, copied: dryRun ? '（dry-run）' : after - before, total: after }
  }
  console.log(JSON.stringify({ from, to, dryRun, report }, null, 2))
} finally {
  try { db.close() } catch { /* ignore */ }
}
