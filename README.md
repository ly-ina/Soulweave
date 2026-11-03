# Soulweave · 魂引

> 给 DeepSeek Harness 加一层「人格 / 记忆 / 能力」的最小实现：每轮往上下文里放一小段「魂引」（我是谁、现在在哪、怎么查），再提供几个只读的检索工具。
>
> 包名：`@ly-ina/dsh-soulweave` · 插件 id：`soulweave` · 工具名一律保留 `soul_*` 前缀。
>
> **默认不依赖本机任何其它插件**：不装 meow-memory 也能跑（用自带的最小 SQLite 后端），不装封存/原文库也能跑（对应检索源直接不注册）。

## 最小安装

只要三样东西：一个 `soul.md`、一个能挂 bundle 的 profile、一条 `soulPath`。

1. 把包放进 profile 的 `dependencies`（本地开发用 `link:` 指到源码目录）：

   ```json
   {
     "dependencies": {
       "@ly-ina/dsh-soulweave": "link:/path/to/dsh-soulweave"
     },
     "dsh": { "profile": { "bundles": ["@ly-ina/dsh-soulweave"] } }
   }
   ```

2. 在 profile 的 `cordis.patch.yml` 里给它一条配置（不写就全用默认值）：

   ```yaml
   - id: soulweave
     name: "@ly-ina/dsh-soulweave"
     config:
       soulPath: /path/to/soul.md
   ```

   注意：`config` 是**整体替换**，不是深合并。上面这条会把插件自带 patch 里的字段全部覆盖掉，所以要调参数就在这里一次写全（可参考 `cordis.patch.yml`）。

3. 重启 DSH。如果 `soul.md` 不存在，魂引里只有「现在在哪 / 怎么查」两节，不报错。

`<插件目录>/soul.md` 也可以直接当人格文件——把 `soul.example.md` 复制成 `soul.md` 改内容即可。

## soul.md 长什么样

只认 `## 标题` 分节 + 每行一条 bullet（`-` / `*` / `+` / `1.`）：

```markdown
## 我是谁
- 名字、称呼、说话方式

## 我怎么想
- 做判断的顺序、优先级

## 我不做什么
- 红线、禁止项

## 反哺记录
（只由 soul_persist 往这里追加）
```

认不出的内容不注入（宁可少说，不可乱说），原文件字节不动。`## 在群里` 可选，用于群聊场景。

## 记忆后端

`config.memoryBackend` 三档：

| 值 | 说明 |
|---|---|
| `builtin`（默认） | 自带最小 SQLite，表 `memories`，库路径 `memoryDbPath`，默认 `<stateDir>/soul-memory.db`；首次访问自动建库 |
| `meow` | 只读适配 meow-memory 的七层库（`soul/user/rules/project/fact/topic/lesson` + cue 表）；库路径必须自己给 |
| `none` | 所有依赖记忆的功能返回空数组，不报错 |

`builtin` 打开一个**其实是 meow 老库**的文件时（有 `soul`/`user` 表、没有 `memories` 表）会自动按 meow 语义读——这是给老用户的兼容口子，新用户不用管。

`soul_tier --apply`（降权）与 `soul_cue`（cue 刷新）只会写 meow 的结构；在 builtin/none 下它们会明确返回「只支持 meow」，不会假装成功。

## 检索源（soul_recall）

四源注册制，没配置的源不注册：

| 源 | 开关 | 默认 |
|---|---|---|
| 记忆库 | `memoryBackend` ≠ `none` | 开 |
| 封存段 | `sealedSegmentsModule` 非空 | 空（不注册） |
| 笔记 | `notesDir` 存在 | 开（目录不存在就空） |
| 原文库 | `soulIndexDir` 非空（`python query.py --json`，Python + FTS5） | 空（不注册） |

封存模块的解析顺序：显式路径 → 包名 `import` → 用 `$DSH_HOME/profiles/*/node_modules` 解析包名 → 都失败就跳过并在结果里写「封存源不可用」。**没有**写死的同级目录回落。

