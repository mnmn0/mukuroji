import { useCallback } from 'react'
import { useSWRConfig } from 'swr'
import { captureProjectScheduleBaseline } from '../api/scheduleBaseline'
import { projectScheduleBaselineKey } from '../queries/useProjectScheduleBaseline'
import { WORK_ITEM_SCHEDULE_BASELINES_KEY } from '../queries/useWorkItemScheduleBaselines'

/**
 * Returns a function that saves a Project schedule baseline and stores the response under the
 * cache key of the Project it was saved for, so a capture that finishes after the viewer moved
 * to another Project never replaces that Project's baseline. The Gantt and Team table baselines
 * are read again so their differences follow the new capture.
 *
 * @returns The capture function.
 */
export function useCaptureProjectScheduleBaseline() {
  const { mutate } = useSWRConfig()
  return useCallback(
    async (accessToken: string, teamId: string, projectId: string) => {
      const response = await captureProjectScheduleBaseline(teamId, projectId, accessToken)
      await mutate(projectScheduleBaselineKey(accessToken, teamId, projectId), response, { revalidate: false })
      // Without data, mutate only revalidates the matching keys and keeps what they show.
      void mutate((key) => Array.isArray(key) && key[0] === WORK_ITEM_SCHEDULE_BASELINES_KEY)
      return response
    },
    [mutate],
  )
}
