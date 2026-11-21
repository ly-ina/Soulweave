# Changelog

## 0.4.3 — 2026-11-21

- **when 命中计数（记忆系统第 3 条前半：先把数据架子搭起来，暂不调权）**。
  - `when_index` 加三列 `hit_count` / `bad_count` / `last_hit`；`ensureWhenTable` 先用 `pragma table_info` 判缺哪列再 `alter table add column`，老库原地升，不重建、不动旧行。
  - `memory/when.mjs` 新增 `bumpWhenHit` / `markWhenBad` / `readWhenStats`；`putWhen` 的 upsert 不碰计数列。
  - `adapters/dsh/prestep.mjs`：命中就记账，**dry-run 也记**；并且 dry-run 也进冷却。原来 dry-run 跳过冷却，同一条每步都命中，日志里的命中数是假的——数据失真比没数据更糟。
  - `tools/when-stats.mjs`：`--db` 看排行（命中/误报/最近命中）；`--bad <level>#<id>` 手动标误报；`--json` 给机器读。
  - 自测：`selftest-when` 23→31 条（计数 / 误报 / 缺 id / 老表补列 ×3）；R13 加「dry-run 也要记账」断言；`check.mjs` 98/98。
  - **日志降噪**：未命中的 `when-scan` 每 10 步一行（行内带 `steps=` 累计 / `miss=` 累计，命中率的分母不丢）；`no-tool-call` 同样首次照写、之后每 10 步一行。soul.log 实测已 10 MB / 36 002 行，每步一行的写法撑不住。  - 为什么先只做计数：调权没有 hit/bad 样本就是拍脑袋。dry-run 这几天顺手把数据攒了，有样本再定权重怎么改。
## 0.4.3 — 2026-11-21

- **when 命中计数（记忆系统第 3 条前半：先把数据架子搭起来，暂不调权）**。
  - `when_index` 加三列 `hit_count` / `bad_count` / `last_hit`；`ensureWhenTable` 先用 `pragma table_info` 判缺哪列再 `alter table add column`，老库原地升，不重建、不动旧行。
  - `memory/when.mjs` 新增 `bumpWhenHit` / `markWhenBad` / `readWhenStats`；`putWhen` 的 upsert 不碰计数列。
  - `adapters/dsh/prestep.mjs`：命中就记账，**dry-run 也记**；并且 dry-run 也进冷却。原来 dry-run 跳过冷却，同一条每步都命中，日志里的命中数是假的——数据失真比没数据更糟。
  - `tools/when-stats.mjs`：`--db` 看排行（命中/误报/最近命中）；`--bad <level>#<id>` 手动标误报；`--json` 给机器读。
  - 自测：`selftest-when` 23→31 条（计数 / 误报 / 缺 id / 老表补列 ×3）；R13 加「dry-run 也要记账」断言；`check.mjs` 98/98。
  - **日志降噪**：未命中的 `when-scan` 每 10 步一行（行内带 `steps=` 累计 / `miss=` 累计，命中率的分母不丢）；`no-tool-call` 同样首次照写、之后每 10 步一行。soul.log 实测已 10 MB / 36 002 行，每步一行的写法撑不住。  - 为什么先只做计数：调权没有 hit/bad 样本就是拍脑袋。dry-run 这几天顺手把数据攒了，有样本再定权重怎么改。
## 0.4.2 — 2026-11-21

