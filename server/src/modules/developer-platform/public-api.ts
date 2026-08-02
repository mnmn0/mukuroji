import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import type {
  ApiProblem,
  ApiProblemCode,
  ApiScope,
  CanonicalWorkItem,
  ConnectorAuthorizationOutput,
  ConnectorDefinition,
  ConnectorInstallation,
  ConnectorProvider,
  CreateConnectorInstallationInput,
  CreateApiKeyInput,
  CreateOAuthAppInput,
  CreatePublicWorkItemRequest,
  CreateWebhookSubscriptionInput,
  DeveloperPlatformCapabilities,
  DeveloperPlatformOverview,
  ImportFieldMapping,
  ImportDryRunReport,
  ImportJob,
  ImportSource,
  ResolveWorkItemSyncConflictInput,
  UpdatePublicWorkItemRequest,
  UpdateWebhookSubscriptionInput,
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import { Hono, type Context } from 'hono'
import type {
  ApiKeyPort,
  AuthenticatedDeveloperCredential,
  ConnectorLifecycleSnapshot,
  ConnectorPort,
  ExternalLinkPort,
  IdempotencyMutationToken,
  IdempotencyPort,
  ImportPort,
  OAuthCredentialPort,
  RateLimitPort,
  WebhookDeliveryPort,
  WebhookSubscriptionPort,
} from './application/ports'
import { DeveloperPlatformError } from './errors'
import { assertSafeWebhookUrl, UnsafeWebhookUrlError } from './webhook-delivery'

/** Public API が一 credential に許可する1分あたりの既定 request 数です。 */
export const PUBLIC_API_RATE_LIMIT = 120

/** Maximum request body hashed for one entitlement metering receipt. */
const PUBLIC_API_METERING_BODY_MAX_BYTES = 10 * 1024 * 1024

/** OAuth token endpoint が一 client ID に許可する1分あたりの request 数です。 */
export const OAUTH_TOKEN_CLIENT_RATE_LIMIT = 30

/** OAuth token endpoint が一 source IP に許可する1分あたりの request 数です。 */
export const OAUTH_TOKEN_IP_RATE_LIMIT = 60

/** Public Work Item page の既定件数です。 */
export const PUBLIC_API_DEFAULT_PAGE_SIZE = 50

/** Public Work Item page の最大件数です。 */
export const PUBLIC_API_MAX_PAGE_SIZE = 100

/** Public Work Item cursor の有効期間（15分）です。 */
export const PUBLIC_API_CURSOR_TTL_SECONDS = 15 * 60

/** Cognito 認証済み developer settings actor です。 */
export type DeveloperManagementPrincipal = {
  /** Actor が所属する Workspace ID です。 */
  workspaceId: string
  /** Active Workspace member ID です。 */
  userId: string
  /** Server-side RBAC から解決した管理 capability です。 */
  capabilities: DeveloperPlatformCapabilities
}

/** Public mutation を既存 audit/idempotency と関連付ける context です。 */
export type PublicMutationContext = {
  /** Support と audit で照合する request ID です。 */
  requestId: string
  /** Caller が指定した idempotency key です。 */
  idempotencyKey: string
  /** Caller が指定した correlation ID です。 */
  correlationId?: string
}

/** Dry-run と commit の両方で再送・再検証する import source です。 */
export type PublicImportSourceInput = {
  /** Source file format です。 */
  format: 'csv' | 'json'
  /** Error report と再検証に使う UTF-8 source です。 */
  source: ImportSource
  /** Imported Work Item を所有する Team ID です。 */
  teamId: string
  /** Imported Work Item の既定 assigned Project ID です。 */
  assignedProjectId?: string
  /** Source field と Work Item field の mapping です。 */
  mapping: ImportFieldMapping[]
}

/** Public Work Item API と既存 canonical service の境界です。 */
export interface PublicWorkItemService {
  /** Credential owner の current RBAC で Work Items を bounded page 取得します。 */
  list(
    credential: AuthenticatedDeveloperCredential,
    filters: Record<string, string | number | undefined>,
    continuation: string | undefined,
    limit: number,
  ): Promise<{
    /** Current store page に含まれる Work Items です。 */
    items: CanonicalWorkItem[]
    /** Store に次 page があるかどうかです。 */
    hasMore: boolean
    /** 次 page の store-bound opaque continuation です。 */
    nextContinuation?: string
  }>
  /** Team + Work Item ID を current RBAC で取得します。 */
  get(
    credential: AuthenticatedDeveloperCredential,
    teamId: string,
    workItemId: string,
  ): Promise<CanonicalWorkItem>
  /** Work Item 作成 receipt の replay 前に current create RBAC を再評価します。 */
  authorizeCreate(
    credential: AuthenticatedDeveloperCredential,
    input: CreatePublicWorkItemRequest,
  ): Promise<void>
  /** Current RBAC/configuration validation を通して Work Item を作成します。 */
  create(
    credential: AuthenticatedDeveloperCredential,
    input: CreatePublicWorkItemRequest,
    context: PublicMutationContext,
  ): Promise<CanonicalWorkItem>
  /** Work Item 更新 receipt の replay 前に current source/target RBAC を再評価します。 */
  authorizeUpdate(
    credential: AuthenticatedDeveloperCredential,
    teamId: string,
    workItemId: string,
    input: UpdatePublicWorkItemRequest,
  ): Promise<void>
  /** Current RBAC/configuration/CAS を通して Work Item を更新します。 */
  update(
    credential: AuthenticatedDeveloperCredential,
    teamId: string,
    workItemId: string,
    input: UpdatePublicWorkItemRequest,
    context: PublicMutationContext,
    idempotency?: IdempotencyMutationToken,
  ): Promise<CanonicalWorkItem>
  /** Work Item 削除 receipt の replay 前に current delete RBAC を再評価します。 */
  authorizeDelete(
    credential: AuthenticatedDeveloperCredential,
    teamId: string,
    workItemId: string,
  ): Promise<void>
  /** Current RBAC/CAS を通して Work Item を削除します。 */
  delete(
    credential: AuthenticatedDeveloperCredential,
    teamId: string,
    workItemId: string,
    expectedRevision: number,
    context: PublicMutationContext,
    idempotency?: IdempotencyMutationToken,
  ): Promise<CanonicalWorkItem>
  /** External link 操作前に Work Item の current RBAC を再評価します。 */
  authorizeExternalLink(
    credential: AuthenticatedDeveloperCredential,
    teamId: string,
    workItemId: string,
    write: boolean,
  ): Promise<void>
  /** Webhook selector に含める全 Team の current viewer access を検証します。 */
  authorizeWebhookTeams(
    principal: DeveloperManagementPrincipal,
    teamIds: readonly string[],
  ): Promise<void>
  /** Import source/job を永続化せずに mapping/permission validation します。 */
  dryRunImport(
    principal: DeveloperManagementPrincipal,
    input: PublicImportSourceInput,
  ): Promise<ImportDryRunReport>
  /** Optional dry-run metadata と current permissions を確認して durable import を stage します。 */
  commitImport(
    principal: DeveloperManagementPrincipal,
    dryRunJobId: string | undefined,
    input: PublicImportSourceInput,
    context: PublicMutationContext,
  ): Promise<ImportJob>
  /** Import record の creator と Team access を current RBAC で検証します。 */
  authorizeImportJob(
    principal: DeveloperManagementPrincipal,
    job: ImportJob,
    write: boolean,
  ): Promise<void>
  /** Worker と協調して未完了 import を cancel し、cancelled retry は成功扱いにします。 */
  cancelImport(
    principal: DeveloperManagementPrincipal,
    job: ImportJob,
    context: PublicMutationContext,
  ): Promise<ImportJob>
  /** Permission-filtered Work Items を bounded export page で返します。 */
  export(
    principal: DeveloperManagementPrincipal,
    format: 'csv' | 'json',
    continuation: string | undefined,
    limit: number,
  ): Promise<{
    /** Export page に含まれる Work Items です。 */
    items: CanonicalWorkItem[]
    /** Export に次 page があるかどうかです。 */
    hasMore: boolean
    /** 次 page の store-bound opaque continuation です。 */
    nextContinuation?: string
  }>
}

/** Provider OAuth と sync-conflict recovery を実装する optional connector 境界です。 */
export interface ConnectorAuthorizationService {
  /** Secret を返さず provider authorization flow を開始します。 */
  begin(
    principal: DeveloperManagementPrincipal,
    input: CreateConnectorInstallationInput,
    operationId?: string,
  ): Promise<ConnectorAuthorizationOutput>
  /** Signed single-use state と authorization code を検証して OAuth callback を完了します。 */
  completeCallback(input: {
    /** Provider が発行した authorization code です。 */
    code: string
    /** Authorization 開始時に作成した signed state です。 */
    state: string
  }): Promise<{
    /** 作成または復旧した secret-free installation です。 */
    installation: ConnectorInstallation
    /** 検証済み application-relative return URL です。 */
    returnUrl: string
  }>
  /** Provider denial 時も signed state を consume し、検証済み return URL を返します。 */
  abortCallback(input: {
    /** Authorization 開始時に作成した signed state です。 */
    state: string
  }): Promise<{
    /** 検証済み application-relative return URL です。 */
    returnUrl: string
  }>
  /** 既存 installation の provider 再認証 flow を開始します。 */
  reauthorize(
    principal: DeveloperManagementPrincipal,
    installationId: string,
    operationId?: string,
  ): Promise<ConnectorAuthorizationOutput>
  /** Provider credential を revoke し、local secret を削除可能な状態にします。 */
  disconnect(
    principal: DeveloperManagementPrincipal,
    installationId: string,
  ): Promise<ConnectorLifecycleSnapshot>
  /** Provider adapter が永続化した sync conflict page を返します。 */
  listConflicts(
    principal: DeveloperManagementPrincipal,
    input: {
      /** Optional conflict status filter です。 */
      status?: 'open' | 'resolved' | 'ignored'
      /** Provider 固有値を露出しない opaque cursor です。 */
      cursor?: string
      /** Page の最大件数です。 */
      limit: number
    },
  ): Promise<{
    /** Current Workspace が参照できる conflict です。 */
    items: WorkItemSyncConflict[]
    /** 次 page があるかどうかです。 */
    hasMore: boolean
    /** 次 page の opaque cursor です。 */
    nextCursor?: string
  }>
  /** Current RBAC で conflict を解決し、redact 済み resource を返します。 */
  resolveConflict(
    principal: DeveloperManagementPrincipal,
    conflictId: string,
    input: ResolveWorkItemSyncConflictInput,
  ): Promise<WorkItemSyncConflict>
}

/** External ports and request-bound services required by the management and public API router. */
export type PublicApiDependencies = {
  /** API key lifecycle and authentication port. */
  apiKeys: ApiKeyPort
  /** OAuth application and token credential port. */
  oauthCredentials: OAuthCredentialPort
  /** Webhook subscription lifecycle port. */
  webhookSubscriptions: WebhookSubscriptionPort
  /** Webhook delivery persistence port. */
  webhookDeliveries: WebhookDeliveryPort
  /** Connector installation and credential lifecycle port. */
  connectors: ConnectorPort
  /** External Work Item link lifecycle port. */
  externalLinks: ExternalLinkPort
  /** Import job metadata port. */
  imports: ImportPort
  /** Idempotency reservation and replay port. */
  idempotency: IdempotencyPort
  /** Credential-scoped rate-limit port. */
  rateLimits: RateLimitPort
  /** Enforces Developer Platform entitlement and mutation usage for one Workspace request. */
  enforceEntitlement(
    workspaceId: string,
    method: string,
    idempotencyKey?: string,
  ): Promise<void>
  /** Cognito bearer token と request metadata を current Workspace principal へ解決します。 */
  authenticateManagement(
    authorization: string,
    context: Context,
  ): Promise<DeveloperManagementPrincipal>
  /** Canonical Work Item/RBAC adapter です。 */
  workItems: PublicWorkItemService
  /** Public OpenAPI 3.1 document です。 */
  openApiDocument: Record<string, unknown>
  /** Scope-bound cursor を署名する secret です。 */
  cursorSecret: string
  /** Webhook delivery/replay を queue へ送る production adapter です。 */
  queueWebhookDelivery?(workspaceId: string, deliveryId: string): Promise<void>
  /** Connector OAuth と sync-conflict recovery の optional provider adapter です。 */
  connectorAuthorization?: ConnectorAuthorizationService
  /** Existing domain error を stable public error へ変換します。 */
  mapError?(error: unknown): PublicApiServiceError | undefined
  /** Test で request ID を固定する generator です。 */
  createRequestId?: () => string
  /** Cursor expiry と rate-limit header の計算に使う clock です。 */
  now?: () => Date
}

const connectorCatalog = [
  {
    provider: 'github',
    category: 'source-control',
    name: 'GitHub',
    capabilities: ['issues', 'pull-requests', 'commits'],
  },
  {
    provider: 'gitlab',
    category: 'source-control',
    name: 'GitLab',
    capabilities: ['issues', 'merge-requests', 'commits'],
  },
  {
    provider: 'slack',
    category: 'chat',
    name: 'Slack',
    capabilities: ['messages', 'notifications'],
  },
  {
    provider: 'microsoft-teams',
    category: 'chat',
    name: 'Microsoft Teams',
    capabilities: ['messages', 'notifications'],
  },
  {
    provider: 'gmail',
    category: 'email',
    name: 'Gmail',
    capabilities: ['messages'],
  },
  {
    provider: 'outlook',
    category: 'email',
    name: 'Outlook',
    capabilities: ['messages'],
  },
  {
    provider: 'google-calendar',
    category: 'calendar',
    name: 'Google Calendar',
    capabilities: ['events'],
  },
  {
    provider: 'outlook-calendar',
    category: 'calendar',
    name: 'Outlook Calendar',
    capabilities: ['events'],
  },
  {
    provider: 'google-drive',
    category: 'cloud-storage',
    name: 'Google Drive',
    capabilities: ['files'],
  },
  {
    provider: 'onedrive',
    category: 'cloud-storage',
    name: 'OneDrive',
    capabilities: ['files'],
  },
  {
    provider: 'dropbox',
    category: 'cloud-storage',
    name: 'Dropbox',
    capabilities: ['files'],
  },
] as const satisfies readonly ConnectorDefinition[]

/** Public API adapter が投げる stable HTTP error です。 */
export class PublicApiServiceError extends Error {
  /** HTTP status です。 */
  readonly status: number
  /** RFC problem code です。 */
  readonly code: ApiProblemCode
  /** Client が安全に retry できる可能性です。 */
  readonly retryable: boolean

  /** Stable public error を作成します。 */
  constructor(status: number, code: ApiProblemCode, message: string, retryable = false) {
    super(message)
    this.name = 'PublicApiServiceError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

/**
 * Public API error を secret-safe な structured log fields へ変換します。
 *
 * Error message、stack、cause、provider response は意図的に含めません。
 */
export function toSafePublicApiErrorLog(error: unknown) {
  if (error instanceof PublicApiServiceError) {
    return {
      errorType: 'PublicApiServiceError',
      code: error.code,
      status: error.status,
    }
  }
  if (error instanceof DeveloperPlatformError) {
    return {
      errorType: 'DeveloperPlatformError',
      code: mapDeveloperPlatformProblemCode(error.status, error.code),
      status: error.status,
    }
  }
  if (error instanceof UnsafeWebhookUrlError) {
    return {
      errorType: 'UnsafeWebhookUrlError',
      code: 'unsafe_webhook_url',
      status: 400,
    }
  }
  return {
    errorType: 'InternalError',
    code: 'internal_error',
    status: 500,
  }
}

/**
 * Creates the developer management and versioned public API router mounted below `/api`.
 *
 * @param dependencies - Authenticated application ports and router configuration.
 * @returns A Hono router exposing management and public API routes.
 */
export function createPublicApiRouter(dependencies: PublicApiDependencies) {
  const router = new Hono<{ Variables: { requestId: string } }>()

  router.use('*', async (c, next) => {
    const requestId = readRequestId(c.req.header('X-Request-Id')) ??
      (dependencies.createRequestId ?? (() => crypto.randomUUID()))()
    c.set('requestId', requestId)
    c.header('X-Request-Id', requestId)
    if (isSecretBearingRequest(c.req.method, new URL(c.req.url).pathname)) {
      setSecretResponseHeaders(c)
    }
    await next()
    if (c.req.header('Origin')) {
      c.header(
        'Access-Control-Expose-Headers',
        [
          'Content-Disposition',
          'Idempotency-Replayed',
          'RateLimit-Limit',
          'RateLimit-Remaining',
          'RateLimit-Reset',
          'Retry-After',
          'X-RateLimit-Limit',
          'X-RateLimit-Remaining',
          'X-RateLimit-Reset',
          'X-Request-Id',
        ].join(','),
      )
    }
  })

  router.onError((error, c) => toProblemResponse(c, error, dependencies))

  router.get('/v1/openapi.json', (c) => c.json(dependencies.openApiDocument))

  router.post('/v1/oauth/token', async (c) => {
    setSecretResponseHeaders(c)
    const clientIp = readTrustedClientIp(c)
    if (clientIp) {
      await enforceOAuthTokenRateLimit(
        c,
        dependencies,
        `ip:${digestRateLimitSubject(clientIp)}`,
        OAUTH_TOKEN_IP_RATE_LIMIT,
      )
    }
    const input = await readOAuthTokenInput(c)
    await enforceOAuthTokenRateLimit(
      c,
      dependencies,
      `client:${digestRateLimitSubject(input.clientId)}`,
      OAUTH_TOKEN_CLIENT_RATE_LIMIT,
    )
    if (input.grantType !== 'client_credentials') {
      throw new PublicApiServiceError(400, 'invalid_request', 'grant_type must be client_credentials.')
    }
    const token = await dependencies.oauthCredentials.issueOAuthToken({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      ...(input.scopes.length > 0 ? { scopes: input.scopes } : {}),
    })
    return c.json({
      access_token: token.accessToken,
      token_type: token.tokenType,
      expires_in: token.expiresIn,
      scope: token.scopes.join(' '),
    })
  })

  router.get('/v1/work-items', async (c) => {
    const credential = await authenticatePublicRequest(c, dependencies, ['work-items:read'])
    const filters = readWorkItemFilters(c)
    return c.json(await createSignedContinuationPage(
      c,
      dependencies,
      {
        workspaceId: credential.workspaceId,
        actorId: `credential:${credential.credentialId}`,
        resource: '/v1/work-items',
        filters,
      },
      (continuation, limit) =>
        dependencies.workItems.list(credential, filters, continuation, limit),
      (item) => item.updatedAt,
    ))
  })

  router.get('/v1/work-items/:workItemId', async (c) => {
    const credential = await authenticatePublicRequest(c, dependencies, ['work-items:read'])
    return c.json(await dependencies.workItems.get(
      credential,
      readRequiredQuery(c.req.query('teamId'), 'teamId'),
      readRouteId(c.req.param('workItemId'), 'Work Item ID'),
    ))
  })

  router.post('/v1/work-items', async (c) => {
    const credential = await authenticatePublicRequest(c, dependencies, ['work-items:write'])
    const body = readCreatePublicWorkItemRequest(await readJson(c))
    return executeIdempotentJson(
      c,
      dependencies,
      credential,
      body,
      async (mutationContext) => ({
        status: 201,
        body: await dependencies.workItems.create(credential, body, mutationContext),
      }),
      {
        authorizeReplay: () => dependencies.workItems.authorizeCreate(credential, body),
      },
    )
  })

  router.patch('/v1/work-items/:workItemId', async (c) => {
    const credential = await authenticatePublicRequest(c, dependencies, ['work-items:write'])
    const body = readUpdatePublicWorkItemRequest(await readJson(c))
    const teamId = readRequiredQuery(c.req.query('teamId'), 'teamId')
    const workItemId = readRouteId(c.req.param('workItemId'), 'Work Item ID')
    return executeIdempotentJson(
      c,
      dependencies,
      credential,
      body,
      async (
        mutationContext,
        idempotency,
      ) => ({
        status: 200,
        body: await dependencies.workItems.update(
          credential,
          teamId,
          workItemId,
          body,
          mutationContext,
          idempotency,
        ),
      }),
      {
        authorizeReplay: () =>
          dependencies.workItems.authorizeUpdate(credential, teamId, workItemId, body),
      },
    )
  })

  router.delete('/v1/work-items/:workItemId', async (c) => {
    const credential = await authenticatePublicRequest(c, dependencies, ['work-items:delete'])
    const body = readDeletePublicWorkItemRequest(await readJson(c))
    const teamId = readRequiredQuery(c.req.query('teamId'), 'teamId')
    const workItemId = readRouteId(c.req.param('workItemId'), 'Work Item ID')
    return executeIdempotentJson(
      c,
      dependencies,
      credential,
      body,
      async (
        mutationContext,
        idempotency,
      ) => {
        await dependencies.workItems.delete(
          credential,
          teamId,
          workItemId,
          body.expectedRevision,
          mutationContext,
          idempotency,
        )
        return { status: 204, body: null }
      },
      {
        authorizeReplay: () =>
          dependencies.workItems.authorizeDelete(credential, teamId, workItemId),
      },
    )
  })

  router.get('/v1/work-items/:workItemId/external-links', async (c) => {
    const credential = await authenticatePublicRequest(
      c,
      dependencies,
      ['work-items:read', 'integrations:read'],
    )
    const teamId = readRequiredQuery(c.req.query('teamId'), 'teamId')
    const workItemId = readRouteId(c.req.param('workItemId'), 'Work Item ID')
    await dependencies.workItems.authorizeExternalLink(credential, teamId, workItemId, false)
    const links = await dependencies.externalLinks.listExternalWorkItemLinks({
      workspaceId: credential.workspaceId,
      teamId,
      workItemId,
    })
    return c.json(createSignedKeysetPage(
      c,
      dependencies,
      {
        workspaceId: credential.workspaceId,
        actorId: `credential:${credential.credentialId}`,
        resource: '/v1/work-items/{workItemId}/external-links',
        filters: { teamId, workItemId },
      },
      links,
      (link) => link.createdAt,
    ))
  })

  router.post('/v1/work-items/:workItemId/external-links', async (c) => {
    const credential = await authenticatePublicRequest(
      c,
      dependencies,
      ['work-items:write', 'integrations:write'],
    )
    const teamId = readRequiredQuery(c.req.query('teamId'), 'teamId')
    const workItemId = readRouteId(c.req.param('workItemId'), 'Work Item ID')
    const body = readExternalLinkInput(await readJson(c))
    await dependencies.workItems.authorizeExternalLink(credential, teamId, workItemId, true)
    return executeIdempotentJson(c, dependencies, credential, body, async () => ({
      status: 201,
      body: await dependencies.externalLinks.createExternalWorkItemLink({
        workspaceId: credential.workspaceId,
        input: { ...body, teamId, workItemId },
      }),
    }))
  })

  router.delete('/v1/work-items/:workItemId/external-links/:linkId', async (c) => {
    const credential = await authenticatePublicRequest(
      c,
      dependencies,
      ['work-items:write', 'integrations:write'],
    )
    const teamId = readRequiredQuery(c.req.query('teamId'), 'teamId')
    const workItemId = readRouteId(c.req.param('workItemId'), 'Work Item ID')
    const linkId = readRouteId(c.req.param('linkId'), 'External link ID')
    return executeIdempotentJson(
      c,
      dependencies,
      credential,
      { teamId, workItemId, linkId },
      async (
        _context,
        idempotency,
      ) => {
        await dependencies.workItems.authorizeExternalLink(
          credential,
          teamId,
          workItemId,
          true,
        )
        await dependencies.externalLinks.deleteExternalWorkItemLink({
          workspaceId: credential.workspaceId,
          teamId,
          workItemId,
          linkId,
          deletedByActorId: `credential:${credential.credentialId}`,
          idempotency,
        })
        return { status: 204, body: null }
      },
      {
        authorizeReplay: () =>
          dependencies.workItems.authorizeExternalLink(
            credential,
            teamId,
            workItemId,
            true,
          ),
      },
    )
  })

  router.get('/developer', async (c) => {
    const principal = await requireManagementCapability(
      c,
      dependencies,
      'canManageCredentials',
    )
    const [apiKeys, oauthApps, webhookSubscriptions, deliveryPage, connectors, imports] =
      await Promise.all([
        dependencies.apiKeys.listApiKeys(principal.workspaceId),
        dependencies.oauthCredentials.listOAuthApps(principal.workspaceId),
        dependencies.webhookSubscriptions.listWebhookSubscriptions(principal.workspaceId),
        dependencies.webhookDeliveries.listWebhookDeliveries({
          workspaceId: principal.workspaceId,
          limit: 20,
        }),
        dependencies.connectors.listConnectors(principal.workspaceId),
        listAuthorizedImportJobs(dependencies.imports, dependencies.workItems, principal),
      ])
    return c.json({
      capabilities: principal.capabilities,
      apiKeys,
      oauthApps,
      webhookSubscriptions,
      webhookDeliveries: deliveryPage.deliveries,
      connectors,
      imports,
    } satisfies DeveloperPlatformOverview)
  })

  router.post('/developer/api-keys', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const input = readCreateApiKeyInput(await readJson(c))
    return executeManagementIdempotentJson(c, dependencies, principal, input, async (
      _context,
      idempotency,
    ) => ({
      status: 201,
      body: await dependencies.apiKeys.createApiKey({
        workspaceId: principal.workspaceId,
        createdByUserId: principal.userId,
        input,
        idempotency,
      }),
    }))
  })

  router.get('/developer/api-keys', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const apiKeys = await dependencies.apiKeys.listApiKeys(principal.workspaceId)
    return c.json(createSignedKeysetPage(
      c,
      dependencies,
      managementCursorScope(principal, '/developer/api-keys'),
      apiKeys,
      (apiKey) => apiKey.createdAt,
    ))
  })

  router.get('/developer/api-keys/:apiKeyId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const apiKeyId = readRouteId(c.req.param('apiKeyId'), 'API key ID')
    const apiKey = (await dependencies.apiKeys.listApiKeys(principal.workspaceId))
      .find((candidate) => candidate.id === apiKeyId)
    if (!apiKey) throw new PublicApiServiceError(404, 'not_found', 'API key was not found.')
    return c.json(apiKey)
  })

  router.post('/developer/api-keys/:apiKeyId/rotate', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const apiKeyId = readRouteId(c.req.param('apiKeyId'), 'API key ID')
    const apiKey = (await dependencies.apiKeys.listApiKeys(principal.workspaceId))
      .find((candidate) => candidate.id === apiKeyId)
    requireResourceCreator(apiKey, principal.userId, 'API key')
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { apiKeyId },
      async (_context, idempotency) => ({
        status: 200,
        body: await dependencies.apiKeys.rotateApiKey({
          workspaceId: principal.workspaceId,
          apiKeyId,
          idempotency,
        }),
      }),
    )
  })

  router.delete('/developer/api-keys/:apiKeyId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const apiKeyId = readRouteId(c.req.param('apiKeyId'), 'API key ID')
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { apiKeyId },
      async () => ({
        status: 200,
        body: await dependencies.apiKeys.revokeApiKey({
          workspaceId: principal.workspaceId,
          apiKeyId,
        }),
      }),
    )
  })

  router.post('/developer/oauth-apps', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const input = readCreateOAuthAppInput(await readJson(c))
    return executeManagementIdempotentJson(c, dependencies, principal, input, async (
      _context,
      idempotency,
    ) => ({
      status: 201,
      body: await dependencies.oauthCredentials.createOAuthApp({
        workspaceId: principal.workspaceId,
        createdByUserId: principal.userId,
        input,
        idempotency,
      }),
    }))
  })

  router.get('/developer/oauth-apps', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const oauthApps = await dependencies.oauthCredentials.listOAuthApps(principal.workspaceId)
    return c.json(createSignedKeysetPage(
      c,
      dependencies,
      managementCursorScope(principal, '/developer/oauth-apps'),
      oauthApps,
      (oauthApp) => oauthApp.createdAt,
    ))
  })

  router.get('/developer/oauth-apps/:oauthAppId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const oauthAppId = readRouteId(c.req.param('oauthAppId'), 'OAuth app ID')
    const oauthApp = (await dependencies.oauthCredentials.listOAuthApps(principal.workspaceId))
      .find((candidate) => candidate.id === oauthAppId)
    if (!oauthApp) throw new PublicApiServiceError(404, 'not_found', 'OAuth app was not found.')
    return c.json(oauthApp)
  })

  router.post('/developer/oauth-apps/:oauthAppId/rotate-secret', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const oauthAppId = readRouteId(c.req.param('oauthAppId'), 'OAuth app ID')
    const oauthApp = (await dependencies.oauthCredentials.listOAuthApps(principal.workspaceId))
      .find((candidate) => candidate.id === oauthAppId)
    requireResourceCreator(oauthApp, principal.userId, 'OAuth app')
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { oauthAppId },
      async (_context, idempotency) => ({
        status: 200,
        body: await dependencies.oauthCredentials.rotateOAuthClientSecret({
          workspaceId: principal.workspaceId,
          oauthAppId,
          idempotency,
        }),
      }),
    )
  })

  router.delete('/developer/oauth-apps/:oauthAppId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageCredentials')
    const oauthAppId = readRouteId(c.req.param('oauthAppId'), 'OAuth app ID')
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { oauthAppId },
      async () => ({
        status: 200,
        body: await dependencies.oauthCredentials.revokeOAuthApp({
          workspaceId: principal.workspaceId,
          oauthAppId,
        }),
      }),
    )
  })

  router.get('/developer/webhook-subscriptions', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageWebhooks')
    const subscriptions = await dependencies.webhookSubscriptions.listWebhookSubscriptions(
      principal.workspaceId,
    )
    return c.json(createSignedKeysetPage(
      c,
      dependencies,
      managementCursorScope(principal, '/developer/webhook-subscriptions'),
      subscriptions,
      (subscription) => subscription.createdAt,
    ))
  })

  router.post('/developer/webhook-subscriptions', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageWebhooks')
    const input = readCreateWebhookSubscriptionInput(await readJson(c))
    await dependencies.workItems.authorizeWebhookTeams(principal, input.teamIds)
    await assertSafeWebhookUrl(input.url)
    return executeManagementIdempotentJson(c, dependencies, principal, input, async (
      _context,
      idempotency,
    ) => {
      const result = await dependencies.webhookSubscriptions.createWebhookSubscription({
        workspaceId: principal.workspaceId,
        createdByUserId: principal.userId,
        input,
        idempotency,
      })
      return {
        status: 201,
        body: {
          subscription: result.subscription,
          signingSecret: result.signingSecret,
        },
      }
    })
  })

  router.get('/developer/webhook-subscriptions/:subscriptionId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageWebhooks')
    const subscriptionId = readRouteId(
      c.req.param('subscriptionId'),
      'Webhook subscription ID',
    )
    const subscription = (await dependencies.webhookSubscriptions.listWebhookSubscriptions(
      principal.workspaceId,
    ))
      .find((candidate) => candidate.id === subscriptionId)
    if (!subscription) {
      throw new PublicApiServiceError(404, 'not_found', 'Webhook subscription was not found.')
    }
    return c.json(subscription)
  })

  router.patch('/developer/webhook-subscriptions/:subscriptionId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageWebhooks')
    const subscriptionId = readRouteId(
      c.req.param('subscriptionId'),
      'Webhook subscription ID',
    )
    const input = readUpdateWebhookSubscriptionInput(await readJson(c))
    const subscription = await requireWebhookSubscriptionCreator(
      dependencies.webhookSubscriptions,
      principal,
      subscriptionId,
    )
    await dependencies.workItems.authorizeWebhookTeams(principal, subscription.teamIds)
    if (input.url) await assertSafeWebhookUrl(input.url)
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { subscriptionId, ...input },
      async (_context, idempotency) => ({
        status: 200,
        body: await dependencies.webhookSubscriptions.updateWebhookSubscription({
          workspaceId: principal.workspaceId,
          subscriptionId,
          input,
          idempotency,
        }),
      }),
    )
  })

  router.post('/developer/webhook-subscriptions/:subscriptionId/rotate-secret', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageWebhooks')
    const subscriptionId = readRouteId(c.req.param('subscriptionId'), 'Webhook subscription ID')
    const subscription = await requireWebhookSubscriptionCreator(
      dependencies.webhookSubscriptions,
      principal,
      subscriptionId,
    )
    await dependencies.workItems.authorizeWebhookTeams(principal, subscription.teamIds)
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { subscriptionId },
      async (_context, idempotency) => {
        const result = await dependencies.webhookSubscriptions.rotateWebhookSecret({
          workspaceId: principal.workspaceId,
          subscriptionId,
          idempotency,
        })
        return {
          status: 200,
          body: {
            subscription: result.subscription,
            signingSecret: result.signingSecret,
          },
        }
      },
    )
  })

  router.delete('/developer/webhook-subscriptions/:subscriptionId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageWebhooks')
    const subscriptionId = readRouteId(c.req.param('subscriptionId'), 'Webhook subscription ID')
    const subscription = await requireWebhookSubscriptionCreator(
      dependencies.webhookSubscriptions,
      principal,
      subscriptionId,
    )
    await dependencies.workItems.authorizeWebhookTeams(principal, subscription.teamIds)
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { subscriptionId },
      async (_context, idempotency) => {
        const response = { status: 204 as const, body: null }
        await dependencies.webhookSubscriptions.setWebhookSubscriptionStatus({
          workspaceId: principal.workspaceId,
          subscriptionId,
          status: 'disabled',
          idempotency,
          idempotencyResponse: response,
        })
        return response
      },
    )
  })

  router.get('/developer/webhook-deliveries', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageWebhooks')
    const subscriptionId = c.req.query('subscriptionId')
      ? readRequiredQuery(c.req.query('subscriptionId'), 'subscriptionId')
      : undefined
    return c.json(await createSignedContinuationPage(
      c,
      dependencies,
      managementCursorScope(
        principal,
        '/developer/webhook-deliveries',
        { subscriptionId },
      ),
      async (continuation, limit) => {
        const page = await dependencies.webhookDeliveries.listWebhookDeliveries({
          workspaceId: principal.workspaceId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...(continuation ? { cursor: continuation } : {}),
          limit,
        })
        return {
          items: page.deliveries,
          hasMore: page.nextCursor !== undefined,
          ...(page.nextCursor ? { nextContinuation: page.nextCursor } : {}),
        }
      },
      (delivery) => delivery.createdAt,
    ))
  })

  router.get('/developer/webhook-deliveries/:deliveryId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageWebhooks')
    const deliveryId = readRouteId(c.req.param('deliveryId'), 'Webhook delivery ID')
    return c.json(await dependencies.webhookDeliveries.getWebhookDelivery({
      workspaceId: principal.workspaceId,
      deliveryId,
    }))
  })

  router.post('/developer/webhook-deliveries/:deliveryId/replay', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageWebhooks')
    const deliveryId = readRouteId(c.req.param('deliveryId'), 'Webhook delivery ID')
    if (!dependencies.queueWebhookDelivery) {
      readIdempotencyKey(c.req.header('Idempotency-Key'))
      throw unavailableManagementMutation('Webhook replay queue')
    }
    const requestedDelivery = await dependencies.webhookDeliveries.getWebhookDelivery({
      workspaceId: principal.workspaceId,
      deliveryId,
    })
    const subscription = await requireWebhookSubscriptionCreator(
      dependencies.webhookSubscriptions,
      principal,
      requestedDelivery.subscriptionId,
    )
    await dependencies.workItems.authorizeWebhookTeams(principal, subscription.teamIds)
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { deliveryId },
      async (_context, idempotency) => {
        const delivery = await dependencies.webhookDeliveries.replayWebhookDelivery({
          workspaceId: principal.workspaceId,
          deliveryId,
          operationId: createHash('sha256')
            .update(
              `webhook-replay-operation-v1\0${principal.workspaceId}\0` +
                `${idempotency.credentialId}\0${idempotency.idempotencyKey}\0` +
                idempotency.requestFingerprint,
            )
            .digest('hex'),
        })
        await dependencies.queueWebhookDelivery!(principal.workspaceId, delivery.id)
        return { status: 202, body: delivery }
      },
    )
  })

  router.get('/developer/connectors', async (c) => {
    await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const category = c.req.query('category')
    if (
      category !== undefined &&
      !['source-control', 'chat', 'email', 'calendar', 'cloud-storage'].includes(category)
    ) {
      throw new PublicApiServiceError(400, 'invalid_request', 'Connector category is invalid.')
    }
    return c.json(
      category === undefined
        ? connectorCatalog
        : connectorCatalog.filter((connector) => connector.category === category),
    )
  })

  router.get('/developer/connector-oauth/callback', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Pragma', 'no-cache')
    c.header('Referrer-Policy', 'no-referrer')
    if (!dependencies.connectorAuthorization) {
      throw unavailableManagementMutation('Connector OAuth callback')
    }
    const state = readOAuthCallbackValue(c.req.query('state'), 'OAuth state', 2_048)
    if (c.req.query('error') !== undefined) {
      const result = await dependencies.connectorAuthorization.abortCallback({ state })
      return c.redirect(appendConnectorCallbackOutcome(result.returnUrl, 'cancelled'), 303)
    }
    const code = readOAuthCallbackValue(c.req.query('code'), 'OAuth authorization code', 8_192)
    const result = await dependencies.connectorAuthorization.completeCallback({ code, state })
    return c.redirect(appendConnectorCallbackOutcome(result.returnUrl, 'connected'), 303)
  })

  router.get('/developer/connector-installations', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const status = c.req.query('status')
    if (
      status !== undefined &&
      !['connected', 'needs-reauth', 'degraded', 'disconnected', 'conflict'].includes(status)
    ) {
      throw new PublicApiServiceError(400, 'invalid_request', 'Connector status is invalid.')
    }
    const installations = await dependencies.connectors.listConnectors(principal.workspaceId)
    const filteredInstallations = status === undefined
      ? installations
      : installations.filter((installation) => installation.status === status)
    return c.json(createSignedKeysetPage(
      c,
      dependencies,
      managementCursorScope(
        principal,
        '/developer/connector-installations',
        { status },
      ),
      filteredInstallations,
      (installation) => installation.installedAt,
    ))
  })

  router.post('/developer/connector-installations', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const input = readConnectorAuthorizationInput(await readJson(c))
    if (!dependencies.connectorAuthorization) {
      readIdempotencyKey(c.req.header('Idempotency-Key'))
      throw unavailableManagementMutation('Connector OAuth authorization')
    }
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      input,
      async (_context, idempotency) => ({
        status: 201,
        body: await dependencies.connectorAuthorization!.begin(
          principal,
          input,
          createConnectorOAuthOperationId(principal.workspaceId, idempotency),
        ),
      }),
    )
  })

  router.get('/developer/connector-installations/:installationId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const installationId = readRouteId(
      c.req.param('installationId'),
      'Connector installation ID',
    )
    const installation = (await dependencies.connectors.listConnectors(principal.workspaceId))
      .find((candidate) => candidate.id === installationId)
    if (!installation) {
      throw new PublicApiServiceError(404, 'not_found', 'Connector installation was not found.')
    }
    return c.json(installation)
  })

  router.delete('/developer/connector-installations/:installationId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const installationId = readRouteId(
      c.req.param('installationId'),
      'Connector installation ID',
    )
    if (!dependencies.connectorAuthorization) {
      readIdempotencyKey(c.req.header('Idempotency-Key'))
      throw unavailableManagementMutation('Connector provider disconnect')
    }
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { installationId },
      async () => {
        let snapshot: ConnectorLifecycleSnapshot
        try {
          snapshot = await dependencies.connectorAuthorization!.disconnect(
            principal,
            installationId,
          )
        } catch {
          throw new PublicApiServiceError(
            503,
            'temporarily_unavailable',
            'Connector disconnect did not finish. Retry the same operation to recover safely.',
            true,
          )
        }
        if (snapshot.installation.status !== 'disconnected') {
          throw new PublicApiServiceError(
            503,
            'temporarily_unavailable',
            'Connector disconnect did not reach a stable local state.',
            true,
          )
        }
        return {
          status: 200,
          body: snapshot.installation,
        }
      },
      { releaseReservationAfterCompletionFailure: true },
    )
  })

  router.post(
    '/developer/connector-installations/:installationId/reauthorize',
    async (c) => {
      const principal = await requireManagementCapability(
        c,
        dependencies,
        'canManageIntegrations',
      )
      const installationId = readRouteId(
        c.req.param('installationId'),
        'Connector installation ID',
      )
      if (!dependencies.connectorAuthorization) {
        readIdempotencyKey(c.req.header('Idempotency-Key'))
        throw unavailableManagementMutation('Connector OAuth reauthorization')
      }
      return executeManagementIdempotentJson(
        c,
        dependencies,
        principal,
        { installationId },
        async (_context, idempotency) => ({
          status: 200,
          body: await dependencies.connectorAuthorization!.reauthorize(
            principal,
            installationId,
            createConnectorOAuthOperationId(principal.workspaceId, idempotency),
          ),
        }),
      )
    },
  )

  router.get('/developer/work-items/:workItemId/external-links', async (c) => {
    const principal = await authenticateManagementRequest(c, dependencies)
    const teamId = readRequiredQuery(c.req.query('teamId'), 'teamId')
    const workItemId = readRouteId(c.req.param('workItemId'), 'Work Item ID')
    await dependencies.workItems.authorizeExternalLink(
      toManagementCredential(principal),
      teamId,
      workItemId,
      false,
    )
    const installationId = c.req.query('installationId')
      ? readRequiredQuery(c.req.query('installationId'), 'installationId')
      : undefined
    const links = await dependencies.externalLinks.listExternalWorkItemLinks({
      workspaceId: principal.workspaceId,
      teamId,
      workItemId,
      ...(installationId ? { installationId } : {}),
    })
    return c.json(createSignedKeysetPage(
      c,
      dependencies,
      managementCursorScope(
        principal,
        '/developer/work-items/{workItemId}/external-links',
        { teamId, workItemId, installationId },
      ),
      links,
      (link) => link.createdAt,
    ))
  })

  router.post('/developer/work-items/:workItemId/external-links', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const workItemId = readRouteId(c.req.param('workItemId'), 'Work Item ID')
    const body = readExternalLinkInput(await readJson(c), true)
    await dependencies.workItems.authorizeExternalLink(
      toManagementCredential(principal),
      body.teamId,
      workItemId,
      true,
    )
    return executeManagementIdempotentJson(c, dependencies, principal, body, async () => ({
      status: 201,
      body: await dependencies.externalLinks.createExternalWorkItemLink({
        workspaceId: principal.workspaceId,
        input: { ...body, workItemId },
      }),
    }))
  })

  router.get('/developer/external-links/:linkId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const link = await requireExternalWorkItemLink(
      dependencies.externalLinks,
      principal.workspaceId,
      readRouteId(c.req.param('linkId'), 'External link ID'),
    )
    await dependencies.workItems.authorizeExternalLink(
      toManagementCredential(principal),
      link.teamId,
      link.workItemId,
      false,
    )
    return c.json(link)
  })

  router.patch('/developer/external-links/:linkId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const link = await requireExternalWorkItemLink(
      dependencies.externalLinks,
      principal.workspaceId,
      readRouteId(c.req.param('linkId'), 'External link ID'),
    )
    await dependencies.workItems.authorizeExternalLink(
      toManagementCredential(principal),
      link.teamId,
      link.workItemId,
      true,
    )
    const body = readExternalLinkPatch(await readJson(c))
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      body,
      async (_context, idempotency) => ({
        status: 200,
        body: await dependencies.externalLinks.updateExternalWorkItemLink({
          workspaceId: principal.workspaceId,
          teamId: link.teamId,
          workItemId: link.workItemId,
          linkId: link.id,
          updatedByUserId: principal.userId,
          input: body,
          idempotency,
        }),
      }),
    )
  })

  router.delete('/developer/external-links/:linkId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const teamId = readRequiredQuery(c.req.query('teamId'), 'teamId')
    const workItemId = readRequiredQuery(c.req.query('workItemId'), 'workItemId')
    const linkId = readRouteId(c.req.param('linkId'), 'External link ID')
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { teamId, workItemId, linkId },
      async (_context, idempotency) => {
        const link = await requireExternalWorkItemLink(
          dependencies.externalLinks,
          principal.workspaceId,
          linkId,
        )
        if (link.teamId !== teamId || link.workItemId !== workItemId) {
          throw new PublicApiServiceError(
            404,
            'not_found',
            'External Work Item link was not found.',
          )
        }
        await dependencies.workItems.authorizeExternalLink(
          toManagementCredential(principal),
          teamId,
          workItemId,
          true,
        )
        await dependencies.externalLinks.deleteExternalWorkItemLink({
          workspaceId: principal.workspaceId,
          teamId,
          workItemId,
          linkId: link.id,
          deletedByActorId: principal.userId,
          idempotency,
        })
        return { status: 204, body: null }
      },
      {
        authorizeReplay: () =>
          dependencies.workItems.authorizeExternalLink(
            toManagementCredential(principal),
            teamId,
            workItemId,
            true,
          ),
      },
    )
  })

  router.get('/developer/sync-conflicts', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    if (!dependencies.connectorAuthorization) {
      throw unavailableManagementMutation('Sync-conflict persistence')
    }
    const status = readSyncConflictStatus(c.req.query('status'))
    return c.json(await createSignedContinuationPage(
      c,
      dependencies,
      managementCursorScope(
        principal,
        '/developer/sync-conflicts',
        { status },
      ),
      async (continuation, limit) => {
        const page = await dependencies.connectorAuthorization!.listConflicts(principal, {
          ...(status ? { status } : {}),
          ...(continuation ? { cursor: continuation } : {}),
          limit,
        })
        return {
          items: page.items,
          hasMore: page.hasMore,
          ...(page.nextCursor ? { nextContinuation: page.nextCursor } : {}),
        }
      },
      (conflict) => conflict.detectedAt,
    ))
  })

  router.post('/developer/sync-conflicts/:conflictId/resolve', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canManageIntegrations')
    const conflictId = readRouteId(c.req.param('conflictId'), 'Sync conflict ID')
    const input = readSyncConflictResolution(await readJson(c))
    if (!dependencies.connectorAuthorization) {
      readIdempotencyKey(c.req.header('Idempotency-Key'))
      throw unavailableManagementMutation('Sync-conflict resolution')
    }
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { conflictId, input },
      async () => ({
        status: 200,
        body: await dependencies.connectorAuthorization!.resolveConflict(
          principal,
          conflictId,
          input,
        ),
      }),
      {
        authorizeReplay: () => requireAuthorizedSyncConflict(
          dependencies.connectorAuthorization!,
          dependencies.externalLinks,
          dependencies.workItems,
          principal,
          conflictId,
        ),
      },
    )
  })

  router.post('/developer/imports/dry-run', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canImport')
    const input = readPublicImportSourceInput(await readJson(c))
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      input,
      async () => ({
        status: 200,
        body: await dependencies.workItems.dryRunImport(principal, input),
      }),
      {
        releaseReservationAfterCompletionFailure: true,
        authorizeReplay: async () => {
          await dependencies.workItems.dryRunImport(principal, input)
        },
      },
    )
  })

  router.get('/developer/imports', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canImport')
    const imports = await listAuthorizedImportJobs(
      dependencies.imports,
      dependencies.workItems,
      principal,
    )
    return c.json(createSignedKeysetPage(
      c,
      dependencies,
      managementCursorScope(principal, '/developer/imports'),
      imports,
      (job) => job.createdAt,
    ))
  })

  router.post('/developer/imports', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canImport')
    const input = readPublicImportSourceInput(await readJson(c))
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      input,
      async (context) => ({
        status: 202,
        body: await dependencies.workItems.commitImport(
          principal,
          undefined,
          input,
          context,
        ),
      }),
      {
        authorizeReplay: async () => {
          await dependencies.workItems.dryRunImport(principal, input)
        },
      },
    )
  })

  router.get('/developer/imports/:jobId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canImport')
    return c.json(await requireAuthorizedImportJob(
      dependencies.imports,
      dependencies.workItems,
      principal,
      readRouteId(c.req.param('jobId'), 'Import job ID'),
      false,
    ))
  })

  router.delete('/developer/imports/:jobId', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canImport')
    const jobId = readRouteId(c.req.param('jobId'), 'Import job ID')
    return executeManagementIdempotentJson(
      c,
      dependencies,
      principal,
      { jobId },
      async (context) => ({
        status: 200,
        body: await dependencies.workItems.cancelImport(
          principal,
          await requireAuthorizedImportJob(
            dependencies.imports,
            dependencies.workItems,
            principal,
            jobId,
            true,
          ),
          context,
        ),
      }),
      {
        releaseReservationAfterCompletionFailure: true,
        authorizeReplay: async () => {
          await requireAuthorizedImportJob(
            dependencies.imports,
            dependencies.workItems,
            principal,
            jobId,
            true,
          )
        },
      },
    )
  })

  router.get('/developer/imports/:jobId/report', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canImport')
    const job = await requireAuthorizedImportJob(
      dependencies.imports,
      dependencies.workItems,
      principal,
      readRouteId(c.req.param('jobId'), 'Import job ID'),
      false,
    )
    if (!job.report) {
      const pending = job.status === 'queued' ||
        job.status === 'validating' ||
        job.status === 'running'
      throw new PublicApiServiceError(
        409,
        'conflict',
        pending
          ? 'Import report is not available yet.'
          : 'This terminal import did not produce a row report.',
        pending,
      )
    }
    return c.json(job.report)
  })

  router.get('/developer/exports', async (c) => {
    const principal = await requireManagementCapability(c, dependencies, 'canExport')
    const format = readExportFormat(c.req.query('format'))
    return c.json(await createSignedContinuationPage(
      c,
      dependencies,
      managementCursorScope(principal, '/developer/exports', { format }),
      (continuation, limit) =>
        dependencies.workItems.export(principal, format, continuation, limit),
      (item) => item.updatedAt,
    ))
  })

  return router
}

