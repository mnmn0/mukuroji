import type { SaveTimeRateCardRequest, TimeRateCard } from '@mukuroji/contracts'
import { useCallback } from 'react'
import { saveTimeRateCard } from '../api/timeRateCard'
import { TimeTrackingApiError } from '../api/timeTrackingRequest'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/**
 * Creates the rate card save of a Team, refreshing every time tracking query after it settles so
 * the panel shows the saved card, or the one that won a revision conflict.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team whose card is saved.
 * @returns Save function.
 */
export function useSaveTimeRateCard(
  accessToken: string | undefined,
  teamId: string,
): (request: SaveTimeRateCardRequest) => Promise<TimeRateCard> {
  const refresh = useRefreshTimeTrackingQueries()
  return useCallback(async (request) => {
    if (!accessToken) throw new TimeTrackingApiError(401, 'Sign in again to save the rate card.')
    try {
      return await saveTimeRateCard(accessToken, teamId, request)
    } finally {
      await refresh()
    }
  }, [accessToken, refresh, teamId])
}
