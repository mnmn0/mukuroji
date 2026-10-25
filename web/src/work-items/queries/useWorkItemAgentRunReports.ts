import useSWR from 'swr'
import { listWorkItemAgentRunReports } from '../api/agentRuns'

/** Interval for picking up reports that agents save while the detail stays open. */
const agentRunReportsRefreshInterval = 30_000

/**
 * Reads the structured reports of a Work Item. The number of loaded comments is part of the query,
 * so a new comment reads the reports again and its report appears with it; the previous reports
 * stay shown while that read runs.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team that owns the Work Item; reading is skipped without it.
 * @param workItemId - Work Item ID.
 * @param commentCount - Number of comments currently shown.
 * @returns SWR state of the reports.
 */
export function useWorkItemAgentRunReports(
  accessToken: string | undefined,
  teamId: string | undefined,
  workItemId: string,
  commentCount: number,
) {
  return useSWR(
    accessToken && teamId ? ['work-item-agent-run-reports', accessToken, teamId, workItemId, commentCount] as const : null,
    ([, token, currentTeamId, currentWorkItemId]) =>
      listWorkItemAgentRunReports(token, currentTeamId, currentWorkItemId),
    {
      dedupingInterval: 10_000,
      keepPreviousData: true,
      refreshInterval: agentRunReportsRefreshInterval,
      shouldRetryOnError: false,
    },
  )
}
