// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/constants.mjs —— 魂引的固定常量与文案表（零宿主依赖）。
 *
 * 2026-11-19 解耦：从 index.js 原样搬出，逻辑未改。
 */

export const MESSAGE_KIND = 'soul'

/** soul.md 里插件只读的三节（§3.1）。 */
export const SOUL_SECTIONS = Object.freeze(['身份', '认知', '禁令', '外交'])

/** 旧节名兼容映射：v0.1.1 起渲染用通用名，旧文件仍可读。 */
export const SECTION_ALIASES = Object.freeze({
  身份: ['我是谁'],
  认知: ['我怎么想'],
  禁令: ['我不做什么'],
  外交: ['在群里'],
})

/** 唯一允许追加的一节；模板内容禁止写入（§9.10）。 */
export const FEEDBACK_SECTION = '反哺'

/** 旧名兼容。 */
export const FEEDBACK_ALIASES = Object.freeze(['反哺记录'])

/**
 * 魂引配置可设的最高值（§5，2026-11-09 放宽）。
 *
 * 以前这里是 1100 的硬上限：超了直接夹住，使用者连「我想多花点」都表达不出来。
 * 现在它只是数值上界（防手滑填 1e9），真正的成本提示交给 `soulWarnTokens`。
 */
export const SOUL_TOKEN_CEILING = 8000

/** 警示线默认值：魂引渲染超过它就写一条 soul-warn，不降档、不夹。 */
export const DEFAULT_SOUL_WARN_TOKENS = 1100

/** 旧名兼容：曾经是硬上限，现在是 `SOUL_TOKEN_CEILING` 的别名。 */
export const HARD_SOUL_TOKENS = SOUL_TOKEN_CEILING

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
 * 原因：【怎么查】按要求加了「能力：soul_capabilities(query)」一行（≈20 tok，不是 12），
 * 真实 soul.md 渲染从 183 → 203 tok；200 的上限会让渲染器降档到 `short-hints`，
 * 那一档只有一行提示，**新加的能力行会被静默丢掉**。220 留出余量，档位回到 `full`。
 *
 * 2026-11-09 由 220 改成 1000：默认值就该是一般人够用的量，不是「先给 220 再让人自己调」。
 * 1000 仍在默认警示线 1100 之下；真到 1100 以上由 `soulWarnTokens` 报成本。
 */
export const DEFAULT_SOUL_TOKENS = 1000

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
  // 2026-11-11 v2：每轮关键记忆召回单列一类，预算让步时最后才砍它。
  Object.freeze({ id: 'soul-recall', label: '记忆召回', kinds: Object.freeze(['soul-recall']) }),
])

/**
 * 让步顺序（§5）：先砍封存目录，再砍分区目录，**最后**才砍记忆召回；
 * 魂引核心、动态段与时间行永不砍（v2 起 recall 排在链尾）。
 */
export const YIELD_ORDER = Object.freeze(['archive', 'partition', 'soul-recall'])

/** 「怎么查」三条入口（§1）。固定文案，不随轮次变化。 */
export const HINTS = Object.freeze([
  // 压成一行：省约 25 tok/轮；三个工具名仍然齐全，够我认路
  'soul_recall(query) 查记忆/封存/笔记/原文库；单独用 memory_search / archive_search',
  // 三期 C：能力入口（约 12 tok）。带 query 会按「最近 2 条 user 消息」自动取词，给 3–5 个工具名。
  '能力：soul_capabilities(query)',
  // 十二期：关系层 / 情绪（正文不常驻，只给入口；约 10 tok）
  '关系层 soul_relations() · 情绪 soul_mood()',
])

/** 稳定版魂引默认预算（原 index.js:438）。 */
export const DEFAULT_SOUL_STABLE_TOKENS = 900

/** 魂引状态行：字数上限（原 index.js:437）。 */
export const SOUL_STATE_MAX_CHARS = 200
/** 魂引状态行：默认 token 预算（原 index.js:438）。 */
export const DEFAULT_SOUL_STATE_TOKENS = 120

export const MEMORY_SECTION = Object.freeze({
  title: '【记忆】',
  pinnedMaxTokens: 100,
  pointer: '查：soul_recall · memory_search · archive_search · soul_capabilities · soul_relations()',
})

/**
 * 路由层只保留「安全规则」两条（伊纳 2026-11-04 拍板）：改文件前读规则、争论先取证。
 * 工具发现不在这里——它在【记忆】尾部那一行。其余路由行照旧留在 router.md 里，只是不注入。
 */
const ROUTER_SAFETY = /verification\.md|先取证/

/** 三节每条最多注入几条（2026-10-28 起超出的不再静默丢，会在 soul.log 记一行 warn）。 */
export const SOUL_SECTION_CAP = 8

export { ROUTER_SAFETY }

export const ALIAS_TO_STANDARD = Object.freeze({
  ...Object.fromEntries(Object.entries(SECTION_ALIASES).flatMap(([std, list]) => list.map((a) => [a, std]))),
  ...Object.fromEntries(FEEDBACK_ALIASES.map((a) => [a, FEEDBACK_SECTION])),
})
