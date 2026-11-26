#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/tree-query.mjs —— 按词查树索引（验收用）。
 *
 *   node tools/tree-query.mjs "文件夹 加密" [--limit 8] [--no-expand] [--frags]
 */
import '../io-node.mjs'
import { DatabaseSync } from 'node:sqlite'
import { searchSummaries, expandTerms, summaryFrags } from '../core/tree/retrieve.mjs'
import { createTokenizer } from '../core/tree/terms.mjs'

const args = process.argv.slice(2)
const has = (n) => args.includes(`--${n}`)
const opt = (n, def) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : def }
let query = ''
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith('--')) {
    if (['limit', 'mem-db'].includes(args[i].slice(2))) i += 1
    continue
  }
  query = args[i]
}
const MEM = opt('mem-db', `${process.env.USERPROFILE || 'C:\\Users\\Lenovo'}\\.dsh\\soulweave\\soul-memory.db`)
const limit = Number(opt('limit', 8))
const db = new DatabaseSync(MEM, { readOnly: true })
const tok = createTokenizer()
const seeds = [...new Set(tok.tokenize(query))]
console.log(`query: ${query}\nseeds: ${seeds.join(' / ') || '(空)'}`)
if (has('no-expand') === false) {
  const ex = expandTerms(db, seeds, { topk: 8 })
  if (ex.length) console.log('expand:', ex.map((e) => `${e.term}:${e.score}`).join(', '))
}
const rows = searchSummaries(db, query, { limit, tokenizer: tok, expand: has('no-expand') ? 0 : 1 })
for (const r of rows) {
  console.log(`\n[${r.score}] ${r.summary.zone}/${r.summary.layer}  ${r.summary.id}`)
  console.log(`  ${r.summary.text}`)
  console.log(`  hits: ${r.hits.join(' / ')}`)
  if (has('frags')) for (const f of summaryFrags(db, r.summary.id).slice(0, 2)) console.log(`  frag[${f.role}] ${f.text.slice(0, 100).replace(/\n/g, ' ')}`)
}
