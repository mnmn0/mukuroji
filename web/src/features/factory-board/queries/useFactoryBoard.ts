import useSWR from 'swr'
import { getTeamAgentRunBoard, listWorkItemAgentRunReports } from '../../../work-items/api/agentRuns'

/**
 * Interval for reading the board again while it stays open. Each read evaluates many runs and Work
 * Items, so it is slower than the single Work Item's run panel; focus and the refresh action read it
 * at once.
 */
const factoryBoardRefreshInterval = 60_000

/** Interval for reading the selected Work Item's reports again while its detail stays open. */
const factoryBoardReportsRefreshInterval = 30_000

/**
 * Reads a Team's Factory board, again when the window regains focus and at a slow interval. There is
 * no realtime delivery.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team ID; reading is skipped without it.
 * @returns SWR state of the board.
 */
export function useTeamAgentRunBoard(accessToken: string | undefined, teamId: string | undefined) {
  return useSWR(
    accessToken && teamId ? ['factory-board', accessToken, teamId] as const : null,
    ([, token, currentTeamId]) => getTeamAgentRunBoard(token, currentTeamId),
    {
      dedupingInterval: 10_000,
      keepPreviousData: true,
      refreshInterval: factoryBoardRefreshInterval,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )
}

/**
 * Reads the structured reports of the Work Item selected on the board.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team ID; reading is skipped without it.
 * @param workItemId - Selected Work Item; reading is skipped without one.
 * @returns SWR state of the reports.
 */
export function useFactoryBoardReports(
  accessToken: string | undefined,
  teamId: string | undefined,
  workItemId: string | undefined,
) {
  return useSWR(
    accessToken && teamId && workItemId ? ['factory-board-reports', accessToken, teamId, workItemId] as const : null,
    ([, token, currentTeamId, currentWorkItemId]) => listWorkItemAgentRunReports(token, currentTeamId, currentWorkItemId),
    {
      dedupingInterval: 10_000,
      refreshInterval: factoryBoardReportsRefreshInterval,
      shouldRetryOnError: false,
    },
  )
}
