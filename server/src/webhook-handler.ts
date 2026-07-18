import { randomUUID } from 'node:crypto'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import type { WebhookDelivery, WebhookEventEnvelope, WebhookEventType } from '@mukuroji/contracts'
import { toAuditEventView, upcastAuditEvent } from './audit'
import {
  DeveloperPlatformError,
  DynamoDbDeveloperPlatformClient,
  WEBHOOK_MAX_ATTEMPTS,
  type DeveloperPlatformClient,
  type PreparedWebhookDelivery,
} from './developer-platform'
import {
  UnsafeWebhookUrlError,
  createWebhookRetryDelaySeconds,
  deliverWebhookRequest,
  type WebhookRequestResult,
} from './webhook-delivery'
import {
  DynamoDbWebhookSubscriptionAuthorizer,
  type WebhookSubscriptionAuthorizer,
} from './webhook-authorization'

/** SQS が1 message に設定できる最大 delay 秒です。 */
export const WEBHOOK_QUEUE_MAX_DELAY_SECONDS = 15 * 60

/** Webhook HTTP attempt を単一 worker に束縛する lease 秒数です。 */
export const WEBHOOK_DELIVERY_LEASE_SECONDS = 90

/** DynamoDB Streams image に含まれる AttributeValue の必要最小表現です。 */
export type WebhookDynamoAttributeValue = {
  /** 文字列値です。 */
  S?: string
  /** 数値を表す文字列値です。 */
  N?: string
  /** 真偽値です。 */
  BOOL?: boolean
  /** Null marker です。 */
  NULL?: boolean
  /** List value です。 */
  L?: WebhookDynamoAttributeValue[]
  /** Map value です。 */
  M?: Record<string, WebhookDynamoAttributeValue>
  /** String set です。 */
  SS?: string[]
  /** Number set です。 */
  NS?: string[]
}

/** AuditEventsTable stream の1 record です。 */
export type WebhookDynamoStreamRecord = {
  /** INSERT、MODIFY、REMOVE の event 種別です。 */
  eventName?: string
  /** DynamoDB stream item image と sequence number です。 */
  dynamodb?: {
    /** Mutation 後の item です。 */
    NewImage?: Record<string, WebhookDynamoAttributeValue>
    /** Partial batch failure の checkpoint ID です。 */
    SequenceNumber?: string
  }
}

/** AuditEventsTable stream Lambda event です。 */
export type WebhookDynamoStreamEvent = {
  /** 同じ batch で配送された stream records です。 */
  Records?: WebhookDynamoStreamRecord[]
}

/** Lambda partial batch response の1 failure です。 */
export type WebhookBatchItemFailure = {
  /** 再試行する stream sequence number または SQS message ID です。 */
  itemIdentifier: string
}

/** DynamoDB Streams と SQS が共有する partial batch response です。 */
export type WebhookBatchResponse = {
  /** 再試行する records です。 */
  batchItemFailures: WebhookBatchItemFailure[]
}

/** Webhook delivery queue に載せる secret-free message です。 */
export type WebhookQueueMessage = {
  /** Delivery が属する Workspace ID です。 */
  workspaceId: string
  /** 永続化済み Webhook delivery ID です。 */
  deliveryId: string
  /** SQS へ設定する delay 秒です。 */
  delaySeconds?: number
}

/** Webhook delivery queue への書き込み境界です。 */
export interface WebhookDeliveryQueue {
  /** Secret を含まない delivery locator を enqueue します。 */
  enqueue(message: WebhookQueueMessage): Promise<void>
}

/** Webhook delivery の durable claim 入力です。 */
export type WebhookDeliveryClaimRequest = {
  /** Delivery が属する Workspace ID です。 */
  workspaceId: string
  /** Claim 対象の delivery ID です。 */
  deliveryId: string
  /** Claim owner を一意に識別する token です。 */
  leaseOwner: string
  /** Claim 判定時刻です。 */
  now: string
  /** Claim の失効日時です。 */
  leaseExpiresAt: string
}

