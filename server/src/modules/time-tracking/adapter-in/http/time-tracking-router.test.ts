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

  test('records a categorized date-and-minutes entry and groups the summary by category', async () => {
    const { router } = createFixture()
    const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' }
    const created = await router.request('/api/teams/team-1/time-entries', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        workItemId: 'work-item-1',
        date: '2026-08-03',
        minutes: 120,
        timeZone: 'Asia/Tokyo',
        category: 'meeting',
        billable: false,
      }),
    })
    expect(created.status).toBe(201)
    const { entry } = await created.json() as { entry: Record<string, unknown> }
    expect(entry).toMatchObject({ startAt: '2026-08-02T15:00:00.000Z', durationMinutes: 120, durationOnly: true, category: 'meeting' })

    const cleared = await router.request(`/api/teams/team-1/time-entries/${String(entry.id)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ expectedRevision: 1, category: null }),
    })
    expect(cleared.status).toBe(200)
    expect((await cleared.json() as { entry: Record<string, unknown> }).entry.category).toBeUndefined()

    const summary = await router.request(
      '/api/teams/team-1/time-tracking/summary?from=2026-08-03&to=2026-08-09&timeZone=Asia/Tokyo&groupBy=category',
      { headers },
    )
    expect(summary.status).toBe(200)
    expect(await summary.json()).toMatchObject({ groupBy: 'category', groups: [{ key: 'uncategorized', minutes: 120 }] })

    const invalid: unknown[] = [
      { workItemId: 'work-item-1', date: '2026-08-03', minutes: 60, category: 'lunch', billable: false },
      { workItemId: 'work-item-1', date: '2026-08-03', billable: false },
      { workItemId: 'work-item-1', date: '2026-08-03', minutes: 60, startAt: '2026-08-03T00:00:00.000Z', billable: false },
    ]
    for (const body of invalid) {
      const response = await router.request('/api/teams/team-1/time-entries', { method: 'POST', headers, body: JSON.stringify(body) })
      expect(response.status).toBe(400)
    }
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
    const entry = readEntryRef(await created.json())

    const mutations: Array<[string, string, unknown]> = [
      ['POST', '/api/teams/team-1/time-entries', draftBody('work-item-p1')],
      ['PATCH', `/api/teams/team-1/time-entries/${entry.id}`, { expectedRevision: entry.revision, billable: false }],
      ['POST', `/api/teams/team-1/time-entries/${entry.id}/submit`, { expectedRevision: entry.revision }],
      ['POST', `/api/teams/team-1/time-entries/${entry.id}/approve`, { expectedRevision: entry.revision }],
      ['POST', '/api/teams/team-1/timesheet/approve', { from: '2026-08-01', to: '2026-08-03' }],
      ['POST', '/api/teams/team-1/timers', { workItemId: 'work-item-p1', billable: false }],
      ['POST', '/api/time-tracking/timers/timer-1/stop', {}],
      ['DELETE', '/api/time-tracking/timers/timer-1', undefined],
      ['DELETE', `/api/teams/team-1/time-entries/${entry.id}?expectedRevision=${entry.revision}`, undefined],
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

  test('decides who manages an entry from its stored Project, not its Work Item', async () => {
    const fixture = createProjectFixture()
    const entry = await createDraft(fixture.router, 'bob', 'work-item-p2')
    fixture.workItemProjects['work-item-p2'] = 'project-1'

    const response = await requestAs(fixture.router, 'alice', 'PATCH', `/api/teams/team-1/time-entries/${entry.id}`, {
      expectedRevision: entry.revision,
      billable: false,
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'TimeEntryAccessDenied' })
  })

  test('rejects an edit that targets a revision newer than the one authorized', async () => {
    const fixture = createProjectFixture()
    const entry = await createDraft(fixture.router, 'bob', 'work-item-p1')
    fixture.hooks.beforeVerifyWorkItem = async () => {
      await fixture.service.updateEntry({
        workspaceId: 'workspace-1',
        teamId: 'team-1',
        entryId: entry.id,
        actorUserId: 'bob',
        canManageRates: false,
        expectedRevision: entry.revision,
        workItemId: 'work-item-p2',
        projectId: 'project-2',
      })
    }

    const response = await requestAs(fixture.router, 'alice', 'PATCH', `/api/teams/team-1/time-entries/${entry.id}`, {
      expectedRevision: entry.revision + 1,
      billable: false,
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'TimeEntryRevisionConflict' })
    expect((await fixture.service.getEntry('workspace-1', 'team-1', entry.id)).billable).toBe(true)
  })

  test('does not let a Project manager approve another member entry without a Project', async () => {
    const fixture = createProjectFixture()
    const entry = await createDraft(fixture.router, 'bob', 'work-item-none')
    const submitted = await requestAs(fixture.router, 'bob', 'POST', `/api/teams/team-1/time-entries/${entry.id}/submit`, {
      expectedRevision: entry.revision,
    })
    expect(submitted.status).toBe(200)
    const submittedEntry = readEntryRef(await submitted.json())

    const approved = await requestAs(fixture.router, 'alice', 'POST', `/api/teams/team-1/time-entries/${entry.id}/approve`, {
      expectedRevision: submittedEntry.revision,
    })
    expect(approved.status).toBe(403)
    expect(await approved.json()).toMatchObject({ code: 'TimesheetApprovalDenied' })
  })

  test('lists other users entries and history only from the Projects the manager manages', async () => {
    const fixture = createProjectFixture()
    const managed = await createDraft(fixture.router, 'bob', 'work-item-p1')
    const unmanaged = await createDraft(fixture.router, 'bob', 'work-item-p2')
    const aliceOwn = await createDraft(fixture.router, 'alice', 'work-item-p2')

    const everyone = await requestAs(fixture.router, 'alice', 'GET', '/api/teams/team-1/time-entries')
    expect(everyone.status).toBe(200)
    expect(readEntryIds(await everyone.json())).toEqual([managed.id])

    const bob = await requestAs(fixture.router, 'alice', 'GET', '/api/teams/team-1/time-entries?userId=bob')
    expect(readEntryIds(await bob.json())).toEqual([managed.id])

    const self = await requestAs(fixture.router, 'alice', 'GET', '/api/teams/team-1/time-entries?userId=alice')
    expect(readEntryIds(await self.json())).toEqual([aliceOwn.id])

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

  test('records a meeting without a Work Item and carries it through submit, approval, and reports', async () => {
    const fixture = createProjectFixture()
    const meetingBody = { category: 'meeting', projectId: 'project-1', date: '2026-08-03', minutes: 120, timeZone: 'Asia/Tokyo', billable: false }
    const created = await requestAs(fixture.router, 'bob', 'POST', '/api/teams/team-1/time-entries', meetingBody)
    expect(created.status).toBe(201)
    const { entry } = await created.json() as { entry: Record<string, unknown> }
    expect(entry).toMatchObject({ projectId: 'project-1', category: 'meeting', durationMinutes: 120, durationOnly: true, status: 'draft' })
    expect(entry.workItemId).toBeUndefined()

    const withoutCategory = await requestAs(fixture.router, 'bob', 'POST', '/api/teams/team-1/time-entries', { ...meetingBody, category: undefined })
    expect(withoutCategory.status).toBe(400)
    expect(await withoutCategory.json()).toMatchObject({ code: 'TimeEntryCategoryRequired' })
    const otherProject = await requestAs(fixture.router, 'bob', 'POST', '/api/teams/team-1/time-entries', { ...meetingBody, projectId: 'project-3' })
    expect(otherProject.status).toBe(403)

    const submitted = await requestAs(fixture.router, 'bob', 'POST', `/api/teams/team-1/time-entries/${String(entry.id)}/submit`, { expectedRevision: 1 })
    expect(submitted.status).toBe(200)
    const approved = await requestAs(fixture.router, 'alice', 'POST', `/api/teams/team-1/time-entries/${String(entry.id)}/approve`, { expectedRevision: 2 })
    expect(approved.status).toBe(200)
    const history = await requestAs(fixture.router, 'alice', 'GET', `/api/teams/team-1/time-entries/${String(entry.id)}/history`)
    expect(history.status).toBe(200)

    const period = 'from=2026-08-03&to=2026-08-09&timeZone=Asia/Tokyo'
    const byWorkItem = await requestAs(fixture.router, 'alice', 'GET', `/api/teams/team-1/time-tracking/summary?${period}&groupBy=work-item`)
    expect(await byWorkItem.json()).toMatchObject({ totalMinutes: 120, groups: [{ key: 'no-work-item', label: 'No Work Item', minutes: 120 }] })
    const csv = await requestAs(fixture.router, 'alice', 'GET', `/api/teams/team-1/time-tracking/export?${period}&groupBy=category`)
    expect(await csv.text()).toContain('meeting,120,0,1')
  })

  test('turns a Work Item entry into indirect work only when it keeps a category', async () => {
    const fixture = createProjectFixture()
    const draft = await createDraft(fixture.router, 'bob', 'work-item-p1')
    const path = `/api/teams/team-1/time-entries/${draft.id}`
    const uncategorized = await requestAs(fixture.router, 'bob', 'PATCH', path, { expectedRevision: draft.revision, workItemId: null })
    expect(uncategorized.status).toBe(400)
    expect(await uncategorized.json()).toMatchObject({ code: 'TimeEntryCategoryRequired' })

    const indirect = await requestAs(fixture.router, 'bob', 'PATCH', path, { expectedRevision: draft.revision, workItemId: null, category: 'management' })
    expect(indirect.status).toBe(200)
    const { entry } = await indirect.json() as { entry: Record<string, unknown> }
    expect(entry).toMatchObject({ projectId: 'project-1', category: 'management' })
    expect(entry.workItemId).toBeUndefined()

    const deniedProject = await requestAs(fixture.router, 'bob', 'PATCH', path, { expectedRevision: entry.revision, projectId: 'project-3' })
    expect(deniedProject.status).toBe(403)
    const moved = await requestAs(fixture.router, 'bob', 'PATCH', path, { expectedRevision: entry.revision, projectId: 'project-2' })
    expect(moved.status).toBe(200)
    expect((await moved.json() as { entry: Record<string, unknown> }).entry.projectId).toBe('project-2')
  })

  test('keeps a date-and-minutes entry when an edit repeats its times or sends new minutes', async () => {
    const { router } = createFixture()
    const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' }
    const created = await router.request('/api/teams/team-1/time-entries', {
      method: 'POST',
      headers,
      body: JSON.stringify({ category: 'meeting', date: '2026-08-03', minutes: 60, timeZone: 'Asia/Tokyo', billable: false }),
    })
    const { entry } = await created.json() as { entry: { id: string; startAt: string; endAt: string } }
    /** Patches the entry and returns the updated entry. */
    const patch = async (body: Record<string, unknown>) => {
      const response = await router.request(`/api/teams/team-1/time-entries/${entry.id}`, { method: 'PATCH', headers, body: JSON.stringify(body) })
      expect(response.status).toBe(200)
      return (await response.json() as { entry: Record<string, unknown> }).entry
    }

    expect(await patch({ expectedRevision: 1, startAt: entry.startAt, endAt: entry.endAt, description: 'Weekly sync' }))
      .toMatchObject({ durationOnly: true, durationMinutes: 60, description: 'Weekly sync' })
    expect(await patch({ expectedRevision: 2, date: '2026-08-04', minutes: 90, timeZone: 'Asia/Tokyo' }))
      .toMatchObject({ durationOnly: true, durationMinutes: 90, startAt: '2026-08-03T15:00:00.000Z' })
    const timed = await patch({ expectedRevision: 3, startAt: '2026-08-04T01:00:00.000Z', endAt: '2026-08-04T02:00:00.000Z' })
    expect(timed.durationOnly).toBeUndefined()
  })

  test('lets only the owner delete a draft or rejected entry', async () => {
    const fixture = createProjectFixture()
    /** Deletes an entry as one fixture user at a revision. */
    const remove = (userKey: string, entryId: string, revision?: number) => requestAs(
      fixture.router,
      userKey,
      'DELETE',
      `/api/teams/team-1/time-entries/${entryId}${revision === undefined ? '' : `?expectedRevision=${revision}`}`,
    )

    const draft = await createDraft(fixture.router, 'bob', 'work-item-p1')
    expect((await remove('alice', draft.id, draft.revision)).status).toBe(403)
    expect((await remove('guest', draft.id, draft.revision)).status).toBe(403)
    expect((await remove('bob', draft.id)).status).toBe(400)
    expect((await remove('bob', draft.id, draft.revision + 1)).status).toBe(409)
    expect((await remove('bob', draft.id, draft.revision)).status).toBe(204)
    expect((await remove('bob', draft.id, draft.revision)).status).toBe(404)
    const listed = await requestAs(fixture.router, 'bob', 'GET', '/api/teams/team-1/time-entries')
    expect(readEntryIds(await listed.json())).not.toContain(draft.id)

    const submitted = await createDraft(fixture.router, 'bob', 'work-item-p1')
    await requestAs(fixture.router, 'bob', 'POST', `/api/teams/team-1/time-entries/${submitted.id}/submit`, { expectedRevision: 1 })
    const notDeletable = await remove('bob', submitted.id, 2)
    expect(notDeletable.status).toBe(409)
    expect(await notDeletable.json()).toMatchObject({ code: 'TimeEntryNotDeletable' })
    await requestAs(fixture.router, 'alice', 'POST', `/api/teams/team-1/time-entries/${submitted.id}/approve`, { expectedRevision: 2 })
    expect((await remove('bob', submitted.id, 3)).status).toBe(409)

    const rejected = await createDraft(fixture.router, 'bob', 'work-item-p1')
    await requestAs(fixture.router, 'bob', 'POST', `/api/teams/team-1/time-entries/${rejected.id}/submit`, { expectedRevision: 1 })
    await requestAs(fixture.router, 'alice', 'POST', `/api/teams/team-1/time-entries/${rejected.id}/reject`, { expectedRevision: 2, reason: 'Duplicate' })
    expect((await remove('bob', rejected.id, 3)).status).toBe(204)
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
  const workItemProjects: Record<string, string | null> = {
    'work-item-p1': 'project-1',
    'work-item-p2': 'project-2',
    'work-item-none': null,
  }
  const hooks: { beforeVerifyWorkItem?: () => Promise<void> } = {}
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
      const hook = hooks.beforeVerifyWorkItem
      hooks.beforeVerifyWorkItem = undefined
      await hook?.()
      const projectId = workItemProjects[workItemId]
      if (projectId === undefined) throw deny()
      if (projectId === null) {
        if (projectsWith(principal.userKey, minimum).size === 0) throw deny()
        return undefined
      }
      if (!projectsWith(principal.userKey, minimum).has(projectId)) throw deny()
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
  return { router, service, workItemProjects, hooks }
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
  return readEntryRef(await response.json())
}

/**
 * Reads the ID and revision of the entry in a single-entry response.
 *
 * @param body - Parsed JSON response body.
 * @returns The entry ID and revision.
 */
function readEntryRef(body: unknown): { id: string; revision: number } {
  const entry = isFixtureRecord(body) ? body.entry : undefined
  if (!isFixtureRecord(entry) || typeof entry.id !== 'string' || typeof entry.revision !== 'number') {
    throw new Error('The response does not contain a time entry.')
  }
  return { id: entry.id, revision: entry.revision }
}

/**
 * Reads the entry IDs of a list response.
 *
 * @param body - Parsed JSON response body.
 * @returns Entry IDs in response order.
 */
function readEntryIds(body: unknown): string[] {
  const entries = isFixtureRecord(body) ? body.entries : undefined
  if (!Array.isArray(entries)) throw new Error('The response does not contain an entry list.')
  return entries.map((entry: unknown) => {
    if (!isFixtureRecord(entry) || typeof entry.id !== 'string') throw new Error('The entry list contains an invalid entry.')
    return entry.id
  })
}

/**
 * Checks whether a parsed JSON value is an object record.
 *
 * @param value - Value to check.
 * @returns `true` for a non-array object.
 */
function isFixtureRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
