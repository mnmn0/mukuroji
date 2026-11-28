import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
import {
  InMemoryEnterpriseIdentityClient,
} from '../../enterprise-identity'
import { InMemoryPlanningClient } from '../../../planning/planning'
import {
  InMemoryGitHubIntegrationStore,
  InMemoryGitHubSyncQueue,
  type GitHubAppGateway,
} from '../../../github-integration'
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
  createFakeWorkItemConfigurationClient,
  createTeamIssuesFake,
  resetTestApp,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()

const enterpriseEnvironment = {
  COGNITO_HOSTED_UI_DOMAIN: 'https://mukuroji.auth.ap-northeast-1.amazoncognito.com',
  ENTERPRISE_SSO_STATE_SECRET: 'test-sso-state-secret-with-at-least-32-characters',
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
 * @param projectPermissions - Permissions of a second role granted on the `refero` Project, if any.
 * @returns The bearer authorization header for the configured member.
 */
async function configureEnterpriseTeamAccess(
  permissions: EnterprisePermissionId[],
  projectPermissions?: EnterprisePermissionId[],
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
  if (projectPermissions) {
    await identity.putCustomRole({
      workspaceId,
      roleId: 'custom:project-api-access',
      name: 'Project API access',
      permissions: projectPermissions,
      guestAssignable: false,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    await identity.putGroupMapping({
      workspaceId,
      mappingId: 'project-api-access-mapping',
      identityProviderId: 'idp-team-api-access',
      directoryGroupId: group.groupId,
      roleId: 'custom:project-api-access',
      scope: { workspaceId, kind: 'project', targetId: 'refero', parentTeamId: 'core-team' },
      enabled: true,
      priority: 1,
      revision: 1,
      updatedAt: now,
    })
  }
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

test('requires work-items.read for the Team Work Item hierarchy, like the Team list', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const teamsOnly = await configureEnterpriseTeamAccess(['teams.read'])
    const deniedList = await app.request('/api/teams/core-team/issues', {
      headers: { Authorization: teamsOnly },
    })
    const deniedHierarchy = await app.request('/api/teams/core-team/work-item-hierarchy', {
      headers: { Authorization: teamsOnly },
    })

    expect(deniedList.status).toBe(403)
    expect(deniedHierarchy.status).toBe(403)

    const workItems = await configureEnterpriseTeamAccess(['teams.read', 'work-items.read'])
    setTestAppDependencies({
      teamIssues: createTeamIssuesFake({
        async getTeamHierarchyEntries() {
          return []
        },
      }),
      workItemConfigurations: createFakeWorkItemConfigurationClient({
        async getRelationGraphRevision() {
          return 1
        },
      }),
    })
    const hierarchy = await app.request('/api/teams/core-team/work-item-hierarchy', {
      headers: { Authorization: workItems },
    })

    expect(hierarchy.status).toBe(200)
    expect(await hierarchy.json()).toMatchObject({ teamId: 'core-team', nodes: [] })
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

test('lets a Team-scoped grant read workload and submit time across its Teams only', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess(['teams.read', 'teams.write'])

    const workload = await app.request('/api/workload?from=2026-08-10&to=2026-08-10&granularity=day', {
      headers: { Authorization: authorization },
    })
    expect(workload.status).toBe(200)
    expect((await workload.json()).teams.map((team: { teamId: string }) => team.teamId)).toEqual(['core-team'])

    const period = 'from=2026-08-10T00:00:00.000Z&to=2026-08-11T00:00:00.000Z'
    const timesheet = await app.request(`/api/time-tracking/my-timesheet?${period}`, {
      headers: { Authorization: authorization },
    })
    expect(timesheet.status).toBe(200)
    expect((await timesheet.json()).teams.map((team: { teamId: string }) => team.teamId)).toEqual(['core-team'])

    const created = await app.request('/api/teams/core-team/time-entries', {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workItemId: 'onboarding-friction',
        startAt: '2026-08-10T09:00:00.000Z',
        endAt: '2026-08-10T10:00:00.000Z',
        billable: false,
        currency: 'USD',
      }),
    })
    expect(created.status).toBe(201)
    const draft = (await created.json()).entry

    const submitted = await app.request('/api/time-tracking/my-timesheet/submit', {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '2026-08-10T00:00:00.000Z',
        to: '2026-08-11T00:00:00.000Z',
        entries: [{ teamId: 'core-team', entryId: draft.id, expectedRevision: draft.revision }],
      }),
    })
    expect(submitted.status).toBe(200)
    expect(await submitted.json()).toMatchObject({
      count: 1,
      failedEntryIds: [],
      partialFailure: false,
      teams: [{ teamId: 'core-team', count: 1, failedEntryIds: [] }],
    })

    const after = await app.request(`/api/time-tracking/my-timesheet?${period}`, {
      headers: { Authorization: authorization },
    })
    const afterTeams: { entries: { id: string; status: string }[] }[] = (await after.json()).teams
    expect(afterTeams[0]?.entries.find((entry) => entry.id === draft.id)?.status).toBe('submitted')
  })
})