/** 同じ delivery ID の並行 HTTP attempt を直列化する永続化境界です。 */
export interface WebhookDeliveryClaimStore {
  /** Claim を取得できた worker だけ true を返します。 */
  tryClaim(request: WebhookDeliveryClaimRequest): Promise<boolean>
  /** Current claim owner だけが claim を解放します。 */
  release(request: WebhookDeliveryClaimRequest): Promise<void>
}

/** Audit stream projection の注入可能 dependencies です。 */
export type WebhookProjectionDependencies = {
  /** Subscription と delivery log の永続化境界です。 */
  developerPlatform: DeveloperPlatformClient
  /** Subscription 作成者の current Team ACL を検証します。 */
  authorizer: WebhookSubscriptionAuthorizer
  /** HTTP worker へ delivery locator を渡す queue です。 */
  queue: WebhookDeliveryQueue
}

/** Webhook HTTP worker の注入可能 dependencies です。 */
export type WebhookDeliveryWorkerDependencies = {
  /** Subscription と delivery log の永続化境界です。 */
  developerPlatform: DeveloperPlatformClient
  /** Retry/replay 時にも subscription 作成者の current ACL を再検証します。 */
  authorizer: WebhookSubscriptionAuthorizer
  /** HTTP worker へ delivery locator を渡す queue です。 */
  queue: WebhookDeliveryQueue
  /** Delivery ID ごとの durable HTTP attempt claim です。 */
  claims: WebhookDeliveryClaimStore
  /** 署名付き HTTP request を1回だけ実行します。 */
  deliver(prepared: PreparedWebhookDelivery): Promise<WebhookRequestResult>
  /** Retry schedule と署名時刻を決める clock です。 */
  now(): Date
  /** Full-jitter retry delay に利用する乱数源です。 */
  random(): number
}

/** SQS Lambda event の1 record です。 */
export type WebhookSqsRecord = {
  /** Partial batch failure で返す SQS message ID です。 */
  messageId?: string
  /** JSON serialized `WebhookQueueMessage` です。 */
  body?: string
}

/** SQS Lambda event の最小表現です。 */
export type WebhookSqsEvent = {
  /** 同じ batch に含まれる queue records です。 */
  Records?: WebhookSqsRecord[]
}

let defaultDeveloperPlatform: DeveloperPlatformClient | undefined
let defaultWebhookAuthorizer: WebhookSubscriptionAuthorizer | undefined
let defaultQueue: WebhookDeliveryQueue | undefined
let defaultSqsClient: SQSClient | undefined
let defaultWebhookDeliveryClaimStore: WebhookDeliveryClaimStore | undefined

/**
 * AuditEventsTable の pending insert を versioned webhook envelope へ射影します。
 *
 * @remarks
 * Delivery ID は domain 側で subscription/event ごとに決定的に作られるため、stream retry で
 * 同じ delivery log が重複作成されません。SQS message には secret や payload を含めません。
 */
export async function projectionHandler(
  event: WebhookDynamoStreamEvent,
): Promise<WebhookBatchResponse> {
  return await processWebhookProjectionBatch(event, {
    developerPlatform: getDefaultDeveloperPlatform(),
    authorizer: getDefaultWebhookAuthorizer(),
    queue: getDefaultWebhookQueue(),
  })
}

/** Audit stream batch を処理して record 単位の retry response を返します。 */
export async function processWebhookProjectionBatch(
  event: WebhookDynamoStreamEvent,
  dependencies: WebhookProjectionDependencies,
): Promise<WebhookBatchResponse> {
  const batchDependencies = {
    ...dependencies,
    authorizer: dependencies.authorizer.createBatch?.() ?? dependencies.authorizer,
  }
  const results = await Promise.all((event.Records ?? []).map(async (record) => {
    try {
      await projectAuditRecord(record, batchDependencies)
      return undefined
    } catch (error) {
      console.error('Webhook projection failed:', readSafeErrorMessage(error))
      return createDynamoBatchFailure(record)
    }
  }))
  return { batchItemFailures: results.filter(isDefined) }
}

