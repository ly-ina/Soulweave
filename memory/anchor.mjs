/**
 * memory/anchor.mjs —— 待办短锚点。
 *
 * 为什么需要：模型写 `※结：xxx` 时不知道 todo 的真实 id，只能描述内容。
 * 靠文本相似度匹配会误结（"交材料" vs "交材料给王工"）。所以给每条待办一个**短锚点**，
 * 由现状段注入时带出来，模型照着抄即可：
 *
 *   ⏰ 明天 09:00 交材料 [k3f9]
 *   ※结：k3f9
 *
 * 锚点取自 todo id 的最后一段（`t-mno8x-k3f9` → `k3f9`），纯函数，不碰库。
 */

/** 3–6 位小写字母数字，且至少含一个字母（排除纯数字，免得和日期混淆）。 */
const ANCHOR_RE = /^(?=[a-z0-9]{3,6}$)(?=.*[a-z])[a-z0-9]+$/

/** 从 todo id 取短锚点；格式不符返回空串（宁可不用锚点，也不给一个错的）。 */
export function anchorOf(id) {
  const text = String(id ?? '').trim().toLowerCase()
  if (text === '') return ''
  const parts = text.split('-')
  const last = parts[parts.length - 1] ?? ''
  return ANCHOR_RE.test(last) ? last : ''
}

/** 这串东西看起来像不像锚点。 */
export function looksLikeAnchor(value) {
  return ANCHOR_RE.test(String(value ?? '').trim().toLowerCase())
}

/**
 * 解析 `※结` 后面的正文。
 *
 * 容忍模型加括号/井号：`[k3f9]`、`#k3f9`、`（k3f9）` 都按锚点处理。
 * 不像锚点就退回原文本，由调用方走文本匹配兜底。
 *
 * @returns {{kind:'anchor'|'text'|'empty', value:string}}
 */
export function parseSettle(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { kind: 'empty', value: '' }
  const bare = text.replace(/^[[#（(【]+/, '').replace(/[\]）)】]+$/, '').trim()
  if (looksLikeAnchor(bare)) return { kind: 'anchor', value: bare.toLowerCase() }
  return { kind: 'text', value: text }
}

/** 现状段里渲染锚点：`交材料 [k3f9]`；没有锚点就只给内容。 */
export function renderAnchored(content, id) {
  const anchor = anchorOf(id)
  const text = String(content ?? '').trim()
  return anchor === '' ? text : `${text} [${anchor}]`
}
