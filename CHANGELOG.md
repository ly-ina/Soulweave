# Changelog

## 0.2.7 — 2026-11-13

- **规则原文接入（②+③）**：新增 `rulesDir`，稳定段只注入「文件名 + 一句话」索引（`rulesIndexMaxTokens` 默认 120 tok，0 = 关）；细则不常驻，走 `soul_recall` 新加的第⑤源「规则原文」，命中给 `rules/<文件名>:<行号>`。
  - 单源原则：原文只在 `rulesDir` 里存一份，插件只读不复制，记忆库里不会多出第二份。
  - 规则文件可在任意位置写一行 `> 摘要：…`，索引优先用它；没写退回 `#` 标题，标题与文件名同名时退回前两个 `##` 小节。标题里的日期括号自动剥掉。
  - 索引缓存 60 秒；`soul.log` 新增 `rules=shown/count` 与 `rulesTok=`。
  - 默认 `rulesDir` 为空：不配置时渲染结果与 0.2.5 逐字节一致（R12 有断言）。
- 自测：新增 R12（索引 / 预算夹取 / 摘要 / 第⑤源行号 / 配置白名单 6 项），97/97 通过。

## 0.2.6 — 2026-11-09

- **项目中文名改为「魂织」**。Soulweave 直译是 soul（魂）+ weave（织），之前 README 和侧边栏叫「魂引」，那是它每轮注入的那段人格文本的功能名，不是项目名。现在项目名统一为「魂织」；「魂引」继续作为那段注入文本的名字，代码与日志里的 `【魂引】` 段落名、`soulMaxTokens` / `soulWarnTokens` 文案、工具描述均不变。

## 0.2.5 — 2026-11-09

- **魂引上限从「硬夹」改成「上界 + 警示线」**。以前 `soulMaxTokens` 被 `HARD_SOUL_TOKENS = 1100` 夹死，人格写得长的人调不上去，渲染器还会静默降档。现在：
  - `SOUL_TOKEN_CEILING = 8000` 只是数值上界（防手滑填 1e9），配置到 3000 就是 3000；
  - 新增 `soulWarnTokens`（默认 1100，可配，0 = 关闭）：魂引渲染超过它只写一条 `soul-warn`，不截断、不降档；
  - 压缩后 `reload` 那一轮不再固定 `HARD_SOUL_TOKENS`，改为 `max(soulMaxTokens, soulWarnTokens)`，避免压缩一次就把长魂引砍回 1100；
  - 面板新增「魂引警示线」一项，`soulMaxTokens` 上限同步放到 8000。
  - `DEFAULT_SOUL_TOKENS` 由 220 改成 **1000**：默认值就该是一般人够用的量，不再「先给 220 再让人自己调」。1000 仍在警示线 1100 之下。
- `HARD_SOUL_TOKENS` 保留为 `SOUL_TOKEN_CEILING` 的别名，旧 import 不破。
- **自测**：新增 R9（3000 不被夹、99999→8000、警示线可开关且不触发截断），90/90 通过。

## 0.2.4 — 2026-11-09

- **侧边栏设置面板**：新增「魂引」面板，七项常用配置（魂引上限、四类合计上限、超预算裁剪、未结条数、soul_recall 条数、拆分注入、混合召回）。面板只读写 `<stateDir>/panel-override.json`，启动时在 `normalizeConfig` 之前合并，不碰 profile；保存后重启生效。
- **修复**：`inject` 补上 `webServer`。漏声明时拿不到 `ctx.webServer`，面板路由静默不注册，表现为 405。
- **自测**：`check.mjs` 新增 R8，断言 `panel-client.js` 声明的模块 id 必须等于 `package.json` 的 `name`（宿主 manifest 按包名注册，不一致会被二次执行）；89/89 通过。

## 0.2.3 — 2026-11-07

- **修**：`normalizeConfig` 返回的是白名单对象，0.2.2 里新加的 `hybridSearch` / `embedModule` / `embedCachePath` / `embedModelDir` 没在返回对象中列出，运行时全部变成 `undefined`，混合召回静默退回纯 BM25（现象：`soul_recall` 记忆源只剩 BM25 那一条）。现已补上，并在 `test-hybrid.mjs` 加三条透传断言。

## 0.2.2 — 2026-11-07

