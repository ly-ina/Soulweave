#!/usr/bin/env node
/**
 * soul_lint —— 只读查「三处数据双写」（v0.1.2 P0）。
 *
 * 三处分别是：`soul.md`（人格）、`memory/<zone>.md`（分区经验）、meow 的 `memory.db`（原子条目）。
 * 规则只有一条：**同一条内容不许两处都写**。这个脚本不改任何文件、不改任何库，
 * 只把「标题 + 正文」算成字符 bigram 集合做 Jaccard，≥ 阈值（默认 0.8）的列成候选对，
 * 由人来决定谁留谁迁。
 *
 * 复跑：`node soul_lint.mjs`
 *   - 不传参数时先找本机 profile（`$DSH_HOME/profiles/<名字>/cordis.patch.yml` 里的
 *     `- id: soulweave` 块）拿真实 soulPath / memoryRoot / memoryDbPath；
 *     找不到 profile 才回落到插件目录的默认路径。
 *   - 也可显式：`--soul-path` / `--memory-root` / `--db` / `--threshold` / `--json` / `--limit`。
 *
 * 判据为什么是 bigram：中文没有空格，按词切要词典，按字切又太松；bigram 是这两头最省事的平衡点，
 * 且与 meow-memory 的检索口径同源。阈值 0.8 只抓「几乎逐字重复」，改写过的近义条目抓不到——
 * 这是刻意的：宁可漏报，不要拿一堆「像但不同」的条目让人一条条看。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { scanZones } from './zones.mjs'

export const DEFAULT_THRESHOLD = 0.8
/**
 * 少于这么多 bigram（约 13 个汉字）的条目不参与比对：
 * 短条目（「部署」「记忆库」这种两三个词）撞 bigram 的概率太高，报了也只是噪音。
 */
export const MIN_BIGRAMS = 12

/** 参与比对的库表。dream_log / summary / cue 那些不是「一条知识点」，不扫。 */
export const LINT_LEVELS = Object.freeze(['fact', 'lesson', 'topic', 'rules', 'project', 'user', 'soul'])

const PUNCT = /[\s\p{P}\p{S}]+/gu

export function normalizeForLint(text) {
  return String(text ?? '').toLowerCase().replace(PUNCT, '')
}

/** 标题 + 正文 → 字符 bigram 集合。标点、空白、Markdown 符号先去掉，免得改写格式就判成不同。 */
export function bigramsOf(title, body) {
  const text = normalizeForLint(`${title ?? ''}\n${body ?? ''}`)
  const set = new Set()
  if (text.length === 1) {
    set.add(text)
    return set
  }
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2))
  return set
}

export function jaccardOf(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 0
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA]
  let intersection = 0
  for (const token of small) if (large.has(token)) intersection += 1
  return intersection / (setA.size + setB.size - intersection)
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 读 `memory/<zone>.md`：一条条给 `{source:'zone', where:'memory/work.md#标题'}`。 */
export function readZoneEntries(memoryRoot) {
  if (!memoryRoot || !existsSync(memoryRoot)) return []
  const entries = []
  const zones = scanZones(memoryRoot)
  for (const [zone, list] of Object.entries(zones)) {
    for (const item of list) {
      const title = textOf(item?.title)
      if (title === '') continue
      entries.push({
        source: 'zone',
        level: zone,
        where: `memory/${zone}.md#${title}`,
        title,
        body: textOf(item?.body),
      })
    }
  }
  return entries
}

/** 读 `memory.db`：只取 active 条目；库不存在/打不开/表结构不对都跳过，不抛错。 */
export function readDbEntries(memoryDbPath) {
  if (!memoryDbPath || !existsSync(memoryDbPath)) {
    return { entries: [], note: `memory.db 不存在，已跳过：${memoryDbPath ?? '(未配置)'}` }
  }
  let db
  try {
    db = new DatabaseSync(memoryDbPath, { readOnly: true })
  } catch (error) {
    return { entries: [], note: `memory.db 打不开，已跳过：${error?.message ?? error}` }
  }
  const entries = []
  const skipped = []
  try {
    try {
      db.exec('PRAGMA busy_timeout = 4000')
    } catch {
      /* 旧版 sqlite 不支持就算了，读失败会落到下面的 catch */
    }
    for (const level of LINT_LEVELS) {
      let rows
      try {
        const columns = db.prepare(`PRAGMA table_info(${level})`).all().map((column) => column.name)
        if (!columns.includes('content')) continue
        const where = columns.includes('status') ? " WHERE status = 'active'" : ''
        rows = db.prepare(`SELECT id, title, content FROM ${level}${where}`).all()
      } catch {
        skipped.push(level)
        continue
      }
      for (const row of rows) {
        const title = textOf(row?.title)
        const body = textOf(row?.content)
        if (title === '' && body === '') continue
        entries.push({
          source: 'db',
          level,
          where: `db:${level}:${row?.id ?? '?'}`,
          title,
          body,
        })
      }
    }
  } finally {
    try {
      db.close()
    } catch {
      /* 关不上不影响结果 */
    }
  }
  const note = skipped.length > 0 ? `这些表读不了，已跳过：${skipped.join('/')}` : ''
  return { entries, note }
}

