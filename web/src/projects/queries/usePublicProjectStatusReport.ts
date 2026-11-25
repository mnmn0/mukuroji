import useSWR from 'swr'
import { ProjectDirectoryApiError } from '../api/errors'
import { getPublicProjectStatusReport } from '../api/statusReports'

/**
 * Reads the report a share link publishes, without sign-in.
 *
 * Only a 404, which the server answers for an unknown, revoked, or expired link, makes the link
 * unavailable. Any other failure, such as a network error or a 503, is temporary and can be
 * retried. Failures are not retried automatically and the page is not revalidated on focus.
 *
 * @param token - Token from the share URL; nothing is read without it.
 * @returns The report once loaded, the load and failure states, and a retry action.
 */
export function usePublicProjectStatusReport(token: string) {
  const published = useSWR(
    token ? ['public-project-status', token] as const : null,
    ([, currentToken]) => getPublicProjectStatusReport(currentToken),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  )
  const isUnavailable = !token || (published.error instanceof ProjectDirectoryApiError && published.error.status === 404)
  return {
    published: published.data,
    isLoading: published.isLoading,
    isUnavailable,
    hasFailed: published.error !== undefined && !isUnavailable,
    isRetrying: published.isValidating,
    retry: () => {
      void published.mutate()
    },
  }
}
