// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * dsh-soulweave —— 插件入口薄壳：只做装配与宿主导出。
 *
 * 分层：core/（零宿主依赖）· memory/（存储与检索）· adapters/dsh/（宿主耦合）。
 * 对外契约只有 `./sdk`（20 个承诺导出）。1.0 起根路径不再附带内部面——
 * `unstable.mjs` 已删除；确实要更深的入口请直接 import 具体模块。
 */
export const name = 'soulweave'

/** §9.4：需要动 `ctx.tools` 就必须经 inject 声明。 */
export const inject = ['tools', 'webServer']

// 宿主装配：Node 的 IO 与 sqlite 驱动。必须排在其它 import 之前（ESM 按声明顺序求值）。
import './io-node.mjs'
import './storage/node-sqlite.mjs'

import { MESSAGE_KIND } from './core/constants.mjs'
import { apply, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools } from './adapters/dsh/apply.mjs'
import { createPreStepHandler } from './adapters/dsh/prestep.mjs'

export { apply, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools, createPreStepHandler }

export * from './sdk.mjs'

export default { name, inject, apply, MESSAGE_KIND }
