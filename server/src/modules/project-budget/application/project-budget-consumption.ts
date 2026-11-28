import {
  toWorkspaceLocalDate,
  type ProjectExpense,
  type TimeBudget,
  type TimeEntry,
  type WorkspaceAgentCostSettings,
} from '@mukuroji/contracts'
import { splitTimeEntryByLocalDate } from '../../time-tracking'
import {
  MAX_PROJECT_AGENT_COST_RUNS,
  resolveProjectAgentCostRate,
  sumProjectAgentCost,
  toProjectAgentRunCosts,
  type ProjectAgentRunCostReader,
  projectAgentRunFinishDateTest,
} from '../project-agent-cost'

/** Most Team Work Item pages one Project's Agent Run cost reads to find the Project's Work Items. */
const MAX_AGENT_COST_WORK_ITEM_PAGES = 200

/** Milliseconds in one UTC day. */
const DAY_MS = 86_400_000

/** Widest offset of any IANA timezone from UTC, in milliseconds. */
const MAX_TIMEZONE_OFFSET_MS = 14 * 3_600_000

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
    /** Inclusive lower instant, ISO 8601, or undefined to read from the first entry. */
    from?: string
    /** Upper instant, ISO 8601. */
    to: string
  }): Promise<readonly TimeEntry[]>
  /** Reads every expense of the Project. */
  listExpenses(workspaceId: string, teamId: string, projectId: string): Promise<readonly ProjectExpense[]>
  /** Reads how the Workspace counts coding agent cost (ADR 0119); undefined when never saved. */
  readAgentCostSettings?(workspaceId: string): Promise<WorkspaceAgentCostSettings | undefined>
  /**
   * Reads one page of the Team's Work Items with their current Project, archived ones included;
   * needed with `listAgentRunCosts`.
   */
  listWorkItems?(workspaceId: string, teamId: string, startAfterIssueId: string | undefined): Promise<{
    /** Work Items on the page. */
    issues: readonly {
      /** Work Item ID. */
      id: string
      /** Project the Work Item belongs to now, if any. */
      assignedProjectId?: string
    }[]
    /** Cursor of the next page; absent on the last page. */
    nextStartAfterIssueId?: string
  }>
  /** Reads Agent Run cost; absent when the deployment has no Software factory. */
  listAgentRunCosts?: ProjectAgentRunCostReader
}

/** How much of a Project budget is used up to today. */
export type ProjectBudgetConsumption = {
  /** The Project's default budget. */
  budget: TimeBudget
  /** Last local date counted: today, or the period end when the period is over. */
  asOf: string
  /**
   * Time cost plus approved expenses, plus Agent Run cost when the Workspace counts it and has a
   * rate for the budget currency, in the budget currency within the period up to `asOf`.
   */
  actualCostMinor: number
  /** `actualCostMinor` as a percentage of the budget amount, rounded to one decimal. */
  consumedPercent: number
}

