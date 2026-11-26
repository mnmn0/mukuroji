import useSWR from 'swr'
import { listWorkItemArtifactStatuses } from '../api/agentRuns'

/** Interval for picking up a pull request's new checks or merge while the detail stays open. */
const artifactStatusesRefreshInterval = 60_000

/**
 * Reads the provider status of a Work Item's reported pull requests. The number of reports is part
 * of the query, so a newly reported pull request is checked when its report appears.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team that owns the Work Item; reading is skipped without it.
 * @param workItemId - Work Item ID.
 * @param reportCount - Number of reports currently shown; reading is skipped while it is zero.
 * @returns SWR state of the statuses.
 */
export function useWorkItemArtifactStatuses(
  accessToken: string | undefined,
  teamId: string | undefined,
  workItemId: string,
  reportCount: number,
) {
  return useSWR(
    accessToken && teamId && reportCount > 0
      ? ['work-item-artifact-statuses', accessToken, teamId, workItemId, reportCount] as const
      : null,
    ([, token, currentTeamId, currentWorkItemId]) => listWorkItemArtifactStatuses(token, currentTeamId, currentWorkItemId),
    {
      dedupingInterval: 30_000,
      keepPreviousData: true,
      refreshInterval: artifactStatusesRefreshInterval,
      shouldRetryOnError: false,
    },
  )
}
