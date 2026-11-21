import { createDefaultDueDateWorkItemSchedule, PROJECT_SCHEDULE_BASELINE_MAX_SAVED } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { InMemoryProjectScheduleBaselineStore } from './schedule-baseline-store'
import {
  activateProjectScheduleBaselineUseCase,
  captureProjectScheduleBaselineUseCase,
  readProjectScheduleBaselineUseCase,
} from '../../application/use-cases/project-schedule-baseline'

const scope = { workspaceId: 'w', teamId: 't', projectId: 'p' }

/** Audit context of the captures. */
const auditContext = createMutationAuditContext({
  workspaceId: 'w',
  actor: { id: 'manager', kind: 'user', displayName: 'Manager' },
  idempotencyKey: 'key',
  request: { method: 'POST', path: '/x', body: {} },
  source: { kind: 'api' },
})

test('rejects an older snapshot when another capture committed while it read the plan', async () => {
  const store = new InMemoryProjectScheduleBaselineStore()
  let interleaved = false
  const slowCapture = captureProjectScheduleBaselineUseCase({
    store,
    async readTeamWorkItems() {
      if (!interleaved) {
        interleaved = true
        await captureProjectScheduleBaselineUseCase(
          {
            store,
            async readTeamWorkItems() {
              return [{ id: 'a', assignedProjectId: 'p', schedule: createDefaultDueDateWorkItemSchedule('2026-12-20') }]
            },
          },
          scope,
          { capturedAt: '2026-11-19T00:00:02.000Z', callerAuthorization: [], auditContext },
        )
      }
      return [{ id: 'a', assignedProjectId: 'p', schedule: createDefaultDueDateWorkItemSchedule('2026-12-10') }]
    },
  }, scope, { capturedAt: '2026-11-19T00:00:01.000Z', callerAuthorization: [], auditContext })

  await expect(slowCapture).rejects.toMatchObject({ status: 409 })
  expect((await store.get('w', 't', 'p'))?.entries).toEqual([{ workItemId: 'a', endDate: '2026-12-20' }])
})

test('captures only the Work Items of the Project', async () => {
  const store = new InMemoryProjectScheduleBaselineStore()
  const response = await captureProjectScheduleBaselineUseCase({
    store,
    async readTeamWorkItems() {
      return [
        { id: 'a', assignedProjectId: 'p', schedule: createDefaultDueDateWorkItemSchedule('2026-12-10') },
        { id: 'b', assignedProjectId: 'other', schedule: createDefaultDueDateWorkItemSchedule('2026-12-11') },
      ]
    },
  }, scope, { capturedAt: '2026-11-19T00:00:00.000Z', callerAuthorization: [], auditContext })
  expect(response.baseline?.entries).toEqual([{ workItemId: 'a', endDate: '2026-12-10' }])
})

test('records the first capture and each replacement as separate audit events', async () => {
  const store = new InMemoryProjectScheduleBaselineStore()
  const dependencies = {
    store,
    async readTeamWorkItems() {
      return [{ id: 'a', assignedProjectId: 'p', schedule: createDefaultDueDateWorkItemSchedule('2026-12-10') }]
    },
  }
  await captureProjectScheduleBaselineUseCase(dependencies, scope, { capturedAt: '2026-11-19T00:00:00.000Z', callerAuthorization: [], auditContext })
  await captureProjectScheduleBaselineUseCase(dependencies, scope, { capturedAt: '2026-11-20T00:00:00.000Z', callerAuthorization: [], auditContext })
  expect(store.auditEvents).toEqual([
    { eventType: 'project.schedule_baseline_captured', projectId: 'p', actorId: 'manager', revision: 1 },
    { eventType: 'project.schedule_baseline_replaced', projectId: 'p', actorId: 'manager', revision: 2 },
  ])
})

/**
 * Builds dependencies whose Project has one Work Item with the given plan and numbered IDs.
 *
 * @param store - Baseline store.
 * @param plan - Reads the current plan of the Work Item.
 * @returns The dependencies.
 */
function namedDependencies(
  store: InMemoryProjectScheduleBaselineStore,
  plan: () => { endDate: string; effort?: number },
) {
  let next = 0
  return {
    store,
    createBaselineId: () => `b${++next}`,
    async readTeamWorkItems() {
      const { endDate, effort } = plan()
      return [{
        id: 'a',
        assignedProjectId: 'p',
        schedule: { ...createDefaultDueDateWorkItemSchedule(endDate), ...(effort === undefined ? {} : { plannedEffortMinutes: effort }) },
      }]
    },
  }
}

