# 嵌入说明（1.0）

> 这是 `@ly-ina/dsh-soulweave/sdk` 的接入指南。19 个承诺导出，**零 `node:` 依赖**——
> 静态扫描和运行时 loader 两道都验过（`tools/probe-no-node.mjs`）。
> 跑得通的样例：`examples/sdk-quickstart.mjs`（10 条断言）、`examples/embed-demo.mjs`。

## 1. 先装配（Node 两行）

SDK 面只保证「算得对」，不替宿主选文件系统、也不替宿主选 sqlite 实现。
Node 下把这两行放在所有 import 之前：

```js
import '@ly-ina/dsh-soulweave/io-node'                // fs / os / path / zstd / 动态加载
import '@ly-ina/dsh-soulweave/storage-node-sqlite'    // node:sqlite 驱动
```

然后只用承诺面：

```js
import { initMemoryDb, putMemory, search, health } from '@ly-ina/dsh-soulweave/sdk'
```

漏了装配会得到一条明确的错（`soulweave: 宿主 IO 未配置（readFileSync）…`），
不会静默写坏东西。

## 2. 不是 Node 的宿主

`configureIo({...})` 注入宿主能力，`configureStorage(driver)` 注入存储驱动。
需要实现的方法看 `io.mjs` 里的 `empty` 表，最少这几个：

| 能力 | 必须 | 说明 |
|---|---|---|
| `readFileSync / writeFileSync / appendFileSync` | 是 | 读 soul、写笔记与日志 |
| `existsSync / mkdirSync / statSync / readdirSync` | 是 | 路径探测与建目录 |
| `homedir / env / cwd / argv / platform` | 是 | 找配置、找会话目录 |
| `zstdCompressSync / zstdDecompressSync` | 否 | 只有会话日志解析（`surface.mjs`）用 |
| `requireResolve / spawnProcess` | 否 | 只有可选插件加载与原文库检索用 |
| `driver` | 是 | 形状 = `node:sqlite` 的 `DatabaseSync`：`open(path,{readOnly})` → `{prepare,exec,close}` |

浏览器里**不能**直接用：这套库的持久化就是 SQLite 文件，没有远端后端。
要上 Web，得先写一个走 HTTP 的 driver —— 契约只有 `open/prepare/exec/close`，
但 `prepare().all()/get()/run()` 的同步语义意味着后端必须是同步可用的（Worker + SharedArrayBuffer 或本地缓存）。

## 3. 一轮对话的最小顺序

```js
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '@ly-ina/dsh-soulweave/io-node'
import '@ly-ina/dsh-soulweave/storage-node-sqlite'
import {
  initMemoryDb, putMemory, search, putTodo, listTodos, parseDue, anchorOf,
  composeSoulState, renderDueLine, routeRecords, health,
} from '@ly-ina/dsh-soulweave/sdk'

const db = join(mkdtempSync(join(tmpdir(), 'soulweave-')), 'memory.db')
initMemoryDb(db)                                        // 建表；幂等

putMemory(db, { level: 'user', project: 'demo', content: '他最近在准备辞职，很焦虑' })
search(db, ['辞职', '焦虑'], 5)                          // → { entries: [{ loc, snippet }], note }

putTodo(db, { content: '周三前把简历改完', due: '周三' })
listTodos(db, { status: 'pending' })
anchorOf('t-mwx3p1cz-tut9')                              // → 'tut9'，※结 靠它结账
parseDue('一小时内')                                      // → { at, iso, kind, matched, … }

health(db)                                               // → { ok, stage, records, journalMode, … }
```

`composeSoulState` 出的是每轮会变的段（时间、工作区、未结数）；稳定段另有实现，
分开是为了不破坏前缀缓存。

## 4. 三个坑

**① 决策层不在这一层。**
「什么时候注入、每轮几条、冷却多久、超预算怎么砍」都在 `adapters/dsh/prestep.mjs`，
和 DSH 的 `agent/pre-step` 钩子长在一起。这些状态是**进程内 Map**
（`whenCooled` / `recallCooled` / `triggerCooled` / `stableSent`），多实例各算各的，重启清空。
服务端要自己实现。

**② 多用户要自己隔离。**
每用户一份 soul 文本 + 一个 `memory.db`。SQLite 记得开 `WAL` + `busy_timeout`，
否则同一用户多端同时聊会 `SQLITE_BUSY`。

**③ 检索是纯子串 AND，没有分词。**
`search()` 把查询词和 `title + content + keywords + project` 做小写子串匹配，**所有词都命中才算**。
中文没有分词：记忆里写「很焦虑」，用户说「心里堵得慌」——一个字都命中不了。
情感聊天场景建议自己换检索（向量，或先过一遍关键词抽取）。

## 5. 不在这层里的东西

- 注入时机与去重（DSH 钩子层）
- 每轮 token 预算的**执行**（`planBudget` 在 core 里，砍不砍由调用方决定）
- 面板 UI、配置写入、cordis 插件装配
- 加密（不提供，记忆库是明文 SQLite）

## 6. 稳定性

`sdk.mjs` 的 19 个导出是承诺面，`check.mjs` 的 R33 守着三条：
不许碰 `node:`、必须齐、不许无限膨胀（上限 40）。
更深的模块（`core/*`、`memory/*`）随时可能改，但都不会引入 `node:` ——
这一条由 `tools/check-layers.mjs` 机器守着。

## 7. 想反馈什么

1. 十句真实对话里，检索**命中了哪些、漏了哪些**
2. soul 文本里，有哪想写的写不进去
3. 哪里最想有个现成函数、却只能自己拼
4. 单用户一轮注入多少 token
