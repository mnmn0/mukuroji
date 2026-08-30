import type {
  AnalyticsCustomFieldFilter,
  AnalyticsDateRange,
  AnalyticsEvidenceInput,
  AnalyticsEvidenceItem,
  AnalyticsEvidenceResponse,
  AnalyticsFilter,
  AnalyticsMetricKey,
  AnalyticsReport,
  AnalyticsSchedule,
  AnalyticsSnapshot,
  AnalyticsSnapshotRecord,
  AnalyticsWidget,
  AnalyticsWidgetResult,
  CreateAnalyticsReportInput,
  WorkItemTypeDefinition,
} from '@mukuroji/contracts'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  createTranslator,
  type Locale,
  type MessageKey,
} from '../../shared/i18n/i18n'
import { useModalFocus } from '../../shared/ui/useModalFocus'
import type { ProjectDirectoryTeam } from '../../projects/api'
import type { AnalyticsExportFormat } from '../api'
import {
  analyticsCustomFieldOperatorUsesNumericValue,
  parseAnalyticsCustomFieldDraftValue,
  updateAnalyticsMultiSelectValues,
} from '../model/filterDraft'
import {
  analyticsCalendarDateBoundaryToInstant,
  formatAnalyticsCalendarDate,
} from '../model/timeZone'

/**
 * Analytics workbench の表示と操作に必要な props です。
 */
export type AnalyticsWorkbenchProps = {
  /**
   * 表示 locale です。
   */
  locale: Locale
  /**
   * 現在 user が参照できる saved report です。
   */
  reports: AnalyticsReport[]
  /**
   * URL で選択された report ID です。
   */
  selectedReportId?: string
  /**
   * 実行中 query の filter です。
   */
  filter: AnalyticsFilter
  /**
   * Forecast risk と比較する target date range です。
   */
  forecastBaseline?: AnalyticsDateRange
  /**
   * Calendar bucket と日付表示に使う IANA timezone です。
   */
  timeZone: string
  /**
   * Query または builder preview に使う widget 定義です。
   */
  widgets: AnalyticsWidget[]
  /**
   * Permission 適用済み query snapshot です。
   */
  snapshot?: AnalyticsSnapshot
  /**
   * 選択中 report に保存された immutable snapshot record です。
   */
  snapshots?: AnalyticsSnapshotRecord[]
  /**
   * Viewer で表示中の snapshot record ID です。
   */
  selectedSnapshotId?: string
  /**
   * より古い snapshot page が残っているかどうかです。
   */
  hasMoreSnapshots?: boolean
  /**
   * より古い snapshot page の読み込み中表示です。
   */
  isLoadingMoreSnapshots?: boolean
  /**
   * Drill-down drawer に表示する evidence page です。
   */
  evidence?: AnalyticsEvidenceResponse
  /**
   * Evidence drawer で選択中の metric です。
   */
  evidenceMetric?: AnalyticsMetricKey
  /**
   * Sidebar filter 候補に使う Team / Project directory です。
   */
  teams: ProjectDirectoryTeam[]
  /** Work Item Type definitions available across the visible Teams. */
  workItemTypes?: WorkItemTypeDefinition[]
  /**
   * Report 一覧または snapshot の初回読み込み中表示です。
   */
  isLoading?: boolean
  /**
   * Evidence page の読み込み中表示です。
   */
  isEvidenceLoading?: boolean
  /**
   * Load または mutation の error message です。
   */
  errorMessage?: string
  /**
   * Share、snapshot、export mutation の完了通知です。
   */
  noticeMessage?: string
  /**
   * Widget builder を表示するかどうかです。
   */
  builder?: boolean
  /**
   * 現在 user が report を保存・削除・配信設定できるかどうかです。
   */
  canManageReports?: boolean
  /**
   * Story / test で schedule dialog を初期表示するかどうかです。
   */
  initialScheduleOpen?: boolean
  /**
   * Saved report selector が変更されたときの callback です。
   */
  onSelectReport?: (reportId?: string) => void
  /**
   * Filter toolbar が変更されたときの callback です。
   */
  onFilterChange?: (filter: AnalyticsFilter) => void
  /**
   * Forecast baseline date range が変更されたときの callback です。
   */
  onForecastBaselineChange?: (baseline?: AnalyticsDateRange) => void
  /**
   * Timezone が変更されたときの callback です。
   */
  onTimeZoneChange?: (timeZone: string) => void
  /**
   * Builder mode が変更されたときの callback です。
   */
  onBuilderChange?: (builder: boolean) => void
  /**
   * Builder の widget 定義が変更されたときの callback です。
   */
  onWidgetsChange?: (widgets: AnalyticsWidget[]) => void
  /**
   * Report draft を新規作成または更新するときの callback です。
   */
  onSaveReport?: (input: CreateAnalyticsReportInput) => Promise<void> | void
  /**
   * 選択中 report を削除するときの callback です。
   */
  onDeleteReport?: (report: AnalyticsReport) => Promise<void> | void
  /**
   * 選択中 report の immutable snapshot を保存するときの callback です。
   */
  onCreateSnapshot?: () => Promise<void> | void
  /**
   * Live query または保存済み snapshot を切り替える callback です。
   */
  onSelectSnapshot?: (snapshotId?: string) => void
  /**
   * より古い snapshot page を一つ読み込む callback です。
   */
  onLoadMoreSnapshots?: () => void
  /**
   * 現在 URL を共有するときの callback です。
   */
  onShare?: () => Promise<void> | void
  /**
   * CSV または PDF export を開始する callback です。
   */
  onExport?: (format: AnalyticsExportFormat) => Promise<void> | void
  /**
   * Widget metric の evidence drawer を開く callback です。
   */
  onOpenEvidence?: (input: AnalyticsEvidenceInput) => void
  /**
   * Evidence の次 page を読み込む callback です。
   */
  onLoadMoreEvidence?: () => void
  /**
   * Evidence drawer を閉じる callback です。
   */
  onCloseEvidence?: () => void
  /**
   * Evidence から Work Item 画面を開く callback です。
   */
  onOpenWorkItem?: (item: AnalyticsEvidenceItem) => void
  /**
   * Report schedule を保存する callback です。失敗時は `false` を返します。
   */
  onSaveSchedule?: (
    schedule: AnalyticsSchedule | null,
  ) => Promise<boolean | void> | boolean | void
  /**
   * Empty state から example report を開始する callback です。
   */
  onStartExample?: () => void
  /**
   * Empty state から空の builder を開始する callback です。
   */
  onCreateBlank?: () => void
  /**
   * Load error を再試行する callback です。
   */
  onRetry?: () => void
}

const metricKeys = [
  'throughput',
  'cycle-time',
  'lead-time',
  'wip',
  'overdue',
  'scope-change',
  'velocity',
  'sla',
] as const satisfies readonly AnalyticsMetricKey[]

const statusCategories = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const

const customFieldOperators = [
  'equals',
  'not-equals',
  'contains',
  'greater-than',
  'greater-than-or-equal',
  'less-than',
  'less-than-or-equal',
  'is-empty',
  'is-not-empty',
] as const satisfies readonly AnalyticsCustomFieldFilter['operator'][]

const metricLabelKeys: Record<AnalyticsMetricKey, MessageKey> = {
  throughput: 'analytics.metric.throughput',
  'cycle-time': 'analytics.metric.cycleTime',
  'lead-time': 'analytics.metric.leadTime',
  wip: 'analytics.metric.wip',
  overdue: 'analytics.metric.overdue',
  'scope-change': 'analytics.metric.scopeChange',
  velocity: 'analytics.metric.velocity',
  sla: 'analytics.metric.sla',
}

const metricDescriptionKeys: Record<AnalyticsMetricKey, MessageKey> = {
  throughput: 'analytics.metricDescription.throughput',
  'cycle-time': 'analytics.metricDescription.cycleTime',
  'lead-time': 'analytics.metricDescription.leadTime',
  wip: 'analytics.metricDescription.wip',
  overdue: 'analytics.metricDescription.overdue',
  'scope-change': 'analytics.metricDescription.scopeChange',
  velocity: 'analytics.metricDescription.velocity',
  sla: 'analytics.metricDescription.sla',
}

const tableColumnLabelKeys: Readonly<Record<string, MessageKey>> = {
  occurredAt: 'analytics.table.occurredAt',
  projectId: 'analytics.table.projectId',
  teamId: 'analytics.table.teamId',
  value: 'analytics.table.value',
  workItemId: 'analytics.table.workItemId',
}

const widgetTypeLabelKeys: Record<AnalyticsWidget['type'], MessageKey> = {
  metric: 'analytics.builder.type.metric',
  chart: 'analytics.builder.type.chart',
  table: 'analytics.builder.type.table',
}

/**
 * Analytics report viewer、builder、drill-down を描画します。
 */
