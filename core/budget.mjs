// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/budget.mjs —— 注入分类与预算让步、请求体量统计、快照漂移、记忆库读取（零宿主依赖）。
 *
 * 2026-11-19 解耦第 5 块：从 index.js 原样搬出，逻辑未改。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from '../io.mjs'
import { openDatabase } from '../storage/index.mjs'

import { dirname, join } from '../io.mjs'
import { planForDb } from './tier.mjs'
import { asText, clip, estimateTokens, tableColumns } from './text.mjs'
import { INJECTION_CLASSES, MESSAGE_KIND, TOTAL_TOKENS, YIELD_ORDER } from './constants.mjs'
import { SOUL_STATE_KIND } from './recall-state.mjs'
import * as builtinMemory from '../memory/builtin.mjs'

// ---------------------------------------------------------------------------
// 预算：统计与让步计划（纯函数，便于 check.mjs 断言）
// ---------------------------------------------------------------------------

export function classOfKind(kind) {
  for (const def of INJECTION_CLASSES) {
    if (def.kinds.includes(kind)) return def.id
  }
  return 'other'
}

/** 统计本轮 `decision.messages` 里各来源的 token（§3.4）。 */
export function measureInjections(messages) {
  const perClass = { soul: 0, partition: 0, archive: 0, time: 0, 'soul-recall': 0, other: 0 }
  const counts = { soul: 0, partition: 0, archive: 0, time: 0, 'soul-recall': 0, other: 0 }
  for (const message of Array.isArray(messages) ? messages : []) {
    const kind = typeof message?.source?.kind === 'string' ? message.source.kind : 'other'
    const id = classOfKind(kind)
    const text = textOfMessage(message)
    perClass[id] += estimateTokens(text)
    counts[id] += 1
  }
  const total = perClass.soul + perClass.partition + perClass.archive + perClass.time + perClass['soul-recall']
  return { perClass, counts, total, all: total + perClass.other }
}

/** 长期记忆快照的正文标记（meow-memory 以 user 消息插入，kind 不是魂引的）。 */
export const SNAPSHOT_MARK = '===== 长期记忆 ====='

/** meow-memory 在会话事件里登记的 `source.kind`。 */
export const MEOW_KIND = 'plugin:meow-memory'

/**
 * 二期 B R2：同一会话内每种快照允许留几条（保留最新）。
 * 数字来自交办单，不是拍脑袋：initial 只该有一次、reinjection 只为补压缩、hit 是最近的命中片段。
 */
export const SNAPSHOT_CAPS = Object.freeze({ initial: 1, reinjection: 1, hit: 2 })

/**
 * 二期 B 实测（2026-10-28，当前会话 107 条 user/message 里 5 条是 meow 快照）：
 * 插入原因不在公开字段上，藏在 `source.sections` 的 `__meta__` 里——
 * `{name:'__meta__', text:'{"kind":"hit","ids":[...]}'}`。所以判 kind 必须解析这段 JSON。
 */
export function snapshotMetaOf(message) {
  const sections = message?.source?.sections
  if (!Array.isArray(sections)) return null
  const meta = sections.find((section) => section?.name === '__meta__')
  if (!meta || typeof meta.text !== 'string') return null
  try {
    const parsed = JSON.parse(meta.text)
    if (!parsed || typeof parsed !== 'object') return null
    return {
      kind: asText(parsed.kind) || 'unknown',
      ids: Array.isArray(parsed.ids) ? parsed.ids.map((id) => String(id)) : [],
    }
  } catch {
    return null
  }
}

/**
 * 申报（预算红字 / drift）挂哪条消息：真发时优先挂动态段——它每 turn 一条、读者能看到；
 * 老会话没有动态段时退回唯一那条魂引。legacy 模式下这个函数等价于「找 kind==='soul'」。
 */
export function soulTargetIndex(list) {
  const stateIdx = list.findIndex((m) => m?.source?.kind === SOUL_STATE_KIND)
  if (stateIdx >= 0) return stateIdx
  return list.findIndex((m) => m?.source?.kind === MESSAGE_KIND)
}

