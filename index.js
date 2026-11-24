/**
 * dsh-soulweave —— 入口薄壳：只做装配与公共导出。
 *
 * 分层：core/（零宿主依赖）· memory/（存储与检索）· adapters/dsh/（宿主耦合）。
 * 单包多入口，零构建：`.` / `./core` / `./memory` / `./client`。
 */

export const name = 'soulweave'

/** §9.4：需要动 `ctx.tools` 就必须经 inject 声明。 */
export const inject = ['tools', 'webServer']

import { estimateTokens } from './core/text.mjs'
export { estimateTokens }

import { ALIAS_TO_STANDARD, MEMORY_SECTION, ROUTER_SAFETY, SOUL_SECTION_CAP, DEFAULT_SOUL_STABLE_TOKENS, SOUL_STATE_MAX_CHARS, DEFAULT_SOUL_STATE_TOKENS, MESSAGE_KIND, SOUL_SECTIONS, SECTION_ALIASES, FEEDBACK_SECTION, FEEDBACK_ALIASES, SOUL_TOKEN_CEILING, DEFAULT_SOUL_WARN_TOKENS, HARD_SOUL_TOKENS, TOTAL_TOKENS, DEFAULT_SOUL_TOKENS, RECALL_MAX_CHARS, MEMORY_LEVELS, MEMORY_HEAD_LIMIT, INJECTION_CLASSES, YIELD_ORDER, HINTS } from './core/constants.mjs'
export { ALIAS_TO_STANDARD, MEMORY_SECTION, ROUTER_SAFETY, SOUL_SECTION_CAP, DEFAULT_SOUL_STABLE_TOKENS, SOUL_STATE_MAX_CHARS, DEFAULT_SOUL_STATE_TOKENS, MESSAGE_KIND, SOUL_SECTIONS, SECTION_ALIASES, FEEDBACK_SECTION, FEEDBACK_ALIASES, SOUL_TOKEN_CEILING, DEFAULT_SOUL_WARN_TOKENS, HARD_SOUL_TOKENS, TOTAL_TOKENS, DEFAULT_SOUL_TOKENS, RECALL_MAX_CHARS, MEMORY_LEVELS, MEMORY_HEAD_LIMIT, INJECTION_CLASSES, YIELD_ORDER, HINTS }

import { PLUGIN_DIR } from './core/text.mjs'
export { PLUGIN_DIR }

import { MOOD_MAX_CHARS, RELATIONS_CAP, normalizeConfig, profilePatchPaths, readMood, readRelations, readRouterLines } from './core/config.mjs'
export { MOOD_MAX_CHARS, RELATIONS_CAP, normalizeConfig, profilePatchPaths, readMood, readRelations, readRouterLines }

import { EMPTY_SOUL, parseSoul, readSoul, readSoulSources, SOUL_STAGES, decideReload, composeSoul, composeSoulStable, composeSoulState, planSoulSplit } from './core/soul.mjs'
export { parseSoul, readSoul, readSoulSources, SOUL_STAGES, decideReload, composeSoul, composeSoulStable, composeSoulState, planSoulSplit }

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

import { createPreStepHandler } from './adapters/dsh/prestep.mjs'
export { createPreStepHandler }

import { createMemoryBackend, searchMemory, searchMemoryByCue, wordsOf, hitAll, snippetAround, searchMemoryMeow, scoreOf } from './core/search.mjs'
export { createMemoryBackend, searchMemory, searchMemoryByCue }

import { resolveSealedModule, createArchiveSearch, walkMarkdown, readRulesIndex, searchRules, searchNotes, searchIndexSource, createRecallSources, createRecall, createPersist, resetIndexCircuit, indexCircuitState } from './core/recall.mjs'
export { resolveSealedModule, createArchiveSearch, walkMarkdown, readRulesIndex, searchRules, searchNotes, searchIndexSource, createRecallSources, createRecall, createPersist, resetIndexCircuit, indexCircuitState }

import { apply, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools } from './adapters/dsh/apply.mjs'
export { apply, createCapabilities, createSoulIndexSyncTrigger, createTier, createTools }

export default { name, inject, apply, MESSAGE_KIND }

export { configureIo, resetIo, ioStatus } from './io.mjs'
export { guardTool, sanitizeArgs, isRecord } from './core/validate.mjs'

