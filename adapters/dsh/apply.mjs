/**
 * dsh 宿主：工具定义、apply 入口（允许 ctx）。
 */
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { applyOverride, registerSoulweavePanel } from './panel.js'
import * as builtinMemory from '../../memory/builtin.mjs'
import { createHybridSearch } from '../../memory/hybrid.mjs'
import { buildCue, cueStats, readCueMap, runCue, scoreCue } from '../../core/cue.mjs'
import { restoreFromExport, runToolout } from '../../core/toolout.mjs'
import { buildRows, collectPluginTools, countCalls, NO_MATCH_TEXT, renderCapabilities, suggestTools, suggestToolsWithReasons, writeCapabilities } from '../../core/capabilities.mjs'
import { applyTier, CHARS_PER_TOKEN, planForDb, planTier, readInjectionRows, renderTierPlan, resolveTierBudget } from '../../core/tier.mjs'
import { applyViaSession, planSurfaceReplace, renderSurfacePlan, surfaceStatsOf, SURFACE_TOOL } from '../../core/surface.mjs'
import { searchGamedev } from '../../core/gamedev.mjs'
import { ZONE_IDS, ZONES, buildZoneIndex, readZoneIndex, renderZoneLine, scanZones, searchZones } from '../../core/zones.mjs'
import { ALIAS_TO_STANDARD, MEMORY_SECTION, ROUTER_SAFETY, SOUL_SECTION_CAP, DEFAULT_SOUL_STABLE_TOKENS, SOUL_STATE_MAX_CHARS, DEFAULT_SOUL_STATE_TOKENS, MESSAGE_KIND, SOUL_SECTIONS, SECTION_ALIASES, FEEDBACK_SECTION, FEEDBACK_ALIASES, SOUL_TOKEN_CEILING, DEFAULT_SOUL_WARN_TOKENS, HARD_SOUL_TOKENS, TOTAL_TOKENS, DEFAULT_SOUL_TOKENS, RECALL_MAX_CHARS, MEMORY_LEVELS, MEMORY_HEAD_LIMIT, INJECTION_CLASSES, YIELD_ORDER, HINTS } from '../../core/constants.mjs'
import { PLUGIN_DIR } from '../../core/text.mjs'
import { MOOD_MAX_CHARS, RELATIONS_CAP, normalizeConfig, profilePatchPaths, readMood, readRelations, readRouterLines } from '../../core/config.mjs'
import { EMPTY_SOUL, parseSoul, readSoul, readSoulSources, SOUL_STAGES, decideReload, composeSoul, composeSoulStable, composeSoulState, planSoulSplit } from '../../core/soul.mjs'
import { SOUL_STATE_KIND, SOUL_TRIGGER_KIND, SOUL_RECALL_KIND, RECALL_TEXT_MAX_CHARS, pickRecallEntry, renderRecall, resetRecallCooldownOnReload, planStateEmit } from '../../core/recall-state.mjs'
import { soulTargetIndex, classOfKind, measureInjections, SNAPSHOT_MARK, MEOW_KIND, SNAPSHOT_CAPS, snapshotMetaOf, isSnapshotMessage, isConversationMessage, measureRequestBudget, eventsOfSession, countSnapshots, planSnapshotPrune, detectSnapshotDrift, tierStatePath, maybeLogTier, textOfMessage, rememberUserTexts, recentUserQuery, lastUserTexts, planBudget, applyBudgetPlan, countSnapshotEntries, countResidentEntries, loadPendingItems, loadMemoryHeads, loadLessonHead, detectPinnedAnomalies, countPinnedEntries, countSoulNodes, loadCorrectedLessons } from '../../core/budget.mjs'
import { DREAM_MARKER, isDreamTurn, wordsOfKeywords, pickProbeWords, runProbes, readProbeState, writeProbeState, maybeRunProbe } from '../../core/probe.mjs'
import { createPreStepHandler } from './prestep.mjs'
import { CJK, appendLog, asInt, asText, clip, dsHome, estimateTokens, logLine, sha256, tableColumns } from '../../core/text.mjs'
import { createSoulMessage, resolveWorkspace, zoneRowsOf } from '../../core/prompt.mjs'
import { loadTriggers, selectTriggers, pickTriggerText, resetTriggerCooldownOnReload } from '../../core/triggers.mjs'
import { createMemoryBackend, searchMemory, searchMemoryByCue, wordsOf, hitAll, snippetAround, searchMemoryMeow, scoreOf } from '../../core/search.mjs'
import { resolveSealedModule, createArchiveSearch, walkMarkdown, readRulesIndex, searchRules, searchNotes, searchIndexSource, createRecallSources, createRecall, createPersist } from '../../core/recall.mjs'

