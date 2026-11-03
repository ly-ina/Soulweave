#!/usr/bin/env node
/**
 * 干净安装验证（交办单 §1）：证明「别人只装这个包、只配一个 soulPath」也能跑通。
 *
 * 做法：把包按 package.json 的 `files` 白名单复制进临时目录里的
 * `node_modules/@ly-ina/dsh-soulweave/`，再从那里 import —— 于是插件的
 * PLUGIN_DIR、默认 state/ 目录、builtin 库全都落在临时根内，跑完整个删掉。
 * 不读、不写本机任何真实目录（DSH_HOME 也临时指到一个空目录）。
 *
 * 复跑：node clean-install.mjs
 * 期望最后一行：R1..R8 OK
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))

const results = []
const ok = (id, detail) => {
  results.push(id)
  console.log(`${id} OK  ${detail}`)
}

/** 全程唯一的外部可写根：系统临时目录下的一次性目录。 */
const root = mkdtempSync(join(tmpdir(), 'soul-clean-install-'))
const pkgDir = join(root, 'node_modules', '@ly-ina', 'dsh-soulweave')
const homeDir = join(root, 'home')
const soulPath = join(root, 'soul.md')

/** 复制前记下临时根外不该被写的位置，收尾时比 mtime。 */
const WATCH = [join(SRC, 'soul.md'), join(SRC, '.state'), join(SRC, 'memory'), join(SRC, 'soul-memory.db')]
const before = new Map(WATCH.map((p) => [p, existsSync(p) ? statSync(p).mtimeMs : null]))

