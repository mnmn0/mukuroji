import {
  AGENT_RUN_RUNTIMES,
  AGENT_TOOL_KINDS,
  type AgentModelUsage,
  type AgentRunActivity,
  type AgentToolActivity,
  type AgentWaitActivity,
  type FactoryAnalyticsActivity,
  type FactoryAnalyticsComparison,
  type FactoryAnalyticsComparisonAxis,
  type FactoryAnalyticsComparisonGroup,
  type FactoryAnalyticsComparisonModel,
  type FactoryAnalyticsComparisonOutlier,
} from '@mukuroji/contracts'
import { isNonnegativeSafeInteger, isRecord } from '../../shared/api/jsonValidation'

/**
 * Checks for a finite, non-negative number.
 *
 * @param value - Untrusted value.
 * @returns True for a finite number of 0 or more.
 */
function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Reads every entry of an array with one reader, failing when any entry is malformed.
 *
 * @param value - Untrusted value.
 * @param read - Entry reader.
 * @returns The entries, or undefined when the value is not an array or an entry is malformed.
 */
function readList<T>(value: unknown, read: (entry: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries: T[] = []
  for (const entry of value) {
    const parsed = read(entry)
    if (parsed === undefined) return undefined
    entries.push(parsed)
  }
  return entries
}

/**
 * Reads one model's totals of a usage summary.
 *
 * @param value - Untrusted value.
 * @returns The totals, or undefined when malformed.
 */
export function readAgentModelUsage(value: unknown): AgentModelUsage | undefined {
  if (!isRecord(value)) return undefined
  const { model, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, requestCount, aiDurationMs, estimatedCostMicroUsd } = value
  if (
    typeof model !== 'string' ||
    !isNonnegativeSafeInteger(inputTokens) || !isNonnegativeSafeInteger(outputTokens) ||
    !isNonnegativeSafeInteger(cacheReadTokens) || !isNonnegativeSafeInteger(cacheCreationTokens) ||
    !isNonnegativeSafeInteger(requestCount) || !isNonnegativeSafeInteger(aiDurationMs) ||
    (estimatedCostMicroUsd !== undefined && !isNonnegativeSafeInteger(estimatedCostMicroUsd))
  ) {
    return undefined
  }
  return {
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    requestCount,
    aiDurationMs,
    ...(estimatedCostMicroUsd === undefined ? {} : { estimatedCostMicroUsd }),
  }
}

/**
 * Reads the request time and per-model totals of a usage summary. A server that predates them
 * sends neither, which reads as no request time and no model breakdown.
 *
 * @param value - Untrusted usage object.
 * @returns The fields, or undefined when either is present and malformed.
 */
export function readAgentUsageTiming(value: Record<string, unknown>): { aiDurationMs: number; byModel: AgentModelUsage[] } | undefined {
  const aiDurationMs = value.aiDurationMs === undefined ? 0 : value.aiDurationMs
  const byModel = value.byModel === undefined ? [] : readList(value.byModel, readAgentModelUsage)
  if (!isNonnegativeSafeInteger(aiDurationMs) || byModel === undefined) return undefined
  return { aiDurationMs, byModel }
}

/**
 * Reads one tool's time.
 *
 * @param value - Untrusted value.
 * @returns The tool, or undefined when malformed.
 */
function readToolActivity(value: unknown): AgentToolActivity | undefined {
  if (!isRecord(value)) return undefined
  const kind = AGENT_TOOL_KINDS.find((candidate) => candidate === value.kind)
  const { name, count, durationMs, failureCount } = value
  if (
    kind === undefined || typeof name !== 'string' || !isNonnegativeSafeInteger(count) ||
    !isNonnegativeSafeInteger(durationMs) || !isNonnegativeSafeInteger(failureCount)
  ) {
    return undefined
  }
  return { kind, name, count, durationMs, failureCount }
}

/**
 * Reads one kind of wait.
 *
 * @param value - Untrusted value.
 * @returns The wait, or undefined when malformed.
 */
function readWaitActivity(value: unknown): AgentWaitActivity | undefined {
  if (!isRecord(value) || !isNonnegativeSafeInteger(value.count) || !isNonnegativeSafeInteger(value.durationMs)) return undefined
  return { count: value.count, durationMs: value.durationMs }
}

/**
 * Reads the tool time and waits attributed to a run or a Work Item.
 *
 * @param value - Untrusted value.
 * @returns The activity, or undefined when malformed.
 */
export function readAgentRunActivity(value: unknown): AgentRunActivity | undefined {
  if (!isRecord(value)) return undefined
  const tools = readList(value.tools, readToolActivity)
  const approvalWait = readWaitActivity(value.approvalWait)
  const promptWait = readWaitActivity(value.promptWait)
  const { toolCount, toolDurationMs, toolFailureCount, hasMore } = value
  if (
    !tools || !approvalWait || !promptWait || typeof hasMore !== 'boolean' ||
    !isNonnegativeSafeInteger(toolCount) || !isNonnegativeSafeInteger(toolDurationMs) || !isNonnegativeSafeInteger(toolFailureCount)
  ) {
    return undefined
  }
  return { toolCount, toolDurationMs, toolFailureCount, tools, approvalWait, promptWait, hasMore }
}

/**
 * Reads the time summary of a Factory analytics response.
 *
 * @param value - Untrusted value.
 * @returns The summary, or undefined when malformed.
 */
export function readFactoryAnalyticsActivity(value: unknown): FactoryAnalyticsActivity | undefined {
  if (!isRecord(value)) return undefined
  const total = readAgentRunActivity(value.total)
  const topTools = readList(value.topTools, readToolActivity)
  const { aiDurationMs, agentWorkShare, runsHasMore } = value
  if (
    !total || !topTools || !isNonnegativeSafeInteger(aiDurationMs) || typeof runsHasMore !== 'boolean' ||
    (agentWorkShare !== null && !isNonNegativeNumber(agentWorkShare))
  ) {
    return undefined
  }
  return { aiDurationMs, total, topTools, agentWorkShare, runsHasMore }
}

/**
 * Reads a comparison axis.
 *
 * @param value - Untrusted value.
 * @returns The axis, or undefined when malformed.
 */
function readComparisonAxis(value: unknown): FactoryAnalyticsComparisonAxis | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'size') return { kind: 'size' }
  if (value.kind === 'custom-field' && typeof value.customFieldId === 'string') return { kind: 'custom-field', customFieldId: value.customFieldId }
  return undefined
}

