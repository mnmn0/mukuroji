import { describe, expect, test } from 'bun:test'
import { createTimeTrackingRouter } from './time-tracking-router'
import {
  InMemoryTimeTrackingRepository,
  TimeTrackingError,
  TimeTrackingService,
} from '../../time-tracking'

/** Converts a domain status to the HTTP status values accepted by Hono. */
function toTimeTrackingHttpStatus(status: number): 400 | 403 | 404 | 409 | 500 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 500:
      return status
    default:
      return 500
  }
}

/** Creates an isolated HTTP router fixture with deterministic authentication and storage. */
function createFixture(canManageRates = false) {
  const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    createId: (() => {
      let id = 0
      return () => `id-${++id}`
    })(),
  })
  const router = createTimeTrackingRouter({
    readBearerAccessToken: (context) => context.req.header('Authorization')?.replace(/^Bearer\s+/u, ''),
    authenticate: async () => ({ directoryId: 'workspace-1', userKey: 'member-1' }),
    requireWrite: () => {},
    requireTeamPermission: async () => {},
    canManageRates: async () => canManageRates,
    getAccessibleProjectIds: async () => undefined,
    getManagedProjectIds: async () => undefined,
    verifyProject: async () => {},
    verifyWorkItem: async () => undefined,
    getTimeTracking: () => service,
    readJson: async (request) => await request.json(),
    mapError: (context, error) => {
      if (error instanceof TimeTrackingError) {
        return context.json({ code: error.code, message: error.message }, toTimeTrackingHttpStatus(error.status))
      }
      throw error
    },
  })
  return { router, service }
}

