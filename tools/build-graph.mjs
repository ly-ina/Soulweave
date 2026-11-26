#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/build-graph.mjs —— 从 when_index 建 L1 记忆层的 same-scene 边。
 *
 * 默认 dry-run：只报统计，不写库。加 --apply 才写。
 *
 *   node tools/build-graph.mjs                    # 看这批数据能连成什么样
 *   node tools/build-graph.mjs --apply            # 写进 soul-memory.db
 *   node tools/build-graph.mjs --max-degree 24    # 每节点最多连几条
 *   node tools/build-graph.mjs --all              # 七层老表的 when 也进图（默认只收 memories）
 *
 * 节点 id 统一成 `<level>#<entry_id>`：七层老表和 memories 的 id 可能撞号。
 */
import '../io-node.mjs'
import '../storage/node-sqlite.mjs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sameSceneEdges, sameSourceEdges, upsertEdges, readEdges, graphStats, ensureEdgeTable, RELATION_SAME_SCENE, RELATION_SAME_SOURCE } from '../memory/graph.mjs'
import { openDatabase } from '../storage/index.mjs'

const args = process.argv.slice(2)
const has = (n) => args.includes(`--${n}`)
const opt = (n, def) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : def
}
const num = (n, def) => {
  const v = opt(n)
  return v === undefined ? def : Number(v)
}

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const MEM = opt('mem-db', join(DSH_HOME, 'soulweave', 'soul-memory.db'))
const ALL = has('all')
const APPLY = has('apply')
const MAX_DEGREE = num('max-degree', 16)

if (!existsSync(MEM)) {
  console.error(`记忆库不存在：${MEM}`)
  process.exit(2)
}

const db = openDatabase(MEM)
if (!db) {
  console.error('记忆库打不开')
  process.exit(2)
}
ensureEdgeTable(db)

const levels = ALL
  ? ["'soul'", "'rules'", "'user'", "'project'", "'fact'", "'topic'", "'lesson'", "'memories'"]
  : ["'memories'"]

let rows = []
try {
  rows = db.prepare(`SELECT level, entry_id, when_ctx FROM when_index WHERE level IN (${levels.join(',')})`).all()
} catch {
  rows = []
}

const entries = []
for (const row of rows) {
  let when = null
  try { when = JSON.parse(String(row.when_ctx ?? '')) } catch { when = null }
  if (!when || typeof when !== 'object') continue
  entries.push({ id: `${row.level}#${row.entry_id}`, when, at: 0 })
}

// 用 memories.updated_at 当时间近度（没有 when 的条目本来也不进图）
try {
  const times = new Map(
    db.prepare('SELECT id, updated_at FROM memories').all()
      .map((row) => [`memories#${row.id}`, Number(row.updated_at) || 0]),
  )
  for (const entry of entries) {
    if (times.has(entry.id)) entry.at = times.get(entry.id)
  }
} catch { /* 没有 memories 表就按 0 */ }

const sceneEdges = sameSceneEdges(entries, { maxDegree: MAX_DEGREE })

// same-source：同一会话的记忆天然同源，先把 L1 图撑起来（history 里 when 还很少）
let sourceEntries = []
try {
  sourceEntries = db.prepare('SELECT id, source_session, updated_at FROM memories WHERE status = ?').all('active')
    .map((row) => ({ id: `memories#${row.id}`, source: String(row.source_session ?? ''), at: Number(row.updated_at) || 0 }))
} catch { sourceEntries = [] }
const sourceEdges = sameSourceEdges(sourceEntries, { maxDegree: MAX_DEGREE })

const edges = [...sceneEdges, ...sourceEdges]
const stats = graphStats(edges)
const before = readEdges(db)
const out = {
  db: MEM,
  entries: entries.length,
  edges: edges.length,
  sceneEdges: sceneEdges.length,
  sourceEdges: sourceEdges.length,
  maxDegree: MAX_DEGREE,
  components: stats.components,
  largest: stats.largest,
  ratio: Number(stats.ratio.toFixed(3)),
  existing: before.length,
  applied: false,
}
if (APPLY) {
  const written = upsertEdges(db, edges)
  out.applied = written.ok
  out.written = written.written
  if (!written.ok) out.error = written.error
  out.after = readEdges(db, { relation: RELATION_SAME_SCENE }).length + readEdges(db, { relation: RELATION_SAME_SOURCE }).length
}
db.close()
console.log(JSON.stringify(out, null, 2))