import { createDefaultDueDateWorkItemSchedule } from '@mukuroji/contracts'
import { expect, test } from 'bun:test'
import { createMutationAuditContext } from '../../../audit'
import { InMemoryProjectScheduleBaselineStore } from './schedule-baseline-store'
import { captureProjectScheduleBaselineUseCase } from '../../application/use-cases/project-schedule-baseline'

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
