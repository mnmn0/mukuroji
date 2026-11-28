import { useCallback } from 'react'
import {
  saveTeamInvestmentAssignments,
  type SaveTeamInvestmentAssignmentsInput,
  type TeamInvestmentAssignmentsView,
} from '../api/investmentAssignments'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/**
 * Creates the investment category assignment save of a Team, refreshing every time tracking query
 * after it settles so reports and editors show the saved assignments, or the ones that won a
 * revision conflict.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team whose assignments are saved.
 * @returns Save function.
 */
export function useSaveTeamInvestmentAssignments(
  accessToken: string | undefined,
  teamId: string,
): (input: SaveTeamInvestmentAssignmentsInput) => Promise<TeamInvestmentAssignmentsView> {
  const refresh = useRefreshTimeTrackingQueries()
  return useCallback(async (input) => {
    if (!accessToken) throw new TimeTrackingApiError(401, 'Sign in again to save the investment categories.')
    try {
      return await saveTeamInvestmentAssignments(accessToken, teamId, input)
    } finally {
      await refresh()
    }
  }, [accessToken, refresh, teamId])
}
