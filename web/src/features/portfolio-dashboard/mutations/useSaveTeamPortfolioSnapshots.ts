import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { createMutationRequestContext } from '../../../shared/api/mutationHeaders'
import { saveTeamPortfolioSnapshot } from '../api/portfolio'
import { isPortfolioSnapshotsKeyOfMonth } from '../queries/usePortfolioDashboard'

/** Outcome of the last save of this month's snapshots. */
export type TeamPortfolioSnapshotSaveResult = {
  /** Month that was saved, as `YYYY-MM`. */
  month: string
  /** Teams whose snapshot was saved. */
  savedTeamIds: string[]
  /** Teams whose snapshot could not be saved. */
  failedTeamIds: string[]
}

/** Inputs of {@link useSaveTeamPortfolioSnapshots}. */
export type SaveTeamPortfolioSnapshotsOptions = {
  /** Session access token; saving does nothing without it. */
  accessToken: string | undefined
  /** IANA timezone whose current month is saved. */
  timeZone: string
  /** Resolves the current month as `YYYY-MM` when the save starts. */
  resolveCurrentMonth: () => string
}

/**
 * Saves this month's portfolio snapshot of each Team the reader manages as a whole, one Team
 * at a time, and keeps the failures so the page can name the Teams and forward session failures.
 * Every cached read of the saved month is revalidated afterwards, so a comparison the reader
 * switched to during the save does not keep the older snapshot.
 *
 * @param options - Token, timezone, and month resolver.
 * @returns The save state and the action.
 */
export function useSaveTeamPortfolioSnapshots(options: SaveTeamPortfolioSnapshotsOptions) {
  const { accessToken, timeZone, resolveCurrentMonth } = options
  const { mutate } = useSWRConfig()
  const [isSaving, setIsSaving] = useState(false)
  const [result, setResult] = useState<TeamPortfolioSnapshotSaveResult>()
  const [errors, setErrors] = useState<readonly unknown[]>([])

  /**
   * Saves the snapshot of each Team; a second call while one runs is ignored.
   *
   * @param teamIds - Teams to save.
   */
  const save = async (teamIds: readonly string[]) => {
    if (!accessToken || teamIds.length === 0 || isSaving) return
    setIsSaving(true)
    setResult(undefined)
    setErrors([])
    const month = resolveCurrentMonth()
    const savedTeamIds: string[] = []
    const failedTeamIds: string[] = []
    const failures: unknown[] = []
    for (const teamId of teamIds) {
      try {
        await saveTeamPortfolioSnapshot(accessToken, teamId, month, timeZone, createMutationRequestContext())
        savedTeamIds.push(teamId)
      } catch (error) {
        failedTeamIds.push(teamId)
        failures.push(error)
      }
    }
    setIsSaving(false)
    setErrors(failures)
    setResult({ month, savedTeamIds, failedTeamIds })
    if (savedTeamIds.length > 0) {
      await mutate((key) => isPortfolioSnapshotsKeyOfMonth(key, month))
        .catch(() => undefined)
    }
  }

  return { isSaving, result, errors, save }
}
