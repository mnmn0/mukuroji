import useSWR from 'swr'
import { getPublicProjectStatusReport } from '../api/statusReports'

/**
 * Reads the report a share link publishes, without sign-in.
 *
 * A failed read is not retried and the page is not revalidated on focus, because a revoked or
 * expired link answers the same way every time.
 *
 * @param token - Token from the share URL; nothing is read without it.
 * @returns The report once loaded, whether it is loading, and whether the link is unavailable.
 */
export function usePublicProjectStatusReport(token: string) {
  const published = useSWR(
    token ? ['public-project-status', token] as const : null,
    ([, currentToken]) => getPublicProjectStatusReport(currentToken),
    { shouldRetryOnError: false, revalidateOnFocus: false },
  )
  return {
    published: published.data,
    isLoading: published.isLoading,
    isUnavailable: !token || published.error !== undefined,
  }
}
