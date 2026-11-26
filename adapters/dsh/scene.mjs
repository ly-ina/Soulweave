// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * adapters/dsh/scene.mjs —— 把每次工具调用落成一行 scene（SPEC-V2 §1）。
 *
 * 纯提取在 memory/scene.mjs；这里只做宿主耦合与写库。
 * 表在 soul-memory.db 里（和树索引同库），schema 由 core/tree/schema.mjs 保证。
 *
 * fail-open：任何异常只 warn，不打断会话；同一条工具调用重放是 INSERT OR REPLACE。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureTreeSchema } from '../../core/tree/schema.mjs'
import { createSceneTracker } from '../../memory/scene.mjs'

/** 幂等写一行 scene。 */
export function writeScene(db, scene) {
  if (!scene?.sessionId) return false
  const id = `${scene.sessionId}:${scene.seq || scene.at}`
  db.prepare(`INSERT OR REPLACE INTO scene
    (id,sid,seq,turn,step,tool,cwd,path_pattern,time_window,intimacy,tool_ms_window,tool_count,t)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, scene.sessionId, scene.seq || 0, scene.turn || 0, scene.step || 0,
    scene.tool || null, scene.cwd || '', scene.pathPattern || '',
    scene.timeWindow || '', Number(scene.intimacy) || 0,
    Number(scene.toolMsWindow) || 0, Number(scene.toolCount) || 0, Number(scene.at) || Date.now(),
  )
  return true
}

/** 某会话在 seq 之前最近的一条 scene（summary 绑 scene 用）。 */
export function latestSceneId(db, sid, seq = 0) {
  try {
    const row = db.prepare('SELECT id FROM scene WHERE sid = ? AND seq <= ? ORDER BY seq DESC, t DESC LIMIT 1').get(String(sid), Number(seq) || 0)
    return row?.id || null
  } catch { return null }
}

export function attachSceneRecorder(ctx, options = {}) {
  const dbPath = String(options.dbPath || '')
  const logger = options.logger
  if (!dbPath || typeof ctx.on !== 'function') return () => {}
  const tracker = createSceneTracker({ now: options.now })
  const lastUserText = new Map()
  let schemaReady = false
  let warned = 0

  const warn = (msg) => {
    if (warned >= 3) return
    warned += 1
    try { logger?.warn?.(`scene: ${msg}`) } catch {}
  }

  const off = ctx.on('session/event', (session, event) => {
    try {
      const sid = String(session?.id || event?.sessionId || '')
      if (!sid) return
      if (event?.type === 'user/message') {
        const text = (Array.isArray(event.data?.content) ? event.data.content : [])
          .map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
        lastUserText.set(sid, text.slice(0, 2000))
        return
      }
      if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true })
      const scene = tracker.observe(event, {
        sessionId: sid,
        cwd: session?.header?.cwd || session?.cwd || '',
        text: lastUserText.get(sid) || '',
        at: options.now ? options.now() : (Number(event?.time) || Date.now()),
      })
      if (!scene) return
      const db = new DatabaseSync(dbPath)
      try {
        if (!schemaReady) { ensureTreeSchema(db); schemaReady = true }
        writeScene(db, scene)
      } finally { try { db.close() } catch {} }
    } catch (e) { warn(`写 scene 失败（已忽略）：${e?.message ?? e}`) }
  })
  return () => { try { off?.() } catch {} }
}

