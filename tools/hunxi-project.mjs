#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/hunxi-project.mjs —— 第一刀第 2~3 步：第一版房间投影 + 每房项 profile。
 *
 * 顺序：
 *   1. 结构脚手架跑一遍（**只此一次**），把每条 frag 落进它沾到的房间
 *      → 写 room_projection(frag_id, room, evidence, method)
 *   2. 用原文级矩阵（frag_term）反推每房 profile
 *      → 写 room_profile(room, term, kind=own|shared, df)
 *   3. 用 profile 回判一批 frag，看 verdict 分布（这就是下一版的判据）
 *
 * 结构脚手架是临时脚手架，不是判据。跑完这版投影就该退场（见 HUNXI-ROADMAP §十一）。
 *
 *   node tools/hunxi-project.mjs                 # 全量
 *   node tools/hunxi-project.mjs --report        # 额外打印每房 own/ shared 高频项
 *   node tools/hunxi-project.mjs --limit 3000    # 小样本先看
 *   node tools/hunxi-project.mjs --dry-run       # 不写库
 */
import '../io-node.mjs'
import { configureStorage, openReadWrite, closeQuietly, storageStatus } from '../storage/index.mjs'
import { sqliteDriver } from '../storage/driver.mjs'
import { buildIndex, roomProfiles, classify } from '../core/tree/matrix.mjs'

const BATCH = 500

function parseArgs(argv) {
  const out = { db: '', limit: 0, dryRun: false, report: false, rebuild: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--report') out.report = true
    else if (a === '--rebuild') out.rebuild = true
    else if (a === '--db') out.db = argv[(i += 1)] || ''
    else if (a === '--limit') out.limit = Number(argv[(i += 1)] || 0) || 0
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}
function defaultDb() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return `${home.replace(/\\/g, '/')}/.dsh/soulweave/soul-memory.db`
}

/* ---------- 结构脚手架（一次性，跑完退场） ----------
 * 语义按 2026-11-27 修正：
 *   空间房 = 位置关系（有路径 + 指向/存放动作），不是「字符串像路径」
 *   程序房 = 重复出现的做法序列（先…再…、遇到…就…、流程/步骤），不是命令行
 *   执行房 = 约束 + 对象（不许/必须/拉黑…）
 *   显著房 = 情绪项 + 它挂在哪件事上
 *   情景房 = 底座，全落
 */
