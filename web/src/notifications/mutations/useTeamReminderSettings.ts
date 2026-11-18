import { useCallback, useRef, useState } from 'react'
import useSWR from 'swr'
import type {
  TeamNotificationReminderDays,
  TeamNotificationReminderSettings,
} from '@mukuroji/contracts'
import { createMutationRequestRunner } from '../../shared/api/mutationHeaders'
import { NotificationsApiError } from '../api/errors'
import { getTeamReminderSettings, updateTeamReminderSettings } from '../api/teamReminders'

/** State and actions of the Team reminder settings panel. */
export type TeamReminderSettingsController = {
  /** Loaded settings. */
  settings?: TeamNotificationReminderSettings
  /** Whether the first load is running. */
  isLoading: boolean
  /** Whether the load failed. */
  hasLoadError: boolean
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
  const [isSaving, setIsSaving] = useState(false)
  const [saveResult, setSaveResult] = useState<TeamReminderSettingsController['saveResult']>()
  const [saveError, setSaveError] = useState<unknown>()
  const key = accessToken && teamId && enabled
    ? ['team-notification-reminders', accessToken, teamId] as const
    : null
  const { data, error, isLoading, mutate } = useSWR(
    key,
    ([, token, team]) => getTeamReminderSettings(token, team),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )

  const save = useCallback(async (days: TeamNotificationReminderDays) => {
    if (!accessToken || !teamId || !data) return false
    setIsSaving(true)
    setSaveResult(undefined)
    setSaveError(undefined)
    const request = { expectedRevision: data.revision, days }
    try {
      const saved = await mutationRunner.run(
        `team-notification-reminders:${teamId}`,
        JSON.stringify(request),
        (context) => updateTeamReminderSettings(accessToken, teamId, request, context),
      )
      await mutate(saved, { revalidate: false })
      setSaveResult('saved')
      return true
    } catch (caught) {
      console.error('Team reminder settings update failed:', caught)
      setSaveError(caught)
      if (caught instanceof NotificationsApiError && caught.status === 409) {
        setSaveResult('conflict')
        await mutate().catch(() => undefined)
      } else {
        setSaveResult('error')
      }
      return false
    } finally {
      setIsSaving(false)
    }
  }, [accessToken, data, mutate, mutationRunner, teamId])

  return {
    ...(data ? { settings: data } : {}),
    isLoading: Boolean(key) && isLoading,
    hasLoadError: Boolean(error),
    isSaving,
    ...(saveResult ? { saveResult } : {}),
    sessionErrors: [error, saveError],
    refresh: async () => {
      await mutate()
    },
    save,
  }
}
