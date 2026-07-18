import { describe, expect, test } from 'bun:test'
import type {
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import {
  ConnectorAuthorizationRuntime,
  type ConnectorConflictRuntime,
} from './connector-authorization-runtime'
import {
  BUILT_IN_CONNECTOR_CATALOG,
  ConnectorRegistry,
} from './connectors'
import {
  InMemoryDeveloperPlatformClient,
  LocalAesGcmSecretProtector,
} from './developer-platform'
import {
  ConfiguredOAuthConnectorAdapter,
  ConnectorRuntimeError,
  deserializeConnectorCredential,
  serializeConnectorCredential,
  type ConfiguredOAuthConnectorOptions,
} from './connector-oauth'
import {
  ConnectorOAuthStateManager,
  InMemoryConnectorOAuthStateStore,
} from './connector-oauth-state'
import type { DeveloperManagementPrincipal } from './public-api'

const NOW = new Date('2026-07-18T00:00:00.000Z')

const principal: DeveloperManagementPrincipal = {
  workspaceId: 'workspace-1',
  userId: 'user-1',
  capabilities: {
    canManageCredentials: true,
    canManageWebhooks: true,
    canManageIntegrations: true,
    canImport: true,
    canExport: true,
  },
}

function emptyConflictRuntime(
  overrides: Partial<ConnectorConflictRuntime> = {},
): ConnectorConflictRuntime {
  return {
    async listConflicts() {
      return { items: [], hasMore: false }
    },
    async canAccessConflict() {
      return true
    },
    async resolveConflict() {
      throw new Error('No conflict configured')
    },
    ...overrides,
  }
}

function createRuntimeFixture() {
  let externalAccountId = 'account-1'
  const revoked: string[] = []
  const tokenRequests: URLSearchParams[] = []
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/oauth/token')) {
      const body = init!.body as URLSearchParams
      tokenRequests.push(new URLSearchParams(body))
      const suffix = body.get('code') ?? body.get('refresh_token') ?? 'unknown'
      return Response.json({
        access_token: `access-${suffix}`,
        refresh_token: 'refresh-1',
        expires_in: 3_600,
        scope: 'repo',
      })
    }
    if (url.endsWith('/api/me')) {
      return Response.json({ id: externalAccountId, login: 'Engineering' })
    }
    if (url.endsWith('/oauth/revoke')) {
      const body = init!.body as URLSearchParams
      revoked.push(body.get('token')!)
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }) as typeof fetch
  const options: ConfiguredOAuthConnectorOptions = {
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
    resources: {},
    allowedHosts: ['app.test', 'provider.test'],
    fetch: fetcher,
    clock: () => NOW,
  }
  const protector = new LocalAesGcmSecretProtector(new Uint8Array(32).fill(3))
  const platform = new InMemoryDeveloperPlatformClient(protector, () => NOW)
  const state = new ConnectorOAuthStateManager({
    store: new InMemoryConnectorOAuthStateStore(),
    protector,
    signingSecret: 'connector-state-signing-secret-at-least-thirty-two-bytes',
    clock: () => NOW,
  })
  const callbackAuthorizations: string[] = []
  const runtime = new ConnectorAuthorizationRuntime({
    platform,
    registry: new ConnectorRegistry([
      new ConfiguredOAuthConnectorAdapter(options),
    ]),
    state,
    callbackAuthorizer: {
      async authorize(workspaceId, userId) {
        callbackAuthorizations.push(`${workspaceId}:${userId}`)
      },
    },
    conflicts: emptyConflictRuntime(),
  })
  return {
    platform,
    runtime,
    revoked,
    tokenRequests,
    callbackAuthorizations,
    setExternalAccountId(value: string) {
      externalAccountId = value
    },
  }
}

function readStateFromAuthorizationUrl(value: string) {
  return new URL(value).searchParams.get('state')!
}

