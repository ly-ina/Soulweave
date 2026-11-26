// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/** 验收用：任何 node: 内置模块都算「还没剥离」。 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('node:')) {
    const e = new Error(`裸依赖 node:${specifier.slice(5)} @ ${context.parentURL ?? '?'}`)
    e.code = 'ERR_NODE_DEP'
    throw e
  }
  return next(specifier, context)
}
