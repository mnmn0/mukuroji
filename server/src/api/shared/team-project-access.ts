import { ProjectDataError } from '../../modules/directory'
import { workspaceDependencies } from './app-dependencies'
import { resolveEnterpriseProjectRole } from './enterprise-access'
import { createPlanningCallerAuthorizationConditionChecks } from './planning-access'
import {
  canAccessAssignedProject,
  canWorkspaceBusinessWrite,
  hasEnterprisePermissionAtResource,
  requireTeamPermission,
  type WorkspacePrincipal,
} from './project-access'
import type { TeamPermissionContext } from './workspace-access'

/**
 * Requires the Project to belong to the Team and the principal to see it.
 *
 * A Project outside the Team and a Project the principal may not see both answer 404, so the
 * response does not reveal which Projects exist.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 */
export async function requireTeamProjectRead(principal: WorkspacePrincipal, teamId: string, projectId: string) {
  const context = await requireTeamPermission(principal, teamId, 'viewer')
  const inTeam = context.team.projects.some((project) => project.id === projectId)
  if (!inTeam || !canAccessAssignedProject(principal, context, projectId, 'viewer')) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }
}

/**
 * Builds the commit-time fences that fail a Project write when the caller lost access or the Team
 * or Project was archived after the request was authorized.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project whose data is changed.
 * @param unavailableCode - Error code of the 503 raised when the fences cannot be built.
 * @returns The condition checks.
 * @throws ProjectDataError 503 when the directory cannot build the active-reference fences.
 */
export async function createTeamProjectCallerAuthorization(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
  unavailableCode: string,
) {
  const { projectDirectory } = workspaceDependencies
  if (!projectDirectory.createActiveReferenceConditionChecks) {
    throw new ProjectDataError(503, unavailableCode, 'Project access cannot be verified.')
  }
  return [
    ...createPlanningCallerAuthorizationConditionChecks(
      principal,
      [],
      principal.principalKind !== 'service-account',
    ),
    ...await projectDirectory.createActiveReferenceConditionChecks(principal.directoryId, teamId, projectId),
  ]
}

/**
 * Tells whether the principal may change a Team-owned Project's data, such as its log or share links: a writable Workspace session, member
 * access to the Project resolved at the Team write level (so a Team-wide grant such as an
 * Enterprise Team member keeps its effective role), and, for an Enterprise principal,
 * `projects.write` on the Project.
 *
 * @remarks
 * The Enterprise Project accesses on the principal carry the role of the current route's
 * permission, so on a read they are viewer even for a Project member. Once `projects.write`
 * holds on this Project, the check uses the role that grant gives, the same role a write
 * request resolves, so the read reports the access the write will get.
 *
 * @param principal - Authenticated principal.
 * @param teamId - Team that owns the Project.
 * @param projectId - Project ID.
 * @returns Whether the principal may write.
 */
export async function canWriteTeamProject(principal: WorkspacePrincipal, teamId: string, projectId: string) {
  if (!canWorkspaceBusinessWrite(principal)) return false
  let writer = principal
  if (principal.enterprisePermissions !== undefined) {
    if (!hasEnterprisePermissionAtResource(principal, 'projects.write', {
      workspaceId: principal.directoryId,
      kind: 'project',
      targetId: projectId,
      parentTeamId: teamId,
    })) {
      return false
    }
    writer = {
      ...principal,
      enterpriseProjectAccesses: [
        ...(principal.enterpriseProjectAccesses ?? []).filter((access) =>
          access.projectId !== projectId || (access.teamId !== undefined && access.teamId !== teamId)
        ),
        { teamId, projectId, role: resolveEnterpriseProjectRole(['projects.write']) },
      ],
    }
  }
  let context: TeamPermissionContext
  try {
    context = await requireTeamPermission(writer, teamId, 'member')
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
  return canAccessAssignedProject(writer, context, projectId, 'member')
}