function unavailableManagementMutation(capability: string) {
  return new PublicApiServiceError(
    503,
    'temporarily_unavailable',
    `${capability} is not available until its durable provider adapter is configured.`,
    true,
  )
}

async function listAuthorizedImportJobs(
  platform: ImportPort,
  workItems: PublicWorkItemService,
  principal: DeveloperManagementPrincipal,
) {
  const jobs = (await platform.listImportJobs(principal.workspaceId))
    .filter((job) => job.createdByUserId === principal.userId)
  const authorized: ImportJob[] = []
  for (const job of jobs) {
    try {
      await workItems.authorizeImportJob(principal, job, false)
      authorized.push(job)
    } catch (error) {
      if (
        error instanceof PublicApiServiceError &&
        (error.status === 403 || error.status === 404)
      ) {
        continue
      }
      throw error
    }
  }
  return authorized
}

async function requireAuthorizedImportJob(
  platform: ImportPort,
  workItems: PublicWorkItemService,
  principal: DeveloperManagementPrincipal,
  jobId: string,
  write: boolean,
) {
  const job = (await platform.listImportJobs(principal.workspaceId))
    .find((candidate) => candidate.id === jobId)
  if (!job || job.createdByUserId !== principal.userId) {
    throw new PublicApiServiceError(404, 'not_found', 'Import job was not found.')
  }
  try {
    await workItems.authorizeImportJob(principal, job, write)
  } catch (error) {
    if (
      error instanceof PublicApiServiceError &&
      (error.status === 403 || error.status === 404)
    ) {
      throw new PublicApiServiceError(404, 'not_found', 'Import job was not found.')
    }
    throw error
  }
  return job
}

