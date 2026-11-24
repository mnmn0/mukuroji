import type { WorkspacePrincipal } from './project-access'

/** Principal fields that decide Workspace month close access. */
export type WorkspaceTimePeriodPrincipal = Pick<
  WorkspacePrincipal,
  | 'isSystemAdmin'
  | 'workspaceRole'
  | 'enterprisePermissions'
  | 'enterpriseRouteAuthorizedAtResource'
  | 'enterpriseAuthorizationResource'
>

/**
 * Decides whether a principal may close or reopen a month for every Team (ADR 0076). An Enterprise
 * assignment replaces the legacy Workspace role, so its `workspace.manage` permission at the
 * Workspace decides; otherwise a Workspace owner or admin may. A system administrator may always.
 *
 * @param principal - Authenticated Workspace principal.
 * @returns Whether the principal manages Workspace month closes.
 */
export function canManageWorkspaceTimePeriods(principal: WorkspaceTimePeriodPrincipal): boolean {
  if (principal.isSystemAdmin) return true
  if (principal.enterprisePermissions !== undefined) {
    return principal.enterpriseRouteAuthorizedAtResource === true &&
      principal.enterpriseAuthorizationResource?.kind === 'workspace' &&
      principal.enterprisePermissions.includes('workspace.manage')
  }
  return principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin'
}
