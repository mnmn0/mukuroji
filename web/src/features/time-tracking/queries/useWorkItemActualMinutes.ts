import useSWR from 'swr'
import { getTimeSummaryMinutes } from '../api/timeSummary'
import { createTrailingPeriod, resolveBrowserTimeZone } from '../model/timePeriod'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/** Days of history counted as a Work Item's actual time. */
export const workItemActualPeriodDays = 365

/**
 * Loads the actual minutes the Team recorded on a Work Item over the last year.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item identifier.
 * @returns SWR state of the actual minutes.
 */
export function useWorkItemActualMinutes(accessToken: string | undefined, teamId: string, workItemId: string) {
  const period = createTrailingPeriod(workItemActualPeriodDays)
  const key = accessToken
    ? [timeTrackingQueryKeyRoot, 'work-item-actual', accessToken, teamId, workItemId, period.from, period.to] as const
    : null
  return useSWR(
    key,
    async ([, , token, team, workItem, from, to]) => {
      const summary = await getTimeSummaryMinutes(token, team, { from, to, timeZone: resolveBrowserTimeZone(), groupBy: 'work-item' })
      return summary.minutesByKey[workItem] ?? 0
    },
    timeTrackingQueryConfig,
  )
}
