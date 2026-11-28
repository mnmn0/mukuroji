import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS, type WorkspaceInvestmentCategorySettings } from '@mukuroji/contracts'
import { getTeamInvestmentAssignments, saveTeamInvestmentAssignments } from '../src/features/time-tracking/api/investmentAssignments'
import { downloadTimeTrackingCsv, getTimeTrackingSummary } from '../src/features/time-tracking/api/timeReport'
import {
  listInvestmentCategoryChoices,
  setProjectInvestmentCategory,
  setWorkItemInvestmentCategory,
} from '../src/features/time-tracking/model/investmentAssignments'
import { timeReportFixtureInvestmentSummary, timeReportFixtureRange } from '../src/features/time-tracking/reportFixtures'
import { InvestmentAssignmentsPanel } from '../src/features/time-tracking/ui/InvestmentAssignmentsPanel'
import { TimeReport } from '../src/features/time-tracking/ui/TimeReport'
import { createTimeTrackingFormatters } from '../src/features/time-tracking/ui/timeTrackingText'
import { createTranslator } from '../src/shared/i18n/i18n'
import {
  addInvestmentCategory,
  hasInvestmentCategoryProblem,
  measureInvestmentTime,
  readInvestmentCategoryDisplayName,
  summarizeInvestmentGroups,
} from '../src/workspace/model/investmentCategories'

const originalFetch = globalThis.fetch
const ja = createTranslator('ja')
const en = createTranslator('en')
const noop = () => undefined

afterEach(() => {
  globalThis.fetch = originalFetch
})

/**
 * Replaces fetch with one that records requested URLs and bodies and returns a JSON body.
 *
 * @param body - Response body.
 * @returns Requests seen by the mock.
 */
function respondWith(body: unknown): { url: URL; body: unknown }[] {
  const requests: { url: URL; body: unknown }[] = []
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      url: new URL(String(input), 'http://localhost'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 })
  }, { preconnect: originalFetch.preconnect })
  return requests
}

const settings: WorkspaceInvestmentCategorySettings = {
  categories: [
    ...DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS.categories,
    { key: 'custom-rnd', label: '研究', group: 'capex', active: false },
  ],
  personMonthHours: 160,
}

test('names categories, adds one, and measures person-months, share, and Capex and Opex', () => {
  expect(readInvestmentCategoryDisplayName('custom-rnd', settings, ja)).toBe('研究')
  expect(readInvestmentCategoryDisplayName('operations', settings, ja)).toBe(ja('workspace.investmentCategory.operations'))
  expect(readInvestmentCategoryDisplayName('unclassified', settings, ja)).toBe(ja('workspace.investmentCategory.unclassified'))
  expect(readInvestmentCategoryDisplayName('custom-gone', settings, ja)).toBe('custom-gone')

  const added = addInvestmentCategory(settings, ' 監査対応 ', 'opex', () => 'abc')
  expect(added.categories.at(-1)).toEqual({ key: 'custom-abc', label: '監査対応', group: 'opex', active: true })
  expect(addInvestmentCategory(settings, '  ', 'opex')).toBe(settings)
  expect(hasInvestmentCategoryProblem(DEFAULT_WORKSPACE_INVESTMENT_CATEGORY_SETTINGS)).toBe(false)
  expect(hasInvestmentCategoryProblem({ ...settings, personMonthHours: 0 })).toBe(true)

  expect(measureInvestmentTime(9_600, settings, 19_200)).toEqual({ personMonths: 1, sharePercent: 50 })
  expect(measureInvestmentTime(0, settings, 0)).toEqual({ personMonths: 0, sharePercent: 0 })
  const groups = summarizeInvestmentGroups(timeReportFixtureInvestmentSummary.groups, settings, timeReportFixtureInvestmentSummary.totalMinutes)
  expect(groups.map((row) => [row.key, row.minutes])).toEqual([['capex', 600], ['opex', 480]])
})

test('edits assignments and offers a retired category only where it is held', () => {
  const assignments = { projects: { atlas: 'maintenance' }, workItems: {} }
  expect(setProjectInvestmentCategory(assignments, 'atlas', '').projects).toEqual({})
  expect(setWorkItemInvestmentCategory(assignments, 'wi-1', 'operations').workItems).toEqual({ 'wi-1': 'operations' })
  expect(listInvestmentCategoryChoices(settings, undefined).some((choice) => choice.key === 'custom-rnd')).toBe(false)
  expect(listInvestmentCategoryChoices(settings, 'custom-rnd').at(-1)).toEqual({ key: 'custom-rnd', retired: true })
  expect(listInvestmentCategoryChoices(settings, 'custom-gone').at(-1)).toEqual({ key: 'custom-gone', retired: true })
})

