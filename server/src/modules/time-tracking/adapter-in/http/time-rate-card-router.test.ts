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

/** Caller and Workspace settings a fixture router runs with. */
type FixtureScope = {
  /** Authenticated caller's member key. */
  userKey: string
  /** Whether the caller manages time in the Team at all. */
  canManage: boolean
  /** Whether the caller manages every Project of the Team. */
  wholeTeam: boolean
  /** Workspace currency; absent leaves the router's default. */
  defaultCurrency?: string
}

/**
 * Creates a router over one in-memory service whose caller can be switched between requests.
 *
 * @param initial - Caller and settings of the first requests.
 * @returns The router, its service, and a setter for the caller.
 */
function createFixture(initial: FixtureScope) {
  let scope = initial
  const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    createId: (() => {
      let id = 0
      return () => `id-${++id}`
    })(),
  })
  const router = createTimeTrackingRouter({
    readBearerAccessToken: (context) => context.req.header('Authorization')?.replace(/^Bearer\s+/u, ''),
    authenticate: async () => ({ directoryId: 'workspace-1', userKey: scope.userKey }),
    requireWrite: () => {},
    requireTeamPermission: async () => {},
    listTimeTrackingTeams: async () => [],
    canManageRates: async () => scope.canManage,
    getAccessibleProjectIds: async () => undefined,
    canManageWholeTeam: async () => scope.wholeTeam,
    getManagedProjectIds: async () => undefined,
    ...(initial.defaultCurrency ? { readDefaultCurrency: async () => scope.defaultCurrency ?? 'JPY' } : {}),
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
  return {
    router,
    service,
    /** Switches the caller of later requests. */
    setScope(next: FixtureScope) {
      scope = next
    },
  }
}

const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' }
const manager: FixtureScope = { userKey: 'manager-1', canManage: true, wholeTeam: true }
const member: FixtureScope = { userKey: 'member-1', canManage: false, wholeTeam: false }

/**
 * Saves a rate card through the router.
 *
 * @param router - Router under test.
 * @param body - Request body.
 * @returns The HTTP response.
 */
async function putRateCard(router: ReturnType<typeof createFixture>['router'], body: Record<string, unknown>) {
  return await router.request('/api/teams/team-1/time-rate-card', { method: 'PUT', headers, body: JSON.stringify(body) })
}

/**
 * Creates an hour of time for the current caller.
 *
 * @param router - Router under test.
 * @param extra - Extra body fields.
 * @returns The HTTP response.
 */
async function createHour(router: ReturnType<typeof createFixture>['router'], extra: Record<string, unknown> = {}) {
  return await router.request('/api/teams/team-1/time-entries', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      workItemId: 'work-item-1',
      startAt: '2026-08-03T00:00:00.000Z',
      endAt: '2026-08-03T01:30:00.000Z',
      billable: true,
      ...extra,
    }),
  })
}

