#!/usr/bin/env node
/**
 * tools/legacy-compare.mjs —— 新旧记忆库双读比对（第三刀）。
 *
 * 用法：
 *   node tools/legacy-compare.mjs --new <soul-memory.db> --legacy <old-meow.db> [--json]
 *
 * 只读：两个库都以 readOnly 打开，不建表、不写字节。
 * 输出：旧库各层条数、新池各层条数、按正文 sha 的重合数、只在旧库/只在新池的样例。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { inspectLegacyDb, LEGACY_LAYERS } from '../memory/legacy.mjs'

function argOf(name, fallback = '') {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] ?? '') : fallback
}

const newPath = argOf('--new')
const legacyPath = argOf('--legacy')
const asJson = process.argv.includes('--json')

if (!newPath || !legacyPath) {
  console.error('用法：node tools/legacy-compare.mjs --new <soul-memory.db> --legacy <old-meow.db> [--json]')
  process.exit(2)
}

const shaOf = (text) => createHash('sha256').update(String(text ?? '').trim()).digest('hex')
const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

function readNewPool(path) {
  if (!existsSync(path)) return { ok: false, path, levels: {}, total: 0, contents: [] }
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const names = new Set(db.prepare("select name from sqlite_master where type='table'").all().map((r) => String(r.name)))
    if (!names.has('memories')) return { ok: false, path, levels: {}, total: 0, contents: [] }
    const levels = {}
    for (const row of db.prepare('select level, count(*) c from memories where status=? group by level').all('active')) {
      levels[String(row.level)] = Number(row.c)
    }
    const contents = db
      .prepare('select id, level, content from memories where status=? order by updated_at desc')
      .all('active')
      .map((row) => ({ id: String(row.id), level: String(row.level), sha: shaOf(row.content), content: norm(row.content) }))
    return { ok: true, path, levels, total: contents.length, contents }
  } catch (error) {
    return { ok: false, path, levels: {}, total: 0, contents: [], note: String(error?.message ?? error) }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

function readLegacyContents(path) {
  const info = inspectLegacyDb(path)
  if (!info.ok) return { info, contents: [] }
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const contents = []
    for (const table of LEGACY_LAYERS) {
      if (!info.tables.includes(table)) continue
      try {
        for (const row of db.prepare(`select * from ${table}`).all()) {
          if (String(row.status ?? 'active') !== 'active') continue
          contents.push({ table, id: String(row.id ?? ''), sha: shaOf(row.content), content: norm(row.content) })
        }
      } catch { /* 单表读不了不影响其它层 */ }
    }
    return { info, contents }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

const next = readNewPool(newPath)
const legacy = readLegacyContents(legacyPath)
const legacyShas = new Set(legacy.contents.map((item) => item.sha))
const newShas = new Set(next.contents.map((item) => item.sha))
const overlap = next.contents.filter((item) => legacyShas.has(item.sha))
const onlyLegacy = legacy.contents.filter((item) => !newShas.has(item.sha))
const onlyNew = next.contents.filter((item) => !legacyShas.has(item.sha))
const summary = {
  new: { path: newPath, ok: next.ok, levels: next.levels, total: next.total },
  legacy: {
    path: legacyPath,
    ok: legacy.info.ok,
    tables: legacy.info.tables,
    counts: legacy.info.counts,
    total: legacy.info.total,
    note: legacy.info.note,
  },
  overlap: overlap.length,
  onlyLegacy: onlyLegacy.length,
  onlyNew: onlyNew.length,
  samples: {
    overlap: overlap.slice(0, 5).map((item) => `${item.level}:${item.content.slice(0, 60)}`),
    onlyLegacy: onlyLegacy.slice(0, 5).map((item) => `${item.table}:${item.content.slice(0, 60)}`),
    onlyNew: onlyNew.slice(0, 5).map((item) => `${item.level}:${item.content.slice(0, 60)}`),
  },
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`新池 ${newPath}`)
  console.log(`  ${next.ok ? `active ${next.total} 条 · ${Object.entries(next.levels).map(([k, v]) => `${k} ${v}`).join(' / ')}` : '读不到 memories 表'}`)
  console.log(`旧库 ${legacyPath}`)
  console.log(`  ${legacy.info.ok ? `七层 active ${legacy.info.total} 条 · ${legacy.info.tables.join(' / ')}` : `不可用：${legacy.info.note}`}`)
  console.log(`重合 ${overlap.length} 条 · 只在旧库 ${onlyLegacy.length} 条 · 只在新池 ${onlyNew.length} 条`)
  for (const label of ['overlap', 'onlyLegacy', 'onlyNew']) {
    if (summary.samples[label].length === 0) continue
    console.log(`  ${label}:`)
    for (const line of summary.samples[label]) console.log(`    - ${line}`)
  }
}
