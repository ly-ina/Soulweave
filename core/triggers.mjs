/**
 * triggers —— 触发词清单加载与选择（零宿主依赖）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { asText, asInt, estimateTokens } from './text.mjs'
import { textOfMessage, lastUserTexts } from './budget.mjs'

export function loadTriggers(triggerPath) {
  const file = asText(triggerPath)
  if (!file) return { ok: false, triggers: [], error: '未配置 triggerPath' }
  if (!existsSync(file)) return { ok: false, triggers: [], error: '文件不存在' }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const list = Array.isArray(parsed?.triggers) ? parsed.triggers : []
    const triggers = []
    for (const item of list) {
      if (item?.enabled === false) continue
      const id = asText(item?.id)
      const text = asText(item?.text)
      const keywords = Array.isArray(item?.keywords)
        ? item.keywords.map((word) => asText(word)).filter(Boolean)
        : []
      if (!id || !text || keywords.length === 0) continue
      triggers.push({ id, keywords, text })
    }
    return { ok: true, triggers, error: '' }
  } catch (error) {
    return { ok: false, triggers: [], error: String(error?.message ?? error) }
  }
}

/**
 * 从清单里挑本轮该注入的条目（纯函数）。
 * - 大小写不敏感**子串**匹配（中文没有词边界，子串是唯一便宜的口径）；
 * - 按命中关键词数降序，取前 `maxEntries` 条；
 * - 累加正文估算 token 超 `budgetTokens` 就停（不做单条截断）。
 *
 * @returns {Array<{id: string, text: string, hits: number}>}
 */
export function selectTriggers(userText, triggers, options = {}) {
  const text = asText(userText)
  if (!text) return []
  const maxEntries = asInt(options.maxEntries, 2, 1, 5)
  const budgetTokens = asInt(options.budgetTokens, 200, 50, 600)
  const lower = text.toLowerCase()
  const scored = []
  for (const trigger of Array.isArray(triggers) ? triggers : []) {
    const id = asText(trigger?.id)
    const body = asText(trigger?.text)
    if (!id || !body) continue
    const keywords = Array.isArray(trigger?.keywords) ? trigger.keywords : []
    let hits = 0
    for (const word of keywords) {
      const value = asText(word).toLowerCase()
      if (value !== '' && lower.includes(value)) hits += 1
    }
    if (hits > 0) scored.push({ id, text: body, hits })
  }
  scored.sort((a, b) => b.hits - a.hits)
  const picked = []
  let spent = 0
  for (const item of scored) {
    if (picked.length >= maxEntries) break
    const cost = estimateTokens(item.text)
    if (spent + cost > budgetTokens) break
    picked.push(item)
    spent += cost
  }
  return picked
}

/**
 * 2026-11-10 v1.1 修复：pre-step 时 `payload.events` 里可能还没有本轮 user 消息，
 * 旧实现 lastUserTexts(events,1) 会拿到更早的压缩摘要（里面常含「魂织」等词），导致串触发。
 * 优先取 `payload.messages` 尾部当前消息；跳过注入的 soul-* 消息；events 只作兜底。
 */
export function pickTriggerText(messages, events) {
  const tail = Array.isArray(messages) ? messages.slice(-4) : []
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index]
    const kind = message?.source?.kind
    if (kind && String(kind).startsWith('soul')) continue
    if (message?.role && message.role !== 'user') continue
    const text = textOfMessage(message).trim()
    if (text) return text
  }
  return lastUserTexts(events, 1)[0] ?? ''
}

/** 2026-11-10 v1.1：压缩重载轮清掉本会话触发冷却，避免「消息被压掉、冷却又不补」。 */
export function resetTriggerCooldownOnReload(cooledBySession, sessionKey, shadowPlan) {
  if (shadowPlan?.injectStable === true) cooledBySession.delete(sessionKey)
}

