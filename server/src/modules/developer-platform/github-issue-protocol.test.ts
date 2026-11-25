import { describe, expect, test } from 'bun:test'
import type { ConnectorProviderRequest } from './connector-resource-protocol'
import { createOAuthConnectorRegistryFromEnvironment, isConnectorOAuthAdapter } from './connector-oauth'
import { GitHubIssueProtocol } from './github-issue-protocol'

/**
 * Builds a requester that answers from a queue and records the requests.
 *
 * @param responses - Responses in order.
 * @returns The requester and the requests it received.
 */
function createRequester(responses: Array<{ status: number, payload: unknown }>) {
  const requests: ConnectorProviderRequest[] = []
  return {
    requests,
    request: async (request: ConnectorProviderRequest) => {
      requests.push(request)
      const response = responses.shift()
      if (!response) throw new Error('No response queued.')
      return response
    },
  }
}

/**
 * Builds a GitHub issue payload.
 *
 * @param overrides - Fields to replace.
 * @returns Issue payload.
 */
function issue(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    html_url: 'https://github.com/acme/app/issues/12',
    updated_at: '2026-11-25T10:00:00Z',
    title: 'Fix login',
    body: 'Steps to reproduce',
    state: 'open',
    repository: { full_name: 'acme/app' },
    ...overrides,
  }
}