/** SQS delivery batch を処理し、失敗した message だけを再試行します。 */
export async function deliveryHandler(event: WebhookSqsEvent): Promise<WebhookBatchResponse> {
  return await processWebhookDeliveryBatch(event, {
    developerPlatform: getDefaultDeveloperPlatform(),
    authorizer: getDefaultWebhookAuthorizer(),
    queue: getDefaultWebhookQueue(),
    claims: getDefaultWebhookDeliveryClaimStore(),
    deliver: deliverPreparedWebhook,
    now: () => new Date(),
    random: Math.random,
  })
}

/** Webhook queue batch を配信し、message 単位の retry response を返します。 */
export async function processWebhookDeliveryBatch(
  event: WebhookSqsEvent,
  dependencies: WebhookDeliveryWorkerDependencies,
): Promise<WebhookBatchResponse> {
  const batchDependencies = {
    ...dependencies,
    authorizer: dependencies.authorizer.createBatch?.() ?? dependencies.authorizer,
  }
  const results = await Promise.all((event.Records ?? []).map(async (record) => {
    try {
      await processWebhookQueueRecord(record, batchDependencies)
      return undefined
    } catch (error) {
      console.error('Webhook delivery failed:', readSafeErrorMessage(error))
      return createSqsBatchFailure(record)
    }
  }))
  return { batchItemFailures: results.filter(isDefined) }
}

/** API replay と worker retry が共有する SQS enqueue helper です。 */
export async function queueWebhookDeliveryMessage(
  workspaceId: string,
  deliveryId: string,
  delaySeconds = 0,
) {
  await getDefaultWebhookQueue().enqueue({ workspaceId, deliveryId, delaySeconds })
}

async function projectAuditRecord(
  record: WebhookDynamoStreamRecord,
  dependencies: WebhookProjectionDependencies,
) {
  if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) return
  const stored = unmarshalDynamoMap(record.dynamodb.NewImage)
  if (stored.outboxStatus !== 'pending') return
  const event = upcastAuditEvent(stored)
  if (event.outboxStatus !== 'pending' || !isWebhookEventType(event.eventType)) return
  const envelope: WebhookEventEnvelope = {
    id: event.eventId,
    type: event.eventType,
    apiVersion: '2026-07-01',
    occurredAt: event.occurredAt,
    workspaceId: event.workspaceId,
    data: toAuditEventView(stored),
  }
  const resourceScope = readWebhookEventResourceScope(envelope)
  if (!resourceScope) return
  const subscriptions = await dependencies.developerPlatform.listWebhookSubscriptions(
    event.workspaceId,
  )
  const authorizedSubscriptionIds = (await Promise.all(subscriptions.map(async (
    subscription,
  ) =>
    subscription.status === 'active' &&
    subscription.teamIds.includes(resourceScope.teamId) &&
    await dependencies.authorizer.canDeliver(
      event.workspaceId,
      subscription,
      resourceScope.teamId,
      resourceScope.projectId,
    )
      ? subscription.id
      : undefined
  ))).filter(isDefined)
  const deliveries = await dependencies.developerPlatform.enqueueWebhookEvent({
    workspaceId: event.workspaceId,
    event: envelope,
    authorizedSubscriptionIds,
  })
  await Promise.all(deliveries.map((delivery) => dependencies.queue.enqueue({
    workspaceId: event.workspaceId,
    deliveryId: delivery.id,
  })))
}

