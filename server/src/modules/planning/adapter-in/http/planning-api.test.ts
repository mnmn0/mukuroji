import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
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
} = createApiTestHarness()
import {
  InMemoryPlanningClient,
} from '../../planning'
import { InMemoryEnterpriseIdentityClient } from '../../../enterprise-identity/enterprise-identity'
import { createInMemoryDeveloperPlatformAdapters } from '../../../developer-platform/adapter-out/in-memory/developer-platform-adapters'
import type { CompleteIdempotencyRequest } from '../../../developer-platform/application/ports'
import type {
  EnterpriseRoleAssignment,
  PlanningMutationResponse,
  PlanningSnapshot,
  PlanningUpdateTarget,
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
 */
async function seedPlanningUpdateInitiative(
  planning: InMemoryPlanningClient,
  entityId: string,
  teamId?: string,
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
    projectId: undefined,
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
  expect(archivedPlanning.revision).toBe(4)
  expect(archivedPlanning.entities.find((entity) => entity.id === 'cycle-structural')?.archivedAt)
    .toBeDefined()
  expect(structuralCalls).toEqual({ archive: 1, duplicate: 1, move: 1 })
})

test('requires Workspace administration for unscoped status updates', async () => {
  const planningClient = new InMemoryPlanningClient()
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'owner' })
  setTestAppDependencies({ planning: planningClient })
  const created = await planningApiRequest('/api/planning/entities', 'POST', {
    id: 'portfolio-workspace',
    type: 'portfolio',
    title: 'Workspace portfolio',
    ownerMemberKey: 'demo@example.com',
    status: 'active',
    health: 'on-track',
    risk: 'low',
    progressMode: 'automatic',
    baseline: { startDate: '2026-07-01', endDate: '2026-09-30' },
    forecast: { startDate: '2026-07-01', endDate: '2026-09-30' },
    expectedRevision: 0,
  })
  expect(created.status).toBe(201)

  let statusUpdateCalls = 0
  const addStatusUpdate = planningClient.addStatusUpdate.bind(planningClient)
  planningClient.addStatusUpdate = async (...input) => {
    statusUpdateCalls += 1
    return addStatusUpdate(...input)
  }
  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })

  const response = await planningApiRequest(
    '/api/planning/entities/portfolio-workspace/status-updates',
    'POST',
    {
      id: 'status-workspace',
      message: 'Member must not update Workspace scope.',
      health: 'at-risk',
      expectedRevision: 1,
    },
  )

  expect(response.status).toBe(403)
  expect(statusUpdateCalls).toBe(0)
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

test('lets members add status updates and link accessible canonical Work Items', async () => {
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
  const statusUpdate = await planningApiRequest(
    '/api/planning/entities/cycle-current/status-updates',
    'POST',
    {
      id: 'status-1',
      message: 'Delivery is proceeding.',
      health: 'on-track',
      expectedRevision: 1,
    },
  )
  expect(statusUpdate.status).toBe(201)
  const statusPlanning = await statusUpdate.json() as PlanningSnapshot
  expect(statusPlanning.entities[0]?.statusUpdates[0]).toMatchObject({
    id: 'status-1',
    authorMemberKey: 'demo@example.com',
  })

  const malformedLink = await planningApiRequest(
    '/api/planning/work-item-links/core-team/onboarding-friction',
    'PUT',
    {
      teamId: 'core-team',
      workItemId: 'onboarding-friction',
      projectId: 'refero',
      cycleId: 'cycle-current',
      expectedRevision: 2,
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
      expectedRevision: 2,
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
