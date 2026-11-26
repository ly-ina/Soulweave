/**
 * core/probe.mjs —— dream 记忆探针：取词、跑检、状态读写、到点调度（零宿主依赖）。
 *
 * 2026-11-19 解耦第 6 块：从 index.js 原样搬出，逻辑未改。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from '../io.mjs'
import { openDatabase } from '../storage/index.mjs'

import { join } from 'node:path'
import { tableColumns } from './text.mjs'
import { MEMORY_LEVELS } from './constants.mjs'
import { textOfMessage } from './budget.mjs'
import { searchMemory } from './search.mjs'

// ---------------------------------------------------------------------------
// 二期 B R5：周检探针（7 天一轮；dream 收尾后附带 3 条快检）
// ---------------------------------------------------------------------------

/** meow-memory 的 dream 标记：它插一条带这个 marker 的 user 消息。 */
export const DREAM_MARKER = '[meow-memory-dream]'

/** 最近一个 turn 里有没有 dream 注入（用来判断「dream 刚收尾」）。 */
export function isDreamTurn(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/start') break
    if (event?.type !== 'user/message') continue
    if (textOfMessage(event?.data?.message ?? event?.data).includes(DREAM_MARKER)) return true
  }
  return false
}

/** 记忆库的 `keywords` 列常是 JSON 数组字符串（`["a","b"]`），也可能是普通分隔串。 */
export function wordsOfKeywords(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) {
        return parsed.map((word) => String(word).trim()).filter((word) => word.length >= 2)
      }
    } catch {
      /* 落到下面的分隔切法 */
    }
  }
  return text
    .split(/[,，;；、\s]+/)
    .map((word) => word.replace(/^["'[\]()]+|["'[\]()]+$/g, '').trim())
    .filter((word) => word.length >= 2)
}

/**
 * 探针词只从**检索面**取（keywords 优先，其次 title），绝不从正文切——
 * 从正文切的词在关键词索引里常常搜不回来，会得到假警报（记忆 `0mvl2r5kf`）。
 * 抽样是确定性的（同一 seed 复跑同一批），seed 用「日期序号」，便于复现。
 */
export function pickProbeWords(dbPath, count, seed = 0) {
  if (!existsSync(dbPath) || count <= 0) return []
  let db
  try {
    db = openDatabase(dbPath, { readOnly: true })
    const pool = []
    for (const level of MEMORY_LEVELS) {
      const cols = tableColumns(db, level)
      if (!cols.includes('content')) continue
      const hasStatus = cols.includes('status')
      const pick = ['id', 'content']
      for (const optional of ['title', 'keywords']) if (cols.includes(optional)) pick.push(optional)
      let rows
      try {
        rows = db.prepare(`select ${pick.join(', ')} from ${level}${hasStatus ? " where status = 'active'" : ''}`).all()
      } catch {
        continue
      }
      for (const row of rows) {
        const keywords = wordsOfKeywords(row.keywords)
        const titleWords = wordsOfKeywords(row.title)
        const words = keywords.length > 0 ? keywords : titleWords
        if (words.length === 0) continue
        pool.push({ level, id: String(row.id), words })
      }
    }
    if (pool.length === 0) return []
    const picked = []
    const used = new Set()
    let cursor = Math.abs(Math.trunc(seed)) % pool.length
    const total = Math.min(count, pool.length)
    for (let guard = 0; guard < pool.length * 3 && picked.length < total; guard += 1) {
      const item = pool[cursor % pool.length]
      cursor += 7
      const key = `${item.level}#${item.id}`
      if (used.has(key)) continue
      used.add(key)
      picked.push(item)
    }
    return picked
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/** 逐条探针：用条目自己的 keywords 查，命中同一 id 即算通过。 */
export function runProbes(options, probes, limit = 5) {
  const results = []
  for (const probe of Array.isArray(probes) ? probes : []) {
    const words = probe.words.slice(0, 3).map((word) => word.toLowerCase())
    const found = searchMemory(options, words, limit)
    const needle = `#${probe.id}`
    const hit = (found.entries ?? []).some((entry) => String(entry?.loc ?? '').includes(needle))
    results.push({ level: probe.level, id: probe.id, words, hit })
  }
  const passed = results.filter((item) => item.hit).length
  return { results, passed, total: results.length }
}

function probeStatePath(stateDir) {
  return join(stateDir, 'probe-state.json')
}

export function readProbeState(stateDir) {
  try {
    const file = probeStatePath(stateDir)
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeProbeState(stateDir, state) {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(probeStatePath(stateDir), JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 到点就跑：主探针每 `probeIntervalDays` 一轮（10 条，≥8 通过），
 * dream 收尾那轮改跑快检（默认 3 条）。连续两期主探针不达标 → `alert=true`，由调用方在魂引末行申报。
 * 全部只读本地记忆库，不出网、不额外起模型请求。
 */
export function maybeRunProbe(config, at, dreamTurn) {
  const state = readProbeState(config.stateDir)
  const interval = config.probeIntervalDays * 86_400_000
  const mainDue = at.getTime() - Number(state.lastMainAt ?? 0) >= interval
  if (!mainDue && !dreamTurn) return { line: '', alert: false, state }
  const count = mainDue ? 10 : config.probeQuickCount
  const probes = pickProbeWords(config.memoryDbPath, count, Math.floor(at.getTime() / 86_400_000))
  if (probes.length === 0) return { line: 'probe=skip/no-probe-words', alert: false, state }
  const run = runProbes({ memoryDbPath: config.memoryDbPath }, probes)
  const need = Math.ceil(run.total * 0.8)
  const next = { ...state }
  if (mainDue) {
    next.lastMainAt = at.getTime()
    next.lastMainPassed = run.passed
    next.lastMainTotal = run.total
    next.badStreak = run.passed >= need ? 0 : Number(state.badStreak ?? 0) + 1
  } else {
    next.lastQuickAt = at.getTime()
    next.lastQuickPassed = run.passed
    next.lastQuickTotal = run.total
    if (run.passed < run.total) next.quickMiss = Number(state.quickMiss ?? 0) + 1
  }
  writeProbeState(config.stateDir, next)
  const tag = mainDue ? 'main' : 'quick'
  const bad = mainDue && run.passed < need
  const missed = run.results.filter((item) => !item.hit).map((item) => `${item.level}#${item.id}`)
  return {
    line: [
      `probe=${tag} ${run.passed}/${run.total}`,
      bad ? 'ALERT' : 'ok',
      `need=${need}`,
      `bad-streak=${Number(next.badStreak ?? 0)}`,
      missed.length > 0 ? `miss=${missed.join(',')}` : '',
      `words=${run.results.map((item) => item.words.join('|')).join(';')}`,
    ].filter(Boolean).join(' '),
    alert: Number(next.badStreak ?? 0) >= 2,
    state: next,
  }
}

/**
 * 三期 A5：dream 收尾那轮跑一次 `soul_tier preview`，结果只写 `soul.log`（`tier=名单/超线/字符`）。
 * 7 天一次（`stateDir/tier-state.json` 记上次时间）；**只 preview，不落库** —— apply 只能人工触发。
 */
