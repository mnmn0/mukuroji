import {
  NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY,
  UNCATEGORIZED_TIME_ENTRY_GROUP_KEY,
  type TimeSummaryGroup,
  type TimeTrackingGroupBy,
  type TimeTrackingSummary,
  type WorkspaceInvestmentCategorySettings,
} from '@mukuroji/contracts'
import { useId, useState } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { formatCostsByCurrency, isTimeReportRangeOrdered, timeReportGroupings, type TimeReportRange } from '../model/timeReport'
import { formatMinutes } from '../model/timePeriod'
import {
  describeTimeEntryCategory,
  describeTimeTrackingFailure,
  interpolate,
  type TimeTrackingFormatters,
  type TimeTrackingTranslator,
} from './timeTrackingText'
import { readWorkPhaseDisplayName } from '../../../workspace/model/workPhases'
import {
  investmentGroupLabelKeys,
  measureInvestmentTime,
  readInvestmentCategoryDisplayName,
  summarizeInvestmentGroups,
} from '../../../workspace/model/investmentCategories'
import { useTimeEntryCategories } from './timeEntryCategoryContext'

/** Display names used to label report rows keyed by an identifier. */
export type TimeReportLabels = {
  /** Member display names keyed by member key. */
  members: Readonly<Record<string, string>>
  /** Project names keyed by Project ID. */
  projects: Readonly<Record<string, string>>
  /** Work Item titles keyed by Work Item ID. */
  workItems: Readonly<Record<string, string>>
}

/** Props of the grouped time report. */
export type TimeReportProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Display locale, used for money. */
  locale: Locale
  /** Date formatters. */
  formatters: TimeTrackingFormatters
  /** Inclusive local period shown. */
  range: TimeReportRange
  /** Grouping shown. */
  groupBy: TimeTrackingGroupBy
  /** Report, when loaded. */
  summary?: TimeTrackingSummary
  /** Whether the report is loading. */
  isLoading?: boolean
  /** Whether the read failed. */
  hasLoadError?: boolean
  /** Names that label member, Project, and Work Item rows. */
  labels: TimeReportLabels
  /** Changes the period. */
  onChangeRange: (range: TimeReportRange) => void
  /** Changes the grouping. */
  onChangeGroupBy: (groupBy: TimeTrackingGroupBy) => void
  /** Reloads the report. */
  onRetry: () => void
  /** Downloads the CSV export of the period and grouping shown. */
  onDownloadCsv: () => Promise<void>
  /**
   * Workspace investment categories (ADR 0116); with them an investment report shows person-months,
   * shares, and Capex and Opex totals.
   */
  investmentCategories?: WorkspaceInvestmentCategorySettings
  /** Whether reading the Workspace investment categories failed; an investment report then says why its columns are missing. */
  hasInvestmentCategoriesError?: boolean
  /** Reads the Workspace investment categories again. */
  onRetryInvestmentCategories?: () => void
  /** Project the report is narrowed to, with the Projects offered; absent hides the filter. */
  projectFilter?: TimeReportProjectFilter
}

/** Project filter of the report. */
export type TimeReportProjectFilter = {
  /** Selected Project ID, or undefined for every Project. */
  projectId?: string
  /** Projects offered, in display order. */
  options: readonly { id: string; name: string }[]
  /** Selects another Project, or every Project with undefined. */
  onChange: (projectId: string | undefined) => void
}

/** Calendar group keys are local dates; anything else is shown by its server label. */
const localDatePattern = /^\d{4}-\d{2}-\d{2}$/u

/** Message key of each grouping. */
const groupByKeys = {
  day: 'timeTracking.report.groupBy.day',
  week: 'timeTracking.report.groupBy.week',
  user: 'timeTracking.report.groupBy.user',
  project: 'timeTracking.report.groupBy.project',
  'work-item': 'timeTracking.report.groupBy.workItem',
  category: 'timeTracking.report.groupBy.category',
  phase: 'timeTracking.report.groupBy.phase',
  investment: 'timeTracking.report.groupBy.investment',
} as const satisfies Record<TimeTrackingGroupBy, string>

/**
 * Team report: totals grouped by day, week, member, Project, or Work Item for a period, with a CSV
 * export of the same report. Cost columns appear only when the server returned costs.
 *
 * @param props - Period, grouping, report, and actions.
 * @returns Report section.
 */
