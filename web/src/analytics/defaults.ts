import type {
  AnalyticsFilter,
  AnalyticsWidget,
} from '@mukuroji/contracts'
import { createDefaultAnalyticsFilter } from './queryState'

/**
 * New report で最初に表示する標準 widget set を生成します。
 *
 * @returns Builder から安全に変更できる新しい widget 配列です。
 */
export function createDefaultAnalyticsWidgets(): AnalyticsWidget[] {
  return [
    {
      id: 'metric-throughput',
      metric: 'throughput',
      size: 'small',
      title: 'Throughput',
      type: 'metric',
    },
    {
      id: 'metric-cycle-time',
      metric: 'cycle-time',
      size: 'small',
      title: 'Cycle time',
      type: 'metric',
    },
    {
      id: 'metric-wip',
      metric: 'wip',
      size: 'small',
      title: 'Work in progress',
      type: 'metric',
    },
    {
      id: 'metric-overdue',
      metric: 'overdue',
      size: 'small',
      title: 'Overdue',
      type: 'metric',
    },
    {
      groupBy: { dimension: 'week' },
      id: 'chart-throughput',
      metric: 'throughput',
      size: 'large',
      title: 'Throughput trend',
      type: 'chart',
      visualization: 'line',
    },
    {
      groupBy: { dimension: 'team' },
      id: 'chart-cycle-time',
      metric: 'cycle-time',
      size: 'small',
      title: 'Cycle time by team',
      type: 'chart',
      visualization: 'bar',
    },
    {
      id: 'table-overdue',
      metric: 'overdue',
      size: 'large',
      title: 'Overdue work items',
      type: 'table',
    },
  ]
}

/**
 * Report が存在しない workspace で example 実行に使う query definition を作ります。
 *
 * @param now - Example の期間終端を決める日時です。
 * @param timeZone - 直近30 calendar daysを解釈する IANA timezone です。
 * @returns 直近30日の filter と標準 widget set です。
 */
export function createExampleAnalyticsDefinition(
  now = new Date(),
  timeZone = getDefaultAnalyticsTimeZone(),
): {
  filter: AnalyticsFilter
  widgets: AnalyticsWidget[]
} {
  return {
    filter: createDefaultAnalyticsFilter(now, timeZone),
    widgets: createDefaultAnalyticsWidgets(),
  }
}

/**
 * Browser が解決できる timezone、または UTC fallback を返します。
 *
 * @returns IANA timezone identifier です。
 */
export function getDefaultAnalyticsTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}
