import type { Meta, StoryObj } from '@storybook/react-vite'
import type { AnalyticsFilter } from '@mukuroji/contracts'
import { expect, fn, userEvent, within } from 'storybook/test'
import { AnalyticsWorkbench } from '../../analytics/ui/AnalyticsWorkbench'
import {
  analyticsEvidenceFixture,
  analyticsFilterFixture,
  analyticsReportFixtures,
  analyticsSnapshotFixture,
  analyticsSnapshotRecordFixture,
  analyticsWidgetFixtures,
} from '../../analytics/fixtures'
import { projectDirectoryFixtures } from '../../projects/fixtures'

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

const namedGroupWidgets = analyticsWidgetFixtures.map((widget) =>
  widget.id === 'chart-cycle-time'
    ? { ...widget, groupBy: { dimension: 'assignee' as const } }
    : widget)

/** Assignee groups keyed by member key, with one group of unassigned Work Items. */
const namedGroupSnapshot = {
  ...analyticsSnapshotFixture,
  widgets: analyticsSnapshotFixture.widgets.map((result) =>
    result.widgetId === 'chart-cycle-time'
      ? {
          ...result,
          groups: [
            { key: 'sato@example.com', label: 'sato@example.com', sampleSize: 12, value: 24.5 },
            { key: 'kato@example.com', label: 'kato@example.com', sampleSize: 9, value: 31.2 },
            { key: '', label: 'Unassigned', sampleSize: 4, value: 40.8 },
          ],
        }
      : result),
}

/** Members whose names replace member keys; one has no name and shows the email. */
const namedGroupMembers = [
  { id: 'sato@example.com', email: 'sato@example.com', name: '佐藤 花子' },
  { id: 'kato@example.com', email: 'kato@example.com' },
]

const priorityGroupWidgets = analyticsWidgetFixtures.map((widget) =>
  widget.id === 'chart-cycle-time'
    ? { ...widget, groupBy: { dimension: 'priority' as const } }
    : widget)

/** Priority groups keyed by the stored priority value. */
const priorityGroupSnapshot = {
  ...analyticsSnapshotFixture,
  widgets: analyticsSnapshotFixture.widgets.map((result) =>
    result.widgetId === 'chart-cycle-time'
      ? {
          ...result,
          groups: [
            { key: 'high', label: 'high', sampleSize: 6, value: 18.2 },
            { key: 'medium', label: 'medium', sampleSize: 11, value: 27.4 },
            { key: 'low', label: 'low', sampleSize: 5, value: 35.9 },
          ],
        }
      : result),
}

const milestoneGroupWidgets = analyticsWidgetFixtures.map((widget) =>
  widget.id === 'chart-cycle-time'
    ? { ...widget, groupBy: { dimension: 'milestone' as const } }
    : widget)

/** Milestone groups carry the entity title; Work Items outside a readable Milestone are unset. */
const milestoneGroupSnapshot = {
  ...analyticsSnapshotFixture,
  widgets: analyticsSnapshotFixture.widgets.map((result) =>
    result.widgetId === 'chart-cycle-time'
      ? {
          ...result,
          groups: [
            { key: 'milestone-beta', label: 'β リリース', sampleSize: 8, value: 22.1 },
            { key: 'milestone-ga', label: 'GA', sampleSize: 10, value: 29.6 },
            { key: '', label: 'Unassigned', sampleSize: 3, value: 41.3 },
          ],
        }
      : result),
}

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
    calendarSettings: { fiscalYearStartMonth: 4, weekStartDay: 1 },
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

/** Phone reports reveal date controls on demand while keeping the report first. */
export const MobileFilters: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async ({ canvasElement }) => {
    if (!window.matchMedia('(max-width: 760px)').matches) return
    const canvas = within(canvasElement)
    const disclosure = canvas.getByRole('button', { name: /絞り込み・並べ替え/ })
    await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(disclosure)
    await expect(canvas.getByTestId('analytics-team-filter')).toBeVisible()
    await userEvent.click(disclosure)
    await expect(canvas.getByTestId('analytics-team-filter')).not.toBeVisible()
  },
}

/**
 * 担当者で分けた chart です。member key の代わりに名前（名前がなければメール）、担当者なしは
 * 「未設定」で表示します。
 */
