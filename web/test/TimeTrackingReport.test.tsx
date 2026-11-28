import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { deleteTimeBudgetPeriod, downloadTimeTrackingCsv, getTimeTrackingSummary, saveTimeBudget } from '../src/features/time-tracking/api/timeReport'
import { TimeTrackingApiError } from '../src/features/time-tracking/api/timeTrackingRequest'
import {
  compareTimeBudget,
  createTimeReportFileName,
  formatCostsByCurrency,
  formatMinorAmount,
  isTimeReportRangeOrdered,
  parseMajorAmount,
  resolveTimeReportGroupBy,
  resolveTimeReportRange,
  toMajorAmountInput,
} from '../src/features/time-tracking/model/timeReport'
import {
  timeReportFixtureBudgetSummary,
  timeReportFixtureManagerSummary,
  timeReportFixtureMemberSummary,
  timeReportFixturePeriodBudgetSummary,
  timeReportFixtureProjects,
  timeReportFixtureRange,
} from '../src/features/time-tracking/reportFixtures'
import { TimeBudgetPanel } from '../src/features/time-tracking/ui/TimeBudgetPanel'
import { TimeReport } from '../src/features/time-tracking/ui/TimeReport'
import { TimeEntryCategoryContext } from '../src/features/time-tracking/ui/timeEntryCategoryContext'
import { createTimeTrackingFormatters } from '../src/features/time-tracking/ui/timeTrackingText'
import { createTranslator } from '../src/shared/i18n/i18n'
import { createTeamTimeTrackingPath } from '../src/shared/routing/paths'

const originalFetch = globalThis.fetch
const t = createTranslator('en')
const noop = () => undefined

/** One request seen by the fetch mock. */
type RecordedRequest = {
  /** Requested URL. */
  url: URL
  /** HTTP method. */
  method: string
  /** Request headers. */
  headers: Headers
  /** Parsed JSON body, when one was sent. */
  body: unknown
}

/**
 * Replaces fetch with a mock that records requests and answers with one body.
 *
 * @param body - Response body; a string is sent as is.
 * @param status - HTTP status.
 * @returns Requests seen by the mock.
 */
function respondWith(body: unknown, status = 200): RecordedRequest[] {
  const requests: RecordedRequest[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: new URL(String(input), 'http://localhost'),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }, { preconnect: originalFetch.preconnect })
  return requests
}

/**
 * Creates the budget report of the Atlas Project from the Team budget fixture.
 *
 * @returns Project-grouped report carrying a 30,000 JPY Atlas budget.
 */
