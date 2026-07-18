import { describe, expect, test } from 'bun:test'
import {
  DeleteCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  BUILT_IN_CONNECTOR_CATALOG,
} from './connectors'
import {
  ConfiguredOAuthConnectorAdapter,
  ConnectorRuntimeError,
  createOAuthConnectorRegistryFromEnvironment,
  deserializeConnectorCredential,
  serializeConnectorCredential,
  type ConfiguredOAuthConnectorOptions,
} from './connector-oauth'
import {
  ConnectorOAuthStateManager,
  DynamoDbConnectorOAuthStateStore,
  InMemoryConnectorOAuthStateStore,
} from './connector-oauth-state'

const NOW = new Date('2026-07-18T00:00:00.000Z')

function createProviderOptions(fetcher: typeof fetch): ConfiguredOAuthConnectorOptions {
  const resourceBinding = {
    collectionPath: 'issues',
    itemPath: 'issues/{externalId}',
    itemsPath: 'data.items',
    nextCursorPath: 'page.next',
    cursorParameter: 'after',
    record: {
      externalId: 'id',
      externalUrl: 'html_url',
      externalVersion: 'updated_at',
      displayKey: 'number',
      title: 'title',
      description: 'body',
      status: 'state',
      originMarker: 'mukuroji_origin',
      metadata: ['number'],
    },
    mutation: {
      title: 'title',
      description: 'body',
      status: 'state',
      originMarker: 'mukuroji_origin',
    },
    idempotencyHeader: 'Idempotency-Key',
    versionHeader: 'If-Match',
  } as const
  return {
    definition: BUILT_IN_CONNECTOR_CATALOG[0]!,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    redirectUri: 'https://app.test/api/connectors/oauth/callback',
    authorizationEndpoint: 'https://provider.test/oauth/authorize',
    tokenEndpoint: 'https://provider.test/oauth/token',
    revocationEndpoint: 'https://provider.test/oauth/revoke',
    accountEndpoint: 'https://provider.test/api/me',
    apiBaseUrl: 'https://provider.test/api/',
    defaultScopes: ['repo'],
    token: {
      accessToken: 'access_token',
      refreshToken: 'refresh_token',
      expiresInSeconds: 'expires_in',
      scopes: 'scope',
    },
    account: {
      externalAccountId: 'id',
      externalAccountName: 'login',
    },
    resources: Object.fromEntries(
      BUILT_IN_CONNECTOR_CATALOG[0]!.resourceTypes.map((resourceType) => [
        resourceType,
        structuredClone(resourceBinding),
      ]),
    ),
    allowedHosts: ['app.test', 'provider.test'],
    fetch: fetcher,
    clock: () => NOW,
  }
}

