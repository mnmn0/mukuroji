import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AnalyticsWorkbench } from '../src/analytics/ui/AnalyticsWorkbench'
import { parseAnalyticsCustomFieldDraftValue } from '../src/analytics/model/filterDraft'
import { applyAnalyticsPeriodPreset } from '../src/analytics/model/periodPresets'
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
  test('preserves typed custom-field values while editing filter drafts', () => {
    expect(parseAnalyticsCustomFieldDraftValue('12.5', 'greater-than')).toBe(12.5)
    expect(parseAnalyticsCustomFieldDraftValue('invalid', 'less-than')).toBeUndefined()
    expect(parseAnalyticsCustomFieldDraftValue('false', 'equals', true)).toBeFalse()
    expect(
      parseAnalyticsCustomFieldDraftValue('urgent, blocked', 'contains', ['urgent']),
    ).toEqual(['urgent', 'blocked'])
  })

  test('lists the deliveries to the user and marks the open one', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        deliveries={[{
          reportId: 'weekly',
          reportName: 'Weekly delivery',
          snapshotId: 'snapshot-1',
          format: 'pdf',
          deliveredAt: '2026-07-13T00:00:00.000Z',
        }]}
        selectedReportId="weekly"
        selectedSnapshotId="snapshot-1"
      />,
    )
    expect(html).toContain('Delivered to me')
    expect(html).toMatch(/<option value="snapshot-1" selected="">Weekly delivery · /u)
    expect(renderToStaticMarkup(<AnalyticsWorkbench {...baseProps} />)).not.toContain('Delivered to me')
  })

  test('enables the period presets only once the Workspace calendar settings are loaded', () => {
    const withoutSettings = renderToStaticMarkup(
      <AnalyticsWorkbench {...baseProps} onFilterChange={() => undefined} />,
    )
    const withSettings = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        calendarSettings={{ fiscalYearStartMonth: 4, weekStartDay: 1 }}
        onFilterChange={() => undefined}
      />,
    )

    expect(withoutSettings).toMatch(/<select[^>]*data-testid="analytics-period-preset"[^>]*disabled/u)
    expect(withSettings).not.toMatch(/<select[^>]*data-testid="analytics-period-preset"[^>]*disabled/u)
    expect(withSettings).toContain('This fiscal year')
    expect(withSettings).toContain('Last week')
    expect(withSettings).toMatch(/<option value="custom" selected/u)
  })

  test('shows the relative period a saved report remembers while its dates are current', () => {
    const calendarSettings = { fiscalYearStartMonth: 4, weekStartDay: 1 as const }
    const current = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        calendarSettings={calendarSettings}
        filter={applyAnalyticsPeriodPreset(
          baseProps.filter,
          'last-fiscal-year',
          new Date(),
          baseProps.timeZone,
          calendarSettings,
        )}
        onFilterChange={() => undefined}
      />,
    )
    // An old snapshot keeps the dates it was taken with.
    const stale = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        calendarSettings={calendarSettings}
        filter={{ ...baseProps.filter, periodPreset: 'last-fiscal-year' }}
        onFilterChange={() => undefined}
      />,
    )

    expect(current).toMatch(/<option value="last-fiscal-year" selected/u)
    expect(stale).not.toMatch(/<option value="last-fiscal-year" selected/u)
  })

  test('explains a failed calendar settings read and offers a retry while presets stay disabled', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        calendarSettingsFailed
        onFilterChange={() => undefined}
        onRetryCalendarSettings={() => undefined}
      />,
    )

    expect(html).toMatch(/<select[^>]*data-testid="analytics-period-preset"[^>]*disabled/u)
    expect(html).toContain("Couldn&#x27;t load the Workspace fiscal year and week settings.")
    expect(html).toMatch(/role="alert">Couldn[^<]*<button[^>]*>Retry<\/button>/u)
  })

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

  test('draws flow charts only for compatible metrics and extends burndowns to the period end', () => {
    const series = [{
      from: '2026-06-30T15:00:00.000Z',
      to: '2026-07-01T14:59:59.999Z',
      value: 3,
      sampleSize: 3,
      segments: [{ key: 'scope', value: 3 }, { key: 'completed', value: 0 }],
    }]
    const result = (widgetId: string) => ({
      ...analyticsSnapshotFixture.widgets[0]!,
      widgetId,
      metric: 'remaining-scope' as const,
      series,
      groups: [],
      rows: [],
      warnings: [],
    })
    const widget = (id: string, visualization: 'burndown' | 'area') => ({
      id,
      title: id,
      type: 'chart' as const,
      metric: 'remaining-scope' as const,
      visualization,
      groupBy: { dimension: 'day' as const },
    })
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        filter={{ period: { from: '2026-06-30T15:00:00.000Z', to: '2026-07-03T14:59:59.999Z' } }}
        snapshot={{ ...analyticsSnapshotFixture, widgets: [result('bd'), result('cfd')] }}
        widgets={[widget('bd', 'burndown'), widget('cfd', 'area')]}
      />,
    )

    expect(html).toContain('data-testid="analytics-flow-chart-burndown"')
    expect(html).toContain('<td class="px-3 py-2">2026-07-02</td>')
    expect(html).not.toContain('data-testid="analytics-flow-chart-area"')
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

  test('renders null chart values as gaps instead of zero-valued marks', () => {
    const result = {
      ...analyticsSnapshotFixture.widgets.find(
        (widget) => widget.widgetId === 'chart-throughput',
      )!,
      series: [
        {
          from: '2026-07-01T00:00:00.000Z',
          sampleSize: 3,
          to: '2026-07-01T23:59:59.999Z',
          value: 3,
        },
        {
          from: '2026-07-02T00:00:00.000Z',
          sampleSize: 0,
          to: '2026-07-02T23:59:59.999Z',
          value: null,
        },
        {
          from: '2026-07-03T00:00:00.000Z',
          sampleSize: 5,
          to: '2026-07-03T23:59:59.999Z',
          value: 5,
        },
      ],
    }
    const widget = analyticsWidgetFixtures.find(
      (candidate) => candidate.id === 'chart-throughput',
    )!
    const lineHtml = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        snapshot={{ ...analyticsSnapshotFixture, widgets: [result] }}
        widgets={[{ ...widget, visualization: 'line' }]}
      />,
    )
    const barHtml = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        snapshot={{ ...analyticsSnapshotFixture, widgets: [result] }}
        widgets={[{ ...widget, visualization: 'bar' }]}
      />,
    )

    expect(lineHtml).toContain('data-testid="analytics-line-segment-0"')
    expect(lineHtml).toContain('data-testid="analytics-line-segment-1"')
    expect(lineHtml).toContain('data-testid="analytics-line-point-0"')
    expect(lineHtml).not.toContain('data-testid="analytics-line-point-1"')
    expect(lineHtml).toContain('data-testid="analytics-line-point-2"')
    expect(barHtml).toContain('data-testid="analytics-bar-0"')
    expect(barHtml).not.toContain('data-testid="analytics-bar-1"')
    expect(barHtml).toContain('data-testid="analytics-bar-missing-1"')
    expect(barHtml).toContain('data-testid="analytics-bar-2"')
    expect(lineHtml).toContain('>Unavailable</td>')
    // Chart primitives follow the theme instead of fixed light-palette colors.
    expect(barHtml).toContain('fill:var(--workbench-chart-series)')
    expect(barHtml).toContain('stroke:var(--workbench-chart-grid)')
    expect(barHtml).toContain('stroke:var(--workbench-chart-missing)')
    expect(lineHtml).toContain('fill:var(--workbench-chart-point-fill);stroke:var(--workbench-chart-series)')
    expect(`${lineHtml}${barHtml}`).not.toMatch(/(?:fill|stroke)="#(?:dde4e1|0f766e|78837f|ffffff)"/u)
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
    expect(html).toMatch(/Jul 16, 2026(?: at|,) 1:20 PM/u)
    expect(html).not.toMatch(/Jul 16, 2026(?: at|,) 4:20 AM/u)
    expect(html).toContain('tabindex="-1"')
  })

  test('keeps a closed evidence drawer hidden while an aborted request settles', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        evidenceMetric={undefined}
        isEvidenceLoading
      />,
    )

    expect(html).not.toContain('aria-modal="true"')
    expect(html).not.toContain('Loading evidence')
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

  test('shows a retryable load error instead of empty-state onboarding', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        errorMessage="Analytics data could not be loaded."
        reports={[]}
        selectedReportId={undefined}
        snapshot={undefined}
        widgets={[]}
        onRetry={() => undefined}
      />,
    )

    expect(html).toContain('Analytics data could not be loaded.')
    expect(html).toContain('Retry')
    expect(html).not.toContain('Create your first report')
    expect(html).not.toContain('View an example')
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
    expect(html).toMatch(/Jun 8, 2026(?: at|,) 9:00 AM/u)
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
    expect(html).toContain('No external email is sent.')
    expect(html).toContain('data-modal-initial-focus="true"')
    expect(html).toContain('tabindex="-1"')
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
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*type="submit"[^>]*>Save schedule<\/button>/u,
    )
  })

  test('explains the in-app-only schedule boundary in Japanese', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        initialScheduleOpen
        locale="ja"
        onSaveSchedule={() => undefined}
      />,
    )

    expect(html).toContain('アプリ内の配信履歴')
    expect(html).toContain('外部メールは送信されません。')
    expect(html).toContain('アプリ内受信メンバー')
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

  test('shows Agent token and cost widgets with their units and warnings', () => {
    const [base] = analyticsSnapshotFixture.widgets
    if (base === undefined) throw new Error('Expected a fixture widget.')
    const usageResult = (metric: 'agent-tokens' | 'agent-cost', unit: 'tokens' | 'usd', value: number, warnings: string[]) => ({
      ...base,
      widgetId: 'metric-throughput',
      metric,
      definition: { ...base.definition, key: metric, label: metric, unit },
      value,
      warnings,
    })
    const render = (result: ReturnType<typeof usageResult>) => renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        locale="ja"
        snapshot={{ ...analyticsSnapshotFixture, widgets: [result] }}
        widgets={[{ ...analyticsWidgetFixtures[0]!, metric: result.metric }]}
      />,
    )
    const tokens = render(usageResult('agent-tokens', 'tokens', 1_234_567, [
      '2 Agent Run(s) had more usage than one read returns, so the total is a lower bound.',
    ]))
    expect(tokens).toContain('1,234,567 トークン')
    expect(tokens).toContain('一度に読める量を超えた Agent Run が 2件あるため')
    const cost = render(usageResult('agent-cost', 'usd', 12.345, [
      '1 Agent Run(s) whose cost you may not see were left out of the estimated cost.',
    ]))
    expect(cost).toContain('$12.35')
    expect(cost).toContain('費用を見られない Agent Run 1件は推定費用に含めていません。')
    expect(cost).toContain('coding agent の見積もりで、請求額とは一致しません。')
  })

  test('shows earned value widgets as indexes with their Project figures and warnings', () => {
    const [base] = analyticsSnapshotFixture.widgets
    if (base === undefined) throw new Error('Expected a fixture widget.')
    const spi = {
      ...base,
      widgetId: 'metric-throughput',
      metric: 'evm-spi' as const,
      definition: { ...base.definition, key: 'evm-spi' as const, label: 'SPI', unit: 'index' as const },
      value: 0.8,
      warnings: [
        '2 Project(s) you do not manage were left out of the earned value.',
        '1 Project(s) have no baseline with planned effort and were left out.',
      ],
    }
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        locale="ja"
        snapshot={{ ...analyticsSnapshotFixture, widgets: [spi] }}
        widgets={[{ ...analyticsWidgetFixtures[0]!, metric: 'evm-spi' }]}
      />,
    )
    expect(html).toContain('0.80')
    // Every warning shows, so both reasons a Project was left out are visible.
    expect(html).toContain('自分が管理していない Project 2件は出来高に含めていません。 予定工数のある baseline がない Project 1件は含めていません。')
    expect(html).toContain('baseline の予定工数で測ります')

    const table = {
      ...spi,
      definition: { ...spi.definition, key: 'evm-eac' as const, unit: 'hours' as const },
      metric: 'evm-eac' as const,
      value: 312,
      warnings: [],
      rows: [{
        id: 'core\0project-a',
        label: 'project-a',
        values: { teamId: 'core', projectId: 'project-a', budgetAtCompletionHours: 200, plannedValueHours: 100, earnedValueHours: 100, actualHours: 80, value: 160 },
      }],
    }
    const tableHtml = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        locale="ja"
        snapshot={{ ...analyticsSnapshotFixture, widgets: [table] }}
        widgets={[{ ...analyticsWidgetFixtures[0]!, type: 'table', metric: 'evm-eac', groupBy: { dimension: 'project' } }]}
      />,
    )
    expect(tableHtml).toContain('>出来高 EV（時間）</th>')
    expect(tableHtml).toContain('>実績 AC（時間）</th>')
    expect(tableHtml).toContain('>値</th>')
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

  test('shows every selected dimension and custom-field filter without collapsing arrays', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        filter={{
          ...analyticsFilterFixture,
          assigneeUserIds: ['owner@example.com', 'reviewer@example.com'],
          customFields: [
            {
              fieldId: 'impact',
              operator: 'not-equals',
              value: 'low',
            },
            {
              fieldId: 'launch-date',
              operator: 'is-empty',
            },
          ],
          projectIds: ['refero', 'brand-refresh'],
          statusCategories: ['started', 'completed'],
          teamIds: ['core-team', 'design-team'],
        }}
      />,
    )

    for (const value of [
      'core-team',
      'design-team',
      'refero',
      'brand-refresh',
      'started',
      'completed',
    ]) {
      expect(html).toContain(`type="checkbox" checked="" value="${value}"`)
    }
    expect(html).toContain('value="owner@example.com, reviewer@example.com"')
    expect(html).toContain('data-testid="analytics-custom-field-filter-0"')
    expect(html).toContain('data-testid="analytics-custom-field-filter-1"')
    expect(html).toContain('value="impact"')
    expect(html).toContain('value="launch-date"')
    expect(html).toContain('value="not-equals" selected=""')
    expect(html).toContain('value="is-empty" selected=""')
  })

  test('distinguishes explicit match-none allowlists from omitted all-values filters', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        filter={{
          ...analyticsFilterFixture,
          projectIds: [],
          statusCategories: [],
          teamIds: [],
        }}
      />,
    )

    expect(html).toContain('No teams')
    expect(html).toContain('No projects')
    expect(html).toContain('No statuses')
    expect(html).toContain('data-testid="analytics-team-filter-all"')
    expect(html).toContain('data-testid="analytics-project-filter-all"')
    expect(html).toContain('data-testid="analytics-status-filter-all"')
    expect(html).toContain('aria-pressed="false"')
  })

  test('marks explicit all-values controls as active for omitted dimension filters', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        filter={{
          period: analyticsFilterFixture.period,
        }}
      />,
    )

    expect(html.match(/aria-pressed="true"/gu)?.length).toBe(4)
    expect(html).toContain('All teams')
    expect(html).toContain('All projects')
    expect(html).toContain('All statuses')
  })

  test('offers an explicit older-snapshot page action after an empty visible page', () => {
    const availableHtml = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        hasMoreSnapshots
        snapshots={[]}
        onLoadMoreSnapshots={() => undefined}
      />,
    )
    const loadingHtml = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        hasMoreSnapshots
        isLoadingMoreSnapshots
        snapshots={[]}
        onLoadMoreSnapshots={() => undefined}
      />,
    )

    expect(availableHtml).toContain('data-testid="analytics-snapshot-load-older"')
    expect(availableHtml).toContain('Load older snapshots')
    expect(loadingHtml).toContain('disabled=""')
    expect(loadingHtml).toContain('Loading…')
  })

  test('shows Team, member, and status names and a localized unset group instead of IDs', () => {
    const widgets = analyticsWidgetFixtures.map((widget) =>
      widget.id === 'chart-cycle-time'
        ? { ...widget, groupBy: { dimension: 'assignee' as const } }
        : widget.id === 'chart-throughput'
          ? { ...widget, groupBy: { dimension: 'status' as const } }
          : widget)
    const snapshot = {
      ...analyticsSnapshotFixture,
      widgets: analyticsSnapshotFixture.widgets.map((result) =>
        result.widgetId === 'chart-cycle-time'
          ? {
              ...result,
              groups: [
                { key: 'sato@example.com', label: 'sato@example.com', sampleSize: 3, value: 20 },
                { key: '', label: 'Unassigned', sampleSize: 1, value: 8 },
              ],
            }
          : result.widgetId === 'chart-throughput'
            ? {
                ...result,
                series: [],
                groups: [{ key: 'started', label: 'started', sampleSize: 2, value: 2 }],
              }
            : result),
    }
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        locale="ja"
        members={[{ id: 'sato@example.com', email: 'sato@example.com', name: '佐藤 花子' }]}
        snapshot={snapshot}
        widgets={widgets}
      />,
    )

    expect(html).toContain('佐藤 花子')
    expect(html).toContain('未設定')
    expect(html).toContain('進行中')
    expect(html).not.toContain('>sato@example.com<')
  })

  test('shows a delivery-list failure with a retry instead of an empty list', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench {...baseProps} deliveriesFailed onRetryDeliveries={() => undefined} />,
    )
    expect(html).toContain('data-testid="analytics-deliveries-error"')
    expect(html).toContain('Your deliveries could not be loaded.')
    expect(html).toContain('Retry')
  })

  test('keeps the delivery error and retry when earlier deliveries are still shown', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        deliveries={[{
          reportId: 'weekly',
          reportName: 'Weekly delivery',
          snapshotId: 'snapshot-1',
          format: 'pdf',
          deliveredAt: '2026-07-13T00:00:00.000Z',
        }]}
        deliveriesFailed
        onRetryDeliveries={() => undefined}
      />,
    )
    expect(html).toContain('data-testid="analytics-delivery-selector"')
    expect(html).toContain('data-testid="analytics-deliveries-error"')
  })

  test('offers to read earlier deliveries while more remain', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        deliveries={[]}
        hasMoreDeliveries
        onLoadMoreDeliveries={() => undefined}
      />,
    )
    expect(html).toContain('data-testid="analytics-deliveries-more"')
    expect(html).toContain('Load earlier deliveries')
    expect(renderToStaticMarkup(<AnalyticsWorkbench {...baseProps} deliveries={[]} />))
      .not.toContain('analytics-deliveries-more')
  })

  test('shows a delivery-list failure with a retry on the empty state too', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        deliveriesFailed
        reports={[]}
        selectedReportId={undefined}
        snapshot={undefined}
        widgets={[]}
        onRetryDeliveries={() => undefined}
      />,
    )
    expect(html).toContain('Create your first report')
    expect(html).toContain('data-testid="analytics-deliveries-error"')
    expect(html).toContain('Retry')
  })

  test('shares a report with one Project of its Team', () => {
    const projectReport = {
      ...analyticsReportFixtures[0],
      visibility: 'project' as const,
      teamId: 'design-team',
      projectId: 'brand-refresh',
    }
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        builder
        reports={[projectReport]}
        selectedReportId={projectReport.id}
        onWidgetsChange={() => undefined}
      />,
    )
    expect(html).toContain('<option value="project" selected="">Project</option>')
    expect(html).toContain('Shared project')
    expect(html).toContain('<option value="brand-refresh" selected="">ブランド刷新</option>')
    // Only the chosen Team's Projects are offered.
    expect(html).not.toContain('<option value="refero"')
  })

  test('keeps an empty assignee selection apart from all assignees', () => {
    const members = [{ id: 'sato@example.com', email: 'sato@example.com', name: '佐藤 花子' }]
    const render = (assigneeUserIds: string[] | undefined) => renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        filter={{ ...analyticsFilterFixture, assigneeUserIds }}
        members={members}
        onFilterChange={() => undefined}
      />,
    )
    expect(render([])).toContain('No assignees')
    expect(render(undefined)).toContain('All assignees')
  })

  test('picks assignees, custom fields, and schedule recipients by name', () => {
    const members = [
      { id: 'sato@example.com', email: 'sato@example.com', name: '佐藤 花子' },
      { id: 'kato@example.com', email: 'kato@example.com' },
    ]
    const customFields = [{ id: 'impact', label: '影響度' }]
    const widgets = analyticsWidgetFixtures.map((widget) =>
      widget.id === 'chart-cycle-time'
        ? { ...widget, groupBy: { dimension: 'custom-field' as const, customFieldId: 'impact' } }
        : widget)
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        builder
        customFields={customFields}
        filter={{
          ...analyticsFilterFixture,
          assigneeUserIds: ['sato@example.com', 'former@example.com'],
          customFields: [{ fieldId: 'impact', operator: 'is-not-empty' }],
        }}
        initialScheduleOpen
        members={members}
        widgets={widgets}
        onFilterChange={() => undefined}
        onSaveSchedule={() => undefined}
        onWidgetsChange={() => undefined}
      />,
    )

    expect(html).toContain('data-testid="analytics-assignee-filter"')
    expect(html).toContain('佐藤 花子')
    expect(html).toContain('>kato@example.com<')
    // An assignee outside the member list, such as a former member, stays in the email field.
    expect(html).toContain('Other assignees')
    expect(html).toMatch(/value="former@example.com"/u)
    expect(html).not.toMatch(/checked=""[^>]*value="former@example.com"/u)
    expect(html).toContain('<option value="impact" selected="">影響度</option>')
    expect(html).not.toContain('Example: impact')
    expect(html).toContain('data-testid="analytics-recipient-picker"')
    expect(html).not.toContain('Comma-separated member keys')
  })

  test('keeps typed IDs while member and custom field lists are unavailable', () => {
    const html = renderToStaticMarkup(
      <AnalyticsWorkbench
        {...baseProps}
        initialScheduleOpen
        onFilterChange={() => undefined}
        onSaveSchedule={() => undefined}
      />,
    )

    expect(html).toContain('Comma-separated emails')
    expect(html).toContain('Example: impact')
    expect(html).toContain('Comma-separated member keys')
  })
})
