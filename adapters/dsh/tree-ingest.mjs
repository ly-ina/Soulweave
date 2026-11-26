// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * adapters/dsh/tree-ingest.mjs —— 在线增量写树索引。
 *
 * 挂 `session/event`：缓存本轮 user/assistant 正文，`turn/end` 时把这一轮
 * 落成 frag + summary + kw，下一句就能被 `tree-query` 检索到。
 *
 * 三条约束：
 *  1. fail-open：任何异常只 warn，不打断会话；
 *  2. 只收真实用户消息（source.kind === 'user'），注入的魂引/记忆快照不进索引；
 *  3. 与 build-tree 共用 core/tree/ingest.mjs，ID 口径一致（`sid:t<turn>`）。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { textOfMessage } from '../../core/budget.mjs'
import { isNoiseText } from '../../core/tree/summary.mjs'
import { ensureTreeSchema } from '../../core/tree/schema.mjs'
import { createTokenizer } from '../../core/tree/terms.mjs'
import { buildTurnRecord, ingestTurn, nextTurn } from '../../core/tree/ingest.mjs'

function contentText(data) {
  if (!data) return ''
  return textOfMessage(data.message ?? data).trim()
}

/**
 * @param {{dbPath:string, logger?:any, tokenizer?:any, now?:()=>number, maxTurns?:number}} options
 */
export function createTreeIngest(options = {}) {
  const dbPath = String(options.dbPath || '')
  const logger = options.logger
  const tokenizer = options.tokenizer || createTokenizer()
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const maxTurns = Number(options.maxTurns) || 32
  const buffers = new Map() // sid -> [{ userSeq, msgs:[{seq,role,text,t}] }]
  const flushed = new Set() // `${sid}:${userSeq}`，进程内去重

  function warn(msg) {
    try { logger?.warn?.(`tree-ingest: ${msg}`) } catch {}
  }

  function push(sid) {
    if (!buffers.has(sid)) buffers.set(sid, [])
    const list = buffers.get(sid)
    if (list.length > maxTurns) list.shift()
    return list
  }

  function accept(session, event) {
    if (!dbPath) return false
    const sid = String(session?.id || event?.sessionId || event?.data?.sessionId || '')
    if (!sid) return false
    const type = event?.type
    if (type === 'user/message') {
      const data = event.data || {}
      const kind = data.source?.kind
      if (kind && kind !== 'user') return false
      if (data.source?.form === 'snapshot') return false
      const text = contentText(data)
      if (!text || isNoiseText(text)) return false
      push(sid).push({ userSeq: Number(event.seq) || 0, msgs: [{ seq: Number(event.seq) || 0, role: 'user', text, t: Number(event.time) || now() }] })
      return true
    }
    if (type === 'assistant/message') {
      const list = buffers.get(sid)
      const cur = list?.[list.length - 1]
      if (!cur) return false
      const text = contentText(event.data)
      if (!text || isNoiseText(text)) return false
      cur.msgs.push({ seq: Number(event.seq) || 0, role: 'assistant', text, t: Number(event.time) || now() })
      return true
    }
    if (type === 'turn/end') {
      try { flush(sid) } catch (e) { warn(`flush 失败（已保留缓存）：${e?.message ?? e}`) }
      return true
    }
    return false
  }

  /** 把某会话缓存里的完整轮写进树库。返回写入轮数。 */
  function flush(sid) {
    const list = buffers.get(String(sid))
    if (!list || list.length === 0) return 0
    if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true })
    const db = new DatabaseSync(dbPath)
    let wrote = 0
    try {
      ensureTreeSchema(db)
      let turn = nextTurn(db, sid)
      const keep = []
      for (const item of list) {
        const key = `${sid}:${item.userSeq}`
        if (flushed.has(key)) continue
        turn += 1
        const rec = buildTurnRecord({ sid, turn, msgs: item.msgs, tokenizer, topk: 8 })
        if (!rec) { flushed.add(key); continue }
        ingestTurn(db, rec, { now: now() })
        flushed.add(key)
        wrote += 1
      }
      buffers.set(String(sid), keep)
    } finally {
      try { db.close() } catch {}
    }
    return wrote
  }

  return { accept, flush, pending: () => buffers.size, dbPath }
}

/** 宿主入口：挂监听，返回 dispose。 */
export function attachTreeIngest(ctx, options = {}) {
  const engine = createTreeIngest(options)
  const off = ctx.on('session/event', (session, event) => {
    try { engine.accept(session, event) } catch (e) {
      try { options.logger?.warn?.(`tree-ingest: 处理事件异常（已忽略）: ${e?.message ?? e}`) } catch {}
    }
  })
  return () => { try { off?.() } catch {} }
}
