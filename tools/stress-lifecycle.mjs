#!/usr/bin/env node
/**
 * tools/stress-lifecycle.mjs —— SDK 生命周期验收（HANDOFF 第 3 节第 4 条）。
 *
 * 判据：连续 create → dispose N 次后
 *   1. 监听器数量归零（ctx.on 全部被 dispose 摘掉）
 *   2. 工具注册数量归零
 *   3. heapUsed 回到基线 +5MB 内
 *
 * 用法：node --expose-gc tools/stress-lifecycle.mjs [次数]
 * 任何一条不满足 → 退出码 1。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../adapters/dsh/apply.mjs'

const N = Math.max(1, Number(process.argv[2]) || 100)
const HEAP_TOLERANCE_MB = 5

function makeCtx() {
  const listeners = new Map()
  let toolCount = 0
  return {
    inject: ['tools', 'webServer'],
    logger: () => ({ info() {}, warn() {}, debug() {}, error() {} }),
    on(name, fn) {
      const set = listeners.get(name) ?? new Set()
      set.add(fn)
      listeners.set(name, set)
      return () => {
        set.delete(fn)
        if (set.size === 0) listeners.delete(name)
      }
    },
    tools: {
      register() {
        toolCount += 1
        let done = false
        return () => {
          if (done) return
          done = true
          toolCount -= 1
        }
      },
    },
    probe: {
      listenerCount: () => [...listeners.values()].reduce((a, s) => a + s.size, 0),
      groups: () => [...listeners.keys()],
      toolCount: () => toolCount,
    },
  }
}

function snap() {
  if (global.gc) {
    global.gc()
    global.gc()
  }
  const m = process.memoryUsage()
  return { heapMB: m.heapUsed / 1048576, extMB: m.external / 1048576 }
}

const dir = mkdtempSync(join(tmpdir(), 'soulweave-stress-'))
const config = { stateDir: dir }
const ctxs = []

// 预热：让 JIT / 模块缓存先热起来，基线才可比
for (let i = 0; i < 5; i += 1) {
  const c = makeCtx()
  const dispose = apply(c, config)
  if (typeof dispose === 'function') dispose()
}

const base = snap()
console.log(`基线  heap=${base.heapMB.toFixed(2)}MB  ext=${base.extMB.toFixed(2)}MB  N=${N}`)

let noDispose = 0
for (let i = 1; i <= N; i += 1) {
  const c = makeCtx()
  const dispose = apply(c, config)
  if (typeof dispose !== 'function') {
    noDispose += 1
    console.error(`✗ 第 ${i} 次 apply 没返回 dispose`)
    break
  }
  dispose()
  ctxs.push(c)
  if (i % 20 === 0) {
    const s = snap()
    console.log(`#${String(i).padStart(3)}  heap=${s.heapMB.toFixed(2)}MB  ext=${s.extMB.toFixed(2)}MB`)
  }
}

let leakListeners = 0
let leakTools = 0
for (const c of ctxs) {
  leakListeners += c.probe.listenerCount()
  leakTools += c.probe.toolCount()
}
const end = snap()
const heapDelta = end.heapMB - base.heapMB

const checks = [
  ['每次都返回 dispose', noDispose === 0, `noDispose=${noDispose}`],
  ['监听器归零', leakListeners === 0, `残留 ${leakListeners}`],
  ['工具注册归零', leakTools === 0, `残留 ${leakTools}`],
  [`heap 增长 < ${HEAP_TOLERANCE_MB}MB`, heapDelta < HEAP_TOLERANCE_MB, `Δ=${heapDelta.toFixed(2)}MB`],
]

let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? '✓' : '✗'} ${name}  (${detail})`)
  if (!ok) failed += 1
}

rmSync(dir, { recursive: true, force: true })
console.log(failed === 0 ? `\nstress-lifecycle ${N}/${N} 通过` : `\nstress-lifecycle 失败 ${failed} 项`)
process.exit(failed === 0 ? 0 : 1)