async function requireExternalWorkItemLink(
  platform: ExternalLinkPort,
  workspaceId: string,
  linkId: string,
) {
  const link = (await platform.listExternalWorkItemLinks({ workspaceId, linkId }))[0]
  if (!link) {
    throw new PublicApiServiceError(404, 'not_found', 'External Work Item link was not found.')
  }
  return link
}

async function requireAuthorizedSyncConflict(
  connectorAuthorization: ConnectorAuthorizationService,
  platform: ExternalLinkPort,
  workItems: PublicWorkItemService,
  principal: DeveloperManagementPrincipal,
  conflictId: string,
) {
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await connectorAuthorization.listConflicts(principal, {
      ...(cursor ? { cursor } : {}),
      limit: PUBLIC_API_MAX_PAGE_SIZE,
    })
    const conflict = page.items.find((candidate) => candidate.id === conflictId)
    if (conflict) {
      const link = await requireExternalWorkItemLink(
        platform,
        principal.workspaceId,
        conflict.externalLinkId,
      )
      if (link.workItemId !== conflict.workItemId) {
        throw new PublicApiServiceError(
          404,
          'not_found',
          'Connector sync conflict was not found.',
        )
      }
      await workItems.authorizeExternalLink(
        toManagementCredential(principal),
        link.teamId,
        conflict.workItemId,
        true,
      )
      return
    }
    if (!page.hasMore) break
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
      throw new PublicApiServiceError(
        503,
        'temporarily_unavailable',
        'Connector sync conflict authorization could not advance safely.',
        true,
      )
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new PublicApiServiceError(
    404,
    'not_found',
    'Connector sync conflict was not found.',
  )
}

