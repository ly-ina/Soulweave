/**
 * dsh 宿主：pre-step 注入处理器（允许 ctx，业务全在 core）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { appendLog, asText, clip, estimateTokens, logLine, sha256, PLUGIN_DIR } from '../../core/text.mjs'
import { MESSAGE_KIND, MEMORY_HEAD_LIMIT } from '../../core/constants.mjs'
import { normalizeConfig, readRouterLines } from '../../core/config.mjs'
import { EMPTY_SOUL, composeSoul, composeSoulStable, composeSoulState, decideReload, planSoulSplit, readSoulSources } from '../../core/soul.mjs'
import { RECALL_TEXT_MAX_CHARS, SOUL_RECALL_KIND, SOUL_STATE_KIND, SOUL_TRIGGER_KIND, pickRecallEntry, planStateEmit, renderRecall, resetRecallCooldownOnReload } from '../../core/recall-state.mjs'
import { applyBudgetPlan, countPinnedEntries, countResidentEntries, countSnapshotEntries, countSnapshots, countSoulNodes, detectPinnedAnomalies, detectSnapshotDrift, eventsOfSession, isSnapshotMessage, lastUserTexts, loadLessonHead, loadMemoryHeads, loadPendingItems, maybeLogTier, measureInjections, measureRequestBudget, planBudget, planSnapshotPrune, rememberUserTexts, snapshotMetaOf, soulTargetIndex, textOfMessage } from '../../core/budget.mjs'
import { isDreamTurn, maybeRunProbe } from '../../core/probe.mjs'
import { createSoulMessage, resolveWorkspace, zoneRowsOf } from '../../core/prompt.mjs'
import { loadTriggers, pickTriggerText, resetTriggerCooldownOnReload, selectTriggers } from '../../core/triggers.mjs'
import { createMemoryBackend, searchMemoryByContext } from '../../core/search.mjs'
import { pickLastToolCall } from '../../core/toolcall.mjs'
import { timeWindowOf } from '../../memory/when.mjs'
import { readRulesIndex } from '../../core/recall.mjs'

export function createPreStepHandler(options = {}) {
  const config = options.config ?? normalizeConfig(options)
  const now = typeof options.now === 'function' ? options.now : () => new Date()
  const timeZone = asText(options.timeZone) || 'Asia/Shanghai'
  const logger = options.logger ?? null
  const backend = createMemoryBackend(config)
  const pendingLoader = typeof options.pendingLoader === 'function'
    ? options.pendingLoader
    : () => backend.listPending(config.pendingLimit)
  let pendingCache = { at: 0, items: [] }
  // 记忆联动（2026-10-31）：rules + lesson 里 importance>=3 的最近几条，压成「我记得」一行。
  const memoryLoader = typeof options.memoryLoader === 'function'
    ? options.memoryLoader
    : () => backend.listHeads(MEMORY_HEAD_LIMIT)
  let memoryCache = { at: 0, items: [] }
  // 2026-11-04 第二阶段：state 只放 lesson 头 1 条，跟其余 loader 一样 60s 一取。
  let lessonCache = { at: 0, text: '' }
  /** 规则索引缓存（2026-11-12）：60s 内复用，避免每一步都扫目录。 */
  let rulesCache = { at: 0, lines: [], entries: [], count: 0, shown: 0, tokens: 0 }
  // 2026-11-04：本进程内哪些会话已经发过稳定段。不能用历史事件数判——
  // 老会话历史里有 200+ 条魂引，但早被挤出模型上下文。
  const stableSent = new Set()
  /**
   * 2026-11-10 触发器冷却：`Map<sessionKey, Map<triggerId, ts>>`，只在进程内，不落盘。
   * 重启后从不冷却开始——宁可多发一条，也不要因为冷启动丢掉该提醒的那一轮。
   */
  const triggerCooled = new Map()
  /** 2026-11-10：「读不到触发器文件」只告警一次（同一路径同一原因），否则每 turn 刷一行。 */
  const triggerWarned = new Set()
  /** 2026-11-11 v2：召回冷却与告警节流，形状与 trigger 一致（session → id → ts）。 */
  const recallCooled = new Map()
  const recallWarned = new Set()
  /** 2026-11-21 v0.4.2 条件触发（when_ctx）冷却，形状同 recall（session → id → ts）。 */
  const whenCooled = new Map()
  /** when 注入失败的告警节流（session + 原因）。 */
  const whenWarned = new Set()
  /** 召回检索入口：默认走记忆后端；check.mjs 用 options.recallSearcher 注入假后端。 */
  const recallSearcher = typeof options.recallSearcher === 'function'
    ? options.recallSearcher
    : (query, limit) => backend.search(query, limit)
  /** 2026-11-21 v0.4.2：when 匹配入口；默认走 searchMemoryByContext，check.mjs 用 options.whenSearcher 注入假后端。 */
  const whenSearcher = typeof options.whenSearcher === 'function'
    ? options.whenSearcher
    : (cfg, ctx, limit) => searchMemoryByContext(cfg, ctx, limit)
  // 待办 A：分区行（计数现扫，索引只定顺序），也是 60s 内复用。
  const zoneLoader = typeof options.zoneLoader === 'function' ? options.zoneLoader : () => zoneRowsOf(config)
  let zoneCache = { at: 0, rows: [] }

  const handler = async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted === true) return decision

    const at = now()
    const soulSources = readSoulSources([config.soulPath, ...config.extraSoulPaths])
    const soul = soulSources.soul
    if (!soul && logger?.warn) logger.warn(`dsh-soul: 读不到 ${config.soulPath}，本轮只注入「现在在哪 / 怎么查」`)
    // v0.1.2 P1 R4：extraSoulPaths 里某个文件缺失时不报错，写一条 soul-warn 后继续用剩下的。
    // 主文件缺失已有上面那条更长的提示，这里不重复记第二遍。
    for (const missingPath of soulSources.missing) {
      if (missingPath === config.soulPath) continue
      const warning = `dsh-soul: 魂引文件缺失，已跳过：${missingPath}`
      appendLog(config.logPath, logLine(at, 'soul-warn', warning))
      logger?.warn?.(warning)
    }

    if (at.getTime() - pendingCache.at > 60_000) {
      pendingCache = { at: at.getTime(), items: pendingLoader() }
    }
    if (at.getTime() - memoryCache.at > 60_000) {
      memoryCache = { at: at.getTime(), items: memoryLoader() }
    }
    if (at.getTime() - zoneCache.at > 60_000) {
      zoneCache = { at: at.getTime(), rows: zoneLoader() }
    }

    const session = payload?.agent?.session
    const workspace = resolveWorkspace(payload, options)

    // §5 的顺序：先让别人让步，再拿剩下多少给魂引 —— 绝不先把自己砍到 40 再回头
    // 发现封存目录整块（400tok）还占着位置。这里用「魂引最小 40tok」预估一次，
    // 得到该砍谁；砍完再按真实剩余预算渲染魂引。
    const others = (decision.messages ?? []).filter((message) => message?.source?.kind !== MESSAGE_KIND)
    const othersMeasured = measureInjections(others)
    const minSoul = Math.min(config.soulMaxTokens, 40)
    const reserve = planBudget(
      { perClass: othersMeasured.perClass, total: othersMeasured.total + minSoul },
      config.totalMaxTokens,
    )
    const kept = config.enforceBudget && reserve.cut.length > 0 ? applyBudgetPlan(others, reserve) : others
    const keptTokens = measureInjections(kept).total
    // enforceBudget=off 时不裁剪别人，所以不能拿 total 去扣——魂引按自己的上限渲染（§13.2）
    const available = config.enforceBudget
      ? Math.max(40, config.totalMaxTokens - keptTokens)
      : config.soulMaxTokens

    // 关键词路由：只有本轮最后一条 user 消息确实是群消息时，才注入「在群里」那节。
    // 判断信号来自外部（bridge 注入的 `[QQ群 xxx]` 前缀），不靠模型自知。
    const tail = (payload?.messages ?? []).slice(-2)
    const inGroup = tail.some((m) => JSON.stringify(m).includes('[QQ群'))

    // 2026-11-03：压缩后重载。压缩那一轮会把整段重述灌进 decision.messages（体量骤增），
    // 下一轮骤降。用上一轮体量对比判定「压缩后第一轮」，把三节全量渲染一次，
    // 让被 slice 截掉的条目和记忆摘要重新回到上下文里。
    // 2026-11-03 修：状态按 session 分键。原先是全局单文件，压缩代理会话会把 lastInject
    // 覆盖成自己的小值，主会话下一轮判不出「上轮很大」，reload 永远轮不到主会话。
    const reloadStateFile = join(config.stateDir, 'reload-state.json')
    let reloadState = {}
    try {
      reloadState = JSON.parse(readFileSync(reloadStateFile, 'utf8'))
    } catch {
      reloadState = {}
    }
    const sessionKey = asText(session?.id) || 'unknown'
    const currentInject = measureRequestBudget(decision.messages ?? []).total
    const { reload, previousInject, sessionStates, previousState } = decideReload(
      reloadState,
      sessionKey,
      currentInject,
    )
    sessionStates[sessionKey] = {
      lastInject: currentInject,
      at: at.toISOString(),
      lastReloadAt: reload ? at.toISOString() : previousState.lastReloadAt ?? null,
    }
    // 只保留最近 12 个会话，防止状态文件无限增长。
    const recentStates = Object.fromEntries(
      Object.entries(sessionStates)
        .filter(([, value]) => value && typeof value === 'object')
        .sort((a, b) => String(b[1].at ?? '').localeCompare(String(a[1].at ?? '')))
        .slice(0, 12),
    )
    try {
      mkdirSync(config.stateDir, { recursive: true })
      writeFileSync(reloadStateFile, JSON.stringify({ version: 2, sessions: recentStates }, null, 2), 'utf8')
    } catch {
      // 状态写不了不影响注入
    }
    if (reload) appendLog(config.logPath, logLine(at, 'reload', `压缩后重载 session=${sessionKey} previous=${previousInject}tok current=${currentInject}tok`))

    const composed = composeSoul({
      soul: soul ?? EMPTY_SOUL,
      at,
      timeZone,
      workspace,
      pending: pendingCache.items,
      pendingMode: config.pendingMode,
      router: readRouterLines(config.routerPath),
      memoryHeads: memoryCache.items,
      zones: zoneCache.rows,
      maxTokens: reload
        ? Math.max(config.soulMaxTokens, config.soulWarnTokens)
        : Math.min(config.soulMaxTokens, available),
      warnTokens: config.soulWarnTokens,
      reload,
      inGroup,
    })

    // 2026-10-28：三节超过 3 条时不再静默丢弃——一行 warn 进 soul.log（每节每轮最多一条）。
    for (const warning of composed.warnings ?? []) {
      appendLog(config.logPath, logLine(at, 'soul-warn', warning))
      logger?.warn?.(warning)
    }

    // 二期 B R2：本轮新来的长期记忆快照限流（不改历史、不改 meow-memory）。
    // 实测 `agent/pre-step` 的 decision.messages 只含本轮增量，历史快照不在里面——
    // 所以这里能做的是「让条数不再增长」，历史里已经超的只能在日志里如实报出来（见回执 H2/H3）。
    const events = eventsOfSession(session)
    // ---------------------------------------------------------------------
    // 2026-11-04 第二阶段 shadow（伊纳拍板）：只算不发。
    // 消息仍然是 legacy 整块，逐字节不变；这里只把「如果拆分会长什么样」写进日志。
    // 四个观测目标：稳定段会不会重发、压缩后会不会补、surface 节点数、pinned 有没有异常。
    // ---------------------------------------------------------------------
    if (at.getTime() - lessonCache.at > 60_000) {
      lessonCache = { at: at.getTime(), text: loadLessonHead(config.memoryDbPath) }
    }
    if (at.getTime() - rulesCache.at > 60_000) {
      rulesCache = { at: at.getTime(), ...readRulesIndex(config.rulesDir, config.rulesIndexMaxTokens) }
    }
    const shadowStable = composeSoulStable({
      soul: soul ?? EMPTY_SOUL,
      rulesIndex: rulesCache.lines,
      router: readRouterLines(config.routerPath),
      inGroup,
      maxTokens: config.soulStableMaxTokens,
    })
    const shadowState = composeSoulState({
      at,
      timeZone,
      workspace,
      pending: pendingCache.items,
      zones: zoneCache.rows,
      lessonHead: lessonCache.text,
      inGroup,
      maxTokens: config.soulStateMaxTokens,
    })
    const shadowNodes = countSoulNodes(events)
    const soulHash = soul?.sha256 ?? soulSources.soul?.sha256 ?? ''
    // 历史里已有魂引节点（nodes>0）就视为「同内容已发过」；`previousState.soulHash` 的持久化
    // 留到真发阶段做（那时才有「发完写状态」的时机）。否则 `soulHash !== ''` 每轮恒真。
    const recordedHash = asText(previousState?.soulHash)
    const lastInjectedHash = recordedHash !== '' ? recordedHash : (shadowNodes > 0 ? soulHash : '')
    // 2026-11-04 修正（真发时踩到）：判「稳定段发过没有」不能用历史**事件**数——
    // 老会话历史里有 200+ 条魂引，但早被挤出模型上下文；按事件数判成「已发过」，
    // 结果真发时稳定段被跳过，这一轮的魂引只剩【现状】，人格和禁令整段消失。
    // 改用进程内记账：本进程给这个会话发过才记；重启 Set 清空 → 首次必然补发。
    const shadowPlan = planSoulSplit({
      surfaceHasStable: stableSent.has(sessionKey),
      reload,
      soulHash,
      lastInjectedHash,
    })
    if (shadowPlan.injectStable) stableSent.add(sessionKey)
    const pinnedAnomalies = detectPinnedAnomalies(config.memoryDbPath)
    // 动态段按伊纳 2026-11-04 拍板：每 turn 只在第一个 step 发；压缩重载 / 哈希变化时强制补。
    // 「首轮缺段」和「从没记录过哈希」都不算补发原因——首轮本来 step=1，会自然发。
    const hashChanged = recordedHash !== '' && soulHash !== '' && soulHash !== recordedHash
    const statePlan = planStateEmit({
      turn: payload?.turn,
      step: payload?.step,
      lastStateTurn: previousState?.lastStateTurn,
      stableDue: reload === true || hashChanged,
    })
    const stateNodes = countSoulNodes(events, SOUL_STATE_KIND)
    // `budget=0` 是显式 kill switch（伊纳 2026-11-04 定义）：pinned 一起停是预期，不是漏装。
    const shadowLine = [
      `mode=${config.soulSplitInjection ? 'split-active' : 'split-shadow'}`,
      `stable=${shadowPlan.injectStable ? 1 : 0}`,
      `why=${shadowPlan.reason}`,
      `state=${statePlan.emit ? 1 : 0}`,
      `stateWhy=${statePlan.why}`,
      `stableTok=${shadowStable.tokens}`,
      `stateTok=${shadowState.tokens}`,
      `stateChars=${shadowState.chars}`,
      `nodes=${shadowNodes}`,
      `stateNodes=${stateNodes}`,
      `pinned=${countPinnedEntries(config.memoryDbPath)}`,
      `rules=${rulesCache.shown}/${rulesCache.count}`,
      `rulesTok=${rulesCache.tokens}`,
      `budget=${config.tierBudgetChars}`,
      `anomaly=${pinnedAnomalies.length > 0 ? pinnedAnomalies.map((item) => `${item.table}:${item.count}`).join(',') : 'none'}`,
    ].join(' ')
    // 2026-11-04 真发开关：false 时逐字节走 legacy（原样一条整块）；true 时发
    // 「稳定段（缺段/重载/哈希变）+ 动态段（每 turn 首 step）」。回滚就是改回 false。
    let messages
    if (config.soulSplitInjection) {
      messages = [...kept]
      if (shadowPlan.injectStable) messages.push(createSoulMessage(shadowStable.text))
      if (statePlan.emit) messages.push(createSoulMessage(shadowState.text, SOUL_STATE_KIND))
    } else {
      messages = [...kept, createSoulMessage(composed.text)]
    }

    /*
     * 2026-11-10 触发器注入（条件召回 v1）：只在**每 turn 第一个 step** 扫最后一条真人 user 文本，
     * 命中清单就补一条 `soul-trigger` 小消息；同一 session 同一 id 有冷却。
     * `triggerInjection=false`（默认）时整段不执行 —— legacy/split 两条路径的输出逐字节不变。
     */
    let triggerUsedTokens = 0
    if (config.triggerInjection && statePlan.emit) {
      resetTriggerCooldownOnReload(triggerCooled, sessionKey, shadowPlan)
      const loaded = loadTriggers(config.triggerPath)
      if (!loaded.ok) {
        const warnKey = `${config.triggerPath}\u0000${loaded.error}`
        if (!triggerWarned.has(warnKey)) {
          triggerWarned.add(warnKey)
          const warning = `dsh-soul: 触发器文件读不了，本轮跳过：${config.triggerPath}（${loaded.error}）`
          appendLog(config.logPath, logLine(at, 'trigger-warn', warning))
          logger?.warn?.(warning)
        }
      }
      const lastText = pickTriggerText(payload?.messages, events)
      const picked = selectTriggers(lastText, loaded.triggers, {
        maxEntries: config.triggerMaxEntries,
        budgetTokens: config.triggerBudgetTokens,
      })
      const cooldownMs = config.triggerCooldownMinutes * 60_000
      const cooled = triggerCooled.get(sessionKey) ?? new Map()
      const fired = []
      for (const item of picked) {
        const last = cooled.get(item.id) ?? 0
        if (cooldownMs > 0 && at.getTime() - last < cooldownMs) continue
        messages.push(createSoulMessage(item.text, SOUL_TRIGGER_KIND))
        cooled.set(item.id, at.getTime())
        fired.push(item)
      }
      if (fired.length > 0) {
        triggerCooled.set(sessionKey, cooled)
        triggerUsedTokens = fired.reduce((sum, item) => sum + estimateTokens(item.text), 0)
        appendLog(
          config.logPath,
          logLine(at, 'trigger', `ids=${fired.map((item) => item.id).join(',')} tokens=${triggerUsedTokens}`),
        )
      }
    }

    /*
     * 2026-11-11 v2 每轮关键记忆召回（经验层）：接在 trigger 后面，复用同一个 `statePlan.emit` 门。
     * 查询文本必须用 pickTriggerText（v1.1 那条：直接取 events 末尾会拿到压缩摘要，串味）。
     * 合并预算 conditionalBudgetTokens：先 trigger，余量给 recall；预算不够先裁 recall，不裁 state。
     * `autoRecall=false`（默认）时整段不执行 —— v1.2 的输出逐字节不变。
     */
    if (config.autoRecall && statePlan.emit) {
      resetRecallCooldownOnReload(recallCooled, sessionKey, shadowPlan)
      const query = clip(pickTriggerText(payload?.messages, events), RECALL_TEXT_MAX_CHARS)
      const room = config.conditionalBudgetTokens - triggerUsedTokens
      const budget = Math.min(config.recallBudgetTokens, room)
      if (query && budget > 0) {
        let rows = null
        let failed = ''
        try {
          rows = await Promise.resolve(recallSearcher(query, 3))
        } catch (error) {
          failed = `search-error:${error?.message ?? error}`
        }
        const entry = failed ? null : pickRecallEntry(rows)
        if (failed) {
          // 抛错：只写日志，不抛、不影响本轮对话。
        } else if (!entry) {
          const raw = Array.isArray(rows) ? rows : Array.isArray(rows?.entries) ? rows.entries : []
          failed = raw.length === 0 ? 'empty' : 'bad-rows'
        } else {
          const text = renderRecall(entry)
          const tokens = estimateTokens(text)
          const cooldownMs = config.recallCooldownMinutes * 60_000
          const cooled = recallCooled.get(sessionKey) ?? new Map()
          const last = cooled.get(entry.id) ?? 0
          if (tokens > budget) {
            // 预算不够：静默放弃（不是故障，不写 recall-warn）。
          } else if (cooldownMs > 0 && at.getTime() - last < cooldownMs) {
            // 冷却中：同 session 同 id 不重复注入（同样静默）。
          } else {
            messages.push(createSoulMessage(text, SOUL_RECALL_KIND))
            cooled.set(entry.id, at.getTime())
            recallCooled.set(sessionKey, cooled)
            appendLog(config.logPath, logLine(at, 'recall', `ids=${entry.id} tokens=${tokens}`))
          }
        }
        if (failed) {
          // 同一 session 同一原因只告警一次，别每 turn 刷一行；只写 id/原因，不记正文。
          const warnKey = `${sessionKey}\u0000${failed}`
          if (!recallWarned.has(warnKey)) {
            recallWarned.add(warnKey)
            const warning = `dsh-soul: 记忆召回失败，本轮跳过（${failed}）`
            appendLog(config.logPath, logLine(at, 'recall-warn', warning))
            logger?.warn?.(warning)
          }
        }
      }
    }
    /*
     * 2026-11-21 v0.4.2 条件触发（待办第 2 条）：看「上一次工具调用」，按 when_ctx 匹配记忆。
     * 时机限制：DSH 只有 pre-step、没有 pre-tool —— 这里注入的提示作用于**下一个**工具调用，
     * 不是拦住当前这一次。想更早，只能改宿主，不在本插件范围。
     * 硬约束：每轮最多 1 条；同 session 同 id 冷却 whenCooldownMinutes。
     * whenDryRun 默认 true：只写 when-dry 日志、不注入。先量命中率与误报，再接真发。
     */
    if (config.whenInjection && statePlan.emit) {
      if (shadowPlan?.injectStable === true) whenCooled.delete(sessionKey)
      const call = pickLastToolCall(payload?.messages, events)
      if (!call?.tool) {
        // dry-run 诊断：payload 尾部没认出工具调用时也要留痕，否则「没命中」和「没生效」分不清。
        appendLog(config.logPath, logLine(at, 'when-scan', 'no-tool-call'))
      }
      if (call?.tool) {
        const ctx = { tool: call.tool, path: call.path || '', timeWindow: timeWindowOf(at) }
        let picked = null
        let failed = ''
        let scanned = 0
        try {
          const result = whenSearcher(config, ctx, 3)
          scanned = Number(result?.scanned ?? 0)
          const cooled = whenCooled.get(sessionKey) ?? new Map()
          const nowMs = at.getTime()
          const cooldownMs = config.whenCooldownMinutes * 60_000
          picked = (result.entries ?? []).find((entry) => {
            const last = cooled.get(entry.id)
            return cooldownMs <= 0 || !last || nowMs - last >= cooldownMs
          }) ?? null
          if (picked && !config.whenDryRun) {
            cooled.set(picked.id, nowMs)
            whenCooled.set(sessionKey, cooled)
          }
        } catch (error) {
          failed = error instanceof Error ? error.message : String(error)
        }
        // 每次匹配尝试都留一行（含未命中），dry-run 全靠它看命中率与误报。
        appendLog(config.logPath, logLine(at, 'when-scan', `tool=${call.tool} path=${call.path || '-'} scanned=${scanned} hit=${picked?.id ?? '-'}${failed ? ` err=${failed}` : ''}`))
        if (picked) {
          const text = clip(String(picked.title || picked.snippet || ''), 60)
          const tokens = estimateTokens(text)
          if (config.whenDryRun) {
            appendLog(config.logPath, logLine(at, 'when-dry', `tool=${call.tool} id=${picked.id} tokens=${tokens} text=${text}`))
          } else if (tokens <= config.whenBudgetTokens) {
            messages.push(createSoulMessage(text, SOUL_TRIGGER_KIND))
            appendLog(config.logPath, logLine(at, 'when', `tool=${call.tool} id=${picked.id} tokens=${tokens}`))
          }
        } else if (failed) {
          const warnKey = `${sessionKey}\u0000${failed}`
          if (!whenWarned.has(warnKey)) {
            whenWarned.add(warnKey)
            appendLog(config.logPath, logLine(at, 'when-warn', failed))
          }
        }
      }
    }
    // 三期 C1：每轮记下最近 2 条真人 user 消息，工具没传 query 时当「本轮在做什么」。
    rememberUserTexts(lastUserTexts(events, 2))
    const historyCounts = countSnapshots(events)
    const incomingSnapshots = messages.filter((message) => isSnapshotMessage(message))
    let pruned = { keep: [], dropped: [], counts: historyCounts }
    if (incomingSnapshots.length > 0) {
      pruned = planSnapshotPrune(
        historyCounts,
        incomingSnapshots.map((message) => snapshotMetaOf(message) ?? { kind: 'unknown', ids: [] }),
      )
      if (pruned.dropped.length > 0) {
        let cursor = 0
        messages = messages.filter((message) => {
          if (!isSnapshotMessage(message)) return true
          const keep = pruned.keep[cursor] !== false
          cursor += 1
          return keep
        })
      }
    }

    let plan = planBudget(measureInjections(messages), config.totalMaxTokens)
    if (config.enforceBudget && plan.cut.length > 0) {
      messages = applyBudgetPlan(messages, plan)
      plan = planBudget(measureInjections(messages), config.totalMaxTokens)
    }

    // 自己的魂引已经 push 过一次；若宿主的旧实现残留了同 kind 消息，只留最后一条。
    const seenSoul = messages.some((message) => message?.source?.kind === MESSAGE_KIND)
    const finalMessages = seenSoul
      ? messages.filter((message, index) => {
          if (message?.source?.kind !== MESSAGE_KIND) return true
          const lastSoul = messages.map((m) => m?.source?.kind).lastIndexOf(MESSAGE_KIND)
          return index === lastSoul
        })
      : [...messages]

    // 观测（一期 A 起，二期 B 改准）：fixed 才是固定注入，total 含整轮对话。
    const observed = measureRequestBudget(finalMessages)

    // R5 周检：主探针 7 天一轮，dream 收尾那轮跑快检；只读本地库、不出网、不额外起请求。
    const dreamTurn = isDreamTurn(events)
    const probe = maybeRunProbe(config, at, dreamTurn)
    if (probe.line) appendLog(config.logPath, logLine(at, 'probe', probe.line))

    // 三期 A5：dream 收尾那轮顺手跑一次 soul_tier preview（7 天一次，只记日志、不落库）。
    const tierLine = maybeLogTier(config, at, dreamTurn)
    if (tierLine) appendLog(config.logPath, logLine(at, 'tier', tierLine))

    // 预算申报（2026-10-28 改口径）：以前报的是 soul/partition/archive/time 四类合计，每轮红字
    // `3881/800` —— 800 那个目标早作废，四类合计也不是「固定注入」，纯噪音。现在只报真东西：
    // 常驻快照 tok + 记忆注入条数，阈值是可配的 `fixedMaxTokens`（默认 2500），超了才说一句。
    const notes = []
    if (observed.snapshot > config.fixedMaxTokens) {
      const resident = backend.countResident()
      const keptCount = countSnapshotEntries(finalMessages)
      notes.push(`【预算】snapshot:${observed.snapshot} · 记忆 ${resident > 0 ? `${keptCount}/${resident}` : `${keptCount}`}`)
    }
    if (probe.alert) {
      notes.push(
        `【预算】检索探针连续 ${Number(probe.state?.badStreak ?? 0)} 期不达标（最近 ${probe.state?.lastMainPassed ?? '?'}/${probe.state?.lastMainTotal ?? '?'}）`,
      )
    }
    if (notes.length > 0) {
      const idx = soulTargetIndex(finalMessages)
      if (idx >= 0) {
        const base = textOfMessage(finalMessages[idx])
        const kind = finalMessages[idx]?.source?.kind ?? MESSAGE_KIND
        finalMessages[idx] = createSoulMessage(`${base}${notes.map((note) => `\n${note}`).join('')}`, kind)
      }
    }

    // R3 护栏：常驻快照里出现 project/topic/fact/lesson 正文 = meow-memory 变胖了。
    // 只记日志 + 当轮申报，**不改它的源码**（交办单 §3 R3）。
    const drift = detectSnapshotDrift(finalMessages.filter((message) => isSnapshotMessage(message)))
    if (drift.length > 0) {
      const idx = soulTargetIndex(finalMessages)
      if (idx >= 0) {
        const base = textOfMessage(finalMessages[idx])
        const kind = finalMessages[idx]?.source?.kind ?? MESSAGE_KIND
        finalMessages[idx] = createSoulMessage(`${base}\n【预算】常驻快照出现 ${drift.join('/')} 正文（疑似变胖）`, kind)
      }
    }

    const prunedText = pruned.dropped.length > 0
      ? `pruned=${pruned.dropped.map((item) => `${item.kind}:${item.ids.length > 0 ? item.ids.join(',') : '-'}`).join('+')}/${pruned.dropped.length}`
      : 'pruned=none'

    appendLog(
      config.logPath,
      logLine(
        at,
        'inject',
        [
          `session=${asText(session?.id) || 'unknown'}`,
          `turn=${Number(payload?.turn ?? 0)}`,
          `step=${Number(payload?.step ?? 0)}`,
          `soul=${composed.tokens}tok/${composed.stage}`,
          `before=${plan.before}tok`,
          `after=${plan.after}tok`,
          `cut=${plan.cut.length > 0 ? plan.cut.join('+') : 'none'}`,
          `over=${plan.over}tok`,
          `observed=soul:${observed.soul} snapshot:${observed.snapshot} inject:${observed.inject} conv:${observed.conversation} fixed:${observed.fixed} total:${observed.total}tok`,
          prunedText,
          `hist=${historyCounts.initial}/${historyCounts.reinjection}/${historyCounts.hit}`,
          shadowLine,
        ].join(' '),
      ),
    )

    return { ...decision, messages: finalMessages }
  }

  handler.composeSoulAt = composeSoul
  /** 压缩结束后调用：本进程的「稳定段已发」记账作废，下一轮必须重发（2026-11-04）。 */
  handler.resetStable = (sessionKey) => {
    stableSent.delete(asText(sessionKey) || 'unknown')
  }
  return handler
}