test('keeps earlier named baselines and switches the active one', async () => {
  const store = new InMemoryProjectScheduleBaselineStore()
  let endDate = '2026-12-10'
  const dependencies = namedDependencies(store, () => ({ endDate, effort: 480 }))
  const write = { callerAuthorization: [], auditContext }
  const first = await captureProjectScheduleBaselineUseCase(dependencies, scope, { ...write, capturedAt: '2026-11-19T00:00:00.000Z', name: '計画承認' })
  expect(first.baseline).toMatchObject({ id: 'b1', name: '計画承認', entries: [{ workItemId: 'a', endDate: '2026-12-10', plannedEffortMinutes: 480 }] })
  endDate = '2026-12-20'
  const second = await captureProjectScheduleBaselineUseCase(dependencies, scope, { ...write, capturedAt: '2026-11-20T00:00:00.000Z' })
  expect(second.activeBaselineId).toBe('b2')
  expect(second.savedBaselines.map((item) => item.id)).toEqual(['b2', 'b1'])

  const readable = () => true
  const old = await readProjectScheduleBaselineUseCase(dependencies, scope, readable, 'b1')
  expect(old).toMatchObject({ activeBaselineId: 'b2', baseline: { id: 'b1', entries: [{ endDate: '2026-12-10' }] } })

  await expect(activateProjectScheduleBaselineUseCase(dependencies, scope, { baselineId: 'b1', expectedRevision: 1 }, { ...write, capturedAt: '2026-11-21T00:00:00.000Z' }))
    .rejects.toMatchObject({ status: 409 })
  const switched = await activateProjectScheduleBaselineUseCase(dependencies, scope, { baselineId: 'b1', expectedRevision: 2 }, { ...write, capturedAt: '2026-11-21T00:00:00.000Z' })
  expect(switched).toMatchObject({ activeBaselineId: 'b1', baseline: { id: 'b1', revision: 3, capturedAt: '2026-11-19T00:00:00.000Z' } })
  // Focus and the views read the active row, which now holds the first plan.
  expect(await store.get('w', 't', 'p')).toMatchObject({ id: 'b1', revision: 3, entries: [{ endDate: '2026-12-10' }] })
  expect(store.auditEvents.map((event) => event.eventType)).toEqual([
    'project.schedule_baseline_captured',
    'project.schedule_baseline_replaced',
    'project.schedule_baseline_activated',
  ])
  await expect(activateProjectScheduleBaselineUseCase(dependencies, scope, { baselineId: 'missing', expectedRevision: 3 }, { ...write, capturedAt: '2026-11-21T00:00:00.000Z' }))
    .rejects.toMatchObject({ status: 404 })
  await expect(readProjectScheduleBaselineUseCase(dependencies, scope, readable, 'missing')).rejects.toMatchObject({ status: 404 })
})

test('drops the oldest saved baseline beyond the limit', async () => {
  const store = new InMemoryProjectScheduleBaselineStore()
  const dependencies = namedDependencies(store, () => ({ endDate: '2026-12-10' }))
  const write = { callerAuthorization: [], auditContext, capturedAt: '2026-11-04T00:00:00.000Z' }
  let response = await captureProjectScheduleBaselineUseCase(dependencies, scope, write)
  for (let index = 0; index < PROJECT_SCHEDULE_BASELINE_MAX_SAVED; index += 1) {
    response = await captureProjectScheduleBaselineUseCase(dependencies, scope, write)
  }
  expect(response.savedBaselines).toHaveLength(PROJECT_SCHEDULE_BASELINE_MAX_SAVED)
  expect(response.savedBaselines[0]?.id).toBe(`b${PROJECT_SCHEDULE_BASELINE_MAX_SAVED + 1}`)
  expect(response.savedBaselines.map((item) => item.id)).not.toContain('b1')
  expect(await store.getSaved('w', 't', 'p', 'b1')).toBeNull()
  // Switching keeps the list as it is.
  const switched = await activateProjectScheduleBaselineUseCase(
    dependencies,
    scope,
    { baselineId: 'b2', expectedRevision: PROJECT_SCHEDULE_BASELINE_MAX_SAVED + 1 },
    write,
  )
  expect(switched.savedBaselines).toEqual(response.savedBaselines)
})

test('keeps a baseline saved before named baselines under a legacy ID', async () => {
  const store = new InMemoryProjectScheduleBaselineStore()
  // A row written by the first version has no ID, name, or saved list.
  await store.write({
    ...scope,
    kind: 'capture',
    writtenAt: '2026-11-01T00:00:00.000Z',
    baseline: { id: 'ignored', revision: 1, capturedAt: '2026-11-01T00:00:00.000Z', entries: [{ workItemId: 'a', endDate: '2026-12-01' }] },
    expectedRevision: 0,
    savedBaselines: [],
    savedRowsToPut: [],
    savedIdsToDelete: [],
    previous: null,
    callerAuthorization: [],
    auditContext,
  })
  const legacyRow = await store.get('w', 't', 'p')
  if (!legacyRow) throw new Error('missing')
  Reflect.deleteProperty(legacyRow, 'id')
  Reflect.set(store, 'baselines', new Map([[JSON.stringify(['w', 't', 'p']), legacyRow]]))

  const dependencies = namedDependencies(store, () => ({ endDate: '2026-12-10' }))
  const legacyRead = await readProjectScheduleBaselineUseCase(dependencies, scope, () => true)
  expect(legacyRead).toMatchObject({ activeBaselineId: 'legacy-r1', baseline: { id: 'legacy-r1' }, savedBaselines: [{ id: 'legacy-r1' }] })

  const captured = await captureProjectScheduleBaselineUseCase(dependencies, scope, { capturedAt: '2026-11-20T00:00:00.000Z', callerAuthorization: [], auditContext })
  expect(captured.savedBaselines.map((item) => item.id)).toEqual(['b1', 'legacy-r1'])
  expect(await store.getSaved('w', 't', 'p', 'legacy-r1')).toMatchObject({ entries: [{ endDate: '2026-12-01' }] })
})