const CAPABILITIES_TOOL = Object.freeze({
  name: 'soul_capabilities',
  description:
    '能力按需加载（二期模块 C）。不带 query：返回能力清单摘要（工具数、常驻/按需），write:true 时把清单写到 notes\\capabilities.md；带 query：按规则返回本轮可能相关的 3–5 个工具名，并在清单里标出各自调用次数。只读统计（扫插件源码 + 代理库调用次数），不装/不卸任何工具。source:"gamedev" 时不查工具清单，改查本地游戏开发技能库（78 个 SKILL.md），只返回「名字 + 一句话 + 路径」的 3–5 条，正文要自己按路径打开。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '本轮在做什么（中文短语即可）；给了就返回 3–5 个候选工具名' },
      write: { type: 'boolean', description: 'true=把清单写到 capabilities.md（默认只返回摘要）' },
      days: { type: 'number', description: '调用次数统计窗口，默认 30 天' },
      limit: { type: 'number', description: '建议里最多给几个工具，默认 5，上限 8（gamedev 上限 5）' },
      source: { type: 'string', enum: ['dsh', 'gamedev'], description: 'dsh（默认）=查本机工具清单；gamedev=查游戏开发技能库' },
    },
    additionalProperties: false,
  },
  result: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
      rows: { type: 'number' },
      file: { type: 'string' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
})

const TIER_TOOL = Object.freeze({
  name: 'soul_tier',
  description:
    '三期模块 A：常驻名单审计（只读 + preview/apply 两段，不改 meow-memory 源码）。预算与 meow 同源（默认读 profile `injectBudgetChars`，2200 字 ≈ 1538 tok；读不到才兜底 600 tok）。preview 按「沉底分」排序打印名单，并分三组：可降权（rules，需两次 apply 才退出）/ 降权无效（user、soul）/ pin 保护（跳过）。apply 必须 confirm:true，先 VACUUM INTO 备份整库并校验行数，再把超线条目降权（rules 的 importance−1，全部 keywords 追加「沉底」），输出里给可还原 SQL；本次一条注入都减不掉时会先说明「仅改数据」。永不删、永不 archived、永不改 content。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', description: 'preview（默认，只读）| apply（需 confirm:true）' },
      confirm: { type: 'boolean', description: 'apply 必须显式 true，否则拒绝' },
      budgetTokens: { type: 'number', description: '临时覆盖预算（tok）；默认跟 meow 的 injectBudgetChars 换算（2200 字 ≈ 1538 tok）' },
      limit: { type: 'number', description: '逐条列表最多打几条，默认 20' },
      dbPath: { type: 'string', description: '记忆库路径；默认用配置里的 memoryDbPath' },
    },
    additionalProperties: false,
  },
  result: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      mode: { type: 'string' },
      text: { type: 'string' },
      backup: { type: 'string' },
      changes: { type: 'number' },
      sql: { type: 'string' },
      tokens: { type: 'number' },
      noSave: { type: 'boolean' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
})

