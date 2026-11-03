/**
 * dsh-soul —— 「人格 / 记忆 / 能力」三层契约的最小实现（MVP）。
 *
 * 本文件只实现最初交办单 §12 的 MVP 范围：
 *   1. `soul` 人格层只读注入（魂引，默认 200 tok 起步，硬上限 400）
 *   2. `soul_recall` 三源检索（记忆库 / 封存段 / 笔记），输出 ≤1200 字
 *   3. `budget` 统计与让步（先砍封存目录 → 再砍分区目录，魂引核心永不砍）
 *
 * 非目标（第二/三期）：`cue` 表、面板与路由。`soul_persist` 已实现（§7，只追加第四节）。
 * 能力边界（§3.4）：本模块只能约束自己并报告总量；「砍封存目录 / 分区目录」
 * 只针对 **目录型注入**（archive-index / context-index），不动时间行、不动记忆命中。
 *
 * @module dsh-soul
 */
import { DatabaseSync } from 'node:sqlite'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as builtinMemory from './memory-builtin.mjs'

import { buildCue, cueStats, readCueMap, runCue, scoreCue } from './cue.mjs'
import { restoreFromExport, runToolout } from './toolout.mjs'
import { buildRows, collectPluginTools, countCalls, NO_MATCH_TEXT, renderCapabilities, suggestTools, suggestToolsWithReasons, writeCapabilities } from './capabilities.mjs'
import { applyTier, CHARS_PER_TOKEN, planForDb, planTier, readInjectionRows, renderTierPlan, resolveTierBudget } from './tier.mjs'
import { applyViaSession, planSurfaceReplace, renderSurfacePlan, surfaceStatsOf, SURFACE_TOOL } from './surface.mjs'
import { searchGamedev } from './gamedev.mjs'
import { ZONE_IDS, ZONES, buildZoneIndex, readZoneIndex, renderZoneLine, scanZones, searchZones } from './zones.mjs'

export const name = 'soulweave'

/** §9.4：需要动 `ctx.tools` 就必须经 inject 声明。 */
export const inject = ['tools']

/** 注入消息的 `source.kind`，同时用于去重与预算归类（§3.4）。 */
export const MESSAGE_KIND = 'soul'

/** soul.md 里插件只读的三节（§3.1）。 */
export const SOUL_SECTIONS = Object.freeze(['我是谁', '我怎么想', '我不做什么', '在群里'])

/** 唯一允许追加的一节；模板内容禁止写入（§9.10）。 */
export const FEEDBACK_SECTION = '反哺记录'

/** 魂引硬上限（§5）。 */
export const HARD_SOUL_TOKENS = 1100

/**
 * 四类注入合计的上限（§5）。
 *
 * 2026-10-25 由 600 改成 700：600 当初是拍的，实测常驻注入（时间行 + 分区目录 +
 * 封存目录 + 魂引）稳定在 670 上下，申报行会永久显示「超限」，久了就是噪音。
 * 改的是「拍脑袋的数」回到「实测的数」，不是放宽标准；魂引自己的 400 / 200 一分没动。
 * 2026-11-02 由 700 改成 800：单条上限 80→140、记忆摘要 28→60 之后 full 档 736tok，
 * 700 会永久降档到 short-hints（丢一条路由 + 怎么查只剩一行），实测后补足余量。
 */
export const TOTAL_TOKENS = 950

/** MVP 起步值：先生 200，跑出体感再往上调（§12）。 */
/**
 * 魂引默认预算（2026-10-28 由 200 调到 220）。
 *
 * 原因：【怎么查】按伊纳要求加了「能力：soul_capabilities(query)」一行（≈20 tok，不是 12），
 * 真实 soul.md 渲染从 183 → 203 tok；200 的上限会让渲染器降档到 `short-hints`，
 * 那一档只有一行提示，**新加的能力行会被静默丢掉**。220 留出余量，档位回到 `full`。
 */
export const DEFAULT_SOUL_TOKENS = 220

/** `soul_recall` 单次输出上限（§5）。 */
export const RECALL_MAX_CHARS = 1200

/** 记忆库分层表顺序（与 meow-memory 的建表一致）。 */
export const MEMORY_LEVELS = Object.freeze(['soul', 'rules', 'user', 'project', 'fact', 'topic', 'lesson'])
/** 记忆联动：魂引「我记得」最多几条（2026-10-31）。 */
export const MEMORY_HEAD_LIMIT = 2

/** 四类注入的归类表（§3.4）。顺序即优先级，只用于展示。 */
export const INJECTION_CLASSES = Object.freeze([
  Object.freeze({ id: 'soul', label: '魂引', kinds: Object.freeze([MESSAGE_KIND]) }),
  Object.freeze({ id: 'partition', label: '分区目录', kinds: Object.freeze(['context-index']) }),
  Object.freeze({ id: 'archive', label: '封存目录', kinds: Object.freeze(['archive-index', 'archive-seal-hint']) }),
  Object.freeze({ id: 'time', label: '时间行', kinds: Object.freeze(['time-context', 'realtime-clock']) }),
])

/** 让步顺序（§5）：先砍封存目录，再砍分区目录；魂引核心与时间行永不砍。 */
export const YIELD_ORDER = Object.freeze(['archive', 'partition'])

/** 「怎么查」三条入口（§1）。固定文案，不随轮次变化。 */
export const HINTS = Object.freeze([
  // 压成一行：省约 25 tok/轮；三个工具名仍然齐全，够我认路
  'soul_recall(query) 查记忆/封存/笔记/原文库；单独用 memory_search / archive_search',
  // 三期 C：能力入口（约 12 tok）。带 query 会按「最近 2 条 user 消息」自动取词，给 3–5 个工具名。
  '能力：soul_capabilities(query)',
  // 十二期：关系层 / 情绪（正文不常驻，只给入口；约 10 tok）
  '关系层 soul_relations() · 情绪 soul_mood()',
])

/** 三节每条最多注入几条（2026-10-28 起超出的不再静默丢，会在 soul.log 记一行 warn）。 */
export const SOUL_SECTION_CAP = 8

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function asInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 与 `dsh-context-index` / `dsh-sealed-segments` 同一口径，便于横向对比。 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let units = 0
  for (const ch of text) units += CJK.test(ch) ? 1 : 0.34
  return Math.ceil(units)
}

export function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (max <= 0) return ''
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

function dsHome() {
  return asText(process.env.DSH_HOME) || join(homedir(), '.dsh')
}

/**
 * 插件自己的目录（§C：用 `import.meta.url` 推，不用 `process.cwd()`）。
 * 开源化之后所有默认路径都从这里派生，别再写死交办方本机的绝对路径。
 */
export const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 十二期：关系层 / 情绪（都**只读**、都住在 lanxi/，不进记忆库）
// ---------------------------------------------------------------------------

/** 关系层最多返回几条（单子 §3.1：≤8 条）。 */
export const RELATIONS_CAP = 8
/** mood 读取上限（字）。 */
export const MOOD_MAX_CHARS = 600

/**
 * 读关系层：目录内 `*.md` 按文件名**倒序**，取最新一份里的全部 `- ` bullet（≤8 条）。
 * 旧文件不删（可追溯）；单条形如 `- 正文（YYYY-MM-DD）`。
 * @returns {{ok:boolean, file:string, date:string, items:string[], note:string}}
 */
export function readRelations(dir) {
  const base = asText(dir)
  if (!base || !existsSync(base)) return { ok: true, file: '', date: '', items: [], note: '关系层为空' }
  let files = []
  try {
    files = readdirSync(base).filter((name) => name.endsWith('.md')).sort().reverse()
  } catch {
    return { ok: true, file: '', date: '', items: [], note: '关系层为空' }
  }
  for (const name of files) {
    const file = join(base, name)
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const items = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean)
      .slice(0, RELATIONS_CAP)
    if (items.length === 0) continue
    const date = (/(\d{4}-\d{2}-\d{2})/.exec(name) ?? [])[1] ?? ''
    return { ok: true, file, date, items, note: '' }
  }
  return { ok: true, file: '', date: '', items: [], note: '关系层为空' }
}

/** 读 mood.md（整文件，最多 600 字）。v1 只读，写入由伊纳手动。 */
export function readMood(path) {
  const file = asText(path)
  if (!file || !existsSync(file)) return { ok: true, file: '', text: '', note: '未记录' }
  try {
    const text = readFileSync(file, 'utf8').slice(0, MOOD_MAX_CHARS)
    return { ok: true, file, text: text.trim(), note: '' }
  } catch (error) {
    return { ok: false, file, text: '', note: `读不到：${String(error?.message ?? error)}` }
  }
}

