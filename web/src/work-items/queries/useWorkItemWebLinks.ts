import useSWR from 'swr'
import { listWorkItemWebLinks } from '../api/webLinks'

/**
 * Reads the web links of a Work Item.
 *
 * @param accessToken - Access token; no request is made without one.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns The SWR state of the links, oldest first.
 */
export function useWorkItemWebLinks(
  accessToken: string | undefined,
  teamId: string,
  workItemId: string,
) {
  return useSWR(
    accessToken ? (['work-item-web-links', accessToken, teamId, workItemId] as const) : null,
    ([, token, currentTeamId, currentWorkItemId]) => listWorkItemWebLinks(token, currentTeamId, currentWorkItemId),
    { dedupingInterval: 10_000, shouldRetryOnError: false },
  )
}
