import {
  GITHUB_PULL_REQUEST_CHECK_STATES,
  GITHUB_PULL_REQUEST_INBOX_VIEWS,
  GITHUB_PULL_REQUEST_MERGEABLE_STATES,
  GITHUB_PULL_REQUEST_REVIEW_DECISIONS,
  GITHUB_PULL_REQUEST_REVIEW_STATES,
  GITHUB_PULL_REQUEST_SECTIONS,
  GITHUB_PULL_REQUEST_STATES,
  type GitHubLoginResponse,
  type GitHubPullRequestInboxResponse,
  type GitHubPullRequestInboxView,
  type GitHubPullRequestReview,
  type GitHubPullRequestSummary,
  type GitHubRepositoryLink,
  type GitHubRepositoryLinkListResponse,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'

/** Base URL of the GitHub review inbox API. */
const githubApiBaseUrl = resolveApiBaseUrl('workspaceWithoutProjects')

/** Error of a GitHub review inbox request with its HTTP status and server code. */
export class GitHubReviewsApiError extends Error {
  /** HTTP status of the response, or 0 when the request did not reach the server. */
  readonly status: number

  /** Server error code, such as `GitHubLoginTaken`, when the server sent one. */
  readonly code: string | undefined

  /**
   * Creates the error.
   *
   * @param status - HTTP status.
   * @param message - Server message, or a generic one.
   * @param code - Server error code.
   */
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'GitHubReviewsApiError'
    this.status = status
    this.code = code
  }
}

/**
 * Reads one tab of the signed-in member's pull request review inbox.
 *
 * @param accessToken - Access token of the member.
 * @param view - `created` or `to-review`.
 * @returns The inbox.
 */
export async function readPullRequestInbox(
  accessToken: string,
  view: GitHubPullRequestInboxView,
): Promise<GitHubPullRequestInboxResponse> {
  const body = await requestJson(`/me/pull-requests?view=${encodeURIComponent(view)}`, accessToken)
  if (!isRecord(body) || typeof body.configured !== 'boolean' || !Array.isArray(body.items)) throw invalidResponse()
  const responseView = GITHUB_PULL_REQUEST_INBOX_VIEWS.find((candidate) => candidate === body.view)
  if (!responseView) throw invalidResponse()
  return {
    configured: body.configured,
    ...(typeof body.githubLogin === 'string' ? { githubLogin: body.githubLogin } : {}),
    view: responseView,
    items: body.items.map(parsePullRequest),
    ...(body.incomplete === true ? { incomplete: true } : {}),
  }
}

/**
 * Reads the signed-in member's GitHub login.
 *
 * @param accessToken - Access token of the member.
 * @returns The login, when registered.
 */
export async function readGitHubLogin(accessToken: string): Promise<GitHubLoginResponse> {
  return parseLogin(await requestJson('/me/github-login', accessToken))
}

/**
 * Registers or replaces the signed-in member's GitHub login.
 *
 * @param accessToken - Access token of the member.
 * @param githubLogin - GitHub login.
 * @param context - Mutation context shared with retries.
 * @returns The saved login.
 */
export async function saveGitHubLogin(
  accessToken: string,
  githubLogin: string,
  context: MutationRequestContext,
): Promise<GitHubLoginResponse> {
  return parseLogin(await requestJson('/me/github-login', accessToken, {
    method: 'PUT',
    body: JSON.stringify({ githubLogin }),
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
  }))
}

/**
 * Removes the signed-in member's GitHub login.
 *
 * @param accessToken - Access token of the member.
 * @param context - Mutation context shared with retries.
 */
export async function deleteGitHubLogin(accessToken: string, context: MutationRequestContext): Promise<void> {
  await requestJson('/me/github-login', accessToken, { method: 'DELETE', headers: createMutationHeaders(context) })
}

/**
 * Lists the repositories the GitHub App can read, with their Team links.
 *
 * @param accessToken - Access token of a Workspace administrator.
 * @returns The repositories.
 */
