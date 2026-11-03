/**
 * 十期：存量魂引 / 记忆快照瘦身（surface replace —— **只遮不删**，日志原文一条不动）
 *
 * 依据全部来自 app.asar 抽取件，行号见回执：
 *   `@deepseek-ai/dsh-session/lib/index.js`
 *     :364-375 `replacementRange` —— 按**当前 surface 节点**定位 startSeq/endSeq
 *     :466       `nodes.splice(startIdx, 长, event.seq)` —— 整段区间折叠成「替换事件」这一个节点
 *     :359       startSeq / endSeq 必须指向**更早**的事件
 *     :360/:447  `sourceEventSeqs` 必须覆盖到区间里全部被遮的 seq
 *     :419-423   node 0 若是 system/message，只能由 system/message 单节点替换（我们的候选永远不是 node 0）
 *   `@deepseek-ai/dsh-context-trim/index.js:106-110` —— 现网 replace 的真实写法（同类型事件 + surfaceOp + sourceEventSeqs）
 *
 * 为什么需要它：魂引 / 记忆快照是 `user/message` 节点，注入一次就永久留在历史里、之后每轮重发。
 * 二期 B 只压增量，存量还在（`hist` 0/3/33 那种）。本模块把**旧快照节点遮掉**，模型视图只留最新一条。
 *
 * 安全边界：默认 dry-run；apply 必须 confirm + 先整文件备份 + 写完立刻自检（不通过就自动还原）。
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

/** zstd 帧魔数：会话日志是「多帧拼接」，只按魔数切帧逐段解，普通解压只出第一帧。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 魂引节点开头的字面量。 */
export const SOUL_HEAD = '【魂引 · 人格】'
/** 记忆快照节点开头的字面量。 */
export const MEMORY_HEAD = '===== 长期记忆 ====='
/** 替换事件自己写进 `source.kind`，跟魂引 / meow 快照区分开（别让预算统计把它当注入）。 */
export const FOLD_KIND = 'soul-surface-fold'
/** 替换桩的正文前缀（十期重做：桩已经进了日志的，也要进下一次折叠的候选）。 */
export const STUB_HEAD = '【已折叠】'

/** 与 index.js 的 estimateTokens 同口径（CJK 1 tok/字，其它 0.34），不引 index.js 以免 CLI 拉起整插件。 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  const cjk = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/
  let units = 0
  for (const ch of text) units += cjk.test(ch) ? 1 : 0.34
  return Math.ceil(units)
}

/** 解整份会话日志（多帧 zstd）。坏帧留空，但会记进 `badFrames` 方便报错。 */
export function decodeSessionLog(file) {
  const buf = readFileSync(file)
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i)
    }
  }
  const chunks = []
  let badFrames = 0
  for (let i = 0; i < offsets.length; i += 1) {
    const slice = buf.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : buf.length)
    try {
      chunks.push(zstdDecompressSync(slice))
    } catch {
      badFrames += 1
    }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  const events = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { file, bytes: buf.length, frames: offsets.length, badFrames, badLines, events, text }
}

/** 事件正文（user/message 的 content 数组拼起来）。 */
export function textOf(event) {
  const parts = event?.data?.content
  if (!Array.isArray(parts)) return ''
  return parts.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
}

/** 快照种类：'soul'（魂引）/ 'memory'（记忆快照）/ 'stub'（本工具写的替换桩）/ null（不归我们管）。 */
export function snapshotKindOf(event) {
  if (event?.type !== 'user/message') return null
  const text = textOf(event)
  if (text.startsWith(SOUL_HEAD)) return 'soul'
  if (text.startsWith(MEMORY_HEAD)) return 'memory'
  if (text.startsWith(STUB_HEAD)) return 'stub'
  return null
}