/**
 * 这一条是不是「长期记忆快照」。
 *
 * 2026-10-28 修正（一期 A 的真 bug）：只认 `source.form === 'snapshot'` 会把
 * `runtime-context` / `time-context`（它们也带 `form:'snapshot'`）算成记忆快照，observed 虚高。
 * 现在必须同时是 meow-memory 的消息，或以正文标记兜底。
 */
export function isSnapshotMessage(message) {
  if (message?.source?.kind === MESSAGE_KIND) return false
  if (message?.source?.form !== 'snapshot') return false
  if (message?.source?.kind === MEOW_KIND) return true
  return textOfMessage(message).includes(SNAPSHOT_MARK)
}

/** 没有插件来源的普通对话消息（user/assistant 且不带 source.kind）。 */
export function isConversationMessage(message) {
  const kind = message?.source?.kind
  return typeof kind !== 'string' || kind === 'user' || kind === 'assistant'
}

/**
 * 观测口径（一期 A 起，二期 B 改准）：把这一轮要发出去的消息分成四笔账。
 *
 * - `soul` 魂引自己；`snapshot` 长期记忆快照；`conversation` 普通对话；`inject` 其余注入
 * - `fixed = soul + snapshot + inject` 才是「固定注入」（二期 B 的 800 上限比这个）
 * - `total = fixed + conversation` 是整轮体积
 *
 * 与 `measureInjections` 的区别：后者只数 soul/partition/archive/time 四类并排除 other，
 * 长期记忆快照落在 other 里，于是恒量成 0（一期「空账」的根因）。
 */
export function measureRequestBudget(messages) {
  const list = Array.isArray(messages) ? messages : []
  let soul = 0
  let snapshot = 0
  let inject = 0
  let conversation = 0
  for (const message of list) {
    const tokens = estimateTokens(textOfMessage(message))
    if (message?.source?.kind === MESSAGE_KIND) soul += tokens
    else if (isSnapshotMessage(message)) snapshot += tokens
    else if (isConversationMessage(message)) conversation += tokens
    else inject += tokens
  }
  const fixed = soul + snapshot + inject
  return { soul, snapshot, inject, conversation, fixed, total: fixed + conversation }
}

/** 读会话事件（meow-memory 的 `ownEvents()` 优先，退到 `events` 数组）。 */
export function eventsOfSession(session) {
  if (typeof session?.ownEvents === 'function') {
    const events = session.ownEvents()
    if (Array.isArray(events)) return events
  }
  const events = session?.events
  return Array.isArray(events) ? events : []
}

/** 数历史里各 kind 的快照条数（只读，不碰 meow-memory）。 */
export function countSnapshots(events) {
  const counts = { initial: 0, reinjection: 0, hit: 0, unknown: 0 }
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue
    const message = event?.data?.message ?? event?.data
    if (!isSnapshotMessage(message)) continue
    const kind = snapshotMetaOf(message)?.kind ?? 'unknown'
    counts[Object.prototype.hasOwnProperty.call(counts, kind) ? kind : 'unknown'] += 1
  }
  return counts
}

/**
 * 本轮限流（R2 的可实现形态）：历史计数 + 本轮新来的快照一起算，超 `SNAPSHOT_CAPS` 的**本轮新条目**丢弃。
 *
 * 为什么不是「删历史」：实测 `agent/pre-step` 的 `decision.messages` 只含**本轮增量**（一期日志
 * `conv=5` 可证），历史快照不在里面；改历史要走 session 的 surface replace，属于另一条路线（见回执）。
 * 所以这里只能保证「不再增长」，`keep`/`dropped` 的顺序与传入一致。
 */
export function planSnapshotPrune(historyCounts, incoming) {
  const counts = { initial: 0, reinjection: 0, hit: 0, unknown: 0 }
  for (const kind of Object.keys(counts)) counts[kind] = Math.max(0, Number(historyCounts?.[kind] ?? 0) || 0)
  const keep = []
  const dropped = []
  for (const item of Array.isArray(incoming) ? incoming : []) {
    const kind = item?.kind ?? 'unknown'
    const cap = SNAPSHOT_CAPS[kind]
    const bucket = Object.prototype.hasOwnProperty.call(counts, kind) ? kind : 'unknown'
    if (cap !== undefined && counts[bucket] + 1 > cap) {
      keep.push(false)
      dropped.push({ kind, ids: item?.ids ?? [] })
      continue
    }
    counts[bucket] += 1
    keep.push(true)
  }
  return { keep, dropped, counts }
}

