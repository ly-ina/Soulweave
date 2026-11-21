/**
 * 阶段衰退（待办第 4 条）：长期未命中的低重要性条目**沉底，不删**。
 *
 * 两档，只往前走，不回头删：
 *   1. sink  ：importance-1（最低 1），keywords 追加 `decay:沉底@YYYY-MM-DD`
 *   2. stale ：沉底满 relabelDays 且期间没再命中 → status='stale'（原文一字不动）
 *
 * 为什么不是直接删 / 直接 archived：原文是这个库里最贵的东西，错杀一次就没了。
 * 为什么不用 memory_event 当基准：builtin 后端没有记忆事件表；把日期写进 keywords，
 * 两种后端同一套判据，不靠额外状态。
 *
 * 边界：不动 soul / user / rules（常驻层由 soul_tier 管）；不动 pinned / daily；
 * 不动 corrected=1 的 lesson（被纠正过的是交过学费的）；不动 status != active。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DAY = 86_400_000
const SINK_RE = /^decay:沉底@(\d{4}-\d{2}-\d{2})$/

export const DECAY_DEFAULTS = Object.freeze({
  minIdleDays: 45,
  relabelDays: 30,
  maxImportance: 2,
  tables: ['fact', 'lesson', 'topic', 'project'],
  sinkTag: 'decay:沉底',
})

function openDb(dbPath, readOnly) {
  if (!dbPath || !existsSync(dbPath)) return null
  try {
    return new DatabaseSync(dbPath, { readOnly: !!readOnly })
  } catch {
    return null
  }
}

function tableNames(db) {
  return new Set(
    db
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%'")
      .all()
      .map((r) => String(r.name)),
  )
}

/** 'meow'（七层表）| 'builtin'（单表 memories）| 'unknown' */
export function detectKind(db) {
  const names = tableNames(db)
  if (names.has('memories')) return 'builtin'
  if (names.has('fact') && names.has('lesson')) return 'meow'
  return 'unknown'
}

function columnsOf(db, table) {
  return new Set(db.prepare(`pragma table_info("${table}")`).all().map((r) => String(r.name)))
}

export function parseKeywords(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return []
  try {
    const v = JSON.parse(s)
    if (Array.isArray(v)) return v.map((x) => String(x))
  } catch {}
  return s
    .split(/[,，]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function formatKeywords(list) {
  return JSON.stringify(list)
}

function dayStamp(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function parseDayStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''))
  if (!m) return null
  const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`).getTime()
  return Number.isFinite(t) ? t : null
}

function readRows(db, kind, table) {
  if (kind === 'builtin') {
    return db
      .prepare(
        `select id,title,content,keywords,importance,status,'' as lifecycle,corrected,
                0 as hit_count,null as last_accessed_at,created_at
           from memories where level=? and status='active'`,
      )
      .all(table)
  }
  const cols = columnsOf(db, table)
  if (cols.size === 0) return []
  const lifecycle = cols.has('lifecycle') ? 'lifecycle' : "'' as lifecycle"
  const corrected = cols.has('corrected') ? 'corrected' : '0 as corrected'
  const hitCount = cols.has('hit_count') ? 'hit_count' : '0 as hit_count'
  const lastAcc = cols.has('last_accessed_at') ? 'last_accessed_at' : 'null as last_accessed_at'
  return db
    .prepare(
      `select id,title,content,keywords,importance,status,${lifecycle},${corrected},
              ${hitCount},${lastAcc},created_at
         from "${table}" where status='active'`,
    )
    .all()
}

function classify(row, table, opt, now) {
  const lifecycle = String(row.lifecycle ?? '')
  if (lifecycle === 'pinned' || lifecycle === 'daily') return null
  const importance = Number(row.importance ?? 1) || 1
  if (importance > opt.maxImportance) return null
  if (table === 'lesson' && Number(row.corrected ?? 0) === 1) return null

  const createdAt = Number(row.created_at ?? 0) || 0
  const lastHit = Number(row.last_accessed_at ?? 0) || 0
  const base = lastHit || createdAt
  if (!base) return null
  const idleDays = Math.floor((now - base) / DAY)

  const kws = parseKeywords(row.keywords)
  // 只认带前缀+日期的自家标记。裸「沉底」是 dsh-toy 潮的档位名，不能当标记用。
  const sink = kws.find((k) => SINK_RE.test(k))
  if (!sink) {
    if (idleDays < opt.minIdleDays) return null
    return { stage: 'sink', idleDays }
  }
  const m = SINK_RE.exec(sink)
  const markedAt = parseDayStamp(m[1])
  if (!markedAt) return null
  if (lastHit >= markedAt) return null // 沉底后又被用上了，不动
  const markedDays = Math.floor((now - markedAt) / DAY)
  if (markedDays < opt.relabelDays) return null
  return { stage: 'stale', idleDays, markedDays, markedAt }
}

/**
 * 只读预览：给出这一轮可以被沉底 / 转 stale 的名单。
 * @returns {{ok:boolean, kind?:string, scanned?:number, candidates?:Array, note?:string, error?:string}}
 */
export function previewDecay(dbPath, options = {}) {
  const opt = { ...DECAY_DEFAULTS, ...options }
  const now = Number(options.now ?? Date.now())
  const db = openDb(dbPath, true)
  if (!db) return { ok: false, error: '记忆库打不开', dbPath }
  try {
    const kind = detectKind(db)
    if (kind === 'unknown') return { ok: false, error: '认不出库结构（既不是 meow 七层也不是 builtin）', dbPath }
    const wanted = opt.tables.filter((t) => ['fact', 'lesson', 'topic', 'project'].includes(t))
    const candidates = []
    let scanned = 0
    for (const table of wanted) {
      let rows = []
      try {
        rows = readRows(db, kind, table)
      } catch {
        continue
      }
      for (const row of rows) {
        scanned += 1
        const hit = classify(row, table, opt, now)
        if (!hit) continue
        candidates.push({
          table,
          id: String(row.id),
          title: String(row.title ?? '').slice(0, 60),
          importance: Number(row.importance ?? 1) || 1,
          hitCount: Number(row.hit_count ?? 0) || 0,
          idleDays: hit.idleDays,
          stage: hit.stage,
                    markedDays: hit.markedDays ?? null,
        })
      }
    }
    candidates.sort((a, b) => b.idleDays - a.idleDays)
    return {
      ok: true,
      kind,
      dbPath,
      now,
      scanned,
      candidates,
      note:
        candidates.length === 0
          ? '没有够格的条目（都还新、或用得上、或重要性够高）'
          : `可沉底 ${candidates.filter((c) => c.stage === 'sink').length} 条，可转 stale ${candidates.filter((c) => c.stage === 'stale').length} 条`,
    }
  } finally {
    db.close()
  }
}

function countAll(db) {
  const names = [...tableNames(db)].sort()
  const out = {}
  for (const name of names) {
    try {
      out[name] = Number(db.prepare(`select count(*) c from "${name}"`).get().c)
    } catch {
      out[name] = -1
    }
  }
  return out
}

function backupDb(db, dbPath, tag) {
  const dir = join(dirname(dbPath), 'backup')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17)
  const target = join(dir, `${tag}-${stamp}.db`)
  db.exec(`vacuum into '${target.replace(/'/g, "''")}'`)
  return target
}