/**
 * 八期 T1：dsh-soul 拿不到 meow-memory 的 Service 实例，直接读 profile 的 patch 文件。
 * 只列 `profiles/<名字>/cordis.patch.yml`，不递归找 `node_modules`：
 * 我们要的是「本机当前生效的配置」，不是插件自带的默认 patch。
 */
export function profilePatchPaths(home = dsHome()) {
  const dir = join(home, 'profiles')
  if (!existsSync(dir)) return []
  const paths = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(dir, entry.name, 'cordis.patch.yml')
      if (existsSync(file)) paths.push(file)
    }
  } catch {
    return []
  }
  return paths.sort()
}

function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

/**
 * 归一化配置。用户目录下的路径（日志、cue）从 `DSH_HOME` 推出，**不写死**（§9.6）；
 * 本机路径一律由 profile 显式配置（见 README「最小安装」）。
 */
export function normalizeConfig(config = {}) {
  const home = dsHome()
  /**
   * 八期 T1：常驻预算与 meow 同源，不再各自维护一个常数。
   * 优先级：显式传参 `budgetTokens` → profile `injectBudgetChars` → meow 默认 1400 字 → 兜底 600 tok。
   * 读不到就回落并在 preview 首行标明来源（不许让人以为还是 600/2200 tok 的老尺子）。
   */
  // 已经归一化过的配置再喂回来（`{...normalized, 某字段}`）时：
  //   - 若 tok 与字这一对还自洽（2200 字 ↔ 1538 tok，±2 取整误差），就当作「解析结果」而不是「用户显式传参」；
  //   - 只改了其中一条（例如只给 tierBudgetTokens: 600）→ 视为显式覆盖，按 arg 处理。
  const looksResolved =
    config.tierBudgetResolved === true &&
    Number.isFinite(Number(config.tierBudgetTokens)) &&
    Math.abs(Number(config.tierBudgetTokens) * CHARS_PER_TOKEN - Number(config.tierBudgetChars)) <= 2
  const reuseBudget = looksResolved && !(Array.isArray(config.tierConfigPaths) && config.tierConfigPaths.length > 0)
  const explicitTokens = looksResolved || config.tierBudgetTokens == null ? null : Number(config.tierBudgetTokens)
  const tierBudget = reuseBudget
    ? {
        tokens: Number(config.tierBudgetTokens),
        chars: Number(config.tierBudgetChars) || Math.round(Number(config.tierBudgetTokens) * CHARS_PER_TOKEN),
        source: asText(config.tierBudgetSource) || 'arg',
        note: asText(config.tierBudgetNote),
        sourcePath: asText(config.tierBudgetPath),
        pinIds: Array.isArray(config.tierPins) ? config.tierPins.map((item) => asText(item)).filter(Boolean) : [],
      }
    : resolveTierBudget({
        dshHome: home,
        configPaths: Array.isArray(config.tierConfigPaths) && config.tierConfigPaths.length > 0
          ? config.tierConfigPaths
          : profilePatchPaths(home),
        budgetTokens: explicitTokens,
      })
  /**
   * 开源化（2026-11-03）：默认路径全部从插件目录 / stateDir 派生，配置优先。
   * 交办方本机的旧绝对路径改由 profile 的 cordis.patch.yml 显式给出（§D），不再写死在这里。
   */
  const stateDir = asText(config.stateDir) || join(PLUGIN_DIR, '.state')
  const memoryBackend = ['builtin', 'meow', 'none'].includes(asText(config.memoryBackend))
    ? asText(config.memoryBackend)
    : 'builtin'
  const notesDir = asText(config.notesDir) || join(stateDir, 'notes')
  const soulPath = asText(config.soulPath) || join(PLUGIN_DIR, 'soul.md')
  /** 分区（待办 A）：memory/*.md 与 index.jsonl 默认挂在 soul.md 同一目录下。 */
  const soulRoot = dirname(soulPath)
  const memoryRoot = asText(config.memoryRoot) || join(soulRoot, 'memory')
  const zoneIndexPath = asText(config.zoneIndexPath) || join(soulRoot, 'index.jsonl')
  const memoryDbPath = asText(config.memoryDbPath)
    || join(stateDir, memoryBackend === 'meow' ? 'memory.db' : 'soul-memory.db')
  /** 工作区根：显式给了记忆库就按它推（meow 本机 = 记忆库上一级）；没给就取插件上一级。 */
  const workspaceRoot = asText(config.memoryDbPath) ? resolve(dirname(memoryDbPath), '..') : dirname(PLUGIN_DIR)
  return Object.freeze({
    soulPath,
    /** 分区索引与标签（待办 A）。 */
    memoryRoot,
    zoneIndexPath,
    notesDir,
    /** 十二期：关系层目录（`*.md` 按文件名倒序取最新一份）与 mood 文件——不进记忆库。 */
    relationsDir: asText(config.relationsDir) || join(stateDir, 'relations'),
    moodPath: asText(config.moodPath) || join(stateDir, 'mood.md'),
    archiveRoot: asText(config.archiveRoot) || join(stateDir, 'archive'),
    /** 记忆后端：builtin（默认，自带最小 schema）｜meow（本机七层库适配器）｜none（全部返回空）。 */
    memoryBackend,
    memoryDbPath: asText(config.memoryDbPath)
      || join(stateDir, memoryBackend === 'meow' ? 'memory.db' : 'soul-memory.db'),
    // 2026-11-01：第四源 soul-index 原文库（全量会话原文）；空 = 不注册该源
    soulIndexDir: asText(config.soulIndexDir),
    soulIndexPython: asText(config.soulIndexPython) || 'python',
    logPath: asText(config.logPath) || join(stateDir, 'soul.log'),
    stateDir,
    /**
     * 封存源（dsh-sealed-segments）：先按**显式路径**导入，再按包名解析（profile node_modules），
     * 都失败就跳过这个源——不再保留写死的 `../dsh-sealed-segments/index.js` 回落（§B）。
     */
    sealedModule: asText(config.sealedSegmentsModule) || asText(config.sealedModule),
    soulMaxTokens: asInt(config.soulMaxTokens, DEFAULT_SOUL_TOKENS, 40, HARD_SOUL_TOKENS),
    totalMaxTokens: asInt(config.totalMaxTokens, TOTAL_TOKENS, 200, 4000),
    /** 二期 B R1：固定注入申报阈值（2026-10-28 改口径：报常驻快照 tok，默认 2500；超了才申报、不裁剪）。 */
    fixedMaxTokens: asInt(config.fixedMaxTokens, 2500, 200, 20000),
    /** 二期 B R5：周检主探针周期（天）。伊纳要求 7 天，可调短不可默认变长。 */
    probeIntervalDays: asInt(config.probeIntervalDays, 7, 1, 90),
    /** 二期 B R5：dream 收尾后附带的快检条数。 */
    probeQuickCount: asInt(config.probeQuickCount, 3, 1, 10),
    /** true=真把目录型注入从本轮消息里剔掉；false=只统计与报告。 */
    enforceBudget: config.enforceBudget === true,
    /** 「现在在哪 → 手头未结」的条数上限（§5：超限只留 3 条）。 */
    pendingLimit: asInt(config.pendingLimit, 3, 0, 5),
    /** 2026-11-01：未结只报条数（count），正文按需 soul_recall；full 保留旧行为。 */
    pendingMode: asText(config.pendingMode) === 'full' ? 'full' : 'count',
    /** 2026-11-01：路由层文件——魂引只放「该去哪查」，不放内容，这样库怎么长魂引都不涨。 */
    routerPath: asText(config.routerPath) || '',
    /** soul_recall 默认返回条数（§3.2：默认 3，上限 5）。 */
    recallLimit: asInt(config.recallLimit, 3, 1, 5),
    /**
     * 二期模块 B 的目标库：billion-context 的 index.db。
     * 默认按 XDG 约定从用户主目录推，不写死绝对路径（§9.6）；可用 config.biliDbPath 覆盖。
     */
    biliDbPath:
      asText(config.biliDbPath) ||
      asText(process.env.BILI_SESSIONS_DIR) ||
      join(homedir(), '.local', 'share', 'billion-context', 'sessions', 'index.db'),
    /** 模块 B 的下界：最近 N 个 turn 内的工具输出不动。 */
    tooloutRecentTurns: asInt(config.tooloutRecentTurns, 8, 1, 100),
    /** 模块 B 的短文本阈值：短于这个字符数不动（省不了多少还容易误伤）。 */
    tooloutMinChars: asInt(config.tooloutMinChars, 400, 100, 20000),
    /** 模块 C 的清单落盘位置（跟着 notesDir 走，不另写绝对路径）。 */
    capabilitiesPath: asText(config.capabilitiesPath) || join(notesDir, 'capabilities.md'),
    /** 模块 C 的调用次数统计窗口。 */
    capabilitiesDays: asInt(config.capabilitiesDays, 30, 1, 365),
    /**
     * 九期：gamedev 技能库目录（只读它的 INDEX.json）。
     * 不写死盘符：优先配置项，缺省回落到「工作区/skills/gamedev」——工作区按记忆库位置推。
     */
    gamedevSkillsDir: asText(config.gamedevSkillsDir) || join(workspaceRoot, 'skills', 'gamedev'),
    /**
     * 八期 T1：常驻名单目标预算——**跟 meow 同源**，不再各自维护常数。
     * 优先级见 `resolveTierBudget`：显式传参 → profile `injectBudgetChars` → meow 默认 1400 字 → 兜底 600 tok。
     * `tierBudgetChars` 保留 meow 的**字数**口径，避免 round 之后再乘回去产生 1 字误差。
     */
    tierBudgetTokens: tierBudget.tokens,
    tierBudgetChars: tierBudget.chars,
    tierBudgetSource: tierBudget.source,
    tierBudgetNote: tierBudget.note,
    tierBudgetPath: tierBudget.sourcePath,
    /** 归一化标记：把本对象再喂回 normalizeConfig 时沿用，不要重新猜来源。 */
    tierBudgetResolved: true,
    /** meow 配置里的显式 pin id（永不衰减，本工具不碰）；配置里显式给就优先。 */
    tierPins: Array.isArray(config.tierPinIds) && config.tierPinIds.length > 0
      ? config.tierPinIds.map((item) => asText(item)).filter(Boolean)
      : tierBudget.pinIds ?? [],
    /** 模块 C 扫插件的根目录：默认本工作区的 plugins + 当前 profile 的 node_modules。 */
    pluginRoots: Array.isArray(config.pluginRoots) && config.pluginRoots.length > 0
      ? config.pluginRoots.map((item) => asText(item)).filter(Boolean)
      : [resolve(workspaceRoot, 'plugins'), join(home, 'profiles', 'desktop', 'node_modules')],
  })
}

