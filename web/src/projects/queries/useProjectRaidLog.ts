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
 * @param onError - Receives each failed load with the access token it was sent with, so an
 * expired session can be sent to sign in again without acting on a token already replaced.
 * @returns SWR state of the log response.
 */
export function useProjectRaidLog(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId: string,
  enabled: boolean,
  onError?: (error: unknown, requestAccessToken: string) => void,
) {
  return useSWR(
    accessToken && teamId && enabled ? projectRaidLogKey(accessToken, teamId, projectId) : null,
    async ([, token, currentTeamId, currentProjectId]) => {
      try {
        return await getProjectRaidLog(token, currentTeamId, currentProjectId)
      } catch (error) {
        onError?.(error, token)
        throw error
      }
    },
    { shouldRetryOnError: false },
  )
}
