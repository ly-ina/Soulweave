# Changelog


## 0.12.1 — 2026-11-26

修 CI 红：`memory/graph.mjs` 违反依赖方向守卫（0.12.0 带着这条上去了，本地没拦住）。

- `memory/graph.mjs`：删掉 `node:fs` / `node:path` / `node:sqlite` 导入与 `openGraphDb`；DB 句柄改由调用方用 `storage/index.mjs` 的 `openDatabase()` 打开后传入。memory/ 层回到零 `node:` 依赖。
- `check.mjs` R23：扫描范围从「core/ 顶层」扩到 `core` / `memory` / `storage` 全递归，`node:sqlite` 只放行 `storage/driver.mjs`。这条本地早该拦住。
- check **129/129**；`check-layers` / `gen-api --check` / `clean-install` / `npm pack --dry-run` 四项全绿。
## 0.12.0 — 2026-11-26

L1 记忆图：PPR 扩散 + Context Momentum + 建边。第六路的算法层齐了（还没接进注入）。

- `memory/ppr.mjs`（新）：个人化 PageRank，**死守 2 跳**（BFS 跳数 > 2 的节点权重强制归零，不靠阻尼衰减）；枢纽惩罚 `deg > P95` 时乘 `1/log(deg)`；种子接受 Map / 数组 / 裸对象 / 单 id；边接受 `{from,to}` 和 `{a,b}` 两种形状。
- `memory/momentum.mjs`（新）：分会话势能状态机。工作（60s 内 >30s 且 ≥2 次）`+0.08`，亲密 `-0.15`，压低后转工作「覆写回拉」，压缩归 `0.60`，软区间 `0.50~0.85`。`createMomentumStore` 落 `state/momentum.json`，重载按 `lastAt` 回弹一次。
- `memory/graph.mjs`（新）：`same-scene`（when 的 tool/pathPattern/timeWindow 任一相等）+ `same-source`（同一会话，时间滑窗）建边；`maxDegree` 限流（默认 16），边表 `memory_edge(a,b,relation)`，a<b 归一化，hits/bad 留 §6 反馈口；`graphStats` 算连通分量。
- `memory/assoc.mjs`（新）：查询壳。给种子记忆沿图扩散 2 跳，只补召回、不替代相似度检索；裸 id 自动补 `memories#` 前缀。
- `tools/build-graph.mjs`（新）：默认 dry-run，`--apply` 写库；`--all` 把七层老表的 when 也收进来。
- 真实库实测：606 节点 / 5934 条 same-source 边 / 46 个分量 / 最大分量 **37.4%**（验收线 30%）；PPR 从一条种子扩散出 2 跳 33 个邻居，联想内容语义相关。
- check **129/129**（新增 P1 / MO1 / G1 / L1）。

## 0.11.4 — 2026-11-26

记忆侧接 scene：`soul_remember` 写入时自动带情境签名，不用人填。

- `memory/builtin.mjs`：`memories` 补列 `scene_id`（老库自动 ALTER）；`putMemory` 写入/更新都带上。
- `memory/scene-link.mjs`（新）：`latestScene` 只取 15 分钟内的最近一行（按 sid 过滤）；`whenFromScene` 由 `path_pattern` 生成目录 glob（`memory/scene.mjs` → `*memory/*`）+ `time_window`；`tool` 不自动签（太窄，签上几乎不会再命中）。
- `core/remember.mjs`：显式 `when` 优先、scene 只补缺；when 写进 `when_index`（level 口径用表名 `memories`，否则情境检索按表查取不到）；回执带 `when=… / scene=…`。fail-open，签不上不影响正文。
- `core/search.mjs`：情境检索加读 `memories` 表——之前只扫七层老表，自动签的 when 没有消费方。
- `adapters/dsh/apply.mjs`：`soul_remember` schema 加 `when` 参数（tool / pathPattern / timeWindow）。
- check **125/125**（新增 M1：提取 → 自动签名 → 落库 → 情境命中 / 时段不符不命中 → 显式覆盖自动）。

## 0.11.3 — 2026-11-26

scene 的 sid 也跟着保留 `session-` 前缀，和树索引/原文库对齐。

