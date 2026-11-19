/**
 * 三期模块 A：遗忘曲线 / 常驻名单审计（**只读 + preview/apply 两段**，不改 meow-memory 源码）
 *
 * 八期（2026-10-28）：**预算与 meow 同源**——默认读 profile `injectBudgetChars`（2200 字），
 * 换算 `round(chars / CHARS_PER_TOKEN)` = 1538 tok；600 tok 只在读不到配置时兜底。
 * 旧口径把 2200**字**当 2200 **tok** 用，同一份库能跑出两个「超线」数（尺子本身是 bug）。
 *
 * 口径依据（实测，2026-10-28）：meow-memory `lib/index.js:2643-2674` 的 `buildInjectionBody`
 *   - `soul` 表：**全部** active 行，无过滤、无截断
 *   - `user` 表：**全部** active 行，无过滤、无截断
 *   - `rules` 表：只取 `isGlobalScope(project) && importance >= 2`（`isGlobalScope` 见 `:1126`：
 *     null / '' / '全局' / 'global' 算全局）
 *   ⇒ 结论（写进回执，别再说反）：**降 `user` 的 importance 对常驻没有任何影响**；
 *     能让常驻变小的只有两条路——降 `rules` 的 importance 到 <2，或改 meow 的注入口径。
 *     本模块只做「看得见 + 可审计」，`enforceBudget` 保持 false，不偷改别人的注入。
 *
 * 降权动作只有两种（交办单 A4）：`importance-1`（最低 1）、`keywords` 追加 `沉底`。
 * 永不删、永不 archived、永不改 content。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'

/** 各表行数快照，用来校验 VACUUM INTO 备份与源库一致。 */
function snapshotCounts(db) {
  const counts = {}
  let tables = []
  try {
    tables = db.prepare("select name from sqlite_master where type='table'").all().map((row) => String(row.name))
  } catch {
    tables = []
  }
  for (const table of tables) {
    if (table.startsWith('sqlite_')) continue
    try {
      counts[table] = db.prepare(`select count(*) c from "${table}"`).get().c
    } catch {
      /* 读不到的表不参与校验 */
    }
  }
  return counts
}

/**
 * 常驻名单的**兜底**预算（三期 A2 的 600 tok）。
 *
 * 八期起它只是兜底：默认预算跟着 meow 的 `injectBudgetChars` 走（见 `resolveTierBudget`）。
 * 保留这个常量是为了「读不到 meow 配置」时仍能给出确定的数，并在输出里标明来源。
 */
export const TIER_BUDGET_TOKENS = 600
/** 中文粗估：1 字 ≈ 0.7 tok ⇒ 1 tok ≈ 1.43 字。与 index.js 的 tokOf 同一口径。 */
export const CHARS_PER_TOKEN = 1.43
/** meow-memory 未配 `injectBudgetChars` 时的 schema 默认（`meow-memory/lib/index.js:4833`）。 */
export const MEOW_DEFAULT_INJECT_BUDGET_CHARS = 1400

/** meow 的口径是**字**：chars → tok 用同一个换算，避免出现第二把尺子。 */
export function budgetTokensOfChars(chars) {
  const value = Number(chars)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.max(100, Math.round(value / CHARS_PER_TOKEN))
}

/**
 * 从一段 profile yml 文本里抠 meow 的注入配置。
 * 只认**键值行**（`injectBudgetChars: 2200` / `injectPinIds: 'a,b'`），不做完整 YAML 解析：
 * patch 文件是我们自己的、格式稳定，解析器越简单越不容易和别的解析器打架。
 * @returns {{chars:number|null, pinIds:string[]}}
 */
