/**
 * io.mjs —— 整个插件的宿主环境入口（文件系统 / OS / 进程环境），不属于 core 也不属于 memory。
 *
 * 规则（tools/check-layers.mjs 机器校验）：
 *   core/** 除本文件外，不许 import node:fs / node:os / node:child_process；
 *   core/** 也不许直接读 process.env / process.cwd。
 *
 * 为什么：core 是纯记忆逻辑，不该知道自己在 Windows 还是 Linux、库落在哪个盘。
 * 抽到这里之后：
 *   - 单测可以 configureIo({ readFileSync: () => { throw ... } }) 注入故障（SQLITE_BUSY / 磁盘满 / JSON 坏）；
 *   - 换宿主（CLI、未来别的 harness）只换一份注入表；
 *   - 路径来源只有 dsHome() 一处。
 */
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'
import { spawn as realSpawn } from 'node:child_process'

const real = {
  readFileSync: (...a) => realFs.readFileSync(...a),
  writeFileSync: (...a) => realFs.writeFileSync(...a),
  appendFileSync: (...a) => realFs.appendFileSync(...a),
  existsSync: (...a) => realFs.existsSync(...a),
  mkdirSync: (...a) => realFs.mkdirSync(...a),
  readdirSync: (...a) => realFs.readdirSync(...a),
  statSync: (...a) => realFs.statSync(...a),
  copyFileSync: (...a) => realFs.copyFileSync(...a),
  unlinkSync: (...a) => realFs.unlinkSync(...a),
  renameSync: (...a) => realFs.renameSync(...a),
  rmSync: (...a) => realFs.rmSync(...a),
  mkdtempSync: (...a) => realFs.mkdtempSync(...a),
  homedir: () => realOs.homedir(),
  tmpdir: () => realOs.tmpdir(),
  env: (name) => process.env[name],
  cwd: () => process.cwd(),
  platform: () => process.platform,
  envAll: () => ({ ...process.env }),
  spawnProcess: (command, args, options) => realSpawn(command, args, options),
}

let current = real
let injected = false

/** 注入替身（测试/故障演练用）。只覆盖给出的键，其余保持真实实现。 */
export function configureIo(overrides = {}) {
  current = { ...real, ...overrides }
  injected = true
  return current
}

/** 恢复真实实现。 */
export function resetIo() {
  current = real
  injected = false
}

/** 当前是否处于注入态；以及注入了哪些键（给自检断言用）。 */
export function ioStatus() {
  return {
    injected,
    overridden: Object.keys(current).filter((k) => current[k] !== real[k]),
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
export function spawnProcess(...a) { return current.spawnProcess(...a) }

/** 纯路径函数：不碰环境，原样转出，省得每个 core 文件各自 import node:path。 */
export const join = realPath.join
export const resolve = realPath.resolve
export const dirname = realPath.dirname
export const basename = realPath.basename
export const extname = realPath.extname
export const relative = realPath.relative
export const isAbsolute = realPath.isAbsolute
export const sep = realPath.sep

