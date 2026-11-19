import type { TeamFactoryAnalyticsResponse } from '@mukuroji/contracts'
import { useId } from 'react'
import {
  FACTORY_ANALYTICS_PERIOD_DAYS,
  isFactoryAnalyticsIncomplete,
  readFactoryAnalyticsPeriodDays,
  type FactoryAnalyticsPeriodDays,
} from '../model/factoryAnalytics'
import type { FactoryAnalyticsLabels } from './factoryBoardLabels'

/** Props of the Factory analytics summary. */
export type FactoryAnalyticsSummaryProps = {
  /** Analytics of the selected period, once loaded. */
  analytics?: TeamFactoryAnalyticsResponse
  /** Whether the first read is in progress. */
  isLoading: boolean
  /** Safe failure text of the read; shown instead of the numbers. */
  errorMessage?: string
  /** Reads the analytics again. */
  onRetry: () => void
  /** Selected period length. */
  periodDays: FactoryAnalyticsPeriodDays
  /** Selects another period length. */
  onPeriodDaysChange: (days: FactoryAnalyticsPeriodDays) => void
  /** Locale-aware text. */
  labels: FactoryAnalyticsLabels
  /** Formats a number for the locale. */
  formatNumber: (value: number) => string
}

/** Props of one headline figure. */
type FigureProps = {
  /** Heading of the figure. */
  label: string
  /** Main value. */
  value: string
  /** Breakdown under the value. */
  detail: string
}

/**
 * Shows one headline figure with its breakdown.
 *
 * @param props - Heading, value, and breakdown.
 * @returns Figure.
 */
function Figure({ label, value, detail }: FigureProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md border border-[var(--workbench-border)] px-3 py-2">
      <dt className="text-xs font-semibold text-[var(--workbench-muted)]">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums text-[var(--workbench-text)]">{value}</dd>
      <dd className="text-xs text-[var(--workbench-muted)]">{detail}</dd>
    </div>
  )
}

/**
 * Shows the Factory analytics of a Team for a period above the board: success and rework rates,
 * interventions, finished runs, the median time runs spent in each station, and the same rates per
 * runtime. Missing rates show a dash instead of zero, and a notice says when the server left runs out.
 *
 * @param props - Analytics, read state, period, and text.
 * @returns Analytics summary section.
 */
