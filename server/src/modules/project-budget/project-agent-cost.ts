import {
  agentCostMicroUsdToCents,
  toWorkspaceLocalDate,
  type ProjectBudgetAgentCost,
  type WorkspaceAgentCostSettings,
} from '@mukuroji/contracts'

/** Most finished Agent Runs with a cost one Project budget measurement counts (ADR 0119). */
export const MAX_PROJECT_AGENT_COST_RUNS = 1_000

/** Estimated cost of one Agent Run that finished on a Work Item of the Project. */
export type ProjectAgentRunCost = {
  /** Local date the run finished on, in the budget's timezone. */
  localDate: string
  /** Estimated cost in millionths of a US dollar. */
  costMicroUsd: number
}

/** Agent Run cost of a Project as read for a budget measurement. */
export type ProjectAgentRunCosts = {
  /** Runs with a reported cost, in any order. */
  runs: readonly ProjectAgentRunCost[]
  /** True when the read stopped at its limit or a run had more usage than one read returns. */
  truncated: boolean
}

/** Agent Run cost of a Project as the store read it, before local dates are taken. */
export type ProjectAgentRunCostRead = {
  /** Runs with a reported cost. */
  runs: readonly {
    /** UTC ISO 8601 time the run finished. */
    finishedAt: string
    /** Estimated cost in millionths of a US dollar. */
    costMicroUsd: number
  }[]
  /** True when the read stopped at its limit or a run had more usage than one read returns. */
  truncated: boolean
}

/** Reads the cost of the Agent Runs that finished on given Work Items of a Team. */
export type ProjectAgentRunCostReader = (input: {
  /** Workspace directory ID. */
  workspaceId: string
  /** Team ID. */
  teamId: string
  /** Work Items the Project holds now; only their runs count. */
  workItemIds: ReadonlySet<string>
  /** Inclusive lower finish instant, ISO 8601, or undefined for no lower bound. */
  since?: string
  /** Inclusive upper finish instant, ISO 8601. */
  until: string
  /**
   * Whether a run that finished at an ISO 8601 instant counts; runs it rejects do not use up
   * `maxRuns`. The padded instant range above holds a little more than the local date range.
   */
  countsFinishedAt?: (finishedAt: string) => boolean
  /** Most runs with a cost to return before the read is marked truncated. */
  maxRuns: number
}) => Promise<ProjectAgentRunCostRead>

/**
 * Builds the finish-time test that keeps only runs whose local finish date, in the budget's time
 * zone, falls within a date range (ADR 0119).
 *
 * @param timeZone - Budget time zone.
 * @param from - First local date counted, or undefined for no lower bound.
 * @param to - Last local date counted.
 * @returns The test; an instant that cannot be read does not count.
 */
export function projectAgentRunFinishDateTest(
  timeZone: string,
  from: string | undefined,
  to: string,
): (finishedAt: string) => boolean {
  return (finishedAt) => {
    if (!Number.isFinite(Date.parse(finishedAt))) return false
    const date = toWorkspaceLocalDate(finishedAt, timeZone)
    return (from === undefined || date >= from) && date <= to
  }
}

/** Agent Run cost a Project budget measurement adds, already read. */
export type ProjectAgentCostInput = {
  /**
   * Whether the cost is added to the actual cost: only for a budget in USD, because the cost is
   * not converted to other currencies.
   */
  addToActualCost: boolean
  /** Runs and whether the read was cut. */
  costs: ProjectAgentRunCosts
}

/** Agent Run cost of a Project within a local date range. */
export type ProjectAgentCostTotal = {
  /** Cost per local date in US cents; empty when the cost is not added to the actual cost. */
  byDate: ReadonlyMap<string, number>
  /** Sum of `byDate`; zero when the cost is not added. */
  amountMinor: number
  /** Estimated cost in millionths of a US dollar of the runs in the range. */
  estimatedCostMicroUsd: number
  /** Runs in the range. */
  runCount: number
}

/**
 * Totals the Agent Run cost of a Project within a local date range (ADR 0119). Each day's cost is
 * rounded to cents once, so the cumulative series and the total add up to the same amount.
 *
 * @param input - Runs and whether they are added to the actual cost.
 * @param from - First local date counted, or undefined for no lower bound.
 * @param to - Last local date counted.
 * @returns The cost by date in cents and in total.
 */
export function sumProjectAgentCost(
  input: ProjectAgentCostInput,
  from: string | undefined,
  to: string,
): ProjectAgentCostTotal {
  const microByDate = new Map<string, number>()
  let estimatedCostMicroUsd = 0
  let runCount = 0
  for (const run of input.costs.runs) {
    if ((from !== undefined && run.localDate < from) || run.localDate > to) continue
    microByDate.set(run.localDate, (microByDate.get(run.localDate) ?? 0) + run.costMicroUsd)
    estimatedCostMicroUsd += run.costMicroUsd
    runCount += 1
  }
  const byDate = new Map<string, number>()
  let amountMinor = 0
  if (input.addToActualCost) {
    for (const [date, micro] of microByDate) {
      const cents = agentCostMicroUsdToCents(micro)
      byDate.set(date, cents)
      amountMinor += cents
    }
  }
  return { byDate, amountMinor, estimatedCostMicroUsd, runCount }
}

/**
 * Describes the Agent Run cost of a budget report.
 *
 * @param input - Runs and whether they are added to the actual cost.
 * @param total - The runs' total within the report range.
 * @returns The report's `agentCost` field.
 */
export function describeProjectAgentCost(input: ProjectAgentCostInput, total: ProjectAgentCostTotal): ProjectBudgetAgentCost {
  return input.addToActualCost
    ? {
        status: 'included',
        estimatedCostMicroUsd: total.estimatedCostMicroUsd,
        amountMinor: total.amountMinor,
        runCount: total.runCount,
        truncated: input.costs.truncated,
      }
    : {
        status: 'separate-currency',
        estimatedCostMicroUsd: total.estimatedCostMicroUsd,
        runCount: total.runCount,
        truncated: input.costs.truncated,
      }
}

/**
 * Returns whether a Workspace counts Agent Run cost in a Project budget, and whether it is added
 * to the actual cost.
 *
 * @param settings - Workspace agent cost settings, or undefined when never saved.
 * @param currency - Budget currency.
 * @returns Undefined when the Workspace does not count the cost; otherwise whether the budget is
 *   in USD, the only currency the cost is added to.
 */
export function resolveProjectAgentCostMode(
  settings: WorkspaceAgentCostSettings | undefined,
  currency: string,
): { addToActualCost: boolean } | undefined {
  if (!settings?.includeInProjectBudgets) return undefined
  return { addToActualCost: currency === 'USD' }
}

/**
 * Takes the local finish date of each run read from the store.
 *
 * @param read - Runs as read.
 * @param timeZone - IANA timezone of the budget dates.
 * @returns The runs with local dates.
 */
export function toProjectAgentRunCosts(read: ProjectAgentRunCostRead, timeZone: string): ProjectAgentRunCosts {
  return {
    runs: read.runs.map((run) => ({ localDate: toWorkspaceLocalDate(new Date(run.finishedAt), timeZone), costMicroUsd: run.costMicroUsd })),
    truncated: read.truncated,
  }
}
