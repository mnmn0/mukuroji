import type {
  AgentRunUsage,
  FactoryAnalyticsPullRequestLeadTime,
  FactoryAnalyticsUsage,
  TeamFactoryAnalyticsResponse,
  WorkspaceWorkPhaseSettings,
} from '@mukuroji/contracts'
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
  /** Project names by ID, for the usage per Project; an unknown ID shows as the ID. */
  projectNames?: Readonly<Record<string, string>>
  /** Workspace work phases, for the names of the usage per phase; built-in phases are translated without them. */
  workPhases?: WorkspaceWorkPhaseSettings
  /** Whether reading the Workspace work phases failed. */
  hasWorkPhasesError?: boolean
  /** Reads the Workspace work phases again. */
  onRetryWorkPhases?: () => void
}

/** Props of the token usage part. */
type UsageSummaryProps = {
  /** Usage of the period. */
  usage: FactoryAnalyticsUsage
  /** Locale-aware text. */
  labels: FactoryAnalyticsLabels
  /** Project names by ID. */
  projectNames: Readonly<Record<string, string>>
  /** Workspace work phases, for phase names. */
  workPhases?: WorkspaceWorkPhaseSettings
  /** Whether reading the Workspace work phases failed. */
  hasWorkPhasesError: boolean
  /** Reads the Workspace work phases again. */
  onRetryWorkPhases?: () => void
}

/**
 * Adds the four token counts of a usage.
 *
 * @param usage - Usage.
 * @returns Total tokens.
 */
function totalTokens(usage: AgentRunUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
}

/**
 * Shows the telemetry usage of the period: the total, the usage per Project, and the Work Items with
 * the most tokens. Each row's bar is relative to the largest row of its list.
 *
 * @param props - Usage, text, and Project names.
 * @returns Usage part.
 */
