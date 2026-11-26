/**
 * adapters/dsh/records.mjs —— ※记 / ※办 / ※结 记录捕获。
 *
 * 2026-11-26 从独立插件 dsh-memprobe 并入（CHANGELOG 0.8.0）。
 * 纯解析在 core/record-extract.mjs；这里只做宿主耦合：挂监听、写 JSONL、可选落库。
 *
 * 三条硬约束（沿用原插件）：
 *  1. 只追加，不覆盖：`outPath` 是原始 JSONL 日志；`targets` 是可选的定向追加目标。
 *     本模块永不写 soul.md / memory 目录，除非用户把它们配成 target。
 *  2. fail-open：任何异常只 warn，绝不让宿主起不来、也不能打断会话。
 *  3. 不落 reasoning 全文（默认只落诊断行）；需要排查时把 dumpReasoning 打开。
 *
 * 卸载：attachRecords 返回 dispose，会把两个 ctx.on 都摘掉。
 */import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { extractRecords, DEFAULT_TRIGGER } from '../../core/record-extract.mjs'
// 落库走 soulweave 的纯 memory 层（零宿主依赖），不走它的插件入口。
import { routeRecords } from '../../memory/route.mjs'


const DEFAULT_TEMPLATE = '- {date} {text}'

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 本地时区的时间变量（JSONL 里用 ISO，落到人看的文件用本地时间）。 */
function timeVars(ts) {
  const d = new Date(ts)
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
    datetime: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  }
}

/** 只替换已知变量，未知的 `{xxx}` 原样保留（防止误伤正文里的花括号）。 */
function expandTemplate(tpl, vars) {
  return String(tpl).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (m, key) => (key in vars ? String(vars[key] ?? '') : m))
}

