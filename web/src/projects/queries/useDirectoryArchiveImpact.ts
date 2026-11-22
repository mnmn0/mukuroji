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
 * Each mount sends a new request, with deduplication off so a confirmation reopened within the
 * default deduplication window does not reuse the earlier counts; the caller treats a
 * revalidation as loading.
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
    {
      revalidateOnMount: true,
      dedupingInterval: 0,
      revalidateOnFocus: false,
      shouldRetryOnError: false,
    },
  )
}