export function AnalyticsWorkbench({
  locale,
  reports,
  selectedReportId,
  filter,
  forecastBaseline,
  timeZone,
  widgets,
  snapshot,
  snapshots = [],
  selectedSnapshotId,
  hasMoreSnapshots = false,
  evidence,
  evidenceMetric,
  teams,
  workItemTypes = [],
  isLoading = false,
  isLoadingMoreSnapshots = false,
  isEvidenceLoading = false,
  errorMessage,
  noticeMessage,
  builder = false,
  canManageReports = false,
  initialScheduleOpen = false,
  onSelectReport,
  onFilterChange,
  onForecastBaselineChange,
  onTimeZoneChange,
  onBuilderChange,
  onWidgetsChange,
  onSaveReport,
  onDeleteReport,
  onCreateSnapshot,
  onSelectSnapshot,
  onLoadMoreSnapshots,
  onShare,
  onExport,
  onOpenEvidence,
  onLoadMoreEvidence,
  onCloseEvidence,
  onOpenWorkItem,
  onSaveSchedule,
  onStartExample,
  onCreateBlank,
  onRetry,
}: AnalyticsWorkbenchProps) {
  const t = useMemo(() => createTranslator(locale), [locale])
  const workItemTypeLabels = useMemo(
    () => new Map(workItemTypes.map((type) => [type.id, type.name])),
    [workItemTypes],
  )
  const selectedReport = reports.find((report) => report.id === selectedReportId)
  const [draftId] = useState(
    selectedReport?.id ?? createAnalyticsClientId('report'),
  )
  const [draftName, setDraftName] = useState(
    selectedReport?.name ?? t('analytics.builder.untitled'),
  )
  const [draftDescription, setDraftDescription] = useState(
    selectedReport?.description ?? '',
  )
  const [draftVisibility, setDraftVisibility] = useState<
    AnalyticsReport['visibility']
  >(selectedReport?.visibility ?? 'personal')
  const [draftTeamId, setDraftTeamId] = useState(selectedReport?.teamId ?? '')
  const [isScheduleOpen, setIsScheduleOpen] = useState(initialScheduleOpen)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const reportSchedule = selectedReport?.schedule
  const isReportDraftValid = Boolean(draftName.trim()) &&
    widgets.length > 0 &&
    (draftVisibility !== 'team' || Boolean(draftTeamId.trim()))
  const isTeamVisibilityValid = selectedReport?.visibility !== 'team' ||
    Boolean(selectedReport.teamId?.trim())
  const metricResults = snapshot?.widgets.filter((result) =>
    resolveWidgetType(widgets, result.widgetId) === 'metric') ?? []
  const contentResults = snapshot?.widgets.filter((result) =>
    resolveWidgetType(widgets, result.widgetId) !== 'metric') ?? []
  const showEmptyState = !isLoading &&
    !errorMessage &&
    reports.length === 0 &&
    !selectedReport &&
    !snapshot &&
    !builder &&
    widgets.length === 0

  const saveReport = async () => {
    if (!onSaveReport || !isReportDraftValid) {
      return
    }

    setIsSaving(true)
    try {
      await onSaveReport({
        description: draftDescription.trim() || undefined,
        filter,
        forecastBaseline,
        id: draftId,
        name: draftName.trim(),
        schedule: selectedReport?.schedule,
        teamId: draftVisibility === 'team' ? draftTeamId || undefined : undefined,
        timeZone,
        visibility: draftVisibility,
        widgets,
      } as CreateAnalyticsReportInput)
    } finally {
      setIsSaving(false)
    }
  }

  const deleteReport = async () => {
    if (!selectedReport || !onDeleteReport) {
      return
    }

    setIsDeleting(true)
    try {
      await onDeleteReport(selectedReport)
    } finally {
      setIsDeleting(false)
    }
  }

  if (showEmptyState) {
    return (
      <AnalyticsEmptyState
        t={t}
        onCreateBlank={onCreateBlank}
        onStartExample={onStartExample}
      />
    )
  }

  return (
    <div className="min-h-full bg-[var(--workbench-canvas)]">
      <header className="border-b border-[var(--workbench-border)] bg-white px-[clamp(20px,3vw,34px)] pb-5 pt-6">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-5">
          <div className="min-w-0">
            <p className="workbench-eyebrow">{t('analytics.eyebrow')}</p>
            <h1 className="workbench-title mt-2 text-page-title">
              {selectedReport?.name ?? t('analytics.title')}
            </h1>
            <p className="workbench-description mt-2 max-w-[760px]">
              {selectedReport?.description ?? t('analytics.description')}
            </p>
          </div>
          <label className="grid min-w-[260px] gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
            {t('analytics.savedReport')}
            <select
              className="workbench-input min-h-11 px-3 normal-case tracking-normal"
              data-testid="analytics-report-selector"
              value={selectedReportId ?? ''}
              onChange={(event) => onSelectReport?.(event.target.value || undefined)}
            >
              <option value="">{t('analytics.adHocReport')}</option>
              {reports.map((report) => (
                <option key={report.id} value={report.id}>
                  {report.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <SnapshotMetadata locale={locale} snapshot={snapshot} t={t} />
            {selectedReport && (snapshots.length > 0 || hasMoreSnapshots) ? (
              <div className="flex flex-wrap items-center gap-2">
                {snapshots.length > 0 ? (
                  <label className="flex items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
                    {t('analytics.snapshot.label')}
                    <select
                      className="workbench-input min-h-9 max-w-[240px] px-2 text-xs"
                      value={selectedSnapshotId ?? ''}
                      onChange={(event) =>
                        onSelectSnapshot?.(event.target.value || undefined)}
                    >
                      <option value="">{t('analytics.snapshot.live')}</option>
                      {snapshots.map((record) => (
                        <option key={record.id} value={record.id}>
                          {formatDateTime(
                            record.createdAt,
                            locale,
                            record.snapshot.timeZone,
                          )}
                          {' · '}r{record.reportRevision ?? '—'}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                {hasMoreSnapshots ? (
                  <button
                    className="workbench-button-secondary min-h-8 px-2.5 text-xs disabled:cursor-wait disabled:opacity-60"
                    data-testid="analytics-snapshot-load-older"
                    disabled={isLoadingMoreSnapshots || !onLoadMoreSnapshots}
                    type="button"
                    onClick={onLoadMoreSnapshots}
                  >
                    {t(isLoadingMoreSnapshots
                      ? 'analytics.snapshot.loadingOlder'
                      : 'analytics.snapshot.loadOlder')}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t('analytics.actions')}>
            <button
              className="workbench-button-secondary min-h-10 px-3"
              disabled={!canManageReports}
              type="button"
              onClick={() => onBuilderChange?.(!builder)}
            >
              {t(builder ? 'analytics.action.preview' : 'analytics.action.edit')}
            </button>
            <button
              className="workbench-button-primary min-h-10 px-4 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={
                !canManageReports ||
                !onSaveReport ||
                !isReportDraftValid ||
                isSaving
              }
              type="button"
              onClick={() => void saveReport()}
            >
              {isSaving ? t('analytics.action.saving') : t('analytics.action.save')}
            </button>
            <button
              className="workbench-button-secondary min-h-10 px-3 disabled:opacity-50"
              disabled={!selectedReport || !onCreateSnapshot}
              type="button"
              onClick={() => void onCreateSnapshot?.()}
            >
              {t('analytics.action.snapshot')}
            </button>
            <button
              className="workbench-button-secondary min-h-10 px-3 disabled:opacity-50"
              disabled={!selectedReport || !onShare}
              type="button"
              onClick={() => void onShare?.()}
            >
              {t('analytics.action.share')}
            </button>
            <button
              className="workbench-button-secondary min-h-10 px-3 disabled:opacity-50"
              disabled={!selectedReport || !onSaveSchedule || !canManageReports}
              type="button"
              onClick={() => setIsScheduleOpen(true)}
            >
              {t('analytics.action.schedule')}
            </button>
            <button
              className="workbench-button-secondary min-h-10 px-3 disabled:opacity-50"
              disabled={!snapshot || !onExport}
              type="button"
              onClick={() => void onExport?.('csv')}
            >
              {t('analytics.action.csv')}
            </button>
            <button
              className="workbench-button-secondary min-h-10 px-3 disabled:opacity-50"
              disabled={!snapshot || !onExport}
              type="button"
              onClick={() => void onExport?.('pdf')}
            >
              {t('analytics.action.pdf')}
            </button>
          </div>
        </div>
      </header>

      <AnalyticsFilterToolbar
        filter={filter}
        forecastBaseline={forecastBaseline}
        t={t}
        teams={teams}
        timeZone={timeZone}
        workItemTypes={workItemTypes}
        onFilterChange={onFilterChange}
        onForecastBaselineChange={onForecastBaselineChange}
        onTimeZoneChange={onTimeZoneChange}
      />

      {errorMessage ? (
        <div className="mx-[clamp(20px,3vw,34px)] mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800" role="alert">
          <span>{errorMessage}</span>
          {onRetry ? (
            <button className="underline underline-offset-2" type="button" onClick={onRetry}>
              {t('analytics.action.retry')}
            </button>
          ) : null}
        </div>
      ) : null}
      {noticeMessage ? (
        <div
          className="mx-[clamp(20px,3vw,34px)] mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800"
          role="status"
        >
          {noticeMessage}
        </div>
      ) : null}

      <div className={builder
        ? 'grid grid-cols-[310px_minmax(0,1fr)] items-start gap-5 px-[clamp(20px,3vw,34px)] py-5 max-[980px]:grid-cols-1'
        : 'px-[clamp(20px,3vw,34px)] py-5'}
      >
        {builder ? (
          <AnalyticsBuilderPanel
            description={draftDescription}
            name={draftName}
            selectedTeamId={draftTeamId}
            t={t}
            teams={teams}
            visibility={draftVisibility}
            widgets={widgets}
            onDescriptionChange={setDraftDescription}
            onNameChange={setDraftName}
            onSelectedTeamIdChange={setDraftTeamId}
            onVisibilityChange={setDraftVisibility}
            onWidgetsChange={onWidgetsChange}
          />
        ) : null}

        <div className="min-w-0">
          {isLoading ? (
            <AnalyticsLoadingState t={t} />
          ) : snapshot ? (
            <div className="grid gap-5">
              {snapshot.widgets.length === 0 ? (
                <AnalyticsNoResults t={t} />
              ) : (
                <>
                  <div className="grid grid-cols-4 gap-4 max-[1240px]:grid-cols-2 max-[660px]:grid-cols-1" data-testid="analytics-kpi-grid">
                    {metricResults.map((result) => (
                      <AnalyticsMetricCard
                        key={result.widgetId}
                        locale={locale}
                        result={result}
                        snapshot={snapshot}
                        t={t}
                        widget={widgets.find((widget) => widget.id === result.widgetId)}
                        onOpenEvidence={onOpenEvidence}
                      />
                    ))}
                  </div>

                  <div className="grid grid-cols-12 gap-5" data-testid="analytics-widget-grid">
                    {contentResults.map((result) => (
                      <AnalyticsResultWidget
                        key={result.widgetId}
                        locale={locale}
                        result={result}
                        snapshot={snapshot}
                        t={t}
                        widget={widgets.find((widget) => widget.id === result.widgetId)}
                        workItemTypeLabels={workItemTypeLabels}
                        onOpenEvidence={onOpenEvidence}
                      />
                    ))}
                    <AnalyticsForecastCard
                      locale={locale}
                      snapshot={snapshot}
                      t={t}
                    />
                  </div>
                </>
              )}
            </div>
          ) : (
            <AnalyticsNoResults t={t} />
          )}
        </div>
      </div>

      {evidenceMetric ? (
        <AnalyticsEvidenceDrawer
          evidence={evidence}
          isLoading={isEvidenceLoading}
          locale={locale}
          metric={evidenceMetric}
          t={t}
          timeZone={timeZone}
          onClose={onCloseEvidence}
          onLoadMore={onLoadMoreEvidence}
          onOpenWorkItem={onOpenWorkItem}
        />
      ) : null}

      {isScheduleOpen ? (
        <AnalyticsScheduleDialog
          initialSchedule={reportSchedule}
          isTeamVisibilityValid={isTeamVisibilityValid}
          reportName={selectedReport?.name ?? draftName}
          t={t}
          timeZone={timeZone}
          onClose={() => setIsScheduleOpen(false)}
          onSave={async (schedule) => {
            const saved = await onSaveSchedule?.(schedule)
            if (saved !== false) {
              setIsScheduleOpen(false)
            }
          }}
        />
      ) : null}

      {selectedReport && builder && canManageReports ? (
        <div className="border-t border-[var(--workbench-border)] bg-white px-[clamp(20px,3vw,34px)] py-4 text-right">
          <button
            className="min-h-10 rounded-md border border-red-200 bg-white px-4 text-sm font-semibold text-red-700 transition hover:bg-red-50 disabled:opacity-50"
            disabled={!onDeleteReport || isDeleting}
            type="button"
            onClick={() => void deleteReport()}
          >
            {isDeleting ? t('analytics.action.deleting') : t('analytics.action.delete')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function AnalyticsEmptyState({
  onCreateBlank,
  onStartExample,
  t,
}: {
  onCreateBlank?: () => void
  onStartExample?: () => void
  t: ReturnType<typeof createTranslator>
}) {
  return (
    <div className="grid min-h-[calc(100svh-1px)] place-items-center bg-[var(--workbench-canvas)] px-6 py-16">
      <section className="workbench-panel w-full max-w-[760px] overflow-hidden text-center">
        <div className="border-b border-[var(--workbench-border)] bg-gradient-to-br from-[#e5f7f4] via-white to-amber-50 px-8 py-12">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-[#99d7cf] bg-white text-2xl text-[var(--workbench-primary)]" aria-hidden="true">
            ↗
          </span>
          <p className="workbench-eyebrow mt-6">{t('analytics.empty.eyebrow')}</p>
          <h1 className="workbench-title mt-3 text-page-title">{t('analytics.empty.title')}</h1>
          <p className="workbench-description mx-auto mt-3 max-w-[580px]">
            {t('analytics.empty.description')}
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <button className="workbench-button-primary min-h-11 px-5" type="button" onClick={onStartExample}>
              {t('analytics.empty.example')}
            </button>
            <button className="workbench-button-secondary min-h-11 px-5" type="button" onClick={onCreateBlank}>
              {t('analytics.empty.create')}
            </button>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-px bg-[var(--workbench-border)] text-left max-[680px]:grid-cols-1">
          {[
            ['analytics.empty.feature.metrics', 'analytics.empty.feature.metricsDescription'],
            ['analytics.empty.feature.evidence', 'analytics.empty.feature.evidenceDescription'],
            ['analytics.empty.feature.delivery', 'analytics.empty.feature.deliveryDescription'],
          ].map(([titleKey, descriptionKey]) => (
            <div className="bg-white p-5" key={titleKey}>
              <p className="text-sm font-semibold text-[var(--workbench-text)]">
                {t(titleKey as MessageKey)}
              </p>
              <p className="mt-2 text-sm font-medium text-[var(--workbench-muted)]">
                {t(descriptionKey as MessageKey)}
              </p>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function SnapshotMetadata({
  locale,
  snapshot,
  t,
}: {
  locale: Locale
  snapshot?: AnalyticsSnapshot
  t: ReturnType<typeof createTranslator>
}) {
  if (!snapshot) {
    return <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('analytics.notRun')}</p>
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-[var(--workbench-muted)]">
      <span className="workbench-badge-primary">
        {t('analytics.asOf')}: {formatDateTime(snapshot.asOf, locale, snapshot.timeZone)}
      </span>
      <span className="workbench-badge">{snapshot.timeZone}</span>
      <span className="workbench-badge">
        {t('analytics.evidenceCount').replace('{count}', String(snapshot.evidenceCount))}
      </span>
      <span className="font-mono text-[11px]" title={snapshot.queryHash}>
        {snapshot.queryHash.slice(0, 10)}
      </span>
    </div>
  )
}

function AnalyticsFilterToolbar({
  filter,
  forecastBaseline,
  onFilterChange,
  onForecastBaselineChange,
  onTimeZoneChange,
  t,
  teams,
  timeZone,
  workItemTypes,
}: {
  filter: AnalyticsFilter
  forecastBaseline?: AnalyticsDateRange
  onFilterChange?: (filter: AnalyticsFilter) => void
  onForecastBaselineChange?: (baseline?: AnalyticsDateRange) => void
  onTimeZoneChange?: (timeZone: string) => void
  t: ReturnType<typeof createTranslator>
  teams: ProjectDirectoryTeam[]
  timeZone: string
  workItemTypes: WorkItemTypeDefinition[]
}) {
  const projects = uniqueProjects(teams)
  const teamOptions = includeSelectedFilterOptions(
    teams.map((team) => ({ label: team.name, value: team.id })),
    filter.teamIds,
  )
  const projectOptions = includeSelectedFilterOptions(
    projects.map((project) => ({ label: project.name, value: project.id })),
    filter.projectIds,
  )
  const statusOptions = includeSelectedFilterOptions(
    statusCategories.map((category) => ({
      label: t(`workItems.statusCategory.${category}`),
      value: category,
    })),
    filter.statusCategories,
  )
  const workItemTypeOptions = includeSelectedFilterOptions(
    workItemTypes.map((type) => ({ label: type.name, value: type.id })),
    filter.workItemTypeIds,
  )
  const assigneeDraft = useDebouncedDraft(
    filter.assigneeUserIds?.join(', ') ?? '',
    (value) => onFilterChange?.({
      ...filter,
      assigneeUserIds: splitValues(value),
    }),
  )
  const timeZoneDraft = useDebouncedDraft(
    timeZone,
    (value) => {
      const normalized = value.trim()
      if (normalized) onTimeZoneChange?.(normalized)
    },
  )

  return (
    <section className="sticky top-0 z-20 border-b border-[var(--workbench-border)] bg-white/95 px-[clamp(20px,3vw,34px)] py-3 shadow-[0_5px_18px_rgba(23,32,29,0.06)] backdrop-blur" data-testid="analytics-filter-toolbar">
      <div className="grid grid-cols-[repeat(2,minmax(150px,1fr))_repeat(4,minmax(140px,1fr))] items-start gap-3 max-[1280px]:grid-cols-3 max-[760px]:grid-cols-1">
        <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.filter.from')}
          <input
            className="workbench-input min-h-10 px-3"
            type="date"
            value={formatAnalyticsCalendarDate(filter.period.from, timeZone)}
            onChange={(event) => {
              if (!event.target.value) return
              onFilterChange?.({
                ...filter,
                period: {
                  ...filter.period,
                  from: analyticsCalendarDateBoundaryToInstant(
                    event.target.value,
                    timeZone,
                    'start',
                  ),
                },
              })
            }}
          />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.filter.to')}
          <input
            className="workbench-input min-h-10 px-3"
            type="date"
            value={formatAnalyticsCalendarDate(filter.period.to, timeZone)}
            onChange={(event) => {
              if (!event.target.value) return
              onFilterChange?.({
                ...filter,
                period: {
                  ...filter.period,
                  to: analyticsCalendarDateBoundaryToInstant(
                    event.target.value,
                    timeZone,
                    'end',
                  ),
                },
              })
            }}
          />
        </label>
        <AnalyticsMultiSelectFilter
          allLabel={t('analytics.filter.allTeams')}
          label={t('analytics.filter.team')}
          noneLabel={t('analytics.filter.noTeams')}
          options={teamOptions}
          selectedValues={filter.teamIds}
          testId="analytics-team-filter"
          onChange={(teamIds) => onFilterChange?.({ ...filter, teamIds })}
        />
        <AnalyticsMultiSelectFilter
          allLabel={t('analytics.filter.allProjects')}
          label={t('analytics.filter.project')}
          noneLabel={t('analytics.filter.noProjects')}
          options={projectOptions}
          selectedValues={filter.projectIds}
          testId="analytics-project-filter"
          onChange={(projectIds) => onFilterChange?.({ ...filter, projectIds })}
        />
        <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.filter.assignee')}
          <input
            className="workbench-input min-h-10 px-3"
            placeholder={t('analytics.filter.assigneePlaceholder')}
            value={assigneeDraft.value}
            onBlur={assigneeDraft.flush}
            onChange={(event) => assigneeDraft.update(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                assigneeDraft.flush()
              }
            }}
          />
        </label>
        <AnalyticsMultiSelectFilter
          allLabel={t('analytics.filter.allStatuses')}
          label={t('analytics.filter.status')}
          noneLabel={t('analytics.filter.noStatuses')}
          options={statusOptions}
          selectedValues={filter.statusCategories}
          testId="analytics-status-filter"
          onChange={(statusCategories) =>
            onFilterChange?.({ ...filter, statusCategories })}
        />
        <AnalyticsMultiSelectFilter
          allLabel={t('analytics.filter.allWorkItemTypes')}
          label={t('analytics.filter.workItemType')}
          noneLabel={t('analytics.filter.noWorkItemTypes')}
          options={workItemTypeOptions}
          selectedValues={filter.workItemTypeIds}
          testId="analytics-work-item-type-filter"
          onChange={(workItemTypeIds) =>
            onFilterChange?.({ ...filter, workItemTypeIds })}
        />
      </div>
      <details className="mt-3">
        <summary className="w-fit cursor-pointer text-xs font-semibold text-[var(--workbench-primary)]">
          {t('analytics.filter.advanced')}
        </summary>
        <div className="mt-3 grid grid-cols-[repeat(4,minmax(170px,1fr))_auto] items-end gap-3 max-[1180px]:grid-cols-2 max-[760px]:grid-cols-1">
          <div className="col-span-full">
            <AnalyticsCustomFieldFilters
              filters={filter.customFields}
              t={t}
              onChange={(customFields) => onFilterChange?.({
                ...filter,
                customFields,
              })}
            />
          </div>
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('analytics.filter.baselineFrom')}
            <input
              className="workbench-input min-h-10 px-3"
              type="date"
              value={forecastBaseline
                ? formatAnalyticsCalendarDate(forecastBaseline.from, timeZone)
                : ''}
              onChange={(event) => {
                if (!event.target.value) {
                  onForecastBaselineChange?.(undefined)
                  return
                }
                onForecastBaselineChange?.({
                  from: analyticsCalendarDateBoundaryToInstant(
                    event.target.value,
                    timeZone,
                    'start',
                  ),
                  to: forecastBaseline?.to ?? filter.period.to,
                })
              }}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('analytics.filter.baselineTo')}
            <input
              className="workbench-input min-h-10 px-3"
              type="date"
              value={forecastBaseline
                ? formatAnalyticsCalendarDate(forecastBaseline.to, timeZone)
                : ''}
              onChange={(event) => {
                if (!event.target.value) {
                  onForecastBaselineChange?.(undefined)
                  return
                }
                onForecastBaselineChange?.({
                  from: forecastBaseline?.from ?? filter.period.from,
                  to: analyticsCalendarDateBoundaryToInstant(
                    event.target.value,
                    timeZone,
                    'end',
                  ),
                })
              }}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('analytics.filter.timeZone')}
            <input
              className="workbench-input min-h-10 px-3"
              value={timeZoneDraft.value}
              onBlur={timeZoneDraft.flush}
              onChange={(event) => timeZoneDraft.update(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  timeZoneDraft.flush()
                }
              }}
            />
          </label>
          <label className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg border border-[var(--workbench-border)] bg-white px-3 text-sm font-semibold text-[var(--workbench-text)]">
            <input
              checked={filter.includeArchived ?? false}
              className="h-4 w-4 accent-[var(--workbench-primary)]"
              type="checkbox"
              onChange={(event) => onFilterChange?.({
                ...filter,
                includeArchived: event.target.checked,
              })}
            />
            {t('analytics.filter.includeArchived')}
          </label>
        </div>
      </details>
    </section>
  )
}

function AnalyticsMultiSelectFilter({
  allLabel,
  label,
  noneLabel,
  onChange,
  options,
  selectedValues,
  testId,
}: {
  allLabel: string
  label: string
  noneLabel: string
  onChange: (values: string[] | undefined) => void
  options: Array<{ label: string; value: string }>
  selectedValues?: string[]
  testId: string
}) {
  const selected = new Set(selectedValues ?? [])
  const hasExplicitEmptySelection = selectedValues !== undefined &&
    selectedValues.length === 0
  const selectionLabel = options
    .filter((option) => selected.has(option.value))
    .map((option) => option.label)
    .join(', ')

  return (
    <fieldset className="grid min-w-0 gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
      <legend>{label}</legend>
      <div
        className="workbench-input grid max-h-28 min-h-10 gap-1 overflow-y-auto p-2"
        data-testid={testId}
      >
        <button
          aria-pressed={selectedValues === undefined}
          className={`mb-1 min-h-7 rounded px-2 py-1 text-left text-xs font-semibold transition ${
            selectedValues === undefined
              ? 'bg-[#e5f7f4] text-[var(--workbench-primary)]'
              : 'text-[var(--workbench-muted)] hover:bg-[var(--workbench-surface-muted)]'
          }`}
          data-testid={`${testId}-all`}
          type="button"
          onClick={() => onChange(undefined)}
        >
          {allLabel}
        </button>
        {options.map((option) => (
          <label
            className="flex min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm font-medium text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]"
            key={option.value}
          >
            <input
              checked={selected.has(option.value)}
              className="h-4 w-4 shrink-0 accent-[var(--workbench-primary)]"
              type="checkbox"
              value={option.value}
              onChange={(event) => {
                onChange(updateAnalyticsMultiSelectValues(
                  selectedValues,
                  option.value,
                  event.target.checked,
                ))
              }}
            />
            <span className="truncate">{option.label}</span>
          </label>
        ))}
      </div>
      <span
        className="truncate text-[11px] font-medium text-[var(--workbench-muted-soft)]"
        title={hasExplicitEmptySelection
          ? noneLabel
          : selected.size === 0
            ? allLabel
            : selectionLabel}
      >
        {hasExplicitEmptySelection
          ? noneLabel
          : selected.size === 0
            ? allLabel
            : selectionLabel}
      </span>
    </fieldset>
  )
}

function AnalyticsCustomFieldFilters({
  filters = [],
  onChange,
  t,
}: {
  filters?: AnalyticsCustomFieldFilter[]
  onChange: (filters: AnalyticsCustomFieldFilter[] | undefined) => void
  t: ReturnType<typeof createTranslator>
}) {
  const [newFieldId, setNewFieldId] = useState('')
  const [newOperator, setNewOperator] = useState<
    AnalyticsCustomFieldFilter['operator']
  >('equals')
  const [newValue, setNewValue] = useState('')
  const newOperatorNeedsValue = customFieldOperatorNeedsValue(newOperator)
  const parsedNewValue = newOperatorNeedsValue
    ? parseAnalyticsCustomFieldDraftValue(newValue, newOperator)
    : undefined
  const newValueIsValid = !newOperatorNeedsValue ||
    parsedNewValue !== undefined

  return (
    <section className="grid gap-2" data-testid="analytics-custom-field-filters">
      <h3 className="text-xs font-semibold text-[var(--workbench-muted)]">
        {t('analytics.filter.customField')}
      </h3>
      {filters.length > 0 ? (
        <div className="grid gap-2">
          {filters.map((customFilter, index) => (
            <AnalyticsCustomFieldFilterRow
              customFilter={customFilter}
              index={index}
              key={`${index}:${customFilter.fieldId}:${customFilter.operator}`}
              t={t}
              onChange={(nextFilter) => onChange(
                filters.map((candidate, candidateIndex) =>
                  candidateIndex === index ? nextFilter : candidate),
              )}
              onRemove={() => {
                const nextFilters = filters.filter(
                  (_, candidateIndex) => candidateIndex !== index,
                )
                onChange(nextFilters.length > 0 ? nextFilters : undefined)
              }}
            />
          ))}
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-[var(--workbench-border)] px-3 py-2 text-xs font-medium text-[var(--workbench-muted-soft)]">
          {t('analytics.filter.customFieldEmpty')}
        </p>
      )}
      <form
        className="grid grid-cols-[minmax(140px,1fr)_minmax(170px,1fr)_minmax(140px,1fr)_auto] items-end gap-2 max-[900px]:grid-cols-2 max-[600px]:grid-cols-1"
        onSubmit={(event) => {
          event.preventDefault()
          const fieldId = newFieldId.trim()
          if (!fieldId || !newValueIsValid) return
          const nextFilter: AnalyticsCustomFieldFilter = {
            fieldId,
            operator: newOperator,
            ...(newOperatorNeedsValue ? { value: parsedNewValue } : {}),
          }
          onChange([...filters, nextFilter])
          setNewFieldId('')
          setNewOperator('equals')
          setNewValue('')
        }}
      >
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.filter.customFieldId')}
          <input
            className="workbench-input min-h-10 px-3"
            placeholder={t('analytics.filter.customFieldIdPlaceholder')}
            value={newFieldId}
            onChange={(event) => setNewFieldId(event.target.value)}
          />
        </label>
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.filter.customFieldOperator')}
          <select
            className="workbench-input min-h-10 px-3"
            value={newOperator}
            onChange={(event) => setNewOperator(
              event.target.value as AnalyticsCustomFieldFilter['operator'],
            )}
          >
            {customFieldOperators.map((operator) => (
              <option key={operator} value={operator}>
                {t(`analytics.filter.operator.${operator}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.filter.customFieldValue')}
          <input
            className="workbench-input min-h-10 px-3 disabled:bg-[var(--workbench-surface-muted)]"
            disabled={!newOperatorNeedsValue}
            inputMode={analyticsCustomFieldOperatorUsesNumericValue(newOperator)
              ? 'decimal'
              : undefined}
            value={newOperatorNeedsValue ? newValue : ''}
            onChange={(event) => setNewValue(event.target.value)}
          />
        </label>
        <button
          className="workbench-button-secondary min-h-10 px-3 disabled:opacity-50"
          disabled={!newFieldId.trim() || !newValueIsValid}
          type="submit"
        >
          {t('analytics.filter.customFieldAdd')}
        </button>
      </form>
    </section>
  )
}

function AnalyticsCustomFieldFilterRow({
  customFilter,
  index,
  onChange,
  onRemove,
  t,
}: {
  customFilter: AnalyticsCustomFieldFilter
  index: number
  onChange: (filter: AnalyticsCustomFieldFilter) => void
  onRemove: () => void
  t: ReturnType<typeof createTranslator>
}) {
  const fieldIdDraft = useDebouncedDraft(
    customFilter.fieldId,
    (value) => {
      const fieldId = value.trim()
      if (fieldId) onChange({ ...customFilter, fieldId })
    },
  )
  const valueDraft = useDebouncedDraft(
    formatCustomFieldFilterValue(customFilter.value),
    (value) => {
      const parsedValue = parseAnalyticsCustomFieldDraftValue(
        value,
        customFilter.operator,
        customFilter.value,
      )
      if (parsedValue !== undefined) {
        onChange({ ...customFilter, value: parsedValue })
      }
    },
  )
  const operatorNeedsValue = customFieldOperatorNeedsValue(
    customFilter.operator,
  )

  return (
    <div
      className="grid grid-cols-[minmax(140px,1fr)_minmax(170px,1fr)_minmax(140px,1fr)_auto] items-end gap-2 rounded-md border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-2 max-[900px]:grid-cols-2 max-[600px]:grid-cols-1"
      data-testid={`analytics-custom-field-filter-${index}`}
    >
      <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('analytics.filter.customFieldId')}
        <input
          className="workbench-input min-h-10 px-3"
          value={fieldIdDraft.value}
          onBlur={fieldIdDraft.flush}
          onChange={(event) => fieldIdDraft.update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              fieldIdDraft.flush()
            }
          }}
        />
      </label>
      <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('analytics.filter.customFieldOperator')}
        <select
          className="workbench-input min-h-10 px-3"
          value={customFilter.operator}
          onChange={(event) => {
            const operator = event.target
              .value as AnalyticsCustomFieldFilter['operator']
            const parsedValue = parseAnalyticsCustomFieldDraftValue(
              formatCustomFieldFilterValue(customFilter.value),
              operator,
              customFilter.value,
            )
            onChange({
              fieldId: customFilter.fieldId,
              operator,
              ...(customFieldOperatorNeedsValue(operator)
                ? { value: parsedValue ?? customFilter.value ?? '' }
                : {}),
            })
          }}
        >
          {customFieldOperators.map((operator) => (
            <option key={operator} value={operator}>
              {t(`analytics.filter.operator.${operator}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('analytics.filter.customFieldValue')}
        <input
          aria-invalid={operatorNeedsValue &&
            parseAnalyticsCustomFieldDraftValue(
              valueDraft.value,
              customFilter.operator,
              customFilter.value,
            ) === undefined}
          className="workbench-input min-h-10 px-3 disabled:bg-[var(--workbench-surface-muted)]"
          disabled={!operatorNeedsValue}
          inputMode={analyticsCustomFieldOperatorUsesNumericValue(customFilter.operator)
            ? 'decimal'
            : undefined}
          value={operatorNeedsValue ? valueDraft.value : ''}
          onBlur={valueDraft.flush}
          onChange={(event) => valueDraft.update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              valueDraft.flush()
            }
          }}
        />
      </label>
      <button
        aria-label={t('analytics.filter.customFieldRemove')}
        className="grid h-10 w-10 place-items-center rounded-md border border-red-200 bg-white text-lg font-semibold text-red-700"
        type="button"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  )
}

function AnalyticsBuilderPanel({
  description,
  name,
  onDescriptionChange,
  onNameChange,
  onSelectedTeamIdChange,
  onVisibilityChange,
  onWidgetsChange,
  selectedTeamId,
  t,
  teams,
  visibility,
  widgets,
}: {
  description: string
  name: string
  onDescriptionChange: (description: string) => void
  onNameChange: (name: string) => void
  onSelectedTeamIdChange: (teamId: string) => void
  onVisibilityChange: (visibility: AnalyticsReport['visibility']) => void
  onWidgetsChange?: (widgets: AnalyticsWidget[]) => void
  selectedTeamId: string
  t: ReturnType<typeof createTranslator>
  teams: ProjectDirectoryTeam[]
  visibility: AnalyticsReport['visibility']
  widgets: AnalyticsWidget[]
}) {
  const addWidget = (type: AnalyticsWidget['type'], visualization?: 'line' | 'bar') => {
    const metric = type === 'metric'
      ? metricKeys[Math.min(widgets.filter((widget) => widget.type === 'metric').length, 3)]
      : type === 'table'
        ? 'overdue'
        : 'throughput'
    const nextWidget = {
      id: createAnalyticsClientId('widget'),
      metric,
      size: type === 'metric' ? 'small' : 'large',
      title: t(metricLabelKeys[metric]),
      type,
      visualization,
      ...(type === 'chart' ? { groupBy: { dimension: 'week' as const } } : {}),
    } as AnalyticsWidget

    onWidgetsChange?.([...widgets, nextWidget])
  }

  return (
    <aside className="workbench-panel sticky top-[92px] max-h-[calc(100svh-112px)] overflow-auto p-4 max-[980px]:static max-[980px]:max-h-none" data-testid="analytics-builder">
      <div>
        <p className="workbench-eyebrow">{t('analytics.builder.eyebrow')}</p>
        <h2 className="mt-2 text-base font-semibold text-[var(--workbench-text)]">
          {t('analytics.builder.title')}
        </h2>
        <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
          {t('analytics.builder.description')}
        </p>
      </div>

      <div className="mt-5 grid gap-3">
        <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.builder.name')}
          <input className="workbench-input min-h-10 px-3" value={name} onChange={(event) => onNameChange(event.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.builder.descriptionLabel')}
          <textarea className="workbench-input min-h-20 resize-y p-3" value={description} onChange={(event) => onDescriptionChange(event.target.value)} />
        </label>
        <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.builder.visibility')}
          <select className="workbench-input min-h-10 px-3" value={visibility} onChange={(event) => onVisibilityChange(event.target.value as AnalyticsReport['visibility'])}>
            <option value="personal">{t('analytics.visibility.personal')}</option>
            <option value="team">{t('analytics.visibility.team')}</option>
            <option value="shared">{t('analytics.visibility.shared')}</option>
          </select>
        </label>
        {visibility === 'team' ? (
          <label className="grid gap-1.5 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('analytics.builder.team')}
            <select className="workbench-input min-h-10 px-3" value={selectedTeamId} onChange={(event) => onSelectedTeamIdChange(event.target.value)}>
              <option value="">{t('analytics.builder.selectTeam')}</option>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          </label>
        ) : null}
      </div>

      <div className="mt-6 border-t border-[var(--workbench-border)] pt-4">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--workbench-muted)]">
          {t('analytics.builder.addWidget')}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button className="workbench-button-secondary min-h-10 px-3" type="button" onClick={() => addWidget('metric')}>
            {t('analytics.builder.type.metric')}
          </button>
          <button className="workbench-button-secondary min-h-10 px-3" type="button" onClick={() => addWidget('chart', 'line')}>
            {t('analytics.builder.type.line')}
          </button>
          <button className="workbench-button-secondary min-h-10 px-3" type="button" onClick={() => addWidget('chart', 'bar')}>
            {t('analytics.builder.type.bar')}
          </button>
          <button className="workbench-button-secondary min-h-10 px-3" type="button" onClick={() => addWidget('table')}>
            {t('analytics.builder.type.table')}
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3">
        {widgets.map((widget, index) => (
          <AnalyticsWidgetEditor
            index={index}
            key={widget.id}
            t={t}
            total={widgets.length}
            widget={widget}
            onChange={(nextWidget) => onWidgetsChange?.(
              widgets.map((candidate) => candidate.id === widget.id ? nextWidget : candidate),
            )}
            onMove={(direction) => onWidgetsChange?.(moveItem(widgets, index, index + direction))}
            onRemove={() => onWidgetsChange?.(
              widgets.filter((candidate) => candidate.id !== widget.id),
            )}
          />
        ))}
        {widgets.length === 0 ? (
          <p className="rounded-lg border border-dashed border-[var(--workbench-border-strong)] px-4 py-6 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('analytics.builder.noWidgets')}
          </p>
        ) : null}
      </div>
    </aside>
  )
}

function AnalyticsWidgetEditor({
  index,
  onChange,
  onMove,
  onRemove,
  t,
  total,
  widget,
}: {
  index: number
  onChange: (widget: AnalyticsWidget) => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
  t: ReturnType<typeof createTranslator>
  total: number
  widget: AnalyticsWidget
}) {
  const size = readWidgetSize(widget)
  const group = widget.groupBy?.dimension ?? ''
  const customFieldId = widget.groupBy?.dimension === 'custom-field'
    ? widget.groupBy.customFieldId
    : ''
  const titleDraft = useDebouncedDraft(
    widget.title,
    (title) => onChange({ ...widget, title }),
  )
  const customFieldIdDraft = useDebouncedDraft(
    customFieldId,
    (value) => {
      const normalized = value.trim()
      if (!normalized) return
      onChange({
        ...widget,
        groupBy: {
          customFieldId: normalized,
          dimension: 'custom-field',
        },
      })
    },
  )
  const slaTargetDraft = useDebouncedDraft(
    String(widget.slaTargetHours ?? 24),
    (value) => {
      const slaTargetHours = Number(value)
      if (Number.isFinite(slaTargetHours) && slaTargetHours > 0) {
        onChange({ ...widget, slaTargetHours })
      }
    },
  )

  return (
    <section className="rounded-lg border border-[var(--workbench-border)] bg-[var(--workbench-surface-muted)] p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="workbench-badge">{t(widgetTypeLabelKeys[widget.type])}</span>
        <span className="flex items-center gap-1">
          <button aria-label={t('analytics.builder.moveUp')} className="grid h-8 w-8 place-items-center rounded-md border border-[var(--workbench-border)] bg-white disabled:opacity-35" disabled={index === 0} type="button" onClick={() => onMove(-1)}>↑</button>
          <button aria-label={t('analytics.builder.moveDown')} className="grid h-8 w-8 place-items-center rounded-md border border-[var(--workbench-border)] bg-white disabled:opacity-35" disabled={index === total - 1} type="button" onClick={() => onMove(1)}>↓</button>
          <button aria-label={t('analytics.builder.remove')} className="grid h-8 w-8 place-items-center rounded-md border border-red-200 bg-white text-red-700" type="button" onClick={onRemove}>×</button>
        </span>
      </div>
      <label className="mt-3 grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('analytics.builder.widgetTitle')}
        <input
          className="workbench-input min-h-9 px-2"
          value={titleDraft.value}
          onBlur={titleDraft.flush}
          onChange={(event) => titleDraft.update(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              titleDraft.flush()
            }
          }}
        />
      </label>
      <label className="mt-2 grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {t('analytics.builder.metric')}
        <select className="workbench-input min-h-9 px-2" value={widget.metric} onChange={(event) => onChange({ ...widget, metric: event.target.value as AnalyticsMetricKey })}>
          {metricKeys.map((metric) => <option key={metric} value={metric}>{t(metricLabelKeys[metric])}</option>)}
        </select>
      </label>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.builder.group')}
          <select
            className="workbench-input min-h-9 px-2"
            value={group}
            onChange={(event) => onChange({
              ...widget,
              groupBy: event.target.value
                ? event.target.value === 'custom-field'
                  ? {
                      customFieldId,
                      dimension: 'custom-field',
                    }
                  : {
                      dimension: event.target.value,
                    } as AnalyticsWidget['groupBy']
                : undefined,
            })}
          >
            <option value="">{t('analytics.builder.groupNone')}</option>
            {[
              'day',
              'week',
              'month',
              'team',
              'project',
              'assignee',
              'status',
              'work-item-type',
              'custom-field',
            ].map((dimension) => (
              <option key={dimension} value={dimension}>
                {t(dimension === 'custom-field'
                  ? 'analytics.group.customField'
                  : `analytics.group.${dimension}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.builder.size')}
          <select className="workbench-input min-h-9 px-2" value={size} onChange={(event) => onChange({ ...widget, size: event.target.value } as AnalyticsWidget)}>
            <option value="small">{t('analytics.size.small')}</option>
            <option value="medium">{t('analytics.size.medium')}</option>
            <option value="large">{t('analytics.size.large')}</option>
          </select>
        </label>
      </div>
      {group === 'custom-field' ? (
        <label className="mt-2 grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.builder.customFieldId')}
          <input
            className="workbench-input min-h-9 px-2"
            placeholder={t('analytics.builder.customFieldIdPlaceholder')}
            required
            value={customFieldIdDraft.value}
            onBlur={customFieldIdDraft.flush}
            onChange={(event) => customFieldIdDraft.update(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                customFieldIdDraft.flush()
              }
            }}
          />
        </label>
      ) : null}
      {widget.metric === 'sla' ? (
        <label className="mt-2 grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
          {t('analytics.builder.slaTarget')}
          <input
            className="workbench-input min-h-9 px-2"
            min="1"
            type="number"
            value={slaTargetDraft.value}
            onBlur={slaTargetDraft.flush}
            onChange={(event) => slaTargetDraft.update(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                slaTargetDraft.flush()
              }
            }}
          />
        </label>
      ) : null}
    </section>
  )
}

function AnalyticsMetricCard({
  locale,
  onOpenEvidence,
  result,
  snapshot,
  t,
  widget,
}: {
  locale: Locale
  onOpenEvidence?: (input: AnalyticsEvidenceInput) => void
  result: AnalyticsWidgetResult
  snapshot: AnalyticsSnapshot
  t: ReturnType<typeof createTranslator>
  widget?: AnalyticsWidget
}) {
  return (
    <section className="workbench-panel min-w-0 p-4" data-testid={`analytics-widget-${result.widgetId}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-[var(--workbench-muted)]" title={widget?.title ?? result.definition.label}>
            {widget?.title ?? result.definition.label}
          </p>
          <p className="mt-2 text-3xl font-semibold leading-none tabular-nums text-[var(--workbench-text)]">
            {formatMetricValue(result.value, result.definition.unit, locale, t)}
          </p>
        </div>
        <span className="workbench-badge">{result.sampleSize}</span>
      </div>
      <p className="mt-3 line-clamp-2 text-xs font-medium leading-5 text-[var(--workbench-muted)]">
        {t(metricDescriptionKeys[result.metric])}
      </p>
      {result.warnings.length > 0 ? (
        <p className="mt-3 text-xs font-semibold text-amber-700">
          {formatAnalyticsWarning(result.warnings[0] ?? '', t)}
        </p>
      ) : null}
      <button
        className="mt-4 text-xs font-semibold text-[var(--workbench-primary)] underline-offset-2 hover:underline disabled:text-[var(--workbench-muted-soft)]"
        disabled={!onOpenEvidence}
        type="button"
        onClick={() => onOpenEvidence?.(createEvidenceInput(result, snapshot, widget))}
      >
        {t('analytics.drillDown')}
      </button>
    </section>
  )
}

function AnalyticsResultWidget({
  locale,
  onOpenEvidence,
  result,
  snapshot,
  t,
  widget,
  workItemTypeLabels,
}: {
  locale: Locale
  onOpenEvidence?: (input: AnalyticsEvidenceInput) => void
  result: AnalyticsWidgetResult
  snapshot: AnalyticsSnapshot
  t: ReturnType<typeof createTranslator>
  widget?: AnalyticsWidget
  workItemTypeLabels: ReadonlyMap<string, string>
}) {
  const widgetType = widget?.type ?? (result.rows.length > 0 ? 'table' : 'chart')
  const size = readWidgetSize(widget)
  const columnClassName = size === 'small'
    ? 'col-span-4 max-[1000px]:col-span-6 max-[680px]:col-span-12'
    : size === 'medium'
      ? 'col-span-6 max-[900px]:col-span-12'
      : 'col-span-8 max-[1100px]:col-span-12'
  const points = normalizeWidgetPoints(
    result,
    snapshot.timeZone,
    widget?.groupBy?.dimension === 'work-item-type' ? workItemTypeLabels : undefined,
  )

  return (
    <section className={`workbench-panel min-w-0 overflow-hidden ${columnClassName}`} data-testid={`analytics-widget-${result.widgetId}`}>
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-[var(--workbench-border)] px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-[var(--workbench-text)]">
            {widget?.title ?? result.definition.label}
          </h2>
          <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">
            {t(metricDescriptionKeys[result.metric])}
          </p>
        </div>
        <button
          className="text-xs font-semibold text-[var(--workbench-primary)] underline-offset-2 hover:underline disabled:text-[var(--workbench-muted-soft)]"
          disabled={!onOpenEvidence}
          type="button"
          onClick={() => onOpenEvidence?.(createEvidenceInput(result, snapshot, widget))}
        >
          {t('analytics.drillDown')}
        </button>
      </div>
      <div className="p-5">
        {result.warnings.length > 0 ? (
          <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
            {result.warnings
              .map((warning) => formatAnalyticsWarning(warning, t))
              .join(' ')}
          </p>
        ) : null}
        {widgetType === 'table' ? (
          <AnalyticsTable
            result={result}
            t={t}
            workItemTypeLabels={
              widget?.groupBy?.dimension === 'work-item-type'
                ? workItemTypeLabels
                : undefined
            }
          />
        ) : points.length > 0 ? (
          <AccessibleChart
            label={widget?.title ?? result.definition.label}
            locale={locale}
            points={points}
            t={t}
            unit={result.definition.unit}
            visualization={readWidgetVisualization(widget)}
          />
        ) : (
          <p className="py-12 text-center text-sm font-medium text-[var(--workbench-muted)]">
            {t('analytics.widget.empty')}
          </p>
        )}
      </div>
    </section>
  )
}

function AccessibleChart({
  label,
  locale,
  points,
  t,
  unit,
  visualization,
}: {
  label: string
  locale: Locale
  points: ReturnType<typeof normalizeWidgetPoints>
  t: ReturnType<typeof createTranslator>
  unit: AnalyticsWidgetResult['definition']['unit']
  visualization: 'bar' | 'line'
}) {
  const values = points.flatMap((point) =>
    isDrawableChartValue(point.value) ? [point.value] : [])
  const maximum = Math.max(...values, 1)
  const width = 640
  const height = 220
  const padding = 28
  const chartWidth = width - padding * 2
  const chartHeight = height - padding * 2
  const barSlotWidth = chartWidth / Math.max(points.length, 1)
  const coordinates = points.map((point, index) => ({
    ...point,
    index,
    x: visualization === 'bar'
      ? padding + barSlotWidth * (index + 0.5)
      : padding + (points.length === 1
          ? chartWidth / 2
          : index * chartWidth / (points.length - 1)),
    y: isDrawableChartValue(point.value)
      ? padding + chartHeight - (point.value / maximum) * chartHeight
      : undefined,
  }))
  const linePaths: string[] = []
  let currentLinePath = ''
  for (const point of coordinates) {
    if (point.y === undefined) {
      if (currentLinePath) linePaths.push(currentLinePath)
      currentLinePath = ''
      continue
    }
    currentLinePath += `${currentLinePath ? ' L' : 'M'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`
  }
  if (currentLinePath) linePaths.push(currentLinePath)

  return (
    <div>
      <div aria-label={label} role="img">
        <svg className="h-auto w-full overflow-visible" viewBox={`0 0 ${width} ${height}`}>
          <title>{label}</title>
          {[0, 0.5, 1].map((ratio) => (
            <line
              key={ratio}
              stroke="#dde4e1"
              strokeDasharray="4 5"
              x1={padding}
              x2={width - padding}
              y1={padding + chartHeight * ratio}
              y2={padding + chartHeight * ratio}
            />
          ))}
          {visualization === 'bar'
            ? coordinates.map((point, index) => {
                const barWidth = Math.max(6, Math.min(72, barSlotWidth * 0.58))
                if (point.y === undefined) {
                  const markerRadius = Math.min(7, barWidth / 3)
                  const markerY = padding + chartHeight - 5
                  return (
                    <g
                      aria-hidden="true"
                      data-testid={`analytics-bar-missing-${index}`}
                      key={`${point.label}-${index}`}
                      stroke="#78837f"
                      strokeLinecap="round"
                      strokeWidth="2"
                    >
                      <line
                        x1={point.x - markerRadius}
                        x2={point.x + markerRadius}
                        y1={markerY - markerRadius}
                        y2={markerY + markerRadius}
                      />
                      <line
                        x1={point.x - markerRadius}
                        x2={point.x + markerRadius}
                        y1={markerY + markerRadius}
                        y2={markerY - markerRadius}
                      />
                    </g>
                  )
                }
                const barHeight = Math.max(2, padding + chartHeight - point.y)
                return (
                  <rect
                    data-testid={`analytics-bar-${index}`}
                    fill="#0f766e"
                    height={barHeight}
                    key={`${point.label}-${index}`}
                    rx="4"
                    width={barWidth}
                    x={point.x - barWidth / 2}
                    y={padding + chartHeight - barHeight}
                  />
                )
              })
            : (
              <>
                {linePaths.map((path, index) => (
                  <path
                    d={path}
                    data-testid={`analytics-line-segment-${index}`}
                    fill="none"
                    key={path}
                    stroke="#0f766e"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="4"
                  />
                ))}
                {coordinates.map((point) => point.y === undefined ? null : (
                  <circle
                    cx={point.x}
                    cy={point.y}
                    data-testid={`analytics-line-point-${point.index}`}
                    fill="#ffffff"
                    key={`${point.label}-${point.index}`}
                    r="5"
                    stroke="#0f766e"
                    strokeWidth="3"
                  />
                ))}
              </>
            )}
        </svg>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs font-semibold text-[var(--workbench-muted)]">
        <span>{points[0]?.label}</span>
        <span>{points.at(-1)?.label}</span>
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--workbench-primary)]">
          {t('analytics.chart.tableFallback')}
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[360px] border-collapse text-left text-sm">
            <thead>
              <tr className="workbench-table-head">
                <th className="px-3 py-2" scope="col">{t('analytics.chart.bucket')}</th>
                <th className="px-3 py-2 text-right" scope="col">{t('analytics.chart.value')}</th>
                <th className="px-3 py-2 text-right" scope="col">{t('analytics.chart.samples')}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr className="border-b border-[var(--workbench-border)]" key={point.key}>
                  <td className="px-3 py-2">{point.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMetricValue(point.value, unit, locale, t)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{point.sampleSize}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function isDrawableChartValue(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function AnalyticsTable({
  result,
  t,
  workItemTypeLabels,
}: {
  result: AnalyticsWidgetResult
  t: ReturnType<typeof createTranslator>
  workItemTypeLabels?: ReadonlyMap<string, string>
}) {
  const columns = [...new Set(result.rows.flatMap((row) => Object.keys(row.values)))].slice(0, 6)

  if (result.rows.length === 0) {
    return (
      <p className="py-12 text-center text-sm font-medium text-[var(--workbench-muted)]">
        {t('analytics.widget.empty')}
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] border-collapse text-left text-sm">
        <thead>
          <tr className="workbench-table-head">
            <th className="px-3 py-2" scope="col">{t('analytics.table.item')}</th>
            {columns.map((column) => (
              <th className="px-3 py-2" key={column} scope="col">
                {tableColumnLabelKeys[column]
                  ? t(tableColumnLabelKeys[column])
                  : column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row) => (
            <tr className="border-b border-[var(--workbench-border)]" key={row.id}>
              <th className="px-3 py-3 font-semibold" scope="row">
                {workItemTypeLabels?.get(row.label) ?? row.label}
              </th>
              {columns.map((column) => (
                <td className="px-3 py-3 tabular-nums text-[var(--workbench-muted)]" key={column}>
                  {formatTableValue(row.values[column])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function AnalyticsForecastCard({
  locale,
  snapshot,
  t,
}: {
  locale: Locale
  snapshot: AnalyticsSnapshot
  t: ReturnType<typeof createTranslator>
}) {
  const forecast = snapshot.forecast
  const confidence = Math.round(Math.max(0, Math.min(1, forecast.confidence)) * 100)
  const riskClasses = {
    unknown: 'workbench-badge',
    low: 'workbench-badge-success',
    medium: 'workbench-badge-warning',
    high: 'workbench-badge-danger',
  } as const

  return (
    <section className="workbench-panel col-span-4 overflow-hidden max-[1100px]:col-span-12" data-testid="analytics-forecast">
      <div className="border-b border-[var(--workbench-border)] px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--workbench-text)]">{t('analytics.forecast.title')}</h2>
            <p className="mt-1 text-xs font-medium text-[var(--workbench-muted)]">{t('analytics.forecast.description')}</p>
          </div>
          <span className={riskClasses[forecast.risk]}>
            {t(`analytics.forecast.risk.${forecast.risk}`)}
          </span>
        </div>
      </div>
      <div className="grid gap-4 p-5">
        <div>
          <div className="flex items-center justify-between gap-3 text-xs font-semibold text-[var(--workbench-muted)]">
            <span>{t('analytics.forecast.confidence')}</span>
            <span className="tabular-nums">{confidence}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[var(--workbench-surface-muted)]">
            <div className="h-full rounded-full bg-[var(--workbench-primary)]" style={{ width: `${confidence}%` }} />
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-3">
          <ForecastValue label={t('analytics.forecast.p50')} value={formatForecastDate(forecast.p50, locale, snapshot.timeZone, t)} />
          <ForecastValue label={t('analytics.forecast.p85')} value={formatForecastDate(forecast.p85, locale, snapshot.timeZone, t)} />
          <ForecastValue label={t('analytics.forecast.p95')} value={formatForecastDate(forecast.p95, locale, snapshot.timeZone, t)} />
          <ForecastValue label={t('analytics.forecast.remaining')} value={String(forecast.remainingWorkItems)} />
        </dl>
        <p className="text-xs font-medium leading-5 text-[var(--workbench-muted)]">
          {t('analytics.forecast.sample')
            .replace('{count}', String(forecast.sampleSize))
            .replace('{rate}', forecast.dailyThroughput.toFixed(2))}
        </p>
        {forecast.baseline ? (
          <p className="rounded-md bg-[var(--workbench-surface-muted)] px-3 py-2 text-xs font-semibold text-[var(--workbench-muted)]">
            {t('analytics.forecast.baseline')
              .replace('{from}', formatDateTime(forecast.baseline.from, locale, snapshot.timeZone))
              .replace('{to}', formatDateTime(forecast.baseline.to, locale, snapshot.timeZone))}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function ForecastValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--workbench-border)] p-3">
      <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums text-[var(--workbench-text)]">{value}</dd>
    </div>
  )
}

function AnalyticsEvidenceDrawer({
  evidence,
  isLoading,
  locale,
  metric,
  onClose,
  onLoadMore,
  onOpenWorkItem,
  t,
  timeZone,
}: {
  evidence?: AnalyticsEvidenceResponse
  isLoading: boolean
  locale: Locale
  metric?: AnalyticsMetricKey
  onClose?: () => void
  onLoadMore?: () => void
  onOpenWorkItem?: (item: AnalyticsEvidenceItem) => void
  t: ReturnType<typeof createTranslator>
  timeZone: string
}) {
  const dialogRef = useModalFocus<HTMLElement>(() => onClose?.())

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/30" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose?.()
    }}>
      <aside ref={dialogRef} aria-label={t('analytics.evidence.title')} aria-modal="true" className="ml-auto flex h-full w-full max-w-[560px] flex-col border-l border-[var(--workbench-border)] bg-white shadow-2xl" role="dialog" tabIndex={-1}>
        <header className="flex items-start justify-between gap-4 border-b border-[var(--workbench-border)] px-5 py-4">
          <div>
            <p className="workbench-eyebrow">{t('analytics.evidence.eyebrow')}</p>
            <h2 className="mt-2 text-lg font-semibold text-[var(--workbench-text)]">
              {metric ? t(metricLabelKeys[metric]) : t('analytics.evidence.title')}
            </h2>
            <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
              {t('analytics.evidence.description')}
            </p>
          </div>
          <button aria-label={t('analytics.evidence.close')} className="grid h-10 w-10 place-items-center rounded-md border border-[var(--workbench-border)] text-xl" type="button" onClick={onClose}>×</button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {isLoading && !evidence ? (
            <p className="p-5 text-sm font-semibold text-[var(--workbench-muted)]">{t('analytics.evidence.loading')}</p>
          ) : evidence?.items.length ? (
            <div className="divide-y divide-[var(--workbench-border)]">
              {evidence.items.map((item) => (
                <button
                  className="grid w-full gap-2 px-5 py-4 text-left transition hover:bg-[var(--workbench-surface-muted)] disabled:hover:bg-white"
                  disabled={!onOpenWorkItem}
                  key={item.id}
                  type="button"
                  onClick={() => onOpenWorkItem?.(item)}
                >
                  <span className="font-semibold text-[var(--workbench-text)]">{item.title}</span>
                  <span className="flex flex-wrap items-center gap-2 text-xs font-medium text-[var(--workbench-muted)]">
                    <span>{item.teamId}</span>
                    {item.projectId ? <span>· {item.projectId}</span> : null}
                    <span>· {formatDateTime(item.occurredAt, locale, timeZone)}</span>
                  </span>
                  <span className="flex flex-wrap gap-2">
                    <span className="workbench-badge">{item.workItemId}</span>
                    {item.eventId ? <span className="workbench-badge-primary">{item.eventId}</span> : null}
                    {item.value !== undefined ? <span className="workbench-badge">{item.value}</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="p-8 text-center text-sm font-semibold text-[var(--workbench-muted)]">{t('analytics.evidence.empty')}</p>
          )}
        </div>
        {evidence?.nextCursor ? (
          <div className="border-t border-[var(--workbench-border)] p-4">
            <button className="workbench-button-secondary min-h-10 w-full px-4 disabled:opacity-50" disabled={isLoading || !onLoadMore} type="button" onClick={onLoadMore}>
              {isLoading ? t('analytics.evidence.loading') : t('analytics.evidence.loadMore')}
            </button>
          </div>
        ) : null}
      </aside>
    </div>
  )
}

function AnalyticsScheduleDialog({
  initialSchedule,
  isTeamVisibilityValid,
  onClose,
  onSave,
  reportName,
  t,
  timeZone,
}: {
  initialSchedule?: AnalyticsSchedule
  isTeamVisibilityValid: boolean
  onClose: () => void
  onSave: (schedule: AnalyticsSchedule | null) => Promise<void> | void
  reportName: string
  t: ReturnType<typeof createTranslator>
  timeZone: string
}) {
  const [isSaving, setIsSaving] = useState(false)
  const [frequency, setFrequency] = useState(
    initialSchedule?.frequency ?? 'weekly',
  )
  const [validationMessage, setValidationMessage] = useState<string | undefined>(
    isTeamVisibilityValid
      ? undefined
      : t('analytics.schedule.teamRequired'),
  )
  const dialogRef = useModalFocus<HTMLElement>(onClose)

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 px-4 py-6" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section ref={dialogRef} aria-label={t('analytics.schedule.title')} aria-modal="true" className="workbench-panel w-full max-w-[560px] overflow-hidden" role="dialog" tabIndex={-1}>
        <div className="flex items-start justify-between gap-4 border-b border-[var(--workbench-border)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-[var(--workbench-text)]">{t('analytics.schedule.title')}</h2>
            <p className="mt-1 text-sm font-medium text-[var(--workbench-muted)]">
              {t('analytics.schedule.description').replace('{name}', reportName)}
            </p>
          </div>
          <button aria-label={t('analytics.schedule.close')} className="grid h-9 w-9 place-items-center rounded-md border border-[var(--workbench-border)]" type="button" onClick={onClose}>×</button>
        </div>
        <form
          className="grid gap-4 p-5"
          key={`${reportName}:${initialSchedule?.nextRunAt ?? 'new'}`}
          onSubmit={async (event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            const frequency = readScheduleFrequency(data.get('frequency'))
            const dayOfWeek = Number(data.get('dayOfWeek'))
            const dayOfMonth = Number(data.get('dayOfMonth'))
            const recipientMemberKeys = splitValues(
              String(data.get('recipients') || ''),
            ) ?? []
            if (!isTeamVisibilityValid) {
              setValidationMessage(t('analytics.schedule.teamRequired'))
              return
            }
            if (recipientMemberKeys.length === 0) {
              setValidationMessage(t('analytics.schedule.recipientsRequired'))
              return
            }
            setValidationMessage(undefined)
            const schedule = {
              dayOfMonth: frequency === 'monthly' && dayOfMonth ? dayOfMonth : undefined,
              dayOfWeek: frequency === 'weekly' && Number.isFinite(dayOfWeek) ? dayOfWeek : undefined,
              enabled: true,
              format: data.get('format') === 'pdf' ? 'pdf' : 'csv',
              frequency,
              localTime: String(data.get('localTime') || '09:00'),
              recipientMemberKeys,
              timeZone: String(data.get('timeZone') || timeZone),
            } satisfies AnalyticsSchedule
            setIsSaving(true)
            try {
              await onSave(schedule)
            } finally {
              setIsSaving(false)
            }
          }}
        >
          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('analytics.schedule.frequency')}
              <select
                className="workbench-input min-h-10 px-3"
                data-modal-initial-focus
                name="frequency"
                value={frequency}
                onChange={(event) =>
                  setFrequency(readScheduleFrequency(event.target.value))}
              >
                <option value="daily">{t('analytics.schedule.daily')}</option>
                <option value="weekly">{t('analytics.schedule.weekly')}</option>
                <option value="monthly">{t('analytics.schedule.monthly')}</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('analytics.schedule.time')}
              <input className="workbench-input min-h-10 px-3" defaultValue={initialSchedule?.localTime ?? '09:00'} name="localTime" type="time" />
            </label>
            {frequency === 'weekly' ? (
              <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('analytics.schedule.dayOfWeek')}
                <select className="workbench-input min-h-10 px-3" defaultValue={initialSchedule?.dayOfWeek ?? 1} name="dayOfWeek">
                  {[
                    'analytics.schedule.sunday',
                    'analytics.schedule.monday',
                    'analytics.schedule.tuesday',
                    'analytics.schedule.wednesday',
                    'analytics.schedule.thursday',
                    'analytics.schedule.friday',
                    'analytics.schedule.saturday',
                  ].map((key, index) => <option key={key} value={index}>{t(key as MessageKey)}</option>)}
                </select>
              </label>
            ) : null}
            {frequency === 'monthly' ? (
              <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
                {t('analytics.schedule.dayOfMonth')}
                <input className="workbench-input min-h-10 px-3" defaultValue={initialSchedule?.dayOfMonth ?? 1} max="31" min="1" name="dayOfMonth" type="number" />
              </label>
            ) : null}
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('analytics.schedule.timeZone')}
              <input className="workbench-input min-h-10 px-3" defaultValue={initialSchedule?.timeZone ?? timeZone} name="timeZone" />
            </label>
            <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
              {t('analytics.schedule.format')}
              <select className="workbench-input min-h-10 px-3" defaultValue={initialSchedule?.format ?? 'pdf'} name="format">
                <option value="pdf">PDF</option>
                <option value="csv">CSV</option>
              </select>
            </label>
          </div>
          <label className="grid gap-1.5 text-sm font-semibold text-[var(--workbench-text)]">
            {t('analytics.schedule.recipients')}
            <textarea className="workbench-input min-h-20 p-3" defaultValue={initialSchedule?.recipientMemberKeys.join(', ') ?? ''} name="recipients" placeholder={t('analytics.schedule.recipientsPlaceholder')} required />
          </label>
          {validationMessage ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700" role="alert">
              {validationMessage}
            </p>
          ) : null}
          {initialSchedule?.nextRunAt ? (
            <p className="text-xs font-semibold text-[var(--workbench-muted)]">
              {t('analytics.schedule.nextRun')}: {initialSchedule.nextRunAt}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-between gap-3 border-t border-[var(--workbench-border)] pt-4">
            <button
              className="text-sm font-semibold text-red-700 disabled:opacity-50"
              disabled={isSaving || !initialSchedule}
              type="button"
              onClick={async () => {
                setIsSaving(true)
                try {
                  await onSave(null)
                } finally {
                  setIsSaving(false)
                }
              }}
            >
              {t('analytics.schedule.disable')}
            </button>
            <span className="flex gap-2">
              <button className="workbench-button-secondary min-h-10 px-4" disabled={isSaving} type="button" onClick={onClose}>{t('analytics.schedule.cancel')}</button>
              <button className="workbench-button-primary min-h-10 px-4 disabled:opacity-50" disabled={isSaving || !isTeamVisibilityValid} type="submit">{isSaving ? t('analytics.schedule.saving') : t('analytics.schedule.save')}</button>
            </span>
          </div>
        </form>
      </section>
    </div>
  )
}

function AnalyticsLoadingState({ t }: { t: ReturnType<typeof createTranslator> }) {
  return (
    <div aria-label={t('analytics.loading')} className="grid gap-5" role="status">
      <div className="grid grid-cols-4 gap-4 max-[680px]:grid-cols-1">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="h-28 animate-pulse rounded-lg border border-[var(--workbench-border)] bg-white" key={index} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-5 max-[900px]:grid-cols-1">
        <div className="h-80 animate-pulse rounded-lg border border-[var(--workbench-border)] bg-white" />
        <div className="h-80 animate-pulse rounded-lg border border-[var(--workbench-border)] bg-white" />
      </div>
    </div>
  )
}

function AnalyticsNoResults({ t }: { t: ReturnType<typeof createTranslator> }) {
  return (
    <section className="workbench-panel grid min-h-[320px] place-items-center px-6 py-12 text-center">
      <div>
        <p className="text-lg font-semibold text-[var(--workbench-text)]">{t('analytics.noResults.title')}</p>
        <p className="mx-auto mt-2 max-w-[520px] text-sm font-medium text-[var(--workbench-muted)]">{t('analytics.noResults.description')}</p>
      </div>
    </section>
  )
}

function createEvidenceInput(
  result: AnalyticsWidgetResult,
  snapshot: AnalyticsSnapshot,
  widget?: AnalyticsWidget,
) {
  return {
    asOf: snapshot.asOf,
    filter: snapshot.filter,
    limit: 40,
    metric: result.metric,
    slaTargetHours: widget?.slaTargetHours,
    timeZone: snapshot.timeZone,
  } satisfies AnalyticsEvidenceInput
}

function normalizeWidgetPoints(
  result: AnalyticsWidgetResult,
  timeZone: string,
  workItemTypeLabels?: ReadonlyMap<string, string>,
) {
  if (result.series.length > 0) {
    return result.series.map((point, index) => ({
      key: `${point.from}:${point.to}:${index}`,
      label: formatBucketLabel(point.from, point.to, timeZone),
      sampleSize: point.sampleSize,
      value: point.value,
    }))
  }

  return result.groups.map((group) => ({
    key: group.key,
    label: workItemTypeLabels?.get(group.label) ?? group.label,
    sampleSize: group.sampleSize,
    value: group.value,
  }))
}

function resolveWidgetType(
  widgets: readonly AnalyticsWidget[],
  widgetId: string,
) {
  return widgets.find((widget) => widget.id === widgetId)?.type ?? 'chart'
}

function readWidgetSize(widget?: AnalyticsWidget) {
  const size = asRecord(widget).size
  return size === 'small' || size === 'medium' || size === 'large'
    ? size
    : widget?.type === 'metric'
      ? 'small'
      : 'large'
}

function readWidgetVisualization(widget?: AnalyticsWidget) {
  return asRecord(widget).visualization === 'bar' ? 'bar' : 'line'
}

function formatMetricValue(
  value: number | null,
  unit: AnalyticsWidgetResult['definition']['unit'],
  locale: Locale,
  t: ReturnType<typeof createTranslator>,
) {
  if (value === null || !Number.isFinite(value)) {
    return t('analytics.value.unavailable')
  }

  const formatter = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 'count' ? 0 : 1,
  })
  const formatted = formatter.format(value)

  if (unit === 'hours') return t('analytics.value.hours').replace('{value}', formatted)
  if (unit === 'items-per-week') return t('analytics.value.perWeek').replace('{value}', formatted)
  if (unit === 'percent') return `${formatted}%`
  return formatted
}

function formatForecastDate(
  value: string | null,
  locale: Locale,
  timeZone: string,
  t: ReturnType<typeof createTranslator>,
) {
  return value ? formatDateTime(value, locale, timeZone) : t('analytics.value.unavailable')
}

function formatDateTime(value: string, locale: Locale, timeZone: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(date)
  } catch {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(date)
  }
}

function formatBucketLabel(from: string, to: string, timeZone: string) {
  const fromDate = formatAnalyticsCalendarDate(from, timeZone)
  const toDate = formatAnalyticsCalendarDate(to, timeZone)
  return fromDate === toDate ? fromDate : `${fromDate} – ${toDate}`
}

function formatTableValue(value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? '✓' : '—'
  return String(value)
}

function formatAnalyticsWarning(
  warning: string,
  t: ReturnType<typeof createTranslator>,
) {
  if (warning === 'No effective completions were recorded in this period.') {
    return t('analytics.warning.noCompletions')
  }
  if (warning === 'No cycle time samples are available.') {
    return t('analytics.warning.noCycleTime')
  }
  if (warning === 'No lead time samples are available.') {
    return t('analytics.warning.noLeadTime')
  }
  if (warning === 'No Project scope changes were recorded in this period.') {
    return t('analytics.warning.noScopeChanges')
  }
  if (warning === 'No SLA samples are available.') {
    return t('analytics.warning.noSlaSamples')
  }
  const invalidDueDates = /^(\d+) Work Item due date value\(s\) were invalid and excluded\.$/u
    .exec(warning)
  if (invalidDueDates?.[1]) {
    return t('analytics.warning.invalidDueDates').replace(
      '{count}',
      invalidDueDates[1],
    )
  }
  return warning
}

function splitValues(value: string) {
  const values = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
  return values.length > 0 ? values : undefined
}

function customFieldOperatorNeedsValue(
  operator: AnalyticsCustomFieldFilter['operator'],
) {
  return operator !== 'is-empty' && operator !== 'is-not-empty'
}

function formatCustomFieldFilterValue(
  value: AnalyticsCustomFieldFilter['value'],
) {
  return Array.isArray(value) ? value.join(', ') : String(value ?? '')
}

function useDebouncedDraft(
  sourceValue: string,
  onCommit: (value: string) => void,
  delayMilliseconds = 400,
) {
  const [value, setValue] = useState(sourceValue)
  const valueRef = useRef(sourceValue)
  const isDirtyRef = useRef(false)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const commitRef = useRef(onCommit)

  useEffect(() => {
    commitRef.current = onCommit
  }, [onCommit])

  useEffect(() => {
    if (!isDirtyRef.current) {
      valueRef.current = sourceValue
      setValue(sourceValue)
    }
  }, [sourceValue])

  useEffect(() => () => {
    if (timeoutRef.current !== undefined) {
      clearTimeout(timeoutRef.current)
    }
  }, [])

  const flush = useCallback(() => {
    if (!isDirtyRef.current) return
    if (timeoutRef.current !== undefined) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = undefined
    }
    isDirtyRef.current = false
    commitRef.current(valueRef.current)
  }, [])

  const update = useCallback((nextValue: string) => {
    if (timeoutRef.current !== undefined) {
      clearTimeout(timeoutRef.current)
    }
    valueRef.current = nextValue
    isDirtyRef.current = true
    setValue(nextValue)
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = undefined
      isDirtyRef.current = false
      commitRef.current(nextValue)
    }, delayMilliseconds)
  }, [delayMilliseconds])

  return { flush, update, value }
}

function uniqueProjects(teams: readonly ProjectDirectoryTeam[]) {
  const projects = new Map<string, { id: string; name: string }>()
  for (const team of teams) {
    for (const project of team.projects) {
      if (!projects.has(project.id)) {
        projects.set(project.id, { id: project.id, name: project.name })
      }
    }
  }
  return [...projects.values()]
}

function includeSelectedFilterOptions(
  options: Array<{ label: string; value: string }>,
  selectedValues?: readonly string[],
) {
  const nextOptions = [...options]
  const knownValues = new Set(options.map((option) => option.value))
  for (const value of selectedValues ?? []) {
    if (!knownValues.has(value)) {
      nextOptions.push({ label: value, value })
      knownValues.add(value)
    }
  }
  return nextOptions
}

function moveItem<T>(items: readonly T[], from: number, to: number) {
  if (to < 0 || to >= items.length || from === to) return [...items]
  const next = [...items]
  const [item] = next.splice(from, 1)
  if (item !== undefined) next.splice(to, 0, item)
  return next
}

function readScheduleFrequency(value: FormDataEntryValue | null) {
  return value === 'daily' || value === 'monthly' ? value : 'weekly'
}

function createAnalyticsClientId(prefix: string) {
  const suffix = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${suffix}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : {}
}