export function attachRecords(ctx, config = {}) {
  // 并入魂织后的契约：返回一个 dispose 函数，apply 侧负责推进 disposers。
  // 原 dsh-memprobe 的 ctx.on 返回值没接，卸载不掉；这里统一走 on() 包装。
  // ctx.logger 是工厂函数（apply 侧写的是 ctx.logger?.('soul')），不是对象。
  // 原来这里当对象用，所有 warn/info 都是哑的——并入时修的。
  const logger = typeof ctx.logger === 'function' ? ctx.logger('records') : (ctx.logger ?? console)
  const disposers = []
  const on = (event, handler, opts) => {
    const off = ctx.on(event, handler, opts)
    disposers.push(off)
    return off
  }
  const outPath = config.outPath || ''
  // 渐进接线：只把 recall / todo 落库，※结 等锚点机制验过再开。
  const dbPath = String(config.dbPath ?? '').trim()
  const routeKinds = new Set(
    Array.isArray(config.routeKinds) && config.routeKinds.length > 0
      ? config.routeKinds.map((k) => String(k))
      : ['recall', 'todo'],
  )
  // 三词默认全开（记 / 办 / 结）；只配 trigger 则退化成单触发词兼容模式。
  const extractOptions =
    config.triggers && typeof config.triggers === 'object'
      ? { triggers: config.triggers }
      : config.trigger
        ? { trigger: config.trigger }
        : {}
  const triggerLabel = extractOptions.triggers
    ? Object.values(extractOptions.triggers).join(' / ')
    : extractOptions.trigger || DEFAULT_TRIGGER
  const dumpReasoning = config.dumpReasoning === true
  const targets = Array.isArray(config.targets) ? config.targets.filter((t) => t && t.path) : []
  const seen = new Set()

  try {
    mkdirSync(dirname(outPath), { recursive: true })
  } catch (e) {
    try { logger.warn?.(`memprobe: 输出目录创建失败，插件不启用: ${e?.message ?? e}`) } catch {}
    return
  }

  // ---- 记忆巡检 cue（2026-11-26）----
  // 缘起：三词在自然状态下实测命中 0——不是「不会写」，是「没人给该记了的信号」。
  // 「可以压」能稳定命中，就因为压缩提示是外部 cue。这里把同一个模式搬过来：
  // 只在「会话开场」问一次「有没有值得记的」，只要一个二选一，不要求取证、不查库。
  // 开场 = 新会话首轮，或上下文被压缩后的首轮（后者提醒的是「到下一次压缩之前」）。
  // 不定时、不隔轮：每轮问是监督，隔几轮问也是监督——用户要的是「知道有这回事」，不是被巡查。
  // 关掉：config.cue = false。改文案：config.cue = { text }。限次数：config.cue = { maxTurns: 5 }。
  const cueEnabled = config.cue !== false
  const cueConfig = config.cue && typeof config.cue === 'object' ? config.cue : {}
  const cueText =
    typeof cueConfig.text === 'string' && cueConfig.text.trim()
      ? cueConfig.text
      : '[记忆巡检] 开场一次就够：纳有没有让你记住什么，或者你自己想记住什么？' +
        '\n记的是舍不得忘的，不是明天还用得上的——不记版本号、不记「改成了什么」、不记干了哪些活。' +
        '\n有 → 单独一行，用 `※记` 开头写一句（正文或思考都行），不换行。待办用 `※办` 开头。' +
        '\n没有 → 什么都不写。'
  // 上次看到的上下文条数（-1 = 还没看过）；用来识别「压缩后开场」。
  let cueLastCount = -1
  const cueMaxTurns = Number.isFinite(cueConfig.maxTurns) ? Number(cueConfig.maxTurns) : 0
  const cueMaxChars = Number.isFinite(cueConfig.maxChars) ? Number(cueConfig.maxChars) : 0
  let cueCount = 0

  // 2026-11-26：压缩是原子操作（compaction/start→end 不跨 turn），模型没有插话窗口，
  // 压完只剩摘要。所以不在压缩后追问「上一轮」，改成压缩后提醒一次：
  // 从现在到下一次压缩之间，遇到舍不得忘的就当场记，别等压完再找。
  const cueCompacted =
    '[记忆巡检] 刚刚结束了一次压缩，压缩前的原文已经不在上下文里了。' +
    '\n在下一次压缩之前，遇到舍不得忘的就单独一行 `※记` 开头写下来，不换行。' +
    '\n等压完再回头找，那些话就没了。'
  const buildCue = (compacted) => (compacted ? cueCompacted : cueText)

  /** 注入消息：role=user + source.kind 标记，宿主和日志里都能认出来源。 */
  function cueMessage(text) {
    return {
      id: `memprobe-cue-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'memprobe-cue', form: 'snapshot', sections: [{ name: 'memprobe-cue', text }] },
    }
  }

  function write(row) {
    appendFileSync(outPath, `${JSON.stringify(row)}\n`)
  }

  /** 定向追加：一条记录一行，模板可配；首次写文件时补 header。失败只 warn。 */
  function appendTargets(texts, vars) {
    for (const target of targets) {
      try {
        const abs = String(target.path).trim()
        if (!abs) continue
        mkdirSync(dirname(abs), { recursive: true })
        if (!existsSync(abs) && typeof target.header === 'string' && target.header !== '') {
          const header = target.header.replace(/\n*$/, '\n')
          appendFileSync(abs, header)
        }
        const tpl = typeof target.template === 'string' && target.template !== '' ? target.template : DEFAULT_TEMPLATE
        const body = texts.map((t) => expandTemplate(tpl, { ...vars, text: t })).join('\n')
        appendFileSync(abs, `${body}\n`)
      } catch (e) {
        try { logger.warn?.(`records: 追加到 ${target?.path} 失败（已忽略）: ${e?.message ?? e}`) } catch {}
      }
    }
  }

  // 记忆巡检 cue：每轮第一个 step 注入一次（turn<=1 没有「上一轮」，跳过）。
  // 不拦 next() 之后的 decision；注入失败 fail-open，绝不打断会话。
  if (cueEnabled && typeof ctx.on === 'function') {
    on(
      'agent/pre-step',
      async (payload, next) => {
        const decision = await next()
        try {
          const step = Number(payload?.step ?? 1)
          const turn = Number(payload?.turn ?? 0)
          if (step !== 1) return decision
          if (cueMaxTurns > 0 && cueCount >= cueMaxTurns) return decision
          if (cueMaxChars > 0 && cueText.length > cueMaxChars) return decision
          const msgs = Array.isArray(decision?.messages)
            ? decision.messages
            : Array.isArray(payload?.messages)
              ? payload.messages
              : []
          // 只在会话开场注入：新会话首轮，或上下文被压缩后的首轮。
          // 条数骤降（少 8 条以上）视为压缩；这比猜 turn 编号可靠。
          const compacted = cueLastCount >= 0 && msgs.length + 8 < cueLastCount
          cueLastCount = msgs.length
          if (turn !== 1 && !compacted) return decision
          cueCount++
          const text = buildCue(compacted)
          try {
            write({ ts: new Date().toISOString(), type: 'cue', turn, step, chars: text.length, compacted })
          } catch {}
          return { ...(decision ?? {}), messages: [...msgs, cueMessage(text)] }
        } catch (e) {
          try { logger.warn?.(`records: cue 注入失败（已忽略）: ${e?.message ?? e}`) } catch {}
          return decision
        }
      },
      { prepend: true },
    )
  }

  on('session/event', (session, event) => {
    try {
      if (event?.type !== 'assistant/message') return

      const message = event.data?.message
      const blocks = message?.content
      if (!Array.isArray(blocks)) return

      const sid = session?.id ?? session?.sessionId ?? 'unknown'
      const key = `${sid}:${event.seq ?? '-'}`
      if (seen.has(key)) return
      if (seen.size > 10000) seen.clear()
      seen.add(key)

      // 2026-11-26：正文（text block）也算。纳要的是「看得见的记」——
      // 思考里的记录错了没人纠，正文里的纳当场能看见。reasoning 保留兼容。
      const textSeen = new Set()
      for (const block of blocks) {
        if (block?.type !== 'reasoning' && block?.type !== 'text') continue
        if (typeof block.text !== 'string' || block.text === '') continue
        const r = extractRecords(block.text, extractOptions)
        if (!r.hit) continue
        const dedupeKey = r.records.map((x) => `${x.kind}:${x.text}`).join('\u0001')
        if (textSeen.has(dedupeKey)) continue
        textSeen.add(dedupeKey)

        const ts = event.time ?? Date.now()
        const row = {
          ts: new Date(ts).toISOString(),
          sessionId: String(sid),
          turn: event.data?.turn ?? null,
          step: event.data?.step ?? null,
          seq: event.seq ?? null,
          model: message?.source?.model ?? null,
          from: block.type,
          triggers: r.triggers,
          counts: {
            recall: r.byKind.recall.length,
            todo: r.byKind.todo.length,
            settle: r.byKind.settle.length,
          },
          records: r.records.map((x) => ({ kind: x.kind, text: x.text, line: x.lineIndex + 1 })),
          emptyLines: r.empty,
          leak: { live: r.leak.live, settled: r.leak.settled },
          headLive: r.leak.headLive,
          headSettled: r.leak.headSettled,
          chars: r.chars,
          paragraphs: r.paragraphs,
        }
        if (dumpReasoning) row.reasoning = block.text

        // 渐进接线（2026-11-25）：只开 recall/todo。异常一律吞掉，绝不打断会话。
        if (dbPath !== '' && r.records.length > 0) {
          const routable = r.records.filter((x) => routeKinds.has(x.kind))
          if (routable.length > 0) {
            try {
              const res = routeRecords(
                routable.map((x) => ({ kind: x.kind, text: x.text })),
                { dbPath, now: new Date(ts) },
              )
              row.route = {
                memories: (res.written?.memories ?? []).length,
                todos: (res.written?.todos ?? []).length,
                settled: (res.written?.settled ?? []).length,
                warnings: (res.warnings ?? []).map((w) => ({ kind: w.kind, text: w.text })),
                failed: (res.failed ?? []).length,
              }
              if (row.route.warnings.length > 0) {
                try {
                  logger.warn?.(
                    `memprobe: 落库警告 ${row.route.warnings.map((w) => w.kind).join(',')}`,
                  )
                } catch {}
              }
            } catch (e) {
              row.route = { error: String(e?.message ?? e) }
              try { logger.warn?.(`memprobe: 落库失败（已忽略）: ${e?.message ?? e}`) } catch {}
            }
          }
        }

        write(row)

        if (r.records.length > 0 && targets.length > 0) {
          appendTargets(r.records.map((x) => x.text), {
            ...timeVars(ts),
            turn: row.turn ?? '',
            step: row.step ?? '',
            session: row.sessionId,
            model: row.model ?? '',
            trigger: triggerLabel,
          })
        }

        if (r.leak.live || r.leak.settled) {
          try {
            logger.warn?.(
              `memprobe: 触发词出现在摘要位置上（live=${r.leak.live} settled=${r.leak.settled}），摘要=「${r.leak.live ? r.leak.headLive : r.leak.headSettled}」`
            )
          } catch {}
        }
      }
    } catch (e) {
      try { logger.warn?.(`records: 处理事件异常（已忽略）: ${e?.message ?? e}`) } catch {}
    }
  })

  const targetDesc = targets.length === 0 ? '无（只写 JSONL）' : targets.map((t) => t.path).join(' · ')
  try { logger.info?.(`records: 已挂载，触发词「${triggerLabel}」，日志 ${outPath}，定向 ${targetDesc}`) } catch {}

  return () => {
    for (const off of disposers) try { off?.() } catch {}
  }
}

