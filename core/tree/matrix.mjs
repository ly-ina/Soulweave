// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/tree/matrix.mjs —— 原文级记忆矩阵（第一刀的地基）。
 *
 * 单位不是「词」，是「命题对」：同一句里同时出现的两个词。
 * 2026-11-27 实测（docs/HUNXI-ROADMAP.md §十二）：
 *   - 词不分房间，命题才分；own-term profile 只是在测词的稀有度。
 *   - 单跳（单个词）无信息；两跳（共现对）有 18–22× 信号。
 * 所以 profile 的原子从 term 换成 pair。pair 同时保留来源句 sent_id——
 * 判据要能被看见：这条为什么在空间房，能指回是哪几句给出这个对。
 *
 * 只做集合运算，不引入分数、阈值、相似度：
 *   1. 建索引：pair → 出现在哪些句（postings）
 *   2. 取 profile：一组句子里出现过的 pair（去掉产物词）
 *   3. 判归属：一个句子的 pair 集与某 profile 是「只在这间 / 几间都有 / 没有」
 *
 * 唯一的门槛是跨房：一个 pair 在两间以上房间都出现，就不属于任何一间——
 * 它不是判据，是共性。房间一变多，共性项自动全部出局，不需要调参。
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
 * 命题对的内部键。只在内存里用，不落库——
 * 落库拆成 pair_a / pair_b 两列，避免分隔符与 SQLite 的 NUL 问题。
 */
export function pairKey(a, b) {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

export function pairTerms(key) {
  const s = String(key || '')
  const i = s.indexOf('\u0000')
  if (i < 0) return [s, '']
  return [s.slice(0, i), s.slice(i + 1)]
}

export function pairLabel(key) {
  const [a, b] = pairTerms(key)
  return `${a}·${b}`
}

/**
 * 一句的命题对集合：句内两两无序对。
 * 先过滤产物词，再去重——同一句里重复出现不产生新对。
 *
 * @param {Iterable<string>} terms
 * @param {{exclude?: Iterable<string>}} [opts]
 * @returns {string[]} 已排序的 pair key，稳定可复现
 */
export function pairsOf(terms, opts = {}) {
  const exclude = new Set(opts.exclude || [])
  const seen = new Set()
  for (const raw of terms || []) {
    const t = String(raw || '').trim()
    if (!t || seen.has(t)) continue
    if (exclude.has(t)) continue
    if (isArtifactTerm(t)) continue
    seen.add(t)
  }
  const list = [...seen].sort()
  const out = []
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) out.push(pairKey(list[i], list[j]))
  }
  return out
}

/**
 * 建一个命题对索引。
 * @param {Iterable<{id: string, terms: string[]}>} docs 每条原文/句子的 id 与切好的词
 * @returns {{postings: Map<string, Set<string>>, docs: number}}
 */
export function buildPairIndex(docs) {
  const postings = new Map()
  let n = 0
  for (const doc of docs) {
    if (!doc || !doc.id) continue
    n += 1
    for (const key of pairsOf(doc.terms)) {
      let set = postings.get(key)
      if (!set) {
        set = new Set()
        postings.set(key, set)
      }
      set.add(doc.id)
    }
  }
  return { postings, docs: n }
}

/**
 * 一组句子的项集：在这些句子里出现过的命题对。
 *
 * **没有「复现次数」门槛。**（2026-11-27 伊纳）
 * 用复现次数当条件，分子分母是同一个计数：语料越大，命中自己就涨了，
 * 等于不需要条件也会「通过」。条件只能设在真正会失效的地方——跨房。
 *
 * @param {{postings: Map<string, Set<string>>}} index
 * @param {Iterable<string>} ids
 * @param {{exclude?: Iterable<string>}} [opts]
 * @returns {{pair: string, ids: string[]}[]} 按 pair 字典序，稳定可复现
 */
export function profileOf(index, ids, opts = {}) {
  const want = new Set(ids)
  if (want.size === 0) return []
  const exclude = new Set(opts.exclude || [])
  const out = []
  for (const [pair, set] of index.postings) {
    if (exclude.has(pair)) continue
    const hit = []
    for (const id of set) if (want.has(id)) hit.push(id)
    if (hit.length > 0) out.push({ pair, ids: hit })
  }
  out.sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0))
  return out
}

/**
 * 每间房各自独占的命题对。
 *
 * 一个 pair 如果在两间以上房间都出现，就**不属于任何一间**——
 * 它不是判据，是共性。这比「算一个区分度分数再砍阈值」更不容易漂：
 * 房间一变多，共性项自动全部出局，不需要调参。
 *
 * @param {{postings: Map<string, Set<string>>}} index
 * @param {Map<string, Set<string>>} roomSets room → sent id 集合
 * @param {{base?: string}} [opts]
 *   base = 底座房。它每条都沾，不是区分器；算「跨房」时必须把它排除，
 *   否则任何项都同时属于底座房和它的房，全部变成 shared。
 * @returns {Map<string, {own: Set<string>, shared: Set<string>, profile: {pair:string,ids:string[]}[]}>}
 */
export function roomProfiles(index, roomSets, opts = {}) {
  const base = opts.base ?? 'episode'
  /** pair → 出现在哪几间（底座房不算） */
  const where = new Map()
  const pairsOfRoom = new Map()
  for (const [room, ids] of roomSets) {
    if (room === base) continue
    const list = profileOf(index, ids)
    pairsOfRoom.set(room, list)
    for (const item of list) {
      let set = where.get(item.pair)
      if (!set) {
        set = new Set()
        where.set(item.pair, set)
      }
      set.add(room)
    }
  }
  const result = new Map()
  for (const [room, list] of pairsOfRoom) {
    const own = new Set()
    const shared = new Set()
    for (const item of list) {
      const rooms = where.get(item.pair)
      if (rooms && rooms.size > 1) shared.add(item.pair)
      else own.add(item.pair)
    }
    result.set(room, {
      own,
      shared,
      profile: list.filter((item) => own.has(item.pair)),
    })
  }
  return result
}

/**
 * 判一句的命题对落在哪间房。返回集合关系，不返回分数。
 *
 * verdict:
 *   'only'   只与一间房的 profile 重叠 → 落这间（+底座房）
 *   'multi'  与多间重叠 → 按字典序取第一间，其余记进 evidence 供解释
 *   'none'   谁都不沾 → 只落底座房（情景房），不做兜底猜测
 *
 * @param {Iterable<string>} pairs 本句的命题对
 * @param {Map<string, {own: Set<string>}>} profiles
 * @returns {{verdict: 'only'|'multi'|'none', rooms: string[], evidence: Record<string,string[]>}}
 */
export function classify(pairs, profiles) {
  const evidence = {}
  const rooms = []
  for (const pair of new Set(pairs || [])) {
    for (const [room, p] of profiles) {
      if (!p || !p.own || !p.own.has(pair)) continue
      if (!evidence[room]) {
        evidence[room] = []
        rooms.push(room)
      }
      evidence[room].push(pairLabel(pair))
    }
  }
  // 字典序：先按命中项数？不——按项数就是量化。按房间 id 字典序，稳定且可解释。
  rooms.sort()
  const verdict = rooms.length === 0 ? 'none' : rooms.length === 1 ? 'only' : 'multi'
  return { verdict, rooms, evidence }
}

/**
 * 解释一个命题对：它在哪些句子里出现过。
 * 只给事实，不做判断——判断留给调用方（或人）。
 */
export function explainPair(index, pair) {
  const set = index.postings.get(String(pair || '')) || new Set()
  return { pair, label: pairLabel(pair), df: set.size, ids: [...set] }
}
