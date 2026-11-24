import { useMemo, useState } from 'react'
import {
  PROJECT_LIFECYCLE_STATES,
  type PlanningHealth,
  type PortfolioProjectBudget,
  type ProjectLifecycleState,
  type ProjectRaidSeverity,
} from '@mukuroji/contracts'
import type { ProjectDirectoryTeam } from '../../../projects/api'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { printTaskView, taskViewPrintableWidth, type TaskViewPrintPaper } from '../../../shared/ui/viewPrint'
import { MetricCard, ProgressBar, SectionHeader } from '../../../shared/ui/WorkbenchPrimitives'
import {
  arrangePortfolioDashboardRows,
  createPortfolioDashboardCsv,
  DEFAULT_PORTFOLIO_BUDGET_THRESHOLD,
  DEFAULT_PORTFOLIO_DELAY_THRESHOLD_DAYS,
  evaluatePortfolioDashboardAttention,
  listPortfolioDashboardPortfolios,
  openRiskCount,
  type PortfolioDashboardFilters,
  type PortfolioDashboardModel,
  type PortfolioDashboardRow,
  type PortfolioDashboardSort,
  type PortfolioDashboardSortKey,
  type PortfolioDashboardThresholds,
} from '../model/portfolioDashboard'

/** Props of the Workspace portfolio dashboard view. */
export type PortfolioDashboardViewProps = {
  /** Rows and what the reader could not see. */
  model: PortfolioDashboardModel
  /** Directory Teams, for the Team filter. */
  teams: readonly ProjectDirectoryTeam[]
  /** Display locale. */
  locale: Locale
  /** Translator. */
  t: (key: MessageKey) => string
  /** Whether the Agent Run column is shown. */
  showAgentRuns: boolean
  /** Whether Planning health could not be read, so every row shows unknown health. */
  isPlanningUnavailable: boolean
  /** Compared month as `YYYY-MM`, or undefined for no comparison. */
  compareMonth?: string
  /** Months offered for comparison, newest first. */
  compareMonthOptions: readonly string[]
  /** Changes the compared month. */
  onCompareMonthChange: (month: string | undefined) => void
  /** Whether the reader manages at least one whole Team and may save snapshots. */
  canSaveSnapshot: boolean
  /** Whether a snapshot save is running. */
  isSavingSnapshot: boolean
  /** Result of the last snapshot save, when any. */
  snapshotMessage?: string
  /** Saves this month's snapshot of the Teams the reader manages. */
  onSaveSnapshot: () => void
  /** Opens a Project overview. */
  onOpenProject: (teamId: string, projectId: string) => void
  /** Reads the failed Teams, snapshots, and Agent Run counts again. */
  onRetry: () => void
}

/** Badge tokens of reported health. */
const healthClassNames: Record<PlanningHealth, string> = {
  unknown: 'border-slate-200 bg-slate-50 text-fg-slate-600',
  'on-track': 'border-emerald-200 bg-emerald-50 text-fg-emerald-700',
  'at-risk': 'border-amber-200 bg-amber-50 text-fg-amber-800',
  'off-track': 'border-red-200 bg-red-50 text-fg-red-700',
}

/** Translation keys of reported health. */
const healthMessageKeys: Record<PlanningHealth, MessageKey> = {
  unknown: 'workspace.planningUpdate.health.unknown',
  'on-track': 'workspace.planningUpdate.health.onTrack',
  'at-risk': 'workspace.planningUpdate.health.atRisk',
  'off-track': 'workspace.planningUpdate.health.offTrack',
}

/** Translation keys of lifecycle states. */
const lifecycleMessageKeys: Record<ProjectLifecycleState, MessageKey> = {
  proposed: 'projects.lifecycle.proposed',
  approved: 'projects.lifecycle.approved',
  active: 'projects.lifecycle.active',
  'on-hold': 'projects.lifecycle.on-hold',
  closed: 'projects.lifecycle.closed',
  archived: 'projects.lifecycle.archived',
}