describe('createTimeTrackingRouter', () => {
  test('requires authentication and redacts confidential fields for members', async () => {
    const member = createFixture()
    const unauthorized = await member.router.request('/api/teams/team-1/time-entries', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(unauthorized.status).toBe(401)

    const created = await member.router.request('/api/teams/team-1/time-entries', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workItemId: 'work-item-1',
        startAt: '2026-08-02T09:00:00.000Z',
        endAt: '2026-08-02T10:00:00.000Z',
        billable: true,
        currency: 'USD',
      }),
    })
    expect(created.status).toBe(201)
    const body = await created.json() as { entry: Record<string, unknown> }
    expect(body.entry.hourlyRateMinor).toBeUndefined()
    expect(body.entry.actualCostMinor).toBeUndefined()
  })

  test('allows managers to persist and read confidential rate data', async () => {
    const manager = createFixture(true)
    const created = await manager.router.request('/api/teams/team-1/time-entries', {
      method: 'POST',
      headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workItemId: 'work-item-1',
        startAt: '2026-08-02T09:00:00.000Z',
        endAt: '2026-08-02T10:00:00.000Z',
        billable: true,
        currency: 'USD',
        hourlyRateMinor: 4_000,
      }),
    })
    expect(created.status).toBe(201)
    const body = await created.json() as { entry: { hourlyRateMinor: number; actualCostMinor: number } }
    expect(body.entry).toMatchObject({ hourlyRateMinor: 4_000, actualCostMinor: 4_000 })
  })

  test('rejects every mutation for a principal without business write access', async () => {
    const fixture = createProjectFixture()
    const created = await requestAs(fixture.router, 'bob', 'POST', '/api/teams/team-1/time-entries', draftBody('work-item-p1'))
    expect(created.status).toBe(201)
    const { entry } = await created.json() as { entry: { id: string; revision: number } }

    const mutations: Array<[string, string, unknown]> = [
      ['POST', '/api/teams/team-1/time-entries', draftBody('work-item-p1')],
      ['PATCH', `/api/teams/team-1/time-entries/${entry.id}`, { expectedRevision: entry.revision, billable: false }],
      ['POST', `/api/teams/team-1/time-entries/${entry.id}/submit`, { expectedRevision: entry.revision }],
      ['POST', `/api/teams/team-1/time-entries/${entry.id}/approve`, { expectedRevision: entry.revision }],
      ['POST', '/api/teams/team-1/timesheet/approve', { from: '2026-08-01', to: '2026-08-03' }],
      ['POST', '/api/teams/team-1/timers', { workItemId: 'work-item-p1', billable: false }],
      ['POST', '/api/time-tracking/timers/timer-1/stop', {}],
      ['DELETE', '/api/time-tracking/timers/timer-1', undefined],
      ['PUT', '/api/teams/team-1/time-budget', { amountMinor: 1_000, expectedRevision: 0 }],
      ['PUT', '/api/teams/team-1/projects/project-1/time-budget', { amountMinor: 1_000, expectedRevision: 0 }],
    ]
    for (const [method, path, body] of mutations) {
      const response = await requestAs(fixture.router, 'guest', method, path, body)
      expect({ method, path, status: response.status }).toEqual({ method, path, status: 403 })
      expect(await response.json()).toMatchObject({ code: 'WorkspaceRoleDenied' })
    }

    const listed = await requestAs(fixture.router, 'guest', 'GET', '/api/teams/team-1/time-entries')
    expect(listed.status).toBe(200)
  })

  test('lets a manager of one Project edit only entries of the Projects they manage', async () => {
    const fixture = createProjectFixture()
    const own = await createDraft(fixture.router, 'bob', 'work-item-p1')
    const other = await createDraft(fixture.router, 'bob', 'work-item-p2')

    const deniedOtherProject = await requestAs(fixture.router, 'alice', 'PATCH', `/api/teams/team-1/time-entries/${other.id}`, {
      expectedRevision: other.revision,
      billable: false,
    })
    expect(deniedOtherProject.status).toBe(403)
    expect(await deniedOtherProject.json()).toMatchObject({ code: 'TimeEntryAccessDenied' })

    const movedIntoOtherProject = await requestAs(fixture.router, 'alice', 'PATCH', `/api/teams/team-1/time-entries/${own.id}`, {
      expectedRevision: own.revision,
      workItemId: 'work-item-p2',
    })
    expect(movedIntoOtherProject.status).toBe(403)

    const allowed = await requestAs(fixture.router, 'alice', 'PATCH', `/api/teams/team-1/time-entries/${own.id}`, {
      expectedRevision: own.revision,
      billable: false,
    })
    expect(allowed.status).toBe(200)
  })

  test('lists other users entries and history only from the Projects the manager manages', async () => {
    const fixture = createProjectFixture()
    const managed = await createDraft(fixture.router, 'bob', 'work-item-p1')
    const unmanaged = await createDraft(fixture.router, 'bob', 'work-item-p2')
    const aliceOwn = await createDraft(fixture.router, 'alice', 'work-item-p2')

    const everyone = await requestAs(fixture.router, 'alice', 'GET', '/api/teams/team-1/time-entries')
    expect(everyone.status).toBe(200)
    expect(((await everyone.json()) as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)).toEqual([managed.id])

    const bob = await requestAs(fixture.router, 'alice', 'GET', '/api/teams/team-1/time-entries?userId=bob')
    expect(((await bob.json()) as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)).toEqual([managed.id])

    const self = await requestAs(fixture.router, 'alice', 'GET', '/api/teams/team-1/time-entries?userId=alice')
    expect(((await self.json()) as { entries: Array<{ id: string }> }).entries.map((entry) => entry.id)).toEqual([aliceOwn.id])

    const deniedHistory = await requestAs(fixture.router, 'alice', 'GET', `/api/teams/team-1/time-entries/${unmanaged.id}/history`)
    expect(deniedHistory.status).toBe(403)
    const allowedHistory = await requestAs(fixture.router, 'alice', 'GET', `/api/teams/team-1/time-entries/${managed.id}/history`)
    expect(allowedHistory.status).toBe(200)
    const ownHistory = await requestAs(fixture.router, 'alice', 'GET', `/api/teams/team-1/time-entries/${aliceOwn.id}/history`)
    expect(ownHistory.status).toBe(200)
  })

  test('returns a Project budget only to a manager of that Project', async () => {
    const fixture = createProjectFixture()
    for (const projectId of ['project-1', 'project-2']) {
      await fixture.service.saveBudget({
        workspaceId: 'workspace-1',
        teamId: 'team-1',
        scopeType: 'project',
        scopeId: projectId,
        amountMinor: 50_000,
        currency: 'USD',
        expectedRevision: 0,
        updatedBy: 'admin',
      })
    }
    const summaryPath = (projectId: string) =>
      `/api/teams/team-1/time-tracking/summary?from=2026-08-01&to=2026-08-03&budgetScope=project&projectId=${projectId}`

    const unmanaged = await requestAs(fixture.router, 'alice', 'GET', summaryPath('project-2'))
    expect(unmanaged.status).toBe(200)
    expect(await unmanaged.json()).not.toHaveProperty('budget')

    const managed = await requestAs(fixture.router, 'alice', 'GET', summaryPath('project-1'))
    expect(managed.status).toBe(200)
    expect(await managed.json()).toMatchObject({ budget: { scopeId: 'project-1', amountMinor: 50_000 } })
  })
})

