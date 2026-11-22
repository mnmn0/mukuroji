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
