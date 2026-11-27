#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/hunxi-project.mjs —— 第一刀第 2~3 步：房间投影 + 每房 profile（**句级**）。
 *
 * 2026-11-27 第五刀：粒度从 frag 改成 sentence。
 *   frag 级投影的致命伤：一条 frag 是一整轮，位置、程序、约束、情绪经常同处一轮，
 *   落房后每个项都同时属于好几间，profile 里 90% 是跨房项——那不是判据不准，是粒度错了。
 *
 * 顺序：
 *   1. 逐 frag 重新切句（与 hunxi-matrix.mjs 同一套规则），对**每一句**跑命题形态脚手架
 *      → 写 room_projection(sent_id, frag_id, room, evidence, method)
 *   2. 用句级矩阵（sent_term）反推每房 profile
 *      → 写 room_profile(room, term, kind=own|shared, df)
 *   3. 随机抽取句子用 profile 回判，看 verdict 分布；并打印每房证据样本供肉眼判断
 *
 * 脚手架是临时脚手架，不是判据。跑完这版投影就该退场（见 HUNXI-ROADMAP §十一）。
 *
 *   node tools/hunxi-project.mjs                 # 全量
 *   node tools/hunxi-project.mjs --report        # 额外打印每房 own/shared 高频项
 *   node tools/hunxi-project.mjs --samples 6     # 每房打印几条证据句
 *   node tools/hunxi-project.mjs --limit 3000    # 小样本先看
 *   node tools/hunxi-project.mjs --dry-run       # 不写库
 */
import '../io-node.mjs'
import { configureStorage, openReadWrite, closeQuietly, storageStatus } from '../storage/index.mjs'
import { sqliteDriver } from '../storage/driver.mjs'
import { buildIndex, roomProfiles, classify } from '../core/tree/matrix.mjs'

const BATCH = 500

