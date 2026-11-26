#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/bench-recall.mjs —— 记忆规模 × 召回耗时实测。
 *
 * 只量一件事：builtin 记忆池（soul_recall 的主源）在 N 条数据下的检索耗时。
 * 十万条是幻想场景；这里量 500 / 2k / 10k，因为真实库现在就几十条，
 * 十年也到不了十万。真正要证明的是「线性增长但常数很小」。
 *
 * 用法：node tools/bench-recall.mjs [--sizes 500,2000,10000] [--rounds 15]
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { search } from '../memory/builtin.mjs'

const args = process.argv.slice(2)
function opt(name, fallback) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : fallback
}
const sizes = String(opt('sizes', '500,2000,10000')).split(',').map((n) => Number(n.trim())).filter((n) => n > 0)
const rounds = Number(opt('rounds', 15))

const WORDS = ['魂织', '记忆', '召回', '纳', '小汐', '预算', '注入', '人格', '项目', '决策', '插件', '边界']
function randomText(i) {
  const a = WORDS[i % WORDS.length]
  const b = WORDS[(i * 7 + 3) % WORDS.length]
  return `${a}${b}第${i}条：这是一条用来压测召回的记忆正文，长度接近真实条目。`
}

const root = mkdtempSync(join(tmpdir(), 'soul-bench-recall-'))
const rows = []
try {
  for (const n of sizes) {
    const dbPath = join(root, `bench-${n}.db`)
    const db = new DatabaseSync(dbPath)
    db.exec(`
      create table memories (
        id text primary key, title text default '', content text not null,
        keywords text default '', importance integer default 1, status text default 'active',
        corrected integer default 0, project text default '', level text default 'fact',
        created_at integer, updated_at integer, sha text default '',
        source_session text default '', source_turn text default '', goal text default '',
        version integer default 1
      );
    `)
    const insert = db.prepare('insert into memories (id,title,content,keywords,importance,status,level,created_at,updated_at,sha) values (?,?,?,?,?,?,?,?,?,?)')
    const now = Date.now()
    db.exec('begin')
    for (let i = 0; i < n; i += 1) {
      insert.run(`m-bench-${i}`, `标题${i}`, randomText(i), WORDS[i % WORDS.length], (i % 4) + 1, 'active', 'fact', now, now, `sha${i}`)
    }
    db.exec('commit')
    db.close()

    const times = []
    for (let r = 0; r < rounds; r += 1) {
      const t0 = performance.now()
      search(dbPath, [WORDS[r % WORDS.length]], 10)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    const median = times[Math.floor(times.length / 2)]
    const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]
    rows.push({ n, median, p95, max: times[times.length - 1] })
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log('记忆条数 | 中位耗时 | p95    | 最慢')
console.log('---------|----------|--------|--------')
for (const r of rows) {
  console.log(`${String(r.n).padStart(8)} | ${r.median.toFixed(2).padStart(6)}ms | ${r.p95.toFixed(2).padStart(5)}ms | ${r.max.toFixed(2)}ms`)
}
const perRow = rows.length > 1 ? (rows[rows.length - 1].median - rows[0].median) / (rows[rows.length - 1].n - rows[0].n) : 0
console.log(`\n增量成本约 ${(perRow * 1000).toFixed(4)} µs/条（中位耗时斜率）`)
