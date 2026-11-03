#!/usr/bin/env node
/**
 * dsh-soul 自测（MVP）。对应交办单 §8 的断言 1–4、11，另加三条本地加固。
 * 全部用自建靶子（%TEMP% 下一次性目录 + 临时 SQLite 库），不碰真实会话与真实库（§9.8）。
 *
 * 复跑：node check.mjs（夹具路径一律 os.tmpdir() 派生，不指向任何本机目录）
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 一次性夹具工作区：从 tmpdir 派生，绝不写本机真实目录。 */
const FIXTURE_WS = join(tmpdir(), 'dsh-soul-check-ws')

import {
  TOTAL_TOKENS,
  HARD_SOUL_TOKENS,
  composeSoul,
  SOUL_STAGES,
  createPreStepHandler,
  createRecall,
  createPersist,
  createTools,
  estimateTokens,
  measureInjections,
  measureRequestBudget,
  normalizeConfig,
  parseSoul,
  planBudget,
  countSnapshots,
  detectSnapshotDrift,
  maybeRunProbe,
  pickProbeWords,
  planSnapshotPrune,
  readProbeState,
  runProbes,
  snapshotMetaOf,
  rememberUserTexts,
  recentUserQuery,
  createTier,
  maybeLogTier,
  resolveWorkspace,
  RELATIONS_CAP,
  readMood,
  readRelations,
  readSoul,
  createMemoryBackend,
} from './index.js'

import { putMemory } from './memory-builtin.mjs'
import { ZONES, buildZoneIndex, scanZones, writeZoneIndex } from './zones.mjs'

import { cueStats, readCueMap, runCue } from './cue.mjs'
import { createCapabilities } from './index.js'
import { GAMEDEV_STOP, GAMEDEV_ZH } from './gamedev.mjs'
import { budgetTokensOfChars, planForDb, resolveTierBudget, scoreParts } from './tier.mjs'
import { planToolOutputs, restoreFromExport, runToolout } from './toolout.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-soul-check-'))
const results = []
let failed = 0

async function test(id, title, fn) {
  try {
    const detail = await fn()
    results.push({ id, title: title, ok: true, detail: String(detail ?? '') })
  } catch (error) {
    failed += 1
    results.push({ id, title: title, ok: false, detail: String(error?.message ?? error) })
  }
}