describe('ConfiguredOAuthConnectorAdapter', () => {
  test('uses signed state + PKCE and exchanges a code without exposing secrets in URLs', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith('/oauth/token')) {
        return Response.json({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 3_600,
          scope: 'repo issues:write',
        })
      }
      if (url.endsWith('/api/me')) {
        return Response.json({ id: 42, login: 'octocat' })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }) as typeof fetch
    const adapter = new ConfiguredOAuthConnectorAdapter(
      createProviderOptions(fetcher),
    )

    const authorizationUrl = new URL(adapter.createAuthorizationUrl({
      state: 'signed-state',
      codeChallenge: 'pkce-challenge',
      scopes: ['repo'],
    }))
    expect(authorizationUrl.searchParams.get('state')).toBe('signed-state')
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe('pkce-challenge')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.toString()).not.toContain('client-secret')

    const credential = await adapter.connect({
      code: 'authorization-code',
      state: 'signed-state',
      codeVerifier: 'pkce-verifier',
      redirectUri: 'https://app.test/api/connectors/oauth/callback',
      requestedScopes: ['repo'],
    })
    expect(credential).toEqual({
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: '2026-07-18T01:00:00.000Z',
      externalAccountId: '42',
      externalAccountName: 'octocat',
      scopes: ['issues:write', 'repo'],
    })
    const tokenBody = requests[0]!.init!.body as URLSearchParams
    expect(tokenBody.get('code_verifier')).toBe('pkce-verifier')
    expect(tokenBody.get('client_secret')).toBe('client-secret')
    expect(requests[0]!.url).not.toContain('client-secret')
    expect(requests[1]!.init!.headers).toMatchObject({
      Authorization: 'Bearer access-secret',
    })
  })

  test('maps cursor pages and sends loop-guarded outbound mutations', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (init?.method === 'GET') {
        return Response.json({
          data: {
            items: [{
              id: 29,
              html_url: 'https://provider.test/issues/29',
              updated_at: '2026-07-18T00:02:00.000Z',
              number: 29,
              title: 'Issue 29',
              body: 'Description',
              state: 'open',
              labels: ['api'],
            }],
          },
          page: { next: 'page-2' },
        })
      }
      return Response.json({
        id: 29,
        html_url: 'https://provider.test/issues/29',
        updated_at: '2026-07-18T00:03:00.000Z',
        number: 29,
        title: 'Updated',
        body: 'New body',
        state: 'closed',
        mukuroji_origin: 'origin-1',
        labels: ['api'],
      })
    }) as typeof fetch
    const adapter = new ConfiguredOAuthConnectorAdapter(
      createProviderOptions(fetcher),
    )
    const credential = {
      accessToken: 'access-secret',
      externalAccountId: '42',
      scopes: ['repo'],
    }

    const page = await adapter.pull(credential, 'issue', 'page-1')
    expect(requests[0]!.url).toBe(
      'https://provider.test/api/issues?after=page-1',
    )
    expect(page).toEqual({
      items: [{
        externalId: '29',
        resourceType: 'issue',
        externalUrl: 'https://provider.test/issues/29',
        externalVersion: '2026-07-18T00:02:00.000Z',
        displayKey: '29',
        title: 'Issue 29',
        description: 'Description',
        status: 'open',
        metadata: { number: 29 },
        originMarker: undefined,
      }],
      nextCursor: 'page-2',
    })

    const pushed = await adapter.push(credential, {
      externalId: '29',
      resourceType: 'issue',
      workItemRevision: 4,
      title: 'Updated',
      description: 'New body',
      status: 'closed',
      originMarker: 'origin-1',
      operationId: 'operation-1',
      expectedExternalVersion: '2026-07-18T00:02:00.000Z',
    })
    expect(requests[1]!.url).toBe('https://provider.test/api/issues/29')
    expect(requests[1]!.init!.headers).toMatchObject({
      'X-Mukuroji-Origin': 'origin-1',
      'Idempotency-Key': 'operation-1',
      'If-Match': '2026-07-18T00:02:00.000Z',
    })
    expect(JSON.parse(requests[1]!.init!.body as string)).toEqual({
      title: 'Updated',
      body: 'New body',
      state: 'closed',
      mukuroji_origin: 'origin-1',
    })
    expect(pushed.originMarker).toBe('origin-1')
  })

  test('classifies authorization/rate failures and requires a configured revoke endpoint', async () => {
    const unauthorized = new ConfiguredOAuthConnectorAdapter(
      createProviderOptions(
        (async (_input: URL | RequestInfo, _init?: RequestInit) =>
          new Response(null, { status: 401 })) as typeof fetch,
      ),
    )
    await expect(unauthorized.pull({
      accessToken: 'expired-token',
      externalAccountId: '42',
      scopes: ['repo'],
    }, 'issue')).rejects.toMatchObject({
      code: 'ConnectorAuthorizationRequired',
      authorizationRequired: true,
      retryable: false,
      providerStatus: 401,
    })

    const limited = new ConfiguredOAuthConnectorAdapter(
      createProviderOptions(
        (async (_input: URL | RequestInfo, _init?: RequestInit) =>
          new Response(null, { status: 429 })) as typeof fetch,
      ),
    )
    await expect(limited.pull({
      accessToken: 'token',
      externalAccountId: '42',
      scopes: ['repo'],
    }, 'issue')).rejects.toMatchObject({
      code: 'ConnectorProviderUnavailable',
      retryable: true,
      providerStatus: 429,
    })

    const options = createProviderOptions(
      (async (_input: URL | RequestInfo, _init?: RequestInit) =>
        Response.json({})) as typeof fetch,
    )
    delete options.revocationEndpoint
    const noRevocation = new ConfiguredOAuthConnectorAdapter(options)
    await expect(noRevocation.disconnect({
      accessToken: 'token',
      externalAccountId: '42',
      scopes: ['repo'],
    })).rejects.toMatchObject({ code: 'ConnectorRevocationUnsupported' })
  })

  test('revokes refresh and access tokens before deleting local credentials', async () => {
    const revoked: Array<{ token: string | null; hint: string | null }> = []
    const adapter = new ConfiguredOAuthConnectorAdapter(
      createProviderOptions(
        (async (_input: URL | RequestInfo, init?: RequestInit) => {
          const body = init?.body as URLSearchParams
          revoked.push({
            token: body.get('token'),
            hint: body.get('token_type_hint'),
          })
          return new Response(null, { status: 200 })
        }) as typeof fetch,
      ),
    )

    await expect(adapter.disconnect({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      externalAccountId: '42',
      scopes: ['repo'],
    })).resolves.toBeUndefined()
    expect(revoked).toEqual([
      { token: 'refresh-token', hint: 'refresh_token' },
      { token: 'access-token', hint: 'access_token' },
    ])

    const misconfigured = new ConfiguredOAuthConnectorAdapter(
      createProviderOptions(
        (async (_input: URL | RequestInfo, _init?: RequestInit) =>
          new Response(null, { status: 404 })) as typeof fetch,
      ),
    )
    await expect(misconfigured.disconnect({
      accessToken: 'access-token',
      externalAccountId: '42',
      scopes: ['repo'],
    })).rejects.toMatchObject({
      code: 'ConnectorProviderUnavailable',
      providerStatus: 404,
      retryable: false,
    })
  })

  test('rejects untrusted endpoint hosts and environment secret omissions', () => {
    const options = createProviderOptions(
      (async (_input: URL | RequestInfo, _init?: RequestInit) =>
        Response.json({})) as typeof fetch,
    )
    options.tokenEndpoint = 'https://metadata.invalid/token'
    expect(() => new ConfiguredOAuthConnectorAdapter(options)).toThrow(
      ConnectorRuntimeError,
    )

    const configuration = [{
      provider: 'github',
      clientId: 'github-client',
      clientSecretEnvironmentVariable: 'GITHUB_CONNECTOR_SECRET',
      redirectUri: 'https://app.test/callback',
      authorizationEndpoint: 'https://provider.test/authorize',
      tokenEndpoint: 'https://provider.test/token',
      apiBaseUrl: 'https://provider.test/api/',
      defaultScopes: ['repo'],
      token: {
        accessToken: 'access_token',
        externalAccountId: 'account_id',
      },
      resources: options.resources,
      allowedHosts: ['app.test', 'provider.test'],
    }]
    expect(() => createOAuthConnectorRegistryFromEnvironment({
      environment: {
        MUKUROJI_CONNECTOR_PROVIDERS_JSON: JSON.stringify(configuration),
      },
    })).toThrow(ConnectorRuntimeError)
    const registry = createOAuthConnectorRegistryFromEnvironment({
      environment: {
        MUKUROJI_CONNECTOR_PROVIDERS_JSON: JSON.stringify(configuration),
        GITHUB_CONNECTOR_SECRET: 'provider-secret',
      },
    })
    expect(registry.get('github').definition.category).toBe('source-control')
  })

  test('requires exact resource bindings and rejects case-insensitive mapping collisions', () => {
    const fetcher = (async (_input: URL | RequestInfo, _init?: RequestInit) =>
      Response.json({})) as typeof fetch
    const missingBinding = createProviderOptions(fetcher)
    delete missingBinding.resources.deploy
    expect(() => new ConfiguredOAuthConnectorAdapter(missingBinding))
      .toThrow(expect.objectContaining({ code: 'ConnectorResourceBindingMismatch' }))

    const mutationCollision = createProviderOptions(fetcher)
    mutationCollision.resources.issue!.mutation.status = 'TITLE'
    expect(() => new ConfiguredOAuthConnectorAdapter(mutationCollision))
      .toThrow(expect.objectContaining({ code: 'ConnectorMutationMappingInvalid' }))

    const reservedHeader = createProviderOptions(fetcher)
    reservedHeader.resources.issue!.idempotencyHeader = 'x-MUKUROJI-origin'
    expect(() => new ConfiguredOAuthConnectorAdapter(reservedHeader))
      .toThrow(expect.objectContaining({ code: 'ConnectorHeaderInvalid' }))

    const headerCollision = createProviderOptions(fetcher)
    headerCollision.resources.issue!.idempotencyHeader = 'X-Provider-Version'
    headerCollision.resources.issue!.versionHeader = 'x-provider-version'
    expect(() => new ConfiguredOAuthConnectorAdapter(headerCollision))
      .toThrow(expect.objectContaining({ code: 'ConnectorHeaderInvalid' }))
  })

  test('wraps transport failures without exposing provider error details', async () => {
    const adapter = new ConfiguredOAuthConnectorAdapter(createProviderOptions(
      (async () => {
        throw new Error('getaddrinfo ENOTFOUND token=provider-secret')
      }) as typeof fetch,
    ))
    try {
      await adapter.pull({
        accessToken: 'access-secret',
        externalAccountId: '42',
        scopes: ['repo'],
      }, 'issue')
      throw new Error('expected provider request to fail')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'ConnectorProviderUnavailable',
        retryable: true,
        message: 'Connector provider request could not be completed.',
      })
      expect(String(error)).not.toContain('provider-secret')
    }
  })

  test('cancels streamed provider responses as soon as the 2 MiB limit is exceeded', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024))
        controller.enqueue(new Uint8Array(1024 * 1024))
        controller.enqueue(new Uint8Array(1))
      },
      cancel() {
        cancelled = true
      },
    })
    const adapter = new ConfiguredOAuthConnectorAdapter(createProviderOptions(
      (async () => new Response(body, { status: 200 })) as typeof fetch,
    ))

    await expect(adapter.pull({
      accessToken: 'access-secret',
      externalAccountId: '42',
      scopes: ['repo'],
    }, 'issue')).rejects.toMatchObject({
      code: 'ConnectorProviderResponseMalformed',
      message: 'Connector provider response is too large.',
    })
    expect(cancelled).toBe(true)
  })

  test('round-trips the validated credential envelope and rejects malformed storage', () => {
    const serialized = serializeConnectorCredential({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2026-07-18T01:00:00Z',
      externalAccountId: 'account-1',
      externalAccountName: 'Engineering',
      scopes: ['write', 'read', 'read'],
    })
    expect(deserializeConnectorCredential(serialized)).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: '2026-07-18T01:00:00.000Z',
      externalAccountId: 'account-1',
      externalAccountName: 'Engineering',
      scopes: ['read', 'write'],
    })
    expect(() => deserializeConnectorCredential('{"accessToken":7}')).toThrow(
      ConnectorRuntimeError,
    )
  })
})

