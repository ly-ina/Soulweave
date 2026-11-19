/**
 * core/recall-state.mjs —— 召回条目挑选/渲染、重载冷却、状态行发射计划（零宿主依赖）。
 *
 * 2026-11-19 解耦第 4 块：从 index.js 原样搬出，逻辑未改。
 */
import { asText, clip } from './text.mjs'

export const SOUL_STATE_KIND = 'soul-state'

/** 触发器注入的消息来源（2026-11-10）：单独一种 kind，便于日志与测试区分。 */
export const SOUL_TRIGGER_KIND = 'soul-trigger'

/** 每轮关键记忆召回的消息来源（2026-11-11 v2）：另一种 kind，预算上排在 trigger 之后。 */
export const SOUL_RECALL_KIND = 'soul-recall'

/** 召回正文与查询文本的截断长度（字）。 */
export const RECALL_TEXT_MAX_CHARS = 120

/**
 * 从 `backend.search` 的返回里挑第一条可用召回（v2）。
 *
 * 现有三个后端的 `search` 实际返回 `{ entries: [{ loc, snippet }], note }`，
 * `loc` 形如 `记忆库/fact#f00001`；交办单写的则是 `[{ id, content }]` 这种直给形状。
 * 这里两种都收：缺 id 或缺正文的行跳过，凑不出完整一对就返回 null（宁可不注入）。
 */
export function pickRecallEntry(result) {
  const rows = Array.isArray(result) ? result : Array.isArray(result?.entries) ? result.entries : []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const loc = asText(String(row.loc ?? ''))
    const rawId = asText(String(row.id ?? ''))
    const id = rawId || (loc.includes('#') ? asText(loc.slice(loc.lastIndexOf('#') + 1)) : '')
    const content = asText(String(row.content ?? '')) || asText(String(row.snippet ?? ''))
    if (id && content) return { id, content }
  }
  return null
}

/** 召回注入格式：`【记忆】<id> · <正文，截 120 字>`。 */
export function renderRecall(item) {
  return `【记忆】${item.id} · ${clip(item.content, RECALL_TEXT_MAX_CHARS)}`
}

/** 与 trigger 同一条规则：压缩重载轮清掉本会话召回冷却，避免「消息被压掉、冷却又不补」。 */
export function resetRecallCooldownOnReload(cooledBySession, sessionKey, shadowPlan) {
  if (shadowPlan?.injectStable === true) cooledBySession.delete(sessionKey)
}

/**
 * 动态段这一步发不发（伊纳 2026-11-04 拍板）。
 *
 * 一个 turn 里时间、工作区、未结数、分区计数、lesson 头都不变，第二步再发一遍纯重复：
 * 每 step 发 83 tok，一次 10 步的工具对话就堆 830 tok；每 turn 首 step 只堆 83 tok。
 *
 * - `stableDue`（压缩重载 / 哈希变化）：不管第几步，stable + state 一起补发；
 * - `step === 1`：发；
 * - 其余 step：不发（`skip-step`）；
 * - 没有 step 信息时用 per-session 的 `lastStateTurn` 兜底，同一 turn 不重复发。
 *
 * @returns {{ emit: boolean, why: 'turn-first'|'reload'|'skip-step' }}
 */
export function planStateEmit(input = {}) {
  const turn = Number(input.turn)
  const step = Number(input.step)
  const lastStateTurn = Number(input.lastStateTurn)
  const stableDue = input.stableDue === true
  const hasTurn = Number.isFinite(turn)
  const hasStep = Number.isFinite(step) && step > 0
  if (stableDue) return { emit: true, why: 'reload' }
  if (hasStep) return step === 1 ? { emit: true, why: 'turn-first' } : { emit: false, why: 'skip-step' }
  // 没有 step：靠 session 里记的上一轮 turn 兜底，同一 turn 只发一次。
  if (hasTurn && lastStateTurn === turn) return { emit: false, why: 'skip-step' }
  return { emit: true, why: 'turn-first' }
}
