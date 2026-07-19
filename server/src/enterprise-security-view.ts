import {
  ENTERPRISE_BUILT_IN_ROLE_IDS,
  ENTERPRISE_PERMISSION_IDS,
  type EnterpriseIdentityProvider,
  type EnterpriseIdentitySnapshot,
  type EnterprisePermissionId,
  type EnterpriseSecurityPolicy,
} from '@mukuroji/contracts'
import {
  canAssignEnterpriseRole,
  resolveEnterpriseRolePermissions,
} from './enterprise-identity'

const permissionMetadata = {
  'workspace.read': ['workspace', 'View workspace', 'View workspace settings and navigation.', false],
  'workspace.write': ['workspace', 'Edit workspace', 'Create and update workspace content.', false],
  'workspace.manage': ['workspace', 'Manage workspace', 'Change workspace-wide administration settings.', true],
  'members.read': ['members', 'View members', 'View members and invitations.', false],
  'members.manage': ['members', 'Manage members', 'Invite, change, and deactivate members.', true],
  'teams.read': ['content', 'View teams', 'View team directories.', false],
  'teams.write': ['content', 'Edit teams', 'Create and update team content.', false],
  'teams.manage': ['content', 'Manage teams', 'Change team settings and membership.', false],
  'projects.read': ['content', 'View projects', 'View projects in the assigned scope.', false],
  'projects.write': ['content', 'Edit projects', 'Create and update project content.', false],
  'projects.manage': ['content', 'Manage projects', 'Change project settings and membership.', false],
  'work-items.read': ['content', 'View work items', 'View work items in the assigned scope.', false],
  'work-items.write': ['content', 'Edit work items', 'Create and update work items.', false],
  'files.read': ['content', 'View files', 'View files and review history.', false],
  'files.write': ['content', 'Edit files', 'Upload files and add annotations.', false],
  'files.approve': ['content', 'Approve files', 'Record file approval decisions.', false],
  'requests.read': ['content', 'View requests', 'View request intake queues.', false],
  'requests.manage': ['content', 'Manage requests', 'Triage and convert request submissions.', false],
  'planning.read': ['content', 'View planning', 'View planning entities and dependencies.', false],
  'planning.write': ['content', 'Edit planning', 'Create and update planning entities.', false],
  'planning.manage': ['content', 'Manage planning', 'Change shared planning configuration.', false],
  'automation.read': ['automation', 'View automation', 'View rules, templates, and executions.', false],
  'automation.manage': ['automation', 'Manage automation', 'Create and run automation.', true],
  'audit.read': ['security', 'View audit log', 'View immutable audit events.', true],
  'audit.export': ['security', 'Export audit log', 'Export audit events outside the workspace.', true],
  'identity.read': ['security', 'View identity', 'View SSO and provisioning configuration.', true],
  'identity.manage': ['security', 'Manage identity', 'Change SSO, domains, and provisioning.', true],
  'security.read': ['security', 'View security', 'View authentication and access policies.', true],
  'security.manage': ['security', 'Manage security', 'Change authentication and access policies.', true],
  'service-accounts.use': ['automation', 'Use service accounts', 'Authenticate as a service account.', true],
  'service-accounts.manage': ['security', 'Manage service accounts', 'Issue and revoke machine credentials.', true],
} as const satisfies Record<
  EnterprisePermissionId,
  readonly [
    'workspace' | 'members' | 'content' | 'security' | 'automation',
    string,
    string,
    boolean,
  ]
>

const builtInPermissions = Object.fromEntries(
  ENTERPRISE_BUILT_IN_ROLE_IDS.map((roleId) => [
    roleId,
    resolveEnterpriseRolePermissions([], roleId),
  ]),
) as Record<(typeof ENTERPRISE_BUILT_IN_ROLE_IDS)[number], EnterprisePermissionId[]>
const guestPermissions = builtInPermissions['workspace:guest']

