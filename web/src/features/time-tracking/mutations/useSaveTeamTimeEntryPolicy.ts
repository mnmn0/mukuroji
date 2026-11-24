import { useCallback } from 'react'
import { saveTeamTimeEntryPolicy, type SaveTeamTimeEntryPolicyInput, type TeamTimeEntryPolicyView } from '../api/timeEntryPolicy'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/**
 * Creates the time entry check save of a Team, refreshing every time tracking query after it
 * settles so the panel shows the saved policy, or the one that won a revision conflict.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team whose checks are saved.
 * @returns Save function.
 */
export function useSaveTeamTimeEntryPolicy(
  accessToken: string | undefined,
  teamId: string,
): (input: SaveTeamTimeEntryPolicyInput) => Promise<TeamTimeEntryPolicyView> {
  const refresh = useRefreshTimeTrackingQueries()
  return useCallback(async (input) => {
    if (!accessToken) throw new TimeTrackingApiError(401, 'Sign in again to save the checks.')
    try {
      return await saveTeamTimeEntryPolicy(accessToken, teamId, input)
    } finally {
      await refresh()
    }
  }, [accessToken, refresh, teamId])
}
