import type { ProjectBudgetReport, ProjectBudgetReportPoint } from '@mukuroji/contracts'
import { useId, type ReactNode } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'
import { formatPerformanceIndex, isProjectBudgetReportRangeValid, listIsolatedPoints } from '../model/projectBudgetReport'
import { formatMinutes } from '../model/timePeriod'
import { formatCostsByCurrency, formatMinorAmount, type TimeReportRange } from '../model/timeReport'
import { interpolate, type TimeTrackingTranslator } from './timeTrackingText'

/** Props of {@link ProjectBudgetReportPanel}. */
export type ProjectBudgetReportPanelProps = {
  /** Translator. */
  t: TimeTrackingTranslator
  /** Display locale, used for money. */
  locale: Locale
  /** Range being shown. */
  range: TimeReportRange
  /** Report of the range, once loaded. */
  report?: ProjectBudgetReport
  /** Whether the report is loading. */
  isLoading?: boolean
  /** Whether the read failed. */
  hasLoadError?: boolean
  /** Whether the CSV is being downloaded. */
  isExporting?: boolean
  /** Whether the last CSV download failed. */
  hasExportError?: boolean
  /** Path of the screen where the budget is edited. */
  budgetEditPath: string
  /** Renders a link to an in-app path. */
  renderLink: (path: string, children: ReactNode) => ReactNode
  /** Changes the range. */
  onChangeRange: (range: TimeReportRange) => void
  /** Downloads the CSV of the range. */
  onExport: () => void
  /** Reloads the report. */
  onRetry: () => void
}

/**
 * Budget against actual figures and earned value (PV, EV, AC, SPI, CPI, EAC) of one Project, with
 * the cumulative planned value and actual series of the range. Shown only to Project managers.
 *
 * @param props - Range, report, and actions.
 * @returns The panel.
 */
