# API 参考

> 本文件由 `node tools/gen-api.mjs` 从源码 JSDoc 生成，**不要手改**。
> 改了签名就重新生成；CI 会跑 `--check`，过期会直接失败。

只列 `index.js` **显式导出**且**有 JSDoc 摘要**的 API。
内部 API 用 `--all` 查看；公开但没写摘要的在文末列名单。

统计：共 386 个导出；公开 119 个，其中 89 个有文档、30 个待补。

## `core/budget.mjs`

### `measureInjections(messages)`

统计本轮 `decision.messages` 里各来源的 token（§3.4）。

### `SNAPSHOT_MARK`

长期记忆快照的正文标记（meow-memory 以 user 消息插入，kind 不是魂引的）。

### `MEOW_KIND`

meow-memory 在会话事件里登记的 `source.kind`。

### `SNAPSHOT_CAPS`

二期 B R2：同一会话内每种快照允许留几条（保留最新）。 数字来自交办单，不是拍脑袋：initial 只该有一次、reinjection 只为补压缩、hit 是最近的命中片段。

### `snapshotMetaOf(message)`

二期 B 实测（2026-10-28，当前会话 107 条 user/message 里 5 条是 meow 快照）： 插入原因不在公开字段上，藏在 `source.sections` 的 `__meta__` 里—— `{name:'__meta__', text:'{"kind":"hit","ids":[...]}'}`。所以判 kind 必须解析这段 JSON。

### `isSnapshotMessage(message)`

这一条是不是「长期记忆快照」。

### `isConversationMessage(message)`

没有插件来源的普通对话消息（user/assistant 且不带 source.kind）。

### `measureRequestBudget(messages)`

观测口径（一期 A 起，二期 B 改准）：把这一轮要发出去的消息分成四笔账。

### `eventsOfSession(session)`

读会话事件（meow-memory 的 `ownEvents()` 优先，退到 `events` 数组）。

### `countSnapshots(events)`

数历史里各 kind 的快照条数（只读，不碰 meow-memory）。

### `planSnapshotPrune(historyCounts, incoming)`

本轮限流（R2 的可实现形态）：历史计数 + 本轮新来的快照一起算，超 `SNAPSHOT_CAPS` 的**本轮新条目**丢弃。

### `detectSnapshotDrift(snapshots)`

R3 护栏：常驻快照里出现项目/话题/事实/经验正文就该报。

### `lastUserTexts(events, count = 2)`

从会话事件里取最近 N 条**真人** user 消息（跳过长期记忆快照这类注入消息）。

### `planBudget(measured, totalMaxTokens = TOTAL_TOKENS)`

让步计划：只产出「该砍谁」的清单，不自己动手改别人的消息（§3.4 边界）。 顺序固定 封存目录 → 分区目录；无论超多少，`soul` / `time` 都不在清单里。

### `applyBudgetPlan(messages, plan)`

按计划剔掉对应 class 的消息；`soul` 与 `time` 永远不会被剔。

### `countSnapshotEntries(messages)`

本轮快照里实际注入了几条记忆（数 `- ` 开头的条目行；「（其余 N 条…」那行不算）。 只给「【预算】snapshot:N · 记忆 kept/total」这行申报用，不参与任何裁剪。

### `countResidentEntries(memoryDbPath)`

记忆库里的「常驻口径」条数（与 meow 的 buildInjectionBody 同口径：soul 全量 + user 全量 + rules 里全局 scope 且 importance>=2）。只读、失败返回 0（申报行宁可少个分母，不许报错）。

### `loadMemoryHeads(memoryDbPath, limit = 3)`

记忆联动（2026-10-31）：从 memory.db 取「高重要性、仍在用」的规则与教训， 压成一句话塞进魂引「我记得」。只读、失败静默——记忆库坏了不能拖垮魂引。 取 rules + lesson 里 importance>=3、status=active 的条目，按 updated_at 倒序各取 limit， 合并去重后按 importance 倒序取 limit 条，每条 clip 到 28 字。

### `loadLessonHead(memoryDbPath)`

2026-11-04 第二阶段口径（伊纳拍板）：state 里只放 lesson 头 1 条。

### `detectPinnedAnomalies(memoryDbPath)`

`lifecycle='pinned'` 目前只对 rules/user 生效（meow 的 initial 候选不看 lesson/fact/project/topic）。 这几层上标了 pinned 就是**两头都不进**的静默丢失，shadow 期一律报红。 返回 `[{ table, count }]`，空数组表示干净。

### `countPinnedEntries(memoryDbPath)`

meow 侧会「无条件装」的 pinned 条数（`rules` + `user` 里 `lifecycle='pinned'`）。shadow 观测用。

### `countSoulNodes(events, kind = MESSAGE_KIND)`

