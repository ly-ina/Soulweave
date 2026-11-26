// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
// 阶段衰退自测：node tools/selftest-decay.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { previewDecay, applyDecay, detectKind } from '../memory/decay.mjs'

const NOW = 1795263383996 // 2026-11-21T20:16:23+08:00
const DAY = 86_400_000
let pass = 0
function ok(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ok ${pass}. ${name}`)
  } catch (err) {
    console.error(`  FAIL ${name}\n${err?.stack ?? err}`)
    process.exitCode = 1
  }
}

const dir = mkdtempSync(join(tmpdir(), 'decay-'))
const dbPath = join(dir, 'meow.db')
{
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table fact(id text primary key,title text,content text,keywords text,importance integer,status text,
      lifecycle text,hit_count integer,last_accessed_at integer,created_at integer,updated_at integer);
    create table lesson(id text primary key,title text,content text,keywords text,importance integer,status text,
      lifecycle text,corrected integer,hit_count integer,last_accessed_at integer,created_at integer,updated_at integer);
    create table topic(id text primary key,title text,content text,keywords text,importance integer,status text,
      lifecycle text,hit_count integer,last_accessed_at integer,created_at integer,updated_at integer);
    create table project(id text primary key,title text,content text,keywords text,importance integer,status text,
      lifecycle text,hit_count integer,last_accessed_at integer,created_at integer,updated_at integer);
    create table memory_event(id integer primary key autoincrement,at integer,action text,entry_table text,entry_id text,detail text);
  `)
  const ins = db.prepare(
    'insert into fact(id,title,content,keywords,importance,status,lifecycle,hit_count,last_accessed_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)',
  )
  ins.run('A', '老 fact', '正文A', '["甲"]', 2, 'active', 'normal', 0, null, NOW - 60 * DAY, NOW - 60 * DAY)
  ins.run('B', '已沉底', '正文B', '["乙","decay:沉底@2026-09-01"]', 1, 'active', 'normal', 0, null, NOW - 100 * DAY, NOW - 100 * DAY)
  ins.run('C', '新 fact', '正文C', '["丙"]', 2, 'active', 'normal', 0, null, NOW - 5 * DAY, NOW - 5 * DAY)
  ins.run('D', '重要 fact', '正文D', '["丁"]', 3, 'active', 'normal', 0, null, NOW - 300 * DAY, NOW - 300 * DAY)
  ins.run('E', 'pinned', '正文E', '["戊"]', 1, 'active', 'pinned', 0, null, NOW - 300 * DAY, NOW - 300 * DAY)
  ins.run('G', '刚沉底', '正文G', '["庚","decay:沉底@2026-11-10"]', 2, 'active', 'normal', 0, null, NOW - 90 * DAY, NOW - 90 * DAY)
  ins.run('H', '沉底后又用上', '正文H', '["辛","decay:沉底@2026-09-01"]', 1, 'active', 'normal', 1, NOW - 5 * DAY, NOW - 120 * DAY, NOW - 5 * DAY)
  // 关键回归：dsh-toy 潮的八档里有「沉底」这个档位名，裸词不是标记
  ins.run('I', '裸沉底（潮档位）', '正文I', '["壬","沉底","潮"]', 2, 'active', 'normal', 0, null, NOW - 80 * DAY, NOW - 80 * DAY)
  db.prepare(
    'insert into lesson(id,title,content,keywords,importance,status,lifecycle,corrected,hit_count,last_accessed_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run('F', '被纠正的 lesson', '正文F', '["癸"]', 1, 'active', 'normal', 1, 0, null, NOW - 200 * DAY, NOW - 200 * DAY)
  db.close()
}

console.log('== 1. 预览 ==')
let prev
ok('detectKind = meow', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(detectKind(db), 'meow')
  db.close()
})
ok('候选 3 条：A sink / B stale / I 只是普通 sink；裸「沉底」不被当标记', () => {
  prev = previewDecay(dbPath, { now: NOW })
  assert.equal(prev.ok, true)
  assert.equal(prev.kind, 'meow')
  assert.equal(prev.candidates.length, 3, JSON.stringify(prev.candidates))
  const m = new Map(prev.candidates.map((c) => [c.id, c]))
  assert.equal(m.get('A').stage, 'sink')
  assert.equal(m.get('B').stage, 'stale')
  assert.equal(m.get('I').stage, 'sink') // 裸词不能把它变成 stale 或补日期
  for (const id of ['C', 'D', 'E', 'F', 'G', 'H']) assert.equal(m.has(id), false, `${id} 不该进候选`)
})

