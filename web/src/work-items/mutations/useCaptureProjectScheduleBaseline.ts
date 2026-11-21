import { useCallback } from 'react'
import { useSWRConfig } from 'swr'
import type { ProjectScheduleBaselineResponse } from '@mukuroji/contracts'
import { activateProjectScheduleBaseline, captureProjectScheduleBaseline } from '../api/scheduleBaseline'
import { PROJECT_SCHEDULE_BASELINE_KEY, projectScheduleBaselineKey } from '../queries/useProjectScheduleBaseline'
import { WORK_ITEM_SCHEDULE_BASELINES_KEY } from '../queries/useWorkItemScheduleBaselines'

/**
 * Returns a function that saves a named Project schedule baseline and stores the response under
 * the cache key of the Project it was saved for, so a capture that finishes after the viewer
 * moved to another Project never replaces that Project's baseline. The Gantt and table baselines
 * are read again so their differences follow the new capture.
 *
 * @returns The capture function.
 */
export function useCaptureProjectScheduleBaseline() {
  const refresh = useBaselineCacheRefresh()
  return useCallback(
    async (accessToken: string, teamId: string, projectId: string, name?: string) => {
      const response = await captureProjectScheduleBaseline(teamId, projectId, accessToken, name)
      await refresh(accessToken, teamId, projectId, response)
      return response
    },
    [refresh],
  )
}

/**
 * Returns a function that makes a saved baseline the active one of its Project and refreshes
 * every view that compares against the active baseline.
 *
 * @returns The switch function.
 */
export function useActivateProjectScheduleBaseline() {
  const refresh = useBaselineCacheRefresh()
  return useCallback(
    async (accessToken: string, teamId: string, projectId: string, baselineId: string, expectedRevision: number) => {
      const response = await activateProjectScheduleBaseline(teamId, projectId, accessToken, { baselineId, expectedRevision })
      await refresh(accessToken, teamId, projectId, response)
      return response
    },
    [refresh],
  )
}

/**
 * Returns a function that stores a new active baseline in the cache and revalidates the other
 * keys that read the same Project's baselines.
 *
 * @returns The refresh function.
 */
function useBaselineCacheRefresh() {
  const { mutate } = useSWRConfig()
  return useCallback(
    async (accessToken: string, teamId: string, projectId: string, response: ProjectScheduleBaselineResponse) => {
      await mutate(projectScheduleBaselineKey(accessToken, teamId, projectId), response, { revalidate: false })
      // Without data, mutate only revalidates the matching keys and keeps what they show.
      void mutate((key) =>
        Array.isArray(key) &&
        key[0] === PROJECT_SCHEDULE_BASELINE_KEY &&
        key[2] === teamId &&
        key[3] === projectId &&
        key[4] !== '')
      void mutate((key) => Array.isArray(key) && key[0] === WORK_ITEM_SCHEDULE_BASELINES_KEY)
    },
    [mutate],
  )
}