function toManagementCredential(
  principal: DeveloperManagementPrincipal,
): AuthenticatedDeveloperCredential {
  return {
    kind: 'oauth-token',
    workspaceId: principal.workspaceId,
    credentialId: `session:${principal.userId}`,
    subjectUserId: principal.userId,
    scopes: [
      'work-items:read',
      'work-items:write',
      'work-items:delete',
      'webhooks:read',
      'webhooks:write',
      'integrations:read',
      'integrations:write',
      'imports:read',
      'imports:write',
    ],
  }
}

async function authenticatePublicRequest(
  c: Context,
  dependencies: PublicApiDependencies,
  requiredScopes: readonly ApiScope[],
) {
  const bearer = readBearerToken(c.req.header('Authorization'))
  let credential: AuthenticatedDeveloperCredential
  if (bearer.startsWith('mk_key_')) {
    credential = await dependencies.apiKeys.authenticateApiKey({
      credential: bearer,
      requiredScopes,
    })
  } else {
    credential = await dependencies.oauthCredentials.authenticateOAuthToken({
      credential: bearer,
      requiredScopes,
    })
  }
  const rateLimit = await dependencies.rateLimits.consumeRateLimit({
    workspaceId: credential.workspaceId,
    credentialId: credential.credentialId,
    limit: PUBLIC_API_RATE_LIMIT,
    windowSeconds: 60,
  })
  c.header('X-RateLimit-Limit', String(rateLimit.limit))
  c.header('X-RateLimit-Remaining', String(rateLimit.remaining))
  c.header('X-RateLimit-Reset', rateLimit.resetAt)
  c.header('RateLimit-Limit', String(rateLimit.limit))
  c.header('RateLimit-Remaining', String(rateLimit.remaining))
  const now = dependencies.now?.() ?? new Date()
  c.header('RateLimit-Reset', String(Math.max(
    0,
    Math.ceil((Date.parse(rateLimit.resetAt) - now.getTime()) / 1_000),
  )))
  if (!rateLimit.allowed) {
    c.header('Retry-After', String(rateLimit.retryAfterSeconds ?? 1))
    throw new PublicApiServiceError(429, 'rate_limited', 'API rate limit exceeded.', true)
  }
  await dependencies.enforceEntitlement(
    credential.workspaceId,
    c.req.method,
    await createPublicApiUsageIdempotencyScope(c),
  )
  return credential
}

