import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import type {
  ApiKeySummary,
  ApiScope,
  ConnectorInstallation,
  CreateApiKeyInput,
  CreateOAuthAppInput,
  ExternalWorkItemLink,
  ImportJob,
  OAuthAppSummary,
  UpdateExternalWorkItemLinkInput,
  UpdateWebhookSubscriptionInput,
  WebhookDelivery,
  WebhookEventEnvelope,
  WebhookSubscription,
} from '@mukuroji/contracts'
import {
  createMutationAuditContext,
  createMutationAuditEventPut,
  getConfiguredAuditTableName,
  type AuditTransactWriteItem,
} from '../audit'
import {
  createConnectorPollTargetLookupKey,
  createConnectorPollTargetRecordKey,
} from './connector-poll-projection'

/** Developer platform credential に付与できる全 scope です。 */
export const API_SCOPES = [
  'work-items:read',
  'work-items:write',
  'work-items:delete',
  'webhooks:read',
  'webhooks:write',
  'integrations:read',
  'integrations:write',
  'imports:read',
  'imports:write',
] as const satisfies readonly ApiScope[]

/** API key の既定有効期間です。 */
export const API_KEY_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60

/** OAuth app credential の既定有効期間です。 */
export const OAUTH_APP_DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60

/** OAuth access token の既定有効期間です。 */
export const OAUTH_TOKEN_DEFAULT_TTL_SECONDS = 60 * 60

/** OAuth access token に許可する最大有効期間です。 */
export const OAUTH_TOKEN_MAX_TTL_SECONDS = 24 * 60 * 60

/** Idempotency response を保持する既定期間です。 */
export const IDEMPOTENCY_DEFAULT_TTL_SECONDS = 24 * 60 * 60

/** 暗号化後も DynamoDB item 上限へ安全に収める idempotency response 上限です。 */
export const IDEMPOTENCY_MAX_RESPONSE_BYTES = 256 * 1024

/** 未完了 idempotency reservation を takeover できるまでの lease 期間です。 */
export const IDEMPOTENCY_RESERVATION_LEASE_SECONDS = 2 * 60

/** Webhook delivery log と index locator を保持する期間です。 */
export const WEBHOOK_DELIVERY_RETENTION_SECONDS = 90 * 24 * 60 * 60

/** Disabled Webhook subscription metadata を監査目的で保持する期間です。 */
export const WEBHOOK_DISABLED_SUBSCRIPTION_RETENTION_SECONDS = 90 * 24 * 60 * 60

/** Webhook delivery の既定取得件数です。 */
export const WEBHOOK_DELIVERY_DEFAULT_LIMIT = 50

/** Webhook delivery の最大取得件数です。 */
export const WEBHOOK_DELIVERY_MAX_LIMIT = 100

/** 一つの Workspace に保存できる Webhook subscription 上限です。 */
export const WEBHOOK_SUBSCRIPTION_LIMIT = 1_000

/** 一つの Webhook projection job が処理できる subscription 上限です。 */
export const WEBHOOK_PROJECTION_PAGE_MAX_LIMIT = 50

/** Webhook delivery 永続化処理の同時実行上限です。 */
const WEBHOOK_ENQUEUE_CONCURRENCY = 10

/** 一つの connector installation に保存できる external link 上限です。 */
export const EXTERNAL_LINK_INSTALLATION_LIMIT = 2_000

/** 一つの connector disconnect job が処理できる link 上限です。 */
export const CONNECTOR_DISCONNECT_PAGE_MAX_LIMIT = 50

/** 一つの Work Item に保存できる external link 上限です。 */
export const EXTERNAL_LINK_WORK_ITEM_LIMIT = 2_000

/** Webhook を自動 retry する最大 attempt 数です。 */
export const WEBHOOK_MAX_ATTEMPTS = 8

/** Provider credential refresh claim を takeover できるまでの lease 期間です。 */
export const CONNECTOR_CREDENTIAL_REFRESH_LEASE_SECONDS = 60

/** Webhook signature timestamp に許容する既定 clock skew です。 */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60

/** DynamoDB の lookupKey GSI 既定名です。 */
export const DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME = 'LookupKeyIndex'

/** Active Webhook locator migration の永続状態です。 */
export type WebhookActiveLocatorMigrationState =
  | 'pending'
  | 'cutover'
  | 'complete'

/** Active Webhook locator migration row の partition key です。 */
const WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID =
  'WEBHOOK_ACTIVE_LOCATOR_MIGRATION#v3'

/** Active Webhook locator migration row の sort key です。 */
const WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY = 'STATE'

/** Active Webhook locator migration row の discriminator です。 */
const WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE =
  'webhook-active-locator-migration'

/** External link installation index が受け付ける resource 種別です。 */
const EXTERNAL_LINK_RESOURCE_TYPES = [
  'issue',
  'merge-request',
  'commit',
  'deploy',
] as const satisfies readonly ExternalWorkItemLink['resourceType'][]

/** External link index を一度に評価する page size です。 */
const EXTERNAL_LINK_INDEX_PAGE_SIZE = 100

/** 一つの filter から解決できる external links の hard cap です。 */
const EXTERNAL_LINK_INDEX_RESULT_LIMIT = EXTERNAL_LINK_INSTALLATION_LIMIT

/** Domain mutation と同じ transaction で idempotency response を確定する token です。 */
export type IdempotencyMutationToken = {
  /** Idempotency namespace を分離する credential ID です。 */
  credentialId: string
  /** Caller が指定した HTTP `Idempotency-Key` です。 */
  idempotencyKey: string
  /** Method、target、body を束縛する stable fingerprint です。 */
  requestFingerprint: string
  /** Current reservation owner だけが commit できる opaque token です。 */
  reservationId: string
}

/** Domain mutation と同じ transaction で保存する HTTP response です。 */
export type IdempotencyMutationResponse = {
  /** Replay 時に返す HTTP status です。 */
  status: 200 | 201 | 202 | 204
  /** Replay 時に返す response body です。 */
  body: unknown
}

/** Atomic idempotency を任意で付与できる domain mutation request です。 */
export type IdempotentDomainMutationRequest = {
  /** Domain row と response receipt を同時確定する内部 token です。 */
  idempotency?: IdempotencyMutationToken
}

/** API key 作成 request です。 */
export type CreateApiKeyRequest = IdempotentDomainMutationRequest & {
  /** API key を所有する Workspace ID です。 */
  workspaceId: string
  /** API key を作成する User ID です。 */
  createdByUserId: string
  /** 検証済み API key 入力です。 */
  input: CreateApiKeyInput
}

/** API key secret を一度だけ含む作成・rotation response です。 */
export type ApiKeySecretResult = {
  /** Secret を除いた API key summary です。 */
  apiKey: ApiKeySummary
  /** 作成・rotation response でのみ返す高 entropy secret です。 */
  secret: string
}

/** API key rotation request です。 */
export type RotateApiKeyRequest = IdempotentDomainMutationRequest & {
  /** API key を所有する Workspace ID です。 */
  workspaceId: string
  /** Rotation 対象 API key ID です。 */
  apiKeyId: string
}

/** API key revoke request です。 */
export type RevokeApiKeyRequest = RotateApiKeyRequest

/** Credential 認証時の共通入力です。 */
export type AuthenticateCredentialRequest = {
  /** Caller が提示した bearer credential です。 */
  credential: string
  /** Endpoint が必要とする scope です。 */
  requiredScopes?: readonly ApiScope[]
}

/** 認証済み developer credential snapshot です。 */
export type AuthenticatedDeveloperCredential = {
  /** 認証方式です。 */
  kind: 'api-key' | 'oauth-token'
  /** Credential が所属する Workspace ID です。 */
  workspaceId: string
  /** API key または OAuth token ID です。 */
  credentialId: string
  /** Request ごとに active membership/RBAC を再評価する subject User ID です。 */
  subjectUserId: string
  /** OAuth token の場合に発行元 app を示す ID です。 */
  oauthAppId?: string
  /** Credential に付与された scope です。 */
  scopes: ApiScope[]
  /** Credential の失効日時です。 */
  expiresAt?: string
}

/** OAuth app 作成 request です。 */
export type CreateOAuthAppRequest = IdempotentDomainMutationRequest & {
  /** OAuth app を所有する Workspace ID です。 */
  workspaceId: string
  /** OAuth app を作成する User ID です。 */
  createdByUserId: string
  /** 検証済み OAuth app 入力です。 */
  input: CreateOAuthAppInput
}

/** OAuth client secret を一度だけ含む作成・rotation response です。 */
export type OAuthAppSecretResult = {
  /** Secret を除いた OAuth app summary です。 */
  oauthApp: OAuthAppSummary
  /** 作成・rotation response でのみ返す高 entropy client secret です。 */
  clientSecret: string
}

/** OAuth client secret rotation request です。 */
export type RotateOAuthClientSecretRequest = IdempotentDomainMutationRequest & {
  /** OAuth app を所有する Workspace ID です。 */
  workspaceId: string
  /** Rotation 対象 OAuth app ID です。 */
  oauthAppId: string
}

/** OAuth app revoke request です。 */
export type RevokeOAuthAppRequest = RotateOAuthClientSecretRequest

/** OAuth client_credentials token request です。 */
export type IssueOAuthTokenRequest = {
  /** Public OAuth client ID です。 */
  clientId: string
  /** Caller が提示した client secret です。 */
  clientSecret: string
  /** App の scope から絞り込む token scope です。 */
  scopes?: readonly ApiScope[]
  /** Token の有効秒数です。 */
  expiresInSeconds?: number
}

/** OAuth token endpoint response です。 */
export type OAuthTokenResult = {
  /** 一度だけ返す bearer access token です。 */
  accessToken: string
  /** OAuth token type です。 */
  tokenType: 'Bearer'
  /** Token の有効秒数です。 */
  expiresIn: number
  /** Token の失効日時です。 */
  expiresAt: string
  /** Token に付与された scope です。 */
  scopes: ApiScope[]
}

/** Webhook subscription 作成入力です。 */
export type CreateWebhookSubscriptionInput = {
  /** Subscription の表示名です。 */
  name: string
  /** HTTPS delivery endpoint です。 */
  url: string
  /** 購読する audit event type または wildcard pattern です。 */
  eventTypes: WebhookSubscription['eventTypes']
  /** Payload 配信を許可する Team ID です。 */
  teamIds: string[]
  /** Delivery payload に許可する scope です。 */
  scopes?: ApiScope[]
}

/** Webhook subscription 作成 request です。 */
export type CreateWebhookSubscriptionRequest = IdempotentDomainMutationRequest & {
  /** Subscription を所有する Workspace ID です。 */
  workspaceId: string
  /** Subscription を作成する Workspace user ID です。 */
  createdByUserId: string
  /** 検証済み subscription 入力です。 */
  input: CreateWebhookSubscriptionInput
}

/** Webhook signing secret を一度だけ含む response です。 */
export type WebhookSecretResult = {
  /** Secret を除いた subscription です。 */
  subscription: WebhookSubscription
  /** 作成・rotation response でのみ返す signing secret です。 */
  signingSecret: string
}

/** Webhook secret rotation request です。 */
export type RotateWebhookSecretRequest = IdempotentDomainMutationRequest & {
  /** Subscription を所有する Workspace ID です。 */
  workspaceId: string
  /** Rotation 対象 subscription ID です。 */
  subscriptionId: string
}

/** Webhook subscription status 更新 request です。 */
export type SetWebhookSubscriptionStatusRequest = RotateWebhookSecretRequest & {
  /** 更新後 status です。 */
  status: WebhookSubscription['status']
  /** Status 更新と同じ transaction で確定する endpoint response です。 */
  idempotencyResponse?: IdempotencyMutationResponse
}

/** Webhook subscription metadata 更新 request です。 */
export type UpdateWebhookSubscriptionRequest = RotateWebhookSecretRequest & {
  /** 検証する partial metadata 更新です。 */
  input: UpdateWebhookSubscriptionInput
  /** Metadata 更新と同じ transaction で確定する endpoint response です。 */
  idempotencyResponse?: IdempotencyMutationResponse
}

/** Webhook event enqueue request です。 */
export type EnqueueWebhookEventRequest = {
  /** Event を所有する Workspace ID です。 */
  workspaceId: string
  /** 現在の RBAC で event を配信できる subscription ID です。 */
  authorizedSubscriptionIds: string[]
  /** 配送する immutable event envelope です。 */
  event: WebhookEventEnvelope
}

/** Active Webhook subscription の内部pagination requestです。 */
export type ListActiveWebhookSubscriptionsPageRequest = {
  /** Subscription を所有する Workspace ID です。 */
  workspaceId: string
  /** 一 page の最大件数です。 */
  limit: number
  /** 前 page が返した内部 cursor です。 */
  cursor?: string
}

/** Active Webhook subscription の内部pagination結果です。 */
export type ActiveWebhookSubscriptionsPage = {
  /** Current active projectionを強整合再検証した subscription です。 */
  subscriptions: WebhookSubscription[]
  /** 次 page が存在する場合の内部 cursor です。 */
  nextCursor?: string
}

/** Webhook delivery page request です。 */
export type ListWebhookDeliveriesRequest = {
  /** Delivery を所有する Workspace ID です。 */
  workspaceId: string
  /** 指定時に絞り込む subscription ID です。 */
  subscriptionId?: string
  /** 一 page の最大件数です。 */
  limit?: number
  /** 前 page が返した opaque cursor です。 */
  cursor?: string
}

/** Cursor pagination された Webhook delivery です。 */
export type WebhookDeliveryPage = {
  /** 作成日時の降順で並んだ delivery です。 */
  deliveries: WebhookDelivery[]
  /** 次 page が存在する場合の opaque cursor です。 */
  nextCursor?: string
}

/** Webhook delivery detail の取得 request です。 */
export type GetWebhookDeliveryRequest = {
  /** Delivery を所有する Workspace ID です。 */
  workspaceId: string
  /** 取得する delivery ID です。 */
  deliveryId: string
}

/** Webhook worker が HTTP delivery に必要とする秘密情報です。 */
export type PreparedWebhookDelivery = {
  /** 現在の delivery state です。 */
  delivery: WebhookDelivery
  /** Delivery endpoint を持つ subscription です。 */
  subscription: WebhookSubscription
  /** Worker 内だけで利用し、log や API response に含めない signing secret です。 */
  signingSecret: string
  /** 署名対象の安定した JSON payload です。 */
  payload: string
}

/** Webhook delivery worker の取得 request です。 */
export type PrepareWebhookDeliveryRequest = {
  /** Delivery を所有する Workspace ID です。 */
  workspaceId: string
  /** 取得する delivery ID です。 */
  deliveryId: string
}

/** Webhook delivery attempt の保存 request です。 */
export type RecordWebhookDeliveryAttemptRequest = PrepareWebhookDeliveryRequest & {
  /** Attempt 後の delivery status です。 */
  status: WebhookDelivery['status']
  /** Remote endpoint の HTTP status です。 */
  responseStatus?: number
  /** Retry scheduler が次に配送できる日時です。 */
  nextAttemptAt?: string
  /** Secret を含まない短い error message です。 */
  error?: string
}

/** Webhook delivery replay request です。 */
export type ReplayWebhookDeliveryRequest = PrepareWebhookDeliveryRequest & {
  /** 同じ API mutation retry を一つの replay delivery に束縛する digest です。 */
  operationId?: string
}

/** Webhook signature 検証 request です。 */
export type VerifyWebhookSignatureRequest = {
  /** Subscription を所有する Workspace ID です。 */
  workspaceId: string
  /** Signing secret を解決する subscription ID です。 */
  subscriptionId: string
  /** HTTP request body の原文です。 */
  payload: string
  /** `X-Mukuroji-Timestamp` の epoch seconds です。 */
  timestamp: number
  /** `X-Mukuroji-Signature` の `v1=` 付き signature です。 */
  signature: string
  /** 許容する clock skew 秒です。 */
  toleranceSeconds?: number
}

/** Connector installation 作成入力です。 */
export type InstallConnectorInput = {
  /** Connector 分類です。 */
  category: ConnectorInstallation['category']
  /** GitHub や Slack などの provider code です。 */
  provider: ConnectorInstallation['provider']
  /** Installation の表示名です。 */
  name: string
  /** Connector に許可する API scope です。 */
  scopes: string[]
  /** Provider 側 account ID です。 */
  externalAccountId?: string
  /** Provider 側 account 表示名です。 */
  externalAccountName?: string
  /** SecretProtector で暗号化して保存する credential です。 */
  credential?: string
}

/** Connector installation 作成 request です。 */
export type InstallConnectorRequest = {
  /** Installation を所有する Workspace ID です。 */
  workspaceId: string
  /** Installation を開始した User ID です。 */
  installedByUserId: string
  /** 検証済み connector 入力です。 */
  input: InstallConnectorInput
}

/** Connector status 更新 request です。 */
export type UpdateConnectorStatusRequest = {
  /** Installation を所有する Workspace ID です。 */
  workspaceId: string
  /** 更新対象 installation ID です。 */
  installationId: string
  /** 更新後 status です。 */
  status: ConnectorInstallation['status']
  /** Secret を含まない provider error です。 */
  lastError?: ConnectorInstallation['lastError']
  /** 再認証開始 URL です。 */
  reauthorizationUrl?: string
  /** 成功した同期時刻です。 */
  lastSyncAt?: string
  /** `needs-reauth` transition に束縛する single-use OAuth state ID です。 */
  reauthorizationStateId?: string
  /** Lifecycle audit に記録する mutation actor User ID です。 */
  updatedByUserId?: string
  /** Flow/health snapshot を束縛する installation row revision です。 */
  expectedLifecycleRevision?: number
  /** Disconnect 前に provider で revoke 済みの serialized credential です。 */
  expectedCredential?: string
}

/** Secret-free connector lifecycle snapshot 取得 request です。 */
export type ReadConnectorLifecycleSnapshotRequest = {
  /** Installation を所有する Workspace ID です。 */
  workspaceId: string
  /** 取得対象 installation ID です。 */
  installationId: string
}

/** OAuth/status mutation を fencing する connector lifecycle snapshot です。 */
export type ConnectorLifecycleSnapshot = {
  /** Credential を含まない installation summary です。 */
  installation: ConnectorInstallation
  /** Installation row の optimistic-concurrency revision です。 */
  lifecycleRevision: number
  /** Pending disconnect cleanupをqueueへ束縛するstable operation revisionです。 */
  disconnectCleanupRevision?: number
}

/** Disconnected connector link のbounded pause requestです。 */
export type PauseConnectorExternalLinksPageRequest = {
  /** Installation を所有する Workspace ID です。 */
  workspaceId: string
  /** Pause対象 installation ID です。 */
  installationId: string
  /** Disconnect transitionを束縛する lifecycle revision です。 */
  expectedLifecycleRevision: number
  /** Lifecycle auditへ記録する actor User ID です。 */
  updatedByUserId?: string
  /** 一 job でpauseする最大 link 数です。 */
  limit: number
  /** 前 page が返した内部 cursor です。 */
  cursor?: string
}

/** Disconnected connector link のbounded pause結果です。 */
export type PauseConnectorExternalLinksPageResult = {
  /** このpageでpauseへ遷移した link 数です。 */
  paused: number
  /** 次 page が存在する場合の内部 cursor です。 */
  nextCursor?: string
}

/** Reauthorization callback の current OAuth state 検証 request です。 */
export type AssertConnectorReauthorizationStateRequest = {
  /** Installation を所有する Workspace ID です。 */
  workspaceId: string
  /** 検証対象 installation ID です。 */
  installationId: string
  /** Callback の encrypted flow から復元した state ID です。 */
  stateId: string
}

/** Connector credential 更新による復旧 request です。 */
export type RecoverConnectorRequest = {
  /** Installation を所有する Workspace ID です。 */
  workspaceId: string
  /** 復旧対象 installation ID です。 */
  installationId: string
  /** SecretProtector で暗号化して置換する credential です。 */
  credential: string
  /** Reauthorization callback が提示する current OAuth state ID です。 */
  expectedReauthorizationStateId?: string
  /** Refresh CAS が比較する置換前の serialized credential です。 */
  expectedCredential?: string
  /** Provider refresh 呼び出し前に取得した durable claim ID です。 */
  refreshClaimId?: string
  /** Credential replacement の lifecycle reason です。 */
  reason?: 'reauthorization' | 'refresh' | 'recovery'
  /** Lifecycle audit に記録する mutation actor User ID です。 */
  updatedByUserId?: string
}

/** Provider refresh side effect の durable claim request です。 */
export type ClaimConnectorCredentialRefreshRequest = {
  /** Installation を所有する Workspace ID です。 */
  workspaceId: string
  /** Refresh 対象 installation ID です。 */
  installationId: string
  /** Claim が比較する現在の serialized credential です。 */
  expectedCredential: string
  /** Refresh invocation を一意に束縛する claim ID です。 */
  claimId: string
}

/** Provider refresh side effect の durable claim 判定です。 */
export type ConnectorCredentialRefreshClaimResult =
  | 'claimed'
  | 'same-operation'
  | 'busy'
  | 'credential-changed'

/** Provider refresh side effect claim の解放 request です。 */
export type ReleaseConnectorCredentialRefreshRequest = {
  /** Installation を所有する Workspace ID です。 */
  workspaceId: string
  /** Refresh 対象 installation ID です。 */
  installationId: string
  /** 解放する current claim ID です。 */
  claimId: string
}

/** Connector worker 用 credential 取得 request です。 */
export type ReadConnectorCredentialRequest = {
  /** Installation を所有する Workspace ID です。 */
  workspaceId: string
  /** Credential を所有する installation ID です。 */
  installationId: string
}

/** External Work Item link 作成入力です。 */
export type CreateExternalWorkItemLinkInput = {
  /** Canonical Work Item を所有する Team ID です。 */
  teamId: string
  /** Canonical Work Item ID です。 */
  workItemId: string
  /** Link を管理する connector installation ID です。 */
  installationId: string
  /** Provider 側 resource 種別です。 */
  resourceType: ExternalWorkItemLink['resourceType']
  /** Provider account 内の immutable external ID です。 */
  externalId: string
  /** Provider resource の HTTPS URL です。 */
  externalUrl: string
  /** UI 用 provider key です。 */
  displayKey?: string
  /** 同期方向です。 */
  syncDirection: ExternalWorkItemLink['syncDirection']
}

/** External Work Item link 作成 request です。 */
export type CreateExternalWorkItemLinkRequest = {
  /** Link を所有する Workspace ID です。 */
  workspaceId: string
  /** 検証済み link 入力です。 */
  input: CreateExternalWorkItemLinkInput
}

/** External Work Item link list request です。 */
export type ListExternalWorkItemLinksRequest = {
  /** Link を所有する Workspace ID です。 */
  workspaceId: string
  /** Primary key で一件だけ取得する external link ID です。 */
  linkId?: string
  /** 指定時に絞り込む canonical Work Item ID です。 */
  workItemId?: string
  /** Work Item filter と組で指定する owner Team ID です。 */
  teamId?: string
  /** 指定時に絞り込む installation ID です。 */
  installationId?: string
  /** Installation filter と組で指定する provider resource 種別です。 */
  resourceType?: ExternalWorkItemLink['resourceType']
}

/** External Work Item link 更新 request です。 */
export type UpdateExternalWorkItemLinkRequest = IdempotentDomainMutationRequest & {
  /** Link を所有する Workspace ID です。 */
  workspaceId: string
  /** Link 先 Work Item を所有する Team ID です。 */
  teamId: string
  /** Link 先 Work Item ID です。 */
  workItemId: string
  /** 更新対象 link ID です。 */
  linkId: string
  /** Audit actor に保存する Workspace user ID です。 */
  updatedByUserId: string
  /** 検証済み更新入力です。 */
  input: UpdateExternalWorkItemLinkInput
}

/** External Work Item link delete request です。 */
export type DeleteExternalWorkItemLinkRequest = IdempotentDomainMutationRequest & {
  /** Link を所有する Workspace ID です。 */
  workspaceId: string
  /** Link 先 Work Item を所有する Team ID です。 */
  teamId: string
  /** Link 先 Work Item ID です。 */
  workItemId: string
  /** 削除対象 link ID です。 */
  linkId: string
  /** Audit actor に保存する Workspace user または credential ID です。 */
  deletedByActorId?: string
}

/** Import job 作成入力です。 */
export type CreateImportJobInput = {
  /** Source file format です。 */
  format: ImportJob['format']
  /** Imported Work Item を所有する Team ID です。 */
  teamId: string
  /** Imported Work Item の既定 assigned Project ID です。 */
  assignedProjectId?: string
  /** Source column から canonical field への mapping です。 */
  mapping: ImportJob['mapping']
  /** 永続化せず検証・report だけ行うかどうかです。 */
  dryRun?: boolean
}

/** Import job 作成 request です。 */
export type CreateImportJobRequest = {
  /** Import 対象 Workspace ID です。 */
  workspaceId: string
  /** Import を開始した User ID です。 */
  createdByUserId: string
  /** Queue retry 間で固定できる deterministic Import job ID です。 */
  jobId?: string
  /** 検証済み import 入力です。 */
  input: CreateImportJobInput
}

/** Import job 更新 request です。 */
export type UpdateImportJobRequest = {
  /** Import 対象 Workspace ID です。 */
  workspaceId: string
  /** 更新対象 job ID です。 */
  jobId: string
  /** 更新後 status です。 */
  status: ImportJob['status']
  /** 完了、dry-run、または validation failure の bounded report です。 */
  report?: ImportJob['report']
  /** Secret や source row を含まない error です。 */
  error?: ImportJob['error']
}

/** Idempotency reservation request です。 */
export type ReserveIdempotencyRequest = {
  /** Request を処理する Workspace ID です。 */
  workspaceId: string
  /** Rate limit と idempotency を分離する credential ID です。 */
  credentialId: string
  /** HTTP `Idempotency-Key` の原文です。 */
  idempotencyKey: string
  /** Method、path、body から作成した stable fingerprint です。 */
  requestFingerprint: string
  /** Reservation と response を保持する秒数です。 */
  ttlSeconds?: number
}

/** Idempotency reservation の判定結果です。 */
export type IdempotencyDecision =
  | {
      /** 初回 caller が処理を開始できる状態です。 */
      status: 'reserved'
      /** 完了保存を最初の caller に束縛する token です。 */
      reservationId: string
    }
  | {
      /** 同一 request がまだ処理中である状態です。 */
      status: 'in-progress'
    }
  | {
      /** 保存済み response をそのまま返せる状態です。 */
      status: 'replay'
      /** 前回処理が保存した JSON-safe response です。 */
      response: unknown
    }

/** Idempotent request 完了保存 request です。 */
export type CompleteIdempotencyRequest = ReserveIdempotencyRequest & {
  /** Reserve 時に返された ownership token です。 */
  reservationId: string
  /** Replay 時に返す JSON-safe response です。 */
  response: unknown
}

/** Domain mutation と同じ DynamoDB transaction に追加する idempotency completion です。 */
export type IdempotencyCompletionTransactWrite = {
  /** Reserved receipt を encrypted completed receipt へ置換する transaction item です。 */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/** Work Item 削除と同じ transaction に追加する external-link fence 入力です。 */
export type PrepareWorkItemDeletionFenceRequest = {
  /** Work Item を所有する Workspace ID です。 */
  workspaceId: string
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** 削除対象 Work Item ID です。 */
  workItemId: string
}

/** Work Item 削除と external-link 作成を直列化する transaction item です。 */
export type WorkItemDeletionFenceTransactWrite = {
  /** Link count が 0 の場合だけ durable tombstone を保存する transaction item です。 */
  transactWriteItem: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
}

/** 未完了 idempotency reservation の解放 request です。 */
export type ReleaseIdempotencyRequest = ReserveIdempotencyRequest & {
  /** Reserve 時に返された ownership token です。 */
  reservationId: string
}

/** Fixed-window rate limit 消費 request です。 */
export type ConsumeRateLimitRequest = {
  /** Credential が所属する Workspace ID です。 */
  workspaceId: string
  /** Window を分離する credential ID です。 */
  credentialId: string
  /** Window 内に許可する request cost です。 */
  limit: number
  /** Fixed window の秒数です。 */
  windowSeconds: number
  /** この request が消費する cost です。 */
  cost?: number
}

/** Fixed-window rate limit の現在値です。 */
export type RateLimitDecision = {
  /** Request を処理できるかどうかです。 */
  allowed: boolean
  /** Window の上限です。 */
  limit: number
  /** この判定後に残る cost です。 */
  remaining: number
  /** Fixed window が reset される日時です。 */
  resetAt: string
  /** 拒否時に待つ秒数です。 */
  retryAfterSeconds?: number
}

/** Developer platform domain/store の公開契約です。 */
export interface DeveloperPlatformClient {
  /** API key を作成し、secret を一度だけ返します。 */
  createApiKey(request: CreateApiKeyRequest): Promise<ApiKeySecretResult>
  /** Workspace の secret を含まない API key summary を返します。 */
  listApiKeys(workspaceId: string): Promise<ApiKeySummary[]>
  /** API key secret を置換し、新 secret を一度だけ返します。 */
  rotateApiKey(request: RotateApiKeyRequest): Promise<ApiKeySecretResult>
  /** API key を revoke します。 */
  revokeApiKey(request: RevokeApiKeyRequest): Promise<ApiKeySummary>
  /** API key secret を認証し、last-used を更新します。 */
  authenticateApiKey(
    request: AuthenticateCredentialRequest,
  ): Promise<AuthenticatedDeveloperCredential>
  /** OAuth app を作成し、client secret を一度だけ返します。 */
  createOAuthApp(request: CreateOAuthAppRequest): Promise<OAuthAppSecretResult>
  /** Workspace の secret を含まない OAuth app summary を返します。 */
  listOAuthApps(workspaceId: string): Promise<OAuthAppSummary[]>
  /** OAuth client secret を置換し、新 secret を一度だけ返します。 */
  rotateOAuthClientSecret(
    request: RotateOAuthClientSecretRequest,
  ): Promise<OAuthAppSecretResult>
  /** OAuth app と配下 token を revoke します。 */
  revokeOAuthApp(request: RevokeOAuthAppRequest): Promise<OAuthAppSummary>
  /** client_credentials を検証し、digest だけ保存する token を発行します。 */
  issueOAuthToken(request: IssueOAuthTokenRequest): Promise<OAuthTokenResult>
  /** Bearer token を認証します。 */
  authenticateOAuthToken(
    request: AuthenticateCredentialRequest,
  ): Promise<AuthenticatedDeveloperCredential>
  /** Webhook subscription を作成し、signing secret を一度だけ返します。 */
  createWebhookSubscription(
    request: CreateWebhookSubscriptionRequest,
  ): Promise<WebhookSecretResult>
  /** Workspace の secret を含まない Webhook subscription を返します。 */
  listWebhookSubscriptions(workspaceId: string): Promise<WebhookSubscription[]>
  /** Active Webhook subscription projection を bounded page 取得します。 */
  listActiveWebhookSubscriptionsPage(
    request: ListActiveWebhookSubscriptionsPageRequest,
  ): Promise<ActiveWebhookSubscriptionsPage>
  /** Webhook signing secret を置換し、新 secret を一度だけ返します。 */
  rotateWebhookSecret(request: RotateWebhookSecretRequest): Promise<WebhookSecretResult>
  /** Webhook subscription status を更新します。 */
  setWebhookSubscriptionStatus(
    request: SetWebhookSubscriptionStatusRequest,
  ): Promise<WebhookSubscription>
  /** Webhook subscription metadata と status を原子的に更新します。 */
  updateWebhookSubscription(
    request: UpdateWebhookSubscriptionRequest,
  ): Promise<WebhookSubscription>
  /** Event に一致する subscription へ delivery を冪等に enqueue します。 */
  enqueueWebhookEvent(request: EnqueueWebhookEventRequest): Promise<WebhookDelivery[]>
  /** Webhook delivery log を cursor pagination します。 */
  listWebhookDeliveries(
    request: ListWebhookDeliveriesRequest,
  ): Promise<WebhookDeliveryPage>
  /** Webhook delivery を tenant-bound ID lookup で取得します。 */
  getWebhookDelivery(request: GetWebhookDeliveryRequest): Promise<WebhookDelivery>
  /** Worker 用 payload と signing secret を安全な内部境界で解決します。 */
  prepareWebhookDelivery(
    request: PrepareWebhookDeliveryRequest,
  ): Promise<PreparedWebhookDelivery>
  /** Webhook attempt 結果を保存します。 */
  recordWebhookDeliveryAttempt(
    request: RecordWebhookDeliveryAttemptRequest,
  ): Promise<WebhookDelivery>
  /** Original delivery を保存したまま新しい pending replay を作成します。 */
  replayWebhookDelivery(request: ReplayWebhookDeliveryRequest): Promise<WebhookDelivery>
  /** Incoming webhook signature を timing-safe に検証します。 */
  verifyWebhookSignature(request: VerifyWebhookSignatureRequest): Promise<boolean>
  /** Connector credential を暗号化して installation を作成します。 */
  installConnector(request: InstallConnectorRequest): Promise<ConnectorInstallation>
  /** Workspace の credential を含まない connector summary を返します。 */
  listConnectors(workspaceId: string): Promise<ConnectorInstallation[]>
  /** Strongly consistent lifecycle snapshot と revision を返します。 */
  readConnectorLifecycleSnapshot(
    request: ReadConnectorLifecycleSnapshotRequest,
  ): Promise<ConnectorLifecycleSnapshot>
  /** Connector の current health status を保存します。 */
  updateConnectorStatus(
    request: UpdateConnectorStatusRequest,
  ): Promise<ConnectorInstallation>
  /** Provider code exchange 前に reauthorization state が current か検証します。 */
  assertConnectorReauthorizationState(
    request: AssertConnectorReauthorizationStateRequest,
  ): Promise<void>
  /** Provider refresh side effect の実行権を credential-bound lease で取得します。 */
  claimConnectorCredentialRefresh(
    request: ClaimConnectorCredentialRefreshRequest,
  ): Promise<ConnectorCredentialRefreshClaimResult>
  /** Provider side effect 前後の失敗時に current refresh claim を解放します。 */
  releaseConnectorCredentialRefresh(
    request: ReleaseConnectorCredentialRefreshRequest,
  ): Promise<boolean>
  /** Credential を置換して connector を connected へ復旧します。 */
  recoverConnector(request: RecoverConnectorRequest): Promise<ConnectorInstallation>
  /** Connector worker 内でのみ使う credential を復号します。 */
  readConnectorCredential(request: ReadConnectorCredentialRequest): Promise<string>
  /** Disconnected installation の external links を bounded page でpauseします。 */
  pauseConnectorExternalLinksPage(
    request: PauseConnectorExternalLinksPageRequest,
  ): Promise<PauseConnectorExternalLinksPageResult>
  /** External resource と canonical Work Item の一意な link を作成します。 */
  createExternalWorkItemLink(
    request: CreateExternalWorkItemLinkRequest,
  ): Promise<ExternalWorkItemLink>
  /** Workspace 内の external link を取得します。 */
  listExternalWorkItemLinks(
    request: ListExternalWorkItemLinksRequest,
  ): Promise<ExternalWorkItemLink[]>
  /** External link の同期方向・状態を tenant-bound CAS で更新します。 */
  updateExternalWorkItemLink(
    request: UpdateExternalWorkItemLinkRequest,
  ): Promise<ExternalWorkItemLink>
  /** External link と uniqueness claim を削除します。 */
  deleteExternalWorkItemLink(
    request: DeleteExternalWorkItemLinkRequest,
  ): Promise<void>
  /** Import job を queued 状態で作成します。 */
  createImportJob(request: CreateImportJobRequest): Promise<ImportJob>
  /** Workspace の Import job を作成日時降順で返します。 */
  listImportJobs(workspaceId: string): Promise<ImportJob[]>
  /** Import job state と report を保存します。 */
  updateImportJob(request: UpdateImportJobRequest): Promise<ImportJob>
  /** Idempotency key を reserve、replay、または conflict 判定します。 */
  reserveIdempotency(request: ReserveIdempotencyRequest): Promise<IdempotencyDecision>
  /** Reserve owner だけが response を保存できます。 */
  completeIdempotency(request: CompleteIdempotencyRequest): Promise<void>
  /**
   * Domain mutation と response receipt を同じ DynamoDB transaction へ束縛します。
   * DynamoDB-backed client だけが提供し、他の実装は通常の完了保存へ fallback します。
   */
  prepareIdempotencyCompletionTransactWrite?(
    request: CompleteIdempotencyRequest,
  ): Promise<IdempotencyCompletionTransactWrite>
  /** Work Item delete transaction に external-link existence fence を追加します。 */
  prepareWorkItemDeletionFenceTransactWrite?(
    request: PrepareWorkItemDeletionFenceRequest,
  ): Promise<WorkItemDeletionFenceTransactWrite>
  /** 失敗した処理の Reserve owner だけが未完了 reservation を解放できます。 */
  releaseIdempotency(request: ReleaseIdempotencyRequest): Promise<void>
  /** Credential ごとの fixed-window rate limit を原子的に消費します。 */
  consumeRateLimit(request: ConsumeRateLimitRequest): Promise<RateLimitDecision>
}

/** Secret を storage-safe ciphertext へ変換する境界です。 */
export interface SecretProtector {
  /** Context-bound authenticated encryption を行います。 */
  protect(plaintext: string, context: string): Promise<string>
  /** Context-bound ciphertext を復号・検証します。 */
  unprotect(ciphertext: string, context: string): Promise<string>
}

/** KMS envelope encryption で鍵を分離する用途です。 */
export type KmsEnvelopePurpose = 'webhook' | 'connector' | 'platform-state'

/** GenerateDataKey の構造化入力です。 */
export type KmsGenerateDataKeyRequest = {
  /** 利用する KMS key ID または ARN です。 */
  keyId: string
  /** KMS が認証する暗号化 context です。 */
  encryptionContext: Readonly<Record<string, string>>
}

/** GenerateDataKey の必要最小 response です。 */
export type KmsGenerateDataKeyResult = {
  /** 一度だけ利用して zeroize する 256-bit plaintext data key です。 */
  plaintext: Uint8Array
  /** Envelope に保存する KMS encrypted data key です。 */
  ciphertextBlob: Uint8Array
}

/** Decrypt の構造化入力です。 */
export type KmsDecryptRequest = {
  /** Envelope の data key を暗号化した KMS key ID または ARN です。 */
  keyId: string
  /** Envelope に保存された KMS encrypted data key です。 */
  ciphertextBlob: Uint8Array
  /** GenerateDataKey と完全一致させる暗号化 context です。 */
  encryptionContext: Readonly<Record<string, string>>
}

/** Decrypt の必要最小 response です。 */
export type KmsDecryptResult = {
  /** 一度だけ利用して zeroize する 256-bit plaintext data key です。 */
  plaintext: Uint8Array
}

/** AWS KMS SDK を構造型で注入する envelope encryption 境界です。 */
export interface KmsEnvelopeClient {
  /** AES-256 data key と encrypted copy を生成します。 */
  generateDataKey(request: KmsGenerateDataKeyRequest): Promise<KmsGenerateDataKeyResult>
  /** Envelope の encrypted data key を復号します。 */
  decrypt(request: KmsDecryptRequest): Promise<KmsDecryptResult>
}

/** Purpose ごとの KMS key ID です。 */
export type KmsEnvelopeKeyIds = {
  /** Webhook signing secret 専用 key です。 */
  webhook?: string
  /** Connector provider credential 専用 key です。 */
  connector?: string
  /** Idempotency response と cursor 専用 key です。 */
  platformState?: string
}

/** Developer platform API/store の安定した error です。 */
export class DeveloperPlatformError extends Error {
  /** HTTP response に対応する status code です。 */
  readonly status: number
  /** External client が分岐に使える stable error code です。 */
  readonly code: string

  constructor(status: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DeveloperPlatformError'
    this.status = status
    this.code = code
  }
}

/** Local/test で利用できる AES-256-GCM SecretProtector です。 */
export class LocalAesGcmSecretProtector implements SecretProtector {
  /** AES-256 key bytes です。 */
  private readonly encryptionKey: Buffer

  constructor(key: string | Uint8Array = randomBytes(32)) {
    if (typeof key === 'string') {
      const normalized = key.trim()
      if (Buffer.byteLength(normalized, 'utf8') < 32) {
        throw new DeveloperPlatformError(
          500,
          'SecretProtectorKeyInvalid',
          'Secret protector key must contain at least 32 UTF-8 bytes.',
        )
      }
      this.encryptionKey = createHash('sha256').update(normalized).digest()
      return
    }
    if (key.byteLength !== 32) {
      throw new DeveloperPlatformError(
        500,
        'SecretProtectorKeyInvalid',
        'Secret protector key must contain 32 bytes.',
      )
    }
    this.encryptionKey = Buffer.from(key)
  }

  /** AES-GCM と context AAD で secret を暗号化します。 */
  async protect(plaintext: string, context: string) {
    const normalizedContext = requireText(context, 'Secret protection context')
    const initializationVector = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, initializationVector)
    cipher.setAAD(Buffer.from(normalizedContext, 'utf8'))
    const ciphertext = Buffer.concat([
      cipher.update(requireText(plaintext, 'Protected secret'), 'utf8'),
      cipher.final(),
    ])
    const authenticationTag = cipher.getAuthTag()
    return [
      'v1',
      initializationVector.toString('base64url'),
      ciphertext.toString('base64url'),
      authenticationTag.toString('base64url'),
    ].join('.')
  }

  /** AES-GCM authentication tag と context AAD を検証して復号します。 */
  async unprotect(ciphertext: string, context: string) {
    const [version, initializationVector, encrypted, authenticationTag, extra] =
      ciphertext.split('.')
    if (
      version !== 'v1' ||
      !initializationVector ||
      !encrypted ||
      !authenticationTag ||
      extra !== undefined
    ) {
      throw new DeveloperPlatformError(
        400,
        'ProtectedSecretInvalid',
        'Protected secret is invalid.',
      )
    }
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        Buffer.from(initializationVector, 'base64url'),
      )
      decipher.setAAD(Buffer.from(requireText(context, 'Secret protection context'), 'utf8'))
      decipher.setAuthTag(Buffer.from(authenticationTag, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    } catch (error) {
      if (error instanceof DeveloperPlatformError) throw error
      throw new DeveloperPlatformError(
        400,
        'ProtectedSecretInvalid',
        'Protected secret could not be authenticated.',
      )
    }
  }
}

/** AWS KMS data key と local AES-GCM を組み合わせる production protector です。 */
export class KmsEnvelopeSecretProtector implements SecretProtector {
  /** GenerateDataKey/Decrypt の注入境界です。 */
  private readonly kmsClient: KmsEnvelopeClient
  /** Purpose ごとに分離した KMS key ID です。 */
  private readonly keyIds: KmsEnvelopeKeyIds

  constructor(kmsClient: KmsEnvelopeClient, keyIds: KmsEnvelopeKeyIds) {
    this.kmsClient = kmsClient
    this.keyIds = {
      ...(keyIds.webhook
        ? { webhook: requireText(keyIds.webhook, 'Webhook KMS key ID') }
        : {}),
      ...(keyIds.connector
        ? { connector: requireText(keyIds.connector, 'Connector KMS key ID') }
        : {}),
      ...(keyIds.platformState
        ? { platformState: requireText(keyIds.platformState, 'Platform state KMS key ID') }
        : {}),
    }
  }

  /** KMS data key を一度だけ使い、context-bound AES-GCM envelope を作成します。 */
  async protect(plaintext: string, context: string) {
    const normalizedPlaintext = requireText(plaintext, 'Protected secret')
    const normalizedContext = requireText(context, 'Secret protection context')
    const purpose = readKmsEnvelopePurpose(normalizedContext)
    const keyId = readKmsKeyId(this.keyIds, purpose)
    const encryptionContext = createKmsEncryptionContext(purpose, normalizedContext)
    let generated: KmsGenerateDataKeyResult | undefined
    let dataKey: Buffer | undefined
    try {
      generated = await this.kmsClient.generateDataKey({ keyId, encryptionContext })
      dataKey = Buffer.from(generated.plaintext)
      if (dataKey.byteLength !== 32 || generated.ciphertextBlob.byteLength === 0) {
        throw new Error('KMS returned invalid data key material.')
      }
      const initializationVector = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', dataKey, initializationVector)
      cipher.setAAD(Buffer.from(createKmsEnvelopeAad(purpose, keyId, normalizedContext)))
      const encrypted = Buffer.concat([
        cipher.update(normalizedPlaintext, 'utf8'),
        cipher.final(),
      ])
      return [
        'kms-v1',
        purpose,
        Buffer.from(generated.ciphertextBlob).toString('base64url'),
        initializationVector.toString('base64url'),
        encrypted.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
      ].join('.')
    } catch {
      throw new DeveloperPlatformError(
        500,
        'SecretProtectionFailed',
        'Secret could not be protected.',
      )
    } finally {
      dataKey?.fill(0)
      generated?.plaintext.fill(0)
    }
  }

  /** KMS data key と AES-GCM AAD を検証し、平文 key を必ず zeroize します。 */
  async unprotect(ciphertext: string, context: string) {
    const normalizedCiphertext = requireText(ciphertext, 'Protected secret')
    const normalizedContext = requireText(context, 'Secret protection context')
    const expectedPurpose = readKmsEnvelopePurpose(normalizedContext)
    const [
      version,
      storedPurpose,
      encryptedDataKey,
      initializationVector,
      encrypted,
      authenticationTag,
      extra,
    ] = normalizedCiphertext.split('.')
    if (
      version !== 'kms-v1' ||
      storedPurpose !== expectedPurpose ||
      !encryptedDataKey ||
      !initializationVector ||
      !encrypted ||
      !authenticationTag ||
      extra !== undefined
    ) {
      throw new DeveloperPlatformError(
        400,
        'ProtectedSecretInvalid',
        'Protected secret is invalid.',
      )
    }
    const purpose = storedPurpose as KmsEnvelopePurpose
    const keyId = readKmsKeyId(this.keyIds, purpose)
    const encryptionContext = createKmsEncryptionContext(purpose, normalizedContext)
    let decrypted: KmsDecryptResult | undefined
    let dataKey: Buffer | undefined
    try {
      decrypted = await this.kmsClient.decrypt({
        keyId,
        ciphertextBlob: Buffer.from(encryptedDataKey, 'base64url'),
        encryptionContext,
      })
      dataKey = Buffer.from(decrypted.plaintext)
      if (dataKey.byteLength !== 32) throw new Error('KMS returned invalid plaintext key.')
      const decipher = createDecipheriv(
        'aes-256-gcm',
        dataKey,
        Buffer.from(initializationVector, 'base64url'),
      )
      decipher.setAAD(Buffer.from(createKmsEnvelopeAad(purpose, keyId, normalizedContext)))
      decipher.setAuthTag(Buffer.from(authenticationTag, 'base64url'))
      return Buffer.concat([
        decipher.update(Buffer.from(encrypted, 'base64url')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      throw new DeveloperPlatformError(
        400,
        'ProtectedSecretInvalid',
        'Protected secret could not be authenticated.',
      )
    } finally {
      dataKey?.fill(0)
      decrypted?.plaintext.fill(0)
    }
  }
}

/** Single-table row discriminator です。 */
type DeveloperPlatformEntryType =
  | 'api-key'
  | 'credential-auth'
  | 'oauth-app'
  | 'oauth-token'
  | 'webhook-subscription'
  | 'webhook-active-subscription'
  | 'webhook-subscription-quota'
  | 'webhook-delivery'
  | 'webhook-delivery-index'
  | 'connector-installation'
  | 'connector-poll-target'
  | 'external-link'
  | 'external-link-index'
  | 'external-link-claim'
  | 'work-item-link-fence'
  | 'import-job'
  | 'idempotency'
  | 'rate-limit'

/** Developer platform single-table の共通 row です。 */
type DeveloperPlatformRecord = {
  /** DynamoDB partition key である Workspace ID です。 */
  workspaceId: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Row の domain discriminator です。 */
  entryType: DeveloperPlatformEntryType
  /** Secret を除く domain value です。 */
  value: unknown
  /** Global secondary index partition key です。 */
  lookupKey?: string
  /** Global secondary index sort key です。 */
  lookupSortKey?: string
  /** API key、OAuth secret/token の SHA-256 digest です。 */
  secretDigest?: string
  /** Webhook/connector credential の authenticated ciphertext です。 */
  secretCiphertext?: string
  /** Connector credential の serialized value を束縛する SHA-256 digest です。 */
  connectorCredentialDigest?: string
  /** Connector credential replacement の単調増加 revision です。 */
  connectorCredentialRevision?: number
  /** Current provider refresh claim ID の SHA-256 digest です。 */
  connectorCredentialRefreshClaimDigest?: string
  /** Current provider refresh claim を取得した timestamp です。 */
  connectorCredentialRefreshClaimedAt?: string
  /** Current connector OAuth reauthorization state ID の SHA-256 digest です。 */
  connectorOAuthStateDigest?: string
  /** Connector OAuth state fencing の単調増加 revision です。 */
  connectorOAuthStateRevision?: number
  /** External-link pause 完了まで reauthorization を防ぐ disconnect revision です。 */
  connectorDisconnectCleanupRevision?: number
  /** DynamoDB TTL epoch seconds です。 */
  expiresAt?: number
  /** Fixed-window rate limit の消費量です。 */
  consumed?: number
  /** Work Item に現在紐づく external-link 数です。 */
  activeLinkCount?: number
  /** Workspace に作成済みの Webhook subscription 数です。 */
  subscriptionCount?: number
  /** Connector installation に作成済みの external-link 数です。 */
  externalLinkCount?: number
  /** Installation/resource に現在存在する pollable external-link 数です。 */
  pollableLinkCount?: number
  /** Optimistic conditional update 用 version です。 */
  version: number
}

/** Eventual-consistent lookup index から得る primary-key locator です。 */
type DeveloperPlatformRecordLocator = {
  /** DynamoDB partition key である Workspace ID です。 */
  workspaceId: string
  /** DynamoDB sort key です。 */
  recordKey: string
  /** Global secondary index partition key です。 */
  lookupKey: string
  /** Global secondary index sort key です。 */
  lookupSortKey: string
}

/** Strongly consistent credential 認証 row が指す domain locator です。 */
type StoredCredentialAuthValue = {
  /** Credential の種別です。 */
  kind: 'api-key' | 'oauth-client' | 'oauth-token'
  /** Credential domain row の Workspace ID です。 */
  targetWorkspaceId: string
  /** Credential domain row の sort key です。 */
  targetRecordKey: string
}

/** Active Webhook subscription locator の secret-free value です。 */
type StoredActiveWebhookSubscriptionValue = {
  /** Current subscription base row の sort key です。 */
  targetRecordKey: string
}

/** Active Webhook locator migration中の内部cursorです。 */
type ActiveWebhookSubscriptionCursor =
  | {
      /** Cursor schema versionです。 */
      version: 1
      /** Primary locator query phaseです。 */
      phase: 'primary'
      /** Tenant bindingです。 */
      workspaceId: string
      /** Primary queryの排他的開始sort keyです。 */
      recordKey?: string
    }
  | {
      /** Cursor schema versionです。 */
      version: 1
      /** Retain済みGSI rowだけを読むmigration fallback phaseです。 */
      phase: 'legacy'
      /** Tenant bindingです。 */
      workspaceId: string
      /** Legacy GSI partition keyです。 */
      lookupKey: string
      /** GSI queryの排他的開始locatorです。 */
      locator?: DeveloperPlatformRecordLocator
    }

/** Credential auth row の条件付き Put です。 */
type CredentialAuthRecordWrite = {
  /** 保存する auth row です。 */
  record: DeveloperPlatformRecord
  /** Auth row に適用する作成・version 条件です。 */
  condition: PutRecordCondition
}

/** Credential auth row の条件付き Delete です。 */
type CredentialAuthRecordDelete = {
  /** 削除する auth row の partition key です。 */
  workspaceId: string
  /** 削除する auth row の sort key です。 */
  recordKey: string
  /** 削除対象 auth row の期待 version です。 */
  expectedVersion: number
}

/** Webhook delivery row の非公開 value です。 */
type StoredWebhookDeliveryValue = {
  /** Public delivery summary です。 */
  delivery: WebhookDelivery
  /** Worker が配送する immutable event envelope です。 */
  event: WebhookEventEnvelope
  /** Secret を除いた最新 attempt error です。 */
  lastError?: string
}

/** Webhook delivery access pattern を指す immutable locator row です。 */
type StoredWebhookDeliveryIndexValue = {
  /** Locator の access pattern です。 */
  kind: 'workspace-list' | 'subscription-list' | 'replay-chain'
  /** 強整合再取得する delivery 本体の record key です。 */
  targetRecordKey: string
}

/** OAuth token row の非公開 value です。 */
type StoredOAuthTokenValue = {
  /** Token の opaque ID です。 */
  id: string
  /** Token を発行した OAuth app ID です。 */
  oauthAppId: string
  /** Request ごとに active membership/RBAC を再評価する subject User ID です。 */
  subjectUserId: string
  /** Token scope です。 */
  scopes: ApiScope[]
  /** Token 発行日時です。 */
  createdAt: string
  /** Token 失効日時です。 */
  expiresAt: string
  /** Token の最終利用日時です。 */
  lastUsedAt?: string
}

/** Workspace Webhook subscription quota row の非公開 value です。 */
type StoredWebhookSubscriptionQuotaValue = {
  /** Quota row が適用する immutable subscription 上限です。 */
  limit: typeof WEBHOOK_SUBSCRIPTION_LIMIT
}

/** Installation/resource ごとの materialized connector poll target です。 */
type StoredConnectorPollTargetValue = {
  /** Connector installation ID です。 */
  installationId: string
  /** Provider resource 種別です。 */
  resourceType: ExternalWorkItemLink['resourceType']
}

/** Idempotency row の非公開 value です。 */
type StoredIdempotencyValue = {
  /** 同じ raw key に対する request fingerprint digest です。 */
  requestFingerprintDigest: string
  /** Reservation 所有 token の SHA-256 digest です。 */
  reservationDigest: string
  /** Reservation state です。 */
  state: 'reserved' | 'completed'
  /** Completed request の context-bound authenticated ciphertext です。 */
  responseCiphertext?: string
  /** Reservation 作成日時です。 */
  createdAt: string
}

/** Domain row と同時 commit する暗号化済み idempotency receipt です。 */
type PreparedIdempotencyCompletionRecord = {
  /** Transaction が置換する completed idempotency row です。 */
  completedRecord: DeveloperPlatformRecord
  /** Transaction 開始時に存在すべき reserved row です。 */
  reservedRecord: DeveloperPlatformRecord
  /** Current owner を束縛する reservation digest です。 */
  reservationDigest: string
  /** Current request を束縛する fingerprint digest です。 */
  requestFingerprintDigest: string
}

/** External link uniqueness claim の非公開 value です。 */
type StoredExternalLinkClaimValue = {
  /** Claim が所有する external link record key です。 */
  targetRecordKey: string
}

/** External link の bounded list access pattern を指す locator row です。 */
type StoredExternalLinkIndexValue = {
  /** Index が表す access pattern です。 */
  kind: 'work-item' | 'installation'
  /** Strongly consistent に再取得する external link record key です。 */
  targetRecordKey: string
}

/** Work Item ごとの active external-link count と deletion fence です。 */
type StoredWorkItemLinkFenceValue = {
  /** Link 対象を所有する Team ID です。 */
  teamId: string
  /** Link 対象 Work Item ID です。 */
  workItemId: string
  /** Work Item が削除された時刻です。存在する場合は新規 link を拒否します。 */
  deletedAt?: string
}

/** Webhook cursor の暗号化 payload です。 */
type WebhookDeliveryCursor = {
  /** Cursor format version です。 */
  version: 2
  /** Cursor を利用できる Workspace ID です。 */
  workspaceId: string
  /** Cursor を利用できる subscription filter です。 */
  subscriptionId?: string
  /** 次 page の ExclusiveStartKey に使う GSI partition key です。 */
  lookupKey: string
  /** 次 page の ExclusiveStartKey に使う GSI sort key です。 */
  lookupSortKey: string
  /** 次 page の ExclusiveStartKey に使う base-table sort key です。 */
  recordKey: string
}

/** LookupKeyIndex の bounded query 入力です。 */
type QueryLookupIndexRequest = {
  /** Query 対象 GSI partition key です。 */
  lookupKey: string
  /** DynamoDB が評価する最大 item 数です。 */
  limit: number
  /** 昇順なら true、降順なら false です。 */
  scanIndexForward: boolean
  /** 前 page の排他的開始位置です。 */
  exclusiveStartKey?: DeveloperPlatformRecordLocator
}

/** LookupKeyIndex の bounded query 結果です。 */
type QueryLookupIndexResult = {
  /** GSI projection から読み取った base-table locator です。 */
  locators: DeveloperPlatformRecordLocator[]
  /** 続きがある場合の最終評価 key です。 */
  lastEvaluatedKey?: DeveloperPlatformRecordLocator
}

/** Base-table prefix query のbounded page結果です。 */
type ListRecordsPageResult = {
  /** Current page のstrongly consistent rows です。 */
  records: DeveloperPlatformRecord[]
  /** 次 page が存在する場合のbase-table sort keyです。 */
  nextRecordKey?: string
}

/** Conditional put の条件です。 */
type PutRecordCondition = {
  /** Row が存在しない場合だけ作成するかどうかです。 */
  ifAbsent?: boolean
  /** 現在の version が一致する場合だけ置換します。 */
  expectedVersion?: number
}

/** Developer platform lifecycle を audit/Webhook outbox event に変換する入力です。 */
type PlatformAuditEventInput = {
  /** Event を所有する Workspace ID です。 */
  workspaceId: string
  /** Webhook contract と一致する event type です。 */
  eventType: string
  /** Audit timeline の entity type です。 */
  entityType: string
  /** Workspace 内で安定した entity ID です。 */
  entityId: string
  /** Retry 間で変わらない transition identity です。 */
  transitionId: string
  /** Team selector authorization に使う optional Team ID です。 */
  teamId?: string
  /** Project selector authorization に使う optional Project ID です。 */
  projectId?: string
  /** Event 発生日時です。 */
  occurredAt: string
  /** Audit action code です。 */
  action: string
  /** Activity と delivery log に表示できる概要です。 */
  summary: string
  /** Secret や source row を含まない追加 metadata です。 */
  metadata?: Readonly<Record<string, unknown>>
  /** Mutation actor ID です。 */
  actorId?: string
}

/** External link と claim を同時保存する結果です。 */
type SaveExternalLinkResult =
  | 'created'
  | 'same-owner'
  | 'conflict'
  | 'installation-changed'
  | 'installation-limit-exceeded'
  | 'work-item-limit-exceeded'
  | 'work-item-deleted'

/** Storage 固有の fixed-window 原子更新入力です。 */
type ConsumeRateLimitStorageInput = {
  /** Credential の Workspace ID です。 */
  workspaceId: string
  /** Window row の sort key です。 */
  recordKey: string
  /** Window 上限です。 */
  limit: number
  /** 消費する cost です。 */
  cost: number
  /** Window reset timestamp です。 */
  resetAt: string
  /** DynamoDB TTL epoch seconds です。 */
  expiresAt: number
}

/** Storage 固有の fixed-window 原子更新結果です。 */
type ConsumeRateLimitStorageResult = {
  /** Limit 内で消費できたかどうかです。 */
  allowed: boolean
  /** 判定後の消費量です。 */
  consumed: number
}

/** Rate-limit row の非公開 value です。 */
type StoredRateLimitValue = {
  /** Fixed window に設定した上限です。 */
  limit: number
  /** Fixed window の reset timestamp です。 */
  resetAt: string
}

/** Storage primitives を共有 domain implementation へ接続する基底 class です。 */
abstract class BaseDeveloperPlatformClient implements DeveloperPlatformClient {
  /** Webhook/connector secret と cursor を暗号化する protector です。 */
  protected readonly secretProtector: SecretProtector
  /** Test から差し替え可能な clock です。 */
  protected readonly clock: () => Date
  /** Platform lifecycle event を保存する immutable audit outbox table 名です。 */
  protected readonly auditTableName?: string

  constructor(
    secretProtector: SecretProtector,
    clock: () => Date,
    auditTableName?: string,
  ) {
    this.secretProtector = secretProtector
    this.clock = clock
    this.auditTableName = auditTableName
  }

  /** Primary key で row を取得します。 */
  protected abstract getRecord(
    workspaceId: string,
    recordKey: string,
  ): Promise<DeveloperPlatformRecord | undefined>

  /** Workspace partition の prefix rows を取得します。 */
  protected abstract listRecords(
    workspaceId: string,
    recordKeyPrefix: string,
  ): Promise<DeveloperPlatformRecord[]>

  /** Workspace partition の prefix rows をbounded page取得します。 */
  protected abstract listRecordsPage(
    workspaceId: string,
    recordKeyPrefix: string,
    limit: number,
    exclusiveStartRecordKey?: string,
  ): Promise<ListRecordsPageResult>

  /** lookupKey GSI 相当から一意な row を取得します。 */
  protected abstract getRecordByLookupKey(
    lookupKey: string,
  ): Promise<DeveloperPlatformRecordLocator | undefined>

  /** LookupKeyIndex を件数上限付きで query します。 */
  protected abstract queryLookupIndex(
    request: QueryLookupIndexRequest,
  ): Promise<QueryLookupIndexResult>

  /** Active Webhook locator migration の強整合な状態を返します。 */
  protected abstract readWebhookActiveLocatorMigrationState():
    Promise<WebhookActiveLocatorMigrationState>

  /** Row を作成または条件付き置換します。 */
  protected abstract putRecord(
    record: DeveloperPlatformRecord,
    condition?: PutRecordCondition,
  ): Promise<boolean>

  /** Domain row と encrypted idempotency receipt を原子的に保存します。 */
  protected abstract putRecordWithIdempotency(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    completion: PreparedIdempotencyCompletionRecord,
    auditPut?: AuditTransactWriteItem,
  ): Promise<boolean>

  /** Domain row と immutable audit outbox event を原子的に保存します。 */
  protected abstract putRecordWithAudit(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    auditPut: AuditTransactWriteItem,
  ): Promise<boolean>

  /** Credential domain/auth rows と optional receipt を原子的に保存します。 */
  protected abstract putCredentialRecord(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    authWrite?: CredentialAuthRecordWrite,
    authDelete?: CredentialAuthRecordDelete,
    completion?: PreparedIdempotencyCompletionRecord,
  ): Promise<boolean>

  /** OAuth app 利用記録、token domain/auth rows を原子的に保存します。 */
  protected abstract createOAuthTokenRecords(
    appRecord: DeveloperPlatformRecord,
    expectedAppVersion: number,
    tokenRecord: DeveloperPlatformRecord,
    authRecord: DeveloperPlatformRecord,
  ): Promise<boolean>

  /** Credential domain row と対応 auth row を原子的に削除します。 */
  protected abstract deleteCredentialRecord(
    record: DeveloperPlatformRecord,
    authRecord?: DeveloperPlatformRecord,
  ): Promise<boolean>

  /** Primary key の row を削除します。 */
  protected abstract deleteRecord(
    workspaceId: string,
    recordKey: string,
    expectedVersion?: number,
  ): Promise<boolean>

  /** Webhook subscription と Workspace quota、optional receipt を原子的に保存します。 */
  protected abstract createWebhookSubscriptionRecord(
    record: DeveloperPlatformRecord,
    completion?: PreparedIdempotencyCompletionRecord,
  ): Promise<'created' | 'quota-exceeded' | 'conflict'>

  /** Webhook subscription と active locator、optional receipt を原子的に保存します。 */
  protected abstract putWebhookSubscriptionRecord(
    record: DeveloperPlatformRecord,
    expectedVersion: number,
    completion?: PreparedIdempotencyCompletionRecord,
  ): Promise<boolean>

  /** Webhook subscription の無効化と Workspace quota 解放を原子的に保存します。 */
  protected abstract disableWebhookSubscriptionRecord(
    record: DeveloperPlatformRecord,
    expectedVersion: number,
    completion?: PreparedIdempotencyCompletionRecord,
  ): Promise<boolean>

  /** Webhook delivery attempt と subscription health を原子的に保存します。 */
  protected abstract putWebhookDeliveryAttempt(
    deliveryRecord: DeveloperPlatformRecord,
    expectedDeliveryVersion: number,
    subscriptionRecordKey: string,
    delivered: boolean,
    attemptedAt: string,
  ): Promise<boolean>

  /** Delivery 本体と immutable index locator を原子的に新規保存します。 */
  protected abstract createWebhookDeliveryRecords(
    records: readonly DeveloperPlatformRecord[],
  ): Promise<boolean>

  /** External link と tenant-scoped uniqueness claim を原子的に保存します。 */
  protected abstract saveExternalLinkWithClaim(
    linkRecord: DeveloperPlatformRecord,
    claimRecord: DeveloperPlatformRecord,
    indexRecords: readonly DeveloperPlatformRecord[],
    installationRecord: DeveloperPlatformRecord,
    auditPut?: AuditTransactWriteItem,
  ): Promise<SaveExternalLinkResult>

  /** Connector lifecycle guard と external-link mutation を原子的に保存します。 */
  protected abstract putExternalLinkWithConnectorGuard(
    linkRecord: DeveloperPlatformRecord,
    expectedLinkVersion: number,
    installationRecord: DeveloperPlatformRecord,
    previousLink: ExternalWorkItemLink,
    expectedConnectorStatus: 'connected' | 'disconnected',
    completion?: PreparedIdempotencyCompletionRecord,
    auditPut?: AuditTransactWriteItem,
  ): Promise<boolean>

  /** Connector lifecycle revisionを変えずにcurrent disconnect cleanup markerを解除します。 */
  protected abstract clearConnectorDisconnectCleanupMarker(
    workspaceId: string,
    connectorRecordKey: string,
    expectedRecordVersion: number,
    expectedCleanupRevision: number,
  ): Promise<boolean>

  /** External link、claim、sync state、receipt、audit を原子的に削除・保存します。 */
  protected abstract deleteExternalLinkWithClaim(
    linkRecord: DeveloperPlatformRecord,
    claimRecordKey: string,
    indexRecordKeys: readonly string[],
    completion?: PreparedIdempotencyCompletionRecord,
    auditPut?: AuditTransactWriteItem,
  ): Promise<boolean>

  /** Credential fixed-window counter を原子的に消費します。 */
  protected abstract consumeRateLimitRecord(
    input: ConsumeRateLimitStorageInput,
  ): Promise<ConsumeRateLimitStorageResult>

  /** Optional token があれば domain row と response receipt を同時保存します。 */
  private async persistMutationRecord(
    workspaceId: string,
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    idempotency: IdempotencyMutationToken | undefined,
    response: unknown,
    auditPut?: AuditTransactWriteItem,
  ) {
    if (!idempotency) {
      return auditPut
        ? this.putRecordWithAudit(record, condition, auditPut)
        : this.putRecord(record, condition)
    }
    const completion = await this.prepareIdempotencyCompletionRecord(
      workspaceId,
      idempotency,
      response,
    )
    return this.putRecordWithIdempotency(record, condition, completion, auditPut)
  }

  /** Credential domain/auth rows と optional idempotency receipt を保存します。 */
  private async persistCredentialMutationRecord(
    workspaceId: string,
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    authWrite: CredentialAuthRecordWrite | undefined,
    authDelete: CredentialAuthRecordDelete | undefined,
    idempotency: IdempotencyMutationToken | undefined,
    response: unknown,
  ) {
    const completion = idempotency
      ? await this.prepareIdempotencyCompletionRecord(
          workspaceId,
          idempotency,
          response,
        )
      : undefined
    return this.putCredentialRecord(
      record,
      condition,
      authWrite,
      authDelete,
      completion,
    )
  }

  /** Platform lifecycle を既存 audit stream へ流す immutable outbox Put にします。 */
  protected createPlatformAuditPut(input: PlatformAuditEventInput) {
    if (!this.auditTableName) return undefined
    const context = createMutationAuditContext({
      workspaceId: input.workspaceId,
      actor: {
        id: input.actorId ?? 'developer-platform',
        kind: input.actorId ? 'user' : 'service',
      },
      idempotencyKey:
        `developer-platform:${input.eventType}:${input.entityId}:${input.transitionId}`,
      occurredAt: input.occurredAt,
      request: {
        method: 'EVENT',
        path: `/developer-platform/${input.entityType}/${input.entityId}`,
        body: { transitionId: input.transitionId },
      },
      source: {
        kind: 'system',
        requestId: `developer-platform-${digestText(input.transitionId).slice(0, 24)}`,
      },
    })
    return createMutationAuditEventPut(this.auditTableName, context, {
      directoryId: input.workspaceId,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      occurredAt: input.occurredAt,
      summary: input.summary,
      metadata: {
        adapter: 'developer-platform',
        ...(input.teamId ? { teamId: input.teamId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...input.metadata,
      },
    })
  }

  /** Current reservation owner に束縛した encrypted completed row を準備します。 */
  protected async prepareIdempotencyCompletionRecord(
    workspaceIdValue: string,
    token: IdempotencyMutationToken,
    responseValue: unknown,
  ): Promise<PreparedIdempotencyCompletionRecord> {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const credentialId = readIdentifier(token.credentialId, 'Credential ID')
    const idempotencyKey = readIdempotencyKey(token.idempotencyKey)
    const requestFingerprint = requireText(
      token.requestFingerprint,
      'Idempotency request fingerprint',
    )
    const reservationId = requireText(
      token.reservationId,
      'Idempotency reservation ID',
    )
    const keyDigest = digestText(
      `developer-idempotency-v1\0${workspaceId}\0${credentialId}\0${idempotencyKey}`,
    )
    const recordKey = `IDEMPOTENCY#${credentialId}#${keyDigest}`
    const reservedRecord = await this.requireRecord(
      workspaceId,
      recordKey,
      'idempotency',
      'IdempotencyReservationNotFound',
      'Idempotency reservation was not found.',
    )
    if ((reservedRecord.expiresAt ?? 0) <= Math.floor(this.clock().getTime() / 1_000)) {
      throw conflict(
        'IdempotencyReservationExpired',
        'Idempotency reservation has expired.',
      )
    }
    const stored = readRecordValue<StoredIdempotencyValue>(
      reservedRecord,
      'idempotency',
    )
    const reservationDigest = digestSecret(reservationId)
    if (!secretDigestsEqual(stored.reservationDigest, reservationDigest)) {
      throw forbidden(
        'IdempotencyReservationOwnerMismatch',
        'Idempotency reservation belongs to another request.',
      )
    }
    const requestFingerprintDigest = digestText(
      `developer-request-v1\0${requestFingerprint}`,
    )
    if (stored.requestFingerprintDigest !== requestFingerprintDigest) {
      throw conflict(
        'IdempotencyKeyConflict',
        'Idempotency key was already used for a different request.',
      )
    }
    if (stored.state !== 'reserved') {
      throw conflict(
        'IdempotencyAlreadyCompleted',
        'Idempotency request was already completed.',
      )
    }
    const response = cloneJsonValue(responseValue)
    const serializedResponse = JSON.stringify(response)
    if (
      Buffer.byteLength(serializedResponse, 'utf8') >
        IDEMPOTENCY_MAX_RESPONSE_BYTES
    ) {
      throw new DeveloperPlatformError(
        413,
        'IdempotencyResponseTooLarge',
        'Idempotency response exceeds the safe persistence limit.',
      )
    }
    const responseCiphertext = await this.secretProtector.protect(
      serializedResponse,
      createIdempotencyResponseContext(workspaceId, credentialId, keyDigest),
    )
    const completedRecord: DeveloperPlatformRecord = {
      ...reservedRecord,
      value: {
        ...stored,
        state: 'completed',
        responseCiphertext,
      } satisfies StoredIdempotencyValue,
      version: reservedRecord.version + 1,
    }
    if (estimateStoredRecordBytes(completedRecord) > 380 * 1024) {
      throw new DeveloperPlatformError(
        413,
        'IdempotencyResponseTooLarge',
        'Encrypted idempotency response exceeds the safe persistence limit.',
      )
    }
    return {
      completedRecord,
      reservedRecord,
      reservationDigest,
      requestFingerprintDigest,
    }
  }

  /** API key を作成し、secret を一度だけ返します。 */
  async createApiKey(request: CreateApiKeyRequest): Promise<ApiKeySecretResult> {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const createdByUserId = readIdentifier(request.createdByUserId, 'Creator user ID')
    const name = readName(request.input.name, 'API key name')
    const scopes = readScopes(request.input.scopes)
    const now = this.clock()
    const expiresAt = request.input.expiresAt === undefined
      ? new Date(now.getTime() + API_KEY_DEFAULT_TTL_SECONDS * 1_000).toISOString()
      : readFutureTimestamp(request.input.expiresAt, now, 'API key expiry')
    const id = createId('key')
    const secret = createSecret('mk_key')
    const secretDigest = digestSecret(secret)
    const apiKey: ApiKeySummary = {
      id,
      name,
      prefix: secret.slice(0, 14),
      scopes,
      status: 'active',
      createdByUserId,
      createdAt: now.toISOString(),
      expiresAt,
    }
    const record = createRecord(
      workspaceId,
      createApiKeyRecordKey(id),
      'api-key',
      apiKey,
      {
        secretDigest,
      },
    )
    const authRecord = createCredentialAuthRecord(
      createApiKeyAuthWorkspaceId(secretDigest),
      'api-key',
      record,
      secretDigest,
      toEpochSeconds(expiresAt),
    )
    const result = { apiKey: clone(apiKey), secret } satisfies ApiKeySecretResult
    if (!await this.persistCredentialMutationRecord(
      workspaceId,
      record,
      { ifAbsent: true },
      { record: authRecord, condition: { ifAbsent: true } },
      undefined,
      request.idempotency,
      { status: 201, body: result },
    )) {
      throw persistenceConflict()
    }
    return result
  }

  /** Workspace の secret を含まない API key summary を返します。 */
  async listApiKeys(workspaceIdValue: string) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const now = this.clock()
    const records = await this.listRecords(workspaceId, 'APIKEY#')
    const apiKeys: ApiKeySummary[] = []
    for (const record of records) {
      const apiKey = readRecordValue<ApiKeySummary>(record, 'api-key')
      const normalized = normalizeCredentialStatus(apiKey, now)
      if (normalized !== apiKey || (
        normalized.status !== 'active' &&
        record.secretDigest !== undefined
      )) {
        const authRecord = record.secretDigest
          ? await this.getCredentialAuthRecord(
              createApiKeyAuthWorkspaceId(record.secretDigest),
              'api-key',
              record,
            )
          : undefined
        await this.putCredentialRecord(withoutStoredCredential({
          ...record,
          value: normalized,
          version: record.version + 1,
        }, true), { expectedVersion: record.version }, undefined,
        authRecord ? createCredentialAuthDelete(authRecord) : undefined)
      }
      apiKeys.push(clone(normalized))
    }
    return sortByCreatedAt(apiKeys)
  }

  /** API key secret を置換し、新 secret を一度だけ返します。 */
  async rotateApiKey(request: RotateApiKeyRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const apiKeyId = readIdentifier(request.apiKeyId, 'API key ID')
    const record = await this.requireRecord(
      workspaceId,
      createApiKeyRecordKey(apiKeyId),
      'api-key',
      'ApiKeyNotFound',
      'API key was not found.',
    )
    const current = normalizeCredentialStatus(
      readRecordValue<ApiKeySummary>(record, 'api-key'),
      this.clock(),
    )
    if (current.status !== 'active') {
      if (
        current.status === 'expired' &&
        (
          current !== record.value ||
          record.secretDigest !== undefined
        )
      ) {
        const authRecord = record.secretDigest
          ? await this.getCredentialAuthRecord(
              createApiKeyAuthWorkspaceId(record.secretDigest),
              'api-key',
              record,
            )
          : undefined
        const saved = await this.putCredentialRecord(withoutStoredCredential({
          ...record,
          value: current,
          version: record.version + 1,
        }, true), { expectedVersion: record.version }, undefined,
        authRecord ? createCredentialAuthDelete(authRecord) : undefined)
        if (!saved) throw persistenceConflict()
      }
      throw conflict('ApiKeyNotActive', 'Only an active API key can be rotated.')
    }
    const secret = createSecret('mk_key')
    const apiKey: ApiKeySummary = {
      ...current,
      prefix: secret.slice(0, 14),
      lastUsedAt: undefined,
    }
    if (!record.secretDigest) {
      throw persistenceInvalid('API key auth digest is missing.')
    }
    const secretDigest = digestSecret(secret)
    const updatedRecord: DeveloperPlatformRecord = {
      ...record,
      value: apiKey,
      secretDigest,
      version: record.version + 1,
    }
    const oldAuthRecord = await this.getCredentialAuthRecord(
      createApiKeyAuthWorkspaceId(record.secretDigest),
      'api-key',
      record,
    )
    if (!oldAuthRecord) throw persistenceInvalid('API key auth row is missing.')
    const authRecord = createCredentialAuthRecord(
      createApiKeyAuthWorkspaceId(secretDigest),
      'api-key',
      updatedRecord,
      secretDigest,
      apiKey.expiresAt ? toEpochSeconds(apiKey.expiresAt) : undefined,
    )
    const result = { apiKey: clone(apiKey), secret } satisfies ApiKeySecretResult
    const saved = await this.persistCredentialMutationRecord(
      workspaceId,
      updatedRecord,
      { expectedVersion: record.version },
      { record: authRecord, condition: { ifAbsent: true } },
      createCredentialAuthDelete(oldAuthRecord),
      request.idempotency,
      { status: 200, body: result },
    )
    if (!saved) throw persistenceConflict()
    return result
  }

  /** API key を revoke します。 */
  async revokeApiKey(request: RevokeApiKeyRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const apiKeyId = readIdentifier(request.apiKeyId, 'API key ID')
    const record = await this.requireRecord(
      workspaceId,
      createApiKeyRecordKey(apiKeyId),
      'api-key',
      'ApiKeyNotFound',
      'API key was not found.',
    )
    const current = readRecordValue<ApiKeySummary>(record, 'api-key')
    if (current.status === 'revoked') {
      if (record.secretDigest) {
        const authRecord = await this.getCredentialAuthRecord(
          createApiKeyAuthWorkspaceId(record.secretDigest),
          'api-key',
          record,
        )
        const saved = await this.putCredentialRecord(
          withoutStoredCredential({
            ...record,
            version: record.version + 1,
          }, true),
          { expectedVersion: record.version },
          undefined,
          authRecord ? createCredentialAuthDelete(authRecord) : undefined,
        )
        if (!saved) throw persistenceConflict()
      }
      return clone(current)
    }
    const apiKey: ApiKeySummary = {
      ...current,
      status: 'revoked',
      revokedAt: this.clock().toISOString(),
    }
    const authRecord = record.secretDigest
      ? await this.getCredentialAuthRecord(
          createApiKeyAuthWorkspaceId(record.secretDigest),
          'api-key',
          record,
        )
      : undefined
    const saved = await this.putCredentialRecord(withoutStoredCredential({
      ...record,
      value: apiKey,
      version: record.version + 1,
    }, true), { expectedVersion: record.version }, undefined,
    authRecord ? createCredentialAuthDelete(authRecord) : undefined)
    if (!saved) throw persistenceConflict()
    return clone(apiKey)
  }

  /** API key secret を認証し、last-used を更新します。 */
  async authenticateApiKey(request: AuthenticateCredentialRequest) {
    const credential = requireText(request.credential, 'API key credential')
    const credentialDigest = digestSecret(credential)
    const resolved = await this.resolveCredentialRecord(
      createApiKeyAuthWorkspaceId(credentialDigest),
      'api-key',
      'api-key',
    )
    const record = resolved?.record
    if (
      !record ||
      !record.secretDigest ||
      !resolved?.authRecord.secretDigest ||
      !secretDigestsEqual(resolved.authRecord.secretDigest, credentialDigest) ||
      !secretDigestsEqual(record.secretDigest, credentialDigest)
    ) {
      throw unauthorized('ApiKeyInvalid', 'API key is invalid.')
    }
    const now = this.clock()
    const current = normalizeCredentialStatus(
      readRecordValue<ApiKeySummary>(record, 'api-key'),
      now,
    )
    if (current.status === 'expired') {
      if (
        current !== record.value ||
        record.secretDigest !== undefined
      ) {
        await this.putCredentialRecord(withoutStoredCredential({
          ...record,
          value: current,
          version: record.version + 1,
        }, true), { expectedVersion: record.version }, undefined,
        createCredentialAuthDelete(resolved.authRecord))
      }
      throw unauthorized('ApiKeyExpired', 'API key has expired.')
    }
    if (current.status !== 'active') {
      throw unauthorized('ApiKeyRevoked', 'API key has been revoked.')
    }
    assertRequiredScopes(current.scopes, request.requiredScopes)
    const lastUsedAt = now.toISOString()
    const apiKey: ApiKeySummary = { ...current, lastUsedAt }
    await this.putRecord({
      ...record,
      value: apiKey,
      version: record.version + 1,
    }, { expectedVersion: record.version })
    return {
      kind: 'api-key',
      workspaceId: record.workspaceId,
      credentialId: current.id,
      subjectUserId: current.createdByUserId,
      scopes: [...current.scopes],
      ...(current.expiresAt ? { expiresAt: current.expiresAt } : {}),
    } satisfies AuthenticatedDeveloperCredential
  }

  /** OAuth app を作成し、client secret を一度だけ返します。 */
  async createOAuthApp(request: CreateOAuthAppRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const createdByUserId = readIdentifier(request.createdByUserId, 'Creator user ID')
    const name = readName(request.input.name, 'OAuth app name')
    const grantTypes = readOAuthGrantTypes(request.input.grantTypes)
    const scopes = readScopes(request.input.scopes)
    const now = this.clock()
    const expiresAt = request.input.expiresAt === undefined
      ? new Date(now.getTime() + OAUTH_APP_DEFAULT_TTL_SECONDS * 1_000).toISOString()
      : readFutureTimestamp(request.input.expiresAt, now, 'OAuth app expiry')
    const id = createId('oauth')
    const clientId = createPublicIdentifier('mk_oauth')
    const clientSecret = createSecret('mk_oauth_secret')
    const clientSecretDigest = digestSecret(clientSecret)
    const oauthApp: OAuthAppSummary = {
      id,
      name,
      clientId,
      grantTypes,
      scopes,
      status: 'active',
      createdByUserId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt,
    }
    const record = createRecord(
      workspaceId,
      createOAuthAppRecordKey(id),
      'oauth-app',
      oauthApp,
      {
        secretDigest: clientSecretDigest,
      },
    )
    const authRecord = createCredentialAuthRecord(
      createOAuthClientAuthWorkspaceId(clientId),
      'oauth-client',
      record,
      clientSecretDigest,
      toEpochSeconds(expiresAt),
    )
    const result = {
      oauthApp: clone(oauthApp),
      clientSecret,
    } satisfies OAuthAppSecretResult
    if (!await this.persistCredentialMutationRecord(
      workspaceId,
      record,
      { ifAbsent: true },
      { record: authRecord, condition: { ifAbsent: true } },
      undefined,
      request.idempotency,
      { status: 201, body: result },
    )) throw persistenceConflict()
    return result
  }

  /** Workspace の secret を含まない OAuth app summary を返します。 */
  async listOAuthApps(workspaceIdValue: string) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const records = await this.listRecords(workspaceId, 'OAUTHAPP#')
    const now = this.clock()
    const oauthApps: OAuthAppSummary[] = []
    for (const record of records) {
      const oauthApp = readRecordValue<OAuthAppSummary>(record, 'oauth-app')
      const normalized = normalizeCredentialStatus(oauthApp, now)
      if (normalized !== oauthApp || (
        normalized.status !== 'active' && record.secretDigest !== undefined
      )) {
        await this.persistInactiveOAuthApp(record, normalized)
      }
      oauthApps.push(clone(normalized))
    }
    return sortByCreatedAt(oauthApps)
  }

  /** OAuth client secret を置換し、新 secret を一度だけ返します。 */
  async rotateOAuthClientSecret(request: RotateOAuthClientSecretRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const oauthAppId = readIdentifier(request.oauthAppId, 'OAuth app ID')
    const record = await this.requireRecord(
      workspaceId,
      createOAuthAppRecordKey(oauthAppId),
      'oauth-app',
      'OAuthAppNotFound',
      'OAuth app was not found.',
    )
    const current = normalizeCredentialStatus(
      readRecordValue<OAuthAppSummary>(record, 'oauth-app'),
      this.clock(),
    )
    if (current.status !== 'active') {
      if (
        current.status === 'expired' &&
        (current !== record.value || record.secretDigest !== undefined)
      ) {
        await this.persistInactiveOAuthApp(record, current)
      }
      throw conflict('OAuthAppNotActive', 'Only an active OAuth app can be rotated.')
    }
    const clientSecret = createSecret('mk_oauth_secret')
    const clientSecretDigest = digestSecret(clientSecret)
    const oauthApp: OAuthAppSummary = {
      ...current,
      updatedAt: this.clock().toISOString(),
      lastUsedAt: undefined,
    }
    const currentAuthRecord = await this.getCredentialAuthRecord(
      createOAuthClientAuthWorkspaceId(oauthApp.clientId),
      'oauth-client',
      record,
    )
    if (!currentAuthRecord) {
      throw persistenceInvalid('OAuth client auth row is missing.')
    }
    const updatedRecord: DeveloperPlatformRecord = {
      ...record,
      value: oauthApp,
      secretDigest: clientSecretDigest,
      version: record.version + 1,
    }
    const updatedAuthRecord = createCredentialAuthRecord(
      currentAuthRecord.workspaceId,
      'oauth-client',
      updatedRecord,
      clientSecretDigest,
      oauthApp.expiresAt ? toEpochSeconds(oauthApp.expiresAt) : undefined,
      currentAuthRecord.version + 1,
    )
    const result = {
      oauthApp: clone(oauthApp),
      clientSecret,
    } satisfies OAuthAppSecretResult
    const saved = await this.persistCredentialMutationRecord(
      workspaceId,
      updatedRecord,
      { expectedVersion: record.version },
      {
        record: updatedAuthRecord,
        condition: { expectedVersion: currentAuthRecord.version },
      },
      undefined,
      request.idempotency,
      { status: 200, body: result },
    )
    if (!saved) throw persistenceConflict()
    return result
  }

  /** OAuth app と配下 token を revoke します。 */
  async revokeOAuthApp(request: RevokeOAuthAppRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const oauthAppId = readIdentifier(request.oauthAppId, 'OAuth app ID')
    const record = await this.requireRecord(
      workspaceId,
      createOAuthAppRecordKey(oauthAppId),
      'oauth-app',
      'OAuthAppNotFound',
      'OAuth app was not found.',
    )
    const current = readRecordValue<OAuthAppSummary>(record, 'oauth-app')
    if (current.status === 'revoked') {
      if (record.secretDigest !== undefined) {
        await this.persistInactiveOAuthApp(record, current)
      }
      return clone(current)
    }
    const now = this.clock().toISOString()
    const oauthApp: OAuthAppSummary = {
      ...current,
      status: 'revoked',
      revokedAt: now,
      updatedAt: now,
    }
    await this.persistInactiveOAuthApp(record, oauthApp)
    return clone(oauthApp)
  }

  /** client_credentials を検証し、digest だけ保存する token を発行します。 */
  async issueOAuthToken(request: IssueOAuthTokenRequest) {
    const clientId = requireText(request.clientId, 'OAuth client ID')
    const clientSecret = requireText(request.clientSecret, 'OAuth client secret')
    const clientSecretDigest = digestSecret(clientSecret)
    const resolved = await this.resolveCredentialRecord(
      createOAuthClientAuthWorkspaceId(clientId),
      'oauth-client',
      'oauth-app',
    )
    const record = resolved?.record
    if (
      !record ||
      !record.secretDigest ||
      !resolved?.authRecord.secretDigest ||
      !secretDigestsEqual(resolved.authRecord.secretDigest, clientSecretDigest) ||
      !secretDigestsEqual(record.secretDigest, clientSecretDigest)
    ) {
      throw unauthorized('OAuthClientInvalid', 'OAuth client credentials are invalid.')
    }
    const now = this.clock()
    const oauthApp = normalizeCredentialStatus(
      readRecordValue<OAuthAppSummary>(record, 'oauth-app'),
      now,
    )
    if (oauthApp.clientId !== clientId) {
      throw unauthorized('OAuthClientInvalid', 'OAuth client credentials are invalid.')
    }
    if (oauthApp.status === 'expired') {
      await this.persistInactiveOAuthApp(record, oauthApp)
      throw unauthorized('OAuthAppExpired', 'OAuth app has expired.')
    }
    if (oauthApp.status !== 'active') {
      throw unauthorized('OAuthAppRevoked', 'OAuth app has been revoked.')
    }
    if (!oauthApp.grantTypes.includes('client_credentials')) {
      throw forbidden(
        'OAuthGrantNotAllowed',
        'OAuth app does not allow the client_credentials grant.',
      )
    }
    const scopes = request.scopes === undefined
      ? [...oauthApp.scopes]
      : readScopes(request.scopes)
    assertRequiredScopes(oauthApp.scopes, scopes)
    const requestedExpiresIn = readPositiveInteger(
      request.expiresInSeconds ?? OAUTH_TOKEN_DEFAULT_TTL_SECONDS,
      'OAuth token expiry seconds',
      OAUTH_TOKEN_MAX_TTL_SECONDS,
    )
    const appRemainingSeconds = oauthApp.expiresAt
      ? Math.floor((Date.parse(oauthApp.expiresAt) - now.getTime()) / 1_000)
      : requestedExpiresIn
    if (appRemainingSeconds < 1) {
      await this.persistInactiveOAuthApp(record, {
        ...oauthApp,
        status: 'expired',
      })
      throw unauthorized('OAuthAppExpired', 'OAuth app has expired.')
    }
    const expiresIn = Math.min(requestedExpiresIn, appRemainingSeconds)
    const expiresAt = new Date(now.getTime() + expiresIn * 1_000).toISOString()
    const tokenId = createId('token')
    const accessToken = createSecret('mk_access')
    const accessTokenDigest = digestSecret(accessToken)
    const token: StoredOAuthTokenValue = {
      id: tokenId,
      oauthAppId: oauthApp.id,
      subjectUserId: oauthApp.createdByUserId,
      scopes,
      createdAt: now.toISOString(),
      expiresAt,
    }
    const tokenRecord = createRecord(
      record.workspaceId,
      createOAuthTokenRecordKey(tokenId),
      'oauth-token',
      token,
      {
        secretDigest: accessTokenDigest,
        expiresAt: toEpochSeconds(expiresAt),
      },
    )
    const tokenAuthRecord = createCredentialAuthRecord(
      createOAuthTokenAuthWorkspaceId(accessTokenDigest),
      'oauth-token',
      tokenRecord,
      accessTokenDigest,
      tokenRecord.expiresAt,
    )
    const updatedAppRecord: DeveloperPlatformRecord = {
      ...record,
      value: {
        ...oauthApp,
        lastUsedAt: now.toISOString(),
        updatedAt: now.toISOString(),
      } satisfies OAuthAppSummary,
      version: record.version + 1,
    }
    const saved = await this.createOAuthTokenRecords(
      updatedAppRecord,
      record.version,
      tokenRecord,
      tokenAuthRecord,
    )
    if (!saved) throw persistenceConflict()
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn,
      expiresAt,
      scopes: [...scopes],
    } satisfies OAuthTokenResult
  }

  /** Bearer token を認証します。 */
  async authenticateOAuthToken(request: AuthenticateCredentialRequest) {
    const credential = requireText(request.credential, 'OAuth access token')
    const credentialDigest = digestSecret(credential)
    const resolved = await this.resolveCredentialRecord(
      createOAuthTokenAuthWorkspaceId(credentialDigest),
      'oauth-token',
      'oauth-token',
    )
    const record = resolved?.record
    if (
      !record ||
      !record.secretDigest ||
      !resolved?.authRecord.secretDigest ||
      !secretDigestsEqual(resolved.authRecord.secretDigest, credentialDigest) ||
      !secretDigestsEqual(record.secretDigest, credentialDigest)
    ) {
      throw unauthorized('OAuthTokenInvalid', 'OAuth access token is invalid.')
    }
    const token = readRecordValue<StoredOAuthTokenValue>(record, 'oauth-token')
    const now = this.clock()
    if (Date.parse(token.expiresAt) <= now.getTime()) {
      await this.deleteCredentialRecord(record, resolved.authRecord)
      throw unauthorized('OAuthTokenExpired', 'OAuth access token has expired.')
    }
    const appRecord = await this.getRecord(
      record.workspaceId,
      createOAuthAppRecordKey(token.oauthAppId),
    )
    if (!appRecord || appRecord.entryType !== 'oauth-app') {
      throw unauthorized('OAuthTokenInvalid', 'OAuth access token is invalid.')
    }
    const oauthApp = normalizeCredentialStatus(
      readRecordValue<OAuthAppSummary>(appRecord, 'oauth-app'),
      now,
    )
    if (oauthApp.status === 'expired') {
      await this.persistInactiveOAuthApp(appRecord, oauthApp)
      throw unauthorized('OAuthAppExpired', 'OAuth app has expired.')
    }
    if (oauthApp.status !== 'active') {
      throw unauthorized('OAuthAppRevoked', 'OAuth app has been revoked.')
    }
    assertRequiredScopes(token.scopes, request.requiredScopes)
    await this.putRecord({
      ...record,
      value: { ...token, lastUsedAt: now.toISOString() } satisfies StoredOAuthTokenValue,
      version: record.version + 1,
    }, { expectedVersion: record.version })
    return {
      kind: 'oauth-token',
      workspaceId: record.workspaceId,
      credentialId: token.id,
      subjectUserId: token.subjectUserId,
      oauthAppId: token.oauthAppId,
      scopes: [...token.scopes],
      expiresAt: token.expiresAt,
    } satisfies AuthenticatedDeveloperCredential
  }

  /**
   * Migration state に合わせて active subscription のlegacy/primary投影を準備します。
   */
  protected async prepareWebhookSubscriptionStorageRecord(
    record: DeveloperPlatformRecord,
    subscription: WebhookSubscription,
  ) {
    const migrationState =
      await this.readWebhookActiveLocatorMigrationState()
    return migrationState !== 'complete' && subscription.status === 'active'
      ? addLegacyActiveWebhookProjection(record, subscription)
      : removeLegacyActiveWebhookProjection(record)
  }

  /** Webhook subscription を作成し、signing secret を一度だけ返します。 */
  async createWebhookSubscription(request: CreateWebhookSubscriptionRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const createdByUserId = readIdentifier(
      request.createdByUserId,
      'Webhook creator user ID',
    )
    const name = readName(request.input.name, 'Webhook subscription name')
    const url = readHttpsUrl(request.input.url, 'Webhook URL')
    const eventTypes = readEventTypes(request.input.eventTypes)
    const teamIds = readIdentifierArray(
      request.input.teamIds,
      'Webhook Team IDs',
      100,
    )
    const scopes = readScopes(request.input.scopes ?? ['work-items:read'])
    assertWebhookEventScopes(eventTypes, scopes)
    const id = createId('webhook')
    const secret = createSecret('mk_webhook')
    const now = this.clock().toISOString()
    const subscription: WebhookSubscription = {
      id,
      name,
      url,
      createdByUserId,
      teamIds,
      eventTypes,
      scopes,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      failureCount: 0,
    }
    const secretCiphertext = await this.secretProtector.protect(
      secret,
      createWebhookSecretContext(workspaceId, id),
    )
    const record = await this.prepareWebhookSubscriptionStorageRecord(
      createRecord(
        workspaceId,
        createWebhookRecordKey(id),
        'webhook-subscription',
        subscription,
        { secretCiphertext },
      ),
      subscription,
    )
    const result = {
      subscription: clone(subscription),
      signingSecret: secret,
    } satisfies WebhookSecretResult
    const completion = request.idempotency
      ? await this.prepareIdempotencyCompletionRecord(
          workspaceId,
          request.idempotency,
          { status: 201, body: result },
        )
      : undefined
    const saved = await this.createWebhookSubscriptionRecord(record, completion)
    if (saved === 'quota-exceeded') {
      throw conflict(
        'WebhookSubscriptionLimitExceeded',
        `A Workspace cannot contain more than ${WEBHOOK_SUBSCRIPTION_LIMIT} Webhook subscriptions.`,
      )
    }
    if (saved !== 'created') throw persistenceConflict()
    return result
  }

  /** Workspace の secret を含まない Webhook subscription を返します。 */
  async listWebhookSubscriptions(workspaceIdValue: string) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const records = await this.listRecords(workspaceId, 'WEBHOOK#')
    return sortByCreatedAt(
      records
        .filter((record) =>
          record.entryType === 'webhook-subscription' &&
          !isRecordExpired(record, this.clock())
        )
        .map((record) =>
          clone(readRecordValue<WebhookSubscription>(record, 'webhook-subscription'))
        ),
    )
  }

  /** Primary-key active locator を強整合の bounded page で取得します。 */
  async listActiveWebhookSubscriptionsPage(
    request: ListActiveWebhookSubscriptionsPageRequest,
  ): Promise<ActiveWebhookSubscriptionsPage> {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const limit = readBoundedLimit(
      request.limit,
      WEBHOOK_PROJECTION_PAGE_MAX_LIMIT,
      'Webhook subscription page limit',
    )
    const migrationState = request.cursor === undefined
      ? await this.readWebhookActiveLocatorMigrationState()
      : undefined
    let cursor = request.cursor === undefined
      ? migrationState === 'complete'
        ? {
            version: 1,
            phase: 'primary',
            workspaceId,
          } satisfies ActiveWebhookSubscriptionCursor
        : {
            version: 1,
            phase: 'legacy',
            workspaceId,
            lookupKey: createActiveWebhookSubscriptionLookupKey(workspaceId),
          } satisfies ActiveWebhookSubscriptionCursor
      : decodeActiveWebhookSubscriptionCursor(request.cursor, workspaceId)
    if (cursor.phase === 'legacy') {
      const legacyCursor = cursor
      const page = await this.queryLookupIndex({
        lookupKey: legacyCursor.lookupKey,
        limit,
        scanIndexForward: true,
        ...(legacyCursor.locator
          ? { exclusiveStartKey: legacyCursor.locator }
          : {}),
      })
      const subscriptions = (await mapWithConcurrency(
        page.locators,
        WEBHOOK_ENQUEUE_CONCURRENCY,
        async (locator) => {
          const record = await this.getRecord(locator.workspaceId, locator.recordKey)
          if (
            record?.entryType !== 'webhook-subscription' ||
            record.lookupKey !== legacyCursor.lookupKey ||
            record.lookupSortKey !== locator.lookupSortKey ||
            isRecordExpired(record, this.clock())
          ) return undefined
          const subscription = readRecordValue<WebhookSubscription>(
            record,
            'webhook-subscription',
          )
          if (subscription.status !== 'active') return undefined
          const primaryLocator = await this.getRecord(
            workspaceId,
            createActiveWebhookSubscriptionRecordKey(subscription),
          )
          if (primaryLocator?.entryType === 'webhook-active-subscription') {
            return undefined
          }
          return clone(subscription)
        },
      )).filter(isDefined)
      if (page.lastEvaluatedKey) {
        return {
          subscriptions,
          nextCursor: encodeActiveWebhookSubscriptionCursor({
            ...legacyCursor,
            locator: page.lastEvaluatedKey,
          }),
        }
      }
      const primaryCursor = {
        version: 1,
        phase: 'primary',
        workspaceId,
      } satisfies ActiveWebhookSubscriptionCursor
      if (subscriptions.length > 0) {
        return {
          subscriptions,
          nextCursor: encodeActiveWebhookSubscriptionCursor(primaryCursor),
        }
      }
      cursor = primaryCursor
    }
    const locatorPrefix = createActiveWebhookSubscriptionRecordKeyPrefix()
    const page = await this.listRecordsPage(
      workspaceId,
      locatorPrefix,
      limit,
      cursor.recordKey,
    )
    const subscriptions = (await mapWithConcurrency(
      page.records,
      WEBHOOK_ENQUEUE_CONCURRENCY,
      async (locator) => {
        if (locator.entryType !== 'webhook-active-subscription') return undefined
        const value = readRecordValue<StoredActiveWebhookSubscriptionValue>(
          locator,
          'webhook-active-subscription',
        )
        const record = await this.getRecord(workspaceId, value.targetRecordKey)
        if (
          record?.entryType !== 'webhook-subscription' ||
          isRecordExpired(record, this.clock())
        ) return undefined
        const subscription = readRecordValue<WebhookSubscription>(
          record,
          'webhook-subscription',
        )
        if (
          subscription.status !== 'active' ||
          locator.recordKey !== createActiveWebhookSubscriptionRecordKey(subscription) ||
          value.targetRecordKey !== createWebhookRecordKey(subscription.id)
        ) return undefined
        return clone(subscription)
      },
    )).filter(isDefined)
    const nextCursor = page.nextRecordKey
      ? encodeActiveWebhookSubscriptionCursor({
          ...cursor,
          recordKey: page.nextRecordKey,
        })
      : undefined
    return {
      subscriptions,
      ...(nextCursor ? { nextCursor } : {}),
    }
  }

  /** Webhook signing secret を置換し、新 secret を一度だけ返します。 */
  async rotateWebhookSecret(request: RotateWebhookSecretRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const subscriptionId = readIdentifier(request.subscriptionId, 'Webhook subscription ID')
    const record = await this.requireRecord(
      workspaceId,
      createWebhookRecordKey(subscriptionId),
      'webhook-subscription',
      'WebhookSubscriptionNotFound',
      'Webhook subscription was not found.',
    )
    const current = readRecordValue<WebhookSubscription>(record, 'webhook-subscription')
    if (current.status === 'disabled') {
      throw conflict(
        'WebhookSubscriptionDisabled',
        'A disabled Webhook subscription cannot be rotated.',
      )
    }
    const secret = createSecret('mk_webhook')
    const subscription: WebhookSubscription = {
      ...current,
      updatedAt: this.clock().toISOString(),
    }
    const secretCiphertext = await this.secretProtector.protect(
      secret,
      createWebhookSecretContext(workspaceId, subscriptionId),
    )
    const updatedRecord = await this.prepareWebhookSubscriptionStorageRecord(
      {
        ...record,
        value: subscription,
        secretCiphertext,
        version: record.version + 1,
      },
      subscription,
    )
    const result = {
      subscription: clone(subscription),
      signingSecret: secret,
    } satisfies WebhookSecretResult
    const completion = request.idempotency
      ? await this.prepareIdempotencyCompletionRecord(
          workspaceId,
          request.idempotency,
          { status: 200, body: result },
        )
      : undefined
    const saved = await this.putWebhookSubscriptionRecord(
      updatedRecord,
      record.version,
      completion,
    )
    if (!saved) throw persistenceConflict()
    return result
  }

  /** Webhook subscription metadata と status を原子的に更新します。 */
  async updateWebhookSubscription(request: UpdateWebhookSubscriptionRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const subscriptionId = readIdentifier(request.subscriptionId, 'Webhook subscription ID')
    const record = await this.requireRecord(
      workspaceId,
      createWebhookRecordKey(subscriptionId),
      'webhook-subscription',
      'WebhookSubscriptionNotFound',
      'Webhook subscription was not found.',
    )
    const current = readRecordValue<WebhookSubscription>(record, 'webhook-subscription')
    const status = request.input.status === undefined
      ? current.status
      : readWebhookSubscriptionStatus(request.input.status)
    if (current.status === 'disabled' && status !== 'disabled') {
      throw conflict(
        'WebhookSubscriptionDisabled',
        'A disabled Webhook subscription cannot be re-enabled.',
      )
    }
    const eventTypes = request.input.eventTypes === undefined
      ? current.eventTypes
      : readEventTypes(request.input.eventTypes)
    const scopes = request.input.scopes === undefined
      ? current.scopes
      : readScopes(request.input.scopes)
    assertWebhookEventScopes(eventTypes, scopes)
    const subscription: WebhookSubscription = {
      ...current,
      name: request.input.name === undefined
        ? current.name
        : readName(request.input.name, 'Webhook subscription name'),
      url: request.input.url === undefined
        ? current.url
        : readHttpsUrl(request.input.url, 'Webhook URL'),
      eventTypes,
      scopes,
      status,
      updatedAt: this.clock().toISOString(),
    }
    const updatedRecord = await this.prepareWebhookSubscriptionStorageRecord(
      {
        ...record,
        value: subscription,
        version: record.version + 1,
      },
      subscription,
    )
    if (status === 'disabled') {
      delete updatedRecord.secretCiphertext
      updatedRecord.expiresAt = record.expiresAt ??
        Math.floor(Date.parse(subscription.updatedAt) / 1_000) +
          WEBHOOK_DISABLED_SUBSCRIPTION_RETENTION_SECONDS
    }
    const response = request.idempotencyResponse ?? { status: 200, body: subscription }
    const saved = current.status !== 'disabled' && status === 'disabled'
      ? await this.disableWebhookSubscriptionRecord(
          updatedRecord,
          record.version,
          request.idempotency
            ? await this.prepareIdempotencyCompletionRecord(
                workspaceId,
                request.idempotency,
                response,
              )
            : undefined,
        )
      : await this.putWebhookSubscriptionRecord(
          updatedRecord,
          record.version,
          request.idempotency
            ? await this.prepareIdempotencyCompletionRecord(
                workspaceId,
                request.idempotency,
                response,
              )
            : undefined,
        )
    if (!saved) throw persistenceConflict()
    return clone(subscription)
  }

  /** Webhook subscription status を更新します。 */
  async setWebhookSubscriptionStatus(request: SetWebhookSubscriptionStatusRequest) {
    return this.updateWebhookSubscription({
      workspaceId: request.workspaceId,
      subscriptionId: request.subscriptionId,
      input: { status: request.status },
      ...(request.idempotency ? { idempotency: request.idempotency } : {}),
      ...(request.idempotencyResponse
        ? { idempotencyResponse: request.idempotencyResponse }
        : {}),
    })
  }

  /** Event に一致する subscription へ delivery を冪等に enqueue します。 */
  async enqueueWebhookEvent(request: EnqueueWebhookEventRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const event = readWebhookEvent(request.event, workspaceId)
    const teamId = readWebhookEventTeamId(event)
    const authorizedSubscriptionIds = new Set(readIdentifierArray(
      request.authorizedSubscriptionIds,
      'Authorized Webhook subscription IDs',
      WEBHOOK_PROJECTION_PAGE_MAX_LIMIT,
      true,
    ))
    const matching = (await mapWithConcurrency(
      [...authorizedSubscriptionIds],
      WEBHOOK_ENQUEUE_CONCURRENCY,
      async (subscriptionId) => {
        const record = await this.getRecord(
          workspaceId,
          createWebhookRecordKey(subscriptionId),
        )
        if (record?.entryType !== 'webhook-subscription') return undefined
        const subscription = readRecordValue<WebhookSubscription>(
          record,
          'webhook-subscription',
        )
        return subscription.status === 'active' &&
            subscription.teamIds.includes(teamId) &&
            subscription.eventTypes.some((pattern) =>
              eventTypeMatches(pattern, event.type)
            )
          ? subscription
          : undefined
      },
    )).filter(isDefined)
    const deliveries = await mapWithConcurrency(
      matching,
      WEBHOOK_ENQUEUE_CONCURRENCY,
      async (subscription) => {
      const id = createDeterministicDeliveryId(subscription.id, event.id)
      const recordKey = createWebhookDeliveryRecordKey(id)
      const existing = await this.getRecord(workspaceId, recordKey)
      if (existing) {
        const existingValue = readRecordValue<StoredWebhookDeliveryValue>(
          existing,
          'webhook-delivery',
        )
        if (
          existingValue.event.id !== event.id ||
          existingValue.delivery.subscriptionId !== subscription.id
        ) {
          throw persistenceConflict()
        }
        return clone(existingValue.delivery)
      }
      const now = this.clock().toISOString()
      const delivery: WebhookDelivery = {
        id,
        subscriptionId: subscription.id,
        eventId: event.id,
        eventType: event.type,
        status: 'pending',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      }
      const value: StoredWebhookDeliveryValue = {
        delivery,
        event,
      }
      const expiresAt = Math.floor(this.clock().getTime() / 1_000) +
        WEBHOOK_DELIVERY_RETENTION_SECONDS
      const records = createWebhookDeliveryStorageRecords(
        workspaceId,
        value,
        expiresAt,
      )
      if (!await this.createWebhookDeliveryRecords(records)) {
        const concurrent = await this.getRecord(workspaceId, recordKey)
        if (
          !concurrent ||
          concurrent.entryType !== 'webhook-delivery' ||
          isRecordExpired(concurrent, this.clock())
        ) {
          throw persistenceConflict()
        }
        return clone(
          readRecordValue<StoredWebhookDeliveryValue>(concurrent, 'webhook-delivery').delivery,
        )
      }
      return clone(delivery)
      },
    )
    return deliveries.sort(compareCreatedAtDescending)
  }

  /** Webhook delivery log を cursor pagination します。 */
  async listWebhookDeliveries(request: ListWebhookDeliveriesRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const subscriptionId = request.subscriptionId === undefined
      ? undefined
      : readIdentifier(request.subscriptionId, 'Webhook subscription ID')
    const limit = readPositiveInteger(
      request.limit ?? WEBHOOK_DELIVERY_DEFAULT_LIMIT,
      'Webhook delivery page limit',
      WEBHOOK_DELIVERY_MAX_LIMIT,
    )
    const cursor = request.cursor
      ? await this.decodeWebhookCursor(request.cursor, workspaceId, subscriptionId)
      : undefined
    const lookupKey = subscriptionId
      ? createWebhookDeliverySubscriptionLookupKey(workspaceId, subscriptionId)
      : createWebhookDeliveryWorkspaceLookupKey(workspaceId)
    const page = await this.queryLookupIndex({
      lookupKey,
      limit,
      scanIndexForward: false,
      ...(cursor
        ? {
            exclusiveStartKey: {
              workspaceId,
              recordKey: cursor.recordKey,
              lookupKey: cursor.lookupKey,
              lookupSortKey: cursor.lookupSortKey,
            },
          }
        : {}),
    })
    const resolved = await Promise.all(page.locators.map((locator) =>
      this.resolveWebhookDeliveryIndexLocator(
        locator,
        subscriptionId ? 'subscription-list' : 'workspace-list',
      )
    ))
    const deliveries = resolved
      .filter((delivery): delivery is WebhookDelivery => delivery !== undefined)
    return {
      deliveries: clone(deliveries),
      ...(page.lastEvaluatedKey
        ? {
            nextCursor: await this.secretProtector.protect(
              JSON.stringify({
                version: 2,
                workspaceId,
                ...(subscriptionId ? { subscriptionId } : {}),
                lookupKey: page.lastEvaluatedKey.lookupKey,
                lookupSortKey: page.lastEvaluatedKey.lookupSortKey,
                recordKey: page.lastEvaluatedKey.recordKey,
              } satisfies WebhookDeliveryCursor),
              WEBHOOK_CURSOR_CONTEXT,
            ),
          }
        : {}),
    } satisfies WebhookDeliveryPage
  }

  /** Webhook delivery を tenant-bound ID lookup で取得します。 */
  async getWebhookDelivery(request: GetWebhookDeliveryRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const deliveryId = readIdentifier(request.deliveryId, 'Webhook delivery ID')
    const record = await this.requireWebhookDeliveryRecordById(workspaceId, deliveryId)
    return clone(
      readRecordValue<StoredWebhookDeliveryValue>(record, 'webhook-delivery').delivery,
    )
  }

  /** Worker 用 payload と signing secret を安全な内部境界で解決します。 */
  async prepareWebhookDelivery(request: PrepareWebhookDeliveryRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const deliveryId = readIdentifier(request.deliveryId, 'Webhook delivery ID')
    const deliveryRecord = await this.requireWebhookDeliveryRecordById(
      workspaceId,
      deliveryId,
    )
    const stored = readRecordValue<StoredWebhookDeliveryValue>(
      deliveryRecord,
      'webhook-delivery',
    )
    const subscriptionRecord = await this.requireRecord(
      workspaceId,
      createWebhookRecordKey(stored.delivery.subscriptionId),
      'webhook-subscription',
      'WebhookSubscriptionNotFound',
      'Webhook subscription was not found.',
    )
    const subscription = readRecordValue<WebhookSubscription>(
      subscriptionRecord,
      'webhook-subscription',
    )
    if (subscription.status !== 'active') {
      throw conflict(
        'WebhookSubscriptionNotActive',
        'Webhook subscription is not active.',
      )
    }
    if (!subscriptionRecord.secretCiphertext) {
      throw persistenceInvalid('Webhook signing secret is missing.')
    }
    const signingSecret = await this.secretProtector.unprotect(
      subscriptionRecord.secretCiphertext,
      createWebhookSecretContext(workspaceId, subscription.id),
    )
    return {
      delivery: clone(stored.delivery),
      subscription: clone(subscription),
      signingSecret,
      payload: stableJson(stored.event),
    } satisfies PreparedWebhookDelivery
  }

  /** Webhook attempt 結果を保存します。 */
  async recordWebhookDeliveryAttempt(request: RecordWebhookDeliveryAttemptRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const deliveryId = readIdentifier(request.deliveryId, 'Webhook delivery ID')
    const status = readWebhookDeliveryStatus(request.status)
    const responseStatus = request.responseStatus === undefined
      ? undefined
      : readHttpStatus(request.responseStatus)
    const nextAttemptAt = request.nextAttemptAt === undefined
      ? undefined
      : readTimestamp(request.nextAttemptAt, 'Webhook next attempt')
    const error = request.error === undefined
      ? undefined
      : readOptionalText(request.error, 'Webhook delivery error', 1_000)
    if (status === 'retrying' && !nextAttemptAt) {
      throw invalid(
        'WebhookRetryTimeRequired',
        'Retrying Webhook delivery requires nextAttemptAt.',
      )
    }
    if (status !== 'retrying' && nextAttemptAt) {
      throw invalid(
        'WebhookRetryTimeInvalid',
        'Only a retrying Webhook delivery can set nextAttemptAt.',
      )
    }
    if (status === 'pending') {
      throw invalid(
        'WebhookDeliveryAttemptStatusInvalid',
        'A delivery attempt cannot finish in pending status.',
      )
    }
    const record = await this.requireWebhookDeliveryRecordById(workspaceId, deliveryId)
    const stored = readRecordValue<StoredWebhookDeliveryValue>(record, 'webhook-delivery')
    if (stored.delivery.status === 'delivered') {
      throw conflict(
        'WebhookDeliveryAlreadyDelivered',
        'Delivered Webhook delivery must be replayed before another attempt.',
      )
    }
    const now = this.clock().toISOString()
    const attempts = stored.delivery.attempts + 1
    const normalizedStatus = attempts >= WEBHOOK_MAX_ATTEMPTS && status === 'retrying'
      ? 'failed'
      : status
    const delivery: WebhookDelivery = {
      ...stored.delivery,
      status: normalizedStatus,
      attempts,
      ...(responseStatus === undefined ? {} : { responseStatus }),
      nextAttemptAt: normalizedStatus === 'retrying' ? nextAttemptAt : undefined,
      deliveredAt: normalizedStatus === 'delivered' ? now : undefined,
      updatedAt: now,
    }
    const value: StoredWebhookDeliveryValue = {
      ...stored,
      delivery,
      ...(error ? { lastError: error } : { lastError: undefined }),
    }
    const subscriptionRecord = await this.requireRecord(
      workspaceId,
      createWebhookRecordKey(delivery.subscriptionId),
      'webhook-subscription',
      'WebhookSubscriptionNotFound',
      'Webhook subscription was not found.',
    )
    const saved = await this.putWebhookDeliveryAttempt(
      {
        ...record,
        value,
        version: record.version + 1,
      },
      record.version,
      subscriptionRecord.recordKey,
      normalizedStatus === 'delivered',
      now,
    )
    if (!saved) throw persistenceConflict()
    return clone(delivery)
  }

  /** Original delivery を保存したまま新しい pending replay を作成します。 */
  async replayWebhookDelivery(request: ReplayWebhookDeliveryRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const deliveryId = readIdentifier(request.deliveryId, 'Webhook delivery ID')
    const operationId = request.operationId === undefined
      ? undefined
      : readWebhookReplayOperationId(request.operationId)
    const requestedRecord = await this.requireWebhookDeliveryRecordById(
      workspaceId,
      deliveryId,
    )
    const requested = readRecordValue<StoredWebhookDeliveryValue>(
      requestedRecord,
      'webhook-delivery',
    )
    const originalDeliveryId = requested.delivery.replayOfDeliveryId ?? requested.delivery.id
    const operationReplayId = operationId
      ? createDeterministicReplayOperationDeliveryId(originalDeliveryId, operationId)
      : undefined
    if (operationReplayId) {
      const existingOperationReplay = await this.getRecord(
        workspaceId,
        createWebhookDeliveryRecordKey(operationReplayId),
      )
      if (existingOperationReplay) {
        if (existingOperationReplay.entryType !== 'webhook-delivery') {
          throw persistenceConflict()
        }
        const delivery = readRecordValue<StoredWebhookDeliveryValue>(
          existingOperationReplay,
          'webhook-delivery',
        ).delivery
        if (
          delivery.replayOfDeliveryId !== originalDeliveryId ||
          delivery.subscriptionId !== requested.delivery.subscriptionId ||
          delivery.eventId !== requested.delivery.eventId
        ) throw persistenceConflict()
        return clone(delivery)
      }
    }
    const replayLookupKey = createWebhookDeliveryReplayLookupKey(
      workspaceId,
      originalDeliveryId,
    )
    const latestPage = await this.queryLookupIndex({
      lookupKey: replayLookupKey,
      limit: 1,
      scanIndexForward: false,
    })
    const latestReplay = latestPage.locators[0]
      ? await this.resolveWebhookDeliveryIndexLocator(
          latestPage.locators[0],
          'replay-chain',
        )
      : undefined
    if (
      !operationReplayId &&
      latestReplay &&
      (
        latestReplay.subscriptionId !== requested.delivery.subscriptionId ||
        latestReplay.eventId !== requested.delivery.eventId ||
        (latestReplay.replayOfDeliveryId ?? latestReplay.id) !== originalDeliveryId
      )
    ) {
      throw persistenceInvalid('Webhook replay chain invariant is invalid.')
    }
    if (
      !operationReplayId &&
      latestReplay &&
      (
        latestReplay.status === 'pending' ||
        latestReplay.status === 'retrying'
      )
    ) {
      return clone(latestReplay)
    }
    if (
      !operationReplayId &&
      !latestReplay &&
      (
        requested.delivery.status === 'pending' ||
        requested.delivery.status === 'retrying'
      )
    ) {
      return clone(requested.delivery)
    }
    let replayNumber = Math.max(
      latestReplay?.replayNumber ?? 0,
      requested.delivery.replayNumber ?? 0,
    ) + 1
    while (Number.isSafeInteger(replayNumber)) {
      const replayId = operationReplayId ?? createDeterministicReplayDeliveryId(
        originalDeliveryId,
        replayNumber,
      )
      const now = this.clock()
      const createdAt = now.toISOString()
      const delivery: WebhookDelivery = {
        id: replayId,
        subscriptionId: requested.delivery.subscriptionId,
        eventId: requested.delivery.eventId,
        eventType: requested.delivery.eventType,
        status: 'pending',
        attempts: 0,
        replayOfDeliveryId: originalDeliveryId,
        replayNumber,
        createdAt,
        updatedAt: createdAt,
      }
      const value: StoredWebhookDeliveryValue = {
        delivery,
        event: requested.event,
      }
      const records = createWebhookDeliveryStorageRecords(
        workspaceId,
        value,
        Math.floor(now.getTime() / 1_000) + WEBHOOK_DELIVERY_RETENTION_SECONDS,
      )
      if (await this.createWebhookDeliveryRecords(records)) return clone(delivery)
      const concurrent = await this.getRecord(
        workspaceId,
        createWebhookDeliveryRecordKey(replayId),
      )
      if (!concurrent || concurrent.entryType !== 'webhook-delivery') {
        throw persistenceConflict()
      }
      const concurrentReplay = readRecordValue<StoredWebhookDeliveryValue>(
        concurrent,
        'webhook-delivery',
      ).delivery
      if (
        concurrentReplay.replayOfDeliveryId !== originalDeliveryId ||
        concurrentReplay.replayNumber !== replayNumber ||
        concurrentReplay.subscriptionId !== requested.delivery.subscriptionId ||
        concurrentReplay.eventId !== requested.delivery.eventId
      ) {
        throw persistenceConflict()
      }
      if (operationReplayId) return clone(concurrentReplay)
      if (
        concurrentReplay.status === 'pending' ||
        concurrentReplay.status === 'retrying'
      ) {
        return clone(concurrentReplay)
      }
      replayNumber += 1
    }
    throw persistenceInvalid('Webhook replay number exceeded the supported range.')
  }

  /** Incoming webhook signature を timing-safe に検証します。 */
  async verifyWebhookSignature(request: VerifyWebhookSignatureRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const subscriptionId = readIdentifier(request.subscriptionId, 'Webhook subscription ID')
    const payload = request.payload
    if (typeof payload !== 'string') {
      throw invalid('WebhookPayloadInvalid', 'Webhook payload must be a string.')
    }
    const timestamp = readPositiveInteger(request.timestamp, 'Webhook signature timestamp')
    const toleranceSeconds = readPositiveInteger(
      request.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
      'Webhook signature tolerance',
      24 * 60 * 60,
    )
    const currentEpoch = Math.floor(this.clock().getTime() / 1_000)
    if (Math.abs(currentEpoch - timestamp) > toleranceSeconds) return false
    const record = await this.requireRecord(
      workspaceId,
      createWebhookRecordKey(subscriptionId),
      'webhook-subscription',
      'WebhookSubscriptionNotFound',
      'Webhook subscription was not found.',
    )
    const subscription = readRecordValue<WebhookSubscription>(
      record,
      'webhook-subscription',
    )
    if (subscription.status !== 'active') return false
    if (!record.secretCiphertext) throw persistenceInvalid('Webhook signing secret is missing.')
    const secret = await this.secretProtector.unprotect(
      record.secretCiphertext,
      createWebhookSecretContext(workspaceId, subscriptionId),
    )
    const expected = createWebhookSignature(secret, timestamp, payload)
    return safeTextEqual(expected, request.signature)
  }

  /** Connector credential を暗号化して installation を作成します。 */
  async installConnector(request: InstallConnectorRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const installedByUserId = readIdentifier(request.installedByUserId, 'Installer user ID')
    const input = request.input
    const category = readConnectorCategory(input.category)
    const provider = readProvider(input.provider)
    if (!connectorProviderMatchesCategory(provider, category)) {
      throw invalid(
        'ConnectorCategoryProviderMismatch',
        'Connector provider does not belong to the selected category.',
      )
    }
    const name = readName(input.name, 'Connector name')
    const scopes = readConnectorScopes(input.scopes)
    const externalAccountId = input.externalAccountId === undefined
      ? undefined
      : readIdentifier(input.externalAccountId, 'External account ID')
    const externalAccountName = input.externalAccountName === undefined
      ? undefined
      : readName(input.externalAccountName, 'External account name')
    const id = createId('connector')
    const credential = input.credential === undefined
      ? undefined
      : requireText(input.credential, 'Connector credential')
    const now = this.clock().toISOString()
    const installation: ConnectorInstallation = {
      id,
      category,
      provider,
      name,
      status: credential ? 'connected' : 'disconnected',
      scopes,
      ...(externalAccountId ? { externalAccountId } : {}),
      ...(externalAccountName ? { externalAccountName } : {}),
      installedByUserId,
      installedAt: now,
      updatedAt: now,
    }
    const secretCiphertext = credential
      ? await this.secretProtector.protect(
          credential,
          createConnectorSecretContext(workspaceId, id),
        )
      : undefined
    const record = createRecord(
      workspaceId,
      createConnectorRecordKey(id),
      'connector-installation',
      installation,
      {
        secretCiphertext,
        ...(credential
          ? {
              connectorCredentialDigest: digestConnectorCredential(credential),
              connectorCredentialRevision: 1,
            }
          : { connectorCredentialRevision: 0 }),
        connectorOAuthStateRevision: 0,
        externalLinkCount: 0,
      },
    )
    const auditPut = this.createPlatformAuditPut({
      workspaceId,
      eventType: 'connector.installed',
      entityType: 'connector-installation',
      entityId: id,
      transitionId: 'installed:1',
      occurredAt: now,
      action: 'installed',
      summary: 'Connector installation was created.',
      actorId: installedByUserId,
      metadata: {
        category,
        provider,
        status: installation.status,
        scopesCount: scopes.length,
        credentialConfigured: credential !== undefined,
      },
    })
    const saved = auditPut
      ? await this.putRecordWithAudit(record, { ifAbsent: true }, auditPut)
      : await this.putRecord(record, { ifAbsent: true })
    if (!saved) throw persistenceConflict()
    return clone(installation)
  }

  /** Workspace の credential を含まない connector summary を返します。 */
  async listConnectors(workspaceIdValue: string) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const records = await this.listRecords(workspaceId, 'CONNECTOR#')
    return records
      .map((record) =>
        clone(readRecordValue<ConnectorInstallation>(record, 'connector-installation'))
      )
      .sort((left, right) =>
        right.installedAt.localeCompare(left.installedAt) ||
        right.id.localeCompare(left.id)
      )
  }

  /** Strongly consistent connector lifecycle snapshot と revision を返します。 */
  async readConnectorLifecycleSnapshot(
    request: ReadConnectorLifecycleSnapshotRequest,
  ) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const installationId = readIdentifier(
      request.installationId,
      'Connector installation ID',
    )
    const record = await this.requireRecord(
      workspaceId,
      createConnectorRecordKey(installationId),
      'connector-installation',
      'ConnectorInstallationNotFound',
      'Connector installation was not found.',
    )
    return {
      installation: clone(readRecordValue<ConnectorInstallation>(
        record,
        'connector-installation',
      )),
      lifecycleRevision: record.version,
      ...(record.connectorDisconnectCleanupRevision === undefined
        ? {}
        : {
            disconnectCleanupRevision:
              record.connectorDisconnectCleanupRevision,
          }),
    } satisfies ConnectorLifecycleSnapshot
  }

  /** Connector の current health status を保存します。 */
  async updateConnectorStatus(request: UpdateConnectorStatusRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const installationId = readIdentifier(request.installationId, 'Connector installation ID')
    const status = readConnectorStatus(request.status)
    const updatedByUserId = request.updatedByUserId === undefined
      ? undefined
      : readIdentifier(request.updatedByUserId, 'Connector updater user ID')
    const expectedLifecycleRevision = request.expectedLifecycleRevision === undefined
      ? undefined
      : readPositiveInteger(
          request.expectedLifecycleRevision,
          'Connector lifecycle revision',
        )
    const expectedCredential = request.expectedCredential === undefined
      ? undefined
      : requireText(request.expectedCredential, 'Expected connector credential')
    if (expectedCredential && status !== 'disconnected') {
      throw invalid(
        'ConnectorCredentialExpectationInvalid',
        'Expected credential can only fence connector disconnect.',
      )
    }
    const record = await this.requireRecord(
      workspaceId,
      createConnectorRecordKey(installationId),
      'connector-installation',
      'ConnectorInstallationNotFound',
      'Connector installation was not found.',
    )
    const current = readRecordValue<ConnectorInstallation>(
      record,
      'connector-installation',
    )
    if (
      expectedLifecycleRevision !== undefined &&
      record.version !== expectedLifecycleRevision
    ) {
      throw conflict(
        'ConnectorLifecycleChanged',
        'Connector lifecycle changed before the status mutation was committed.',
      )
    }
    if (
      current.status === 'disconnected' &&
      status !== 'disconnected' &&
      !(
        status === 'needs-reauth' &&
        request.reauthorizationStateId !== undefined &&
        updatedByUserId !== undefined
      )
    ) {
      return clone(current)
    }
    if (
      record.connectorOAuthStateDigest &&
      status !== 'needs-reauth' &&
      status !== 'disconnected'
    ) {
      return clone(current)
    }
    if (status === 'connected' && !record.secretCiphertext) {
      throw conflict(
        'ConnectorCredentialRequired',
        'Connector cannot be connected without a credential.',
      )
    }
    if (
      expectedCredential &&
      (
        !record.connectorCredentialDigest ||
        !secretDigestsEqual(
          record.connectorCredentialDigest,
          digestConnectorCredential(expectedCredential),
        )
      )
    ) {
      throw conflict(
        'ConnectorCredentialChanged',
        'Connector credential changed before disconnect completed.',
      )
    }
    const lastError = request.lastError === undefined
      ? undefined
      : sanitizeConnectorProblem(request.lastError)
    const reauthorizationUrl = request.reauthorizationUrl === undefined
      ? undefined
      : readHttpsUrl(request.reauthorizationUrl, 'Connector reauthorization URL')
    const reauthorizationStateId = request.reauthorizationStateId === undefined
      ? undefined
      : readConnectorOAuthStateId(
          request.reauthorizationStateId,
        )
    if (status === 'needs-reauth' && (!reauthorizationUrl || !reauthorizationStateId)) {
      throw invalid(
        'ConnectorReauthorizationStateRequired',
        'A connector needing reauthorization requires a URL and OAuth state.',
      )
    }
    if (status !== 'needs-reauth' && reauthorizationStateId !== undefined) {
      throw invalid(
        'ConnectorReauthorizationStateUnexpected',
        'OAuth state can only be bound to a connector needing reauthorization.',
      )
    }
    if (
      current.status === 'disconnected' &&
      status === 'needs-reauth' &&
      record.connectorDisconnectCleanupRevision !== undefined
    ) {
      throw conflict(
        'ConnectorDisconnectCleanupPending',
        'Connector reauthorization must wait for disconnect cleanup to finish.',
      )
    }
    const nextOAuthStateDigest = reauthorizationStateId
      ? digestConnectorOAuthState(reauthorizationStateId)
      : undefined
    if (
      status === 'needs-reauth' &&
      current.status === 'needs-reauth' &&
      reauthorizationUrl === current.reauthorizationUrl &&
      nextOAuthStateDigest !== undefined &&
      record.connectorOAuthStateDigest !== undefined &&
      secretDigestsEqual(
        nextOAuthStateDigest,
        record.connectorOAuthStateDigest,
      )
    ) {
      return clone(current)
    }
    const lastSyncAt = request.lastSyncAt === undefined
      ? current.lastSyncAt
      : readTimestamp(request.lastSyncAt, 'Connector last sync')
    const {
      lastError: _currentLastError,
      reauthorizationUrl: _currentReauthorizationUrl,
      ...stableInstallation
    } = current
    const installation: ConnectorInstallation = {
      ...stableInstallation,
      status,
      ...(lastSyncAt ? { lastSyncAt } : {}),
      ...(status === 'needs-reauth'
        ? {
            ...(lastError ? { lastError } : {}),
            reauthorizationUrl: reauthorizationUrl!,
          }
        : status === 'degraded' || status === 'conflict'
          ? lastError ? { lastError } : {}
          : {}),
      updatedAt: this.clock().toISOString(),
    }
    const currentOAuthStateRevision = record.connectorOAuthStateRevision ?? 0
    const currentCredentialRevision = record.connectorCredentialRevision ?? 0
    const invalidatesOAuthState =
      status !== 'needs-reauth' && record.connectorOAuthStateDigest !== undefined
    const nextOAuthStateRevision =
      reauthorizationStateId || invalidatesOAuthState
        ? currentOAuthStateRevision + 1
        : currentOAuthStateRevision
    const removesCredential =
      status === 'disconnected' && record.secretCiphertext !== undefined
    const isNoopDisconnect =
      status === 'disconnected' &&
      current.status === 'disconnected' &&
      current.lastError === undefined &&
      current.reauthorizationUrl === undefined &&
      record.secretCiphertext === undefined &&
      record.connectorCredentialDigest === undefined &&
      record.connectorCredentialRefreshClaimDigest === undefined &&
      record.connectorCredentialRefreshClaimedAt === undefined &&
      record.connectorOAuthStateDigest === undefined
    if (isNoopDisconnect) {
      return clone(current)
    }
    const updatedRecord: DeveloperPlatformRecord = {
      ...record,
      value: installation,
      connectorOAuthStateRevision: nextOAuthStateRevision,
      version: record.version + 1,
    }
    if (status === 'disconnected') {
      updatedRecord.connectorDisconnectCleanupRevision = updatedRecord.version
    } else {
      delete updatedRecord.connectorDisconnectCleanupRevision
    }
    if (nextOAuthStateDigest) {
      updatedRecord.connectorOAuthStateDigest = nextOAuthStateDigest
    } else {
      delete updatedRecord.connectorOAuthStateDigest
    }
    if (status === 'disconnected') {
      delete updatedRecord.secretCiphertext
      delete updatedRecord.connectorCredentialDigest
      if (removesCredential) {
        updatedRecord.connectorCredentialRevision = currentCredentialRevision + 1
      }
    }
    if (status === 'disconnected' || reauthorizationStateId) {
      delete updatedRecord.connectorCredentialRefreshClaimDigest
      delete updatedRecord.connectorCredentialRefreshClaimedAt
    }
    const now = installation.updatedAt
    const auditPut = this.createPlatformAuditPut({
      workspaceId,
      eventType: reauthorizationStateId
        ? 'connector.reauthorization.started'
        : 'connector.status.updated',
      entityType: 'connector-installation',
      entityId: installationId,
      transitionId: `status:${updatedRecord.version}:${nextOAuthStateRevision}`,
      occurredAt: now,
      action: reauthorizationStateId ? 'reauthorization-started' : 'status-updated',
      summary: reauthorizationStateId
        ? 'Connector reauthorization was started.'
        : 'Connector installation status changed.',
      ...(updatedByUserId ? { actorId: updatedByUserId } : {}),
      metadata: {
        category: current.category,
        provider: current.provider,
        previousStatus: current.status,
        status,
        oauthStateRevision: nextOAuthStateRevision,
        credentialRemoved: removesCredential,
        ...(status === 'disconnected'
          ? { disconnectCleanupRevision: updatedRecord.version }
          : {}),
      },
    })
    const saved = auditPut
      ? await this.putRecordWithAudit(
          updatedRecord,
          { expectedVersion: record.version },
          auditPut,
        )
      : await this.putRecord(updatedRecord, { expectedVersion: record.version })
    if (!saved) throw persistenceConflict()
    return clone(installation)
  }

  /** Provider code exchange 前に current reauthorization state digest を照合します。 */
  async assertConnectorReauthorizationState(
    request: AssertConnectorReauthorizationStateRequest,
  ) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const installationId = readIdentifier(
      request.installationId,
      'Connector installation ID',
    )
    const stateId = readConnectorOAuthStateId(request.stateId)
    const record = await this.requireRecord(
      workspaceId,
      createConnectorRecordKey(installationId),
      'connector-installation',
      'ConnectorInstallationNotFound',
      'Connector installation was not found.',
    )
    if (
      !record.connectorOAuthStateDigest ||
      !secretDigestsEqual(
        record.connectorOAuthStateDigest,
        digestConnectorOAuthState(stateId),
      )
    ) {
      throw conflict(
        'ConnectorReauthorizationStateStale',
        'Connector reauthorization state is no longer current.',
      )
    }
  }

  /** Provider refresh side effect の実行権を credential-bound durable lease で取得します。 */
  async claimConnectorCredentialRefresh(
    request: ClaimConnectorCredentialRefreshRequest,
    concurrentMutationRetries = 0,
  ): Promise<ConnectorCredentialRefreshClaimResult> {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const installationId = readIdentifier(
      request.installationId,
      'Connector installation ID',
    )
    const expectedCredential = requireText(
      request.expectedCredential,
      'Expected connector credential',
    )
    const claimId = readIdentifier(request.claimId, 'Connector refresh claim ID')
    const claimDigest = digestConnectorCredentialRefreshClaim(claimId)
    const record = await this.requireRecord(
      workspaceId,
      createConnectorRecordKey(installationId),
      'connector-installation',
      'ConnectorInstallationNotFound',
      'Connector installation was not found.',
    )
    const installation = readRecordValue<ConnectorInstallation>(
      record,
      'connector-installation',
    )
    if (installation.status === 'disconnected' || !record.secretCiphertext) {
      throw conflict(
        'ConnectorDisconnected',
        'Disconnected connector credentials cannot be refreshed.',
      )
    }
    if (record.connectorOAuthStateDigest) {
      throw conflict(
        'ConnectorReauthorizationStateRequired',
        'Current connector reauthorization must complete before credential refresh.',
      )
    }
    if (
      !record.connectorCredentialDigest ||
      !secretDigestsEqual(
        record.connectorCredentialDigest,
        digestConnectorCredential(expectedCredential),
      )
    ) return 'credential-changed'
    if (
      record.connectorCredentialRefreshClaimDigest &&
      record.connectorCredentialRefreshClaimedAt
    ) {
      const claimedAt = Date.parse(record.connectorCredentialRefreshClaimedAt)
      const active = Number.isFinite(claimedAt) &&
        claimedAt + CONNECTOR_CREDENTIAL_REFRESH_LEASE_SECONDS * 1_000 >
          this.clock().getTime()
      if (active) {
        return secretDigestsEqual(
            record.connectorCredentialRefreshClaimDigest,
            claimDigest,
          )
          ? 'same-operation'
          : 'busy'
      }
    }
    const updatedRecord: DeveloperPlatformRecord = {
      ...record,
      connectorCredentialRefreshClaimDigest: claimDigest,
      connectorCredentialRefreshClaimedAt: this.clock().toISOString(),
      version: record.version + 1,
    }
    if (await this.putRecord(
      updatedRecord,
      { expectedVersion: record.version },
    )) return 'claimed'
    if (concurrentMutationRetries < 3) {
      return this.claimConnectorCredentialRefresh(
        request,
        concurrentMutationRetries + 1,
      )
    }
    throw persistenceConflict()
  }

  /** Provider side effect 前後の失敗時に current refresh claim を CAS 解放します。 */
  async releaseConnectorCredentialRefresh(
    request: ReleaseConnectorCredentialRefreshRequest,
    concurrentMutationRetries = 0,
  ): Promise<boolean> {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const installationId = readIdentifier(
      request.installationId,
      'Connector installation ID',
    )
    const claimId = readIdentifier(request.claimId, 'Connector refresh claim ID')
    const record = await this.requireRecord(
      workspaceId,
      createConnectorRecordKey(installationId),
      'connector-installation',
      'ConnectorInstallationNotFound',
      'Connector installation was not found.',
    )
    if (
      !record.connectorCredentialRefreshClaimDigest ||
      !secretDigestsEqual(
        record.connectorCredentialRefreshClaimDigest,
        digestConnectorCredentialRefreshClaim(claimId),
      )
    ) return false
    const updatedRecord: DeveloperPlatformRecord = {
      ...record,
      version: record.version + 1,
    }
    delete updatedRecord.connectorCredentialRefreshClaimDigest
    delete updatedRecord.connectorCredentialRefreshClaimedAt
    if (await this.putRecord(
      updatedRecord,
      { expectedVersion: record.version },
    )) return true
    if (concurrentMutationRetries < 3) {
      return this.releaseConnectorCredentialRefresh(
        request,
        concurrentMutationRetries + 1,
      )
    }
    throw persistenceConflict()
  }

  /** Credential を置換して connector を connected へ復旧します。 */
  async recoverConnector(
    request: RecoverConnectorRequest,
    concurrentMutationRetries = 0,
  ): Promise<ConnectorInstallation> {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const installationId = readIdentifier(request.installationId, 'Connector installation ID')
    const credential = requireText(request.credential, 'Connector credential')
    const expectedReauthorizationStateId =
      request.expectedReauthorizationStateId === undefined
        ? undefined
        : readConnectorOAuthStateId(
            request.expectedReauthorizationStateId,
          )
    const expectedCredential = request.expectedCredential === undefined
      ? undefined
      : requireText(request.expectedCredential, 'Expected connector credential')
    const refreshClaimId = request.refreshClaimId === undefined
      ? undefined
      : readIdentifier(request.refreshClaimId, 'Connector refresh claim ID')
    if (
      expectedReauthorizationStateId &&
      (expectedCredential || refreshClaimId)
    ) {
      throw invalid(
        'ConnectorCredentialExpectationInvalid',
        'Credential replacement cannot compare OAuth state and credential together.',
      )
    }
    const reason = readConnectorCredentialReplacementReason(request.reason ?? (
      expectedReauthorizationStateId
        ? 'reauthorization'
        : expectedCredential
          ? 'refresh'
          : 'recovery'
    ))
    if (
      (reason === 'reauthorization' && !expectedReauthorizationStateId) ||
      (reason === 'refresh' && (!expectedCredential || !refreshClaimId))
    ) {
      throw invalid(
        'ConnectorCredentialExpectationRequired',
        'Credential replacement reason requires its matching current value.',
      )
    }
    if (
      (reason !== 'reauthorization' && expectedReauthorizationStateId) ||
      (reason !== 'refresh' && (expectedCredential || refreshClaimId))
    ) {
      throw invalid(
        'ConnectorCredentialExpectationInvalid',
        'Credential replacement expectation does not match its lifecycle reason.',
      )
    }
    const updatedByUserId = request.updatedByUserId === undefined
      ? undefined
      : readIdentifier(request.updatedByUserId, 'Connector updater user ID')
    const record = await this.requireRecord(
      workspaceId,
      createConnectorRecordKey(installationId),
      'connector-installation',
      'ConnectorInstallationNotFound',
      'Connector installation was not found.',
    )
    const current = readRecordValue<ConnectorInstallation>(
      record,
      'connector-installation',
    )
    if (record.connectorOAuthStateDigest && !expectedReauthorizationStateId) {
      throw conflict(
        'ConnectorReauthorizationStateRequired',
        'Current connector reauthorization requires its expected OAuth state.',
      )
    }
    if (
      expectedReauthorizationStateId &&
      (
        !record.connectorOAuthStateDigest ||
        !secretDigestsEqual(
          record.connectorOAuthStateDigest,
          digestConnectorOAuthState(expectedReauthorizationStateId),
        )
      )
    ) {
      throw conflict(
        'ConnectorReauthorizationStateStale',
        'Connector reauthorization state is no longer current.',
      )
    }
    if (
      expectedCredential &&
      (
        !record.connectorCredentialDigest ||
        !secretDigestsEqual(
          record.connectorCredentialDigest,
          digestConnectorCredential(expectedCredential),
        )
      )
    ) {
      throw conflict(
        'ConnectorCredentialChanged',
        'Connector credential changed before refresh completed.',
      )
    }
    if (
      refreshClaimId &&
      (
        !record.connectorCredentialRefreshClaimDigest ||
        !secretDigestsEqual(
          record.connectorCredentialRefreshClaimDigest,
          digestConnectorCredentialRefreshClaim(refreshClaimId),
        )
      )
    ) {
      throw conflict(
        'ConnectorCredentialRefreshClaimLost',
        'Connector credential refresh claim is no longer current.',
      )
    }
    const {
      lastError: _currentLastError,
      reauthorizationUrl: _currentReauthorizationUrl,
      ...stableInstallation
    } = current
    const installation: ConnectorInstallation = {
      ...stableInstallation,
      status: 'connected',
      updatedAt: this.clock().toISOString(),
    }
    const secretCiphertext = await this.secretProtector.protect(
      credential,
      createConnectorSecretContext(workspaceId, installationId),
    )
    const previousCredentialRevision = record.connectorCredentialRevision ?? 0
    const previousOAuthStateRevision = record.connectorOAuthStateRevision ?? 0
    const nextOAuthStateRevision = record.connectorOAuthStateDigest
      ? previousOAuthStateRevision + 1
      : previousOAuthStateRevision
    const updatedRecord: DeveloperPlatformRecord = {
      ...record,
      value: installation,
      secretCiphertext,
      connectorCredentialDigest: digestConnectorCredential(credential),
      connectorCredentialRevision: previousCredentialRevision + 1,
      connectorOAuthStateRevision: nextOAuthStateRevision,
      version: record.version + 1,
    }
    delete updatedRecord.connectorCredentialRefreshClaimDigest
    delete updatedRecord.connectorCredentialRefreshClaimedAt
    delete updatedRecord.connectorOAuthStateDigest
    const auditPut = this.createPlatformAuditPut({
      workspaceId,
      eventType: 'connector.credential.replaced',
      entityType: 'connector-installation',
      entityId: installationId,
      transitionId:
        `credential:${updatedRecord.version}:${previousCredentialRevision + 1}`,
      occurredAt: installation.updatedAt,
      action: 'credential-replaced',
      summary: 'Connector credential was replaced.',
      ...(updatedByUserId ? { actorId: updatedByUserId } : {}),
      metadata: {
        category: current.category,
        provider: current.provider,
        previousStatus: current.status,
        status: installation.status,
        reason,
        previousCredentialRevision,
        credentialRevision: previousCredentialRevision + 1,
        oauthStateRevision: nextOAuthStateRevision,
      },
    })
    const saved = auditPut
      ? await this.putRecordWithAudit(
          updatedRecord,
          { expectedVersion: record.version },
          auditPut,
        )
      : await this.putRecord(updatedRecord, { expectedVersion: record.version })
    if (!saved) {
      if (expectedReauthorizationStateId) {
        const latest = await this.requireRecord(
          workspaceId,
          createConnectorRecordKey(installationId),
          'connector-installation',
          'ConnectorInstallationNotFound',
          'Connector installation was not found.',
        )
        if (
          latest.connectorOAuthStateDigest &&
          secretDigestsEqual(
            latest.connectorOAuthStateDigest,
            digestConnectorOAuthState(expectedReauthorizationStateId),
          )
        ) {
          if (concurrentMutationRetries < 3) {
            return this.recoverConnector(request, concurrentMutationRetries + 1)
          }
          throw persistenceConflict()
        }
        throw conflict(
          'ConnectorReauthorizationStateStale',
          'Connector reauthorization state is no longer current.',
        )
      }
      if (expectedCredential) {
        const latest = await this.requireRecord(
          workspaceId,
          createConnectorRecordKey(installationId),
          'connector-installation',
          'ConnectorInstallationNotFound',
          'Connector installation was not found.',
        )
        if (latest.connectorOAuthStateDigest) {
          throw conflict(
            'ConnectorReauthorizationStateRequired',
            'Current connector reauthorization requires its expected OAuth state.',
          )
        }
        if (
          latest.connectorCredentialDigest &&
          secretDigestsEqual(
            latest.connectorCredentialDigest,
            digestConnectorCredential(expectedCredential),
          )
        ) {
          if (
            !refreshClaimId ||
            !latest.connectorCredentialRefreshClaimDigest ||
            !secretDigestsEqual(
              latest.connectorCredentialRefreshClaimDigest,
              digestConnectorCredentialRefreshClaim(refreshClaimId),
            )
          ) {
            throw conflict(
              'ConnectorCredentialRefreshClaimLost',
              'Connector credential refresh claim is no longer current.',
            )
          }
          if (concurrentMutationRetries < 3) {
            return this.recoverConnector(request, concurrentMutationRetries + 1)
          }
          throw persistenceConflict()
        }
        throw conflict(
          'ConnectorCredentialChanged',
          'Connector credential changed before refresh completed.',
        )
      }
      throw persistenceConflict()
    }
    return clone(installation)
  }

  /** Connector worker 内でのみ使う credential を復号します。 */
  async readConnectorCredential(request: ReadConnectorCredentialRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const installationId = readIdentifier(request.installationId, 'Connector installation ID')
    const record = await this.requireRecord(
      workspaceId,
      createConnectorRecordKey(installationId),
      'connector-installation',
      'ConnectorInstallationNotFound',
      'Connector installation was not found.',
    )
    const installation = readRecordValue<ConnectorInstallation>(
      record,
      'connector-installation',
    )
    if (installation.status === 'disconnected') {
      throw conflict(
        'ConnectorDisconnected',
        'Disconnected connector credentials cannot be read.',
      )
    }
    if (!record.secretCiphertext) {
      throw conflict(
        'ConnectorCredentialMissing',
        'Connector installation has no stored credential.',
      )
    }
    return this.secretProtector.unprotect(
      record.secretCiphertext,
      createConnectorSecretContext(workspaceId, installationId),
    )
  }

  /** Disconnected installation の external links をdurable continuation単位でpauseします。 */
  async pauseConnectorExternalLinksPage(
    request: PauseConnectorExternalLinksPageRequest,
  ): Promise<PauseConnectorExternalLinksPageResult> {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const installationId = readIdentifier(
      request.installationId,
      'Connector installation ID',
    )
    const expectedLifecycleRevision = readPositiveInteger(
      request.expectedLifecycleRevision,
      'Connector lifecycle revision',
    )
    const updatedByUserId = request.updatedByUserId === undefined
      ? undefined
      : readIdentifier(request.updatedByUserId, 'Connector updater user ID')
    const limit = readBoundedLimit(
      request.limit,
      CONNECTOR_DISCONNECT_PAGE_MAX_LIMIT,
      'Connector disconnect page limit',
    )
    const recordKeyPrefix = createExternalLinkInstallationIndexRecordPrefix(
      installationId,
    )
    const exclusiveStartRecordKey = request.cursor === undefined
      ? undefined
      : decodeInternalRecordCursor(
          request.cursor,
          recordKeyPrefix,
          'Connector disconnect cursor',
        )
    const installationRecord = await this.getRecord(
      workspaceId,
      createConnectorRecordKey(installationId),
    )
    const installation = installationRecord?.entryType === 'connector-installation'
      ? readRecordValue<ConnectorInstallation>(
          installationRecord,
          'connector-installation',
        )
      : undefined
    if (
      !installationRecord ||
      installation?.status !== 'disconnected' ||
      installationRecord.connectorDisconnectCleanupRevision !==
        expectedLifecycleRevision
    ) return { paused: 0 }

    const page = await this.listRecordsPage(
      workspaceId,
      recordKeyPrefix,
      limit,
      exclusiveStartRecordKey,
    )
    const outcomes = await mapWithConcurrency(
      page.records,
      5,
      async (indexRecord): Promise<'paused' | 'unchanged' | 'stale'> => {
        if (indexRecord.entryType !== 'external-link-index') {
          throw persistenceInvalid('External link installation index row is invalid.')
        }
        const index = readRecordValue<StoredExternalLinkIndexValue>(
          indexRecord,
          'external-link-index',
        )
        if (index.kind !== 'installation') {
          throw persistenceInvalid('External link installation index kind is invalid.')
        }
        let connectorGuardRecord = installationRecord
        let record = await this.getRecord(workspaceId, index.targetRecordKey)
        for (let attempt = 0; attempt < 3 && record; attempt += 1) {
          if (record.entryType !== 'external-link') {
            throw persistenceInvalid('External link installation index target is invalid.')
          }
          const link = readRecordValue<ExternalWorkItemLink>(record, 'external-link')
          if (link.installationId !== installationId) {
            throw persistenceInvalid('External link installation index scope is invalid.')
          }
          if (link.syncStatus === 'paused') return 'unchanged'
          const paused: ExternalWorkItemLink = {
            ...link,
            syncStatus: 'paused',
            updatedAt: this.clock().toISOString(),
          }
          const nextRecord = createExternalLinkReplacementRecord(record, paused)
          const auditPut = this.createPlatformAuditPut({
            workspaceId,
            eventType: 'external-link.updated',
            entityType: 'external-link',
            entityId: link.id,
            transitionId: `connector-disconnect:${nextRecord.version}`,
            teamId: link.teamId,
            occurredAt: paused.updatedAt,
            action: 'paused',
            summary:
              'External Work Item link was paused because its connector disconnected.',
            ...(updatedByUserId ? { actorId: updatedByUserId } : {}),
            metadata: {
              externalLinkId: link.id,
              workItemId: link.workItemId,
              installationId,
              resourceType: link.resourceType,
              previousSyncDirection: link.syncDirection,
              syncDirection: link.syncDirection,
              previousSyncStatus: link.syncStatus,
              syncStatus: paused.syncStatus,
              cause: 'connector-disconnected',
            },
          })
          if (await this.putExternalLinkWithConnectorGuard(
            nextRecord,
            record.version,
            connectorGuardRecord,
            link,
            'disconnected',
            undefined,
            auditPut,
          )) return 'paused'
          const currentInstallation = await this.getRecord(
            workspaceId,
            connectorGuardRecord.recordKey,
          )
          const currentInstallationValue =
            currentInstallation?.entryType === 'connector-installation'
              ? readRecordValue<ConnectorInstallation>(
                  currentInstallation,
                  'connector-installation',
                )
              : undefined
          if (
            currentInstallation?.connectorDisconnectCleanupRevision !==
              expectedLifecycleRevision ||
            currentInstallationValue?.status !== 'disconnected'
          ) return 'stale'
          connectorGuardRecord = currentInstallation
          record = await this.getRecord(workspaceId, record.recordKey)
        }
        if (!record) return 'unchanged'
        throw persistenceConflict()
      },
    )
    const paused = outcomes.filter((outcome) => outcome === 'paused').length
    if (outcomes.includes('stale')) return { paused }
    if (page.nextRecordKey) {
      return {
        paused,
        nextCursor: encodeInternalRecordCursor(page.nextRecordKey),
      }
    }
    const completionRecord = await this.getRecord(
      workspaceId,
      installationRecord.recordKey,
    )
    const completionInstallation = completionRecord?.entryType ===
        'connector-installation'
      ? readRecordValue<ConnectorInstallation>(
          completionRecord,
          'connector-installation',
        )
      : undefined
    if (
      !completionRecord ||
      completionInstallation?.status !== 'disconnected' ||
      completionRecord.connectorDisconnectCleanupRevision !==
        expectedLifecycleRevision
    ) return { paused }
    if (!await this.clearConnectorDisconnectCleanupMarker(
      workspaceId,
      completionRecord.recordKey,
      completionRecord.version,
      expectedLifecycleRevision,
    )) {
      const latest = await this.getRecord(workspaceId, completionRecord.recordKey)
      if (
        latest?.connectorDisconnectCleanupRevision ===
          expectedLifecycleRevision
      ) throw persistenceConflict()
    }
    return { paused }
  }

  /** External resource と canonical Work Item の一意な link を作成します。 */
  async createExternalWorkItemLink(request: CreateExternalWorkItemLinkRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const input = request.input
    const teamId = readIdentifier(input.teamId, 'Team ID')
    const workItemId = readIdentifier(input.workItemId, 'Work Item ID')
    const installationId = readIdentifier(input.installationId, 'Connector installation ID')
    const resourceType = readExternalResourceType(input.resourceType)
    const installationRecord = await this.getRecord(
      workspaceId,
      createConnectorRecordKey(installationId),
    )
    if (!installationRecord || installationRecord.entryType !== 'connector-installation') {
      throw notFound(
        'ConnectorInstallationNotFound',
        'Connector installation was not found.',
      )
    }
    const installation = readRecordValue<ConnectorInstallation>(
      installationRecord,
      'connector-installation',
    )
    if (installation.status !== 'connected') {
      throw conflict(
        'ConnectorNotConnected',
        'External links require a connected connector installation.',
      )
    }
    if (installation.category !== 'source-control') {
      throw conflict(
        'ConnectorCapabilityUnsupported',
        `${resourceType} external links require a source-control connector.`,
      )
    }
    const externalId = readExternalIdentifier(input.externalId)
    const externalUrl = readHttpsUrl(input.externalUrl, 'External resource URL')
    const displayKey = input.displayKey === undefined
      ? undefined
      : readName(input.displayKey, 'External display key')
    const syncDirection = readExternalSyncDirection(input.syncDirection)
    const id = createId('link')
    const now = this.clock().toISOString()
    const link: ExternalWorkItemLink = {
      id,
      teamId,
      workItemId,
      installationId,
      provider: installation.provider,
      installationName: installation.name,
      ...(installation.externalAccountName
        ? { externalAccountName: installation.externalAccountName }
        : {}),
      resourceType,
      externalId,
      externalUrl,
      ...(displayKey ? { displayKey } : {}),
      syncDirection,
      syncStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    const linkRecord = createRecord(
      workspaceId,
      createExternalLinkRecordKey(id),
      'external-link',
      link,
    )
    const indexRecords = createExternalLinkIndexRecords(workspaceId, link)
    const claimRecordKey = createExternalLinkClaimRecordKey(
      installationId,
      resourceType,
      externalId,
    )
    const claimRecord = createRecord(
      workspaceId,
      claimRecordKey,
      'external-link-claim',
      { targetRecordKey: linkRecord.recordKey } satisfies StoredExternalLinkClaimValue,
    )
    const auditPut = this.createPlatformAuditPut({
      workspaceId,
      eventType: 'external-link.created',
      entityType: 'external-link',
      entityId: id,
      transitionId: 'created',
      teamId,
      occurredAt: now,
      action: 'created',
      summary: 'External resource was linked to a Work Item.',
      metadata: {
        externalLinkId: id,
        workItemId,
        installationId,
        resourceType,
        syncDirection,
      },
    })
    const result = await this.saveExternalLinkWithClaim(
      linkRecord,
      claimRecord,
      indexRecords,
      installationRecord,
      auditPut,
    )
    if (result === 'installation-changed') {
      throw conflict(
        'ConnectorNotConnected',
        'External links require a connected connector installation.',
      )
    }
    if (result === 'work-item-deleted') {
      throw conflict(
        'ExternalWorkItemTargetDeleted',
        'The Work Item was deleted while the external link was being created.',
      )
    }
    if (result === 'installation-limit-exceeded') {
      throw new DeveloperPlatformError(
        413,
        'ExternalWorkItemLinkLimitExceeded',
        `A connector installation cannot have more than ${EXTERNAL_LINK_INSTALLATION_LIMIT} external links.`,
      )
    }
    if (result === 'work-item-limit-exceeded') {
      throw new DeveloperPlatformError(
        413,
        'ExternalWorkItemLinkLimitExceeded',
        `A Work Item cannot have more than ${EXTERNAL_LINK_WORK_ITEM_LIMIT} external links.`,
      )
    }
    if (result === 'conflict') {
      throw conflict(
        'ExternalWorkItemLinkConflict',
        'External resource is already linked with a different target or configuration.',
      )
    }
    if (result === 'same-owner') {
      const claim = await this.getRecord(workspaceId, claimRecordKey)
      const claimValue = claim
        ? readRecordValue<StoredExternalLinkClaimValue>(claim, 'external-link-claim')
        : undefined
      const existing = claimValue
        ? await this.getRecord(workspaceId, claimValue.targetRecordKey)
        : undefined
      if (!existing) throw persistenceInvalid('External link claim has no target.')
      const existingLink = readRecordValue<ExternalWorkItemLink>(
        existing,
        'external-link',
      )
      if (!haveSameExternalLinkCreationFields(existingLink, link)) {
        throw conflict(
          'ExternalWorkItemLinkConflict',
          'External resource is already linked with a different target or configuration.',
        )
      }
      return clone(existingLink)
    }
    return clone(link)
  }

  /** Workspace 内の external link を取得します。 */
  async listExternalWorkItemLinks(request: ListExternalWorkItemLinksRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const linkId = request.linkId === undefined
      ? undefined
      : readIdentifier(request.linkId, 'External Work Item link ID')
    const workItemId = request.workItemId === undefined
      ? undefined
      : readIdentifier(request.workItemId, 'Work Item ID')
    const teamId = request.teamId === undefined
      ? undefined
      : readIdentifier(request.teamId, 'Team ID')
    if ((teamId === undefined) !== (workItemId === undefined)) {
      throw invalid(
        'ExternalWorkItemIdentityInvalid',
        'External Work Item filters require both teamId and workItemId.',
      )
    }
    const installationId = request.installationId === undefined
      ? undefined
      : readIdentifier(request.installationId, 'Connector installation ID')
    const resourceType = request.resourceType === undefined
      ? undefined
      : readExternalResourceType(request.resourceType)
    if (resourceType && !installationId) {
      throw invalid(
        'ExternalWorkItemFilterInvalid',
        'External resourceType filter requires installationId.',
      )
    }
    if (
      linkId &&
      (teamId || workItemId || installationId || resourceType)
    ) {
      throw invalid(
        'ExternalWorkItemFilterInvalid',
        'External link ID cannot be combined with list filters.',
      )
    }
    if (linkId) {
      const record = await this.getRecord(workspaceId, createExternalLinkRecordKey(linkId))
      return record?.entryType === 'external-link'
        ? [clone(readRecordValue<ExternalWorkItemLink>(record, 'external-link'))]
        : []
    }

    let links: ExternalWorkItemLink[]
    if (teamId && workItemId) {
      links = await this.listExternalLinksByLookupKey(
        createExternalLinkWorkItemLookupKey(workspaceId, teamId, workItemId),
        'work-item',
      )
    } else if (installationId) {
      const resourceTypes = resourceType
        ? [resourceType]
        : EXTERNAL_LINK_RESOURCE_TYPES
      links = (await Promise.all(resourceTypes.map((candidate) =>
        this.listExternalLinksByLookupKey(
          createExternalLinkInstallationLookupKey(
            workspaceId,
            installationId,
            candidate,
          ),
          'installation',
        )
      ))).flat()
    } else {
      const records = await this.listRecords(workspaceId, 'EXTERNALLINK#')
      links = records.map((record) =>
        clone(readRecordValue<ExternalWorkItemLink>(record, 'external-link'))
      )
    }
    return links
      .filter((link) =>
        (teamId === undefined || link.teamId === teamId) &&
        (workItemId === undefined || link.workItemId === workItemId) &&
        (installationId === undefined || link.installationId === installationId) &&
        (resourceType === undefined || link.resourceType === resourceType)
      )
      .sort(compareCreatedAtDescending)
  }

  /** Materialized GSI locators を bounded page 取得し、authoritative link rows を再検証します。 */
  private async listExternalLinksByLookupKey(
    lookupKey: string,
    expectedKind: StoredExternalLinkIndexValue['kind'],
  ) {
    const links = new Map<string, ExternalWorkItemLink>()
    let exclusiveStartKey: DeveloperPlatformRecordLocator | undefined
    let previousCursor: string | undefined
    do {
      const page = await this.queryLookupIndex({
        lookupKey,
        limit: EXTERNAL_LINK_INDEX_PAGE_SIZE,
        scanIndexForward: false,
        ...(exclusiveStartKey ? { exclusiveStartKey } : {}),
      })
      const resolved = await Promise.all(page.locators.map(async (locator) => {
        const indexRecord = await this.getRecord(locator.workspaceId, locator.recordKey)
        if (!indexRecord) return undefined
        if (
          indexRecord.entryType !== 'external-link-index' ||
          indexRecord.lookupKey !== lookupKey ||
          indexRecord.lookupSortKey !== locator.lookupSortKey
        ) {
          throw persistenceInvalid('External link index locator is invalid.')
        }
        const index = readRecordValue<StoredExternalLinkIndexValue>(
          indexRecord,
          'external-link-index',
        )
        if (index.kind !== expectedKind) {
          throw persistenceInvalid('External link index kind is invalid.')
        }
        const target = await this.getRecord(locator.workspaceId, index.targetRecordKey)
        if (!target) return undefined
        if (
          target.entryType !== 'external-link' ||
          target.recordKey !== index.targetRecordKey
        ) {
          throw persistenceInvalid('External link index target is invalid.')
        }
        return clone(readRecordValue<ExternalWorkItemLink>(target, 'external-link'))
      }))
      for (const link of resolved) {
        if (link) links.set(link.id, link)
      }
      if (links.size > EXTERNAL_LINK_INDEX_RESULT_LIMIT) {
        throw new DeveloperPlatformError(
          413,
          'ExternalWorkItemLinkLimitExceeded',
          `External link filter cannot return more than ${EXTERNAL_LINK_INDEX_RESULT_LIMIT} items.`,
        )
      }
      const cursor = page.lastEvaluatedKey
        ? `${page.lastEvaluatedKey.lookupSortKey}\0${page.lastEvaluatedKey.recordKey}`
        : undefined
      if (cursor && cursor === previousCursor) {
        throw persistenceInvalid('External link index pagination did not advance.')
      }
      previousCursor = cursor
      exclusiveStartKey = page.lastEvaluatedKey
    } while (exclusiveStartKey)
    return [...links.values()]
  }

  /** External link の同期方向を更新し、再同期または一時停止状態へ遷移します。 */
  async updateExternalWorkItemLink(request: UpdateExternalWorkItemLinkRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const teamId = readIdentifier(request.teamId, 'Team ID')
    const workItemId = readIdentifier(request.workItemId, 'Work Item ID')
    const linkId = readIdentifier(request.linkId, 'External Work Item link ID')
    const updatedByUserId = readIdentifier(
      request.updatedByUserId,
      'External Work Item link updater user ID',
    )
    const syncDirection = readExternalSyncDirection(request.input.syncDirection)
    const record = await this.requireRecord(
      workspaceId,
      createExternalLinkRecordKey(linkId),
      'external-link',
      'ExternalWorkItemLinkNotFound',
      'External Work Item link was not found.',
    )
    const current = readRecordValue<ExternalWorkItemLink>(record, 'external-link')
    if (current.teamId !== teamId || current.workItemId !== workItemId) {
      throw notFound(
        'ExternalWorkItemLinkNotFound',
        'External Work Item link was not found.',
      )
    }
    if (current.syncStatus === 'conflict') {
      throw conflict(
        'ExternalWorkItemLinkSyncConflict',
        'Resolve the open synchronization conflict before changing this link.',
      )
    }
    const installationRecord = await this.requireRecord(
      workspaceId,
      createConnectorRecordKey(current.installationId),
      'connector-installation',
      'ConnectorInstallationNotFound',
      'Connector installation was not found.',
    )
    const installation = readRecordValue<ConnectorInstallation>(
      installationRecord,
      'connector-installation',
    )
    if (installation.status !== 'connected') {
      throw conflict(
        'ConnectorNotConnected',
        'Disconnected connector links cannot be resumed.',
      )
    }
    const now = this.clock().toISOString()
    const link: ExternalWorkItemLink = {
      ...current,
      syncDirection,
      syncStatus: syncDirection === 'none' ? 'paused' : 'pending',
      updatedAt: now,
    }
    const nextRecord = createExternalLinkReplacementRecord(record, link)
    const auditPut = this.createPlatformAuditPut({
      workspaceId,
      eventType: 'external-link.updated',
      entityType: 'external-link',
      entityId: link.id,
      transitionId: `direction:${nextRecord.version}:${syncDirection}`,
      teamId,
      occurredAt: now,
      action: 'updated',
      summary: 'External Work Item link synchronization direction changed.',
      actorId: updatedByUserId,
      metadata: {
        externalLinkId: link.id,
        workItemId,
        installationId: link.installationId,
        resourceType: link.resourceType,
        previousSyncDirection: current.syncDirection,
        syncDirection: link.syncDirection,
        previousSyncStatus: current.syncStatus,
        syncStatus: link.syncStatus,
      },
    })
    const completion = request.idempotency
      ? await this.prepareIdempotencyCompletionRecord(
          workspaceId,
          request.idempotency,
          { status: 200, body: link },
        )
      : undefined
    const saved = await this.putExternalLinkWithConnectorGuard(
      nextRecord,
      record.version,
      installationRecord,
      current,
      'connected',
      completion,
      auditPut,
    )
    if (!saved) {
      const currentInstallation = await this.getRecord(
        workspaceId,
        installationRecord.recordKey,
      )
      const currentInstallationValue = currentInstallation?.entryType ===
          'connector-installation'
        ? readRecordValue<ConnectorInstallation>(
            currentInstallation,
            'connector-installation',
          )
        : undefined
      if (currentInstallationValue?.status !== 'connected') {
        throw conflict(
          'ConnectorNotConnected',
          'Disconnected connector links cannot be resumed.',
        )
      }
      throw persistenceConflict()
    }
    return clone(link)
  }

  /** External link と uniqueness claim を削除します。 */
  async deleteExternalWorkItemLink(request: DeleteExternalWorkItemLinkRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const teamId = readIdentifier(request.teamId, 'Team ID')
    const workItemId = readIdentifier(request.workItemId, 'Work Item ID')
    const linkId = readIdentifier(request.linkId, 'External Work Item link ID')
    const deletedByActorId = request.deletedByActorId === undefined
      ? undefined
      : readIdentifier(
          request.deletedByActorId,
          'External Work Item link deletion actor ID',
        )
    const record = await this.requireRecord(
      workspaceId,
      createExternalLinkRecordKey(linkId),
      'external-link',
      'ExternalWorkItemLinkNotFound',
      'External Work Item link was not found.',
    )
    const link = readRecordValue<ExternalWorkItemLink>(record, 'external-link')
    if (link.teamId !== teamId || link.workItemId !== workItemId) {
      throw notFound(
        'ExternalWorkItemLinkNotFound',
        'External Work Item link was not found.',
      )
    }
    if (link.syncStatus === 'conflict') {
      throw externalLinkDeletionConflict()
    }
    const now = this.clock().toISOString()
    const completion = request.idempotency
      ? await this.prepareIdempotencyCompletionRecord(
          workspaceId,
          request.idempotency,
          { status: 204, body: null },
        )
      : undefined
    const auditPut = this.createPlatformAuditPut({
      workspaceId,
      eventType: 'external-link.updated',
      entityType: 'external-link',
      entityId: link.id,
      transitionId: `deleted:${record.version}`,
      teamId,
      occurredAt: now,
      action: 'deleted',
      summary: 'External resource was unlinked from a Work Item.',
      actorId: deletedByActorId,
      metadata: {
        externalLinkId: link.id,
        workItemId,
        installationId: link.installationId,
        resourceType: link.resourceType,
        syncDirection: link.syncDirection,
        previousSyncStatus: link.syncStatus,
        lifecycle: 'deleted',
      },
    })
    const deleted = await this.deleteExternalLinkWithClaim(
      record,
      createExternalLinkClaimRecordKey(
        link.installationId,
        link.resourceType,
        link.externalId,
      ),
      createExternalLinkIndexRecordKeys(link),
      completion,
      auditPut,
    )
    if (deleted) return
    const current = await this.getRecord(workspaceId, record.recordKey)
    if (current?.entryType === 'external-link') {
      const currentLink = readRecordValue<ExternalWorkItemLink>(
        current,
        'external-link',
      )
      if (currentLink.syncStatus === 'conflict') {
        throw externalLinkDeletionConflict()
      }
    }
    throw persistenceConflict()
  }

  /** Import job を queued 状態で作成します。 */
  async createImportJob(request: CreateImportJobRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const createdByUserId = readIdentifier(request.createdByUserId, 'Creator user ID')
    const jobId = request.jobId === undefined
      ? createId('import')
      : readIdentifier(request.jobId, 'Import job ID')
    const format = readImportFormat(request.input.format)
    const teamId = readIdentifier(request.input.teamId, 'Import Team ID')
    const assignedProjectId = request.input.assignedProjectId === undefined
      ? undefined
      : readIdentifier(request.input.assignedProjectId, 'Import assigned Project ID')
    const mapping = readImportMapping(request.input.mapping)
    if (
      request.input.dryRun !== undefined &&
      typeof request.input.dryRun !== 'boolean'
    ) {
      throw invalid('ImportDryRunInvalid', 'Import dryRun must be a boolean.')
    }
    const now = this.clock().toISOString()
    const job: ImportJob = {
      id: jobId,
      format,
      teamId,
      ...(assignedProjectId ? { assignedProjectId } : {}),
      status: 'queued',
      mapping,
      dryRun: request.input.dryRun ?? false,
      createdByUserId,
      createdAt: now,
    }
    assertImportJobStorable(job)
    const record = createRecord(
      workspaceId,
      createImportJobRecordKey(job.id),
      'import-job',
      job,
    )
    if (!await this.putRecord(record, { ifAbsent: true })) {
      const existingRecord = await this.getRecord(workspaceId, record.recordKey)
      if (!existingRecord || existingRecord.entryType !== 'import-job') {
        throw persistenceConflict()
      }
      const existing = readRecordValue<ImportJob>(existingRecord, 'import-job')
      if (
        existing.id !== job.id ||
        existing.format !== job.format ||
        existing.teamId !== job.teamId ||
        existing.assignedProjectId !== job.assignedProjectId ||
        existing.dryRun !== job.dryRun ||
        existing.createdByUserId !== job.createdByUserId ||
        stableJson(existing.mapping) !== stableJson(job.mapping)
      ) {
        throw conflict(
          'ImportJobIdConflict',
          'Import job ID was already used for different import metadata.',
        )
      }
      return clone(existing)
    }
    return clone(job)
  }

  /** Workspace の Import job を作成日時降順で返します。 */
  async listImportJobs(workspaceIdValue: string) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const records = await this.listRecords(workspaceId, 'IMPORT#')
    return records
      .map((record) => clone(readRecordValue<ImportJob>(record, 'import-job')))
      .sort(compareCreatedAtDescending)
  }

  /** Import job state と report を保存します。 */
  async updateImportJob(request: UpdateImportJobRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const jobId = readIdentifier(request.jobId, 'Import job ID')
    const status = readImportJobStatus(request.status)
    const record = await this.requireRecord(
      workspaceId,
      createImportJobRecordKey(jobId),
      'import-job',
      'ImportJobNotFound',
      'Import job was not found.',
    )
    const current = readRecordValue<ImportJob>(record, 'import-job')
    assertImportTransition(current.status, status)
    if (current.status === status) return clone(current)
    const now = this.clock().toISOString()
    const report = request.report === undefined
      ? current.report
      : clone(request.report)
    const error = request.error === undefined
      ? current.error
      : cloneJsonValue(request.error) as ImportJob['error']
    if (status === 'completed' && !report) {
      throw invalid(
        'ImportReportRequired',
        'A completed import job requires a report.',
      )
    }
    if (status === 'failed' && !error) {
      throw invalid(
        'ImportErrorRequired',
        'A failed import job requires an error.',
      )
    }
    const job: ImportJob = {
      ...current,
      status,
      ...(current.startedAt
        ? {}
        : status === 'validating' || status === 'running'
          ? { startedAt: now }
          : {}),
      ...(status === 'completed' || status === 'failed' || status === 'cancelled'
        ? { completedAt: now }
        : {}),
      ...(report === undefined ? {} : { report }),
      ...(error === undefined ? {} : { error }),
    }
    assertImportJobStorable(job)
    const updatedRecord = {
      ...record,
      value: job,
      version: record.version + 1,
    }
    const auditPut = status === 'completed' || status === 'failed'
      ? this.createPlatformAuditPut({
          workspaceId,
          eventType: `import.${status}`,
          entityType: 'import-job',
          entityId: job.id,
          transitionId: status,
          teamId: job.teamId,
          ...(job.assignedProjectId ? { projectId: job.assignedProjectId } : {}),
          occurredAt: now,
          action: status,
          summary: status === 'completed'
            ? 'Work Item import completed.'
            : 'Work Item import failed.',
          metadata: {
            importJobId: job.id,
            format: job.format,
            dryRun: job.dryRun,
            status,
            ...(job.report
              ? {
                  totalRows: job.report.totalRows,
                  validRows: job.report.validRows,
                  invalidRows: job.report.invalidRows,
                }
              : {}),
          },
          actorId: job.createdByUserId,
        })
      : undefined
    const saved = await this.persistMutationRecord(
      workspaceId,
      updatedRecord,
      { expectedVersion: record.version },
      undefined,
      { status: 200, body: job },
      auditPut,
    )
    if (!saved) throw persistenceConflict()
    return clone(job)
  }

  /** Idempotency key を reserve、replay、または conflict 判定します。 */
  async reserveIdempotency(
    request: ReserveIdempotencyRequest,
  ): Promise<IdempotencyDecision> {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const credentialId = readIdentifier(request.credentialId, 'Credential ID')
    const idempotencyKey = readIdempotencyKey(request.idempotencyKey)
    const requestFingerprint = requireText(
      request.requestFingerprint,
      'Idempotency request fingerprint',
    )
    const ttlSeconds = readPositiveInteger(
      request.ttlSeconds ?? IDEMPOTENCY_DEFAULT_TTL_SECONDS,
      'Idempotency TTL seconds',
      7 * 24 * 60 * 60,
    )
    const keyDigest = digestText(
      `developer-idempotency-v1\0${workspaceId}\0${credentialId}\0${idempotencyKey}`,
    )
    const fingerprintDigest = digestText(
      `developer-request-v1\0${requestFingerprint}`,
    )
    const recordKey = `IDEMPOTENCY#${credentialId}#${keyDigest}`
    const now = this.clock()
    const existing = await this.getRecord(workspaceId, recordKey)
    if (existing && (existing.expiresAt ?? 0) > Math.floor(now.getTime() / 1_000)) {
      const value = readRecordValue<StoredIdempotencyValue>(existing, 'idempotency')
      if (value.requestFingerprintDigest !== fingerprintDigest) {
        throw conflict(
          'IdempotencyKeyConflict',
          'Idempotency key was already used for a different request.',
        )
      }
      if (value.state === 'completed') {
        if (!value.responseCiphertext) {
          throw persistenceInvalid('Completed idempotency response is missing.')
        }
        let response: unknown
        try {
          const plaintext = await this.secretProtector.unprotect(
            value.responseCiphertext,
            createIdempotencyResponseContext(workspaceId, credentialId, keyDigest),
          )
          response = cloneJsonValue(JSON.parse(plaintext))
        } catch {
          throw persistenceInvalid('Completed idempotency response is invalid.')
        }
        return { status: 'replay', response } satisfies IdempotencyDecision
      }
      const createdAt = Date.parse(value.createdAt)
      if (!Number.isFinite(createdAt)) {
        throw persistenceInvalid('Idempotency reservation timestamp is invalid.')
      }
      if (
        createdAt + IDEMPOTENCY_RESERVATION_LEASE_SECONDS * 1_000 >
          now.getTime()
      ) {
        return { status: 'in-progress' } satisfies IdempotencyDecision
      }
    }
    const reservationId = createSecret('mk_reservation')
    const value: StoredIdempotencyValue = {
      requestFingerprintDigest: fingerprintDigest,
      reservationDigest: digestSecret(reservationId),
      state: 'reserved',
      createdAt: now.toISOString(),
    }
    const record = {
      ...createRecord(
        workspaceId,
        recordKey,
        'idempotency',
        value,
        { expiresAt: Math.floor(now.getTime() / 1_000) + ttlSeconds },
      ),
      version: (existing?.version ?? 0) + 1,
    }
    if (!await this.putRecord(record, existing
      ? { expectedVersion: existing.version }
      : { ifAbsent: true })) {
      return this.reserveIdempotency(request)
    }
    return { status: 'reserved', reservationId } satisfies IdempotencyDecision
  }

  /** Reserve owner だけが response を保存できます。 */
  async completeIdempotency(request: CompleteIdempotencyRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const credentialId = readIdentifier(request.credentialId, 'Credential ID')
    const idempotencyKey = readIdempotencyKey(request.idempotencyKey)
    const keyDigest = digestText(
      `developer-idempotency-v1\0${workspaceId}\0${credentialId}\0${idempotencyKey}`,
    )
    const recordKey = `IDEMPOTENCY#${credentialId}#${keyDigest}`
    const record = await this.requireRecord(
      workspaceId,
      recordKey,
      'idempotency',
      'IdempotencyReservationNotFound',
      'Idempotency reservation was not found.',
    )
    if ((record.expiresAt ?? 0) <= Math.floor(this.clock().getTime() / 1_000)) {
      throw conflict(
        'IdempotencyReservationExpired',
        'Idempotency reservation has expired.',
      )
    }
    const value = readRecordValue<StoredIdempotencyValue>(record, 'idempotency')
    if (!secretDigestsEqual(value.reservationDigest, digestSecret(request.reservationId))) {
      throw forbidden(
        'IdempotencyReservationOwnerMismatch',
        'Idempotency reservation belongs to another request.',
      )
    }
    const expectedFingerprint = digestText(
      `developer-request-v1\0${requireText(
        request.requestFingerprint,
        'Idempotency request fingerprint',
      )}`,
    )
    if (value.requestFingerprintDigest !== expectedFingerprint) {
      throw conflict(
        'IdempotencyKeyConflict',
        'Idempotency key was already used for a different request.',
      )
    }
    if (value.state === 'completed') return
    const response = cloneJsonValue(request.response)
    const serializedResponse = JSON.stringify(response)
    if (
      Buffer.byteLength(serializedResponse, 'utf8') >
        IDEMPOTENCY_MAX_RESPONSE_BYTES
    ) {
      throw new DeveloperPlatformError(
        413,
        'IdempotencyResponseTooLarge',
        'Idempotency response exceeds the safe persistence limit.',
      )
    }
    const responseCiphertext = await this.secretProtector.protect(
      serializedResponse,
      createIdempotencyResponseContext(workspaceId, credentialId, keyDigest),
    )
    const completedRecord: DeveloperPlatformRecord = {
      ...record,
      value: {
        ...value,
        state: 'completed',
        responseCiphertext,
      } satisfies StoredIdempotencyValue,
      version: record.version + 1,
    }
    if (estimateStoredRecordBytes(completedRecord) > 380 * 1024) {
      throw new DeveloperPlatformError(
        413,
        'IdempotencyResponseTooLarge',
        'Encrypted idempotency response exceeds the safe persistence limit.',
      )
    }
    const saved = await this.putRecord(completedRecord, { expectedVersion: record.version })
    if (!saved) throw persistenceConflict()
  }

  /** 失敗した処理の Reserve owner だけが未完了 reservation を解放できます。 */
  async releaseIdempotency(request: ReleaseIdempotencyRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const credentialId = readIdentifier(request.credentialId, 'Credential ID')
    const idempotencyKey = readIdempotencyKey(request.idempotencyKey)
    const keyDigest = digestText(
      `developer-idempotency-v1\0${workspaceId}\0${credentialId}\0${idempotencyKey}`,
    )
    const recordKey = `IDEMPOTENCY#${credentialId}#${keyDigest}`
    const record = await this.getRecord(workspaceId, recordKey)
    if (!record) return
    if (record.entryType !== 'idempotency') {
      throw persistenceInvalid('Idempotency reservation row is invalid.')
    }
    const value = readRecordValue<StoredIdempotencyValue>(record, 'idempotency')
    if (value.state === 'completed') return
    if (!secretDigestsEqual(value.reservationDigest, digestSecret(request.reservationId))) {
      throw forbidden(
        'IdempotencyReservationOwnerMismatch',
        'Idempotency reservation belongs to another request.',
      )
    }
    const expectedFingerprint = digestText(
      `developer-request-v1\0${requireText(
        request.requestFingerprint,
        'Idempotency request fingerprint',
      )}`,
    )
    if (value.requestFingerprintDigest !== expectedFingerprint) {
      throw conflict(
        'IdempotencyKeyConflict',
        'Idempotency key was already used for a different request.',
      )
    }
    if (!await this.deleteRecord(workspaceId, recordKey, record.version)) {
      throw persistenceConflict()
    }
  }

  /** Credential ごとの fixed-window rate limit を原子的に消費します。 */
  async consumeRateLimit(request: ConsumeRateLimitRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const credentialId = readIdentifier(request.credentialId, 'Credential ID')
    const limit = readPositiveInteger(request.limit, 'Rate limit')
    const windowSeconds = readPositiveInteger(
      request.windowSeconds,
      'Rate limit window seconds',
      24 * 60 * 60,
    )
    const cost = readPositiveInteger(request.cost ?? 1, 'Rate limit cost', limit)
    const nowEpoch = Math.floor(this.clock().getTime() / 1_000)
    const windowStart = Math.floor(nowEpoch / windowSeconds) * windowSeconds
    const resetEpoch = windowStart + windowSeconds
    const result = await this.consumeRateLimitRecord({
      workspaceId,
      recordKey: `RATELIMIT#${credentialId}#${windowStart}`,
      limit,
      cost,
      resetAt: new Date(resetEpoch * 1_000).toISOString(),
      expiresAt: resetEpoch + windowSeconds,
    })
    return {
      allowed: result.allowed,
      limit,
      remaining: Math.max(0, limit - result.consumed),
      resetAt: new Date(resetEpoch * 1_000).toISOString(),
      ...(!result.allowed
        ? { retryAfterSeconds: Math.max(1, resetEpoch - nowEpoch) }
        : {}),
    } satisfies RateLimitDecision
  }

  /** OAuth app secret digest を消去し、配下 access token を無効化します。 */
  private async persistInactiveOAuthApp(
    record: DeveloperPlatformRecord,
    oauthApp: OAuthAppSummary,
  ) {
    const authRecord = await this.getCredentialAuthRecord(
      createOAuthClientAuthWorkspaceId(oauthApp.clientId),
      'oauth-client',
      record,
    )
    const saved = await this.putCredentialRecord(withoutStoredCredential({
      ...record,
      value: oauthApp,
      version: record.version + 1,
    }, false), { expectedVersion: record.version }, undefined,
    authRecord ? createCredentialAuthDelete(authRecord) : undefined)
    if (!saved) throw persistenceConflict()
    const tokens = await this.listRecords(record.workspaceId, 'OAUTHTOKEN#')
    await Promise.all(tokens.map(async (tokenRecord) => {
      const token = readRecordValue<StoredOAuthTokenValue>(tokenRecord, 'oauth-token')
      if (token.oauthAppId === oauthApp.id) {
        const tokenAuthRecord = tokenRecord.secretDigest
          ? await this.getCredentialAuthRecord(
              createOAuthTokenAuthWorkspaceId(tokenRecord.secretDigest),
              'oauth-token',
              tokenRecord,
            )
          : undefined
        if (!await this.deleteCredentialRecord(tokenRecord, tokenAuthRecord)) {
          throw persistenceConflict()
        }
      }
    }))
  }

  /** Auth primary row を強整合取得し、期待 locator との対応を検証します。 */
  private async getCredentialAuthRecord(
    authWorkspaceId: string,
    expectedKind: StoredCredentialAuthValue['kind'],
    expectedTarget?: DeveloperPlatformRecord,
  ) {
    const authRecord = await this.getRecord(
      authWorkspaceId,
      CREDENTIAL_AUTH_RECORD_KEY,
    )
    if (!authRecord) return undefined
    if (authRecord.entryType !== 'credential-auth') {
      throw persistenceInvalid('Credential auth row has an invalid entry type.')
    }
    const auth = readRecordValue<StoredCredentialAuthValue>(
      authRecord,
      'credential-auth',
    )
    if (
      auth.kind !== expectedKind ||
      typeof auth.targetWorkspaceId !== 'string' ||
      typeof auth.targetRecordKey !== 'string' ||
      !authRecord.secretDigest ||
      !isOptionalSha256Digest(authRecord.secretDigest) ||
      (
        expectedTarget &&
        (
          auth.targetWorkspaceId !== expectedTarget.workspaceId ||
          auth.targetRecordKey !== expectedTarget.recordKey
        )
      )
    ) {
      throw persistenceInvalid('Credential auth row has an invalid target.')
    }
    return authRecord
  }

  /** Auth primary row から credential domain row を強整合解決します。 */
  private async resolveCredentialRecord(
    authWorkspaceId: string,
    expectedKind: StoredCredentialAuthValue['kind'],
    expectedEntryType: 'api-key' | 'oauth-app' | 'oauth-token',
  ) {
    const authRecord = await this.getCredentialAuthRecord(
      authWorkspaceId,
      expectedKind,
    )
    if (!authRecord) return undefined
    const auth = readRecordValue<StoredCredentialAuthValue>(
      authRecord,
      'credential-auth',
    )
    const record = await this.getRecord(auth.targetWorkspaceId, auth.targetRecordKey)
    if (!record || record.entryType !== expectedEntryType) return undefined
    return { authRecord, record }
  }

  /** Lookup index を locator のみに使い、base table の強整合 row を再検証します。 */
  private async getAuthoritativeRecordByLookupKey(lookupKey: string) {
    const locator = await this.getRecordByLookupKey(lookupKey)
    if (!locator) return undefined
    const record = await this.getRecord(locator.workspaceId, locator.recordKey)
    return record?.lookupKey === lookupKey &&
        record.lookupSortKey === locator.lookupSortKey
      ? record
      : undefined
  }

  /** Delivery ID GSI locator から tenant-bound row を強整合再取得します。 */
  private async getWebhookDeliveryRecordById(workspaceId: string, deliveryId: string) {
    const lookupKey = createWebhookDeliveryIdLookupKey(workspaceId, deliveryId)
    const record = await this.getAuthoritativeRecordByLookupKey(lookupKey)
    if (!record || isRecordExpired(record, this.clock())) return undefined
    if (
      record.workspaceId !== workspaceId ||
      record.recordKey !== createWebhookDeliveryRecordKey(deliveryId) ||
      record.entryType !== 'webhook-delivery' ||
      record.lookupSortKey !== record.recordKey
    ) {
      throw persistenceInvalid('Webhook delivery ID locator is invalid.')
    }
    const stored = readRecordValue<StoredWebhookDeliveryValue>(record, 'webhook-delivery')
    if (stored.delivery.id !== deliveryId) {
      throw persistenceInvalid('Webhook delivery ID does not match its locator.')
    }
    return record
  }

  /** Delivery ID GSI locator から tenant-bound row を必須取得します。 */
  private async requireWebhookDeliveryRecordById(
    workspaceId: string,
    deliveryId: string,
  ) {
    const record = await this.getWebhookDeliveryRecordById(workspaceId, deliveryId)
    if (!record) {
      throw notFound(
        'WebhookDeliveryNotFound',
        'Webhook delivery was not found.',
      )
    }
    return record
  }

  /** GSI locator と delivery 本体を強整合再取得して immutable index を検証します。 */
  private async resolveWebhookDeliveryIndexLocator(
    locator: DeveloperPlatformRecordLocator,
    expectedKind: StoredWebhookDeliveryIndexValue['kind'],
  ) {
    const indexRecord = await this.getRecord(locator.workspaceId, locator.recordKey)
    if (!indexRecord || isRecordExpired(indexRecord, this.clock())) return undefined
    if (
      indexRecord.entryType !== 'webhook-delivery-index' ||
      indexRecord.lookupKey !== locator.lookupKey ||
      indexRecord.lookupSortKey !== locator.lookupSortKey
    ) {
      throw persistenceInvalid('Webhook delivery index locator is stale or invalid.')
    }
    const index = readRecordValue<StoredWebhookDeliveryIndexValue>(
      indexRecord,
      'webhook-delivery-index',
    )
    if (index.kind !== expectedKind) {
      throw persistenceInvalid('Webhook delivery index kind is invalid.')
    }
    const deliveryRecord = await this.getRecord(locator.workspaceId, index.targetRecordKey)
    if (!deliveryRecord || isRecordExpired(deliveryRecord, this.clock())) return undefined
    if (deliveryRecord.entryType !== 'webhook-delivery') {
      throw persistenceInvalid('Webhook delivery index target is invalid.')
    }
    const delivery = readRecordValue<StoredWebhookDeliveryValue>(
      deliveryRecord,
      'webhook-delivery',
    ).delivery
    const expectedLookupKey = expectedKind === 'workspace-list'
      ? createWebhookDeliveryWorkspaceLookupKey(locator.workspaceId)
      : expectedKind === 'subscription-list'
        ? createWebhookDeliverySubscriptionLookupKey(
            locator.workspaceId,
            delivery.subscriptionId,
          )
        : createWebhookDeliveryReplayLookupKey(
            locator.workspaceId,
            delivery.replayOfDeliveryId ?? delivery.id,
          )
    const expectedLookupSortKey = expectedKind === 'replay-chain'
      ? createWebhookDeliveryReplaySortKey(delivery)
      : createWebhookDeliveryOrderSortKey(delivery)
    if (
      locator.lookupKey !== expectedLookupKey ||
      locator.lookupSortKey !== expectedLookupSortKey ||
      index.targetRecordKey !== createWebhookDeliveryRecordKey(delivery.id) ||
      deliveryRecord.lookupKey !== createWebhookDeliveryIdLookupKey(
        locator.workspaceId,
        delivery.id,
      )
    ) {
      throw persistenceInvalid('Webhook delivery index invariant is invalid.')
    }
    return clone(delivery)
  }

  /** Primary key の型付き row を必須取得します。 */
  private async requireRecord(
    workspaceId: string,
    recordKey: string,
    entryType: DeveloperPlatformEntryType,
    code: string,
    message: string,
  ) {
    const record = await this.getRecord(workspaceId, recordKey)
    if (!record || record.entryType !== entryType) throw notFound(code, message)
    return record
  }

  /** Webhook cursor を復号し、tenant/filter binding を検証します。 */
  private async decodeWebhookCursor(
    encoded: string,
    workspaceId: string,
    subscriptionId: string | undefined,
  ) {
    try {
      const plaintext = await this.secretProtector.unprotect(
        requireText(encoded, 'Webhook delivery cursor'),
        WEBHOOK_CURSOR_CONTEXT,
      )
      const cursor = JSON.parse(plaintext) as Partial<WebhookDeliveryCursor>
      const expectedLookupKey = subscriptionId
        ? createWebhookDeliverySubscriptionLookupKey(workspaceId, subscriptionId)
        : createWebhookDeliveryWorkspaceLookupKey(workspaceId)
      if (
        cursor.version !== 2 ||
        cursor.workspaceId !== workspaceId ||
        cursor.subscriptionId !== subscriptionId ||
        cursor.lookupKey !== expectedLookupKey ||
        typeof cursor.lookupSortKey !== 'string' ||
        typeof cursor.recordKey !== 'string' ||
        cursor.recordKey !== createWebhookDeliveryIndexRecordKey(
          expectedLookupKey,
          cursor.lookupSortKey,
        )
      ) {
        throw invalid('WebhookCursorInvalid', 'Webhook delivery cursor is invalid.')
      }
      return cursor as WebhookDeliveryCursor
    } catch (error) {
      if (error instanceof DeveloperPlatformError && error.code === 'WebhookCursorInvalid') {
        throw error
      }
      throw invalid('WebhookCursorInvalid', 'Webhook delivery cursor is invalid.', error)
    }
  }
}

/** Local/test 向けの in-memory developer platform client です。 */
export class InMemoryDeveloperPlatformClient extends BaseDeveloperPlatformClient {
  /** Workspace と recordKey で分離した永続化 row です。 */
  private readonly records = new Map<string, DeveloperPlatformRecord>()
  /** Test が再現する Active Webhook locator migration 状態です。 */
  private readonly webhookActiveLocatorMigrationState:
    WebhookActiveLocatorMigrationState

  constructor(
    secretProtector: SecretProtector = new LocalAesGcmSecretProtector(),
    clock: () => Date = () => new Date(),
    webhookActiveLocatorMigrationState:
      WebhookActiveLocatorMigrationState = 'complete',
  ) {
    super(secretProtector, clock)
    this.webhookActiveLocatorMigrationState =
      webhookActiveLocatorMigrationState
  }

  /** Primary key で row を取得します。 */
  protected async getRecord(workspaceId: string, recordKey: string) {
    const record = this.records.get(createMemoryKey(workspaceId, recordKey))
    return record ? clone(record) : undefined
  }

  /** Workspace partition の prefix rows を取得します。 */
  protected async listRecords(workspaceId: string, recordKeyPrefix: string) {
    return [...this.records.values()]
      .filter((record) =>
        record.workspaceId === workspaceId && record.recordKey.startsWith(recordKeyPrefix)
      )
      .sort((left, right) => left.recordKey.localeCompare(right.recordKey))
      .map((record) => clone(record))
  }

  /** Memory partition の prefix rows をbounded page取得します。 */
  protected async listRecordsPage(
    workspaceId: string,
    recordKeyPrefix: string,
    limit: number,
    exclusiveStartRecordKey?: string,
  ) {
    const records = [...this.records.values()]
      .filter((record) =>
        record.workspaceId === workspaceId &&
        record.recordKey.startsWith(recordKeyPrefix) &&
        (
          exclusiveStartRecordKey === undefined ||
          record.recordKey > exclusiveStartRecordKey
        )
      )
      .sort((left, right) => left.recordKey.localeCompare(right.recordKey))
    const selected = records.slice(0, limit)
    return {
      records: selected.map((record) => clone(record)),
      ...(records.length > selected.length && selected.length > 0
        ? { nextRecordKey: selected.at(-1)!.recordKey }
        : {}),
    } satisfies ListRecordsPageResult
  }

  /** lookupKey GSI 相当から一意な row を取得します。 */
  protected async getRecordByLookupKey(lookupKey: string) {
    const records = [...this.records.values()].filter((record) =>
      record.lookupKey === lookupKey
    )
    if (records.length > 1) throw persistenceInvalid('Developer lookup is not unique.')
    return records[0]
      ? readStoredRecordLocator(clone(records[0]) as unknown as Record<string, unknown>, lookupKey)
      : undefined
  }

  /** LookupKeyIndex 相当を件数上限付きで query します。 */
  protected async queryLookupIndex(request: QueryLookupIndexRequest) {
    const ordered = [...this.records.values()]
      .filter((record) =>
        record.lookupKey === request.lookupKey &&
        typeof record.lookupSortKey === 'string'
      )
      .sort((left, right) => {
        const comparison = left.lookupSortKey!.localeCompare(right.lookupSortKey!)
        return request.scanIndexForward ? comparison : -comparison
      })
    const remaining = request.exclusiveStartKey
      ? ordered.filter((record) => {
          const comparison = record.lookupSortKey!.localeCompare(
            request.exclusiveStartKey!.lookupSortKey,
          )
          return request.scanIndexForward ? comparison > 0 : comparison < 0
        })
      : ordered
    const selected = remaining.slice(0, request.limit)
    const locators = selected.map((record) =>
      readStoredRecordLocator(
        clone(record) as unknown as Record<string, unknown>,
        request.lookupKey,
      )
    )
    return {
      locators,
      ...(remaining.length > selected.length && locators.length > 0
        ? { lastEvaluatedKey: locators.at(-1)! }
        : {}),
    } satisfies QueryLookupIndexResult
  }

  /** Test に設定された Active Webhook locator migration 状態を返します。 */
  protected async readWebhookActiveLocatorMigrationState() {
    return this.webhookActiveLocatorMigrationState
  }

  /** Row を作成または条件付き置換します。 */
  protected async putRecord(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition = {},
  ) {
    const key = createMemoryKey(record.workspaceId, record.recordKey)
    const current = this.records.get(key)
    if (condition.ifAbsent && current) return false
    if (
      condition.expectedVersion !== undefined &&
      current?.version !== condition.expectedVersion
    ) {
      return false
    }
    this.records.set(key, clone(record))
    return true
  }

  /** Domain row と encrypted response receipt を同じ memory commit にします。 */
  protected async putRecordWithIdempotency(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    completion: PreparedIdempotencyCompletionRecord,
    _auditPut?: AuditTransactWriteItem,
  ) {
    const recordKey = createMemoryKey(record.workspaceId, record.recordKey)
    const currentRecord = this.records.get(recordKey)
    if (condition.ifAbsent && currentRecord) return false
    if (
      condition.expectedVersion !== undefined &&
      currentRecord?.version !== condition.expectedVersion
    ) return false

    const idempotencyKey = createMemoryKey(
      completion.reservedRecord.workspaceId,
      completion.reservedRecord.recordKey,
    )
    const currentIdempotency = this.records.get(idempotencyKey)
    if (
      !currentIdempotency ||
      currentIdempotency.version !== completion.reservedRecord.version ||
      currentIdempotency.entryType !== 'idempotency'
    ) return false
    const currentValue = readRecordValue<StoredIdempotencyValue>(
      currentIdempotency,
      'idempotency',
    )
    if (
      currentValue.state !== 'reserved' ||
      !secretDigestsEqual(
        currentValue.reservationDigest,
        completion.reservationDigest,
      ) ||
      currentValue.requestFingerprintDigest !== completion.requestFingerprintDigest
    ) return false

    this.records.set(recordKey, clone(record))
    this.records.set(idempotencyKey, clone(completion.completedRecord))
    return true
  }

  /** Memory commit では domain row と audit emission を同じ critical section とみなします。 */
  protected async putRecordWithAudit(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    _auditPut: AuditTransactWriteItem,
  ) {
    return this.putRecord(record, condition)
  }

  /** Credential domain/auth rows と receipt を同じ memory commit にします。 */
  protected async putCredentialRecord(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    authWrite?: CredentialAuthRecordWrite,
    authDelete?: CredentialAuthRecordDelete,
    completion?: PreparedIdempotencyCompletionRecord,
  ) {
    const recordKey = createMemoryKey(record.workspaceId, record.recordKey)
    const currentRecord = this.records.get(recordKey)
    if (condition.ifAbsent && currentRecord) return false
    if (
      condition.expectedVersion !== undefined &&
      currentRecord?.version !== condition.expectedVersion
    ) return false

    const authWriteKey = authWrite
      ? createMemoryKey(authWrite.record.workspaceId, authWrite.record.recordKey)
      : undefined
    const currentAuthWrite = authWriteKey
      ? this.records.get(authWriteKey)
      : undefined
    if (authWrite?.condition.ifAbsent && currentAuthWrite) return false
    if (
      authWrite?.condition.expectedVersion !== undefined &&
      currentAuthWrite?.version !== authWrite.condition.expectedVersion
    ) return false

    const authDeleteKey = authDelete
      ? createMemoryKey(authDelete.workspaceId, authDelete.recordKey)
      : undefined
    const currentAuthDelete = authDeleteKey
      ? this.records.get(authDeleteKey)
      : undefined
    if (
      authDelete &&
      currentAuthDelete &&
      (
        currentAuthDelete.entryType !== 'credential-auth' ||
        currentAuthDelete.version !== authDelete.expectedVersion
      )
    ) return false

    let idempotencyKey: string | undefined
    if (completion) {
      idempotencyKey = createMemoryKey(
        completion.reservedRecord.workspaceId,
        completion.reservedRecord.recordKey,
      )
      const currentIdempotency = this.records.get(idempotencyKey)
      if (
        !currentIdempotency ||
        currentIdempotency.version !== completion.reservedRecord.version ||
        currentIdempotency.entryType !== 'idempotency'
      ) return false
      const currentValue = readRecordValue<StoredIdempotencyValue>(
        currentIdempotency,
        'idempotency',
      )
      if (
        currentValue.state !== 'reserved' ||
        !secretDigestsEqual(
          currentValue.reservationDigest,
          completion.reservationDigest,
        ) ||
        currentValue.requestFingerprintDigest !==
          completion.requestFingerprintDigest
      ) return false
    }

    this.records.set(recordKey, clone(record))
    if (authWriteKey && authWrite) {
      this.records.set(authWriteKey, clone(authWrite.record))
    }
    if (authDeleteKey) this.records.delete(authDeleteKey)
    if (completion && idempotencyKey) {
      this.records.set(idempotencyKey, clone(completion.completedRecord))
    }
    return true
  }

  /** OAuth app 利用記録、token domain/auth rows を同じ memory commit にします。 */
  protected async createOAuthTokenRecords(
    appRecord: DeveloperPlatformRecord,
    expectedAppVersion: number,
    tokenRecord: DeveloperPlatformRecord,
    authRecord: DeveloperPlatformRecord,
  ) {
    const appKey = createMemoryKey(appRecord.workspaceId, appRecord.recordKey)
    const tokenKey = createMemoryKey(tokenRecord.workspaceId, tokenRecord.recordKey)
    const authKey = createMemoryKey(authRecord.workspaceId, authRecord.recordKey)
    if (
      this.records.get(appKey)?.version !== expectedAppVersion ||
      this.records.has(tokenKey) ||
      this.records.has(authKey)
    ) return false
    this.records.set(appKey, clone(appRecord))
    this.records.set(tokenKey, clone(tokenRecord))
    this.records.set(authKey, clone(authRecord))
    return true
  }

  /** Credential domain row と auth row を同じ memory commit で削除します。 */
  protected async deleteCredentialRecord(
    record: DeveloperPlatformRecord,
    authRecord?: DeveloperPlatformRecord,
  ) {
    const recordKey = createMemoryKey(record.workspaceId, record.recordKey)
    const currentRecord = this.records.get(recordKey)
    if (currentRecord && currentRecord.entryType !== record.entryType) return false
    const authKey = authRecord
      ? createMemoryKey(authRecord.workspaceId, authRecord.recordKey)
      : undefined
    if (authKey) {
      const currentAuth = this.records.get(authKey)
      if (
        currentAuth &&
        (
          currentAuth.entryType !== 'credential-auth' ||
          currentAuth.version !== authRecord?.version
        )
      ) return false
    }
    this.records.delete(recordKey)
    if (authKey) this.records.delete(authKey)
    return true
  }

  /** Primary key の row を削除します。 */
  protected async deleteRecord(
    workspaceId: string,
    recordKey: string,
    expectedVersion?: number,
  ) {
    const key = createMemoryKey(workspaceId, recordKey)
    const current = this.records.get(key)
    if (!current) return true
    if (expectedVersion !== undefined && current.version !== expectedVersion) return false
    this.records.delete(key)
    return true
  }

  /** Webhook subscription と quota counter、optional receipt を同じ memory commit にします。 */
  protected async createWebhookSubscriptionRecord(
    record: DeveloperPlatformRecord,
    completion?: PreparedIdempotencyCompletionRecord,
  ): Promise<'created' | 'quota-exceeded' | 'conflict'> {
    const recordKey = createMemoryKey(record.workspaceId, record.recordKey)
    if (this.records.has(recordKey)) return 'conflict'
    const quotaKey = createMemoryKey(
      record.workspaceId,
      createWebhookSubscriptionQuotaRecordKey(),
    )
    const quotaRecord = this.records.get(quotaKey)
    if (quotaRecord && quotaRecord.entryType !== 'webhook-subscription-quota') {
      return 'conflict'
    }
    const subscriptionCount = quotaRecord?.subscriptionCount ?? 0
    if (subscriptionCount >= WEBHOOK_SUBSCRIPTION_LIMIT) return 'quota-exceeded'

    let completionKey: string | undefined
    if (completion) {
      completionKey = createMemoryKey(
        completion.reservedRecord.workspaceId,
        completion.reservedRecord.recordKey,
      )
      const current = this.records.get(completionKey)
      if (
        !current ||
        current.version !== completion.reservedRecord.version ||
        current.entryType !== 'idempotency'
      ) return 'conflict'
      const value = readRecordValue<StoredIdempotencyValue>(current, 'idempotency')
      if (
        value.state !== 'reserved' ||
        !secretDigestsEqual(value.reservationDigest, completion.reservationDigest) ||
        value.requestFingerprintDigest !== completion.requestFingerprintDigest
      ) return 'conflict'
    }

    this.records.set(quotaKey, {
      workspaceId: record.workspaceId,
      recordKey: createWebhookSubscriptionQuotaRecordKey(),
      entryType: 'webhook-subscription-quota',
      value: { limit: WEBHOOK_SUBSCRIPTION_LIMIT } satisfies
        StoredWebhookSubscriptionQuotaValue,
      subscriptionCount: subscriptionCount + 1,
      version: (quotaRecord?.version ?? 0) + 1,
    })
    this.records.set(recordKey, clone(record))
    const subscription = readRecordValue<WebhookSubscription>(
      record,
      'webhook-subscription',
    )
    const activeLocator = createActiveWebhookSubscriptionRecord(
      record.workspaceId,
      subscription,
    )
    this.records.set(
      createMemoryKey(activeLocator.workspaceId, activeLocator.recordKey),
      activeLocator,
    )
    if (completion && completionKey) {
      this.records.set(completionKey, clone(completion.completedRecord))
    }
    return 'created'
  }

  /** Subscription と active locator、optional receipt を同じ memory commit にします。 */
  protected async putWebhookSubscriptionRecord(
    record: DeveloperPlatformRecord,
    expectedVersion: number,
    completion?: PreparedIdempotencyCompletionRecord,
  ) {
    const recordKey = createMemoryKey(record.workspaceId, record.recordKey)
    const current = this.records.get(recordKey)
    if (
      current?.entryType !== 'webhook-subscription' ||
      current.version !== expectedVersion
    ) return false
    let completionKey: string | undefined
    if (completion) {
      completionKey = createMemoryKey(
        completion.reservedRecord.workspaceId,
        completion.reservedRecord.recordKey,
      )
      if (!isCurrentIdempotencyReservation(this.records.get(completionKey), completion)) {
        return false
      }
    }
    const subscription = readRecordValue<WebhookSubscription>(
      record,
      'webhook-subscription',
    )
    const locator = createActiveWebhookSubscriptionRecord(
      record.workspaceId,
      subscription,
    )
    const locatorKey = createMemoryKey(locator.workspaceId, locator.recordKey)
    this.records.set(recordKey, clone(record))
    if (subscription.status === 'active') {
      this.records.set(locatorKey, locator)
    } else {
      this.records.delete(locatorKey)
    }
    if (completion && completionKey) {
      this.records.set(completionKey, clone(completion.completedRecord))
    }
    return true
  }

  /** Webhook subscription の無効化と quota 解放を同じ memory commit にします。 */
  protected async disableWebhookSubscriptionRecord(
    record: DeveloperPlatformRecord,
    expectedVersion: number,
    completion?: PreparedIdempotencyCompletionRecord,
  ) {
    const recordKey = createMemoryKey(record.workspaceId, record.recordKey)
    const currentRecord = this.records.get(recordKey)
    const quotaKey = createMemoryKey(
      record.workspaceId,
      createWebhookSubscriptionQuotaRecordKey(),
    )
    const quotaRecord = this.records.get(quotaKey)
    if (
      currentRecord?.entryType !== 'webhook-subscription' ||
      currentRecord.version !== expectedVersion ||
      quotaRecord?.entryType !== 'webhook-subscription-quota' ||
      readRecordValue<StoredWebhookSubscriptionQuotaValue>(
        quotaRecord,
        'webhook-subscription-quota',
      ).limit !== WEBHOOK_SUBSCRIPTION_LIMIT ||
      (quotaRecord.subscriptionCount ?? 0) < 1
    ) return false

    let completionKey: string | undefined
    if (completion) {
      completionKey = createMemoryKey(
        completion.reservedRecord.workspaceId,
        completion.reservedRecord.recordKey,
      )
      const current = this.records.get(completionKey)
      if (
        !current ||
        current.version !== completion.reservedRecord.version ||
        current.entryType !== 'idempotency'
      ) return false
      const value = readRecordValue<StoredIdempotencyValue>(current, 'idempotency')
      if (
        value.state !== 'reserved' ||
        !secretDigestsEqual(value.reservationDigest, completion.reservationDigest) ||
        value.requestFingerprintDigest !== completion.requestFingerprintDigest
      ) return false
    }

    this.records.set(recordKey, clone(record))
    const subscription = readRecordValue<WebhookSubscription>(
      record,
      'webhook-subscription',
    )
    this.records.delete(createMemoryKey(
      record.workspaceId,
      createActiveWebhookSubscriptionRecordKey(subscription),
    ))
    this.records.set(quotaKey, {
      ...quotaRecord,
      subscriptionCount: (quotaRecord.subscriptionCount ?? 0) - 1,
      version: quotaRecord.version + 1,
    })
    if (completion && completionKey) {
      this.records.set(completionKey, clone(completion.completedRecord))
    }
    return true
  }

  /** Delivery attempt と subscription health を同じ memory commit にします。 */
  protected async putWebhookDeliveryAttempt(
    deliveryRecord: DeveloperPlatformRecord,
    expectedDeliveryVersion: number,
    subscriptionRecordKey: string,
    delivered: boolean,
    attemptedAt: string,
  ) {
    const deliveryKey = createMemoryKey(
      deliveryRecord.workspaceId,
      deliveryRecord.recordKey,
    )
    const subscriptionKey = createMemoryKey(
      deliveryRecord.workspaceId,
      subscriptionRecordKey,
    )
    const currentSubscriptionRecord = this.records.get(subscriptionKey)
    if (
      this.records.get(deliveryKey)?.version !== expectedDeliveryVersion ||
      currentSubscriptionRecord?.entryType !== 'webhook-subscription'
    ) return false
    const currentSubscription = readRecordValue<WebhookSubscription>(
      currentSubscriptionRecord,
      'webhook-subscription',
    )
    this.records.set(deliveryKey, clone(deliveryRecord))
    this.records.set(subscriptionKey, {
      ...currentSubscriptionRecord,
      value: {
        ...currentSubscription,
        lastDeliveryAt: attemptedAt,
        failureCount: delivered ? 0 : currentSubscription.failureCount + 1,
        updatedAt: attemptedAt,
      },
      version: currentSubscriptionRecord.version + 1,
    })
    return true
  }

  /** Delivery 本体と immutable index locator を原子的に新規保存します。 */
  protected async createWebhookDeliveryRecords(
    records: readonly DeveloperPlatformRecord[],
  ) {
    if (records.some((record) =>
      this.records.has(createMemoryKey(record.workspaceId, record.recordKey))
    )) {
      return false
    }
    for (const record of records) {
      this.records.set(createMemoryKey(record.workspaceId, record.recordKey), clone(record))
    }
    return true
  }

  /** External link と tenant-scoped uniqueness claim を原子的に保存します。 */
  protected async saveExternalLinkWithClaim(
    linkRecord: DeveloperPlatformRecord,
    claimRecord: DeveloperPlatformRecord,
    indexRecords: readonly DeveloperPlatformRecord[],
    installationRecord: DeveloperPlatformRecord,
    _auditPut?: AuditTransactWriteItem,
  ) {
    const link = readRecordValue<ExternalWorkItemLink>(
      linkRecord,
      'external-link',
    )
    const fenceKey = createMemoryKey(
      linkRecord.workspaceId,
      createWorkItemLinkFenceRecordKey(link.teamId, link.workItemId),
    )
    const currentFence = this.records.get(fenceKey)
    const currentFenceValue = currentFence?.entryType === 'work-item-link-fence'
      ? readRecordValue<StoredWorkItemLinkFenceValue>(
          currentFence,
          'work-item-link-fence',
        )
      : undefined
    if (currentFenceValue?.deletedAt) return 'work-item-deleted' as const
    if (
      currentFenceValue &&
      (
        currentFenceValue.teamId !== link.teamId ||
        currentFenceValue.workItemId !== link.workItemId
      )
    ) return 'conflict' as const
    const claimKey = createMemoryKey(claimRecord.workspaceId, claimRecord.recordKey)
    const existingClaim = this.records.get(claimKey)
    if (existingClaim) {
      return this.compareExternalLinkClaim(linkRecord, existingClaim)
    }
    const currentInstallation = this.records.get(createMemoryKey(
      installationRecord.workspaceId,
      installationRecord.recordKey,
    ))
    const currentInstallationValue = currentInstallation?.entryType ===
        'connector-installation'
      ? readRecordValue<ConnectorInstallation>(
          currentInstallation,
          'connector-installation',
        )
      : undefined
    if (
      currentInstallation?.entryType !== 'connector-installation' ||
      currentInstallationValue?.status !== 'connected'
    ) {
      return 'installation-changed' as const
    }
    const externalLinkCount = currentInstallation?.externalLinkCount
    if (!Number.isSafeInteger(externalLinkCount) || Number(externalLinkCount) < 0) {
      throw persistenceInvalid('Connector installation external-link count is invalid.')
    }
    if (Number(externalLinkCount) >= EXTERNAL_LINK_INSTALLATION_LIMIT) {
      return 'installation-limit-exceeded' as const
    }
    const linkKey = createMemoryKey(linkRecord.workspaceId, linkRecord.recordKey)
    if (
      this.records.has(linkKey) ||
      indexRecords.some((indexRecord) =>
        this.records.has(createMemoryKey(indexRecord.workspaceId, indexRecord.recordKey))
      )
    ) return 'conflict' as const
    const activeLinkCount = readWorkItemLinkFenceCount(currentFence)
    if (activeLinkCount >= EXTERNAL_LINK_WORK_ITEM_LIMIT) {
      return 'work-item-limit-exceeded' as const
    }
    this.records.set(fenceKey, {
      workspaceId: linkRecord.workspaceId,
      recordKey: createWorkItemLinkFenceRecordKey(link.teamId, link.workItemId),
      entryType: 'work-item-link-fence',
      value: {
        teamId: link.teamId,
        workItemId: link.workItemId,
      } satisfies StoredWorkItemLinkFenceValue,
      activeLinkCount: activeLinkCount + 1,
      version: (currentFence?.version ?? 0) + 1,
    })
    this.records.set(claimKey, clone(claimRecord))
    this.records.set(linkKey, clone(linkRecord))
    if (isPollableExternalLink(link)) {
      applyMemoryConnectorPollTargetDelta(
        this.records,
        linkRecord.workspaceId,
        link,
        1,
      )
    }
    this.records.set(createMemoryKey(
      installationRecord.workspaceId,
      installationRecord.recordKey,
    ), {
      ...currentInstallation,
      externalLinkCount: Number(externalLinkCount) + 1,
      version: currentInstallation.version + 1,
    })
    for (const indexRecord of indexRecords) {
      this.records.set(
        createMemoryKey(indexRecord.workspaceId, indexRecord.recordKey),
        clone(indexRecord),
      )
    }
    return 'created' as const
  }

  /** Memory commit で connector lifecycle と external-link write を同時検証します。 */
  protected async putExternalLinkWithConnectorGuard(
    linkRecord: DeveloperPlatformRecord,
    expectedLinkVersion: number,
    installationRecord: DeveloperPlatformRecord,
    previousLink: ExternalWorkItemLink,
    expectedConnectorStatus: 'connected' | 'disconnected',
    completion?: PreparedIdempotencyCompletionRecord,
    _auditPut?: AuditTransactWriteItem,
  ) {
    const currentInstallation = this.records.get(createMemoryKey(
      installationRecord.workspaceId,
      installationRecord.recordKey,
    ))
    const installation = currentInstallation?.entryType ===
        'connector-installation'
      ? readRecordValue<ConnectorInstallation>(
          currentInstallation,
          'connector-installation',
        )
      : undefined
    if (
      currentInstallation?.version !== installationRecord.version ||
      installation?.status !== expectedConnectorStatus
    ) return false
    const linkKey = createMemoryKey(linkRecord.workspaceId, linkRecord.recordKey)
    if (this.records.get(linkKey)?.version !== expectedLinkVersion) return false
    let idempotencyKey: string | undefined
    if (completion) {
      idempotencyKey = createMemoryKey(
        completion.reservedRecord.workspaceId,
        completion.reservedRecord.recordKey,
      )
      const currentIdempotency = this.records.get(idempotencyKey)
      if (
        !currentIdempotency ||
        currentIdempotency.version !== completion.reservedRecord.version ||
        currentIdempotency.entryType !== 'idempotency'
      ) return false
      const currentValue = readRecordValue<StoredIdempotencyValue>(
        currentIdempotency,
        'idempotency',
      )
      if (
        currentValue.state !== 'reserved' ||
        !secretDigestsEqual(
          currentValue.reservationDigest,
          completion.reservationDigest,
        ) ||
        currentValue.requestFingerprintDigest !== completion.requestFingerprintDigest
      ) return false
    }
    const nextLink = readRecordValue<ExternalWorkItemLink>(linkRecord, 'external-link')
    const pollTargetDelta = Number(isPollableExternalLink(nextLink)) -
      Number(isPollableExternalLink(previousLink))
    if (pollTargetDelta !== 0) {
      applyMemoryConnectorPollTargetDelta(
        this.records,
        linkRecord.workspaceId,
        nextLink,
        pollTargetDelta,
      )
    }
    this.records.set(linkKey, clone(linkRecord))
    if (completion && idempotencyKey) {
      this.records.set(idempotencyKey, clone(completion.completedRecord))
    }
    return true
  }

  /** Memory row の current disconnect cleanup markerだけを条件付き解除します。 */
  protected async clearConnectorDisconnectCleanupMarker(
    workspaceId: string,
    connectorRecordKey: string,
    expectedRecordVersion: number,
    expectedCleanupRevision: number,
  ) {
    const key = createMemoryKey(workspaceId, connectorRecordKey)
    const current = this.records.get(key)
    const installation = current?.entryType === 'connector-installation'
      ? readRecordValue<ConnectorInstallation>(current, 'connector-installation')
      : undefined
    if (
      current?.version !== expectedRecordVersion ||
      current.connectorDisconnectCleanupRevision !== expectedCleanupRevision ||
      installation?.status !== 'disconnected'
    ) return false
    const completed = clone(current)
    delete completed.connectorDisconnectCleanupRevision
    this.records.set(key, completed)
    return true
  }

  /** Memory commit で link、claim、sync state、receipt を同時に更新します。 */
  protected async deleteExternalLinkWithClaim(
    linkRecord: DeveloperPlatformRecord,
    claimRecordKey: string,
    indexRecordKeys: readonly string[],
    completion?: PreparedIdempotencyCompletionRecord,
    _auditPut?: AuditTransactWriteItem,
  ) {
    const linkKey = createMemoryKey(linkRecord.workspaceId, linkRecord.recordKey)
    const currentLinkRecord = this.records.get(linkKey)
    if (
      currentLinkRecord?.entryType !== 'external-link' ||
      currentLinkRecord.version !== linkRecord.version
    ) return false
    const currentLink = readRecordValue<ExternalWorkItemLink>(
      currentLinkRecord,
      'external-link',
    )
    if (currentLink.syncStatus === 'conflict') return false

    const claimKey = createMemoryKey(linkRecord.workspaceId, claimRecordKey)
    const claim = this.records.get(claimKey)
    if (claim?.entryType !== 'external-link-claim') return false
    const claimValue = readRecordValue<StoredExternalLinkClaimValue>(
      claim,
      'external-link-claim',
    )
    if (claimValue.targetRecordKey !== linkRecord.recordKey) return false

    const indexKeys = indexRecordKeys.map((recordKey) =>
      createMemoryKey(linkRecord.workspaceId, recordKey)
    )
    if (indexKeys.some((indexKey) => {
      const indexRecord = this.records.get(indexKey)
      if (indexRecord?.entryType !== 'external-link-index') return true
      return readRecordValue<StoredExternalLinkIndexValue>(
        indexRecord,
        'external-link-index',
      ).targetRecordKey !== linkRecord.recordKey
    })) return false

    const fenceKey = createMemoryKey(
      linkRecord.workspaceId,
      createWorkItemLinkFenceRecordKey(currentLink.teamId, currentLink.workItemId),
    )
    const currentFence = this.records.get(fenceKey)
    const currentFenceValue = currentFence?.entryType === 'work-item-link-fence'
      ? readRecordValue<StoredWorkItemLinkFenceValue>(
          currentFence,
          'work-item-link-fence',
        )
      : undefined
    const activeLinkCount = readWorkItemLinkFenceCount(currentFence)
    if (
      !currentFence ||
      !currentFenceValue ||
      currentFenceValue.deletedAt ||
      currentFenceValue.teamId !== currentLink.teamId ||
      currentFenceValue.workItemId !== currentLink.workItemId ||
      activeLinkCount < 1
    ) return false
    const installationKey = createMemoryKey(
      linkRecord.workspaceId,
      createConnectorRecordKey(currentLink.installationId),
    )
    const currentInstallation = this.records.get(installationKey)
    if (
      currentInstallation?.entryType !== 'connector-installation' ||
      !Number.isSafeInteger(currentInstallation.externalLinkCount) ||
      Number(currentInstallation.externalLinkCount) < 1
    ) return false

    let idempotencyKey: string | undefined
    if (completion) {
      idempotencyKey = createMemoryKey(
        completion.reservedRecord.workspaceId,
        completion.reservedRecord.recordKey,
      )
      const currentIdempotency = this.records.get(idempotencyKey)
      if (
        !currentIdempotency ||
        currentIdempotency.version !== completion.reservedRecord.version ||
        currentIdempotency.entryType !== 'idempotency'
      ) return false
      const currentValue = readRecordValue<StoredIdempotencyValue>(
        currentIdempotency,
        'idempotency',
      )
      if (
        currentValue.state !== 'reserved' ||
        !secretDigestsEqual(
          currentValue.reservationDigest,
          completion.reservationDigest,
        ) ||
        currentValue.requestFingerprintDigest !==
          completion.requestFingerprintDigest
      ) return false
    }

    this.records.delete(claimKey)
    this.records.delete(linkKey)
    if (isPollableExternalLink(currentLink)) {
      applyMemoryConnectorPollTargetDelta(
        this.records,
        linkRecord.workspaceId,
        currentLink,
        -1,
      )
    }
    for (const indexKey of indexKeys) this.records.delete(indexKey)
    this.records.delete(createMemoryKey(
      linkRecord.workspaceId,
      createConnectorSyncStateRecordKey(currentLink.id),
    ))
    this.records.set(fenceKey, {
      ...currentFence,
      activeLinkCount: activeLinkCount - 1,
      version: currentFence.version + 1,
    })
    this.records.set(installationKey, {
      ...currentInstallation,
      externalLinkCount: Number(currentInstallation.externalLinkCount) - 1,
      version: currentInstallation.version + 1,
    })
    if (completion && idempotencyKey) {
      this.records.set(idempotencyKey, clone(completion.completedRecord))
    }
    return true
  }

  /** Credential fixed-window counter を原子的に消費します。 */
  protected async consumeRateLimitRecord(input: ConsumeRateLimitStorageInput) {
    const key = createMemoryKey(input.workspaceId, input.recordKey)
    const existing = this.records.get(key)
    if (existing) {
      const value = readRecordValue<StoredRateLimitValue>(existing, 'rate-limit')
      if (value.limit !== input.limit || value.resetAt !== input.resetAt) {
        throw conflict(
          'RateLimitConfigurationConflict',
          'Rate limit configuration changed inside an active window.',
        )
      }
    }
    const consumed = existing?.consumed ?? 0
    if (consumed + input.cost > input.limit) {
      return { allowed: false, consumed } satisfies ConsumeRateLimitStorageResult
    }
    this.records.set(key, {
      workspaceId: input.workspaceId,
      recordKey: input.recordKey,
      entryType: 'rate-limit',
      value: { limit: input.limit, resetAt: input.resetAt } satisfies StoredRateLimitValue,
      consumed: consumed + input.cost,
      expiresAt: input.expiresAt,
      version: (existing?.version ?? 0) + 1,
    })
    return {
      allowed: true,
      consumed: consumed + input.cost,
    } satisfies ConsumeRateLimitStorageResult
  }

  /** Existing claim target と new canonical identity を比較します。 */
  private compareExternalLinkClaim(
    candidateRecord: DeveloperPlatformRecord,
    claimRecord: DeveloperPlatformRecord,
  ): SaveExternalLinkResult {
    const claim = readRecordValue<StoredExternalLinkClaimValue>(
      claimRecord,
      'external-link-claim',
    )
    const target = this.records.get(
      createMemoryKey(candidateRecord.workspaceId, claim.targetRecordKey),
    )
    if (!target || target.entryType !== 'external-link') {
      throw persistenceInvalid('External link claim has no target.')
    }
    const candidate = readRecordValue<ExternalWorkItemLink>(
      candidateRecord,
      'external-link',
    )
    const existing = readRecordValue<ExternalWorkItemLink>(target, 'external-link')
    return haveSameExternalLinkCreationFields(existing, candidate)
      ? 'same-owner'
      : 'conflict'
  }
}

/** Production DynamoDB-backed developer platform client です。 */
export class DynamoDbDeveloperPlatformClient extends BaseDeveloperPlatformClient {
  /** Developer platform single-table 名です。 */
  private readonly tableName: string
  /** lookupKey GSI 名です。 */
  private readonly lookupIndexName: string
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient

  constructor(
    tableName = process.env.DEVELOPER_PLATFORM_TABLE_NAME ??
      'mukuroji-developer-platform-local',
    documentClient = createDeveloperPlatformDocumentClient(),
    secretProtector: SecretProtector = createDefaultSecretProtector(),
    clock: () => Date = () => new Date(),
    lookupIndexName = process.env.DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME ??
      DEVELOPER_PLATFORM_LOOKUP_INDEX_NAME,
    auditTableName = getConfiguredAuditTableName(),
  ) {
    super(secretProtector, clock, auditTableName)
    this.tableName = requireText(tableName, 'Developer platform table name')
    this.documentClient = documentClient
    this.lookupIndexName = requireText(
      lookupIndexName,
      'Developer platform lookup index name',
    )
  }

  /** Primary key で row を強整合取得します。 */
  protected async getRecord(workspaceId: string, recordKey: string) {
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey },
        ConsistentRead: true,
      }))
      return response.Item
        ? readStoredRecord(response.Item)
        : undefined
    } catch (error) {
      throw toPersistenceError(error)
    }
  }

  /** LookupKeyIndex を件数上限付きで query します。 */
  protected async queryLookupIndex(request: QueryLookupIndexRequest) {
    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: this.lookupIndexName,
        KeyConditionExpression: 'lookupKey = :lookupKey',
        ExpressionAttributeValues: { ':lookupKey': request.lookupKey },
        Limit: request.limit,
        ScanIndexForward: request.scanIndexForward,
        ...(request.exclusiveStartKey
          ? {
              ExclusiveStartKey: {
                workspaceId: request.exclusiveStartKey.workspaceId,
                recordKey: request.exclusiveStartKey.recordKey,
                lookupKey: request.exclusiveStartKey.lookupKey,
                lookupSortKey: request.exclusiveStartKey.lookupSortKey,
              },
            }
          : {}),
      }))
      return {
        locators: (response.Items ?? []).map((item) =>
          readStoredRecordLocator(item, request.lookupKey)
        ),
        ...(response.LastEvaluatedKey
          ? {
              lastEvaluatedKey: readStoredRecordLocator(
                response.LastEvaluatedKey,
                request.lookupKey,
              ),
            }
          : {}),
      } satisfies QueryLookupIndexResult
    } catch (error) {
      if (error instanceof DeveloperPlatformError) throw error
      throw toPersistenceError(error)
    }
  }

  /** Migration marker を強整合取得して active locator の移行状態を返します。 */
  protected async readWebhookActiveLocatorMigrationState() {
    try {
      const response = await this.documentClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          workspaceId: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID,
          recordKey: WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY,
        },
        ConsistentRead: true,
      }))
      return readStoredWebhookActiveLocatorMigrationState(response.Item)
    } catch (error) {
      if (error instanceof DeveloperPlatformError) throw error
      throw toPersistenceError(error)
    }
  }

  /** Workspace partition の prefix rows を全 page 取得します。 */
  protected async listRecords(workspaceId: string, recordKeyPrefix: string) {
    const records: DeveloperPlatformRecord[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    try {
      do {
        const response = await this.documentClient.send(new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression:
            'workspaceId = :workspaceId AND begins_with(recordKey, :recordKeyPrefix)',
          ExpressionAttributeValues: {
            ':workspaceId': workspaceId,
            ':recordKeyPrefix': recordKeyPrefix,
          },
          ConsistentRead: true,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }))
        records.push(...(response.Items ?? []).map(readStoredRecord))
        exclusiveStartKey = response.LastEvaluatedKey
      } while (exclusiveStartKey)
      return records
    } catch (error) {
      throw toPersistenceError(error)
    }
  }

  /** Workspace partition の prefix rows をstrongly consistentなbounded pageで返します。 */
  protected async listRecordsPage(
    workspaceId: string,
    recordKeyPrefix: string,
    limit: number,
    exclusiveStartRecordKey?: string,
  ) {
    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression:
          'workspaceId = :workspaceId AND begins_with(recordKey, :recordKeyPrefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':recordKeyPrefix': recordKeyPrefix,
        },
        ConsistentRead: true,
        Limit: limit,
        ...(exclusiveStartRecordKey
          ? {
              ExclusiveStartKey: {
                workspaceId,
                recordKey: exclusiveStartRecordKey,
              },
            }
          : {}),
      }))
      const records = (response.Items ?? []).map(readStoredRecord)
      const nextRecordKey = response.LastEvaluatedKey?.recordKey
      if (
        nextRecordKey !== undefined &&
        (
          typeof nextRecordKey !== 'string' ||
          !nextRecordKey.startsWith(recordKeyPrefix)
        )
      ) throw persistenceInvalid('Developer platform page cursor is invalid.')
      return {
        records,
        ...(nextRecordKey ? { nextRecordKey } : {}),
      } satisfies ListRecordsPageResult
    } catch (error) {
      if (error instanceof DeveloperPlatformError) throw error
      throw toPersistenceError(error)
    }
  }

  /** lookupKey GSI から一意な row を取得します。 */
  protected async getRecordByLookupKey(lookupKey: string) {
    try {
      const response = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        IndexName: this.lookupIndexName,
        KeyConditionExpression: 'lookupKey = :lookupKey',
        ExpressionAttributeValues: { ':lookupKey': lookupKey },
        Limit: 2,
      }))
      if ((response.Items?.length ?? 0) > 1) {
        throw persistenceInvalid('Developer lookup is not unique.')
      }
      return response.Items?.[0]
        ? readStoredRecordLocator(response.Items[0], lookupKey)
        : undefined
    } catch (error) {
      if (error instanceof DeveloperPlatformError) throw error
      throw toPersistenceError(error)
    }
  }

  /** Row を作成または version 条件付き置換します。 */
  protected async putRecord(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition = {},
  ) {
    const conditional = condition.ifAbsent
      ? {
          ConditionExpression:
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        }
      : condition.expectedVersion === undefined
        ? {}
        : {
            ConditionExpression: '#version = :expectedVersion',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: {
              ':expectedVersion': condition.expectedVersion,
            },
          }
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: record,
        ...conditional,
      }))
      return true
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) return false
      throw toPersistenceError(error)
    }
  }

  /** Domain row と encrypted response receipt を DynamoDB transaction で保存します。 */
  protected async putRecordWithIdempotency(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    completion: PreparedIdempotencyCompletionRecord,
    auditPut?: AuditTransactWriteItem,
  ) {
    const recordCondition = condition.ifAbsent
      ? {
          ConditionExpression:
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        }
      : condition.expectedVersion === undefined
        ? {}
        : {
            ConditionExpression: '#recordVersion = :expectedRecordVersion',
            ExpressionAttributeNames: { '#recordVersion': 'version' },
            ExpressionAttributeValues: {
              ':expectedRecordVersion': condition.expectedVersion,
            },
          }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: record,
              ...recordCondition,
            },
          },
          createIdempotencyCompletionTransactWriteItem(this.tableName, completion),
          ...(auditPut ? [auditPut] : []),
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** Domain row と immutable audit outbox event を DynamoDB transaction で保存します。 */
  protected async putRecordWithAudit(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    auditPut: AuditTransactWriteItem,
  ) {
    const recordCondition = condition.ifAbsent
      ? {
          ConditionExpression:
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        }
      : condition.expectedVersion === undefined
        ? {}
        : {
            ConditionExpression: '#recordVersion = :expectedRecordVersion',
            ExpressionAttributeNames: { '#recordVersion': 'version' },
            ExpressionAttributeValues: {
              ':expectedRecordVersion': condition.expectedVersion,
            },
          }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: record,
              ...recordCondition,
            },
          },
          auditPut,
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** Credential domain/auth rows と receipt を DynamoDB transaction で保存します。 */
  protected async putCredentialRecord(
    record: DeveloperPlatformRecord,
    condition: PutRecordCondition,
    authWrite?: CredentialAuthRecordWrite,
    authDelete?: CredentialAuthRecordDelete,
    completion?: PreparedIdempotencyCompletionRecord,
  ) {
    const recordCondition = condition.ifAbsent
      ? {
          ConditionExpression:
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        }
      : condition.expectedVersion === undefined
        ? {}
        : {
            ConditionExpression: '#recordVersion = :expectedRecordVersion',
            ExpressionAttributeNames: { '#recordVersion': 'version' },
            ExpressionAttributeValues: {
              ':expectedRecordVersion': condition.expectedVersion,
            },
          }
    const authCondition = authWrite?.condition.ifAbsent
      ? {
          ConditionExpression:
            'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
        }
      : authWrite?.condition.expectedVersion === undefined
        ? {}
        : {
            ConditionExpression:
              '#authVersion = :expectedAuthVersion AND #entryType = :authEntryType',
            ExpressionAttributeNames: {
              '#authVersion': 'version',
              '#entryType': 'entryType',
            },
            ExpressionAttributeValues: {
              ':expectedAuthVersion': authWrite.condition.expectedVersion,
              ':authEntryType': 'credential-auth',
            },
          }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: record,
              ...recordCondition,
            },
          },
          ...(authWrite
            ? [{
                Put: {
                  TableName: this.tableName,
                  Item: authWrite.record,
                  ...authCondition,
                },
              }]
            : []),
          ...(authDelete
            ? [{
                Delete: {
                  TableName: this.tableName,
                  Key: {
                    workspaceId: authDelete.workspaceId,
                    recordKey: authDelete.recordKey,
                  },
                  ConditionExpression:
                    'attribute_not_exists(workspaceId) OR ' +
                    '(#authVersion = :expectedAuthVersion AND ' +
                    '#entryType = :authEntryType)',
                  ExpressionAttributeNames: {
                    '#authVersion': 'version',
                    '#entryType': 'entryType',
                  },
                  ExpressionAttributeValues: {
                    ':expectedAuthVersion': authDelete.expectedVersion,
                    ':authEntryType': 'credential-auth',
                  },
                },
              }]
            : []),
          ...(completion
            ? [createIdempotencyCompletionTransactWriteItem(
                this.tableName,
                completion,
              )]
            : []),
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** OAuth app 利用記録、token domain/auth rows を一 transaction で保存します。 */
  protected async createOAuthTokenRecords(
    appRecord: DeveloperPlatformRecord,
    expectedAppVersion: number,
    tokenRecord: DeveloperPlatformRecord,
    authRecord: DeveloperPlatformRecord,
  ) {
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: appRecord,
              ConditionExpression: '#recordVersion = :expectedRecordVersion',
              ExpressionAttributeNames: { '#recordVersion': 'version' },
              ExpressionAttributeValues: {
                ':expectedRecordVersion': expectedAppVersion,
              },
            },
          },
          ...[tokenRecord, authRecord].map((record) => ({
            Put: {
              TableName: this.tableName,
              Item: record,
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            },
          })),
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** Credential domain/auth rows を一 transaction で削除します。 */
  protected async deleteCredentialRecord(
    record: DeveloperPlatformRecord,
    authRecord?: DeveloperPlatformRecord,
  ) {
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                workspaceId: record.workspaceId,
                recordKey: record.recordKey,
              },
              ConditionExpression:
                'attribute_not_exists(workspaceId) OR #entryType = :recordEntryType',
              ExpressionAttributeNames: { '#entryType': 'entryType' },
              ExpressionAttributeValues: {
                ':recordEntryType': record.entryType,
              },
            },
          },
          ...(authRecord
            ? [{
                Delete: {
                  TableName: this.tableName,
                  Key: {
                    workspaceId: authRecord.workspaceId,
                    recordKey: authRecord.recordKey,
                  },
                  ConditionExpression:
                    'attribute_not_exists(workspaceId) OR ' +
                    '(#authVersion = :expectedAuthVersion AND ' +
                    '#entryType = :authEntryType)',
                  ExpressionAttributeNames: {
                    '#authVersion': 'version',
                    '#entryType': 'entryType',
                  },
                  ExpressionAttributeValues: {
                    ':expectedAuthVersion': authRecord.version,
                    ':authEntryType': 'credential-auth',
                  },
                },
              }]
            : []),
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /**
   * Work Item など別 table の domain mutation に encrypted response receipt を追加します。
   */
  async prepareIdempotencyCompletionTransactWrite(
    request: CompleteIdempotencyRequest,
  ): Promise<IdempotencyCompletionTransactWrite> {
    const completion = await this.prepareIdempotencyCompletionRecord(
      request.workspaceId,
      {
        credentialId: request.credentialId,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: request.requestFingerprint,
        reservationId: request.reservationId,
      },
      request.response,
    )
    return {
      transactWriteItem: createIdempotencyCompletionTransactWriteItem(
        this.tableName,
        completion,
      ),
    }
  }

  /** Work Item delete と external-link create を同じ durable fence で直列化します。 */
  async prepareWorkItemDeletionFenceTransactWrite(
    request: PrepareWorkItemDeletionFenceRequest,
  ): Promise<WorkItemDeletionFenceTransactWrite> {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const teamId = readIdentifier(request.teamId, 'Team ID')
    const workItemId = readIdentifier(request.workItemId, 'Work Item ID')
    const deletedAt = this.clock().toISOString()
    const value = {
      teamId,
      workItemId,
      deletedAt,
    } satisfies StoredWorkItemLinkFenceValue
    return {
      transactWriteItem: {
        Put: {
          TableName: this.tableName,
          Item: {
            workspaceId,
            recordKey: createWorkItemLinkFenceRecordKey(teamId, workItemId),
            entryType: 'work-item-link-fence',
            value,
            activeLinkCount: 0,
            version: 1,
          },
          ConditionExpression:
            'attribute_not_exists(workspaceId) OR ' +
            '(#entryType = :entryType AND activeLinkCount = :zero AND ' +
            '#value.#teamId = :teamId AND #value.#workItemId = :workItemId AND ' +
            'attribute_not_exists(#value.#deletedAt))',
          ExpressionAttributeNames: {
            '#entryType': 'entryType',
            '#value': 'value',
            '#teamId': 'teamId',
            '#workItemId': 'workItemId',
            '#deletedAt': 'deletedAt',
          },
          ExpressionAttributeValues: {
            ':entryType': 'work-item-link-fence',
            ':zero': 0,
            ':teamId': teamId,
            ':workItemId': workItemId,
          },
        },
      },
    }
  }

  /** Primary key の row を削除します。 */
  protected async deleteRecord(
    workspaceId: string,
    recordKey: string,
    expectedVersion?: number,
  ) {
    try {
      await this.documentClient.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey },
        ...(expectedVersion === undefined
          ? {}
          : {
              ConditionExpression: '#version = :expectedVersion',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':expectedVersion': expectedVersion },
            }),
      }))
      return true
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) return false
      throw toPersistenceError(error)
    }
  }

  /** Webhook subscription と quota counter、optional receipt を同じ transaction にします。 */
  protected async createWebhookSubscriptionRecord(
    record: DeveloperPlatformRecord,
    completion?: PreparedIdempotencyCompletionRecord,
  ): Promise<'created' | 'quota-exceeded' | 'conflict'> {
    const quotaRecordKey = createWebhookSubscriptionQuotaRecordKey()
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { workspaceId: record.workspaceId, recordKey: quotaRecordKey },
              UpdateExpression:
                'SET #entryType = if_not_exists(#entryType, :entryType), ' +
                '#value = if_not_exists(#value, :value), ' +
                'subscriptionCount = if_not_exists(subscriptionCount, :zero) + :one, ' +
                '#version = if_not_exists(#version, :zero) + :one',
              ConditionExpression:
                '(attribute_not_exists(#entryType) OR ' +
                '(#entryType = :entryType AND #value.#limit = :limit)) AND ' +
                '(attribute_not_exists(subscriptionCount) OR subscriptionCount < :limit)',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#value': 'value',
                '#limit': 'limit',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':entryType': 'webhook-subscription-quota',
                ':value': { limit: WEBHOOK_SUBSCRIPTION_LIMIT } satisfies
                  StoredWebhookSubscriptionQuotaValue,
                ':limit': WEBHOOK_SUBSCRIPTION_LIMIT,
                ':zero': 0,
                ':one': 1,
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: record,
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: createActiveWebhookSubscriptionRecord(
                record.workspaceId,
                readRecordValue<WebhookSubscription>(
                  record,
                  'webhook-subscription',
                ),
              ),
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            },
          },
          ...(completion
            ? [createIdempotencyCompletionTransactWriteItem(this.tableName, completion)]
            : []),
        ],
      }))
      return 'created'
    } catch (error) {
      if (!isTransactionConditionFailure(error)) throw toPersistenceError(error)
      const quotaRecord = await this.getRecord(record.workspaceId, quotaRecordKey)
      if (
        quotaRecord?.entryType === 'webhook-subscription-quota' &&
        (quotaRecord.subscriptionCount ?? 0) >= WEBHOOK_SUBSCRIPTION_LIMIT
      ) return 'quota-exceeded'
      return 'conflict'
    }
  }

  /** Subscription と active locator、optional receipt を同じ transaction にします。 */
  protected async putWebhookSubscriptionRecord(
    record: DeveloperPlatformRecord,
    expectedVersion: number,
    completion?: PreparedIdempotencyCompletionRecord,
  ) {
    const subscription = readRecordValue<WebhookSubscription>(
      record,
      'webhook-subscription',
    )
    const locator = createActiveWebhookSubscriptionRecord(
      record.workspaceId,
      subscription,
    )
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: record,
              ConditionExpression:
                '#recordVersion = :expectedRecordVersion AND ' +
                '#entryType = :subscriptionEntryType',
              ExpressionAttributeNames: {
                '#recordVersion': 'version',
                '#entryType': 'entryType',
              },
              ExpressionAttributeValues: {
                ':expectedRecordVersion': expectedVersion,
                ':subscriptionEntryType': 'webhook-subscription',
              },
            },
          },
          subscription.status === 'active'
            ? {
                Put: {
                  TableName: this.tableName,
                  Item: locator,
                },
              }
            : {
                Delete: {
                  TableName: this.tableName,
                  Key: {
                    workspaceId: locator.workspaceId,
                    recordKey: locator.recordKey,
                  },
                },
              },
          ...(completion
            ? [createIdempotencyCompletionTransactWriteItem(this.tableName, completion)]
            : []),
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** Webhook subscription の無効化と quota 解放を同じ transaction にします。 */
  protected async disableWebhookSubscriptionRecord(
    record: DeveloperPlatformRecord,
    expectedVersion: number,
    completion?: PreparedIdempotencyCompletionRecord,
  ) {
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: record,
              ConditionExpression:
                '#recordVersion = :expectedRecordVersion AND ' +
                '#entryType = :subscriptionEntryType',
              ExpressionAttributeNames: {
                '#recordVersion': 'version',
                '#entryType': 'entryType',
              },
              ExpressionAttributeValues: {
                ':expectedRecordVersion': expectedVersion,
                ':subscriptionEntryType': 'webhook-subscription',
              },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: {
                workspaceId: record.workspaceId,
                recordKey: createWebhookSubscriptionQuotaRecordKey(),
              },
              UpdateExpression:
                'SET subscriptionCount = subscriptionCount - :one, ' +
                '#version = #version + :one',
              ConditionExpression:
                '#entryType = :entryType AND #value.#limit = :limit AND ' +
                'subscriptionCount >= :one',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#value': 'value',
                '#limit': 'limit',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':entryType': 'webhook-subscription-quota',
                ':limit': WEBHOOK_SUBSCRIPTION_LIMIT,
                ':one': 1,
              },
            },
          },
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                workspaceId: record.workspaceId,
                recordKey: createActiveWebhookSubscriptionRecordKey(
                  readRecordValue<WebhookSubscription>(
                    record,
                    'webhook-subscription',
                  ),
                ),
              },
            },
          },
          ...(completion
            ? [createIdempotencyCompletionTransactWriteItem(this.tableName, completion)]
            : []),
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** Delivery attempt と subscription health を同じ DynamoDB transaction にします。 */
  protected async putWebhookDeliveryAttempt(
    deliveryRecord: DeveloperPlatformRecord,
    expectedDeliveryVersion: number,
    subscriptionRecordKey: string,
    delivered: boolean,
    attemptedAt: string,
  ) {
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: deliveryRecord,
              ConditionExpression: '#version = :expectedVersion',
              ExpressionAttributeNames: { '#version': 'version' },
              ExpressionAttributeValues: { ':expectedVersion': expectedDeliveryVersion },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: {
                workspaceId: deliveryRecord.workspaceId,
                recordKey: subscriptionRecordKey,
              },
              UpdateExpression:
                'SET #value.#lastDeliveryAt = :attemptedAt, ' +
                '#value.#updatedAt = :attemptedAt, ' +
                '#value.#failureCount = ' +
                (delivered
                  ? ':zero, '
                  : 'if_not_exists(#value.#failureCount, :zero) + :one, ') +
                '#version = #version + :one',
              ConditionExpression: '#entryType = :entryType',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#value': 'value',
                '#lastDeliveryAt': 'lastDeliveryAt',
                '#updatedAt': 'updatedAt',
                '#failureCount': 'failureCount',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':entryType': 'webhook-subscription',
                ':attemptedAt': attemptedAt,
                ':zero': 0,
                ':one': 1,
              },
            },
          },
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** Delivery 本体と immutable index locator を原子的に新規保存します。 */
  protected async createWebhookDeliveryRecords(
    records: readonly DeveloperPlatformRecord[],
  ) {
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: records.map((record) => ({
          Put: {
            TableName: this.tableName,
            Item: record,
            ConditionExpression:
              'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
          },
        })),
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** External link と tenant-scoped uniqueness claim を原子的に保存します。 */
  protected async saveExternalLinkWithClaim(
    linkRecord: DeveloperPlatformRecord,
    claimRecord: DeveloperPlatformRecord,
    indexRecords: readonly DeveloperPlatformRecord[],
    installationRecord: DeveloperPlatformRecord,
    auditPut?: AuditTransactWriteItem,
  ): Promise<SaveExternalLinkResult> {
    const link = readRecordValue<ExternalWorkItemLink>(linkRecord, 'external-link')
    const fenceRecordKey = createWorkItemLinkFenceRecordKey(
      link.teamId,
      link.workItemId,
    )
    const existingClaim = await this.getRecord(
      claimRecord.workspaceId,
      claimRecord.recordKey,
    )
    if (existingClaim) {
      return this.compareDynamoExternalLinkClaim(linkRecord, existingClaim)
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: {
                workspaceId: installationRecord.workspaceId,
                recordKey: installationRecord.recordKey,
              },
              UpdateExpression:
                'SET externalLinkCount = externalLinkCount + :one, ' +
                '#version = #version + :one',
              ConditionExpression:
                '#entryType = :entryType AND #value.#status = :connected AND ' +
                'externalLinkCount < :limit',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#version': 'version',
                '#value': 'value',
                '#status': 'status',
              },
              ExpressionAttributeValues: {
                ':entryType': 'connector-installation',
                ':connected': 'connected',
                ':limit': EXTERNAL_LINK_INSTALLATION_LIMIT,
                ':one': 1,
              },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: {
                workspaceId: linkRecord.workspaceId,
                recordKey: fenceRecordKey,
              },
              UpdateExpression:
                'SET #entryType = if_not_exists(#entryType, :entryType), ' +
                '#value = if_not_exists(#value, :value), ' +
                'activeLinkCount = if_not_exists(activeLinkCount, :zero) + :one, ' +
                '#version = if_not_exists(#version, :zero) + :one',
              ConditionExpression:
                'attribute_not_exists(#entryType) OR ' +
                '(#entryType = :entryType AND #value.#teamId = :teamId AND ' +
                '#value.#workItemId = :workItemId AND ' +
                'attribute_not_exists(#value.#deletedAt) AND ' +
                'activeLinkCount < :limit)',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#value': 'value',
                '#teamId': 'teamId',
                '#workItemId': 'workItemId',
                '#deletedAt': 'deletedAt',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':entryType': 'work-item-link-fence',
                ':value': {
                  teamId: link.teamId,
                  workItemId: link.workItemId,
                } satisfies StoredWorkItemLinkFenceValue,
                ':teamId': link.teamId,
                ':workItemId': link.workItemId,
                ':zero': 0,
                ':one': 1,
                ':limit': EXTERNAL_LINK_WORK_ITEM_LIMIT,
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: claimRecord,
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: linkRecord,
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            },
          },
          ...(isPollableExternalLink(link)
            ? [createConnectorPollTargetTransactUpdate(
                this.tableName,
                linkRecord.workspaceId,
                link,
                1,
              )]
            : []),
          ...indexRecords.map((indexRecord) => ({
            Put: {
              TableName: this.tableName,
              Item: indexRecord,
              ConditionExpression:
                'attribute_not_exists(workspaceId) AND attribute_not_exists(recordKey)',
            },
          })),
          ...(auditPut ? [auditPut] : []),
        ],
      }))
      return 'created'
    } catch (error) {
      if (isTransactionConditionFailure(error)) {
        const concurrentClaim = await this.getRecord(
          claimRecord.workspaceId,
          claimRecord.recordKey,
        )
        if (concurrentClaim) {
          return this.compareDynamoExternalLinkClaim(linkRecord, concurrentClaim)
        }
        const currentInstallation = await this.getRecord(
          installationRecord.workspaceId,
          installationRecord.recordKey,
        )
        const installation = currentInstallation?.entryType ===
            'connector-installation'
          ? readRecordValue<ConnectorInstallation>(
              currentInstallation,
              'connector-installation',
            )
          : undefined
        if (installation?.status !== 'connected') return 'installation-changed'
        if (
          !Number.isSafeInteger(currentInstallation?.externalLinkCount) ||
          Number(currentInstallation?.externalLinkCount) < 0
        ) {
          throw persistenceInvalid(
            'Connector installation external-link count is invalid.',
          )
        }
        const currentFence = await this.getRecord(
          linkRecord.workspaceId,
          fenceRecordKey,
        )
        if (currentFence?.entryType === 'work-item-link-fence') {
          const fence = readRecordValue<StoredWorkItemLinkFenceValue>(
            currentFence,
            'work-item-link-fence',
          )
          if (fence.deletedAt) return 'work-item-deleted'
          if (
            Number(currentFence.activeLinkCount) >= EXTERNAL_LINK_WORK_ITEM_LIMIT
          ) return 'work-item-limit-exceeded'
        }
        if (
          Number(currentInstallation?.externalLinkCount) >=
            EXTERNAL_LINK_INSTALLATION_LIMIT
        ) return 'installation-limit-exceeded'
        throw persistenceConflict()
      }
      throw toPersistenceError(error)
    }
  }

  /** Connector version/status と external-link mutation を同じ transaction で保存します。 */
  protected async putExternalLinkWithConnectorGuard(
    linkRecord: DeveloperPlatformRecord,
    expectedLinkVersion: number,
    installationRecord: DeveloperPlatformRecord,
    previousLink: ExternalWorkItemLink,
    expectedConnectorStatus: 'connected' | 'disconnected',
    completion?: PreparedIdempotencyCompletionRecord,
    auditPut?: AuditTransactWriteItem,
  ) {
    const nextLink = readRecordValue<ExternalWorkItemLink>(
      linkRecord,
      'external-link',
    )
    const pollTargetDelta = Number(isPollableExternalLink(nextLink)) -
      Number(isPollableExternalLink(previousLink))
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: this.tableName,
              Key: {
                workspaceId: installationRecord.workspaceId,
                recordKey: installationRecord.recordKey,
              },
              ConditionExpression:
                '#version = :expectedVersion AND #value.#status = :expectedStatus',
              ExpressionAttributeNames: {
                '#version': 'version',
                '#value': 'value',
                '#status': 'status',
              },
              ExpressionAttributeValues: {
                ':expectedVersion': installationRecord.version,
                ':expectedStatus': expectedConnectorStatus,
              },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: linkRecord,
              ConditionExpression: '#linkVersion = :expectedLinkVersion',
              ExpressionAttributeNames: { '#linkVersion': 'version' },
              ExpressionAttributeValues: {
                ':expectedLinkVersion': expectedLinkVersion,
              },
            },
          },
          ...(pollTargetDelta === 0
            ? []
            : [createConnectorPollTargetTransactUpdate(
                this.tableName,
                linkRecord.workspaceId,
                nextLink,
                pollTargetDelta,
              )]),
          ...(completion
            ? [createIdempotencyCompletionTransactWriteItem(
                this.tableName,
                completion,
              )]
            : []),
          ...(auditPut ? [auditPut] : []),
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** DynamoDB row の lifecycle versionを進めずcleanup markerだけを解除します。 */
  protected async clearConnectorDisconnectCleanupMarker(
    workspaceId: string,
    connectorRecordKey: string,
    expectedRecordVersion: number,
    expectedCleanupRevision: number,
  ) {
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { workspaceId, recordKey: connectorRecordKey },
        UpdateExpression: 'REMOVE connectorDisconnectCleanupRevision',
        ConditionExpression:
          '#entryType = :entryType AND #version = :expectedRecordVersion AND ' +
          'connectorDisconnectCleanupRevision = :expectedCleanupRevision AND ' +
          '#value.#status = :disconnected',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#status': 'status',
          '#value': 'value',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':disconnected': 'disconnected',
          ':entryType': 'connector-installation',
          ':expectedCleanupRevision': expectedCleanupRevision,
          ':expectedRecordVersion': expectedRecordVersion,
        },
      }))
      return true
    } catch (error) {
      if (isNamedError(error, 'ConditionalCheckFailedException')) return false
      throw toPersistenceError(error)
    }
  }

  /** DynamoDB transaction で link、claim、sync state、receipt、audit を更新します。 */
  protected async deleteExternalLinkWithClaim(
    linkRecord: DeveloperPlatformRecord,
    claimRecordKey: string,
    indexRecordKeys: readonly string[],
    completion?: PreparedIdempotencyCompletionRecord,
    auditPut?: AuditTransactWriteItem,
  ) {
    const link = readRecordValue<ExternalWorkItemLink>(linkRecord, 'external-link')
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                workspaceId: linkRecord.workspaceId,
                recordKey: claimRecordKey,
              },
              ConditionExpression:
                '#entryType = :claimEntryType AND ' +
                '#value.#targetRecordKey = :targetRecordKey',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#value': 'value',
                '#targetRecordKey': 'targetRecordKey',
              },
              ExpressionAttributeValues: {
                ':claimEntryType': 'external-link-claim',
                ':targetRecordKey': linkRecord.recordKey,
              },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: {
                workspaceId: linkRecord.workspaceId,
                recordKey: createWorkItemLinkFenceRecordKey(
                  link.teamId,
                  link.workItemId,
                ),
              },
              UpdateExpression:
                'SET activeLinkCount = activeLinkCount - :one, ' +
                '#version = #version + :one',
              ConditionExpression:
                '#entryType = :entryType AND #value.#teamId = :teamId AND ' +
                '#value.#workItemId = :workItemId AND ' +
                'attribute_not_exists(#value.#deletedAt) AND activeLinkCount >= :one',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#value': 'value',
                '#teamId': 'teamId',
                '#workItemId': 'workItemId',
                '#deletedAt': 'deletedAt',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':entryType': 'work-item-link-fence',
                ':teamId': link.teamId,
                ':workItemId': link.workItemId,
                ':one': 1,
              },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: {
                workspaceId: linkRecord.workspaceId,
                recordKey: createConnectorRecordKey(link.installationId),
              },
              UpdateExpression:
                'SET externalLinkCount = externalLinkCount - :one, ' +
                '#version = #version + :one',
              ConditionExpression:
                '#entryType = :entryType AND externalLinkCount >= :one',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#version': 'version',
              },
              ExpressionAttributeValues: {
                ':entryType': 'connector-installation',
                ':one': 1,
              },
            },
          },
          ...indexRecordKeys.map((recordKey) => ({
            Delete: {
              TableName: this.tableName,
              Key: {
                workspaceId: linkRecord.workspaceId,
                recordKey,
              },
              ConditionExpression:
                '#entryType = :indexEntryType AND #value.#targetRecordKey = :targetRecordKey',
              ExpressionAttributeNames: {
                '#entryType': 'entryType',
                '#value': 'value',
                '#targetRecordKey': 'targetRecordKey',
              },
              ExpressionAttributeValues: {
                ':indexEntryType': 'external-link-index',
                ':targetRecordKey': linkRecord.recordKey,
              },
            },
          })),
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                workspaceId: linkRecord.workspaceId,
                recordKey: linkRecord.recordKey,
              },
              ConditionExpression:
                '#version = :expectedVersion AND #entryType = :linkEntryType AND ' +
                '#value.#syncStatus <> :conflict',
              ExpressionAttributeNames: {
                '#version': 'version',
                '#entryType': 'entryType',
                '#value': 'value',
                '#syncStatus': 'syncStatus',
              },
              ExpressionAttributeValues: {
                ':expectedVersion': linkRecord.version,
                ':linkEntryType': 'external-link',
                ':conflict': 'conflict',
              },
            },
          },
          ...(isPollableExternalLink(link)
            ? [createConnectorPollTargetTransactUpdate(
                this.tableName,
                linkRecord.workspaceId,
                link,
                -1,
              )]
            : []),
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                workspaceId: linkRecord.workspaceId,
                recordKey: createConnectorSyncStateRecordKey(link.id),
              },
            },
          },
          ...(completion
            ? [createIdempotencyCompletionTransactWriteItem(
                this.tableName,
                completion,
              )]
            : []),
          ...(auditPut ? [auditPut] : []),
        ],
      }))
      return true
    } catch (error) {
      if (isTransactionConditionFailure(error)) return false
      throw toPersistenceError(error)
    }
  }

  /** Credential fixed-window counter を原子的に消費します。 */
  protected async consumeRateLimitRecord(input: ConsumeRateLimitStorageInput) {
    const value: StoredRateLimitValue = {
      limit: input.limit,
      resetAt: input.resetAt,
    }
    try {
      const response = await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { workspaceId: input.workspaceId, recordKey: input.recordKey },
        UpdateExpression:
          'SET entryType = :entryType, #value = if_not_exists(#value, :value), ' +
          'expiresAt = :expiresAt, #version = if_not_exists(#version, :zero) + :one ' +
          'ADD consumed :cost',
        ConditionExpression:
          'attribute_not_exists(consumed) OR ' +
          '(#value.#limit = :limit AND #value.#resetAt = :resetAt AND consumed <= :maximumBefore)',
        ExpressionAttributeNames: {
          '#value': 'value',
          '#limit': 'limit',
          '#resetAt': 'resetAt',
          '#version': 'version',
        },
        ExpressionAttributeValues: {
          ':entryType': 'rate-limit',
          ':value': value,
          ':expiresAt': input.expiresAt,
          ':zero': 0,
          ':one': 1,
          ':cost': input.cost,
          ':limit': input.limit,
          ':resetAt': input.resetAt,
          ':maximumBefore': input.limit - input.cost,
        },
        ReturnValues: 'ALL_NEW',
      }))
      const consumed = response.Attributes?.consumed
      if (typeof consumed !== 'number') {
        throw persistenceInvalid('Rate limit counter response is invalid.')
      }
      return { allowed: true, consumed }
    } catch (error) {
      if (!isNamedError(error, 'ConditionalCheckFailedException')) {
        if (error instanceof DeveloperPlatformError) throw error
        throw toPersistenceError(error)
      }
      const current = await this.getRecord(input.workspaceId, input.recordKey)
      if (!current || current.entryType !== 'rate-limit') throw persistenceConflict()
      const currentValue = readRecordValue<StoredRateLimitValue>(current, 'rate-limit')
      if (currentValue.limit !== input.limit || currentValue.resetAt !== input.resetAt) {
        throw conflict(
          'RateLimitConfigurationConflict',
          'Rate limit configuration changed inside an active window.',
        )
      }
      return {
        allowed: false,
        consumed: current.consumed ?? input.limit,
      }
    }
  }

  /** Existing claim target と new canonical identity を比較します。 */
  private async compareDynamoExternalLinkClaim(
    candidateRecord: DeveloperPlatformRecord,
    claimRecord: DeveloperPlatformRecord,
  ): Promise<SaveExternalLinkResult> {
    const claim = readRecordValue<StoredExternalLinkClaimValue>(
      claimRecord,
      'external-link-claim',
    )
    const target = await this.getRecord(candidateRecord.workspaceId, claim.targetRecordKey)
    if (!target || target.entryType !== 'external-link') {
      throw persistenceInvalid('External link claim has no target.')
    }
    const candidate = readRecordValue<ExternalWorkItemLink>(
      candidateRecord,
      'external-link',
    )
    const existing = readRecordValue<ExternalWorkItemLink>(target, 'external-link')
    return haveSameExternalLinkCreationFields(existing, candidate)
      ? 'same-owner'
      : 'conflict'
  }
}

/** Webhook cursor ciphertext の authenticated context です。 */
const WEBHOOK_CURSOR_CONTEXT = 'mukuroji-developer-platform:webhook-cursor:v1'

/** Strongly consistent credential auth row の固定 sort key です。 */
const CREDENTIAL_AUTH_RECORD_KEY = 'CREDENTIAL'

/** Secret-free row 作成時の optional storage fields です。 */
type CreateRecordOptions = {
  /** lookupKey GSI value です。 */
  lookupKey?: string
  /** lookupSortKey GSI value です。 */
  lookupSortKey?: string
  /** SHA-256 secret digest です。 */
  secretDigest?: string
  /** Authenticated encrypted credential です。 */
  secretCiphertext?: string
  /** Connector credential の serialized value を束縛する SHA-256 digest です。 */
  connectorCredentialDigest?: string
  /** Connector credential replacement の単調増加 revision です。 */
  connectorCredentialRevision?: number
  /** Current connector OAuth reauthorization state ID の SHA-256 digest です。 */
  connectorOAuthStateDigest?: string
  /** Connector OAuth state fencing の単調増加 revision です。 */
  connectorOAuthStateRevision?: number
  /** Connector installation に作成済みの external-link 数です。 */
  externalLinkCount?: number
  /** DynamoDB TTL epoch seconds です。 */
  expiresAt?: number
}

function createRecord(
  workspaceId: string,
  recordKey: string,
  entryType: DeveloperPlatformEntryType,
  value: unknown,
  options: CreateRecordOptions = {},
): DeveloperPlatformRecord {
  const {
    lookupKey,
    lookupSortKey,
    ...storedOptions
  } = options
  return {
    workspaceId,
    recordKey,
    entryType,
    value: clone(value),
    ...(lookupKey
      ? {
          lookupKey,
          lookupSortKey: lookupSortKey ?? recordKey,
        }
      : {}),
    ...storedOptions,
    version: 1,
  }
}

function withoutStoredCredential(
  record: DeveloperPlatformRecord,
  removeLookupKey: boolean,
) {
  const sanitized = { ...record }
  delete sanitized.secretDigest
  if (removeLookupKey) {
    delete sanitized.lookupKey
    delete sanitized.lookupSortKey
  }
  return sanitized
}

function createApiKeyRecordKey(id: string) {
  return `APIKEY#${id}`
}

function createOAuthAppRecordKey(id: string) {
  return `OAUTHAPP#${id}`
}

function createOAuthTokenRecordKey(id: string) {
  return `OAUTHTOKEN#${id}`
}

function createApiKeyAuthWorkspaceId(secretDigest: string) {
  return `CREDENTIALAUTH#APIKEY#${secretDigest}`
}

function createOAuthClientAuthWorkspaceId(clientId: string) {
  return `CREDENTIALAUTH#OAUTHCLIENT#${digestText(clientId)}`
}

function createOAuthTokenAuthWorkspaceId(secretDigest: string) {
  return `CREDENTIALAUTH#OAUTHTOKEN#${secretDigest}`
}

function createCredentialAuthRecord(
  authWorkspaceId: string,
  kind: StoredCredentialAuthValue['kind'],
  target: DeveloperPlatformRecord,
  secretDigest: string,
  expiresAt?: number,
  version = 1,
): DeveloperPlatformRecord {
  return {
    workspaceId: authWorkspaceId,
    recordKey: CREDENTIAL_AUTH_RECORD_KEY,
    entryType: 'credential-auth',
    value: {
      kind,
      targetWorkspaceId: target.workspaceId,
      targetRecordKey: target.recordKey,
    } satisfies StoredCredentialAuthValue,
    secretDigest,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    version,
  }
}

function createCredentialAuthDelete(
  authRecord: DeveloperPlatformRecord,
): CredentialAuthRecordDelete {
  return {
    workspaceId: authRecord.workspaceId,
    recordKey: authRecord.recordKey,
    expectedVersion: authRecord.version,
  }
}

function haveSameExternalLinkCreationFields(
  existing: ExternalWorkItemLink,
  candidate: ExternalWorkItemLink,
) {
  return existing.teamId === candidate.teamId &&
    existing.workItemId === candidate.workItemId &&
    existing.installationId === candidate.installationId &&
    existing.resourceType === candidate.resourceType &&
    existing.externalId === candidate.externalId &&
    existing.externalUrl === candidate.externalUrl &&
    existing.displayKey === candidate.displayKey &&
    existing.syncDirection === candidate.syncDirection
}

function createWebhookRecordKey(id: string) {
  return `WEBHOOK#${id}`
}

function createActiveWebhookSubscriptionLookupKey(workspaceId: string) {
  return `WEBHOOK#ACTIVE#${workspaceId}`
}

function createActiveWebhookSubscriptionRecordKeyPrefix() {
  return 'WEBHOOKACTIVE#'
}

function createActiveWebhookSubscriptionRecordKey(
  subscription: WebhookSubscription,
) {
  return `${createActiveWebhookSubscriptionRecordKeyPrefix()}${subscription.createdAt}#${subscription.id}`
}

function createActiveWebhookSubscriptionRecord(
  workspaceId: string,
  subscription: WebhookSubscription,
) {
  return createRecord(
    workspaceId,
    createActiveWebhookSubscriptionRecordKey(subscription),
    'webhook-active-subscription',
    {
      targetRecordKey: createWebhookRecordKey(subscription.id),
    } satisfies StoredActiveWebhookSubscriptionValue,
  )
}

function addLegacyActiveWebhookProjection(
  record: DeveloperPlatformRecord,
  subscription: WebhookSubscription,
) {
  return {
    ...record,
    lookupKey: createActiveWebhookSubscriptionLookupKey(record.workspaceId),
    lookupSortKey: `${subscription.createdAt}#${subscription.id}`,
  } satisfies DeveloperPlatformRecord
}

function removeLegacyActiveWebhookProjection(
  record: DeveloperPlatformRecord,
) {
  const current = { ...record }
  delete current.lookupKey
  delete current.lookupSortKey
  return current
}

function createWebhookSubscriptionQuotaRecordKey() {
  return 'WEBHOOKSUBSCRIPTIONQUOTA'
}

function createWebhookDeliveryRecordKey(id: string) {
  return `WEBHOOKDELIVERY#${id}`
}

function createWebhookDeliveryIdLookupKey(workspaceId: string, deliveryId: string) {
  return `WEBHOOKDELIVERY#ID#${workspaceId}#${deliveryId}`
}

function createWebhookDeliveryWorkspaceLookupKey(workspaceId: string) {
  return `WEBHOOKDELIVERY#LIST#${workspaceId}`
}

function createWebhookDeliverySubscriptionLookupKey(
  workspaceId: string,
  subscriptionId: string,
) {
  return `WEBHOOKDELIVERY#SUBSCRIPTION#${workspaceId}#${subscriptionId}`
}

function createWebhookDeliveryReplayLookupKey(
  workspaceId: string,
  originalDeliveryId: string,
) {
  return `WEBHOOKDELIVERY#REPLAY#${workspaceId}#${originalDeliveryId}`
}

function createWebhookDeliveryOrderSortKey(delivery: WebhookDelivery) {
  return `${delivery.createdAt}#${delivery.id}`
}

function createWebhookDeliveryReplaySortKey(delivery: WebhookDelivery) {
  const replayNumber = delivery.replayNumber ?? 0
  return `${String(replayNumber).padStart(16, '0')}#${delivery.id}`
}

function createWebhookDeliveryIndexRecordKey(lookupKey: string, lookupSortKey: string) {
  return `WEBHOOKDELIVERYINDEX#${digestText(`${lookupKey}\0${lookupSortKey}`)}`
}

function createWebhookDeliveryStorageRecords(
  workspaceId: string,
  value: StoredWebhookDeliveryValue,
  expiresAt: number,
) {
  const delivery = value.delivery
  const targetRecordKey = createWebhookDeliveryRecordKey(delivery.id)
  const originalDeliveryId = delivery.replayOfDeliveryId ?? delivery.id
  const orderSortKey = createWebhookDeliveryOrderSortKey(delivery)
  const indexDefinitions = [
    {
      kind: 'workspace-list',
      lookupKey: createWebhookDeliveryWorkspaceLookupKey(workspaceId),
      lookupSortKey: orderSortKey,
    },
    {
      kind: 'subscription-list',
      lookupKey: createWebhookDeliverySubscriptionLookupKey(
        workspaceId,
        delivery.subscriptionId,
      ),
      lookupSortKey: orderSortKey,
    },
    {
      kind: 'replay-chain',
      lookupKey: createWebhookDeliveryReplayLookupKey(workspaceId, originalDeliveryId),
      lookupSortKey: createWebhookDeliveryReplaySortKey(delivery),
    },
  ] as const
  return [
    createRecord(
      workspaceId,
      targetRecordKey,
      'webhook-delivery',
      value,
      {
        lookupKey: createWebhookDeliveryIdLookupKey(workspaceId, delivery.id),
        lookupSortKey: targetRecordKey,
        expiresAt,
      },
    ),
    ...indexDefinitions.map((definition) =>
      createRecord(
        workspaceId,
        createWebhookDeliveryIndexRecordKey(
          definition.lookupKey,
          definition.lookupSortKey,
        ),
        'webhook-delivery-index',
        {
          kind: definition.kind,
          targetRecordKey,
        } satisfies StoredWebhookDeliveryIndexValue,
        {
          lookupKey: definition.lookupKey,
          lookupSortKey: definition.lookupSortKey,
          expiresAt,
        },
      )
    ),
  ]
}

function createConnectorRecordKey(id: string) {
  return `CONNECTOR#${id}`
}

function createExternalLinkRecordKey(id: string) {
  return `EXTERNALLINK#${id}`
}

function createExternalLinkWorkItemLookupKey(
  workspaceId: string,
  teamId: string,
  workItemId: string,
) {
  return `EXTERNALLINK#WORKITEM#${workspaceId}#${digestText(`${teamId}\0${workItemId}`)}`
}

function createExternalLinkInstallationLookupKey(
  workspaceId: string,
  installationId: string,
  resourceType: ExternalWorkItemLink['resourceType'],
) {
  return `EXTERNALLINK#INSTALLATION#${workspaceId}#${installationId}#${resourceType}`
}

function createExternalLinkIndexRecordKeys(link: ExternalWorkItemLink) {
  return [
    `EXTERNALLINKINDEX#WORKITEM#${link.id}`,
    `${createExternalLinkInstallationIndexRecordPrefix(link.installationId)}${link.id}`,
  ] as const
}

function createExternalLinkInstallationIndexRecordPrefix(installationId: string) {
  return `EXTERNALLINKINDEX#INSTALLATION#${digestText(installationId)}#`
}

function createExternalLinkIndexRecords(
  workspaceId: string,
  link: ExternalWorkItemLink,
) {
  const targetRecordKey = createExternalLinkRecordKey(link.id)
  const [workItemRecordKey, installationRecordKey] =
    createExternalLinkIndexRecordKeys(link)
  const lookupSortKey = `${link.createdAt}#${link.id}`
  return [
    createRecord(
      workspaceId,
      workItemRecordKey,
      'external-link-index',
      {
        kind: 'work-item',
        targetRecordKey,
      } satisfies StoredExternalLinkIndexValue,
      {
        lookupKey: createExternalLinkWorkItemLookupKey(
          workspaceId,
          link.teamId,
          link.workItemId,
        ),
        lookupSortKey,
      },
    ),
    createRecord(
      workspaceId,
      installationRecordKey,
      'external-link-index',
      {
        kind: 'installation',
        targetRecordKey,
      } satisfies StoredExternalLinkIndexValue,
      {
        lookupKey: createExternalLinkInstallationLookupKey(
          workspaceId,
          link.installationId,
          link.resourceType,
        ),
        lookupSortKey,
      },
    ),
  ]
}

function isPollableExternalLink(link: ExternalWorkItemLink) {
  return link.syncStatus !== 'paused' &&
    link.syncStatus !== 'conflict' &&
    (link.syncDirection === 'inbound' || link.syncDirection === 'bidirectional')
}

function createConnectorPollTargetTransactUpdate(
  tableName: string,
  workspaceId: string,
  link: ExternalWorkItemLink,
  delta: -1 | 1,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const value = {
    installationId: link.installationId,
    resourceType: link.resourceType,
  } satisfies StoredConnectorPollTargetValue
  const incrementing = delta === 1
  return {
    Update: {
      TableName: tableName,
      Key: {
        workspaceId,
        recordKey: createConnectorPollTargetRecordKey(
          link.installationId,
          link.resourceType,
        ),
      },
      UpdateExpression:
        'SET #entryType = if_not_exists(#entryType, :entryType), ' +
        '#value = if_not_exists(#value, :value), ' +
        'pollableLinkCount = ' +
        `${incrementing ? 'if_not_exists(pollableLinkCount, :zero) +' : 'pollableLinkCount -'} :one, ` +
        'lookupKey = :lookupKey, lookupSortKey = :lookupSortKey, ' +
        '#version = if_not_exists(#version, :zero) + :one',
      ConditionExpression: incrementing
        ? 'attribute_not_exists(#entryType) OR ' +
          '(#entryType = :entryType AND #value.#installationId = :installationId AND ' +
          '#value.#resourceType = :resourceType AND pollableLinkCount >= :zero)'
        : '#entryType = :entryType AND #value.#installationId = :installationId AND ' +
          '#value.#resourceType = :resourceType AND pollableLinkCount >= :one',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#value': 'value',
        '#installationId': 'installationId',
        '#resourceType': 'resourceType',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':entryType': 'connector-poll-target',
        ':value': value,
        ':installationId': link.installationId,
        ':resourceType': link.resourceType,
        ':lookupKey': createConnectorPollTargetLookupKey(
          workspaceId,
          link.installationId,
          link.resourceType,
        ),
        ':lookupSortKey': `${workspaceId}#${link.installationId}#${link.resourceType}`,
        ':zero': 0,
        ':one': 1,
      },
    },
  }
}

function applyMemoryConnectorPollTargetDelta(
  records: Map<string, DeveloperPlatformRecord>,
  workspaceId: string,
  link: ExternalWorkItemLink,
  delta: -1 | 1,
) {
  const recordKey = createConnectorPollTargetRecordKey(
    link.installationId,
    link.resourceType,
  )
  const key = createMemoryKey(workspaceId, recordKey)
  const current = records.get(key)
  const value = current?.entryType === 'connector-poll-target'
    ? readRecordValue<StoredConnectorPollTargetValue>(
        current,
        'connector-poll-target',
      )
    : undefined
  if (
    current &&
    (
      !value ||
      value.installationId !== link.installationId ||
      value.resourceType !== link.resourceType ||
      !Number.isSafeInteger(current.pollableLinkCount) ||
      Number(current.pollableLinkCount) < 0
    )
  ) throw persistenceInvalid('Connector poll target is invalid.')
  const count = Number(current?.pollableLinkCount ?? 0)
  if (delta === -1 && count < 1) {
    throw persistenceInvalid('Connector poll target count is invalid.')
  }
  records.set(key, {
    workspaceId,
    recordKey,
    entryType: 'connector-poll-target',
    value: {
      installationId: link.installationId,
      resourceType: link.resourceType,
    } satisfies StoredConnectorPollTargetValue,
    lookupKey: createConnectorPollTargetLookupKey(
      workspaceId,
      link.installationId,
      link.resourceType,
    ),
    lookupSortKey: `${workspaceId}#${link.installationId}#${link.resourceType}`,
    pollableLinkCount: count + delta,
    version: (current?.version ?? 0) + 1,
  })
}

function createExternalLinkReplacementRecord(
  record: DeveloperPlatformRecord,
  link: ExternalWorkItemLink,
): DeveloperPlatformRecord {
  const {
    lookupKey: _lookupKey,
    lookupSortKey: _lookupSortKey,
    ...baseRecord
  } = record
  return {
    ...baseRecord,
    value: clone(link),
    version: record.version + 1,
  }
}

function createConnectorSyncStateRecordKey(linkId: string) {
  return `CONNECTORSYNC#${linkId}`
}

function createWorkItemLinkFenceRecordKey(teamId: string, workItemId: string) {
  return `WORKITEMLINKS#${digestText(`${teamId}\0${workItemId}`)}`
}

function createExternalLinkClaimRecordKey(
  installationId: string,
  resourceType: ExternalWorkItemLink['resourceType'],
  externalId: string,
) {
  return `EXTERNALCLAIM#${digestText(
    `${installationId}\0${resourceType}\0${externalId}`,
  )}`
}

function createImportJobRecordKey(id: string) {
  return `IMPORT#${id}`
}

function createIdempotencyCompletionTransactWriteItem(
  tableName: string,
  completion: PreparedIdempotencyCompletionRecord,
): IdempotencyCompletionTransactWrite['transactWriteItem'] {
  return {
    Put: {
      TableName: tableName,
      Item: completion.completedRecord,
      ConditionExpression:
        '#version = :expectedVersion AND #entryType = :entryType AND ' +
        '#value.#state = :reserved AND ' +
        '#value.#reservationDigest = :reservationDigest AND ' +
        '#value.#requestFingerprintDigest = :requestFingerprintDigest',
      ExpressionAttributeNames: {
        '#entryType': 'entryType',
        '#requestFingerprintDigest': 'requestFingerprintDigest',
        '#reservationDigest': 'reservationDigest',
        '#state': 'state',
        '#value': 'value',
        '#version': 'version',
      },
      ExpressionAttributeValues: {
        ':entryType': 'idempotency',
        ':expectedVersion': completion.reservedRecord.version,
        ':requestFingerprintDigest': completion.requestFingerprintDigest,
        ':reservationDigest': completion.reservationDigest,
        ':reserved': 'reserved',
      },
    },
  }
}

function createWebhookSecretContext(workspaceId: string, subscriptionId: string) {
  return `mukuroji:webhook:${workspaceId}:${subscriptionId}:v1`
}

function createConnectorSecretContext(workspaceId: string, installationId: string) {
  return `mukuroji:connector:${workspaceId}:${installationId}:v1`
}

function createIdempotencyResponseContext(
  workspaceId: string,
  credentialId: string,
  keyDigest: string,
) {
  return `mukuroji:idempotency-response:v1\0${workspaceId}\0${credentialId}\0${keyDigest}`
}

function createMemoryKey(workspaceId: string, recordKey: string) {
  return `${workspaceId}\0${recordKey}`
}

function isCurrentIdempotencyReservation(
  record: DeveloperPlatformRecord | undefined,
  completion: PreparedIdempotencyCompletionRecord,
) {
  if (
    !record ||
    record.version !== completion.reservedRecord.version ||
    record.entryType !== 'idempotency'
  ) return false
  const value = readRecordValue<StoredIdempotencyValue>(record, 'idempotency')
  return value.state === 'reserved' &&
    secretDigestsEqual(value.reservationDigest, completion.reservationDigest) &&
    value.requestFingerprintDigest === completion.requestFingerprintDigest
}

function createId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function createPublicIdentifier(prefix: string) {
  return `${prefix}_${randomBytes(18).toString('base64url')}`
}

function createSecret(prefix: string) {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

function createDeterministicDeliveryId(subscriptionId: string, eventId: string) {
  return `delivery_${digestText(
    `webhook-delivery-v1\0${subscriptionId}\0${eventId}`,
  ).slice(0, 40)}`
}

function createDeterministicReplayDeliveryId(
  originalDeliveryId: string,
  replayNumber: number,
) {
  return `delivery_replay_${digestText(
    `webhook-delivery-replay-v1\0${originalDeliveryId}\0${replayNumber}`,
  ).slice(0, 40)}`
}

function createDeterministicReplayOperationDeliveryId(
  originalDeliveryId: string,
  operationId: string,
) {
  return `delivery_replay_${digestText(
    `webhook-delivery-replay-operation-v1\0${originalDeliveryId}\0${operationId}`,
  ).slice(0, 40)}`
}

function readWebhookReplayOperationId(value: string) {
  const operationId = requireText(value, 'Webhook replay operation ID')
  if (!/^[a-f0-9]{64}$/u.test(operationId)) {
    throw invalid(
      'WebhookReplayOperationIdInvalid',
      'Webhook replay operation ID is invalid.',
    )
  }
  return operationId
}

function digestSecret(value: string) {
  return digestText(`developer-secret-v1\0${value}`)
}

function digestConnectorCredential(value: string) {
  return digestText(`connector-credential-v1\0${value}`)
}

function digestConnectorCredentialRefreshClaim(value: string) {
  return digestText(`connector-credential-refresh-claim-v1\0${value}`)
}

function digestConnectorOAuthState(value: string) {
  return digestText(`connector-oauth-state-v1\0${value}`)
}

function digestText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function secretDigestsEqual(left: string, right: string) {
  return safeTextEqual(left, right)
}

function safeTextEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false
  return timingSafeEqual(leftBytes, rightBytes)
}

/**
 * Webhook worker が timestamp と payload に対する HMAC-SHA256 signature を作成します。
 */
export function createWebhookSignature(
  signingSecret: string,
  timestamp: number,
  payload: string,
) {
  const secret = requireText(signingSecret, 'Webhook signing secret')
  if (typeof payload !== 'string') {
    throw invalid('WebhookPayloadInvalid', 'Webhook payload must be a string.')
  }
  const normalizedTimestamp = readPositiveInteger(timestamp, 'Webhook signature timestamp')
  const digest = createHmac('sha256', secret)
    .update(`${normalizedTimestamp}.${payload}`)
    .digest('hex')
  return `v1=${digest}`
}

function readIdentifier(value: string, label: string) {
  const normalized = requireText(value, label)
  if (normalized.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(normalized)) {
    throw invalid('DeveloperIdentifierInvalid', `${label} is invalid.`)
  }
  return normalized
}

function readConnectorOAuthStateId(value: string) {
  const normalized = requireText(value, 'Connector reauthorization state ID')
  if (
    normalized.length !== 32 ||
    !/^[A-Za-z0-9_-]{32}$/u.test(normalized)
  ) {
    throw invalid(
      'DeveloperIdentifierInvalid',
      'Connector reauthorization state ID is invalid.',
    )
  }
  return normalized
}

function readIdentifierArray(
  values: readonly string[],
  label: string,
  maximum: number,
  allowEmpty = false,
) {
  if (
    !Array.isArray(values) ||
    (!allowEmpty && values.length === 0) ||
    values.length > maximum
  ) {
    throw invalid('DeveloperIdentifierListInvalid', `${label} is invalid.`)
  }
  const normalized = values.map((value) => readIdentifier(value, label))
  if (new Set(normalized).size !== normalized.length) {
    throw invalid('DeveloperIdentifierListInvalid', `${label} must not contain duplicates.`)
  }
  return normalized.sort()
}

function readExternalIdentifier(value: string) {
  const normalized = requireText(value, 'External resource ID')
  if (normalized.length > 512 || containsControlCharacter(normalized)) {
    throw invalid('ExternalIdentifierInvalid', 'External resource ID is invalid.')
  }
  return normalized
}

function readName(value: string, label: string) {
  const normalized = requireText(value, label)
  if (normalized.length > 120 || containsControlCharacter(normalized)) {
    throw invalid('DeveloperNameInvalid', `${label} is invalid.`)
  }
  return normalized
}

function readProvider(value: ConnectorInstallation['provider']) {
  if (
    value === 'github' ||
    value === 'gitlab' ||
    value === 'slack' ||
    value === 'microsoft-teams' ||
    value === 'gmail' ||
    value === 'outlook' ||
    value === 'google-calendar' ||
    value === 'outlook-calendar' ||
    value === 'google-drive' ||
    value === 'onedrive' ||
    value === 'dropbox'
  ) return value
  throw invalid('ConnectorProviderInvalid', 'Connector provider is invalid.')
}

function requireText(value: string, label: string) {
  if (typeof value !== 'string') {
    throw invalid('DeveloperTextInvalid', `${label} must be a string.`)
  }
  const normalized = value.trim()
  if (!normalized) throw invalid('DeveloperTextInvalid', `${label} is required.`)
  return normalized
}

function readOptionalText(value: string, label: string, maximumLength: number) {
  const normalized = requireText(value, label)
  if (normalized.length > maximumLength || containsControlCharacter(normalized, true)) {
    throw invalid('DeveloperTextInvalid', `${label} is invalid.`)
  }
  return normalized
}

function containsControlCharacter(value: string, allowNewline = false) {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 32 && !(allowNewline && (code === 9 || code === 10 || code === 13))) {
      return true
    }
    if (code === 127) return true
  }
  return false
}

function readScopes(values: readonly ApiScope[]) {
  if (!Array.isArray(values) || values.length === 0 || values.length > API_SCOPES.length) {
    throw invalid('ApiScopesInvalid', 'At least one API scope is required.')
  }
  const allowed = new Set<string>(API_SCOPES)
  const scopes: ApiScope[] = []
  for (const value of values) {
    if (!allowed.has(value)) {
      throw invalid('ApiScopesInvalid', `API scope "${String(value)}" is invalid.`)
    }
    if (!scopes.includes(value)) scopes.push(value)
  }
  return scopes.sort()
}

function readConnectorScopes(values: readonly string[]) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) {
    throw invalid('ConnectorScopesInvalid', 'At least one connector scope is required.')
  }
  const scopes: string[] = []
  for (const value of values) {
    const normalized = requireText(value, 'Connector scope')
    if (
      normalized.length > 160 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized)
    ) {
      throw invalid('ConnectorScopeInvalid', `Connector scope "${normalized}" is invalid.`)
    }
    if (!scopes.includes(normalized)) scopes.push(normalized)
  }
  return scopes.sort()
}

function assertRequiredScopes(
  grantedScopes: readonly ApiScope[],
  requiredScopes: readonly ApiScope[] | undefined,
) {
  if (!requiredScopes) return
  const required = readScopes(requiredScopes)
  const granted = new Set(grantedScopes)
  const missing = required.filter((scope) => !granted.has(scope))
  if (missing.length > 0) {
    throw forbidden(
      'ApiScopeInsufficient',
      `Credential is missing required scope: ${missing.join(', ')}.`,
    )
  }
}

function readFutureTimestamp(value: string, now: Date, label: string) {
  const timestamp = readTimestamp(value, label)
  if (Date.parse(timestamp) <= now.getTime()) {
    throw invalid('DeveloperExpiryInvalid', `${label} must be in the future.`)
  }
  return timestamp
}

function readTimestamp(value: string, label: string) {
  const normalized = requireText(value, label)
  const milliseconds = Date.parse(normalized)
  if (!Number.isFinite(milliseconds)) {
    throw invalid('DeveloperTimestampInvalid', `${label} is invalid.`)
  }
  return new Date(milliseconds).toISOString()
}

function toEpochSeconds(timestamp: string) {
  return Math.floor(Date.parse(timestamp) / 1_000)
}

function readPositiveInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw invalid(
      'DeveloperNumberInvalid',
      `${label} must be a positive integer no greater than ${maximum}.`,
    )
  }
  return value
}

function readBoundedLimit(value: number, maximum: number, label: string) {
  return readPositiveInteger(value, label, maximum)
}

function encodeActiveWebhookSubscriptionCursor(
  cursor: ActiveWebhookSubscriptionCursor,
) {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeActiveWebhookSubscriptionCursor(
  value: string,
  expectedWorkspaceId: string,
): ActiveWebhookSubscriptionCursor {
  try {
    const encoded = requireText(value, 'Webhook subscription cursor')
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as unknown
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      parsed.workspaceId !== expectedWorkspaceId ||
      Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url') !== encoded
    ) throw new Error('invalid')
    if (
      parsed.phase === 'primary' &&
      (
        parsed.recordKey === undefined ||
        (
          typeof parsed.recordKey === 'string' &&
          parsed.recordKey.startsWith(
            createActiveWebhookSubscriptionRecordKeyPrefix(),
          )
        )
      )
    ) {
      return {
        version: 1,
        phase: 'primary',
        workspaceId: expectedWorkspaceId,
        ...(typeof parsed.recordKey === 'string'
          ? { recordKey: parsed.recordKey }
          : {}),
      }
    }
    const lookupKey = createActiveWebhookSubscriptionLookupKey(expectedWorkspaceId)
    if (
      parsed.phase !== 'legacy' ||
      parsed.lookupKey !== lookupKey ||
      (
        parsed.locator !== undefined &&
        (
          !isRecord(parsed.locator) ||
          parsed.locator.workspaceId !== expectedWorkspaceId ||
          typeof parsed.locator.recordKey !== 'string' ||
          parsed.locator.lookupKey !== lookupKey ||
          typeof parsed.locator.lookupSortKey !== 'string'
        )
      )
    ) throw new Error('invalid')
    return {
      version: 1,
      phase: 'legacy',
      workspaceId: expectedWorkspaceId,
      lookupKey,
      ...(parsed.locator
        ? {
            locator: {
              workspaceId: expectedWorkspaceId,
              recordKey: parsed.locator.recordKey,
              lookupKey,
              lookupSortKey: parsed.locator.lookupSortKey,
            },
          }
        : {}),
    }
  } catch {
    throw invalid(
      'DeveloperCursorInvalid',
      'Webhook subscription cursor is invalid.',
    )
  }
}

function encodeInternalRecordCursor(recordKey: string) {
  return Buffer.from(recordKey, 'utf8').toString('base64url')
}

function decodeInternalRecordCursor(
  value: string,
  expectedPrefix: string,
  label: string,
) {
  try {
    const encoded = requireText(value, label)
    const recordKey = Buffer.from(encoded, 'base64url').toString('utf8')
    if (
      !recordKey.startsWith(expectedPrefix) ||
      Buffer.from(recordKey, 'utf8').toString('base64url') !== encoded
    ) throw new Error('invalid')
    return recordKey
  } catch {
    throw invalid('DeveloperCursorInvalid', `${label} is invalid.`)
  }
}

async function mapWithConcurrency<TInput, TOutput>(
  values: readonly TInput[],
  concurrency: number,
  mapper: (value: TInput, index: number) => Promise<TOutput>,
) {
  const results: TOutput[] = []
  let nextIndex = 0
  const workerCount = Math.min(
    values.length,
    Math.max(1, Math.floor(concurrency)),
  )
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(values[index]!, index)
    }
  }))
  return results
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}

function readHttpStatus(value: number) {
  if (!Number.isSafeInteger(value) || value < 100 || value > 599) {
    throw invalid('WebhookResponseStatusInvalid', 'Webhook response status is invalid.')
  }
  return value
}

function readHttpsUrl(value: string, label: string) {
  const normalized = requireText(value, label)
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw invalid('DeveloperUrlInvalid', `${label} is invalid.`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !url.hostname ||
    normalized.length > 2_048
  ) {
    throw invalid(
      'DeveloperUrlInvalid',
      `${label} must be an HTTPS URL without embedded credentials.`,
    )
  }
  return url.toString()
}

function readOAuthGrantTypes(values: OAuthAppSummary['grantTypes']) {
  if (!Array.isArray(values) || values.length === 0) {
    throw invalid('OAuthGrantTypesInvalid', 'At least one OAuth grant type is required.')
  }
  const allowed = new Set(['client_credentials'])
  const grantTypes: OAuthAppSummary['grantTypes'] = []
  for (const value of values) {
    if (!allowed.has(value)) {
      throw invalid('OAuthGrantTypesInvalid', `OAuth grant type "${String(value)}" is invalid.`)
    }
    if (!grantTypes.includes(value)) grantTypes.push(value)
  }
  return grantTypes.sort()
}

function readEventTypes(values: WebhookSubscription['eventTypes']) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    throw invalid('WebhookEventTypesInvalid', 'At least one Webhook event type is required.')
  }
  const allowed = new Set<WebhookSubscription['eventTypes'][number]>([
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
  const eventTypes: WebhookSubscription['eventTypes'] = []
  for (const value of values) {
    if (!allowed.has(value)) {
      throw invalid('WebhookEventTypeInvalid', `Webhook event type "${String(value)}" is invalid.`)
    }
    if (!eventTypes.includes(value)) eventTypes.push(value)
  }
  return eventTypes.sort()
}

function assertWebhookEventScopes(
  eventTypes: readonly WebhookSubscription['eventTypes'][number][],
  scopes: readonly ApiScope[],
) {
  const requiredScopes = new Set<ApiScope>()
  for (const eventType of eventTypes) {
    if (eventType.startsWith('work-item.')) {
      requiredScopes.add('work-items:read')
    } else if (
      eventType.startsWith('external-link.') ||
      eventType.startsWith('sync-conflict.')
    ) {
      requiredScopes.add('integrations:read')
    } else if (eventType.startsWith('import.')) {
      requiredScopes.add('imports:read')
    }
  }
  const missingScopes = [...requiredScopes].filter((scope) => !scopes.includes(scope))
  if (missingScopes.length > 0) {
    throw invalid(
      'WebhookEventScopeInvalid',
      `Webhook event types require scope: ${missingScopes.sort().join(', ')}.`,
    )
  }
}

function eventTypeMatches(pattern: string, eventType: string) {
  return pattern === eventType
}

function readWebhookEvent(
  event: WebhookEventEnvelope,
  expectedWorkspaceId: string,
) {
  if (!isRecord(event)) {
    throw invalid('WebhookEventInvalid', 'Webhook event must be an object.')
  }
  const id = readIdentifier(event.id, 'Webhook event ID')
  const type = readEventTypes([event.type])[0]!
  if (event.apiVersion !== '2026-07-01') {
    throw invalid('WebhookApiVersionInvalid', 'Webhook API version is invalid.')
  }
  const apiVersion = event.apiVersion
  const occurredAt = readTimestamp(event.occurredAt, 'Webhook event occurrence')
  const workspaceId = readIdentifier(event.workspaceId, 'Webhook event Workspace ID')
  if (workspaceId !== expectedWorkspaceId) {
    throw forbidden(
      'WebhookWorkspaceMismatch',
      'Webhook event belongs to another Workspace.',
    )
  }
  const data = cloneJsonValue(event.data)
  return {
    id,
    type,
    apiVersion,
    occurredAt,
    workspaceId,
    data,
  } satisfies WebhookEventEnvelope
}

function readWebhookEventTeamId(event: WebhookEventEnvelope) {
  if (
    !isRecord(event.data) ||
    !isRecord(event.data.metadata) ||
    event.data.metadata.teamId === undefined
  ) {
    throw invalid(
      'WebhookEventTeamScopeMissing',
      'Webhook event metadata must contain its Team ID.',
    )
  }
  return readIdentifier(
    event.data.metadata.teamId as string,
    'Webhook event Team ID',
  )
}

function readWebhookSubscriptionStatus(value: WebhookSubscription['status']) {
  if (value === 'active' || value === 'paused' || value === 'disabled') return value
  throw invalid('WebhookSubscriptionStatusInvalid', 'Webhook subscription status is invalid.')
}

function readWebhookDeliveryStatus(value: WebhookDelivery['status']) {
  if (
    value === 'pending' ||
    value === 'retrying' ||
    value === 'delivered' ||
    value === 'failed'
  ) return value
  throw invalid('WebhookDeliveryStatusInvalid', 'Webhook delivery status is invalid.')
}

function readConnectorCategory(value: ConnectorInstallation['category']) {
  if (
    value === 'source-control' ||
    value === 'chat' ||
    value === 'email' ||
    value === 'calendar' ||
    value === 'cloud-storage'
  ) return value
  throw invalid('ConnectorCategoryInvalid', 'Connector category is invalid.')
}

function readConnectorStatus(value: ConnectorInstallation['status']) {
  if (
    value === 'connected' ||
    value === 'needs-reauth' ||
    value === 'degraded' ||
    value === 'disconnected' ||
    value === 'conflict'
  ) return value
  throw invalid('ConnectorStatusInvalid', 'Connector status is invalid.')
}

function readConnectorCredentialReplacementReason(
  value: NonNullable<RecoverConnectorRequest['reason']>,
) {
  if (
    value === 'reauthorization' ||
    value === 'refresh' ||
    value === 'recovery'
  ) return value
  throw invalid(
    'ConnectorCredentialReplacementReasonInvalid',
    'Connector credential replacement reason is invalid.',
  )
}

function sanitizeConnectorProblem(value: unknown): NonNullable<
  ConnectorInstallation['lastError']
> {
  if (!isRecord(value)) {
    throw invalid('ConnectorProblemInvalid', 'Connector error must be an object.')
  }
  const status = readHttpStatus(value.status as number)
  const code = readApiProblemCode(value.code)
  if (typeof value.retryable !== 'boolean') {
    throw invalid('ConnectorProblemInvalid', 'Connector retryable flag is invalid.')
  }
  const descriptor = describeConnectorProblem(code, status, value.retryable)
  return {
    type: `https://docs.mukuroji.app/problems/${code}`,
    title: descriptor.title,
    status,
    code,
    detail: descriptor.detail,
    requestId: 'provider-error',
    retryable: value.retryable,
  }
}

function readApiProblemCode(value: unknown): NonNullable<
  ConnectorInstallation['lastError']
>['code'] {
  if (
    value === 'invalid_request' ||
    value === 'authentication_required' ||
    value === 'invalid_credentials' ||
    value === 'insufficient_scope' ||
    value === 'forbidden' ||
    value === 'not_found' ||
    value === 'conflict' ||
    value === 'idempotency_conflict' ||
    value === 'validation_failed' ||
    value === 'rate_limited' ||
    value === 'temporarily_unavailable' ||
    value === 'internal_error'
  ) {
    return value
  }
  throw invalid('ConnectorProblemInvalid', 'Connector error code is invalid.')
}

function describeConnectorProblem(
  code: NonNullable<ConnectorInstallation['lastError']>['code'],
  status: number,
  retryable: boolean,
) {
  if (code === 'rate_limited' || status === 429) {
    return {
      title: 'Provider rate limit reached',
      detail: 'The provider request can be retried after its rate limit resets.',
    }
  }
  if (
    code === 'authentication_required' ||
    code === 'invalid_credentials' ||
    status === 401
  ) {
    return {
      title: 'Provider authorization required',
      detail: 'Reconnect the provider before retrying this operation.',
    }
  }
  if (retryable || code === 'temporarily_unavailable' || status >= 500) {
    return {
      title: 'Provider temporarily unavailable',
      detail: 'The provider request could not be completed and may be retried.',
    }
  }
  return {
    title: 'Provider request failed',
    detail: 'The provider rejected the request.',
  }
}

function connectorProviderMatchesCategory(
  provider: ConnectorInstallation['provider'],
  category: ConnectorInstallation['category'],
) {
  const categories: Record<
    ConnectorInstallation['provider'],
    ConnectorInstallation['category']
  > = {
    github: 'source-control',
    gitlab: 'source-control',
    slack: 'chat',
    'microsoft-teams': 'chat',
    gmail: 'email',
    outlook: 'email',
    'google-calendar': 'calendar',
    'outlook-calendar': 'calendar',
    'google-drive': 'cloud-storage',
    onedrive: 'cloud-storage',
    dropbox: 'cloud-storage',
  }
  return categories[provider] === category
}

function readExternalResourceType(value: ExternalWorkItemLink['resourceType']) {
  if (
    value === 'issue' ||
    value === 'merge-request' ||
    value === 'commit' ||
    value === 'deploy'
  ) return value
  throw invalid('ExternalResourceTypeInvalid', 'External resource type is invalid.')
}

function readExternalSyncDirection(value: ExternalWorkItemLink['syncDirection']) {
  if (
    value === 'inbound' ||
    value === 'outbound' ||
    value === 'bidirectional' ||
    value === 'none'
  ) return value
  throw invalid('ExternalSyncDirectionInvalid', 'External sync direction is invalid.')
}

function readImportFormat(value: ImportJob['format']) {
  if (value === 'csv' || value === 'json') return value
  throw invalid('ImportFormatInvalid', 'Import format is invalid.')
}

function readImportMapping(value: ImportJob['mapping']) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    throw invalid('ImportMappingInvalid', 'Import mapping must be a non-empty array.')
  }
  const seenTargets = new Set<string>()
  const mapping = value.map((field) => {
    if (!isRecord(field)) {
      throw invalid('ImportMappingInvalid', 'Import mapping field is invalid.')
    }
    const sourceField = readName(field.sourceField as string, 'Import source field')
    const targetField = readName(field.targetField as string, 'Import target field')
    if (seenTargets.has(targetField)) {
      throw invalid(
        'ImportMappingInvalid',
        `Import target field "${targetField}" is mapped more than once.`,
      )
    }
    seenTargets.add(targetField)
    const transform = field.transform
    if (
      transform !== undefined &&
      transform !== 'none' &&
      transform !== 'trim' &&
      transform !== 'lowercase' &&
      transform !== 'uppercase' &&
      transform !== 'parse-date' &&
      transform !== 'parse-number' &&
      transform !== 'split-comma'
    ) {
      throw invalid('ImportMappingInvalid', 'Import mapping transform is invalid.')
    }
    if (field.required !== undefined && typeof field.required !== 'boolean') {
      throw invalid('ImportMappingInvalid', 'Import mapping required flag is invalid.')
    }
    return cloneJsonValue({
      sourceField,
      targetField,
      ...(transform === undefined ? {} : { transform }),
      ...(field.required === undefined ? {} : { required: field.required }),
      ...(field.defaultValue === undefined
        ? {}
        : { defaultValue: cloneJsonValue(field.defaultValue) }),
    })
  })
  return mapping as ImportJob['mapping']
}

function readImportJobStatus(value: ImportJob['status']) {
  if (
    value === 'queued' ||
    value === 'validating' ||
    value === 'running' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  ) return value
  throw invalid('ImportJobStatusInvalid', 'Import job status is invalid.')
}

function assertImportJobStorable(job: ImportJob) {
  if (Buffer.byteLength(JSON.stringify(job), 'utf8') > 128 * 1024) {
    throw new DeveloperPlatformError(
      413,
      'ImportJobTooLarge',
      'Import job metadata exceeds the safe persistence limit.',
    )
  }
}

function assertImportTransition(
  current: ImportJob['status'],
  next: ImportJob['status'],
) {
  if (current === next) return
  const transitions: Record<ImportJob['status'], readonly ImportJob['status'][]> = {
    queued: ['validating', 'running', 'failed', 'cancelled'],
    validating: ['running', 'completed', 'failed', 'cancelled'],
    running: ['completed', 'failed', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  }
  if (!transitions[current].includes(next)) {
    throw conflict(
      'ImportJobTransitionInvalid',
      `Import job cannot transition from ${current} to ${next}.`,
    )
  }
}

function readIdempotencyKey(value: string) {
  const normalized = requireText(value, 'Idempotency key')
  if (normalized.length > 256 || containsControlCharacter(normalized)) {
    throw invalid('IdempotencyKeyInvalid', 'Idempotency key is invalid.')
  }
  return normalized
}

function normalizeCredentialStatus<
  T extends {
    status: 'active' | 'expired' | 'revoked'
    expiresAt?: string
  },
>(credential: T, now: Date): T {
  if (
    credential.status === 'active' &&
    credential.expiresAt &&
    Date.parse(credential.expiresAt) <= now.getTime()
  ) {
    return { ...credential, status: 'expired' } as T
  }
  return credential
}

function readRecordValue<T>(
  record: DeveloperPlatformRecord,
  expectedEntryType: DeveloperPlatformEntryType,
) {
  if (
    record.entryType !== expectedEntryType ||
    record.value === null ||
    record.value === undefined
  ) {
    throw persistenceInvalid(`Developer ${expectedEntryType} row is invalid.`)
  }
  return record.value as T
}

function readStoredRecord(value: Record<string, unknown>) {
  if (
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    typeof value.entryType !== 'string' ||
    !isDeveloperPlatformEntryType(value.entryType) ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) <= 0 ||
    value.value === undefined ||
    !isOptionalSha256Digest(value.connectorCredentialDigest) ||
    !isOptionalSha256Digest(value.connectorCredentialRefreshClaimDigest) ||
    !isOptionalTimestamp(value.connectorCredentialRefreshClaimedAt) ||
    (
      (value.connectorCredentialRefreshClaimDigest === undefined) !==
      (value.connectorCredentialRefreshClaimedAt === undefined)
    ) ||
    !isOptionalSha256Digest(value.connectorOAuthStateDigest) ||
    !isOptionalNonNegativeInteger(value.connectorCredentialRevision) ||
    !isOptionalNonNegativeInteger(value.connectorOAuthStateRevision) ||
    !isOptionalPositiveInteger(value.connectorDisconnectCleanupRevision) ||
    (
      value.connectorDisconnectCleanupRevision !== undefined &&
      value.entryType !== 'connector-installation'
    ) ||
    !isOptionalNonNegativeInteger(value.activeLinkCount) ||
    !isOptionalNonNegativeInteger(value.subscriptionCount) ||
    !isOptionalNonNegativeInteger(value.externalLinkCount) ||
    !isOptionalNonNegativeInteger(value.pollableLinkCount)
  ) {
    throw persistenceInvalid('Developer platform row is invalid.')
  }
  return value as DeveloperPlatformRecord
}

function readStoredWebhookActiveLocatorMigrationState(
  value: Record<string, unknown> | undefined,
): WebhookActiveLocatorMigrationState {
  if (value === undefined) return 'pending'
  const storedValue = value.value
  if (
    value.workspaceId !== WEBHOOK_ACTIVE_LOCATOR_MIGRATION_WORKSPACE_ID ||
    value.recordKey !== WEBHOOK_ACTIVE_LOCATOR_MIGRATION_RECORD_KEY ||
    value.entryType !== WEBHOOK_ACTIVE_LOCATOR_MIGRATION_ENTRY_TYPE ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    !isRecord(storedValue) ||
    storedValue.migrationVersion !== 'v3' ||
    (
      storedValue.state !== 'cutover' &&
      storedValue.state !== 'complete' &&
      storedValue.state !== 'rollback'
    )
  ) {
    throw persistenceInvalid(
      'Webhook active locator migration row is invalid.',
    )
  }
  return storedValue.state === 'rollback'
    ? 'pending'
    : storedValue.state
}

function isOptionalSha256Digest(value: unknown) {
  return value === undefined ||
    (typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))
}

function isOptionalTimestamp(value: unknown) {
  return value === undefined ||
    (
      typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value
    )
}

function isOptionalNonNegativeInteger(value: unknown) {
  return value === undefined ||
    (Number.isSafeInteger(value) && Number(value) >= 0)
}

function isOptionalPositiveInteger(value: unknown) {
  return value === undefined ||
    (Number.isSafeInteger(value) && Number(value) > 0)
}

function readWorkItemLinkFenceCount(
  record: DeveloperPlatformRecord | undefined,
) {
  if (record === undefined) return 0
  if (
    record.entryType !== 'work-item-link-fence' ||
    !Number.isSafeInteger(record.activeLinkCount) ||
    Number(record.activeLinkCount) < 0
  ) {
    throw persistenceInvalid('Work Item external-link fence is invalid.')
  }
  return Number(record.activeLinkCount)
}

function isRecordExpired(record: DeveloperPlatformRecord, now: Date) {
  return record.expiresAt !== undefined &&
    record.expiresAt <= Math.floor(now.getTime() / 1_000)
}

function readStoredRecordLocator(
  value: Record<string, unknown>,
  expectedLookupKey: string,
): DeveloperPlatformRecordLocator {
  if (
    typeof value.workspaceId !== 'string' ||
    typeof value.recordKey !== 'string' ||
    value.lookupKey !== expectedLookupKey ||
    typeof value.lookupSortKey !== 'string'
  ) {
    throw persistenceInvalid('Developer platform lookup locator is invalid.')
  }
  return {
    workspaceId: value.workspaceId,
    recordKey: value.recordKey,
    lookupKey: expectedLookupKey,
    lookupSortKey: value.lookupSortKey,
  }
}

function isDeveloperPlatformEntryType(value: string): value is DeveloperPlatformEntryType {
  return value === 'api-key' ||
    value === 'credential-auth' ||
    value === 'oauth-app' ||
    value === 'oauth-token' ||
    value === 'webhook-subscription' ||
    value === 'webhook-active-subscription' ||
    value === 'webhook-subscription-quota' ||
    value === 'webhook-delivery' ||
    value === 'webhook-delivery-index' ||
    value === 'connector-installation' ||
    value === 'connector-poll-target' ||
    value === 'external-link' ||
    value === 'external-link-index' ||
    value === 'external-link-claim' ||
    value === 'work-item-link-fence' ||
    value === 'import-job' ||
    value === 'idempotency' ||
    value === 'rate-limit'
}

function sortByCreatedAt<T extends { createdAt: string }>(values: readonly T[]) {
  return [...values].sort(compareCreatedAtDescending)
}

function compareCreatedAtDescending(
  left: { createdAt: string; id?: string },
  right: { createdAt: string; id?: string },
) {
  return right.createdAt.localeCompare(left.createdAt) ||
    String(right.id ?? '').localeCompare(String(left.id ?? ''))
}

function stableJson(value: unknown) {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  )
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function cloneJsonValue(value: unknown) {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) {
      throw new Error('JSON value is undefined.')
    }
    return JSON.parse(encoded) as unknown
  } catch (error) {
    throw invalid('DeveloperJsonInvalid', 'Value must be JSON serializable.', error)
  }
}

function estimateStoredRecordBytes(record: DeveloperPlatformRecord) {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNamedError(error: unknown, name: string) {
  return error instanceof Error && error.name === name
}

function isTransactionConditionFailure(error: unknown) {
  if (!isNamedError(error, 'TransactionCanceledException')) return false
  if (!isRecord(error)) return true
  const reasons = error.CancellationReasons
  return !Array.isArray(reasons) ||
    reasons.some((reason) => isRecord(reason) && reason.Code === 'ConditionalCheckFailed')
}

function createDeveloperPlatformDocumentClient() {
  const endpoint = process.env.DYNAMODB_ENDPOINT ??
    process.env.AWS_ENDPOINT_URL_DYNAMODB ??
    process.env.AWS_ENDPOINT_URL
  const client = new DynamoDBClient({
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-northeast-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
  return DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  })
}

function readKmsEnvelopePurpose(context: string): KmsEnvelopePurpose {
  if (context.startsWith('mukuroji:webhook:')) return 'webhook'
  if (context.startsWith('mukuroji:connector:')) return 'connector'
  if (
    context.startsWith('mukuroji:idempotency-response:') ||
    context.startsWith('mukuroji:platform-state:') ||
    context === WEBHOOK_CURSOR_CONTEXT
  ) {
    return 'platform-state'
  }
  throw new DeveloperPlatformError(
    500,
    'SecretProtectionPurposeInvalid',
    'Secret protection context has no configured purpose.',
  )
}

function readKmsKeyId(keyIds: KmsEnvelopeKeyIds, purpose: KmsEnvelopePurpose) {
  const keyId = purpose === 'webhook'
    ? keyIds.webhook
    : purpose === 'connector'
      ? keyIds.connector
      : keyIds.platformState
  if (!keyId) {
    throw new DeveloperPlatformError(
      500,
      'SecretProtectorKmsKeyMissing',
      `KMS key ID for ${purpose} secret protection is required.`,
    )
  }
  return keyId
}

function createKmsEncryptionContext(
  purpose: KmsEnvelopePurpose,
  context: string,
) {
  return {
    'mukuroji:service': 'developer-platform',
    'mukuroji:purpose': purpose,
    'mukuroji:context-digest': digestText(`kms-envelope-context-v1\0${context}`),
  }
}

function createKmsEnvelopeAad(
  purpose: KmsEnvelopePurpose,
  keyId: string,
  context: string,
) {
  return `mukuroji:kms-envelope:v1\0${purpose}\0${keyId}\0${context}`
}

function createDefaultKmsEnvelopeClient(): KmsEnvelopeClient {
  let loadedSdk: Promise<{
    client: { send(command: unknown): Promise<Record<string, unknown>> }
    sdk: Record<string, new (input: Record<string, unknown>) => unknown>
  }> | undefined
  const loadSdk = async () => {
    loadedSdk ??= (async () => {
      const packageName = ['@aws-sdk', 'client-kms'].join('/')
      const sdk = await import(packageName) as Record<string, unknown>
      const KmsClient = sdk.KMSClient
      if (typeof KmsClient !== 'function') throw new Error('AWS KMS client is unavailable.')
      const client = new (
        KmsClient as new (input: Record<string, unknown>) => {
          send(command: unknown): Promise<Record<string, unknown>>
        }
      )({})
      return {
        client,
        sdk: sdk as Record<string, new (input: Record<string, unknown>) => unknown>,
      }
    })()
    return loadedSdk
  }
  return {
    async generateDataKey(request) {
      const { client, sdk } = await loadSdk()
      const Command = sdk.GenerateDataKeyCommand
      if (typeof Command !== 'function') throw new Error('GenerateDataKey is unavailable.')
      const response = await client.send(new Command({
        KeyId: request.keyId,
        KeySpec: 'AES_256',
        EncryptionContext: request.encryptionContext,
      }))
      if (
        !(response.Plaintext instanceof Uint8Array) ||
        !(response.CiphertextBlob instanceof Uint8Array)
      ) {
        throw new Error('GenerateDataKey returned incomplete key material.')
      }
      return {
        plaintext: response.Plaintext,
        ciphertextBlob: response.CiphertextBlob,
      }
    },
    async decrypt(request) {
      const { client, sdk } = await loadSdk()
      const Command = sdk.DecryptCommand
      if (typeof Command !== 'function') throw new Error('Decrypt is unavailable.')
      const response = await client.send(new Command({
        KeyId: request.keyId,
        CiphertextBlob: request.ciphertextBlob,
        EncryptionContext: request.encryptionContext,
      }))
      if (!(response.Plaintext instanceof Uint8Array)) {
        throw new Error('Decrypt returned no plaintext key.')
      }
      return { plaintext: response.Plaintext }
    },
  }
}

/** Environment に応じて local AES または production KMS envelope protector を作成します。 */
export function createDefaultSecretProtector() {
  const configuredRawKey = process.env.DEVELOPER_PLATFORM_SECRET_PROTECTOR_KEY?.trim()
  const keyIds = {
    webhook: process.env.DEVELOPER_PLATFORM_WEBHOOK_KMS_KEY_ID?.trim(),
    connector: process.env.DEVELOPER_PLATFORM_CONNECTOR_KMS_KEY_ID?.trim(),
    platformState: process.env.DEVELOPER_PLATFORM_STATE_KMS_KEY_ID?.trim(),
  }
  const production = process.env.NODE_ENV === 'production' ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    Boolean(process.env.AWS_EXECUTION_ENV)
  if (production && configuredRawKey) {
    throw new DeveloperPlatformError(
      500,
      'RawSecretProtectorKeyForbidden',
      'Raw developer platform secret protector keys are forbidden in production.',
    )
  }
  if (production || Object.values(keyIds).some(Boolean)) {
    return new KmsEnvelopeSecretProtector(
      createDefaultKmsEnvelopeClient(),
      {
        ...(keyIds.webhook ? { webhook: keyIds.webhook } : {}),
        ...(keyIds.connector ? { connector: keyIds.connector } : {}),
        ...(keyIds.platformState ? { platformState: keyIds.platformState } : {}),
      },
    )
  }
  if (configuredRawKey) return new LocalAesGcmSecretProtector(configuredRawKey)
  return new LocalAesGcmSecretProtector(
    'mukuroji-local-developer-platform-secret-protector-key',
  )
}

function invalid(
  code: string,
  message: string,
  cause?: unknown,
) {
  return new DeveloperPlatformError(
    400,
    code,
    message,
    cause === undefined ? undefined : { cause },
  )
}

function unauthorized(code: string, message: string) {
  return new DeveloperPlatformError(401, code, message)
}

function forbidden(code: string, message: string) {
  return new DeveloperPlatformError(403, code, message)
}

function notFound(code: string, message: string) {
  return new DeveloperPlatformError(404, code, message)
}

function conflict(code: string, message: string) {
  return new DeveloperPlatformError(409, code, message)
}

function externalLinkDeletionConflict() {
  return conflict(
    'ExternalWorkItemLinkSyncConflict',
    'Resolve or ignore the synchronization conflict before deleting this external link.',
  )
}

function persistenceConflict() {
  return new DeveloperPlatformError(
    409,
    'DeveloperPlatformConcurrentMutation',
    'Developer platform resource changed. Reload and try again.',
  )
}

function persistenceInvalid(message: string) {
  return new DeveloperPlatformError(503, 'DeveloperPlatformDataInvalid', message)
}

function toPersistenceError(error: unknown) {
  if (error instanceof DeveloperPlatformError) return error
  return new DeveloperPlatformError(
    503,
    'DeveloperPlatformUnavailable',
    'Developer platform storage is unavailable.',
    { cause: error },
  )
}
