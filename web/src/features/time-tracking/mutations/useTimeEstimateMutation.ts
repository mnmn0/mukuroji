import type { TimeEstimate } from '@mukuroji/contracts'
import { useMemo } from 'react'
import { createMutationRequestRunner } from '../../../shared/api/mutationHeaders'
import { saveTimeEstimate } from '../api/timeEstimates'
import { classifyTimeTrackingFailure, shouldRetainTimeTrackingMutation } from '../model/timeTrackingFailure'
import { useRefreshTimeTrackingQueries } from './refreshTimeTrackingQueries'

/**
 * Creates the Work Item estimate save action.
 *
 * @param accessToken - Bearer token, or undefined while signed out.
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item identifier.
 * @returns Save function taking the new minutes and the revision being replaced (0 for a first estimate).
 */
export function useTimeEstimateMutation(
  accessToken: string | undefined,
  teamId: string,
  workItemId: string,
): (estimateMinutes: number, expectedRevision: number) => Promise<TimeEstimate> {
  const runner = useMemo(() => createMutationRequestRunner(), [])
  const refresh = useRefreshTimeTrackingQueries()

  return useMemo(() => async (estimateMinutes: number, expectedRevision: number) => {
    if (!accessToken) throw new Error('A signed-in session is required.')
    try {
      const estimate = await runner.run(
        `time-estimate:${teamId}:${workItemId}`,
        JSON.stringify([estimateMinutes, expectedRevision]),
        (context) => saveTimeEstimate(accessToken, teamId, workItemId, estimateMinutes, expectedRevision, context),
        shouldRetainTimeTrackingMutation,
      )
      await refresh()
      return estimate
    } catch (error) {
      if (classifyTimeTrackingFailure(error) === 'conflict') await refresh()
      throw error
    }
  }, [accessToken, refresh, runner, teamId, workItemId])
}
