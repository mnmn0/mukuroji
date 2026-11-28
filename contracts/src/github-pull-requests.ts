/**
 * Contracts of the pull request review inbox fed by the Workspace GitHub App (#775, ADR 0079).
 *
 * GitHub stays the source of truth. Mukuroji keeps one read-only snapshot per pull request of a
 * repository an administrator linked to a Team, updated from GitHub App webhooks and an hourly
 * reconcile, and shows each member the pull requests they opened or were asked to review.
 */

/** States of a pull request snapshot. */
export const GITHUB_PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const

/** Open, closed without merging, or merged. */
export type GitHubPullRequestState = (typeof GITHUB_PULL_REQUEST_STATES)[number]

/** Combined result of the check runs and commit statuses on the head commit. */
export const GITHUB_PULL_REQUEST_CHECK_STATES = ['success', 'failure', 'pending', 'none'] as const

/** Combined check result of the head commit. */
export type GitHubPullRequestCheckState = (typeof GITHUB_PULL_REQUEST_CHECK_STATES)[number]

/** Whether GitHub can merge the head into the base without a conflict. */
export const GITHUB_PULL_REQUEST_MERGEABLE_STATES = ['mergeable', 'conflicting', 'unknown'] as const

/** Merge conflict state; `unknown` while GitHub is still computing it. */
export type GitHubPullRequestMergeableState = (typeof GITHUB_PULL_REQUEST_MERGEABLE_STATES)[number]

/** GitHub's review decision of a pull request. */
export const GITHUB_PULL_REQUEST_REVIEW_DECISIONS = [
  'approved',
  'changes-requested',
  'review-required',
  'none',
] as const

/**
 * Review decision. `review-required` means the base branch requires a review that is missing;
 * `none` means the repository requires no review and nobody approved or requested changes yet.
 */
export type GitHubPullRequestReviewDecision = (typeof GITHUB_PULL_REQUEST_REVIEW_DECISIONS)[number]

/** Latest decisive review of one reviewer. */
export const GITHUB_PULL_REQUEST_REVIEW_STATES = ['approved', 'changes-requested', 'commented', 'dismissed'] as const

/** State of one reviewer's latest review. */
export type GitHubPullRequestReviewState = (typeof GITHUB_PULL_REQUEST_REVIEW_STATES)[number]

/** Sections of the review inbox, in display order. */
export const GITHUB_PULL_REQUEST_SECTIONS = ['ready-to-merge', 'open', 'merged', 'closed'] as const

/**
 * Section a pull request is listed in. `ready-to-merge` is an open, non-draft pull request that is
 * approved (or needs no review), has no failing or pending checks, and has no conflict.
 */
export type GitHubPullRequestSection = (typeof GITHUB_PULL_REQUEST_SECTIONS)[number]

/** Tabs of the review inbox. */
export const GITHUB_PULL_REQUEST_INBOX_VIEWS = ['created', 'to-review'] as const

/** `created` lists the member's own pull requests; `to-review` the ones that ask for their review. */
export type GitHubPullRequestInboxView = (typeof GITHUB_PULL_REQUEST_INBOX_VIEWS)[number]

/** Most failed check names kept on one snapshot. */
export const GITHUB_PULL_REQUEST_FAILED_CHECK_NAMES_MAX = 20

/** Most requested reviewers and reviews kept on one snapshot. */
export const GITHUB_PULL_REQUEST_REVIEWERS_MAX = 20

/** Days a merged or closed pull request stays in the inbox after it closed. */
export const GITHUB_PULL_REQUEST_CLOSED_RETENTION_DAYS = 30

/** One reviewer's latest review. */
export type GitHubPullRequestReview = {
  /** Reviewer's GitHub login. */
  login: string
  /** State of the reviewer's latest review. */
  state: GitHubPullRequestReviewState
}

/** Head commit checks of a pull request. */
export type GitHubPullRequestChecks = {
  /** Combined result. */
  state: GitHubPullRequestCheckState
  /** Names of failed check runs and commit statuses, at most {@link GITHUB_PULL_REQUEST_FAILED_CHECK_NAMES_MAX}. */
  failedNames: string[]
  /** Number of check runs and commit statuses on the head commit. */
  total: number
}

