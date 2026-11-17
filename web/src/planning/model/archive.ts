import type {
  ArchivedPlanningEntitySummary,
  PlanningEntity,
  PlanningRestoreSummary,
} from '@mukuroji/contracts'

/** Data and callbacks the archived plans panel needs. */
export type PlanningArchiveController = {
  /** Restorable archived entities in display order. */
  entities: readonly ArchivedPlanningEntitySummary[]
  /** Whether the archive list has another page. */
  hasMore: boolean
  /** Whether the first page is loading. */
  isLoading: boolean
  /** Whether a further page is loading. */
  isLoadingMore: boolean
  /** List load error message. */
  errorMessage?: string
  /** Entity whose restore request is running. */
  restoringEntityId?: string
  /** Restore outcomes, newest first; earlier ones stay while references remain in the archive. */
  results: readonly PlanningRestoreResultView[]
  /** Starts loading the list when the panel opens. */
  onOpen: () => void
  /** Loads the next page. */
  onLoadMore: () => void | Promise<unknown>
  /** Reloads the list after an error. */
  onRetry: () => void
  /** Restores an entity, or continues a restore that left references behind. */
  onRestore: (entity: Pick<ArchivedPlanningEntitySummary, 'id' | 'title'>) => void | Promise<void>
}

/** Outcome of one restore shown next to the archived plans. */
export type PlanningRestoreResultView = {
  /** Restored entity ID; also the target of "restore the rest". */
  entityId: string
  /** Entity title at restore time. */
  title: string
  /**
   * Reference counts returned by the restore API; omitted when the request failed after the
   * restore may have committed, so whether references remain is unknown.
   */
  summary?: PlanningRestoreSummary
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
 * @param result - Outcome of the latest restore of the entity.
 * @returns True when references are still waiting in the archive, or when that is unknown.
 */
export function hasPendingPlanningRestore(result: PlanningRestoreResultView) {
  return result.summary === undefined || result.summary.pendingReferenceCount > 0
}

/**
 * Records a restore request that failed without a definite answer from the server.
 *
 * The first revision may have restored the entity before the failure, which removes it from the
 * archived list; an outcome with an unknown summary keeps a way to restore it again. An existing
 * outcome of the same entity is kept as it is.
 *
 * @param results - Outcomes shown so far, newest first.
 * @param entity - Entity whose restore failed.
 * @returns The outcomes with a retry target for the entity.
 */
export function recordUncertainPlanningRestore(
  results: readonly PlanningRestoreResultView[],
  entity: Pick<PlanningRestoreResultView, 'entityId' | 'title'>,
): PlanningRestoreResultView[] {
  if (results.some((result) => result.entityId === entity.entityId)) return [...results]
  return [{ entityId: entity.entityId, title: entity.title }, ...results]
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
      result.entityId !== next.entityId && hasPendingPlanningRestore(result)
    ),
  ]
}
