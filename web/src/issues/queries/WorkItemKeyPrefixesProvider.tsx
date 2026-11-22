import { useMemo, type ReactNode } from 'react'
import useSWR from 'swr'
import { getWorkItemKeyPrefixes } from '../api/workItems'
import { WorkItemKeyPrefixesContext } from './workItemKeyPrefixesContext'

/** Props of {@link WorkItemKeyPrefixesProvider}. */
export type WorkItemKeyPrefixesProviderProps = {
  /** Work Item API access token; nothing is loaded without one. */
  accessToken: string | undefined
  /** Workspace content that links Work Item keys. */
  children: ReactNode
}

/**
 * Loads the Workspace's Work Item key prefixes and shares them with key links below. The list is
 * read again when the window regains focus, so a Team that got its first key since is linked.
 *
 * @param props - Access token and children.
 * @returns The children inside the prefix context.
 */
export function WorkItemKeyPrefixesProvider({ accessToken, children }: WorkItemKeyPrefixesProviderProps) {
  const { data } = useSWR(
    accessToken ? ['work-item-key-prefixes', accessToken] as const : null,
    ([, token]) => getWorkItemKeyPrefixes(token),
    { shouldRetryOnError: false },
  )
  const prefixes = useMemo(() => data ? new Set(data) : undefined, [data])
  return (
    <WorkItemKeyPrefixesContext.Provider value={prefixes}>
      {children}
    </WorkItemKeyPrefixesContext.Provider>
  )
}
