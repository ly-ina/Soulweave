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
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 与 meow 的七层同名，便于上层逻辑不分叉。 */
export const BUILTIN_LEVELS = Object.freeze(['soul', 'rules', 'user', 'project', 'fact', 'topic', 'lesson'])

/** meow 的 `ENTRY_OVERHEAD` 同口径：每条注入还有「- 」「（id）」等固定开销。 */
const ENTRY_OVERHEAD = 6

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
  updated_at  integer
);
create table if not exists cues (
  id  text primary key,
  cue text default ''
);
create index if not exists idx_memories_level on memories(level, status);
`

export function clipText(text, max) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function charsOf(text) {
  return Array.from(String(text ?? '')).length
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
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(SCHEMA)
  } catch {
    /* 建表失败让读操作自己降级 */
  }
  return db
}

/** 只读打开；库不存在返回 null（不建库）。 */
export function openDb(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return null
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
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

/** 这个文件是不是 meow 的老库（有 soul/user 等七层表、没有 memories）。 */
export function looksLikeMeowDb(dbPath) {
  const db = openDb(dbPath)
  if (!db) return false
  try {
    const tables = tableNames(db)
    if (tables.has('memories')) return false
    return ['soul', 'user', 'fact', 'topic', 'lesson', 'rules', 'project'].some((name) => tables.has(name))
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

/** 写入/更新一条记忆。O4 的「写入并读回」就走它，也给未来的 import 工具留口子。 */
export function putMemory(dbPath, memory = {}) {
  const db = ensureDb(dbPath)
  if (!db) return { ok: false, error: '无法创建 builtin 库' }
  const now = Date.now()
  const row = {
    id: String(memory.id ?? '').trim() || `m-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    title: String(memory.title ?? ''),
    content: String(memory.content ?? ''),
    keywords: Array.isArray(memory.keywords) ? memory.keywords.join(' ') : String(memory.keywords ?? ''),
    importance: Number(memory.importance ?? 1) || 1,
    status: String(memory.status ?? 'active'),
    corrected: memory.corrected === true || Number(memory.corrected) === 1 ? 1 : 0,
    project: String(memory.project ?? ''),
    level: BUILTIN_LEVELS.includes(String(memory.level)) ? String(memory.level) : 'fact',
    created_at: Number(memory.created_at ?? now),
    updated_at: Number(memory.updated_at ?? now),
  }
  try {
    db.prepare(
      `insert into memories (id,title,content,keywords,importance,status,corrected,project,level,created_at,updated_at)
       values (?,?,?,?,?,?,?,?,?,?,?)
       on conflict(id) do update set title=excluded.title, content=excluded.content, keywords=excluded.keywords,
         importance=excluded.importance, status=excluded.status, corrected=excluded.corrected,
         project=excluded.project, level=excluded.level, updated_at=excluded.updated_at`,
    ).run(
      row.id,
      row.title,
      row.content,
      row.keywords,
      row.importance,
      row.status,
      row.corrected,
      row.project,
      row.level,
      row.created_at,
      row.updated_at,
    )
    return { ok: true, id: row.id }
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

/** 常驻口径条数：soul 全量 + user 全量 + rules 里全局 scope 且 importance>=2。 */
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

/** 「手头未结」：level=project 且没标完成（builtin 没有 subcategory，用 project/关键词里的 todo 代替）。 */
export function listPending(dbPath, limit = 3) {
  if (limit <= 0) return []
  return withDb(
    dbPath,
    (db) =>
      db
        .prepare(
          `select content from memories
           where status='active' and level='project'
             and (lower(trim(project))='todo' or lower(keywords) like '%todo%' or lower(title) like '%todo%')
           order by updated_at desc limit ?`,
        )
        .all(limit)
        .map((row) => clipText(String(row.content ?? ''), 40))
        .filter((text) => text !== ''),
    [],
  )
}

/** 「我记得」：rules + lesson 里 importance>=3 的摘头，按重要性倒序、去重、每条 60 字。 */
export function listHeads(dbPath, limit = 3) {
  if (limit <= 0) return []
  return withDb(
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
  if (list.length === 0) return { entries: [], note: '查询为空' }
  return withDb(
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
      return { entries, note: entries.length === 0 ? '记忆里没有这些词' : '' }
    },
    { entries: [], note: 'builtin 记忆库打不开' },
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
