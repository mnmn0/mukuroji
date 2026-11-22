import type { PlanningEntity } from '@mukuroji/contracts'
import type { ProjectRole } from '../../modules/directory'
import { PlanningError } from '../../modules/planning'
import { workspaceDependencies } from './app-dependencies'
import { readPlanningIdentifier } from './planning-access'
import {
  requireProjectPermission,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from './project-access'

/**
 * Requires a Planning owner to be an active Workspace member.
 *
 * @param principal - Authenticated Workspace principal.
 * @param ownerMemberKey - Untrusted owner member key.
 * @returns The active owner.
 */
export async function requirePlanningActiveOwner(
  principal: WorkspacePrincipal,
  ownerMemberKey: unknown,
) {
  const memberKey = readPlanningIdentifier(ownerMemberKey, 'Planning owner member key')
  const owner = await workspaceDependencies.workspaceAccess.getActiveMember(principal.directoryId, memberKey)
  if (!owner) {
    throw new PlanningError(
      409,
      'PlanningOwnerInactive',
      'Planning owner must be an active Workspace member.',
    )
  }
  return owner
}

/**
 * Requires the caller to hold a role at a Planning entity's Team / Project scope.
 *
 * A Workspace-scope entity needs Workspace administration unless `allowWorkspaceScopeMember`.
 *
 * @param principal - Authenticated Workspace principal.
 * @param scope - Team / Project scope of the entity.
 * @param minimumRole - Least role required at that scope.
 * @param allowWorkspaceScopeMember - Whether a Workspace-scope entity is open to members.
 */
export async function requirePlanningScopePermission(
  principal: WorkspacePrincipal,
  scope: Pick<PlanningEntity, 'teamId' | 'projectId'>,
  minimumRole: Extract<ProjectRole, 'member' | 'manager'>,
  allowWorkspaceScopeMember = false,
) {
  requireWorkspaceBusinessWrite(principal)
  const teamId = scope.teamId === undefined
    ? undefined
    : readPlanningIdentifier(scope.teamId, 'Team ID')
  const projectId = scope.projectId === undefined
    ? undefined
    : readPlanningIdentifier(scope.projectId, 'Project ID')
  if (teamId && !projectId && principal.enterprisePermissions !== undefined) {
    const resource = principal.enterpriseAuthorizationResource
    if (
      !principal.enterpriseRouteAuthorizedAtResource ||
      !resource ||
      (
        resource.kind !== 'workspace' &&
        !(resource.kind === 'team' && resource.targetId === teamId)
      )
    ) {
      throw new PlanningError(
        403,
        'ProjectAccessDenied',
        'Enterprise Team permission is required for this Planning scope.',
      )
    }
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
    if (!directory.teams.some((team) => team.id === teamId)) {
      throw new PlanningError(404, 'TeamNotFound', 'Planning Team was not found.')
    }
    return
  }
  const teamContext = teamId
    ? await requireTeamPermission(principal, teamId, minimumRole)
    : undefined
  if (projectId) {
    await requireProjectPermission(principal, projectId, minimumRole, teamId)
  }
  if (
    teamContext &&
    projectId &&
    !teamContext.team.projects.some((project) => project.id === projectId)
  ) {
    throw new PlanningError(
      409,
      'PlanningScopeMismatch',
      'Planning Team and Project scopes do not belong to the same hierarchy.',
    )
  }
  if (!teamId && !projectId && !principal.isSystemAdmin && !allowWorkspaceScopeMember) {
    requireWorkspaceAdministration(principal)
  }
}

/**
 * Finds a Planning entity and requires the caller to hold a role at its scope.
 *
 * @param principal - Authenticated Workspace principal.
 * @param entities - Planning entities to search.
 * @param entityId - Untrusted entity ID.
 * @param minimumRole - Least role required at the entity scope.
 * @param allowWorkspaceScopeMember - Whether a Workspace-scope entity is open to members.
 * @returns The entity.
 */
export async function requirePlanningEntityPermission(
  principal: WorkspacePrincipal,
  entities: readonly PlanningEntity[],
  entityId: unknown,
  minimumRole: Extract<ProjectRole, 'member' | 'manager'>,
  allowWorkspaceScopeMember = false,
) {
  const normalizedEntityId = readPlanningIdentifier(entityId, 'Planning entity ID')
  const entity = entities.find((candidate) => candidate.id === normalizedEntityId)
  if (!entity) {
    throw new PlanningError(404, 'PlanningEntityNotFound', 'Planning entity was not found.')
  }
  await requirePlanningScopePermission(
    principal,
    entity,
    minimumRole,
    allowWorkspaceScopeMember,
  )
  return entity
}
