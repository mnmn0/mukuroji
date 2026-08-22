import {
  createProjectIssuesPath,
  createTeamIssuesPath,
  createTeamTriagePath,
} from '../../shared/routing/paths'
import { isSafeApplicationPath } from '../../shared/routing/applicationPath'
import type { InboxNotification } from '../api'

/**
 * 通知の構造化 target または安全な app path から遷移先を解決します。
 *
 * @param notification - Inbox API が返した通知です。
 * @returns 現在の router が扱える同一 origin path です。
 */
export function resolveNotificationPath(notification: InboxNotification) {
  if (notification.teamId && notification.triageEntryId) {
    return createTeamTriagePath(notification.teamId, notification.triageEntryId)
  }

  if (notification.teamId && notification.issueId) {
    return notification.projectId
      ? createProjectIssuesPath(
          notification.projectId,
          notification.teamId,
          notification.issueId,
          notification.commentId,
          notification.rootCommentId,
        )
      : createTeamIssuesPath(
          notification.teamId,
          notification.issueId,
          notification.commentId,
          notification.rootCommentId,
        )
  }

  const deepLink = notification.deepLink?.trim()

  if (!deepLink || !isSafeApplicationPath(deepLink)) {
    return undefined
  }

  if (isLegacyTeamIssuePath(deepLink)) return undefined

  if (!notification.commentId) {
    return deepLink
  }

  const [pathAndQuery, hash = ''] = deepLink.split('#', 2)
  const [path, query = ''] = pathAndQuery.split('?', 2)
  const searchParams = new URLSearchParams(query)

  if (!searchParams.has('commentId')) {
    searchParams.set('commentId', notification.commentId)
  }
  if (notification.rootCommentId && !searchParams.has('rootCommentId')) {
    searchParams.set('rootCommentId', notification.rootCommentId)
  }

  return `${path}?${searchParams.toString()}${hash ? `#${hash}` : ''}`
}

/** Returns whether a notification contains the removed path-parameter Team Issue URL. */
function isLegacyTeamIssuePath(value: string): boolean {
  return /^\/teams\/[^/?#]+\/issues\/[^/?#]+(?:[?#].*)?$/u.test(value)
}
