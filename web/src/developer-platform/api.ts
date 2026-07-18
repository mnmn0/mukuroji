import type {
  ApiKeySummary,
  ApiScope,
  ConnectorAuthorizationOutput,
  ConnectorInstallation,
  CreateExternalWorkItemLinkInput,
  CreateImportDryRunInput,
  CursorPage,
  DeveloperPlatformCapabilities as ContractDeveloperPlatformCapabilities,
  DeveloperPlatformOverview,
  ExternalWorkItemLink,
  ImportDryRunReport,
  ImportJob,
  OAuthAppSummary,
  SyncConflictStatus,
  UpdateExternalWorkItemLinkInput,
  WebhookDelivery,
  WebhookSubscription,
  WorkItem,
  WorkItemSyncConflict,
} from '@mukuroji/contracts'
import {
  createMutationHeaders,
  type MutationRequestContext,
} from '../api/mutationHeaders'

/**
 * Developer Platform の管理画面で許可された操作です。
 */
export type DeveloperPlatformCapabilities =
  ContractDeveloperPlatformCapabilities

/**
 * Developer Platform 管理画面の aggregate response です。
 */
export type DeveloperPlatformResources = DeveloperPlatformOverview

/**
 * API key 作成 API の入力です。
 */
export type CreateDeveloperApiKeyInput = {
  /**
   * 管理画面で識別する API key 名です。
   */
  name: string
  /**
   * API key に付与する最小権限 scope です。
   */
  scopes: ApiScope[]
  /**
   * API key の有効期限を表す ISO 8601 timestamp です。
   */
  expiresAt?: string
}

/**
 * API key 作成または rotation 直後だけ返す one-time secret です。
 */
export type IssuedApiKeySecret = {
  /**
   * 発行後の API key metadata です。
   */
  apiKey: ApiKeySummary
  /**
   * 一度だけ表示可能な API key secret です。
   */
  secret: string
}

/**
 * 現在 Developer Platform で提供する OAuth app の grant type です。
 */
export type DeveloperOAuthGrantType = Extract<
  OAuthAppSummary['grantTypes'][number],
  'client_credentials'
>

/**
 * OAuth app 作成 API の入力です。
 */
export type CreateDeveloperOAuthAppInput = {
  /**
   * 管理画面と consent 画面に表示する app 名です。
   */
  name: string
  /** OAuth app が使用する grant type 一覧です。 */
  grantTypes: DeveloperOAuthGrantType[]
  /**
   * OAuth app に付与する API scope 一覧です。
   */
  scopes: ApiScope[]
  /**
   * OAuth app credential の有効期限を表す ISO 8601 timestamp です。
   */
  expiresAt?: string
}

/**
 * OAuth app 作成または rotation 直後だけ返す one-time client secret です。
 */
export type IssuedOAuthClientSecret = {
  /**
   * 発行後の OAuth app metadata です。
   */
  oauthApp: OAuthAppSummary
  /**
   * 一度だけ表示可能な OAuth client secret です。
   */
  clientSecret: string
}

/**
 * Webhook subscription が購読できる event type です。
 */
export type DeveloperWebhookEventType = WebhookSubscription['eventTypes'][number]

/**
 * Webhook subscription 作成 API の入力です。
 */
export type CreateDeveloperWebhookInput = {
  /**
   * 管理画面で識別する subscription 名です。
   */
  name: string
  /**
   * Signed webhook を送信する HTTPS URL です。
   */
  url: string
  /**
   * 作成者が現在参照でき、event payload の配信を許可する Team ID 一覧です。
   */
  teamIds: string[]
  /**
   * 配信対象 event type 一覧です。
   */
  eventTypes: DeveloperWebhookEventType[]
  /**
   * Webhook payload に許可する scope 一覧です。
   */
  scopes: ApiScope[]
}

/**
 * Webhook subscription 作成または signing secret rotation 直後の response です。
 */
export type IssuedWebhookSigningSecret = {
  /**
   * 発行後の webhook subscription metadata です。
   */
  subscription: WebhookSubscription
  /**
   * 一度だけ表示可能な webhook signing secret です。
   */
  signingSecret: string
}

/**
 * Connector provider identifier です。
 */
export type DeveloperConnectorProvider = ConnectorInstallation['provider']

