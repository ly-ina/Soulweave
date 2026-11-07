/**
 * hybrid.mjs · RRF 混合召回（零依赖）
 *
 * 两路候选取并集，不是只重排 BM25：
 *   ① BM25/关键词召回（魂引后端自带）
 *   ② 向量召回（可选模块，自带全库索引）
 * 两份名次用 RRF 相加，只用名次，不做加权求和（两边分不同量纲）。
 * 公式：score = 1/(k + bm25Rank) + 1/(k + vecRank)，k 默认 60。
 *
 * 失败即回退：没有 recall、recall 抛错、返回不是数组，
 * 一律原样返回 BM25 结果。重排是加分项，不能把原有能力搞挂。
 */

export const DEFAULT_RRF_K = 60
export const DEFAULT_CANDIDATES = 24

function keyOf(entry, index) {
  const loc = entry && typeof entry.loc === 'string' ? entry.loc : ''
  return loc !== '' ? loc : '#' + index
}

function rankMap(entries) {
  const map = new Map()
  entries.forEach((entry, index) => {
    const key = keyOf(entry, index)
    if (!map.has(key)) map.set(key, index)
  })
  return map
}

/**
 * @param {object} options
 * @param {(query: string, limit: number) => any} options.search BM25 路
 * @param {((query: string, limit: number) => Promise<object[]>) | null} [options.recall] 向量路
 * @param {number} [options.rrfK]
 * @param {number} [options.candidates]
 */
export function createHybridSearch(options = {}) {
  const { search, recall = null, rrfK = DEFAULT_RRF_K, candidates = DEFAULT_CANDIDATES } = options
  if (typeof search !== 'function') throw new TypeError('createHybridSearch 需要 search 函数')
  const k = Number.isFinite(rrfK) && rrfK > 0 ? rrfK : DEFAULT_RRF_K
  const cand = Number.isFinite(candidates) && candidates > 1 ? candidates : DEFAULT_CANDIDATES
  const canRecall = typeof recall === 'function'

  return async function hybridSearch(query, limit = 5) {
    const text = String(query ?? '')
    const want = Math.max(1, Number(limit) || 5)
    const take = Math.max(want, cand)
    const base = await search(text, take)
    const bmEntries = Array.isArray(base && base.entries) ? base.entries : []
    if (!canRecall) return base

    let vecEntries
    try {
      vecEntries = await recall(text, take)
    } catch {
      return base
    }
    if (!Array.isArray(vecEntries) || vecEntries.length === 0) return base

    const bmRank = rankMap(bmEntries)
    const vecRank = rankMap(vecEntries)
    const byKey = new Map()
    bmEntries.forEach((entry, index) => byKey.set(keyOf(entry, index), entry))
    vecEntries.forEach((entry, index) => {
      const key = keyOf(entry, index)
      if (!byKey.has(key)) byKey.set(key, entry)
    })

    const missing = k + take + 1
    const merged = []
    for (const [key, entry] of byKey) {
      const bm = bmRank.has(key) ? k + bmRank.get(key) + 1 : missing
      const vr = vecRank.has(key) ? k + vecRank.get(key) + 1 : missing
      merged.push({ entry, score: 1 / bm + 1 / vr })
    }
    merged.sort((a, b) => b.score - a.score)
    return { ...base, entries: merged.slice(0, want).map((item) => item.entry) }
  }
}