describe('time rate card routes', () => {
  test('an unsaved Team reads an empty card in the Workspace currency', async () => {
    const { router } = createFixture(manager)
    const response = await router.request('/api/teams/team-1/time-rate-card', { headers })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      rateCard: {
        schemaVersion: 1,
        workspaceId: 'workspace-1',
        teamId: 'team-1',
        currency: 'JPY',
        memberRates: [],
        jobRoleRates: [],
        revision: 0,
      },
    })
    const settings = await router.request('/api/teams/team-1/time-tracking/settings', { headers })
    expect(await settings.json()).toEqual({ defaultCurrency: 'JPY', canManageRateCard: true })
  })

  test('a member rate wins over the job role rate, and a member does not see the applied rate', async () => {
    const { router, service, setScope } = createFixture(manager)
    const saved = await putRateCard(router, {
      currency: 'JPY',
      memberRates: [
        { userId: 'member-1', jobRoleId: 'role-engineer' },
        { userId: 'member-2', hourlyRateMinor: 9_000, jobRoleId: 'role-engineer' },
      ],
      jobRoleRates: [{ jobRoleId: 'role-engineer', hourlyRateMinor: 6_000 }],
      expectedRevision: 0,
    })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toMatchObject({ rateCard: { revision: 1, updatedBy: 'manager-1' } })

    setScope(member)
    const created = await createHour(router)
    expect(created.status).toBe(201)
    const createdBody: { entry: Record<string, unknown> } = await created.json()
    expect(createdBody.entry.hourlyRateMinor).toBeUndefined()
    expect(createdBody.entry.actualCostMinor).toBeUndefined()
    expect(createdBody.entry.currency).toBe('JPY')
    const stored = await service.getEntry('workspace-1', 'team-1', String(createdBody.entry.id))
    expect(stored).toMatchObject({ hourlyRateMinor: 6_000, actualCostMinor: 9_000, currency: 'JPY' })

    // The member cannot move the hidden rate to another currency.
    const recurrency = await router.request(`/api/teams/team-1/time-entries/${String(createdBody.entry.id)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ currency: 'USD', expectedRevision: 1 }),
    })
    expect(recurrency.status).toBe(403)
    expect(await recurrency.json()).toMatchObject({ code: 'ConfidentialRateDenied' })

    setScope({ ...member, userKey: 'member-2' })
    const own = await createHour(router)
    const ownBody: { entry: Record<string, unknown> } = await own.json()
    expect(await service.getEntry('workspace-1', 'team-1', String(ownBody.entry.id))).toMatchObject({
      hourlyRateMinor: 9_000,
      actualCostMinor: 13_500,
    })
  })

  test('a rate the manager types wins over the card, and members outside the card get no rate', async () => {
    const { router, service, setScope } = createFixture(manager)
    await putRateCard(router, {
      currency: 'USD',
      memberRates: [{ userId: 'manager-1', hourlyRateMinor: 10_000 }],
      jobRoleRates: [],
      expectedRevision: 0,
    })
    const typed = await createHour(router, { hourlyRateMinor: 2_000 })
    expect(await typed.json()).toMatchObject({ entry: { hourlyRateMinor: 2_000, actualCostMinor: 3_000, currency: 'JPY' } })

    setScope(member)
    const unlisted = await createHour(router)
    const unlistedBody: { entry: Record<string, unknown> } = await unlisted.json()
    const stored = await service.getEntry('workspace-1', 'team-1', String(unlistedBody.entry.id))
    expect(stored.hourlyRateMinor).toBeUndefined()
    expect(stored.currency).toBe('JPY')
  })

  test('the card applies to a stopped timer and brings its currency', async () => {
    const { router } = createFixture(manager)
    await putRateCard(router, {
      currency: 'USD',
      memberRates: [{ userId: 'manager-1', hourlyRateMinor: 5_000 }],
      jobRoleRates: [],
      expectedRevision: 0,
    })
    const started = await router.request('/api/teams/team-1/timers', {
      method: 'POST',
      headers,
      body: JSON.stringify({ workItemId: 'work-item-1', billable: true, startedAt: '2026-08-02T11:00:00.000Z' }),
    })
    expect(started.status).toBe(201)
    const { timer }: { timer: { id: string } } = await started.json()
    const stopped = await router.request(`/api/time-tracking/timers/${timer.id}/stop`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })
    expect(stopped.status).toBe(200)
    expect(await stopped.json()).toMatchObject({ entry: { hourlyRateMinor: 5_000, actualCostMinor: 5_000, currency: 'USD' } })
  })

  test('only a manager of the whole Team reads or changes the card', async () => {
    const { router, setScope } = createFixture({ userKey: 'manager-2', canManage: true, wholeTeam: false })
    const read = await router.request('/api/teams/team-1/time-rate-card', { headers })
    expect(read.status).toBe(403)
    expect(await read.json()).toMatchObject({ code: 'TimeRateCardDenied' })
    const write = await putRateCard(router, { currency: 'JPY', memberRates: [], jobRoleRates: [], expectedRevision: 0 })
    expect(write.status).toBe(403)
    const settings = await router.request('/api/teams/team-1/time-tracking/settings', { headers })
    expect(await settings.json()).toMatchObject({ canManageRateCard: false })

    setScope(member)
    expect((await router.request('/api/teams/team-1/time-rate-card', { headers })).status).toBe(403)
  })

  test('invalid rows and stale revisions are rejected', async () => {
    const { router } = createFixture(manager)
    const duplicate = await putRateCard(router, {
      currency: 'JPY',
      memberRates: [{ userId: 'member-1', hourlyRateMinor: 1 }, { userId: 'member-1', hourlyRateMinor: 2 }],
      jobRoleRates: [],
      expectedRevision: 0,
    })
    expect(duplicate.status).toBe(400)
    expect(await duplicate.json()).toMatchObject({ code: 'InvalidTimeRateCard' })
    const empty = await putRateCard(router, {
      currency: 'JPY',
      memberRates: [{ userId: 'member-1' }],
      jobRoleRates: [],
      expectedRevision: 0,
    })
    expect(empty.status).toBe(400)
    const negative = await putRateCard(router, {
      currency: 'JPY',
      memberRates: [],
      jobRoleRates: [{ jobRoleId: 'role-1', hourlyRateMinor: -1 }],
      expectedRevision: 0,
    })
    expect(negative.status).toBe(400)
    const badCurrency = await putRateCard(router, { currency: 'Y1N', memberRates: [], jobRoleRates: [], expectedRevision: 0 })
    expect(await badCurrency.json()).toMatchObject({ code: 'InvalidCurrency' })
    const unknownCurrency = await putRateCard(router, { currency: 'ZZZ', memberRates: [], jobRoleRates: [], expectedRevision: 0 })
    expect(await unknownCurrency.json()).toMatchObject({ code: 'InvalidCurrency' })

    expect((await putRateCard(router, { currency: 'JPY', memberRates: [], jobRoleRates: [], expectedRevision: 0 })).status).toBe(200)
    const stale = await putRateCard(router, { currency: 'JPY', memberRates: [], jobRoleRates: [], expectedRevision: 0 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'TimeRateCardRevisionConflict' })
  })

  test('new entries and budgets take the Workspace currency when the request names none', async () => {
    const { router } = createFixture({ ...manager, defaultCurrency: 'EUR' })
    const created = await createHour(router)
    expect(await created.json()).toMatchObject({ entry: { currency: 'EUR' } })
    const budget = await router.request('/api/teams/team-1/time-budget', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ amountMinor: 100_000, expectedRevision: 0 }),
    })
    expect(await budget.json()).toMatchObject({ budget: { currency: 'EUR' } })
    const settings = await router.request('/api/teams/team-1/time-tracking/settings', { headers })
    expect(await settings.json()).toMatchObject({ defaultCurrency: 'EUR' })
  })

})
