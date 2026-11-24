import { describe, expect, test } from 'bun:test'
import { createTimeTrackingRouter } from './time-tracking-router'
import {
  InMemoryTimeTrackingRepository,
  TimeTrackingError,
  TimeTrackingService,
} from '../../time-tracking'

/** Converts a domain status to the HTTP status values accepted by Hono. */
function toHttpStatus(status: number): 400 | 403 | 404 | 409 | 500 {
  return status === 400 || status === 403 || status === 404 || status === 409 ? status : 500
}

/**
 * Creates a router whose caller is `manager-1`, with a configurable management scope.
 *
 * @param scope - Whether the caller manages time at all, and whether it manages the whole Team.
 * @returns The router and its service.
 */
function createFixture(scope: { canManage: boolean; wholeTeam: boolean; workspaceAdmin?: boolean; teamIds?: string[] }) {
  const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    createId: (() => {
      let id = 0
      return () => `id-${++id}`
    })(),
  })
  const router = createTimeTrackingRouter({
    readBearerAccessToken: (context) => context.req.header('Authorization')?.replace(/^Bearer\s+/u, ''),
    authenticate: async () => ({ directoryId: 'workspace-1', userKey: 'manager-1' }),
    requireWrite: () => {},
    requireTeamPermission: async () => {},
    listTimeTrackingTeams: async () => [],
    canManageRates: async () => scope.canManage,
    getAccessibleProjectIds: async () => undefined,
    canManageWholeTeam: async () => scope.wholeTeam,
    canManageWorkspacePeriods: async () => scope.workspaceAdmin === true,
    listWorkspaceTeams: async () => (scope.teamIds ?? ['team-1', 'team-2']).map((teamId) => ({ teamId, name: `Name ${teamId}` })),
    getManagedProjectIds: async () => undefined,
    verifyProject: async () => {},
    verifyWorkItem: async () => undefined,
    createAuthorizationConditionChecks: () => [],
    getTimeTracking: () => service,
    readJson: async (request) => await request.json(),
    mapError: (context, error) => {
      if (error instanceof TimeTrackingError) {
        return context.json({ code: error.code, message: error.message }, toHttpStatus(error.status))
      }
      throw error
    },
  })
  return { router, service }
}

const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' }

