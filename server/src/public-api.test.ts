import { describe, expect, test } from 'bun:test'
import {
  PUBLIC_API_OPENAPI_DOCUMENT,
  type ApiScope,
  type CanonicalWorkItem,
  type ImportJob,
  type WorkItemSyncConflict,
} from '@mukuroji/contracts'
import {
  DeveloperPlatformError,
  InMemoryDeveloperPlatformClient,
  LocalAesGcmSecretProtector,
} from './developer-platform'
import {
  createPublicApiRouter,
  PUBLIC_API_CURSOR_TTL_SECONDS,
  PublicApiServiceError,
  toSafePublicApiErrorLog,
  type ConnectorAuthorizationService,
  type DeveloperManagementPrincipal,
  type PublicImportSourceInput,
  type PublicWorkItemService,
} from './public-api'

const NOW = new Date('2026-07-18T00:00:00.000Z')
const managementPrincipal: DeveloperManagementPrincipal = {
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

function createWorkItem(id = 'work-item-1', teamId = 'team-1'): CanonicalWorkItem {
  return {
    schemaVersion: 1,
    revision: 1,
    id,
    teamId,
    title: 'Public API work item',
    assigneeUserId: 'user-1',
    creatorMemberKey: 'user-1',
    workflowSchemaVersion: 1,
    workflowStatusId: 'todo',
    statusCategory: 'unstarted',
    customFieldValues: {},
    relationIds: [],
    dueDate: '2026-07-31',
    priority: 'medium',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    source: 'dynamodb',
  }
}

function createImportJob(id: string, dryRun: boolean): ImportJob {
  return {
    id,
    format: 'csv',
    teamId: 'team-1',
    status: dryRun ? 'completed' : 'queued',
    mapping: [
      { sourceField: 'Title', targetField: 'title', transform: 'trim' },
      { sourceField: 'Assignee', targetField: 'assigneeUserId' },
      { sourceField: 'Due', targetField: 'dueDate', required: true },
    ],
    dryRun,
    createdByUserId: 'user-1',
    createdAt: NOW.toISOString(),
    ...(dryRun ? { completedAt: NOW.toISOString() } : {}),
    report: { totalRows: 1, validRows: 1, invalidRows: 0, errors: [] },
  }
}

function createDefaultWorkItemService(
  overrides: Partial<PublicWorkItemService> = {},
): PublicWorkItemService {
  const workItem = createWorkItem()
  return {
    async list() {
      return { items: [workItem], hasMore: false }
    },
    async get() {
      return workItem
    },
    async create() {
      return workItem
    },
    async update() {
      return workItem
    },
    async delete() {
      return workItem
    },
    async authorizeExternalLink() {},
    async authorizeWebhookTeams() {},
    async dryRunImport() {
      return {
        valid: true,
        totalRows: 1,
        validRows: 1,
        invalidRows: 0,
        errors: [],
        sample: [],
      }
    },
    async commitImport() {
      return createImportJob('import-commit', false)
    },
    async authorizeImportJob() {},
    async cancelImport(_principal, job) {
      return { ...job, status: 'cancelled' }
    },
    async export() {
      return {
        items: [workItem],
        hasMore: false,
      }
    },
    ...overrides,
  }
}

function createTestRouter(input: {
  workItems?: PublicWorkItemService
  connectorAuthorization?: ConnectorAuthorizationService
  managementPrincipal?: DeveloperManagementPrincipal
  platform?: InMemoryDeveloperPlatformClient
  now?: () => Date
  queueWebhookDelivery?: (workspaceId: string, deliveryId: string) => Promise<void>
} = {}) {
  const platform = input.platform ?? new InMemoryDeveloperPlatformClient(
    new LocalAesGcmSecretProtector(new Uint8Array(32).fill(9)),
    () => new Date(NOW),
  )
  const router = createPublicApiRouter({
    developerPlatform: platform,
    authenticateManagement: async () => input.managementPrincipal ?? managementPrincipal,
    workItems: input.workItems ?? createDefaultWorkItemService(),
    openApiDocument: { openapi: '3.1.0' },
    cursorSecret: 'public-api-test-cursor-secret-at-least-32-bytes',
    createRequestId: () => 'request-public-api-test',
    now: input.now ?? (() => new Date(NOW)),
    ...(input.queueWebhookDelivery
      ? { queueWebhookDelivery: input.queueWebhookDelivery }
      : {}),
    ...(input.connectorAuthorization
      ? { connectorAuthorization: input.connectorAuthorization }
      : {}),
  })
  return { platform, router }
}

async function createApiKey(
  platform: InMemoryDeveloperPlatformClient,
  scopes: ApiScope[],
) {
  return platform.createApiKey({
    workspaceId: 'workspace-1',
    createdByUserId: 'user-1',
    input: {
      name: 'Test key',
      scopes,
      expiresAt: '2027-07-18T00:00:00.000Z',
    },
  })
}

describe('public API router', () => {
  test('redacts error messages, stacks, causes, and unsafe codes from log fields', () => {
    const secret = 'provider-client-secret-must-not-appear'
    const unknownLog = JSON.stringify(toSafePublicApiErrorLog(
      new Error(`upstream response contained ${secret}`, {
        cause: { accessToken: secret },
      }),
    ))
    const domainLog = JSON.stringify(toSafePublicApiErrorLog(
      new DeveloperPlatformError(
        503,
        secret,
        `provider response contained ${secret}`,
      ),
    ))
    const publicLog = toSafePublicApiErrorLog(
      new PublicApiServiceError(409, 'conflict', `sensitive ${secret}`),
    )

    expect(unknownLog).not.toContain(secret)
    expect(unknownLog).toBe(
      '{"errorType":"InternalError","code":"internal_error","status":500}',
    )
    expect(domainLog).not.toContain(secret)
    expect(domainLog).toBe(
      '{"errorType":"DeveloperPlatformError","code":"temporarily_unavailable","status":503}',
    )
    expect(publicLog).toEqual({
      errorType: 'PublicApiServiceError',
      code: 'conflict',
      status: 409,
    })
  })

  test('keeps OpenAPI aligned with the implemented OAuth, export, and external-link surface', () => {
    const { paths, components } = PUBLIC_API_OPENAPI_DOCUMENT

    expect(Object.keys(components.securitySchemes.OAuth2.flows)).toEqual([
      'clientCredentials',
    ])
    expect(Object.keys(components.schemas.OAuthTokenRequest.properties).sort()).toEqual([
      'client_id',
      'client_secret',
      'grant_type',
      'scope',
    ])
    expect(Object.keys(components.schemas.OAuthTokenOutput.properties).sort()).toEqual([
      'access_token',
      'expires_in',
      'scope',
      'token_type',
    ])
    expect(components.securitySchemes.ApiKeyAuth).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'APIKey',
    })
    expect(components.schemas.OAuthAppSummary.properties).not.toHaveProperty('redirectUris')
    expect(components.schemas.CreateOAuthAppInput.properties).not.toHaveProperty('redirectUris')
    expect(paths['/api/v1/work-items/{workItemId}/external-links']).toHaveProperty('get')
    expect(paths['/api/v1/work-items/{workItemId}/external-links']).toHaveProperty('post')
    expect(paths['/api/developer/external-links/{externalLinkId}']).toHaveProperty('patch')
    expect(
      paths['/api/developer/external-links/{externalLinkId}'].patch.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/UpdateExternalWorkItemLinkInput' })
    expect(paths['/api/developer/imports'].post.responses).toHaveProperty('202')
    expect(paths['/api/developer/imports'].post.responses).not.toHaveProperty('201')
    expect(paths['/api/developer/exports']).toHaveProperty('get')
    expect(paths['/api/developer/exports']).not.toHaveProperty('post')
    expect(paths).not.toHaveProperty('/api/developer/exports/{exportJobId}')
    expect(paths['/api/developer/api-keys/{apiKeyId}']).not.toHaveProperty('patch')
    expect(paths['/api/developer/oauth-apps/{oauthAppId}']).not.toHaveProperty('patch')
    expect(components.schemas.CreateWebhookSubscriptionInput.required).toContain('teamIds')
    expect(components.schemas.WebhookSubscription.required).toContain('createdByUserId')
    expect(components.schemas.ApiKeyOneTimeSecretOutput.properties.secret).toMatchObject({
      readOnly: true,
    })
    expect(components.schemas.OAuthAppOneTimeSecretOutput.properties.clientSecret)
      .toMatchObject({ readOnly: true })
    expect(components.schemas.OAuthTokenOutput.properties.access_token).toMatchObject({
      readOnly: true,
    })
    expect(components.schemas.WebhookSubscriptionSecretOutput.properties.signingSecret)
      .toMatchObject({ readOnly: true })
    expect(components.schemas.OAuthTokenRequest.properties.client_secret).toMatchObject({
      writeOnly: true,
    })
    expect(components.schemas.ImportDryRunReport).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['valid', 'sample', 'totalRows', 'errors']),
    })
    expect(components.schemas.ImportDryRunReport).not.toHaveProperty('allOf')
    expect(components.schemas.ConnectorProvider.enum).toHaveLength(11)
    expect(components.schemas.UpdatePublicWorkItemRequest.minProperties).toBe(2)
  })

  test('binds management cursors to actor, route, filters, limit, and expiry', async () => {
    let now = new Date(NOW)
    const { platform, router } = createTestRouter({ now: () => new Date(now) })
    await Promise.all([
      createApiKey(platform, ['work-items:read']),
      createApiKey(platform, ['work-items:read']),
      createApiKey(platform, ['work-items:read']),
    ])
    const requestPage = (path: string, targetRouter = router) =>
      targetRouter.request(`http://localhost${path}`, {
        headers: { Authorization: 'Bearer session-token' },
      })
    const first = await requestPage('/developer/api-keys?limit=2')
    const firstBody = await first.json() as {
      items: Array<{ id: string }>
      hasMore: boolean
      nextCursor: string
    }
    const second = await requestPage(
      `/developer/api-keys?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    )
    const secondBody = await second.json() as {
      items: Array<{ id: string }>
      hasMore: boolean
    }
    const combinedIds = [...firstBody.items, ...secondBody.items].map((item) => item.id)

    expect(first.status).toBe(200)
    expect(firstBody.hasMore).toBe(true)
    expect(second.status).toBe(200)
    expect(secondBody.hasMore).toBe(false)
    expect(combinedIds).toEqual([...combinedIds].sort((left, right) =>
      right.localeCompare(left)
    ))

    const wrongRoute = await requestPage(
      `/developer/oauth-apps?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    )
    const wrongLimit = await requestPage(
      `/developer/api-keys?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    )
    const tamperedCursor = `${firstBody.nextCursor.slice(0, -1)}${
      firstBody.nextCursor.endsWith('a') ? 'b' : 'a'
    }`
    const tampered = await requestPage(
      `/developer/api-keys?limit=2&cursor=${encodeURIComponent(tamperedCursor)}`,
    )
    const otherActorRouter = createTestRouter({
      platform,
      managementPrincipal: { ...managementPrincipal, userId: 'user-2' },
      now: () => new Date(now),
    }).router
    const wrongActor = await requestPage(
      `/developer/api-keys?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
      otherActorRouter,
    )
    now = new Date(NOW.getTime() + PUBLIC_API_CURSOR_TTL_SECONDS * 1_000)
    const expired = await requestPage(
      `/developer/api-keys?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`,
    )

    for (const response of [wrongRoute, wrongLimit, tampered, wrongActor, expired]) {
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'invalid_request' })
    }
  })

  test('keeps store continuation pages stable when a live collection receives a newer item', async () => {
    const workItemAt = (id: string, hour: number) => ({
      ...createWorkItem(id),
      createdAt: `2026-07-18T0${hour}:00:00.000Z`,
      updatedAt: `2026-07-18T0${hour}:00:00.000Z`,
    })
    let items = [
      workItemAt('work-item-a', 4),
      workItemAt('work-item-b', 3),
      workItemAt('work-item-c', 2),
      workItemAt('work-item-d', 1),
    ]
    const workItems = createDefaultWorkItemService({
      async list(_credential, _filters, continuation, limit) {
        const offset = continuation
          ? Math.max(0, items.findIndex((item) => item.id === continuation) + 1)
          : 0
        const pageItems = items.slice(offset, offset + limit)
        const hasMore = offset + pageItems.length < items.length
        return {
          items: structuredClone(pageItems),
          hasMore,
          ...(hasMore ? { nextContinuation: pageItems.at(-1)!.id } : {}),
        }
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:read'])
    const requestPage = (cursor?: string) => router.request(
      `http://localhost/v1/work-items?teamId=team-1&limit=2${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`,
      { headers: { Authorization: `Bearer ${apiKey.secret}` } },
    )

    const first = await requestPage()
    const firstBody = await first.json() as {
      items: CanonicalWorkItem[]
      nextCursor: string
    }
    items = [workItemAt('work-item-new', 5), ...items]
    const second = await requestPage(firstBody.nextCursor)
    const secondBody = await second.json() as {
      items: CanonicalWorkItem[]
      hasMore: boolean
    }

    expect(firstBody.items.map((item) => item.id)).toEqual(['work-item-a', 'work-item-b'])
    expect(secondBody.items.map((item) => item.id)).toEqual(['work-item-c', 'work-item-d'])
    expect(secondBody.hasMore).toBe(false)
  })

  test('rejects normalized impossible dates while accepting leap and month-end dates', async () => {
    const receivedDueDates: string[] = []
    const workItems = createDefaultWorkItemService({
      async create(_credential, input) {
        receivedDueDates.push(input.dueDate)
        return { ...createWorkItem(), dueDate: input.dueDate }
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:write'])
    const request = (dueDate: string) => router.request('http://localhost/v1/work-items', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secret}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `create-${dueDate}`,
      },
      body: JSON.stringify({
        teamId: 'team-1',
        title: 'Date validation',
        assigneeUserId: 'user-1',
        dueDate,
        priority: 'medium',
      }),
    })

    for (const impossible of ['2026-02-29', '2026-02-31', '2026-04-31']) {
      const response = await request(impossible)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    }
    for (const valid of ['2024-02-29', '2026-04-30']) {
      expect((await request(valid)).status).toBe(201)
    }
    expect(receivedDueDates).toEqual(['2024-02-29', '2026-04-30'])
  })

  test('does not silently ignore cursors on advertised management lists', async () => {
    const { router } = createTestRouter()
    const paths = [
      '/developer/api-keys',
      '/developer/oauth-apps',
      '/developer/webhook-subscriptions',
      '/developer/webhook-deliveries',
      '/developer/connector-installations',
      '/developer/imports',
      '/developer/work-items/work-item-1/external-links?teamId=team-1',
    ]

    for (const path of paths) {
      const separator = path.includes('?') ? '&' : '?'
      const response = await router.request(
        `http://localhost${path}${separator}cursor=unsigned`,
        { headers: { Authorization: 'Bearer session-token' } },
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'invalid_request' })
    }
  })

  test('returns stable problem details for unknown management fields', async () => {
    const { router } = createTestRouter()
    const response = await router.request('http://localhost/developer/api-keys', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'create-key-invalid',
      },
      body: JSON.stringify({
        name: 'Invalid key',
        scopes: ['work-items:read'],
        credential: 'must-never-be-accepted',
      }),
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('Content-Type')).toContain('application/problem+json')
    expect(await response.json()).toMatchObject({
      code: 'validation_failed',
      requestId: 'request-public-api-test',
      retryable: false,
    })
  })

  test('replays one-time API key output for the same management idempotency key', async () => {
    const { router } = createTestRouter()
    const request = () => router.request('http://localhost/developer/api-keys', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'create-key-once',
      },
      body: JSON.stringify({
        name: 'Automation key',
        scopes: ['work-items:read'],
        expiresAt: '2027-07-18T00:00:00.000Z',
      }),
    })

    const first = await request()
    const firstBody = await first.json()
    const replay = await request()

    expect(first.status).toBe(201)
    expect(replay.status).toBe(201)
    expect(first.headers.get('Cache-Control')).toBe('no-store')
    expect(first.headers.get('Pragma')).toBe('no-cache')
    expect(replay.headers.get('Cache-Control')).toBe('no-store')
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(await replay.json()).toEqual(firstBody)
  })

  test('classifies an in-progress reservation as an idempotency conflict', async () => {
    const platform = new InMemoryDeveloperPlatformClient(
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(9)),
      () => new Date(NOW),
    )
    platform.reserveIdempotency = async () => ({ status: 'in-progress' })
    const { router } = createTestRouter({ platform })
    const response = await router.request('http://localhost/developer/api-keys', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'create-key-in-progress',
      },
      body: JSON.stringify({
        name: 'In-progress key',
        scopes: ['work-items:read'],
        expiresAt: '2027-07-18T00:00:00.000Z',
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'idempotency_conflict',
      retryable: true,
    })
  })

  test('recovers the one-time secret after handler completion fails', async () => {
    const platform = new InMemoryDeveloperPlatformClient(
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(9)),
      () => new Date(NOW),
    )
    const completeIdempotency = platform.completeIdempotency.bind(platform)
    let failCompletion = true
    platform.completeIdempotency = async (request) => {
      if (failCompletion) {
        failCompletion = false
        throw new DeveloperPlatformError(
          503,
          'DeveloperPlatformDataUnavailable',
          'Simulated response-path failure after the atomic domain commit.',
        )
      }
      await completeIdempotency(request)
    }
    const { router } = createTestRouter({ platform })
    const request = () => router.request('http://localhost/developer/api-keys', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'create-key-handler-crash',
      },
      body: JSON.stringify({
        name: 'Crash-safe key',
        scopes: ['work-items:read'],
        expiresAt: '2027-07-18T00:00:00.000Z',
      }),
    })

    expect((await request()).status).toBe(503)
    const replay = await request()
    const replayBody = await replay.json() as { secret: string }
    expect(replay.status).toBe(201)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(replayBody.secret).toStartWith('mk_key_')
    expect(await platform.listApiKeys('workspace-1')).toHaveLength(1)
    await expect(platform.authenticateApiKey({ credential: replayBody.secret }))
      .resolves.toMatchObject({ workspaceId: 'workspace-1' })
  })

  test('uses the final detail path with teamId query and emits rate-limit headers', async () => {
    let requestedTeamId = ''
    let requestedWorkItemId = ''
    const workItems = createDefaultWorkItemService({
      async get(_credential, teamId, workItemId) {
        requestedTeamId = teamId
        requestedWorkItemId = workItemId
        return createWorkItem(workItemId, teamId)
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:read'])
    const response = await router.request(
      'http://localhost/v1/work-items/work-item-9?teamId=team-9',
      { headers: { Authorization: `Bearer ${apiKey.secret}` } },
    )

    expect(response.status).toBe(200)
    expect(requestedTeamId).toBe('team-9')
    expect(requestedWorkItemId).toBe('work-item-9')
    expect(response.headers.get('RateLimit-Limit')).toBe('120')
    expect(response.headers.get('RateLimit-Reset')).toBe('60')
    expect(await response.json()).toMatchObject({ id: 'work-item-9', teamId: 'team-9' })
  })

  test('uses Team query scope for public external-link create, list, and delete', async () => {
    const authorized: Array<{ teamId: string; workItemId: string; write: boolean }> = []
    const workItems = createDefaultWorkItemService({
      async authorizeExternalLink(_credential, teamId, workItemId, write) {
        authorized.push({ teamId, workItemId, write })
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const installation = await platform.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'GitHub',
        scopes: ['issues:read'],
        credential: 'connector-credential',
      },
    })
    const apiKey = await createApiKey(platform, [
      'work-items:read',
      'work-items:write',
      'integrations:read',
      'integrations:write',
    ])
    const authorization = { Authorization: `Bearer ${apiKey.secret}` }
    const created = await router.request(
      'http://localhost/v1/work-items/work-item-1/external-links?teamId=team-1',
      {
        method: 'POST',
        headers: {
          ...authorization,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'create-public-external-link',
        },
        body: JSON.stringify({
          installationId: installation.id,
          resourceType: 'issue',
          externalId: 'GH-29',
          externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
          displayKey: '#29',
          syncDirection: 'bidirectional',
        }),
      },
    )
    expect(created.status).toBe(201)
    const link = await created.json() as { id: string }
    expect(link.id).toBeString()

    const list = await router.request(
      'http://localhost/v1/work-items/work-item-1/external-links?teamId=team-1',
      { headers: authorization },
    )
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({
      items: [{ id: link.id, teamId: 'team-1', workItemId: 'work-item-1' }],
      hasMore: false,
    })

    const deleted = await router.request(
      `http://localhost/v1/work-items/work-item-1/external-links/${link.id}?teamId=team-1`,
      {
        method: 'DELETE',
        headers: {
          ...authorization,
          'Idempotency-Key': 'delete-public-external-link',
        },
      },
    )
    expect(deleted.status).toBe(204)
    const replayedDelete = await router.request(
      `http://localhost/v1/work-items/work-item-1/external-links/${link.id}?teamId=team-1`,
      {
        method: 'DELETE',
        headers: {
          ...authorization,
          'Idempotency-Key': 'delete-public-external-link',
        },
      },
    )
    expect(replayedDelete.status).toBe(204)
    expect(replayedDelete.headers.get('Idempotency-Replayed')).toBe('true')
    expect(authorized).toEqual([
      { teamId: 'team-1', workItemId: 'work-item-1', write: true },
      { teamId: 'team-1', workItemId: 'work-item-1', write: false },
      { teamId: 'team-1', workItemId: 'work-item-1', write: true },
    ])
  })

  test('updates a managed external link with current Work Item RBAC and replays it', async () => {
    const authorized: Array<{ teamId: string; workItemId: string; write: boolean }> = []
    const workItems = createDefaultWorkItemService({
      async authorizeExternalLink(_credential, teamId, workItemId, write) {
        authorized.push({ teamId, workItemId, write })
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const installation = await platform.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Managed GitHub',
        scopes: ['issues:read'],
        credential: 'managed-connector-credential',
      },
    })
    const link = await platform.createExternalWorkItemLink({
      workspaceId: 'workspace-1',
      input: {
        teamId: 'team-1',
        workItemId: 'work-item-1',
        installationId: installation.id,
        resourceType: 'issue',
        externalId: 'GH-29',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
        displayKey: '#29',
        syncDirection: 'bidirectional',
      },
    })
    const update = platform.updateExternalWorkItemLink.bind(platform)
    let updateCount = 0
    platform.updateExternalWorkItemLink = async (request) => {
      updateCount += 1
      return update(request)
    }
    const request = (syncDirection = 'none', idempotencyKey = 'pause-managed-link') =>
      router.request(`http://localhost/developer/external-links/${link.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer session-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ syncDirection }),
      })

    const first = await request()
    const firstBody = await first.json()
    const replay = await request()

    expect(first.status).toBe(200)
    expect(firstBody).toMatchObject({
      id: link.id,
      syncDirection: 'none',
      syncStatus: 'paused',
    })
    expect(replay.status).toBe(200)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(await replay.json()).toEqual(firstBody)
    expect(updateCount).toBe(1)
    expect(authorized).toEqual([
      { teamId: 'team-1', workItemId: 'work-item-1', write: true },
      { teamId: 'team-1', workItemId: 'work-item-1', write: true },
    ])

    const deniedRouter = createTestRouter({
      platform,
      workItems: createDefaultWorkItemService({
        async authorizeExternalLink() {
          throw new PublicApiServiceError(403, 'forbidden', 'Work Item access was revoked.')
        },
      }),
    }).router
    const denied = await deniedRouter.request(
      `http://localhost/developer/external-links/${link.id}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer session-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'resume-managed-link-without-access',
        },
        body: JSON.stringify({ syncDirection: 'outbound' }),
      },
    )
    expect(denied.status).toBe(403)
    expect((await platform.listExternalWorkItemLinks({
      workspaceId: 'workspace-1',
    }))[0]).toMatchObject({
      syncDirection: 'none',
      syncStatus: 'paused',
    })
  })

  test('binds mutation idempotency to the canonical teamId query', async () => {
    let updateCount = 0
    const workItems = createDefaultWorkItemService({
      async update(_credential, teamId, workItemId) {
        updateCount += 1
        return createWorkItem(workItemId, teamId)
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:write'])
    const request = (teamId: string) => router.request(
      `http://localhost/v1/work-items/work-item-1?teamId=${teamId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${apiKey.secret}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'update-across-teams',
        },
        body: JSON.stringify({ expectedRevision: 1, title: 'Updated' }),
      },
    )

    expect((await request('team-1')).status).toBe(200)
    const conflict = await request('team-2')
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: 'idempotency_conflict' })
    expect(updateCount).toBe(1)
  })

  test('rejects a signed cursor after its 15 minute lifetime', async () => {
    let now = new Date(NOW)
    const workItems = createDefaultWorkItemService({
      async list() {
        return {
          items: [createWorkItem('work-item-1')],
          hasMore: true,
          nextContinuation: 'work-item-1',
        }
      },
    })
    const { platform, router } = createTestRouter({ workItems, now: () => new Date(now) })
    const apiKey = await createApiKey(platform, ['work-items:read'])
    const first = await router.request(
      'http://localhost/v1/work-items?teamId=team-1&limit=1',
      { headers: { Authorization: `Bearer ${apiKey.secret}` } },
    )
    const cursor = (await first.json() as { nextCursor: string }).nextCursor
    now = new Date(NOW.getTime() + 15 * 60 * 1_000)
    const expired = await router.request(
      `http://localhost/v1/work-items?teamId=team-1&limit=1&cursor=${encodeURIComponent(cursor)}`,
      { headers: { Authorization: `Bearer ${apiKey.secret}` } },
    )

    expect(expired.status).toBe(400)
    expect(await expired.json()).toMatchObject({ code: 'invalid_request' })
  })

  test('stages the full nested import source without blocking on a remote dry-run', async () => {
    const received: PublicImportSourceInput[] = []
    const workItems = createDefaultWorkItemService({
      async commitImport(_principal, jobId, input) {
        expect(jobId).toBeUndefined()
        received.push(structuredClone(input))
        return createImportJob('import-commit', false)
      },
    })
    const { router } = createTestRouter({ workItems })
    const input: PublicImportSourceInput = {
      format: 'csv',
      source: {
        fileName: 'work-items.csv',
        mediaType: 'text/csv',
        content: 'Title,Assignee,Due\n Example ,user-1,2026-07-31\n',
      },
      teamId: 'team-1',
      mapping: [
        { sourceField: 'Title', targetField: 'title', transform: 'trim' },
        { sourceField: 'Assignee', targetField: 'assigneeUserId' },
        { sourceField: 'Due', targetField: 'dueDate', required: true },
      ],
    }
    const response = await router.request('http://localhost/developer/imports', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'commit-import-source',
      },
      body: JSON.stringify(input),
    })

    expect(response.status).toBe(202)
    expect(received).toEqual([input])
    expect(await response.json()).toMatchObject({
      id: 'import-commit',
      status: 'queued',
      dryRun: false,
    })
  })

  test('retries a side-effect-free import dry-run after response receipt persistence fails', async () => {
    const platform = new InMemoryDeveloperPlatformClient(
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(9)),
      () => new Date(NOW),
    )
    const completeIdempotency = platform.completeIdempotency.bind(platform)
    let failCompletion = true
    platform.completeIdempotency = async (request) => {
      if (failCompletion) {
        failCompletion = false
        throw new DeveloperPlatformError(
          503,
          'DeveloperPlatformDataUnavailable',
          'Simulated dry-run response receipt failure.',
        )
      }
      await completeIdempotency(request)
    }
    let validations = 0
    const workItems = createDefaultWorkItemService({
      async dryRunImport() {
        validations += 1
        return {
          valid: true,
          totalRows: 1,
          validRows: 1,
          invalidRows: 0,
          errors: [],
          sample: [],
        }
      },
    })
    const { router } = createTestRouter({ platform, workItems })
    const request = () => router.request('http://localhost/developer/imports/dry-run', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'dry-run-receipt-retry',
      },
      body: JSON.stringify({
        format: 'csv',
        source: {
          fileName: 'work-items.csv',
          mediaType: 'text/csv',
          content: 'Title\nExample\n',
        },
        teamId: 'team-1',
        mapping: [{ sourceField: 'Title', targetField: 'title' }],
      }),
    })

    expect((await request()).status).toBe(503)
    const retried = await request()
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({ valid: true, totalRows: 1 })
    expect(validations).toBe(2)
    expect(await platform.listImportJobs('workspace-1')).toEqual([])

    const replay = await request()
    expect(replay.status).toBe(200)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(validations).toBe(2)
  })

  test('retries import cancellation deterministically after response receipt persistence fails', async () => {
    const platform = new InMemoryDeveloperPlatformClient(
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(9)),
      () => new Date(NOW),
    )
    const job = await platform.createImportJob({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        format: 'csv',
        teamId: 'team-1',
        mapping: [{ sourceField: 'Title', targetField: 'title' }],
      },
    })
    const completeIdempotency = platform.completeIdempotency.bind(platform)
    let failCompletion = true
    platform.completeIdempotency = async (request) => {
      if (failCompletion) {
        failCompletion = false
        throw new DeveloperPlatformError(
          503,
          'DeveloperPlatformDataUnavailable',
          'Simulated cancellation response receipt failure.',
        )
      }
      await completeIdempotency(request)
    }
    let cancellations = 0
    const workItems = createDefaultWorkItemService({
      async cancelImport(_principal, current) {
        cancellations += 1
        if (current.status === 'cancelled') return current
        return platform.updateImportJob({
          workspaceId: 'workspace-1',
          jobId: current.id,
          status: 'cancelled',
        })
      },
    })
    const { router } = createTestRouter({ platform, workItems })
    const request = (idempotencyKey: string) => router.request(
      `http://localhost/developer/imports/${job.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer session-token',
          'Idempotency-Key': idempotencyKey,
        },
      },
    )

    expect((await request('cancel-import-receipt-retry')).status).toBe(503)
    const retried = await request('cancel-import-receipt-retry')
    expect(retried.status).toBe(200)
    expect(await retried.json()).toMatchObject({ id: job.id, status: 'cancelled' })
    expect(cancellations).toBe(2)

    const replay = await request('cancel-import-receipt-retry')
    expect(replay.status).toBe(200)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(cancellations).toBe(2)

    const equivalentRetry = await request('cancel-import-equivalent-retry')
    expect(equivalentRetry.status).toBe(200)
    expect(await equivalentRetry.json()).toMatchObject({
      id: job.id,
      status: 'cancelled',
    })
    expect(cancellations).toBe(3)
  })

  test('requires the Workspace settings administrator capability for every management area', async () => {
    const { router } = createTestRouter({
      managementPrincipal: {
        ...managementPrincipal,
        capabilities: {
          canManageCredentials: false,
          canManageWebhooks: false,
          canManageIntegrations: false,
          canImport: true,
          canExport: true,
        },
      },
    })
    for (const path of ['/developer', '/developer/imports', '/developer/exports']) {
      const response = await router.request(`http://localhost${path}`, {
        headers: { Authorization: 'Bearer session-token' },
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'forbidden' })
    }
  })

  test('lets a current Work Item viewer read external links without integration administration', async () => {
    const authorizations: Array<{
      teamId: string
      workItemId: string
      write: boolean
    }> = []
    const { router } = createTestRouter({
      managementPrincipal: {
        ...managementPrincipal,
        capabilities: {
          canManageCredentials: false,
          canManageWebhooks: false,
          canManageIntegrations: false,
          canImport: false,
          canExport: false,
        },
      },
      workItems: createDefaultWorkItemService({
        async authorizeExternalLink(_credential, teamId, workItemId, write) {
          authorizations.push({ teamId, workItemId, write })
        },
      }),
    })
    const response = await router.request(
      'http://localhost/developer/work-items/work-item-1/external-links?teamId=team-1',
      { headers: { Authorization: 'Bearer session-token' } },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ items: [], hasMore: false })
    expect(authorizations).toEqual([
      { teamId: 'team-1', workItemId: 'work-item-1', write: false },
    ])
  })

  test('does not expose import records owned by another creator or an inaccessible Team', async () => {
    const workItems = createDefaultWorkItemService({
      async authorizeImportJob() {
        throw new PublicApiServiceError(403, 'forbidden', 'Team access is required.')
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const own = await platform.createImportJob({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        format: 'csv',
        teamId: 'team-denied',
        mapping: [{ sourceField: 'Title', targetField: 'title' }],
      },
    })
    const foreign = await platform.createImportJob({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-2',
      input: {
        format: 'csv',
        teamId: 'team-1',
        mapping: [{ sourceField: 'Title', targetField: 'title' }],
      },
    })
    const list = await router.request('http://localhost/developer/imports', {
      headers: { Authorization: 'Bearer session-token' },
    })
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({ items: [], hasMore: false })

    for (const jobId of [own.id, foreign.id]) {
      const detail = await router.request(`http://localhost/developer/imports/${jobId}`, {
        headers: { Authorization: 'Bearer session-token' },
      })
      expect(detail.status).toBe(404)
      expect(await detail.json()).toMatchObject({ code: 'not_found' })
    }
  })

  test('retains the local connector credential when provider disconnect fails', async () => {
    let disconnectAttempts = 0
    const connectorAuthorization: ConnectorAuthorizationService = {
      async begin() {
        throw new Error('not used')
      },
      async completeCallback() {
        throw new Error('not used')
      },
      async abortCallback() {
        throw new Error('not used')
      },
      async reauthorize() {
        throw new Error('not used')
      },
      async disconnect() {
        disconnectAttempts += 1
        if (disconnectAttempts === 1) {
          throw new Error('provider unavailable with credential=must-not-leak')
        }
      },
      async listConflicts() {
        return { items: [], hasMore: false }
      },
      async resolveConflict() {
        throw new Error('not used')
      },
    }
    const { platform, router } = createTestRouter({ connectorAuthorization })
    const installation = await platform.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Engineering GitHub',
        scopes: ['issues:read'],
        credential: 'provider-credential',
      },
    })
    const request = () => router.request(
      `http://localhost/developer/connector-installations/${installation.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer session-token',
          'Idempotency-Key': 'disconnect-provider-failure',
        },
      },
    )
    const response = await request()
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      code: 'temporarily_unavailable',
      detail: 'Connector disconnect did not finish. Retry the same operation to recover safely.',
      retryable: true,
    })
    expect(await platform.readConnectorCredential({
      workspaceId: 'workspace-1',
      installationId: installation.id,
    })).toBe('provider-credential')
    expect(await platform.listConnectors('workspace-1')).toContainEqual(
      expect.objectContaining({ id: installation.id, status: 'connected' }),
    )
    const retry = await request()
    expect(retry.status).toBe(200)
    expect(disconnectAttempts).toBe(2)
    await expect(platform.readConnectorCredential({
      workspaceId: 'workspace-1',
      installationId: installation.id,
    })).rejects.toMatchObject({ status: 409, code: 'ConnectorDisconnected' })
    expect(await platform.listConnectors('workspace-1')).toContainEqual(
      expect.objectContaining({ id: installation.id, status: 'disconnected' }),
    )
  })

  test('authorizes every webhook Team selector before storing a subscription', async () => {
    let authorizedTeamIds: readonly string[] = []
    const workItems = createDefaultWorkItemService({
      async authorizeWebhookTeams(_principal, teamIds) {
        authorizedTeamIds = teamIds
        throw new PublicApiServiceError(403, 'forbidden', 'Team access is required.')
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const response = await router.request(
      'http://localhost/developer/webhook-subscriptions',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'create-webhook-denied-team',
        },
        body: JSON.stringify({
          name: 'Denied webhook',
          url: 'https://hooks.example.test/work-items',
          teamIds: ['team-allowed', 'team-denied'],
          eventTypes: ['work-item.updated'],
        }),
      },
    )
    expect(response.status).toBe(403)
    expect(authorizedTeamIds).toEqual(['team-allowed', 'team-denied'])
    expect(await platform.listWebhookSubscriptions('workspace-1')).toEqual([])
  })

  test('passes the exact DELETE receipt into the atomic webhook disable mutation', async () => {
    const platform = new InMemoryDeveloperPlatformClient(
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(21)),
      () => new Date(NOW),
    )
    const created = await platform.createWebhookSubscription({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'Atomic delete webhook',
        url: 'https://hooks.example.test/atomic-delete',
        teamIds: ['team-1'],
        eventTypes: ['work-item.updated'],
      },
    })
    const setStatus = platform.setWebhookSubscriptionStatus.bind(platform)
    let setStatusCalls = 0
    let receivedAtomicReceipt = false
    platform.setWebhookSubscriptionStatus = async (request) => {
      setStatusCalls += 1
      receivedAtomicReceipt = request.idempotency !== undefined &&
        request.idempotencyResponse?.status === 204 &&
        request.idempotencyResponse.body === null
      return await setStatus(request)
    }
    const { router } = createTestRouter({ platform })
    const request = () => router.request(
      `http://localhost/developer/webhook-subscriptions/${created.subscription.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer session-token',
          'Idempotency-Key': 'delete-webhook-atomically',
        },
      },
    )

    const response = await request()
    expect(response.status).toBe(204)
    expect(receivedAtomicReceipt).toBe(true)
    const replay = await request()
    expect(replay.status).toBe(204)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(setStatusCalls).toBe(1)
  })

  test('prevents another administrator from rotating creator-owned credentials', async () => {
    const { platform } = createTestRouter()
    const apiKey = await createApiKey(platform, ['work-items:read'])
    const oauthApp = await platform.createOAuthApp({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'Creator service',
        grantTypes: ['client_credentials'],
        scopes: ['work-items:read'],
      },
    })
    const otherAdmin = {
      ...managementPrincipal,
      userId: 'user-2',
    }
    const { router } = createTestRouter({ platform, managementPrincipal: otherAdmin })
    const rotate = (path: string, idempotencyKey: string) => router.request(
      `http://localhost${path}`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-token',
          'Idempotency-Key': idempotencyKey,
        },
      },
    )

    const apiKeyResponse = await rotate(
      `/developer/api-keys/${apiKey.apiKey.id}/rotate`,
      'other-admin-api-key-rotate',
    )
    const oauthResponse = await rotate(
      `/developer/oauth-apps/${oauthApp.oauthApp.id}/rotate-secret`,
      'other-admin-oauth-rotate',
    )

    for (const response of [apiKeyResponse, oauthResponse]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'forbidden' })
    }
    await expect(platform.authenticateApiKey({ credential: apiKey.secret }))
      .resolves.toMatchObject({ subjectUserId: 'user-1' })
    await expect(platform.issueOAuthToken({
      clientId: oauthApp.oauthApp.clientId,
      clientSecret: oauthApp.clientSecret,
    })).resolves.toMatchObject({ tokenType: 'Bearer' })
  })

  test('keeps webhook mutation and replay authority with its creator and current Teams', async () => {
    const { platform } = createTestRouter()
    const created = await platform.createWebhookSubscription({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'Creator webhook',
        url: 'https://hooks.example.test/original',
        teamIds: ['team-1'],
        eventTypes: ['work-item.updated'],
      },
    })
    const deliveries = await platform.enqueueWebhookEvent({
      workspaceId: 'workspace-1',
      authorizedSubscriptionIds: [created.subscription.id],
      event: {
        id: 'event-webhook-security',
        type: 'work-item.updated',
        apiVersion: '2026-07-01',
        occurredAt: NOW.toISOString(),
        workspaceId: 'workspace-1',
        data: { metadata: { teamId: 'team-1' }, workItemId: 'work-item-1' },
      },
    })
    const queued: string[] = []
    const requestMutation = (
      router: ReturnType<typeof createTestRouter>['router'],
      path: string,
      idempotencyKey: string,
      body?: Record<string, unknown>,
      method = 'POST',
    ) => router.request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: 'Bearer session-token',
        'Idempotency-Key': idempotencyKey,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const otherAdminRouter = createTestRouter({
      platform,
      managementPrincipal: { ...managementPrincipal, userId: 'user-2' },
      queueWebhookDelivery: async (_workspaceId, deliveryId) => {
        queued.push(deliveryId)
      },
    }).router
    const paths = [
      [
        `/developer/webhook-subscriptions/${created.subscription.id}`,
        'other-admin-webhook-update',
        { url: 'https://attacker.example.test/exfiltrate' },
        'PATCH',
      ],
      [
        `/developer/webhook-subscriptions/${created.subscription.id}/rotate-secret`,
        'other-admin-webhook-rotate',
      ],
      [
        `/developer/webhook-deliveries/${deliveries[0]!.id}/replay`,
        'other-admin-webhook-replay',
      ],
    ] as const
    for (const [path, key, body, method] of paths) {
      const response = await requestMutation(otherAdminRouter, path, key, body, method)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'forbidden' })
    }
    expect(queued).toEqual([])
    expect((await platform.listWebhookSubscriptions('workspace-1'))[0]?.url)
      .toBe('https://hooks.example.test/original')

    const authorizedTeamChecks: string[][] = []
    const ownerRouter = createTestRouter({
      platform,
      workItems: createDefaultWorkItemService({
        async authorizeWebhookTeams(_principal, teamIds) {
          authorizedTeamChecks.push([...teamIds])
          throw new PublicApiServiceError(403, 'forbidden', 'Team access is required.')
        },
      }),
      queueWebhookDelivery: async (_workspaceId, deliveryId) => {
        queued.push(deliveryId)
      },
    }).router
    for (const [path, key, body, method] of paths) {
      const response = await requestMutation(
        ownerRouter,
        path,
        key.replace('other-admin', 'owner-no-team'),
        body,
        method,
      )
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: 'forbidden' })
    }
    expect(authorizedTeamChecks).toEqual([['team-1'], ['team-1'], ['team-1']])
    expect(queued).toEqual([])
  })

  test('rate-limits invalid OAuth client attempts and never permits caching token responses', async () => {
    const { router } = createTestRouter()
    const request = () => router.request('http://localhost/v1/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'unknown-client',
        client_secret: 'invalid-secret',
      }).toString(),
    })
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request()
      expect(response.status).toBe(401)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Pragma')).toBe('no-cache')
    }
    const limited = await request()
    expect(limited.status).toBe(429)
    expect(limited.headers.get('RateLimit-Limit')).toBe('30')
    expect(limited.headers.get('Retry-After')).toBe('60')
    expect(limited.headers.get('Cache-Control')).toBe('no-store')
  })

  test('uses the trusted Lambda source IP instead of spoofable forwarding headers', async () => {
    const { router } = createTestRouter()
    const request = (attempt: number) => router.request(
      'http://localhost/v1/oauth/token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Forwarded-For': `198.51.100.${(attempt % 200) + 1}`,
        },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: `unknown-client-${attempt}`,
          client_secret: 'invalid-secret',
        }).toString(),
      },
      {
        event: {
          requestContext: {
            http: { sourceIp: '203.0.113.9' },
          },
        },
      },
    )

    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect((await request(attempt)).status).toBe(401)
    }
    const limited = await request(60)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('RateLimit-Limit')).toBe('60')
  })

  test('uses the configured connector authorization and conflict recovery seam', async () => {
    const conflict: WorkItemSyncConflict = {
      id: 'conflict-1',
      externalLinkId: 'link-1',
      workItemId: 'work-item-1',
      localRevision: 2,
      externalRevision: 'etag-2',
      fields: [{ field: 'title', localValue: 'Local', externalValue: 'Remote' }],
      status: 'open',
      detectedAt: NOW.toISOString(),
    }
    const beginOperationIds: string[] = []
    const connectorAuthorization: ConnectorAuthorizationService = {
      async begin(_principal, _input, operationId) {
        beginOperationIds.push(operationId ?? '')
        return {
          authorizationUrl: 'https://provider.example/oauth/authorize?state=opaque',
          stateId: 'state-1',
          expiresAt: '2026-07-18T00:10:00.000Z',
        }
      },
      async completeCallback(input) {
        expect(input).toEqual({ code: 'provider-code', state: 'signed-state' })
        return {
          installation: {
            id: 'connector-1',
            category: 'source-control',
            provider: 'github',
            name: 'Engineering GitHub',
            status: 'connected',
            scopes: ['issues:read'],
            installedByUserId: 'user-1',
            installedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
          returnUrl: '/settings/developer',
        }
      },
      async abortCallback(input) {
        expect(input).toEqual({ state: 'cancelled-state' })
        return { returnUrl: '/settings/developer?tab=connectors' }
      },
      async reauthorize() {
        return {
          authorizationUrl: 'https://provider.example/oauth/authorize?state=reauth',
          stateId: 'state-2',
          expiresAt: '2026-07-18T00:10:00.000Z',
        }
      },
      async disconnect() {},
      async listConflicts() {
        return { items: [conflict], hasMore: false }
      },
      async resolveConflict(_principal, conflictId, input) {
        expect(conflictId).toBe('conflict-1')
        expect(input).toEqual({ resolution: 'use-local' })
        return {
          ...conflict,
          status: 'resolved',
          resolvedAt: NOW.toISOString(),
          resolvedByUserId: 'user-1',
        }
      },
    }
    const { router } = createTestRouter({ connectorAuthorization })
    const beginRequest = () => router.request(
      'http://localhost/developer/connector-installations',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'begin-connector',
        },
        body: JSON.stringify({
          provider: 'github',
          name: 'Engineering GitHub',
          scopes: ['issues:read'],
          returnUrl: '/settings/developer',
        }),
      },
    )
    const begin = await beginRequest()
    const beginBody = await begin.json() as Record<string, unknown>
    expect(begin.status).toBe(201)
    expect(beginBody.authorizationUrl).toBeString()
    expect(beginBody.credential).toBeUndefined()
    expect(beginOperationIds).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/u)])
    const beginReplay = await beginRequest()
    expect(beginReplay.status).toBe(201)
    expect(beginReplay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(await beginReplay.json()).toEqual(beginBody)
    expect(beginOperationIds).toHaveLength(1)

    const callback = await router.request(
      'http://localhost/developer/connector-oauth/callback' +
        '?code=provider-code&state=signed-state',
    )
    expect(callback.status).toBe(303)
    expect(callback.headers.get('Location'))
      .toBe('/settings/developer?connectorOAuth=connected')
    expect(callback.headers.get('Cache-Control')).toBe('no-store')

    const cancelled = await router.request(
      'http://localhost/developer/connector-oauth/callback' +
        '?error=access_denied&state=cancelled-state',
    )
    expect(cancelled.status).toBe(303)
    expect(cancelled.headers.get('Location'))
      .toBe('/settings/developer?tab=connectors&connectorOAuth=cancelled')

    const resolved = await router.request(
      'http://localhost/developer/sync-conflicts/conflict-1/resolve',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'resolve-conflict',
        },
        body: JSON.stringify({ resolution: 'use-local' }),
      },
    )
    expect(resolved.status).toBe(200)
    expect(await resolved.json()).toMatchObject({ id: 'conflict-1', status: 'resolved' })
  })
})
