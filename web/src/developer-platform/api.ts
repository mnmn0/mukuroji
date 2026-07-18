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
   * Content-Disposition から解決した file 名です。
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

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'DeveloperPlatformApiError'
    this.status = status
    this.code = code
  }
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
  const response = await fetch(
    `${developerApiBaseUrl}/developer/exports?format=${encodeURIComponent(format)}`,
    {
      headers: {
        Accept: format === 'csv' ? 'text/csv' : 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
    },
  )

  if (!response.ok) {
    const data = await readJson<unknown>(response)
    const errorData = readErrorResponse(data)

    throw new DeveloperPlatformApiError(
      response.status,
      errorData?.message?.trim() ||
        errorData?.detail?.trim() ||
        defaultDeveloperApiErrorMessage,
      errorData?.code,
    )
  }

  return {
    blob: await response.blob(),
    fileName:
      readDownloadFileName(response.headers.get('Content-Disposition')) ??
      `work-items.${format}`,
  } satisfies DeveloperExportFile
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
) {
  const response = await fetch(`${developerApiBaseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const errorData = readErrorResponse(data)

    throw new DeveloperPlatformApiError(
      response.status,
      errorData?.message?.trim() ||
        errorData?.detail?.trim() ||
        defaultDeveloperApiErrorMessage,
      errorData?.code,
    )
  }

  return data as T
}

function readErrorResponse(
  value: unknown,
): { code?: string; detail?: string; message?: string } | undefined {
  return typeof value === 'object' && value !== null ? value : undefined
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function readDownloadFileName(contentDisposition: string | null) {
  const match = contentDisposition?.match(/filename="?([^";]+)"?/i)

  return match?.[1]
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
