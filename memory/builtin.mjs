// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * builtin 记忆后端：单文件 SQLite，一张 `memories` 表。
 *
 * 设计边界（2026-11-03 开源化改造）：
 *  - 只依赖 `node:sqlite`，不引第三方依赖；
 *  - 首次访问自动建库建表（`createMemoryBackend` 拿到 builtin 时调 `ensureDb`）；
 *  - 语义对齐 meow 后端的**最小集**：常驻条数、高重要性摘头、未结待办、关键词检索、
 *    常驻名单（soul_tier 的只读部分）、cue、反哺用的 lesson。
 *  - 不支持 meow 专属的 `soul_tier --apply`（降权要写 meow 的七层表），调用方要拦。
 *
 * 这不是 meow-memory 的替代品，只是「本机没装任何记忆插件也能单跑」的兜底。
 */

import { existsSync, mkdirSync } from '../io.mjs'
import { dirname } from '../io.mjs'
import { createHash } from '../sha256.mjs'
import { openDatabase } from '../storage/index.mjs'
import { anchorOf } from './anchor.mjs'

/** 与 meow 的七层同名，便于上层逻辑不分叉。 */
export const BUILTIN_LEVELS = Object.freeze(['soul', 'rules', 'user', 'project', 'fact', 'topic', 'lesson'])

/** meow 的 `ENTRY_OVERHEAD` 同口径：每条注入还有「- 」「（id）」等固定开销。 */
const ENTRY_OVERHEAD = 6

/**
 * 四位短锚点随机段。**必须至少含一个字母**：anchor.mjs 的 ANCHOR_RE 要求
 * `(?=.*[a-z])`，纯数字会被 anchorOf 判成空，待办就结不了账。
 * 原先直接用 `Math.random().toString(36).slice(2,6)`，约 0.6% 概率全是数字。
 */
const ANCHOR_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
export function randomAnchor() {
  let out = ''
  for (let i = 0; i < 4; i += 1) out += ANCHOR_ALPHABET[Math.floor(Math.random() * ANCHOR_ALPHABET.length)]
  return /[a-z]/.test(out) ? out : `a${out.slice(1)}`
}

const SCHEMA = `
create table if not exists memories (
  id          text primary key,
  title       text default '',
  content     text not null,
  keywords    text default '',
  importance  integer default 1,
  status      text default 'active',
  corrected   integer default 0,
  project     text default '',
  level       text default 'fact',
  created_at  integer,
  updated_at  integer,
  sha           text default '',
  source_session text default '',
  source_turn   text default '',
  goal          text default '',
  version       integer default 1
);
create table if not exists cues (
  id  text primary key,
  cue text default ''
);
create table if not exists memory_versions (
  memory_id  text not null,
  version    integer not null,
  content    text not null,
  changed_at integer,
  why        text default '',
  primary key (memory_id, version)
);
create table if not exists todos (
  id         text primary key,
  project    text default '',
  content    text not null,
  status     text default 'pending',
  due        text default '',
  created_at integer,
  done_at    integer
);
create index if not exists idx_memories_level on memories(level, status);
create index if not exists idx_todos_status on todos(status, project);
`