const builtInRoles = [
  {
    id: 'workspace:owner',
    name: 'Workspace owner',
    description: 'Full workspace access, including security and audit export.',
    permissions: builtInPermissions['workspace:owner'],
  },
  {
    id: 'workspace:admin',
    name: 'Workspace administrator',
    description: 'Workspace administration without owner-only audit export.',
    permissions: builtInPermissions['workspace:admin'],
  },
  {
    id: 'workspace:member',
    name: 'Workspace member',
    description: 'Standard collaboration and content access.',
    permissions: builtInPermissions['workspace:member'],
  },
  {
    id: 'workspace:guest',
    name: 'Guest',
    description: 'Read-only access capped by the external access policy.',
    permissions: builtInPermissions['workspace:guest'],
  },
  {
    id: 'team:manager',
    name: 'Team manager',
    description: 'Manage a Team, its Projects, Work Items, files, and planning links.',
    permissions: builtInPermissions['team:manager'],
  },
  {
    id: 'team:member',
    name: 'Team member',
    description: 'Collaborate on Team Projects, Work Items, files, and planning links.',
    permissions: builtInPermissions['team:member'],
  },
  {
    id: 'project:manager',
    name: 'Project manager',
    description: 'Manage a Project and its Work Items, files, approvals, and planning links.',
    permissions: builtInPermissions['project:manager'],
  },
  {
    id: 'project:member',
    name: 'Project member',
    description: 'Collaborate on a Project and its Work Items, files, and planning links.',
    permissions: builtInPermissions['project:member'],
  },
  {
    id: 'project:viewer',
    name: 'Project viewer',
    description: 'Read-only Project, Work Item, file, and planning access.',
    permissions: builtInPermissions['project:viewer'],
  },
] as const

/**
 * Enterprise security policy が未設定の Workspace に適用する fail-safe default を返します。
 */
export function createDefaultEnterpriseSecurityPolicy(
  workspaceId: string,
  actorId = 'system',
): EnterpriseSecurityPolicy {
  return {
    workspaceId,
    loginMode: 'password-or-sso',
    mfaRequirement: 'optional',
    sessionLifetimeMinutes: 720,
    idleTimeoutMinutes: 60,
    reauthenticationIntervalMinutes: 120,
    sensitiveActionReauthenticationMinutes: 15,
    ipAllowlistMode: 'disabled',
    ipAllowlist: [],
    externalAccess: {
      allowGuests: true,
      allowExternalCollaborators: true,
      requireMfa: false,
      maximumSessionLifetimeMinutes: 240,
      allowedGuestDomains: [],
      permissionCeiling: guestPermissions,
    },
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    updatedBy: actorId,
  }
}

/**
 * Domain login discovery と管理 UI が利用する provider URL を返します。
 */
export function resolveEnterpriseIdentityProviderAuthorizationUrl(
  provider: EnterpriseIdentityProvider,
) {
  return provider.kind === 'saml'
    ? provider.singleSignOnUrl
    : provider.authorizationEndpoint
}

/**
 * Domain login discovery と管理 UI が利用する provider issuer を返します。
 */
export function resolveEnterpriseIdentityProviderIssuer(
  provider: EnterpriseIdentityProvider,
) {
  return provider.kind === 'saml' ? provider.entityId : provider.issuer
}

/**
 * Domain login discovery と管理 UI が利用する provider client/audience を返します。
 */
export function resolveEnterpriseIdentityProviderClientId(
  provider: EnterpriseIdentityProvider,
) {
  return provider.kind === 'saml' ? provider.entityId : provider.clientId
}

/**
 * Domain login discovery と管理 UI が利用する provider 設定を返します。
 */
