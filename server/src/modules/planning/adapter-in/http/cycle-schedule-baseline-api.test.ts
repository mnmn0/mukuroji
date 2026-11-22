import { afterEach, expect, test } from 'bun:test'
import {
  CYCLE_SCHEDULE_BASELINE_MAX_SAVED,
  parseCycleScheduleBaselineResponse,
  type CycleScheduleBaselineResponse,
} from '@mukuroji/contracts'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import { InMemoryCycleScheduleBaselineStore } from '../..'
import { InMemoryPlanningClient } from '../../planning'

const {
  configureFakeProjectClients,
  createCyclePlanningInput,
  planningApiRequest,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/**
 * Creates a Cycle with one linked Work Item as a Project manager.
 *
 * @returns The baseline store the routes use.
 */
async function seedCycleWithWorkItem() {
  configureFakeProjectClients(true, { role: 'manager', workspaceRole: 'member' })
  const store = new InMemoryCycleScheduleBaselineStore()
  setTestAppDependencies({ planning: new InMemoryPlanningClient(), cycleScheduleBaselines: store })
  expect((await planningApiRequest('/api/planning/entities', 'POST', createCyclePlanningInput('cycle-a', 0))).status).toBe(201)
  const linked = await planningApiRequest('/api/planning/work-item-links/core-team/onboarding-friction', 'PUT', {
    teamId: 'core-team',
    workItemId: 'onboarding-friction',
    projectId: 'refero',
    cycleId: 'cycle-a',
    goalIds: [],
    expectedRevision: 1,
  })
  expect(linked.status).toBe(200)
  return store
}

/**
 * Reads and validates a Cycle baseline response body.
 *
 * @param response - HTTP response.
 * @returns The parsed body.
 */
async function readBaselineBody(response: Response): Promise<CycleScheduleBaselineResponse> {
  const body = parseCycleScheduleBaselineResponse(await response.json())
  if (!body) throw new Error('Cycle baseline response is malformed.')
  return body
}

test('a Cycle manager saves named Cycle baselines that freeze the Cycle Work Items, with an audit event', async () => {
  const store = await seedCycleWithWorkItem()
  const path = '/api/planning/cycles/cycle-a/schedule-baselines'

  const empty = await readBaselineBody(await planningApiRequest(path))
  expect(empty).toEqual({ cycleId: 'cycle-a', revision: 0, baseline: null, savedBaselines: [] })

  const saved = await planningApiRequest(path, 'POST', { name: '  Sprint start  ' })
  expect(saved.status).toBe(201)
  const body = await readBaselineBody(saved)
  expect(body.revision).toBe(1)
  expect(body.baseline).toMatchObject({ name: 'Sprint start', entryCount: 1 })
  expect(body.baseline?.entries).toEqual([expect.objectContaining({ teamId: 'core-team', workItemId: 'onboarding-friction' })])
  expect(store.auditEvents).toEqual([
    expect.objectContaining({ eventType: 'cycle.schedule_baseline_captured', cycleId: 'cycle-a', revision: 1 }),
  ])

  const second = await readBaselineBody(await planningApiRequest(path, 'POST', {}))
  expect(second.savedBaselines.map((item) => item.name)).toEqual([undefined, 'Sprint start'])

  const firstId = body.baseline?.id
  const older = await readBaselineBody(await planningApiRequest(`${path}?baselineId=${firstId}`))
  expect(older.baseline?.name).toBe('Sprint start')
  const newest = await readBaselineBody(await planningApiRequest(path))
  expect(newest.baseline?.id).toBe(second.baseline?.id)
  expect((await planningApiRequest(`${path}?baselineId=missing`)).status).toBe(404)
  expect((await planningApiRequest(`${path}?baselineId=bad%20id`)).status).toBe(400)
})

test('keeps at most the saved limit of Cycle baselines, dropping the oldest', async () => {
  await seedCycleWithWorkItem()
  const path = '/api/planning/cycles/cycle-a/schedule-baselines'
  for (let index = 0; index <= CYCLE_SCHEDULE_BASELINE_MAX_SAVED; index += 1) {
    expect((await planningApiRequest(path, 'POST', { name: `B${index}` })).status).toBe(201)
  }
  const body = await readBaselineBody(await planningApiRequest(path))
  expect(body.revision).toBe(CYCLE_SCHEDULE_BASELINE_MAX_SAVED + 1)
  expect(body.savedBaselines).toHaveLength(CYCLE_SCHEDULE_BASELINE_MAX_SAVED)
  expect(body.savedBaselines[0]?.name).toBe(`B${CYCLE_SCHEDULE_BASELINE_MAX_SAVED}`)
  expect(body.savedBaselines.some((item) => item.name === 'B0')).toBe(false)
})

test('rejects invalid names, non-Cycle entities, and callers who do not manage the Cycle', async () => {
  await seedCycleWithWorkItem()
  const path = '/api/planning/cycles/cycle-a/schedule-baselines'
  expect((await planningApiRequest(path, 'POST', { name: 'bad\u0007name' })).status).toBe(400)
  expect((await planningApiRequest(path, 'POST', { name: 'x'.repeat(81) })).status).toBe(400)
  expect((await planningApiRequest('/api/planning/cycles/missing/schedule-baselines', 'POST', {})).status).toBe(404)
  expect((await planningApiRequest('/api/planning/cycles/missing/schedule-baselines')).status).toBe(404)

  configureFakeProjectClients(false, {
    workspaceRole: 'member',
    role: 'viewer',
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }],
  })
  expect((await planningApiRequest(path, 'POST', {})).status).toBe(403)
  expect((await planningApiRequest(path)).status).toBe(200)
})
