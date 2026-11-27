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
 *   2. 用句级矩阵（sent_term）反推每房 profile：单位是**命题对**，来源是**证据句**
 *      → 写 room_profile(room, pair_a, pair_b, sent_id, kind=own|shared)
 *   3. 随机抽取句子用 profile 回判；再用证据句本身回判（in-sample），看能不能落回自己那间
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
import { pairsOf, pairTerms, roomProfiles, classify, cascade, isArtifactTerm } from '../core/tree/matrix.mjs'

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
const SENT_RE = /[^。！？；，,、\n]+/g

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
    DROP TABLE IF EXISTS room_profile;
    CREATE TABLE room_profile (
      room    TEXT NOT NULL,
      pair_a  TEXT NOT NULL,
      pair_b  TEXT NOT NULL,
      sent_id TEXT NOT NULL,          -- 这个对是哪条证据句给出的
      kind    TEXT NOT NULL,          -- own / shared
      PRIMARY KEY (room, pair_a, pair_b, sent_id)
    );
    CREATE INDEX IF NOT EXISTS room_profile_room ON room_profile(room, kind);
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

/* ---------- 2. 从投影反推 profile：单位是命题对，来源是证据句 ---------- */
// profile 不是全库统计。全库一起建出来的是语料分布（哪对常见），不是房间判据。
// 所以只拿**证据句**的 sent_term 建索引，并让每个 pair 记住来源句。
const evIds = new Set()
for (const ids of roomSets.values()) for (const id of ids) evIds.add(id)

const pairPostings = new Map()
const termPostings = new Map() // term → 证据句集合，给「整句包含」实验用
const evTerms = new Map()      // 证据句 → 词集
{
  db.exec('CREATE TEMP TABLE IF NOT EXISTS ev (sent_id TEXT PRIMARY KEY)')
  db.exec('DELETE FROM ev')
  const insEv = db.prepare('INSERT OR IGNORE INTO ev (sent_id) VALUES (?)')
  db.exec('BEGIN')
  for (const id of evIds) insEv.run(id)
  db.exec('COMMIT')

  const sel = db.prepare(
    'select st.sent_id as sid, st.term as term from sent_term st join ev on ev.sent_id = st.sent_id order by st.sent_id'
  )
  let cur = ''
  let buf = []
  const flush = () => {
    if (!cur) return
    const kept = buf.filter((t) => !isArtifactTerm(t))
    evTerms.set(cur, new Set(kept))
    for (const t of kept) {
      let s = termPostings.get(t)
      if (!s) { s = new Set(); termPostings.set(t, s) }
      s.add(cur)
    }
    for (const key of pairsOf(buf)) {
      let set = pairPostings.get(key)
      if (!set) {
        set = new Set()
        pairPostings.set(key, set)
      }
      set.add(cur)
    }
  }
  for (const row of sel.iterate()) {
    if (row.sid !== cur) {
      flush()
      cur = row.sid
      buf = []
    }
    buf.push(row.term)
  }
  flush()
}
const index = { postings: pairPostings, docs: evIds.size }
console.log(`\n命题对矩阵：${pairPostings.size} 对 · ${evIds.size} 条证据句`)

const profiles = roomProfiles(index, roomSets)
console.log('\n—— 每房命题对 profile（唯一门槛：跨房项排除）——')
for (const [room, p] of [...profiles].sort()) {
  console.log(`${room}: own ${p.own.size} · shared ${p.shared.size}`)
}

const insProf = args.dryRun
  ? null
  : db.prepare('INSERT OR REPLACE INTO room_profile (room, pair_a, pair_b, sent_id, kind) VALUES (?, ?, ?, ?, ?)')
if (insProf) {
  db.exec('BEGIN')
  for (const [room, p] of profiles) {
    for (const item of p.profile) {
      const [a, b] = pairTerms(item.pair)
      for (const sid of item.ids) insProf.run(room, a, b, sid, 'own')
    }
    for (const pair of p.shared) {
      const ids = index.postings.get(pair) || new Set()
      const sid = ids.values().next().value || ''
      const [a, b] = pairTerms(pair)
      insProf.run(room, a, b, sid, 'shared')
    }
  }
  db.exec('COMMIT')
}

