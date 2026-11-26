// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * curator —— 记忆库体检 + 选择性归档（2026-11-24 从 dsh-memory-curator 并入魂织）。
 *
 * 数据面只认魂织新池的 memories 一张表：
 *  - level 当分类，status 当生命周期（active / stale / archived）。
 *  - 永不 DELETE：归档只把 status 改成 archived。
 *  - apply 前一定 VACUUM INTO 备份并核对行数；核对不过就中止。
 *  - 默认 dry-run，只有显式 mode='apply' 才写库。
 */
import { appendFileSync, existsSync, mkdirSync } from '../io.mjs'
import { openReadonly, openReadWrite } from '../storage/index.mjs'
import { createHash } from '../sha256.mjs'

import { join } from '../io.mjs'

export const JACCARD_THRESHOLD = 0.45
export const HOT_KEYWORD_THRESHOLD = 6
export const PROTECTED_LEVELS = ['soul', 'user', 'rules']
/** 项目保护名单默认空：具体项目名属于使用者配置，不写进产品代码。 */
export const DEFAULT_PROTECTED_PROJECTS = []
export const EMOTION_WORDS = [
  '喜欢', '害怕', '怕', '抱', '亲', '爱', '陪', '哭', '想你', '秘密', '日记', '晚安', '害羞',
]
const DAY_MS = 24 * 60 * 60 * 1000

export function projectTokens(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function parseKeywords(raw) {
  if (Array.isArray(raw)) return raw.map(String)
  const text = String(raw ?? '').trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    /* 不是 JSON，按逗号串回落 */
  }
  return text.split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
}

export function emotionHits(row, words = EMOTION_WORDS) {
  const text = `${row.title ?? ''}\n${row.content ?? ''}`
  return words.filter((w) => text.includes(w))
}

/** 保护名单：返回全部命中原因（为空 = 可归档）。 */
export function protectionReasons(row, { protectedProjects = DEFAULT_PROTECTED_PROJECTS, emotionWords = EMOTION_WORDS } = {}) {
  const reasons = []
  if (PROTECTED_LEVELS.includes(row.level)) reasons.push(`level:${row.level}`)
  const projectHit = projectTokens(row.project).find((p) => protectedProjects.includes(p)); if (projectHit) reasons.push(`project:${projectHit}`)
  const emo = emotionHits(row, emotionWords)
  if (emo.length > 0) reasons.push(`情感词:${emo.slice(0, 3).join('/')}`)
  if (Number(row.importance) >= 4) reasons.push('importance>=4')
  return reasons
}

export function protectionReason(row, options = {}) {
  const reasons = protectionReasons(row, options)
  return reasons.length > 0 ? reasons.join(' · ') : null
}

export function isProtected(row, options = {}) {
  return protectionReason(row, options) !== null
}

export function shingles(text) {
  const clean = String(text ?? '').replace(/\s+/g, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2))
  return set
}

export function docShingles(row) {
  return shingles(`${row.title ?? ''}${row.content ?? ''}`)
}

