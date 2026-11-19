import useSWR from 'swr'
import { getProjectRaidLog } from '../api/raidLog'

/**
 * Builds the SWR key of a Project log.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The scope-bound cache key.
 */
export function projectRaidLogKey(accessToken: string, teamId: string, projectId: string) {
  return ['project-raid-log', accessToken, teamId, projectId] as const
}

/**
 * Reads the risk, issue, and change request log of a Project.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team that owns the Project; reading is skipped without it.
 * @param projectId - Project ID.
 * @param enabled - Whether the current session may load the log.
 * @returns SWR state of the log response.
 */
export function useProjectRaidLog(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId: string,
  enabled: boolean,
) {
  return useSWR(
    accessToken && teamId && enabled ? projectRaidLogKey(accessToken, teamId, projectId) : null,
    ([, token, currentTeamId, currentProjectId]) => getProjectRaidLog(token, currentTeamId, currentProjectId),
    { shouldRetryOnError: false },
  )
}
