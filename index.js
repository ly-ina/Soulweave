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
/**
 * DSH / cordis 约定：设置面板看到的默认配置。
 * 只列「用户会改」的键，且都是 normalizeConfig 的**原始输入**口径；
 * 派生项（stateDir、sqlite 驱动、预算换算）不在这里，运行时仍以 normalizeConfig 为准。
 * 其它宿主（MCP / SDK）不会读这个导出，忽略即可。
 */
export const DEFAULT_CONFIG = Object.freeze({
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

/**
 * 2026-11-27：cordis 的 `resolveConfig` 只认 standard-schema（`Config['~standard'].validate`）。
 * 以前这里导出的是一个普通对象，宿主拿到模块后先 `Config['~standard']` 取不到 → TypeError
 * → apply 根本不会被调用，插件静默消失（魂引一整天零注入就是这个）。
 * 现在给一个合法的 standard-schema：原样收下用户配置，默认值仍由 normalizeConfig 补。
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'soulweave',
    validate(value) {
      return { value: value ?? {} }
    },
  }),
})

/** 面板注册要 `ctx.webServer`，cordis 会按 inject 校验属性访问，漏声明就直接抛。 */
export const inject = ['tools', 'webServer']

// 宿主装配：Node 的 IO 与 sqlite 驱动。必须排在其它 import 之前（ESM 按声明顺序求值）。
import './io-node.mjs'
import './storage/node-sqlite.mjs'

import { MESSAGE_KIND } from './core/constants.mjs'
import { apply as applyInner, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools } from './adapters/dsh/apply.mjs'
import { createPreStepHandler } from './adapters/dsh/prestep.mjs'

export { applyInner as apply, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools, createPreStepHandler }

export * from './sdk.mjs'

export default { name, inject, Config, DEFAULT_CONFIG, apply: applyInner, MESSAGE_KIND }
