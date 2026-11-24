import type {
  ProjectBudgetReport,
  ProjectBudgetReportInterval,
  ProjectBudgetReportPoint,
  ProjectEarnedValueMetrics,
  ProjectEarnedValueMoney,
  ProjectScheduleBaseline,
  TimeBudget,
} from '@mukuroji/contracts'

/** Current state of one Work Item that earned value reads. */
export type ProjectBudgetWorkItemProgress = {
  /** Whether the Work Item was canceled, which removes its baseline effort from every value. */
  canceled: boolean
  /** Progress from 0 to 100 under the Team progress mode. */
  progressPercent: number
}

/** One recorded time entry of the Project. */
export type ProjectBudgetTimeEntry = {
  /** Local date the entry starts on in the report timezone. */
  localDate: string
  /** Recorded minutes. */
  durationMinutes: number
  /** ISO currency of the cost. */
  currency: string
  /** Cost in minor units; absent for an entry without a rate. */
  actualCostMinor?: number
}

/** Everything the Project budget report is calculated from. */
export type ProjectBudgetReportInput = {
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
  /** Calendar bucket of the series. */
  interval: ProjectBudgetReportInterval
  /** Today's local date in the report timezone. */
  today: string
  /** Project budget, or `null` without one. */
  budget: TimeBudget | null
  /** Active schedule baseline with every entry, or `null` without one. */
  baseline: ProjectScheduleBaseline | null
  /** Current progress of Work Items keyed by ID; a missing Work Item has earned nothing. */
  workItems: ReadonlyMap<string, ProjectBudgetWorkItemProgress>
  /** Time entries recorded on the Project. Entries outside `from`..`asOf` are ignored. */
  entries: readonly ProjectBudgetTimeEntry[]
}

/** One baseline Work Item that is planned on the calendar. */
type PlannedEffort = {
  /** First planned local date. */
  startDate: string
  /** Last planned local date. */
  endDate: string
  /** Planned minutes spread evenly over the dates. */
  minutes: number
}

/** Milliseconds in one UTC day. */
const DAY_MS = 86_400_000

/**
 * Calculates the budget against actual report and the earned value figures of one Project.
 *
 * Planned value spreads each baseline Work Item's planned effort evenly over the calendar days
 * from its planned start to its planned end; a Work Item with only an end date plans all of it on
 * that date, and one without an end date plans none. Earned value is each baseline Work Item's
 * planned effort times its current progress. Canceled Work Items leave every value. Amounts are
 * the effort figures times the budget amount per baseline minute, and actual cost counts only the
 * entries in the budget currency.
 *
 * @param input - Report inputs.
 * @returns The report.
 */
export function createProjectBudgetReport(input: ProjectBudgetReportInput): ProjectBudgetReport {
  const asOf = input.today < input.to ? (input.today < input.from ? input.from : input.today) : input.to
  const measured = input.today >= input.from
  const planned: PlannedEffort[] = []
  let budgetAtCompletionMinutes = 0
  let earnedValueMinutes = 0
  let unscheduledEffortMinutes = 0
  let canceledEffortMinutes = 0
  for (const entry of input.baseline?.entries ?? []) {
    const minutes = entry.plannedEffortMinutes ?? 0
    if (minutes <= 0) continue
    const workItem = input.workItems.get(entry.workItemId)
    if (workItem?.canceled) {
      canceledEffortMinutes += minutes
      continue
    }
    budgetAtCompletionMinutes += minutes
    earnedValueMinutes += (minutes * (workItem?.progressPercent ?? 0)) / 100
    if (entry.endDate === undefined) {
      unscheduledEffortMinutes += minutes
      continue
    }
    const startDate = entry.startDate !== undefined && entry.startDate <= entry.endDate ? entry.startDate : entry.endDate
    planned.push({ startDate, endDate: entry.endDate, minutes })
  }

  const currency = input.budget?.currency
  const minorPerMinute = input.budget && budgetAtCompletionMinutes > 0
    ? input.budget.amountMinor / budgetAtCompletionMinutes
    : undefined
  const actualByDate = new Map<string, { minutes: number; costMinor: number }>()
  const actualCostByCurrency: Record<string, number> = {}
  let actualMinutes = 0
  let uncostedMinutes = 0
  for (const entry of input.entries) {
    if (!measured || entry.localDate < input.from || entry.localDate > asOf) continue
    actualMinutes += entry.durationMinutes
    if (entry.actualCostMinor === undefined) uncostedMinutes += entry.durationMinutes
    else actualCostByCurrency[entry.currency] = (actualCostByCurrency[entry.currency] ?? 0) + entry.actualCostMinor
    const day = actualByDate.get(entry.localDate) ?? { minutes: 0, costMinor: 0 }
    day.minutes += entry.durationMinutes
    if (entry.actualCostMinor !== undefined && entry.currency === currency) day.costMinor += entry.actualCostMinor
    actualByDate.set(entry.localDate, day)
  }

  const points = createSeries(input, asOf, measured, planned, actualByDate, minorPerMinute)
  const plannedValueMinutes = plannedValueAt(planned, asOf)
  const actualCostMinor = currency === undefined ? 0 : actualCostByCurrency[currency] ?? 0
  return {
    teamId: input.teamId,
    projectId: input.projectId,
    from: input.from,
    to: input.to,
    timeZone: input.timeZone,
    interval: input.interval,
    asOf,
    budget: input.budget,
    baseline: input.baseline
      ? {
          ...(input.baseline.id === undefined ? {} : { id: input.baseline.id }),
          ...(input.baseline.name === undefined ? {} : { name: input.baseline.name }),
          capturedAt: input.baseline.capturedAt,
          entryCount: input.baseline.entries.length,
          unscheduledEffortMinutes,
          canceledEffortMinutes,
        }
      : null,
    actualMinutes,
    uncostedMinutes,
    actualCostByCurrency,
    ...(input.budget && input.budget.amountMinor > 0
      ? { budgetConsumedPercent: roundRatio((actualCostMinor * 100) / input.budget.amountMinor) }
      : {}),
    ...(budgetAtCompletionMinutes > 0
      ? { effortConsumedPercent: roundRatio((actualMinutes * 100) / budgetAtCompletionMinutes) }
      : {}),
    earnedValue: budgetAtCompletionMinutes > 0
      ? createEarnedValue(
          budgetAtCompletionMinutes,
          plannedValueMinutes,
          earnedValueMinutes,
          actualMinutes,
          input.budget,
          minorPerMinute,
          actualCostMinor,
        )
      : null,
    points,
  }
}

