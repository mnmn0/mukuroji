import useSWR from 'swr'
import { getProjectDecisionLog, getTeamDecisionLog, type TeamDecisionLogQuery } from '../api/decisionLog'

/**
 * Builds the SWR key of a Project decision log.
 *
 * @param accessToken - Session access token.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns The scope-bound cache key.
 */
export function projectDecisionLogKey(accessToken: string, teamId: string, projectId: string) {
  return ['project-decision-log', accessToken, teamId, projectId] as const
}

/**
 * Tells whether an SWR key belongs to a Team decision log of the given Team, so a save can
 * reload every filtered view of it.
 *
 * @param key - SWR cache key.
 * @param teamId - Team whose views to match.
 * @returns Whether the key is a Team decision log key of the Team.
 */
export function isTeamDecisionLogKey(key: unknown, teamId: string) {
  return Array.isArray(key) && key[0] === 'team-decision-log' && key[2] === teamId
}

/**
 * Reads the decisions of a Project.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team that owns the Project; reading is skipped without it.
 * @param projectId - Project ID; reading is skipped without it.
 * @param enabled - Whether the current session may load the log.
 * @returns SWR state of the log response.
 */
export function useProjectDecisionLog(
  accessToken: string | undefined,
  teamId: string | undefined,
  projectId: string | undefined,
  enabled: boolean,
) {
  return useSWR(
    accessToken && teamId && projectId && enabled ? projectDecisionLogKey(accessToken, teamId, projectId) : null,
    async ([, token, currentTeamId, currentProjectId]) => await getProjectDecisionLog(token, currentTeamId, currentProjectId),
    { shouldRetryOnError: false },
  )
}

/**
 * Reads the decisions and decided change requests of a Team's Projects.
 *
 * @param accessToken - Session access token; reading is skipped without it.
 * @param teamId - Team ID; reading is skipped without it.
 * @param query - Keyword and Project filters.
 * @param enabled - Whether the current session may load the log.
 * @returns SWR state of the Team log response.
 */
export function useTeamDecisionLog(
  accessToken: string | undefined,
  teamId: string | undefined,
  query: TeamDecisionLogQuery,
  enabled: boolean,
) {
  return useSWR(
    accessToken && teamId && enabled
      ? ['team-decision-log', accessToken, teamId, query.keyword ?? '', query.projectId ?? ''] as const
      : null,
    async ([, token, currentTeamId, keyword, projectId]) => await getTeamDecisionLog(token, currentTeamId, {
      ...(keyword ? { keyword } : {}),
      ...(projectId ? { projectId } : {}),
    }),
    { shouldRetryOnError: false, keepPreviousData: true },
  )
}
