import useSWR from 'swr'
import { getTeamInvestmentAssignments } from '../api/investmentAssignments'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads a Team's investment category assignments (ADR 0116).
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team whose assignments are read.
 * @returns SWR state of the assignments and whether the member may change them.
 */
export function useTeamInvestmentAssignments(accessToken: string | undefined, teamId: string | undefined) {
  const key = accessToken && teamId ? [timeTrackingQueryKeyRoot, 'investment-assignments', accessToken, teamId] as const : null
  return useSWR(key, ([, , token, team]) => getTeamInvestmentAssignments(token, team), timeTrackingQueryConfig)
}
