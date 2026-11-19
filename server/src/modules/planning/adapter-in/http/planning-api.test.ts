import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  app,
  configureFakeAuthenticatedUser,
  configureFakeProjectClients,
  createCollaborationStub,
  createCyclePlanningInput,
  createFileProofingStub,
  createFileUploadSessionFixture,
  getTestAppDependencies,
  planningApiRequest,
  resetTestApp,
  seedPlanningWorkspaceParentAndScopedChild,
  setTestAppDependencies,
  withTestEnvironment,
} = createApiTestHarness()
import {
  InMemoryPlanningClient,
  PlanningError,
} from '../../planning'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import { CognitoServiceError } from '../../../authentication'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import { DynamoDbInboxDigestStore } from '../../../update-feed'
import { CollaborationError } from '../../../collaboration'
import { createInMemoryDeveloperPlatformAdapters } from '../../../developer-platform/adapter-out/in-memory/developer-platform-adapters'
import type { CompleteIdempotencyRequest } from '../../../developer-platform/application/ports'
import { isRecord } from '../../../../infrastructure/runtime/value-guards'
import type {
  EnterpriseCustomRole,
  EnterpriseRoleAssignment,
  CreateNextCycleResponse,
  PlanningMutationResponse,
  PlanningSnapshot,
  PlanningUpdateTarget,
  SavedUpdateFeed,
} from '@mukuroji/contracts'
import {
  PLANNING_SCHEMA_VERSION,
  createDefaultDueDateWorkItemSchedule,
} from '@mukuroji/contracts'
import {
  afterEach,
  expect,
  test,
} from 'bun:test'

afterEach(() => {
  resetTestApp()
})

test('manual digest preferences and preview use authenticated identity and reject guests', async () => {
  configureFakeProjectClients(true)
  const path = '/api/planning/update-feed/digest'
  expect((await (await planningApiRequest(path)).json()).preferences.enabled).toBe(false)
  expect((await planningApiRequest(`${path}/preview`, 'POST', {})).status).toBe(409)
  const settings = { expectedRevision: 0, preferences: { enabled: true, frequency: 'weekly', views: ['recent', 'at-risk'] }, memberKey: 'attacker', workspaceId: 'other' }
  expect((await planningApiRequest(path, 'PUT', settings)).status).toBe(200)
  expect((await planningApiRequest(path, 'PUT', settings)).status).toBe(409)
  const first = await planningApiRequest(`${path}/preview`, 'POST', {})
  expect(first.status).toBe(200)
  expect(await first.json()).toMatchObject({ transport: 'preview', replay: false, entries: [] })
  const replay = await planningApiRequest(`${path}/preview`, 'POST', {})
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ transport: 'preview', replay: true, entries: [] })
  expect((await (await planningApiRequest(path)).json()).history).toHaveLength(1)
  configureFakeProjectClients(false, { workspaceRole: 'guest', role: 'viewer', projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }] })
  expect((await planningApiRequest(path, 'PUT', settings)).status).toBe(403)
  expect((await planningApiRequest(`${path}/preview`, 'POST', {})).status).toBe(403)
})

test('both digest settings bind owned custom definitions and reject deleted selections without reflecting IDs', async () => {
  configureFakeProjectClients(true)
  const savedPath = '/api/planning/update-feed/saved'
  const feed: SavedUpdateFeed = { id: 'private-custom-id', name: 'Personal filter', view: 'recent', filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }
  expect((await planningApiRequest(savedPath, 'PUT', { expectedRevision: 0, feeds: [feed] })).status).toBe(200)
  const preferences = { enabled: true, frequency: 'daily', views: [], savedFeeds: { revision: 1, ids: [feed.id] } }
  for (const path of ['/api/planning/update-feed/digest', '/api/planning/update-feed/digest/inbox']) {
    const saved = await planningApiRequest(path, 'PUT', { expectedRevision: 0, preferences, memberKey: 'attacker' })
    expect(saved.status).toBe(200)
    expect((await saved.json()).preferences).toEqual(preferences)
  }
  expect((await planningApiRequest('/api/planning/update-feed/digest/preview', 'POST', {})).status).toBe(200)
  expect((await planningApiRequest(savedPath, 'PUT', { expectedRevision: 1, feeds: [] })).status).toBe(200)
  const rejected = await planningApiRequest('/api/planning/update-feed/digest/preview', 'POST', {})
  expect(rejected.status).toBe(409)
  expect(await rejected.text()).not.toContain(feed.id)
  expect((await planningApiRequest('/api/planning/update-feed/digest/inbox', 'PUT', { expectedRevision: 1, preferences })).status).toBe(409)
  expect((await planningApiRequest('/api/planning/update-feed/digest/inbox', 'PUT', { expectedRevision: 1, preferences: { ...preferences, enabled: false } })).status).toBe(200)
})

test('Inbox consent defaults off, stays separate from previews, ignores client identity and uses CAS', async () => {
  configureFakeProjectClients(true)
  const path = '/api/planning/update-feed/digest/inbox'
  expect((await (await planningApiRequest(path)).json()).preferences.enabled).toBe(false)
  const settings = { expectedRevision: 0, preferences: { enabled: true, frequency: 'daily', views: ['recent'] }, workspaceId: 'attacker', memberKey: 'attacker' }
  expect((await planningApiRequest(path, 'PUT', settings)).status).toBe(200)
  expect((await planningApiRequest(path, 'PUT', settings)).status).toBe(409)
  expect((await (await planningApiRequest('/api/planning/update-feed/digest')).json()).preferences.enabled).toBe(false)
  expect((await planningApiRequest(path, 'PUT', { expectedRevision: 1, preferences: { ...settings.preferences, enabled: false } })).status).toBe(200)
  expect((await (await planningApiRequest(path)).json()).history).toEqual([])
  configureFakeProjectClients(false, { workspaceRole: 'guest', role: 'viewer', projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }] })
  expect((await planningApiRequest(path, 'PUT', settings)).status).toBe(403)
})

test('Inbox metadata HTTP boundary preserves stable storage failure categories without private details', async () => {
  configureFakeProjectClients(true)
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'test' }))
  let failure: unknown
  let item: Record<string, unknown> | undefined
  // The isolated SDK overload is the only assertion; no transport is invoked.
  client.send = (async () => { if (failure) throw failure; return { Item: item } }) as DynamoDBDocumentClient['send']
  setTestAppDependencies({ inboxDigestSettings: new DynamoDbInboxDigestStore('planning', 'notifications', client) })
  const path = '/api/planning/update-feed/digest/inbox'
  expect(await (await planningApiRequest(path)).json()).toMatchObject({ revision: 0, preferences: { enabled: false } })
  const settings = { expectedRevision: 0, preferences: { enabled: false, frequency: 'daily', views: ['recent'] } }
  for (const method of ['GET', 'PUT']) {
    failure = Object.assign(new Error('private SDK detail'), { name: 'ThrottlingException' })
    let response = await planningApiRequest(path, method, method === 'PUT' ? settings : undefined)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'UpdateFeedDigestRetryable' })
    failure = undefined
    item = { schemaVersion: 999, secret: 'private stored detail' }
    response = await planningApiRequest(path, method, method === 'PUT' ? settings : undefined)
    expect(response.status).toBe(502)
    const body = await response.json()
    expect(body).toMatchObject({ code: 'UpdateFeedDigestCorruptState' })
    expect(JSON.stringify(body)).not.toContain('private')
  }
})

test('personal saved-feed CRUD requires current authentication, rejects guests and preserves CAS', async () => {
  configureFakeProjectClients(true)
  const feed: SavedUpdateFeed = { id: 'risk', name: 'My risks', view: 'at-risk', filters: { teamIds: [], projects: [], portfolioIds: [], initiativeIds: [], health: [], updateStates: [] } }
  expect(await (await planningApiRequest('/api/planning/update-feed/saved')).json()).toEqual({ revision: 0, feeds: [] })
  const created = await planningApiRequest('/api/planning/update-feed/saved', 'PUT', { expectedRevision: 0, feeds: [feed], memberKey: 'someone-else' })
  expect(created.status).toBe(200)
  expect(await created.json()).toEqual({ revision: 1, feeds: [feed] })
  expect((await planningApiRequest('/api/planning/update-feed/saved', 'PUT', { expectedRevision: 0, feeds: [] })).status).toBe(409)
  expect((await planningApiRequest('/api/planning/update-feed?feedId=risk&view=recent')).status).toBe(409)
  expect((await planningApiRequest('/api/planning/update-feed?feedId=unknown')).status).toBe(404)
  expect((await planningApiRequest('/api/planning/update-feed?feedId=risk&feedId=other')).status).toBe(400)
  expect((await planningApiRequest('/api/planning/update-feed/saved', 'PUT', { expectedRevision: 1, feeds: [{ ...feed, name: 'Edited' }] })).status).toBe(200)
  expect((await planningApiRequest('/api/planning/update-feed/saved', 'PUT', { expectedRevision: 2, feeds: [] })).status).toBe(200)
  expect(await (await planningApiRequest('/api/planning/update-feed/saved')).json()).toEqual({ revision: 3, feeds: [] })
  configureFakeProjectClients(false, { workspaceRole: 'guest', role: 'viewer', projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }] })
  expect((await planningApiRequest('/api/planning/update-feed/saved', 'PUT', { expectedRevision: 3, feeds: [feed] })).status).toBe(403)
})

test('authenticates read-state requests before parsing malformed JSON', async () => {
  let authenticationAttempted = false
  configureFakeAuthenticatedUser({}, () => {
    authenticationAttempted = true
    throw new CognitoServiceError(400, 'NotAuthorizedException', 'Invalid token')
  })
  const response = await app.request('/api/planning/update-feed/read-state', {
    method: 'PUT', headers: { Authorization: 'Bearer invalid-token', 'Content-Type': 'application/json' }, body: '{broken',
  })
  expect(authenticationAttempted).toBe(true)
  expect(response.status).toBe(401)
})

test('persists service-account read state using Enterprise control without a synthetic member fence', async () => {
  const workspaceId = 'workspace-service-feed'
  await withTestEnvironment({ ENTERPRISE_IDENTITY_TABLE_NAME: 'EnterpriseIdentityTable', MUKUROJI_WORKSPACE_DIRECTORY_ID: workspaceId }, async () => {
    configureFakeProjectClients(false)
    const identity = new InMemoryEnterpriseIdentityClient()
    const timestamp = new Date().toISOString()
    const issued = await identity.createServiceAccountWithToken({
      workspaceId, accountId: 'feed-reader', displayName: 'Feed reader',
      permissions: ['planning.read', 'projects.read', 'service-accounts.use'], roleId: 'project:viewer',
      scope: { workspaceId, kind: 'project', targetId: 'refero' }, credentialLifetimeDays: 30,
      allowedSourceCidrs: [], status: 'active', credentialGeneration: 0, revision: 1, createdAt: timestamp, updatedAt: timestamp,
    }, 'create-feed-reader', 'create-feed-reader-fingerprint')
    const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
    const target: PlanningUpdateTarget = { type: 'project', teamId: 'core-team', projectId: 'refero' }
    await planning.configureUpdateCadence(workspaceId, { target, expectedRevision: 0, cadence: {
      updateOwnerMemberKey: 'demo@example.com', cadence: { unit: 'week', count: 1 }, timeZone: 'UTC', nextDueAt: '2026-08-10T00:00:00.000Z', reminderHoursBefore: 24,
    } }, { workItems: [] })
    await planning.publishUpdate(workspaceId, { target, expectedRevision: 1, id: 'report', health: 'on-track', risk: 'none', summary: 'Visible report', riskSummary: '', decisionSummary: '', helpNeeded: '', nextAction: '', evidence: [] }, 'demo@example.com', { workItems: [] })
    setTestAppDependencies({ planning, enterpriseIdentity: identity })
    const store = getTestAppDependencies().workItems.updateFeedReadState
    const bindCaller = store.withCallerAuthorization.bind(store)
    let checked = false
    store.withCallerAuthorization = (checks) => {
      expect(checks).toHaveLength(1)
      expect(checks[0]?.ConditionCheck).toMatchObject({ TableName: 'EnterpriseIdentityTable', Key: { scopeKey: `WORKSPACE#${workspaceId}`, recordKey: 'CONTROL' } })
      expect(checks[0]?.ConditionCheck.ExpressionAttributeValues?.[':expectedControlRevision']).toBeGreaterThan(0)
      checked = true
      return bindCaller(checks)
    }
    const input = { target, version: 1, read: true, expectedRevision: 0 }
    const response = await app.request('/api/planning/update-feed/read-state', { method: 'PUT', headers: { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ read: true, revision: 1 })
    expect(checked).toBe(true)
    await identity.revokeServiceAccountToken(workspaceId, issued.account.accountId)
    const revoked = await app.request('/api/planning/update-feed/read-state', { method: 'PUT', headers: { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, read: false, expectedRevision: 1 }) })
    expect(revoked.status).toBe(401)
  })
})

