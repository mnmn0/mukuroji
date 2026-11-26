import { afterEach, describe, expect, test } from 'bun:test'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicPlanningService } from './routes/public-planning-service'
import { InMemoryPlanningClient } from '../modules/planning/planning'
import type {
  AuthenticatedDeveloperCredential,
  CompleteIdempotencyRequest,
  IdempotencyMutationToken,
} from '../modules/developer-platform/application/ports'
import { createInMemoryDeveloperPlatformAdapters } from '../modules/developer-platform/adapter-out/in-memory/developer-platform-adapters'
import type { PublicMutationContext } from '../modules/developer-platform/public-api'

const {
  configureFakeProjectClients,
  createCyclePlanningInput,
  resetTestApp,
  runWithTestAppDependencies,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

const workspaceId = 'user#demo@example.com'
const credential: AuthenticatedDeveloperCredential = {
  kind: 'api-key',
  workspaceId,
  credentialId: 'agent-key',
  subjectUserId: 'demo@example.com',
  scopes: ['work-items:read', 'work-items:write'],
}
const projectTarget = { type: 'project' as const, teamId: 'core-team', projectId: 'refero' }

/**
 * Builds the mutation context of one keyed request.
 *
 * @param idempotencyKey - Idempotency key of the request.
 * @returns The context.
 */
function context(idempotencyKey: string): PublicMutationContext {
  return { requestId: `request-${idempotencyKey}`, idempotencyKey }
}

/** In-memory idempotency store of the current test. */
let platform = createInMemoryDeveloperPlatformAdapters()

/**
 * Reserves a Public API idempotency key, as the router does before it calls the service.
 *
 * @param idempotencyKey - Idempotency key.
 * @returns The reservation token, or the stored response when the key already completed.
 */
async function reserve(idempotencyKey: string): Promise<IdempotencyMutationToken | { replay: unknown }> {
  const request = { workspaceId, credentialId: credential.credentialId, idempotencyKey, requestFingerprint: `fingerprint-${idempotencyKey}` }
  const reservation = await platform.idempotency.reserveIdempotency(request)
  if (reservation.status === 'replay') return { replay: reservation.response }
  if (reservation.status !== 'reserved') throw new Error('The key is still in progress.')
  return { ...request, reservationId: reservation.reservationId }
}

/**
 * Reserves a key that has not been used yet.
 *
 * @param idempotencyKey - Idempotency key.
 * @returns The reservation token.
 */
async function token(idempotencyKey: string): Promise<IdempotencyMutationToken> {
  const reserved = await reserve(idempotencyKey)
  if ('replay' in reserved) throw new Error('The key was already used.')
  return reserved
}

/**
 * Installs an in-memory Planning store for the test Workspace, whose health update publish and
 * entity patch commit their idempotency receipt with the change, as the DynamoDB transaction does.
 *
 * @returns The store.
 */
function usePlanning(): InMemoryPlanningClient {
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  platform = createInMemoryDeveloperPlatformAdapters()
  const prepared: CompleteIdempotencyRequest[] = []
  /**
   * Completes the receipts a write prepared once the write commits.
   *
   * @param write - The write.
   * @returns The write's result.
   */
  async function completePrepared<Result>(write: () => Promise<Result>): Promise<Result> {
    const first = prepared.length
    try {
      const result = await write()
      for (const completion of prepared.splice(first)) await platform.idempotency.completeIdempotency(completion)
      return result
    } catch (error) {
      prepared.splice(first)
      throw error
    }
  }
  const publishUpdate = planning.publishUpdate.bind(planning)
  planning.publishUpdate = (...input) => completePrepared(() => publishUpdate(...input))
  const update = planning.update.bind(planning)
  planning.update = (...input) => completePrepared(() => update(...input))
  setTestAppDependencies({
    planning,
    idempotency: platform.idempotency,
    transactions: {
      async prepareIdempotencyCompletionTransactWrite(request) {
        prepared.push(request)
        return { transactWriteItem: { Put: { TableName: 'DeveloperPlatformTable', Item: { entryType: 'idempotency' } } } }
      },
    },
  })
  return planning
}

/**
 * Seeds the Initiative a Milestone hangs under, with its Roadmap and Portfolio.
 *
 * @param planning - Planning store.
 */
async function seedInitiative(planning: InMemoryPlanningClient): Promise<void> {
  const base = {
    ...createCyclePlanningInput('unused', 0),
    teamId: undefined, projectId: undefined, cadence: undefined, capacity: undefined, carryOverPolicy: undefined,
  }
  await planning.create(workspaceId, { ...base, id: 'portfolio-1', type: 'portfolio', title: 'Portfolio', expectedRevision: 0 }, { workItems: [] })
  await planning.create(workspaceId, { ...base, id: 'roadmap-1', type: 'roadmap', title: 'Roadmap', parentId: 'portfolio-1', expectedRevision: 1 }, { workItems: [] })
  await planning.create(workspaceId, {
    ...base, id: 'initiative-1', type: 'initiative', title: 'Initiative', parentId: 'roadmap-1', teamId: 'core-team', projectId: 'refero',
    expectedRevision: 2,
  }, { workItems: [] })
}

describe('Public API Planning', () => {
  test('creates, lists, and updates a Milestone as a Project member, and retries by key', async () => {
    configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
    await seedInitiative(usePlanning())
    const service = createCanonicalPublicPlanningService()
    const input = {
      title: 'Beta', parentId: 'initiative-1', teamId: 'core-team', projectId: 'refero', targetDate: '2026-08-31',
    }

    const created = await runWithTestAppDependencies(() => service.createMilestone(credential, input, context('key-1')))
    expect(created.item).toMatchObject({
      type: 'milestone', title: 'Beta', teamId: 'core-team', projectId: 'refero', ownerMemberId: 'demo@example.com',
      status: 'planned', health: 'unknown',
      baseline: { startDate: '2026-08-31', endDate: '2026-08-31' }, forecast: { startDate: '2026-08-31', endDate: '2026-08-31' },
    })
    expect(created.item.id).toStartWith('pe-')

    // A retry after a lost response finds the same Milestone instead of creating another one.
    const retried = await runWithTestAppDependencies(() => service.createMilestone(
      credential,
      { ...input, expectedRevision: 0 },
      context('key-1'),
    ))
    expect(retried.item.id).toBe(created.item.id)

    const listed = await runWithTestAppDependencies(() => service.listEntities(credential, 'milestone', { teamId: 'core-team' }))
    expect(listed.items.map((item) => item.id)).toEqual([created.item.id])
    expect((await runWithTestAppDependencies(() => service.listEntities(credential, 'initiative', {}))).items)
      .toMatchObject([{ id: 'initiative-1', type: 'initiative' }])
    expect(await runWithTestAppDependencies(() => service.listEntities(credential, 'cycle', {}))).toMatchObject({ items: [] })

    const reservation = await token('key-2')
    const updated = await runWithTestAppDependencies(() => service.updateMilestone(
      credential,
      created.item.id,
      { health: 'at-risk', targetDate: '2026-09-04' },
      context('key-2'),
      reservation,
    ))
    expect(updated.item).toMatchObject({
      id: created.item.id, health: 'at-risk', forecast: { startDate: '2026-09-04', endDate: '2026-09-04' }, baseline: { endDate: '2026-08-31' },
    })
    expect(updated.revision).toBeGreaterThan(created.revision)
    // The receipt committed with the patch, so a retry after a lost response replays it.
    expect(await reserve('key-2')).toEqual({ replay: { status: 200, body: updated } })
  })

  test('refuses a Milestone to a Project viewer, as the Web Planning routes do', async () => {
    configureFakeProjectClients(true, {
      role: 'viewer',
      workspaceRole: 'member',
      projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }],
    })
    await seedInitiative(usePlanning())
    const service = createCanonicalPublicPlanningService()

    await expect(runWithTestAppDependencies(() => service.createMilestone(credential, {
      title: 'Beta', parentId: 'initiative-1', teamId: 'core-team', projectId: 'refero', targetDate: '2026-08-31',
    }, context('key-3')))).rejects.toMatchObject({ status: 403 })
    const missing = await token('key-4')
    await expect(runWithTestAppDependencies(() => service.updateMilestone(
      credential,
      'missing',
      { title: 'Renamed' },
      context('key-4'),
      missing,
    ))).rejects.toMatchObject({ status: 404 })
  })

  test('puts a Work Item in a Cycle, takes it out again, and refuses a stale revision', async () => {
    configureFakeProjectClients(true, { role: 'member', workspaceRole: 'member' })
    const planning = usePlanning()
    const workItemState = { workItems: [] }
    await planning.create(workspaceId, createCyclePlanningInput('cycle-1', 0), workItemState)
    const service = createCanonicalPublicPlanningService()

    const inCycle = await runWithTestAppDependencies(() => service.updateWorkItemPlanning(
      credential,
      'core-team',
      'onboarding-friction',
      { cycleId: 'cycle-1' },
    ))
    expect(inCycle).toMatchObject({ teamId: 'core-team', workItemId: 'onboarding-friction', cycleId: 'cycle-1', goalIds: [] })
    expect(await runWithTestAppDependencies(() => service.getWorkItemPlanning(credential, 'core-team', 'onboarding-friction')))
      .toMatchObject({ cycleId: 'cycle-1' })

    const outOfCycle = await runWithTestAppDependencies(() => service.updateWorkItemPlanning(
      credential,
      'core-team',
      'onboarding-friction',
      { cycleId: null },
    ))
    expect(outOfCycle.cycleId).toBeUndefined()

    await expect(runWithTestAppDependencies(() => service.updateWorkItemPlanning(
      credential,
      'core-team',
      'onboarding-friction',
      { cycleId: 'cycle-1', expectedRevision: 0 },
    ))).rejects.toMatchObject({ status: 409 })
  })

  test('publishes a health update once per key and lists it newest first', async () => {
    configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
    const planning = usePlanning()
    await planning.configureUpdateCadence(workspaceId, {
      target: projectTarget,
      cadence: {
        updateOwnerMemberKey: 'demo@example.com',
        cadence: { unit: 'week', count: 1 },
        timeZone: 'Asia/Tokyo',
        nextDueAt: '2026-08-10T00:00:00.000Z',
        reminderHoursBefore: 24,
      },
      expectedRevision: 0,
    }, { workItems: [] })
    const service = createCanonicalPublicPlanningService()
    const input = { target: projectTarget, health: 'on-track' as const, summary: 'On plan.' }

    const published = await runWithTestAppDependencies(() => service.publishStatusUpdate(credential, input, context('key-5')))
    expect(published.item).toMatchObject({
      target: projectTarget, version: 1, health: 'on-track', risk: 'none', summary: 'On plan.', authorMemberId: 'demo@example.com',
    })
    // Another update follows before the first request is retried; the retry still finds its own.
    const next = await runWithTestAppDependencies(() => service.publishStatusUpdate(
      credential,
      { ...input, summary: 'Still on plan.' },
      context('key-7'),
    ))
    expect(next.item.version).toBe(2)
    const retried = await runWithTestAppDependencies(() => service.publishStatusUpdate(credential, input, context('key-5')))
    expect(retried.item).toMatchObject({ id: published.item.id, version: 1 })
    await runWithTestAppDependencies(() => service.authorizeStatusUpdateReplay(credential, projectTarget, published))
    await expect(runWithTestAppDependencies(() => service.authorizeStatusUpdateReplay(
      credential,
      projectTarget,
      { item: { id: 'another', version: 1 } },
    ))).rejects.toMatchObject({ status: 503 })

    const page = await runWithTestAppDependencies(() => service.listStatusUpdates(credential, projectTarget, 10, undefined))
    expect(page).toMatchObject({ schemaVersion: 1, hasMore: false, items: [{ version: 2 }, { id: published.item.id, version: 1 }] })
  })

  test('refuses a health update for a target without an update cadence', async () => {
    configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
    usePlanning()
    const service = createCanonicalPublicPlanningService()

    await expect(runWithTestAppDependencies(() => service.publishStatusUpdate(credential, {
      target: projectTarget, health: 'on-track', summary: 'On plan.',
    }, context('key-6')))).rejects.toMatchObject({ status: 409, code: 'PlanningUpdateCadenceNotConfigured' })
  })
})
