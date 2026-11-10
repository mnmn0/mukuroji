import { type EnterprisePermissionId } from '@mukuroji/contracts'
import { getSystemAdminGroups } from '../../modules/authentication'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  resolveEnterpriseDirectoryPrincipal,
  type EnterpriseAuthorizationResource,
  type EnterprisePrincipalContext,
} from '../../modules/enterprise-identity'
import type {
  AuthenticatedDeveloperCredential,
} from '../../modules/developer-platform/application/ports'
import {
  PublicApiServiceError,
  type DeveloperManagementPrincipal,
} from '../../modules/developer-platform/public-api'
import { authenticationDependencies, workspaceDependencies } from './app-dependencies'
import {
  type EnterpriseAuthorizationEvaluationSnapshot,
  type EnterpriseRequestAccess,
  hasUnqualifiedEnterpriseProjectScope,
  normalizeEnterpriseEmailDomain,
  qualifyEnterpriseProjectScopes,
  requireEnterpriseExternalAccessAllowed,
} from './enterprise-access'
import { type WorkspacePrincipal } from './project-access'
import { evaluateEnterpriseRequestAccess } from './request-authorization'

/**
 * Headless Developer Platform operation が current Enterprise RBAC に要求する権限と scope です。
 */
export type DeveloperAuthorizationRequirement = {
  /** Operation が要求する Enterprise permission です。 */
  permission: EnterprisePermissionId
  /** Team scope が既知の場合の canonical Team ID です。 */
  teamId?: string
  /** Project scope が既知の場合の canonical Project ID です。 */
  projectId?: string
  /** Collection/Team operation で descendant Project grant を列挙するかどうかです。 */
  evaluateProjectScopes?: boolean
}

function resolveDeveloperAuthorizationResource(
  workspaceId: string,
  requirement: DeveloperAuthorizationRequirement,
): EnterpriseAuthorizationResource {
  if (requirement.projectId) {
    if (!requirement.teamId) {
      throw new TypeError('Developer Project authorization requires its owning Team ID.')
    }
    return {
      workspaceId,
      kind: 'project',
      targetId: requirement.projectId,
      parentTeamId: requirement.teamId,
    }
  }
  if (requirement.teamId) {
    return {
      workspaceId,
      kind: 'team',
      targetId: requirement.teamId,
    }
  }
  return { workspaceId, kind: 'workspace' }
}

/**
 * Resolves the Workspace principal for an authenticated developer credential.
 *
 * @param credential - Authenticated developer credential.
 * @param requirement - Authorization requirement of the route.
 * @returns The Workspace principal.
 */
