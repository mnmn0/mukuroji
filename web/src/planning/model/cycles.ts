import type {
  PlanningEntity,
  PlanningSnapshot,
  PlanningWorkItemLink,
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
