// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * dsh-soulweave —— 插件入口薄壳：只做装配与宿主导出。
 *
 * 分层：core/（零宿主依赖）· memory/（存储与检索）· adapters/dsh/（宿主耦合）。
 * 对外契约只有 `./sdk`（20 个承诺导出）。1.0 起根路径不再附带内部面——
 * `unstable.mjs` 已删除；确实要更深的入口请直接 import 具体模块。
 */
export const name = 'soulweave'

// 临时哨兵（2026-11-27 排查「插件静默不加载」）：确认模块有没有被 import。
// 查完即删。
import { appendFileSync } from 'node:fs'
try {
  appendFileSync('C:/Users/Lenovo/.dsh/soul/boot.log', `${new Date().toISOString()} imported\n`)
} catch {}

/** §9.4：需要动 `ctx.tools` 就必须经 inject 声明。 */
/**
 * DSH / cordis 约定：设置面板看到的默认配置。
 * 只列「用户会改」的键，且都是 normalizeConfig 的**原始输入**口径；
 * 派生项（stateDir、sqlite 驱动、预算换算）不在这里，运行时仍以 normalizeConfig 为准。
 * 其它宿主（MCP / SDK）不会读这个导出，忽略即可。
 */
export const Config = Object.freeze({
  soulPath: '',
  autoInitSoul: true,
  memoryBackend: 'builtin',
  memoryDbPath: '',
  soulMaxTokens: 1000,
  totalMaxTokens: 950,
  recallLimit: 3,
  rulesDir: '',
  soulIndexDir: '',
  sealedSegmentsModule: '',
  hybridSearch: false,
})

export const inject = ['tools']

// 宿主装配：Node 的 IO 与 sqlite 驱动。必须排在其它 import 之前（ESM 按声明顺序求值）。
import './io-node.mjs'
import './storage/node-sqlite.mjs'

import { MESSAGE_KIND } from './core/constants.mjs'
import { apply as applyInner, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools } from './adapters/dsh/apply.mjs'
import { createPreStepHandler } from './adapters/dsh/prestep.mjs'

function traceApply(phase, e) {
  try {
    appendFileSync('C:/Users/Lenovo/.dsh/soul/boot.log', `${new Date().toISOString()} apply ${phase}: ${String((e && e.stack) || e).slice(0, 1200)}\n`)
  } catch {}
}

// 临时包壳（2026-11-27）：把 apply 里的异常落到 boot.log，查完即删。
function apply(ctx, config) {
  try {
    const r = applyInner(ctx, config)
    if (r && typeof r.then === 'function') return r.catch((e) => { traceApply('rejected', e); throw e })
    return r
  } catch (e) {
    traceApply('threw', e)
    throw e
  }
}

export { apply, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools, createPreStepHandler }

export * from './sdk.mjs'

export default { name, inject, Config, apply, MESSAGE_KIND }
