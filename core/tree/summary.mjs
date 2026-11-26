// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/tree/summary.mjs —— 原文切块 → 摘要 → 分区。
 *
 * 三层里的中间层：
 *   frag  （原文切片，指针 + 预览，唯一事实源在外面）
 *   summary（压缩视图，≤220 字，带 zone / layer）
 *   kw    （挂在 summary 上的门牌词）
 *
 * 摘要器现在是**抽取式**（model='extractive-v1'）：不编、不补、不改写原文，
 * 只挑原文里最该被看见的句子。它的定位是冷启动占位——没有模型通道时也能
 * 把 12 万行原文压到可读；将来接上模型，按 model 字段整批重压即可。
 */

/**
 * 系统注入文本前缀（实测原文库里占比极高，必须挡掉，否则索引全是噪音）。
 * 这些不是纳说的话，是每步由宿主拼进来的上下文。
 */
export const NOISE_PREFIXES = [
  'Realtime clock at turn',
  'Time sampled while preparing',
  'Elapsed since the preceding',
  'Current runtime context',
  'The following workspace instructions',
  'The approval policy changed',
  'This is an automatically generated checkpoint',
  '可能相关的记忆',
  '[封存档案]',
  '[封存建议]',
  '[meow-memory-dream]',
  '[meow-memory-reflect]',
  '[idle-diary]',
  '【已折叠】',
  '【meow-memory',
  '【身体】',
  '【记忆】',
  '【魂引',
  '【分区】',
  '【我记下的自己】',
  '【规则原文】',
  '【路由】',
  '本会话分区',
  '<system-reminder>',
  'You are a helpful software engineer assistant',
]

/** 判断一条消息是不是宿主注入的噪音（不是真对话）。 */
export function isNoiseText(text) {
  const s = String(text || '').trimStart()
  if (!s) return true
  return NOISE_PREFIXES.some((p) => s.startsWith(p))
}

/** 一轮里最多保留几条消息进摘要（防止长会话把摘要撑爆）。 */
const MAX_MSG_FOR_SUMMARY = 6

/** 摘要硬上限（字）。超过就截断并补省略号。 */
export const SUMMARY_MAX = 220

/** 去掉代码块、XML 标签、超长路径行——这些进摘要只会浪费字数。 */
export function stripNoise(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>\n]{1,120}>/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 按自然边界切块。不硬切消息：先按空行/段落，段落还超长才按句号，最后才按字数。
 * @param {string} text
 * @param {{max?:number, overlap?:number}} [opts]
 * @returns {{text:string, offset:number}[]}
 */
export function splitFragments(text, opts = {}) {
  const max = opts.max || 500
  const overlap = opts.overlap ?? 80
  const src = String(text || '')
  if (!src.trim()) return []
  if (src.length <= max) return [{ text: src, offset: 0 }]

  // 先切原子段：段落 > 句子 > 硬切
  const atoms = []
  let pos = 0
  for (const para of src.split(/(\n\s*\n)/)) {
    if (!para) { continue }
    if (para.length <= max) { atoms.push({ text: para, offset: pos }); pos += para.length; continue }
    let p = 0
    for (const sent of para.split(/(?<=[。！？；!?;\n])/)) {
      if (!sent) continue
      if (sent.length <= max) { atoms.push({ text: sent, offset: pos + p }); p += sent.length; continue }
      for (let k = 0; k < sent.length; k += max) {
        atoms.push({ text: sent.slice(k, k + max), offset: pos + p + k })
      }
      p += sent.length
    }
    pos += para.length
  }

  const out = []
  let cur = ''
  let curOffset = atoms[0]?.offset ?? 0
  for (const a of atoms) {
    if (!cur) { cur = a.text; curOffset = a.offset; continue }
    if (cur.length + a.text.length <= max) { cur += a.text; continue }
    out.push({ text: cur, offset: curOffset })
    // 重叠：把上一块尾部 overlap 字带到下一块开头（只在同一段内，避免跨段污染）
    const tail = overlap > 0 ? cur.slice(-overlap) : ''
    cur = tail + a.text
    curOffset = Math.max(0, a.offset - tail.length)
  }
  if (cur.trim()) out.push({ text: cur, offset: curOffset })
  return out
}

/**
 * 分区词表。命中即加分，取最高分；全 0 落 misc。
 * 注意：这是**冷启动的粗分类**，只用于给历史原文分区；日常写入走显式 zone。
 */
