# Changelog

## 0.5.2 — 2026-11-25

**守卫的提示修对了，API 文档改成自动生成**

- **fix(tools)**：`check-layers` 报错写「走 core/io.mjs」，但 `io.mjs` 在仓库根、`core/` 下没有这个文件；而且对 `memory/` 的文件也报「core 不许」。**照着提示改会 import 一个不存在的路径。** 现在按层报 `${layer}/ 层不许…` 并指向真实位置 `../io.mjs`。
- **feat(docs)**：`tools/gen-api.mjs` 从源码 JSDoc 生成 `docs/API.md`（119 个公开 API 中 89 个有摘要）。`--check` 接进 CI —— 手写文档一定会过时，而过时的文档比没有更糟。
- **docs(README)**：补「分层约束」章节，写明 `core/` 与 `memory/` 受同一个 `node:fs` 禁令、唯一合法出口是根 `io.mjs`，并记录上面那个坑。
- `check` 118/118、`check-layers` 37 文件、`gen-api --check` PASS。

## 0.5.1 — 2026-11-25

**修 Windows CI 上的误拒**

- **fix(core/surface)**：`applySurfaceReplace()` 的新鲜度检查是 `if (age < quietMs)`，而 `quietMs: 0`（自测用来关闭检查）在 `age` **为负**时仍然命中。文件系统的 mtime 精度比 `Date.now()` 粗，同一毫秒内写入的文件可能被记成「未来 1ms」，于是 `-1 < 0` 成立 —— Windows CI 上把刚写完的测试文件误判成「会话正在运行」并拒绝写入，S2 失败。
- 改为 `if (quietMs > 0 && age < quietMs)`：`quietMs <= 0` 明确表示关闭检查，不受负 age 影响。
- **test**：S2 里用 `utimesSync` 把 mtime 设到未来 5 秒再 apply，锁住这个修复。本地无法自然复现，只能伪造 mtime。
- `check` 118/118，`check-layers` 不变。

## 0.5.0 — 2026-11-25

**待办闭环：记 / 办 / 结**

这一版把「记录 → 落库 → 到期提醒」整条链路打通。新增四个模块、五个 MCP 工具、六组测试；
`check.mjs` 从 113 涨到 **118**，`check-layers` 仍是 37 文件零宿主依赖。

### 新增模块

| 模块 | 职责 | 导出 |
|---|---|---|
| `memory/health.mjs` | 库健康检查，区分「没命中」与「库坏了」 | `health` / `renderHealth` / `isBrokenSearchResult` |
| `memory/anchor.mjs` | 待办短锚点，让结账能精确对上 | `anchorOf` / `looksLikeAnchor` / `parseSettle` / `renderAnchored` |
| `memory/time.mjs` | 中文时间解析 | `parseDue` / `cnNum` / `DEFAULT_HOUR` |
| `memory/route.mjs` | 触发词 → 落库路由 | `routeRecords` / `renderRouteResult` |

### 1. 三个触发词，语义闭环

| 触发词 | 含义 | 落点 |
|---|---|---|
| `※记` | 经验 / 事实 | `memories` |
| `※办` | 待办 / 承诺（需带时间） | `todos` + `due` |
| `※结` | 结算：已完成或不再需要 | 把对应 pending 标 `done` |

配套改动：

- `parseDue` 解析不出时间时**降级成记忆**，不进 `todos`——宁可少一条提醒，不给一条错的。
- `※结` 优先按短锚点匹配，其次文本兜底，都找不到就只告警、**不改任何数据**。
- 待办正文里命中的时间词会被摘掉，避免渲染成「明天 09:00 明天九点交材料」。

### 2. 短锚点：让结账不再靠相似度

`todos.id` 形如 `t-mno8x-k3f9`，末段 `k3f9` 就是锚点。现状段的到期行会带出来：

```
⏰ 明天 09:00 交材料 [k3f9]
```

模型照着写 `※结：k3f9` 即可精确对上。锚点规则：3–6 位、必须含字母（排除纯数字，免得和日期混淆）。

### 3. 中文时间解析

支持：绝对日期、`11月30日`、`下个月5号`、`今天/明天/后天/大后天`、`三天后`、
`明早/明晚/今晚`、`周五/下周三/本周一`、`9:30`、`九点半`、`下午三点`、`两小时后`。

三条规则值得单说：

- **裸时刻按当前时段推断**：晚上 7 点说「八点」→ 今晚 20:00；晚上 9 点说「八点」→ 明早 08:00。
  带冒号的 `9:30` 不做推断（默认上午）。推断出来的会标 `ambiguous: true`。
- **只有日期** → 默认 09:00，标 `assumedTime`。
- **认不出就返回 `null`**：`月底`、`改天`、`下周找时间` 一律不猜。

### 4. 现状段新增到期行

