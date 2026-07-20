import useSWR from 'swr'
import {
  getProjectIssues,
  getTeamIssueDetail,
  getTeamIssues,
  getWorkspaceWorkItems,
} from '../api/workItems'

const workItemQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * Team の Work Item 一覧を取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param teamId - 取得対象の Team ID です。
 * @param enabled - Query を実行するかどうかです。
 * @param scope - 同じTeam一覧を異なる用途で分離するSWR key scopeです。
 * @returns Team Work Item 一覧の SWR state です。
 */
export function useTeamIssues(
  accessToken: string | undefined,
  teamId: string | undefined,
  enabled = true,
  scope = 'team-issues',
) {
  const key = accessToken && teamId && enabled
    ? [scope, accessToken, teamId] as const
    : null

  const query = useSWR(
    key,
    ([, token, currentTeamId]) => getTeamIssues(currentTeamId, token),
    workItemQueryConfig,
  )

  return { ...query, key }
}

/**
 * Project に割り当てられた Work Item 一覧を取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param projectId - 取得対象の Project ID です。
 * @param enabled - Query を実行するかどうかです。
 * @param normalizeError - Legacy Project task error へ変換する関数です。
 * @returns Project Work Item 一覧の SWR state です。
 */
export function useProjectIssues(
  accessToken: string | undefined,
  projectId: string | undefined,
  enabled = true,
  normalizeError: (error: unknown) => unknown = (error) => error,
) {
  const key = accessToken && projectId && enabled
    ? ['project-tasks', accessToken, projectId] as const
    : null

  const query = useSWR(
    key,
    async ([, token, currentProjectId]) => {
      try {
        return await getProjectIssues(currentProjectId, token)
      } catch (error) {
        throw normalizeError(error)
      }
    },
    workItemQueryConfig,
  )

  return { ...query, key }
}

/**
 * Workspace 全体の Work Item 投影を取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Workspace Work Item 一覧の SWR state です。
 */
export function useWorkspaceWorkItems(accessToken?: string, enabled = true) {
  const key = accessToken && enabled
    ? ['workspace-work-items', accessToken] as const
    : null

  const query = useSWR(
    key,
    ([, token]) => getWorkspaceWorkItems(token),
    workItemQueryConfig,
  )

  return { ...query, key }
}

/**
 * Team Work Item の詳細を取得します。
 *
 * @param accessToken - Work Item API の access token です。
 * @param teamId - Work Item を所有する Team ID です。
 * @param issueId - 取得対象の Work Item ID です。
 * @param enabled - Query を実行するかどうかです。
 * @param scope - 詳細queryを利用画面ごとに分離するSWR key scopeです。
 * @returns Work Item 詳細の SWR state です。
 */
export function useTeamIssueDetail(
  accessToken: string | undefined,
  teamId: string | undefined,
  issueId: string | undefined,
  enabled = true,
  scope = 'team-issue-detail',
) {
  const key = accessToken && teamId && issueId && enabled
    ? [scope, accessToken, teamId, issueId] as const
    : null

  const query = useSWR(
    key,
    ([, token, currentTeamId, currentIssueId]) =>
      getTeamIssueDetail(currentTeamId, currentIssueId, token),
    workItemQueryConfig,
  )

  return { ...query, key }
}
