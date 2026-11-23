import useSWR from 'swr'
import { getMyTimesheet } from '../api/myTimesheet'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads the caller's own time of every Team for a period.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param period - Inclusive start and exclusive end as ISO instants, and the display timezone.
 * @param enabled - Whether the query may run.
 * @returns SWR state of the personal timesheet.
 */
export function useMyTimesheet(
  accessToken: string | undefined,
  period: { from: string; to: string; timeZone: string },
  enabled: boolean,
) {
  const key = accessToken && enabled
    ? [timeTrackingQueryKeyRoot, 'my-timesheet', accessToken, period.from, period.to, period.timeZone] as const
    : null
  return useSWR(
    key,
    ([, , token, from, to, timeZone]) => getMyTimesheet(token, { from, to, timeZone }),
    timeTrackingQueryConfig,
  )
}
