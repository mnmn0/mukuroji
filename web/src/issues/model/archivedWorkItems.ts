import type { CanonicalWorkItem } from '@mukuroji/contracts'

/**
 * Picks the archived Work Items from a list that also holds active ones, newest archive first.
 *
 * @param workItems - Work Items read with archived ones included.
 * @returns Only the archived Work Items, sorted by archive time from newest to oldest.
 */
export function selectArchivedWorkItems<T extends Pick<CanonicalWorkItem, 'archivedAt' | 'id'>>(
  workItems: readonly T[],
): T[] {
  return workItems
    .filter((workItem) => workItem.archivedAt !== undefined)
    .sort((first, second) =>
      (second.archivedAt ?? '').localeCompare(first.archivedAt ?? '') ||
      first.id.localeCompare(second.id)
    )
}
