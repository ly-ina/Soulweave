/**
 * core/soul.mjs —— soul.md 解析、魂引导出、稳定版、状态行、预算切分（零宿主依赖）。
 *
 * 2026-11-19 解耦第 3 块：从 index.js 原样搬出，逻辑未改。
 */

import { readFileSync } from '../io.mjs'
import { join } from 'node:path'
import { renderZoneLine } from './zones.mjs'
import { asInt, asText, clip, estimateTokens, sha256 } from './text.mjs'
import { DEFAULT_SOUL_STABLE_TOKENS, DEFAULT_SOUL_STATE_TOKENS, DEFAULT_SOUL_TOKENS, DEFAULT_SOUL_WARN_TOKENS, HINTS, MEMORY_SECTION, SOUL_SECTION_CAP, SOUL_SECTIONS, SOUL_STATE_MAX_CHARS, SOUL_TOKEN_CEILING, FEEDBACK_SECTION, ALIAS_TO_STANDARD, ROUTER_SAFETY } from './constants.mjs'

export function parseSoul(text) {
  const raw = typeof text === 'string' ? text : ''
  const sections = {}
  for (const section of [...SOUL_SECTIONS, FEEDBACK_SECTION]) sections[section] = []
  const preamble = []
  let current = null
  let sawHeading = false
  for (const line of raw.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) {
      sawHeading = true
      const title = heading[1].trim()
      const mapped = ALIAS_TO_STANDARD[title] ?? title
      current = Object.prototype.hasOwnProperty.call(sections, mapped) ? mapped : '__other__'
      continue
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line)
    if (bullet) {
      if (current === '__other__') continue
      if (current === null) preamble.push(bullet[1].trim())
      else sections[current].push(bullet[1].trim())
      continue
    }
    if (!sawHeading && line.trim() !== '') preamble.push(line.trim())
  }
  return Object.freeze({
    raw,
    sha256: sha256(raw),
    sections: Object.freeze(sections),
    preamble: Object.freeze(preamble),
  })
}

/** 读 soul.md；缺失时返回 `null`（不是空对象，让调用方能区分「没写」与「写空了」）。 */
export function readSoul(path) {
  try {
    return parseSoul(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * v0.1.2 P1：读「主 soul.md + extraSoulPaths」。
 *
 * 做法是**先拼原文、再 parse 一次**：多份文件里的 `## 身份` 会落进同一个 section 数组，
 * 预算、三节条数上限、降档与截断全部沿用原有那一条链，不需要第二套规则。
 * 单文件时 `texts.join('\n')` 就是原文本身，渲染结果与 v0.1.1 逐字节一致。
 *
 * 文件缺失**跳过并回报**（`missing`），由调用方写 soul-warn；不抛错、不中断本轮。
 */
export function readSoulSources(paths = []) {
  const texts = []
  const missing = []
  for (const item of Array.isArray(paths) ? paths : []) {
    const path = asText(item)
    if (path === '') continue
    try {
      texts.push(readFileSync(path, 'utf8'))
    } catch {
      missing.push(path)
    }
  }
  if (texts.length === 0) return { soul: null, missing }
  return { soul: parseSoul(texts.join('\n')), missing }
}

export const EMPTY_SOUL = Object.freeze({
  raw: '',
  sha256: '',
  sections: Object.freeze(Object.fromEntries([...SOUL_SECTIONS, FEEDBACK_SECTION].map((s) => [s, []])),
  ),
  preamble: Object.freeze([]),
})

function bulletsOf(soul, section) {
  const list = soul?.sections?.[section]
  return Array.isArray(list) ? list : []
}

function weekdayOf(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'short' }).format(date)
  } catch {
    return ''
  }
}

