# VERIFIABILITY — 魂织断言总表

> 原则（借自 routing-suite 的研究验收格式，2026-11-12）：每条断言给出**来源**（文件:行 / 文档节）、
> **证据**（数值或日志字段）、**复现路径**（可执行命令或日志定位）。
> 跑不通的断言写进最后一节，不写进表里充数。

本表所有「证据」列的值都取自本机 `<DSH_HOME>/soul/soul.log`，
字段口径与该文件每行 `inject ...` 记录一致。

## 1. 注入与预算

| # | 断言 | 来源 | 证据 | 复现路径 |
|---|---|---|---|---|
| V1 | 每轮注入有硬预算，超出按 `YIELD_ORDER` 逐档降级，魂引与时间行永不砍 | `index.js:84` `TOTAL_TOKENS = 950`；`YIELD_ORDER = ['archive','partition','soul-recall']` | `node verify-budget.cjs` **7/7 PASS**；构造 total=2000 时三档全 cut、after=1800、ok=false、over=850，soul/time 未进入 cut | `node verify-budget.cjs` |
| V2 | 人格每节最多 8 条，截断时留标题和回查提示 | `index.js:151` `SOUL_SECTION_CAP = 8`；`composeSoul` 的 `overflow()` | `soul.log` `soul=784tok/full`；超限时正文出现「另有 N 条」 | `Select-String 'dsh-soulweave\index.js' -Pattern 'SOUL_SECTION_CAP'` |
| V3 | 快照三类各自限流：initial 1 / reinjection 1 / hit 2 | `index.js:1143` `SNAPSHOT_CAPS` | `soul.log` `pruned=hit:<id>/1` 表示 hit 类已到顶 | `Select-String 'dsh-soulweave\index.js' -Pattern 'SNAPSHOT_CAPS'` |
| V4 | 快照只保证「不再增长」，不删历史 | `planSnapshotPrune` 注释（`index.js:1090` 附近） | `soul.log` `pruned=none` 与 `pruned=hit:…` 交替出现 | 同上 |

## 2. 生命周期

| # | 断言 | 来源 | 证据 | 复现路径 |
|---|---|---|---|---|
| V5 | 压缩后人格保留、当轮重新注入 | `soul.log` `why=reload` 分支 | `2026-11-12T00:20:31.515Z reload … previous=25654tok current=122tok` | `Select-String soul.log -Pattern 'reload 压缩后重载'` |
| V6 | 召回冷却默认 60 分钟，但压缩/reload 后主动重置 | `index.js:477` `recallCooldownMinutes: 60`；`resetRecallCooldownOnReload`（`index.js:1076`） | `soul.log` 同 id `0mvfbmfwr` 在 17 分钟内被召回 3 次，末次紧跟 `reload`（00:20:31） | `Select-String soul.log -Pattern 'recall ids='` 看同 id 时间间隔 |
| V7 | 每一步都实测注入量并记账，不靠估算 | `measureInjections` / `measureRequestBudget`（`index.js:1119` / `1207`） | 每行 `inject=113tok conv=0 fixed=113 total=113tok` | 任取 `soul.log` 五行，字段应齐全 |

## 3. 漂移与遮蔽

| # | 断言 | 来源 | 证据 | 复现路径 |
|---|---|---|---|---|
| V8 | 驻留快照里出现记忆正文即报警 | `detectSnapshotDrift` + `DRIFT_PATTERN`（`index.js:1304`） | `soul.log` 行尾 `anomaly=lesson:1` | `Select-String soul.log -Pattern 'anomaly=' \| Select-Object -Last 3` |
| V9 | surface 只遮不删，日志原文不动 | `surface.mjs`，`applyViaSession` | `soul_surface` preview 输出的段落数 | 调 `soul_surface`（mode=preview） |

## 4. 检索

| # | 断言 | 来源 | 证据 | 复现路径 |
|---|---|---|---|---|
| V10 | 五源检索（记忆库 / 封存段 / 笔记 / 原文库 / 规则原文）各自限量 | `soul_recall` 工具，`RECALL_MAX_CHARS = 1200`（`index.js:100`） | 实测一次返回五源齐全，单源 ≤3 条 | 调 `soul_recall(query=…)` |
| V11 | 规则索引只取标题层、受 `rulesIndexMaxTokens` 夹取，`rulesDir` 为空时渲染与 0.2.5 逐字节一致 | `readRulesIndex()` / `searchRules()` / `composeSoulStable` 的 `rules` 段（0.2.6） | `node check.mjs` **R12 PASS**：日期括号剥掉、`> 摘要：` 优先、预算 0 不给、预算 10 只给 1 行、命中 `rules/说话方式.md:3` | `node check.mjs`，或 `node rules-test.mjs`（真实目录 7 文件 103 tok） |

## 5. 未验证项（诚实清单，2026-11-12 收尾）

- **V9（surface apply）不验了**：2026-11-12 08:39 纳判定没必要。apply 是手动低频操作，
  代码有备份 + `verifySurfaceAfter` 失败还原，损失上限是单个会话看不见、原文不丢。
  只保留已完成的 preview 证据：`soul_surface` preview 返回「session-8a813a0b… 106 节点 / ≈14203 tok」。
- V5（连续两次压缩）由纳 2026-11-12 明确划掉，不再验。
- 2026-11-12 补记：V1 离线测试第一次写错期望（1000 砍掉 50 后正好回到 950，不该继续砍 partition），
  是测试用例错，不是函数错；修正后 7/7 PASS。
- 2026-11-12：`rulesIndexMaxTokens = 120` 时，本机 7 个规则文件实测索引 **103 tok**（7 行全给）。真跑起来后要在 `soul.log` 认 `rulesTok=` 这一列，不信估算。
- 2026-11-12 补记：曾用「658 tok 常驻 × 400 轮 = 26 万 tok」论证成本，被纳纠正——常驻体后续是缓存命中价，
  日常非缓存只有 113–200 tok，合计约 0.1 分钱。成本论证作废。