/**
 * Connector の新規接続入力です。
 */
export type ConnectDeveloperConnectorInput = {
  /**
   * 管理画面で識別する installation 名です。
   */
  name: string
  /**
   * Connector に許可する scope 一覧です。
   */
  scopes: string[]
  /**
   * OAuth 完了後に戻る application-relative URL です。
   */
  returnUrl?: string
}

/**
 * Connector 競合の解決方針です。
 */
export type DeveloperSyncConflictResolution =
  | 'keep-local'
  | 'keep-remote'
  | 'merge'
  | 'ignore'

/**
 * Work Item 同期競合を解決する入力です。
 */
export type ResolveDeveloperSyncConflictInput = {
  /**
   * 一覧 API が返した同期競合 ID です。
   */
  conflictId: string
  /**
   * 競合した変更を収束させる方針です。
   */
  resolution: DeveloperSyncConflictResolution
  /**
   * Merge 解決で field ごとに採用する JSON value です。
   */
  mergedValues?: Record<string, unknown>
}

/**
 * Work Item 外部 link 一覧の cursor pagination 入力です。
 */
export type ListDeveloperExternalLinksInput = {
  /**
   * 前 response が返した opaque cursor です。
   */
  cursor?: string
  /**
   * 一度に取得する最大件数です。
   */
  limit?: number
}

/**
 * Work Item 同期競合一覧の filter と pagination 入力です。
 */
export type ListDeveloperSyncConflictsInput = {
  /**
   * 表示する同期競合の解決状態です。
   */
  status?: SyncConflictStatus
  /**
   * 前 response が返した opaque cursor です。
   */
  cursor?: string
  /**
   * 一度に取得する最大件数です。
   */
  limit?: number
}

/**
 * Import の source field と Work Item field の対応です。
 */
export type DeveloperImportFieldMapping = ImportJob['mapping'][number]

/**
 * Import source format です。
 */
export type DeveloperImportFormat = ImportJob['format']

/**
 * Import dry-run API の入力です。
 */
export type DryRunDeveloperImportInput = CreateImportDryRunInput

/**
 * Export 可能な Work Item format です。
 */
export type DeveloperExportFormat = 'csv' | 'json'

/**
 * Work Item export response と download metadata です。
 */
export type DeveloperExportFile = {
  /**
   * Browser download に渡す response body です。
   */
  blob: Blob
  /**
   * UI が export 日と format から生成した file 名です。
   */
  fileName: string
}

/**
 * Developer Platform API の失敗を status code と安定 code 付きで保持します。
 */
export class DeveloperPlatformApiError extends Error {
  /**
   * API response の HTTP status code です。
   */
  readonly status: number

  /**
   * API が返した機械判定用 error code です。
   */
  readonly code?: string

  /**
   * 同じ idempotency key で安全に再試行すべき失敗かどうかです。
   */
  readonly retryable: boolean

  /** API が指定した再試行待機秒数です。 */
  readonly retryAfterSeconds?: number

