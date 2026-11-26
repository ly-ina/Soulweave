/**
 * smoke-sdk —— 宿主外冒烟：只用 sdk.mjs 的 20 个承诺面，不碰 adapters。
 *
 * 这是 SDK 真正的验收：一个普通 Node 程序（没有 DSH ctx、没有插件加载器）
 * 拿临时库写一条、查回来、跑一次体检。任何一步失败都说明承诺面漏了依赖。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../io-node.mjs'
import '../storage/node-sqlite.mjs'
import { anchorOf, health, initMemoryDb, listTodos, parseDue, putMemory, putTodo, search } from '../sdk.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'soulweave-sdk-'))
const db = join(dir, 'm.db')
try {
  ok('initMemoryDb', initMemoryDb(db)?.ok === true)

  const put = putMemory(db, { id: 's1', content: 'SDK 冒烟：只经 sdk.mjs 就能写读', keywords: ['sdk', '冒烟'], importance: 2, level: 'fact' })
  ok('putMemory', put?.ok === true, JSON.stringify(put))

  const hit = search(db, ['SDK', '冒烟'], 5)
  ok('search 命中', hit?.entries?.length === 1, JSON.stringify(hit)?.slice(0, 120))
  ok('search 未降级', hit?.degraded === false)
  ok('命中就是刚写的', JSON.stringify(hit?.entries?.[0] ?? {}).includes('SDK 冒烟'))

  ok('health', health(db)?.ok === true)

  const todo = putTodo(db, { id: 't1', content: 'SDK 冒烟待办', due: '2026-12-01' })
  ok('putTodo', todo?.ok === true, JSON.stringify(todo))
  const todos = listTodos(db, { limit: 5 })
  ok('listTodos', Array.isArray(todos) && todos.length >= 1, JSON.stringify(todos)?.slice(0, 120))

  ok('parseDue', String(parseDue('2026-12-01')?.iso ?? '').includes('2026-12-01'))
  ok('anchorOf', typeof anchorOf === 'function')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} sdk 契约：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