test('restores as a service account with only the Enterprise control fence', async () => {
  const workspaceId = 'workspace-service-restore'
  await withTestEnvironment({ ENTERPRISE_IDENTITY_TABLE_NAME: 'EnterpriseIdentityTable', MUKUROJI_WORKSPACE_DIRECTORY_ID: workspaceId }, async () => {
    configureFakeProjectClients(false)
    const identity = new InMemoryEnterpriseIdentityClient()
    const timestamp = new Date().toISOString()
    const issued = await identity.createServiceAccountWithToken({
      workspaceId, accountId: 'planning-restorer', displayName: 'Planning restorer',
      permissions: ['planning.read', 'planning.manage', 'projects.read', 'service-accounts.use'], roleId: 'workspace:admin',
      scope: { workspaceId, kind: 'workspace' }, credentialLifetimeDays: 30,
      allowedSourceCidrs: [], status: 'active', credentialGeneration: 0, revision: 1, createdAt: timestamp, updatedAt: timestamp,
    }, 'create-planning-restorer', 'create-planning-restorer-fingerprint')
    const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
    await planning.create(workspaceId, {
      id: 'portfolio-service', type: 'portfolio', title: 'Service portfolio', ownerMemberKey: 'demo@example.com',
      status: 'planned', health: 'on-track', risk: 'none', progressMode: 'automatic',
      baseline: { startDate: '2026-08-01', endDate: '2026-08-01' }, forecast: { startDate: '2026-08-01', endDate: '2026-08-01' },
      expectedRevision: 0,
    }, { workItems: [] })
    const archived = await planning.archive(workspaceId, 'portfolio-service', { expectedRevision: 1 }, { workItems: [] })
    const restore = planning.restore.bind(planning)
    let checks: unknown
    planning.restore = async (...input) => {
      checks = input[4]?.authorizationConditionChecks
      return restore(...input)
    }
    setTestAppDependencies({ planning, enterpriseIdentity: identity })
    const response = await app.request('/api/planning/entities/portfolio-service/restore', {
      method: 'POST',
      headers: { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: archived.planning.revision }),
    })
    expect(response.status).toBe(200)
    // The synthetic member of a service account has no row a membership fence could match.
    expect(checks).toEqual([
      expect.objectContaining({
        ConditionCheck: expect.objectContaining({
          TableName: 'EnterpriseIdentityTable',
          Key: { scopeKey: `WORKSPACE#${workspaceId}`, recordKey: 'CONTROL' },
        }),
      }),
    ])
  })
})

/** Creates the canonical two-endpoint dependency input shared by API idempotency tests. */
function createWorkItemDependencyInput(expectedRevision = 0) {
  return {
    id: 'dependency-onboarding-work-item-1',
    predecessor: { teamId: 'core-team', workItemId: 'onboarding-friction' },
    successor: { teamId: 'core-team', workItemId: 'work-item-1' },
    type: 'finish-to-finish',
    lagDays: 0,
    expectedRevision,
  }
}

/**
 * Seeds the hierarchy required by an Initiative update target.
 *
 * @param planning - Isolated Planning client to populate.
 * @param entityId - Initiative identifier used by update requests.
 * @param teamId - Optional Team-only scope; omitted for Workspace scope.
 * @param projectId - Optional Project scope owned by the Team.
 */
async function seedPlanningUpdateInitiative(
  planning: InMemoryPlanningClient,
  entityId: string,
  teamId?: string,
  projectId?: string,
): Promise<void> {
  const workspaceId = 'user#demo@example.com'
  const portfolioId = `${entityId}-portfolio`
  const roadmapId = `${entityId}-roadmap`
  await planning.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 0),
    id: portfolioId,
    type: 'portfolio',
    title: `${entityId} portfolio`,
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planning.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 1),
    id: roadmapId,
    type: 'roadmap',
    title: `${entityId} roadmap`,
    parentId: portfolioId,
    teamId,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planning.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 2),
    id: entityId,
    type: 'initiative',
    title: `${entityId} initiative`,
    parentId: roadmapId,
    teamId,
    projectId,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
}

/**
 * Configures an in-memory reservation store whose prepared completion simulates atomic commit.
 *
 * @param planning - Planning client retained across retries.
 * @returns Captured compact receipt responses and the configured Planning client.
 */
function configureWorkItemDependencyIdempotency(
  planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z')),
) {
  const platform = createInMemoryDeveloperPlatformAdapters()
  const preparedResponses: unknown[] = []
  const preparedCompletions: CompleteIdempotencyRequest[] = []

  /** Completes exactly one staged receipt only after the simulated Planning commit succeeds. */
  async function completePreparedMutation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const firstPendingIndex = preparedCompletions.length
    try {
      const result = await operation()
      const completions = preparedCompletions.splice(firstPendingIndex)
      const completion = completions[0]
      if (!completion || completions.length !== 1) {
        throw new Error('Expected exactly one staged dependency receipt completion.')
      }
      await platform.idempotency.completeIdempotency(completion)
      return result
    } catch (error) {
      preparedCompletions.splice(firstPendingIndex)
      throw error
    }
  }

  const createDependency = planning.createWorkItemDependency.bind(planning)
  planning.createWorkItemDependency = (...input) => completePreparedMutation(
    () => createDependency(...input),
  )
  const updateDependency = planning.updateWorkItemDependency.bind(planning)
  planning.updateWorkItemDependency = (...input) => completePreparedMutation(
    () => updateDependency(...input),
  )
  const deleteDependency = planning.deleteWorkItemDependency.bind(planning)
  planning.deleteWorkItemDependency = (...input) => completePreparedMutation(
    () => deleteDependency(...input),
  )
  setTestAppDependencies({
    planning,
    idempotency: platform.idempotency,
    transactions: {
      async prepareIdempotencyCompletionTransactWrite(request) {
        preparedResponses.push(request.response)
        preparedCompletions.push(request)
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: { entryType: 'idempotency', state: 'completed' },
            },
          },
        }
      },
    },
  })
  return { planning, preparedResponses }
}

/**
 * Configures atomic in-memory completion for Planning update annotation receipts.
 *
 * @param planning - Planning client retained across first attempts and response-loss retries.
 * @returns Configured Planning client and captured durable response payloads.
 */
function configurePlanningAnnotationIdempotency(
  planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z')),
) {
  const platform = createInMemoryDeveloperPlatformAdapters()
  const preparedResponses: unknown[] = []
  const preparedCompletions: CompleteIdempotencyRequest[] = []

  /** Completes one staged receipt only after its simulated annotation write succeeds. */
  async function completePreparedMutation<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const firstPendingIndex = preparedCompletions.length
    try {
      const result = await operation()
      const completions = preparedCompletions.splice(firstPendingIndex)
      const completion = completions[0]
      if (!completion || completions.length !== 1) {
        throw new Error('Expected exactly one staged annotation receipt completion.')
      }
      await platform.idempotency.completeIdempotency(completion)
      return result
    } catch (error) {
      preparedCompletions.splice(firstPendingIndex)
      throw error
    }
  }

  const createComment = planning.createUpdateComment.bind(planning)
  planning.createUpdateComment = (...input) => completePreparedMutation(
    () => createComment(...input),
  )
  const addReaction = planning.addUpdateReaction.bind(planning)
  planning.addUpdateReaction = (...input) => completePreparedMutation(
    () => addReaction(...input),
  )
  const removeReaction = planning.removeUpdateReaction.bind(planning)
  planning.removeUpdateReaction = (...input) => completePreparedMutation(
    () => removeReaction(...input),
  )
  const configureCadence = planning.configureUpdateCadence.bind(planning)
  planning.configureUpdateCadence = (...input) => input[4]
    ? completePreparedMutation(() => configureCadence(...input))
    : configureCadence(...input)
  setTestAppDependencies({
    planning,
    idempotency: platform.idempotency,
    transactions: {
      async prepareIdempotencyCompletionTransactWrite(request) {
        preparedResponses.push(request.response)
        preparedCompletions.push(request)
        return {
          transactWriteItem: {
            Put: {
              TableName: 'DeveloperPlatformTable',
              Item: { entryType: 'idempotency', state: 'completed' },
            },
          },
        }
      },
    },
  })
  return { planning, preparedResponses }
}

test('returns an authenticated empty Planning graph with accessible Work Item projections', async () => {
  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  setTestAppDependencies({ planning: new InMemoryPlanningClient() })

  const response = await planningApiRequest('/api/planning')

  expect(response.status).toBe(200)
  const planning = await response.json() as PlanningSnapshot
  expect(planning).toMatchObject({
    schemaVersion: PLANNING_SCHEMA_VERSION,
    revision: 0,
    entities: [],
    dependencies: [],
    workItemLinks: [],
  })
  expect(planning.workItems).toEqual([
    expect.objectContaining({
      id: 'onboarding-friction',
      teamId: 'core-team',
      projectId: 'refero',
      statusCategory: 'started',
    }),
  ])
})

test('rejects invalid feed selectors before the feed directory read even during an outage', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'owner', projectAccesses: [] })
  const directory = getTestAppDependencies().workspace.projectDirectory
  const originalRead = directory.getProjectDirectory.bind(directory)
  let strongReads = 0
  directory.getProjectDirectory = async (...args) => {
    if (args[2] === true) {
      strongReads++
      throw new Error('Directory unavailable')
    }
    return originalRead(...args)
  }
  for (const query of ['view=invalid', 'limit=101', 'limit=1.5']) {
    expect((await planningApiRequest(`/api/planning/update-feed?${query}`)).status).toBe(400)
  }
  expect(strongReads).toBe(0)
})

test('preserves direct Enterprise Team access for an Initiative in an empty Team and removes it after revocation', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', projectAccesses: [], teamProjects: [] })
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  await seedPlanningUpdateInitiative(planning, 'empty-team-initiative', 'core-team')
  const target: PlanningUpdateTarget = { type: 'initiative', entityId: 'empty-team-initiative' }
  await planning.configureUpdateCadence('user#demo@example.com', {
    target, expectedRevision: 3, cadence: {
      updateOwnerMemberKey: 'demo@example.com', cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC', nextDueAt: '2026-08-10T00:00:00.000Z', reminderHoursBefore: 24,
    },
  }, { workItems: [] })
  await planning.publishUpdate('user#demo@example.com', {
    target, expectedRevision: 4, id: 'team-report', health: 'on-track', risk: 'none',
    summary: 'Team report', riskSummary: '', decisionSummary: '', helpNeeded: '', nextAction: '', evidence: [],
  }, 'demo@example.com', { workItems: [] })
  const identity = new InMemoryEnterpriseIdentityClient()
  const readIdentity = identity.getSnapshot.bind(identity)
  let assignments: EnterpriseRoleAssignment[] = [{
    workspaceId: 'user#demo@example.com', assignmentId: 'direct-team-member',
    principalKind: 'member', principalId: 'demo@example.com', roleId: 'team:member',
    scope: { workspaceId: 'user#demo@example.com', kind: 'team', targetId: 'core-team' }, source: 'direct',
  }]
  const customRole: EnterpriseCustomRole = {
    workspaceId: 'user#demo@example.com', roleId: 'custom:planning-reader', name: 'Planning reader',
    permissions: ['planning.read'], guestAssignable: false, revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }
  identity.getSnapshot = async (workspaceId) => ({ ...await readIdentity(workspaceId), roleAssignments: assignments, customRoles: [customRole] })
  setTestAppDependencies({ planning, enterpriseIdentity: identity })
  const granted = await planningApiRequest('/api/planning/update-feed?view=recent')
  expect(granted.status).toBe(200)
  expect(await granted.json()).toMatchObject({ total: 1, entries: [{ target, latestUpdate: { summary: 'Team report' } }] })
  assignments = assignments.map((assignment) => ({ ...assignment, roleId: customRole.roleId }))
  const customGranted = await planningApiRequest('/api/planning/update-feed?view=recent')
  expect(customGranted.status).toBe(200)
  expect(await customGranted.json()).toMatchObject({ total: 1, entries: [{ target, latestUpdate: { summary: 'Team report' } }] })
  assignments = []
  const revoked = await planningApiRequest('/api/planning/update-feed?view=recent')
  expect(revoked.status).toBe(200)
  expect(await revoked.json()).toMatchObject({ total: 0, entries: [] })
})

test('lists archived entities that an Enterprise Team grant can restore', async () => {
  configureFakeProjectClients(true, { workspaceRole: 'member', projectAccesses: [], teamProjects: [] })
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  const workspaceId = 'user#demo@example.com'
  await seedPlanningUpdateInitiative(planning, 'team-initiative', 'core-team')
  let revision = 3
  for (const entityId of ['team-initiative', 'team-initiative-roadmap', 'team-initiative-portfolio']) {
    revision = (await planning.archive(workspaceId, entityId, { expectedRevision: revision }, { workItems: [] }))
      .planning.revision
  }
  const identity = new InMemoryEnterpriseIdentityClient()
  const readIdentity = identity.getSnapshot.bind(identity)
  const customRole: EnterpriseCustomRole = {
    workspaceId, roleId: 'custom:planning-manager', name: 'Planning manager',
    permissions: ['planning.read', 'planning.manage'], guestAssignable: false, revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }
  identity.getSnapshot = async (id) => ({
    ...await readIdentity(id),
    roleAssignments: [{
      workspaceId, assignmentId: 'team-planning-manager',
      principalKind: 'member', principalId: 'demo@example.com', roleId: customRole.roleId,
      scope: { workspaceId, kind: 'team', targetId: 'core-team' }, source: 'direct',
    }],
    customRoles: [customRole],
  })
  setTestAppDependencies({ planning, enterpriseIdentity: identity })

  const response = await planningApiRequest('/api/planning/archived-entities')
  expect(response.status).toBe(200)
  // The Workspace-scoped Portfolio needs a Workspace grant, so only the Team entities are listed.
  expect(await response.json()).toEqual({
    entities: [
      expect.objectContaining({ id: 'team-initiative' }),
      expect.objectContaining({ id: 'team-initiative-roadmap' }),
    ],
  })
})

