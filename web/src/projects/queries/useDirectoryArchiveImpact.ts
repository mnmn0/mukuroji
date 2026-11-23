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
 * The key includes the opening, so each opening of a confirmation sends its own request and never
 * shares the cache or an in-flight request of an earlier opening.
 *
 * @param accessToken - Bearer token of the Workspace administrator, or undefined before sign-in.
 * @param target - Team or Project about to be archived.
 * @param opening - Identifies this opening of the confirmation.
 * @param guard - Wraps the request so an ended Enterprise session is reported.
 * @returns The SWR state of the impact counts.
 */
export function useDirectoryArchiveImpact(
  accessToken: string | undefined,
  target: DirectoryArchiveImpactTarget,
  opening: number,
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
          opening,
        ] as const
      : null,
    () => guard(getDirectoryArchiveImpact(accessToken ?? '', target)),
    { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false },
  )
}