export function TimeReport({
  formatters,
  groupBy,
  hasLoadError = false,
  isLoading = false,
  labels,
  locale,
  onChangeGroupBy,
  onChangeRange,
  onDownloadCsv,
  onRetry,
  range,
  summary,
  t,
  investmentCategories,
  hasInvestmentCategoriesError = false,
  onRetryInvestmentCategories,
  projectFilter,
}: TimeReportProps) {
  const id = useId()
  const [isDownloading, setIsDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState<string>()
  const categories = useTimeEntryCategories()
  const ordered = isTimeReportRangeOrdered(range)
  const showCosts = summary !== undefined && !summary.costsRedacted
  const showsInvestment = groupBy === 'investment' && investmentCategories !== undefined
  // Members get only their own time, except Work Item totals that every viewer of the Work Item reads.
  const showsOwnTimeOnly = summary !== undefined && !summary.canManageTeam && summary.groupBy !== 'work-item'

  /**
   * Labels one report row.
   *
   * @param group - Report row.
   * @returns Display label.
   */
  const labelOf = (group: TimeSummaryGroup): string => {
    switch (groupBy) {
      case 'day':
        return localDatePattern.test(group.key) ? formatters.day(group.key) : group.label
      case 'week':
        return localDatePattern.test(group.key)
          ? interpolate(t('timeTracking.report.weekOf'), { date: formatters.day(group.key) })
          : group.label
      case 'user':
        return labels.members[group.key] ?? group.label
      case 'project':
        return group.key === 'unassigned' ? t('timeTracking.report.noProject') : labels.projects[group.key] ?? group.label
      case 'work-item':
        if (group.key === NO_WORK_ITEM_TIME_ENTRY_GROUP_KEY) return t('timeTracking.report.noWorkItem')
        return labels.workItems[group.key] ?? group.label
      case 'category': {
        if (group.key === UNCATEGORIZED_TIME_ENTRY_GROUP_KEY) return t('timeTracking.report.category.uncategorized')
        // The Workspace settings say whether a category was named; a built-in one without a name
        // is translated, even when its key happens to equal a name. A key the loaded settings do
        // not know keeps the name the server gave it.
        const name = describeTimeEntryCategory(t, group.key, categories)
        return name === group.key ? group.label : name
      }
      case 'phase':
        // The server labels a phase the Workspace did not name with its key.
        return group.label === group.key ? readWorkPhaseDisplayName(group.key, undefined, t) : group.label
      case 'investment':
        return group.label === group.key || group.key === 'unclassified'
          ? readInvestmentCategoryDisplayName(group.key, investmentCategories, t)
          : group.label
    }
  }

  /** Downloads the CSV, reporting a failure next to the button. */
  const download = async () => {
    if (isDownloading) return
    setIsDownloading(true)
    setDownloadError(undefined)
    try {
      await onDownloadCsv()
    } catch (error) {
      setDownloadError(describeTimeTrackingFailure(t, error))
    } finally {
      setIsDownloading(false)
    }
  }

  return (
    <section aria-labelledby={`${id}-title`} className="grid min-w-0 gap-4" data-testid="time-report">
      <h2 className="text-base font-semibold text-[var(--workbench-text)]" id={`${id}-title`}>{t('timeTracking.report.title')}</h2>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
          {t('timeTracking.report.from')}
          <input
            className="workbench-input min-h-9 px-2"
            onChange={(event) => { if (event.target.value) onChangeRange({ ...range, from: event.target.value }) }}
            type="date"
            value={range.from}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
          {t('timeTracking.report.to')}
          <input
            className="workbench-input min-h-9 px-2"
            onChange={(event) => { if (event.target.value) onChangeRange({ ...range, to: event.target.value }) }}
            type="date"
            value={range.to}
          />
        </label>
        <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
          {t('timeTracking.report.groupBy')}
          <select
            className="workbench-input min-h-9 px-2"
            onChange={(event) => onChangeGroupBy(timeReportGroupings.find((grouping) => grouping === event.target.value) ?? 'day')}
            value={groupBy}
          >
            {timeReportGroupings.map((grouping) => <option key={grouping} value={grouping}>{t(groupByKeys[grouping])}</option>)}
          </select>
        </label>
        {projectFilter ? (
          <label className="grid min-w-0 gap-1 text-sm font-semibold text-[var(--workbench-text)]">
            {t('timeTracking.report.projectFilter')}
            <select
              className="workbench-input min-h-9 px-2"
              onChange={(event) => projectFilter.onChange(event.target.value === '' ? undefined : event.target.value)}
              value={projectFilter.projectId ?? ''}
            >
              <option value="">{t('timeTracking.report.projectFilterAll')}</option>
              {projectFilter.options.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
        ) : null}
        <button
          className="workbench-button-secondary min-h-9 px-3"
          disabled={!ordered || isDownloading}
          onClick={() => { void download() }}
          type="button"
        >
          {isDownloading ? t('timeTracking.report.downloading') : t('timeTracking.report.downloadCsv')}
        </button>
      </div>
      {downloadError ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{downloadError}</p> : null}
      {!ordered ? <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('timeTracking.report.invalidRange')}</p> : null}

      {hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{t('timeTracking.report.loadError')}</span>
          <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetry} type="button">{t('timeTracking.retry')}</button>
        </div>
      ) : null}
      {groupBy === 'investment' && hasInvestmentCategoriesError ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" data-testid="time-report-investment-error" role="alert">
          <span>{t('timeTracking.report.investmentCategoriesLoadError')}</span>
          {onRetryInvestmentCategories ? (
            <button className="workbench-button-secondary min-h-8 px-3" onClick={onRetryInvestmentCategories} type="button">{t('timeTracking.retry')}</button>
          ) : null}
        </div>
      ) : null}
      {isLoading ? <p className="text-sm font-medium text-[var(--workbench-muted)]" role="status">{t('timeTracking.loading')}</p> : null}
      {showsOwnTimeOnly && ordered ? (
        <p className="text-sm font-medium text-[var(--workbench-muted)]" data-testid="time-report-own-only">{t('timeTracking.report.ownTimeOnly')}</p>
      ) : null}

      {summary && ordered ? (
        summary.groups.length === 0 ? (
          <p className="text-sm font-medium text-[var(--workbench-muted)]">{t('timeTracking.report.empty')}</p>
        ) : (
          <div className="min-w-0 overflow-x-auto rounded-lg border border-[var(--workbench-border)]">
            <table className="w-full min-w-[560px] border-collapse text-sm" data-testid="time-report-table">
              <caption className="sr-only">{t('timeTracking.report.title')}</caption>
              <thead>
                <tr className="bg-[var(--workbench-surface-muted)] text-xs font-semibold text-[var(--workbench-muted)]">
                  <th className="px-3 py-2 text-left" scope="col">{t(groupByKeys[groupBy])}</th>
                  <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.minutes')}</th>
                  {showsInvestment ? (
                    <>
                      <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.personMonths')}</th>
                      <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.share')}</th>
                    </>
                  ) : null}
                  <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.billable')}</th>
                  <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.estimate')}</th>
                  <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.entries')}</th>
                  {showCosts ? <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.cost')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {summary.groups.map((group) => (
                  <tr className="border-t border-[var(--workbench-border)]" key={group.key}>
                    <th className="px-3 py-2 text-left font-medium text-[var(--workbench-text)]" scope="row">{labelOf(group)}</th>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{formatMinutes(group.minutes)}</td>
                    {showsInvestment ? <InvestmentCells minutes={group.minutes} settings={investmentCategories} totalMinutes={summary.totalMinutes} /> : null}
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{formatMinutes(group.billableMinutes)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-muted)]">{group.estimateMinutes === undefined ? '—' : formatMinutes(group.estimateMinutes)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-muted)]">{group.entryCount}</td>
                    {showCosts ? <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{formatCostsByCurrency(group.actualCostByCurrency, locale) || '—'}</td> : null}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-[var(--workbench-border)] font-semibold">
                  <th className="px-3 py-2 text-left text-[var(--workbench-text)]" scope="row">{t('timeTracking.report.total')}</th>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{formatMinutes(summary.totalMinutes)}</td>
                  {showsInvestment ? <InvestmentCells minutes={summary.totalMinutes} settings={investmentCategories} totalMinutes={summary.totalMinutes} /> : null}
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{formatMinutes(summary.totalBillableMinutes)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-muted)]">{formatMinutes(summary.totalEstimateMinutes)}</td>
                  {/* An entry that crosses midnight counts in two day rows, so the rows do not add up to an entry total. */}
                  <td className="px-3 py-2" />
                  {showCosts ? <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{formatCostsByCurrency(summary.totalActualCostByCurrency, locale) || '—'}</td> : null}
                </tr>
              </tfoot>
            </table>
          </div>
        )
      ) : null}
      {summary && ordered && showsInvestment && summary.groups.length > 0 ? (
        <InvestmentGroupTable locale={locale} settings={investmentCategories} showCosts={showCosts} summary={summary} t={t} />
      ) : null}
    </section>
  )
}