单个源抛错只写 note，不拖累其余源。结果里 `sources` 给各源命中数，`active` 给本轮真正启用的源 id。

## 完整配置表

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `soulPath` | `<插件目录>/soul.md` | 人格文件（只读；只有 `soul_persist` 追加第四节） |
| `notesDir` | `<stateDir>/notes` | 笔记根目录 |
| `stateDir` | `<插件目录>/.state` | 运行态目录（日志、cue 状态、`soul-memory.db`） |
| `logPath` | `<stateDir>/soul.log` | 只追加的 UTF-8 日志 |
| `relationsDir` | `<stateDir>/relations` | 关系层 `*.md`（按文件名倒序取最新一份） |
| `moodPath` | `<stateDir>/mood.md` | 情绪状态 |
| `routerPath` | 空 | 路由层：一行一条「触发 → 去哪」 |
| `archiveRoot` | `<stateDir>/archive` | 封存根目录（给 sealed 模块校验 manifest 路径） |
| `memoryBackend` | `builtin` | 见上 |
| `memoryDbPath` | `<stateDir>/soul-memory.db`（meow 时 `<stateDir>/memory.db`） | 记忆库路径 |
| `sealedSegmentsModule` | 空 | 封存模块（路径或包名） |
| `sealedModule` | 空 | 旧名，仍兼容 |
| `soulIndexDir` | 空 | 原文库目录（含 `query.py`） |
| `soulIndexPython` | `python` | 跑 `query.py` 的解释器 |
| `soulMaxTokens` | 220（可调到 1000；硬上限 1100） | 魂引 token 上限 |
| `totalMaxTokens` | 950 | 四类注入合计上限 |
| `fixedMaxTokens` | 2500 | 快照超这个值才在末行申报 |
| `enforceBudget` | `false` | true 才真把目录型注入从本轮剔掉 |
| `pendingLimit` | 3 | 「现在在哪 → 手头未结」条数 |
| `pendingMode` | `count` | 未结只报条数；`full` 为旧行为 |
| `recallLimit` | 3 | `soul_recall` 默认条数（上限 5） |
| `gamedevSkillsDir` | `<工作区>/skills/gamedev` | 可选游戏开发技能库（只读 `INDEX.json`） |
| `biliDbPath` | 环境变量 `BILI_SESSIONS_DIR` 或 XDG 路径 | `soul_toolout` 的目标库 |
| `pluginRoots` | 工作区 `plugins` + profile `node_modules` | `soul_capabilities` 扫插件用 |

`<插件目录>` 由 `import.meta.url` 推出，不用 `process.cwd()`。

## 工具

| 工具 | 作用 |
|---|---|
| `soul_recall` | 四源检索，≤1200 字，带定位 |
| `soul_persist` | 把 corrected lesson 追加到 `soul.md` 的「反哺记录」；默认 preview |
| `soul_tier` | 常驻名单审计（preview 只读；apply 仅 meow） |
| `soul_cue` | cue 刷新（仅 meow） |
| `soul_toolout` | 工具输出归档（只归档不删；需 `biliDbPath`） |
| `soul_capabilities` | 能力清单 / 按需建议；可选 `source:'gamedev'` |
| `soul_surface` | 把旧注入从模型视图里遮掉（走会话 API） |
| `soul_relations` | 读关系层 |
| `soul_mood` | 读情绪状态 |

注入消息的 `source.kind` 固定是 `soul`，历史识别依赖它。

## 分区与标签（zone / tags）

魂引不展开记忆正文：它只渲染一行计数 + 指路，正文留在 `memory/<zone>.md` 里按需查。

```
<soulRoot>/soul.md          人格层
<soulRoot>/memory/work.md   一区一个文件（work / intimacy / relations / rules / misc）
<soulRoot>/index.jsonl      一行一区（不是一条记忆一行）
```