function parseArgs(argv) {
  const out = { db: '', limit: 0, dryRun: false, report: false, samples: 0 }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--report') out.report = true
    else if (a === '--db') out.db = argv[(i += 1)] || ''
    else if (a === '--limit') out.limit = Number(argv[(i += 1)] || 0) || 0
    else if (a === '--samples') out.samples = Number(argv[(i += 1)] || 0) || 0
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function defaultDb() {
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return `${home.replace(/\\/g, '/')}/.dsh/soulweave/soul-memory.db`
}

/* ---------- 命题形态脚手架 v3（一次性，跑完退场） ----------
 *   空间房 = 主题 + 位置关系 + 处所       「X 在/放到/指向 Y」
 *   程序房 = 触发或顺序 + 第二段动作       「遇到 X 就 Y」「先 A 再 B」
 *   执行房 = 约束词 + 左右两侧都有对象      「X 必须/不许 Y」
 *   显著房 = 情绪项 + 人/挂靠对象           「我怕 X」「X 让我难受」
 *   情景房 = 底座，全落
 *
 * 一句话可以同时满足两间房（「先备份再删」既是程序也是约束）。
 * 跨房互斥只作用在 profile 的项上，不作用在句子的落点上。
 */
const SENT_SPLIT = /[。！？；\n]/
const CODEY = /```|^\s*(?:const|let|var|function|import|export|class|def|return|\$ |PS |node |git |npm |pnpm|pip )/m
const ASCII_HEAVY = /^[\x00-\x7f\s]{24,}$/

const PLACE =
  /(目录|路径|文件夹|文件|磁盘|盘符|仓库|服务器|桌面|家目录|工作区|项目里|库里|输出|输入|文档|缓存|插件|工程|机器|电脑)/
const SPATIAL_REL = /(.{1,24}?)(?:位于|放在|放到|放进|存到|存进|写进|写到|挪到|移到|搬到|指向|通往|从.{1,20}?到)(.{1,24})/

const PROC_TRIGGER = /(每次|每当|一遇到|遇到|一旦|凡是|通常|一般|习惯|默认|总是)/
const PROC_ORDER = /(先.{1,30}?再|先.{1,30}?然后|再.{1,20}?最后|做完.{1,10}?再)/
const PROC_SECOND = /(再|然后|接着|最后|就)/
const NARRATIVE = /(昨天|刚才|当时|那时候|上次|今天早上|前天|之前那回|那会儿)/

const CONSTRAINT = /(.{2,30}?)(?:必须|不许|禁止|不能|只能|只许|务必|一律|严禁|不要|别|记得)(.{2,30})/

const AFFECT = /(心疼|委屈|害怕|怕|喜欢|讨厌|难过|开心|生气|在意|骄傲|失望|舍不得|安心|舒服|难受|烦|累|晚安|亲亲|抱抱)/
const PERSON = /(我|让我|使我|搞得我|心里|胸口|眼眶|有点|特别|真的|忽然|突然)/

const MIN_SENT = 4
const SENT_RE = /[^。！？；\n]+/g

function splitSentences(text) {
  const out = []
  SENT_RE.lastIndex = 0
  let m
  while ((m = SENT_RE.exec(text))) {
    const raw = m[0]
    const lead = raw.length - raw.trimStart().length
    const body = raw.trim()
    if (body.length >= MIN_SENT) out.push({ off: m.index + lead, text: body })
  }
  return out
}

function hits(sentence, role) {
  const out = []
  if (!role) return out
  if (CODEY.test(sentence)) return out
  if (!ASCII_HEAVY.test(sentence) && PLACE.test(sentence) && SPATIAL_REL.test(sentence)) {
    out.push({ room: 'spatial', method: 'prop-v3:theme+relation+place' })
  }
  if (!NARRATIVE.test(sentence) && (PROC_TRIGGER.test(sentence) || (PROC_ORDER.test(sentence) && PROC_SECOND.test(sentence)))) {
    out.push({ room: 'procedural', method: 'prop-v3:trigger+sequence' })
  }
  if (CONSTRAINT.test(sentence)) out.push({ room: 'executive', method: 'prop-v3:constraint+object' })
  if (AFFECT.test(sentence) && PERSON.test(sentence)) out.push({ room: 'salient', method: 'prop-v3:affect+anchor' })
  return out
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('node tools/hunxi-project.mjs [--report] [--samples N] [--limit N] [--dry-run] [--db path]')
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
const totalTerm = db.prepare('select count(*) c from sent_term').get().c
if (totalTerm === 0) {
  console.error('sent_term 是空的，先跑 node tools/hunxi-matrix.mjs')
  process.exit(1)
}
const totalSent = db.prepare('select count(*) c from sent').get().c
const want = args.limit ? Math.min(args.limit, totalFrag) : totalFrag
console.log(`frag ${totalFrag} 条 · sent ${totalSent} 句 · sent_term ${totalTerm} 行，本次投影 ${want} 条 frag`)

if (!args.dryRun) {
  db.exec(`
    DROP TABLE IF EXISTS room_projection;
    CREATE TABLE room_projection (
      sent_id  TEXT NOT NULL,
      frag_id  TEXT NOT NULL,
      room     TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      method   TEXT NOT NULL DEFAULT 'prop-v3',
      PRIMARY KEY (sent_id, room)
    );
    CREATE INDEX IF NOT EXISTS room_projection_frag ON room_projection(frag_id);
    CREATE TABLE IF NOT EXISTS room_profile (
      room TEXT NOT NULL,
      term TEXT NOT NULL,
      kind TEXT NOT NULL,
      df   INTEGER NOT NULL,
      PRIMARY KEY (room, term)
    );
  `)
  db.exec('DELETE FROM room_profile')
}

/* ---------- 1. 逐句投影 ---------- */
const t0 = Date.now()
const insProj = args.dryRun
  ? null
  : db.prepare('INSERT OR REPLACE INTO room_projection (sent_id, frag_id, room, evidence, method) VALUES (?, ?, ?, ?, ?)')
const selFrag = db.prepare('select id, text, role from frag where id > ? order by id limit ?')
let cursor = ''
let scanned = 0
let sentCount = 0
const roomSets = new Map()
const roomHits = new Map()
const samples = new Map()

if (!args.dryRun) db.exec('BEGIN')
while (scanned < want) {
  const batch = selFrag.all(cursor, Math.min(BATCH, want - scanned))
  if (batch.length === 0) break
  for (const row of batch) {
    cursor = row.id
    scanned += 1
    if (!row.role) continue
    for (const part of splitSentences(String(row.text || ''))) {
      const sentId = `${row.id}#${part.off}`
      sentCount += 1
      for (const hit of hits(part.text, row.role)) {
        if (insProj) insProj.run(sentId, row.id, hit.room, part.text.slice(0, 120), hit.method)
        let set = roomSets.get(hit.room)
        if (!set) {
          set = new Set()
          roomSets.set(hit.room, set)
        }
        set.add(sentId)
        roomHits.set(hit.room, (roomHits.get(hit.room) || 0) + 1)
        if (args.samples) {
          let arr = samples.get(hit.room)
          if (!arr) {
            arr = []
            samples.set(hit.room, arr)
          }
          if (arr.length < args.samples) arr.push(part.text.slice(0, 120))
        }
      }
    }
  }
}
if (!args.dryRun) db.exec('COMMIT')