/** 能进模型视图（surface）的事件类型——照 `dsh-session:157-163`，别的类型没有 surfaceOp 是正常的。 */
export const SURFACE_EVENT_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * 复算 surface：只做节点数学（与 dsh-session `applySurfacePlan` 同构）。
 * @returns {{nodes:number[], replacements:Array, problems:string[]}}
 */
export function foldSurface(events) {
  const nodes = []
  const replacements = []
  const problems = []
  let extraSources = 0
  let expected = null
  for (const event of events) {
    if (typeof event.seq !== 'number') continue
    if (expected !== null && event.seq !== expected) {
      problems.push(`seq 不连续：${event.seq}（期望 ${expected}）`)
    }
    expected = event.seq + 1
    if (!SURFACE_EVENT_TYPES.has(event.type)) continue
    const op = event.surfaceOp
    if (op === undefined) {
      problems.push(`seq ${event.seq}(${event.type}) 是 surface 类型却没有 surfaceOp`)
      continue
    }
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') {
      problems.push(`seq ${event.seq} 的 surfaceOp 非法`)
      continue
    }
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
      problems.push(`seq ${event.seq} 的 replace 目标不在当前 surface（${op.startSeq}..${op.endSeq}）`)
      continue
    }
    const shadowed = nodes.slice(startIdx, endIdx + 1)
    const declared = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    const missing = shadowed.filter((seq) => !declared.includes(seq))
    if (missing.length > 0) problems.push(`seq ${event.seq} 的 sourceEventSeqs 漏了 ${missing.length} 条：${missing.slice(0, 3).join(',')}`)
    // 多报不算错：`dsh-session:330-331` 只要求「覆盖所有被遮节点」，允许多列（DSH 自己的压缩会列到已被更早 replace 遮掉的 seq）。
    const extra = declared.filter((seq) => !shadowed.includes(seq))
    extraSources += extra.length
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq, shadowed })
  }
  return { nodes, replacements, problems, extraSources }
}

/** 每个事件属于第几个 turn（`turn/start` 计数）。 */
export function turnIndexMap(events) {
  const map = new Map()
  let turn = 0
  let openTurn = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn += 1
      openTurn = true
    }
    if (event.type === 'turn/end') openTurn = false
    if (typeof event.seq === 'number') map.set(event.seq, turn)
  }
  const last = events.filter((event) => event.type === 'turn/start').length
  const open = openTurn
  return { map, lastTurn: last, lastTurnOpen: open }
}

/**
 * 谓词（§1）：`user/message` + 以魂引/长期记忆开头 + 不是该会话里**同类**最新一条 + 不在最近 1 个 turn 内。
 * @returns {{rows:Array, keep:Array, ranges:Array, notes:string[]}}
 */
