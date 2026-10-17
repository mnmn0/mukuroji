import { hasEnterpriseWorkspacePermission, type WorkspacePrincipal } from './project-access'

/**
 * Checks exact Workspace management access without trusting a weaker route authorization.
 *
 * @param principal - Freshly authenticated Workspace principal.
 * @returns Whether the principal may manage AI policy and Request Intake source content.
 */
export function canManageAiAssistanceWorkspace(principal: WorkspacePrincipal): boolean {
  if (principal.isSystemAdmin) {
    // A Cognito system-admin group is not a durable commit-time fence. Only
    // retain the bypass when the Workspace membership itself is a durable
    // manager authorization checked by the policy transaction; otherwise fail
    // closed instead of relying on a group that can disappear mid-request.
    return principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin'
  }
  if (principal.enterprisePermissions !== undefined) {
    return hasEnterpriseWorkspacePermission(principal, 'workspace.manage')
  }
  return principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin'
}
