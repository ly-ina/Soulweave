#!/usr/bin/env node
/**
 * tools/when.mjs —— 给记忆条目签情境（第 1 条的命令行入口）。
 *
 *   node tools/when.mjs set <level> <id> '{"tool":"write","pathPattern":"*.md"}'
 *   node tools/when.mjs get <level> <id>
 *   node tools/when.mjs del <level> <id>
 *   node tools/when.mjs list
 *   node tools/when.mjs probe '{"tool":"write","path":"a.md"}'   # 看哪些条目会命中
 *
 * 记忆库路径默认为 <workspace>/.dsh-meow/memory.db，可用 --db 覆盖。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { putWhen, getWhen, removeWhen, readWhenMap, matchWhen, timeWindowOf, WHEN_KEYS } from '../memory/when.mjs'

const argv = process.argv.slice(2)
// 默认指向退役库 .dsh-meow/memory.db：数据已全迁 soulweave，这里保留只为能读历史。
// 新数据一律用 --db 指到 ~/.dsh/soulweave/soul-memory.db。
let dbPath = process.env.DSH_MEOW_DB || join(process.cwd(), '.dsh-meow', 'memory.db')
const rest = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--db') { dbPath = argv[i + 1]; i += 1; continue }
  rest.push(argv[i])
}
const [action, a, b, c] = rest

function die(message) { console.error(message); process.exit(1) }

if (!existsSync(dbPath)) die(`记忆库不存在：${dbPath}`)

if (action === 'set') {
  if (!a || !b) die('用法：set <level> <id> \'{"tool":"write"}\'')
  let raw = {}
  try { raw = JSON.parse(c ?? '{}') } catch (error) { die(`when 不是合法 JSON：${error.message}`) }
  const result = putWhen(dbPath, a, b, raw)
  console.log(JSON.stringify(result))
  process.exit(result.ok ? 0 : 1)
} else if (action === 'get') {
  console.log(JSON.stringify(getWhen(dbPath, a, b)))
} else if (action === 'del') {
  console.log(JSON.stringify(removeWhen(dbPath, a, b)))
} else if (action === 'list') {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const map = readWhenMap(db)
  db.close()
  console.log(JSON.stringify([...map.entries()].map(([key, when]) => ({ key, when })), null, 2))
} else if (action === 'probe') {
  let ctx = {}
  try { ctx = JSON.parse(a ?? '{}') } catch (error) { die(`ctx 不是合法 JSON：${error.message}`) }
  if (!ctx.timeWindow) ctx.timeWindow = timeWindowOf()
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const map = readWhenMap(db)
  db.close()
  const hits = []
  for (const [key, when] of map.entries()) if (matchWhen(when, ctx) === 'hit') hits.push({ key, when })
  console.log(JSON.stringify({ ctx, hits }, null, 2))
} else {
  console.log(`when.mjs —— 情境签名 when_ctx（键：${WHEN_KEYS.join(' / ')}）`)
  console.log('  set <level> <id> \'{"tool":"write","pathPattern":"*.md"}\'')
  console.log('  get <level> <id>')
  console.log('  del <level> <id>')
  console.log('  list')
  console.log('  probe \'{"tool":"write","path":"a.md"}\'')
  console.log(`  记忆库：${dbPath}`)
}
