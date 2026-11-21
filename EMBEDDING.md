# 嵌入说明（现状）

> **这不是 SDK 文档。** 魂织目前是一个 DSH 插件，下面写的是「把它的两层库拿进别的 Node 程序」时**现在真实能用**的部分、**必须自己补**的部分，以及三个已知的坑。
>
> 接口不承诺稳定，随时可能改。跑得通的样例见 `examples/embed-demo.mjs`。

## 1. 能用什么

| 入口 | 内容 | 宿主依赖 |
|---|---|---|
| `@ly-ina/dsh-soulweave/core` | 人格解析、稳定段/动态段组装、预算、检索、评分、token 估算 | 零 |
| `@ly-ina/dsh-soulweave/memory` | SQLite 记忆库、检索、when 情境签名、tier 降权 | 零（只用 `node:sqlite`） |

要求 **Node ≥ 22.5**（`node:sqlite` 内置）。零 npm 依赖，不用构建。

根入口 `.`（`index.js`）是 **DSH 插件**，带 `inject = ['tools', 'webServer']`，它不是库入口。

## 2. 一轮对话的最小顺序

```js
import { ensureDb, putMemory, search } from '@ly-ina/dsh-soulweave/memory'
import { parseSoul, composeSoulStable } from '@ly-ina/dsh-soulweave/core'

// 1) 人格：每人一份 soul 文本
const soul = parseSoul(soulText)           // 认「## 身份 / ## 认知 / ## 禁令 / ## 外交」四节

// 2) 记忆：用户说过的话
ensureDb(dbPath)
putMemory(dbPath, { level: 'user', project: 'demo', content: '他最近在准备辞职，很焦虑' })

// 3) 按当前这句话检索
const hits = search(dbPath, ['辞职', '焦虑'], 5)   // → { entries: [{ loc, snippet }], note }

// 4) 拼成可注入的文本
const stable = composeSoulStable({ soul })         // → { text, tokens, take, warnings }
const injection = [stable.text, ...hits.entries.map((e) => `- ${e.snippet}`)].join('\n\n')
```

`composeSoulStable` 只出「稳定段」（身份/认知/禁令）。时间、工作区、未结计数这些每轮会变的东西在 `composeSoulState`，要自己调——两者分开是为了不破坏前缀缓存。

## 3. 三个坑

**① 决策层不在这一层。**
「什么时候注入、每轮几条、冷却多久、超预算怎么砍」全在 `adapters/dsh/prestep.mjs` 里，和 DSH 的 `agent/pre-step` 钩子长在一起。这些状态是**进程内 Map**（`whenCooled` / `recallCooled` / `triggerCooled` / `stableSent`），多实例会各算各的，重启就清空。服务端要自己实现。

**② 多用户要自己隔离。**
灵魂和记忆库都是「一份 per 用户」：每用户一个 `soul` 文本 + 一个 `memory.db`。SQLite 记得开 `WAL` + `busy_timeout`，否则同一用户多端同时聊会 `SQLITE_BUSY`。

**③ 检索是纯子串 AND，没有分词。**
`search()` 把查询词和 `title + content + keywords + project` 做小写子串匹配，**所有词都命中才算**。中文没有分词：记忆里写「很焦虑」，用户说「心里堵得慌」——一个字都命中不了。
情感聊天场景建议自己换检索（向量、或者先过一遍关键词抽取）。

## 4. 不在这两层里的东西

- 注入时机与去重（DSH 钩子层）
- 每轮 token 预算的**执行**（`planBudget` 在 core 里，但要不要按它砍、怎么砍，由调用方决定）
- 面板 UI、配置写入、cordis 插件装配
- 加密（魂织不提供，记忆库是明文 SQLite）

## 5. 想反馈什么

用真实对话跑过之后，最有用的是这四条：

1. 十句真实对话里，检索**命中了哪些、漏了哪些**
2. soul 文本里，有哪想写的写不进去（现在只认四节）
3. 哪里最想有个现成函数、却只能自己拼
4. 单用户一轮注入多少 token（demo 里是 100）