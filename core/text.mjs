/**
 * core/text.mjs —— 纯文本小工具（零宿主依赖）。
 *
 * 2026-11-19 解耦第 1 块：从 index.js 原样搬出，逻辑未改。
 */

import { appendFileSync, env, fileURLToPath, homedir, mkdirSync } from '../io.mjs'
import { createHash } from '../sha256.mjs'

import { dirname, join, resolve } from '../io.mjs'

/** CJK 判定（全角标点也算一个 token）。 */
export const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/

export function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function asInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/** 与 `dsh-context-index` / `dsh-sealed-segments` 同一口径，便于横向对比。 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let units = 0
  for (const ch of text) units += CJK.test(ch) ? 1 : 0.34
  return Math.ceil(units)
}

export function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (max <= 0) return ''
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

export function dsHome() {
  return asText(env('DSH_HOME')) || join(homedir(), '.dsh')
}

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

export function appendLog(logPath, line) {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${line}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

export function logLine(at, action, detail) {
  return `${new Date(at).toISOString()} ${action} ${detail}`
}

export function tableColumns(db, table) {
  try {
    return db.prepare(`pragma table_info(${table})`).all().map((row) => row.name)
  } catch {
    return []
  }
}
/** 本文件所在目录（core/）。 */
export const CORE_DIR = dirname(fileURLToPath(import.meta.url))
/** 包根目录（core/ 的上一级）。 */
export const PLUGIN_DIR = resolve(CORE_DIR, '..')


