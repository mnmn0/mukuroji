import { useCallback, useRef, useState } from 'react'
import { useSWRConfig } from 'swr'
import type {
  TeamNotificationReminderDays,
  TeamNotificationReminderSettings,
} from '@mukuroji/contracts'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { NotificationsApiError } from '../api/errors'
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
  const [isSaving, setIsSaving] = useState(false)
  // Tagged with the saved Team, so a result never shows on another Team's page.
  const [saveOutcome, setSaveOutcome] = useState<{
    teamId: string
    result: NonNullable<TeamReminderSettingsController['saveResult']>
  }>()
  const [saveError, setSaveError] = useState<unknown>()
  const { data, error, isLoading, mutate } = useTeamReminderSettingsQuery(accessToken, teamId, enabled)
  const save = useCallback(async (days: TeamNotificationReminderDays) => {
    if (!accessToken || !teamId || !data) return false
    // Fixed at save start, so a response that arrives after moving to another Team updates the
    // saved Team's cache entry instead of the one now on screen.
    const key = createTeamReminderSettingsKey(accessToken, teamId)
    setIsSaving(true)
    setSaveOutcome(undefined)
    setSaveError(undefined)
    const request = { expectedRevision: data.revision, days }
    try {
      const saved = await mutationRunner.run(
        `team-notification-reminders:${teamId}`,
        JSON.stringify(request),
        (context) => updateTeamReminderSettings(accessToken, teamId, request, context),
      )
      await mutateCache(key, saved, { revalidate: false })
      setSaveOutcome({ teamId, result: 'saved' })
      return true
    } catch (caught) {
      console.error('Team reminder settings update failed:', caught)
      if (caught instanceof NotificationsApiError && caught.status === 409) {
        await mutateCache(key).catch(() => undefined)
        setSaveOutcome({ teamId, result: 'conflict' })
      } else {
        setSaveOutcome({ teamId, result: 'error' })
      }
      setSaveError(caught)
      return false
    } finally {
      setIsSaving(false)
    }
  }, [accessToken, data, mutateCache, mutationRunner, teamId])

  return {
    ...(data ? { settings: data } : {}),
    isLoading,
    hasLoadError: Boolean(error),
    isUnavailable: error instanceof NotificationsApiError && (error.status === 403 || error.status === 404),
    isSaving,
    ...(saveOutcome && saveOutcome.teamId === teamId ? { saveResult: saveOutcome.result } : {}),
    sessionErrors: [error, saveError],
    refresh: async () => {
      await mutate()
    },
    save,
  }
}