export function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const item of a) if (b.has(item)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

export function stampForBackup(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

export function dayKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 只读打开。 */
export function openDatabase(dbPath) {
  return openReadonly(dbPath)
}

function tableColumns(db, table) {
  try {
    return db.prepare(`pragma table_info(${table})`).all().map((r) => r.name)
  } catch {
    return []
  }
}

/** 读出 memories 全表（新池只有这一张记忆表）。 */
export function loadRows(db) {
  const cols = tableColumns(db, 'memories')
  if (cols.length === 0) return []
  return db
    .prepare('select * from memories')
    .all()
    .map((r) => ({
      id: String(r.id),
      level: String(r.level ?? 'fact'),
      title: r.title ?? '',
      content: r.content ?? '',
      status: r.status ?? 'active',
      importance: Number(r.importance ?? 0),
      keywords: r.keywords ?? '',
      project: r.project ?? null,
      goal: r.goal ?? null,
      corrected: r.corrected ?? null,
      created_at: r.created_at ?? null,
      updated_at: r.updated_at ?? null,
      sha: r.sha ?? null,
    }))
}

/** 逻辑指纹：memories 按 id 排序取 (id,status,len,sha256(content))。 */
export function logicalFingerprint(db) {
  const cols = tableColumns(db, 'memories')
  if (cols.length === 0) return { fingerprint: sha256(''), count: 0 }
  const rows = db.prepare('select id, status, content from memories order by id').all()
  const parts = [`#memories:${rows.length}`]
  for (const r of rows) {
    const content = r.content ?? ''
    parts.push(`${r.id}\u0000${r.status ?? ''}\u0000${content.length}\u0000${sha256(content)}`)
  }
  return { fingerprint: sha256(parts.join('\n')), count: rows.length }
}

// ────────────────────────────── A. 体检 ──────────────────────────────

export function layerStats(rows) {
  const out = {}
  for (const r of rows) {
    if (!out[r.level]) out[r.level] = { total: 0, active: 0, archived: 0, stale: 0 }
    const bucket = out[r.level]
    bucket.total += 1
    if (r.status === 'active') bucket.active += 1
    else if (r.status === 'archived') bucket.archived += 1
    else if (r.status === 'stale') bucket.stale += 1
  }
  return out
}

function brief(row) {
  return {
    id: row.id,
    level: row.level,
    title: String(row.title ?? '').slice(0, 40),
    importance: Number(row.importance ?? 0),
  }
}

function pickKeep(a, b) {
  if (Number(a.importance) !== Number(b.importance)) return Number(a.importance) > Number(b.importance) ? a : b
  return String(a.content ?? '').length >= String(b.content ?? '').length ? a : b
}

export function nearDuplicatePairs(rows, threshold = JACCARD_THRESHOLD) {
  const docs = rows
    .filter((r) => r.status === 'active' && String(r.content ?? '').trim())
    .map((r) => ({ row: r, set: docShingles(r) }))
  const pairs = []
  for (let i = 0; i < docs.length; i += 1) {
    for (let j = i + 1; j < docs.length; j += 1) {
      const score = jaccard(docs[i].set, docs[j].set)
      if (score >= threshold) {
        pairs.push({
          a: brief(docs[i].row),
          b: brief(docs[j].row),
          score: Number(score.toFixed(2)),
          keep: pickKeep(docs[i].row, docs[j].row).id,
        })
      }
    }
  }
  return pairs.sort((x, y) => y.score - x.score)
}

export function hotKeywords(rows, threshold = HOT_KEYWORD_THRESHOLD) {
  const counts = new Map()
  for (const r of rows) {
    if (r.status !== 'active') continue
    for (const kw of parseKeywords(r.keywords)) counts.set(kw, (counts.get(kw) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1])
    .map(([keyword, count]) => ({ keyword, count }))
}

export function staleCandidates(rows, days = 30, now = Date.now()) {
  return rows.filter((r) => {
    if (r.status !== 'active') return false
    const ts = Number(r.updated_at ?? r.created_at ?? 0)
    if (!ts) return false
    return now - ts > days * DAY_MS
  })
}

export function buildAudit(rows, { staleDays = 30, now = Date.now() } = {}) {
  const duplicates = nearDuplicatePairs(rows)
  const stale = staleCandidates(rows, staleDays, now)
  const active = rows.filter((r) => r.status === 'active')
  return {
    total: rows.length,
    active: active.length,
    layers: layerStats(rows),
    duplicates: duplicates.slice(0, 10),
    duplicateTotal: duplicates.length,
    hotKeywords: hotKeywords(rows).slice(0, 15),
    stale: stale.slice(0, 10).map(brief),
    staleTotal: stale.length,
    chars: active.reduce((n, r) => n + String(r.content ?? '').length, 0),
  }
}

// ────────────────────────────── B. 候选 / 归档 ──────────────────────────────

/**
 * 候选判定（新池简化版）：active、不在保护名单、且
 *  - 超过 staleDays 没更新且 importance <= 1；或
 *  - level=lesson 且 importance=1（低价值资料）。
 * 返回的只是建议；真正归档必须显式给 ids。
 */
export function buildCandidates(rows, { limit = 0, staleDays = 30, now = Date.now(), protectedProjects = DEFAULT_PROTECTED_PROJECTS, emotionWords = EMOTION_WORDS } = {}) {
  const items = []
  for (const r of rows) {
    if (r.status !== 'active') continue
    if (isProtected(r, { protectedProjects, emotionWords })) continue
    const ts = Number(r.updated_at ?? r.created_at ?? 0)
    const old = ts > 0 && now - ts > staleDays * DAY_MS
    const lowValue = Number(r.importance) <= 1
    // importance 在写入时默认 1，单看它会把「没手动升过级的具体教训」全判成废物。
    // 再加一层价值信号：只剩残句（<30 字）或已被 decay 沉底，才可能是候选；
    // 句子短但意思完整的（如「X 不可靠，该走 Y」）不算。
    const text = String(r.content ?? '')
    const thin = text.trim().length < 30
    const decayed = /(^|[\s,[])(decay:)/.test(String(r.keywords ?? ''))
    if (!lowValue || !(thin || decayed)) continue
    if (!old && r.level !== 'lesson') continue
    const reason = decayed
      ? 'importance<=1 且已 decay 沉底'
      : old
        ? `${staleDays} 天未更新、importance<=1 且正文单薄`
        : 'lesson、importance=1 且正文单薄'
    items.push({ ...brief(r), reason })
  }
  const total = items.length
  return { total, items: limit > 0 ? items.slice(0, limit) : items }
}

export function backupDatabase(dbPath, backupDir, { now = new Date() } = {}) {
  mkdirSync(backupDir, { recursive: true })
  const file = join(backupDir, `memory-${stampForBackup(now)}.db`)
  const db = openReadWrite(dbPath)
  try {
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
  const src = openReadonly(dbPath)
  const dst = openReadonly(file)
  let srcRows = 0
  let dstRows = 0
  try {
    srcRows = src.prepare('select count(*) c from memories').get().c
    dstRows = dst.prepare('select count(*) c from memories').get().c
  } finally {
    src.close()
    dst.close()
  }
  if (srcRows !== dstRows) {
    return { ok: false, file, srcRows, dstRows, error: `备份行数不一致：源 ${srcRows} / 备份 ${dstRows}` }
  }
  return { ok: true, file, srcRows, dstRows }
}

export function applyArchive(rows, ids, { dbPath, backupDir, now = new Date(), logger, protectedProjects = DEFAULT_PROTECTED_PROJECTS, emotionWords = EMOTION_WORDS } = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).map((x) => String(x).trim()).filter(Boolean))]
  if (wanted.length === 0) {
    return { ok: false, code: 'no-ids', error: '没有传 ids：apply 必须显式给要归档的条目', applied: [], rejected: [] }
  }
  const index = new Map(rows.map((r) => [r.id, r]))
  const unknown = wanted.filter((id) => !index.has(id))
  if (unknown.length > 0) {
    return { ok: false, code: 'unknown-id', error: `不存在的 id：${unknown.join(', ')}`, unknown, applied: [], rejected: [] }
  }
  const rejected = []
  for (const id of wanted) {
    const row = index.get(id)
    const reason = protectionReason(row, { protectedProjects, emotionWords })
    if (reason !== null) rejected.push({ id, level: row.level, code: 'protected', reason })
  }
  if (rejected.length > 0) {
    return {
      ok: false,
      code: 'protected',
      error: `这些条目在保护名单里，拒绝归档：${rejected.map((r) => r.id).join(', ')}`,
      rejected,
      applied: [],
    }
  }

  const before = wanted.map((id) => {
    const r = index.get(id)
    return { id, status: r.status, contentSha: sha256(r.content ?? ''), contentChars: String(r.content ?? '').length }
  })
  const backup = backupDatabase(dbPath, backupDir, { now })
  if (!backup.ok) return { ok: false, code: 'backup-failed', error: backup.error, backup, applied: [], rejected: [] }

  const db = openReadWrite(dbPath)
  const applied = []
  const written = []
  let inTransaction = false
  try {
    db.exec('BEGIN IMMEDIATE')
    inTransaction = true
    for (const item of before) {
      if (item.status === 'archived') {
        applied.push({ id: item.id, from: 'archived', to: 'archived', skipped: true })
        continue
      }
      db.prepare("update memories set status='archived', updated_at=? where id=?").run(Date.now(), item.id)
      written.push(item)
      applied.push({ id: item.id, from: item.status, to: 'archived' })
    }
    db.exec('COMMIT')
    inTransaction = false
  } catch (error) {
    try {
      if (inTransaction) {
        try {
          db.exec('ROLLBACK')
          inTransaction = false
        } catch {
          /* 走逐条还原 */
        }
      }
      for (const item of written) {
        try {
          db.prepare('update memories set status=? where id=?').run(item.status, item.id)
        } catch {
          /* 单条还原失败不拖挂其它行 */
        }
      }
    } finally {
      /* 下面统一关闭 */
    }
    return { ok: false, code: 'write-failed', error: String(error?.message ?? error), backup, applied: [], rejected: [] }
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }

  // 写完复核：正文一字节没被改写。
  let verified = true
  const check = openReadonly(dbPath)
  try {
    for (const item of before) {
      const row = check.prepare('select content, status from memories where id=?').get(item.id)
      if (!row || sha256(row.content ?? '') !== item.contentSha || row.status !== 'archived') verified = false
    }
  } finally {
    check.close()
  }
  try {
    logger?.(`apply: archived=${applied.filter((a) => !a.skipped).length} backup=${backup.file} verified=${verified}`)
  } catch {
    /* ignore */
  }
  return { ok: true, applied, rejected: [], backup, verified }
}

/** 体检笔记：一天一文件，只追加。 */
export function writeAuditNote(report, { notesDir, dateKey: key = dayKey(), now = new Date() } = {}) {
  if (!notesDir) return null
  mkdirSync(notesDir, { recursive: true })
  const file = join(notesDir, `${key}.md`)
  const lines = []
  if (!existsSync(file)) lines.push(`# 记忆体检 ${key}`, '')
  lines.push(`## ${now.toTimeString().slice(0, 8)}`)
  lines.push('')
  lines.push(`- 总计 ${report.total} · active ${report.active} · 正文 ${report.chars} 字`)
  lines.push(`- 分层：${Object.entries(report.layers).map(([k, v]) => `${k} ${v.active}/${v.total}`).join(' · ')}`)
  lines.push(`- 近重复 ${report.duplicateTotal} 对 · stale ${report.staleTotal} 条`)
  if (report.hotKeywords.length) lines.push(`- 热词：${report.hotKeywords.map((h) => `${h.keyword}(${h.count})`).join(' ')}`)
  lines.push('')
  appendFileSync(file, `${lines.join('\n')}\n`, 'utf8')
  return file
}


