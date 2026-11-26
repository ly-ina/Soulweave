// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * storage/index.mjs —— 存储层的公共接口。core/ 与 memory/ 只从这里取句柄。
 *
 * 六个方法：
 *   openReadonly(dbPath)            只读打开；库不存在/打不开 → null（不抛）
 *   openReadWrite(dbPath, opts)     读写打开，必要时建父目录
 *   withReadonly(dbPath, fn, fb)    打开→跑 fn→必关；任何异常走 fb
 *   closeQuietly(db)                关不掉不抛
 *   configureStorage(driver)        替换驱动（测试/未来后端）；传 null 复位
 *   storageStatus()                 自检：当前驱动、ready、最近一次打开失败的原因
 *
 * 语义约定（很重要，调用方靠它决定要不要写 try/catch）：
 *   - **本层从不抛异常**。拿不到库就是 null / 走 fallback。
 *     记忆库坏了不能拖垮魂引，这是魂引一直以来的口径，收在这里统一保证。
 *   - 句柄形状与 node:sqlite 的 DatabaseSync 相同（prepare/exec/close），
 *     所以调用点只需要把 `new DatabaseSync(p, {readOnly:true})` 换成 `openReadonly(p)`。
 */
import { existsSync, mkdirSync, statSync, dirname } from '../io.mjs'

let current = null
/** 最近一次打开失败的原因；只给诊断看，不参与控制流。 */
let lastFailure = null

function remember(dbPath, reason, detail) {
  lastFailure = {
    at: Date.now(),
    dbPath: typeof dbPath === 'string' ? dbPath : null,
    reason,
    detail: detail instanceof Error ? detail.message : (detail ?? null),
  }
  return null
}

/**
 * 替换驱动。传 null / 不传 → 复位成「没有驱动」。
 * 1.0 起本层不再自带默认实现：Node 用户 import 'soulweave/storage-node-sqlite'
 * （插件入口 index.js 已经替你做了），其它宿主 configureStorage(自己的驱动)。
 */
export function configureStorage(driver = null) {
  current = driver
  lastFailure = null
  return current
}

/** 当前驱动名（自检/申报用）。 */
export function storageDriverName() {
  return current?.name ?? 'none'
}

/**
 * 存储层自检：为什么打不开库，一眼能看出来。
 *   ready=false 时 lastFailure.reason ∈
 *     no-driver   宿主没调 configureStorage（Node 入口会自己装）
 *     no-path     调用方没给库路径
 *     not-a-file  路径不存在 / 是目录
 *     mkdir-failed 建父目录失败
 *     open-failed 驱动抛了（损坏、被锁、权限）
 */
export function storageStatus() {
  return { driver: storageDriverName(), ready: current != null, lastFailure }
}

function usableFile(dbPath) {
  if (!dbPath) return false
  try {
    return existsSync(dbPath) && statSync(dbPath).isFile()
  } catch {
    return false
  }
}

/** 只读打开。库不存在、是目录、损坏、被独占锁 —— 一律 null。 */
export function openReadonly(dbPath) {
  if (!current) return remember(dbPath, 'no-driver')
  if (!dbPath) return remember(dbPath, 'no-path')
  if (!usableFile(dbPath)) return remember(dbPath, 'not-a-file')
  try {
    return current.open(dbPath, { readOnly: true })
  } catch (e) {
    return remember(dbPath, 'open-failed', e)
  }
}

/** 读写打开（必要时建库建父目录）。失败返回 null，由调用方决定提示。 */
export function openReadWrite(dbPath, { create = true } = {}) {
  if (!current) return remember(dbPath, 'no-driver')
  if (!dbPath) return remember(dbPath, 'no-path')
  if (!existsSync(dbPath)) {
    if (!create) return remember(dbPath, 'not-a-file')
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
    } catch (e) {
      return remember(dbPath, 'mkdir-failed', e)
    }
  }
  try {
    return current.open(dbPath, { readOnly: false })
  } catch (e) {
    return remember(dbPath, 'open-failed', e)
  }
}

/**
 * 门面：按 readOnly 分流到只读/读写。
 * 给「原来写 `new DatabaseSync(path, { readOnly })` 且 readOnly 是变量」的调用点用；
 * 常量只读/读写请直接调 openReadonly / openReadWrite，语义更明确。
 */
export function openDatabase(dbPath, { readOnly = false, create = true } = {}) {
  return readOnly ? openReadonly(dbPath) : openReadWrite(dbPath, { create })
}

export function closeQuietly(db) {
  try {
    db?.close()
  } catch {
    /* 关不掉不影响主流程 */
  }
}

/**
 * 打开只读库跑一段逻辑，**无论成败都关掉**。
 * fn 收到句柄；fn 自己抛的错会被吃掉并返回 fallback —— 因为本层契约是不抛。
 * 需要区分「库打不开」和「查询出错」时，直接 openReadonly + try/finally。
 */
export function withReadonly(dbPath, fn, fallback) {
  const fallbackValue = () => (typeof fallback === 'function' ? fallback() : fallback)
  const db = openReadonly(dbPath)
  if (!db) return fallbackValue()
  try {
    return fn(db)
  } catch {
    return fallbackValue()
  } finally {
    closeQuietly(db)
  }
}

