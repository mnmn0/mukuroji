import type {
  CanonicalWorkItem,
  CreateWorkItemInput,
  WorkItemPatch,
} from './work-items'

/**
 * Public API client に付与できる最小権限 scope です。
 */
export type ApiScope =
  | 'work-items:read'
  | 'work-items:write'
  | 'work-items:delete'
  | 'webhooks:read'
  | 'webhooks:write'
  | 'integrations:read'
  | 'integrations:write'
  | 'imports:read'
  | 'imports:write'

/**
 * Public API が返す安定した machine-readable error code です。
 */
export type ApiProblemCode =
  | 'invalid_request'
  | 'authentication_required'
  | 'invalid_credentials'
  | 'insufficient_scope'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'temporarily_unavailable'
  | 'internal_error'

/**
 * 入力検証で問題があった一つの field を表します。
 */
export type ApiProblemViolation = {
  /**
   * JSON Pointer 形式の request field path です。
   */
  pointer: string
  /**
   * Field 単位の安定した error code です。
   */
  code: string
  /**
   * 開発者向けの簡潔な説明です。
   */
  message: string
}

/**
 * RFC 9457 を基礎にした Public API の安定 error response です。
 */
export type ApiProblem = {
  /**
   * 問題種別を説明する永続的な URI です。
   */
  type: string
  /**
   * 問題種別の短い見出しです。
   */
  title: string
  /**
   * HTTP status code です。
   */
  status: number
  /**
   * Client 分岐に使う安定した machine-readable code です。
   */
  code: ApiProblemCode
  /**
   * この発生事例に固有の説明です。
   */
  detail?: string
  /**
   * この発生事例を識別する request-relative URI です。
   */
  instance?: string
  /**
   * Support と監査で照合する request ID です。
   */
  requestId: string
  /**
   * 同じ request を再試行できる可能性があるかを示します。
   */
  retryable: boolean
  /**
   * Field 単位の入力検証 error です。
   */
  errors?: ApiProblemViolation[]
}

/**
 * Opaque cursor を用いる Public API の共通 page response です。
 */
export type CursorPage<T> = {
  /**
   * 現在 page に含まれる resource です。
   */
  items: T[]
  /**
   * 次 page が存在するかどうかです。
   */
  hasMore: boolean
  /**
   * 次 page の取得時にそのまま渡す opaque cursor です。
   */
  nextCursor?: string
}

/**
 * API key と OAuth app credential の lifecycle 状態です。
 */
export type ApiCredentialStatus = 'active' | 'expired' | 'revoked'

/**
 * API key の非機密 metadata です。
 */
export type ApiKeySummary = {
  /**
   * API key resource ID です。
   */
  id: string
  /**
   * 管理画面に表示する名前です。
   */
  name: string
  /**
   * 利用者が key を識別するための非機密 prefix です。
   */
  prefix: string
  /**
   * API key に認可された scope です。
   */
  scopes: ApiScope[]
  /**
   * API key の lifecycle 状態です。
   */
  status: ApiCredentialStatus
  /**
   * API key を作成した Workspace user ID です。
   */
  createdByUserId: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 有効期限の ISO 8601 timestamp です。
   */
  expiresAt?: string
  /**
   * 最後に認証へ成功した日時の ISO 8601 timestamp です。
   */
  lastUsedAt?: string
  /**
   * Revoke した日時の ISO 8601 timestamp です。
   */
  revokedAt?: string
}

/**
 * API key を作成する入力です。
 */
export type CreateApiKeyInput = {
  /**
   * 管理画面に表示する名前です。
   */
  name: string
  /**
   * API key に付与する scope です。
   */
  scopes: ApiScope[]
  /**
   * 有効期限の ISO 8601 timestamp です。
   */
  expiresAt?: string
}

/**
 * API key の非機密 metadata を更新する入力です。
 */
export type UpdateApiKeyInput = {
  /**
   * 変更後の表示名です。
   */
  name?: string
  /**
   * 変更後の有効期限です。null は有効期限の解除を表します。
   */
  expiresAt?: string | null
}

/**
 * API key を rotation する入力です。
 */
export type RotateApiKeyInput = {
  /**
   * Rotation 後の有効期限です。null は有効期限なしを表します。
   */
  expiresAt?: string | null
}