export function planSurfaceReplace(events, { excludeLastTurn = 'auto', now = Date.now() } = {}) {
  const fold = foldSurface(events)
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const surface = fold.nodes.map((seq) => bySeq.get(seq)).filter(Boolean)
  const turns = turnIndexMap(events)
  const notes = []

  const candidates = []
  for (let index = 0; index < surface.length; index += 1) {
    const event = surface[index]
    const kind = snapshotKindOf(event)
    if (!kind) continue
    candidates.push({ index, seq: event.seq, kind, chars: textOf(event).length, tokens: estimateTokens(textOf(event)), turn: turns.map.get(event.seq) ?? 0 })
  }

  // 「最新一条同类节点」永远保留（魂引、记忆各自算一条）。
  const latest = {}
  for (const row of candidates) latest[row.kind] = row
  const keep = Object.values(latest)

  // 「最近 1 个 turn 内不算」：auto = 只有该 turn 还没结束时才排除（已结束的 turn 没有在跑的步骤）。
  const excludeLatest = excludeLastTurn === 'auto' ? turns.lastTurnOpen : excludeLastTurn === true
  if (excludeLastTurn === 'auto') {
    notes.push(
      turns.lastTurnOpen
        ? `最后 1 个 turn（第 ${turns.lastTurn} 个）还没结束，按 §1 第 3 条整个排除`
        : `最后 1 个 turn（第 ${turns.lastTurn} 个）已结束、无在跑步骤，按「不打架」本意未排除（可用 --exclude-last-turn 走字面规则）`,
    )
  }

  const maskable = candidates.filter((row) => {
    if (keep.some((item) => item.seq === row.seq)) return false
    if (excludeLatest && row.turn >= turns.lastTurn) return false
    return true
  })

  // 连续区间：相邻候选之间若隔着任何非候选节点，就断开（不许跨过去）。
  const ranges = []
  for (const row of maskable) {
    const last = ranges[ranges.length - 1]
    const prev = last?.rows[last.rows.length - 1]
    if (last && prev && row.index === prev.index + 1) last.rows.push(row)
    else ranges.push({ rows: [row] })
  }
  for (const range of ranges) {
    range.startSeq = range.rows[0].seq
    range.endSeq = range.rows[range.rows.length - 1].seq
    range.startIndex = range.rows[0].index
    range.endIndex = range.rows[range.rows.length - 1].index
    range.tokens = range.rows.reduce((sum, row) => sum + row.tokens, 0)
    range.chars = range.rows.reduce((sum, row) => sum + row.chars, 0)
    // 区间内 100% 同谓词：靠「相邻」定义已经保证，这里再核一遍并给检查行用。
    const inside = surface.slice(range.startIndex, range.endIndex + 1)
    range.pure = inside.every((event) => snapshotKindOf(event) !== null)
    range.stub = foldStubText(range)
    range.stubTokens = estimateTokens(range.stub)
  }

  // 切点配对：每个区间「开始前」「结束后」两个切点都必须 balanced（= toolPairingBalancedBefore/After）。
  const pair = toolPairingBalanced(fold.nodes, bySeq)
  const rangeChecks = ranges.map((range) => ({
    startSeq: range.startSeq,
    endSeq: range.endSeq,
    before: pair.cuts[range.startIndex] === true,
    after: pair.cuts[range.endIndex + 1] === true,
  }))
  const savedTokens = maskable.reduce((sum, row) => sum + row.tokens, 0)
  const stubTokens = ranges.reduce((sum, range) => sum + range.stubTokens, 0)

  return {
    ok: fold.problems.length === 0,
    problems: fold.problems,
    notes,
    events,
    surfaceSize: surface.length,
    candidates,
    keep,
    ranges,
    rangeChecks,
    pairingOk: rangeChecks.every((check) => check.before && check.after),
    tailBalanced: pair.balanced,
    maskable,
    tokensBefore: surface.reduce((sum, event) => sum + estimateTokens(textOf(event)), 0),
    tokensSaved: savedTokens,
    stubTokens,
    tokensNet: savedTokens - stubTokens,
    turns,
  }
}

/** 替换事件的正文：短、真话、别长得像一次注入（一条约 12 tok，别把省下的又贴回去）。 */
export function foldStubText(range) {
  return `【已折叠】此处原有 ${range.rows.length} 条旧魂引/记忆快照（seq ${range.startSeq}–${range.endSeq}），原文在会话日志；需要旧内容用 memory_search / soul_recall。`
}

/** 按 surface 顺序算「每个切点处工具调用是否配对」——与 dsh-compaction `toolPairingBalancedBefore/After` 同规则。 */
export function toolPairingBalanced(nodes, bySeq) {
  let open = 0
  // cuts[i] = 第 i 个节点之前的切点是否配对；cuts[nodes.length] = 尾部切点。
  const cuts = [true]
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    if (event?.type === 'assistant/message') {
      const calls = Array.isArray(event.data?.message?.content)
        ? event.data.message.content.filter((block) => block?.type === 'tool-call').length
        : 0
      open += calls
    } else if (event?.type === 'tool/result') {
      open -= 1
      if (open < 0) return { balanced: false, cuts, reason: `seq ${seq} 的 tool/result 没有对应 tool-call` }
    }
    cuts.push(open === 0)
  }
  return { balanced: open === 0, cuts, open }
}