export function FactoryAnalyticsSummary({
  analytics,
  isLoading,
  errorMessage,
  onRetry,
  periodDays,
  onPeriodDaysChange,
  labels,
  formatNumber,
}: FactoryAnalyticsSummaryProps) {
  const headingId = useId()
  const periodId = useId()
  /**
   * Formats a percentage, or a dash when it cannot be calculated.
   *
   * @param value - Percentage or null.
   * @returns Display text.
   */
  const percent = (value: number | null) => value === null ? labels.notAvailable : labels.percent.replace('{value}', formatNumber(value))
  /**
   * Formats a duration in hours, or a dash when no run entered the station.
   *
   * @param value - Hours or null.
   * @returns Display text.
   */
  const hours = (value: number | null) => value === null ? labels.notAvailable : labels.stageHours.replace('{hours}', formatNumber(value))

  return (
    <section aria-labelledby={headingId} className="mb-5 flex flex-col gap-3" data-testid="factory-analytics">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-[var(--workbench-text)]" id={headingId}>{labels.title}</h2>
          <p className="text-xs text-[var(--workbench-muted)]">{labels.description}</p>
        </div>
        <label className="flex flex-col gap-1 text-xs font-semibold text-[var(--workbench-muted)]" htmlFor={periodId}>
          {labels.period}
          <select
            className="workbench-input min-h-[40px]"
            id={periodId}
            onChange={(event) => {
              const days = readFactoryAnalyticsPeriodDays(event.target.value)
              if (days !== undefined) onPeriodDaysChange(days)
            }}
            value={String(periodDays)}
          >
            {FACTORY_ANALYTICS_PERIOD_DAYS.map((days) => (
              <option key={days} value={String(days)}>{labels.periodDays.replace('{days}', String(days))}</option>
            ))}
          </select>
        </label>
      </div>

      {errorMessage ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-fg-red-700" role="alert">
          <span>{errorMessage}</span>
          <button className="workbench-button-secondary min-h-[44px] px-3" onClick={onRetry} type="button">{labels.retry}</button>
        </div>
      ) : !analytics ? (
        isLoading ? <p className="text-sm text-[var(--workbench-muted)]" role="status">{labels.loading}</p> : null
      ) : (
        <>
          {isFactoryAnalyticsIncomplete(analytics) ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-fg-amber-800" role="note">{labels.incomplete}</p>
          ) : null}
          {analytics.finishedRuns === 0 ? (
            <p className="text-sm text-[var(--workbench-muted)]" role="status">{labels.empty}</p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-2 min-[760px]:grid-cols-4">
                <Figure
                  detail={labels.successRateDetail
                    .replace('{completed}', formatNumber(analytics.outcomes.completed))
                    .replace('{total}', formatNumber(analytics.finishedRuns - analytics.outcomes.paused))}
                  label={labels.successRate}
                  value={percent(analytics.successRate)}
                />
                <Figure
                  detail={labels.reworkRateDetail.replace('{count}', formatNumber(analytics.reworkRuns))}
                  label={labels.reworkRate}
                  value={percent(analytics.reworkRate)}
                />
                <Figure
                  detail={labels.interventionsDetail
                    .replace('{released}', formatNumber(analytics.outcomes.released))
                    .replace('{superseded}', formatNumber(analytics.outcomes.superseded))}
                  label={labels.interventions}
                  value={formatNumber(analytics.interventions)}
                />
                <Figure
                  detail={labels.finishedRunsDetail
                    .replace('{failed}', formatNumber(analytics.outcomes.failed))
                    .replace('{paused}', formatNumber(analytics.outcomes.paused))}
                  label={labels.finishedRuns}
                  value={formatNumber(analytics.finishedRuns)}
                />
              </dl>

              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{labels.stageHeading}</h3>
                <ol className="grid grid-cols-2 gap-2 min-[760px]:grid-cols-4">
                  {analytics.stageLeadTimes.map((stage) => (
                    <li className="flex flex-col gap-0.5 rounded-md bg-[var(--workbench-surface-muted)] px-3 py-2" key={stage.stage}>
                      <span className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.stages[stage.stage]}</span>
                      <span className="text-lg font-semibold tabular-nums text-[var(--workbench-text)]">{hours(stage.medianHours)}</span>
                      <span className="text-xs text-[var(--workbench-muted)]">{labels.stageSamples.replace('{count}', formatNumber(stage.sampleSize))}</span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{labels.runtimeHeading}</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs text-[var(--workbench-muted)]">
                      <tr>
                        <th className="py-1 pr-3 font-semibold" scope="col">{labels.runtimeColumn}</th>
                        <th className="py-1 pr-3 text-right font-semibold" scope="col">{labels.runsColumn}</th>
                        <th className="py-1 pr-3 text-right font-semibold" scope="col">{labels.successColumn}</th>
                        <th className="py-1 pr-3 text-right font-semibold" scope="col">{labels.reworkColumn}</th>
                        <th className="py-1 text-right font-semibold" scope="col">{labels.interventionsColumn}</th>
                      </tr>
                    </thead>
                    <tbody className="tabular-nums text-[var(--workbench-text)]">
                      {analytics.runtimes.map((runtime) => (
                        <tr className="border-t border-[var(--workbench-border)]" key={runtime.runtime}>
                          <th className="py-1.5 pr-3 font-medium" scope="row">{labels.runtimes[runtime.runtime]}</th>
                          <td className="py-1.5 pr-3 text-right">{formatNumber(runtime.finishedRuns)}</td>
                          <td className="py-1.5 pr-3 text-right">{percent(runtime.successRate)}</td>
                          <td className="py-1.5 pr-3 text-right">{percent(runtime.reworkRate)}</td>
                          <td className="py-1.5 text-right">{formatNumber(runtime.interventions)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
