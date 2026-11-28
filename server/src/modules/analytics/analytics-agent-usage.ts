import type { AnalyticsMetricKey, AnalyticsQueryInput, AnalyticsSnapshot, AnalyticsWidget } from '@mukuroji/contracts'

/**
 * Telemetry usage of one Agent Run that finished on an authorized Work Item (ADR 0061), as the
 * `agent-tokens` and `agent-cost` metrics read it.
 */
export type AnalyticsAgentUsageRun = {
  /** Agent Run ID. */
  runId: string
  /** Finish instant of the run in epoch milliseconds; the metrics count a run in the bucket it finished in. */
  finishedAt: number
  /** Input, output, prompt cache read, and prompt cache write tokens added together. */
  tokens: number
  /**
   * Estimated cost in millionths of US dollars. Present only when the viewer may see the run's cost
   * and the agent runtime reported a cost.
   */
  estimatedCostMicroUsd?: number
  /**
   * Whether the viewer may see the run's cost (ADR 0111): they administer the Workspace, manage the
   * run's Team or its Work Item's Project, or ran the agent themselves.
   */
  costVisible: boolean
  /** True when the run had more usage than one read returns, so its totals are a lower bound. */
  hasMore: boolean
}

/** Agent Run usage the API read for one Analytics run, under the viewer's current access. */
export type AnalyticsAgentUsage = {
  /** Runs that finished in the query period, keyed by Team-qualified Work Item key (`teamId\0workItemId`). */
  runs: ReadonlyMap<string, readonly AnalyticsAgentUsageRun[]>
  /**
   * Keys of whose estimated cost the viewer may see (managed Teams and Projects, and their own runs),
   * sorted. Set only when the query has an `agent-cost` widget; the snapshot permission scope fixes it.
   */
  costScopeKeys?: readonly string[]
}

/** Warning of an Agent usage widget computed by a run that cannot read Agent Run usage. */
export const ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING =
  'Agent Run usage is not available for this run.'

/**
 * Most Agent Runs one Analytics query reads usage for. Each run costs two reads (the run and its
 * usage buckets), so a larger period fails with `413` instead of a partial total.
 */
export const MAX_ANALYTICS_AGENT_USAGE_RUNS = 500

/**
 * Returns whether a metric adds up Agent Run telemetry usage.
 *
 * @param metric - Metric key.
 * @returns Whether the metric is `agent-tokens` or `agent-cost`.
 */
export function isAnalyticsAgentUsageMetric(metric: AnalyticsMetricKey): metric is 'agent-tokens' | 'agent-cost' {
  return metric === 'agent-tokens' || metric === 'agent-cost'
}

/**
 * Returns whether a query has a widget that reads Agent Run usage.
 *
 * @param query - Normalized query.
 * @returns Whether the API must read Agent Run usage before computing the snapshot.
 */
export function analyticsQueryReadsAgentUsage(query: Pick<AnalyticsQueryInput, 'widgets'>) {
  return query.widgets.some((widget) => isAnalyticsAgentUsageMetric(widget.metric))
}

/**
 * Returns whether a query has an `agent-cost` widget, whose result depends on the Teams the viewer
 * manages.
 *
 * @param query - Normalized query.
 * @returns Whether the API must read the viewer's managed Teams.
 */
export function analyticsQueryReadsAgentCost(query: Pick<AnalyticsQueryInput, 'widgets'>) {
  return query.widgets.some((widget: Pick<AnalyticsWidget, 'metric'>) => widget.metric === 'agent-cost')
}

/**
 * Returns whether a stored snapshot fixed the Teams whose cost the viewer could see, so its
 * permission check must read them again. A scheduled delivery cannot read Agent Run usage, so its
 * cost widgets carry only the unavailable warning and its hash leaves the Teams out.
 *
 * @param snapshot - Stored snapshot.
 * @returns Whether the permission scope check must include the viewer's managed Teams.
 */
export function analyticsSnapshotReadAgentCost(snapshot: Pick<AnalyticsSnapshot, 'widgets'>) {
  return snapshot.widgets.some((widget) =>
    widget.metric === 'agent-cost' &&
    !widget.warnings.includes(ANALYTICS_AGENT_USAGE_UNAVAILABLE_WARNING)
  )
}
