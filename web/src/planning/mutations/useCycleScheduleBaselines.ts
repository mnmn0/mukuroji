import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { captureCycleScheduleBaseline } from '../api/cycleBaselines'
import { PlanningApiError } from '../api/errors'
import { cycleScheduleBaselineKey, useCycleScheduleBaseline } from '../queries/useCycleScheduleBaseline'

/**
 * Tells whether a failed read was for a selected baseline that is no longer saved.
 *
 * @param selectedId - Selected saved baseline, or `undefined` for the newest one.
 * @param error - Error of the read.
 * @returns `true` when the selection should fall back to the newest baseline.
 */
export function isEvictedBaselineSelection(selectedId: string | undefined, error: unknown) {
  return selectedId !== undefined
    && error instanceof PlanningApiError
    && error.code === 'CycleScheduleBaselineNotFound'
}

/**
 * Reads a Cycle's baselines, tracks which saved one is shown, and saves new ones.
 *
 * @param accessToken - Planning API access token.
 * @param cycleId - Cycle whose baselines are read and saved.
 * @returns The baseline query, the selection, the retry and save actions, and the save state.
 */
export function useCycleScheduleBaselines(accessToken: string, cycleId: string) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [isCapturing, setIsCapturing] = useState(false)
  const [captureFailed, setCaptureFailed] = useState(false)
  const query = useCycleScheduleBaseline(accessToken, cycleId, selectedId)
  const { mutate } = useSWRConfig()

  /**
   * Saves the Cycle's current plan as a new baseline and shows it.
   *
   * @param name - Optional baseline name.
   */
  const capture = async (name: string) => {
    setIsCapturing(true)
    setCaptureFailed(false)
    try {
      const saved = await captureCycleScheduleBaseline(accessToken, cycleId, name)
      // The newest baseline is the one just saved, so show it whichever one was selected.
      await mutate(cycleScheduleBaselineKey(accessToken, cycleId), saved, { revalidate: false })
      setSelectedId(undefined)
    } catch {
      setCaptureFailed(true)
    } finally {
      setIsCapturing(false)
    }
  }

  /**
   * Reloads after a failed read. A selected baseline that is no longer saved, such as one dropped
   * when newer baselines were saved, falls back to the newest one instead of failing again.
   */
  const retry = () => {
    if (isEvictedBaselineSelection(selectedId, query.error)) setSelectedId(undefined)
    else void query.mutate()
  }

  return { query, selectedId, select: setSelectedId, retry, capture, isCapturing, captureFailed }
}