/** 三期 A：常驻名单审计（preview 只读；apply 备份后降权）。八期：预算跟 meow 同源、pin 不碰、三组分列。 */
export function createTier(options) {
  const config = options?.config ?? normalizeConfig(options ?? {})
  return function run(args = {}) {
    const mode = args?.mode === 'apply' ? 'apply' : 'preview'
    const explicitBudget = args?.budgetTokens == null ? null : Number(args.budgetTokens)
    // 显式传参优先；否则用 normalizeConfig 里解析好的「meow 同源」预算（tok + 字两条口径都带上）。
    // 八期 T4：显式 0 也是合法值（= 关闭预算 = 全量注入），不许被 asInt 的 100 下限夹成 100。
    const explicitOff = explicitBudget !== null && Number.isFinite(explicitBudget) && explicitBudget <= 0
    const explicitTok = explicitBudget === null || !Number.isFinite(explicitBudget) ? null : Math.min(8000, Math.max(100, Math.trunc(explicitBudget)))
    const budget = explicitBudget == null
      ? {
          tokens: config.tierBudgetTokens,
          chars: config.tierBudgetChars,
          source: config.tierBudgetSource,
          note: config.tierBudgetNote,
          sourcePath: config.tierBudgetPath,
        }
      : explicitOff
        ? { tokens: 0, chars: 0, source: 'off', note: '预算关闭（显式传参 0 = 不限）', sourcePath: '' }
        : {
            tokens: explicitTok,
            chars: Math.round(explicitTok * CHARS_PER_TOKEN),
            source: 'arg',
            note: `显式传参 ${explicitTok} tok`,
            sourcePath: '',
          }
    const dbPath = asText(args?.dbPath) || config.memoryDbPath
    const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 200)
    const backend = createMemoryBackend(config)
    const meowShaped = Boolean(asText(args?.dbPath)) || backend.id === 'meow'
    const plan = meowShaped
      ? planForDb(dbPath, {
          budgetTokens: budget.tokens,
          budgetChars: budget.chars,
          budgetOff: budget.source === 'off',
          pins: config.tierPins,
          budget,
        })
      : {
          ...planTier(backend.listTier(limit), {
            budgetTokens: budget.tokens,
            budgetChars: budget.chars,
            budgetOff: budget.source === 'off',
            pins: config.tierPins,
          }),
          dbPath: backend.dbPath,
          budgetSource: budget.source,
          budgetNote: budget.note,
          budgetPath: budget.sourcePath,
          pins: config.tierPins,
          backend: backend.id,
        }
    if (!plan?.ok) return { ok: false, mode, text: `【soul_tier】${plan?.error ?? '读库失败'}` }
    if (mode === 'apply') {
      // builtin 只有只读名单，降权要写 meow 的七层表——这里必须先拒绝，不许假装成功。
      if (!meowShaped) {
        return { ok: false, mode, text: '【soul_tier】apply 只支持 memoryBackend: meow（builtin 后端只读）' }
      }
      // 八期 T3：本次 apply 一条注入都减不掉时，必须先说清楚「仅改数据」，再要 confirm。
      const noSave = (plan.savings?.nowChars ?? 0) === 0
      if (args?.confirm !== true) {
        const warn = noSave
          ? '；注意：本次 apply 不减少任何注入，仅改数据（降一级后仍 ≥2，或空位被其他超线条目补上）。确实要落库请带 confirm:true'
          : ''
        return {
          ok: false,
          mode,
          text: `【soul_tier】apply 需要 confirm:true（会改 importance/keywords，先跑 preview 看过再落）${warn}`,
        }
      }
      const applied = applyTier(dbPath, plan)
      if (!applied.ok) return { ok: false, mode, text: `【soul_tier · apply 失败】${applied.error}` }
      plan.mode = 'apply'
      plan.changes = applied.changes
      plan.backup = applied.backup
      plan.sql = applied.sql
      const head = renderTierPlan(plan, { limit })
      const body = applied.sql.length > 0 ? [head, '回滚 SQL（原样执行即可还原）：', ...applied.sql] : [head]
      return {
        ok: true,
        mode,
        text: body.join('\n'),
        backup: applied.backup,
        changes: applied.changes.length,
        sql: applied.sql.join('\n'),
        tokens: plan.tokens,
        noSave,
      }
    }
    plan.mode = 'preview'
    return { ok: true, mode, text: renderTierPlan(plan, { limit }), tokens: plan.tokens }
  }
}

/** 能力清单/建议：每次算一遍太贵，按天窗口缓存 10 分钟。 */
export function createCapabilities(options) {
  const config = options?.config ?? normalizeConfig(options ?? {})
  let cache = null
  const load = (days) => {
    if (cache && cache.days === days && Date.now() - cache.at < 10 * 60 * 1000) return cache
    const pluginTools = collectPluginTools({ pluginRoots: config.pluginRoots })
    const counted = countCalls(config.biliDbPath, { days })
    const rows = buildRows({ pluginTools, counts: counted.counts })
    cache = { at: Date.now(), days, rows, counted, pluginTools }
    return cache
  }
  return function run(args = {}) {
    // 九期：gamedev 分支——只读技能库 INDEX.json，**不**扫插件源码、**不**查代理库
    // （所以放在 load() 之前：查技能不需要那两笔开销）。
    // 大写/大小写混写也认；未命中一律降级成文本，不抛错（§4）。
    if (asText(args.source).toLowerCase() === 'gamedev') {
      const asked = asText(args.query) || recentUserQuery()
      const found = searchGamedev(asked, { dir: config.gamedevSkillsDir, limit: args.limit })
      return { ok: true, text: found.text, rows: found.count, file: '' }
    }
    const days = asInt(args.days, config.capabilitiesDays, 1, 365)
    const limit = Math.min(Math.max(Number(args.limit ?? 5) || 5, 1), 8)
    const state = load(days)
    // C1：没传 query 就用 pre-step 每轮记下的「最近 2 条 user 消息」当查询词。
    const auto = !asText(args.query)
    const query = asText(args.query) || recentUserQuery()
    if (query) {
      const picked = suggestToolsWithReasons(query, { rows: state.rows, limit })
      const head = `【soul_capabilities · 建议】${auto ? `（自动取自最近 2 条 user 消息）${clip(query, 60)}` : query}`
      if (picked.length === 0) {
        // C2：没有命中就明说，不许瞎凑。
        const body = [head, NO_MATCH_TEXT, '可以先用 glob/grep 定位，再决定装什么；也可以直接给 query。']
        return { ok: true, text: body.join('\n'), rows: state.rows.length, file: '' }
      }
      const detail = picked.map((item) => {
        const row = state.rows.find((entry) => entry.tool === item.tool)
        return `${item.tool}（${row ? `${row.plugin}，${row.count} 次` : '未归属'}；${item.why}）`
      })
      const body = [head, `候选 ${picked.length} 个：${detail.join(' / ')}`]
      return { ok: true, text: body.join('\n'), rows: state.rows.length, file: '' }
    }
    const file = config.capabilitiesPath
    let written = ''
    if (args.write === true) {
      writeCapabilities(file, renderCapabilities(state.rows, { days, source: config.biliDbPath }))
      written = file
    }
    const top = state.rows.slice(0, 8).map((row) => `${row.tool}=${row.count}`).join(' ')
    const lines = [
      `【soul_capabilities · 清单】工具 ${state.rows.length} 个；常驻 ${state.rows.filter((r) => r.suggestion === '常驻').length} 个；扫描 ${state.counted.scanned ?? 0} 条 assistant 消息（最近 ${days} 天）`,
      `调用最多：${top || '（无）'}`,
      written ? `已写入 ${written}` : `未写文件（加 write:true 才写 ${file}）`,
    ]
    return { ok: true, text: lines.join('\n'), rows: state.rows.length, file: written || file }
  }
}

