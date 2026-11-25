#!/usr/bin/env node
/**
 * examples/node-cli.mjs —— 「不装 DSH 也能用」的最小证明。
 *
 * 数据用 `./sdk` 的承诺面（putMemory / search），别的用 core/ 的具体模块。
 * 不碰 index.js / adapters / 任何 ctx。
 * 跑：node examples/node-cli.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ensureDb } from '../memory/builtin.mjs'
import { putMemory, search } from '../sdk.mjs'
import { clip, estimateTokens } from '../core/text.mjs'
import { parseSoul } from '../core/soul.mjs'

const dir = mkdtempSync(join(tmpdir(), 'soulweave-example-'))
const dbPath = join(dir, 'memory.db')
ensureDb(dbPath)

putMemory(dbPath, { level: 'project', project: 'demo', content: '伊纳在写《AI时代》，用 RPG Maker 发布' })
putMemory(dbPath, { level: 'fact', project: 'demo', content: '记忆检索是纯子串 AND 匹配，没有分词' })

const hit = search(dbPath, ['AI时代'], 5)
console.log('检索命中：', JSON.stringify(hit.entries ?? hit, null, 0))

const soul = ['## 身份', '- 我叫示例助手', '', '## 禁令', '- 不删原文'].join('\n')
const parsed = parseSoul(soul)
console.log('parseSoul：', Object.keys(parsed.sections ?? parsed).join(' / '))
console.log('estimateTokens：', estimateTokens('你好 world'), '· clip：', clip('一二三四五六', 4))

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  // Windows 上 SQLite 句柄未释放会锁目录；临时目录交给系统清理，不影响示例结论。
}
console.log('OK：不装 DSH、不碰 ctx，memory + core 可用')