export function parseMeowInjectConfig(text) {
  let chars = null
  const pinIds = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue
    const budget = /^\s*injectBudgetChars:\s*(\d+)\s*(?:#.*)?$/.exec(line)
    if (budget) {
      chars = Number(budget[1])
      continue
    }
    const pins = /^\s*injectPinIds:\s*(['"]?)([^'"#\r\n]*)\1/.exec(line)
    if (pins) {
      for (const part of String(pins[2] ?? '').split(',')) {
        const id = part.trim()
        if (id) pinIds.push(id)
      }
    }
  }
  return { chars, pinIds }
}

/**
 * 预算来源解析（八期 T1，优先级照交办单 §2）：
 *   显式传参 → profile 里的 `injectBudgetChars` → meow schema 默认 1400 → 兜底 600。
 * 同一份 profile 里后面的条目覆盖前面的，所以文件内按「最后一次命中」取值；
 * 多 profile 时取**排序第一个**有显式配置的文件（本机只有 desktop 一个，够用）。
 * @returns {{tokens:number, chars:number, source:string, sourcePath:string, note:string}}
 */
export function resolveTierBudget({ dshHome = '', configPaths = [], budgetTokens = null } = {}) {
  const paths = (Array.isArray(configPaths) ? configPaths : []).filter((item) => item && existsSync(item)).sort()
  let referenced = ''
  let found = null
  for (const path of paths) {
    let text = ''
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    if (!/meow-memory/.test(text)) continue
    referenced = referenced || path
    const parsed = parseMeowInjectConfig(text)
    // 文件内「最后一次命中」= 后写的覆盖先写的；多个 profile 时用排序第一个有显式配置的。
    // 八期 T4：`injectBudgetChars: 0` 是**合法值**（= 关闭预算 = 全量注入），不能被 `>0` 过滤掉。
    if (!found && parsed.chars !== null) found = { chars: parsed.chars, path, pinIds: parsed.pinIds }
  }
  const pinIds = found?.pinIds ?? []
  if (Number.isFinite(Number(budgetTokens)) && budgetTokens !== null) {
    const tokens = Number(budgetTokens)
    if (tokens === 0) {
      // T4：显式 0 也当「关闭预算」，不许被 asInt 的下限夹成 100。
      return { tokens: 0, chars: 0, source: 'off', sourcePath: found?.path ?? '', pinIds, note: '预算关闭（0 = 不限）' }
    }
    return {
      tokens,
      chars: Math.round(tokens * CHARS_PER_TOKEN),
      source: 'arg',
      sourcePath: found?.path ?? '',
      pinIds,
      note: `显式传参 ${tokens} tok`,
    }
  }
  if (found && found.chars <= 0) {
    // `meow-memory/lib/index.js:2858`：budget 为 0 时走 else 分支，user + globalRules 全部注入。
    return {
      tokens: 0,
      chars: 0,
      source: 'off',
      sourcePath: found.path,
      pinIds,
      note: '预算关闭（injectBudgetChars: 0 = 不限）',
    }
  }
  if (found) {
    return {
      tokens: budgetTokensOfChars(found.chars),
      chars: Math.floor(found.chars),
      source: 'meow',
      sourcePath: found.path,
      pinIds,
      note: `meow injectBudgetChars: ${found.chars}`,
    }
  }
  if (referenced) {
    return {
      tokens: budgetTokensOfChars(MEOW_DEFAULT_INJECT_BUDGET_CHARS),
      chars: MEOW_DEFAULT_INJECT_BUDGET_CHARS,
      source: 'meow-default',
      sourcePath: referenced,
      pinIds: [],
      note: `meow 未配 injectBudgetChars，用 schema 默认 ${MEOW_DEFAULT_INJECT_BUDGET_CHARS} 字`,
    }
  }
  return {
    tokens: TIER_BUDGET_TOKENS,
    chars: Math.round(TIER_BUDGET_TOKENS * CHARS_PER_TOKEN),
    source: 'fallback',
    sourcePath: '',
    pinIds: [],
    note: `兜底 ${TIER_BUDGET_TOKENS} tok`,
  }
}
/** 沉底标记（写进 keywords 数组，不写 content）。 */
export const STALE_KEYWORD = '沉底'
/** 每条注入多算的字符（`- ` + 换行），与注入体实测一致。 */
export const ENTRY_OVERHEAD = 3

export function charsOf(text) {
  return [...String(text ?? '')].length
}

export function tokensOf(chars) {
  return Math.round(Number(chars ?? 0) / CHARS_PER_TOKEN)
}

function isGlobalScope(field) {
  if (field === null || field === undefined) return true
  const trimmed = String(field).trim()
  return trimmed === '' || trimmed === '全局' || trimmed.toLowerCase() === 'global'
}

function parseKeywords(raw) {
  if (Array.isArray(raw)) return raw.map((item) => String(item))
  try {
    const parsed = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

/**
 * 读出**真正会进常驻**的条目（口径照 buildInjectionBody，不猜）。
 * @returns {{ok:boolean, error?:string, rows?:Array, dbBytes?:number}}
 */
export function readInjectionRows(dbPath) {
  if (!dbPath || !existsSync(dbPath)) return { ok: false, error: `记忆库不存在：${dbPath}` }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const has = (table) => {
      try {
        return db.prepare('select name from sqlite_master where type=? and name=?').get('table', table) !== undefined
      } catch {
        return false
      }
    }
    const pick = (table, sql) => {
      if (!has(table)) return []
      try {
        return db.prepare(sql).all()
      } catch {
        return []
      }
    }
    const soul = pick('soul', "select * from soul where status='active' order by created_at")
    const user = pick('user', "select * from user where status='active' order by created_at")
    const rules = pick('rules', "select * from rules where status='active' order by created_at").filter(
      (row) => isGlobalScope(row.project) && Number(row.importance ?? 0) >= 2,
    )
    const rows = []
    for (const [level, list] of [['soul', soul], ['user', user], ['rules', rules]]) {
      for (const row of list) {
        const chars = charsOf(row.content) + ENTRY_OVERHEAD
        rows.push({
          level,
          id: String(row.id),
          chars,
          importance: Number(row.importance ?? 1),
          hit_count: Number(row.hit_count ?? 0),
          updated_at: row.updated_at == null ? null : Number(row.updated_at),
          last_accessed_at: row.last_accessed_at == null ? null : Number(row.last_accessed_at),
          corrected: Number(row.corrected ?? 0) === 1,
          keywords: parseKeywords(row.keywords),
          content: String(row.content ?? ''),
        })
      }
    }
    return { ok: true, rows }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉不影响只读结果 */
    }
  }
}

/**
 * 沉底分（可复算，回执里逐项打印）：
 *   score = importance*3 + min(hit_count,5) + (corrected?2:0) + 近30天访问 +2 − 超90天未访问 −2
 * `last_accessed_at` 为 null 视作「从未检索过」：既不加也不扣（不拿“没记过”当罪证）。
 * 坑（H2）：只有 `memory_search` 会 bump 这两个字段；`soul_recall` 是只读直读库、不记账。
 */
export function scoreParts(row, now = Date.now()) {
  const parts = []
  let score = 0
  const imp = row.importance * 3
  score += imp
  parts.push(`imp${row.importance}×3=+${imp}`)
  const hits = Math.min(row.hit_count ?? 0, 5)
  score += hits
  parts.push(`hit${row.hit_count ?? 0}→+${hits}`)
  const corrected = row.corrected ? 2 : 0
  score += corrected
  if (corrected) parts.push(`corrected=+${corrected}`)
  if (row.last_accessed_at != null) {
    const days = (now - row.last_accessed_at) / 86_400_000
    if (days <= 30) {
      score += 2
      parts.push(`访问${days.toFixed(0)}天前=+2`)
    } else if (days > 90) {
      score -= 2
      parts.push(`访问${days.toFixed(0)}天前=−2`)
    } else {
      parts.push(`访问${days.toFixed(0)}天前=0`)
    }
  } else {
    parts.push('从未检索=0')
  }
  return { score, parts }
}

/**
 * 选常驻名单：按沉底分降序；同分让**短的先上**（同样的分，省下的字符能多装两条）。
 *
 * 八期口径：
 *   - **pin 先占位**：显式 `injectPinIds` 与 meow 的自动钉（`importance>=4`）都不受预算限制，
 *     先算进 `chars`，再从剩下的预算里按分数装别的条目（跟 meow `buildInjectionBody` 一致）；
 *   - `savings` 是**诚实收益**：降权腾出的字符会被下一条超线条目补上，所以按「移除后重算填坑」得出，
 *     不做「这条多少字就省多少字」的假账。
 */
export function planTier(rows, { budgetTokens = TIER_BUDGET_TOKENS, budgetChars = null, pins = [], now = Date.now(), budgetOff = false } = {}) {
  /** 八期 T4：`injectBudgetChars: 0` = 关闭预算 = 全量注入（meow 走 `:2858` 的 else 分支）。 */
  // 注意 `Number(null) === 0`：没传 budgetChars 不能被当成「0 字预算」。
  const hasChars = budgetChars !== null && budgetChars !== undefined
  const off = budgetOff === true || (hasChars && Number(budgetChars) === 0) || (!hasChars && Number(budgetTokens) === 0)
  const budgetCharsResolved = off ? 0 : Number(budgetChars) > 0 ? Math.floor(Number(budgetChars)) : Math.round(budgetTokens * CHARS_PER_TOKEN)
  const tokensResolved = off ? 0 : Number(budgetChars) > 0 ? tokensOf(budgetCharsResolved) : Math.max(1, Math.round(budgetTokens))
  const pinSet = new Set((Array.isArray(pins) ? pins : []).map((item) => String(item)))
  const scored = (Array.isArray(rows) ? rows : []).map((row) => {
    const { score, parts } = scoreParts(row, now)
    const byId = pinSet.has(String(row.id))
    const byImportance = Number(row.importance ?? 0) >= 4
    return {
      ...row,
      score,
      parts,
      pinned: byId || byImportance,
      pinReason: byId ? 'pin id' : byImportance ? 'imp≥4 自动钉' : '',
    }
  })
  const order = (a, b) => b.score - a.score || a.chars - b.chars || a.id.localeCompare(b.id)
  const pinned = scored.filter((row) => row.pinned).sort(order)
  const rest = scored.filter((row) => !row.pinned).sort(order)

  const listed = [...pinned]
  const overflow = []
  let chars = pinned.reduce((sum, row) => sum + row.chars, 0)
  for (const row of rest) {
    // 预算关闭时全部进名单，超线恒 0（与 meow 一致：不贪心、不截断）。
    if (off || chars + row.chars <= budgetCharsResolved) {
      listed.push(row)
      chars += row.chars
    } else {
      overflow.push(row)
    }
  }
  const totalChars = scored.reduce((sum, row) => sum + row.chars, 0)
  const byLevel = {}
  for (const row of scored) byLevel[row.level] = (byLevel[row.level] ?? 0) + 1

  /** 可降权：超线里的 rules（user/soul 降 importance 不进也不出常驻）。 */
  const demotable = overflow.filter((row) => row.level === 'rules')
  const ineffective = overflow.filter((row) => row.level !== 'rules')

  /** 把 `removedIds` 摘掉后重新填坑，得到真实注入字符数。 */
  const refillChars = (removedIds) => {
    const kept = scored.filter((row) => !removedIds.has(row.id))
    if (off) return kept.reduce((sum, row) => sum + row.chars, 0)
    const keptPinned = kept.filter((row) => row.pinned && !removedIds.has(row.id))
    const keptRest = kept.filter((row) => !row.pinned).sort(order)
    let used = keptPinned.reduce((sum, row) => sum + row.chars, 0)
    for (const row of keptRest) {
      if (used + row.chars <= budgetCharsResolved) used += row.chars
    }
    return used
  }
  const exitsNow = new Set(demotable.filter((row) => row.importance <= 2).map((row) => row.id))
  const exitsLater = new Set(demotable.map((row) => row.id))
  const nowChars = Math.max(0, chars - refillChars(exitsNow))
  const laterChars = Math.max(0, chars - refillChars(exitsLater))

  return {
    ok: true,
    budgetOff: off,
    budgetTokens: tokensResolved,
    budgetChars: budgetCharsResolved,
    budgetSource: 'fallback',
    rows: [...listed, ...overflow].sort(order),
    listed,
    overflow,
    pinned,
    chars,
    totalChars,
    tokens: tokensOf(totalChars),
    listedTokens: tokensOf(chars),
    overflowTokens: tokensOf(totalChars - chars),
    byLevel,
    /** 降权对常驻的真实作用：只有 rules 有效（且不含 pin）。 */
    effective: demotable.length,
    ineffective: ineffective.length,
    groups: { demotable, ineffective, pinnedSkip: pinned },
    savings: {
      nowChars,
      nowTokens: tokensOf(nowChars),
      laterChars,
      laterTokens: tokensOf(laterChars),
      /** 本次 apply 会不会让任何条目跌破注入门槛（T3 的前置校验用它）。 */
      exits: exitsNow.size,
    },
  }
}

export function planForDb(dbPath, options = {}) {
  const read = readInjectionRows(dbPath)
  if (!read.ok) return { ok: false, error: read.error, text: `【soul_tier】${read.error}` }
  const plan = planTier(read.rows, options)
  const budget = options?.budget ?? null
  return {
    ...plan,
    dbPath,
    budgetSource: budget?.source ?? plan.budgetSource,
    budgetNote: budget?.note ?? '',
    budgetPath: budget?.sourcePath ?? '',
    pins: options?.pins ?? [],
  }
}

/** 每行的降权收益文案（T2 第 1 组要的「本次 0 / 再来一次才省」）。 */
function demotionBenefit(row) {
  const perRow = tokensOf(row.chars)
  if (row.importance <= 2) return `本次 apply 当下节省 ${perRow} tok（imp 2→1 退出常驻）`
  if (row.importance === 3) return `本次 apply 当下节省 0 tok / 再 apply 一次才省 ${perRow} tok`
  return `本次 apply 当下节省 0 tok / 再 apply ${row.importance - 2} 次才省 ${perRow} tok`
}

export function renderTierPlan(plan, { limit = 12 } = {}) {
  if (!plan?.ok) return String(plan?.text ?? '【soul_tier】失败')
  const sourceText =
    plan.budgetSource === 'meow'
      ? `来源 meow injectBudgetChars`
      : plan.budgetSource === 'meow-default'
        ? '来源 meow 默认 1400 字'
        : plan.budgetSource === 'arg'
          ? '来源 显式传参'
          : `来源 兜底 ${TIER_BUDGET_TOKENS} tok`
  const lines = []
  const targetText = plan.budgetOff
    ? '目标：预算关闭（0 = 不限，全量注入）'
    : `目标 ~${plan.budgetTokens} tok（${plan.budgetChars} 字 · ${sourceText}）`
  lines.push(
    `【soul_tier · ${plan.mode === 'apply' ? '已落库' : 'preview'}】常驻 ${plan.listed.length} 条 / ${plan.chars} 字 ≈ ${plan.listedTokens} tok（全库 ${plan.rows.length} 条 ${plan.totalChars} 字）；${targetText}`,
  )
  lines.push(
    `预算来源：${plan.budgetNote || sourceText}${plan.budgetPath ? `（${plan.budgetPath}）` : ''}${plan.pins?.length ? `；pin ${plan.pins.length} 个` : ''}`,
  )
  lines.push(
    `名单 ${plan.listed.length} 条：${plan.listed.map((row) => `${row.level}/${row.importance}`).join(' ') || '（空）'} = ${plan.chars} 字 ≈ ${plan.listedTokens} tok`,
  )
  lines.push(
    `超线 ${plan.overflow.length} 条 = ${plan.totalChars - plan.chars} 字 ≈ ${plan.overflowTokens} tok；其中降 importance 能移出常驻的 ${plan.effective} 条（仅 rules），对注入无效的 ${plan.ineffective} 条（user/soul）${plan.budgetOff ? '（预算关闭，降权没有意义）' : ''}`,
  )
  lines.push(`逐条（沉底分 降序；分数可复算）：`)
  for (const row of plan.rows.slice(0, Math.max(1, limit))) {
    const mark = row.pinned ? `常驻·${row.pinReason}` : plan.listed.includes(row) ? '常驻' : '超线'
    lines.push(`  [${mark}] ${row.level}/${row.id} score=${row.score}（${row.parts.join(' ')}）${row.chars}字`)
  }
  if (plan.rows.length > limit) lines.push(`  ……另 ${plan.rows.length - limit} 条见 limit 参数`)

  const groups = plan.groups ?? { demotable: [], ineffective: [], pinnedSkip: [] }
  const savings = plan.savings ?? { nowTokens: 0, laterTokens: 0, nowChars: 0, laterChars: 0, exits: 0 }
  lines.push(
    `一、可降权（rules，需两次 apply 才退出）共 ${groups.demotable.length} 条：${groups.demotable.length ? '' : '（无）'}`,
  )
  for (const row of groups.demotable) {
    lines.push(`  rules/${row.id} imp${row.importance} ${row.chars}字 · ${demotionBenefit(row)}`)
  }
  if (groups.demotable.length > 0) {
    // 省不省要说实话：降权腾出的空位会被排在后面的超线条目补上，所以两块都按「移除后重算填坑」给。
    const tail =
      savings.laterChars === 0
        ? '再 apply 足够多次也省不到 tok——空位会被其余超线条目补满'
        : `再 apply 足够多次才省 ${savings.laterTokens} tok`
    lines.push(`  本组合计：本次 apply 当下真实节省 ${savings.nowTokens} tok（按重算填坑后实算）/ ${tail}`)
  }
  lines.push(
    `二、降权无效（user / soul，要动只能归档）共 ${groups.ineffective.length} 条：${groups.ineffective.length ? '' : '（无）'}`,
  )
  for (const row of groups.ineffective) {
    lines.push(`  ${row.level}/${row.id} imp${row.importance} ${row.chars}字 · 降 importance 不进也不出常驻`)
  }
  lines.push(`三、pin 保护，跳过 ${groups.pinnedSkip.length} 条（不降 importance、不改 keywords）：`)
  for (const row of groups.pinnedSkip) {
    lines.push(`  ${row.level}/${row.id}（${row.pinReason}）${row.chars}字`)
  }

  if (plan.mode === 'apply') {
    if ((plan.savings?.nowChars ?? 0) === 0) {
      lines.push('注意：本次 apply 不减少任何注入，仅改数据（降一级后仍 ≥2，或空位被其他超线条目补上）。')
    }
    lines.push(`已降权 ${plan.changes?.length ?? 0} 条（importance−1 / keywords+沉底）；备份 ${plan.backup ?? '（无）'}`)
    if (plan.sql?.length) lines.push(`回滚 SQL：${plan.sql.length} 条，已写进回执，可直接 sqlite3 执行`)
  }
  return lines.join('\n')
}

/** 把 keywords 数组追加 `沉底`（幂等）。 */
export function keywordsWithStale(row) {
  const list = Array.isArray(row.keywords) ? row.keywords.map((item) => String(item)) : []
  if (!list.includes(STALE_KEYWORD)) list.push(STALE_KEYWORD)
  return list
}

/**
 * apply：先整库 `VACUUM INTO` 备份（字节数校验），再只动 `overflow` 里的条目。
 * 返回 changes + 可还原的 SQL（每条一行，照抄即可回滚）。
 */
export function applyTier(dbPath, plan, { now = new Date() } = {}) {
  if (!plan?.ok) return { ok: false, error: 'plan 无效，什么都没动' }
  if (!dbPath || !existsSync(dbPath)) return { ok: false, error: `记忆库不存在：${dbPath}` }
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[-:T]/g, '')
  const backup = `${dbPath}.bak-tier3-${stamp}`
  let db
  try {
    // 备份先做，且必须**行数对得上**才继续（交办单 G3：任何 apply 都要有可还原的备份）
    // 注意：VACUUM INTO 出来的库做过整理，字节数天然不等于源库，所以校验用的是各表行数，不是字节数。
    const source = new DatabaseSync(dbPath, { readOnly: true })
    const snapshot = snapshotCounts(source)
    source.close()
    db = new DatabaseSync(dbPath)
    db.prepare(`VACUUM INTO '${backup.replace(/'/g, "''")}'`).run()
    db.close()
    db = null
    const check = new DatabaseSync(backup, { readOnly: true })
    const restored = snapshotCounts(check)
    check.close()
    const diff = Object.keys(snapshot).filter((table) => snapshot[table] !== restored[table])
    if (diff.length > 0) {
      return { ok: false, error: `备份校验失败（${diff.join(',')} 行数不一致），未改任何数据` }
    }

    db = new DatabaseSync(dbPath)
    const changes = []
    const sql = []
    db.exec('BEGIN')
    try {
      for (const row of plan.overflow) {
        // pin 保护（T2 第 3 组）：显式 pin id 与 meow 自动钉的条目一概不碰。
        if (row.pinned) continue
        const table = row.level
        const nextKeywords = keywordsWithStale(row)
        const nextImportance = row.level === 'rules' ? Math.max(1, row.importance - 1) : row.importance
        const importanceChanged = nextImportance !== row.importance
        const keywordsChanged = nextKeywords.length !== row.keywords.length
        if (!importanceChanged && !keywordsChanged) continue
        db
          .prepare(`update ${table} set importance=?, keywords=?, updated_at=? where id=?`)
          .run(nextImportance, JSON.stringify(nextKeywords), Date.now(), row.id)
        changes.push({ level: table, id: row.id, from: row.importance, to: nextImportance, keywords: nextKeywords })
        const prevKeywords = JSON.stringify(row.keywords).replace(/'/g, "''")
        const rollbackUpdatedAt = row.updated_at == null ? '' : `, updated_at=${row.updated_at}`
        sql.push(
          `UPDATE ${table} SET importance=${row.importance}, keywords='${prevKeywords}'${rollbackUpdatedAt} WHERE id='${row.id}';`,
        )
      }
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 回滚失败也要把错抛出去 */
      }
      throw error
    }
    return { ok: true, backup, changes, sql }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  } finally {
    try {
      db?.close()
    } catch {
      /* 关不掉不影响结论 */
    }
  }
}

export default {
  TIER_BUDGET_TOKENS,
  CHARS_PER_TOKEN,
  MEOW_DEFAULT_INJECT_BUDGET_CHARS,
  STALE_KEYWORD,
  budgetTokensOfChars,
  parseMeowInjectConfig,
  resolveTierBudget,
  readInjectionRows,
  scoreParts,
  planTier,
  planForDb,
  renderTierPlan,
  applyTier,
}
