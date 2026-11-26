// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * memory/assoc.mjs —— 第六路的查询壳：给种子记忆，沿 L1 图 2 跳内扩散出「想到的」。
 *
 * 与 personalizedPageRank 的分工：
 *  - ppr.mjs 只算 rank（纯算法）；
 *  - 这里负责读边、把 `memories#<id>` 还原成记忆正文。
 *
 * 第六路只做「补召回」，不替代相似度检索：输出带 hops，注入侧按 rank 截断。
 */

import { existsSync } from '../io.mjs'
import { openDatabase } from '../storage/index.mjs'
import { personalizedPageRank } from './ppr.mjs'
import { readEdges, RELATION_SAME_SCENE, RELATION_SAME_SOURCE } from './graph.mjs'

/** 去掉 level 前缀。七层老表的节点先不还原正文，只保留 id。 */
export function bareId(nodeId) {
  const text = String(nodeId ?? '')
  const cut = text.indexOf('#')
  return cut > 0 ? text.slice(cut + 1) : text
}

/** 节点属于哪张表。 */
export function levelOf(nodeId) {
  const text = String(nodeId ?? '')
  const cut = text.indexOf('#')
  return cut > 0 ? text.slice(0, cut) : 'memories'
}

function snippetOf(text, max = 140) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

/**
 * @param {string} dbPath soul-memory.db
 * @param {{seeds:Array|Map|null, alpha?:number, limit?:number, relations?:string[], now?:number}} options
 * @returns {{entries:Array<{nodeId:string,id:string,score:number,hops:number,title:string,snippet:string}>, note:string}}
 */
export function associateByPPR(dbPath, options = {}) {
  const limit = Math.max(1, Number(options.limit ?? 5))
  if (!dbPath || !existsSync(dbPath)) return { entries: [], note: '记忆库不存在' }
  let db
  try {
    db = openDatabase(dbPath, { readOnly: true })
    const relations = Array.isArray(options.relations) && options.relations.length
      ? options.relations
      : [RELATION_SAME_SCENE, RELATION_SAME_SOURCE]
    const edges = relations.flatMap((relation) => readEdges(db, { relation }))
    if (edges.length === 0) return { entries: [], note: '记忆图还没有边' }

    // 图里的节点 id 是 `<level>#<id>`；调用方给裸记忆 id 时默认按 memories 补前缀。
    const asNodeId = (id) => {
      const text = String(id ?? '').trim()
      return !text ? '' : text.includes('#') ? text : `memories#${text}`
    }
    const seeds = options.seeds instanceof Map
      ? new Map([...options.seeds].map(([id, weight]) => [asNodeId(id), weight]))
      : new Map((Array.isArray(options.seeds) ? options.seeds : [])
        .map(asNodeId)
        .filter(Boolean)
        .map((id) => [id, 1]))
    const { rank, hops, scanned } = personalizedPageRank({
      edges,
      seeds,
      alpha: Number(options.alpha ?? 0.6),
    })
    if (rank.size === 0) return { entries: [], note: `种子不在图里 / 图里没有 2 跳邻居（扫描 ${scanned}）` }

    const wanted = [...rank.entries()]
      .filter(([nodeId]) => !seeds.has(nodeId))
      .sort((a, b) => b[1] - a[1])
    const ids = wanted.slice(0, limit * 4).map(([nodeId]) => bareId(nodeId))
    const rows = new Map()
    try {
      const placeholders = ids.map(() => '?').join(', ')
      for (const row of db.prepare(`SELECT id, title, content FROM memories WHERE id IN (${placeholders})`).all(...ids)) {
        rows.set(String(row.id), row)
      }
    } catch { /* 老库没有 memories 表 */ }

    const entries = []
    for (const [nodeId, score] of wanted) {
      if (entries.length >= limit) break
      const id = bareId(nodeId)
      const row = rows.get(id)
      if (!row) continue
      entries.push({
        nodeId,
        id,
        score: Number(score.toFixed(6)),
        hops: Number(hops.get(nodeId) ?? 0),
        title: String(row.title ?? ''),
        snippet: snippetOf(row.content),
      })
    }
    return { entries, note: `PPR 种子 ${seeds.size} · 2 跳内 ${rank.size} 个 · 取 ${entries.length}` }
  } catch (error) {
    return { entries: [], note: `联想失败：${String(error?.message ?? error)}` }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}