- **混合召回（可选）**：新增 `hybridSearch` / `embedModule` / `embedCachePath` / `embedModelDir` 配置。开启后记忆源取「BM25 候选 ∪ 向量候选」，用 RRF（`1/(60+名次)`）合并；不做分数加权，因为两种分不在一个量纲。
- 新增 `hybrid.mjs`（零依赖）：模块缺失、模型加载失败、编码抛错、返回非数组，任何一步失败都原样退回 BM25。
- 向量模块不随插件发布（模型约 95MB + transformers 依赖），按 `lanxi/tools/semantic-search/README.md` 自行安装；`setup.mjs` 可下模型、装依赖，支持 `--proxy` / `--mirror`。
- `check.mjs` 88/88 保持通过；混合逻辑另有 4 条单测（`lanxi/tools/semantic-search/test-hybrid.mjs`）。

## 0.2.1 — 2026-11-05

- **pinned 记忆头补齐**：`loadMemoryHeads()` 现在把 `lifecycle='pinned'` 的低 importance 条目也算进来，并排在高 importance 之前；不再只认 `importance >= 3`。
- **三条 pinned 能装下**：`MEMORY_SECTION.pinnedMaxTokens` 70 → 100，单条先裁 30 字；3 条 30 字短陈述能同时进【记忆】，收不进仍按原逻辑停，不硬塞残句。
- `check.mjs` 87 → 88（SP14：低 importance pinned + 3 条 30 字打包）。

## 0.2.0 — 2026-11-05

- **魂引拆分注入正式上线**（`soulSplitInjection`）：稳定段（人格/认知/禁令）每会话只进一次，动态段（时间/未结/分区）只在 turn 的首个 step 进；`agent/pre-step` 每 step 触发的重复整块注入随之消失。日志新增 `mode=split-active stable= why= state= stateWhy= stateNodes=`。
- 修压缩后人格段消失：`stableSent` 是进程内记账，压缩不会清；`decideReload` 的 `lastInject` 又只是本步增量。现监听宿主 `session/event` 的 `compaction/end`（`data.error` 为空才算成功），清该会话记账，下一轮补发稳定段。
- `package.json` 增加 `engines.node >=22.5`（`node:sqlite`）；README 补运行环境与自测计数。
- `check.mjs` 71 → 87 条断言（新增 SP8–SP13：稳定段/动态段、pinned 归属、压缩后补发等）。

## 0.1.2 — 2026-11-03（待发布：npm publish 由交办方执行）

- 新增只读脚本 `soul_lint.mjs`：扫 `memory/*.md` 与 `memory.db`，按「标题 + 正文」的字符 bigram Jaccard ≥ 0.8 列出「可能双写」，只报告不修改；不传参数时自动读本机 profile 的 soulweave 配置。
- 新增配置 `extraSoulPaths`（字符串数组）：额外常驻文件按顺序拼在 `soul.md` 之后，共用同一份预算与降档；文件缺失跳过并写 `soul-warn`。不配置时渲染结果与 0.1.1 逐字节一致。
- README 新增「三处数据写哪里」：`soul.md` / `memory/<zone>.md` / `memory.db` 的写入边界与迁移规则。
- `check.mjs` 64 → 70 条断言（新增 V1–V3 双写检测、X1–X3 多文件常驻）。

## 未发布

- 改：`soul_toolout` 改为按 `biliDbPath` 存在与否注册。目标库不存在时不再注册该工具，避免每次调用都返回「库不存在」、并白占一张工具 schema。`check.mjs` 增至 72 条断言（新增 R7）。

- 修：`reload-state.json` 改为按 session 分键（`{ version: 2, sessions: { <id>: { lastInject, at, lastReloadAt } } }`）。原先是全局单文件，压缩代理会话会把 `lastInject` 覆盖成自己的小值，主会话下一轮误判为「上轮不大」，压缩后重载永远轮不到主会话。状态只保留最近 12 个会话，旧格式自动视为空。

