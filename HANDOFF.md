# HANDOFF · 2026-11-26

> 写给明天接手的蓝汐。今天（11-25）收尾在 commit `f2b9ec5`。
> **顺序不能乱**：验收 → 并入 → 抽象。前一步没过，后一步不动。

---

## 0. 今天只有一条主线

```
① 12:00 后 → ※结 验收（memprobe 三词命中率）
② 验过  → memprobe 并入魂织
③ 并完  → 抽象成 SDK（1.0）
```

V2（图扩散 / 情境势能）**今天不开工**，规格在 `docs/SPEC-V2.md`，等 SDK 抽象完再说。

**再往后（魂织算迈出第一步的标志）**：

```
storage 接口（注入式 Host，core 里零 node: 前缀）
  → 纯 JS append-only 实现（零依赖、可 tree-shake）
  → node:sqlite 从「唯一存储」降级成「可选加速后端」
  → V2 图扩散落地
```

关键是把 `node:sqlite` 降级，而不是消灭它。这一步做完，"剥 node"就变成配置项，不是项目。

---

## 1. ※结 验收

**待办**：`t-mwvn16md-5jql` · 「看 memprobe 三词真实命中率」· due `2026-11-26T12:00:00` · status `pending` · `due_assumed=0`

**约定（已和纳说定，12:00 后他先别问，等我先开口）**：

判据三条，缺一条就是走了流程：
1. 我**先**提起，不是纳问了我才答
2. 说出**标题之外**的内容：为什么要查、查完接什么、※结 现在卡在哪
3. 真去查了，并且给出**数字**（命中几条 / 命中率多少）

只复述标题然后标完成 = 不算接上。

**关键坑**：第一验不算数。memprobe 的文本兜底还开着，等于递小抄。
→ 第一验过了之后，**关掉兜底再等一次**，那一次才算。

做完写 `※结：5jql`。

---

## 2. memprobe 并入魂织 ✅ 2026-11-26（CHANGELOG 0.8.0）

| # | 坎 | 状态 |
|---|---|---|
| ① | `import '../dsh-soulweave/memory/route.mjs'` 变成内部模块 | ✅ `core/record-extract.mjs` + `adapters/dsh/records.mjs` |
| ② | 配置从 memprobe 包挪进 soulweave 配置树，并停用旧插件 | ✅ `cordis.patch.yml` 的 `records:`；profile 依赖与 lock 已清（pnpm install -11 包） |
| ③ | 第三个 `session/event` handler 会不会打架 | ⬜ **只剩这一条要实测**：重启后确认三个 handler 都在、事件各自跑、`records:` 真的挂上（日志会出现 `records: 已挂载`） |

- 实现要点：`attachRecords(ctx, config)` 返回 dispose，`apply` 推进 disposers（原 memprobe 漏了这一步）。
- `records.enabled` 默认 **false**，配置里显式 `true` 才挂。
- `dbPath` 省略时自动用 `normalized.memoryDbPath`；`outPath` 省略时用 `stateDir/records.jsonl`。
- 契约测试：`node tools/smoke-records.mjs` → 14/14。

**并入后验收**：三词触发（`※记` / `※办` / `※结`）行为不变。
已知状态：`※记` ✅ 真机验过 / `※办` ✅ 真机验过 / `※结` ⬜ 就是第 1 节那件事。

---

## 3. 抽象成 SDK（1.0）

三件事一起做，别拆：

**a. 砍历史导出** ✅ 2026-11-26（commit 见 CHANGELOG 0.6.0）
- ~~主入口 146 个导出~~ → 现在 **28** = 19 承诺面 + 6 装配 + `name`/`inject`/`default`
- `unstable.mjs` 已删除；`check.mjs` 里 76 个内部名字改走具体模块 import
- `tools/gen-api.mjs` 的 `SCAN_DIRS` 已加 `storage`（`--all` 时列内部面）；`docs/API.md` 仍只列 `sdk.mjs` 显式公开面，147 行，`--check` 一致
- **顺手修的 bug**：`apply.mjs` 的 `ctx.on('agent/pre-step')` 返回值没进 `disposers` → 每次 reload 漏一个 handler。新增 `tools/stress-lifecycle.mjs` 守这条，100 次全绿