/** Translation keys of log severities. */
const severityMessageKeys: Record<ProjectRaidSeverity, MessageKey> = {
  low: 'portfolioDashboard.severity.low',
  medium: 'portfolioDashboard.severity.medium',
  high: 'portfolioDashboard.severity.high',
  critical: 'portfolioDashboard.severity.critical',
}

/** Sortable columns with their header labels, in table order. */
const sortableColumns: readonly { key: PortfolioDashboardSortKey; label: MessageKey; agentRuns?: boolean }[] = [
  { key: 'project', label: 'portfolioDashboard.column.project' },
  { key: 'team', label: 'portfolioDashboard.column.team' },
  { key: 'health', label: 'portfolioDashboard.column.health' },
  { key: 'progress', label: 'portfolioDashboard.column.progress' },
  { key: 'effort', label: 'portfolioDashboard.column.effort' },
  { key: 'delay', label: 'portfolioDashboard.column.delay' },
  { key: 'budget', label: 'portfolioDashboard.column.budget' },
  { key: 'forecast', label: 'portfolioDashboard.column.forecast' },
  { key: 'risks', label: 'portfolioDashboard.column.risks' },
  { key: 'milestone', label: 'portfolioDashboard.column.milestone' },
  { key: 'utilization', label: 'portfolioDashboard.column.utilization' },
]

/** Width in CSS pixels the table needs, used to fit it on paper. */
const TABLE_MIN_WIDTH = 1_620

/** Health filter options. */
const healthFilterOptions: readonly (PlanningHealth | 'all')[] = ['all', 'off-track', 'at-risk', 'on-track', 'unknown']

/**
 * Replaces `{name}` placeholders in a message.
 *
 * @param message - Message with placeholders.
 * @param values - Values by placeholder name.
 * @returns The formatted message.
 */
function format(message: string, values: Readonly<Record<string, string | number>>) {
  return message.replace(/\{(\w+)\}/gu, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Formats a budget amount given in minor currency units.
 *
 * @param amountMinor - Amount in minor units.
 * @param currency - ISO 4217 currency code.
 * @param locale - Display locale.
 * @returns Localized currency text.
 */
function formatMoney(amountMinor: number, currency: string, locale: Locale) {
  try {
    const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency })
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0
    return formatter.format(amountMinor / 10 ** digits)
  } catch {
    return `${amountMinor} ${currency}`
  }
}

/**
 * Formats a signed change.
 *
 * @param value - Change.
 * @param unit - Unit appended to the number.
 * @returns Text such as `+3pt`.
 */
function formatDelta(value: number, unit: string) {
  return `${value > 0 ? '+' : ''}${value}${unit}`
}

/**
 * Starts a browser download of a CSV file.
 *
 * @param csv - CSV text.
 * @param fileName - Offered file name.
 */