const CUE_TOOL = Object.freeze({
  name: 'soul_cue',
  description:
    '为记忆库生成 / 补全 cue（3–5 个触发词，规则生成、不调模型）。默认 preview 只报数与前 10 条示例、不动库；append 才写：先 VACUUM INTO 备份，再 upsert 到 cue 表。凑不满 3 个词的条目 cue 留空并在输出里点名。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', description: 'preview（默认，只看不写）| append（备份后写入）' },
      refresh: { type: 'boolean', description: 'true=连已有 cue 也重算；默认只补缺' },
      limit: { type: 'number', description: '预览里最多列几条示例，默认 10，上限 30' },
    },
    additionalProperties: false,
  },
  result: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      mode: { type: 'string' },
      text: { type: 'string' },
      stats: { type: 'object' },
      backup: { type: 'string' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
})

const TOOLOUT_TOOL = Object.freeze({
  name: 'soul_toolout',
  description:
    '工具输出归档（二期模块 B，只归档不删除）。preview 只报「将归档 N 段 / X 字符 / 预计省 Y tok」；apply 必须带 confirm:true，先整库 VACUUM INTO 备份、把原文导出到 <stateDir>\\archive\\toolout\\，再把该条消息换成一行指针；restore 按导出文件把原文塞回去。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', description: 'preview（默认）| apply（需 confirm:true）| restore' },
      confirm: { type: 'boolean', description: 'apply 必须显式 true，否则拒绝' },
      sessionId: { type: 'string', description: '目标会话；不传则取消息最多的那个' },
      recentTurns: { type: 'number', description: '最近 N 个 turn 内的工具输出不动，默认 8' },
      minChars: { type: 'number', description: '短于这个字符数不动，默认 400' },
      limit: { type: 'number', description: '预览里最多列几条，默认 10' },
      restoreFile: { type: 'string', description: 'restore 时的导出文件路径' },
    },
    additionalProperties: false,
  },
  result: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      mode: { type: 'string' },
      text: { type: 'string' },
      stats: { type: 'object' },
      backup: { type: 'string' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
})

const PERSIST_TOOL = Object.freeze({
  name: 'soul_persist',
  description:
    '把「被用户明确纠正过」的 lesson（记忆库 corrected=1 且 active）追加到 soul.md 的「反哺」节。只追加不重写，默认 preview 预览；落盘前自动备份。反哺记录不进魂引，不涨每轮预算。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', description: 'preview（默认，只看不写）| append（真写）' },
      limit: { type: 'number', description: '本次最多追加几条，默认 10，上限 20' },
    },
    additionalProperties: false,
  },
  result: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      mode: { type: 'string' },
      added: { type: 'number' },
      pending: { type: 'number' },
      text: { type: 'string' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
})

const RECALL_TOOL = Object.freeze({
  name: 'soul_recall',
  description:
    '一次查三处：记忆库 / 封存段 / 笔记，各返回至多 3 条带定位的命中（≤1200 字）。封存段复用 dsh-sealed-segments 的检索，与 archive_search 同源。带 zone/tags 时改走分区：先按区与标签过滤，再打分，返回项带 zone 与 tags。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词，空格分隔多个词（必须全部命中）；带 zone/tags 时可留空' },
      limit: { type: 'number', description: '每源最多几条，默认 3，上限 5' },
      zone: { type: 'string', description: '限定分区：work / intimacy / relations / rules / misc' },
      tags: { type: 'array', items: { type: 'string' }, description: '标签 AND 过滤，如 ["工作","工具"]；最多三个' },
      tag: { type: 'string', description: '单个标签的简写（等价于 tags:[tag]）' },
    },
    required: [],
    additionalProperties: false,
  },
  result: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
      sources: { type: 'object' },
      active: { type: 'array', items: { type: 'string' } },
      hits: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            zone: { type: 'string' },
            title: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            snippet: { type: 'string' },
          },
          required: ['zone', 'title'],
          additionalProperties: false,
        },
      },
      truncated: { type: 'boolean' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
})

