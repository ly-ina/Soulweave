/**
 * recall —— 三源检索、原文库/规则/笔记搜索、persist（零宿主依赖）。
 */

import {
  envAll,
  existsSync,
  join,
  pathToFileURL,
  platform,
  readFileSync,
  readdirSync,
  relative,
  requireResolve,
  resolve,
  sep,
  spawnProcess,
  statSync,
  writeFileSync,
} from '../io.mjs'
import * as builtinMemory from '../memory/builtin.mjs'
import { PLUGIN_DIR, asText, asInt, clip, estimateTokens, dsHome } from './text.mjs'
import { RECALL_MAX_CHARS } from './constants.mjs'
import { createMemoryBackend, hitAll, snippetAround, wordsOf, searchMemoryMeow, scoreOf } from './search.mjs'
import { createHybridSearch } from './hybrid.mjs'
import { ZONE_IDS, ZONES, scanZones, searchZones } from './zones.mjs'
import { normalizeConfig } from './config.mjs'

function packageRequireBases() {
  const bases = [join(PLUGIN_DIR, 'package.json')]
  try {
    for (const item of readdirSync(join(dsHome(), 'profiles'), { withFileTypes: true })) {
      if (item.isDirectory()) bases.push(join(dsHome(), 'profiles', item.name, 'package.json'))
    }
  } catch {
    /* 没有 profiles 目录就只用插件自己 */
  }
  return bases
}

export async function resolveSealedModule(options = {}) {
  const spec = asText(options.sealedModule)
  if (!spec) return { module: null, via: 'none', error: '未配置 sealedSegmentsModule' }
  if (/[\\/]/.test(spec) || /\.m?js$/i.test(spec)) {
    const absolute = resolve(PLUGIN_DIR, spec)
    try {
      return { module: await import(pathToFileURL(absolute).href), via: 'path' }
    } catch (error) {
      return { module: null, via: 'path', error: String(error?.message ?? error) }
    }
  }
  try {
    return { module: await import(spec), via: 'import' }
  } catch {
    /* 插件目录解析不到包名，继续用 profile 的 node_modules 试 */
  }
  for (const base of packageRequireBases()) {
    try {
      const file = requireResolve(base, spec)
      return { module: await import(pathToFileURL(file).href), via: 'require' }
    } catch {
      /* 下一个候选 */
    }
  }
  return { module: null, via: 'none', error: `找不到模块 ${spec}` }
}

/** 封存源复用 `dsh-sealed-segments` 的导出函数（§13.4），失败则明确报告而不是静默空结果。 */
export function createArchiveSearch(options) {
  let cached = null
  let reader = null
  return async function searchArchiveSource(words, limit) {
    cached ??= resolveSealedModule(options)
    const resolved = await cached
    if (!resolved.module) return { entries: [], note: `封存源不可用：${resolved.error ?? '导入失败'}` }
    const mod = resolved.module
    const manifestPath = options.manifestPath ?? join(options.archiveRoot, 'manifest.jsonl')
    try {
      reader ??= mod.createManifestReader({ manifestPath, archiveRoot: options.archiveRoot })
      const records = reader()
      const result = mod.searchArchive(records, {
        query: words.join(' '),
        limit,
        contextLines: 0,
        maxLines: 24,
        options: { manifestPath, archiveRoot: options.archiveRoot },
      })
      const entries = []
      let current = null
      for (const line of result.display ?? []) {
        const head = /^==\s+(\S+)\s+·\s+(.*?)\s+·\s+命中\s+(\d+)\s+处/.exec(line)
        if (head) {
          if (current) entries.push(current)
          current = { loc: `封存段/${head[1]}`, snippet: '' }
          continue
        }
        const body = /^[> ]\s*\d+\|\s*(.*)$/.exec(line)
        if (body && current && current.snippet === '') current.snippet = clip(body[1], 90)
      }
      if (current) entries.push(current)
      return { entries: entries.slice(0, limit), note: result.hits === 0 ? '封存里没有这些词' : '' }
    } catch (error) {
      return { entries: [], note: `封存检索失败：${String(error?.message ?? error)}` }
    }
  }
}

