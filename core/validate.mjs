/**
 * core/validate.mjs —— 工具入参与执行边界的最后一道闸。
 *
 * 为什么需要：DSH 工具参数是模型生成的 JSON，不保证是对象；execute 里任何一次
 * SQLITE_BUSY / 文件锁 / 未预期字段都可能把异常抛回宿主，让整个工具调用变成红色报错。
 * 这里只做两件事，不多做：
 *   1. sanitizeArgs：顶层不是 plain object → 换成 {}，让工具自己返回「参数不对」；
 *   2. guardTool：execute 抛出的任何异常 → 转成 { ok:false, text }，不影响对话。
 */

/** 不是 null / 数组 / 原始值的对象。 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 顶层入参归一：非对象一律变 {}（不猜语义）。 */
export function sanitizeArgs(args) {
  return isRecord(args) ? args : {}
}

/**
 * 包一层执行守卫。name 用于错误文案；execute 的其余参数原样透传。
 * 注意：只在 adapters 层用，core 不依赖它。
 */
export function guardTool(name, execute) {
  return async (args, ...rest) => {
    try {
      const result = await execute(sanitizeArgs(args), ...rest)
      return result
    } catch (error) {
      const detail = String(error?.message ?? error)
      try {
        console.error(`[soulweave] ${name} 执行异常（已兜住）：${detail}`)
      } catch {
        /* 日志都不许再抛 */
      }
      return { ok: false, text: `【${name}】内部错误（已兜住，不影响对话）：${detail}` }
    }
  }
}
