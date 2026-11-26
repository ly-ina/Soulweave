#!/usr/bin/env node
/**
 * tools/check-layers.mjs —— 依赖方向与宿主隔离守卫。
 *
 * 规则（解耦交办单 §1 + 2026-11-24 第九刀）：
 *   core/、memory/ 只许 import `node:*` 或相对路径；
 *   memory/ 不许反向 import core/；
 *   any 层都不许 import dsh / cordis / @deepseek* / adapters（宿主耦合只能在 adapters/dsh/）。
 *   ★ core/** 除 core/io.mjs 外，不许 import node:fs / node:os / node:child_process；
 *   ★ core/** 除 io.mjs 外，不许直接读 process.env / process.cwd。
 *
 * 退出码：0 = 通过；1 = 有违规。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const layers = ['core', 'memory', 'storage']
const FORBIDDEN = [/^dsh(\/|$)/, /^cordis(\/|$)/, /^@deepseek/, /(^|\/)adapters\//]
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^\n]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
const HOST_MODULES = /^node:(fs|os|child_process|process)(\/|$)/
const SQLITE_OWNER = 'storage/driver.mjs'
const ENV_READ_RE = /\bprocess\.(env|cwd)\b/
const IO_ENTRY = 'io.mjs'

const problems = []
let scanned = 0

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 去掉整行注释后的逐行文本，避免注释里提到 process.env 被误报。 */
function codeLines(text) {
  return text
    .split(/\r?\n/)
    .map((line, i) => {
      const t = line.trim()
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return [i + 1, '']
      return [i + 1, line]
    })
}

for (const layer of layers) {
  for (const file of walk(join(ROOT, layer))) {
    scanned += 1
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    const text = readFileSync(file, 'utf8')
    const isIoEntry = rel === IO_ENTRY
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2]
      if (!spec) continue
      if (spec.startsWith('node:')) {
        // 存储驱动收口：整个仓库只有 storage/driver.mjs 能碰 node:sqlite。
        // 上层要库就 import storage/index.mjs 的 openReadonly / openReadWrite。
        if (spec === 'node:sqlite' && rel !== SQLITE_OWNER) {
          problems.push(`${rel}: node:sqlite 只许在 ${SQLITE_OWNER} 里 import；改用 ../storage/index.mjs`)
          continue
        }
        if (HOST_MODULES.test(spec) && !isIoEntry) {
          // 提示必须指向**真实存在**的出口：io.mjs 在仓库根，不是 core/ 下。
          // 且 memory/ 也不许 import core/，所以两层都用同一个相对路径 '../io.mjs'。
          problems.push(`${rel}: ${layer}/ 层不许直接 import ${spec}；改用根 io.mjs：import { … } from '../io.mjs'`)
        }
        continue
      }
      if (spec.startsWith('.')) {
        const target = resolve(dirname(file), spec).replace(/\\/g, '/')
        if (layer === 'memory' && target.includes('/core/')) {
          problems.push(`${rel}: memory 不得反向依赖 core（${spec}）`)
        }
        if (layer === 'storage' && (/\/core\//.test(target) || /\/memory\//.test(target))) {
          problems.push(`${rel}: storage 是底座，不得依赖 core/memory（${spec}）`)
        }
        if (FORBIDDEN.some((re) => re.test(spec.replace(/^\.\.?\//, '')))) {
          problems.push(`${rel}: 相对路径指向宿主层（${spec}）`)
        }
        continue
      }
      if (FORBIDDEN.some((re) => re.test(spec))) {
        problems.push(`${rel}: 禁止的宿主依赖（${spec}）`)
      } else {
        problems.push(`${rel}: 非相对、非 node: 的依赖（${spec}）`)
      }
    }
    if (!isIoEntry) {
      for (const [lineNo, line] of codeLines(text)) {
        if (ENV_READ_RE.test(line)) {
          problems.push(`${rel}:${lineNo}: ${layer}/ 层不许直接读 process.env；改用 io.mjs 的 env()/cwd()`)
        }
      }
    }
  }
}

// 同哈希副本守卫：core/hybrid.mjs 与 memory/hybrid.mjs 必须逐字节一致。
// 保留两份是为了让 `./memory` 子入口不反向依赖 core；但改一份必须同步另一份。
try {
  const hashOf = (rel) => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex')
  const coreHybrid = hashOf('core/hybrid.mjs')
  const memoryHybrid = hashOf('memory/hybrid.mjs')
  if (coreHybrid !== memoryHybrid) {
    problems.push(`core/hybrid.mjs 与 memory/hybrid.mjs 哈希不一致（${coreHybrid.slice(0, 12)} ≠ ${memoryHybrid.slice(0, 12)}）`)
  }
} catch (error) {
  problems.push(`hybrid 同哈希副本校验失败：${error.message}`)
}

if (problems.length === 0) {
  console.log(`PASS 依赖方向：${scanned} 个文件，core/memory/storage 全部零宿主依赖；core 宿主入口仅 ${IO_ENTRY}；node:sqlite 仅 ${SQLITE_OWNER}`)
  process.exit(0)
}
console.error(`FAIL 依赖方向：${problems.length} 处违规`)
for (const p of problems) console.error('  - ' + p)
process.exit(1)


