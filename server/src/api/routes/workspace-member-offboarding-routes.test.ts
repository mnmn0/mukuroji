import { afterEach, expect, test } from 'bun:test'
import { createApiTestHarness } from '../test-support/api-test-harness'
import { InMemoryPlanningClient } from '../../modules/planning/planning'
import {
  createInMemoryDeveloperPlatformAdapters,
} from '../../modules/developer-platform/adapter-out/in-memory/developer-platform-adapters'
import type { UpdateWorkspaceMemberAccessExpiryInput } from '../../modules/workspace-access'

const {
  app,
  configureFakeProjectClients,
  createCyclePlanningInput,
  createDocumentFake,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

const workspaceId = 'user#demo@example.com'
const headers = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' }

afterEach(() => {
  resetTestApp()
})

/**
 * Creates a developer platform holding credentials and a Webhook of the leaver and of another member.
 *
 * @returns The adapters and the leaver's credential IDs.
 */
async function createDeveloperPlatformWithCredentials() {
  const platform = createInMemoryDeveloperPlatformAdapters()
  const ownKey = await platform.apiKeys.createApiKey({
    workspaceId,
    createdByUserId: 'sato@example.com',
    input: { name: 'Sato CI', scopes: ['work-items:read'] },
  })
  const otherKey = await platform.apiKeys.createApiKey({
    workspaceId,
    createdByUserId: 'demo@example.com',
    input: { name: 'Team CI', scopes: ['work-items:read'] },
  })
  const ownApp = await platform.oauthCredentials.createOAuthApp({
    workspaceId,
    createdByUserId: 'sato@example.com',
    input: { name: 'Sato sync', grantTypes: ['client_credentials'], scopes: ['work-items:read'] },
  })
  const ownWebhook = await platform.webhookSubscriptions.createWebhookSubscription({
    workspaceId,
    createdByUserId: 'sato@example.com',
    input: {
      name: 'Sato hook',
      url: 'https://hooks.example.test/sato',
      teamIds: ['core-team'],
      eventTypes: ['work-item.updated'],
    },
  })
  return { platform, ownKey, otherKey, ownApp, ownWebhook }
}

test('lists everything a leaver must hand over on one summary', async () => {
  configureFakeProjectClients(true, {
    projectAccessesByMember: {
      'sato@example.com': [
        { projectId: 'refero', role: 'manager', teamId: 'core-team' },
        { projectId: 'other', role: 'member', teamId: 'core-team' },
      ],
    },
  })
  const planning = new InMemoryPlanningClient()
  await planning.create(workspaceId, {
    ...createCyclePlanningInput('cycle-owned-by-sato', 0),
    ownerMemberKey: 'sato@example.com',
  }, { workItems: [] })
  const { platform, ownKey, ownApp, ownWebhook } = await createDeveloperPlatformWithCredentials()
  setTestAppDependencies({
    planning,
    apiKeys: platform.apiKeys,
    oauthCredentials: platform.oauthCredentials,
    webhookSubscriptions: platform.webhookSubscriptions,
    documents: {
      ...createDocumentFake(),
      async getAuthorizationRevision() {
        return 4
      },
      async getManagerLifecycleSnapshot() {
        return { authorizationRevision: 4, blockingDocumentId: 'private-plan' }
      },
    },
  })

  const response = await app.request('/api/workspace/members/sato%40example.com/offboarding', { headers })

  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  const body = await response.json()
  expect(body).toMatchObject({
    memberKey: 'sato@example.com',
    accessExpired: false,
    managedProjects: [{ teamId: 'core-team', projectId: 'refero', name: 'Refero' }],
    ownedPlanningEntities: [{ id: 'cycle-owned-by-sato', type: 'cycle' }],
    managesPrivateDocuments: true,
    credentials: [
      { id: ownKey.apiKey.id, kind: 'api-key', name: 'Sato CI' },
      { id: ownApp.oauthApp.id, kind: 'oauth-app', name: 'Sato sync' },
    ],
    webhooks: [{ id: ownWebhook.subscription.id, name: 'Sato hook' }],
    canDeactivate: false,
  })
  expect(body.planningRevision).toBeGreaterThan(0)
})

test('revokes only the leaver credentials before deactivation', async () => {
  configureFakeProjectClients(true, { projectAccesses: [] })
  const { platform, ownKey, otherKey, ownApp } = await createDeveloperPlatformWithCredentials()
  setTestAppDependencies({
    apiKeys: platform.apiKeys,
    oauthCredentials: platform.oauthCredentials,
    webhookSubscriptions: platform.webhookSubscriptions,
  })

  const response = await app.request('/api/workspace/members/sato%40example.com/credentials/revoke', {
    method: 'POST',
    headers,
  })

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    revokedApiKeyIds: [ownKey.apiKey.id],
    revokedOAuthAppIds: [ownApp.oauthApp.id],
  })
  const apiKeys = await platform.apiKeys.listApiKeys(workspaceId)
  expect(apiKeys.find((apiKey) => apiKey.id === otherKey.apiKey.id)?.status).toBe('active')
  await expect(platform.apiKeys.authenticateApiKey({ credential: ownKey.secret })).rejects.toThrow()
})

