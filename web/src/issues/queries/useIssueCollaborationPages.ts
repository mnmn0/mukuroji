import useSWRInfinite from 'swr/infinite'
import {
  getTeamIssueCollaboration,
  type TeamIssueCollaborationPage,
} from '../api/collaboration'
import {
  getTeamIssueActivity,
  type TeamIssueActivityPage,
} from '../api/activity'

const collaborationPageSize = 20
const collaborationRefreshInterval = 4_000

/**
 * Work Item collaboration commentsをcursor paginationで取得します。
 *
 * @param accessToken - Issues API の access token です。
 * @param teamId - Work Itemを所有するTeam IDです。
 * @param issueId - 取得対象のWork Item IDです。
 * @param enabled - Query を実行するかどうかです。
 * @returns Collaboration page の SWR Infinite state です。
 */
export function useIssueCollaborationPages(
  accessToken: string | undefined,
  teamId: string | undefined,
  issueId: string | undefined,
  enabled = true,
) {
  return useSWRInfinite(
    (pageIndex, previousPage: TeamIssueCollaborationPage | null) => {
      if (!accessToken || !teamId || !issueId || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'issue-collaboration',
        accessToken,
        teamId,
        issueId,
        previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, currentTeamId, currentIssueId, cursor]) =>
      getTeamIssueCollaboration(currentTeamId, currentIssueId, token, {
        cursor: cursor || undefined,
        limit: collaborationPageSize,
      }),
    collaborationQueryConfig,
  )
}

/**
 * Work Item activityをcursor paginationで取得します。
 *
 * @param accessToken - Issues API の access token です。
 * @param teamId - Work Itemを所有するTeam IDです。
 * @param issueId - 取得対象のWork Item IDです。
 * @param enabled - Query を実行するかどうかです。
 * @returns Activity page の SWR Infinite state です。
 */
export function useIssueActivityPages(
  accessToken: string | undefined,
  teamId: string | undefined,
  issueId: string | undefined,
  enabled = true,
) {
  return useSWRInfinite(
    (pageIndex, previousPage: TeamIssueActivityPage | null) => {
      if (!accessToken || !teamId || !issueId || !enabled) return null
      if (pageIndex > 0 && !previousPage?.nextCursor) return null
      return [
        'issue-activity',
        accessToken,
        teamId,
        issueId,
        previousPage?.nextCursor ?? '',
      ] as const
    },
    ([, token, currentTeamId, currentIssueId, cursor]) =>
      getTeamIssueActivity(currentTeamId, currentIssueId, token, {
        cursor: cursor || undefined,
        limit: collaborationPageSize,
      }),
    collaborationQueryConfig,
  )
}

const collaborationQueryConfig = {
  dedupingInterval: 1_000,
  refreshInterval: collaborationRefreshInterval,
  refreshWhenHidden: false,
  refreshWhenOffline: false,
  revalidateOnFocus: true,
  shouldRetryOnError: false,
} as const
