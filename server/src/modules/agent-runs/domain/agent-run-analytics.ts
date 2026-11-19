import {
  AGENT_RUN_RUNTIMES,
  FACTORY_ANALYTICS_STAGES,
  type AgentRunOutcome,
  type AgentRunReport,
  type AgentRunReportKind,
  type AgentRunRuntime,
  type FactoryAnalyticsRunSummary,
  type FactoryAnalyticsRuntimeSummary,
  type FactoryAnalyticsStage,
  type FactoryAnalyticsStageLeadTime,
} from '@mukuroji/contracts'
import type { StoredAgentRun } from './agent-run'

/** Milliseconds in one hour. */
const millisecondsPerHour = 3_600_000

/** Station a run enters after each report kind. */
const stageByReportKind: Record<AgentRunReportKind, FactoryAnalyticsStage> = {
  progress: 'build',
  verification: 'verify',
  artifact: 'artifact',
  blocker: 'decision',
  handoff: 'decision',
}

/** Run and report history of one Work Item, as far as it was read. */
export type FactoryAnalyticsWorkItemHistory = {
  /** Runs of the Work Item in any order; the newest ones when the history was cut. */
  runs: readonly StoredAgentRun[]
  /** Whether `runs` holds every run of the Work Item. */
  runsComplete: boolean
  /** Structured reports of the Work Item in any order; the newest ones when the history was cut. */
  reports: readonly AgentRunReport[]
}

/** Period and histories Factory analytics are calculated from. */
export type FactoryAnalyticsInput = {
  /** Start of the period in epoch milliseconds, inclusive. */
  from: number
  /** End of the period in epoch milliseconds, inclusive. */
  to: number
  /** Histories of the Work Items the viewer can see. */
  histories: readonly FactoryAnalyticsWorkItemHistory[]
}

/** Factory analytics calculated from run and report histories. */
export type FactoryAnalyticsResult = FactoryAnalyticsRunSummary & {
  /** Median dwell time per station, in station order. */
  stageLeadTimes: FactoryAnalyticsStageLeadTime[]
  /** Outcome rates per runtime with at least one finished run, in runtime order. */
  runtimes: FactoryAnalyticsRuntimeSummary[]
  /** Whether a run's rework or dwell time was left out because its history was cut. */
  historyHasMore: boolean
}

/** One finished run counted in the period. */
type CountedRun = {
  /** Runtime of the run. */
  runtime: AgentRunRuntime
  /** Outcome of the run. */
  outcome: AgentRunOutcome
  /** Whether the run was rework. */
  rework: boolean
}

/**
 * Creates outcome counts with every outcome at zero.
 *
 * @returns Zeroed counts.
 */
function createOutcomeCounts(): Record<AgentRunOutcome, number> {
  return { completed: 0, paused: 0, failed: 0, released: 0, superseded: 0 }
}

/**
 * Rounds a value to a fixed number of decimals for a stable response.
 *
 * @param value - Value to round.
 * @param decimals - Number of decimals.
 * @returns Rounded value.
 */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Calculates a percentage of a part in a whole.
 *
 * @param part - Counted part.
 * @param whole - Whole; zero yields null.
 * @returns Percentage rounded to one decimal, or null when the whole is zero.
 */
function percentage(part: number, whole: number): number | null {
  return whole === 0 ? null : roundTo((part / whole) * 100, 1)
}

/**
 * Calculates the median of a list of numbers.
 *
 * @param values - Values in any order.
 * @returns Median, or null for an empty list.
 */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 1 ? sorted[middle] : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  return value === undefined ? null : value
}

/**
 * Summarizes the outcomes and rework of a group of counted runs.
 *
 * @param runs - Counted runs.
 * @returns Outcome counts and rates.
 */
function summarizeRuns(runs: readonly CountedRun[]): FactoryAnalyticsRunSummary {
  const outcomes = createOutcomeCounts()
  let reworkRuns = 0
  for (const run of runs) {
    outcomes[run.outcome] += 1
    if (run.rework) reworkRuns += 1
  }
  return {
    finishedRuns: runs.length,
    outcomes,
    successRate: percentage(outcomes.completed, runs.length - outcomes.paused),
    reworkRuns,
    reworkRate: percentage(reworkRuns, runs.length),
    interventions: outcomes.released + outcomes.superseded,
  }
}

/**
 * Orders runs by start time, oldest first, with the run ID as a stable tie-breaker.
 *
 * @param left - First run.
 * @param right - Second run.
 * @returns Sort order.
 */
function compareRunStart(left: StoredAgentRun, right: StoredAgentRun): number {
  return Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.runId.localeCompare(right.runId)
}