test('aggregates latest Project and Initiative updates without history reads and removes revoked or archived targets', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  await seedPlanningUpdateInitiative(planning, 'feed-initiative', 'core-team', 'refero')
  const targets: PlanningUpdateTarget[] = [
    { type: 'project', teamId: 'core-team', projectId: 'refero' },
    { type: 'initiative', entityId: 'feed-initiative' },
  ]
  let revision = 3
  for (const target of targets) {
    await planning.configureUpdateCadence('user#demo@example.com', {
      target, expectedRevision: revision++, cadence: {
        updateOwnerMemberKey: 'demo@example.com', cadence: { unit: 'week', count: 1 },
        timeZone: 'UTC', nextDueAt: '2026-08-10T00:00:00.000Z', reminderHoursBefore: 24,
      },
    }, { workItems: [] })
    await planning.publishUpdate('user#demo@example.com', {
      target, expectedRevision: revision++, id: 'same-local-id', health: 'at-risk', risk: 'medium',
      summary: 'Visible report', riskSummary: '', decisionSummary: '', helpNeeded: '', nextAction: '', evidence: [],
    }, 'demo@example.com', { workItems: [] })
  }
  const before = await planning.get('user#demo@example.com', { workItems: [] })
  planning.listUpdates = async () => { throw new Error('Feed must not read history') }
  planning.listUpdateComments = async () => { throw new Error('Feed must not read annotations') }
  planning.listUpdateReactions = async () => { throw new Error('Feed must not read annotations') }
  setTestAppDependencies({ planning })
  const directoryClient = getTestAppDependencies().workspace.projectDirectory
  const readDirectory = directoryClient.getProjectDirectory.bind(directoryClient)
  const readAccesses = directoryClient.getProjectAccessList.bind(directoryClient)
  const readPlanning = planning.get.bind(planning)
  let projectionRead = false
  let perTargetAuthorizationReads = 0
  planning.get = async (...args) => { projectionRead = true; return readPlanning(...args) }
  directoryClient.getProjectDirectory = async (...args) => {
    if (projectionRead) perTargetAuthorizationReads++
    const directory = await readDirectory(...args)
    return { ...directory, teams: directory.teams.map((team) => ({ ...team, projects: team.projects.map((project) => ({ ...project, name: args[1] === 'en' ? 'English project' : '日本語のプロジェクト' })) })) }
  }
  directoryClient.getProjectAccessList = async (...args) => {
    if (projectionRead) perTargetAuthorizationReads++
    return readAccesses(...args)
  }
  const response = await planningApiRequest('/api/planning/update-feed?view=for-me&relevance=2')
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ total: 2, truncated: false, entries: [
    { target: { type: 'initiative' }, reasons: ['update-owner', 'project-member', 'latest-author'] },
    { target: { type: 'project' }, reasons: ['update-owner', 'project-member', 'latest-author'] },
  ] })
  expect(perTargetAuthorizationReads).toBe(0)
  const legacy = await planningApiRequest('/api/planning/update-feed?view=for-me')
  expect(legacy.status).toBe(200)
  const legacyBody = await legacy.json()
  expect(legacyBody).toMatchObject({ total: 2, entries: [
    { reasons: ['update-owner', 'latest-author'], relevance: 3 },
    { reasons: ['update-owner', 'latest-author'], relevance: 3 },
  ] })
  expect(legacyBody.entries.every((entry: Record<string, unknown>) => entry.attention === undefined)).toBe(true)
  expect((await planningApiRequest('/api/planning/update-feed?relevance=3')).status).toBe(400)
  expect((await planningApiRequest('/api/planning/update-feed?relevance=2&relevance=2')).status).toBe(400)
  const english = await planningApiRequest('/api/planning/update-feed?view=recent&locale=en')
  expect(await english.json()).toMatchObject({ entries: [expect.anything(), { title: 'English project' }] })
  const japanese = await planningApiRequest('/api/planning/update-feed?view=recent&locale=ja')
  expect(await japanese.json()).toMatchObject({ entries: [expect.anything(), { title: '日本語のプロジェクト' }] })
  const optionsResponse = await planningApiRequest('/api/planning/update-feed/options?locale=en')
  expect(optionsResponse.status).toBe(200)
  const options = await optionsResponse.json()
  expect(options).toMatchObject({ projects: [{ teamId: 'core-team', projectId: 'refero', name: 'English project' }], initiatives: [{ id: expect.any(String), name: expect.any(String) }] })
  expect(options).not.toHaveProperty('entries')
  planning.get = readPlanning
  const readInput = { target: targets[0], version: 1, read: true, expectedRevision: 0 }
  const stateStore = getTestAppDependencies().workItems.updateFeedReadState
  const bindCaller = stateStore.withCallerAuthorization.bind(stateStore)
  let callerGuardBound = false
  stateStore.withCallerAuthorization = (checks) => {
    expect(checks).toContainEqual(expect.objectContaining({ ConditionCheck: expect.objectContaining({ Key: { workspaceId: 'user#demo@example.com', recordKey: 'MEMBER#demo@example.com' } }) }))
    callerGuardBound = true
    return bindCaller(checks)
  }
  const markedRead = await planningApiRequest('/api/planning/update-feed/read-state', 'PUT', readInput)
  expect(markedRead.status).toBe(200)
  expect(callerGuardBound).toBe(true)
  expect(await markedRead.json()).toEqual({ read: true, revision: 1 })
  const refreshed = await planningApiRequest('/api/planning/update-feed?view=recent')
  expect(await refreshed.json()).toMatchObject({ entries: [
    { target: { type: 'initiative' }, readState: { read: false, revision: 0 } },
    { target: { type: 'project' }, readState: { read: true, revision: 1 } },
  ] })
  expect((await planningApiRequest('/api/planning/update-feed/read-state', 'PUT', readInput)).status).toBe(409)
  const readAuthorizationRevision = planning.getAuthorizationRevision.bind(planning)
  planning.getAuthorizationRevision = async () => before.revision - 1
  expect((await planningApiRequest('/api/planning/update-feed/read-state', 'PUT', { ...readInput, read: false, expectedRevision: 1 })).status).toBe(409)
  planning.getAuthorizationRevision = readAuthorizationRevision
  expect(await planning.get('user#demo@example.com', { workItems: [] })).toEqual(before)
  expect((await planningApiRequest('/api/planning/update-feed?limit=101')).status).toBe(400)
  for (const query of ['view=recent&view=overdue', 'limit=1&limit=2', 'locale=en&locale=ja']) {
    const ambiguous = await planningApiRequest(`/api/planning/update-feed?${query}`)
    expect(ambiguous.status).toBe(400)
    expect(await ambiguous.json()).toMatchObject({ code: 'UpdateFeedQueryAmbiguous' })
  }

  configureFakeProjectClients(false, { workspaceRole: 'guest', role: 'viewer', projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }] })
  expect((await planningApiRequest('/api/planning/update-feed')).status).toBe(200)
  const guestWrite = await planningApiRequest('/api/planning/update-feed/read-state', 'PUT', { ...readInput, read: false, expectedRevision: 1 })
  expect(guestWrite.status).toBe(403)
  expect(await guestWrite.json()).toMatchObject({ code: 'WorkspaceRoleDenied' })
  configureFakeProjectClients(true, { workspaceRole: 'member', projectAccesses: [] })
  const denied = await planningApiRequest('/api/planning/update-feed')
  expect(denied.status).toBe(200)
  expect(await denied.json()).toMatchObject({ entries: [], total: 0 })
  expect((await planningApiRequest('/api/planning/update-feed/read-state', 'PUT', { ...readInput, read: false, expectedRevision: 1 })).status).toBe(404)

  const identity = new InMemoryEnterpriseIdentityClient()
  const readIdentity = identity.getSnapshot.bind(identity)
  const assignment: EnterpriseRoleAssignment = {
    workspaceId: 'user#demo@example.com', assignmentId: 'feed-project-viewer',
    principalKind: 'member', principalId: 'demo@example.com', roleId: 'project:viewer',
    scope: { workspaceId: 'user#demo@example.com', kind: 'project', targetId: 'refero' }, source: 'direct',
  }
  identity.getSnapshot = async (workspaceId) => ({ ...await readIdentity(workspaceId), roleAssignments: [assignment] })
  setTestAppDependencies({ enterpriseIdentity: identity })
  const enterpriseFeed = await planningApiRequest('/api/planning/update-feed?relevance=2')
  expect(enterpriseFeed.status).toBe(200)
  expect(await enterpriseFeed.json()).toMatchObject({ total: 2, entries: [{ reasons: expect.arrayContaining(['project-member']) }, { reasons: expect.arrayContaining(['project-member']) }] })
  const viewerChoice = await planningApiRequest('/api/planning/update-feed/read-state', 'PUT', { ...readInput, read: false, expectedRevision: 1 })
  expect(viewerChoice.status).toBe(200)
  expect(await viewerChoice.json()).toEqual({ read: false, revision: 2 })
  setTestAppDependencies({ enterpriseIdentity: new InMemoryEnterpriseIdentityClient() })

  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner', teamProjects: [] })
  const archived = await planningApiRequest('/api/planning/update-feed')
  expect(archived.status).toBe(200)
  expect(await archived.json()).toMatchObject({ entries: [], total: 0 })
  expect((await planningApiRequest('/api/planning/update-feed/read-state', 'PUT', { ...readInput, expectedRevision: 2 })).status).toBe(404)
})

test('relevance uses current explicit membership and watches without treating admin visibility as membership', async () => {
  configureFakeProjectClients(true, { projectAccesses: [], workspaceRole: 'owner', cognitoUserGroups: ['mukuroji-system-admins'], systemAdminMemberKeys: ['demo@example.com'] })
  const planning = new InMemoryPlanningClient()
  const target: PlanningUpdateTarget = { type: 'project', teamId: 'core-team', projectId: 'refero' }
  await planning.configureUpdateCadence('user#demo@example.com', { target, expectedRevision: 0, cadence: { updateOwnerMemberKey: 'other@example.com', cadence: { unit: 'week', count: 1 }, timeZone: 'UTC', nextDueAt: '2026-08-10T00:00:00.000Z', reminderHoursBefore: 24 } }, { workItems: [] })
  let watching = true
  let reads = 0
  const collaboration = createCollaborationStub({ getMemberSubscribedScopes: async (member, scopes) => { expect(member).toBe('demo@example.com'); expect(scopes).toHaveLength(1); reads++; return watching ? [...scopes] : [] } })
  setTestAppDependencies({ planning, collaboration })
  expect(await (await planningApiRequest('/api/planning/update-feed?view=for-me&relevance=2')).json()).toMatchObject({ entries: [{ reasons: ['watching'], relevance: 3 }] })
  watching = false
  expect(await (await planningApiRequest('/api/planning/update-feed?view=for-me&relevance=2')).json()).toMatchObject({ entries: [], total: 0 })
  configureFakeProjectClients(false, { workspaceRole: 'member', role: 'viewer', projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }] })
  setTestAppDependencies({ planning, collaboration })
  expect(await (await planningApiRequest('/api/planning/update-feed?view=for-me&relevance=2')).json()).toMatchObject({ entries: [{ reasons: ['project-member'], relevance: 4 }] })
  for (const code of ['WatcherReadRetryable', 'InvalidCollaborationRecord']) {
    setTestAppDependencies({ planning, collaboration: createCollaborationStub({ getMemberSubscribedScopes: async () => { throw new CollaborationError(503, code, 'Internal storage detail') } }) })
    const failure = await planningApiRequest('/api/planning/update-feed?view=for-me&relevance=2')
    expect(failure.status).toBe(503)
    expect(await failure.json()).toEqual({ code, message: 'Feed watcher signals are unavailable.' })
    const legacy = await planningApiRequest('/api/planning/update-feed?view=for-me')
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toMatchObject({ entries: [], total: 0 })
  }
  configureFakeProjectClients(false, { workspaceRole: 'guest', role: 'viewer', projectAccesses: [] })
  setTestAppDependencies({ planning, collaboration })
  const before = reads
  expect(await (await planningApiRequest('/api/planning/update-feed?view=for-me&relevance=2')).json()).toMatchObject({ entries: [], total: 0 })
  expect(reads).toBe(before)
})

test('filters legacy Planning update targets by their Team-qualified Project ACL', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'private-project', name: 'Private', tone: 'purple' },
    ],
  })
  const planning = new InMemoryPlanningClient()
  const cadence = {
    updateOwnerMemberKey: 'demo@example.com',
    cadence: { unit: 'week' as const, count: 1 },
    timeZone: 'UTC',
    nextDueAt: '2026-08-10T00:00:00.000Z',
    reminderHoursBefore: 24,
  }
  await planning.configureUpdateCadence('user#demo@example.com', {
    target: { type: 'project', teamId: 'core-team', projectId: 'refero' },
    cadence,
    expectedRevision: 0,
  }, { workItems: [] })
  await planning.configureUpdateCadence('user#demo@example.com', {
    target: { type: 'project', teamId: 'core-team', projectId: 'private-project' },
    cadence,
    expectedRevision: 1,
  }, { workItems: [] })
  setTestAppDependencies({ planning })

  const response = await planningApiRequest('/api/planning')

  expect(response.status).toBe(200)
  const body: PlanningSnapshot = await response.json()
  expect(body.updateTargets.map(({ target }) => target)).toEqual([{
    type: 'project',
    teamId: 'core-team',
    projectId: 'refero',
  }])
})

