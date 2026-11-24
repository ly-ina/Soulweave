#!/usr/bin/env node
/**
 * 把旧 meow 库的行为层（soul / user / rules）active 条目迁进魂织新池。
 * 只读源库；目标库走 remember()，带正文 sha 去重与版本留痕。
 *
 * 用法：
 *   node tools/migrate-behavior.mjs --from <旧库> --to <新库> [--dry-run] [--layers soul,user,rules]
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { normalizeConfig } from '../core/config.mjs'
import { remember } from '../core/remember.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const from = arg('from')
const to = arg('to')
const dry = argv.includes('--dry-run')
const layers = arg('layers', 'soul,user,rules').split(',').map((s) => s.trim()).filter(Boolean)

if (!from || !to) {
  console.error('用法: node tools/migrate-behavior.mjs --from <旧库> --to <新库> [--dry-run]')
  process.exit(2)
}
if (!existsSync(from)) {
  console.error(`源库不存在：${from}`)
  process.exit(2)
}

const config = normalizeConfig({ memoryBackend: 'builtin', memoryDbPath: to })
const db = new DatabaseSync(from, { readOnly: true })
let total = 0
let ok = 0
let dedup = 0
let failed = 0

for (const layer of layers) {
  const rows = db.prepare(`select * from ${layer} where status='active' order by importance desc, updated_at asc`).all()
  for (const row of rows) {
    total += 1
    const content = String(row.content ?? '').trim()
    if (!content) continue
    let keywords = []
    try {
      keywords = JSON.parse(String(row.keywords ?? '[]'))
    } catch {
      keywords = []
    }
    if (dry) {
      console.log(`[${layer}] ${row.title || row.id} · ${content.length} 字`)
      continue
    }
    const res = remember(config, {
      content,
      title: String(row.title ?? ''),
      kind: layer,
      importance: Number(row.importance) || 1,
      keywords,
      project: String(row.project ?? ''),
    })
    if (res.ok) {
      ok += 1
      if (res.dedup) dedup += 1
      console.log(`[${layer}] ${row.id} -> ${res.id}${res.dedup ? '（去重）' : ''}`)
    } else {
      failed += 1
      console.error(`[${layer}] ${row.id} 失败：${res.text}`)
    }
  }
}
db.close()
console.log(dry ? `dry-run：${total} 条` : `迁移 ${ok}/${total} 条（去重 ${dedup}，失败 ${failed}）`)
process.exit(failed ? 1 : 0)
