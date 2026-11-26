// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * memory/health.mjs —— 记忆库健康检查。
 *
 * 为什么要有它：读路径全是**静默降级**（`openDb` 返回 null、`search` 返回空集 + note），
 * 这对插件是对的——库坏了不能让对话崩。但对 SDK 是灾难：
 * 调用方分不清「没有相关记忆」和「记忆库打不开」。
 *
 * 这个模块回答两个问题：
 *   ① `health` —— **这个库现在到底能不能用。** 只读，不建库、不写、不迁移，
 *      代价是一次 stat + 一次只读打开，可以随时调。
 *   ② `initMemoryDb` —— **第一次用之前能不能把它建起来。** 写一次、立刻关句柄、再只读复核。
 *      见下面的注释：为什么不直接导出 ensureDb。
 *
 * 依赖方向：node:* 之外的一切宿主能力都走根 `io.mjs`（memory/ 不许 import core/，
 * 也不许直接 import node:fs——那条约定由 tools/check-layers.mjs 守）。
 */
import { statSync } from '../io.mjs'
import { ensureDb, openDb } from './builtin.mjs'
/** 判定阶段，按顺序推进；`stage` 停在第一个失败处，便于定位。 */
export const HEALTH_STAGES = Object.freeze(['path', 'exists', 'open', 'schema', 'read', 'done'])

const fail = (stage, reason, extra = {}) => ({
  ok: false,
  stage,
  reason,
  path: extra.path ?? '',
  records: null,
  journalMode: null,
  busyTimeout: null,
  ...extra,
})

/**
 * 检查一个记忆库。
 *
 * @param {string} dbPath 库路径
 * @returns {{
 *   ok: boolean, stage: string, reason: string, path: string,
 *   records: number|null, journalMode: string|null, busyTimeout: number|null,
 *   sizeBytes?: number, tables?: number
 * }}
 */
export function health(dbPath) {
  const path = typeof dbPath === 'string' ? dbPath.trim() : ''
  if (path === '') return fail('path', '未提供 dbPath')

  let st = null
  try {
    st = statSync(path)
  } catch {
    return fail('exists', '路径不存在', { path })
  }
  if (st.isDirectory()) return fail('exists', '路径是一个目录，不是 SQLite 文件', { path })

  let db = null
  try {
    // 走 openDb 而不是裸 new DatabaseSync：openDb 会设 pragma busy_timeout。
    // 裸连接的 busy_timeout 是 0，摘要里会显示「busy=0ms」，让人误以为写连接也没设（实际是 4000）。
    db = openDb(path)
    if (!db) return fail('open', '打不开（openDb 返回 null）', { path, sizeBytes: st.size })
  } catch (error) {
    return fail('open', `打不开：${error?.message ?? error}`, { path, sizeBytes: st.size })
  }

  try {
    const hasMemories = db
      .prepare("select name from sqlite_master where type='table' and name='memories'")
      .get()
    if (!hasMemories) {
      const tables = db.prepare("select count(*) c from sqlite_master where type='table'").get()
      return fail('schema', '缺 memories 表（不是魂织的库，或还没初始化）', {
        path,
        sizeBytes: st.size,
        tables: Number(tables?.c ?? 0),
      })
    }

    const row = db.prepare('select count(*) c from memories').get()
    const records = Number(row?.c ?? 0)
    let journalMode = null
    let busyTimeout = null
    try {
      journalMode = String(db.prepare('pragma journal_mode').get()?.journal_mode ?? '')
    } catch {}
    try {
      busyTimeout = Number(db.prepare('pragma busy_timeout').get()?.timeout ?? -1)
    } catch {}

    return {
      ok: true,
      stage: 'done',
      reason: '',
      path,
      records,
      journalMode,
      busyTimeout,
      sizeBytes: st.size,
    }
  } catch (error) {
    return fail('read', `读表失败：${error?.message ?? error}`, { path, sizeBytes: st.size })
  } finally {
    try {
      db.close()
    } catch {}
  }
}

/**
 * 首次使用时建库，建完立刻关句柄，再做一次只读体检。幂等，可以每次启动都调。
 *
 * 为什么不直接导出 `ensureDb`：它返回活的 `DatabaseSync` 句柄，调用方得自己 `close()`；
 * Windows 上句柄没关会锁住目录，删不掉也搬不走。这里建完就关，调用方只拿结果。
 *
 * 注意写路径（`putMemory` / `putTodo` …）本来也会按需建库，所以这个函数对「能写进去」
 * 不是必须的；它的价值是把「库建不起来」从第一次写入失败提前到服务启动时失败，
 * 并且让调用方不用碰内部模块和句柄。
 *
 * @param {string} dbPath 库路径
 * @returns {ReturnType<typeof health>} 与 health() 同形状，可直接交给 renderHealth()
 */
export function initMemoryDb(dbPath) {
  const path = typeof dbPath === 'string' ? dbPath.trim() : ''
  if (path === '') return fail('path', '未提供 dbPath')
  const db = ensureDb(path)
  if (db) {
    try {
      db.close()
    } catch {}
    return health(path)
  }
  // ensureDb 返回 null：目录不可写、库损坏或被占用。health 会停在第一个失败阶段，
  // 但「路径不存在」容易被当成参数写错，这里补一句说明是建库失败。
  const h = health(path)
  if (h.stage === 'exists') return { ...h, reason: `${h.reason}（建库也失败了：目录不可写或被占用）` }
  return h
}

/** 一行摘要，给日志和工具返回用。 */
export function renderHealth(h) {
  if (!h) return '（无结果）'
  if (!h.ok) return `不可用 [${h.stage}] ${h.reason}`
  return `可用 · ${h.records} 条 · ${h.journalMode} · busy=${h.busyTimeout}ms · ${Math.round((h.sizeBytes ?? 0) / 1024)}KB`
}

/**
 * 判断一次 `search()` 的返回是否代表「库坏了」而不是「没命中」。
 *
 * 优先用结构化信号 `degraded`（builtin.search 会显式给 true/false），
 * 没有该字段时才退回 note 语义匹配——用于兼容 hybrid 等按旧形状返回的路径。
 */
export function isBrokenSearchResult(result) {
  if (!result || !Array.isArray(result.entries)) return true
  if (typeof result.degraded === 'boolean') return result.degraded
  const note = typeof result.note === 'string' ? result.note : ''
  return /打不开|失败|异常/.test(note)
}
