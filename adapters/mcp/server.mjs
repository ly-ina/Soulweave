#!/usr/bin/env node
/**
 * adapters/mcp/server.mjs —— 第二个宿主：MCP（stdio JSON-RPC）。
 *
 * 目的不是做产品，是**证伪或证实一件事**：
 *   把 soulweave 的 core/ 与 memory/ 接到一个完全不是 dsh 的宿主上，
 *   core 一行不改，能不能跑。
 *
 * 边界（照 check-layers 的规矩）：
 *   - 只 import core/ 与 memory/ 的公开导出；
 *   - 不 import index.js、不 import adapters/dsh/、不碰 ctx；
 *   - 零 npm 依赖，MCP 协议手写（stdio 是行分隔 JSON，够用）。
 *
 * 跑法：
 *   node adapters/mcp/server.mjs --db /tmp/t.db
 *   靠 stdin 喂 JSON-RPC，stdout 只出协议数据，日志一律走 stderr。
 */
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { homedir } from 'node:os'

import {
  BUILTIN_LEVELS,
  countSearchable,
  ensureDb,
  lessonHead,
  listPending,
  putMemory,
  search,
} from '../../memory/builtin.mjs'
import { composeSoulState } from '../../core/soul.mjs'

// ── 参数（不读环境变量做隐式配置，显式优先） ──
const argv = process.argv.slice(2)
function argOf(flag, fallback) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const DB_PATH = argOf('--db', process.env.SOULWEAVE_DB || join(homedir(), '.dsh', 'soulweave', 'soul-memory.db'))
const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'soulweave-memory', version: '0.1.0' }

const log = (...args) => process.stderr.write(`[soulweave-mcp] ${args.join(' ')}\n`)

// ── 工具定义 ──
const TOOLS = [
  {
    name: 'soul_recall',
    description: '在魂织记忆库里检索条目（子串 AND，与 dsh 宿主同一套 search）。返回层级、标题与正文片段。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询词，多个词用空格分隔' },
        limit: { type: 'number', description: '最多返回几条，默认 5' },
      },
      required: ['query'],
    },
  },
  {
    name: 'soul_remember',
    description: `写入一条记忆。level 限于 ${BUILTIN_LEVELS.join(' / ')}。`,
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '正文' },
        level: { type: 'string', enum: BUILTIN_LEVELS, description: '记忆层级，默认 project' },
        title: { type: 'string', description: '标题，可省略' },
        project: { type: 'string', description: '所属项目，可省略' },
      },
      required: ['content'],
    },
  },
  {
    name: 'soul_state',
    description: '渲染【魂引 · 现状】段（复用 dsh 宿主的 composeSoulState，可对比两边输出是否一致）。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: '工作区标注，默认未标注' },
        timeZone: { type: 'string', description: 'IANA 时区，默认 Asia/Shanghai' },
        maxTokens: { type: 'number', description: '预算，默认 180' },
      },
    },
  },
]

// ── 工具实现 ──
function safeCountPending(limit = 3) {
  try {
    const rows = listPending(DB_PATH, limit)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function safeLessonHead() {
  try {
    return lessonHead(DB_PATH) ?? ''
  } catch {
    return ''
  }
}

async function callTool(name, args = {}) {
  switch (name) {
    case 'soul_recall': {
      const query = String(args.query ?? '').trim()
      if (query === '') throw new Error('query 不能为空')
      const words = query.split(/[\s,，、;；]+/).filter(Boolean)
      const result = search(DB_PATH, words, Number(args.limit) || 5)
      const entries = Array.isArray(result?.entries) ? result.entries : []
      if (entries.length === 0) return { content: [{ type: 'text', text: '（无命中）' }] }
      // search() 的条目形状是 { loc, snippet }，不是完整行：loc = "level#id"
      const text = entries.map((e) => `- ${e.loc}｜${String(e.snippet ?? '').replace(/\s+/g, ' ')}`).join('\n')
      return { content: [{ type: 'text', text }] }
    }

    case 'soul_remember': {
      const content = String(args.content ?? '').trim()
      if (content === '') throw new Error('content 不能为空')
      const level = BUILTIN_LEVELS.includes(args.level) ? args.level : 'project'
      ensureDb(DB_PATH)
      const saved = putMemory(DB_PATH, {
        level,
        content,
        ...(args.title ? { title: String(args.title) } : {}),
        ...(args.project ? { project: String(args.project) } : {}),
      })
      if (saved && saved.ok === false) throw new Error(saved.error || '写入失败')
      return { content: [{ type: 'text', text: `已写入 ${level}${saved?.id ? ` · ${saved.id}` : ''}` }] }
    }

    case 'soul_state': {
      const pending = safeCountPending(3)
      // composeSoulState 返回 { text, tokens, chars, step }，不是裸字符串
      const state = composeSoulState({
        at: new Date(),
        timeZone: String(args.timeZone ?? 'Asia/Shanghai'),
        maxTokens: Number(args.maxTokens) || undefined,
        workspace: String(args.workspace ?? '未标注工作区'),
        pending,
        present: { pending },
        searchableCount: countSearchable(DB_PATH),
        lessonHead: safeLessonHead(),
      })
      return { content: [{ type: 'text', text: String(state?.text ?? '') }] }
    }

    default:
      throw new Error(`未知工具：${name}`)
  }
}

// ── JSON-RPC 传输 ──
function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const hasId = msg && Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null
  const { method, params } = msg ?? {}

  if (method === 'initialize') {
    return reply(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: '魂织记忆引擎的 MCP 端口。只暴露检索/写入/现状渲染，不做自动注入。',
    })
  }

  // 通知（无 id）一律不回，包括 notifications/initialized
  if (!hasId) return undefined

  if (method === 'ping') return reply(msg.id, {})

  if (method === 'tools/list') return reply(msg.id, { tools: TOOLS })

  if (method === 'tools/call') {
    const name = params?.name
    try {
      const result = await callTool(name, params?.arguments ?? {})
      return reply(msg.id, result)
    } catch (e) {
      return reply(msg.id, {
        content: [{ type: 'text', text: `执行失败：${e?.message ?? e}` }],
        isError: true,
      })
    }
  }

  return fail(msg.id, -32601, `Method not found: ${method}`)
}

// ── 启动 ──
try {
  ensureDb(DB_PATH)
} catch (e) {
  log('库初始化失败（继续只读尝试）：', e?.message ?? e)
}
log('已启动，库 =', DB_PATH)

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let queue = Promise.resolve()

rl.on('line', (line) => {
  const text = line.trim()
  if (text === '') return
  let msg
  try {
    msg = JSON.parse(text)
  } catch (e) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  // 串行化，保持请求顺序（MCP 允许并发，但顺序更省心）
  queue = queue.then(() => handle(msg)).catch((e) => log('处理异常：', e?.message ?? e))
})

rl.on('close', () => {
  queue.finally(() => process.exit(0))
})
