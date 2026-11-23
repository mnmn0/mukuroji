import useSWR from 'swr'
import { getTeamTimeEntryPolicy } from '../api/timeEntryPolicy'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads a Team's time entry checks.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team whose checks are read.
 * @returns SWR state of the policy and whether the member may change it.
 */
export function useTeamTimeEntryPolicy(accessToken: string | undefined, teamId: string | undefined) {
  const key = accessToken && teamId ? [timeTrackingQueryKeyRoot, 'entry-policy', accessToken, teamId] as const : null
  return useSWR(key, ([, , token, team]) => getTeamTimeEntryPolicy(token, team), timeTrackingQueryConfig)
}
