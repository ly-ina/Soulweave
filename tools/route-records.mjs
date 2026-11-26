#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * tools/route-records.mjs —— 把 memprobe 的 records.jsonl 路由进记忆库。
 *
 * 用法：
 *   node tools/route-records.mjs --in <records.jsonl> --db <soul-memory.db> [--dry-run] [--project <名>]
 *
 * 这是**事后批处理**，不依赖 dsh 的事件钩子：
 *   memprobe 挂上后只管写 JSONL（探针职责），落库由这个脚本决定。
 *   将来 dsh 侧接实时路由时，调的是同一个 routeRecords()，逻辑不分叉。
 *
 * 退出码：0 = 全部成功；1 = 有条目失败；2 = 参数错误。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { renderRouteResult, routeRecords } from '../memory/route.mjs'
import { parseDue } from '../memory/time.mjs'

const argv = process.argv.slice(2)
const argOf = (name, fallback = '') => {
  const at = argv.indexOf(`--${name}`)
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const inPath = argOf('in')
const dbPath = argOf('db')
const project = argOf('project')
const dryRun = has('dry-run')

if (inPath === '' || dbPath === '') {
  console.error('用法：node tools/route-records.mjs --in <records.jsonl> --db <soul-memory.db> [--dry-run] [--project <名>]')
  process.exit(2)
}

/** 把 JSONL 里的 rows 展平成 records，保留 ts 作为参考时间。 */
function loadRecords(path) {
  let text = ''
  try {
    text = readFileSync(resolve(path), 'utf8')
  } catch (error) {
    console.error(`读不到 ${path}：${error?.message ?? error}`)
    process.exit(2)
  }

  const records = []
  let rows = 0
  let bad = 0
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    let row = null
    try {
      row = JSON.parse(t)
    } catch {
      bad += 1
      continue
    }
    rows += 1
    const at = row?.ts ? Date.parse(row.ts) : NaN
    for (const rec of Array.isArray(row?.records) ? row.records : []) {
      const kind = String(rec?.kind ?? 'recall')
      const content = String(rec?.text ?? '').trim()
      if (content === '') continue
      records.push({ kind, text: content, at: Number.isFinite(at) ? at : undefined, session: row?.sessionId })
    }
  }
  return { records, rows, bad }
}

const { records, rows, bad } = loadRecords(inPath)
console.log(`读入 ${rows} 行（坏行 ${bad}），展开 ${records.length} 条记录`)

if (records.length === 0) {
  console.log('没有可路由的记录')
  process.exit(0)
}

if (dryRun) {
  // dry-run 必须跑时间解析：只看 kind 计数看不出「有多少条会因为认不出日期被降级」，
  // 而那才是接线前最该看的数据。这里不写库，只报告每条会被怎么处理。
  let writable = 0
  const degraded = []
  const ambiguous = []
  for (const rec of records) {
    const at = rec.at ? new Date(rec.at) : new Date()
    if (rec.kind === 'todo') {
      const due = parseDue(rec.text, at)
      if (due === null) {
        degraded.push(rec.text)
        continue
      }
      writable += 1
      const marks = []
      if (due.assumedTime) marks.push('默认时刻')
      if (due.ambiguous) marks.push('歧义推定')
      console.log(`  + 待办 ${rec.text} → ${due.iso}${marks.length > 0 ? `（${marks.join('、')}）` : ''}`)
      if (due.ambiguous) ambiguous.push(rec.text)
    } else if (rec.kind === 'settle') {
      console.log(`  ~ 结账 ${rec.text}（dry-run 不校验目标是否存在）`)
    } else {
      writable += 1
      console.log(`  · 记忆 ${rec.text}`)
    }
  }
  const totalTodo = records.filter((r) => r.kind === 'todo').length
  console.log(`\n[dry-run] 可落库 ${writable} 条；待办 ${totalTodo} 条中降级 ${degraded.length} 条`)
  if (totalTodo > 0) {
    console.log(`  待办解析成功率：${totalTodo - degraded.length}/${totalTodo}`)
  }
  for (const text of degraded) console.log(`  ~ 降级（解析不出日期，会进 memories）${text}`)
  for (const text of ambiguous) console.log(`  ! 歧义（按最近未来推定，建议写清上午/晚上）${text}`)
  process.exit(0)
}

// 逐条带自己的时间基准：捕获时的 ts 比"现在"更接近语义（"明天"是相对那时说的）
let ok = 0
let failed = 0
const allWarnings = []

for (const rec of records) {
  const result = routeRecords([{ kind: rec.kind, text: rec.text }], {
    dbPath,
    now: rec.at ?? Date.now(),
    project,
  })
  if (result.ok) ok += 1
  else failed += 1
  allWarnings.push(...result.warnings)
  for (const item of result.written.todos) {
    console.log(`  + 待办 [${item.anchor}] ${item.text} → ${item.due}${item.assumedTime ? '（默认时刻）' : ''}`)
  }
  for (const item of result.written.settled) {
    console.log(`  ✓ 结账 [${item.anchor}] ${item.text}（按 ${item.by}）`)
  }
  for (const item of result.failed) {
    console.log(`  ! 失败 ${item.kind}：${item.reason} ← ${item.text}`)
  }
}

console.log(`\n完成：成功 ${ok} 条，失败 ${failed} 条，警告 ${allWarnings.length} 条`)
for (const w of allWarnings) console.log(`  ~ ${w.kind}：${w.note} ← ${w.text}`)

process.exit(failed > 0 ? 1 : 0)
