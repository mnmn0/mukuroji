import useSWR from 'swr'
import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  type WorkspaceCalendarSettings,
} from '@mukuroji/contracts'
import { getWorkspaceCalendarSettings } from '../api/tenantAdministration'

const workspaceCalendarSettingsQueryConfig = {
  dedupingInterval: 60_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Loads the Workspace fiscal year and week settings for any member.
 *
 * Until the read lands, or when it fails, the defaults apply, so periods keep the behavior
 * from before the settings existed instead of blocking the screen.
 *
 * @param accessToken - Bearer token used for the read.
 * @param enabled - Whether the query may run.
 * @returns The effective settings and whether they came from the server.
 */
export function useWorkspaceCalendarSettings(
  accessToken?: string,
  enabled = true,
): { settings: WorkspaceCalendarSettings; isLoaded: boolean } {
  const key = accessToken && enabled
    ? ['workspace-calendar-settings', accessToken] as const
    : null
  const query = useSWR(
    key,
    ([, token]) => getWorkspaceCalendarSettings(token),
    workspaceCalendarSettingsQueryConfig,
  )
  return {
    settings: query.data ?? DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
    isLoaded: query.data !== undefined || query.error !== undefined,
  }
}