export async function listGitHubRepositoryLinks(accessToken: string): Promise<GitHubRepositoryLinkListResponse> {
  const body = await requestJson('/workspace/github/repositories', accessToken)
  if (!isRecord(body) || typeof body.configured !== 'boolean' || !Array.isArray(body.repositories)) throw invalidResponse()
  return {
    configured: body.configured,
    repositories: body.repositories.map(parseRepositoryLink),
    ...(body.incomplete === true ? { incomplete: true } : {}),
  }
}

/**
 * Links a repository to a Team, or moves it to another Team.
 *
 * @param accessToken - Access token of a Workspace administrator.
 * @param repositoryId - Numeric repository ID.
 * @param input - Team and the revision the administrator saw.
 * @param input.teamId - Team to link to.
 * @param input.expectedRevision - Revision of the current link, when one exists.
 * @param context - Mutation context shared with retries.
 * @returns The saved link.
 */
export async function saveGitHubRepositoryLink(
  accessToken: string,
  repositoryId: string,
  input: { teamId: string, expectedRevision?: number },
  context: MutationRequestContext,
): Promise<GitHubRepositoryLink> {
  return parseRepositoryLink(await requestJson(`/workspace/github/repositories/${encodeURIComponent(repositoryId)}`, accessToken, {
    method: 'PUT',
    body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
  }))
}

/**
 * Removes a repository's Team link.
 *
 * @param accessToken - Access token of a Workspace administrator.
 * @param repositoryId - Numeric repository ID.
 * @param expectedRevision - Revision of the link the administrator saw.
 * @param context - Mutation context shared with retries.
 */
export async function deleteGitHubRepositoryLink(
  accessToken: string,
  repositoryId: string,
  expectedRevision: number,
  context: MutationRequestContext,
): Promise<void> {
  await requestJson(
    `/workspace/github/repositories/${encodeURIComponent(repositoryId)}?expectedRevision=${expectedRevision}`,
    accessToken,
    { method: 'DELETE', headers: createMutationHeaders(context) },
  )
}

/**
 * Sends an authenticated request and reads its JSON body.
 *
 * @param path - Path under the API base URL.
 * @param accessToken - Access token of the member.
 * @param init - Request options.
 * @returns The parsed body, or `undefined` for an empty response.
 * @throws GitHubReviewsApiError when the request fails.
 */
async function requestJson(path: string, accessToken: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${githubApiBaseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
    })
  } catch {
    throw new GitHubReviewsApiError(0, 'GitHub request failed.')
  }
  let text: string
  try {
    text = await response.text()
  } catch {
    throw new GitHubReviewsApiError(0, 'GitHub response was interrupted.')
  }
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    throw new GitHubReviewsApiError(response.status, 'GitHub response was malformed.')
  }
  if (!response.ok) {
    throw new GitHubReviewsApiError(
      response.status,
      isRecord(body) && typeof body.message === 'string' ? body.message : 'GitHub request failed.',
      isRecord(body) && typeof body.code === 'string' ? body.code : undefined,
    )
  }
  return body
}

/**
 * Validates a login response.
 *
 * @param value - Raw body.
 * @returns The login response.
 */
function parseLogin(value: unknown): GitHubLoginResponse {
  if (!isRecord(value)) throw invalidResponse()
  return typeof value.githubLogin === 'string' ? { githubLogin: value.githubLogin } : {}
}

/**
 * Validates one repository of a link listing.
 *
 * @param value - Raw repository.
 * @returns The repository and its link.
 */
function parseRepositoryLink(value: unknown): GitHubRepositoryLink {
  if (
    !isRecord(value) ||
    typeof value.repositoryId !== 'string' ||
    typeof value.repository !== 'string' ||
    typeof value.installationId !== 'string' ||
    typeof value.private !== 'boolean'
  ) {
    throw invalidResponse()
  }
  return {
    repositoryId: value.repositoryId,
    repository: value.repository,
    installationId: value.installationId,
    private: value.private,
    ...(typeof value.teamId === 'string' ? { teamId: value.teamId } : {}),
    ...(typeof value.revision === 'number' ? { revision: value.revision } : {}),
    ...(typeof value.linkedAt === 'string' ? { linkedAt: value.linkedAt } : {}),
  }
}