describe('ConnectorOAuthStateManager', () => {
  test('encrypts the PKCE flow, verifies HMAC, and consumes state exactly once', async () => {
    const stored = new Map<string, {
      stateId: string
      protectedPayload: string
      expiresAtEpochSeconds: number
    }>()
    const store = {
      async put(value: {
        stateId: string
        protectedPayload: string
        expiresAtEpochSeconds: number
      }) {
        stored.set(value.stateId, structuredClone(value))
      },
      async get(stateId: string) {
        const value = stored.get(stateId)
        return value ? structuredClone(value) : undefined
      },
      async consume(stateId: string) {
        const value = stored.get(stateId)
        stored.delete(stateId)
        return value
      },
    }
    let randomCall = 0
    const manager = new ConnectorOAuthStateManager({
      store,
      protector: {
        async protect(plaintext, context) {
          return `${context}.${Buffer.from(plaintext).toString('base64url')}`
        },
        async unprotect(ciphertext, context) {
          expect(ciphertext.startsWith(`${context}.`)).toBe(true)
          return Buffer.from(ciphertext.slice(context.length + 1), 'base64url')
            .toString('utf8')
        },
      },
      signingSecret: 'state-signing-secret-with-more-than-thirty-two-bytes',
      clock: () => NOW,
      randomBytes(size) {
        randomCall += 1
        return Buffer.alloc(size, randomCall)
      },
    })
    const created = await manager.create({
      kind: 'install',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings/developer',
      redirectUri: 'https://app.test/callback',
    })
    expect(created.state).toStartWith('v1.')
    expect(created.codeChallenge).not.toContain('=')
    expect(stored.get(created.stateId)!.protectedPayload).not.toContain(
      '"codeVerifier"',
    )

    const flow = await manager.consume(created.state)
    expect(flow).toMatchObject({
      kind: 'install',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      provider: 'github',
    })
    expect(flow.codeVerifier).toHaveLength(64)
    await expect(manager.consume(created.state)).rejects.toMatchObject({
      code: 'ConnectorOAuthStateConsumed',
    })
  })

  test('accepts in-flight states in both directions during staged key rotation', async () => {
    const store = new InMemoryConnectorOAuthStateStore()
    const protector = {
      async protect(plaintext: string) {
        return Buffer.from(plaintext).toString('base64url')
      },
      async unprotect(ciphertext: string) {
        return Buffer.from(ciphertext, 'base64url').toString('utf8')
      },
    }
    const previousSigningSecret =
      'previous-state-signing-secret-with-more-than-thirty-two-bytes'
    const currentSigningSecret =
      'current-state-signing-secret-with-more-than-thirty-two-bytes'
    const preloadedPreviousManager = new ConnectorOAuthStateManager({
      store,
      protector,
      signingSecret: previousSigningSecret,
      previousSigningSecrets: [currentSigningSecret],
      clock: () => NOW,
    })
    const previousState = await preloadedPreviousManager.create({
      kind: 'install',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings/developer',
      redirectUri: 'https://app.test/callback',
    })
    const rotatedManager = new ConnectorOAuthStateManager({
      store,
      protector,
      signingSecret: currentSigningSecret,
      previousSigningSecrets: [previousSigningSecret],
      clock: () => NOW,
    })
    const currentState = await rotatedManager.create({
      kind: 'install',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      provider: 'gitlab',
      name: 'Engineering GitLab',
      scopes: ['api'],
      returnUrl: '/settings/developer',
      redirectUri: 'https://app.test/callback',
    })

    await expect(rotatedManager.consume(previousState.state)).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      provider: 'github',
    })
    await expect(
      preloadedPreviousManager.consume(currentState.state),
    ).resolves.toMatchObject({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      provider: 'gitlab',
    })
  })

  test('reuses the same encrypted state and PKCE challenge for an idempotent operation', async () => {
    let protectCalls = 0
    const manager = new ConnectorOAuthStateManager({
      store: new InMemoryConnectorOAuthStateStore(),
      protector: {
        async protect(plaintext) {
          protectCalls += 1
          return Buffer.from(plaintext).toString('base64url')
        },
        async unprotect(ciphertext) {
          return Buffer.from(ciphertext, 'base64url').toString('utf8')
        },
      },
      signingSecret: 'state-signing-secret-with-more-than-thirty-two-bytes',
      clock: () => NOW,
    })
    const input = {
      kind: 'install' as const,
      workspaceId: 'workspace-1',
      userId: 'user-1',
      provider: 'github' as const,
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings/developer',
      redirectUri: 'https://app.test/callback',
      operationId: 'oauth-install-operation-1',
    }

    const first = await manager.create(input)
    const replay = await manager.create(input)

    expect(replay).toEqual(first)
    expect(first.stateId).toHaveLength(32)
    expect(protectCalls).toBe(1)
  })

  test('rejects state tampering and expiry before touching a consumed flow', async () => {
    let now = new Date(NOW)
    const manager = new ConnectorOAuthStateManager({
      store: new InMemoryConnectorOAuthStateStore(),
      protector: {
        async protect(plaintext) {
          return Buffer.from(plaintext).toString('base64url')
        },
        async unprotect(ciphertext) {
          return Buffer.from(ciphertext, 'base64url').toString('utf8')
        },
      },
      signingSecret: 'state-signing-secret-with-more-than-thirty-two-bytes',
      ttlSeconds: 60,
      clock: () => now,
    })
    const created = await manager.create({
      kind: 'install',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings/developer',
      redirectUri: 'https://app.test/callback',
    })
    const stateSegments = created.state.split('.')
    const signature = stateSegments[2]!
    stateSegments[2] = `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`
    const tampered = stateSegments.join('.')
    await expect(manager.consume(tampered)).rejects.toMatchObject({
      code: 'ConnectorOAuthStateInvalid',
    })
    now = new Date(NOW.getTime() + 61_000)
    await expect(manager.consume(created.state)).rejects.toMatchObject({
      code: 'ConnectorOAuthStateExpired',
    })
  })

  test('uses conditional put, TTL, sharded keys, and DeleteItem return-old-value', async () => {
    const commands: unknown[] = []
    const documentClient = {
      async send(command: unknown) {
        commands.push(command)
        if (command instanceof DeleteCommand) {
          return {
            Attributes: {
              entryType: 'connector-oauth-state',
              protectedPayload: 'ciphertext',
              expiresAt: 1_800_000_600,
            },
          }
        }
        return {}
      },
    } as unknown as DynamoDBDocumentClient
    const store = new DynamoDbConnectorOAuthStateStore({
      tableName: 'DeveloperPlatform',
      documentClient,
    })
    await store.put({
      stateId: 'abcdefghijklmnopqrstuvwxyzABCDEF',
      protectedPayload: 'ciphertext',
      expiresAtEpochSeconds: 1_800_000_600,
    })
    const consumed = await store.consume('abcdefghijklmnopqrstuvwxyzABCDEF')

    expect(commands[0]).toBeInstanceOf(PutCommand)
    expect((commands[0] as PutCommand).input).toMatchObject({
      TableName: 'DeveloperPlatform',
      Item: {
        workspaceId: 'CONNECTOR-OAUTH-STATE#ab',
        recordKey: 'STATE#abcdefghijklmnopqrstuvwxyzABCDEF',
        entryType: 'connector-oauth-state',
        protectedPayload: 'ciphertext',
        expiresAt: 1_800_000_600,
      },
      ConditionExpression:
        'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
    })
    expect(commands[1]).toBeInstanceOf(DeleteCommand)
    expect((commands[1] as DeleteCommand).input.ReturnValues).toBe('ALL_OLD')
    expect(consumed).toEqual({
      stateId: 'abcdefghijklmnopqrstuvwxyzABCDEF',
      protectedPayload: 'ciphertext',
      expiresAtEpochSeconds: 1_800_000_600,
    })
  })
})