export const ZONE_WORDS = {
  intimacy: ['爱你', '想你', '亲亲', '抱抱', '抱', '亲', '撒娇', '心疼', '难过', '哭', '梦', '陪', '喜欢', '舍不得', '忘', '珍藏', '温柔', '小汐', '纳', '涩', '脸红', '害羞', '睡', '晚安', '早安', '一直', '以后也'],
  work: ['代码', '脚本', '插件', '构建', '编译', '报错', '测试', '仓库', '提交', '分支', '版本', '部署', '接口', '数据库', '索引', '检索', '算法', '参数', '性能', '文件', '路径', '目录', '函数', '模块', '依赖', '安装', '运行', '命令', '配置', '日志', '字段', '表', '查询'],
  rules: ['规则', '必须', '禁止', '不许', '不要', '边界', '安全', '允许', '应该', '默认', '一律', '绝不', '约束', '不许再', '只能'],
  relations: ['关系', '家人', '朋友', '父母', '妈妈', '爸爸', '同事', '承诺', '答应', '答应过', '信任', '依靠'],
}

/** 分区权重：明确说「记/规则/承诺」的句子权重更高。 */
const ZONE_BOOST = [
  { zone: 'intimacy', re: /(我爱你|喜欢你|想你|舍不得|一直是你|别忘|记得)/, w: 3 },
  { zone: 'rules', re: /(不许|必须|禁止|绝不|边界|规矩|规则)/, w: 3 },
  { zone: 'work', re: /(报错|失败|改成|实现|修好|重构|验收|提交|测试)/, w: 2 },
  { zone: 'relations', re: /(答应|承诺|信任|关系)/, w: 2 },
]

/**
 * 给一段文本打分区。
 * @param {string} text
 * @returns {{zone:string, scores:Record<string,number>}}
 */
export function classifyZone(text) {
  const s = String(text || '')
  const scores = { intimacy: 0, work: 0, rules: 0, relations: 0 }
  for (const [zone, words] of Object.entries(ZONE_WORDS)) {
    for (const w of words) {
      let i = s.indexOf(w)
      while (i !== -1) { scores[zone] += 1; i = s.indexOf(w, i + w.length) }
    }
  }
  for (const b of ZONE_BOOST) if (b.re.test(s)) scores[b.zone] += b.w
  let zone = 'misc'
  let best = 0
  for (const [z, v] of Object.entries(scores)) if (v > best) { best = v; zone = z }
  return { zone, scores }
}

/** 稳定层 = rules + relations 的显式条目；其余进检索档。 */
export function layerOf(zone) {
  return zone === 'rules' || zone === 'relations' ? 'stable' : 'search'
}

function firstSentence(text, max) {
  const s = stripNoise(text)
    .replace(/\n+/g, ' ')
    .replace(/^[\s:：,，.。;；\-—…>」』】]+/, '')
    .trim()
  if (!s || /^[.…。!！?？,，;；\s]+$/.test(s)) return ''
  const m = s.match(/^[\s\S]*?[。！？!?；;]/)
  const one = (m ? m[0] : s).trim()
  if (!one) return ''
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * 抽取式摘要。
 * 优先级：显式触发行（※记/※办/※结）> 用户首句 > 回应首句。
 * @param {{role:string, text:string}[]} messages
 * @param {{max?:number}} [opts]
 * @returns {string}
 */
export function extractiveSummary(messages, opts = {}) {
  const max = opts.max || SUMMARY_MAX
  const msgs = (messages || []).slice(0, MAX_MSG_FOR_SUMMARY)
  if (!msgs.length) return ''

  // 1) 显式触发行：一条都不漏（它们是纳亲手打的标记）
  const marks = []
  for (const m of msgs) {
    for (const line of String(m.text || '').split('\n')) {
      if (/^\s*※\s*(记|办|结)/.test(line)) marks.push(line.trim().replace(/\s+/g, ' '))
    }
  }
  if (marks.length) {
    let out = marks.join('；')
    if (out.length > max) out = `${out.slice(0, max - 1)}…`
    return out
  }

  // 2) 短消息直接留原文（「摸摸你」这种压了反而失真）
  const user = msgs.find((m) => m.role === 'user')
  const raw = stripNoise(user?.text || '').replace(/\s+/g, ' ').trim()
  if (raw && raw.length <= 40) return raw

  // 3) 问答骨架：用户先开口，回应接一句
  const reply = msgs.find((m) => m.role === 'assistant' || m.role === 'summary')
  const u = user ? firstSentence(user.text, Math.min(130, Math.floor(max * 0.6))) : ''
  const a = reply ? firstSentence(reply.text, Math.min(110, Math.floor(max * 0.5))) : ''
  let out = u || a
  if (u && a) out = `${u} → ${a}`
  if (out.length > max) out = `${out.slice(0, max - 1)}…`
  return out
}