// ---------------------------------------------------------------------------
// soul.md：解析与渲染
// ---------------------------------------------------------------------------

/**
 * 解析 soul.md。只认 `## 标题` 分节 + 每行一条 bullet（`-`/`*`/`+`/`1.`）。
 * 认不出的内容不注入（宁可少说，不可乱说），但原文件字节不动（§7.1 只追加）。
 */
/**
 * 2026-11-01：路由层。魂引只放「该去哪查」，不放内容——库怎么长，魂引都不涨。
 * 文件一行一条 `触发 → 去哪`；`#` 开头是注释；最多取 6 行。
 */
export function readRouterLines(path) {
  try {
    if (!path || !existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .slice(0, 6)
  } catch {
    return []
  }
}

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
      current = Object.prototype.hasOwnProperty.call(sections, title) ? title : '__other__'
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

const EMPTY_SOUL = Object.freeze({
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
export function composeSoul(input = {}) {
  const soul = input.soul ?? EMPTY_SOUL
  const timeZone = asText(input.timeZone) || 'Asia/Shanghai'
  const at = input.at instanceof Date ? input.at : new Date(input.at ?? Date.now())
  const pending = Array.isArray(input.pending) ? input.pending.filter((x) => asText(x) !== '') : []
  const workspace = asText(input.workspace) || '未标注工作区'
  const maxTokens = asInt(input.maxTokens, DEFAULT_SOUL_TOKENS, 40, HARD_SOUL_TOKENS)
  const router = (Array.isArray(input.router) ? input.router : [])
    .map((item) => asText(item)).filter((item) => item !== '').slice(0, 6)
  const pendingMode = asText(input.pendingMode) === 'full' ? 'full' : 'count'
  // 2026-11-03：压缩后重载。压缩折叠的是历史，魂引本身每轮重生成；但被 slice 截掉的
  // 条目和记忆摘要压缩后就再也看不见，所以在压缩后第一轮把三节全量渲染一次。
  const reload = input.reload === true

  const identityAll = bulletsOf(soul, '我是谁')
  const mindAll = bulletsOf(soul, '我怎么想')
  const boundaryAll = bulletsOf(soul, '我不做什么')
  const groupAll = bulletsOf(soul, '在群里')
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
    ['我是谁', identityAll],
    ['我怎么想', mindAll],
    ['我不做什么', boundaryAll],
    ['在群里', groupAll],
  ]) {
    if (list.length > SOUL_SECTION_CAP) {
      warnings.push(
        `dsh-soul: soul.md「${label}」有 ${list.length} 条，只注入前 ${SOUL_SECTION_CAP} 条（第 ${SOUL_SECTION_CAP + 1} 条起被丢弃）`,
      )
    }
  }

  // 降档先减「条数」（留几条完整的话），再减「字数」（每条收窄）—— 顺序反了会得到
  // 九条 12 字的残句，读起来比没有更糟（2026-10-24 用真实 soul.md 探针发现）。
  const stages = [
    ...(reload
      ? [{ id: 'reload', take: { identity: 99, mind: 99, boundary: 99, group: 99, mem: 3, router: 6 }, pendingLimit: Math.min(3, pending.length), hints: 'full', coreMax: 0 }]
      : []),
    { id: 'full', take: { identity: 5, mind: 5, boundary: 3, group: 3, mem: 3, router: 6 }, pendingLimit: Math.min(3, pending.length), hints: 'full', coreMax: 0 },
    { id: 'pending-1', take: { identity: 5, mind: 5, boundary: 3, group: 3, mem: 3, router: 6 }, pendingLimit: Math.min(1, pending.length), hints: 'full', coreMax: 0 },
    { id: 'no-pending', take: { identity: 5, mind: 5, boundary: 3, group: 3, mem: 3, router: 6 }, pendingLimit: 0, hints: 'full', coreMax: 0 },
    { id: 'short-hints', take: { identity: 5, mind: 5, boundary: 3, group: 3, mem: 3, router: 3 }, pendingLimit: 0, hints: 'short', coreMax: 0 },
    { id: 'two-two', take: { identity: 2, mind: 0, boundary: 3, group: 2, mem: 2 }, pendingLimit: 0, hints: 'short', coreMax: 0 },
    { id: 'one-one', take: { identity: 2, mind: 0, boundary: 2, group: 1, mem: 1 }, pendingLimit: 0, hints: 'short', coreMax: 0 },
    { id: 'clip-core-48', take: { identity: 2, mind: 0, boundary: 2, group: 1, mem: 0 }, pendingLimit: 0, hints: 'short', coreMax: 48 },
    { id: 'clip-core-32', take: { identity: 2, mind: 0, boundary: 2, group: 1, mem: 0 }, pendingLimit: 0, hints: 'short', coreMax: 32 },
    { id: 'clip-core-20', take: { identity: 1, mind: 0, boundary: 1, group: 0, mem: 0 }, pendingLimit: 0, hints: 'short', coreMax: 20 },
    { id: 'clip-core-12', take: { identity: 1, mind: 0, boundary: 1, group: 0, mem: 0 }, pendingLimit: 0, hints: 'short', coreMax: 12 },
  ]

  // 2026-11-03：full 档每节的展示条数比 SOUL_SECTION_CAP 更紧（boundary=3），
  // 之前只对「>8 条」告警，3~8 条之间被丢的条目是静默的。现在补一条按档位的 warn；
  // reload 档 take=99 不触发。
  const fullTake = stages[0].take
  for (const [label, list, cap] of [
    ['我是谁', identityAll, fullTake.identity],
    ['我怎么想', mindAll, fullTake.mind],
    ['我不做什么', boundaryAll, fullTake.boundary],
    ['在群里', groupAll, fullTake.group],
  ]) {
    if (list.length > cap && list.length <= SOUL_SECTION_CAP) {
      warnings.push(`dsh-soul: soul.md「${label}」有 ${list.length} 条，只注入前 ${cap} 条（第 ${cap + 1} 条起被丢弃）`)
    }
  }

  // 2026-11-01：单条软上限。条数早就有上限，但单条长度没有——有人手滑写长一条就能撑爆。
  // full 阶段裁到 80 字并记一条 warn；降档时仍按 coreMax 裁更短。
  const SOFT_BULLET_MAX = 140
  for (const [label, list] of [['我是谁', identityAll], ['我怎么想', mindAll], ['我不做什么', boundaryAll], ['在群里', groupAll]]) {
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
    if (shownIdentity.length > 0) lines.push(`我是谁：${shownIdentity.join(' · ')}${overflow(identityAll, shownIdentity)}`)
    if (shownMind.length > 0) lines.push(`我怎么想：${shownMind.join(' · ')}${overflow(mindAll, shownMind)}`)
    if (shownBoundary.length > 0) lines.push(`我不做什么：${shownBoundary.join(' · ')}${overflow(boundaryAll, shownBoundary)}`)
    if (shownGroup.length > 0) lines.push(`在群里：${shownGroup.join(' · ')}${overflow(groupAll, shownGroup)}`)
    if (shownMem.length > 0) lines.push(`我记得：${shownMem.join(' · ')}`)
    lines.push('【现在在哪】')
    lines.push(`${stampOf(at, timeZone)} ${weekdayOf(at, timeZone)} · ${workspace}`.trim())
    if (pending.length > 0) {
      if (pendingMode === 'count') {
        lines.push(`未结 ${pending.length} 条 → soul_recall('未结')`)
      } else {
        const shown = stage.pendingLimit > 0 ? pending.slice(0, stage.pendingLimit) : []
        if (shown.length > 0) lines.push(`未结：${shown.map((item) => clip(item, 40)).join(' · ')}`)
      }
    }
    const shownRouter = router.slice(0, stage.take.router ?? 0)
    const zoneLine = renderZoneLine(zoneRows)
    if (zoneLine) lines.push(zoneLine)
    if (shownRouter.length > 0) {
      lines.push('【路由】')
      lines.push(...shownRouter)
    }
    lines.push('【怎么查】')
    if (stage.hints === 'short') lines.push('memory_search / archive_search / soul_recall')
    else lines.push(...HINTS)
    return lines.join('\n')
  }

  let text = render(stages[0])
  let used = stages[0]
  for (const stage of stages) {
    text = render(stage)
    used = stage
    if (estimateTokens(text) <= maxTokens) break
  }
  // 绝对兜底：仍然超限就硬裁，并在尾巴注明，绝不静默放大（§8.1）。
  if (estimateTokens(text) > maxTokens) {
    const note = '（魂引超限，已截断）'
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
    warnings.push(`dsh-soul: 魂引降档 stage=${used.id} 原 ${fullTokens}tok 上限 ${maxTokens}tok（【怎么查】只留一行）`)
    const note = `【魂引】已降档 ${used.id}`
    if (!text.includes('【魂引】已降档') && estimateTokens(`${text}\n${note}`) <= maxTokens) {
      text = `${text}\n${note}`
    }
  }
  return {
    text,
    tokens: estimateTokens(text),
    stage: used.id,
    warnings,
  }
}

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
  const perClass = { soul: 0, partition: 0, archive: 0, time: 0, other: 0 }
  const counts = { soul: 0, partition: 0, archive: 0, time: 0, other: 0 }
  for (const message of Array.isArray(messages) ? messages : []) {
    const kind = typeof message?.source?.kind === 'string' ? message.source.kind : 'other'
    const id = classOfKind(kind)
    const text = textOfMessage(message)
    perClass[id] += estimateTokens(text)
    counts[id] += 1
  }
  const total = perClass.soul + perClass.partition + perClass.archive + perClass.time
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

export function detectSnapshotDrift(snapshots) {
  const hits = new Set()
  for (const message of Array.isArray(snapshots) ? snapshots : []) {
    const match = DRIFT_PATTERN.exec(textOfMessage(message))
    if (match) hits.add(match[1])
  }
  return [...hits]
}

// ---------------------------------------------------------------------------
// 二期 B R5：周检探针（7 天一轮；dream 收尾后附带 3 条快检）
// ---------------------------------------------------------------------------

/** meow-memory 的 dream 标记：它插一条带这个 marker 的 user 消息。 */
export const DREAM_MARKER = '[meow-memory-dream]'

/** 最近一个 turn 里有没有 dream 注入（用来判断「dream 刚收尾」）。 */
export function isDreamTurn(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') break
    if (event?.type !== 'user/message') continue
    if (textOfMessage(event?.data?.message ?? event?.data).includes(DREAM_MARKER)) return true
  }
  return false
}

