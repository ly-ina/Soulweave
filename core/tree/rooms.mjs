// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/tree/rooms.mjs —— 五间房 + 丘脑（路由 / 情绪偏好）。
 *
 * 房间是脑区级功能分区，不是会话隔离。同一次经历在五间房各有落点，
 * 是不同侧面，不是五份副本。
 *
 *   情景房 海马体   发生了什么、什么时候、跟谁
 *   执行房 前额叶   目标、规矩、约束、待办
 *   空间房 顶叶     在哪、哪个文件、走哪条路
 *   程序房 基底核   这类事通常怎么做
 *   显著房 杏仁核   多重要、多危险、对我意味着什么
 *
 * 丘脑不是房间。它做两件事，**互不干扰**：
 *   1. 路由：这段输入投到哪几间房（只看触发词）
 *   2. 情绪偏好：在这几间房里，先想起哪类条目（只看条目标签）
 *
 * 为什么情绪不关房间：情绪不会让某个脑区停工。生气时海马体照样记得
 * 那次发生了什么，只是偏向委屈而不是温暖。所以情绪作用于**条目**，
 * 不作用于房间（2026-11-27 实测修正）。
 *
 * 零依赖：只做分类判断，不打分、不设阈值。
 */
import { existsSync, readFileSync } from '../../io.mjs'

/** 五间房。顺序即展示顺序。 */
export const ROOMS = Object.freeze([
  Object.freeze({ id: 'episode',    brain: '海马体', name: '情景房', asks: '那次发生了什么' }),
  Object.freeze({ id: 'executive',  brain: '前额叶', name: '执行房', asks: '我该做什么／不许什么' }),
  Object.freeze({ id: 'spatial',    brain: '顶叶',   name: '空间房', asks: '在哪儿／哪个文件' }),
  Object.freeze({ id: 'procedural', brain: '基底核', name: '程序房', asks: '这类事通常怎么做' }),
  Object.freeze({ id: 'salient',    brain: '杏仁核', name: '显著房', asks: '多重要／多危险' }),
])

export const ROOM_IDS = Object.freeze(ROOMS.map((r) => r.id))

/**
 * 种子触发词：只为把五间房点着，之后靠数据自己归位（见 syncTriggers）。
 * 不放人名、不放「小汐」——它们跨房，本来就该撤出。
 */
export const SEED_TRIGGERS = Object.freeze({
  episode: ['昨天', '前天', '上次', '那次', '当时', '后来', '早上', '晚上', '刚才', '原来', '发生', '记得'],
  executive: ['该', '不许', '必须', '规则', '禁止', '记得要', '待办', '目标', '不能', '要求', '规范'],
  spatial: ['文件', '目录', '路径', '放在', '位于', 'cwd', '盘', '根目录', '工程', '仓库'],
  procedural: ['步骤', '流程', '怎么做', '然后', '接着', '最后', '命令', '运行', '执行', '检查', '工具'],
  salient: ['重要', '要紧', '慌', '怕', '担心', '喜欢', '爱', '讨厌', '生气', '难过', '开心', '珍藏', '禁忌'],
})

/** 路由：命中哪几间房的触发词。可同时投多间房。 */
export function pickRooms(terms, triggers = SEED_TRIGGERS) {
  const hit = new Set()
  for (const room of ROOM_IDS) {
    const set = triggers[room]
    if (!set) continue
    for (const t of terms) {
      if (set.has ? set.has(t) : set.includes(t)) { hit.add(room); break }
    }
  }
  return [...hit]
}

/** 情绪类别。判不出 → 'unknown'（不设偏好）。 */
export function normalizeAffect(x) {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(AFFECT_PREFERENCE, x) ? x : 'unknown'
}

/**
 * 丘脑。路由与情绪偏好**互不影响**：
 *   rooms  —— 该投哪几间房
 *   affect —— 情绪类别
 *   prefer —— 房内先想起哪类条目（标签集合；null = 不设偏好）
 *   suppress— 房内暂时压住哪类条目
 *
 * @param {{terms:string[], triggers?:object, affect?:string}} input
 */
