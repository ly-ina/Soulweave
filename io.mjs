// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * io.mjs —— 整个插件的宿主环境门面（文件系统 / OS / 进程 / 压缩 / 动态加载）。
 * **本文件零 `node:` import。** 1.0 起，任何宿主能力都必须由外部注入。
 *
 * 分工：
 *   - 本文件：只有转发 + 注入，import 进 SDK 面也不会断。
 *   - io-node.mjs：Node 实现，`import 'soulweave/io-node'` 自动注册。
 *   - index.js（插件入口）：第一行就是 import io-node.mjs，因此 DSH 里无需额外操作。
 *   - 纯函数（path / sha256 / file URL）**不注入**，直接用同目录的零依赖实现，
 *     因为它们是字符串运算，不属于宿主能力。
 *
 * 未注入时的行为约定：
 *   - 读类（existsSync / env / ioStatus）返回空值，不抛；
 *   - 写类与进程类抛错，错误信息直接告诉你怎么装配。
 *   这样「忘了装配」会以一条清楚的错出现，而不是静默写坏东西。
 */
import { join, resolve, dirname, basename, extname, relative, isAbsolute, sep, normalize, parse, format, toNamespacedPath } from './path.mjs'

export { join, resolve, dirname, basename, extname, relative, isAbsolute, sep, normalize, parse, format, toNamespacedPath }
export { createHash, sha256Hex, sha256Bytes } from './sha256.mjs'

const NOT_CONFIGURED = (what) =>
  new Error(`soulweave: 宿主 IO 未配置（${what}）。Node 下 import 'soulweave/io-node' 或 './io-node.mjs'；其它宿主用 configureIo({...}) 注入。`)

/** 未装配时的缺省实现：读类给空值，写类抛明确错误。 */
const empty = {
  readFileSync() { throw NOT_CONFIGURED('readFileSync') },
  writeFileSync() { throw NOT_CONFIGURED('writeFileSync') },
  appendFileSync() { throw NOT_CONFIGURED('appendFileSync') },
  existsSync() { return false },
  mkdirSync() { throw NOT_CONFIGURED('mkdirSync') },
  readdirSync() { return [] },
  statSync() { throw NOT_CONFIGURED('statSync') },
  copyFileSync() { throw NOT_CONFIGURED('copyFileSync') },
  unlinkSync() { throw NOT_CONFIGURED('unlinkSync') },
  renameSync() { throw NOT_CONFIGURED('renameSync') },
  rmSync() { throw NOT_CONFIGURED('rmSync') },
  mkdtempSync() { throw NOT_CONFIGURED('mkdtempSync') },
  homedir() { return '' },
  tmpdir() { return '' },
  env() { return undefined },
  cwd() { return '/' },
  platform() { return 'unknown' },
  envAll() { return {} },
  argv() { return [] },
  spawnProcess() { throw NOT_CONFIGURED('spawnProcess') },
  zstdCompressSync() { throw NOT_CONFIGURED('zstdCompressSync') },
  zstdDecompressSync() { throw NOT_CONFIGURED('zstdDecompressSync') },
  requireResolve() { throw NOT_CONFIGURED('requireResolve') },
}

let current = empty
/** 第一次 configureIo 视为「宿主基线」；之后都是临时覆盖，resetIo 回到基线。 */
let baseline = empty

/** 注入宿主实现。只覆盖给出的键，其余沿用基线。 */
export function configureIo(overrides = {}) {
  if (baseline === empty) baseline = { ...empty, ...overrides }
  current = { ...baseline, ...overrides }
  return current
}

/** 恢复宿主基线（测试注入故障后收尾用）。未装配过时就是 empty。 */
export function resetIo() {
  current = baseline
  return current
}

/** 当前是否已装配；以及相对空实现覆盖了哪些键（自检断言用）。 */
export function ioStatus() {
  return {
    injected: current !== empty,
    overridden: Object.keys(current).filter((k) => current[k] !== empty[k]),
  }
}

export function readFileSync(...a) { return current.readFileSync(...a) }
export function writeFileSync(...a) { return current.writeFileSync(...a) }
export function appendFileSync(...a) { return current.appendFileSync(...a) }
export function existsSync(...a) { return current.existsSync(...a) }
export function mkdirSync(...a) { return current.mkdirSync(...a) }
export function readdirSync(...a) { return current.readdirSync(...a) }
export function statSync(...a) { return current.statSync(...a) }
export function copyFileSync(...a) { return current.copyFileSync(...a) }
export function unlinkSync(...a) { return current.unlinkSync(...a) }
export function renameSync(...a) { return current.renameSync(...a) }
export function rmSync(...a) { return current.rmSync(...a) }
export function mkdtempSync(...a) { return current.mkdtempSync(...a) }
export function homedir() { return current.homedir() }
export function tmpdir() { return current.tmpdir() }
export function env(name) { return current.env(name) }
export function cwd() { return current.cwd() }
export function platform() { return current.platform() }
export function envAll() { return current.envAll() }
export function argv() { return current.argv() }
/** 命令行参数（去掉 node 与脚本路径）。CLI 直跑用。 */
export function cliArgs() { return current.argv().slice(2) }
export function spawnProcess(...a) { return current.spawnProcess(...a) }
export function zstdCompressSync(...a) { return current.zstdCompressSync(...a) }
export function zstdDecompressSync(...a) { return current.zstdDecompressSync(...a) }
export function requireResolve(...a) { return current.requireResolve(...a) }

/**
 * `file:///E:/x/y` → `E:\x\y`。纯字符串，不借 node:url。
 * 非盘符路径保持 posix 形态。
 */
export function fileURLToPath(url) {
  const s = String(url ?? '')
  if (!s.startsWith('file://')) throw new TypeError(`fileURLToPath：不是 file URL：${s}`)
  let rest = s.slice('file://'.length)
  if (rest.startsWith('localhost/')) rest = rest.slice('localhost'.length)
  let decoded = rest
  try { decoded = decodeURIComponent(rest) } catch { /* 保留原样 */ }
  if (/^\/[A-Za-z]:[\\/]/.test(decoded)) return decoded.slice(1).replace(/\//g, '\\')
  return decoded
}

/** `E:\x\y` → file URL。用标准 URL 做百分号编码。 */
export function pathToFileURL(path) {
  let s = String(path ?? '').replace(/\\/g, '/')
  if (!s.startsWith('/')) s = '/' + s
  return new URL('file://' + s)
}

/** 该模块是不是被直接运行的入口（`node soul_lint.mjs`）。 */
export function isMainModule(metaUrl) {
  const entry = current.argv()[1]
  if (!entry) return false
  try { return String(metaUrl) === pathToFileURL(resolve(entry)).href } catch { return false }
}
