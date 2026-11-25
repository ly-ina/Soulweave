#!/usr/bin/env node
/**
 * tools/gen-api.mjs —— 从源码 JSDoc 生成 docs/API.md。
 *
 * 为什么用生成而不是手写：手写的 API 文档一定会过时，而且过时的文档比没有更糟——
 * 它让人相信一个已经不成立的签名。所以这里做两件事：
 *   1. 生成：扫 `core/` `memory/` `/io.mjs` 的 export，取紧邻的 JSDoc；
 *   2. 校验：`--check` 模式下与现有 docs/API.md 比对，不一致就退出码 1（CI 用）。
 *
 * 用法：
 *   node tools/gen-api.mjs           # 生成/覆盖 docs/API.md
 *   node tools/gen-api.mjs --check   # 只校验是否最新（CI）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOC_PATH = join(ROOT, 'docs', 'API.md')
const CHECK = process.argv.includes('--check')

const SCAN_DIRS = ['core', 'memory']
const SCAN_ROOT_FILES = ['io.mjs']

/** 去掉开头的 `{类型}`，支持嵌套大括号（`{{a: b}}`）。 */
function stripTypeBraces(input) {
  const rest = String(input ?? '').trim()
  if (!rest.startsWith('{')) return rest
  let depth = 0
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '{') depth += 1
    else if (rest[i] === '}') {
      depth -= 1
      if (depth === 0) return rest.slice(i + 1).trim()
    }
  }
  return rest
}

/** 从 `/** … *\/` 里抽摘要 / @param / @returns。 */
function parseDoc(block) {
  const lines = String(block ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*?\s?/, '').trimEnd())
  const summary = []
  const params = []
  const returns = []
  let mode = 'summary'
  for (const line of lines) {
    const t = line.trim()
    if (t === '') {
      if (mode === 'summary' && summary.length > 0) mode = 'skip'
      continue
    }
    if (t.startsWith('@param')) {
      mode = 'param'
      const rest = stripTypeBraces(t.slice('@param'.length))
      const sp = rest.search(/\s/)
      const name = sp < 0 ? rest : rest.slice(0, sp)
      const desc = sp < 0 ? '' : rest.slice(sp + 1).trim()
      if (name) params.push({ name, desc })
      continue
    }
    if (t.startsWith('@returns') || t.startsWith('@return')) {
      mode = 'return'
      returns.push(stripTypeBraces(t.replace(/^@returns?/, '')))
      continue
    }
    if (t.startsWith('@')) {
      mode = 'skip'
      continue
    }
    if (mode === 'summary') summary.push(t)
    else if (mode === 'param' && params.length > 0) params[params.length - 1].desc += ` ${t}`
    else if (mode === 'return') returns[returns.length - 1] += ` ${t}`
  }
  return {
    summary: summary.join(' ').trim(),
    params,
    returns: returns.join(' ').trim(),
    hasDoc: lines.some((l) => l.trim() !== ''),
  }
}

/**
 * 找 index 之前的紧邻 JSDoc 块。
 *
 * 不能用「非贪婪 + 结尾锚定」的正则：它会从**文件头**的块注释起步，一路回溯到最后一个
 * 闭合符，把整段代码都吞进 body，起点永远算成 0。
 * 正确做法是从结尾往前找：最后一个闭合符之后必须只剩空白，再找配对的起始符。
 */
function docBlockBefore(text, index) {
  const before = text.slice(0, index)
  const close = before.lastIndexOf('*/')
  if (close === -1) return { body: '', start: -1 }
  if (before.slice(close + 2).trim() !== '') return { body: '', start: -1 } // 中间隔着代码，不是紧邻
  const open = before.lastIndexOf('/**', close)
  if (open === -1) return { body: '', start: -1 }
  return { body: before.slice(open + 3, close), start: open }
}