/** 「[项目名 : project]」这种行 = meow-memory 把项目正文塞进了常驻快照（R3 护栏）。 */
const DRIFT_PATTERN = /\[[^\]\n]{1,40}\s:\s(project|topic|fact|lesson)\]/

/**
 * R3 护栏：常驻快照里出现项目/话题/事实/经验正文就该报。
 *
 * 2026-11-04 修正（误报）：`hit` 快照是 meow-memory 每轮按关键词命中的「可能相关的记忆」，
 * 它本来就带条目正文、且每轮换内容——不是常驻段。按常驻口径报「变胖」时，soul.log 的
 * `observed snapshot` 恒为 0（预算量的是本轮 decision.messages，漂移扫的是历史快照），
 * 红字却每轮挂在魂引尾巴上，一直到那几条旧 hit 离开历史。所以 `hit` 跳过。
 * `initial` / `reinjection` 才是真正的常驻段，继续报。
 */
export function detectSnapshotDrift(snapshots) {
  const hits = new Set()
  for (const message of Array.isArray(snapshots) ? snapshots : []) {
    if (snapshotMetaOf(message)?.kind === 'hit') continue
    const match = DRIFT_PATTERN.exec(textOfMessage(message))
    if (match) hits.add(match[1])
  }
  return [...hits]
}

// ---------------------------------------------------------------------------
// 文本 / 预算计划 / 记忆库读取
// ---------------------------------------------------------------------------

export function tierStatePath(stateDir) {
  return join(stateDir, 'tier-state.json')
}

