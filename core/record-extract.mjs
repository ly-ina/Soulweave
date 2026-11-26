// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * dsh-memprobe · 提取层（零宿主依赖，可单独 node 跑）
 *
 * 职责：从一段正文文本里找出「触发词行」，并判断这段文本在 UI 上
 * 会不会把触发词那行当摘要露出来。
 *
 * 三条规则来自 dsh 真实渲染代码，改之前先看 dsh-client-ui-chat/lib/client.js：
 *  - ReasoningRow.js:6130  firstLine()                         → 结束后摘要取全文第一行
 *  - ReasoningRow.js:6166  latestCompletedParagraphFirstLine() → 运行中摘要取最后一段首行
 *  - ReasoningRow.js:6137  段落分隔 = /\r?\n(?:[\t ]*\r?\n)+/
 */

export const DEFAULT_TRIGGER = '※记'

/**
 * 三种触发词，语义闭环：
 *   recall 记 —— 经验/事实，落 memories
 *   todo   办 —— 待办/承诺，必须能解析出日期，落 todos(due)
 *   settle 结 —— 结算：已完成或不再需要，把对应 pending 结掉
 */
export const DEFAULT_TRIGGERS = Object.freeze({ recall: '※记', todo: '※办', settle: '※结' })
export const TRIGGER_KINDS = Object.freeze(['recall', 'todo', 'settle'])

/**
 * 归一触发词配置。
 * - 传 `triggers` 对象：按 kind 取，缺的补默认；
 * - 只传 `trigger` 字符串：单触发词兼容模式，只有 recall 生效；
 * - 什么都不传：三词全开（记 / 办 / 结）。
 */
export function resolveTriggers(options = {}) {
  if (options && typeof options.triggers === 'object' && options.triggers !== null) {
    const out = {}
    for (const kind of TRIGGER_KINDS) {
      const value = options.triggers[kind]
      out[kind] = typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_TRIGGERS[kind]
    }
    return out
  }
  if (options && typeof options.trigger === 'string' && options.trigger.trim() !== '') {
    return { recall: options.trigger.trim(), todo: '', settle: '' }
  }
  return { ...DEFAULT_TRIGGERS }
}

/** 行首允许的 Markdown 装饰：空白、引用符、列表符。触发词必须从行首（允许装饰）开始。 */
// 2026-11-26：正文也能承载触发词了，所以「行首」收窄成只认空白。
// `> ※记` / `- ※记` / `* ※记` 一律不抓——那是引用/列表里在**讨论**格式，不是要记。
// 允许行首空白和列表符（`- ※记` / `* ※记` / `+ ※记`），
// 但 `> ※记`（引用）、反引号、缩进代码块一律不抓——那是引用/讨论，不是要记。
const LINE_PREFIX = '^[\\t ]*(?:[-*+][\\t ]+)?'

/** 与 UI 完全一致的段落分隔。 */
const PARA_SEP = /\r?\n(?:[\t ]*\r?\n)+/

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 成对包裹符：整段被它包住，说明是在**引用**这个词，不是要用它。 */
const QUOTE_PAIRS = Object.freeze([
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
  ['‘', '’'],
  ['《', '》'],
  ['（', '）'],
  ['【', '】'],
  ['(', ')'],
  ['[', ']'],
])

/** 整段是否被同一对引号/括号包住。 */
function isQuoted(text) {
  const s = String(text ?? '').trim()
  for (const [open, close] of QUOTE_PAIRS) {
    if (s.startsWith(open) && s.endsWith(close) && s.length > open.length + close.length) return true
  }
  return false
}

/**
 * 匹配一行里的触发词。
 *
 * 两道逃逸（防止「自我观察污染」——模型讨论这个词时写了它，又被自己抓走）：
 *   1. 行首 `\` 转义：`\※办：…` 表示我在说这个词，不是要用它；
 *   2. 整体被引号/括号包住：`※办「明天九点交材料」` 是引文，不是待办。
 * 另外行首是反引号（`` `※办：…` ``）本来就不匹配，因为 LINE_PREFIX 不认反引号。
 *
 * @param {string} line 单行文本
 * @param {string} trigger 触发词
 * @returns {string|null} 触发词之后的正文（已 trim）；不含/被转义/是引文返回 null；含但后面为空返回 ''
 */
export function matchTrigger(line, trigger = DEFAULT_TRIGGER) {
  if (typeof line !== 'string') return null
  if (/^[\s>*+-]*\\/.test(line)) return null
  const re = new RegExp(`${LINE_PREFIX}${escapeRegExp(trigger)}[ \\t]*[:：]?[ \\t]*(.*)$`)
  const m = re.exec(line)
  if (m === null) return null
  const body = m[1].trim()
  if (isQuoted(body)) return null
  return body
}

/**
 * 一行里的**所有**触发词，按出现位置切段（0.12.4）。
 *
 * 历史问题：0.12.3 及以前一行只认第一个触发词，后面的会被吞进前一条正文里——
 * `※办：明天交材料 ※记：别用裸文件名` 会变成一条 todo（正文含 `※记：…`），
 * 而「记」根本没录上。现在一行可以有任意多条，各自成段。
 *
 * 切分规则（可预测优先）：
 *  - 行首必须是某个触发词（允许前置空白 / 列表符），否则整行不算；
 *  - 行首之后的触发词必须**前面有空白**才算分隔，避免误切词内字符；
 *  - 每段各自判引文（`※办「明天九点交材料」` 仍不抓）；
 *  - 空段返回在 `empty` 里，由调用方记成「空触发」。
 *
 * @param {string} line 单行文本
 * @param {Record<string,string>} [triggers] kind → 触发词
 * @returns {{entries:Array<{kind:string,text:string}>, empty:string[]}}
 */