/** dry-run 文本（§2 T1 的版式）。 */
export function renderSurfacePlan(plan, { limit = 40, session = '' } = {}) {
  if (!plan?.ok) return `【soul_surface】读日志失败：${plan?.problems?.join('；') || '未知错误'}`
  const bySeq = new Map(plan.events.map((event) => [event.seq, event]))
  const lines = []
  const keepText = plan.keep.map((row) => `${row.kind === 'soul' ? '魂引' : '记忆'} seq ${row.seq}`).join('、')
  lines.push(
    `${session || '会话'}  候选快照 ${plan.candidates.length} 条，拟遮 ${plan.maskable.length} 条（保留最新：${keepText || '无'}）`,
  )
  for (const row of plan.maskable.slice(0, limit)) {
    const event = bySeq.get(row.seq)
    const text = textOf(event).replace(/\s+/g, ' ')
    lines.push(`seq ${String(row.seq).padEnd(6)}  ${text.slice(0, 40)}  ~${row.tokens} tok`)
  }
  if (plan.maskable.length > limit) lines.push(`……另 ${plan.maskable.length - limit} 条`)
  lines.push(
    `合计可省 ≈ ${plan.tokensNet.toLocaleString('en-US')} tok/轮（遮掉 ${plan.tokensSaved.toLocaleString('en-US')}，替换桩回填 ${plan.stubTokens.toLocaleString('en-US')}；surface 现 ${plan.surfaceSize} 条 / ${plan.tokensBefore.toLocaleString('en-US')} tok）`,
  )
  for (const note of plan.notes) lines.push(`注：${note}`)
  lines.push(`范围检查：${plan.ranges.length} 段连续区间，区间内 100% 是同谓词节点 ${plan.ranges.every((range) => range.pure) ? '✓' : '✗'}`)
  const segText = plan.ranges.map((range) => `${range.startSeq}–${range.endSeq}(${range.rows.length} 条)`)
  lines.push(`各段：${segText.slice(0, 8).join(' ')}${segText.length > 8 ? ` …共 ${segText.length} 段` : ''}`)
  lines.push(
    `tool 配对检查：${plan.pairingOk ? 'balanced ✓' : `不平衡 ✗（${plan.rangeChecks.filter((check) => !check.before || !check.after).length} 个切点）`}${plan.tailBalanced ? '' : '（尾部本就有未闭合 tool-call，与本次无关）'}`,
  )
  return lines.join('\n')
}

/**
 * ⚠️ 只给自测/离线副本用：**直接往 .zstd 追加**，宿主认不认没有保证（十期已证实不能用它动真实会话）。
 * 真实会话一律走 `applyViaSession`（会话 API）。CLI 已禁用 `--apply`。
 * 写入：整文件备份 → 每段追加一条 replace 事件 → 重读自检（不通过自动还原备份）。
 * @returns {{ok:boolean, backup?:string, appended?:Array, verify?:object, error?:string}}
 */
