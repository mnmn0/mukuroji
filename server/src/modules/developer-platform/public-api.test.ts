import { describe, expect, test } from 'bun:test'
import {
  PUBLIC_API_OPENAPI_DOCUMENT,
  WORK_ITEM_SCHEDULE_MAX_HOLIDAYS,
  WORK_ITEM_SCHEMA_VERSION,
  type AgentRun,
  type AgentRunReport,
  type ApiScope,
  type CanonicalWorkItem,
  type CustomFieldDefinition,
  type DueDateWorkItemSchedule,
  type ImportJob,
  type PublicWorkItemTypeCatalog,
  type WorkItemSyncConflict,
} from '@mukuroji/contracts'
import {
  InMemoryDeveloperPlatformStorage,
  LocalAesGcmSecretProtector,
} from './adapter-out/shared/developer-platform-store'
import { DeveloperPlatformError } from './errors'
import type { DeveloperPlatformPorts } from './application/developer-platform-ports'
import {
  ConnectorAdapter,
  ExternalLinkAdapter,
} from './adapter-out/shared/connector-adapters'
import {
  ApiKeyAdapter,
  OAuthCredentialAdapter,
} from './adapter-out/shared/credential-adapters'
import { ImportAdapter } from './adapter-out/shared/import-adapter'
import {
  IdempotencyAdapter,
  RateLimitAdapter,
} from './adapter-out/shared/request-control-adapters'
import {
  WebhookDeliveryAdapter,
  WebhookSubscriptionAdapter,
} from './adapter-out/shared/webhook-adapters'
import {
  createPublicApiRouter,
  PUBLIC_API_CURSOR_TTL_SECONDS,
  PublicApiServiceError,
  toSafePublicApiErrorLog,
  type ConnectorAuthorizationService,
  type DeveloperManagementPrincipal,
  type PublicApiDependencies,
  type PublicImportSourceInput,
  type PublicAgentRunService,
  type PublicAgentTelemetryService,
  type PublicAttachmentService,
  type PublicDocumentService,
  type PublicWorkItemRelationService,
  type PublicDirectoryService,
  type PublicWorkItemService,
} from './public-api'
import { AgentRunError, createAgentRunConflictError, hashAgentInstanceId } from '../agent-runs'

const NOW = new Date('2026-07-18T00:00:00.000Z')
/** API key expiry one year after the real clock, because key creation rejects an expiry in the past. */
const API_KEY_EXPIRES_AT = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString()
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

/** Creates a canonical deadline-only schedule for public API fixtures. */
function createDueDateSchedule(dueDate: string): DueDateWorkItemSchedule {
  return {
    calendarPolicy: {
      holidays: [],
      timeZone: 'UTC',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    },
    dueDate,
    mode: 'due-date',
  }
}

