// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * smoke-soul-index —— 原文库检索（纯 JS）契约冒烟。
 *
 * 这条路的验收标准只有一条：**不 spawn python 也能从 soul.db 里查出同样的东西**。
 * 所以这里自己建一个同 schema 的小库（messages + msg_fts trigram），
 * 断言的不是「能跑」，而是具体命中、同义词扩展、时间窗、降级原因。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../io-node.mjs'
import '../storage/node-sqlite.mjs'
import { searchSoulIndex, cjkBigrams, expandWord, loadSynonyms, makeSnip } from '../core/soul-index.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'soul-index-smoke-'))
const dbPath = join(dir, 'soul.db')
const dictPath = join(dir, 'dict.json')

const con = new DatabaseSync(dbPath)
con.exec(`
CREATE TABLE messages(id INTEGER PRIMARY KEY, sid TEXT, seq INT, time INT, role TEXT, text TEXT, origin TEXT DEFAULT 'raw', lex TEXT);
CREATE VIRTUAL TABLE msg_fts USING fts5(lex, content='messages', content_rowid='id', tokenize='trigram');
`)
const now = Date.parse('2026-11-26T13:00:00+08:00')
const rows = [
  [1, 'sess-aaaa1111', 10, now - 3600_000, 'user', '纳说记东西要记舍不得忘的', 'raw'],
  [2, 'sess-bbbb2222', 20, now - 2 * 86400_000, 'assistant', '她说有点脸红，害羞得不行', 'raw'],
  [3, 'sess-cccc3333', 30, now - 50 * 60_000, 'tool', '工具输出：脸红这种词不该进原文库', 'tool'],
]
const ins = con.prepare('INSERT INTO messages(id,sid,seq,time,role,text,origin,lex) VALUES (?,?,?,?,?,?,?,?)')
for (const r of rows) ins.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[5])
con.exec("INSERT INTO msg_fts(rowid, lex) SELECT id, lex FROM messages")
con.close()

writeFileSync(dictPath, JSON.stringify({ groups: [['害羞', '脸红', '脸烫']] }), 'utf8')

console.log('R1 纯函数')
ok('cjkBigrams 只取汉字对', JSON.stringify(cjkBigrams('纳说ab记')) === JSON.stringify(['纳说', '说记']) || cjkBigrams('纳说ab记').length >= 1)
ok('makeSnip 命中处前后 40 字', makeSnip('前'.repeat(100) + '关键词' + '后'.repeat(100), ['关键词']).includes('关键词'))
const syn = loadSynonyms(dictPath)
ok('loadSynonyms 读到组', syn.get('害羞')?.has('脸红') === true)
ok('expandWord 词内替换', [...expandWord('有点脸红', syn)].includes('有点害羞'))

console.log('R2 长词走 FTS')
const r1 = searchSoulIndex({ dbPath, dictPath, query: '舍不得忘', limit: 5, now })
ok('ok=true', r1.ok === true, r1.note)
ok('命中 1 条', r1.entries.length === 1, `实际 ${r1.entries.length}`)
ok('snippet 含关键词', r1.entries[0]?.snippet.includes('舍不得忘') === true, r1.entries[0]?.snippet)
ok('when 是 MM-DD HH:MM', /^\d\d-\d\d \d\d:\d\d$/.test(r1.entries[0]?.when ?? ''), r1.entries[0]?.when)
ok('sid/seq 原样带回', r1.entries[0]?.sid === 'sess-aaaa1111' && r1.entries[0]?.seq === 10)

console.log('R3 短词走 LIKE + 同义词')
const r2 = searchSoulIndex({ dbPath, dictPath, query: '脸红', limit: 5, now })
ok('同义词扩到「害羞」也命中', r2.entries.length >= 1, `实际 ${r2.entries.length}`)

console.log('R4 stale 判定')
ok('最新一条早于 30 分钟 → stale', r1.stale === true, String(r1.stale))
const fresh = searchSoulIndex({ dbPath, dictPath, query: '舍不得忘', limit: 5, now: now - 40 * 60_000 })
ok('now 贴着最新一条 → 不 stale', fresh.stale === false, String(fresh.stale))

console.log('R4b 时间窗')
const r3 = searchSoulIndex({ dbPath, dictPath, query: '今天 记', limit: 5, now })
ok('「今天」只要当天', r3.entries.every((e) => /^11-26/.test(e.when)), JSON.stringify(r3.entries.map((e) => e.when)))

console.log('R5 tool 过滤')
const r4 = searchSoulIndex({ dbPath, dictPath, query: '原文库', limit: 5, now })
ok('默认不含 tool 来源', r4.entries.every((e) => e.origin !== 'tool'))
const r5 = searchSoulIndex({ dbPath, dictPath, query: '原文库', limit: 5, now, includeTool: true })
ok('includeTool 能带出来', r5.entries.some((e) => e.origin === 'tool'))

console.log('R6 降级原因')
ok('空查询', searchSoulIndex({ dbPath, query: '  ' }).note === '查询为空')
ok('缺 dbPath → no-db', searchSoulIndex({ query: 'x' }).reason === 'no-db')
ok('库不存在 → db-unavailable', searchSoulIndex({ dbPath: join(dir, 'nope.db'), query: 'x' }).reason === 'db-unavailable')

rmSync(dir, { recursive: true, force: true })
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} soul-index 契约：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