- `memory/scene.mjs`：不再剥 `session-`；tracker 的 key 同样原样保留。
- 0.11.2 里只改了 tree、scene 还剥前缀，导致 `summary.scene_id` 绑不上（S2 红了一次，已修）。
- 库里已有的 45 行 scene 与那条 summary 的 `scene_id` 一起迁回带前缀的 id。
- check **124/124**。
## 0.11.2 — 2026-11-26

sid 前缀修正：**不要剥 `session-`**。

- 实测本会话在原文库里是 `session-8a813a0b-…`（回填 6189 条），0.11.0 的「剥前缀」反而把它写成第二个 sid（在线 t1、回填 t1..t6189 对不上）。
- `adapters/dsh/tree-ingest.mjs` 的 `normalizeSid` 改为原样保留；T1 断言改回 `session-t1`。
- 已把库里那条误写的 `8a813a0b-…:t1` 迁回 `session-8a813a0b-…:t6190`（summary / frag / frag_summary / kw_link 一起改）。
- 在线写入首次实证：`t6190` 的 `scene_id` 非空，树 → scene 闭环。
## 0.11.1 — 2026-11-26

树索引缓存落盘：热重载不再吃掉「改代码那一轮的 user 消息」。

- `adapters/dsh/tree-ingest.mjs`：每收一条 user/assistant 就把缓存写到 `tree-buffer.json`（与记忆库同目录），`turn/end` 写完清空。热重载重建引擎时从缓存恢复，未完成的那一轮接着写。
- check 新增 T2：旧引擎收 user → 新引擎从缓存恢复收 assistant → `turn/end` 落库成功。**124/124**。
- 前两轮在线 summary 一直验不到，原因就是 HMR 重建时内存缓存被丢；不是 turn/end 没来。
## 0.11.0 — 2026-11-26

SPEC-V2 §1：scene 落库。工具调用第一次有了「在哪儿、用什么、碰了哪条路径」的坐标。

- 新增 `memory/scene.mjs`：纯提取器 + 无 IO 的 tracker。输出 `sessionId / tool / cwd / pathPattern / timeWindow / intimacy / toolMsWindow / toolCount / at`；`pathPattern` 只存工作区相对路径或末两级，不落完整用户目录。
- 新增 `adapters/dsh/scene.mjs`：挂 `session/event`，每次 `tool/call` 写一行；同轮重放 `INSERT OR REPLACE`，全程 fail-open。
- `core/tree/schema.mjs` 升到 **v2**：建 `scene` 表（sid/seq/turn/step/tool/cwd/path_pattern/time_window/intimacy/tool_ms_window/tool_count/t），`summary` 补 `scene_id` 列（老库自动 `ALTER TABLE`）；`tree_meta.schema_version` 改为可更新。
- `core/tree/ingest.mjs`：写 summary 时自动绑该会话最近一条 scene。
- `apply` 默认挂载 scene 记录，`sceneRecorder: false` 可关。
- 真实事件验证：从当前会话日志里抽 `tool/call`（`{"type":"tool/call","data":{"turn":6141,"step":24,"name":"ps","arguments":"…"}}`），提取器输出非空；实跑后库里已有 10 行真实 scene。
- check 新增 S1/S2（提取器 + 落库 + summary 绑定），**123/123** 通过。

## 0.10.6 — 2026-11-26

树索引在线增量：新对话不再等离线回填。

- 新增 `core/tree/ingest.mjs`：单轮落 `frag / summary / kw / kw_link`，df 现算、topk 砍枝；权重用 `log(1 + N/df)` 平滑（库里只有一条时 `log(N/df)=0` 会把词全删光，实测踩到）。
- 新增 `adapters/dsh/tree-ingest.mjs`：挂 `session/event` 缓存本轮 user/assistant 正文，`turn/end` 写进记忆库；只收 `source.kind === 'user'`，魂引/记忆快照不进索引；全程 fail-open。
- `apply` 默认挂载，`treeIngest: false` 可关；`memoryBackend: 'none'` 自动不挂。
- check 新增 T1：真实事件序列 → 检索命中 → 原文回溯 → 注入过滤 → 同轮重跑不重复。121/121 通过。

## 0.10.5 — 2026-11-26

署名防删（拦得住顺手抄的人，拦不住下决心的人）。

