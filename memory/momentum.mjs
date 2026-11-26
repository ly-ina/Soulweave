// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * memory/momentum.mjs —— Context Momentum（SPEC-V2 §3）。
 *
 * 一个分会话的势能：工作态拉高（更保守，少发散），亲密态压低（更发散，多联想）。
 * 纯状态机 + 一个 JSON 持久化壳；不碰数据库。
 *
 * 状态：{ value, suppressed, lastAt }
 *  - value     当前势能，软区间 0.20 ~ 0.80
 *  - suppressed 被亲密压低的累计量，用来做「覆写回拉」
 */

import { readFileSync, writeFileSync } from '../io.mjs'

export const MOMENTUM_MIN = 0.2
export const MOMENTUM_MAX = 0.8
/** 压缩后的重置窗口：高于 0.6 压回 0.6，低于 0.4 抬回 0.4，落在中间就保持。 */
export const MOMENTUM_RESET = 0.6
export const MOMENTUM_RESET_MIN = 0.4
export const MOMENTUM_RESET_MAX = 0.6
export const MOMENTUM_BOUNCE = 0.02
export const WORK_RAISE = 0.08
export const INTIMACY_DROP = 0.15
/** 工作判定：60s 内累计工具耗时 > 30s 且调用 >= 2 次。 */
export const WORK_MS = 30_000
export const WORK_COUNT = 2

const clamp = (value) => Math.min(MOMENTUM_MAX, Math.max(MOMENTUM_MIN, value))

export function initialState(value = MOMENTUM_RESET) {
  return { value: clamp(Number(value) || MOMENTUM_RESET), suppressed: 0, lastAt: 0 }
}

/** 向区间内回归一点（越界才回弹，区间内不动）。 */
export function bounce(state) {
  let value = Number(state?.value ?? MOMENTUM_RESET)
  if (value < MOMENTUM_MIN) value = Math.min(MOMENTUM_MIN, value + MOMENTUM_BOUNCE)
  else if (value > MOMENTUM_MAX) value = Math.max(MOMENTUM_MAX, value - MOMENTUM_BOUNCE)
  return { ...state, value: clamp(value) }
}

/**
 * 一轮的势能变化。纯函数。
 * @param {{value:number,suppressed:number,lastAt:number}} state
 * @param {{toolMsWindow?:number,toolCount?:number,intimacy?:number,compacted?:boolean,now?:number}} input
 */
export function nextMomentum(state, input = {}) {
  const prev = state ?? initialState()
  if (input.compacted === true) {
    // 压缩不拉回固定值，只夹进重置窗口 [0.4, 0.6]：
    // 工作态（>0.6）压回 0.6，亲密态（<0.4）抬回 0.4，中间就保持。
    const carried = clamp(Number(prev.value ?? MOMENTUM_RESET))
    const value = Math.min(MOMENTUM_RESET_MAX, Math.max(MOMENTUM_RESET_MIN, carried))
    return { value, suppressed: 0, lastAt: Number(input.now ?? prev.lastAt ?? 0) }
  }
  let value = Number(prev.value ?? MOMENTUM_RESET)
  let suppressed = Number(prev.suppressed ?? 0)
  const toolMsWindow = Number(input.toolMsWindow ?? 0)
  const toolCount = Number(input.toolCount ?? 0)
  const intimacy = Number(input.intimacy ?? 0)
  const heavy = toolMsWindow > WORK_MS && toolCount >= WORK_COUNT

  if (heavy) {
    // 覆写回拉：之前被亲密压下去的，回到工作态时补回来
    if (suppressed > 0) {
      value += suppressed
      suppressed = 0
    }
    value += WORK_RAISE
  } else if (intimacy > 0) {
    value -= INTIMACY_DROP
    suppressed += INTIMACY_DROP
  }

  return { value: clamp(value), suppressed, lastAt: Number(input.now ?? prev.lastAt ?? 0) }
}

/**
 * 分会话 store。`file` 给了就落盘（state/momentum.json）；读写失败一律吞掉。
 */
export function createMomentumStore({ file = '', now = () => Date.now() } = {}) {
  /** @type {Map<string, {value:number,suppressed:number,lastAt:number}>} */
  const states = new Map()
  const text = (v) => String(v ?? '').trim()

  function normalize(raw) {
    const out = {}
    if (!raw || typeof raw !== 'object') return out
    for (const [sid, state] of Object.entries(raw)) {
      const key = text(sid)
      if (!key || !state || typeof state !== 'object') continue
      // 重启后按 lastAt 做一次回弹再继续（规范：持久化 + 回弹一次）
      out[key] = bounce(initialState(Number(state.value)))
      out[key].suppressed = Math.max(0, Number(state.suppressed) || 0)
      out[key].lastAt = Number(state.lastAt) || 0
    }
    return out
  }

  if (file) {
    try {
      for (const [sid, state] of Object.entries(normalize(JSON.parse(readFileSync(file, 'utf8'))))) states.set(sid, state)
    } catch {
      /* 没文件 / 坏文件：从默认值起步 */
    }
  }

  function save() {
    if (!file) return false
    try {
      const raw = Object.fromEntries(states)
      writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
      return true
    } catch {
      return false
    }
  }

  return {
    get(sid) {
      const key = text(sid)
      if (!states.has(key)) states.set(key, initialState())
      return { ...states.get(key) }
    },
    /** 一轮观察；返回新的 { value, ... }。 */
    observe(sid, input = {}) {
      const key = text(sid)
      const next = nextMomentum(states.get(key) ?? initialState(), { ...input, now: input.now ?? now() })
      states.set(key, next)
      return { ...next }
    },
    reset(sid) {
      states.set(text(sid), { value: MOMENTUM_RESET, suppressed: 0, lastAt: now() })
    },
    all() {
      return new Map(states)
    },
    save,
    size() {
      return states.size
    },
  }
}