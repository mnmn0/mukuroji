import useSWR from 'swr'
import { getDirectoryAdministration } from '../api/directoryAdministration'

/**
 * Loads every Team and Project, archived ones included, for the administration panel.
 *
 * @param accessToken - Bearer token of the Workspace administrator.
 * @returns The SWR state of the Teams in display order.
 */
export function useDirectoryAdministration(accessToken: string) {
  return useSWR(
    ['directory-administration', accessToken] as const,
    ([, token]) => getDirectoryAdministration(token),
    { shouldRetryOnError: false },
  )
}
