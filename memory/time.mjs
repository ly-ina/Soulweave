/**
 * memory/time.mjs —— 中文时间解析（`明天九点` → 绝对时间）。
 *
 * 只服务一件事：把 `※办：明天九点交材料` 里的到期时间算出来。
 * 设计原则：**宁可不认，不许猜错**。认不出返回 null，调用方据此把待办降级成记忆，
 * 而不是挂一个错误的 due 到现状段上。
 *
 * 时区：本地时区（用户机器 +08:00），不引 IANA 库。
 * 依赖方向：纯函数，零 import。
 */

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const WEEKDAY_CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 七: 0 }

/** 只说了日期没说时刻时，默认早上 9 点。 */
export const DEFAULT_HOUR = 9

/**
 * 截止式表述：这些词**本身就是时刻别名**，不是模糊说法。
 *
 * 「下周五下班前」= 18:00，是明确的截止点；把它当"没写时刻"按 09:00 处理，
 * 会给出一个**错的时间**，比不认更糟。
 */
const DEADLINE_WORDS = Object.freeze([
  { re: /下班前|下班之前/, h: 18, word: '下班前' },
  { re: /下班后|下班之后/, h: 19, word: '下班后' },
  { re: /午休前|中午前|午饭前/, h: 12, word: '中午前' },
  { re: /上班前|上班之前/, h: 9, word: '上班前' },
  { re: /晚饭前|晚饭之前/, h: 18, word: '晚饭前' },
  { re: /睡前|睡觉前/, h: 22, word: '睡前' },
  { re: /早餐前|早饭前/, h: 8, word: '早餐前' },
])

const pad2 = (n) => String(n).padStart(2, '0')

/** 中文数字转整数：九 / 十 / 十一 / 二十三。不是数字返回 null。 */
export function cnNum(input) {
  const text = String(input ?? '').trim()
  if (/^\d+$/.test(text)) return Number(text)
  if (text === '十') return 10
  if (text.startsWith('十')) return 10 + (CN_DIGIT[text[1]] ?? 0)
  if (text.includes('十')) {
    const [a, b] = text.split('十')
    return (CN_DIGIT[a] ?? 0) * 10 + (b ? CN_DIGIT[b] ?? 0 : 0)
  }
  const single = CN_DIGIT[text]
  return single === undefined ? null : single
}

const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const addDays = (d, n) => {
  const x = new Date(d.getTime())
  x.setDate(x.getDate() + n)
  return x
}
const mondayOf = (d) => addDays(atMidnight(d), -((d.getDay() + 6) % 7))

/** 有没有明说时段：「八点」没有，「晚上八点」「下班前」有。 */
const hasPeriodWord = (src) =>
  /凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜/.test(src) || DEADLINE_WORDS.some((def) => def.re.test(src))

/**
 * 在若干候选小时里取「离现在最近的未来那一刻」。
 * 用于裸时刻：晚上七点说「八点」，该给今晚 20:00，而不是明天 08:00。
 */
function nearestFuture(base, hours, minute) {
  const mid = atMidnight(base)
  let best = null
  for (const hh of hours) {
    let cand = new Date(mid.getFullYear(), mid.getMonth(), mid.getDate(), hh, minute)
    if (cand.getTime() <= base.getTime()) cand = addDays(cand, 1)
    if (best === null || cand.getTime() < best.getTime()) best = cand
  }
  return best
}

