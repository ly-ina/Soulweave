// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * memory/scene-link.mjs —— 记忆侧接 scene（2026-11-26）。
 *
 * 目标：`soul_remember` 不用人填「什么时候该想起我」，
 * 写入时自己去 scene 表里看一眼「刚才在干什么」，自动生 when_ctx。
 *
 * 自动签名故意窄：
 *  - pathPattern 取自 scene 的末两级路径，扩成目录 glob（memory/*）；
 *  - timeWindow 照抄 scene 的时段；
 *  - tool **不自动签**——工具太具体，签上就几乎不会再命中。要签得显式给。
 *
 * 只读；任何异常返回 null，不影响写入（fail-open）。
 */

import { existsSync } from '../io.mjs'
import { openDatabase } from '../storage/index.mjs'

/** scene 超过这么久就算「不是刚才」，不往记忆上绑。 */
export const SCENE_MAX_AGE_MS = 15 * 60_000

/**
 * 最近一条 scene。给了 sid 就只看这个会话（推荐），否则看全库最新。
 * @returns {object|null}
 */
export function latestScene(dbPath, { sid = '', now = Date.now(), maxAgeMs = SCENE_MAX_AGE_MS } = {}) {
  if (!dbPath || !existsSync(dbPath)) return null
  let db
  try {
    db = openDatabase(dbPath, { readOnly: true })
    const since = Number(now) - Number(maxAgeMs || SCENE_MAX_AGE_MS)
    const wanted = String(sid ?? '').trim()
    const row = wanted
      ? db.prepare('select * from scene where sid = ? and t >= ? order by t desc limit 1').get(wanted, since)
      : db.prepare('select * from scene where t >= ? order by t desc limit 1').get(since)
    return row ? { ...row } : null
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/**
 * scene 的路径 → 记忆的 pathPattern glob。
 * `memory/when.mjs` → `*memory/*`；只有文件名时原样返回。
 * 两端带 `*`：不管运行时 ctx.path 是相对还是绝对都能对上。
 */
export function pathGlobOf(pathPattern) {
  const text = String(pathPattern ?? '').trim().replace(/\\/g, '/')
  if (!text) return ''
  if (!text.includes('/')) return text
  const dir = text.slice(0, text.lastIndexOf('/'))
  return dir ? `*${dir}/*` : ''
}

/**
 * scene → when_ctx。没话可说时返回 null。
 * @param {object|null} scene
 * @param {{tool?: boolean}} options tool=true 才把工具名也签上（默认不签）
 */
export function whenFromScene(scene, options = {}) {
  if (!scene) return null
  const out = {}
  if (options.tool === true && scene.tool) out.tool = String(scene.tool)
  const glob = pathGlobOf(scene.path_pattern)
  if (glob) out.pathPattern = glob
  if (scene.time_window) out.timeWindow = String(scene.time_window)
  return Object.keys(out).length === 0 ? null : out
}

/** 一行展示，给 soul_remember 的回执用。 */
export function sceneLabel(scene) {
  if (!scene) return ''
  const bits = []
  if (scene.tool) bits.push(String(scene.tool))
  if (scene.path_pattern) bits.push(String(scene.path_pattern))
  if (scene.time_window) bits.push(String(scene.time_window))
  return bits.join(' / ')
}