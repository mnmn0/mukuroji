import { afterEach, describe, expect, test } from 'bun:test'
import { PUBLIC_API_OPENAPI_DOCUMENT } from '@mukuroji/contracts'
import {
  DeveloperPlatformApiError,
  connectDeveloperConnector,
  createDeveloperApiKey,
  createDeveloperExternalLink,
  createDeveloperImport,
  createDeveloperOAuthApp,
  createDeveloperWebhook,
  disconnectDeveloperConnector,
  deleteDeveloperExternalLink,
  dryRunDeveloperImport,
  exportDeveloperWorkItems,
  getDeveloperPlatformResources,
  listDeveloperExternalLinks,
  listDeveloperSyncConflicts,
  replayDeveloperWebhookDelivery,
  reauthorizeDeveloperConnector,
  resolveDeveloperSyncConflict,
  revokeDeveloperApiKey,
  revokeDeveloperOAuthApp,
  revokeDeveloperWebhook,
  rotateDeveloperApiKey,
  rotateDeveloperOAuthApp,
  rotateDeveloperWebhook,
  updateDeveloperExternalLink,
} from '../src/developer-platform/api'
import {
  developerPlatformResourcesFixture,
  issuedApiKeySecretFixture,
} from '../src/developer-platform/fixtures'

const originalFetch = globalThis.fetch
const mutationContext = {
  correlationId: 'correlation-developer-29',
  idempotencyKey: 'idempotency-developer-29',
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('Developer Platform API', () => {
  test('documents sync-conflict listing and resolution routes', () => {
    expect(
      PUBLIC_API_OPENAPI_DOCUMENT.paths[
        '/api/developer/sync-conflicts'
      ].get.operationId,
    ).toBe('listManagedWorkItemSyncConflicts')
    expect(
      PUBLIC_API_OPENAPI_DOCUMENT.paths[
        '/api/developer/sync-conflicts/{conflictId}/resolve'
      ].post.operationId,
    ).toBe('resolveManagedWorkItemSyncConflict')
    expect(
      PUBLIC_API_OPENAPI_DOCUMENT.components.schemas
        .ResolveWorkItemSyncConflictInput.oneOf,
    ).toHaveLength(2)
  })

  test('gets the aggregate resource with Bearer authorization', async () => {
    const requests = installFetchRecorder(
      developerPlatformResourcesFixture,
    )

    await expect(
      getDeveloperPlatformResources('access-token'),
    ).resolves.toEqual(developerPlatformResourcesFixture)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('/api/developer')
    expect(requests[0]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
    })
  })

  test('creates, rotates, and revokes encoded API keys with stable mutation headers', async () => {
    const requests = installFetchRecorder(
      issuedApiKeySecretFixture,
    )
    const input = {
      name: 'Production automation',
      scopes: ['work-items:read', 'work-items:write'] as const,
      expiresAt: '2026-10-01T00:00:00.000Z',
    }

    await createDeveloperApiKey(
      'access-token',
      {
        ...input,
        scopes: [...input.scopes],
      },
      mutationContext,
    )
    await rotateDeveloperApiKey(
      'access-token',
      'api/key 29',
      mutationContext,
    )
    await revokeDeveloperApiKey(
      'access-token',
      'api/key 29',
      mutationContext,
    )

    expect(
      requests.map((request) => [
        request.init.method,
        request.url,
      ]),
    ).toEqual([
      ['POST', '/api/developer/api-keys'],
      [
        'POST',
        '/api/developer/api-keys/api%2Fkey%2029/rotate',
      ],
      [
        'DELETE',
        '/api/developer/api-keys/api%2Fkey%2029',
      ],
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(
      input,
    )

    for (const request of requests) {
      expect(request.init.headers).toMatchObject({
        Authorization: 'Bearer access-token',
        'Idempotency-Key': 'idempotency-developer-29',
        'X-Correlation-Id': 'correlation-developer-29',
      })
    }
    expect(requests[0]?.init.headers).toMatchObject({
      'Content-Type': 'application/json',
    })
    expect(requests[1]?.init.headers).toMatchObject({
      'Content-Type': 'application/json',
    })
  })

  test('uses the fixed OAuth and webhook management routes', async () => {
    const requests = installFetchRecorder({})

    await createDeveloperOAuthApp(
      'access-token',
      {
        name: 'Reporting portal',
        grantTypes: ['client_credentials'],
        scopes: ['work-items:read'],
        expiresAt: '2026-10-01T23:59:59.999Z',
      },
      mutationContext,
    )
    await rotateDeveloperOAuthApp(
      'access-token',
      'oauth/app',
      mutationContext,
    )
    await revokeDeveloperOAuthApp(
      'access-token',
      'oauth/app',
      mutationContext,
    )
    await createDeveloperWebhook(
      'access-token',
      {
        name: 'Production sink',
        url: 'https://events.example.com/mukuroji',
        teamIds: ['team-product'],
        eventTypes: ['work-item.updated'],
        scopes: ['work-items:read'],
      },
      mutationContext,
    )
    await rotateDeveloperWebhook(
      'access-token',
      'webhook/main',
      mutationContext,
    )
    await revokeDeveloperWebhook(
      'access-token',
      'webhook/main',
      mutationContext,
    )
    await replayDeveloperWebhookDelivery(
      'access-token',
      'delivery/failed',
      mutationContext,
    )

    expect(requests.map((request) => request.url)).toEqual([
      '/api/developer/oauth-apps',
      '/api/developer/oauth-apps/oauth%2Fapp/rotate-secret',
      '/api/developer/oauth-apps/oauth%2Fapp',
      '/api/developer/webhook-subscriptions',
      '/api/developer/webhook-subscriptions/webhook%2Fmain/rotate-secret',
      '/api/developer/webhook-subscriptions/webhook%2Fmain',
      '/api/developer/webhook-deliveries/delivery%2Ffailed/replay',
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      name: 'Reporting portal',
      grantTypes: ['client_credentials'],
      scopes: ['work-items:read'],
      expiresAt: '2026-10-01T23:59:59.999Z',
    })
  })

  test('connects, recovers, disconnects, and resolves connector conflicts', async () => {
    const requests = installFetchRecorder({})

    await connectDeveloperConnector(
      'access-token',
      'github',
      {
        name: 'Product engineering',
        scopes: ['integrations:read', 'integrations:write'],
        returnUrl: '/workspace/settings/developer',
      },
      mutationContext,
    )
    await reauthorizeDeveloperConnector(
      'access-token',
      'installation/29',
      mutationContext,
    )
    await disconnectDeveloperConnector(
      'access-token',
      'installation/29',
      mutationContext,
    )
    await listDeveloperSyncConflicts('access-token', {
      status: 'open',
      cursor: 'next/conflict page',
      limit: 25,
    })
    await resolveDeveloperSyncConflict(
      'access-token',
      {
        conflictId: 'conflict/29',
        resolution: 'keep-local',
      },
      mutationContext,
    )
    await resolveDeveloperSyncConflict(
      'access-token',
      {
        conflictId: 'conflict/merge',
        resolution: 'merge',
        mergedValues: {
          title: 'Ship the stable API',
          priority: 'high',
        },
      },
      mutationContext,
    )

    expect(
      requests.map((request) => [
        request.init.method,
        request.url,
      ]),
    ).toEqual([
      ['POST', '/api/developer/connector-installations'],
      [
        'POST',
        '/api/developer/connector-installations/installation%2F29/reauthorize',
      ],
      [
        'DELETE',
        '/api/developer/connector-installations/installation%2F29',
      ],
      [
        undefined,
        '/api/developer/sync-conflicts?status=open&cursor=next%2Fconflict+page&limit=25',
      ],
      [
        'POST',
        '/api/developer/sync-conflicts/conflict%2F29/resolve',
      ],
      [
        'POST',
        '/api/developer/sync-conflicts/conflict%2Fmerge/resolve',
      ],
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      name: 'Product engineering',
      provider: 'github',
      returnUrl: '/workspace/settings/developer',
      scopes: ['integrations:read', 'integrations:write'],
    })
    expect(JSON.parse(String(requests[4]?.init.body))).toEqual({
      resolution: 'use-local',
    })
    expect(JSON.parse(String(requests[5]?.init.body))).toEqual({
      resolution: 'merge',
      mergedValues: {
        title: 'Ship the stable API',
        priority: 'high',
      },
    })
  })

  test('lists, creates, updates, and unlinks Work Item external resources', async () => {
    const requests = installFetchRecorder({ items: [] })

    await listDeveloperExternalLinks(
      'access-token',
      'team/product',
      'work item/29',
      { cursor: 'next/link page', limit: 25 },
    )
    await createDeveloperExternalLink(
      'access-token',
      'work item/29',
      {
        teamId: 'team/product',
        installationId: 'installation/github',
        resourceType: 'merge-request',
        externalId: '29',
        externalUrl: 'https://github.com/mnmn0/mukuroji/pull/29',
        displayKey: 'PR-29',
        syncDirection: 'bidirectional',
      },
      mutationContext,
    )
    await updateDeveloperExternalLink(
      'access-token',
      'link/29',
      { syncDirection: 'inbound' },
      mutationContext,
    )
    await deleteDeveloperExternalLink(
      'access-token',
      'link/29',
      mutationContext,
    )

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      [undefined, '/api/developer/work-items/work%20item%2F29/external-links?teamId=team%2Fproduct&cursor=next%2Flink+page&limit=25'],
      ['POST', '/api/developer/work-items/work%20item%2F29/external-links'],
      ['PATCH', '/api/developer/external-links/link%2F29'],
      ['DELETE', '/api/developer/external-links/link%2F29'],
    ])
    expect(JSON.parse(String(requests[1]?.init.body))).toMatchObject({
      installationId: 'installation/github',
      resourceType: 'merge-request',
      syncDirection: 'bidirectional',
      teamId: 'team/product',
    })
    expect(JSON.parse(String(requests[2]?.init.body))).toEqual({
      syncDirection: 'inbound',
    })
    for (const request of requests.slice(1)) {
      expect(request.init.headers).toMatchObject({
        'Idempotency-Key': 'idempotency-developer-29',
        'X-Correlation-Id': 'correlation-developer-29',
      })
    }
  })

  test('dry-runs, creates an import job, and exports Work Items through the fixed routes', async () => {
    const requests = installFetchRecorder({
      valid: true,
      totalRows: 1,
      validRows: 1,
      invalidRows: 0,
      errors: [],
      sample: [],
    })
    const importInput = {
      format: 'csv' as const,
      source: {
        fileName: 'work-items.csv',
        mediaType: 'text/csv' as const,
        content: 'summary,status\\nShip API,Todo',
      },
      mapping: [
        { sourceField: 'summary', targetField: 'title' },
      ],
      teamId: 'team-product',
      assignedProjectId: 'project-mukuroji',
    }

    await dryRunDeveloperImport(
      'access-token',
      importInput,
      mutationContext,
    )
    await createDeveloperImport(
      'access-token',
      importInput,
      mutationContext,
    )

    globalThis.fetch = (async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      requests.push({
        url:
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url,
        init,
      })

      return new Response('title,status\\nShip API,Todo', {
        headers: {
          'Content-Disposition':
            'attachment; filename="mukuroji-work-items.csv"',
          'Content-Type': 'text/csv',
        },
      })
    }) as typeof fetch

    const exportedFile = await exportDeveloperWorkItems(
      'access-token',
      'csv',
    )

    expect(
      requests.map((request) => request.url),
    ).toEqual([
      '/api/developer/imports/dry-run',
      '/api/developer/imports',
      '/api/developer/exports?format=csv',
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(
      importInput,
    )
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual(
      importInput,
    )
    expect(requests[2]?.init.headers).toMatchObject({
      Accept: 'text/csv',
      Authorization: 'Bearer access-token',
    })
    expect(exportedFile.fileName).toBe(
      'mukuroji-work-items.csv',
    )
    expect(await exportedFile.blob.text()).toBe(
      'title,status\\nShip API,Todo',
    )
  })

  test('preserves stable API status and error code', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: 'insufficient_scope',
          message: 'The actor cannot manage API credentials.',
        }),
        { status: 403 },
      )) as typeof fetch

    const request = createDeveloperApiKey(
      'access-token',
      {
        name: 'Unauthorized automation',
        scopes: ['work-items:read'],
      },
      mutationContext,
    )

    await expect(request).rejects.toMatchObject({
      code: 'insufficient_scope',
      message: 'The actor cannot manage API credentials.',
      status: 403,
    } satisfies Partial<DeveloperPlatformApiError>)
  })
})

function installFetchRecorder(responseBody: unknown) {
  const requests: Array<{
    url: string
    init: RequestInit
  }> = []

  globalThis.fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    requests.push({
      url:
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      init,
    })

    return new Response(JSON.stringify(responseBody), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  }) as typeof fetch

  return requests
}