export function maybeLogTier(config, at, dreamTurn) {
  if (!dreamTurn) return ''
  const file = tierStatePath(config.stateDir)
  let last = 0
  try {
    last = Number(JSON.parse(readFileSync(file, 'utf8'))?.lastTierAt ?? 0)
  } catch {
    last = 0
  }
  if (last > 0 && (new Date(at).getTime() - last) / 86_400_000 < 7) return ''
  // 八期：预算跟 meow 同源（tok + 字两条口径都传），pin 一并传进去，日志里的 tier= 才和 preview 对得上。
  const plan = planForDb(config.memoryDbPath, {
    budgetTokens: config.tierBudgetTokens,
    budgetChars: config.tierBudgetChars,
    pins: config.tierPins,
    now: new Date(at).getTime(),
  })
  if (!plan?.ok) return `tier=error ${plan?.error ?? '未知错误'}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ lastTierAt: new Date(at).getTime() }), 'utf8')
  } catch {
    /* 记不住时间就下轮再跑，不影响预览结果 */
  }
  return `tier=名单${plan.listed.length}/超线${plan.overflow.length}/字符${plan.totalChars}`
}

export function textOfMessage(message) {
  if (typeof message === 'string') return message
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
    .join('\n')
}

/**
 * 三期 C1：「本轮在做什么」的自动来源。
 *
 * 工具的 `execute` 拿不到会话上下文，所以由 pre-step 处理器每轮把**最近 2 条 user 消息**
 * 写进这个内存槽（不落盘、不进日志、不含快照类注入消息）。工具没传 `query` 时才用它。
 */
const recentUserTexts = []

export function rememberUserTexts(texts) {
  recentUserTexts.length = 0
  for (const text of Array.isArray(texts) ? texts.slice(-2) : []) {
    const value = asText(text)
    if (value) recentUserTexts.push(value)
  }
  return recentUserTexts.slice()
}

export function recentUserQuery() {
  return recentUserTexts.join(' ')
}

/** 从会话事件里取最近 N 条**真人** user 消息（跳过长期记忆快照这类注入消息）。 */
export function lastUserTexts(events, count = 2) {
  const out = []
  const list = Array.isArray(events) ? events : []
  for (let index = list.length - 1; index >= 0 && out.length < count; index -= 1) {
    const event = list[index]
    if (event?.type !== 'user/message') continue
    const message = event?.data?.message ?? event?.data
    if (isSnapshotMessage(message)) continue
    const text = textOfMessage(message).trim()
    if (text) out.unshift(text)
  }
  return out
}

/**
 * 让步计划：只产出「该砍谁」的清单，不自己动手改别人的消息（§3.4 边界）。
 * 顺序固定 封存目录 → 分区目录；无论超多少，`soul` / `time` 都不在清单里。
 */
export function planBudget(measured, totalMaxTokens = TOTAL_TOKENS) {
  const perClass = { ...measured.perClass }
  const cut = []
  let total = measured.total
  for (const id of YIELD_ORDER) {
    if (total <= totalMaxTokens) break
    if (perClass[id] > 0) {
      total -= perClass[id]
      perClass[id] = 0
      cut.push(id)
    }
  }
  return {
    cut,
    before: measured.total,
    after: total,
    ok: total <= totalMaxTokens,
    over: Math.max(0, total - totalMaxTokens),
    perClass,
  }
}

/** 按计划剔掉对应 class 的消息；`soul` 与 `time` 永远不会被剔。 */
export function applyBudgetPlan(messages, plan) {
  const drop = new Set(
    INJECTION_CLASSES.filter((def) => plan.cut.includes(def.id)).flatMap((def) => def.kinds),
  )
  return (Array.isArray(messages) ? messages : []).filter((message) => {
    const kind = typeof message?.source?.kind === 'string' ? message.source.kind : ''
    return !drop.has(kind)
  })
}

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 「现在在哪 → 手头未结」：读记忆库 project 表的 todo（只读，短期缓存）
// ---------------------------------------------------------------------------

/**
 * 本轮快照里实际注入了几条记忆（数 `- ` 开头的条目行；「（其余 N 条…」那行不算）。
 * 只给「【预算】snapshot:N · 记忆 kept/total」这行申报用，不参与任何裁剪。
 */
export function countSnapshotEntries(messages) {
  let kept = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!isSnapshotMessage(message)) continue
    for (const line of textOfMessage(message).split(/\r?\n/)) {
      if (/^\s*-\s+\S/.test(line)) kept += 1
    }
  }
  return kept
}

/**
 * 记忆库里的「常驻口径」条数（与 meow 的 buildInjectionBody 同口径：soul 全量 + user 全量 +
 * rules 里全局 scope 且 importance>=2）。只读、失败返回 0（申报行宁可少个分母，不许报错）。
 */
export function countResidentEntries(memoryDbPath) {
  if (!memoryDbPath || !existsSync(memoryDbPath)) return 0
  let db
  try {
    db = openDatabase(memoryDbPath, { readOnly: true })
    // 第三刀：纯 builtin 库没有七层表，回退到 memories 口径。
    if (!tableColumns(db, 'soul').length && !tableColumns(db, 'rules').length) {
      return builtinMemory.countResident(memoryDbPath)
    }
    const activeCount = (table) => {
      try {
        return db.prepare(`select count(*) c from ${table} where status='active'`).get().c
      } catch {
        return 0
      }
    }
    let rules = 0
    try {
      rules = db
        .prepare("select count(*) c from rules where status='active' and importance >= 2 and (project is null or trim(project) in ('', '全局') or lower(trim(project)) = 'global')")
        .get().c
    } catch {
      rules = 0
    }
    return activeCount('soul') + activeCount('user') + rules
  } catch {
    return 0
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉不影响申报 */
    }
  }
}

export function loadPendingItems(memoryDbPath, limit = 3) {
  if (limit <= 0 || !existsSync(memoryDbPath)) return []
  let db
  try {
    db = openDatabase(memoryDbPath, { readOnly: true })
    const cols = tableColumns(db, 'project')
    // 第三刀：没有 project 表时读 todos（builtin 的未结口径）。
    if (!cols.includes('content')) return builtinMemory.listPending(memoryDbPath, limit)
    const hasSub = cols.includes('subcategory')
    const hasStatus = cols.includes('status')
    const where = [hasSub ? "subcategory = 'todo'" : "content like '%todo%'"]
    if (hasStatus) where.push("status = 'active'")
    const rows = db
      .prepare(`select content from project where ${where.join(' and ')} order by id desc limit ${limit}`)
      .all()
    return rows.map((row) => clip(String(row.content ?? ''), 40)).filter((text) => text !== '')
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉不影响主流程 */
    }
  }
}

/**
 * 记忆联动（2026-10-31）：从 memory.db 取「高重要性、仍在用」的规则与教训，
 * 压成一句话塞进魂引「我记得」。只读、失败静默——记忆库坏了不能拖垮魂引。
 * 取 rules + lesson 里 importance>=3、status=active 的条目，按 updated_at 倒序各取 limit，
 * 合并去重后按 importance 倒序取 limit 条，每条 clip 到 28 字。
 */
export function loadMemoryHeads(memoryDbPath, limit = 3) {
  if (limit <= 0 || !existsSync(memoryDbPath)) return []
  let db
  try {
    db = openDatabase(memoryDbPath, { readOnly: true })
    // 第三刀：没有七层表时读 memories 的 rules/lesson。
    if (!tableColumns(db, 'rules').length && !tableColumns(db, 'lesson').length) {
      return builtinMemory.listHeads(memoryDbPath, limit)
    }
    const rows = []
    for (const table of ['rules', 'lesson']) {
      const cols = tableColumns(db, table)
      if (!cols.includes('content')) continue
      const where = [cols.includes('lifecycle') ? "(importance >= 3 or lifecycle = 'pinned')" : 'importance >= 3']
      if (cols.includes('status')) where.push("status = 'active'")
      // D1（2026-11-04）：检索口径统一——被取代（superseded_by）、冷却中（cooldown_until）、
      // 归档（lifecycle='archived'）的条目不再进魂引。列缺失（老库/summary）就跳过，不硬写列名。
      if (cols.includes('lifecycle')) where.push("(lifecycle is null or lifecycle != 'archived')")
      if (cols.includes('superseded_by')) where.push('superseded_by is null')
      if (cols.includes('cooldown_until')) where.push(`(cooldown_until is null or cooldown_until <= ${Date.now()})`)
      const order = cols.includes('lifecycle') && cols.includes('updated_at')
        ? "case when lifecycle = 'pinned' then 0 else 1 end, updated_at desc"
        : cols.includes('updated_at') ? 'updated_at desc' : 'rowid desc'
      try {
        const lifecycleCol = cols.includes('lifecycle') ? ', lifecycle' : ''
        for (const row of db
          .prepare(`select content, importance${lifecycleCol} from ${table} where ${where.join(' and ')} order by ${order} limit ${limit}`)
          .all()) {
          rows.push({ content: String(row.content ?? ''), importance: Number(row.importance) || 0, pinned: String(row.lifecycle ?? '') === 'pinned' })
        }
      } catch {
        /* 单表读不到就跳过，不影响另一张 */
      }
    }
    const seen = new Set()
    const heads = []
    for (const row of rows.sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.importance - a.importance))) {
      const head = clip(row.content.replace(/\s+/g, ' ').trim(), 60)
      if (head === '') continue
      const key = head.slice(0, 10)
      if (seen.has(key)) continue
      seen.add(key)
      heads.push(head)
      if (heads.length >= limit) break
    }
    return heads
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉不影响主流程 */
    }
  }
}

/**
 * 2026-11-04 第二阶段口径（伊纳拍板）：state 里只放 lesson 头 1 条。
 *
 * meow 的 initial 候选是 `[...user, ...globalRules]`，**不看 lesson**；魂引这边再不放，
 * lesson 的常驻铭记就彻底没了。取法写死：active、非 archived、未被取代、不在冷却、
 * `importance` 最高，同分取 `updated_at` 最新，裁 40 字，只取正文。
 */
export function loadLessonHead(memoryDbPath) {
  if (!memoryDbPath || !existsSync(memoryDbPath)) return ''
  let db
  try {
    db = openDatabase(memoryDbPath, { readOnly: true })
    const cols = tableColumns(db, 'lesson')
    // 第三刀：没有 lesson 表时读 memories 里最高重要性的 lesson。
    if (!cols.includes('content')) return builtinMemory.lessonHead(memoryDbPath)
    const where = ['importance >= 3']
    if (cols.includes('status')) where.push("status = 'active'")
    if (cols.includes('lifecycle')) where.push("(lifecycle is null or lifecycle != 'archived')")
    if (cols.includes('superseded_by')) where.push('superseded_by is null')
    if (cols.includes('cooldown_until')) where.push(`(cooldown_until is null or cooldown_until <= ${Date.now()})`)
    const order = cols.includes('updated_at')
      ? 'importance desc, updated_at desc'
      : 'importance desc, rowid desc'
    const row = db
      .prepare(`select content from lesson where ${where.join(' and ')} order by ${order} limit 1`)
      .get()
    return row ? clip(asText(row.content), 40) : ''
  } catch {
    return ''
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉不影响主流程 */
    }
  }
}

/**
 * `lifecycle='pinned'` 目前只对 rules/user 生效（meow 的 initial 候选不看 lesson/fact/project/topic）。
 * 这几层上标了 pinned 就是**两头都不进**的静默丢失，shadow 期一律报红。
 * 返回 `[{ table, count }]`，空数组表示干净。
 */
export function detectPinnedAnomalies(memoryDbPath) {
  if (!memoryDbPath || !existsSync(memoryDbPath)) return []
  let db
  try {
    db = openDatabase(memoryDbPath, { readOnly: true })
    const found = []
    for (const table of ['lesson', 'fact', 'project', 'topic']) {
      if (!tableColumns(db, table).includes('lifecycle')) continue
      try {
        const count = db.prepare(`select count(*) c from ${table} where lifecycle = 'pinned'`).get()?.c
        if (Number(count) > 0) found.push({ table, count: Number(count) })
      } catch {
        /* 单表读不到就跳过 */
      }
    }
    return found
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉不影响主流程 */
    }
  }
}

/** meow 侧会「无条件装」的 pinned 条数（`rules` + `user` 里 `lifecycle='pinned'`）。shadow 观测用。 */
export function countPinnedEntries(memoryDbPath) {
  if (!memoryDbPath || !existsSync(memoryDbPath)) return 0
  let db
  try {
    db = openDatabase(memoryDbPath, { readOnly: true })
    let total = 0
    for (const table of ['rules', 'user']) {
      if (!tableColumns(db, table).includes('lifecycle')) continue
      try {
        total += Number(db.prepare(`select count(*) c from ${table} where lifecycle = 'pinned'`).get()?.c) || 0
      } catch {
        /* 单表读不到就跳过 */
      }
    }
    return total
  } catch {
    return 0
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉不影响主流程 */
    }
  }
}

/**
 * 数历史里某类注入消息的条数（默认 `source.kind === 'soul'`）。
 * shadow 用它分别报「稳定段节点数」和「动态段节点数」——两者 kind 不同，混在一起就看不出谁在涨。
 */
export function countSoulNodes(events, kind = MESSAGE_KIND) {
  let count = 0
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message') continue
    const message = event?.data?.message ?? event?.data
    if (message?.source?.kind === kind) count += 1
  }
  return count
}

/**
 * 反哺用：meow 库里 `corrected=1` 且仍在用的 lesson。
 * 列不一致（有的老库没 project）先探列再拼 SQL，别硬写列名。
 */
export function loadCorrectedLessons(memoryDbPath, limit = 200) {
  if (!existsSync(memoryDbPath)) return []
  let db
  try {
    db = openDatabase(memoryDbPath, { readOnly: true })
    const cols = new Set(tableColumns(db, 'lesson'))
    if (!cols.has('corrected')) return []
    const select = ['id', 'title', 'content', 'project', 'created_at']
      .map((key) => (cols.has(key) ? key : `null as ${key}`))
      .join(', ')
    return db
      .prepare(`select ${select} from lesson where corrected = 1 and status = 'active' order by created_at limit ?`)
      .all(limit)
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

