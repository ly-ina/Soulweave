/**
 * 二期模块 C：能力按需加载（只出清单与建议，不自动装/卸任何东西）
 *
 * 1. 清单：扫已装插件的 `tools.register({ name })` + 代理库里的真实调用次数，
 *    产出 `notes\capabilities.md`（工具 | 所属插件 | 最近 30 天调用次数 | 建议常驻/按需）。
 * 2. 建议：`suggestTools` 纯规则匹配（关键词 → 工具名），不调模型。
 *
 * 调用次数的唯一来源是 billion-context 的 `index.db`：代理会话里每条工具调用都是一个
 * `"contentType":"tool-call","toolName":"…"` 的消息，数它即可。只读，不改库。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const CAPABILITIES_FILE = join('notes', 'capabilities.md')
export const DEFAULT_DAYS = 30

/** 关键词 → 工具名（纯规则，无模型）。顺序即优先级。 */
export const SUGGEST_RULES = [
  { match: ['记忆', '回忆', '想起', '查过什么', '之前说'], tools: ['soul_recall', 'memory_search', 'memory_project'] },
  { match: ['封存', '归档', '压缩', '存档', '封存段'], tools: ['soul_toolout', 'archive_search', 'archive_open'] },
  { match: ['工具输出', '省 token', '清理上下文', '视野'], tools: ['soul_toolout', 'soul_cue', 'acp_status'] },
  { match: ['人格', '魂引', 'soul.md', '反哺'], tools: ['soul_persist', 'soul_recall'] },
  { match: ['能力', '工具清单', '按需加载'], tools: ['soul_capabilities'] },
  { match: ['会话', '之前的会话', '历史'], tools: ['session_search', 'session_trace'] },
  { match: ['改文件', '写代码', '代码', '补丁', '重构', '改这段'], tools: ['read', 'edit', 'write', 'pwsh'] },
  { match: ['日记', '随笔', '写日记', '今天的事'], tools: ['write', 'read', 'soul_recall'] },
  { match: ['插件', '安装插件', '启用插件', '装个插件'], tools: ['plugin_manager', 'plugin_market', 'skill'] },
  { match: ['找文件', '路径', '哪个文件'], tools: ['glob', 'grep', 'ops_glob', 'ops_grep'] },
  { match: ['网页', '链接', '文章', '抓取'], tools: ['web_search', 'read_url', 'web_fetch'] },
  { match: ['图片', '截图', '看图'], tools: ['read_image', 'present'] },
  { match: ['定时', '提醒', '每天', '稍后'], tools: ['schedule_create', 'schedule_list'] },
  { match: ['qq', '手机', '发消息'], tools: ['qq-say', 'send_sticker'] },
  { match: ['表情包', '贴纸'], tools: ['send_sticker'] },
  { match: ['记忆库', 'memory.db', 'cue'], tools: ['soul_cue', 'memory_search', 'memory_update'] },
  { match: ['跑测试', '自测', '验收'], tools: ['pwsh', 'todo_write'] },
]