function createProjectBudgetSummary() {
  const teamBudget = timeReportFixtureBudgetSummary.budget
  if (!teamBudget) throw new Error('The budget fixture has no budget.')
  return {
    ...timeReportFixtureBudgetSummary,
    budget: { ...teamBudget, scopeType: 'project' as const, scopeId: 'atlas', amountMinor: 30_000 },
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('time report model', () => {
  test('reads the period and grouping from the URL, falling back to the current week by day', () => {
    expect(resolveTimeReportRange('2026-11-01', '2026-11-30')).toEqual({ from: '2026-11-01', to: '2026-11-30' })
    const fallback = resolveTimeReportRange('2026-02-30', '2026-11-30', new Date(2026, 10, 12, 12))
    expect(fallback).toEqual({ from: '2026-11-09', to: '2026-11-15' })
    expect(resolveTimeReportGroupBy('work-item')).toBe('work-item')
    expect(resolveTimeReportGroupBy('team')).toBe('day')
    expect(isTimeReportRangeOrdered({ from: '2026-11-02', to: '2026-11-02' })).toBe(true)
    expect(isTimeReportRangeOrdered({ from: '2026-11-03', to: '2026-11-02' })).toBe(false)
    expect(createTimeReportFileName(timeReportFixtureRange, 'user')).toBe('mukuroji-time-2026-11-09_2026-11-15-user.csv')
  })

  test('converts typed amounts with the decimals of their currency', () => {
    expect(parseMajorAmount('500000', 'JPY')).toBe(500_000)
    expect(parseMajorAmount('1,200', 'JPY')).toBe(1_200)
    expect(parseMajorAmount('12.5', 'JPY')).toBeUndefined()
    expect(parseMajorAmount('12.5', 'USD')).toBe(1_250)
    expect(parseMajorAmount('12.345', 'USD')).toBeUndefined()
    expect(parseMajorAmount('-1', 'USD')).toBeUndefined()
    expect(toMajorAmountInput(1_250, 'USD')).toBe('12.50')
    expect(toMajorAmountInput(500_000, 'JPY')).toBe('500000')
    expect(formatMinorAmount(1_250, 'USD', 'en')).toBe('$12.50')
    expect(formatCostsByCurrency({ USD: 1_250, JPY: 300 }, 'en')).toBe('¥300 / $12.50')
  })

  test('compares a Project budget with the actual cost of the period', () => {
    const projectBudget = createProjectBudgetSummary()
    expect(compareTimeBudget(projectBudget, 'atlas')).toMatchObject({
      actualMinor: 35_000,
      remainingMinor: -5_000,
      usedPercent: 117,
      actualMinutes: 420,
      isPartialScope: false,
    })
    expect(compareTimeBudget(projectBudget, 'unknown')).toMatchObject({ actualMinor: 0, actualMinutes: 0 })
    expect(compareTimeBudget(timeReportFixtureManagerSummary)).toBeUndefined()
  })

  test('treats the Team comparison as partial, since Team costs cover only managed Projects', () => {
    const comparison = compareTimeBudget(timeReportFixtureBudgetSummary)
    expect(comparison).toMatchObject({ actualMinor: 110_000, actualMinutes: 1_170, isPartialScope: true })
    expect(comparison?.remainingMinor).toBeUndefined()
    expect(comparison?.usedPercent).toBeUndefined()
  })

  test('withholds the remaining amount when costs in another currency are not converted', () => {
    const projectBudget = createProjectBudgetSummary()
    const mixed = {
      ...projectBudget,
      groups: projectBudget.groups.map((group) => group.key === 'atlas'
        ? { ...group, actualCostByCurrency: { JPY: 35_000, USD: 2_500 } }
        : group),
    }
    const comparison = compareTimeBudget(mixed, 'atlas')
    expect(comparison).toMatchObject({ actualMinor: 35_000, otherCurrencyCosts: { USD: 2_500 } })
    expect(comparison?.remainingMinor).toBeUndefined()
    expect(comparison?.usedPercent).toBeUndefined()
    const markup = renderToStaticMarkup(
      <TimeBudgetPanel
        defaultCurrency="USD"
        locale="en"
        onChangeScope={noop}
        onDeletePeriod={async () => undefined}
        onRetry={noop}
        onSave={async () => undefined}
        onUseBudgetPeriod={noop}
        projects={timeReportFixtureProjects}
        reportRange={timeReportFixtureRange}
        scope={{ scopeType: 'project', projectId: 'atlas' }}
        summary={mixed}
        t={t}
      />,
    )
    expect(markup).toContain('Actual costs in other currencies ($25.00) are not converted')
  })

  test('links the report view with its period and grouping', () => {
    expect(createTeamTimeTrackingPath('core-team', 'report', undefined, { from: '2026-11-01', to: '2026-11-30', groupBy: 'project' }))
      .toBe('/teams/core-team/timesheet?view=report&from=2026-11-01&to=2026-11-30&groupBy=project')
    expect(createTeamTimeTrackingPath('core-team', 'report', '2026-11-09')).toBe('/teams/core-team/timesheet?view=report')
    expect(createTeamTimeTrackingPath('core-team', 'approvals', '2026-11-09')).toBe('/teams/core-team/timesheet?view=approvals&week=2026-11-09')
  })
})

describe('time report API', () => {
  test('reads a report with the budget scope and validates it', async () => {
    const requests = respondWith(timeReportFixtureBudgetSummary)
    const summary = await getTimeTrackingSummary('token', 'core team', {
      ...timeReportFixtureRange,
      timeZone: 'Asia/Tokyo',
      groupBy: 'project',
      budgetScope: { scopeType: 'project', projectId: 'atlas' },
    })
    expect(summary.budget?.amountMinor).toBe(500_000)
    const url = requests[0]?.url
    expect(url?.pathname).toBe('/api/teams/core%20team/time-tracking/summary')
    expect(url?.searchParams.get('from')).toBe('2026-11-09')
    expect(url?.searchParams.get('to')).toBe('2026-11-15')
    expect(url?.searchParams.get('groupBy')).toBe('project')
    expect(url?.searchParams.get('budgetScope')).toBe('project')
    expect(url?.searchParams.get('projectId')).toBe('atlas')
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer token')

    // A work phase report (ADR 0115) is read like any other grouping.
    respondWith({ ...timeReportFixtureMemberSummary, groupBy: 'phase' })
    expect((await getTimeTrackingSummary('token', 'core-team', { ...timeReportFixtureRange, timeZone: 'UTC', groupBy: 'phase' })).groupBy)
      .toBe('phase')
    respondWith({ ...timeReportFixtureMemberSummary, groupBy: 'team' })
    await expect(getTimeTrackingSummary('token', 'core-team', { ...timeReportFixtureRange, timeZone: 'UTC', groupBy: 'day' }))
      .rejects.toBeInstanceOf(TimeTrackingApiError)
    respondWith({ ...timeReportFixtureMemberSummary, budget: { amountMinor: 'many' } })
    await expect(getTimeTrackingSummary('token', 'core-team', { ...timeReportFixtureRange, timeZone: 'UTC', groupBy: 'day' }))
      .rejects.toBeInstanceOf(TimeTrackingApiError)

    // An older API without the flag totalled everyone's time, so no own-time-only notice applies.
    respondWith({ ...timeReportFixtureMemberSummary, canManageTeam: undefined })
    expect((await getTimeTrackingSummary('token', 'core-team', { ...timeReportFixtureRange, timeZone: 'UTC', groupBy: 'day' })).canManageTeam)
      .toBe(true)
  })

  test('downloads the CSV of the same period and grouping without the budget scope', async () => {
    const requests = respondWith('Group,Minutes\naoi,750\n')
    const blob = await downloadTimeTrackingCsv('token', 'core-team', {
      ...timeReportFixtureRange,
      timeZone: 'Asia/Tokyo',
      groupBy: 'user',
      budgetScope: { scopeType: 'team' },
    })
    expect(await blob.text()).toBe('Group,Minutes\naoi,750\n')
    const url = requests[0]?.url
    expect(url?.pathname).toBe('/api/teams/core-team/time-tracking/export')
    expect(url?.searchParams.get('groupBy')).toBe('user')
    expect(url?.searchParams.get('timeZone')).toBe('Asia/Tokyo')
    expect(url?.searchParams.has('budgetScope')).toBe(false)
    expect(requests[0]?.headers.get('Authorization')).toBe('Bearer token')

    respondWith({ message: 'Forbidden' }, 403)
    await expect(downloadTimeTrackingCsv('token', 'core-team', { ...timeReportFixtureRange, timeZone: 'UTC', groupBy: 'day' }))
      .rejects.toMatchObject({ status: 403 })
  })

  test('saves a Team or Project budget with the revision it replaces', async () => {
    const budget = timeReportFixtureBudgetSummary.budget
    let requests = respondWith({ budget })
    await saveTimeBudget('token', 'core-team', { scopeType: 'team' }, { amountMinor: 500_000, currency: 'JPY', periodFrom: '2026-11-01', periodTo: '2026-11-30', expectedRevision: 2, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' })
    expect(requests[0]?.method).toBe('PUT')
    expect(requests[0]?.url.pathname).toBe('/api/teams/core-team/time-budget')
    expect(requests[0]?.body).toEqual({ amountMinor: 500_000, currency: 'JPY', periodFrom: '2026-11-01', periodTo: '2026-11-30', expectedRevision: 2, expectedUpdatedAt: '2026-11-01T00:00:00.000Z' })

    requests = respondWith({ budget: { ...budget, scopeType: 'project', scopeId: 'atlas' } })
    await saveTimeBudget('token', 'core-team', { scopeType: 'project', projectId: 'atlas' }, { amountMinor: 1_000, currency: 'USD', expectedRevision: 0 })
    expect(requests[0]?.url.pathname).toBe('/api/teams/core-team/projects/atlas/time-budget')
    expect(requests[0]?.body).toEqual({ amountMinor: 1_000, currency: 'USD', expectedRevision: 0 })

    respondWith({ budget: { amountMinor: 1 } })
    await expect(saveTimeBudget('token', 'core-team', { scopeType: 'team' }, { amountMinor: 1, currency: 'USD', expectedRevision: 0 }))
      .rejects.toBeInstanceOf(TimeTrackingApiError)
  })

  test('reads, saves, and deletes budgets per period', async () => {
    respondWith(timeReportFixturePeriodBudgetSummary)
    const summary = await getTimeTrackingSummary('token', 'core-team', { from: '2026-11-01', to: '2026-11-30', timeZone: 'Asia/Tokyo', groupBy: 'project', budgetScope: { scopeType: 'team' } })
    expect(summary.budget?.periodBudget).toBe(true)
    expect(summary.budgetPeriods?.map((budget) => budget.periodFrom)).toEqual(['2026-11-01', '2026-12-01'])

    // A budget per period without its period is not accepted.
    respondWith({ ...timeReportFixturePeriodBudgetSummary, budgetPeriods: [{ ...timeReportFixturePeriodBudgetSummary.budget, periodTo: undefined }] })
    await expect(getTimeTrackingSummary('token', 'core-team', { ...timeReportFixtureRange, timeZone: 'UTC', groupBy: 'project' }))
      .rejects.toBeInstanceOf(TimeTrackingApiError)

    const periodBudget = timeReportFixturePeriodBudgetSummary.budget
    let requests = respondWith({ budget: periodBudget })
    await saveTimeBudget('token', 'core-team', { scopeType: 'team' }, { amountMinor: 300_000, currency: 'JPY', periodFrom: '2026-11-01', periodTo: '2026-11-30', periodBudget: true, expectedRevision: 0 })
    expect(requests[0]?.body).toEqual({ amountMinor: 300_000, currency: 'JPY', periodFrom: '2026-11-01', periodTo: '2026-11-30', periodBudget: true, expectedRevision: 0 })

    requests = respondWith('')
    await deleteTimeBudgetPeriod('token', 'core-team', { scopeType: 'project', projectId: 'atlas' }, { periodFrom: '2026-12-01', periodTo: '2026-12-31', revision: 3, updatedAt: '2026-11-03T00:00:00.000Z' })
    expect(requests[0]?.method).toBe('DELETE')
    expect(requests[0]?.url.pathname).toBe('/api/teams/core-team/projects/atlas/time-budget/periods/2026-12-01/2026-12-31')
    expect(requests[0]?.url.searchParams.get('expectedRevision')).toBe('3')
    expect(requests[0]?.url.searchParams.get('expectedUpdatedAt')).toBe('2026-11-03T00:00:00.000Z')

    respondWith({ code: 'TimeBudgetRevisionConflict', message: 'stale' }, 409)
    await expect(deleteTimeBudgetPeriod('token', 'core-team', { scopeType: 'team' }, { periodFrom: '2026-12-01', periodTo: '2026-12-31', revision: 2, updatedAt: '2026-11-03T00:00:00.000Z' }))
      .rejects.toMatchObject({ status: 409 })
  })
})

describe('time report views', () => {
  const formatters = createTimeTrackingFormatters('en')
  const labels = {
    members: { 'aoi@example.com': 'Aoi Tanaka' },
    projects: { refero: 'Refero' },
    workItems: {},
  }
  const reportProps = {
    t,
    locale: 'en' as const,
    formatters,
    range: timeReportFixtureRange,
    groupBy: 'user' as const,
    labels,
    onChangeRange: noop,
    onChangeGroupBy: noop,
    onRetry: noop,
    onDownloadCsv: async () => undefined,
  }

  test('shows the cost column only when the server returned costs', () => {
    const manager = renderToStaticMarkup(<TimeReport {...reportProps} summary={timeReportFixtureManagerSummary} />)
    expect(manager).toContain('Actual cost')
    expect(manager).toContain('Aoi Tanaka')
    expect(manager).toContain('ren@example.com')
    expect(manager).toContain('19:30')
    expect(manager).not.toContain('time-report-own-only')
    const member = renderToStaticMarkup(<TimeReport {...reportProps} summary={timeReportFixtureMemberSummary} />)
    expect(member).not.toContain('Actual cost')
    expect(member).toContain('12:30')
    expect(member).toContain('Only the time you recorded is totalled here.')
  })

  test('labels Project rows and entries without a Project', () => {
    const summary = {
      ...timeReportFixtureMemberSummary,
      groupBy: 'project' as const,
      groups: [
        { key: 'refero', label: 'refero', minutes: 60, billableMinutes: 0, entryCount: 1 },
        { key: 'unassigned', label: 'unassigned', minutes: 30, billableMinutes: 0, entryCount: 1 },
      ],
    }
    const markup = renderToStaticMarkup(<TimeReport {...reportProps} groupBy="project" summary={summary} />)
    expect(markup).toContain('Refero')
    expect(markup).toContain('No Project')
  })

  test('labels work categories and uncategorized time', () => {
    const summary = {
      ...timeReportFixtureMemberSummary,
      groupBy: 'category' as const,
      groups: [
        { key: 'meeting', label: 'meeting', minutes: 120, billableMinutes: 0, entryCount: 1 },
        { key: 'uncategorized', label: 'uncategorized', minutes: 30, billableMinutes: 0, entryCount: 1 },
      ],
    }
    const markup = renderToStaticMarkup(<TimeReport {...reportProps} groupBy="category" summary={summary} />)
    expect(markup).toContain('Meeting')
    expect(markup).toContain('Uncategorized')
    expect(resolveTimeReportGroupBy('category')).toBe('category')
  })

  test('keeps a Workspace name that matches a built-in key, and the server name of an unknown key', () => {
    const summary = {
      ...timeReportFixtureMemberSummary,
      groupBy: 'category' as const,
      groups: [
        { key: 'meeting', label: 'meeting', minutes: 120, billableMinutes: 0, entryCount: 1 },
        { key: 'custom-sales', label: 'Sales support', minutes: 60, billableMinutes: 0, entryCount: 1 },
      ],
    }
    const settings = { categories: [{ key: 'meeting', label: 'meeting', active: true }] }
    const markup = renderToStaticMarkup(
      <TimeEntryCategoryContext value={settings}>
        <TimeReport {...reportProps} groupBy="category" summary={summary} />
      </TimeEntryCategoryContext>,
    )
    expect(markup).toContain('>meeting<')
    expect(markup).not.toContain('Meeting')
    expect(markup).toContain('Sales support')
  })

  test('refuses a period that ends before it starts', () => {
    const markup = renderToStaticMarkup(<TimeReport {...reportProps} range={{ from: '2026-11-15', to: '2026-11-09' }} summary={timeReportFixtureManagerSummary} />)
    expect(markup).toContain('The start date must be on or before the end date.')
    expect(markup).not.toContain('time-report-table')
  })

  test('shows the remaining amount and usage of a Project budget', () => {
    const markup = renderToStaticMarkup(
      <TimeBudgetPanel
        defaultCurrency="USD"
        locale="en"
        onChangeScope={noop}
        onDeletePeriod={async () => undefined}
        onRetry={noop}
        onSave={async () => undefined}
        onUseBudgetPeriod={noop}
        projects={timeReportFixtureProjects}
        reportRange={timeReportFixtureRange}
        scope={{ scopeType: 'project', projectId: 'atlas' }}
        summary={createProjectBudgetSummary()}
        t={t}
      />,
    )
    expect(markup).toContain('-¥5,000')
    expect(markup).toContain('117%')
    expect(markup).not.toContain('Team actual costs include only the Projects you manage')
  })

  test('shows the Team budget next to the actual cost of the period', () => {
    const markup = renderToStaticMarkup(
      <TimeBudgetPanel
        defaultCurrency="USD"
        locale="en"
        onChangeScope={noop}
        onDeletePeriod={async () => undefined}
        onRetry={noop}
        onSave={async () => undefined}
        onUseBudgetPeriod={noop}
        projects={timeReportFixtureProjects}
        reportRange={timeReportFixtureRange}
        scope={{ scopeType: 'team' }}
        summary={timeReportFixtureBudgetSummary}
        t={t}
      />,
    )
    expect(markup).toContain('¥500,000')
    expect(markup).toContain('¥110,000')
    expect(markup).not.toContain('¥390,000')
    expect(markup).toContain('Team actual costs include only the Projects you manage')
    expect(markup).toContain('2026-11-01 – 2026-11-30')
    expect(markup).toContain('Report this period')
    expect(markup).toContain('Edit budget')
  })

  test('compares with the budget of exactly the report period and lists the budgets per period', () => {
    const markup = renderToStaticMarkup(
      <TimeBudgetPanel
        defaultCurrency="JPY"
        locale="en"
        onChangeScope={noop}
        onDeletePeriod={async () => undefined}
        onRetry={noop}
        onSave={async () => undefined}
        onUseBudgetPeriod={noop}
        projects={timeReportFixtureProjects}
        reportRange={timeReportFixtureRange}
        scope={{ scopeType: 'team' }}
        summary={timeReportFixturePeriodBudgetSummary}
        t={t}
      />,
    )
    expect(markup).toContain('¥300,000')
    expect(markup).toContain('data-testid="time-budget-period-badge"')
    expect(markup).toContain('Budgets per period')
    expect(markup.match(/data-testid="time-budget-period-row"/gu)).toHaveLength(2)
    expect(markup).toContain('2026-12-01 – 2026-12-31')
    expect(markup).toContain('¥450,000')
    expect(markup).toContain('Add period budget')
  })

  test('shows no budget per period list for a scope without one', () => {
    const markup = renderToStaticMarkup(
      <TimeBudgetPanel
        defaultCurrency="JPY"
        locale="en"
        onChangeScope={noop}
        onDeletePeriod={async () => undefined}
        onRetry={noop}
        onSave={async () => undefined}
        onUseBudgetPeriod={noop}
        projects={timeReportFixtureProjects}
        reportRange={timeReportFixtureRange}
        scope={{ scopeType: 'team' }}
        summary={timeReportFixtureBudgetSummary}
        t={t}
      />,
    )
    expect(markup).not.toContain('time-budget-periods')
    expect(markup).not.toContain('time-budget-period-badge')
  })
})
