import { ConnectorRuntimeError } from './connector-runtime-error'
import type {
  ConnectorProviderRequester,
  ConnectorResourceProtocol,
} from './connector-resource-protocol'
import type {
  ConnectorExternalRecord,
  ConnectorOutboundMutation,
  ConnectorPullRequestReference,
  ExternalResourceType,
} from './connectors'
import { readGitHubPullRequest } from './github-pull-request-reader'

/** Resource types of the GitHub catalog entry; only issues are read and written. */
const GITHUB_RESOURCE_TYPES: readonly ExternalResourceType[] = ['issue', 'merge-request', 'commit', 'deploy']

/**
 * Issues GitHub returns per page; a full page means there may be another. An issue body can hold
 * 65,536 characters (about 200 KB of UTF-8), so eight issues stay within the provider requester's
 * 2 MiB response limit whatever their bodies hold.
 */
const PAGE_SIZE = 8

/** Longest issue title GitHub accepts. */
const TITLE_MAX_LENGTH = 256

/** Longest issue body Mukuroji writes, kept under GitHub's 65,536 character limit with the marker. */
const BODY_MAX_LENGTH = 60_000

/** Hidden HTML comment that carries the origin marker of a Mukuroji write in the issue body. */
const ORIGIN_COMMENT_PATTERN = /\n*<!-- mukuroji-origin:([A-Za-z0-9._~:-]{1,1024}) -->\s*$/u

/** `owner/repository#number`, the external ID of a GitHub issue. */
const ISSUE_ID_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]{0,9})$/u

/**
 * OAuth and API settings of a GitHub OAuth App that an operator does not need to write, so a
 * GitHub entry needs only its client ID, client secret variable, and redirect URI.
 */
export const GITHUB_CONNECTOR_DEFAULTS = {
  authorizationEndpoint: 'https://github.com/login/oauth/authorize',
  tokenEndpoint: 'https://github.com/login/oauth/access_token',
  accountEndpoint: 'https://api.github.com/user',
  apiBaseUrl: 'https://api.github.com/',
  clientAuthentication: 'body',
  defaultScopes: ['repo'],
  token: { accessToken: 'access_token' },
  account: { externalAccountId: 'id', externalAccountName: 'login' },
  allowedHosts: ['github.com', 'api.github.com'],
  grantRevocation: 'github-oauth-app',
} as const

/**
 * GitHub REST issues in the repositories the connected account can see, served as a built-in resource protocol (ADR 0089). The issue state
 * travels as `open` / `closed`, which the sync maps to the status category of the Work Item, so a
 * Team workflow never has to name GitHub states. Pull requests, commits, and deploys stay manual
 * links: reading or writing them through the connector is refused.
 */
export class GitHubIssueProtocol implements ConnectorResourceProtocol {
  /** Resource types of the GitHub catalog entry. */
  readonly resourceTypes = GITHUB_RESOURCE_TYPES

  /**
   * Lists the issues the account can see, most recently updated first. Pull requests that the
   * issues API also returns are left out.
   *
   * @param request - Authenticated provider requester.
   * @param resourceType - Resource type; only `issue` has records.
   * @param cursor - Page number from the previous page.
   * @returns One page of issues and the next page number when the page was full.
   */
  async pull(request: ConnectorProviderRequester, resourceType: ExternalResourceType, cursor?: string) {
    if (resourceType !== 'issue') return { items: [] }
    const page = cursor === undefined ? 1 : readPageCursor(cursor)
    const response = await request({
      method: 'GET',
      path: 'issues',
      query: {
        filter: 'all',
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: String(PAGE_SIZE),
        page: String(page),
      },
    })
    if (!Array.isArray(response.payload)) throw malformed('GitHub issue list must be an array.')
    const items = response.payload
      .filter((item) => !(isObject(item) && item.pull_request !== undefined))
      .map((item) => readIssue(item, readRepositoryName(item)))
    return {
      items,
      ...(response.payload.length === PAGE_SIZE ? { nextCursor: String(page + 1) } : {}),
    }
  }

