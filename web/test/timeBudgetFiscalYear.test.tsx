import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  findTimeBudgetFiscalYear,
  listTimeBudgetFiscalYearOptions,
} from '../src/features/time-tracking/model/budgetFiscalYear'
import { timeReportFixtureBudgetSummary, timeReportFixtureProjects } from '../src/features/time-tracking/reportFixtures'
import { TimeBudgetPanel } from '../src/features/time-tracking/ui/TimeBudgetPanel'
import { createTranslator } from '../src/shared/i18n/i18n'

const noop = () => undefined

describe('budget periods by fiscal year', () => {
  test('offers the previous, current, and next fiscal year', () => {
    expect(listTimeBudgetFiscalYearOptions('2026-11-23', 4)).toEqual([
      { fiscalYear: 2025, from: '2025-04-01', to: '2026-03-31' },
      { fiscalYear: 2026, from: '2026-04-01', to: '2027-03-31' },
      { fiscalYear: 2027, from: '2027-04-01', to: '2028-03-31' },
    ])
    expect(listTimeBudgetFiscalYearOptions('2027-02-10', 4)[1]).toEqual({
      fiscalYear: 2026,
      from: '2026-04-01',
      to: '2027-03-31',
    })
    expect(listTimeBudgetFiscalYearOptions('2026-11-23', 1)[1]).toEqual({
      fiscalYear: 2026,
      from: '2026-01-01',
      to: '2026-12-31',
    })
  })

  test('names a period that is exactly one fiscal year', () => {
    expect(findTimeBudgetFiscalYear('2026-04-01', '2027-03-31', 4)).toBe(2026)
    expect(findTimeBudgetFiscalYear('2026-04-01', '2027-03-30', 4)).toBeUndefined()
    expect(findTimeBudgetFiscalYear('2026-01-01', '2026-12-31', 4)).toBeUndefined()
    expect(findTimeBudgetFiscalYear('2026-04-01', undefined, 4)).toBeUndefined()
    expect(findTimeBudgetFiscalYear('bad', '2027-03-31', 4)).toBeUndefined()
  })

  test('labels a saved fiscal-year budget with its fiscal year', () => {
    const summary = {
      ...timeReportFixtureBudgetSummary,
      budget: timeReportFixtureBudgetSummary.budget
        ? { ...timeReportFixtureBudgetSummary.budget, periodFrom: '2026-04-01', periodTo: '2027-03-31' }
        : undefined,
    }
    const render = (fiscalYearStartMonth?: number) => renderToStaticMarkup(
      <TimeBudgetPanel
        defaultCurrency="JPY"
        fiscalYearStartMonth={fiscalYearStartMonth}
        locale="ja"
        onChangeScope={noop}
        onDeletePeriod={async () => undefined}
        onRetry={noop}
        onSave={async () => undefined}
        onUseBudgetPeriod={noop}
        projects={timeReportFixtureProjects}
        scope={{ scopeType: 'team' }}
        summary={summary}
        t={createTranslator('ja')}
      />,
    )

    expect(render(4)).toContain('2026年度')
    expect(render(1)).not.toContain('data-testid="time-budget-fiscal-year"')
    expect(render()).not.toContain('data-testid="time-budget-fiscal-year"')
  })
})
