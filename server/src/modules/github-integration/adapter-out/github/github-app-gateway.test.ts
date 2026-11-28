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

test('refuses to call GitHub without a configured App', async () => {
  const gateway = new GitHubAppHttpGateway(new CachedGitHubAppCredentialSource(async () => undefined), async () => json(200, {}))
  await expect(gateway.listRepositories()).rejects.toMatchObject({ code: 'GitHubAppNotConfigured' })
})