/**
 * 公开面在 sdk.mjs 里（index.js 只是插件入口 + 向后兼容的 `export * from './sdk.mjs'`）。
 * 读 index.js 会漏掉 `export *` 后面的所有名字——0.5.4 拆 SDK 时踩过一次。
 */
const SURFACE_FILE = existsSync(join(ROOT, 'sdk.mjs')) ? 'sdk.mjs' : 'index.js'

/** sdk.mjs 里显式导出的名字 + 是否 export * memory。 */
function readPublicSurface() {
  let text = ''
  try {
    text = readFileSync(join(ROOT, SURFACE_FILE), 'utf8')
  } catch {
    return { names: new Set(), starMemory: false }
  }
  const names = new Set()
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  for (const m of text.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(m[1])
  for (const m of text.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*=/g)) names.add(m[1])
  return { names, starMemory: /export\s*\*\s*from\s*['"]\.\/memory\/index\.mjs/.test(text) }
}

const EXPORT_RE = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^export\s+const\s+([A-Za-z0-9_$]+)\s*=/gm

function scanFile(absPath, rel) {
  const text = readFileSync(absPath, 'utf8')
  const headerMatch = /\/\*\*[\s\S]*?\*\//.exec(text)
  const headerStart = headerMatch ? headerMatch.index : -1
  const items = []
  for (const m of text.matchAll(EXPORT_RE)) {
    const name = m[1] ?? m[2]
    const start = m.index ?? 0
    const kind = m[1] ? 'function' : 'const'
    // 函数签名：取到第一个 '{' 或行尾
    let signature = name
    if (kind === 'function') {
      // 不能用非贪婪到第一个 `)`：参数里可能有 `Date.now()` / 对象解构，会被截断。
      const after = text.slice(start, start + 800)
      const fn = /(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(after)
      if (fn) {
        const open = after.indexOf('(', fn.index + fn[0].length - 1)
        if (open >= 0) {
          let depth = 0
          let close = -1
          for (let i = open; i < after.length; i += 1) {
            if (after[i] === '(') depth += 1
            else if (after[i] === ')') {
              depth -= 1
              if (depth === 0) { close = i; break }
            }
          }
          if (close > open) {
            const args = after.slice(open + 1, close).replace(/\s+/g, ' ').replace(/,\s*/g, ', ').trim()
            signature = `${name}(${args.length > 70 ? '…' : args})`
          }
        }
      }
    } else {
      signature = name
    }
    const doc = docBlockBefore(text, start)
    // 模块头注释不是这个函数的文档，别把文件简介贴到第一个 export 上
    const isHeader = doc.start >= 0 && doc.start === headerStart
    items.push({ name, kind, signature, rel, doc: parseDoc(isHeader ? '' : doc.body) })
  }
  return items
}

function collect() {
  const files = []
  for (const dir of SCAN_DIRS) {
    const abs = join(ROOT, dir)
    if (!existsSync(abs)) continue
    for (const entry of readdirSync(abs).filter((f) => f.endsWith('.mjs')).sort()) {
      files.push({ abs: join(abs, entry), rel: `${dir}/${entry}` })
    }
  }
  for (const name of SCAN_ROOT_FILES) {
    const abs = join(ROOT, name)
    if (existsSync(abs)) files.push({ abs, rel: name })
  }

  const groups = []
  for (const file of files) {
    const items = scanFile(file.abs, file.rel)
    if (items.length > 0) groups.push({ rel: file.rel, items })
  }
  return groups
}

function render(groups) {
  const { names } = readPublicSurface()
  // 只认 index.js **显式**导出。`export * from './memory/index.mjs'` 不算公开契约——
  // 那是「方便内部用」，不是承诺。想公开就显式写出来。
  const isPublic = (item) => names.has(item.name)
  const SHOW_ALL = process.argv.includes('--all')
  const hasDoc = (item) => item.doc.summary !== ''

  const all = groups.flatMap((g) => g.items)
  const pub = all.filter(isPublic)
  const documented = pub.filter(hasDoc)
  const undocumented = pub.filter((i) => !hasDoc(i))

  const out = []
  out.push('# API 参考')
  out.push('')
  out.push('> 本文件由 `node tools/gen-api.mjs` 从源码 JSDoc 生成，**不要手改**。')
  out.push('> 改了签名就重新生成；CI 会跑 `--check`，过期会直接失败。')
  out.push('')
  out.push('只列 `index.js` **显式导出**且**有 JSDoc 摘要**的 API。')
  out.push('内部 API 用 `--all` 查看；公开但没写摘要的在文末列名单。')
  out.push('')
  out.push(`统计：共 ${all.length} 个导出；公开 ${pub.length} 个，其中 ${documented.length} 个有文档、${undocumented.length} 个待补。`)
  out.push('')

  let shown = 0
  for (const group of groups) {
    const picked = group.items.filter((item) => (SHOW_ALL ? true : isPublic(item) && hasDoc(item)))
    if (picked.length === 0) continue
    shown += picked.length
    out.push(`## \`${group.rel}\``)
    out.push('')
    for (const item of picked) {
      out.push(`### \`${item.signature}\``)
      out.push('')
      if (item.doc.summary) {
        out.push(item.doc.summary)
        out.push('')
      }
      if (item.doc.params.length > 0) {
        out.push('| 参数 | 说明 |')
        out.push('|---|---|')
        for (const p of item.doc.params) out.push(`| \`${p.name}\` | ${p.desc.replace(/\|/g, '\\|')} |`)
        out.push('')
      }
      if (item.doc.returns) {
        out.push(`**返回** ${item.doc.returns}`)
        out.push('')
      }
    }
  }
  if (shown === 0) {
    out.push('（没有带文档的公开导出）')
    out.push('')
  }

  if (!SHOW_ALL && undocumented.length > 0) {
    out.push('---')
    out.push('')
    out.push(`## 待补文档的公开 API（${undocumented.length} 个）`)
    out.push('')
    out.push('这些名字从 `index.js` 导出，但源码里没有 JSDoc 摘要。补一段就能自动进正文。')
    out.push('')
    for (const item of undocumented) out.push(`- \`${item.name}\` —— \`${item.rel}\``)
    out.push('')
  }
  return `${out.join('\n').trimEnd()}\n`
}

const content = render(collect())

if (CHECK) {
  if (!existsSync(DOC_PATH)) {
    console.error('FAIL docs/API.md 不存在，先跑 node tools/gen-api.mjs')
    process.exit(1)
  }
  const current = readFileSync(DOC_PATH, 'utf8')
  // Windows 上 git 可能把文件 checkout 成 CRLF，跟生成器的 LF 逐字节不等。
  // 比对前统一换行符，否则 CI 会被换行符打败（已踩过一次）。
  const norm = (s) => String(s).replace(/\r\n/g, '\n')
  if (norm(current) !== norm(content)) {
    const a = norm(current).split('\n')
    const b = norm(content).split('\n')
    let firstDiff = 0
    while (firstDiff < Math.min(a.length, b.length) && a[firstDiff] === b[firstDiff]) firstDiff += 1
    console.error(`FAIL docs/API.md 已过期（第 ${firstDiff + 1} 行起不一致）`)
    console.error(`  现在: ${a[firstDiff] ?? '(文件结束)'}`)
    console.error(`  应为: ${b[firstDiff] ?? '(文件结束)'}`)
    console.error('  跑 node tools/gen-api.mjs 重新生成')
    process.exit(1)
  }
  console.log('PASS API 文档与源码一致')
  process.exit(0)
}

mkdirSync(dirname(DOC_PATH), { recursive: true })
writeFileSync(DOC_PATH, content)
console.log(`已生成 ${relative(ROOT, DOC_PATH)}（${content.split('\n').length} 行）`)
