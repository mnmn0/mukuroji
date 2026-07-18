import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnalyticsWorkbench } from '../src/analytics/AnalyticsWorkbench'
import {
  analyticsEvidenceFixture,
  analyticsFilterFixture,
  analyticsReportFixtures,
  analyticsSnapshotFixture,
  analyticsSnapshotRecordFixture,
  analyticsWidgetFixtures,
} from '../src/analytics/fixtures'
import { projectDirectoryFixtures } from '../src/projects/fixtures'

const baseProps = {
  filter: analyticsFilterFixture,
  forecastBaseline: analyticsReportFixtures[0].forecastBaseline,
  locale: 'en' as const,
  reports: analyticsReportFixtures,
  selectedReportId: analyticsReportFixtures[0].id,
  snapshot: analyticsSnapshotFixture,
  teams: projectDirectoryFixtures,
  timeZone: 'Asia/Tokyo',
  widgets: analyticsWidgetFixtures,
}

describe('AnalyticsWorkbench', () => {
  test('renders KPI, dependency-free charts, table fallback, forecast, and provenance', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        onOpenEvidence={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="analytics-kpi-grid"')
    expect(html).toContain('data-testid="analytics-widget-grid"')
    expect(html).toContain('data-testid="analytics-forecast"')
    expect(html).toContain('<svg')
    expect(html).toContain('<details')
    expect(html).toContain('View as a table')
    expect(html).toContain('sha256:de')
    expect(html).toContain('View evidence')
  })

  test('formats series buckets in the snapshot timezone', () => {
    const snapshot = {
      ...analyticsSnapshotFixture,
      widgets: analyticsSnapshotFixture.widgets.map((result) =>
        result.widgetId === 'chart-throughput'
          ? {
              ...result,
              series: [{
                from: '2026-06-18T15:00:00.000Z',
                sampleSize: 4,
                to: '2026-06-19T14:59:59.999Z',
                value: 4,
              }],
            }
          : result),
    }
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        snapshot={snapshot}
      />,
    )

    expect(html).toContain('>2026-06-19</span>')
    expect(html).not.toContain('2026-06-18 – 2026-06-19')
  })

  test('centers grouped bars inside their chart slots', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench {...baseProps} />,
    )

    expect(html).toMatch(/data-testid="analytics-bar-0"[^>]*x="138"/u)
    expect(html).toMatch(/data-testid="analytics-bar-1"[^>]*x="430"/u)
  })

  test('renders the report builder palette and every widget editor', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        builder
        canManageReports
        onWidgetsChange={() => undefined}
      />,
    )

    expect(html).toContain('Report builder')
    expect(html).toContain('Add widget')
    expect(html).toContain('Line')
    expect(html).toContain('Bar')
    expect(html.match(/Move up/g)?.length).toBe(analyticsWidgetFixtures.length)
  })

  test('shows a traceable evidence drawer with Work Item links and pagination', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        evidence={analyticsEvidenceFixture}
        evidenceMetric="throughput"
        onLoadMoreEvidence={() => undefined}
        onOpenWorkItem={() => undefined}
      />,
    )

    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('Harden billing webhook retries')
    expect(html).toContain('MKJ-184')
    expect(html).toContain('Load more')
  })

  test('offers example and blank-report actions in the explicit empty state', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        reports={[]}
        selectedReportId={undefined}
        snapshot={undefined}
        widgets={[]}
      />,
    )

    expect(html).toContain('Create your first report')
    expect(html).toContain('View an example')
    expect(html).toContain('Create blank report')
  })

  test('renders an immutable snapshot with its historical widget definition', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        filter={analyticsSnapshotRecordFixture.query.filter}
        forecastBaseline={analyticsSnapshotRecordFixture.query.forecastBaseline}
        selectedSnapshotId={analyticsSnapshotRecordFixture.id}
        snapshot={analyticsSnapshotRecordFixture.snapshot}
        snapshots={[analyticsSnapshotRecordFixture]}
        timeZone={analyticsSnapshotRecordFixture.query.timeZone}
        widgets={analyticsSnapshotRecordFixture.query.widgets}
      />,
    )

    expect(html).toContain('Historical delivery trend')
    expect(html).toContain('snapshot-revision-3')
    expect(html).toContain('UTC')
    expect(html).toContain('31 evidence items')
    expect(html).toContain('2026-05-01 – 2026-05-03')
    expect(html).toContain('2026-05-25 – 2026-05-31')
    expect(html).toContain('Finalize launch illustrations')
    expect(html).toContain('2026-05-28T16:30:00.000Z')
    expect(html).toContain('Jun 8, 2026 at 9:00 AM')
    expect(html).toContain('value="2026-06-15"')
    expect(html).not.toContain('2026-06-18 – 2026-06-24')
    expect(html).not.toContain('Harden billing webhook retries')
    expect(html).not.toContain('Aug 4, 2026')
  })

  test('allows a monthly delivery schedule on day 31', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        initialScheduleOpen
        reports={[{
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
        }]}
        onSaveSchedule={() => undefined}
      />,
    )

    expect(html).toContain('max="31"')
    expect(html).toContain('value="31"')
    expect(html).toContain('value="monthly" selected=""')
    expect(html).not.toContain('Day of week')
    expect(html).toContain('required=""')
  })

  test('blocks scheduled delivery when a team report has no shared team', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        initialScheduleOpen
        reports={[{
          ...analyticsReportFixtures[0],
          teamId: undefined,
        }]}
        onSaveSchedule={() => undefined}
      />,
    )

    expect(html).toContain('A shared team is required for a team report.')
    expect(html).toContain('role="alert"')
  })

  test('disables report saving when a team draft has no shared team', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        builder
        canManageReports
        reports={[{
          ...analyticsReportFixtures[0],
          teamId: undefined,
        }]}
        onSaveReport={() => undefined}
      />,
    )

    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save<\/button>/u)
  })

  test('edits a custom-field group with its required field ID', () => {
    const widgets = analyticsWidgetFixtures.map((widget) =>
      widget.id === 'chart-cycle-time'
        ? {
            ...widget,
            groupBy: {
              customFieldId: 'impact',
              dimension: 'custom-field' as const,
            },
          }
        : widget)
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        builder
        widgets={widgets}
        onWidgetsChange={() => undefined}
      />,
    )

    expect(html).toContain('value="custom-field" selected=""')
    expect(html).toContain('Custom field ID')
    expect(html).toContain('value="impact"')
  })

  test('localizes metric descriptions, known warnings, and standard table headers', () => {
    const snapshot = {
      ...analyticsSnapshotFixture,
      widgets: analyticsSnapshotFixture.widgets.map((result, index) =>
        index === 0
          ? {
              ...result,
              warnings: ['No effective completions were recorded in this period.'],
            }
          : result),
    }
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        locale="ja"
        snapshot={snapshot}
      />,
    )

    expect(html).toContain('選択期間に完了した Work Item の件数です。')
    expect(html).toContain('この期間に有効な完了履歴はありません。')
    expect(html).toContain('>発生日時</th>')
    expect(html).not.toContain('Completed work items in the selected period.')
  })

  test('renders reproducible forecast baseline date controls', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench {...baseProps} />,
    )

    expect(html).toContain('Forecast baseline start')
    expect(html).toContain('Target completion date')
    expect(html).toContain('value="2026-07-01"')
    expect(html).toContain('value="2026-08-15"')
  })
})
