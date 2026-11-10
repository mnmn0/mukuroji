import { expect, test, type Page } from '@playwright/test'
import type { TimeEntry, TimeEntryStatus } from '@mukuroji/contracts'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

/** Canonical Work Items the member can record time on. */
const workItems = [
  { id: 'onboarding', teamId: 'core-team', title: 'Reduce onboarding friction', assignedProjectId: 'refero', statusCategory: 'started' },
  { id: 'pricing', teamId: 'core-team', title: 'Update the pricing page', assignedProjectId: 'refero', statusCategory: 'unstarted' },
]

/** Mutable state of the mocked time tracking API. */
type TimeTrackingMockState = {
  /** Every stored entry. */
  entries: TimeEntry[]
  /** Rejection reasons keyed by entry. */
  reasons: Record<string, string>
  /** Whether the signed-in member manages the Team. */
  isManager: boolean
  /** Idempotency keys sent with mutations. */
  idempotencyKeys: string[]
}

/**
 * Installs the session, directory, Work Items, and an in-memory time tracking API.
 *
 * @param page - Browser page whose API requests are intercepted.
 * @returns Mutable mock state.
 */
async function mockTimeTracking(page: Page): Promise<TimeTrackingMockState> {
  const state: TimeTrackingMockState = { entries: [], reasons: {}, isManager: false, idempotencyKeys: [] }
  await page.clock.setFixedTime(new Date('2026-11-10T01:00:00.000Z'))
  await page.addInitScript(() => {
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken: 'time-test', expiresAt: Date.now() + 3600000, remember: true, tokenType: 'Bearer' }))
    localStorage.setItem('mukuroji.locale', 'en')
  })
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'demo@example.com', name: 'Demo' }, groups: [], isSystemAdmin: false, username: 'demo@example.com', workspaceMemberStatus: 'active', workspaceRole: 'member' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  await page.route((url) => url.pathname === '/api/work-items', (route) => route.fulfill({ json: { workItems } }))
  await page.route((url) => /^\/api\/projects\/[^/]+\/members$/u.test(url.pathname), (route) => {
    const projectId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
    return route.fulfill({ json: { projectId, members: [
      { id: 'demo@example.com', email: 'demo@example.com', name: 'Demo Member', role: 'member', updatedAt: '2026-11-01T00:00:00.000Z' },
    ] } })
  })
  await page.route((url) => url.pathname === '/api/time-tracking/timers/active', (route) => route.fulfill({ json: { timer: null } }))
  await page.route((url) => url.pathname.startsWith('/api/teams/core-team/time') && !url.pathname.includes('/projects'), async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api/teams/core-team', '')
    const key = request.headers()['idempotency-key']
    if (key) state.idempotencyKeys.push(key)
    if (path === '/timesheet' && request.method() === 'GET') {
      return route.fulfill({ json: { from: url.searchParams.get('from'), to: url.searchParams.get('to'), timeZone: 'Asia/Tokyo', days: [], weeks: [], costsRedacted: !state.isManager } })
    }
    if (path === '/time-entries' && request.method() === 'GET') {
      const status = url.searchParams.get('status')
      return route.fulfill({ json: { entries: state.entries.filter((entry) => !status || entry.status === status) } })
    }
    if (path === '/time-entries' && request.method() === 'POST') {
      const input = request.postDataJSON()
      const entry: TimeEntry = {
        schemaVersion: 1,
        id: `entry-${state.entries.length + 1}`,
        workspaceId: 'workspace-demo',
        teamId: 'core-team',
        projectId: 'refero',
        workItemId: input.workItemId,
        userId: 'demo@example.com',
        startAt: input.startAt,
        endAt: input.endAt,
        durationMinutes: Math.round((Date.parse(input.endAt) - Date.parse(input.startAt)) / 60_000),
        ...(input.description ? { description: input.description } : {}),
        billable: input.billable,
        currency: 'USD',
        status: 'draft',
        source: 'manual',
        revision: 1,
        createdAt: '2026-11-10T01:00:00.000Z',
        updatedAt: '2026-11-10T01:00:00.000Z',
      }
      state.entries.push(entry)
      return route.fulfill({ status: 201, json: { entry } })
    }
    const transition = /^\/timesheet\/(submit|approve|lock)$/u.exec(path)
    if (transition && request.method() === 'POST') {
      const action = transition[1]
      const from: TimeEntryStatus[] = action === 'submit' ? ['draft', 'rejected'] : action === 'approve' ? ['submitted'] : ['approved']
      const to: TimeEntryStatus = action === 'submit' ? 'submitted' : action === 'approve' ? 'approved' : 'locked'
      const changed = state.entries.filter((entry) => from.includes(entry.status))
      for (const entry of changed) {
        entry.status = to
        entry.revision += 1
      }
      return route.fulfill({ json: { count: changed.length, failedEntryIds: [], partialFailure: false, entries: changed } })
    }
    const entryMatch = /^\/time-entries\/([^/]+)(?:\/(submit|approve|reject|lock|history))?$/u.exec(path)
    const entry = state.entries.find((candidate) => candidate.id === entryMatch?.[1])
    if (!entryMatch || !entry) return route.fulfill({ status: 404, json: { code: 'TimeEntryNotFound' } })
    const action = entryMatch[2]
    if (action === 'history') {
      const reason = state.reasons[entry.id]
      return route.fulfill({ json: { history: reason ? [{ id: 'h1', entryId: entry.id, action: 'rejected', actorUserId: 'lead@example.com', reason, occurredAt: '2026-11-10T02:00:00.000Z' }] : [] } })
    }
    const input = request.postDataJSON()
    if (input.expectedRevision !== entry.revision) return route.fulfill({ status: 409, json: { code: 'TimeEntryRevisionConflict' } })
    if (request.method() === 'PATCH') {
      Object.assign(entry, {
        startAt: input.startAt,
        endAt: input.endAt,
        durationMinutes: Math.round((Date.parse(input.endAt) - Date.parse(input.startAt)) / 60_000),
        status: 'draft',
        revision: entry.revision + 1,
      })
      return route.fulfill({ json: { entry } })
    }
    entry.status = action === 'submit' ? 'submitted' : action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'locked'
    entry.revision += 1
    if (action === 'reject') state.reasons[entry.id] = input.reason
    return route.fulfill({ json: { entry } })
  })
  return state
}

