import { toWorkspaceLocalDate, type ProjectExpense, type TimeBudget, type TimeEntry } from '@mukuroji/contracts'
import { splitTimeEntryByLocalDate } from '../../time-tracking'

/** Milliseconds in one UTC day. */
const DAY_MS = 86_400_000

/** Widest offset of any IANA timezone from UTC, in milliseconds. */
const MAX_TIMEZONE_OFFSET_MS = 14 * 3_600_000

/** Lower instant of the entry read of a budget without a period start. */
const OPEN_PERIOD_START = '2000-01-01T00:00:00.000Z'

/** Approved expenses of a Project within a budget period, in the budget currency. */
export type ApprovedProjectExpenseTotal = {
  /** Approved amount in the budget currency, in minor units. */
  amountMinor: number
  /** Whether an approved expense in the period is in another currency, which is not converted. */
  hasOtherCurrency: boolean
}

/**
 * Totals the approved expenses dated within a local date range in one currency (ADR 0104).
 *
 * @param expenses - Every expense of the Project.
 * @param currency - Budget currency.
 * @param from - First local date, or undefined for no lower bound.
 * @param to - Last local date.
 * @returns The approved amount in the currency and whether other currencies were left out.
 */
export function sumApprovedProjectExpenses(
  expenses: readonly ProjectExpense[],
  currency: string,
  from: string | undefined,
  to: string,
): ApprovedProjectExpenseTotal {
  let amountMinor = 0
  let hasOtherCurrency = false
  for (const expense of expenses) {
    if (expense.status !== 'approved' || (from !== undefined && expense.date < from) || expense.date > to) continue
    if (expense.currency !== currency) {
      hasOtherCurrency = true
      continue
    }
    amountMinor += expense.amountMinor
  }
  return { amountMinor, hasOtherCurrency }
}

/** Reads the consumption check needs, scoped to one Project. */
export type ProjectBudgetConsumptionPorts = {
  /** Reads the default budget of the Project. */
  getBudget(workspaceId: string, teamId: string, projectId: string): Promise<TimeBudget | undefined>
  /** Lists every time entry of the Project that starts within the UTC instants. */
  listEntries(input: {
    /** Workspace directory ID. */
    workspaceId: string
    /** Team ID. */
    teamId: string
    /** Project ID. */
    projectId: string
    /** Inclusive lower instant, ISO 8601. */
    from: string
    /** Upper instant, ISO 8601. */
    to: string
  }): Promise<readonly TimeEntry[]>
  /** Reads every expense of the Project. */
  listExpenses(workspaceId: string, teamId: string, projectId: string): Promise<readonly ProjectExpense[]>
}

/** How much of a Project budget is used up to today. */
export type ProjectBudgetConsumption = {
  /** The Project's default budget. */
  budget: TimeBudget
  /** Last local date counted: today, or the period end when the period is over. */
  asOf: string
  /** Time cost plus approved expenses in the budget currency within the period up to `asOf`. */
  actualCostMinor: number
  /** `actualCostMinor` as a percentage of the budget amount, rounded to one decimal. */
  consumedPercent: number
}

/**
 * Measures how much of a Project's default budget is used, counting the same cost as the Project
 * budget report: the cost of the time recorded on the Project plus its approved expenses, both in
 * the budget currency (ADR 0104, ADR 0105).
 *
 * The cost is counted from the budget period start, or from the first record when the budget has
 * no period, through today or the period end when it is over.
 *
 * @param scope - Workspace, Team, and Project.
 * @param timeZone - IANA timezone of the budget period and of today.
 * @param now - Current instant.
 * @param ports - Project-scoped reads.
 * @returns The consumption, or undefined for a Project without a budget or with a zero budget.
 */
export async function loadProjectBudgetConsumption(
  scope: {
    /** Workspace directory ID. */
    workspaceId: string
    /** Team that owns the Project. */
    teamId: string
    /** Project ID. */
    projectId: string
  },
  timeZone: string,
  now: Date,
  ports: ProjectBudgetConsumptionPorts,
): Promise<ProjectBudgetConsumption | undefined> {
  const { workspaceId, teamId, projectId } = scope
  const budget = await ports.getBudget(workspaceId, teamId, projectId)
  if (!budget || !(budget.amountMinor > 0)) return undefined
  const today = toWorkspaceLocalDate(now, timeZone)
  const asOf = budget.periodTo !== undefined && budget.periodTo < today ? budget.periodTo : today
  if (budget.periodFrom !== undefined && budget.periodFrom > asOf) {
    return { budget, asOf, actualCostMinor: 0, consumedPercent: 0 }
  }
  const [entries, expenses] = await Promise.all([
    ports.listEntries({
      workspaceId,
      teamId,
      projectId,
      from: budget.periodFrom === undefined
        ? OPEN_PERIOD_START
        : new Date(Date.parse(`${budget.periodFrom}T00:00:00Z`) - MAX_TIMEZONE_OFFSET_MS).toISOString(),
      to: new Date(Date.parse(`${asOf}T00:00:00Z`) + DAY_MS + MAX_TIMEZONE_OFFSET_MS).toISOString(),
    }),
    ports.listExpenses(workspaceId, teamId, projectId),
  ])
  let actualCostMinor = sumApprovedProjectExpenses(expenses, budget.currency, budget.periodFrom, asOf).amountMinor
  for (const entry of entries) {
    if (entry.projectId !== projectId || entry.currency !== budget.currency || entry.actualCostMinor === undefined) continue
    for (const segment of splitTimeEntryByLocalDate(entry, timeZone)) {
      if ((budget.periodFrom !== undefined && segment.date < budget.periodFrom) || segment.date > asOf) continue
      // Each local-date part keeps its share of the cost, as in the Project budget report.
      actualCostMinor += entry.hourlyRateMinor === undefined
        ? Math.round(entry.actualCostMinor * segment.ratio)
        : Math.round((segment.minutes / 60) * entry.hourlyRateMinor)
    }
  }
  return {
    budget,
    asOf,
    actualCostMinor,
    consumedPercent: Math.round(((actualCostMinor * 100) / budget.amountMinor) * 10) / 10,
  }
}
