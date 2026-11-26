// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * prompt —— 注入消息、工作区解析、分区行（零宿主依赖）。
 */
import { MESSAGE_KIND } from './constants.mjs'
import { cwd } from '../io.mjs'
import { isAbsolute } from '../io.mjs'
import { asText } from './text.mjs'
import { scanZones, readZoneIndex, ZONE_IDS, ZONES } from './zones.mjs'
export function createSoulMessage(text, kind = MESSAGE_KIND) {
  return Object.freeze({
    id: `soul-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind,
      form: 'snapshot',
      sections: Object.freeze([Object.freeze({ name: kind, text })]),
    }),
  })
}

/**
 * 「现在在哪」要的是**会话工作区**，不是宿主进程的 cwd（那会是 profile 目录）。
 * 实测 `agent/pre-step` 的 payload 是 `{ messages, turn, step, signal, agent }`，
 * 工作区在 `agent.session.header.cwd`（`dsh-session` 的会话头记录 cwd，见
 * `liveSource.header.cwd`）。其余候选字段是防御性兜底：宿主换形状时仍能落到真值。
 * 绝对路径判定跨平台：path.isAbsolute（本平台语义）+ 原 Windows 盘符/UNC 正则兜底，
 * 这样 Linux 的 /home/... 与 Linux 视角下的 D:\... 都能被采纳，不再回落 process.cwd()。
 */
export function resolveWorkspace(payload, options = {}) {
  const session = payload?.agent?.session ?? payload?.session
  const candidates = [
    options.workspace,
    session?.header?.cwd,
    session?.header?.workspace,
    session?.cwd,
    session?.workspace,
    payload?.agent?.cwd,
    payload?.agent?.workspace,
    payload?.cwd,
    payload?.workspace,
    payload?.runtimeContext?.cwd,
  ]
  for (const candidate of candidates) {
    const text = asText(candidate)
    if (text && (isAbsolute(text) || /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(text))) return text
  }
  return asText(cwd()) || '未标注工作区'
}

/**
 * 构造 `agent/pre-step` 处理器。导出成工厂是为了让 check.mjs 能用假 payload、
 * 临时 soul.md、临时日志跑断言，不碰真实会话与真实库（§9.8）。
 *
 * @param options 归一化后的配置（可再带 `now` / `logger` / `workspace` 覆盖）
 */
/**
 * 分区行（待办 A）：索引定顺序/标题，**条数每次现扫文件算**——手改完 memory/*.md
 * 忘了重建索引也不会把魂引的数字写错。
 */
export function zoneRowsOf(config) {
  const scanned = scanZones(config.memoryRoot)
  const rows = readZoneIndex(config.zoneIndexPath).map((row) => ({
    ...row,
    count: (scanned[row.zone] ?? []).length,
  }))
  const known = new Set(rows.map((row) => row.zone))
  for (const zone of ZONE_IDS) {
    if (known.has(zone)) continue
    const count = (scanned[zone] ?? []).length
    if (count > 0) {
      rows.push({ zone, title: ZONES[zone], file: `memory/${zone}.md`, count, tags: [], updated: '' })
    }
  }
  return rows
}

