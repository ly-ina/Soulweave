#!/usr/bin/env node
/**
 * tools/smoke-records.mjs —— adapters/dsh/records.mjs 契约自检。
 *
 * 验三件事：挂上两个 handler、※记 能被捕获写 JSONL、dispose 能摘干净。
 * 不碰真实记忆库（dbPath 传空串，只走 JSONL）。
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachRecords } from '../adapters/dsh/records.mjs'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name} ${extra}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'soulweave-records-'))
const outPath = join(dir, 'records.jsonl')

try {
  const handlers = new Map()
  const offed = []
  const ctx = {
    logger: { info() {}, warn() {} },
    on(event, handler) {
      handlers.set(event, handler)
      const off = () => { handlers.delete(event); offed.push(event) }
      return off
    },
  }

  console.log('R1 挂载')
  const dispose = attachRecords(ctx, {
    outPath,
    dbPath: '',
    triggers: { recall: '※记', todo: '※办', settle: '※结' },
  })
  ok('返回 dispose 函数', typeof dispose === 'function')
  ok('挂了 agent/pre-step', handlers.has('agent/pre-step'))
  ok('挂了 session/event', handlers.has('session/event'))

  console.log('R2 捕获 ※记（正文块）')
  const onEvent = handlers.get('session/event')
  onEvent(
    { id: 's-1' },
    {
      type: 'assistant/message',
      seq: 7,
      time: Date.parse('2026-11-26T12:00:00+08:00'),
      data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '※记 测试用记录' }] } },
    },
  )
  ok('JSONL 已写入', existsSync(outPath))
  const rows = existsSync(outPath)
    ? readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
  ok('只有一行', rows.length === 1, `实际 ${rows.length}`)
  const row = rows[0] ?? {}
  ok('from=text', row.from === 'text', String(row.from))
  ok('records 命中 1 条', row.records?.length === 1, JSON.stringify(row.records))
  ok('正文正确', row.records?.[0]?.text === '测试用记录', String(row.records?.[0]?.text))
  ok('kind=recall', row.records?.[0]?.kind === 'recall', String(row.records?.[0]?.kind))

  console.log('R3 去重：同一事件再来一次不重复写')
  onEvent(
    { id: 's-1' },
    {
      type: 'assistant/message',
      seq: 7,
      time: Date.parse('2026-11-26T12:00:00+08:00'),
      data: { turn: 3, step: 1, message: { content: [{ type: 'text', text: '※记 测试用记录' }] } },
    },
  )
  const rows2 = readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean)
  ok('仍是 1 行', rows2.length === 1, `实际 ${rows2.length}`)

  console.log('R4 无触发词不写')
  onEvent(
    { id: 's-1' },
    { type: 'assistant/message', seq: 8, data: { message: { content: [{ type: 'text', text: '普通回复' }] } } },
  )
  ok('仍是 1 行', readFileSync(outPath, 'utf8').trim().split('\n').filter(Boolean).length === 1)

  console.log('R5 dispose 摘干净')
  dispose()
  ok('handler 全部摘掉', handlers.size === 0, `残留 ${[...handlers.keys()].join(',')}`)
  ok('两个 off 都被调用', offed.length === 2, `实际 ${offed.length}`)
  ok('重复 dispose 不炸', (() => { try { dispose(); return true } catch { return false } })())
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} records 契约：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
