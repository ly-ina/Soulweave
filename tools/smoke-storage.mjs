#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/smoke-storage.mjs —— storage/ 层契约自检。
 *
 * 只验契约不验业务：打不开要 null、句柄形状要对、withReadonly 必关、
 * configureStorage 能换驱动、换完复位。
 */
import { DatabaseSync } from 'node:sqlite'
import '../io-node.mjs'
import '../storage/node-sqlite.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configureStorage,
  storageDriverName,
  storageStatus,
  openReadonly,
  openReadWrite,
  withReadonly,
  closeQuietly,
} from '../storage/index.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'soulweave-storage-'))
const dbPath = join(dir, 't.db')

try {
  console.log('S1 只读打开 / 不存在的路径')
  ok('不存在的库返回 null', openReadonly(join(dir, 'nope.db')) === null)
  ok('空路径返回 null', openReadonly('') === null)
  ok('目录返回 null', openReadonly(dir) === null)

  console.log('S2 读写建库 + 句柄形状')
  const w = openReadWrite(dbPath)
  ok('openReadWrite 拿到句柄', Boolean(w))
  w.exec('create table t (id integer primary key, name text)')
  w.prepare('insert into t (name) values (?)').run('甲')
  closeQuietly(w)

  const r = openReadonly(dbPath)
  ok('只读句柄有 prepare/exec/close', typeof r.prepare === 'function' && typeof r.exec === 'function' && typeof r.close === 'function')
  ok('查得到行', r.prepare('select name from t where id = 1').get()?.name === '甲')
  ok('all 返回数组', r.prepare('select * from t').all().length === 1)
  closeQuietly(r)

  console.log('S3 只读连接不许写')
  const ro = openReadonly(dbPath)
  let blocked = false
  try { ro.prepare("insert into t (name) values ('乙')").run() } catch { blocked = true }
  ok('只读库写入被拒', blocked)
  closeQuietly(ro)

  console.log('S4 withReadonly 必关 + 异常降级')
  let seen = null
  const value = withReadonly(dbPath, (db) => { seen = db; return db.prepare('select count(*) c from t').get().c }, -1)
  ok('withReadonly 返回 fn 结果', value === 1)
  let closed = false
  try { seen.prepare('select 1').get() } catch { closed = true }
  ok('withReadonly 结束后句柄已关', closed)
  ok('库不存在走 fallback', withReadonly(join(dir, 'nope.db'), () => 'x', 'fb') === 'fb')
  ok('fn 抛错走 fallback', withReadonly(dbPath, () => { throw new Error('boom') }, 'fb') === 'fb')

  console.log('S5 换驱动')
  const calls = []
  const fake = {
    name: 'fake',
    open(path, opts) {
      calls.push({ path, opts })
      return { prepare: () => ({ get: () => ({ v: 42 }), all: () => [], run: () => ({}) }), exec: () => {}, close: () => {} }
    },
  }
  configureStorage(fake)
  ok('驱动名切换', storageDriverName() === 'fake')
  ok('查询走假驱动', openReadonly(dbPath).prepare('select 1').get().v === 42)
  ok('readOnly 传下去了', calls.at(-1)?.opts?.readOnly === true)
  configureStorage(null)
  ok('复位成无驱动（1.0 起默认不带驱动）', storageDriverName() === 'none')

  console.log('S5b 诊断能说出为什么打不开')
  ok('无驱动时 openReadonly 返回 null', openReadonly(dbPath) === null)
  ok('原因 no-driver（不是 not-a-file）', storageStatus().lastFailure?.reason === 'no-driver')
  ok('no-driver 时 ready=false', storageStatus().ready === false)
  configureStorage(fake)
  ok('装上驱动后 ready=true', storageStatus().ready === true)
  ok('库不存在原因 not-a-file', openReadonly(join(dir, 'nope.db')) === null && storageStatus().lastFailure?.reason === 'not-a-file')
  ok('空路径原因 no-path', openReadonly('') === null && storageStatus().lastFailure?.reason === 'no-path')
  configureStorage(null)

  console.log('S6 closeQuietly 不抛')
  let threw = false
  try { closeQuietly(null); closeQuietly({ close() { throw new Error('x') } }) } catch { threw = true }
  ok('closeQuietly 吞掉异常', !threw)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} storage 契约：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
