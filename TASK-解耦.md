# 交办单 · dsh-soulweave 解耦（结构层）

> 交办：小汐（主会话）· 2026-11-19
> 接办：小小汐
> 起点目录：`<workspace>\lanxi\tmp\soulweave-next`（**已经是一份能跑通的副本，97/97 全绿**）

## 0 先读这一段，能省你两小时

- **绝对不要动** `<workspace>\plugins\dsh-soulweave` —— 那是 DSH 正在加载的插件。所有改动只在 `lanxi\tmp\soulweave-next` 里做。
- 起点已经是改过的：`core/`、`memory/`、`adapters/dsh/` 三个目录已建好，`cue/zones/tier/surface/capabilities/gamedev/toolout/soul_lint` 已搬进 `core/`，`memory-builtin/hybrid` 已搬进 `memory/`，`panel.js` 已搬进 `adapters/dsh/`，`panel-client.js` **必须留在包根**（宿主断言 R8 卡这个）。
- `index.js` 的 import 路径和 `check.mjs` 的 import 路径都已经改好了，**别再改它们**。
- 跑一次确认起点：`node check.mjs` → 必须 `97/97 通过`。

## 1 目标结构

```
soulweave-next/
  package.json      exports: "."  "./core"  "./memory"  "./client"
  index.js          ← 最后只剩：re-export core + apply（薄壳）
  core/             ← 零宿主依赖，只许 import node:* 和同目录相对路径
  memory/           ← 零宿主依赖，给别人的 app 直接用
  adapters/dsh/     ← pre-step 钩子、panel、apply
  tools/check-layers.mjs   ← 新增：依赖方向检查
  examples/node-cli.mjs    ← 新增：不装 DSH 也能跑的证明
```

## 2 刀口（按这个顺序，一次只搬一块）

`index.js` 现在 4027 行。每个函数定义行号都列在下面，**只搬函数体，不改一行逻辑**。

