/**
 * 九期：gamedev 技能库接入能力层（`soul_capabilities` 的 `source: 'gamedev'`）。
 *
 * 设计要点（交办单 §2）：
 * 1. 只读 `INDEX.json`（78 条，约 18KB），**不读正文**——正文由模型拿路径自己打开；
 * 2. 检索口径照抄技能库自带的 ind.mjs：
 *    中文词表（ZH）整段搬来、name 命中 +6、desc 命中每次 +1 封顶 3、停用词表一致。
 *    搬来而不是运行时去 import 那边，是为了让插件不依赖技能库的目录结构；
 *    两边口径漂移由 `check.mjs` 的 C14 断言盯着（skill 目录在就逐字比 ZH 与 STOP）。
 * 3. `INDEX.json` 不存在 → 返回一行「技能库未安装：<目录>」，不抛错；
 * 4. 一切异常降级为「无相关技能」，绝不影响 soul_capabilities 主流程。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 中文 → 英文检索词。与 `skills/gamedev/find.mjs` 的 ZH 逐字一致（C14 校验）。 */
export const GAMEDEV_ZH = {
  角色: ['character', 'player', 'controller'], 玩家: ['player', 'input', 'controller'],
  敌人: ['enemy', 'ai', 'behavior'], 行为树: ['behavior-tree', 'ai'],
  存档: ['save', 'persistence', 'serialization'], 读档: ['save', 'load'],
  关卡: ['level', 'tilemap', 'design'], 地图: ['tilemap', 'level', 'map'],
  物理: ['physics', 'collision'], 碰撞: ['collision', 'physics'],
  着色器: ['shader'], 材质: ['material', 'shader'], 光照: ['lighting', 'light'],
  动画: ['animation', 'animator'], 骨骼: ['skinned', 'animation'],
  音效: ['audio', 'sound'], 音乐: ['audio', 'music'],
  像素: ['pixel', 'sprite', '2d'], 精灵: ['sprite'], 瓦片: ['tile', 'tilemap'],
  界面: ['ui', 'ux', 'hud'], 相机: ['camera'], 输入: ['input', 'controls'],
  手感: ['game-feel', 'juice', 'tuning'], 性能: ['performance', 'optimization', 'profiling'],
  程序化: ['procedural', 'generation'], 随机: ['random', 'procedural'],
  对话: ['dialogue', 'narrative'], 剧情: ['narrative', 'dialogue', 'visual-novel'],
  联机: ['multiplayer', 'networking'], 网络: ['networking', 'multiplayer'],
  打包: ['build', 'packaging', 'export'], 发布: ['publish', 'steam', 'itch'],
  测试: ['test', 'testing'], 原型: ['prototype', 'jam'],
  平台跳跃: ['platformer'], 肉鸽: ['roguelike'], 塔防: ['tower-defense'],
  卡牌: ['card'], 文字冒险: ['visual-novel'], 生存: ['survival'],
  寻路: ['pathfinding', 'navigation'], 相机跟随: ['camera', 'follow'],
}

export const GAMEDEV_STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'on', 'with', 'use', 'when', 'this',
  'that', 'is', 'are', 'it', 'its', 'from', 'by', 'as', 'at', 'be', 'your', 'you', 'their', 'they',
  'not', 'but', 'all', 'any', 'only', 'also', 'into', 'before', 'after', 'so', 'if', 'than', 'then',
  'more', 'most', 'such', 'which', 'what', 'how',
])

export const GAMEDEV_INDEX = 'INDEX.json'
export const GAMEDEV_NO_MATCH_TEXT = '无相关技能'
export const GAMEDEV_MISSING_PREFIX = '技能库未安装：'
/** 命中的第一条摘要截断长度（find.mjs 是 240，这里收紧一点，省 token）。 */
export const GAMEDEV_DESC_CHARS = 200
export const GAMEDEV_DEFAULT_LIMIT = 5

/**
 * 读技能库索引。找不到 / 读不动 / JSON 坏 → `{ ok:false, text }`，调用方只需贴 text。
 * 不抛错：§4「检索失败一律降级」。
 */