- 85 个源文件（`.mjs` / `.js`）头三行内加统一版权行：`Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）`。删署名要逐个改 85 个文件。
- 新增 `NOTICE`：专有声明、MIT 留档说明、中英双语。
- `verify-release` 新增 `R9 署名完整`：每个跟踪的源文件头三行内必须有版权行，缺一个就红。
- `package.json` 的 `files` 加入 `NOTICE`。
## 0.10.4 — 2026-11-26

不经过 npm 的一键安装。

- 新增 `install.mjs`：自动找带 `dsh.profile.bundles` 的 profile，写 `link:` 依赖、追加 bundles、建 junction / symlink、复制 `soul.example.md → soul.md`，并打印 `cordis.patch.yml` 片段。支持 `--dry-run` / `--profile`，可重复执行（幂等）。装完即可用，不联网。
- README 安装段改为「clone + `node install.mjs`」；npm 不是安装路径。
- `package.json` 的 `files` 加入 `install.mjs`。
## 0.10.3 — 2026-11-26

发布闸门从「5 红」修到全绿，顺带把产品代码里的私有痕迹清干净。

- **verify-release**：R5 只扫本机绝对路径（人名属产品示例，CHANGELOG 属历史记录，均豁免）；R6 只拦数据产物（`.db` / `.log` / `state/`），不再误伤 `memory/` 源码目录；R7 没有 `SOULWEAVE_PRIVATE_SOUL` 时记 SKIP 而不是 FAIL；R8 对齐 README 现有标题（`## 30 秒跑起来` / `## 配置`）。
- **隐私**：README、VERIFIABILITY、RECORDS-FORMAT、SPEC-V2、`tools/when.mjs` 里的本机绝对路径改成 `<workspace>` / `<DSH_HOME>` / `<private-workspace>` 占位。
- **仓库边界**：内部交接档案（`HANDOFF.md`、`REPORT*.md`、`TASK-解耦.md`）移出版本库，本地保留；`package.json` 的 `files` 同步去掉 `REPORT.md`。
- **curator**：项目保护名单与情感词表改成配置项 `archiveProtectedProjects` / `archiveEmotionWords`，产品代码不再硬编码私有项目名与人名。
- 自测：`check.mjs` 120/120 + O* 11/11，`check-layers` 42 文件 0 违规，`verify-release` ALL PASS。
## 0.10.2 — 2026-11-26

1.0 收尾之一：存储层能说清「为什么打不开」。

- **feat(storage)**：新增 `storageStatus()` → `{ driver, ready, lastFailure }`。
  `lastFailure.reason` 分 `no-driver` / `no-path` / `not-a-file` / `mkdir-failed` / `open-failed`。
  以前没装驱动时 `current.open` 抛 TypeError，被 catch 成 null，和「库损坏」长得一模一样。
- **fix(storage)**：`openReadonly` / `openReadWrite` 在无驱动、空路径时先行返回 null 并记账，
  不再靠异常吞掉；`configureStorage()` 复位时清空记账。
- **test**：smoke-storage 17 → 23 项（新增诊断断言）。
- **feat(path)**：补齐 `normalize` / `parse` / `format` / `toNamespacedPath`，
  `io.mjs` 一并 re-export。（与 `node:path` 在 `C:/a//b/` 这类混合/重复分隔符、
  Windows 盘根 `/x` 的解析上仍有边角差异，已注释说明；不影响插件内部调用。）
- **fix(path)**：`splitPath` 先把 `\\server\share` 的前导双斜杠保住再折叠，
  以前会压成一个反斜杠，UNC 路径退化成「根下的相对段」。
- **fix(apply)**：`records` 挂载诊断原来无条件 warn 一次行；改为只在
  `records.enabled=true` 但宿主没给 `ctx.on` 时报警。

## 0.10.1 — 2026-11-26

原文库检索提速：12 万行库上 `压缩 巡检` 从 ~760ms 降到 ~11ms。