数历史里某类注入消息的条数（默认 `source.kind === 'soul'`）。 shadow 用它分别报「稳定段节点数」和「动态段节点数」——两者 kind 不同，混在一起就看不出谁在涨。

### `loadCorrectedLessons(memoryDbPath, limit = 200)`

反哺用：meow 库里 `corrected=1` 且仍在用的 lesson。 列不一致（有的老库没 project）先探列再拼 SQL，别硬写列名。

## `core/config.mjs`

### `RELATIONS_CAP`

关系层最多返回几条（单子 §3.1：≤8 条）。

### `MOOD_MAX_CHARS`

mood 读取上限（字）。

### `readRelations(dir)`

读关系层：目录内 `*.md` 按文件名**倒序**，取最新一份里的全部 `- ` bullet（≤8 条）。 旧文件不删（可追溯）；单条形如 `- 正文（YYYY-MM-DD）`。

**返回** }

### `readMood(path)`

读 mood.md（整文件，最多 600 字）。v1 只读，写入由使用者手动。

### `appendRelation(dir, text, options = {})`

写关系层：追加一条到 `<dir>/<YYYY-MM-DD>.md`，格式固定 `- 正文（YYYY-MM-DD）`。 同一条当天已存在不重复写；当天满 `RELATIONS_CAP` 条默认拒写，`force:true` 才写。

**返回** }

### `writeMood(path, patch = {})`

写 mood.md：只给哪个键就改哪个（at / mood / carry），整文件 ≤ `MOOD_MAX_CHARS`。

**返回** }

### `profilePatchPaths(home = dsHome()`

八期 T1：dsh-soul 拿不到 meow-memory 的 Service 实例，直接读 profile 的 patch 文件。 只列 `profiles/<名字>/cordis.patch.yml`，不递归找 `node_modules`： 我们要的是「本机当前生效的配置」，不是插件自带的默认 patch。

### `readRouterLines(path)`

2026-11-01：路由层。魂引只放「该去哪查」，不放内容——库怎么长，魂引都不涨。 文件一行一条 `触发 → 去哪`；`#` 开头是注释；最多取 6 行。

## `core/constants.mjs`

### `SOUL_SECTIONS`

soul.md 里插件只读的三节（§3.1）。

### `SECTION_ALIASES`

旧节名兼容映射：v0.1.1 起渲染用通用名，旧文件仍可读。

### `FEEDBACK_SECTION`

唯一允许追加的一节；模板内容禁止写入（§9.10）。

### `FEEDBACK_ALIASES`

旧名兼容。

### `SOUL_TOKEN_CEILING`

魂引配置可设的最高值（§5，2026-11-09 放宽）。

### `DEFAULT_SOUL_WARN_TOKENS`

警示线默认值：魂引渲染超过它就写一条 soul-warn，不降档、不夹。

### `HARD_SOUL_TOKENS`

旧名兼容：曾经是硬上限，现在是 `SOUL_TOKEN_CEILING` 的别名。

### `TOTAL_TOKENS`

四类注入合计的上限（§5）。

### `DEFAULT_SOUL_TOKENS`

魂引默认预算（2026-10-28 由 200 调到 220）。

### `RECALL_MAX_CHARS`

`soul_recall` 单次输出上限（§5）。

### `MEMORY_LEVELS`

记忆库分层表顺序（与 meow-memory 的建表一致）。

### `MEMORY_HEAD_LIMIT`

记忆联动：魂引「我记得」最多几条（2026-10-31）。

### `INJECTION_CLASSES`

四类注入的归类表（§3.4）。顺序即优先级，只用于展示。

### `YIELD_ORDER`

让步顺序（§5）：先砍封存目录，再砍分区目录，**最后**才砍记忆召回； 魂引核心、动态段与时间行永不砍（v2 起 recall 排在链尾）。

### `HINTS`

「怎么查」三条入口（§1）。固定文案，不随轮次变化。

### `DEFAULT_SOUL_STABLE_TOKENS`

稳定版魂引默认预算（原 index.js:438）。

### `SOUL_STATE_MAX_CHARS`

魂引状态行：字数上限（原 index.js:437）。

### `DEFAULT_SOUL_STATE_TOKENS`

魂引状态行：默认 token 预算（原 index.js:438）。

### `SOUL_SECTION_CAP`

三节每条最多注入几条（2026-10-28 起超出的不再静默丢，会在 soul.log 记一行 warn）。

## `core/probe.mjs`

### `DREAM_MARKER`

meow-memory 的 dream 标记：它插一条带这个 marker 的 user 消息。

### `isDreamTurn(events)`

最近一个 turn 里有没有 dream 注入（用来判断「dream 刚收尾」）。

### `wordsOfKeywords(raw)`

