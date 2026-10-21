import {
  type EnterprisePermissionId,
  type EnterpriseRoutePermissionRule,
} from '@mukuroji/contracts'
import type { Context } from 'hono'
import { type GetUserResponse } from '../../modules/authentication'
import { type ProjectAccessEntry, type ProjectRole } from '../../modules/directory'
import { createMutationAuditContext } from '../../modules/audit/audit'
import {
  WorkspaceAccessError,
  type WorkspaceMember,
} from '../../modules/workspace-access/workspace-access'
import { CollaborationError } from '../../modules/collaboration/collaboration'
import { RequestIntakeError } from '../../modules/request-intake/request-intake'
import {
  EnterpriseIdentityError,
  evaluateEnterpriseAccess,
  ipMatchesCidr,
  resolveEnterpriseDirectoryPrincipal,
  resolveRoutePermissions,
  validateEnterpriseSession,
  type EnterpriseAuthorizationResource,
  type EnterprisePrincipalContext,
} from '../../modules/enterprise-identity'
import {
  createEnterpriseSsoAuthenticationMethod,
} from '../../modules/enterprise-identity/enterprise-sso'
import {
  EnterpriseSessionActivityError,
} from '../../modules/enterprise-identity/enterprise-session-activity'
import {
  authenticationDependencies,
  enforceActiveTenantForRequest,
  workItemDependencies,
  workspaceDependencies,
} from './app-dependencies'
import { toProjectPrincipal } from './authentication-session'
import {
  assertEnterpriseRuntimeCognitoProviders,
  type CognitoAccessTokenClaims,
  createEnterpriseAuthenticationSessionId,
  type EnterpriseAuthorizationEvaluationSnapshot,
  type EnterpriseProjectScopeAccess,
  type EnterpriseRequestAccess,
  type EnterpriseRequestAccessInput,
  type EnterpriseTeamAccess,
  getVerifiedEnterpriseAuthenticationMethods,
  hasUnqualifiedEnterpriseProjectScope,
  isEnterpriseSsoConfigured,
  normalizeEnterpriseEmailDomain,
  qualifyEnterpriseProjectScopes,
  readCognitoAuthenticationMethods,
  readStableEnterpriseServiceAccountSnapshot,
  requireEnterpriseCognitoSsoAppClientConfiguration,
  requireEnterpriseExternalAccessAllowed,
  resolveEnterpriseClientIp,
  resolveEnterpriseProjectRole,
  resolveEnterpriseSessionErrorCode,
  shouldDeferEnterpriseContentAuthorization,
  validateConfiguredCognitoAccessToken,
} from './enterprise-access'
import {
  createRequestMutationContext,
  readBearerAccessToken,
  type WorkspaceAuthenticationOptions,
} from './http'
import { shouldEvaluateAllPlanningHistoryScopes } from './planning-access'
import {
  readLegacyProjectScopeAccesses,
  requireWorkspaceAdministration,
  type WorkspacePrincipal,
} from './project-access'
import { getEnv } from './runtime-config'
import { decodeJwtPayload, readNumericClaim } from './token-claims'
import { isRecord } from './value-guards'
import { loadAuthorizedTeamIssue } from './work-item-access'

const ENTERPRISE_NOTIFICATION_SCOPE_PERMISSIONS = [
  'teams.read',
  'teams.write',
  'projects.read',
  'projects.write',
  'work-items.read',
  'work-items.write',
  'documents.read',
  'documents.write',
  'files.read',
  'files.write',
  'planning.read',
  'planning.write',
] satisfies EnterprisePermissionId[]