/**
 * Binds a public API idempotency key to its method, route, and payload.
 *
 * @param context - Current public API request context.
 * @returns A route-scoped digest, or undefined when no key was supplied.
 */
async function createPublicApiUsageIdempotencyScope(
  context: Context,
): Promise<string | undefined> {
  const value = context.req.header('Idempotency-Key')?.trim()
  if (!value) return undefined
  if (value.length > 256 || containsAsciiControl(value, false)) {
    throw new PublicApiServiceError(
      400,
      'invalid_request',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  if (context.req.raw.bodyUsed) {
    throw new PublicApiServiceError(
      503,
      'temporarily_unavailable',
      'Request idempotency could not be evaluated.',
      true,
    )
  }
  const contentLength = context.req.header('Content-Length')
  if (
    contentLength !== undefined &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > PUBLIC_API_METERING_BODY_MAX_BYTES
  ) {
    throw publicApiMeteringBodyTooLarge()
  }
  const requestDigest = createHash('sha256')
    .update(context.req.header('Content-Type') ?? '')
    .update('\0')
  const bodyReader = context.req.raw.clone().body?.getReader()
  let bodyBytes = 0
  if (bodyReader) {
    try {
      while (true) {
        const chunk = await bodyReader.read()
        if (chunk.done) break
        bodyBytes += chunk.value.byteLength
        if (bodyBytes > PUBLIC_API_METERING_BODY_MAX_BYTES) {
          await bodyReader.cancel().catch(() => undefined)
          throw publicApiMeteringBodyTooLarge()
        }
        requestDigest.update(chunk.value)
      }
    } finally {
      bodyReader.releaseLock()
    }
  }
  const url = new URL(context.req.url)
  const scopeDigest = createHash('sha256')
    .update(context.req.method.toUpperCase())
    .update('\0')
    .update(context.req.path)
    .update('\0')
    .update(url.search)
    .update('\0')
    .update(context.req.header('If-Match') ?? '')
    .update('\0')
    .update(value)
    .digest('hex')
  return `tenant-meter:v1:${scopeDigest}:${requestDigest.digest('hex')}`
}

/** Creates the stable public API response used for an oversized metering body. */
function publicApiMeteringBodyTooLarge(): PublicApiServiceError {
  return new PublicApiServiceError(
    413,
    'invalid_request',
    'The metered request body is too large.',
  )
}

async function enforceOAuthTokenRateLimit(
  c: Context,
  dependencies: PublicApiDependencies,
  credentialId: string,
  limit: number,
) {
  const rateLimit = await dependencies.rateLimits.consumeRateLimit({
    workspaceId: 'public-oauth-token',
    credentialId,
    limit,
    windowSeconds: 60,
  })
  c.header('X-RateLimit-Limit', String(rateLimit.limit))
  c.header('X-RateLimit-Remaining', String(rateLimit.remaining))
  c.header('X-RateLimit-Reset', rateLimit.resetAt)
  c.header('RateLimit-Limit', String(rateLimit.limit))
  c.header('RateLimit-Remaining', String(rateLimit.remaining))
  const now = dependencies.now?.() ?? new Date()
  c.header('RateLimit-Reset', String(Math.max(
    0,
    Math.ceil((Date.parse(rateLimit.resetAt) - now.getTime()) / 1_000),
  )))
  if (!rateLimit.allowed) {
    c.header('Retry-After', String(rateLimit.retryAfterSeconds ?? 1))
    throw new PublicApiServiceError(
      429,
      'rate_limited',
      'OAuth token endpoint rate limit exceeded.',
      true,
    )
  }
}

function readTrustedClientIp(c: Context) {
  const environment = isObjectRecord(c.env) ? c.env : undefined
  const event = environment && isObjectRecord(environment.event)
    ? environment.event
    : undefined
  const requestContext = event && isObjectRecord(event.requestContext)
    ? event.requestContext
    : undefined
  const http = requestContext && isObjectRecord(requestContext.http)
    ? requestContext.http
    : undefined
  if (typeof http?.sourceIp !== 'string') return undefined
  const normalized = http.sourceIp.trim()
  return isIP(normalized) !== 0 ? normalized : undefined
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function digestRateLimitSubject(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function isSecretBearingRequest(method: string, pathname: string) {
  if (method !== 'POST') return false
  return pathname.endsWith('/v1/oauth/token') ||
    pathname.endsWith('/developer/api-keys') ||
    /\/developer\/api-keys\/[^/]+\/rotate$/u.test(pathname) ||
    pathname.endsWith('/developer/oauth-apps') ||
    /\/developer\/oauth-apps\/[^/]+\/rotate-secret$/u.test(pathname) ||
    pathname.endsWith('/developer/webhook-subscriptions') ||
    /\/developer\/webhook-subscriptions\/[^/]+\/rotate-secret$/u.test(pathname)
}

function setSecretResponseHeaders(c: Context) {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
}

async function authenticateManagementRequest(c: Context, dependencies: PublicApiDependencies) {
  const authorization = c.req.header('Authorization') ?? ''
  if (!authorization) {
    throw new PublicApiServiceError(401, 'authentication_required', 'Bearer token is required.')
  }
  const principal = await dependencies.authenticateManagement(authorization, c)
  const rateLimit = await dependencies.rateLimits.consumeRateLimit({
    workspaceId: principal.workspaceId,
    credentialId: `management:${principal.userId}`,
    limit: PUBLIC_API_RATE_LIMIT,
    windowSeconds: 60,
  })
  c.header('X-RateLimit-Limit', String(rateLimit.limit))
  c.header('X-RateLimit-Remaining', String(rateLimit.remaining))
  c.header('X-RateLimit-Reset', rateLimit.resetAt)
  c.header('RateLimit-Limit', String(rateLimit.limit))
  c.header('RateLimit-Remaining', String(rateLimit.remaining))
  const now = dependencies.now?.() ?? new Date()
  c.header('RateLimit-Reset', String(Math.max(
    0,
    Math.ceil((Date.parse(rateLimit.resetAt) - now.getTime()) / 1_000),
  )))
  if (!rateLimit.allowed) {
    c.header('Retry-After', String(rateLimit.retryAfterSeconds ?? 1))
    throw new PublicApiServiceError(429, 'rate_limited', 'API rate limit exceeded.', true)
  }
  return principal
}

async function requireManagementCapability(
  c: Context,
  dependencies: PublicApiDependencies,
  capability: keyof DeveloperPlatformCapabilities,
) {
  const principal = await authenticateManagementRequest(c, dependencies)
  if (
    !principal.capabilities.canManageCredentials ||
    !principal.capabilities[capability]
  ) {
    throw new PublicApiServiceError(403, 'forbidden', 'Workspace administrator access is required.')
  }
  return principal
}

/** Idempotent mutation の reservation/replay 制御 option です。 */
type IdempotentExecutionOptions = {
  /** Receipt 保存失敗後に安全に同じ domain operation を再実行できるかどうかです。 */
  releaseReservationAfterCompletionFailure?: boolean
  /** Completed receipt を返す直前に current domain authorization を再評価します。 */
  authorizeReplay?: () => Promise<void>
}

async function executeIdempotentJson(
  c: Context,
  dependencies: PublicApiDependencies,
  credential: AuthenticatedDeveloperCredential,
  body: unknown,
  operation: (
    context: PublicMutationContext,
    idempotency: IdempotencyMutationToken,
  ) => Promise<{ status: 200 | 201 | 202 | 204; body: unknown }>,
  options: IdempotentExecutionOptions = {},
) {
  return executeIdempotent(c, dependencies, {
    workspaceId: credential.workspaceId,
    credentialId: credential.credentialId,
  }, body, operation, options)
}

async function executeManagementIdempotentJson(
  c: Context,
  dependencies: PublicApiDependencies,
  principal: DeveloperManagementPrincipal,
  body: unknown,
  operation: (
    context: PublicMutationContext,
    idempotency: IdempotencyMutationToken,
  ) => Promise<{ status: 200 | 201 | 202 | 204; body: unknown }>,
  options: IdempotentExecutionOptions = {},
) {
  return executeIdempotent(c, dependencies, {
    workspaceId: principal.workspaceId,
    credentialId: `user:${principal.userId}`,
  }, body, operation, options)
}

async function executeIdempotent(
  c: Context,
  dependencies: PublicApiDependencies,
  actor: { workspaceId: string; credentialId: string },
  body: unknown,
  operation: (
    context: PublicMutationContext,
    idempotency: IdempotencyMutationToken,
  ) => Promise<{ status: 200 | 201 | 202 | 204; body: unknown }>,
  options: IdempotentExecutionOptions = {},
) {
  const idempotencyKey = readIdempotencyKey(c.req.header('Idempotency-Key'))
  const requestUrl = new URL(c.req.url)
  requestUrl.searchParams.sort()
  const canonicalTarget = `${requestUrl.pathname}${
    requestUrl.searchParams.size > 0 ? `?${requestUrl.searchParams.toString()}` : ''
  }`
  const requestFingerprint = createHash('sha256')
    .update(`${c.req.method}\n${canonicalTarget}\n${stableStringify(body)}`)
    .digest('hex')
  const reservation = await dependencies.idempotency.reserveIdempotency({
    ...actor,
    idempotencyKey,
    requestFingerprint,
  })
  if (reservation.status === 'in-progress') {
    throw new PublicApiServiceError(
      409,
      'idempotency_conflict',
      'An identical idempotent request is still in progress.',
      true,
    )
  }
  if (reservation.status === 'replay') {
    await options.authorizeReplay?.()
    const replay = requireStoredResponse(reservation.response)
    c.header('Idempotency-Replayed', 'true')
    return respondIdempotent(c, replay)
  }
  const context: PublicMutationContext = {
    requestId: c.get('requestId'),
    idempotencyKey,
    ...(c.req.header('X-Correlation-Id')?.trim()
      ? { correlationId: c.req.header('X-Correlation-Id')!.trim() }
      : {}),
  }
  const idempotency: IdempotencyMutationToken = {
    credentialId: actor.credentialId,
    idempotencyKey,
    requestFingerprint,
    reservationId: reservation.reservationId,
  }
  let result: { status: 200 | 201 | 202 | 204; body: unknown }
  try {
    result = await operation(context, idempotency)
  } catch (error) {
    try {
      await dependencies.idempotency.releaseIdempotency({
        ...actor,
        idempotencyKey,
        requestFingerprint,
        reservationId: reservation.reservationId,
      })
    } catch (releaseError) {
      console.error(
        'Failed to release an idempotency reservation.',
        toSafePublicApiErrorLog(releaseError),
      )
    }
    throw error
  }
  try {
    await dependencies.idempotency.completeIdempotency({
      ...actor,
      idempotencyKey,
      requestFingerprint,
      reservationId: reservation.reservationId,
      response: result,
    })
  } catch (error) {
    if (options.releaseReservationAfterCompletionFailure) {
      try {
        await dependencies.idempotency.releaseIdempotency({
          ...actor,
          idempotencyKey,
          requestFingerprint,
          reservationId: reservation.reservationId,
        })
      } catch (releaseError) {
        console.error(
          'Failed to release an idempotency reservation after response persistence failed.',
          toSafePublicApiErrorLog(releaseError),
        )
      }
    }
    throw error
  }
  return respondIdempotent(c, result)
}

function respondIdempotent(
  c: Context,
  result: { status: 200 | 201 | 202 | 204; body: unknown },
) {
  if (result.status === 204) return c.body(null, 204)
  if (result.status === 202) return c.json(result.body, 202)
  if (result.status === 201) return c.json(result.body, 201)
  return c.json(result.body)
}

function createConnectorOAuthOperationId(
  workspaceId: string,
  idempotency: IdempotencyMutationToken,
) {
  return createHash('sha256')
    .update(
      `connector-oauth-operation-v1\0${workspaceId}\0${idempotency.credentialId}` +
      `\0${idempotency.idempotencyKey}\0${idempotency.requestFingerprint}`,
    )
    .digest('hex')
}

function toProblemResponse(c: Context, error: unknown, dependencies: PublicApiDependencies) {
  const normalized = normalizeError(error, dependencies)
  const retryAfter = c.res.headers.get('Retry-After') ??
    (normalized.status === 503 && normalized.retryable ? '5' : undefined)
  const problem: ApiProblem = {
    type: `https://docs.mukuroji.app/problems/${normalized.code}`,
    title: problemTitle(normalized.code),
    status: normalized.status,
    code: normalized.code,
    detail: normalized.message,
    instance: new URL(c.req.url).pathname,
    requestId: c.get('requestId'),
    retryable: normalized.retryable,
  }
  return new Response(JSON.stringify(problem), {
    status: normalized.status,
    headers: {
      'Content-Type': 'application/problem+json; charset=utf-8',
      'X-Request-Id': problem.requestId,
      ...(c.res.headers.get('Cache-Control')
        ? { 'Cache-Control': c.res.headers.get('Cache-Control')! }
        : {}),
      ...(c.res.headers.get('Pragma') ? { Pragma: c.res.headers.get('Pragma')! } : {}),
      ...(c.res.headers.get('Referrer-Policy')
        ? { 'Referrer-Policy': c.res.headers.get('Referrer-Policy')! }
        : {}),
      ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
      ...(c.res.headers.get('X-RateLimit-Limit') ? {
        'X-RateLimit-Limit': c.res.headers.get('X-RateLimit-Limit')!,
        'X-RateLimit-Remaining': c.res.headers.get('X-RateLimit-Remaining')!,
        'X-RateLimit-Reset': c.res.headers.get('X-RateLimit-Reset')!,
        'RateLimit-Limit': c.res.headers.get('RateLimit-Limit')!,
        'RateLimit-Remaining': c.res.headers.get('RateLimit-Remaining')!,
        'RateLimit-Reset': c.res.headers.get('RateLimit-Reset')!,
      } : {}),
    },
  })
}

function normalizeError(error: unknown, dependencies: PublicApiDependencies) {
  if (error instanceof PublicApiServiceError) return error
  if (error instanceof UnsafeWebhookUrlError) {
    return new PublicApiServiceError(400, 'validation_failed', error.message)
  }
  if (error instanceof DeveloperPlatformError) {
    return new PublicApiServiceError(
      error.status,
      mapDeveloperPlatformProblemCode(error.status, error.code),
      error.message,
      error.status >= 500,
    )
  }
  const mapped = dependencies.mapError?.(error)
  if (mapped) return mapped
  console.error('Public API request failed.', toSafePublicApiErrorLog(error))
  return new PublicApiServiceError(500, 'internal_error', 'An unexpected error occurred.', true)
}

function mapDeveloperPlatformProblemCode(status: number, code: string): ApiProblemCode {
  if (code.includes('Idempotency')) return 'idempotency_conflict'
  if (code.includes('Scope')) return 'insufficient_scope'
  if (status === 400) return 'validation_failed'
  if (status === 401) return 'invalid_credentials'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'temporarily_unavailable'
  return 'invalid_request'
}

function problemTitle(code: ApiProblemCode) {
  return code.split('_').map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join(' ')
}

function readBearerToken(authorization: string | undefined) {
  const token = (authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (!token) {
    throw new PublicApiServiceError(401, 'authentication_required', 'Bearer credential is required.')
  }
  return token
}

function readOAuthCallbackValue(
  value: string | undefined,
  label: string,
  maximumLength: number,
) {
  if (
    !value ||
    value !== value.trim() ||
    value.length > maximumLength ||
    containsAsciiControl(value, false)
  ) {
    throw new PublicApiServiceError(400, 'invalid_request', `${label} is invalid.`)
  }
  return value
}

function appendConnectorCallbackOutcome(
  returnUrl: string,
  outcome: 'connected' | 'cancelled',
) {
  const base = new URL('https://mukuroji.invalid')
  const resolved = new URL(returnUrl, base)
  if (resolved.origin !== base.origin || !returnUrl.startsWith('/')) {
    throw new PublicApiServiceError(
      503,
      'temporarily_unavailable',
      'Stored connector return URL is invalid.',
      true,
    )
  }
  resolved.searchParams.set('connectorOAuth', outcome)
  return `${resolved.pathname}${resolved.search}${resolved.hash}`
}

function readIdempotencyKey(value: string | undefined) {
  const key = value?.trim() ?? ''
  if (!key || key.length > 256 || containsAsciiControl(key, false)) {
    throw new PublicApiServiceError(
      400,
      'invalid_request',
      'Idempotency-Key must contain 1 to 256 characters without control characters.',
    )
  }
  return key
}

function readRequestId(value: string | undefined) {
  const requestId = value?.trim()
  return requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(requestId) ? requestId : undefined
}

function readRouteId(value: string, label: string) {
  const result = value.trim()
  if (
    !result ||
    result !== value ||
    result.length > 256 ||
    containsAsciiControl(result, false)
  ) {
    throw new PublicApiServiceError(400, 'invalid_request', `${label} is invalid.`)
  }
  return result
}

function readRequiredString(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 4_096 ||
    containsAsciiControl(value, true)
  ) {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} is required.`)
  }
  return value.trim()
}

function readOptionalString(value: unknown, label: string, maxLength = 4_096) {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    containsAsciiControl(value, true)
  ) {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} is invalid.`)
  }
  return value.trim() || undefined
}

function containsAsciiControl(value: string, allowTextWhitespace: boolean) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (
      codePoint === 0x7f ||
      (
        codePoint < 0x20 &&
        !(allowTextWhitespace && (codePoint === 0x09 || codePoint === 0x0a || codePoint === 0x0d))
      )
    ) {
      return true
    }
  }
  return false
}

function readPositiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} must be a positive integer.`)
  }
  return value as number
}

function readRequiredQuery(value: string | undefined, label: string) {
  return readRouteId(value ?? '', label)
}

function readCreatePublicWorkItemRequest(value: unknown): CreatePublicWorkItemRequest {
  const body = requireRecord(value, 'Work Item body is required.')
  assertAllowedFields(body, [
    'teamId',
    'title',
    'description',
    'assignedProjectId',
    'assigneeUserId',
    'workflowStatusId',
    'customFieldValues',
    'dueDate',
    'priority',
  ], 'Work Item body')
  const description = readOptionalString(body.description, 'description', 100_000)
  return {
    teamId: readIdentifier(body.teamId, 'teamId'),
    title: readRequiredString(body.title, 'title'),
    assigneeUserId: readIdentifier(body.assigneeUserId, 'assigneeUserId'),
    dueDate: readIsoDate(body.dueDate, 'dueDate'),
    priority: readPriority(body.priority),
    ...(description !== undefined ? { description } : {}),
    ...(body.assignedProjectId !== undefined
      ? { assignedProjectId: readIdentifier(body.assignedProjectId, 'assignedProjectId') }
      : {}),
    ...(body.workflowStatusId !== undefined
      ? { workflowStatusId: readIdentifier(body.workflowStatusId, 'workflowStatusId') }
      : {}),
    ...(body.customFieldValues !== undefined
      ? { customFieldValues: readCustomFieldValues(body.customFieldValues, false) }
      : {}),
  }
}

function readUpdatePublicWorkItemRequest(value: unknown): UpdatePublicWorkItemRequest {
  const body = requireRecord(value, 'Work Item patch is required.')
  assertAllowedFields(body, [
    'expectedRevision',
    'title',
    'description',
    'assignedProjectId',
    'assigneeUserId',
    'workflowStatusId',
    'customFieldValues',
    'dueDate',
    'priority',
  ], 'Work Item patch')
  const result: UpdatePublicWorkItemRequest = {
    expectedRevision: readPositiveInteger(body.expectedRevision, 'expectedRevision'),
  }
  if ('title' in body) result.title = readRequiredString(body.title, 'title')
  if ('description' in body) result.description = readRequiredString(body.description, 'description')
  if ('assignedProjectId' in body) {
    result.assignedProjectId = body.assignedProjectId === null
      ? null
      : readIdentifier(body.assignedProjectId, 'assignedProjectId')
  }
  if ('assigneeUserId' in body) {
    result.assigneeUserId = readIdentifier(body.assigneeUserId, 'assigneeUserId')
  }
  if ('workflowStatusId' in body) {
    result.workflowStatusId = readIdentifier(body.workflowStatusId, 'workflowStatusId')
  }
  if ('customFieldValues' in body) {
    result.customFieldValues = readCustomFieldValues(body.customFieldValues, true)
  }
  if ('dueDate' in body) result.dueDate = readIsoDate(body.dueDate, 'dueDate')
  if ('priority' in body) result.priority = readPriority(body.priority)
  if (Object.keys(result).length === 1) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      'Work Item patch must include at least one changed field.',
    )
  }
  return result
}

function readDeletePublicWorkItemRequest(value: unknown) {
  const body = requireRecord(value, 'Delete request is required.')
  assertAllowedFields(body, ['expectedRevision'], 'Delete request')
  return {
    expectedRevision: readPositiveInteger(body.expectedRevision, 'expectedRevision'),
  }
}

function readCreateApiKeyInput(value: unknown): CreateApiKeyInput {
  const body = requireRecord(value, 'API key input is required.')
  assertAllowedFields(body, ['name', 'scopes', 'expiresAt'], 'API key input')
  return {
    name: readRequiredString(body.name, 'API key name'),
    scopes: readApiScopes(body.scopes, 'API key scopes'),
    ...(body.expiresAt !== undefined
      ? { expiresAt: readFutureTimestamp(body.expiresAt, 'API key expiry') }
      : {}),
  }
}

function readCreateOAuthAppInput(value: unknown): CreateOAuthAppInput {
  const body = requireRecord(value, 'OAuth app input is required.')
  assertAllowedFields(
    body,
    ['name', 'grantTypes', 'scopes', 'expiresAt'],
    'OAuth app input',
  )
  const grantTypes = readOAuthGrantTypes(body.grantTypes)
  if (grantTypes.length !== 1 || grantTypes[0] !== 'client_credentials') {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      'Only the client_credentials OAuth grant type is supported.',
    )
  }
  return {
    name: readRequiredString(body.name, 'OAuth app name'),
    grantTypes,
    scopes: readApiScopes(body.scopes, 'OAuth app scopes'),
    ...(body.expiresAt === undefined
      ? {}
      : { expiresAt: readFutureTimestamp(body.expiresAt, 'OAuth app expiry') }),
  }
}

function readCreateWebhookSubscriptionInput(
  value: unknown,
): CreateWebhookSubscriptionInput {
  const body = requireRecord(value, 'Webhook input is required.')
  assertAllowedFields(body, ['name', 'url', 'teamIds', 'eventTypes', 'scopes'], 'Webhook input')
  return {
    name: readRequiredString(body.name, 'Webhook name'),
    url: readHttpsUrl(body.url, 'Webhook URL'),
    teamIds: readStringArray(body.teamIds, 'Webhook teamIds', 100)
      .map((teamId) => readIdentifier(teamId, 'Webhook Team ID')),
    eventTypes: readWebhookEventTypes(body.eventTypes),
    ...(body.scopes !== undefined
      ? { scopes: readApiScopes(body.scopes, 'Webhook scopes', true) }
      : {}),
  }
}

function readUpdateWebhookSubscriptionInput(
  value: unknown,
): UpdateWebhookSubscriptionInput {
  const body = requireRecord(value, 'Webhook subscription patch is required.')
  assertAllowedFields(
    body,
    ['name', 'url', 'eventTypes', 'scopes', 'status'],
    'Webhook subscription patch',
  )
  const result: UpdateWebhookSubscriptionInput = {}
  if ('name' in body) result.name = readRequiredString(body.name, 'Webhook name')
  if ('url' in body) result.url = readHttpsUrl(body.url, 'Webhook URL')
  if ('eventTypes' in body) result.eventTypes = readWebhookEventTypes(body.eventTypes)
  if ('scopes' in body) result.scopes = readApiScopes(body.scopes, 'Webhook scopes', true)
  if ('status' in body) {
    if (body.status !== 'active' && body.status !== 'paused' && body.status !== 'disabled') {
      throw new PublicApiServiceError(
        400,
        'validation_failed',
        'Webhook status is invalid.',
      )
    }
    result.status = body.status
  }
  requirePatchField(result, 'Webhook subscription patch')
  return result
}

function readExternalLinkInput(
  value: unknown,
  includeTeamId: true,
): ReturnType<typeof readExternalLinkFields> & { teamId: string }
function readExternalLinkInput(
  value: unknown,
  includeTeamId?: false,
): ReturnType<typeof readExternalLinkFields>
function readExternalLinkInput(value: unknown, includeTeamId = false) {
  const body = requireRecord(value, 'External link body is required.')
  assertAllowedFields(body, [
    ...(includeTeamId ? ['teamId'] : []),
    'installationId',
    'resourceType',
    'externalId',
    'externalUrl',
    'displayKey',
    'syncDirection',
  ], 'External link body')
  const fields = readExternalLinkFields(body)
  return includeTeamId
    ? { teamId: readIdentifier(body.teamId, 'teamId'), ...fields }
    : fields
}

function readExternalLinkFields(body: Record<string, unknown>) {
  const resourceType = readRequiredString(body.resourceType, 'resourceType')
  if (!['issue', 'merge-request', 'commit', 'deploy'].includes(resourceType)) {
    throw new PublicApiServiceError(400, 'validation_failed', 'resourceType is invalid.')
  }
  const syncDirection = readRequiredString(body.syncDirection, 'syncDirection')
  if (!['inbound', 'outbound', 'bidirectional', 'none'].includes(syncDirection)) {
    throw new PublicApiServiceError(400, 'validation_failed', 'syncDirection is invalid.')
  }
  return {
    installationId: readIdentifier(body.installationId, 'installationId'),
    resourceType: resourceType as 'issue' | 'merge-request' | 'commit' | 'deploy',
    externalId: readIdentifier(body.externalId, 'externalId'),
    externalUrl: readHttpsUrl(body.externalUrl, 'externalUrl'),
    ...(body.displayKey !== undefined
      ? { displayKey: readRequiredString(body.displayKey, 'displayKey') }
      : {}),
    syncDirection: syncDirection as 'inbound' | 'outbound' | 'bidirectional' | 'none',
  }
}

function readExternalLinkPatch(value: unknown) {
  const body = requireRecord(value, 'External link patch is required.')
  assertAllowedFields(body, ['syncDirection'], 'External link patch')
  const syncDirection = readRequiredString(body.syncDirection, 'syncDirection')
  if (!['inbound', 'outbound', 'bidirectional', 'none'].includes(syncDirection)) {
    throw new PublicApiServiceError(400, 'validation_failed', 'syncDirection is invalid.')
  }
  return {
    syncDirection: syncDirection as 'inbound' | 'outbound' | 'bidirectional' | 'none',
  }
}

function readConnectorProvider(value: unknown): ConnectorProvider {
  const provider = readIdentifier(value, 'Connector provider')
  const providers = new Set<ConnectorProvider>([
    'github',
    'gitlab',
    'slack',
    'microsoft-teams',
    'gmail',
    'outlook',
    'google-calendar',
    'outlook-calendar',
    'google-drive',
    'onedrive',
    'dropbox',
  ])
  if (!providers.has(provider as ConnectorProvider)) {
    throw new PublicApiServiceError(400, 'validation_failed', 'Connector provider is invalid.')
  }
  return provider as ConnectorProvider
}

function readConnectorAuthorizationInput(value: unknown): CreateConnectorInstallationInput {
  const body = requireRecord(value, 'Connector authorization input is required.')
  assertAllowedFields(
    body,
    ['provider', 'name', 'scopes', 'returnUrl'],
    'Connector authorization input',
  )
  return {
    provider: readConnectorProvider(body.provider),
    name: readRequiredString(body.name, 'Connector name'),
    scopes: readStringArray(body.scopes, 'Connector scopes', 100, true),
    returnUrl: readApplicationRelativeUrl(body.returnUrl, 'Connector returnUrl'),
  }
}

function readSyncConflictResolution(value: unknown): ResolveWorkItemSyncConflictInput {
  const body = requireRecord(value, 'Sync-conflict resolution is required.')
  assertAllowedFields(body, ['resolution', 'mergedValues'], 'Sync-conflict resolution')
  const resolution = readRequiredString(body.resolution, 'Sync-conflict resolution')
  if (!['use-local', 'use-external', 'merge', 'ignore'].includes(resolution)) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      'Sync-conflict resolution is invalid.',
    )
  }
  const mergedValues = resolution === 'merge'
    ? requireRecord(body.mergedValues, 'mergedValues is required for merge resolution.')
    : undefined
  if (resolution !== 'merge' && body.mergedValues !== undefined) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      'mergedValues is only valid for merge resolution.',
    )
  }
  return {
    resolution: resolution as ResolveWorkItemSyncConflictInput['resolution'],
    ...(mergedValues === undefined ? {} : { mergedValues }),
  }
}

function readSyncConflictStatus(value: string | undefined) {
  if (value === undefined) return undefined
  if (value === 'open' || value === 'resolved' || value === 'ignored') return value
  throw new PublicApiServiceError(400, 'invalid_request', 'Sync conflict status is invalid.')
}

function readPublicImportSourceInput(value: unknown): PublicImportSourceInput {
  const body = requireRecord(value, 'Import source is required.')
  assertAllowedFields(body, [
    'format',
    'source',
    'teamId',
    'assignedProjectId',
    'mapping',
  ], 'Import source')
  const format = body.format
  if (format !== 'csv' && format !== 'json') {
    throw new PublicApiServiceError(400, 'validation_failed', 'Import format is invalid.')
  }
  const sourceBody = requireRecord(body.source, 'Import source file is required.')
  assertAllowedFields(
    sourceBody,
    ['fileName', 'mediaType', 'content'],
    'Import source file',
  )
  const expectedMediaType = format === 'csv' ? 'text/csv' : 'application/json'
  if (sourceBody.mediaType !== expectedMediaType) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      `Import source mediaType must be ${expectedMediaType} for ${format}.`,
    )
  }
  if (!Array.isArray(body.mapping) || body.mapping.length === 0 || body.mapping.length > 200) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      'Import mapping must contain between 1 and 200 fields.',
    )
  }
  const sourceFields = new Set<string>()
  const targetFields = new Set<string>()
  const mapping = body.mapping.map((value, index) => {
    const field = requireRecord(value, `Import mapping ${index + 1} is invalid.`)
    assertAllowedFields(
      field,
      ['sourceField', 'targetField', 'transform', 'required', 'defaultValue'],
      `Import mapping ${index + 1}`,
    )
    const sourceField = readRequiredString(field.sourceField, 'Import sourceField')
    const targetField = readRequiredString(field.targetField, 'Import targetField')
    if (sourceFields.has(sourceField) || targetFields.has(targetField)) {
      throw new PublicApiServiceError(
        400,
        'validation_failed',
        'Import source and target fields must be unique.',
      )
    }
    sourceFields.add(sourceField)
    targetFields.add(targetField)
    const transform = field.transform === undefined
      ? undefined
      : readImportTransform(field.transform)
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      throw new PublicApiServiceError(
        400,
        'validation_failed',
        `Import mapping ${index + 1} required must be a boolean.`,
      )
    }
    return {
      sourceField,
      targetField,
      ...(transform ? { transform } : {}),
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.defaultValue === undefined ? {} : { defaultValue: field.defaultValue }),
    }
  })
  return {
    format,
    source: {
      fileName: readImportFileName(sourceBody.fileName),
      mediaType: expectedMediaType,
      content: readImportContent(sourceBody.content),
    },
    teamId: readIdentifier(body.teamId, 'Import teamId'),
    ...(body.assignedProjectId !== undefined
      ? { assignedProjectId: readIdentifier(body.assignedProjectId, 'assignedProjectId') }
      : {}),
    mapping,
  }
}

function readExportFormat(value: string | undefined) {
  if (value === 'csv' || value === undefined) return 'csv' as const
  if (value === 'json') return 'json' as const
  throw new PublicApiServiceError(400, 'invalid_request', 'Export format must be csv or json.')
}

function readImportTransform(value: unknown): NonNullable<ImportFieldMapping['transform']> {
  if (
    value === 'none' ||
    value === 'trim' ||
    value === 'lowercase' ||
    value === 'uppercase' ||
    value === 'parse-date' ||
    value === 'parse-number' ||
    value === 'split-comma'
  ) {
    return value
  }
  throw new PublicApiServiceError(400, 'validation_failed', 'Import transform is invalid.')
}

function readImportFileName(value: unknown) {
  const fileName = readRequiredString(value, 'Import fileName')
  if (
    fileName.length > 255 ||
    fileName === '.' ||
    fileName === '..' ||
    fileName.includes('/') ||
    fileName.includes('\\')
  ) {
    throw new PublicApiServiceError(400, 'validation_failed', 'Import fileName is invalid.')
  }
  return fileName
}

function readImportContent(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 2 * 1024 * 1024 ||
    value.includes('\u0000')
  ) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      'Import content must contain between 1 byte and 2 MiB of UTF-8 text.',
    )
  }
  return value
}

function readIdentifier(value: unknown, label: string) {
  const identifier = readRequiredString(value, label)
  if (
    identifier.length > 256 ||
    !/^[\p{Letter}\p{Number}][\p{Letter}\p{Number}._:/@+-]*$/u.test(identifier)
  ) {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} is invalid.`)
  }
  return identifier
}

