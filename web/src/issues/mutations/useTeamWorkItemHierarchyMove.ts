import { useCallback, useEffect, useRef } from 'react'
import { unstable_serialize, useSWRConfig } from 'swr'
import type { Arguments } from 'swr'
import type { MutationRequestRunner } from '../../shared/api/mutationHeaders'
import { getTeamWorkItemHierarchy, replaceWorkItemParent } from '../../work-items/api'
import { createTeamWorkItemHierarchyKey } from '../../work-items/queries/useTeamWorkItemHierarchy'
import { isWorkItemRelationGraphConflict } from '../model/teamIssueDisplay'
import { createTeamIssueDetailKey } from '../queries/useWorkItems'
import { refreshMovedCacheEntry, refreshMovedHierarchyCache } from './hierarchyMoveCacheRefresh'

/** Where a hierarchy move places a Work Item. */
export type TeamWorkItemHierarchyPlacement = {
  /** Parent after the move; `null` makes the Work Item top-level. */
  parentWorkItemId: string | null
  /** Sibling order rank after the move. */
  hierarchyRank: string
}

/** Inputs of {@link useTeamWorkItemHierarchyMove}. */
export type TeamWorkItemHierarchyMoveOptions = {
  /** Access token of the signed-in person; moves are refused without one. */
  accessToken: string | undefined
  /** Team whose outline the page shows. */
  teamId: string
  /** Relation graph revision of the hierarchy the move was planned on. */
  graphRevision: number | undefined
  /** Key of the Team Work Item list the page reads now. */
  issuesKey: Arguments
  /** Key of the Work Item detail the page reads now. */
  detailKey: Arguments
  /** Records an expired or revoked session before passing the failure on. */
  guardEnterpriseSession: <Result>(request: Promise<Result>) => Promise<Result>
  /** Shares retries of the same move. */
  mutationRequestRunner: MutationRequestRunner
  /** Message shown when the hierarchy changed since the move was planned. */
  conflictMessage: string
}

/**
 * Saves outline moves and refreshes every cache entry a move changes.
 *
 * The moved Team's hierarchy is read again and written to the cache; the Work Item list, the
 * open detail, and the moved Work Item's own detail are revalidated, or cleared when the page no
 * longer reads them, so none of them shows the pre-move parent later.
 *
 * @param options - Page state the move depends on.
 * @returns Saves one move; rejects when it fails, with `conflictMessage` when the hierarchy changed.
 */
export function useTeamWorkItemHierarchyMove({
  accessToken,
  teamId,
  graphRevision,
  issuesKey,
  detailKey,
  guardEnterpriseSession,
  mutationRequestRunner,
  conflictMessage,
}: TeamWorkItemHierarchyMoveOptions) {
  const { mutate } = useSWRConfig()
  // The list and detail cache keys the page reads now. A move that finishes after the person
  // switched Team or Work Item checks it to tell whether a key it refreshes still has a reader
  // that revalidates it.
  const shownCacheKeysRef = useRef<ReadonlySet<string>>(new Set())
  const shownIssuesCacheKey = issuesKey ? unstable_serialize(issuesKey) : ''
  const shownDetailCacheKey = detailKey ? unstable_serialize(detailKey) : ''
  useEffect(() => {
    shownCacheKeysRef.current = new Set(
      [shownIssuesCacheKey, shownDetailCacheKey].filter(Boolean),
    )
    return () => {
      shownCacheKeysRef.current = new Set()
    }
  }, [shownDetailCacheKey, shownIssuesCacheKey])

  return useCallback(async (issueId: string, placement: TeamWorkItemHierarchyPlacement) => {
    if (!accessToken || graphRevision === undefined) {
      throw new Error('A hierarchy move needs a signed-in person and a loaded hierarchy.')
    }
    // Fixed now, so the moved Team's caches are refreshed even if the person switches Team or
    // Work Item before the save returns.
    const movedHierarchyKey = createTeamWorkItemHierarchyKey(accessToken, teamId)
    // The moved Work Item's own detail may be read later even if another one is open now.
    const movedItemDetailKey = createTeamIssueDetailKey(accessToken, teamId, issueId)
    const readShownCacheKeys = () => shownCacheKeysRef.current
    const refreshMovedHierarchy = () => refreshMovedHierarchyCache(
      mutate,
      movedHierarchyKey,
      () => getTeamWorkItemHierarchy(teamId, accessToken),
    )
    try {
      await guardEnterpriseSession(mutationRequestRunner.run(
        `issue:hierarchy:move:${teamId}:${issueId}`,
        JSON.stringify([graphRevision, placement]),
        (context) => replaceWorkItemParent(
          teamId,
          issueId,
          accessToken,
          {
            parentWorkItemId: placement.parentWorkItemId,
            expectedGraphRevision: graphRevision,
            hierarchyRank: placement.hierarchyRank,
          },
          context,
        ),
      ))
    } catch (error) {
      if (isWorkItemRelationGraphConflict(error)) {
        await refreshMovedHierarchy()
        throw new Error(conflictMessage, { cause: error })
      }
      throw error
    }
    await Promise.all([
      refreshMovedHierarchy(),
      issuesKey ? refreshMovedCacheEntry(mutate, issuesKey, readShownCacheKeys) : undefined,
      detailKey ? refreshMovedCacheEntry(mutate, detailKey, readShownCacheKeys) : undefined,
      detailKey && unstable_serialize(detailKey) === unstable_serialize(movedItemDetailKey)
        ? undefined
        : refreshMovedCacheEntry(mutate, movedItemDetailKey, readShownCacheKeys),
    ])
  }, [
    accessToken,
    conflictMessage,
    detailKey,
    graphRevision,
    guardEnterpriseSession,
    issuesKey,
    mutate,
    mutationRequestRunner,
    teamId,
  ])
}
