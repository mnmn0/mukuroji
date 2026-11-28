import { createSign } from 'node:crypto'
import { GitHubIntegrationError } from '../../domain/github-integration-error'
import {
  parseGitHubPullRequestNode,
  type GitHubPullRequestSnapshot,
} from '../../domain/pull-request-snapshot'
import { GITHUB_SYNC_JOB_MAX_NUMBERS } from '../../domain/sync-jobs'
import type {
  GitHubAppCredentialSource,
  GitHubAppCredentials,
  GitHubAppGateway,
  GitHubInstallationRepository,
  GitHubOpenPullRequestReadResult,
  GitHubPullRequestReadResult,
  GitHubRepositoryReference,
} from '../../application/ports'

/** The only host the gateway calls. */
const GITHUB_API_ORIGIN = 'https://api.github.com'

/** Milliseconds one GitHub request may take. */
const REQUEST_TIMEOUT_MILLISECONDS = 10_000

/** Largest response body read. */
const RESPONSE_MAX_BYTES = 4 * 1024 * 1024

/** Seconds before expiry an installation token is replaced. */
const TOKEN_REFRESH_MARGIN_SECONDS = 300

/** Installations and repository pages listed for the administrator. */
const INSTALLATIONS_MAX = 100
const REPOSITORY_PAGES_MAX = 5
const PAGE_SIZE = 100

/** Open pull requests one read returns. */
const OPEN_PULL_REQUESTS_PAGE_SIZE = 50

/** Most pages of open pull requests one read follows; 500 pull requests in all. */
const OPEN_PULL_REQUESTS_PAGES_MAX = 10

/** Repository ID: a positive decimal integer. */
const NUMERIC_ID_PATTERN = /^[1-9][0-9]{0,19}$/u

/** `owner/repo`. */
const REPOSITORY_NAME_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/u

/** GraphQL selection of every field a snapshot needs (ADR 0079). */
const PULL_REQUEST_FRAGMENT = `
fragment PullRequestSnapshot on PullRequest {
  number title url state isDraft createdAt updatedAt mergedAt closedAt
  headRefName baseRefName headRefOid mergeable reviewDecision
  baseRepository { databaseId nameWithOwner }
  author { login }
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } ... on Mannequin { login } } }
  }
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  commits(last: 1) {
    nodes { commit { statusCheckRollup { state contexts(first: 50) {
      totalCount
      nodes { __typename ... on CheckRun { name conclusion } ... on StatusContext { context state } }
    } } } }
  }
}`

/** Performs an HTTP request; replaced in tests. */
export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>

/** Parsed GitHub response. */
type GitHubResponse = {
  /** HTTP status. */
  status: number
  /** Parsed JSON body, or `undefined` for an empty body. */
  body: unknown
}

/**
 * Reads GitHub with the deployment's GitHub App (ADR 0079): an RS256 App JWT lists installations
 * and mints installation tokens, and installation tokens read repositories with REST and GraphQL.
 *
 * Requests go only to `https://api.github.com`, refuse redirects, time out after 10 seconds, and
 * read at most 4 MiB. Tokens stay in memory for their lifetime minus five minutes and are never
 * logged.
 */
export class GitHubAppHttpGateway implements GitHubAppGateway {
  /** App credentials. */
  private readonly credentials: GitHubAppCredentialSource

  /** HTTP client. */
  private readonly fetch: GitHubFetch

  /** Clock in milliseconds. */
  private readonly now: () => number

  /** Installation tokens by installation ID. */
  private readonly tokens = new Map<string, { token: string, expiresAt: number }>()

  /**
   * Creates the gateway.
   *
   * @param credentials - App credentials.
   * @param fetchImplementation - HTTP client.
   * @param now - Clock.
   */
  constructor(
    credentials: GitHubAppCredentialSource,
    fetchImplementation: GitHubFetch = (url, init) => fetch(url, init),
    now: () => number = Date.now,
  ) {
    this.credentials = credentials
    this.fetch = fetchImplementation
    this.now = now
  }