/**
 * 作成または rotation 直後に一度だけ返す API key secret です。
 */
export type ApiKeyOneTimeSecretOutput = {
  /**
   * 保存可能な API key metadata です。
   */
  apiKey: ApiKeySummary
  /**
   * 再取得できない平文 secret です。
   */
  secret: string
}

/**
 * OAuth app が利用できる grant type です。
 */
export type OAuthGrantType = 'client_credentials'

/**
 * OAuth app の非機密 metadata です。
 */
export type OAuthAppSummary = {
  /**
   * OAuth app resource ID です。
   */
  id: string
  /**
   * 管理画面に表示する server-to-server app 名です。
   */
  name: string
  /**
   * OAuth client ID です。
   */
  clientId: string
  /**
   * OAuth app が利用できる grant type です。
   */
  grantTypes: OAuthGrantType[]
  /**
   * OAuth app が要求できる scope の上限です。
   */
  scopes: ApiScope[]
  /**
   * OAuth app credential の lifecycle 状態です。
   */
  status: ApiCredentialStatus
  /**
   * OAuth app を作成した Workspace user ID です。
   */
  createdByUserId: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * OAuth app credential の有効期限を示す ISO 8601 timestamp です。
   */
  expiresAt?: string
  /**
   * 最後に token を発行した日時の ISO 8601 timestamp です。
   */
  lastUsedAt?: string
  /**
   * Revoke した日時の ISO 8601 timestamp です。
   */
  revokedAt?: string
}

/**
 * OAuth app を作成する入力です。
 */
export type CreateOAuthAppInput = {
  /**
   * 管理画面に表示する server-to-server app 名です。
   */
  name: string
  /**
   * OAuth app が利用する grant type です。
   */
  grantTypes: OAuthGrantType[]
  /**
   * OAuth app が要求できる scope の上限です。
   */
  scopes: ApiScope[]
  /**
   * OAuth app credential の有効期限を示す ISO 8601 timestamp です。
   */
  expiresAt?: string
}

/**
 * OAuth app の非機密 metadata を更新する入力です。
 */
export type UpdateOAuthAppInput = {
  /**
   * 変更後の表示名です。
   */
  name?: string
}

/**
 * 作成または rotation 直後に一度だけ返す OAuth client secret です。
 */
export type OAuthAppOneTimeSecretOutput = {
  /**
   * 保存可能な OAuth app metadata です。
   */
  oauthApp: OAuthAppSummary
  /**
   * 再取得できない平文 client secret です。
   */
  clientSecret: string
}

/**
 * OAuth token endpoint の request です。
 */
export type OAuthTokenRequest = {
  /**
   * Token 発行に使う grant type です。
   */
  grant_type: 'client_credentials'
  /**
   * OAuth client ID です。
   */
  client_id: string
  /**
   * OAuth client secret です。
   */
  client_secret: string
  /**
   * 発行 token に要求する空白区切り scope です。
   */
  scope?: string
}

/**
 * OAuth token endpoint の成功 response です。
 */
export type OAuthTokenOutput = {
  /**
   * Public API 認証に使う access token です。
   */
  access_token: string
  /**
   * Token type です。
   */
  token_type: 'Bearer'
  /**
   * Access token の有効秒数です。
   */
  expires_in: number
  /**
   * 発行 token に実際に付与された空白区切り scope です。
   */
  scope: string
}

/**
 * Webhook が購読できる event type です。
 */
export type WebhookEventType =
  | 'work-item.created'
  | 'work-item.updated'
  | 'work-item.deleted'
  | 'external-link.created'
  | 'external-link.updated'
  | 'sync-conflict.created'
  | 'sync-conflict.resolved'
  | 'import.completed'
  | 'import.failed'

/**
 * Webhook subscription の配信状態です。
 */
export type WebhookSubscriptionStatus = 'active' | 'paused' | 'disabled'

/**
 * Signed webhook の購読設定です。
 */
