import { afterEach, describe, expect, test } from 'bun:test'
import {
  archivePlanningEntity,
  createPlanningDependency,
  createPlanningEntity,
  deletePlanningDependency,
  deletePlanningWorkItemLink,
  duplicatePlanningEntity,
  getPlanningSnapshot,
  movePlanningEntity,
  PlanningApiError,
  putPlanningWorkItemLink,
  rolloverPlanningCycle,
  updatePlanningEntity,
} from '../src/planning/api'
import { planningSnapshotFixture } from '../src/planning/fixtures'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-planning',
  idempotencyKey: 'idempotency-planning',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Planning API', () => {
  test('loads a Workspace planning snapshot with authorization', async () => {
    const requests = installFetchRecorder(planningSnapshotFixture)

    await expect(getPlanningSnapshot('access-token')).resolves.toEqual(planningSnapshotFixture)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/planning')
    expect(requests[0]?.init.headers).toMatchObject({ Authorization: 'Bearer access-token' })
  })

  test('uses stable mutation headers for entity lifecycle endpoints', async () => {
    const requests = installFetchRecorder(planningSnapshotFixture)
    const entityInput = {
      id: 'goal/new',
      type: 'goal' as const,
      title: 'New goal',
      ownerMemberKey: 'owner@example.com',
      status: 'planned' as const,
      health: 'unknown' as const,
      risk: 'low' as const,
      progressMode: 'automatic' as const,
      baseline: { startDate: '2026-08-01', endDate: '2026-09-01' },
      forecast: { startDate: '2026-08-01', endDate: '2026-09-01' },
      expectedRevision: 12,
    }

    await expect(createPlanningEntity('access-token', entityInput, mutationContext))
      .resolves.toEqual(planningSnapshotFixture)
    await updatePlanningEntity('access-token', 'goal/new', {
      expectedRevision: 12,
      patch: { title: 'Updated goal' },
    }, mutationContext)
    await archivePlanningEntity('access-token', 'goal/new', {
      expectedRevision: 12,
    }, mutationContext)
    await duplicatePlanningEntity('access-token', 'goal/new', {
      expectedRevision: 12,
      targetId: 'goal/copy',
    }, mutationContext)
    await movePlanningEntity('access-token', 'goal/new', {
      expectedRevision: 12,
      parentId: 'portfolio/product',
    }, mutationContext)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/planning/entities'],
      ['PATCH', '/api/planning/entities/goal%2Fnew'],
      ['POST', '/api/planning/entities/goal%2Fnew/archive'],
      ['POST', '/api/planning/entities/goal%2Fnew/duplicate'],
      ['POST', '/api/planning/entities/goal%2Fnew/move'],
    ])
    for (const request of requests) {
      expect(request.init.headers).toMatchObject({
        Authorization: 'Bearer access-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'idempotency-planning',
        'X-Correlation-Id': 'correlation-planning',
      })
    }
  })

  test('mutates dependencies, Work Item links, and cycle rollover through encoded paths', async () => {
    const requests = installFetchRecorder((url) =>
      url.endsWith('/rollover') ? createMutationResponse() : planningSnapshotFixture,
    )

    await createPlanningDependency('access-token', {
      id: 'dependency/1',
      predecessorId: 'phase/1',
      successorId: 'milestone/1',
      type: 'finish-to-start',
      lagDays: 0,
      expectedRevision: 12,
    }, mutationContext)
    await deletePlanningDependency('access-token', 'dependency/1', {
      expectedRevision: 12,
    }, mutationContext)
    await putPlanningWorkItemLink('access-token', 'core/team', 'work/item', {
      teamId: 'core/team',
      workItemId: 'work/item',
      projectId: 'refero',
      cycleId: 'cycle-14',
      milestoneId: 'milestone-beta',
      goalIds: ['goal-activation'],
      expectedRevision: 12,
    }, mutationContext)
    await deletePlanningWorkItemLink('access-token', 'core/team', 'work/item', {
      expectedRevision: 12,
    }, mutationContext)
    await expect(rolloverPlanningCycle('access-token', 'cycle/14', {
      targetCycleId: 'cycle-15',
      expectedRevision: 12,
    }, mutationContext)).resolves.toEqual(createMutationResponse())

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/planning/dependencies'],
      ['DELETE', '/api/planning/dependencies/dependency%2F1'],
      ['PUT', '/api/planning/work-item-links/core%2Fteam/work%2Fitem'],
      ['DELETE', '/api/planning/work-item-links/core%2Fteam/work%2Fitem'],
      ['POST', '/api/planning/cycles/cycle%2F14/rollover'],
    ])
    expect(JSON.parse(String(requests[4]?.init.body))).toEqual({
      targetCycleId: 'cycle-15',
      expectedRevision: 12,
    })
  })

  test('preserves stable conflict codes and readable fallback messages', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'PlanningRevisionConflict',
      message: 'Planning graph changed.',
    }), { status: 409 })) as typeof fetch

    const error = await archivePlanningEntity('token', 'goal', {
      expectedRevision: 1,
    }, mutationContext).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(PlanningApiError)
    expect(error).toMatchObject({
      code: 'PlanningRevisionConflict',
      message: 'Planning graph changed.',
      status: 409,
    })
  })
})

function createMutationResponse() {
  return {
    planning: planningSnapshotFixture,
    movedWorkItemIds: [],
    retainedWorkItemIds: [],
  }
}

function installFetchRecorder(responseBody: unknown | ((url: string) => unknown)) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
      init,
    })
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    return new Response(JSON.stringify(
      typeof responseBody === 'function' ? responseBody(url) : responseBody,
    ), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch
  return requests
}
