import type { Meta, StoryObj } from '@storybook/react-vite'
import type { AnalyticsFilter } from '@mukuroji/contracts'
import { AnalyticsWorkbench } from '../analytics/AnalyticsWorkbench'
import {
  analyticsEvidenceFixture,
  analyticsFilterFixture,
  analyticsReportFixtures,
  analyticsSnapshotFixture,
  analyticsSnapshotRecordFixture,
  analyticsWidgetFixtures,
} from '../analytics/fixtures'
import { projectDirectoryFixtures } from '../projects/fixtures'

const customFieldGroupingWidgets = analyticsWidgetFixtures.map((widget) =>
  widget.id === 'chart-cycle-time'
    ? {
        ...widget,
        groupBy: {
          customFieldId: 'impact',
          dimension: 'custom-field' as const,
        },
      }
    : widget)

const multipleFilters = {
  ...analyticsFilterFixture,
  assigneeUserIds: ['owner@example.com', 'reviewer@example.com'],
  customFields: [
    {
      fieldId: 'impact',
      operator: 'not-equals' as const,
      value: 'low',
    },
    {
      fieldId: 'launch-date',
      operator: 'is-empty' as const,
    },
  ],
  projectIds: ['refero', 'brand-refresh'],
  statusCategories: ['started', 'completed'],
  teamIds: ['core-team', 'design-team'],
} satisfies AnalyticsFilter

/**
 * Analytics report workbench の Storybook meta です。
 */
const meta = {
  args: {
    builder: false,
    canManageReports: true,
    filter: analyticsFilterFixture,
    forecastBaseline: analyticsReportFixtures[0].forecastBaseline,
    locale: 'ja',
    reports: analyticsReportFixtures,
    selectedReportId: analyticsReportFixtures[0].id,
    snapshot: analyticsSnapshotFixture,
    snapshots: [],
    teams: projectDirectoryFixtures,
    timeZone: 'Asia/Tokyo',
    widgets: analyticsWidgetFixtures,
    onBuilderChange: () => undefined,
    onCloseEvidence: () => undefined,
    onCreateBlank: () => undefined,
    onCreateSnapshot: async () => undefined,
    onDeleteReport: async () => undefined,
    onExport: async () => undefined,
    onFilterChange: () => undefined,
    onLoadMoreEvidence: () => undefined,
    onOpenEvidence: () => undefined,
    onOpenWorkItem: () => undefined,
    onRetry: () => undefined,
    onSaveReport: async () => undefined,
    onSaveSchedule: async () => undefined,
    onSelectReport: () => undefined,
    onSelectSnapshot: () => undefined,
    onShare: async () => undefined,
    onStartExample: () => undefined,
    onTimeZoneChange: () => undefined,
    onWidgetsChange: () => undefined,
  },
  component: AnalyticsWorkbench,
  parameters: {
    layout: 'fullscreen',
  },
  title: 'Application/Pages/ReportsPage',
} satisfies Meta<typeof AnalyticsWorkbench>

export default meta

/**
 * ReportsPage stories の型です。
 */
type Story = StoryObj<typeof meta>

/**
 * KPI、chart、table、forecast を含む標準 report view です。
 */
export const Overview: Story = {}

/**
 * Widget palette と構成 editor を開いた report builder です。
 */
export const Builder: Story = {
  args: {
    builder: true,
  },
}

/**
 * Custom field ID を dimension として設定する report builder です。
 */
export const CustomFieldGrouping: Story = {
  args: {
    builder: true,
    widgets: customFieldGroupingWidgets,
  },
}

/**
 * 複数の dimension と custom field 条件を同時編集する filter state です。
 */
export const MultipleFilters: Story = {
  args: {
    filter: multipleFilters,
  },
}

/**
 * Metric から Work Item evidence を確認する drawer state です。
 */
export const DrillDown: Story = {
  args: {
    evidence: analyticsEvidenceFixture,
    evidenceMetric: 'throughput',
  },
}

/**
 * Report がまだない Workspace の onboarding state です。
 */
export const Empty: Story = {
  args: {
    filter: analyticsFilterFixture,
    reports: [],
    selectedReportId: undefined,
    snapshot: undefined,
    widgets: [],
  },
}

/**
 * Report と analytics query の初回 loading state です。
 */
export const Loading: Story = {
  args: {
    isLoading: true,
    snapshot: undefined,
  },
}

/**
 * 履歴不足で予測信頼度が低い forecast state です。
 */
export const LowConfidence: Story = {
  args: {
    snapshot: {
      ...analyticsSnapshotFixture,
      forecast: {
        confidence: 0.18,
        dailyThroughput: 0,
        p50: null,
        p85: null,
        p95: null,
        remainingWorkItems: 19,
        risk: 'unknown',
        sampleSize: 2,
      },
    },
  },
}

/**
 * Report 更新後も旧 revision の query 定義を再現する snapshot view です。
 */
export const HistoricalSnapshot: Story = {
  args: {
    filter: analyticsSnapshotRecordFixture.query.filter,
    forecastBaseline: analyticsSnapshotRecordFixture.query.forecastBaseline,
    selectedSnapshotId: analyticsSnapshotRecordFixture.id,
    snapshot: analyticsSnapshotRecordFixture.snapshot,
    snapshots: [analyticsSnapshotRecordFixture],
    timeZone: analyticsSnapshotRecordFixture.query.timeZone,
    widgets: analyticsSnapshotRecordFixture.query.widgets,
  },
}

/**
 * 月末31日を含む monthly delivery schedule editor です。
 */
export const Schedule: Story = {
  args: {
    initialScheduleOpen: true,
    reports: [{
      ...analyticsReportFixtures[0],
      schedule: {
        dayOfMonth: 31,
        enabled: true,
        format: 'pdf',
        frequency: 'monthly',
        localTime: '09:00',
        recipientMemberKeys: ['owner@example.com'],
        timeZone: 'Asia/Tokyo',
      },
    }],
  },
}

/**
 * English locale の analytics report workbench です。
 */
export const English: Story = {
  args: {
    locale: 'en',
  },
}
