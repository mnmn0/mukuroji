import type { GitHubPullRequestSnapshot } from './pull-request-snapshot'

/** Kinds of Inbox notification a pull request change sends (#775). */
export type GitHubPullRequestNotificationKind = 'review-requested' | 'checks-failed' | 'conflict'

/** One Inbox notification a pull request change implies, addressed to a GitHub login. */
export type GitHubPullRequestNotification = {
  /** What changed. */
  kind: GitHubPullRequestNotificationKind
  /** GitHub login of the recipient. */
  login: string
  /**
   * Key unique to this change: the same change read again, by a retry or another worker, yields the
   * same key, so the notification is written once.
   */
  key: string
}

/**
 * Finds the notifications a newly read pull request implies, compared with the stored snapshot.
 *
 * - A newly requested reviewer is told their review was requested.
 * - The author is told when CI starts failing, or fails on a new head commit.
 * - The author is told when the pull request starts to conflict with its base.
 *
 * Only open pull requests notify. A pull request without a stored snapshot notifies only its
 * requested reviewers, and only when `notifyNew` is set, so linking a repository does not flood
 * the Inbox with every open pull request. Nobody is told about their own action.
 *
 * @param previous - Stored snapshot, if any.
 * @param next - Snapshot read from GitHub.
 * @param options - Whether a pull request seen for the first time notifies.
 * @param options.notifyNew - Whether a pull request without a stored snapshot notifies its reviewers.
 * @returns The notifications, at most one per kind and login.
 */
export function detectPullRequestNotifications(
  previous: GitHubPullRequestSnapshot | undefined,
  next: GitHubPullRequestSnapshot,
  options: { notifyNew: boolean },
): GitHubPullRequestNotification[] {
  if (next.state !== 'open') return []
  if (!previous && !options.notifyNew) return []
  // The stored snapshot is replaced only after the notifications are written, so a retry keys on
  // the same previous read and does not notify twice.
  const base = previous?.syncedAt ?? 'new'
  const author = next.authorLogin?.toLowerCase()
  const notifications: GitHubPullRequestNotification[] = []
  const alreadyRequested = new Set(previous?.requestedReviewerLogins.map((login) => login.toLowerCase()) ?? [])
  const requested = new Set<string>()
  for (const login of next.requestedReviewerLogins) {
    const normalized = login.toLowerCase()
    if (alreadyRequested.has(normalized) || normalized === author || requested.has(normalized)) continue
    requested.add(normalized)
    notifications.push({ kind: 'review-requested', login, key: `review-requested\0${normalized}\0${base}` })
  }
  if (!previous || !next.authorLogin || next.draft) return notifications
  const newlyFailing = next.checks.state === 'failure' &&
    (previous.checks.state !== 'failure' || previous.headSha !== next.headSha)
  if (newlyFailing) {
    notifications.push({ kind: 'checks-failed', login: next.authorLogin, key: `checks-failed\0${next.headSha}\0${base}` })
  }
  // GitHub recomputes the conflict state after each push, so `unknown` in between is not a change.
  const newlyConflicting = next.mergeable === 'conflicting' &&
    (previous.mergeable === 'mergeable' || (previous.mergeable === 'unknown' && previous.headSha !== next.headSha))
  if (newlyConflicting) {
    notifications.push({ kind: 'conflict', login: next.authorLogin, key: `conflict\0${next.headSha}\0${base}` })
  }
  return notifications
}