/**
 * Reads one model's share of a comparison group.
 *
 * @param value - Untrusted value.
 * @returns The model share, or undefined when malformed.
 */
function readComparisonModel(value: unknown): FactoryAnalyticsComparisonModel | undefined {
  if (!isRecord(value)) return undefined
  const { model, workItemCount, medianTokens, medianAiDurationMs } = value
  if (
    typeof model !== 'string' || !isNonnegativeSafeInteger(workItemCount) ||
    !isNonnegativeSafeInteger(medianTokens) || !isNonnegativeSafeInteger(medianAiDurationMs)
  ) {
    return undefined
  }
  return { model, workItemCount, medianTokens, medianAiDurationMs }
}

/**
 * Reads one comparison group.
 *
 * @param value - Untrusted value.
 * @returns The group, or undefined when malformed.
 */
function readComparisonGroup(value: unknown): FactoryAnalyticsComparisonGroup | undefined {
  if (!isRecord(value)) return undefined
  const models = readList(value.models, readComparisonModel)
  const { workItemTypeId, workItemCount, medianRunMinutes, medianTokens, medianCostMicroUsd, missingValue } = value
  if (
    !models || typeof value.value !== 'string' || (missingValue !== undefined && missingValue !== true) || (workItemTypeId !== undefined && typeof workItemTypeId !== 'string') ||
    !isNonnegativeSafeInteger(workItemCount) || !isNonNegativeNumber(medianRunMinutes) || !isNonnegativeSafeInteger(medianTokens) ||
    (medianCostMicroUsd !== undefined && !isNonnegativeSafeInteger(medianCostMicroUsd))
  ) {
    return undefined
  }
  return {
    ...(workItemTypeId === undefined ? {} : { workItemTypeId }),
    value: value.value,
    ...(missingValue === true ? { missingValue } : {}),
    workItemCount,
    medianRunMinutes,
    medianTokens,
    ...(medianCostMicroUsd === undefined ? {} : { medianCostMicroUsd }),
    models,
  }
}

/**
 * Reads one outlier.
 *
 * @param value - Untrusted value.
 * @returns The outlier, or undefined when malformed.
 */
function readComparisonOutlier(value: unknown): FactoryAnalyticsComparisonOutlier | undefined {
  if (!isRecord(value)) return undefined
  const {
    workItemId, title, projectId, workItemTypeId, runMinutes, aiDurationMs, toolDurationMs, waitDurationMs,
    tokens, estimatedCostMicroUsd, ratio, models, runtimes, assigneeUserId, runCount, reworkRuns,
  } = value
  const runtimeList = readList(runtimes, (entry) => AGENT_RUN_RUNTIMES.find((runtime) => runtime === entry))
  const modelList = readList(models, (entry) => typeof entry === 'string' ? entry : undefined)
  if (
    typeof workItemId !== 'string' || typeof title !== 'string' || typeof value.value !== 'string' ||
    (projectId !== undefined && typeof projectId !== 'string') || (workItemTypeId !== undefined && typeof workItemTypeId !== 'string') ||
    !isNonNegativeNumber(runMinutes) || !isNonnegativeSafeInteger(aiDurationMs) || !isNonnegativeSafeInteger(toolDurationMs) ||
    !isNonnegativeSafeInteger(waitDurationMs) || !isNonnegativeSafeInteger(tokens) || !isNonNegativeNumber(ratio) ||
    (estimatedCostMicroUsd !== undefined && !isNonnegativeSafeInteger(estimatedCostMicroUsd)) ||
    !runtimeList || !modelList || typeof assigneeUserId !== 'string' ||
    !isNonnegativeSafeInteger(runCount) || !isNonnegativeSafeInteger(reworkRuns)
  ) {
    return undefined
  }
  return {
    workItemId,
    title,
    ...(projectId === undefined ? {} : { projectId }),
    ...(workItemTypeId === undefined ? {} : { workItemTypeId }),
    value: value.value,
    runMinutes,
    aiDurationMs,
    toolDurationMs,
    waitDurationMs,
    tokens,
    ...(estimatedCostMicroUsd === undefined ? {} : { estimatedCostMicroUsd }),
    ratio,
    models: modelList,
    runtimes: runtimeList,
    assigneeUserId,
    runCount,
    reworkRuns,
  }
}

/**
 * Reads the comparison of a Factory analytics response.
 *
 * @param value - Untrusted value.
 * @returns The comparison, or undefined when malformed.
 */
export function readFactoryAnalyticsComparison(value: unknown): FactoryAnalyticsComparison | undefined {
  if (!isRecord(value)) return undefined
  const axis = readComparisonAxis(value.axis)
  const groups = readList(value.groups, readComparisonGroup)
  const outliers = readList(value.outliers, readComparisonOutlier)
  if (!axis || !groups || !outliers || !isNonnegativeSafeInteger(value.unsizedWorkItems)) return undefined
  return { axis, groups, outliers, unsizedWorkItems: value.unsizedWorkItems }
}