记忆库的 `keywords` 列常是 JSON 数组字符串（`["a","b"]`），也可能是普通分隔串。

### `pickProbeWords(dbPath, count, seed = 0)`

探针词只从**检索面**取（keywords 优先，其次 title），绝不从正文切—— 从正文切的词在关键词索引里常常搜不回来，会得到假警报（记忆 `0mvl2r5kf`）。 抽样是确定性的（同一 seed 复跑同一批），seed 用「日期序号」，便于复现。

### `runProbes(options, probes, limit = 5)`

逐条探针：用条目自己的 keywords 查，命中同一 id 即算通过。

### `maybeRunProbe(config, at, dreamTurn)`

到点就跑：主探针每 `probeIntervalDays` 一轮（10 条，≥8 通过）， dream 收尾那轮改跑快检（默认 3 条）。连续两期主探针不达标 → `alert=true`，由调用方在魂引末行申报。 全部只读本地记忆库，不出网、不额外起模型请求。

## `core/prompt.mjs`

### `resolveWorkspace(payload, options = {})`

「现在在哪」要的是**会话工作区**，不是宿主进程的 cwd（那会是 profile 目录）。 实测 `agent/pre-step` 的 payload 是 `{ messages, turn, step, signal, agent }`， 工作区在 `agent.session.header.cwd`（`dsh-session` 的会话头记录 cwd，见 `liveSource.header.cwd`）。其余候选字段是防御性兜底：宿主换形状时仍能落到真值。 绝对路径判定跨平台：path.isAbsolute（本平台语义）+ 原 Windows 盘符/UNC 正则兜底， 这样 Linux 的 /home/... 与 Linux 视角下的 D:\... 都能被采纳，不再回落 process.cwd()。

### `zoneRowsOf(config)`

