// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * memory/graph.mjs —— L1 记忆层的边（SPEC-V2 §4 建边规则）。
 *
 * 不用关键词重叠建边。判据是「情景关联系数」：
 * 两条记忆的 when_ctx 在 tool / pathPattern / timeWindow 任一项相等，就连一条 `same-scene`。
 *
 * 第一版只实现 same-scene；same-source / causal 留接口。
 * 建边是纯函数（sameSceneEdges），落库函数单独放下面，方便单测。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const EDGE_TABLE = 'memory_edge'
export const RELATION_SAME_SCENE = 'same-scene'
export const RELATION_SAME_SOURCE = 'same-source'

const WHEN_FIELDS = ['tool', 'pathPattern', 'timeWindow']

/** 幂等建边表。a < b 归一化，一条边只存一行。 */
export function ensureEdgeTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EDGE_TABLE} (
      a           TEXT NOT NULL,
      b           TEXT NOT NULL,
      relation    TEXT NOT NULL DEFAULT 'same-scene',
      weight      REAL NOT NULL DEFAULT 1,
      hits        INTEGER NOT NULL DEFAULT 0,
      bad         INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (a, b, relation)
    );
    CREATE INDEX IF NOT EXISTS memory_edge_a ON ${EDGE_TABLE}(a);
    CREATE INDEX IF NOT EXISTS memory_edge_b ON ${EDGE_TABLE}(b);
  `)
}

/**
 * 由带 when 的记忆条目生成 same-scene 边。
 *
 * @param {Array<{id:string, when?:{tool?:string,pathPattern?:string,timeWindow?:string}, at?:number}>} entries
 * @param {{maxDegree?:number}} [options] 每节点最多连几条（默认 16，防 O(n²) 爆炸）
 * @returns {Array<{a:string,b:string,relation:string,weight:number,fields:string[]}>}
 */
export function sameSceneEdges(entries, options = {}) {
  const maxDegree = Math.max(1, Number(options.maxDegree ?? 16))
  const list = []
  for (const entry of entries ?? []) {
    const id = String(entry?.id ?? '')
    if (!id) continue
    const when = entry.when && typeof entry.when === 'object' ? entry.when : {}
    const fields = {}
    for (const key of WHEN_FIELDS) {
      const value = String(when[key] ?? '').trim()
      if (value) fields[key] = value
    }
    if (Object.keys(fields).length === 0) continue
    list.push({ id, fields, at: Number(entry.at ?? 0) })
  }

  // 每个字段一个桶：bucket[field][value] = [index...]
  const buckets = new Map(WHEN_FIELDS.map((field) => [field, new Map()]))
  list.forEach((entry, index) => {
    for (const [field, value] of Object.entries(entry.fields)) {
      const bucket = buckets.get(field)
      if (!bucket.has(value)) bucket.set(value, [])
      bucket.get(value).push(index)
    }
  })

  // 候选对：key = "i,j"，值 = 命中字段集合
  const pairs = new Map()
  for (const [field, bucket] of buckets) {
    for (const indexes of bucket.values()) {
      // 同一个桶超过 64 条时只取时间最近的 64 条，避免一次建边把 CPU 打满
      const near = indexes.length > 64
        ? [...indexes].sort((x, y) => Math.abs(list[x].at - list[y].at)).slice(0, 64)
        : indexes
      for (let i = 0; i < near.length; i += 1) {
        for (let j = i + 1; j < near.length; j += 1) {
          const a = Math.min(near[i], near[j])
          const b = Math.max(near[i], near[j])
          const key = `${a},${b}`
          if (!pairs.has(key)) pairs.set(key, new Set())
          pairs.get(key).add(field)
        }
      }
    }
  }

  // 每个节点只留得分最高的 maxDegree 条：命中字段多优先，其次时间近
  const byNode = new Map()
  for (const [key, fields] of pairs) {
    const [i, j] = key.split(',').map(Number)
    const score = fields.size * 1e12 - Math.abs(list[i].at - list[j].at)
    for (const [self, other] of [[i, j], [j, i]]) {
      if (!byNode.has(self)) byNode.set(self, [])
      byNode.get(self).push({ other, key, fields, score })
    }
  }
  const keep = new Set()
  for (const bucket of byNode.values()) {
    bucket.sort((x, y) => y.score - x.score)
    for (const item of bucket.slice(0, maxDegree)) keep.add(item.key)
  }

  const edges = []
  for (const key of keep) {
    const [i, j] = key.split(',').map(Number)
    const fields = [...pairs.get(key)].sort()
    const a = list[i].id < list[j].id ? list[i].id : list[j].id
    const b = list[i].id < list[j].id ? list[j].id : list[i].id
    edges.push({ a, b, relation: RELATION_SAME_SCENE, weight: 1, fields })
  }
  return edges
}

/**
 * 同一来源会话建 `same-source` 边（规范 §4 预留的接口，v0 先用它把图撑起来）。
 * 组内按时间排序，每节点只连最近的 maxDegree 条。
 *
 * @param {Array<{id:string, source?:string, at?:number}>} entries
 * @param {{maxDegree?:number}} [options]
 */
export function sameSourceEdges(entries, options = {}) {
  const maxDegree = Math.max(1, Number(options.maxDegree ?? 16))
  const groups = new Map()
  for (const entry of entries ?? []) {
    const id = String(entry?.id ?? '')
    const source = String(entry?.source ?? '').trim()
    if (!id || !source) continue
    if (!groups.has(source)) groups.set(source, [])
    groups.get(source).push({ id, at: Number(entry.at ?? 0) })
  }
  const edges = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    group.sort((a, b) => b.at - a.at)
    // 时间滑动窗：每个节点连它后面最近的 maxDegree 条
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < Math.min(group.length, i + 1 + maxDegree); j += 1) {
        const a = group[i].id < group[j].id ? group[i].id : group[j].id
        const b = group[i].id < group[j].id ? group[j].id : group[i].id
        edges.push({ a, b, relation: RELATION_SAME_SOURCE, weight: 1 })
      }
    }
  }
  return edges
}

/** 打开（必要时创建）图库。 */
export function openGraphDb(dbPath) {
  try {
    if (!existsSync(dbPath)) mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    ensureEdgeTable(db)
    return db
  } catch {
    return null
  }
}

/** 批量 upsert；已有边只刷新 updated_at，不覆盖 hits/bad/weight。 */
export function upsertEdges(db, edges, { now = Date.now() } = {}) {
  if (!db || !Array.isArray(edges) || edges.length === 0) return { ok: true, written: 0 }
  ensureEdgeTable(db)
  const stmt = db.prepare(`
    INSERT INTO ${EDGE_TABLE} (a,b,relation,weight,hits,bad,created_at,updated_at)
    VALUES (?,?,?,?,0,0,?,?)
    ON CONFLICT(a,b,relation) DO UPDATE SET updated_at=excluded.updated_at
  `)
  let written = 0
  db.exec('BEGIN')
  try {
    for (const edge of edges) {
      if (!edge?.a || !edge?.b || edge.a === edge.b) continue
      stmt.run(String(edge.a), String(edge.b), String(edge.relation ?? RELATION_SAME_SCENE),
        Number(edge.weight ?? 1), Number(now), Number(now))
      written += 1
    }
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    return { ok: false, error: String(error?.message ?? error), written: 0 }
  }
  return { ok: true, written }
}

/** 读边（默认只读 same-scene）。 */
export function readEdges(db, { relation = RELATION_SAME_SCENE } = {}) {
  if (!db) return []
  try {
    return db.prepare(`SELECT a,b,relation,weight,hits,bad FROM ${EDGE_TABLE} WHERE relation = ?`)
      .all(String(relation))
      .map((row) => ({ ...row, weight: Number(row.weight ?? 1) }))
  } catch {
    return []
  }
}

/** 连通分量统计：给验收判据「最大分量占比 > 30%」用。 */
export function graphStats(edges) {
  const parent = new Map()
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x)
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)
    while (parent.get(x) !== root) { const next = parent.get(x); parent.set(x, root); x = next }
    return root
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const nodes = new Set()
  for (const edge of edges ?? []) {
    nodes.add(String(edge.a))
    nodes.add(String(edge.b))
    union(String(edge.a), String(edge.b))
  }
  const sizes = new Map()
  for (const node of nodes) {
    const root = find(node)
    sizes.set(root, (sizes.get(root) ?? 0) + 1)
  }
  let largest = 0
  for (const size of sizes.values()) largest = Math.max(largest, size)
  return {
    nodes: nodes.size,
    edges: (edges ?? []).length,
    components: sizes.size,
    largest,
    ratio: nodes.size === 0 ? 0 : largest / nodes.size,
  }
}