test.describe('Time tracking', () => {
  test('records, submits, is rejected, resubmits, and is approved and locked', async ({ page }) => {
    const state = await mockTimeTracking(page)
    await page.goto('/teams/core-team/timesheet')

    await expect(page.getByText('No time has been recorded this week.')).toBeVisible()
    await page.getByRole('button', { name: 'Add manually' }).click()
    const form = page.getByRole('form', { name: 'Add time' })
    await form.getByLabel('Task').selectOption({ label: 'Reduce onboarding friction' })
    await form.getByLabel('Start').fill('09:00')
    await form.getByLabel('End', { exact: true }).fill('11:30')
    await form.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Time added.' })).toBeVisible()
    await expect(page.getByTestId('timesheet-week-table')).toContainText('2:30')

    await page.getByRole('button', { name: 'Submit drafts (1)' }).click()
    await expect(page.getByText('Submitted 1 entries.')).toBeVisible()
    await expect(page.getByTestId('time-entry-row')).toContainText('Submitted')

    // A manager reviews the week.
    state.isManager = true
    await page.getByRole('link', { name: 'Approvals' }).click()
    await expect(page).toHaveURL(/view=approvals/u)
    await expect(page.getByRole('heading', { name: 'Awaiting approval (1)' })).toBeVisible()
    await page.getByRole('button', { name: /^Reject Demo Member/u }).click()
    await page.getByLabel('Rejection reason').fill('Split the interview from the build work.')
    await page.getByRole('button', { name: 'Reject', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Awaiting approval (0)' })).toBeVisible()

    // The member fixes the entry and resubmits it.
    await page.getByRole('link', { name: 'My timesheet' }).click()
    await expect(page.getByText('Rejection reason: Split the interview from the build work.')).toBeVisible()
    await page.getByRole('button', { name: /^Edit/u }).click()
    await page.getByRole('form', { name: 'Edit time' }).getByLabel('End', { exact: true }).fill('10:30')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByTestId('timesheet-week-table')).toContainText('1:30')
    await page.getByRole('button', { name: /^Submit/u }).first().click()
    await expect(page.getByTestId('time-entry-row')).toContainText('Submitted')

    await page.getByRole('link', { name: 'Approvals' }).click()
    await page.getByRole('button', { name: 'Approve all submitted this week' }).click()
    await expect(page.getByText('Approved 1 entries.')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Approved, not locked (1)' })).toBeVisible()
    await page.getByRole('button', { name: 'Lock all approved this week' }).click()
    await expect(page.getByText('Locked this week: 1')).toBeVisible()
    expect(state.entries[0]?.status).toBe('locked')
    expect(new Set(state.idempotencyKeys).size).toBe(state.idempotencyKeys.length)
  })

  test('tells a member that only managers approve time', async ({ page }) => {
    await mockTimeTracking(page)
    await page.goto('/teams/core-team/timesheet?view=approvals')
    await expect(page.getByText('Only Team managers can approve time.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Approve all submitted this week' })).toHaveCount(0)
  })

  test('shows a failed task lookup and recovers on retry', async ({ page }) => {
    await mockTimeTracking(page)
    let failures = 1
    await page.route((url) => url.pathname === '/api/work-items', async (route) => {
      if (failures > 0) {
        failures -= 1
        await route.fulfill({ status: 503, json: { message: 'Unavailable' } })
        return
      }
      await route.fallback()
    })
    await page.goto('/teams/core-team/timesheet')
    const alert = page.getByRole('alert').filter({ hasText: 'Tasks and member names could not be loaded.' })
    await expect(alert).toBeVisible()
    await alert.getByRole('button', { name: 'Reload tasks' }).click()
    await expect(alert).toHaveCount(0)
    await page.getByRole('button', { name: 'Add manually' }).click()
    await expect(page.getByRole('form', { name: 'Add time' }).getByLabel('Task')).toContainText('Update the pricing page')
  })

  test('does not offer manual entry to a Project viewer', async ({ page }) => {
    await mockTimeTracking(page)
    await page.route((url) => /^\/api\/projects\/[^/]+\/members$/u.test(url.pathname), (route) => {
      const projectId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
      return route.fulfill({ json: { projectId, members: [
        { id: 'demo@example.com', email: 'demo@example.com', name: 'Demo Member', role: 'viewer', updatedAt: '2026-11-01T00:00:00.000Z' },
      ] } })
    })
    await page.goto('/teams/core-team/timesheet')
    await expect(page.getByTestId('timesheet-no-writable-items')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add manually' })).toBeDisabled()
  })

  test('works at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockTimeTracking(page)
    await page.goto('/teams/core-team/timesheet')
    await page.getByRole('button', { name: 'Add manually' }).click()
    const form = page.getByRole('form', { name: 'Add time' })
    await form.getByLabel('Task').selectOption({ label: 'Update the pricing page' })
    await form.getByRole('button', { name: 'Add' }).click()
    await expect(page.getByTestId('timesheet-week-table')).toBeVisible()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(0)
  })
})
