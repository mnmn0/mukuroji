import { ProjectDataError } from '../../modules/directory'
import {
  canAccessAssignedProject,
  principalManagesTeamWorkItem,
  requireTeamPermission,
  type ProjectPrincipal,
} from './project-access'
import type { TeamPermissionContext } from './workspace-access'

/**
 * Requires the principal to manage the Work Item's assigned Project or its Team.
 *
 * A manager role on another Project of the same Team is not enough for an assigned Work Item:
 * only that Project's managers, a direct Team manager grant, or a system administrator may act.
 * An unassigned Work Item belongs to the Team alone, so any Team manager may.
 * An enterprise principal's context carries the roles of the permission that granted the route,
 * such as `work-items.write`, so its manager roles are read from its role assignments instead.
 *
 * @param principal - Authenticated Workspace principal.
 * @param teamId - Team that owns the Work Item.
 * @param context - Team permission context already resolved for the update.
 * @param assignedProjectId - Project the Work Item is assigned to, if any.
 * @param deniedMessage - Message of the `403` when the principal is not a manager.
 * @returns Nothing when the principal is a manager of the Work Item.
 * @throws ProjectDataError when the principal is not a manager.
 */
export async function requireWorkItemManagerPermission(
  principal: ProjectPrincipal,
  teamId: string,
  context: TeamPermissionContext,
  assignedProjectId: string | undefined,
  deniedMessage: string,
): Promise<void> {
  if (principal.isSystemAdmin) return
  if (
    principal.enterpriseAuthorizationEvaluation !== undefined &&
    principalManagesTeamWorkItem(principal, context, assignedProjectId)
  ) {
    return
  }
  if (!assignedProjectId) {
    await requireTeamPermission(principal, teamId, 'manager')
    return
  }
  if (canAccessAssignedProject(principal, context, assignedProjectId, 'manager')) return
  // The update route's context is read at member level, so a direct Team member grant can hide a
  // Project manager role; re-read the roles at manager level before deciding.
  const teamContext = await requireTeamPermission(principal, teamId, 'manager')
  if (teamContext.directTeamGrant) return
  if (canAccessAssignedProject(principal, teamContext, assignedProjectId, 'manager')) return
  throw new ProjectDataError(403, 'ProjectAccessDenied', deniedMessage)
}