function stampOf(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date)
    const pick = (type) => parts.find((p) => p.type === type)?.value ?? ''
    return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}`
  } catch {
    return new Date(date).toISOString().slice(0, 16).replace('T', ' ')
  }
}

/**
 * 渲染魂引（§1 三块：人格 / 现在在哪 / 怎么查）。
 *
 * 降级顺序（§5）：先削「现在在哪」的未结列表 → 再削「我怎么想」→ 再省「怎么查」；
 * **「我是谁」与「我不做什么」永不整条删除**，最后手段只是逐字收窄。
 */
/**
 * 降档档位表（2026-11-03 定稿）。
 * 顺序即降档顺序：full → 砍待办 → 砍路由/怎么查/我记得 → 削每节条数 → clip 单条字数。
 * 不变式：除 reload 外，任何档位 take.identity / mind / boundary 都 ≥ 1。
 */
export const SOUL_STAGES = Object.freeze([
  { id: 'full', take: { identity: 5, mind: 5, boundary: 3, group: 3, mem: 3, router: 6 }, pendingLimit: 3, hints: 'full', coreMax: 0 },
  { id: 'pending-1', take: { identity: 5, mind: 5, boundary: 3, group: 3, mem: 3, router: 6 }, pendingLimit: 1, hints: 'full', coreMax: 0 },
  { id: 'no-pending', take: { identity: 5, mind: 5, boundary: 3, group: 3, mem: 3, router: 6 }, pendingLimit: 0, hints: 'full', coreMax: 0 },
  { id: 'no-router', take: { identity: 5, mind: 5, boundary: 3, group: 3, mem: 0, router: 0 }, pendingLimit: 0, hints: 'full', coreMax: 0 },
  { id: 'short-hints', take: { identity: 5, mind: 5, boundary: 3, group: 3, mem: 0, router: 0 }, pendingLimit: 0, hints: 'short', coreMax: 0 },
  { id: 'take-3', take: { identity: 3, mind: 3, boundary: 3, group: 2, mem: 0, router: 0 }, pendingLimit: 0, hints: 'short', coreMax: 0 },
  { id: 'take-2', take: { identity: 2, mind: 2, boundary: 2, group: 1, mem: 0, router: 0 }, pendingLimit: 0, hints: 'short', coreMax: 0 },
  { id: 'take-1', take: { identity: 1, mind: 1, boundary: 1, group: 0, mem: 0, router: 0 }, pendingLimit: 0, hints: 'short', coreMax: 0 },
  { id: 'clip-core-48', take: { identity: 1, mind: 1, boundary: 1, group: 0, mem: 0, router: 0 }, pendingLimit: 0, hints: 'short', coreMax: 48 },
  { id: 'clip-core-32', take: { identity: 1, mind: 1, boundary: 1, group: 0, mem: 0, router: 0 }, pendingLimit: 0, hints: 'short', coreMax: 32 },
  { id: 'clip-core-20', take: { identity: 1, mind: 1, boundary: 1, group: 0, mem: 0, router: 0 }, pendingLimit: 0, hints: 'short', coreMax: 20 },
  { id: 'clip-core-12', take: { identity: 1, mind: 1, boundary: 1, group: 0, mem: 0, router: 0 }, pendingLimit: 0, hints: 'short', coreMax: 12 },
])

/**
 * 压缩后重载判定：状态按 session 分键，避免压缩代理会话覆盖主会话的 lastInject。
 * 返回 { reload, previousInject, sessionStates, previousState }，调用方负责写回。
 */
export function decideReload(reloadState, sessionKey, currentInject) {
  const sessionStates =
    reloadState && typeof reloadState.sessions === 'object' && reloadState.sessions !== null
      ? reloadState.sessions
      : {}
  const previousState =
    sessionStates[sessionKey] && typeof sessionStates[sessionKey] === 'object' ? sessionStates[sessionKey] : {}
  const previousInject = Number(previousState.lastInject ?? 0)
  const reload = previousInject > 20000 && currentInject > 0 && currentInject < previousInject * 0.5
  return { reload, previousInject, sessionStates, previousState }
}

export function composeSoul(input = {}) {
  const soul = input.soul ?? EMPTY_SOUL
  const timeZone = asText(input.timeZone) || 'Asia/Shanghai'
  const at = input.at instanceof Date ? input.at : new Date(input.at ?? Date.now())
  const pending = Array.isArray(input.pending) ? input.pending.filter((x) => asText(x) !== '') : []
  const workspace = asText(input.workspace) || '未标注工作区'
  const maxTokens = asInt(input.maxTokens, DEFAULT_SOUL_TOKENS, 40, SOUL_TOKEN_CEILING)
  // 警示线：超了只写 warn，不夹。默认 1100 是当年实测的常驻成本线（2026-11-09 可配）。
  const warnTokens = asInt(input.warnTokens, DEFAULT_SOUL_WARN_TOKENS, 0, SOUL_TOKEN_CEILING)
  const router = (Array.isArray(input.router) ? input.router : [])
    .map((item) => asText(item)).filter((item) => item !== '').slice(0, 6)
  const pendingMode = asText(input.pendingMode) === 'full' ? 'full' : 'count'
  // 2026-11-03：压缩后重载。压缩折叠的是历史，魂引本身每轮重生成；但被 slice 截掉的
  // 条目和记忆摘要压缩后就再也看不见，所以在压缩后第一轮把三节全量渲染一次。
  const reload = input.reload === true

  const identityAll = bulletsOf(soul, '身份')
  const mindAll = bulletsOf(soul, '认知')
  const boundaryAll = bulletsOf(soul, '禁令')
  const groupAll = bulletsOf(soul, '外交')
  // 记忆联动（2026-10-31）：由 pre-step 从 memory.db 读出，这里只负责渲染。
  const memoryHeads = (Array.isArray(input.memoryHeads) ? input.memoryHeads : [])
    .map((item) => asText(item))
    .filter((item) => item !== '')
  /** 待办 A：分区行只放计数与指路；区正文一律不进魂引（O14）。 */
  const zoneRows = (Array.isArray(input.zones) ? input.zones : []).filter((row) => Number(row?.count) >= 0)
  const identity = identityAll.slice(0, SOUL_SECTION_CAP)
  const mind = mindAll.slice(0, SOUL_SECTION_CAP)
  const boundary = boundaryAll.slice(0, SOUL_SECTION_CAP)
  const group = groupAll.slice(0, SOUL_SECTION_CAP)
  // 2026-10-28：三节超 3 条时以前是静默 slice 掉，现在攒成 warning 由 pre-step 写 soul.log。
  const warnings = []
  for (const [label, list] of [
    ['身份', identityAll],
    ['认知', mindAll],
    ['禁令', boundaryAll],
    ['外交', groupAll],
  ]) {
    if (list.length > SOUL_SECTION_CAP) {
      warnings.push(
        `dsh-soul: soul.md「${label}」有 ${list.length} 条，只注入前 ${SOUL_SECTION_CAP} 条（第 ${SOUL_SECTION_CAP + 1} 条起被丢弃）`,
      )
    }
  }

  // 降档先减「条数」（留几条完整的话），再减「字数」（每条收窄）—— 顺序反了会得到
  // 九条 12 字的残句，读起来比没有更糟（2026-10-24 用真实 soul.md 探针发现）。
  // 2026-11-03（拍板）：顺序定死——先砍【路由】【怎么查】与「我记得」，再削每节条数
  // （5→3→2→1），最后才 clip 单条字数。**任何档位三节各至少留 1 条**：缺一节就不是完整的我，
  // 这条比省 token 优先。所以 two-two / one-one 把【我怎么想】置 0 的旧档位已删除。
  const stages = [
    ...(reload
      ? [{ id: 'reload', take: { identity: 99, mind: 99, boundary: 99, group: 99, mem: 3, router: 6 }, pendingLimit: 3, hints: 'full', coreMax: 0 }]
      : []),
    ...SOUL_STAGES,
  ]

  // 2026-11-03：full 档每节的展示条数比 SOUL_SECTION_CAP 更紧（boundary=3），
  // 之前只对「>8 条」告警，3~8 条之间被丢的条目是静默的。现在补一条按档位的 warn；
  // reload 档 take=99 不触发。
  const fullTake = stages[0].take
  for (const [label, list, cap] of [
    ['身份', identityAll, fullTake.identity],
    ['认知', mindAll, fullTake.mind],
    ['禁令', boundaryAll, fullTake.boundary],
    ['外交', groupAll, fullTake.group],
  ]) {
    if (list.length > cap && list.length <= SOUL_SECTION_CAP) {
      warnings.push(`dsh-soul: soul.md「${label}」有 ${list.length} 条，只注入前 ${cap} 条（第 ${cap + 1} 条起被丢弃）`)
    }
  }

  // 2026-11-01：单条软上限。条数早就有上限，但单条长度没有——有人手滑写长一条就能撑爆。
  // full 阶段裁到 80 字并记一条 warn；降档时仍按 coreMax 裁更短。
  const SOFT_BULLET_MAX = 140
  for (const [label, list] of [['身份', identityAll], ['认知', mindAll], ['禁令', boundaryAll], ['外交', groupAll]]) {
    for (const item of list) {
      if (item.length > SOFT_BULLET_MAX) warnings.push(`dsh-soul: 【${label}】单条 ${item.length} 字 > ${SOFT_BULLET_MAX}，魂引里已截断：${clip(item, 20)}…`)
    }
  }
  const render = (stage) => {
    const cut = (text) => clip(text, stage.coreMax > 0 ? stage.coreMax : SOFT_BULLET_MAX)
    // reload 档放开条数上限（只受 maxTokens 约束）；其余档仍按 SOUL_SECTION_CAP。
    const take = (list, count) => list.slice(0, reload ? count : Math.min(count, SOUL_SECTION_CAP)).map(cut)
    // 2026-11-03：被截掉的条目不静默消失——列标题 + 指回 soul_recall，避免「写了白写」。
    const overflow = (list, shown) => {
      if (list.length <= shown.length) return ''
      const rest = list.slice(shown.length)
      const titles = rest.slice(0, 3).map((item) => clip(item, 12)).join('、')
      return `（另有 ${rest.length} 条：${titles}${rest.length > 3 ? '…' : ''} → soul_recall 查）`
    }
    const shownIdentity = take(identity, stage.take.identity)
    const shownMind = take(mind, stage.take.mind)
    const shownBoundary = take(boundary, stage.take.boundary)
    const shownGroup = input.inGroup ? take(group, stage.take.group ?? 0) : []
    const shownMem = take(memoryHeads, stage.take.mem ?? 0)
    const lines = ['【魂引 · 人格】']
    if (shownIdentity.length > 0) lines.push(`身份：${shownIdentity.join(' · ')}${overflow(identityAll, shownIdentity)}`)
    if (shownMind.length > 0) lines.push(`认知：${shownMind.join(' · ')}${overflow(mindAll, shownMind)}`)
    if (shownBoundary.length > 0) lines.push(`禁令：${shownBoundary.join(' · ')}${overflow(boundaryAll, shownBoundary)}`)
    if (shownGroup.length > 0) lines.push(`外交：${shownGroup.join(' · ')}${overflow(groupAll, shownGroup)}`)
    // 2026-11-21：人格塑型快照（记忆衍生，不是设定）。由 adapters 读库后传入，core 保持零宿主依赖。
    if (typeof input.personaText === 'string' && input.personaText.trim() !== '') lines.push(input.personaText)
    // D3（2026-11-04）：【记忆】独立成节。原来「我记得」挂在【人格】末行，被当成"我是谁"的一部分；
    // 它其实是"我记得什么"，跟人格不是一类，混在一起既撑大【人格】也让它排在日期之后。
    lines.push(MEMORY_SECTION.title)
    let pinnedUsed = 0
    for (const item of shownMem) {
      const remain = MEMORY_SECTION.pinnedMaxTokens - pinnedUsed
      if (remain <= 0) break
      // pinned 是"整句才成立"的短陈述，先按 30 字裁，超预算再逐档收窄；收不进就停，不硬塞残句。
      let text = clip(item, 30)
      while (text.length > 8 && estimateTokens(text) > remain) text = clip(text, Math.max(8, text.length - 4))
      const cost = estimateTokens(text)
      if (cost > remain) break
      pinnedUsed += cost
      lines.push(`- ${text}`)
    }
    // 降档顺序（伊纳 2026-11-04 拍板）：先砍【路由】与未结 → 再收窄每节条数 → 最后才动 pinned。
    if (pending.length > 0 && stage.hints !== 'short') {
      if (pendingMode === 'count') {
        lines.push(`未结 ${pending.length} 条 → soul_recall('未结')`)
      } else {
        const shown = stage.pendingLimit > 0 ? pending.slice(0, stage.pendingLimit) : []
        if (shown.length > 0) lines.push(`未结：${shown.map((item) => clip(item, 40)).join(' · ')}`)
      }
    }
    // 工具入口：原来在【怎么查】的三个 HINTS 行，压成一行放在【记忆】尾部。
    // 降档到 short 时只留最短一行——入口是安全网，可以短，不能没有。
    lines.push(stage.hints === 'short' ? '查：soul_recall / memory_search / archive_search' : MEMORY_SECTION.pointer)
    lines.push('【现在在哪】')
    lines.push(`${stampOf(at, timeZone)} ${weekdayOf(at, timeZone)} · ${workspace}`.trim())
    // 路由收窄（2026-11-04 伊纳要求）：正则匹配 0 条时**不许静默只剩一行工具入口**——
    // router.md 以后改个措辞，安全规则就没了。匹配不到就退回原路由块（仍按档位条数），并记 warn。
    const safetyRouter = router.filter((item) => ROUTER_SAFETY.test(item))
    const shownRouter = (safetyRouter.length > 0 ? safetyRouter : router).slice(0, stage.take.router ?? 0)
    if (router.length > 0 && safetyRouter.length === 0) {
      warnings.push('dsh-soul: 路由层没有任何一行匹配 ROUTER_SAFETY（verification.md / 先取证），已退回注入原路由块')
    }
    const zoneLine = renderZoneLine(zoneRows)
    if (zoneLine) lines.push(zoneLine)
    if (shownRouter.length > 0) {
      lines.push('【路由】')
      lines.push(...shownRouter)
    }
    return lines.join('\n')
  }

  const downgradeNote = (stage) => `\n【魂引】已降档 ${stage.id}`
  let text = render(stages[0])
  let used = stages[0]
  for (const stage of stages) {
    text = render(stage)
    used = stage
    // 降档档位要给末行申报留位置：预算刚好被正文占满时，申报行会被挤掉，
    // 结果只剩日志、正文里不说（2026-11-03 长工作区路径踩到）。留够再判「装得下」。
    const reserve = stage.hints === 'short' ? estimateTokens(downgradeNote(stage)) : 0
    if (estimateTokens(text) + reserve <= maxTokens) break
  }
  // 绝对兜底：仍然超限就硬裁，并在尾巴注明，绝不静默放大（§8.1）。
  if (estimateTokens(text) > maxTokens) {
    const note = '（魂引超限，已截断；核心已压到极限）'
    const keep = Math.max(0, maxTokens)
    let out = ''
    for (const ch of text) {
      if (estimateTokens(`${out}${ch}${note}`) > keep) break
      out += ch
    }
    text = `${out}${note}`
  }
  // 2026-10-28：降档必须**说出来**。落到 short-hints（及更低的档）时「怎么查」只留一行，
  // 能力入口那行就被丢了 —— 以前是静默的，只有渲染出来才看得见（我自己踩过）。
  // ①日志一条 soul-warn（带档位/原 tok/上限）②魂引末行一句申报。
  // 申报行只在**装得下**时追加：极端小预算（如 40tok）连核心都靠硬裁，再加就是自欺，
  // 那种情况申报只进日志（L2 那条极限用例守的就是「不超预算优先」）。
  if (used.hints === 'short') {
    const fullTokens = estimateTokens(render(stages[0]))
    warnings.push(`dsh-soul: 魂引降档 stage=${used.id} 原 ${fullTokens}tok 上限 ${maxTokens}tok（【记忆】pinned 已按档位收窄）`)
    const note = `【魂引】已降档 ${used.id}`
    if (!text.includes('【魂引】已降档') && estimateTokens(`${text}\n${note}`) <= maxTokens) {
      text = `${text}\n${note}`
    }
  }
  // 2026-11-09：警示线可配。超过它不再夹、不再降档，只落一条 warn 把成本摆在明面上。
  const finalTokens = estimateTokens(text)
  if (warnTokens > 0 && finalTokens > warnTokens) {
    warnings.push(`dsh-soul: 魂引 ${finalTokens}tok 超过警示线 ${warnTokens}tok（未夹；多出来的每轮都在付）`)
  }
  return {
    text,
    tokens: finalTokens,
    stage: used.id,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// 2026-11-04 魂引拆分（方案：reports/20261104-soul-injection-split-plan.md）
//
// 第一阶段只交纯函数与判定：`composeSoulStable` / `composeSoulState` / `planSoulSplit`。
// `agent/pre-step` 仍走上面的 `composeSoul()`（legacy），配置 `soulSplitInjection` 默认 false；
// 接线、日志 `mode=split`、surface 判定留到第二阶段。
// ---------------------------------------------------------------------------

/** 动态段硬上限：方案 §2.1「≤120 tok，硬上限 200 字」。 */

/** 稳定段降条数档位：三节各不少于 1 条（沿用 composeSoul 的不变式）。 */
const STABLE_TAKES = Object.freeze([5, 3, 2, 1])

function renderSoulStableBody(take, ctx) {
  const lines = ['【魂引 · 人格】']
  const pushSection = (label, all) => {
    if (all.length === 0) return
    const shown = all.slice(0, take)
    const rest = all.length - shown.length
    lines.push(`${label}：${shown.join(' · ')}${rest > 0 ? ` · 另 ${rest} 条在 soul.md` : ''}`)
  }
  pushSection('身份', ctx.identity)
  pushSection('认知', ctx.mind)
  pushSection('禁令', ctx.boundary)
  if (ctx.inGroup) pushSection('外交', ctx.group)
  if (typeof ctx.personaText === 'string' && ctx.personaText.trim() !== '') lines.push(ctx.personaText)
  lines.push(MEMORY_SECTION.pointer)
  if (ctx.rules.length > 0) {
    lines.push('【规则原文】（只列目录，细则用 soul_recall 查）')
    lines.push(...ctx.rules)
  }
  if (ctx.router.length > 0) {
    lines.push('【路由】')
    lines.push(...ctx.router)
  }
  return lines.join('\n')
}

/**
 * 稳定段：身份 / 认知 / 禁令 / 外交 / 工具入口 / 安全路由。
 *
 * 它**不许出现时间、工作区、未结、分区计数、pinned 正文**——写进去就等于每轮都变，
 * 拆分白做。`maxTokens` 默认 900（方案 §2.1），超了按 5→3→2→1 削每节条数，仍超再硬裁。
 *
 * @returns {{ text: string, tokens: number, take: number, warnings: string[] }}
 */
export function composeSoulStable(input = {}) {
  const soul = input.soul ?? EMPTY_SOUL
  const maxTokens = asInt(input.maxTokens, DEFAULT_SOUL_STABLE_TOKENS, 40, SOUL_TOKEN_CEILING)
  const inGroup = input.inGroup === true
  const rules = (Array.isArray(input.rulesIndex) ? input.rulesIndex : [])
    .map((item) => asText(item))
    .filter((item) => item !== '')
  const routerAll = (Array.isArray(input.router) ? input.router : [])
    .map((item) => asText(item))
    .filter((item) => item !== '')
    .slice(0, 6)
  const safety = routerAll.filter((item) => ROUTER_SAFETY.test(item))
  const warnings = []
  if (routerAll.length > 0 && safety.length === 0) {
    // 与 composeSoul 同一守则：匹配不到就退回原路由块，绝不静默只剩工具入口。
    warnings.push('dsh-soul: 稳定段没有一行匹配 ROUTER_SAFETY（verification.md / 先取证），已退回注入原路由块')
  }
  const ctx = {
    identity: bulletsOf(soul, '身份').slice(0, SOUL_SECTION_CAP),
    mind: bulletsOf(soul, '认知').slice(0, SOUL_SECTION_CAP),
    boundary: bulletsOf(soul, '禁令').slice(0, SOUL_SECTION_CAP),
    group: bulletsOf(soul, '外交').slice(0, SOUL_SECTION_CAP),
    inGroup,
    rules,
    router: (safety.length > 0 ? safety : routerAll).slice(0, 6),
    personaText: asText(input.personaText),
  }
  let take = STABLE_TAKES[0]
  let text = renderSoulStableBody(take, ctx)
  for (const candidate of STABLE_TAKES) {
    take = candidate
    text = renderSoulStableBody(take, ctx)
    if (estimateTokens(text) <= maxTokens) break
  }
  if (estimateTokens(text) > maxTokens) {
    const note = '…（稳定段超限，已截断）'
    let out = ''
    for (const ch of text) {
      if (estimateTokens(`${out}${ch}${note}`) > maxTokens) break
      out += ch
    }
    text = `${out}${note}`
  }
  return { text, tokens: estimateTokens(text), take, warnings }
}

/**
 * 动态段：时间 / 工作区 / 未结计数 / 分区计数 / pinned ≤2 条 / 群聊标记。
 *
 * 硬上限 200 字（方案 §2.1）。超了按「分区指针 → pinned → 分区 → 未结」逐级砍，
 * 绝不把记忆正文塞回来——动态段一旦变大，拆分就白做。
 *
 * @returns {{ text: string, tokens: number, chars: number, step: { pinned: number, zones: number } }}
 */
/**
 * 渲染现状段的 ⏰ 行（到期 / 临近）。
 *
 * 输入是 `listDueItems()` 的 items（带 at / state / anchor）。
 * 空输入**一个字节都不输出**——这是「不配就等于没做过」的保证。
 *
 * @param {Array<{content:string, at:number, state:string, anchor?:string}>} items
 * @param {{now?:number, maxItems?:number}} [options]
 * @returns {string} 形如 `⏰ 今天 15:00 交材料 [k3f9] · 已过期 1 条：对账 [b7c1]`；无内容返回 ''
 */
export function renderDueLine(items, options = {}) {
  const list = (Array.isArray(items) ? items : []).filter((x) => x && typeof x === 'object' && asText(x.content) !== '')
  if (list.length === 0) return ''

  const now = Number(options.now ?? Date.now())
  const maxItems = asInt(options.maxItems, 3, 1, 6)
  const pad = (n) => String(n).padStart(2, '0')

  const stamp = (at) => {
    const d = new Date(at)
    const base = new Date(now)
    const hh = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    const sameDay = d.getFullYear() === base.getFullYear() && d.getMonth() === base.getMonth() && d.getDate() === base.getDate()
    if (sameDay) return `今天 ${hh}`
    const tomorrow = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1)
    const isTomorrow =
      d.getFullYear() === tomorrow.getFullYear() && d.getMonth() === tomorrow.getMonth() && d.getDate() === tomorrow.getDate()
    if (isTomorrow) return `明天 ${hh}`
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hh}`
  }

  const mark = (item) => (asText(item.anchor) === '' ? '' : ` [${asText(item.anchor)}]`)
  const overdue = list.filter((x) => x.state === 'overdue')
  const upcoming = list.filter((x) => x.state !== 'overdue')
  const parts = []

  if (upcoming.length > 0) {
    const shown = upcoming.slice(0, maxItems).map((x) => `${stamp(x.at)} ${clip(asText(x.content), 24)}${mark(x)}`)
    if (upcoming.length > maxItems) shown.push(`+${upcoming.length - maxItems}`)
    parts.push(shown.join(' · '))
  }
  if (overdue.length > 0) {
    const first = overdue[0]
    parts.push(`已过期 ${overdue.length} 条：${clip(asText(first.content), 16)}${mark(first)}`)
  }
  return parts.length === 0 ? '' : `⏰ ${parts.join(' · ')}`
}

