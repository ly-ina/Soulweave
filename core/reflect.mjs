/**
 * core/reflect.mjs —— 魂织反思轮（第四刀）。
 *
 * 用纯函数决定「这一轮要不要插一条反思提示」，便于 check 直接验证；
 * 真正的注入在 adapters/dsh/prestep.mjs，默认 `reflectEvery=0`（关）。
 */
export const REFLECT_MARK = '【魂织反思】'

export function buildReflectPrompt({ projectList = '', everyTurns = 0 } = {}) {
  return [
    `${REFLECT_MARK}这是魂织的自动反思轮（每 ${everyTurns || '?'} 次工具调用触发一次）。`,
    '回顾从上一次反思到现在的对话，只做三件事：',
    '1. 有值得跨会话记住的？用 soul_remember 写，分类交给系统，别挑表。',
    "2. 哪条记忆过时/做完了？用 soul_remember({id, status:'stale'|'archived'}) 标掉，或给 id 改正文。",
    '3. 没有就回「无需记忆」，别硬写。',
    `项目：${projectList || '（无）'}`,
  ].join('\n')
}

export function textOfEvent(event) {
  const blocks = event?.data?.content ?? event?.data?.message?.content ?? []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

/** 从 events 里找出最后一次反思提示的位置；没有返回 -1。 */
export function lastReflectIndex(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (textOfEvent(events[index]).includes(REFLECT_MARK)) return index
  }
  return -1
}

/** 最后一次反思之后出现了多少次工具调用。 */
export function toolCallsSinceReflect(events = []) {
  const start = lastReflectIndex(events) + 1
  let count = 0
  for (let index = start; index < events.length; index += 1) {
    const blocks = events[index]?.data?.message?.content ?? []
    for (const block of blocks) if (block?.type === 'tool-call') count += 1
  }
  return count
}

/** everyTurns<=0 永远不插；只在每 turn 第一步判断，避免同一轮多插。 */
export function shouldInjectReflect({ events = [], everyTurns = 0, step = 1 } = {}) {
  if (Number(everyTurns) <= 0) return false
  if (Number(step) !== 1) return false
  return toolCallsSinceReflect(events) >= Number(everyTurns)
}