export function ProjectBudgetReportPanel({
  budgetEditPath,
  hasExportError = false,
  hasLoadError = false,
  isExporting = false,
  isLoading = false,
  locale,
  onChangeRange,
  onExport,
  onRetry,
  range,
  renderLink,
  report,
  t,
}: ProjectBudgetReportPanelProps) {
  const id = useId()
  const rangeIsValid = isProjectBudgetReportRangeValid(range)
  return (
    <section className="workbench-panel grid gap-4 px-5 py-4" data-testid="project-budget-report">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-[var(--workbench-text)]">{t('timeTracking.projectBudget.title')}</h2>
          <p className="mt-1 text-sm text-[var(--workbench-muted)]">{t('timeTracking.projectBudget.description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {renderLink(budgetEditPath, t('timeTracking.projectBudget.editBudget'))}
          <button
            className="workbench-button-secondary inline-flex min-h-9 items-center px-3"
            disabled={isExporting || !rangeIsValid}
            type="button"
            onClick={onExport}
          >
            {t(isExporting ? 'timeTracking.projectBudget.exporting' : 'timeTracking.projectBudget.export')}
          </button>
        </div>
      </div>
      {hasExportError ? (
        <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('timeTracking.projectBudget.exportError')}</p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="grid gap-1" htmlFor={`${id}-from`}>
          <span className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.projectBudget.from')}</span>
          <input
            className="workbench-input min-h-9 px-2"
            id={`${id}-from`}
            type="date"
            value={range.from}
            onChange={(event) => { if (event.target.value) onChangeRange({ ...range, from: event.target.value }) }}
          />
        </label>
        <label className="grid gap-1" htmlFor={`${id}-to`}>
          <span className="text-xs font-semibold text-[var(--workbench-muted)]">{t('timeTracking.projectBudget.to')}</span>
          <input
            className="workbench-input min-h-9 px-2"
            id={`${id}-to`}
            type="date"
            value={range.to}
            onChange={(event) => { if (event.target.value) onChangeRange({ ...range, to: event.target.value }) }}
          />
        </label>
      </div>
      {!rangeIsValid ? (
        <p className="text-sm font-semibold text-fg-red-700" role="alert">{t('timeTracking.projectBudget.invalidRange')}</p>
      ) : hasLoadError ? (
        <div className="flex flex-wrap items-center gap-3 text-sm" role="alert">
          <span className="font-semibold text-fg-red-700">{t('timeTracking.projectBudget.loadError')}</span>
          <button className="workbench-button-secondary inline-flex min-h-9 items-center px-3" type="button" onClick={onRetry}>{t('timeTracking.projectBudget.retry')}</button>
        </div>
      ) : isLoading || !report ? (
        <p className="text-sm text-[var(--workbench-muted)]" role="status">{t('timeTracking.projectBudget.loading')}</p>
      ) : (
        <ReportContent locale={locale} report={report} t={t} />
      )}
    </section>
  )
}

/**
 * Figures, notes, and chart of a loaded report.
 *
 * @param props - Report, locale, and translator.
 * @returns The content.
 */
function ReportContent({ locale, report, t }: { locale: Locale; report: ProjectBudgetReport; t: TimeTrackingTranslator }) {
  const ev = report.earnedValue
  const money = ev?.money
  const budget = report.budget
  // Approved expenses are actual cost like time; both are shown together per currency.
  const actualByCurrency = sumByCurrency(report.actualCostByCurrency, report.approvedExpenseByCurrency)
  const otherCurrencies = Object.fromEntries(
    Object.entries(actualByCurrency).filter(([currency]) => currency !== budget?.currency),
  )
  // Agent Run cost is already in the budget currency when the Workspace counts it (ADR 0119).
  const agentCostMinor = report.agentCost?.status === 'included' ? report.agentCost.amountMinor ?? 0 : 0
  const budgetCost = budget ? (actualByCurrency[budget.currency] ?? 0) + agentCostMinor : undefined
  const budgetExpense = budget ? report.approvedExpenseByCurrency[budget.currency] ?? 0 : 0
  const formatMoney = (amount: number | undefined) =>
    amount === undefined || !budget ? '—' : formatMinorAmount(amount, budget.currency, locale)
  return (
    <div className="grid gap-4">
      <p className="text-xs text-[var(--workbench-muted)]">
        {interpolate(t('timeTracking.projectBudget.asOf'), { date: report.asOf })}
      </p>
      <dl className="grid grid-cols-1 gap-3 text-sm min-[600px]:grid-cols-3" data-testid="project-budget-figures">
        <Figure label={t('timeTracking.projectBudget.budget')}>
          {budget ? formatMinorAmount(budget.amountMinor, budget.currency, locale) : t('timeTracking.projectBudget.noBudget')}
        </Figure>
        <Figure
          label={t('timeTracking.projectBudget.actualCost')}
          note={[
            report.budgetConsumedPercent === undefined
              ? undefined
              : interpolate(t('timeTracking.projectBudget.consumed'), { percent: report.budgetConsumedPercent }),
            budgetExpense > 0
              ? interpolate(t('timeTracking.projectBudget.includesExpenses'), { amount: formatMoney(budgetExpense) })
              : undefined,
            report.agentCost?.status === 'included'
              ? interpolate(t('timeTracking.projectBudget.includesAgentCost'), { amount: formatMoney(agentCostMinor) })
              : undefined,
          ].filter((part) => part !== undefined).join(' / ') || undefined}
        >
          {budgetCost === undefined
            ? formatCostsByCurrency(actualByCurrency, locale) || '—'
            : formatMinorAmount(budgetCost, budget?.currency ?? '', locale)}
        </Figure>
        <Figure
          label={t('timeTracking.projectBudget.actualEffort')}
          note={report.effortConsumedPercent === undefined || !ev
            ? undefined
            : interpolate(t('timeTracking.projectBudget.effortConsumed'), {
                percent: report.effortConsumedPercent,
                planned: formatMinutes(ev.budgetAtCompletionMinutes),
              })}
        >
          {formatMinutes(report.actualMinutes)}
        </Figure>
        <Figure
          label={t('timeTracking.projectBudget.spi')}
          note={ev ? interpolate(t('timeTracking.projectBudget.spiNote'), {
            earned: formatMinutes(ev.earnedValueMinutes),
            planned: formatMinutes(ev.plannedValueMinutes),
          }) : undefined}
          testId="project-budget-spi"
        >
          {formatPerformanceIndex(ev?.schedulePerformanceIndex)}
        </Figure>
        <Figure
          label={t('timeTracking.projectBudget.cpi')}
          note={money
            ? interpolate(t('timeTracking.projectBudget.cpiMoneyNote'), {
                earned: formatMoney(money.earnedValueMinor),
                actual: formatMoney(money.actualCostMinor),
              })
            : ev
              ? interpolate(t('timeTracking.projectBudget.cpiEffortNote'), {
                  earned: formatMinutes(ev.earnedValueMinutes),
                  actual: formatMinutes(ev.actualMinutes),
                })
              : undefined}
          testId="project-budget-cpi"
        >
          {formatPerformanceIndex(money ? money.costPerformanceIndex : ev?.costPerformanceIndex)}
        </Figure>
        <Figure
          label={t('timeTracking.projectBudget.eac')}
          note={money?.varianceAtCompletionMinor === undefined
            ? undefined
            : interpolate(t('timeTracking.projectBudget.vac'), { amount: formatMoney(money.varianceAtCompletionMinor) })}
        >
          {money
            ? formatMoney(money.estimateAtCompletionMinor)
            : ev?.estimateAtCompletionMinutes === undefined ? '—' : formatMinutes(ev.estimateAtCompletionMinutes)}
        </Figure>
      </dl>
      <ul className="grid gap-1 text-xs text-[var(--workbench-muted)]">
        {!report.baseline ? <li>{t('timeTracking.projectBudget.noBaseline')}</li> : null}
        {report.baseline && !ev ? <li>{t('timeTracking.projectBudget.noBaselineEffort')}</li> : null}
        {report.baseline && report.baseline.unscheduledEffortMinutes > 0 ? (
          <li>{interpolate(t('timeTracking.projectBudget.unscheduled'), { minutes: formatMinutes(report.baseline.unscheduledEffortMinutes) })}</li>
        ) : null}
        {!budget ? <li>{t('timeTracking.projectBudget.noBudgetNote')}</li> : null}
        {report.uncostedMinutes > 0 ? (
          <li>{interpolate(t('timeTracking.projectBudget.uncosted'), { minutes: formatMinutes(report.uncostedMinutes) })}</li>
        ) : null}
        {Object.keys(report.pendingExpenseByCurrency).length > 0 ? (
          <li>{interpolate(t('timeTracking.projectBudget.pendingExpenses'), { amounts: formatCostsByCurrency(report.pendingExpenseByCurrency, locale) })}</li>
        ) : null}
        {report.agentCost?.status === 'missing-exchange-rate' && report.agentCost.runCount > 0 ? (
          <li data-testid="project-budget-agent-cost-missing-rate">
            {interpolate(t('timeTracking.projectBudget.agentCostMissingRate'), {
              amount: formatMinorAmount(Math.round(report.agentCost.estimatedCostMicroUsd / 10_000), 'USD', locale),
            })}
          </li>
        ) : null}
        {report.agentCost?.truncated ? <li>{t('timeTracking.projectBudget.agentCostTruncated')}</li> : null}
        {budget && Object.keys(otherCurrencies).length > 0 ? (
          <li>{interpolate(t('timeTracking.projectBudget.otherCurrencies'), { amounts: formatCostsByCurrency(otherCurrencies, locale) })}</li>
        ) : null}
      </ul>
      <CumulativeChart locale={locale} report={report} t={t} />
    </div>
  )
}

/**
 * Adds two per-currency amounts.
 *
 * @param left - First amounts by ISO currency.
 * @param right - Second amounts by ISO currency.
 * @returns The sums by currency.
 */
function sumByCurrency(left: Readonly<Record<string, number>>, right: Readonly<Record<string, number>>): Record<string, number> {
  const sums: Record<string, number> = { ...left }
  for (const [currency, amount] of Object.entries(right)) sums[currency] = (sums[currency] ?? 0) + amount
  return sums
}

/**
 * One labelled figure.
 *
 * @param props - Label, value, optional note, and test ID.
 * @returns The figure.
 */
function Figure({ children, label, note, testId }: { children: ReactNode; label: string; note?: string; testId?: string }) {
  return (
    <div className="grid gap-1 rounded-md border border-[var(--workbench-border)] px-3 py-2" data-testid={testId}>
      <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-[var(--workbench-text)]">{children}</dd>
      {note ? <dd className="text-xs text-[var(--workbench-muted)]">{note}</dd> : null}
    </div>
  )
}

const WIDTH = 640
const HEIGHT = 200
const PADDING_LEFT = 84
const PADDING = 20

/** One drawn series of the cumulative chart. */
type ChartSeries = {
  /** Legend label. */
  label: string
  /** CSS color. */
  color: string
  /** Whether the line is dashed. */
  dashed: boolean
  /** Value per point; null where none exists. */
  values: Array<number | null>
}

/**
 * Cumulative planned value against actual, in the budget currency when a budget exists and in
 * hours otherwise, with a table view of every point.
 *
 * @param props - Report, locale, and translator.
 * @returns The chart.
 */
function CumulativeChart({ locale, report, t }: { locale: Locale; report: ProjectBudgetReport; t: TimeTrackingTranslator }) {
  const budget = report.budget
  const inMoney = Boolean(budget && report.points.some((point) => point.plannedValueMinor !== undefined))
  const format = (value: number) => inMoney && budget ? formatMinorAmount(value, budget.currency, locale) : formatMinutes(value)
  const planned = (point: ProjectBudgetReportPoint) => inMoney ? point.plannedValueMinor ?? null : point.plannedValueMinutes
  const actual = (point: ProjectBudgetReportPoint) => (inMoney ? point.actualCostMinor : point.actualMinutes) ?? null
  const series: ChartSeries[] = [
    { label: t('timeTracking.projectBudget.chart.planned'), color: 'var(--workbench-chart-category-1)', dashed: true, values: report.points.map(planned) },
    { label: t('timeTracking.projectBudget.chart.actual'), color: 'var(--workbench-chart-category-2)', dashed: false, values: report.points.map(actual) },
  ]
  const maximum = Math.max(1, ...series.flatMap((line) => line.values.flatMap((value) => value === null ? [] : [value])))
  const chartWidth = WIDTH - PADDING_LEFT - PADDING
  const chartHeight = HEIGHT - PADDING * 2
  const count = report.points.length
  const xAt = (index: number) => PADDING_LEFT + (count <= 1 ? chartWidth / 2 : index * chartWidth / (count - 1))
  const yAt = (value: number) => PADDING + chartHeight - value / maximum * chartHeight
  const label = t(inMoney ? 'timeTracking.projectBudget.chart.titleMoney' : 'timeTracking.projectBudget.chart.titleEffort')
  return (
    <div data-testid="project-budget-chart">
      <p className="text-sm font-semibold text-[var(--workbench-text)]">{label}</p>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {series.map((line) => (
          <li className="flex items-center gap-1.5" key={line.label}>
            <span
              aria-hidden="true"
              className={`inline-block w-4 border-t-2 ${line.dashed ? 'border-dashed' : ''}`}
              style={{ borderColor: line.color }}
            />
            {line.label}
          </li>
        ))}
      </ul>
      <div aria-label={label} className="mt-2" role="img">
        <svg className="h-auto max-h-72 w-full overflow-visible" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}>
          <title>{label}</title>
          {[maximum, maximum / 2, 0].map((tick) => (
            <g key={tick}>
              <line
                strokeDasharray="4 5"
                style={{ stroke: 'var(--workbench-chart-grid)' }}
                x1={PADDING_LEFT}
                x2={WIDTH - PADDING}
                y1={yAt(tick)}
                y2={yAt(tick)}
              />
              <text className="text-[11px]" style={{ fill: 'var(--workbench-muted)' }} textAnchor="end" x={PADDING_LEFT - 6} y={yAt(tick) + 4}>
                {format(Math.round(tick))}
              </text>
            </g>
          ))}
          {series.map((line) => (
            <g key={line.label}>
              <path
                d={createPath(line.values, xAt, yAt)}
                fill="none"
                strokeDasharray={line.dashed ? '6 4' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                style={{ stroke: line.color }}
              />
              {listIsolatedPoints(line.values).map((index) => (
                <circle
                  cx={xAt(index)}
                  cy={yAt(line.values[index] ?? 0)}
                  key={index}
                  r="3"
                  style={{ fill: line.color }}
                />
              ))}
            </g>
          ))}
        </svg>
      </div>
      <div
        className="mt-1 flex items-center justify-between gap-3 text-xs font-semibold text-[var(--workbench-muted)]"
        style={{ paddingLeft: `${PADDING_LEFT / WIDTH * 100}%` }}
      >
        <span>{report.points[0]?.date}</span>
        <span>{report.points.at(-1)?.endDate}</span>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--workbench-primary-text)]">
          {t('timeTracking.projectBudget.chart.table')}
        </summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="w-full min-w-[420px] border-collapse text-left text-sm">
            <thead>
              <tr className="workbench-table-head">
                <th className="px-3 py-2" scope="col">{t('timeTracking.projectBudget.chart.period')}</th>
                {series.map((line) => <th className="px-3 py-2 text-right" key={line.label} scope="col">{line.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {report.points.map((point, index) => (
                <tr className="border-b border-[var(--workbench-border)]" key={point.date}>
                  <td className="px-3 py-2 tabular-nums">{point.date === point.endDate ? point.date : `${point.date} – ${point.endDate}`}</td>
                  {series.map((line) => {
                    const value = line.values[index]
                    return (
                      <td className="px-3 py-2 text-right tabular-nums" key={line.label}>
                        {value === null || value === undefined ? '—' : format(value)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

/**
 * Builds an SVG path through the known values, breaking the line where a value is missing.
 *
 * @param values - Value per point.
 * @param xAt - Horizontal position of a point.
 * @param yAt - Vertical position of a value.
 * @returns Path data.
 */
function createPath(values: ReadonlyArray<number | null>, xAt: (index: number) => number, yAt: (value: number) => number): string {
  let path = ''
  let drawing = false
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false
      return
    }
    path += `${drawing ? 'L' : 'M'}${xAt(index).toFixed(1)} ${yAt(value).toFixed(1)} `
    drawing = true
  })
  return path.trim()
}
