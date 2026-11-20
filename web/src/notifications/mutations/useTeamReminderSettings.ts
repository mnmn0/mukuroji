import { useCallback, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import type {
  TeamNotificationReminderDays,
  TeamNotificationReminderSettings,
} from '@mukuroji/contracts'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { NotificationsApiError } from '../api/errors'
import {
  finishTeamReminderSave,
  listTeamReminderSaveErrors,
  readTeamReminderSave,
  startTeamReminderSave,
  type TeamReminderSaveStates,
} from '../model/teamReminderSaveState'
import { updateTeamReminderSettings } from '../api/teamReminders'
import {
  createTeamReminderSettingsKey,
  useTeamReminderSettingsQuery,
} from '../queries/useTeamReminderSettingsQuery'

/** State and actions of the Team reminder settings panel. */
export type TeamReminderSettingsController = {
  /** Loaded settings. */
  settings?: TeamNotificationReminderSettings
  /** Whether the first load is running. */
  isLoading: boolean
  /** Whether the load failed. */
  hasLoadError: boolean
  /** Whether the caller may not see this Team's settings, so the panel stays hidden. */
  isUnavailable: boolean
  /** Whether a save is running. */
  isSaving: boolean
  /** Outcome of the last save. */
  saveResult?: 'saved' | 'conflict' | 'error'
  /** Errors the Workspace shell checks for an expired session. */
  sessionErrors: unknown[]
  /** Reloads the settings. */
  refresh(): Promise<void>
  /**
   * Saves the complete Team overrides against the loaded revision.
   *
   * @param days - Overrides; an omitted field uses the default.
   * @returns Whether the save succeeded.
   */
  save(days: TeamNotificationReminderDays): Promise<boolean>
}

/**
 * Loads a Team's reminder settings and saves them with the loaded revision.
 *
 * @param accessToken - API access token.
 * @param teamId - Team ID, or undefined while the route resolves.
 * @param enabled - Whether the query may run.
 * @returns Panel controller.
 */
export function useTeamReminderSettings(
  accessToken: string | undefined,
  teamId: string | undefined,
  enabled = true,
): TeamReminderSettingsController {
  const mutationRunner = useRef(createMutationRequestRunner()).current
  const { mutate: mutateCache } = useSWRConfig()
  // Kept per Team, so a save that finishes after moving to another Team stays with its own Team.
  const [saveStates, setSaveStates] = useState<TeamReminderSaveStates>({})
  const { data, error, isLoading, mutate } = useTeamReminderSettingsQuery(accessToken, teamId, enabled)
  const save = useCallback(async (days: TeamNotificationReminderDays) => {
    if (!accessToken || !teamId || !data) return false
    // Fixed at save start, so a response that arrives after moving to another Team updates the
    // saved Team's cache entry instead of the one now on screen.
    const key = createTeamReminderSettingsKey(accessToken, teamId)
    setSaveStates((states) => startTeamReminderSave(states, teamId))
    const request = { expectedRevision: data.revision, days }
    try {
      const saved = await mutationRunner.run(
        `team-notification-reminders:${teamId}`,
        JSON.stringify(request),
        (context) => updateTeamReminderSettings(accessToken, teamId, request, context),
      )
      await mutateCache(key, saved, { revalidate: false })
      setSaveStates((states) => finishTeamReminderSave(states, teamId, 'saved'))
      return true
    } catch (caught) {
      console.error('Team reminder settings update failed:', caught)
      const isConflict = caught instanceof NotificationsApiError && caught.status === 409
      if (isConflict) await mutateCache(key).catch(() => undefined)
      setSaveStates((states) => finishTeamReminderSave(states, teamId, isConflict ? 'conflict' : 'error', caught))
      return false
    }
  }, [accessToken, data, mutateCache, mutationRunner, teamId])

  const currentSave = readTeamReminderSave(saveStates, teamId)
  return {
    ...(data ? { settings: data } : {}),
    isLoading,
    hasLoadError: Boolean(error),
    isUnavailable: error instanceof NotificationsApiError && (error.status === 403 || error.status === 404),
    isSaving: currentSave.isSaving,
    ...(currentSave.result ? { saveResult: currentSave.result } : {}),
    sessionErrors: [error, ...listTeamReminderSaveErrors(saveStates)],
    refresh: async () => {
      await mutate()
    },
    save,
  }
}