  /**
   * Lists the repositories of every installation.
   *
   * @returns Repositories and whether the listing stopped at its bound.
   */
  async listRepositories(): Promise<{ repositories: GitHubInstallationRepository[], incomplete: boolean }> {
    const credentials = await this.requireCredentials()
    const installations = await this.request('GET', `/app/installations?per_page=${INSTALLATIONS_MAX}`, { kind: 'app', credentials })
    if (installations.status !== 200 || !Array.isArray(installations.body)) throw unexpected('installations')
    let incomplete = installations.body.length >= INSTALLATIONS_MAX
    const repositories: GitHubInstallationRepository[] = []
    for (const installation of installations.body) {
      const installationId = isRecord(installation) ? readNumericId(installation.id) : undefined
      if (!installationId) throw unexpected('installation')
      for (let page = 1; page <= REPOSITORY_PAGES_MAX; page += 1) {
        const response = await this.request(
          'GET',
          `/installation/repositories?per_page=${PAGE_SIZE}&page=${page}`,
          { kind: 'installation', installationId },
        )
        if (response.status !== 200 || !isRecord(response.body) || !Array.isArray(response.body.repositories)) {
          throw unexpected('installation repositories')
        }
        for (const repository of response.body.repositories) {
          const parsed = parseRepository(repository, installationId)
          if (parsed) repositories.push(parsed)
        }
        const total = typeof response.body.total_count === 'number' ? response.body.total_count : 0
        if (response.body.repositories.length < PAGE_SIZE || page * PAGE_SIZE >= total) break
        if (page === REPOSITORY_PAGES_MAX) incomplete = true
      }
    }
    return { repositories, incomplete }
  }

  /**
   * Reads a repository's current name.
   *
   * @param reference - Installation and repository ID.
   * @returns `owner/repo`, or `null` when the installation cannot read the repository.
   */
  async readRepositoryName(reference: GitHubRepositoryReference): Promise<string | null> {
    if (!NUMERIC_ID_PATTERN.test(reference.repositoryId)) throw unexpected('repository ID')
    const response = await this.request('GET', `/repositories/${reference.repositoryId}`, {
      kind: 'installation',
      installationId: reference.installationId,
    }, [403, 404])
    if (response.status === 403 || response.status === 404) return null
    const parsed = parseRepository(response.body, reference.installationId)
    if (!parsed || parsed.repositoryId !== reference.repositoryId) throw unexpected('repository')
    return parsed.repository
  }

