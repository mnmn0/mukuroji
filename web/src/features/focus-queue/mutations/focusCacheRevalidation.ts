import { TeamIssuesApiError } from '../../../issues/api/errors'
import { FocusQueueApiError } from '../api/focusQueue'

/** One Team-qualified Work Item whose cached projections may be stale. */
export type FocusAffectedWorkItem = {
  /** Team that owns the Work Item. */
  teamId: string
  /** Team-local Work Item identifier. */
  workItemId: string
}

/** Canonical projections affected by one successful or conflicted Focus mutation. */
export type FocusCacheRevalidationScope = {
  /** Whether the Workspace Planning snapshot may contain changed schedules. */
  includePlanning: boolean
  /** Projects whose Work Item lists may contain an affected item. */
  projectIds: readonly string[]
  /** Team-qualified Work Items changed directly or through schedule propagation. */
  workItems: readonly FocusAffectedWorkItem[]
}

const teamListCacheScopes: ReadonlySet<string> = new Set([
  'project-relation-candidates',
  'team-issues',
])

const workItemDetailCacheScopes: ReadonlySet<string> = new Set([
  'project-issue-detail',
  'team-issue-detail',
])

/**
 * Returns whether one loaded SWR cache key is affected by a Focus mutation.
 *
 * @param key - Unknown SWR cache key supplied by the global mutator.
 * @param scope - Team, Project, and Planning projections affected by the mutation.
 * @returns Whether the cache entry must be revalidated.
 */
export function isFocusAffectedCacheKey(
  key: unknown,
  scope: FocusCacheRevalidationScope,
): boolean {
  if (!Array.isArray(key) || typeof key[0] !== 'string') return false

  const cacheScope = key[0]
  if (cacheScope === 'workspace-work-items') return true
  if (scope.includePlanning && cacheScope === 'planning-snapshot') return true

  if (
    cacheScope === 'project-tasks' &&
    typeof key[2] === 'string'
  ) {
    return scope.projectIds.includes(key[2])
  }

  if (
    teamListCacheScopes.has(cacheScope) &&
    typeof key[2] === 'string'
  ) {
    return scope.workItems.some((item) => item.teamId === key[2])
  }

  if (
    workItemDetailCacheScopes.has(cacheScope) &&
    typeof key[2] === 'string' &&
    typeof key[3] === 'string'
  ) {
    return scope.workItems.some((item) =>
      item.teamId === key[2] && item.workItemId === key[3]
    )
  }

  return false
}

/**
 * Immediately refreshes authoritative caches after an optimistic concurrency conflict.
 *
 * Cache refresh remains best effort so the original 409 error stays available to the
 * mutation caller even when a recovery request also fails.
 *
 * @param error - Error thrown by a Focus or canonical Work Item mutation.
 * @param revalidate - Cache refresh covering the mutation's affected projection scope.
 * @returns Nothing after a 409 refresh completes or a non-conflict is ignored.
 */
export async function revalidateFocusCachesOnConflict(
  error: unknown,
  revalidate: () => Promise<unknown>,
): Promise<void> {
  if (!isFocusMutationConflict(error)) return
  await revalidate().catch(() => undefined)
}

/**
 * Returns whether a Focus action failed because its optimistic snapshot was stale.
 *
 * @param error - Unknown transport or application failure.
 * @returns Whether the failure is a typed HTTP 409 from Focus or Work Items.
 */
export function isFocusMutationConflict(error: unknown): boolean {
  return (
    error instanceof FocusQueueApiError ||
    error instanceof TeamIssuesApiError
  ) && error.status === 409
}
