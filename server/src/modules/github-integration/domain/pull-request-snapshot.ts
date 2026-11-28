import {
  GITHUB_PULL_REQUEST_FAILED_CHECK_NAMES_MAX,
  GITHUB_PULL_REQUEST_REVIEWERS_MAX,
  isGitHubLogin,
  type GitHubPullRequestCheckState,
  type GitHubPullRequestChecks,
  type GitHubPullRequestMergeableState,
  type GitHubPullRequestReview,
  type GitHubPullRequestReviewDecision,
  type GitHubPullRequestReviewState,
  type GitHubPullRequestState,
  type GitHubPullRequestSummary,
} from '@mukuroji/contracts'

/** Longest title kept; GitHub allows 256 characters, so this only bounds malformed input. */
const TITLE_MAX_LENGTH = 1024

/** Longest branch, check, team, or login text kept. */
const NAME_MAX_LENGTH = 255

/** Commit SHA: 40 (SHA-1) or 64 (SHA-256) hexadecimal digits. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

/** Check run conclusions that fail the head commit. */
const FAILING_CHECK_CONCLUSIONS = new Set([
  'ACTION_REQUIRED',
  'CANCELLED',
  'FAILURE',
  'STALE',
  'STARTUP_FAILURE',
  'TIMED_OUT',
])

/** Commit status states that fail the head commit. */
const FAILING_STATUS_STATES = new Set(['ERROR', 'FAILURE'])

/**
 * Stored state of one pull request (ADR 0079). The Team link is not part of it: the inbox reads
 * the repository's current link, so moving a repository to another Team takes effect at once.
 */
export type GitHubPullRequestSnapshot = Omit<GitHubPullRequestSummary, 'teamId' | 'section'>

/** Repository a GraphQL pull request must belong to. */
export type GitHubSnapshotRepository = {
  /** GitHub's numeric repository ID, as a decimal string. */
  repositoryId: string
}

/**
 * Builds a snapshot from one GraphQL `PullRequest` node of the sync query.
 *
 * @param node - Untrusted GraphQL node.
 * @param expected - Repository the node must belong to.
 * @param syncedAt - Time the node was read.
 * @returns The snapshot.
 * @throws TypeError when the node is malformed or belongs to another repository.
 */
export function parseGitHubPullRequestNode(
  node: unknown,
  expected: GitHubSnapshotRepository,
  syncedAt: string,
): GitHubPullRequestSnapshot {
  const value = requireRecord(node, 'pull request')
  const repository = requireRecord(value.baseRepository, 'pull request repository')
  if (
    typeof repository.databaseId !== 'number' ||
    String(repository.databaseId) !== expected.repositoryId ||
    typeof repository.nameWithOwner !== 'string' ||
    repository.nameWithOwner.length === 0 ||
    repository.nameWithOwner.length > NAME_MAX_LENGTH
  ) {
    throw new TypeError('GitHub pull request belongs to another repository.')
  }
  const number = value.number
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    throw new TypeError('GitHub pull request number is invalid.')
  }
  const url = readUrl(value.url)
  const headSha = typeof value.headRefOid === 'string' && COMMIT_SHA_PATTERN.test(value.headRefOid)
    ? value.headRefOid
    : undefined
  if (!url || !headSha) throw new TypeError('GitHub pull request URL or head is invalid.')
  const author = isRecord(value.author) && isGitHubLogin(value.author.login) ? value.author.login : undefined
  const state = readState(value.state)
  const mergedAt = readTime(value.mergedAt)
  const closedAt = readTime(value.closedAt)
  return {
    repositoryId: expected.repositoryId,
    repository: repository.nameWithOwner,
    number,
    title: readText(value.title, TITLE_MAX_LENGTH, 'title'),
    url,
    state,
    draft: value.isDraft === true,
    ...(author === undefined ? {} : { authorLogin: author }),
    headRef: readText(value.headRefName, NAME_MAX_LENGTH, 'head branch'),
    baseRef: readText(value.baseRefName, NAME_MAX_LENGTH, 'base branch'),
    headSha,
    mergeable: readMergeable(value.mergeable),
    reviewDecision: readReviewDecision(value.reviewDecision),
    ...readReviewRequests(value.reviewRequests),
    reviews: readReviews(value.latestOpinionatedReviews),
    checks: readChecks(value.commits),
    createdAt: requireTime(value.createdAt, 'created time'),
    updatedAt: requireTime(value.updatedAt, 'updated time'),
    ...(state === 'merged' && mergedAt ? { mergedAt } : {}),
    ...(state !== 'open' && closedAt ? { closedAt } : {}),
    syncedAt,
  }
}

