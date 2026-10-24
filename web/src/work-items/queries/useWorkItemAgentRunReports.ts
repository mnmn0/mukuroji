import { useEffect } from 'react'
import useSWR from 'swr'
import { listWorkItemAgentRunReports } from '../api/agentRuns'

/** Interval for picking up reports that agents save while the detail stays open. */
const agentRunReportsRefreshInterval = 30_000

/**
 * Reads the structured reports of a Work Item and reads them again whenever the number of loaded
 * comments changes, so a report appears with the comment it was saved with.
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
  const state = useSWR(
    accessToken && teamId ? ['work-item-agent-run-reports', accessToken, teamId, workItemId] as const : null,
    ([, token, currentTeamId, currentWorkItemId]) =>
      listWorkItemAgentRunReports(token, currentTeamId, currentWorkItemId),
    {
      dedupingInterval: 10_000,
      refreshInterval: agentRunReportsRefreshInterval,
      shouldRetryOnError: false,
    },
  )
  const { mutate } = state
  useEffect(() => {
    // A new agent comment usually carries a report; the first render reads through the key instead.
    if (commentCount > 0) void mutate()
  }, [commentCount, mutate])
  return state
}