/**
 * Measures how much of a Project's default budget is used, counting the same cost as the Project
 * budget report: the cost of the time recorded on the Project plus its approved expenses, both in
 * the budget currency, plus the Agent Run cost when the Workspace counts it (ADR 0104, ADR 0105,
 * ADR 0119).
 *
 * The cost is counted from the budget period start, or from the first record when the budget has
 * no period, through today or the period end when it is over.
 *
 * @param scope - Workspace, Team, and Project.
 * @param timeZone - IANA timezone of the budget period and of today.
 * @param now - Current instant.
 * @param ports - Project-scoped reads.
 * @returns The consumption, or undefined for a Project without a budget or with a zero budget.
 * @throws RangeError when the cost passes the exact integer range.
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
      ...(budget.periodFrom === undefined
        ? {}
        : { from: new Date(Date.parse(`${budget.periodFrom}T00:00:00Z`) - MAX_TIMEZONE_OFFSET_MS).toISOString() }),
      to: new Date(Date.parse(`${asOf}T00:00:00Z`) + DAY_MS + MAX_TIMEZONE_OFFSET_MS).toISOString(),
    }),
    ports.listExpenses(workspaceId, teamId, projectId),
  ])
  let actualCostMinor = sumApprovedProjectExpenses(expenses, budget.currency, budget.periodFrom, asOf).amountMinor
  actualCostMinor += await loadAgentCostMinor(scope, budget, asOf, timeZone, ports)
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
  if (!Number.isSafeInteger(actualCostMinor)) {
    throw new RangeError(`Project ${projectId} cost exceeds the exact integer range.`)
  }
  return {
    budget,
    asOf,
    actualCostMinor,
    consumedPercent: Math.round(((actualCostMinor * 100) / budget.amountMinor) * 10) / 10,
  }
}

/**
 * Reads the Agent Run cost of a Project's budget period in the budget currency, the same runs the
 * budget report counts (ADR 0119): runs that finished in the period on Work Items the Project
 * holds now. A read cut at its limit counts the runs it read.
 *
 * @param scope - Workspace, Team, and Project.
 * @param budget - The Project's default budget.
 * @param asOf - Last local date counted.
 * @param timeZone - IANA timezone of the period.
 * @param ports - Project-scoped reads.
 * @returns The cost in minor units, or 0 when the Workspace does not count it or has no rate.
 * @throws Error when a Team Work Item page read does not advance.
 * @throws RangeError when the Team has more Work Item pages than one check reads.
 */
async function loadAgentCostMinor(
  scope: {
    /** Workspace directory ID. */
    workspaceId: string
    /** Team that owns the Project. */
    teamId: string
    /** Project ID. */
    projectId: string
  },
  budget: TimeBudget,
  asOf: string,
  timeZone: string,
  ports: ProjectBudgetConsumptionPorts,
): Promise<number> {
  const { listAgentRunCosts, listWorkItems, readAgentCostSettings } = ports
  if (!listAgentRunCosts || !listWorkItems || !readAgentCostSettings) return 0
  const rate = resolveProjectAgentCostRate(await readAgentCostSettings(scope.workspaceId), budget.currency)
  if (rate?.usdExchangeRate === undefined) return 0
  const workItemIds = new Set<string>()
  let startAfterIssueId: string | undefined
  let pages = 0
  do {
    pages += 1
    const page = await listWorkItems(scope.workspaceId, scope.teamId, startAfterIssueId)
    for (const issue of page.issues) {
      if (issue.assignedProjectId === scope.projectId) workItemIds.add(issue.id)
    }
    if (page.nextStartAfterIssueId !== undefined && page.nextStartAfterIssueId === startAfterIssueId) {
      throw new Error(`Team "${scope.teamId}" Work Item read did not advance.`)
    }
    startAfterIssueId = page.nextStartAfterIssueId
    if (startAfterIssueId !== undefined && pages >= MAX_AGENT_COST_WORK_ITEM_PAGES) {
      // A partial Work Item scope would silently leave runs out and could hold an alert back.
      throw new RangeError(`Team "${scope.teamId}" has more Work Item pages than one budget check reads (${MAX_AGENT_COST_WORK_ITEM_PAGES}).`)
    }
  } while (startAfterIssueId !== undefined)
  if (workItemIds.size === 0) return 0
  const read = await listAgentRunCosts({
    workspaceId: scope.workspaceId,
    teamId: scope.teamId,
    workItemIds,
    ...(budget.periodFrom === undefined
      ? {}
      : { since: new Date(Date.parse(`${budget.periodFrom}T00:00:00Z`) - MAX_TIMEZONE_OFFSET_MS).toISOString() }),
    until: new Date(Date.parse(`${asOf}T00:00:00Z`) + DAY_MS + MAX_TIMEZONE_OFFSET_MS).toISOString(),
    countsFinishedAt: projectAgentRunFinishDateTest(timeZone, budget.periodFrom, asOf),
    maxRuns: MAX_PROJECT_AGENT_COST_RUNS,
  })
  return sumProjectAgentCost(
    { usdExchangeRate: rate.usdExchangeRate, costs: toProjectAgentRunCosts(read, timeZone) },
    budget.currency,
    budget.periodFrom,
    asOf,
  ).amountMinor
}