test('commits Inbox audit events with update publishes and comments', async () => {
  await withTestEnvironment({ AUDIT_EVENTS_TABLE_NAME: 'AuditEventsTable' }, async () => {
    configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
    const { planning } = configurePlanningAnnotationIdempotency(
      new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z')),
    )
    const contributions: unknown[] = []
    /** Records the contribution a route-supplied transaction prepares. */
    const record = <T>(transaction: { prepare(result: T): Promise<unknown> } | undefined) =>
      transaction && {
        async prepare(result: T) {
          const contribution = await transaction.prepare(result)
          contributions.push(contribution)
          return contribution
        },
      }
    const publish = planning.publishUpdate.bind(planning)
    planning.publishUpdate = (workspaceId, input, author, state, checks, transaction) =>
      publish(workspaceId, input, author, state, checks, record(transaction))
    const comment = planning.createUpdateComment.bind(planning)
    planning.createUpdateComment = (workspaceId, input, author, transaction, checks) =>
      comment(workspaceId, input, author, record(transaction), checks)
    const target = { type: 'project', teamId: 'core-team', projectId: 'refero' }
    expect((await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
      target,
      cadence: {
        updateOwnerMemberKey: 'demo@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'Asia/Tokyo',
        nextDueAt: '2026-08-10T00:00:00.000Z',
        reminderHoursBefore: 24,
        escalationHoursAfter: 24,
        escalationMemberKey: 'lead@example.com',
      },
      expectedRevision: 0,
    }, 'planning-cadence-audit-1')).status).toBe(200)

    const published = await planningApiRequest('/api/planning/updates', 'POST', {
      target,
      id: 'project-update-audit-1',
      health: 'off-track',
      risk: 'high',
      summary: 'The vendor slipped two weeks.',
      riskSummary: 'Launch moves unless we add a vendor.',
      decisionSummary: '',
      helpNeeded: 'Approve the second vendor.',
      nextAction: 'Sign the contract.',
      evidence: [],
      expectedRevision: 1,
    })
    expect(await published.json()).toMatchObject({ update: { health: 'off-track' } })
    expect(published.status).toBe(201)
    expect(contributions[0]).toMatchObject({
      transactWriteItem: {
        Put: {
          TableName: 'AuditEventsTable',
          Item: {
            eventType: 'planning-update.health-degraded',
            metadata: {
              planningTargetType: 'project',
              teamId: 'core-team',
              projectId: 'refero',
              notificationCandidates: [
                { memberKey: 'lead@example.com', reason: 'escalation' },
                { memberKey: 'demo@example.com', reason: 'update-owner' },
              ],
            },
          },
        },
      },
    })

    const query = '?targetType=project&teamId=core-team&projectId=refero'
    expect((await planningApiRequest(
      `/api/planning/updates/1/comments${query}`,
      'POST',
      { id: 'audit-comment-1', body: 'Escalating to @Lead@Example.com', mentionMemberKeys: ['Lead@Example.com'] },
      'planning-comment-audit-1',
    )).status).toBe(201)
    expect(contributions[1]).toMatchObject({
      transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable' } },
      additionalTransactWriteItems: [{
        Put: {
          TableName: 'AuditEventsTable',
          Item: {
            eventType: 'planning-update.commented',
            metadata: {
              commentId: 'audit-comment-1',
              notificationCandidates: [
                { memberKey: 'demo@example.com', reason: 'update-author' },
                { memberKey: 'lead@example.com', reason: 'mention' },
              ],
            },
          },
        },
      }],
    })

    const invalidMentions = await planningApiRequest(
      `/api/planning/updates/1/comments${query}`,
      'POST',
      { id: 'audit-comment-2', body: 'Bad', mentionMemberKeys: 'lead@example.com' },
      'planning-comment-audit-2',
    )
    expect(invalidMentions.status).toBe(400)
    expect(await invalidMentions.json()).toMatchObject({ code: 'InvalidPlanningUpdateCommentMentions' })
  })
})

test('configures, publishes, pages, exports, and watches a qualified Project update', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  let current = new Date('2026-08-07T00:00:00.000Z')
  configurePlanningAnnotationIdempotency(new InMemoryPlanningClient(() => current))
  const target = { type: 'project', teamId: 'core-team', projectId: 'refero' }
  const configured = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'Asia/Tokyo',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 0,
  }, 'planning-cadence-request-1')

  expect(configured.status).toBe(200)
  const configuredBody = await configured.json()
  expect(configuredBody).toMatchObject({
    planning: { revision: 1 },
    updateTarget: {
      target,
      latestVersion: 0,
      updateState: 'missing',
    },
  })

  const replayedCadence = await planningApiRequest(
    '/api/planning/updates/cadence',
    'PUT',
    {
      target,
      cadence: {
        updateOwnerMemberKey: 'demo@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'Asia/Tokyo',
        nextDueAt: '2026-08-10T00:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 0,
    },
    'planning-cadence-request-1',
  )
  expect(replayedCadence.status).toBe(200)
  expect(replayedCadence.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await replayedCadence.json()).toEqual(configuredBody)

  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  setTestAppDependencies({
    collaboration: createCollaborationStub({
      async subscribe() {
        return {
          subscribed: true,
          explicit: true,
          automatic: false,
          reasons: ['manual'],
          watcherCount: 1,
        }
      },
    }),
  })
  const published = await planningApiRequest('/api/planning/updates', 'POST', {
    target,
    id: 'project-update-1',
    health: 'at-risk',
    risk: 'medium',
    summary: 'Migration is progressing with one dependency at risk.',
    riskSummary: 'The vendor handoff may move by one day.',
    decisionSummary: 'Keep the staged rollout.',
    helpNeeded: 'Confirm the vendor owner.',
    nextAction: 'Complete the handoff review.',
    evidence: [{ type: 'link', url: 'https://example.com/evidence', label: 'Handoff log' }],
    expectedRevision: 1,
  })

  expect(published.status).toBe(201)
  expect(await published.json()).toMatchObject({
    planning: { revision: 2 },
    update: {
      id: 'project-update-1',
      version: 1,
      origin: 'manual',
      health: 'at-risk',
      authorMemberKey: 'demo@example.com',
      target,
    },
  })

  const query = '?targetType=project&teamId=core-team&projectId=refero&limit=20'
  const history = await planningApiRequest(`/api/planning/updates${query}`)
  expect(history.status).toBe(200)
  expect(await history.json()).toMatchObject({
    updates: [{ id: 'project-update-1', version: 1 }],
  })

  const exported = await planningApiRequest(`/api/planning/updates/export${query}`)
  expect(exported.status).toBe(200)
  expect(exported.headers.get('Content-Disposition')).toContain(
    'planning-updates-project-core-team-refero.json',
  )
  expect(await exported.json()).toMatchObject({
    schemaVersion: 1,
    target,
    updates: [{ id: 'project-update-1' }],
  })

  const createdComment = await planningApiRequest(
    `/api/planning/updates/1/comments${query}`,
    'POST',
    { id: 'project-update-comment-1', body: 'The handoff evidence is now confirmed.' },
    'planning-comment-request-1',
  )
  expect(createdComment.status).toBe(201)
  const createdCommentBody = await createdComment.json()
  expect(createdCommentBody).toMatchObject({
    comment: {
      id: 'project-update-comment-1',
      updateVersion: 1,
      authorMemberKey: 'demo@example.com',
    },
  })
  current = new Date('2026-08-07T01:00:00.000Z')
  const replayedComment = await planningApiRequest(
    `/api/planning/updates/1/comments${query}`,
    'POST',
    { id: 'project-update-comment-1', body: 'The handoff evidence is now confirmed.' },
    'planning-comment-request-1',
  )
  expect(replayedComment.status).toBe(201)
  expect(replayedComment.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await replayedComment.json()).toEqual(createdCommentBody)
  const conflictingCommentReplay = await planningApiRequest(
    `/api/planning/updates/1/comments${query}`,
    'POST',
    { id: 'project-update-comment-1', body: 'A different retry payload.' },
    'planning-comment-request-1',
  )
  expect(conflictingCommentReplay.status).toBe(409)
  expect(await conflictingCommentReplay.json()).toMatchObject({
    code: 'PlanningUpdateAnnotationIdempotencyConflict',
  })
  const commentWithoutIdempotencyKey = await planningApiRequest(
    `/api/planning/updates/1/comments${query}`,
    'POST',
    { id: 'project-update-comment-2', body: 'Must reserve a durable response receipt.' },
  )
  expect(commentWithoutIdempotencyKey.status).toBe(400)
  expect(await commentWithoutIdempotencyKey.json()).toMatchObject({
    code: 'InvalidPlanningUpdateAnnotationIdempotencyKey',
  })

  const comments = await planningApiRequest(`/api/planning/updates/1/comments${query}`)
  expect(comments.status).toBe(200)
  expect(await comments.json()).toMatchObject({
    comments: [{ id: 'project-update-comment-1' }],
  })

  const addedReaction = await planningApiRequest(
    `/api/planning/updates/1/reactions${query}`,
    'PUT',
    { emoji: '👍' },
    'planning-reaction-add-request-1',
  )
  expect(addedReaction.status).toBe(201)
  const addedReactionBody = await addedReaction.json()
  expect(addedReactionBody).toMatchObject({
    reaction: { emoji: '👍', memberKey: 'demo@example.com', updateVersion: 1 },
  })
  current = new Date('2026-08-07T02:00:00.000Z')
  const replayedReaction = await planningApiRequest(
    `/api/planning/updates/1/reactions${query}`,
    'PUT',
    { emoji: '👍' },
    'planning-reaction-add-request-1',
  )
  expect(replayedReaction.status).toBe(201)
  expect(replayedReaction.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await replayedReaction.json()).toEqual(addedReactionBody)
  const reactions = await planningApiRequest(`/api/planning/updates/1/reactions${query}`)
  expect(await reactions.json()).toMatchObject({
    reactions: [{ emoji: '👍', memberKey: 'demo@example.com' }],
  })
  const removedReaction = await planningApiRequest(
    `/api/planning/updates/1/reactions${query}&emoji=%F0%9F%91%8D`,
    'DELETE',
    undefined,
    'planning-reaction-remove-request-1',
  )
  expect(removedReaction.status).toBe(204)
  const replayedRemoval = await planningApiRequest(
    `/api/planning/updates/1/reactions${query}&emoji=%F0%9F%91%8D`,
    'DELETE',
    undefined,
    'planning-reaction-remove-request-1',
  )
  expect(replayedRemoval.status).toBe(204)
  expect(replayedRemoval.headers.get('Idempotency-Replayed')).toBe('true')
  const reactionsAfterRemoval = await planningApiRequest(
    `/api/planning/updates/1/reactions${query}`,
  )
  expect(await reactionsAfterRemoval.json()).toMatchObject({ reactions: [] })

  const watched = await planningApiRequest(
    '/api/planning/update-watch?targetType=project&teamId=core-team&projectId=refero',
    'PUT',
  )
  expect(watched.status).toBe(200)
  expect(await watched.json()).toHaveProperty('watch')
})

test('bounds Project publish canonical reads to the selected Team and Project', async () => {
  const calls = configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    additionalTeams: Array.from({ length: 20 }, (_, index) => ({
      id: `unrelated-team-${index}`,
      name: `Unrelated Team ${index}`,
      projects: [{
        id: `unrelated-project-${index}`,
        name: `Unrelated Project ${index}`,
        tone: 'purple' as const,
      }],
    })),
  })
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  configurePlanningAnnotationIdempotency(planning)
  const target = { type: 'project', teamId: 'core-team', projectId: 'refero' }

  const configured = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 0,
  }, 'project-scope-cadence-request')
  expect(configured.status).toBe(200)

  const published = await planningApiRequest('/api/planning/updates', 'POST', {
    target,
    id: 'project-scope-update',
    health: 'on-track',
    risk: 'low',
    summary: 'The selected Project remains on track.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    evidence: [],
    expectedRevision: 1,
  })

  expect(published.status).toBe(201)
  expect(new Set(calls.issueReads.map((read) => read.teamId))).toEqual(new Set(['core-team']))
})

test('publishes a Workspace-scoped Initiative update across 50 Teams', async () => {
  const calls = configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'owner',
    additionalTeams: Array.from({ length: 49 }, (_, index) => ({
      id: `wide-team-${index}`,
      name: `Wide Team ${index}`,
      projects: [{
        id: `wide-project-${index}`,
        name: `Wide Project ${index}`,
        tone: 'purple' as const,
      }],
    })),
  })
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  await seedPlanningUpdateInitiative(planning, 'wide-initiative')
  setTestAppDependencies({ planning })
  const target: PlanningUpdateTarget = { type: 'initiative', entityId: 'wide-initiative' }
  const configured = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 3,
  })
  expect(configured.status).toBe(200)

  const published = await planningApiRequest('/api/planning/updates', 'POST', {
    target,
    id: 'wide-initiative-update',
    health: 'on-track',
    risk: 'none',
    summary: 'Every Team is on track.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    evidence: [],
    expectedRevision: 4,
  })

  expect(published.status).toBe(201)
  expect(new Set(calls.issueReads.map((read) => read.teamId)).size).toBe(50)
})

