/**
 * 分区索引与标签（2026-11-03 待办 A）。
 *
 * 目标：记忆怎么长，魂引都不涨——魂引只渲染一行「【分区】work 12 · intimacy 8 …」，
 * 正文留在 `memory/<zone>.md` 里，靠 `soul_recall({zone, tags})` 现查。
 *
 * 目录约定（默认都从 soulPath 的目录推）：
 *   <soulRoot>/soul.md          人格层（不归这里管）
 *   <soulRoot>/memory/work.md   一区一个文件
 *   <soulRoot>/index.jsonl      一行一区；**绝不允许一条记忆一行**
 *
 * `index.jsonl` 只当「区目录 + 标签集合」用；**条数每次现扫文件算**，
 * 免得手写完索引忘了重建就对不上（O16 盯的就是这个）。
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'

/** 固定区。区名进不了 tags（§1：区本身不重复写进 tags）。 */
export const ZONES = Object.freeze({
  work: '工作',
  intimacy: '亲密',
  relations: '关系',
  rules: '规则',
  misc: '杂项',
})

export const ZONE_IDS = Object.freeze(Object.keys(ZONES))

/** 标签只有两个维度（场景 / 类型），每条最多三个。 */
export const TAG_SCENES = Object.freeze(['工作', '亲密', '群聊', '日常'])
export const TAG_TYPES = Object.freeze(['规则', '事实', '偏好', '教训'])
export const MAX_TAGS = 3

/**
 * 拆不拆子区按**可测判据**（2026-11-03 拍板，废掉原来的「一区 200 条」）：
 *   - 单文件 > 1 MB，或
 *   - `soul_recall({zone:"work"})` 实测 > 500 ms。
 * 条数不是判据：221 KB / 330 条远没到；拆了反而让索引从一行变四行，违背「一区一行」。
 */
export const ZONE_SPLIT_MAX_BYTES = 1024 * 1024
export const ZONE_SPLIT_MAX_MS = 500

/** 各区文件大小（巡检/迁移用；超阈值才谈拆区）。 */
export function zoneSizes(memoryRoot) {
  const out = {}
  if (!memoryRoot || !existsSync(memoryRoot)) return out
  let files = []
  try {
    files = readdirSync(memoryRoot).filter((name) => name.toLowerCase().endsWith('.md'))
  } catch {
    return out
  }
  for (const name of files) {
    const zone = basename(name, '.md').toLowerCase()
    if (!ZONE_IDS.includes(zone)) continue
    try {
      out[zone] = statSync(join(memoryRoot, name)).size
    } catch {
      /* 单个文件读不到就跳过 */
    }
  }
  return out
}

function textOf(value) {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/** 把 `tags: 工作, 工具` 拆成数组；分区名与非法标签一律丢掉，最多 3 个。 */
export function parseTags(line) {
  const raw = textOf(line)
    .replace(/^\s*tags\s*[:：]\s*/i, '')
    .split(/[,，、;；|]/)
    .map((item) => item.trim())
    .filter(Boolean)
  const allowed = new Set([...TAG_SCENES, ...TAG_TYPES])
  const out = []
  for (const tag of raw) {
    if (!allowed.has(tag)) continue
    if (ZONE_IDS.includes(tag)) continue
    if (!out.includes(tag)) out.push(tag)
    if (out.length >= MAX_TAGS) break
  }
  return out
}

/**
 * 解析一个区文件：`## 标题` → 紧跟一行 `tags:` → 正文（到下一个 `## ` 为止）。
 * 没写 tags 的条目照样收，`tags` 为空数组（不猜）。
 */
export function parseZoneFile(text) {
  const entries = []
  let current = null
  let seenBody = false
  for (const line of textOf(text).split(/\r?\n/)) {
    const head = /^##\s+(.+?)\s*$/.exec(line)
    if (head) {
      if (current) entries.push(current)
      current = { title: head[1].trim(), tags: [], body: [] }
      seenBody = false
      continue
    }
    if (!current) continue
    // tags 行允许跟在空行后面（`## 标题` 后隔一行写 tags 是迁移脚本的格式）
    if (!seenBody && /^\s*tags\s*[:：]/i.test(line)) {
      current.tags = parseTags(line)
      continue
    }
    if (line.trim() !== '') seenBody = true
    current.body.push(line)
  }
  if (current) entries.push(current)
  return entries
    .map((entry) => ({ title: entry.title, tags: entry.tags, body: entry.body.join('\n').trim() }))
    .filter((entry) => entry.title !== '')
}

/** 扫 memoryRoot 下所有区文件，返回 `{ zone → [{title,tags,body}] }`。 */
export function scanZones(memoryRoot) {
  const out = {}
  for (const id of ZONE_IDS) out[id] = []
  if (!memoryRoot || !existsSync(memoryRoot)) return out
  let files = []
  try {
    files = readdirSync(memoryRoot).filter((name) => name.toLowerCase().endsWith('.md'))
  } catch {
    return out
  }
  for (const name of files) {
    const zone = basename(name, '.md').toLowerCase()
    if (!ZONE_IDS.includes(zone)) continue
    try {
      out[zone] = parseZoneFile(readFileSync(join(memoryRoot, name), 'utf8'))
    } catch {
      /* 单个文件坏了不拖累别的区 */
    }
  }
  return out
}

/** 读区索引：一行一区；坏行跳过。返回 `[]` 表示没有索引。 */
export function readZoneIndex(indexPath) {
  if (!indexPath || !existsSync(indexPath)) return []
  const zones = []
  for (const line of textOf(readFileSync(indexPath, 'utf8')).split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw || raw.startsWith('#')) continue
    let row
    try {
      row = JSON.parse(raw)
    } catch {
      continue
    }
    const zone = textOf(row.zone).toLowerCase()
    if (!ZONE_IDS.includes(zone)) continue
    zones.push({
      zone,
      title: textOf(row.title) || ZONES[zone],
      file: textOf(row.file) || `memory/${zone}.md`,
      count: Number(row.count) || 0,
      tags: Array.isArray(row.tags) ? row.tags.map(textOf).filter(Boolean) : [],
      updated: textOf(row.updated),
    })
  }
  return zones
}

