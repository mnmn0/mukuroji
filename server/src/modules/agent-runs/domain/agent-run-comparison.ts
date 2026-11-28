import {
  AGENT_RUN_RUNTIMES,
  FACTORY_ANALYTICS_ACTIVITY_TOP_TOOLS,
  FACTORY_ANALYTICS_MAX_COMPARISON_GROUPS,
  FACTORY_ANALYTICS_MAX_OUTLIERS,
  FACTORY_ANALYTICS_OUTLIER_MIN_GROUP_SIZE,
  FACTORY_ANALYTICS_OUTLIER_RATIO,
  type AgentRunActivity,
  type AgentRunRuntime,
  type AgentRunUsage,
  type FactoryAnalyticsActivity,
  type FactoryAnalyticsComparison,
  type FactoryAnalyticsComparisonAxis,
  type FactoryAnalyticsComparisonGroup,
  type FactoryAnalyticsComparisonModel,
  type FactoryAnalyticsComparisonOutlier,
} from '@mukuroji/contracts'
import { combineAgentRunActivity } from './agent-run-activity'
import { combineAgentRunUsage } from './agent-run-usage'

/** One counted run of a Work Item in the comparison. */
export type AgentRunComparisonRun = {
  /** Runtime of the run. */
  runtime: AgentRunRuntime
  /** Member responsible when the run started. */
  assigneeUserId: string
  /** Run start. */
  startedAt: string
  /** Run finish. */
  finishedAt: string
  /** Whether the run started after a `failed` or `completed` run of the same Work Item. */
  rework: boolean
  /** Usage of the run, when telemetry arrived. */
  usage?: AgentRunUsage
  /** Activity of the run, when telemetry arrived. */
  activity?: AgentRunActivity
}

/** A Work Item and its counted runs, as the comparison reads them. */
export type AgentRunComparisonEntry = {
  /** Work Item ID. */
  workItemId: string
  /** Work Item title. */
  title: string
  /** Project of the Work Item, when it has one. */
  projectId?: string
  /** Work Item type, when it has one. */
  workItemTypeId?: string
  /** Value on the comparison axis; absent when the Work Item has no estimate or no value in the custom field. */
  value?: string
  /** Counted runs, oldest start first. */
  runs: AgentRunComparisonRun[]
}

/**
 * Returns the median of a list of numbers.
 *
 * @param values - Numbers.
 * @returns The median, or 0 for an empty list.
 */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  return value ?? 0
}

/**
 * Total tokens of a usage summary.
 *
 * @param usage - Usage, when present.
 * @returns Input, output, and cache tokens added together.
 */
function totalTokens(usage: Pick<AgentRunUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'> | undefined): number {
  return usage === undefined ? 0 : usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
}

/**
 * Rounds a number to one decimal place for a response.
 *
 * @param value - Number.
 * @returns The rounded number.
 */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** Totals of one Work Item in the comparison. */
type WorkItemTotals = {
  /** Entry. */
  entry: AgentRunComparisonEntry
  /** Minutes the runs lasted. */
  runMinutes: number
  /** Combined usage. */
  usage?: AgentRunUsage
  /** Combined activity. */
  activity?: AgentRunActivity
  /** Tokens. */
  tokens: number
}

/**
 * Adds up the runs of one Work Item.
 *
 * @param entry - Work Item and its runs.
 * @returns Totals.
 */
