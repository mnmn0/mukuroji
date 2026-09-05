import {
  createSearchWorkItemTypeKey,
  DEFAULT_WORK_ITEM_TYPE_ID,
  type WorkspaceSearchResult,
} from '@mukuroji/contracts'
import { resolveWorkspaceSearchResultFieldValue } from './sortResults'

/** One count bucket derived from the currently loaded permission-filtered results. */
export type LoadedSearchCountGroup = {
  /** Search result field value, omitted when the field is unavailable. */
  value?: string
  /** Number of currently loaded results in this bucket. */
  count: number
}

/** Bounded count summary for the current Search result collection. */
export type LoadedSearchCountReport = {
  /** Number of permission-filtered results currently held by the Search view. */
  loadedCount: number
  /** Whether the cursor response confirms that no additional result page remains. */
  isComplete: boolean
  /** Optional count buckets using the approved existing Search layout group. */
  groups: LoadedSearchCountGroup[]
}

/**
 * Counts only the result pages already loaded by the existing permission-aware Search API.
 *
 * @param results - Current loaded Search results.
 * @param groupBy - Existing Search layout field used for an optional breakdown.
 * @param hasMore - Whether the Search API returned a next-page cursor.
 * @returns A bounded count summary that never implies an unrequested full aggregation.
 */
export function createLoadedSearchCountReport(
  results: readonly WorkspaceSearchResult[],
  groupBy: string | undefined,
  hasMore: boolean,
): LoadedSearchCountReport {
  const counts = new Map<string | undefined, number>()

  if (groupBy) {
    for (const result of results) {
      const value = formatGroupValue(
        groupBy === 'workItemType' && result.entityType === 'work-item'
          ? resolveSearchWorkItemTypeKey(result)
          : resolveWorkspaceSearchResultFieldValue(result, groupBy),
      )
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }
  }

  return {
    groups: Array.from(counts, ([value, count]) => ({ count, value }))
      .sort((left, right) => right.count - left.count ||
        (left.value ?? '').localeCompare(right.value ?? '')),
    isComplete: !hasMore,
    loadedCount: results.length,
  }
}

/** Resolves a Work Item result to its collision-safe Team-qualified type key. */
function resolveSearchWorkItemTypeKey(result: WorkspaceSearchResult): string {
  const typeId = result.workItemTypeId ?? DEFAULT_WORK_ITEM_TYPE_ID
  return result.teamId
    ? createSearchWorkItemTypeKey(result.teamId, typeId)
    : typeId
}

/** Converts a supported built-in result field value into a compact review label. */
function formatGroupValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value || undefined
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  return undefined
}