/**
 * Reads the pull request state.
 *
 * @param value - GraphQL `PullRequestState`.
 * @returns The state.
 * @throws TypeError for an unknown state.
 */
function readState(value: unknown): GitHubPullRequestState {
  if (value === 'OPEN') return 'open'
  if (value === 'CLOSED') return 'closed'
  if (value === 'MERGED') return 'merged'
  throw new TypeError('GitHub pull request state is invalid.')
}

/**
 * Reads the merge conflict state.
 *
 * @param value - GraphQL `MergeableState`.
 * @returns The state; anything GitHub has not decided is `unknown`.
 */
function readMergeable(value: unknown): GitHubPullRequestMergeableState {
  if (value === 'MERGEABLE') return 'mergeable'
  if (value === 'CONFLICTING') return 'conflicting'
  return 'unknown'
}

/**
 * Reads the review decision.
 *
 * @param value - GraphQL `PullRequestReviewDecision`, or null when no review is required.
 * @returns The decision.
 */
function readReviewDecision(value: unknown): GitHubPullRequestReviewDecision {
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes-requested'
  if (value === 'REVIEW_REQUIRED') return 'review-required'
  return 'none'
}

/**
 * Reads the users and teams whose review is requested.
 *
 * @param value - GraphQL `reviewRequests` connection.
 * @returns Distinct logins and team slugs, each at most {@link GITHUB_PULL_REQUEST_REVIEWERS_MAX}.
 */
function readReviewRequests(value: unknown): { requestedReviewerLogins: string[], requestedTeamSlugs: string[] } {
  const logins = new Set<string>()
  const teams = new Set<string>()
  for (const node of readNodes(value)) {
    const reviewer = isRecord(node) && isRecord(node.requestedReviewer) ? node.requestedReviewer : undefined
    if (!reviewer) continue
    if (isGitHubLogin(reviewer.login) && logins.size < GITHUB_PULL_REQUEST_REVIEWERS_MAX) logins.add(reviewer.login)
    if (
      typeof reviewer.slug === 'string' &&
      reviewer.slug.length > 0 &&
      reviewer.slug.length <= NAME_MAX_LENGTH &&
      teams.size < GITHUB_PULL_REQUEST_REVIEWERS_MAX
    ) {
      teams.add(reviewer.slug)
    }
  }
  return { requestedReviewerLogins: [...logins], requestedTeamSlugs: [...teams] }
}

/**
 * Reads each reviewer's latest approval, change request, comment, or dismissal.
 *
 * @param value - GraphQL `latestOpinionatedReviews` connection.
 * @returns At most {@link GITHUB_PULL_REQUEST_REVIEWERS_MAX} reviews, one per reviewer.
 */
function readReviews(value: unknown): GitHubPullRequestReview[] {
  const reviews = new Map<string, GitHubPullRequestReviewState>()
  for (const node of readNodes(value)) {
    if (!isRecord(node) || !isRecord(node.author) || !isGitHubLogin(node.author.login)) continue
    const state = readReviewState(node.state)
    if (!state) continue
    if (!reviews.has(node.author.login) && reviews.size >= GITHUB_PULL_REQUEST_REVIEWERS_MAX) continue
    reviews.set(node.author.login, state)
  }
  return [...reviews].map(([login, state]) => ({ login, state }))
}

/**
 * Reads one review state.
 *
 * @param value - GraphQL `PullRequestReviewState`.
 * @returns The state, or `undefined` for a pending review.
 */
