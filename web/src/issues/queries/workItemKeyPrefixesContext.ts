import { createContext, useContext } from 'react'

/**
 * Key prefixes that exist in the Workspace, or undefined while they are unknown. Unknown keeps
 * the earlier behaviour of linking every key-shaped word, so a failed load never hides links.
 */
export const WorkItemKeyPrefixesContext = createContext<ReadonlySet<string> | undefined>(undefined)

/**
 * Reads the Workspace's Work Item key prefixes.
 *
 * @returns The known prefixes, or undefined when they are not loaded.
 */
export function useWorkItemKeyPrefixes(): ReadonlySet<string> | undefined {
  return useContext(WorkItemKeyPrefixesContext)
}

/**
 * Chooses the prefixes to share from the latest load. SWR keeps the last list when a later load
 * fails, but that list may miss a prefix changed since, so a failed load falls back to unknown.
 *
 * @param prefixes - Last loaded prefixes, if any.
 * @param loadError - Error of the latest load, if it failed.
 * @returns The known prefixes, or undefined when they are not loaded or the latest load failed.
 */
export function selectLinkableWorkItemKeyPrefixes(
  prefixes: readonly string[] | undefined,
  loadError: unknown,
): ReadonlySet<string> | undefined {
  if (loadError !== undefined || prefixes === undefined) return undefined
  return new Set(prefixes)
}
