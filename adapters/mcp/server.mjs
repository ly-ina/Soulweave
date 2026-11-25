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
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import {
  BUILTIN_LEVELS,
  countSearchable,
  ensureDb,
  lessonHead,
  listDueItems,
  listPending,
  listTodos,
  putMemory,
  putTodo,
  search,
  setTodoStatus,
} from '../../memory/builtin.mjs'
import { anchorOf, renderAnchored } from '../../memory/anchor.mjs'
import { health, isBrokenSearchResult, renderHealth } from '../../memory/health.mjs'
import { composeSoulState } from '../../core/soul.mjs'

// ── 参数（不读环境变量做隐式配置，显式优先） ──
const argv = process.argv.slice(2)
function argOf(flag, fallback) {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const DB_PATH = argOf('--db', process.env.SOULWEAVE_DB || join(homedir(), '.soulweave', 'mcp', 'soul-memory.db'))
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
    name: 'soul_todo',
    description:
      '待办：create 写一条（due 必须能解析成时间）；list 列未结（带短锚点）；done 按短锚点结账（标记完成，不物理删除）。锚点出现在 list 与 soul_state 的 ⏰ 行里。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'done'], description: '默认 list' },
        content: { type: 'string', description: 'create 时必填：要做什么' },
        due: { type: 'string', description: 'create 时必填：到期时间，ISO 8601（2026-11-26T09:00）或 2026-11-26 09:00' },
        anchor: { type: 'string', description: 'done 时必填：短锚点，如 k3f9（list / ⏰ 行里带）' },
        project: { type: 'string', description: '所属项目，可省略' },
      },
    },
  },
  {
    name: 'soul_health',
    description:
      '检查记忆库是否可用。返回路径、记录数、journal_mode、busy_timeout、文件大小；不可用时给出失败阶段（不存在/是目录/打不开/缺表/读失败）与原因。只读。用来区分「没有相关记忆」和「记忆库坏了」。',
    inputSchema: { type: 'object', properties: {} },
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

/**
 * 解析待办的到期时间。
 * 优先按本地时区手解析（`2026-11-26 09:00` 被 Date.parse 当 UTC 的坑），再退回 Date.parse。
 * @returns {number|null} epoch ms
 */
function parseDueAt(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null

  // 已带时区（Z / +08:00）就直接交给 Date.parse：手解析会把 UTC 的 07:30 当成本地 07:30，差 8 小时
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)) {
    const parsed = Date.parse(text)
    return Number.isFinite(parsed) ? parsed : null
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(text)
  if (m) {
    const at = new Date(+m[1], +m[2] - 1, +m[3], m[4] === undefined ? 9 : +m[4], m[5] === undefined ? 0 : +m[5])
    return Number.isNaN(at.getTime()) ? null : at.getTime()
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
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

    case 'soul_todo': {
      const action = String(args.action ?? 'list')

      if (action === 'create') {
        const content = String(args.content ?? '').trim()
        if (content === '') throw new Error('create 需要 content')
        const at = parseDueAt(args.due)
        if (at === null) throw new Error(`due 解析不出时间：「${args.due ?? ''}」（给 2026-11-26T09:00 或 2026-11-26 09:00）`)
        const saved = putTodo(DB_PATH, {
          content,
          due: new Date(at).toISOString(),
          ...(args.project ? { project: String(args.project) } : {}),
        })
        if (saved && saved.ok === false) throw new Error(saved.error || '写入失败')
        const anchor = anchorOf(saved?.id)
        const when = new Date(at).toLocaleString('zh-CN', { hour12: false })
        return {
          content: [
            {
              type: 'text',
              text: `已记下 [${anchor}] ${content}\n到期：${when}\n结账时写 ※结：${anchor}`,
            },
          ],
        }
      }

      if (action === 'done') {
        const anchor = String(args.anchor ?? '').trim().toLowerCase()
        if (anchor === '') throw new Error('done 需要 anchor（list / ⏰ 行里带的短锚点）')
        const pending = listTodos(DB_PATH, { status: 'pending', limit: 200 })
        const hit = pending.find((t) => anchorOf(t.id) === anchor)
        if (!hit) throw new Error(`没有锚点 ${anchor} 的未结待办（可能已结，或锚点抄错）`)
        const result = setTodoStatus(DB_PATH, hit.id, 'done')
        if (result && result.ok === false) throw new Error(result.error || '标记失败')
        return { content: [{ type: 'text', text: `已结账 [${anchor}] ${hit.content}` }] }
      }

      // list（默认）
      const todos = listTodos(DB_PATH, { status: 'pending', limit: 50 })
      if (todos.length === 0) return { content: [{ type: 'text', text: '未结：（无）' }] }
      const lines = todos.map((t) => {
        const raw = String(t.due ?? '').trim()
        let due = '无到期'
        if (raw !== '') {
          const at = parseDueAt(raw)
          // 库里存的是 ISO（UTC），直接回显会让模型误读成 01:00，统一转本地
          due = at === null ? `到期（无法解析）${raw}` : `到期 ${new Date(at).toLocaleString('zh-CN', { hour12: false })}`
        }
        return `- ${renderAnchored(t.content, t.id)} · ${due}`
      })
      return { content: [{ type: 'text', text: `未结 ${todos.length} 条\n${lines.join('\n')}` }] }
    }

    case 'soul_health': {
      const h = health(DB_PATH)
      const text = h.ok
        ? [
            '状态：可用',
            `路径：${h.path}`,
            `记录：${h.records} 条`,
            `日志模式：${h.journalMode}`,
            `busy_timeout：${h.busyTimeout} ms`,
            `大小：${Math.round((h.sizeBytes ?? 0) / 1024)} KB`,
          ].join('\n')
        : ['状态：不可用', `阶段：${h.stage}`, `原因：${h.reason}`, `路径：${h.path}`].join('\n')
      return { content: [{ type: 'text', text }] }
    }

    case 'soul_state': {
      const pending = safeCountPending(3)
      // 到期行：给现状段一个 ⏰ 行，带锚点，模型之后能对着锚点结账
      let dueItems = []
      try {
        dueItems = listDueItems(DB_PATH, { now: Date.now(), limit: 5 }).items
      } catch {
        dueItems = []
      }
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
        dueItems,
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
        content: [
          {
            type: 'text',
            text: `执行失败：${e?.message ?? e}\n（若连续失败，先跑 node adapters/mcp/server.mjs --selftest 判断是库坏了还是协议断了）`,
          },
        ],
        isError: true,
      })
    }
  }

  return fail(msg.id, -32601, `Method not found: ${method}`)
}