test('keeps filtered Planning history within the requested limit while advancing the cursor', async () => {
  const oldScope = {
    teamId: 'other-team',
    projectId: 'other-project',
  }
  const target: PlanningUpdateTarget = { type: 'initiative', entityId: 'paged-initiative' }
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'owner',
    projectAccesses: [{ ...oldScope, role: 'manager' }],
    additionalTeams: [{
      id: oldScope.teamId,
      name: 'Other Team',
      projects: [{ id: oldScope.projectId, name: 'Other Project', tone: 'purple' }],
    }],
  })
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  await seedPlanningUpdateInitiative(planning, target.entityId, oldScope.teamId)
  setTestAppDependencies({ planning })
  await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 3,
  })
  const firstPublished = await planningApiRequest('/api/planning/updates', 'POST', {
    target,
    id: 'paged-initiative-old-scope',
    health: 'on-track',
    risk: 'low',
    summary: 'Old scope update.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    evidence: [],
    expectedRevision: 4,
  })
  expect(firstPublished.status).toBe(201)

  await planning.move('user#demo@example.com', `${target.entityId}-portfolio`, {
    teamId: 'core-team',
    projectId: 'refero',
    expectedRevision: 5,
  }, { workItems: [] })
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'owner',
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'manager' }],
  })
  const movedGraph = await planningApiRequest('/api/planning')
  expect(movedGraph.status).toBe(200)
  const movedGraphBody: PlanningSnapshot = await movedGraph.json()
  const movedFeed = await planningApiRequest('/api/planning/update-feed')
  expect(movedFeed.status).toBe(200)
  expect(await movedFeed.json()).toMatchObject({ entries: [], total: 0 })
  const ownedMovedFeed = await planningApiRequest('/api/planning/update-feed?view=for-me&relevance=2')
  expect(ownedMovedFeed.status).toBe(200)
  const ownedMovedBody = await ownedMovedFeed.json()
  expect(ownedMovedBody).toMatchObject({ total: 1, entries: [{ health: 'unknown', reasons: ['update-owner', 'project-member'], relevance: 12, attention: { score: 0, reasons: [] } }] })
  expect(ownedMovedBody.entries[0]).not.toHaveProperty('latestUpdate')
  expect(movedGraphBody.updateTargets.find((updateTarget) =>
    updateTarget.target.type === 'initiative' &&
    updateTarget.target.entityId === target.entityId
  )?.latestUpdate).toBeUndefined()
  const reconfigured = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 6,
  })
  expect(reconfigured.status).toBe(200)
  expect((await reconfigured.json()).updateTarget.latestUpdate).toBeUndefined()
  const secondPublished = await planningApiRequest('/api/planning/updates', 'POST', {
    target,
    id: 'paged-initiative-current-scope',
    health: 'at-risk',
    risk: 'medium',
    summary: 'Current scope update.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    evidence: [],
    expectedRevision: 7,
  })
  expect(secondPublished.status).toBe(201)

  const originalListUpdates = planning.listUpdates.bind(planning)
  const firstPage = await originalListUpdates('user#demo@example.com', { target, limit: 2 })
  const currentScopeUpdate = firstPage.updates[0]
  const oldScopeUpdate = firstPage.updates[1]
  if (!currentScopeUpdate || !oldScopeUpdate) {
    throw new Error('Expected two Planning history updates for pagination regression test.')
  }
  const requestedLimits: Array<number | undefined> = []
  planning.listUpdates = async (_workspaceId, input) => {
    if (input.cursor === undefined) {
      return { updates: [currentScopeUpdate, oldScopeUpdate], nextCursor: 'synthetic-next' }
    }
    requestedLimits.push(input.limit)
    return { updates: [currentScopeUpdate, currentScopeUpdate], nextCursor: 'synthetic-end' }
  }

  const response = await planningApiRequest(
    '/api/planning/updates?targetType=initiative&entityId=paged-initiative&limit=2',
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    updates: [
      { id: 'paged-initiative-current-scope' },
      { id: 'paged-initiative-current-scope' },
    ],
    nextCursor: 'synthetic-end',
  })
  expect(requestedLimits).toEqual([1])
})

test('keeps Enterprise-authorized history after an Initiative moves between Projects', async () => {
  const oldScope = { teamId: 'other-team', projectId: 'other-project' }
  const currentScope = { teamId: 'core-team', projectId: 'refero' }
  const target: PlanningUpdateTarget = { type: 'initiative', entityId: 'moved-initiative' }
  configureFakeProjectClients(true, {
    role: 'member',
    workspaceRole: 'member',
    projectAccesses: [],
    teamProjects: [{ id: currentScope.projectId, name: 'Refero', tone: 'blue' }],
    additionalTeams: [{
      id: oldScope.teamId,
      name: 'Other Team',
      projects: [{ id: oldScope.projectId, name: 'Other Project', tone: 'purple' }],
    }],
  })
  const identity = new InMemoryEnterpriseIdentityClient()
  const assignments: EnterpriseRoleAssignment[] = [oldScope, currentScope].map((scope, index) => ({
    workspaceId: 'user#demo@example.com',
    assignmentId: `history-project-member-${index}`,
    principalKind: 'member',
    principalId: 'demo@example.com',
    roleId: 'project:viewer',
    scope: {
      workspaceId: 'user#demo@example.com',
      kind: 'project',
      targetId: scope.projectId,
    },
    source: 'direct',
  }))
  const readSnapshot = identity.getSnapshot.bind(identity)
  identity.getSnapshot = async (workspaceId) => {
    const snapshot = await readSnapshot(workspaceId)
    return { ...snapshot, roleAssignments: assignments }
  }
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  await seedPlanningUpdateInitiative(
    planning,
    target.entityId,
    oldScope.teamId,
    oldScope.projectId,
  )
  setTestAppDependencies({ enterpriseIdentity: identity, planning })

  await planning.configureUpdateCadence('user#demo@example.com', {
    target,
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 3,
  }, { workItems: [] })

  await planning.publishUpdate('user#demo@example.com', {
    target,
    id: 'moved-initiative-history',
    health: 'on-track',
    risk: 'low',
    summary: 'The original Project scope remains readable.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    evidence: [],
    expectedRevision: 4,
  }, 'demo@example.com', { workItems: [] })

  await planning.move('user#demo@example.com', `${target.entityId}-portfolio`, {
    teamId: currentScope.teamId,
    projectId: currentScope.projectId,
    expectedRevision: 5,
  }, { workItems: [] })
  const query = '?targetType=initiative&entityId=moved-initiative'
  const history = await planningApiRequest(`/api/planning/updates${query}`)
  expect(history.status).toBe(200)
  expect(await history.json()).toMatchObject({
    updates: [{ id: 'moved-initiative-history' }],
  })

  const exported = await planningApiRequest(`/api/planning/updates/export${query}`)
  expect(exported.status).toBe(200)
  expect(await exported.json()).toMatchObject({
    target,
    updates: [{ id: 'moved-initiative-history' }],
  })
})

test('requires visible File evidence and fails closed for unsupported Decision evidence', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  const uploadSession = createFileUploadSessionFixture()
  const file = {
    ...uploadSession.file,
    targetType: 'project' as const,
    targetId: 'refero',
    capabilities: {
      ...uploadSession.file.capabilities,
      canDownload: true,
    },
  }
  const seenScopes: string[] = []
  setTestAppDependencies({
    planning,
    fileProofing: createFileProofingStub({
      async findFileById(_workspaceId, _actor, fileId) {
        seenScopes.push('project:refero')
        return fileId === file.id
          ? {
              file,
              scope: {
                workspaceId: 'user#demo@example.com',
                teamId: 'core-team',
                kind: 'project',
                projectId: 'refero',
              },
            }
          : undefined
      },
    }),
  })
  const target = { type: 'project' as const, teamId: 'core-team', projectId: 'refero' }
  const configured = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 0,
  })
  expect(configured.status).toBe(200)

  const published = await planningApiRequest('/api/planning/updates', 'POST', {
    target,
    id: 'project-file-evidence-update',
    health: 'on-track',
    risk: 'none',
    summary: 'The project evidence is attached.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    evidence: [{ type: 'file', fileId: file.id, url: 'https://example.com/files/file-1' }],
    expectedRevision: 1,
  })
  expect(published.status).toBe(201)
  expect(seenScopes).toContain('project:refero')

  const missing = await planningApiRequest('/api/planning/updates', 'POST', {
    target,
    id: 'project-missing-file-evidence-update',
    health: 'on-track',
    risk: 'none',
    summary: 'The missing file must not be accepted.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    evidence: [{ type: 'file', fileId: 'missing-file', url: 'https://example.com/files/missing' }],
    expectedRevision: 2,
  })
  expect(missing.status).toBe(400)
  expect(await missing.json()).toMatchObject({ code: 'PlanningUpdateEvidenceInvalid' })

  const unsupportedDecision = await planningApiRequest('/api/planning/updates', 'POST', {
    target,
    id: 'project-decision-evidence-update',
    health: 'on-track',
    risk: 'none',
    summary: 'The unsupported decision must not be accepted.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    evidence: [{
      type: 'decision',
      decisionId: 'decision-1',
      url: 'https://example.com/decisions/decision-1',
    }],
    expectedRevision: 2,
  })
  expect(unsupportedDecision.status).toBe(400)
  expect(await unsupportedDecision.json()).toMatchObject({
    code: 'PlanningUpdateEvidenceInvalid',
  })
})

test('keeps Project viewers read-only for update comments and reactions', async () => {
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  configurePlanningAnnotationIdempotency(planning)
  const target = { type: 'project' as const, teamId: 'core-team', projectId: 'refero' }
  await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 0,
  })
  await planningApiRequest('/api/planning/updates', 'POST', {
    target,
    id: 'viewer-guard-update',
    health: 'on-track',
    risk: 'none',
    summary: 'Viewer guard update.',
    riskSummary: '',
    decisionSummary: '',
    helpNeeded: '',
    nextAction: '',
    evidence: [],
    expectedRevision: 1,
  })
  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  const query = '?targetType=project&teamId=core-team&projectId=refero'

  const comment = await planningApiRequest(
    `/api/planning/updates/1/comments${query}`,
    'POST',
    { id: 'viewer-comment', body: 'Must not persist.' },
    'viewer-comment-request',
  )
  expect(comment.status).toBe(403)
  const reaction = await planningApiRequest(
    `/api/planning/updates/1/reactions${query}`,
    'PUT',
    { emoji: '👍' },
    'viewer-reaction-request',
  )
  expect(reaction.status).toBe(403)
})

test('requires the exact Team-qualified Project access when Project IDs are duplicated', async () => {
  const planning = new InMemoryPlanningClient()
  await seedPlanningUpdateInitiative(planning, 'core-team-initiative', 'core-team')

  configureFakeProjectClients(true, {
    workspaceRole: 'member',
    projectAccesses: [{ teamId: 'other-team', projectId: 'refero', role: 'viewer' }],
    additionalTeams: [{
      id: 'other-team',
      name: 'Other Team',
      projects: [{ id: 'refero', name: 'Other Refero', tone: 'purple' }],
    }],
  })
  setTestAppDependencies({ planning })

  const denied = await planningApiRequest(
    '/api/planning/updates?targetType=project&teamId=core-team&projectId=refero',
  )
  expect(denied.status).toBe(403)
  const teamScopedInitiativeDenied = await planningApiRequest(
    '/api/planning/updates?targetType=initiative&entityId=core-team-initiative',
  )
  expect(teamScopedInitiativeDenied.status).toBe(403)
  const allowed = await planningApiRequest(
    '/api/planning/updates?targetType=project&teamId=other-team&projectId=refero',
  )
  expect(allowed.status).toBe(200)
  expect(await allowed.json()).toEqual({ updates: [] })
})

test('rejects cadence recipients that cannot act in the current target scope', async () => {
  configureFakeProjectClients(false, {
    workspaceRole: 'owner',
    systemAdminMemberKeys: ['demo@example.com'],
  })
  setTestAppDependencies({ planning: new InMemoryPlanningClient() })
  const target = { type: 'project', teamId: 'core-team', projectId: 'refero' }
  const cadence = {
    cadence: { unit: 'week', count: 1 },
    timeZone: 'UTC',
    nextDueAt: '2026-08-10T00:00:00.000Z',
    reminderHoursBefore: 24,
  }

  const ownerDenied = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: { ...cadence, updateOwnerMemberKey: 'owner@example.com' },
    expectedRevision: 0,
  })
  expect(ownerDenied.status).toBe(409)
  expect(await ownerDenied.json()).toMatchObject({
    code: 'PlanningUpdateRecipientAccessDenied',
  })
  const escalationDenied = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: {
      ...cadence,
      updateOwnerMemberKey: 'demo@example.com',
      escalationHoursAfter: 4,
      escalationMemberKey: 'escalation@example.com',
    },
    expectedRevision: 0,
  })
  expect(escalationDenied.status).toBe(409)
  expect(await escalationDenied.json()).toMatchObject({
    code: 'PlanningUpdateRecipientAccessDenied',
  })
})

test('uses the candidate Enterprise assignment when the configuring caller uses legacy ACLs', async () => {
  configureFakeProjectClients(false, {
    workspaceRole: 'owner',
    projectAccesses: [],
    systemAdminMemberKeys: ['demo@example.com'],
  })
  const identity = new InMemoryEnterpriseIdentityClient()
  const assignment: EnterpriseRoleAssignment = {
    workspaceId: 'user#demo@example.com',
    assignmentId: 'candidate-project-member',
    principalKind: 'member',
    principalId: 'owner@example.com',
    roleId: 'project:member',
    scope: {
      workspaceId: 'user#demo@example.com',
      kind: 'project',
      targetId: 'refero',
    },
    source: 'direct',
  }
  const readSnapshot = identity.getSnapshot.bind(identity)
  identity.getSnapshot = async (workspaceId) => {
    const snapshot = await readSnapshot(workspaceId)
    return {
      ...snapshot,
      roleAssignments: [assignment],
    }
  }
  setTestAppDependencies({
    enterpriseIdentity: identity,
    planning: new InMemoryPlanningClient(),
  })

  const response = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target: { type: 'project', teamId: 'core-team', projectId: 'refero' },
    cadence: {
      updateOwnerMemberKey: 'owner@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 0,
  })

  expect(response.status).toBe(200)
})

test('does not fall back to legacy ACLs for an Enterprise-managed recipient', async () => {
  configureFakeProjectClients(true, {
    workspaceRole: 'owner',
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'member' }],
    systemAdminMemberKeys: ['demo@example.com'],
  })
  const identity = new InMemoryEnterpriseIdentityClient()
  const assignment: EnterpriseRoleAssignment = {
    workspaceId: 'user#demo@example.com',
    assignmentId: 'candidate-project-viewer',
    principalKind: 'member',
    principalId: 'owner@example.com',
    roleId: 'project:viewer',
    scope: {
      workspaceId: 'user#demo@example.com',
      kind: 'project',
      targetId: 'refero',
    },
    source: 'direct',
  }
  const readSnapshot = identity.getSnapshot.bind(identity)
  identity.getSnapshot = async (workspaceId) => {
    const snapshot = await readSnapshot(workspaceId)
    return {
      ...snapshot,
      roleAssignments: [assignment],
    }
  }
  setTestAppDependencies({
    enterpriseIdentity: identity,
    planning: new InMemoryPlanningClient(),
  })

  const response = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target: { type: 'project', teamId: 'core-team', projectId: 'refero' },
    cadence: {
      updateOwnerMemberKey: 'owner@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 0,
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    code: 'PlanningUpdateRecipientAccessDenied',
  })
})

