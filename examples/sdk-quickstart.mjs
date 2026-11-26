#!/usr/bin/env node
// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * examples/sdk-quickstart.mjs —— 接入魂织的五步闭环：
 *   建库 → 写记忆 → 写待办 → 读现状段 → 按指针去检索。
 *
 * 只碰一样东西：`../sdk.mjs` 的承诺面（发布后是 `@ly-ina/dsh-soulweave/sdk`）。
 * 建库用 `initMemoryDb`（0.5.6 起在承诺面里），不用 import 任何内部模块。
 *
 * 不碰 index.js、不碰 adapters、不需要 ctx。普通 Node 服务端可以照抄。
 * 自带临时库，跑完就删，不碰你自己的记忆。
 *
 * 需要 Node >= 22.5（`node:sqlite`），启动会打一条 ExperimentalWarning，正常。
 *
 * 跑：node examples/sdk-quickstart.mjs
 */
// 1.0：Node 的 IO 与 sqlite 驱动要显式装配（非 Node 宿主改 configureIo）。
import '../io-node.mjs'
import '../storage/node-sqlite.mjs'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  anchorOf,
  composeSoulState,
  health,
  listDueItems,
  listTodos,
  parseDue,
  putMemory,
  putTodo,
  initMemoryDb,
  renderHealth,
  search,
} from '../sdk.mjs'
const project = 'demo'
const now = new Date()
const dir = mkdtempSync(join(tmpdir(), 'soulweave-sdk-'))
const dbPath = join(dir, 'memory.db')
const pad = (n) => String(n).padStart(2, '0')
const localIso = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`

// ── 0. 建库 ───────────────────────────────────────────────────────────────
// initMemoryDb 建完就关句柄（Windows 上留着的句柄会锁住目录），只返回体检结果。
// 它不是必须的：putMemory / putTodo 自己会按需建库。但启动时调一次，
// 库建不起来就当场失败，而不是等第一条记忆写不进去才发现。
const boot = initMemoryDb(dbPath)
console.log(`[0] 库 ${dbPath}`)
console.log(`    体检 ${renderHealth(boot)}`)
// health() 是唯一能区分「没命中」和「库坏了」的东西 —— 读路径全是静默降级，
// 不体检的话 search() 返回空集，你分不清是没记忆还是打不开库。
// busy= 是 openDb 打开时设的 4000ms（与写连接同一套 pragma），不是只读连接的默认 0。

// ── 1. 写记忆 ─────────────────────────────────────────────────────────────
// level 决定进哪一档：soul / rules / user / project / fact / topic / lesson。
// 服务端一般只用两种：user（关于这个人）、fact（关于世界）。默认 fact。
const m1 = putMemory(dbPath, {
  level: 'fact',
  project,
  content: '记忆检索是纯子串 AND 匹配：没有分词，也没有向量',
  keywords: ['检索', '实现'],
  importance: 3,
})
const m2 = putMemory(dbPath, {
  level: 'user',
  project,
  content: '伊纳在写《AI时代》，用 RPG Maker 发布',
})
// 正文一字不差再写一次不会多出一条：按 sha 去重（只跟 active 比，archived 允许重写）。
const dup = putMemory(dbPath, { level: 'fact', project, content: '记忆检索是纯子串 AND 匹配：没有分词，也没有向量' })
console.log(`[1] 记忆 ${m1.id} · ${m2.id}${dup.dedup ? ` · 同正文再写一次被去重（还是 ${dup.id}）` : ''}`)

// ── 2. 写待办 ─────────────────────────────────────────────────────────────
// due 是**本地时区的 ISO 串**（不带 Z / +08:00 后缀），由 parseDue 产出。
// parseDue 认不出时间就返回 null —— 这时降级成记忆，绝不挂一个错的 due：
// 宁可少一条提醒，不给一条错的（memory/route.mjs 里的同一条规则）。
const phrase = '明天上午九点交材料'
const due = parseDue(phrase, now)
if (due === null) {
  putMemory(dbPath, { level: 'project', project, content: phrase })
  console.log(`[2] 「${phrase}」解析不出时间 → 降级成记忆`)
} else {
  const t1 = putTodo(dbPath, {
    project,
    content: '交材料',
    due: due.iso,
    // 时刻只是推断出来的（比如「明天八点」没说上午下午）就记一笔：
    // 现状段会渲染成「约 09:00」，让人一眼看出这是猜的，不是模型说清的。
    due_assumed: due.assumedTime || due.assumedDate,
  })
  console.log(`[2] 待办 ${t1.id} → ${due.iso}（锚点 ${anchorOf(t1.id)}）`)
}
// 过期那条直接给绝对时间：parseDue 只往后看，不产过去时间。
putTodo(dbPath, { project, content: '对账', due: localIso(new Date(now.getTime() - 2 * 3600_000)) })

// ── 3. 读现状段 ───────────────────────────────────────────────────────────
// 现状段每轮都注入，所以它**只给指认和计数**，正文留给检索。
const pending = listTodos(dbPath, { project, status: 'pending', limit: 20 })
// 默认窗口是 now-72h ~ now+24h；示例放宽到 +48h，保证任意钟点跑都能看见「明天」那条。
const dueItems = listDueItems(dbPath, { now: now.getTime(), leadMs: 48 * 3600_000 })

const state = composeSoulState({
  at: now,
  workspace: 'E:/demo',
  // 「在场」需要一个非空信号才渲染（present.pending / present.memories 的条数）；
  // 只给 present.project 不给内容，这一行是不出来的。
  present: { project, pending: pending.map((t) => t.content) },
  pending: pending.map((t) => t.content),
  dueItems: dueItems.items,
})
console.log(`[3] 现状段 ${state.chars} 字 / ${state.tokens} tokens\n`)
console.log(state.text)

// ── 4. 按指针去检索 ───────────────────────────────────────────────────────
// 上面那句「→ soul_recall('未结')」不是装饰：正文真要靠检索拿。
const hit = search(dbPath, ['检索'], 5)
console.log(`\n[4] 搜「检索」命中 ${hit.entries?.length ?? 0} 条：`)
for (const e of hit.entries ?? []) console.log(`    ${e.loc}｜${e.snippet}`)

try {
  rmSync(dir, { recursive: true, force: true })
} catch {
  /* Windows 偶发 EPERM：临时目录交给系统清，不影响示例结论 */
}

console.log(`
接到自己的服务里，还有三件事这个例子替不了你：
  1. 一用户一份库（或一个 project）。魂织不做多租户隔离。
  2. busy_timeout 已由 builtin 设成 4000ms，但 journal_mode 默认还是 delete ——
     多实例并发写自己开 WAL，开没开 health() 会告诉你。
  3. 捕获端。想接 memprobe 的实时路由（REPORT-2026-11-25 第八节第一条），
     捕获器不要重写，落盘之后加三行就够：

       import { routeRecords, renderRouteResult } from '@ly-ina/dsh-soulweave/sdk'
       const r = routeRecords(records, { dbPath, now: new Date(event.time), project })
       if (r.warnings.length > 0) ctx.logger?.warn?.(renderRouteResult(r))

     但先手动跑几轮 node tools/route-records.mjs --dry-run 看命中率，再接实时。
`)