export const NamedAssigneeGroups: Story = {
  args: {
    members: namedGroupMembers,
    snapshot: namedGroupSnapshot,
    widgets: namedGroupWidgets,
  },
  play: async ({ canvasElement }) => {
    const widget = within(canvasElement).getByTestId('analytics-widget-chart-cycle-time')
    await expect(widget).toHaveTextContent('佐藤 花子')
    await expect(widget).toHaveTextContent('未設定')
  },
}

/**
 * 優先度で分けた chart と、その dimension を選んだ report builder です。優先度の値は画面の言語の名前で表示します。
 */
export const PriorityGroups: Story = {
  args: {
    builder: true,
    snapshot: priorityGroupSnapshot,
    widgets: priorityGroupWidgets,
  },
  play: async ({ canvasElement }) => {
    const widget = within(canvasElement).getByTestId('analytics-widget-chart-cycle-time')
    await expect(widget).toHaveTextContent('高')
    await expect(widget).toHaveTextContent('低')
  },
}

/**
 * Milestone で分けた chart です。読める Milestone は名前で、どの Milestone にも属さない Work Item は
 * 「未設定」で表示します。
 */
export const MilestoneGroups: Story = {
  args: {
    builder: true,
    snapshot: milestoneGroupSnapshot,
    widgets: milestoneGroupWidgets,
  },
  play: async ({ canvasElement }) => {
    const widget = within(canvasElement).getByTestId('analytics-widget-chart-cycle-time')
    await expect(widget).toHaveTextContent('β リリース')
    await expect(widget).toHaveTextContent('未設定')
  },
}

/**
 * 自分に届いた定期配信を新しい順に並べた選択肢です。選ぶとその回の report と snapshot を開きます。
 */
export const MyDeliveries: Story = {
  args: {
    deliveries: [
      {
        reportId: analyticsReportFixtures[0].id,
        reportName: analyticsReportFixtures[0].name,
        snapshotId: 'snapshot-2026-11-20',
        format: 'pdf',
        deliveredAt: '2026-11-20T00:00:00.000Z',
      },
      {
        reportId: analyticsReportFixtures[0].id,
        reportName: analyticsReportFixtures[0].name,
        snapshotId: 'snapshot-2026-11-13',
        format: 'csv',
        deliveredAt: '2026-11-13T00:00:00.000Z',
      },
    ],
    onOpenDelivery: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const select = canvas.getByTestId('analytics-delivery-selector')
    await userEvent.selectOptions(select, 'snapshot-2026-11-13')
    await expect(args.onOpenDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snapshot-2026-11-13' }),
    )
  },
}

/**
 * 担当者・カスタムフィールド・配信先を名前の一覧から選ぶ状態です。一覧にいない選択済みの担当者も
 * 選択されたまま残ります。
 */
export const NamePickers: Story = {
  args: {
    builder: true,
    customFields: [
      { id: 'impact', label: '影響度' },
      { id: 'launch-date', label: 'リリース日' },
    ],
    filter: multipleFilters,
    initialScheduleOpen: true,
    members: namedGroupMembers,
    widgets: customFieldGroupingWidgets,
  },
}

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
 * Checkboxのmatch-noneと明示的な全件操作をcallbackまで検証します。
 */
export const FilterSelectionSemantics: Story = {
  args: {
    filter: analyticsFilterFixture,
    onFilterChange: fn(),
  },
  play: async ({ args, canvasElement, step }) => {
    const canvas = within(canvasElement)
    const teamFilter = within(canvas.getByTestId('analytics-team-filter'))

    await step('最後のTeam checkbox解除は空allowlistを渡す', async () => {
      await userEvent.click(
        teamFilter.getByRole('checkbox', { name: 'コアチーム' }),
      )
      await expect(args.onFilterChange).toHaveBeenLastCalledWith({
        ...analyticsFilterFixture,
        teamIds: [],
      })
    })

    await step('明示的なすべてボタンだけがallowlistを省略する', async () => {
      await userEvent.click(
        teamFilter.getByTestId('analytics-team-filter-all'),
      )
      await expect(args.onFilterChange).toHaveBeenLastCalledWith({
        ...analyticsFilterFixture,
        teamIds: undefined,
      })
    })
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