  /**
   * Developer Platform API error を作成します。
   *
   * @param status API response の HTTP status code です。
   * @param message ユーザーへ表示できる secret-safe message です。
   * @param code API が返した機械判定用 error code です。
   * @param retryable 同じ logical mutation として再試行できるかどうかです。
   * @param retryAfterSeconds API が Retry-After で指定した待機秒数です。
   */
  constructor(
    status: number,
    message: string,
    code?: string,
    retryable = false,
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'DeveloperPlatformApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * Developer Platform mutation の idempotency context を retry まで保持するか判定します。
 *
 * Transport failure と retryable な Problem Details response は、server 側で mutation が
 * commit 済みか判別できないため同じ context を再利用します。
 *
 * @param error mutation request が返した error です。
 * @returns 同じ logical mutation context を保持する場合は true です。
 */
export function shouldRetainDeveloperPlatformMutationContext(error: unknown) {
  return !(error instanceof DeveloperPlatformApiError) || error.retryable
}

const developerApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_WORKSPACE_API_BASE_URL ??
    import.meta.env.VITE_API_BASE_URL ??
    '/api',
)
const defaultDeveloperApiErrorMessage =
  'Unable to complete the Developer Platform request.'

/**
 * Developer Platform 管理画面の aggregate resource を取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param signal - 画面遷移時に request を中止する AbortSignal です。
 * @returns Developer Platform の resource と capabilities です。
 */
export function getDeveloperPlatformResources(
  accessToken: string,
  signal?: AbortSignal,
) {
  return requestJson<DeveloperPlatformResources>('/developer', accessToken, {
    signal,
  })
}

/**
 * Scoped API key を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - API key 名、scope、有効期限です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 一度だけ表示できる secret と API key metadata です。
 */
export function createDeveloperApiKey(
  accessToken: string,
  input: CreateDeveloperApiKeyInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedApiKeySecret>(
    '/developer/api-keys',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * API key secret を rotation します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param apiKeyId - Rotation 対象 API key ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 新しい one-time secret と API key metadata です。
 */
export function rotateDeveloperApiKey(
  accessToken: string,
  apiKeyId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedApiKeySecret>(
    `/developer/api-keys/${encodeURIComponent(apiKeyId)}/rotate`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

/**
 * API key を revoke します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param apiKeyId - Revoke 対象 API key ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Revoke 後の API key metadata です。
 */
export function revokeDeveloperApiKey(
  accessToken: string,
  apiKeyId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ApiKeySummary>(
    `/developer/api-keys/${encodeURIComponent(apiKeyId)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

/**
 * OAuth app を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - App metadata、server-to-server grant、scope です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns OAuth app と一度だけ表示できる client secret です。
 */
export function createDeveloperOAuthApp(
  accessToken: string,
  input: CreateDeveloperOAuthAppInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedOAuthClientSecret>(
    '/developer/oauth-apps',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * OAuth client secret を rotation します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param oauthAppId - Rotation 対象 OAuth app ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 新しい one-time client secret と OAuth app metadata です。
 */
export function rotateDeveloperOAuthApp(
  accessToken: string,
  oauthAppId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedOAuthClientSecret>(
    `/developer/oauth-apps/${encodeURIComponent(oauthAppId)}/rotate-secret`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

/**
 * OAuth app を revoke します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param oauthAppId - Revoke 対象 OAuth app ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Revoke 後の OAuth app metadata です。
 */
export function revokeDeveloperOAuthApp(
  accessToken: string,
  oauthAppId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<OAuthAppSummary>(
    `/developer/oauth-apps/${encodeURIComponent(oauthAppId)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

/**
 * Signed webhook subscription を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - 配信先 URL、event、scope です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Subscription と一度だけ表示できる signing secret です。
 */
export function createDeveloperWebhook(
  accessToken: string,
  input: CreateDeveloperWebhookInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedWebhookSigningSecret>(
    '/developer/webhook-subscriptions',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * Webhook signing secret を rotation します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param subscriptionId - Rotation 対象 subscription ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 新しい one-time signing secret と subscription metadata です。
 */
export function rotateDeveloperWebhook(
  accessToken: string,
  subscriptionId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<IssuedWebhookSigningSecret>(
    `/developer/webhook-subscriptions/${encodeURIComponent(subscriptionId)}/rotate-secret`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

/**
 * Webhook subscription を revoke します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param subscriptionId - Revoke 対象 subscription ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Revoke 後の subscription metadata です。
 */
export function revokeDeveloperWebhook(
  accessToken: string,
  subscriptionId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<Record<string, never>>(
    `/developer/webhook-subscriptions/${encodeURIComponent(subscriptionId)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
    true,
  )
}

/**
 * 失敗した webhook delivery を replay します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param deliveryId - Replay 対象 delivery ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Replay request 後の delivery metadata です。
 */
export function replayDeveloperWebhookDelivery(
  accessToken: string,
  deliveryId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<WebhookDelivery>(
    `/developer/webhook-deliveries/${encodeURIComponent(deliveryId)}/replay`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

/**
 * Provider connector を新規接続します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param provider - 接続対象 provider identifier です。
 * @param input - Installation 名と許可 scope です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Provider authorization URL と短命 state です。
 */
export function connectDeveloperConnector(
  accessToken: string,
  provider: DeveloperConnectorProvider,
  input: ConnectDeveloperConnectorInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ConnectorAuthorizationOutput>(
    '/developer/connector-installations',
    accessToken,
    createJsonMutation(
      'POST',
      {
        ...input,
        provider,
        returnUrl: input.returnUrl ?? '/',
      },
      mutationContext,
    ),
  )
}

/**
 * Connector の再認証 flow を開始します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param installationId - 再認証対象 installation ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Provider authorization URL と短命 state です。
 */
export function reauthorizeDeveloperConnector(
  accessToken: string,
  installationId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ConnectorAuthorizationOutput>(
    `/developer/connector-installations/${encodeURIComponent(installationId)}/reauthorize`,
    accessToken,
    createJsonMutation('POST', undefined, mutationContext),
  )
}

/**
 * Connector installation を切断します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param installationId - 切断対象 installation ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 切断状態を反映した connector installation です。
 */
export function disconnectDeveloperConnector(
  accessToken: string,
  installationId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ConnectorInstallation>(
    `/developer/connector-installations/${encodeURIComponent(installationId)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )
}

/**
 * Work Item に紐づく外部 resource link を cursor pagination で取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param teamId - Work Item を所有する Team ID です。
 * @param workItemId - Link 対象 Work Item ID です。
 * @param input - Cursor と取得上限です。
 * @param signal - 画面遷移時に request を中止する AbortSignal です。
 * @returns External link と次 page cursor です。
 */
export function listDeveloperExternalLinks(
  accessToken: string,
  teamId: string,
  workItemId: string,
  input: ListDeveloperExternalLinksInput = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ teamId })

  if (input.cursor) {
    query.set('cursor', input.cursor)
  }
  if (input.limit !== undefined) {
    query.set('limit', String(input.limit))
  }

  return requestJson<CursorPage<ExternalWorkItemLink>>(
    `/developer/work-items/${encodeURIComponent(workItemId)}/external-links?${query.toString()}`,
    accessToken,
    { signal },
  )
}

/**
 * Work Item と外部 resource の link を作成します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param workItemId - Link 対象 Work Item ID です。
 * @param input - Installation、resource、同期方向です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 作成した external link です。
 */
export function createDeveloperExternalLink(
  accessToken: string,
  workItemId: string,
  input: CreateExternalWorkItemLinkInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ExternalWorkItemLink>(
    `/developer/work-items/${encodeURIComponent(workItemId)}/external-links`,
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * External link の同期方向を更新します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param linkId - 更新対象 external link ID です。
 * @param input - 新しい同期方向です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 更新した external link です。
 */
export function updateDeveloperExternalLink(
  accessToken: string,
  linkId: string,
  input: UpdateExternalWorkItemLinkInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ExternalWorkItemLink>(
    `/developer/external-links/${encodeURIComponent(linkId)}`,
    accessToken,
    createJsonMutation('PATCH', input, mutationContext),
  )
}

/**
 * Work Item と外部 resource の link を解除します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param linkId - 削除対象 external link ID です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 */
export function deleteDeveloperExternalLink(
  accessToken: string,
  linkId: string,
  mutationContext: MutationRequestContext,
) {
  return requestJson<unknown>(
    `/developer/external-links/${encodeURIComponent(linkId)}`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
    true,
  )
}

/**
 * Work Item 同期競合を cursor pagination で取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Status filter、cursor、取得上限です。
 * @param signal - 画面遷移時に request を中止する AbortSignal です。
 * @returns 同期競合と次 page cursor です。
 */
export function listDeveloperSyncConflicts(
  accessToken: string,
  input: ListDeveloperSyncConflictsInput = {},
  signal?: AbortSignal,
) {
  const query = new URLSearchParams()

  if (input.status) {
    query.set('status', input.status)
  }
  if (input.cursor) {
    query.set('cursor', input.cursor)
  }
  if (input.limit !== undefined) {
    query.set('limit', String(input.limit))
  }

  const suffix = query.size ? `?${query.toString()}` : ''

  return requestJson<CursorPage<WorkItemSyncConflict>>(
    `/developer/sync-conflicts${suffix}`,
    accessToken,
    { signal },
  )
}

/**
 * Work Item 同期競合を解決します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Conflict ID と解決方針です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns 解決状態を反映した同期競合です。
 */
export function resolveDeveloperSyncConflict(
  accessToken: string,
  input: ResolveDeveloperSyncConflictInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<WorkItemSyncConflict>(
    `/developer/sync-conflicts/${encodeURIComponent(input.conflictId)}/resolve`,
    accessToken,
    createJsonMutation(
      'POST',
      {
        resolution:
          input.resolution === 'keep-local'
            ? 'use-local'
            : input.resolution === 'keep-remote'
              ? 'use-external'
              : input.resolution,
        ...(input.resolution === 'merge'
          ? { mergedValues: input.mergedValues }
          : {}),
      },
      mutationContext,
    ),
  )
}

/**
 * CSV または JSON import を検証だけ実行します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Source content、format、field mapping です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Row error と sample を含む dry-run report です。
 */
export function dryRunDeveloperImport(
  accessToken: string,
  input: DryRunDeveloperImportInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ImportDryRunReport>(
    '/developer/imports/dry-run',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * Error の無い dry-run input から import job を開始します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param input - Dry-run 済みの source content と field mapping です。
 * @param mutationContext - Retry でも共有する mutation header context です。
 * @returns Queue に追加された import job です。
 */
export function createDeveloperImport(
  accessToken: string,
  input: DryRunDeveloperImportInput,
  mutationContext: MutationRequestContext,
) {
  return requestJson<ImportJob>(
    '/developer/imports',
    accessToken,
    createJsonMutation('POST', input, mutationContext),
  )
}

/**
 * Work Item export file を Authorization header 付きで取得します。
 *
 * @param accessToken - Authorization header に使う access token です。
 * @param format - CSV または JSON の export format です。
 * @returns Browser download に使う Blob と file 名です。
 */
export async function exportDeveloperWorkItems(
  accessToken: string,
  format: DeveloperExportFormat,
) {
  const workItems: WorkItem[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined

  do {
    const query = new URLSearchParams({
      format,
      limit: '100',
    })
    if (cursor) {
      query.set('cursor', cursor)
    }

    const page = await requestDeveloperExportPage(accessToken, query)
    workItems.push(...page.items)

    if (!page.hasMore) {
      cursor = undefined
      continue
    }
    if (!page.nextCursor || cursors.has(page.nextCursor)) {
      throw new DeveloperPlatformApiError(
        200,
        'Developer Platform API returned an invalid export cursor.',
        'InvalidDeveloperPlatformResponse',
      )
    }

    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  } while (cursor)

  return createDeveloperExportFile(format, workItems)
}

async function requestDeveloperExportPage(
  accessToken: string,
  query: URLSearchParams,
) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestJson<CursorPage<WorkItem>>(
        `/developer/exports?${query.toString()}`,
        accessToken,
      )
    } catch (error) {
      if (
        !(error instanceof DeveloperPlatformApiError) ||
        error.status !== 429 ||
        error.retryAfterSeconds === undefined ||
        attempt >= 5
      ) throw error
      await waitForDeveloperExportRetry(error.retryAfterSeconds)
    }
  }
}

function waitForDeveloperExportRetry(seconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, seconds * 1_000)
  })
}

function createDeveloperExportFile(
  format: DeveloperExportFormat,
  workItems: readonly WorkItem[],
): DeveloperExportFile {
  const suffix = new Date().toISOString().slice(0, 10)
  if (format === 'json') {
    const body = `${JSON.stringify({
      apiVersion: '2026-07-01',
      workItems: workItems.map(toExportWorkItem),
    }, null, 2)}\n`

    return {
      blob: new Blob([body], {
        type: 'application/json; charset=utf-8',
      }),
      fileName: `mukuroji-work-items-${suffix}.json`,
    }
  }

  const customFieldIds = [...new Set(
    workItems.flatMap((workItem) =>
      Object.keys(workItem.customFieldValues)
    ),
  )].sort()
  const headers = [
    'id',
    'teamId',
    'title',
    'description',
    'assignedProjectId',
    'assigneeUserId',
    'workflowStatusId',
    'statusCategory',
    'dueDate',
    'priority',
    'revision',
    'createdAt',
    'updatedAt',
    ...customFieldIds.map(
      (fieldId) => `customFieldValues.${fieldId}`,
    ),
  ]
  const lines = [
    headers.map(escapeDeveloperExportCsvValue).join(','),
    ...workItems.map((workItem) =>
      headers.map((header) => {
        const value = header.startsWith('customFieldValues.')
          ? workItem.customFieldValues[
              header.slice('customFieldValues.'.length)
            ]
          : (workItem as unknown as Record<string, unknown>)[header]

        return escapeDeveloperExportCsvValue(
          serializeDeveloperExportCell(value),
        )
      }).join(',')
    ),
  ]

  return {
    blob: new Blob(
      [`\ufeff${lines.join('\r\n')}\r\n`],
      { type: 'text/csv; charset=utf-8' },
    ),
    fileName: `mukuroji-work-items-${suffix}.csv`,
  }
}

function toExportWorkItem(workItem: WorkItem) {
  return {
    id: workItem.id,
    teamId: workItem.teamId,
    title: workItem.title,
    ...(workItem.description
      ? { description: workItem.description }
      : {}),
    ...(workItem.assignedProjectId
      ? { assignedProjectId: workItem.assignedProjectId }
      : {}),
    assigneeUserId: workItem.assigneeUserId,
    workflowStatusId: workItem.workflowStatusId,
    statusCategory: workItem.statusCategory,
    customFieldValues: structuredClone(workItem.customFieldValues),
    relationIds: [...workItem.relationIds],
    dueDate: workItem.dueDate,
    priority: workItem.priority,
    revision: workItem.revision,
    createdAt: workItem.createdAt,
    updatedAt: workItem.updatedAt,
  }
}

function serializeDeveloperExportCell(value: unknown) {
  if (value === undefined || value === null) {
    return ''
  }
  if (
    Array.isArray(value) ||
    (typeof value === 'object' && value !== null)
  ) {
    return JSON.stringify(value)
  }

  return String(value)
}

function escapeDeveloperExportCsvValue(value: string) {
  const safeValue = /^[\t\r\n ]*[=+\-@]/u.test(value)
    ? `'${value}`
    : value

  return /[",\r\n]/u.test(safeValue)
    ? `"${safeValue.replaceAll('"', '""')}"`
    : safeValue
}

function createJsonMutation(
  method: 'PATCH' | 'POST',
  body: unknown,
  mutationContext: MutationRequestContext,
): RequestInit {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      ...createMutationHeaders(mutationContext),
    },
    method,
  }
}

async function requestJson<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  allowEmptyResponse = false,
) {
  const response = await fetch(`${developerApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(
    response,
    allowEmptyResponse || !response.ok,
    response.ok,
  )

  if (!response.ok) {
    const errorData = readErrorResponse(data)

    throw new DeveloperPlatformApiError(
      response.status,
      errorData?.message?.trim() ||
        errorData?.detail?.trim() ||
        defaultDeveloperApiErrorMessage,
      errorData?.code,
      isRetryableDeveloperApiResponse(response.status, errorData),
      readRetryAfterSeconds(response),
    )
  }

  return data as T
}

function readRetryAfterSeconds(response: Response) {
  const value = response.headers.get('Retry-After')?.trim()
  if (!value) return undefined
  if (/^\d+$/u.test(value)) {
    return Math.min(Number(value), 300)
  }
  const retryAt = Date.parse(value)
  if (Number.isNaN(retryAt)) return undefined
  return Math.min(Math.max(Math.ceil((retryAt - Date.now()) / 1_000), 0), 300)
}

function readErrorResponse(
  value: unknown,
): {
  code?: string
  detail?: string
  message?: string
  retryable?: boolean
} | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

function isRetryableDeveloperApiResponse(
  status: number,
  error: ReturnType<typeof readErrorResponse>,
) {
  return error?.retryable === true || status === 429 || status >= 500
}

async function readJson<T>(
  response: Response,
  allowEmpty: boolean,
  rejectMalformed: boolean,
): Promise<T> {
  const text = await response.text()

  if (!text) {
    if (allowEmpty) {
      return {} as T
    }

    throw new DeveloperPlatformApiError(
      response.status,
      'Developer Platform API returned an empty JSON response.',
      'InvalidDeveloperPlatformResponse',
      isRetryableDeveloperApiResponse(response.status, undefined),
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    if (!rejectMalformed) {
      return {} as T
    }

    throw new DeveloperPlatformApiError(
      response.status,
      'Developer Platform API returned invalid JSON.',
      'InvalidDeveloperPlatformResponse',
      isRetryableDeveloperApiResponse(response.status, undefined),
    )
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