export function walkMarkdown(root, limit = 400) {
  const out = []
  const stack = [root]
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop()
    let items
    try {
      items = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const item of items) {
      const full = join(dir, item.name)
      if (item.isDirectory()) {
        if (item.name === 'node_modules' || item.name.startsWith('.')) continue
        stack.push(full)
      } else if (item.name.toLowerCase().endsWith('.md')) {
        out.push(full)
        if (out.length >= limit) break
      }
    }
  }
  return out
}

/**
 * 规则原文索引（2026-11-12）：扫 `rulesDir` 下 `*.md`，只取标题层。
 *
 * 返回 `{ lines, entries, count, shown, tokens }`；目录没配或读不到就返回空，不抛。
 * `lines` 给稳定段，`entries` 给 soul_recall 第⑤源做定位——同一份数据两种用途，
 * 原文一个字都不复制进记忆库（伊纳 2026-11-12 定的单源原则）。
 */
export function readRulesIndex(dir, maxTokens = 120) {
  const empty = { lines: [], entries: [], count: 0, shown: 0, tokens: 0 }
  const base = asText(dir)
  if (base === '' || !existsSync(base)) return empty
  let names = []
  try {
    names = readdirSync(base).filter((name) => name.toLowerCase().endsWith('.md')).sort()
  } catch {
    return empty
  }
  const entries = []
  for (const name of names) {
    let text = ''
    try {
      const file = join(base, name)
      if (statSync(file).size > 400_000) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const all = text.replace(/^\uFEFF/, '').split(/\r?\n/)
    const h1 = all.find((line) => /^#\s+/.test(line))
    const sections = all
      .filter((line) => /^##\s+/.test(line))
      .map((line) => line.replace(/^##\s+/, '').replace(/（[^）]*\d{4}-\d{2}-\d{2}[^）]*）/g, '').trim())
      .filter((line) => line !== '')
      .slice(0, 2)
    // 文件自述摘要优先（2026-11-12）：规则文件可以在任意位置写一行 `> 摘要：…`，
    // 索引就用它，不再靠标题猜；没写才退回标题/小节。仍是单源——摘要也住在同一份文件里。
    const declared = text.match(/^>\s*摘要[:：]\s*(.+)$/m)
    const bare = name.replace(/\.md$/i, '')
    const title = (h1 ? h1.replace(/^#\s+/, '') : '')
      .replace(/（[^）]*\d{4}-\d{2}-\d{2}[^）]*）/g, '')
      .replace(/\([^)]*\d{4}-\d{2}-\d{2}[^)]*\)/g, '')
      .trim()
    const summary = (declared ? declared[1].trim() : '') || (title !== '' && title !== bare ? title : (sections.join('·') || bare))
    const cap = declared ? 34 : 26
    entries.push({ name: bare, file: name, title: title || bare, sections, line: `- ${bare}：${clip(summary, cap)}` })
  }
  const lines = []
  let tokens = 0
  for (const entry of entries) {
    const next = estimateTokens([...lines, entry.line].join('\n'))
    if (next > maxTokens) break
    lines.push(entry.line)
    tokens = next
  }
  return { lines, entries, count: entries.length, shown: lines.length, tokens }
}

/**
 * 第⑤源：规则原文（2026-11-12）。与笔记源同一形状，只是目录固定、只读。
 * 命中给 `rules/<文件名>:<行号>`，片段仍走 snippetAround，不整段回灌。
 */
export function searchRules(options, words, limit) {
  if (asText(options.rulesDir) === '') return { entries: [], note: '未配置规则目录' }
  if (!existsSync(options.rulesDir)) return { entries: [], note: '规则目录不存在' }
  let names = []
  try {
    names = readdirSync(options.rulesDir).filter((name) => name.toLowerCase().endsWith('.md')).sort()
  } catch {
    return { entries: [], note: '规则目录读不了' }
  }
  const entries = []
  for (const name of names) {
    let text = ''
    try {
      const file = join(options.rulesDir, name)
      if (statSync(file).size > 400_000) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!hitAll(text, words)) continue
    const lines = text.split(/\r?\n/)
    const index = lines.findIndex((line) => hitAll(line, words))
    entries.push({
      loc: `rules/${name}:${index >= 0 ? index + 1 : 1}`,
      snippet: snippetAround(index >= 0 ? lines[index] : text, words),
    })
    if (entries.length >= limit) break
  }
  return { entries, note: entries.length === 0 ? '规则原文里没有这些词' : '' }
}

export function searchNotes(options, words, limit) {
  if (!existsSync(options.notesDir)) return { entries: [], note: '笔记目录不存在' }
  const files = walkMarkdown(options.notesDir)
  const entries = []
  for (const file of files) {
    let text
    try {
      if (statSync(file).size > 400_000) continue
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    if (!hitAll(text, words)) continue
    const lines = text.split(/\r?\n/)
    const index = lines.findIndex((line) => hitAll(line, words))
    const lineNo = index >= 0 ? index + 1 : 1
    entries.push({
      loc: `${relative(options.notesDir, file).split(sep).join('/')}:${lineNo}`,
      snippet: snippetAround(index >= 0 ? lines[index] : text, words),
    })
    if (entries.length >= limit) break
  }
  return { entries, note: entries.length === 0 ? '笔记里没有这些词' : '' }
}

/**
 * 第四源：soul-index 原文库（全量会话原文，2026-11-01 接入）。
 * 现跑 query.py --json；失败只返回 note，不拖累其余三源。
 *
 * 熔断（2026-11-24 第九刀）：python 缺失/query.py 坏了时，原先每次 soul_recall 都要
 * 白等满 15 秒超时。现在失败按指数退避熔断（1min → 5min → 15min，上限 15min），
 * 熔断期内直接返回 note 不 spawn；成功一次立即复位。
 */
const indexCircuit = { fails: 0, openUntil: 0, lastNote: '' }
export function resetIndexCircuit() { indexCircuit.fails = 0; indexCircuit.openUntil = 0; indexCircuit.lastNote = '' }
export function indexCircuitState() { return { ...indexCircuit, open: Date.now() < indexCircuit.openUntil } }
const INDEX_BACKOFF_MS = [60_000, 300_000, 900_000]

function tripIndexCircuit(note) {
  indexCircuit.fails += 1
  const wait = INDEX_BACKOFF_MS[Math.min(indexCircuit.fails - 1, INDEX_BACKOFF_MS.length - 1)]
  indexCircuit.openUntil = Date.now() + wait
  indexCircuit.lastNote = note
}

export function searchIndexSource(options, words, limit) {
  if (Date.now() < indexCircuit.openUntil) {
    const left = Math.ceil((indexCircuit.openUntil - Date.now()) / 1000)
    return Promise.resolve({ entries: [], note: `原文库熔断中（${left}s 后重试）：${indexCircuit.lastNote}` })
  }
  return new Promise((resolve) => {
    const dir = options.soulIndexDir
    const script = join(dir, 'query.py')
    if (!existsSync(script)) return resolve({ entries: [], note: '原文库脚本不在' })
    let child
    try {
      child = spawnProcess(options.soulIndexPython || (platform() === 'win32' ? 'python' : 'python3'), [script, words.join(' '), String(limit), '--json'], {
        cwd: dir, windowsHide: true, env: { ...envAll(), SOUL_INDEX_NO_SYNC: '1' },
      })
    } catch (e) {
      const note = '原文库启动失败：' + (e?.message || e)
      tripIndexCircuit(note)
      return resolve({ entries: [], note })
    }
    let out = ''
    let err = ''
    let done = false
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } tripIndexCircuit('原文库超时'); finish({ entries: [], note: '原文库超时' }) }, 15000)
    child.stdout?.on('data', (d) => { out += d })
    child.stderr?.on('data', (d) => { err += d })
    child.on('error', (e) => { const note = '原文库不可用：' + (e?.message || e); tripIndexCircuit(note); finish({ entries: [], note }) })
    child.on('close', (code) => {
      if (code !== 0) { const note = '原文库退出 ' + code + (err ? '：' + clip(err, 80) : ''); tripIndexCircuit(note); return finish({ entries: [], note }) }
      try {
        const rows = JSON.parse(out.trim() || '[]')
        resetIndexCircuit()
        finish({
          entries: rows.slice(0, limit).map((r) => ({ loc: r.when + ' ' + String(r.sid || '').slice(-8) + '#' + r.seq, snippet: r.snippet })),
          note: rows.length === 0 ? '原文库里没有这些词' : '',
        })
      } catch {
        tripIndexCircuit('原文库输出解析失败')
        finish({ entries: [], note: '原文库输出解析失败' })
      }
    })
  })
}

/**
 * 三源检索并压成 ≤1200 字符的文本（§3.2）。超限时截断并注明「还有 N 条未显示」。
 */
/**
 * 检索源注册制（§B）：memory / sealed / notes / index 四项。
 * 每项 `{ id, enabled, search }`；没配置的源不注册（返回「未配置（跳过）」的空结果），
 * 单个源抛错只写 note，不拖累其余源。
 */
export function createRecallSources(config) {
  const backend = createMemoryBackend(config)
  /**
   * 混合重排（2026-11-07）：向量编码放在外部可选模块里，插件不背 95MB 模型和 transformers 依赖。
   * 找不到模块、模型加载失败、编码抛错，一律退回纯 BM25；重排只是加分项，不能把原有召回搞挂。
   */
  let recallerPromise = null
  const recallForHybrid = async (query, limit) => {
    if (recallerPromise === null) {
      recallerPromise = (async () => {
        const spec = asText(config.embedModule)
        if (spec === '') return null
        const resolved = await resolveSealedModule({ sealedModule: spec })
        if (!resolved.module || typeof resolved.module.createVectorRecall !== 'function') {
          console.error(`[soulweave] 向量模块不可用：${resolved.error ?? '缺少 createVectorRecall'}，召回退回 BM25`)
          return null
        }
        return resolved.module.createVectorRecall({
          dbPath: backend.dbPath,
          modelDir: asText(config.embedModelDir) || undefined,
          cachePath: asText(config.embedCachePath) || undefined,
        })
      })().catch((error) => {
        console.error(`[soulweave] 向量模块初始化失败：${String(error?.message ?? error)}，召回退回 BM25`)
        return null
      })
    }
    const instance = await recallerPromise
    if (!instance) throw new Error('vector recall unavailable')
    return instance.recall(query, limit)
  }
  const memorySearch = config.hybridSearch === true
    ? createHybridSearch({ search: (query, limit) => backend.search(query, limit), recall: recallForHybrid })
    : (query, limit) => backend.search(query, limit)
  // 2026-11-24 魂织第一刀：meow 后端时再读同一个库里 soul_remember 写的 memories 表。
  // 两个池子同库不同表，按 loc 去重；builtin 后端本身读的就是这张表，不重复读。
  const memoryBoth = async (query, limit) => {
    const primary = await memorySearch(query, limit)
    if (config.memoryBackend === 'builtin') {
      // 第三刀：旧 meow 库只读挂载，双读比对。新池优先，旧库只补位、不改写。
      if (typeof backend.legacySearch !== 'function') return primary
      const legacy = await backend.legacySearch(query, limit)
      if (!legacy || !Array.isArray(legacy.entries) || legacy.entries.length === 0) return primary
      const seen = new Set((primary.entries ?? []).map((entry) => String(entry.loc)))
      const extra = legacy.entries
        .filter((entry) => !seen.has(String(entry.loc)))
        .slice(0, Math.max(1, Math.ceil(limit / 2)))
        .map((entry) => ({ ...entry, loc: `旧库/${String(entry.loc)}` }))
      if (extra.length === 0) return primary
      const primaryTop = (primary.entries ?? []).slice(0, Math.max(limit - extra.length, 0))
      return { entries: [...primaryTop, ...extra].slice(0, Math.max(limit, 1)), note: primary.note || '' }
    }
    if (!existsSync(config.memoryDbPath)) return primary
    // builtin.search 对字符串按「整串一个词」匹配，这里必须先拆成词，否则永远空命中。
    const words = String(query ?? '').split(/\s+/).filter(Boolean)
    const extra = builtinMemory.search(config.memoryDbPath, words, limit)
    if (!Array.isArray(extra.entries) || extra.entries.length === 0) return primary
    const seen = new Set((primary.entries ?? []).map((entry) => String(entry.loc)))
    // 双读阶段新库优先：至少给 memories 表 ceil(limit/2) 个位置，
    // 否则 meow 一次就占满 limit，新写的永远露不出来。
    const extraTop = extra.entries.filter((entry) => !seen.has(String(entry.loc))).slice(0, Math.max(1, Math.ceil(limit / 2)))
    const primaryTop = (primary.entries ?? []).slice(0, Math.max(limit - extraTop.length, 0))
    return {
      entries: [...extraTop, ...primaryTop].slice(0, Math.max(limit, 1)),
      note: primary.note || extra.note || '',
    }
  }
  const archiveSearch = asText(config.sealedModule)
    ? createArchiveSearch({ ...config, manifestPath: join(config.archiveRoot, 'manifest.jsonl') })
    : null
  return [
    {
      id: 'memory',
      label: '① 记忆库',
      enabled: true,
      search: (words, n) => memoryBoth(words.join(' '), n),
    },
    {
      id: 'archive',
      label: '② 封存段',
      enabled: Boolean(archiveSearch),
      search: (words, n) => archiveSearch(words, n),
    },
    {
      id: 'notes',
      label: '③ 笔记',
      enabled: true,
      search: (words, n) => searchNotes(config, words, n),
    },
    {
      id: 'rules',
      label: '⑤ 规则原文',
      enabled: Boolean(asText(config.rulesDir)),
      search: (words, n) => searchRules(config, words, n),
    },
    {
      id: 'index',
      label: '④ 原文库',
      enabled: Boolean(asText(config.soulIndexDir)),
      search: (words, n) => searchIndexSource(config, words, n),
    },
  ]
}

export function createRecall(options = {}) {
  const config = normalizeConfig(options)
  const sources = createRecallSources(config)

  return async function recall({ query, limit, zone, tags } = {}) {
    const words = wordsOf(query)
    const wantedTags = (Array.isArray(tags) ? tags : asText(tags) ? asText(tags).split(/[,，、\s]+/) : [])
      .map((tag) => asText(tag))
      .filter(Boolean)
    const zoneWanted = asText(zone)
    // 待办 A：带了 zone / tags 就先在分区里过滤，再走分区打分；结果带 zone 与 tags。
    if (zoneWanted || wantedTags.length > 0) {
      const found = searchZones(scanZones(config.memoryRoot), {
        query: words.join(' '),
        zone: zoneWanted,
        tags: wantedTags,
        limit: asInt(limit, config.recallLimit, 1, 5),
      })
      const lines = [`【soul_recall · 分区】${zoneWanted || '全部'}${wantedTags.length ? ` · tags=${wantedTags.join('+')}` : ''}`]
      if (found.note) lines.push(found.note)
      for (const entry of found.entries) {
        lines.push(`- ${entry.zone}/${entry.title}${entry.tags.length ? ` [${entry.tags.join(',')}]` : ''} · ${entry.snippet}`)
      }
      const text = lines.join('\n').slice(0, RECALL_MAX_CHARS)
      return {
        ok: true,
        text,
        sources: { memory: found.entries.length, archive: 0, notes: 0, index: 0, rules: 0 },
        active: ['zone'],
        hits: found.entries.map((entry) => ({ zone: entry.zone, title: entry.title, tags: entry.tags, snippet: entry.snippet })),
        truncated: false,
      }
    }
    if (words.length === 0) {
      return {
        ok: false,
        text: 'soul_recall: query 不能为空',
        sources: { memory: 0, archive: 0, notes: 0, index: 0, rules: 0 },
        active: sources.filter((source) => source.enabled).map((source) => source.id),
        truncated: false,
      }
    }
    const n = asInt(limit, config.recallLimit, 1, 5)
    const results = await Promise.all(
      sources.map((source) =>
        source.enabled
          ? Promise.resolve()
              .then(() => source.search(words, n))
              .catch((error) => ({ entries: [], note: `源失败：${String(error?.message ?? error)}` }))
          : Promise.resolve({ entries: [], note: '未配置（跳过）' }),
      ),
    )
    const blocks = sources.map((source, index) => ({ id: source.id, label: source.label, result: results[index] }))
    const header = `【soul_recall】${words.join(' ')}`
    const lines = [header]
    let dropped = 0
    let chars = header.length + 1
    const counts = { memory: 0, archive: 0, notes: 0, index: 0, rules: 0 }
    for (const block of blocks) counts[block.id] = block.result.entries.length
    for (const block of blocks) {
      const head = `${block.label}（${block.result.entries.length} 条）${block.result.note ? ` · ${block.result.note}` : ''}`
      if (chars + head.length + 1 > RECALL_MAX_CHARS) {
        dropped += block.result.entries.length
        continue
      }
      lines.push(head)
      chars += head.length + 1
      for (const entry of block.result.entries) {
        const line = `- ${entry.loc} · ${entry.snippet}`
        if (chars + line.length + 1 > RECALL_MAX_CHARS) {
          dropped += 1
          continue
        }
        lines.push(line)
        chars += line.length + 1
      }
    }
    if (dropped > 0) lines.push(`（还有 ${dropped} 条未显示；缩小检索词或用原工具看全）`)
    const text = lines.join('\n').slice(0, RECALL_MAX_CHARS)
    return {
      ok: true,
      text,
      sources: counts,
      active: blocks.filter((block, index) => sources[index].enabled).map((block) => block.id),
      truncated: dropped > 0,
    }
  }
}

/**
 * §7 soul_persist：把「被使用者明确纠正过」的 lesson 追加到 soul.md 第四节。
 * 只追加、不重写前三节；默认 preview，append 时才落盘并先备份。
 */
export function createPersist(config) {
  return async function persist(args = {}) {
    const mode = args?.mode === 'append' ? 'append' : 'preview'
    const limit = Math.min(Math.max(Number(args?.limit ?? 10) || 10, 1), 20)
    const md = readFileSync(config.soulPath, 'utf8')
    if (!md.includes('## 反哺') && !md.includes('## 反哺记录')) {
      return { ok: false, mode, added: 0, pending: 0, text: 'soul.md 缺少「## 反哺」节（旧名「反哺记录」也认），未写入' }
    }
    const seen = new Set()
    for (const m of md.matchAll(/（([0-9a-z]{8})/g)) seen.add(m[1])

    // 2026-11-03 开源化：记忆读取统一走 backend（builtin / meow / none 都能给出 lesson）
    const backend = createMemoryBackend(config)
    const rows = backend.listCorrectedLessons(500)

    const pending = rows.filter((row) => !seen.has(String(row.id).slice(0, 8)))
    const take = pending.slice(0, limit)
    const fmt = (row) => {
      let t = String(row.title ?? '').replace(/^关于：/, '').trim()
      if (!t) t = String(row.content ?? '').split(/[。；;！!？?\n]/)[0]
      t = t.replace(/\s+/g, ' ').trim()
      if (t.length > 46) t = t.slice(0, 46) + '…'
      const proj = row.project && row.project !== '全局' ? ` · ${row.project}` : ''
      const day = new Date(Number(row.created_at)).toLocaleDateString('sv-SE')
      return `- [${day}] ${t}（${String(row.id).slice(0, 8)}${proj}）`
    }
    const lines = take.map(fmt)

    if (mode !== 'append' || lines.length === 0) {
      const head = lines.length === 0
        ? `【soul_persist · 预览】没有待追加的条目（corrected=1 且 active 共 ${rows.length} 条，都已在反哺记录里）`
        : `【soul_persist · 预览】待追加 ${pending.length} 条，本次显示 ${lines.length} 条；确认后传 { mode: "append" } 才落盘`
      return { ok: true, mode, added: 0, pending: pending.length, text: [head, ...lines].join('\n') }
    }

    const backup = `${config.soulPath}.bak-persist-${Date.now()}`
    writeFileSync(backup, md, 'utf8')
    const next = md.replace(/\s*$/, '\n') + lines.join('\n') + '\n'
    writeFileSync(config.soulPath, next, 'utf8')
    const head = `【soul_persist · 已追加】${lines.length} 条（待追加剩 ${pending.length - lines.length} 条）；备份 ${backup}`
    return { ok: true, mode, added: lines.length, pending: pending.length - lines.length, text: [head, ...lines].join('\n') }
  }
}