/** 解析日期锚点；返回 {date, matched, kind}，认不出时 date=null。 */
function resolveDate(src, base) {
  // ① 完整日期：2026-11-30 / 2026年11月30日
  let m = /(\d{4})\s*[-/年]\s*(\d{1,2})\s*[-/月]\s*(\d{1,2})\s*[日号]?/.exec(src)
  if (m) return { date: new Date(+m[1], +m[2] - 1, +m[3]), matched: m[0], kind: 'absolute' }

  // ② 月日：11月30日 / 11月30（无年份，已过则算明年）
  m = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(src)
  if (m) {
    const month = +m[1]
    const day = +m[2]
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let d = new Date(base.getFullYear(), month - 1, day)
      if (d.getTime() < atMidnight(base).getTime() - 86_400_000) {
        d = new Date(base.getFullYear() + 1, month - 1, day)
      }
      return { date: d, matched: m[0], kind: 'month-day' }
    }
  }

  // ③ 相对天（含缩写：明早 / 今早 / 明晚 / 今晚）
  if (/明早|明晚/.test(src)) return { date: addDays(atMidnight(base), 1), matched: src.match(/明[早晚]/)[0], kind: 'relative-days' }
  if (/今早|今晚/.test(src)) return { date: atMidnight(base), matched: src.match(/今[早晚]/)[0], kind: 'relative-days' }
  m = /([一二三四五六七八九十]+|\d+)\s*天\s*(?:之?后|以后)/.exec(src)
  if (m) {
    const n = cnNum(m[1])
    if (n !== null) return { date: addDays(atMidnight(base), n), matched: m[0], kind: 'relative-days' }
  }
  if (/大后天/.test(src)) return { date: addDays(atMidnight(base), 3), matched: '大后天', kind: 'relative-days' }
  if (/后天/.test(src)) return { date: addDays(atMidnight(base), 2), matched: '后天', kind: 'relative-days' }
  if (/明天|明日/.test(src)) return { date: addDays(atMidnight(base), 1), matched: '明天', kind: 'relative-days' }
  if (/今天|今日/.test(src)) return { date: atMidnight(base), matched: '今天', kind: 'relative-days' }

  // ⑤ 下个月 X 号（跨年由 Date 构造自动进位）
  m = /(?:下个?月|下月)\s*(\d{1,2})\s*[日号]?/.exec(src)
  if (m) {
    const day = +m[1]
    if (day >= 1 && day <= 31) {
      return { date: new Date(base.getFullYear(), base.getMonth() + 1, day), matched: m[0], kind: 'next-month' }
    }
  }

  // ④ 周：下周X / 本周X / 周X / 星期X / 礼拜X
  m = /(下下|下|本|这)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天七])/.exec(src)
  if (m) {
    const token = m[1] ?? ''
    const weekday = WEEKDAY_CN[m[2]]
    const weekOffset = token === '下' ? 1 : token === '下下' ? 2 : 0
    const targetIdx = (weekday + 6) % 7 // 周一 = 0

    // 只说「周五」：相对今天算最近的未来那天（不是相对本周一）
    if (token === '') {
      const todayIdx = (base.getDay() + 6) % 7
      let delta = targetIdx - todayIdx
      if (delta < 0) delta += 7
      return { date: addDays(atMidnight(base), delta), matched: m[0], kind: 'weekday' }
    }

    // 说「下周X / 本周X」：相对本周一算
    return { date: addDays(mondayOf(base), targetIdx + weekOffset * 7), matched: m[0], kind: 'weekday' }
  }

  return { date: null, matched: '', kind: 'none' }
}

/** 解析时刻；返回 {h, min, matched}，认出时 h 为 null。 */
function resolveTime(src) {
  const NUM = '[一二三四五六七八九十]{1,3}|\\d{1,2}'

  // ① HH:mm（最精确，优先）
  let m = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(src)
  if (m) {
    const h = +m[1]
    const min = +m[2]
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { h, min, matched: m[0] }
  }

  // ①b 截止式表述（下班前 / 午休前 / 睡前…）——它们本身就是时刻，不是模糊词
  // matched 必须回**原文命中片段**：route 会拿它从正文里摘除，回规范词会摘不掉
  for (const def of DEADLINE_WORDS) {
    const hit = def.re.exec(src)
    if (hit) return { h: def.h, min: 0, matched: hit[0] }
  }

  // ② 时段 + N点(半/N分)
  m = new RegExp(`(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里|半夜)?\\s*(${NUM})\\s*点\\s*(半|(${NUM})\\s*分)?`).exec(src)
  if (m) {
    const period = m[1] ?? ''
    let h = cnNum(m[2])
    const min = m[3] === '半' ? 30 : m[4] !== undefined ? cnNum(m[4]) : 0
    if (h !== null && min !== null) {
      if (period === '下午' || period === '傍晚' || period === '晚上' || period === '夜里') {
        if (h < 12) h += 12
      } else if (period === '中午') {
        if (h < 12) h += 12
      } else if (period === '半夜') {
        if (h === 12) h = 0
      }
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { h, min, matched: m[0] }
    }
  }

  // ③ 只有时段词
  if (/中午/.test(src)) return { h: 12, min: 0, matched: '中午' }
  if (/早上|早晨|上午/.test(src)) return { h: 8, min: 0, matched: '早上' }
  if (/晚上|夜里/.test(src)) return { h: 20, min: 0, matched: '晚上' }

  return { h: null, min: 0, matched: '' }
}