export function thalamus(input = {}) {
  const terms = input.terms || []
  const rooms = pickRooms(terms, input.triggers || SEED_TRIGGERS)
  const affect = normalizeAffect(input.affect)
  const pref = AFFECT_PREFERENCE[affect] || AFFECT_PREFERENCE.unknown
  return { rooms, affect, prefer: pref.prefer, suppress: pref.suppress }
}

/**
 * 情绪 → 条目偏好。
 *
 * 条目标签（落点写入时打）：
 *   routine     常规流程          task        任务
 *   warmth      温暖/亲近         bond        关系
 *   threat      威胁/风险         risk        可能出错的地方
 *   unfinished  没完成的事        grievance   委屈/被冒犯
 *   boundary    边界/规矩         offense     被冒犯
 *   rule        规则              novelty     新鲜
 *   achievement 成就              lesson      教导/劝解
 *   chatter     闲聊
 *
 * 关键一条：angry 压制 warmth —— 生气时想不起对方的好，不是忘了，是被压住了。
 */
export const AFFECT_PREFERENCE = Object.freeze({
  calm:    Object.freeze({ prefer: ['routine', 'task'],             suppress: ['threat', 'grievance'] }),
  close:   Object.freeze({ prefer: ['warmth', 'bond'],              suppress: ['grievance'] }),
  tense:   Object.freeze({ prefer: ['threat', 'risk', 'unfinished'], suppress: ['chatter'] }),
  angry:   Object.freeze({ prefer: ['boundary', 'offense', 'rule'], suppress: ['warmth'] }),
  sad:     Object.freeze({ prefer: ['warmth'],                      suppress: ['lesson'] }),
  excited: Object.freeze({ prefer: ['novelty', 'achievement'],      suppress: [] }),
  guarded: Object.freeze({ prefer: ['threat', 'boundary'],          suppress: ['warmth', 'chatter'] }),
  unknown: Object.freeze({ prefer: null, suppress: [] }),
})

/**
 * 按情绪偏好给条目排序：prefer 命中靠前，suppress 命中靠后。
 * 不打分——只分三档：偏好 / 中性 / 压住。档内保持原有顺序。
 *
 * @param {Array<{tags?:string[]}>} items
 * @param {{prefer:string[]|null, suppress:string[]}} pref
 */
export function rankByAffect(items, pref) {
  if (!pref || !pref.prefer) return items
  const prefer = new Set(pref.prefer)
  const suppress = new Set(pref.suppress || [])
  const tier = (it) => {
    const tags = it.tags || []
    if (tags.some((t) => suppress.has(t))) return 2
    if (tags.some((t) => prefer.has(t))) return 0
    return 1
  }
  return items
    .map((it, i) => ({ it, i, t: tier(it) }))
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map((x) => x.it)
}

/**
 * 触发词自动归位：只在某房出现的词进该房；多房出现的撤出。
 * 纯集合判断——信息量来自区分能力，不是出现频率。
 *
 * @param {Record<string, Set<string>>} roomTerms  房间 -> 该房落点里出现过的词
 * @param {Record<string, string[]>} [extra]       额外种子，合并进结果
 */
export function syncTriggers(roomTerms, extra = {}) {
  const all = new Map() // term -> rooms[]
  for (const room of ROOM_IDS) {
    const set = roomTerms[room] || new Set()
    for (const t of set) {
      const list = all.get(t) || []
      list.push(room)
      all.set(t, list)
    }
  }
  const out = {}
  for (const room of ROOM_IDS) out[room] = new Set(extra[room] ? extra[room] : [])
  for (const [term, rooms] of all) {
    if (rooms.length !== 1) continue // 跨房词，撤出
    out[rooms[0]].add(term)
  }
  return out
}

/** 哪些词跨房（出现在多间房）——这些不许单独开门。 */
export function crossRoomTerms(roomTerms) {
  const seen = new Map()
  for (const room of ROOM_IDS) {
    for (const t of roomTerms[room] || []) {
      seen.set(t, (seen.get(t) || 0) + 1)
    }
  }
  return new Set([...seen].filter(([, n]) => n > 1).map(([t]) => t))
}

/** 读一个可选的额外种子文件（每行一个词，`#` 开头忽略）。不存在就返回空。 */
export function loadTriggerFile(path) {
  if (!path || !existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#'))
}
