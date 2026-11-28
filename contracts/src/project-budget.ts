import type { TimeBudget } from './time-tracking'

/**
 * Audit event type recorded once when a Project budget's use reaches its alert percentage
 * (ADR 0105). It notifies the Project owner and fires the `budget-threshold` Automation trigger.
 */
export const PROJECT_BUDGET_THRESHOLD_REACHED_EVENT_TYPE = 'project-budget.threshold-reached'

/** Calendar bucket of the Project budget report series. */
export type ProjectBudgetReportInterval = 'day' | 'week'

/** Every Project budget report interval. */
export const PROJECT_BUDGET_REPORT_INTERVALS: readonly ProjectBudgetReportInterval[] = ['day', 'week']

/** Most points one Project budget report series may hold. */
export const PROJECT_BUDGET_REPORT_MAX_POINTS = 400

/**
 * Reports whether a value names a Project budget report interval.
 *
 * @param value - Candidate value.
 * @returns Whether it is `day` or `week`.
 */
export function isProjectBudgetReportInterval(value: unknown): value is ProjectBudgetReportInterval {
  return value === 'day' || value === 'week'
}

/** The active schedule baseline a Project budget report measures against. */
export type ProjectBudgetReportBaseline = {
  /** Baseline ID; absent for a baseline saved before named baselines existed. */
  id?: string
  /** Name the Project manager gave the baseline; absent when none was given. */
  name?: string
  /** ISO timestamp of the capture. */
  capturedAt: string
  /** Number of Work Items the baseline holds. */
  entryCount: number
  /** Planned effort of baseline Work Items without a planned end date, which no date plans. */
  unscheduledEffortMinutes: number
  /** Planned effort of baseline Work Items that were canceled since, left out of every value. */
  canceledEffortMinutes: number
}

/**
 * Estimated coding agent cost the Project budget counts (ADR 0119): Agent Runs that finished from
 * the report start through the as-of date on Work Items the Project holds now.
 */
export type ProjectBudgetAgentCost = {
  /**
   * `included` when the budget is in USD and the cost is part of the actual cost;
   * `separate-currency` when the budget is in another currency, so the cost is shown in US
   * dollars beside the budget and nothing is added (the cost is not converted).
   */
  status: 'included' | 'separate-currency'
  /** Estimated cost in millionths of a US dollar, as the agent runtimes reported it. */
  estimatedCostMicroUsd: number
  /** The cost in US cents added to the actual cost; present only when `status` is `included`. */
  amountMinor?: number
  /** Agent Runs with reported usage that were counted, including runs whose cost was zero. */
  runCount: number
  /**
   * True when the Project had more finished Agent Runs than one report reads, or a run had more
   * usage than one read returns, so the cost is a lower bound.
   */
  truncated: boolean
}

/** Cumulative values at the end of one day or week of the report. */
export type ProjectBudgetReportPoint = {
  /** First local date of the bucket (a Monday for weeks, clipped to the report start). */
  date: string
  /** Last local date of the bucket, clipped to the report end. */
  endDate: string
  /** Planned value in minutes: baseline effort planned to be done by the end of the bucket. */
  plannedValueMinutes: number
  /** Planned value in the budget currency; absent without a budget. */
  plannedValueMinor?: number
  /**
   * Actual minutes recorded on the Project from the report start through the bucket; absent for
   * buckets that start after the as-of date.
   */
  actualMinutes?: number
  /**
   * Actual cost in the budget currency from the report start through the bucket, time cost plus
   * approved expenses, plus Agent Run cost for a USD budget when the Workspace counts it (ADR 0119); absent without
   * a budget and for buckets that start after the as-of date.
   */
  actualCostMinor?: number
}

/** Earned value figures in the budget currency. */
export type ProjectEarnedValueMoney = {
  /** ISO 4217 currency of every amount, the budget currency. */
  currency: string
  /** Budget at completion: the budget amount. */
  budgetAtCompletionMinor: number
  /** Planned value at the as-of date. */
  plannedValueMinor: number
  /** Earned value at the as-of date. */
  earnedValueMinor: number
  /**
   * Actual cost in the budget currency through the as-of date: time cost plus approved expenses,
   * plus Agent Run cost for a USD budget when the Workspace counts it (ADR 0119).
   */
  actualCostMinor: number
  /** Schedule variance, earned minus planned value. */
  scheduleVarianceMinor: number
  /** Cost variance, earned value minus actual cost. */
  costVarianceMinor: number
  /** Cost performance index, earned value divided by actual cost; absent without actual cost. */
  costPerformanceIndex?: number
  /** Estimate at completion, budget divided by the cost index; absent without a cost index. */
  estimateAtCompletionMinor?: number
  /** Estimate to complete, estimate at completion minus actual cost. */
  estimateToCompleteMinor?: number
  /** Variance at completion, budget minus estimate at completion. */
  varianceAtCompletionMinor?: number
}