export async function resolveDeveloperCredentialPrincipal(
  credential: AuthenticatedDeveloperCredential,
  requirement: DeveloperAuthorizationRequirement,
): Promise<WorkspacePrincipal> {
  const member = await workspaceDependencies.workspaceAccess.getActiveMember(
    credential.workspaceId,
    credential.subjectUserId,
  )
  if (!member) {
    throw new PublicApiServiceError(
      403,
      'forbidden',
      'The credential owner is not an active Workspace member.',
    )
  }
  const currentCognitoGroups = await authenticationDependencies.cognito.getUserGroups(member.memberKey)
  const systemAdminGroups = new Set(getSystemAdminGroups())
  const isSystemAdmin = currentCognitoGroups.some((group) =>
    systemAdminGroups.has(group)
  )
  const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(credential.workspaceId)
  const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(
    snapshot,
    member.memberKey,
    currentCognitoGroups,
  )
  if (directoryPrincipal.deprovisioned) {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceDirectoryMemberDeprovisioned',
      'Workspace access was deprovisioned by the enterprise directory.',
    )
  }
  const memberDomain = normalizeEnterpriseEmailDomain(member.email)
  const verifiedDomains = snapshot.domains.filter((domain) =>
    domain.status === 'verified'
  )
  const managedDomain = verifiedDomains.length === 0 || verifiedDomains.some((domain) =>
    domain.domain === memberDomain
  )
  const external = member.role === 'guest' || !managedDomain
  const recoveryAccount = snapshot.breakGlassAccounts.some((account) =>
    account.linkedMemberKey === member.memberKey && account.status === 'active'
  )
  requireEnterpriseExternalAccessAllowed(
    snapshot,
    member.email,
    member.role,
    recoveryAccount,
  )
  const {
    compatibleGroupMappings,
    compatibleRoleAssignments,
    directoryGroupIds,
    directoryGroupMemberships,
  } = directoryPrincipal
  const needsProjectScopeQualification =
    hasUnqualifiedEnterpriseProjectScope(compatibleRoleAssignments) ||
    hasUnqualifiedEnterpriseProjectScope(compatibleGroupMappings)
  const enterpriseDirectory = needsProjectScopeQualification
    ? await workspaceDependencies.projectDirectory.getProjectDirectory(
        credential.workspaceId,
        'ja',
        true,
      )
    : undefined
  const qualifiedRoleAssignments = enterpriseDirectory
    ? qualifyEnterpriseProjectScopes(compatibleRoleAssignments, enterpriseDirectory)
    : compatibleRoleAssignments
  const qualifiedGroupMappings = enterpriseDirectory
    ? qualifyEnterpriseProjectScopes(compatibleGroupMappings, enterpriseDirectory)
    : compatibleGroupMappings
  const suppressLegacyWorkspaceRole = directoryPrincipal.directoryManaged ||
    qualifiedRoleAssignments.some((assignment) =>
      assignment.principalKind === 'member' &&
        assignment.principalId === member.memberKey ||
      assignment.principalKind === 'directory-group' &&
        (
          assignment.source === 'directory-mapping' ||
          directoryGroupIds.includes(assignment.principalId)
        )
    ) ||
    qualifiedGroupMappings.some((mapping) => mapping.enabled)
  const enterprisePrincipal = {
    kind: 'member',
    principalId: member.memberKey,
    directoryGroupIds,
    directoryGroupMemberships,
    workspaceRole: member.role,
    includeWorkspaceRolePermissions: !suppressLegacyWorkspaceRole,
    ...(suppressLegacyWorkspaceRole
      ? { directPermissions: ['workspace.read' as const] }
      : {}),
    systemAdministrator: isSystemAdmin,
    ...(external
      ? {
          permissionCeiling: snapshot.policy?.externalAccess.permissionCeiling ??
            ['workspace.read', 'members.read', 'teams.read', 'projects.read',
              'work-items.read', 'documents.read', 'files.read',
              'planning.read'] as EnterprisePermissionId[],
        }
      : {}),
  } satisfies EnterprisePrincipalContext
  const enterpriseAuthorizationEvaluation = {
    principal: enterprisePrincipal,
    snapshot,
    assignments: qualifiedRoleAssignments,
    groupMappings: qualifiedGroupMappings,
  } satisfies EnterpriseAuthorizationEvaluationSnapshot
  const resource = resolveDeveloperAuthorizationResource(
    credential.workspaceId,
    requirement,
  )
  const defersToLegacyBusinessAuthorization =
    !suppressLegacyWorkspaceRole &&
    (!external || snapshot.policy === undefined) &&
    !isSystemAdmin
  const requestAccess: EnterpriseRequestAccess = defersToLegacyBusinessAuthorization
    ? {
        allowed: true,
        resource,
        permissions: [],
        grantedRoutePermissions: [],
        authorizedAtResource: false,
        projectAccesses: [],
        projectScopeAccesses: [],
        authorizedTeamIds: [],
        teamAccesses: [],
      }
    : await evaluateEnterpriseRequestAccess({
        workspaceId: credential.workspaceId,
        resource,
        ...(requirement.evaluateProjectScopes === undefined
          ? {}
          : { evaluateProjectScopes: requirement.evaluateProjectScopes }),
        requiredPermissions: [requirement.permission],
        ...enterpriseAuthorizationEvaluation,
      })
  if (!requestAccess.allowed) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Enterprise permission is required for this operation.',
    )
  }
  return {
    directoryId: credential.workspaceId,
    userKey: member.memberKey,
    actorId: member.id,
    isSystemAdmin,
    groups: currentCognitoGroups,
    principalKind: 'member',
    ...(defersToLegacyBusinessAuthorization
      ? {}
      : { enterprisePermissions: requestAccess.permissions }),
    enterpriseIdentityControlRevision: snapshot.controlRevision,
    enterpriseAuthorizationResource: requestAccess.resource,
    enterpriseGrantedRoutePermission: requestAccess.grantedRoutePermission,
    enterpriseGrantedRoutePermissions: requestAccess.grantedRoutePermissions,
    enterpriseRouteAuthorizedAtResource: requestAccess.authorizedAtResource,
    enterpriseProjectAccesses: requestAccess.projectAccesses,
    enterpriseProjectScopeAccesses: requestAccess.projectScopeAccesses,
    enterpriseAuthorizedTeamIds: requestAccess.authorizedTeamIds,
    enterpriseTeamAccesses: requestAccess.teamAccesses,
    enterpriseLegacyProjectAccessSuppressed: suppressLegacyWorkspaceRole,
    ...(defersToLegacyBusinessAuthorization
      ? {}
      : { enterpriseAuthorizationEvaluation }),
    workspaceMember: member,
    workspaceRole: member.role,
    workspaceMemberStatus: member.status,
  }
}

/**
 * Resolves the Workspace principal for a developer management credential.
 *
 * @param principal - Authenticated Workspace principal.
 * @param requirement - Authorization requirement of the route.
 * @returns The Workspace principal.
 */
export async function resolveDeveloperManagementPrincipal(
  principal: DeveloperManagementPrincipal,
  requirement: DeveloperAuthorizationRequirement,
): Promise<WorkspacePrincipal> {
  return resolveDeveloperCredentialPrincipal({
    kind: 'oauth-token',
    workspaceId: principal.workspaceId,
    credentialId: `session:${principal.userId}`,
    subjectUserId: principal.userId,
    scopes: [],
  }, requirement)
}