| # | 新文件 | 从左列行号区间的这些函数 |
|---|---|---|
| 1 | `core/text.mjs` | asText(159) asInt(163) estimateTokens(170) clip(177) dsHome(184) sha(272) appendLog(1612) logLine(1622) tableColumns(1630) |
| 2 | `core/config.mjs` | readRelations(208) readMood(240) profilePatchPaths(256) normalizeConfig(284) readRouterLines(505) |
| 3 | `core/soul.mjs` | parseSoul(523) readSoul(557) readSoulSources(574) bulletsOf(598) weekdayOf(603) stampOf(611) decideReload(659) composeSoul(671) renderSoulStableBody(881) composeSoulStable(913) composeSoulState(966) planSoulSplit(1036) |
| 4 | `core/recall-state.mjs` | pickRecallEntry(1073) renderRecall(1087) resetRecallCooldownOnReload(1092) planStateEmit(1109) |
| 5 | `core/budget.mjs` | classOfKind(1127) measureInjections(1135) snapshotMetaOf(1166) soulTargetIndex(1187) isSnapshotMessage(1200) isConversationMessage(1208) measureRequestBudget(1223) eventsOfSession(1241) countSnapshots(1251) planSnapshotPrune(1270) detectSnapshotDrift(1302) isDreamTurn(1320) wordsOfKeywords(1331) planBudget(1575) applyBudgetPlan(1598) |
| 6 | `core/probe.mjs` | pickProbeWords(1355) runProbes(1407) probeStatePath(1420) readProbeState(1424) writeProbeState(1435) maybeRunProbe(1450) tierStatePath(1494) maybeLogTier(1498) textOfMessage(1525) rememberUserTexts(1543) recentUserQuery(1552) lastUserTexts(1557) |
| 7 | `core/store.mjs` | countSnapshotEntries(1642) countResidentEntries(1657) loadPendingItems(1689) loadMemoryHeads(1721) loadLessonHead(1781) detectPinnedAnomalies(1816) countPinnedEntries(1844) countSoulNodes(1874) loadCorrectedLessons(1888) createSoulMessage(1916) resolveWorkspace(1935) zoneRowsOf(1966) |
| 8 | `core/triggers.mjs` | loadTriggers(1993) selectTriggers(2025) pickTriggerText(2062) resetTriggerCooldownOnReload(2076) |
| 9 | `core/search.mjs` | wordsOf(2547) hitAll(2551) snippetAround(2556) createMeowBackend(2573) createBuiltinBackend(2591) createNoneBackend(2608) createMemoryBackend(2624) searchMemory(2632) searchMemoryMeow(2637) scoreOf(2697) searchMemoryByCue(2712) packageRequireBases(2802) resolveSealedModule(2814) createArchiveSearch(2842) walkMarkdown(2881) readRulesIndex(2913) searchRules(2967) searchNotes(2998) searchIndexSource(3027) createRecallSources(3071) createRecall(3142) |
| 10 | `core/tools.mjs` | createPersist(3235) createTier(3340) createCapabilities(3435) createTools(3674) |
| 11 | `adapters/dsh/prestep.mjs` | createPreStepHandler(2080–2546，**最大的一块，最后做**） |
| 12 | `adapters/dsh/apply.mjs` | createSoulIndexSyncTrigger(3917) apply(3947) |

### 每块的操作顺序（照做，别跳）

1. 把函数**原样剪**到新文件（连注释一起）
2. 在新文件顶部补 `import`（它用到谁就 import 谁，从 `core/text.mjs` 这些新模块里取）
3. 在 `index.js` 顶部加 `export * from './core/xxx.mjs'`
4. `index.js` 里如果还有函数调用被搬走的，改成从新文件 import
5. **跑 `node check.mjs`，必须 97/97**
6. `git add -A; git commit -m "refactor: 搬 xxx 到 core/xxx.mjs"`

**一次只搬一块。** 搬两块再跑测试，出错时你不知道是哪块坏的。

## 3 新增两个文件

### `tools/check-layers.mjs`

扫 `core/` 和 `memory/` 下所有 `.mjs`，逐行匹配 `^import` / `^export .* from`：

- 允许：`node:*`、`./xxx.mjs`（同目录）
- 禁止：含 `dsh`、`cordis`、`@deepseek`、`adapters` 的路径
- 违反就打印 `文件:行号  违规 import` 并 `process.exit(1)`

在 `package.json` 加 `"scripts": { "check": "node check.mjs && node tools/check-layers.mjs" }`。

### `examples/node-cli.mjs`

不启动 DSH，只 import `../memory/index.mjs`：

```js
import { putMemory, search } from '../memory/index.mjs'
// 建临时库 → put 两条 → search 一条 → 打印结果
```

必须能 `node examples/node-cli.mjs` 直接跑通，输出里能看到命中的那条。

## 4 验收（全过才算完）

1. `node check.mjs` → `97/97 通过`
2. `node tools/check-layers.mjs` → exit 0，无输出
3. `node examples/node-cli.mjs` → 打印命中结果
4. 三个入口都能加载：
   ```powershell
   node -e "import('./core/index.mjs').then(m=>console.log('core',Object.keys(m).length))"
   node -e "import('./memory/index.mjs').then(m=>console.log('memory',Object.keys(m).length))"
   node -e "import('./index.js').then(m=>console.log('plugin',Object.keys(m).length))"
   ```
   三个都打印，数字不为 0
5. `index.js` 行数 < 400（现在 4027）
6. `node -e "import('./index.js')"` 导出的名字**覆盖**改动前的集合：先用起点副本跑一次存下 `Object.keys`，改完对比，缺一个都不行

## 5 不要做

- 不改任何函数逻辑、不改导出名、不"顺手优化"
- 不改 `check.mjs` 里已有的断言（可以新增用例）
- 不引入任何第三方依赖
- 不拆 `panel.js` / `panel-client.js`
- 不把 `panel-client.js` 移出包根
- 不动 `cordis.patch.yml`
- 不碰 `<workspace>\plugins\dsh-soulweave`

## 6 已知的坑

- **PowerShell 5.1 没有 `-Encoding utf8NoBOM`**。写文件一律用：
  `[IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`
- `check.mjs` 会跑 4–5 秒，别以为是卡死
- 这块代码有大量中文注释，`Select-String` 读中文没问题，但 `Set-Content` 会写成 GBK，别用
- `normalizeConfig` 被几乎所有函数调用，它搬走以后 `index.js` 里剩下的函数必须 `import { normalizeConfig }`，漏一个就会 `ReferenceError`

## 7 交付

- 追加一节到 `REPORT.md`（**追加，不重写**）：每块搬了什么、check 通过记录、验收 6 条的实际输出
- `package.json` 版本 → `0.4.0`
- 回一句：**「解耦完成，97/97，check-layers 通过，examples 跑通，index.js 现在 N 行」**
- 如果某块搬不动（循环依赖之类），**停下来写清是哪两个函数互相依赖**，不要硬拆
## 进度 2026-11-19 19:44（小汐自己做，第一阶段完成）

index.js：4028 行 → **1936 行**。每一块搬完都跑一次 check.mjs，**97/97 全绿**保持至今。

| 块 | 文件 | 内容 |
|---|---|---|
| 1 | core/text.mjs | asText / asInt / estimateTokens / clip / dsHome / sha256 / appendLog / logLine / tableColumns / CJK / PLUGIN_DIR |
| — | core/constants.mjs | 单子里没列、但必须抽：MESSAGE_KIND、SOUL_SECTIONS、各 token 常量、MEMORY_SECTION、ROUTER_SAFETY、SOUL_SECTION_CAP、ALIAS_TO_STANDARD、HINTS |
| 2 | core/config.mjs | readRelations / readMood / profilePatchPaths / normalizeConfig / readRouterLines |
| 3 | core/soul.mjs | parseSoul / readSoul / readSoulSources / composeSoul / composeSoulStable / composeSoulState / planSoulSplit / decideReload / SOUL_STAGES |
| 4 | core/recall-state.mjs | pickRecallEntry / renderRecall / resetRecallCooldownOnReload / planStateEmit + 四个 kind 常量 |
| 5 | core/budget.mjs | classOfKind / measureInjections / measureRequestBudget / 快照漂移 / planBudget / applyBudgetPlan / 记忆库读取（pending/heads/lessons/pinned） |
| 6 | core/probe.mjs | DREAM_MARKER / isDreamTurn / pickProbeWords / runProbes / 探针 state / maybeRunProbe |
| 10（提前） | core/search.mjs | 三个 memory backend / searchMemory / searchMemoryByCue / cue 检索 —— 提前是因为 probe 要 searchMemory，不搬就循环 |

新增守卫与证明：

- `tools/check-layers.mjs`：扫 core/ + memory/ 的 import，非 `node:*`、非相对即 fail；memory 反向依赖 core 也 fail。当前 **20 个文件全过**。
- `examples/node-cli.mjs`：不装 DSH、不碰 ctx，`ensureDb/putMemory/search` + `parseSoul` + `estimateTokens` 跑通。
- package.json → 0.4.0，scripts 加 `check-layers` / `example`。

### 还剩（下一阶段）

1. `core/prompt.mjs`：createSoulMessage / resolveWorkspace / zoneRowsOf（54–143）
2. `core/triggers.mjs`：loadTriggers / selectTriggers / pickTriggerText / resetTriggerCooldownOnReload（145–240）
3. `core/recall.mjs`：archive/rules/notes/indexSource + createRecallSources / createRecall / createPersist（705–1187）
4. `adapters/dsh/prestep.mjs`：createPreStepHandler（242–704，宿主层，允许 ctx）
5. `adapters/dsh/apply.mjs`：九个 TOOL 定义 + createTools + createSoulIndexSyncTrigger + apply（1188–末尾）

搬完 4、5 之后 index.js 应该只剩 re-export + apply 薄壳。

## 进度 2026-11-19 19:51（第二阶段完成：index.js 4028 → 56 行）

| 块 | 文件 | 内容 |
|---|---|---|
| 9 | core/prompt.mjs | createSoulMessage / resolveWorkspace / zoneRowsOf |
| 10 | core/triggers.mjs | loadTriggers / selectTriggers / pickTriggerText / resetTriggerCooldownOnReload |
| 11 | core/recall.mjs | packageRequireBases / resolveSealedModule / createArchiveSearch / walkMarkdown / readRulesIndex / searchRules / searchNotes / searchIndexSource / createRecallSources / createRecall / createPersist |
| 12 | adapters/dsh/prestep.mjs | createPreStepHandler（宿主层，允许 ctx） |
| 13 | adapters/dsh/apply.mjs | 8 个 TOOL 常量 + createTier / createCapabilities / createTools / createSoulIndexSyncTrigger / apply |

新增：

- `core/hybrid.mjs`：hybrid 重排下沉到 core（core/recall 需要它，而 memory 不得反向依赖 core），`memory/hybrid.mjs` 暂时保留同哈希副本（分层规则与公共入口的折中，待定）。
- `index.js` 只剩装配与公共导出；顶部残留的未使用 import 已清掉。
- `tools/check-layers.mjs` 现在扫 24 个文件，全过。

验证（全部实跑）：

- `node check.mjs` → 97/97 通过；O* 11/11 通过
- `node tools/check-layers.mjs` → PASS 依赖方向：24 个文件，core/memory 全部零宿主依赖
- `node examples/node-cli.mjs` → exit 0

### 还剩（下一阶段）

1. README 补结构说明（core / memory / adapters/dsh 三层 + 单包多入口）
2. REPORT.md 追加验收节（只追加不重写）
3. hybrid 双份定夺：要么删 memory/hybrid.mjs 并调整 memory/index.mjs，要么在 check-layers 里给它开白名单
4. 交给伊纳跑 apply，落到 `<workspace>\plugins\dsh-soulweave`


## 进度 2026-11-19 19:56（收尾三项完成）

| 项 | 结果 |
|---|---|
| README 结构说明 | 新增「## 包结构」：目录树、四入口表、三条分层规则、验证命令 |
| hybrid 双份定夺 | 保留同哈希副本（`./memory` 子入口不反向依赖 core）；`tools/check-layers.mjs` 增加 SHA-256 一致性守卫 |
| 守卫反证 | 临时篡改 `memory/hybrid.mjs` → FAIL exit 1，报「core/hybrid.mjs 与 memory/hybrid.mjs 哈希不一致」；还原后 PASS exit 0，两份均为 `727316C1…` |

验证（2026-11-19 19:56）：

- `node tools/check-layers.mjs` → PASS 依赖方向：24 个文件，core/memory 全部零宿主依赖
- `node check.mjs` → 97/97 + O* 11/11
- `node examples/node-cli.mjs` → exit 0

剩余：交给伊纳跑 apply，落到 `<workspace>\plugins\dsh-soulweave`。副本在 `lanxi\tmp\soulweave-next`，正在加载的插件一个字节没碰。

## 进度 2026-11-19 19:57（打包验收：又抓到两处漏网）

1. `panel-client.js` 不在 `files` 白名单 → `npm pack --dry-run` 里根本没有它，`exports["./client"]` 发布后必然解析失败。已补进 `files`。
2. `clean-install.mjs` 仍 import 旧路径 `memory-builtin.mjs` → `ERR_MODULE_NOT_FOUND`。已改 `memory/builtin.mjs`，R1..R8 全过。
3. 清掉 10 个 0B 的 `.dsh-ops-update-*.lock`（工具临时锁，被 npm 打进包），新增 `.npmignore` 排除。
4. `CHANGELOG.md` 补 0.4.0 解耦条目。

最终验证（2026-11-19 19:57）：

- `node tools/check-layers.mjs` → PASS，24 文件
- `node check.mjs` → 97/97 + O* 11/11
- `node examples/node-cli.mjs` → exit 0
- `node clean-install.mjs` → R1..R8 OK
- `npm pack --dry-run` → `panel-client.js` 在包内，lock 文件 0 个

交付命令（由伊纳执行，覆盖到正在加载的插件目录；不用 `/MIR`，保留目标里多出来的文件）：

```powershell
Copy-Item '<workspace>\lanxi\tmp\soulweave-next\*' '<workspace>\plugins\dsh-soulweave' -Recurse -Force
```