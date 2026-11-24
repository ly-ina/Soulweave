#!/usr/bin/env node
/**
 * tools/migrate-legacy.mjs —— 把 meow 七层的 active 记忆迁进 builtin 池。
 *
 * 用法：
 *   node tools/migrate-legacy.mjs --from <旧库> --to <新库> --dry-run
 *   node tools/migrate-legacy.mjs --from <旧库> --to <新库>
 *
 * 规矩：
 *  - 只迁 status='active'；archived / stale 留在旧库，不搬。
 *  - 沿用旧 id（`0mw...`，与新池 `m-...` 不撞），随时能对回旧库。
 *  - 靠 putMemory 的 sha 去重：新池已有同文只记一笔 dedup，不重复写。
 *  - `--dry-run` 只统计，不动新库一个字节。
 *  - 旧库只读（`fileMustExist`），脚本不会写它。
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from '../io.mjs'
import { BUILTIN_LEVELS, putMemory } from '../memory/builtin.mjs'

const LAYERS = ['soul', 'rules', 'user', 'project', 'fact', 'lesson', 'topic']

function argOf(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback
}

const from = argOf('from')
const to = argOf('to')
const dryRun = process.argv.includes('--dry-run')
if (!from || !to) {
  console.error('用法：node tools/migrate-legacy.mjs --from <旧库> --to <新库> [--dry-run]')
  process.exit(2)
}
if (!existsSync(from)) {
  console.error(`旧库不存在：${from}`)
  process.exit(2)
}
if (!dryRun && !existsSync(to)) {
  console.error(`新库不存在（先跑一次让 builtin 建库）：${to}`)
  process.exit(2)
}

const shaOf = (text) => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
const old = new DatabaseSync(from, { readOnly: true })

let newDb = null
const knownShas = new Set()
try {
  const shaDb = new DatabaseSync(to, { readOnly: true })
  for (const row of shaDb.prepare("select sha from memories where status='active'").all()) knownShas.add(String(row.sha))
  shaDb.close()
} catch {
  /* 新库还没建：dry-run 下 knownShas 为空，可以接受 */
}
if (!dryRun) newDb = new DatabaseSync(to)

const stats = { total: 0, written: 0, dedup: 0, skipped: 0, failed: 0, byLayer: {} }
const failures = []

for (const layer of LAYERS) {
  if (!BUILTIN_LEVELS.includes(layer)) continue
  let rows = []
  try {
    rows = old.prepare(`select * from "${layer}" where status='active'`).all()
  } catch (error) {
    failures.push({ layer, id: '', why: `读不到表：${String(error?.message ?? error)}` })
    continue
  }
  stats.byLayer[layer] = { total: rows.length, written: 0, dedup: 0, failed: 0 }
  for (const row of rows) {
    stats.total += 1
    const content = String(row.content ?? '').trim()
    if (!content) {
      stats.skipped += 1
      continue
    }
    const sha = shaOf(content)
    if (knownShas.has(sha)) {
      stats.dedup += 1
      stats.byLayer[layer].dedup += 1
      continue
    }
    if (dryRun) {
      stats.written += 1
      stats.byLayer[layer].written += 1
      knownShas.add(sha)
      continue
    }
    const result = putMemory(to, {
      id: String(row.id ?? '').trim() || undefined,
      title: String(row.title ?? ''),
      content,
      keywords: row.keywords ?? '',
      importance: Number(row.importance ?? 1) || 1,
      status: 'active',
      corrected: row.corrected ?? 0,
      project: String(row.project ?? ''),
      level: layer,
      created_at: Number(row.created_at ?? 0) || undefined,
      updated_at: Number(row.updated_at ?? 0) || undefined,
      source_session: String(row.source_session ?? ''),
      source_turn: '',
      goal: String(row.goal ?? ''),
    })
    if (!result.ok) {
      stats.failed += 1
      stats.byLayer[layer].failed += 1
      failures.push({ layer, id: String(row.id ?? ''), why: String(result.error ?? '') })
      continue
    }
    if (result.dedup) {
      stats.dedup += 1
      stats.byLayer[layer].dedup += 1
    } else {
      stats.written += 1
      stats.byLayer[layer].written += 1
    }
    knownShas.add(sha)
  }
}

try { old.close() } catch { /* ignore */ }
try { newDb?.close() } catch { /* ignore */ }

const mode = dryRun ? 'DRY-RUN（没写）' : '已写入'
console.log(`迁移${mode}：${from} -> ${to}`)
for (const layer of LAYERS) {
  const s = stats.byLayer[layer]
  if (!s) continue
  console.log(`  ${layer.padEnd(8)} 共 ${String(s.total).padStart(3)} · 写 ${String(s.written).padStart(3)} · 去重 ${String(s.dedup).padStart(3)} · 失败 ${s.failed}`)
}
console.log(`总计：${stats.total} 条 active · 写 ${stats.written} · 去重 ${stats.dedup} · 空跳过 ${stats.skipped} · 失败 ${stats.failed}`)
if (failures.length) {
  console.log('失败明细：')
  for (const f of failures.slice(0, 20)) console.log(`  [${f.layer}] ${f.id} ${f.why}`)
}
process.exit(stats.failed ? 1 : 0)
