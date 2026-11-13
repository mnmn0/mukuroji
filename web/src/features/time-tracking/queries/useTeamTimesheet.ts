import useSWR from 'swr'
import { getTeamTimesheet } from '../api/teamTimesheet'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads a Team's daily and weekly totals for a period.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team whose entries are totalled.
 * @param period - Inclusive start and exclusive end as ISO instants, and the display timezone.
 * @param enabled - Whether the query may run.
 * @returns SWR state of the timesheet.
 */
export function useTeamTimesheet(
  accessToken: string | undefined,
  teamId: string | undefined,
  period: { from: string; to: string; timeZone: string },
  enabled = true,
) {
  const key = accessToken && teamId && enabled
    ? [timeTrackingQueryKeyRoot, 'team-timesheet', accessToken, teamId, period.from, period.to, period.timeZone] as const
    : null
  return useSWR(
    key,
    ([, , token, team, from, to, timeZone]) => getTeamTimesheet(token, team, { from, to, timeZone }),
    timeTrackingQueryConfig,
  )
}
