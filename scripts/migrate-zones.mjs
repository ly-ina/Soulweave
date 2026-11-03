#!/usr/bin/env node
/**
 * 分区迁移（2026-11-03 待办 A）：把 meow 记忆库按 project/level 映射进 `memory/<zone>.md`。
 *
 * 用法：
 *   node scripts/migrate-zones.mjs --db <memory.db> [--root <soul.md 所在目录>] [--dry]
 *
 * 规则（映射不确定的一律进 misc，不猜）：
 *   intimacy  关键词/项目里出现 亲密、身体、偏好、放置、项圈、绑
 *   relations 出现 关系层、relations
 *   rules     level = rules
 *   work      project 以 dsh/plugins/meow/lanxi 开头，或带 工具/流程/部署/代码/插件
 *   misc      其余
 *
 * 只追加：已有 `<!-- id:… -->` 标记的条目不会重复写；手改过的正文不动。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ZONE_SPLIT_MAX_BYTES, buildZoneIndex, scanZones, writeZoneIndex, zoneSizes, ZONE_IDS } from '../zones.mjs'

const LEVELS = ['soul', 'user', 'rules', 'project', 'fact', 'topic', 'lesson']

function argsOf(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out[key] = next
      i += 1
    } else {
      out[key] = true
    }
  }
  return out
}

function pickZone(row) {
  const blob = `${row.project ?? ''} ${row.keywords ?? ''} ${row.title ?? ''}`.toLowerCase()
  if (/亲密|身体|偏好|放置|项圈|绑|intimacy/.test(blob)) return 'intimacy'
  if (/关系层|relations/.test(blob)) return 'relations'
  if (row.level === 'rules') return 'rules'
  if (/^(dsh|plugins|meow|lanxi|全局)/.test(blob) || /工具|流程|部署|代码|插件/.test(blob)) return 'work'
  return 'misc'
}

const SCENE = { work: '工作', intimacy: '亲密', relations: '关系', rules: '工作', misc: '日常' }
const TYPE = { rules: '规则', lesson: '教训', user: '偏好', soul: '偏好' }

function tagsOf(row, zone) {
  const tags = [SCENE[zone]]
  const type = TYPE[row.level] ?? '事实'
  if (type !== tags[0]) tags.push(type)
  return tags.slice(0, 3)
}

function renderEntry(row, zone) {
  const title = String(row.title ?? '').trim() || String(row.content ?? '').replace(/\s+/g, ' ').slice(0, 24) || `条目 ${row.id}`
  const body = String(row.content ?? '').trim()
  return `## ${title}\n\ntags: ${tagsOf(row, zone).join(', ')}\n\n${body}\n\n<!-- id:${row.id} level:${row.level} -->\n`
}

function main() {
  const args = argsOf(process.argv.slice(2))
  const dbPath = args.db ? resolve(String(args.db)) : ''
  if (!dbPath || !existsSync(dbPath)) {
    console.error('migrate-zones: 需要 --db <memory.db>（文件不存在）')
    process.exit(2)
  }
  const soulRoot = args.root ? resolve(String(args.root)) : dirname(dbPath)
  const memoryRoot = join(soulRoot, 'memory')
  const indexPath = join(soulRoot, 'index.jsonl')
  const dry = args.dry === true

  const db = new DatabaseSync(dbPath, { readOnly: true })
  const buckets = Object.fromEntries(ZONE_IDS.map((zone) => [zone, []]))
  let scanned = 0
  for (const level of LEVELS) {
    let rows = []
    try {
      rows = db.prepare(`select * from ${level} where status = 'active'`).all()
    } catch {
      continue
    }
    for (const row of rows) {
      scanned += 1
      const record = { ...row, level }
      buckets[pickZone(record)].push(record)
    }
  }
  db.close()

  const existing = scanZones(memoryRoot)
  const plan = []
  for (const zone of ZONE_IDS) {
    const file = join(memoryRoot, `${zone}.md`)
    const seen = new Set((existing[zone] ?? []).map((entry) => entry.body.match(/<!-- id:(\S+)/)?.[1]).filter(Boolean))
    const fresh = buckets[zone].filter((row) => !seen.has(String(row.id)))
    plan.push({ zone, file, fresh: fresh.length, total: (existing[zone] ?? []).length + fresh.length })
  }

  if (dry) {
    console.log(`扫描 ${scanned} 条；将写入：${plan.map((item) => `${item.zone}+${item.fresh}`).join(' ')}`)
    process.exit(0)
  }

  if (!existsSync(memoryRoot)) mkdirSync(memoryRoot, { recursive: true })
  for (const zone of ZONE_IDS) {
    const file = join(memoryRoot, `${zone}.md`)
    const seen = new Set((existing[zone] ?? []).map((entry) => entry.body.match(/<!-- id:(\S+)/)?.[1]).filter(Boolean))
    const fresh = buckets[zone].filter((row) => !seen.has(String(row.id)))
    if (fresh.length === 0 && existsSync(file)) continue
    const header = existsSync(file) ? readFileSync(file, 'utf8') : `# ${zone}\n\n`
    const body = fresh.map((row) => renderEntry(row, zone)).join('\n')
    writeFileSync(file, `${header}${body}`, 'utf8')
  }

  const zoneMap = scanZones(memoryRoot)
  writeZoneIndex(indexPath, buildZoneIndex(zoneMap))
  // 拆不拆子区按可测判据（1 MB 或 soul_recall(zone) > 500ms），不看条数。
  const sizes = zoneSizes(memoryRoot)
  const over = Object.entries(sizes).filter(([, size]) => size > ZONE_SPLIT_MAX_BYTES)
  console.log(`扫描 ${scanned} 条；写入 ${plan.reduce((sum, item) => sum + item.fresh, 0)} 条；索引 ${indexPath}`)
  console.log(`各区大小：${Object.entries(sizes).map(([zone, size]) => `${zone} ${(size / 1024).toFixed(0)}KB`).join(' · ')}`)
  if (over.length > 0) console.warn(`超过 ${ZONE_SPLIT_MAX_BYTES / 1024 / 1024}MB，按判据该拆子区：${over.map(([zone]) => zone).join(', ')}`)
}

main()
