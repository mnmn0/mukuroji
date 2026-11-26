import { afterEach, describe, expect, test } from 'bun:test'
import { createApiTestHarness } from './test-support/api-test-harness'
import { createCanonicalPublicPlanningService } from './routes/public-planning-service'
import { InMemoryPlanningClient } from '../modules/planning/planning'
import type { AuthenticatedDeveloperCredential } from '../modules/developer-platform/application/ports'
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

/**
 * Installs an in-memory Planning store for the test Workspace.
 *
 * @returns The store.
 */
function usePlanning(): InMemoryPlanningClient {
  const planning = new InMemoryPlanningClient(() => new Date('2026-08-07T00:00:00.000Z'))
  setTestAppDependencies({ planning })
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

    const updated = await runWithTestAppDependencies(() => service.updateMilestone(
      credential,
      created.item.id,
      { health: 'at-risk', targetDate: '2026-09-04' },
      context('key-2'),
    ))
    expect(updated.item).toMatchObject({
      id: created.item.id, health: 'at-risk', forecast: { startDate: '2026-09-04', endDate: '2026-09-04' }, baseline: { endDate: '2026-08-31' },
    })
    expect(updated.revision).toBeGreaterThan(created.revision)
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
    await expect(runWithTestAppDependencies(() => service.updateMilestone(
      credential,
      'missing',
      { title: 'Renamed' },
      context('key-4'),
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
    const retried = await runWithTestAppDependencies(() => service.publishStatusUpdate(
      credential,
      { ...input, expectedRevision: 1 },
      context('key-5'),
    ))
    expect(retried.item.id).toBe(published.item.id)

    const page = await runWithTestAppDependencies(() => service.listStatusUpdates(credential, projectTarget, 10, undefined))
    expect(page).toMatchObject({ schemaVersion: 1, hasMore: false, items: [{ id: published.item.id, version: 1 }] })
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
