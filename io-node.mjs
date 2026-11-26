import { existsSync } from 'node:fs'
import * as realFs from 'node:fs'
import * as realOs from 'node:os'
import * as realPath from 'node:path'
import { spawn as realSpawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { configureIo } from './io.mjs'

/**
 * io-node.mjs —— io.mjs 的 Node 实现。**只有这里可以 import node:**。
 *
 * `import 'soulweave/io-node'` 即完成装配（插件入口 index.js 第一行就是它）。
 * 非 Node 宿主不要 import 本文件，改 configureIo({...}) 自己注入。
 */
configureIo({
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
  argv: () => process.argv,
  spawnProcess: (command, args, options) => realSpawn(command, args, options),
  zstdCompressSync: (...a) => zstdCompressSync(...a),
  zstdDecompressSync: (...a) => zstdDecompressSync(...a),
  requireResolve: (base, spec) => createRequire(base).resolve(spec),
})
