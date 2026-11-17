import type {
  ArchivedPlanningEntitySummary,
  PlanningEntity,
  PlanningRestoreSummary,
} from '@mukuroji/contracts'

/** Outcome of one restore shown next to the archived plans. */
export type PlanningRestoreResultView = {
  /** Restored entity ID; also the target of "restore the rest". */
  entityId: string
  /** Entity title at restore time. */
  title: string
  /** Reference counts returned by the restore API. */
  summary: PlanningRestoreSummary
}

/**
 * Lists the archived plans the caller can restore, in display order.
 *
 * Most archived entities leave the live graph and only the archive list API returns them. Some stay
 * in the snapshot with `archivedAt` (an entity with live children, or an Initiative with an update
 * target), so those come from the snapshot first.
 *
 * @param snapshotEntities - Entities of the current snapshot, archived ones included.
 * @param listed - Entities the archive list API returned so far, in server order.
 * @param canManageEntity - Whether the caller manages an entity's scope; omitted allows all.
 * @returns Restorable archived entities without duplicates.
 */
export function selectRestorablePlanningEntities(
  snapshotEntities: readonly PlanningEntity[],
  listed: readonly ArchivedPlanningEntitySummary[],
  canManageEntity?: (entity: PlanningEntity) => boolean,
): ArchivedPlanningEntitySummary[] {
  const live = snapshotEntities
    .filter((entity) => entity.archivedAt !== undefined && (canManageEntity?.(entity) ?? true))
    .map((entity): ArchivedPlanningEntitySummary => ({
      id: entity.id,
      type: entity.type,
      title: entity.title,
      ...(entity.parentId === undefined ? {} : { parentId: entity.parentId }),
      ...(entity.teamId === undefined ? {} : { teamId: entity.teamId }),
      ...(entity.projectId === undefined ? {} : { projectId: entity.projectId }),
      ownerMemberKey: entity.ownerMemberKey,
      archivedAt: entity.archivedAt ?? '',
    }))
    .sort((first, second) => second.archivedAt.localeCompare(first.archivedAt))
  const liveIds = new Set(live.map((entity) => entity.id))
  return [...live, ...listed.filter((entity) => !liveIds.has(entity.id))]
}

/**
 * Returns whether restoring the same entity again may bring back more references.
 *
 * @param summary - Counts returned by the latest restore.
 * @returns True when references are still waiting in the archive.
 */
export function hasPendingPlanningRestore(summary: PlanningRestoreSummary) {
  return summary.pendingReferenceCount > 0
}

/**
 * Records a successful restore among the outcomes shown next to the archived plans.
 *
 * A restored entity is no longer listed as archived, so an earlier outcome with references still
 * in the archive is the only way back to them and stays until its own restore finishes them.
 *
 * @param results - Outcomes shown so far, newest first.
 * @param next - Outcome of the restore that just succeeded.
 * @returns The new outcome first, then earlier outcomes of other entities that still have pending references.
 */
export function recordPlanningRestoreResult(
  results: readonly PlanningRestoreResultView[],
  next: PlanningRestoreResultView,
): PlanningRestoreResultView[] {
  return [
    next,
    ...results.filter((result) =>
      result.entityId !== next.entityId && hasPendingPlanningRestore(result.summary)
    ),
  ]
}
