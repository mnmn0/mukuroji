import useSWR from 'swr'
import { getTimeEstimate } from '../api/timeEstimates'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads the estimate of a Work Item.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item identifier.
 * @returns SWR state of the estimate; `null` data means no estimate is set.
 */
export function useTimeEstimate(accessToken: string | undefined, teamId: string, workItemId: string) {
  const key = accessToken ? [timeTrackingQueryKeyRoot, 'estimate', accessToken, teamId, workItemId] as const : null
  return useSWR(key, ([, , token, team, workItem]) => getTimeEstimate(token, team, workItem), timeTrackingQueryConfig)
}
