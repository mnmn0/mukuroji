/** Budget use of one active Project with a budget, as the daily schedule reads it (ADR 0105). */
export type ScheduledProjectBudgetStatus = {
  /** Team that owns the Project. */
  teamId: string
  /** Project ID. */
  projectId: string
  /** Budget amount in minor units; a changed amount is a new budget to alert on. */
  amountMinor: number
  /** Budget currency. */
  currency: string
  /** Budget period start, when the budget has one. */
  periodFrom?: string
  /** Budget period end, when the budget has one. */
  periodTo?: string
  /** Alert percentage of the budget, already resolved to the default when unset. */
  alertPercent: number
  /** Time cost plus approved expenses in the budget currency, in minor units. */
  actualCostMinor: number
  /** `actualCostMinor` as a percentage of the budget, rounded for display. */
  consumedPercent: number
  /** Lower-case member key of the charter owner, when the charter names one. */
  ownerMemberKey?: string
  /** Lower-case member keys of the Project's unarchived managers. */
  managerMemberKeys: readonly string[]
}

/**
 * Failure of a budget use read in which some Projects could not be read. It carries the statuses
 * of the Projects that were read, so their alerts still go out while the run fails (ADR 0119).
 */
export class BudgetThresholdPartialReadError extends Error {
  /** Statuses of the Projects that were read. */
  readonly statuses: readonly ScheduledProjectBudgetStatus[]
  /** First failure among the Projects that could not be read. */
  readonly firstFailure: unknown

  /**
   * Creates the error.
   *
   * @param statuses - Statuses of the Projects that were read.
   * @param failedProjects - Number of Projects that could not be read.
   * @param firstFailure - First failure.
   */
  constructor(statuses: readonly ScheduledProjectBudgetStatus[], failedProjects: number, firstFailure: unknown) {
    super(`Budget use of ${failedProjects} Project(s) could not be read.`)
    this.name = 'BudgetThresholdPartialReadError'
    this.statuses = statuses
    this.firstFailure = firstFailure
  }
}

/** Reads the budget use of a Workspace's active Projects. */
export type ScheduledBudgetThresholdReader = {
  /**
   * Lists the active Projects of a Workspace that have a budget, with their use up to now.
   *
   * @param workspaceId - Workspace to read.
   * @param now - Schedule execution instant.
   * @returns One status per Project with a budget, ordered by Team and Project.
   * @throws BudgetThresholdPartialReadError When some Projects could not be read; it holds the
   *   statuses of the others.
   */
  listProjectBudgetStatuses(workspaceId: string, now: Date): Promise<ScheduledProjectBudgetStatus[]>
}

/** One Project whose budget use reached its alert percentage. */
export type BudgetThresholdAlertCandidate = {
  /** Workspace of the Project. */
  workspaceId: string
  /** Team that owns the Project. */
  teamId: string
  /** Project ID. */
  projectId: string
  /** Alert percentage that was reached. */
  thresholdPercent: number
  /** Budget use when the schedule read it. */
  consumedPercent: number
  /** Stable identity of the budget the alert is for: period, amount, currency, and threshold. */
  budgetKey: string
  /** Managers to notify: the charter owner when they manage the Project, else every manager. */
  recipientMemberKeys: string[]
}

/**
 * Chooses the Projects whose budget use reached the alert percentage and who to tell.
 *
 * The budget figures are confidential to Project managers, so only managers are told: the
 * charter owner when they manage the Project, or every manager when the charter names no owner
 * or names one who does not manage it. A Project without managers still yields a candidate, so
 * the Automation trigger fires for it.
 *
 * @param workspaceId - Workspace of the statuses.
 * @param statuses - Budget use of the Workspace's Projects.
 * @returns One candidate per Project at or past its alert percentage.
 * @throws RangeError when a Project's figures are not safe integers.
 */
export function evaluateBudgetThresholdAlerts(
  workspaceId: string,
  statuses: readonly ScheduledProjectBudgetStatus[],
): BudgetThresholdAlertCandidate[] {
  return statuses.flatMap((status) => {
    if (!reachesAlertPercent(status)) return []
    const managers = [...new Set(status.managerMemberKeys.map((key) => key.toLowerCase()))].sort()
    const owner = status.ownerMemberKey?.toLowerCase()
    const recipientMemberKeys = owner !== undefined && managers.includes(owner) ? [owner] : managers
    return [{
      workspaceId,
      teamId: status.teamId,
      projectId: status.projectId,
      thresholdPercent: status.alertPercent,
      consumedPercent: status.consumedPercent,
      budgetKey: [
        status.periodFrom ?? '',
        status.periodTo ?? '',
        String(status.amountMinor),
        status.currency,
        String(status.alertPercent),
      ].join('|'),
      recipientMemberKeys,
    }]
  })
}

/**
 * Tells whether a Project's cost reached its alert percentage, from the exact cost rather than the
 * rounded percentage, so a use just under the threshold that rounds up to it is not alerted.
 *
 * @param status - Cost, budget amount, and alert percentage.
 * @returns True when the cost is at or past the alert percentage of the budget.
 * @throws RangeError when a figure is not a safe integer.
 */
function reachesAlertPercent(status: Pick<ScheduledProjectBudgetStatus, 'actualCostMinor' | 'amountMinor' | 'alertPercent'>) {
  const { actualCostMinor, amountMinor, alertPercent } = status
  if (![actualCostMinor, amountMinor, alertPercent].every(Number.isSafeInteger)) {
    // A total past the exact integer range cannot be compared reliably, so the check fails loudly.
    throw new RangeError('Project budget figures must be safe integers to check the alert threshold.')
  }
  // Integer products stay exact even past the range a double holds exactly.
  return BigInt(actualCostMinor) * 100n >= BigInt(alertPercent) * BigInt(amountMinor)
}
