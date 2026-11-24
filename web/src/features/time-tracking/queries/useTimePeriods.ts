import useSWR from 'swr'
import { getTeamTimePeriods, getWorkspaceTimePeriod } from '../api/timePeriods'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads a Team's closed months and whether the caller may close them.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team to read.
 * @returns SWR state of the closed months.
 */
export function useTeamTimePeriods(accessToken: string | undefined, teamId: string | undefined) {
  const key = accessToken && teamId ? [timeTrackingQueryKeyRoot, 'time-periods', accessToken, teamId] as const : null
  return useSWR(key, ([, , token, team]) => getTeamTimePeriods(token, team), timeTrackingQueryConfig)
}

/**
 * Loads one month's close state for every Team of the Workspace.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param month - Month as `YYYY-MM`, or undefined while none is chosen.
 * @param enabled - Whether the caller is a Workspace administrator, so a member never requests it.
 * @returns SWR state of the month.
 */
export function useWorkspaceTimePeriod(accessToken: string | undefined, month: string | undefined, enabled: boolean) {
  const key = accessToken && month && enabled ? [timeTrackingQueryKeyRoot, 'workspace-time-period', accessToken, month] as const : null
  return useSWR(key, ([, , token, selected]) => getWorkspaceTimePeriod(token, selected), timeTrackingQueryConfig)
}
