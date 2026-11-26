import type {
  AnalyticsGroup,
  AnalyticsMetricKey,
  AnalyticsQueryInput,
  AnalyticsSnapshot,
  AnalyticsTableRow,
  AnalyticsWidget,
} from '@mukuroji/contracts'

/** Earned value metric keys (ADR 0110). */
export type AnalyticsEarnedValueMetric = 'evm-spi' | 'evm-cpi' | 'evm-eac'

/**
 * Earned value figures of one Project in minutes at the query's as-of date, read by the API from
 * the same source as the Project budget report.
 */
export type AnalyticsEarnedValueProject = {
  /** Team that owns the Project. */
  teamId: string
  /** Project ID within the Team. */
  projectId: string
  /** Budget at completion: the planned effort of the active baseline. */
  budgetAtCompletionMinutes: number
  /** Planned value at the as-of date. */
  plannedValueMinutes: number
  /** Earned value: baseline effort times each Work Item's progress when the query ran. */
  earnedValueMinutes: number
  /** Minutes recorded on the Project through the as-of date. */
  actualMinutes: number
}

/** Earned value the API read for one Analytics run, under the viewer's current access. */
export type AnalyticsEarnedValue = {
  /** Measured Projects, the ones the viewer manages that have a baseline with planned effort. */
  projects: readonly AnalyticsEarnedValueProject[]
  /**
   * Team-qualified keys (`teamId\0projectId`) of the Projects in the query scope that the viewer
   * manages, sorted. The snapshot permission scope fixes them.
   */
  managedProjectKeys: readonly string[]
  /** Projects in the query scope that the viewer does not manage and that were left out. */
  unmanagedProjectCount: number
  /** Managed Projects without a baseline that plans any effort. */
  withoutBaselineCount: number
  /**
   * Whether the as-of time is too far in the past to measure. Earned value reads the Work Items'
   * progress when the query runs, so such a run reads no figures.
   */
  asOfTooOld: boolean
}

/** Warning of an earned value widget computed by a run that cannot read earned value. */
export const ANALYTICS_EARNED_VALUE_UNAVAILABLE_WARNING =
  'Earned value is not available for this run.'

/** Warning of an earned value widget whose as-of time is too far in the past. */
export const ANALYTICS_EARNED_VALUE_AS_OF_WARNING =
  'Earned value uses the Work Items\' current progress, so it is measured only when the as-of time is within the last day.'

/** Most Projects one Analytics query measures; a larger scope fails with `413`. */
export const MAX_ANALYTICS_EARNED_VALUE_PROJECTS = 20

/** Longest time before now that an as-of time may be for earned value to be measured. */
export const ANALYTICS_EARNED_VALUE_MAX_AS_OF_AGE_MS = 86_400_000

/**
 * Returns whether a metric is an earned value metric.
 *
 * @param metric - Metric key.
 * @returns Whether the metric is `evm-spi`, `evm-cpi`, or `evm-eac`.
 */
export function isAnalyticsEarnedValueMetric(metric: AnalyticsMetricKey): metric is AnalyticsEarnedValueMetric {
  return metric === 'evm-spi' || metric === 'evm-cpi' || metric === 'evm-eac'
}

/**
 * Returns whether a query has an earned value widget.
 *
 * @param query - Normalized query.
 * @returns Whether the API must read earned value before computing the snapshot.
 */
export function analyticsQueryReadsEarnedValue(query: Pick<AnalyticsQueryInput, 'widgets'>) {
  return query.widgets.some((widget: Pick<AnalyticsWidget, 'metric'>) => isAnalyticsEarnedValueMetric(widget.metric))
}

/**
 * Returns whether a stored snapshot fixed the Projects the viewer managed, so its permission check
 * must read them again. A scheduled delivery cannot read earned value, so its widgets carry only
 * the unavailable warning and its hash leaves the Projects out.
 *
 * @param snapshot - Stored snapshot.
 * @returns Whether the permission scope check must include the managed Projects.
 */
export function analyticsSnapshotReadEarnedValue(snapshot: Pick<AnalyticsSnapshot, 'widgets'>) {
  return snapshot.widgets.some((widget) =>
    isAnalyticsEarnedValueMetric(widget.metric) &&
    !widget.warnings.includes(ANALYTICS_EARNED_VALUE_UNAVAILABLE_WARNING)
  )
}

/**
 * Builds the Team-qualified key of a Project.
 *
 * @param teamId - Team ID.
 * @param projectId - Project ID within the Team.
 * @returns `teamId\0projectId`.
 */
export function createAnalyticsEarnedValueProjectKey(teamId: string, projectId: string) {
  return `${teamId}\0${projectId}`
}

/** The parts of a widget result that an earned value widget computes. */
export type AnalyticsEarnedValueWidgetParts = {
  /** Value of the whole scope. */
  value: number | null
  /** Projects that gave the value. */
  sampleSize: number
  /** Team or Project groups. */
  groups: AnalyticsGroup[]
  /** One row per measured Project for a table widget. */
  rows: AnalyticsTableRow[]
  /** Notes on Projects left out. */
  warnings: string[]
}

/** Summed figures of one or more Projects. */
type EarnedValueTotals = Omit<AnalyticsEarnedValueProject, 'teamId' | 'projectId'>

