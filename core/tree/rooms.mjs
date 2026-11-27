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
 * 路由口径（2026-11-27 实测修正）：
 *   词表路由不成立——frag 级落空 61%、summary 级落空 78–89%。
 *   改为**结构判据**：看数据里有没有那个东西（路径 / 工具调用 / 规矩 / 时间 / 情绪）。
 *   并且**情景房是底座**：每条 frag 天然是一次经历，永远落情景房；
 *   其余四房只在有结构证据时落。判据要回答的是「除底座外还多了哪几间」。
 *
 * 丘脑不是房间。它做两件事，**互不干扰**：
 *   1. 路由：这段输入投到哪几间房（结构判据优先，词表补充）
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
  Object.freeze({ id: 'episode',    brain: '海马体', name: '情景房', asks: '那次发生了什么', base: true }),
  Object.freeze({ id: 'executive',  brain: '前额叶', name: '执行房', asks: '我该做什么／不许什么' }),
  Object.freeze({ id: 'spatial',    brain: '顶叶',   name: '空间房', asks: '在哪儿／哪个文件' }),
  Object.freeze({ id: 'procedural', brain: '基底核', name: '程序房', asks: '这类事通常怎么做' }),
  Object.freeze({ id: 'salient',    brain: '杏仁核', name: '显著房', asks: '多重要／多危险' }),
])

export const ROOM_IDS = Object.freeze(ROOMS.map((r) => r.id))

/** 底座房：每条经历都落。 */
export const BASE_ROOM = 'episode'

// ── 结构判据（不靠词表；只判断「有没有那个东西」）─────────────────────────