  /**
   * Reads pull requests by number with one GraphQL request.
   *
   * @param reference - Repository.
   * @param numbers - At most 20 numbers.
   * @param syncedAt - Read time.
   * @returns Snapshots and missing numbers.
   */
  async readPullRequests(
    reference: GitHubRepositoryReference,
    numbers: readonly number[],
    syncedAt: string,
  ): Promise<GitHubPullRequestReadResult> {
    if (
      numbers.length === 0 ||
      numbers.length > GITHUB_SYNC_JOB_MAX_NUMBERS ||
      numbers.some((number) => !Number.isSafeInteger(number) || number < 1)
    ) {
      throw unexpected('pull request numbers')
    }
    // The numbers are validated integers, so they are written into the query as aliases' arguments.
    const fields = numbers.map((number, index) => `pr${index}: pullRequest(number: ${number}) { ...PullRequestSnapshot }`).join('\n')
    const data = await this.graphql(
      reference,
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }${PULL_REQUEST_FRAGMENT}`,
      splitRepository(reference.repository),
      true,
    )
    const repository = requireRecord(data.repository, 'repository')
    const snapshots: GitHubPullRequestSnapshot[] = []
    const missing: number[] = []
    numbers.forEach((number, index) => {
      const node = repository[`pr${index}`]
      if (node === null || node === undefined) missing.push(number)
      else snapshots.push(parseNode(node, reference, syncedAt))
    })
    return { snapshots, missing }
  }

  /**
   * Reads the open pull requests whose head is a commit.
   *
   * @param reference - Repository.
   * @param sha - Commit SHA.
   * @param syncedAt - Read time.
   * @returns Snapshots.
   */
  async readCommitPullRequests(
    reference: GitHubRepositoryReference,
    sha: string,
    syncedAt: string,
  ): Promise<GitHubPullRequestSnapshot[]> {
    const data = await this.graphql(
      reference,
      `query($owner: String!, $name: String!, $sha: GitObjectID!) { repository(owner: $owner, name: $name) {
        object(oid: $sha) { ... on Commit { associatedPullRequests(first: 10) { nodes { ...PullRequestSnapshot } } } }
      } }${PULL_REQUEST_FRAGMENT}`,
      { ...splitRepository(reference.repository), sha },
      false,
    )
    const repository = requireRecord(data.repository, 'repository')
    const object = isRecord(repository.object) ? repository.object : {}
    // A commit pushed to a fork is also associated with pull requests of other repositories; only
    // this repository's pull requests are read, so one foreign node does not fail the whole job.
    return readNodes(object.associatedPullRequests)
      .filter((node) => isBaseRepository(node, reference.repositoryId))
      .map((node) => parseNode(node, reference, syncedAt))
      .filter((snapshot) => snapshot.state === 'open' && snapshot.headSha === sha)
  }

  /**
   * Reads open pull requests, most recently updated first.
   *
   * @param reference - Repository.
   * @param options - Base branch filter.
   * @param syncedAt - Read time.
   * @returns Snapshots and whether more exist.
   */
  async readOpenPullRequests(
    reference: GitHubRepositoryReference,
    options: { baseRef?: string },
    syncedAt: string,
  ): Promise<GitHubOpenPullRequestReadResult> {
    const snapshots: GitHubPullRequestSnapshot[] = []
    let after: string | null = null
    for (let page = 1; page <= OPEN_PULL_REQUESTS_PAGES_MAX; page += 1) {
      const data = await this.graphql(
        reference,
        `query($owner: String!, $name: String!, $base: String, $after: String) { repository(owner: $owner, name: $name) {
          pullRequests(states: OPEN, first: ${OPEN_PULL_REQUESTS_PAGE_SIZE}, after: $after, baseRefName: $base, orderBy: { field: UPDATED_AT, direction: DESC }) {
            pageInfo { hasNextPage endCursor } nodes { ...PullRequestSnapshot }
          }
        } }${PULL_REQUEST_FRAGMENT}`,
        { ...splitRepository(reference.repository), base: options.baseRef ?? null, after },
        false,
      )
      const repository = requireRecord(data.repository, 'repository')
      const connection = requireRecord(repository.pullRequests, 'pull requests')
      snapshots.push(...readNodes(connection).map((node) => parseNode(node, reference, syncedAt)))
      const pageInfo = isRecord(connection.pageInfo) ? connection.pageInfo : {}
      if (pageInfo.hasNextPage !== true) return { snapshots, incomplete: false }
      if (typeof pageInfo.endCursor !== 'string' || pageInfo.endCursor === '') {
        throw unexpected('pull request page cursor')
      }
      after = pageInfo.endCursor
    }
    return { snapshots, incomplete: true }
  }

  /**
   * Sends one GraphQL query with an installation token.
   *
   * @param reference - Repository whose installation authorizes the query.
   * @param query - Query text.
   * @param variables - Variables.
   * @param allowNotFound - Whether `NOT_FOUND` errors on individual fields are data (a missing pull request).
   * @returns The `data` object.
   */
  private async graphql(
    reference: GitHubRepositoryReference,
    query: string,
    variables: Record<string, unknown>,
    allowNotFound: boolean,
  ): Promise<Record<string, unknown>> {
    const response = await this.request('POST', '/graphql', {
      kind: 'installation',
      installationId: reference.installationId,
    }, [], { query, variables })
    if (response.status !== 200 || !isRecord(response.body)) throw unexpected('GraphQL response')
    const errors = Array.isArray(response.body.errors) ? response.body.errors : []
    const onlyMissingFields = allowNotFound && errors.every((error) =>
      isRecord(error) && error.type === 'NOT_FOUND' && Array.isArray(error.path) && error.path.length === 2)
    if (errors.length > 0 && !onlyMissingFields) {
      const types = errors.map((error) => (isRecord(error) && typeof error.type === 'string' ? error.type : 'UNKNOWN'))
      throw new GitHubIntegrationError('unavailable', 'GitHubGraphQLFailed', `GitHub GraphQL returned errors: ${types.slice(0, 5).join(', ')}.`, {
        retryable: !types.includes('NOT_FOUND'),
      })
    }
    return requireRecord(response.body.data, 'GraphQL data')
  }

  /**
   * Sends one request to the GitHub API.
   *
   * @param method - HTTP method.
   * @param path - Path and query under the API origin.
   * @param auth - App JWT or installation token.
   * @param allowedStatuses - Non-2xx statuses returned instead of thrown.
   * @param body - JSON body.
   * @returns Status and parsed body.
   */
  private async request(
    method: 'GET' | 'POST',
    path: string,
    auth: { kind: 'app', credentials: GitHubAppCredentials } | { kind: 'installation', installationId: string },
    allowedStatuses: readonly number[] = [],
    body?: unknown,
  ): Promise<GitHubResponse> {
    const authorization = auth.kind === 'app'
      ? `Bearer ${createGitHubAppJwt(auth.credentials, this.now())}`
      : `token ${await this.installationToken(auth.installationId)}`
    let response: Response
    try {
      response = await this.fetch(`${GITHUB_API_ORIGIN}${path}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MILLISECONDS),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: authorization,
          'User-Agent': 'mukuroji-github-app',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (error) {
      throw new GitHubIntegrationError('unavailable', 'GitHubRequestFailed', 'The GitHub request failed.', { cause: error })
    }
    const text = await readBoundedText(response)
    if (response.status === 401 && auth.kind === 'installation') this.tokens.delete(auth.installationId)
    if (isRateLimited(response)) {
      throw new GitHubIntegrationError('unavailable', 'GitHubRateLimited', `GitHub rate limited the request (${response.status}).`, {
        retryable: true,
      })
    }
    if (!response.ok && !allowedStatuses.includes(response.status)) {
      throw new GitHubIntegrationError('unavailable', 'GitHubRequestRejected', `GitHub answered ${response.status}.`, {
        retryable: response.status === 429 || response.status >= 500 || response.status === 401,
      })
    }
    if (text.length === 0) return { status: response.status, body: undefined }
    try {
      return { status: response.status, body: JSON.parse(text) }
    } catch (error) {
      throw new GitHubIntegrationError('unavailable', 'GitHubResponseMalformed', 'GitHub returned invalid JSON.', { cause: error })
    }
  }

  /**
   * Returns a live installation token, minting a new one when needed.
   *
   * @param installationId - Installation.
   * @returns The token.
   */
  private async installationToken(installationId: string): Promise<string> {
    if (!NUMERIC_ID_PATTERN.test(installationId)) throw unexpected('installation ID')
    const cached = this.tokens.get(installationId)
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_SECONDS * 1000 > this.now()) return cached.token
    const credentials = await this.requireCredentials()
    const response = await this.request('POST', `/app/installations/${installationId}/access_tokens`, { kind: 'app', credentials })
    const token = isRecord(response.body) ? response.body.token : undefined
    const expiresAt = isRecord(response.body) && typeof response.body.expires_at === 'string'
      ? Date.parse(response.body.expires_at)
      : Number.NaN
    if (response.status !== 201 || typeof token !== 'string' || token.length === 0 || !Number.isFinite(expiresAt)) {
      throw unexpected('installation token')
    }
    this.tokens.set(installationId, { token, expiresAt })
    return token
  }

  /**
   * Reads the credentials or fails when the App is not configured.
   *
   * @returns The credentials.
   */
  private async requireCredentials(): Promise<GitHubAppCredentials> {
    const credentials = await this.credentials.read()
    if (!credentials) {
      throw new GitHubIntegrationError('not-configured', 'GitHubAppNotConfigured', 'No GitHub App is configured for this deployment.')
    }
    return credentials
  }
}