- **魂引**：`【分区】work 42 · intimacy 8 · relations 3 · rules 12 · misc 5` + 一行命令示例；full 与 reload 档都一样，不出现任何区正文。
- **条数**：每次现扫 `memory/*.md` 算，手改文件后不用重建索引也不会报错数；`index.jsonl` 只定顺序与标题。
- **条目格式**：`## 标题` + 空一行 + `tags: 场景, 类型` + 正文。标签只有两个维度：场景（工作/亲密/群聊/日常）、类型（规则/事实/偏好/教训），每条最多三个，区名不写进 tags。
- **检索**：`soul_recall({zone:"work", tags:["工作","工具"]})` 先按区与标签过滤再打分，返回项带 `zone` 与 `tags`。
- **迁移**：`node scripts/migrate-zones.mjs --db <memory.db> --root <soulRoot>`（只追加、按 id 去重；映射不确定的一律进 `misc.md`；结尾会报各区文件大小）。
- **什么时候拆子区**：不看条数，看可测判据——单文件 > 1 MB，或 `soul_recall({zone:"work"})` 实测 > 500 ms。没到线就别拆（拆了会让索引从一行变四行）。
## 权限边界

装之前先看清这三条，它们都是**默认就会发生**的：

| 能力 | 默认行为 | 边界 |
|---|---|---|
| 注入 | 每轮往上下文里放一段 ≤ `soulMaxTokens` 的魂引 | 只读 `soul.md`，不改它；认不出的内容不注入 |
| `soul_persist` | **会写 `soul.md`**：把 corrected lesson 追加到「## 反哺记录」一节 | 只追加、不重写前三节；默认 `preview`，落盘前先备份 |
| `soul_surface` | **能折叠会话历史**：把旧注入从模型视图里遮掉（surface replace，只遮不删，日志原文一条不动） | 需要宿主提供会话对象；拿不到就报错，不直接改 `.zstd` |
| 记忆库 | 默认后端是 `builtin`：自带 SQLite，落在 `<stateDir>/soul-memory.db`，首次读取自动建库 | 不联网、不外发；`memoryBackend: "none"` 可整个关掉 |

其余工具（`soul_tier` / `soul_cue` / `soul_toolout`）都是显式 preview 优先，apply 需要 `confirm: true`。

## 已知限制

- 只读 `soul.md`，唯一写入通道是 `soul_persist`（只追加「## 反哺记录」一节，落盘前备份）。
- 不引任何 npm 依赖；SQLite 用 Node 自带 `node:sqlite`。
- `soul_tier --apply`、`soul_cue` 依赖 meow 的表结构。
- `soul_surface` 需要宿主提供会话对象；拿不到就明说，不直接改 `.zstd`。
- `soul_toolout` 依赖外部 billion-context 库存在，否则返回「库不存在」。

## 自测

`check.mjs`、`clean-install.mjs`、`gamedev-golden.json` 是开发期测试物，不进 npm 包（见 `files` 白名单）。源码目录里直接跑：

```bash
node check.mjs          # 单元/集成：期望最后一行 63/63 通过（含 11 条 O* 观测断言）
node clean-install.mjs  # 干净安装：临时目录 + 默认配置 + 假 harness，期望最后一行 R1..R8 OK
```

`clean-install.mjs` 不读、不写本机任何真实目录（`DSH_HOME` 也临时指到空目录），跑完自删。

## 变更记录

见 `CHANGELOG.md`。

### 降档顺序（2026-11-03 定）

预算不够时按这个顺序让位，**任何档位三节都至少留 1 条**——缺一节就不是完整的我，这条比省 token 优先：

1. 先砍【路由】【怎么查】和「我记得」；
2. 再削每节条数（5 → 3 → 2 → 1，每节下限 1）；
3. 最后才 clip 单条字数（48 → 32 → 20 → 12 字）。

真到物理上装不下的极端预算（如 40 tok），会硬裁并在末行写「（魂引超限，已截断；核心已压到极限）」，不静默降级。