/** 盘符路径 / 目录 / 带扩展名的文件 / URL */
const PATH_RE = /[A-Za-z]:[\\/]|(?:^|[\s(（"'`])(?:\.[/\\]|\/)[\w.-]+[/\\]|[\w-]+\.(?:mjs|js|ts|tsx|json|md|txt|png|jpg|jpeg|log|db|ps1|yml|yaml)\b|https?:\/\//i

/** 代码块 / 命令行动词 */
const CMD_RE = /```|(?:^|[\s(（])(?:node|npm|pnpm|yarn|git|pwsh|powershell|python|pip|curl|cd|ls|dir|Get-[A-Za-z]+|Select-Object|Set-[A-Za-z]+|Remove-[A-Za-z]+)\b/

/** 规矩 / 约束 / 目标 */
const RULE_RE = /(不许|必须|禁止|不能|记得要|规范|规则|要求|应该|不该|务必|一律|严禁)/

/** 时间指代（情景房的显式证据；没有也只是没有显式证据，仍在底座） */
const TIME_RE = /(昨天|前天|上次|那次|当时|后来|刚才|之前|以后|曾经|原来|记得|早上|晚上|凌晨|今天|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2})/

/** 情绪 / 显著 */
const AFFECT_RE = /(重要|要紧|慌|怕|担心|喜欢|爱|讨厌|生气|难过|开心|珍藏|禁忌|烦|累|心疼|委屈|骄傲|失望|舍不得)/

/**
 * 结构路由。情景房恒在底座，其余四房按证据。
 *
 * @param {{
 *   text?:string, role?:string, cwd?:string, pathPattern?:string,
 *   tool?:string, todo?:boolean, importance?:number, hasTime?:boolean
 * }} input
 * @returns {string[]} 房间 id，恒以 episode 开头
 */
export function routeByStructure(input = {}) {
  return [BASE_ROOM, ...Object.keys(explainRoute(input))]
}

/**
 * 每个落点的证据：为什么落这间房。
 * 这是阶段 1 的验收口径——解释不出的落点，就是判据错了。
 *
 * @returns {Record<string, string>} 房间 id -> 证据片段
 */
export function explainRoute(input = {}) {
  const text = String(input.text || '')
  const ev = {}
  const collect = (re, room, hard) => {
    const set = new Set()
    const re2 = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    for (const m of text.matchAll(re2)) { if (set.size >= 6) break; set.add(m[0]) }
    if (!set.size && hard) set.add(hard)
    if (set.size) ev[room] = [...set]
  }
  collect(PATH_RE, 'spatial', input.cwd || input.pathPattern)
  collect(CMD_RE, 'procedural', input.tool ? `tool=${input.tool}` : '')
  collect(RULE_RE, 'executive', input.todo ? 'todo' : '')
  collect(AFFECT_RE, 'salient', Number(input.importance) > 0 ? `importance=${input.importance}` : '')
  return ev
}

/** 找到 index 附近的那一句（按 。！？；换行 切）。 */
function sentenceAt(text, index, len) {
  const BOUND = /[。！？；\n]/
  let start = 0
  for (let i = index - 1; i >= 0; i -= 1) {
    if (BOUND.test(text[i])) { start = i + 1; break }
  }
  let end = text.length
  for (let i = index + len; i < text.length; i += 1) {
    if (BOUND.test(text[i])) { end = i; break }
  }
  return text.slice(start, end).trim()
}

/**
 * 每间房**证据所在的那几句**。投影应该只记证据这一面，不抄整段。
 * 自进化也只从这些句子里学。
 *
 * @returns {Record<string, string[]>} 房间 -> 证据句（去重）
 */
export function evidenceSentences(input = {}) {
  const text = String(input.text || '')
  const out = {}
  const each = (re, room) => {
    const re2 = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    for (const m of text.matchAll(re2)) {
      const s = sentenceAt(text, m.index, m[0].length)
      if (!s) continue
      const arr = out[room] || (out[room] = [])
      if (!arr.includes(s)) arr.push(s)
    }
  }
  each(PATH_RE, 'spatial')
  each(CMD_RE, 'procedural')
  each(RULE_RE, 'executive')
  each(AFFECT_RE, 'salient')
  return out
}

/**
 * 强锚：同一间房在一段文本里有**两条以上独立证据**。
 *
 * 自进化只从强锚样本里学。理由：单条证据的样本里混着大量偶然词
 * （实测：` ``` ` 这个单锚让程序房学到了一堆绘图提示词），
 * 多重证据才说明这段确实属于这间房。
 *
 * @returns {string[]} 可用于学习的房间 id
 */
export function strongRooms(input = {}) {
  const ev = explainRoute(input)
  return Object.keys(ev).filter((r) => ev[r].length >= 2)
}

/** 除底座外，这段文本有多少间房落了证据。用来观察判据的区分力。 */
export function extraRooms(rooms) {
  return rooms.filter((r) => r !== BASE_ROOM)
}

// ── 词表（补充，不是主判据）────────────────────────────────────────────

/**
 * 种子触发词：只为补充结构判据漏掉的表达，之后靠数据自己归位（见 syncTriggers）。
 * 不放人名、不放「小汐」——它们跨房，本来就该撤出。
 */
export const SEED_TRIGGERS = Object.freeze({
  episode: ['昨天', '前天', '上次', '那次', '当时', '后来', '早上', '晚上', '刚才', '原来', '发生', '记得'],
  executive: ['该', '不许', '必须', '规则', '禁止', '记得要', '待办', '目标', '不能', '要求', '规范'],
  spatial: ['文件', '目录', '路径', '放在', '位于', 'cwd', '盘', '根目录', '工程', '仓库'],
  procedural: ['步骤', '流程', '怎么做', '然后', '接着', '最后', '命令', '运行', '执行', '检查', '工具'],
  salient: ['重要', '要紧', '慌', '怕', '担心', '喜欢', '爱', '讨厌', '生气', '难过', '开心', '珍藏', '禁忌'],
})

/** 词表路由（补充用）。命中哪几间房的触发词。 */
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

/**
 * 路由总入口：结构判据为主，词表为补充，合并去重。
 * 情景房恒在（底座）。
 */
export function route(input = {}, terms = [], triggers = SEED_TRIGGERS) {
  const out = new Set(routeByStructure(input))
  for (const r of pickRooms(terms, triggers)) out.add(r)
  out.add(BASE_ROOM)
  return ROOM_IDS.filter((r) => out.has(r))
}

// ── 丘脑 ──────────────────────────────────────────────────────────────

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
 * @param {{text?:string, terms?:string[], triggers?:object, affect?:string,
 *          cwd?:string, tool?:string, todo?:boolean, importance?:number}} input
 */
export function thalamus(input = {}) {
  const rooms = route(input, input.terms || [], input.triggers || SEED_TRIGGERS)
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

// ── 触发词归位 ────────────────────────────────────────────────────────

/**
 * 触发词自动归位：只在某房出现的词进该房；多房出现的撤出。
 * 纯集合判断——信息量来自区分能力，不是出现频率。
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
