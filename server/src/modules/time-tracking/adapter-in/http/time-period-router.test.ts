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
function createFixture(scope: { canManage: boolean; wholeTeam: boolean }) {
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
    canManageRates: async () => scope.canManage,
    getAccessibleProjectIds: async () => undefined,
    canManageWholeTeam: async () => scope.wholeTeam,
    getManagedProjectIds: async () => undefined,
    verifyProject: async () => {},
    verifyWorkItem: async () => undefined,
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
    expect(await listedAfter.json()).toEqual({ closedPeriods: [] })
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
})