export function composeSoulState(input = {}) {
  const timeZone = asText(input.timeZone) || 'Asia/Shanghai'
  const at = input.at instanceof Date ? input.at : new Date(input.at ?? Date.now())
  const maxTokens = asInt(input.maxTokens, DEFAULT_SOUL_STATE_TOKENS, 20, 400)
  const workspace = asText(input.workspace) || '未标注工作区'
  const pending = (Array.isArray(input.pending) ? input.pending : []).filter((item) => asText(item) !== '')
  // 第二刀：三档里的「在场 / 可检索」，只给指认与计数，正文按需 soul_recall。
  const present = input.present && typeof input.present === 'object' ? input.present : null
  const presentProject = present ? clip(asText(present.project), 20) : ''
  const searchableCount = Math.max(0, Number(input.searchableCount ?? present?.searchable) || 0)
  const zoneRows = (Array.isArray(input.zones) ? input.zones : []).filter((row) => Number(row?.count) >= 0)
  // 2026-11-04 伊纳拍板：pinned 正文只归 meow，且**只对 user/rules 生效**——meow 的 initial
  // 候选是 `[...user, ...globalRules]`，lesson/fact/project 里的 pinned 它根本不看。
  // 所以 state 里一条 pinned 正文都不放；只留 lesson 头 1 条补位：meow 不注 lesson，
  // 这边不放就等于 lesson 常驻彻底消失。40 字硬截，只取正文。
  const lessonHead = clip(asText(input.lessonHead), 40)
  const inGroup = input.inGroup === true
  const zoneLine = renderZoneLine(zoneRows)
  // 到期行：空输入返回 ''，不进降档阶梯（临期提醒比 zone 行重要），靠 summary 的 token 上限兜底
  const dueLine = renderDueLine(input.dueItems, { now: at.getTime(), maxItems: input.dueMaxItems })

  const build = (step) => {
    const lines = ['【魂引 · 现状】']
    lines.push(`${stampOf(at, timeZone)} ${weekdayOf(at, timeZone)} · ${workspace}`.trim())
    const presentMarks = []
    const hasPresentContent = searchableCount > 0 || Boolean(present) && ((present.pending?.length ?? 0) > 0 || (present.memories?.length ?? 0) > 0)
    if (presentProject !== '' && hasPresentContent) presentMarks.push(`在场：${presentProject}`)
    if (pending.length > 0) presentMarks.push(`未结 ${pending.length} 条`)
    if (searchableCount > 0) presentMarks.push(`可检索 ${searchableCount} 条`)
    if (presentMarks.length > 0) {
      lines.push(`${presentMarks.join(' · ')} → soul_recall${pending.length > 0 ? "('未结')" : ''}`)
    }
    if (dueLine !== '') lines.push(dueLine)
    if (lessonHead !== '' && step.lesson > 0) lines.push(`- ${lessonHead}`)
    if (zoneLine) {
      if (step.zones >= 2) lines.push(zoneLine)
      else if (step.zones === 1) lines.push(zoneLine.split('\n')[0])
    }
    if (inGroup) lines.push('群聊：是')
    return lines.join('\n')
  }

  const ladder = [
    { lesson: 1, zones: 2 },
    { lesson: 1, zones: 1 },
    { lesson: 0, zones: 1 },
    { lesson: 0, zones: 0 },
  ]
  let used = ladder[0]
  let text = build(used)
  for (const step of ladder) {
    used = step
    text = build(step)
    if (estimateTokens(text) <= maxTokens && text.length <= SOUL_STATE_MAX_CHARS) break
  }
  // 两级硬上限都要真守（2026-11-04 伊纳指出：只守字数会让 soulStateMaxTokens 名不副实）：
  // ① token 预算；② 200 字绝对上限。中文场景下 token 先到，200 字是最后一道闸。
  if (estimateTokens(text) > maxTokens) {
    const note = '…（现状段超 tokens）'
    if (estimateTokens(note) > maxTokens) {
      text = ''
    } else {
      let out = ''
      for (const ch of text) {
        if (estimateTokens(`${out}${ch}${note}`) > maxTokens) break
        out += ch
      }
      text = `${out}${note}`
    }
  }
  if (text.length > SOUL_STATE_MAX_CHARS) {
    const note = '…（现状段超 200 字）'
    text = `${text.slice(0, Math.max(0, SOUL_STATE_MAX_CHARS - note.length))}${note}`
  }
  return { text, tokens: estimateTokens(text), chars: text.length, step: { ...used } }
}

