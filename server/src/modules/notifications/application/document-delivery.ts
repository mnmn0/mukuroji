import type { EnterpriseIdentitySnapshot, EnterprisePermissionId } from '@mukuroji/contracts'
import { DocumentError, type DocumentAccessContext, type DocumentProjectRole, type GetDocumentRequest } from '../../documents'
import { evaluateEnterpriseAccess, resolveEnterpriseDirectoryPrincipal, type EnterpriseAuthorizationResource } from '../../enterprise-identity'

/** Current recipient and directory context for document notification delivery. */
export type DocumentDeliveryAccessInput = {
  /** Canonical workspace containing the document and recipient. */
  workspaceId: string
  /** Active recipient's normalized membership key. */
  memberKey: string
  /** Current membership email used by the external collaborator policy. */
  memberEmail: string
  /** Current Cognito group names, retrieved for this recipient. */
  cognitoGroupIds: string[]
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
  const directory = resolveEnterpriseDirectoryPrincipal(input.snapshot, input.memberKey, input.cognitoGroupIds)
  const boundary = resolveNotificationRecipientBoundary(input.snapshot, input.memberKey, input.memberEmail, input.workspaceRole)
  if (!boundary.allowed || boundary.permissionCeiling &&
    !boundary.permissionCeiling.some((permission) => ['documents.read', 'documents.write', 'documents.manage'].includes(permission))) return undefined
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
          ...(boundary.permissionCeiling ? { permissionCeiling: boundary.permissionCeiling } : {}),
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

/** Workspace-wide Enterprise restrictions applied before any external notification. */
export type NotificationRecipientBoundary = {
  /** Whether the directory and external access policy allow this recipient. */
  allowed: boolean
  /** Maximum permissions for guests or members outside verified domains. */
  permissionCeiling?: EnterprisePermissionId[]
}

/**
 * Applies current SCIM deprovisioning and the same external-access ceiling used by authenticated reads.
 * @param snapshot - Current workspace Enterprise snapshot.
 * @param memberKey - Canonical active member key.
 * @param memberEmail - Current membership email.
 * @param workspaceRole - Current workspace role.
 * @returns Whether the recipient remains eligible and any external permission ceiling.
 */
export function resolveNotificationRecipientBoundary(
  snapshot: EnterpriseIdentitySnapshot,
  memberKey: string,
  memberEmail: string,
  workspaceRole: DocumentAccessContext['workspaceRole'],
): NotificationRecipientBoundary {
  if (resolveEnterpriseDirectoryPrincipal(snapshot, memberKey, []).deprovisioned) return { allowed: false }
  const domain = memberEmail.trim().toLowerCase().split('@')[1]
  const verifiedDomains = snapshot.domains.filter((candidate) => candidate.status === 'verified')
  const managedDomain = verifiedDomains.length === 0 || verifiedDomains.some((candidate) => candidate.domain.trim().toLowerCase() === domain)
  const external = workspaceRole === 'guest' || !managedDomain
  const policy = snapshot.policy?.externalAccess
  if (workspaceRole === 'guest' && policy && (!policy.allowGuests ||
    policy.allowedGuestDomains.length > 0 && !policy.allowedGuestDomains.some((candidate) => candidate.trim().toLowerCase() === domain))) {
    return { allowed: false }
  }
  const recoveryAccount = snapshot.breakGlassAccounts.some((account) =>
    account.status === 'active' && account.linkedMemberKey?.trim().toLowerCase() === memberKey)
  if (workspaceRole !== 'guest' && !managedDomain && policy?.allowExternalCollaborators === false && !recoveryAccount) return { allowed: false }
  return {
    allowed: true,
    ...(external ? { permissionCeiling: policy?.permissionCeiling ?? [
      'workspace.read', 'members.read', 'teams.read', 'projects.read', 'work-items.read', 'documents.read', 'files.read', 'planning.read',
    ] } : {}),
  }
}
