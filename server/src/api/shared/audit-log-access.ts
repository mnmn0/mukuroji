import type { EnterprisePermissionId } from '@mukuroji/contracts'
import { evaluateEnterpriseAccess } from '../../modules/enterprise-identity'
import type { WorkspacePrincipal } from './project-access'

/**
 * Checks one audit permission at the Workspace itself, independent of the current route.
 *
 * The audit routes authorize at the Workspace, so a Team or Project grant never counts.
 * Without an Enterprise evaluation the built-in Workspace roles decide, matching the
 * permissions those roles carry: owners have both audit permissions and admins only read.
 *
 * @param principal - Freshly authenticated Workspace principal.
 * @param permission - Audit permission to check.
 * @returns Whether the principal holds the permission at the Workspace.
 */
function hasWorkspaceAuditPermission(
  principal: WorkspacePrincipal,
  permission: Extract<EnterprisePermissionId, 'audit.read' | 'audit.export'>,
): boolean {
  if (principal.isSystemAdmin) return true
  const evaluation = principal.enterpriseAuthorizationEvaluation
  if (evaluation === undefined) {
    return principal.workspaceRole === 'owner' ||
      (permission === 'audit.read' && principal.workspaceRole === 'admin')
  }
  return evaluateEnterpriseAccess({
    permission,
    principal: evaluation.principal,
    assignments: evaluation.assignments,
    customRoles: evaluation.snapshot.customRoles,
    groupMappings: evaluation.groupMappings,
    resource: { workspaceId: principal.directoryId, kind: 'workspace' },
  }).allowed
}

/**
 * Tells the Web whether to show the audit log; the audit routes still authorize every request.
 *
 * @param principal - Freshly authenticated Workspace principal.
 * @returns Whether the principal may search audit events.
 */
export function canReadWorkspaceAuditLog(principal: WorkspacePrincipal): boolean {
  return hasWorkspaceAuditPermission(principal, 'audit.read') ||
    hasWorkspaceAuditPermission(principal, 'audit.export')
}

/**
 * Tells the Web whether to offer audit exports; the export routes still authorize every request.
 *
 * @param principal - Freshly authenticated Workspace principal.
 * @returns Whether the principal may request and download audit exports.
 */
export function canExportWorkspaceAuditLog(principal: WorkspacePrincipal): boolean {
  return hasWorkspaceAuditPermission(principal, 'audit.export')
}