分区行（待办 A）：索引定顺序/标题，**条数每次现扫文件算**——手改完 memory/*.md 忘了重建索引也不会把魂引的数字写错。

## `core/recall-state.mjs`

### `SOUL_TRIGGER_KIND`

触发器注入的消息来源（2026-11-10）：单独一种 kind，便于日志与测试区分。

### `SOUL_RECALL_KIND`

每轮关键记忆召回的消息来源（2026-11-11 v2）：另一种 kind，预算上排在 trigger 之后。

### `RECALL_TEXT_MAX_CHARS`

召回正文与查询文本的截断长度（字）。

### `pickRecallEntry(result)`

从 `backend.search` 的返回里挑第一条可用召回（v2）。

### `renderRecall(item)`

召回注入格式：`【记忆】<id> · <正文，截 120 字>`。

### `resetRecallCooldownOnReload(cooledBySession, sessionKey, shadowPlan)`

与 trigger 同一条规则：压缩重载轮清掉本会话召回冷却，避免「消息被压掉、冷却又不补」。

### `planStateEmit(input = {})`

动态段这一步发不发（伊纳 2026-11-04 拍板）。

**返回** }

## `core/recall.mjs`

### `createArchiveSearch(options)`

封存源复用 `dsh-sealed-segments` 的导出函数（§13.4），失败则明确报告而不是静默空结果。

### `readRulesIndex(dir, maxTokens = 120)`

规则原文索引（2026-11-12）：扫 `rulesDir` 下 `*.md`，只取标题层。

### `searchRules(options, words, limit)`

第⑤源：规则原文（2026-11-12）。与笔记源同一形状，只是目录固定、只读。 命中给 `rules/<文件名>:<行号>`，片段仍走 snippetAround，不整段回灌。

### `createRecallSources(config)`

检索源注册制（§B）：memory / sealed / notes / index 四项。 每项 `{ id, enabled, search }`；没配置的源不注册（返回「未配置（跳过）」的空结果）， 单个源抛错只写 note，不拖累其余源。

### `createPersist(config)`

§7 soul_persist：把「被使用者明确纠正过」的 lesson 追加到 soul.md 第四节。 只追加、不重写前三节；默认 preview，append 时才落盘并先备份。

## `core/soul.mjs`

### `readSoul(path)`

读 soul.md；缺失时返回 `null`（不是空对象，让调用方能区分「没写」与「写空了」）。

### `readSoulSources(paths = [])`

v0.1.2 P1：读「主 soul.md + extraSoulPaths」。

### `SOUL_STAGES`

降档档位表（2026-11-03 定稿）。 顺序即降档顺序：full → 砍待办 → 砍路由/怎么查/我记得 → 削每节条数 → clip 单条字数。 不变式：除 reload 外，任何档位 take.identity / mind / boundary 都 ≥ 1。

### `decideReload(reloadState, sessionKey, currentInject)`

压缩后重载判定：状态按 session 分键，避免压缩代理会话覆盖主会话的 lastInject。 返回 { reload, previousInject, sessionStates, previousState }，调用方负责写回。

### `composeSoulStable(input = {})`

稳定段：身份 / 认知 / 禁令 / 外交 / 工具入口 / 安全路由。

**返回** }

### `renderDueLine(items, options = {})`

渲染现状段的 ⏰ 行（到期 / 临近）。

| 参数 | 说明 |
|---|---|
| `>}` | items |
| `}` | [options] |

**返回** 形如 `⏰ 今天 15:00 交材料 [k3f9] · 已过期 1 条：对账 [b7c1]`；无内容返回 ''

### `planSoulSplit(input = {})`

稳定段发不发（方案 §2.2 的四条判定）。

## `core/surface.mjs`

### `estimateTokens(text)`

与 index.js 的 estimateTokens 同口径（CJK 1 tok/字，其它 0.34），不引 index.js 以免 CLI 拉起整插件。

## `core/text.mjs`

### `estimateTokens(text)`

与 `dsh-context-index` / `dsh-sealed-segments` 同一口径，便于横向对比。

### `PLUGIN_DIR`

包根目录（core/ 的上一级）。

## `core/triggers.mjs`

### `selectTriggers(userText, triggers, options = {})`

从清单里挑本轮该注入的条目（纯函数）。 - 大小写不敏感**子串**匹配（中文没有词边界，子串是唯一便宜的口径）； - 按命中关键词数降序，取前 `maxEntries` 条； - 累加正文估算 token 超 `budgetTokens` 就停（不做单条截断）。

**返回** >}

### `pickTriggerText(messages, events)`

2026-11-10 v1.1 修复：pre-step 时 `payload.events` 里可能还没有本轮 user 消息， 旧实现 lastUserTexts(events,1) 会拿到更早的压缩摘要（里面常含「魂织」等词），导致串触发。 优先取 `payload.messages` 尾部当前消息；跳过注入的 soul-* 消息；events 只作兜底。

### `resetTriggerCooldownOnReload(cooledBySession, sessionKey, shadowPlan)`

2026-11-10 v1.1：压缩重载轮清掉本会话触发冷却，避免「消息被压掉、冷却又不补」。

## `core/validate.mjs`

### `isRecord(value)`

不是 null / 数组 / 原始值的对象。

### `sanitizeArgs(args)`

顶层入参归一：非对象一律变 {}（不猜语义）。

### `guardTool(name, execute)`

包一层执行守卫。name 用于错误文案；execute 的其余参数原样透传。 注意：只在 adapters 层用，core 不依赖它。

## `io.mjs`

### `configureIo(overrides = {})`

注入替身（测试/故障演练用）。只覆盖给出的键，其余保持真实实现。

### `resetIo()`

恢复真实实现。

### `ioStatus()`

当前是否处于注入态；以及注入了哪些键（给自检断言用）。

---

## 待补文档的公开 API（30 个）

这些名字从 `index.js` 导出，但源码里没有 JSDoc 摘要。补一段就能自动进正文。

- `classOfKind` —— `core/budget.mjs`
- `tierStatePath` —— `core/budget.mjs`
- `maybeLogTier` —— `core/budget.mjs`
- `textOfMessage` —— `core/budget.mjs`
- `rememberUserTexts` —— `core/budget.mjs`
- `recentUserQuery` —— `core/budget.mjs`
- `loadPendingItems` —— `core/budget.mjs`
- `normalizeConfig` —— `core/config.mjs`
- `MESSAGE_KIND` —— `core/constants.mjs`
- `MEMORY_SECTION` —— `core/constants.mjs`
- `ALIAS_TO_STANDARD` —— `core/constants.mjs`
- `readProbeState` —— `core/probe.mjs`
- `writeProbeState` —— `core/probe.mjs`
- `createSoulMessage` —— `core/prompt.mjs`
- `SOUL_STATE_KIND` —— `core/recall-state.mjs`
- `resolveSealedModule` —— `core/recall.mjs`
- `walkMarkdown` —— `core/recall.mjs`
- `searchNotes` —— `core/recall.mjs`
- `resetIndexCircuit` —— `core/recall.mjs`
- `indexCircuitState` —— `core/recall.mjs`
- `searchIndexSource` —— `core/recall.mjs`
- `createRecall` —— `core/recall.mjs`
- `createMemoryBackend` —— `core/search.mjs`
- `searchMemory` —— `core/search.mjs`
- `searchMemoryByCue` —— `core/search.mjs`
- `parseSoul` —— `core/soul.mjs`
- `composeSoul` —— `core/soul.mjs`
- `composeSoulState` —— `core/soul.mjs`
- `estimateTokens` —— `core/toolout.mjs`
- `loadTriggers` —— `core/triggers.mjs`
