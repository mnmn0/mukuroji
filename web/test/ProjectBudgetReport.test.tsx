import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getProjectBudgetReport, readProjectBudgetReport } from '../src/features/time-tracking/api/projectBudgetReport'
import {
  chooseProjectBudgetReportInterval,
  formatPerformanceIndex,
  isProjectBudgetReportRangeValid,
  resolveProjectBudgetReportRange,
} from '../src/features/time-tracking/model/projectBudgetReport'
import { projectBudgetReportFixture } from '../src/features/time-tracking/reportFixtures'
import { ProjectBudgetReportPanel } from '../src/features/time-tracking/ui/ProjectBudgetReportPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Project budget report', () => {
  test('reads a valid report and rejects malformed values', () => {
    expect(readProjectBudgetReport(JSON.parse(JSON.stringify(projectBudgetReportFixture)))).toEqual(projectBudgetReportFixture)
    expect(readProjectBudgetReport({ ...projectBudgetReportFixture, interval: 'month' })).toBeUndefined()
    expect(readProjectBudgetReport({
      ...projectBudgetReportFixture,
      earnedValue: { ...projectBudgetReportFixture.earnedValue, schedulePerformanceIndex: 'fast' },
    })).toBeUndefined()
    expect(readProjectBudgetReport({ ...projectBudgetReportFixture, points: [{ date: '2026-11-02' }] })).toBeUndefined()
  })

  test('requests the report of the Team-qualified Project with its range', async () => {
    let requested: URL | undefined
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
      requested = new URL(String(input), 'http://localhost')
      return Response.json(projectBudgetReportFixture)
    }, { preconnect: originalFetch.preconnect })

    const report = await getProjectBudgetReport('token', 'core-team', 'atlas', {
      from: '2026-11-02',
      to: '2026-11-29',
      timeZone: 'Asia/Tokyo',
      interval: 'day',
    })

    expect(report.earnedValue?.schedulePerformanceIndex).toBe(0.72)
    expect(requested?.pathname).toEndWith('/teams/core-team/projects/atlas/budget-report')
    expect(requested?.searchParams.get('interval')).toBe('day')
    expect(requested?.searchParams.get('timeZone')).toBe('Asia/Tokyo')
  })

  test('opens on the budget period and picks weeks for long ranges', () => {
    expect(resolveProjectBudgetReportRange(projectBudgetReportFixture.budget, '2026-11-20')).toEqual({ from: '2026-11-02', to: '2026-11-29' })
    expect(resolveProjectBudgetReportRange(null, '2026-11-20')).toEqual({ from: '2026-08-22', to: '2026-11-20' })
    expect(chooseProjectBudgetReportInterval({ from: '2026-01-01', to: '2026-04-30' })).toBe('day')
    expect(chooseProjectBudgetReportInterval({ from: '2026-01-01', to: '2026-05-01' })).toBe('week')
    expect(isProjectBudgetReportRangeValid({ from: '2026-01-02', to: '2026-01-01' })).toBe(false)
    expect(isProjectBudgetReportRangeValid({ from: '2020-01-01', to: '2026-12-31' })).toBe(true)
    expect(isProjectBudgetReportRangeValid({ from: '2010-01-01', to: '2026-12-31' })).toBe(false)
    expect(formatPerformanceIndex(undefined)).toBe('—')
    expect(formatPerformanceIndex(0.9234)).toBe('0.92')
  })

  test('shows the indices, the money estimate, and the notes', () => {
    const html = renderToStaticMarkup(
      <ProjectBudgetReportPanel
        budgetEditPath="/teams/core-team/timesheet?view=report"
        locale="ja"
        range={{ from: '2026-11-02', to: '2026-11-29' }}
        renderLink={(path, children) => <a href={path}>{children}</a>}
        report={projectBudgetReportFixture}
        t={createTranslator('ja')}
        onChangeRange={() => undefined}
        onExport={() => undefined}
        onRetry={() => undefined}
      />,
    )

    expect(html).toContain('0.72')
    expect(html).toContain('0.92')
    expect(html).toContain('予算の 39% を消化')
    expect(html).toContain('単価のない工数 2:00')
    expect(html).toContain('終了日のないタスクの予定工数 4:00')
  })

  test('explains why earned value is missing without a baseline', () => {
    const html = renderToStaticMarkup(
      <ProjectBudgetReportPanel
        budgetEditPath="/teams/core-team/timesheet?view=report"
        locale="en"
        range={{ from: '2026-11-02', to: '2026-11-29' }}
        renderLink={(path, children) => <a href={path}>{children}</a>}
        report={{ ...projectBudgetReportFixture, baseline: null, earnedValue: null }}
        t={createTranslator('en')}
        onChangeRange={() => undefined}
        onExport={() => undefined}
        onRetry={() => undefined}
      />,
    )

    expect(html).toContain('Earned value cannot be calculated without a schedule baseline.')
  })
})