test('lists the review inbox of a Team the member reads through a Team-scoped grant only', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess(['teams.read'])
    const workspaceId = 'user#demo@example.com'
    const store = new InMemoryGitHubIntegrationStore()
    const now = '2026-08-10T00:00:00.000Z'
    await store.saveRepositoryLink({
      workspaceId,
      record: { installationId: '7', repositoryId: '42', repository: 'acme/app', private: true, teamId: 'core-team', revision: 1, linkedAt: now },
    })
    await store.saveMemberLogin({ workspaceId, memberKey: 'demo@example.com', login: 'demo', now })
    await store.putPullRequestSnapshot(workspaceId, {
      repositoryId: '42', repository: 'acme/app', number: 5, title: 'Add the inbox', url: 'https://github.com/acme/app/pull/5',
      state: 'open', draft: false, authorLogin: 'demo', headRef: 'feature', baseRef: 'main', headSha: 'a'.repeat(40),
      mergeable: 'mergeable', reviewDecision: 'none', requestedReviewerLogins: [], requestedTeamSlugs: [], reviews: [],
      checks: { state: 'success', failedNames: [], total: 1 }, createdAt: now, updatedAt: now, syncedAt: now,
    })
    const gateway: GitHubAppGateway = {
      async listRepositories() { return { repositories: [], incomplete: false } },
      async readRepositoryName() { return 'acme/app' },
      async readPullRequests() { return { snapshots: [], missing: [] } },
      async readCommitPullRequests() { return [] },
      async readOpenPullRequests() { return { snapshots: [], incomplete: false } },
    }
    setTestAppDependencies({
      githubIntegration: {
        workspaceId,
        store,
        credentials: { async read() { return { appId: '1', privateKey: 'unused', webhookSecrets: ['webhook-secret-of-at-least-20-characters'] } } },
        gateway,
        queue: new InMemoryGitHubSyncQueue(),
      },
    })

    const response = await app.request('/api/me/pull-requests?view=created', { headers: { Authorization: authorization } })
    expect(response.status).toBe(200)
    const body: unknown = await response.json()
    expect(body).toMatchObject({ configured: true, githubLogin: 'demo', items: [{ repositoryId: '42', number: 5, teamId: 'core-team' }] })
  })
})

test('rejects submitting time across Teams without Team teams.write access', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess(['teams.read'])

    const submitted = await app.request('/api/time-tracking/my-timesheet/submit', {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: '2026-08-10T00:00:00.000Z',
        to: '2026-08-11T00:00:00.000Z',
        entries: [{ teamId: 'core-team', entryId: 'entry-1', expectedRevision: 1 }],
      }),
    })
    expect(submitted.status).toBe(403)
  })
})

test('treats Team teams.manage access as managing every Project for time entry costs', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess([
      'teams.read',
      'teams.write',
      'teams.manage',
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
        billable: true,
        currency: 'USD',
        hourlyRateMinor: 4_000,
      }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      entry: { projectId: 'refero', hourlyRateMinor: 4_000, actualCostMinor: 4_000 },
    })
  })
})

