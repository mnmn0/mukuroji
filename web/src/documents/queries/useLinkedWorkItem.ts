import useSWR from 'swr'
import { TeamIssuesApiError } from '../../issues/api/errors'
import { getTeamIssueDetail } from '../../issues/api/workItems'
import { parseCanonicalWorkItemId } from '../model/relations'

/**
 * Tells whether a Work Item read failed because the viewer cannot see it, as
 * opposed to a failure that a retry can recover from.
 *
 * @param error - Error thrown by the Work Item detail read.
 * @returns Whether the Work Item is missing or forbidden for the viewer.
 */
function isUnavailableWorkItemError(error: unknown): boolean {
  return (
    error instanceof TeamIssuesApiError &&
    (error.status === 403 || error.status === 404)
  )
}

/**
 * Reads a linked Work Item with the viewer's token.
 *
 * @param accessToken - Workspace API token; omission skips the read.
 * @param workItemId - Canonical Work Item ID; omission skips the read.
 * @returns The Work Item; whether it cannot be shown because its ID is not
 *   canonical or the viewer cannot read it; whether a retryable read failed;
 *   and the retry entry point.
 */
export function useLinkedWorkItem(
  accessToken: string | undefined,
  workItemId: string | undefined,
) {
  const parsed = workItemId === undefined
    ? undefined
    : parseCanonicalWorkItemId(workItemId)
  const { data, error, mutate } = useSWR(
    accessToken && parsed
      ? ['document-link-work-item', accessToken, parsed.teamId, parsed.issueId] as const
      : null,
    ([, token, teamId, issueId]) => getTeamIssueDetail(teamId, issueId, token),
    {
      dedupingInterval: 30_000,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
  const isUnavailable =
    workItemId !== undefined &&
    (parsed === undefined || isUnavailableWorkItemError(error))
  return {
    hasError: error !== undefined && !isUnavailable,
    issue: data?.issue,
    isUnavailable,
    retry: () => mutate(),
  }
}
