import { useMemo, type ReactNode } from 'react'
import useSWR from 'swr'
import { getWorkItemKeyPrefixes } from '../api/workItems'
import { selectLinkableWorkItemKeyPrefixes, WorkItemKeyPrefixesContext } from './workItemKeyPrefixesContext'
import { workItemKeyPrefixesKey } from './workItemKeyPrefixesCache'

/** Props of {@link WorkItemKeyPrefixesProvider}. */
export type WorkItemKeyPrefixesProviderProps = {
  /** Work Item API access token; nothing is loaded without one. */
  accessToken: string | undefined
  /** Workspace content that links Work Item keys. */
  children: ReactNode
}

/**
 * Loads the Workspace's Work Item key prefixes and shares them with key links below. The list is
 * read again when the window regains focus, and right away after a Work Item is created or a
 * Team's prefix changes in this tab, so a Team that got its first key since is linked. When a
 * load fails, every key-shaped word is linked again, since the last list may be out of date.
 *
 * @param props - Access token and children.
 * @returns The children inside the prefix context.
 */
export function WorkItemKeyPrefixesProvider({ accessToken, children }: WorkItemKeyPrefixesProviderProps) {
  const { data, error } = useSWR(
    accessToken ? workItemKeyPrefixesKey(accessToken) : null,
    ([, token]) => getWorkItemKeyPrefixes(token),
    { shouldRetryOnError: false },
  )
  const prefixes = useMemo(() => selectLinkableWorkItemKeyPrefixes(data, error), [data, error])
  return (
    <WorkItemKeyPrefixesContext.Provider value={prefixes}>
      {children}
    </WorkItemKeyPrefixesContext.Provider>
  )
}