/** One pull request as the review inbox shows it. */
export type GitHubPullRequestSummary = {
  /** GitHub's numeric repository ID, as a decimal string. */
  repositoryId: string
  /** `owner/repo` as GitHub last reported it. */
  repository: string
  /** Pull request number. */
  number: number
  /** Title. */
  title: string
  /** `https://github.com/...` URL of the pull request. */
  url: string
  /** Open, closed, or merged. */
  state: GitHubPullRequestState
  /** Whether the pull request is a draft. */
  draft: boolean
  /** GitHub login of the author; absent for a deleted account. */
  authorLogin?: string
  /** Head branch name. */
  headRef: string
  /** Base branch name. */
  baseRef: string
  /** Head commit SHA. */
  headSha: string
  /** Merge conflict state. */
  mergeable: GitHubPullRequestMergeableState
  /** Review decision. */
  reviewDecision: GitHubPullRequestReviewDecision
  /** Logins of users whose review is still requested. */
  requestedReviewerLogins: string[]
  /** Slugs of GitHub teams whose review is still requested. */
  requestedTeamSlugs: string[]
  /** Each reviewer's latest review. */
  reviews: GitHubPullRequestReview[]
  /** Head commit checks. */
  checks: GitHubPullRequestChecks
  /** Team the repository is linked to. */
  teamId: string
  /** Section the pull request is listed in. */
  section: GitHubPullRequestSection
  /** When the pull request was opened. */
  createdAt: string
  /** When GitHub last changed the pull request. */
  updatedAt: string
  /** When it was merged. */
  mergedAt?: string
  /** When it was closed or merged. */
  closedAt?: string
  /** When Mukuroji last read it from GitHub. */
  syncedAt: string
}

/** Response of `GET /api/me/pull-requests`. */
export type GitHubPullRequestInboxResponse = {
  /** Whether this deployment has a GitHub App configured. */
  configured: boolean
  /** The caller's GitHub login, when they registered one. */
  githubLogin?: string
  /** Tab the items belong to. */
  view: GitHubPullRequestInboxView
  /** Pull requests of the tab the caller may read, newest update first. */
  items: GitHubPullRequestSummary[]
  /** Present when the snapshots were too many to read in full, so some may be missing. */
  incomplete?: true
}

/** Response of `GET /api/me/github-login` and `PUT /api/me/github-login`. */
export type GitHubLoginResponse = {
  /** The caller's GitHub login, when they registered one. */
  githubLogin?: string
}

/** Body of `PUT /api/me/github-login`. */
export type SaveGitHubLoginRequest = {
  /** GitHub login; matched without regard to case. */
  githubLogin: string
}

/** One repository the GitHub App can read, and its Team link. */
export type GitHubRepositoryLink = {
  /** GitHub's numeric repository ID, as a decimal string. */
  repositoryId: string
  /** `owner/repo`. */
  repository: string
  /** GitHub App installation that grants access to the repository. */
  installationId: string
  /** Whether the repository is private. */
  private: boolean
  /** Linked Team; absent while the repository is not linked and therefore not synchronized. */
  teamId?: string
  /** Revision of the link, used as the expected revision of the next change. */
  revision?: number
  /** When the link last changed. */
  linkedAt?: string
}

/** Response of `GET /api/workspace/github/repositories`. */
export type GitHubRepositoryLinkListResponse = {
  /** Whether this deployment has a GitHub App configured. */
  configured: boolean
  /** Repositories the App can read, linked ones first, then by name. */
  repositories: GitHubRepositoryLink[]
  /** Present when the App can read more repositories than one listing returns. */
  incomplete?: true
}

/** Body of `PUT /api/workspace/github/repositories/:repositoryId`. */
export type SaveGitHubRepositoryLinkRequest = {
  /** Team the repository's pull requests belong to. */
  teamId: string
  /** Revision of the current link, or absent to create one. */
  expectedRevision?: number
}

