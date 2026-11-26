// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * remember —— 魂织记忆模型唯一写入口（2026-11-24 第一刀）。
 *
 * 设计原则：分类是系统的责任，不是使用者的负担。
 *  - kind 可省略，按内容/上下文保守推断；判错只是标签错，不丢内容。
 *  - 正文 sha 去重（不传 id 时）。
 *  - 同 id 更新留版本（builtin.putMemory 负责）。
 *  - kind=todo 或 input.todo=true 时，额外写 todos 表（生命周期与记忆正文分开）。
 */
import * as builtinMemory from '../memory/builtin.mjs'
import { latestScene, whenFromScene, sceneLabel } from '../memory/scene-link.mjs'
import { putWhen } from '../memory/when.mjs'
import { asInt, asText } from './text.mjs'

/**
 * 显式 when 优先，自动 when 补缺；显式给空串不算覆盖。
 * 2026-11-26：这就是「记忆侧接 scene」的合并规则。
 */
export function mergeWhen(explicit, auto) {
  const out = {}
  for (const source of [auto, explicit]) {
    if (!source || typeof source !== 'object') continue
    for (const key of ['tool', 'pathPattern', 'timeWindow']) {
      const value = source[key]
      if (value == null) continue
      if (Array.isArray(value) ? value.length === 0 : String(value).trim() === '') continue
      out[key] = value
    }
  }
  return Object.keys(out).length === 0 ? null : out
}

const KINDS = new Set(builtinMemory.BUILTIN_LEVELS)

/** 保守推断：显式 kind 最高优先，其次 corrected，最后才是内容线索。 */
export function normalizeKind(raw, { content = '', project = '', corrected = false } = {}) {
  const kind = asText(raw).toLowerCase()
  if (kind === 'todo' || kind === '待办') return 'todo'
  if (KINDS.has(kind)) return kind
  if (corrected) return 'lesson'
  if (project && /todo|待办|未结|还没|要做|下一步/i.test(content)) return 'todo'
  return 'fact'
}

export function remember(config, input = {}) {
  const dbPath = config?.memoryDbPath
  const id = asText(input.id)
  const existing = id ? builtinMemory.getMemory(dbPath, id) : null
  if (id && !existing) return { ok: false, text: `soul_remember: 没有这条记忆 ${id}` }

  const content = String(input.content ?? existing?.content ?? '').trim()
  if (!content) return { ok: false, text: 'soul_remember: content 不能为空（更新时给 id 即可只改状态/关键词）' }

  const project = asText(input.project) || String(existing?.project ?? '')
  const corrected =
    input.corrected !== undefined
      ? input.corrected === true || Number(input.corrected) === 1
      : Number(existing?.corrected ?? 0) === 1
  const kind = asText(input.kind) || String(existing?.level ?? '') || normalizeKind('', { content, project, corrected })
  const level = kind === 'todo' ? 'project' : kind
  const importance =
    input.importance !== undefined
      ? asInt(input.importance, corrected ? 2 : 1, 1, 4)
      : Number(existing?.importance ?? (corrected ? 2 : 1))
  const status = asText(input.status) || String(existing?.status ?? 'active')
  const keywords =
    input.keywords !== undefined
      ? input.keywords
      : String(existing?.keywords ?? '')
          .split(/\s+/)
          .filter(Boolean)

  // 2026-11-26 记忆侧接 scene：写入时顺手看一眼「刚才在干什么」。
  // 显式 when 优先，scene 只补缺；传了 source.session 就只看那个会话的 scene。
  const scene = input.scene && typeof input.scene === 'object'
    ? input.scene
    : latestScene(dbPath, { sid: asText(input.source?.session) })
  const when = mergeWhen(input.when, whenFromScene(scene))
  const sceneId = asText(input.scene_id) || String(scene?.id ?? existing?.scene_id ?? '')

  const written = builtinMemory.putMemory(dbPath, {
    id: id || undefined,
    content,
    title: input.title !== undefined ? asText(input.title) : String(existing?.title ?? ''),
    keywords,
    importance,
    corrected,
    project,
    level,
    status,
    goal: input.goal !== undefined ? asText(input.goal) : String(existing?.goal ?? ''),
    source: input.source,
    why: asText(input.why) || 'remember',
    scene_id: sceneId,
  })
  if (!written.ok) return { ok: false, text: `soul_remember 写入失败：${written.error ?? '未知错误'}` }

  // when 是旁路索引：签不上不影响正文写入（fail-open），但在回执里说清楚。
  let whenNote = ''
  if (when) {
    // when_index 的 level 口径是「哪张表」：soul_remember 的行都在 memories 表，
    // 所以写 'memories' 而不是 kind（fact/lesson…），否则情境检索按表查会取不到。
    const signed = putWhen(dbPath, 'memories', written.id, when)
    whenNote = signed?.ok
      ? `when=${JSON.stringify(when)}`
      : `when 未签上：${signed?.error ?? '未知'}`
  }

  let todo = null
  if (kind === 'todo' || input.todo === true) {
    todo = builtinMemory.putTodo(dbPath, {
      project,
      content,
      due: asText(input.due),
      status: 'pending',
    })
  }

  const tag = written.dedup ? '已存在（去重，未新增）' : written.updated ? '已更新' : '已写入'
  const bits = [`【soul_remember】${tag}`, `${kind}#${written.id}`, `v${written.version}`, `importance=${importance}`]
  if (status !== 'active') bits.push(`status=${status}`)
  if (project) bits.push(`project=${project}`)
  if (todo?.ok) bits.push(`todo#${todo.id}`)
  if (!todo?.ok && (kind === 'todo' || input.todo === true)) bits.push(`todo 写入失败：${todo?.error ?? '未知'}`)
  if (whenNote) bits.push(whenNote)
  if (sceneId) bits.push(`scene=${sceneLabel(scene) || sceneId}`)
  return {
    ok: true,
    id: written.id,
    dedup: Boolean(written.dedup),
    version: written.version,
    kind,
    level,
    status,
    project,
    importance,
    sceneId,
    when,
    todo: todo?.ok ? { id: todo.id, status: todo.status } : null,
    text: bits.join(' · '),
  }
}
