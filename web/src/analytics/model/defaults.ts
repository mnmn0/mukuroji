import type {
  AnalyticsFilter,
  AnalyticsMetricKey,
  AnalyticsWidget,
} from '@mukuroji/contracts'
import {
  createTranslator,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import { createDefaultAnalyticsFilter } from './queryState'

const metricLabelKeys: Readonly<Record<AnalyticsMetricKey, MessageKey>> = {
  throughput: 'analytics.metric.throughput',
  'cycle-time': 'analytics.metric.cycleTime',
  'lead-time': 'analytics.metric.leadTime',
  wip: 'analytics.metric.wip',
  overdue: 'analytics.metric.overdue',
  'scope-change': 'analytics.metric.scopeChange',
  velocity: 'analytics.metric.velocity',
  sla: 'analytics.metric.sla',
}

/**
 * New report で最初に表示する標準 widget set を生成します。
 *
 * @param locale - Widget title の翻訳に使う表示 locale です。
 * @returns Builder から安全に変更できる新しい widget 配列です。
 */
export function createDefaultAnalyticsWidgets(
  locale: Locale = 'en',
): AnalyticsWidget[] {
  const t = createTranslator(locale)
  const metricTitle = (metric: AnalyticsMetricKey) =>
    t(metricLabelKeys[metric])

  return [
    {
      id: 'metric-throughput',
      metric: 'throughput',
      size: 'small',
      title: metricTitle('throughput'),
      type: 'metric',
    },
    {
      id: 'metric-cycle-time',
      metric: 'cycle-time',
      size: 'small',
      title: metricTitle('cycle-time'),
      type: 'metric',
    },
    {
      id: 'metric-wip',
      metric: 'wip',
      size: 'small',
      title: metricTitle('wip'),
      type: 'metric',
    },
    {
      id: 'metric-overdue',
      metric: 'overdue',
      size: 'small',
      title: metricTitle('overdue'),
      type: 'metric',
    },
    {
      groupBy: { dimension: 'week' },
      id: 'chart-throughput',
      metric: 'throughput',
      size: 'large',
      title: t('analytics.defaultWidget.throughputTrend'),
      type: 'chart',
      visualization: 'line',
    },
    {
      groupBy: { dimension: 'team' },
      id: 'chart-cycle-time',
      metric: 'cycle-time',
      size: 'small',
      title: t('analytics.defaultWidget.cycleTimeByTeam'),
      type: 'chart',
      visualization: 'bar',
    },
    {
      id: 'table-overdue',
      metric: 'overdue',
      size: 'large',
      title: t('analytics.defaultWidget.overdueWorkItems'),
      type: 'table',
    },
  ]
}

/**
 * Report が存在しない workspace で example 実行に使う query definition を作ります。
 *
 * @param now - Example の期間終端を決める日時です。
 * @param timeZone - 直近30 calendar daysを解釈する IANA timezone です。
 * @param locale - Widget title の翻訳に使う表示 locale です。
 * @returns 直近30日の filter と標準 widget set です。
 */
export function createExampleAnalyticsDefinition(
  now = new Date(),
  timeZone = getDefaultAnalyticsTimeZone(),
  locale: Locale = 'en',
): {
  filter: AnalyticsFilter
  widgets: AnalyticsWidget[]
} {
  return {
    filter: createDefaultAnalyticsFilter(now, timeZone),
    widgets: createDefaultAnalyticsWidgets(locale),
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