/**
 * Builds the earned value figures in minutes and, with a budget, in money.
 *
 * @param bac - Budget at completion in minutes.
 * @param pv - Planned value in minutes.
 * @param ev - Earned value in minutes.
 * @param ac - Actual minutes.
 * @param budget - Project budget, or `null`.
 * @param minorPerMinute - Budget amount per baseline minute, when a budget exists.
 * @param actualCostMinor - Actual cost in the budget currency.
 * @returns The figures.
 */
function createEarnedValue(
  bac: number,
  pv: number,
  ev: number,
  ac: number,
  budget: TimeBudget | null,
  minorPerMinute: number | undefined,
  actualCostMinor: number,
): ProjectEarnedValueMetrics {
  // Work logged with nothing earned yet is a CPI of 0; the estimates stay open until CPI is positive.
  const cpi = ac > 0 ? ev / ac : undefined
  const eac = cpi === undefined || cpi === 0 ? undefined : bac / cpi
  const metrics: ProjectEarnedValueMetrics = {
    budgetAtCompletionMinutes: Math.round(bac),
    plannedValueMinutes: Math.round(pv),
    earnedValueMinutes: Math.round(ev),
    actualMinutes: ac,
    scheduleVarianceMinutes: Math.round(ev - pv),
    costVarianceMinutes: Math.round(ev - ac),
    ...(pv > 0 ? { schedulePerformanceIndex: roundIndex(ev / pv) } : {}),
    ...(cpi === undefined ? {} : { costPerformanceIndex: roundIndex(cpi) }),
    ...(eac === undefined
      ? {}
      : {
          estimateAtCompletionMinutes: Math.round(eac),
          estimateToCompleteMinutes: Math.round(eac - ac),
          varianceAtCompletionMinutes: Math.round(bac - eac),
        }),
  }
  if (!budget || minorPerMinute === undefined) return metrics
  const pvMinor = pv * minorPerMinute
  const evMinor = ev * minorPerMinute
  const moneyCpi = actualCostMinor > 0 ? evMinor / actualCostMinor : undefined
  const eacMinor = moneyCpi === undefined || moneyCpi === 0 ? undefined : budget.amountMinor / moneyCpi
  const money: ProjectEarnedValueMoney = {
    currency: budget.currency,
    budgetAtCompletionMinor: budget.amountMinor,
    plannedValueMinor: Math.round(pvMinor),
    earnedValueMinor: Math.round(evMinor),
    actualCostMinor,
    scheduleVarianceMinor: Math.round(evMinor - pvMinor),
    costVarianceMinor: Math.round(evMinor - actualCostMinor),
    ...(moneyCpi === undefined ? {} : { costPerformanceIndex: roundIndex(moneyCpi) }),
    ...(eacMinor === undefined
      ? {}
      : {
          estimateAtCompletionMinor: Math.round(eacMinor),
          estimateToCompleteMinor: Math.round(eacMinor - actualCostMinor),
          varianceAtCompletionMinor: Math.round(budget.amountMinor - eacMinor),
        }),
  }
  return { ...metrics, money }
}

