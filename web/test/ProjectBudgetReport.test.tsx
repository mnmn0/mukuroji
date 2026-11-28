import { afterEach, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { getProjectBudgetReport, readProjectBudgetReport } from '../src/features/time-tracking/api/projectBudgetReport'
import {
  chooseProjectBudgetReportInterval,
  formatPerformanceIndex,
  isProjectBudgetReportRangeValid,
  listIsolatedPoints,
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
    // 2026-01-05 is a Monday: 400 Monday-based weeks fit, one more day starts the 401st.
    expect(isProjectBudgetReportRangeValid({ from: '2026-01-05', to: '2033-09-04' })).toBe(true)
    expect(isProjectBudgetReportRangeValid({ from: '2026-01-05', to: '2033-09-05' })).toBe(false)
    expect(formatPerformanceIndex(undefined)).toBe('—')
    expect(formatPerformanceIndex(0.9234)).toBe('0.92')
    expect(listIsolatedPoints([5])).toEqual([0])
    expect(listIsolatedPoints([1, null, 3, 4, null, 6])).toEqual([0, 5])
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

  test('reads and shows the coding agent cost the budget counts (ADR 0119)', () => {
    const included = {
      ...projectBudgetReportFixture,
      agentCost: { status: 'included' as const, estimatedCostMicroUsd: 80_000_000, amountMinor: 12_000, usdExchangeRate: 150, runCount: 14, truncated: true },
    }
    expect(readProjectBudgetReport(JSON.parse(JSON.stringify(included)))).toEqual(included)
    expect(readProjectBudgetReport({ ...included, agentCost: { ...included.agentCost, amountMinor: -1 } })).toBeUndefined()
    expect(readProjectBudgetReport({
      ...included,
      agentCost: { status: 'missing-exchange-rate', estimatedCostMicroUsd: 1, runCount: 1, truncated: false, amountMinor: 1 },
    })).toBeUndefined()

    const html = renderToStaticMarkup(
      <ProjectBudgetReportPanel
        budgetEditPath="/teams/core-team/timesheet?view=report"
        locale="ja"
        range={{ from: '2026-11-02', to: '2026-11-29' }}
        renderLink={(path, children) => <a href={path}>{children}</a>}
        report={included}
        t={createTranslator('ja')}
        onChangeRange={() => undefined}
        onExport={() => undefined}
        onRetry={() => undefined}
      />,
    )
    // Time cost 468,000 plus 12,000 of agent cost.
    expect(html).toContain('480,000')
    expect(html).toContain('うち coding agent の推定費用')
    expect(html).toContain('下限の値です')
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
