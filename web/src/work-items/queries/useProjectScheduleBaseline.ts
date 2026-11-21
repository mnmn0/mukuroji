import useSWR from 'swr'
import { getProjectScheduleBaseline } from '../api/scheduleBaseline'

/** First element of every single-Project baseline cache key. */
export const PROJECT_SCHEDULE_BASELINE_KEY = 'project-schedule-baseline'

/**
 * Builds the SWR key of a Project schedule baseline.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @param baselineId - Saved baseline ID, or undefined for the active baseline.
 * @returns The scope-bound cache key.
 */
export function projectScheduleBaselineKey(
  accessToken: string,
  teamId: string,
  projectId: string,
  baselineId?: string,
) {
  return [PROJECT_SCHEDULE_BASELINE_KEY, accessToken, teamId, projectId, baselineId ?? ''] as const
}

/**
 * Reads the active schedule baseline of a Project, or one saved baseline.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID; reading is skipped without it.
 * @param baselineId - Saved baseline ID, or undefined for the active baseline.
 * @param enabled - Whether to read at all.
 * @returns SWR state of the baseline response.
 */
export function useProjectScheduleBaseline(
  accessToken: string | undefined,
  teamId: string,
  projectId: string | undefined,
  baselineId?: string,
  enabled = true,
) {
  return useSWR(
    enabled && accessToken && projectId ? projectScheduleBaselineKey(accessToken, teamId, projectId, baselineId) : null,
    ([, token, currentTeamId, currentProjectId, currentBaselineId]) =>
      getProjectScheduleBaseline(currentTeamId, currentProjectId, token, currentBaselineId || undefined),
    { shouldRetryOnError: false },
  )
}
