import {
  getProjectMembers,
  isActiveProjectAssignmentCandidate,
  type ProjectMember,
  type ProjectMemberRole,
} from '../api/members'
import type { ProjectDirectoryProject } from '../api/directory'
import type { TeamProjectMemberAccess } from '../model/teamInsights'
import type { PlanningProjectRoleScope } from '../../planning/model/permissions'

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
  return loadProjectMembersForScope(accessToken, projects)
}

/**
 * Loads Project members through Team-qualified Project scopes.
 *
 * @param accessToken - Bearer token for the Project member API.
 * @param teamId - Team that owns every requested Project.
 * @param projects - Projects currently visible in that Team directory.
 * @returns Project members, failed Project IDs, and request errors.
 */
export async function loadTeamProjectMembers(
  accessToken: string,
  teamId: string,
  projects: readonly ProjectDirectoryProject[],
) {
  return loadProjectMembersForScope(accessToken, projects, teamId)
}

/**
 * Loads Project members for either an unqualified or Team-qualified scope.
 *
 * @param accessToken - Bearer token for the Project member API.
 * @param projects - Projects to load.
 * @param teamId - Optional Team scope used to qualify duplicate Project IDs.
 * @returns Project members, failed Project IDs, and request errors.
 */
async function loadProjectMembersForScope(
  accessToken: string,
  projects: readonly ProjectDirectoryProject[],
  teamId?: string,
) {
  const results = await Promise.allSettled(
    projects.map(async (project) => ({
      members: await getProjectMembers(accessToken, project.id, teamId),
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
 * Loads the selected member's Project roles for Planning authorization.
 *
 * Team-qualified scopes use a Team-aware API request and are returned under a composite
 * `teamId\0projectId` key. An unqualified Project scope also receives a `projectId` key only when
 * that Project appears once, which avoids ambiguity when the same Project ID exists in multiple
 * Teams. Individual request failures are returned in `errors` instead of rejecting the aggregate.
 *
 * @param accessToken - Bearer token for the Project directory API.
 * @param memberKey - Member ID whose role should be resolved.
 * @param projectScopes - Unqualified Project IDs or Team-qualified Project scopes.
 * @returns Resolved role keys and request errors for failed scopes.
 */
export async function loadPlanningProjectRoles(
  accessToken: string,
  memberKey: string,
  projectScopes: readonly (string | PlanningProjectRoleScope)[],
) {
  const scopes: Array<{ projectId: string; teamId?: string }> = projectScopes.map((scope) => typeof scope === 'string'
    ? { projectId: scope }
    : scope)
  const projectIdCounts = new Map<string, number>()
  for (const scope of scopes) {
    projectIdCounts.set(scope.projectId, (projectIdCounts.get(scope.projectId) ?? 0) + 1)
  }
  const responses = await Promise.allSettled(
    scopes.map(async (scope) => ({
      scope,
      members: await getProjectMembers(accessToken, scope.projectId, scope.teamId),
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
      const { projectId, teamId } = response.value.scope
      if (teamId !== undefined) roles[`${teamId}\0${projectId}`] = member.role
      if (projectIdCounts.get(projectId) === 1) roles[projectId] = member.role
    }
  }

  return {
    errors: responses.flatMap((response) =>
      response.status === 'rejected' ? [response.reason] : []
    ),
    roles,
  }
}
