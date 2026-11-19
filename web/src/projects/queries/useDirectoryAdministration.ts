import useSWR from 'swr'
import { getDirectoryAdministration } from '../api/directoryAdministration'

/** First element of the administration query key. */
const directoryAdministrationKeyPrefix = 'directory-administration'

/**
 * Tells whether an SWR key belongs to the directory administration query.
 *
 * Sidebar mutations that create or archive Teams and Projects revalidate matching keys with it.
 *
 * @param key - SWR cache key.
 * @returns Whether the key is a directory administration key.
 */
export function isDirectoryAdministrationKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === directoryAdministrationKeyPrefix
}

/**
 * Loads every Team and Project, archived ones included, for the administration panel.
 *
 * @param accessToken - Bearer token of the Workspace administrator.
 * @returns The SWR state of the Teams in display order.
 */
export function useDirectoryAdministration(accessToken: string) {
  return useSWR(
    [directoryAdministrationKeyPrefix, accessToken] as const,
    ([, token]) => getDirectoryAdministration(token),
    { shouldRetryOnError: false },
  )
}