// ---------------------------------------------------------------------------
// 宿主入口
// ---------------------------------------------------------------------------

/**
 * 五个工具的完整定义（导出是为了让 check.mjs 能直接验「execute 返回是否合 schema」）。
 * 2026-10-25 出过一次：preview 时把 undefined 塞进 schema 声明为 string 的 backup 键，
 * 宿主直接报 `invalid output / must be a string`。此后「缺失就整个键不写」，
 * 并用 §2 的断言把五个工具都过一遍。
 */
/** 十二期：关系层工具（只读；正文不进常驻注入、不进记忆库）。 */
const RELATIONS_TOOL = Object.freeze({
  name: 'soul_relations',
  description:
    '十二期：读「关系层」——`<stateDir>/relations/*.md` 按文件名倒序取最新一份里的全部条目（≤8 条，第一人称、否定式/阈值、带日期）。只读，不写文件、不进记忆库；魂引里只有入口，正文要自己调这个工具拿。',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: `最多返回几条（默认 ${RELATIONS_CAP}，上限 ${RELATIONS_CAP}）` },
    },
    additionalProperties: false,
  },
  result: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
      count: { type: 'number' },
      file: { type: 'string' },
      date: { type: 'string' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
})

/** 十二期：情绪 / 跨轮延续（只读 mood.md，≤600 字）。 */
const MOOD_TOOL = Object.freeze({
  name: 'soul_mood',
  description:
    '十二期：读「情绪状态」`<stateDir>/mood.md`（at / mood / carry 三个键，整文件 ≤600 字）。只读，v1 不写；没有文件就回「未记录」。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  result: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      text: { type: 'string' },
      file: { type: 'string' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
})

export function createTools(config, deps = {}) {
  const normalized = config
  const RENDER = (_args, value) => [{ type: 'text', text: String(value?.text ?? '（无输出）') }]
  const recall = createRecall(normalized)
  const persist = createPersist(normalized)

  /**
   * 十期：`soul_surface` —— 只走会话 API（`session.append`），判据是宿主自己的 `session.surface`。
   * 直接改 .zstd 的做法已被现实否掉（宿主不认），这条代码路径不再提供。
   */
  const surfaceExecute = async (args) => {
    const mode = args?.mode === 'apply' ? 'apply' : 'preview'
    const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 200)
    const getSessions = deps?.getSessions
    const sessions = typeof getSessions === 'function' ? getSessions() : null
    if (!sessions) {
      return { ok: false, mode, text: '【soul_surface】拿不到 sessions 服务（只有宿主里活着时才能查会话）' }
    }
    const sessionId = asText(args?.sessionId)
    if (!sessionId) {
      const live = (typeof sessions.list === 'function' ? sessions.list() : []) || []
      const lines = [`【soul_surface · 活着的会话 ${live.length} 个】`]
      for (const item of live) {
        const stats = surfaceStatsOf(item)
        lines.push(`  ${item.id}  surface ${stats.nodes} 节点 / 魂引 ${stats.soul} · 记忆 ${stats.memory} · 桩 ${stats.stub} / ≈${stats.tokens} tok`)
      }
      lines.push('给 sessionId 再看某个会话的详细计划（preview 只读）。')
      return { ok: true, mode, text: lines.join('\n') }
    }
    const session = typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (!session) {
      return { ok: false, mode, text: `【soul_surface】${sessionId} 不在本进程里（只有已加载/活着的会话能通过 API 动）；先让它开着，或换一个活着的 id` }
    }
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : (session.log ?? [])
    const plan = planSurfaceReplace(events)
    const statText = (stats) => `${stats.nodes} 节点 / 魂引 ${stats.soul} · 记忆 ${stats.memory} · 桩 ${stats.stub} / ≈${stats.tokens} tok`
    const head = `宿主 surface 实况：${statText(surfaceStatsOf(session))}`
    if (mode !== 'apply') {
      return { ok: plan.ok, mode, text: [head, renderSurfacePlan(plan, { limit, session: sessionId })].join('\n'), before: surfaceStatsOf(session).tokens }
    }
    const applied = applyViaSession(session, plan, { confirm: args?.confirm === true })
    if (applied.error) return { ok: false, mode, text: `【soul_surface · apply 未完成】${applied.error}` }
    const lines = [
      applied.ok ? '【soul_surface · apply 完成，宿主认了】' : '【soul_surface · apply 写完但宿主没吃】',
      `写入前 ${statText(applied.before)}`,
      `写入后 ${statText(applied.after)}`,
      `追加 ${applied.appended.length} 条 replace：${applied.appended.slice(0, 5).map((item) => `seq ${item.seq}←${item.startSeq}–${item.endSeq}`).join(' ')}${applied.appended.length > 5 ? ' …' : ''}`,
    ]
    if (applied.problems.length) lines.push(`问题：${applied.problems.join('；')}`)
    return {
      ok: applied.ok,
      mode,
      text: lines.join('\n'),
      appended: applied.appended.length,
      before: applied.before.tokens,
      after: applied.after.tokens,
    }
  }

  const recallExecute = async (args) =>
    recall({ query: args?.query, limit: args?.limit, zone: args?.zone, tags: args?.tags ?? args?.tag })
  const persistExecute = async (args) => persist({ mode: args?.mode, limit: args?.limit })

  const tooloutExecute = async (args) => {
    const mode = args?.mode === 'apply' ? 'apply' : args?.mode === 'restore' ? 'restore' : 'preview'
    if (mode === 'restore') {
      const file = asText(args?.restoreFile)
      if (!file) return { ok: false, mode, text: '【soul_toolout】restore 需要 restoreFile（导出文件路径）' }
      const restored = restoreFromExport(normalized.biliDbPath, file)
      const text = restored.ok
        ? `【soul_toolout · 回滚】seq=${restored.seq} 已指回原文（${restored.chars} 字符，hash ${restored.hash.slice(0, 8)}）`
        : `【soul_toolout · 回滚失败】${restored.error}`
      return { ok: restored.ok, mode, text: text + '\n' + logLine(new Date(), 'toolout', `restore seq=${restored.seq ?? '-'} ok=${restored.ok}`) }
    }
    if (mode === 'apply' && args?.confirm !== true) {
      return {
        ok: false,
        mode,
        text: '【soul_toolout】apply 需要 confirm:true（写库前会整库备份；不带 confirm 一律拒绝）',
      }
    }
    const result = runToolout(normalized.biliDbPath, normalized.archiveRoot, {
      mode,
      confirm: mode === 'apply',
      sessionId: asText(args?.sessionId) || undefined,
      recentTurns: asInt(args?.recentTurns, normalized.tooloutRecentTurns, 1, 100),
      minChars: asInt(args?.minChars, normalized.tooloutMinChars, 100, 20000),
      limit: Math.min(Math.max(Number(args?.limit ?? 10) || 10, 1), 50),
      log: (line) => appendLog(normalized.logPath, line),
    })
    const out = {
      ok: result.ok !== false,
      mode,
      text: `${result.text}\n${logLine(new Date(), 'toolout', `${mode} ${result.stats ? `${result.stats.segments}seg/${result.stats.tokens}tok` : 'n/a'}`)}`,
    }
    if (result.stats && typeof result.stats === 'object') out.stats = result.stats
    if (typeof result.backup === 'string' && result.backup) out.backup = result.backup
    return out
  }

  const cueExecute = async (args) => {
    const limit = Math.min(Math.max(Number(args?.limit ?? 10) || 10, 1), 30)
    // cue 表是 meow 专属结构；builtin/none 下明说，不假装跑过。
    if (createMemoryBackend(normalized).id !== 'meow') {
      return { ok: false, mode: args?.mode === 'append' ? 'append' : 'preview', text: 'soul_cue 只支持 memoryBackend: meow（cue 表结构是 meow 的）' }
    }
    const result = runCue(normalized.memoryDbPath, normalized.stateDir, {
      mode: args?.mode === 'append' ? 'append' : 'preview',
      refresh: args?.refresh === true,
      limit,
    })
    const stats = result.stats ?? null
    const text = result.ok ? `${result.text}\n${logLine(new Date(), 'cue', `${result.mode} ${stats ? `${stats.withCue}/${stats.total}` : 'n/a'}`)}` : String(result.text ?? '')
    // 结果 schema 里 stats 是 object、backup 是 string：不能塞 null/undefined（宿主会报 invalid output），
    // 缺失时直接不写这两个键。
    const cueOut = { ok: result.ok !== false, mode: result.mode ?? 'preview', text }
    if (stats && typeof stats === 'object') cueOut.stats = stats
    if (typeof result.backup === 'string' && result.backup) cueOut.backup = result.backup
    return cueOut
  }

  const capabilitiesExecute = async (args) => createCapabilities({ config: normalized })(args ?? {})
  const tierExecute = async (args) => createTier({ config: normalized })(args ?? {})

  /** 十二期：关系层（只读最新一份，≤8 条）。 */
  const relationsExecute = async (args) => {
    const cap = Math.min(Math.max(Number(args?.limit ?? RELATIONS_CAP) || RELATIONS_CAP, 1), RELATIONS_CAP)
    const found = readRelations(normalized.relationsDir)
    if (!found.ok) return { ok: false, text: `【soul_relations】${found.note}` }
    if (found.items.length === 0) {
      return { ok: true, text: `【soul_relations】${found.note}（目录 ${normalized.relationsDir}）`, count: 0, file: '', date: '' }
    }
    const items = found.items.slice(0, cap)
    const head = `【soul_relations】${items.length} 条 · 来源 ${basename(found.file)}${found.date ? `（${found.date}）` : ''}`
    const body = items.map((item, index) => `${index + 1}. ${item}`)
    return { ok: true, text: [head, ...body].join('\n'), count: items.length, file: found.file, date: found.date }
  }

  /** 十二期：情绪状态（mood.md 全文，≤600 字；只读）。 */
  const moodExecute = async () => {
    const found = readMood(normalized.moodPath)
    if (!found.ok) return { ok: false, text: `【soul_mood】${found.note}` }
    if (!found.text) return { ok: true, text: `【soul_mood】${found.note}（${normalized.moodPath}）`, file: '' }
    return { ok: true, text: `【soul_mood】${found.file}\n${found.text}`, file: found.file }
  }

  const tools = [
    {
      name: RECALL_TOOL.name,
      description: RECALL_TOOL.description,
      parameters: RECALL_TOOL.parameters,
      isConcurrencySafe: () => true,
      execute: recallExecute,
      output: { schema: RECALL_TOOL.result, render: RENDER },
    },
    {
      name: PERSIST_TOOL.name,
      description: PERSIST_TOOL.description,
      parameters: PERSIST_TOOL.parameters,
      isConcurrencySafe: () => false,
      execute: persistExecute,
      output: { schema: PERSIST_TOOL.result, render: RENDER },
    },
    {
      name: TOOLOUT_TOOL.name,
      description: TOOLOUT_TOOL.description,
      parameters: TOOLOUT_TOOL.parameters,
      isConcurrencySafe: () => false,
      execute: tooloutExecute,
      output: { schema: TOOLOUT_TOOL.result, render: RENDER },
    },
    {
      name: CUE_TOOL.name,
      description: CUE_TOOL.description,
      parameters: CUE_TOOL.parameters,
      isConcurrencySafe: () => false,
      execute: cueExecute,
      output: { schema: CUE_TOOL.result, render: RENDER },
    },
    {
      name: CAPABILITIES_TOOL.name,
      description: CAPABILITIES_TOOL.description,
      parameters: CAPABILITIES_TOOL.parameters,
      isConcurrencySafe: () => false,
      execute: capabilitiesExecute,
      output: { schema: CAPABILITIES_TOOL.result, render: RENDER },
    },
    {
      name: TIER_TOOL.name,
      description: TIER_TOOL.description,
      parameters: TIER_TOOL.parameters,
      isConcurrencySafe: () => false,
      execute: tierExecute,
      output: { schema: TIER_TOOL.result, render: RENDER },
    },
    {
      name: SURFACE_TOOL.name,
      description: SURFACE_TOOL.description,
      parameters: SURFACE_TOOL.parameters,
      isConcurrencySafe: () => false,
      execute: surfaceExecute,
      output: { schema: SURFACE_TOOL.result, render: RENDER },
    },
    {
      name: RELATIONS_TOOL.name,
      description: RELATIONS_TOOL.description,
      parameters: RELATIONS_TOOL.parameters,
      isConcurrencySafe: () => true,
      execute: relationsExecute,
      output: { schema: RELATIONS_TOOL.result, render: RENDER },
    },
    {
      name: MOOD_TOOL.name,
      description: MOOD_TOOL.description,
      parameters: MOOD_TOOL.parameters,
      isConcurrencySafe: () => true,
      execute: moodExecute,
      output: { schema: MOOD_TOOL.result, render: RENDER },
    },
  ]

  // 模块 B（soul_toolout）只服务 billion-context 的 index.db。库不存在时注册它，
  // 每次调用只会返回「库不存在」，还白占一张工具 schema；这里按库存在与否决定注册。
  if (!existsSync(normalized.biliDbPath)) {
    deps.logger?.warn?.(`dsh-soul: soul_toolout 未注册（目标库不存在：${normalized.biliDbPath}）`)
    return tools.filter((tool) => tool.name !== TOOLOUT_TOOL.name)
  }

  return tools
}

