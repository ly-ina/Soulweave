#!/usr/bin/env node
/**
 * tools/when-stats.mjs —— when_ctx 命中统计 + 误报标注。
 *
 * 用法：
 *   node tools/when-stats.mjs [--db <memory.db>] [--limit 20]
 *   node tools/when-stats.mjs --bad fact#0mwp8jcoz
 *   node tools/when-stats.mjs --json
 *
 * 计数由 adapters/dsh/prestep.mjs 在每次命中时写入（dry-run 也写）。
 * 误报只能人工标：看到 when-dry 日志里某条不该触发，就 --bad 一次。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { markWhenBad, readWhenStats } from '../memory/when.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(name)

// 默认指向退役库 .dsh-meow/memory.db：数据已全迁 soulweave，这里保留只为能读历史。
// 新数据一律用 --db 指到 ~/.dsh/soulweave/soul-memory.db。
const dbPath = arg('--db', process.env.DSH_MEMORY_DB || join(process.cwd(), '.dsh-meow', 'memory.db'))
const limit = Number(arg('--limit', '20'))
const badTarget = arg('--bad')

if (!existsSync(dbPath)) {
  console.error(`记忆库不存在：${dbPath}`)
  process.exit(2)
}

if (badTarget) {
  const [level, ...rest] = badTarget.split('#')
  const id = rest.join('#')
  if (!level || !id) {
    console.error('--bad 要写成 <level>#<id>，例如 fact#0mwp8jcoz')
    process.exit(2)
  }
  const out = markWhenBad(dbPath, level, id)
  console.log(out.ok ? `已标注误报：${level}#${id}（changes=${out.changes}）` : `标注失败：${out.error}`)
  process.exit(out.ok ? 0 : 1)
}

const stats = readWhenStats(dbPath)
if (!stats.ok) {
  console.error(`读统计失败：${stats.error}`)
  process.exit(1)
}
if (flag('--json')) {
  console.log(JSON.stringify(stats.rows, null, 2))
  process.exit(0)
}
if (stats.rows.length === 0) {
  console.log('when_index 还是空的：没有任何条目签过 when_ctx。')
  process.exit(0)
}

const fmtTime = (ms) => {
  const n = Number(ms ?? 0)
  if (!n) return '-'
  const d = new Date(n)
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const total = stats.rows.reduce((sum, row) => sum + row.hit_count, 0)
const bad = stats.rows.reduce((sum, row) => sum + row.bad_count, 0)
console.log(`库：${dbPath}`)
console.log(`共 ${stats.rows.length} 条签了 when，累计命中 ${total} 次，其中标为误报 ${bad} 次。\n`)
console.log('命中  误报  最近命中              id                         when')
for (const row of stats.rows.slice(0, limit)) {
  const id = `${row.level}#${row.entry_id}`
  console.log(
    `${String(row.hit_count).padStart(4)}  ${String(row.bad_count).padStart(4)}  ${fmtTime(row.last_hit).padEnd(19)}  ${id.padEnd(26)} ${String(row.when_ctx).slice(0, 80)}`,
  )
}
if (stats.rows.length > limit) console.log(`\n…还有 ${stats.rows.length - limit} 条（--limit 调大）`)