test('reads and saves assignments and sends the Project filter with the report and its CSV', async () => {
  const view = { canEdit: true, assignments: { teamId: 'core', revision: 2, projects: { atlas: 'maintenance' }, workItems: {} } }
  respondWith(view)
  expect(await getTeamInvestmentAssignments('token', 'core')).toEqual(view)

  const saved = respondWith(view)
  await saveTeamInvestmentAssignments('token', 'core', { projects: { atlas: 'maintenance' }, workItems: {}, expectedRevision: 1 })
  expect(saved[0]?.body).toEqual({ projects: { atlas: 'maintenance' }, workItems: {}, expectedRevision: 1 })

  respondWith({ ...view, assignments: { ...view.assignments, projects: { atlas: '' } } })
  await expect(getTeamInvestmentAssignments('token', 'core')).rejects.toThrow()

  const input = { from: '2026-11-01', to: '2026-11-30', timeZone: 'Asia/Tokyo', groupBy: 'investment' as const, filterProjectId: 'atlas' }
  const reports = respondWith(timeReportFixtureInvestmentSummary)
  expect(await getTimeTrackingSummary('token', 'core', input)).toEqual(timeReportFixtureInvestmentSummary)
  expect(reports[0]?.url.searchParams.get('groupBy')).toBe('investment')
  expect(reports[0]?.url.searchParams.get('filterProjectId')).toBe('atlas')

  const exports = respondWith('csv')
  await downloadTimeTrackingCsv('token', 'core', input)
  expect(exports[0]?.url.searchParams.get('filterProjectId')).toBe('atlas')
})

test('shows person-months, share, Capex and Opex, and the Project filter', () => {
  const markup = renderToStaticMarkup(
    <TimeReport
      formatters={createTimeTrackingFormatters('en')}
      groupBy="investment"
      investmentCategories={settings}
      labels={{ members: {}, projects: {}, workItems: {} }}
      locale="en"
      onChangeGroupBy={noop}
      onChangeRange={noop}
      onDownloadCsv={async () => undefined}
      onRetry={noop}
      projectFilter={{ options: [{ id: 'atlas', name: 'Atlas' }], projectId: 'atlas', onChange: noop }}
      range={timeReportFixtureRange}
      summary={timeReportFixtureInvestmentSummary}
      t={en}
    />,
  )
  expect(markup).toContain(en('timeTracking.report.column.personMonths'))
  expect(markup).toContain(en('timeTracking.report.column.share'))
  expect(markup).toContain(en('workspace.investmentCategory.newDevelopment'))
  expect(markup).toContain(en('workspace.investmentGroup.capex'))
  expect(markup).toContain(en('timeTracking.report.investmentGroups'))
  expect(markup).toContain('>Atlas<')
})

test('says why the investment columns are missing when the categories fail to load', () => {
  const markup = renderToStaticMarkup(
    <TimeReport
      formatters={createTimeTrackingFormatters('en')}
      groupBy="investment"
      hasInvestmentCategoriesError
      labels={{ members: {}, projects: {}, workItems: {} }}
      locale="en"
      onChangeGroupBy={noop}
      onChangeRange={noop}
      onDownloadCsv={async () => undefined}
      onRetry={noop}
      onRetryInvestmentCategories={noop}
      range={timeReportFixtureRange}
      summary={timeReportFixtureInvestmentSummary}
      t={en}
    />,
  )
  expect(markup).toContain('data-testid="time-report-investment-error"')
  expect(markup).toContain(en('timeTracking.report.investmentCategoriesLoadError'))
  expect(markup).not.toContain(en('timeTracking.report.column.personMonths'))
})

test('lists Project defaults and Work Item overrides for managers', () => {
  const markup = renderToStaticMarkup(
    <InvestmentAssignmentsPanel
      onRetry={noop}
      onSave={async () => undefined}
      projects={[{ id: 'atlas', name: 'Atlas' }]}
      settings={settings}
      t={en}
      view={{ canEdit: true, assignments: { teamId: 'core', revision: 1, projects: { atlas: 'custom-rnd' }, workItems: { 'wi-1': 'operations' } } }}
      workItems={[{ id: 'wi-1', name: 'Fix login' }, { id: 'wi-2', name: 'Add export' }]}
    />,
  )
  expect(markup).toContain('data-testid="investment-assignments-panel"')
  expect(markup).toContain('研究 (retired)')
  expect(markup).toContain('Fix login')
  expect(markup).toContain('Add export')
  expect(markup).toContain(en('timeTracking.investment.add'))
})