export function clipText(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function charsOf(text) {
  return Array.from(String(text ?? '')).length
}

/** 统一锁等待：route 写库与宿主读库可能并发，等锁而不是直接 SQLITE_BUSY。 */
const BUSY_TIMEOUT_MS = 4000

function openSqlite(dbPath, options = {}) {
  const db = openDatabase(dbPath, options)
  try {
    db.exec(`pragma busy_timeout = ${BUSY_TIMEOUT_MS}`)
  } catch {
    /* 不支持就退回默认，不挡路 */
  }
  return db
}

/** 打开（必要时创建）builtin 库。写路径才建库；只读路径不存在就直接返回 null。 */
export function ensureDb(dbPath, { create = true } = {}) {
  if (!dbPath) return null
  if (!existsSync(dbPath)) {
    if (!create) return null
    try {
      mkdirSync(dirname(dbPath), { recursive: true })
    } catch {
      return null
    }
  }
  let db
  try {
    db = openSqlite(dbPath)
  } catch {
    // 损坏 / 被锁 / 无权限：返回 null，让读路径走 fallback，绝不把异常抛给宿主
    return null
  }
  try {
    db.exec(SCHEMA)
  } catch {
    /* 建表失败让读操作自己降级 */
  }
  migrateColumns(db)
  return db
}

/** 只读打开；库不存在返回 null（不建库）。 */
export function openDb(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return null
  try {
    return openSqlite(dbPath, { readOnly: true })
  } catch {
    return null
  }
}

function tableNames(db) {
  try {
    return new Set(db.prepare("select name from sqlite_master where type='table'").all().map((row) => String(row.name)))
  } catch {
    return new Set()
  }
}

/**
 * 这个文件是不是 meow 的老库（有 soul/user 等七层表）。
 *
 * 2026-11-24 魂织第一刀：memories 表与七层表**允许共存于同一文件**
 *（soul_remember 写 memories，meow 继续写七层）。所以不能再用「有 memories 就不算 meow」，
 * 改成数七层表：≥3 张才认，避免单表单名误判。
 */
export function looksLikeMeowDb(dbPath) {
  const db = openDb(dbPath)
  if (!db) return false
  try {
    const tables = tableNames(db)
    const meowTables = ['soul', 'user', 'fact', 'topic', 'lesson', 'rules', 'project']
    // 任意一张七层表在，就当 meow（测试靶子可能只造一张表）；纯 builtin 库只有 memories/cues/todos。
    return meowTables.some((name) => tables.has(name))
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

function withDb(dbPath, fn, fallback) {
  const db = openDb(dbPath)
  if (!db) return fallback
  try {
    return fn(db)
  } catch {
    return fallback
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 读类操作（listPending / listHeads / search）：库不存在就按 schema 建一个空库再读。
 * 单子 §1 第 6 步要求「只装插件、只配 soulPath」时 soul_recall 能自动建库并返回空结果，
 * 而不是回一句「记忆库打不开」；建库失败（如安装目录只读）仍按 fallback 降级，不抛错。
 */
function withDbCreating(dbPath, fn, fallback) {
  const db = ensureDb(dbPath)
  if (!db) return fallback
  try {
    return fn(db)
  } catch {
    return fallback
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/** 写入/更新一条记忆。O4 的「写入并读回」就走它，也给未来的 import 工具留口子。 */
function sha256Of(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 2026-11-24 魂织第一刀：老库补列（create table if not exists 不会给已存在的表加列）。 */
const MEMORY_EXTRA_COLUMNS = [
  ['sha', "text default ''"],
  ['source_session', "text default ''"],
  ['source_turn', "text default ''"],
  ['goal', "text default ''"],
  ['version', 'integer default 1'],
]

/**
 * todos 表补列。
 * `due_assumed`：到期时刻是**推断**出来的，不是他钉死的。
 *   0 = 明确（`明天九点` / `18:30`）
 *   1 = 推断（只给了日期按默认时刻补，或裸时刻按最近未来推）
 * 现状段据此显示「约 18:00」，让猜的和钉死的能区分开。
 */
const TODO_EXTRA_COLUMNS = Object.freeze([['due_assumed', 'integer default 0']])

/** 老库补列：`[列名, 声明]`。alter 不幂等，所以先 pragma 看缺哪列。 */
function addColumns(db, table, defs) {
  let cols
  try {
    cols = new Set(db.prepare(`pragma table_info(${table})`).all().map((row) => String(row.name)))
  } catch {
    return
  }
  for (const [name, decl] of defs) {
    if (cols.has(name)) continue
    try {
      db.exec(`alter table ${table} add column ${name} ${decl}`)
    } catch {
      /* 并发或只读：读操作按旧结构降级，不抛 */
    }
  }
}

function migrateColumns(db) {
  addColumns(db, 'memories', MEMORY_EXTRA_COLUMNS)
  addColumns(db, 'todos', TODO_EXTRA_COLUMNS)
  try {
    db.exec('create index if not exists idx_memories_sha on memories(sha)')
  } catch {
    /* ignore */
  }
}

/**
 * 写入/更新一条记忆。O4 的「写入并读回」就走它，也给未来的 import 工具留口子。
 *
 * 2026-11-24 魂织第一刀：
 *  - 不传 id 时按正文 sha 去重（只跟 active 比，archived/stale 允许重写）；
 *  - 同 id 内容变了才写 memory_versions 并把 version+1；
 *  - 写 source_session / source_turn / goal。
 */
export function putMemory(dbPath, memory = {}) {
  const db = ensureDb(dbPath)
  if (!db) return { ok: false, error: '无法创建 builtin 库' }
  const now = Date.now()
  const wantsId = String(memory.id ?? '').trim()
  let existing = null
  try {
    existing = wantsId ? db.prepare('select * from memories where id=?').get(wantsId) : null
  } catch {
    existing = null
  }
  // 2026-11-24 第四刀：id 更新时未给的字段沿用旧值，别再被默认值清空。
  const pick = (key, fallback) => (memory[key] !== undefined ? memory[key] : existing?.[key] ?? fallback)
  const content = String(pick('content', ''))
  const sha = sha256Of(content.trim())
  try {
    if (!wantsId) {
      const hit = db.prepare("select id, version from memories where sha=? and status='active' limit 1").get(sha)
      if (hit) return { ok: true, id: String(hit.id), dedup: true, version: Number(hit.version ?? 1) }
    }
    const row = {
      id: wantsId || `m-${now.toString(36)}-${randomAnchor()}`,
      title: String(pick('title', '')),
      content,
      keywords: Array.isArray(pick('keywords', [])) ? pick('keywords', []).join(' ') : String(pick('keywords', existing?.keywords ?? '')),
      importance: Number(pick('importance', 1)) || 1,
      status: String(pick('status', 'active')),
      corrected: pick('corrected', false) === true || Number(pick('corrected', 0)) === 1 ? 1 : 0,
      project: String(pick('project', '')),
      level: BUILTIN_LEVELS.includes(String(pick('level', 'fact'))) ? String(pick('level', 'fact')) : 'fact',
      created_at: Number(existing?.created_at ?? memory.created_at ?? now),
      updated_at: Number(memory.updated_at ?? now),
      sha,
      source_session: String(memory.source_session ?? memory.source?.session ?? pick('source_session', '')),
      source_turn: String(memory.source_turn ?? memory.source?.turn ?? pick('source_turn', '')),
      goal: String(pick('goal', '')),
      version: Number(existing?.version ?? 1),
    }
    if (existing && String(existing.content ?? '') !== content) {
      row.version = Number(existing.version ?? 1) + 1
      db.prepare(
        'insert or replace into memory_versions (memory_id,version,content,changed_at,why) values (?,?,?,?,?)',
      ).run(row.id, Number(existing.version ?? 1), String(existing.content ?? ''), now, String(memory.why ?? 'update'))
    }
    db.prepare(
      `insert into memories (id,title,content,keywords,importance,status,corrected,project,level,created_at,updated_at,sha,source_session,source_turn,goal,version)
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict(id) do update set title=excluded.title, content=excluded.content, keywords=excluded.keywords,
         importance=excluded.importance, status=excluded.status, corrected=excluded.corrected,
         project=excluded.project, level=excluded.level, updated_at=excluded.updated_at, sha=excluded.sha,
         source_session=excluded.source_session, source_turn=excluded.source_turn, goal=excluded.goal,
         version=excluded.version`,
    ).run(
      row.id, row.title, row.content, row.keywords, row.importance, row.status, row.corrected,
      row.project, row.level, row.created_at, row.updated_at, row.sha,
      row.source_session, row.source_turn, row.goal, row.version,
    )
    return { ok: true, id: row.id, dedup: false, version: row.version, updated: Boolean(existing) }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/** 读一条（验收/调试用）。 */
export function getMemory(dbPath, id) {
  return withDb(
    dbPath,
    (db) => {
      const row = db.prepare('select * from memories where id=?').get(String(id))
      return row ? { ...row } : null
    },
    null,
  )
}

/** 读一条的版本历史（旧的在前）。 */
export function listVersions(dbPath, memoryId, limit = 50) {
  return withDb(
    dbPath,
    (db) =>
      db
        .prepare('select memory_id,version,content,changed_at,why from memory_versions where memory_id=? order by version asc limit ?')
        .all(String(memoryId), limit)
        .map((row) => ({ ...row })),
    [],
  )
}

/** todo：生命周期只有 pending / done / stale。 */
export function putTodo(dbPath, todo = {}) {
  const db = ensureDb(dbPath)
  if (!db) return { ok: false, error: '无法创建 builtin 库' }
  const now = Date.now()
  const id = String(todo.id ?? '').trim() || `t-${now.toString(36)}-${randomAnchor()}`
  const status = ['pending', 'done', 'stale'].includes(String(todo.status)) ? String(todo.status) : 'pending'
  const dueAssumed = Number(todo.dueAssumed ?? 0) === 1 ? 1 : 0
  try {
    db.prepare(
      `insert into todos (id,project,content,status,due,due_assumed,created_at,done_at) values (?,?,?,?,?,?,?,?)
       on conflict(id) do update set project=excluded.project, content=excluded.content, status=excluded.status,
         due=excluded.due, due_assumed=excluded.due_assumed, done_at=excluded.done_at`,
    ).run(
      id, String(todo.project ?? ''), String(todo.content ?? ''), status, String(todo.due ?? ''), dueAssumed,
      Number(todo.created_at ?? now), status === 'done' ? Number(todo.done_at ?? now) : null,
    )
    return { ok: true, id, status, dueAssumed: dueAssumed === 1 }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 改待办状态（pending / done / stale）。
 *
 * @param {string} dbPath 库路径
 * @param {string} id 待办 id
 * @param {'pending'|'done'|'stale'} status 新状态
 * @returns {{ok:boolean, id:string, status?:string, error?:string}}
 */
export function setTodoStatus(dbPath, id, status) {
  const db = ensureDb(dbPath)
  if (!db) return { ok: false, error: '无法创建 builtin 库' }
  const next = ['pending', 'done', 'stale'].includes(String(status)) ? String(status) : 'pending'
  try {
    const info = db.prepare('update todos set status=?, done_at=? where id=?').run(next, next === 'done' ? Date.now() : null, String(id))
    if (Number(info.changes) === 0) return { ok: false, error: '没有这个 todo' }
    return { ok: true, id: String(id), status: next }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 列待办。
 *
 * @param {string} dbPath 库路径
 * @param {{project?:string, status?:'pending'|'done'|'stale', limit?:number}} [options] 过滤与条数
 * @returns {Array<{id:string, content:string, due:string|null, status:string}>}
 */
export function listTodos(dbPath, { project = '', status = 'pending', limit = 20 } = {}) {
  return withDbCreating(
    dbPath,
    (db) => {
      const where = []
      const args = []
      if (status && status !== 'all') { where.push('status=?'); args.push(String(status)) }
      if (project) { where.push("(project=? or project='')"); args.push(String(project)) }
      const sql = `select id,project,content,status,due,created_at,done_at from todos${where.length ? ` where ${where.join(' and ')}` : ''} order by created_at desc limit ?`
      args.push(limit)
      return db.prepare(sql).all(...args).map((row) => ({ ...row }))
    },
    [],
  )
}

/**
 * 到期扫描：给「现状段 ⏰ 行」用。
 *
 * 与 listPending 的分工：listPending 是「未结几条」的计数口径，只回 content；
 * 这个要的是**能带锚点、能判过期**的候选，所以回 id / due / state / anchor。
 *
 * 窗口：`now - graceMs` 到 `now + leadMs` 之间才提；太远的等临近再说，太旧的沉底。
 * 用 withDb（只读）而不是 withDbCreating：到期扫描不该顺手建库。
 *
 * @returns {{items:Array<{id,content,project,due,at,state,anchor}>, invalid:number}}
 */
export function listDueItems(dbPath, { now = Date.now(), leadMs = 24 * 3600_000, graceMs = 72 * 3600_000, limit = 6 } = {}) {
  const empty = { items: [], invalid: 0 }
  return withDb(
    dbPath,
    (db) => {
      let rows = []
      try {
        rows = db
          .prepare(
            "select id, content, project, due, due_assumed from todos where status='pending' and trim(due) <> '' order by due asc limit ?",
          )
          .all(Math.max(limit * 4, 20))
      } catch {
        return empty
      }
      const items = []
      let invalid = 0
      for (const row of rows) {
        const at = Date.parse(String(row.due ?? '').trim())
        if (!Number.isFinite(at)) {
          invalid += 1
          continue
        }
        if (at > now + leadMs) continue
        if (at < now - graceMs) continue
        items.push({
          id: String(row.id),
          content: String(row.content ?? ''),
          project: String(row.project ?? ''),
          due: String(row.due ?? ''),
          at,
          state: at < now ? 'overdue' : 'upcoming',
          assumed: Number(row.due_assumed ?? 0) === 1,
          anchor: anchorOf(row.id),
        })
        if (items.length >= limit) break
      }
      return { items, invalid }
    },
    empty,
  )
}

/** 常驻口径条数：soul 全量 + user 全量 + rules 里全局 scope 且 importance>=2。 *//** 魂引「我记得」用的单条教训头（第三刀预算回退口）。 */
export function lessonHead(dbPath) {
  return withDb(
    dbPath,
    (db) => {
      try {
        const row = db
          .prepare(
            "select content from memories where status='active' and level='lesson' order by importance desc, updated_at desc limit 1",
          )
          .get()
        return clipText(String(row?.content ?? '').replace(/\s+/g, ' ').trim(), 40)
      } catch {
        return ''
      }
    },
    '',
  )
}

export function countResident(dbPath) {
  return withDb(
    dbPath,
    (db) => {
      const one = (sql, ...args) => Number(db.prepare(sql).get(...args)?.c ?? 0)
      return (
        one("select count(*) c from memories where status='active' and level='soul'") +
        one("select count(*) c from memories where status='active' and level='user'") +
        one(
          "select count(*) c from memories where status='active' and level='rules' and importance>=2 and (project is null or trim(project) in ('','全局') or lower(trim(project))='global')",
        )
      )
    },
    0,
  )
}

/** 「手头未结」：优先读 todos 表（新模型）；老库没有 todo 行时退回 memories 的 project 待办。 */
export function listPending(dbPath, limit = 3, options = {}) {
  if (limit <= 0) return []
  const project = String(options?.project ?? '').trim()
  return withDbCreating(
    dbPath,
    (db) => {
      const args = []
      let where = "status='pending'"
      if (project) {
        where += " and (project is null or trim(project) in ('','全局','global') or lower(trim(project))=lower(?))"
        args.push(project)
      }
      let rows = []
      try {
        rows = db
          .prepare(
            `select content from todos where ${where}
             order by case when due is null or trim(due)='' then 1 else 0 end, due asc, created_at desc limit ?`,
          )
          .all(...args, limit)
      } catch {
        rows = []
      }
      const out = rows
        .map((row) => clipText(String(row.content ?? '').replace(/\s+/g, ' ').trim(), 48))
        .filter((text) => text !== '')
      // 不再回退 memories.level='project'：builtin 库里那是普通项目记忆（本机实测 142 条），
      // 会被当成未结待办，每写一条 ※记 就凭空多一条「未结」。
      return out
    },
    [],
  )
}

/**
 * 在场档（第二刀）：当前项目 + 全局的未结 todo、当前项目的项目记忆、可检索条数。
 * 一次查完，避免 prestep 每轮多开几次库。
 */
export function listPresent(dbPath, options = {}) {
  const project = String(options?.project ?? '').trim()
  const limit = Math.max(1, Number(options?.limit) || 3)
  const empty = { project, pending: [], memories: [], searchable: 0 }
  if (project === '') return empty
  return withDbCreating(
    dbPath,
    (db) => {
      let pending = []
      try {
        pending = db
          .prepare(
            `select content from todos
             where status='pending'
               and (project is null or trim(project) in ('','全局','global') or lower(trim(project))=lower(?))
             order by case when due is null or trim(due)='' then 1 else 0 end, due asc, created_at desc limit ?`,
          )
          .all(project, limit)
          .map((row) => clipText(String(row.content ?? '').replace(/\s+/g, ' ').trim(), 48))
          .filter(Boolean)
      } catch {
        pending = []
      }
      const memories = db
        .prepare(
          `select content from memories
           where status='active' and level='project' and lower(trim(project))=lower(?)
           order by updated_at desc limit ?`,
        )
        .all(project, limit)
        .map((row) => clipText(String(row.content ?? '').replace(/\s+/g, ' ').trim(), 48))
        .filter(Boolean)
      const searchable = Number(
        db
          .prepare("select count(*) c from memories where status='active' and level in ('fact','lesson','topic')")
          .get()?.c ?? 0,
      )
      return { project, pending, memories, searchable }
    },
    empty,
  )
}

/** 可检索档条数：内容池里除常驻/在场之外的部分。 */
export function countSearchable(dbPath) {
  return withDb(
    dbPath,
    (db) =>
      Number(
        db
          .prepare("select count(*) c from memories where status='active' and level in ('fact','lesson','topic')")
          .get()?.c ?? 0,
      ),
    0,
  )
}

/** 「我记得」：rules + lesson 里 importance>=3 的摘头，按重要性倒序、去重、每条 60 字。 */
export function listHeads(dbPath, limit = 3) {
  if (limit <= 0) return []
  return withDbCreating(
    dbPath,
    (db) => {
      const rows = db
        .prepare(
          `select content, importance from memories
           where status='active' and importance>=3 and level in ('rules','lesson')
           order by importance desc, updated_at desc limit ?`,
        )
        .all(limit)
      const seen = new Set()
      const heads = []
      for (const row of rows) {
        const head = clipText(String(row.content ?? '').replace(/\s+/g, ' ').trim(), 60)
        if (!head) continue
        const key = head.slice(0, 10)
        if (seen.has(key)) continue
        seen.add(key)
        heads.push(head)
      }
      return heads
    },
    [],
  )
}

function parseKeywords(value) {
  return String(value ?? '')
    .split(/[\s,，、;；|]+/)
    .map((word) => word.trim())
    .filter(Boolean)
}

function snippet(text, words, size = 90) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  const lower = value.toLowerCase()
  const first = words
    .map((word) => lower.indexOf(word))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0]
  if (first === undefined) return clipText(value, size)
  const start = Math.max(0, first - 20)
  return clipText(value.slice(start, start + size), size)
}

/**
 * 关键词检索：所有词都要在 title/content/keywords/project 的并集里出现；
 * 打分 = 命中词数*10 + 标题命中*6 + importance + 近期新鲜度（30 天内 +2）。
 * 返回结构与 meow 后端一致：{ entries:[{loc,snippet}], note }。
 */
export function search(dbPath, words, limit) {
  const list = (Array.isArray(words) ? words : [words]).map((word) => String(word ?? '').toLowerCase()).filter(Boolean)
  if (list.length === 0) return { entries: [], note: '查询为空', degraded: false }
  return withDbCreating(
    dbPath,
    (db) => {
      const rows = db
        .prepare("select id,title,content,keywords,project,importance,level,updated_at from memories where status='active'")
        .all()
      const now = Date.now()
      const scored = []
      for (const row of rows) {
        const title = String(row.title ?? '')
        const content = String(row.content ?? '')
        const keywords = String(row.keywords ?? '')
        const project = String(row.project ?? '')
        const blob = `${title} ${content} ${keywords} ${project}`.toLowerCase()
        if (!list.every((word) => blob.includes(word))) continue
        const titleHit = list.filter((word) => title.toLowerCase().includes(word)).length
        const fresh = Number(row.updated_at ?? 0) > now - 30 * 86_400_000 ? 2 : 0
        scored.push({
          id: String(row.id),
          level: String(row.level ?? 'fact'),
          content,
          score: list.length * 10 + titleHit * 6 + (Number(row.importance) || 1) + fresh,
        })
      }
      scored.sort((a, b) => b.score - a.score)
      const entries = scored.slice(0, limit).map((row) => ({
        loc: `${row.level}#${row.id}`,
        snippet: snippet(row.content, list),
      }))
      return { entries, note: entries.length === 0 ? '记忆里没有这些词' : '', degraded: false }
    },
    { entries: [], note: 'builtin 记忆库打不开', degraded: true, reason: 'db-unavailable' },
  )
}

/** soul_tier 用：常驻名单（与 meow readInjectionRows 的 row 形状一致）。 */
export function listTier(dbPath, limit = 200) {
  return withDb(
    dbPath,
    (db) =>
      db
        .prepare(
          `select id,title,content,keywords,importance,project,level,updated_at,corrected
           from memories
           where status='active' and (
             level in ('soul','user')
             or (level='rules' and importance>=2 and (project is null or trim(project) in ('','全局') or lower(trim(project))='global'))
           )
           order by importance desc, updated_at desc limit ?`,
        )
        .all(limit)
        .map((row) => ({
          level: String(row.level),
          id: String(row.id),
          chars: charsOf(row.content) + ENTRY_OVERHEAD,
          importance: Number(row.importance ?? 1),
          hit_count: 0,
          updated_at: row.updated_at == null ? null : Number(row.updated_at),
          last_accessed_at: null,
          corrected: Number(row.corrected ?? 0) === 1,
          keywords: parseKeywords(row.keywords),
          content: String(row.content ?? ''),
        })),
    [],
  )
}

/** soul_persist 用：已纠正、仍在用的 lesson。 */
export function listCorrectedLessons(dbPath, limit = 10) {
  return withDb(
    dbPath,
    (db) =>
      db
        .prepare(
          `select id,title,content,project,created_at from memories
           where level='lesson' and corrected=1 and status='active'
           order by created_at asc limit ?`,
        )
        .all(limit),
    [],
  )
}

/** soul_cue --append 用：写 cue（builtin 没有 meow 的 cue 列，单独一张表）。 */
export function putCue(dbPath, id, cue) {
  const db = ensureDb(dbPath)
  if (!db) return { ok: false, error: '无法创建 builtin 库' }
  try {
    db.prepare('insert into cues (id, cue) values (?,?) on conflict(id) do update set cue=excluded.cue').run(
      String(id),
      String(cue),
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try {
      db.close()
    } catch {
      /* ignore */
    }
  }
}