`composeSoulState` 新增 `dueItems` 输入，渲染一行：

```
⏰ 今天 15:30 复盘 [lz1h] · 已过期 1 条：对账 [x1y2]
```

- 空输入**一个字节都不输出**，不配就等于没做过。
- 不参与降档阶梯（临期提醒比 zone 行重要），靠 summary 的 token 上限兜底。
- `memory/builtin.mjs` 新增 `listDueItems()`：按 `leadMs`(24h) / `graceMs`(72h) 窗口扫描。

### 5. 结构化降级，插件静默不再等于不可知

`search()` 的返回值分三态：

| 情况 | 返回 |
|---|---|
| 有命中 | `{ entries:[…], note:'', degraded:false }` |
| 没命中 | `{ entries:[], note:'记忆里没有这些词', degraded:false }` |
| 库打不开 | `{ entries:[], note:'…打不开', degraded:true, reason:'db-unavailable' }` |

插件侧没人读 `degraded`，行为零变化；SDK / 外部调用方不用再正则匹配中文 note。

### 6. MCP 宿主适配（第二宿主）

`adapters/mcp/server.mjs` 现在提供五个工具：

| 工具 | 用途 |
|---|---|
| `soul_recall` | 检索 |
| `soul_remember` | 写记忆 |
| `soul_todo` | 待办 create / list / done（按锚点结账） |
| `soul_health` | 库健康检查 |
| `soul_state` | 渲染现状段（含 ⏰ 行） |

另有 `--selftest`：不起协议，只跑读路径，输出 PASS/FAIL 并给退出码。
加上全局异常兜底 + 信号处理，进程崩了不会静默。

### 7. CLI：把 JSONL 路由进库

```bash
node tools/route-records.mjs --in <records.jsonl> --db <soul-memory.db> [--dry-run] [--project 名]
```

这是**事后批处理**，不依赖 dsh 事件钩子。dsh 侧将来接实时路由时调同一个 `routeRecords()`。

### 修掉的 bug

- `parseDueAt` 时区坑：带 `Z` / `+08:00` 的串被当成本地时间，差 8 小时。
- 「周五」按本周一算导致错位，改为相对今天取最近的周五。
- 「两个小时以后」中文数字不认（正则只写了 `\d+`）。
- 「明晚八点」解析成 08:00 —— 时段词藏在缩写里，`resolveTime` 看不到。

### 测试

`check.mjs` 118/118（新增 R27 健康检查 / R28 锚点 / R29 到期行 / R30 时间解析 / R31 路由）。

## 0.4.12 — 2026-11-25

**R25 的预期异常不再污染 check 输出**

- **test**：`check.mjs` 的 R25 为了让「工具 execute 抛错」这条路径逼真，是**主动抛** `SQLITE_BUSY: database is locked` 的。`guardTool` 捕获后按设计往 stderr 打一行 `[soulweave] soul_probe 执行异常（已兜住）`——于是每次跑 check 都会看见一行像故障的日志，实际是测试夹具的产物，一度被误读成真锁库。
- **fix(test)**：R25 内接管 `console.error` 收集日志，finally 恢复。新增两条断言：抛错一次只记一条、日志带工具名与「已兜住」。**顺带补上了原本缺失的覆盖**——此前没有任何断言验证兜底真的记了日志。
- 不改 `core/validate.mjs`。这条日志在真实运行时是 `guardTool` 对**所有工具**的统一兜底，撞上真库锁时打的就是它，删掉等于放弃唯一的现场信息。
- **test**：`check.mjs` 113/113、`O*` 11/11；stderr 里 `SQLITE_BUSY` 出现次数 1 → 0。

## 0.4.11 — 2026-11-25

**第二个宿主：MCP**

- **feat(adapters)**：新增 `adapters/mcp/server.mjs`——零依赖手写 stdio JSON-RPC，把引擎接到任意 MCP 客户端。暴露三个工具：`soul_recall`（检索）、`soul_remember`（写入）、`soul_state`（渲染【魂引 · 现状】）。只 import `core/` 与 `memory/` 的公开导出，不碰 `index.js`、不碰 `adapters/dsh/`、不碰任何 ctx。用途是证明宿主无关，不是做产品。
- **fix(adapters)**：适配层两处读错了引擎的返回结构——`search()` 返回的是 `{ loc, snippet }` 而非完整行；`composeSoulState()` 返回 `{ text, tokens, chars, step }` 而非字符串。两处都改在适配器里，**引擎一行未动**，这恰好是抽象成立的证据：换宿主暴露的问题全在边界上。
- **test**：手动 MCP 会话跑通 `initialize` → `tools/list` → 三工具调用 → 未知工具报错；`check.mjs` 113/113、`O*` 11/11；`check-layers` 仍是「33 个文件，core/memory 全部零宿主依赖」。
- **chore**：补打 `v0.4.11`。上个 tag 停在 `v0.4.6`（11-23），其后的 0.4.7–0.4.11 共 11 个提交此前在 GitHub 上没有任何锚点。