async function processWebhookQueueRecord(
  record: WebhookSqsRecord,
  dependencies: WebhookDeliveryWorkerDependencies,
) {
  const message = readWebhookQueueMessage(record.body)
  const now = dependencies.now()
  const claim: WebhookDeliveryClaimRequest = {
    ...message,
    leaseOwner: randomUUID(),
    now: now.toISOString(),
    leaseExpiresAt: new Date(
      now.getTime() + WEBHOOK_DELIVERY_LEASE_SECONDS * 1_000,
    ).toISOString(),
  }
  if (!await dependencies.claims.tryClaim(claim)) {
    throw new Error('Webhook delivery claim is still active.')
  }
  let attemptStarted = false
  let completed = false
  try {
    await processClaimedWebhookQueueRecord(message, dependencies, () => {
      attemptStarted = true
    })
    completed = true
  } finally {
    if (completed || !attemptStarted) await dependencies.claims.release(claim)
  }
}

async function processClaimedWebhookQueueRecord(
  message: WebhookQueueMessage,
  dependencies: WebhookDeliveryWorkerDependencies,
  markAttemptStarted: () => void,
) {
  let prepared: PreparedWebhookDelivery
  try {
    prepared = await dependencies.developerPlatform.prepareWebhookDelivery(message)
  } catch (error) {
    if (isMissingWebhookDelivery(error)) return
    if (isInactiveWebhookSubscription(error)) {
      await dependencies.developerPlatform.recordWebhookDeliveryAttempt({
        ...message,
        status: 'failed',
        error: 'Webhook subscription is not active.',
      })
      return
    }
    throw error
  }
  if (prepared.delivery.status === 'delivered' || prepared.delivery.status === 'failed') return
  const preparedEvent = readPreparedWebhookEvent(prepared.payload)
  const resourceScope = readWebhookEventResourceScope(preparedEvent)
  if (
    !resourceScope ||
    !prepared.subscription.teamIds.includes(resourceScope.teamId) ||
    !await dependencies.authorizer.canDeliver(
      message.workspaceId,
      prepared.subscription,
      resourceScope.teamId,
      resourceScope.projectId,
    )
  ) {
    await dependencies.developerPlatform.recordWebhookDeliveryAttempt({
      ...message,
      status: 'failed',
      error: 'Webhook subscription owner no longer has access to this resource.',
    })
    return
  }

  const remainingDelay = readRemainingRetryDelay(prepared.delivery, dependencies.now())
  if (remainingDelay > 0) {
    await dependencies.queue.enqueue({ ...message, delaySeconds: remainingDelay })
    return
  }

  let result: WebhookRequestResult
  try {
    markAttemptStarted()
    result = await dependencies.deliver(prepared)
  } catch (error) {
    if (error instanceof UnsafeWebhookUrlError) {
      await dependencies.developerPlatform.recordWebhookDeliveryAttempt({
        ...message,
        status: 'failed',
        error: 'Webhook endpoint is no longer safe to contact.',
      })
      return
    }
    throw error
  }
  if (result.succeeded) {
    await dependencies.developerPlatform.recordWebhookDeliveryAttempt({
      ...message,
      status: 'delivered',
      ...(result.responseStatus === undefined ? {} : { responseStatus: result.responseStatus }),
    })
    return
  }

  const nextAttempt = prepared.delivery.attempts + 1
  if (!result.retryable || nextAttempt >= WEBHOOK_MAX_ATTEMPTS) {
    await dependencies.developerPlatform.recordWebhookDeliveryAttempt({
      ...message,
      status: 'failed',
      ...(result.responseStatus === undefined ? {} : { responseStatus: result.responseStatus }),
      error: result.error ?? 'Webhook delivery failed.',
    })
    return
  }

  const delaySeconds = createWebhookRetryDelaySeconds(
    nextAttempt,
    result.retryAfterSeconds,
    dependencies.random,
  )
  const nextAttemptAt = new Date(
    dependencies.now().getTime() + delaySeconds * 1_000,
  ).toISOString()
  await dependencies.developerPlatform.recordWebhookDeliveryAttempt({
    ...message,
    status: 'retrying',
    ...(result.responseStatus === undefined ? {} : { responseStatus: result.responseStatus }),
    nextAttemptAt,
    error: result.error ?? 'Webhook delivery will be retried.',
  })
  await dependencies.queue.enqueue({ ...message, delaySeconds })
}

