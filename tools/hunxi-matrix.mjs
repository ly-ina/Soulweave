#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/hunxi-matrix.mjs —— 第一刀第 1 步：建原文级矩阵 `sentence × term`。
 *
 * 现有的 kw_link 键是 (summary_id, kw_id)，共现建在 8 018 条摘要上，是二手矩阵。
 * 这一步直接扫 30 270 条 frag 原文，产出原文级词链接。零模型、可重跑。
 *
 * 2026-11-27 第五刀：**粒度从 frag 改成 sentence**。
 *   原因：一条 frag 是一整轮对话，可能同时含位置、程序、约束、情绪。
 *   frag 级共现等于「什么都和什么共现」，profile 里 90% 的项跨房——
 *   这不是判据不准，是矩阵粒度错了。句级共现才对应命题。
 *   同时 sent.off/len 直接当定位器：不复制原文，指得回去。
 *
 *   node tools/hunxi-matrix.mjs                # 全量重建写入 frag_term
 *   node tools/hunxi-matrix.mjs --dry-run      # 只统计不写库
 *   node tools/hunxi-matrix.mjs --limit 2000   # 先跑一小段看速度
 *   node tools/hunxi-matrix.mjs --db <path>    # 指定库（默认 ~/.dsh/soulweave/soul-memory.db）
 *
 * 写的是派生表：`DROP TABLE frag_term` 即撤销，原文一个字不动。
 */
import '../io-node.mjs'
import { createTokenizer } from '../core/tree/terms.mjs'
import { configureStorage, openReadWrite, closeQuietly, storageStatus } from '../storage/index.mjs'
import { sqliteDriver } from '../storage/driver.mjs'

const BATCH = 500

function parseArgs(argv) {
  const out = { db: '', limit: 0, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
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

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('node tools/hunxi-matrix.mjs [--dry-run] [--limit N] [--db path]')
  process.exit(0)
}

const tokenizer = createTokenizer()
if (tokenizer.size === 0) {
  console.error('词表为空：io-node.mjs 没有先于 core 模块加载。')
  process.exit(2)
}
console.log(`词表 ${tokenizer.size} 词`)

const dbPath = args.db || defaultDb()
console.log(`库 ${dbPath}`)

configureStorage(sqliteDriver)
const db = openReadWrite(dbPath)
if (!db) {
  console.error('打不开库：', JSON.stringify(storageStatus()))
  process.exit(1)
}

const t0 = Date.now()
const total = db.prepare('select count(*) c from frag').get().c
const want = args.limit ? Math.min(args.limit, total) : total
console.log(`frag ${total} 条，本次扫 ${want} 条`)

if (!args.dryRun) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sent (
      sent_id TEXT PRIMARY KEY,
      frag_id TEXT NOT NULL,
      off     INTEGER NOT NULL,
      len     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sent_frag ON sent(frag_id);
    CREATE TABLE IF NOT EXISTS sent_term (
      sent_id TEXT NOT NULL,
      term    TEXT NOT NULL,
      tf      INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (sent_id, term)
    );
    CREATE INDEX IF NOT EXISTS sent_term_term ON sent_term(term);
  `)
  db.exec('DELETE FROM sent')
  db.exec('DELETE FROM sent_term')
}

const insertSent = args.dryRun ? null : db.prepare('INSERT OR REPLACE INTO sent (sent_id, frag_id, off, len) VALUES (?, ?, ?, ?)')
const insert = args.dryRun ? null : db.prepare('INSERT OR REPLACE INTO sent_term (sent_id, term, tf) VALUES (?, ?, ?)')
const page = db.prepare('select id, text from frag where id > ? order by id limit ?')

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

let cursor = ''
let scanned = 0
let rows = 0
let empty = 0
let sents = 0
const termDf = new Map()

db.exec('BEGIN')
while (scanned < want) {
  const take = Math.min(BATCH, want - scanned)
  const batch = page.all(cursor, take)
  if (batch.length === 0) break
  for (const row of batch) {
    cursor = row.id
    scanned += 1
    const parts = splitSentences(String(row.text || ''))
    if (parts.length === 0) {
      empty += 1
      continue
    }
    for (const part of parts) {
      const sentId = `${row.id}#${part.off}`
      const terms = tokenizer.tokenize(part.text)
      if (terms.length === 0) continue
      if (insertSent) insertSent.run(sentId, row.id, part.off, part.text.length)
      sents += 1
      const tf = new Map()
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1)
      for (const [term, n] of tf) {
        termDf.set(term, (termDf.get(term) || 0) + 1)
        if (insert) insert.run(sentId, term, n)
        rows += 1
      }
    }
  }
  if (!args.dryRun && scanned % (BATCH * 10) === 0) {
    db.exec('COMMIT')
    db.exec('BEGIN')
  }
  if (scanned % 5000 === 0) {
    const sec = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`  ${scanned}/${want} 条 · ${rows} 行 · ${sec}s`)
  }
}
db.exec('COMMIT')

const reprised = [...termDf.values()].filter((n) => n >= 2).length
const avg = scanned ? (rows / scanned).toFixed(1) : '0'
console.log('\n—— 结果 ——')
console.log(`扫 ${scanned} 条 frag → ${sents} 句，写入 ${rows} 行词链接（平均 ${avg} 词/句）`)
console.log(`空词 ${empty} 条 · 不同 term ${termDf.size} 个 · 复现(≥2 句) ${reprised} 个`)

const top = [...termDf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
console.log('\n最高频 25 项：')
console.log(top.map(([t, n]) => `${t}(${n})`).join('  '))

if (!args.dryRun) {
  const s = db.prepare('select count(*) c from sent').get().c
  const t = db.prepare('select count(*) c from sent_term').get().c
  console.log(`\nsent 现有 ${s} 行 · sent_term 现有 ${t} 行`)
}
console.log(`用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
closeQuietly(db)