describe('time period close routes', () => {
  test('a Team manager closes, lists, and reopens a month with a reason', async () => {
    const { router } = createFixture({ canManage: true, wholeTeam: true })
    const closed = await router.request('/api/teams/team-1/time-periods/2026-07/close', {
      method: 'POST',
      headers,
      body: JSON.stringify({ timeZone: 'Asia/Tokyo' }),
    })
    expect(closed.status).toBe(201)
    expect(await closed.json()).toMatchObject({ period: { month: '2026-07', timeZone: 'Asia/Tokyo', closedBy: 'manager-1' } })

    const listed = await router.request('/api/teams/team-1/time-periods', { headers })
    expect(await listed.json()).toMatchObject({ closedPeriods: [{ month: '2026-07' }] })

    const blocked = await router.request('/api/teams/team-1/time-entries', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workItemId: 'work-item-1', date: '2026-07-31', minutes: 60, timeZone: 'Asia/Tokyo', billable: false }),
    })
    expect(blocked.status).toBe(409)
    expect(await blocked.json()).toMatchObject({ code: 'TimePeriodClosed' })

    const withoutReason = await router.request('/api/teams/team-1/time-periods/2026-07/reopen', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(withoutReason.status).toBe(400)
    expect(await withoutReason.json()).toMatchObject({ code: 'ReopenReasonRequired' })

    const reopened = await router.request('/api/teams/team-1/time-periods/2026-07/reopen', {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Late client meeting' }),
    })
    expect(reopened.status).toBe(200)
    const listedAfter = await router.request('/api/teams/team-1/time-periods', { headers })
    expect(await listedAfter.json()).toMatchObject({ closedPeriods: [] })
  })

  test('only a manager of the whole Team may close or reopen a month', async () => {
    for (const scope of [{ canManage: false, wholeTeam: false }, { canManage: true, wholeTeam: false }]) {
      const { router } = createFixture(scope)
      for (const action of ['close', 'reopen']) {
        const response = await router.request(`/api/teams/team-1/time-periods/2026-07/${action}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ reason: 'x' }),
        })
        expect(response.status).toBe(403)
        expect(await response.json()).toMatchObject({ code: 'TimePeriodCloseDenied' })
      }
    }
  })

  test('a manager returns an approved entry with a reason', async () => {
    const { router, service } = createFixture({ canManage: true, wholeTeam: true })
    const entry = await service.createEntry({
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      workItemId: 'work-item-1',
      userId: 'member-1',
      startAt: '2026-08-01T01:00:00.000Z',
      endAt: '2026-08-01T02:00:00.000Z',
      billable: false,
      currency: 'JPY',
      source: 'manual',
    }, false)
    const base = { workspaceId: 'workspace-1', teamId: 'team-1', entryId: entry.id }
    const submitted = await service.transitionEntry({ ...base, actorUserId: 'member-1', canApprove: false, expectedRevision: 1, action: 'submit' })
    const approved = await service.transitionEntry({ ...base, actorUserId: 'manager-1', canApprove: true, expectedRevision: submitted.revision, action: 'approve' })

    const missingReason = await router.request(`/api/teams/team-1/time-entries/${entry.id}/return`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedRevision: approved.revision }),
    })
    expect(missingReason.status).toBe(400)
    expect(await missingReason.json()).toMatchObject({ code: 'ReturnReasonRequired' })

    const returned = await router.request(`/api/teams/team-1/time-entries/${entry.id}/return`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ expectedRevision: approved.revision, reason: 'Wrong Work Item' }),
    })
    expect(returned.status).toBe(200)
    expect(await returned.json()).toMatchObject({ entry: { status: 'rejected' } })
  })

  test('the Team list tells whether the caller may close the Team', async () => {
    const { router } = createFixture({ canManage: true, wholeTeam: false, workspaceAdmin: true })
    const listed = await router.request('/api/teams/team-1/time-periods', { headers })
    expect(await listed.json()).toEqual({ closedPeriods: [], canManagePeriods: false })
  })

  test('a Workspace administrator closes and reopens a month for every Team', async () => {
    const { router, service } = createFixture({ canManage: false, wholeTeam: false, workspaceAdmin: true })
    await service.closePeriod({ workspaceId: 'workspace-1', teamId: 'team-2', month: '2026-07', timeZone: 'Asia/Tokyo', actorUserId: 'manager-1' })

    const closed = await router.request('/api/time-periods/2026-07/close', {
      method: 'POST',
      headers,
      body: JSON.stringify({ timeZone: 'Asia/Tokyo' }),
    })
    expect(closed.status).toBe(200)
    expect(await closed.json()).toEqual({
      month: '2026-07',
      results: [{ teamId: 'team-1', status: 'closed' }, { teamId: 'team-2', status: 'already-closed' }],
      partialFailure: false,
    })

    const state = await router.request('/api/time-periods/2026-07', { headers })
    expect(await state.json()).toMatchObject({
      month: '2026-07',
      teams: [
        { teamId: 'team-1', name: 'Name team-1', close: { month: '2026-07' } },
        { teamId: 'team-2', name: 'Name team-2', close: { month: '2026-07' } },
      ],
    })

    const blocked = await router.request('/api/teams/team-1/time-entries', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workItemId: 'work-item-1', date: '2026-07-31', minutes: 60, timeZone: 'Asia/Tokyo', billable: false }),
    })
    expect(blocked.status).toBe(409)

    const withoutReason = await router.request('/api/time-periods/2026-07/reopen', { method: 'POST', headers, body: JSON.stringify({}) })
    expect(withoutReason.status).toBe(400)
    expect(await withoutReason.json()).toMatchObject({ code: 'ReopenReasonRequired' })

    await service.reopenPeriod({ workspaceId: 'workspace-1', teamId: 'team-2', month: '2026-07', actorUserId: 'manager-1', reason: 'fix' })
    const reopened = await router.request('/api/time-periods/2026-07/reopen', {
      method: 'POST',
      headers,
      body: JSON.stringify({ reason: 'Late corrections' }),
    })
    expect(await reopened.json()).toEqual({
      month: '2026-07',
      results: [{ teamId: 'team-1', status: 'reopened' }, { teamId: 'team-2', status: 'not-closed' }],
      partialFailure: false,
    })
  })

  test('a Team manager who is not a Workspace administrator cannot close every Team', async () => {
    const { router, service } = createFixture({ canManage: true, wholeTeam: true, workspaceAdmin: false })
    for (const path of ['/api/time-periods/2026-07/close', '/api/time-periods/2026-07/reopen']) {
      const response = await router.request(path, { method: 'POST', headers, body: JSON.stringify({ timeZone: 'UTC', reason: 'x' }) })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'WorkspaceTimePeriodCloseDenied' })
    }
    const state = await router.request('/api/time-periods/2026-07', { headers })
    expect(state.status).toBe(403)
    expect(await service.listClosedPeriods('workspace-1', 'team-1')).toEqual([])
  })

  test('a Workspace close rejects an invalid month before closing any Team', async () => {
    const { router, service } = createFixture({ canManage: false, wholeTeam: false, workspaceAdmin: true })
    const response = await router.request('/api/time-periods/2026-13/close', { method: 'POST', headers, body: JSON.stringify({ timeZone: 'UTC' }) })
    expect(response.status).toBe(400)
    expect(await service.listClosedPeriods('workspace-1', 'team-1')).toEqual([])
  })

  test('a Team that fails is reported and the other Teams are still closed', async () => {
    /** Repository whose close of `team-1` fails like an unavailable table. */
    class FailingTeamRepository extends InMemoryTimeTrackingRepository {
      /** Fails the close of `team-1` and stores the others. */
      override async createPeriodClose(...args: Parameters<InMemoryTimeTrackingRepository['createPeriodClose']>) {
        if (args[0].teamId === 'team-1') throw new Error('table unavailable')
        await super.createPeriodClose(...args)
      }
    }
    const service = new TimeTrackingService(new FailingTeamRepository(), { now: () => new Date('2026-08-02T12:00:00.000Z') })
    const originalError = console.error
    const logs: unknown[] = []
    console.error = (line: unknown) => { logs.push(line) }
    try {
      expect(await service.closeWorkspacePeriod({
        workspaceId: 'workspace-1',
        teamIds: ['team-2', 'team-1', 'team-2'],
        month: '2026-07',
        timeZone: 'UTC',
        actorUserId: 'admin-1',
        correlationId: 'correlation-1',
      })).toEqual({
        month: '2026-07',
        results: [{ teamId: 'team-1', status: 'failed' }, { teamId: 'team-2', status: 'closed' }],
        partialFailure: true,
      })
    } finally {
      console.error = originalError
    }
    // The log names the failed Team and the request, and leaves out the error message.
    expect(logs.map((line) => JSON.parse(String(line)))).toEqual([{
      event: 'workspace-time-period.team-failed',
      action: 'close',
      workspaceId: 'workspace-1',
      teamId: 'team-1',
      month: '2026-07',
      correlationId: 'correlation-1',
      errorCode: 'UnexpectedError',
    }])
    expect(await service.listClosedPeriods('workspace-1', 'team-2')).toMatchObject([{ month: '2026-07' }])
  })
})
