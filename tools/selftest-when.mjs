import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { putWhen, getWhen, readWhenMap, matchWhen, timeWindowOf, normalizeWhen, ensureWhenTable, bumpWhenHit, markWhenBad, readWhenStats, WHEN_TABLE } from '../memory/when.mjs'

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

// 9. 计数：命中 / 误报 / 老表补列（2026-11-21 第 3 条）
bumpWhenHit(dbPath, 'lesson', 'aaa-1')
bumpWhenHit(dbPath, 'lesson', 'aaa-1')
markWhenBad(dbPath, 'lesson', 'aaa-1')
const stats = readWhenStats(dbPath)
ok('stats.hit', stats.ok && stats.rows[0]?.hit_count === 2)
ok('stats.bad', stats.rows[0]?.bad_count === 1)
ok('stats.lastHit', Number(stats.rows[0]?.last_hit) > 0)
ok('stats.missing', bumpWhenHit(dbPath, 'lesson', 'nope').changes === 0)
const oldDb = new DatabaseSync(join(dir, 'old.db'))
oldDb.exec(`create table ${WHEN_TABLE} (level text not null, entry_id text not null, when_ctx text not null, updated_at integer, primary key (level, entry_id))`)
ensureWhenTable(oldDb)
const cols = new Set(oldDb.prepare(`pragma table_info(${WHEN_TABLE})`).all().map((row) => String(row.name)))
oldDb.close()
ok('migrate.hit_count', cols.has('hit_count'))
ok('migrate.bad_count', cols.has('bad_count'))
ok('migrate.last_hit', cols.has('last_hit'))

try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 上偶发 EPERM，临时目录留给系统清 */ }
if (fails.length > 0) { console.log('FAIL ' + fails.join(', ')); process.exit(1) }
// 8. tool 也支持 | 分隔（2026-11-21 修：原来只支持数组）
ok('tool.pipe.hit', matchWhen({ tool: 'write*|ops_replace' }, { tool: 'ops_replace' }) === 'hit')
ok('tool.pipe.miss', matchWhen({ tool: 'write*|ops_replace' }, { tool: 'ps' }) === 'miss')
ok('tool.array.pipe', matchWhen({ tool: ['ps', 'read|grep'] }, { tool: 'grep' }) === 'hit')
console.log('PASS 31/31 when.mjs')
