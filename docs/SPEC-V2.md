# Soulweave V2 可施工规格（联想与情境势能）

> 来源：`docs/ROADMAP-V2.md`（纳的原始规划）+ 2026-11-25 晚与纳的讨论定稿。
> 状态：**规格，未实现**。实现前先读 §0 的依赖顺序。

---

## 0. 依赖顺序（为什么不能先写 PPR）

```
session/event + agent/pre-step
        │
        ▼
   scene 提取器  ← 唯一前置，缺它下面全部空转
        │
   ┌────┴────┐
   ▼         ▼
自动签 when   Context Momentum
   │              │
   ▼              ▼
memory_links   PPR 阻尼 α
   │              │
   └────┬─────────┘
        ▼
     PPR 扩散
        ▼
   触发 / 排队 / 注入「想到」
        ▼
   hit / bad 反馈 → 边权 w
```

**第一批代码只写 scene 提取器**，其余按上图顺序推进。

---

## 1. scene 提取器

**位置**：`memory/scene.mjs`（新），纯函数，不碰 DB。

```js
// 输入：一次 session/event 或 pre-step 的 payload
// 输出：
{
  sessionId,        // 势能与队列都按会话隔离
  tool,             // 最近一次工具名，无则 null
  cwd,              // 工作目录
  timeWindow,       // 'morning' | 'afternoon' | 'evening' | 'night'
  intimacy,         // 0..1，亲密词命中强度
  toolMsWindow,     // 近 60s 工具累计耗时（ms）
  toolCount,        // 近 60s 工具次数
  at                // 毫秒时间戳
}
```

**数据来源已确认存在**：
- `adapters/dsh/apply.mjs:1111` / `:1149` 已挂 `session/event`
- `adapters/dsh/apply.mjs:1100` 已挂 `agent/pre-step`
- 压缩事件已在接：`compaction/end` → `handler.resetStable(sessionKey)`

**待确认（第一步就验）**：真实 `session/event` 里 tool 事件带的是单时间戳还是 `startedAt`/`endedAt` 成对。
- 若只有单时间戳 → `toolMsWindow` 用相邻事件时间差近似，标记为估算值。
- 这条不确定，规格其余部分不受影响。

---

## 2. 自动签 when

**现状（实测 2026-11-25）**：

| 库 | when_index |
|---|---|
| `<DSH_HOME>/soulweave\soul-memory.db`（魂织现用） | **表不存在** |
| `<DSH_HOME>/soulweave\memory.db`（6.4 MB 合体库） | 4 行 |
| `<workspace>/.dsh-meow/memory.db` | 4 行 |

889 条记忆、4 条签过 when。**这是 V2 的最大实际瓶颈**：不是算法没写，是原料是空的。

**做法**：
1. 迁移建表：`when_index(level, entry_id, when_ctx, updated_at, hit_count, bad_count, last_hit)`，与 `memory/when.mjs` 现有 schema 一致。
2. `soul_remember` 写入路径接 scene：自动生成 `when_ctx = { tool, pathPattern: cwd, timeWindow }`。
3. 不覆盖已有 when；只在空时补。
4. 手工覆盖入口保留（`when` 参数），自动签是兜底不是强制。

**隐私**：`pathPattern` 只存工作区相对路径或 cwd 末两级，不存完整用户目录。

---

## 3. Context Momentum（分会话）

**位置**：`memory/momentum.mjs`（新），纯状态机，无 IO。

```js
state = { value: 0.60, lastAt, toolMsAccum, intimacyCarry }
```

| 规则 | 条件 | 变化 |
|---|---|---|
| 软化区间 | 常态 | 0.50 ~ 0.85 |
| 工作拉高 | 60s 内 `toolMsWindow > 30000` 且 `toolCount >= 2` | `+0.08` |
| 亲密压低 | 60s 内无重度工作 且 `intimacy > 0` | `-0.15` |
| 覆写回拉 | 压低后立即进入重度工作 | 取消压低，回拉 |
| 软边界回弹 | 每轮 | 向区间内回归 `0.02` |
| 压缩重置 | `compaction/end` | 强制 `0.60`，清累加 |

**分会话**：`Map<sessionId, state>`，不同会话共享魂织但势能不共享。
**持久化**：`state/momentum.json`，随轮次写入；重启后按 `lastAt` 做一次回弹再继续。

---

## 4. 第六路：PPR 图扩散

**位置**：`memory/ppr.mjs`（新），纯 JS 迭代，**死守 2 跳**。

```
rank(v) = (1-α)·p(v) + α·Σ_{u→v} w(u,v)/deg(u)·rank(u)
```

- `α` 直接取当前会话的 momentum 值（0.50 发散 ↔ 0.85 保守）
- `p(v)` = 原五路召回结果的归一化分布
- 边权 `w` 初值 1，由 §6 的 hit/bad 更新
- **枢纽惩罚**：转移时分母用 `deg(u)`；节点度 > P95 时额外乘 `1/log(deg)`
- 第六路在 RRF 融合中权重 **0.15**（可实测调整）