export function splitTriggers(line, triggers = DEFAULT_TRIGGERS) {
  if (typeof line !== 'string') return { entries: [], empty: [] }
  if (/^[\s>*+-]*\\/.test(line)) return { entries: [], empty: [] }
  const enabled = TRIGGER_KINDS.filter((kind) => triggers[kind])
  if (enabled.length === 0) return { entries: [], empty: [] }
  const words = enabled.map((kind) => ({ kind, word: triggers[kind] }))
  const alternation = words.map((w) => escapeRegExp(w.word)).join('|')

  const head = new RegExp(`^[\\t ]*(?:[-*+][\\t ]+)?(${alternation})[\\t ]*[:：]?[\\t ]*`)
  const m = head.exec(line)
  if (m === null) return { entries: [], empty: [] }

  const kindOf = (word) => (words.find((w) => w.word === word) || {}).kind
  const entries = []
  const empty = []
  const push = (kind, body) => {
    if (body === '') {
      if (kind) empty.push(kind)
      return
    }
    if (isQuoted(body)) return
    entries.push({ kind, text: body })
  }

  let kind = kindOf(m[1])
  let rest = line.slice(m[0].length)
  // `^` 让「上一段是空的」也能切出来（`※记： ※办：B` → 空 recall + todo）；
  // 其余位置仍要求前面有空白，避免把正文里的字符当分隔。
  const sep = new RegExp(`(?:^|[\\t ]+)(${alternation})[\\t ]*[:：]?[\\t ]*`, 'g')
  let last = 0
  let hit
  while ((hit = sep.exec(rest)) !== null) {
    push(kind, rest.slice(last, hit.index).trim())
    kind = kindOf(hit[1])
    last = hit.index + hit[0].length
  }
  push(kind, rest.slice(last).trim())

  return { entries, empty }
}

/** 全文第一行（结束后 UI 摘要使用的值）。 */
export function firstLine(text) {
  const s = String(text ?? '')
  const i = s.indexOf('\n')
  return i === -1 ? s : s.slice(0, i)
}

/** 最后一段的首行（运行中 UI 摘要使用的值）。 */
export function lastParagraphFirstLine(text) {
  const parts = String(text ?? '').split(PARA_SEP)
  const last = parts[parts.length - 1] ?? ''
  const i = last.indexOf('\n')
  return i === -1 ? last : last.slice(0, i)
}

/**
 * 从正文文本提取记录，并判定两种泄漏。
 *
 * live    = 运行中摘要（最后一段首行）就是触发词 → 会边想边漏
 * settled = 结束后摘要（全文第一行）就是触发词 → 想完仍挂在摘要上
 *
 * @param {string} text 正文全文（adapters 只传 text block，不传 reasoning）
 * @param {{trigger?:string}} [options]
 * @returns {{
 *   trigger:string, hit:boolean, records:Array<{text:string,lineIndex:number,raw:string}>,
 *   empty:number[], paragraphs:number, chars:number, lines:number,
 *   leak:{live:boolean, settled:boolean, headLive:string, headSettled:string}
 * }}
 */
export function extractRecords(text, options = {}) {
  const triggers = resolveTriggers(options)
  const enabled = TRIGGER_KINDS.filter((kind) => triggers[kind] !== '')
  const primary = triggers.recall || ''
  const src = typeof text === 'string' ? text : ''

  const lines = src.split('\n')
  const records = []
  const empty = []

  const emptyLines = new Set()
  for (let i = 0; i < lines.length; i++) {
    // 0.12.4：一行可以有多个触发词（`※办：A ※记：B` 拆成两条），不再只认第一个。
    const split = splitTriggers(lines[i], triggers)
    for (const entry of split.entries) {
      records.push({ kind: entry.kind, text: entry.text, lineIndex: i, raw: lines[i] })
    }
    for (const _kind of split.empty) emptyLines.add(i + 1) // 1-based，写给人看
  }
  for (const lineNo of emptyLines) empty.push(lineNo)

  const headLive = lastParagraphFirstLine(src)
  const headSettled = firstLine(src)
  const hitsAny = (line) => enabled.some((kind) => matchTrigger(line, triggers[kind]) !== null)

  const byKind = { recall: [], todo: [], settle: [] }
  for (const rec of records) byKind[rec.kind].push(rec)

  return {
    trigger: primary, // 兼容旧调用方：单触发词模式下就是它
    triggers,
    hit: records.length > 0 || empty.length > 0,
    records,
    byKind,
    empty,
    paragraphs: src.split(PARA_SEP).length,
    chars: src.length,
    lines: lines.length,
    leak: {
      live: hitsAny(headLive),
      settled: hitsAny(headSettled),
      headLive: headLive.slice(0, 80),
      headSettled: headSettled.slice(0, 80),
    },
  }
}
