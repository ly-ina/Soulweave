# 工程说明

面向要改这份代码、或者想搞清楚它凭什么敢说自己「解耦」的人。日常使用看 [README](../README.md)。

## 包结构

单包多入口：零构建、零 npm 依赖、没有 `node_modules`。

```
dsh-soulweave/
├── index.js              # 插件入口：导出 apply(ctx, config)
├── io.mjs                # 宿主门面（零 node:，注入式；对接 Node 见 io-node.mjs）
├── io-node.mjs           # Node 实现：fs / os / env / spawn / zstd / 动态加载
├── path.mjs              # 零依赖路径运算（node:path 的替身）
├── sha256.mjs            # 零依赖 SHA-256（node:crypto 的替身）
├── cordis.patch.yml      # 默认配置（profile 里写了 config 会整体覆盖它）
├── soul.example.md       # 人格模板
├── panel-client.js       # 侧边栏设置面板（可选）
├── core/                 # 纯函数：配置、预算、魂引拼装、检索、校验
│   ├── config.mjs
│   ├── budget.mjs
│   ├── hybrid.mjs        # 与 memory/hybrid.mjs 必须字节一致
│   ├── recall.mjs
│   ├── toolout.mjs
│   └── validate.mjs      # 入参清洗 + guardTool 统一兜底
├── memory/               # 记忆后端：builtin / legacy(meow) / decay / when
├── adapters/dsh/         # 只属于 DSH 的接线：prestep、apply、面板
└── tools/                # 分层守卫、检索基准等辅助脚本（随包发布）
    ├── check-layers.mjs
    └── bench-recall.mjs
```

## 分层约束（机器强制）

```
adapters/dsh  →  core  →  memory
                   ↑
              io.mjs（根）
```

`node tools/check-layers.mjs` 会拦下这些：

- `core/`、`memory/`、`storage/` import **任何** `node:*`（1.0 起，连 `path` / `crypto` / `url` 也不行）；
- `core/`、`memory/` 读写 `process.env` / `process.cwd()`；
- `memory/` 反向 import `core/`；
- `core/hybrid.mjs` 与 `memory/hybrid.mjs` 不一致；
- 除 `storage/driver.mjs` 外任何文件 import `node:sqlite`。

`io.mjs` 放在根目录而不是 `core/`，因为 `memory/`、`storage/` 也要用它——放 `core/` 就成了反向依赖。

### 为什么要有 `io.mjs`

- **可测**：`configureIo({ readFileSync: () => { throw ... } })` 能注入只读磁盘、缺文件、spawn 失败，不用真去改权限。
- **可移植**：`env()` / `cwd()` / `platform()` 集中一处；宿主实现（`io-node.mjs`）是唯一碰 `node:` 的地方。
- **可审计**：`grep -r "node:" core/ memory/ storage/` 只该命中 `storage/driver.mjs` 的 `node:sqlite`。
- **可脱离 Node**：`node --experimental-loader ./tools/no-node-loader.mjs tools/probe-no-node.mjs`
  拒绝解析任何 `node:*` 仍能 import SDK —— 这条已经接进 `check.mjs` R33⑥，退化即红。

`path.mjs` 与 `sha256.mjs` 是纯函数，不做注入：路径解析和哈希不依赖宿主，
放进注入表只会让每个调用点多一层间接。

## soul.md 格式

只认 `## 标题` 分节 + 每行一条 bullet（`-` / `*` / `+` / `1.`）：

```markdown
## 身份
- 名字、称呼、说话方式

## 认知
- 做判断的顺序、优先级

## 禁令
- 红线、禁止项

## 反哺
（只由 soul_persist 往这里追加）
```

认不出的内容不注入（宁可少说，不可乱说），原文件字节不动。`## 外交` 可选，用于群聊场景。

### soul.md 和 memory/ 怎么分工

一句话：**缺了它我还是不是我——是，就写 `soul.md`；只是活干得更好——就写分区。**

| 写 `soul.md` | 写 `memory/<zone>.md` |
|---|---|
| 名字、称呼、语言 | 工具用法、命令习惯 |
| 做判断的顺序、价值排序 | 具体项目的流程和踩坑 |
| 红线、禁止项 | 某次事件的细节 |
| 群聊/私聊的说话方式 | 待办、临时约定 |

`soul.md` 应该越写越短，不是越写越长。它每轮整份进上下文，分区只在魂引里占一行索引。往 `soul.md` 加一条之前先问：这是「我是谁」，还是「我该怎么干活」。

外交那节也不必挤在主文件里：`extraSoulPaths: ["/path/to/diplomacy.md"]` 会把额外文件按数组顺序拼在 `soul.md` 之后，**共用同一份预算、同一条降档链**；某个文件缺失只写一条 `soul-warn` 然后跳过，不影响其余。

## 三处数据写哪里

同一条内容只许存在一处。

