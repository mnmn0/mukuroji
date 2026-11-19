import { expect, test, type Page } from '@playwright/test'
import type { TimeBudget, TimeTrackingSummary } from '@mukuroji/contracts'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

/** Mutable state of the mocked report API. */
type TimeReportMockState = {
  /** Whether the signed-in member receives costs and budgets. */
  isManager: boolean
  /** Saved Team budget. */
  budget?: TimeBudget
  /** Query strings of report reads. */
  summaryQueries: URLSearchParams[]
  /** Query strings of CSV exports. */
  exportQueries: URLSearchParams[]
  /** Bodies of budget saves. */
  budgetBodies: unknown[]
}

/**
 * Builds the report the mock returns for a grouping.
 *
 * @param state - Mock state.
 * @param query - Report query.
 * @returns Report body.
 */
function createSummary(state: TimeReportMockState, query: URLSearchParams): TimeTrackingSummary {
  const requested = query.get('groupBy')
  const groupBy = requested === 'project' || requested === 'day' ? requested : 'user'
  const costs = state.isManager
  const groupKey = groupBy === 'project' ? 'refero' : groupBy === 'day' ? '2026-11-10' : 'demo@example.com'
  return {
    from: '2026-11-08T15:00:00.000Z',
    to: '2026-11-15T15:00:00.000Z',
    timeZone: 'Asia/Tokyo',
    groupBy,
    groups: [{ key: groupKey, label: groupKey, minutes: 750, billableMinutes: 600, entryCount: 5, ...(costs ? { actualCostByCurrency: { JPY: 75_000 }, actualCostMinor: 75_000 } : {}) }],
    totalMinutes: 750,
    totalBillableMinutes: 600,
    totalEstimateMinutes: 0,
    ...(costs ? { totalActualCostByCurrency: { JPY: 75_000 }, totalActualCostMinor: 75_000 } : {}),
    ...(costs && state.budget && query.get('budgetScope') === 'team' ? { budget: state.budget } : {}),
    costsRedacted: !costs,
  }
}

/**
 * Installs the session, directory, and an in-memory report and budget API.
 *
 * @param page - Browser page whose API requests are intercepted.
 * @param isManager - Whether the member receives costs and budgets.
 * @returns Mutable mock state.
 */
async function mockTimeReport(page: Page, isManager: boolean): Promise<TimeReportMockState> {
  const state: TimeReportMockState = { isManager, summaryQueries: [], exportQueries: [], budgetBodies: [] }
  await page.clock.setFixedTime(new Date('2026-11-10T01:00:00.000Z'))
  await page.addInitScript(() => {
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken: 'time-test', expiresAt: Date.now() + 3600000, remember: true, tokenType: 'Bearer' }))
    localStorage.setItem('mukuroji.locale', 'en')
  })
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'demo@example.com', name: 'Demo' }, groups: [], isSystemAdmin: false, username: 'demo@example.com', workspaceMemberStatus: 'active', workspaceRole: 'member' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route((url) => url.pathname === '/api/work-items', (route) => route.fulfill({ json: { workItems: [] } }))
  await page.route((url) => /^\/api\/projects\/[^/]+\/members$/u.test(url.pathname), (route) => {
    const projectId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
    return route.fulfill({ json: { projectId, members: [
      { id: 'demo@example.com', email: 'demo@example.com', name: 'Demo Member', role: 'member', updatedAt: '2026-11-01T00:00:00.000Z' },
    ] } })
  })
  await page.route((url) => url.pathname === '/api/task-views', (route) => route.fulfill({ json: { views: [], capabilities: {
    canWrite: false, canManageSharedViews: false, canSetTeamDefault: false, writableTeamIds: [], writableProjectScopes: [],
  } } }))
  await page.route((url) => url.pathname === '/api/time-tracking/timers/active', (route) => route.fulfill({ json: { timer: null } }))
  await page.route((url) => url.pathname === '/api/teams/core-team/time-tracking/summary', (route) => {
    const query = new URL(route.request().url()).searchParams
    state.summaryQueries.push(query)
    return route.fulfill({ json: createSummary(state, query) })
  })
  await page.route((url) => url.pathname === '/api/teams/core-team/time-tracking/export', (route) => {
    state.exportQueries.push(new URL(route.request().url()).searchParams)
    return route.fulfill({ body: 'Group,Minutes\ndemo@example.com,750\n', headers: { 'Content-Type': 'text/csv; charset=utf-8' } })
  })
  await page.route((url) => url.pathname === '/api/teams/core-team/time-budget', (route) => {
    const body = route.request().postDataJSON()
    state.budgetBodies.push(body)
    state.budget = {
      schemaVersion: 1,
      workspaceId: 'workspace-demo',
      scopeType: 'team',
      scopeId: 'core-team',
      amountMinor: body.amountMinor,
      currency: body.currency,
      ...(body.periodFrom ? { periodFrom: body.periodFrom } : {}),
      ...(body.periodTo ? { periodTo: body.periodTo } : {}),
      revision: (state.budget?.revision ?? 0) + 1,
      updatedAt: '2026-11-10T01:00:00.000Z',
    }
    return route.fulfill({ json: { budget: state.budget } })
  })
  return state
}

