import useSWR from 'swr'
import { listWorkItemAgentRuns } from '../api/agentRuns'

/**
 * Reads the newest Agent Runs of a Work Item.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns SWR state of the run history.
 */
export function useWorkItemAgentRuns(
  accessToken: string | undefined,
  teamId: string,
  workItemId: string,
) {
  return useSWR(
    accessToken ? ['work-item-agent-runs', accessToken, teamId, workItemId] as const : null,
    ([, token, currentTeamId, currentWorkItemId]) =>
      listWorkItemAgentRuns(token, currentTeamId, currentWorkItemId),
    {
      dedupingInterval: 10_000,
      shouldRetryOnError: false,
    },
  )
}