function downloadCsv(csv: string, fileName: string) {
  // The byte order mark makes Excel read the UTF-8 file, including Japanese names, correctly.
  const objectUrl = URL.createObjectURL(new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
}

/**
 * Renders the Workspace portfolio dashboard: summary cards, filters, thresholds, the month
 * comparison, and one row per Project that opens its overview.
 *
 * @param props - Dashboard model, directory, and actions.
 * @returns The dashboard.
 */
export function PortfolioDashboardView({
  canSaveSnapshot,
  compareMonth,
  compareMonthOptions,
  isPlanningUnavailable,
  isSavingSnapshot,
  locale,
  model,
  onCompareMonthChange,
  onOpenProject,
  onRetry,
  onSaveSnapshot,
  showAgentRuns,
  snapshotMessage,
  t,
  teams,
}: PortfolioDashboardViewProps) {
  const [filters, setFilters] = useState<PortfolioDashboardFilters>({
    teamId: 'all',
    lifecycle: 'all',
    health: 'all',
    portfolioId: 'all',
    attentionOnly: false,
  })
  const [thresholds, setThresholds] = useState<PortfolioDashboardThresholds>({
    budgetPercent: DEFAULT_PORTFOLIO_BUDGET_THRESHOLD,
    delayDays: DEFAULT_PORTFOLIO_DELAY_THRESHOLD_DAYS,
  })
  const [sort, setSort] = useState<PortfolioDashboardSort>({ key: 'health', descending: false })
  const [rootElement, setRootElement] = useState<HTMLElement | null>(null)
  const visibleRows = useMemo(
    () => arrangePortfolioDashboardRows(model.rows, filters, thresholds, sort),
    [filters, model.rows, sort, thresholds],
  )
  const portfolios = useMemo(() => listPortfolioDashboardPortfolios(model.rows), [model.rows])
  const attentionCounts = useMemo(() => {
    let budget = 0
    let delay = 0
    let utilization = 0
    for (const row of model.rows) {
      const attention = evaluatePortfolioDashboardAttention(row, thresholds)
      if (attention.budget) budget += 1
      if (attention.delay) delay += 1
      if (attention.utilization) utilization += 1
    }
    return { budget, delay, utilization }
  }, [model.rows, thresholds])
  const offTrackCount = model.rows.filter((row) => row.health === 'off-track').length
  const openRisks = model.rows.reduce((sum, row) => sum + openRiskCount(row.metrics), 0)

  /**
   * Sorts by a column, flipping the direction when it is already the sort column.
   *
   * @param key - Column.
   */
  const toggleSort = (key: PortfolioDashboardSortKey) => {
    setSort((current) => current.key === key ? { key, descending: !current.descending } : { key, descending: key !== 'project' && key !== 'team' && key !== 'milestone' && key !== 'health' })
  }

  /** Downloads the visible rows as CSV. */
  const exportCsv = () => {
    const csv = createPortfolioDashboardCsv(visibleRows, (column) => t(`portfolioDashboard.csv.${column}`), (kind, value) => {
      if (kind === 'lifecycle') {
        const state = PROJECT_LIFECYCLE_STATES.find((candidate) => candidate === value)
        return state ? t(lifecycleMessageKeys[state]) : value
      }
      const health = healthFilterOptions.find((candidate): candidate is PlanningHealth => candidate !== 'all' && candidate === value)
      return health ? t(healthMessageKeys[health]) : value
    })
    downloadCsv(csv, `portfolio-${new Date().toISOString().slice(0, 10)}.csv`)
  }

  /**
   * Prints only the dashboard on landscape paper.
   *
   * @param paper - Paper size.
   */
  const print = (paper: TaskViewPrintPaper) => {
    if (!rootElement) return
    printTaskView({ contentWidth: Math.max(TABLE_MIN_WIDTH, taskViewPrintableWidth(paper)), paper, root: rootElement, target: 'portfolio-dashboard' })
  }

  const notices = [
    model.failedTeamNames.length > 0
      ? format(t('portfolioDashboard.error.teams'), { teams: model.failedTeamNames.join(', ') })
      : undefined,
    model.tooLargeTeamNames.length > 0
      ? format(t('portfolioDashboard.error.tooLarge'), { teams: model.tooLargeTeamNames.join(', ') })
      : undefined,
    model.failedSnapshotTeamNames.length > 0
      ? format(t('portfolioDashboard.error.snapshots'), { teams: model.failedSnapshotTeamNames.join(', ') })
      : undefined,
    showAgentRuns && model.agentRunsIncomplete ? t('portfolioDashboard.error.agentRuns') : undefined,
    model.utilizationUnavailable ? t('portfolioDashboard.error.utilization') : undefined,
    isPlanningUnavailable ? t('workspace.planningUpdate.error.loading') : undefined,
  ].filter((notice) => notice !== undefined)
  const hiddenNotices = [
    model.hiddenProjectCount > 0 ? format(t('portfolioDashboard.hidden.projects'), { count: model.hiddenProjectCount }) : undefined,
    model.costHiddenProjectCount > 0 ? format(t('portfolioDashboard.hidden.costs'), { count: model.costHiddenProjectCount }) : undefined,
    compareMonth && model.snapshotHiddenProjectCount > 0
      ? format(t('portfolioDashboard.hidden.snapshot'), { count: model.snapshotHiddenProjectCount })
      : undefined,
  ].filter((notice) => notice !== undefined)

  return (
    <div className="grid gap-6" data-print-root="portfolio-dashboard" ref={setRootElement}>
      <div className="grid grid-cols-2 gap-3 min-[901px]:grid-cols-6">
        <MetricCard label={t('portfolioDashboard.metric.projects')} tone="teal" value={model.rows.length} />
        <MetricCard label={t('portfolioDashboard.metric.offTrack')} tone={offTrackCount > 0 ? 'red' : 'emerald'} value={isPlanningUnavailable ? '—' : offTrackCount} />
        <MetricCard label={t('portfolioDashboard.metric.overBudget')} testId="portfolio-over-budget" tone={attentionCounts.budget > 0 ? 'red' : 'emerald'} value={attentionCounts.budget} />
        <MetricCard label={t('portfolioDashboard.metric.delayed')} testId="portfolio-delayed" tone={attentionCounts.delay > 0 ? 'amber' : 'emerald'} value={attentionCounts.delay} />
        <MetricCard label={t('portfolioDashboard.metric.overloaded')} testId="portfolio-overloaded" tone={attentionCounts.utilization > 0 ? 'amber' : 'emerald'} value={model.utilizationUnavailable ? '—' : attentionCounts.utilization} />
        <MetricCard label={t('portfolioDashboard.metric.openRisks')} tone={openRisks > 0 ? 'amber' : 'emerald'} value={openRisks} />
      </div>

      {notices.length > 0 ? (
        <div className="grid gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-fg-amber-800" role="status">
          {notices.map((notice) => <p key={notice}>{notice}</p>)}
          <div>
            <button className="workbench-button-secondary min-h-8 px-3 text-sm font-semibold" data-testid="portfolio-retry" type="button" onClick={onRetry}>
              {t('portfolioDashboard.retry')}
            </button>
          </div>
        </div>
      ) : null}
      {hiddenNotices.length > 0 ? (
        <div className="grid gap-1 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-medium text-fg-slate-700" data-testid="portfolio-hidden-notice">
          {hiddenNotices.map((notice) => <p key={notice}>{notice}</p>)}
        </div>
      ) : null}

      <section className="workbench-table overflow-hidden">
        <SectionHeader
          meta={format(t('portfolioDashboard.table.meta'), { shown: visibleRows.length, total: model.rows.length })}
          title={t('portfolioDashboard.table.title')}
        />
        <div className="flex flex-wrap items-end gap-3 px-5 pb-4 print:hidden">
          <FilterSelect
            label={t('portfolioDashboard.filter.team')}
            options={[
              { value: 'all', label: t('portfolioDashboard.filter.all') },
              ...teams.map((team) => ({ value: team.id, label: team.name })),
            ]}
            testId="portfolio-filter-team"
            value={filters.teamId}
            onChange={(teamId) => setFilters((current) => ({ ...current, teamId }))}
          />
          <FilterSelect
            label={t('portfolioDashboard.filter.lifecycle')}
            options={[
              { value: 'all', label: t('portfolioDashboard.filter.all') },
              ...PROJECT_LIFECYCLE_STATES.map((state) => ({ value: state, label: t(lifecycleMessageKeys[state]) })),
            ]}
            testId="portfolio-filter-lifecycle"
            value={filters.lifecycle}
            onChange={(value) => {
              const lifecycle = PROJECT_LIFECYCLE_STATES.find((state) => state === value) ?? 'all'
              setFilters((current) => ({ ...current, lifecycle }))
            }}
          />
          <FilterSelect
            disabled={isPlanningUnavailable}
            label={t('portfolioDashboard.filter.health')}
            options={healthFilterOptions.map((value) => ({
              value,
              label: value === 'all' ? t('portfolioDashboard.filter.all') : t(healthMessageKeys[value]),
            }))}
            testId="portfolio-filter-health"
            value={filters.health}
            onChange={(value) => {
              const health = healthFilterOptions.find((candidate) => candidate === value) ?? 'all'
              setFilters((current) => ({ ...current, health }))
            }}
          />
          <FilterSelect
            label={t('portfolioDashboard.filter.portfolio')}
            options={[
              { value: 'all', label: t('portfolioDashboard.filter.all') },
              ...portfolios.map((portfolio) => ({ value: portfolio.id, label: portfolio.title })),
              { value: 'none', label: t('portfolioDashboard.filter.noPortfolio') },
            ]}
            testId="portfolio-filter-portfolio"
            value={filters.portfolioId}
            onChange={(portfolioId) => setFilters((current) => ({ ...current, portfolioId }))}
          />
          <NumberField
            label={t('portfolioDashboard.threshold.budget')}
            testId="portfolio-threshold-budget"
            value={thresholds.budgetPercent}
            onChange={(budgetPercent) => setThresholds((current) => ({ ...current, budgetPercent }))}
          />
          <NumberField
            label={t('portfolioDashboard.threshold.delay')}
            testId="portfolio-threshold-delay"
            value={thresholds.delayDays}
            onChange={(delayDays) => setThresholds((current) => ({ ...current, delayDays }))}
          />
          <label className="flex min-h-10 items-center gap-2 text-sm font-semibold text-[var(--workbench-text)]">
            <input
              checked={filters.attentionOnly}
              data-testid="portfolio-filter-attention"
              type="checkbox"
              onChange={(event) => {
                const attentionOnly = event.target.checked
                setFilters((current) => ({ ...current, attentionOnly }))
              }}
            />
            {t('portfolioDashboard.filter.attentionOnly')}
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-[var(--workbench-border)] px-5 py-4 print:hidden">
          <FilterSelect
            label={t('portfolioDashboard.compare.label')}
            options={[
              { value: '', label: t('portfolioDashboard.compare.none') },
              ...compareMonthOptions.map((month) => ({ value: month, label: month })),
            ]}
            testId="portfolio-compare-month"
            value={compareMonth ?? ''}
            onChange={(month) => onCompareMonthChange(month === '' ? undefined : month)}
          />
          {canSaveSnapshot ? (
            <div className="grid gap-1">
              <button
                className="workbench-button-primary min-h-10 px-4 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                data-testid="portfolio-save-snapshot"
                disabled={isSavingSnapshot}
                type="button"
                onClick={onSaveSnapshot}
              >
                {isSavingSnapshot ? t('portfolioDashboard.snapshot.saving') : t('portfolioDashboard.snapshot.save')}
              </button>
              <p className="max-w-[360px] text-xs text-[var(--workbench-muted)]">{t('portfolioDashboard.snapshot.hint')}</p>
            </div>
          ) : null}
          <div className="ml-auto flex flex-wrap gap-2">
            <button className="workbench-button-secondary min-h-10 px-4 text-sm font-semibold" data-testid="portfolio-export-csv" type="button" onClick={exportCsv}>
              {t('portfolioDashboard.export.csv')}
            </button>
            <button className="workbench-button-secondary min-h-10 px-4 text-sm font-semibold" type="button" onClick={() => print('a4')}>
              {t('portfolioDashboard.export.printA4')}
            </button>
            <button className="workbench-button-secondary min-h-10 px-4 text-sm font-semibold" type="button" onClick={() => print('a3')}>
              {t('portfolioDashboard.export.printA3')}
            </button>
          </div>
          {snapshotMessage ? (
            <p className="w-full text-sm font-semibold text-[var(--workbench-text)]" data-testid="portfolio-snapshot-message" role="status">
              {snapshotMessage}
            </p>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left" style={{ minWidth: TABLE_MIN_WIDTH }}>
            <thead>
              <tr className="workbench-table-head text-left">
                {sortableColumns.map((column) => (
                  <th
                    aria-sort={sort.key === column.key ? (sort.descending ? 'descending' : 'ascending') : 'none'}
                    className="px-4 py-3"
                    key={column.key}
                    scope="col"
                  >
                    <button
                      aria-label={format(t('portfolioDashboard.sort.toggle'), { column: t(column.label) })}
                      className="inline-flex items-center gap-1 rounded font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--workbench-focus)]"
                      type="button"
                      onClick={() => toggleSort(column.key)}
                    >
                      {t(column.label)}
                      <span aria-hidden="true">{sort.key === column.key ? (sort.descending ? '↓' : '↑') : ''}</span>
                    </button>
                  </th>
                ))}
                {showAgentRuns ? <th className="px-4 py-3" scope="col">{t('portfolioDashboard.column.agentRuns')}</th> : null}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <PortfolioRow
                  key={row.key}
                  locale={locale}
                  row={row}
                  showAgentRuns={showAgentRuns}
                  t={t}
                  thresholds={thresholds}
                  onOpenProject={onOpenProject}
                />
              ))}
              {visibleRows.length === 0 ? (
                <tr>
                  <td className="px-5 py-8 text-sm font-medium text-[var(--workbench-muted)]" colSpan={sortableColumns.length + 1} data-testid="portfolio-empty">
                    {t('portfolioDashboard.table.empty')}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

/** Props of one table row. */
type PortfolioRowProps = {
  /** Row. */
  row: PortfolioDashboardRow
  /** Thresholds that highlight cells. */
  thresholds: PortfolioDashboardThresholds
  /** Whether the Agent Run cell is shown. */
  showAgentRuns: boolean
  /** Display locale. */
  locale: Locale
  /** Translator. */
  t: (key: MessageKey) => string
  /** Opens the Project overview. */
  onOpenProject: (teamId: string, projectId: string) => void
}

/**
 * Renders one Project row; every cell opens the Project overview.
 *
 * @param props - Row and display settings.
 * @returns The row.
 */
function PortfolioRow({ locale, onOpenProject, row, showAgentRuns, t, thresholds }: PortfolioRowProps) {
  const { metrics, delta } = row
  const attention = evaluatePortfolioDashboardAttention(row, thresholds)
  const open = () => onOpenProject(row.teamId, row.projectId)
  const cellClassName = 'cursor-pointer px-4 py-3 align-top'
  const deltaText = (value: number | undefined, unit: string) =>
    value === undefined || value === 0 ? null : (
      <p className="text-xs text-[var(--workbench-muted)]">{format(t('portfolioDashboard.cell.delta'), { value: formatDelta(value, unit) })}</p>
    )
  return (
    <tr
      className="border-b border-slate-100 text-sm font-medium text-[var(--workbench-text)] hover:bg-[var(--workbench-surface-muted)]"
      data-testid={`portfolio-row-${row.teamId}-${row.projectId}`}
      onClick={open}
    >
      <td className={cellClassName}>
        <button
          className="min-h-8 rounded-md text-left font-semibold underline-offset-4 hover:underline focus:outline-none focus:ring-2 focus:ring-[var(--workbench-focus)]"
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            open()
          }}
        >
          {row.projectName}
        </button>
        <p className="text-xs text-[var(--workbench-muted)]">
          {t(lifecycleMessageKeys[row.lifecycleState])}
          {row.ownerName ? ` · ${row.ownerName}` : ''}
        </p>
      </td>
      <td className={`${cellClassName} text-[var(--workbench-muted)]`}>{row.teamName}</td>
      <td className={cellClassName}>
        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${healthClassNames[row.health]}`}>
          {t(healthMessageKeys[row.health])}
        </span>
      </td>
      <td className={`${cellClassName} min-w-[140px]`}>
        <ProgressBar label={`${row.projectName} ${t('portfolioDashboard.column.progress')}`} value={row.countProgress ?? 0} />
        <p className="mt-1 text-xs tabular-nums">
          {row.countProgress === undefined ? '—' : `${row.countProgress}%`} ·{' '}
          {format(t('portfolioDashboard.cell.workItems'), { completed: metrics.workItems.completed, total: metrics.workItems.total })}
        </p>
        {metrics.workItems.overdueOpen > 0 ? (
          <p className="text-xs font-semibold text-fg-red-700">{format(t('portfolioDashboard.cell.overdue'), { count: metrics.workItems.overdueOpen })}</p>
        ) : null}
        {deltaText(delta?.progress, 'pt')}
      </td>
      <td className={`${cellClassName} tabular-nums`}>{row.effortProgress === undefined ? '—' : `${row.effortProgress}%`}</td>
      <td className={`${cellClassName} ${attention.delay ? 'bg-amber-50' : ''}`} data-attention={attention.delay ? 'delay' : undefined}>
        {!metrics.schedule.hasBaseline ? (
          <span className="text-[var(--workbench-muted)]">{t('portfolioDashboard.cell.noBaseline')}</span>
        ) : metrics.schedule.maxDelayDays === undefined ? (
          <span className="text-fg-emerald-700">{t('portfolioDashboard.cell.onSchedule')}</span>
        ) : (
          <span className={attention.delay ? 'font-semibold text-fg-red-700' : ''}>
            {format(t('portfolioDashboard.cell.delay'), { days: metrics.schedule.maxDelayDays, count: metrics.schedule.delayedOpenCount })}
          </span>
        )}
        {deltaText(delta?.delay, t('portfolioDashboard.cell.delayUnit'))}
      </td>
      <BudgetCells attention={attention.budget} budget={metrics.budget} className={cellClassName} costHidden={metrics.costHidden} delta={delta?.budget} forecast={row.budgetForecast} locale={locale} row={row} t={t} />
      <td className={cellClassName}>
        <p className="tabular-nums">
          {format(t('portfolioDashboard.cell.risks'), { risks: metrics.raid.openRisks, issues: metrics.raid.openIssues })}
        </p>
        {metrics.raid.highestOpenSeverity ? (
          <span className={`mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${metrics.raid.highestOpenSeverity === 'critical' || metrics.raid.highestOpenSeverity === 'high' ? 'border-red-200 bg-red-50 text-fg-red-700' : 'border-slate-200 bg-slate-50 text-fg-slate-600'}`}>
            {t(severityMessageKeys[metrics.raid.highestOpenSeverity])}
          </span>
        ) : null}
        {deltaText(delta?.risks, '')}
      </td>
      <td className={`${cellClassName} max-w-[220px]`}>
        {metrics.nextMilestone ? (
          <>
            <p className="tabular-nums">{metrics.nextMilestone.dueDate}</p>
            <p className="truncate text-xs text-[var(--workbench-muted)]">{metrics.nextMilestone.title}</p>
          </>
        ) : <span className="text-[var(--workbench-muted)]">{t('portfolioDashboard.cell.noMilestone')}</span>}
      </td>
      <td
        className={`${cellClassName} tabular-nums ${attention.utilization ? 'bg-amber-50' : ''}`}
        data-attention={attention.utilization ? 'utilization' : undefined}
      >
        {row.utilization === undefined ? '—' : row.utilization.memberCount === 0 ? (
          <span className="text-[var(--workbench-muted)]">{t('portfolioDashboard.cell.noUtilization')}</span>
        ) : (
          <>
            <p className={attention.utilization ? 'font-semibold text-fg-amber-800' : ''}>
              {row.utilization.percent === undefined ? '—' : `${row.utilization.percent}%`}
            </p>
            <p className="text-xs text-[var(--workbench-muted)]">
              {format(t('portfolioDashboard.cell.utilization'), {
                members: row.utilization.memberCount,
                overloaded: row.utilization.overloadedMemberCount,
              })}
            </p>
          </>
        )}
      </td>
      {showAgentRuns ? (
        <td className={`${cellClassName} tabular-nums`}>
          {row.agentRuns ? (
            <>
              <p className={row.agentRuns.failed + row.agentRuns.stalled > 0 ? 'font-semibold text-fg-red-700' : ''}>
                {format(t('portfolioDashboard.cell.agentRuns'), { failed: row.agentRuns.failed, stalled: row.agentRuns.stalled })}
              </p>
              {row.agentRuns.isIncomplete ? <p className="text-xs text-[var(--workbench-muted)]">{t('portfolioDashboard.cell.agentRunsIncomplete')}</p> : null}
            </>
          ) : '—'}
        </td>
      ) : null}
    </tr>
  )
}

/** Props of the budget cells. */
type BudgetCellsProps = {
  /** Row the cells belong to. */
  row: PortfolioDashboardRow
  /** Budget, when visible and set. */
  budget?: PortfolioProjectBudget
  /** Whether the reader may not see costs. */
  costHidden: boolean
  /** Forecast at the end of the period, in percent. */
  forecast?: number
  /** Change of the consumption since the compared month. */
  delta?: number
  /** Whether a threshold is breached. */
  attention: boolean
  /** Shared cell class name. */
  className: string
  /** Display locale. */
  locale: Locale
  /** Translator. */
  t: (key: MessageKey) => string
}

/**
 * Renders the budget consumption and forecast cells.
 *
 * @param props - Budget and display settings.
 * @returns Two table cells.
 */
function BudgetCells({ attention, budget, className, costHidden, delta, forecast, locale, row, t }: BudgetCellsProps) {
  const attentionClassName = attention ? 'bg-red-50' : ''
  if (costHidden || !budget) {
    const text = costHidden ? t('portfolioDashboard.cell.costHidden') : t('portfolioDashboard.cell.noBudget')
    return (
      <>
        <td className={`${className} text-[var(--workbench-muted)]`}>{text}</td>
        <td className={`${className} text-[var(--workbench-muted)]`}>—</td>
      </>
    )
  }
  return (
    <>
      <td className={`${className} ${attentionClassName}`} data-attention={attention ? 'budget' : undefined}>
        <p className={`tabular-nums ${attention ? 'font-semibold text-fg-red-700' : ''}`}>
          {row.budgetConsumption === undefined ? '—' : `${row.budgetConsumption}%`}
        </p>
        <p className="text-xs tabular-nums text-[var(--workbench-muted)]">
          {formatMoney(budget.actualCostMinor, budget.currency, locale)} / {formatMoney(budget.amountMinor, budget.currency, locale)}
        </p>
        {budget.hasOtherCurrencyCost ? <p className="text-xs text-[var(--workbench-muted)]">{t('portfolioDashboard.cell.otherCurrency')}</p> : null}
        {delta === undefined || delta === 0 ? null : (
          <p className="text-xs text-[var(--workbench-muted)]">{format(t('portfolioDashboard.cell.delta'), { value: formatDelta(delta, 'pt') })}</p>
        )}
      </td>
      <td className={`${className} tabular-nums ${attentionClassName}`}>
        {forecast === undefined ? '—' : `${forecast}%`}
      </td>
    </>
  )
}

/** Props of a labelled select. */
type FilterSelectProps = {
  /** Label. */
  label: string
  /** Options. */
  options: readonly { value: string; label: string }[]
  /** Selected value. */
  value: string
  /** Test ID. */
  testId: string
  /** Whether the select is disabled. */
  disabled?: boolean
  /** Receives the selected value. */
  onChange: (value: string) => void
}

/**
 * Renders a labelled select.
 *
 * @param props - Label, options, and value.
 * @returns The select.
 */
function FilterSelect({ disabled = false, label, onChange, options, testId, value }: FilterSelectProps) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <select
        className="workbench-input min-h-10 min-w-[160px] px-3 text-sm disabled:cursor-not-allowed disabled:bg-[var(--workbench-surface-muted)]"
        data-testid={testId}
        disabled={disabled}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  )
}

/** Props of a labelled whole-number field. */
type NumberFieldProps = {
  /** Label. */
  label: string
  /** Current value. */
  value: number
  /** Test ID. */
  testId: string
  /** Receives a valid non-negative whole number. */
  onChange: (value: number) => void
}

/**
 * Renders a labelled field for a non-negative whole number; other input is ignored.
 *
 * @param props - Label and value.
 * @returns The field.
 */
function NumberField({ label, onChange, testId, value }: NumberFieldProps) {
  return (
    <label className="grid gap-1 text-xs font-semibold text-[var(--workbench-muted)]">
      {label}
      <input
        className="workbench-input min-h-10 w-[120px] px-3 text-sm tabular-nums"
        data-testid={testId}
        inputMode="numeric"
        min={0}
        type="number"
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value)
          if (Number.isSafeInteger(next) && next >= 0) onChange(next)
        }}
      />
    </label>
  )
}
