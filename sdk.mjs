/**
 * sdk.mjs —— 纯 SDK 出口：core/ + memory/ + io.mjs 的公开面。
 *
 * 与 index.js 的区别：这里一个 adapters/dsh/* 都不 import，
 * 所以外部消费者（Node CLI、别的 DSH 插件）import 它不会拉进宿主耦合。
 * 入口写法：`import { routeRecords } from '@ly-ina/dsh-soulweave/sdk'`
 */
/**
 * dsh-soulweave —— 入口薄壳：只做装配与公共导出。
 *
 * 单包多入口，零构建：`.` / `./core` / `./memory` / `./client`。
 */

/** §9.4：需要动 `ctx.tools` 就必须经 inject 声明。 */

import { estimateTokens } from './core/text.mjs'
export { estimateTokens }

import { ALIAS_TO_STANDARD, MEMORY_SECTION, ROUTER_SAFETY, SOUL_SECTION_CAP, DEFAULT_SOUL_STABLE_TOKENS, SOUL_STATE_MAX_CHARS, DEFAULT_SOUL_STATE_TOKENS, MESSAGE_KIND, SOUL_SECTIONS, SECTION_ALIASES, FEEDBACK_SECTION, FEEDBACK_ALIASES, SOUL_TOKEN_CEILING, DEFAULT_SOUL_WARN_TOKENS, HARD_SOUL_TOKENS, TOTAL_TOKENS, DEFAULT_SOUL_TOKENS, RECALL_MAX_CHARS, MEMORY_LEVELS, MEMORY_HEAD_LIMIT, INJECTION_CLASSES, YIELD_ORDER, HINTS } from './core/constants.mjs'
export { ALIAS_TO_STANDARD, MEMORY_SECTION, ROUTER_SAFETY, SOUL_SECTION_CAP, DEFAULT_SOUL_STABLE_TOKENS, SOUL_STATE_MAX_CHARS, DEFAULT_SOUL_STATE_TOKENS, MESSAGE_KIND, SOUL_SECTIONS, SECTION_ALIASES, FEEDBACK_SECTION, FEEDBACK_ALIASES, SOUL_TOKEN_CEILING, DEFAULT_SOUL_WARN_TOKENS, HARD_SOUL_TOKENS, TOTAL_TOKENS, DEFAULT_SOUL_TOKENS, RECALL_MAX_CHARS, MEMORY_LEVELS, MEMORY_HEAD_LIMIT, INJECTION_CLASSES, YIELD_ORDER, HINTS }

import { PLUGIN_DIR } from './core/text.mjs'
export { PLUGIN_DIR }

import { MOOD_MAX_CHARS, RELATIONS_CAP, appendRelation, normalizeConfig, profilePatchPaths, readMood, readRelations, readRouterLines, writeMood } from './core/config.mjs'
export { MOOD_MAX_CHARS, RELATIONS_CAP, appendRelation, normalizeConfig, profilePatchPaths, readMood, readRelations, readRouterLines, writeMood }

import { EMPTY_SOUL, parseSoul, readSoul, readSoulSources, SOUL_STAGES, decideReload, composeSoul, composeSoulStable, composeSoulState, renderDueLine, planSoulSplit } from './core/soul.mjs'
export { parseSoul, readSoul, readSoulSources, SOUL_STAGES, decideReload, composeSoul, composeSoulStable, composeSoulState, renderDueLine, planSoulSplit }

// memory 层公开面（0.5.0 起）：SDK 与外部宿主据此接路由，不必钻内部目录。
// memprobe 这类插件要落库，走 import { routeRecords } from 'soulweave' 即可。
export { routeRecords, renderRouteResult } from './memory/route.mjs'
export { parseDue, cnNum, DEFAULT_HOUR } from './memory/time.mjs'
export { anchorOf, looksLikeAnchor, parseSettle, renderAnchored } from './memory/anchor.mjs'
export { health, renderHealth, isBrokenSearchResult } from './memory/health.mjs'

import { SOUL_STATE_KIND, SOUL_TRIGGER_KIND, SOUL_RECALL_KIND, RECALL_TEXT_MAX_CHARS, pickRecallEntry, renderRecall, resetRecallCooldownOnReload, planStateEmit } from './core/recall-state.mjs'
export { SOUL_STATE_KIND, SOUL_TRIGGER_KIND, SOUL_RECALL_KIND, RECALL_TEXT_MAX_CHARS, pickRecallEntry, renderRecall, resetRecallCooldownOnReload, planStateEmit }

import { soulTargetIndex, classOfKind, measureInjections, SNAPSHOT_MARK, MEOW_KIND, SNAPSHOT_CAPS, snapshotMetaOf, isSnapshotMessage, isConversationMessage, measureRequestBudget, eventsOfSession, countSnapshots, planSnapshotPrune, detectSnapshotDrift, tierStatePath, maybeLogTier, textOfMessage, rememberUserTexts, recentUserQuery, lastUserTexts, planBudget, applyBudgetPlan, countSnapshotEntries, countResidentEntries, loadPendingItems, loadMemoryHeads, loadLessonHead, detectPinnedAnomalies, countPinnedEntries, countSoulNodes, loadCorrectedLessons } from './core/budget.mjs'
export { classOfKind, measureInjections, SNAPSHOT_MARK, MEOW_KIND, SNAPSHOT_CAPS, snapshotMetaOf, isSnapshotMessage, isConversationMessage, measureRequestBudget, eventsOfSession, countSnapshots, planSnapshotPrune, detectSnapshotDrift, tierStatePath, maybeLogTier, textOfMessage, rememberUserTexts, recentUserQuery, lastUserTexts, planBudget, applyBudgetPlan, countSnapshotEntries, countResidentEntries, loadPendingItems, loadMemoryHeads, loadLessonHead, detectPinnedAnomalies, countPinnedEntries, countSoulNodes, loadCorrectedLessons }

import { DREAM_MARKER, isDreamTurn, wordsOfKeywords, pickProbeWords, runProbes, readProbeState, writeProbeState, maybeRunProbe } from './core/probe.mjs'
export { DREAM_MARKER, isDreamTurn, wordsOfKeywords, pickProbeWords, runProbes, readProbeState, writeProbeState, maybeRunProbe }

import { createSoulMessage, resolveWorkspace, zoneRowsOf } from './core/prompt.mjs'
export { createSoulMessage, resolveWorkspace, zoneRowsOf }

import { loadTriggers, selectTriggers, pickTriggerText, resetTriggerCooldownOnReload } from './core/triggers.mjs'
export { loadTriggers, selectTriggers, pickTriggerText, resetTriggerCooldownOnReload }

import { createMemoryBackend, searchMemory, searchMemoryByCue, wordsOf, hitAll, snippetAround, searchMemoryMeow, scoreOf } from './core/search.mjs'
export { createMemoryBackend, searchMemory, searchMemoryByCue }

import { resolveSealedModule, createArchiveSearch, walkMarkdown, readRulesIndex, searchRules, searchNotes, searchIndexSource, createRecallSources, createRecall, createPersist, resetIndexCircuit, indexCircuitState } from './core/recall.mjs'
export { resolveSealedModule, createArchiveSearch, walkMarkdown, readRulesIndex, searchRules, searchNotes, searchIndexSource, createRecallSources, createRecall, createPersist, resetIndexCircuit, indexCircuitState }

export { configureIo, resetIo, ioStatus } from './io.mjs'
export { guardTool, sanitizeArgs, isRecord } from './core/validate.mjs'
