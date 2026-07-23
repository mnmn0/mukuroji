import {
  getProjectMembers,
  isActiveProjectAssignmentCandidate,
  type ProjectMember,
  type ProjectMemberRole,
} from '../api/members'
import type { ProjectDirectoryProject } from '../api/directory'
import type { TeamProjectMemberAccess } from '../model/teamInsights'

/**
 * 複数 Project の member を Workspace の Team 表示用にまとめて取得します。
 *
 * @param accessToken - Project member API の access token です。
 * @param projects - 取得対象の Project 一覧です。
 * @returns Project 情報付き member、失敗した Project ID、取得 error です。
 */
export async function loadWorkspaceProjectMembers(
  accessToken: string,
  projects: readonly ProjectDirectoryProject[],
) {
  const results = await Promise.allSettled(
    projects.map(async (project) => ({
      members: await getProjectMembers(accessToken, project.id),
      project,
    })),
  )
  const members: TeamProjectMemberAccess[] = []
  const failedProjectIds: string[] = []
  const errors: unknown[] = []

  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') {
      for (const member of result.value.members) {
        members.push({
          projectId: result.value.project.id,
          projectName: result.value.project.name,
          member,
        })
      }
    } else {
      errors.push(result.reason)
      const failedProjectId = projects[index]?.id

      if (failedProjectId) {
        failedProjectIds.push(failedProjectId)
      }
    }
  }

  return {
    errors,
    failedProjectIds,
    members,
  }
}

/**
 * 複数 Project の active な assignment candidate を重複除外して取得します。
 *
 * @param accessToken - Project member API の access token です。
 * @param projectIds - 取得対象の Project ID 一覧です。
 * @returns Active member と取得 error です。
 */
export async function loadActiveProjectMembers(
  accessToken: string,
  projectIds: readonly string[],
) {
  const responses = await Promise.allSettled(
    projectIds.map((projectId) => getProjectMembers(accessToken, projectId)),
  )
  const membersById = new Map<string, ProjectMember>()

  for (const response of responses) {
    if (response.status !== 'fulfilled') {
      continue
    }

    for (const member of response.value) {
      membersById.set(member.id, member)
    }
  }

  return {
    errors: responses.flatMap((response) =>
      response.status === 'rejected' ? [response.reason] : []
    ),
    members: Array.from(membersById.values()).filter(isActiveProjectAssignmentCandidate),
  }
}

/**
 * Planning 画面で利用する Project ごとの member role を取得します。
 *
 * @param accessToken - Project member API の access token です。
 * @param memberKey - Role を解決する member ID です。
 * @param projectIds - 取得対象の Project ID 一覧です。
 * @returns Project ID ごとの role と取得 error です。
 */
export async function loadPlanningProjectRoles(
  accessToken: string,
  memberKey: string,
  projectIds: readonly string[],
) {
  const responses = await Promise.allSettled(
    projectIds.map(async (projectId) => ({
      projectId,
      members: await getProjectMembers(accessToken, projectId),
    })),
  )
  const roles: Record<string, ProjectMemberRole> = {}

  for (const response of responses) {
    if (response.status !== 'fulfilled') {
      continue
    }

    const member = response.value.members.find(
      (candidate) => candidate.id.trim().toLowerCase() === memberKey,
    )

    if (member) {
      roles[response.value.projectId] = member.role
    }
  }

  return {
    errors: responses.flatMap((response) =>
      response.status === 'rejected' ? [response.reason] : []
    ),
    roles,
  }
}