- 只读连接开 `mmap_size` / `cache_size`：顺序 LIKE 少走 read syscall。
- `stale` 判定改主键倒序取最后一条（`MAX(time)` 没索引，白花 130ms）。
- 短词 LIKE 改主键倒序 + LIMIT 早停，不再全表扫完再排序。
- 「今天/昨天」时间窗只取 n 条候选（窗口内命中少，取多了反而退化成全扫）。
- 结果统一按时间倒序（原文库是回忆最近发生过什么），短词只取最近 n 条候选。
- 修复 `msg_fts` 索引停在 id ≈ 4 万（11-01 前后）的数据问题：external content
  表上 `MAX(rowid)` 会委托给 `messages`，水位式增量永远为空。改为 messages 上的
  INSERT/DELETE/UPDATE 触发器自动同步，并全量 rebuild 补齐（39926 → 119720 条，
  27.5s）。`memory` 这类纯英文长词现在能查到最新内容。

## 0.10.0 — 2026-11-26

**原文库检索不再需要 Python：`core/soul-index.mjs`（SDK 第 20 个承诺面）**

- **feat(core)**：新增 `core/soul-index.mjs`，把 `lanxi/tools/soul-index/query.py` 的检索逻辑 1:1 搬成 JS——读 `dict.json` 同义词、查 `msg_fts`（FTS5 trigram）走 `bm25`、短词与中文二元组走 `LIKE` 兜底、命中处抠 160 字摘要、`今天/昨晚/前天` 折算本地日历日时间窗。与 Python 版逐条对照过：`纳 记 珍藏` / `压缩 巡检` / `脸红` 三组查询的 `when / role / origin / sid / seq / snippet / score` 完全一致。
- **feat(sdk)**：`searchSoulIndex` 进承诺面，导出 19 → 20。它只需要宿主注入 `readFileSync / existsSync / statSync` 并注册 sqlite 驱动——**不需要子进程、不需要 Python**。已在「不装配 io-node」的模拟宿主上实测通过（手工 `configureIo` + `configureStorage`，查真实 11.9 万条原文库）。
- **change(recall)**：第四源改成**进程内检索优先**，`spawnProcess('python', query.py)` 退为兜底（无驱动 / 库不在 / SQL 报错时才走）。Node 宿主上不再每次起子进程；非 Node 宿主从「这条路整条消失」变成「装上驱动就能用」。
- **feat(tools)**：新增 `tools/smoke-soul-index.mjs`（16 条断言）：纯函数、FTS 长词、LIKE 短词 + 同义词、时间窗、tool 过滤、三种降级原因。自己建同 schema 小库，不依赖真实原文库。
- **docs**：`EMBEDDING.md` 补「原文库检索不需要 Python」一节与注入表更新；README / HANDOFF / index.js 的承诺面数字 19 → 20；`docs/API.md` 重新生成（410 个导出 / 公开 20）。
- 回归：`check.mjs` 120/120 + O* 11/11、`check-layers` 42 文件 0 违规、`smoke-soul-index` 16/16、`smoke-sdk` 10/10、`smoke-storage` 17/17、`smoke-records` 17/17、`gen-api --check` PASS。

## 0.9.1 — 2026-11-26

**触发词只认正文：`reasoning` 里写的不算**

- **change(records)**：`adapters/dsh/records.mjs` 只从 `text` block 抓 `※记` / `※办` / `※结`，不再扫 `reasoning`。原因是纳指出的一句话：**「我脑子里过一遍 `※记`，它照样扫出来落库——等于心里嘟囔一句就算数。这个得掐掉，只认真写出来的。」** 顺带治掉同一条被记两遍的老毛病：思考里一份、正文里一份，措辞不同就绕过 sha 去重，库里出现两条近似记忆（11-26 上午 `m-mwx2vykv-gkah` / `m-mwx2vykl-04dd` 就是这类施工便条，已 archived）。
- **change(cue)**：巡检文案跟着改——「单独一行，用 `※记` 开头写一句（写进正文，思考里不算）」「在下一次压缩之前……写进正文」。压缩后提醒同步。
- **docs(core)**：`core/record-extract.mjs` 的职责与 `@param` 从「reasoning 全文」改成「正文全文」；纯解析逻辑未动（它本来就只吃字符串，不关心来源）。
- **test(smoke-records)**：新增 R2b「只认正文：`reasoning` 块不抓」——同一条 `assistant/message` 里同时放 `reasoning` 和 `text` 块，断言只落一行、`from=text`、内容是正文那句。R3/R4 的硬编码行数改成跟着 R2b 走。17 通过 / 0 失败。
- **docs(rules)**：`lanxi/rules/memprobe.md` 追加一条：原「写在思考里，正文不出现」作废，改为**只认正文**。
- 全量回归：`check.mjs` 120/120 + O* 11/11、`check-layers` 41 文件 0 违规、`smoke-records` 17/17。