function write(relPath, text) {
  const target = join(root, relPath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
  return target
}

// ---------------------------------------------------------------------------
// 靶子：soul.md / 笔记 / 封存段 / 记忆库
// ---------------------------------------------------------------------------

const soulOk = write(
  'soul/soul.md',
  [
    '# 示例人格',
    '',
    '## 我是谁',
    '- 我叫示例助手，用户叫我小助手',
    '- 说话直接，不用敬语',
    '- 简体中文',
    '',
    '## 我怎么想',
    '- 先取证再动手',
    '',
    '## 我不做什么',
    '- 不物理注入鼠标键盘',
    '',
    '## 反哺记录',
    '- 2026-10-24 被纠正：别把未验证写成已修复',
    '',
  ].join('\n'),
)

const soulBloated = write(
  'soul/big.md',
  [
    '## 我是谁',
    `- ${'称呼很多字'.repeat(40)}`,
    `- ${'语气三档很多字'.repeat(40)}`,
    `- ${'界线很多字'.repeat(40)}`,
    '## 我怎么想',
    `- ${'认知倾向很多字'.repeat(40)}`,
    '## 我不做什么',
    `- ${'硬界线很多字'.repeat(40)}`,
  ].join('\n'),
)

const notesDir = join(root, 'notes')
write('notes/sub/2026-10-20-manifest.md', '今天定了：封存 manifest 是 append-only，后行覆盖前行。\n第二行无关内容。\n')

const archiveRoot = join(root, 'archive')
write('archive/sessions/s1/seg-10-12.md', '# 段 10–12\n封存 manifest 与记忆库是两套东西，别混。\n普通一行。\n')
write(
  'archive/manifest.jsonl',
  `${JSON.stringify({
    seg_id: 'seg-10-12',
    session: 's1',
    file: 'sessions/s1/seg-10-12.md',
    from_seq: 10,
    to_seq: 12,
    msg_count: 3,
    topic: '封存 manifest 讨论',
    keywords: ['封存', 'manifest', '归档'],
    sha256: 'deadbeef',
    sealed_at: '2026-10-20T10:00:00+08:00',
  })}\n`,
)

const memoryDbPath = join(root, 'memory.db')
{
  const db = new DatabaseSync(memoryDbPath)
  const tables = {
    soul: 'id text primary key, content text, status text',
    rules: 'id text primary key, content text, status text',
    user: 'id text primary key, content text, status text',
    project: 'id text primary key, content text, status text, project text, subcategory text',
    fact: 'id text primary key, content text, status text, title text, keywords text, project text',
    topic: 'id text primary key, content text, status text, title text, keywords text, goal text',
    lesson: 'id text primary key, content text, status text, title text, keywords text, corrected integer',
  }
  for (const [table, cols] of Object.entries(tables)) db.exec(`create table ${table} (${cols})`)
  db.prepare('insert into lesson (id, content, status, title, keywords, corrected) values (?,?,?,?,?,?)').run(
    'm00042',
    '封存 manifest 后行覆盖前行，别按行数判断段数。',
    'active',
    '封存段 manifest 语义',
    '封存 manifest 覆盖',
    1,
  )
  db.prepare('insert into project (id, content, status, project, subcategory) values (?,?,?,?,?)').run(
    'p00001',
    '把 dsh-soul 的 MVP 跑通',
    'active',
    'dsh',
    'todo',
  )
  db.prepare('insert into fact (id, content, status, title, keywords, project) values (?,?,?,?,?,?)').run(
    'f00001',
    '封存段原文在 archive 目录下',
    'active',
    '封存位置',
    '封存 路径',
    'dsh',
  )
  db.prepare('insert into fact (id, content, status, title, keywords, project) values (?,?,?,?,?,?)').run(
    'f00002',
    '这条没有标题也没有关键词，用来测 cue 留空',
    'active',
    '',
    '',
    '',
  )
  db.close()
}

const config = normalizeConfig({
  soulPath: soulOk,
  notesDir,
  archiveRoot,
  memoryDbPath,
  logPath: join(root, 'logs/soul.log'),
  soulMaxTokens: 200,
  // 2026-11-03 开源化：sealed 源默认不注册（§C），测试要显式打开它才能验封存检索。
  sealedSegmentsModule: 'dsh-sealed-segments',
})

const words = ['封存', 'manifest']

// ---------------------------------------------------------------------------
// §8.1 魂引 token ≤ 400（用超量假数据触发截断）
// ---------------------------------------------------------------------------

await test('§8.1', '魂引硬上限：超量 soul.md 截断后 ≤400 且 ≤200 起步值', () => {
  const soul = parseSoul(readFileSync(soulBloated, 'utf8'))
  const big = composeSoul({ soul, at: new Date('2026-10-24T22:00:00+08:00'), workspace: FIXTURE_WS, maxTokens: HARD_SOUL_TOKENS })
  assert.ok(big.tokens <= HARD_SOUL_TOKENS, `400 上限被突破：${big.tokens}`)
  const small = composeSoul({ soul, at: new Date('2026-10-24T22:00:00+08:00'), workspace: FIXTURE_WS, maxTokens: 200 })
  assert.ok(small.tokens <= 200, `200 起步值被突破：${small.tokens}`)
  assert.ok(small.text.includes('我是谁'), '超量时「我是谁」整条丢了')
  return `400→${big.tokens}tok(${big.stage}) / 200→${small.tokens}tok(${small.stage})`
})

// ---------------------------------------------------------------------------
// §8.2 / §8.3 四类注入合计 ≤700，且让步顺序是 封存目录 → 分区目录
// ---------------------------------------------------------------------------

function fakeMessages() {
  const filler = (label, tokens) => `[${label}]${'占位内容'.repeat(Math.ceil((tokens * 1) / 4))}`
  return [
    {
      id: 'time-1',
      role: 'user',
      content: [{ type: 'text', text: filler('时间行', 60) }],
      source: { kind: 'realtime-clock' },
    },
    {
      id: 'partition-1',
      role: 'user',
      content: [{ type: 'text', text: filler('分区目录', 1200) }],
      source: { kind: 'context-index' },
    },
    {
      id: 'archive-1',
      role: 'user',
      content: [{ type: 'text', text: filler('封存目录', 400) }],
      source: { kind: 'archive-index' },
    },
  ]
}

const fakeDecision = { messages: fakeMessages() }

function fakePayload(turn) {
  return {
    turn,
    step: 1,
    agent: { session: { id: 'check-session', cwd: FIXTURE_WS } },
    messages: [],
    signal: undefined,
  }
}

async function runHandler(handler, turn) {
  return handler(fakePayload(turn), async () => fakeDecision)
}

await test('§8.2', '全部注入 ≤700，且魂引核心（我是谁 / 我不做什么）未被砍', async () => {
  const handler = createPreStepHandler({ config, now: () => new Date('2026-10-24T22:05:00+08:00'), pendingLoader: () => [] })
  const decision = await runHandler(handler, 1)
  const measured = measureInjections(decision.messages)
  // 2026-10-24 决策：enforceBudget 默认 false（不许静默裁掉别人的注入）。≤700 只在打开时成立。
  const enforcing = await runHandler(
    createPreStepHandler({
      config: { ...config, enforceBudget: true },
      now: () => new Date('2026-10-24T22:05:00+08:00'),
      pendingLoader: () => [],
    }),
    1,
  )
  const enforcedTotal = measureInjections(enforcing.messages).total
  assert.ok(enforcedTotal <= TOTAL_TOKENS, `enforceBudget=true 时合计 ${enforcedTotal} > ${TOTAL_TOKENS}`)
  assert.ok(measured.total > TOTAL_TOKENS, `默认 off 时不应裁剪别人（本用例期望超预算，实际 ${measured.total}）`)
  const offSoul = decision.messages
    .filter((m) => m?.source?.kind === 'soul')
    .map((m) => m.content.map((p) => p.text).join(''))
    .join('\n')
  // 2026-10-28 改口径：四类合计那条红字（3881/800）已废——默认 off 时魂引里不该再出现它。
  // 这条守的是**新契约**：别人的账不进魂引，只报自己的常驻快照；核心两节仍不许被砍。
  assert.ok(!/【预算】\d+\/700/.test(offSoul), `四类合计的老红字又回来了：${offSoul.slice(-80)}`)
  assert.ok(!offSoul.includes('固定注入'), `作废的「固定注入 N/800」又回来了：${offSoul.slice(-80)}`)
  assert.ok(offSoul.includes('我是谁') && offSoul.includes('我不做什么'), '魂引核心两节不许被砍')
  const soulText = decision.messages
    .filter((m) => m?.source?.kind === 'soul')
    .map((m) => m.content.map((part) => part.text).join(''))
    .join('')
  assert.ok(soulText.includes('我是谁'), '魂引里没有「我是谁」')
  assert.ok(soulText.includes('我不做什么'), '魂引里没有「我不做什么」')
  return `after=${measured.total}tok per=${JSON.stringify(measured.perClass)}`
})

await test('§8.3', '降级顺序：封存目录 → 分区目录，魂引与时间行永不进砍名单', () => {
  const messageList = [...fakeMessages(), { id: 'soul-1', role: 'user', content: [{ type: 'text', text: '【魂引】' }], source: { kind: 'soul' } }]
  const plan = planBudget(measureInjections(messageList), TOTAL_TOKENS)
  assert.deepEqual(plan.cut, ['archive', 'partition'], `砍名单不对：${JSON.stringify(plan.cut)}`)
  assert.ok(!plan.cut.includes('soul') && !plan.cut.includes('time'), '魂引/时间行进砍名单')
  assert.ok(plan.after <= TOTAL_TOKENS, `让步后仍超：${plan.after}`)
  return `cut=${plan.cut.join('→')} ${plan.before}→${plan.after}tok`
})

// ---------------------------------------------------------------------------
// §8.4 三源都能命中，且带定位
// ---------------------------------------------------------------------------

await test('§8.4', 'soul_recall 三源各 ≥1 条且带定位', async () => {
  const recall = createRecall(config)
  const result = await recall({ query: '封存 manifest', limit: 3 })
  assert.equal(result.ok, true, 'recall 失败')
  assert.ok(result.sources.memory >= 1, '记忆库没命中')
  assert.ok(result.sources.archive >= 1, `封存段没命中：${result.text}`)
  assert.ok(result.sources.notes >= 1, '笔记没命中')
  assert.match(result.text, /记忆库\/lesson#m00042/, '记忆定位不对')
  assert.match(result.text, /封存段\/seg-10-12/, '封存定位不对')
  assert.match(result.text, /2026-10-20-manifest\.md:\d+/, '笔记定位不对')
  assert.ok(result.text.length <= 1200, `输出 ${result.text.length} 字 > 1200`)
  return `memory=${result.sources.memory} archive=${result.sources.archive} notes=${result.sources.notes} chars=${result.text.length}`
})

// ---------------------------------------------------------------------------
// §8.11 每轮一行日志，行数 = 轮次
// ---------------------------------------------------------------------------

await test('§8.11', 'soul.log 每轮一行，行数与轮次一致', async () => {
  const logPath = join(root, 'logs/turn.log')
  rmSync(logPath, { force: true })
  const handler = createPreStepHandler({
    config: normalizeConfig({ ...config, logPath }),
    now: () => new Date('2026-10-24T22:06:00+08:00'),
    pendingLoader: () => [],
  })
  for (let turn = 1; turn <= 3; turn += 1) await runHandler(handler, turn)
  const lines = readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
  assert.equal(lines.length, 3, `日志 ${lines.length} 行 ≠ 3 轮`)
  for (const line of lines) assert.match(line, / inject session=check-session turn=\d+ step=1 /)
  return `3 轮 → ${lines.length} 行`
})

// ---------------------------------------------------------------------------
// 本地加固
// ---------------------------------------------------------------------------

await test('L1', 'soul.md 缺失：不崩，仍注入「现在在哪 / 怎么查」', async () => {
  const missing = normalizeConfig({ ...config, soulPath: join(root, 'soul/missing.md'), logPath: join(root, 'logs/missing.log') })
  const handler = createPreStepHandler({ config: missing, now: () => new Date('2026-10-24T22:07:00+08:00'), pendingLoader: () => [] })
  const decision = await runHandler(handler, 1)
  const soulText = decision.messages.filter((m) => m?.source?.kind === 'soul').map((m) => m.content[0].text).join('')
  assert.ok(soulText.includes('现在在哪'), '缺文件时没有「现在在哪」')
  assert.ok(soulText.includes('怎么查'), '缺文件时没有「怎么查」')
  return `${estimateTokens(soulText)}tok`
})

await test('L2', '极端小预算仍保留「我是谁」（只裁内容，不整条删）', () => {
  const soul = parseSoul(readFileSync(soulBloated, 'utf8'))
  const out = composeSoul({ soul, at: new Date(), workspace: FIXTURE_WS, maxTokens: 40 })
  assert.ok(out.tokens <= 40, `${out.tokens} > 40`)
  assert.ok(out.text.includes('我是谁'), '小预算下「我是谁」丢了')
  return `${out.tokens}tok stage=${out.stage}`
})

await test('L3', '现在在哪：记忆库 todo 进魂引，且只取上限条数', () => {
  const handler = createPreStepHandler({ config, now: () => new Date('2026-10-24T22:08:00+08:00') })
  assert.equal(typeof handler, 'function', '工厂没返回函数')
  const soul = parseSoul(readFileSync(soulOk, 'utf8'))
  const out = composeSoul({
    soul,
    at: new Date('2026-10-24T22:08:00+08:00'),
    workspace: FIXTURE_WS,
    pending: ['把 dsh-soul 的 MVP 跑通', '第二条', '第三条', '第四条'],
    maxTokens: 200,
    pendingMode: 'full',
  })
  assert.ok(out.text.includes('未结：'), '魂引里没有「未结」')
  assert.ok(!out.text.includes('第四条'), '未结超过 3 条没截断')
  // 2026-11-01：默认改成 count 模式——未结只报条数，正文按需 soul_recall。
  const compact = composeSoul({
    soul,
    at: new Date('2026-10-24T22:08:00+08:00'),
    workspace: FIXTURE_WS,
    pending: ['把 dsh-soul 的 MVP 跑通', '第二条', '第三条', '第四条'],
    maxTokens: 200,
    pendingMode: 'count',
  })
  assert.ok(/未结 4 条 → soul_recall\('未结'\)/.test(compact.text), 'count 模式没只报条数')
  return out.stage
})


await test('L4', '工作区取会话头 cwd（不落到宿主 profile 目录）', () => {
  const header = resolveWorkspace({ agent: { session: { id: 's', header: { cwd: FIXTURE_WS } } } })
  assert.equal(header, FIXTURE_WS, `header.cwd 没被采纳：${header}`)
  const legacy = resolveWorkspace({ agent: { session: { id: 's', cwd: 'D:\\project' } } })
  assert.equal(legacy, 'D:\\project', `session.cwd 兜底失效：${legacy}`)
  const override = resolveWorkspace({ agent: { session: { header: { cwd: FIXTURE_WS } } } }, { workspace: 'F:\\x' })
  assert.equal(override, 'F:\\x', '显式 workspace 没优先')
  return `${header} / ${legacy} / ${override}`
})
// ---------------------------------------------------------------------------
// 二期模块 A：cue 化（§6.2 干跑不动库 / §6.3 真跑有数据且 recall 仍命中）
// ---------------------------------------------------------------------------

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

await test('A1', 'soul_cue preview：库字节不变、不建 cue 表、报「有 N / 留空 M」与示例', () => {
  const before = sha256File(memoryDbPath)
  const result = runCue(memoryDbPath, join(root, 'state-a'), { mode: 'preview', limit: 10 })
  assert.equal(result.ok, true, `preview 失败：${result.text}`)
  assert.equal(sha256File(memoryDbPath), before, 'preview 改动了库字节')
  const db = new DatabaseSync(memoryDbPath, { readOnly: true })
  const created = db.prepare("select name from sqlite_master where type='table' and name='cue'").all().length
  db.close()
  assert.equal(created, 0, 'preview 建了 cue 表')
  assert.ok(result.stats.total >= 3, `总条数不对：${result.stats?.total}`)
  assert.ok(result.stats.empty >= 1, '没有识别出凑不满 3 词的条目')
  assert.match(result.text, /有 \d+ 条、留空 \d+ 条/, '输出里没有「有 N 条 / 留空 M 条」')
  assert.match(result.text, /· fact#f0000\d → /, '没有示例行')
  return `total=${result.stats.total} withCue=${result.stats.withCue} empty=${result.stats.empty} sha256 未变`
})

await test('A2', 'soul_cue append：先备份再写、cue 表有数据、未空条目仍报留空', () => {
  const result = runCue(memoryDbPath, join(root, 'state-b'), { mode: 'append', limit: 10 })
  assert.equal(result.ok, true, `append 失败：${result.text}`)
  assert.ok(result.backup, '没有备份路径')
  assert.ok(existsSync(result.backup), `备份文件不存在：${result.backup}`)
  assert.ok(readFileSync(result.backup).length > 0, '备份是空文件')
  const stats = cueStats(memoryDbPath)
  assert.ok(stats.total >= 2, `cue 表行数太少：${stats.total}`)
  const db = new DatabaseSync(memoryDbPath, { readOnly: true })
  const map = readCueMap(db)
  db.close()
  assert.ok(map && map.size >= 2, 'readCueMap 读不到新写的 cue')
  return `backup=${result.backup.split(/[\\/]/).pop()} rows=${stats.total}`
})

await test('A3', 'cue 生效后 soul_recall 走 cue 路径仍能命中，且命中带正文摘要', async () => {
  const recall = createRecall(config)
  const result = await recall({ query: '封存 manifest', limit: 3 })
  assert.equal(result.ok, true, 'recall 失败')
  assert.ok(result.sources.memory >= 1, `cue 路径没命中记忆：${result.text}`)
  assert.match(result.text, /记忆库\/lesson#m00042/, '定位不对')
  assert.ok(result.text.includes('后行覆盖前行'), '摘要里没有正文片段')
  return `memory=${result.sources.memory} chars=${result.text.length}`
})

// ---------------------------------------------------------------------------
// 二期模块 B：工具输出归档（§6.4 干跑 / §6.5 真跑 / §6.6 回滚演练）
// ---------------------------------------------------------------------------

const tooloutDb = join(root, 'bili/index.db')
{
  mkdirSync(dirname(tooloutDb), { recursive: true })
  const db = new DatabaseSync(tooloutDb)
  db.exec('create table content (hash text primary key, byte_len integer not null, refcount integer not null default 0, algo text not null default \'sha256\', bytes blob not null)')
  db.exec('create table messages (session_id text not null, seq integer not null, msg_id text not null, ref text, ref_num integer, role text not null, kind text not null default \'message\', content_hash text not null, primary key (session_id, seq))')
  db.exec('create table blocks (block_id text primary key, session_id text, ord integer, start_seq integer, end_seq integer, tier integer, payload_json text)')
  const put = (seq, role, kind, msgId, text) => {
    const buf = Buffer.from(text, 'utf8')
    const hash = createHash('sha256').update(buf).digest('hex')
    db.prepare('insert or ignore into content (hash, byte_len, refcount, bytes) values (?,?,?,?)').run(hash, buf.length, 1, buf)
    db.prepare('insert into messages (session_id, seq, msg_id, ref, role, kind, content_hash) values (?,?,?,?,?,?,?)').run(
      's-toolout', seq, msgId, `m0000${seq}`, role, kind, hash,
    )
    return hash
  }
  for (const seq of [1, 4, 6, 8, 10, 12]) put(seq, 'user', 'text', `u${seq}`, `第 ${seq} 轮的用户消息，用来当 turn 分界`)
  put(2, 'tool', 'tool-result', 't2', '短输出，不该被动')
  const bigA = `工具输出 A：${'文件内容行'.repeat(200)}`
  const bigB = `工具输出 B：${'构建日志行'.repeat(200)}`
  put(3, 'tool', 'tool-result', 't3', bigA)
  put(5, 'tool', 'tool-result', 't5', bigB)
  put(11, 'tool', 'tool-result', 't11', `最近一轮的工具输出：${'近的'.repeat(300)}`)
  db.close()
}

await test('B1', 'soul_toolout preview：只报数、库字节不变、近 N 轮与短文不动', () => {
  const before = sha256File(tooloutDb)
  const result = runToolout(tooloutDb, join(root, 'archive'), { mode: 'preview', sessionId: 's-toolout', recentTurns: 3, minChars: 400 })
  assert.equal(result.ok, true, `preview 失败：${result.text}`)
  assert.equal(sha256File(tooloutDb), before, 'preview 改动了库字节')
  assert.equal(result.stats.segments, 2, `应挑出 2 段，实际 ${result.stats.segments}`)
  assert.match(result.text, /将归档 2 段 \/ 共 \d+ 字符 \/ 预计省 \d+ tok/, '输出措辞不对')
  assert.ok(!result.text.includes('seq=2'), '短文不该进清单')
  assert.ok(!result.text.includes('seq=11'), '最近一轮不该进清单')
  return `${result.text.split('\n')[0].replace(/^【[^】]+】/, '')}`
})

await test('B2', 'soul_toolout apply：先备份、导出原文、换成一指针、没有 DELETE', () => {
  const before = sha256File(tooloutDb)
  const result = runToolout(tooloutDb, join(root, 'archive'), { mode: 'apply', confirm: true, sessionId: 's-toolout', recentTurns: 3, minChars: 400 })
  assert.equal(result.ok, true, `apply 失败：${result.text}`)
  assert.ok(result.backup && existsSync(result.backup), '没有整库备份')
  const exported = readdirSync(join(root, 'archive', 'toolout'))
  assert.equal(exported.length, 2, `导出文件数不对：${exported.length}`)
  const db = new DatabaseSync(tooloutDb, { readOnly: true })
  const rows = db.prepare("select seq, c.bytes as bytes from messages m join content c on c.hash = m.content_hash where m.session_id = 's-toolout' and seq in (3,5)").all()
  const total = db.prepare("select count(*) as n from messages where session_id = 's-toolout'").get().n
  const contents = db.prepare('select count(*) as n from content').get().n
  db.close()
  assert.equal(total, 10, `消息行数变了（不许 DELETE）：${total}`)
  assert.ok(contents >= 9, '指针 content 行没插入')
  for (const row of rows) {
    const text = Buffer.from(row.bytes).toString('utf8')
    assert.ok(text.startsWith('[工具输出已归档]'), `seq=${row.seq} 没换成指针：${text.slice(0, 40)}`)
  }
  assert.ok(sha256File(tooloutDb) !== before, 'apply 后库字节没变化')
  return `${result.stats.tokens}tok / backup=${result.backup.split(/[\\/]/).pop()} / files=${exported.length}`
})

await test('B3', 'soul_toolout restore：按导出文件把原文塞回去（回滚演练）', () => {
  const dir = join(root, 'archive', 'toolout')
  const file = readdirSync(dir).find((name) => name.includes('-3.md'))
  assert.ok(file, '找不到 seq=3 的导出文件')
  const restored = restoreFromExport(tooloutDb, join(dir, file))
  assert.equal(restored.ok, true, `restore 失败：${restored.error}`)
  const db = new DatabaseSync(tooloutDb, { readOnly: true })
  const row = db.prepare("select c.bytes as bytes from messages m join content c on c.hash = m.content_hash where m.session_id = 's-toolout' and seq = 3").get()
  db.close()
  const text = Buffer.from(row.bytes).toString('utf8')
  assert.ok(text.startsWith('工具输出 A：'), `原文没塞回去：${text.slice(0, 30)}`)
  assert.ok(text.includes('文件内容行'.repeat(3)), '原文内容不完整')
  return `seq=3 恢复 ${restored.chars} 字符`
})

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

await test('§7.1', 'soul_persist：只追加第四节、先预览、落盘留备份、按 id 去重', async () => {
  const dbPath = join(root, 'soul-persist.db')
  const db = new DatabaseSync(dbPath)
  db.exec(
    'create table lesson(id text, title text, content text, importance integer, keywords text, status text, source_session text, hit_count integer, created_at integer, updated_at integer, last_accessed_at integer, corrected integer, project text)',
  )
  db.prepare('insert into lesson values(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'abcdef12-0000-0000-0000-000000000000', '关于：测试教训', '', 1, '', 'active', '', 0,
    Date.now(), Date.now(), 0, 1, '全局',
  )
  db.close()

  const soulPath = join(root, 'soul-persist.md')
  const head = '# T\n\n## 我是谁\n- a\n\n## 反哺记录\n'
  writeFileSync(soulPath, head, 'utf8')
  const persist = createPersist({ soulPath, memoryDbPath: dbPath })

  const pre = await persist({})
  assert.equal(pre.pending, 1, '预览应看到 1 条待追加')
  assert.equal(readFileSync(soulPath, 'utf8'), head, '预览不许写盘')

  const app = await persist({ mode: 'append', limit: 5 })
  const after = readFileSync(soulPath, 'utf8')
  assert.equal(app.added, 1, '应追加 1 条')
  assert.ok(after.startsWith(head), '前三节不许被改写')
  assert.ok(after.includes('abcdef12'), '缺来源 id')
  assert.ok(readdirSync(root).some((f) => f.includes('bak-persist')), '落盘前必须备份')

  const again = await persist({})
  assert.equal(again.pending, 0, '追加后应去重到 0')
  return '预览不写盘 / 追加 1 条 / 前三节未动 / 已备份 / 去重到位'
})

// ---------------------------------------------------------------------------
await test('B4', 'soul_toolout apply 不带 confirm 时拒绝写库', () => {
  const result = runToolout(tooloutDb, join(root, 'archive'), { mode: 'apply', sessionId: 's-toolout', recentTurns: 3, minChars: 400 })
  assert.equal(result.ok, false, '没 confirm 也写了')
  assert.match(result.text, /【拒绝】/, '拒绝文案不对')
  return 'rejected without confirm'
})

// 模块 C：能力清单与建议（靶子 = 假插件目录 + 假代理库）
// ---------------------------------------------------------------------------

const capPlugins = join(root, 'plugins')
for (const [plugin, prefix] of [['dsh-alpha', 'alpha'], ['dsh-beta', 'beta'], ['dsh-gamma', 'gamma']]) {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((letter) => `${prefix}_${letter}`)
  write(`plugins/${plugin}/index.js`, names.map((tool) => `  ctx.tools.register({ name: '${tool}' })\n`).join(''))
}
const capBili = join(root, 'capbili', 'index.db')
{
  mkdirSync(dirname(capBili), { recursive: true })
  const db = new DatabaseSync(capBili)
  db.exec('create table sessions (session_id text primary key, created_at integer)')
  db.exec('create table content (hash text primary key, byte_len integer, refcount integer, algo text, bytes blob)')
  db.exec('create table messages (session_id text, seq integer, msg_id text, ref text, role text, kind text, content_hash text)')
  db.prepare('insert into sessions (session_id, created_at) values (?, ?)').run('s1', Math.floor(Date.now() / 1000))
  let seq = 0
  for (const [tool, times] of [['alpha_a', 25], ['alpha_b', 12], ['alpha_c', 3], ['alpha_d', 1]]) {
    for (let index = 0; index < times; index += 1) {
      seq += 1
      const hash = `h${seq}`
      const text = JSON.stringify({ role: 'assistant', contentType: 'tool-call', toolName: tool })
      db.prepare('insert into content (hash, byte_len, refcount, algo, bytes) values (?,?,?,?,?)').run(hash, Buffer.byteLength(text), 1, 'none', Buffer.from(text, 'utf8'))
      db.prepare('insert into messages (session_id, seq, msg_id, ref, role, kind, content_hash) values (?,?,?,?,?,?,?)').run('s1', seq, `m${seq}`, `r${seq}`, 'assistant', 'text', hash)
    }
  }
  db.close()
}

const capConfig = normalizeConfig({
  ...config,
  capabilitiesPath: join(root, 'notes/capabilities.md'),
  biliDbPath: capBili,
  pluginRoots: [capPlugins],
  stateDir: join(root, 'state'),
  logPath: join(root, 'logs/cap.log'),
})
const capabilities = createCapabilities({ config: capConfig })

await test('C1', 'soul_capabilities 清单：≥20 行、每行带调用次数与建议、write 才落盘', () => {
  const result = capabilities({ write: true })
  assert.equal(result.ok, true, '清单失败')
  assert.ok(result.rows >= 20, `只有 ${result.rows} 个工具`)
  assert.ok(existsSync(capConfig.capabilitiesPath), '清单文件没写出来')
  const text = readFileSync(capConfig.capabilitiesPath, 'utf8')
  const rows = text.split(/\r?\n/).filter((line) => /^\| .+ \| .+ \| \d+ \|/.test(line))
  assert.ok(rows.length >= 20, `表里只有 ${rows.length} 行`)
  assert.match(text, /\| alpha_a \| dsh-alpha \| 25 \| 常驻 \|/, '调用最多的工具行不对')
  assert.match(text, /\| alpha_d \| dsh-alpha \| 1 \| 按需 \|/, '1 次的工具行不对')
  assert.match(text, /\| beta_a \| dsh-beta \| 0 \| 按需（候选） \|/, '0 次的工具行不对')
  return `${result.rows} 个工具 / ${rows.length} 行表`
})

await test('C2', 'soul_capabilities 建议：按查询词给 3–5 个候选工具名', () => {
  const memory = capabilities({ query: '记忆检索' })
  assert.equal(memory.ok, true, '建议失败')
  assert.match(memory.text, /soul_recall/, '记忆类查询没给 soul_recall')
  const found = /候选 (\d+) 个/.exec(memory.text)
  const names = Number(found?.[1] ?? 0)
  assert.ok(names >= 3 && names <= 5, `候选数 ${names} 不在 3–5`)
  const edit = capabilities({ query: '改文件写代码' })
  assert.match(edit.text, /edit/, '改文件类查询没给编辑类工具')
  return `记忆→${names} 个候选；改文件→命中`
})

// ---------------------------------------------------------------------------
// D：工具 execute 的返回契约（宿主按 output.schema 校验；undefined / 多出来的键都会炸）
// 2026-10-25 真实事故：preview 时把 undefined 塞进 backup（schema 声明 string）
// → 宿主报 `invalid output / must be a string`，而按旧自测全绿，因为只测了 runCue()。
// ---------------------------------------------------------------------------

function assertLossless(value, name, path = name) {
  if (value === undefined) throw new Error(`${path} 出现 undefined（不是无损 JSON）`)
  if (typeof value === 'function') throw new Error(`${path} 是函数（不是无损 JSON）`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} 是 ${value}`)
  if (Array.isArray(value)) return value.forEach((item, index) => assertLossless(item, name, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertLossless(item, name, `${path}.${key}`)
  }
}

function assertSchemaValue(schema, value, path) {
  if (value === undefined) throw new Error(`${path} 缺值（undefined）`)
  if (value === null) throw new Error(`${path} 是 null（schema 没声明可空）`)
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  const matches = (type) => {
    if (type === 'object') return typeof value === 'object' && !Array.isArray(value)
    if (type === 'array') return Array.isArray(value)
    if (type === 'integer') return Number.isInteger(value)
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    if (type === 'string') return typeof value === 'string'
    if (type === 'boolean') return typeof value === 'boolean'
    return true
  }
  if (types.length > 0 && !types.some(matches)) {
    throw new Error(`${path} 类型是 ${Array.isArray(value) ? 'array' : typeof value}，schema 要 ${types.join('|')}`)
  }
  if (types.includes('object') && value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const sub = schema.properties?.[key]
      if (!sub) {
        if (schema.additionalProperties === false) throw new Error(`${path}.${key} 不在 schema 里（additionalProperties:false）`)
        continue
      }
      assertSchemaValue(sub, item, `${path}.${key}`)
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) throw new Error(`${path}.${key} 缺失（required）`)
    }
  }
}

await test('D1', '九个工具的 execute：无损 JSON + 合 output.schema（不许 undefined/null 塞非 nullable 键）', async () => {
  const toolConfig = normalizeConfig({
    ...config,
    biliDbPath: tooloutDb,
    capabilitiesPath: join(root, 'notes/caps-d1.md'),
    pluginRoots: [capPlugins],
    stateDir: join(root, 'state-d1'),
    logPath: join(root, 'logs/d1.log'),
  })
  const tools = createTools(toolConfig)
  assert.equal(tools.length, 9, `工具数 ${tools.length} ≠ 9`)
  const calls = {
    soul_recall: { query: '封存 manifest', limit: 1 },
    soul_persist: { mode: 'preview', limit: 1 },
    soul_toolout: { mode: 'preview', sessionId: 's-toolout', recentTurns: 3, minChars: 400, limit: 1 },
    soul_cue: { mode: 'preview', limit: 1 },
    soul_capabilities: { query: '记忆检索', limit: 3 },
    soul_tier: { mode: 'preview', budgetTokens: 600, limit: 3 },
    // 没接 sessions 服务时也要给得出话（不能抛）
    soul_surface: { mode: 'preview' },
    soul_relations: { limit: 2 },
    soul_mood: {},
  }
  const details = []
  for (const tool of tools) {
    const args = calls[tool.name]
    assert.ok(args, `没给 ${tool.name} 准备调用参数`)
    const value = await tool.execute(args)
    assertLossless(value, tool.name)
    assertSchemaValue(tool.output.schema, value, tool.name)
    const rendered = tool.output.render(args, value)
    assert.ok(rendered?.[0]?.text?.length > 0, `${tool.name} 的 render 没输出文本`)
    details.push(`${tool.name}✓`)
  }
  // 反证：把当初那个 bug 原样塞回去，断言必须抓到（否则这条测试是空的）
  assert.throws(() => assertLossless({ ok: true, text: 'x', backup: undefined }, 'fake'), /undefined/)
  return details.join(' ')
})

// ---------------------------------------------------------------------------
// 三期 C：能力建议「不瞎凑」+ 自动取词（最近 2 条 user 消息）
// ---------------------------------------------------------------------------

await test('C3', 'soul_capabilities 自动取词：不传 query 时用最近 2 条 user 消息，无命中说「无相关能力」', () => {
  rememberUserTexts(['这张截图你帮我看下', '顺便把之前的会话翻出来'])
  const auto = capabilities({})
  assert.match(auto.text, /自动取自最近 2 条 user 消息/, '没走自动取词')
  assert.match(auto.text, /read_image/, '截图类没给 read_image')
  assert.match(auto.text, /session_search/, '会话类没给 session_search')
  const hit = /候选 (\d+) 个/.exec(auto.text)
  assert.ok(hit, `没报候选数：${auto.text}`)
  assert.ok(Number(hit[1]) <= 5, `候选超过 5：${hit[1]}`)
  rememberUserTexts(['zzz', 'qwerty 没有关键词'])
  const none = capabilities({})
  assert.match(none.text, /无相关能力/, `无命中时没说「无相关能力」：${none.text}`)
  assert.doesNotMatch(none.text, /候选 \d+ 个/, '无命中时还硬凑了候选')
  const explicit = capabilities({ query: '封存 归档' })
  assert.match(explicit.text, /archive_search/, '显式 query 没生效')
  assert.doesNotMatch(explicit.text, /自动取自/, '显式 query 被自动取词覆盖了')
  rememberUserTexts([])
  assert.equal(recentUserQuery(), '', '清空后仍有残留')
  return '自动→read_image+session_search；无命中→无相关能力；显式 query 优先'
})

await test('C4', '10 个真实任务词：命中 ≥7，且不许出现不相关工具', () => {
  const cases = [
    { q: '帮我改一下这段代码，加个补丁', want: 'edit', ban: 'web_search' },
    { q: '写日记，记一下今天的事', want: 'write', ban: 'schedule_create' },
    { q: '装个插件，看看 plugin_manager 能用吗', want: 'plugin_manager', ban: 'read_image' },
    { q: '这张截图你看了吗', want: 'read_image', ban: 'memory_search' },
    { q: '在 QQ 上跟朋友说一声', want: 'qq-say', ban: 'archive_search' },
    { q: '把之前的会话找出来', want: 'session_search', ban: 'send_sticker' },
    { q: '这个网页讲什么，抓一下', want: 'read_url', ban: 'soul_tier' },
    { q: '搜一下记忆里有没有这条', want: 'soul_recall', ban: 'plugin_manager' },
    { q: '明天九点提醒我', want: 'schedule_create', ban: 'read_image' },
    { q: '把这堆工具输出清一清，省点 token', want: 'soul_toolout', ban: 'qq-say' },
  ]
  const misses = []
  for (const item of cases) {
    const out = capabilities({ query: item.q })
    if (!out.text.includes(item.want)) misses.push(`${item.q}→缺${item.want}`)
    if (out.text.includes(item.ban)) misses.push(`${item.q}→混入${item.ban}`)
    const count = Number(/候选 (\d+) 个/.exec(out.text)?.[1] ?? 0)
    if (count > 5) misses.push(`${item.q}→候选${count}个`)
  }
  assert.equal(misses.length, 0, misses.join('；'))
  return `${cases.length}/${cases.length} 命中且无混入`
})

// ---------------------------------------------------------------------------
// 三期 A：常驻名单（沉底分）+ preview 只读 + apply 备份/降权/回滚
// ---------------------------------------------------------------------------

const tierDir = join(root, 'tier')
const tierDbPath = join(tierDir, 'memory.db')
mkdirSync(tierDir, { recursive: true })
{
  const db = new DatabaseSync(tierDbPath)
  const cols = 'id text primary key, title text, content text, importance integer not null default 1, keywords text not null default \'[]\', status text not null default \'active\', source_session text, hit_count integer not null default 0, created_at integer not null, updated_at integer not null, last_accessed_at integer'
  for (const table of ['soul', 'user']) db.exec(`create table ${table} (${cols})`)
  db.exec(`create table rules (${cols}, project text)`)
  const now = Date.now()
  const day = 86_400_000
  const insert = (table, row) => {
    const keywords = JSON.stringify(row.keywords ?? [])
    const hitCount = row.hit_count ?? 0
    const createdAt = now - 100 * day
    const updatedAt = now - 50 * day
    const lastAccessed = row.last_accessed_at ?? null
    if (table === 'rules') {
      db.prepare(
        'insert into rules (id, content, importance, keywords, hit_count, created_at, updated_at, last_accessed_at, project) values (?,?,?,?,?,?,?,?,?)',
      ).run(row.id, row.content, row.importance, keywords, hitCount, createdAt, updatedAt, lastAccessed, row.project ?? null)
      return
    }
    db.prepare(
      `insert into ${table} (id, content, importance, keywords, hit_count, created_at, updated_at, last_accessed_at) values (?,?,?,?,?,?,?,?)`,
    ).run(row.id, row.content, row.importance, keywords, hitCount, createdAt, updatedAt, lastAccessed)
  }
  insert('soul', { id: 's1', content: '我是示例助手，喊我小助手', importance: 3 })
  insert('user', { id: 'u1', content: '直接执行，别铺垫，结论在前', importance: 4, hit_count: 6, last_accessed_at: now - 3 * day })
  insert('user', { id: 'u2', content: '很久以前的一条老规矩', importance: 1, last_accessed_at: now - 200 * day })
  insert('user', { id: 'u3', content: `长偏好：${'要多写细节。'.repeat(120)}`, importance: 1 })
  insert('rules', { id: 'r1', content: '全局规则甲：先取证再动手', importance: 3, hit_count: 2, last_accessed_at: now - 10 * day, project: '全局' })
  insert('rules', { id: 'r2', content: '全局规则乙：未验证不写成已修复', importance: 2, last_accessed_at: now - 200 * day, project: null })
  insert('rules', { id: 'r3', content: '全局规则丙 importance=1 不进常驻', importance: 1, project: '全局' })
  insert('rules', { id: 'r4', content: '项目规则：只有 dsh 项目才注入', importance: 3, project: 'dsh' })
  insert('rules', { id: 'r5', content: `长规则：${'必须留证据。'.repeat(90)}`, importance: 3, project: '' })
  insert('rules', { id: 'r6', content: '全局规则丁：corrected 加分', importance: 4, project: 'global' })
  db.close()
}

const tierConfig = normalizeConfig({
  ...config,
  memoryDbPath: tierDbPath,
  stateDir: join(root, 'state-tier'),
  logPath: join(root, 'logs/tier.log'),
  tierBudgetTokens: 600,
})
const tier = createTier({ config: tierConfig })

await test('A1', 'soul_tier preview：口径照 buildInjectionBody、名单 ≤600tok、分数可复算、库字节不变', () => {
  const before = sha256File(tierDbPath)
  const result = tier({ mode: 'preview', budgetTokens: 600 })
  assert.equal(result.ok, true, `preview 失败：${result.text}`)
  assert.equal(sha256File(tierDbPath), before, 'preview 动了库')
  const plan = planForDb(tierDbPath, { budgetTokens: 600 })
  assert.equal(plan.ok, true, '读库失败')
  const ids = plan.rows.map((row) => row.id)
  assert.ok(!ids.includes('r4'), '项目规则 r4 不该进常驻（非全局 scope）')
  assert.ok(!ids.includes('r3'), 'importance<2 的规则 r3 不该进常驻')
  assert.ok(ids.includes('r6') && ids.includes('r5') && ids.includes('r2'), '全局 rules 漏了')
  assert.ok(plan.chars <= plan.budgetChars, `名单 ${plan.chars} 字超预算 ${plan.budgetChars}`)
  for (const row of plan.overflow) {
    assert.ok(plan.chars + row.chars > plan.budgetChars, `${row.id} 本来塞得下却被判超线`)
  }
  for (const row of plan.rows) {
    const again = scoreParts(row, Date.now())
    assert.equal(again.score, row.score, `${row.id} 分数不可复算：${again.score} ≠ ${row.score}`)
  }
  assert.match(result.text, /超线 \d+ 条/, '没报超线条数')
  assert.match(result.text, /降 importance 能移出常驻的 \d+ 条/, '没报降权有效性')
  return `${plan.rows.length} 条 / ${plan.totalChars} 字 ≈ ${plan.tokens}tok；名单 ${plan.listed.length} 条 / ${plan.listedTokens}tok`
})

await test('A2', 'soul_tier apply：不带 confirm 只读拒绝；带 confirm 先备份、只降权不删改 content、给回滚 SQL', () => {
  const before = sha256File(tierDbPath)
  const rejected = tier({ mode: 'apply', budgetTokens: 400 })
  assert.equal(rejected.ok, false, 'apply 没 confirm 竟然通过了')
  assert.equal(sha256File(tierDbPath), before, '被拒绝的 apply 改了库')

  const plan = planForDb(tierDbPath, { budgetTokens: 400 })
  const snapshot = () => {
    const db = new DatabaseSync(tierDbPath, { readOnly: true })
    const out = {}
    for (const table of ['soul', 'user', 'rules']) {
      for (const row of db.prepare(`select id, content, importance, keywords from ${table}`).all()) {
        out[`${table}/${row.id}`] = { content: row.content, importance: row.importance, keywords: row.keywords }
      }
    }
    db.close()
    return out
  }
  const stateBefore = snapshot()
  const applied = tier({ mode: 'apply', budgetTokens: 400, confirm: true })
  assert.equal(applied.ok, true, `apply 失败：${applied.text}`)
  assert.ok(existsSync(applied.backup), `备份不存在：${applied.backup}`)
  assert.ok(applied.changes > 0, '一条都没降权')
  const stateAfter = snapshot()
  for (const key of Object.keys(stateBefore)) assert.equal(stateAfter[key].content, stateBefore[key].content, `${key} 的 content 被改了`)
  const overflowRules = plan.overflow.filter((row) => row.level === 'rules')
  assert.ok(overflowRules.length > 0, '这条用例没造出 rules 超线条目')
  for (const row of overflowRules) {
    const after = stateAfter[`rules/${row.id}`]
    assert.equal(Number(after.importance), Math.max(1, row.importance - 1), `rules/${row.id} 没降权`)
    assert.ok(JSON.parse(after.keywords).includes('沉底'), `rules/${row.id} 没打沉底标记`)
  }
  for (const row of plan.overflow.filter((item) => item.level === 'user')) {
    assert.equal(Number(stateAfter[`user/${row.id}`].importance), row.importance, `user/${row.id} 不该降 importance`)
    assert.ok(JSON.parse(stateAfter[`user/${row.id}`].keywords).includes('沉底'), `user/${row.id} 没打沉底标记`)
  }
  assert.ok(applied.sql.split('\n').filter(Boolean).length >= 1, '没给回滚 SQL')
  const rollback = new DatabaseSync(tierDbPath)
  for (const line of applied.sql.split('\n')) if (line.trim()) rollback.exec(line)
  rollback.close()
  const stateRolled = snapshot()
  for (const key of Object.keys(stateBefore)) {
    assert.equal(Number(stateRolled[key].importance), Number(stateBefore[key].importance), `${key} 回滚后 importance 不对`)
    assert.equal(stateRolled[key].keywords, stateBefore[key].keywords, `${key} 回滚后 keywords 不对`)
  }
  return `降权 ${applied.changes} 条 / 回滚 SQL 还原成功`
})

await test('A3', 'dream 收尾自动跑 tier preview：7 天才一次、只写日志不落库', () => {
  const stateDir = join(root, 'state-tier-hook')
  const logPath = join(root, 'logs/tier-hook.log')
  const hookConfig = { ...tierConfig, stateDir, logPath }
  const first = maybeLogTier(hookConfig, new Date('2026-10-28T12:00:00Z'), true)
  assert.match(first, /^tier=名单\d+\/超线\d+\/字符\d+$/, `日志格式不对：${first}`)
  const again = maybeLogTier(hookConfig, new Date('2026-10-30T12:00:00Z'), true)
  assert.equal(again, '', '7 天内又跑了一次')
  const noDream = maybeLogTier(hookConfig, new Date('2026-11-20T12:00:00Z'), false)
  assert.equal(noDream, '', '非 dream 轮不该跑')
  const weekly = maybeLogTier(hookConfig, new Date('2026-11-20T12:00:00Z'), true)
  assert.match(weekly, /^tier=/, '过了 7 天却没跑')
  return `首跑「${first}」；7 天内跳过；非 dream 跳过；到期再跑`
})

// ---------------------------------------------------------------------------
// 八期 T1：预算单一来源（meow 同源，不许再各自维护常数）
// ---------------------------------------------------------------------------

await test('A4', 'T1 预算来源：显式传参 → profile injectBudgetChars（2200 字≈1538 tok）→ meow 默认 1400 → 兜底 600', () => {
  const dir = join(root, 'profiles')
  mkdirSync(dir, { recursive: true })
  const withBudget = join(dir, 'cordis.patch.yml')
  writeFileSync(
    withBudget,
    [
      '- id: meow-memory',
      '  name: meow-memory',
      '  config:',
      '      injectBudgetChars: 2200',
      "      injectPinIds: 'p1,p2,p3'",
      '',
    ].join('\n'),
    'utf8',
  )
  const noBudget = join(dir, 'cordis-no-budget.yml')
  writeFileSync(noBudget, ['- id: meow-memory', '  name: meow-memory', '  config:', '      enabled: true', ''].join('\n'), 'utf8')

  const fromMeow = resolveTierBudget({ configPaths: [withBudget] })
  assert.equal(fromMeow.source, 'meow')
  assert.equal(fromMeow.chars, 2200)
  assert.equal(fromMeow.tokens, 1538, `2200 字应换算成 1538 tok，实得 ${fromMeow.tokens}`)
  assert.deepEqual(fromMeow.pinIds, ['p1', 'p2', 'p3'], `pin id 没解析出来：${JSON.stringify(fromMeow.pinIds)}`)

  const fromDefault = resolveTierBudget({ configPaths: [noBudget] })
  assert.equal(fromDefault.source, 'meow-default')
  assert.equal(fromDefault.chars, 1400)
  assert.equal(fromDefault.tokens, 979)

  const fromFallback = resolveTierBudget({ configPaths: [join(dir, 'nope.yml')] })
  assert.equal(fromFallback.source, 'fallback')
  assert.equal(fromFallback.tokens, 600)
  assert.equal(fromFallback.chars, 858)

  const fromArg = resolveTierBudget({ configPaths: [withBudget], budgetTokens: 600 })
  assert.equal(fromArg.source, 'arg')
  assert.equal(fromArg.tokens, 600)

  // 集成：normalizeConfig 里默认就该跟着 meow 走（不再写死 600）。
  const cfg = normalizeConfig({ ...config, tierConfigPaths: [withBudget] })
  assert.equal(cfg.tierBudgetTokens, 1538, `normalizeConfig 没跟 meow 同源：${cfg.tierBudgetTokens}`)
  assert.equal(cfg.tierBudgetChars, 2200)
  assert.equal(cfg.tierBudgetSource, 'meow')
  assert.deepEqual(cfg.tierPins, ['p1', 'p2', 'p3'])

  // 显式配置仍是最高优先级（老用户行为不变）。
  const cfg2 = normalizeConfig({ ...config, tierConfigPaths: [withBudget], tierBudgetTokens: 600 })
  assert.equal(cfg2.tierBudgetSource, 'arg')
  assert.equal(cfg2.tierBudgetTokens, 600)
  return `meow 2200 字→1538 tok / 默认 1400 字→979 tok / 兜底 600 tok / 显式传参优先`
})

await test('A5', 'T2 三组分列：rules 进第 1 组带「两次 apply」、user 进第 2 组、pin 进第 3 组且不动', () => {
  const dir = join(root, 'tier-groups')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'memory.db')
  const db = new DatabaseSync(dbPath)
  const cols = "id text primary key, content text, importance integer not null default 1, keywords text not null default '[]', status text not null default 'active', hit_count integer not null default 0, created_at integer not null, updated_at integer not null, last_accessed_at integer, corrected integer not null default 0"
  for (const table of ['soul', 'user']) db.exec(`create table ${table} (${cols})`)
  db.exec(`create table rules (${cols}, project text)`)
  const now = Date.now()
  db.prepare('insert into user (id, content, importance, created_at, updated_at) values (?,?,?,?,?)').run(
    'u-g',
    `长用户偏好：${'要多写细节。'.repeat(60)}`,
    3,
    now,
    now,
  )
  db.prepare('insert into rules (id, content, importance, created_at, updated_at, project) values (?,?,?,?,?,?)').run(
    'r-g',
    `长全局规则：${'先取证再动手。'.repeat(60)}`,
    3,
    now,
    now,
    '全局',
  )
  db.close()

  const cfg = normalizeConfig({
    ...config,
    memoryDbPath: dbPath,
    stateDir: join(root, 'state-tier-groups'),
    tierConfigPaths: [join(root, 'profiles', 'cordis.patch.yml')],
    tierPinIds: ['r-g'],
  })
  const cfgNoPin = normalizeConfig({
    ...cfg,
    tierConfigPaths: [join(root, 'profiles', 'cordis.patch.yml')],
    tierPinIds: [],
  })
  // 首行只看「预算来源」：默认跟 meow 走（2200 字 ≈ 1538 tok）。
  const head = createTier({ config: cfg })({ mode: 'preview', limit: 20 })
  assert.equal(head.ok, true, head.text)
  assert.match(
    head.text,
    /目标 ~1538 tok（2200 字 · 来源 meow injectBudgetChars）/,
    `首行没标预算来源：${head.text.split('\n')[0]}`,
  )
  // 三组用 100 tok 的小预算逼出超线（预算口径已被 A4 验过，这里只管分列）。
  const groups = createTier({ config: cfg })({ mode: 'preview', budgetTokens: 100, limit: 20 })
  assert.equal(groups.ok, true, groups.text)
  const i1 = groups.text.indexOf('一、可降权（rules，需两次 apply 才退出）')
  const i2 = groups.text.indexOf('二、降权无效（user / soul，要动只能归档）')
  const i3 = groups.text.indexOf('三、pin 保护，跳过')
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, `三组顺序不对：${groups.text}`)
  assert.ok(!groups.text.slice(i1, i2).includes('rules/r-g'), 'pin 住的 rules 不该出现在可降权组')
  assert.ok(groups.text.slice(i2, i3).includes('user/u-g'), '被 pin 时 user 仍应在第 2 组')
  assert.match(groups.text.slice(i3), /r-g（pin id）/, '第 3 组没列出 pin id')

  const noPin = createTier({ config: cfgNoPin })({ mode: 'preview', budgetTokens: 100, limit: 20 })
  const a1 = noPin.text.indexOf('一、可降权（rules，需两次 apply 才退出）')
  const a2 = noPin.text.indexOf('二、降权无效（user / soul，要动只能归档）')
  const a3 = noPin.text.indexOf('三、pin 保护，跳过')
  assert.ok(a1 >= 0 && a2 > a1 && a3 > a2, `不 pin 时三组顺序不对：${noPin.text}`)
  const g1 = noPin.text.slice(a1, a2)
  const g2 = noPin.text.slice(a2, a3)
  assert.match(g1, /rules\/r-g/, `rules 没进第 1 组：${noPin.text}`)
  assert.match(g1, /本次 apply 当下节省 0 tok \/ 再 apply 一次才省 \d+ tok/, `第 1 组缺「两次 apply」文案：${g1}`)
  assert.match(g2, /user\/u-g/, 'user 没进第 2 组')
  assert.match(g2, /降 importance 不进也不出常驻/, '第 2 组缺说明')
  return `三组齐全；pin 的 rules 被跳过、不 pin 时「两次 apply」文案在`
})

await test('A6', 'T3 apply 前置校验：一条注入都减不掉时先拒并要求 confirm，带 confirm 才落库并给备份/回滚', () => {
  const dir = join(root, 'tier-nosave')
  mkdirSync(dir, { recursive: true })
  const dbPath = join(dir, 'memory.db')
  const db = new DatabaseSync(dbPath)
  const cols = "id text primary key, content text, importance integer not null default 1, keywords text not null default '[]', status text not null default 'active', hit_count integer not null default 0, created_at integer not null, updated_at integer not null, last_accessed_at integer, corrected integer not null default 0"
  for (const table of ['soul', 'user']) db.exec(`create table ${table} (${cols})`)
  db.exec(`create table rules (${cols}, project text)`)
  const now = Date.now()
  db.prepare('insert into rules (id, content, importance, created_at, updated_at, project) values (?,?,?,?,?,?)').run(
    'r-3',
    `全是 imp3 的长规则：${'必须留证据。'.repeat(80)}`,
    3,
    now,
    now,
    '全局',
  )
  db.close()
  const cfg = normalizeConfig({ ...config, memoryDbPath: dbPath, stateDir: join(root, 'state-tier-nosave'), tierBudgetTokens: 100 })
  const tier = createTier({ config: cfg })

  const rejected = tier({ mode: 'apply' })
  assert.equal(rejected.ok, false, '没 confirm 竟然落库了')
  assert.match(rejected.text, /本次 apply 不减少任何注入，仅改数据/, `拒绝时没说清「仅改数据」：${rejected.text}`)

  const applied = tier({ mode: 'apply', confirm: true })
  assert.equal(applied.ok, true, `带 confirm 仍失败：${applied.text}`)
  assert.ok(applied.backup && existsSync(applied.backup), `没给备份：${applied.backup}`)
  assert.ok(applied.sql.split('\n').filter(Boolean).length >= 1, '没给回滚 SQL')
  assert.match(applied.text, /本次 apply 不减少任何注入，仅改数据/, '落库后没申报「仅改数据」')
  const after = new DatabaseSync(dbPath, { readOnly: true })
  assert.equal(after.prepare("select importance from rules where id='r-3'").get().importance, 2, 'imp3 没降到 2')
  after.close()
  return `拒绝文案含「仅改数据」；confirm 后 r-3 imp3→2、备份+回滚 SQL 齐全`
})

await test('A7', 'T4 injectBudgetChars:0 = 关闭预算 = 全量注入（不许被 100 下限夹住、也不许回落 1400）', () => {
  const dir = join(root, 'profiles-off')
  mkdirSync(dir, { recursive: true })
  const offYml = join(dir, 'cordis.patch.yml')
  writeFileSync(offYml, ['- id: meow-memory', '  name: meow-memory', '  config:', '      injectBudgetChars: 0', ''].join('\n'), 'utf8')

  const off = resolveTierBudget({ configPaths: [offYml] })
  assert.equal(off.source, 'off', `0 应解析成「关闭预算」，实得 ${off.source}`)
  assert.equal(off.chars, 0, `0 字被改写成 ${off.chars}`)
  assert.equal(off.tokens, 0, `0 被夹成 ${off.tokens} tok`)
  assert.match(off.note, /预算关闭/, `来源文案不对：${off.note}`)

  const cfg = normalizeConfig({ ...config, memoryDbPath: tierDbPath, stateDir: join(root, 'state-off'), tierConfigPaths: [offYml] })
  assert.equal(cfg.tierBudgetSource, 'off')
  assert.equal(cfg.tierBudgetTokens, 0)

  const preview = createTier({ config: cfg })({ mode: 'preview', limit: 50 })
  assert.equal(preview.ok, true, preview.text)
  assert.match(preview.text, /目标：预算关闭（0 = 不限，全量注入）/, `首行没写关闭：${preview.text.split('\n')[0]}`)
  const all = planForDb(tierDbPath, { budgetChars: 0, budgetOff: true })
  assert.equal(all.overflow.length, 0, `预算关闭却还有超线 ${all.overflow.length} 条`)
  assert.equal(all.listed.length, all.rows.length, `预算关闭应全量入名单：${all.listed.length}/${all.rows.length}`)

  // 显式传参 0 也当关闭，不许被夹成 100 tok。
  const explicit0 = createTier({
    config: normalizeConfig({ ...config, memoryDbPath: tierDbPath, stateDir: join(root, 'state-off2') }),
  })({ mode: 'preview', budgetTokens: 0, limit: 50 })
  assert.equal(explicit0.ok, true, explicit0.text)
  assert.match(explicit0.text, /目标：预算关闭（0 = 不限，全量注入）/, `显式 0 没当关闭：${explicit0.text.split('\n')[0]}`)
  return `profile 0 → off（0 tok / 0 字）；首行「预算关闭」；名单=全库、超线 0；显式 0 同样生效`
})

// ---------------------------------------------------------------------------
// 十期：存量快照瘦身（surface replace）——用自建小日志当靶子
// ---------------------------------------------------------------------------

import { zstdCompressSync } from 'node:zlib'
import {
  applySurfaceReplace,
  applyViaSession,
  decodeSessionLog,
  foldSurface,
  planSurfaceReplace,
  renderSurfacePlan,
  surfaceStatsOf,
  textOf,
} from './surface.mjs'

const surfDir = join(root, 'surface')
mkdirSync(surfDir, { recursive: true })

const soulText = (tag) => `【魂引 · 人格】\n我是谁：示例助手（${tag}）\n${'人格行。'.repeat(30)}`
const memText = (tag) => `===== 长期记忆 =====\n${tag}\n${'记忆正文。'.repeat(60)}`

/** 造一份最小会话日志：多帧 zstd，一条事件一帧（和 DSH 的追加写法一致）。 */
function writeSessionLog(dirName, events) {
  const dir = join(surfDir, dirName)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, Buffer.concat(events.map((ev) => zstdCompressSync(Buffer.from(`${JSON.stringify(ev)}\n`, 'utf8')))))
  return file
}

function fixtureEvents() {
  let seq = 0
  const mk = (type, data) => ({ type, seq: seq++, time: 1_700_000_000_000 + seq, data, surfaceOp: 'append' })
  return [
    mk('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'You are an agent.' }] } }),
    mk('user/message', { content: [{ type: 'text', text: '真实用户消息：做这个任务' }], source: { kind: 'user' }, role: 'user', id: 'u1' }),
    mk('user/message', { content: [{ type: 'text', text: soulText('第1轮') }], source: { kind: 'soul' }, role: 'user', id: 's1' }),
    mk('user/message', { content: [{ type: 'text', text: memText('第1轮') }], source: { kind: 'plugin:meow-memory' }, role: 'user', id: 'm1' }),
    // 中间隔一条真实用户消息 → 必须断成两段，不许跨过去
    mk('user/message', { content: [{ type: 'text', text: '真实用户消息：继续' }], source: { kind: 'user' }, role: 'user', id: 'u2' }),
    mk('user/message', { content: [{ type: 'text', text: soulText('第2轮') }], source: { kind: 'soul' }, role: 'user', id: 's2' }),
    mk('user/message', { content: [{ type: 'text', text: memText('第2轮') }], source: { kind: 'plugin:meow-memory' }, role: 'user', id: 'm2' }),
    mk('assistant/message', { message: { role: 'assistant', content: [{ type: 'tool-call', name: 'read' }] } }),
    mk('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] } }),
    mk('user/message', { content: [{ type: 'text', text: '真实用户消息：再继续' }], source: { kind: 'user' }, role: 'user', id: 'u3' }),
    mk('user/message', { content: [{ type: 'text', text: soulText('最新') }], source: { kind: 'soul' }, role: 'user', id: 's3' }),
    mk('user/message', { content: [{ type: 'text', text: memText('最新') }], source: { kind: 'plugin:meow-memory' }, role: 'user', id: 'm3' }),
  ]
}

await test('S1', 'surface dry-run：只认魂引/记忆两种谓词、保留最新各一条、相邻合成一段、收益按「遮掉－替换桩」算', () => {
  const file = writeSessionLog('dry', fixtureEvents())
  const decoded = decodeSessionLog(file)
  const plan = planSurfaceReplace(decoded.events)
  assert.deepEqual(plan.problems, [], `fold 有问题：${plan.problems.join('；')}`)
  assert.equal(plan.candidates.length, 6, `候选应 6 条（3 魂引 + 3 记忆），实得 ${plan.candidates.length}`)
  assert.deepEqual(plan.keep.map((row) => row.seq).sort((a, b) => a - b), [10, 11], `保留应是最新魂引 seq10 与最新记忆 seq11`)
  assert.equal(plan.maskable.length, 4, `拟遮应 4 条，实得 ${plan.maskable.length}`)
  assert.equal(plan.ranges.length, 2, `被真实用户消息隔开应断成 2 段，实得 ${plan.ranges.length}`)
  assert.deepEqual(
    plan.ranges.map((range) => range.rows.length),
    [2, 2],
    '每段 2 条',
  )
  assert.equal(plan.pairingOk, true, '切点应 balanced')
  const stubTokens = plan.ranges.length * estimateTokens(plan.ranges[0].stub)
  assert.equal(plan.tokensNet, plan.tokensSaved - plan.stubTokens, '净省应等于遮掉减替换桩')
  assert.ok(plan.tokensNet > 0, '净省应大于 0')
  assert.equal(stubTokens > 0, true)
  // 真实用户消息、system、tool 不在候选里
  const maskedKinds = plan.maskable.map((row) => decoded.events.find((ev) => ev.seq === row.seq).data.source.kind)
  assert.deepEqual([...new Set(maskedKinds)].sort(), ['plugin:meow-memory', 'soul'], `遮到了不该遮的：${maskedKinds}`)
  const text = renderSurfacePlan(plan, { session: 'dry' })
  assert.match(text, /范围检查：2 段连续区间，区间内 100% 是同谓词节点 ✓/)
  assert.match(text, /tool 配对检查：balanced ✓/)
  assert.match(text, /合计可省 ≈ [\d,]+ tok\/轮/)
  return `候选 6 / 拟遮 4 / 2 段 / 净省 ${plan.tokensNet} tok`
})

await test('S2', 'surface apply：没 confirm 拒、刚写过拒；带 confirm 才备份+写入，写后自检全绿且原文一字不动', () => {
  const file = writeSessionLog('apply', fixtureEvents())
  const events = decodeSessionLog(file).events
  const plan = planSurfaceReplace(events)
  const before = readFileSync(file)

  const noConfirm = applySurfaceReplace(file, plan, { quietMs: 0 })
  assert.equal(noConfirm.ok, false, '没 confirm 竟然写了')
  assert.match(noConfirm.error, /confirm/, `拒绝理由不对：${noConfirm.error}`)

  const tooFresh = applySurfaceReplace(join(writeSessionLog('apply-fresh', fixtureEvents())), plan, { confirm: true })
  assert.equal(tooFresh.ok, false, '刚写完的日志（疑似在跑）不该被写')
  assert.match(tooFresh.error, /还在写|拒绝写入/, `提示不对：${tooFresh.error}`)

  const applied = applySurfaceReplace(file, plan, { confirm: true, quietMs: 0 })
  assert.equal(applied.ok, true, `apply 失败：${applied.error ?? applied.verify?.problems?.join('；')}`)
  assert.ok(applied.backup && existsSync(applied.backup), '没留备份')
  assert.equal(Buffer.compare(readFileSync(applied.backup), before), 0, '备份内容必须与写前逐字节一致')
  assert.equal(applied.appended.length, 2, `应追加 2 条 replace，实得 ${applied.appended.length}`)

  const after = decodeSessionLog(file).events
  assert.equal(after.length, events.length + 2, '事件数应为原数 + 2')
  const afterBySeq = new Map(after.map((ev) => [ev.seq, ev]))
  for (const ev of events) {
    assert.equal(JSON.stringify(afterBySeq.get(ev.seq)), JSON.stringify(ev), `seq ${ev.seq} 的原文被改了`)
  }
  const fold = foldSurface(after)
  assert.deepEqual(fold.problems, [], `写后 fold 有问题：${fold.problems.join('；')}`)
  const onSurface = fold.nodes.map((seq) => afterBySeq.get(seq))
  assert.equal(onSurface.filter((ev) => textOf(ev).startsWith('【魂引 · 人格】')).length, 1, '魂引应只剩最新一条')
  assert.equal(onSurface.filter((ev) => textOf(ev).startsWith('===== 长期记忆 =====')).length, 1, '记忆应只剩最新一条')
  assert.equal(onSurface.filter((ev) => textOf(ev).startsWith('真实用户消息')).length, 3, '真实用户消息不许动')
  assert.equal(
    onSurface.filter((ev) => textOf(ev).startsWith('【已折叠】')).length,
    2,
    '两个区间应各留一条替换桩',
  )
  const v = applied.verify
  assert.equal(v.ok, true, `自检失败：${v.problems.join('；')}`)
  assert.equal(v.pairing, true, '切点配对自检应为真')
  assert.ok(v.surfaceTokens < v.tokensBefore, `surface tok 应下降：${v.tokensBefore} → ${v.surfaceTokens}`)
  return `拒绝 2 次；写入 2 段；原文逐字节一致；surface ${v.tokensBefore} → ${v.surfaceTokens} tok`
})

await test('S3', 'surface 回滚演练：还原备份后计划与写入前完全一致（这是唯一可靠的回滚）', () => {
  const file = join(surfDir, 'apply', 'session.v4.jsonl.zstd')
  const backups = readdirSync(surfDir + '/apply').filter((name) => name.includes('.bak-surface-'))
  assert.equal(backups.length, 1, `备份应恰好 1 份，实得 ${backups.length}`)
  const backup = join(surfDir, 'apply', backups[0])
  copyFileSync(backup, file)
  const after = planSurfaceReplace(decodeSessionLog(file).events)
  assert.equal(after.candidates.length, 6, `回滚后候选应回到 6，实得 ${after.candidates.length}`)
  assert.equal(after.maskable.length, 4, `回滚后拟遮应回到 4，实得 ${after.maskable.length}`)
  assert.equal(after.tokensNet > 0, true, '回滚后净省应恢复为正数')
  assert.equal(foldSurface(decodeSessionLog(file).events).replacements.length, 0, '回滚后不该还剩 replace')
  return `备份 ${basename(backup)} 还原后：候选 ${after.candidates.length} / 拟遮 ${after.maskable.length} / replace 0`
})

await test('S4', 'soul_surface 走会话 API：append 后宿主 surface 里旧快照消失、桩可再次成为候选', () => {
  /** 假会话：只实现 surface / snapshotEvents / append 三件事，fold 用同一个 foldSurface 复算。 */
  class FakeSession {
    constructor(events) {
      this.log = events.map((event) => ({ ...event }))
      this.nextSeq = this.log.reduce((max, event) => Math.max(max, event.seq), -1) + 1
      this.id = 'fake-session'
    }
    get surface() {
      return { nodes: foldSurface(this.log).nodes }
    }
    snapshotEvents() {
      return this.log.map((event) => ({ ...event }))
    }
    append(type, data, opts = {}) {
      const event = { type, seq: this.nextSeq++, time: 1_700_000_100_000, data, surfaceOp: opts.surfaceOp, sourceEventSeqs: opts.sourceEventSeqs }
      this.log.push(event)
      return event
    }
  }

  const session = new FakeSession(fixtureEvents())
  const plan = planSurfaceReplace(session.snapshotEvents())
  assert.equal(plan.ranges.length, 2, `夹具应有 2 段，实得 ${plan.ranges.length}`)
  const before = surfaceStatsOf(session)
  assert.equal(before.soul, 3, '写入前应有 3 条魂引在 surface 上')

  const refused = applyViaSession(session, plan, { confirm: false })
  assert.equal(refused.ok, false, '没 confirm 竟然写了')
  assert.match(refused.error, /confirm/, `拒绝理由不对：${refused.error}`)

  const applied = applyViaSession(session, plan, { confirm: true })
  assert.equal(applied.ok, true, `apply 失败：${applied.error ?? applied.problems.join('；')}`)
  assert.equal(applied.appended.length, 2, `应追加 2 条，实得 ${applied.appended.length}`)
  assert.deepEqual(applied.stillOn, [], `宿主 surface 里还剩被遮节点：${applied.stillOn}`)
  assert.ok(applied.after.tokens < applied.before.tokens, `surface tok 应下降：${applied.before.tokens} → ${applied.after.tokens}`)
  assert.equal(applied.after.soul, 1, '魂引应只剩最新一条')
  assert.equal(applied.after.memory, 1, '记忆应只剩最新一条')
  assert.equal(applied.after.stub, 2, '两个区间各留一条桩')

  // 桩已进日志 → 下一次折叠必须把桩也算进候选（否则桩永远留着）
  const plan2 = planSurfaceReplace(session.snapshotEvents())
  assert.equal(plan2.candidates.filter((row) => row.kind === 'stub').length, 2, '桩没进候选')
  return `拒 1 次；写入 2 段；surface ${applied.before.tokens}→${applied.after.tokens} tok；魂引/记忆各剩 1；桩进候选`
})

// ---------------------------------------------------------------------------
// 十二期：关系层 / 情绪（只读、不进记忆库、正文不常驻）
// ---------------------------------------------------------------------------

const relationsDir = join(root, 'relations')
mkdirSync(relationsDir, { recursive: true })
writeFileSync(join(relationsDir, '2026-10-29.md'), ['# 关系层 · 2026-10-29', '', '- 旧的一条（2026-10-29）', ''].join('\n'), 'utf8')
const tenItems = Array.from({ length: 10 }, (_, i) => `- 第 ${i + 1} 条阈值（2026-10-30）`)
writeFileSync(join(relationsDir, '2026-10-30.md'), ['# 关系层 · 2026-10-30', '', ...tenItems, '', '> 注释行不算条目'].join('\n'), 'utf8')

await test('S5', 'readRelations：按文件名倒序取最新一份、只收 `- ` 条目、≤8 条、空目录不炸', () => {
  const found = readRelations(relationsDir)
  assert.equal(found.ok, true, '读取失败')
  assert.equal(basename(found.file), '2026-10-30.md', `没取最新那份：${found.file}`)
  assert.equal(found.date, '2026-10-30', `日期没解析出来：${found.date}`)
  assert.equal(found.items.length, RELATIONS_CAP, `应截到 ${RELATIONS_CAP} 条，实得 ${found.items.length}`)
  assert.ok(found.items.every((item) => !item.startsWith('#') && !item.startsWith('>')), '把注释/标题当成条目了')
  const empty = readRelations(join(root, 'relations-empty'))
  assert.equal(empty.ok, true, '空目录应 ok=true')
  assert.equal(empty.items.length, 0, '空目录不该有条目')
  return `取 ${basename(found.file)} / ${found.items.length} 条（原始 10 条截到 8）/ 空目录 ok`
})

await test('S6', 'soul_relations / soul_mood：真调 execute、合 schema；没文件给「未记录」；正文不进魂引', async () => {
  const relationsConfig = normalizeConfig({ ...config, relationsDir, moodPath: join(root, 'no-mood.md') })
  const tools = createTools(relationsConfig)
  const rel = tools.find((tool) => tool.name === 'soul_relations')
  const mood = tools.find((tool) => tool.name === 'soul_mood')
  assert.ok(rel && mood, '两个新工具没注册')
  const relOut = await rel.execute({ limit: 3 })
  assertSchemaValue(relOut, rel.output.schema, 'soul_relations')
  assert.equal(relOut.ok, true, relOut.text)
  assert.equal(relOut.count, 3, `limit=3 应回 3 条，实得 ${relOut.count}`)
  assert.match(relOut.text, /第 1 条阈值/, `正文没带出来：${relOut.text}`)
  const moodOut = await mood.execute({})
  assertSchemaValue(moodOut, mood.output.schema, 'soul_mood')
  assert.match(moodOut.text, /未记录/, `没文件时应说未记录：${moodOut.text}`)

  const moodPath = join(root, 'mood.md')
  writeFileSync(moodPath, 'at: 2026-10-30 07:40\nmood: 平静，有点困\ncarry: 十一期刚验收', 'utf8')
  const withMood = createTools(normalizeConfig({ ...config, relationsDir, moodPath }))
  const moodOut2 = await withMood.find((tool) => tool.name === 'soul_mood').execute({})
  assert.match(moodOut2.text, /有点困/, `mood 没读出来：${moodOut2.text}`)

  const soulText = composeSoul(parseSoul(readFileSync(config.soulPath, 'utf8')), { now: new Date('2026-10-30T07:40:00+08:00') }).text
  assert.match(soulText, /soul_relations\(\)/, `魂引缺关系层入口：${soulText}`)
  assert.ok(!soulText.includes('第 1 条阈值'), '关系层正文漏进魂引了')
  return `relations 3/3 条 · mood 未记录→有文件都通 · 魂引入口在、正文没漏`
})

// ---------------------------------------------------------------------------
// 一期 A（魂引预算可见性）：只观测、不改行为
// ---------------------------------------------------------------------------

await test('O1', 'measureRequestBudget：soul / snapshot / inject / conv 四笔账，fixed=前三者', () => {  const snapshotText = `===== 长期记忆 =====\n${'记忆内容。'.repeat(200)}`
  const messages = [
    { id: 's1', role: 'user', content: [{ type: 'text', text: '魂引'.repeat(20) }], source: { kind: 'soul' } },
    {
      id: 'snap-1',
      role: 'user',
      content: [{ type: 'text', text: snapshotText }],
      source: {
        kind: 'plugin:meow-memory',
        form: 'snapshot',
        sections: [
          { name: '__meta__', text: '{"kind":"hit","ids":["m1"]}' },
          { name: '长期记忆', text: snapshotText },
        ],
      },
    },
    { id: 'clock-1', role: 'user', content: [{ type: 'text', text: '时间行'.repeat(10) }], source: { kind: 'time-context', form: 'snapshot' } },
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '早' }], source: { kind: 'user' } },
  ]
  const got = measureRequestBudget(messages)
  assert.equal(got.soul, estimateTokens('魂引'.repeat(20)), `soul 记错：${got.soul}`)
  assert.ok(got.snapshot > 1000, `快照没被认出来（${got.snapshot}）`)
  // 这条是一期 A 的真 bug：time-context 也带 form:'snapshot'，以前被算进快照，现在必须算 inject。
  assert.ok(got.inject > 0, `time-context 应算注入、不该算快照：inject=${got.inject} snapshot=${got.snapshot}`)
  assert.ok(got.conversation > 0 && got.conversation < 20, `conv 记错：${got.conversation}`)
  assert.equal(got.fixed, got.soul + got.snapshot + got.inject, `fixed 对不上：${JSON.stringify(got)}`)
  assert.ok(Math.abs(got.total - (got.fixed + got.conversation)) <= 1, `合计对不上：${JSON.stringify(got)}`)
  return `soul=${got.soul} snapshot=${got.snapshot} inject=${got.inject} conv=${got.conversation} fixed=${got.fixed}`
})

await test('O2', 'pre-step 观测：快照进 observed=，但 before= 口径不变、快照不被吞', async () => {
  const logPath = join(root, 'logs/observed.log')
  rmSync(logPath, { force: true })
  const snapshotText = `===== 长期记忆 =====\n${'记忆内容。'.repeat(250)}`
  const handler = createPreStepHandler({
    config: normalizeConfig({ ...config, logPath }),
    now: () => new Date('2026-10-28T08:20:00+08:00'),
    pendingLoader: () => [],
  })
  const decision = await handler(fakePayload(1), async () => ({
    kind: 'enter',
    messages: [
      {
        id: 'snap-1',
        role: 'user',
        content: [{ type: 'text', text: snapshotText }],
        source: { kind: 'plugin:meow-memory', form: 'snapshot', sections: [{ name: '__meta__', text: '{"kind":"initial","ids":["m1"]}' }] },
      },
      { id: 'user-1', role: 'user', content: [{ type: 'text', text: '帮我看看这个' }], source: { kind: 'user' } },
    ],
  }))
  const line = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).pop()
  const match = /before=(\d+)tok .*observed=soul:(\d+) snapshot:(\d+) inject:(\d+) conv:(\d+) fixed:(\d+) total:(\d+)tok/.exec(line)
  assert.ok(match, `日志里没有 observed=：${line}`)
  const before = Number(match[1])
  const snapshot = Number(match[3])
  const fixed = Number(match[6])
  assert.ok(snapshot > 1000, `快照没进 observed（${snapshot}）：${line}`)
  assert.ok(before < snapshot, `before=${before} 含了快照，旧口径被改了`)
  assert.ok(fixed >= snapshot, `fixed 应含快照：fixed=${fixed}`)
  assert.ok(decision.messages.some((m) => m?.source?.kind === 'plugin:meow-memory'), '快照被吞了（不该改行为）')
  assert.match(line, /hist=0\/0\/0/, `历史计数应为本轮之外为 0（本轮快照不重复计入）：${line}`)
  return `before=${before} observed.snapshot=${snapshot} fixed=${fixed}`
})

// ---------------------------------------------------------------------------
// 二期 B（分级常驻 / 旧快照清理 / 周检探针）
// ---------------------------------------------------------------------------

function snapshotMessage(kind, ids, text = '===== 长期记忆 =====\n内容') {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin:meow-memory',
      form: 'snapshot',
      sections: [
        { name: '__meta__', text: JSON.stringify({ kind, ids }) },
        { name: '长期记忆', text },
      ],
    },
  }
}

await test('T1', 'snapshotMetaOf / countSnapshots：从 __meta__ 读 kind，不靠 id 前缀猜', () => {
  const events = [
    { type: 'user/message', data: { message: snapshotMessage('initial', ['a']) } },
    { type: 'user/message', data: { message: snapshotMessage('hit', ['b']) } },
    { type: 'user/message', data: { message: snapshotMessage('hit', ['c']) } },
    { type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '普通一句' }], source: { kind: 'user' } } } },
  ]
  const counts = countSnapshots(events)
  assert.equal(counts.initial, 1, `initial 记错：${JSON.stringify(counts)}`)
  assert.equal(counts.hit, 2, `hit 记错：${JSON.stringify(counts)}`)
  assert.deepEqual(snapshotMetaOf(snapshotMessage('hit', ['b']))?.ids, ['b'])
  assert.equal(snapshotMetaOf({ source: { kind: 'user' } }), null, '普通消息不该有 meta')
  return `hist=${counts.initial}/${counts.reinjection}/${counts.hit}`
})

await test('T2', 'planSnapshotPrune：历史 hit 满 2 后，本轮新 hit 被丢（只丢本轮，不碰历史）', () => {
  const full = planSnapshotPrune({ hit: 2 }, [{ kind: 'hit', ids: ['new'] }])
  assert.deepEqual(full.keep, [false])
  assert.equal(full.dropped.length, 1)
  assert.deepEqual(full.dropped[0].ids, ['new'])
  const room = planSnapshotPrune({ hit: 1 }, [{ kind: 'hit', ids: ['new'] }])
  assert.deepEqual(room.keep, [true])
  const initial = planSnapshotPrune({ initial: 1 }, [{ kind: 'initial', ids: ['x'] }])
  assert.deepEqual(initial.keep, [false], 'initial 只许 1 条')
  const reinj = planSnapshotPrune({ reinjection: 1 }, [{ kind: 'reinjection', ids: ['x'] }])
  assert.deepEqual(reinj.keep, [false], 'reinjection 只许 1 条')
  return `hit 满→${JSON.stringify(full.keep)} / 未满→${JSON.stringify(room.keep)}`
})

await test('T3', 'detectSnapshotDrift：常驻快照里出现项目/话题正文要被抓到', () => {
  const clean = snapshotMessage('hit', ['a'], '===== 长期记忆 =====\n【关于你】\n- 人格见 soul.md')
  assert.deepEqual(detectSnapshotDrift([clean]), [], '干净快照被误判')
  const fat = snapshotMessage('hit', ['a'], '===== 长期记忆 =====\n[dsh : project] MVP 跑通')
  assert.deepEqual(detectSnapshotDrift([fat]), ['project'], '变胖没被抓到')
  return '干净=[] / 变胖=[project]'
})

await test('T4', 'R2 端到端：历史已有 2 条 hit，本轮新 hit 被丢掉且日志写 pruned=', async () => {
  const logPath = join(root, 'logs/prune.log')
  rmSync(logPath, { force: true })
  const history = [
    { type: 'user/message', data: { message: snapshotMessage('hit', ['h1']) } },
    { type: 'user/message', data: { message: snapshotMessage('hit', ['h2']) } },
  ]
  const payload = {
    ...fakePayload(1),
    agent: { session: { id: 'check-session', cwd: FIXTURE_WS, ownEvents: () => history } },
  }
  const handler = createPreStepHandler({
    config: normalizeConfig({ ...config, logPath }),
    now: () => new Date('2026-10-28T08:22:00+08:00'),
    pendingLoader: () => [],
  })
  const decision = await handler(payload, async () => ({
    kind: 'enter',
    messages: [snapshotMessage('hit', ['h3']), { role: 'user', content: [{ type: 'text', text: '问题' }], source: { kind: 'user' } }],
  }))
  const line = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).pop()
  assert.match(line, /pruned=hit:h3\/1/, `pruned 没写对：${line}`)
  assert.match(line, /hist=0\/0\/2/, `hist 没写对：${line}`)
  const leaked = decision.messages.filter((m) => m?.source?.kind === 'plugin:meow-memory')
  assert.equal(leaked.length, 0, `本轮 hit 没被丢：${leaked.length} 条`)
  return line.slice(line.indexOf('pruned='))
})

await test('T5', 'R1 申报（2026-10-28 新口径）：snapshot 超 fixedMaxTokens 时魂引末行报「snapshot:N · 记忆 k/t」', async () => {
  const logPath = join(root, 'logs/fixed.log')
  rmSync(logPath, { force: true })
  const big = `===== 长期记忆 =====\n${'记忆内容。'.repeat(700)}`
  const handler = createPreStepHandler({
    config: normalizeConfig({ ...config, logPath }),
    now: () => new Date('2026-10-28T08:23:00+08:00'),
    pendingLoader: () => [],
  })
  const decision = await handler(fakePayload(1), async () => ({
    kind: 'enter',
    messages: [snapshotMessage('initial', ['big'], big)],
  }))
  const soulText = decision.messages.filter((m) => m?.source?.kind === 'soul').map((m) => m.content[0].text).join('')
  // 新格式：`【预算】snapshot:3910 · 记忆 1/0`（分母 0 时只报分子）
  assert.match(soulText, /【预算】snapshot:\d+ · 记忆 \d+(\/\d+)?/, `魂引里没有新的快照申报：${soulText.slice(-120)}`)
  assert.doesNotMatch(soulText, /固定注入\s*\d+\/800/, '作废的「固定注入 N/800」又出现了')
  const line = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).pop()
  assert.match(line, /fixed:\d{3,}/, `日志 fixed 不对：${line}`)
  return soulText.slice(soulText.indexOf('【预算'))
})

await test('T8', '降档必须说出来：上限 200 + 超长 soul.md → 魂引末行有「【魂引】已降档」且日志有 stage= 的 soul-warn', async () => {
  const logPath = join(root, 'logs/stage-warn.log')
  rmSync(logPath, { force: true })
  const handler = createPreStepHandler({
    config: normalizeConfig({ ...config, logPath, soulPath: soulBloated, soulMaxTokens: 200 }),
    now: () => new Date('2026-10-28T13:12:00+08:00'),
    pendingLoader: () => [],
  })
  // 用默认 fakePayload（tmpdir 派生、较长的工作区路径）：2026-11-03 就是这样把 200tok
  // 预算占满、末行申报被挤掉的，改 composition 里给申报留位后这条才算真回归。
  const decision = await handler(fakePayload(1), async () => ({ kind: 'enter', messages: [] }))
  const soulText = decision.messages.filter((m) => m?.source?.kind === 'soul').map((m) => m.content[0].text).join('')
  assert.match(soulText, /【魂引】已降档 [\w-]+/, `魂引里没有降档申报：${soulText.slice(-160)}`)
  assert.ok(estimateTokens(soulText) <= 200, `申报后超了 200：${estimateTokens(soulText)}`)
  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /soul-warn/, `日志里没有 soul-warn：${log.slice(-200)}`)
  assert.match(log, /魂引降档 stage=[\w-]+ 原 \d+tok 上限 200tok/, `warn 没带原始 tok 与上限：${log.slice(-200)}`)
  return soulText.slice(soulText.indexOf('【魂引】已降档'))
})

await test('T9', '降档确实少了内容、但不砍人格核心：申报带 stage / 总条目变少 / 三节首条都在', () => {
  const soul = parseSoul(readFileSync(soulOk, 'utf8'))
  const base = { soul, at: new Date('2026-10-28T13:12:00+08:00'), workspace: FIXTURE_WS }
  const full = composeSoul({ ...base, maxTokens: HARD_SOUL_TOKENS })
  /** 条目 = 人格行的 bullet（用 · 分隔）+ 【怎么查】的行 + 【路由】的行。
   *  不写死「少的是哪一条」：降档策略改了也只在条目数上体现。 */
  const entries = (text) => {
    const lines = text.split('\n')
    let count = 0
    for (const line of lines) {
      if (/^(我是谁|我怎么想|我不做什么|在群里|我记得)：/.test(line)) count += line.split(' · ').length
    }
    let zone = ''
    for (const line of lines) {
      if (line === '【怎么查】' || line === '【路由】') { zone = line; continue }
      if (zone !== '' && line.trim() !== '' && !line.startsWith('【')) count += 1
    }
    return count
  }
  const firstBullet = (text, label) => {
    const line = text.split('\n').find((l) => l.startsWith(`${label}：`))
    return line ? line.slice(label.length + 1).split(' · ')[0] : ''
  }
  // 从 full 的预算往下找：第一个会申报降档的预算
  let tight = null
  for (let m = full.tokens - 1; m >= 40; m -= 1) {
    const out = composeSoul({ ...base, maxTokens: m })
    if (/【魂引】已降档 [\w-]+/.test(out.text)) { tight = out; break }
  }
  assert.ok(tight, '扫完 40..full 都没有降档申报')
  assert.ok(tight.tokens <= full.tokens, `${tight.tokens} > ${full.tokens}`)
  const note = tight.text.match(/【魂引】已降档 ([\w-]+)/)
  assert.equal(note[1], tight.stage, `申报的 stage ${note[1]} 与实际档位 ${tight.stage} 不一致`)
  assert.ok(entries(tight.text) < entries(full.text), `降档后条目没减少：${entries(tight.text)} vs ${entries(full.text)}`)
  for (const label of ['我是谁', '我怎么想', '我不做什么']) {
    const head = firstBullet(full.text, label)
    assert.ok(head !== '', `full 档里没有「${label}」`)
    const line = tight.text.split('\n').find((l) => l.startsWith(`${label}：`))
    assert.ok(line, `降档后整节「${label}」丢了`)
    assert.ok(line.includes(head.slice(0, 8)), `降档后「${label}」首条被砍：${line.slice(0, 60)}`)
  }
  return `${full.tokens}tok(${full.stage}) → ${tight.tokens}tok(${tight.stage})，条目 ${entries(full.text)} → ${entries(tight.text)}`
})

await test('T10', '任何档位三节各至少 1 条；极端装不下时申报「核心已压到极限」', () => {
  // ① 档位表本身的不变式
  for (const stage of SOUL_STAGES) {
    for (const key of ['identity', 'mind', 'boundary']) {
      assert.ok(stage.take[key] >= 1, `档位 ${stage.id} 的 ${key} = ${stage.take[key]}，违反「三节各至少 1 条」`)
    }
  }
  // ② 逐 tok 扫全预算区间，每一档渲染出来的三节都必须有内容
  const soul = parseSoul(readFileSync(soulOk, 'utf8'))
  const longWs = join(FIXTURE_WS, 'x'.repeat(160))
  const seen = new Set()
  for (let m = 40; m <= HARD_SOUL_TOKENS; m += 1) {
    const out = composeSoul({ soul, at: new Date('2026-10-28T13:12:00+08:00'), workspace: longWs, maxTokens: m })
    seen.add(out.stage)
    // 物理上装不下（硬裁）时只要求申报「核心已压到极限」，不再要求三节都在
    if (out.text.includes('核心已压到极限')) continue
    for (const label of ['我是谁', '我怎么想', '我不做什么']) {
      const line = out.text.split('\n').find((l) => l.startsWith(`${label}：`))
      assert.ok(line, `预算 ${m}（档位 ${out.stage}）缺「${label}」整节`)
      const body = line.slice(label.length + 1).split('（另有')[0].trim()
      assert.ok(body.length > 0, `预算 ${m}（档位 ${out.stage}）的「${label}」是空条`)
    }
  }
  assert.ok(seen.has('clip-core-12') || seen.has('clip-core-20'), `扫描没落到极端档：${[...seen].join(',')}`)
  // ③ 物理上装不下：硬裁时必须写明核心已压到极限，不许静默
  const huge = parseSoul([
    '## 我是谁', `- ${'很长的自称'.repeat(400)}`,
    '## 我怎么想', `- ${'很长的想法'.repeat(400)}`,
    '## 我不做什么', `- ${'很长的红线'.repeat(400)}`,
  ].join('\n'))
  const squeezed = composeSoul({ soul: huge, at: new Date(), workspace: longWs, maxTokens: 40 })
  assert.ok(squeezed.tokens <= 40, `${squeezed.tokens} > 40`)
  assert.match(squeezed.text, /核心已压到极限/, `硬裁没有申报：${squeezed.text.slice(-80)}`)
  return `${seen.size} 个档位三节全在场；装不下时申报「核心已压到极限」`
})

await test('T7', '三节超 3 条不再静默：soul.md 某节 4 条时 soul.log 出现 soul-warn 且点名第 4 条起被丢弃', async () => {
  const logPath = join(root, 'logs/section-warn.log')
  rmSync(logPath, { force: true })
  const warnSoul = write(
    'soul/warn-soul.md',
    [
      '## 我是谁',
      '- 第一条',
      '- 第二条',
      '- 第三条',
      '## 我怎么想',
      '- 想法一',
      '## 我不做什么',
      '- 红线一',
      '- 红线二',
      '- 红线三',
      '- 红线四（应被丢弃）这段写长一点，确保指针里只出现标题前缀而正文不进来',
      '',
    ].join('\n'),
  )
  const handler = createPreStepHandler({
    config: normalizeConfig({ ...config, logPath, soulPath: warnSoul }),
    now: () => new Date('2026-10-28T13:10:00+08:00'),
    pendingLoader: () => [],
  })
  const decision = await handler(fakePayload(1), async () => ({ kind: 'enter', messages: [] }))
  const soulText = decision.messages.filter((m) => m?.source?.kind === 'soul').map((m) => m.content[0].text).join('')
  // 2026-11-03：第 4 条起不再静默丢弃——正文不注入，但标题以「另有 N 条」指针出现。
  assert.ok(!soulText.includes('这段写长一点'), '第 4 条正文不该进魂引')
  assert.ok(soulText.includes('另有 1 条') && soulText.includes('红线四'), '第 4 条应以指针标题出现')
  const log = readFileSync(logPath, 'utf8')
  assert.match(log, /soul-warn/, `日志里没有 soul-warn：${log.slice(-200)}`)
  assert.match(
    log,
    /dsh-soul: soul\.md「我不做什么」有 4 条，只注入前 3 条（第 4 条起被丢弃）/,
    `warn 文案不对：${log.slice(-200)}`,
  )
  // 「我是谁」3 条不该产生 warn（上限内）
  assert.doesNotMatch(log, /「我是谁」有/, '未超限的节不该报 warn')
  return `warn 1 行、文案与条数正确；被丢弃的第 4 条没进魂引`
})

await test('T6', 'R5 周检：探针词从 keywords 取、只读库、state 落盘、连续两期不达标才告警', () => {
  const probes = pickProbeWords(memoryDbPath, 5, 1)
  assert.ok(probes.length > 0, '靶子库里没抽到探针条')
  for (const probe of probes) assert.ok(probe.words.every((w) => !w.includes('。')), `探针词像正文切片：${probe.words}`)
  const run = runProbes({ memoryDbPath }, probes)
  assert.equal(run.total, probes.length)
  assert.ok(run.passed >= 1, `一条都查不回：${JSON.stringify(run.results)}`)

  const stateDir = join(root, 'state-probe')
  const cfg = normalizeConfig({ ...config, stateDir, probeIntervalDays: 7 })
  const first = maybeRunProbe(cfg, new Date('2026-10-28T08:25:00+08:00'), false)
  assert.match(first.line, /^probe=main \d+\/\d+/, `主探针没跑：${first.line}`)
  assert.ok(existsSync(join(stateDir, 'probe-state.json')), 'state 没落盘')
  const second = maybeRunProbe(cfg, new Date('2026-10-28T08:26:00+08:00'), false)
  assert.equal(second.line, '', '7 天内不该重跑主探针')
  const quick = maybeRunProbe(cfg, new Date('2026-10-28T08:27:00+08:00'), true)
  assert.match(quick.line, /^probe=quick /, `dream 后没跑快检：${quick.line}`)
  const stored = readProbeState(stateDir)
  assert.ok(stored.lastMainAt > 0 && stored.lastQuickAt > 0, `state 不全：${JSON.stringify(stored)}`)
  return `${first.line.split(' ')[0]} / ${quick.line.split(' ')[0]} / streak=${stored.badStreak ?? 0}`
})

await test('O3', 'T1 真机观测：本机 profile 的 injectBudgetChars 能被 soul_tier 读到并标出来源（读不到也要标兜底）', () => {
  const cfg = normalizeConfig({
    soulPath: join(root, 'soul-o3.md'),
    memoryDbPath: tierDbPath,
    stateDir: join(root, 'state-o3'),
    logPath: join(root, 'logs/o3.log'),
  })
  assert.ok(cfg.tierBudgetNote, '没写预算来源')
  if (cfg.tierBudgetSource === 'meow') {
    assert.ok(cfg.tierBudgetChars > 0, `字数没解析出来：${cfg.tierBudgetChars}`)
    assert.equal(cfg.tierBudgetTokens, budgetTokensOfChars(cfg.tierBudgetChars), 'tok 与字两条口径不一致')
    assert.match(cfg.tierBudgetNote, /meow injectBudgetChars: \d+/, `来源文案不对：${cfg.tierBudgetNote}`)
  }
  return `source=${cfg.tierBudgetSource} ${cfg.tierBudgetTokens} tok（${cfg.tierBudgetChars} 字）pin=${cfg.tierPins.length}`
})

// ---------------------------------------------------------------------------
// 九期：gamedev 技能库接入能力层（source:'gamedev'）
// 全部自建靶子：一次性假技能库（4 条）+ 一次性插件目录/代理库，不碰真库（真库另有 C15 只读冒烟）。
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url))
const skillRoot = join(root, 'gamedev-skills')
const skillIndex = join(skillRoot, 'INDEX.json')
const skillEntries = [
  {
    name: 'save-systems', group: 'disciplines',
    desc: 'Design save/load for game state — choosing what to serialize,\nfile formats and migration',
    path: join(skillRoot, 'disciplines/save-systems/SKILL.md'),
  },
  {
    name: 'rpg', group: 'genres',
    desc: 'Build an RPG: stats and leveling, quests, branching dialogue, save/load',
    path: join(skillRoot, 'genres/rpg/SKILL.md'),
  },
  {
    name: 'ai-behavior-trees-utility-ai', group: 'disciplines',
    desc: 'Build a production behavior-tree runtime (Blackboard, action/condition leaves, enemy AI)',
    path: join(skillRoot, 'disciplines/ai-behavior-trees-utility-ai/SKILL.md'),
  },
  {
    name: 'unreal-behavior-trees', group: 'unreal',
    desc: 'Build NPC AI in Unreal Engine 5 with Behavior Trees and Blackboards',
    path: join(skillRoot, 'unreal/unreal-behavior-trees/SKILL.md'),
  },
]
function writeSkillIndex() {
  mkdirSync(skillRoot, { recursive: true })
  writeFileSync(skillIndex, JSON.stringify(skillEntries, null, 1), 'utf8')
  mkdirSync(join(skillRoot, 'disciplines/save-systems'), { recursive: true })
  // 正文故意放一份，证明「只给路径不读正文」不是嘴上说说。
  writeFileSync(join(skillRoot, 'disciplines/save-systems/SKILL.md'), '# save-systems\n\n## 正文\n大量不该进上下文的细节\n', 'utf8')
}
writeSkillIndex()

const skillConfig = normalizeConfig({
  ...config,
  gamedevSkillsDir: skillRoot,
  capabilitiesPath: join(root, 'notes/cap-gamedev.md'),
  biliDbPath: capBili,
  pluginRoots: [capPlugins],
  stateDir: join(root, 'state-gamedev'),
  logPath: join(root, 'logs/gamedev.log'),
})
const skillCaps = createCapabilities({ config: skillConfig })
const skillTools = createTools(skillConfig)
const capTool = skillTools.find((tool) => tool.name === 'soul_capabilities')
// §2「真调 execute」，不许只测内部函数（三期那条假绿的教训）。
const capExec = (args) => capTool.execute(args)

await test('C9', "source:'gamedev' + 「存档」→ 第一条是 save-systems，只给名字/一句话/路径", async () => {
  const out = await capExec({ query: '存档', source: 'gamedev' })
  assert.equal(out.ok, true, '返回不 ok')
  const lines = out.text.split('\n')
  assert.match(lines[0], /^【soul_capabilities · gamedev】存档$/, `首行不对：${lines[0]}`)
  assert.match(lines[1], /^== save-systems  \[disciplines\]  score=7$/, `第一条不对：${lines[1]}`)
  assert.equal(lines[2], 'Design save/load for game state — choosing what to serialize, file formats and migration', `一句话没压成单行：${lines[2]}`)
  assert.equal(lines[3], join(skillRoot, 'disciplines/save-systems/SKILL.md'), `路径不对：${lines[3]}`)
  assert.doesNotMatch(out.text, /不该进上下文的细节/, '把正文读进来了')
  return `rows=${out.rows} ${lines[1]}`
})

await test('C10', "source:'gamedev' + 「敌人 行为树」→ 返回里含 ai-behavior-trees-utility-ai", async () => {
  const out = await capExec({ query: '敌人 行为树', source: 'gamedev' })
  // 假库里这条的 desc 与真库不同，所以只钉名字与前三行形态，分数只要 >0。
  assert.match(out.text, /== ai-behavior-trees-utility-ai  \[disciplines\]  score=\d+/, `没给行为树：${out.text}`)
  const first = out.text.split('\n')[1]
  assert.match(first, /^== ai-behavior-trees-utility-ai/, `行为树该排第一：${first}`)
  return first
})

await test('C11', '乱码 / 停用词查询 → 明说「无相关技能」，不抛错、不静默空', async () => {
  for (const query of ['¿¿zzz 乱码', 'the and of', 'qqq']) {
    const out = await capExec({ query, source: 'gamedev' })
    assert.equal(out.ok, true, `${query} 抛错了`)
    assert.match(out.text, /无相关技能/, `${query} 没说无相关技能：${out.text}`)
    assert.equal(out.rows, 0, `${query} rows 不是 0`)
  }
  const empty = await capExec({ query: '   ', source: 'gamedev' })
  assert.match(empty.text, /无相关技能/, `空 query 没降级：${empty.text}`)
  return '3 条乱码 + 1 条空 query 都降级'
})

await test('C12', 'INDEX.json 改名（=没装库）→ 输出「技能库未安装：<目录>」，不抛错', async () => {
  const backup = `${skillIndex}.bak`
  renameSync(skillIndex, backup)
  try {
    const out = await capExec({ query: '存档', source: 'gamedev' })
    assert.equal(out.ok, true, '没装库时抛错了')
    assert.equal(out.text, `技能库未安装：${skillRoot}`, `文案不对：${out.text}`)
    assert.equal(out.rows, 0)
    // 再证一条：目录在但 JSON 坏 → 也降级，不抛
    writeFileSync(skillIndex, '{ 坏掉的 json', 'utf8')
    const broken = await capExec({ query: '存档', source: 'gamedev' })
    assert.equal(broken.ok, true, 'JSON 坏了抛错')
    assert.match(broken.text, /技能库未安装：/, `坏 JSON 文案不对：${broken.text}`)
  } finally {
    if (existsSync(skillIndex)) rmSync(skillIndex, { force: true })
    renameSync(backup, skillIndex)
  }
  return '缺 INDEX.json / JSON 坏，两种都降级'
})

await test('C13', '缺省 source（含显式 dsh）输出与改动前逐字一致——真调 execute 比 golden', async () => {
  const golden = JSON.parse(readFileSync(join(here, 'gamedev-golden.json'), 'utf8'))
  // 重建与抓 golden 时完全相同的靶子（3 个插件 × 8 个工具名 + 同一份代理库）
  const base = join(root, 'g13')
  const gPlugins = join(base, 'plugins')
  for (const [plugin, prefix] of [['dsh-alpha', 'alpha'], ['dsh-beta', 'beta'], ['dsh-gamma', 'gamma']]) {
    const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((l) => `${prefix}_${l}`)
    mkdirSync(join(gPlugins, plugin), { recursive: true })
    writeFileSync(join(gPlugins, plugin, 'index.js'), names.map((t) => `  ctx.tools.register({ name: '${t}' })\n`).join(''), 'utf8')
  }
  const gBili = join(base, 'capbili', 'index.db')
  {
    mkdirSync(dirname(gBili), { recursive: true })
    const db = new DatabaseSync(gBili)
    db.exec('create table sessions (session_id text primary key, created_at integer)')
    db.exec('create table content (hash text primary key, byte_len integer, refcount integer, algo text, bytes blob)')
    db.exec('create table messages (session_id text, seq integer, msg_id text, ref text, role text, kind text, content_hash text)')
    db.prepare('insert into sessions (session_id, created_at) values (?, ?)').run('s1', Math.floor(Date.now() / 1000))
    let seq = 0
    for (const [tool, times] of [['alpha_a', 25], ['alpha_b', 12], ['alpha_c', 3], ['alpha_d', 1]]) {
      for (let index = 0; index < times; index += 1) {
        seq += 1
        const hash = `h${seq}`
        const text = JSON.stringify({ role: 'assistant', contentType: 'tool-call', toolName: tool })
        db.prepare('insert into content (hash, byte_len, refcount, algo, bytes) values (?,?,?,?,?)').run(hash, Buffer.byteLength(text), 1, 'none', Buffer.from(text, 'utf8'))
        db.prepare('insert into messages (session_id, seq, msg_id, ref, role, kind, content_hash) values (?,?,?,?,?,?,?)').run('s1', seq, `m${seq}`, `r${seq}`, 'assistant', 'text', hash)
      }
    }
    db.close()
  }
  const gConfig = normalizeConfig({
    capabilitiesPath: join(base, 'notes/capabilities.md'),
    biliDbPath: gBili,
    pluginRoots: [gPlugins],
    stateDir: join(base, 'state'),
    logPath: join(base, 'logs/cap.log'),
  })
  const gCaps = createCapabilities({ config: gConfig })
  const gExec = (args) => createTools(gConfig).find((tool) => tool.name === 'soul_capabilities').execute(args)

  const cases = [
    ['dsh:记忆检索', async () => (await gExec({ query: '记忆检索', limit: 3 })).text],
    ['dsh:封存 归档', async () => (await gExec({ query: '封存 归档' })).text],
    ['dsh:无query', async () => {
      rememberUserTexts(['zzz', 'qwerty 没有关键词'])
      return (await gExec({})).text
    }],
  ]
  for (const [key, get] of cases) {
    const was = golden[key]
    assert.ok(was, `golden 里没有 ${key}`)
    assert.equal(await get(), was.text, `${key} 的文本变了（缺省 source 必须完全不变）`)
  }
  // 显式 source:'dsh' 与缺省也必须一致
  rememberUserTexts(['zzz', 'qwerty 没有关键词'])
  assert.equal((await gExec({ query: '记忆检索', limit: 3, source: 'dsh' })).text, golden['dsh:记忆检索'].text, "source:'dsh' 与缺省不一致")
  // rows（工具数）也不能变
  assert.equal(gCaps({ query: '记忆检索', limit: 3 }).rows, golden['dsh:记忆检索'].rows, 'rows 变了')
  return `3 条 golden 逐字一致，rows=${golden['dsh:记忆检索'].rows}；显式 dsh 一致`
})

await test('C14', '中文词表与停用词跟 find.mjs 不漂（技能库在就逐字比）', () => {
  const realFind = join(normalizeConfig({}).gamedevSkillsDir, 'find.mjs')
  if (!existsSync(realFind)) return '跳过：本机没装技能库 find.mjs'
  const src = readFileSync(realFind, 'utf8')
  const zhStart = src.indexOf('const ZH = {') + 'const ZH = '.length
  const zhEnd = src.indexOf('\n}', zhStart)
  assert.ok(zhStart > 0 && zhEnd > zhStart, 'find.mjs 里找不到 ZH 表')
  const zh = new Function(`return ${src.slice(zhStart, zhEnd + 2)}`)()
  assert.deepEqual(Object.keys(GAMEDEV_ZH).sort(), Object.keys(zh).sort(), 'ZH 词条集合漂了')
  for (const key of Object.keys(zh)) assert.deepEqual(GAMEDEV_ZH[key], zh[key], `ZH["${key}"] 与 find.mjs 不一致`)
  const stopStart = src.indexOf('const STOP = new Set([') + 'const STOP = new Set('.length
  const stopEnd = src.indexOf('])', stopStart)
  assert.ok(stopStart > 0 && stopEnd > stopStart, 'find.mjs 里找不到 STOP 表')
  const stop = new Function(`return ${src.slice(stopStart, stopEnd + 1)}`)()
  assert.deepEqual([...GAMEDEV_STOP].sort(), [...stop].sort(), 'STOP 表漂了')
  return `ZH ${Object.keys(zh).length} 条 / STOP ${[...stop].length} 词，逐字一致`
})

await test('C15', '真库只读冒烟：本机技能库在 → 「存档」第一条 save-systems（路径为真 INDEX.json）', async () => {
  const realDir = normalizeConfig({}).gamedevSkillsDir
  if (!existsSync(join(realDir, 'INDEX.json'))) return `跳过：${realDir} 里没有 INDEX.json`
  const realConfig = normalizeConfig({ ...config, gamedevSkillsDir: realDir, capabilitiesPath: join(root, 'notes/cap-real.md') })
  const out = await createTools(realConfig).find((tool) => tool.name === 'soul_capabilities').execute({ query: '存档', source: 'gamedev', limit: 3 })
  const first = out.text.split('\n')[1]
  assert.match(first, /^== save-systems/, `真库第一条不是 save-systems：${first}`)
  assert.match(out.text, /skills[\\/]gamedev[\\/]disciplines[\\/]save-systems[\\/]SKILL\.md/, '真库路径不对')
  return `${realDir} → ${first}`
})

// ---------------------------------------------------------------------------
// 开源化（2026-11-03）：后端切换 / 四源注册 / 路径配置化
// 说明：spec 的 O3 与已有 O3（八期真机预算）撞号，这里记作 O3b，REPORT 里有对照表。
// ---------------------------------------------------------------------------

await test('O3b', "spec O3：memoryBackend:'none' 时 soul_recall 不抛错、记忆源返回空", async () => {
  const recall = createRecall({ ...config, memoryBackend: 'none' })
  const out = await recall({ query: '封存 manifest', limit: 3 })
  assert.equal(out.ok, true, 'none 后端不该抛错')
  assert.equal(out.sources.memory, 0, 'none 后端记忆命中应为 0')
  return `memory=${out.sources.memory} active=${out.active.join(',')}`
})

await test('O4', 'spec O4：builtin 在临时目录自动建库，能写入并读回一条记忆', () => {
  const dbPath = join(root, 'builtin', 'soul-memory.db')
  const put = putMemory(dbPath, { id: 'b1', content: '魂引测试条目：预算按条目自身大小算', keywords: ['魂引', '预算'], importance: 3, level: 'rules' })
  assert.equal(put.ok, true, `写入失败：${put.error}`)
  assert.ok(existsSync(dbPath), '没有自动建库')
  const backend = createMemoryBackend({ ...config, memoryBackend: 'builtin', memoryDbPath: dbPath })
  assert.equal(backend.id, 'builtin')
  const found = backend.search('魂引 预算', 3)
  assert.equal(found.entries.length, 1, `读回失败：${JSON.stringify(found)}`)
  assert.deepEqual(backend.listHeads(3), ['魂引测试条目：预算按条目自身大小算'], '「我记得」摘头不对')
  assert.equal(backend.countResident(), 1, '常驻条数口径不对')
  return `entries=${found.entries.length} loc=${found.entries[0].loc} heads/listTier/countResident 均通`
})

await test('O5', 'spec O5：未配置 sealedSegmentsModule / soulIndexDir 时只剩 memory 与 notes，sources 如实列出', async () => {
  const bare = normalizeConfig({
    soulPath: soulOk,
    notesDir,
    memoryDbPath,
    stateDir: join(root, 'state-o5'),
    logPath: join(root, 'logs/o5.log'),
  })
  assert.equal(bare.sealedModule, '', 'sealed 源默认应关闭')
  assert.equal(bare.soulIndexDir, '', 'index 源默认应关闭')
  const out = await createRecall(bare)({ query: '封存 manifest', limit: 3 })
  assert.deepEqual(out.active, ['memory', 'notes'], `启用源不对：${out.active.join(',')}`)
  assert.equal(out.sources.archive, 0)
  assert.equal(out.sources.index, 0)
  assert.match(out.text, /② 封存段（0 条） · 未配置（跳过）/, '封存源没如实写「未配置」')
  return `active=${out.active.join(',')} archive=${out.sources.archive} index=${out.sources.index}`
})

await test('O6', 'spec O6：soulPath 指向临时文件时，readSoul + composeSoul 能读到并生成魂引', () => {
  const tmp = join(root, 'o6-soul.md')
  writeFileSync(tmp, '# T\n\n## 我是谁\n- 开源化测试人格\n\n## 我怎么想\n- 先取证\n', 'utf8')
  const cfg = normalizeConfig({ soulPath: tmp, stateDir: join(root, 'state-o6') })
  assert.equal(cfg.soulPath, tmp)
  const soul = readSoul(cfg.soulPath)
  assert.ok(soul, 'readSoul 读不到临时 soul.md')
  const out = composeSoul({ soul, at: new Date('2026-11-03T20:00:00+08:00'), workspace: 'tmp', maxTokens: 300 })
  assert.match(out.text, /我是谁/, '魂引里没有「我是谁」')
  assert.match(out.text, /开源化测试人格/, '魂引没读到临时文件内容')
  return `tokens=${out.tokens} 首节来自 ${tmp}`
})

// ---------------------------------------------------------------------------
// 待办 A（2026-11-03）：分区索引与标签
// ---------------------------------------------------------------------------

const zoneRoot = join(root, 'zones')
function writeZoneFile(name, entries) {
  mkdirSync(join(zoneRoot, 'memory'), { recursive: true })
  const body = entries.map((entry) => `## ${entry.title}\n\ntags: ${(entry.tags ?? []).join(', ')}\n\n${entry.body}\n`).join('\n')
  writeFileSync(join(zoneRoot, 'memory', `${name}.md`), body, 'utf8')
}
writeZoneFile('work', [
  { title: '部署流程', tags: ['工作', '规则'], body: '插件部署后要重启一次。' },
  { title: '工具选型', tags: ['工作', '事实'], body: '记忆写进库，正文别进魂引。' },
])
writeZoneFile('intimacy', [{ title: '放置偏好', tags: ['亲密', '偏好'], body: '分区正文绝不能进魂引 ZONEBODY。' }])
writeZoneFile('relations', [{ title: '关系层入口', tags: ['日常', '事实'], body: '关系层按文件名倒序取最新。' }])
writeZoneFile('rules', [{ title: '不写未验证', tags: ['工作', '规则'], body: '未验证不许写成已修复。' }])
writeZoneFile('misc', [{ title: '映射不确定的', tags: ['日常', '事实'], body: '映射不确定的统一进 misc。' }])
const zoneMapSample = scanZones(join(zoneRoot, 'memory'))
writeZoneIndex(join(zoneRoot, 'index.jsonl'), buildZoneIndex(zoneMapSample))

await test('O13', '分区索引只有区级行，总行数 ≤ 10', () => {
  const lines = readFileSync(join(zoneRoot, 'index.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
  assert.ok(lines.length <= 10, `索引 ${lines.length} 行，超了 10`)
  const zones = new Set()
  for (const line of lines) {
    const row = JSON.parse(line)
    assert.ok(ZONES[row.zone], `未知分区：${row.zone}`)
    assert.equal(typeof row.count, 'number', 'count 必须是数字')
    zones.add(row.zone)
  }
  assert.equal(zones.size, lines.length, '同一区出现了多行（一条记忆一行就错了）')
  return `${lines.length} 行 / ${lines.length} 区`
})

await test('O14', '魂引 full 与 reload 档都只出现一行【分区】，不出现任何区正文', () => {
  const soul = parseSoul('# T\n\n## 我是谁\n- a\n\n## 我怎么想\n- b\n')
  const zones = buildZoneIndex(scanZones(join(zoneRoot, 'memory')))
  for (const reload of [false, true]) {
    const out = composeSoul({ soul, at: new Date('2026-11-03T20:00:00+08:00'), workspace: 'tmp', maxTokens: 900, zones, reload })
    const hits = out.text.match(/【分区】/g) ?? []
    assert.equal(hits.length, 1, `reload=${reload} 时【分区】出现 ${hits.length} 次`)
    assert.ok(!out.text.includes('ZONEBODY'), '区正文漏进魂引了')
    assert.ok(!out.text.includes('部署流程'), '区条目标题漏进魂引了')
  }
  return 'full/reload 各一行【分区】，无正文'
})

await test('O15', 'soul_recall({zone, tags}) 先过滤再打分，返回项带 zone 与 tags', async () => {
  const cfg = normalizeConfig({
    soulPath: join(zoneRoot, 'soul.md'),
    memoryDbPath,
    stateDir: join(root, 'state-o15'),
    memoryRoot: join(zoneRoot, 'memory'),
    zoneIndexPath: join(zoneRoot, 'index.jsonl'),
    logPath: join(root, 'logs/o15.log'),
  })
  const recall = createRecall(cfg)
  const out = await recall({ query: '部署', zone: 'work', tags: ['工作'], limit: 3 })
  assert.equal(out.active[0], 'zone', '没有走分区检索')
  assert.ok(out.hits.length >= 1, `分区过滤没命中：${out.text}`)
  for (const hit of out.hits) {
    assert.equal(hit.zone, 'work', 'zone 过滤失效（混进了别的区）')
    assert.ok(hit.tags.includes('工作'), `tags 过滤失效：${JSON.stringify(hit.tags)}`)
  }
  const intimacyOnly = await recall({ query: '分区', zone: 'intimacy', tags: ['亲密'], limit: 3 })
  assert.ok(intimacyOnly.hits.every((hit) => hit.zone === 'intimacy'), 'intimacy 过滤失效')
  assert.ok(intimacyOnly.text.includes('[亲密,偏好]'), '返回项没带 tags')
  return `work=${out.hits.length} intimacy=${intimacyOnly.hits.length}`
})

await test('O16', '往 work.md 追加 20 条后，魂引长度变化 ≤ 20 字（只许计数变）', () => {
  const soul = parseSoul('# T\n\n## 我是谁\n- a\n')
  const before = composeSoul({ soul, at: new Date('2026-11-03T20:00:00+08:00'), workspace: 'tmp', maxTokens: 900, zones: buildZoneIndex(scanZones(join(zoneRoot, 'memory'))) })
  const extra = Array.from({ length: 20 }, (_, index) => `## 追加条目 ${index + 1}\n\ntags: 工作, 事实\n\n第 ${index + 1} 条长正文，不许进魂引。\n`).join('\n')
  appendFileSync(join(zoneRoot, 'memory', 'work.md'), `\n${extra}`, 'utf8')
  const after = composeSoul({ soul, at: new Date('2026-11-03T20:00:00+08:00'), workspace: 'tmp', maxTokens: 900, zones: buildZoneIndex(scanZones(join(zoneRoot, 'memory'))) })
  const delta = after.text.length - before.text.length
  assert.ok(Math.abs(delta) <= 20, `魂引长度变化 ${delta} 字（>20）`)
  assert.match(after.text, /work 22/, `计数没跟上：${(after.text.match(/【分区】[^\n]*/) ?? [''])[0]}`)
  return `before=${before.text.length} after=${after.text.length} delta=${delta}`
})



const width = Math.max(...results.map((r) => r.title.length))
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL'
  console.log(`${mark} ${r.id.padEnd(6)} ${r.title.padEnd(width)}  ${r.detail}`)
}
console.log(`\n${results.length - failed}/${results.length} 通过；靶子目录 ${root}`)
const observedResults = results.filter((r) => r.id.startsWith('O'))
if (observedResults.length > 0) {
  const okCount = observedResults.filter((r) => r.ok).length
  console.log(`新增观测断言（O*）：${okCount}/${observedResults.length} 通过`)
}
rmSync(root, { recursive: true, force: true })

if (failed > 0) {
  console.error(`失败 ${failed} 条`)
  process.exit(1)
}
