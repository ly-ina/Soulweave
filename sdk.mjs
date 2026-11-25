/**
 * sdk.mjs —— 对外稳定契约。**只有这里的东西承诺语义化版本。**
 *
 * 为什么不把整个 core/memory 都放出来：导出越多，承诺越多。130 个导出里每多一个，
 * 以后改它都算破坏性变更；而 bigramsOf 这种内部工具改掉根本不该惊动任何人。
 * 其余导出在 unstable.mjs（明确不承诺）；index.js 为向后兼容仍把两者都带出来。
 *
 * 入口：import { routeRecords } from "@ly-ina/dsh-soulweave/sdk"
 */

// 人格文本：拼装 + 现状行
export { composeSoulState, renderDueLine } from './core/soul.mjs'

// 记录路由：※记 / ※办 / ※结 的入口
export { routeRecords, renderRouteResult } from './memory/route.mjs'

// 时间与锚点
export { parseDue } from './memory/time.mjs'
export { anchorOf, looksLikeAnchor, parseSettle, renderAnchored } from './memory/anchor.mjs'

// 存储与检索
export { putMemory, search, putTodo, listTodos, listDueItems, setTodoStatus } from './memory/builtin.mjs'

// 体检与首次初始化
export { health, renderHealth, isBrokenSearchResult, initMemoryDb } from './memory/health.mjs'
