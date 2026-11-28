import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { expect, test } from 'bun:test'
import { CachedGitHubAppCredentialSource, parseGitHubAppSecret } from '../secrets-manager/github-app-credential-source'
import { createGitHubAppJwt, GitHubAppHttpGateway, type GitHubFetch } from './github-app-gateway'

/** RSA key of the fake App. */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

/** Secret JSON of the fake App. */
const secret = JSON.stringify({ appId: '123', privateKey: privateKeyPem, webhookSecret: 'webhook-secret-of-at-least-20-characters' })

/**
 * Builds a JSON response.
 *
 * @param status - HTTP status.
 * @param body - JSON body.
 * @returns The response.
 */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

test('parses the App secret and treats the stack placeholder as not configured', () => {
  expect(parseGitHubAppSecret(secret)).toMatchObject({ appId: '123', webhookSecrets: ['webhook-secret-of-at-least-20-characters'] })
  expect(parseGitHubAppSecret(JSON.stringify({ placeholder: 'generated' }))).toBeNull()
  expect(() => parseGitHubAppSecret(JSON.stringify({ appId: '123' }))).toThrow('GitHub App secret must hold')
  expect(() => parseGitHubAppSecret(JSON.stringify({ appId: '123', privateKey: 'not a key', webhookSecret: 'webhook-secret-of-at-least-20-characters' })))
    .toThrow('GitHub App secret must hold')
  expect(() => parseGitHubAppSecret(JSON.stringify({ appId: '123', privateKey: privateKeyPem, webhookSecret: 'short' }))).toThrow('GitHub App secret must hold')
  expect(parseGitHubAppSecret(JSON.stringify({ ...JSON.parse(secret), previousWebhookSecret: 'previous-secret-of-20-characters' }))?.webhookSecrets)
    .toEqual(['webhook-secret-of-at-least-20-characters', 'previous-secret-of-20-characters'])
})

test('reuses the read secret for five minutes and retries a failed read', async () => {
  let now = 0
  let reads = 0
  let fail = true
  const source = new CachedGitHubAppCredentialSource(async () => {
    reads += 1
    if (fail) throw new Error('throttled')
    return secret
  }, () => now)
  await expect(source.read()).rejects.toMatchObject({ code: 'GitHubAppCredentialsUnavailable' })
  fail = false
  expect((await source.read())?.appId).toBe('123')
  now = 4 * 60_000
  await source.read()
  expect(reads).toBe(2)
  now = 6 * 60_000
  await source.read()
  expect(reads).toBe(3)
})

test('signs the App JWT with RS256 for the App ID', () => {
  const jwt = createGitHubAppJwt({ appId: '123', privateKey: privateKeyPem }, 1_700_000_000_000)
  const [header, payload, signature] = jwt.split('.')
  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
  expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: '123' })
  expect(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), createPublicKey(privateKey), Buffer.from(signature, 'base64url'))).toBe(true)
})

