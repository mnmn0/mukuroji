import {
  ANALYTICS_SCHEMA_VERSION,
  type AnalyticsEvidenceResponse,
  type AnalyticsFilter,
  type AnalyticsReport,
  type AnalyticsSnapshot,
  type AnalyticsSnapshotRecord,
} from '@mukuroji/contracts'
import { createDefaultAnalyticsWidgets } from './model/defaults'
import { analyticsCalendarDateBoundaryToInstant } from './model/timeZone'

/**
 * Analytics Story と unit test で共有する固定 filter です。
 */
export const analyticsFilterFixture = {
  period: {
    from: '2026-06-18T00:00:00.000Z',
    to: '2026-07-17T23:59:59.999Z',
  },
  includeArchived: false,
  teamIds: ['core-team'],
} satisfies AnalyticsFilter

/**
 * Analytics Story と unit test で共有する標準 widget set です。
 */
export const analyticsWidgetFixtures = createDefaultAnalyticsWidgets()

/**
 * Saved report selector と builder を確認する report fixture です。
 */
export const analyticsReportFixtures = [
  {
    createdAt: '2026-06-02T01:00:00.000Z',
    description: 'Delivery flow, aging work, and launch confidence.',
    filter: analyticsFilterFixture,
    forecastBaseline: {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-14T23:59:59.999Z',
    },
    id: 'delivery-health',
    name: 'Delivery health',
    ownerMemberKey: 'owner@example.com',
    revision: 7,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    schedule: {
      dayOfWeek: 1,
      enabled: true,
      format: 'pdf',
      frequency: 'weekly',
      localTime: '09:00',
      nextRunAt: '2026-07-20T00:00:00.000Z',
      recipientMemberKeys: ['owner@example.com', 'lead@example.com'],
      timeZone: 'Asia/Tokyo',
    },
    teamId: 'core-team',
    timeZone: 'Asia/Tokyo',
    updatedAt: '2026-07-17T04:20:00.000Z',
    visibility: 'team',
    widgets: analyticsWidgetFixtures,
    workspaceId: 'workspace-demo',
  },
  {
    createdAt: '2026-07-01T03:00:00.000Z',
    description: 'A personal weekly review of flow metrics.',
    filter: {
      ...analyticsFilterFixture,
      teamIds: undefined,
    },
    id: 'weekly-review',
    name: 'Weekly review',
    ownerMemberKey: 'owner@example.com',
    revision: 2,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    timeZone: 'UTC',
    updatedAt: '2026-07-16T10:00:00.000Z',
    visibility: 'personal',
    widgets: analyticsWidgetFixtures.slice(0, 5),
    workspaceId: 'workspace-demo',
  },
] satisfies AnalyticsReport[]

const definitionDescriptions = {
  throughput: 'Completed work items in the selected period.',
  'cycle-time': 'Elapsed time from work start to completion.',
  wip: 'Work items in progress at the snapshot time.',
  overdue: 'Incomplete work items past their due date.',
} as const

/**
 * KPI、chart、table、forecast を一画面で確認できる snapshot fixture です。
 */
