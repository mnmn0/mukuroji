import type { SearchEntityType } from '@mukuroji/contracts'

/**
 * Entity types that the Workspace search index never contains.
 *
 * `file` stays in the shared contract for compatibility, but no writer projects
 * files into the search index, so selecting it always returns no results.
 */
const unindexedSearchEntityTypes: readonly SearchEntityType[] = ['file']

/**
 * Lists the entity type filters to offer, hiding unindexed types unless a saved
 * URL, view, or AI draft already selected them so the user can still clear them.
 *
 * @param entityTypes - Every entity type the filter can express.
 * @param selected - Entity types currently selected in the filter.
 * @returns The entity types to render as filter options, in their original order.
 */
export function listOfferedSearchEntityTypes<T extends SearchEntityType>(
  entityTypes: readonly T[],
  selected: readonly SearchEntityType[] | undefined,
): T[] {
  return entityTypes.filter((type) =>
    !unindexedSearchEntityTypes.includes(type) || (selected?.includes(type) ?? false)
  )
}
