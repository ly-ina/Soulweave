# records.jsonl 格式契约

> 消费者：`tools/route-records.mjs`（→ `memory/route.mjs` 的 `routeRecords()`）
> 生产者：`<workspace>\plugins\dsh-memprobe\index.js`（dsh 插件，见文末「生产端在哪」）

---

## 1. 最小契约（下游只读这三个）

`route-records.mjs` 只依赖以下三个字段。**别的都可以没有**：

```json
{
  "ts": "2026-11-25T03:15:00.000Z",
  "sessionId": "s-b5dec218",
  "records": [
    { "kind": "todo", "text": "明天九点交材料" }
  ]
}
```

| 字段 | 类型 | 用途 | 缺失时 |
|---|---|---|---|
| `ts` | ISO 8601 字符串 | 作为「现在」的基准——「明天九点」是**相对这句话说出的时刻**算的 | 用文件读取时的当前时间（语义会漂，不推荐依赖） |
| `sessionId` | 字符串 | 溯源，目前只透传不参与逻辑 | 无所谓 |
| `records[].kind` | `recall` \| `todo` \| `settle` | 决定走哪条路由 | 默认按 `recall` 处理 |
| `records[].text` | 字符串 | 要落库的正文 | 空串直接跳过 |

**为什么 `ts` 必须准确**：`2026-11-20` 那轮说的「明天九点」是 `11-21 09:00`。如果用导入时刻当基准，会算成导入日期的明天——差十天。

---

## 2. 完整字段（memprobe 实际写什么）

生产端会写更多字段，都是**观测用**，下游忽略即可：

```json
{
  "ts": "2026-11-25T03:15:00.000Z",
  "sessionId": "s-b5dec218",
  "turn": 12,
  "step": 3,
  "seq": 874,
  "model": "qwen3-8b",
  "triggers": { "recall": "※记", "todo": "※办", "settle": "※结" },
  "counts": { "recall": 1, "todo": 2, "settle": 1 },
  "records": [
    { "kind": "recall", "text": "WAL 对写写无效", "line": 8 },
    { "kind": "todo", "text": "明天九点交材料", "line": 10 },
    { "kind": "settle", "text": "k3f9", "line": 12 }
  ],
  "emptyLines": [14],
  "leak": { "live": false, "settled": false },
  "headLive": "用户想要…",
  "headSettled": "好的，我看了…",
  "chars": 2140,
  "paragraphs": 6
}
```

| 字段 | 说明 |
|---|---|
| `counts` | 按 kind 分类计数，**验证 B1 命中率就看这个**，不用展开 `records` |
| `records[].line` | 1 基行号，回溯原文用 |
| `emptyLines` | 写了触发词但没跟内容的行号（1 基）——这是「模型会写词但写不全」的信号 |
| `leak.live` / `leak.settled` | 触发词是否出现在**摘要位置上**（会漏给用户看）。应为 `false` |
| `headLive` / `headSettled` | 摘要首行内容，泄漏时用来定位 |

---

## 3. 一行一条消息，一条消息可含多条记录

一个 `assistant/message` 事件里可能有多个 reasoning block、每个 block 里可能有多条触发词。
生产端的做法是**一个 block 命中就写一行**，`records` 数组里放该 block 的全部命中。

下游按 `records` 逐条路由，所以一行里几条都行。

---

## 4. 去重与幂等

- 生产端按 `event.seq + blockIndex` 去重，同一事件重复投递不会重复写。
- 下游 `putMemory` 自带 `sha` 去重，同内容重复导入不会产生副本（`dedup: true`）。
- 但 `putTodo` **没有**去重——同一句「明天九点交材料」导两次会是两条待办。所以**别重复导入同一个文件**。

---

## 5. 生产端在哪

```
<workspace>\plugins\dsh-memprobe\
├── index.js              dsh 插件：监听 session/event 的 assistant/message，抽 reasoning 里的触发词 → 写 JSONL
├── lib/extract.mjs       提取逻辑（多触发词、泄漏判定、空标记），54 项自测
├── cordis.patch.yml      挂载配置（insert 到 profiles 的 bundle）
├── check.mjs             54/54
├── smoke.mjs             22/22，模拟宿主事件做端到端落盘
└── tools/demo-self.mjs   WorkBuddy 侧自测（宿主不给 reasoning，只能喂文本）
```

**它不是独立仓库，也不在 soulweave 里。** 也没有 git 版本控制——是 `<workspace>\plugins\` 下的一个本地插件目录。

为什么分开放：memprobe 是**探针**（运行时挂进 dsh，监听事件、只写 JSONL），
soulweave 是**引擎**（不关心事件从哪来，只认 `records`）。两者靠这个 JSONL 格式解耦。

落库时机由消费者决定：

| 方式 | 做法 | 适合 |
|---|---|---|
| 手动批处理 | `node tools/route-records.mjs --in … --db …` | 先观察一段时间，确认命中率 |
| 定时批处理 | 把上面那条挂 cron / 开机脚本 | 每天落一次 |
| 实时 | memprobe 里直接 `import { routeRecords }` 调用 | 命中率验证过、且接受探针承担写库职责之后 |

**推荐先手动跑几轮**：如果 `※办` 大量因为解析不出日期被降级，说明要改 `soul.md` 的约束，而不是急着接实时。