/** 把条目算上 tokens（只算一次，O(n²) 比对时直接复用）。 */
export function withTokens(entries) {
  return entries.map((entry) => ({ ...entry, tokens: bigramsOf(entry.title, entry.body) }))
}

/**
 * 找可疑对。先按「大小比 ≥ 阈值」粗筛：Jaccard ≤ min/max，比值不够的直接不可能过线，
 * 省掉大部分集合运算；再算真分数。
 */
export function findDuplicatePairs(entries, { threshold = DEFAULT_THRESHOLD, minBigrams = MIN_BIGRAMS } = {}) {
  const pairs = []
  const candidates = entries.filter((entry) => (entry.tokens?.size ?? 0) >= minBigrams)
  for (let i = 0; i < candidates.length; i += 1) {
    const a = candidates[i]
    for (let j = i + 1; j < candidates.length; j += 1) {
      const b = candidates[j]
      const small = Math.min(a.tokens.size, b.tokens.size)
      const large = Math.max(a.tokens.size, b.tokens.size)
      if (small / large < threshold) continue
      const score = jaccardOf(a.tokens, b.tokens)
      if (score < threshold) continue
      pairs.push({ a, b, score })
    }
  }
  return pairs.sort((x, y) => y.score - x.score)
}

// ---------------------------------------------------------------------------
// 默认路径：本机 profile 的 soulweave 配置，找不到才回落插件目录
// ---------------------------------------------------------------------------