  /**
   * Reads a pull request's state, checks, and reviews for Agent Run artifact verification (ADR 0103).
   *
   * @param request - Authenticated provider requester.
   * @param reference - Repository and pull request number.
   * @returns The pull request status.
   */
  readPullRequest(request: ConnectorProviderRequester, reference: ConnectorPullRequestReference) {
    return readGitHubPullRequest(request, reference)
  }

  /**
   * Reads one issue as it is now.
   *
   * @param request - Authenticated provider requester.
   * @param resourceType - Must be `issue`.
   * @param externalId - `owner/repository#number`.
   * @returns The issue.
   */
  async read(request: ConnectorProviderRequester, resourceType: ExternalResourceType, externalId: string) {
    requireIssueResource(resourceType)
    const issue = readIssueId(externalId)
    const response = await request({
      method: 'GET',
      path: issuePath(issue),
      allowedStatuses: [404, 410],
    })
    if (response.status === 404 || response.status === 410) throw missingIssue()
    return readIssue(response.payload, `${issue.owner}/${issue.repository}`)
  }

  /**
   * Writes the Work Item title, description, and open / closed state to its issue. A completed or
   * canceled Work Item closes the issue; any other status category reopens it.
   *
   * Every write first reads the target and refuses a pull request, which the issues endpoint would
   * also write. A write with an expected version also refuses when the issue changed since
   * Mukuroji last read it; the next poll then reads that edit and records a conflict.
   *
   * GitHub has no conditional issue update, so this check is not atomic: an edit that lands
   * between this read and the PATCH is overwritten, and no conflict is recorded for it. That window
   * is one request long and is accepted rather than serialized, because the edit stays in the
   * issue's history on GitHub.
   *
   * @param request - Authenticated provider requester.
   * @param mutation - Work Item contents and the origin marker.
   * @returns The issue after the write.
   */
  async push(request: ConnectorProviderRequester, mutation: ConnectorOutboundMutation) {
    requireIssueResource(mutation.resourceType)
    const issue = readIssueId(mutation.externalId)
    const state = toIssueState(mutation.statusCategory)
    // The target is read first even without an expected version: the issues endpoint also writes
    // pull requests, which reading the payload refuses.
    // The contents are checked before anything is read, so a write GitHub cannot take sends nothing.
    const body = {
      ...(mutation.title === undefined ? {} : { title: readTitle(mutation.title) }),
      body: writeBody(mutation.description, mutation.originMarker),
      ...(state === undefined
        ? {}
        : { state, ...(state === 'closed' ? { state_reason: mutation.statusCategory === 'canceled' ? 'not_planned' : 'completed' } : {}) }),
    }
    const current = await request({ method: 'GET', path: issuePath(issue), allowedStatuses: [404, 410] })
    if (current.status === 404 || current.status === 410) throw missingIssue()
    const currentIssue = readIssue(current.payload, `${issue.owner}/${issue.repository}`)
    if (mutation.expectedExternalVersion !== undefined && currentIssue.externalVersion !== mutation.expectedExternalVersion) {
      throw issueChanged()
    }
    const response = await request({
      method: 'PATCH',
      path: issuePath(issue),
      body,
      allowedStatuses: [404, 410],
    })
    if (response.status === 404 || response.status === 410) throw missingIssue()
    return readIssue(response.payload, `${issue.owner}/${issue.repository}`)
  }

  /**
   * Refuses to create issues: the repository of a new issue is not part of the link, so an issue
   * is created on GitHub and then linked.
   *
   * @returns Never returns.
   */
  async create(): Promise<ConnectorExternalRecord> {
    throw new ConnectorRuntimeError(
      'ConnectorResourceCreateUnsupported',
      'GitHub issues are created on GitHub and then linked.',
    )
  }
}