## 0.9.0 — 2026-11-26

**1.0 第四步（最后一刀）：剥离 node 内置依赖，SDK 面零 `node:`**

- **feat(path)**：新增 `path.mjs`——零依赖路径运算（join / resolve / dirname / basename / extname / relative / isAbsolute / sep）。不维护全局平台状态，按传入路径自判 win32 / posix；23 条与 `node:path` 逐条对照。
- **feat(sha256)**：新增 `sha256.mjs`——纯 JS SHA-256，同时给 `createHash('sha256')` 同形门面，调用点只换 import。8 条对照（含 5000 字符跨块）全等。
- **refactor(io)**：`io.mjs` 改成**零 `node:` 的注入门面**；Node 实现移到 `io-node.mjs`（fs / os / env / argv / spawn / zstd / requireResolve）。新增纯函数 `fileURLToPath` / `pathToFileURL` / `isMainModule` / `cliArgs`。`configureIo` 首次调用记为「宿主基线」，`resetIo()` 回基线（原来回空实现，会把后续流程全弄挂）。
- **refactor(storage)**：`storage/index.mjs` 不再静态 import 驱动；新增 `storage/node-sqlite.mjs` 由宿主显式注册。`configureStorage(null)` 语义变为「复位成无驱动」。
- **refactor(core/memory)**：19 处 `node:path`、4 处 `node:crypto`、3 处 `node:url`、1 处 `node:module` 全部改走零依赖实现或 io 注入；`Buffer` 全换 `TextEncoder/TextDecoder`，`randomUUID` 用 `globalThis.crypto`。
- **feat(package)**：新增 `./io-node`、`./storage-node-sqlite` 两个导出；`index.js` 前两行完成装配（DSH 里零感知）。
- **change(breaking)**：SDK 用户（`soulweave/sdk`）现在必须自己装配两行；`configureStorage(null)` 不再回 sqlite。接入见重写的 `EMBEDDING.md`。
- **test**：`check.mjs` R33 加硬验收——用 `no-node-loader` 在子进程里拒绝一切 `node:*` 再 import SDK；`check-layers.mjs` 规则扩成「core/memory/storage 一律禁 `node:*`」。全量 120/120 + O* 11/11、四个冒烟、三个 example 全绿。
- **docs**：`EMBEDDING.md` 重写成真正的接入指南；`README.md` / `docs/ENGINEERING.md` 同步分层规则；`HANDOFF.md` §3c 标记完工。
## 0.8.0 — 2026-11-26

**1.0 第三步：并入 dsh-memprobe（※记 / ※办 / ※结 记录捕获）**

- **feat(core)**：新增 `core/record-extract.mjs`（原 memprobe `lib/extract.mjs`，180 行纯函数，零宿主依赖）。触发词解析、段落抽取、泄漏检测都在这一层。
- **feat(adapters)**：新增 `adapters/dsh/records.mjs`，导出 `attachRecords(ctx, config)`。挂两个监听：`agent/pre-step`（记忆巡检 cue，`turn===1` 或上下文骤降 ≥8 才注入）与 `session/event`（从 assistant 消息块里抽记录 → JSONL → 可选 `routeRecords` 落库）。
- **feat(config)**：`config.records`，字段沿用 memprobe 原名（`outPath` / `dbPath` / `routeKinds` / `triggers` / `targets` / `cue` / `dumpReasoning`）。**默认关**——只有 `records.enabled === true` 才挂，避免 HMR 重载时和旧插件双写。
- **fix(dispose)**：原 memprobe 的 `ctx.on` 返回值没接，卸载不掉；现在 `attachRecords` 返回 dispose，`apply` 推进 `disposers`。
- **change(host)**：`cordis.patch.yml` 里 memprobe 段与依赖已摘除，配置搬进 soulweave 的 `records:`；profile `package.json` / `pnpm-lock.yaml` 同步（pnpm install 清了 11 个包）。
- **test**：新增 `tools/smoke-records.mjs` 14 条：两个 handler 挂上、`※记` 捕获写 JSONL、同事件去重、无触发词不写、dispose 摘干净且可重复调用。