test('lets a Team teams.manage grant close and reopen a month of time', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess([
      'teams.read',
      'teams.write',
      'teams.manage',
    ])
    const headers = { Authorization: authorization, 'Content-Type': 'application/json' }

    const closed = await app.request('/api/teams/core-team/time-periods/2026-07/close', {
      method: 'POST',
      headers,
      body: JSON.stringify({ timeZone: 'Asia/Tokyo' }),
    })
    expect(closed.status).toBe(201)
    const reopened = await app.request('/api/teams/core-team/time-periods/2026-07/reopen', {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Late client meeting' }),
    })
    expect(reopened.status).toBe(200)
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

test('requires projects.manage on every Project to add a member to all Projects of a Team', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const send = (authorization: string) => app.request('/api/teams/core-team/members', {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberKey: 'sato@example.com', role: 'member' }),
    })

    const teamOnly = await send(await configureEnterpriseTeamAccess(['teams.read', 'teams.manage']))
    expect(teamOnly.status).toBe(403)
    expect(await teamOnly.json()).toMatchObject({ code: 'TeamProjectsManageDenied' })

    const withProjects = await send(
      await configureEnterpriseTeamAccess(['teams.read', 'teams.manage', 'projects.manage']),
    )
    expect(withProjects.status).toBe(200)
    expect(await withProjects.json()).toMatchObject({ addedProjectIds: ['refero'] })
  })
})

test('shows the Team work calendar as read-only to a teams.read grant without teams.manage', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess(['teams.read'])

    const read = await app.request('/api/teams/core-team/work-calendar', {
      headers: { Authorization: authorization },
    })
    const preview = await app.request('/api/teams/core-team/work-calendar/preview', {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { additionalHolidays: [] }, adjustment: 'keep-duration' }),
    })

    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ canManage: false })
    expect(preview.status).toBe(403)
  })
})

test('shows a Project work calendar as editable to a Project-scoped teams.manage grant', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess(['teams.read'], ['teams.read', 'teams.manage'])

    const projectRead = await app.request('/api/teams/core-team/work-calendar?projectId=refero', {
      headers: { Authorization: authorization },
    })
    const teamRead = await app.request('/api/teams/core-team/work-calendar', {
      headers: { Authorization: authorization },
    })

    expect(projectRead.status).toBe(200)
    expect(await projectRead.json()).toMatchObject({ canManage: true })
    expect(teamRead.status).toBe(200)
    expect(await teamRead.json()).toMatchObject({ canManage: false })
  })
})

test('lets a Team teams.manage grant change the Work Item key prefix without teams.write', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess(['teams.read', 'teams.manage'])

    const settings = await app.request('/api/teams/core-team/work-item-key-prefix', {
      headers: { Authorization: authorization },
    })
    expect(settings.status).toBe(200)
    expect(await settings.json()).toMatchObject({ teamId: 'core-team', canManage: true })

    const response = await app.request('/api/teams/core-team/work-item-key-prefix', {
      method: 'PUT',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyPrefix: 'CORE', expectedKeyPrefix: null }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ teamId: 'core-team', keyPrefix: 'CORE', canManage: true })
  })
})

test('does not offer or allow a Work Item key prefix change without Team teams.manage', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const authorization = await configureEnterpriseTeamAccess(['teams.read', 'teams.write'])

    const settings = await app.request('/api/teams/core-team/work-item-key-prefix', {
      headers: { Authorization: authorization },
    })
    expect(settings.status).toBe(200)
    expect(await settings.json()).toMatchObject({ canManage: false })

    const response = await app.request('/api/teams/core-team/work-item-key-prefix', {
      method: 'PUT',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyPrefix: 'CORE', expectedKeyPrefix: null }),
    })
    expect(response.status).toBe(403)
  })
})

test('does not move the Project update owner for a charter editor without planning.write', async () => {
  await withTestEnvironment(enterpriseEnvironment, async () => {
    const planning = new InMemoryPlanningClient()
    await planning.configureUpdateCadence('user#demo@example.com', {
      target: { type: 'project', teamId: 'core-team', projectId: 'refero' },
      cadence: {
        updateOwnerMemberKey: 'demo@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'Asia/Tokyo',
        nextDueAt: '2026-08-10T00:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 0,
    }, { workItems: [] })

    const charterEditor = await configureEnterpriseTeamAccess(
      ['teams.read', 'projects.read', 'projects.manage', 'planning.read'],
    )
    setTestAppDependencies({ planning })
    const saved = await app.request('/api/teams/core-team/projects/refero/charter', {
      method: 'PUT',
      headers: { Authorization: charterEditor, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 0, charter: { ownerUserId: 'sato@example.com' } }),
    })

    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ updateOwnerSync: 'not-permitted' })
  })
})