/** Parts of an issue external ID. */
type GitHubIssueId = {
  /** Repository owner. */
  owner: string
  /** Repository name. */
  repository: string
  /** Issue number. */
  number: string
}

/**
 * Parses `owner/repository#number`.
 *
 * @param value - External ID.
 * @returns The parts.
 */
export function readIssueId(value: string): GitHubIssueId {
  const match = ISSUE_ID_PATTERN.exec(value)
  if (!match) {
    throw new ConnectorRuntimeError(
      'ConnectorExternalIdInvalid',
      'GitHub issue external ID must be owner/repository#number.',
    )
  }
  return { owner: match[1], repository: match[2], number: match[3] }
}

/**
 * Builds the REST path of an issue.
 *
 * @param issue - Issue ID parts.
 * @returns Path relative to the API base URL.
 */
function issuePath(issue: GitHubIssueId) {
  return `repos/${encodeURIComponent(issue.owner)}/${encodeURIComponent(issue.repository)}/issues/${issue.number}`
}

/**
 * Converts a Work Item status category to the GitHub issue state.
 *
 * @param category - Status category, when the sync knows it.
 * @returns `closed` for completed and canceled, `open` otherwise, or `undefined` when unknown.
 */
function toIssueState(category: string | undefined) {
  if (category === undefined) return undefined
  return category === 'completed' || category === 'canceled' ? 'closed' : 'open'
}

/**
 * Reads `repository.full_name` of an issue from the account-wide issue list.
 *
 * @param value - Issue payload.
 * @returns `owner/repository`.
 */
function readRepositoryName(value: unknown) {
  const repository = isObject(value) ? value.repository : undefined
  const name = isObject(repository) ? repository.full_name : undefined
  if (typeof name !== 'string') throw malformed('GitHub issue repository is missing.')
  return name
}

/**
 * Converts a GitHub issue payload to a connector record.
 *
 * @param value - Issue payload.
 * @param repositoryName - `owner/repository` of the issue.
 * @returns The normalized record.
 */
function readIssue(value: unknown, repositoryName: string): ConnectorExternalRecord {
  const issue = requireObject(value, 'GitHub issue')
  // The issues API also serves pull requests; only issues are synchronized.
  if (issue.pull_request !== undefined && issue.pull_request !== null) {
    throw new ConnectorRuntimeError('ConnectorResourceUnsupported', 'The GitHub link points to a pull request, not an issue.')
  }
  const number = issue.number
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw malformed('GitHub issue number is invalid.')
  const externalId = `${repositoryName}#${number}`
  readIssueId(externalId)
  if (typeof issue.html_url !== 'string' || !issue.html_url.startsWith('https://')) throw malformed('GitHub issue URL is invalid.')
  if (typeof issue.updated_at !== 'string' || issue.updated_at === '') throw malformed('GitHub issue version is missing.')
  if (issue.state !== 'open' && issue.state !== 'closed') throw malformed('GitHub issue state is invalid.')
  const { description, originMarker } = readBody(issue.body)
  return {
    externalId,
    resourceType: 'issue',
    externalUrl: issue.html_url,
    displayKey: externalId,
    externalVersion: issue.updated_at,
    ...(typeof issue.title === 'string' ? { title: issue.title } : {}),
    description,
    state: issue.state,
    metadata: {},
    ...(originMarker === undefined ? {} : { originMarker }),
  }
}

/**
 * Splits the issue body into the description and the hidden origin marker of the last write.
 *
 * @param value - Issue body, which GitHub returns as `null` when empty.
 * @returns Description without the marker comment, and the marker.
 */
function readBody(value: unknown): { description: string; originMarker?: string } {
  const body = typeof value === 'string' ? value.replace(/\r\n/gu, '\n') : ''
  const match = ORIGIN_COMMENT_PATTERN.exec(body)
  return match
    ? { description: body.slice(0, match.index), originMarker: match[1] }
    : { description: body }
}

