import { afterEach, describe, expect, test } from 'bun:test'
import {
  PUBLIC_API_OPENAPI_DOCUMENT,
  WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
  WORK_ITEM_SCHEMA_VERSION,
  type WorkItem,
} from '@mukuroji/contracts'
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
  shouldRetainDeveloperPlatformMutationContext,
  updateDeveloperExternalLink,
} from '../src/developer-platform/api'
import {
  createMutationRequestRunner,
  type MutationRequestContext,
} from '../src/api/mutationHeaders'
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
    const { components, paths } = PUBLIC_API_OPENAPI_DOCUMENT

    expect(
      paths[
        '/api/developer/sync-conflicts'
      ].get.operationId,
    ).toBe('listManagedWorkItemSyncConflicts')
    expect(
      paths[
        '/api/developer/sync-conflicts/{conflictId}/resolve'
      ].post.operationId,
    ).toBe('resolveManagedWorkItemSyncConflict')
    expect(
      components.schemas.ResolveWorkItemSyncConflictInput.oneOf,
    ).toHaveLength(2)
    expect(
      paths['/api/developer/api-keys/{apiKeyId}/rotate'].post
        .requestBody.content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/RotateApiKeyInput' })
    expect(
      components.schemas.RotateApiKeyInput.properties.expiresAt,
    ).toEqual({ type: ['string', 'null'], format: 'date-time' })
    expect(
      paths['/api/developer/connector-oauth/callback'].get.responses['303']
        .headers,
    ).toHaveProperty('RateLimit-Limit')
    expect(
      paths['/api/developer/exports'].get.responses['200'].headers,
    ).toHaveProperty('RateLimit-Limit')
    expect(
      paths['/api/developer/exports'].get.operationId,
    ).toBe('listManagedWorkItemExportPage')
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
    const exportedWorkItems = [
      createExportWorkItem({
        customFieldValues: { risk: 'high' },
        id: 'work-item-1',
        title: '=HYPERLINK("https://example.com")',
      }),
      createExportWorkItem({
        customFieldValues: { labels: ['api', 'p1'] },
        id: 'work-item-2',
        title: 'Ship API',
      }),
    ]

    globalThis.fetch = (async (
      input: string | URL | Request,
      init: RequestInit = {},
    ) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      requests.push({
        url,
        init,
      })

      const isNextPage = url.includes('cursor=')
      return new Response(JSON.stringify({
        items: [exportedWorkItems[isNextPage ? 1 : 0]],
        hasMore: !isNextPage,
        ...(isNextPage ? {} : { nextCursor: 'signed/cursor+2' }),
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const csvExport = await exportDeveloperWorkItems(
      'access-token',
      'csv',
    )
    const jsonExport = await exportDeveloperWorkItems(
      'access-token',
      'json',
    )

    expect(
      requests.map((request) => request.url),
    ).toEqual([
      '/api/developer/imports/dry-run',
      '/api/developer/imports',
      '/api/developer/exports?format=csv&limit=100',
      '/api/developer/exports?format=csv&limit=100&cursor=signed%2Fcursor%2B2',
      '/api/developer/exports?format=json&limit=100',
      '/api/developer/exports?format=json&limit=100&cursor=signed%2Fcursor%2B2',
    ])
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual(
      importInput,
    )
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual(
      importInput,
    )
    expect(requests[2]?.init.headers).toMatchObject({
      Authorization: 'Bearer access-token',
    })
    expect(csvExport.fileName).toMatch(
      /^mukuroji-work-items-\d{4}-\d{2}-\d{2}\.csv$/u,
    )
    expect(new Uint8Array(await csvExport.blob.arrayBuffer()).slice(0, 3))
      .toEqual(new Uint8Array([0xef, 0xbb, 0xbf]))
    expect(await csvExport.blob.text()).toContain(
      'id,teamId,title,description,assignedProjectId,assigneeUserId,workflowStatusId,statusCategory,dueDate,priority,revision,createdAt,updatedAt,customFieldValues.labels,customFieldValues.risk\r\n',
    )
    expect(await csvExport.blob.text()).toContain(
      'work-item-1,team-product,"\'=HYPERLINK(""https://example.com"")"',
    )
    expect(jsonExport.fileName).toMatch(
      /^mukuroji-work-items-\d{4}-\d{2}-\d{2}\.json$/u,
    )
    expect(JSON.parse(await jsonExport.blob.text())).toMatchObject({
      apiVersion: '2026-07-01',
      workItems: [
        {
          id: 'work-item-1',
          customFieldValues: { risk: 'high' },
        },
        {
          id: 'work-item-2',
          customFieldValues: { labels: ['api', 'p1'] },
        },
      ],
    })
  })

  test('retries the same export cursor after the API rate-limit window', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      urls.push(url)
      if (urls.length === 1) {
        return new Response(JSON.stringify({
          code: 'rate_limited',
          detail: 'API rate limit exceeded.',
          retryable: true,
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/problem+json',
            'Retry-After': '0',
          },
        })
      }
      return new Response(JSON.stringify({
        items: [createExportWorkItem({ id: 'work-item-retry' })],
        hasMore: false,
      }), {
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await expect(exportDeveloperWorkItems('access-token', 'json'))
      .resolves.toMatchObject({ fileName: expect.stringMatching(/\.json$/u) })
    expect(urls).toEqual([
      '/api/developer/exports?format=json&limit=100',
      '/api/developer/exports?format=json&limit=100',
    ])
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

  test('preserves retryable Problem Details across another successful mutation', async () => {
    const contexts: MutationRequestContext[] = [
      {
        correlationId: 'correlation-retryable-1',
        idempotencyKey: 'idempotency-retryable-1',
      },
      {
        correlationId: 'correlation-retryable-2',
        idempotencyKey: 'idempotency-retryable-2',
      },
    ]
    let contextIndex = 0
    const runner = createMutationRequestRunner(() => contexts[contextIndex++]!)
    const observedContexts: MutationRequestContext[] = []

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          code: 'idempotency_conflict',
          detail: 'The credential creation is still in progress.',
          retryable: true,
        }),
        {
          headers: { 'Content-Type': 'application/problem+json' },
          status: 409,
        },
      )) as typeof fetch

    await expect(runner.run(
      'api-key:create',
      'same-input',
      async (context) => {
        observedContexts.push(context)
        return createDeveloperApiKey(
          'access-token',
          {
            name: 'Retryable automation',
            scopes: ['work-items:read'],
          },
          context,
        )
      },
      shouldRetainDeveloperPlatformMutationContext,
    )).rejects.toMatchObject({
      code: 'idempotency_conflict',
      retryable: true,
      status: 409,
    } satisfies Partial<DeveloperPlatformApiError>)

    await runner.run(
      'webhook:rotate',
      'other-input',
      async (context) => {
        expect(context).toBe(contexts[1])
      },
      shouldRetainDeveloperPlatformMutationContext,
    )

    globalThis.fetch = (async () =>
      new Response(JSON.stringify(issuedApiKeySecretFixture), {
        headers: { 'Content-Type': 'application/json' },
        status: 201,
      })) as typeof fetch

    await runner.run(
      'api-key:create',
      'same-input',
      async (context) => {
        observedContexts.push(context)
        return createDeveloperApiKey(
          'access-token',
          {
            name: 'Retryable automation',
            scopes: ['work-items:read'],
          },
          context,
        )
      },
      shouldRetainDeveloperPlatformMutationContext,
    )

    expect(observedContexts).toEqual([contexts[0], contexts[0]])
    expect(contextIndex).toBe(2)
  })

  test('treats gateway 5xx responses without Problem Details as ambiguous', async () => {
    globalThis.fetch = (async () =>
      new Response('upstream unavailable', { status: 503 })) as typeof fetch

    await expect(createDeveloperApiKey(
      'access-token',
      {
        name: 'Gateway retry',
        scopes: ['work-items:read'],
      },
      mutationContext,
    )).rejects.toMatchObject({
      retryable: true,
      status: 503,
    } satisfies Partial<DeveloperPlatformApiError>)
  })

  test('retries unreadable success responses with the original idempotency context', async () => {
    for (const unreadableBody of [null, '{"apiKey":'] as const) {
      const contexts: MutationRequestContext[] = [
        {
          correlationId: 'correlation-unreadable-1',
          idempotencyKey: 'idempotency-unreadable-1',
        },
        {
          correlationId: 'correlation-unreadable-2',
          idempotencyKey: 'idempotency-unreadable-2',
        },
      ]
      let contextIndex = 0
      let attempt = 0
      const observedIdempotencyKeys: Array<string | null> = []
      const runner = createMutationRequestRunner(
        () => contexts[contextIndex++]!,
      )

      globalThis.fetch = (async (
        _input: string | URL | Request,
        init: RequestInit = {},
      ) => {
        observedIdempotencyKeys.push(
          new Headers(init.headers).get('Idempotency-Key'),
        )
        attempt += 1

        if (attempt === 1) {
          return new Response(unreadableBody, {
            headers: { 'Content-Type': 'application/json' },
            status: 201,
          })
        }

        return new Response(JSON.stringify(issuedApiKeySecretFixture), {
          headers: { 'Content-Type': 'application/json' },
          status: 201,
        })
      }) as typeof fetch

      const runCreateApiKey = () =>
        runner.run(
          'api-key:create',
          'same-input',
          (context) =>
            createDeveloperApiKey(
              'access-token',
              {
                name: 'Ambiguous success',
                scopes: ['work-items:read'],
              },
              context,
            ),
          shouldRetainDeveloperPlatformMutationContext,
        )

      await expect(runCreateApiKey()).rejects.toMatchObject({
        code: 'InvalidDeveloperPlatformResponse',
        retryable: true,
        status: 201,
      } satisfies Partial<DeveloperPlatformApiError>)
      await expect(runCreateApiKey()).resolves.toEqual(
        issuedApiKeySecretFixture,
      )

      expect(contextIndex).toBe(1)
      expect(observedIdempotencyKeys).toEqual([
        'idempotency-unreadable-1',
        'idempotency-unreadable-1',
      ])
    }
  })

  test('rejects malformed non-empty success JSON and explicitly accepts empty delete responses', async () => {
    globalThis.fetch = (async () =>
      new Response('{"apiKeys":', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      })) as typeof fetch

    await expect(
      getDeveloperPlatformResources('access-token'),
    ).rejects.toMatchObject({
      code: 'InvalidDeveloperPlatformResponse',
      retryable: true,
      status: 200,
    } satisfies Partial<DeveloperPlatformApiError>)

    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as typeof fetch

    await expect(revokeDeveloperWebhook(
      'access-token',
      'subscription-29',
      mutationContext,
    )).resolves.toEqual({})
    await expect(deleteDeveloperExternalLink(
      'access-token',
      'external-link-29',
      mutationContext,
    )).resolves.toEqual({})
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

function createExportWorkItem(
  overrides: Partial<WorkItem>,
): WorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
    revision: 3,
    id: 'work-item-export',
    teamId: 'team-product',
    title: 'Export Work Item',
    assigneeUserId: 'user-minami',
    creatorMemberKey: 'member-minami',
    customFieldValues: {},
    statusCategory: 'unstarted',
    workflowSchemaVersion: WORK_ITEM_CONFIGURATION_SCHEMA_VERSION,
    workflowStatusId: 'todo',
    dueDate: '2026-08-01',
    priority: 'medium',
    relationIds: [],
    source: 'dynamodb',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T01:00:00.000Z',
    ...overrides,
  }
}
