# Changelog

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