/**
 * Writes the description with the origin marker as a trailing HTML comment, which GitHub hides.
 * A description longer than {@link BODY_MAX_LENGTH} is refused rather than shortened.
 * The description is written as it is: the marker opens its own comment, and reading the issue
 * back takes only a marker at the very end, so comments in the description keep working.
 *
 * @param description - Work Item description.
 * @param originMarker - Signed origin marker.
 * @returns Issue body.
 */
function writeBody(description: string | undefined, originMarker: string) {
  if (!/^[A-Za-z0-9._~:-]{1,1024}$/u.test(originMarker)) throw malformed('Connector origin marker is invalid.')
  const text = description ?? ''
  // A shortened copy would read back as the Work Item's description, so a longer one is refused.
  if (text.length > BODY_MAX_LENGTH) {
    throw new ConnectorRuntimeError(
      'ConnectorRecordTooLarge',
      `The Work Item description is longer than the ${BODY_MAX_LENGTH} characters a GitHub issue can take with the sync marker.`,
    )
  }
  return `${text}\n\n<!-- mukuroji-origin:${originMarker} -->`
}

/**
 * Checks the issue title. A title longer than {@link TITLE_MAX_LENGTH} characters (Unicode code
 * points, as Work Item titles count them) is refused rather than shortened, since a shortened copy
 * would read back as the Work Item's title.
 *
 * @param value - Work Item title.
 * @returns Title GitHub accepts.
 */
function readTitle(value: string) {
  const title = value.trim()
  if (Array.from(title).length > TITLE_MAX_LENGTH) {
    throw new ConnectorRuntimeError(
      'ConnectorRecordTooLarge',
      `The Work Item title is longer than the ${TITLE_MAX_LENGTH} characters a GitHub issue title can take.`,
    )
  }
  return title === '' ? 'Untitled' : title
}

/**
 * Validates a page-number cursor.
 *
 * @param value - Cursor from the previous page.
 * @returns Page number.
 */
function readPageCursor(value: string) {
  // Any positive page number of up to nine digits: a walk goes on while GitHub returns full pages,
  // and each poll already reads a bounded number of pages.
  if (!/^[1-9][0-9]{0,8}$/u.test(value)) throw malformed('GitHub issue page cursor is invalid.')
  return Number(value)
}

/**
 * Refuses resource types other than issues.
 *
 * @param resourceType - Requested resource type.
 */
function requireIssueResource(resourceType: ExternalResourceType) {
  if (resourceType !== 'issue') {
    throw new ConnectorRuntimeError(
      'ConnectorResourceUnsupported',
      'The GitHub connector syncs issues only.',
    )
  }
}

/**
 * Error for an issue edited since Mukuroji last read it. The next poll reads the edit and records a
 * conflict when the Work Item changed too.
 *
 * @returns A non-retryable runtime error.
 */
function issueChanged() {
  return new ConnectorRuntimeError('ConnectorExternalVersionChanged', 'The GitHub issue changed since it was last read.')
}

/**
 * Error for an issue that no longer exists or is no longer visible.
 *
 * @returns Runtime error.
 */
function missingIssue() {
  return new ConnectorRuntimeError(
    'ConnectorExternalResourceMissing',
    'The linked GitHub issue no longer exists.',
    { providerStatus: 404 },
  )
}

/**
 * Requires a JSON object.
 *
 * @param value - Payload.
 * @param label - Name used in the error.
 * @returns The object.
 */
function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw malformed(`${label} must be an object.`)
  return value
}

/**
 * Checks for a non-array object.
 *
 * @param value - Candidate.
 * @returns Whether it is an object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Error for an unexpected provider response.
 *
 * @param message - Safe message.
 * @returns Runtime error.
 */
function malformed(message: string) {
  return new ConnectorRuntimeError('ConnectorProviderResponseMalformed', message)
}