export function loadGamedevIndex(dir) {
  const indexPath = join(String(dir ?? ''), GAMEDEV_INDEX)
  try {
    if (!dir || !existsSync(indexPath)) return { ok: false, kind: 'missing', indexPath, text: `${GAMEDEV_MISSING_PREFIX}${dir ?? ''}` }
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
    if (!Array.isArray(parsed)) return { ok: false, kind: 'broken', indexPath, text: `${GAMEDEV_MISSING_PREFIX}${dir}（INDEX.json 不是数组）` }
    // 只留检索要用的四个字段，顺手挡掉缺字段的坏条目。
    const entries = parsed
      .filter((s) => s && typeof s.name === 'string' && s.name)
      .map((s) => ({
        name: s.name,
        group: typeof s.group === 'string' ? s.group : '',
        desc: typeof s.desc === 'string' ? s.desc : '',
        path: typeof s.path === 'string' ? s.path : '',
      }))
    return { ok: true, kind: 'ok', indexPath, entries }
  } catch (error) {
    return { ok: false, kind: 'broken', indexPath, text: `${GAMEDEV_MISSING_PREFIX}${dir}（${String(error?.message ?? error)}）` }
  }
}

/** 查询词 → 检索词数组（与 find.mjs 同一口径：小写、切词、中文扩词、去停用词）。 */
export function gamedevTerms(query) {
  const lower = String(query ?? '').toLowerCase()
  let terms = lower.replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').split(/\s+/).filter(Boolean)
  for (const t of [...terms]) if (GAMEDEV_ZH[t]) terms = terms.concat(GAMEDEV_ZH[t])
  return [...new Set(terms.filter((t) => !GAMEDEV_STOP.has(t)))]
}

/**
 * 打分排序。与 find.mjs 逐字同口径：name 命中 +6，desc 每命中一次 +1（封顶 3）。
 * 返回 `[{ name, group, desc, path, score, hits }]`，score 为 0 的不返回。
 */
export function scoreGamedev(entries, query) {
  const terms = gamedevTerms(query)
  if (terms.length === 0) return []
  const scored = []
  for (const s of entries ?? []) {
    const name = s.name.toLowerCase()
    const desc = s.desc.toLowerCase()
    let score = 0
    const hits = []
    for (const t of terms) {
      let v = 0
      if (name.includes(t)) v += 6
      const re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      const n = (desc.match(re) || []).length
      if (n) v += Math.min(n, 3)
      if (v) { score += v; hits.push(t) }
    }
    if (score > 0) scored.push({ ...s, score, hits })
  }
  // 同分按名字排，保证输出稳定（find.mjs 靠 V8 稳定排序，这里写死）。
  scored.sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
  return scored
}

/**
 * 能力层入口：`source:'gamedev'` 时把技能库查成一屏文本。
 * 返回 `{ ok, text, count }`；不抛错。
 */
export function searchGamedev(query, { dir, limit = GAMEDEV_DEFAULT_LIMIT } = {}) {
  const loaded = loadGamedevIndex(dir)
  if (!loaded.ok) return { ok: true, text: loaded.text, count: 0, kind: loaded.kind }
  const q = String(query ?? '').trim()
  if (!q) return { ok: true, text: `${GAMEDEV_NO_MATCH_TEXT}（query 为空）`, count: 0, kind: 'empty-query' }
  const matched = scoreGamedev(loaded.entries, q)
  if (matched.length === 0) {
    return { ok: true, text: `${GAMEDEV_NO_MATCH_TEXT}\n可以换英文关键词（如 save / behavior tree），或用 glob 查 ${join(String(dir ?? ''), '**', 'SKILL.md')}`, count: 0, kind: 'no-match' }
  }
  const n = Math.min(Math.max(Number(limit) || GAMEDEV_DEFAULT_LIMIT, 1), GAMEDEV_DEFAULT_LIMIT)
  const lines = [`【soul_capabilities · gamedev】${q}`]
  for (const s of matched.slice(0, n)) {
    lines.push(`== ${s.name}  [${s.group}]  score=${s.score}`)
    // desc 在 INDEX.json 里带换行；压成一行，超长加省略号（只给「一句话」，正文自己按路径开）。
    const flat = s.desc.replace(/\s+/g, ' ').trim()
    lines.push(flat.length > GAMEDEV_DESC_CHARS ? `${flat.slice(0, GAMEDEV_DESC_CHARS)}…` : flat)
    lines.push(s.path)
  }
  return { ok: true, text: lines.join('\n'), count: Math.min(n, matched.length), kind: 'ok' }
}

export default {
  GAMEDEV_ZH,
  GAMEDEV_STOP,
  GAMEDEV_NO_MATCH_TEXT,
  GAMEDEV_MISSING_PREFIX,
  loadGamedevIndex,
  gamedevTerms,
  scoreGamedev,
  searchGamedev,
}