export const analyticsSnapshotFixture = {
  asOf: '2026-07-18T02:30:00.000Z',
  evidenceCount: 86,
  filter: analyticsFilterFixture,
  forecast: {
    baseline: {
      from: '2026-07-01T00:00:00.000Z',
      to: '2026-08-14T23:59:59.999Z',
    },
    confidence: 0.78,
    dailyThroughput: 1.35,
    p50: '2026-08-04T00:00:00.000Z',
    p85: '2026-08-11T00:00:00.000Z',
    p95: '2026-08-18T00:00:00.000Z',
    remainingWorkItems: 19,
    risk: 'medium',
    sampleSize: 37,
  },
  generatedAt: '2026-07-18T02:30:01.000Z',
  permissionScopeHash: 'sha256:permission-scope-demo',
  queryHash: 'sha256:demo-delivery-health',
  schemaVersion: ANALYTICS_SCHEMA_VERSION,
  timeZone: 'Asia/Tokyo',
  widgets: [
    createMetricResult('metric-throughput', 'throughput', 'items-per-week', 9.2, 37),
    createMetricResult('metric-cycle-time', 'cycle-time', 'hours', 31.4, 32),
    createMetricResult('metric-wip', 'wip', 'count', 14, 14),
    createMetricResult('metric-overdue', 'overdue', 'count', 5, 5),
    {
      ...createMetricResult('chart-throughput', 'throughput', 'items-per-week', 9.2, 37),
      series: createThroughputSeries('Asia/Tokyo'),
    },
    {
      ...createMetricResult('chart-cycle-time', 'cycle-time', 'hours', 31.4, 32),
      groups: [
        { key: 'core-team', label: 'Core team', sampleSize: 21, value: 26.8 },
        { key: 'design-team', label: 'Design team', sampleSize: 11, value: 40.2 },
      ],
    },
    {
      ...createMetricResult('table-overdue', 'overdue', 'count', 5, 5),
      rows: [
        {
          id: 'MKJ-184',
          label: 'Harden billing webhook retries',
          values: {
            occurredAt: '2026-07-16T04:20:00.000Z',
            projectId: 'refero',
            teamId: 'core-team',
            value: 1,
            workItemId: 'MKJ-184',
          },
        },
        {
          id: 'MKJ-191',
          label: 'Finalize onboarding copy',
          values: {
            occurredAt: '2026-07-15T08:10:00.000Z',
            projectId: 'product-roadmap',
            teamId: 'core-team',
            value: 1,
            workItemId: 'MKJ-191',
          },
        },
        {
          id: 'MKJ-205',
          label: 'Repair mobile focus order',
          values: {
            occurredAt: '2026-07-14T02:40:00.000Z',
            projectId: 'refero',
            teamId: 'core-team',
            value: 1,
            workItemId: 'MKJ-205',
          },
        },
      ],
    },
  ],
} satisfies AnalyticsSnapshot

/**
 * Evidence drawer の pagination と Work Item 導線を確認する fixture です。
 */
export const analyticsEvidenceFixture = {
  items: [
    {
      eventId: 'event-completed-184',
      id: 'evidence-184',
      occurredAt: '2026-07-16T04:20:00.000Z',
      projectId: 'refero',
      teamId: 'core-team',
      title: 'Harden billing webhook retries',
      value: 1,
      workItemId: 'MKJ-184',
    },
    {
      eventId: 'event-completed-191',
      id: 'evidence-191',
      occurredAt: '2026-07-15T08:10:00.000Z',
      projectId: 'product-roadmap',
      teamId: 'core-team',
      title: 'Finalize onboarding copy',
      value: 1,
      workItemId: 'MKJ-191',
    },
  ],
  nextCursor: 'cursor-demo-page-2',
} satisfies AnalyticsEvidenceResponse

const historicalWidgetFixtures = analyticsWidgetFixtures.map((widget) =>
  widget.id === 'chart-throughput'
    ? { ...widget, title: 'Historical delivery trend' }
    : widget)
const historicalFilterFixture = {
  ...analyticsFilterFixture,
  period: {
    from: '2026-05-01T00:00:00.000Z',
    to: '2026-05-31T23:59:59.999Z',
  },
  teamIds: ['design-team'],
} satisfies AnalyticsFilter
const historicalForecastBaseline = {
  from: '2026-05-01T00:00:00.000Z',
  to: '2026-06-15T23:59:59.999Z',
}

/**
 * Report revision 後も当時の query 定義を表示できる snapshot record fixture です。
 */
export const analyticsSnapshotRecordFixture = {
  createdAt: '2026-06-01T01:00:00.000Z',
  createdByMemberKey: 'owner@example.com',
  id: 'snapshot-revision-3',
  query: {
    asOf: '2026-06-01T00:00:00.000Z',
    filter: historicalFilterFixture,
    forecastBaseline: historicalForecastBaseline,
    timeZone: 'UTC',
    widgets: historicalWidgetFixtures,
  },
  reportId: analyticsReportFixtures[0].id,
  reportRevision: 3,
  snapshot: {
    ...analyticsSnapshotFixture,
    asOf: '2026-06-01T00:00:00.000Z',
    evidenceCount: 31,
    filter: historicalFilterFixture,
    forecast: {
      baseline: historicalForecastBaseline,
      confidence: 0.72,
      dailyThroughput: 0.84,
      p50: '2026-06-08T09:00:00.000Z',
      p85: '2026-06-12T09:00:00.000Z',
      p95: '2026-06-17T09:00:00.000Z',
      remainingWorkItems: 10,
      risk: 'medium',
      sampleSize: 26,
    },
    generatedAt: '2026-06-01T00:00:01.000Z',
    queryHash: 'sha256:historical-revision-3',
    timeZone: 'UTC',
    widgets: createHistoricalWidgetResults(),
  },
  workspaceId: 'workspace-demo',
} satisfies AnalyticsSnapshotRecord

