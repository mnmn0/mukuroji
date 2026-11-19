import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AnalyticsSeriesPoint, PlanningEntity } from '@mukuroji/contracts'
import { AnalyticsFlowChart } from '../src/analytics/ui/AnalyticsFlowChart'
import { CycleBurndownPanel } from '../src/analytics/ui/CycleBurndownPanel'
import { createAnalyticsFlowChartModel } from '../src/analytics/model/flowChart'
import { createCycleBurndownQuery } from '../src/analytics/model/cycleBurndown'
import { planningSnapshotFixture } from '../src/planning/fixtures'
import { createTranslator } from '../src/shared/i18n/i18n'

const series: AnalyticsSeriesPoint[] = [
  {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-01T23:59:59.999Z',
    value: 4,
    sampleSize: 4,
    segments: [{ key: 'scope', value: 4 }, { key: 'completed', value: 0 }],
  },
  {
    from: '2026-01-02T00:00:00.000Z',
    to: '2026-01-02T23:59:59.999Z',
    value: 3,
    sampleSize: 3,
    segments: [{ key: 'scope', value: 5 }, { key: 'completed', value: 2 }],
  },
]

const flowSeries: AnalyticsSeriesPoint[] = series.map((point, index) => ({
  ...point,
  segments: [
    { key: 'completed', value: index },
    { key: 'started', value: 2 },
    { key: 'unstarted', value: 1 },
    { key: 'backlog', value: 1 },
    { key: 'canceled', value: 0 },
  ],
}))

describe('Analytics flow chart', () => {
  test('pads a burndown to the planned end and draws the ideal line to zero', () => {
    const model = createAnalyticsFlowChartModel(series, 'burndown', {
      timeZone: 'UTC',
      plannedEndDate: '2026-01-05',
    })
    expect(model.dates).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'])
    expect(model.layers.find((layer) => layer.key === 'remaining')?.values).toEqual([4, 3, null, null, null])
    expect(model.layers.find((layer) => layer.key === 'ideal')?.values).toEqual([4, 3, 2, 1, 0])
  })

  test('labels weekly and monthly observations by bucket end and pads by bucket', () => {
    // 2026-01-05 is a Monday. The current week is clipped at asOf (Wednesday).
    const weekly: AnalyticsSeriesPoint[] = [
      { from: '2026-01-05T00:00:00.000Z', to: '2026-01-11T23:59:59.999Z', value: 6, sampleSize: 6 },
      { from: '2026-01-12T00:00:00.000Z', to: '2026-01-14T12:00:00.000Z', value: 4, sampleSize: 4 },
    ]
    const week = createAnalyticsFlowChartModel(weekly, 'burndown', {
      granularity: 'week',
      plannedEndDate: '2026-01-28',
      timeZone: 'UTC',
    })
    expect(week.dates).toEqual(['2026-01-11', '2026-01-14', '2026-01-25', '2026-01-28'])
    expect(week.layers.find((layer) => layer.key === 'remaining')?.values).toEqual([6, 4, null, null])

    const monthly: AnalyticsSeriesPoint[] = [
      { from: '2026-01-15T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z', value: 6, sampleSize: 6 },
    ]
    const month = createAnalyticsFlowChartModel(monthly, 'burndown', {
      granularity: 'month',
      plannedEndDate: '2026-03-10',
      timeZone: 'UTC',
    })
    expect(month.dates).toEqual(['2026-01-31', '2026-02-28', '2026-03-10'])
  })

  test('draws burnup scope and completed lines and stacks cumulative flow', () => {
    const burnup = createAnalyticsFlowChartModel(series, 'burnup', { timeZone: 'UTC' })
    expect(burnup.layers.map((layer) => [layer.key, layer.values])).toEqual([
      ['scope', [4, 5]],
      ['completed', [0, 2]],
    ])
    const flow = createAnalyticsFlowChartModel(flowSeries, 'area', { timeZone: 'UTC' })
    expect(flow.layers.find((layer) => layer.key === 'backlog')).toMatchObject({
      values: [4, 5],
      baseValues: [3, 4],
      ownValues: [1, 1],
    })
    expect(flow.maximum).toBe(5)
  })

  test('renders a legend, areas, and a table view', () => {
    const html = renderToStaticMarkup(
      <AnalyticsFlowChart
        label="Flow"
        locale="en"
        series={flowSeries}
        t={createTranslator('en')}
        timeZone="UTC"
        visualization="area"
      />,
    )
    expect(html).toContain('data-testid="analytics-flow-area-completed"')
    expect(html).toContain('Backlog')
    expect(html).toContain('<table')
  })
})

