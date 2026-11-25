/**
 * dsh-soulweave —— 插件入口薄壳：只做装配与宿主导出。
 *
 * 分层：core/（零宿主依赖）· memory/（存储与检索）· adapters/dsh/（宿主耦合）。
 * 纯 SDK 出口拆到 sdk.mjs / `./sdk` 子路径——那里不 import 任何 adapters/dsh/*，
 * 外部消费者用它就不会被插件入口的宿主依赖拖住。
 */
export const name = 'soulweave'

/** §9.4：需要动 `ctx.tools` 就必须经 inject 声明。 */
export const inject = ['tools', 'webServer']

import { MESSAGE_KIND } from './core/constants.mjs'
import { apply, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools } from './adapters/dsh/apply.mjs'
import { createPreStepHandler } from './adapters/dsh/prestep.mjs'

export { apply, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools, createPreStepHandler }

// 向后兼容：`import { ... } from 'soulweave'` 仍然拿到全部公开面（承诺面 + 不承诺面）。
// 新代码请用 './sdk' 子路径——那里才是承诺的东西。
export * from './sdk.mjs'
export * from './unstable.mjs'

export default { name, inject, apply, MESSAGE_KIND }