test('rejects guest recipients for Workspace-scoped Initiative cadence', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  const planning = new InMemoryPlanningClient()
  await seedPlanningUpdateInitiative(planning, 'workspace-initiative')
  setTestAppDependencies({ planning })

  const dependencies = getTestAppDependencies()
  const workspaceAccess = dependencies.workspace.workspaceAccess
  setTestAppDependencies({
    workspaceAccess: {
      ...workspaceAccess,
      async getActiveMember(workspaceId, memberKey) {
        const member = await workspaceAccess.getActiveMember(workspaceId, memberKey)
        return member && memberKey === 'guest@example.com'
          ? { ...member, role: 'guest' }
          : member
      },
    },
  })
  const target = { type: 'initiative', entityId: 'workspace-initiative' }
  const cadence = {
    cadence: { unit: 'week', count: 1 },
    timeZone: 'UTC',
    nextDueAt: '2026-08-10T00:00:00.000Z',
    reminderHoursBefore: 24,
  }

  const ownerDenied = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: { ...cadence, updateOwnerMemberKey: 'guest@example.com' },
    expectedRevision: 3,
  })
  expect(ownerDenied.status).toBe(409)
  expect(await ownerDenied.json()).toMatchObject({
    code: 'PlanningUpdateRecipientAccessDenied',
  })
  const escalationDenied = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target,
    cadence: {
      ...cadence,
      updateOwnerMemberKey: 'demo@example.com',
      escalationHoursAfter: 4,
      escalationMemberKey: 'guest@example.com',
    },
    expectedRevision: 3,
  })
  expect(escalationDenied.status).toBe(409)
  expect(await escalationDenied.json()).toMatchObject({
    code: 'PlanningUpdateRecipientAccessDenied',
  })
})

test('lets managers build a scoped hierarchy and dependency graph', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  setTestAppDependencies({ planning: new InMemoryPlanningClient() })

  const portfolio = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'portfolio-1',
    type: 'portfolio',
    title: 'Company portfolio',
    ownerMemberKey: 'demo@example.com',
    status: 'active',
    health: 'on-track',
    risk: 'low',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
    expectedRevision: 0,
  })
  expect(portfolio.status).toBe(201)

  for (const [index, id] of ['roadmap-a', 'roadmap-b'].entries()) {
    const response = await planningApiRequest('/api/planning/entities', 'POST', {
      id,
      type: 'roadmap',
      title: id,
      parentId: 'portfolio-1',
      teamId: 'core-team',
      projectId: 'refero',
      ownerMemberKey: 'demo@example.com',
      status: 'planned',
      health: 'on-track',
      risk: 'low',
      progressMode: 'automatic',
      baseline: { startDate: '2026-07-01', endDate: '2026-07-31' },
      forecast: { startDate: '2026-07-01', endDate: '2026-07-31' },
      expectedRevision: index + 1,
    })
    expect(response.status).toBe(201)
  }

  const dependency = await planningApiRequest('/api/planning/dependencies', 'POST', {
    id: 'dependency-1',
    predecessorId: 'roadmap-a',
    successorId: 'roadmap-b',
    type: 'finish-to-start',
    lagDays: 2,
    expectedRevision: 3,
  })

  expect(dependency.status).toBe(201)
  const planning = await dependency.json() as PlanningSnapshot
  expect(planning.revision).toBe(4)
  expect(planning.dependencies).toEqual([
    expect.objectContaining({
      id: 'dependency-1',
      predecessorId: 'roadmap-a',
      successorId: 'roadmap-b',
    }),
  ])
})

test('replays POST, PATCH, and DELETE dependency mutations without a second revision increment', async () => {
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    teamIssueCount: 2,
  })
  const { preparedResponses } = configureWorkItemDependencyIdempotency()
  const createInput = createWorkItemDependencyInput()

  const created = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    createInput,
    'dependency-create-response-loss',
  )
  expect(created.status).toBe(201)
  expect(await created.json()).toMatchObject({ revision: 1 })
  const replayedCreate = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    createInput,
    'dependency-create-response-loss',
  )
  expect(replayedCreate.status).toBe(201)
  expect(replayedCreate.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await replayedCreate.json()).toMatchObject({ revision: 1 })

  const updateInput = {
    expectedRevision: 1,
    patch: {
      constraint: {
        anchor: 'finish',
        kind: 'not-before',
        date: '2026-06-18',
      },
    },
  }
  const updated = await planningApiRequest(
    '/api/planning/work-item-dependencies/dependency-onboarding-work-item-1',
    'PATCH',
    updateInput,
    'dependency-update-response-loss',
  )
  const updatedBody = await updated.json()
  expect({ body: updatedBody, status: updated.status }).toMatchObject({
    status: 200,
    body: {
      revision: 2,
      workItemDependencies: [{
        id: 'dependency-onboarding-work-item-1',
        constraint: {
          anchor: 'finish',
          kind: 'not-before',
          date: '2026-06-18',
        },
      }],
    },
  })
  const replayedUpdate = await planningApiRequest(
    '/api/planning/work-item-dependencies/dependency-onboarding-work-item-1',
    'PATCH',
    updateInput,
    'dependency-update-response-loss',
  )
  expect(replayedUpdate.status).toBe(200)
  expect(replayedUpdate.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await replayedUpdate.json()).toMatchObject({ revision: 2 })

  const deleteInput = { expectedRevision: 2 }
  const deleted = await planningApiRequest(
    '/api/planning/work-item-dependencies/dependency-onboarding-work-item-1',
    'DELETE',
    deleteInput,
    'dependency-delete-response-loss',
  )
  expect(deleted.status).toBe(200)
  expect(await deleted.json()).toMatchObject({ revision: 3, workItemDependencies: [] })
  const replayedDelete = await planningApiRequest(
    '/api/planning/work-item-dependencies/dependency-onboarding-work-item-1',
    'DELETE',
    deleteInput,
    'dependency-delete-response-loss',
  )
  expect(replayedDelete.status).toBe(200)
  expect(replayedDelete.headers.get('Idempotency-Replayed')).toBe('true')
  expect(await replayedDelete.json()).toMatchObject({
    revision: 3,
    workItemDependencies: [],
  })
  expect(preparedResponses).toHaveLength(3)
})

test('binds dependency idempotency keys to the canonical method, path, and stable body', async () => {
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    teamIssueCount: 2,
  })
  configureWorkItemDependencyIdempotency()
  const createInput = createWorkItemDependencyInput()
  const first = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    createInput,
    'dependency-fingerprint',
  )
  expect(first.status).toBe(201)

  const differentBody = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    { ...createInput, lagDays: 1 },
    'dependency-fingerprint',
  )
  expect(differentBody.status).toBe(409)
  expect(await differentBody.json()).toMatchObject({
    code: 'PlanningWorkItemDependencyIdempotencyConflict',
  })

  const differentMethodAndPath = await planningApiRequest(
    '/api/planning/work-item-dependencies/dependency-onboarding-work-item-1',
    'PATCH',
    { expectedRevision: 1, patch: { lagDays: 2 } },
    'dependency-fingerprint',
  )
  expect(differentMethodAndPath.status).toBe(409)
  expect(await differentMethodAndPath.json()).toMatchObject({
    code: 'PlanningWorkItemDependencyIdempotencyConflict',
  })
})

test('passes only canonical dependency fields across the Planning application boundary', async () => {
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    teamIssueCount: 2,
  })
  const planning = new InMemoryPlanningClient()
  const createDependency = planning.createWorkItemDependency.bind(planning)
  let receivedInput: unknown
  planning.createWorkItemDependency = (...input) => {
    receivedInput = input[1]
    return createDependency(...input)
  }
  configureWorkItemDependencyIdempotency(planning)

  const response = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    {
      ...createWorkItemDependencyInput(),
      adapterOwnedField: 'must-not-cross-boundary',
    },
    'dependency-canonical-input',
  )

  expect(response.status).toBe(201)
  expect(receivedInput).toEqual(createWorkItemDependencyInput())
})

test('returns stable validation and in-progress errors for dependency idempotency keys', async () => {
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    teamIssueCount: 2,
  })
  configureWorkItemDependencyIdempotency()

  for (const key of [undefined, 'x'.repeat(257)]) {
    const response = await planningApiRequest(
      '/api/planning/work-item-dependencies',
      'POST',
      createWorkItemDependencyInput(),
      key,
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'InvalidPlanningWorkItemDependencyIdempotencyKey',
    })
  }

  const currentIdempotency = getTestAppDependencies().developerPlatform.idempotency
  setTestAppDependencies({
    idempotency: {
      reserveIdempotency: async () => ({ status: 'in-progress' }),
      completeIdempotency: (request) => currentIdempotency.completeIdempotency(request),
      releaseIdempotency: (request) => currentIdempotency.releaseIdempotency(request),
    },
  })
  const inProgress = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    createWorkItemDependencyInput(),
    'dependency-in-progress',
  )
  expect(inProgress.status).toBe(409)
  expect(await inProgress.json()).toMatchObject({
    code: 'PlanningWorkItemDependencyIdempotencyInProgress',
  })
})

test('reauthorizes both stored dependency endpoints before replaying a receipt', async () => {
  const projects = [
    { id: 'refero', name: 'Refero', tone: 'blue' },
    { id: 'project-b', name: 'Project B', tone: 'green' },
  ] satisfies Array<{
    id: string
    name: string
    tone: 'blue' | 'green'
  }>
  const assignedProjects = {
    'onboarding-friction': 'refero',
    'work-item-1': 'project-b',
  }
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    teamIssueCount: 2,
    teamProjects: projects,
    detailAssignedProjectIds: assignedProjects,
    projectAccesses: [
      { projectId: 'refero', role: 'manager' },
      { projectId: 'project-b', role: 'manager' },
    ],
  })
  configureWorkItemDependencyIdempotency()
  const input = createWorkItemDependencyInput()
  const first = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    input,
    'dependency-revoked-endpoint',
  )
  expect(first.status).toBe(201)

  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    teamIssueCount: 2,
    teamProjects: projects,
    detailAssignedProjectIds: assignedProjects,
    projectAccesses: [
      { projectId: 'refero', role: 'manager' },
      { projectId: 'project-b', role: 'member' },
    ],
  })
  const replay = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    input,
    'dependency-revoked-endpoint',
  )
  expect(replay.status).toBe(403)
  expect(replay.headers.get('Idempotency-Replayed')).toBeNull()
})

test('stores only a compact dependency receipt when the current Planning snapshot is large', async () => {
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    teamIssueCount: 180,
  })
  const { preparedResponses } = configureWorkItemDependencyIdempotency()
  const response = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    createWorkItemDependencyInput(),
    'dependency-compact-receipt',
  )
  expect(response.status).toBe(201)
  const responsePayload = JSON.stringify(await response.json())
  const receiptPayload = JSON.stringify(preparedResponses[0])
  expect(responsePayload.length).toBeGreaterThan(receiptPayload.length * 20)
  expect(receiptPayload.length).toBeLessThan(1_500)
  expect(receiptPayload).not.toContain('workItems')
  expect(receiptPayload).not.toContain('初回オンボーディング')
  expect(receiptPayload).toContain('"operation":"create"')
})

test('fails closed when a valid replay receipt is ahead of current Planning state', async () => {
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    teamIssueCount: 2,
  })
  configureWorkItemDependencyIdempotency()
  const input = createWorkItemDependencyInput()
  const first = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    input,
    'dependency-restored-state',
  )
  expect(first.status).toBe(201)

  setTestAppDependencies({
    planning: new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z')),
  })
  const replay = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    input,
    'dependency-restored-state',
  )
  expect(replay.status).toBe(503)
  expect(await replay.json()).toMatchObject({
    code: 'InvalidStoredPlanningWorkItemDependencyMutationReceipt',
  })
})

test('releases a dependency reservation after a precommit revision conflict', async () => {
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    teamIssueCount: 2,
  })
  configureWorkItemDependencyIdempotency()
  const input = createWorkItemDependencyInput(1)
  const stale = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    input,
    'dependency-release-precommit',
  )
  expect(stale.status).toBe(409)

  const advanced = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('cycle-before-dependency', 0),
  )
  expect(advanced.status).toBe(201)
  const retried = await planningApiRequest(
    '/api/planning/work-item-dependencies',
    'POST',
    input,
    'dependency-release-precommit',
  )
  expect(retried.status).toBe(201)
  expect(await retried.json()).toMatchObject({ revision: 2 })
})

test('requires parent scope permission when creating a Planning child', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  setTestAppDependencies({ planning: planningClient })

  const parent = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'portfolio-protected',
    type: 'portfolio',
    title: 'Protected Workspace portfolio',
    ownerMemberKey: 'demo@example.com',
    status: 'active',
    health: 'on-track',
    risk: 'low',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
    expectedRevision: 0,
  })
  expect(parent.status).toBe(201)

  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const child = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'roadmap-denied',
    type: 'roadmap',
    title: 'Project roadmap',
    parentId: 'portfolio-protected',
    teamId: 'core-team',
    projectId: 'refero',
    ownerMemberKey: 'demo@example.com',
    status: 'planned',
    health: 'on-track',
    risk: 'low',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-07-31' },
    forecast: { startDate: '2026-07-01', endDate: '2026-07-31' },
    expectedRevision: 1,
  })

  expect(child.status).toBe(403)
  const snapshot = await planningClient.get('user#demo@example.com', { workItems: [] })
  expect(snapshot.revision).toBe(1)
  expect(snapshot.entities.map((entity) => entity.id)).toEqual(['portfolio-protected'])
})

