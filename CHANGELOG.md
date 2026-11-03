# Changelog

## 0.1.2 — 2026-11-03（待发布：npm publish 由交办方执行）

- 新增只读脚本 `soul_lint.mjs`：扫 `memory/*.md` 与 `memory.db`，按「标题 + 正文」的字符 bigram Jaccard ≥ 0.8 列出「可能双写」，只报告不修改；不传参数时自动读本机 profile 的 soulweave 配置。
- 新增配置 `extraSoulPaths`（字符串数组）：额外常驻文件按顺序拼在 `soul.md` 之后，共用同一份预算与降档；文件缺失跳过并写 `soul-warn`。不配置时渲染结果与 0.1.1 逐字节一致。
- README 新增「三处数据写哪里」：`soul.md` / `memory/<zone>.md` / `memory.db` 的写入边界与迁移规则。
- `check.mjs` 64 → 70 条断言（新增 V1–V3 双写检测、X1–X3 多文件常驻）。

## 未发布

- 改：`soul_toolout` 改为按 `biliDbPath` 存在与否注册。目标库不存在时不再注册该工具，避免每次调用都返回「库不存在」、并白占一张工具 schema。`check.mjs` 增至 72 条断言（新增 R7）。

- 修：`reload-state.json` 改为按 session 分键（`{ version: 2, sessions: { <id>: { lastInject, at, lastReloadAt } } }`）。原先是全局单文件，压缩代理会话会把 `lastInject` 覆盖成自己的小值，主会话下一轮误判为「上轮不大」，压缩后重载永远轮不到主会话。状态只保留最近 12 个会话，旧格式自动视为空。

## 0.1.1 — 2026-11-03

节名改为通用名：`身份` / `认知` / `禁令` / `外交` / `反哺`；旧名 `我是谁` / `我怎么想` / `我不做什么` / `在群里` / `反哺记录` 仍兼容，旧文件不用改。

## 0.1.0 — 2026-11-03

首个开源版本：`agent/pre-step` 注入魂引（预算内降档）、九个 `soul_*` 工具、三档记忆后端（`builtin` 默认 / `meow` / `none`）、四源 `soul_recall`（记忆 / 笔记 / 封存段 / 原文库）、分区与标签、干净安装自测（`clean-install.mjs`）。