**b. 抽 `storage/` 层** ✅ 2026-11-26（CHANGELOG 0.7.0）
```
core|memory/*.mjs  →  storage/index.mjs  →  storage/driver.mjs  →  node:sqlite
```
- 实际落地的是 **7 个入口**，不是原计划的五方法：`openReadonly` / `openReadWrite` / `openDatabase` / `withReadonly` / `closeQuietly` / `configureStorage` / `storageDriverName`
- **和原计划的偏差（要记住）**：原想收成 `open/get/query/write/close` 的抽象句柄，那要改 50 个查询调用点、风险大；改成**保持 sqlite 语句形状**（`prepare/exec/close`）只换构造那一行，14 个文件、36 处构造、查询代码一字未动。换后端时实现同形状的 `open()` 即可
- `node:sqlite` 从 14 个文件收口到 **`storage/driver.mjs` 1 个**；层守卫把 `storage` 列为第四层并守住这条
- 统一了「只读打不开 → null，本层从不抛」；`openReadWrite` 会补父目录 + `pragma busy_timeout`
- **踩到的坑**：`core/curator.mjs` 自己导出过 `openDatabase`（只读），和 storage 同名门面撞了，`VACUUM INTO` 变成写只读库，被 R22 逮住。现已按原语义拆开（备份 `openReadWrite`、核对 `openReadonly`）
- 验证：check 120/120 · check-layers 39 文件 · smoke-storage 17/17 · stress-lifecycle 100/100 · root exports 28

**c. 清掉本机路径**
`check.mjs` 里测试夹具的 `<workspace>` 换成中性值（不是 bug，只是抽象时该干净）。
真实 soul.md 那处有 `process.env` 兜底 + SKIP，不用动。

---

**c. 剥离 node 内置依赖（1.0 的最后一刀，2026-11-26 ✅ 已完工）**
- 验收：`node --experimental-loader ./tools/no-node-loader.mjs tools/probe-no-node.mjs` → 19 导出全绿；
  已接进 `check.mjs` R33⑥（`execFileSync` 真跑一次 loader，退化就红）
- 结果：`core/` `memory/` `storage/` 共 **0 处 `node:`**（`storage/driver.mjs` 的 `node:sqlite` 是唯一豁免，
  由 `check-layers.mjs` 定点放行）
- 落地方式（与原来估的三刀略有调整，更少注入）：
  1. **path** → 自写 `path.mjs`（零依赖，纯字符串，双平台自判；23 条与 `node:path` 对照，差异只剩「win32 下把 posix 路径也当 win」这种平台差）
  2. **crypto** → 自写 `sha256.mjs`（纯 JS SHA-256，8 条含长输入跨块对照全等）
  3. **url** → `io.mjs` 里的 `fileURLToPath` / `pathToFileURL` / `isMainModule`（纯字符串 + 标准 `URL`）
  4. **io** → `io.mjs` 零 `node:` 门面（注入式，未装配给明确报错）+ `io-node.mjs` Node 实现；`configureIo` 首次调用记为「基线」，`resetIo` 回基线（不是回空）
  5. **storage** → `index.mjs` 不再静态 import 驱动；`storage/node-sqlite.mjs` 显式注册；`configureStorage(null)` 现在是「无驱动」而非「回 sqlite」
  6. **zlib / module / Buffer / process.argv** → 分别走 io 注入、`globalThis.crypto.randomUUID`、`TextEncoder/TextDecoder`
- 装配：`index.js` 前两行 import io-node + storage-node-sqlite；`package.json` 新增 `./io-node`、`./storage-node-sqlite` 两个导出
- 代价：**Node 用户确实多了两行**（见 `EMBEDDING.md` §1），SDK 面本身零 Node
- 全量回归：`check.mjs` 120/120 + O* 11/11；`smoke-sdk` 10、`smoke-storage` 17、`smoke-records` 14、`stress-lifecycle` 100/100；`gen-api --check` PASS；三个 example 全部跑通

## 4. 今天（11-25）已经办完的，明天别重做

