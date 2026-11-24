# 配置参考

所有配置写在 profile 的 `cordis.patch.yml` 里 `- id: soulweave` 的 `config:` 下。**`config` 是整体替换，不是深合并**——写了就一次写全。

路径里的 `<插件目录>` 由 `import.meta.url` 推出，不用 `process.cwd()`。

## 完整配置表

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `soulPath` | `<插件目录>/soul.md` | 人格文件（只读；只有 `soul_persist` 追加第四节） |
| `extraSoulPaths` | `[]` | 额外常驻文件，按数组顺序拼在 `soul.md` 之后；共用预算与降档，缺失时跳过并写 `soul-warn` |
| `stateDir` | `<DSH_HOME>/soulweave` | 运行态目录（日志、cue 状态、默认记忆库） |
| `notesDir` | `<stateDir>/notes` | 笔记根目录 |
| `logPath` | `<stateDir>/soul.log` | 只追加的 UTF-8 日志 |
| `relationsDir` | `<stateDir>/relations` | 关系层 `*.md`（按文件名倒序取最新一份） |
| `moodPath` | `<stateDir>/mood.md` | 情绪状态 |
| `routerPath` | 空 | 路由层：一行一条「触发 → 去哪」 |
| `rulesDir` | 空 | 规则原文目录：稳定段只注入标题索引，细则走第⑤源 |
| `rulesIndexMaxTokens` | `120` | 规则索引预算（tok）；0 = 不注入索引，第⑤源仍可用 |
| `archiveRoot` | `<stateDir>/archive` | 封存根目录（给 sealed 模块校验 manifest 路径） |
| `memoryBackend` | `builtin` | `builtin` / `meow` / `none` |
| `memoryDbPath` | `<stateDir>/soul-memory.db` | 记忆库路径（meow 后端时指向 meow 的库） |
| `sealedSegmentsModule` | 空 | 封存模块（路径或包名） |
| `sealedModule` | 空 | 旧名，仍兼容 |
| `soulIndexDir` | 空 | 原文库目录（含 `query.py`） |
| `soulIndexPython` | `python`（非 Windows 为 `python3`） | 跑 `query.py` 的解释器 |
| `soulMaxTokens` | `1000`（可调到 8000） | 魂引 token 上限；上界只是防手滑 |
| `soulWarnTokens` | `1100` | 魂引超过这条线写一条 `soul-warn`，不夹、不降档；设 0 关闭 |
| `totalMaxTokens` | `950` | 四类注入合计上限 |
| `fixedMaxTokens` | `2500` | 快照超这个值才在末行申报 |
| `enforceBudget` | `false` | true 才真把目录型注入从本轮剔掉 |
| `soulSplitInjection` | `true` | 稳定段 / 现状拆开注入；关掉退回每步全量 |
| `pendingLimit` | `3` | 「现在在哪 → 手头未结」条数 |
| `pendingMode` | `count` | 未结只报条数；`full` 为旧行为 |
| `recallLimit` | `3` | `soul_recall` 默认条数（上限 5） |
| `hybridSearch` | `false` | true 时记忆源走「BM25 + 向量」名次合并（RRF） |
| `embedModule` | 空 | 向量模块路径或包名；空 = 纯 BM25 |
| `embedCachePath` | 模块自带 | 向量缓存 SQLite 路径 |
| `embedModelDir` | 模块自带 | 模型根目录（要含 `<org>/<model>` 两层） |
| `gamedevSkillsDir` | `<工作区>/skills/gamedev` | 可选游戏开发技能库（只读 `INDEX.json`） |
| `biliDbPath` | 环境变量 `BILI_SESSIONS_DIR` 或 XDG 路径 | `soul_toolout` 的目标库 |
| `pluginRoots` | 工作区 `plugins` + profile `node_modules` | `soul_capabilities` 扫插件用 |

## 记忆后端