describe('ConnectorAuthorizationRuntime', () => {
  test('completes a signed PKCE callback into an encrypted connected installation', async () => {
    const fixture = createRuntimeFixture()
    const authorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings/developer?tab=connectors',
    })
    const authorizationUrl = new URL(authorization.authorizationUrl)
    expect(authorizationUrl.origin).toBe('https://provider.test')
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorizationUrl.searchParams.get('state')).toStartWith('v1.')

    const result = await fixture.runtime.completeCallback({
      code: 'callback-code',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })
    expect(result.returnUrl).toBe('/settings/developer?tab=connectors')
    expect(result.installation).toMatchObject({
      category: 'source-control',
      provider: 'github',
      status: 'connected',
      externalAccountId: 'account-1',
      externalAccountName: 'Engineering',
      scopes: ['repo'],
    })
    expect(fixture.callbackAuthorizations).toEqual(['workspace-1:user-1'])
    const stored = deserializeConnectorCredential(
      await fixture.platform.readConnectorCredential({
        workspaceId: 'workspace-1',
        installationId: result.installation.id,
      }),
    )
    expect(stored).toMatchObject({
      accessToken: 'access-callback-code',
      refreshToken: 'refresh-1',
      externalAccountId: 'account-1',
    })
    expect(fixture.tokenRequests[0]!.get('code_verifier')).toBeString()

    await expect(fixture.runtime.completeCallback({
      code: 'replayed-code',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })).rejects.toMatchObject({ code: 'ConnectorOAuthStateConsumed' })
  })

  test('reauthorizes only the same provider account and retains the old credential on mismatch', async () => {
    const fixture = createRuntimeFixture()
    const firstAuthorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings/developer',
    })
    const installed = await fixture.runtime.completeCallback({
      code: 'initial-code',
      state: readStateFromAuthorizationUrl(firstAuthorization.authorizationUrl),
    })

    const reauthorization = await fixture.runtime.reauthorize(
      principal,
      installed.installation.id,
    )
    const recovered = await fixture.runtime.completeCallback({
      code: 'reauthorized-code',
      state: readStateFromAuthorizationUrl(reauthorization.authorizationUrl),
    })
    expect(recovered.installation.id).toBe(installed.installation.id)
    expect(deserializeConnectorCredential(
      await fixture.platform.readConnectorCredential({
        workspaceId: 'workspace-1',
        installationId: installed.installation.id,
      }),
    ).accessToken).toBe('access-reauthorized-code')

    const mismatchedFlow = await fixture.runtime.reauthorize(
      principal,
      installed.installation.id,
    )
    fixture.setExternalAccountId('account-2')
    await expect(fixture.runtime.completeCallback({
      code: 'wrong-account-code',
      state: readStateFromAuthorizationUrl(mismatchedFlow.authorizationUrl),
    })).rejects.toMatchObject({ code: 'ConnectorAccountMismatch' })
    expect(deserializeConnectorCredential(
      await fixture.platform.readConnectorCredential({
        workspaceId: 'workspace-1',
        installationId: installed.installation.id,
      }),
    ).accessToken).toBe('access-reauthorized-code')
  })

  test('fences an older reauthorization callback when a newer flow starts', async () => {
    const fixture = createRuntimeFixture()
    const authorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings',
    })
    const installed = await fixture.runtime.completeCallback({
      code: 'initial-fenced-code',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })
    const stale = await fixture.runtime.reauthorize(
      principal,
      installed.installation.id,
    )
    const current = await fixture.runtime.reauthorize(
      principal,
      installed.installation.id,
    )

    await expect(fixture.runtime.completeCallback({
      code: 'stale-code',
      state: readStateFromAuthorizationUrl(stale.authorizationUrl),
    })).rejects.toMatchObject({ code: 'ConnectorReauthorizationStateStale' })
    expect(deserializeConnectorCredential(
      await fixture.platform.readConnectorCredential({
        workspaceId: 'workspace-1',
        installationId: installed.installation.id,
      }),
    ).accessToken).toBe('access-initial-fenced-code')
    expect(fixture.tokenRequests.map((request) => request.get('code')))
      .not.toContain('stale-code')

    await expect(fixture.runtime.completeCallback({
      code: 'current-code',
      state: readStateFromAuthorizationUrl(current.authorizationUrl),
    })).resolves.toMatchObject({
      installation: {
        id: installed.installation.id,
        status: 'connected',
      },
    })
    expect(fixture.revoked).not.toContain('access-stale-code')
  })

  test('disconnect invalidates an outstanding callback and clears reauthorization state', async () => {
    const fixture = createRuntimeFixture()
    const authorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings',
    })
    const installed = await fixture.runtime.completeCallback({
      code: 'disconnect-fence-code',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })
    const reauthorization = await fixture.runtime.reauthorize(
      principal,
      installed.installation.id,
    )

    await fixture.runtime.disconnect(principal, installed.installation.id)
    await expect(fixture.runtime.completeCallback({
      code: 'after-disconnect-code',
      state: readStateFromAuthorizationUrl(reauthorization.authorizationUrl),
    })).rejects.toMatchObject({ code: 'ConnectorReauthorizationStateStale' })
    expect((await fixture.platform.listConnectors('workspace-1'))[0]).toEqual(
      expect.objectContaining({
        status: 'disconnected',
      }),
    )
    expect((await fixture.platform.listConnectors('workspace-1'))[0])
      .not.toHaveProperty('lastError')
    expect((await fixture.platform.listConnectors('workspace-1'))[0])
      .not.toHaveProperty('reauthorizationUrl')
    expect(fixture.revoked).toEqual([
      'refresh-1',
      'access-disconnect-fence-code',
    ])
    expect(fixture.tokenRequests.map((request) => request.get('code')))
      .not.toContain('after-disconnect-code')
  })

  test('does not bind a reauthorization flow after disconnect wins the lifecycle race', async () => {
    const fixture = createRuntimeFixture()
    const authorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings',
    })
    const installed = await fixture.runtime.completeCallback({
      code: 'bind-disconnect-race',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })
    const updateStatus = fixture.platform.updateConnectorStatus.bind(fixture.platform)
    let releaseBinding!: () => void
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve
    })
    let markBindingReached!: () => void
    const bindingReached = new Promise<void>((resolve) => {
      markBindingReached = resolve
    })
    let blocked = false
    fixture.platform.updateConnectorStatus = async (request) => {
      if (request.status === 'needs-reauth' && !blocked) {
        blocked = true
        markBindingReached()
        await bindingGate
      }
      return updateStatus(request)
    }

    const pending = fixture.runtime.reauthorize(
      principal,
      installed.installation.id,
    )
    const pendingOutcome = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    await bindingReached
    await fixture.runtime.disconnect(principal, installed.installation.id)
    releaseBinding()
    await expect(pendingOutcome).resolves.toMatchObject({
      error: {
        code: 'ConnectorLifecycleChanged',
      },
    })
    expect((await fixture.platform.listConnectors('workspace-1'))[0]).toMatchObject({
      status: 'disconnected',
    })
  })

  test('retries disconnect against a credential replaced after the first revoke', async () => {
    const fixture = createRuntimeFixture()
    const authorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings',
    })
    const installed = await fixture.runtime.completeCallback({
      code: 'disconnect-c1',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })
    const updateStatus = fixture.platform.updateConnectorStatus.bind(fixture.platform)
    const recover = fixture.platform.recoverConnector.bind(fixture.platform)
    let concurrentReplacements = 0
    fixture.platform.updateConnectorStatus = async (request) => {
      if (
        request.status === 'disconnected' &&
        request.expectedCredential &&
        concurrentReplacements === 0
      ) {
        concurrentReplacements += 1
        await recover({
          workspaceId: 'workspace-1',
          installationId: installed.installation.id,
          credential: serializeConnectorCredential({
            accessToken: 'access-disconnect-c2',
            refreshToken: 'refresh-disconnect-c2',
            externalAccountId: 'account-1',
            scopes: ['repo'],
          }),
        })
      }
      return updateStatus(request)
    }

    await fixture.runtime.disconnect(principal, installed.installation.id)
    expect(concurrentReplacements).toBe(1)
    expect(fixture.revoked).toEqual([
      'refresh-1',
      'access-disconnect-c1',
      'refresh-disconnect-c2',
      'access-disconnect-c2',
    ])
    await expect(fixture.platform.readConnectorCredential({
      workspaceId: 'workspace-1',
      installationId: installed.installation.id,
    })).rejects.toMatchObject({ code: 'ConnectorDisconnected' })
  })

  test('ignores stale health results after a newer credential lifecycle wins', async () => {
    const fixture = createRuntimeFixture()
    const authorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings',
    })
    const installed = await fixture.runtime.completeCallback({
      code: 'stale-health-c1',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })
    const stale = await fixture.platform.readConnectorLifecycleSnapshot({
      workspaceId: 'workspace-1',
      installationId: installed.installation.id,
    })
    await fixture.platform.recoverConnector({
      workspaceId: 'workspace-1',
      installationId: installed.installation.id,
      credential: serializeConnectorCredential({
        accessToken: 'access-stale-health-c2',
        refreshToken: 'refresh-stale-health-c2',
        externalAccountId: 'account-1',
        scopes: ['repo'],
      }),
    })

    await fixture.runtime.authorizationRequired(
      'workspace-1',
      stale.installation,
      stale.lifecycleRevision,
    )
    await fixture.runtime.degraded(
      'workspace-1',
      stale.installation,
      new ConnectorRuntimeError(
        'ConnectorProviderUnavailable',
        'stale provider result',
        { retryable: true, providerStatus: 503 },
      ),
      stale.lifecycleRevision,
    )
    const current = (await fixture.platform.listConnectors('workspace-1'))[0]!
    expect(current.status).toBe('connected')
    expect(current).not.toHaveProperty('reauthorizationUrl')
    expect(current).not.toHaveProperty('lastError')
  })

  test('reloads the winning credential when refresh loses its compare-and-set', async () => {
    const fixture = createRuntimeFixture()
    const authorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings',
    })
    const installed = await fixture.runtime.completeCallback({
      code: 'refresh-cas-code',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })
    const recover = fixture.platform.recoverConnector.bind(fixture.platform)
    let concurrentWrites = 0
    fixture.platform.recoverConnector = async (request) => {
      if (request.reason === 'refresh' && concurrentWrites === 0) {
        concurrentWrites += 1
        const expected = deserializeConnectorCredential(request.expectedCredential!)
        await recover({
          ...request,
          credential: serializeConnectorCredential({
            ...expected,
            accessToken: 'access-concurrent-winner',
            refreshToken: 'refresh-concurrent-winner',
          }),
        })
      }
      return recover(request)
    }

    await expect(fixture.runtime.refreshCredential(
      'workspace-1',
      installed.installation.id,
    )).resolves.toMatchObject({
      id: installed.installation.id,
      status: 'connected',
    })
    expect(concurrentWrites).toBe(1)
    expect(deserializeConnectorCredential(
      await fixture.platform.readConnectorCredential({
        workspaceId: 'workspace-1',
        installationId: installed.installation.id,
      }),
    )).toMatchObject({
      accessToken: 'access-concurrent-winner',
      refreshToken: 'refresh-concurrent-winner',
    })
  })

  test('revokes provider access before deleting the local credential', async () => {
    const fixture = createRuntimeFixture()
    const authorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings/developer',
    })
    const installed = await fixture.runtime.completeCallback({
      code: 'disconnect-code',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })

    await fixture.runtime.disconnect(principal, installed.installation.id)
    expect(fixture.revoked).toEqual([
      'refresh-1',
      'access-disconnect-code',
    ])
    await expect(fixture.platform.readConnectorCredential({
      workspaceId: 'workspace-1',
      installationId: installed.installation.id,
    })).rejects.toMatchObject({ code: 'ConnectorDisconnected' })
    expect((await fixture.platform.listConnectors('workspace-1'))[0]).toMatchObject({
      status: 'disconnected',
    })
  })

  test('creates actionable reauth health state and redacts transient failures', async () => {
    const fixture = createRuntimeFixture()
    const authorization = await fixture.runtime.begin(principal, {
      provider: 'github',
      name: 'Engineering GitHub',
      scopes: ['repo'],
      returnUrl: '/settings/developer',
    })
    const installed = await fixture.runtime.completeCallback({
      code: 'health-code',
      state: readStateFromAuthorizationUrl(authorization.authorizationUrl),
    })

    await fixture.runtime.degraded(
      'workspace-1',
      installed.installation,
      new ConnectorRuntimeError(
        'ConnectorProviderUnavailable',
        'secret provider body must not be saved',
        { retryable: true, providerStatus: 503 },
      ),
    )
    const degraded = (await fixture.platform.listConnectors('workspace-1'))[0]!
    expect(degraded.status).toBe('degraded')
    expect(JSON.stringify(degraded.lastError)).not.toContain('secret provider body')

    await fixture.runtime.authorizationRequired(
      'workspace-1',
      degraded,
    )
    const needsReauth = (await fixture.platform.listConnectors('workspace-1'))[0]!
    expect(needsReauth).toMatchObject({
      status: 'needs-reauth',
      lastError: {
        code: 'authentication_required',
        detail: 'Reconnect the provider before retrying this operation.',
      },
    })
    expect(needsReauth.reauthorizationUrl).toStartWith(
      'https://provider.test/oauth/authorize?',
    )
    expect(needsReauth.reauthorizationUrl).not.toContain('client-secret')

    await fixture.runtime.degraded(
      'workspace-1',
      installed.installation,
      new ConnectorRuntimeError(
        'ConnectorProviderUnavailable',
        'secret provider body must not be saved',
        { retryable: true, providerStatus: 503 },
      ),
    )
    const preserved = (await fixture.platform.listConnectors('workspace-1'))[0]!
    expect(preserved.status).toBe('needs-reauth')
    expect(preserved.reauthorizationUrl).toBe(needsReauth.reauthorizationUrl)
    expect(preserved.lastError?.code).toBe('authentication_required')
  })

  test('delegates conflict list and recovery with tenant-bound current actor identity', async () => {
    const conflict: WorkItemSyncConflict = {
      id: 'conflict-1',
      externalLinkId: 'link-1',
      workItemId: 'work-item-1',
      localRevision: 4,
      externalRevision: '11',
      fields: [{
        field: 'title',
        localValue: 'Local',
        externalValue: 'External',
      }],
      status: 'open',
      detectedAt: NOW.toISOString(),
    }
    const calls: unknown[] = []
    const protector = new LocalAesGcmSecretProtector(new Uint8Array(32).fill(4))
    const runtime = new ConnectorAuthorizationRuntime({
      platform: new InMemoryDeveloperPlatformClient(protector, () => NOW),
      registry: new ConnectorRegistry(),
      state: new ConnectorOAuthStateManager({
        store: new InMemoryConnectorOAuthStateStore(),
        protector,
        signingSecret: 'connector-state-signing-secret-at-least-thirty-two-bytes',
        clock: () => NOW,
      }),
      callbackAuthorizer: { async authorize() {} },
      conflicts: emptyConflictRuntime({
        async listConflicts(workspaceId, input) {
          calls.push({ kind: 'list', workspaceId, input })
          return { items: [conflict], hasMore: false }
        },
        async resolveConflict(actor, conflictId, input) {
          calls.push({ kind: 'resolve', actor, conflictId, input })
          return {
            ...conflict,
            status: 'resolved',
            resolvedAt: NOW.toISOString(),
            resolvedByUserId: actor.userId,
          }
        },
      }),
    })

    expect(await runtime.listConflicts(principal, {
      status: 'open',
      limit: 25,
    })).toEqual({ items: [conflict], hasMore: false })
    expect(await runtime.resolveConflict(principal, 'conflict-1', {
      resolution: 'use-local',
    })).toMatchObject({
      status: 'resolved',
      resolvedByUserId: 'user-1',
    })
    expect(calls).toEqual([
      {
        kind: 'list',
        workspaceId: 'workspace-1',
        input: { status: 'open', limit: 25 },
      },
      {
        kind: 'resolve',
        actor: { workspaceId: 'workspace-1', userId: 'user-1' },
        conflictId: 'conflict-1',
        input: { resolution: 'use-local' },
      },
    ])
  })
})