test('mints one installation token, reads pull requests by number, and reports missing ones', async () => {
  const requests: { url: string, authorization: string, body?: unknown, redirect?: string }[] = []
  const fetchImplementation: GitHubFetch = async (url, init) => {
    const headers = new Headers(init.headers)
    requests.push({
      url,
      authorization: headers.get('Authorization') ?? '',
      ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}),
      ...(init.redirect ? { redirect: init.redirect } : {}),
    })
    if (url.endsWith('/app/installations/7/access_tokens')) {
      return json(201, { token: 'ghs_installation', expires_at: '2026-11-28T02:00:00Z' })
    }
    if (url.endsWith('/graphql')) {
      return json(200, {
        data: {
          repository: {
            pr0: {
              number: 5,
              title: 'Title',
              url: 'https://github.com/acme/app/pull/5',
              state: 'OPEN',
              isDraft: false,
              createdAt: '2026-11-27T00:00:00Z',
              updatedAt: '2026-11-28T00:00:00Z',
              headRefName: 'feature',
              baseRefName: 'main',
              headRefOid: 'a'.repeat(40),
              mergeable: 'CONFLICTING',
              reviewDecision: null,
              baseRepository: { databaseId: 42, nameWithOwner: 'acme/app' },
              author: { login: 'alice' },
              reviewRequests: { nodes: [] },
              latestOpinionatedReviews: { nodes: [] },
              commits: { nodes: [] },
            },
            pr1: null,
          },
        },
        errors: [{ type: 'NOT_FOUND', path: ['repository', 'pr1'], message: 'Could not resolve' }],
      })
    }
    return json(404, {})
  }
  const gateway = new GitHubAppHttpGateway(new CachedGitHubAppCredentialSource(async () => secret), fetchImplementation, () => Date.parse('2026-11-28T01:00:00Z'))
  const reference = { installationId: '7', repositoryId: '42', repository: 'acme/app' }
  const result = await gateway.readPullRequests(reference, [5, 6], '2026-11-28T01:00:00.000Z')
  expect(result.missing).toEqual([6])
  expect(result.snapshots).toMatchObject([{ number: 5, mergeable: 'conflicting', reviewDecision: 'none', checks: { state: 'none' } }])
  await gateway.readPullRequests(reference, [5, 6], '2026-11-28T01:00:00.000Z')
  expect(requests.map((request) => request.url)).toEqual([
    'https://api.github.com/app/installations/7/access_tokens',
    'https://api.github.com/graphql',
    'https://api.github.com/graphql',
  ])
  expect(requests[0].authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/u)
  expect(requests[1].authorization).toBe('token ghs_installation')
  expect(requests.every((request) => request.redirect === 'error')).toBe(true)
  expect(requests[1].body).toMatchObject({ variables: { owner: 'acme', name: 'app' } })
  await expect(gateway.readPullRequests(reference, [], 'now')).rejects.toMatchObject({ code: 'GitHubResponseMalformed' })
})

test('fails a GraphQL error other than a missing pull request', async () => {
  const fetchImplementation: GitHubFetch = async (url) => url.endsWith('/access_tokens')
    ? json(201, { token: 'ghs_installation', expires_at: '2026-11-28T02:00:00Z' })
    : json(200, { data: { repository: null }, errors: [{ type: 'RATE_LIMITED', path: ['repository'] }] })
  const gateway = new GitHubAppHttpGateway(new CachedGitHubAppCredentialSource(async () => secret), fetchImplementation, () => Date.parse('2026-11-28T01:00:00Z'))
  await expect(gateway.readOpenPullRequests({ installationId: '7', repositoryId: '42', repository: 'acme/app' }, {}, 'now'))
    .rejects.toMatchObject({ code: 'GitHubGraphQLFailed', retryable: true })
})

test('retries a rate limited 403 but treats a plain 403 as a repository the installation cannot read', async () => {
  let answer: Response = json(403, { message: 'Resource not accessible by integration' })
  const fetchImplementation: GitHubFetch = async (url) => url.endsWith('/access_tokens')
    ? json(201, { token: 'ghs_installation', expires_at: '2026-11-28T02:00:00Z' })
    : answer
  const gateway = new GitHubAppHttpGateway(new CachedGitHubAppCredentialSource(async () => secret), fetchImplementation, () => Date.parse('2026-11-28T01:00:00Z'))
  const reference = { installationId: '7', repositoryId: '42', repository: 'acme/app' }
  expect(await gateway.readRepositoryName(reference)).toBeNull()
  answer = new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
  await expect(gateway.readRepositoryName(reference)).rejects.toMatchObject({ code: 'GitHubRateLimited', retryable: true })
  answer = new Response('{}', { status: 403, headers: { 'retry-after': '60' } })
  await expect(gateway.readRepositoryName(reference)).rejects.toMatchObject({ code: 'GitHubRateLimited', retryable: true })
})