/** Earned value management figures of a Project at the as-of date. */
export type ProjectEarnedValueMetrics = {
  /** Budget at completion in minutes: the planned effort of the active baseline. */
  budgetAtCompletionMinutes: number
  /** Planned value in minutes at the as-of date. */
  plannedValueMinutes: number
  /** Earned value in minutes: baseline effort times each Work Item's current progress. */
  earnedValueMinutes: number
  /** Actual minutes recorded on the Project through the as-of date. */
  actualMinutes: number
  /** Schedule variance in minutes, earned minus planned value. */
  scheduleVarianceMinutes: number
  /** Cost variance in minutes, earned value minus actual minutes. */
  costVarianceMinutes: number
  /** Schedule performance index, earned divided by planned value; absent without planned value. */
  schedulePerformanceIndex?: number
  /** Cost performance index in effort, earned value divided by actual minutes; absent without them. */
  costPerformanceIndex?: number
  /** Estimate at completion in minutes, budget divided by the cost index. */
  estimateAtCompletionMinutes?: number
  /** Estimate to complete in minutes, estimate at completion minus actual minutes. */
  estimateToCompleteMinutes?: number
  /** Variance at completion in minutes, budget minus estimate at completion. */
  varianceAtCompletionMinutes?: number
  /** The same figures in the budget currency; absent without a budget. */
  money?: ProjectEarnedValueMoney
}

/**
 * Budget against actual report of one Project, with earned value figures.
 *
 * Returned by `GET /api/teams/:teamId/projects/:projectId/budget-report` to Project managers
 * only, because it totals every member's time and confidential cost on the Project.
 */
export type ProjectBudgetReport = {
  /** Team that owns the Project. */
  teamId: string
  /** Project the report covers. */
  projectId: string
  /** First local date of the report. */
  from: string
  /** Last local date of the report. */
  to: string
  /** IANA timezone of the local dates. */
  timeZone: string
  /** Calendar bucket of `points`. */
  interval: ProjectBudgetReportInterval
  /**
   * Local date the earned value figures and actual totals are measured at: today clamped to
   * `from`..`to`. Before `from` it is `from` and no actuals are counted yet.
   */
  asOf: string
  /** Project budget, or `null` when none is set. */
  budget: TimeBudget | null
  /** Active schedule baseline, or `null` when none is captured. */
  baseline: ProjectBudgetReportBaseline | null
  /** Actual minutes recorded on the Project from `from` through `asOf`. */
  actualMinutes: number
  /** Of `actualMinutes`, the minutes of entries without a cost (no rate). */
  uncostedMinutes: number
  /** Cost of the time recorded from `from` through `asOf`, keyed by ISO currency; expenses are apart. */
  actualCostByCurrency: Readonly<Record<string, number>>
  /**
   * Approved Project expenses dated from `from` through `asOf`, keyed by ISO currency (ADR 0104).
   * The budget currency's amount is part of the actual cost; other currencies are not converted.
   */
  approvedExpenseByCurrency: Readonly<Record<string, number>>
  /** Project expenses dated from `from` through `asOf` that wait for a decision, keyed by ISO currency. */
  pendingExpenseByCurrency: Readonly<Record<string, number>>
  /**
   * Agent Run cost of the Project in US dollars; absent unless the Workspace counts it (ADR 0119), the
   * report has a budget, and the deployment has the Software factory.
   */
  agentCost?: ProjectBudgetAgentCost
  /**
   * Time cost plus approved expenses, plus Agent Run cost when `agentCost.status` is `included`,
   * in the budget currency as a percentage of the budget; absent without a budget.
   */
  budgetConsumedPercent?: number
  /** Actual minutes as a percentage of the baseline effort; absent without baseline effort. */
  effortConsumedPercent?: number
  /** Earned value figures, or `null` without a baseline that plans any effort. */
  earnedValue: ProjectEarnedValueMetrics | null
  /** Cumulative series, one point per bucket from `from` to `to`. */
  points: ProjectBudgetReportPoint[]
}
