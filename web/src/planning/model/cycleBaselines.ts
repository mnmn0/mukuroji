import {
  deriveWorkItemScheduleSlip,
  type CycleScheduleBaseline,
  type CycleScheduleBaselineEntry,
  type PlanningSnapshot,
  type PlanningWorkItemSummary,
} from '@mukuroji/contracts'

/** A Work Item that is in the Cycle now and was in the baseline. */
export type CycleBaselineSlippedItem = {
  /** Current Work Item. */
  workItem: PlanningWorkItemSummary
  /** Days its planned end moved later since the baseline. */
  endSlipDays: number
}

/** How a Cycle's scope and plan moved since one of its baselines. */
export type CycleBaselineComparison = {
  /** Work Items the baseline holds, including ones the reader cannot see. */
  committed: number
  /** Baseline Work Items the reader can see that are still in the Cycle. */
  stillIn: number
  /** Work Items in the Cycle now that the baseline did not hold. */
  added: PlanningWorkItemSummary[]
  /** Baseline Work Items the reader can see that left the Cycle; the title is absent when unknown. */
  removed: { entry: CycleScheduleBaselineEntry; title?: string }[]
  /** Baseline Work Items the reader cannot see now. */
  hidden: number
  /** Work Items whose planned end moved later, most delayed first. */
  slipped: CycleBaselineSlippedItem[]
  /** Net change of planned effort in minutes across Work Items both sides estimate. */
  effortDeltaMinutes: number
}

/**
 * Compares a Cycle baseline with the Cycle's current Work Items in the reader's snapshot.
 *
 * @param baseline - Baseline with the entries the reader may see.
 * @param cycleId - Cycle the baseline belongs to.
 * @param snapshot - Current Planning snapshot.
 * @returns Scope change, end slips, and effort change since the baseline.
 */
export function compareCycleBaseline(
  baseline: CycleScheduleBaseline,
  cycleId: string,
  snapshot: Pick<PlanningSnapshot, 'workItemLinks' | 'workItems'>,
): CycleBaselineComparison {
  const workItems = new Map(snapshot.workItems.map((workItem) => [itemKey(workItem.teamId, workItem.id), workItem]))
  const inCycle = new Set(
    snapshot.workItemLinks
      .filter((link) => link.cycleId === cycleId)
      .map((link) => itemKey(link.teamId, link.workItemId)),
  )
  const entries = new Map(baseline.entries.map((entry) => [itemKey(entry.teamId, entry.workItemId), entry]))
  const added: PlanningWorkItemSummary[] = []
  const slipped: CycleBaselineSlippedItem[] = []
  let stillIn = 0
  let effortDeltaMinutes = 0
  for (const key of inCycle) {
    const workItem = workItems.get(key)
    if (!workItem) continue
    const entry = entries.get(key)
    if (!entry) {
      added.push(workItem)
      continue
    }
    stillIn += 1
    const slip = deriveWorkItemScheduleSlip(entry, workItem.schedule)
    if (slip.endSlipDays !== undefined && slip.endSlipDays > 0) slipped.push({ workItem, endSlipDays: slip.endSlipDays })
    effortDeltaMinutes += slip.effortDeltaMinutes ?? 0
  }
  const removed = baseline.entries
    .filter((entry) => !inCycle.has(itemKey(entry.teamId, entry.workItemId)))
    .map((entry) => {
      const title = workItems.get(itemKey(entry.teamId, entry.workItemId))?.title
      return title === undefined ? { entry } : { entry, title }
    })
  slipped.sort((first, second) => second.endSlipDays - first.endSlipDays)
  return {
    committed: baseline.entryCount,
    stillIn,
    added,
    removed,
    hidden: Math.max(0, baseline.entryCount - baseline.entries.length),
    slipped,
    effortDeltaMinutes,
  }
}

/**
 * Builds the key that matches a baseline entry to a Work Item.
 *
 * @param teamId - Team that owns the Work Item.
 * @param workItemId - Work Item ID.
 * @returns A key unique per Team and Work Item.
 */
function itemKey(teamId: string, workItemId: string) {
  return JSON.stringify([teamId, workItemId])
}