function logEvent(db, kind, table, id, action, detail) {
  if (kind !== 'meow') return
  try {
    db.prepare(
      'insert into memory_event (at, action, entry_table, entry_id, detail) values (?,?,?,?,?)',
    ).run(Date.now(), action, table, id, detail)
  } catch {}
}

/**
 * 真正动手：先重新预览校验（防并发），再 VACUUM INTO 备份并核对行数，最后事务内改。
 * picks: [{table, id, stage}]
 */
export function applyDecay(dbPath, picks, options = {}) {
  const opt = { ...DECAY_DEFAULTS, ...options }
  const now = Number(options.now ?? Date.now())
  if (!Array.isArray(picks) || picks.length === 0) {
    return { ok: true, changed: [], note: '没有要动的条目' }
  }
  const fresh = previewDecay(dbPath, { ...options, now })
  if (!fresh.ok) return fresh
  const key = (x) => `${x.table}#${x.id}`
  const freshMap = new Map(fresh.candidates.map((c) => [key(c), c]))
  const stale = picks.filter((p) => {
    const c = freshMap.get(key(p))
    return !c || c.stage !== p.stage
  })
  if (stale.length > 0) {
    return { ok: false, error: '有候选已过期，请重新预览再动手', stale: stale.map(key) }
  }

  const db = openDb(dbPath, false)
  if (!db) return { ok: false, error: '记忆库打不开（写）', dbPath }
  let backup = null
  try {
    const kind = fresh.kind
    const before = countAll(db)
    backup = backupDb(db, dbPath, 'decay')
    const bdb = new DatabaseSync(backup, { readOnly: true })
    const after = countAll(bdb)
    bdb.close()
    const drift = Object.keys(before).filter((k) => before[k] !== after[k])
    if (drift.length > 0) {
      return { ok: false, error: '备份行数对不上，已停下', backup, drift }
    }

    const changed = []
    db.exec('begin immediate')
    try {
      for (const p of picks) {
        const c = freshMap.get(key(p))
        if (c.stage === 'sink') {
          const row = db
            .prepare(
              kind === 'builtin'
                ? 'select keywords,importance from memories where id=? and status=?'
                : `select keywords,importance from "${p.table}" where id=? and status='active'`,
            )
            .get(p.id, ...(kind === 'builtin' ? ['active'] : []))
          if (!row) continue
          const kws = parseKeywords(row.keywords).filter((k) => !SINK_RE.test(k))
          kws.push(`${opt.sinkTag}@${dayStamp(now)}`)
          const nextImportance = Math.max(1, (Number(row.importance ?? 1) || 1) - 1)
          if (kind === 'builtin') {
            db.prepare('update memories set keywords=?, importance=?, updated_at=? where id=? and status=?').run(
              formatKeywords(kws),
              nextImportance,
              now,
              p.id,
              'active',
            )
          } else {
            db.prepare(`update "${p.table}" set keywords=?, importance=?, updated_at=? where id=? and status='active'`).run(
              formatKeywords(kws),
              nextImportance,
              now,
              p.id,
            )
          }
          logEvent(db, kind, p.table, p.id, 'decay-sink', `importance=${nextImportance}`)
          changed.push({ ...p, action: 'sink', importance: nextImportance })
        } else if (c.stage === 'stale') {
          if (kind === 'builtin') {
            db.prepare("update memories set status='stale', updated_at=? where id=? and status='active'").run(now, p.id)
          } else {
            db.prepare(`update "${p.table}" set status='stale', updated_at=? where id=? and status='active'`).run(now, p.id)
          }
          logEvent(db, kind, p.table, p.id, 'decay-stale', `idleDays=${c.idleDays} markedDays=${c.markedDays}`)
          changed.push({ ...p, action: 'stale' })
        }
      }
      db.exec('commit')
    } catch (err) {
      try {
        db.exec('rollback')
      } catch {}
      return { ok: false, error: `写入失败已回滚：${err?.message ?? err}`, backup }
    }
    return { ok: true, backup, changed, note: `改了 ${changed.length} 条，原文一字未动` }
  } finally {
    db.close()
  }
}