| 位置 | 装什么 | 判据 |
|---|---|---|
| `soul.md` | 人格：身份 / 认知 / 禁令 / 外交 / 反哺 | 缺了它，「我是谁」就变了 |
| `memory/<zone>.md` | 分区经验 | 只影响活干得好不好 |
| 记忆库（SQLite） | 需要被 `soul_recall` 跨会话命中的原子事实 / 教训 | 一句话能说完、要能被检索到 |

规则：

- 只影响「我是谁」的 → `soul.md`，别的都不写。
- 工作方法、项目知识、踩坑 → `memory/<zone>.md`。
- 需要跨会话被 `soul_recall` 命中的 → 记忆库，只走 `soul_remember`。
- **同一条内容不许两处都写。** 迁移时先写新处，再在旧处标 `deprecated`，不直接删。

`soul_lint.mjs` 只负责把明显违背的那部分指出来（只读，不改任何文件）：

```bash
node core/soul_lint.mjs            # 用本机 profile 里的 soulPath / memoryRoot / memoryDbPath
node core/soul_lint.mjs --json     # 机读
```

它扫 `memory/*.md` 与记忆库（只取 `active` 条目），把「标题 + 正文」算成字符 bigram 求 Jaccard，`≥ 0.8` 的列成「可能双写」，报条目数、可疑对数与清单，**不自动改**。阈值刻意收紧到 0.8：只抓几乎逐字重复的，宁可漏报，不拿一堆「像但不同」的条目让人一条条看。

## 分区与标签

魂引不展开记忆正文：它只渲染一行计数 + 指路，正文留在 `memory/<zone>.md` 里按需查。

```
<soulRoot>/soul.md          人格层
<soulRoot>/memory/work.md   一区一个文件（work / intimacy / relations / rules / misc）
<soulRoot>/index.jsonl      一行一区（不是一条记忆一行）
```

- **魂引**：`【分区】work 42 · intimacy 8 · relations 3 · rules 12 · misc 5` + 一行命令示例；不出现任何区正文。
- **条数**：每次现扫 `memory/*.md` 算，手改文件后不用重建索引也不会报错数；`index.jsonl` 只定顺序与标题。
- **条目格式**：`## 标题` + 空一行 + `tags: 场景, 类型` + 正文。标签只有两个维度：场景（工作/亲密/群聊/日常）、类型（规则/事实/偏好/教训），每条最多三个，区名不写进 tags。
- **检索**：`soul_recall({zone:"work", tags:["工作","工具"]})` 先按区与标签过滤再打分，返回项带 `zone` 与 `tags`。
- **什么时候拆子区**：不看条数，看可测判据——单文件 > 1 MB，或 `soul_recall({zone:"work"})` 实测 > 500 ms。

## 自测

`check.mjs`、`clean-install.mjs`、`gamedev-golden.json` 是开发期测试物，不进 npm 包（见 `files` 白名单）。源码目录里直接跑：

```bash
node check.mjs               # 单元/集成：期望最后一行 113/113
node clean-install.mjs       # 干净安装：临时目录 + 默认配置 + 假 harness，期望 R1..R8 OK
node tools/check-layers.mjs  # 分层依赖守卫，PASS 即 33 个文件全部合规
node core/soul_lint.mjs           # 只读查双写（不进 npm 包）
```

`clean-install.mjs` 不读、不写本机任何真实目录（`DSH_HOME` 也临时指到空目录），跑完自删。

### check.mjs 覆盖了什么

| 组 | 内容 |
|---|---|
| A | 配置归一化、预算与降档、魂引拼装 |
| §8.4 | 封存源接入（用本地 `sealed-stub.mjs`，不依赖第三方包） |
| R23 | `core/` 宿主隔离静态扫描 |
| R24 | 故障注入：mkdir 抛错 / 库路径是目录 → 读返回空、写返回 `ok:false` |
| R25 | `guardTool` 对 null / 字符串 / 抛异常的处理 |
| R26 | 原文库熔断：连续失败后一次 spawn 就熔断 |
| O* | 可选模块缺失时优雅退化 |

## 基准

`node tools/bench-recall.mjs` 测 `builtinMemory.search` 的检索延迟：

| 条数 | 中位延迟 |
|---|---|
| 500 | 3.65 ms |
| 2 000 | 7.82 ms |
| 10 000 | 26.63 ms |

约 2.42 µs/条，10 万条外推 ~260 ms。真实库通常几十到几百条，不是瓶颈。

## 实测环境

- Windows 11（NT 10.0.26200）、Node v24.22.1、DSH 0.2.1-rc.3
- Ubuntu / Windows × Node 22 / 24 四格 CI 全绿
- `npm pack --dry-run`：68 文件 / 278.5 kB

没有在真实 Linux / macOS 机器上长期跑过；CI 只证明「能装、能跑测试」，不证明长期运行行为。