## 0.4.10 — 2026-11-25

**归档候选判据修正**

- **fix**：`curator.buildCandidates` 原来只看 `importance<=1`。可这个字段写入时默认就是 1，等于「没手动升过级」——体检把 24 条写得具体、能直接照着做的教训全列成「归档候选」，一条都不该归。现在加第二层价值信号：正文不足 30 字（只剩残句）或 keywords 已带 `decay:` 沉底，才进候选。真实库 24 → 0。
- **test**：`check.mjs` 113/113 通过（R22 的断言不依赖候选条数）。
- **data**：体检 672 条，近重复 4 对。其中 2 对合并后归档；另 2 对一端命中「项目含 lanxi」保护名单、拒绝归档，改为把独有的关键词和分工说明并进保留那条。active 672 → 670。

## 0.4.9 — 2026-11-24

**人格层写入口**

- **feat**：`soul_relations` 加 `add`——追加一条到今天的关系层文件，格式 `- 正文（YYYY-MM-DD）`；同条去重，当天满 8 条默认拒写、`force:true` 才写。
- **feat**：`soul_mood` 加 `mood` / `carry` / `at`——写 `mood.md` 三键，只给哪个键就改哪个，整文件 ≤600 字。
- **test**：新增 S7 / S8（纯函数层 + execute 写分支：去重 / 上限 / force / 只改单键 / 超长拒写），`check.mjs` 111 → 113。
- **docs**：README 工具表改为「读/写」；「已知限制」删掉人格层只读那条。
- **feat(tools)**：新增 `tools/migrate-legacy.mjs`——meow 七层 active 记忆迁进 builtin 池，沿用旧 id、sha 去重、支持 `--dry-run`，旧库只读。
- **data**：主库 492 条 + lumi-game 168 条 active 迁入新池，active 总数 56 → 672。

## 0.4.8 — 2026-11-24

**README 重写 + 文档分层**

- README 从 381 行「设计说明」重排成 197 行门面：先说解决什么问题，再给架构图、30 秒安装、四个概念、14 个工具表。工程细节迁到 `docs/ENGINEERING.md`，完整配置迁到 `docs/CONFIG.md`。
- 新增 `docs/architecture.drawio` + `docs/architecture.png`：魂引两段怎么从三处记忆拼出来——稳定段（人格 / 规则 / 我记下的自己）首轮或压缩后注入，现状（时间 / 工作区 / 在场 / 可检索 5 条）每轮刷新。
- `package.json` 的 `files` 补 `soul.example.md`、`docs/`、`CHANGELOG.md`。此前发布包里没有 `soul.example.md`，新用户装完无从下手。
- 修正过时数据：测试 97→111、工具 10→14、DSH 版本 0.2.1-rc.3、包体积 61 文件 / 207.7 kB。
- **口径修正**：README「已知限制」明确写出人格层（`soul_relations` / `soul_mood` 只读）与旧七层库未迁移；0.4.7 说的是记忆层换代，不等于魂织全部完成。
## 0.4.7 — 2026-11-24

记忆层完成换代：从 meow 迁到魂织自己的 builtin 池，并把工程边界收紧。

- **feat**：记忆后端切 builtin 新池——`memories` 单表 + `todos` + `memory_versions` 溯源；数据落点迁到 `<DSH_HOME>/soulweave`。
- **feat**：新增 `soul_remember`（唯一写入口，按 sha 去重、同 id 留版本）、`soul_project`（项目全景）、`soul_todo`（未结待办）。
- **feat**：并入 curator——`soul_audit`（体检：分层统计 / 近重复 / 热词 / stale）、`soul_archive`（选择性归档，保护名单 + VACUUM 备份 + 只改 status）。独立 `dsh-memory-curator` 退役。
- **chore**：卸载 `meow-memory` 依赖；旧库留档只读。
- **refactor**：新增根 `io.mjs`——fs / os / child_process / `process.env` / `cwd` 的唯一入口，支持 `configureIo()` 注入替身；`core/` 19 个文件、`memory/` 4 个文件全部改走它。
- **test**：`tools/check-layers.mjs` 加机器守卫（core/memory 绕过 io 直接碰宿主模块即报错）；新增 R23-R26。
- **fix**：`ensureDb` 兜住 `DatabaseSync` 构造失败（损坏 / 被锁 / 无权限），读返回 null、写返回 `ok:false`。
- **fix**：soul-index 原文库源加指数退避熔断（1/5/15 min），坏一次后不再每次 `soul_recall` 白等 15 秒。
- **feat**：`tools/bench-recall.mjs`——实测 10k 条召回 26.6ms（增量 2.4µs/条）。
- **fix(pack)**：`files` 白名单补 `io.mjs`；`clean-install.mjs` 的库路径断言跟进数据落点迁移。
- `check.mjs` 107 → 111/111。