function createWorkItem(id = 'work-item-1', teamId = 'team-1'): CanonicalWorkItem {
  return {
    schemaVersion: WORK_ITEM_SCHEMA_VERSION,
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
    schedule: createDueDateSchedule('2026-07-31'),
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
      { sourceField: 'Schedule', targetField: 'schedule', required: true },
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
    async getAcceptanceCriteria(_credential, teamId, workItemId) {
      return { schemaVersion: 1, teamId, workItemId, revision: workItem.revision, items: [] }
    },
    async getEffort(_credential, teamId, workItemId) {
      return { schemaVersion: 1, teamId, workItemId, revision: workItem.revision }
    },
    async getActualDates(_credential, teamId, workItemId) {
      return { schemaVersion: 1, teamId, workItemId, revision: workItem.revision }
    },
    async getKey(_credential, teamId, workItemId) {
      return { schemaVersion: 1, teamId, workItemId, createdAt: workItem.createdAt, key: 'TEAM-1' }
    },
    async getHierarchy(_credential, teamId, workItemId) {
      return { schemaVersion: 1, teamId, workItemId, parentWorkItemId: null, childWorkItemIds: [], wbsNumber: '1' }
    },
    async getCompletionGate(_credential, teamId, workItemId) {
      return { schemaVersion: 1, teamId, workItemId, revision: workItem.revision, conditions: [], blocksCompletion: false }
    },
    async listComments() { return { items: [], hasMore: false } },
    async authorizeComment() {},
    async addComment(_credential, _teamId, _workItemId, body) {
      return { id: 'comment-1', actorUserId: 'user-1', body, createdAt: NOW.toISOString() }
    },
    async list() {
      return { items: [workItem], hasMore: false }
    },
    async get() {
      return workItem
    },
    async listWorkItemTypes(_credential, teamId) {
      return {
        teamId,
        configurationRevision: 1,
        workItemTypes: [],
      }
    },
    async listWorkItemTemplates(_credential, teamId) {
      return { teamId, templates: [] }
    },
    async previewTypeChange() {
      return {
        expectedRevision: 1,
        currentWorkItemTypeId: 'default',
        currentWorkflowStatusId: 'todo',
        targetWorkItemTypeId: 'default',
        lostCustomFieldIds: [],
        targetInitialWorkflowStatusId: 'todo',
        missingRequiredCustomFieldIds: [],
        missingRequiredCustomFieldDefinitions: [],
        approvalCompletionTransitionConflict: false,
        requiresResolution: false,
      }
    },
    async authorizeCreate() {},
    async create() {
      return workItem
    },
    async authorizeUpdate() {},
    async update() {
      return workItem
    },
    async authorizeDelete() {},
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
    async getImportProgress(_principal, job) {
      return { jobId: job.id, status: job.status, totalRows: 2, processedRows: 1, totalLinks: 0, processedLinks: 0 }
    },
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

/** Binds the compatibility test store to the same focused ports used in production. */
function createFocusedTestPlatform(
  platform: InMemoryDeveloperPlatformStorage,
): DeveloperPlatformPorts {
  return {
    apiKeys: new ApiKeyAdapter(platform),
    oauthCredentials: new OAuthCredentialAdapter(platform),
    webhookSubscriptions: new WebhookSubscriptionAdapter(platform),
    webhookDeliveries: new WebhookDeliveryAdapter(platform),
    connectors: new ConnectorAdapter(platform),
    externalLinks: new ExternalLinkAdapter(platform),
    imports: new ImportAdapter(platform),
    idempotency: new IdempotencyAdapter(platform),
    rateLimits: new RateLimitAdapter(platform),
  }
}

/** Workspace Document methods a linked Document test does not call. */
const unusedWorkspaceDocumentMethods: Omit<PublicDocumentService, 'listWorkItemDocuments' | 'getWorkItemDocument'> = {
  async listDocuments() {
    throw new Error('not used')
  },
  async getDocument() {
    throw new Error('not used')
  },
  async authorizeDocumentWrite() {
    throw new Error('not used')
  },
  async createDocument() {
    throw new Error('not used')
  },
  async updateDocument() {
    throw new Error('not used')
  },
}

/** Linked Document methods a Workspace Document test does not call. */
const unusedLinkedDocumentMethods: Pick<PublicDocumentService, 'listWorkItemDocuments' | 'getWorkItemDocument'> = {
  async listWorkItemDocuments() {
    throw new Error('not used')
  },
  async getWorkItemDocument() {
    throw new Error('not used')
  },
}

function createTestRouter(input: {
  workItems?: PublicWorkItemService
  /** Agent Run service used by Agent Run route tests. */
  agentRuns?: PublicAgentRunService
  /** Agent telemetry receiver used by telemetry route tests. */
  agentTelemetry?: PublicAgentTelemetryService
  /** Document service used by Document route tests. */
  documents?: PublicDocumentService
  /** Relation service used by relation route tests. */
  workItemRelations?: PublicWorkItemRelationService
  /** Attachment service used by attachment route tests. */
  attachments?: PublicAttachmentService
  /** Directory service used by Team, Project member, and key route tests. */
  directory?: PublicDirectoryService
  connectorAuthorization?: ConnectorAuthorizationService
  /** Lists the providers configured in the test runtime. */
  listConfiguredConnectorProviders?: PublicApiDependencies['listConfiguredConnectorProviders']
  /** Web app origin that the connector OAuth callback hands off to. */
  connectorOAuthWebOrigin?: string
  managementPrincipal?: DeveloperManagementPrincipal
  /** Management authentication の request context を検証する override です。 */
  authenticateManagement?: PublicApiDependencies['authenticateManagement']
  /** Workspace lifecycle guard used by the focused router test. */
  enforceActiveWorkspace?: PublicApiDependencies['enforceActiveWorkspace']
  /** Credential owner membership guard used by the deactivated-owner test. */
  requireActiveCredentialSubject?: PublicApiDependencies['requireActiveCredentialSubject']
  /** Credential request limiter used by admission-order tests. */
  rateLimits?: PublicApiDependencies['rateLimits']
  platform?: InMemoryDeveloperPlatformStorage
  now?: () => Date
  queueWebhookDelivery?: (workspaceId: string, deliveryId: string) => Promise<void>
} = {}) {
  const platform = input.platform ?? new InMemoryDeveloperPlatformStorage(
    new LocalAesGcmSecretProtector(new Uint8Array(32).fill(9)),
    () => new Date(NOW),
  )
  const router = createPublicApiRouter({
    ...createFocusedTestPlatform(platform),
    ...(input.rateLimits ? { rateLimits: input.rateLimits } : {}),
    authenticateManagement: input.authenticateManagement ??
      (async () => input.managementPrincipal ?? managementPrincipal),
    enforceActiveWorkspace: input.enforceActiveWorkspace ?? (async () => undefined),
    ...(input.requireActiveCredentialSubject
      ? { requireActiveCredentialSubject: input.requireActiveCredentialSubject }
      : {}),
    workItems: input.workItems ?? createDefaultWorkItemService(),
    ...(input.agentRuns ? { agentRuns: input.agentRuns } : {}),
    ...(input.agentTelemetry ? { agentTelemetry: input.agentTelemetry } : {}),
    ...(input.documents ? { documents: input.documents } : {}),
    ...(input.workItemRelations ? { workItemRelations: input.workItemRelations } : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.directory ? { directory: input.directory } : {}),
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
    ...(input.connectorOAuthWebOrigin
      ? { connectorOAuthWebOrigin: input.connectorOAuthWebOrigin }
      : {}),
    ...(input.listConfiguredConnectorProviders
      ? { listConfiguredConnectorProviders: input.listConfiguredConnectorProviders }
      : {}),
  })
  return { platform, router }
}

async function createApiKey(
  platform: InMemoryDeveloperPlatformStorage,
  scopes: ApiScope[],
) {
  return platform.createApiKey({
    workspaceId: 'workspace-1',
    createdByUserId: 'user-1',
    input: {
      name: 'Test key',
      scopes,
      expiresAt: API_KEY_EXPIRES_AT,
    },
  })
}

describe('public API router', () => {
  test('lists only the connector providers configured in the runtime', async () => {
    /** Reads the provider IDs returned by the connector catalog route. */
    const readProviders = async (
      router: ReturnType<typeof createTestRouter>['router'],
      query = '',
    ) => {
      const response = await router.request(
        `http://localhost/developer/connectors${query}`,
        { headers: { Authorization: 'Bearer session-token' } },
      )
      expect(response.status).toBe(200)
      const body: unknown = await response.json()
      if (!Array.isArray(body)) throw new TypeError('Catalog must be an array.')
      return body.map((entry: unknown) =>
        typeof entry === 'object' && entry !== null && 'provider' in entry
          ? entry.provider
          : undefined
      )
    }

    const { router: unconfiguredRouter } = createTestRouter()
    expect(await readProviders(unconfiguredRouter)).toEqual([])

    const { router } = createTestRouter({
      listConfiguredConnectorProviders: async () => ['slack', 'github'],
    })
    expect(await readProviders(router)).toEqual(['github', 'slack'])
    expect(await readProviders(router, '?category=chat')).toEqual(['slack'])
    expect(await readProviders(router, '?category=email')).toEqual([])
  })

  test('adds progress comments with scoped authentication, idempotency, and current replay authorization', async () => {
    let creates = 0
    let allowed = true
    const { platform, router } = createTestRouter({ workItems: createDefaultWorkItemService({
      async addComment(credential, teamId, id, body, _context, project, assignee) {
        expect(credential.workspaceId).toBe('workspace-1')
        expect(teamId).toBe('team-1')
        expect(id).toBe('work-item-1')
        expect(project).toBe('project-1')
        expect(assignee).toBe('user-1')
        creates += 1
        return { id: 'comment-1', actorUserId: credential.subjectUserId, body, createdAt: NOW.toISOString() }
      },
      async authorizeComment(_credential, _team, _id, project, assignee) {
        expect(project).toBe('project-1')
        expect(assignee).toBe('user-1')
        if (!allowed) throw new PublicApiServiceError(403, 'forbidden', 'Access removed.')
      },
    }) })
    const credential = await createApiKey(platform, ['work-items:read', 'work-items:write'])
    const path = '/v1/work-items/work-item-1/comments?teamId=team-1&assignedProjectId=project-1&assigneeUserId=user-1'
    const headers = { Authorization: `Bearer ${credential.secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'progress-key' }
    const send = (body = 'Tests pass. PR #123') => router.request(path, { method: 'POST', headers, body: JSON.stringify({ body }) })
    expect((await send()).status).toBe(201)
    const replay = await send()
    expect(replay.status).toBe(201)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(creates).toBe(1)
    expect((await send('Different content')).status).toBe(409)
    expect((await router.request(path.replace('project-1', 'project-2'), { method: 'POST', headers, body: JSON.stringify({ body: 'Tests pass. PR #123' }) })).status).toBe(409)
    expect((await router.request(path.replace('project-1', ''), { method: 'POST', headers, body: JSON.stringify({ body: 'x' }) })).status).toBe(400)
    allowed = false
    expect((await send()).status).toBe(403)
    expect(creates).toBe(1)
    expect((await router.request(path, { method: 'POST', headers, body: JSON.stringify({ body: 'x', actorUserId: 'someone-else' }) })).status).toBe(400)
    const readOnly = await createApiKey(platform, ['work-items:read'])
    expect((await router.request(path, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${readOnly.secret}` }, body: JSON.stringify({ body: 'x' }) })).status).toBe(403)
    expect((await router.request(path)).status).toBe(401)
  })

  test('keys rate limits and idempotency on the OAuth app instead of each access token', async () => {
    let creates = 0
    const { router } = createTestRouter({ workItems: createDefaultWorkItemService({
      async addComment(credential, _teamId, _id, body) {
        creates += 1
        return { id: `comment-${creates}`, actorUserId: credential.subjectUserId, body, createdAt: NOW.toISOString() }
      },
    }) })
    // Register OAuth apps and issue tokens through the HTTP endpoints integrations use.
    const registerClient = async (name: string) => {
      const response = await router.request('http://localhost/developer/oauth-apps', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': `register-${name}`,
        },
        body: JSON.stringify({
          name,
          grantTypes: ['client_credentials'],
          scopes: ['work-items:read', 'work-items:write'],
        }),
      })
      expect(response.status).toBe(201)
      const registered = await response.json() as {
        oauthApp: { clientId: string }
        clientSecret: string
      }
      return new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: registered.oauthApp.clientId,
        client_secret: registered.clientSecret,
      }).toString()
    }
    const requestToken = async (grant: string) => {
      const response = await router.request('http://localhost/v1/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: grant,
      })
      expect(response.status).toBe(200)
      return (await response.json() as { access_token: string }).access_token
    }
    const grant = await registerClient('Retrying integration')
    const first = await requestToken(grant)
    const second = await requestToken(grant)
    expect(second).not.toBe(first)
    const path = '/v1/work-items/work-item-1/comments?teamId=team-1&assignedProjectId=project-1&assigneeUserId=user-1'
    const send = (accessToken: string) => router.request(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'oauth-retry-key',
      },
      body: JSON.stringify({ body: 'Tests pass.' }),
    })

    const created = await send(first)
    expect(created.status).toBe(201)
    expect(created.headers.get('RateLimit-Remaining')).toBe('119')
    // A retry with a newly issued token replays instead of creating a second comment.
    const retried = await send(second)
    expect(retried.status).toBe(201)
    expect(retried.headers.get('Idempotency-Replayed')).toBe('true')
    expect(creates).toBe(1)
    // Both tokens draw from one rate-limit bucket.
    expect(retried.headers.get('RateLimit-Remaining')).toBe('118')

    // Another OAuth app keeps its own bucket and idempotency scope.
    const other = await send(await requestToken(await registerClient('Other integration')))
    expect(other.status).toBe(201)
    expect(other.headers.get('Idempotency-Replayed')).toBeNull()
    expect(other.headers.get('RateLimit-Remaining')).toBe('119')
    expect(creates).toBe(2)
  })

  test('preserves empty comment page continuations and binds cursors to Team, Project, task, credential, and limit', async () => {
    const { platform, router } = createTestRouter({ workItems: createDefaultWorkItemService({
      async listComments(_credential, _team, _id, continuation, _limit, project) {
        expect(project).toBe('project-1')
        return continuation ? { items: [{ id: 'comment', actorUserId: 'user-1', body: 'Progress', createdAt: NOW.toISOString() }], hasMore: false }
          : { items: [], hasMore: true, nextContinuation: 'internal-cursor' }
      },
    }) })
    const credential = await createApiKey(platform, ['work-items:read'])
    const headers = { Authorization: `Bearer ${credential.secret}` }
    const path = '/v1/work-items/work-item-1/comments?teamId=team-1&limit=1&assignedProjectId=project-1'
    const first = await router.request(path, { headers })
    const body = await first.json()
    expect(body).toMatchObject({ items: [], hasMore: true })
    expect(body.nextCursor).not.toContain('internal-cursor')
    const query = `&cursor=${encodeURIComponent(body.nextCursor)}`
    expect((await router.request(path + query, { headers })).status).toBe(200)
    expect((await router.request(path.replace('work-item-1', 'work-item-2') + query, { headers })).status).toBe(400)
    expect((await router.request(path.replace('team-1', 'team-2') + query, { headers })).status).toBe(400)
    expect((await router.request(path.replace('project-1', 'project-2') + query, { headers })).status).toBe(400)
    expect((await router.request(path.replace('limit=1', 'limit=2') + query, { headers })).status).toBe(400)
    const other = await createApiKey(platform, ['work-items:read'])
    expect((await router.request(path + query, { headers: { Authorization: `Bearer ${other.secret}` } })).status).toBe(400)
  })

  test('passes request metadata to management authentication', async () => {
    const observations: string[] = []
    const { router } = createTestRouter({
      authenticateManagement: async (authorization, context) => {
        observations.push(
          authorization,
          context.req.method,
          context.req.path,
          context.req.header('X-Management-Context') ?? '',
        )
        return managementPrincipal
      },
    })

    const response = await router.request('http://localhost/developer', {
      headers: {
        Authorization: 'Bearer session-token',
        'X-Management-Context': 'forwarded',
      },
    })

    expect(response.status).toBe(200)
    expect(observations).toEqual([
      'Bearer session-token',
      'GET',
      '/developer',
      'forwarded',
    ])
  })

  test('enforces lifecycle after resolving the credential Workspace', async () => {
    const observations: string[] = []
    const { platform, router } = createTestRouter({
      async enforceActiveWorkspace(workspaceId) {
        observations.push(workspaceId)
        throw new PublicApiServiceError(
          403,
          'forbidden',
          'This Workspace is closing.',
        )
      },
    })
    const apiKey = await createApiKey(platform, ['work-items:read'])

    const response = await router.request('http://localhost/v1/work-items', {
      headers: { Authorization: `Bearer ${apiKey.secret}` },
    })

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      code: 'forbidden',
      detail: 'This Workspace is closing.',
    })
    expect(observations).toEqual(['workspace-1'])
  })

  test('refuses a credential whose owner is no longer an active member', async () => {
    const subjects: string[] = []
    let ownerActive = true
    const { platform, router } = createTestRouter({
      async requireActiveCredentialSubject(credential) {
        subjects.push(`${credential.workspaceId}/${credential.subjectUserId}`)
        if (!ownerActive) {
          throw new PublicApiServiceError(403, 'forbidden', 'The credential owner is not an active Workspace member.')
        }
      },
    })
    const apiKey = await createApiKey(platform, ['work-items:read'])
    const request = () => router.request('http://localhost/v1/work-items?teamId=team-1', {
      headers: { Authorization: `Bearer ${apiKey.secret}` },
    })

    expect((await request()).status).toBe(200)
    ownerActive = false
    const refused = await request()
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'forbidden' })
    expect(subjects).toEqual(['workspace-1/user-1', 'workspace-1/user-1'])
  })

  test('returns canonical schedules, including explicitly unscheduled Work Items', async () => {
    const scheduled = createWorkItem('scheduled')
    const unscheduled: CanonicalWorkItem = {
      ...createWorkItem('unscheduled'),
      dueDate: '',
      schedule: {
        calendarPolicy: scheduled.schedule.calendarPolicy,
        mode: 'unscheduled',
      },
    }
    const { platform, router } = createTestRouter({
      workItems: createDefaultWorkItemService({
        async list() {
          return { items: [scheduled, unscheduled], hasMore: false }
        },
        async get() {
          return unscheduled
        },
      }),
    })
    const apiKey = await createApiKey(platform, ['work-items:read'])
    const headers = { Authorization: `Bearer ${apiKey.secret}` }

    const [listResponse, detailResponse] = await Promise.all([
      router.request('http://localhost/v1/work-items?teamId=team-1', { headers }),
      router.request('http://localhost/v1/work-items/unscheduled?teamId=team-1', { headers }),
    ])

    expect(listResponse.status).toBe(200)
    expect((await listResponse.json()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'scheduled',
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        schedule: expect.objectContaining({ mode: 'due-date' }),
      }),
      expect.objectContaining({
        id: 'unscheduled',
        schemaVersion: WORK_ITEM_SCHEMA_VERSION,
        schedule: expect.objectContaining({ mode: 'unscheduled' }),
      }),
    ]))
    expect(detailResponse.status).toBe(200)
    expect(await detailResponse.json()).toMatchObject({
      id: 'unscheduled',
      schemaVersion: WORK_ITEM_SCHEMA_VERSION,
      schedule: { mode: 'unscheduled' },
    })
  })

  test('returns the Work Item hierarchy from its own read-scoped endpoint', async () => {
    const reads: string[] = []
    const { platform, router } = createTestRouter({
      workItems: createDefaultWorkItemService({
        async getHierarchy(_credential, teamId, workItemId) {
          reads.push(`${teamId}/${workItemId}`)
          return {
            schemaVersion: 1,
            teamId,
            workItemId,
            parentWorkItemId: 'phase-1',
            childWorkItemIds: ['task-1'],
            wbsNumber: '1.2',
          }
        },
      }),
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])

    const response = await router.request('http://localhost/v1/work-items/work-item-1/hierarchy?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const denied = await router.request('http://localhost/v1/work-items/work-item-1/hierarchy?teamId=team-1', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      teamId: 'team-1',
      workItemId: 'work-item-1',
      parentWorkItemId: 'phase-1',
      childWorkItemIds: ['task-1'],
      wbsNumber: '1.2',
    })
    expect(denied.status).toBe(403)
    expect(reads).toEqual(['team-1/work-item-1'])
  })

  test('returns the completion Gate status from its own read-scoped endpoint', async () => {
    const reads: string[] = []
    const { platform, router } = createTestRouter({
      workItems: createDefaultWorkItemService({
        async getCompletionGate(_credential, teamId, workItemId) {
          reads.push(`${teamId}/${workItemId}`)
          return {
            schemaVersion: 1,
            teamId,
            workItemId,
            revision: 3,
            conditions: [
              { condition: 'acceptance-criteria', requirement: 'required', state: 'unmet', message: '1 of 1 acceptance criteria are not satisfied.' },
            ],
            blocksCompletion: true,
          }
        },
      }),
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])

    const response = await router.request('http://localhost/v1/work-items/work-item-1/completion-gate?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const denied = await router.request('http://localhost/v1/work-items/work-item-1/completion-gate?teamId=team-1', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      teamId: 'team-1',
      workItemId: 'work-item-1',
      revision: 3,
      conditions: [
        { condition: 'acceptance-criteria', requirement: 'required', state: 'unmet', message: '1 of 1 acceptance criteria are not satisfied.' },
      ],
      blocksCompletion: true,
    })
    expect(denied.status).toBe(403)
    expect(reads).toEqual(['team-1/work-item-1'])
  })

  test('returns the Work Item key from its own read-scoped endpoint', async () => {
    const reads: string[] = []
    const { platform, router } = createTestRouter({
      workItems: createDefaultWorkItemService({
        async getKey(_credential, teamId, workItemId) {
          reads.push(`${teamId}/${workItemId}`)
          return { schemaVersion: 1, teamId, workItemId, createdAt: '2026-07-18T00:00:00.000Z', key: 'TEAM-7' }
        },
      }),
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])

    const response = await router.request('http://localhost/v1/work-items/work-item-1/key?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const denied = await router.request('http://localhost/v1/work-items/work-item-1/key?teamId=team-1', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      schemaVersion: 1, teamId: 'team-1', workItemId: 'work-item-1', createdAt: '2026-07-18T00:00:00.000Z', key: 'TEAM-7',
    })
    expect(denied.status).toBe(403)
    expect(reads).toEqual(['team-1/work-item-1'])
  })

  test('returns the actual dates of a Work Item from their own read-scoped endpoint', async () => {
    const reads: string[] = []
    const { platform, router } = createTestRouter({
      workItems: createDefaultWorkItemService({
        async getActualDates(_credential, teamId, workItemId) {
          reads.push(`${teamId}/${workItemId}`)
          return { schemaVersion: 1, teamId, workItemId, revision: 4, actualStartDate: '2026-07-01', actualEndDate: '2026-07-09' }
        },
      }),
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])

    const response = await router.request('http://localhost/v1/work-items/work-item-1/actual-dates?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const denied = await router.request('http://localhost/v1/work-items/work-item-1/actual-dates?teamId=team-1', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })
    const missingTeam = await router.request('http://localhost/v1/work-items/work-item-1/actual-dates', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      schemaVersion: 1, teamId: 'team-1', workItemId: 'work-item-1', revision: 4,
      actualStartDate: '2026-07-01', actualEndDate: '2026-07-09',
    })
    expect(denied.status).toBe(403)
    expect(missingTeam.status).toBe(400)
    expect(reads).toEqual(['team-1/work-item-1'])
  })

  test('reads and changes Work Item relations with the matching scopes and replays an idempotent create', async () => {
    const calls: string[] = []
    const { platform, router } = createTestRouter({
      workItemRelations: {
        async listRelations(_credential, teamId, workItemId) {
          calls.push(`list ${teamId}/${workItemId}`)
          return { schemaVersion: 1, teamId, workItemId, relations: [{ type: 'blockedBy', targetWorkItemId: 'task-2' }] }
        },
        async authorizeRelationChange(_credential, teamId, workItemId, targetWorkItemId) {
          calls.push(`authorize ${teamId}/${workItemId}->${targetWorkItemId}`)
        },
        async createRelation(_credential, teamId, workItemId, input, context, idempotency) {
          calls.push(`create ${teamId}/${workItemId} ${input.type} ${input.targetWorkItemId} ${context.idempotencyKey} ${idempotency?.idempotencyKey}`)
          return { schemaVersion: 1, teamId, workItemId, relation: { type: input.type, targetWorkItemId: input.targetWorkItemId } }
        },
        async deleteRelation(_credential, teamId, workItemId, targetWorkItemId, type, _context, idempotency) {
          calls.push(`delete ${teamId}/${workItemId} ${type} ${targetWorkItemId} ${idempotency?.idempotencyKey}`)
          return { schemaVersion: 1, teamId, workItemId, relation: { type, targetWorkItemId } }
        },
      },
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])
    const write = (path: string, method: string, key: string, body?: unknown) => router.request(`http://localhost${path}`, {
      method,
      headers: { Authorization: `Bearer ${writer.secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const listed = await router.request('http://localhost/v1/work-items/task-1/relations?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const listDenied = await router.request('http://localhost/v1/work-items/task-1/relations?teamId=team-1', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })
    const created = await write('/v1/work-items/task-1/relations?teamId=team-1', 'POST', 'relation-key', { type: 'child', targetWorkItemId: 'task-3' })
    const replayed = await write('/v1/work-items/task-1/relations?teamId=team-1', 'POST', 'relation-key', { type: 'child', targetWorkItemId: 'task-3' })
    const invalidType = await write('/v1/work-items/task-1/relations?teamId=team-1', 'POST', 'invalid-key', { type: 'sibling', targetWorkItemId: 'task-3' })
    const extraField = await write('/v1/work-items/task-1/relations?teamId=team-1', 'POST', 'extra-key', { type: 'related', targetWorkItemId: 'task-3', expectedGraphRevision: 2 })
    const createDenied = await router.request('http://localhost/v1/work-items/task-1/relations?teamId=team-1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${reader.secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'reader-key' },
      body: JSON.stringify({ type: 'related', targetWorkItemId: 'task-3' }),
    })
    const deleted = await write('/v1/work-items/task-1/relations/task-2/blockedBy?teamId=team-1', 'DELETE', 'delete-key')
    const deleteInvalid = await write('/v1/work-items/task-1/relations/task-2/sibling?teamId=team-1', 'DELETE', 'delete-invalid-key')

    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({
      schemaVersion: 1, teamId: 'team-1', workItemId: 'task-1', relations: [{ type: 'blockedBy', targetWorkItemId: 'task-2' }],
    })
    expect(listDenied.status).toBe(403)
    expect(created.status).toBe(201)
    expect(replayed.status).toBe(201)
    expect(replayed.headers.get('Idempotency-Replayed')).toBe('true')
    expect(await replayed.json()).toEqual({
      schemaVersion: 1, teamId: 'team-1', workItemId: 'task-1', relation: { type: 'child', targetWorkItemId: 'task-3' },
    })
    expect(invalidType.status).toBe(400)
    expect(extraField.status).toBe(400)
    expect(createDenied.status).toBe(403)
    expect(deleted.status).toBe(200)
    expect(deleteInvalid.status).toBe(400)
    expect(calls).toEqual([
      'list team-1/task-1',
      'create team-1/task-1 child task-3 relation-key relation-key',
      'authorize team-1/task-1->task-3',
      'delete team-1/task-1 blockedBy task-2 delete-key',
    ])
  })

  test('binds a subtask batch key to the parent and the whole list, and refuses another list with the same key', async () => {
    const calls: string[] = []
    const { platform, router } = createTestRouter({
      workItemRelations: {
        async listRelations() { throw new Error('not used') },
        async authorizeRelationChange(_credential, teamId, workItemId, targetWorkItemId) {
          calls.push(`authorize ${teamId}/${workItemId}->${targetWorkItemId}`)
        },
        async createRelation() { throw new Error('not used') },
        async deleteRelation() { throw new Error('not used') },
      },
    })
    const writer = await createApiKey(platform, ['work-items:write'])
    const reader = await createApiKey(platform, ['work-items:read'])
    const reserve = (key: string, body: unknown, secret = writer.secret) => router.request('http://localhost/v1/work-items/task-1/subtask-batches?teamId=team-1', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    })
    const list = { subtasks: [{ title: 'Design', assigneeUserId: 'owner', priority: 'medium' }] }

    const reserved = await reserve('batch-key', list)
    const replayed = await reserve('batch-key', list)
    const changed = await reserve('batch-key', { subtasks: [...list.subtasks, { title: 'Build' }] })
    const empty = await reserve('empty-key', { subtasks: [] })
    const tooMany = await reserve('many-key', { subtasks: Array.from({ length: 21 }, (_, index) => ({ title: `Task ${index}` })) })
    const unknownField = await reserve('field-key', { subtasks: [{ title: 'Design', parentId: 'task-9' }] })
    const untitled = await reserve('title-key', { subtasks: [{ description: 'No title' }] })
    const denied = await reserve('reader-key', list, reader.secret)
    // An entry takes the same description length as creating a Work Item.
    const longDescription = await reserve('long-key', { subtasks: [{ title: 'Design', description: 'x'.repeat(100_000) }] })
    const tooLongDescription = await reserve('too-long-key', { subtasks: [{ title: 'Design', description: 'x'.repeat(100_001) }] })

    expect(reserved.status).toBe(201)
    expect(await reserved.json()).toEqual({ schemaVersion: 1, teamId: 'team-1', workItemId: 'task-1', subtaskCount: 1 })
    expect(replayed.status).toBe(201)
    expect(replayed.headers.get('Idempotency-Replayed')).toBe('true')
    expect(changed.status).toBe(409)
    expect(await changed.json()).toMatchObject({ code: 'idempotency_conflict', retryable: false })
    expect([empty.status, tooMany.status, unknownField.status, untitled.status]).toEqual([400, 400, 400, 400])
    expect(denied.status).toBe(403)
    expect([longDescription.status, tooLongDescription.status]).toEqual([201, 400])
    // The first request and the replay both check that the caller may still link children to the parent.
    expect(calls).toEqual(['authorize team-1/task-1->task-1', 'authorize team-1/task-1->task-1', 'authorize team-1/task-1->task-1'])
  })

  test('lists Documents linked to a Work Item with the read scope and signs the continuation', async () => {
    const calls: { continuation: string | undefined; limit: number }[] = []
    const { platform, router } = createTestRouter({
      documents: {
        async listWorkItemDocuments(credential, teamId, workItemId, continuation, limit) {
          expect(credential.workspaceId).toBe('workspace-1')
          expect(`${teamId}/${workItemId}`).toBe('team-1/work-item-1')
          calls.push({ continuation, limit })
          return continuation === undefined
            ? { items: [{ id: 'document-1', title: 'Spec' }], hasMore: true, nextContinuation: 'backlink-cursor' }
            : { items: [], hasMore: false }
        },
        async getWorkItemDocument() {
          throw new Error('not used')
        },
        ...unusedWorkspaceDocumentMethods,
      },
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])

    const first = await router.request('http://localhost/v1/work-items/work-item-1/documents?teamId=team-1&limit=80', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const firstBody = await first.json() as { items: unknown[]; hasMore: boolean; nextCursor?: string }
    const second = await router.request(
      `http://localhost/v1/work-items/work-item-1/documents?teamId=team-1&limit=80&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      { headers: { Authorization: `Bearer ${reader.secret}` } },
    )
    const otherWorkItem = await router.request(
      `http://localhost/v1/work-items/work-item-2/documents?teamId=team-1&limit=80&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      { headers: { Authorization: `Bearer ${reader.secret}` } },
    )
    const denied = await router.request('http://localhost/v1/work-items/work-item-1/documents?teamId=team-1', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })
    const missingTeam = await router.request('http://localhost/v1/work-items/work-item-1/documents', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })

    expect(first.status).toBe(200)
    expect(firstBody.items).toEqual([{ id: 'document-1', title: 'Spec' }])
    expect(firstBody.hasMore).toBe(true)
    expect(firstBody.nextCursor).not.toContain('backlink-cursor')
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual({ items: [], hasMore: false })
    expect(otherWorkItem.status).toBe(400)
    expect(calls).toEqual([
      { continuation: undefined, limit: 50 },
      { continuation: 'backlink-cursor', limit: 50 },
    ])
    expect(denied.status).toBe(403)
    expect(missingTeam.status).toBe(400)
  })

  test('reads a linked Document as Markdown with the read scope and never caches it', async () => {
    const reads: string[] = []
    const { platform, router } = createTestRouter({
      documents: {
        async listWorkItemDocuments() {
          throw new Error('not used')
        },
        async getWorkItemDocument(_credential, teamId, workItemId, documentId) {
          reads.push(`${teamId}/${workItemId}/${documentId}`)
          if (documentId !== 'document-1') {
            throw new PublicApiServiceError(404, 'not_found', 'Document was not found.')
          }
          return {
            schemaVersion: 1, id: documentId, kind: 'page', title: 'Spec', revision: 3,
            updatedAt: NOW.toISOString(), format: 'markdown', content: '# Spec\n',
          }
        },
        ...unusedWorkspaceDocumentMethods,
      },
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])

    const response = await router.request('http://localhost/v1/work-items/work-item-1/documents/document-1?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const hidden = await router.request('http://localhost/v1/work-items/work-item-1/documents/document-2?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const denied = await router.request('http://localhost/v1/work-items/work-item-1/documents/document-1?teamId=team-1', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      schemaVersion: 1, id: 'document-1', kind: 'page', title: 'Spec', revision: 3,
      updatedAt: NOW.toISOString(), format: 'markdown', content: '# Spec\n',
    })
    expect(hidden.status).toBe(404)
    expect(denied.status).toBe(403)
    expect(reads).toEqual(['team-1/work-item-1/document-1', 'team-1/work-item-1/document-2'])
  })

  test('lists Workspace Documents with the read scope, filtered and with a signed continuation', async () => {
    const calls: unknown[] = []
    const { platform, router } = createTestRouter({
      documents: {
        ...unusedLinkedDocumentMethods,
        ...unusedWorkspaceDocumentMethods,
        async listDocuments(credential, filters, continuation, limit) {
          expect(credential.workspaceId).toBe('workspace-1')
          calls.push({ filters, continuation, limit })
          return continuation === undefined
            ? {
                items: [{ id: 'document-1', kind: 'page', title: 'Spec', scope: { type: 'project', projectId: 'project-1' }, revision: 2 }],
                hasMore: true,
                nextContinuation: 'tree-cursor',
              }
            : { items: [], hasMore: false }
        },
      },
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])

    const first = await router.request('http://localhost/v1/documents?projectId=project-1&limit=100', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const firstBody = await first.json() as { items: unknown[]; hasMore: boolean; nextCursor?: string }
    const second = await router.request(
      `http://localhost/v1/documents?projectId=project-1&limit=100&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      { headers: { Authorization: `Bearer ${reader.secret}` } },
    )
    const otherFilter = await router.request(
      `http://localhost/v1/documents?projectId=project-2&limit=100&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      { headers: { Authorization: `Bearer ${reader.secret}` } },
    )
    const denied = await router.request('http://localhost/v1/documents', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })

    expect(first.status).toBe(200)
    expect(first.headers.get('Cache-Control')).toBe('private, no-store')
    expect(firstBody.items).toEqual([{ id: 'document-1', kind: 'page', title: 'Spec', scope: { type: 'project', projectId: 'project-1' }, revision: 2 }])
    expect(firstBody.nextCursor).not.toContain('tree-cursor')
    expect(second.status).toBe(200)
    expect(otherFilter.status).toBe(400)
    expect(denied.status).toBe(403)
    expect(calls).toEqual([
      { filters: { projectId: 'project-1' }, continuation: undefined, limit: 100 },
      { filters: { projectId: 'project-1' }, continuation: 'tree-cursor', limit: 100 },
    ])
  })

  test('creates and updates a Document from Markdown with the write scope and replays a retry', async () => {
    const calls: string[] = []
    const content = (id: string, revision: number) => ({
      schemaVersion: 1 as const, id, kind: 'page' as const, title: 'Plan', revision,
      updatedAt: NOW.toISOString(), format: 'markdown' as const, content: '# Plan\n\nBody\n',
    })
    const { platform, router } = createTestRouter({
      documents: {
        ...unusedLinkedDocumentMethods,
        ...unusedWorkspaceDocumentMethods,
        async authorizeDocumentWrite() {
          calls.push('authorize')
        },
        async getDocument(_credential, documentId) {
          calls.push(`get ${documentId}`)
          return content(documentId, 2)
        },
        async createDocument(_credential, input, context) {
          calls.push(`create ${JSON.stringify(input)} ${context.idempotencyKey}`)
          return content('document-1', 1)
        },
        async updateDocument(_credential, documentId, input) {
          calls.push(`update ${documentId} ${JSON.stringify(input)}`)
          return content(documentId, input.expectedRevision + 1)
        },
      },
    })
    const writer = await createApiKey(platform, ['work-items:write'])
    const reader = await createApiKey(platform, ['work-items:read'])
    const post = (body: unknown, key: string, secret = writer.secret) => router.request('http://localhost/v1/documents', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    })
    const body = { title: ' Plan ', content: 'Body', projectId: 'project-1', workItem: { teamId: 'team-1', workItemId: 'task-1' } }

    const created = await post(body, 'create-1')
    const replayed = await post(body, 'create-1')
    const readOnly = await post(body, 'create-2', reader.secret)
    const unknownField = await post({ ...body, blocks: [] }, 'create-3')
    const noTitle = await post({ content: 'Body' }, 'create-4')
    const updated = await router.request('http://localhost/v1/documents/document-1', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${writer.secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'update-1' },
      body: JSON.stringify({ expectedRevision: 1, content: 'New body' }),
    })
    const emptyPatch = await router.request('http://localhost/v1/documents/document-1', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${writer.secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'update-2' },
      body: JSON.stringify({ expectedRevision: 1 }),
    })

    expect(created.status).toBe(201)
    expect(await created.json()).toEqual(content('document-1', 1))
    expect(replayed.status).toBe(201)
    expect(replayed.headers.get('Idempotency-Replayed')).toBe('true')
    expect(readOnly.status).toBe(403)
    expect(unknownField.status).toBe(400)
    expect(noTitle.status).toBe(400)
    expect(updated.status).toBe(200)
    expect((await updated.json() as { revision: number }).revision).toBe(2)
    expect(emptyPatch.status).toBe(400)
    expect(calls).toEqual([
      `create ${JSON.stringify({ title: 'Plan', content: 'Body', projectId: 'project-1', workItem: { teamId: 'team-1', workItemId: 'task-1' } })} create-1`,
      'authorize',
      `update document-1 ${JSON.stringify({ expectedRevision: 1, content: 'New body' })}`,
    ])
  })

  test('lists attachments and issues download URLs with the read scope and never caches them', async () => {
    const calls: string[] = []
    const { platform, router } = createTestRouter({
      attachments: {
        async listWorkItemAttachments(credential, teamId, workItemId) {
          expect(credential.workspaceId).toBe('workspace-1')
          calls.push(`list ${teamId}/${workItemId}`)
          return {
            items: [{
              id: 'file-1', name: 'spec.pdf', versionId: 'version-2', versionNumber: 2,
              contentType: 'application/pdf', sizeBytes: 2048, updatedAt: NOW.toISOString(),
            }],
          }
        },
        async createWorkItemAttachmentDownload(_credential, teamId, workItemId, fileId, request) {
          calls.push(`download ${teamId}/${workItemId}/${fileId} ${request.correlationId ?? '-'}`)
          expect(request.requestId).toBeTruthy()
          if (fileId !== 'file-1') throw new PublicApiServiceError(404, 'not_found', 'Attachment was not found.')
          return { fileId, versionId: 'version-2', url: 'https://files.example.test/file-1', expiresAt: NOW.toISOString() }
        },
      },
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])

    const list = await router.request('http://localhost/v1/work-items/work-item-1/attachments?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const download = await router.request('http://localhost/v1/work-items/work-item-1/attachments/file-1/download?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}`, 'X-Correlation-Id': 'corr-1' },
    })
    const hidden = await router.request('http://localhost/v1/work-items/work-item-1/attachments/file-2/download?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    const denied = await router.request('http://localhost/v1/work-items/work-item-1/attachments?teamId=team-1', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })
    const missingTeam = await router.request('http://localhost/v1/work-items/work-item-1/attachments', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })

    expect(list.status).toBe(200)
    expect(list.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await list.json()).toEqual({
      items: [{
        id: 'file-1', name: 'spec.pdf', versionId: 'version-2', versionNumber: 2,
        contentType: 'application/pdf', sizeBytes: 2048, updatedAt: NOW.toISOString(),
      }],
    })
    expect(download.status).toBe(200)
    expect(download.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await download.json()).toEqual({
      fileId: 'file-1', versionId: 'version-2', url: 'https://files.example.test/file-1', expiresAt: NOW.toISOString(),
    })
    expect(hidden.status).toBe(404)
    expect(denied.status).toBe(403)
    expect(missingTeam.status).toBe(400)
    // Error responses carry the same cache policy as the successful ones.
    for (const failed of [hidden, denied, missingTeam]) expect(failed.headers.get('Cache-Control')).toBe('private, no-store')
    expect(calls).toEqual([
      'list team-1/work-item-1',
      'download team-1/work-item-1/file-1 corr-1',
      'download team-1/work-item-1/file-2 -',
    ])
  })

  test('reports Document routes as unavailable when no Document service is configured', async () => {
    const { platform, router } = createTestRouter()
    const reader = await createApiKey(platform, ['work-items:read'])

    const response = await router.request('http://localhost/v1/work-items/work-item-1/documents/document-1?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })

    expect(response.status).toBe(503)
  })

  test('reads the credential owner, Teams, Project members, and Work Item keys with the read scope', async () => {
    const calls: string[] = []
    const { platform, router } = createTestRouter({
      directory: {
        async getCredentialOwner(credential) {
          calls.push(`me:${credential.subjectUserId}`)
          return { schemaVersion: 1, workspaceId: credential.workspaceId, memberId: credential.subjectUserId, email: 'owner@example.com' }
        },
        async listTeams(_credential, locale) {
          calls.push(`teams:${locale}`)
          return {
            schemaVersion: 1,
            items: [{ id: 'team-1', name: 'Platform', projects: [{ id: 'project-1', name: 'WBS', lifecycleState: 'active', code: 'WBS' }] }],
          }
        },
        async listProjectMembers(_credential, teamId, projectId) {
          calls.push(`members:${teamId}/${projectId}`)
          return { schemaVersion: 1, teamId, projectId, items: [{ id: 'member-1', email: 'member@example.com', role: 'member' }] }
        },
        async listProjectRaidLog(_credential, teamId, projectId) {
          calls.push(`raid:${teamId}/${projectId}`)
          return { schemaVersion: 1, teamId, projectId, items: [] }
        },
        async getProjectCharter(_credential, teamId, projectId) {
          calls.push(`charter:${teamId}/${projectId}`)
          return {
            schemaVersion: 1, teamId, projectId, lifecycleState: 'active', revision: 2,
            code: 'ABC', owner: { memberId: 'member-1', displayName: 'Owner' }, tags: [], repositoryUrls: [],
          }
        },
        async lookupWorkItemKey(_credential, key) {
          calls.push(`key:${key}`)
          if (key !== 'ABC-1') throw new PublicApiServiceError(404, 'not_found', 'No readable Work Item has this key.')
          return { schemaVersion: 1, key, teamId: 'team-1', workItemId: 'work-item-1' }
        },
      },
    })
    const reader = await createApiKey(platform, ['work-items:read'])
    const writer = await createApiKey(platform, ['work-items:write'])
    const headers = { Authorization: `Bearer ${reader.secret}` }

    const me = await router.request('http://localhost/v1/me', { headers })
    const teams = await router.request('http://localhost/v1/teams?locale=en', { headers })
    const badLocale = await router.request('http://localhost/v1/teams?locale=fr', { headers })
    const members = await router.request('http://localhost/v1/projects/project-1/members?teamId=team-1', { headers })
    const membersWithoutTeam = await router.request('http://localhost/v1/projects/project-1/members', { headers })
    const raidLog = await router.request('http://localhost/v1/projects/project-1/raid-log?teamId=team-1', { headers })
    const raidLogWithoutTeam = await router.request('http://localhost/v1/projects/project-1/raid-log', { headers })
    const charter = await router.request('http://localhost/v1/projects/project-1/charter?teamId=team-1', { headers })
    const charterWithoutTeam = await router.request('http://localhost/v1/projects/project-1/charter', { headers })
    const key = await router.request('http://localhost/v1/work-item-keys/ABC-1', { headers })
    const hiddenKey = await router.request('http://localhost/v1/work-item-keys/ABC-2', { headers })
    const paddedKey = await router.request('http://localhost/v1/work-item-keys/%20ABC-1', { headers })
    const longKey = await router.request(`http://localhost/v1/work-item-keys/${'A'.repeat(257)}`, { headers })
    const denied = await router.request('http://localhost/v1/teams', {
      headers: { Authorization: `Bearer ${writer.secret}` },
    })

    expect(me.status).toBe(200)
    expect(me.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await me.json()).toMatchObject({ schemaVersion: 1, workspaceId: 'workspace-1', email: 'owner@example.com' })
    expect(teams.status).toBe(200)
    expect(await teams.json()).toEqual({
      schemaVersion: 1,
      items: [{ id: 'team-1', name: 'Platform', projects: [{ id: 'project-1', name: 'WBS', lifecycleState: 'active', code: 'WBS' }] }],
    })
    expect(badLocale.status).toBe(400)
    expect(members.status).toBe(200)
    expect(members.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await members.json()).toEqual({
      schemaVersion: 1, teamId: 'team-1', projectId: 'project-1',
      items: [{ id: 'member-1', email: 'member@example.com', role: 'member' }],
    })
    expect(membersWithoutTeam.status).toBe(400)
    expect(raidLog.status).toBe(200)
    expect(raidLog.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await raidLog.json()).toEqual({ schemaVersion: 1, teamId: 'team-1', projectId: 'project-1', items: [] })
    expect(raidLogWithoutTeam.status).toBe(400)
    expect(charter.status).toBe(200)
    expect(charter.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await charter.json()).toEqual({
      schemaVersion: 1, teamId: 'team-1', projectId: 'project-1', lifecycleState: 'active', revision: 2,
      code: 'ABC', owner: { memberId: 'member-1', displayName: 'Owner' }, tags: [], repositoryUrls: [],
    })
    expect(charterWithoutTeam.status).toBe(400)
    expect(key.status).toBe(200)
    expect(await key.json()).toEqual({ schemaVersion: 1, key: 'ABC-1', teamId: 'team-1', workItemId: 'work-item-1' })
    expect(hiddenKey.status).toBe(404)
    expect(paddedKey.status).toBe(404)
    expect(longKey.status).toBe(404)
    expect(denied.status).toBe(403)
    expect(calls.filter((call) => !call.startsWith('me:'))).toEqual([
      'teams:en', 'members:team-1/project-1', 'raid:team-1/project-1', 'charter:team-1/project-1', 'key:ABC-1', 'key:ABC-2',
    ])
  })

  test('reports directory routes as unavailable when no directory service is configured', async () => {
    const { platform, router } = createTestRouter()
    const reader = await createApiKey(platform, ['work-items:read'])

    const response = await router.request('http://localhost/v1/teams', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })

    expect(response.status).toBe(503)
  })

  test('exposes the authorized Work Item Type creation schema', async () => {
    let requestedTeamId: string | undefined
    let requestedProjectId: string | undefined
    const catalog = {
      teamId: 'team-1',
      configurationRevision: 7,
      workItemTypes: [{
        id: 'incident',
        name: 'Incident',
        defaultWorkflowId: 'incident-workflow',
        workflow: {
          id: 'incident-workflow',
          name: 'Incident workflow',
          initialStatusId: 'incident-open',
          statuses: [{
            id: 'incident-open',
            name: 'Open',
            category: 'unstarted',
            sortOrder: 0,
          }],
        },
        customFields: [{
          id: 'severity',
          name: 'Severity',
          required: true,
          sortOrder: 0,
          type: 'select',
          options: [{ id: 'high', name: 'High', sortOrder: 0 }],
        }],
      }],
    } satisfies PublicWorkItemTypeCatalog
    const { platform, router } = createTestRouter({
      workItems: createDefaultWorkItemService({
        async listWorkItemTypes(_credential, teamId, projectId) {
          requestedTeamId = teamId
          requestedProjectId = projectId
          return catalog
        },
      }),
    })
    const apiKey = await createApiKey(platform, ['work-items:read'])

    const response = await router.request(
      'http://localhost/v1/work-item-types?teamId=team-1&assignedProjectId=project-1',
      { headers: { Authorization: `Bearer ${apiKey.secret}` } },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(catalog)
    expect(requestedTeamId).toBe('team-1')
    expect(requestedProjectId).toBe('project-1')
  })

  test('exposes a public Work Item Type change preview', async () => {
    let received: {
      teamId: string
      workItemId: string
      input: Record<string, unknown>
    } | undefined
    const previewDefinition = {
      id: 'severity',
      name: 'Severity',
      required: true,
      sortOrder: 0,
      type: 'formula',
      formulaExpression: '{amount} * 2',
    } satisfies CustomFieldDefinition
    const preview = {
      expectedRevision: 4,
      currentWorkItemTypeId: 'default',
      currentWorkflowStatusId: 'todo',
      targetWorkItemTypeId: 'incident',
      lostCustomFieldIds: ['customer-impact'],
      invalidWorkflowStatusId: 'todo',
      targetInitialWorkflowStatusId: 'incident-open',
      missingRequiredCustomFieldIds: ['severity'],
      missingRequiredCustomFieldDefinitions: [previewDefinition],
      approvalCompletionTransitionConflict: false,
      requiresResolution: true,
    }
    const publicPreview = {
      ...preview,
      missingRequiredCustomFieldDefinitions: [{
        id: 'severity',
        name: 'Severity',
        required: true,
        sortOrder: 0,
        type: 'formula',
      }],
    }
    const { platform, router } = createTestRouter({
      workItems: createDefaultWorkItemService({
        async previewTypeChange(_credential, teamId, workItemId, input) {
          received = { teamId, workItemId, input }
          return preview
        },
      }),
    })
    const apiKey = await createApiKey(platform, ['work-items:write'])

    const response = await router.request(
      'http://localhost/v1/work-items/work-item-1/work-item-type-preview?teamId=team-1',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expectedRevision: 4,
          targetWorkItemTypeId: 'incident',
          assignedProjectId: null,
        }),
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(publicPreview)
    expect(received).toEqual({
      teamId: 'team-1',
      workItemId: 'work-item-1',
      input: {
        expectedRevision: 4,
        targetWorkItemTypeId: 'incident',
        assignedProjectId: null,
      },
    })
  })

  test('rejects an oversized idempotent body before the lifecycle check', async () => {
    let lifecycleCalls = 0
    const { platform, router } = createTestRouter({
      async enforceActiveWorkspace() {
        lifecycleCalls += 1
      },
    })
    const apiKey = await createApiKey(platform, ['work-items:write'])

    const response = await router.request('http://localhost/v1/work-items', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secret}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'oversized-payload-key',
      },
      body: 'x'.repeat(10 * 1024 * 1024 + 1),
    })

    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      code: 'invalid_request',
      detail: 'The request body is too large.',
    })
    expect(lifecycleCalls).toBe(0)
  })

  test('does not check lifecycle for a request rejected by credential rate limiting', async () => {
    let lifecycleCalls = 0
    const { platform, router } = createTestRouter({
      rateLimits: {
        async consumeRateLimit() {
          return {
            allowed: false,
            limit: 120,
            remaining: 0,
            resetAt: '2026-08-02T00:01:00.000Z',
            retryAfterSeconds: 60,
          }
        },
      },
      async enforceActiveWorkspace() {
        lifecycleCalls += 1
      },
    })
    const apiKey = await createApiKey(platform, ['work-items:read'])

    const response = await router.request('http://localhost/v1/work-items', {
      headers: { Authorization: `Bearer ${apiKey.secret}` },
    })

    expect(response.status).toBe(429)
    expect(lifecycleCalls).toBe(0)
  })

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
    expect(paths['/api/v1/work-item-types']).toHaveProperty('get')
    expect(
      paths['/api/v1/work-item-types'].get.responses['200'].content['application/json'].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicWorkItemTypeCatalog' })
    expect(components.schemas.PublicCustomFieldDefinition.properties).not.toHaveProperty('formulaExpression')
    expect(paths['/api/v1/work-items/{workItemId}/external-links']).toHaveProperty('get')
    expect(paths['/api/v1/work-items/{workItemId}/external-links']).toHaveProperty('post')
    expect(paths['/api/v1/work-items/{workItemId}/work-item-type-preview']).toHaveProperty('post')
    expect(paths['/api/v1/work-items/{workItemId}/agent-runs']).toHaveProperty('post')
    expect(paths['/api/v1/work-items/{workItemId}/agent-runs']).toHaveProperty('get')
    expect(paths['/api/v1/agent-runs']).toHaveProperty('get')
    expect(paths['/api/v1/agent-runs/{runId}']).toHaveProperty('get')
    expect(paths['/api/v1/agent-runs/{runId}/heartbeat']).toHaveProperty('post')
    expect(paths['/api/v1/agent-runs/{runId}/finish']).toHaveProperty('post')
    expect(paths['/api/v1/agent-settings']).toHaveProperty('get')
    expect(paths['/api/v1/agent-context']).toHaveProperty('get')
    expect(paths['/api/v1/work-items/{workItemId}/acceptance-criteria']).toHaveProperty('get')
    expect(paths['/api/v1/work-items/{workItemId}/effort']).toHaveProperty('get')
    expect(paths['/api/v1/work-items/{workItemId}/key']).toHaveProperty('get')
    expect(paths['/api/v1/work-items/{workItemId}/actual-dates']).toHaveProperty('get')
    expect(paths['/api/v1/work-items/{workItemId}/documents']).toHaveProperty('get')
    expect(paths['/api/v1/work-items/{workItemId}/documents/{documentId}']).toHaveProperty('get')
    expect(paths['/api/v1/me']).toHaveProperty('get')
    expect(paths['/api/v1/teams']).toHaveProperty('get')
    expect(paths['/api/v1/projects/{projectId}/members']).toHaveProperty('get')
    expect(paths['/api/v1/work-item-keys/{key}']).toHaveProperty('get')
    expect(components.schemas.WorkItem.properties).not.toHaveProperty('actualStartDate')
    expect(components.schemas.WorkItem.properties).not.toHaveProperty('actualEndDate')
    expect(components.schemas.WorkItem.properties).not.toHaveProperty('acceptanceCriteria')
    expect(components.schemas.WorkItem.properties).not.toHaveProperty('remainingEffortMinutes')
    expect(components.schemas.WorkItem.properties).not.toHaveProperty('progressPercent')
    expect(components.schemas.UpdatePublicWorkItemRequest.properties).toHaveProperty('agentInstanceId')
    expect(components.schemas.CreatePublicWorkItemCommentRequest.properties).toHaveProperty('agentRunId')
    expect(
      paths['/api/v1/work-items/{workItemId}/work-item-type-preview'].post.responses['200'].content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PublicWorkItemTypeChangePreview' })
    expect(
      components.schemas.PublicWorkItemTypeChangePreview.properties
        .missingRequiredCustomFieldDefinitions.items,
    ).toEqual({ $ref: '#/components/schemas/PublicCustomFieldDefinition' })
    expect(
      paths['/api/v1/work-items/{workItemId}/work-item-type-preview'].post.requestBody.content[
        'application/json'
      ].schema,
    ).toEqual({ $ref: '#/components/schemas/PreviewPublicWorkItemTypeChangeRequest' })
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
    expect(paths['/api/developer/me/agent-connection']).toHaveProperty('get')
    expect(paths['/api/developer/me/api-keys']).toHaveProperty('post')
    expect(paths['/api/developer/me/api-keys/{apiKeyId}/rotate']).toHaveProperty('post')
    expect(paths['/api/developer/me/api-keys/{apiKeyId}']).toHaveProperty('delete')
    expect(paths['/api/developer/credential-policy']).toHaveProperty('put')
    expect(components.schemas.CreatePersonalApiKeyInput.required).toEqual(['name', 'expiresAt'])
    // Existing closed response schemas stay unchanged; self-issued keys are listed by new endpoints.
    expect(components.schemas.ApiKeySummary.properties).not.toHaveProperty('issuance')
    expect(components.schemas.DeveloperPlatformOverview.properties)
      .not.toHaveProperty('personalCredentialPolicy')
    expect(components.schemas.PersonalCredentialAdministration.required)
      .toEqual(['policy', 'personalApiKeyIds'])
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

  test('rejects impossible schedule dates while accepting leap and month-end dates', async () => {
    const receivedDueDates: string[] = []
    const workItems = createDefaultWorkItemService({
      async create(_credential, input) {
        if (input.schedule?.mode !== 'due-date') {
          throw new Error('Expected a deadline-only schedule.')
        }
        receivedDueDates.push(input.schedule.dueDate)
        return {
          ...createWorkItem(),
          dueDate: input.schedule.dueDate,
          schedule: input.schedule,
        }
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
        schedule: createDueDateSchedule(dueDate),
        priority: 'medium',
      }),
    })

    for (const impossible of ['0999-12-31', '2026-02-29', '2026-02-31', '2026-04-31']) {
      const response = await request(impossible)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    }
    for (const valid of ['1000-01-01', '2024-02-29', '2026-04-30']) {
      expect((await request(valid)).status).toBe(201)
    }
    expect(receivedDueDates).toEqual(['1000-01-01', '2024-02-29', '2026-04-30'])
  })

  test('accepts a create request without a schedule, with or without a due date, for the server to complete', async () => {
    const received: unknown[] = []
    const workItems = createDefaultWorkItemService({
      async create(_credential, input) {
        received.push({ schedule: input.schedule, dueDate: input.dueDate })
        return createWorkItem()
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:write'])
    const request = (key: string, fields: Record<string, unknown>) => router.request('http://localhost/v1/work-items', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secret}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({
        teamId: 'team-1',
        title: 'Workspace calendar',
        assigneeUserId: 'user-1',
        priority: 'medium',
        ...fields,
      }),
    })

    expect((await request('due-date', { dueDate: '2026-12-01' })).status).toBe(201)
    expect((await request('unscheduled', {})).status).toBe(201)
    expect(received).toEqual([
      { schedule: undefined, dueDate: '2026-12-01' },
      { schedule: undefined, dueDate: undefined },
    ])
    const both = await request('both', { dueDate: '2026-12-01', schedule: createDueDateSchedule('2026-12-01') })
    expect(both.status).toBe(400)
    expect(await both.json()).toMatchObject({ code: 'validation_failed' })
    expect((await request('bad-date', { dueDate: '2026-02-30' })).status).toBe(400)
    expect(received).toHaveLength(2)
  })

  test('passes estimate, remaining effort, and manual progress updates, including clears, and rejects invalid amounts', async () => {
    const inputs: unknown[] = []
    const workItems = createDefaultWorkItemService({
      async update(_credential, _teamId, _workItemId, input) {
        inputs.push(input)
        return createWorkItem()
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:write'])
    const request = (key: string, body: Record<string, unknown>) => router.request('http://localhost/v1/work-items/work-item-1?teamId=team-1', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey.secret}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({ expectedRevision: 1, ...body }),
    })

    expect((await request('effort-set', { remainingEffortMinutes: 90, progressPercent: 40 })).status).toBe(200)
    expect((await request('effort-clear', { remainingEffortMinutes: null, progressPercent: null })).status).toBe(200)
    expect((await request('estimate-set', { plannedEffortMinutes: 480 })).status).toBe(200)
    expect((await request('estimate-clear', { plannedEffortMinutes: null })).status).toBe(200)
    for (const [key, body] of [
      ['estimate-negative', { plannedEffortMinutes: -1 }],
      ['estimate-with-schedule', {
        plannedEffortMinutes: 60,
        schedule: { mode: 'unscheduled', calendarPolicy: { timeZone: 'UTC', workingWeekdays: ['monday'], holidays: [] } },
      }],
      ['effort-negative', { remainingEffortMinutes: -1 }],
      ['effort-fraction', { remainingEffortMinutes: 1.5 }],
      ['progress-over', { progressPercent: 101 }],
      ['progress-text', { progressPercent: '50' }],
    ] as const) {
      const response = await request(key, body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    }
    expect(inputs).toEqual([
      { expectedRevision: 1, remainingEffortMinutes: 90, progressPercent: 40 },
      { expectedRevision: 1, remainingEffortMinutes: null, progressPercent: null },
      { expectedRevision: 1, plannedEffortMinutes: 480 },
      { expectedRevision: 1, plannedEffortMinutes: null },
    ])
  })

  test('reads the effort of a Work Item from its own endpoint with the read scope', async () => {
    const reads: string[] = []
    const workItems = createDefaultWorkItemService({
      async getEffort(_credential, teamId, workItemId) {
        reads.push(`${teamId}/${workItemId}`)
        return { schemaVersion: 1, teamId, workItemId, revision: 3, plannedEffortMinutes: 480, remainingEffortMinutes: 120, progressPercent: 75 }
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:read'])
    const response = await router.request('http://localhost/v1/work-items/work-item-1/effort?teamId=team-1', {
      headers: { Authorization: `Bearer ${apiKey.secret}` },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      schemaVersion: 1, teamId: 'team-1', workItemId: 'work-item-1', revision: 3,
      plannedEffortMinutes: 480, remainingEffortMinutes: 120, progressPercent: 75,
    })
    expect(reads).toEqual(['team-1/work-item-1'])
    const missingTeam = await router.request('http://localhost/v1/work-items/work-item-1/effort', {
      headers: { Authorization: `Bearer ${apiKey.secret}` },
    })
    expect(missingTeam.status).toBe(400)
  })

  test('rejects oversized calendar collections before invoking the Work Item service', async () => {
    let createCalls = 0
    const workItems = createDefaultWorkItemService({
      async create() {
        createCalls += 1
        return createWorkItem()
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:write'])
    const response = await router.request('http://localhost/v1/work-items', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secret}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'oversized-calendar-policy',
      },
      body: JSON.stringify({
        assigneeUserId: 'user-1',
        priority: 'medium',
        schedule: {
          ...createDueDateSchedule('2026-07-31'),
          calendarPolicy: {
            ...createDueDateSchedule('2026-07-31').calendarPolicy,
            holidays: Array.from(
              { length: WORK_ITEM_SCHEDULE_MAX_HOLIDAYS + 1 },
              () => '2026-01-01',
            ),
          },
        },
        teamId: 'team-1',
        title: 'Oversized calendar policy',
      }),
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    expect(createCalls).toBe(0)
  })

  test('rechecks current Work Item RBAC before replaying completed mutation receipts', async () => {
    let allowReplay = false
    const authorizationChecks: string[] = []
    const operationCalls = { create: 0, update: 0, delete: 0 }
    const requireReplayAccess = (operation: string) => {
      authorizationChecks.push(operation)
      if (!allowReplay) {
        throw new PublicApiServiceError(403, 'forbidden', 'Work Item access was revoked.')
      }
    }
    const workItems = createDefaultWorkItemService({
      async authorizeCreate(_credential, input) {
        expect(input.teamId).toBe('team-1')
        requireReplayAccess('create')
      },
      async create() {
        operationCalls.create += 1
        return createWorkItem('work-item-created')
      },
      async authorizeUpdate(_credential, teamId, workItemId, input) {
        expect({ teamId, workItemId, expectedRevision: input.expectedRevision }).toEqual({
          teamId: 'team-1',
          workItemId: 'work-item-1',
          expectedRevision: 1,
        })
        requireReplayAccess('update')
      },
      async update() {
        operationCalls.update += 1
        return { ...createWorkItem(), title: 'Updated through API' }
      },
      async authorizeDelete(_credential, teamId, workItemId) {
        expect({ teamId, workItemId }).toEqual({
          teamId: 'team-1',
          workItemId: 'work-item-1',
        })
        requireReplayAccess('delete')
      },
      async delete() {
        operationCalls.delete += 1
        return createWorkItem()
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:write', 'work-items:delete'])
    const authorization = { Authorization: `Bearer ${apiKey.secret}` }
    const createRequest = () => router.request('http://localhost/v1/work-items', {
      method: 'POST',
      headers: {
        ...authorization,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'replay-create-work-item',
      },
      body: JSON.stringify({
        teamId: 'team-1',
        title: 'Replay create',
        assigneeUserId: 'user-1',
        schedule: createDueDateSchedule('2026-07-31'),
        priority: 'medium',
      }),
    })
    const updateRequest = () => router.request(
      'http://localhost/v1/work-items/work-item-1?teamId=team-1',
      {
        method: 'PATCH',
        headers: {
          ...authorization,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'replay-update-work-item',
        },
        body: JSON.stringify({ expectedRevision: 1, title: 'Updated through API' }),
      },
    )
    const deleteRequest = () => router.request(
      'http://localhost/v1/work-items/work-item-1?teamId=team-1',
      {
        method: 'DELETE',
        headers: {
          ...authorization,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'replay-delete-work-item',
        },
        body: JSON.stringify({ expectedRevision: 1 }),
      },
    )

    const created = await createRequest()
    const createdBody = await created.json()
    const updated = await updateRequest()
    const updatedBody = await updated.json()
    const deleted = await deleteRequest()
    expect(created.status).toBe(201)
    expect(updated.status).toBe(200)
    expect(deleted.status).toBe(204)
    expect(created.headers.get('Idempotency-Replayed')).toBeNull()
    expect(updated.headers.get('Idempotency-Replayed')).toBeNull()
    expect(deleted.headers.get('Idempotency-Replayed')).toBeNull()
    expect(authorizationChecks).toEqual([])

    for (const request of [createRequest, updateRequest, deleteRequest]) {
      const denied = await request()
      expect(denied.status).toBe(403)
      expect(denied.headers.get('Idempotency-Replayed')).toBeNull()
      expect(await denied.json()).toMatchObject({ code: 'forbidden' })
    }
    expect(operationCalls).toEqual({ create: 1, update: 1, delete: 1 })

    allowReplay = true
    const createdReplay = await createRequest()
    const updatedReplay = await updateRequest()
    const deletedReplay = await deleteRequest()
    expect(createdReplay.status).toBe(201)
    expect(updatedReplay.status).toBe(200)
    expect(deletedReplay.status).toBe(204)
    expect(createdReplay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(updatedReplay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(deletedReplay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(await createdReplay.json()).toEqual(createdBody)
    expect(await updatedReplay.json()).toEqual(updatedBody)
    expect(await deletedReplay.text()).toBe('')
    expect(operationCalls).toEqual({ create: 1, update: 1, delete: 1 })
    expect(authorizationChecks).toEqual([
      'create',
      'update',
      'delete',
      'create',
      'update',
      'delete',
    ])
  })

  test('denies a replay before validating a malformed stored receipt', async () => {
    let authorizationChecks = 0
    let createCalls = 0
    const workItems = createDefaultWorkItemService({
      async authorizeCreate() {
        authorizationChecks += 1
        throw new PublicApiServiceError(403, 'forbidden', 'Work Item access was revoked.')
      },
      async create() {
        createCalls += 1
        return createWorkItem()
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:write'])
    platform.reserveIdempotency = async () => ({
      status: 'replay' as const,
      response: {
        status: 299,
        body: { receiptSecret: 'must-not-be-exposed' },
      },
    })

    const response = await router.request('http://localhost/v1/work-items', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.secret}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'malformed-receipt-with-revoked-access',
      },
      body: JSON.stringify({
        teamId: 'team-1',
        title: 'Denied replay',
        assigneeUserId: 'user-1',
        schedule: createDueDateSchedule('2026-07-31'),
        priority: 'medium',
      }),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('Idempotency-Replayed')).toBeNull()
    const responseText = await response.text()
    expect(responseText).not.toContain('must-not-be-exposed')
    expect(JSON.parse(responseText)).toMatchObject({ code: 'forbidden' })
    expect(authorizationChecks).toBe(1)
    expect(createCalls).toBe(0)
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
        expiresAt: API_KEY_EXPIRES_AT,
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
    const platform = new InMemoryDeveloperPlatformStorage(
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
        expiresAt: API_KEY_EXPIRES_AT,
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      code: 'idempotency_conflict',
      retryable: true,
    })
  })

  test('recovers the one-time secret after handler completion fails', async () => {
    const platform = new InMemoryDeveloperPlatformStorage(
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
        expiresAt: API_KEY_EXPIRES_AT,
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
    let allowWrite = true
    const workItems = createDefaultWorkItemService({
      async authorizeExternalLink(_credential, teamId, workItemId, write) {
        authorized.push({ teamId, workItemId, write })
        if (write && !allowWrite) {
          throw new PublicApiServiceError(403, 'forbidden', 'Work Item access was revoked.')
        }
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
          externalId: 'mnmn0/mukuroji#29',
          externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
          displayKey: '#29',
          syncDirection: 'bidirectional',
        }),
      },
    )
    expect(created.status).toBe(201)
    const link = await created.json() as { id: string }
    expect(link.id).toBeString()

    // `#` is allowed for provider IDs such as a GitHub issue's owner/repository#number, but an ID
    // still has to start with a letter or digit.
    const badId = await router.request(
      'http://localhost/v1/work-items/work-item-1/external-links?teamId=team-1',
      {
        method: 'POST',
        headers: { ...authorization, 'Content-Type': 'application/json', 'Idempotency-Key': 'link-bad-external-id' },
        body: JSON.stringify({
          installationId: installation.id,
          resourceType: 'issue',
          externalId: '#29',
          externalUrl: 'https://github.com/mnmn0/mukuroji/issues/29',
          syncDirection: 'bidirectional',
        }),
      },
    )
    expect(badId.status).toBe(400)

    // A calendar event link is always created by Mukuroji, so an existing event ID is refused.
    const existingEvent = await router.request(
      'http://localhost/v1/work-items/work-item-1/external-links?teamId=team-1',
      {
        method: 'POST',
        headers: {
          ...authorization,
          'Content-Type': 'application/json',
          'Idempotency-Key': 'link-existing-calendar-event',
        },
        body: JSON.stringify({
          installationId: installation.id,
          resourceType: 'calendar-event',
          externalId: 'existing-event',
          externalUrl: 'https://calendar.google.com/event?eid=existing-event',
          syncDirection: 'inbound',
        }),
      },
    )
    expect(existingEvent.status).toBe(400)

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
    allowWrite = false
    const deniedReplay = await router.request(
      `http://localhost/v1/work-items/work-item-1/external-links/${link.id}?teamId=team-1`,
      {
        method: 'DELETE',
        headers: {
          ...authorization,
          'Idempotency-Key': 'delete-public-external-link',
        },
      },
    )
    expect(deniedReplay.status).toBe(403)
    expect(deniedReplay.headers.get('Idempotency-Replayed')).toBeNull()
    expect(await deniedReplay.json()).toMatchObject({ code: 'forbidden' })
    allowWrite = true
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
      { teamId: 'team-1', workItemId: 'work-item-1', write: true },
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

  test('requires canonical scope and current RBAC before replaying a managed link deletion', async () => {
    let allowWrite = true
    const authorized: Array<{ teamId: string; workItemId: string; write: boolean }> = []
    const workItems = createDefaultWorkItemService({
      async authorizeExternalLink(_credential, teamId, workItemId, write) {
        authorized.push({ teamId, workItemId, write })
        if (write && !allowWrite) {
          throw new PublicApiServiceError(403, 'forbidden', 'Work Item access was revoked.')
        }
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const installation = await platform.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Managed delete GitHub',
        scopes: ['issues:read'],
        credential: 'managed-delete-credential',
      },
    })
    const link = await platform.createExternalWorkItemLink({
      workspaceId: 'workspace-1',
      input: {
        teamId: 'team-1',
        workItemId: 'work-item-1',
        installationId: installation.id,
        resourceType: 'issue',
        externalId: 'GH-57',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/57',
        displayKey: '#57',
        syncDirection: 'bidirectional',
      },
    })
    const deleteLink = platform.deleteExternalWorkItemLink.bind(platform)
    let deleteCalls = 0
    platform.deleteExternalWorkItemLink = async (request) => {
      deleteCalls += 1
      return deleteLink(request)
    }
    const scopedUrl = `http://localhost/developer/external-links/${link.id}` +
      '?teamId=team-1&workItemId=work-item-1'
    const request = (url = scopedUrl) => router.request(url, {
      method: 'DELETE',
      headers: {
        Authorization: 'Bearer session-token',
        'Idempotency-Key': 'delete-managed-link-with-current-rbac',
      },
    })

    const missingScope = await request(
      `http://localhost/developer/external-links/${link.id}`,
    )
    expect(missingScope.status).toBe(400)
    expect(await missingScope.json()).toMatchObject({ code: 'invalid_request' })

    const deleted = await request()
    expect(deleted.status).toBe(204)
    expect(deleted.headers.get('Idempotency-Replayed')).toBeNull()
    expect(deleteCalls).toBe(1)

    allowWrite = false
    const deniedReplay = await request()
    expect(deniedReplay.status).toBe(403)
    expect(deniedReplay.headers.get('Idempotency-Replayed')).toBeNull()
    expect(await deniedReplay.json()).toMatchObject({ code: 'forbidden' })
    expect(deleteCalls).toBe(1)

    allowWrite = true
    const replay = await request()
    expect(replay.status).toBe(204)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(await replay.text()).toBe('')
    expect(deleteCalls).toBe(1)
    expect(authorized).toEqual([
      { teamId: 'team-1', workItemId: 'work-item-1', write: true },
      { teamId: 'team-1', workItemId: 'work-item-1', write: true },
      { teamId: 'team-1', workItemId: 'work-item-1', write: true },
    ])
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

  test('stages a nested import once and reauthorizes its completed replay', async () => {
    const received: PublicImportSourceInput[] = []
    let allowReplay = false
    let replayValidations = 0
    const workItems = createDefaultWorkItemService({
      async dryRunImport(_principal, input) {
        replayValidations += 1
        expect(input.teamId).toBe('team-1')
        if (!allowReplay) {
          throw new PublicApiServiceError(403, 'forbidden', 'Import access was revoked.')
        }
        return {
          valid: true,
          totalRows: 1,
          validRows: 1,
          invalidRows: 0,
          errors: [],
          sample: [],
        }
      },
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
        content: 'Title,Assignee,Schedule\n Example ,user-1,"{""mode"":""unscheduled""}"\n',
      },
      teamId: 'team-1',
      mapping: [
        { sourceField: 'Title', targetField: 'title', transform: 'trim' },
        { sourceField: 'Assignee', targetField: 'assigneeUserId' },
        { sourceField: 'Schedule', targetField: 'schedule', required: true },
      ],
    }
    const request = () => router.request('http://localhost/developer/imports', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'commit-import-source',
      },
      body: JSON.stringify(input),
    })
    const response = await request()
    const responseBody = await response.json()

    expect(response.status).toBe(202)
    expect(received).toEqual([input])
    expect(responseBody).toMatchObject({
      id: 'import-commit',
      status: 'queued',
      dryRun: false,
    })

    const deniedReplay = await request()
    expect(deniedReplay.status).toBe(403)
    expect(deniedReplay.headers.get('Idempotency-Replayed')).toBeNull()
    expect(received).toEqual([input])

    allowReplay = true
    const replay = await request()
    expect(replay.status).toBe(202)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(await replay.json()).toEqual(responseBody)
    expect(received).toEqual([input])
    expect(replayValidations).toBe(2)
  })

  test('retries a side-effect-free import dry-run after response receipt persistence fails', async () => {
    const platform = new InMemoryDeveloperPlatformStorage(
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
    expect(validations).toBe(3)
  })

  test('accepts an import source up to the import byte limit and rejects a larger one', async () => {
    const platform = new InMemoryDeveloperPlatformStorage(
      new LocalAesGcmSecretProtector(new Uint8Array(32).fill(9)),
      () => new Date(NOW),
    )
    const validatedBytes: number[] = []
    const workItems = createDefaultWorkItemService({
      async dryRunImport(_principal, input) {
        validatedBytes.push(new TextEncoder().encode(input.source.content).byteLength)
        return { valid: true, totalRows: 1, validRows: 1, invalidRows: 0, errors: [], sample: [] }
      },
    })
    const { router } = createTestRouter({ platform, workItems })
    /** Sends a dry-run whose source holds the given number of bytes, padded with `filler`. */
    const dryRun = (bytes: number, key: string, filler = 'x') => router.request('http://localhost/developer/imports/dry-run', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify({
        format: 'csv',
        source: {
          fileName: 'work-items.csv',
          mediaType: 'text/csv',
          content: `Title\n${filler.repeat(bytes - 'Title\n'.length)}`,
        },
        teamId: 'team-1',
        mapping: [{ sourceField: 'Title', targetField: 'title' }],
      }),
    })

    expect((await dryRun(3 * 1024 * 1024, 'dry-run-3-mib')).status).toBe(200)
    expect(validatedBytes).toEqual([3 * 1024 * 1024])
    expect((await dryRun(4 * 1024 * 1024 + 1, 'dry-run-over-limit')).status).toBe(400)
    // Quotes are escaped in the request body and again in the Lambda event, so 1.5 MiB of them count as 6 MiB.
    expect((await dryRun(1.5 * 1024 * 1024, 'dry-run-escaped-over-limit', '"')).status).toBe(400)
    expect(validatedBytes).toHaveLength(1)

    const longField = await router.request('http://localhost/developer/imports/dry-run', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'dry-run-long-mapping',
      },
      body: JSON.stringify({
        format: 'csv',
        source: { fileName: 'work-items.csv', mediaType: 'text/csv', content: 'Title\nx' },
        teamId: 'team-1',
        mapping: [{ sourceField: 'T'.repeat(257), targetField: 'title' }],
      }),
    })
    expect(longField.status).toBe(400)
    expect(validatedBytes).toHaveLength(1)
  })

  test('retries import cancellation deterministically after response receipt persistence fails', async () => {
    const platform = new InMemoryDeveloperPlatformStorage(
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
    let allowAuthorization = true
    let authorizationChecks = 0
    const workItems = createDefaultWorkItemService({
      async authorizeImportJob() {
        authorizationChecks += 1
        if (!allowAuthorization) {
          throw new PublicApiServiceError(403, 'forbidden', 'Import access was revoked.')
        }
      },
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

    allowAuthorization = false
    const deniedReplay = await request('cancel-import-receipt-retry')
    expect(deniedReplay.status).toBe(404)
    expect(deniedReplay.headers.get('Idempotency-Replayed')).toBeNull()
    expect(cancellations).toBe(2)

    allowAuthorization = true
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
    expect(authorizationChecks).toBe(5)
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

  test('returns the progress of the caller\'s own import job only', async () => {
    const { platform, router } = createTestRouter()
    const own = await platform.createImportJob({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        format: 'csv',
        teamId: 'team-1',
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

    const progress = await router.request(`http://localhost/developer/imports/${own.id}/progress`, {
      headers: { Authorization: 'Bearer session-token' },
    })
    expect(progress.status).toBe(200)
    expect(await progress.json()).toEqual({
      jobId: own.id,
      status: own.status,
      totalRows: 2,
      processedRows: 1,
      totalLinks: 0,
      processedLinks: 0,
    })

    const hidden = await router.request(`http://localhost/developer/imports/${foreign.id}/progress`, {
      headers: { Authorization: 'Bearer session-token' },
    })
    expect(hidden.status).toBe(404)
  })

  test('creates a separate calendar event for each credential that reuses an idempotency key', async () => {
    const operationIds: string[] = []
    const notUsed = async (): Promise<never> => {
      throw new Error('not used')
    }
    const connectorAuthorization: ConnectorAuthorizationService = {
      begin: notUsed,
      completeCallback: notUsed,
      abortCallback: notUsed,
      reauthorize: notUsed,
      disconnect: notUsed,
      listConflicts: notUsed,
      resolveConflict: notUsed,
      async createLinkedResource(input) {
        operationIds.push(input.operationId)
        const externalId = `event-${operationIds.length}`
        return { externalId, externalUrl: `https://calendar.google.com/event?eid=${externalId}` }
      },
    }
    const { platform, router } = createTestRouter({ connectorAuthorization })
    const installation = await platform.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'calendar',
        provider: 'google-calendar',
        name: 'Team calendar',
        scopes: ['https://www.googleapis.com/auth/calendar.events'],
        credential: 'connector-credential',
      },
    })
    const scopes: ApiScope[] = ['work-items:read', 'work-items:write', 'integrations:read', 'integrations:write']
    const keys = [await createApiKey(platform, scopes), await createApiKey(platform, scopes)]

    for (const key of keys) {
      const created = await router.request(
        'http://localhost/v1/work-items/work-item-1/external-links?teamId=team-1',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key.secret}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': 'shared-calendar-key',
          },
          body: JSON.stringify({
            installationId: installation.id,
            resourceType: 'calendar-event',
            syncDirection: 'bidirectional',
          }),
        },
      )
      expect(created.status).toBe(201)
    }

    expect(operationIds).toHaveLength(2)
    expect(operationIds[0]).not.toBe(operationIds[1])
  })

  test('retains the local connector credential when provider disconnect fails', async () => {
    let disconnectAttempts = 0
    let disconnectPlatform: InMemoryDeveloperPlatformStorage | undefined
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
      async disconnect(_principal, installationId) {
        disconnectAttempts += 1
        if (disconnectAttempts === 1) {
          throw new Error('provider unavailable with credential=must-not-leak')
        }
        if (!disconnectPlatform) throw new Error('test platform is unavailable')
        await disconnectPlatform.updateConnectorStatus({
          workspaceId: 'workspace-1',
          installationId,
          status: 'disconnected',
        })
        return disconnectPlatform.readConnectorLifecycleSnapshot({
          workspaceId: 'workspace-1',
          installationId,
        })
      },
      async listConflicts() {
        return { items: [], hasMore: false }
      },
      async resolveConflict() {
        throw new Error('not used')
      },
    }
    const { platform, router } = createTestRouter({ connectorAuthorization })
    disconnectPlatform = platform
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

  test('recovers when the disconnect response is lost after durable local commit', async () => {
    let platform: InMemoryDeveloperPlatformStorage | undefined
    let disconnectCalls = 0
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
      async disconnect(_principal, installationId) {
        disconnectCalls += 1
        if (!platform) throw new Error('test platform is unavailable')
        if (disconnectCalls === 1) {
          await platform.updateConnectorStatus({
            workspaceId: 'workspace-1',
            installationId,
            status: 'disconnected',
          })
          throw new Error('disconnect response was lost after commit')
        }
        return platform.readConnectorLifecycleSnapshot({
          workspaceId: 'workspace-1',
          installationId,
        })
      },
      async listConflicts() {
        return { items: [], hasMore: false }
      },
      async resolveConflict() {
        throw new Error('not used')
      },
    }
    const fixture = createTestRouter({ connectorAuthorization })
    platform = fixture.platform
    const installation = await platform.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Durable cleanup GitHub',
        scopes: ['issues:read'],
        credential: 'provider-credential',
      },
    })
    const request = () => fixture.router.request(
      `http://localhost/developer/connector-installations/${installation.id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: 'Bearer session-token',
          'Idempotency-Key': 'disconnect-cleanup-enqueue-retry',
        },
      },
    )

    const failed = await request()
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({
      code: 'temporarily_unavailable',
      detail: 'Connector disconnect did not finish. Retry the same operation to recover safely.',
      retryable: true,
    })
    expect(await platform.listConnectors('workspace-1')).toContainEqual(
      expect.objectContaining({ id: installation.id, status: 'disconnected' }),
    )

    const recovered = await request()
    expect(recovered.status).toBe(200)
    expect(disconnectCalls).toBe(2)
    const snapshot = await platform.readConnectorLifecycleSnapshot({
      workspaceId: 'workspace-1',
      installationId: installation.id,
    })
    expect(snapshot.disconnectCleanupRevision).toBe(snapshot.lifecycleRevision)
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
    const platform = new InMemoryDeveloperPlatformStorage(
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
        `/developer/webhook-subscriptions/${created.subscription.id}`,
        'other-admin-webhook-delete',
        undefined,
        'DELETE',
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
    expect((await platform.listWebhookSubscriptions('workspace-1'))[0])
      .toMatchObject({
        status: 'active',
        url: 'https://hooks.example.test/original',
      })

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
    expect(authorizedTeamChecks).toEqual([
      ['team-1'],
      ['team-1'],
      ['team-1'],
      ['team-1'],
    ])
    expect(queued).toEqual([])
  })

  test('keeps invalid OAuth secrets from using up the client limit and never permits caching token responses', async () => {
    const { platform, router } = createTestRouter()
    const oauthApp = await platform.createOAuthApp({
      workspaceId: 'workspace-1',
      createdByUserId: 'user-1',
      input: {
        name: 'Rate limited service',
        grantTypes: ['client_credentials'],
        scopes: ['work-items:read'],
      },
    })
    const request = (clientSecret: string, sourceIp: string) => router.request(
      'http://localhost/v1/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: oauthApp.oauthApp.clientId,
          client_secret: clientSecret,
        }).toString(),
      },
      { requestContext: { http: { sourceIp } } },
    )

    // Someone who only knows the public client_id cannot lock the client out.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await request('invalid-secret', '198.51.100.1')
      expect(response.status).toBe(401)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Pragma')).toBe('no-cache')
    }
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await request(oauthApp.clientSecret, '198.51.100.2')
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    }
    const limited = await request(oauthApp.clientSecret, '198.51.100.3')
    expect(limited.status).toBe(429)
    expect(limited.headers.get('RateLimit-Limit')).toBe('30')
    expect(limited.headers.get('Retry-After')).toBe('60')
    expect(limited.headers.get('Cache-Control')).toBe('no-store')
  })

  test('still limits wrong OAuth secrets when no trusted client address is available', async () => {
    const { router } = createTestRouter()
    // No Lambda request context, as under the Bun server.
    const request = (attempt: number) => router.request('http://localhost/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-For': `198.51.100.${attempt + 1}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'unknown-client',
        client_secret: 'invalid-secret',
      }).toString(),
    })

    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect((await request(attempt)).status).toBe(401)
    }
    const limited = await request(60)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('RateLimit-Limit')).toBe('60')
  })

  test('limits OAuth token requests by the CloudFront viewer address, not the edge address', async () => {
    const edgeSecret = 'edge-secret-0123456789abcdef0123456789abcdef'
    const originalEdgeSecret = process.env.MUKUROJI_EDGE_ORIGIN_SECRET
    process.env.MUKUROJI_EDGE_ORIGIN_SECRET = edgeSecret
    try {
      const { router } = createTestRouter()
      const request = (viewerAddress: string, attempt: number) => router.request(
        'http://localhost/v1/oauth/token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-mukuroji-edge-secret': edgeSecret,
            'x-mukuroji-viewer-address': viewerAddress,
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: `unknown-client-${attempt}`,
            client_secret: 'invalid-secret',
          }).toString(),
        },
        // Every request reaches the API from the same CloudFront edge.
        {
          event: { requestContext: { http: { sourceIp: '198.51.100.250' } } },
          requestContext: { http: { sourceIp: '198.51.100.250' } },
        },
      )

      for (let attempt = 0; attempt < 60; attempt += 1) {
        expect((await request('203.0.113.9', attempt)).status).toBe(401)
      }
      expect((await request('203.0.113.9', 60)).status).toBe(429)
      // Another viewer behind the same edge keeps its own bucket.
      expect((await request('203.0.113.10', 61)).status).toBe(401)
    } finally {
      if (originalEdgeSecret === undefined) {
        delete process.env.MUKUROJI_EDGE_ORIGIN_SECRET
      } else {
        process.env.MUKUROJI_EDGE_ORIGIN_SECRET = originalEdgeSecret
      }
    }
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
      // Shaped like the env that hono/aws-lambda passes to the app.
      {
        event: { requestContext: { http: { sourceIp: '203.0.113.9' } } },
        requestContext: { http: { sourceIp: '203.0.113.9' } },
      },
    )

    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect((await request(attempt)).status).toBe(401)
    }
    const limited = await request(60)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('RateLimit-Limit')).toBe('60')
  })

  test('hands the callback to the Web origin and requires a signed-in integration manager to complete it', async () => {
    let calls = 0
    const connectorAuthorization: ConnectorAuthorizationService = {
      async begin() { throw new Error('not used') },
      async completeCallback() {
        calls += 1
        throw new Error('not reached')
      },
      async abortCallback() {
        calls += 1
        throw new Error('not reached')
      },
      async reauthorize() { throw new Error('not used') },
      async disconnect() { throw new Error('not used') },
      async listConflicts() { throw new Error('not used') },
      async resolveConflict() { throw new Error('not used') },
    }
    const request = {
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'complete-without-admin',
      },
      body: JSON.stringify({ state: 'signed-state', code: 'provider-code' }),
    }
    const splitOrigin = createTestRouter({
      connectorAuthorization,
      connectorOAuthWebOrigin: 'https://app.example.com',
    })
    const handedOff = await splitOrigin.router.request(
      'http://localhost/developer/connector-oauth/callback?code=provider-code&state=signed-state',
    )
    expect(handedOff.status).toBe(303)
    expect(handedOff.headers.get('Location')).toBe(
      'https://app.example.com/settings/connectors/oauth-callback' +
        '#state=signed-state&code=provider-code',
    )
    expect(calls).toBe(0)

    const member = createTestRouter({
      connectorAuthorization,
      managementPrincipal: {
        ...managementPrincipal,
        capabilities: { ...managementPrincipal.capabilities, canManageIntegrations: false },
      },
    })
    const forbidden = await member.router.request(
      'http://localhost/developer/connector-oauth/complete',
      request,
    )
    expect(forbidden.status).toBe(403)

    const anonymous = createTestRouter({
      connectorAuthorization,
      authenticateManagement: async () => {
        throw new PublicApiServiceError(401, 'invalid_credentials', 'Sign in again.')
      },
    })
    const unauthenticated = await anonymous.router.request(
      'http://localhost/developer/connector-oauth/complete',
      request,
    )
    expect(unauthenticated.status).toBe(401)
    expect(calls).toBe(0)
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
    let allowConflictWrite = false
    let conflictWriteChecks = 0
    let resolveCalls = 0
    let completeCalls = 0
    const connectorAuthorization: ConnectorAuthorizationService = {
      async begin(_principal, _input, operationId) {
        beginOperationIds.push(operationId ?? '')
        return {
          authorizationUrl: 'https://provider.example/oauth/authorize?state=opaque',
          stateId: 'state-1',
          expiresAt: '2026-07-18T00:10:00.000Z',
        }
      },
      async completeCallback(input, actor) {
        expect(input).toEqual({ code: 'provider-code', state: 'signed-state' })
        expect(actor).toMatchObject({ workspaceId: 'workspace-1', userId: 'user-1' })
        completeCalls += 1
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
      async abortCallback(input, actor) {
        expect(input).toEqual({ state: 'cancelled-state' })
        expect(actor).toMatchObject({ workspaceId: 'workspace-1', userId: 'user-1' })
        return { returnUrl: '/settings/developer?tab=connectors' }
      },
      async reauthorize() {
        return {
          authorizationUrl: 'https://provider.example/oauth/authorize?state=reauth',
          stateId: 'state-2',
          expiresAt: '2026-07-18T00:10:00.000Z',
        }
      },
      async disconnect() {
        return {
          installation: {
            id: 'connector-1',
            category: 'source-control',
            provider: 'github',
            name: 'Engineering GitHub',
            status: 'disconnected',
            scopes: ['issues:read'],
            installedByUserId: 'user-1',
            installedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
          },
          lifecycleRevision: 2,
        }
      },
      async listConflicts() {
        return { items: [conflict], hasMore: false }
      },
      async resolveConflict(_principal, conflictId, input) {
        resolveCalls += 1
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
    const workItems = createDefaultWorkItemService({
      async authorizeExternalLink(_credential, teamId, workItemId, write) {
        conflictWriteChecks += 1
        expect({ teamId, workItemId, write }).toEqual({
          teamId: 'team-1',
          workItemId: 'work-item-1',
          write: true,
        })
        if (!allowConflictWrite) {
          throw new PublicApiServiceError(403, 'forbidden', 'Work Item access was revoked.')
        }
      },
    })
    const { platform, router } = createTestRouter({ connectorAuthorization, workItems })
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
      .toBe('/settings/connectors/oauth-callback#state=signed-state&code=provider-code')
    expect(callback.headers.get('Cache-Control')).toBe('no-store')
    expect(callback.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(completeCalls).toBe(0)

    const cancelled = await router.request(
      'http://localhost/developer/connector-oauth/callback' +
        '?error=access_denied&state=cancelled-state',
    )
    expect(cancelled.status).toBe(303)
    expect(cancelled.headers.get('Location'))
      .toBe('/settings/connectors/oauth-callback#state=cancelled-state&cancelled=true')

    const completeRequest = (body: unknown, idempotencyKey: string) => router.request(
      'http://localhost/developer/connector-oauth/complete',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    )
    const completed = await completeRequest(
      { state: 'signed-state', code: 'provider-code' },
      'complete-connector',
    )
    expect(completed.status).toBe(200)
    expect(completed.headers.get('Cache-Control')).toBe('no-store')
    expect(await completed.json()).toEqual({
      outcome: 'connected',
      returnUrl: '/settings/developer?connectorOAuth=connected',
    })
    const completedReplay = await completeRequest(
      { state: 'signed-state', code: 'provider-code' },
      'complete-connector',
    )
    expect(completedReplay.status).toBe(200)
    expect(completedReplay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(completeCalls).toBe(1)

    const aborted = await completeRequest(
      { state: 'cancelled-state', cancelled: true },
      'abort-connector',
    )
    expect(aborted.status).toBe(200)
    expect(await aborted.json()).toEqual({
      outcome: 'cancelled',
      returnUrl: '/settings/developer?tab=connectors&connectorOAuth=cancelled',
    })

    for (const invalid of [
      { state: 'signed-state' },
      { state: 'signed-state', code: 'provider-code', cancelled: true },
      { state: 'signed-state', cancelled: false },
      { state: 'signed-state', code: 'provider-code', extra: 'field' },
      { code: 'provider-code' },
    ]) {
      const response = await completeRequest(invalid, `invalid-${JSON.stringify(invalid)}`)
      expect(response.status).toBe(400)
    }
    expect(completeCalls).toBe(1)

    const conflictInstallation = await platform.installConnector({
      workspaceId: 'workspace-1',
      installedByUserId: 'user-1',
      input: {
        category: 'source-control',
        provider: 'github',
        name: 'Conflict GitHub',
        scopes: ['issues:read'],
        credential: 'conflict-connector-credential',
      },
    })
    const conflictLink = await platform.createExternalWorkItemLink({
      workspaceId: 'workspace-1',
      input: {
        teamId: 'team-1',
        workItemId: 'work-item-1',
        installationId: conflictInstallation.id,
        resourceType: 'issue',
        externalId: 'GH-conflict',
        externalUrl: 'https://github.com/mnmn0/mukuroji/issues/57',
        displayKey: '#57',
        syncDirection: 'bidirectional',
      },
    })
    conflict.externalLinkId = conflictLink.id

    const resolveRequest = () => router.request(
      'http://localhost/developer/sync-conflicts/conflict-1/resolve', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer session-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': 'resolve-conflict',
        },
        body: JSON.stringify({ resolution: 'use-local' }),
      },
    )
    const resolved = await resolveRequest()
    const resolvedBody = await resolved.json()
    expect(resolved.status).toBe(200)
    expect(resolvedBody).toMatchObject({ id: 'conflict-1', status: 'resolved' })

    const deniedReplay = await resolveRequest()
    expect(deniedReplay.status).toBe(403)
    expect(deniedReplay.headers.get('Idempotency-Replayed')).toBeNull()
    expect(resolveCalls).toBe(1)

    allowConflictWrite = true
    const replay = await resolveRequest()
    expect(replay.status).toBe(200)
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(await replay.json()).toEqual(resolvedBody)
    expect(resolveCalls).toBe(1)
    expect(conflictWriteChecks).toBe(2)
  })
})

/** Public Agent Run fixture returned by fake services. */
const agentRunFixture: AgentRun = {
  schemaVersion: 1,
  runId: 'run_00000000-0000-4000-8000-000000000001',
  teamId: 'team-1',
  workItemId: 'work-item-1',
  assigneeUserId: 'user-1',
  runtime: 'claude-code',
  agentName: 'Claude Code',
  state: 'active',
  startRevision: 2,
  leaseMinutes: 30,
  startedAt: NOW.toISOString(),
  lastHeartbeatAt: NOW.toISOString(),
  leaseExpiresAt: NOW.toISOString(),
  stalled: false,
  reportCount: 0,
}

/**
 * Creates a fake Agent Run service whose methods fail unless overridden.
 *
 * @param overrides - Methods used by one test.
 * @returns Agent Run service.
 */
function createAgentRunService(overrides: Partial<PublicAgentRunService> = {}): PublicAgentRunService {
  /**
   * Fails a service call the test did not expect.
   *
   * @returns Never; always throws.
   */
  const unexpected = async (): Promise<never> => {
    throw new Error('Unexpected Agent Run service call.')
  }
  return {
    authorizeStart: unexpected,
    start: unexpected,
    listWorkItemRuns: unexpected,
    list: unexpected,
    get: unexpected,
    heartbeat: unexpected,
    authorizeFinish: unexpected,
    finish: unexpected,
    authorizeReport: unexpected,
    report: unexpected,
    authorizeTakeOver: unexpected,
    takeOver: unexpected,
    authorizeResume: unexpected,
    resume: unexpected,
    getSettings: unexpected,
    getContext: unexpected,
    ...overrides,
  }
}

describe('public Agent Run routes', () => {
  const startBody = {
    expectedRevision: 1,
    workflowStatusId: 'in-progress',
    runtime: 'claude-code',
    agentName: 'Claude Code',
    instanceId: 'laptop-1',
  }

  test('starts idempotently, hashes the instance ID, and reports a held claim with a stable reason', async () => {
    let starts = 0
    let conflict = false
    const { platform, router } = createTestRouter({ agentRuns: createAgentRunService({
      async start(_credential, teamId, workItemId, input) {
        expect([teamId, workItemId]).toEqual(['team-1', 'work-item-1'])
        expect(input.instanceIdHash).toBe(hashAgentInstanceId('laptop-1'))
        expect(JSON.stringify(input)).not.toContain('laptop-1')
        if (conflict) throw createAgentRunConflictError()
        starts += 1
        return { run: agentRunFixture, workItem: createWorkItem('work-item-1') }
      },
      async authorizeStart() {},
    }) })
    const credential = await createApiKey(platform, ['work-items:write'])
    const headers = { Authorization: `Bearer ${credential.secret}`, 'Content-Type': 'application/json' }
    /**
     * Sends a run start request.
     *
     * @param key - Idempotency key.
     * @param body - Request body.
     * @returns Response.
     */
    const send = (key: string, body: unknown = startBody) => router.request('/v1/work-items/work-item-1/agent-runs?teamId=team-1', {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body),
    })
    const created = await send('start-1')
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ run: { runId: agentRunFixture.runId } })
    expect((await send('start-1')).headers.get('Idempotency-Replayed')).toBe('true')
    expect(starts).toBe(1)
    conflict = true
    const held = await send('start-2')
    expect(held.status).toBe(409)
    expect(await held.json()).toMatchObject({
      code: 'conflict',
      errors: [{ pointer: '/agentInstanceId', code: 'agent_run_conflict' }],
    })
    const invalid = await send('start-3', { ...startBody, runtime: 'unknown' })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'validation_failed', errors: [{ pointer: '/runtime' }] })
  })

  test('takes over a stalled run idempotently and reports a disabled Team setting', async () => {
    const calls: unknown[] = []
    let disabled = false
    const { platform, router } = createTestRouter({ agentRuns: createAgentRunService({
      /**
       * Accepts every take over authorization in this test.
       */
      async authorizeTakeOver() {},
      /**
       * Returns a take over response for the requested run, or the disabled error the test configures.
       *
       * @param _credential - Ignored credential.
       * @param teamId - Team ID.
       * @param workItemId - Work Item ID.
       * @param runId - Stalled run.
       * @param request - Take over request.
       * @returns The new and superseded runs.
       */
      async takeOver(_credential, teamId, workItemId, runId, request) {
        calls.push({ teamId, workItemId, runId, request })
        if (disabled) throw new AgentRunError('forbidden', 'Disabled.', { reason: 'agent_run_takeover_disabled' })
        return {
          run: { ...agentRunFixture, runId: 'run_00000000-0000-4000-8000-000000000009' },
          supersededRun: { ...agentRunFixture, state: 'finished', outcome: 'superseded', finishedBy: 'agent-owner', finishedAt: NOW.toISOString() },
        }
      },
    }) })
    const credential = await createApiKey(platform, ['work-items:write'])
    const headers = { Authorization: `Bearer ${credential.secret}`, 'Content-Type': 'application/json' }
    /**
     * Sends a take over request.
     *
     * @param key - Idempotency key.
     * @param body - Request body.
     * @returns Response.
     */
    const send = (key: string, body: unknown = { runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-2' }) => router.request(
      `/v1/work-items/work-item-1/agent-runs/${agentRunFixture.runId}/take-over?teamId=team-1`,
      { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body) },
    )
    const taken = await send('take-over-1')
    expect(taken.status).toBe(201)
    expect(await taken.json()).toMatchObject({ supersededRun: { outcome: 'superseded' } })
    expect((await send('take-over-1')).headers.get('Idempotency-Replayed')).toBe('true')
    expect(calls).toEqual([{
      teamId: 'team-1', workItemId: 'work-item-1', runId: agentRunFixture.runId,
      request: { runtime: 'codex', agentName: 'Codex', instanceIdHash: hashAgentInstanceId('laptop-2') },
    }])
    disabled = true
    const refused = await send('take-over-2')
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ code: 'forbidden', errors: [{ code: 'agent_run_takeover_disabled' }] })
    expect((await send('take-over-3', { runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-2', expectedRevision: 1 })).status).toBe(400)
  })

  test('resumes a started Work Item idempotently and reports a status the Team does not allow', async () => {
    const calls: unknown[] = []
    let notResumable = false
    let lostAccess = false
    const { platform, router } = createTestRouter({ agentRuns: createAgentRunService({
      /**
       * Accepts resume authorizations until the test removes the caller's access.
       */
      async authorizeResume() {
        if (lostAccess) throw new AgentRunError('forbidden', 'No access.', { reason: 'agent_run_forbidden' })
      },
      /**
       * Returns a resume response, or the not resumable error the test configures.
       *
       * @param _credential - Ignored credential.
       * @param teamId - Team ID.
       * @param workItemId - Work Item ID.
       * @param request - Resume request.
       * @returns The new run and the run it resumes.
       */
      async resume(_credential, teamId, workItemId, request) {
        calls.push({ teamId, workItemId, request })
        if (notResumable) throw new AgentRunError('conflict', 'Not resumable.', { reason: 'not_resumable' })
        return {
          run: { ...agentRunFixture, runId: 'run_00000000-0000-4000-8000-000000000010' },
          resumedFromRun: { ...agentRunFixture, state: 'finished', outcome: 'paused', finishedBy: 'agent', finishedAt: NOW.toISOString() },
        }
      },
    }) })
    const credential = await createApiKey(platform, ['work-items:write'])
    const headers = { Authorization: `Bearer ${credential.secret}`, 'Content-Type': 'application/json' }
    /**
     * Sends a resume request.
     *
     * @param key - Idempotency key.
     * @param body - Request body.
     * @returns Response.
     */
    const send = (key: string, body: unknown = { expectedRevision: 3, runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-2' }) => router.request(
      '/v1/work-items/work-item-1/agent-runs/resume?teamId=team-1',
      { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body) },
    )
    const resumed = await send('resume-1')
    expect(resumed.status).toBe(201)
    expect(await resumed.json()).toMatchObject({ resumedFromRun: { outcome: 'paused' } })
    expect((await send('resume-1')).headers.get('Idempotency-Replayed')).toBe('true')
    // A caller who lost access gets no saved response on a retry.
    lostAccess = true
    const lost = await send('resume-1')
    expect(lost.status).toBe(403)
    expect(lost.headers.get('Idempotency-Replayed')).toBeNull()
    lostAccess = false
    expect(calls).toEqual([{
      teamId: 'team-1', workItemId: 'work-item-1',
      request: { expectedRevision: 3, runtime: 'codex', agentName: 'Codex', instanceIdHash: hashAgentInstanceId('laptop-2') },
    }])
    notResumable = true
    const refused = await send('resume-2')
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'conflict', errors: [{ code: 'not_resumable' }] })
    expect((await send('resume-3', { runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-2' })).status).toBe(400)
    expect((await send('resume-4', { expectedRevision: 3, runtime: 'codex', agentName: 'Codex', instanceId: 'laptop-2', workflowStatusId: 'doing' })).status).toBe(400)
  })

  test('saves a structured report idempotently and rejects an unsafe artifact URL before any write', async () => {
    const calls: unknown[] = []
    const { platform, router } = createTestRouter({ agentRuns: createAgentRunService({
      /**
       * Accepts every report authorization in this test.
       */
      async authorizeReport() {},
      /**
       * Returns a saved report for the requested run.
       *
       * @param _credential - Ignored credential.
       * @param teamId - Team ID.
       * @param runId - Reporting run.
       * @param request - Validated report.
       * @param _context - Ignored request identifiers.
       * @param _idempotency - Ignored reservation.
       * @param assignedProjectId - Requested Project, if any.
       * @returns The report, its comment, and the run.
       */
      async report(_credential, teamId, runId, request, _context, _idempotency, assignedProjectId) {
        calls.push({ teamId, runId, request, ...(assignedProjectId ? { assignedProjectId } : {}) })
        return {
          report: {
            schemaVersion: 1, runId, teamId, workItemId: 'work-item-1', sequence: 1, kind: request.kind, commentId: 'cmt_1',
            verifications: request.verifications, artifacts: request.artifacts, createdAt: NOW.toISOString(),
          },
          comment: { id: 'cmt_1', actorUserId: 'agent-owner', body: `[Codex]\n\n${request.message}`, createdAt: NOW.toISOString() },
          run: { ...agentRunFixture, reportCount: 1 },
        }
      },
    }) })
    const credential = await createApiKey(platform, ['work-items:write'])
    const headers = { Authorization: `Bearer ${credential.secret}`, 'Content-Type': 'application/json' }
    /**
     * Sends a report request.
     *
     * @param key - Idempotency key.
     * @param body - Request body.
     * @returns Response.
     */
    const send = (key: string, body: unknown, query = '') => router.request(
      `/v1/agent-runs/${agentRunFixture.runId}/reports?teamId=team-1${query}`,
      { method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(body) },
    )
    const body = {
      instanceId: 'laptop-1', kind: 'verification', message: 'Tests passed',
      verifications: [{ command: 'bun test', status: 'passed' }],
      artifacts: [{ type: 'pull-request', url: 'https://github.com/example/repo/pull/1' }],
    }
    const saved = await send('report-1', body)
    expect(saved.status).toBe(201)
    expect(await saved.json()).toMatchObject({ report: { sequence: 1, kind: 'verification' }, run: { reportCount: 1 } })
    expect((await send('report-1', body)).headers.get('Idempotency-Replayed')).toBe('true')
    expect(calls).toEqual([{
      teamId: 'team-1', runId: agentRunFixture.runId,
      request: {
        instanceIdHash: hashAgentInstanceId('laptop-1'), kind: 'verification', message: 'Tests passed',
        verifications: [{ command: 'bun test', status: 'passed' }],
        artifacts: [{ type: 'pull-request', url: 'https://github.com/example/repo/pull/1' }],
      },
    }])
    expect((await send('report-scoped', body, '&assignedProjectId=project-1')).status).toBe(201)
    expect(calls.at(-1)).toMatchObject({ assignedProjectId: 'project-1' })
    const unsafe = await send('report-2', { ...body, artifacts: [{ type: 'url', url: 'https://user:secret@example.test/log' }] })
    expect(unsafe.status).toBe(400)
    const problem = await unsafe.json()
    expect(problem).toMatchObject({ code: 'validation_failed', errors: [{ pointer: '/artifacts/0/url', code: 'invalid_artifact_url' }] })
    expect(JSON.stringify(problem)).not.toContain('secret')
    expect(calls).toHaveLength(2)
  })

  test('binds heartbeats and finishes to the instance, returns Retry-After, and 503 when runs are not configured', async () => {
    const finishes: unknown[] = []
    const { platform, router } = createTestRouter({ agentRuns: createAgentRunService({
      async heartbeat(_credential, _teamId, _runId, instanceIdHash) {
        expect(instanceIdHash).toBe(hashAgentInstanceId('laptop-1'))
        throw new AgentRunError('rate_limited', 'Too frequent.', { retryAfterSeconds: 7 })
      },
      async finish(_credential, _teamId, _runId, request) {
        finishes.push(request)
        return { ...agentRunFixture, state: 'finished', outcome: request.outcome, finishedBy: 'agent', finishedAt: NOW.toISOString() }
      },
      async authorizeFinish() {},
    }) })
    const credential = await createApiKey(platform, ['work-items:read', 'work-items:write'])
    const headers = { Authorization: `Bearer ${credential.secret}`, 'Content-Type': 'application/json' }
    const body = JSON.stringify({ instanceId: 'laptop-1' })
    const limited = await router.request(`/v1/agent-runs/${agentRunFixture.runId}/heartbeat?teamId=team-1`, { method: 'POST', headers, body })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe('7')
    expect((await router.request('/v1/agent-runs/not-a-run/heartbeat?teamId=team-1', { method: 'POST', headers, body })).status).toBe(400)
    const anonymous = await router.request(`/v1/agent-runs/${agentRunFixture.runId}/heartbeat?teamId=team-1`, {
      method: 'POST', headers, body: '{}',
    })
    expect(anonymous.status).toBe(400)
    expect(await anonymous.json()).toMatchObject({ errors: [{ pointer: '/instanceId' }] })

    /**
     * Sends a run finish request.
     *
     * @param instanceBody - Request body.
     * @param key - Idempotency key.
     * @returns Response.
     */
    const finish = (instanceBody: unknown, key: string) => router.request(`/v1/agent-runs/${agentRunFixture.runId}/finish?teamId=team-1`, {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': key }, body: JSON.stringify(instanceBody),
    })
    expect((await finish({ outcome: 'completed', instanceId: 'laptop-1' }, 'finish-1')).status).toBe(200)
    expect(finishes).toEqual([{ outcome: 'completed', instanceIdHash: hashAgentInstanceId('laptop-1') }])
    expect((await finish({ outcome: 'completed' }, 'finish-2')).status).toBe(400)

    const unconfigured = createTestRouter({ platform })
    expect((await unconfigured.router.request('/v1/agent-context?teamId=team-1', { headers })).status).toBe(503)
    expect((await unconfigured.router.request('/v1/agent-settings?teamId=team-1', { headers })).status).toBe(503)
  })

  test('receives OTLP JSON logs with work-items:write and reports partial success', async () => {
    const received: unknown[] = []
    const { platform, router } = createTestRouter({ agentTelemetry: {
      async ingestLogs(_credential, body) {
        received.push(body)
        if (received.length === 3) throw new AgentRunError('temporarily_unavailable', 'Throttled.')
        return { rejectedRecords: received.length === 1 ? 0 : 2, duplicate: false }
      },
    } })
    const body = JSON.stringify({ resourceLogs: [] })
    const telemetryKey = await createApiKey(platform, ['work-items:write'])
    const headers = { Authorization: `Bearer ${telemetryKey.secret}`, 'Content-Type': 'application/json' }
    const accepted = await router.request('/v1/agent-telemetry/v1/logs', { method: 'POST', headers, body })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({})
    const partial = await router.request('/v1/agent-telemetry/v1/logs', { method: 'POST', headers, body })
    expect(await partial.json()).toMatchObject({ partialSuccess: { rejectedLogRecords: '2' } })
    // OTLP exporters retry only 429, 502, 503, and 504, so a transient storage failure is a 503.
    const throttled = await router.request('/v1/agent-telemetry/v1/logs', { method: 'POST', headers, body })
    expect(throttled.status).toBe(503)
    const protobuf = await router.request('/v1/agent-telemetry/v1/logs', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-protobuf' }, body: 'binary',
    })
    expect(protobuf.status).toBe(415)
    const readOnlyKey = await createApiKey(platform, ['work-items:read'])
    const unscoped = await router.request('/v1/agent-telemetry/v1/logs', {
      method: 'POST', headers: { ...headers, Authorization: `Bearer ${readOnlyKey.secret}` }, body,
    })
    expect(unscoped.status).toBe(403)
    expect(received).toHaveLength(3)
    const unconfigured = createTestRouter({ platform })
    expect((await unconfigured.router.request('/v1/agent-telemetry/v1/logs', { method: 'POST', headers, body })).status).toBe(503)
  })

  test('lists runs for one instance by hash and rejects unknown states', async () => {
    const { platform, router } = createTestRouter({ agentRuns: createAgentRunService({
      async list(_credential, teamId, filters) {
        expect(teamId).toBe('team-1')
        seenFilters.push(filters)
        return { items: [agentRunFixture], hasMore: false }
      },
    }) })
    const seenFilters: unknown[] = []
    const credential = await createApiKey(platform, ['work-items:read'])
    const headers = { Authorization: `Bearer ${credential.secret}` }
    const listed = await router.request('/v1/agent-runs?teamId=team-1&instanceId=laptop-1', { headers })
    expect(await listed.json()).toEqual({ items: [agentRunFixture], hasMore: false })
    await router.request('/v1/agent-runs?teamId=team-1&workItemId=work-item-1&instanceId=laptop-1', { headers })
    expect(seenFilters).toEqual([
      { state: 'active', instanceIdHash: hashAgentInstanceId('laptop-1') },
      { state: 'active', instanceIdHash: hashAgentInstanceId('laptop-1'), workItemId: 'work-item-1' },
    ])
    expect((await router.request('/v1/agent-runs?teamId=team-1&state=stalled', { headers })).status).toBe(400)
    expect((await router.request('/v1/agent-runs?teamId=team-1&state=finished&workItemId=work-item-1', { headers })).status).toBe(400)
  })

  test('lists a Work Item\'s agent questions with their answers without caching them', async () => {
    const question = {
      schemaVersion: 1, runId: agentRunFixture.runId, teamId: 'team-1', workItemId: 'work-item-1', sequence: 2, kind: 'blocker',
      commentId: 'cmt_2', verifications: [], artifacts: [], createdAt: NOW.toISOString(),
      answer: { body: 'Use staging.', answeredBy: 'user-1', answeredAt: NOW.toISOString(), commentId: 'cmt_3' },
    } satisfies AgentRunReport
    const { platform, router } = createTestRouter({ agentRuns: createAgentRunService({
      async listWorkItemQuestions(_credential, teamId, workItemId) {
        expect([teamId, workItemId]).toEqual(['team-1', 'work-item-1'])
        return { items: [question], hasMore: false }
      },
    }) })
    const reader = await createApiKey(platform, ['work-items:read'])
    const listed = await router.request('/v1/work-items/work-item-1/agent-run-questions?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })
    expect(listed.status).toBe(200)
    expect(listed.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await listed.json()).toEqual({ items: [question], hasMore: false })
    expect((await router.request('/v1/work-items/work-item-1/agent-run-questions', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })).status).toBe(400)
    const unconfigured = createTestRouter({ platform, agentRuns: createAgentRunService() })
    expect((await unconfigured.router.request('/v1/work-items/work-item-1/agent-run-questions?teamId=team-1', {
      headers: { Authorization: `Bearer ${reader.secret}` },
    })).status).toBe(503)
  })

  test('passes Agent Run fences to updates and comments without changing the patch', async () => {
    const fences: unknown[] = []
    const { platform, router } = createTestRouter({ workItems: createDefaultWorkItemService({
      async update(_credential, _team, _id, input, _context, _idempotency, fence) {
        expect(input).toEqual({ expectedRevision: 1, title: 'Renamed' })
        fences.push(fence)
        return createWorkItem('work-item-1')
      },
      async addComment(credential, _team, _id, body, _context, _project, _assignee, fence) {
        fences.push(fence)
        return { id: 'comment-1', actorUserId: credential.subjectUserId, body, createdAt: NOW.toISOString() }
      },
    }) })
    const credential = await createApiKey(platform, ['work-items:write'])
    const headers = { Authorization: `Bearer ${credential.secret}`, 'Content-Type': 'application/json' }
    const patched = await router.request('/v1/work-items/work-item-1?teamId=team-1', {
      method: 'PATCH', headers: { ...headers, 'Idempotency-Key': 'patch-1' },
      body: JSON.stringify({ expectedRevision: 1, title: 'Renamed', agentRunId: agentRunFixture.runId, agentInstanceId: 'laptop-1' }),
    })
    expect(patched.status).toBe(200)
    const commented = await router.request('/v1/work-items/work-item-1/comments?teamId=team-1', {
      method: 'POST', headers: { ...headers, 'Idempotency-Key': 'comment-1' },
      body: JSON.stringify({ body: 'progress', agentInstanceId: 'laptop-1' }),
    })
    expect(commented.status).toBe(201)
    expect(fences).toEqual([
      { agentRunId: agentRunFixture.runId, instanceIdHash: hashAgentInstanceId('laptop-1') },
      { instanceIdHash: hashAgentInstanceId('laptop-1') },
    ])
    const orphan = await router.request('/v1/work-items/work-item-1?teamId=team-1', {
      method: 'PATCH', headers: { ...headers, 'Idempotency-Key': 'patch-2' },
      body: JSON.stringify({ expectedRevision: 1, title: 'Renamed', agentRunId: agentRunFixture.runId }),
    })
    expect(orphan.status).toBe(400)
  })

  test('passes acceptance criteria marks to the service and replays the same marks body', async () => {
    const inputs: unknown[] = []
    const workItems = createDefaultWorkItemService({
      async update(_credential, _teamId, _workItemId, input) {
        inputs.push(input)
        return createWorkItem()
      },
    })
    const { platform, router } = createTestRouter({ workItems })
    const apiKey = await createApiKey(platform, ['work-items:write'])
    const patch = (body: unknown, key: string) => router.request('http://localhost/v1/work-items/work-item-1?teamId=team-1', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey.secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(body),
    })
    const marks = { expectedRevision: 1, acceptanceCriteriaMarks: [{ id: 'a'.repeat(32), satisfied: true }] }
    expect((await patch(marks, 'mark-criteria')).status).toBe(200)
    const replay = await patch(marks, 'mark-criteria')
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true')
    expect(inputs).toEqual([marks])
    for (const acceptanceCriteriaMarks of ['a', [{ id: 'a'.repeat(32) }], [{ id: 'a'.repeat(32), satisfied: true, text: 'x' }]]) {
      const invalid = await patch({ expectedRevision: 1, acceptanceCriteriaMarks }, `invalid-${JSON.stringify(acceptanceCriteriaMarks)}`)
      expect(invalid.status).toBe(400)
    }
    expect(inputs).toHaveLength(1)
  })
})