export function applySurfaceReplace(file, plan, { confirm = false, now = Date.now(), quietMs = 120_000 } = {}) {
  if (confirm !== true) return { ok: false, error: 'apply 需要 confirm:true' }
  if (!plan?.ok) return { ok: false, error: `计划无效：${plan?.problems?.join('；') || '未知'}` }
  if (plan.ranges.length === 0) return { ok: false, error: '没有可遮的区间（候选为空或只剩最新一条）' }
  if (!existsSync(file)) return { ok: false, error: `会话日志不存在：${file}` }
  const age = Date.now() - statSync(file).mtimeMs
  if (age < quietMs) return { ok: false, error: `日志 ${Math.round(age / 1000)}s 前还在写（<${quietMs / 1000}s），疑似会话正在运行，拒绝写入` }

  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, '')
  const backup = `${file}.bak-surface-${stamp}`
  copyFileSync(file, backup)

  const decoded = decodeSessionLog(file)
  const events = decoded.events
  const lastSeq = events.reduce((max, event) => (typeof event.seq === 'number' ? Math.max(max, event.seq) : max), -1)
  const appended = []
  try {
    let next = lastSeq + 1
    const frames = []
    for (const range of plan.ranges) {
      const event = {
        type: 'user/message',
        seq: next,
        time: now,
        data: {
          content: [{ type: 'text', text: foldStubText(range) }],
          source: { kind: FOLD_KIND },
          role: 'user',
          id: randomUUID(),
        },
        surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
        sourceEventSeqs: range.rows.map((row) => row.seq),
      }
      frames.push(zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')))
      appended.push({ seq: event.seq, startSeq: range.startSeq, endSeq: range.endSeq, shadowed: event.sourceEventSeqs.length })
      next += 1
    }
    appendFileSync(file, Buffer.concat(frames))
    const verify = verifySurfaceAfter(file, {
      shadowedSeqs: plan.maskable.map((row) => row.seq),
      before: decoded.events.length,
      baseTokens: plan.tokensBefore,
      checkSeqs: appended.map((item) => item.seq),
    })
    if (!verify.ok) {
      copyFileSync(backup, file)
      return { ok: false, backup, appended, verify, error: `自检失败，已用备份还原：${verify.problems.join('；')}` }
    }
    return { ok: true, backup, appended, verify }
  } catch (error) {
    copyFileSync(backup, file)
    return { ok: false, backup, appended, error: `写入异常，已用备份还原：${String(error?.message ?? error)}` }
  }
}

/** 写后自检：seq 连续、fold 无 problem、被遮 seq 已不在 surface、原文仍可按 seq 找到、**本次追加的**替换节点前后切点配对。 */
export function verifySurfaceAfter(file, { shadowedSeqs = [], before = null, baseTokens = null, checkSeqs = [] } = {}) {
  const decoded = decodeSessionLog(file)
  const fold = foldSurface(decoded.events)
  const problems = [...fold.problems]
  const bySeq = new Map(decoded.events.map((event) => [event.seq, event]))
  const onSurface = new Set(fold.nodes)
  const stillOn = shadowedSeqs.filter((seq) => onSurface.has(seq))
  if (stillOn.length > 0) problems.push(`仍有 ${stillOn.length} 条被遮节点留在 surface：${stillOn.slice(0, 5).join(',')}`)
  const lost = shadowedSeqs.filter((seq) => !bySeq.has(seq))
  if (lost.length > 0) problems.push(`日志里找不到 ${lost.length} 条原文（不该发生）：${lost.slice(0, 5).join(',')}`)
  const pair = toolPairingBalanced(fold.nodes, bySeq)
  const cuts = pair.cuts ?? []
  const unbalanced = []
  // 只检查本次追加的替换：库里本来就有 DSH 自己写的 replace（context-trim / 压缩 checkpoint），
  // 那些切点的平衡是它们自己的事，不该让我们 apply 失败。
  const mine = new Set(checkSeqs)
  for (const replacement of fold.replacements) {
    if (mine.size > 0 && !mine.has(replacement.seq)) continue
    const index = fold.nodes.indexOf(replacement.seq)
    if (index === -1) {
      unbalanced.push(`replace seq ${replacement.seq} 不在 surface`)
      continue
    }
    if (cuts[index] !== true || cuts[index + 1] !== true) unbalanced.push(`replace seq ${replacement.seq} 的切点不配对`)
  }
  if (unbalanced.length > 0) problems.push(`tool 配对不平衡：${unbalanced.slice(0, 5).join('；')}`)
  const surfaceTokens = fold.nodes.reduce((sum, seq) => sum + estimateTokens(textOf(bySeq.get(seq))), 0)
  return {
    ok: problems.length === 0,
    problems,
    events: decoded.events.length,
    eventsBefore: before,
    surface: fold.nodes.length,
    replacements: fold.replacements.length,
    surfaceTokens,
    tokensBefore: baseTokens,
    pairing: unbalanced.length === 0,
    unbalanced,
    tailBalanced: pair.balanced,
  }
}