/** Project role held by a fixture user, keyed by Project ID. */
type FixtureProjectRoles = Record<string, 'viewer' | 'member' | 'manager'>

/**
 * Creates a router fixture with two Projects in one Team and per-user Project roles.
 *
 * `alice` manages project-1 and is a member of project-2, `bob` is a member of both,
 * and `guest` is a Workspace guest with the manager role on project-1.
 */
function createProjectFixture() {
  const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    createId: (() => {
      let id = 0
      return () => `id-${++id}`
    })(),
  })
  const roles: Record<string, FixtureProjectRoles> = {
    alice: { 'project-1': 'manager', 'project-2': 'member' },
    bob: { 'project-1': 'member', 'project-2': 'member' },
    guest: { 'project-1': 'manager' },
  }
  const workItemProjects: Record<string, string> = {
    'work-item-p1': 'project-1',
    'work-item-p2': 'project-2',
  }
  const rank = { viewer: 0, member: 1, manager: 2 } as const
  const projectsWith = (userKey: string, minimum: keyof typeof rank) =>
    new Set(Object.entries(roles[userKey] ?? {}).filter(([, role]) => rank[role] >= rank[minimum]).map(([projectId]) => projectId))
  const deny = () => new TimeTrackingError(403, 'ProjectAccessDenied', 'Access denied.')
  const router = createTimeTrackingRouter({
    readBearerAccessToken: (context) => context.req.header('Authorization')?.replace(/^Bearer\s+/u, ''),
    authenticate: async (accessToken) => ({ directoryId: 'workspace-1', userKey: accessToken }),
    requireWrite: (principal) => {
      if (principal.userKey === 'guest') {
        throw new TimeTrackingError(403, 'WorkspaceRoleDenied', 'Guest members have read-only Workspace access.')
      }
    },
    requireTeamPermission: async (principal, _teamId, minimum) => {
      if (projectsWith(principal.userKey, minimum).size === 0) throw deny()
    },
    canManageRates: async (principal) => projectsWith(principal.userKey, 'manager').size > 0,
    getAccessibleProjectIds: async (principal) => projectsWith(principal.userKey, 'viewer'),
    getManagedProjectIds: async (principal) => projectsWith(principal.userKey, 'manager'),
    verifyProject: async (principal, _teamId, projectId, minimum) => {
      if (!projectsWith(principal.userKey, minimum).has(projectId)) throw deny()
    },
    verifyWorkItem: async (principal, _teamId, workItemId, minimum = 'member') => {
      const projectId = workItemProjects[workItemId]
      if (!projectId || !projectsWith(principal.userKey, minimum).has(projectId)) throw deny()
      return projectId
    },
    getTimeTracking: () => service,
    readJson: async (request) => await request.json(),
    mapError: (context, error) => {
      if (error instanceof TimeTrackingError) {
        return context.json({ code: error.code, message: error.message }, toTimeTrackingHttpStatus(error.status))
      }
      throw error
    },
  })
  return { router, service }
}

/**
 * Sends a request as one fixture user.
 *
 * @param router - Router under test.
 * @param userKey - Fixture user, also used as the bearer token.
 * @param method - HTTP method.
 * @param path - Request path.
 * @param body - Optional JSON body.
 * @returns The router response.
 */
async function requestAs(
  router: ReturnType<typeof createTimeTrackingRouter>,
  userKey: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return await router.request(path, {
    method,
    headers: { Authorization: `Bearer ${userKey}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Builds a valid manual entry body for a Work Item.
 *
 * @param workItemId - Work Item that receives the time.
 * @returns The JSON request body.
 */
function draftBody(workItemId: string) {
  return {
    workItemId,
    startAt: '2026-08-02T09:00:00.000Z',
    endAt: '2026-08-02T10:00:00.000Z',
    billable: true,
    currency: 'USD',
  }
}

/**
 * Creates a draft entry as one fixture user.
 *
 * @param router - Router under test.
 * @param userKey - Entry owner.
 * @param workItemId - Work Item that receives the time.
 * @returns The created entry ID and revision.
 */
async function createDraft(
  router: ReturnType<typeof createTimeTrackingRouter>,
  userKey: string,
  workItemId: string,
): Promise<{ id: string; revision: number }> {
  const response = await requestAs(router, userKey, 'POST', '/api/teams/team-1/time-entries', draftBody(workItemId))
  expect(response.status).toBe(201)
  const { entry } = await response.json() as { entry: { id: string; revision: number } }
  return { id: entry.id, revision: entry.revision }
}
