import type { CuratedContextPage } from '@mukuroji/contracts'
import useSWRInfinite from 'swr/infinite'
import { getTeamIssueContextItems } from '../api/contextItems'

const contextPageSize = 10

/**
 * Loads human-curated context through an independent opaque cursor.
 *
 * @param accessToken - Issues API access token.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param enabled - Whether the scoped query may run.
 * @returns SWR Infinite state for context pages.
 */
export function useIssueContextPages(
  accessToken: string | undefined,
  teamId: string | undefined,
  issueId: string | undefined,
  enabled = true,
) {
  return useSWRInfinite(
    (pageIndex, previousPage: CuratedContextPage | null) => {
      if (!accessToken || !teamId || !issueId || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null

      return [
        'issue-context-items',
        accessToken,
        teamId,
        issueId,
        previousPage?.nextCursor ?? '',
      ]
    },
    ([, token, currentTeamId, currentIssueId, cursor]) =>
      getTeamIssueContextItems(currentTeamId, currentIssueId, token, {
        cursor: cursor || undefined,
        limit: contextPageSize,
      }),
    {
      dedupingInterval: 1_000,
      refreshInterval: 4_000,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )
}