function listDirs(root) {
  if (!existsSync(root)) return []
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** 扫插件目录里 `tools.register({ name: '…' })`，返回 {工具: 插件包名}。 */
export function collectPluginTools({ pluginRoots = [] } = {}) {
  const map = new Map()
  for (const root of pluginRoots) {
    for (const name of listDirs(root)) {
      if (!/^dsh-/.test(name)) continue
      const file = join(root, name, 'index.js')
      if (!existsSync(file)) continue
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      const regex = /tools\.register\(\s*\{[\s\S]{0,400}?name:\s*'([^']+)'/g
      let hit
      while ((hit = regex.exec(text)) !== null) {
        if (!map.has(hit[1])) map.set(hit[1], name)
      }
    }
  }
  return map
}

/** 数代理库里最近 N 天每个工具的调用次数（只读）。 */
export function countCalls(dbPath, { days = DEFAULT_DAYS } = {}) {
  if (!dbPath || !existsSync(dbPath)) return { ok: false, error: `库不存在：${dbPath}`, counts: new Map() }
  const cutoff = Math.floor((Date.now() - days * 86400000) / 1000)
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const counts = new Map()
  try {
    let rows = []
    try {
      rows = db
        .prepare(
          `select c.bytes as bytes from messages m join content c on c.hash = m.content_hash
             join sessions s on s.session_id = m.session_id
            where m.role = 'assistant' and s.created_at >= ?`,
        )
        .all(cutoff)
    } catch {
      rows = db
        .prepare("select c.bytes as bytes from messages m join content c on c.hash = m.content_hash where m.role = 'assistant'")
        .all()
    }
    const regex = /"toolName":"([A-Za-z0-9_-]{1,64})"/g
    for (const row of rows) {
      const text = Buffer.from(row.bytes).toString('utf8')
      let hit
      while ((hit = regex.exec(text)) !== null) counts.set(hit[1], (counts.get(hit[1]) ?? 0) + 1)
      regex.lastIndex = 0
    }
    return { ok: true, counts, scanned: rows.length, days }
  } finally {
    db.close()
  }
}

/** 建议规则：常驻 = 30 天内调用 ≥20 次；0 次标「按需（候选：可评估卸载）」。 */
export function suggestionFor(count) {
  if (count >= 20) return '常驻'
  if (count >= 1) return '按需'
  return '按需（候选）'
}

export function buildRows({ pluginTools, counts, extraTools = [] }) {
  const names = new Set([...pluginTools.keys(), ...counts.keys(), ...extraTools])
  return [...names]
    .map((name) => ({
      tool: name,
      plugin: pluginTools.get(name) ?? '宿主内置/未归属',
      count: counts.get(name) ?? 0,
      suggestion: suggestionFor(counts.get(name) ?? 0),
    }))
    .sort((a, b) => (b.count - a.count) || a.tool.localeCompare(b.tool))
}

export function renderCapabilities(rows, { days = DEFAULT_DAYS, source = '' } = {}) {
  const lines = [
    '# 能力清单（soul_capabilities）',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 调用次数口径：${source || 'billion-context index.db'} 里最近 ${days} 天的 tool-call 消息`,
    `- 共 ${rows.length} 个工具；常驻 ${rows.filter((r) => r.suggestion === '常驻').length} 个`,
    '',
    '| 工具 | 所属插件 | 最近 30 天调用次数 | 建议 |',
    '| --- | --- | --- | --- |',
  ]
  for (const row of rows) lines.push(`| ${row.tool} | ${row.plugin} | ${row.count} | ${row.suggestion} |`)
  lines.push('')
  return lines.join('\n')
}

export function writeCapabilities(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  return file
}

/** 没有任何规则命中时的固定说法（交办单 C2：不许瞎凑）。 */
export const NO_MATCH_TEXT = '无相关能力'

/** 把查询切成词：拉丁词（≥2 字）+ 中文二元组；两条路都能命中规则里的中文关键词。 */
export function wordsOf(query) {
  const text = String(query ?? '').toLowerCase()
  const words = new Set()
  for (const hit of text.matchAll(/[a-z0-9_+.-]{2,}/g)) words.add(hit[0])
  for (const hit of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const run = hit[0]
    for (let index = 0; index + 2 <= run.length; index += 1) words.add(run.slice(index, index + 2))
    words.add(run)
  }
  return { text, words }
}

/** 命中规则排序（内部）：命中词多的、命中的词更长的排前面。 */
function rankRules(query) {
  const { text, words } = wordsOf(query)
  if (text.trim() === '') return { text, matched: [] }
  const scored = []
  SUGGEST_RULES.forEach((rule, index) => {
    const hitWords = []
    let longest = 0
    for (const word of rule.match) {
      const needle = word.toLowerCase()
      if (text.includes(needle) || words.has(needle)) {
        hitWords.push(word)
        longest = Math.max(longest, needle.length)
      }
    }
    if (hitWords.length > 0) scored.push({ rule, hits: hitWords.length, longest, index, hitWords })
  })
  scored.sort((a, b) => b.hits - a.hits || b.longest - a.longest || a.index - b.index)
  return { text, matched: scored }
}

/**
 * 按关键词给**真正命中**的工具名（交办单 C1/C2）：
 *   - 只返回命中规则的工具，3–5 个是「上限 5」而不是「凑够 3」——不相关的一个都不许出现；
 *   - 命中越多词、词越长的规则排前面（越具体越先给）；
 *   - 一条都没命中 → 返回空数组，由调用方说 `无相关能力`。
 */
export function suggestTools(query, { rows = [], limit = 5 } = {}) {
  const { text, matched } = rankRules(query)
  if (text.trim() === '') return []
  const cap = Math.max(1, Math.min(Number(limit) || 5, 8))
  const out = []
  for (const item of matched) {
    for (const name of item.rule.tools) {
      if (out.length >= cap) break
      if (!out.includes(name)) out.push(name)
    }
    if (out.length >= cap) break
  }
  if (out.length === 0) {
    // 兜底：查询里直接点了工具名，也算相关
    for (const row of rows) {
      const name = String(row?.tool ?? '')
      if (name && text.includes(name.toLowerCase()) && !out.includes(name)) out.push(name)
      if (out.length >= cap) break
    }
  }
  return out.slice(0, cap)
}

/** 同 suggestTools，但每个工具带一句「为什么」（交办单 C1：3–5 个工具名 + 一句为什么）。 */
export function suggestToolsWithReasons(query, { rows = [], limit = 5 } = {}) {
  const { text, matched } = rankRules(query)
  const cap = Math.max(1, Math.min(Number(limit) || 5, 8))
  const out = []
  const push = (name, why) => {
    if (out.length >= cap || out.some((item) => item.tool === name)) return
    out.push({ tool: name, why })
  }
  for (const item of matched) {
    for (const name of item.rule.tools) push(name, `命中「${item.hitWords.join('/')}」`)
    if (out.length >= cap) break
  }
  if (out.length === 0) {
    for (const row of rows) {
      const name = String(row?.tool ?? '')
      if (name && text.includes(name.toLowerCase())) push(name, '查询里直接点了工具名')
      if (out.length >= cap) break
    }
  }
  return out
}

export default {
  CAPABILITIES_FILE,
  NO_MATCH_TEXT,
  SUGGEST_RULES,
  collectPluginTools,
  countCalls,
  suggestionFor,
  buildRows,
  renderCapabilities,
  writeCapabilities,
  suggestTools,
  suggestToolsWithReasons,
}