/**
 * 从一句话里解析到期时间。
 *
 * @param {string} text 待办正文
 * @param {Date} [now] 基准时间
 * @returns {null | {at:number, iso:string, assumedTime:boolean, assumedDate:boolean, matched:string, kind:string}}
 *   null 表示**认不出**——调用方必须据此降级，不许拿当前时间兜底。
 */
export function parseDue(text, now = new Date()) {
  const src = String(text ?? '')
  if (src.trim() === '') return null

  const base = new Date(now)

  // 相对小时 / 分钟优先（中文数字也要认：「两个小时以后」）
  let m = /([一二三四五六七八九十两]+|\d+(?:\.\d+)?)\s*个?\s*小时\s*(?:之?后|以后)/.exec(src)
  if (m) {
    const n = cnNum(m[1])
    if (n !== null) return pack(base.getTime() + Math.round(n * 3600_000), false, false, m[0], 'relative-hours')
  }
  if (/半\s*个?\s*小时\s*(?:之?后|以后)/.test(src)) return pack(base.getTime() + 30 * 60_000, false, false, '半小时后', 'relative-hours')
  m = /([一二三四五六七八九十两]+|\d+)\s*分钟\s*(?:之?后|以后)/.exec(src)
  if (m) {
    const n = cnNum(m[1])
    if (n !== null) return pack(base.getTime() + n * 60_000, false, false, m[0], 'relative-minutes')
  }

  const date = resolveDate(src, base)
  const time = resolveTime(src)
  if (date.date === null && time.h === null) return null

  // 裸时刻（没日期、也没说早/晚、且不是 9:30 这种带冒号的精确写法）：
  // 「八点」在晚上说来是今晚 20:00，在上午说来是明天 08:00 —— 取 h 与 h+12 里先到的那个。
  // 带冒号的（9:30）按保守处理：默认上午，过了就顺延明天。
  const isClock = /[:：]/.test(time.matched)
  if (date.date === null && time.h !== null && time.h < 12 && !isClock && !hasPeriodWord(src)) {
    const best = nearestFuture(base, [time.h, time.h + 12], time.min)
    const result = pack(best.getTime(), false, true, time.matched, 'bare-hour')
    result.ambiguous = true // 让调用方知道：这个时刻是靠"最近未来"推的，不是模型说清的
    return result
  }

  let day = date.date
  let assumedDate = false
  if (day === null) {
    // 只有时刻：今天该点若已过，顺延到明天
    day = atMidnight(base)
    const candidate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.h, time.min)
    if (candidate.getTime() <= base.getTime()) day = addDays(day, 1)
    assumedDate = true
  }

  let hour = time.h
  let minute = time.min
  let assumedTime = hour === null
  // 「明早 / 今晚」这类缩写：日期由 resolveDate 给了，时刻取默认时段（早=8、晚=20），不算瞎猜
  if (assumedTime) {
    const abbrev = /(?:明|今|后)(早|晚)/.exec(src)
    if (abbrev) {
      hour = abbrev[1] === '早' ? 8 : 20
      minute = 0
      assumedTime = false
    }
  }
  // 「明晚八点」：时段藏在缩写里，resolveTime 只看到「八点」，得补 +12
  if (hour !== null && hour < 12 && /(?:明|今|后)晚/.test(src) && !/(凌晨|早上|早晨|上午)/.test(src)) {
    hour += 12
  }
  const h = assumedTime ? DEFAULT_HOUR : hour
  const min = assumedTime ? 0 : minute
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, min)

  return pack(
    at.getTime(),
    assumedTime,
    assumedDate,
    [date.matched, time.matched].filter(Boolean).join(' '),
    [date.kind, assumedTime ? 'default-time' : 'explicit-time'].filter((x) => x !== 'none').join('+'),
  )
}

function pack(at, assumedTime, assumedDate, matched, kind) {
  const d = new Date(at)
  const iso = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`
  return { at, iso, assumedTime, assumedDate, ambiguous: false, matched, kind }
}