// ── 自检：不起协议，只跑一次读路径，判断这个进程还健康吗 ──
// 用法：node adapters/mcp/server.mjs --selftest [--db <path>]
// 退出码 0 = 全部通过；1 = 有项失败。宿主侧调工具连续失败时，先用它定位是库的问题还是协议的问题。
async function selftest() {
  const checks = []
  // 用 core 之外的 health()：读路径是静默降级的，光看「没抛异常」判断不了好坏
  const h = health(DB_PATH)
  checks.push(['库可用', h.ok, h.ok ? renderHealth(h) : `[${h.stage}] ${h.reason}`])

  try {
    const r = search(DB_PATH, ['selftest'], 1)
    const broken = isBrokenSearchResult(r)
    checks.push(['检索可跑', !broken, broken ? (r?.note || '返回形状异常') : `正常（${r.entries.length} 条命中）`])
  } catch (e) {
    checks.push(['检索可跑', false, e?.message ?? String(e)])
  }
  try {
    const s = composeSoulState({ at: new Date(), workspace: 'selftest' })
    checks.push(['现状可渲染', typeof s?.text === 'string' && s.text.length > 0, `${s?.chars ?? 0} 字`])
  } catch (e) {
    checks.push(['现状可渲染', false, e?.message ?? String(e)])
  }
  for (const [name, ok, detail] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${detail}`)
  return checks.every(([, ok]) => ok)
}

if (argv.includes('--selftest')) {
  const ok = await selftest()
  process.exit(ok ? 0 : 1)
}

// ── 启动 ──
// 默认落到中性路径，但**强烈建议用 --db 显式指向 dsh 的库**，让所有宿主共享同一份记忆：
// 经验能跨宿主复用，才叫记忆引擎。真要隔离再指到别的文件。
// 目录不存在时自己建，别让 DatabaseSync 因为父目录缺失而直接抛。
try {
  mkdirSync(dirname(DB_PATH), { recursive: true })
} catch (e) {
  log('目录创建失败：', e?.message ?? e)
}

try {
  ensureDb(DB_PATH)
} catch (e) {
  log('库初始化失败（继续只读尝试）：', e?.message ?? e)
}
log('已启动，库 =', DB_PATH)

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let queue = Promise.resolve()

// ── 进程守卫 ──
// 这个进程是被宿主 spawn 的，崩了宿主只会看到「工具调用失败」，看不到原因。
// 所以任何逃出 handle 的异常都记一行到 stderr（宿主日志通常会收），然后退出，
// 交给宿主重启——带着坏状态硬撑比退出更危险。
process.on('uncaughtException', (e) => {
  log('未捕获异常，退出：', e?.stack ?? e?.message ?? String(e))
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  log('未处理的 Promise 拒绝：', e?.stack ?? e?.message ?? String(e))
})

// stdin 关闭 = 宿主没了（或重启中），立刻退出，别留僵尸进程
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))

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
