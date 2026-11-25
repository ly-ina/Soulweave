/**
 * memory/route.mjs —— 触发词记录 → 落库路由。
 *
 * 三种 kind 各走一条路：
 *   recall → putMemory（经验/事实）
 *   todo   → 解析到期时间 → putTodo；**解析不出就降级成记忆**，绝不挂一个错的 due
 *   settle → 解析锚点 → 按锚点 / 文本找未结待办 → 标 done（逻辑删除，不物理删）
 *
 * 设计底线：单条失败不影响其余，全部结果都回给调用方；找不到对账目标就什么都不改。
 *
 * 依赖方向：只 import 同层（builtin / anchor / time），不碰 core、不碰宿主。
 */
import { anchorOf, parseSettle } from './anchor.mjs'
import { listTodos, putMemory, putTodo, setTodoStatus } from './builtin.mjs'
import { parseDue } from './time.mjs'

/** 文本兜底匹配：完全相等优先，其次互相包含。 */
function findByText(pending, value) {
  const v = String(value ?? '').trim()
  if (v === '') return null
  const exact = pending.find((t) => String(t.content ?? '').trim() === v)
  if (exact) return exact
  return (
    pending.find((t) => String(t.content ?? '').includes(v)) ??
    pending.find((t) => v.includes(String(t.content ?? '').trim())) ??
    null
  )
}

/**
 * 把一批提取结果写进记忆库。
 *
 * @param {Array<{kind:string, text:string}>} records extractRecords().records
 * @param {{dbPath:string, now?:Date|number, project?:string, level?:string}} options
 * @returns {{
 *   ok: boolean,
 *   written: { memories: Array, todos: Array, settled: Array },
 *   failed: Array<{kind:string,text:string,reason:string}>,
 *   warnings: Array<{kind:string,text:string,note:string}>
 * }}
 */
export function routeRecords(records, options = {}) {
  const dbPath = String(options.dbPath ?? '').trim()
  const written = { memories: [], todos: [], settled: [] }
  const failed = []
  const warnings = []
  if (dbPath === '') {
    return { ok: false, written, failed: [{ kind: '', text: '', reason: '缺 dbPath' }], warnings }
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now())
  const project = String(options.project ?? '')
  // 默认 'fact'：'project' 是 listPending 的「未结待办」回退口径，recall 落成 project 会凭空多一条未结。
  const level = String(options.level ?? 'fact')
  const tags = project === '' ? {} : { project }

  for (const rec of Array.isArray(records) ? records : []) {
    const kind = String(rec?.kind ?? 'recall')
    const text = String(rec?.text ?? '').trim()
    if (text === '') continue

    try {
      if (kind === 'recall') {
        const saved = putMemory(dbPath, { content: text, level, ...tags })
        if (saved && saved.ok === false) throw new Error(saved.error || '写入失败')
        written.memories.push({ id: saved?.id ?? '', text })
        continue
      }

      if (kind === 'todo') {
        const due = parseDue(text, now)
        if (due === null) {
          // 认不出到期时间：降级成记忆，不进 ⏰ 行
          const saved = putMemory(dbPath, { content: text, level, ...tags })
          warnings.push({ kind: 'todo-no-due', text, note: '解析不出日期，已降级为记忆（不会出现在到期行）' })
          written.memories.push({ id: saved?.id ?? '', text, degraded: true })
          continue
        }
        // 时间已经在 due 里了，正文里再留一遍会渲染成「明天 09:00 明天九点交材料」。
        // matched 是「明天 九点」这种用空格拼起来的片段，原文里未必带空格，所以要逐段摘。
        let stripped = text
        for (const part of String(due.matched ?? '').split(/\s+/).filter(Boolean)) {
          stripped = stripped.replace(part, '')
        }
        stripped = stripped.replace(/\s+/g, ' ').trim()
        const content = stripped === '' ? text : stripped
        // 推断出来的时刻要留痕：只给了日期（默认 09:00）或裸时刻（按最近未来推）都算推断，
        // 现状段会显示「约 18:00」，免得猜的和钉死的混在一起。
        const dueAssumed = due.assumedTime || due.ambiguous ? 1 : 0
        const saved = putTodo(dbPath, { content, due: due.iso, dueAssumed, ...tags })
        if (saved && saved.ok === false) throw new Error(saved.error || '写入失败')
        written.todos.push({
          id: saved?.id ?? '',
          anchor: anchorOf(saved?.id),
          text: content,
          original: text,
          due: due.iso,
          assumedTime: due.assumedTime,
          assumed: dueAssumed === 1,
        })
        if (due.assumedTime) {
          warnings.push({ kind: 'todo-assumed-time', text, note: `只说了日期，按 ${due.iso} 记（默认 ${due.iso.slice(11, 16)}）` })
        }
        if (due.ambiguous) {
          warnings.push({
            kind: 'todo-ambiguous-time',
            text,
            note: `只说了「${due.matched}」没说是早是晚，按最近未来取 ${due.iso}；若不对，写清「上午/晚上」重记`,
          })
        }
        continue
      }

      if (kind === 'settle') {
        const parsed = parseSettle(text)
        if (parsed.kind === 'empty') {
          warnings.push({ kind: 'settle-empty', text, note: '结账正文为空，未改动任何数据' })
          continue
        }
        const pending = listTodos(dbPath, { status: 'pending', limit: 300 })
        let target = null
        let by = ''
        if (parsed.kind === 'anchor') {
          target = pending.find((t) => anchorOf(t.id) === parsed.value) ?? null
          if (target) by = 'anchor'
        }
        if (!target) {
          target = findByText(pending, parsed.value)
          if (target) by = parsed.kind === 'anchor' ? 'anchor→text' : 'text'
        }
        if (!target) {
          warnings.push({ kind: 'settle-not-found', text, note: '没有匹配的未结待办，未改动任何数据' })
          continue
        }
        const result = setTodoStatus(dbPath, target.id, 'done')
        if (result && result.ok === false) throw new Error(result.error || '标记失败')
        written.settled.push({ id: target.id, anchor: anchorOf(target.id), text: target.content, by })
        continue
      }

      warnings.push({ kind: 'unknown-kind', text, note: `不认识的 kind：${kind}` })
    } catch (error) {
      failed.push({ kind, text, reason: String(error?.message ?? error) })
    }
  }

  return { ok: failed.length === 0, written, failed, warnings }
}

/** 一行摘要，给 CLI 和日志用。 */
export function renderRouteResult(result) {
  const { written = {}, failed = [], warnings = [] } = result ?? {}
  const parts = [
    `记忆 ${(written.memories ?? []).length}`,
    `待办 ${(written.todos ?? []).length}`,
    `结账 ${(written.settled ?? []).length}`,
  ]
  const tail = []
  if (warnings.length > 0) tail.push(`警告 ${warnings.length}`)
  if (failed.length > 0) tail.push(`失败 ${failed.length}`)
  return `写入：${parts.join(' · ')}${tail.length > 0 ? `；${tail.join(' · ')}` : ''}`
}
