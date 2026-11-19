import type { TimeBudget } from '@mukuroji/contracts'
import { useCallback } from 'react'
import { saveTimeBudget, type SaveTimeBudgetInput, type TimeReportBudgetScope } from '../api/timeReport'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/**
 * Creates the budget save of a Team, refreshing every time tracking query after it settles so the
 * panel shows the saved budget, or the one that won a revision conflict.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team that owns the budget or its Project.
 * @returns Save function for a Team or Project budget.
 */
export function useSaveTimeBudget(
  accessToken: string | undefined,
  teamId: string,
): (scope: TimeReportBudgetScope, input: SaveTimeBudgetInput) => Promise<TimeBudget> {
  const refresh = useRefreshTimeTrackingQueries()
  return useCallback(async (scope, input) => {
    if (!accessToken) throw new TimeTrackingApiError(401, 'Sign in again to save the budget.')
    try {
      return await saveTimeBudget(accessToken, teamId, scope, input)
    } finally {
      await refresh()
    }
  }, [accessToken, refresh, teamId])
}
