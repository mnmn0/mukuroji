import type { KeyedMutator } from 'swr'

/**
 * Wraps a Work Item list mutator so that a refresh of the list also re-reads the hierarchies.
 *
 * Hierarchy roll-ups total the status, estimate, and dates of a Team's Work Items, and WBS numbers
 * follow parent links, so they go stale with the list. A call that re-reads the list, or publishes
 * a list read from the server, also re-reads the hierarchies. A call with an updater function is a
 * local optimistic edit or its rollback, so it leaves them alone; the refresh after the server
 * answers re-reads them.
 *
 * @param mutateList - Mutator of the Work Item list.
 * @param revalidateHierarchies - Re-reads the hierarchies shown beside the list.
 * @returns A mutator that behaves like `mutateList` and also re-reads the hierarchies.
 */
export function withHierarchyRevalidation<Data>(
  mutateList: KeyedMutator<Data>,
  revalidateHierarchies: () => Promise<unknown>,
): KeyedMutator<Data> {
  return (data, options) => {
    const result = mutateList(data, options)
    if (typeof data !== 'function') void revalidateHierarchies().catch(() => undefined)
    return result
  }
}