/** Props of the person-month and share cells. */
type InvestmentCellsProps = {
  /** Minutes of the row. */
  minutes: number
  /** Workspace investment categories with the person-month hours. */
  settings: WorkspaceInvestmentCategorySettings
  /** Report total, the base of the share. */
  totalMinutes: number
}

/**
 * Shows a row's person-months and share of the report.
 *
 * @param props - Minutes, settings, and report total.
 * @returns Two table cells.
 */
function InvestmentCells({ minutes, settings, totalMinutes }: InvestmentCellsProps) {
  const { personMonths, sharePercent } = measureInvestmentTime(minutes, settings, totalMinutes)
  return (
    <>
      <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{personMonths.toFixed(2)}</td>
      <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-muted)]">{`${sharePercent.toFixed(1)}%`}</td>
    </>
  )
}

/** Props of the Capex and Opex table. */
type InvestmentGroupTableProps = {
  /** Investment report. */
  summary: TimeTrackingSummary
  /** Workspace investment categories. */
  settings: WorkspaceInvestmentCategorySettings
  /** Whether the viewer sees amounts. */
  showCosts: boolean
  /** Display locale, used for money. */
  locale: Locale
  /** Translator. */
  t: TimeTrackingTranslator
}

/**
 * Totals an investment report by Capex and Opex: minutes, person-months, share, and, for those who
 * see costs, amounts.
 *
 * @param props - Report, settings, cost visibility, locale, and translator.
 * @returns The group table.
 */
