/**
 * Soulweave 设置面板（server 半）。
 *
 * 设计：面板只读写 <stateDir>/panel-override.json，不改 profile 的 cordis.patch.yml。
 * 覆盖值在 apply() 里 merge 到 config，再交给 normalizeConfig，所以白名单仍然生效。
 * 这样 profile 永远是本机权威，面板是「运行时覆盖」，删掉文件就回到 profile。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const PANEL_API_PREFIX = '/soulweave-panel/api'
export const PANEL_HEADER_NAME = 'x-dsh-soulweave-panel'
export const PANEL_HEADER_VALUE = 'sw-panel-1'

const OVERRIDE_FILE = 'panel-override.json'
const MAX_BODY_BYTES = 64 * 1024

export const PANEL_ITEMS = Object.freeze([
  {
    key: 'soulMaxTokens',
    label: '魂引上限',
    type: 'int',
    min: 100,
    max: 4000,
    help: '每轮注入的魂引 token 上限。硬上限 1100，超过会被夹住。',
  },
  {
    key: 'totalMaxTokens',
    label: '四类注入合计上限',
    type: 'int',
    min: 100,
    max: 4000,
    help: '魂引、记忆、现状、路由合起来的 token 上限。',
  },
  {
    key: 'enforceBudget',
    label: '超预算时裁剪别人的注入',
    type: 'bool',
    help: '关着时只在魂引末尾申报超支，不静默裁掉其它插件的注入。',
  },
  {
    key: 'pendingLimit',
    label: '「现在在哪」条目上限',
    type: 'int',
    min: 1,
    max: 10,
    help: '超限只留最近 3 条。',
  },
  {
    key: 'recallLimit',
    label: 'soul_recall 默认条数',
    type: 'int',
    min: 1,
    max: 5,
    help: '上限 5。',
  },
  {
    key: 'soulSplitInjection',
    label: '稳定段／动态段拆分注入',
    type: 'bool',
    help: '开：稳定段只发一次、压缩后补发；关：legacy 每步全量。',
  },
  {
    key: 'hybridSearch',
    label: '混合召回（BM25 + 向量）',
    type: 'bool',
    help: 'embed 模块缺失或编码报错时自动退回纯 BM25。',
  },
])

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function overridePath(stateDir) {
  return join(stateDir, OVERRIDE_FILE)
}

function validateItem(item, value) {
  if (item.type === 'bool') {
    if (typeof value !== 'boolean') return { ok: false, error: `${item.key} 要布尔值` }
    return { ok: true, value }
  }
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n)) return { ok: false, error: `${item.key} 要整数` }
  if (n < item.min || n > item.max) {
    return { ok: false, error: `${item.key} 要在 ${item.min} 到 ${item.max} 之间` }
  }
  return { ok: true, value: n }
}

export function readOverride(stateDir) {
  const p = overridePath(stateDir)
  if (!existsSync(p)) return {}
  try {
    const parsed = asObject(JSON.parse(readFileSync(p, 'utf8')))
    const out = {}
    for (const item of PANEL_ITEMS) {
      if (!Object.hasOwn(parsed, item.key)) continue
      const checked = validateItem(item, parsed[item.key])
      if (checked.ok) out[item.key] = checked.value
    }
    return out
  } catch {
    return {}
  }
}

export function applyOverride(config, stateDir) {
  const override = readOverride(stateDir)
  return Object.keys(override).length === 0 ? config : { ...config, ...override }
}

function writeOverride(stateDir, values) {
  const p = overridePath(stateDir)
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(values, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * @param {object} ctx 宿主上下文
 * @param {object} logger
 * @param {{ stateDir: string, getEffective: () => object }} deps
 */
export function registerSoulweavePanel(ctx, logger, deps) {
  const { stateDir, getEffective } = deps
  if (typeof ctx.webServer?.register !== 'function') {
    logger.warn?.('soulweave: 宿主没有 webServer，设置面板路由未注册')
    return () => {}
  }

  const api = {
    state() {
      const effective = asObject(getEffective?.())
      return {
        items: PANEL_ITEMS.map((item) => ({ ...item, value: effective[item.key] })),
        override: readOverride(stateDir),
        file: overridePath(stateDir),
      }
    },
    set(body) {
      const values = asObject(body?.values)
      const next = { ...readOverride(stateDir) }
      let touched = 0
      for (const item of PANEL_ITEMS) {
        if (!Object.hasOwn(values, item.key)) continue
        const checked = validateItem(item, values[item.key])
        if (!checked.ok) throw new Error(checked.error)
        next[item.key] = checked.value
        touched += 1
      }
      if (touched === 0) throw new Error('没有要保存的项')
      writeOverride(stateDir, next)
      logger.info?.(`soulweave: 面板覆盖已写入（${touched} 项），重启后生效`)
      return { ok: true, override: next, restartRequired: true }
    },
    reset() {
      const p = overridePath(stateDir)
      if (existsSync(p)) rmSync(p)
      logger.info?.('soulweave: 面板覆盖已清空，重启后回到 profile 配置')
      return { ok: true, override: {}, restartRequired: true }
    },
  }

  try {
    return ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: PANEL_API_PREFIX,
          handler: async (req, res) => {
            if (req.headers[PANEL_HEADER_NAME] !== PANEL_HEADER_VALUE) {
              sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: '缺少面板头' } })
              return
            }
            if (req.method !== 'POST') {
              sendJson(res, 405, { ok: false, error: { code: 'method-error', message: '面板路由只接受 POST' } })
              return
            }
            const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
            const method = pathname.startsWith(`${PANEL_API_PREFIX}/`)
              ? pathname.slice(PANEL_API_PREFIX.length + 1)
              : ''
            if (!Object.hasOwn(api, method)) {
              sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `没有这条路由：${method}` } })
              return
            }
            try {
              const body = await readJsonBody(req)
              const value = api[method](body)
              sendJson(res, 200, { ok: true, value })
            } catch (error) {
              sendJson(res, 400, {
                ok: false,
                error: { code: 'panel-error', message: String(error?.message ?? error) },
              })
            }
          },
        }),
      'soulweave: panel routes',
    )
  } catch (error) {
    logger.warn?.(`soulweave: 面板路由注册失败：${String(error?.message ?? error)}`)
    return () => {}
  }
}
