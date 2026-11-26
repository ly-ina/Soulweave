# API 参考

> 本文件由 `node tools/gen-api.mjs` 从源码 JSDoc 生成，**不要手改**。
> 改了签名就重新生成；CI 会跑 `--check`，过期会直接失败。

只列 `sdk.mjs` **显式导出**且**有 JSDoc 摘要**的 API。
内部 API 用 `--all` 查看；公开但没写摘要的在文末列名单。

统计：共 425 个导出；公开 20 个，其中 20 个有文档、0 个待补。

## `core/soul-index.mjs`

### `searchSoulIndex(options = {})`

在原文库里检索。

| 参数 | 说明 |
|---|---|
| `options` |  |

**返回** `{ok, entries, note, degraded, reason?, stale?}`； `entries` 每条是 `{when, role, origin, sid, seq, snippet, score}`。

## `core/soul.mjs`

### `renderDueLine(items, options = {})`

渲染现状段的 ⏰ 行（到期 / 临近）。

| 参数 | 说明 |
|---|---|
| `items` |  |
| `[options]` |  |

**返回** 形如 `⏰ 今天 15:00 交材料 [k3f9] · 已过期 1 条：对账 [b7c1]`；无内容返回 ''

### `composeSoulState(input = {})`

拼出「现状段」：在场 / 未结待办 / 分区计数 / 到期提醒。

| 参数 | 说明 |
|---|---|
| `[input]` | 见本文件里 state 的输入形状 |

**返回** 现状段文本；完全没有内容时返回空串

## `memory/anchor.mjs`

### `anchorOf(id)`

从 todo id 取短锚点；格式不符返回空串（宁可不用锚点，也不给一个错的）。

### `looksLikeAnchor(value)`

这串东西看起来像不像锚点。

### `parseSettle(raw)`

解析 `※结` 后面的正文。

### `renderAnchored(content, id)`

现状段里渲染锚点：`交材料 [k3f9]`；没有锚点就只给内容。

## `memory/builtin.mjs`

### `putMemory(dbPath, memory = {})`

写入/更新一条记忆。O4 的「写入并读回」就走它，也给未来的 import 工具留口子。

### `putTodo(dbPath, todo = {})`

todo：生命周期只有 pending / done / stale。

### `setTodoStatus(dbPath, id, status)`

改待办状态（pending / done / stale）。

| 参数 | 说明 |
|---|---|
| `dbPath` | 库路径 |
| `id` | 待办 id |
| `status` | 新状态 |

### `listTodos(dbPath, { project = '', status = 'pending', limit = 20 } = {})`

列待办。

| 参数 | 说明 |
|---|---|
| `dbPath` | 库路径 |
| `[options]` | 过滤与条数 |

### `listDueItems(…)`

到期扫描：给「现状段 ⏰ 行」用。

### `search(dbPath, words, limit)`

关键词检索：所有词都要在 title/content/keywords/project 的并集里出现； 打分 = 命中词数*10 + 标题命中*6 + importance + 近期新鲜度（30 天内 +2）。 返回结构与 meow 后端一致：{ entries:[{loc,snippet}], note }。

## `memory/health.mjs`

### `health(dbPath)`

检查一个记忆库。

| 参数 | 说明 |
|---|---|
| `dbPath` | 库路径 |

**返回** {{ ok: boolean, stage: string, reason: string, path: string, records: number|null, journalMode: string|null, busyTimeout: number|null, sizeBytes?: number, tables?: number }}

### `initMemoryDb(dbPath)`

首次使用时建库，建完立刻关句柄，再做一次只读体检。幂等，可以每次启动都调。

| 参数 | 说明 |
|---|---|
| `dbPath` | 库路径 |

**返回** 与 health() 同形状，可直接交给 renderHealth()

### `renderHealth(h)`

一行摘要，给日志和工具返回用。

### `isBrokenSearchResult(result)`

判断一次 `search()` 的返回是否代表「库坏了」而不是「没命中」。

## `memory/route.mjs`

### `routeRecords(records, options = {})`

把一批提取结果写进记忆库。

| 参数 | 说明 |
|---|---|
| `records` | extractRecords().records |
| `options` |  |

**返回** {{ ok: boolean, written: { memories: Array, todos: Array, settled: Array }, failed: Array<{kind:string,text:string,reason:string}>, warnings: Array<{kind:string,text:string,note:string}> }}

### `renderRouteResult(result)`

一行摘要，给 CLI 和日志用。

## `memory/time.mjs`

### `parseDue(text, now = new Date())`

从一句话里解析到期时间。

| 参数 | 说明 |
|---|---|
| `text` | 待办正文 |
| `[now]` | 基准时间 |

**返回** null 表示**认不出**——调用方必须据此降级，不许拿当前时间兜底。