## 0.4.6 — 2026-11-23

- **fix**：`composeSoulStable` 的 ctx 白名单漏了 `personaText`，稳定段（缓存命中路径）一直没注入人格快照，只有非稳定段有。补上后两条路径一致。
- **fix**：人格快照裁剪优先在标点处收口，不再把句子砍成半截。
- **tune**：`personaMaxChars` 60 → 400（取全文），`personaMaxItems` 仍 3；稳定段预算同步提到 2000 tok，实测不削魂引条数。
- **feat(panel)**：设置页加入人格快照三项——开关 / 条数 / 单条字数。

## 0.4.5 — 2026-11-21

- 新增 `core/persona.mjs`：人格塑型快照。从记忆库 `soul` 表读 active、importance≥2、未沉底（`decay:沉底@`）、非 daily 的条目，带日期渲染成【我记下的自己】。不存新设定；读不到库 / 非 meow 结构就返回空，绝不自己编。
- `core/soul.mjs`：`composeSoul` / `composeSoulStable` 接受 `personaText`，插在禁令/外交之后、记忆指针之前。core 仍零宿主依赖，读库在 adapters。
- `core/config.mjs`：新增 `personaInjection`（默认 true）、`personaMaxItems`（3）、`personaMaxChars`（60）。
- `adapters/dsh/prestep.mjs`：每次 pre-step 读快照并传入。轻量版现场查库、不落盘；`stale` 钩子已占位，正式版换实现不动调用方。
- `check.mjs` 新增 R15：只取合规条目、带日期、可裁剪、无库/非 meow 结构不崩。100/100 + O* 11/11。

## 0.4.4 — 2026-11-21

- **阶段衰退（记忆系统第 4 条）**：`memory/decay.mjs`，两档沉底、永不删。
  - 判据：`status=active`、`lifecycle` 不是 pinned/daily、`importance ≤ 2`、`last_accessed_at || created_at` 超过 `minIdleDays`（默认 45 天）。lesson 额外排除 `corrected=1`。
  - 第一档 sink：`importance-1`（最低 1），keywords 追加 `decay:沉底@YYYY-MM-DD`。
  - 第二档 stale：沉底满 `relabelDays`（默认 30 天）且期间没再命中 → `status='stale'`，原文一字不动。
  - **标记带 `decay:` 前缀**：dsh-toy「潮」的八档里正好有一档叫「沉底」，裸词被当成衰退标记会误杀真实条目（真库预览时当场撞到）。裸词原样保留，只追加自家标记。
  - 动手前 `VACUUM INTO` 备份并逐表核对行数，对不上就停；apply 前重新预览校验，名单过期直接拒绝；事务写，失败回滚。
  - `tools/decay.mjs`：默认只预览，`--apply` 才动；`--days / --relabel-days / --max-importance / --tables / --json`。
  - 兼容 meow 七层表与 builtin 单表 `memories`。
  - 自测：`tools/selftest-decay.mjs` 12 条；`check.mjs` R14；99/99 + O* 11/11；依赖方向 27 文件 PASS。


## 0.4.3 — 2026-11-21

- **when 命中计数（记忆系统第 3 条前半：先把数据架子搭起来，暂不调权）**。
  - `when_index` 加三列 `hit_count` / `bad_count` / `last_hit`；`ensureWhenTable` 先用 `pragma table_info` 判缺哪列再 `alter table add column`，老库原地升，不重建、不动旧行。
  - `memory/when.mjs` 新增 `bumpWhenHit` / `markWhenBad` / `readWhenStats`；`putWhen` 的 upsert 不碰计数列。
  - `adapters/dsh/prestep.mjs`：命中就记账，**dry-run 也记**；并且 dry-run 也进冷却。原来 dry-run 跳过冷却，同一条每步都命中，日志里的命中数是假的——数据失真比没数据更糟。
  - `tools/when-stats.mjs`：`--db` 看排行（命中/误报/最近命中）；`--bad <level>#<id>` 手动标误报；`--json` 给机器读。
  - 自测：`selftest-when` 23→31 条（计数 / 误报 / 缺 id / 老表补列 ×3）；R13 加「dry-run 也要记账」断言；`check.mjs` 98/98。
  - **日志降噪**：未命中的 `when-scan` 每 10 步一行（行内带 `steps=` 累计 / `miss=` 累计，命中率的分母不丢）；`no-tool-call` 同样首次照写、之后每 10 步一行。soul.log 实测已 10 MB / 36 002 行，每步一行的写法撑不住。
  - 为什么先只做计数：调权没有 hit/bad 样本就是拍脑袋。dry-run 这几天顺手把数据攒了，有样本再定权重怎么改。