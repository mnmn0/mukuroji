import type {
  AcceptedResolutionPage,
  CuratedContextRevisionPage,
} from '@mukuroji/contracts'
import useSWRInfinite from 'swr/infinite'
import {
  getTeamIssueAcceptedResolutions,
  getTeamIssueContextRevisions,
} from '../api/contextItems'

const historyPageSize = 10

/**
 * Loads immutable snapshots for one selected curated context item.
 *
 * @param accessToken - Issues API access token.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param contextItemId - Selected curated context item identifier.
 * @returns SWR Infinite state for the selected revision history.
 */
export function useIssueContextRevisionPages(
  accessToken: string | undefined,
  teamId: string | undefined,
  issueId: string | undefined,
  contextItemId: string | undefined,
) {
  return useSWRInfinite(
    (pageIndex, previousPage: CuratedContextRevisionPage | null) => {
      if (!accessToken || !teamId || !issueId || !contextItemId) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null

      return [
        'issue-context-revisions',
        accessToken,
        teamId,
        issueId,
        contextItemId,
        previousPage?.nextCursor ?? '',
      ]
    },
    ([, token, currentTeamId, currentIssueId, currentItemId, cursor]) =>
      getTeamIssueContextRevisions(
        currentTeamId,
        currentIssueId,
        currentItemId,
        token,
        {
          cursor: cursor || undefined,
          limit: historyPageSize,
        },
      ),
    {
      dedupingInterval: 1_000,
      refreshWhenHidden: false,
      refreshWhenOffline: false,
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  )
}

/**
 * Loads accepted-resolution snapshots for one selected root thread.
 *
 * @param accessToken - Issues API access token.
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param rootCommentId - Selected root comment identifier.
 * @returns SWR Infinite state for the selected resolution history.
 */
export function useIssueAcceptedResolutionPages(
  accessToken: string | undefined,
  teamId: string | undefined,
  issueId: string | undefined,
  rootCommentId: string | undefined,
) {
  return useSWRInfinite(
    (pageIndex, previousPage: AcceptedResolutionPage | null) => {
      if (!accessToken || !teamId || !issueId || !rootCommentId) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null

      return [
        'issue-accepted-resolutions',
        accessToken,
        teamId,
        issueId,
        rootCommentId,
        previousPage?.nextCursor ?? '',
      ]
    },
    ([, token, currentTeamId, currentIssueId, currentRootCommentId, cursor]) =>
      getTeamIssueAcceptedResolutions(
        currentTeamId,
        currentIssueId,
        currentRootCommentId,
        token,
        {
          cursor: cursor || undefined,
          limit: historyPageSize,
        },
      ),
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
