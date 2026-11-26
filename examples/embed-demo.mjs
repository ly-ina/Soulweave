#!/usr/bin/env node
/**
 * examples/embed-demo.mjs —— 「在不是 DSH 的 Node 服务端里用魂织」的最小可跑样例。
 *
 * 数据入口走 `./sdk`（稳定契约），其余 import core/ 具体模块；零 DSH 依赖、零 ctx、零 adapters。
 * 自带临时库，跑完就删，不碰你自己的记忆。
 *
 * 跑：node examples/embed-demo.mjs
 *
 * 这不是稳定 API。它演示的是「调用顺序」，不是接口契约。
 */
// 1.0：Node 的 IO 与 sqlite 驱动要显式装配（非 Node 宿主改 configureIo）。
import '../io-node.mjs'
import '../storage/node-sqlite.mjs'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDb } from '../memory/builtin.mjs'
import { putMemory, search } from '../sdk.mjs'
import { parseSoul, composeSoulStable } from '../core/soul.mjs'
import { estimateTokens } from '../core/text.mjs'
import { putWhen, matchWhen, timeWindowOf, bumpWhenHit, readWhenStats } from '../memory/when.mjs'

const dir = mkdtempSync(join(tmpdir(), 'soulweave-embed-'))
const dbPath = join(dir, 'memory.db')
ensureDb(dbPath)

// ── 1. 人格：服务端每人一份 soul 文本（存 DB / 文件都行，按 user 取）
const soulText = [
  '## 身份',
  '- 你是「小满」，话不多的倾听者',
  '',
  '## 认知',
  '- 先接住情绪，再谈事',
  '',
  '## 禁令',
  '- 不评判用户的选择',
].join('\n')
const soul = parseSoul(soulText)

// ── 2. 记忆：用户说过的话
putMemory(dbPath, { level: 'user', project: 'demo', content: '阿泽最近在准备辞职，很焦虑' })
putMemory(dbPath, { level: 'fact', project: 'demo', content: '阿泽不吃香菜，喜欢下雨天' })

// ── 3. 情境签名：服务端没有「工具调用」，可以把 tool 当「场景名」用
// timeWindow 用当前时间段，别硬编码 —— 硬编码的话换个钟点跑就一定 miss。
putWhen(dbPath, 'user', 'demo-1', { tool: 'chat', timeWindow: timeWindowOf(new Date()) })

// ── 4. 一轮对话：用户说话 → 组装注入文本
const userText = '今天又加班到十点，好累'
const now = new Date()
const ctx = { tool: 'chat', path: '', timeWindow: timeWindowOf(now) }

const stable = composeSoulStable({ soul })
const hits = search(dbPath, ['辞职', '焦虑'], 5)
// search 返回的 entry 形状是 { loc, snippet }，没有 content 字段。
const related = (hits.entries ?? [])
  .map((entry) => `- ${entry.snippet ?? ''}`)
  .filter((line) => line.trim() !== '-')

const injection = [
  stable.text,
  related.length > 0 ? `【相关记忆】\n${related.join('\n')}` : '',
].filter(Boolean).join('\n\n')

console.log('────── 注入文本 ──────')
console.log(injection)
console.log(`────── ${estimateTokens(injection)} tokens / ${injection.length} 字 ──────`)

// ── 5. 命中记账：和 DSH 里走同一条路径
const when = { tool: 'chat', timeWindow: timeWindowOf(now) }
const sig = // timeWindow 用当前时间段，别硬编码 —— 硬编码的话换个钟点跑就一定 miss。
putWhen(dbPath, 'user', 'demo-1', { tool: 'chat', timeWindow: timeWindowOf(new Date()) })
console.log('\nwhen 签名写入:', sig.ok)
console.log('when 匹配:', matchWhen({ tool: 'chat', timeWindow: timeWindowOf(now) }, when))
const bumped = bumpWhenHit(dbPath, 'user', 'demo-1')
console.log('记账:', JSON.stringify(bumped), '→', JSON.stringify(readWhenStats(dbPath).rows?.[0]))

// ── 6. 服务端必须自己做的三件事（demo 不替你做）
console.log(`
服务端还要自己处理：
  1. 每用户一份 soul + 一个 memory.db（本 demo 只演示单用户）；
  2. SQLite 开 WAL + busy_timeout，否则多端同时聊会 SQLITE_BUSY；
  3. 冷却/去重表不要放进程内存 —— 多实例会各算各的。
`)

try { rmSync(dir, { recursive: true, force: true }) } catch { /* Windows 偶发 EPERM，留给系统清 */ }