/**
 * Computes an earned value widget from the Projects the API measured.
 *
 * SPI is earned divided by planned value and CPI earned value divided by actual minutes; a group
 * adds up its Projects' minutes before dividing. EAC is the budget at completion divided by CPI,
 * in hours.
 *
 * @param widget - Earned value widget, grouped by nothing, Team, or Project.
 * @param earnedValue - Earned value the API read.
 * @returns The widget parts.
 */
export function createAnalyticsEarnedValueWidgetParts(
  widget: Pick<AnalyticsWidget, 'type' | 'groupBy'> & { metric: AnalyticsEarnedValueMetric },
  earnedValue: AnalyticsEarnedValue,
): AnalyticsEarnedValueWidgetParts {
  if (earnedValue.asOfTooOld) {
    return { value: null, sampleSize: 0, groups: [], rows: [], warnings: [ANALYTICS_EARNED_VALUE_AS_OF_WARNING] }
  }
  const projects = [...earnedValue.projects].sort((left, right) =>
    left.teamId.localeCompare(right.teamId) || left.projectId.localeCompare(right.projectId))
  const total = calculate(widget.metric, sum(projects))
  const groups: AnalyticsGroup[] = []
  const dimension = widget.groupBy?.dimension
  if (dimension === 'project') {
    for (const project of projects) {
      groups.push({
        key: createAnalyticsEarnedValueProjectKey(project.teamId, project.projectId),
        label: project.projectId,
        value: calculate(widget.metric, project),
        sampleSize: 1,
      })
    }
  } else if (dimension === 'team') {
    const byTeam = new Map<string, AnalyticsEarnedValueProject[]>()
    for (const project of projects) byTeam.set(project.teamId, [...(byTeam.get(project.teamId) ?? []), project])
    for (const [teamId, teamProjects] of byTeam) {
      groups.push({ key: teamId, label: teamId, value: calculate(widget.metric, sum(teamProjects)), sampleSize: teamProjects.length })
    }
  }
  const rows = widget.type === 'table'
    ? projects.map((project): AnalyticsTableRow => ({
        id: createAnalyticsEarnedValueProjectKey(project.teamId, project.projectId),
        label: project.projectId,
        values: {
          teamId: project.teamId,
          projectId: project.projectId,
          budgetAtCompletionHours: toHours(project.budgetAtCompletionMinutes),
          plannedValueHours: toHours(project.plannedValueMinutes),
          earnedValueHours: toHours(project.earnedValueMinutes),
          actualHours: toHours(project.actualMinutes),
          value: calculate(widget.metric, project),
        },
      }))
    : []
  return {
    value: total,
    sampleSize: projects.length,
    groups,
    rows,
    warnings: [
      ...(projects.length === 0 ? ['No Project you manage in this scope has a baseline with planned effort.'] : []),
      ...(earnedValue.unmanagedProjectCount === 0
        ? []
        : [`${earnedValue.unmanagedProjectCount} Project(s) you do not manage were left out of the earned value.`]),
      ...(earnedValue.withoutBaselineCount === 0
        ? []
        : [`${earnedValue.withoutBaselineCount} Project(s) have no baseline with planned effort and were left out.`]),
    ],
  }
}

/**
 * Adds up the figures of several Projects.
 *
 * @param projects - Projects to add up.
 * @returns The totals.
 */
function sum(projects: readonly EarnedValueTotals[]): EarnedValueTotals {
  return projects.reduce<EarnedValueTotals>((totals, project) => ({
    budgetAtCompletionMinutes: totals.budgetAtCompletionMinutes + project.budgetAtCompletionMinutes,
    plannedValueMinutes: totals.plannedValueMinutes + project.plannedValueMinutes,
    earnedValueMinutes: totals.earnedValueMinutes + project.earnedValueMinutes,
    actualMinutes: totals.actualMinutes + project.actualMinutes,
  }), { budgetAtCompletionMinutes: 0, plannedValueMinutes: 0, earnedValueMinutes: 0, actualMinutes: 0 })
}

/**
 * Calculates one earned value metric from summed figures.
 *
 * @param metric - Earned value metric.
 * @param totals - Figures in minutes.
 * @returns The index (two decimals) or EAC in hours (one decimal), or null when it is undefined.
 */
function calculate(metric: AnalyticsEarnedValueMetric, totals: EarnedValueTotals): number | null {
  if (metric === 'evm-spi') {
    return totals.plannedValueMinutes > 0 ? roundIndex(totals.earnedValueMinutes / totals.plannedValueMinutes) : null
  }
  if (totals.actualMinutes <= 0) return null
  const costIndex = totals.earnedValueMinutes / totals.actualMinutes
  if (metric === 'evm-cpi') return roundIndex(costIndex)
  return costIndex > 0 ? toHours(totals.budgetAtCompletionMinutes / costIndex) : null
}

/**
 * Rounds an index to two decimals.
 *
 * @param value - Index.
 * @returns The rounded index.
 */
function roundIndex(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Converts minutes to hours rounded to one decimal.
 *
 * @param minutes - Minutes.
 * @returns Hours.
 */
function toHours(minutes: number): number {
  return Math.round(((minutes / 60) + Number.EPSILON) * 10) / 10
}