async function deliverPreparedWebhook(prepared: PreparedWebhookDelivery) {
  return await deliverWebhookRequest({
    deliveryId: prepared.delivery.id,
    eventId: prepared.delivery.eventId,
    url: prepared.subscription.url,
    signingSecret: prepared.signingSecret,
    payload: prepared.payload,
  })
}

/** Developer platform table の dedicated row で Webhook attempt lease を保持します。 */
export class DynamoDbWebhookDeliveryClaimStore
implements WebhookDeliveryClaimStore {
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Claim row を保存する Developer platform table 名です。 */
  private readonly tableName: string

  /** DynamoDB-backed claim store を作成します。 */
  constructor(
    documentClient: DynamoDBDocumentClient = createWebhookClaimDocumentClient(),
    tableName = readWebhookClaimTableName(),
  ) {
    this.documentClient = documentClient
    this.tableName = readIdentifier(tableName, 'Developer platform table name')
  }

  /** Missing/expired claim だけを current worker が条件付き取得します。 */
  async tryClaim(request: WebhookDeliveryClaimRequest) {
    const normalized = readWebhookDeliveryClaimRequest(request)
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: {
          workspaceId: normalized.workspaceId,
          recordKey: createWebhookDeliveryClaimRecordKey(normalized.deliveryId),
        },
        UpdateExpression:
          'SET #entryType = :entryType, deliveryId = :deliveryId, ' +
          'leaseOwner = :leaseOwner, leaseExpiresAt = :leaseExpiresAt, ' +
          'updatedAt = :now, expiresAt = :expiresAt',
        ConditionExpression:
          'attribute_not_exists(workspaceId) OR ' +
          '(#entryType = :entryType AND ' +
          '(leaseExpiresAt < :now OR leaseOwner = :leaseOwner))',
        ExpressionAttributeNames: { '#entryType': 'entryType' },
        ExpressionAttributeValues: {
          ':entryType': 'webhook-delivery-claim',
          ':deliveryId': normalized.deliveryId,
          ':leaseOwner': normalized.leaseOwner,
          ':leaseExpiresAt': normalized.leaseExpiresAt,
          ':now': normalized.now,
          ':expiresAt': Math.floor(Date.parse(normalized.leaseExpiresAt) / 1_000),
        },
      }))
      return true
    } catch (error) {
      if (readErrorName(error) === 'ConditionalCheckFailedException') return false
      throw error
    }
  }

  /** Current owner の claim だけを条件付き削除します。 */
  async release(request: WebhookDeliveryClaimRequest) {
    const normalized = readWebhookDeliveryClaimRequest(request)
    try {
      await this.documentClient.send(new DeleteCommand({
        TableName: this.tableName,
        Key: {
          workspaceId: normalized.workspaceId,
          recordKey: createWebhookDeliveryClaimRecordKey(normalized.deliveryId),
        },
        ConditionExpression:
          '#entryType = :entryType AND deliveryId = :deliveryId AND leaseOwner = :leaseOwner',
        ExpressionAttributeNames: { '#entryType': 'entryType' },
        ExpressionAttributeValues: {
          ':entryType': 'webhook-delivery-claim',
          ':deliveryId': normalized.deliveryId,
          ':leaseOwner': normalized.leaseOwner,
        },
      }))
    } catch (error) {
      if (readErrorName(error) !== 'ConditionalCheckFailedException') throw error
    }
  }
}

function getDefaultDeveloperPlatform() {
  defaultDeveloperPlatform ??= new DynamoDbDeveloperPlatformClient()
  return defaultDeveloperPlatform
}

function getDefaultWebhookDeliveryClaimStore() {
  defaultWebhookDeliveryClaimStore ??= new DynamoDbWebhookDeliveryClaimStore()
  return defaultWebhookDeliveryClaimStore
}