export function toEnterpriseSecuritySnapshotView(
  snapshot: EnterpriseIdentitySnapshot,
  scimEndpointUrl: string,
  effectivePermissions: readonly EnterprisePermissionId[] = ENTERPRISE_PERMISSION_IDS,
) {
  const provider = snapshot.identityProviders.find((candidate) => candidate.status === 'active') ??
    snapshot.identityProviders[0]
  const policy = snapshot.policy ??
    createDefaultEnterpriseSecurityPolicy(snapshot.workspaceId)
  const activeScimCredentials = snapshot.scimCredentials.filter((credential) =>
    credential.identityProviderId === provider?.providerId &&
    credential.revokedAt === undefined &&
    (credential.expiresAt === undefined || Date.parse(credential.expiresAt) > Date.now())
  )
  const currentActiveScimCredential = activeScimCredentials
    .toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.credentialId.localeCompare(right.credentialId)
    )
    .at(-1)
  const groupByProviderAndId = new Map(
    snapshot.scimGroups.flatMap((group) => [
      [`${group.identityProviderId}\0${group.groupId}`, group] as const,
      [`${group.identityProviderId}\0${group.externalId}`, group] as const,
    ]),
  )
  const assignmentCountByRole = new Map<string, number>()
  for (const assignment of snapshot.roleAssignments) {
    assignmentCountByRole.set(
      assignment.roleId,
      (assignmentCountByRole.get(assignment.roleId) ?? 0) + 1,
    )
  }
  for (const mapping of snapshot.groupMappings) {
    assignmentCountByRole.set(
      mapping.roleId,
      (assignmentCountByRole.get(mapping.roleId) ?? 0) + 1,
    )
  }
  for (const account of snapshot.serviceAccounts) {
    if (account.status !== 'active') continue
    assignmentCountByRole.set(
      account.roleId,
      (assignmentCountByRole.get(account.roleId) ?? 0) + 1,
    )
  }

  const identityProvider = provider
    ? {
        id: provider.providerId,
        status: provider.status === 'active' ? 'verified' : 'draft',
        protocol: provider.kind,
        displayName: provider.displayName,
        issuer: resolveEnterpriseIdentityProviderIssuer(provider),
        ssoUrl: resolveEnterpriseIdentityProviderAuthorizationUrl(provider),
        clientId: resolveEnterpriseIdentityProviderClientId(provider),
        ...(provider.kind === 'saml' ? { metadataUrl: provider.metadataUrl } : {}),
        lastTestSucceeded: provider.status === 'active',
        lastTestedAt: provider.lastTestedAt,
        enforced: snapshot.domains.some((domain) =>
          domain.enforceSso && domain.identityProviderId === provider.providerId
        ),
        version: provider.revision,
      }
    : {
        id: '',
        status: 'not-configured',
        protocol: 'saml',
        displayName: '',
        issuer: '',
        ssoUrl: '',
        clientId: '',
        lastTestSucceeded: false,
        enforced: false,
        version: 0,
      }
  const canReadIdentity = effectivePermissions.some((permission) =>
    permission === 'identity.read' ||
    permission === 'identity.manage' ||
    permission === 'security.manage'
  )
  const canReadSecurity = effectivePermissions.some((permission) =>
    permission === 'security.read' || permission === 'security.manage'
  )
  const canReadMappings = canReadSecurity || effectivePermissions.some((permission) =>
    permission === 'members.read' ||
    permission === 'members.manage'
  )
  const canReadPrivileged = canReadSecurity || effectivePermissions.includes(
    'service-accounts.manage',
  )
  const canReadRoleCatalog = canReadMappings || canReadPrivileged
  const visiblePolicy = canReadSecurity
    ? policy
    : createDefaultEnterpriseSecurityPolicy(snapshot.workspaceId)
  const roleIds = [
    ...ENTERPRISE_BUILT_IN_ROLE_IDS,
    ...snapshot.customRoles.map((role) => role.roleId),
  ]
  const assignableRoleIdsForScope = (
    scopeKind: 'workspace' | 'team' | 'project',
  ) => roleIds.filter((roleId) =>
    canAssignEnterpriseRole(
      snapshot.customRoles,
      effectivePermissions,
      roleId,
      scopeKind,
    )
  )

  return {
    capabilities: {
      canView: canReadIdentity || canReadSecurity || canReadMappings || canReadPrivileged,
      canViewIdentity: canReadIdentity,
      canViewProvisioning: canReadIdentity,
      canViewAccess: canReadMappings,
      canViewSessions: canReadSecurity,
      canViewPrivileged: canReadPrivileged,
      canManageIdentity: effectivePermissions.includes('identity.manage') ||
        effectivePermissions.includes('security.manage'),
      canManageProvisioning: effectivePermissions.includes('identity.manage'),
      canManageAccess: effectivePermissions.includes('members.manage') ||
        effectivePermissions.includes('security.manage'),
      canManageMappings: effectivePermissions.includes('members.manage') ||
        effectivePermissions.includes('security.manage'),
      canManageRoles: effectivePermissions.includes('security.manage'),
      canManageSessions: effectivePermissions.includes('security.manage'),
      canManagePrivilegedAccess: effectivePermissions.includes('service-accounts.manage') ||
        effectivePermissions.includes('security.manage'),
      canManageBreakGlass: effectivePermissions.includes('security.manage'),
    },
    assignableRoleIds: {
      groupMappings: {
        workspace: assignableRoleIdsForScope('workspace'),
        team: assignableRoleIdsForScope('team'),
        project: assignableRoleIdsForScope('project'),
      },
      serviceAccounts: assignableRoleIdsForScope('workspace'),
    },
    assignablePermissionIds: canReadSecurity
      ? ENTERPRISE_PERMISSION_IDS.filter((permission) =>
          effectivePermissions.includes(permission)
        )
      : [],
    identityProvider: canReadIdentity
      ? identityProvider
      : {
          status: 'not-configured',
          protocol: 'saml',
          displayName: '',
          issuer: '',
          ssoUrl: '',
          clientId: '',
          lastTestSucceeded: false,
          enforced: false,
          version: 0,
        },
    ssoPrerequisites: {
      providerReady: canReadIdentity && snapshot.identityProviders.some((candidate) =>
        candidate.status === 'active'
      ),
      domainReady: canReadIdentity && snapshot.domains.some((domain) =>
        domain.status === 'verified'
      ),
      breakGlassReady: canReadIdentity && snapshot.breakGlassAccounts.some((account) =>
        account.status === 'active' &&
        account.requireMfa &&
        Number.isFinite(Date.parse(account.mfaVerifiedAt)) &&
        Number.isFinite(Date.parse(account.lastTestedAt ?? '')) &&
        Date.parse(account.lastTestedAt ?? '') <= Date.now() &&
        Date.now() - Date.parse(account.lastTestedAt ?? '') <= 30 * 24 * 60 * 60_000 &&
        !snapshot.domains.some((domain) =>
          domain.status === 'verified' &&
          domain.domain === account.email.slice(account.email.lastIndexOf('@') + 1)
            .trim()
            .toLowerCase()
        )
      ),
    },
    domains: (canReadIdentity ? snapshot.domains : []).map((domain) => ({
      id: domain.domainId,
      domain: domain.domain,
      status: domain.status === 'failed' ? 'conflict' : domain.status,
      verificationRecordName: domain.verificationRecordName,
      verifiedAt: domain.verifiedAt,
      version: domain.revision,
    })),
    scim: {
      identityProviderId: canReadIdentity ? provider?.providerId ?? '' : '',
      status: canReadIdentity && activeScimCredentials.length > 0 ? 'ready' : 'disabled',
      endpointUrl: canReadIdentity ? scimEndpointUrl : '',
      tokenGeneration: canReadIdentity
        ? snapshot.scimCredentials.filter((credential) =>
            credential.identityProviderId === provider?.providerId
          ).length
        : 0,
      ...(canReadIdentity &&
          currentActiveScimCredential &&
          /^[A-Za-z0-9_-]{4}$/.test(currentActiveScimCredential.tokenLastFour)
        ? { tokenLastFour: currentActiveScimCredential.tokenLastFour }
        : {}),
      lastSyncAt: (canReadIdentity
        ? snapshot.scimUsers.filter((user) =>
            user.identityProviderId === provider?.providerId
          )
        : [])
        .map((user) => user.updatedAt)
        .sort()
        .at(-1),
      version: canReadIdentity
        ? snapshot.scimCredentials.filter((credential) =>
            credential.identityProviderId === provider?.providerId
          ).length
        : 0,
    },
    mappings: (canReadMappings ? snapshot.groupMappings : []).map((mapping) => ({
      id: mapping.mappingId,
      identityProviderId: mapping.identityProviderId,
      directoryGroupId: mapping.directoryGroupId,
      directoryGroupName:
        groupByProviderAndId
          .get(`${mapping.identityProviderId}\0${mapping.directoryGroupId}`)
          ?.displayName ?? mapping.directoryGroupId,
      scopeType: mapping.scope.kind,
      scopeId: mapping.scope.targetId ?? mapping.scope.workspaceId,
      scopeName: mapping.scope.targetId ?? 'Workspace',
      roleId: mapping.roleId,
      version: mapping.revision,
    })),
    roles: canReadRoleCatalog ? [
      ...builtInRoles.map((role) => ({
        id: role.id,
        name: role.name,
        description: role.description,
        kind: 'built-in',
        permissionIds: canReadSecurity ? role.permissions : [],
        guestAssignable: role.id === 'workspace:guest' || role.id === 'project:viewer',
        assignmentCount: assignmentCountByRole.get(role.id) ?? 0,
        version: 1,
      })),
      ...snapshot.customRoles.map((role) => ({
        id: role.roleId,
        name: role.name,
        description: role.description ?? '',
        kind: 'custom',
        permissionIds: canReadSecurity ? role.permissions : [],
        guestAssignable: role.guestAssignable,
        assignmentCount: assignmentCountByRole.get(role.roleId) ?? 0,
        version: role.revision,
      })),
    ] : [],
    permissions: (canReadSecurity ? ENTERPRISE_PERMISSION_IDS : []).map((permission) => {
      const [group, name, description, privileged] = permissionMetadata[permission]
      return { id: permission, group, name, description, privileged }
    }),
    sessionPolicy: {
      mfaRequired: visiblePolicy.mfaRequirement === 'required',
      sessionLifetimeMinutes: visiblePolicy.sessionLifetimeMinutes,
      idleTimeoutMinutes: visiblePolicy.idleTimeoutMinutes,
      reauthenticationMinutes: visiblePolicy.reauthenticationIntervalMinutes,
      sensitiveActionReauthenticationMinutes:
        visiblePolicy.sensitiveActionReauthenticationMinutes,
      ipAllowlist: visiblePolicy.ipAllowlist,
      guestsAllowed: visiblePolicy.externalAccess.allowGuests,
      externalCollaboratorsAllowed:
        visiblePolicy.externalAccess.allowExternalCollaborators,
      guestSessionLifetimeMinutes:
        visiblePolicy.externalAccess.maximumSessionLifetimeMinutes,
      allowedGuestDomains: [...visiblePolicy.externalAccess.allowedGuestDomains],
      version: visiblePolicy.revision,
    },
    serviceAccounts: (canReadPrivileged ? snapshot.serviceAccounts : []).map((account) => ({
      id: account.accountId,
      name: account.displayName,
      status: account.status === 'active' ? 'active' : 'revoked',
      roleId: account.roleId,
      scopeType: account.scope.kind,
      scopeId: account.scope.targetId,
      credentialLifetimeDays: account.credentialLifetimeDays,
      credentialExpiresAt: account.credentialExpiresAt,
      allowedSourceCidrs: account.allowedSourceCidrs,
      credentialGeneration: account.credentialGeneration,
      createdAt: account.createdAt,
      lastUsedAt: account.lastUsedAt,
      version: account.revision,
    })),
    breakGlassAdministrators: (canReadPrivileged ? snapshot.breakGlassAccounts : [])
      .map((account) => ({
      id: account.accountId,
      email: account.email,
      status: account.status,
      mfaConfigured: true,
      lastTestedAt: account.lastTestedAt,
      version: account.revision,
    })),
    provisioningLogs: (canReadIdentity ? snapshot.provisioningRuns : []).map((run) => ({
      id: run.runId,
      operation: run.source === 'scim' ? 'scim' : 'reconcile',
      status: run.status === 'pending' ? 'running' : run.status,
      summary: run.status === 'failed'
        ? `Provisioning failed (${run.failureCode ?? 'unknown'}).`
        : `${run.changes.length} provisioning change(s).`,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      retryable: run.status === 'failed',
      attempts: run.attempt,
    })),
  }
}