/**
 * GitHub login: 1 to 39 letters, digits, or single hyphens, not starting or ending with a hyphen,
 * optionally followed by `_` and an Enterprise Managed Users short code (`mona-cat_octo`).
 */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:_[A-Za-z0-9]{1,39})?$/u

/** GitHub repository ID: a positive decimal integer of up to 20 digits. */
export const GITHUB_REPOSITORY_ID_PATTERN = /^[1-9][0-9]{0,19}$/u

/** Largest length of a Team ID in a repository link request. */
const GITHUB_TEAM_ID_MAX_LENGTH = 256

/**
 * Checks that a value is a GitHub login.
 *
 * @param value - Untrusted value.
 * @returns True for a syntactically valid GitHub login.
 */
export function isGitHubLogin(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_LOGIN_PATTERN.test(value)
}

/**
 * Validates the body of `PUT /api/me/github-login`.
 *
 * @param body - Parsed JSON body.
 * @returns The request with the login trimmed.
 * @throws TypeError when the body is not a valid request.
 */
export function parseSaveGitHubLoginRequest(body: unknown): SaveGitHubLoginRequest {
  if (!isRecord(body)) throw new TypeError('Request body must be an object.')
  requireOnlyKeys(body, ['githubLogin'])
  const login = typeof body.githubLogin === 'string' ? body.githubLogin.trim() : undefined
  if (!isGitHubLogin(login)) throw new TypeError('githubLogin must be a GitHub login.')
  return { githubLogin: login }
}

/**
 * Validates the body of `PUT /api/workspace/github/repositories/:repositoryId`.
 *
 * @param body - Parsed JSON body.
 * @returns The request.
 * @throws TypeError when the body is not a valid request.
 */
export function parseSaveGitHubRepositoryLinkRequest(body: unknown): SaveGitHubRepositoryLinkRequest {
  if (!isRecord(body)) throw new TypeError('Request body must be an object.')
  requireOnlyKeys(body, ['teamId', 'expectedRevision'])
  const teamId = typeof body.teamId === 'string' ? body.teamId.trim() : ''
  if (teamId.length === 0 || teamId.length > GITHUB_TEAM_ID_MAX_LENGTH || /\p{Cc}/u.test(teamId)) {
    throw new TypeError('teamId must be a Team ID.')
  }
  if (body.expectedRevision === undefined) return { teamId }
  if (
    typeof body.expectedRevision !== 'number' ||
    !Number.isSafeInteger(body.expectedRevision) ||
    body.expectedRevision < 1
  ) {
    throw new TypeError('expectedRevision must be a positive integer.')
  }
  return { teamId, expectedRevision: body.expectedRevision }
}

/** Facts {@link classifyGitHubPullRequestSection} reads. */
export type GitHubPullRequestSectionInput = Pick<
  GitHubPullRequestSummary,
  'state' | 'draft' | 'mergeable' | 'reviewDecision' | 'checks'
>

/**
 * Chooses the inbox section of a pull request.
 *
 * @param pullRequest - State, draft flag, conflict state, review decision, and checks.
 * @returns `merged` or `closed` for a closed pull request; `ready-to-merge` for an open one that
 * is not a draft, has no conflict, passed or has no checks, and is approved or needs no review;
 * `open` otherwise.
 */
export function classifyGitHubPullRequestSection(
  pullRequest: GitHubPullRequestSectionInput,
): GitHubPullRequestSection {
  if (pullRequest.state === 'merged') return 'merged'
  if (pullRequest.state === 'closed') return 'closed'
  const checksPass = pullRequest.checks.state === 'success' || pullRequest.checks.state === 'none'
  const reviewPass = pullRequest.reviewDecision === 'approved' || pullRequest.reviewDecision === 'none'
  return !pullRequest.draft && pullRequest.mergeable === 'mergeable' && checksPass && reviewPass
    ? 'ready-to-merge'
    : 'open'
}

/**
 * Checks whether a value is a plain object.
 *
 * @param value - Untrusted value.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Rejects properties a request does not define, so a typo is not silently ignored.
 *
 * @param body - Request object.
 * @param allowed - Property names the request defines.
 * @throws TypeError when the object has another property.
 */
function requireOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new TypeError(`Unknown property: ${key}.`)
  }
}
