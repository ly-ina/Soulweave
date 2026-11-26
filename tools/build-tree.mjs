#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/build-tree.mjs —— 从原文库回填树索引（frag / summary / kw / kw_link）。
 *
 * 默认 **dry-run**：只生成报告 + JSON，不写库。加 --apply 才写。
 *
 *   node tools/build-tree.mjs --limit 200                 # 小样本，看质量
 *   node tools/build-tree.mjs --limit 200 --apply         # 写进 soul-memory.db
 *   node tools/build-tree.mjs                             # 全量（会跑一会）
 *
 * 参数：
 *   --db <path>        原文库，默认 $DSH_HOME/soul-index/out/soul.db（或 SOULWEAVE_SOUL_INDEX_DB）
 *   --mem-db <path>    魂织记忆库，默认 $DSH_HOME/soulweave/soul-memory.db
 *   --limit <n>        最多处理多少条摘要（从最近的会话往回取）
 *   --sessions <n>     最多处理多少个会话
 *   --max-msg <n>      单条消息进摘要器前截断到多少字（默认 8000，不影响 frag）
 *   --topk <n>         每条摘要挂几个词（默认 8）
 *   --json <path>      报告落盘路径，默认 tools/out/tree-sample.json
 *   --apply            真写库
 */
import '../io-node.mjs'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { ensureTreeSchema, treeStats } from '../core/tree/schema.mjs'
import { splitFragments, extractiveSummary, classifyZone, layerOf, stripNoise, isNoiseText } from '../core/tree/summary.mjs'
import { createTokenizer } from '../core/tree/terms.mjs'

const args = process.argv.slice(2)
const has = (n) => args.includes(`--${n}`)
const opt = (n, def) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : def
}
const num = (n, def) => {
  const v = opt(n)
  return v === undefined ? def : Number(v)
}

// 不在产品代码里写死本机路径：用 --db / 环境变量，默认从 DSH_HOME 推。
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DB = opt('db', process.env.SOULWEAVE_SOUL_INDEX_DB || join(DSH_HOME, 'soul-index', 'out', 'soul.db'))
const MEM = opt('mem-db', join(DSH_HOME, 'soulweave', 'soul-memory.db'))
const LIMIT = num('limit', 0)
const SESSIONS = num('sessions', 0)
const MAX_MSG = num('max-msg', 8000)
const TOPK = num('topk', 8)
const APPLY = has('apply')
const JSON_OUT = opt('json', 'tools/out/tree-sample.json')

if (!existsSync(DB)) { console.error(`原文库不存在：${DB}`); process.exit(1) }

const src = new DatabaseSync(DB, { readOnly: true })
const tok = createTokenizer()

// 会话按最近时间倒序；只取 user/assistant/summary（tool 不进 frag）
const sessions = src.prepare(`
  SELECT sid, MAX(time) AS last, COUNT(*) AS n
  FROM messages WHERE role IN ('user','assistant','summary')
  GROUP BY sid ORDER BY last DESC
  ${SESSIONS > 0 ? `LIMIT ${SESSIONS}` : ''}
`).all()

const rowsStmt = src.prepare(`
  SELECT id, sid, seq, time, role, text FROM messages
  WHERE sid = ? AND role IN ('user','assistant','summary') ORDER BY seq
`)

/** 一条 turn = 一条 user 消息 + 它之后的 assistant/summary 消息。 */
function cutTurns(rows) {
  const turns = []
  let cur = null
  for (const r of rows) {
    if (r.role === 'user') {
      if (cur) turns.push(cur)
      cur = { turn: turns.length + 1, msgs: [r] }
    } else if (cur) {
      cur.msgs.push(r)
    }
  }
  if (cur) turns.push(cur)
  return turns
}

const summaries = []
const frags = []
const kwTf = new Map() // summaryId -> Map(term -> tf)

for (const s of sessions) {
  const turns = cutTurns(rowsStmt.all(s.sid).filter((r) => !isNoiseText(r.text)))
  for (const t of turns) {
    if (LIMIT > 0 && summaries.length >= LIMIT) break
    const allText = t.msgs.map((m) => m.text || '').join('\n')
    const summaryText = extractiveSummary(t.msgs.map((m) => ({ role: m.role, text: String(m.text || '').slice(0, MAX_MSG) })))
    if (!summaryText) continue
    const zone = classifyZone(stripNoise(allText.slice(0, 4000))).zone
    const id = `${t.msgs[0].sid}:t${t.turn}`
    const t0 = t.msgs[0].time || 0

    // frag：每条消息独立切块（tool 不进）
    for (const m of t.msgs) {
      const pieces = splitFragments(String(m.text || ''), { max: 500, overlap: 80 })
      pieces.forEach((p, idx) => {
        frags.push({
          id: `${m.sid}:${m.seq}:${idx}`, sid: m.sid, seq: m.seq, idx,
          role: m.role, t: m.time || 0, len: p.text.length, text: p.text,
          summaryId: id,
        })
      })
    }

    summaries.push({
      // 历史回填一律进检索档：稳定层只收显式规则/承诺（※记 或 rules 区条目），
      // 不能把「某轮聊天里出现过『不要』」当成规则（2026-11-26 实测 742 条误判）。
      id, sid: t.msgs[0].sid, turn: t.turn, zone, layer: 'search',
      text: summaryText, model: 'extractive-v1',
      srcLen: allText.length, t: t0,
    })
    const tf = tok.count(summaryText)
    kwTf.set(id, tf)
  }
  if (LIMIT > 0 && summaries.length >= LIMIT) break
}

