import {
  workspaceWeekContaining,
  type PlanningCadence,
  type PlanningDateRange,
  type PlanningEntity,
  type PlanningSnapshot,
  type PlanningWorkItemLink,
  type WorkspaceWeekStartDay,
} from '@mukuroji/contracts'

/** Summary numbers of one Cycle. */
export type CycleCommitmentSummary = {
  /** Work Items linked to the Cycle. */
  committed: number
  /** Work Item capacity of the Cycle. */
  capacity: number
  /** Linked Work Items that were carried over from another Cycle. */
  carriedOver: number
}

/**
 * Counts what a Cycle holds against its capacity.
 *
 * @param cycle - Cycle entity.
 * @param links - Snapshot Work Item links.
 * @returns Committed, capacity, and carried-over counts.
 */
export function summarizeCycleCommitment(
  cycle: PlanningEntity,
  links: readonly PlanningWorkItemLink[],
): CycleCommitmentSummary {
  const cycleLinks = links.filter((link) => link.cycleId === cycle.id)
  return {
    committed: cycleLinks.length,
    capacity: cycle.capacity ?? 0,
    carriedOver: cycleLinks.filter((link) => link.carriedOverFromCycleId !== undefined).length,
  }
}

/**
 * Lists the Work Items that can join a Cycle from the backlog: open, in the Cycle's scope, and
 * not in any Cycle yet.
 *
 * @param cycle - Target Cycle.
 * @param snapshot - Planning snapshot.
 * @returns Backlog Work Items in snapshot order.
 */
export function resolveCycleBacklog(
  cycle: PlanningEntity,
  snapshot: Pick<PlanningSnapshot, 'workItemLinks' | 'workItems'>,
) {
  const cycleIdByKey = new Map(snapshot.workItemLinks.map((link) =>
    [`${link.teamId}/${link.workItemId}`, link.cycleId] as const
  ))
  return snapshot.workItems.filter((workItem) =>
    workItem.teamId === cycle.teamId &&
    (cycle.projectId === undefined || workItem.projectId === cycle.projectId) &&
    workItem.statusCategory !== 'completed' &&
    workItem.statusCategory !== 'canceled' &&
    cycleIdByKey.get(`${workItem.teamId}/${workItem.id}`) === undefined
  )
}

/** State changes a bulk Work Item submit reports to its form. */
export type CycleBatchSubmitHooks = {
  /** Called before the request starts, to lock the selection. */
  onStart: () => void
  /** Called after the request succeeds, to clear the selection that was sent. */
  onSuccess: () => void
  /** Called once the request settles, whether it succeeded or failed, to unlock the selection. */
  onSettled: () => void
}

/**
 * Sends one bulk Cycle Work Item batch, ignoring a second submit while one is in flight.
 *
 * The selection is cleared only after a success, and a failure leaves it for a retry; the caller
 * shows the failure itself.
 *
 * @param inFlight - Lock shared by the submits of one form; it is held until the request settles.
 * @param workItems - Work Items of the batch.
 * @param submit - Request that saves the batch.
 * @param hooks - State changes of the form.
 * @returns Whether this call saved the batch.
 */
export async function submitCycleWorkItemBatch<T>(
  inFlight: { current: boolean },
  workItems: T[],
  submit: (workItems: T[]) => void | Promise<void>,
  hooks: CycleBatchSubmitHooks,
): Promise<boolean> {
  if (inFlight.current || workItems.length === 0) return false
  inFlight.current = true
  hooks.onStart()
  try {
    await submit(workItems)
    hooks.onSuccess()
    return true
  } catch {
    return false
  } finally {
    inFlight.current = false
    hooks.onSettled()
  }
}

/** Milliseconds in one UTC day, used to step through date-only values. */
const CYCLE_DAY_MILLISECONDS = 86_400_000
/** Most cadence units a proposal spans, so a mistyped huge count still yields real dates. */
const MAX_PROPOSED_CYCLE_UNITS = 1_000

/**
 * Proposes the dates of a new Cycle so it lines up with the Workspace calendar.
 *
 * A weekly cadence starts on the first Workspace week start on or after today and lasts the
 * cadence's number of whole weeks; a monthly cadence starts on the first first-of-month on or
 * after today and lasts the cadence's number of whole months. Following Cycles that the cadence
 * creates start the day after, so they stay aligned too.
 *
 * @param today - Today's local `YYYY-MM-DD` date in the Workspace time zone.
 * @param cadence - Cadence chosen for the Cycle; a count below one is treated as one, and a count
 *   above {@link MAX_PROPOSED_CYCLE_UNITS} as that limit.
 * @param weekStartDay - Day the Workspace week starts on.
 * @returns The proposed inclusive start and end dates.
 */
export function proposeCycleDateRange(
  today: string,
  cadence: PlanningCadence,
  weekStartDay: WorkspaceWeekStartDay,
): PlanningDateRange {
  const count = Number.isSafeInteger(cadence.count) && cadence.count > 0
    ? Math.min(cadence.count, MAX_PROPOSED_CYCLE_UNITS)
    : 1
  if (cadence.unit === 'week') {
    const week = workspaceWeekContaining(today, weekStartDay)
    const startDate = week.from === today ? today : addCycleDays(week.to, 1)
    return { startDate, endDate: addCycleDays(startDate, count * 7 - 1) }
  }
  const year = Number(today.slice(0, 4))
  const monthIndex = Number(today.slice(5, 7)) - 1
  const startMonthIndex = today.endsWith('-01') ? monthIndex : monthIndex + 1
  return {
    startDate: formatCycleDate(Date.UTC(year, startMonthIndex, 1)),
    // Day 0 of the month after the Cycle is its last day.
    endDate: formatCycleDate(Date.UTC(year, startMonthIndex + count, 0)),
  }
}

/**
 * Moves a date-only value by whole days.
 *
 * @param date - `YYYY-MM-DD` date.
 * @param days - Days to move; may be negative.
 * @returns The moved date.
 */
function addCycleDays(date: string, days: number): string {
  return formatCycleDate(Date.parse(`${date}T00:00:00.000Z`) + days * CYCLE_DAY_MILLISECONDS)
}

/**
 * Formats a UTC-midnight epoch as a date-only value.
 *
 * @param epoch - Epoch milliseconds at UTC midnight.
 * @returns The `YYYY-MM-DD` date.
 */
function formatCycleDate(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10)
}