test.describe('time tracking report', () => {
  test('a manager switches the grouping, downloads the CSV, and sets the Team budget', async ({ page }) => {
    const state = await mockTimeReport(page, true)
    await page.goto('/teams/core-team/timesheet')
    await page.getByRole('link', { name: 'Report' }).click()
    await expect(page).toHaveURL(/view=report&from=2026-11-09&to=2026-11-15&groupBy=day/u)

    await page.getByLabel('Group by').selectOption('user')
    await expect(page).toHaveURL(/groupBy=user/u)
    const table = page.getByTestId('time-report-table')
    await expect(table).toContainText('Demo Member')
    await expect(table).toContainText('12:30')
    await expect(table.getByRole('columnheader', { name: 'Actual cost' })).toBeVisible()

    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download CSV' }).click()
    expect((await download).suggestedFilename()).toBe('mukuroji-time-2026-11-09_2026-11-15-user.csv')
    expect(state.exportQueries.at(-1)?.get('groupBy')).toBe('user')
    expect(state.exportQueries.at(-1)?.get('from')).toBe('2026-11-09')

    const budget = page.getByTestId('time-budget-panel')
    await expect(budget).toContainText('No budget has been set yet.')
    await budget.getByRole('button', { name: 'Set budget' }).click()
    await budget.getByLabel('Budget', { exact: true }).fill('300000')
    await budget.getByLabel('Currency').fill('JPY')
    await budget.getByLabel('Period start (optional)').fill('2026-11-01')
    await budget.getByLabel('Period end (optional)').fill('2026-11-30')
    await budget.getByRole('button', { name: 'Save budget' }).click()
    await expect(budget.getByText('Budget saved.')).toBeVisible()
    expect(state.budgetBodies.at(-1)).toEqual({ amountMinor: 300_000, currency: 'JPY', periodFrom: '2026-11-01', periodTo: '2026-11-30', expectedRevision: 0 })
    const comparison = budget.getByTestId('time-budget-comparison')
    await expect(comparison).toContainText('¥300,000')
    await expect(comparison).toContainText('¥75,000')
    await expect(budget.getByText('Team actual costs include only the Projects you manage', { exact: false })).toBeVisible()

    await budget.getByRole('button', { name: 'Report this period' }).click()
    await expect(page).toHaveURL(/from=2026-11-01&to=2026-11-30&groupBy=user/u)
  })

  test('a member sees hours without costs or budgets', async ({ page }) => {
    await mockTimeReport(page, false)
    await page.goto('/teams/core-team/timesheet?view=report&from=2026-11-09&to=2026-11-15&groupBy=user')
    const table = page.getByTestId('time-report-table')
    await expect(table).toContainText('12:30')
    await expect(table.getByRole('columnheader', { name: 'Actual cost' })).toHaveCount(0)
    await expect(page.getByTestId('time-budget-panel')).toHaveCount(0)
  })
})
