import useSWR from 'swr'
import { getProjectMembers } from '../api/members'
import { getProjectUsers } from '../api/users'
import {
  loadActiveProjectMembers,
  loadPlanningProjectRoles,
  loadWorkspaceProjectMembers,
} from './projectMembers'
import type { ProjectDirectoryProject } from '../api/directory'
import type { PlanningProjectRoleScope } from '../../planning/model/permissions'

const projectMemberQueryConfig = {
  dedupingInterval: 10_000,
  shouldRetryOnError: false,
} as const

/**
 * 単一 Project の member を取得します。
 *
 * @param accessToken - Project API の access token です。
 * @param projectId - 取得対象の Project ID です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Project member の SWR state です。
 */
export function useProjectMembers(
  accessToken: string | undefined,
  projectId: string | undefined,
  enabled = true,
) {
  const key = accessToken && projectId && enabled
    ? ['project-members', accessToken, projectId] as const
    : null

  const queryResult = useSWR(
    key,
    ([, token, currentProjectId]) => getProjectMembers(token, currentProjectId),
    projectMemberQueryConfig,
  )

  return { ...queryResult, key }
}

/**
 * Project member 候補ユーザーの先頭 page を取得します。
 *
 * @param accessToken - Project API の access token です。
 * @param projectId - 取得対象の Project ID です。
 * @param query - User 検索文字列です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Project user page の SWR state です。
 */
export function useProjectUsers(
  accessToken: string | undefined,
  projectId: string | undefined,
  query: string,
  enabled = true,
) {
  const key = accessToken && projectId && enabled
    ? ['project-users', accessToken, projectId, query] as const
    : null

  const queryResult = useSWR(
    key,
    ([, token, currentProjectId, currentQuery]) =>
      getProjectUsers(token, currentProjectId, {
        limit: 20,
        query: currentQuery,
      }),
    projectMemberQueryConfig,
  )

  return { ...queryResult, key }
}

/**
 * 複数 Project の active member を重複除外して取得します。
 *
 * @param accessToken - Project API の access token です。
 * @param projectIds - 取得対象の Project ID 一覧です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Active Project member の集約結果です。
 */
export function useActiveProjectMembers(
  accessToken: string | undefined,
  projectIds: readonly string[],
  enabled = true,
) {
  const key = accessToken && enabled && projectIds.length > 0
    ? ['active-project-members', accessToken, projectIds.join('\0')] as const
    : null

  const query = useSWR(
    key,
    ([, token]) => loadActiveProjectMembers(token, projectIds),
    projectMemberQueryConfig,
  )

  return { ...query, key }
}

/**
 * Team 表示に必要な複数 Project の member を取得します。
 *
 * @param accessToken - Project API の access token です。
 * @param teamId - SWR key を分離する Team ID です。
 * @param projects - 取得対象の Project 一覧です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Project 情報付き member の集約結果です。
 */
export function useWorkspaceProjectMembers(
  accessToken: string | undefined,
  teamId: string | undefined,
  projects: readonly ProjectDirectoryProject[],
  enabled = true,
) {
  const key = accessToken && enabled && projects.length > 0
    ? [
        'workspace-team-project-members',
        accessToken,
        teamId,
        projects.map((project) => project.id).join('\0'),
      ] as const
    : null

  const query = useSWR(
    key,
    ([, token, currentTeamId]) => loadWorkspaceProjectMembers(token, projects, currentTeamId),
    projectMemberQueryConfig,
  )

  return { ...query, key }
}

/**
 * Planning access 判定に必要な Project role を取得します。
 *
 * @param accessToken - Project API の access token です。
 * @param memberKey - Role を解決する member key です。
 * @param projectIds - 取得対象の Project ID 一覧です。
 * @param enabled - Query を実行するかどうかです。
 * @returns Project ID ごとの role 集約結果です。
 */
export function usePlanningProjectRoles(
  accessToken: string | undefined,
  memberKey: string,
  projectScopes: readonly (string | PlanningProjectRoleScope)[],
  enabled = true,
) {
  const key = accessToken && enabled
    ? ['planning-project-roles', accessToken, memberKey, JSON.stringify(projectScopes)] as const
    : null

  const query = useSWR(
    key,
    ([, token]) => loadPlanningProjectRoles(token, memberKey, projectScopes),
    projectMemberQueryConfig,
  )

  return { ...query, key }
}