| 值 | 说明 |
|---|---|
| `builtin`（默认） | 自带最小 SQLite，表 `memories`，首次访问自动建库 |
| `meow` | 只读适配 meow-memory 的七层库（`soul/user/rules/project/fact/topic/lesson` + cue 表）；库路径必须自己给 |
| `none` | 所有依赖记忆的功能返回空数组，不报错 |

`builtin` 打开一个**其实是 meow 老库**的文件时（有 `soul`/`user` 表、没有 `memories` 表）会自动按 meow 语义读——这是给老用户的兼容口子。

`soul_tier --apply`（降权）与 `soul_cue`（cue 刷新）只会写 meow 的结构；在 builtin/none 下它们会明确返回「只支持 meow」，不会假装成功。

## 检索源（`soul_recall`）

五源注册制，没配置的源不注册：

| 源 | 开关 | 默认 |
|---|---|---|
| 记忆库 | `memoryBackend` ≠ `none` | 开 |
| 封存段 | `sealedSegmentsModule` 非空 | 空（不注册） |
| 笔记 | `notesDir` 存在 | 开（目录不存在就空） |
| 原文库 | `soulIndexDir` 非空（`python query.py --json`，Python + FTS5） | 空（不注册） |
| 规则原文 | `rulesDir` 非空（只读 `*.md`，命中给 `rules/<文件>:<行号>`） | 空（不注册） |

封存模块的解析顺序：显式路径 → 包名 `import` → 用 `$DSH_HOME/profiles/*/node_modules` 解析包名 → 都失败就跳过并在结果里写「封存源不可用」。没有写死的同级目录回落。

单个源抛错只写 note，不拖累其余源。结果里 `sources` 给各源命中数，`active` 给本轮真正启用的源 id。

原文库查询有熔断：连续失败后按 60s / 300s / 900s 退避，期间直接返回「原文库熔断中」，不再 spawn Python。

## 混合召回（可选）

`hybridSearch: true` 时，记忆源的候选不是只来自 BM25，而是两路各召回一批再合并：

```
BM25（后端自带）  ─┐
                   ├─ RRF: 1/(60+bm25名次) + 1/(60+向量名次) ─→ 前 N 条
向量（可选模块）  ─┘
```

只对 BM25 的候选做重排是不行的——BM25 没召回的条目，重排也救不回来，所以取并集。也不做分数加权：BM25 分和余弦相似度不在一个量纲，RRF 只用名次。

向量模块**不随插件发布**（模型约 95MB + transformers 依赖）。要用自己装，然后在 profile 里配：

```yaml
    hybridSearch: true
    embedModule: /path/to/semantic-search/embed.mjs
    embedCachePath: /path/to/semantic-search/cache.db
```

模块缺失、模型加载失败、编码抛错，一律原样退回 BM25，只写一行 `console.error`，不影响召回。

## 设置面板（可选）

装好后侧边栏会出现「魂织」图标，可以直接改八项常用配置：

| 项 | 键 | 说明 |
|---|---|---|
| 魂引上限 | `soulMaxTokens` | 最高 8000 |
| 魂引警示线 | `soulWarnTokens` | 超线只写日志提醒，不夹、不降档 |
| 四类注入合计上限 | `totalMaxTokens` | 魂引、记忆、现状、路由合计 |
| 超预算时裁剪别人的注入 | `enforceBudget` | 关着只申报超支，不静默裁 |
| 「现在在哪」条目上限 | `pendingLimit` | 超限只留最近 3 条 |
| soul_recall 默认条数 | `recallLimit` | 上限 5 |
| 稳定段 / 动态段拆分注入 | `soulSplitInjection` | 关掉退回 legacy 每步全量 |
| 混合召回 | `hybridSearch` | embed 缺失时自动退回 BM25 |

面板**不改 profile 的 `cordis.patch.yml`**，只写 `<stateDir>/panel-override.json`；启动时在 `normalizeConfig` 之前合并，优先级「面板覆盖 > profile > 默认值」。保存后重启生效；「恢复 profile」会删掉覆盖文件。