- **prestep 条件触发（记忆系统第 2 条，dry-run 阶段）**：工具调用之后、下一次模型请求之前，用「刚用过的工具 + 参数里的路径」去查 `when_index`，命中就准备一条 ≤60 字的短句。
  - 时机先说清楚：DSH 只有 `agent/pre-step`、没有 pre-tool 钩子。所以这里注入的提示作用于**下一个**工具调用，不是拦住当前这一次。想更早只能改宿主，不在插件范围。
  - 新增 `core/toolcall.mjs`：`pickLastToolCall(messages)` 从 payload 尾巴提取最近一次工具调用，兼容 content 是数组 / 对象 / JSON 字符串三种形态，返回 `{tool, input, path}`。
  - `adapters/dsh/prestep.mjs` 接线：`whenInjection` 开才跑；`whenDryRun`（默认 true）只写 `when-dry` 日志不注入；每轮最多 1 条；同 session 同 id 冷却 `whenCooldownMinutes`（默认 90）；压缩重载轮清冷却。
  - **修 `matchWhen` 的 `tool` 不支持 `|` 分隔**（原来只有数组形式能多选，字符串里的 `|` 被当字面量，导致 probe 全 miss）。现在 `tool` 和 `pathPattern` 一样支持 `|`。
  - 从 `session.v4.jsonl.zstd` 取证到真实事件形状：`{"type":"tool/call","data":{"name":"ps","arguments":"{\"script\":…}"}}`——`arguments` 是 JSON 字符串不是对象。`pickLastToolCall` 因此加了一条 events 通道（先扫 events 尾部，再回落 messages）。
  - dry-run 加 `when-scan` 诊断行：每轮写 `tool=… path=… scanned=… hit=…`，payload 里认不出工具调用时写 `no-tool-call`。否则「没命中」和「配置没生效」从日志里分不清。
  - 配置：`whenInjection` / `whenDryRun` / `whenBudgetTokens`（默认 80）/ `whenCooldownMinutes`（默认 90）。四个都默认关或宽松，不配置时 `agent/pre-step` 输出逐字节不变。
- 自测：新增 R13（dry-run 只记日志 / 真发注入 1 条 / 同 id 冷却 / 默认关零调用）；`selftest-when` 20→23 条（`tool` 的 `|` 与数组混用）；`check.mjs` 98/98；`check-layers` 26 文件零宿主依赖。
## 0.4.1 — 2026-11-21

- **情境签名 `when_ctx`（记忆系统第 1 条）**：记忆条目可以带「什么时候该想起我」，不再只靠相似度。
  - 新表 `when_index(level, entry_id, when_ctx, updated_at)`，独立于 meow 的七张条目表。与待办原文的一处偏离：原本写的是「七张表加列」，改成了独立表——旧行一个字节不动、回滚只要 `DROP TABLE`、不用碰 `memory_remember` 的工具 schema 和 i18n 文案。
  - 只认三个键：`tool`（工具名，支持 `write*` 通配）、`pathPattern`（`*.md|*.mjs` 这种）、`timeWindow`（morning/afternoon/evening/night）。`sessionState` 故意没做——现在没有可靠信号源，硬塞就是猜，等 prestep 条件触发落地再说。
  - `memory/when.mjs`：`normalizeWhen` / `putWhen` / `getWhen` / `removeWhen` / `readWhenMap` / `matchWhen`（纯函数，返回 `hit` / `miss` / `null`）/ `timeWindowOf`。只依赖 `node:sqlite`。
  - `core/search.mjs` 新增 `searchMemoryByContext(cfg, ctx, limit)`：只返回签过 when 且命中的条目，没签的一律不出现。它不替代相似度检索，是另一条道。
  - `tools/when.mjs`：`set` / `get` / `del` / `list` / `probe` 命令行入口。
- **SP7 口径修正**：soul.md 2026-11-21 起在禁令节多了一行「动 lanxi 文件先查路径」（+59 tok，稳定段 658→717），那行防的是同一个错犯了 5 次，故意付这个成本。原断言拿「首轮全量 stable+state」跟 legacy 比，口径错了——拆分收益在稳态（首轮之后只发 state 57 tok）。改成两条：`stable < legacy` 且 `state < legacy × 0.3`。
- 自测：新增 `tools/selftest-when.mjs` 20 条断言；`check.mjs` 97/97；`check-layers` 依赖方向 25 文件零宿主依赖。

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

- 重构（0.4.0，2026-11-19）：单包多入口解耦。`index.js` 4028 → 52 行，只剩插件声明（`name` / `inject` / `apply` / `MESSAGE_KIND`）与公共 re-export；新增 `core/`（21 个文件，纯逻辑）、`memory/`（3 个文件，只依赖 `node:sqlite`）、`adapters/dsh/`（2 个文件，唯一接触 `ctx`）。`exports` 增加 `./core` 与 `./memory`，`files` 补上 `panel-client.js`（原先漏了，`./client` 发布后会解析失败）。新增 `tools/check-layers.mjs`：core/memory 出现宿主 import 即失败、memory 不得反向依赖 core、`core/hybrid.mjs` 与 `memory/hybrid.mjs` 必须 SHA-256 一致。`clean-install.mjs` 修正旧路径 `memory-builtin.mjs` → `memory/builtin.mjs`。`check.mjs` 97/97 + O* 11/11。

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
