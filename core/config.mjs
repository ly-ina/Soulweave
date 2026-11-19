/**
 * core/config.mjs —— 关系层读取、profile 补丁路径、配置归一化、路由行（零宿主依赖）。
 *
 * 2026-11-19 解耦第 2 块：从 index.js 原样搬出，逻辑未改。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { CHARS_PER_TOKEN, resolveTierBudget } from './tier.mjs'
import { DEFAULT_SOUL_STABLE_TOKENS, DEFAULT_SOUL_STATE_TOKENS, SOUL_STATE_MAX_CHARS, MESSAGE_KIND, SOUL_SECTIONS, SECTION_ALIASES, FEEDBACK_SECTION, FEEDBACK_ALIASES, SOUL_TOKEN_CEILING, DEFAULT_SOUL_WARN_TOKENS, HARD_SOUL_TOKENS, TOTAL_TOKENS, DEFAULT_SOUL_TOKENS, RECALL_MAX_CHARS, MEMORY_LEVELS, MEMORY_HEAD_LIMIT, INJECTION_CLASSES, YIELD_ORDER, HINTS } from './constants.mjs'
import { PLUGIN_DIR, asInt, asText, dsHome } from './text.mjs'

// ---------------------------------------------------------------------------
// 十二期：关系层 / 情绪（都**只读**、默认住在 <stateDir>/ 下，不进记忆库）
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

/** 读 mood.md（整文件，最多 600 字）。v1 只读，写入由使用者手动。 */
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
  /**
   * v0.1.2 P1：多文件常驻。主 soul.md 之后按数组顺序读，原文拼在一起再 parse 一次
   * （不是各 parse 各渲染），所以多份文件和 soul.md 共用同一份预算、同一条降档链。
   * 不配置时为空数组，行为与 v0.1.1 逐字节一致。
   */
  const extraSoulPaths = (Array.isArray(config.extraSoulPaths) ? config.extraSoulPaths : [])
    .map((item) => asText(item))
    .filter((item) => item !== '')
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
    /** v0.1.2 P1：额外常驻文件（按顺序拼在 soul.md 之后；空数组 = 只读 soul.md）。 */
    extraSoulPaths,
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
    /**
     * 交办单 A3（2026-11-04）：原文库增量触发。
     * 脚本默认取 `<soulIndexDir>/auto-sync.mjs`；没配 soulIndexDir 就是空，不注册监听。
     * 节流 60 秒（同一轮里多次 turn/end 不会重复拉起）；`soulIndexAutoSync:false` 可整体关掉。
     */
    soulIndexSyncScript: asText(config.soulIndexSyncScript)
      || (asText(config.soulIndexDir) ? join(asText(config.soulIndexDir), 'auto-sync.mjs') : ''),
    soulIndexSyncIntervalMs: asInt(config.soulIndexSyncIntervalMs, 60_000, 5_000, 3_600_000),
    soulIndexAutoSync: config.soulIndexAutoSync !== false,
    logPath: asText(config.logPath) || join(stateDir, 'soul.log'),
    stateDir,
    /**
     * 封存源（dsh-sealed-segments）：先按**显式路径**导入，再按包名解析（profile node_modules），
     * 都失败就跳过这个源——不再保留写死的 `../dsh-sealed-segments/index.js` 回落（§B）。
     */
    sealedModule: asText(config.sealedSegmentsModule) || asText(config.sealedModule),
    soulMaxTokens: asInt(config.soulMaxTokens, DEFAULT_SOUL_TOKENS, 40, SOUL_TOKEN_CEILING),
    /** 警示线：魂引渲染超过它就写 warn，不夹、不降档（2026-11-09）。 */
    soulWarnTokens: asInt(config.soulWarnTokens, DEFAULT_SOUL_WARN_TOKENS, 0, SOUL_TOKEN_CEILING),
    totalMaxTokens: asInt(config.totalMaxTokens, TOTAL_TOKENS, 200, 4000),
    /** 二期 B R1：固定注入申报阈值（2026-10-28 改口径：报常驻快照 tok，默认 2500；超了才申报、不裁剪）。 */
    fixedMaxTokens: asInt(config.fixedMaxTokens, 2500, 200, 20000),
    /** 二期 B R5：周检主探针周期（天）。要求 7 天，可调短不可默认变长。 */
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
    /**
     * 2026-11-12：规则原文目录（本机 = <workspace>\lanxi\rules）。
     * 稳定段只注入「文件名 + 标题」索引（受 rulesIndexMaxTokens 管），细则走 soul_recall 第⑤源。
     * 单源原则：原文只在那个目录里有一份，插件不复制进记忆库、也不整段抄进注入。
     */
    rulesDir: asText(config.rulesDir) || '',
    /** 规则索引预算（tok；0 = 不注入索引，但第⑤源仍可用）。 */
    rulesIndexMaxTokens: asInt(config.rulesIndexMaxTokens, 120, 0, 400),
    /** soul_recall 默认返回条数（§3.2：默认 3，上限 5）。 */
    recallLimit: asInt(config.recallLimit, 3, 1, 5),
    /**
     * 混合召回（2026-11-07）：true 时记忆源走「BM25 ∪ 向量」RRF 合并。
     * embedModule 是可选外部模块路径/包名，空 = 纯 BM25；加载或编码失败都退回 BM25。
     * 注意：normalizeConfig 是白名单对象，新配置必须在这里列出来，否则运行时会拿到 undefined。
     */
    hybridSearch: config.hybridSearch === true,
    embedModule: asText(config.embedModule),
    embedCachePath: asText(config.embedCachePath),
    embedModelDir: asText(config.embedModelDir),
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

    /**
     * 2026-11-04 魂引拆分（方案 reports/20261104-soul-injection-split-plan.md）。
     * 默认 false：`agent/pre-step` 完全走 legacy 的 composeSoul()，行为逐字节不变。
     * 第一阶段只落了渲染函数与测试，接线在第二阶段；回滚就是把它改回 false。
     */
    soulSplitInjection: config.soulSplitInjection === true,
    /** 稳定段预算（tok）：方案 §2.1 定 900。 */
    soulStableMaxTokens: asInt(config.soulStableMaxTokens, DEFAULT_SOUL_STABLE_TOKENS, 40, SOUL_TOKEN_CEILING),
    /** 动态段预算（tok）：方案 §2.1 定 120；另有 200 字硬上限（SOUL_STATE_MAX_CHARS）。 */
    soulStateMaxTokens: asInt(config.soulStateMaxTokens, DEFAULT_SOUL_STATE_TOKENS, 20, 400),
    /**
     * 2026-11-10 触发器注入（条件召回 v1）：只借世界书「条件注入」一个思路，不搬角色卡。
     * 默认 false —— 关着时 `agent/pre-step` 输出逐字节不变；不调模型、不多工具轮次。
     */
    triggerInjection: config.triggerInjection === true,
    /** 触发器清单路径；读不到/JSON 坏只写一条 trigger-warn，不抛。 */
    triggerPath: asText(config.triggerPath) || join(stateDir, 'triggers.json'),
    /** 每轮最多注入几条（夹 1–5）。 */
    triggerMaxEntries: asInt(config.triggerMaxEntries, 2, 1, 5),
    /** 每轮触发器正文预算（tok，夹 50–600）。 */
    triggerBudgetTokens: asInt(config.triggerBudgetTokens, 200, 50, 600),
    /** 同 session 同 id 的冷却分钟数（夹 0–1440；0 = 不冷却）。 */
    triggerCooldownMinutes: asInt(config.triggerCooldownMinutes, 120, 0, 1440),
    /**
     * 2026-11-11 v2：每轮关键记忆召回（经验层）。trigger 是规则层，recall 是经验层。
     * 默认 false —— 关着时 `agent/pre-step` 输出与 v1.2 逐字节一致。
     */
    autoRecall: config.autoRecall === true,
    /** trigger + recall 的合并预算池（tok）。先 trigger，余量给 recall；夹 100–1200。 */
    conditionalBudgetTokens: asInt(config.conditionalBudgetTokens, 350, 100, 1200),
    /** recall 单轮正文预算（tok，夹 80–400）；实际取 min(它, 合并池余量)。 */
    recallBudgetTokens: asInt(config.recallBudgetTokens, 180, 80, 400),
    /** 同 session 同记忆 id 的召回冷却分钟数（夹 0–1440；0 = 不冷却）。 */
    recallCooldownMinutes: asInt(config.recallCooldownMinutes, 60, 0, 1440),
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