/**
 * Validates one pull request of an inbox.
 *
 * @param value - Raw pull request.
 * @returns The pull request.
 */
function parsePullRequest(value: unknown): GitHubPullRequestSummary {
  if (!isRecord(value) || !isRecord(value.checks)) throw invalidResponse()
  const { checks } = value
  const state = pick(GITHUB_PULL_REQUEST_STATES, value.state)
  const mergeable = pick(GITHUB_PULL_REQUEST_MERGEABLE_STATES, value.mergeable)
  const reviewDecision = pick(GITHUB_PULL_REQUEST_REVIEW_DECISIONS, value.reviewDecision)
  const section = pick(GITHUB_PULL_REQUEST_SECTIONS, value.section)
  const checkState = pick(GITHUB_PULL_REQUEST_CHECK_STATES, checks.state)
  if (
    typeof value.repositoryId !== 'string' ||
    typeof value.repository !== 'string' ||
    typeof value.number !== 'number' ||
    typeof value.title !== 'string' ||
    typeof value.url !== 'string' ||
    !value.url.startsWith('https://github.com/') ||
    typeof value.draft !== 'boolean' ||
    typeof value.headRef !== 'string' ||
    typeof value.baseRef !== 'string' ||
    typeof value.headSha !== 'string' ||
    typeof value.teamId !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    typeof value.syncedAt !== 'string' ||
    typeof checks.total !== 'number' ||
    !state || !mergeable || !reviewDecision || !section || !checkState
  ) {
    throw invalidResponse()
  }
  return {
    repositoryId: value.repositoryId,
    repository: value.repository,
    number: value.number,
    title: value.title,
    url: value.url,
    state,
    draft: value.draft,
    ...(typeof value.authorLogin === 'string' ? { authorLogin: value.authorLogin } : {}),
    headRef: value.headRef,
    baseRef: value.baseRef,
    headSha: value.headSha,
    mergeable,
    reviewDecision,
    requestedReviewerLogins: readStrings(value.requestedReviewerLogins),
    requestedTeamSlugs: readStrings(value.requestedTeamSlugs),
    reviews: Array.isArray(value.reviews) ? value.reviews.flatMap(parseReview) : [],
    checks: { state: checkState, failedNames: readStrings(checks.failedNames), total: checks.total },
    teamId: value.teamId,
    section,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.mergedAt === 'string' ? { mergedAt: value.mergedAt } : {}),
    ...(typeof value.closedAt === 'string' ? { closedAt: value.closedAt } : {}),
    syncedAt: value.syncedAt,
  }
}

/**
 * Reads one review, skipping an unknown one.
 *
 * @param value - Raw review.
 * @returns The review, or nothing.
 */
function parseReview(value: unknown): GitHubPullRequestReview[] {
  if (!isRecord(value) || typeof value.login !== 'string') return []
  const state = pick(GITHUB_PULL_REQUEST_REVIEW_STATES, value.state)
  return state ? [{ login: value.login, state }] : []
}

/**
 * Finds a value among the allowed literals.
 *
 * @param allowed - Allowed literals.
 * @param value - Raw value.
 * @returns The matching literal, or `undefined`.
 */
function pick<const T extends string>(allowed: readonly T[], value: unknown): T | undefined {
  return allowed.find((candidate) => candidate === value)
}

/**
 * Reads an array of strings, dropping other entries.
 *
 * @param value - Raw value.
 * @returns The strings.
 */
function readStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Creates the error for a response that does not match the contract.
 *
 * @returns The error.
 */
function invalidResponse(): GitHubReviewsApiError {
  return new GitHubReviewsApiError(502, 'GitHub response was malformed.')
}

/**
 * Returns whether a value is a plain object.
 *
 * @param value - Value to check.
 * @returns Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
