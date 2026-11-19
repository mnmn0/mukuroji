import type {
  AnalyticsQueryInput,
  PlanningEntity,
  PlanningWorkItemLink,
} from '@mukuroji/contracts'
import { analyticsCalendarDateBoundaryToInstant } from './timeZone'

/** Widget ID of the Cycle burndown query. */
export const CYCLE_BURNDOWN_WIDGET_ID = 'cycle-burndown'

/** Largest number of Work Items an Analytics filter can list. */
export const CYCLE_BURNDOWN_MAX_WORK_ITEMS = 500

/** Result of {@link createCycleBurndownQuery}. */
export type CycleBurndownQueryPlan =
  | {
      /** The query can run. */
      kind: 'query'
      /** Analytics query of the Cycle burndown. */
      query: AnalyticsQueryInput
    }
  | {
      /** Why no query runs: no linked Work Items, too many, or the Cycle has not started. */
      kind: 'empty' | 'too-many' | 'not-started'
    }

/**
 * Builds the Analytics query that draws a Cycle burndown from its linked Work Items.
 *
 * The period runs from the Cycle baseline start to its end, clipped to `asOf` by the API, and the
 * filter lists the Work Items linked to the Cycle now.
 *
 * @param cycle - Cycle planning entity.
 * @param links - Planning Work Item links of the snapshot.
 * @param timeZone - IANA timezone of the daily buckets.
 * @param asOf - Evaluation instant.
 * @returns The query, or why none can run.
 */
export function createCycleBurndownQuery(
  cycle: PlanningEntity,
  links: readonly PlanningWorkItemLink[],
  timeZone: string,
  asOf: Date,
): CycleBurndownQueryPlan {
  const workItems = links
    .filter((link) => link.cycleId === cycle.id)
    .map((link) => ({ teamId: link.teamId, workItemId: link.workItemId }))
  if (workItems.length === 0) return { kind: 'empty' }
  if (workItems.length > CYCLE_BURNDOWN_MAX_WORK_ITEMS) return { kind: 'too-many' }
  const from = analyticsCalendarDateBoundaryToInstant(cycle.baseline.startDate, timeZone, 'start')
  const to = analyticsCalendarDateBoundaryToInstant(cycle.baseline.endDate, timeZone, 'end')
  if (Date.parse(from) > asOf.getTime()) return { kind: 'not-started' }
  return {
    kind: 'query',
    query: {
      filter: { period: { from, to }, workItems },
      widgets: [{
        id: CYCLE_BURNDOWN_WIDGET_ID,
        title: cycle.title,
        type: 'chart',
        metric: 'remaining-scope',
        visualization: 'burndown',
        groupBy: { dimension: 'day' },
      }],
      asOf: asOf.toISOString(),
      timeZone,
    },
  }
}