test('requires inherited parent permission when duplicate omits parentId', async () => {
  const planningClient = new InMemoryPlanningClient()
  await seedPlanningWorkspaceParentAndScopedChild(planningClient)
  let duplicateCalls = 0
  const duplicate = planningClient.duplicate.bind(planningClient)
  planningClient.duplicate = async (...input) => {
    duplicateCalls += 1
    return duplicate(...input)
  }
  configureFakeProjectClients(true, {
    projectAccesses: [{ projectId: 'refero', role: 'manager' }],
    workspaceRole: 'member',
  })
  setTestAppDependencies({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/entities/roadmap-scoped-child/duplicate',
    'POST',
    { targetId: 'roadmap-denied-copy', expectedRevision: 2 },
  )

  expect(response.status).toBe(403)
  expect(duplicateCalls).toBe(0)
})

test('requires manager permission for every active descendant before subtree move', async () => {
  const planningClient = new InMemoryPlanningClient()
  await seedPlanningWorkspaceParentAndScopedChild(planningClient)
  let moveCalls = 0
  const move = planningClient.move.bind(planningClient)
  planningClient.move = async (...input) => {
    moveCalls += 1
    return move(...input)
  }
  configureFakeProjectClients(true, {
    projectAccesses: [],
    workspaceRole: 'owner',
  })
  setTestAppDependencies({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/entities/portfolio-scope-parent/move',
    'POST',
    { expectedRevision: 2 },
  )

  expect(response.status).toBe(403)
  expect(moveCalls).toBe(0)
})

test('rejects a scope move while an affected Initiative cadence is active', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  const planningClient = new InMemoryPlanningClient()
  await seedPlanningUpdateInitiative(planningClient, 'cadenced-move-initiative', 'core-team')
  setTestAppDependencies({ planning: planningClient })

  const cadence = await planningApiRequest('/api/planning/updates/cadence', 'PUT', {
    target: { type: 'initiative', entityId: 'cadenced-move-initiative' },
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-10T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 3,
  })
  expect(cadence.status).toBe(200)

  let moveCalls = 0
  const move = planningClient.move.bind(planningClient)
  planningClient.move = async (...input) => {
    moveCalls += 1
    return move(...input)
  }
  const response = await planningApiRequest(
    '/api/planning/entities/cadenced-move-initiative/move',
    'POST',
    {
      teamId: 'core-team',
      projectId: 'refero',
      expectedRevision: 4,
    },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({
    code: 'PlanningMoveRequiresCadenceReconfiguration',
  })
  expect(moveCalls).toBe(0)
  expect((await planningClient.get('user#demo@example.com', { workItems: [] })).revision).toBe(4)
})

test('denies guest Planning writes before invoking a mutation client', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'guest' })
  const planningClient = new InMemoryPlanningClient()
  const create = planningClient.create.bind(planningClient)
  let createCalls = 0
  planningClient.create = async (...input) => {
    createCalls += 1
    return create(...input)
  }
  setTestAppDependencies({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('guest-cycle', 0),
  )

  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({
    code: 'WorkspaceRoleDenied',
    message: 'Guest members have read-only Workspace access.',
  })
  expect(createCalls).toBe(0)
})

test('enforces Planning revisions and structural permissions before mutations', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  setTestAppDependencies({ planning: planningClient })
  const created = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('cycle-structural', 0),
  )
  expect(created.status).toBe(201)

  const malformedPatch = await planningApiRequest(
    '/api/planning/entities/cycle-structural',
    'PATCH',
    { expectedRevision: 1 },
  )
  expect(malformedPatch.status).toBe(400)
  expect(await malformedPatch.json()).toMatchObject({ code: 'PlanningPatchInvalid' })

  const structuralCalls = { archive: 0, duplicate: 0, move: 0 }
  const archive = planningClient.archive.bind(planningClient)
  const duplicate = planningClient.duplicate.bind(planningClient)
  const move = planningClient.move.bind(planningClient)
  planningClient.archive = async (...input) => {
    structuralCalls.archive += 1
    return archive(...input)
  }
  planningClient.duplicate = async (...input) => {
    structuralCalls.duplicate += 1
    return duplicate(...input)
  }
  planningClient.move = async (...input) => {
    structuralCalls.move += 1
    return move(...input)
  }
  const restore = planningClient.restore.bind(planningClient)
  const restoreAuthorizationChecks: unknown[] = []
  let restoreAuthorizationRevoked = false
  planningClient.restore = async (...input) => {
    restoreAuthorizationChecks.push(input[4]?.authorizationConditionChecks)
    if (restoreAuthorizationRevoked) {
      // What the client throws once a restore revision fails its caller authorization checks.
      throw new PlanningError(409, 'PlanningAuthorizationChanged', 'Planning authorization changed.')
    }
    return restore(...input)
  }

  const futureRevision = await planningApiRequest(
    '/api/planning/entities/cycle-structural/archive',
    'POST',
    { expectedRevision: 2 },
  )
  expect(futureRevision.status).toBe(409)
  expect(await futureRevision.json()).toMatchObject({ code: 'PlanningRevisionConflict' })
  expect(structuralCalls.archive).toBe(0)

  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  const memberArchive = await planningApiRequest(
    '/api/planning/entities/cycle-structural/archive',
    'POST',
    { expectedRevision: 1 },
  )
  expect(memberArchive.status).toBe(403)

  configureFakeProjectClients(true, { role: 'viewer', workspaceRole: 'member' })
  const viewerDuplicate = await planningApiRequest(
    '/api/planning/entities/cycle-structural/duplicate',
    'POST',
    { targetId: 'cycle-viewer-copy', expectedRevision: 1 },
  )
  expect(viewerDuplicate.status).toBe(403)

  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const rootMove = await planningApiRequest(
    '/api/planning/entities/cycle-structural/move',
    'POST',
    { expectedRevision: 1 },
  )
  expect(rootMove.status).toBe(403)
  expect(structuralCalls).toEqual({ archive: 0, duplicate: 0, move: 0 })

  const managerDuplicate = await planningApiRequest(
    '/api/planning/entities/cycle-structural/duplicate',
    'POST',
    { targetId: 'cycle-manager-copy', expectedRevision: 1 },
  )
  expect(managerDuplicate.status).toBe(201)
  const duplicatedPlanning = await managerDuplicate.json() as PlanningSnapshot
  expect(duplicatedPlanning.revision).toBe(2)

  const managerMove = await planningApiRequest(
    '/api/planning/entities/cycle-manager-copy/move',
    'POST',
    { teamId: 'core-team', projectId: 'refero', expectedRevision: 2 },
  )
  expect(managerMove.status).toBe(200)
  const movedPlanning = await managerMove.json() as PlanningSnapshot
  expect(movedPlanning.revision).toBe(3)

  const managerArchive = await planningApiRequest(
    '/api/planning/entities/cycle-structural/archive',
    'POST',
    { expectedRevision: 3 },
  )
  expect(managerArchive.status).toBe(200)
  const archivedPlanning = await managerArchive.json() as PlanningSnapshot
  // Archive commits revision 4; moving the archived Cycle out of the live graph commits 5.
  expect(archivedPlanning.revision).toBe(5)
  expect(archivedPlanning.entities.some((entity) => entity.id === 'cycle-structural')).toBe(false)
  expect(structuralCalls).toEqual({ archive: 1, duplicate: 1, move: 1 })

  const archivedList = await planningApiRequest('/api/planning/archived-entities')
  expect(archivedList.status).toBe(200)
  expect(await archivedList.json()).toMatchObject({
    entities: [{ id: 'cycle-structural', type: 'cycle', archivedAt: expect.any(String) }],
  })
  const invalidLimit = await planningApiRequest('/api/planning/archived-entities?limit=0')
  expect(invalidLimit.status).toBe(400)

  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  const memberList = await planningApiRequest('/api/planning/archived-entities')
  expect(memberList.status).toBe(200)
  expect(await memberList.json()).toEqual({ entities: [] })
  const memberRestore = await planningApiRequest(
    '/api/planning/entities/cycle-structural/restore',
    'POST',
    { expectedRevision: 5 },
  )
  expect(memberRestore.status).toBe(403)

  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const staleRestore = await planningApiRequest(
    '/api/planning/entities/cycle-structural/restore',
    'POST',
    { expectedRevision: 4 },
  )
  expect(staleRestore.status).toBe(409)
  const managerRestore = await planningApiRequest(
    '/api/planning/entities/cycle-structural/restore',
    'POST',
    { expectedRevision: 5 },
  )
  expect(managerRestore.status).toBe(200)
  const restored: unknown = await managerRestore.json()
  expect(restored).toMatchObject({ planning: { revision: 6 }, restore: { pendingReferenceCount: 0 } })
  const restoredEntities = isRecord(restored) && isRecord(restored.planning) &&
      Array.isArray(restored.planning.entities)
    ? restored.planning.entities
    : []
  const restoredCycle = restoredEntities.find((entity) => isRecord(entity) && entity.id === 'cycle-structural')
  expect(restoredCycle).toMatchObject({ id: 'cycle-structural' })
  expect(restoredCycle).not.toHaveProperty('archivedAt')
  restoreAuthorizationRevoked = true
  const revokedRestore = await planningApiRequest(
    '/api/planning/entities/cycle-structural/restore',
    'POST',
    { expectedRevision: 6 },
  )
  expect(revokedRestore.status).toBe(409)
  expect(await revokedRestore.json()).toMatchObject({ code: 'PlanningAuthorizationChanged' })
  // Each restore revision guards the caller's Workspace membership.
  expect(restoreAuthorizationChecks.at(-1)).toEqual([
    expect.objectContaining({
      ConditionCheck: expect.objectContaining({
        Key: expect.objectContaining({ recordKey: expect.stringMatching(/^MEMBER#/) }),
      }),
    }),
  ])
})

test('rejects an inactive Planning owner before invoking the mutation client', async () => {
  const planningClient = new InMemoryPlanningClient()
  let createCalls = 0
  const create = planningClient.create.bind(planningClient)
  planningClient.create = async (...input) => {
    createCalls += 1
    return create(...input)
  }
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'owner',
    inactiveWorkspaceMemberKeys: ['inactive@example.com'],
  })
  setTestAppDependencies({ planning: planningClient })

  const response = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'portfolio-inactive-owner',
    type: 'portfolio',
    title: 'Invalid owner portfolio',
    ownerMemberKey: 'inactive@example.com',
    status: 'planned',
    health: 'on-track',
    risk: 'none',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
    expectedRevision: 0,
  })

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'PlanningOwnerInactive' })
  expect(createCalls).toBe(0)
})

test('rejects restoring an archived entity whose owner became inactive', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  setTestAppDependencies({ planning: planningClient })
  const created = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    {
      ...createCyclePlanningInput('cycle-archived-owner', 0),
      ownerMemberKey: 'former-owner@example.com',
    },
  )
  expect(created.status).toBe(201)
  const archived = await planningApiRequest(
    '/api/planning/entities/cycle-archived-owner/archive',
    'POST',
    { expectedRevision: 1 },
  )
  expect(archived.status).toBe(200)

  let restoreCalls = 0
  const restore = planningClient.restore.bind(planningClient)
  planningClient.restore = async (...input) => {
    restoreCalls += 1
    return restore(...input)
  }
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    inactiveWorkspaceMemberKeys: ['former-owner@example.com'],
  })

  const response = await planningApiRequest(
    '/api/planning/entities/cycle-archived-owner/restore',
    'POST',
    { expectedRevision: 3 },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'PlanningOwnerInactive' })
  expect(restoreCalls).toBe(0)
  expect(await planningClient.getArchivedEntity('user#demo@example.com', 'cycle-archived-owner'))
    .toMatchObject({ ownerMemberKey: 'former-owner@example.com' })
})

test('checks the parent scope before restoring an archived entity kept in the live graph', async () => {
  const planningClient = new InMemoryPlanningClient()
  const workspaceId = 'user#demo@example.com'
  const scope = { teamId: undefined, projectId: undefined, cadence: undefined, capacity: undefined, carryOverPolicy: undefined }
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 0),
    ...scope,
    id: 'retained-portfolio',
    type: 'portfolio',
    title: 'Retained portfolio',
  }, { workItems: [] })
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 1),
    ...scope,
    id: 'retained-roadmap',
    type: 'roadmap',
    title: 'Workspace roadmap',
    parentId: 'retained-portfolio',
  }, { workItems: [] })
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 2),
    ...scope,
    id: 'retained-initiative',
    type: 'initiative',
    title: 'Project initiative',
    parentId: 'retained-roadmap',
    teamId: 'core-team',
    projectId: 'refero',
  }, { workItems: [] })
  await planningClient.configureUpdateCadence(workspaceId, {
    target: { type: 'initiative', entityId: 'retained-initiative' },
    cadence: {
      updateOwnerMemberKey: 'demo@example.com',
      cadence: { unit: 'week', count: 1 },
      timeZone: 'UTC',
      nextDueAt: '2026-08-01T00:00:00.000Z',
      reminderHoursBefore: 24,
    },
    expectedRevision: 3,
  }, { workItems: [] })
  // The update target keeps the archived Initiative in the live graph.
  await planningClient.archive(workspaceId, 'retained-initiative', { expectedRevision: 4 }, { workItems: [] })
  expect(await planningClient.getArchivedEntity(workspaceId, 'retained-initiative')).toBeUndefined()
  let restoreCalls = 0
  const restore = planningClient.restore.bind(planningClient)
  planningClient.restore = async (...input) => {
    restoreCalls += 1
    return restore(...input)
  }
  setTestAppDependencies({ planning: planningClient })

  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const projectManager = await planningApiRequest(
    '/api/planning/entities/retained-initiative/restore',
    'POST',
    { expectedRevision: 5 },
  )
  expect(projectManager.status).toBe(403)
  expect(restoreCalls).toBe(0)

  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  const workspaceOwner = await planningApiRequest(
    '/api/planning/entities/retained-initiative/restore',
    'POST',
    { expectedRevision: 5 },
  )
  expect(workspaceOwner.status).toBe(200)
  expect(restoreCalls).toBe(1)
})