try {
  // ---- R1：临时根 + 示例 soul.md（内容取自 soul.example.md，不碰任何私人 soul.md）
  mkdirSync(pkgDir, { recursive: true })
  mkdirSync(homeDir, { recursive: true })
  const copied = []
  for (const entry of pkg.files ?? []) {
    const from = join(SRC, entry)
    if (!existsSync(from)) continue
    cpSync(from, join(pkgDir, entry), { recursive: true })
    copied.push(entry)
  }
  writeFileSync(soulPath, readFileSync(join(SRC, 'soul.example.md'), 'utf8'), 'utf8')
  assert.ok(copied.includes('index.js'), '包内缺 index.js')
  ok('R1', `临时根 ${relative(tmpdir(), root)}；复制 ${copied.length} 个 files 白名单条目；示例 soul.md 已写入`)

  // 环境隔离：默认目录 / profile 配置查找都落在临时根内。
  process.env.DSH_HOME = homeDir

  // ---- R2：默认配置 + 只给 soulPath
  const mod = await import(pathToFileURL(join(pkgDir, 'index.js')).href)
  const handlers = new Map()
  const tools = new Map()
  const ctx = {
    on: (event, handler) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    tools: {
      register: (tool) => {
        tools.set(tool.name, tool)
        return () => tools.delete(tool.name)
      },
    },
    logger: () => ({ warn() {}, info() {}, debug() {} }),
  }
  const dispose = mod.apply(ctx, { soulPath })
  assert.equal(typeof dispose, 'function', 'apply 没返回卸载函数')
  ok('R2', `apply(ctx, {soulPath}) 成功；注册事件 ${[...handlers.keys()].join(',')}`)

  // ---- R3：触发一次 agent/pre-step
  const preStep = handlers.get('agent/pre-step')
  assert.equal(typeof preStep, 'function', '没注册 agent/pre-step')
  const messages = []
  const decision = await preStep(
    { turn: 1, step: 1, agent: { session: { id: 'clean-install', cwd: root } }, messages: [], signal: undefined },
    async () => ({ kind: 'enter', messages }),
  )
  assert.ok(Array.isArray(decision?.messages), 'pre-step 没返回 decision.messages')
  ok('R3', `agent/pre-step 返回 ${decision.messages.length} 条注入消息`)

  // ---- R4：魂引生成 + source.kind === 'soul' + 读到示例正文
  const soulMessage = decision.messages.find((m) => m?.source?.kind === 'soul')
  assert.ok(soulMessage, '注入里没有 source.kind === "soul" 的消息')
  const soulText = (soulMessage.content ?? []).map((part) => part.text ?? '').join('')
  assert.ok(soulText.includes('示例助手'), `魂引没读到示例 soul.md：${soulText.slice(0, 80)}`)
  assert.ok(soulText.includes('【现在在哪】') && soulText.includes('【怎么查】'), '魂引缺「现在在哪 / 怎么查」')
  ok('R4', `魂引 ${soulText.length} 字，含示例正文与两节固定内容`)

  // ---- R5：九个工具
  const expected = [
    'soul_recall',
    'soul_persist',
    'soul_toolout',
    'soul_cue',
    'soul_capabilities',
    'soul_tier',
    'soul_surface',
    'soul_relations',
    'soul_mood',
  ]
  const missing = expected.filter((name) => !tools.has(name))
  assert.equal(missing.length, 0, `缺工具：${missing.join(',')}`)
  ok('R5', `${tools.size} 个工具：${[...tools.keys()].join(' / ')}`)

  // ---- R6：soul_recall 走 builtin，自动建库，空结果不抛错
  const recall = tools.get('soul_recall')
  const first = await recall.execute({ query: '测试' })
  assert.equal(first?.ok, true, `首次 recall 不成功：${JSON.stringify(first).slice(0, 200)}`)
  assert.ok(first.sources, 'recall 没返回 sources 计数')
  assert.equal(first.sources.archive, 0, '默认配置不该有封存源')
  assert.equal(first.sources.index, 0, '默认配置不该有原文库源')
  const dbPath = join(pkgDir, '.state', 'soul-memory.db')
  assert.ok(existsSync(dbPath), `builtin 库没自动建在包目录的 .state 下：${dbPath}`)
  ok('R6', `recall 空结果 ok=true；sources=${JSON.stringify(first.sources)}；自动建库 ${relative(root, dbPath)}`)

  // ---- R7：往 builtin 库写一条，再查能读回
  const builtin = await import(pathToFileURL(join(pkgDir, 'memory-builtin.mjs')).href)
  const wrote = builtin.putMemory(dbPath, {
    level: 'fact',
    content: '干净安装测试写的一条记忆：安装目录在临时根里。',
    title: '干净安装',
    keywords: '干净 安装 临时根',
    project: '全局',
    importance: 1,
  })
  assert.equal(wrote?.ok, true, `putMemory 失败：${JSON.stringify(wrote).slice(0, 200)}`)
  const second = await recall.execute({ query: '干净安装' })
  assert.equal(second?.ok, true, '写入后 recall 失败')
  assert.ok((second.sources?.memory ?? 0) >= 1, `写入后没读回：${JSON.stringify(second.sources)}`)
  assert.ok((second.text ?? '').includes('干净安装'), `返回正文里没有这条记忆：${(second.text ?? '').slice(0, 120)}`)
  ok('R7', `写入 1 条后 recall 读回 memory=${second.sources.memory}`)

  // ---- R8：产物只落在临时根
  const escaped = []
  for (const [path, stamp] of before) {
    const now = existsSync(path) ? statSync(path).mtimeMs : null
    if (now !== stamp) escaped.push(path)
  }
  assert.equal(escaped.length, 0, `临时根外被写了：${escaped.join(', ')}`)
  const stateEntries = readdirSync(join(pkgDir, '.state')).join(',')
  ok('R8', `临时根外无写入；包目录 .state 内容：${stateEntries}`)

  dispose()
} finally {
  process.env.DSH_HOME = undefined
  rmSync(root, { recursive: true, force: true })
  assert.equal(existsSync(root), false, `临时根没清理掉：${root}`)
}

console.log('R1..R8 OK')
