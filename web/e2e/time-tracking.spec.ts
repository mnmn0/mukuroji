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
  /** Project scopes where the member may record time. */
  writableProjectIds: string[]
  /** Day the Workspace week starts on, 0 (Sunday) to 6. */
  weekStartDay: number
  /** The member's saved notes and submitted bodies of the weekly report, keyed by week. */
  weeklyReports: Record<string, { revision: number; notes: { issues: string; reflection: string }; submissions: { notes: { issues: string; reflection: string }; sections: Record<string, { workItemId: string; minutes: number }[]> }[] }>
}

/**
 * Installs the session, directory, Work Items, and an in-memory time tracking API.
 *
 * @param page - Browser page whose API requests are intercepted.
 * @returns Mutable mock state.
 */
async function mockTimeTracking(page: Page): Promise<TimeTrackingMockState> {
  const state: TimeTrackingMockState = { entries: [], reasons: {}, isManager: false, idempotencyKeys: [], writableProjectIds: ['refero'], weekStartDay: 1, weeklyReports: {} }
  await page.clock.setFixedTime(new Date('2026-11-10T01:00:00.000Z'))
  await page.addInitScript(() => {
    localStorage.setItem('mukuroji.auth', JSON.stringify({ accessToken: 'time-test', expiresAt: Date.now() + 3600000, remember: true, tokenType: 'Bearer' }))
    localStorage.setItem('mukuroji.locale', 'en')
  })
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { attributes: { 'custom:workspace_id': 'workspace-demo', email: 'demo@example.com', name: 'Demo' }, groups: [], isSystemAdmin: false, username: 'demo@example.com', workspaceMemberStatus: 'active', workspaceRole: 'member' } }))
  await page.route('**/api/teams/projects**', (route) => route.fulfill({ json: { teams: projectDirectoryFixtures } }))
  await page.route('**/api/projects/quick-access', (route) => route.fulfill({ json: { items: [], revision: 0 } }))
  await page.route('**/api/notifications/unread-count', (route) => route.fulfill({ json: { unreadCount: 0 } }))
  // An unfiltered read stands in for a Workspace too large to list, so the page must ask for its Team only.
  await page.route((url) => url.pathname === '/api/work-items', (route) => new URL(route.request().url()).searchParams.get('teamId') === 'core-team'
    ? route.fulfill({ json: { workItems } })
    : route.fulfill({ status: 413, json: { code: 'WorkItemListLimitExceeded', message: 'Too many Work Items.' } }))
  await page.route((url) => /^\/api\/projects\/[^/]+\/members$/u.test(url.pathname), (route) => {
    const projectId = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3] ?? '')
    return route.fulfill({ json: { projectId, members: [
      { id: 'demo@example.com', email: 'demo@example.com', name: 'Demo Member', role: 'member', updatedAt: '2026-11-01T00:00:00.000Z' },
    ] } })
  })
  await page.route((url) => url.pathname === '/api/task-views', (route) => route.fulfill({ json: { views: [], capabilities: {
    canWrite: state.writableProjectIds.length > 0,
    canManageSharedViews: false,
    canSetTeamDefault: false,
    writableTeamIds: state.writableProjectIds.length > 0 ? ['core-team'] : [],
    writableProjectScopes: state.writableProjectIds.map((projectId) => ({ teamId: 'core-team', projectId })),
  } } }))
  await page.route((url) => url.pathname === '/api/time-tracking/timers/active', (route) => route.fulfill({ json: { timer: null } }))
  await page.route((url) => url.pathname === '/api/workspace/calendar-settings', (route) => route.fulfill({ json: { fiscalYearStartMonth: 4, weekStartDay: state.weekStartDay } }))
  await page.route((url) => url.pathname.startsWith('/api/teams/core-team/weekly-reports'), async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const parts = url.pathname.replace('/api/teams/core-team/weekly-reports', '').split('/').filter(Boolean).map(decodeURIComponent)
    const titles: Record<string, string> = Object.fromEntries(workItems.map((item) => [item.id, item.title]))
    /** Builds the report response of a week as the stored state says. */
    const respond = (memberKey: string, weekStart: string, status = 200) => {
      const stored = memberKey === 'demo@example.com' ? state.weeklyReports[weekStart] : undefined
      const latest = stored?.submissions.at(-1)
      const view = (rows: { workItemId: string; minutes: number }[]) => rows.map((row) => ({ hidden: false, workItemId: row.workItemId, title: titles[row.workItemId] ?? row.workItemId, minutes: row.minutes }))
      return route.fulfill({ status, json: {
        teamId: 'core-team',
        memberKey,
        weekStart,
        submissionCount: stored?.submissions.length ?? 0,
        ...(stored && memberKey === 'demo@example.com' ? { draft: { revision: stored.revision, updatedAt: '2026-11-10T01:00:00.000Z', notes: stored.notes } } : {}),
        ...(latest ? { submission: {
          version: stored?.submissions.length ?? 1,
          submittedAt: '2026-11-10T01:00:00.000Z',
          weekStart,
          weekEnd: '2026-11-15',
          sections: Object.fromEntries(['completed', 'started', 'overdue', 'upcoming'].map((name) => [name, view(latest.sections[name] ?? [])])),
          time: [],
          totalMinutes: 0,
          timeIsPartial: false,
          notes: latest.notes,
        } } : {}),
      } })
    }
    if (parts.length === 0) {
      if (!state.isManager) return route.fulfill({ status: 403, json: { code: 'WeeklyReportForbidden' } })
      const weekStart = url.searchParams.get('weekStart') ?? ''
      return route.fulfill({ json: { teamId: 'core-team', weekStart, members: [
        { memberKey: 'demo@example.com', submissionCount: state.weeklyReports[weekStart]?.submissions.length ?? 0, ...(state.weeklyReports[weekStart]?.submissions.length ? { lastSubmittedAt: '2026-11-10T01:00:00.000Z' } : {}) },
        { memberKey: 'sato@example.com', submissionCount: 0 },
      ] } })
    }
    const [memberKey = '', weekStart, action] = parts
    if (weekStart === undefined) {
      return route.fulfill({ json: { teamId: 'core-team', memberKey, weeks: Object.entries(state.weeklyReports).map(([week, stored]) => ({ weekStart: week, submissionCount: stored.submissions.length })) } })
    }
    if (request.method() === 'GET') return respond(memberKey, weekStart)
    const input = request.postDataJSON()
    const stored = state.weeklyReports[weekStart] ?? { revision: 0, notes: { issues: '', reflection: '' }, submissions: [] }
    if (action === 'draft') {
      if (input.expectedRevision !== stored.revision) return route.fulfill({ status: 409, json: { code: 'WeeklyReportConflict' } })
      state.weeklyReports[weekStart] = { ...stored, revision: stored.revision + 1, notes: input.notes }
      return respond(memberKey, weekStart)
    }
    if (input.expectedSubmissionCount !== stored.submissions.length || input.expectedRevision !== stored.revision) return route.fulfill({ status: 409, json: { code: 'WeeklyReportConflict' } })
    state.weeklyReports[weekStart] = { revision: stored.revision + 1, notes: input.notes, submissions: [...stored.submissions, { notes: input.notes, sections: input.sections }] }
    return respond(memberKey, weekStart, 201)
  })
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

  test('starts the week on the Workspace week start day', async ({ page }) => {
    const state = await mockTimeTracking(page)
    state.weekStartDay = 0
    // 2026-11-10 is a Tuesday in Tokyo, so a Sunday-based week starts on 2026-11-08.
    const entriesRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/teams/core-team/time-entries')
    await page.goto('/teams/core-team/timesheet')
    const from = new URL((await entriesRequest).url()).searchParams.get('from')
    expect(from).toBe('2026-11-07T15:00:00.000Z')
    await page.getByRole('button', { name: /next week/iu }).click()
    await expect(page).toHaveURL(/week=2026-11-15/u)
  })

  test('waits for the week start and recovers when it fails to load', async ({ page }) => {
    await mockTimeTracking(page)
    let failures = 1
    await page.route((url) => url.pathname === '/api/workspace/calendar-settings', async (route) => {
      if (failures > 0) {
        failures -= 1
        await route.fulfill({ status: 503, json: { message: 'Unavailable' } })
        return
      }
      await route.fallback()
    })
    await page.goto('/teams/core-team/timesheet')
    const alert = page.getByRole('alert').filter({ hasText: 'The Workspace week start could not be loaded.' })
    await expect(alert).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add manually' })).toHaveCount(0)
    // Switching views before the week start is known keeps the URL free of a guessed week.
    await page.getByRole('link', { name: 'Approvals' }).click()
    await expect(page).toHaveURL(/\/timesheet\?view=approvals$/u)
    await page.getByRole('link', { name: 'My timesheet' }).click()
    await alert.getByRole('button', { name: 'Reload settings' }).click()
    await expect(alert).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add manually' })).toBeVisible()
  })

  test('does not offer manual entry to a Project viewer', async ({ page }) => {
    const state = await mockTimeTracking(page)
    state.writableProjectIds = []
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

  test('drafts the member weekly report from their tasks and time and copies it as Markdown', async ({ page, context }) => {
    const state = await mockTimeTracking(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const schedule = (dueDate: string) => ({ mode: 'due-date', dueDate })
    const myWorkItems = [
      { ...workItems[0], key: 'CORE-12', statusCategory: 'completed', actualStartDate: '2026-11-04', actualEndDate: '2026-11-10', dueDate: '2026-11-12', schedule: schedule('2026-11-12') },
      { ...workItems[1], key: 'CORE-15', statusCategory: 'started', actualStartDate: '2026-11-10', dueDate: '2026-11-18', schedule: schedule('2026-11-18') },
    ]
    const requestedFilters: (string | null)[] = []
    await page.route((url) => url.pathname === '/api/work-items' && url.searchParams.get('involvement') === 'mine', (route) => {
      requestedFilters.push(new URL(route.request().url()).searchParams.get('teamId'))
      return route.fulfill({ json: { workItems: myWorkItems } })
    })
    state.entries.push({
      schemaVersion: 1,
      id: 'entry-1',
      workspaceId: 'workspace-demo',
      teamId: 'core-team',
      projectId: 'refero',
      workItemId: 'onboarding',
      userId: 'demo@example.com',
      startAt: '2026-11-10T00:00:00.000Z',
      endAt: '2026-11-10T02:30:00.000Z',
      durationMinutes: 150,
      billable: false,
      currency: 'USD',
      status: 'draft',
      source: 'manual',
      revision: 1,
      createdAt: '2026-11-10T02:30:00.000Z',
      updatedAt: '2026-11-10T02:30:00.000Z',
    })

    await page.goto('/teams/core-team/timesheet')
    await page.getByRole('link', { name: 'Weekly report', exact: true }).click()
    await expect(page).toHaveURL(/view=weekly-report/u)
    const report = page.getByTestId('personal-weekly-report')
    await expect(report).toContainText('Reduce onboarding friction')
    expect(requestedFilters).toContain('core-team')

    await page.getByLabel('Reflection').fill('Onboarding shipped.')
    const markdown = page.getByTestId('weekly-report-markdown')
    await expect(markdown).toContainText('- CORE-12 Reduce onboarding friction (due 2026-11-12, recorded 2:30)')
    await expect(markdown).toContainText('- CORE-15 Update the pricing page (due 2026-11-18)')
    await expect(markdown).toContainText('Onboarding shipped.')

    await page.getByRole('button', { name: 'Copy Markdown' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Copied.' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('# Weekly report')
  })

  test('saves, submits, and reloads the member weekly report', async ({ page }) => {
    const state = await mockTimeTracking(page)
    await page.route((url) => url.pathname === '/api/work-items' && url.searchParams.get('involvement') === 'mine', (route) =>
      route.fulfill({ json: { workItems: [{ ...workItems[0], statusCategory: 'completed', actualEndDate: '2026-11-10', schedule: { mode: 'unscheduled' } }] } }))

    await page.goto('/teams/core-team/timesheet?view=weekly-report&week=2026-11-09')
    const report = page.getByTestId('personal-weekly-report')
    await expect(report.getByTestId('weekly-report-status')).toHaveText('Not submitted')
    await page.getByLabel('Issues and requests for help').fill('Waiting for review.')
    await expect(report).toContainText('You have unsaved changes.')
    await page.getByRole('button', { name: 'Save draft', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible()
    expect(state.weeklyReports['2026-11-09']?.notes.issues).toBe('Waiting for review.')

    await page.getByLabel('Reflection').fill('Onboarding shipped.')
    await page.getByRole('button', { name: 'Submit', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Submitted.' })).toBeVisible()
    await expect(report.getByTestId('weekly-report-status')).toContainText('Submitted (version 1')
    const submitted = state.weeklyReports['2026-11-09']?.submissions[0]
    expect(submitted?.notes).toEqual({ issues: 'Waiting for review.', reflection: 'Onboarding shipped.' })
    expect(submitted?.sections.completed).toEqual([{ workItemId: 'onboarding', minutes: 0 }])

    await page.reload()
    await expect(page.getByLabel('Reflection')).toHaveValue('Onboarding shipped.')
    await expect(page.getByRole('button', { name: 'Submit again', exact: true })).toBeVisible()
    await expect(page.getByTestId('weekly-report-history')).toContainText('Submitted (version 1)')
  })

  test('shows a manager who submitted the weekly report and what they wrote', async ({ page }) => {
    const state = await mockTimeTracking(page)
    state.isManager = true
    state.weeklyReports['2026-11-09'] = {
      revision: 1,
      notes: { issues: '', reflection: 'Good week.' },
      submissions: [{ notes: { issues: '', reflection: 'Good week.' }, sections: { completed: [{ workItemId: 'onboarding', minutes: 60 }] } }],
    }

    await page.goto('/teams/core-team/timesheet?view=team-weekly-reports&week=2026-11-09')
    const view = page.getByTestId('team-weekly-reports')
    await expect(view).toContainText('1 of 2 submitted')
    await view.getByRole('button', { name: /Demo Member/u }).click()
    await expect(view.getByTestId('submitted-weekly-report')).toContainText('Reduce onboarding friction')
    await expect(view.getByTestId('submitted-weekly-report')).toContainText('Good week.')
  })

  test('tells a member without a managed Project that the Team weekly reports are for managers', async ({ page }) => {
    await mockTimeTracking(page)
    await page.goto('/teams/core-team/timesheet?view=team-weekly-reports&week=2026-11-09')
    await expect(page.getByTestId('team-weekly-reports')).toContainText('Only Team managers')
  })
})
