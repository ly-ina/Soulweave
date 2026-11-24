/**
 * core/persona.mjs — 人格塑型快照（零宿主依赖）。
 *
 * 2026-11-21 伊纳定的方向：
 *   「人格是记忆的衍生，应该是让能够影响人格的记忆来影响小汐，
 *     而不是让人格的设定本身来影响。」
 *
 * 所以这里**不存新的人格设定**，只把库里已有的记忆读出来、带日期渲染成一段
 * 【我记下的自己】。它是快照，不是原文：
 *   - 每条都来自具体记忆 id，可以溯源、可以质疑；
 *   - 有日期，旧了会被阶段衰退（memory/decay.mjs）沉底，然后从这段里消失；
 *   - 读不到库 / 表不对 → 返回空文本，绝不自己编。
 *
 * 轻量版（当前）：每次调用现场查库，不落盘，stale 恒 false。
 * 正式版（后续）：内部改成读 persona_snapshot 表 + 过期重算，调用方一行不用改。
 * 接口契约就下面这两个，接线层只认结构、不认来源：
 *   readSnapshot(dbPath, opts) → { text, items, builtAt, stale, note }
 */

import { existsSync } from '../io.mjs'
import { DatabaseSync } from 'node:sqlite'

export const PERSONA_DEFAULTS = Object.freeze({
  maxItems: 3,
  maxChars: 400,
  minImportance: 2,
  table: 'soul',
})

/** 沉底标记（与 memory/decay.mjs 同一口径）；带它的条目已经退出人格层。 */
const SINK_RE = /^decay:沉底@\d{4}-\d{2}-\d{2}$/

function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function clip(text, max) {
  const chars = [...asText(text)]
  if (chars.length <= max) return chars.join('')
  // 优先在标点处收口，别把句子砍成「小汐就是小…」这种半截。
  const head = chars.slice(0, max).join('')
  const cut = Math.max(
    head.lastIndexOf('。'),
    head.lastIndexOf('；'),
    head.lastIndexOf('！'),
    head.lastIndexOf('？'),
    head.lastIndexOf('，'),
  )
  if (cut >= Math.floor(max * 0.6)) return `${head.slice(0, cut + 1)}…`
  return `${head}…`
}

/** 毫秒时间戳 → `MM-DD`；解析不了给空串（宁可没有日期，也不编一个）。 */
export function shortDate(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}-${dd}`
}

/** 关键词里的沉底标记也要认（decay 只改 keywords，不改 content）。 */
function keywordsOf(raw) {
  if (typeof raw !== 'string' || raw === '') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((x) => asText(String(x))) : []
  } catch {
    return raw.split(/[,，\s]+/).map((x) => asText(x)).filter(Boolean)
  }
}

function isSunk(row) {
  return keywordsOf(row.keywords).some((word) => SINK_RE.test(word))
}

/**
 * 读人格快照。
 *
 * @param {string} dbPath 记忆库路径（meow 七层结构）
 * @param {{ now?: number|Date, maxItems?: number, maxChars?: number, minImportance?: number }} [opts]
 * @returns {{ text: string, items: Array<{id:string,content:string,importance:number,at:string}>, builtAt: string, stale: boolean, note: string }}
 */
export function readSnapshot(dbPath, opts = {}) {
  const builtAt = new Date(opts.now ?? Date.now()).toISOString()
  const empty = (note) => ({ text: '', items: [], builtAt, stale: false, note })

  const path = asText(dbPath)
  if (path === '' || !existsSync(path)) return empty('记忆库不存在，未注入人格快照')

  const maxItems = Math.max(1, Number(opts.maxItems) || PERSONA_DEFAULTS.maxItems)
  const maxChars = Math.max(12, Number(opts.maxChars) || PERSONA_DEFAULTS.maxChars)
  const minImportance = Number.isFinite(Number(opts.minImportance))
    ? Number(opts.minImportance)
    : PERSONA_DEFAULTS.minImportance

  let db
  let columns = []
  try {
    db = new DatabaseSync(path, { readOnly: true })
    columns = db.prepare(`PRAGMA table_info(${PERSONA_DEFAULTS.table})`).all()
  } catch (error) {
    try { db?.close() } catch {}
    return empty(`读记忆库失败：${error?.message ?? error}`)
  }
  // 第二刀：builtin 新模型没有 soul 表，soul 级记忆在 memories(level='soul')。
  const usingBuiltin = columns.length === 0
  let memColumns = []
  if (usingBuiltin) {
    try {
      memColumns = db.prepare('PRAGMA table_info(memories)').all()
    } catch {
      memColumns = []
    }
  }
  if (usingBuiltin && memColumns.length === 0) {
    try { db.close() } catch {}
    return empty('没有 soul / memories 表，未注入人格快照')
  }
  const names = new Set((usingBuiltin ? memColumns : columns).map((row) => String(row.name)))
  if (!names.has('content') || !names.has('status')) {
    try { db.close() } catch {}
    return empty(`没有可用的 soul / memories 表结构，未注入人格快照`)
  }

  let rows = []
  try {
    rows = usingBuiltin
      ? db
          .prepare(
            `SELECT id, content, importance, keywords, status, 'normal' AS lifecycle, created_at, updated_at
               FROM memories
              WHERE status = 'active' AND level = 'soul'
              ORDER BY importance DESC, COALESCE(updated_at, created_at, 0) DESC`,
          )
          .all()
      : db
          .prepare(
            `SELECT id, content, importance, keywords, status, lifecycle, created_at, updated_at
               FROM soul
              WHERE status = 'active'
              ORDER BY importance DESC, COALESCE(updated_at, created_at, 0) DESC`,
          )
          .all()
  } catch (error) {
    try { db.close() } catch {}
    return empty(`查 soul 表失败：${error?.message ?? error}`)
  } finally {
    try { db.close() } catch {}
  }

  const picked = []
  for (const row of rows) {
    if (Number(row.importance) < minImportance) continue
    if (row.lifecycle === 'daily') continue
    if (isSunk(row)) continue
    const content = asText(row.content)
    if (content === '') continue
    picked.push({
      id: String(row.id),
      content: clip(content, maxChars),
      importance: Number(row.importance) || 0,
      at: shortDate(row.updated_at ?? row.created_at),
    })
    if (picked.length >= maxItems) break
  }

  if (picked.length === 0) return empty(`${usingBuiltin ? 'memories(soul)' : 'soul 表'}里没有够格的自我记忆，未注入人格快照`)

  const lines = ['【我记下的自己】（记忆，不是设定；久不被验证会被沉底）']
  for (const item of picked) {
    lines.push(`- ${item.content}${item.at ? `（${item.at}）` : ''}`)
  }
  return {
    text: lines.join('\n'),
    items: picked,
    builtAt,
    stale: false,
    note: `取自 ${usingBuiltin ? 'memories(level=soul)' : 'soul 表'} ${picked.length}/${rows.length} 条`,
  }
}

/** 正式版占位：目前只返回输入本身，不做落盘/过期判断。 */
export function rebuildSnapshot(snapshot) {
  return snapshot
}

export default { PERSONA_DEFAULTS, readSnapshot, rebuildSnapshot, shortDate }