/** 把「区 → 条目」折成索引行（一行一区，条数现算，标签取并集）。 */
export function buildZoneIndex(zoneMap, { updated = new Date().toISOString().slice(0, 10), order = ZONE_IDS } = {}) {
  const rows = []
  for (const zone of order) {
    const entries = Array.isArray(zoneMap?.[zone]) ? zoneMap[zone] : []
    const tags = []
    for (const entry of entries) {
      for (const tag of entry.tags ?? []) if (!tags.includes(tag)) tags.push(tag)
    }
    if (entries.length === 0 && !ZONE_IDS.includes(zone)) continue
    rows.push({ zone, title: ZONES[zone] ?? zone, file: `memory/${zone}.md`, count: entries.length, tags, updated })
  }
  return rows
}

export function writeZoneIndex(indexPath, rows) {
  mkdirSync(join(indexPath, '..'), { recursive: true })
  const body = rows.map((row) => JSON.stringify(row)).join('\n')
  writeFileSync(indexPath, `${body}${body ? '\n' : ''}`, 'utf8')
}

/**
 * 魂引里的那一行（+ 指路）。`zones` 传索引行或 `{zone,count}` 都可以；
 * 空数组返回空串（没建分区就一个字也不多）。
 * 只渲染计数与命令示例——**任何区正文都不许出现在这里**（O14）。
 */
export function renderZoneLine(zones) {
  const rows = (Array.isArray(zones) ? zones : []).filter((row) => Number(row?.count) >= 0)
  if (rows.length === 0) return ''
  const parts = rows.map((row) => `${row.zone} ${Number(row.count) || 0}`)
  return `【分区】${parts.join(' · ')}\n        → soul_recall(zone:"${rows[0].zone}", tag:"${rows[0].tags?.[0] ?? '工作'}")`
}

/** 一条命中：定位用 `zone/标题`，标签跟着一起回，方便下一轮直接缩范围。 */
export function flattenZoneEntries(zoneMap) {
  const out = []
  for (const zone of ZONE_IDS) {
    for (const entry of zoneMap?.[zone] ?? []) {
      out.push({ zone, title: entry.title, tags: entry.tags ?? [], body: entry.body ?? '' })
    }
  }
  return out
}

function snippetAround(text, words, size = 90) {
  const value = textOf(text).replace(/\s+/g, ' ').trim()
  const lower = value.toLowerCase()
  const first = words
    .map((word) => lower.indexOf(word))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]
  if (first === undefined) return value.length > size ? `${value.slice(0, size)}…` : value
  const start = Math.max(0, first - 20)
  const chunk = value.slice(start, start + size)
  return chunk.length < value.length ? `${chunk}…` : chunk
}

/**
 * 先按 zone / tags 过滤，再走打分（命中词数 + 标题命中 + 标签命中）。
 * `tags` 是 AND：每个标签都得有。
 */
export function searchZones(zoneMap, { query = '', zone = '', tags = [], limit = 5 } = {}) {
  const words = textOf(query).toLowerCase().split(/\s+/).filter(Boolean)
  const wanted = (Array.isArray(tags) ? tags : [tags]).map((tag) => textOf(tag).trim()).filter(Boolean)
  const zoneFilter = textOf(zone).trim().toLowerCase()
  if (zoneFilter && !ZONE_IDS.includes(zoneFilter)) {
    return { entries: [], note: `未知分区：${zoneFilter}（可选：${ZONE_IDS.join('/')}）` }
  }
  const scored = []
  for (const entry of flattenZoneEntries(zoneMap)) {
    if (zoneFilter && entry.zone !== zoneFilter) continue
    if (wanted.length > 0 && !wanted.every((tag) => entry.tags.includes(tag))) continue
    const blob = `${entry.title} ${entry.body} ${entry.tags.join(' ')}`.toLowerCase()
    const matched = words.filter((word) => blob.includes(word)).length
    if (words.length > 0 && matched === 0) continue
    const titleHit = words.filter((word) => entry.title.toLowerCase().includes(word)).length
    scored.push({
      zone: entry.zone,
      title: entry.title,
      tags: entry.tags,
      snippet: snippetAround(entry.body || entry.title, words.length > 0 ? words : []),
      score: matched * 10 + titleHit * 6 + wanted.length * 2,
    })
  }
  scored.sort((a, b) => b.score - a.score)
  const entries = scored.slice(0, limit)
  return {
    entries,
    note: entries.length === 0 ? (words.length > 0 ? '这个区/标签下没有这些词' : '该区还没有条目') : '',
  }
}
