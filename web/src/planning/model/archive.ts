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
 * outcome of the same entity that still offers a continuation is kept as it is; a finished one is
 * replaced, because it offers none.
 *
 * @param results - Outcomes shown so far, newest first.
 * @param entity - Entity whose restore failed.
 * @returns The outcomes with a retry target for the entity.
 */
export function recordUncertainPlanningRestore(
  results: readonly PlanningRestoreResultView[],
  entity: Pick<PlanningRestoreResultView, 'entityId' | 'title'>,
): PlanningRestoreResultView[] {
  const existing = results.find((result) => result.entityId === entity.entityId)
  if (existing && hasPendingPlanningRestore(existing)) return [...results]
  return [
    { entityId: entity.entityId, title: entity.title },
    ...results.filter((result) => result.entityId !== entity.entityId),
  ]
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

/** Browser storage operations the unfinished restore list needs. */
export type PlanningRestoreResultStorage = Pick<
  Storage,
  'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'
>

/** Storage key prefix of the unfinished restores; each entity of a member has its own key. */
const pendingRestoreStoragePrefix = 'mukuroji.planning.pendingRestore:'

/**
 * Returns the storage key prefix of a Workspace member's unfinished restores.
 *
 * @param scope - Workspace member the outcomes belong to.
 * @returns The prefix every key of that member starts with.
 */
function pendingRestoreScopePrefix(scope: string) {
  return `${pendingRestoreStoragePrefix}${encodeURIComponent(scope)}:`
}

/** Count fields of a stored restore summary. */
const restoreSummaryCountKeys = [
  'restoredLinkCount',
  'droppedLinkCount',
  'restoredDependencyCount',
  'retainedDependencyCount',
  'droppedDependencyCount',
  'pendingReferenceCount',
] as const satisfies readonly (keyof PlanningRestoreSummary)[]

/**
 * Returns whether a stored value is a restore summary.
 *
 * @param value - Parsed stored value.
 * @returns True when every count is a non-negative safe integer.
 */
function isStoredPlanningRestoreSummary(value: unknown): value is PlanningRestoreSummary {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return restoreSummaryCountKeys.every((key) => {
    const count = record[key]
    return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
  })
}

/**
 * Returns whether a stored value is a restore outcome.
 *
 * @param value - The `result` field of a stored entry.
 * @returns True when the entity ID and title are strings and the summary, if any, is valid.
 */
function isStoredPlanningRestoreResult(value: unknown): value is PlanningRestoreResultView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record.entityId === 'string' &&
    record.entityId.length > 0 &&
    typeof record.title === 'string' &&
    (record.summary === undefined || isStoredPlanningRestoreSummary(record.summary))
}

/** One unfinished restore as saved, with when it was saved for newest-first order. */
type StoredPlanningRestoreResult = {
  /** The saved outcome. */
  result: PlanningRestoreResultView
  /** Milliseconds since the epoch when the outcome was saved. */
  savedAt: number
}

/**
 * Reads one saved unfinished restore.
 *
 * @param text - Stored JSON text.
 * @returns The saved outcome, or `undefined` when the text is not a pending outcome.
 */
function readStoredPlanningRestoreResult(text: string | null): StoredPlanningRestoreResult | undefined {
  if (!text) return undefined
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  const savedAt = record.savedAt
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined
  if (!isStoredPlanningRestoreResult(record.result) || !hasPendingPlanningRestore(record.result)) {
    return undefined
  }
  const { entityId, summary, title } = record.result
  return { result: { entityId, title, ...(summary === undefined ? {} : { summary }) }, savedAt }
}

/**
 * Reads the unfinished restores saved for a Workspace member.
 *
 * A restored entity leaves the archived list, so these outcomes are the way back to references
 * still in the archive after a reload or a visit to another page.
 *
 * @param storage - Browser storage; unavailable storage reads as empty.
 * @param scope - Workspace member the outcomes belong to.
 * @returns The saved outcomes that still have pending references, newest first.
 */
export function readStoredPlanningRestoreResults(
  storage: PlanningRestoreResultStorage | undefined,
  scope: string,
): PlanningRestoreResultView[] {
  if (!storage) return []
  const prefix = pendingRestoreScopePrefix(scope)
  const saved: StoredPlanningRestoreResult[] = []
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key === null || !key.startsWith(prefix)) continue
      try {
        const entry = readStoredPlanningRestoreResult(storage.getItem(key))
        // The key names the entity, so an entry copied under another key is ignored.
        if (entry && key === `${prefix}${encodeURIComponent(entry.result.entityId)}`) saved.push(entry)
      } catch {
        // One unreadable entry does not hide the others.
      }
    }
  } catch {
    return []
  }
  return saved
    .sort((first, second) =>
      second.savedAt - first.savedAt || first.result.entityId.localeCompare(second.result.entityId)
    )
    .map((entry) => entry.result)
}

/**
 * Saves or removes one entity's unfinished restore.
 *
 * Each entity has its own key, so tabs of the same member that change different entities never
 * overwrite each other.
 *
 * @param storage - Browser storage; a failed write is ignored.
 * @param scope - Workspace member the outcome belongs to.
 * @param entityId - Entity whose outcome changes.
 * @param result - The entity's outcome now; a finished or missing one removes the saved entry.
 * @param savedAt - When the outcome is saved, for newest-first order.
 */
export function writeStoredPlanningRestoreResult(
  storage: PlanningRestoreResultStorage | undefined,
  scope: string,
  entityId: string,
  result: PlanningRestoreResultView | undefined,
  savedAt = Date.now(),
) {
  const key = `${pendingRestoreScopePrefix(scope)}${encodeURIComponent(entityId)}`
  try {
    if (result === undefined || result.entityId !== entityId || !hasPendingPlanningRestore(result)) {
      storage?.removeItem(key)
    } else {
      storage?.setItem(key, JSON.stringify({ result, savedAt } satisfies StoredPlanningRestoreResult))
    }
  } catch {
    // Storage may be full or disabled; the outcomes still show until the page is left.
  }
}

/**
 * Applies one entity's restore outcome change to the saved unfinished restores.
 *
 * The change is computed from what storage holds now and only that entity's entry is written, so
 * an unfinished restore that another tab of the same member saved is kept.
 *
 * @param storage - Browser storage; unavailable storage is left alone.
 * @param scope - Workspace member the outcomes belong to.
 * @param entityId - Entity the change is about.
 * @param update - The same outcome change the page applies to its own outcomes.
 */
export function updateStoredPlanningRestoreResults(
  storage: PlanningRestoreResultStorage | undefined,
  scope: string,
  entityId: string,
  update: (results: readonly PlanningRestoreResultView[]) => readonly PlanningRestoreResultView[],
) {
  const next = update(readStoredPlanningRestoreResults(storage, scope))
    .find((result) => result.entityId === entityId)
  writeStoredPlanningRestoreResult(storage, scope, entityId, next)
}

/**
 * Removes the outcome of an entity that no longer exists, so it stops offering a restore.
 *
 * @param results - Outcomes shown so far, newest first.
 * @param entityId - Entity the server no longer has.
 * @returns The outcomes without that entity.
 */
export function dropPlanningRestoreResult(
  results: readonly PlanningRestoreResultView[],
  entityId: string,
): PlanningRestoreResultView[] {
  return results.filter((result) => result.entityId !== entityId)
}
