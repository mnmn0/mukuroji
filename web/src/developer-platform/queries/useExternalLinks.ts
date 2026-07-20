import type { CursorPage, ExternalWorkItemLink } from '@mukuroji/contracts'
import useSWRInfinite from 'swr/infinite'
import { listDeveloperExternalLinks } from '../api/externalLinks'

/**
 * Work Item に紐づく external links をcursor paginationで取得します。
 *
 * @param accessToken - Developer Platform API の access token です。
 * @param teamId - Work Itemを所有するTeam IDです。
 * @param workItemId - 取得対象のWork Item IDです。
 * @returns External link page の SWR Infinite state です。
 */
export function useDeveloperExternalLinks(
  accessToken: string | undefined,
  teamId: string,
  workItemId: string,
) {
  return useSWRInfinite(
    (
      pageIndex,
      previousPage: CursorPage<ExternalWorkItemLink> | null,
    ) => {
      if (!accessToken) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'work-item-external-links',
        accessToken,
        teamId,
        workItemId,
        previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, currentTeamId, currentWorkItemId, cursor]) =>
      listDeveloperExternalLinks(
        token,
        currentTeamId,
        currentWorkItemId,
        { ...(cursor ? { cursor } : {}), limit: 50 },
      ),
    {
      dedupingInterval: 10_000,
      shouldRetryOnError: false,
    },
  )
}
