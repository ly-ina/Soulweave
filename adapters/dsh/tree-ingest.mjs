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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
 * sid 对齐：**不要剥 `session-` 前缀**。
 * 2026-11-26 实测：本会话在原文库里是 `session-8a813a0b-…`（回填 6189 条），
 * 剥了前缀反而写成第二个 sid（在线 t1、回填 t1..t6189 对不上）。
 * 原文库里确实也有不带前缀的老 sid，所以这里以宿主事件为准，原样保留。
 */
function normalizeSid(value) {
  return String(value || '').trim()
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
  const bufferPath = options.bufferPath || (dbPath ? join(dirname(dbPath), 'tree-buffer.json') : '')
  const buffers = new Map() // sid -> [{ userSeq, msgs:[{seq,role,text,t}] }]
  const flushed = new Set() // `${sid}:${userSeq}`，进程内去重

  function warn(msg) {
    try { logger?.warn?.(`tree-ingest: ${msg}`) } catch {}
  }

  // 热重载会重建引擎：缓存落盘，重载后接着写，不然改代码那一轮的 user 就丢了。
  function loadBuffer() {
    if (!bufferPath || !existsSync(bufferPath)) return
    try {
      const data = JSON.parse(readFileSync(bufferPath, 'utf8'))
      for (const [sid, list] of Object.entries(data || {})) {
        if (Array.isArray(list) && list.length) buffers.set(sid, list)
      }
    } catch (e) { warn(`读缓存失败（忽略）：${e?.message ?? e}`) }
  }

  function saveBuffer() {
    if (!bufferPath) return
    try {
      const out = {}
      for (const [sid, list] of buffers) if (list.length) out[sid] = list
      mkdirSync(dirname(bufferPath), { recursive: true })
      writeFileSync(bufferPath, JSON.stringify(out))
    } catch (e) { warn(`写缓存失败（忽略）：${e?.message ?? e}`) }
  }

  loadBuffer()

  function push(sid) {
    if (!buffers.has(sid)) buffers.set(sid, [])
    const list = buffers.get(sid)
    if (list.length > maxTurns) list.shift()
    return list
  }

  function accept(session, event) {
    if (!dbPath) return false
    const sid = normalizeSid(session?.id || event?.sessionId || event?.data?.sessionId)
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
      saveBuffer()
      return true
    }
    if (type === 'assistant/message') {
      const list = buffers.get(sid)
      const cur = list?.[list.length - 1]
      if (!cur) return false
      const text = contentText(event.data)
      if (!text || isNoiseText(text)) return false
      cur.msgs.push({ seq: Number(event.seq) || 0, role: 'assistant', text, t: Number(event.time) || now() })
      saveBuffer()
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
      saveBuffer()
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