/**
 * Builds the cumulative series from the report start to its end.
 *
 * @param input - Report inputs.
 * @param asOf - Local date actuals are measured through.
 * @param measured - Whether the report has started, so actual values exist.
 * @param planned - Baseline effort placed on the calendar.
 * @param actualByDate - Actual minutes and budget-currency cost per local date.
 * @param minorPerMinute - Budget amount per baseline minute, when a budget exists.
 * @returns One point per bucket.
 */
function createSeries(
  input: ProjectBudgetReportInput,
  asOf: string,
  measured: boolean,
  planned: readonly PlannedEffort[],
  actualByDate: ReadonlyMap<string, { minutes: number; costMinor: number }>,
  minorPerMinute: number | undefined,
): ProjectBudgetReportPoint[] {
  const dailyActual = [...actualByDate.entries()].sort(([left], [right]) => left.localeCompare(right))
  const points: ProjectBudgetReportPoint[] = []
  let cursor = 0
  let cumulativeMinutes = 0
  let cumulativeCost = 0
  for (const bucket of listBuckets(input.from, input.to, input.interval)) {
    const actualThrough = bucket.endDate < asOf ? bucket.endDate : asOf
    for (let next = dailyActual[cursor]; next !== undefined && next[0] <= actualThrough; next = dailyActual[cursor]) {
      cumulativeMinutes += next[1].minutes
      cumulativeCost += next[1].costMinor
      cursor += 1
    }
    const pv = plannedValueAt(planned, bucket.endDate)
    const hasActual = measured && bucket.date <= asOf
    points.push({
      date: bucket.date,
      endDate: bucket.endDate,
      plannedValueMinutes: Math.round(pv),
      ...(minorPerMinute === undefined ? {} : { plannedValueMinor: Math.round(pv * minorPerMinute) }),
      ...(hasActual ? { actualMinutes: cumulativeMinutes } : {}),
      ...(hasActual && input.budget ? { actualCostMinor: cumulativeCost } : {}),
    })
  }
  return points
}

/**
 * Lists the day or Monday-based week buckets between two local dates.
 *
 * @param from - First local date.
 * @param to - Last local date.
 * @param interval - Bucket size.
 * @returns Buckets clipped to the range.
 */
function listBuckets(from: string, to: string, interval: ProjectBudgetReportInterval): Array<{ date: string; endDate: string }> {
  const buckets: Array<{ date: string; endDate: string }> = []
  let date = from
  while (date <= to) {
    const end = interval === 'day' ? date : addDays(date, 6 - ((dayOfWeek(date) + 6) % 7))
    const endDate = end < to ? end : to
    buckets.push({ date, endDate })
    // Stop at the last bucket instead of stepping past `to`, which may be the last valid date.
    if (endDate === to) break
    date = addDays(endDate, 1)
  }
  return buckets
}

/**
 * Sums the baseline effort planned to be done by the end of a local date.
 *
 * @param planned - Baseline effort placed on the calendar.
 * @param date - Local date.
 * @returns Planned minutes, not rounded.
 */
function plannedValueAt(planned: readonly PlannedEffort[], date: string): number {
  let total = 0
  for (const item of planned) {
    if (date < item.startDate) continue
    if (date >= item.endDate) {
      total += item.minutes
      continue
    }
    const days = daysBetween(item.startDate, item.endDate) + 1
    total += (item.minutes * (daysBetween(item.startDate, date) + 1)) / days
  }
  return total
}

/**
 * Adds calendar days to a local date.
 *
 * @param date - `YYYY-MM-DD`.
 * @param days - Days to add.
 * @returns The shifted date.
 */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

/**
 * Counts calendar days from one local date to another.
 *
 * @param from - Earlier date.
 * @param to - Later date.
 * @returns Whole days between them.
 */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

/**
 * Reads the weekday of a local date.
 *
 * @param date - `YYYY-MM-DD`.
 * @returns 0 for Sunday through 6 for Saturday.
 */
function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

/**
 * Rounds a performance index to three decimals.
 *
 * @param value - Index.
 * @returns The rounded index.
 */
function roundIndex(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Rounds a percentage to one decimal.
 *
 * @param value - Percentage.
 * @returns The rounded percentage.
 */
function roundRatio(value: number): number {
  return Math.round(value * 10) / 10
}
