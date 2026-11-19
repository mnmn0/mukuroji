import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { downloadTimeTrackingCsv, getTimeTrackingSummary, saveTimeBudget } from '../src/features/time-tracking/api/timeReport'
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
  timeReportFixtureProjects,
  timeReportFixtureRange,
} from '../src/features/time-tracking/reportFixtures'
import { TimeBudgetPanel } from '../src/features/time-tracking/ui/TimeBudgetPanel'
import { TimeReport } from '../src/features/time-tracking/ui/TimeReport'
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

  test('compares the Team or a Project budget with the actual cost of the period', () => {
    expect(compareTimeBudget(timeReportFixtureBudgetSummary)).toMatchObject({
      actualMinor: 110_000,
      remainingMinor: 390_000,
      usedPercent: 22,
      actualMinutes: 1_170,
    })
    const teamBudget = timeReportFixtureBudgetSummary.budget
    if (!teamBudget) throw new Error('The budget fixture has no budget.')
    const projectBudget = {
      ...timeReportFixtureBudgetSummary,
      budget: { ...teamBudget, scopeType: 'project' as const, scopeId: 'atlas', amountMinor: 30_000 },
    }
    expect(compareTimeBudget(projectBudget, 'atlas')).toMatchObject({ actualMinor: 35_000, remainingMinor: -5_000, usedPercent: 117, actualMinutes: 420 })
    expect(compareTimeBudget(projectBudget, 'unknown')).toMatchObject({ actualMinor: 0, actualMinutes: 0 })
    expect(compareTimeBudget(timeReportFixtureManagerSummary)).toBeUndefined()
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

    respondWith({ ...timeReportFixtureMemberSummary, groupBy: 'team' })
    await expect(getTimeTrackingSummary('token', 'core-team', { ...timeReportFixtureRange, timeZone: 'UTC', groupBy: 'day' }))
      .rejects.toBeInstanceOf(TimeTrackingApiError)
    respondWith({ ...timeReportFixtureMemberSummary, budget: { amountMinor: 'many' } })
    await expect(getTimeTrackingSummary('token', 'core-team', { ...timeReportFixtureRange, timeZone: 'UTC', groupBy: 'day' }))
      .rejects.toBeInstanceOf(TimeTrackingApiError)
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
    await saveTimeBudget('token', 'core-team', { scopeType: 'team' }, { amountMinor: 500_000, currency: 'JPY', periodFrom: '2026-11-01', periodTo: '2026-11-30', expectedRevision: 2 })
    expect(requests[0]?.method).toBe('PUT')
    expect(requests[0]?.url.pathname).toBe('/api/teams/core-team/time-budget')
    expect(requests[0]?.body).toEqual({ amountMinor: 500_000, currency: 'JPY', periodFrom: '2026-11-01', periodTo: '2026-11-30', expectedRevision: 2 })

    requests = respondWith({ budget: { ...budget, scopeType: 'project', scopeId: 'atlas' } })
    await saveTimeBudget('token', 'core-team', { scopeType: 'project', projectId: 'atlas' }, { amountMinor: 1_000, currency: 'USD', expectedRevision: 0 })
    expect(requests[0]?.url.pathname).toBe('/api/teams/core-team/projects/atlas/time-budget')
    expect(requests[0]?.body).toEqual({ amountMinor: 1_000, currency: 'USD', expectedRevision: 0 })

    respondWith({ budget: { amountMinor: 1 } })
    await expect(saveTimeBudget('token', 'core-team', { scopeType: 'team' }, { amountMinor: 1, currency: 'USD', expectedRevision: 0 }))
      .rejects.toBeInstanceOf(TimeTrackingApiError)
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
    const member = renderToStaticMarkup(<TimeReport {...reportProps} summary={timeReportFixtureMemberSummary} />)
    expect(member).not.toContain('Actual cost')
    expect(member).toContain('12:30')
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

  test('refuses a period that ends before it starts', () => {
    const markup = renderToStaticMarkup(<TimeReport {...reportProps} range={{ from: '2026-11-15', to: '2026-11-09' }} summary={timeReportFixtureManagerSummary} />)
    expect(markup).toContain('The start date must be on or before the end date.')
    expect(markup).not.toContain('time-report-table')
  })

  test('shows the budget next to the actual cost of the period', () => {
    const markup = renderToStaticMarkup(
      <TimeBudgetPanel
        defaultCurrency="USD"
        locale="en"
        onChangeScope={noop}
        onRetry={noop}
        onSave={async () => undefined}
        onUseBudgetPeriod={noop}
        projects={timeReportFixtureProjects}
        scope={{ scopeType: 'team' }}
        summary={timeReportFixtureBudgetSummary}
        t={t}
      />,
    )
    expect(markup).toContain('¥500,000')
    expect(markup).toContain('¥110,000')
    expect(markup).toContain('¥390,000')
    expect(markup).toContain('22%')
    expect(markup).toContain('2026-11-01 – 2026-11-30')
    expect(markup).toContain('Report this period')
    expect(markup).toContain('Edit budget')
  })
})
