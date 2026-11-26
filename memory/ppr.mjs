// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * memory/ppr.mjs —— 第六路：PPR 图扩散（SPEC-V2 §4）。
 *
 * 纯算法，无 IO：给节点、边、种子分布，返回 rank。
 * 硬约束：**只走 2 跳**。跳数按无向图 BFS 算，超过 2 的节点权重强制归零，
 * 而不是靠阻尼自然衰减——衰减到 3 跳还有余量，会破坏「只联想两层」的语义。
 *
 * rank(v) = (1-α)·p(v) + α·Σ_{u→v} w(u,v)/deg(u)·rank(u)
 * 枢纽惩罚：deg(u) > P95 时转移再乘 1/log(deg(u))。
 */

export const PPR_DEFAULT_ALPHA = 0.6
export const PPR_MAX_HOPS = 2
const EPS = 1e-9
const MAX_ITER = 60

/** 归一化种子：接受 Map / 数组 / 单 id。没有正权重时返回空 Map。 */
export function normalizeSeeds(seeds) {
  const out = new Map()
  if (seeds instanceof Map) {
    for (const [id, w] of seeds) {
      const n = Number(w)
      if (Number.isFinite(n) && n > 0) out.set(String(id), n)
    }
  } else if (Array.isArray(seeds)) {
    for (const item of seeds) {
      if (item == null) continue
      const id = typeof item === 'object' ? item.id : item
      const w = typeof item === 'object' ? Number(item.weight ?? item.p ?? 1) : 1
      if (id != null && Number.isFinite(w) && w > 0) out.set(String(id), w)
    }
  } else if (seeds && typeof seeds === 'object') {
    // 也收 plain object：{ id: weight }
    for (const [id, w] of Object.entries(seeds)) {
      const n = Number(w)
      if (Number.isFinite(n) && n > 0) out.set(String(id), n)
    }
  } else if (typeof seeds === 'string' || typeof seeds === 'number') {
    out.set(String(seeds), 1)
  }
  let total = 0
  for (const w of out.values()) total += w
  if (total <= 0) return new Map()
  for (const [id, w] of out) out.set(id, w / total)
  return out
}

/**
 * 无向 BFS 跳数（从所有种子出发，跳数 0）。
 * @returns {Map<string, number>}
 */
export function hopsFromSeeds(seeds, adjacency) {
  const hops = new Map()
  const queue = []
  for (const id of seeds.keys()) {
    hops.set(id, 0)
    queue.push(id)
  }
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head]
    const h = hops.get(u)
    if (h >= PPR_MAX_HOPS) continue
    for (const edge of adjacency.get(u) ?? []) {
      if (hops.has(edge.to)) continue
      hops.set(edge.to, h + 1)
      queue.push(edge.to)
    }
  }
  return hops
}

/** 度数表：无向图里每个节点出现一次算一度。 */
function degreeOf(adjacency) {
  const deg = new Map()
  for (const [from, list] of adjacency) {
    deg.set(from, (deg.get(from) ?? 0) + list.length)
    for (const edge of list) deg.set(edge.to, (deg.get(edge.to) ?? 0) + 1)
  }
  return deg
}

/** P95 分位（节点度数），样本少于 5 时返回 Infinity（不启用枢纽惩罚）。 */
function p95(values) {
  if (values.length < 5) return Infinity
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
  return sorted[idx]
}

/**
 * @param {object} input
 * @param {Iterable<string>|Map<string,number>} input.nodes 参与计算的节点（不传则从边推）
 * @param {Iterable<{from:string,to:string,weight?:number}>} input.edges 无向边；重复方向会合并
 * @param {Map|Array|string|number} input.seeds 原五路召回分布
 * @param {number} [input.alpha] 阻尼；一般取当前会话 momentum
 * @returns {{ rank: Map<string, number>, hops: Map<string, number>, scanned: number }}
 */
export function personalizedPageRank({ nodes, edges, seeds, alpha = PPR_DEFAULT_ALPHA } = {}) {
  const seedMap = normalizeSeeds(seeds)
  if (seedMap.size === 0) return { rank: new Map(), hops: new Map(), scanned: 0 }

  // 无向邻接：同一对节点只留一条，权重取较大值（防止双向重复边把度翻倍）
  const pairKey = (a, b) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)
  const pairs = new Map()
  for (const edge of edges ?? []) {
    // 同时接受 {from,to}（内存图）和 {a,b}（memory_edge 表读出来的行）
    const from = String(edge?.from ?? edge?.a ?? '')
    const to = String(edge?.to ?? edge?.b ?? '')
    if (!from || !to || from === to) continue
    const weight = Number(edge.weight ?? 1)
    if (!Number.isFinite(weight) || weight <= 0) continue
    const key = pairKey(from, to)
    const prev = pairs.get(key)
    if (!prev || weight > prev.weight) pairs.set(key, { a: from < to ? from : to, b: from < to ? to : from, weight })
  }

  const adjacency = new Map()
  const add = (from, to, weight) => {
    if (!adjacency.has(from)) adjacency.set(from, [])
    adjacency.get(from).push({ to, weight })
  }
  for (const { a, b, weight } of pairs.values()) {
    add(a, b, weight)
    add(b, a, weight)
  }
  for (const node of nodes ?? []) {
    const id = String(node)
    if (!adjacency.has(id)) adjacency.set(id, [])
  }

  const hops = hopsFromSeeds(seedMap, adjacency)
  if (hops.size === 0) return { rank: new Map(), hops, scanned: 0 }

  const deg = degreeOf(adjacency)
  const threshold = p95([...deg.values()])
  const hubPenalty = (u) => {
    const d = deg.get(u) ?? 0
    return d > threshold && d >= 3 ? 1 / Math.log(d) : 1
  }

  // 只在 2 跳子图上迭代；子图外的节点不参与，也不承接质量
  const allowed = new Set(
    [...hops.entries()].filter(([, h]) => h <= PPR_MAX_HOPS).map(([id]) => id),
  )
  let rank = new Map()
  for (const id of allowed) rank.set(id, Number(seedMap.get(id) ?? 0))

  const a = Math.max(0, Math.min(0.99, Number(alpha)))
  for (let iter = 0; iter < MAX_ITER; iter += 1) {
    const next = new Map()
    for (const id of allowed) next.set(id, (1 - a) * Number(seedMap.get(id) ?? 0))
    for (const [u, list] of adjacency) {
      const ru = rank.get(u) ?? 0
      if (ru <= EPS || list.length === 0) continue
      const share = (ru * hubPenalty(u)) / list.length
      for (const edge of list) {
        if (!allowed.has(edge.to)) continue
        next.set(edge.to, (next.get(edge.to) ?? 0) + a * share * edge.weight)
      }
    }
    let delta = 0
    let total = 0
    for (const [id, value] of next) {
      delta += Math.abs(value - (rank.get(id) ?? 0))
      total += value
    }
    rank = next
    if (total > 0 && delta < 1e-7) break
  }

  // 归一化（只保留正数）
  let sum = 0
  for (const value of rank.values()) sum += value
  if (sum <= 0) return { rank: new Map(), hops, scanned: allowed.size }
  for (const [id, value] of rank) {
    if (value <= 0) rank.delete(id)
    else rank.set(id, value / sum)
  }
  return { rank, hops, scanned: allowed.size }
}