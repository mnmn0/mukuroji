import type {
  AgentRunPullRequestCheckState,
  AgentRunPullRequestReviewState,
  AgentRunPullRequestStatus,
} from '@mukuroji/contracts'
import { ConnectorRuntimeError } from './connector-runtime-error'
import type { ConnectorProviderRequester } from './connector-resource-protocol'
import type { ConnectorPullRequestReference } from './connectors'

/** `owner/repository` of a GitHub repository. */
const REPOSITORY_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/u

/** Commit SHA GitHub returns: 40 (SHA-1) or 64 (SHA-256) hexadecimal digits. */
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u

/**
 * Check runs read per page. A check run carries its output summary, so 50 keep one page well
 * within the provider requester's 2 MiB response limit.
 */
const CHECK_RUNS_PAGE_SIZE = 50

/** Check run pages read before the runs are treated as too many to aggregate. */
const MAXIMUM_CHECK_RUN_PAGES = 10

/** Reviews read; a pull request rarely has more, and later ones are read only when it does. */
const REVIEWS_PAGE_SIZE = 100

/** Review pages read before the history is treated as too long to aggregate. */
const MAXIMUM_REVIEW_PAGES = 10

/** Check run conclusions that fail the head commit. */
const FAILING_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'])

/**
 * Reads a GitHub pull request's state, the combined checks of its head commit, and its reviews
 * (ADR 0103). A pull request GitHub hides or no longer has throws
 * `ConnectorExternalResourceMissing`, which a caller shows as not accessible.
 *
 * @param request - Authenticated provider requester of the installation.
 * @param reference - Repository and pull request number.
 * @returns The pull request status.
 */
export async function readGitHubPullRequest(
  request: ConnectorProviderRequester,
  reference: ConnectorPullRequestReference,
): Promise<AgentRunPullRequestStatus> {
  const match = REPOSITORY_PATTERN.exec(reference.repository)
  if (!match || !Number.isSafeInteger(reference.number) || reference.number < 1) {
    throw new ConnectorRuntimeError('ConnectorExternalIdInvalid', 'GitHub pull request reference is invalid.')
  }
  const repositoryPath = `repos/${encodeURIComponent(match[1])}/${encodeURIComponent(match[2])}`
  const pullPath = `${repositoryPath}/pulls/${reference.number}`
  const pull = await request({ method: 'GET', path: pullPath, allowedStatuses: [404, 410] })
  if (pull.status === 404 || pull.status === 410) throw missingPullRequest()
  const payload = requireObject(pull.payload, 'GitHub pull request')
  const head = requireObject(payload.head, 'GitHub pull request head')
  const headSha = head.sha
  if (typeof headSha !== 'string' || !COMMIT_SHA_PATTERN.test(headSha)) throw malformed('GitHub pull request head SHA is invalid.')
  if (payload.state !== 'open' && payload.state !== 'closed') throw malformed('GitHub pull request state is invalid.')
  const merged = payload.merged === true || (typeof payload.merged_at === 'string' && payload.merged_at !== '')
  const [checks, review] = await Promise.all([
    readHeadChecks(request, repositoryPath, headSha),
    readReviewState(request, pullPath),
  ])
  return {
    state: merged ? 'merged' : payload.state,
    draft: payload.draft === true,
    headSha,
    checks,
    review,
    ...(merged && typeof payload.merged_at === 'string' ? { mergedAt: payload.merged_at } : {}),
    ...(merged && typeof payload.merge_commit_sha === 'string' && COMMIT_SHA_PATTERN.test(payload.merge_commit_sha)
      ? { mergeCommitSha: payload.merge_commit_sha }
      : {}),
  }
}

/**
 * Combines the check runs and the commit statuses of the head commit.
 *
 * @param request - Authenticated provider requester.
 * @param repositoryPath - `repos/{owner}/{repo}` path.
 * @param sha - Head commit SHA.
 * @returns `failure` when any failed, `pending` while any runs, `success` when all passed, and
 * `none` when the commit has neither.
 * @throws ConnectorRuntimeError ConnectorProviderResponseMalformed when the check runs fill more
 * than {@link MAXIMUM_CHECK_RUN_PAGES} pages, since a partial list could hide a failed run.
 */
async function readHeadChecks(
  request: ConnectorProviderRequester,
  repositoryPath: string,
  sha: string,
): Promise<AgentRunPullRequestCheckState> {
  const [{ runs, total: totalRuns }, statusResponse] = await Promise.all([
    readCheckRuns(request, repositoryPath, sha),
    request({ method: 'GET', path: `${repositoryPath}/commits/${sha}/status`, allowedStatuses: [404, 410] }),
  ])
  if (statusResponse.status === 404 || statusResponse.status === 410) throw missingPullRequest()
  const statusPayload = requireObject(statusResponse.payload, 'GitHub combined status')
  const totalStatuses = typeof statusPayload.total_count === 'number' ? statusPayload.total_count : 0
  let failed = false
  // GitHub counting more runs than it listed means some are still being created.
  let pending = totalRuns > runs.length
  for (const run of runs) {
    if (!isObject(run)) throw malformed('GitHub check run is invalid.')
    if (run.status !== 'completed') pending = true
    else if (typeof run.conclusion === 'string' && FAILING_CONCLUSIONS.has(run.conclusion)) failed = true
  }
  if (totalStatuses > 0) {
    if (statusPayload.state === 'failure' || statusPayload.state === 'error') failed = true
    else if (statusPayload.state !== 'success') pending = true
  }
  if (failed) return 'failure'
  if (pending) return 'pending'
  return totalRuns + totalStatuses === 0 ? 'none' : 'success'
}