const PATHY = /[A-Za-z]:[\\/]|(?:^|[\s(（"'`])(?:\.[/\\]|\/)[\w.-]+[/\\]|[\w-]+\.(?:mjs|js|ts|tsx|json|md|txt|png|jpg|log|db|ps1|yml|yaml)\b|https?:\/\//i
const POSITION = /(放在|放到|存到|位于|目录|路径|哪个|在哪|指向|挪到|放进|写进|文件)/i
const SEGMENTED_PATH = /[A-Za-z]:[\\/][^\s]*[\\/]|[\\/][\w.-]+[\\/][\w.-]+/
const SEQUENCE = /(先.{0,15}再|先.{0,15}然后|遇到.{0,15}就|每次.{0,15}都|通常.{0,10}(做|用|跑)|习惯|流程|步骤|跑一遍|怎么跑|做法|顺序)/i
const CONSTRAINT = /(不许|必须|禁止|不能|记得要|规范|规则|要求|应该|不该|务必|一律|严禁|拉黑)/i
const AFFECT = /(心疼|委屈|害怕|怕|喜欢|讨厌|难过|开心|生气|在意|骄傲|失望|舍不得|晚安|亲亲|抱抱)/i

function scaffold(text) {
  const t = String(text || '')
  const out = []
  const spatial = PATHY.test(t) && (POSITION.test(t) || SEGMENTED_PATH.test(t))
  if (spatial) out.push({ room: 'spatial', evidence: '位置关系' })
  if (SEQUENCE.test(t)) out.push({ room: 'procedural', evidence: '做法序列' })
  if (CONSTRAINT.test(t)) out.push({ room: 'executive', evidence: '约束' })
  if (AFFECT.test(t)) out.push({ room: 'salient', evidence: '情绪项' })
  out.push({ room: 'episode', evidence: '底座' })
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('node tools/hunxi-project.mjs [--report] [--limit N] [--dry-run] [--rebuild] [--db path]')
  process.exit(0)
}

const dbPath = args.db || defaultDb()
configureStorage(sqliteDriver)
const db = openReadWrite(dbPath)
if (!db) {
  console.error('打不开库：', JSON.stringify(storageStatus()))
  process.exit(1)
}

const totalFrag = db.prepare('select count(*) c from frag').get().c
const totalTerm = db.prepare('select count(*) c from frag_term').get().c
if (totalTerm === 0) {
  console.error('frag_term 是空的，先跑 node tools/hunxi-matrix.mjs')
  process.exit(1)
}
const want = args.limit ? Math.min(args.limit, totalFrag) : totalFrag
console.log(`frag ${totalFrag} 条，frag_term ${totalTerm} 行，本次投影 ${want} 条`)

if (!args.dryRun) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_projection (
      frag_id  TEXT NOT NULL,
      room     TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      method   TEXT NOT NULL DEFAULT 'scaffold-structure',
      PRIMARY KEY (frag_id, room)
    );
    CREATE TABLE IF NOT EXISTS room_profile (
      room TEXT NOT NULL,
      term TEXT NOT NULL,
      kind TEXT NOT NULL,
      df   INTEGER NOT NULL,
      PRIMARY KEY (room, term)
    );
  `)
  if (args.rebuild) {
    db.exec('DELETE FROM room_projection; DELETE FROM room_profile;')
  }
}

/* ---------- 1. 结构脚手架 → 第一版投影 ---------- */
const t0 = Date.now()
const insProj = args.dryRun ? null : db.prepare(
  'INSERT OR REPLACE INTO room_projection (frag_id, room, evidence, method) VALUES (?, ?, ?, ?)',
)
const selFrag = db.prepare('select id, text from frag where id > ? order by id limit ?')
let cursor = ''
let scanned = 0
const roomSets = new Map()
const roomHits = new Map()

if (!args.dryRun) db.exec('BEGIN')
while (scanned < want) {
  const batch = selFrag.all(cursor, Math.min(BATCH, want - scanned))
  if (batch.length === 0) break
  for (const row of batch) {
    cursor = row.id
    scanned += 1
    for (const hit of scaffold(row.text)) {
      if (insProj) insProj.run(row.id, hit.room, hit.evidence, 'scaffold-structure')
      let set = roomSets.get(hit.room)
      if (!set) {
        set = new Set()
        roomSets.set(hit.room, set)
      }
      set.add(row.id)
      roomHits.set(hit.room, (roomHits.get(hit.room) || 0) + 1)
    }
  }
}
if (!args.dryRun) db.exec('COMMIT')

console.log('\n—— 第一版投影 ——')
for (const [room, ids] of [...roomSets].sort()) console.log(`${room}: ${ids.size} 条 frag`)

/* ---------- 2. 原文级矩阵反推 profile ---------- */
const postings = new Map()
{
  const sel = db.prepare('select frag_id, term from frag_term order by term')
  let cur = ''
  let set = null
  for (const row of sel.iterate()) {
    if (row.term !== cur) {
      cur = row.term
      set = new Set()
      postings.set(cur, set)
    }
    set.add(row.frag_id)
  }
}
const index = buildIndex([])
index.postings = postings
index.documents = scanned
for (const [term, set] of postings) index.df.set(term, set.size)
console.log(`\n矩阵：${postings.size} 项`)

const profiles = roomProfiles(index, roomSets, { minDocs: 2 })
console.log('\n—— 每房项 profile（复现≥2 条，跨房项已排除）——')
for (const [room, p] of [...profiles].sort()) {
  console.log(`${room}: own ${p.own.size} · shared ${p.shared.size}`)
}

const insProf = args.dryRun ? null : db.prepare(
  'INSERT OR REPLACE INTO room_profile (room, term, kind, df) VALUES (?, ?, ?, ?)',
)
if (insProf) {
  db.exec('BEGIN')
  db.exec('DELETE FROM room_profile')
  for (const [room, p] of profiles) {
    for (const term of p.own) insProf.run(room, term, 'own', index.df.get(term) || 0)
    for (const term of p.shared) insProf.run(room, term, 'shared', index.df.get(term) || 0)
  }
  db.exec('COMMIT')
}

if (args.report) {
  for (const [room, p] of [...profiles].sort()) {
    const own = [...p.own].sort((a, b) => (index.df.get(b) || 0) - (index.df.get(a) || 0)).slice(0, 30)
    const shared = [...p.shared].sort((a, b) => (index.df.get(b) || 0) - (index.df.get(a) || 0)).slice(0, 12)
    console.log(`\n## ${room}`)
    console.log('own   :', own.map((t) => `${t}(${index.df.get(t)})`).join(' '))
    console.log('shared:', shared.map((t) => `${t}(${index.df.get(t)})`).join(' '))
  }
}

/* ---------- 3. 用 profile 回判，看 verdict 分布 ---------- */
const selProbe = db.prepare('select id from frag order by random() limit 500').all()
const verdict = { only: 0, multi: 0, none: 0 }
const roomCount = {}
for (const { id } of selProbe) {
  const terms = []
  for (const [term, set] of postings) if (set.has(id)) terms.push(term)
  const got = classify(terms, profiles)
  verdict[got.verdict] += 1
  for (const r of got.rooms) roomCount[r] = (roomCount[r] || 0) + 1
}
console.log('\n—— 随机 500 条回判（下一版判据的雏形）——')
console.log(`only ${verdict.only} · multi ${verdict.multi} · none ${verdict.none}`)
console.log('落到的房：', Object.entries(roomCount).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`).join(' '))

console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
closeQuietly(db)
