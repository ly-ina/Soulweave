/**
 * unstable.mjs —— 不承诺的内部面：core/ + memory/ + io.mjs 的全部导出，减去 sdk.mjs 的承诺面。
 *
 * 这里任何名字都可能在没有主版本号变更的情况下改签名、改名或删掉。
 * 外部消费者请用 ./sdk（稳定契约）；确实需要更深的能力，直接 import 具体模块。
 */
import { estimateTokens } from './core/text.mjs'
export { estimateTokens }

import { ALIAS_TO_STANDARD, MEMORY_SECTION, ROUTER_SAFETY, SOUL_SECTION_CAP, DEFAULT_SOUL_STABLE_TOKENS, SOUL_STATE_MAX_CHARS, DEFAULT_SOUL_STATE_TOKENS, MESSAGE_KIND, SOUL_SECTIONS, SECTION_ALIASES, FEEDBACK_SECTION, FEEDBACK_ALIASES, SOUL_TOKEN_CEILING, DEFAULT_SOUL_WARN_TOKENS, HARD_SOUL_TOKENS, TOTAL_TOKENS, DEFAULT_SOUL_TOKENS, RECALL_MAX_CHARS, MEMORY_LEVELS, MEMORY_HEAD_LIMIT, INJECTION_CLASSES, YIELD_ORDER, HINTS } from './core/constants.mjs'
export { ALIAS_TO_STANDARD, MEMORY_SECTION, ROUTER_SAFETY, SOUL_SECTION_CAP, DEFAULT_SOUL_STABLE_TOKENS, SOUL_STATE_MAX_CHARS, DEFAULT_SOUL_STATE_TOKENS, MESSAGE_KIND, SOUL_SECTIONS, SECTION_ALIASES, FEEDBACK_SECTION, FEEDBACK_ALIASES, SOUL_TOKEN_CEILING, DEFAULT_SOUL_WARN_TOKENS, HARD_SOUL_TOKENS, TOTAL_TOKENS, DEFAULT_SOUL_TOKENS, RECALL_MAX_CHARS, MEMORY_LEVELS, MEMORY_HEAD_LIMIT, INJECTION_CLASSES, YIELD_ORDER, HINTS }

import { PLUGIN_DIR } from './core/text.mjs'
export { PLUGIN_DIR }

import { MOOD_MAX_CHARS, RELATIONS_CAP, appendRelation, normalizeConfig, profilePatchPaths, readMood, readRelations, readRouterLines, writeMood } from './core/config.mjs'
export { MOOD_MAX_CHARS, RELATIONS_CAP, appendRelation, normalizeConfig, profilePatchPaths, readMood, readRelations, readRouterLines, writeMood }

import { EMPTY_SOUL, parseSoul, readSoul, readSoulSources, SOUL_STAGES, decideReload, composeSoul, composeSoulStable, planSoulSplit } from './core/soul.mjs'
export { parseSoul, readSoul, readSoulSources, SOUL_STAGES, decideReload, composeSoul, composeSoulStable, planSoulSplit }

// memory 层公开面（0.5.0 起）：SDK 与外部宿主据此接路由，不必钻内部目录。
// memprobe 这类插件要落库，走 import { routeRecords } from 'soulweave' 即可。
export { cnNum, DEFAULT_HOUR } from './memory/time.mjs'

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
