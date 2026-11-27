// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/tree/grow.mjs —— 房间判据的自进化（培养）。
 *
 * 魂汐的核心：判据不是写死的，是**长出来的**。
 *
 *   结构判据先给一个锚（这段有路径 → 它属于空间房）
 *   锚定了之后，这段里其余的词就成为该房的候选命中点
 *   一个词只在同一间房的锚定样本里反复出现 → 培养成该房触发词
 *
 * 三条防自我强化（缺一条就会塌）：
 *
 *   1. **无锚不学**：只从结构判据命中的样本里学。
 *      因为词表命中而落进来的样本不参与学习——否则「学了所以落进来，
 *      落进来所以学」，一圈就漂走。
 *   2. **跨房不学**：一个词在别间房的锚定样本里也出现过，就不是这间房的。
 *      这是「区分能力」判据的落地形式。
 *   3. **可撤销**：后来发现它跨房，就撤出。学习不是单向累积。
 *
 * 另有一条资格：**一次可能是巧合，复现才收**（同一个词在不同 frag 里出现两次以上）。
 * 这是资格判断，不是打分数。
 *
 * 零依赖：只做集合判断。
 */
import { ROOM_IDS, SEED_TRIGGERS, BASE_ROOM } from './rooms.mjs'

/** 只培养纯中文 2–4 字词。英文标识符、路径碎片、代码符号不学。 */
const CJK_WORD = /^[\u4e00-\u9fa5]{2,4}$/

/** 培养结果的形态：房间 -> Set(词)。 */
export function createGrower(seed = SEED_TRIGGERS) {
  /** term -> Set(room)，见过的房间（只统计有锚样本） */
  const roomsOf = new Map()
  /** term -> 出现过的样本数（同一 frag 内重复不计） */
  const seenIn = new Map()
  /** 撤销名单 */
  const revoked = new Set()
  /** 学习事件日志（便于回看「它为什么学了这个词」） */
  const log = []

  /**
   * 喂一段带锚的样本。
   * @param {string[]} terms 这段切出来的词
   * @param {string[]} evidenceRooms 结构判据命中的房（不含底座）
   */
  function observe(terms, evidenceRooms) {
    const ev = (evidenceRooms || []).filter((r) => ROOM_IDS.includes(r) && r !== BASE_ROOM)
    if (!ev.length) return 0 // 无锚不学
    const uniq = new Set()
    for (const t of terms) {
      if (typeof t !== 'string') continue
      if (!CJK_WORD.test(t)) continue // 只培养中文词：英文/标识符/路径碎片不学
      if (revoked.has(t)) continue
      uniq.add(t)
    }
    for (const t of uniq) {
      seenIn.set(t, (seenIn.get(t) || 0) + 1)
      let set = roomsOf.get(t)
      if (!set) { set = new Set(); roomsOf.set(t, set) }
      for (const r of ev) set.add(r)
      // 跨房即时撤销：已经在两间房出现过，就不属于任何一间
      if (set.size > 1 && !revoked.has(t)) {
        revoked.add(t)
        log.push({ term: t, action: 'revoke', rooms: [...set] })
      }
    }
    return uniq.size
  }

  /** 当前培养出来的触发词表（种子 + 学到的）。 */
  function triggers() {
    const out = {}
    for (const r of ROOM_IDS) out[r] = new Set(seed[r] || [])
    for (const [t, rooms] of roomsOf) {
      if (revoked.has(t)) continue
      if (rooms.size !== 1) continue
      if ((seenIn.get(t) || 0) < 2) continue // 复现才收
      const room = [...rooms][0]
      if ((seed[room] || []).includes(t)) continue
      out[room].add(t)
    }
    return out
  }

  /** 只报告「学到的」，不含种子——用来观察它长出了什么。 */
  function learned() {
    const out = {}
    for (const r of ROOM_IDS) out[r] = []
    for (const [t, rooms] of roomsOf) {
      if (revoked.has(t)) continue
      if (rooms.size !== 1) continue
      if ((seenIn.get(t) || 0) < 2) continue
      const room = [...rooms][0]
      if ((seed[room] || []).includes(t)) continue
      out[room].push({ term: t, seen: seenIn.get(t) })
    }
    for (const r of ROOM_IDS) out[r].sort((a, b) => b.seen - a.seen)
    return out
  }

  /** 观察但没收下的词（次数不够，或跨房被撤）。 */
  function pending() {
    const one = []
    for (const [t, rooms] of roomsOf) {
      if (revoked.has(t)) continue
      if (rooms.size === 1 && (seenIn.get(t) || 0) < 2) one.push({ term: t, room: [...rooms][0] })
    }
    return { single: one, revoked: [...revoked] }
  }

  function stats() {
    let learnedCount = 0
    for (const r of ROOM_IDS) learnedCount += learned()[r].length
    return { observed: roomsOf.size, learned: learnedCount, revoked: revoked.size, events: log.length }
  }

  return { observe, triggers, learned, pending, stats, log }
}