## 0.7.0 — 2026-11-26

**1.0 第二步：抽出 `storage/` 层，`node:sqlite` 收口到一个文件**

- **feat(storage)**：新增 `storage/driver.mjs`（**全仓库唯一** `import 'node:sqlite'` 的文件）与 `storage/index.mjs`（公共接口：`openReadonly` / `openReadWrite` / `openDatabase` / `withReadonly` / `closeQuietly` / `configureStorage` / `storageDriverName`）。契约保持 sqlite 语句形状（`prepare / exec / close`），所以 14 个调用文件只换了构造那一行，查询代码一字未动；换后端时只要实现同样形状的 `open()`。
- **change(核心 14 文件)**：`core/` 的 budget / capabilities / cue / curator / persona / probe / search / soul_lint / tier / toolout 与 `memory/` 的 builtin / decay / legacy / when，全部改走 storage 入口。行为上多了一条统一保证：**只读打不开就返回 null，本层从不抛**（原来靠每个调用点自己 try/catch）。
- **feat(check-layers)**：守卫加 `storage` 为第四层——`node:sqlite` 只许 `storage/driver.mjs`；`storage/` 不得反向依赖 `core/` / `memory/`。39 个文件全绿。
- **fix(curator)**：`backupDatabase` 里 `VACUUM INTO` 原来用 `new DatabaseSync(dbPath)`（读写），改成 storage 入口时撞上 curator 自己导出的只读 `openDatabase`，变成「attempt to write a readonly database」。R22 逮住的。现按原语义分开：备份走 `openReadWrite`，核对走 `openReadonly`。
- **test**：新增 `tools/smoke-storage.mjs`（17 条断言）：路径不存在/是目录/空串 → null、只读连接写入被拒、`withReadonly` 必关且异常降级、`configureStorage` 换假驱动后 `readOnly` 正确透传、`closeQuietly` 吞异常。

## 0.6.0 — 2026-11-26

**1.0 第一步：根路径不再导出内部面**

- **breaking**：删除 `unstable.mjs`（118 个不承诺导出）。主入口导出从 146 降到 **28** = `./sdk` 的 19 个承诺面 + 6 个装配 + `name` / `inject` / `default`。旧代码若从根路径 import 内部函数，改走具体模块深路径（如 `dsh-soulweave/memory/builtin.mjs`），不复用稳定契约。
- **fix(apply)**：`ctx.on('agent/pre-step', ...)` 的返回值以前没进 `disposers`——每次 HMR reload 或重复 apply 都多挂一个 handler 且永远摘不掉。`tools/stress-lifecycle.mjs` 20 次采样就抓到 20 个残留。
- **test**：新增 `tools/stress-lifecycle.mjs`（`node --expose-gc tools/stress-lifecycle.mjs 100`）：每次 apply 都返回 dispose、监听器归零、工具注册归零、heap 增长 < 5MB。
- **test(check)**：`check.mjs` 里 76 个内部名字改为直接从具体模块 import，不再依赖根 barrel。
## 0.5.6 — 2026-11-25

**补一个真·接入示例：五步闭环**

- **feat(sdk)**：承诺面加 `initMemoryDb(dbPath)`（18 → 19）。建库 → 立刻关句柄 → 只读体检，返回与 `health()` 同形状，可直接交给 `renderHealth()`。以前示例要手写 `ensureDb()` + `close()` + `health()` 三步，还得 import `memory/builtin.mjs` 才能拿到 `DatabaseSync` 句柄——Windows 上忘了关会锁住目录。写路径（`putMemory` / `putTodo`）本来就会按需建库，所以它不是必须的；价值是把「库建不起来」从第一次写入失败提前到启动时失败，且调用方不碰内部模块和句柄。
- **docs(examples)**：新增 `examples/sdk-quickstart.mjs` —— 建库 → 写记忆 → 写待办 → 读现状段 → 按指针检索，全用 `sdk.mjs` 的承诺面。既有的 `node-cli.mjs` / `embed-demo.mjs` 各自只演示了片段，缺一份「从空目录到现状段有内容」的完整顺序。
- 示例里钉住三个容易踩的点：`parseDue` 返回 null 时必须降级成记忆；`due` 是本地时区 ISO 串；`composeSoulState` 的「在场」行需要 `present.pending` / `present.memories` 非空才渲染，只给 `present.project` 不出来。
- **fix(health)**：`health()` 原来用裸 `new DatabaseSync` 读 pragma，摘要里的 `busy=` 恒为 0——那是它自己那条只读连接的默认值，不是写连接的 4000。改走 `openDb`（与写连接同一套 pragma）后显示 `busy=4000ms`。这属于「报了个误导的数」，不是文档能救的。
- `package.json` 加 `example:sdk`；README 两条轨道那段指向新示例。

