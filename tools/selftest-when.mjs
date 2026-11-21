import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { putWhen, getWhen, readWhenMap, matchWhen, timeWindowOf, normalizeWhen, WHEN_TABLE } from '../memory/when.mjs'

const dir = mkdtempSync(join(tmpdir(), 'when-test-'))
const dbPath = join(dir, 'memory.db')
const db = new DatabaseSync(dbPath)
db.exec("create table lesson (id text primary key, content text, status text default 'active')")
db.prepare("insert into lesson (id, content) values (?, ?)").run('aaa-1', '改中文源码用 read/write/edit')
db.close()

const fails = []
const ok = (name, cond) => { if (!cond) fails.push(name) }

// 1. 写入 + 读回
const w = putWhen(dbPath, 'lesson', 'aaa-1', { tool: ['write', 'edit'], pathPattern: '*.md|*.mjs', timeWindow: 'night' })
ok('putWhen', w.ok === true)
const back = getWhen(dbPath, 'lesson', 'aaa-1')
ok('getWhen.tool', Array.isArray(back?.tool) && back.tool.length === 2)
ok('getWhen.pathPattern', back?.pathPattern === '*.md|*.mjs')

// 2. 命中 / 不命中
ok('hit.write.md', matchWhen(back, { tool: 'write', path: 'E:/x/a.md', timeWindow: 'night' }) === 'hit')
ok('hit.edit.mjs', matchWhen(back, { tool: 'edit', path: 'b.mjs', timeWindow: 'night' }) === 'hit')
ok('miss.read', matchWhen(back, { tool: 'read', path: 'a.md', timeWindow: 'night' }) === 'miss')
ok('miss.txt', matchWhen(back, { tool: 'write', path: 'a.txt', timeWindow: 'night' }) === 'miss')
ok('miss.daytime', matchWhen(back, { tool: 'write', path: 'a.md', timeWindow: 'morning' }) === 'miss')
ok('null.none', matchWhen(null, { tool: 'write' }) === null)

// 3. 通配
ok('wild.write*', matchWhen({ tool: 'write*' }, { tool: 'write_file' }) === 'hit')
ok('wild.*md', matchWhen({ pathPattern: '*md' }, { path: 'x/y/z.md' }) === 'hit')
ok('wild.miss', matchWhen({ pathPattern: '*.ts' }, { path: 'z.md' }) === 'miss')

// 4. readWhenMap
const mapDb = new DatabaseSync(dbPath, { readOnly: true })
const map = readWhenMap(mapDb)
mapDb.close()
ok('map.size', map.size === 1)
ok('map.key', map.has('lesson#aaa-1'))

// 5. 幂等 upsert
putWhen(dbPath, 'lesson', 'aaa-1', { tool: 'read' })
const again = getWhen(dbPath, 'lesson', 'aaa-1')
ok('upsert', again?.tool === 'read' && again?.pathPattern === undefined)

// 6. 脏输入
ok('normalize.empty', normalizeWhen({ foo: 1 }) === null)
ok('normalize.null', normalizeWhen(null) === null)
ok('normalize.trim', normalizeWhen({ tool: '  write  ' })?.tool === 'write')

// 7. 时间窗
ok('tw.night', timeWindowOf(new Date(2026, 10, 21, 23, 0)) === 'night')
ok('tw.morning', timeWindowOf(new Date(2026, 10, 21, 8, 0)) === 'morning')

try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 上偶发 EPERM，临时目录留给系统清 */ }
if (fails.length > 0) { console.log('FAIL ' + fails.join(', ')); process.exit(1) }
console.log('PASS 20/20 when.mjs')
