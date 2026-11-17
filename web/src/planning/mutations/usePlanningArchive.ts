import type {
  ArchivedPlanningEntitySummary,
  PlanningEntity,
  PlanningRestoreSummary,
  PlanningSnapshot,
} from '@mukuroji/contracts'
import { useState } from 'react'
import type { MutationRequestContext } from '../../shared/api/mutationHeaders'
import { PlanningApiError, restorePlanningEntity } from '../api'
import {
  recordPlanningRestoreResult,
  recordUncertainPlanningRestore,
  selectRestorablePlanningEntities,
  type PlanningArchiveController,
  type PlanningRestoreResultView,
} from '../model/archive'
import { usePlanningArchivedEntities } from '../queries/usePlanningArchivedEntities'

/**
 * Runs one Planning mutation through the page's error reporting and snapshot cache update.
 *
 * It must reject after reporting a failure, so the archive can tell a failed restore from a
 * successful one.
 */
export type PlanningArchiveMutationRunner = (
  key: string,
  payload: unknown,
  request: (context: MutationRequestContext) => Promise<PlanningSnapshot>,
) => Promise<void>

/** Dependencies of the archived plans list and its restore action. */
export type UsePlanningArchiveOptions = {
  /** Planning API access token. */
  accessToken?: string
  /** Whether the caller may restore archived plans at all; the list loads only then. */
  canRestore: boolean
  /** Latest authoritative Planning snapshot. */
  snapshot?: PlanningSnapshot
  /** Whether the caller manages an entity's scope. */
  canManageEntity: (entity: PlanningEntity) => boolean
  /** Message shown when the archived list cannot be loaded. */
  listErrorMessage: string
  /** Runs the restore request; see {@link PlanningArchiveMutationRunner}. */
  runMutation: PlanningArchiveMutationRunner
  /** Reloads the Planning snapshot after a restore whose outcome is unknown. */
  revalidatePlanning: () => Promise<unknown>
}

/** Archived plans state and actions for the Planning page. */
export type UsePlanningArchiveResult = {
  /** Panel controller; omitted when the caller cannot restore or no snapshot is loaded. */
  controller?: PlanningArchiveController
  /** Error of the archived list request, for session redirects. */
  error: unknown
  /** Reloads the archived list, for example after archiving an entity. */
  revalidate: () => Promise<unknown>
}

/**
 * Returns whether a failed restore request may still have committed on the server.
 *
 * A Planning API error below 500 is a definite rejection. A server error, an unreadable response
 * or a network failure can follow a committed restore.
 *
 * @param error - Rejection of the restore request.
 * @returns True when the restore may have committed.
 */
function isUncertainPlanningRestoreFailure(error: unknown) {
  return !(error instanceof PlanningApiError && error.status < 500)
}

/**
 * Loads the archived plans the caller can restore and runs restores, keeping each outcome until
 * the references it left in the archive are back.
 *
 * @param options - Access token, permissions, snapshot, messages and the page's mutation runner.
 * @returns The panel controller, the list error and a list reload.
 */
export function usePlanningArchive({
  accessToken,
  canManageEntity,
  canRestore,
  listErrorMessage,
  revalidatePlanning,
  runMutation,
  snapshot,
}: UsePlanningArchiveOptions): UsePlanningArchiveResult {
  const [isOpen, setIsOpen] = useState(false)
  const [restoringEntityId, setRestoringEntityId] = useState<string>()
  const [results, setResults] = useState<readonly PlanningRestoreResultView[]>([])
  const archived = usePlanningArchivedEntities(accessToken, canRestore && isOpen)

  /**
   * Restores an archived entity, or continues a restore that left references in the archive.
   *
   * @param entity - Entity to restore.
   */
  const restore = async (entity: Pick<ArchivedPlanningEntitySummary, 'id' | 'title'>) => {
    if (!snapshot || !accessToken || restoringEntityId !== undefined) return
    const expectedRevision = snapshot.revision
    const outcome: { summary?: PlanningRestoreSummary } = {}
    setRestoringEntityId(entity.id)
    try {
      await runMutation(
        `planning:entity:${entity.id}:restore`,
        expectedRevision,
        (context) => restorePlanningEntity(accessToken, entity.id, { expectedRevision }, context)
          .then((result) => {
            outcome.summary = result.restore
            return result.planning
          }),
      )
    } catch (error) {
      // The page has already reported the failure. When the restore may have committed, the entity
      // can leave the archived list, so an outcome without a summary keeps a way to retry it.
      if (isUncertainPlanningRestoreFailure(error)) {
        setResults((current) => recordUncertainPlanningRestore(
          current,
          { entityId: entity.id, title: entity.title },
        ))
        await revalidatePlanning().catch(() => undefined)
      }
    } finally {
      setRestoringEntityId(undefined)
    }
    const { summary } = outcome
    if (summary) {
      setResults((current) => recordPlanningRestoreResult(
        current,
        { entityId: entity.id, title: entity.title, summary },
      ))
    }
    await archived.mutate()
  }

  return {
    controller: canRestore && snapshot && accessToken
      ? {
          entities: selectRestorablePlanningEntities(snapshot.entities, archived.entities, canManageEntity),
          errorMessage: archived.error ? listErrorMessage : undefined,
          hasMore: archived.hasMore,
          isLoading: !isOpen || archived.isLoading,
          isLoadingMore: archived.isLoadingMore,
          onLoadMore: archived.loadMore,
          onOpen: () => setIsOpen(true),
          onRestore: restore,
          onRetry: () => void archived.mutate(),
          restoringEntityId,
          results,
        }
      : undefined,
    error: archived.error,
    revalidate: () => archived.mutate(),
  }
}