function UsageSummary({ hasWorkPhasesError, labels, onRetryWorkPhases, projectNames, usage, workPhases }: UsageSummaryProps) {
  const projectMax = Math.max(1, ...usage.projects.map((project) => totalTokens(project.usage)))
  const phaseMax = Math.max(1, ...usage.phases.map((phase) => totalTokens(phase.usage)))
  const workItemMax = Math.max(1, ...usage.workItems.map((item) => totalTokens(item.usage)))
  const partial = usage.runsHasMore || usage.total.hasMore ||
    usage.projects.some((project) => project.usage.hasMore) || usage.workItems.some((item) => item.usage.hasMore)
  return (
    <div className="flex flex-col gap-2" data-testid="factory-analytics-usage">
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{labels.usageHeading}</h3>
      <p className="text-xs text-[var(--workbench-muted)]">{labels.usageHint}</p>
      {partial ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-semibold text-fg-amber-800" role="note">{labels.usagePartial}</p>
      ) : null}
      <div className="flex flex-col gap-0.5 rounded-md border border-[var(--workbench-border)] px-3 py-2">
        <span className="text-lg font-semibold tabular-nums text-[var(--workbench-text)]">{labels.formatUsageCompact(usage.total)}</span>
        <span className="text-xs tabular-nums text-[var(--workbench-muted)]">{labels.formatUsageTokens(usage.total)}</span>
        <span className="text-xs tabular-nums text-[var(--workbench-muted)]">{labels.formatUsageDetail(usage.total)}</span>
      </div>
      <div className="grid gap-3 min-[760px]:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-1">
          <h4 className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.usageProjectsHeading}</h4>
          <ul className="flex flex-col gap-1.5">
            {usage.projects.map((project) => (
              <UsageRow
                key={project.projectId ?? ''}
                labels={labels}
                max={projectMax}
                name={project.projectId === undefined ? labels.usageNoProject : projectNames[project.projectId] ?? project.projectId}
                usage={project.usage}
              />
            ))}
          </ul>
        </section>
        <section className="flex min-w-0 flex-col gap-1">
          <h4 className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.usageWorkItemsHeading}</h4>
          <ol className="flex flex-col gap-1.5">
            {usage.workItems.map((item) => (
              <UsageRow key={item.workItemId} labels={labels} max={workItemMax} name={item.title} usage={item.usage} />
            ))}
          </ol>
        </section>
        {usage.phases.length > 0 ? (
          <section className="flex min-w-0 flex-col gap-1" data-testid="factory-analytics-usage-phases">
            <h4 className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.usagePhasesHeading}</h4>
            {hasWorkPhasesError ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs font-semibold text-fg-red-700" role="alert">
                <span>{labels.workPhasesLoadError}</span>
                {onRetryWorkPhases ? (
                  <button className="workbench-button-secondary min-h-[44px] px-3" onClick={onRetryWorkPhases} type="button">{labels.retryWorkPhases}</button>
                ) : null}
              </div>
            ) : null}
            <ul className="flex flex-col gap-1.5">
              {usage.phases.map((phase) => (
                <UsageRow
                  key={phase.phaseKey}
                  labels={labels}
                  max={phaseMax}
                  name={labels.phaseName(phase.phaseKey, workPhases)}
                  usage={phase.usage}
                />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  )
}

/** Props of the pull request interval part. */
type PullRequestLeadTimesProps = {
  /** Median of each interval. */
  intervals: readonly FactoryAnalyticsPullRequestLeadTime[]
  /** Locale-aware text. */
  labels: FactoryAnalyticsLabels
  /** Formats hours, or the not-available text for null. */
  hours: (value: number | null) => string
  /** Formats a number for the locale. */
  formatNumber: (value: number) => string
}

/**
 * Shows the median pull request intervals of the period, from creation to the first review, to
 * approval, and to merge.
 *
 * @param props - Intervals, text, and formatters.
 * @returns Interval part.
 */
function PullRequestLeadTimes({ intervals, labels, hours, formatNumber }: PullRequestLeadTimesProps) {
  return (
    <div className="flex flex-col gap-2" data-testid="factory-analytics-pull-requests">
      <h3 className="text-sm font-semibold text-[var(--workbench-text)]">{labels.pullRequestHeading}</h3>
      <p className="text-xs text-[var(--workbench-muted)]">{labels.pullRequestHint}</p>
      <ol className="grid grid-cols-2 gap-2 min-[760px]:grid-cols-4">
        {intervals.map((interval) => (
          <li className="flex flex-col gap-0.5 rounded-md bg-[var(--workbench-surface-muted)] px-3 py-2" key={interval.interval}>
            <span className="text-xs font-semibold text-[var(--workbench-muted)]">{labels.pullRequestIntervals[interval.interval]}</span>
            <span className="text-lg font-semibold tabular-nums text-[var(--workbench-text)]">{hours(interval.medianHours)}</span>
            <span className="text-xs text-[var(--workbench-muted)]">{labels.pullRequestSamples.replace('{count}', formatNumber(interval.sampleSize))}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Props of one usage row. */
type UsageRowProps = {
  /** Project or Work Item name. */
  name: string
  /** Usage of the row. */
  usage: AgentRunUsage
  /** Largest total tokens in the row's list, for the bar width. */
  max: number
  /** Locale-aware text. */
  labels: FactoryAnalyticsLabels
}

/**
 * Shows the name, total tokens, and a relative bar of one Project or Work Item.
 *
 * @param props - Name, usage, list maximum, and text.
 * @returns List item.
 */
function UsageRow({ name, usage, max, labels }: UsageRowProps) {
  const width = Math.max(2, Math.round((totalTokens(usage) / max) * 100))
  return (
    <li className="flex min-w-0 flex-col gap-0.5" title={labels.formatUsageTokens(usage)}>
      <div className="flex min-w-0 items-baseline justify-between gap-2 text-sm">
        <span className="min-w-0 truncate text-[var(--workbench-text)]">{name}</span>
        <span className="shrink-0 tabular-nums text-xs text-[var(--workbench-muted)]">{labels.formatUsageCompact(usage)}</span>
      </div>
      <div aria-hidden="true" className="h-1.5 rounded-full bg-[var(--workbench-surface-muted)]">
        <div className="h-1.5 rounded-full bg-[var(--workbench-primary)]" style={{ width: `${width}%` }} />
      </div>
    </li>
  )
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
 * runtime, and the telemetry token usage when runs have it. Missing rates show a dash instead of zero, and a notice says when the server left runs out.
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
  projectNames = {},
  workPhases,
  hasWorkPhasesError = false,
  onRetryWorkPhases,
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

              {analytics.pullRequestLeadTimes.some((interval) => interval.sampleSize > 0) ? (
                <PullRequestLeadTimes
                  formatNumber={formatNumber}
                  hours={hours}
                  intervals={analytics.pullRequestLeadTimes}
                  labels={labels}
                />
              ) : null}

              {analytics.usage ? (
                <UsageSummary
                  hasWorkPhasesError={hasWorkPhasesError}
                  labels={labels}
                  projectNames={projectNames}
                  usage={analytics.usage}
                  workPhases={workPhases}
                  {...(onRetryWorkPhases ? { onRetryWorkPhases } : {})}
                />
              ) : null}
            </>
          )}
        </>
      )}
    </section>
  )
}
