// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * memory/scene.mjs —— scene 提取器（SPEC-V2 §1）。
 *
 * 纯函数 + 一个无 IO 的 tracker：不碰数据库、不读环境变量。
 * 输入是 DSH 的 `session/event`（真实形状已取证：
 *   {"type":"tool/call","data":{"turn":4990,"step":3,"callId":"…","name":"ps","arguments":"{…}"}}
 * ），输出是这条事件对应的情景坐标。
 *
 * 设计口径：
 *  - `pathPattern` 只存工作区相对路径或末两级，绝不存完整用户目录；
 *  - `toolMsWindow` / `toolCount` 是**估算**：真实事件只有单时间戳，
 *    用相邻 tool/call 的间隔近似单次耗时，标为 estimate 而不是真值；
 *  - 时间窗按本地时区。
 */

const INTIMACY_WORDS = [
  '爱你', '喜欢', '想你', '亲亲', '抱抱', '抱', '亲', '摸', '揉', '涩涩', '宝宝',
  '纳', '小汐', '乖', '想你', '心跳', '脸红', '睡', '梦', '软', '暖',
]

const TOOL_PATH_KEYS = ['path', 'file_path', 'filePath', 'target', 'file', 'cwd']

/** 本地时区的时间窗。 */
export function timeWindowOf(ts) {
  const hour = new Date(Number(ts) || Date.now()).getHours()
  if (hour >= 5 && hour < 11) return 'morning'
  if (hour >= 11 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 22) return 'evening'
  return 'night'
}

/** 亲密词命中强度 0..1（出现次数越多越高，封顶 1）。 */
export function intimacyOf(text) {
  const s = String(text || '')
  if (!s) return 0
  let hits = 0
  for (const word of INTIMACY_WORDS) {
    let i = s.indexOf(word)
    while (i !== -1) { hits += 1; i = s.indexOf(word, i + word.length) }
  }
  return Math.min(1, hits / 4)
}

function splitPath(value) {
  return String(value || '').replace(/\\/g, '/').split('/').filter(Boolean)
}

/**
 * 只保留「工作区相对路径」或「末两级」。完整用户目录不外泄。
 * 非路径工具（ps / web 等）返回 ''。
 */
export function pathPatternOf(inputPath, cwd) {
  const raw = String(inputPath || '').trim()
  if (!raw) return ''
  const norm = raw.replace(/\\/g, '/')
  const base = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (base && norm.toLowerCase().startsWith(base.toLowerCase() + '/')) {
    return norm.slice(base.length + 1)
  }
  const parts = splitPath(norm)
  return parts.slice(-2).join('/')
}

/** 从 tool/call 的 arguments（对象或 JSON 字符串）里取路径。 */
export function toolInput(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : event || {}
  const raw = data.arguments ?? data.args ?? data.input
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* 参数不是合法 JSON 就当没有 */ }
  }
  return {}
}

export function pathOfInput(input) {
  if (!input || typeof input !== 'object') return ''
  for (const key of TOOL_PATH_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value) return value
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) return value[0]
  }
  return ''
}

function isToolCall(event) {
  const kind = String(event?.type || event?.kind || '')
  return kind === 'tool/call' || kind === 'tool-call' || kind === 'tool_use'
}

/**
 * 分会话的场景跟踪：维护近 60s 的 tool/call 间隔，给每条工具调用一个 scene。
 * 不持久化；进程重启就重新累计（估算值本来就只服务当前轮）。
 */
export function createSceneTracker(options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now()
  const windowMs = Number(options.windowMs) || 60_000
  const recent = new Map() // sid -> { lastAt, ms, count }

  /**
   * @param {object} event 宿主事件
   * @param {{sessionId?:string, cwd?:string, text?:string, at?:number}} ctx
   * @returns {null | {sessionId,tool,cwd,pathPattern,timeWindow,intimacy,toolMsWindow,toolCount,at,turn,step,seq}}
   */
  function observe(event, ctx = {}) {
    if (!isToolCall(event)) return null
    const data = event.data && typeof event.data === 'object' ? event.data : event
    const sessionId = String(ctx.sessionId || data.sessionId || '').replace(/^session-/, '')
    if (!sessionId) return null
    const at = Number(ctx.at) || nowFn()
    const state = recent.get(sessionId) || { lastAt: 0, ms: 0, count: 0 }
    if (state.lastAt && at - state.lastAt <= windowMs) {
      state.ms += Math.max(0, at - state.lastAt)
      state.count += 1
    } else {
      state.ms = 0
      state.count = 0
    }
    state.lastAt = at
    recent.set(sessionId, state)

    const input = toolInput(event)
    const tool = String(data.name || data.toolName || data.tool || '').trim()
    const cwd = String(ctx.cwd || data.cwd || '').trim()
    return {
      sessionId,
      seq: Number(event.seq) || 0,
      turn: Number(data.turn) || 0,
      step: Number(data.step) || 0,
      tool: tool || null,
      cwd,
      pathPattern: pathPatternOf(pathOfInput(input), cwd),
      timeWindow: timeWindowOf(at),
      intimacy: intimacyOf(ctx.text),
      toolMsWindow: state.ms,
      toolCount: state.count,
      at,
    }
  }

  return { observe, reset: (sid) => recent.delete(String(sid || '').replace(/^session-/, '')) }
}

/** 便捷入口：只要一条 scene，不跟踪窗口。 */
export function extractScene(event, ctx = {}) {
  return createSceneTracker(ctx).observe(event, ctx)
}