describe('personal agent credentials', () => {
  const DAY_MS = 24 * 60 * 60 * 1_000
  const memberPrincipal: DeveloperManagementPrincipal = {
    workspaceId: 'workspace-1',
    userId: 'member-1',
    capabilities: {
      canManageCredentials: false,
      canManageWebhooks: false,
      canManageIntegrations: false,
      canImport: false,
      canExport: false,
    },
    personalCredentialEligibility: 'eligible',
  }
  const guestPrincipal: DeveloperManagementPrincipal = {
    ...memberPrincipal,
    userId: 'guest-1',
    personalCredentialEligibility: 'guest',
  }
  const principals: Record<string, DeveloperManagementPrincipal> = {
    'Bearer admin-session': { ...managementPrincipal, personalCredentialEligibility: 'eligible' },
    'Bearer member-session': memberPrincipal,
    'Bearer other-member-session': { ...memberPrincipal, userId: 'member-2' },
    'Bearer guest-session': guestPrincipal,
    'Bearer read-only-member-session': {
      ...memberPrincipal,
      userId: 'member-3',
      personalCredentialEligibility: 'missing-permission',
    },
  }

  /** Creates a router whose management session token selects the acting principal. */
  /**
   * Creates a router that resolves the test sessions.
   *
   * @returns The router and its in-memory platform.
   */
  function createPersonalCredentialRouter() {
    return createTestRouter({
      authenticateManagement: async (authorization) => {
        const principal = principals[authorization]
        if (!principal) throw new PublicApiServiceError(401, 'invalid_credentials', 'Unknown session.')
        return principal
      },
    })
  }

  /** Sends a management request as the given session. */
  function send(
    router: ReturnType<typeof createTestRouter>['router'],
    session: string,
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey = crypto.randomUUID(),
  ) {
    return router.request(`http://localhost${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(method === 'GET' ? {} : { 'Idempotency-Key': idempotencyKey }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  const expiresInDays = (days: number) => new Date(NOW.getTime() + days * DAY_MS).toISOString()

  test('lets a non-administrator issue a work-item key that authenticates as themselves', async () => {
    const { platform, router } = createPersonalCredentialRouter()

    const overview = await send(router, 'member-session', 'GET', '/developer/me/agent-connection')
    expect(overview.status).toBe(200)
    expect(await overview.json()).toEqual({
      memberId: 'member-1',
      canIssue: true,
      policy: { selfIssuanceEnabled: true },
      scopes: ['work-items:read', 'work-items:write'],
      maxLifetimeDays: 90,
      apiKeys: [],
    })

    const created = await send(router, 'member-session', 'POST', '/developer/me/api-keys', {
      name: 'Laptop Claude Code',
      expiresAt: expiresInDays(30),
    })
    expect(created.status).toBe(201)
    expect(created.headers.get('Cache-Control')).toBe('no-store')
    const issued = await created.json() as { apiKey: { id: string }; secret: string }
    expect(issued.apiKey).not.toHaveProperty('issuance')
    expect(issued.apiKey).toMatchObject({
      createdByUserId: 'member-1',
      scopes: ['work-items:read', 'work-items:write'],
      status: 'active',
      expiresAt: expiresInDays(30),
    })
    await expect(platform.authenticateApiKey({
      credential: issued.secret,
      requiredScopes: ['work-items:write'],
    })).resolves.toMatchObject({ subjectUserId: 'member-1', kind: 'api-key' })

    const listed = await (await send(router, 'member-session', 'GET', '/developer/me/agent-connection')).json() as {
      apiKeys: Array<{ id: string }>
    }
    expect(listed.apiKeys.map((apiKey) => apiKey.id)).toEqual([issued.apiKey.id])
    const otherMember = await (
      await send(router, 'other-member-session', 'GET', '/developer/me/agent-connection')
    ).json() as { apiKeys: unknown[] }
    expect(otherMember.apiKeys).toEqual([])
  })

  test('requires an expiry within the limit and only work-item scopes', async () => {
    const { router } = createPersonalCredentialRouter()
    const invalidBodies = [
      { name: 'No expiry' },
      { name: 'Past', expiresAt: expiresInDays(-1) },
      { name: 'Too long', expiresAt: expiresInDays(91) },
      { name: 'Delete scope', expiresAt: expiresInDays(30), scopes: ['work-items:delete'] },
      { name: 'Webhook scope', expiresAt: expiresInDays(30), scopes: ['webhooks:write'] },
    ]
    for (const body of invalidBodies) {
      const response = await send(router, 'member-session', 'POST', '/developer/me/api-keys', body)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: 'validation_failed' })
    }

    const readOnly = await send(router, 'member-session', 'POST', '/developer/me/api-keys', {
      name: 'Read only',
      expiresAt: expiresInDays(90),
      scopes: ['work-items:read'],
    })
    expect(readOnly.status).toBe(201)
    expect(await readOnly.json()).toMatchObject({ apiKey: { scopes: ['work-items:read'] } })
  })

  test('rejects guests and members when the administrator disables self-issuance', async () => {
    const { router } = createPersonalCredentialRouter()
    const body = { name: 'Agent', expiresAt: expiresInDays(30) }

    const guest = await send(router, 'guest-session', 'POST', '/developer/me/api-keys', body)
    expect(guest.status).toBe(403)
    expect(await (await send(router, 'guest-session', 'GET', '/developer/me/agent-connection')).json())
      .toMatchObject({ canIssue: false, issuanceBlockedReason: 'guest' })
    expect((await send(router, 'read-only-member-session', 'POST', '/developer/me/api-keys', body)).status)
      .toBe(403)
    expect(await (await send(router, 'read-only-member-session', 'GET', '/developer/me/agent-connection')).json())
      .toMatchObject({ canIssue: false, issuanceBlockedReason: 'missing-permission' })

    const issued = await (await send(router, 'member-session', 'POST', '/developer/me/api-keys', body)).json() as {
      apiKey: { id: string }
    }

    expect((await send(router, 'member-session', 'PUT', '/developer/credential-policy', {
      selfIssuanceEnabled: false,
    })).status).toBe(403)
    const disabled = await send(router, 'admin-session', 'PUT', '/developer/credential-policy', {
      selfIssuanceEnabled: false,
    })
    expect(disabled.status).toBe(200)
    expect(await disabled.json()).toEqual({
      selfIssuanceEnabled: false,
      updatedAt: NOW.toISOString(),
      updatedByUserId: 'user-1',
    })

    expect((await send(router, 'member-session', 'POST', '/developer/me/api-keys', body)).status).toBe(403)
    expect((await send(
      router,
      'member-session',
      'POST',
      `/developer/me/api-keys/${issued.apiKey.id}/rotate`,
      { expiresAt: expiresInDays(30) },
    )).status).toBe(403)
    expect(await (await send(router, 'member-session', 'GET', '/developer/me/agent-connection')).json())
      .toMatchObject({ canIssue: false, issuanceBlockedReason: 'policy-disabled' })
    expect(await (await send(router, 'admin-session', 'GET', '/developer/credential-policy')).json())
      .toEqual({
        policy: expect.objectContaining({ selfIssuanceEnabled: false }),
        personalApiKeyIds: [issued.apiKey.id],
      })

    const revoked = await send(router, 'member-session', 'DELETE', `/developer/me/api-keys/${issued.apiKey.id}`)
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ status: 'revoked' })
  })

  test('rotates and revokes only the member own personal keys, with immediate effect', async () => {
    const { platform, router } = createPersonalCredentialRouter()
    const issued = await (await send(router, 'member-session', 'POST', '/developer/me/api-keys', {
      name: 'Agent',
      expiresAt: expiresInDays(10),
    })).json() as { apiKey: { id: string }; secret: string }
    const workspaceKey = await createApiKey(platform, ['work-items:read'])

    expect((await send(
      router,
      'other-member-session',
      'POST',
      `/developer/me/api-keys/${issued.apiKey.id}/rotate`,
      { expiresAt: expiresInDays(30) },
    )).status).toBe(404)
    expect((await send(router, 'other-member-session', 'DELETE', `/developer/me/api-keys/${issued.apiKey.id}`)).status)
      .toBe(404)
    expect((await send(router, 'member-session', 'DELETE', `/developer/me/api-keys/${workspaceKey.apiKey.id}`)).status)
      .toBe(404)
    expect((await send(
      router,
      'member-session',
      'POST',
      `/developer/me/api-keys/${issued.apiKey.id}/rotate`,
      {},
    )).status).toBe(400)

    const rotated = await send(
      router,
      'member-session',
      'POST',
      `/developer/me/api-keys/${issued.apiKey.id}/rotate`,
      { expiresAt: expiresInDays(60) },
    )
    expect(rotated.status).toBe(200)
    expect(rotated.headers.get('Cache-Control')).toBe('no-store')
    const rotatedBody = await rotated.json() as { apiKey: { expiresAt: string }; secret: string }
    expect(rotatedBody.apiKey.expiresAt).toBe(expiresInDays(60))
    await expect(platform.authenticateApiKey({ credential: issued.secret }))
      .rejects.toMatchObject({ status: 401 })
    await expect(platform.authenticateApiKey({ credential: rotatedBody.secret }))
      .resolves.toMatchObject({ subjectUserId: 'member-1' })

    const adminRevoked = await send(router, 'admin-session', 'DELETE', `/developer/api-keys/${issued.apiKey.id}`)
    expect(adminRevoked.status).toBe(200)
    await expect(platform.authenticateApiKey({ credential: rotatedBody.secret }))
      .rejects.toMatchObject({ status: 401 })
  })

  test('issues and rotates personal keys without Software factory, for the Workspace MCP profile', async () => {
    const { platform, router } = createPersonalCredentialRouter()
    const personal = await send(router, 'member-session', 'POST', '/developer/me/api-keys', {
      name: 'Workspace MCP',
      expiresAt: expiresInDays(30),
    })
    expect(personal.status).toBe(201)
    const issued = await personal.json() as { apiKey: { id: string }; secret: string }
    await expect(platform.authenticateApiKey({ credential: issued.secret }))
      .resolves.toMatchObject({ subjectUserId: 'member-1', scopes: ['work-items:read', 'work-items:write'] })

    const admin = await (await send(router, 'admin-session', 'POST', '/developer/me/api-keys', {
      name: 'Admin agent',
      expiresAt: expiresInDays(30),
    })).json() as { apiKey: { id: string } }
    expect((await send(router, 'admin-session', 'POST', `/developer/api-keys/${admin.apiKey.id}/rotate`)).status)
      .toBe(200)
  })
})
