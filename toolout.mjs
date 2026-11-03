/**
 * 二期模块 B：工具过程归档（只归档、绝不删除）
 *
 * 目标库是 billion-context 的 index.db（默认 C:UsersLenovo/.local/share/billion-context/sessions/index.db，可用 biliDbPath 覆盖）。
 * 只动两类行：
 *   - `messages`：`role = 'tool'` 或 `kind = 'tool-result'` 的行，正文长度 ≥ minChars，
 *     且 `seq` 早于「最近 N 个 turn」的分界（分界 = 从后往前数第 N 条 user 正文消息的 seq）；
 *   - 不动 `blocks` / `checkpoints` / `refs` 等结构表，不改任何表结构。
 *
 * 做法（顺序固定）：
 *   1. `preview`：只读数，输出「将归档 N 段 / 共 X 字符 / 预计省 Y tok」；
 *   2. `apply`：`VACUUM INTO` 整库备份 → 把每段原文导出到 `archive\toolout\<date>-<seq>.md`
 *      → 在 `content` 插一行指针文本、把 `messages.content_hash` 指过去（原行不删）；
 *   3. 回滚：`restore` 读导出文件，把原文重新写成 content 行并指回去（演练过，见 check.mjs）。
 *
 * 红线：不 DELETE 任何行；每写一次都要有备份路径 + 日志行 + 报告条目（由调用方负责写报告）。
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const TOOLOUT_DIR = 'toolout'
export const MIN_CHARS = 400
export const RECENT_TURNS = 8
export const POINTER_TAG = '[工具输出已归档]'

export function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const char of String(text ?? '')) {
    if (/[\u3000-\u9fff\uff00-\uffef]/.test(char)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk + other * 0.34)
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 从后往前数第 N 条 user 正文消息的 seq；找不到就返回 0（表示不设下界）。 */
export function turnCutoff(db, sessionId, recentTurns = RECENT_TURNS) {
  const rows = db
    .prepare("select seq from messages where session_id = ? and role = 'user' and kind in ('text','message') order by seq desc limit ?")
    .all(sessionId, Math.max(1, Number(recentTurns) || RECENT_TURNS))
  if (rows.length === 0) return 0
  return Number(rows[rows.length - 1].seq)
}

/** 只读盘点：返回待归档段（含原文，供 apply 复用）。 */
export function planToolOutputs(dbPath, { sessionId, recentTurns = RECENT_TURNS, minChars = MIN_CHARS } = {}) {
  if (!dbPath || !existsSync(dbPath)) return { ok: false, error: `库不存在：${dbPath}`, items: [] }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    if (!sessionId) {
      const row = db.prepare('select session_id from messages group by session_id order by count(*) desc limit 1').get()
      if (!row) return { ok: false, error: '库里没有任何消息', items: [] }
      sessionId = String(row.session_id)
    }
    const cutoff = turnCutoff(db, sessionId, recentTurns)
    const rows = db
      .prepare(
        `select m.seq as seq, m.msg_id as msg_id, m.ref as ref, m.role as role, m.kind as kind,
                c.hash as hash, length(c.bytes) as bytes, c.bytes as blob
           from messages m join content c on c.hash = m.content_hash
          where m.session_id = ? and (m.role = 'tool' or m.kind = 'tool-result') and m.seq < ?
          order by m.seq asc`,
      )
      .all(sessionId, cutoff)
    const items = []
    let chars = 0
    let tokens = 0
    for (const row of rows) {
      if (Number(row.bytes) < minChars) continue
      const text = Buffer.from(row.blob).toString('utf8')
      items.push({
        seq: Number(row.seq),
        msgId: String(row.msg_id),
        ref: row.ref === null ? '' : String(row.ref),
        hash: String(row.hash),
        chars: text.length,
        tokens: estimateTokens(text),
        text,
      })
      chars += text.length
      tokens += estimateTokens(text)
    }
    return { ok: true, sessionId, cutoff, minChars, recentTurns, items, chars, tokens }
  } finally {
    db.close()
  }
}

export function renderTooloutPlan(result, limit = 10) {
  if (!result.ok) return `【soul_toolout】失败：${result.error}`
  const head = `【soul_toolout · 预览】会话 ${result.sessionId}：将归档 ${result.items.length} 段 / 共 ${result.chars} 字符 / 预计省 ${result.tokens} tok（下界 seq<${result.cutoff}，短于 ${result.minChars} 字符不动）`
  const lines = [head]
  for (const item of result.items.slice(0, limit)) {
    lines.push(`· seq=${item.seq} ${item.ref || item.msgId} ${item.chars} 字符 ≈${item.tokens} tok`)
  }
  if (result.items.length > limit) lines.push(`……另有 ${result.items.length - limit} 段未显示`)
  return lines.join('\n')
}

export function pointerText(file, lines) {
  return `${POINTER_TAG} ${file} · ${lines} 行（原文仍在库与导出文件里，未删除）`
}

