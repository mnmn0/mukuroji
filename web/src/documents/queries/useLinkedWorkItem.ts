import useSWR from 'swr'
import { getTeamIssueDetail } from '../../issues/api/workItems'
import { parseCanonicalWorkItemId } from '../model/relations'

/**
 * Reads a linked Work Item with the viewer's token.
 *
 * @param accessToken - Workspace API token; omission skips the read.
 * @param workItemId - Canonical Work Item ID; omission skips the read.
 * @returns The Work Item, and whether a requested Work Item cannot be shown
 *   because its ID is not canonical or the viewer cannot read it.
 */
export function useLinkedWorkItem(
  accessToken: string | undefined,
  workItemId: string | undefined,
) {
  const parsed = workItemId === undefined
    ? undefined
    : parseCanonicalWorkItemId(workItemId)
  const { data, error } = useSWR(
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
  return {
    issue: data?.issue,
    isUnavailable:
      workItemId !== undefined &&
      (parsed === undefined || error !== undefined),
  }
}
