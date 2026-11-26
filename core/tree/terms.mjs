// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * core/tree/terms.mjs —— 抽词（树索引第二层到第三层的入口）。
 *
 * 零依赖：内置基础词表 + 最大正向匹配 + 英文正则，不引 jieba。
 *   - 词表：./lexicon-base.txt，30,812 个纯中文 2–4 字词（来源 jieba dict.txt，MIT）
 *   - 自学：./lexicon-learned.txt（每行一个词，可带 `\t频次`），不存在就跳过
 *   - 英文/标识符：/[A-Za-z_][A-Za-z0-9_\-:.]{2,}/，统一小写
 *
 * 为什么不用 Intl.Segmenter：实测把「魂织」切成「魂｜织」、「缓存」切成「缓｜存」，
 * 中文分词不能用它（2026-11-26 实测）。
 *
 * 设计口径：抽词只服务检索，不追求语言学正确；宁可少切一个词，不可把
 * 两个词粘成一个（粘出来的词进了图，检索就永远落不到）。
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync, fileURLToPath, dirname } from '../../io.mjs'

const DEFAULT_LEXICON = fileURLToPath(new URL('./lexicon-base.txt', import.meta.url))
const DEFAULT_LEARNED = fileURLToPath(new URL('./lexicon-learned.txt', import.meta.url))

/** 停用词：虚词、口水词、代词。**不挡**情感词与称呼（爱/想/纳/小汐 都不在这里）。 */
export const STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '你', '他', '她', '它', '这', '那', '有', '和', '就',
  '不', '都', '也', '很', '到', '说', '要', '去', '会', '着', '看', '好', '把', '被',
  '让', '给', '对', '从', '而', '但', '又', '还', '再', '才', '只', '更', '最', '太',
  '一个', '一下', '一些', '一样', '一起', '什么', '怎么', '这样', '那样', '这个', '那个',
  '我们', '你们', '他们', '自己', '没有', '可以', '因为', '所以', '但是', '如果', '然后',
  '现在', '时候', '还是', '已经', '就是', '不是', '这么', '那么', '一下', '有点', '觉得',
  '知道', '应该', '可能', '真的', '其实', '不过', '而且', '或者', '以及', '关于', '对于',
  '这里', '那里', '哪里', '之前', '之后', '以后', '以前', '起来', '出来', '过来', '进去',
  '一次', '一直', '一定', '一起', '一点', '有点', '有些', '东西', '事情', '问题', '方面',
])

/** 英文里太泛、建图没意义的词。 */
const STOP_EN = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'not', 'are', 'was', 'you', 'have', 'but', 'all', 'can', 'out', 'get', 'has', 'how', 'its', 'our', 'one', 'two', 'use', 'via', 'per'])

const ASCII_WORD = /[A-Za-z_][A-Za-z0-9_\-:.]{2,}/g

/**
 * 建一个分词器。
 * @param {{lexiconPath?:string, learnedPath?:string, extraWords?:string[]}} [opts]
 */
export function createTokenizer(opts = {}) {
  const lexiconPath = opts.lexiconPath || DEFAULT_LEXICON
  const learnedPath = opts.learnedPath || DEFAULT_LEARNED
  const words = new Set()
  let maxLen = 2

  const add = (w) => {
    const t = String(w || '').trim()
    if (t.length < 2 || t.length > 4) return
    if (!/^[\u4e00-\u9fff]+$/.test(t)) return
    words.add(t)
    if (t.length > maxLen) maxLen = t.length
  }

  if (existsSync(lexiconPath)) {
    for (const line of readFileSync(lexiconPath, 'utf8').split('\n')) {
      const t = line.split('\t')[0]
      add(t)
    }
  }
  if (existsSync(learnedPath)) {
    for (const line of readFileSync(learnedPath, 'utf8').split('\n')) {
      const t = line.split('\t')[0]
      add(t)
    }
  }
  for (const w of opts.extraWords || []) add(w)

  /**
   * 抽词，保留出现顺序。
   * @returns {string[]}
   */
  function tokenize(text) {
    const s = String(text || '')
    if (!s) return []
    const out = []
    // 先把英文/标识符按原位置抽出来，中文部分单独走词表
    const ascii = []
    let masked = s.replace(ASCII_WORD, (m) => {
      ascii.push(m.toLowerCase())
      return '\u0000'
    })
    let i = 0
    while (i < masked.length) {
      const ch = masked[i]
      if (!/[\u4e00-\u9fff]/.test(ch)) { i += 1; continue }
      let hit = ''
      const cap = Math.min(maxLen, masked.length - i)
      for (let n = cap; n >= 2; n -= 1) {
        const w = masked.slice(i, i + n)
        if (words.has(w)) { hit = w; break }
      }
      if (hit) {
        if (!STOPWORDS.has(hit)) out.push(hit)
        i += hit.length
      } else {
        i += 1
      }
    }
    for (const w of ascii) {
      if (w.length >= 3 && !STOP_EN.has(w)) out.push(w)
    }
    return out
  }

  /** 词频表。 */
  function count(text) {
    const m = new Map()
    for (const t of tokenize(text)) m.set(t, (m.get(t) || 0) + 1)
    return m
  }

  return { tokenize, count, has: (w) => words.has(w), get size() { return words.size }, maxLen }
}

/**
 * 自学词落盘（§9.1 词表进化层的最简实现）。
 * 只追加，不改既有行；调用方自己保证频次/PMI 过门槛。
 * @param {string[]} terms
 * @param {{path?:string, minFreq?:number, freq?:Map<string,number>}} [opts]
 * @returns {number} 实际写入行数
 */
export function appendLearned(terms, opts = {}) {
  const p = opts.path || DEFAULT_LEARNED
  const existing = new Set()
  if (existsSync(p)) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const t = line.split('\t')[0]
      if (t) existing.add(t)
    }
  }
  const lines = []
  for (const t of terms) {
    if (!t || existing.has(t) || STOPWORDS.has(t)) continue
    const f = opts.freq?.get?.(t) ?? 0
    lines.push(f ? `${t}\t${f}` : t)
    existing.add(t)
  }
  if (!lines.length) return 0
  mkdirSync(dirname(p), { recursive: true })
  appendFileSync(p, `\n${lines.join('\n')}\n`, 'utf8')
  return lines.length
}