/**
 * Adds the hours of one interval to a station, ignoring intervals that run backwards.
 *
 * @param dwell - Hours per station of one run.
 * @param stage - Station.
 * @param start - Interval start in epoch milliseconds.
 * @param end - Interval end in epoch milliseconds.
 */
function addDwell(dwell: Map<FactoryAnalyticsStage, number>, stage: FactoryAnalyticsStage, start: number, end: number): void {
  dwell.set(stage, (dwell.get(stage) ?? 0) + Math.max(0, end - start) / millisecondsPerHour)
}

/**
 * Measures the hours one finished run spent in each station: from its start in `build`, then in the
 * station each report moves it to, until its finish. A run that finished as `paused` also spends the
 * time until the next run of the Work Item started in `decision`; while no run has followed it, that
 * wait is still open and is not counted.
 *
 * @param run - Finished run.
 * @param reports - Every report of the run.
 * @param next - Next run of the same Work Item, when one started.
 * @returns Hours per station the run entered.
 */
function measureRunDwell(
  run: StoredAgentRun,
  reports: readonly AgentRunReport[],
  next: StoredAgentRun | undefined,
): Map<FactoryAnalyticsStage, number> {
  const dwell = new Map<FactoryAnalyticsStage, number>()
  const finishedAt = Date.parse(run.finishedAt ?? '')
  let stage: FactoryAnalyticsStage = 'build'
  let since = Date.parse(run.startedAt)
  for (const report of [...reports].sort((left, right) => left.sequence - right.sequence)) {
    const at = Math.min(Date.parse(report.createdAt), finishedAt)
    addDwell(dwell, stage, since, at)
    stage = stageByReportKind[report.kind]
    since = Math.max(since, at)
  }
  addDwell(dwell, stage, since, finishedAt)
  if (run.outcome === 'paused' && next !== undefined) {
    addDwell(dwell, 'decision', finishedAt, Date.parse(next.startedAt))
  }
  return dwell
}

/**
 * Calculates Factory analytics for the runs that finished in a period: outcome counts, success and
 * rework rates, interventions, and the median hours runs spent in each station, overall and per
 * runtime. Rework compares a run with the previous run of its Work Item; dwell time needs every report
 * of the run. A run whose previous run or reports were not read is still counted, but is left out of
 * rework or dwell time, and the result says so.
 *
 * @param input - Period and histories.
 * @returns Factory analytics of the period.
 */
export function calculateFactoryAnalytics(input: FactoryAnalyticsInput): FactoryAnalyticsResult {
  const counted: CountedRun[] = []
  const dwellSamples = new Map<FactoryAnalyticsStage, number[]>(FACTORY_ANALYTICS_STAGES.map((stage) => [stage, []]))
  let historyHasMore = false

  for (const history of input.histories) {
    const runs = [...history.runs].sort(compareRunStart)
    const reportsByRun = new Map<string, AgentRunReport[]>()
    for (const report of history.reports) {
      const reports = reportsByRun.get(report.runId) ?? []
      reports.push(report)
      reportsByRun.set(report.runId, reports)
    }
    runs.forEach((run, index) => {
      if (run.state !== 'finished' || run.outcome === undefined || run.finishedAt === undefined) return
      const finishedAt = Date.parse(run.finishedAt)
      if (!(finishedAt >= input.from && finishedAt <= input.to)) return
      const previous = runs[index - 1]
      if (previous === undefined && !history.runsComplete) historyHasMore = true
      counted.push({
        runtime: run.runtime,
        outcome: run.outcome,
        rework: previous?.outcome === 'failed' || previous?.outcome === 'completed',
      })
      const reports = reportsByRun.get(run.runId) ?? []
      if (reports.length < run.reportCount) {
        historyHasMore = true
        return
      }
      for (const [stage, hours] of measureRunDwell(run, reports, runs[index + 1])) {
        dwellSamples.get(stage)?.push(hours)
      }
    })
  }

  return {
    ...summarizeRuns(counted),
    stageLeadTimes: FACTORY_ANALYTICS_STAGES.map((stage) => {
      const samples = dwellSamples.get(stage) ?? []
      const value = median(samples)
      return { stage, medianHours: value === null ? null : roundTo(value, 2), sampleSize: samples.length }
    }),
    runtimes: AGENT_RUN_RUNTIMES.flatMap((runtime) => {
      const runs = counted.filter((run) => run.runtime === runtime)
      return runs.length === 0 ? [] : [{ runtime, ...summarizeRuns(runs) }]
    }),
    historyHasMore,
  }
}