## 0.5.5 — 2026-11-25

**gen-api 加内容自检；README 写明两条轨道**

- **fix(tools)**：`gen-api --check` 以前只验证「生成结果 == 文件」。生成器算错了，它就和文件一致地错，所以永远绿——0.5.4 修的三个解析 bug（嵌套类型花括号、参数名残渣、签名被 `Date.now()` 截断）在三个版本里 CI 全 PASS。现在生成后独立跑 `assertContentSane()`：参数表里每个名字必须是合法标识符或 `[可选名]`，否则退出码 1。**负向验证过**：故意恢复旧解析，当场报出 13 处 `>}` 残渣。
- **docs(README)**：写明两条轨道——`soulweave/sdk` 18 个承诺面、主入口 130（18 承诺 + 112 历史兼容）。主入口的额外导出是为兼容 0.5.x 保留、不承诺稳定性，1.0 时移除。

## 0.5.4 — 2026-11-25

**拆出 `sdk.mjs`：公开 API 不再必须经过插件入口**

- **refactor**：`index.js` 之前同时是 dsh 插件入口（`export default { name, inject, apply }`）和公开 API 出口。外部消费者 `import 'soulweave'` 会被 `adapters/dsh/apply.mjs` 的宿主依赖拖住 —— `routeRecords` 明明已公开，实际只能绕去 `import memory/route.mjs`。
- **feat**：新增 `sdk.mjs` + `package.json` 的 `exports["./sdk"]`，只 re-export `core/`、`memory/`、`io.mjs`，一个 `adapters/dsh/*` 都不 import。单独 `node -e "import('./sdk.mjs')"` 能加载（130 个导出）。
- `index.js` 保留全部旧导出（`export * from './sdk.mjs'`），现有消费者零改动。
- **refactor**：`sdk.mjs` 收窄成 **18 个承诺导出**（拼装/路由/时间/锚点/存取/体检），其余全部搬去 `unstable.mjs`（明确不承诺）。导出越多承诺越多——`bigramsOf` 这种内部工具改掉不该算破坏性变更。`index.js` 仍然同时带两边，旧 import 零改动。
- **test**：新增 R33 —— 静态递归走 `sdk.mjs` 的 import 图，断言不出现 `adapters/` 和裸包名；再起独立 node 进程加载。断言分三段：核心导出必须在、**总数不许超过 40**（旧版 `> 100` 会把「没做筛选」判成通过）、index.js 仍带不承诺面。首版曾因注释和 SQL 模板里的 `from` 字样假红，正则已收窄到行首。
- **fix(tools)**：`gen-api` 三处解析 bug —— `@param`/`@returns` 的嵌套类型花括号（`{{ok:boolean}}`）会漏成 `>}` 残渣；函数签名非贪婪匹配到第一个 `)`，参数里有 `Date.now()` 就截断。现在按括号配对扫描。
- **fix(tools)**：`gen-api --check` 改读 `sdk.mjs`。读 `index.js` 时 `export *` 后面的名字全丢，公开数会变成 0。
- `check` 120/120、`check-layers` 37 文件、`gen-api --check` PASS。

## 0.5.3 — 2026-11-25

**修 API 文档校验在 Windows 上的换行符失败**

- Windows 上 git 把 `docs/API.md` checkout 成 CRLF，与生成器的 LF 逐字节不等，`gen-api --check` 在 `windows-latest` × Node 22/24 两个 job 上失败（ubuntu 通过）。
- `--check` 比对前统一换行符；另加 `.gitattributes` 把该文件固定为 LF，避免工作区抖动。
- 本地用「把文件转成 CRLF 再校验」验证过：PASS。

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