function readIsoDate(value: unknown, label: string) {
  if (typeof value !== 'string') {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} must be an ISO date.`)
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  const parsed = match ? new Date(`${value}T00:00:00.000Z`) : undefined
  if (
    !match ||
    !parsed ||
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCFullYear() !== Number(match[1]) ||
    parsed.getUTCMonth() + 1 !== Number(match[2]) ||
    parsed.getUTCDate() !== Number(match[3])
  ) {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} must be an ISO date.`)
  }
  return value
}

function readIsoTimestamp(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/u.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      `${label} must be an ISO timestamp.`,
    )
  }
  return new Date(value).toISOString()
}

function readPriority(value: unknown) {
  if (value === 'high' || value === 'medium' || value === 'low') return value
  throw new PublicApiServiceError(
    400,
    'validation_failed',
    'priority must be high, medium, or low.',
  )
}

function readCustomFieldValues(
  value: unknown,
  nullable: false,
): NonNullable<CreatePublicWorkItemRequest['customFieldValues']>
function readCustomFieldValues(
  value: unknown,
  nullable: true,
): NonNullable<UpdatePublicWorkItemRequest['customFieldValues']>
function readCustomFieldValues(value: unknown, nullable: boolean) {
  const record = requireRecord(value, 'customFieldValues must be an object.')
  if (Object.keys(record).length > 200) {
    throw new PublicApiServiceError(400, 'validation_failed', 'Too many custom field values.')
  }
  const result: Record<string, string | number | boolean | string[] | null> = {}
  for (const [fieldId, fieldValue] of Object.entries(record)) {
    readIdentifier(fieldId, 'Custom field ID')
    if (fieldValue === null && nullable) {
      result[fieldId] = null
      continue
    }
    if (
      typeof fieldValue !== 'string' &&
      typeof fieldValue !== 'number' &&
      typeof fieldValue !== 'boolean' &&
      !(Array.isArray(fieldValue) &&
        fieldValue.length <= 100 &&
        fieldValue.every((entry) => typeof entry === 'string'))
    ) {
      throw new PublicApiServiceError(
        400,
        'validation_failed',
        `Custom field "${fieldId}" has an invalid value.`,
      )
    }
    result[fieldId] = fieldValue
  }
  return result as NonNullable<UpdatePublicWorkItemRequest['customFieldValues']>
}

