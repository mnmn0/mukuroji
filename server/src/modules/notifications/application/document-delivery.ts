import type { EnterpriseIdentitySnapshot } from '@mukuroji/contracts'
import { DocumentError, type DocumentAccessContext, type DocumentProjectRole, type GetDocumentRequest } from '../../documents'
import { evaluateEnterpriseAccess, resolveEnterpriseDirectoryPrincipal, type EnterpriseAuthorizationResource } from '../../enterprise-identity'

/** Current recipient and directory context for document notification delivery. */
export type DocumentDeliveryAccessInput = {
  /** Canonical workspace containing the document and recipient. */
  workspaceId: string
  /** Active recipient's normalized membership key. */
  memberKey: string
  /** Current workspace membership role. */
  workspaceRole: DocumentAccessContext['workspaceRole']
  /** Current Cognito system-administrator membership. */
  isSystemAdmin: boolean
  /** Current unambiguous legacy Project roles. */
  projectRoles: Record<string, DocumentProjectRole>
  /** Active Projects with uniquely identified owning Teams. */
  projects: Array<{
    /** Current owning Team ID. */
    teamId: string
    /** Project ID within the workspace. */
    projectId: string
  }>
  /** Current authoritative Enterprise Identity snapshot. */
  snapshot: EnterpriseIdentitySnapshot
}

/**
 * Builds the same document-specific RBAC boundary used by Inbox visibility.
 * @param input - Current recipient membership, directory and Enterprise state.
 * @returns A Documents access context, or undefined for inconsistent scope.
 */
export function resolveDocumentDeliveryAccess(input: DocumentDeliveryAccessInput): DocumentAccessContext | undefined {
  if (input.snapshot.workspaceId !== input.workspaceId) return undefined
  const directory = resolveEnterpriseDirectoryPrincipal(input.snapshot, input.memberKey, [])
  if (directory.deprovisioned && !input.isSystemAdmin) return undefined
  const authoritative = directory.directoryManaged ||
    directory.compatibleRoleAssignments.some((assignment) =>
      assignment.principalKind === 'member' && assignment.principalId.trim().toLowerCase() === input.memberKey ||
      assignment.principalKind === 'directory-group' && (
        assignment.source === 'directory-mapping' || directory.directoryGroupIds.includes(assignment.principalId)
      )
    ) || directory.compatibleGroupMappings.some((mapping) => mapping.enabled)
  const access: DocumentAccessContext = {
    memberKey: input.memberKey, workspaceRole: input.workspaceRole,
    isSystemAdmin: input.isSystemAdmin, projectRoles: input.projectRoles,
  }
  if (!authoritative || input.isSystemAdmin) return access

  /** Resolves the strongest document permission at one current resource scope. */
  function roleFor(resource: EnterpriseAuthorizationResource): DocumentProjectRole | undefined {
    for (const [permission, role] of [
      ['documents.manage', 'manager'], ['documents.write', 'member'], ['documents.read', 'viewer'],
    ] as const) {
      if (evaluateEnterpriseAccess({
        permission,
        principal: {
          kind: 'member', principalId: input.memberKey, workspaceRole: input.workspaceRole,
          directoryGroupIds: directory.directoryGroupIds,
          directoryGroupMemberships: directory.directoryGroupMemberships,
          includeWorkspaceRolePermissions: false, directPermissions: ['workspace.read'], systemAdministrator: false,
        },
        assignments: directory.compatibleRoleAssignments,
        groupMappings: directory.compatibleGroupMappings,
        customRoles: input.snapshot.customRoles, resource,
        ...(resource.kind === 'project' && resource.parentTeamId ? { projectScopeOwnerTeamId: resource.parentTeamId } : {}),
      }).allowed) return role
    }
    return undefined
  }

  const projectRoles: Record<string, DocumentProjectRole> = {}
  for (const project of input.projects) {
    const role = roleFor({ workspaceId: input.workspaceId, kind: 'project', targetId: project.projectId, parentTeamId: project.teamId })
    if (role) projectRoles[project.projectId] = role
  }
  return {
    ...access, projectRoles, restrictToAuthorizedScopes: true,
    workspaceScopeRole: roleFor({ workspaceId: input.workspaceId, kind: 'workspace' }),
  }
}

/**
 * Rechecks a document's current ACL and ancestors through the Inbox's Documents read capability.
 * @param workspaceId - Canonical notification workspace.
 * @param documentId - Stored source document ID, never inferred from a URL.
 * @param access - Current recipient access context.
 * @param readDocument - Permission-filtered Documents read, invoked afresh for every delivery.
 * @returns Whether the recipient can still view the source; transient failures propagate for retry.
 */
export async function isDocumentDeliveryVisible(
  workspaceId: string,
  documentId: string | undefined,
  access: DocumentAccessContext | undefined,
  readDocument: (request: GetDocumentRequest) => Promise<unknown>,
): Promise<boolean> {
  if (!documentId || !access) return false
  try {
    await readDocument({ workspaceId, documentId, access })
    return true
  } catch (error: unknown) {
    if (error instanceof DocumentError && (error.status === 403 || error.status === 404)) return false
    throw error
  }
}