export function soulweaveBlockOf(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^\s*-\s*id:\s*['"]?soulweave['"]?\s*$/.test(line))
  if (start < 0) return null
  const blockIndent = (lines[start].match(/^\s*/) ?? [''])[0].length
  const out = {}
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = (line.match(/^\s*/) ?? [''])[0].length
    if (indent <= blockIndent) break
    const match = /^([A-Za-z][\w]*):\s*(.*?)\s*$/.exec(trimmed)
    if (match) out[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

/**
 * 在本机 profile 里找 soulweave 配置。多个 profile 都有时优先 `prefer`，
 * 否则按名字排序取第一个，并把「用了哪个」交给调用方打印——不许悄悄猜。
 */
export function findProfileConfig({ dshHome, prefer = '' } = {}) {
  const home = dshHome || process.env.DSH_HOME || join(homedir(), '.dsh')
  const profilesDir = join(home, 'profiles')
  if (!existsSync(profilesDir)) return null
  let names = []
  try {
    names = readdirSync(profilesDir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
  } catch {
    return null
  }
  if (prefer && names.includes(prefer)) names = [prefer, ...names.filter((name) => name !== prefer)]
  for (const name of names) {
    const file = join(profilesDir, name, 'cordis.patch.yml')
    if (!existsSync(file)) continue
    let block = null
    try {
      block = soulweaveBlockOf(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    if (block && (block.soulPath || block.memoryDbPath)) return { profile: name, file, config: block }
  }
  return null
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : ''
}

export function resolveTargets(argv = []) {
  const prefer = argValue(argv, '--profile')
  const profile = findProfileConfig({ prefer })
  const fromProfile = profile?.config ?? {}
  const soulPath = resolve(
    argValue(argv, '--soul-path')
    || fromProfile.soulPath
    || join(dirname(fileURLToPath(import.meta.url)), 'soul.md'),
  )
  const memoryRoot = resolve(
    argValue(argv, '--memory-root') || fromProfile.memoryRoot || join(dirname(soulPath), 'memory'),
  )
  const memoryDbPath = argValue(argv, '--db') || fromProfile.memoryDbPath || ''
  const threshold = Number(argValue(argv, '--threshold') || DEFAULT_THRESHOLD)
  const limit = Number(argValue(argv, '--limit') || 30)
  return {
    soulPath,
    memoryRoot,
    memoryDbPath: memoryDbPath === '' ? '' : resolve(memoryDbPath),
    threshold: Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : DEFAULT_THRESHOLD,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 30,
    profile: profile?.profile ?? '',
    profileFile: profile?.file ?? '',
  }
}

export function lint({ memoryRoot, memoryDbPath, threshold = DEFAULT_THRESHOLD } = {}) {
  const zoneEntries = readZoneEntries(memoryRoot)
  const dbRead = readDbEntries(memoryDbPath)
  const entries = withTokens([...zoneEntries, ...dbRead.entries])
  const pairs = findDuplicatePairs(entries, { threshold })
  return {
    entries,
    pairs,
    note: dbRead.note,
    zoneCount: zoneEntries.length,
    dbCount: dbRead.entries.length,
  }
}

function shortTitle(title, size = 34) {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= size ? text : `${text.slice(0, size)}…`
}

/** 库里不少条目的 title 是空的，光看 «» 认不出是哪条——退回正文开头。 */
function labelOf(entry, size = 34) {
  const title = shortTitle(entry?.title, size)
  if (title !== '') return title
  return shortTitle(entry?.body, size)
}

function render(report, targets) {
  const lines = []
  lines.push('soul_lint · 只读（不改文件、不改库）')
  if (targets.profile) lines.push(`配置来源：profile ${targets.profile}（${targets.profileFile}）`)
  else lines.push('配置来源：插件目录默认值（没找到带 soulweave 的 profile）')
  lines.push(`soul.md：${targets.soulPath}${existsSync(targets.soulPath) ? '' : '（不存在，本工具不读它）'}`)
  lines.push(`memory/：${targets.memoryRoot}`)
  lines.push(`memory.db：${targets.memoryDbPath || '(未配置)'}`)
  if (report.note) lines.push(`注意：${report.note}`)
  lines.push(
    `条目：memory/ ${report.zoneCount} 条 · memory.db ${report.dbCount} 条（active）· 合计 ${report.entries.length} 条`,
  )
  const cross = report.pairs.filter((pair) => pair.a.source !== pair.b.source).length
  lines.push(
    `阈值 ${targets.threshold} · 最短 ${MIN_BIGRAMS} 个 bigram · 可疑对 ${report.pairs.length} 对（跨库 ${cross} / 同库 ${report.pairs.length - cross}）`,
  )
  if (report.pairs.length === 0) {
    lines.push('没有超过阈值的可疑对。')
    return lines.join('\n')
  }
  lines.push('')
  const shown = report.pairs.slice(0, targets.limit)
  shown.forEach((pair, index) => {
    const kind = pair.a.source !== pair.b.source ? '跨库（疑似双写）' : '同库（疑似重复）'
    lines.push(`${String(index + 1).padStart(2)}. [${pair.score.toFixed(3)}] ${kind}`)
    lines.push(`    A ${pair.a.where}  «${labelOf(pair.a)}»`)
    lines.push(`    B ${pair.b.where}  «${labelOf(pair.b)}»`)
  })
  if (report.pairs.length > shown.length) {
    lines.push(`… 还有 ${report.pairs.length - shown.length} 对未列出（--limit 调大）`)
  }
  lines.push('')
  lines.push(`总数：条目 ${report.entries.length} · 可疑对 ${report.pairs.length}（跨库 ${cross}）`)
  return lines.join('\n')
}

function main() {
  const argv = process.argv.slice(2)
  const targets = resolveTargets(argv)
  const report = lint(targets)
  if (argv.includes('--json')) {
    const payload = {
      profile: targets.profile,
      soulPath: targets.soulPath,
      memoryRoot: targets.memoryRoot,
      memoryDbPath: targets.memoryDbPath,
      threshold: targets.threshold,
      minBigrams: MIN_BIGRAMS,
      entries: { zone: report.zoneCount, db: report.dbCount, total: report.entries.length },
      note: report.note,
      pairs: report.pairs.map((pair) => ({
        score: Number(pair.score.toFixed(4)),
        crossStore: pair.a.source !== pair.b.source,
        a: { where: pair.a.where, title: pair.a.title },
        b: { where: pair.b.where, title: pair.b.title },
      })),
    }
    console.log(JSON.stringify(payload, null, 2))
    return
  }
  console.log(render(report, targets))
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`soul_lint 失败：${error?.stack ?? error}`)
    process.exit(1)
  }
}
