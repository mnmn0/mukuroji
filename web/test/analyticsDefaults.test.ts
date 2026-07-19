import { describe, expect, test } from 'bun:test'
import { createDefaultAnalyticsWidgets } from '../src/analytics/defaults'

describe('Analytics default widgets', () => {
  test('localizes metric titles while preserving chart and table semantics', () => {
    expect(createDefaultAnalyticsWidgets('ja').map((widget) => widget.title))
      .toEqual([
        'Throughput',
        'Cycle time',
        'WIP',
        '期限超過',
        'Throughput の推移',
        'チーム別 Cycle time',
        '期限超過 Work Item',
      ])
    expect(createDefaultAnalyticsWidgets('en').map((widget) => widget.title))
      .toEqual([
        'Throughput',
        'Cycle time',
        'WIP',
        'Overdue',
        'Throughput trend',
        'Cycle time by team',
        'Overdue work items',
      ])
  })
})