function createMetricResult(
  widgetId: string,
  metric: keyof typeof definitionDescriptions,
  unit: 'count' | 'hours' | 'items-per-week',
  value: number,
  sampleSize: number,
) {
  return {
    definition: {
      description: definitionDescriptions[metric],
      key: metric,
      label: metric,
      unit,
      version: 1,
    },
    groups: [],
    metric,
    rows: [],
    sampleSize,
    series: [],
    value,
    warnings: [],
    widgetId,
  }
}

function createThroughputSeries(timeZone: string) {
  return [
    seriesPoint('2026-06-18', '2026-06-24', 7, 7, timeZone),
    seriesPoint('2026-06-25', '2026-07-01', 8, 8, timeZone),
    seriesPoint('2026-07-02', '2026-07-08', 11, 11, timeZone),
    seriesPoint('2026-07-09', '2026-07-15', 9, 9, timeZone),
    seriesPoint('2026-07-16', '2026-07-17', 2, 2, timeZone),
  ]
}

function createHistoricalWidgetResults() {
  return analyticsSnapshotFixture.widgets.map((result) => {
    if (result.widgetId === 'metric-throughput') {
      return { ...result, sampleSize: 26, value: 6.4 }
    }
    if (result.widgetId === 'metric-cycle-time') {
      return { ...result, sampleSize: 21, value: 28.7 }
    }
    if (result.widgetId === 'metric-wip') {
      return { ...result, sampleSize: 8, value: 8 }
    }
    if (result.widgetId === 'metric-overdue') {
      return { ...result, sampleSize: 2, value: 2 }
    }
    if (result.widgetId === 'chart-throughput') {
      return {
        ...result,
        sampleSize: 26,
        series: [
          seriesPoint('2026-05-01', '2026-05-03', 2, 2, 'UTC'),
          seriesPoint('2026-05-04', '2026-05-10', 5, 5, 'UTC'),
          seriesPoint('2026-05-11', '2026-05-17', 7, 7, 'UTC'),
          seriesPoint('2026-05-18', '2026-05-24', 6, 6, 'UTC'),
          seriesPoint('2026-05-25', '2026-05-31', 4, 4, 'UTC'),
        ],
        value: 6.4,
      }
    }
    if (result.widgetId === 'chart-cycle-time') {
      return {
        ...result,
        groups: [{
          key: 'design-team',
          label: 'Design team',
          sampleSize: 21,
          value: 28.7,
        }],
        sampleSize: 21,
        value: 28.7,
      }
    }
    if (result.widgetId === 'table-overdue') {
      return {
        ...result,
        rows: [
          {
            id: 'MKJ-142',
            label: 'Finalize launch illustrations',
            values: {
              occurredAt: '2026-05-28T16:30:00.000Z',
              projectId: 'shared-launch',
              teamId: 'design-team',
              value: 1,
              workItemId: 'MKJ-142',
            },
          },
          {
            id: 'MKJ-147',
            label: 'Resolve brand accessibility review',
            values: {
              occurredAt: '2026-05-24T11:15:00.000Z',
              projectId: 'brand-refresh',
              teamId: 'design-team',
              value: 1,
              workItemId: 'MKJ-147',
            },
          },
        ],
        sampleSize: 2,
        value: 2,
      }
    }
    return result
  })
}

function seriesPoint(
  from: string,
  to: string,
  value: number,
  sampleSize: number,
  timeZone: string,
) {
  return {
    from: analyticsCalendarDateBoundaryToInstant(from, timeZone, 'start'),
    sampleSize,
    to: analyticsCalendarDateBoundaryToInstant(to, timeZone, 'end'),
    value,
  }
}
