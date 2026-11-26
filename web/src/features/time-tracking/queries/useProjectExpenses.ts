import useSWR from 'swr'
import { listProjectExpenses } from '../api/projectExpenses'
import { timeTrackingQueryConfig, timeTrackingQueryKeyRoot } from './timeTrackingQueryKeys'

/**
 * Loads the expenses of one Project for its managers.
 *
 * The key sits under the time tracking root, so a change to an expense also refreshes the budget
 * report that counts it.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project identifier.
 * @param enabled - Whether the query may run.
 * @returns SWR state of the expense list.
 */
export function useProjectExpenses(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId: string | undefined,
  enabled = true,
) {
  const key = accessToken && teamId && projectId && enabled
    ? [timeTrackingQueryKeyRoot, 'project-expenses', accessToken, teamId, projectId] as const
    : null
  return useSWR(key, ([, , token, team, project]) => listProjectExpenses(token, team, project), timeTrackingQueryConfig)
}