// ---------------------------------------------------------------------------
// 十期重做：走**会话 API**（`session.append`），不再直接改 .zstd。
// 判据换成宿主自己的 `session.surface`——它不认，就等于白写。
// ---------------------------------------------------------------------------

/** 宿主当前 surface 的实况：节点数、魂引/记忆/桩各几条、token 估算。 */
export function surfaceStatsOf(session) {
  const nodes = [...((session?.surface?.nodes) ?? [])]
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : (session?.log ?? [])
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const stats = { nodes: nodes.length, soul: 0, memory: 0, stub: 0, tokens: 0 }
  for (const seq of nodes) {
    const event = bySeq.get(seq)
    const kind = snapshotKindOf(event)
    if (kind) stats[kind] += 1
    stats.tokens += estimateTokens(textOf(event))
  }
  return stats
}

/**
 * 通过会话 API 写替换事件，并用宿主 surface 复核（十期重做的唯一判据）。
 * @returns {{ok:boolean, error?:string, before?:object, after?:object, appended?:Array, stillOn?:number[], problems:string[]}}
 */
export function applyViaSession(session, plan, { confirm = false, now = Date.now() } = {}) {
  const problems = []
  if (confirm !== true) return { ok: false, error: 'apply 需要 confirm:true', problems }
  if (!plan?.ok) return { ok: false, error: `计划无效：${plan?.problems?.join('；') || '未知'}`, problems }
  if (!session || typeof session.append !== 'function') return { ok: false, error: '拿不到活的会话对象（只有本进程里已加载的会话能通过 API 动）', problems }
  if (!plan.ranges.length) return { ok: false, error: '没有可遮的区间', problems }

  const before = surfaceStatsOf(session)
  const appended = []
  try {
    for (const range of plan.ranges) {
      const event = session.append(
        'user/message',
        {
          content: [{ type: 'text', text: foldStubText(range) }],
          source: { kind: FOLD_KIND },
          role: 'user',
          id: randomUUID(),
        },
        {
          surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
          sourceEventSeqs: range.rows.map((row) => row.seq),
        },
      )
      appended.push({ seq: event.seq, startSeq: range.startSeq, endSeq: range.endSeq, shadowed: range.rows.length })
    }
  } catch (error) {
    return { ok: false, error: `append 被宿主拒绝：${String(error?.message ?? error)}`, before, appended, problems }
  }

  const after = surfaceStatsOf(session)
  const onSurface = new Set([...((session?.surface?.nodes) ?? [])])
  const stillOn = plan.maskable.map((row) => row.seq).filter((seq) => onSurface.has(seq))
  if (stillOn.length > 0) problems.push(`宿主 surface 里还剩 ${stillOn.length} 条被遮节点（${stillOn.slice(0, 5).join(',')}）——说明它没吃这次 replace`)
  if (after.tokens >= before.tokens) problems.push(`surface tok 没降：${before.tokens} → ${after.tokens}`)
  return { ok: problems.length === 0, before, after, appended, stillOn, problems }
}

