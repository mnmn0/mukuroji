import useSWR from 'swr'
import { getTeamWorkItemHierarchy } from '../api/hierarchy'

const hierarchyQueryConfig = {
  dedupingInterval: 5_000,
  shouldRetryOnError: false,
} as const

/**
 * Reads a Team's Work Item hierarchy with WBS numbers and roll-ups.
 *
 * @param accessToken - Access token for the Work Item API.
 * @param teamId - Team whose hierarchy is read.
 * @param enabled - Whether the query runs.
 * @returns SWR state of the hierarchy.
 */
export function useTeamWorkItemHierarchy(
  accessToken: string | undefined,
  teamId: string | undefined,
  enabled = true,
) {
  const key = accessToken && teamId && enabled
    ? ['team-work-item-hierarchy', accessToken, teamId] as const
    : null
  return useSWR(
    key,
    ([, token, currentTeamId]) => getTeamWorkItemHierarchy(currentTeamId, token),
    hierarchyQueryConfig,
  )
}