describe('GitHub issue protocol', () => {
  test('lists issues across repositories without pull requests and pages by number', async () => {
    const protocol = new GitHubIssueProtocol()
    const fullPage: unknown[] = Array.from({ length: 100 }, (_, index) => issue({ number: index + 1 }))
    fullPage[1] = issue({ number: 2, pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/2' } })
    const { request, requests } = createRequester([{ status: 200, payload: fullPage }, { status: 200, payload: [issue()] }])

    const first = await protocol.pull(request, 'issue')
    expect(first.items).toHaveLength(99)
    expect(first.items[0]).toMatchObject({
      externalId: 'acme/app#1',
      displayKey: 'acme/app#1',
      resourceType: 'issue',
      state: 'open',
      description: 'Steps to reproduce',
    })
    expect(first.nextCursor).toBe('2')
    expect(requests[0]).toMatchObject({ method: 'GET', path: 'issues', query: { filter: 'all', state: 'all', page: '1' } })

    const second = await protocol.pull(request, 'issue', first.nextCursor)
    expect(second.nextCursor).toBeUndefined()
    expect(requests[1]?.query?.page).toBe('2')
  })

  test('has no records for pull requests, commits, or deploys and refuses to write them', async () => {
    const protocol = new GitHubIssueProtocol()
    const { request, requests } = createRequester([])
    expect(await protocol.pull(request, 'merge-request')).toEqual({ items: [] })
    expect(requests).toHaveLength(0)
    await expect(protocol.read(request, 'merge-request', 'acme/app#1')).rejects.toMatchObject({ code: 'ConnectorResourceUnsupported' })
    await expect(protocol.create()).rejects.toMatchObject({ code: 'ConnectorResourceCreateUnsupported' })
  })

  test('reads one issue, strips the origin marker, and reports a missing issue', async () => {
    const protocol = new GitHubIssueProtocol()
    const { request, requests } = createRequester([
      { status: 200, payload: issue({ repository: undefined, state: 'closed', body: 'Done\r\n\n<!-- mukuroji-origin:v1.abc.def -->' }) },
      { status: 404, payload: { message: 'Not Found' } },
    ])
    const record = await protocol.read(request, 'issue', 'acme/app#12')
    expect(record).toMatchObject({ externalId: 'acme/app#12', state: 'closed', description: 'Done', originMarker: 'v1.abc.def' })
    expect(requests[0]?.path).toBe('repos/acme/app/issues/12')
    await expect(protocol.read(request, 'issue', 'acme/app#13')).rejects.toMatchObject({ code: 'ConnectorExternalResourceMissing' })
  })

  test('rejects external IDs that are not owner/repository#number', async () => {
    const protocol = new GitHubIssueProtocol()
    const { request } = createRequester([])
    for (const externalId of ['acme/app', 'acme/app#0', '../x#1', 'acme/app/extra#1', 'https://github.com/acme/app/issues/1']) {
      await expect(protocol.read(request, 'issue', externalId)).rejects.toMatchObject({ code: 'ConnectorExternalIdInvalid' })
    }
  })

  test('closes the issue for a completed or canceled Work Item and reopens it otherwise', async () => {
    const protocol = new GitHubIssueProtocol()
    const { request, requests } = createRequester([
      { status: 200, payload: issue({ state: 'closed' }) },
      { status: 200, payload: issue({ state: 'closed' }) },
      { status: 200, payload: issue() },
    ])
    const mutation = {
      externalId: 'acme/app#12',
      resourceType: 'issue' as const,
      workItemRevision: 4,
      title: 'Fix login',
      description: 'Use --> safely',
      originMarker: 'v1.payload.signature',
      operationId: 'operation-1',
    }
    await protocol.push(request, { ...mutation, statusCategory: 'completed' })
    await protocol.push(request, { ...mutation, statusCategory: 'canceled' })
    await protocol.push(request, { ...mutation, statusCategory: 'started' })
    expect(requests.map((entry) => entry.body)).toEqual([
      { title: 'Fix login', body: 'Use -- > safely\n\n<!-- mukuroji-origin:v1.payload.signature -->', state: 'closed', state_reason: 'completed' },
      { title: 'Fix login', body: 'Use -- > safely\n\n<!-- mukuroji-origin:v1.payload.signature -->', state: 'closed', state_reason: 'not_planned' },
      { title: 'Fix login', body: 'Use -- > safely\n\n<!-- mukuroji-origin:v1.payload.signature -->', state: 'open' },
    ])
    expect(requests[0]).toMatchObject({ method: 'PATCH', path: 'repos/acme/app/issues/12' })
  })
})

describe('bundled GitHub connector settings', () => {
  test('configures GitHub from the client ID, secret variable, and redirect URI alone', () => {
    const registry = createOAuthConnectorRegistryFromEnvironment({
      environment: {
        MUKUROJI_CONNECTOR_PROVIDERS_JSON: JSON.stringify([{
          provider: 'github',
          clientId: 'github-client',
          clientSecretEnvironmentVariable: 'MUKUROJI_CONNECTOR_GITHUB_SECRET',
          redirectUri: 'https://app.example.test/api/developer/connector-oauth/callback',
        }]),
        MUKUROJI_CONNECTOR_GITHUB_SECRET: 'secret',
      },
    })
    expect(registry.listProviders()).toEqual(['github'])
    const adapter = registry.get('github')
    if (!isConnectorOAuthAdapter(adapter)) throw new Error('GitHub adapter must support OAuth.')
    const url = new URL(adapter.createAuthorizationUrl({ state: 'state', codeChallenge: 'challenge', scopes: [] }))
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('scope')).toBe('repo')
    expect(url.searchParams.get('client_id')).toBe('github-client')
  })

  test('keeps operator REST mappings for GitHub instead of the bundled issue sync', () => {
    expect(() => createOAuthConnectorRegistryFromEnvironment({
      environment: {
        MUKUROJI_CONNECTOR_PROVIDERS_JSON: JSON.stringify([{
          provider: 'github',
          clientId: 'github-client',
          clientSecretEnvironmentVariable: 'MUKUROJI_CONNECTOR_GITHUB_SECRET',
          redirectUri: 'https://app.example.test/api/developer/connector-oauth/callback',
          resources: { issue: { collectionPath: 'x', itemPath: 'x/{externalId}', itemsPath: 'items', record: {}, mutation: {} } },
        }]),
        MUKUROJI_CONNECTOR_GITHUB_SECRET: 'secret',
      },
    })).toThrow()
  })
})