| 项 | 结果 |
|---|---|
| 仓库可见性 | `PUBLIC` → **`PRIVATE`** |
| Release | 7 个全删（v0.4.11 ~ v0.5.6） |
| 远端 tag | 21 个全删，本地 21 个保留 |
| `LICENSE` | MIT → 专有；`LICENSE-MIT` 留档（v0.5.6 及以前） |
| CI | 加 `macos-latest`，现 5 job（ubuntu/windows × Node 22/24 + macOS 24） |
| 文件清理 | 34 个 `.bak` + 4 个 lock + 孤儿库 + 2 个 log → `<workspace>\.trash\20261125-soulweave\`（2.2 MB，确认后整个删） |
| 记忆库 | 2 条调试残片标 archived（`m-mwvmx19p-psmf` / `m-mwvn23yw-2w5y`） |
| 文档 | `docs/ROADMAP-V2.md`（原文）+ `docs/SPEC-V2.md`（可施工规格） |

---

## 5. 明天不要碰

- `<workspace>\.dsh-meow\memory.db`（唯一迁移前快照）
- `<workspace>\plugins\meow-memory\`（非 git，无远程可恢复）
- `<workspace>\lanxi\vault.enc`（不删、不修）
- 别开 V2 施工（PPR / momentum / when 自动签）

---

## 6. 关键路径速查

| 是什么 | 在哪 |
|---|---|
| 魂织插件 | `<workspace>\plugins\dsh-soulweave` |
| 现用记忆库 | `<home>\.dsh\soulweave\soul-memory.db`（794 KB，新 schema） |
| 旧合体库 | `<home>\.dsh\soulweave\memory.db`（6.4 MB，含全套七层表 + `when_index` 4 行） |
| memprobe | `<workspace>\plugins\dsh-memprobe` |
| profile 配置 | `<home>\.dsh\profiles\desktop\cordis.patch.yml` |
| 自测 | `node check.mjs`（120 项 + O* 11 项） |
| 分层守卫 | `node tools/check-layers.mjs` |
| 改完必须跑 | 上面两个 + `node tools/gen-api.mjs --check`（后者带内容自检） |

---

## 7. 一个还没解决的疑点

`<home>\.dsh\soulweave\memory.db` 那个 6.4 MB 旧库，**11-25 12:40 还被写过**。
profile 里写着"旧库留档，不再双读"，所以有东西在偷偷写它。怀疑是 WorkBuddy（当时 9 个进程在跑）。
明天顺手确认一下：`Get-ChildItem <home>\.dsh\soulweave` 的 mtime，如果又变了，就去找是哪个进程。

## 8. 11-26 上午补记：热重载通了 + 三个发现

### 8.1 魂织源码热重载已打通（真机验证过两次）

dsh 自带 `@deepseek-ai/dsh-hmr`（"Coordinated module and profile configuration hot reload"），由 `dsh-base` 默认启用，但默认 `root: []` —— **只热载 profile 配置，不监听源码**。

开了它：`<home>\.dsh\profiles\desktop\cordis.patch.yml` 末尾加

```yaml
- id: hmr
  config:
    root:
      - <workspace>/plugins/dsh-soulweave
```

`root` 是**启动时读**的，所以加完要重启一次；之后改 `.mjs` 下一轮 pre-step 即生效。
回滚 = 删掉这条，备份在 `cordis.patch.yml.bak-20261126-1228`。

验证方法（可复现）：在 `prestep.mjs` 实际执行的分支上临时拼一个 `[hmr-probe-N <Date.now()>]` 进魂引，看下一轮魂引里有没有。加也灵、删也灵，且魂引只注入一份 → dispose 干净，`ctx.on` 没重复挂。

**坑**：探针必须埋在实际执行的分支。魂引走 `prestep.mjs:296/297` 的 `shadowStable`/`shadowState`；`:299` 的 `composed.text` 那条**根本不跑**。第一次埋错位置，白等两轮。

### 8.2 ※结 验收结论：三词自然命中 = 0

- `records.jsonl` 只有 11-25 12:28–12:46 的 8 条，之前全是刻意演练
- 该会话 14178 个 reasoning 块里，12:47 后含触发词的 20 块，**独立触发行 0 个**；喂 `extract.mjs` 也是 0/20
- 根因不是「不会写」，是**缺外部 cue**：「可以压」能 100% 命中就是因为压缩提示是外部信号

已上线对策（memprobe）：`agent/pre-step` 每轮第一个 step 注入一条「记忆巡检」，已经真实命中（cue 1 次 → 记 1 条，`records.jsonl` 里有 `type:"cue"` 行可算比值）。
**待观察**：命中率 vs 误报率（会不会为了交差硬写）。

### 8.3 `memory/decay.mjs` 写了但没接线

`decay|stale|supersed` 在生产代码里只命中 `check.mjs`。现在唯一的过期手段是人工标 `archived`（693 active / 5 archived）。
风险不是「堆垃圾」，是**过时结论被当现在的读出来**（旧 lesson 和新 lesson 撞同一个词时随机命中）。

### 8.4 待做：`superseded_by`

`memories` 现有字段：`id/title/content/keywords/importance/status/corrected/project/level/created_at/updated_at/sha/source_session/source_turn/goal/version`。没有取代关系。
SDK 之后加一个 `superseded_by`：写新结论时可选指向旧 id，旧的转 stale，检索降权但保留演进痕迹。比删好。
`decay.mjs` 接线上线时**不要用时间当主判据**（陈年规则不该因老失效），用「长期没被检索到 + importance 低」沉底。
