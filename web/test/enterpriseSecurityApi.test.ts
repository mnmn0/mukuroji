import { afterEach, describe, expect, test } from 'bun:test'
import {
  activateEnterpriseBreakGlassAccess,
  EnterpriseSecurityApiError,
  createEnterpriseDomainClaim,
  createEnterpriseServiceAccount,
  deleteEnterpriseRole,
  getEnterpriseSecuritySnapshot,
  previewEnterpriseProvisioning,
  previewEnterpriseRoleImpact,
  previewEnterpriseSessionPolicy,
  registerEnterpriseBreakGlassAdministrator,
  revokeEnterpriseBreakGlassAccess,
  rotateEnterpriseScimToken,
  testEnterpriseBreakGlassAccess,
  updateEnterpriseGroupRoleMapping,
  updateEnterpriseSessionPolicy,
} from '../src/security/api'
import {
  enterpriseProvisioningImpactFixture,
  enterpriseScimTokenResponseFixture,
  enterpriseSecuritySnapshotFixture,
  enterpriseServiceAccountCredentialResponseFixture,
} from '../src/security/fixtures'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-security-1',
  idempotencyKey: 'idempotency-security-1',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('enterprise security API', () => {
  test('loads the aggregate snapshot and defaults absent logs to an empty list', async () => {
    const snapshotWithoutLogs = {
      ...enterpriseSecuritySnapshotFixture,
      provisioningLogs: undefined,
    }
    const requests = installFetchRecorder(snapshotWithoutLogs)

    const snapshot = await getEnterpriseSecuritySnapshot('access-token')

    expect(snapshot.provisioningLogs).toEqual([])
    expect(snapshot.scim.tokenLastFour).toBe('A7xQ')
    expect(requests[0]?.url).toBe('/api/enterprise/security')
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
      'Content-Type': 'application/json',
    })
  })

  test('loads only server-confirmed current-member recovery state', async () => {
    installFetchRecorder({
      ...enterpriseSecuritySnapshotFixture,
      activeBreakGlassActivation: {
        expiresAt: '2026-07-18T12:30:00.000Z',
      },
    })

    const snapshot =
      await getEnterpriseSecuritySnapshot('access-token')

    expect(snapshot.activeBreakGlassActivation).toEqual({
      expiresAt: '2026-07-18T12:30:00.000Z',
    })
  })

  test('accepts retained revoked service accounts without a current expiry', async () => {
    installFetchRecorder({
      ...enterpriseSecuritySnapshotFixture,
      serviceAccounts:
        enterpriseSecuritySnapshotFixture.serviceAccounts.map(
          (account) => ({
            ...account,
            credentialExpiresAt: undefined,
            status: 'revoked' as const,
          }),
        ),
    })

    const snapshot =
      await getEnterpriseSecuritySnapshot('access-token')

    expect(snapshot.serviceAccounts[0]?.status).toBe('revoked')
    expect(
      snapshot.serviceAccounts[0]?.credentialExpiresAt,
    ).toBeUndefined()
  })

  test('fails closed when split access capabilities are missing', async () => {
    const incompleteCapabilities = {
      ...enterpriseSecuritySnapshotFixture.capabilities,
      canViewAccess: undefined,
    }
    installFetchRecorder({
      ...enterpriseSecuritySnapshotFixture,
      capabilities: incompleteCapabilities,
    })

    await expect(
      getEnterpriseSecuritySnapshot('access-token'),
    ).rejects.toBeInstanceOf(EnterpriseSecurityApiError)
  })

  test('fails closed when the caller permission grant ceiling is missing', async () => {
    installFetchRecorder({
      ...enterpriseSecuritySnapshotFixture,
      assignablePermissionIds: undefined,
    })

    await expect(
      getEnterpriseSecuritySnapshot('access-token'),
    ).rejects.toBeInstanceOf(EnterpriseSecurityApiError)
  })

  test('rejects an unsafe SCIM token suffix in the aggregate snapshot', async () => {
    installFetchRecorder({
      ...enterpriseSecuritySnapshotFixture,
      scim: {
        ...enterpriseSecuritySnapshotFixture.scim,
        tokenLastFour: 'too-long',
      },
    })

    await expect(
      getEnterpriseSecuritySnapshot('access-token'),
    ).rejects.toBeInstanceOf(EnterpriseSecurityApiError)
  })

  test('loads section-limited aggregate snapshots without a separate log request', async () => {
    const sectionCapabilities = [
      {
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canManageAccess: true,
        canManageBreakGlass: false,
        canManageIdentity: false,
        canManageMappings: true,
        canManagePrivilegedAccess: false,
        canManageProvisioning: false,
        canManageRoles: false,
        canManageSessions: false,
        canViewAccess: true,
        canViewIdentity: false,
        canViewPrivileged: false,
        canViewProvisioning: false,
        canViewSessions: false,
      },
      {
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canManageAccess: false,
        canManageBreakGlass: false,
        canManageIdentity: false,
        canManageMappings: false,
        canManagePrivilegedAccess: true,
        canManageProvisioning: false,
        canManageRoles: false,
        canManageSessions: false,
        canViewAccess: true,
        canViewIdentity: false,
        canViewPrivileged: true,
        canViewProvisioning: false,
        canViewSessions: false,
      },
    ]

    for (const capabilities of sectionCapabilities) {
      const requests = installFetchRecorder({
        ...enterpriseSecuritySnapshotFixture,
        capabilities,
        provisioningLogs: [],
      })

      const snapshot = await getEnterpriseSecuritySnapshot('access-token')

      expect(snapshot.capabilities).toEqual(capabilities)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.url).toBe('/api/enterprise/security')
    }
  })

  test('accepts the server redacted identity shape for privileged-only callers', async () => {
    installFetchRecorder({
      ...enterpriseSecuritySnapshotFixture,
      capabilities: {
        ...enterpriseSecuritySnapshotFixture.capabilities,
        canManageIdentity: false,
        canViewIdentity: false,
        canViewPrivileged: true,
      },
      identityProvider: {
        ...enterpriseSecuritySnapshotFixture.identityProvider,
        id: undefined,
      },
    })

    const snapshot =
      await getEnterpriseSecuritySnapshot('access-token')

    expect(snapshot.identityProvider.id).toBe('')
    expect(snapshot.capabilities.canViewPrivileged).toBe(true)
  })

  test('tracks domain and token mutations with idempotency headers', async () => {
    const requests = installFetchRecorder((url) =>
      url.endsWith('/scim/token')
        ? enterpriseScimTokenResponseFixture
        : {
            domain: enterpriseSecuritySnapshotFixture.domains[0],
            verificationRecordValue:
              'mukuroji-domain-verification=one-time-value',
          },
    )

    const challenge = await createEnterpriseDomainClaim(
      'access-token',
      { domain: 'example.com' },
      mutationContext,
    )
    await rotateEnterpriseScimToken(
      'access-token',
      enterpriseSecuritySnapshotFixture.scim.version,
      enterpriseSecuritySnapshotFixture.scim.identityProviderId,
      mutationContext,
    )

    expect(
      requests.map((request) => [request.init.method, request.url]),
    ).toEqual([
      ['POST', '/api/enterprise/security/domains'],
      ['POST', '/api/enterprise/security/scim/token'],
    ])
    for (const request of requests) {
      expect(request.init.headers).toMatchObject({
        'Idempotency-Key': mutationContext.idempotencyKey,
        'X-Correlation-Id': mutationContext.correlationId,
      })
    }
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      expectedVersion: enterpriseSecuritySnapshotFixture.scim.version,
      identityProviderId:
        enterpriseSecuritySnapshotFixture.scim.identityProviderId,
    })
    expect(challenge.verificationRecordValue).toBe(
      'mukuroji-domain-verification=one-time-value',
    )
  })

  test('rejects malformed one-time credential responses without exposing a token', async () => {
    installFetchRecorder({
      scim: enterpriseSecuritySnapshotFixture.scim,
    })

    await expect(
      rotateEnterpriseScimToken(
        'access-token',
        enterpriseSecuritySnapshotFixture.scim.version,
        enterpriseSecuritySnapshotFixture.scim.identityProviderId,
        mutationContext,
      ),
    ).rejects.toBeInstanceOf(EnterpriseSecurityApiError)
  })

  test('rejects a SCIM rotate response whose safe suffix does not match the token', async () => {
    installFetchRecorder({
      ...enterpriseScimTokenResponseFixture,
      scim: {
        ...enterpriseScimTokenResponseFixture.scim,
        tokenLastFour: 'nope',
      },
    })

    await expect(
      rotateEnterpriseScimToken(
        'access-token',
        enterpriseSecuritySnapshotFixture.scim.version,
        enterpriseSecuritySnapshotFixture.scim.identityProviderId,
        mutationContext,
      ),
    ).rejects.toBeInstanceOf(EnterpriseSecurityApiError)
  })

  test('rejects a domain response that omits its one-time DNS value', async () => {
    installFetchRecorder({
      domain: enterpriseSecuritySnapshotFixture.domains[0],
    })

    await expect(
      createEnterpriseDomainClaim(
        'access-token',
        { domain: 'example.com' },
        mutationContext,
      ),
    ).rejects.toBeInstanceOf(EnterpriseSecurityApiError)
  })

  test('updates mappings and deletes custom roles with version guards', async () => {
    const mapping = enterpriseSecuritySnapshotFixture.mappings[0]
    const role = enterpriseSecuritySnapshotFixture.roles.find(
      (candidate) => candidate.kind === 'custom',
    )
    if (!mapping || !role) {
      throw new Error('Enterprise security fixtures are incomplete.')
    }
    const requests = installFetchRecorder((url) =>
      url.includes('/group-mappings/')
        ? { mapping: { ...mapping, roleId: role.id } }
        : {},
    )

    await updateEnterpriseGroupRoleMapping(
      'access-token',
      mapping.id,
      {
        directoryGroupId: mapping.directoryGroupId,
        directoryGroupName: mapping.directoryGroupName,
        expectedVersion: mapping.version,
        identityProviderId: mapping.identityProviderId,
        roleId: role.id,
        scopeId: mapping.scopeId,
        scopeName: mapping.scopeName,
        scopeType: mapping.scopeType,
      },
      mutationContext,
    )
    await deleteEnterpriseRole(
      'access-token',
      role,
      'role-impact-confirmation',
      mutationContext,
    )

    expect(
      requests.map((request) => [request.init.method, request.url]),
    ).toEqual([
      [
        'PUT',
        `/api/enterprise/security/group-mappings/${mapping.id}`,
      ],
      [
        'DELETE',
        `/api/enterprise/security/roles/${encodeURIComponent(role.id)}`,
      ],
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      directoryGroupId: mapping.directoryGroupId,
      directoryGroupName: mapping.directoryGroupName,
      expectedVersion: mapping.version,
      identityProviderId: mapping.identityProviderId,
      roleId: role.id,
      scopeId: mapping.scopeId,
      scopeName: mapping.scopeName,
      scopeType: mapping.scopeType,
    })
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      expectedVersion: role.version,
      impactConfirmationToken: 'role-impact-confirmation',
    })
    for (const request of requests) {
      expect(request.init.headers).toMatchObject({
        'Idempotency-Key': mutationContext.idempotencyKey,
        'X-Correlation-Id': mutationContext.correlationId,
      })
    }
  })

  test('creates a scope- and network-bounded service account', async () => {
    const requests = installFetchRecorder(
      enterpriseServiceAccountCredentialResponseFixture,
    )
    const input = {
      allowedSourceCidrs: ['203.0.113.0/24'],
      credentialLifetimeDays: 30,
      name: 'Project release bot',
      roleId: 'project:member',
      scopeId: 'project-demo',
      scopeType: 'project' as const,
    }

    await createEnterpriseServiceAccount(
      'access-token',
      input,
      mutationContext,
    )

    expect(requests[0]?.url).toBe(
      '/api/enterprise/security/service-accounts',
    )
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(
      input,
    )
  })

  test('previews caller IP impact before a confirmed policy update', async () => {
    const currentPolicy = enterpriseSecuritySnapshotFixture.sessionPolicy
    const policyInput = {
      allowedGuestDomains: [...currentPolicy.allowedGuestDomains],
      expectedVersion: currentPolicy.version,
      externalCollaboratorsAllowed:
        currentPolicy.externalCollaboratorsAllowed,
      guestSessionLifetimeMinutes:
        currentPolicy.guestSessionLifetimeMinutes,
      guestsAllowed: currentPolicy.guestsAllowed,
      idleTimeoutMinutes: currentPolicy.idleTimeoutMinutes,
      ipAllowlist: ['198.51.100.0/24'],
      mfaRequired: currentPolicy.mfaRequired,
      reauthenticationMinutes: currentPolicy.reauthenticationMinutes,
      sensitiveActionReauthenticationMinutes:
        currentPolicy.sensitiveActionReauthenticationMinutes,
      sessionLifetimeMinutes: currentPolicy.sessionLifetimeMinutes,
    }
    const requests = installFetchRecorder((url) =>
      url.endsWith('/preview')
        ? {
            impact: {
              callerAllowed: false,
              callerIp: '203.0.113.24',
              confirmationToken: 'caller-impact-confirmation',
              requiresConfirmation: true,
              warnings: ['Current caller will be excluded.'],
            },
          }
        : { policy: enterpriseSecuritySnapshotFixture.sessionPolicy },
    )

    const impact = await previewEnterpriseSessionPolicy(
      'access-token',
      policyInput,
      mutationContext,
    )
    await updateEnterpriseSessionPolicy(
      'access-token',
      {
        ...policyInput,
        callerIpConfirmationToken: impact.confirmationToken,
      },
      mutationContext,
    )

    expect(
      requests.map((request) => [request.init.method, request.url]),
    ).toEqual([
      ['POST', '/api/enterprise/security/policy/preview'],
      ['PUT', '/api/enterprise/security/policy'],
    ])
    expect(JSON.parse(String(requests[1]?.init.body))).toMatchObject({
      callerIpConfirmationToken: 'caller-impact-confirmation',
      idleTimeoutMinutes: currentPolicy.idleTimeoutMinutes,
      reauthenticationMinutes: currentPolicy.reauthenticationMinutes,
      sensitiveActionReauthenticationMinutes:
        currentPolicy.sensitiveActionReauthenticationMinutes,
    })
  })

  test('fails closed when a provisioning preview omits its blocking decision', async () => {
    installFetchRecorder({
      impact: {
        ...enterpriseProvisioningImpactFixture,
        blocking: undefined,
      },
    })

    await expect(
      previewEnterpriseProvisioning('access-token', mutationContext),
    ).rejects.toBeInstanceOf(EnterpriseSecurityApiError)
  })

  test('previews custom role assignment impact before mutation', async () => {
    const role = enterpriseSecuritySnapshotFixture.roles.find(
      (candidate) => candidate.kind === 'custom',
    )
    if (!role) {
      throw new Error('Custom role fixture is incomplete.')
    }
    const requests = installFetchRecorder({
      impact: {
        assignmentCount: 3,
        blocking: false,
        confirmationToken: 'role-impact-confirmation',
        mappingCount: 1,
        removedPermissionIds: ['security.manage'],
        warnings: [],
      },
    })

    const impact = await previewEnterpriseRoleImpact(
      'access-token',
      role.id,
      {
        expectedVersion: role.version,
        guestAssignable: true,
        permissionIds: ['work-items.write'],
      },
      mutationContext,
    )

    expect(impact.removedPermissionIds).toEqual(['security.manage'])
    expect(requests[0]?.init.method).toBe('POST')
    expect(requests[0]?.url).toBe(
      `/api/enterprise/security/roles/${encodeURIComponent(role.id)}/impact`,
    )
  })

  test('registers and self-tests break-glass access without invoking activation', async () => {
    const administrator =
      enterpriseSecuritySnapshotFixture.breakGlassAdministrators[0]
    if (!administrator) {
      throw new Error('Break-glass fixture is incomplete.')
    }
    const requests = installFetchRecorder({
      breakGlassAdministrator: administrator,
    })

    await registerEnterpriseBreakGlassAdministrator(
      'access-token',
      { email: 'recovery@example.com' },
      mutationContext,
    )
    await testEnterpriseBreakGlassAccess(
      'access-token',
      mutationContext,
    )

    expect(requests[0]?.init.method).toBe('POST')
    expect(requests[0]?.url).toBe(
      '/api/enterprise/security/break-glass/accounts',
    )
    expect(requests[1]?.init.method).toBe('POST')
    expect(requests[1]?.url).toBe(
      '/api/enterprise/security/break-glass/test',
    )
    expect(requests[1]?.init.body).toBeUndefined()
  })

  test('activates current member recovery access with an audited reason and duration', async () => {
    const requests = installFetchRecorder({
      activation: {
        accountId: 'break-glass-account-1',
        expiresAt: '2026-07-18T10:15:00.000Z',
        id: 'activation-1',
        startedAt: '2026-07-18T10:00:00.000Z',
      },
    })

    const activation = await activateEnterpriseBreakGlassAccess(
      'access-token',
      {
        durationMinutes: 15,
        reason: 'Restore the workspace SSO configuration.',
      },
      mutationContext,
    )

    expect(activation.id).toBe('activation-1')
    expect(requests[0]?.url).toBe(
      '/api/enterprise/security/break-glass/activate',
    )
    expect(requests[0]?.init.method).toBe('POST')
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      durationMinutes: 15,
      reason: 'Restore the workspace SSO configuration.',
    })
    expect(requests[0]?.init.headers).toMatchObject({
      'Idempotency-Key': mutationContext.idempotencyKey,
      'X-Correlation-Id': mutationContext.correlationId,
    })
  })

  test('rejects a malformed recovery activation response', async () => {
    installFetchRecorder({
      activation: {
        accountId: 'break-glass-account-1',
        expiresAt: '2026-07-18T10:15:00.000Z',
      },
    })

    await expect(
      activateEnterpriseBreakGlassAccess(
        'access-token',
        {
          durationMinutes: 15,
          reason: 'Restore the workspace SSO configuration.',
        },
        mutationContext,
      ),
    ).rejects.toBeInstanceOf(EnterpriseSecurityApiError)
  })

  test('revokes current member recovery access before automatic expiry', async () => {
    const requests = installFetchRecorder({ revoked: true })

    await revokeEnterpriseBreakGlassAccess(
      'access-token',
      mutationContext,
    )

    expect(requests[0]?.url).toBe(
      '/api/enterprise/security/break-glass/revoke-activation',
    )
    expect(requests[0]?.init.method).toBe('POST')
    expect(requests[0]?.init.body).toBeUndefined()
    expect(requests[0]?.init.headers).toMatchObject({
      'Idempotency-Key': mutationContext.idempotencyKey,
      'X-Correlation-Id': mutationContext.correlationId,
    })
  })
})

function installFetchRecorder(
  response:
    | unknown
    | ((url: string, init: RequestInit) => unknown),
) {
  const requests: Array<{ init: RequestInit; url: string }> = []

  globalThis.fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = String(input)
    requests.push({ init, url })
    const body =
      typeof response === 'function' ? response(url, init) : response

    return new Response(JSON.stringify(body), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