test('classifies a response body that fails while it is read', async () => {
  const fetchImplementation: GitHubFetch = async (url) => url.endsWith('/access_tokens')
    ? json(201, { token: 'ghs_installation', expires_at: '2026-11-28T02:00:00Z' })
    : new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError('socket closed')) } }), { status: 200 })
  const gateway = new GitHubAppHttpGateway(new CachedGitHubAppCredentialSource(async () => secret), fetchImplementation, () => Date.parse('2026-11-28T01:00:00Z'))
  await expect(gateway.readRepositoryName({ installationId: '7', repositoryId: '42', repository: 'acme/app' }))
    .rejects.toMatchObject({ code: 'GitHubRequestFailed', retryable: true })
})

test('refuses to call GitHub without a configured App', async () => {
  const gateway = new GitHubAppHttpGateway(new CachedGitHubAppCredentialSource(async () => undefined), async () => json(200, {}))
  await expect(gateway.listRepositories()).rejects.toMatchObject({ code: 'GitHubAppNotConfigured' })
})

test('reads only this repository\'s pull requests among those associated with a commit', async () => {
  const sha = 'b'.repeat(40)
  /**
   * Builds an open pull request node of a repository.
   *
   * @param number - Pull request number.
   * @param repositoryId - Base repository ID.
   * @returns The node.
   */
  const pullRequest = (number: number, repositoryId: number) => ({
    number,
    title: 'Title',
    url: `https://github.com/acme/app/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-28T00:00:00Z',
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: sha,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    baseRepository: { databaseId: repositoryId, nameWithOwner: repositoryId === 42 ? 'acme/app' : 'fork/app' },
    author: { login: 'alice' },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [] },
  })
  const fetchImplementation: GitHubFetch = async (url) => url.endsWith('/access_tokens')
    ? json(201, { token: 'ghs_installation', expires_at: '2026-11-28T02:00:00Z' })
    : json(200, { data: { repository: { object: { associatedPullRequests: { nodes: [pullRequest(9, 43), pullRequest(5, 42)] } } } } })
  const gateway = new GitHubAppHttpGateway(new CachedGitHubAppCredentialSource(async () => secret), fetchImplementation, () => Date.parse('2026-11-28T01:00:00Z'))
  const snapshots = await gateway.readCommitPullRequests({ installationId: '7', repositoryId: '42', repository: 'acme/app' }, sha, 'now')
  expect(snapshots.map((snapshot) => snapshot.number)).toEqual([5])
})

test('follows the pages of open pull requests', async () => {
  /**
   * Builds an open pull request node.
   *
   * @param number - Pull request number.
   * @returns The node.
   */
  const pullRequest = (number: number) => ({
    number,
    title: 'Title',
    url: `https://github.com/acme/app/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-28T00:00:00Z',
    headRefName: 'feature',
    baseRefName: 'main',
    headRefOid: 'c'.repeat(40),
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    baseRepository: { databaseId: 42, nameWithOwner: 'acme/app' },
    author: { login: 'alice' },
    reviewRequests: { nodes: [] },
    latestOpinionatedReviews: { nodes: [] },
    commits: { nodes: [] },
  })
  const cursors: unknown[] = []
  const fetchImplementation: GitHubFetch = async (url, init) => {
    if (url.endsWith('/access_tokens')) return json(201, { token: 'ghs_installation', expires_at: '2026-11-28T02:00:00Z' })
    const body: unknown = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
    const after = typeof body === 'object' && body !== null && 'variables' in body &&
      typeof body.variables === 'object' && body.variables !== null && 'after' in body.variables ? body.variables.after : undefined
    cursors.push(after)
    const first = after === null
    return json(200, { data: { repository: { pullRequests: {
      pageInfo: { hasNextPage: first, endCursor: first ? 'page-2' : null },
      nodes: [pullRequest(first ? 7 : 3)],
    } } } })
  }
  const gateway = new GitHubAppHttpGateway(new CachedGitHubAppCredentialSource(async () => secret), fetchImplementation, () => Date.parse('2026-11-28T01:00:00Z'))
  const result = await gateway.readOpenPullRequests({ installationId: '7', repositoryId: '42', repository: 'acme/app' }, {}, 'now')
  expect(cursors).toEqual([null, 'page-2'])
  expect(result.snapshots.map((snapshot) => snapshot.number)).toEqual([7, 3])
  expect(result.incomplete).toBe(false)
})