- 修（纯日志噪音）：`detectSnapshotDrift` 跳过 `kind='hit'` 的快照。`hit` 是 meow-memory 每轮按关键词命中的「可能相关的记忆」，本来就带条目正文、每轮换内容，不是常驻段；按常驻口径报「变胖」时 `soul.log` 的 `observed snapshot` 恒为 0，红字却每轮挂在魂引尾巴上，直到旧 hit 离开历史。`initial` / `reinjection` 仍照常报。`check.mjs` T3 由 2 条断言扩为 4 条（hit 不报 / initial 报 / reinjection 报），74/74 通过。

- 新增（第一阶段，未接线）：魂引拆分的纯函数 `composeSoulStable()` / `composeSoulState()` / `planSoulSplit()`，对应配置 `soulSplitInjection`（默认 `false`）/ `soulStableMaxTokens`（900）/ `soulStateMaxTokens`（120）。稳定段走身份/认知/禁令/外交/工具入口/安全路由，动态段走时间/工作区/未结计数/分区计数/pinned≤2/群聊，两级硬上限（`soulStateMaxTokens` 的 token 预算 + 200 字，先按 token 再按字数）。`soulSplitInjection:false` 时 `agent/pre-step` 完全走 legacy `composeSoul()`，输出逐字节不变（`check.mjs` SP6 用 sha256 守）。`check.mjs` 74 → 81 条断言：新增 SP1–SP6，另加 SP7 读真实 `soul.md` 守稳定段基线（658 tok，含工具入口；627 是不含该行的旧口径）。方案见 `reports/20261104-soul-injection-split-plan.md`，接线留第二阶段。

- 新增（第二阶段 shadow，2026-11-04）：`agent/pre-step` 接 `planSoulSplit`，但**只算不发**——消息仍是 legacy 整块、逐字节不变；每轮在 inject 日志行末尾追加 `mode=split-shadow stable=1 why=… stableTok=658 stateTok=57 stateChars=128 nodes=1 pinned=0 budget=2200 anomaly=none`。按伊纳拍板改口径：`composeSoulState` 不再收 `memoryHeads`，pinned 正文只归 meow（且只对 user/rules 生效），state 只留 `lessonHead` 1 条 40 字补位。新增只读工具 `loadLessonHead()` / `detectPinnedAnomalies()`（非 rules/user 的 `lifecycle='pinned'` 报红）/ `countPinnedEntries()` / `countSoulNodes()`。`check.mjs` 81 → 83 条。

- 新增（第二阶段判定，2026-11-04）：`planStateEmit()` —— 动态段每 turn 只在**第一个 step** 发（`turn-first`），压缩重载 / 哈希变化时不管第几步强制补（`reload`），其余 step 不发（`skip-step`）；无 step 信息时用 `lastStateTurn` 兜底。实测 `agent/pre-step` 是**每 step 触发**，一个 turn 多步就会堆多条整块魂引，这是命中率的真实来源。日志同步加 `state=1/0`、`stateWhy=`、`stateNodes=`（`SOUL_STATE_KIND='soul-state'` 单独计数，`countSoulNodes(events, kind)` 加 kind 参数）。`check.mjs` 83 → 84 条（SP10）。

- 新增（真发，2026-11-04）：`soulSplitInjection: true` 时不再发 legacy 整块，改为「稳定段（`kind='soul'`）+ 动态段（`kind='soul-state'`）」两条；false 时原样走旧路径、逐字节不变。`createSoulMessage(text, kind)` 加 kind 参数；申报（预算红字 / drift）改由 `soulTargetIndex()` 选消息——真发优先挂动态段，legacy 回落魂引，不再硬用 `composed.text` 重建（否则真发会把旧整块塞回来）。`check.mjs` 84 → 85 条（SP11：首轮两条 / 第二步 0 条 / 新 turn 只发动态段）。默认仍 `false`，线上行为未变。

## 0.1.1 — 2026-11-03

节名改为通用名：`身份` / `认知` / `禁令` / `外交` / `反哺`；旧名 `我是谁` / `我怎么想` / `我不做什么` / `在群里` / `反哺记录` 仍兼容，旧文件不用改。

## 0.1.0 — 2026-11-03

首个开源版本：`agent/pre-step` 注入魂引（预算内降档）、九个 `soul_*` 工具、三档记忆后端（`builtin` 默认 / `meow` / `none`）、四源 `soul_recall`（记忆 / 笔记 / 封存段 / 原文库）、分区与标签、干净安装自测（`clean-install.mjs`）。