/** 记忆库的 `keywords` 列常是 JSON 数组字符串（`["a","b"]`），也可能是普通分隔串。 */
export function wordsOfKeywords(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return parsed.map((word) => String(word).trim()).filter((word) => word.length >= 2)
      }
    } catch {
      /* 落到下面的分隔切法 */
    }
  }
  return text
    .split(/[,，;；、\s]+/)
    .map((word) => word.replace(/^["'[\]()]+|["'[\]()]+$/g, '').trim())
    .filter((word) => word.length >= 2)
}

/**
 * 探针词只从**检索面**取（keywords 优先，其次 title），绝不从正文切——
 * 从正文切的词在关键词索引里常常搜不回来，会得到假警报（记忆 `0mvl2r5kf`）。
 * 抽样是确定性的（同一 seed 复跑同一批），seed 用「日期序号」，便于复现。
 */
export function pickProbeWords(dbPath, count, seed = 0) {
  if (!existsSync(dbPath) || count <= 0) return []
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const pool = []
    for (const level of MEMORY_LEVELS) {
      const cols = tableColumns(db, level)
      if (!cols.includes('content')) continue
      const hasStatus = cols.includes('status')
      const pick = ['id', 'content']
      for (const optional of ['title', 'keywords']) if (cols.includes(optional)) pick.push(optional)
      let rows
      try {
        rows = db.prepare(`select ${pick.join(', ')} from ${level}${hasStatus ? " where status = 'active'" : ''}`).all()
      } catch {
        continue
      }
      for (const row of rows) {
        const keywords = wordsOfKeywords(row.keywords)
        const titleWords = wordsOfKeywords(row.title)
        const words = keywords.length > 0 ? keywords : titleWords
        if (words.length === 0) continue
        pool.push({ level, id: String(row.id), words })
      }
    }
    if (pool.length === 0) return []
    const picked = []
    const used = new Set()
    let cursor = Math.abs(Math.trunc(seed)) % pool.length
    const total = Math.min(count, pool.length)
    for (let guard = 0; guard < pool.length * 3 && picked.length < total; guard += 1) {
      const item = pool[cursor % pool.length]
      cursor += 7
      const key = `${item.level}#${item.id}`
      if (used.has(key)) continue
      used.add(key)
      picked.push(item)
    }
    return picked
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

/** 逐条探针：用条目自己的 keywords 查，命中同一 id 即算通过。 */
export function runProbes(options, probes, limit = 5) {
  const results = []
  for (const probe of Array.isArray(probes) ? probes : []) {
    const words = probe.words.slice(0, 3).map((word) => word.toLowerCase())
    const found = searchMemory(options, words, limit)
    const needle = `#${probe.id}`
    const hit = (found.entries ?? []).some((entry) => String(entry?.loc ?? '').includes(needle))
    results.push({ level: probe.level, id: probe.id, words, hit })
  }
  const passed = results.filter((item) => item.hit).length
  return { results, passed, total: results.length }
}

function probeStatePath(stateDir) {
  return join(stateDir, 'probe-state.json')
}

export function readProbeState(stateDir) {
  try {
    const file = probeStatePath(stateDir)
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeProbeState(stateDir, state) {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(probeStatePath(stateDir), JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 到点就跑：主探针每 `probeIntervalDays` 一轮（10 条，≥8 通过），
 * dream 收尾那轮改跑快检（默认 3 条）。连续两期主探针不达标 → `alert=true`，由调用方在魂引末行申报。
 * 全部只读本地记忆库，不出网、不额外起模型请求。
 */
export function maybeRunProbe(config, at, dreamTurn) {
  const state = readProbeState(config.stateDir)
  const interval = config.probeIntervalDays * 86_400_000
  const mainDue = at.getTime() - Number(state.lastMainAt ?? 0) >= interval
  if (!mainDue && !dreamTurn) return { line: '', alert: false, state }
  const count = mainDue ? 10 : config.probeQuickCount
  const probes = pickProbeWords(config.memoryDbPath, count, Math.floor(at.getTime() / 86_400_000))
  if (probes.length === 0) return { line: 'probe=skip/no-probe-words', alert: false, state }
  const run = runProbes({ memoryDbPath: config.memoryDbPath }, probes)
  const need = Math.ceil(run.total * 0.8)
  const next = { ...state }
  if (mainDue) {
    next.lastMainAt = at.getTime()
    next.lastMainPassed = run.passed
    next.lastMainTotal = run.total
    next.badStreak = run.passed >= need ? 0 : Number(state.badStreak ?? 0) + 1
  } else {
    next.lastQuickAt = at.getTime()
    next.lastQuickPassed = run.passed
    next.lastQuickTotal = run.total
    if (run.passed < run.total) next.quickMiss = Number(state.quickMiss ?? 0) + 1
  }
  writeProbeState(config.stateDir, next)
  const tag = mainDue ? 'main' : 'quick'
  const bad = mainDue && run.passed < need
  const missed = run.results.filter((item) => !item.hit).map((item) => `${item.level}#${item.id}`)
  return {
    line: [
      `probe=${tag} ${run.passed}/${run.total}`,
      bad ? 'ALERT' : 'ok',
      `need=${need}`,
      `bad-streak=${Number(next.badStreak ?? 0)}`,
      missed.length > 0 ? `miss=${missed.join(',')}` : '',
      `words=${run.results.map((item) => item.words.join('|')).join(';')}`,
    ].filter(Boolean).join(' '),
    alert: Number(next.badStreak ?? 0) >= 2,
    state: next,
  }
}

/**
 * 三期 A5：dream 收尾那轮跑一次 `soul_tier preview`，结果只写 `soul.log`（`tier=名单/超线/字符`）。
 * 7 天一次（`stateDir/tier-state.json` 记上次时间）；**只 preview，不落库** —— apply 只能人工触发。
 */
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

export function appendLog(logPath, line) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${line}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

export function logLine(at, action, detail) {
  return `${new Date(at).toISOString()} ${action} ${detail}`
}

// ---------------------------------------------------------------------------
// 「现在在哪 → 手头未结」：读记忆库 project 表的 todo（只读，短期缓存）
// ---------------------------------------------------------------------------

function tableColumns(db, table) {
  try {
    return db.prepare(`pragma table_info(${table})`).all().map((row) => row.name)
  } catch {
    return []
  }
}

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
    db = new DatabaseSync(memoryDbPath, { readOnly: true })
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
    db = new DatabaseSync(memoryDbPath, { readOnly: true })
    const cols = tableColumns(db, 'project')
    if (!cols.includes('content')) return []
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
    db = new DatabaseSync(memoryDbPath, { readOnly: true })
    const rows = []
    for (const table of ['rules', 'lesson']) {
      const cols = tableColumns(db, table)
      if (!cols.includes('content')) continue
      const where = ['importance >= 3']
      if (cols.includes('status')) where.push("status = 'active'")
      const order = cols.includes('updated_at') ? 'updated_at desc' : 'rowid desc'
      try {
        for (const row of db
          .prepare(`select content, importance from ${table} where ${where.join(' and ')} order by ${order} limit ${limit}`)
          .all()) {
          rows.push({ content: String(row.content ?? ''), importance: Number(row.importance) || 0 })
        }
      } catch {
        /* 单表读不到就跳过，不影响另一张 */
      }
    }
    const seen = new Set()
    const heads = []
    for (const row of rows.sort((a, b) => b.importance - a.importance)) {
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
 * 反哺用：meow 库里 `corrected=1` 且仍在用的 lesson。
 * 列不一致（有的老库没 project）先探列再拼 SQL，别硬写列名。
 */
export function loadCorrectedLessons(memoryDbPath, limit = 200) {
  if (!existsSync(memoryDbPath)) return []
  let db
  try {
    db = new DatabaseSync(memoryDbPath, { readOnly: true })
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

// ---------------------------------------------------------------------------
// 注入消息
// ---------------------------------------------------------------------------

export function createSoulMessage(text) {
  return Object.freeze({
    id: `soul-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: MESSAGE_KIND,
      form: 'snapshot',
      sections: Object.freeze([Object.freeze({ name: MESSAGE_KIND, text })]),
    }),
  })
}

/**
 * 「现在在哪」要的是**会话工作区**，不是宿主进程的 cwd（那会是 profile 目录）。
 * 实测 `agent/pre-step` 的 payload 是 `{ messages, turn, step, signal, agent }`，
 * 工作区在 `agent.session.header.cwd`（`dsh-session` 的会话头记录 cwd，见
 * `liveSource.header.cwd`）。其余候选字段是防御性兜底：宿主换形状时仍能落到真值。
 */
export function resolveWorkspace(payload, options = {}) {
  const session = payload?.agent?.session ?? payload?.session
  const candidates = [
    options.workspace,
    session?.header?.cwd,
    session?.header?.workspace,
    session?.cwd,
    session?.workspace,
    payload?.agent?.cwd,
    payload?.agent?.workspace,
    payload?.cwd,
    payload?.workspace,
    payload?.runtimeContext?.cwd,
  ]
  for (const candidate of candidates) {
    const text = asText(candidate)
    if (text && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(text)) return text
  }
  return asText(process.cwd()) || '未标注工作区'
}

/**
 * 构造 `agent/pre-step` 处理器。导出成工厂是为了让 check.mjs 能用假 payload、
 * 临时 soul.md、临时日志跑断言，不碰真实会话与真实库（§9.8）。
 *
 * @param options 归一化后的配置（可再带 `now` / `logger` / `workspace` 覆盖）
 */
/**
 * 分区行（待办 A）：索引定顺序/标题，**条数每次现扫文件算**——手改完 memory/*.md
 * 忘了重建索引也不会把魂引的数字写错。
 */
export function zoneRowsOf(config) {
  const scanned = scanZones(config.memoryRoot)
  const rows = readZoneIndex(config.zoneIndexPath).map((row) => ({
    ...row,
    count: (scanned[row.zone] ?? []).length,
  }))
  const known = new Set(rows.map((row) => row.zone))
  for (const zone of ZONE_IDS) {
    if (known.has(zone)) continue
    const count = (scanned[zone] ?? []).length
    if (count > 0) {
      rows.push({ zone, title: ZONES[zone], file: `memory/${zone}.md`, count, tags: [], updated: '' })
    }
  }
  return rows
}

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
  // 待办 A：分区行（计数现扫，索引只定顺序），也是 60s 内复用。
  const zoneLoader = typeof options.zoneLoader === 'function' ? options.zoneLoader : () => zoneRowsOf(config)
  let zoneCache = { at: 0, rows: [] }

  const handler = async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    if (payload?.signal?.aborted === true) return decision

    const at = now()
    const soul = readSoul(config.soulPath)
    if (!soul && logger?.warn) logger.warn(`dsh-soul: 读不到 ${config.soulPath}，本轮只注入「现在在哪 / 怎么查」`)

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
    const reloadStateFile = join(config.stateDir, 'reload-state.json')
    let reloadState = {}
    try {
      reloadState = JSON.parse(readFileSync(reloadStateFile, 'utf8'))
    } catch {
      reloadState = {}
    }
    const currentInject = measureRequestBudget(decision.messages ?? []).total
    const previousInject = Number(reloadState.lastInject ?? 0)
    const reload = previousInject > 20000 && currentInject > 0 && currentInject < previousInject * 0.5
    try {
      mkdirSync(config.stateDir, { recursive: true })
      writeFileSync(
        reloadStateFile,
        JSON.stringify(
          {
            lastInject: currentInject,
            at: at.toISOString(),
            lastReloadAt: reload ? at.toISOString() : reloadState.lastReloadAt ?? null,
          },
          null,
          2,
        ),
        'utf8',
      )
    } catch {
      // 状态写不了不影响注入
    }
    if (reload) appendLog(config.logPath, logLine(at, 'reload', `压缩后重载 previous=${previousInject}tok current=${currentInject}tok`))

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
      maxTokens: reload ? HARD_SOUL_TOKENS : Math.min(config.soulMaxTokens, available),
      reload,
      inGroup,
    })

    let messages = [...kept, createSoulMessage(composed.text)]

    // 2026-10-28：三节超过 3 条时不再静默丢弃——一行 warn 进 soul.log（每节每轮最多一条）。
    for (const warning of composed.warnings ?? []) {
      appendLog(config.logPath, logLine(at, 'soul-warn', warning))
      logger?.warn?.(warning)
    }

    // 二期 B R2：本轮新来的长期记忆快照限流（不改历史、不改 meow-memory）。
    // 实测 `agent/pre-step` 的 decision.messages 只含本轮增量，历史快照不在里面——
    // 所以这里能做的是「让条数不再增长」，历史里已经超的只能在日志里如实报出来（见回执 H2/H3）。
    const events = eventsOfSession(session)
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
      const idx = finalMessages.findIndex((m) => m?.source?.kind === MESSAGE_KIND)
      if (idx >= 0) finalMessages[idx] = createSoulMessage(composed.text + notes.map((note) => `\n${note}`).join(''))
    }

    // R3 护栏：常驻快照里出现 project/topic/fact/lesson 正文 = meow-memory 变胖了。
    // 只记日志 + 当轮申报，**不改它的源码**（交办单 §3 R3）。
    const drift = detectSnapshotDrift(finalMessages.filter((message) => isSnapshotMessage(message)))
    if (drift.length > 0) {
      const idx = finalMessages.findIndex((m) => m?.source?.kind === MESSAGE_KIND)
      if (idx >= 0) {
        const base = textOfMessage(finalMessages[idx])
        finalMessages[idx] = createSoulMessage(`${base}\n【预算】常驻快照出现 ${drift.join('/')} 正文（疑似变胖）`)
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
        ].join(' '),
      ),
    )

    return { ...decision, messages: finalMessages }
  }

  handler.composeSoulAt = composeSoul
  return handler
}

// ---------------------------------------------------------------------------
// soul_recall：记忆库 / 封存段 / 笔记 三源（§3.2）
// ---------------------------------------------------------------------------

function wordsOf(query) {
  return asText(query).toLowerCase().split(/\s+/).filter(Boolean)
}

function hitAll(text, words) {
  const lower = String(text ?? '').toLowerCase()
  return words.every((word) => lower.includes(word))
}

function snippetAround(text, words, size = 90) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  const lower = value.toLowerCase()
  const first = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0]
  if (first === undefined) return clip(value, size)
  const start = Math.max(0, first - 20)
  return clip(value.slice(start, start + size), size)
}

/**
 * 记忆后端（§A）：`builtin`（默认，自带最小 schema）｜`meow`（本机七层库）｜`none`（全空不报错）。
 * 统一接口：`{ id, available, listHeads, search, listTier, putCue }`，
 * 另外补了 `listPending / listCorrectedLessons / countResident` 三个上层要用的读法（加法，不改已有语义）。
 *
 * 兼容口子：`builtin` 指向的库如果其实是 meow 的老库（有 soul/user 表、没有 memories 表），
 * 自动按 meow 语义读——这样 check.mjs 里那些临时 meow 靶子不用改。
 */
function createMeowBackend(cfg) {
  return {
    id: 'meow',
    dbPath: cfg.memoryDbPath,
    available: existsSync(cfg.memoryDbPath),
    listHeads: (limit = MEMORY_HEAD_LIMIT) => loadMemoryHeads(cfg.memoryDbPath, limit),
    listPending: (limit = 3) => loadPendingItems(cfg.memoryDbPath, limit),
    search: (query, limit = 5) => searchMemoryMeow(cfg, wordsOf(query), limit),
    listTier: (limit = 200) => {
      const read = readInjectionRows(cfg.memoryDbPath)
      return read.ok ? (read.rows ?? []).slice(0, limit) : []
    },
    putCue: () => ({ ok: false, error: 'meow 后端请走 soul_cue（cue.mjs）' }),
    listCorrectedLessons: (limit = 200) => loadCorrectedLessons(cfg.memoryDbPath, limit),
    countResident: () => countResidentEntries(cfg.memoryDbPath),
  }
}

function createBuiltinBackend(cfg) {
  const dbPath = cfg.memoryDbPath
  return {
    id: 'builtin',
    dbPath,
    available: true,
    listHeads: (limit = MEMORY_HEAD_LIMIT) => builtinMemory.listHeads(dbPath, limit),
    listPending: (limit = 3) => builtinMemory.listPending(dbPath, limit),
    search: (query, limit = 5) =>
      builtinMemory.search(dbPath, String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean), limit),
    listTier: (limit = 200) => builtinMemory.listTier(dbPath, limit),
    putCue: (id, cue) => builtinMemory.putCue(dbPath, id, cue),
    listCorrectedLessons: (limit = 200) => builtinMemory.listCorrectedLessons(dbPath, limit),
    countResident: () => builtinMemory.countResident(dbPath),
  }
}

function createNoneBackend(cfg) {
  const empty = { entries: [], note: '记忆后端已关闭（memoryBackend: none）' }
  return {
    id: 'none',
    dbPath: cfg.memoryDbPath,
    available: false,
    listHeads: () => [],
    listPending: () => [],
    search: () => empty,
    listTier: () => [],
    putCue: () => ({ ok: false, error: 'memoryBackend: none 不写 cue' }),
    listCorrectedLessons: () => [],
    countResident: () => 0,
  }
}

export function createMemoryBackend(config = {}) {
  const cfg = config && config.tierBudgetResolved ? config : normalizeConfig(config)
  if (cfg.memoryBackend === 'none') return createNoneBackend(cfg)
  if (cfg.memoryBackend === 'meow') return createMeowBackend(cfg)
  if (builtinMemory.looksLikeMeowDb(cfg.memoryDbPath)) return createMeowBackend(cfg)
  return createBuiltinBackend(cfg)
}

export function searchMemory(options, words, limit) {
  const backend = options && typeof options.search === 'function' && options.id ? options : createMemoryBackend(options)
  return backend.search(words.join(' '), limit)
}

function searchMemoryMeow(options, words, limit) {
  const dbPath = options.memoryDbPath
  if (!existsSync(dbPath)) return { entries: [], note: '记忆库不存在' }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    // 模块 A：cue 表存在时先走 cue 匹配，只在候选命中后才去读正文（二期 §2.3）。
    // 表不存在（老库/首次安装）保持一期行为，不做静默降级。
    const cueMap = readCueMap(db)
    if (cueMap !== null) return searchMemoryByCue(db, words, limit, cueMap, tableColumns)
    const scored = []
    for (const level of MEMORY_LEVELS) {
      const cols = tableColumns(db, level)
      if (cols.length === 0) continue
      const pick = ['id', 'status', 'content']
      for (const optional of ['title', 'keywords', 'project']) if (cols.includes(optional)) pick.push(optional)
      let rows
      try {
        rows = db.prepare(`select ${pick.join(', ')} from ${level}`).all()
      } catch {
        continue
      }
      for (const row of rows) {
        if (String(row.status ?? 'active') !== 'active') continue
        const title = String(row.title ?? '')
        const content = String(row.content ?? '')
        const keywords = String(row.keywords ?? '')
        const project = String(row.project ?? '')
        const blob = `${title} ${content} ${keywords} ${project}`
        const lowerBlob = blob.toLowerCase()
        const matched = words.filter((word) => lowerBlob.includes(word)).length
        // 命中词数是第一排序键：全中的排前面，但只中一半的也不直接丢（「记忆 部署」这种
        // 跨条目的查询在严格 AND 下会全灭，实际是两条分开的记忆各中一个）。
        // 下限取一半：三词查询只中一个常见词（如「支付」）的不算命中，否则什么都能搜出东西。
        const need = words.length <= 1 ? 1 : Math.ceil(words.length * 0.5)
        if (matched < need) continue
        let score = matched * 10
        score += words.filter((word) => keywords.toLowerCase().includes(word)).length * 3
        score += words.filter((word) => title.toLowerCase().includes(word)).length * 2
        score += words.filter((word) => content.toLowerCase().includes(word)).length
        scored.push({
          score,
          loc: `记忆库/${level}#${row.id}`,
          snippet: snippetAround(content !== '' ? content : title, words),
        })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return { entries: scored.slice(0, limit).map(({ loc, snippet }) => ({ loc, snippet })), note: '' }
  } catch (error) {
    return { entries: [], note: `记忆库读取失败：${String(error?.message ?? error)}` }
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

function scoreOf(matched, words, entry, content = '') {
  let score = matched * 10
  score += words.filter((word) => entry.keywords.toLowerCase().includes(word)).length * 3
  score += words.filter((word) => entry.title.toLowerCase().includes(word)).length * 2
  score += words.filter((word) => (entry.project ?? '').toLowerCase().includes(word)).length
  if (content !== '') score += words.filter((word) => content.toLowerCase().includes(word)).length
  return score
}

/**
 * cue 路径的检索（二期模块 A §2.3）：先只用 cue / 标题 / keywords / 项目打分，
 * 命中者才批量取正文做摘要，「未命中就整表读正文」被去掉。
 * 没有 cue 的行（凑不满 3 个触发词）在候选不足时补一次**受限**正文扫描
 * （最多 limit×50 行），否则 cue 空值会把老记忆变成搜不到——这是刻意的折中，写进报告。
 */
export function searchMemoryByCue(db, words, limit, cueMap, columnsOf = tableColumns) {
  const need = words.length <= 1 ? 1 : Math.ceil(words.length * 0.5)
  const picked = []
  const bare = []
  for (const level of MEMORY_LEVELS) {
    const cols = columnsOf(db, level)
    if (cols.length === 0) continue
    const pick = ['id', 'status']
    for (const optional of ['title', 'keywords', 'project']) if (cols.includes(optional)) pick.push(optional)
    let rows
    try {
      rows = db.prepare(`select ${pick.join(', ')} from ${level}`).all()
    } catch {
      continue
    }
    for (const row of rows) {
      if (String(row.status ?? 'active') !== 'active') continue
      const entry = {
        level,
        id: String(row.id),
        title: String(row.title ?? ''),
        keywords: String(row.keywords ?? ''),
        project: String(row.project ?? ''),
      }
      const tokens = cueMap.get(`${level}#${entry.id}`)
      if (!tokens || tokens.length === 0) {
        bare.push(entry)
        continue
      }
      const matched = scoreCue(tokens, words)
      if (matched < need) continue
      picked.push({ ...entry, matched, score: scoreOf(matched, words, entry) })
    }
  }

  const extra = []
  let scanned = 0
  if (picked.length < limit) {
    const budget = limit * 50
    for (const entry of bare) {
      if (scanned >= budget) break
      const cols = columnsOf(db, entry.level)
      if (!cols.includes('content')) continue
      let row
      try {
        row = db.prepare(`select content from ${entry.level} where id = ?`).get(entry.id)
      } catch {
        continue
      }
      scanned += 1
      const content = String(row?.content ?? '')
      const blob = `${entry.title} ${content} ${entry.keywords} ${entry.project}`.toLowerCase()
      const matched = words.filter((word) => blob.includes(word)).length
      if (matched < need) continue
      extra.push({ ...entry, content, matched, score: scoreOf(matched, words, entry, content) + 1 })
    }
  }

  const merged = [...picked, ...extra].sort((a, b) => b.score - a.score).slice(0, limit)
  const missing = merged.filter((entry) => entry.content === undefined)
  const contents = new Map()
  if (missing.length > 0) {
    const byLevel = new Map()
    for (const entry of missing) {
      if (!byLevel.has(entry.level)) byLevel.set(entry.level, [])
      byLevel.get(entry.level).push(entry.id)
    }
    for (const [level, ids] of byLevel) {
      try {
        const rows = db
          .prepare(`select id, content from ${level} where id in (${ids.map(() => '?').join(',')})`)
          .all(...ids)
        for (const row of rows) contents.set(`${level}#${row.id}`, String(row.content ?? ''))
      } catch {
        /* 取不到正文就退回标题，不算失败 */
      }
    }
  }

  const entries = merged.map((entry) => {
    const text = entry.content ?? contents.get(`${entry.level}#${entry.id}`) ?? ''
    return { loc: `记忆库/${entry.level}#${entry.id}`, snippet: snippetAround(text || entry.title, words) }
  })
  return { entries, note: '', cueHits: picked.length, contentHits: extra.length, scanned }
}

/**
 * 解析封存源模块（§B）：显式路径优先 → 包名 import → 用 profile 的 node_modules 解析包名。
 * 三处都失败就返回 `{module:null}`，由调用方写进 note，不再有写死的同级目录回落。
 */
function packageRequireBases() {
  const bases = [join(PLUGIN_DIR, 'package.json')]
  try {
    for (const item of readdirSync(join(dsHome(), 'profiles'), { withFileTypes: true })) {
      if (item.isDirectory()) bases.push(join(dsHome(), 'profiles', item.name, 'package.json'))
    }
  } catch {
    /* 没有 profiles 目录就只用插件自己 */
  }
  return bases
}

export async function resolveSealedModule(options = {}) {
  const spec = asText(options.sealedModule)
  if (!spec) return { module: null, via: 'none', error: '未配置 sealedSegmentsModule' }
  if (/[\\/]/.test(spec) || /\.m?js$/i.test(spec)) {
    const absolute = resolve(PLUGIN_DIR, spec)
    try {
      return { module: await import(pathToFileURL(absolute).href), via: 'path' }
    } catch (error) {
      return { module: null, via: 'path', error: String(error?.message ?? error) }
    }
  }
  try {
    return { module: await import(spec), via: 'import' }
  } catch {
    /* 插件目录解析不到包名，继续用 profile 的 node_modules 试 */
  }
  for (const base of packageRequireBases()) {
    try {
      const file = createRequire(base).resolve(spec)
      return { module: await import(pathToFileURL(file).href), via: 'require' }
    } catch {
      /* 下一个候选 */
    }
  }
  return { module: null, via: 'none', error: `找不到模块 ${spec}` }
}

/** 封存源复用 `dsh-sealed-segments` 的导出函数（§13.4），失败则明确报告而不是静默空结果。 */
export function createArchiveSearch(options) {
  let cached = null
  let reader = null
  return async function searchArchiveSource(words, limit) {
    cached ??= resolveSealedModule(options)
    const resolved = await cached
    if (!resolved.module) return { entries: [], note: `封存源不可用：${resolved.error ?? '导入失败'}` }
    const mod = resolved.module
    const manifestPath = options.manifestPath ?? join(options.archiveRoot, 'manifest.jsonl')
    try {
      reader ??= mod.createManifestReader({ manifestPath, archiveRoot: options.archiveRoot })
      const records = reader()
      const result = mod.searchArchive(records, {
        query: words.join(' '),
        limit,
        contextLines: 0,
        maxLines: 24,
        options: { manifestPath, archiveRoot: options.archiveRoot },
      })
      const entries = []
      let current = null
      for (const line of result.display ?? []) {
        const head = /^==\s+(\S+)\s+·\s+(.*?)\s+·\s+命中\s+(\d+)\s+处/.exec(line)
        if (head) {
          if (current) entries.push(current)
          current = { loc: `封存段/${head[1]}`, snippet: '' }
          continue
        }
        const body = /^[> ]\s*\d+\|\s*(.*)$/.exec(line)
        if (body && current && current.snippet === '') current.snippet = clip(body[1], 90)
      }
      if (current) entries.push(current)
      return { entries: entries.slice(0, limit), note: result.hits === 0 ? '封存里没有这些词' : '' }
    } catch (error) {
      return { entries: [], note: `封存检索失败：${String(error?.message ?? error)}` }
    }
  }
}

export function walkMarkdown(root, limit = 400) {
  const out = []
  const stack = [root]
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop()
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        if (item.name === 'node_modules' || item.name.startsWith('.')) continue
        stack.push(full)
      } else if (item.name.toLowerCase().endsWith('.md')) {
        out.push(full)
        if (out.length >= limit) break
      }
    }
  }
  return out
}

export function searchNotes(options, words, limit) {
  if (!existsSync(options.notesDir)) return { entries: [], note: '笔记目录不存在' }
  const files = walkMarkdown(options.notesDir)
  const entries = []
  for (const file of files) {
    let text
    try {
      if (statSync(file).size > 400_000) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!hitAll(text, words)) continue
    const lines = text.split(/\r?\n/)
    const index = lines.findIndex((line) => hitAll(line, words))
    const lineNo = index >= 0 ? index + 1 : 1
    entries.push({
      loc: `${relative(options.notesDir, file).split(sep).join('/')}:${lineNo}`,
      snippet: snippetAround(index >= 0 ? lines[index] : text, words),
    })
    if (entries.length >= limit) break
  }
  return { entries, note: entries.length === 0 ? '笔记里没有这些词' : '' }
}

/**
 * 第四源：soul-index 原文库（全量会话原文，2026-11-01 接入）。
 * 现跑 query.py --json；失败只返回 note，不拖累其余三源。
 */
export function searchIndexSource(options, words, limit) {
  return new Promise((resolve) => {
    const dir = options.soulIndexDir
    const script = join(dir, 'query.py')
    if (!existsSync(script)) return resolve({ entries: [], note: '原文库脚本不在' })
    let child
    try {
      child = spawn(options.soulIndexPython || 'python', [script, words.join(' '), String(limit), '--json'], {
        cwd: dir, windowsHide: true, env: { ...process.env, SOUL_INDEX_NO_SYNC: '1' },
      })
    } catch (e) {
      return resolve({ entries: [], note: '原文库启动失败：' + (e?.message || e) })
    }
    let out = ''
    let err = ''
    let done = false
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } finish({ entries: [], note: '原文库超时' }) }, 15000)
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => finish({ entries: [], note: '原文库不可用：' + (e?.message || e) }))
    child.on('close', (code) => {
      if (code !== 0) return finish({ entries: [], note: '原文库退出 ' + code + (err ? '：' + clip(err, 80) : '') })
      try {
        const rows = JSON.parse(out.trim() || '[]')
        finish({
          entries: rows.slice(0, limit).map((r) => ({ loc: r.when + ' ' + String(r.sid || '').slice(-8) + '#' + r.seq, snippet: r.snippet })),
          note: rows.length === 0 ? '原文库里没有这些词' : '',
        })
      } catch {
        finish({ entries: [], note: '原文库输出解析失败' })
      }
    })
  })
}

/**
 * 三源检索并压成 ≤1200 字符的文本（§3.2）。超限时截断并注明「还有 N 条未显示」。
 */
/**
 * 检索源注册制（§B）：memory / sealed / notes / index 四项。
 * 每项 `{ id, enabled, search }`；没配置的源不注册（返回「未配置（跳过）」的空结果），
 * 单个源抛错只写 note，不拖累其余源。
 */
export function createRecallSources(config) {
  const backend = createMemoryBackend(config)
  const archiveSearch = asText(config.sealedModule)
    ? createArchiveSearch({ ...config, manifestPath: join(config.archiveRoot, 'manifest.jsonl') })
    : null
  return [
    {
      id: 'memory',
      label: '① 记忆库',
      enabled: true,
      search: (words, n) => backend.search(words.join(' '), n),
    },
    {
      id: 'archive',
      label: '② 封存段',
      enabled: Boolean(archiveSearch),
      search: (words, n) => archiveSearch(words, n),
    },
    {
      id: 'notes',
      label: '③ 笔记',
      enabled: true,
      search: (words, n) => searchNotes(config, words, n),
    },
    {
      id: 'index',
      label: '④ 原文库',
      enabled: Boolean(asText(config.soulIndexDir)),
      search: (words, n) => searchIndexSource(config, words, n),
    },
  ]
}

export function createRecall(options = {}) {
  const config = normalizeConfig(options)
  const sources = createRecallSources(config)

  return async function recall({ query, limit, zone, tags } = {}) {
    const words = wordsOf(query)
    const wantedTags = (Array.isArray(tags) ? tags : asText(tags) ? asText(tags).split(/[,，、\s]+/) : [])
      .map((tag) => asText(tag))
      .filter(Boolean)
    const zoneWanted = asText(zone)
    // 待办 A：带了 zone / tags 就先在分区里过滤，再走分区打分；结果带 zone 与 tags。
    if (zoneWanted || wantedTags.length > 0) {
      const found = searchZones(scanZones(config.memoryRoot), {
        query: words.join(' '),
        zone: zoneWanted,
        tags: wantedTags,
        limit: asInt(limit, config.recallLimit, 1, 5),
      })
      const lines = [`【soul_recall · 分区】${zoneWanted || '全部'}${wantedTags.length ? ` · tags=${wantedTags.join('+')}` : ''}`]
      if (found.note) lines.push(found.note)
      for (const entry of found.entries) {
        lines.push(`- ${entry.zone}/${entry.title}${entry.tags.length ? ` [${entry.tags.join(',')}]` : ''} · ${entry.snippet}`)
      }
      const text = lines.join('\n').slice(0, RECALL_MAX_CHARS)
      return {
        ok: true,
        text,
        sources: { memory: found.entries.length, archive: 0, notes: 0, index: 0 },
        active: ['zone'],
        hits: found.entries.map((entry) => ({ zone: entry.zone, title: entry.title, tags: entry.tags, snippet: entry.snippet })),
        truncated: false,
      }
    }
    if (words.length === 0) {
      return {
        ok: false,
        text: 'soul_recall: query 不能为空',
        sources: { memory: 0, archive: 0, notes: 0, index: 0 },
        active: sources.filter((source) => source.enabled).map((source) => source.id),
        truncated: false,
      }
    }
    const n = asInt(limit, config.recallLimit, 1, 5)
    const results = await Promise.all(
      sources.map((source) =>
        source.enabled
          ? Promise.resolve()
              .then(() => source.search(words, n))
              .catch((error) => ({ entries: [], note: `源失败：${String(error?.message ?? error)}` }))
          : Promise.resolve({ entries: [], note: '未配置（跳过）' }),
      ),
    )
    const blocks = sources.map((source, index) => ({ id: source.id, label: source.label, result: results[index] }))
    const header = `【soul_recall】${words.join(' ')}`
    const lines = [header]
    let dropped = 0
    let chars = header.length + 1
    const counts = { memory: 0, archive: 0, notes: 0, index: 0 }
    for (const block of blocks) counts[block.id] = block.result.entries.length
    for (const block of blocks) {
      const head = `${block.label}（${block.result.entries.length} 条）${block.result.note ? ` · ${block.result.note}` : ''}`
      if (chars + head.length + 1 > RECALL_MAX_CHARS) {
        dropped += block.result.entries.length
        continue
      }
      lines.push(head)
      chars += head.length + 1
      for (const entry of block.result.entries) {
        const line = `- ${entry.loc} · ${entry.snippet}`
        if (chars + line.length + 1 > RECALL_MAX_CHARS) {
          dropped += 1
          continue
        }
        lines.push(line)
        chars += line.length + 1
      }
    }
    if (dropped > 0) lines.push(`（还有 ${dropped} 条未显示；缩小检索词或用原工具看全）`)
    const text = lines.join('\n').slice(0, RECALL_MAX_CHARS)
    return {
      ok: true,
      text,
      sources: counts,
      active: blocks.filter((block, index) => sources[index].enabled).map((block) => block.id),
      truncated: dropped > 0,
    }
  }
}

/**
 * §7 soul_persist：把「被伊纳明确纠正过」的 lesson 追加到 soul.md 第四节。
 * 只追加、不重写前三节；默认 preview，append 时才落盘并先备份。
 */
export function createPersist(config) {
  return async function persist(args = {}) {
    const mode = args?.mode === 'append' ? 'append' : 'preview'
    const limit = Math.min(Math.max(Number(args?.limit ?? 10) || 10, 1), 20)
    const md = readFileSync(config.soulPath, 'utf8')
    if (!md.includes('## 反哺记录')) {
      return { ok: false, mode, added: 0, pending: 0, text: 'soul.md 缺少「## 反哺记录」节，未写入' }
    }
    const seen = new Set()
    for (const m of md.matchAll(/（([0-9a-z]{8})/g)) seen.add(m[1])

    // 2026-11-03 开源化：记忆读取统一走 backend（builtin / meow / none 都能给出 lesson）
    const backend = createMemoryBackend(config)
    const rows = backend.listCorrectedLessons(500)

    const pending = rows.filter((row) => !seen.has(String(row.id).slice(0, 8)))
    const take = pending.slice(0, limit)
    const fmt = (row) => {
      let t = String(row.title ?? '').replace(/^关于：/, '').trim()
      if (!t) t = String(row.content ?? '').split(/[。；;！!？?\n]/)[0]
      t = t.replace(/\s+/g, ' ').trim()
      if (t.length > 46) t = t.slice(0, 46) + '…'
      const proj = row.project && row.project !== '全局' ? ` · ${row.project}` : ''
      const day = new Date(Number(row.created_at)).toLocaleDateString('sv-SE')
      return `- [${day}] ${t}（${String(row.id).slice(0, 8)}${proj}）`
    }
    const lines = take.map(fmt)

    if (mode !== 'append' || lines.length === 0) {
      const head = lines.length === 0
        ? `【soul_persist · 预览】没有待追加的条目（corrected=1 且 active 共 ${rows.length} 条，都已在反哺记录里）`
        : `【soul_persist · 预览】待追加 ${pending.length} 条，本次显示 ${lines.length} 条；确认后传 { mode: "append" } 才落盘`
      return { ok: true, mode, added: 0, pending: pending.length, text: [head, ...lines].join('\n') }
    }

    const backup = `${config.soulPath}.bak-persist-${Date.now()}`
    writeFileSync(backup, md, 'utf8')
    const next = md.replace(/\s*$/, '\n') + lines.join('\n') + '\n'
    writeFileSync(config.soulPath, next, 'utf8')
    const head = `【soul_persist · 已追加】${lines.length} 条（待追加剩 ${pending.length - lines.length} 条）；备份 ${backup}`
    return { ok: true, mode, added: lines.length, pending: pending.length - lines.length, text: [head, ...lines].join('\n') }
  }
}

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
    '工具输出归档（二期模块 B，只归档不删除）。preview 只报「将归档 N 段 / X 字符 / 预计省 Y tok」；apply 必须带 confirm:true，先整库 VACUUM INTO 备份、把原文导出到 lanxi\\archive\\toolout\\，再把该条消息换成一行指针；restore 按导出文件把原文塞回去。',
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
    '把「被用户明确纠正过」的 lesson（记忆库 corrected=1 且 active）追加到 soul.md 的「反哺记录」节。只追加不重写，默认 preview 预览；落盘前自动备份。反哺记录不进魂引，不涨每轮预算。',
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
    '十二期：读「关系层」——`lanxi/relations/*.md` 按文件名倒序取最新一份里的全部条目（≤8 条，第一人称、否定式/阈值、带日期）。只读，不写文件、不进记忆库；魂引里只有入口，正文要自己调这个工具拿。',
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
    '十二期：读「情绪状态」`lanxi/mood.md`（at / mood / carry 三个键，整文件 ≤600 字）。只读，v1 不写；没有文件就回「未记录」。',
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

  return [
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
}

/** 宿主入口 */

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.('soul') ?? console
  const normalized = normalizeConfig(config)
  const handler = createPreStepHandler({ config: normalized, timeZone: config?.timeZone, logger })
  ctx.on('agent/pre-step', handler, { prepend: true })

  const disposers = []
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
    for (const tool of createTools(normalized, { getSessions: () => sessionsRef })) disposers.push(ctx.tools.register(tool))
  } else {
    logger.warn?.('dsh-soul: tools 服务不可用，soul_recall / soul_persist / soul_cue / soul_toolout / soul_capabilities / soul_surface 未注册')
  }

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

export default { name, inject, apply, MESSAGE_KIND }