/** `soul_surface` 的参数/结果 schema（执行体在 index.js，因为要拿 ctx.sessions）。 */
export const SURFACE_TOOL = Object.freeze({
  name: 'soul_surface',
  description:
    '十期：把旧的魂引 / 记忆快照从**模型视图**里遮掉（surface replace，只遮不删，日志原文一条不动）。必须走会话 API，判据是宿主自己的 `session.surface`。mode=preview 只读看数字；mode=apply 需要 confirm:true，逐段 append 替换事件并复核「旧节点是否真的离开 surface」。只处理本进程里活着的会话（拿不到会话对象就报错），一次只动一个会话。',
  parameters: {
    type: 'object',
    properties: {
      mode: { type: 'string', description: 'preview（默认，只读）| apply（需 confirm:true）' },
      sessionId: { type: 'string', description: '目标会话 id；不传则列出本进程里活着的会话' },
      confirm: { type: 'boolean', description: 'apply 必须显式 true' },
      limit: { type: 'number', description: 'dry-run 逐条最多打几条，默认 20' },
    },
    additionalProperties: false,
  },
  result: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      mode: { type: 'string' },
      text: { type: 'string' },
      appended: { type: 'number' },
      before: { type: 'number' },
      after: { type: 'number' },
    },
    required: ['ok', 'text'],
    additionalProperties: false,
  },
})

export default {
  SOUL_HEAD,
  MEMORY_HEAD,
  STUB_HEAD,
  FOLD_KIND,
  SURFACE_TOOL,
  estimateTokens,
  decodeSessionLog,
  textOf,
  snapshotKindOf,
  foldSurface,
  turnIndexMap,
  planSurfaceReplace,
  foldStubText,
  toolPairingBalanced,
  renderSurfacePlan,
  applySurfaceReplace,
  verifySurfaceAfter,
  surfaceStatsOf,
  applyViaSession,
}

// ---------------------------------------------------------------------------
// CLI：默认 dry-run。`node surface.mjs --session <id|目录|文件> [--apply --confirm]`
// ---------------------------------------------------------------------------
function userFileExists(path) {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/** 会话根目录：`<DSH_HOME>/sessions`。 */
export function dsSessionsRoot() {
  const home = process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'sessions')
}

/** 在 `<sessions>/<工作区>/<会话 id>/session.v4.jsonl.zstd` 里找会话（支持只给 id）。 */
export function findSessionLog(target) {
  if (userFileExists(target) && target.endsWith('.zstd')) return target
  if (userFileExists(target) && !target.endsWith('.zstd')) {
    const inner = join(target, 'session.v4.jsonl.zstd')
    if (userFileExists(inner)) return inner
  }
  const root = dsSessionsRoot()
  try {
    for (const workspace of readdirSync(root)) {
      const candidate = join(root, workspace, target, 'session.v4.jsonl.zstd')
      if (userFileExists(candidate)) return candidate
    }
  } catch {
    /* 没有会话根目录就当找不到 */
  }
  return ''
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const argv = process.argv.slice(2)
  const argOf = (name, fallback = null) => {
    const at = argv.indexOf(`--${name}`)
    return at === -1 ? fallback : argv[at + 1]
  }
  const has = (name) => argv.includes(`--${name}`)
  const target = argOf('session')
  if (!target) {
    console.log('用法：node surface.mjs --session <会话 id | 会话目录 | session.v4.jsonl.zstd> [--apply --confirm] [--exclude-last-turn] [--force] [--limit N]')
    process.exit(2)
  }
  const file = findSessionLog(target)
  if (!file) {
    console.error(`找不到会话日志：${target}`)
    process.exit(2)
  }
  const decoded = decodeSessionLog(file)
  const plan = planSurfaceReplace(decoded.events, {
    excludeLastTurn: has('exclude-last-turn') ? true : 'auto',
  })
  const limit = Number(argOf('limit', 40)) || 40
  console.log(renderSurfacePlan(plan, { limit, session: basename(dirname(file)) }))
  // 十期重做：**不再提供改 .zstd 的写入**。宿主认不认没有保证，写下去就是给会话塞垃圾。
  if (has('apply')) {
    console.error('\n【已禁用】CLI 不再写盘：写入必须走会话 API —— 在 DSH 里用工具 `soul_surface`（preview 先看，apply + confirm 才写）。')
    process.exit(3)
  }
  process.exit(plan.ok ? 0 : 1)
}
