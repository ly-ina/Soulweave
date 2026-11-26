// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/tree/retrieve.mjs —— 从词出发，落到摘要。
 *
 * 这一层不碰向量：query 先抽词，再在 L2 关键词图上扩散一到两跳，最后按
 * `kw_link.weight × 词得分` 给摘要打分。向量只在句子级（summary）做补召回，
 * 由调用方另接；裸词向量实测没有区分度，不在这里用（2026-11-26 实测）。
 */
import { createTokenizer } from './terms.mjs'

/**
 * 词图上扩散：种子词 → 同现词。
 * @param {any} db
 * @param {string[]} seeds
 * @param {{topk?:number}} [opts]
 * @returns {{term:string, score:number}[]}
 */
export function expandTerms(db, seeds, opts = {}) {
  const topk = opts.topk || 6
  const uniq = [...new Set(seeds.map((s) => String(s || '').toLowerCase()).filter(Boolean))]
  if (!uniq.length) return []
  const q = uniq.map(() => '?').join(',')
  let rows = []
  try {
    rows = db.prepare(`
      SELECT k2.term AS term, SUM(l1.weight * l2.weight) AS s
      FROM kw k1
      JOIN kw_link l1 ON l1.kw_id = k1.id
      JOIN kw_link l2 ON l2.summary_id = l1.summary_id
      JOIN kw k2 ON k2.id = l2.kw_id
      WHERE k1.term IN (${q}) AND k2.term NOT IN (${q})
      GROUP BY k2.term
      ORDER BY s DESC
      LIMIT ?
    `).all(...uniq, ...uniq, topk)
  } catch {
    return []
  }
  if (!rows.length) return []
  const max = rows[0].s || 1
  return rows.map((r) => ({ term: r.term, score: Number((r.s / max).toFixed(4)) }))
}

/**
 * 检索：query → 抽词 → 扩散 → 摘要。
 * @param {any} db
 * @param {string} query
 * @param {{limit?:number, expand?:number, minScore?:number, tokenizer?:any}} [opts]
 * @returns {{summary:any, score:number, hits:string[]}[]}
 */
export function searchSummaries(db, query, opts = {}) {
  const limit = opts.limit || 10
  const expand = opts.expand ?? 1
  const tok = opts.tokenizer || createTokenizer()
  const seeds = [...new Set(tok.tokenize(query))]
  if (!seeds.length) return []

  const weights = new Map(seeds.map((t) => [t, 1]))
  if (expand > 0) {
    for (const e of expandTerms(db, seeds, { topk: 6 })) {
      if (!weights.has(e.term)) weights.set(e.term, e.score * 0.4)
    }
  }
  const terms = [...weights.keys()]

  // 直接按词查 link 再在 JS 里聚合，简单、可读，200 条规模足够
  const linkStmt = db.prepare(`
    SELECT l.summary_id, l.weight, k.term FROM kw_link l JOIN kw k ON k.id = l.kw_id WHERE k.term = ?
  `)
  const scores = new Map()
  const hits = new Map()
  for (const t of terms) {
    for (const r of linkStmt.all(t)) {
      scores.set(r.summary_id, (scores.get(r.summary_id) || 0) + r.weight * (weights.get(t) || 0))
      if (!hits.has(r.summary_id)) hits.set(r.summary_id, [])
      hits.get(r.summary_id).push(t)
    }
  }
  const getSum = db.prepare('SELECT id, sid, turn, zone, layer, text, t FROM summary WHERE id = ?')
  const out = []
  for (const [id, score] of [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)) {
    const s = getSum.get(id)
    if (s) out.push({ summary: s, score: Number(score.toFixed(4)), hits: [...new Set(hits.get(id))] })
  }
  return out
}

/** 摘要下的原文片段（下钻）。 */
export function summaryFrags(db, summaryId) {
  return db.prepare(`
    SELECT f.id, f.sid, f.seq, f.idx, f.role, f.t, f.len, f.text
    FROM frag_summary fs JOIN frag f ON f.id = fs.frag_id
    WHERE fs.summary_id = ? ORDER BY f.seq, f.idx
  `).all(summaryId)
}
