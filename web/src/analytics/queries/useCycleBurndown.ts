import type {
  AnalyticsSeriesPoint,
  PlanningEntity,
  PlanningWorkItemLink,
} from '@mukuroji/contracts'
import { useEffect, useMemo, useState } from 'react'
import useSWR from 'swr'
import { queryAnalytics } from '../api/queries'
import {
  CYCLE_BURNDOWN_WIDGET_ID,
  createCycleBurndownQuery,
} from '../model/cycleBurndown'

/** How often a not-yet-started Cycle is checked again for its start. */
const START_CHECK_INTERVAL_MS = 60_000

/** Screen state of a Cycle burndown. */
export type CycleBurndownState =
  | { kind: 'empty' | 'too-many' | 'not-started' | 'loading' | 'error' }
  | {
      /** The burndown series is loaded. */
      kind: 'ready'
      /** Daily remaining scope series. */
      series: AnalyticsSeriesPoint[]
    }

/** Result of {@link useCycleBurndown}. */
export type CycleBurndownQuery = {
  /** Current screen state. */
  state: CycleBurndownState
  /** Refetches the burndown at the current time. */
  retry: () => void
}

/**
 * Loads the burndown of one Cycle from the Analytics API.
 *
 * Every fetch, including focus revalidation and retries, evaluates the Cycle at the time of the
 * request, so an open panel follows completions made elsewhere.
 *
 * @param accessToken - Analytics API access token.
 * @param cycle - Cycle planning entity.
 * @param links - Planning Work Item links of the snapshot.
 * @param timeZone - IANA timezone of the daily buckets.
 * @returns The burndown state and a retry action.
 */
export function useCycleBurndown(
  accessToken: string,
  cycle: PlanningEntity,
  links: readonly PlanningWorkItemLink[],
  timeZone: string,
): CycleBurndownQuery {
  // Refreshed while the Cycle has not started, so an open panel starts loading once it does.
  const [checkedAt, setCheckedAt] = useState(() => new Date())
  const plan = useMemo(
    () => createCycleBurndownQuery(cycle, links, timeZone, checkedAt),
    [checkedAt, cycle, links, timeZone],
  )
  const notStarted = plan.kind === 'not-started'
  useEffect(() => {
    if (!notStarted) return undefined
    const timer = setInterval(() => setCheckedAt(new Date()), START_CHECK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [notStarted])
  const workItemSignature = plan.kind === 'query'
    ? JSON.stringify(plan.query.filter)
    : null
  const { data, error, isLoading, mutate } = useSWR(
    workItemSignature
      ? ['cycle-burndown', accessToken, cycle.id, cycle.title, timeZone, workItemSignature] as const
      : null,
    async ([, token]) => {
      const current = createCycleBurndownQuery(cycle, links, timeZone, new Date())
      if (current.kind !== 'query') return []
      const snapshot = await queryAnalytics(token, current.query)
      return snapshot.widgets.find((widget) => widget.widgetId === CYCLE_BURNDOWN_WIDGET_ID)?.series ?? []
    },
    { dedupingInterval: 10_000, shouldRetryOnError: false },
  )
  const state: CycleBurndownState = plan.kind !== 'query'
    ? { kind: plan.kind }
    : error
      ? { kind: 'error' }
      : isLoading || data === undefined
        ? { kind: 'loading' }
        : { kind: 'ready', series: data }
  return {
    state,
    retry: () => {
      void mutate()
    },
  }
}
