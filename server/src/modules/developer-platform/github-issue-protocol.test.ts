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
    // Pages hold eight issues, so the largest bodies stay within the 2 MiB response limit.
    const fullPage: unknown[] = Array.from({ length: 8 }, (_, index) => issue({ number: index + 1 }))
    fullPage[1] = issue({ number: 2, pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/2' } })
    const { request, requests } = createRequester([{ status: 200, payload: fullPage }, { status: 200, payload: [issue()] }])

    const first = await protocol.pull(request, 'issue')
    expect(first.items).toHaveLength(7)
    expect(first.items[0]).toMatchObject({
      externalId: 'acme/app#1',
      displayKey: 'acme/app#1',
      resourceType: 'issue',
      state: 'open',
      description: 'Steps to reproduce',
    })
    expect(first.nextCursor).toBe('2')
    expect(requests[0]).toMatchObject({ method: 'GET', path: 'issues', query: { filter: 'all', state: 'all', per_page: '8', page: '1' } })

    const second = await protocol.pull(request, 'issue', first.nextCursor)
    expect(second.nextCursor).toBeUndefined()
    expect(requests[1]?.query?.page).toBe('2')
  })

  test('keeps paging past ten thousand issues while GitHub returns full pages', async () => {
    const protocol = new GitHubIssueProtocol()
    const fullPage = Array.from({ length: 8 }, (_, index) => issue({ number: 20_000 + index }))
    const { request, requests } = createRequester([{ status: 200, payload: fullPage }])
    const page = await protocol.pull(request, 'issue', '1250')
    expect(requests[0]?.query?.page).toBe('1250')
    expect(page.nextCursor).toBe('1251')
    await expect(protocol.pull(request, 'issue', '0')).rejects.toMatchObject({ code: 'ConnectorProviderResponseMalformed' })
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
      { status: 200, payload: issue() },
      { status: 200, payload: issue({ state: 'closed' }) },
      { status: 200, payload: issue({ state: 'closed' }) },
      { status: 200, payload: issue({ state: 'closed' }) },
      { status: 200, payload: issue({ state: 'closed' }) },
      { status: 200, payload: issue() },
    ])
    const mutation = {
      externalId: 'acme/app#12',
      resourceType: 'issue' as const,
      workItemRevision: 4,
      title: 'Fix login',
      description: 'Use <!-- note --> safely',
      originMarker: 'v1.payload.signature',
      operationId: 'operation-1',
    }
    await protocol.push(request, { ...mutation, statusCategory: 'completed' })
    await protocol.push(request, { ...mutation, statusCategory: 'canceled' })
    await protocol.push(request, { ...mutation, statusCategory: 'started' })
    // Every write reads the issue first, so only the PATCH requests carry a body.
    expect(requests.filter((entry) => entry.method === 'PATCH').map((entry) => entry.body)).toEqual([
      { title: 'Fix login', body: 'Use <!-- note --> safely\n\n<!-- mukuroji-origin:v1.payload.signature -->', state: 'closed', state_reason: 'completed' },
      { title: 'Fix login', body: 'Use <!-- note --> safely\n\n<!-- mukuroji-origin:v1.payload.signature -->', state: 'closed', state_reason: 'not_planned' },
      { title: 'Fix login', body: 'Use <!-- note --> safely\n\n<!-- mukuroji-origin:v1.payload.signature -->', state: 'open' },
    ])
    expect(requests[0]).toMatchObject({ method: 'GET', path: 'repos/acme/app/issues/12' })
    expect(requests[1]).toMatchObject({ method: 'PATCH', path: 'repos/acme/app/issues/12' })
  })

  test('refuses to write a pull request through an issue link', async () => {
    const protocol = new GitHubIssueProtocol()
    const { request, requests } = createRequester([
      { status: 200, payload: issue({ pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/12' } }) },
      { status: 200, payload: issue({ pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/12' } }) },
    ])
    const mutation = {
      externalId: 'acme/app#12',
      resourceType: 'issue' as const,
      workItemRevision: 4,
      title: 'Fix login',
      originMarker: 'v1.payload.signature',
      operationId: 'operation-1',
      statusCategory: 'started',
    }
    await expect(protocol.push(request, mutation)).rejects.toMatchObject({ code: 'ConnectorResourceUnsupported' })
    expect(requests.map((entry) => entry.method)).toEqual(['GET'])
    await expect(protocol.read(request, 'issue', 'acme/app#12')).rejects.toMatchObject({ code: 'ConnectorResourceUnsupported' })
  })

  test('keeps a title of 256 characters, counting emoji as one, and refuses a longer one', async () => {
    const protocol = new GitHubIssueProtocol()
    const { request, requests } = createRequester([
      { status: 200, payload: issue() },
      { status: 200, payload: issue() },
    ])
    const mutation = {
      externalId: 'acme/app#12',
      resourceType: 'issue' as const,
      workItemRevision: 4,
      originMarker: 'v1.payload.signature',
      operationId: 'operation-1',
      statusCategory: 'started',
    }
    const title = '🚀'.repeat(256)
    await protocol.push(request, { ...mutation, title })
    expect(requests[1]?.body).toMatchObject({ title })
    await expect(protocol.push(request, { ...mutation, title: `${title}x` })).rejects.toMatchObject({ code: 'ConnectorRecordTooLarge' })
    expect(requests).toHaveLength(2)
  })

  test('refuses a description longer than an issue can take instead of shortening it', async () => {
    const protocol = new GitHubIssueProtocol()
    const { request, requests } = createRequester([])
    await expect(protocol.push(request, {
      externalId: 'acme/app#12',
      resourceType: 'issue',
      workItemRevision: 4,
      title: 'Fix login',
      description: 'x'.repeat(60_001),
      originMarker: 'v1.payload.signature',
      operationId: 'operation-1',
      statusCategory: 'started',
    })).rejects.toMatchObject({ code: 'ConnectorRecordTooLarge' })
    expect(requests).toHaveLength(0)
  })

  test('refuses to overwrite an issue edited since its expected version', async () => {
    const protocol = new GitHubIssueProtocol()
    const current = issue()
    const version = typeof current.updated_at === 'string' ? current.updated_at : ''
    const { request, requests } = createRequester([
      { status: 200, payload: current },
      { status: 200, payload: current },
      { status: 200, payload: current },
    ])
    const mutation = {
      externalId: 'acme/app#12',
      resourceType: 'issue' as const,
      workItemRevision: 4,
      title: 'Fix login',
      originMarker: 'v1.payload.signature',
      operationId: 'operation-1',
      statusCategory: 'started',
    }
    await expect(protocol.push(request, { ...mutation, expectedExternalVersion: '2020-01-01T00:00:00Z' }))
      .rejects.toMatchObject({ code: 'ConnectorExternalVersionChanged' })
    expect(requests.map((entry) => entry.method)).toEqual(['GET'])
    await protocol.push(request, { ...mutation, expectedExternalVersion: version })
    expect(requests.map((entry) => entry.method)).toEqual(['GET', 'GET', 'PATCH'])
  })

  test('returns its own completed write on a retry instead of reporting a changed issue', async () => {
    const protocol = new GitHubIssueProtocol()
    const mutation = {
      externalId: 'acme/app#12',
      resourceType: 'issue' as const,
      workItemRevision: 4,
      title: 'Fix login',
      description: 'Steps to reproduce',
      originMarker: 'v1.payload.signature',
      operationId: 'operation-1',
      statusCategory: 'completed',
      expectedExternalVersion: '2026-11-25T10:00:00Z',
    }
    // The first PATCH landed but its response was lost: the issue holds this write's marker.
    const written = issue({
      updated_at: '2026-11-25T11:00:00Z',
      state: 'closed',
      body: 'Steps to reproduce\n\n<!-- mukuroji-origin:v1.payload.signature -->',
    })
    const replay = createRequester([{ status: 200, payload: written }])
    expect(await protocol.push(replay.request, mutation)).toMatchObject({
      externalVersion: '2026-11-25T11:00:00Z',
      state: 'closed',
      originMarker: 'v1.payload.signature',
    })
    expect(replay.requests.map((entry) => entry.method)).toEqual(['GET'])

    // An edit that kept the marker but changed the contents is still a change.
    const edited = createRequester([{ status: 200, payload: { ...written, title: 'Fix login on Safari' } }])
    await expect(protocol.push(edited.request, mutation)).rejects.toMatchObject({ code: 'ConnectorExternalVersionChanged' })
    // Another write's marker is a change too.
    const other = createRequester([{
      status: 200,
      payload: { ...written, body: 'Steps to reproduce\n\n<!-- mukuroji-origin:v1.other.signature -->' },
    }])
    await expect(protocol.push(other.request, mutation)).rejects.toMatchObject({ code: 'ConnectorExternalVersionChanged' })
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

  test('disconnects by revoking only the stored GitHub token with client credentials', async () => {
    const calls: { url: string, init?: RequestInit }[] = []
    let status = 204
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
      fetch: Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), ...(init ? { init } : {}) })
        return new Response(null, { status })
      }, { preconnect: () => undefined }),
    })
    const adapter = registry.get('github')
    if (!isConnectorOAuthAdapter(adapter)) throw new Error('GitHub adapter must support OAuth.')
    const credential = { accessToken: 'gho_token', externalAccountId: '1', scopes: ['repo'] }
    await adapter.disconnect(credential)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.github.com/applications/github-client/token')
    expect(calls[0]?.init?.method).toBe('DELETE')
    expect(new Headers(calls[0]?.init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from('github-client:secret').toString('base64')}`)
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ access_token: 'gho_token' }))
    // A token GitHub no longer has is already revoked; other failures are reported.
    status = 404
    await adapter.disconnect(credential)
    status = 500
    await expect(adapter.disconnect(credential)).rejects.toBeDefined()
  })

  test('keeps operator REST mappings for GitHub instead of the bundled issue sync', async () => {
    const binding = {
      collectionPath: 'operator/issues',
      itemPath: 'operator/issues/{externalId}',
      itemsPath: 'items',
      record: {
        externalId: 'id',
        externalUrl: 'url',
        externalVersion: 'version',
        title: 'title',
        description: 'body',
        status: 'state',
        originMarker: 'origin',
      },
      mutation: { title: 'title', description: 'body', status: 'state', originMarker: 'origin' },
    }
    const urls: string[] = []
    const registry = createOAuthConnectorRegistryFromEnvironment({
      environment: {
        MUKUROJI_CONNECTOR_PROVIDERS_JSON: JSON.stringify([{
          provider: 'github',
          clientId: 'github-client',
          clientSecretEnvironmentVariable: 'MUKUROJI_CONNECTOR_GITHUB_SECRET',
          redirectUri: 'https://app.example.test/api/developer/connector-oauth/callback',
          authorizationEndpoint: 'https://git.example.test/oauth/authorize',
          tokenEndpoint: 'https://git.example.test/oauth/token',
          apiBaseUrl: 'https://git.example.test/api/',
          defaultScopes: ['repo'],
          token: { accessToken: 'access_token', externalAccountId: 'account_id' },
          resources: { issue: binding, 'merge-request': binding, commit: binding, deploy: binding },
          allowedHosts: ['app.example.test', 'git.example.test'],
        }]),
        MUKUROJI_CONNECTOR_GITHUB_SECRET: 'secret',
      },
      fetch: Object.assign(async (input: string | URL | Request) => {
        urls.push(String(input))
        return Response.json({ items: [] })
      }, { preconnect: () => undefined }),
    })
    const adapter = registry.get('github')
    const page = await adapter.pull({ accessToken: 'token', externalAccountId: '1', scopes: ['repo'] }, 'issue')
    expect(page).toEqual({ items: [] })
    expect(urls).toEqual(['https://git.example.test/api/operator/issues'])
  })
})