function readApiScopes(value: unknown, label: string, allowEmpty = false): ApiScope[] {
  const scopes = readStringArray(value, label, 20, allowEmpty)
  const allowed = new Set<ApiScope>([
    'work-items:read',
    'work-items:write',
    'work-items:delete',
    'webhooks:read',
    'webhooks:write',
    'integrations:read',
    'integrations:write',
    'imports:read',
    'imports:write',
  ])
  if (!scopes.every((scope) => allowed.has(scope as ApiScope))) {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} contains an invalid scope.`)
  }
  return scopes as ApiScope[]
}

function readOAuthGrantTypes(
  value: unknown,
  allowEmpty = false,
): CreateOAuthAppInput['grantTypes'] {
  const grantTypes = readStringArray(value, 'OAuth grantTypes', 3, allowEmpty)
  if (!grantTypes.every((grantType) => grantType === 'client_credentials')) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      'OAuth grantTypes contains an invalid grant type.',
    )
  }
  return grantTypes as CreateOAuthAppInput['grantTypes']
}

function readWebhookEventTypes(
  value: unknown,
): CreateWebhookSubscriptionInput['eventTypes'] {
  const eventTypes = readStringArray(value, 'Webhook eventTypes', 20)
  const allowed = new Set<CreateWebhookSubscriptionInput['eventTypes'][number]>([
    'work-item.created',
    'work-item.updated',
    'work-item.deleted',
    'external-link.created',
    'external-link.updated',
    'sync-conflict.created',
    'sync-conflict.resolved',
    'import.completed',
    'import.failed',
  ])
  if (!eventTypes.every((eventType) =>
    allowed.has(eventType as CreateWebhookSubscriptionInput['eventTypes'][number])
  )) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      'Webhook eventTypes contains an unsupported event.',
    )
  }
  return eventTypes as CreateWebhookSubscriptionInput['eventTypes']
}

function readStringArray(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
) {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} is invalid.`)
  }
  const values = value.map((entry) => readRequiredString(entry, label))
  if (new Set(values).size !== values.length) {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} must be unique.`)
  }
  return values
}

function readApplicationRelativeUrl(value: unknown, label: string) {
  const path = readRequiredString(value, label)
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    /[\r\n]/u.test(path)
  ) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      `${label} must be an application-relative path.`,
    )
  }
  return path
}

function readHttpsUrl(value: unknown, label: string) {
  const text = readRequiredString(value, label)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} is invalid.`)
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new PublicApiServiceError(400, 'validation_failed', `${label} must be a safe HTTPS URL.`)
  }
  return url.toString()
}

function readFutureTimestamp(value: unknown, label: string) {
  const text = readRequiredString(value, label)
  const timestamp = Date.parse(text)
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      `${label} must be a future ISO timestamp.`,
    )
  }
  return new Date(timestamp).toISOString()
}

function requirePatchField(value: Record<string, unknown>, label: string) {
  if (Object.keys(value).length === 0) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      `${label} must include at least one changed field.`,
    )
  }
}

function assertAllowedFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const allowedFields = new Set(allowed)
  const unknownField = Object.keys(value).find((field) => !allowedFields.has(field))
  if (unknownField) {
    throw new PublicApiServiceError(
      400,
      'validation_failed',
      `${label} contains unknown field "${unknownField}".`,
    )
  }
}

function readPageLimit(value: string | undefined) {
  if (value === undefined) return PUBLIC_API_DEFAULT_PAGE_SIZE
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > PUBLIC_API_MAX_PAGE_SIZE) {
    throw new PublicApiServiceError(
      400,
      'invalid_request',
      `limit must be between 1 and ${PUBLIC_API_MAX_PAGE_SIZE}.`,
    )
  }
  return limit
}

function readWorkItemFilters(c: Context) {
  const teamId = readRequiredQuery(c.req.query('teamId'), 'teamId')
  const assignedProjectId = c.req.query('assignedProjectId')
  const assigneeUserId = c.req.query('assigneeUserId')
  const workflowStatusId = c.req.query('workflowStatusId')
  const updatedAfter = c.req.query('updatedAfter')
  return {
    teamId,
    ...(assignedProjectId
      ? { assignedProjectId: readIdentifier(assignedProjectId, 'assignedProjectId') }
      : {}),
    ...(assigneeUserId
      ? { assigneeUserId: readIdentifier(assigneeUserId, 'assigneeUserId') }
      : {}),
    ...(workflowStatusId
      ? { workflowStatusId: readIdentifier(workflowStatusId, 'workflowStatusId') }
      : {}),
    ...(updatedAfter
      ? { updatedAfter: readIsoTimestamp(updatedAfter, 'updatedAfter') }
      : {}),
  }
}

async function readJson(c: Context) {
  try {
    return await c.req.json<unknown>()
  } catch {
    throw new PublicApiServiceError(400, 'invalid_request', 'Request body must be valid JSON.')
  }
}

async function readOAuthTokenInput(c: Context) {
  const contentType = c.req.header('Content-Type') ?? ''
  if (!contentType.includes('application/x-www-form-urlencoded')) {
    throw new PublicApiServiceError(
      415,
      'invalid_request',
      'OAuth token requests must use application/x-www-form-urlencoded.',
    )
  }
  const params = new URLSearchParams(await c.req.text())
  const body = Object.fromEntries(params.entries())
  assertAllowedFields(
    body,
    ['grant_type', 'client_id', 'client_secret', 'scope'],
    'OAuth token input',
  )
  const scope = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : []
  return {
    grantType: readRequiredString(body.grant_type, 'grant_type'),
    clientId: readRequiredString(body.client_id, 'client_id'),
    clientSecret: readRequiredString(body.client_secret, 'client_secret'),
    scopes: readApiScopes(scope, 'OAuth scopes', true),
  }
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PublicApiServiceError(400, 'invalid_request', message)
  }
  return value as Record<string, unknown>
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function createFilterFingerprint(filters: Record<string, string | number | undefined>) {
  return createHash('sha256').update(stableStringify(filters)).digest('base64url')
}

function requireResourceCreator<T extends { createdByUserId: string }>(
  resource: T | undefined,
  actorUserId: string,
  label: string,
) {
  if (!resource) {
    throw new PublicApiServiceError(404, 'not_found', `${label} was not found.`)
  }
  if (resource.createdByUserId !== actorUserId) {
    throw new PublicApiServiceError(
      403,
      'forbidden',
      `Only the ${label} creator can perform this operation.`,
    )
  }
  return resource
}

async function requireWebhookSubscriptionCreator(
  platform: WebhookSubscriptionPort,
  principal: DeveloperManagementPrincipal,
  subscriptionId: string,
) {
  const subscription = (await platform.listWebhookSubscriptions(principal.workspaceId))
    .find((candidate) => candidate.id === subscriptionId)
  return requireResourceCreator(
    subscription,
    principal.userId,
    'Webhook subscription',
  )
}

function managementCursorScope(
  principal: DeveloperManagementPrincipal,
  resource: string,
  filters: Record<string, string | number | undefined> = {},
) {
  return {
    workspaceId: principal.workspaceId,
    actorId: `management:${principal.userId}`,
    resource,
    filters,
  }
}

function createSignedKeysetPage<T extends { id: string }>(
  c: Context,
  dependencies: PublicApiDependencies,
  scope: {
    workspaceId: string
    actorId: string
    resource: string
    filters: Record<string, string | number | undefined>
  },
  values: readonly T[],
  getTimestamp: (value: T) => string,
) {
  const limit = readPageLimit(c.req.query('limit'))
  const fingerprint = createFilterFingerprint(scope.filters)
  const cursor = c.req.query('cursor')
    ? readCursor(c.req.query('cursor')!, dependencies.cursorSecret, {
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        resource: scope.resource,
        fingerprint,
        limit,
        kind: 'keyset',
      }, dependencies.now?.() ?? new Date())
    : undefined
  const ordered = [...values].sort((left, right) =>
    getTimestamp(right).localeCompare(getTimestamp(left)) ||
    right.id.localeCompare(left.id)
  )
  const eligible = cursor
    ? ordered.filter((value) =>
        getTimestamp(value).localeCompare(cursor.positionTimestamp!) < 0 ||
        (
          getTimestamp(value) === cursor.positionTimestamp &&
          value.id.localeCompare(cursor.positionId!) < 0
        )
      )
    : ordered
  const items = eligible.slice(0, limit)
  const hasMore = items.length < eligible.length
  const lastItem = items.at(-1)
  return {
    items,
    hasMore,
    ...(hasMore && lastItem
      ? {
          nextCursor: createCursor(dependencies.cursorSecret, {
            version: 3,
            kind: 'keyset',
            workspaceId: scope.workspaceId,
            actorId: scope.actorId,
            resource: scope.resource,
            fingerprint,
            limit,
            positionTimestamp: getTimestamp(lastItem),
            positionId: lastItem.id,
            expiresAt: Math.floor(
              (dependencies.now?.() ?? new Date()).getTime() / 1_000,
            ) + PUBLIC_API_CURSOR_TTL_SECONDS,
          }),
        }
      : {}),
  }
}

async function createSignedContinuationPage<T extends { id: string }>(
  c: Context,
  dependencies: PublicApiDependencies,
  scope: {
    workspaceId: string
    actorId: string
    resource: string
    filters: Record<string, string | number | undefined>
  },
  loadPage: (
    continuation: string | undefined,
    limit: number,
  ) => Promise<{
    items: T[]
    hasMore: boolean
    nextContinuation?: string
  }>,
  getTimestamp: (value: T) => string,
) {
  const limit = readPageLimit(c.req.query('limit'))
  const fingerprint = createFilterFingerprint(scope.filters)
  const cursor = c.req.query('cursor')
    ? readCursor(c.req.query('cursor')!, dependencies.cursorSecret, {
        workspaceId: scope.workspaceId,
        actorId: scope.actorId,
        resource: scope.resource,
        fingerprint,
        limit,
        kind: 'continuation',
      }, dependencies.now?.() ?? new Date())
    : undefined
  const page = await loadPage(cursor?.continuation, limit)
  if (page.hasMore !== (page.nextContinuation !== undefined)) {
    throw new PublicApiServiceError(
      503,
      'temporarily_unavailable',
      'List continuation state is invalid.',
      true,
    )
  }
  const items = [...page.items].sort((left, right) =>
    getTimestamp(right).localeCompare(getTimestamp(left)) ||
    right.id.localeCompare(left.id)
  )
  return {
    items,
    hasMore: page.hasMore,
    ...(page.nextContinuation
      ? {
          nextCursor: createCursor(dependencies.cursorSecret, {
            version: 3,
            kind: 'continuation',
            workspaceId: scope.workspaceId,
            actorId: scope.actorId,
            resource: scope.resource,
            fingerprint,
            limit,
            continuation: page.nextContinuation,
            expiresAt: Math.floor(
              (dependencies.now?.() ?? new Date()).getTime() / 1_000,
            ) + PUBLIC_API_CURSOR_TTL_SECONDS,
          }),
        }
      : {}),
  }
}

/** Public/management list cursor の署名 payload です。 */
type SignedCursor = {
  /** Cursor schema version です。 */
  version: 3
  /** Keyset page または downstream continuation の cursor 種別です。 */
  kind: 'keyset' | 'continuation'
  /** Cursor を束縛する Workspace ID です。 */
  workspaceId: string
  /** Cursor を束縛する credential または management user ID です。 */
  actorId: string
  /** Cursor を発行した canonical route/resource です。 */
  resource: string
  /** Filter set の fingerprint です。 */
  fingerprint: string
  /** Cursor を発行した page limit です。 */
  limit: number
  /** 次 page の直前にある resource の timestamp です。 */
  positionTimestamp?: string
  /** 次 page の直前にある resource ID です。 */
  positionId?: string
  /** Downstream store が発行した opaque continuation です。 */
  continuation?: string
  /** Cursor を利用できる期限の Unix epoch seconds です。 */
  expiresAt: number
}

function createCursor(secret: string, cursor: SignedCursor) {
  const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function readCursor(
  cursor: string,
  secret: string,
  scope: Pick<
    SignedCursor,
    'kind' | 'workspaceId' | 'actorId' | 'resource' | 'fingerprint' | 'limit'
  >,
  now: Date,
) {
  const [payload, signature, extra] = cursor.split('.')
  if (!payload || !signature || extra) throw invalidCursor()
  const expected = Buffer.from(createHmac('sha256', secret).update(payload).digest('base64url'))
  const received = Buffer.from(signature)
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw invalidCursor()
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    throw invalidCursor()
  }
  const value = requireRecord(parsed, 'Cursor is invalid.')
  if (
    value.version !== 3 ||
    value.kind !== scope.kind ||
    value.workspaceId !== scope.workspaceId ||
    value.actorId !== scope.actorId ||
    value.resource !== scope.resource ||
    value.fingerprint !== scope.fingerprint ||
    value.limit !== scope.limit ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= Math.floor(now.getTime() / 1_000) ||
    (
      scope.kind === 'keyset' &&
      (
        typeof value.positionTimestamp !== 'string' ||
        value.positionTimestamp.length === 0 ||
        value.positionTimestamp.length > 128 ||
        typeof value.positionId !== 'string' ||
        value.positionId.length === 0 ||
        value.positionId.length > 512 ||
        value.continuation !== undefined
      )
    ) ||
    (
      scope.kind === 'continuation' &&
      (
        value.positionTimestamp !== undefined ||
        value.positionId !== undefined ||
        typeof value.continuation !== 'string' ||
        value.continuation.length === 0 ||
        value.continuation.length > 8_192
      )
    )
  ) throw invalidCursor()
  return value as SignedCursor
}

function invalidCursor() {
  return new PublicApiServiceError(400, 'invalid_request', 'Cursor is invalid or belongs to another scope.')
}

function requireStoredResponse(value: unknown) {
  const response = requireRecord(value, 'Stored idempotency response is invalid.')
  if (
    response.status !== 200 &&
    response.status !== 201 &&
    response.status !== 202 &&
    response.status !== 204
  ) {
    throw new PublicApiServiceError(503, 'temporarily_unavailable', 'Stored idempotency response is invalid.', true)
  }
  if (!('body' in response)) {
    throw new PublicApiServiceError(
      503,
      'temporarily_unavailable',
      'Stored idempotency response is invalid.',
      true,
    )
  }
  return response as { status: 200 | 201 | 202 | 204; body: unknown }
}