/**
 * Reads every latest check run of a commit, page by page.
 *
 * @param request - Authenticated provider requester.
 * @param repositoryPath - `repos/{owner}/{repo}` path.
 * @param sha - Commit SHA.
 * @returns The check runs, unvalidated, and the count GitHub reports.
 * @throws ConnectorRuntimeError ConnectorProviderResponseMalformed when more than
 * {@link MAXIMUM_CHECK_RUN_PAGES} pages exist.
 */
async function readCheckRuns(
  request: ConnectorProviderRequester,
  repositoryPath: string,
  sha: string,
): Promise<{ runs: unknown[], total: number }> {
  const runs: unknown[] = []
  for (let page = 1; page <= MAXIMUM_CHECK_RUN_PAGES; page += 1) {
    const response = await request({
      method: 'GET',
      path: `${repositoryPath}/commits/${sha}/check-runs`,
      query: { per_page: String(CHECK_RUNS_PAGE_SIZE), filter: 'latest', page: String(page) },
      allowedStatuses: [404, 410],
    })
    if (response.status === 404 || response.status === 410) throw missingPullRequest()
    const payload = requireObject(response.payload, 'GitHub check runs')
    const pageRuns = Array.isArray(payload.check_runs) ? payload.check_runs : []
    runs.push(...pageRuns)
    const total = typeof payload.total_count === 'number' ? payload.total_count : runs.length
    if (runs.length >= total || pageRuns.length < CHECK_RUNS_PAGE_SIZE) return { runs, total }
  }
  throw malformed('GitHub check runs are too many to read in full.')
}

/**
 * Reads each reviewer's latest approval or change request. A dismissed review withdraws the
 * reviewer's earlier decision; comments do not change it.
 *
 * @param request - Authenticated provider requester.
 * @param pullPath - `repos/{owner}/{repo}/pulls/{number}` path.
 * @returns `changes-requested` when any reviewer's latest decision requests changes, `approved`
 * when at least one approves, and `none` otherwise.
 * @throws ConnectorRuntimeError ConnectorProviderResponseMalformed when the history is longer than
 * {@link MAXIMUM_REVIEW_PAGES} pages, since a partial history could show an outdated decision.
 */
async function readReviewState(
  request: ConnectorProviderRequester,
  pullPath: string,
): Promise<AgentRunPullRequestReviewState> {
  const decisions = new Map<string, 'approved' | 'changes-requested'>()
  let complete = false
  for (let page = 1; page <= MAXIMUM_REVIEW_PAGES; page += 1) {
    const response = await request({
      method: 'GET',
      path: `${pullPath}/reviews`,
      query: { per_page: String(REVIEWS_PAGE_SIZE), page: String(page) },
      allowedStatuses: [404, 410],
    })
    if (response.status === 404 || response.status === 410) throw missingPullRequest()
    if (!Array.isArray(response.payload)) throw malformed('GitHub reviews are invalid.')
    // Reviews come oldest first, so a later decision of the same reviewer replaces an earlier one.
    for (const review of response.payload) {
      if (!isObject(review)) throw malformed('GitHub review is invalid.')
      const user = isObject(review.user) ? review.user.id : undefined
      if (typeof user !== 'number' && typeof user !== 'string') continue
      const reviewer = String(user)
      if (review.state === 'APPROVED') decisions.set(reviewer, 'approved')
      else if (review.state === 'CHANGES_REQUESTED') decisions.set(reviewer, 'changes-requested')
      else if (review.state === 'DISMISSED') decisions.delete(reviewer)
    }
    if (response.payload.length < REVIEWS_PAGE_SIZE) {
      complete = true
      break
    }
  }
  if (!complete) throw malformed('GitHub review history is too long to read in full.')
  const values = [...decisions.values()]
  if (values.includes('changes-requested')) return 'changes-requested'
  return values.includes('approved') ? 'approved' : 'none'
}

/**
 * Builds the error of a pull request GitHub does not show to the account.
 *
 * @returns The missing-resource error.
 */
function missingPullRequest() {
  return new ConnectorRuntimeError(
    'ConnectorExternalResourceMissing',
    'The GitHub pull request does not exist or the connected account cannot read it.',
    { providerStatus: 404 },
  )
}

/**
 * Requires a JSON object.
 *
 * @param value - Parsed payload.
 * @param label - Payload name for the error.
 * @returns The object.
 */
function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw malformed(`${label} is invalid.`)
  return value
}

/**
 * Checks whether a value is a JSON object.
 *
 * @param value - Value to check.
 * @returns True for a non-null, non-array object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Builds the error of a payload GitHub returned in an unexpected shape.
 *
 * @param message - Error message.
 * @returns The error.
 */
function malformed(message: string) {
  return new ConnectorRuntimeError('ConnectorProviderResponseMalformed', message)
}