test('refuses an admin revoking the credentials of an owner', async () => {
  configureFakeProjectClients(true, { projectAccesses: [], workspaceRole: 'admin' })
  const { platform, ownKey } = await createDeveloperPlatformWithCredentials()
  const workspaceAccess = getTestAppDependencies().workspace.workspaceAccess
  setTestAppDependencies({
    apiKeys: platform.apiKeys,
    oauthCredentials: platform.oauthCredentials,
    workspaceAccess: {
      ...workspaceAccess,
      async getMember(memberWorkspaceId, memberKey) {
        const member = await workspaceAccess.getMember(memberWorkspaceId, memberKey)
        return member && memberKey === 'sato@example.com' ? { ...member, role: 'owner' } : member
      },
    },
  })

  const response = await app.request('/api/workspace/members/sato%40example.com/credentials/revoke', {
    method: 'POST',
    headers,
  })

  expect(response.status).toBe(403)
  expect(await response.json()).toMatchObject({ code: 'WorkspaceRoleDenied' })
  const apiKeys = await platform.apiKeys.listApiKeys(workspaceId)
  expect(apiKeys.find((apiKey) => apiKey.id === ownKey.apiKey.id)?.status).toBe('active')
})

test('reactivating a deactivated member does not bring back their old credentials', async () => {
  const calls = configureFakeProjectClients(true, {
    projectAccesses: [],
    inactiveWorkspaceMemberKeys: ['sato@example.com'],
  })
  // The access expiry job deactivates a member without revoking their credentials.
  const { platform, ownKey, otherKey } = await createDeveloperPlatformWithCredentials()
  setTestAppDependencies({
    apiKeys: platform.apiKeys,
    oauthCredentials: platform.oauthCredentials,
  })

  const response = await app.request('/api/workspace/members/sato%40example.com', {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ expectedVersion: 1, status: 'active' }),
  })

  expect(response.status).toBe(200)
  expect(calls.workspaceMemberUpdates).toEqual([
    expect.objectContaining({ memberKey: 'sato@example.com', status: 'active' }),
  ])
  const apiKeys = await platform.apiKeys.listApiKeys(workspaceId)
  expect(apiKeys.find((apiKey) => apiKey.id === ownKey.apiKey.id)?.status).toBe('revoked')
  expect(apiKeys.find((apiKey) => apiKey.id === otherKey.apiKey.id)?.status).toBe('active')
})

test('sets and clears a member access expiry with validated input', async () => {
  configureFakeProjectClients(true, { projectAccesses: [] })
  const updates: Array<{ memberKey: string, input: UpdateWorkspaceMemberAccessExpiryInput }> = []
  const workspaceAccess = getTestAppDependencies().workspace.workspaceAccess
  setTestAppDependencies({
    workspaceAccess: {
      ...workspaceAccess,
      async updateMemberAccessExpiry(_workspaceId, actorMemberKey, memberKey, input) {
        expect(actorMemberKey).toBe('demo@example.com')
        updates.push({ memberKey, input })
        const member = await workspaceAccess.getMember(_workspaceId, memberKey)
        if (!member) throw new Error('Expected the fake member.')
        return {
          ...member,
          ...(input.accessExpiresAt === undefined ? {} : { accessExpiresAt: input.accessExpiresAt }),
        }
      },
    },
  })
  const put = (body: unknown) => app.request('/api/workspace/members/sato%40example.com/access-expiry', {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  })
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString()

  const set = await put({ expectedVersion: 1, accessExpiresAt: future })
  expect(set.status).toBe(200)
  const cleared = await put({ expectedVersion: 2, accessExpiresAt: null })
  expect(cleared.status).toBe(200)
  expect(updates).toEqual([
    { memberKey: 'sato@example.com', input: { expectedVersion: 1, accessExpiresAt: future } },
    { memberKey: 'sato@example.com', input: { expectedVersion: 2 } },
  ])

  for (const invalid of [
    { expectedVersion: 1 },
    { expectedVersion: 1, accessExpiresAt: '2020-01-01T00:00:00.000Z' },
    { expectedVersion: 1, accessExpiresAt: '2026-12-01' },
    { accessExpiresAt: future },
  ]) {
    const response = await put(invalid)
    expect(response.status).toBe(400)
  }
  expect(updates).toHaveLength(2)
})

/**
 * Builds an unsigned password-session access token whose sign-in began at the given time.
 *
 * @param authTimeSeconds - Sign-in time in seconds since the epoch.
 * @returns The access token, as the fake Cognito GetUser accepts it.
 */
function createPasswordAccessToken(authTimeSeconds: number) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({
      auth_time: authTimeSeconds,
      // A refresh issues a new `iat` but keeps the original `auth_time`.
      iat: Math.floor(Date.now() / 1_000),
      exp: Math.floor(Date.now() / 1_000) + 3_600,
      token_use: 'access',
    })).toString('base64url'),
    'test-signature',
  ].join('.')
}

test('refuses a password sign-in from before the expiry cutoff after the member is reactivated', async () => {
  configureFakeProjectClients(true, { projectAccesses: [] })
  // The access expiry job recorded a cutoff instead of a Cognito global sign-out, and an admin
  // reactivated the member afterwards.
  const signInsRevokedAt = new Date(Date.now() - 60_000).toISOString()
  const workspaceAccess = getTestAppDependencies().workspace.workspaceAccess
  setTestAppDependencies({
    workspaceAccess: {
      ...workspaceAccess,
      async getActiveMember(workspaceIdToRead, memberKey) {
        const member = await workspaceAccess.getActiveMember(workspaceIdToRead, memberKey)
        return member ? { ...member, signInsRevokedAt } : undefined
      },
    },
  })
  const requestCurrentUser = (accessToken: string) => app.request('/api/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  const nowSeconds = Math.floor(Date.now() / 1_000)

  const beforeCutoff = await requestCurrentUser(createPasswordAccessToken(nowSeconds - 600))
  expect(beforeCutoff.status).toBe(401)
  expect(await beforeCutoff.json()).toMatchObject({ code: 'WorkspaceSessionRevoked' })
  // A token without a readable sign-in time fails closed.
  expect((await requestCurrentUser('test-token')).status).toBe(401)
  expect((await requestCurrentUser(createPasswordAccessToken(nowSeconds - 5))).status).toBe(200)
})
