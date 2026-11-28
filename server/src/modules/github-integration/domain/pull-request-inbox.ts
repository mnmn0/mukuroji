import {
  classifyGitHubPullRequestSection,
  GITHUB_PULL_REQUEST_CLOSED_RETENTION_DAYS,
  type GitHubPullRequestInboxView,
  type GitHubPullRequestSummary,
} from '@mukuroji/contracts'
import type { GitHubPullRequestSnapshot } from './pull-request-snapshot'

/** Milliseconds in a day. */
const DAY_MILLISECONDS = 86_400_000

/** What {@link selectPullRequestInboxItems} filters with. */
export type PullRequestInboxSelection = {
  /** Tab to list. */
  view: GitHubPullRequestInboxView
  /** The caller's GitHub login. */
  login: string
  /** Team each linked repository belongs to, by repository ID. */
  repositoryTeams: ReadonlyMap<string, string>
  /** Teams the caller may read Work Items of. */
  readableTeamIds: ReadonlySet<string>
  /** Request time, which ends the retention of closed pull requests. */
  now: Date
}

/**
 * Chooses the pull requests of one inbox tab (ADR 0079).
 *
 * `created` lists the caller's own pull requests. `to-review` lists the open ones of other authors
 * whose review is requested from the caller, or that the caller already reviewed and are still
 * open. Only repositories linked to a Team the caller can read are listed, and closed pull
 * requests leave after {@link GITHUB_PULL_REQUEST_CLOSED_RETENTION_DAYS} days.
 *
 * @param snapshots - Stored snapshots.
 * @param selection - Tab, login, links, and the caller's readable Teams.
 * @returns The tab's items, most recently updated first.
 */
export function selectPullRequestInboxItems(
  snapshots: readonly GitHubPullRequestSnapshot[],
  selection: PullRequestInboxSelection,
): GitHubPullRequestSummary[] {
  const login = selection.login.toLowerCase()
  const cutoff = selection.now.getTime() - GITHUB_PULL_REQUEST_CLOSED_RETENTION_DAYS * DAY_MILLISECONDS
  const items: GitHubPullRequestSummary[] = []
  for (const snapshot of snapshots) {
    const teamId = selection.repositoryTeams.get(snapshot.repositoryId)
    if (teamId === undefined || !selection.readableTeamIds.has(teamId)) continue
    if (snapshot.state !== 'open' && Date.parse(snapshot.closedAt ?? snapshot.updatedAt) < cutoff) continue
    const author = snapshot.authorLogin?.toLowerCase()
    if (selection.view === 'created') {
      if (author !== login) continue
    } else {
      if (snapshot.state !== 'open' || author === login) continue
      const requested = snapshot.requestedReviewerLogins.some((reviewer) => reviewer.toLowerCase() === login)
      const reviewed = snapshot.reviews.some((review) => review.login.toLowerCase() === login)
      if (!requested && !reviewed) continue
    }
    items.push({ ...snapshot, teamId, section: classifyGitHubPullRequestSection(snapshot) })
  }
  return items.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.repository.localeCompare(right.repository) ||
    right.number - left.number)
}

/**
 * Checks whether a closed snapshot has outlived the inbox retention.
 *
 * @param snapshot - Stored snapshot.
 * @param now - Current time.
 * @returns True for a merged or closed pull request that closed more than the retention ago.
 */
export function isExpiredPullRequestSnapshot(snapshot: GitHubPullRequestSnapshot, now: Date): boolean {
  if (snapshot.state === 'open') return false
  const closedAt = Date.parse(snapshot.closedAt ?? snapshot.updatedAt)
  return closedAt < now.getTime() - GITHUB_PULL_REQUEST_CLOSED_RETENTION_DAYS * DAY_MILLISECONDS
}
