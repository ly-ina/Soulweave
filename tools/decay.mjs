#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * 阶段衰退 CLI：先看，再动手。
 *
 *   node tools/decay.mjs                        # 预览（默认库 .dsh-meow/memory.db）
 *   node tools/decay.mjs --db E:\x\memory.db
 *   node tools/decay.mjs --apply                # 真沉底（自动 VACUUM INTO 备份）
 *   node tools/decay.mjs --json
 *   node tools/decay.mjs --days 60 --max-importance 1 --tables fact,lesson
 */
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { previewDecay, applyDecay } from '../memory/decay.mjs'

const argv = process.argv.slice(2)
const has = (n) => argv.includes(`--${n}`)
const arg = (n, def) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}

function findDb() {
  let dir = process.cwd()
  for (let i = 0; i < 6; i += 1) {
    const p = resolve(dir, '.dsh-meow', 'memory.db')
    if (existsSync(p)) return p
    const up = resolve(dir, '..')
    if (up === dir) break
    dir = up
  }
  return resolve(process.cwd(), '.dsh-meow', 'memory.db')
}
// 默认指向退役库 .dsh-meow/memory.db：数据已全迁 soulweave，这里保留只为能读历史。
// 新数据一律用 --db 指到 ~/.dsh/soulweave/soul-memory.db。
const dbPath = resolve(arg('db', findDb()))
const options = {
  minIdleDays: Number(arg('days', 45)),
  relabelDays: Number(arg('relabel-days', 30)),
  maxImportance: Number(arg('max-importance', 2)),
  tables: String(arg('tables', 'fact,lesson,topic,project')).split(',').map((s) => s.trim()).filter(Boolean),
}
const limit = Number(arg('limit', 30))
const asJson = has('json')

const prev = previewDecay(dbPath, options)
if (!prev.ok) {
  console.error(`失败：${prev.error}`)
  process.exit(1)
}

if (asJson && !has('apply')) {
  console.log(JSON.stringify(prev, null, 2))
  process.exit(0)
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`库：${dbPath}`)
console.log(`判定：闲置 ≥ ${options.minIdleDays} 天、重要性 ≤ ${options.maxImportance}、沉底满 ${options.relabelDays} 天转 stale`)
console.log(`${prev.note}（扫了 ${prev.scanned} 条 active）\n`)
if (prev.candidates.length > 0) {
  console.log(`${pad('阶段', 6)}${pad('闲置', 6)}${pad('重要', 5)}${pad('表', 8)}${pad('id', 30)}标题`)
  for (const c of prev.candidates.slice(0, limit)) {
    console.log(
      `${pad(c.stage, 6)}${pad(c.idleDays + 'd', 6)}${pad(c.importance, 5)}${pad(c.table, 8)}${pad(c.id, 30)}${c.title}`,
    )
  }
  if (prev.candidates.length > limit) console.log(`… 还有 ${prev.candidates.length - limit} 条（--limit 调大）`)
}

if (!has('apply')) {
  console.log('\n这是预览。要真的沉底加 --apply（会先备份）。')
  process.exit(0)
}
if (prev.candidates.length === 0) process.exit(0)

const res = applyDecay(dbPath, prev.candidates.map((c) => ({ table: c.table, id: c.id, stage: c.stage })), options)
if (!res.ok) {
  console.error(`失败：${res.error}`)
  process.exit(1)
}
console.log(`\n已备份：${res.backup}`)
console.log(`改动 ${res.changed.length} 条：`)
for (const c of res.changed) console.log(`  ${c.action}  ${c.table}#${c.id}${c.importance != null ? ` → importance ${c.importance}` : ''}`)
console.log(res.note)