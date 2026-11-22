import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  analyticsDateToEpochDay,
  type AnalyticsGroup,
  type AnalyticsSeriesPoint,
} from '@mukuroji/contracts'
import { AnalyticsMilestoneTrendChart } from '../src/analytics/ui/AnalyticsMilestoneTrendChart'
import {
  createAnalyticsMilestoneTrendModel,
  formatAnalyticsMilestoneShift,
} from '../src/analytics/model/milestoneTrend'
import { createTranslator } from '../src/shared/i18n/i18n'

/**
 * Returns the day number of a date.
 *
 * @param date - `YYYY-MM-DD` date.
 * @returns Days since 1970-01-01.
 */
function day(date: string) {
  const value = analyticsDateToEpochDay(date)
  if (value === undefined) throw new Error(`invalid date ${date}`)
  return value
}

const series: AnalyticsSeriesPoint[] = [
  {
    from: '2026-03-02T00:00:00.000Z',
    to: '2026-03-08T23:59:59.999Z',
    value: 1,
    sampleSize: 1,
    segments: [{ key: 'beta', value: day('2026-04-10') }],
  },
  {
    from: '2026-03-09T00:00:00.000Z',
    to: '2026-03-15T23:59:59.999Z',
    value: 2,
    sampleSize: 2,
    segments: [{ key: 'beta', value: day('2026-04-17') }, { key: 'launch', value: day('2026-05-01') }],
  },
]

const groups: AnalyticsGroup[] = [
  { key: 'beta', label: 'Beta', value: 7, sampleSize: 1 },
  { key: 'launch', label: 'Launch', value: 0, sampleSize: 0 },
]

describe('Analytics Milestone trend chart', () => {
  test('builds one line per Milestone from the segments, with gaps where the date is unknown', () => {
    const model = createAnalyticsMilestoneTrendModel(series, groups, 'UTC')

    expect(model.dates).toEqual(['2026-03-08', '2026-03-15'])
    expect(model.lines.map((line) => [line.key, line.values, line.colorIndex])).toEqual([
      ['beta', [day('2026-04-10'), day('2026-04-17')], 1],
      ['launch', [null, day('2026-05-01')], 2],
    ])
    // The first week already moved Beta, so the period start comes from the shift: April 10.
    expect(model.lines[0]?.periodStart).toBe(day('2026-04-10'))
    expect(model.lines[1]?.periodStart).toBe(day('2026-05-01'))
    expect(model.minimum).toBe(day('2026-04-10'))
    expect(model.maximum).toBe(day('2026-05-01'))
    expect(formatAnalyticsMilestoneShift(7)).toBe('+7')
    expect(formatAnalyticsMilestoneShift(null)).toBe('—')
  })

  test('keeps the period-end date unknown when the last slot hides the Milestone', () => {
    const hidden: AnalyticsGroup[] = [{ key: 'gone', label: 'Gone', value: null, sampleSize: 0 }]
    const model = createAnalyticsMilestoneTrendModel([
      { ...series[0]!, segments: [{ key: 'gone', value: day('2026-04-10') }] },
      { ...series[1]!, segments: [] },
    ], hidden, 'UTC')

    expect(model.lines[0]?.values).toEqual([day('2026-04-10'), null])
    expect(model.lines[0]?.latest).toBeNull()
    expect(model.lines[0]?.periodStart).toBeNull()
  })

  test('renders the legend with the shift and a table of dates', () => {
    const markup = renderToStaticMarkup(
      <AnalyticsMilestoneTrendChart
        groups={groups}
        label="Milestone trend"
        series={series}
        t={createTranslator('ja')}
        timeZone="UTC"
      />,
    )

    expect(markup).toContain('data-testid="analytics-milestone-trend-line-beta"')
    expect(markup).toContain('+7 日')
    expect(markup).toContain('2026-04-17')
    expect(markup).toContain('期間開始時の予定日')
    expect(markup).toContain('var(--workbench-chart-category-2)')
  })
})