test('rejects duplicate when the source Planning owner became inactive', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  setTestAppDependencies({ planning: planningClient })
  const created = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    {
      ...createCyclePlanningInput('cycle-inactive-owner', 0),
      ownerMemberKey: 'former-owner@example.com',
    },
  )
  expect(created.status).toBe(201)

  let duplicateCalls = 0
  const duplicate = planningClient.duplicate.bind(planningClient)
  planningClient.duplicate = async (...input) => {
    duplicateCalls += 1
    return duplicate(...input)
  }
  configureFakeProjectClients(true, {
    role: 'manager',
    workspaceRole: 'member',
    inactiveWorkspaceMemberKeys: ['former-owner@example.com'],
  })

  const response = await planningApiRequest(
    '/api/planning/entities/cycle-inactive-owner/duplicate',
    'POST',
    { targetId: 'cycle-inactive-owner-copy', expectedRevision: 1 },
  )

  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ code: 'PlanningOwnerInactive' })
  expect(duplicateCalls).toBe(0)
})

test('lets Project members link Work Items to Workspace-scope strategic goals', async () => {
  const planningClient = new InMemoryPlanningClient()
  const workspaceId = 'user#demo@example.com'
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 0),
    id: 'portfolio-strategy',
    type: 'portfolio',
    title: 'Strategy portfolio',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 1),
    id: 'roadmap-strategy',
    type: 'roadmap',
    title: 'Strategy roadmap',
    parentId: 'portfolio-strategy',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 2),
    id: 'initiative-strategy',
    type: 'initiative',
    title: 'Strategy initiative',
    parentId: 'roadmap-strategy',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
  }, { workItems: [] })
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('unused-cycle', 3),
    id: 'objective-strategy',
    type: 'goal',
    title: 'Strategy objective',
    parentId: 'initiative-strategy',
    teamId: undefined,
    projectId: undefined,
    cadence: undefined,
    capacity: undefined,
    carryOverPolicy: undefined,
    goalFramework: 'objective',
  }, { workItems: [] })
  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  setTestAppDependencies({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      goalIds: ['objective-strategy'],
      expectedRevision: 4,
    },
  )

  expect(response.status).toBe(200)
  expect((await response.json() as PlanningSnapshot).workItemLinks[0]?.goalIds)
    .toEqual(['objective-strategy'])
})

test('requires old Planning scope permission when re-linking a moved Work Item', async () => {
  const planningClient = new InMemoryPlanningClient()
  const workspaceId = 'user#demo@example.com'
  const oldWorkItemState = {
    workItems: [{
      id: 'onboarding-friction',
      revision: 1,
      teamId: 'core-team',
      title: 'Moved Work Item',
      projectId: 'refero',
      statusCategory: 'started' as const,
      dueDate: '2026-08-31',
      schedule: createDefaultDueDateWorkItemSchedule('2026-08-31'),
    }],
  }
  await planningClient.create(
    workspaceId,
    createCyclePlanningInput('cycle-project-a', 0),
    oldWorkItemState,
  )
  await planningClient.create(workspaceId, {
    ...createCyclePlanningInput('cycle-project-b', 1),
    projectId: 'project-b',
  }, oldWorkItemState)
  await planningClient.putWorkItemLink(workspaceId, {
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    projectId: 'refero',
    cycleId: 'cycle-project-a',
    goalIds: [],
    expectedRevision: 2,
  }, oldWorkItemState)
  let putCalls = 0
  const putWorkItemLink = planningClient.putWorkItemLink.bind(planningClient)
  planningClient.putWorkItemLink = async (...input) => {
    putCalls += 1
    return putWorkItemLink(...input)
  }
  configureFakeProjectClients(true, {
    detailAssignedProjectId: 'project-b',
    projectAccesses: [{ projectId: 'project-b', role: 'member' }],
    teamProjects: [
      { id: 'refero', name: 'Refero', tone: 'blue' },
      { id: 'project-b', name: 'Project B', tone: 'green' },
    ],
    workspaceRole: 'member',
  })
  setTestAppDependencies({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'project-b',
      cycleId: 'cycle-project-b',
      goalIds: [],
      expectedRevision: 3,
    },
  )

  expect(response.status).toBe(403)
  expect(putCalls).toBe(0)
})

test('lets Workspace owners clean up inaccessible stale Work Item links', async () => {
  const planningClient = new InMemoryPlanningClient()
  const workspaceId = 'user#demo@example.com'
  const staleWorkItemState = {
    workItems: [{
      id: 'missing-work-item',
      revision: 1,
      teamId: 'core-team',
      title: 'Deleted later',
      projectId: 'refero',
      statusCategory: 'unstarted' as const,
      dueDate: '2026-08-31',
      schedule: createDefaultDueDateWorkItemSchedule('2026-08-31'),
    }],
  }
  await planningClient.create(
    workspaceId,
    createCyclePlanningInput('cycle-stale-link', 0),
    staleWorkItemState,
  )
  await planningClient.putWorkItemLink(workspaceId, {
    teamId: 'core-team',
    workItemId: 'missing-work-item',
    projectId: 'refero',
    cycleId: 'cycle-stale-link',
    goalIds: [],
    expectedRevision: 1,
  }, staleWorkItemState)
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  setTestAppDependencies({ planning: planningClient })

  const response = await planningApiRequest(
    '/api/planning/work-item-links/core-team/missing-work-item',
    'DELETE',
    { expectedRevision: 2 },
  )

  expect(response.status).toBe(200)
  const planning = await response.json() as PlanningSnapshot
  expect(planning.revision).toBe(3)
  expect(planning.workItemLinks).toEqual([])
})

test('lets members link accessible canonical Work Items', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  setTestAppDependencies({ planning: planningClient })
  const created = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('cycle-current', 0),
  )
  expect(created.status).toBe(201)

  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  const malformedLink = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      cycleId: 'cycle-current',
      expectedRevision: 1,
    },
  )
  expect(malformedLink.status).toBe(400)
  expect(await malformedLink.json()).toMatchObject({ code: 'InvalidPlanningInput' })

  const linked = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      cycleId: 'cycle-current',
      goalIds: [],
      expectedRevision: 1,
    },
  )

  expect(linked.status).toBe(200)
  const linkedPlanning = await linked.json() as PlanningSnapshot
  expect(linkedPlanning.workItemLinks).toEqual([
    expect.objectContaining({
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      cycleId: 'cycle-current',
    }),
  ])
  expect(linkedPlanning.entities[0]).toMatchObject({
    linkedWorkItemCount: 1,
    progress: 50,
  })
})

test('returns revision conflicts and reproducibly rolls incomplete Work Items forward', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  setTestAppDependencies({ planning: new InMemoryPlanningClient() })

  const source = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('cycle-source', 0),
  )
  expect(source.status).toBe(201)
  const target = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    {
      ...createCyclePlanningInput('cycle-target', 1),
      baseline: { startDate: '2026-07-15', endDate: '2026-07-28' },
      forecast: { startDate: '2026-07-15', endDate: '2026-07-28' },
    },
  )
  expect(target.status).toBe(201)
  const linked = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      cycleId: 'cycle-source',
      goalIds: [],
      expectedRevision: 2,
    },
  )
  expect(linked.status).toBe(200)

  const conflict = await planningApiRequest(
    '/api/planning/cycles/cycle-source/rollover',
    'POST',
    { targetCycleId: 'cycle-target', expectedRevision: 2 },
  )
  expect(conflict.status).toBe(409)
  expect(await conflict.json()).toMatchObject({ code: 'PlanningRevisionConflict' })

  const rolledOver = await planningApiRequest(
    '/api/planning/cycles/cycle-source/rollover',
    'POST',
    { targetCycleId: 'cycle-target', expectedRevision: 3 },
  )
  expect(rolledOver.status).toBe(200)
  const body = await rolledOver.json() as PlanningMutationResponse
  expect(body.movedWorkItemIds).toEqual(['onboarding-friction'])
  expect(body.retainedWorkItemIds).toEqual([])
  expect(body.planning.revision).toBe(4)
  expect(body.planning.workItemLinks[0]?.cycleId).toBe('cycle-target')
  expect(body.planning.entities.find((entity) => entity.id === 'cycle-source')?.status)
    .toBe('completed')
})

test('creates the next Cycle and adds Work Items to a Cycle in bulk', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  setTestAppDependencies({ planning: new InMemoryPlanningClient() })

  const source = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    {
      ...createCyclePlanningInput('cycle-source', 0),
      automation: { createNext: true, rolloverAtEnd: true },
    },
  )
  expect(source.status).toBe(201)

  const next = await planningApiRequest('/api/planning/cycles/cycle-source/next', 'POST', {
    expectedRevision: 1,
  })
  expect(next.status).toBe(201)
  const nextBody = await next.json() as CreateNextCycleResponse
  const created = nextBody.planning.entities.find((entity) => entity.id === nextBody.cycleId)
  expect(created).toMatchObject({
    type: 'cycle',
    baseline: { startDate: '2026-07-15', endDate: '2026-07-28' },
    automation: { createNext: true, rolloverAtEnd: true },
  })

  const tooMany = await planningApiRequest(
    `/api/planning/cycles/${nextBody.cycleId}/work-items`,
    'POST',
    {
      action: 'add',
      workItems: Array.from({ length: 50 }, (_, index) => ({
        teamId: 'core-team',
        workItemId: `item-${index}`,
      })),
      expectedRevision: 2,
    },
  )
  expect(tooMany.status).toBe(400)

  const added = await planningApiRequest(
    `/api/planning/cycles/${nextBody.cycleId}/work-items`,
    'POST',
    {
      action: 'add',
      workItems: [{ teamId: 'core-team', workItemId: 'onboarding-friction' }],
      expectedRevision: 2,
    },
  )
  expect(added.status).toBe(200)
  const addedBody = await added.json() as PlanningSnapshot
  expect(addedBody.workItemLinks).toEqual([
    expect.objectContaining({ workItemId: 'onboarding-friction', cycleId: nextBody.cycleId }),
  ])

  const removed = await planningApiRequest(
    `/api/planning/cycles/${nextBody.cycleId}/work-items`,
    'POST',
    {
      action: 'remove',
      workItems: [{ teamId: 'core-team', workItemId: 'onboarding-friction' }],
      expectedRevision: 3,
    },
  )
  expect(removed.status).toBe(200)
  expect((await removed.json() as PlanningSnapshot).workItemLinks).toEqual([])
})

test('lets an Enterprise planning.write role change Cycle Work Items in bulk but not create the next Cycle or set automation', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const workspaceId = 'user#demo@example.com'
  const planning = new InMemoryPlanningClient()
  await planning.create(workspaceId, createCyclePlanningInput('cycle-source', 0), { workItems: [] })
  const identity = new InMemoryEnterpriseIdentityClient()
  const readIdentity = identity.getSnapshot.bind(identity)
  const customRole: EnterpriseCustomRole = {
    workspaceId, roleId: 'custom:planning-writer', name: 'Planning writer',
    permissions: ['planning.read', 'planning.write', 'work-items.read', 'work-items.write', 'projects.read'],
    guestAssignable: false, revision: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }
  identity.getSnapshot = async (id) => ({
    ...await readIdentity(id),
    roleAssignments: [{
      workspaceId, assignmentId: 'workspace-planning-writer',
      principalKind: 'member', principalId: 'demo@example.com', roleId: customRole.roleId,
      scope: { workspaceId, kind: 'workspace' }, source: 'direct',
    }],
    customRoles: [customRole],
  })
  setTestAppDependencies({ planning, enterpriseIdentity: identity })

  const added = await planningApiRequest('/api/planning/cycles/cycle-source/work-items', 'POST', {
    action: 'add',
    workItems: [{ teamId: 'core-team', workItemId: 'onboarding-friction' }],
    expectedRevision: 1,
  })
  expect(added.status).toBe(200)
  const next = await planningApiRequest('/api/planning/cycles/cycle-source/next', 'POST', {
    expectedRevision: 2,
  })
  expect(next.status).toBe(403)
  // Automation runs /next and rollover later, so turning it on needs planning.manage too.
  const automation = await planningApiRequest('/api/planning/entities/cycle-source', 'PATCH', {
    expectedRevision: 2,
    patch: { automation: { createNext: true, rolloverAtEnd: true } },
  })
  expect(automation.status).toBe(403)
  const created = await planningApiRequest('/api/planning/entities', 'POST', {
    ...createCyclePlanningInput('cycle-writer', 2),
    automation: { createNext: true, rolloverAtEnd: false },
  })
  expect(created.status).toBe(403)
})

test('requires Cycle manager permission to create the next Cycle', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const planning = new InMemoryPlanningClient()
  setTestAppDependencies({ planning })
  const source = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('cycle-source', 0),
  )
  expect(source.status).toBe(201)

  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  const denied = await planningApiRequest('/api/planning/cycles/cycle-source/next', 'POST', {
    expectedRevision: 1,
  })
  expect(denied.status).toBe(403)
})

test('requires Cycle manager permission to change Cycle automation', async () => {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const planning = new InMemoryPlanningClient()
  setTestAppDependencies({ planning })
  const source = await planningApiRequest(
    '/api/planning/entities',
    'POST',
    createCyclePlanningInput('cycle-source', 0),
  )
  expect(source.status).toBe(201)

  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  const deniedPatch = await planningApiRequest('/api/planning/entities/cycle-source', 'PATCH', {
    expectedRevision: 1,
    patch: { automation: { createNext: true, rolloverAtEnd: true } },
  })
  expect(deniedPatch.status).toBe(403)
  const deniedCreate = await planningApiRequest('/api/planning/entities', 'POST', {
    ...createCyclePlanningInput('cycle-member', 1),
    automation: { createNext: true, rolloverAtEnd: false },
  })
  expect(deniedCreate.status).toBe(403)
  const allowedPatch = await planningApiRequest('/api/planning/entities/cycle-source', 'PATCH', {
    expectedRevision: 1,
    patch: { title: 'Sprint renamed' },
  })
  expect(allowedPatch.status).toBe(200)
})