function getDefaultWebhookAuthorizer() {
  defaultWebhookAuthorizer ??= new DynamoDbWebhookSubscriptionAuthorizer()
  return defaultWebhookAuthorizer
}

function getDefaultWebhookQueue() {
  defaultQueue ??= {
    async enqueue(message) {
      const queueUrl = process.env.WEBHOOK_DELIVERY_QUEUE_URL?.trim()
      if (!queueUrl) {
        throw new DeveloperPlatformError(
          503,
          'WebhookQueueUnavailable',
          'Webhook delivery queue is not configured.',
        )
      }
      const delaySeconds = normalizeQueueDelay(message.delaySeconds)
      await createSqsClient().send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          workspaceId: readIdentifier(message.workspaceId, 'Workspace ID'),
          deliveryId: readIdentifier(message.deliveryId, 'Webhook delivery ID'),
        }),
        ...(delaySeconds > 0 ? { DelaySeconds: delaySeconds } : {}),
      }))
    },
  }
  return defaultQueue
}

function createSqsClient() {
  if (defaultSqsClient) return defaultSqsClient
  const endpoint = process.env.SQS_ENDPOINT ??
    process.env.AWS_ENDPOINT_URL_SQS ??
    process.env.AWS_ENDPOINT_URL
  defaultSqsClient = new SQSClient({
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
  return defaultSqsClient
}

function createWebhookClaimDocumentClient() {
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

function readWebhookClaimTableName() {
  const configured = process.env.DEVELOPER_PLATFORM_TABLE_NAME?.trim()
  if (configured) return configured
  if (
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME?.trim()) ||
    Boolean(process.env.AWS_EXECUTION_ENV?.trim())
  ) {
    throw new TypeError('Developer platform table name is required in production.')
  }
  return 'mukuroji-developer-platform-local'
}

function readWebhookDeliveryClaimRequest(
  request: WebhookDeliveryClaimRequest,
): WebhookDeliveryClaimRequest {
  const now = readTimestamp(request.now, 'Webhook claim time')
  const leaseExpiresAt = readTimestamp(
    request.leaseExpiresAt,
    'Webhook claim expiry',
  )
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new TypeError('Webhook claim expiry must be after its claim time.')
  }
  return {
    workspaceId: readIdentifier(request.workspaceId, 'Workspace ID'),
    deliveryId: readIdentifier(request.deliveryId, 'Webhook delivery ID'),
    leaseOwner: readIdentifier(request.leaseOwner, 'Webhook claim owner'),
    now,
    leaseExpiresAt,
  }
}

function createWebhookDeliveryClaimRecordKey(deliveryId: string) {
  return `WEBHOOKDELIVERYCLAIM#${deliveryId}`
}

function readTimestamp(value: string, label: string) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} is invalid.`)
  }
  return new Date(value).toISOString()
}

function readErrorName(error: unknown) {
  return error && typeof error === 'object' && 'name' in error &&
      typeof error.name === 'string'
    ? error.name
    : undefined
}

function readWebhookQueueMessage(body: string | undefined): WebhookQueueMessage {
  if (!body) throw new TypeError('Webhook queue body is required.')
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new TypeError('Webhook queue body must be valid JSON.')
  }
  if (!isRecord(value)) throw new TypeError('Webhook queue body must be an object.')
  return {
    workspaceId: readIdentifier(value.workspaceId, 'Workspace ID'),
    deliveryId: readIdentifier(value.deliveryId, 'Webhook delivery ID'),
  }
}

function readRemainingRetryDelay(delivery: WebhookDelivery, now: Date) {
  if (delivery.status !== 'retrying' || !delivery.nextAttemptAt) return 0
  const remaining = Math.ceil((Date.parse(delivery.nextAttemptAt) - now.getTime()) / 1_000)
  return normalizeQueueDelay(remaining)
}

function readWebhookEventResourceScope(event: WebhookEventEnvelope) {
  if (!isRecord(event.data)) return undefined
  const metadata = event.data.metadata
  if (!isRecord(metadata) || typeof metadata.teamId !== 'string') return undefined
  const teamId = metadata.teamId.trim()
  if (!teamId || teamId.length > 200) return undefined
  const projectId = typeof metadata.projectId === 'string'
    ? metadata.projectId.trim()
    : undefined
  if (projectId !== undefined && (!projectId || projectId.length > 200)) return undefined
  return { teamId, ...(projectId ? { projectId } : {}) }
}

function readPreparedWebhookEvent(payload: string): WebhookEventEnvelope {
  try {
    const event = JSON.parse(payload) as unknown
    if (
      !isRecord(event) ||
      typeof event.id !== 'string' ||
      typeof event.type !== 'string' ||
      !isWebhookEventType(event.type) ||
      event.apiVersion !== '2026-07-01' ||
      typeof event.occurredAt !== 'string' ||
      typeof event.workspaceId !== 'string' ||
      !('data' in event)
    ) {
      throw new TypeError('Webhook event envelope is invalid.')
    }
    return event as WebhookEventEnvelope
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError('Webhook event envelope is invalid.')
  }
}

function normalizeQueueDelay(value: number | undefined) {
  if (value === undefined || value <= 0) return 0
  if (!Number.isFinite(value)) throw new TypeError('Webhook queue delay must be finite.')
  return Math.min(WEBHOOK_QUEUE_MAX_DELAY_SECONDS, Math.ceil(value))
}

function isWebhookEventType(value: string): value is WebhookEventType {
  return value === 'work-item.created' ||
    value === 'work-item.updated' ||
    value === 'work-item.deleted' ||
    value === 'external-link.created' ||
    value === 'external-link.updated' ||
    value === 'sync-conflict.created' ||
    value === 'sync-conflict.resolved' ||
    value === 'import.completed' ||
    value === 'import.failed'
}

function unmarshalDynamoMap(
  value: Record<string, WebhookDynamoAttributeValue>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, attribute]) => [key, unmarshalDynamoAttribute(attribute)]),
  )
}

function unmarshalDynamoAttribute(value: WebhookDynamoAttributeValue): unknown {
  if (value.S !== undefined) return value.S
  if (value.N !== undefined) return Number(value.N)
  if (value.BOOL !== undefined) return value.BOOL
  if (value.NULL) return null
  if (value.L) return value.L.map(unmarshalDynamoAttribute)
  if (value.M) return unmarshalDynamoMap(value.M)
  if (value.SS) return value.SS
  if (value.NS) return value.NS.map(Number)
  return undefined
}

function createDynamoBatchFailure(
  record: WebhookDynamoStreamRecord,
): WebhookBatchItemFailure {
  const identifier = record.dynamodb?.SequenceNumber?.trim()
  if (!identifier) throw new TypeError('DynamoDB stream sequence number is required.')
  return { itemIdentifier: identifier }
}

function createSqsBatchFailure(record: WebhookSqsRecord): WebhookBatchItemFailure {
  const identifier = record.messageId?.trim()
  if (!identifier) throw new TypeError('SQS message ID is required.')
  return { itemIdentifier: identifier }
}

function isMissingWebhookDelivery(error: unknown) {
  return error instanceof DeveloperPlatformError && error.code === 'WebhookDeliveryNotFound'
}

function isInactiveWebhookSubscription(error: unknown) {
  return error instanceof DeveloperPlatformError && error.code === 'WebhookSubscriptionNotActive'
}

function readSafeErrorMessage(error: unknown) {
  if (error instanceof DeveloperPlatformError || error instanceof UnsafeWebhookUrlError) {
    return error.code
  }
  return error instanceof TypeError
    ? 'WebhookInputInvalid'
    : 'UnexpectedWebhookWorkerError'
}

function readIdentifier(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
