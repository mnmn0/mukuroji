import { describe, expect, test } from 'bun:test'
import {
  CapacityPlanningError,
  CapacityPlanningService,
  InMemoryCapacityPlanningRepository,
  type CapacityPlanningDataSource,
} from '../../capacity-planning'
import {
  createCapacityPlanningRouter,
  type CapacityPlanningRouterDependencies,
} from './capacity-planning-router'

type TestPrincipal = {
  /** Canonical Workspace identifier. */
  directoryId: string
  /** Canonical Workspace member key. */
  userKey: string
}

const principal: TestPrincipal = { directoryId: 'workspace-1', userKey: 'member-1' }

const emptyDataSource: CapacityPlanningDataSource = {
  listTimeEntries: async () => [],
  listEstimates: async () => [],
}

/** Creates a router with deterministic authentication and an in-memory service. */
function createFixture(options: { allowManager?: boolean } = {}) {
  const calls: string[] = []
  const service = new CapacityPlanningService(
    new InMemoryCapacityPlanningRepository(),
    emptyDataSource,
    { now: () => new Date('2026-08-02T12:00:00.000Z'), createId: () => 'capacity-id-1' },
  )
  const dependencies: CapacityPlanningRouterDependencies<TestPrincipal> = {
    readBearerAccessToken: (context) => context.req.header('Authorization')?.replace(/^Bearer\s+/u, ''),
    authenticate: async (accessToken) => {
      calls.push(`authenticate:${accessToken}`)
      return principal
    },
    requireTeamPermission: async (_value, teamId, minimum) => {
      calls.push(`permission:${teamId}:${minimum}`)
      if (minimum === 'manager' && options.allowManager === false) {
        throw new CapacityPlanningError(403, 'PermissionDenied', 'manager required')
      }
    },
    canViewConfidential: async () => false,
    getVisibleMemberIds: async () => undefined,
    getVisibleProjectIds: async () => undefined,
    canManageMember: async (_value, _teamId, memberId) => memberId === principal.userKey,
    verifyProject: async () => undefined,
    verifyWorkItem: async () => undefined,
    getCapacityPlanning: () => service,
    readJson: async (request) => await request.json(),
    mapError: (context, error) => context.json({
      code: error instanceof CapacityPlanningError ? error.code : 'mapped',
    }, 503),
  }
  return { calls, router: createCapacityPlanningRouter(dependencies) }
}

describe('createCapacityPlanningRouter', () => {
  test('requires a bearer token and applies viewer permission to workload reads', async () => {
    const { calls, router } = createFixture()
    const unauthorized = await router.request('/api/teams/team-1/workload?from=2026-08-03&to=2026-08-03&granularity=day')
    const authorized = await router.request('/api/teams/team-1/workload?from=2026-08-03&to=2026-08-03&granularity=day', {
      headers: { Authorization: 'Bearer workload-token' },
    })

    expect(unauthorized.status).toBe(401)
    expect(authorized.status).toBe(200)
    expect(calls).toEqual(['authenticate:workload-token', 'permission:team-1:viewer'])
  })

  test('requires manager permission for resource requests', async () => {
    const { calls, router } = createFixture()
    const response = await router.request('/api/teams/team-1/workload/requests', {
      method: 'POST',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Launch support',
        skillIds: ['support'],
        fromDate: '2026-08-03',
        toDate: '2026-08-07',
        requestedMinutes: 480,
        confidential: false,
        expectedTeamRevision: 0,
      }),
    })

    expect(response.status).toBe(201)
    expect(calls).toEqual(['authenticate:workload-token', 'permission:team-1:manager'])
  })

  test('rejects an assignment to another member before calling the service', async () => {
    const { calls, router } = createFixture()
    const response = await router.request('/api/teams/team-1/workload/assignments', {
      method: 'POST',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberId: 'member-2' }),
    })

    expect(response.status).toBe(503)
    expect(calls).toEqual(['authenticate:workload-token', 'permission:team-1:manager'])
  })

  test('does not let a member approve their own time off', async () => {
    const { calls, router } = createFixture({ allowManager: false })
    const response = await router.request('/api/teams/team-1/workload/profiles/member-1/time-off/time-off-1', {
      method: 'PUT',
      headers: { Authorization: 'Bearer workload-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fromDate: '2026-08-03',
        toDate: '2026-08-03',
        status: 'approved',
        expectedRevision: 1,
        expectedTeamRevision: 0,
      }),
    })

    expect(response.status).toBe(503)
    expect(calls).toEqual([
      'authenticate:workload-token',
      'permission:team-1:member',
      'permission:team-1:manager',
    ])
  })
})