describe('Cycle burndown panel', () => {
  const t = createTranslator('en')
  const cycle: PlanningEntity = {
    ...planningSnapshotFixture.entities[0]!,
    id: 'cycle-1',
    type: 'cycle',
    title: 'Sprint 1',
    baseline: { startDate: '2026-01-01', endDate: '2026-01-05' },
  }

  test('draws a single first-day observation as a point', () => {
    const html = renderToStaticMarkup(
      <CycleBurndownPanel
        cycle={cycle}
        locale="en"
        state={{ kind: 'ready', series: series.slice(0, 1) }}
        t={t}
        timeZone="UTC"
      />,
    )
    expect(html).toContain('data-testid="analytics-flow-point-remaining-0"')
  })

  test('offers a retry when loading fails', () => {
    const html = renderToStaticMarkup(
      <CycleBurndownPanel
        cycle={cycle}
        locale="en"
        onRetry={() => undefined}
        state={{ kind: 'error' }}
        t={t}
        timeZone="UTC"
      />,
    )
    expect(html).toContain('role="alert"')
    expect(html).toContain('>Retry</button>')
  })
})

describe('Cycle burndown query', () => {
  const cycle: PlanningEntity = {
    ...planningSnapshotFixture.entities[0]!,
    id: 'cycle-1',
    type: 'cycle',
    title: 'Sprint 1',
    baseline: { startDate: '2026-01-01', endDate: '2026-01-14' },
  }
  const link = {
    teamId: 'core',
    workItemId: 'item-1',
    goalIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  }

  test('lists the Work Items linked to the Cycle over its baseline', () => {
    const plan = createCycleBurndownQuery(
      cycle,
      [
        { ...link, cycleId: 'cycle-1' },
        { ...link, workItemId: 'item-2', cycleId: 'other' },
      ],
      'Asia/Tokyo',
      new Date('2026-01-05T00:00:00.000Z'),
    )
    expect(plan.kind).toBe('query')
    if (plan.kind !== 'query') return
    expect(plan.query.filter).toEqual({
      period: {
        from: '2025-12-31T15:00:00.000Z',
        to: '2026-01-14T14:59:59.999Z',
      },
      workItems: [{ teamId: 'core', workItemId: 'item-1' }],
    })
    expect(plan.query.widgets[0]).toMatchObject({ metric: 'remaining-scope', visualization: 'burndown' })
  })

  test('skips Cycles without links, with too many links, or not yet started', () => {
    const now = new Date('2026-01-05T00:00:00.000Z')
    expect(createCycleBurndownQuery(cycle, [], 'UTC', now).kind).toBe('empty')
    expect(createCycleBurndownQuery(
      cycle,
      Array.from({ length: 501 }, (_, index) => ({ ...link, workItemId: `item-${index}`, cycleId: 'cycle-1' })),
      'UTC',
      now,
    ).kind).toBe('too-many')
    expect(createCycleBurndownQuery(
      cycle,
      [{ ...link, cycleId: 'cycle-1' }],
      'UTC',
      new Date('2025-12-30T00:00:00.000Z'),
    ).kind).toBe('not-started')
  })
})