if (args.report) {
  const nSent = (pair) => (index.postings.get(pair) || new Set()).size
  const shown = (pair) => {
    const [a, b] = pairTerms(pair)
    return `${a}·${b}(${nSent(pair)})`
  }
  for (const [room, p] of [...profiles].sort()) {
    const own = [...p.own].sort((a, b) => nSent(b) - nSent(a)).slice(0, 40)
    const shared = [...p.shared].sort((a, b) => nSent(b) - nSent(a)).slice(0, 12)
    console.log(`\n## ${room}`)
    console.log('own   :', own.map(shown).join(' '))
    console.log('shared:', shared.map(shown).join(' '))
  }
}

/* ---------- 3. 回判 ---------- */
const selTerms = db.prepare('select term from sent_term where sent_id = ?')
const termsOf = (sid) => selTerms.all(sid).map((r) => r.term)

const PROBE = 500
const probe = db.prepare('select sent_id from sent order by random() limit ?').all(PROBE)
const verdict = { only: 0, multi: 0, none: 0 }
const roomCount = {}
const selSent = db.prepare('select frag_id as fid, off as off, len as len from sent where sent_id = ?')
const selFragText = db.prepare('select text from frag where id = ?')
const sentText = (sid) => {
  const r = selSent.get(sid)
  if (!r) return ''
  const f = selFragText.get(r.fid)
  return f ? String(f.text).slice(r.off, r.off + r.len) : ''
}
const hitSamples = []
for (const { sent_id: sid } of probe) {
  const got = classify(pairsOf(termsOf(sid)), profiles)
  verdict[got.verdict] += 1
  for (const r of got.rooms) roomCount[r] = (roomCount[r] || 0) + 1
  if (got.verdict !== 'none' && hitSamples.length < 14) {
    const room = got.rooms[0]
    const ev = (got.evidence[room] || []).slice(0, 3).join(' ')
    hitSamples.push(`[${got.verdict}:${room}] ${sentText(sid).slice(0, 80)}  ← ${ev}`)
  }
}
console.log(`\n—— 随机 ${PROBE} 句回判（整库抽样）——`)
console.log(`only ${verdict.only} · multi ${verdict.multi} · none ${verdict.none}`)
for (const s of hitSamples) console.log('  ·', s)
console.log(
  '落到的房：',
  Object.entries(roomCount)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}:${n}`)
    .join(' ')
)

// in-sample：拿证据句回判，看能不能落回自己那间。乐观估计（判据就是从这些句子长的），
// 但能回答一个关键问题：profile 到底记住了「命题」，还是只记住了「稀有词」。
const truth = new Map()
for (const [room, ids] of roomSets) {
  for (const id of ids) {
    let set = truth.get(id)
    if (!set) {
      set = new Set()
      truth.set(id, set)
    }
    set.add(room)
  }
}
const evList = [...evIds]
const evProbe = []
for (let i = 0; i < Math.min(PROBE, evList.length); i += 1) {
  evProbe.push(evList[Math.floor(Math.random() * evList.length)])
}
const self = { onlyRight: 0, onlyWrong: 0, multiHasOwn: 0, multiMissOwn: 0, none: 0 }
const wrongSamples = []
for (const sid of evProbe) {
  const got = classify(pairsOf(termsOf(sid)), profiles)
  const own = truth.get(sid) || new Set()
  const hit = got.rooms.some((r) => own.has(r))
  if (got.verdict === 'none') self.none += 1
  else if (got.verdict === 'only') {
    if (hit) self.onlyRight += 1
    else {
      self.onlyWrong += 1
      if (wrongSamples.length < 10) wrongSamples.push(`${got.rooms[0]} ← 真 ${[...own].join('+')}`)
    }
  } else if (hit) self.multiHasOwn += 1
  else self.multiMissOwn += 1
}
console.log(`\n—— 证据句回判（in-sample，${evProbe.length} 条）——`)
console.log(
  `只中一间且对 ${self.onlyRight} · 只中一间但错 ${self.onlyWrong} · 多间含自己 ${self.multiHasOwn} · 多间漏自己 ${self.multiMissOwn} · 无命中 ${self.none}`
)
if (wrongSamples.length) console.log('错判样本：', wrongSamples.join(' | '))

/* ---------- 4. 多判据级联（--report 时跑） ---------- */
// 判据一：本句的命题对命中该房 own（句内共现）
// 判据二：本句整词集 ⊆ 某条该房证据句（同一条证据句给出这个房间）
// 判据三：同源——本句所属 frag 里已有该房证据句（同源即突触）
// 目标不是「判对每一句」，是「三判据同时成立的召回要少而准；
// 两判据次之；只剩一条的当联想，不当判据」。
if (args.report) {
  const fragRooms = new Map()
  for (const [room, ids] of roomSets) {
    for (const sid of ids) {
      const hash = sid.indexOf('#')
      const fid = hash < 0 ? sid : sid.slice(0, hash)
      let s = fragRooms.get(fid)
      if (!s) {
        s = new Set()
        fragRooms.set(fid, s)
      }
      s.add(room)
    }
  }
  const selFragOf = db.prepare('select frag_id as fid from sent where sent_id = ?')
  const fragOf = (sid) => {
    const r = selFragOf.get(sid)
    if (r) return r.fid
    const hash = sid.indexOf('#')
    return hash < 0 ? sid : sid.slice(0, hash)
  }
  const selOff = db.prepare('select frag_id as fid, off as off from sent where sent_id = ?')
  const selPrev = db.prepare('select sent_id from sent where frag_id = ? and off < ? order by off desc limit 1')
  const selNext = db.prepare('select sent_id from sent where frag_id = ? and off > ? order by off asc limit 1')
  const adjacentRooms = (sid) => {
    const out = new Set()
    const r = selOff.get(sid)
    if (!r) return out
    for (const q of [selPrev, selNext]) {
      const row = q.get(r.fid, r.off)
      if (row) for (const room of truth.get(row.sent_id) || []) out.add(room)
    }
    return out
  }
  const containRooms = (terms) => {
    const rooms = new Set()
    if (terms.length < 2) return rooms
    let cand = null
    for (const t of terms) {
      const s = termPostings.get(t)
      if (!s) return rooms
      cand = cand ? new Set([...cand].filter((x) => s.has(x))) : new Set(s)
      if (!cand.size) return rooms
    }
    for (const ev of cand) for (const r of truth.get(ev) || []) rooms.add(r)
    return rooms
  }

  const N = 1000
  const probe3 = db.prepare('select sent_id from sent order by random() limit ?').all(N)
  const dist = { 3: 0, 2: 0, 1: 0, 0: 0 }
  const fired = { pair: 0, contain: 0, source: 0 }
  const samples = { 3: [], 2: [], 1: [] }
  for (const { sent_id: sid } of probe3) {
    const terms = [...new Set(termsOf(sid))].filter((t) => !isArtifactTerm(t))
    const pairs = pairsOf(terms)
    const cr = containRooms(terms)
    const fr = adjacentRooms(sid)
    if ([...profiles.values()].some((p) => pairs.some((k) => p.own.has(k)))) fired.pair += 1
    if (cr.size) fired.contain += 1
    if (fr.size) fired.source += 1
    const hits = new Map()
    for (const [room, p] of profiles) {
      const c = new Set()
      if (pairs.some((k) => p.own.has(k))) c.add('pair')
      if (cr.has(room)) c.add('contain')
      if (fr.has(room)) c.add('source')
      if (c.size) hits.set(room, c)
    }
    const got = cascade(hits)
    dist[got.level] += 1
    if (got.level > 0 && samples[got.level] && samples[got.level].length < 8) {
      samples[got.level].push(`[${got.rooms.join('+')}] ${sentText(sid).slice(0, 70)}`)
    }
  }
  console.log(`\n—— 多判据级联（随机 ${N} 句）——`)
  console.log(`单判据触发率：pair ${fired.pair} · contain ${fired.contain} · source ${fired.source} / ${N}`)
  console.log(`三判据 ${dist[3]} · 两判据 ${dist[2]} · 单判据(联想) ${dist[1]} · 无 ${dist[0]}`)
  for (const k of [3, 2, 1]) {
    console.log(`\n== ${k} 判据样本 ==`)
    for (const s of samples[k]) console.log('  ·', s)
  }
}

console.log(`\n用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
closeQuietly(db)
