# Soulweave V2 落地对照（截至 0.12.5 / 2026-11-26）

> 对照 `ROADMAP-V2.md`（2026-11-25 设计原稿，保留原文不改）。
> 原稿回答「要做什么」，本文回答「实际做了什么、差在哪、为什么」。

## 一句话

**图谱那一半已经落地并在跑；势能那一半写完了，但没接线。**

## 对照表

### 一、数据结构与基建

| 原稿 | 实际 | 位置 | 状态 |
|---|---|---|---|
| `memory_links(source_id, target_id, relation_type)` | `memory_edge(a, b, relation, weight, hits, bad)` | `core/tree/schema.mjs` | ✅ 落地，字段名与语义都改了 |
| 「不存静态权重」 | 实际存 `weight / hits / bad`，建边时写、命中时记 | 同上 + `tools/build-graph.mjs` | ⚠ 设计意图已改：不再是纯拓扑 |
| `memory_metadata` 隐形侧写 | 未建表；由 `memories.level / project / keywords` + `scene` 承担 | — | ❌ 未落地（暂时够用） |
| 日记索引化 / 懒加载 | 未做；日记仍在 lanxi vault，未进 `soul-memory.db` | — | ❌ 未做 |

### 二、动态情境势能（Context Momentum）

| 原稿 | 实际 | 位置 | 状态 |
|---|---|---|---|
| 软区间 0.20 ~ 0.80 | `MOMENTUM_MIN / MOMENTUM_MAX` | `memory/momentum.mjs` | ✅（0.12.3 放宽） |
| 工作判定 +0.08（60s 内工具 >30s 且 ≥2 次） | `WORK_RAISE` / `WORK_MS` / `WORK_COUNT` | 同上 | ✅ |
| 亲密判定 -0.15 | `INTIMACY_DROP` | 同上 | ✅ |
| 覆写回拉（suppressed） | `nextMomentum` 的 heavy 分支 | 同上 | ✅ |
| 软边界回弹每轮 0.02 | `MOMENTUM_BOUNCE` / `bounce()` | 同上 | ✅ |
| 压缩重置 | `MOMENTUM_RESET_MIN / _MAX` + `input.compacted`：>0.6 压回 0.6，<0.4 抬回 0.4，中间保持 | 同上 | ✅ 状态机支持（0.12.3 改） |
| **接进生产** | **零消费方**——只有 `check.mjs` 测它，`prestep` / `ppr` 都没 import | — | ❌ **未接线** |

> 这不是没做，是做好了没通电。`momentum.mjs` 是完整的纯状态机 + JSON 持久化壳；
> 缺的是三个动作：`tool/call` 喂 `observe`、`compaction/end` 喂 `compacted`、`assocByPPR` 把 `value` 当 `alpha` 传进去。

### 三、第六路召回（PPR）

| 原稿 | 实际 | 位置 | 状态 |
|---|---|---|---|
| PPR 纯 JS 迭代，最多 2 跳 | `personalizedPageRank`，BFS hops > 2 权重归零 | `memory/ppr.mjs` | ✅ |
| 阻尼 α 映射当前势能 | `alpha` 参数存在，但调用方不传，恒为 `PPR_DEFAULT_ALPHA` | `memory/assoc.mjs` | ❌ 未接 |
| 第六路权重压低、并入 RRF（约 0.15） | 未做 RRF；第六路是**独立一条 `soul-assoc` 消息**，每轮至多 1 条 | `adapters/dsh/prestep.mjs` | ⚠ 形态不同，语义达成 |

### 四、黄金测试集

| 原稿 | 实际 | 状态 |
|---|---|---|
| 600 条记忆 + 几十篇日记跑扩散 | `check.mjs` 130 项是单元/集成测试，不含真实语料评测 | ❌ 未做 |

### 五、中长期防坑（6000+）

| 原稿 | 实际 | 位置 | 状态 |
|---|---|---|---|
| 枢纽惩罚（除以度数） | `deg > P95 → 1/log(deg)` | `memory/ppr.mjs` | ✅ |
| 清理弱边（weight < 0.1） | 无自动清理；只有人工 `bad` 标记 | — | ❌ 未做 |
| 死守 2 跳 | BFS 硬切 | `memory/ppr.mjs` | ✅ |

## 偏差记录（为什么和原稿不一样）

1. **表名 → `memory_edge`**：实际表字段 `a/b/relation` 是建表时定的，早于原稿收录。改名成本高于收益。
2. **权重从「纯拓扑」变成「有状态」**：`hits/bad` 是为了「这条联想被用过几次、被否过几次」，PPR 需要它做边的可信度。
3. **第六路不进 RRF**：魂织的召回是「多路各吐一条消息」而不是「分数融合排序」。硬套 RRF 会改动整个注入协议，收益不明确，先按独立消息跑。
4. **没有 `memory_metadata`**：`level/project/keywords` 加上 `scene` 已经能表达"这条记忆属于哪种情境"，单独建表是在没有第二个消费方的时候先造结构。

## 下一刀切哪里（按依赖排序）

1. **momentum 接线**（最小、最值）：`prestep` 每轮 `store.observe(sid, …)`；`ppr` 调用处传 `alpha: momentum.value`；`compaction` 事件喂 `compacted: true`。改完后第六路的发散程度会随工作/亲密态变化。
2. **黄金测试集**：有了真实语料才谈得上调 α。先用现有 716 条记忆 + 已入库的 summary 跑固定查询集，记录命中率。
3. **日记挂载 / Super-Node**：等前两项稳定。
4. **弱边清理**：只在 `compaction` 时做，且先 dry-run 记录数量。

---

## 1.0 待办（2026-11-26 记，以后做）

**包名去 `dsh-` 前缀**：`@ly-ina/dsh-soulweave` → `@ly-ina/soulweave`。
理由：`./sdk` 已经宿主无关，前缀把「不只是 DSH 插件」说小了；1.0 是 breaking 窗口，和其它 breaking 一起做。
配套三件，缺一不可：

1. **过渡包**：`@ly-ina/dsh-soulweave` 留成空壳，re-export 新包并标 deprecated，至少留一个大版本。
2. **`install.mjs` 自动迁移**：识别 profile 里的旧依赖名 / 旧 junction，改写成新名并清掉旧的；
   否则会同时挂两个包，`bundles` 里还留着旧 id。
3. **目录一起改**：`~/.dsh/plugins/dsh-soulweave` → `~/.dsh/plugins/soulweave`；
   README 的 clone 路径、升级命令、HMR 监听路径同步更新。

顺手把 1.0 原本那一刀一起落：根入口只留 `./sdk` 与插件入口，内部面收干净。

---

维护约定：每次发布前对照本表检查一次；已完成的条目改成 ✅ 并补 `CHANGELOG` 版本号，不要删行。
