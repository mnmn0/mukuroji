import useSWR from 'swr'
import { getTeamReminderSettings } from '../api/teamReminders'

/**
 * Loads a Team's reminder settings.
 *
 * @param accessToken - API access token.
 * @param teamId - Team ID, or undefined while the route resolves.
 * @param enabled - Whether the query may run.
 * @returns SWR state for the Team's reminder settings.
 */
export function useTeamReminderSettingsQuery(
  accessToken: string | undefined,
  teamId: string | undefined,
  enabled = true,
) {
  const key = accessToken && teamId && enabled
    ? ['team-notification-reminders', accessToken, teamId] as const
    : null
  return useSWR(
    key,
    ([, token, team]) => getTeamReminderSettings(token, team),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  )
}