export type WebhookSubscription = {
  /**
   * Webhook subscription ID です。
   */
  id: string
  /**
   * 管理画面に表示する名前です。
   */
  name: string
  /**
   * HTTPS delivery endpoint です。
   */
  url: string
  /**
   * Subscription を作成した Workspace user ID です。
   */
  createdByUserId: string
  /**
   * Event payload の送信を許可する Team ID です。
   */
  teamIds: string[]
  /**
   * 購読する event type です。
   */
  eventTypes: WebhookEventType[]
  /**
   * Event payload を生成するときに適用する scope です。
   */
  scopes: ApiScope[]
  /**
   * Subscription の配信状態です。
   */
  status: WebhookSubscriptionStatus
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * 最後に配信を試みた日時の ISO 8601 timestamp です。
   */
  lastDeliveryAt?: string
  /**
   * 直近から連続して失敗した delivery 数です。
   */
  failureCount: number
}

/**
 * Webhook subscription を作成する入力です。
 */
export type CreateWebhookSubscriptionInput = {
  /**
   * 管理画面に表示する名前です。
   */
  name: string
  /**
   * HTTPS delivery endpoint です。
   */
  url: string
  /**
   * Event payload の送信を許可する Team ID です。
   */
  teamIds: string[]
  /**
   * 購読する event type です。
   */
  eventTypes: WebhookEventType[]
  /**
   * Event payload を生成するときに適用する scope です。
   */
  scopes?: ApiScope[]
}

/**
 * Webhook subscription を更新する入力です。
 */
export type UpdateWebhookSubscriptionInput = {
  /**
   * 変更後の表示名です。
   */
  name?: string
  /**
   * 変更後の HTTPS delivery endpoint です。
   */
  url?: string
  /**
   * 変更後に購読する event type です。
   */
  eventTypes?: WebhookEventType[]
  /**
   * 変更後の payload scope です。
   */
  scopes?: ApiScope[]
  /**
   * 変更後の配信状態です。
   */
  status?: WebhookSubscriptionStatus
}

/**
 * Webhook 作成または signing secret rotation の一度限りの response です。
 */
export type WebhookSubscriptionSecretOutput = {
  /**
   * 保存可能な subscription metadata です。
   */
  subscription: WebhookSubscription
  /**
   * 再取得できない webhook signing secret です。
   */
  signingSecret: string
}

/**
 * Webhook delivery の状態です。
 */
export type WebhookDeliveryStatus = 'pending' | 'retrying' | 'delivered' | 'failed'

/**
 * Webhook delivery の監査可能な summary です。
 */
