import useSWR from 'swr'
import type { WorkspaceCalendarSettingsResponse } from '@mukuroji/contracts'
import { getWorkspaceCalendarSettings } from '../api/tenantAdministration'

/** First element of every Workspace calendar settings cache key. */
const workspaceCalendarSettingsKeyPrefix = 'workspace-calendar-settings'

const workspaceCalendarSettingsQueryConfig = {
  dedupingInterval: 60_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Matches the cache keys of {@link useWorkspaceCalendarSettings}, so a settings change can
 * revalidate every reader regardless of the access token in the key.
 *
 * @param key - SWR cache key.
 * @returns Whether the key belongs to the Workspace calendar settings query.
 */
export function isWorkspaceCalendarSettingsKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === workspaceCalendarSettingsKeyPrefix
}

/** State of the Workspace calendar settings read. */
export type WorkspaceCalendarSettingsQuery = {
  /** Settings from the server, with its national holiday dates; undefined until the read succeeds. */
  settings: WorkspaceCalendarSettingsResponse | undefined
  /** Failure of the latest read, if any. */
  error: unknown
  /** Reads the settings again. */
  retry: () => void
}

/**
 * Loads the Workspace fiscal year and week settings for any member.
 *
 * A failed read is reported instead of falling back to the defaults, so screens never lay out
 * periods with a week start the Workspace did not choose.
 *
 * @param accessToken - Bearer token used for the read.
 * @param enabled - Whether the query may run.
 * @returns The settings once loaded, the latest error, and a retry action.
 */
export function useWorkspaceCalendarSettings(
  accessToken?: string,
  enabled = true,
): WorkspaceCalendarSettingsQuery {
  const key = accessToken && enabled
    ? [workspaceCalendarSettingsKeyPrefix, accessToken] as const
    : null
  const query = useSWR(
    key,
    ([, token]) => getWorkspaceCalendarSettings(token),
    workspaceCalendarSettingsQueryConfig,
  )
  return {
    settings: query.data,
    error: query.error,
    retry: () => { void query.mutate().catch(() => undefined) },
  }
}

/**
 * Picks the notice for a failed calendar read, so it names the calendar the screen really uses.
 *
 * @param calendar - State of the calendar settings read.
 * @returns The message key, or undefined when the latest read did not fail.
 */
export function workspaceCalendarErrorMessageKey(
  calendar: Pick<WorkspaceCalendarSettingsQuery, 'settings' | 'error'>,
): 'tasks.workspaceCalendar.error' | 'tasks.workspaceCalendar.staleError' | undefined {
  if (!calendar.error) return undefined
  // After a failed reload the calendar loaded earlier stays in use; before any read succeeds the
  // Monday-to-Friday default is used.
  return calendar.settings ? 'tasks.workspaceCalendar.staleError' : 'tasks.workspaceCalendar.error'
}