console.log('\n—— 句级投影 ——')
console.log(`共切 ${sentCount} 句`)
for (const [room, ids] of [...roomHits].sort()) console.log(`${room}: ${ids} 句`)

if (args.samples) {
  for (const [room, arr] of [...samples].sort()) {
    console.log(`\n## ${room} 证据样本`)
    for (const s of arr) console.log(' ·', s)
  }
}

/* ---------- 2. 句级矩阵反推 profile ---------- */
const postings = new Map()
{
  const sel = db.prepare('select sent_id, term from sent_term order by term')
  let cur = ''
  let set = null
  for (const row of sel.iterate()) {
    if (row.term !== cur) {
      cur = row.term
      set = new Set()
      postings.set(cur, set)
    }
    set.add(row.sent_id)
  }
}
const index = buildIndex([])
index.postings = postings
index.documents = sentCount
for (const [term, set] of postings) index.df.set(term, set.size)
console.log(`\n矩阵：${postings.size} 项 · ${sentCount} 句`)

const profiles = roomProfiles(index, roomSets)
console.log('\n—— 每房项 profile（只设一道门槛：跨房项排除）——')
for (const [room, p] of [...profiles].sort()) {
  console.log(`${room}: own ${p.own.size} · shared ${p.shared.size}`)
}

const insProf = args.dryRun
  ? null
  : db.prepare('INSERT OR REPLACE INTO room_profile (room, term, kind, df) VALUES (?, ?, ?, ?)')
if (insProf) {
  db.exec('BEGIN')
  for (const [room, p] of profiles) {
    for (const term of p.own) insProf.run(room, term, 'own', index.df.get(term) || 0)
    for (const term of p.shared) insProf.run(room, term, 'shared', index.df.get(term) || 0)
  }
  db.exec('COMMIT')
}

if (args.report) {
  for (const [room, p] of [...profiles].sort()) {
    const own = [...p.own].sort((a, b) => (index.df.get(b) || 0) - (index.df.get(a) || 0)).slice(0, 40)
    const shared = [...p.shared].sort((a, b) => (index.df.get(b) || 0) - (index.df.get(a) || 0)).slice(0, 12)
    console.log(`\n## ${room}`)
    console.log('own   :', own.map((t) => `${t}(${index.df.get(t)})`).join(' '))
    console.log('shared:', shared.map((t) => `${t}(${index.df.get(t)})`).join(' '))
  }
}

/* ---------- 3. 拿 profile 回判随机句 ---------- */
const probe = db.prepare('select sent_id from sent order by random() limit 500').all()
const verdict = { only: 0, multi: 0, none: 0 }
const roomCount = {}
for (const { sent_id: sid } of probe) {
  const terms = []
  for (const [term, set] of postings) if (set.has(sid)) terms.push(term)
  const got = classify(terms, profiles)
  verdict[got.verdict] += 1
  for (const r of got.rooms) roomCount[r] = (roomCount[r] || 0) + 1
}
console.log('\n—— 随机 500 句回判（拿 profile 反推，看项是否可分）——')
console.log(`only ${verdict.only} · multi ${verdict.multi} · none ${verdict.none}`)
console.log(
  '落到的房：',
  Object.entries(roomCount)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}:${n}`)
    .join(' ')
)

console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
closeQuietly(db)