/** 宿主入口 */

/**
 * 交办单 A3（2026-11-04）：原文库增量触发。
 *
 * 宿主**没有** `agent/post-step`（`agent/turn-finished` / `session/compaction` 也不存在），
 * 「一轮结束」能用的只有 `agent/turn-stopping`（提交前、可 steer）和会话事件 `turn/end`（事后）。
 * 这里选后者：它不挡对话、监听器抛错也不影响提交，正合适做记账类后台活。
 *
 * 只做 detached spawn，不 await；60 秒内只拉一次（节流），锁与幂等由 auto-sync.mjs 自己保证。
 * 返回 `(event) => boolean`：true 表示这一轮真的拉起了同步，方便单测直接断言。
 */
export function createSoulIndexSyncTrigger(options = {}) {
  const config = options.config ?? normalizeConfig(options)
  const spawnFn = typeof options.spawnFn === 'function' ? options.spawnFn : spawn
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now()
  const logger = options.logger
  const script = config.soulIndexSyncScript
  const intervalMs = config.soulIndexSyncIntervalMs
  let lastAt = 0
  return (event) => {
    if (event?.type !== 'turn/end') return false
    if (!script || !existsSync(script)) return false
    const at = nowFn()
    if (lastAt !== 0 && at - lastAt < intervalMs) return false
    lastAt = at
    try {
      const child = spawnFn(process.execPath, [script], {
        cwd: dirname(script),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child?.unref?.()
      return true
    } catch (error) {
      logger?.warn?.(`dsh-soul: 原文库增量没拉起来：${String(error?.message ?? error)}`)
      return false
    }
  }
}

export function apply(ctx, config = {}) {  const logger = ctx.logger?.('soul') ?? console
  const baseStateDir = asText(config?.stateDir) || join(PLUGIN_DIR, '.state')
  const normalized = normalizeConfig(applyOverride(config, baseStateDir))
  const handler = createPreStepHandler({ config: normalized, timeZone: config?.timeZone, logger })
  ctx.on('agent/pre-step', handler, { prepend: true })

  const disposers = []
  /**
   * 2026-11-04：压缩会真的把稳定段从模型上下文里删掉，但本进程的 `stableSent`
   * 还记着「发过」，单靠它会让压缩后的人格/禁令整段消失。宿主有
   * `compaction/end`（无 error 才算成功），收到就清该会话的记账，下一轮补发。
   * 只在 split 开启时挂监听：legacy 每步都注入全量魂引，不依赖这个记账。
   */
  if (normalized.soulSplitInjection && typeof ctx.on === 'function') {
    try {
      const off = ctx.on('session/event', (session, event) => {
        if (event?.type !== 'compaction/end') return
        const error = event?.data?.error
        if (error !== undefined && error !== null && error !== '') return
        const sessionKey = asText(session?.id)
        if (sessionKey) handler.resetStable(sessionKey)
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      logger.warn?.(`dsh-soul: 压缩重载监听没挂上：${String(error?.message ?? error)}`)
    }
  }
  /** 十期：懒拿 `sessions` 服务（拿不到也不影响其它工具，soul_surface 自己报错）。 */
  let sessionsRef = null
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['sessions'], (scoped) => {
        sessionsRef = scoped.sessions ?? null
        return () => {
          sessionsRef = null
        }
      })
    } else if (ctx.sessions) {
      sessionsRef = ctx.sessions
    }
  } catch (error) {
    logger.warn?.(`dsh-soul: sessions 服务拿不到（soul_surface 会不可用）：${String(error?.message ?? error)}`)
  }
  if (typeof ctx.tools?.register === 'function') {
    for (const tool of createTools(normalized, { getSessions: () => sessionsRef, logger })) disposers.push(ctx.tools.register(tool))
  } else {
    logger.warn?.('dsh-soul: tools 服务不可用，soul_recall / soul_persist / soul_cue / soul_toolout / soul_capabilities / soul_surface 未注册')
  }

  /** A3：只在配了原文库时挂监听；拿不到 session/event 也不影响其它功能。 */
  if (normalized.soulIndexAutoSync && normalized.soulIndexSyncScript !== '' && typeof ctx.on === 'function') {
    try {
      const trigger = createSoulIndexSyncTrigger({ config: normalized, logger })
      const off = ctx.on('session/event', (_session, event) => {
        trigger(event)
      })
      if (typeof off === 'function') disposers.push(off)
    } catch (error) {
      logger.warn?.(`dsh-soul: 原文库增量监听没挂上：${String(error?.message ?? error)}`)
    }
  }

  disposers.push(
    registerSoulweavePanel(ctx, logger, {
      stateDir: normalized.stateDir,
      getEffective: () => normalized,
    }),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 卸载失败不影响宿主 */
      }
    }
  }
}
