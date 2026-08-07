import {
  createApiTestHarness,
} from '../../../../api/test-support/api-test-harness'
const {
  configureFakeProjectClients,
  createCyclePlanningInput,
  getTestAppDependencies,
  planningApiRequest,
  resetTestApp,
  seedPlanningWorkspaceParentAndScopedChild,
  setTestAppDependencies,
} = createApiTestHarness()
import {
  InMemoryPlanningClient,
} from '../../planning'
import { createInMemoryDeveloperPlatformAdapters } from '../../../developer-platform/adapter-out/in-memory/developer-platform-adapters'
import type { CompleteIdempotencyRequest } from '../../../developer-platform/application/ports'
import type {
  PlanningMutationResponse,
  PlanningSnapshot,
} from '@mukuroji/contracts'
import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
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

test('returns an authenticated empty Planning graph with accessible Work Item projections', async () => {
  configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
  setTestAppDependencies({ planning: new InMemoryPlanningClient() })

  const response = await planningApiRequest('/api/planning')

  expect(response.status).toBe(200)
  const planning = await response.json() as PlanningSnapshot
  expect(planning).toMatchObject({
    schemaVersion: 1,
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
