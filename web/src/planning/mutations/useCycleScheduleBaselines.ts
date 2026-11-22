import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { captureCycleScheduleBaseline } from '../api/cycleBaselines'
import { cycleScheduleBaselineKey, useCycleScheduleBaseline } from '../queries/useCycleScheduleBaseline'

/**
 * Reads a Cycle's baselines, tracks which saved one is shown, and saves new ones.
 *
 * @param accessToken - Planning API access token.
 * @param cycleId - Cycle whose baselines are read and saved.
 * @returns The baseline query, the selection, and the save action with its state.
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

  return { query, selectedId, select: setSelectedId, capture, isCapturing, captureFailed }
}
