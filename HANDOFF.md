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

## 2. memprobe 并入魂织

**三个坎（第二条已改，注意）**：

| # | 坎 | 状态 |
|---|---|---|
| ① | `import '../dsh-soulweave/memory/route.mjs'` 变成内部模块 | 待做 |
| ② | 配置从 memprobe 包内 `cordis.patch.yml` 挪进 soulweave 配置树，并停用旧的 | 待做 |
| ③ | ~~soulweave 首次挂 `ctx.on('session/event')`~~ | **已过时——魂织早就挂了**：`adapters/dsh/apply.mjs:1111`（compaction/end）和 `:1149`（原文库同步）。真正要确认的是**第三个 handler 会不会打架**（事件多播，理论上不会，但要实测） |

**并入后验收**：memprobe 原来的三词触发（`※记` / `※办` / `※结`）在魂织里行为不变。
已知状态：`※记` ✅ 真机验过 / `※办` ✅ 真机验过 / `※结` ⬜ 就是第 1 节那件事。

---

## 3. 抽象成 SDK（1.0）

三件事一起做，别拆：

**a. 砍历史导出**
- 主入口现在 **146** 个导出 = `sdk.mjs` 19 个承诺面 + `unstable.mjs` 118 个 + 9 个装配
- 1.0 只留 `sdk.mjs` 那 19 个，`unstable.mjs` 整体移除
- 同步改：`index.js` 装配壳、`check.mjs` R33 的 MUST 数组、`tools/gen-api.mjs`、`docs/API.md`、README 两条轨道表

**b. 抽 `storage/` 层**
```
memory/*.mjs  →  storage/index.mjs  →  { node-sqlite | sql-wasm | file-format }
```
接口只要五个：`open / get / query / write / close`。
现在 `node:sqlite` 散在 `builtin.mjs` / `when.mjs` / `health.mjs` / `decay.mjs` 四个文件里——抽出来成本最低就是现在。

**c. 清掉本机路径**
`check.mjs` 里测试夹具的 `<workspace>` 换成中性值（不是 bug，只是抽象时该干净）。
真实 soul.md 那处有 `process.env` 兜底 + SKIP，不用动。

---

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
