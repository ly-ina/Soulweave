// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * 2026-11-21 v0.4.2：从 DSH prestep 的 payload.messages 里提取「最近一次工具调用」。
 * 只读、纯函数，不依赖宿主。
 *
 * 兼容三种形态（DSH 事件编码与落盘编码都见过）：
 *   A. content 是数组：[{ type: 'tool-call', name, input }]
 *   B. content 是对象：{ type: 'tool-call', name, input }
 *   C. content 是字符串：'{"contentType":"tool-call","toolName":"ps",...}'
 * 返回 { tool, input, path } 或 null。path 只是 input 里常见路径字段的便捷值。
 */

const PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'file']
const TOOL_KINDS = new Set(['tool-call', 'tool_use', 'function_call'])

function asText(value) {
  return typeof value === 'string' ? value : ''
}

function pickInput(part) {
  for (const key of ['input', 'args', 'arguments', 'parameters']) {
    const value = part?.[key]
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  }
  return null
}

function fromPart(part) {
  if (!part || typeof part !== 'object') return null
  if (!TOOL_KINDS.has(asText(part.type))) return null
  const tool = asText(part.name) || asText(part.toolName) || asText(part.tool)
  if (!tool) return null
  return { tool, input: pickInput(part) }
}

function fromText(text) {
  const raw = asText(text)
  if (!raw || !raw.includes('tool')) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const kind = asText(parsed.contentType) || asText(parsed.type)
  if (!TOOL_KINDS.has(kind)) return null
  const tool = asText(parsed.toolName) || asText(parsed.name)
  if (!tool) return null
  return { tool, input: pickInput(parsed) }
}

function pathOf(input) {
  if (!input || typeof input !== 'object') return ''
  for (const key of PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) return value[0]
  }
  return ''
}

/**
 * 2026-11-21 v0.4.2 修：从 DSH 的 session 事件里取工具调用。
 * 真实形状（已从 session.v4.jsonl.zstd 取证）：
 *   {"type":"tool/call","data":{"turn":4990,"step":3,"callId":"…","name":"ps","arguments":"{\\"script\\":…}"}}
 * 注意 arguments 是 JSON 字符串，不是对象。
 */
function fromEvent(event) {
  if (!event || typeof event !== 'object') return null
  const kind = asText(event.type) || asText(event.kind)
  if (kind !== 'tool/call' && kind !== 'tool-call' && kind !== 'tool_use') return null
  const data = event.data && typeof event.data === 'object' ? event.data : event
  const tool = asText(data.name) || asText(data.toolName) || asText(data.tool)
  if (!tool) return null
  let input = null
  const raw = data.arguments ?? data.args ?? data.input
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    input = raw
  } else if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed
    } catch { /* 参数不是合法 JSON 就当没有 */ }
  }
  return { tool, input }
}
/** 先看 events（最可靠），再回落到 messages。都找不到返回 null。 */
export function pickLastToolCall(messages, events) {
  if (Array.isArray(events)) {
    // 2026-11-21 修：原来只扫尾部 12 条，实测不够 —— DSH 把一次 assistant 回复拆成很多事件，
    // 上一轮的工具调用常落在 12 条之外。全量倒序找，找到即停（数组下标访问，成本可忽略）。
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const found = fromEvent(events[index])
      if (found) return { ...found, path: pathOf(found.input) }
    }
  }
  if (!Array.isArray(messages)) return null
  const tail = messages.slice(-8)
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index]
    if (!message || typeof message !== 'object') continue
    if (asText(message?.source?.kind).startsWith('soul')) continue
    const content = message.content
    let found = null
    if (Array.isArray(content)) {
      for (let i = content.length - 1; i >= 0 && !found; i -= 1) found = fromPart(content[i])
    } else if (content && typeof content === 'object') {
      found = fromPart(content)
    } else if (typeof content === 'string') {
      found = fromText(content)
    }
    if (found) return { ...found, path: pathOf(found.input) }
  }
  return null
}