/** apply：备份 → 导出 → 换指针。返回 { backup, files, savedChars, savedTokens }。 */
export function applyToolout(dbPath, archiveRoot, plan, { stamp, log } = {}) {
  if (!plan?.ok) return { ok: false, error: plan?.error ?? '没有可归档的段' }
  if (plan.items.length === 0) return { ok: true, files: [], savedChars: 0, savedTokens: 0, note: '没有满足条件的段' }
  const date = stamp ?? new Date().toISOString().slice(0, 10)
  const backupDir = join(dirname(dbPath), 'backup')
  mkdirSync(backupDir, { recursive: true })
  const backup = join(backupDir, `index-toolout-${date}-${Date.now()}.db`)

  // 1) 备份：VACUUM INTO 是 SQLite 自带的整库一致性快照，不会半截。
  const reader = new DatabaseSync(dbPath, { readOnly: true })
  try {
    reader.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`)
  } finally {
    reader.close()
  }
  if (!existsSync(backup) || !readFileSync(backup).length) return { ok: false, error: `备份失败：${backup}` }

  // 2) 导出原文
  const outDir = join(archiveRoot, TOOLOUT_DIR)
  mkdirSync(outDir, { recursive: true })
  const files = []
  for (const item of plan.items) {
    const name = `${plan.sessionId.replace(/[^\w.-]+/g, '')}-${date}-${item.seq}.md`
    const file = join(outDir, name)
    const body = [
      `# 工具输出归档 seq=${item.seq} ${item.ref || item.msgId}`,
      '',
      `- 会话：${plan.sessionId}`,
      `- 原 content hash：${item.hash}`,
      `- 字符数：${item.chars}`,
      '',
      '```text',
      item.text,
      '```',
      '',
    ].join('\n')
    writeFileSync(file, body, 'utf8')
    files.push({ file, seq: item.seq, lines: body.split(/\r?\n/).length })
  }

  // 3) 换指针（不 DELETE：新 content 行 + 改 messages.content_hash）
  const db = new DatabaseSync(dbPath)
  let savedChars = 0
  let savedTokens = 0
  try {
    db.exec('BEGIN IMMEDIATE')
    for (const [index, item] of plan.items.entries()) {
      const target = files[index]
      const text = pointerText(target.file, target.lines)
      const buffer = Buffer.from(text, 'utf8')
      const hash = sha256(buffer)
      db.prepare('insert or ignore into content (hash, byte_len, refcount, algo, bytes) values (?,?,?,?,?)').run(
        hash,
        buffer.length,
        1,
        'sha256',
        buffer,
      )
      db.prepare('update content set refcount = refcount + 1 where hash = ?').run(hash)
      db.prepare('update messages set content_hash = ? where session_id = ? and seq = ?').run(hash, plan.sessionId, item.seq)
      savedChars += item.chars - text.length
      savedTokens += item.tokens - estimateTokens(text)
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    return { ok: false, error: `写入失败已回滚：${error.message}`, backup }
  } finally {
    db.close()
  }

  if (typeof log === 'function') log(`toolout apply session=${plan.sessionId} segments=${files.length} saved=${savedTokens}tok backup=${backup}`)
  return { ok: true, backup, files, savedChars, savedTokens }
}

/**
 * 回滚演练 / 真回滚：按指针文件把原文塞回去。
 * `pointer` 传档案文件路径；返回新建的 content hash。
 */
export function restoreFromExport(dbPath, exportFile) {
  if (!existsSync(exportFile)) return { ok: false, error: `档案不存在：${exportFile}` }
  const raw = readFileSync(exportFile, 'utf8')
  const head = raw.match(/^# 工具输出归档 seq=(\d+) (\S+)/)
  const fence = raw.indexOf('```text\n')
  const tail = raw.lastIndexOf('\n```')
  if (!head || fence < 0 || tail < 0) return { ok: false, error: '档案格式不认识（缺 seq 头或代码围栏）' }
  const seq = Number(head[1])
  const ref = head[2]
  const original = raw.slice(fence + '```text\n'.length, tail)
  const buffer = Buffer.from(original, 'utf8')
  const hash = sha256(buffer)
  const db = new DatabaseSync(dbPath)
  try {
    db.prepare('insert or ignore into content (hash, byte_len, refcount, algo, bytes) values (?,?,?,?,?)').run(
      hash,
      buffer.length,
      1,
      'sha256',
      buffer,
    )
    const res = db.prepare('update messages set content_hash = ? where seq = ? and (ref = ? or msg_id = ?)').run(hash, seq, ref, ref)
    if (Number(res.changes) === 0) return { ok: false, error: `没有找到 seq=${seq} ${ref} 对应的行` }
    return { ok: true, seq, hash, chars: original.length }
  } finally {
    db.close()
  }
}

export function runToolout(dbPath, archiveRoot, { mode = 'preview', sessionId, recentTurns, minChars, limit = 10, stamp, log, confirm = false } = {}) {
  const plan = planToolOutputs(dbPath, { sessionId, recentTurns, minChars })
  if (!plan.ok) return { ok: false, text: `【soul_toolout】${plan.error}`, stats: null }
  const preview = renderTooloutPlan(plan, limit)
  if (mode !== 'apply') return { ok: true, mode: 'preview', text: preview, stats: { segments: plan.items.length, chars: plan.chars, tokens: plan.tokens } }
  if (confirm !== true) {
    return { ok: false, mode: 'apply', text: `${preview}\n【拒绝】apply 会改代理库，必须显式 confirm: true（工具侧 soul_toolout 同样要求）。`, stats: { segments: plan.items.length } }
  }
  const applied = applyToolout(dbPath, archiveRoot, plan, { stamp, log })
  if (!applied.ok) return { ok: false, text: `${preview}\n写入失败：${applied.error}`, stats: { segments: plan.items.length } }
  return {
    ok: true,
    mode: 'apply',
    backup: applied.backup,
    text: `${preview}\n已归档 ${applied.files.length} 段，省 ${applied.savedChars} 字符 / ${applied.savedTokens} tok；备份 ${applied.backup}`,
    stats: { segments: applied.files.length, chars: plan.chars, tokens: applied.savedTokens },
  }
}

export default { estimateTokens, planToolOutputs, renderTooloutPlan, applyToolout, restoreFromExport, runToolout, turnCutoff }
