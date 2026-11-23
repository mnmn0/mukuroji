import useSWR from 'swr'
import { getWorkCalendar } from '../api/workCalendar'

/** SWR options for shared calendars; a failure stays visible instead of retrying silently. */
const workCalendarQueryConfig = {
  dedupingInterval: 30_000,
  revalidateOnFocus: false,
  shouldRetryOnError: false,
} as const

/**
 * Reads the calendar of a Team, or of one of its Projects, with the calendar new Work Items take.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team to read; reading is skipped without it.
 * @param projectId - Project to read; omitted for the Team calendar.
 * @param enabled - Whether the query may run.
 * @returns SWR state of the calendar.
 */
export function useWorkCalendar(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId?: string,
  enabled = true,
) {
  return useSWR(
    accessToken && teamId && enabled
      ? ['work-calendar', accessToken, teamId, projectId ?? ''] as const
      : null,
    ([, token, currentTeamId, currentProjectId]) =>
      getWorkCalendar(token, currentTeamId, currentProjectId || undefined),
    workCalendarQueryConfig,
  )
}