// df + 权重（tf × log(N/df)）
const N = summaries.length || 1
const df = new Map()
for (const tf of kwTf.values()) for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1)
const links = []
for (const [sid, tf] of kwTf) {
  const scored = []
  for (const [term, f] of tf) {
    const d = df.get(term) || 1
    const w = f * Math.log(N / d)
    if (w > 0) scored.push([term, w, f])
  }
  scored.sort((a, b) => b[1] - a[1])
  for (const [term, w, f] of scored.slice(0, TOPK)) links.push({ summaryId: sid, term, tf: f, weight: Number(w.toFixed(4)) })
}

// ---- 报告 ----
const zoneCount = {}
let srcTotal = 0
let sumTotal = 0
for (const s of summaries) {
  zoneCount[s.zone] = (zoneCount[s.zone] || 0) + 1
  srcTotal += s.srcLen
  sumTotal += s.text.length
}
const sample = summaries.slice(0, 20).map((s) => ({
  id: s.id, zone: s.zone, layer: s.layer,
  srcLen: s.srcLen, len: s.text.length,
  ratio: s.srcLen ? Number((s.text.length / s.srcLen).toFixed(3)) : 0,
  text: s.text,
  kw: links.filter((l) => l.summaryId === s.id).map((l) => l.term),
}))

const report = {
  meta: {
    at: new Date().toISOString(),
    sourceDb: DB, memDb: MEM,
    sessions: sessions.length, summaries: summaries.length, frags: frags.length,
    uniqueTerms: df.size, links: links.length,
    srcTotal, sumTotal, compressRatio: srcTotal ? Number((sumTotal / srcTotal).toFixed(4)) : 0,
    zoneCount, apply: APPLY,
  },
  sample,
}
mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true })
writeFileSync(resolve(JSON_OUT), JSON.stringify(report, null, 2), 'utf8')

if (APPLY) {
  const mem = new DatabaseSync(MEM)
  ensureTreeSchema(mem)
  const insFrag = mem.prepare('INSERT OR REPLACE INTO frag(id,sid,seq,idx,role,t,len,text) VALUES (?,?,?,?,?,?,?,?)')
  const insSum = mem.prepare('INSERT OR REPLACE INTO summary(id,sid,turn,zone,layer,text,model,src_len,t,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
  const insFs = mem.prepare('INSERT OR REPLACE INTO frag_summary(frag_id,summary_id) VALUES (?,?)')
  const insKw = mem.prepare('INSERT INTO kw(term,scene,df) VALUES (?,?,?) ON CONFLICT(term,scene) DO UPDATE SET df=df+excluded.df')
  const getKw = mem.prepare('SELECT id FROM kw WHERE term=? AND scene=?')
  const insLink = mem.prepare('INSERT OR REPLACE INTO kw_link(summary_id,kw_id,tf,weight) VALUES (?,?,?,?)')
  const now = Date.now()
  mem.exec('BEGIN')
  try {
    // 同一批 summary 重跑要覆盖旧结果（否则 kw_link/df 会重复累加）
    const ids = summaries.map((s) => s.id)
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400)
      const q = chunk.map(() => '?').join(',')
      mem.prepare(`DELETE FROM kw_link WHERE summary_id IN (${q})`).run(...chunk)
      mem.prepare(`DELETE FROM frag_summary WHERE summary_id IN (${q})`).run(...chunk)
      mem.prepare(`DELETE FROM summary WHERE id IN (${q})`).run(...chunk)
    }
    for (const f of frags) insFrag.run(f.id, f.sid, f.seq, f.idx, f.role, f.t, f.len, f.text)
    for (const s of summaries) insSum.run(s.id, s.sid, s.turn, s.zone, s.layer, s.text, s.model, s.srcLen, s.t, now)
    for (const f of frags) insFs.run(f.id, f.summaryId)
    for (const l of links) {
      insKw.run(l.term, '', 1)
      const kid = getKw.get(l.term, '').id
      insLink.run(l.summaryId, kid, l.tf, l.weight)
    }
    // df 一律从 kw_link 重算，不信增量累加
    mem.exec('UPDATE kw SET df=(SELECT COUNT(*) FROM kw_link WHERE kw_id=kw.id)')
    mem.exec('DELETE FROM kw WHERE df=0')
    mem.exec('COMMIT')
  } catch (e) {
    mem.exec('ROLLBACK')
    throw e
  }
  console.log('stats=' + JSON.stringify(treeStats(mem)))
  mem.close()
}

console.log(JSON.stringify(report.meta, null, 2))
console.log('\n--- sample ---')
for (const s of sample) console.log(`[${s.zone}/${s.layer}] ${s.srcLen}→${s.len} (${s.ratio}) ${s.text}\n    kw: ${s.kw.join(' / ')}`)
console.log(`\nreport: ${resolve(JSON_OUT)}`)
src.close()