/**
 * Creates the RS256 JWT that authenticates as the App for up to nine minutes.
 *
 * `iat` is a minute in the past to absorb clock drift, as GitHub recommends.
 *
 * @param credentials - App ID and private key.
 * @param nowMilliseconds - Current time.
 * @returns The JWT.
 */
export function createGitHubAppJwt(credentials: Pick<GitHubAppCredentials, 'appId' | 'privateKey'>, nowMilliseconds: number): string {
  const now = Math.floor(nowMilliseconds / 1000)
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: credentials.appId }))
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(credentials.privateKey)
  return `${header}.${payload}.${signature.toString('base64url')}`
}

/**
 * Encodes text as base64url.
 *
 * @param text - Text.
 * @returns The encoding.
 */
function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/**
 * Tells whether GitHub refused a request for its primary or secondary rate limit.
 *
 * GitHub answers either limit with 403 or 429 and marks it with `retry-after` or
 * `x-ratelimit-remaining: 0`; a plain 403 is a permission refusal instead.
 *
 * @param response - Response.
 * @returns Whether the response is a rate limit refusal.
 */
function isRateLimited(response: Response): boolean {
  if (response.status !== 403 && response.status !== 429) return false
  return response.headers.has('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'
}

/**
 * Reads a response body up to {@link RESPONSE_MAX_BYTES}.
 *
 * @param response - Response.
 * @returns The text.
 */
async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>
    try {
      chunk = await reader.read()
    } catch (error) {
      throw new GitHubIntegrationError('unavailable', 'GitHubRequestFailed', 'The GitHub response could not be read.', { cause: error })
    }
    const { done, value } = chunk
    if (done) break
    size += value.byteLength
    if (size > RESPONSE_MAX_BYTES) {
      await reader.cancel()
      throw new GitHubIntegrationError('unavailable', 'GitHubResponseTooLarge', 'The GitHub response is too large.', { retryable: false })
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * Parses one repository of a REST listing.
 *
 * @param value - REST repository object.
 * @param installationId - Installation it was read through.
 * @returns The repository, or `undefined` when it is malformed.
 */
function parseRepository(value: unknown, installationId: string): GitHubInstallationRepository | undefined {
  if (!isRecord(value)) return undefined
  const repositoryId = readNumericId(value.id)
  if (!repositoryId || typeof value.full_name !== 'string' || !REPOSITORY_NAME_PATTERN.test(value.full_name)) return undefined
  return { installationId, repositoryId, repository: value.full_name, private: value.private === true }
}

/**
 * Splits `owner/repo` into GraphQL variables.
 *
 * @param repository - `owner/repo`.
 * @returns Owner and name.
 */
function splitRepository(repository: string): { owner: string, name: string } {
  const match = REPOSITORY_NAME_PATTERN.exec(repository)
  if (!match) throw unexpected('repository name')
  return { owner: match[1], name: match[2] }
}

/**
 * Parses one pull request node, classifying a malformed node as a GitHub failure.
 *
 * @param node - GraphQL node.
 * @param reference - Repository it must belong to.
 * @param syncedAt - Read time.
 * @returns The snapshot.
 */
function parseNode(node: unknown, reference: GitHubRepositoryReference, syncedAt: string): GitHubPullRequestSnapshot {
  try {
    return parseGitHubPullRequestNode(node, reference, syncedAt)
  } catch (error) {
    throw new GitHubIntegrationError('unavailable', 'GitHubResponseMalformed', 'GitHub returned an unexpected pull request.', {
      cause: error,
      retryable: false,
    })
  }
}

/**
 * Tells whether a GraphQL pull request node belongs to the given repository.
 *
 * @param node - Untrusted node.
 * @param repositoryId - Numeric repository ID.
 * @returns Whether its base repository has that ID.
 */
function isBaseRepository(node: unknown, repositoryId: string): boolean {
  return isRecord(node) && isRecord(node.baseRepository) && readNumericId(node.baseRepository.databaseId) === repositoryId
}

/**
 * Reads the `nodes` of a GraphQL connection.
 *
 * @param value - Connection.
 * @returns The nodes.
 */
function readNodes(value: unknown): unknown[] {
  return isRecord(value) && Array.isArray(value.nodes) ? value.nodes : []
}

/**
 * Reads a GitHub numeric ID as a decimal string.
 *
 * @param value - Candidate.
 * @returns The ID, or `undefined`.
 */
function readNumericId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? String(value) : undefined
}

/**
 * Requires an object.
 *
 * @param value - Candidate.
 * @param label - Name for the error.
 * @returns The object.
 */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw unexpected(label)
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

/**
 * Builds the error of an unexpected GitHub answer.
 *
 * @param label - What was unexpected.
 * @returns The error.
 */
function unexpected(label: string): GitHubIntegrationError {
  return new GitHubIntegrationError('unavailable', 'GitHubResponseMalformed', `GitHub returned an unexpected ${label}.`, { retryable: false })
}
