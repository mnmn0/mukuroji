import type {
  DirectoryArchiveImpactResponse,
  DirectoryArchiveImpactTarget,
} from '@mukuroji/contracts'
import useSWR from 'swr'
import { getDirectoryArchiveImpact } from '../api/directoryAdministration'

/** First element of the archive impact query key. */
const directoryArchiveImpactKeyPrefix = 'directory-archive-impact'

/**
 * Loads what archiving a Team or Project affects, for its archive confirmation.
 *
 * Each mount revalidates, so reopening a confirmation never relies on counts read earlier; the
 * caller treats a revalidation as loading.
 *
 * @param accessToken - Bearer token of the Workspace administrator, or undefined before sign-in.
 * @param target - Team or Project about to be archived.
 * @param guard - Wraps the request so an ended Enterprise session is reported.
 * @returns The SWR state of the impact counts.
 */
export function useDirectoryArchiveImpact(
  accessToken: string | undefined,
  target: DirectoryArchiveImpactTarget,
  guard: <Result>(request: Promise<Result>) => Promise<Result>,
) {
  return useSWR<DirectoryArchiveImpactResponse>(
    accessToken
      ? [
          directoryArchiveImpactKeyPrefix,
          accessToken,
          target.kind,
          target.teamId,
          target.kind === 'project' ? target.projectId : '',
        ] as const
      : null,
    () => guard(getDirectoryArchiveImpact(accessToken ?? '', target)),
    { revalidateOnMount: true, revalidateOnFocus: false, shouldRetryOnError: false },
  )
}
