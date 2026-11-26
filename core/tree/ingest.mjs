// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/tree/ingest.mjs —— 单轮增量写树（frag / summary / kw / kw_link）。
 *
 * 和 tools/build-tree.mjs 的分工：
 *   - build-tree 是离线全量回填，批量算 df、统一权重；
 *   - 这里是**在线单轮写入**，turn/end 时立刻落库，下一句就能检索到。
 * 两边共用 summary/terms 的同一套抽取逻辑，ID 口径也一致（`sid:t<turn>`），
 * 所以先在线写、以后全量重建不会打架（同 ID 覆盖）。
 *
 * 只写这四张表；原文全文仍在会话/`soul.db`，frag 只存切块后的短文本。
 * 零依赖：只认 node:sqlite 的 DatabaseSync 接口（prepare/exec）。
 */
import { splitFragments, extractiveSummary, classifyZone, stripNoise } from './summary.mjs'

export const INGEST_MODEL = 'extractive-v1'

/** 一轮消息 → 可落库的 frag + summary（纯函数，不碰库；给测试直接调）。 */
export function buildTurnRecord({ sid, turn, msgs, tokenizer, maxMsg = 8000, topk = 8 }) {
  const list = (msgs || [])
    .filter((m) => m && typeof m.text === 'string' && m.text.trim() !== '')
    .map((m) => ({ ...m, text: String(m.text) }))
  if (!list.length) return null

  const allText = list.map((m) => m.text).join('\n')
  const summaryText = extractiveSummary(list.map((m) => ({ role: m.role, text: m.text.slice(0, maxMsg) })))
  if (!summaryText) return null

  const zone = classifyZone(stripNoise(allText.slice(0, 4000))).zone
  const id = `${sid}:t${turn}`
  const frags = []
  for (const m of list) {
    splitFragments(m.text, { max: 500, overlap: 80 }).forEach((p, idx) => {
      frags.push({
        id: `${sid}:${m.seq}:${idx}`, sid, seq: Number(m.seq) || 0, idx,
        role: m.role || '', t: Number(m.t) || 0, len: p.text.length, text: p.text,
      })
    })
  }
  const tf = tokenizer ? tokenizer.count(summaryText) : new Map()
  return {
    id, sid, turn, zone, layer: 'search', text: summaryText, model: INGEST_MODEL,
    srcLen: allText.length, t: Number(list[0].t) || 0, frags, tf, topk,
  }
}

/** 这个会话下一个该用的 turn 号（在线写与 build-tree 的切轮口径一致）。 */
export function nextTurn(db, sid) {
  const row = db.prepare('SELECT COALESCE(MAX(turn), 0) AS n FROM summary WHERE sid = ?').get(String(sid))
  return Number(row?.n) || 0
}

/**
 * 写一轮。同一个 `sid:t<turn>` 重跑会先清掉旧 summary/frag_link 再覆盖，不会重复累加 df。
 * @returns {{summaryId:string, frags:number, links:number}}
 */
export function ingestTurn(db, rec, { now = Date.now() } = {}) {
  if (!rec || !rec.id) return { summaryId: '', frags: 0, links: 0 }
  const touched = []
  db.exec('BEGIN IMMEDIATE')
  try {
    const oldFrags = db.prepare('SELECT frag_id FROM frag_summary WHERE summary_id = ?').all(rec.id)
    db.prepare('DELETE FROM kw_link WHERE summary_id = ?').run(rec.id)
    db.prepare('DELETE FROM frag_summary WHERE summary_id = ?').run(rec.id)
    const delFrag = db.prepare('DELETE FROM frag WHERE id = ?')
    for (const row of oldFrags) delFrag.run(row.frag_id)
    db.prepare('DELETE FROM summary WHERE id = ?').run(rec.id)

    const insFrag = db.prepare('INSERT INTO frag(id,sid,seq,idx,role,t,len,text) VALUES (?,?,?,?,?,?,?,?)')
    const linkFrag = db.prepare('INSERT OR REPLACE INTO frag_summary(frag_id,summary_id) VALUES (?,?)')
    for (const f of rec.frags || []) {
      insFrag.run(f.id, f.sid, f.seq, f.idx, f.role, f.t, f.len, f.text)
      linkFrag.run(f.id, rec.id)
    }

    db.prepare(`INSERT INTO summary(id,sid,turn,zone,layer,text,model,src_len,t,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      rec.id, rec.sid, rec.turn, rec.zone || 'misc', rec.layer || 'search',
      rec.text, rec.model || INGEST_MODEL, rec.srcLen || 0, rec.t || 0, now,
    )

    // 词先全部挂上（weight 先占位），再按库里现算的 df 算权重、砍到 topk。
    // df 必须包含本轮，所以顺序是「插 link → 重算 df → 算权重」。
    const N = Number(db.prepare('SELECT COUNT(*) AS n FROM summary').get()?.n) || 1
    const upsertKw = db.prepare('INSERT INTO kw(term,scene,df) VALUES (?,?,0) ON CONFLICT(term,scene) DO NOTHING')
    const findKw = db.prepare('SELECT id FROM kw WHERE term = ? AND scene = ?')
    const insLink = db.prepare('INSERT OR REPLACE INTO kw_link(summary_id,kw_id,tf,weight) VALUES (?,?,?,1)')
    const tfOf = new Map()
    for (const [term, f] of rec.tf || new Map()) {
      upsertKw.run(term, '')
      const kid = findKw.get(term, '')?.id
      if (!kid) continue
      insLink.run(rec.id, kid, f)
      tfOf.set(kid, f)
      touched.push(kid)
    }

    const updDf = db.prepare('UPDATE kw SET df=(SELECT COUNT(*) FROM kw_link WHERE kw_id=kw.id) WHERE id=?')
    const readDf = db.prepare('SELECT df FROM kw WHERE id=?')
    const updW = db.prepare('UPDATE kw_link SET weight=? WHERE summary_id=? AND kw_id=?')
    const delLink = db.prepare('DELETE FROM kw_link WHERE summary_id=? AND kw_id=?')
    const scored = []
    for (const kid of new Set(touched)) {
      updDf.run(kid)
      const df = Math.max(1, Number(readDf.get(kid)?.df) || 1)
      // +1 平滑：库里只有这一条时 df=N=1，log(N/df)=0 会把词全删光。
      const w = (tfOf.get(kid) || 1) * Math.log(1 + N / df)
      if (w > 0) { updW.run(Number(w.toFixed(4)), rec.id, kid); scored.push([kid, w]) }
      else delLink.run(rec.id, kid)
    }
    scored.sort((a, b) => b[1] - a[1])
    for (const [kid] of scored.slice(rec.topk || 8)) delLink.run(rec.id, kid)

    // 砍完 topk 后 df 会变，再统一重算一次并清掉空词
    const delKw = db.prepare('DELETE FROM kw WHERE id=? AND df=0')
    for (const kid of new Set(touched)) { updDf.run(kid); delKw.run(kid) }

    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
  return { summaryId: rec.id, frags: (rec.frags || []).length, links: touched.length }
}
