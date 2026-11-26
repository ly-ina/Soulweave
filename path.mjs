/**
 * path.mjs —— 零依赖路径运算（1.0 剥离 node:path 的替身）。
 *
 * 为什么不直接 import node:path：SDK 面要在非 Node 宿主（浏览器 / 别的 harness）里解析得了，
 * 任何 `node:` specifier 都会在那一层断掉。而 path 的运算本质是**纯字符串**，
 * 没有理由向宿主借实现。
 *
 * 策略：不维护全局平台状态，**按传进来的路径自己判断**
 *   `E:\a` / `\\srv\share` → win32 风格；
 *   其余 → posix 风格。
 * 调用点传的都是绝对路径，判断稳定。`sep` 常量才读一次 process.platform。
 */

const WIN_ABS = /^[A-Za-z]:[\\/]/
const WIN_UNC = /^\\\\/

/** 这组参数像是 Windows 路径吗。 */
function looksWin(parts) {
  for (const p of parts) {
    if (typeof p !== 'string') continue
    if (WIN_ABS.test(p) || WIN_UNC.test(p)) return true
  }
  return false
}

function sepOf(parts) {
  return looksWin(parts) ? '\\' : '/'
}

/** 平台默认分隔符。只读全局，不 import 任何东西。 */
export const sep = globalThis.process?.platform === 'win32' ? '\\' : '/'

export function isAbsolute(p) {
  const s = String(p ?? '')
  return s.startsWith('/') || WIN_ABS.test(s) || WIN_UNC.test(s)
}

/** 把一段路径拆成 { prefix, segs, abs }，prefix 是盘符或 UNC 头。 */
function splitPath(p, sep) {
  // 先把 UNC（\\server\share）的前导双斜杠保住：直接折叠会压成一个，
  // 后面 startsWith('\\\\') 就永远不成立，UNC 路径会退化成「根下的相对段」。
  const raw = String(p ?? '')
  const s = sep === '\\' && /^[\\/]{2}[^\\/]/.test(raw)
    ? '\\\\' + raw.replace(/^[\\/]+/, '').replace(/[\\/]+/g, sep)
    : raw.replace(/[\\/]+/g, sep)
  let prefix = ''
  let rest = s
  if (sep === '\\') {
    const drive = /^([A-Za-z]:)(\\|$)/.exec(rest)
    if (drive) {
      prefix = drive[1]
      rest = rest.slice(drive[1].length)
    } else if (rest.startsWith('\\\\')) {
      const m = /^\\\\[^\\]+\\[^\\]+/.exec(rest)
      if (m) {
        prefix = m[0]
        rest = rest.slice(m[0].length)
      } else {
        prefix = '\\\\'
        rest = rest.slice(2)
      }
    }
  }
  const abs = rest.startsWith(sep) || prefix !== ''
  const segs = rest.split(sep).filter((x) => x !== '' && x !== '.')
  return { prefix, segs, abs }
}

function joinParts({ prefix, segs, abs }, sep) {
  const body = segs.join(sep)
  if (prefix) return prefix + (body ? sep + body : sep)
  if (abs) return sep + body
  return body || '.'
}

/** 消解 `.` 与 `..`；没有绝对段时原样保留前导 `..`。 */
function normalizeParts(parts) {
  const { prefix, segs, abs } = parts
  const out = []
  for (const seg of segs) {
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return { prefix, segs: out, abs }
}

function normalizeWith(p, sep) {
  return joinParts(normalizeParts(splitPath(p, sep)), sep)
}

export function join(...parts) {
  const sep = sepOf(parts)
  const usable = parts.filter((p) => typeof p === 'string' && p !== '')
  if (usable.length === 0) return '.'
  const first = splitPath(usable[0], sep)
  const segs = [...first.segs]
  for (let i = 1; i < usable.length; i++) {
    segs.push(...splitPath(usable[i], sep).segs)
  }
  // 后面各段的绝对性被忽略（与 node:path.join 一致）
  // 必须走 normalizeParts：node:path.join 会消 . / ..，这里以前直接拼，
  // join(p, '..') 会变成 "p/.." 原样留着，调用方拿它去 mkdir 就把文件建成了目录。
  return joinParts(normalizeParts({ prefix: first.prefix, segs, abs: first.abs }), sep)
}

export function resolve(...parts) {
  const sep = sepOf(parts)
  const usable = parts.filter((p) => typeof p === 'string' && p !== '')
  if (usable.length === 0) usable.push(globalThis.process?.cwd?.() ?? '/')
  let combined = ''
  let foundAbs = false
  for (let i = usable.length - 1; i >= 0; i--) {
    combined = usable[i] + (combined ? sep + combined : '')
    if (isAbsolute(usable[i])) { foundAbs = true; break }
  }
  if (!foundAbs) {
    const cwd = globalThis.process?.cwd?.() ?? '/'
    combined = cwd + sep + combined
  }
  return normalizeWith(combined, sep)
}

export function dirname(p) {
  const sep = sepOf([p])
  const s = String(p ?? '').replace(/[\\/]+/g, sep)
  if (/^[A-Za-z]:[\\/]*$/.test(s)) return s.slice(0, 2) + sep
  if (/^[\\/]+$/.test(s)) return sep
  const trimmed = s.replace(new RegExp(`\\${sep}+$`), '')
  if (trimmed === '') return sep
  const i = trimmed.lastIndexOf(sep)
  if (i < 0) return '.'
  const head = trimmed.slice(0, i)
  if (head === '') return sep
  if (/^[A-Za-z]:$/.test(head)) return head + sep
  return head
}

export function basename(p, ext) {
  const sep = sepOf([p])
  const s = String(p ?? '').replace(/[\\/]+/g, sep).replace(new RegExp(`\\${sep}+$`), '')
  const i = s.lastIndexOf(sep)
  let b = i < 0 ? s : s.slice(i + 1)
  if (ext && b.length > ext.length && b.endsWith(ext)) b = b.slice(0, -ext.length)
  return b
}

export function extname(p) {
  const b = basename(p)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i)
}

