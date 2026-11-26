// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * storage/driver.mjs —— **整个仓库唯一允许 import `node:sqlite` 的地方**。
 *
 * 规则（tools/check-layers.mjs 机器校验）：
 *   core/、memory/、storage/ 里只有本文件可以 `import ... from 'node:sqlite'`。
 *
 * 为什么收成一处：driver 决定的是「库怎么开」——只读/读写、锁等待、未来的加密或远程后端。
 * 上层（core/memory）只该关心「拿到一个能 prepare/query 的句柄」，不该知道用的是哪个实现。
 *
 * 换驱动的契约（最小面）：driver.open(path, { readOnly }) 必须返回一个对象，具备
 *   prepare(sql) -> { get(...p), all(...p), run(...p) }
 *   exec(sql) / close()
 * 与 node:sqlite 的 DatabaseSync 同形。做不到这一层的后端，先补一层适配再注册。
 */
import { DatabaseSync } from 'node:sqlite'

/** 与 memory/builtin.mjs 原口径一致：等锁而不是直接 SQLITE_BUSY。 */
export const DEFAULT_BUSY_TIMEOUT_MS = 4000

export const sqliteDriver = Object.freeze({
  name: 'node:sqlite',

  open(dbPath, { readOnly = false, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS } = {}) {
    const db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {})
    try {
      db.exec(`pragma busy_timeout = ${busyTimeoutMs}`)
    } catch {
      /* 只读连接或旧版不支持时退回默认，不挡路 */
    }
    return db
  },
})
