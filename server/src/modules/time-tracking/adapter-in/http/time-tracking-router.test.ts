import { describe, expect, test } from 'bun:test'
import { createTimeTrackingRouter } from './time-tracking-router'
import {
  InMemoryTimeTrackingRepository,
  TimeTrackingError,
  TimeTrackingService,
} from '../../time-tracking'

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
    requireTeamPermission: async () => {},
    canManageRates: async () => canManageRates,
    getAccessibleProjectIds: async () => undefined,
    verifyProject: async () => {},
    verifyWorkItem: async () => {},
    getTimeTracking: () => service,
    readJson: async (request) => await request.json(),
    mapError: (context, error) => {
      if (error instanceof TimeTrackingError) {
        return context.json({ code: error.code, message: error.message }, error.status as 400 | 403 | 404 | 409 | 500)
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
})
