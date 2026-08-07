import { afterEach, describe, expect, test } from 'bun:test'
import {
  archivePlanningEntity,
  createPlanningDependency,
  createPlanningEntity,
  createWorkItemScheduleDependency,
  deletePlanningDependency,
  deletePlanningWorkItemLink,
  deleteWorkItemScheduleDependency,
  duplicatePlanningEntity,
  getPlanningSnapshot,
  movePlanningEntity,
  PlanningApiError,
  putPlanningWorkItemLink,
  resolvePlanningErrorMessageKey,
  rolloverPlanningCycle,
  updatePlanningEntity,
  updateWorkItemScheduleDependency,
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

  test('creates, updates, and deletes canonical cross-Team Work Item dependencies', async () => {
    const requests = installFetchRecorder(planningSnapshotFixture)

    await createWorkItemScheduleDependency('access-token', {
      expectedRevision: 12,
      id: 'edge/1',
      predecessor: { teamId: 'team/a', workItemId: 'item/a' },
      successor: { teamId: 'team/b', workItemId: 'item/b' },
      type: 'start-to-finish',
      lagDays: -2,
      constraint: { anchor: 'finish', date: '2026-08-01', kind: 'not-after' },
    }, mutationContext)
    await updateWorkItemScheduleDependency('access-token', 'edge/1', {
      expectedRevision: 13,
      patch: { constraint: null, lagDays: 3 },
    }, mutationContext)
    await deleteWorkItemScheduleDependency('access-token', 'edge/1', {
      expectedRevision: 14,
    }, mutationContext)

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['POST', '/api/planning/work-item-dependencies'],
      ['PATCH', '/api/planning/work-item-dependencies/edge%2F1'],
      ['DELETE', '/api/planning/work-item-dependencies/edge%2F1'],
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toMatchObject({
      lagDays: -2,
      type: 'start-to-finish',
    })
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      expectedRevision: 13,
      patch: { constraint: null, lagDays: 3 },
    })
  })

  test('rejects a malformed successful dependency mutation response at the API boundary', async () => {
    installFetchRecorder({ revision: 13 })

    await expect(deleteWorkItemScheduleDependency('access-token', 'edge', {
      expectedRevision: 12,
    }, mutationContext)).rejects.toMatchObject({ code: 'InvalidPlanningSnapshot' })
  })

  test('rejects malformed nested dependency summary data at the API boundary', async () => {
    installFetchRecorder({
      ...planningSnapshotFixture,
      workItemDependencySummary: {
        ...planningSnapshotFixture.workItemDependencySummary,
        criticalPath: { workItems: [] },
      },
    })

    await expect(getPlanningSnapshot('access-token')).rejects.toMatchObject({
      code: 'InvalidPlanningSnapshot',
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
    expect(resolvePlanningErrorMessageKey(error)).toBe('planning.conflict')
    expect(resolvePlanningErrorMessageKey(
      new PlanningApiError(403, 'raw authorization detail', 'PlanningAuthorizationChanged'),
      'mutation',
    )).toBe('planning.conflict')
    expect(resolvePlanningErrorMessageKey(
      new PlanningApiError(409, 'Entity already exists.', 'PlanningEntityExists'),
      'mutation',
    )).toBe('planning.mutationError')
    expect(resolvePlanningErrorMessageKey(new Error('raw API detail'))).toBe('planning.error')
    expect(resolvePlanningErrorMessageKey(new Error('raw API detail'), 'mutation'))
      .toBe('planning.mutationError')
  })

  test('keeps the HTTP status and fallback when an error message is malformed', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      code: 'PlanningUnavailable',
      message: { internal: 'do not display' },
    }), { status: 503 })) as typeof fetch

    const error = await getPlanningSnapshot('token').catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(PlanningApiError)
    expect(error).toMatchObject({
      code: undefined,
      message: 'Unable to complete the planning request.',
      status: 503,
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