export function relative(from, to) {
  const sep = sepOf([from, to])
  const a = normalizeParts(splitPath(from, sep))
  const b = normalizeParts(splitPath(to, sep))
  if (a.prefix.toLowerCase() !== b.prefix.toLowerCase()) return normalizeWith(to, sep)
  let i = 0
  while (i < a.segs.length && i < b.segs.length && a.segs[i] === b.segs[i]) i++
  const up = new Array(a.segs.length - i).fill('..')
  const rest = b.segs.slice(i)
  if (up.length === 0 && rest.length === 0) return ''
  return [...up, ...rest].join(sep)
}


// ---- node:path 兼容面的剩余部分（1.0 收尾）----
// 原先缺 normalize/parse/format/toNamespacedPath，这里补齐默认平台版。
// 常规路径对齐 node:path；重复分隔符、UNC 尾斜杠这类边角按"合理"处理，
// 不追求逐字节等价（这些只给非 Node 宿主兜底用）。

/** 归一化：折叠 . 和 ..，统一分隔符，保留绝对性与尾斜杠。 */
export function normalize(p) {
  const s = String(p ?? '')
  if (s === '') return '.'
  const sp = looksWin([s]) ? '\\' : sep
  const out = normalizeWith(s, sp)
  const trailing = s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))
  if (trailing && !out.endsWith(sp) && !/^[A-Za-z]:$/.test(out)) return out + sp
  return out
}

function rootOf(s) {
  if (WIN_ABS.test(s)) return s.slice(0, 3)
  if (WIN_UNC.test(s)) {
    const segs = s.replace(/\\/g, '/').split('/').filter(Boolean)
    return segs.length >= 2 ? '\\\\' + segs[0] + '\\' + segs[1] : '\\\\' + segs[0]
  }
  if (s.startsWith('/')) return '/'
  return ''
}

/** 拆成 { root, dir, base, ext, name }，与 node:path.parse 同形。 */
export function parse(p) {
  const s = String(p ?? '')
  if (s === '') return { root: '', dir: '', base: '', ext: '', name: '' }
  const root = rootOf(s)
  let rest = s.slice(root.length)
  if (rest.length > 1 && /[\\/]$/.test(rest)) rest = rest.slice(0, -1)
  const i = Math.max(rest.lastIndexOf('/'), rest.lastIndexOf('\\'))
  const dirPart = i >= 0 ? rest.slice(0, i) : ''
  const base = i >= 0 ? rest.slice(i + 1) : rest
  let dir = dirPart ? root + dirPart : root
  if (!dirPart && base && WIN_UNC.test(root)) dir = root + '\\'
  if (dir.length > 1 && dir !== root && /[\\/]$/.test(dir)) dir = dir.slice(0, -1)
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 && !/^\.+$/.test(base) ? base.slice(dot) : ''
  const name = ext ? base.slice(0, base.length - ext.length) : base
  return { root, dir, base, ext, name }
}

/** parse 的逆操作；给了 base 就忽略 name/ext（和 Node 一致）。 */
export function format(obj) {
  const o = obj ?? {}
  const base = o.base || (o.name || '') + (o.ext || '')
  if (o.dir) {
    const sp = looksWin([o.dir]) ? '\\' : sep
    return o.dir.endsWith(sp) ? o.dir + base : o.dir + sp + base
  }
  return (o.root || '') + base
}

/** Windows 上 resolve 后加 \\?\ 前缀，其它平台原样返回（与 node:path 一致）。 */
export function toNamespacedPath(p) {
  const s = String(p ?? '')
  if (s === '') return s
  if (globalThis.process?.platform !== 'win32') return s
  if (/^\\\\[?.]\\/.test(s)) return s
  const r = resolve(s)
  if (WIN_UNC.test(r)) return '\\\\?\\UNC\\' + r.slice(2)
  if (WIN_ABS.test(r)) return '\\\\?\\' + r
  return r
}