const enterpriseRoutePermissionRules = [
  {
    method: 'POST',
    pathPattern: '/api/enterprise/security/break-glass/activate',
    permission: 'workspace.read',
  },
  {
    method: 'POST',
    pathPattern: '/api/enterprise/security/break-glass/test',
    permission: 'workspace.read',
  },
  {
    method: 'POST',
    pathPattern: '/api/enterprise/security/break-glass/revoke-activation',
    permission: 'workspace.read',
  },
  {
    method: 'POST',
    pathPattern: '/api/enterprise/security/break-glass/deactivate',
    permission: 'security.manage',
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/break-glass/accounts*',
    permission: 'security.manage',
  },
  {
    method: 'GET',
    pathPattern: '/api/enterprise/security',
    permission: 'security.read',
    alternativePermissions: [
      'identity.read',
      'identity.manage',
      'security.manage',
      'members.read',
      'members.manage',
      'service-accounts.manage',
    ],
  },
  {
    method: 'PUT',
    pathPattern: '/api/enterprise/security/identity-provider',
    permission: 'identity.manage',
    alternativePermissions: ['security.manage'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/domains*',
    permission: 'identity.manage',
    alternativePermissions: ['security.manage'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/scim*',
    permission: 'identity.manage',
  },
  {
    method: 'GET',
    pathPattern: '/api/enterprise/security/provisioning/logs',
    permission: 'identity.read',
    alternativePermissions: ['security.read'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/provisioning*',
    permission: 'identity.manage',
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/policy*',
    permission: 'security.manage',
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/roles*',
    permission: 'security.manage',
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/group-mappings*',
    permission: 'security.manage',
    alternativePermissions: ['members.manage'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security/service-accounts*',
    permission: 'service-accounts.manage',
    alternativePermissions: ['security.manage'],
  },
  {
    method: 'GET',
    pathPattern: '/api/enterprise/security*',
    permission: 'security.read',
    alternativePermissions: ['identity.read'],
  },
  {
    method: '*',
    pathPattern: '/api/enterprise/security*',
    permission: 'security.manage',
  },
  { method: 'GET', pathPattern: '/api/audit/events/export', permission: 'audit.export' },
  { method: '*', pathPattern: '/api/audit/exports*', permission: 'audit.export' },
  { method: 'GET', pathPattern: '/api/audit/*', permission: 'audit.read' },
  { method: 'POST', pathPattern: '/api/analytics/query', permission: 'work-items.read' },
  { method: 'POST', pathPattern: '/api/analytics/evidence', permission: 'work-items.read' },
  { method: 'POST', pathPattern: '/api/analytics/export', permission: 'work-items.read' },
  { method: 'GET', pathPattern: '/api/analytics/reports', permission: 'work-items.read' },
  {
    method: 'GET',
    pathPattern: '/api/analytics/reports/:reportId/snapshots',
    permission: 'work-items.read',
  },
  {
    method: 'POST',
    pathPattern: '/api/analytics/reports',
    permission: 'work-items.write',
    alternativePermissions: ['teams.manage', 'workspace.manage'],
  },
  {
    method: 'PATCH',
    pathPattern: '/api/analytics/reports/:reportId',
    permission: 'work-items.write',
    alternativePermissions: ['teams.manage', 'workspace.manage'],
  },
  {
    method: 'DELETE',
    pathPattern: '/api/analytics/reports/:reportId',
    permission: 'work-items.write',
    alternativePermissions: ['teams.manage', 'workspace.manage'],
  },
  {
    method: 'POST',
    pathPattern: '/api/analytics/reports/:reportId/snapshots',
    permission: 'work-items.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/documents*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: '*',
    pathPattern: '/api/document-backlinks*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: 'POST',
    pathPattern: '/api/documents/:documentId/comments*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: '*',
    pathPattern: '/api/documents/:documentId/presence*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: '*',
    pathPattern: '/api/documents/:documentId/favorite',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: 'POST',
    pathPattern: '/api/documents/:documentId/recent',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write', 'documents.read'],
  },
  {
    method: '*',
    pathPattern: '/api/documents/:documentId/shares',
    permission: 'documents.manage',
  },
  {
    method: '*',
    pathPattern: '/api/documents*',
    permission: 'documents.manage',
    alternativePermissions: ['documents.write'],
  },
  { method: 'GET', pathPattern: '/api/workspace/*', permission: 'members.read' },
  { method: '*', pathPattern: '/api/workspace/*', permission: 'members.manage' },
  { method: '*', pathPattern: '/api/tenant/*', permission: 'workspace.manage' },
  { method: 'GET', pathPattern: '/api/automation/*', permission: 'automation.read' },
  { method: '*', pathPattern: '/api/automation/*', permission: 'automation.manage' },
  { method: 'GET', pathPattern: '/api/recurring-work*', permission: 'automation.read' },
  { method: '*', pathPattern: '/api/recurring-work*', permission: 'automation.manage' },
  { method: '*', pathPattern: '/api/bulk-operations*', permission: 'work-items.write' },
  { method: 'GET', pathPattern: '/api/planning*', permission: 'planning.read' },
  {
    method: 'POST',
    pathPattern: '/api/planning/entities/:entityId/archive',
    permission: 'planning.manage',
  },
  {
    method: 'POST',
    pathPattern: '/api/planning/entities/:entityId/move',
    permission: 'planning.manage',
  },
  { method: '*', pathPattern: '/api/planning/dependencies*', permission: 'planning.manage' },
  {
    method: '*',
    pathPattern: '/api/planning/work-item-dependencies*',
    permission: 'planning.manage',
  },
  { method: '*', pathPattern: '/api/planning/cycles*', permission: 'planning.manage' },
  { method: 'PUT', pathPattern: '/api/planning/update-feed/read-state', permission: 'planning.read' },
  { method: 'PUT', pathPattern: '/api/planning/update-feed/saved', permission: 'planning.read' },
  { method: 'PUT', pathPattern: '/api/planning/update-feed/digest', permission: 'planning.read' },
  { method: 'PUT', pathPattern: '/api/planning/update-feed/digest/inbox', permission: 'planning.read' },
  { method: 'POST', pathPattern: '/api/planning/update-feed/digest/preview', permission: 'planning.read' },
  { method: '*', pathPattern: '/api/planning*', permission: 'planning.write' },
  { method: 'GET', pathPattern: '/api/request-forms*', permission: 'requests.read' },
  { method: '*', pathPattern: '/api/request-forms*', permission: 'requests.manage' },
  { method: 'GET', pathPattern: '/api/request-queue*', permission: 'requests.read' },
  { method: 'GET', pathPattern: '/api/request-submissions*', permission: 'requests.read' },
  { method: '*', pathPattern: '/api/request-submissions*', permission: 'requests.manage' },
  {
    method: 'GET',
    pathPattern: '/api/customers/export',
    permission: 'requests.manage',
    alternativePermissions: ['workspace.manage'],
  },
  {
    method: 'GET',
    pathPattern: '/api/customers*',
    permission: 'requests.read',
    alternativePermissions: ['requests.manage', 'workspace.manage'],
  },
  {
    method: '*',
    pathPattern: '/api/customers*',
    permission: 'requests.manage',
    alternativePermissions: ['workspace.manage'],
  },
  {
    method: 'GET',
    pathPattern: '/api/customer-requests*',
    permission: 'requests.read',
    alternativePermissions: ['requests.manage', 'workspace.manage'],
  },
  {
    method: '*',
    pathPattern: '/api/customer-requests*',
    permission: 'requests.manage',
    alternativePermissions: ['workspace.manage'],
  },
  {
    method: '*',
    pathPattern: '/api/customer-contacts*',
    permission: 'requests.manage',
    alternativePermissions: ['workspace.manage'],
  },
  {
    method: 'PUT',
    pathPattern: '/api/teams/:teamId/triage-settings',
    permission: 'teams.manage',
  },
  {
    method: 'POST',
    pathPattern: '/api/teams/:teamId/triage-entries/:entryId/customer-request',
    permission: 'requests.manage',
    alternativePermissions: ['workspace.manage'],
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/triage*',
    permission: 'teams.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/triage*',
    permission: 'teams.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/work-items/:workItemId/triage-sources',
    permission: 'teams.read',
  },
  { method: 'GET', pathPattern: '/api/approvals*', permission: 'files.read' },
  { method: '*', pathPattern: '/api/approvals*', permission: 'files.approve' },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/issues/:issueId/files*',
    permission: 'files.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/issues/:issueId/files*',
    permission: 'files.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/projects/:projectId/files*',
    permission: 'files.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/projects/:projectId/files*',
    permission: 'files.write',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/issues/:issueId/comments/:commentId/files*',
    permission: 'files.write',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/issues/:issueId/approvals*',
    permission: 'files.approve',
  },
  {
    method: 'POST',
    pathPattern: '/api/realtime/tickets',
    permission: 'work-items.read',
  },
  { method: 'GET', pathPattern: '/api/focus*', permission: 'work-items.read' },
  {
    method: 'PUT',
    pathPattern: '/api/focus/policies',
    permission: 'work-items.read',
    alternativePermissions: ['teams.manage'],
  },
  {
    method: 'PUT',
    pathPattern: '/api/focus/items/:teamId/:workItemId/snooze',
    permission: 'work-items.read',
  },
  {
    method: 'PUT',
    pathPattern: '/api/focus/items/:teamId/:workItemId/watch',
    permission: 'work-items.read',
  },
  { method: 'GET', pathPattern: '/api/work-items*', permission: 'work-items.read' },
  { method: '*', pathPattern: '/api/work-items*', permission: 'work-items.write' },
  {
    method: 'GET',
    pathPattern: '/api/work-item-configuration*',
    permission: 'work-items.read',
  },
  {
    method: '*',
    pathPattern: '/api/work-item-configuration*',
    permission: 'work-items.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/work-item-configuration*',
    permission: 'work-items.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/work-item-configuration*',
    permission: 'work-items.write',
  },
  { method: 'GET', pathPattern: '/api/collections*', permission: 'work-items.read' },
  {
    method: '*',
    pathPattern: '/api/collections*',
    permission: 'work-items.write',
    alternativePermissions: ['workspace.write'],
  },
  { method: 'GET', pathPattern: '/api/task-views*', permission: 'work-items.read' },
  {
    method: '*',
    pathPattern: '/api/task-views*',
    permission: 'work-items.write',
    alternativePermissions: ['workspace.write'],
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/issues/:issueId/customer-impact',
    permission: 'requests.read',
    alternativePermissions: ['requests.manage', 'workspace.manage'],
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/:teamId/issues*',
    permission: 'work-items.read',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/issues*',
    permission: 'work-items.write',
  },
  { method: 'GET', pathPattern: '/api/projects/:projectId/issues*', permission: 'work-items.read' },
  { method: '*', pathPattern: '/api/projects/:projectId/issues*', permission: 'work-items.write' },
  {
    method: 'GET',
    pathPattern: '/api/projects/:projectId/customer-impact',
    permission: 'requests.read',
    alternativePermissions: ['requests.manage', 'workspace.manage'],
  },
  {
    method: 'GET',
    pathPattern: '/api/projects/:projectId/users*',
    permission: 'projects.manage',
  },
  {
    method: 'GET',
    pathPattern: '/api/projects/:projectId/members*',
    permission: 'projects.write',
  },
  {
    method: '*',
    pathPattern: '/api/projects/:projectId/members*',
    permission: 'projects.manage',
  },
  {
    method: '*',
    pathPattern: '/api/teams/:teamId/projects/:projectId/archive',
    permission: 'projects.manage',
  },
  {
    method: 'POST',
    pathPattern: '/api/teams/:teamId/projects',
    permission: 'projects.write',
  },
  {
    method: 'PATCH',
    pathPattern: '/api/teams/:teamId/archive',
    permission: 'teams.manage',
  },
  {
    method: 'POST',
    pathPattern: '/api/teams',
    permission: 'teams.write',
  },
  {
    method: 'GET',
    pathPattern: '/api/teams/projects',
    permission: 'teams.read',
    alternativePermissions: ['projects.read'],
  },
  {
    method: '*',
    pathPattern: '/api/projects/quick-access',
    permission: 'projects.read',
  },
  { method: 'GET', pathPattern: '/api/teams*', permission: 'teams.read' },
  { method: '*', pathPattern: '/api/teams*', permission: 'teams.write' },
  { method: 'GET', pathPattern: '/api/projects*', permission: 'projects.read' },
  { method: '*', pathPattern: '/api/projects*', permission: 'projects.write' },
  { method: '*', pathPattern: '/api/developer*', permission: 'workspace.manage' },
  {
    method: 'GET',
    pathPattern: '/api/notifications*',
    permission: 'workspace.read',
    alternativePermissions: ENTERPRISE_NOTIFICATION_SCOPE_PERMISSIONS,
  },
  {
    method: 'PUT',
    pathPattern: '/api/ai-assistance/policy',
    permission: 'workspace.manage',
  },
  {
    method: 'PUT',
    pathPattern: '/api/ai-assistance/preferences/me',
    permission: 'workspace.read',
  },
  // Push availability and the caller's own device registration change no shared Workspace data.
  {
    method: 'GET',
    pathPattern: '/api/push/config',
    permission: 'workspace.read',
  },
  {
    method: '*',
    pathPattern: '/api/push-subscriptions',
    permission: 'workspace.read',
  },
  {
    method: 'POST',
    pathPattern: '/api/ai-assistance/generations*',
    permission: 'workspace.read',
  },
  {
    method: 'GET',
    pathPattern: '/api/ai-assistance*',
    permission: 'workspace.read',
  },
  { method: 'GET', pathPattern: '/api/*', permission: 'workspace.read' },
  { method: '*', pathPattern: '/api/*', permission: 'workspace.write' },
] as const satisfies readonly EnterpriseRoutePermissionRule[]

/**
 * Authenticates an access token and resolves the Workspace principal with its enterprise authorization.
 *
 * @param accessToken - Bearer access token from the request.
 * @param user - Pre-fetched Cognito user, when available.
 * @param context - Hono request context used for enterprise policy checks.
 * @param options - Authentication options for the route.
 * @returns The authenticated Workspace principal.
 */
export async function authenticateWorkspacePrincipal(
  accessToken: string,
  user?: GetUserResponse,
  context?: Context,
  options: WorkspaceAuthenticationOptions = {},
): Promise<WorkspacePrincipal> {
  if (accessToken.startsWith('msa_')) {
    const principal = await authenticateEnterpriseServiceAccount(accessToken, context)
    await enforceActiveTenantForRequest(principal.directoryId, context)
    return principal
  }
  validateConfiguredCognitoAccessToken(accessToken)
  const principal = toProjectPrincipal(user ?? await authenticationDependencies.cognito.getUser(accessToken), accessToken)
  if (typeof authenticationDependencies.cognito.isSystemAdmin === 'function') {
    principal.isSystemAdmin = await authenticationDependencies.cognito.isSystemAdmin(principal.userKey)
  }
  const authenticationSessionId = createEnterpriseAuthenticationSessionId(accessToken)
  const workspaceMember = await workspaceDependencies.workspaceAccess.getActiveMember(
    principal.directoryId,
    principal.userKey,
  )

  if (!workspaceMember) {
    throw new WorkspaceAccessError(403, 'WorkspaceAccessDenied', 'Workspace access is denied.')
  }

  const snapshot = await workspaceDependencies.enterpriseIdentity.read.getSnapshot(principal.directoryId)
  const recoveryAccount = snapshot.breakGlassAccounts.find((account) =>
    account.linkedMemberKey === principal.userKey && account.status === 'active'
  )
  const breakGlassActivation = await workspaceDependencies.enterpriseIdentity.read.getActiveBreakGlassActivation(
    principal.directoryId,
    principal.userKey,
    authenticationSessionId,
  )
  const principalKind = breakGlassActivation ? 'break-glass' : 'member'
  let verifiedAuthenticationMethods: string[] | undefined
  if (!options.breakGlassCandidate && principalKind !== 'break-glass' && isEnterpriseSsoConfigured()) {
    try {
      await assertEnterpriseRuntimeCognitoProviders(
        snapshot,
        principal.userKey,
        workspaceMember.email,
      )
    } catch (error) {
      const status = error instanceof EnterpriseIdentityError && error.status >= 500
        ? 503
        : 403
      throw new WorkspaceAccessError(
        status,
        'EnterpriseCognitoProviderBindingInvalid',
        'Enterprise identity provider binding could not be verified.',
        { cause: error },
      )
    }

    const memberDomain = normalizeEnterpriseEmailDomain(workspaceMember.email)
    const enforcedSsoDomains = snapshot.domains.filter((domain) =>
      domain.status === 'verified' &&
      domain.enforceSso &&
      domain.domain === memberDomain
    )
    if (enforcedSsoDomains.length > 0) {
      const ssoClient = requireEnterpriseCognitoSsoAppClientConfiguration()
      const accessTokenClaims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
      verifiedAuthenticationMethods = await getVerifiedEnterpriseAuthenticationMethods(
        principal.directoryId,
        authenticationSessionId,
      )
      if (
        accessTokenClaims?.client_id !== ssoClient.clientId ||
        enforcedSsoDomains.some((domain) => {
          if (!domain.identityProviderId) return true
          const provider = snapshot.identityProviders.find((candidate) =>
            candidate.providerId === domain.identityProviderId
          )
          return !provider || !verifiedAuthenticationMethods?.includes(
            createEnterpriseSsoAuthenticationMethod(
              provider.providerId,
              provider.revision,
            ),
          )
        })
      ) {
        throw new WorkspaceAccessError(
          403,
          'EnterpriseSsoSessionRequired',
          'Single sign-on is required for this Workspace account.',
        )
      }
    }
  }
  const directoryPrincipal = resolveEnterpriseDirectoryPrincipal(
    snapshot,
    principal.userKey,
    principal.groups,
  )
  if (directoryPrincipal.deprovisioned) {
    throw new WorkspaceAccessError(
      403,
      'WorkspaceDirectoryMemberDeprovisioned',
      'Workspace access was deprovisioned by the enterprise directory.',
    )
  }
  const memberDomain = normalizeEnterpriseEmailDomain(workspaceMember.email)
  const verifiedDomains = snapshot.domains.filter((domain) =>
    domain.status === 'verified'
  )
  const managedDomain = verifiedDomains.length === 0 || verifiedDomains.some((domain) =>
    domain.domain === memberDomain
  )
  const external = workspaceMember.role === 'guest' || !managedDomain
  requireEnterpriseExternalAccessAllowed(
    snapshot,
    workspaceMember.email,
    workspaceMember.role,
    recoveryAccount !== undefined,
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
        principal.directoryId,
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
  const requiredPermissions = context
    ? resolveRoutePermissions(
        context.req.method,
        context.req.path,
        enterpriseRoutePermissionRules,
      )
    : undefined
  const suppressLegacyWorkspaceRole = directoryPrincipal.directoryManaged ||
    qualifiedRoleAssignments.some((assignment) =>
    (
      assignment.principalKind === 'member' && assignment.principalId === principal.userKey ||
      assignment.principalKind === 'directory-group' &&
        (
          assignment.source === 'directory-mapping' ||
          directoryGroupIds.includes(assignment.principalId)
        )
    )
  ) || qualifiedGroupMappings.some((mapping) =>
    mapping.enabled
  )
  const enterprisePrincipal = {
    kind: principalKind,
    principalId: principal.userKey,
    directoryGroupIds,
    directoryGroupMemberships,
    workspaceRole: workspaceMember.role,
    includeWorkspaceRolePermissions: !suppressLegacyWorkspaceRole,
    ...(suppressLegacyWorkspaceRole
      ? { directPermissions: ['workspace.read' as const] }
      : {}),
    systemAdministrator: principal.isSystemAdmin,
    ...(external && principalKind !== 'break-glass'
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
  const defersToLegacyBusinessAuthorization =
    !suppressLegacyWorkspaceRole &&
    (!external || snapshot.policy === undefined) &&
    principalKind === 'member' &&
    !principal.isSystemAdmin &&
    context !== undefined &&
    shouldDeferEnterpriseContentAuthorization(context.req.path)
  const loadsLegacyPlanningScopeAccess = context !== undefined &&
    (context.req.path === '/api/planning' || context.req.path.startsWith('/api/planning/'))
  const requestAccess: EnterpriseRequestAccess = options.breakGlassCandidate && recoveryAccount
    ? {
        allowed: true,
        resource: {
          workspaceId: principal.directoryId,
          kind: 'workspace' as const,
        },
        permissions: [] as EnterprisePermissionId[],
        grantedRoutePermissions: [] as EnterprisePermissionId[],
        authorizedAtResource: false,
        projectAccesses: [] as ProjectAccessEntry[],
        projectScopeAccesses: [] as EnterpriseProjectScopeAccess[],
        authorizedTeamIds: [] as string[],
        teamAccesses: [] as EnterpriseTeamAccess[],
      }
    : defersToLegacyBusinessAuthorization
      ? {
          allowed: true,
          resource: { workspaceId: principal.directoryId, kind: 'workspace' },
          permissions: [],
          grantedRoutePermissions: [],
          authorizedAtResource: false,
          projectAccesses: [],
          projectScopeAccesses: [],
          authorizedTeamIds: [],
          teamAccesses: [],
        }
    : await evaluateEnterpriseRequestAccess({
        workspaceId: principal.directoryId,
        context,
        ...(shouldEvaluateEnterpriseNotificationScopes(context)
          ? { scopePermissions: ENTERPRISE_NOTIFICATION_SCOPE_PERMISSIONS }
          : {}),
        requiredPermissions,
        ...(shouldEvaluateAllPlanningHistoryScopes(context)
          ? { evaluateAllProjectScopes: true }
          : {}),
        ...enterpriseAuthorizationEvaluation,
      })
  if (!requestAccess.allowed) {
    throw new WorkspaceAccessError(
      403,
      'WorkspacePermissionDenied',
      'Enterprise permission is required for this operation.',
    )
  }
  if (context && !options.breakGlassCandidate) {
    const claims = decodeJwtPayload<CognitoAccessTokenClaims>(accessToken)
    const nowSeconds = Math.floor(Date.now() / 1000)
    const authenticatedAt = readNumericClaim(claims?.auth_time) ??
      readNumericClaim(claims?.iat) ??
      nowSeconds
    verifiedAuthenticationMethods ??= await getVerifiedEnterpriseAuthenticationMethods(
      principal.directoryId,
      authenticationSessionId,
    )
    const authenticationMethods = [
      ...new Set([
        ...readCognitoAuthenticationMethods(claims),
        ...verifiedAuthenticationMethods,
      ]),
    ]
    const validation = validateEnterpriseSession(snapshot.policy, {
      authenticatedAt,
      now: nowSeconds,
      authenticationMethods,
      clientIp: resolveEnterpriseClientIp(context),
      privileged: [
        requestAccess.grantedRoutePermission,
        ...(requiredPermissions ?? []),
      ].some((permission) =>
        permission === 'security.manage' ||
        permission === 'identity.manage' ||
        permission === 'members.manage' ||
        permission === 'service-accounts.manage' ||
        permission === 'audit.export'
      ),
      external,
      breakGlass: principalKind === 'break-glass',
    })
    if (!validation.valid) {
      throw new WorkspaceAccessError(
        403,
        resolveEnterpriseSessionErrorCode(validation.reason),
        'Current session does not satisfy the Workspace security policy.',
      )
    }
    if (snapshot.policy) {
      try {
        await workspaceDependencies.enterpriseSessionActivity.validateAndTouch({
          workspaceId: principal.directoryId,
          sessionId: authenticationSessionId,
          authenticatedAt,
          now: nowSeconds,
          idleTimeoutMinutes: snapshot.policy.idleTimeoutMinutes,
          sessionLifetimeMinutes: snapshot.policy.sessionLifetimeMinutes,
          authenticationMethods,
        })
      } catch (error) {
        if (error instanceof EnterpriseSessionActivityError) {
          throw new WorkspaceAccessError(error.status, error.code, error.message, {
            cause: error,
          })
        }
        throw error
      }
    }
  }

  await enforceActiveTenantForRequest(principal.directoryId, context)

  return {
    ...principal,
    principalKind,
    enterpriseAuthenticationSessionId: authenticationSessionId,
    ...(breakGlassActivation
      ? { enterpriseBreakGlassActivationId: breakGlassActivation.activationId }
      : {}),
    ...(defersToLegacyBusinessAuthorization
      ? {}
      : { enterprisePermissions: requestAccess.permissions }),
    enterpriseIdentityControlRevision:
      snapshot.controlRevision,
    enterpriseAuthorizationResource: requestAccess.resource,
    enterpriseGrantedRoutePermission: requestAccess.grantedRoutePermission,
    enterpriseGrantedRoutePermissions: requestAccess.grantedRoutePermissions,
    enterpriseRouteAuthorizedAtResource: requestAccess.authorizedAtResource,
    enterpriseProjectAccesses: requestAccess.projectAccesses,
    enterpriseProjectScopeAccesses: requestAccess.projectScopeAccesses,
    enterpriseAuthorizedTeamIds: requestAccess.authorizedTeamIds,
    enterpriseTeamAccesses: requestAccess.teamAccesses,
    enterpriseLegacyProjectAccessSuppressed: suppressLegacyWorkspaceRole,
    ...(defersToLegacyBusinessAuthorization && loadsLegacyPlanningScopeAccess
      ? {
          legacyProjectScopeAccesses: await readLegacyProjectScopeAccesses(principal),
          legacyWorkspaceScopeReadable: workspaceMember.role !== 'guest',
        }
      : {}),
    ...(defersToLegacyBusinessAuthorization
      ? {}
      : { enterpriseAuthorizationEvaluation }),
    workspaceMember,
    workspaceRole: workspaceMember.role,
    workspaceMemberStatus: workspaceMember.status,
  }
}

async function authenticateEnterpriseServiceAccount(
  accessToken: string,
  context?: Context,
): Promise<WorkspacePrincipal> {
  const workspaceId = getEnv('MUKUROJI_WORKSPACE_DIRECTORY_ID')
  if (!workspaceId) {
    throw new WorkspaceAccessError(
      503,
      'WorkspaceDirectoryUnavailable',
      'Workspace directory is not configured.',
    )
  }
  const clientIp = context ? resolveEnterpriseClientIp(context) : undefined
  const requiredPermissions = context
    ? resolveRoutePermissions(
        context.req.method,
        context.req.path,
        enterpriseRoutePermissionRules,
      )
    : undefined
  const authorizeCurrentServiceAccount =
    async () => {
      const { account, snapshot } =
        await readStableEnterpriseServiceAccountSnapshot(
          workspaceId,
          accessToken,
        )
      if (!account) {
        throw new WorkspaceAccessError(
          401,
          'WorkspaceServiceAccountInvalid',
          'Service account credential is invalid or revoked.',
        )
      }
      if (
        account.allowedSourceCidrs.length > 0 &&
        (
          !clientIp ||
          !account.allowedSourceCidrs.some(
            (cidr) =>
              ipMatchesCidr(clientIp, cidr),
          )
        )
      ) {
        throw new WorkspaceAccessError(
          403,
          'EnterpriseServiceAccountIpDenied',
          'Service account source IP is not allowed.',
        )
      }
      const serviceAccountPrincipal = {
        kind: 'service-account',
        principalId: account.accountId,
        directoryGroupIds: [],
        includeWorkspaceRolePermissions: false,
        directPermissions: [
          'service-accounts.use' as const,
        ],
      } satisfies EnterprisePrincipalContext
      const serviceAccountAssignments = [
        ...snapshot.roleAssignments,
        {
          workspaceId,
          assignmentId:
            `service-account-scope:${account.accountId}`,
          principalKind:
            'service-account' as const,
          principalId: account.accountId,
          roleId: account.roleId,
          scope: account.scope,
          source: 'system' as const,
        },
      ]
      const needsProjectScopeQualification =
        hasUnqualifiedEnterpriseProjectScope(serviceAccountAssignments) ||
        hasUnqualifiedEnterpriseProjectScope(snapshot.groupMappings)
      const enterpriseDirectory = needsProjectScopeQualification
        ? await workspaceDependencies.projectDirectory.getProjectDirectory(
            workspaceId,
            'ja',
            true,
          )
        : undefined
      const qualifiedServiceAccountAssignments = enterpriseDirectory
        ? qualifyEnterpriseProjectScopes(serviceAccountAssignments, enterpriseDirectory)
        : serviceAccountAssignments
      const qualifiedGroupMappings = enterpriseDirectory
        ? qualifyEnterpriseProjectScopes(snapshot.groupMappings, enterpriseDirectory)
        : snapshot.groupMappings
      const enterpriseAuthorizationEvaluation = {
        principal: serviceAccountPrincipal,
        snapshot,
        assignments: qualifiedServiceAccountAssignments,
        groupMappings: qualifiedGroupMappings,
      } satisfies EnterpriseAuthorizationEvaluationSnapshot
      const requestAccess =
        await evaluateEnterpriseRequestAccess({
          workspaceId,
          context,
          ...(shouldEvaluateEnterpriseNotificationScopes(context)
            ? { scopePermissions: ENTERPRISE_NOTIFICATION_SCOPE_PERMISSIONS }
            : {}),
          requiredPermissions,
          ...(shouldEvaluateAllPlanningHistoryScopes(context)
            ? { evaluateAllProjectScopes: true }
            : {}),
          ...enterpriseAuthorizationEvaluation,
        })
      if (!requestAccess.allowed) {
        throw new WorkspaceAccessError(
          403,
          'WorkspacePermissionDenied',
          'Service account does not have permission for this operation.',
        )
      }
      if (context) {
        const validation =
          validateEnterpriseSession(
            snapshot.policy,
            {
              authenticatedAt:
                Math.floor(Date.now() / 1000),
              now: Math.floor(
                Date.now() / 1000,
              ),
              authenticationMethods: [
                'service-account',
                'mfa',
              ],
              clientIp,
              privileged: true,
              external: false,
              breakGlass: false,
            },
          )
        if (
          !validation.valid &&
          validation.reason === 'ip-denied'
        ) {
          throw new WorkspaceAccessError(
            403,
            'EnterpriseSessionIpDenied',
            'Service account source IP is not allowed.',
          )
        }
      }
      return {
        account,
        enterpriseAuthorizationEvaluation,
        requestAccess,
        snapshot,
      }
    }
  let authorization =
    await authorizeCurrentServiceAccount()
  const authenticatedAccount =
    authorization.account
  const serviceAccountAuditContext = context
    ? createRequestMutationContext(
        context,
        workspaceId,
        authenticatedAccount.accountId,
        authenticatedAccount.displayName,
        {
          accountId:
            authenticatedAccount.accountId,
          authenticated: true,
        },
        `service-account-auth:${crypto.randomUUID()}`,
        'service',
      )
    : createMutationAuditContext({
        workspaceId,
        actor: {
          id: authenticatedAccount.accountId,
          kind: 'service',
          displayName:
            authenticatedAccount.displayName,
        },
        idempotencyKey:
          `service-account-auth:${crypto.randomUUID()}`,
        request: {
          method: 'SERVICE_AUTH',
          path:
            `/enterprise/service-accounts/${authenticatedAccount.accountId}/authenticate`,
          body: {
            accountId:
              authenticatedAccount.accountId,
            authenticated: true,
          },
        },
        source: {
          kind: 'system',
          method: 'SERVICE_AUTH',
          route:
            '/enterprise/service-accounts/:accountId/authenticate',
        },
      })
  await workspaceDependencies.enterpriseIdentity.serviceAccountAuthentication.recordServiceAccountUse(
    workspaceId,
    authenticatedAccount.accountId,
    serviceAccountAuditContext,
  )
  authorization =
    await authorizeCurrentServiceAccount()
  const {
    account,
    enterpriseAuthorizationEvaluation,
    requestAccess,
    snapshot,
  } = authorization
  if (
    account.accountId !==
      authenticatedAccount.accountId
  ) {
    throw new WorkspaceAccessError(
      401,
      'WorkspaceServiceAccountInvalid',
      'Service account credential is invalid or revoked.',
    )
  }
  const workspaceMember = {
    id: account.accountId,
    memberKey: account.accountId,
    email: `${account.accountId}@service-account.invalid`,
    name: account.displayName,
    role: 'member',
    status: 'active',
    provisioningSource: 'directory',
    externalIdentityId: account.accountId,
    version: 1,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  } satisfies WorkspaceMember
  await enforceActiveTenantForRequest(workspaceId, context)
  return {
    directoryId: workspaceId,
    userKey: account.accountId,
    actorId: account.accountId,
    isSystemAdmin: false,
    groups: [],
    principalKind: 'service-account',
    enterprisePermissions: requestAccess.permissions,
    enterpriseIdentityControlRevision:
      snapshot.controlRevision,
    enterpriseAuthorizationResource: requestAccess.resource,
    enterpriseGrantedRoutePermission: requestAccess.grantedRoutePermission,
    enterpriseGrantedRoutePermissions: requestAccess.grantedRoutePermissions,
    enterpriseRouteAuthorizedAtResource: requestAccess.authorizedAtResource,
    enterpriseProjectAccesses: requestAccess.projectAccesses,
    enterpriseProjectScopeAccesses: requestAccess.projectScopeAccesses,
    enterpriseAuthorizedTeamIds: requestAccess.authorizedTeamIds,
    enterpriseTeamAccesses: requestAccess.teamAccesses,
    enterpriseLegacyProjectAccessSuppressed: true,
    enterpriseAuthorizationEvaluation,
    workspaceMember,
    workspaceRole: 'member',
    workspaceMemberStatus: 'active',
  }
}

/**
 * Route permission を canonical resource と scoped collection の両方で評価します。
 *
 * @remarks
 * Team/Project scope の grant で collection endpoint を許可する場合、認可済み Team ID
 * と Project 一覧を principal に保持し、handler 側の response/query を同じ範囲へ絞り込みます。
 */
export async function evaluateEnterpriseRequestAccess(
  input: EnterpriseRequestAccessInput,
): Promise<EnterpriseRequestAccess> {
  // A Workspace-wide route is evaluated at the Workspace even when a caller supplies a
  // narrower resource, so a Team or Project grant can never count as its direct grant.
  const resource = input.context !== undefined && requiresEnterpriseDirectGrant(input.context.req.path)
    ? { workspaceId: input.workspaceId, kind: 'workspace' as const }
    : input.resource ?? await resolveEnterpriseAuthorizationResource(
      input.workspaceId,
      input.context,
    )
  if (!input.requiredPermissions || input.requiredPermissions.length === 0) {
    return {
      allowed: input.context === undefined,
      resource,
      permissions: input.principal.directPermissions ?? [],
      grantedRoutePermissions: [],
      authorizedAtResource: input.context === undefined,
      projectAccesses: [],
      projectScopeAccesses: [],
      authorizedTeamIds: [],
      teamAccesses: [],
    }
  }

  const evaluateResource = (candidateResource: EnterpriseAuthorizationResource) => {
    const decisions = input.requiredPermissions!.map((permission) => ({
      permission,
      access: evaluateEnterpriseAccess({
        permission,
        principal: input.principal,
        assignments: input.assignments,
        customRoles: input.snapshot.customRoles,
        groupMappings: input.groupMappings,
        resource: candidateResource,
      }),
    }))
    return {
      decisions,
      granted: decisions.find((decision) => decision.access.allowed),
    }
  }
  /** Evaluates the permissions used to enumerate a descendant Team or Project scope. */
  const evaluateScopeResource = (candidateResource: EnterpriseAuthorizationResource) => {
    const permissions = input.scopePermissions ?? input.requiredPermissions!
    const decisions = permissions.map((permission) => ({
      permission,
      access: evaluateEnterpriseAccess({
        permission,
        principal: input.principal,
        assignments: input.assignments,
        customRoles: input.snapshot.customRoles,
        groupMappings: input.groupMappings,
        resource: candidateResource,
      }),
    }))
    return {
      decisions,
      granted: decisions.find((decision) => decision.access.allowed),
    }
  }
  const direct = evaluateResource(resource)
  const grantedRoutePermissions = new Set<EnterprisePermissionId>()
  for (const decision of direct.decisions) {
    if (decision.access.allowed) grantedRoutePermissions.add(decision.permission)
  }
  const projectAccesses: ProjectAccessEntry[] = []
  const projectScopeAccesses: EnterpriseProjectScopeAccess[] = []
  const authorizedTeamIds = new Set<string>()
  const teamPermissionsById = new Map<string, Set<EnterprisePermissionId>>()
  const scopedPermissions = new Set<EnterprisePermissionId>()
  let scopedGrantedRoutePermission: EnterprisePermissionId | undefined
  const evaluateAllProjectScopes = input.evaluateAllProjectScopes === true
  const addTeamAccess = (
    teamId: string,
    permissions: readonly EnterprisePermissionId[],
  ) => {
    authorizedTeamIds.add(teamId)
    const teamPermissions = teamPermissionsById.get(teamId) ??
      new Set<EnterprisePermissionId>()
    for (const permission of permissions) teamPermissions.add(permission)
    teamPermissionsById.set(teamId, teamPermissions)
  }

  if (direct.granted && resource.kind === 'team' && resource.targetId) {
    addTeamAccess(resource.targetId, direct.granted.access.permissions)
  }

  if (
    input.evaluateProjectScopes === true ||
    evaluateAllProjectScopes ||
    (
      input.context &&
      shouldEvaluateEnterpriseProjectScopes(input.context.req.path, resource)
    )
  ) {
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(input.workspaceId, 'ja')
    const teams = resource.kind === 'project' && resource.parentTeamId === undefined
      ? []
      : directory.teams.filter((team) =>
        evaluateAllProjectScopes ||
        resource.kind === 'workspace' ||
        resource.kind === 'team' && resource.targetId === team.id ||
        resource.kind === 'project' && team.projects.some((project) =>
          resource.targetId === project.id &&
          (resource.parentTeamId === undefined || resource.parentTeamId === team.id)
        )
      )
    if (resource.kind === 'workspace' || evaluateAllProjectScopes) {
      for (const team of teams) {
        const scoped = evaluateScopeResource({
          workspaceId: input.workspaceId,
          kind: 'team',
          targetId: team.id,
        })
        for (const decision of scoped.decisions) {
          if (decision.access.allowed) grantedRoutePermissions.add(decision.permission)
        }
        if (!scoped.granted) continue
        scopedGrantedRoutePermission ??= scoped.granted.permission
        for (const permission of scoped.granted.access.permissions) {
          scopedPermissions.add(permission)
        }
        addTeamAccess(team.id, scoped.granted.access.permissions)
      }
    }
    const projects = teams.flatMap((team) =>
      team.projects
        .filter((project) =>
          evaluateAllProjectScopes || resource.kind !== 'project' || resource.targetId === project.id
        )
        .map((project) => ({
          projectId: project.id,
          teamId: team.id,
        }))
    )
    for (const project of projects) {
      const scoped = evaluateScopeResource({
        workspaceId: input.workspaceId,
        kind: 'project',
        targetId: project.projectId,
        parentTeamId: project.teamId,
      })
      for (const decision of scoped.decisions) {
        if (decision.access.allowed) grantedRoutePermissions.add(decision.permission)
      }
      if (!scoped.granted) continue
      const grantedScopePermissions = scoped.decisions
        .filter((decision) => decision.access.allowed)
        .map((decision) => decision.permission)
      scopedGrantedRoutePermission ??= scoped.granted.permission
      for (const permission of scoped.granted.access.permissions) {
        scopedPermissions.add(permission)
      }
      projectAccesses.push({
        projectId: project.projectId,
        role: resolveEnterpriseProjectRole([scoped.granted.permission]),
        teamId: project.teamId,
      })
      projectScopeAccesses.push({
        teamId: project.teamId,
        projectId: project.projectId,
        permissions: grantedScopePermissions,
      })
    }
  }

  // Workspace-wide resources such as Collections are not owned by any Team or Project, so
  // only a grant at the resource itself authorizes the route. Descendant scopes still feed
  // the Team and Project accesses used for item visibility.
  const directGrantOnly = input.context !== undefined &&
    requiresEnterpriseDirectGrant(input.context.req.path)
  const directRoutePermissions = direct.decisions
    .filter((decision) => decision.access.allowed)
    .map((decision) => decision.permission)
  const permissions = direct.granted
    ? direct.granted.access.permissions
    : directGrantOnly ? [] : [...scopedPermissions]
  return {
    allowed:
      direct.granted !== undefined ||
      !directGrantOnly && (authorizedTeamIds.size > 0 || projectAccesses.length > 0),
    resource,
    permissions,
    grantedRoutePermission: direct.granted?.permission ??
      (directGrantOnly ? undefined : scopedGrantedRoutePermission),
    grantedRoutePermissions: directGrantOnly ? directRoutePermissions : [...grantedRoutePermissions],
    authorizedAtResource: direct.granted !== undefined,
    projectAccesses,
    projectScopeAccesses,
    authorizedTeamIds: [...authorizedTeamIds],
    teamAccesses: [...teamPermissionsById].map(([teamId, permissions]) => ({
      teamId,
      permissions: [...permissions],
    })),
  }
}

/**
 * Team/Project scope の grant で安全に絞り込める resource-oriented route か判定します。
 */
function shouldEvaluateEnterpriseProjectScopes(
  path: string,
  resource: EnterpriseAuthorizationResource,
) {
  if (resource.kind === 'project') return true
  // Collection metadata is Workspace-scoped; only candidate and item routes read Work Items.
  if (/^\/api\/collections(?:\/|$)/u.test(path)) {
    return /^\/api\/collections\/(?:candidates|[^/]+\/items)(?:\/|$)/u.test(path)
  }
  return /^\/api\/(?:analytics|approvals|bulk-operations|document-backlinks|documents|focus|notifications|planning|projects|realtime\/tickets|task-views|teams|work-item-configuration|work-items)(?:\/|$)/u
    .test(path)
}

/**
 * Returns whether a route is authorized only by a grant at the requested resource.
 *
 * @param path - Request path.
 * @returns Whether Team or Project grants must not authorize the route.
 */
function requiresEnterpriseDirectGrant(path: string): boolean {
  return /^\/api\/collections(?:\/|$)/u.test(path)
}

/** Returns whether the notification list needs Enterprise content scopes for visibility checks. */
function shouldEvaluateEnterpriseNotificationScopes(context?: Context): boolean {
  return context?.req.method === 'GET' && (
    context.req.path === '/api/notifications' ||
    context.req.path.startsWith('/api/notifications/')
  )
}

async function resolveEnterpriseAuthorizationResource(
  workspaceId: string,
  context: Context | undefined,
): Promise<EnterpriseAuthorizationResource> {
  const path = context?.req.path
  // Workspace-wide routes are authorized at the Workspace; Team or Project segments in their
  // paths, such as a Collection item's Team ID, are data and must not pick a narrower resource.
  if (path !== undefined && requiresEnterpriseDirectGrant(path)) {
    return { workspaceId, kind: 'workspace' as const }
  }
  const planningUpdateResource = await resolvePlanningUpdateAuthorizationResource(
    workspaceId,
    context,
  )
  if (planningUpdateResource) return planningUpdateResource
  const issueMatch = path?.match(/\/teams\/([^/]+)\/issues\/([^/]+)/u)
  let teamId = issueMatch?.[1] ? decodeURIComponent(issueMatch[1]) : undefined
  let issueId = issueMatch?.[2] ? decodeURIComponent(issueMatch[2]) : undefined
  if (path === '/api/realtime/tickets' && context?.req.method === 'POST') {
    const body = await context.req.raw.clone().json().catch(() => undefined) as
      | Record<string, unknown>
      | undefined
    teamId = typeof body?.teamId === 'string' ? body.teamId.trim() : undefined
    issueId = typeof body?.issueId === 'string' ? body.issueId.trim() : undefined
  }
  if (teamId && issueId) {
    const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
      workspaceId,
      teamId,
      issueId,
      { consistentIssueRead: true, includeEvents: false },
    )
    if (detail.issue.assignedProjectId) {
      return {
        workspaceId,
        kind: 'project',
        targetId: detail.issue.assignedProjectId,
        parentTeamId: teamId,
      }
    }
    return { workspaceId, kind: 'team', targetId: teamId }
  }
  const issueCollectionMatch = path?.match(/\/teams\/([^/]+)\/issues$/u)
  if (issueCollectionMatch?.[1] && context?.req.method === 'POST') {
    const issueTeamId = decodeURIComponent(issueCollectionMatch[1])
    const body = await context.req.raw.clone().json().catch(() => undefined)
    const assignedProjectId = isRecord(body) && typeof body.assignedProjectId === 'string'
      ? body.assignedProjectId.trim()
      : undefined
    if (assignedProjectId) {
      return {
        workspaceId,
        kind: 'project',
        targetId: assignedProjectId,
        parentTeamId: issueTeamId,
      }
    }
    return { workspaceId, kind: 'team', targetId: issueTeamId }
  }
  if (path?.startsWith('/api/planning/work-item-links/')) {
    const linkMatch = path.match(/\/work-item-links\/([^/]+)\/([^/]+)/u)
    const linkTeamId = linkMatch?.[1] ? decodeURIComponent(linkMatch[1]) : undefined
    const workItemId = linkMatch?.[2] ? decodeURIComponent(linkMatch[2]) : undefined
    if (linkTeamId && workItemId) {
      const detail = await workItemDependencies.teamIssues.getTeamIssueDetail(
        workspaceId,
        linkTeamId,
        workItemId,
        { consistentIssueRead: true, includeEvents: false },
      )
      if (detail.issue.assignedProjectId) {
        return {
          workspaceId,
          kind: 'project',
          targetId: detail.issue.assignedProjectId,
          parentTeamId: linkTeamId,
        }
      }
      return { workspaceId, kind: 'team', targetId: linkTeamId }
    }
  }
  if (path?.startsWith('/api/planning/entities')) {
    const entityId = path.match(/\/planning\/entities\/([^/]+)/u)?.[1]
    if (entityId) {
      const authorizationState = await workItemDependencies.planning.getAuthorizationState(workspaceId)
      const entity = authorizationState.entities.find((candidate) =>
        candidate.id === decodeURIComponent(entityId)
      )
      if (entity?.projectId) {
        return {
          workspaceId,
          kind: 'project',
          targetId: entity.projectId,
          parentTeamId: entity.teamId,
        }
      }
      if (entity?.teamId) {
        return { workspaceId, kind: 'team', targetId: entity.teamId }
      }
    } else if (context?.req.method === 'POST') {
      const body = await context.req.raw.clone().json().catch(() => undefined)
      const planningProjectId = isRecord(body) && typeof body.projectId === 'string'
        ? body.projectId.trim()
        : undefined
      const planningTeamId = isRecord(body) && typeof body.teamId === 'string'
        ? body.teamId.trim()
        : undefined
      if (planningProjectId) {
        return {
          workspaceId,
          kind: 'project',
          targetId: planningProjectId,
          ...(planningTeamId ? { parentTeamId: planningTeamId } : {}),
        }
      }
      if (planningTeamId) {
        return { workspaceId, kind: 'team', targetId: planningTeamId }
      }
    }
  }
  const planningCycleId = path?.match(/\/api\/planning\/cycles\/([^/]+)/u)?.[1]
  if (planningCycleId) {
    const authorizationState = await workItemDependencies.planning.getAuthorizationState(workspaceId)
    const cycle = authorizationState.entities.find((candidate) =>
      candidate.id === decodeURIComponent(planningCycleId)
    )
    if (cycle?.projectId) {
      return {
        workspaceId,
        kind: 'project',
        targetId: cycle.projectId,
        parentTeamId: cycle.teamId,
      }
    }
    if (cycle?.teamId) {
      return { workspaceId, kind: 'team', targetId: cycle.teamId }
    }
  }
  if (path === '/api/projects/quick-access') {
    return { workspaceId, kind: 'workspace' as const }
  }
  const projectId = path?.match(/\/projects\/([^/]+)/u)?.[1]
  if (projectId) {
    const decodedProjectId = decodeURIComponent(projectId)
    const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(workspaceId, 'ja')
    const ownerTeamIds = new Set(
      directory.teams
        .filter((team) => team.projects.some((project) => project.id === decodedProjectId))
        .map((team) => team.id),
    )
    const parentTeamId = ownerTeamIds.size === 1
      ? ownerTeamIds.values().next().value
      : undefined
    return {
      workspaceId,
      kind: 'project' as const,
      targetId: decodedProjectId,
      parentTeamId,
    }
  }
  if (path === '/api/teams/projects') {
    return { workspaceId, kind: 'workspace' as const }
  }
  const pathTeamId = path?.match(/\/teams\/([^/]+)/u)?.[1]
  if (pathTeamId) {
    return {
      workspaceId,
      kind: 'team' as const,
      targetId: decodeURIComponent(pathTeamId),
    }
  }
  return { workspaceId, kind: 'workspace' as const }
}

/**
 * Resolves a qualified Planning update target before enterprise route authorization runs.
 *
 * @param workspaceId - Authenticated Workspace identifier.
 * @param context - Current HTTP context containing the target query or mutation body.
 * @returns The exact Workspace, Team, or Project resource, or undefined for another route.
 */
async function resolvePlanningUpdateAuthorizationResource(
  workspaceId: string,
  context: Context | undefined,
): Promise<EnterpriseAuthorizationResource | undefined> {
  const path = context?.req.path
  if (
    !path ||
    !path.startsWith('/api/planning/updates') &&
      path !== '/api/planning/update-watch'
  ) {
    return undefined
  }

  let target: unknown
  if (
    context.req.method !== 'GET' &&
    (path === '/api/planning/updates' || path === '/api/planning/updates/cadence')
  ) {
    const body = await context.req.raw.clone().json().catch(() => undefined)
    target = isRecord(body) ? body.target : undefined
  } else {
    target = {
      type: context.req.query('targetType'),
      teamId: context.req.query('teamId'),
      projectId: context.req.query('projectId'),
      entityId: context.req.query('entityId'),
    }
  }

  if (!isRecord(target)) return { workspaceId, kind: 'workspace' }
  if (
    target.type === 'project' &&
    typeof target.teamId === 'string' &&
    target.teamId.trim() &&
    typeof target.projectId === 'string' &&
    target.projectId.trim()
  ) {
    return {
      workspaceId,
      kind: 'project',
      targetId: target.projectId.trim(),
      parentTeamId: target.teamId.trim(),
    }
  }
  if (
    target.type !== 'initiative' ||
    typeof target.entityId !== 'string' ||
    !target.entityId.trim()
  ) {
    return { workspaceId, kind: 'workspace' }
  }

  const entityId = target.entityId.trim()
  const authorizationState = await workItemDependencies.planning.getAuthorizationState(workspaceId)
  const entity = authorizationState.entities.find((candidate) =>
    candidate.id === entityId && candidate.type === 'initiative'
  )
  if (entity?.projectId) {
    return {
      workspaceId,
      kind: 'project',
      targetId: entity.projectId,
      parentTeamId: entity.teamId,
    }
  }
  if (entity?.teamId) {
    return { workspaceId, kind: 'team', targetId: entity.teamId }
  }
  return { workspaceId, kind: 'workspace' }
}

/**
 * Authenticates the request and requires request intake administration rights.
 *
 * @param c - Hono request context.
 * @returns The authenticated administrator principal.
 */
export async function requireRequestAdministration(c: Context) {
  const accessToken = readBearerAccessToken(c)
  if (!accessToken) {
    throw new RequestIntakeError(401, 'RequestAuthenticationRequired', 'Bearer token is required.')
  }
  const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
  requireWorkspaceAdministration(principal)
  return principal
}

/**
 * Rechecks the parent Work Item scope after a curated-context read completes.
 *
 * @param principal - Current authenticated Workspace principal.
 * @param teamId - Owning Team identifier.
 * @param issueId - Canonical Work Item identifier.
 * @param minimumRole - Minimum current Project role required for the read.
 * @param initialAssignedProjectId - Project assignment observed before the read.
 * @param accessToken - Access token used to re-resolve Enterprise authorization before return.
 * @param context - Current route context used by the authentication refresh.
 * @returns The freshly authenticated principal after the parent scope is verified unchanged.
 */
export async function assertCuratedContextScopeUnchanged(
  principal: WorkspacePrincipal,
  teamId: string,
  issueId: string,
  minimumRole: ProjectRole,
  initialAssignedProjectId: string | undefined,
  accessToken: string,
  context: Context,
): Promise<WorkspacePrincipal> {
  const currentPrincipal = await authenticateWorkspacePrincipal(accessToken, undefined, context)
  const current = await loadAuthorizedTeamIssue(
    currentPrincipal,
    teamId,
    issueId,
    minimumRole,
  )
  if (current.detail.issue.assignedProjectId !== initialAssignedProjectId) {
    throw new CollaborationError(
      409,
      'CollaborationConflict',
      'Work Item assignment changed while curated context was loading.',
    )
  }
  return currentPrincipal
}