function readReviewState(value: unknown): GitHubPullRequestReviewState | undefined {
  if (value === 'APPROVED') return 'approved'
  if (value === 'CHANGES_REQUESTED') return 'changes-requested'
  if (value === 'COMMENTED') return 'commented'
  if (value === 'DISMISSED') return 'dismissed'
  return undefined
}

/**
 * Reads the combined checks of the head commit.
 *
 * @param value - GraphQL `commits(last: 1)` connection.
 * @returns The combined state, failed check names, and the number of checks.
 */
function readChecks(value: unknown): GitHubPullRequestChecks {
  const commit = readNodes(value).at(-1)
  const rollup = isRecord(commit) && isRecord(commit.commit) && isRecord(commit.commit.statusCheckRollup)
    ? commit.commit.statusCheckRollup
    : undefined
  if (!rollup) return { state: 'none', failedNames: [], total: 0 }
  const contexts = isRecord(rollup.contexts) ? rollup.contexts : {}
  const failedNames = new Set<string>()
  for (const node of readNodes(contexts)) {
    if (!isRecord(node)) continue
    const failed = node.__typename === 'CheckRun'
      ? typeof node.conclusion === 'string' && FAILING_CHECK_CONCLUSIONS.has(node.conclusion)
      : node.__typename === 'StatusContext' && typeof node.state === 'string' && FAILING_STATUS_STATES.has(node.state)
    const name = node.__typename === 'CheckRun' ? node.name : node.context
    if (failed && typeof name === 'string' && name.length > 0 && failedNames.size < GITHUB_PULL_REQUEST_FAILED_CHECK_NAMES_MAX) {
      failedNames.add(name.slice(0, NAME_MAX_LENGTH))
    }
  }
  const total = typeof contexts.totalCount === 'number' && Number.isSafeInteger(contexts.totalCount) && contexts.totalCount >= 0
    ? contexts.totalCount
    : 0
  return { state: readRollupState(rollup.state, failedNames.size > 0), failedNames: [...failedNames], total }
}

/**
 * Reads the rollup state of the head commit.
 *
 * @param value - GraphQL `StatusState`.
 * @param anyFailed - Whether a listed check failed.
 * @returns The combined state; a listed failure wins over a pending rollup.
 */
function readRollupState(value: unknown, anyFailed: boolean): GitHubPullRequestCheckState {
  if (value === 'FAILURE' || value === 'ERROR' || anyFailed) return 'failure'
  if (value === 'SUCCESS') return 'success'
  if (value === 'PENDING' || value === 'EXPECTED') return 'pending'
  return 'none'
}

/**
 * Reads the `nodes` of a GraphQL connection.
 *
 * @param value - Connection.
 * @returns The nodes, or an empty list.
 */
function readNodes(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.nodes) ? value.nodes : []
}

/**
 * Reads a `https://github.com/` URL.
 *
 * @param value - Candidate URL.
 * @returns The URL, or `undefined`.
 */
function readUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.username === '' && url.password === ''
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Reads a bounded, non-empty text.
 *
 * @param value - Candidate text.
 * @param maxLength - Longest length kept.
 * @param label - Field name for the error.
 * @returns The text, cut to `maxLength`.
 * @throws TypeError when the value is not a non-empty string.
 */
function readText(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`GitHub pull request ${label} is invalid.`)
  return value.slice(0, maxLength)
}

/**
 * Reads an ISO 8601 time.
 *
 * @param value - Candidate time.
 * @returns The normalized time, or `undefined`.
 */
function readTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

/**
 * Reads a required ISO 8601 time.
 *
 * @param value - Candidate time.
 * @param label - Field name for the error.
 * @returns The normalized time.
 * @throws TypeError when the time is missing or invalid.
 */
function requireTime(value: unknown, label: string): string {
  const time = readTime(value)
  if (time === undefined) throw new TypeError(`GitHub pull request ${label} is invalid.`)
  return time
}

/**
 * Requires an object.
 *
 * @param value - Candidate.
 * @param label - Name for the error.
 * @returns The object.
 * @throws TypeError otherwise.
 */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`GitHub ${label} is invalid.`)
  return value
}

/**
 * Checks whether a value is a plain object.
 *
 * @param value - Value.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