function InvestmentGroupTable({ summary, settings, showCosts, locale, t }: InvestmentGroupTableProps) {
  const rows = summarizeInvestmentGroups(summary.groups, settings, summary.totalMinutes)
  /**
   * Adds up the amounts of the categories in one group, per currency.
   *
   * @param group - Accounting group.
   * @returns Amounts keyed by currency.
   */
  const costsOf = (group: string): Record<string, number> => {
    const totals: Record<string, number> = {}
    for (const row of summary.groups) {
      if (settings.categories.find((category) => category.key === row.key)?.group !== group) continue
      for (const [currency, amount] of Object.entries(row.actualCostByCurrency ?? {})) {
        totals[currency] = (totals[currency] ?? 0) + amount
      }
    }
    return totals
  }
  return (
    <div className="min-w-0 overflow-x-auto rounded-lg border border-[var(--workbench-border)]">
      <table className="w-full min-w-[480px] border-collapse text-sm" data-testid="time-report-investment-groups">
        <caption className="sr-only">{t('timeTracking.report.investmentGroups')}</caption>
        <thead>
          <tr className="bg-[var(--workbench-surface-muted)] text-xs font-semibold text-[var(--workbench-muted)]">
            <th className="px-3 py-2 text-left" scope="col">{t('timeTracking.report.investmentGroups')}</th>
            <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.minutes')}</th>
            <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.personMonths')}</th>
            <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.share')}</th>
            {showCosts ? <th className="px-3 py-2 text-right" scope="col">{t('timeTracking.report.column.cost')}</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-t border-[var(--workbench-border)]" key={row.key}>
              <th className="px-3 py-2 text-left font-medium text-[var(--workbench-text)]" scope="row">
                {row.key === 'capex' || row.key === 'opex' ? t(investmentGroupLabelKeys[row.key]) : row.key}
              </th>
              <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{formatMinutes(row.minutes)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{row.personMonths.toFixed(2)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-muted)]">{`${row.sharePercent.toFixed(1)}%`}</td>
              {showCosts ? (
                <td className="px-3 py-2 text-right tabular-nums text-[var(--workbench-text)]">{formatCostsByCurrency(costsOf(row.key), locale) || '—'}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
