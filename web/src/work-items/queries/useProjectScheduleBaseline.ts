import useSWR from 'swr'
import { getProjectScheduleBaseline } from '../api/scheduleBaseline'

/**
 * Builds the SWR key of a Project schedule baseline.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The scope-bound cache key.
 */
export function projectScheduleBaselineKey(accessToken: string, teamId: string, projectId: string) {
  return ['project-schedule-baseline', accessToken, teamId, projectId] as const
}

/**
 * Reads the latest schedule baseline of a Project.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID; reading is skipped without it.
 * @returns SWR state of the baseline response.
 */
export function useProjectScheduleBaseline(
  accessToken: string | undefined,
  teamId: string,
  projectId: string | undefined,
) {
  return useSWR(
    accessToken && projectId ? projectScheduleBaselineKey(accessToken, teamId, projectId) : null,
    ([, token, currentTeamId, currentProjectId]) =>
      getProjectScheduleBaseline(currentTeamId, currentProjectId, token),
    { shouldRetryOnError: false },
  )
}
