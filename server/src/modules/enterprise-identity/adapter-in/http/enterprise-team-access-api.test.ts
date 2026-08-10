import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
import {
  InMemoryEnterpriseIdentityClient,
} from '../../enterprise-identity'
import type {
  EnterprisePermissionId,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()

const enterpriseEnvironment = {
  COGNITO_CLIENT_ID: 'mukuroji-main-client',
  COGNITO_ENTERPRISE_IDP_NAME: 'EnterpriseOidc',
  COGNITO_SSO_CLIENT_ID: 'mukuroji-sso-client',
  COGNITO_SSO_REDIRECT_URI: 'https://app.example.com/api/auth/sso/callback',
}

afterEach(() => {
  resetTestApp()
})

/**
 * Configures one Team-scoped enterprise group mapping for the authenticated fixture member.
 *
 * @param permissions - Exact custom-role permissions granted on the fixture Team.
 * @returns The bearer authorization header for the configured member.
 */
async function configureEnterpriseTeamAccess(
  permissions: EnterprisePermissionId[],
): Promise<string> {
  configureFakeProjectClients(false, {
    workspaceRole: 'member',
    teamProjects: [{ id: 'refero', name: 'Refero', tone: 'blue' }],
  })
  const workspaceId = 'user#demo@example.com'
  const identity = new InMemoryEnterpriseIdentityClient()
  const now = '2026-08-10T00:00:00.000Z'
  await identity.putIdentityProvider({
    workspaceId,
    providerId: 'idp-team-api-access',
    kind: 'oidc',
    displayName: 'Team API access directory',
    cognitoProviderName: 'EnterpriseOidc',
    status: 'active',
    revision: 1,
    issuer: 'https://idp.example.com',
    clientId: 'enterprise-client',
    authorizationEndpoint: 'https://idp.example.com/authorize',
    tokenEndpoint: 'https://idp.example.com/token',
    jwksUri: 'https://idp.example.com/jwks',
    scopes: ['openid', 'email'],
    createdAt: now,
    updatedAt: now,
    lastTestedAt: now,
  })
  await identity.putCustomRole({
    workspaceId,
    roleId: 'custom:team-api-access',
    name: 'Team API access',
    permissions,
    guestAssignable: false,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  })
  const user = await identity.upsertScimUser({
    workspaceId,
    identityProviderId: 'idp-team-api-access',
    externalId: 'team-api-user',
    userName: 'demo@example.com',
    emails: ['demo@example.com'],
    active: true,
    linkedMemberKey: 'demo@example.com',
    idempotencyKey: 'team-api-user',
  })
  const group = await identity.upsertScimGroup({
    workspaceId,
    identityProviderId: 'idp-team-api-access',
    externalId: 'team-api-group',
    displayName: 'Team API access',
    active: true,
    memberUserIds: [user.userId],
    idempotencyKey: 'team-api-group',
  })
  const desiredUser = (await identity.getSnapshot(workspaceId)).scimUsers.find((candidate) =>
    candidate.userId === user.userId
  )
  if (!desiredUser) throw new Error('Expected the SCIM user to exist.')
  await identity.markScimUserApplied(workspaceId, desiredUser.userId, desiredUser.version)
  await identity.markScimGroupApplied(workspaceId, group.groupId, group.version)
  await identity.putGroupMapping({
    workspaceId,
    mappingId: 'team-api-access-mapping',
    identityProviderId: 'idp-team-api-access',
    directoryGroupId: group.groupId,
    roleId: 'custom:team-api-access',
    scope: { workspaceId, kind: 'team', targetId: 'core-team' },
    enabled: true,
    priority: 0,
    revision: 1,
    updatedAt: now,
  })
  setTestAppDependencies({ enterpriseIdentity: identity })
  const accessToken = createAccessToken([], {
    client_id: 'mukuroji-main-client',
    token_use: 'access',
  })
  return `Bearer ${accessToken}`
}

test('uses Team teams.read access for a Work Item route', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess([
      'teams.read',
      'work-items.read',
    ])

    const response = await app.request('/api/teams/core-team/issues', {
      headers: { Authorization: authorization },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      teamId: 'core-team',
      issues: [{ id: 'onboarding-friction', assignedProjectId: 'refero' }],
    })
  })
})

test('uses Team teams.write access for time-entry creation', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess([
      'teams.read',
      'teams.write',
    ])

    const response = await app.request('/api/teams/core-team/time-entries', {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workItemId: 'onboarding-friction',
        startAt: '2026-08-10T09:00:00.000Z',
        endAt: '2026-08-10T10:00:00.000Z',
        billable: false,
        currency: 'USD',
      }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      entry: {
        teamId: 'core-team',
        workItemId: 'onboarding-friction',
        userId: 'demo@example.com',
      },
    })
  })
})

test('uses Team teams.manage access for capacity request creation', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess([
      'teams.write',
      'teams.manage',
    ])

    const response = await app.request('/api/teams/core-team/workload/requests', {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Launch support',
        skillIds: ['support'],
        fromDate: '2026-08-11',
        toDate: '2026-08-15',
        requestedMinutes: 480,
        confidential: false,
        expectedTeamRevision: 0,
      }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      request: {
        teamId: 'core-team',
        title: 'Launch support',
        requestedMinutes: 480,
      },
    })
  })
})

test('rejects capacity request creation when Team teams.manage access is missing', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess([
      'teams.write',
    ])

    const response = await app.request('/api/teams/core-team/workload/requests', {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        title: 'Launch support',
        skillIds: ['support'],
        fromDate: '2026-08-11',
        toDate: '2026-08-15',
        requestedMinutes: 480,
        confidential: false,
        expectedTeamRevision: 0,
      }),
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      message: 'Project access is denied.',
    })
  })
})
