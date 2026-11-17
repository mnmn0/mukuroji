import type {
  ArchivedPlanningEntitySummary,
  PlanningEntity,
  PlanningRestoreSummary,
} from '@mukuroji/contracts'

/** Outcome of the latest restore shown next to the archived plans. */
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