**建边规则（不用关键词重叠）**：两条记忆的 `when_ctx` 在 `tool` / `pathPattern` / `timeWindow` 任一项相等，建 `same-scene` 边。这是纳定的「情景关联系数」，比裸关键词干净，且天然有反馈数据。

`relation_type` 取值：`same-scene` | `same-source` | `causal`（后两者留接口，第一版只实现 `same-scene`）。

---

## 5. 触发与注入

**关键区分：抵达 ≠ 触发 ≠ 注入。**

| 阶段 | 判定 | 说明 |
|---|---|---|
| 抵达 | PPR rank ≥ 阈值 | 结构上够得着 |
| 触发 | 抛骰子 | 联想的随机性，不是每次都有 |
| 注入 | 每轮最多一条 | 其余排队 |

**触发概率**：`p = 0.15 + 0.35 × rank归一`；momentum ≥ 0.75（工作态）时 `p × 0.5`。

**排队**：
- 按边权 `w` 降序排
- 每轮取队首一条注入
- **3 轮内没排到就丢弃**（宁缺毋滥，场景早变了）
- 队列持久化到 `state/momentum.json`

**注入位置**：魂引中独立一段，段名 **「想到」**（纳定，口语化、有联想语义）。与「我记得」分开，便于单独统计命中率。

**注入格式**：只注入一条，不展开成长文本；保留 id 供后续回写反馈。

---

## 6. 反馈：hit / bad → 边权

**判据（三种，第一版用中间那种）**：

1. PPR 排进前 N → 太便宜，会把"算出来没用上"记成好边，边权虚高。**不用**。
2. 进了注入即算 candidate，下一轮用关键词/摘要片段模糊匹配判断是否被引用 → 记为 hit。**第一版用这个**。
3. 语义级判断"确实用到了" → 最准但最贵。**留到 V3**。

**更新公式**（防单边垄断）：

```
w = 1 + 2 × hit/(hit + bad + 2)
```

- 上限 3.0，下限 0.2
- 连续 5 次 bad → 边进入冷却（w 暂置 0.2，不再参与转移），30 轮后恢复
- `hit_count` / `bad_count` 回写 `when_index`

---

## 7. 参数表（全部待实测）

| 参数 | 初值 | 依据 |
|---|---|---|
| momentum 软下限 | 0.50 | 拍定 |
| momentum 软上限 | 0.85 | 拍定 |
| 压缩重置值 | 0.60 | 拍定 |
| 回弹速率 | 0.02/轮 | 拍定 |
| 工作判定窗口 | 60s / 30s 累计 / ≥2 次 | 拍定 |
| 亲密降低量 | -0.15 | 拍定 |
| 触发概率基准 | 0.15 ~ 0.50 | 拍定 |
| 排队失效 | 3 轮 | 建议 |
| PPR 跳数 | 2 | 硬约束 |
| RRF 第六路权重 | 0.15 | 建议 |
| 边权上限/下限 | 3.0 / 0.2 | 建议 |

**这些数没有一个有真实数据支撑，全部是拍定。** 先用，再拿 `hit_count` 分布回调。

---

## 8. 预算约束（硬）

魂引上限 1000 token，四类注入合计 1000。

- 「想到」段**必须单独申请额度**，不能挤「我记得」的预算。
- 建议：给「想到」固定 80 token 上限（约一条记忆），超了就这轮不注入。
- 没有单独额度时，第六路只能出现在"可检索"档，不进常驻段。
- 这条要在写 PPR 之前定，否则做出来一注入就被 `enforceBudget` 裁掉。

---

## 9. 施工顺序

| 阶段 | 内容 | 依赖 | 可单测 |
|---|---|---|---|
| 一 | `memory/scene.mjs` + 真实事件字段验证 | 无 | ✅ |
| 二 | 新库建 `when_index` + 写入自动签 when | 一 | ✅ |
| 三 | `memory/momentum.mjs` 状态机 + 分会话 Map + 持久化 | 一 | ✅ |
| 四 | `memory/ppr.mjs` 纯算法（给定图，算 rank） | 无（可用假图） | ✅ |
| 五 | 建边脚本（`same-scene`）+ 连通性测试 | 二 | ✅ |
| 六 | 触发/排队/注入「想到」段 | 三四五 | 半 |
| 七 | 反馈回写 w | 六 | ✅ |
| 八 | 真实会话调参 | 全部 | ❌ 只能实测 |

**阶段一必须最后才验收**：真实的 tool 事件字段拿到之前，后面全部是纸上推演。

---

## 10. 验收判据

1. `scene.mjs`：喂一条真实 `session/event`，输出字段全部非空（tool 可为 null，其余不可）。
2. `when_index`：跑一天后行数应接近当日新增记忆数（自动签生效）。
3. `momentum.mjs`：构造 60s 内 3 次工具调用 → 势能升 0.08；喂亲密词 → 降 0.15；压缩 → 归 0.60。
4. `ppr.mjs`：手搓 10 节点小图，验证 2 跳内 rank 单调、3 跳强制归零。
5. 连通性：889 条记忆建边后，最大连通分量占比 > 30%（低于此说明建边太稀，需放宽规则）。
6. 「想到」注入率：不高于 50% 的轮次有联想，不低于 10%——太高变噪音，太低形同没有。
