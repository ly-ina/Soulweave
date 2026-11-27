// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/tree/matrix.mjs —— 原文级记忆矩阵（第一刀的地基）。
 *
 * 只做三件事，全部是集合运算，不引入分数、阈值、相似度：
 *   1. 建索引：term → 出现在哪些 frag（postings）
 *   2. 取 profile：一组 frag 里「复现才成项」的那些 term
 *   3. 判归属：一个 frag 的项集与某 profile 是「只在这间 / 几间都有 / 没有」
 *
 * 为什么不在这里算权重：
 *   魂织的既有阻尼、势能机是量化的，保留不动；魂汐这一层按 2026-11-27 的
 *   第二条硬约束尽量不量化。归属先做资格判断（有无、是否唯一），排序交给
 *   字典序（先房间、再锚、再时间），不掺加权求和。
 *
 * 零依赖：不 import node:，也不 import io.mjs —— 纯函数，输入输出都是普通对象。
 */

/**
 * 产物 vs 目标。
 *
 * 路径、文件名、命令、标识符、纯数字，都是**产物**：它们说明「刚做了什么」，
 * 不说明「这件事在讲什么」。一条 frag 里出现 `E:\...\x.mjs`，是那次动作的落点，
 * 不是这条记忆的主题。所以它们不能当投影的判据——判据只收承载意图与命题的词。
 *
 * 2026-11-27 伊纳的原话：「路径不应该作为投影，因为路径是产物不是目标。」
 *
 * 纯 ASCII 一律按产物处理：小汐的记忆是中文语料，代码与命令里的英文词
 * 绝大多数是文本长相，不是她要记住的东西。真有只以英文存在的概念，
 * 会以中文说法在别处复现；这一层宁可漏，不可脏。
 */
const ARTIFACT_RE = /[\\/]|:\/\/|^[A-Za-z0-9][A-Za-z0-9_.:-]*$|^\d+$/

export function isArtifactTerm(term) {
  const t = String(term || '').trim()
  if (!t) return true
  return ARTIFACT_RE.test(t)
}

/**
 * 建一个索引。
 * @param {Iterable<{id: string, terms: string[]}>} docs 每条原文的 id 与切好的词
 * @returns {{postings: Map<string, Set<string>>, df: Map<string, number>, docs: number}}
 */
export function buildIndex(docs) {
  const postings = new Map()
  let n = 0
  for (const doc of docs) {
    if (!doc || !doc.id) continue
    n += 1
    const seen = new Set()
    for (const raw of doc.terms || []) {
      const term = String(raw || '').trim()
      if (!term || seen.has(term)) continue
      seen.add(term)
      let set = postings.get(term)
      if (!set) {
        set = new Set()
        postings.set(term, set)
      }
      set.add(doc.id)
    }
  }
  const df = new Map()
  for (const [term, set] of postings) df.set(term, set.size)
  return { postings, df, docs: n }
}

/**
 * 一组 frag 的项集：在这组里出现过的 term（去掉产物词）。
 *
 * **没有「复现次数」门槛。**（2026-11-27 伊纳）
 * 用复现次数当条件，分子分母是同一个计数：语料越大，命中自己就涨了，
 * 等于不需要条件也会「通过」。条件只能设在真正会失效的地方——跨房。
 *
 * @param {{postings: Map<string, Set<string>>}} index
 * @param {Iterable<string>} ids
 * @param {{exclude?: Iterable<string>}} [opts]
 * @returns {{term: string, ids: string[]}[]} 按 term 字典序，稳定可复现
 */
export function profileOf(index, ids, opts = {}) {
  const want = new Set(ids)
  if (want.size === 0) return []
  const exclude = new Set(opts.exclude || [])
  const out = []
  for (const [term, set] of index.postings) {
    if (exclude.has(term)) continue
    if (isArtifactTerm(term)) continue
    const hit = []
    for (const id of set) if (want.has(id)) hit.push(id)
    if (hit.length > 0) out.push({ term, ids: hit })
  }
  out.sort((a, b) => (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
  return out
}

/**
 * 每间房各自独占的 term。
 *
 * 一个 term 如果在两间以上房间都稳定出现，就**不属于任何一间**——
 * 它不是判据，是共性。这比「算一个区分度分数再砍阈值」更不容易漂：
 * 房间一变多，共性项自动全部出局，不需要调参。
 *
 * @param {{postings: Map<string, Set<string>>}} index
 * @param {Map<string, Set<string>>} roomSets room → frag id 集合
 * @param {{base?: string}} [opts]
 *   base = 底座房。它每条都沾，不是区分器；算「跨房」时必须把它排除，
 *   否则任何项都同时属于底座房和它的房，全部变成 shared。
 * @returns {Map<string, {own: Set<string>, shared: Set<string>, profile: {term:string,ids:string[]}[]}>}
 */
export function roomProfiles(index, roomSets, opts = {}) {
  const base = opts.base ?? 'episode'
  /** term → 出现在哪几间（底座房不算） */
  const where = new Map()
  const termsOf = new Map()
  for (const [room, ids] of roomSets) {
    if (room === base) continue
    const list = profileOf(index, ids)
    termsOf.set(room, list)
    for (const item of list) {
      let set = where.get(item.term)
      if (!set) {
        set = new Set()
        where.set(item.term, set)
      }
      set.add(room)
    }
  }
  const result = new Map()
  for (const [room, list] of termsOf) {
    const own = new Set()
    const shared = new Set()
    for (const item of list) {
      const rooms = where.get(item.term)
      if (rooms && rooms.size > 1) shared.add(item.term)
      else own.add(item.term)
    }
    result.set(room, {
      own,
      shared,
      profile: list.filter((item) => own.has(item.term)),
    })
  }
  return result
}

/**
 * 判一个 frag 的项集落在哪间房。返回集合关系，不返回分数。
 *
 * verdict:
 *   'only'   只与一间房的 profile 重叠 → 落这间（+底座房）
 *   'multi'  与多间重叠 → 按字典序取第一间，其余记进 evidence 供解释
 *   'none'   谁都不沾 → 只落底座房（情景房），不做兜底猜测
 *
 * @param {Iterable<string>} terms
 * @param {Map<string, {own: Set<string>}>} profiles
 * @returns {{verdict: 'only'|'multi'|'none', rooms: string[], evidence: Record<string,string[]>}}
 */
export function classify(terms, profiles) {
  const evidence = {}
  const rooms = []
  for (const term of new Set(terms || [])) {
    for (const [room, p] of profiles) {
      if (!p || !p.own || !p.own.has(term)) continue
      if (!evidence[room]) {
        evidence[room] = []
        rooms.push(room)
      }
      evidence[room].push(term)
    }
  }
  // 字典序：先按命中项数？不——按项数就是量化。按房间 id 字典序，稳定且可解释。
  rooms.sort()
  const verdict = rooms.length === 0 ? 'none' : rooms.length === 1 ? 'only' : 'multi'
  return { verdict, rooms, evidence }
}

/**
 * 解释一个 term：它在哪些 frag 里出现过、出现几次房间。
 * 只给事实，不做判断——判断留给调用方（或人）。
 */
export function explainTerm(index, term) {
  const set = index.postings.get(String(term || '')) || new Set()
  return { term, df: set.size, ids: [...set] }
}