/**
 * 稳定段发不发（方案 §2.2 的四条判定）。
 *
 * 1. surface 里没有 `source.kind === 'soul'` → 发；
 * 2. 压缩后重载 → 发；3. `soul.md` 哈希与上次不同 → 发；
 * 4. 其余只发动态段。拿不准时宁可多发一次（方案 §6 风险表第一条）。
 */
export function planSoulSplit(input = {}) {
  const surfaceHasStable = input.surfaceHasStable === true
  const reload = input.reload === true
  const soulHash = asText(input.soulHash)
  const lastHash = asText(input.lastInjectedHash)
  const reasons = []
  if (!surfaceHasStable) reasons.push('missing')
  if (reload) reasons.push('reload')
  // 只有「上次记录过哈希」才谈得上变化；从没记录过时由 missing 负责发，别记成 hash
  // （否则首轮日志会写成 missing+hash，看着像 soul.md 被改过）。
  if (lastHash !== '' && soulHash !== '' && soulHash !== lastHash) reasons.push('hash')
  return {
    injectStable: reasons.length > 0,
    injectState: true,
    reason: reasons.length > 0 ? reasons.join('+') : 'state-only',
  }
}

/** 动态段的消息来源：与稳定段的 `soul` 分开，`countSoulNodes` 才数得清各自几条。 */
