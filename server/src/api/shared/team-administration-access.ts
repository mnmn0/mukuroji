import { evaluateEnterpriseAccess } from '../../modules/enterprise-identity'
import type { WorkspacePrincipal } from './project-access'

/**
 * Tells the Web whether to offer the Team settings, whose directory listing authorizes at the
 * Workspace; the Team routes still authorize every request.
 *
 * Without an Enterprise evaluation the built-in owner and admin roles decide. With one, the
 * principal needs `teams.manage` at the Workspace itself, as `GET /api/teams/directory` does.
 *
 * @param principal - Freshly authenticated Workspace principal.
 * @returns Whether the principal may manage Teams across the Workspace.
 */
export function canManageWorkspaceTeams(principal: WorkspacePrincipal): boolean {
  if (principal.isSystemAdmin) return true
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation === undefined) {
    return principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin'
  }
  return evaluateEnterpriseAccess({
    permission: 'teams.manage',
    principal: evaluation.principal,
    assignments: evaluation.assignments,
    customRoles: evaluation.snapshot.customRoles,
    groupMappings: evaluation.groupMappings,
    resource: { workspaceId: principal.directoryId, kind: 'workspace' },
  }).allowed
}