function totalsOf(entry: AgentRunComparisonEntry): WorkItemTotals {
  const runMinutes = entry.runs.reduce((sum, run) => {
    const minutes = (Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 60_000
    return sum + (Number.isFinite(minutes) && minutes > 0 ? minutes : 0)
  }, 0)
  const usage = combineAgentRunUsage(entry.runs.map((run) => run.usage))
  const activity = combineAgentRunActivity(entry.runs.map((run) => run.activity))
  return { entry, runMinutes, ...(usage ? { usage } : {}), ...(activity ? { activity } : {}), tokens: totalTokens(usage) }
}

/**
 * Lists the models of a group with their median tokens and request time per Work Item that used them.
 *
 * @param totals - Work Items of the group.
 * @returns Models, most Work Items first, then by name.
 */
function groupModels(totals: readonly WorkItemTotals[]): FactoryAnalyticsComparisonModel[] {
  const models = new Map<string, { tokens: number[]; durations: number[] }>()
  for (const item of totals) {
    for (const model of item.usage?.byModel ?? []) {
      const saved = models.get(model.model) ?? { tokens: [], durations: [] }
      saved.tokens.push(totalTokens(model))
      saved.durations.push(model.aiDurationMs)
      models.set(model.model, saved)
    }
  }
  return [...models.entries()]
    .map(([model, values]) => ({
      model,
      workItemCount: values.tokens.length,
      medianTokens: Math.round(median(values.tokens)),
      medianAiDurationMs: Math.round(median(values.durations)),
    }))
    .sort((left, right) => right.workItemCount - left.workItemCount || (left.model < right.model ? -1 : left.model > right.model ? 1 : 0))
}

/**
 * Compares Work Items with the others of the same type and axis value (ADR 0117). A Work Item is an
 * outlier when its run minutes or tokens reach {@link FACTORY_ANALYTICS_OUTLIER_RATIO} times the
 * median of a group of at least {@link FACTORY_ANALYTICS_OUTLIER_MIN_GROUP_SIZE} Work Items.
 * Work Items without a value form their own `none` group and are counted, not compared.
 *
 * @param axis - Comparison axis.
 * @param entries - Work Items with counted runs.
 * @param includeCost - Whether the viewer may see the estimated cost.
 * @returns The comparison, or undefined when no Work Item has usage or activity.
 */
export function compareFactoryWorkItems(
  axis: FactoryAnalyticsComparisonAxis,
  entries: readonly AgentRunComparisonEntry[],
  includeCost: boolean,
): FactoryAnalyticsComparison | undefined {
  const totals = entries
    .filter((entry) => entry.runs.some((run) => run.usage !== undefined || run.activity !== undefined))
    .map(totalsOf)
  if (totals.length === 0) return undefined
  const groups = new Map<string, WorkItemTotals[]>()
  for (const item of totals) {
    // A missing value keys apart from every real value, including an option whose ID is `none`.
    const key = `${item.entry.workItemTypeId ?? ''}\u0000${item.entry.value === undefined ? '\u0000' : `=${item.entry.value}`}`
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }
  const groupResults: FactoryAnalyticsComparisonGroup[] = []
  const outliers: FactoryAnalyticsComparisonOutlier[] = []
  for (const items of groups.values()) {
    const first = items[0]
    if (!first) continue
    const medianRunMinutes = median(items.map((item) => item.runMinutes))
    const medianTokens = median(items.map((item) => item.tokens))
    groupResults.push({
      ...(first.entry.workItemTypeId === undefined ? {} : { workItemTypeId: first.entry.workItemTypeId }),
      value: first.entry.value ?? 'none',
      ...(first.entry.value === undefined ? { missingValue: true } : {}),
      workItemCount: items.length,
      medianRunMinutes: round1(medianRunMinutes),
      medianTokens: Math.round(medianTokens),
      ...(includeCost ? { medianCostMicroUsd: Math.round(median(items.map((item) => item.usage?.estimatedCostMicroUsd ?? 0))) } : {}),
      models: groupModels(items),
    })
    const groupValue = first.entry.value
    if (groupValue === undefined || items.length < FACTORY_ANALYTICS_OUTLIER_MIN_GROUP_SIZE) continue
    for (const item of items) {
      const minutesRatio = medianRunMinutes > 0 ? item.runMinutes / medianRunMinutes : 0
      const tokensRatio = medianTokens > 0 ? item.tokens / medianTokens : 0
      const ratio = Math.max(minutesRatio, tokensRatio)
      if (ratio < FACTORY_ANALYTICS_OUTLIER_RATIO) continue
      const newest = item.entry.runs.reduce((latest, run) => run.startedAt > latest.startedAt ? run : latest, item.entry.runs[0] ?? { assigneeUserId: '', startedAt: '' })
      const runtimes = new Set(item.entry.runs.map((run) => run.runtime))
      outliers.push({
        workItemId: item.entry.workItemId,
        title: item.entry.title,
        ...(item.entry.projectId === undefined ? {} : { projectId: item.entry.projectId }),
        ...(item.entry.workItemTypeId === undefined ? {} : { workItemTypeId: item.entry.workItemTypeId }),
        value: groupValue,
        runMinutes: round1(item.runMinutes),
        aiDurationMs: item.usage?.aiDurationMs ?? 0,
        toolDurationMs: item.activity?.toolDurationMs ?? 0,
        waitDurationMs: (item.activity?.approvalWait.durationMs ?? 0) + (item.activity?.promptWait.durationMs ?? 0),
        tokens: item.tokens,
        ...(includeCost && item.usage?.estimatedCostMicroUsd !== undefined ? { estimatedCostMicroUsd: item.usage.estimatedCostMicroUsd } : {}),
        ratio: round1(ratio),
        models: item.usage?.models ?? [],
        runtimes: AGENT_RUN_RUNTIMES.filter((runtime) => runtimes.has(runtime)),
        assigneeUserId: newest.assigneeUserId,
        runCount: item.entry.runs.length,
        reworkRuns: item.entry.runs.filter((run) => run.rework).length,
      })
    }
  }
  return {
    axis,
    groups: groupResults
      .sort((left, right) =>
        right.workItemCount - left.workItemCount ||
        (left.workItemTypeId ?? '').localeCompare(right.workItemTypeId ?? '') ||
        left.value.localeCompare(right.value))
      .slice(0, FACTORY_ANALYTICS_MAX_COMPARISON_GROUPS),
    outliers: outliers
      .sort((left, right) => right.ratio - left.ratio || left.workItemId.localeCompare(right.workItemId))
      .slice(0, FACTORY_ANALYTICS_MAX_OUTLIERS),
    unsizedWorkItems: totals.filter((item) => item.entry.value === undefined).length,
  }
}

/**
 * Adds up where the period's run time went (ADR 0117).
 *
 * @param usages - Usage of each evaluated run.
 * @param activities - Activity of each evaluated run.
 * @param runsHasMore - Whether runs were left out.
 * @returns The activity summary, or undefined when no run has usage or activity.
 */
export function summarizeFactoryActivity(
  usages: readonly (AgentRunUsage | undefined)[],
  activities: readonly (AgentRunActivity | undefined)[],
  runsHasMore: boolean,
): FactoryAnalyticsActivity | undefined {
  const usage = combineAgentRunUsage(usages)
  const total = combineAgentRunActivity(activities, Number.MAX_SAFE_INTEGER)
  if (usage === undefined && total === undefined) return undefined
  const activity = total ?? {
    toolCount: 0,
    toolDurationMs: 0,
    toolFailureCount: 0,
    tools: [],
    approvalWait: { count: 0, durationMs: 0 },
    promptWait: { count: 0, durationMs: 0 },
    hasMore: false,
  }
  const aiDurationMs = usage?.aiDurationMs ?? 0
  const working = aiDurationMs + activity.toolDurationMs
  const waiting = activity.approvalWait.durationMs + activity.promptWait.durationMs
  return {
    aiDurationMs,
    total: { ...activity, tools: activity.tools.slice(0, FACTORY_ANALYTICS_ACTIVITY_TOP_TOOLS) },
    topTools: activity.tools.slice(0, FACTORY_ANALYTICS_ACTIVITY_TOP_TOOLS),
    agentWorkShare: working + waiting === 0 ? null : round1((working / (working + waiting)) * 100),
    runsHasMore,
  }
}
