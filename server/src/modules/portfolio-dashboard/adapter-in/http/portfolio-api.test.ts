import { afterEach, expect, test } from 'bun:test'
import {
  parseTeamPortfolioResponse,
  parseTeamPortfolioSnapshotResponse,
  previousPortfolioMonth,
  type ProjectExpense,
  type TeamPortfolioResponse,
} from '@mukuroji/contracts'
import { createApiTestHarness } from '../../../../api/test-support/api-test-harness'
import { createMutationAuditContext } from '../../../audit'
import { InMemoryProjectExpenseStore } from '../../../project-budget'

const {
  app,
  configureFakeProjectClients,
  createAccessToken,
  getTestAppDependencies,
  resetTestApp,
  setTestAppDependencies,
} = createApiTestHarness()

afterEach(() => {
  resetTestApp()
})

/**
 * Sends an authenticated request.
 *
 * @param path - Request path.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @returns The response.
 */
function request(path: string, method = 'GET', body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${createAccessToken()}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/**
 * Reads the Team portfolio and validates it.
 *
 * @returns The parsed response.
 */
async function readPortfolio(): Promise<TeamPortfolioResponse> {
  const response = await request('/api/teams/core-team/portfolio?timeZone=UTC')
  expect(response.status).toBe(200)
  const parsed = parseTeamPortfolioResponse(await response.json())
  if (!parsed) throw new Error('The portfolio response is malformed.')
  return parsed
}

/** Projects of the fake Team in the access tests: the default Project and a second one. */
const teamProjects = [
  { id: 'refero', name: 'Refero', tone: 'blue' as const },
  { id: 'atlas', name: 'Atlas', tone: 'green' as const },
]

/** Current month in UTC as `YYYY-MM`. */
const currentMonth = new Date().toISOString().slice(0, 7)

test('summarizes each readable Project with its budget, log, and a saved monthly snapshot', async () => {
  configureFakeProjectClients(true)
  const budget = await request('/api/teams/core-team/projects/refero/time-budget', 'PUT', {
    amountMinor: 100_000,
    currency: 'USD',
    expectedRevision: 0,
  })
  expect(budget.status).toBe(200)
  const risk = await request('/api/teams/core-team/projects/refero/raid-log/entries', 'POST', {
    entry: { kind: 'risk', title: 'Vendor delay', probability: 5, impact: 5, status: 'open' },
  })
  expect(risk.status).toBe(201)

  const portfolio = await readPortfolio()
  expect(portfolio.hiddenProjectCount).toBe(0)
  expect(portfolio.viewer.canCaptureSnapshot).toBe(true)
  const refero = portfolio.projects.find((project) => project.projectId === 'refero')
  expect(refero).toMatchObject({
    costHidden: false,
    budget: { amountMinor: 100_000, currency: 'USD', actualCostMinor: 0, hasOtherCurrencyCost: false },
    raid: { openRisks: 1, openIssues: 0, openChangeRequests: 0, highestOpenSeverity: 'critical' },
  })
  expect(refero?.workItems.total).toBeGreaterThan(0)

  const empty = await request(`/api/teams/core-team/portfolio/snapshots/${currentMonth}`)
  expect(await empty.json()).toEqual({ snapshot: null })

  const saved = await request(`/api/teams/core-team/portfolio/snapshots/${currentMonth}?timeZone=UTC`, 'PUT', {})
  expect(saved.status).toBe(200)
  const read = parseTeamPortfolioSnapshotResponse(
    await (await request(`/api/teams/core-team/portfolio/snapshots/${currentMonth}`)).json(),
  )
  expect(read?.snapshot?.month).toBe(currentMonth)
  expect(read?.snapshot?.projects).toEqual(portfolio.projects)

  const past = await request(
    `/api/teams/core-team/portfolio/snapshots/${previousPortfolioMonth(currentMonth)}?timeZone=UTC`,
    'PUT',
    {},
  )
  expect(past.status).toBe(400)
  const malformed = await request('/api/teams/core-team/portfolio/snapshots/2026-13')
  expect(malformed.status).toBe(400)
})

test('counts approved expenses of the budget period toward the budget use (ADR 0104)', async () => {
  configureFakeProjectClients(true)
  const store = new InMemoryProjectExpenseStore()
  setTestAppDependencies({ projectExpenses: store })
  const budget = await request('/api/teams/core-team/projects/refero/time-budget', 'PUT', {
    amountMinor: 100_000,
    currency: 'USD',
    expectedRevision: 0,
  })
  expect(budget.status).toBe(200)
  const now = new Date().toISOString()
  const today = now.slice(0, 10)
  /**
   * Stores an expense of the Project as it is after a decision.
   *
   * @param id - Expense ID.
   * @param amountMinor - Amount.
   * @param currency - Currency.
   * @param status - Decision state.
   */
  const seed = async (id: string, amountMinor: number, currency: string, status: 'approved' | 'submitted') => {
    const expense: ProjectExpense = {
      id,
      teamId: 'core-team',
      projectId: 'refero',
      date: today,
      category: 'License',
      amountMinor,
      currency,
      receiptFileIds: [],
      status,
      submittedByMemberId: 'a@example.com',
      submittedAt: now,
      ...(status === 'approved' ? { decision: { outcome: 'approved' as const, decidedByMemberId: 'b@example.com', decidedAt: now } } : {}),
      revision: status === 'approved' ? 2 : 1,
      createdAt: now,
      updatedAt: now,
    }
    await store.create({
      workspaceId: 'user#demo@example.com',
      teamId: 'core-team',
      projectId: 'refero',
      now,
      callerAuthorization: [{ ConditionCheck: { TableName: 't', Key: {}, ConditionExpression: 'attribute_exists(a)' } }],
      auditContext: createMutationAuditContext({
        workspaceId: 'user#demo@example.com',
        actor: { id: 'seed', kind: 'user', displayName: 'Seed' },
        idempotencyKey: id,
        request: { method: 'POST', path: '/seed', body: {} },
        source: { kind: 'api' },
      }),
      expense,
      creationFingerprint: id,
    })
  }
  await seed('approved-usd', 2_500, 'USD', 'approved')
  await seed('approved-eur', 1_000, 'EUR', 'approved')
  await seed('pending-usd', 9_000, 'USD', 'submitted')

  const refero = (await readPortfolio()).projects.find((project) => project.projectId === 'refero')
  expect(refero?.budget).toMatchObject({ amountMinor: 100_000, currency: 'USD', actualCostMinor: 2_500, hasOtherCurrencyCost: true })
})

test('counts Projects the reader cannot read and hides costs the reader may not see', async () => {
  configureFakeProjectClients(false, {
    teamProjects,
    role: 'manager',
    projectAccesses: teamProjects.map((project) => ({ teamId: 'core-team', projectId: project.id, role: 'manager' as const })),
  })
  const fullPortfolio = await readPortfolio()
  const saved = await request(`/api/teams/core-team/portfolio/snapshots/${currentMonth}?timeZone=UTC`, 'PUT', {})
  expect(saved.status).toBe(200)

  configureFakeProjectClients(false, {
    teamProjects,
    role: 'viewer',
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'viewer' }],
  })
  const portfolio = await readPortfolio()
  expect(portfolio.projects.map((project) => project.projectId)).toEqual(['refero'])
  expect(fullPortfolio.projects).toHaveLength(2)
  expect(portfolio.hiddenProjectCount).toBe(1)
  expect(portfolio.costHiddenProjectCount).toBe(1)
  expect(portfolio.projects[0]?.costHidden).toBe(true)
  expect(portfolio.projects[0]?.budget).toBeUndefined()
  expect(portfolio.viewer.canCaptureSnapshot).toBe(false)

  const snapshot = parseTeamPortfolioSnapshotResponse(
    await (await request(`/api/teams/core-team/portfolio/snapshots/${currentMonth}`)).json(),
  )?.snapshot
  expect(snapshot?.projects.map((project) => project.projectId)).toEqual(['refero'])
  expect(snapshot?.hiddenProjectCount).toBe(1)
  expect(snapshot?.projects[0]?.costHidden).toBe(true)

  const denied = await request(`/api/teams/core-team/portfolio/snapshots/${currentMonth}?timeZone=UTC`, 'PUT', {})
  expect(denied.status).toBe(403)
})