console.log('== 2. 动手（带备份） ==')
let res
ok('apply 成功、给 backup、改 3 条', () => {
  res = applyDecay(dbPath, prev.candidates.map((c) => ({ table: c.table, id: c.id, stage: c.stage })), { now: NOW })
  assert.equal(res.ok, true, JSON.stringify(res))
  assert.equal(res.changed.length, 3)
  assert.ok(existsSync(res.backup))
})
ok('A: importance 2→1，keywords 带前缀日期', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const r = db.prepare('select * from fact where id=?').get('A')
  assert.equal(r.importance, 1)
  assert.ok(String(r.keywords).includes('decay:沉底@2026-11-21'))
  assert.equal(r.content, '正文A')
  db.close()
})
ok('B: status 变 stale，content 未动', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const r = db.prepare('select * from fact where id=?').get('B')
  assert.equal(r.status, 'stale')
  assert.equal(r.content, '正文B')
  db.close()
})
ok('I：裸词原样保留，只追加自家标记', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const r = db.prepare('select * from fact where id=?').get('I')
  const kws = JSON.parse(r.keywords)
  assert.ok(kws.includes('沉底'), '潮的档位名不能被删')
  assert.ok(kws.includes('decay:沉底@2026-11-21'))
  assert.equal(r.importance, 1)
  assert.equal(r.status, 'active')
  db.close()
})
ok('未入选的 C/D/E/F/G/H 一字未变', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  for (const id of ['C', 'D', 'E', 'G', 'H']) {
    const r = db.prepare('select * from fact where id=?').get(id)
    assert.equal(r.status, 'active')
  }
  const f = db.prepare('select * from lesson where id=?').get('F')
  assert.equal(f.importance, 1)
  assert.equal(f.status, 'active')
  db.close()
})
ok('memory_event 记了 3 条', () => {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(db.prepare('select count(*) c from memory_event').get().c, 3)
  db.close()
})

console.log('== 3. 幂等 / 防并发 ==')
ok('再预览 → 0 候选', () => {
  const p2 = previewDecay(dbPath, { now: NOW })
  assert.equal(p2.candidates.length, 0, JSON.stringify(p2.candidates))
})
ok('拿过期 picks 再 apply → 拒绝', () => {
  const r = applyDecay(dbPath, prev.candidates.map((c) => ({ table: c.table, id: c.id, stage: c.stage })), { now: NOW })
  assert.equal(r.ok, false)
  assert.ok(r.stale.length > 0)
})
ok('不存在的 id → 拒绝', () => {
  const r = applyDecay(dbPath, [{ table: 'fact', id: 'NOPE', stage: 'sink' }], { now: NOW })
  assert.equal(r.ok, false)
})

console.log('== 4. builtin 后端 ==')
const bPath = join(dir, 'builtin.db')
{
  const db = new DatabaseSync(bPath)
  db.exec(`create table memories(id text primary key,title text,content text,keywords text,importance integer,
    status text,corrected integer,project text,level text,created_at integer,updated_at integer);`)
  const ins = db.prepare('insert into memories values (?,?,?,?,?,?,?,?,?,?,?)')
  ins.run('b1', '老', '正文b1', '["甲"]', 2, 'active', 0, '', 'lesson', NOW - 90 * DAY, NOW - 90 * DAY)
  ins.run('b2', '新', '正文b2', '["乙"]', 2, 'active', 0, '', 'lesson', NOW - 2 * DAY, NOW - 2 * DAY)
  db.close()
}
ok('builtin: kind + 1 候选 + apply 生效', () => {
  const p = previewDecay(bPath, { now: NOW })
  assert.equal(p.kind, 'builtin')
  assert.equal(p.candidates.length, 1)
  const r = applyDecay(bPath, [{ table: 'lesson', id: 'b1', stage: 'sink' }], { now: NOW })
  assert.equal(r.ok, true, JSON.stringify(r))
  const db = new DatabaseSync(bPath, { readOnly: true })
  const row = db.prepare('select * from memories where id=?').get('b1')
  assert.equal(row.importance, 1)
  assert.ok(String(row.keywords).includes('decay:沉底@2026-11-21'))
  assert.equal(row.content, '正文b1')
  db.close()
})

rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
console.log(`\n${process.exitCode ? 'FAILED' : 'PASS'} — ${pass} 条通过`)