export type WebhookDelivery = {
  /**
   * Delivery ID です。
   */
  id: string
  /**
   * 配信先 subscription ID です。
   */
  subscriptionId: string
  /**
   * 冪等に配信する event ID です。
   */
  eventId: string
  /**
   * 配信した event type です。
   */
  eventType: WebhookEventType
  /**
   * Delivery の現在状態です。
   */
  status: WebhookDeliveryStatus
  /**
   * これまでの配信試行回数です。
   */
  attempts: number
  /**
   * Delivery endpoint が最後に返した HTTP status です。
   */
  responseStatus?: number
  /**
   * Operator replay の起点になった original delivery ID です。
   */
  replayOfDeliveryId?: string
  /**
   * Original delivery 内で単調増加する operator replay 番号です。
   */
  replayNumber?: number
  /**
   * 次回 retry 予定日時の ISO 8601 timestamp です。
   */
  nextAttemptAt?: string
  /**
   * 配信成功日時の ISO 8601 timestamp です。
   */
  deliveredAt?: string
  /**
   * Delivery 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * Delivery 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
}

/**
 * Webhook event の versioned envelope です。
 */
export type WebhookEventEnvelope<T = unknown> = {
  /**
   * 再送時も変わらない event ID です。
   */
  id: string
  /**
   * Event の machine-readable type です。
   */
  type: WebhookEventType
  /**
   * Event envelope の API version です。
   */
  apiVersion: '2026-07-01'
  /**
   * Domain event が発生した ISO 8601 timestamp です。
   */
  occurredAt: string
  /**
   * Event が属する Workspace ID です。
   */
  workspaceId: string
  /**
   * Event type に対応する versioned payload です。
   */
  data: T
}

/**
 * 外部 connector の用途 category です。
 */
export type ConnectorCategory =
  | 'source-control'
  | 'chat'
  | 'email'
  | 'calendar'
  | 'cloud-storage'

/**
 * Built-in connector provider です。
 */
export type ConnectorProvider =
  | 'github'
  | 'gitlab'
  | 'slack'
  | 'microsoft-teams'
  | 'gmail'
  | 'outlook'
  | 'google-calendar'
  | 'outlook-calendar'
  | 'google-drive'
  | 'onedrive'
  | 'dropbox'

/**
 * Connector installation の接続状態です。
 */
export type ConnectorStatus =
  | 'connected'
  | 'needs-reauth'
  | 'degraded'
  | 'disconnected'
  | 'conflict'

/**
 * Connector catalog の一つの provider 定義です。
 */
export type ConnectorDefinition = {
  /**
   * Connector provider code です。
   */
  provider: ConnectorProvider
  /**
   * Connector の用途 category です。
   */
  category: ConnectorCategory
  /**
   * UI に表示する provider 名です。
   */
  name: string
  /**
   * Provider が提供する capability code です。
   */
  capabilities: string[]
}

/**
 * Workspace に接続された connector installation です。
 */
export type ConnectorInstallation = {
  /**
   * Connector installation ID です。
   */
  id: string
  /**
   * Connector の用途 category です。
   */
  category: ConnectorCategory
  /**
   * 接続先 provider です。
   */
  provider: ConnectorProvider
  /**
   * 管理画面に表示する installation 名です。
   */
  name: string
  /**
   * Installation の接続状態です。
   */
  status: ConnectorStatus
  /**
   * Provider から認可された capability scope です。
   */
  scopes: string[]
  /**
   * Provider 側 account または tenant ID です。
   */
  externalAccountId?: string
  /**
   * Provider 側 account の表示名です。
   */
  externalAccountName?: string
  /**
   * Connector を接続した Workspace user ID です。
   */
  installedByUserId: string
  /**
   * 接続日時の ISO 8601 timestamp です。
   */
  installedAt: string
  /**
   * 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
  /**
   * 最後に同期へ成功した日時の ISO 8601 timestamp です。
   */
  lastSyncAt?: string
  /**
   * Redact 済みの直近接続 error です。
   */
  lastError?: ApiProblem
  /**
   * 短時間だけ有効な再認証開始 URL です。
   */
  reauthorizationUrl?: string
}

/**
 * Connector installation を開始する入力です。
 */
export type CreateConnectorInstallationInput = {
  /**
   * 接続する provider です。
   */
  provider: ConnectorProvider
  /**
   * 管理画面に表示する installation 名です。
   */
  name: string
  /**
   * Provider に要求する capability scope です。
   */
  scopes: string[]
  /**
   * OAuth 完了後に戻る application-relative URL です。
   */
  returnUrl: string
}

/**
 * Connector installation または再認証 flow の開始 response です。
 */
export type ConnectorAuthorizationOutput = {
  /**
   * Provider の authorization endpoint へ移動する URL です。
   */
  authorizationUrl: string
  /**
   * Callback と照合する短時間有効な state ID です。
   */
  stateId: string
  /**
   * Authorization flow の有効期限です。
   */
  expiresAt: string
}

/**
 * 外部 resource と Work Item の link 対象種別です。
 */
export type ExternalResourceType = 'issue' | 'merge-request' | 'commit' | 'deploy'

/**
 * 外部 link の同期方向です。
 */
export type ExternalSyncDirection = 'inbound' | 'outbound' | 'bidirectional' | 'none'

/**
 * 外部 link の同期状態です。
 */
export type ExternalSyncStatus = 'pending' | 'synced' | 'conflict' | 'failed' | 'paused'

/**
 * Work Item と外部 resource の link です。
 */
export type ExternalWorkItemLink = {
  /**
   * External link ID です。
   */
  id: string
  /**
   * Link 先 Work Item を所有する Team ID です。
   */
  teamId: string
  /**
   * Link 先 Work Item ID です。
   */
  workItemId: string
  /**
   * 外部 resource にアクセスする connector installation ID です。
   */
  installationId: string
  /**
   * Link 作成時の connector provider 表示 snapshot です。
   */
  provider?: ConnectorProvider
  /**
   * Link 作成時の connector installation 表示名 snapshot です。
   */
  installationName?: string
  /**
   * Link 作成時の provider account 表示名 snapshot です。
   */
  externalAccountName?: string
  /**
   * 外部 resource の種別です。
   */
  resourceType: ExternalResourceType
  /**
   * Provider 内で一意な外部 resource ID です。
   */
  externalId: string
  /**
   * Provider UI で外部 resource を開く HTTPS URL です。
   */
  externalUrl: string
  /**
   * ISSUE-123 のような利用者向け識別子です。
   */
  displayKey?: string
  /**
   * Link の同期方向です。
   */
  syncDirection: ExternalSyncDirection
  /**
   * Link の現在の同期状態です。
   */
  syncStatus: ExternalSyncStatus
  /**
   * 最後に双方向の state が一致した日時です。
   */
  lastSyncedAt?: string
  /**
   * Link 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * Link 最終更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
}

/**
 * Work Item と外部 resource を link する入力です。
 */
export type CreateExternalWorkItemLinkInput = {
  /**
   * Link 先 Work Item を所有する Team ID です。
   */
  teamId: string
  /**
   * 外部 resource にアクセスする connector installation ID です。
   */
  installationId: string
  /**
   * 外部 resource の種別です。
   */
  resourceType: ExternalResourceType
  /**
   * Provider 内で一意な外部 resource ID です。
   */
  externalId: string
  /**
   * Provider UI で外部 resource を開く HTTPS URL です。
   */
  externalUrl: string
  /**
   * ISSUE-123 のような利用者向け識別子です。
   */
  displayKey?: string
  /**
   * Link の同期方向です。
   */
  syncDirection: ExternalSyncDirection
}

/**
 * External Work Item link の同期方向を更新する入力です。
 */
export type UpdateExternalWorkItemLinkInput = {
  /**
   * 更新後の同期方向です。`none` は同期を一時停止します。
   */
  syncDirection: ExternalSyncDirection
}

/**
 * External Work Item link 一覧 API の query contract です。
 */
export type ListExternalWorkItemLinksRequest = {
  /**
   * Link 先 Work Item を所有する Team ID です。
   */
  teamId: string
  /**
   * Link 先 Work Item ID filter です。
   */
  workItemId?: string
  /**
   * Connector installation ID filter です。
   */
  installationId?: string
  /**
   * 前 response の opaque nextCursor です。
   */
  cursor?: string
  /**
   * 1 page に返す最大 resource 数です。
   */
  limit?: number
}

/**
 * Work Item と外部 resource の field 差分です。
 */
export type WorkItemSyncConflictField = {
  /**
   * 競合した canonical field path です。
   */
  field: string
  /**
   * Work Item 側の JSON value です。
   */
  localValue: unknown
  /**
   * 外部 resource 側の JSON value です。
   */
  externalValue: unknown
}

/**
 * Sync conflict の解決状態です。
 */
export type SyncConflictStatus = 'open' | 'resolved' | 'ignored'

/**
 * Sync conflict に適用できる解決方法です。
 */
export type SyncConflictResolution = 'use-local' | 'use-external' | 'merge' | 'ignore'

/**
 * 双方向同期で検出した Work Item conflict です。
 */
export type WorkItemSyncConflict = {
  /**
   * Conflict ID です。
   */
  id: string
  /**
   * Conflict が属する external link ID です。
   */
  externalLinkId: string
  /**
   * 競合した Work Item ID です。
   */
  workItemId: string
  /**
   * 競合検出時の Work Item revision です。
   */
  localRevision: number
  /**
   * Provider が返した external revision または ETag です。
   */
  externalRevision: string
  /**
   * Field 単位の競合差分です。
   */
  fields: WorkItemSyncConflictField[]
  /**
   * Conflict の解決状態です。
   */
  status: SyncConflictStatus
  /**
   * Conflict 検出日時の ISO 8601 timestamp です。
   */
  detectedAt: string
  /**
   * Conflict 解決日時の ISO 8601 timestamp です。
   */
  resolvedAt?: string
  /**
   * Conflict を解決した Workspace user ID です。
   */
  resolvedByUserId?: string
}

/**
 * Work Item sync conflict を解決する入力です。
 */
export type ResolveWorkItemSyncConflictInput = {
  /**
   * Conflict 全体に適用する解決方法です。
   */
  resolution: SyncConflictResolution
  /**
   * Merge 解決時に採用する field value です。
   */
  mergedValues?: Record<string, unknown>
}

/**
 * Import source の file format です。
 */
export type ImportFormat = 'csv' | 'json'

/**
 * Import field に適用する組み込み変換です。
 */
export type ImportFieldTransform =
  | 'none'
  | 'trim'
  | 'lowercase'
  | 'uppercase'
  | 'parse-date'
  | 'parse-number'
  | 'split-comma'

/**
 * Import source field から Work Item field への mapping です。
 */
export type ImportFieldMapping = {
  /**
   * CSV header または JSON property path です。
   */
  sourceField: string
  /**
   * Canonical Work Item field または custom field ID です。
   */
  targetField: string
  /**
   * Mapping 前に適用する組み込み変換です。
   */
  transform?: ImportFieldTransform
  /**
   * Source field が空の場合に row を error とするかどうかです。
   */
  required?: boolean
  /**
   * Source field が空の場合に利用する JSON value です。
   */
  defaultValue?: unknown
}

/**
 * Import source field と Work Item field の mapping 一覧です。
 */
export type ImportMapping = ImportFieldMapping[]

/**
 * Import する client-provided source file です。
 */
export type ImportSource = {
  /**
   * Error report に表示する元 file 名です。
   */
  fileName: string
  /**
   * Source の IANA media type です。
   */
  mediaType: 'text/csv' | 'application/json'
  /**
   * UTF-8 source file の内容です。
   */
  content: string
}

/**
 * Import dry-run を実行する入力です。
 */
export type CreateImportDryRunInput = {
  /**
   * Source file format です。
   */
  format: ImportFormat
  /**
   * 検証する source file です。
   */
  source: ImportSource
  /**
   * Imported Work Item を所有する Team ID です。
   */
  teamId: string
  /**
   * Imported Work Item の既定 assigned Project ID です。
   */
  assignedProjectId?: string
  /**
   * 検証する mapping 設定です。
   */
  mapping: ImportMapping
}

/**
 * Import source の一つの row error です。
 */
export type ImportRowError = {
  /**
   * Header を除く 1 始まりの data row 番号です。
   */
  row: number
  /**
   * Client 分岐に使える安定した error code です。
   */
  code: string
  /**
   * Mapping 修正に使う説明です。
   */
  message: string
  /**
   * Error の原因になった source または target field です。
   */
  field?: string
}

/**
 * Dry-run で返す一つの mapped row preview です。
 */
export type ImportRecordPreview = {
  /**
   * Header を除く 1 始まりの data row 番号です。
   */
  row: number
  /**
   * Source file から parse した input value です。
   */
  input: Record<string, unknown>
  /**
   * Mapping 後に保存予定の Work Item value です。
   */
  mapped: Record<string, unknown>
  /**
   * Row が現在の configuration で保存可能かどうかです。
   */
  valid: boolean
  /**
   * Row に紐づく validation error です。
   */
  errors: ImportRowError[]
}

/**
 * Import dry-run の検証 report です。
 */
export type ImportDryRunReport = ImportReport & {
  /**
   * Source 全体を import job として開始可能かどうかです。
   */
  valid: boolean
  /**
   * Mapping 確認用の先頭 row preview です。
   */
  sample: ImportRecordPreview[]
}

/**
 * Work Item import job を開始する入力です。
 */
export type CreateImportJobInput = {
  /**
   * Source file format です。
   */
  format: ImportFormat
  /**
   * Import する source file です。
   */
  source: ImportSource
  /**
   * Imported Work Item を所有する Team ID です。
   */
  teamId: string
  /**
   * Imported Work Item の既定 assigned Project ID です。
   */
  assignedProjectId?: string
  /**
   * Dry-run で確認済みの mapping 設定です。
   */
  mapping: ImportMapping
}

/**
 * Import job の lifecycle 状態です。
 */
export type ImportJobStatus =
  | 'queued'
  | 'validating'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * 検証または実行を終えた import job の bounded report です。
 */
export type ImportReport = {
  /**
   * Source に含まれた data row 数です。
   */
  totalRows: number
  /**
   * Mapping と validation に成功した row 数です。
   */
  validRows: number
  /**
   * Mapping または validation に失敗した row 数です。
   */
  invalidRows: number
  /**
   * Import 中に記録した row error です。
   */
  errors: ImportRowError[]
}

/**
 * 非同期 Work Item import job です。
 */
export type ImportJob = {
  /**
   * Import job ID です。
   */
  id: string
  /**
   * Source file format です。
   */
  format: ImportFormat
  /**
   * Imported Work Item を所有する Team ID です。
   */
  teamId: string
  /**
   * Imported Work Item の既定 assigned Project ID です。
   */
  assignedProjectId?: string
  /**
   * Import job の現在状態です。
   */
  status: ImportJobStatus
  /**
   * Job に固定した mapping 設定です。
   */
  mapping: ImportMapping
  /**
   * Dry-run のみで resource を保存しない job かどうかです。
   */
  dryRun: boolean
  /**
   * Job を作成した Workspace user ID です。
   */
  createdByUserId: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 実行開始日時の ISO 8601 timestamp です。
   */
  startedAt?: string
  /**
   * 実行完了日時の ISO 8601 timestamp です。
   */
  completedAt?: string
  /**
   * Dry-run、完了、または validation failure の import report です。
   */
  report?: ImportReport
  /**
   * Job 全体が失敗した場合の redact 済み error です。
   */
  error?: ApiProblem
}

/**
 * Work Item export の file format です。
 */
export type ExportFormat = 'csv' | 'json'

/**
 * Public Work Item list endpoint の query contract です。
 */
export type ListPublicWorkItemsRequest = {
  /**
   * 取得対象を所有する Team ID です。
   */
  teamId: string
  /**
   * Assigned Project ID filter です。
   */
  assignedProjectId?: string
  /**
   * Assignee Workspace user ID filter です。
   */
  assigneeUserId?: string
  /**
   * Workflow status ID filter です。
   */
  workflowStatusId?: string
  /** Stable Work Item Type ID filter. */
  workItemTypeId?: string
  /**
   * この ISO 8601 timestamp 以降に更新された resource へ絞り込みます。
   */
  updatedAfter?: string
  /**
   * 前 response の opaque nextCursor です。
   */
  cursor?: string
  /**
   * 1 page に返す最大 resource 数です。
   */
  limit?: number
}

/**
 * Public Work Item create endpoint の request body です。
 */
export type CreatePublicWorkItemRequest = CreateWorkItemInput & {
  /**
   * Work Item を所有する Team ID です。
   */
  teamId: string
}

/**
 * Public Work Item update endpoint の request body です。
 */
export type UpdatePublicWorkItemRequest = WorkItemPatch & {
  /**
   * 読み込み時点の Work Item revision です。
   */
  expectedRevision: number
}

/**
 * Public Work Item delete endpoint の request body です。
 */
export type DeletePublicWorkItemRequest = {
  /**
   * 読み込み時点の Work Item revision です。
   */
  expectedRevision: number
}

/**
 * Public Work Item list endpoint の cursor page です。
 */
export type PublicWorkItemPage = CursorPage<CanonicalWorkItem>

/**
 * Developer settings UI で actor に許可する管理操作です。
 */
export type DeveloperPlatformCapabilities = {
  /**
   * API key と OAuth app credential を管理できるかどうかです。
   */
  canManageCredentials: boolean
  /**
   * Webhook subscription を管理、delivery を replay できるかどうかです。
   */
  canManageWebhooks: boolean
  /**
   * Connector と external link を管理できるかどうかです。
   */
  canManageIntegrations: boolean
  /**
   * Work Item import を dry-run、実行できるかどうかです。
   */
  canImport: boolean
  /**
   * Work Item export を実行できるかどうかです。
   */
  canExport: boolean
}

/**
 * Developer settings 初期表示用の aggregate response です。
 */
export type DeveloperPlatformOverview = {
  /**
   * 現在 actor に許可された管理操作です。
   */
  capabilities: DeveloperPlatformCapabilities
  /**
   * Workspace の API key metadata です。
   */
  apiKeys: ApiKeySummary[]
  /**
   * Workspace の OAuth app metadata です。
   */
  oauthApps: OAuthAppSummary[]
  /**
   * Workspace の webhook subscription です。
   */
  webhookSubscriptions: WebhookSubscription[]
  /**
   * Workspace の直近 webhook delivery です。
   */
  webhookDeliveries: WebhookDelivery[]
  /**
   * Workspace の connector installation です。
   */
  connectors: ConnectorInstallation[]
  /**
   * Workspace の直近 import job です。
   */
  imports: ImportJob[]
}