test('shows costs only for the Projects a partial manager manages and refuses their snapshot save', async () => {
  configureFakeProjectClients(false, {
    teamProjects,
    role: 'manager',
    projectAccesses: [{ teamId: 'core-team', projectId: 'refero', role: 'manager' }],
  })
  const budget = await request('/api/teams/core-team/projects/refero/time-budget', 'PUT', {
    amountMinor: 50_000,
    currency: 'JPY',
    expectedRevision: 0,
  })
  expect(budget.status).toBe(200)
  const portfolio = await readPortfolio()
  const refero = portfolio.projects.find((project) => project.projectId === 'refero')
  expect(refero?.costHidden).toBe(false)
  expect(refero?.budget).toMatchObject({ amountMinor: 50_000, currency: 'JPY' })
  expect(portfolio.viewer.canCaptureSnapshot).toBe(false)
  const denied = await request(`/api/teams/core-team/portfolio/snapshots/${currentMonth}?timeZone=UTC`, 'PUT', {})
  expect(denied.status).toBe(403)
})

/**
 * Saves the current month's snapshot with an explicit Idempotency-Key.
 *
 * @param key - Idempotency-Key header.
 * @param timeZone - Timezone the save computes in.
 * @returns The response.
 */
function saveWithKey(key: string, timeZone: string) {
  return app.request(`/api/teams/core-team/portfolio/snapshots/${currentMonth}?timeZone=${encodeURIComponent(timeZone)}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${createAccessToken()}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: '{}',
  })
}

test('treats a retry with another timezone as a different request', async () => {
  configureFakeProjectClients(true)
  expect((await saveWithKey('portfolio-tz-key', 'UTC')).status).toBe(200)
  expect((await saveWithKey('portfolio-tz-key', 'UTC')).status).toBe(200)
  const changed = await saveWithKey('portfolio-tz-key', 'Africa/Abidjan')
  expect(changed.status).toBe(409)
  expect(await changed.json()).toMatchObject({ code: 'PortfolioSnapshotIdempotencyConflict' })
})

test('refuses to save when the Team cannot be fenced as active', async () => {
  configureFakeProjectClients(true)
  getTestAppDependencies().workspace.projectDirectory.createActiveReferenceConditionChecks = async () => []
  const response = await saveWithKey('portfolio-fence-key', 'UTC')
  expect(response.status).toBe(503)
  expect(await response.json()).toMatchObject({ code: 'PortfolioTeamFenceUnavailable' })
})
