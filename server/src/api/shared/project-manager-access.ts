import { ProjectDataError } from '../../modules/directory'
import { canAccessAssignedProject, requireTeamPermission } from './project-access'
import { projectAccessAllows, type TeamPermissionContext } from './workspace-access'

/** Principal shape the Team-qualified Project checks read. */
type ProjectAccessPrincipal = Parameters<typeof canAccessAssignedProject>[0]

/**
 * Reports whether the principal holds a role on a Project of this exact Team.
 *
 * Project IDs may repeat across Teams, so a grant counts only when its owner Team is the
 * requested Team, not merely when its Project ID matches.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context.
 * @param teamId - Requested Team.
 * @param projectId - Project ID, or undefined for a Work Item outside any Project.
 * @param minimumRole - Role the action needs.
 * @returns Whether the principal may act on the Project.
 */
export function canAccessTeamProject(
  principal: ProjectAccessPrincipal,
  context: TeamPermissionContext,
  teamId: string,
  projectId: string | undefined,
  minimumRole: 'viewer' | 'manager',
) {
  if (principal.isSystemAdmin) return true
  if (projectId === undefined) return canAccessAssignedProject(principal, context, undefined, minimumRole)
  return (context.projectAccesses ?? []).some((access) =>
    access.teamId === teamId && access.projectId === projectId && projectAccessAllows(access, minimumRole))
}

/**
 * Requires the Project to belong to the Team and the principal to hold at least a viewer role
 * on it there.
 *
 * A Project outside the Team and a Project the principal may not use both answer 404, so the
 * response does not reveal which Projects exist.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context.
 * @param teamId - Requested Team.
 * @param projectId - Project ID.
 * @throws ProjectDataError 404 `ProjectNotFound`.
 */
export function requireTeamProjectAccess(
  principal: ProjectAccessPrincipal,
  context: TeamPermissionContext,
  teamId: string,
  projectId: string,
) {
  const inTeam = context.team.id === teamId && context.team.projects.some((project) => project.id === projectId)
  if (!inTeam || !canAccessTeamProject(principal, context, teamId, projectId, 'viewer')) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }
}

/**
 * Requires the principal to manage the Project in this Team.
 *
 * The route reads the Team context at viewer level, and a direct Team grant then reports every
 * Project role as viewer, which would hide a manager. The roles are read again at manager
 * level before refusing.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context read at viewer level.
 * @param teamId - Requested Team.
 * @param projectId - Project ID.
 * @param createForbidden - Builds the refusal the route answers when the principal is not a manager.
 * @throws ProjectDataError 404 when the Project is not visible, or the error `createForbidden` builds.
 */
export async function requireTeamProjectManager(
  principal: ProjectAccessPrincipal,
  context: TeamPermissionContext,
  teamId: string,
  projectId: string,
  createForbidden: () => Error,
) {
  requireTeamProjectAccess(principal, context, teamId, projectId)
  if (canAccessTeamProject(principal, context, teamId, projectId, 'manager')) return
  let managerContext: TeamPermissionContext
  try {
    managerContext = await requireTeamPermission(principal, teamId, 'manager')
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) throw createForbidden()
    throw error
  }
  if (managerContext.directTeamGrant) return
  if (canAccessTeamProject(principal, managerContext, teamId, projectId, 'manager')) return
  throw createForbidden()
}
