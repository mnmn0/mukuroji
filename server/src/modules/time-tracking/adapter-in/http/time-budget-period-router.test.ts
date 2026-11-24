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
 * Creates a router over one in-memory service for a manager of the whole Team.
 *
 * @returns The router.
 */
function createFixture() {
  const service = new TimeTrackingService(new InMemoryTimeTrackingRepository(), {
    now: () => new Date('2026-08-02T12:00:00.000Z'),
    createId: (() => {
      let id = 0
      return () => `id-${++id}`
    })(),
  })
  return createTimeTrackingRouter({
    readBearerAccessToken: (context) => context.req.header('Authorization')?.replace(/^Bearer\s+/u, ''),
    authenticate: async () => ({ directoryId: 'workspace-1', userKey: 'manager-1' }),
    requireWrite: () => {},
    requireTeamPermission: async () => {},
    listTimeTrackingTeams: async () => [],
    canManageRates: async () => true,
    getAccessibleProjectIds: async () => undefined,
    canManageWholeTeam: async () => true,
    canManageWorkspacePeriods: async () => false,
    listWorkspaceTeams: async () => [],
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
}

const headers = { Authorization: 'Bearer token', 'Content-Type': 'application/json' }

/**
 * Saves a Project budget through the router.
 *
 * @param router - Router under test.
 * @param body - Request body.
 * @returns The HTTP response.
 */
async function putProjectBudget(router: ReturnType<typeof createFixture>, body: Record<string, unknown>) {
  return await router.request('/api/teams/team-1/projects/project-1/time-budget', { method: 'PUT', headers, body: JSON.stringify(body) })
}

/**
 * Reads the Project budget of a report period.
 *
 * @param router - Router under test.
 * @param from - Inclusive local start.
 * @param to - Inclusive local end.
 * @returns The parsed summary.
 */
async function readSummary(router: ReturnType<typeof createFixture>, from: string, to: string): Promise<Record<string, unknown>> {
  const response = await router.request(
    `/api/teams/team-1/time-tracking/summary?from=${from}&to=${to}&timeZone=Asia/Tokyo&budgetScope=project&projectId=project-1`,
    { headers },
  )
  expect(response.status).toBe(200)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null) throw new Error('summary is not an object')
  return Object.fromEntries(Object.entries(body))
}

describe('budgets per period', () => {
  test('the report compares the budget of exactly its period and otherwise the default budget', async () => {
    const router = createFixture()
    expect((await putProjectBudget(router, { amountMinor: 1_000_000, currency: 'JPY', expectedRevision: 0 })).status).toBe(200)
    const fiscal2026 = await putProjectBudget(router, {
      amountMinor: 600_000,
      currency: 'JPY',
      periodFrom: '2026-04-01',
      periodTo: '2027-03-31',
      periodBudget: true,
      expectedRevision: 0,
    })
    expect(fiscal2026.status).toBe(200)
    expect(await fiscal2026.json()).toMatchObject({ budget: { periodBudget: true, revision: 1 } })
    expect((await putProjectBudget(router, {
      amountMinor: 700_000,
      currency: 'JPY',
      periodFrom: '2027-04-01',
      periodTo: '2028-03-31',
      periodBudget: true,
      expectedRevision: 0,
    })).status).toBe(200)

    const fiscal = await readSummary(router, '2026-04-01', '2027-03-31')
    expect(fiscal.budget).toMatchObject({ amountMinor: 600_000, periodBudget: true })
    expect(fiscal.budgetPeriods).toMatchObject([
      { periodFrom: '2026-04-01', periodTo: '2027-03-31' },
      { periodFrom: '2027-04-01', periodTo: '2028-03-31' },
    ])
    const month = await readSummary(router, '2026-08-01', '2026-08-31')
    expect(month.budget).toMatchObject({ amountMinor: 1_000_000 })
    expect(month.budget).not.toHaveProperty('periodBudget')
  })

  test('a period needs both dates, must not overlap another, and is deleted at its revision', async () => {
    const router = createFixture()
    const missing = await putProjectBudget(router, { amountMinor: 1, currency: 'JPY', periodFrom: '2026-04-01', periodBudget: true, expectedRevision: 0 })
    expect(await missing.json()).toMatchObject({ code: 'InvalidBudgetPeriod' })
    expect((await putProjectBudget(router, {
      amountMinor: 1, currency: 'JPY', periodFrom: '2026-04-01', periodTo: '2026-09-30', periodBudget: true, expectedRevision: 0,
    })).status).toBe(200)
    const overlap = await putProjectBudget(router, {
      amountMinor: 1, currency: 'JPY', periodFrom: '2026-09-01', periodTo: '2027-03-31', periodBudget: true, expectedRevision: 0,
    })
    expect(overlap.status).toBe(409)
    expect(await overlap.json()).toMatchObject({ code: 'TimeBudgetPeriodOverlap' })
    // Saving the same period again updates it rather than overlapping itself.
    expect((await putProjectBudget(router, {
      amountMinor: 2, currency: 'JPY', periodFrom: '2026-04-01', periodTo: '2026-09-30', periodBudget: true, expectedRevision: 1,
    })).status).toBe(200)

    const path = '/api/teams/team-1/projects/project-1/time-budget/periods/2026-04-01/2026-09-30'
    const stale = await router.request(`${path}?expectedRevision=1`, { method: 'DELETE', headers })
    expect(stale.status).toBe(409)
    expect((await router.request(`${path}?expectedRevision=2`, { method: 'DELETE', headers })).status).toBe(204)
    const gone = await router.request(`${path}?expectedRevision=2`, { method: 'DELETE', headers })
    expect(gone.status).toBe(404)
    const summary = await readSummary(router, '2026-04-01', '2026-09-30')
    expect(summary).not.toHaveProperty('budgetPeriods')
  })
})
