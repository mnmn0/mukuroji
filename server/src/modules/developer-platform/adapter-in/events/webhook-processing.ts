import { createHash, randomUUID } from 'node:crypto'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import type {
  WebhookDelivery,
  WebhookEventEnvelope,
  WebhookEventType,
  WebhookSubscription,
} from '@mukuroji/contracts'
import {
  createDynamoDbClient as createConfiguredDynamoDbClient,
  createWorkspaceSearchWriterDynamoDbDocumentClient,
} from '../../../../infrastructure/aws/dynamodb-client'
import {
  getConfiguredAuditTableName,
  toAuditEventView,
  upcastAuditEvent,
  type AuditEventV1,
} from '../../../audit'
import type {
  PreparedWebhookDelivery,
  WebhookDeliveryPort,
  WebhookSubscriptionPort,
} from '../../application/ports'
import { WEBHOOK_MAX_ATTEMPTS } from '../../domain/webhook-policy'
import { DeveloperPlatformError } from '../../errors'
import {
  UnsafeWebhookUrlError,
  createWebhookRetryDelaySeconds,
  deliverWebhookRequest,
  type WebhookRequestResult,
} from '../../webhook-delivery'
import {
  type WebhookSubscriptionAuthorizer,
} from '../../webhook-authorization'
import {
  createWebhookGrantCleanupDirectoryId,
  createWebhookGrantCleanupEntryKeyPrefix,
  createWebhookGrantCleanupItem,
} from '../../webhook-authorization-projection'

/** SQS が1 message に設定できる最大 delay 秒です。 */
export const WEBHOOK_QUEUE_MAX_DELAY_SECONDS = 15 * 60

/** Webhook HTTP attempt を単一 worker に束縛する lease 秒数です。 */
export const WEBHOOK_DELIVERY_LEASE_SECONDS = 90

/** 1 projection message で読み取る Webhook subscription の最大件数です。 */
export const WEBHOOK_PROJECTION_PAGE_SIZE = 50

/** Webhook projection が同時に実行する認可・永続化・enqueue の最大件数です。 */
export const WEBHOOK_PROJECTION_CONCURRENCY = 10

/** Projection page worker の durable lease 秒数です。 */
export const WEBHOOK_PROJECTION_LEASE_SECONDS = 90

/** 完了済み projection page state の保持秒数です。 */
export const WEBHOOK_PROJECTION_STATE_RETENTION_SECONDS = 15 * 24 * 60 * 60

/** 1 cleanup messageで削除するgrant locator最大件数です。 */
export const WEBHOOK_GRANT_CLEANUP_PAGE_SIZE = 25

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

/** Webhook HTTP delivery queue に載せる secret-free locator です。 */
export type WebhookDeliveryQueueMessage = {
  /** Message の用途を識別する discriminator です。 */
  kind: 'delivery'
  /** Delivery が属する Workspace ID です。 */
  workspaceId: string
  /** 永続化済み Webhook delivery ID です。 */
  deliveryId: string
  /** SQS へ設定する delay 秒です。 */
  delaySeconds?: number
}

/** Audit event から Webhook deliveries を durable に射影する queue message です。 */
export type WebhookProjectionQueueMessage = {
  /** Message の用途を識別する discriminator です。 */
  kind: 'projection'
  /** Audit event が属する Workspace ID です。 */
  workspaceId: string
  /** 強整合読みで復元する Audit event ID です。 */
  eventId: string
  /** 次に読む subscription page の opaque cursor です。 */
  cursor?: string
}

/** Archived Team/Project のmaterialized Webhook grantsを削除するmessageです。 */
export type WebhookGrantCleanupQueueMessage = {
  /** Message の用途を識別する discriminator です。 */
  kind: 'grant-cleanup'
  /** Archived resource が属するWorkspace IDです。 */
  workspaceId: string
  /** Archive transitionを一意に識別するAudit event IDです。 */
  archiveEventId: string
  /** Archived Team IDです。 */
  teamId: string
  /** Project archiveの場合に限定するProject IDです。 */
  projectId?: string
  /** 次に読むcleanup locator pageのopaque cursorです。 */
  cursor?: string
}

/** Webhook queue に載せる secret-free message です。 */
export type WebhookQueueMessage =
  | WebhookDeliveryQueueMessage
  | WebhookProjectionQueueMessage
  | WebhookGrantCleanupQueueMessage

/** Webhook delivery queue への書き込み境界です。 */
export interface WebhookDeliveryQueue {
  /** Secret を含まない projection または delivery locator を enqueue します。 */
  enqueue(message: WebhookQueueMessage): Promise<void>
}

/** Webhook projection worker が Audit event を強整合読みする境界です。 */
export interface WebhookAuditEventReader {
  /** Workspace-bound ID で Audit event を返します。 */
  getEvent(workspaceId: string, eventId: string): Promise<AuditEventV1 | undefined>
}

/** Webhook projection page claim の入力です。 */
export type WebhookProjectionClaimRequest = {
  /** Audit event が属する Workspace ID です。 */
  workspaceId: string
  /** Projection 対象 Audit event ID です。 */
  eventId: string
  /** このpageを一意に識別するsubscription cursorです。 */
  cursor?: string
  /** Current worker owner token です。 */
  leaseOwner: string
  /** Claim 判定時刻です。 */
  now: string
  /** Claim の失効日時です。 */
  leaseExpiresAt: string
}

/** Webhook projection page 完了入力です。 */
export type WebhookProjectionCompletionRequest = WebhookProjectionClaimRequest & {
  /** 次pageが存在する場合のsubscription cursorです。 */
  nextCursor?: string
}

/** Projection page claim の永続状態です。 */
export type WebhookProjectionClaimResult =
  | {
      /** Current worker がpageを処理できます。 */
      status: 'claimed'
    }
  | {
      /** 別workerのleaseが有効です。 */
      status: 'busy'
    }
  | {
      /** Page処理は完了済みです。 */
      status: 'completed'
      /** Durable state に保存済みの次cursorです。 */
      nextCursor?: string
      /** 次page enqueue の確認が永続化済みかどうかです。 */
      continuationEnqueued: boolean
    }

/** `(eventId,cursor)` ごとの durable projection state 境界です。 */
export interface WebhookProjectionStateStore {
  /** Missing/expired page lease をcurrent workerが取得します。 */
  tryClaim(request: WebhookProjectionClaimRequest): Promise<WebhookProjectionClaimResult>
  /** Current ownerだけがpageをcompletedへ進めます。 */
  complete(request: WebhookProjectionCompletionRequest): Promise<boolean>
  /** Pending continuation send leaseをcurrent workerが一度だけ取得します。 */
  tryClaimContinuation(
    request: WebhookProjectionCompletionRequest,
  ): Promise<boolean>
  /** Current pageの次message enqueue確認を一度だけ保存します。 */
  markContinuationEnqueued(
    request: WebhookProjectionCompletionRequest,
  ): Promise<boolean>
}

/** Archived resource grant cleanup page requestです。 */
export type WebhookGrantCleanupPageRequest = {
  /** Archived resource が属するWorkspace IDです。 */
  workspaceId: string
  /** Archived Team IDです。 */
  teamId: string
  /** Project archiveの場合に限定するProject IDです。 */
  projectId?: string
  /** 前pageが返したopaque cursorです。 */
  cursor?: string
  /** 1 page の最大locator数です。 */
  limit: number
}

/** Archived resource grant cleanup page resultです。 */
export type WebhookGrantCleanupPage = {
  /** 次pageが存在する場合のopaque cursorです。 */
  nextCursor?: string
}

/** Project directory のgrant/cleanup locator削除境界です。 */
export interface WebhookGrantCleanupStore {
  /** Strong queryしたlocatorをbounded transactionで削除します。 */
  deletePage(request: WebhookGrantCleanupPageRequest): Promise<WebhookGrantCleanupPage>
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
  /** Durable projection message を delivery worker へ渡す queue です。 */
  queue: WebhookDeliveryQueue
}

/** Webhook HTTP worker の注入可能 dependencies です。 */
export type WebhookDeliveryWorkerDependencies = {
  /** Projection message の Audit event を強整合読みします。 */
  auditEvents: WebhookAuditEventReader
  /** Subscription と delivery log の永続化境界です。 */
  developerPlatform: WebhookDeliveryPort & Pick<
    WebhookSubscriptionPort,
    'listActiveWebhookSubscriptionsPage'
  >
  /** Retry/replay 時にも subscription 作成者の current ACL を再検証します。 */
  authorizer: WebhookSubscriptionAuthorizer
  /** Projection page のleaseとcontinuation checkpointです。 */
  projections?: WebhookProjectionStateStore
  /** Archived Team/Project のgrant locator cleanup境界です。 */
  grantCleanup?: WebhookGrantCleanupStore
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

/**
 * Audit projection dependencies に束縛された stream handler を作成します。
 */
export function createWebhookProjectionHandler(
  dependencies: WebhookProjectionDependencies,
) {
  return async (event: WebhookDynamoStreamEvent): Promise<WebhookBatchResponse> =>
    await processWebhookProjectionBatch(event, dependencies)
}

/** Audit stream batch を処理して record 単位の retry response を返します。 */
export async function processWebhookProjectionBatch(
  event: WebhookDynamoStreamEvent,
  dependencies: WebhookProjectionDependencies,
): Promise<WebhookBatchResponse> {
  const results = await Promise.all((event.Records ?? []).map(async (record) => {
    try {
      await projectAuditRecord(record, dependencies)
      return undefined
    } catch (error) {
      console.error('Webhook projection failed:', readSafeErrorMessage(error))
      return createDynamoBatchFailure(record)
    }
  }))
  return { batchItemFailures: results.filter(isDefined) }
}

/** SQS delivery dependencies に束縛された batch handler を作成します。 */
export function createWebhookDeliveryHandler(
  dependencies: WebhookDeliveryWorkerDependencies,
) {
  return async (event: WebhookSqsEvent): Promise<WebhookBatchResponse> =>
    await processWebhookDeliveryBatch(event, dependencies)
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

/** API replay と worker retry が共有する SQS enqueue helper を作成します。 */
export function createQueueWebhookDeliveryMessage(queue: WebhookDeliveryQueue) {
  return async (
    workspaceId: string,
    deliveryId: string,
    delaySeconds = 0,
  ) => {
    await queue.enqueue({
      kind: 'delivery',
      workspaceId,
      deliveryId,
      delaySeconds,
    })
  }
}

async function projectAuditRecord(
  record: WebhookDynamoStreamRecord,
  dependencies: WebhookProjectionDependencies,
) {
  if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) return
  const stored = unmarshalDynamoMap(record.dynamodb.NewImage)
  if (stored.outboxStatus !== 'pending') return
  const event = upcastAuditEvent(stored)
  if (event.outboxStatus !== 'pending') return
  const cleanupScope = readWebhookGrantCleanupScope(event)
  if (cleanupScope) {
    await dependencies.queue.enqueue({
      kind: 'grant-cleanup',
      workspaceId: event.workspaceId,
      archiveEventId: event.eventId,
      ...cleanupScope,
    })
    return
  }
  if (!isWebhookEventType(event.eventType)) return
  await dependencies.queue.enqueue({
    kind: 'projection',
    workspaceId: event.workspaceId,
    eventId: event.eventId,
  })
}

async function processWebhookProjectionMessage(
  message: WebhookProjectionQueueMessage,
  dependencies: WebhookDeliveryWorkerDependencies,
) {
  if (!dependencies.projections) {
    throw new TypeError('Webhook projection state store is required.')
  }
  const claimTime = dependencies.now()
  const claimRequest: WebhookProjectionClaimRequest = {
    workspaceId: message.workspaceId,
    eventId: message.eventId,
    ...(message.cursor ? { cursor: message.cursor } : {}),
    leaseOwner: randomUUID(),
    now: claimTime.toISOString(),
    leaseExpiresAt: new Date(
      claimTime.getTime() + WEBHOOK_PROJECTION_LEASE_SECONDS * 1_000,
    ).toISOString(),
  }
  const claim = await dependencies.projections.tryClaim(claimRequest)
  if (claim.status === 'busy') {
    throw new Error('Webhook projection page lease is still active.')
  }
  if (claim.status === 'completed') {
    if (claim.nextCursor && !claim.continuationEnqueued) {
      await enqueueWebhookProjectionContinuation(
        claimRequest,
        claim.nextCursor,
        dependencies,
      )
    }
    return
  }

  const event = await dependencies.auditEvents.getEvent(message.workspaceId, message.eventId)
  if (
    !event ||
    event.workspaceId !== message.workspaceId ||
    event.eventId !== message.eventId ||
    event.outboxStatus !== 'pending' ||
    !isWebhookEventType(event.eventType)
  ) {
    if (!await dependencies.projections.complete(claimRequest)) {
      throw new Error('Webhook projection lease was lost.')
    }
    return
  }

  const envelope: WebhookEventEnvelope = {
    id: event.eventId,
    type: event.eventType,
    apiVersion: '2026-07-01',
    occurredAt: event.occurredAt,
    workspaceId: event.workspaceId,
    data: toAuditEventView(event),
  }
  const resourceScope = readWebhookEventResourceScope(envelope)
  if (!resourceScope) {
    if (!await dependencies.projections.complete(claimRequest)) {
      throw new Error('Webhook projection lease was lost.')
    }
    return
  }

  const page = await dependencies.developerPlatform.listActiveWebhookSubscriptionsPage({
    workspaceId: event.workspaceId,
    ...(message.cursor ? { cursor: message.cursor } : {}),
    limit: WEBHOOK_PROJECTION_PAGE_SIZE,
  })
  const candidates = page.subscriptions.filter((subscription) =>
    isMatchingWebhookProjectionSubscription(subscription, envelope, resourceScope.teamId)
  )

  for (const group of chunkValues(candidates, WEBHOOK_PROJECTION_CONCURRENCY)) {
    const authorizedSubscriptionIds = (await mapWithConcurrency(
      group,
      WEBHOOK_PROJECTION_CONCURRENCY,
      async (subscription) => {
        const authorized = await dependencies.authorizer.canDeliver(
          event.workspaceId,
          subscription,
          resourceScope.teamId,
          resourceScope.projectId,
        )
        return authorized ? subscription.id : undefined
      },
    )).filter(isDefined)
    if (authorizedSubscriptionIds.length === 0) continue

    const deliveries = await dependencies.developerPlatform.enqueueWebhookEvent({
      workspaceId: event.workspaceId,
      event: envelope,
      authorizedSubscriptionIds,
    })
    await mapWithConcurrency(
      deliveries,
      WEBHOOK_PROJECTION_CONCURRENCY,
      async (delivery) => {
        await dependencies.queue.enqueue({
          kind: 'delivery',
          workspaceId: event.workspaceId,
          deliveryId: delivery.id,
        })
      },
    )
  }

  const completion = {
    ...claimRequest,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
  if (!await dependencies.projections.complete(completion)) {
    throw new Error('Webhook projection lease was lost.')
  }
  if (page.nextCursor) {
    await enqueueWebhookProjectionContinuation(
      claimRequest,
      page.nextCursor,
      dependencies,
    )
  }
}

async function enqueueWebhookProjectionContinuation(
  claim: WebhookProjectionClaimRequest,
  nextCursor: string,
  dependencies: WebhookDeliveryWorkerDependencies,
) {
  const completion = {
    ...claim,
    nextCursor,
  }
  if (!await dependencies.projections!.tryClaimContinuation(completion)) return
  await dependencies.queue.enqueue({
    kind: 'projection',
    workspaceId: claim.workspaceId,
    eventId: claim.eventId,
    cursor: nextCursor,
  })
  if (!await dependencies.projections!.markContinuationEnqueued(completion)) {
    throw new Error('Webhook projection continuation lease was lost.')
  }
}

function isMatchingWebhookProjectionSubscription(
  subscription: WebhookSubscription,
  event: WebhookEventEnvelope,
  teamId: string,
) {
  return subscription.status === 'active' &&
    subscription.teamIds.includes(teamId) &&
    subscription.eventTypes.includes(event.type)
}

async function processWebhookQueueRecord(
  record: WebhookSqsRecord,
  dependencies: WebhookDeliveryWorkerDependencies,
) {
  const message = readWebhookQueueMessage(record.body)
  if (message.kind === 'projection') {
    await processWebhookProjectionMessage(message, dependencies)
    return
  }
  if (message.kind === 'grant-cleanup') {
    await processWebhookGrantCleanupMessage(message, dependencies)
    return
  }
  const now = dependencies.now()
  const claim: WebhookDeliveryClaimRequest = {
    workspaceId: message.workspaceId,
    deliveryId: message.deliveryId,
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

async function processWebhookGrantCleanupMessage(
  message: WebhookGrantCleanupQueueMessage,
  dependencies: WebhookDeliveryWorkerDependencies,
) {
  if (!dependencies.projections || !dependencies.grantCleanup) {
    throw new TypeError('Webhook grant cleanup dependencies are required.')
  }
  const now = dependencies.now()
  const claimRequest: WebhookProjectionClaimRequest = {
    workspaceId: message.workspaceId,
    eventId: message.archiveEventId,
    ...(message.cursor ? { cursor: message.cursor } : {}),
    leaseOwner: randomUUID(),
    now: now.toISOString(),
    leaseExpiresAt: new Date(
      now.getTime() + WEBHOOK_PROJECTION_LEASE_SECONDS * 1_000,
    ).toISOString(),
  }
  const claim = await dependencies.projections.tryClaim(claimRequest)
  if (claim.status === 'busy') {
    throw new Error('Webhook grant cleanup page lease is still active.')
  }
  if (claim.status === 'completed') {
    if (claim.nextCursor && !claim.continuationEnqueued) {
      await enqueueWebhookGrantCleanupContinuation(
        message,
        claimRequest,
        claim.nextCursor,
        dependencies,
      )
    }
    return
  }
  const page = await dependencies.grantCleanup.deletePage({
    workspaceId: message.workspaceId,
    teamId: message.teamId,
    ...(message.projectId ? { projectId: message.projectId } : {}),
    ...(message.cursor ? { cursor: message.cursor } : {}),
    limit: WEBHOOK_GRANT_CLEANUP_PAGE_SIZE,
  })
  const completion = {
    ...claimRequest,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
  }
  if (!await dependencies.projections.complete(completion)) {
    throw new Error('Webhook grant cleanup lease was lost.')
  }
  if (page.nextCursor) {
    await enqueueWebhookGrantCleanupContinuation(
      message,
      claimRequest,
      page.nextCursor,
      dependencies,
    )
  }
}

async function enqueueWebhookGrantCleanupContinuation(
  message: WebhookGrantCleanupQueueMessage,
  claim: WebhookProjectionClaimRequest,
  nextCursor: string,
  dependencies: WebhookDeliveryWorkerDependencies,
) {
  const completion = {
    ...claim,
    nextCursor,
  }
  if (!await dependencies.projections!.tryClaimContinuation(completion)) return
  await dependencies.queue.enqueue({
    ...message,
    cursor: nextCursor,
  })
  if (!await dependencies.projections!.markContinuationEnqueued(completion)) {
    throw new Error('Webhook grant cleanup continuation lease was lost.')
  }
}

async function processClaimedWebhookQueueRecord(
  message: WebhookDeliveryQueueMessage,
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

/** Prepared Webhook delivery を検証済み transport へ渡します。 */
export async function deliverPreparedWebhook(prepared: PreparedWebhookDelivery) {
  return await deliverWebhookRequest({
    deliveryId: prepared.delivery.id,
    eventId: prepared.delivery.eventId,
    url: prepared.subscription.url,
    signingSecret: prepared.signingSecret,
    payload: prepared.payload,
  })
}

/** Audit event を Workspace-bound key で強整合読みする DynamoDB reader です。 */
export class DynamoDbWebhookAuditEventReader
implements WebhookAuditEventReader {
  /** Audit event table を操作する DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Immutable Audit event table 名です。 */
  private readonly tableName: string

  /** DynamoDB-backed Audit event reader を作成します。 */
  constructor(
    documentClient: DynamoDBDocumentClient = createWebhookDocumentClient(),
    tableName = readWebhookAuditTableName(),
  ) {
    this.documentClient = documentClient
    this.tableName = readIdentifier(tableName, 'Audit event table name')
  }

  /** Workspace-bound deterministic ID で Audit event を強整合読みします。 */
  async getEvent(workspaceIdValue: string, eventIdValue: string) {
    const workspaceId = readIdentifier(workspaceIdValue, 'Workspace ID')
    const eventId = readIdentifier(eventIdValue, 'Audit event ID')
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { directoryId: workspaceId, eventId },
      ConsistentRead: true,
    }))
    if (!response.Item) return undefined
    const event = upcastAuditEvent(response.Item)
    return event.workspaceId === workspaceId && event.eventId === eventId
      ? event
      : undefined
  }
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
    documentClient: DynamoDBDocumentClient = createWebhookDocumentClient(),
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

/** Developer platform table で projection page のleaseと完了状態を保持します。 */
export class DynamoDbWebhookProjectionStateStore
implements WebhookProjectionStateStore {
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Projection state row を保存するDeveloper platform table名です。 */
  private readonly tableName: string

  /** DynamoDB-backed projection state store を作成します。 */
  constructor(
    documentClient: DynamoDBDocumentClient = createWebhookDocumentClient(),
    tableName = readWebhookClaimTableName(),
  ) {
    this.documentClient = documentClient
    this.tableName = readIdentifier(tableName, 'Developer platform table name')
  }

  /** Missing/expired page lease だけをcurrent workerが取得します。 */
  async tryClaim(request: WebhookProjectionClaimRequest) {
    const normalized = readWebhookProjectionClaimRequest(request)
    const cursorDigest = createWebhookProjectionCursorDigest(normalized.cursor)
    const key = createWebhookProjectionStateKey(normalized)
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: key,
        UpdateExpression:
          'SET #entryType = :entryType, eventId = :eventId, ' +
          'cursorDigest = :cursorDigest, #status = :processing, ' +
          'leaseOwner = :leaseOwner, leaseExpiresAt = :leaseExpiresAt, ' +
          'updatedAt = :now, expiresAt = :expiresAt',
        ConditionExpression:
          'attribute_not_exists(workspaceId) OR ' +
          '(#entryType = :entryType AND eventId = :eventId AND ' +
          'cursorDigest = :cursorDigest AND #status = :processing AND ' +
          'leaseExpiresAt < :now)',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':entryType': 'webhook-projection-state',
          ':eventId': normalized.eventId,
          ':cursorDigest': cursorDigest,
          ':processing': 'processing',
          ':leaseOwner': normalized.leaseOwner,
          ':leaseExpiresAt': normalized.leaseExpiresAt,
          ':now': normalized.now,
          ':expiresAt': Math.floor(
            Date.parse(normalized.leaseExpiresAt) / 1_000,
          ) + WEBHOOK_PROJECTION_STATE_RETENTION_SECONDS,
        },
      }))
      return { status: 'claimed' } as const
    } catch (error) {
      if (readErrorName(error) !== 'ConditionalCheckFailedException') throw error
    }
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: key,
      ConsistentRead: true,
    }))
    return readWebhookProjectionClaimResult(
      response.Item,
      normalized.eventId,
      cursorDigest,
    )
  }

  /** Current lease ownerだけがpageとnext cursorをcompletedへ進めます。 */
  async complete(request: WebhookProjectionCompletionRequest) {
    const normalized = readWebhookProjectionCompletionRequest(request)
    const cursorDigest = createWebhookProjectionCursorDigest(normalized.cursor)
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: createWebhookProjectionStateKey(normalized),
        UpdateExpression: normalized.nextCursor
          ? 'SET #status = :completed, nextCursor = :nextCursor, ' +
            'continuationEnqueued = :notEnqueued, updatedAt = :now, ' +
            'expiresAt = :expiresAt ' +
            'REMOVE leaseOwner, leaseExpiresAt, continuationLeaseOwner, ' +
            'continuationLeaseExpiresAt'
          : 'SET #status = :completed, continuationEnqueued = :enqueued, ' +
            'updatedAt = :now, expiresAt = :expiresAt ' +
            'REMOVE leaseOwner, leaseExpiresAt, nextCursor, ' +
            'continuationLeaseOwner, continuationLeaseExpiresAt',
        ConditionExpression:
          '#entryType = :entryType AND eventId = :eventId AND ' +
          'cursorDigest = :cursorDigest AND #status = :processing AND ' +
          'leaseOwner = :leaseOwner',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':entryType': 'webhook-projection-state',
          ':eventId': normalized.eventId,
          ':cursorDigest': cursorDigest,
          ':processing': 'processing',
          ':completed': 'completed',
          ':leaseOwner': normalized.leaseOwner,
          ':now': normalized.now,
          ':expiresAt': Math.floor(Date.parse(normalized.now) / 1_000) +
            WEBHOOK_PROJECTION_STATE_RETENTION_SECONDS,
          ':enqueued': true,
          ...(normalized.nextCursor
            ? { ':nextCursor': normalized.nextCursor, ':notEnqueued': false }
            : {}),
        },
      }))
      return true
    } catch (error) {
      if (readErrorName(error) === 'ConditionalCheckFailedException') return false
      throw error
    }
  }

  /** Completed pageのpending continuation send leaseを条件付きで取得します。 */
  async tryClaimContinuation(request: WebhookProjectionCompletionRequest) {
    const normalized = readWebhookProjectionCompletionRequest(request)
    if (!normalized.nextCursor) {
      throw new TypeError('Webhook projection continuation cursor is required.')
    }
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: createWebhookProjectionStateKey(normalized),
        UpdateExpression:
          'SET continuationLeaseOwner = :leaseOwner, ' +
          'continuationLeaseExpiresAt = :leaseExpiresAt, updatedAt = :now',
        ConditionExpression:
          '#entryType = :entryType AND eventId = :eventId AND ' +
          'cursorDigest = :cursorDigest AND #status = :completed AND ' +
          'nextCursor = :nextCursor AND continuationEnqueued = :notEnqueued AND ' +
          '(attribute_not_exists(continuationLeaseExpiresAt) OR ' +
          'continuationLeaseExpiresAt < :now)',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':entryType': 'webhook-projection-state',
          ':eventId': normalized.eventId,
          ':cursorDigest': createWebhookProjectionCursorDigest(normalized.cursor),
          ':completed': 'completed',
          ':nextCursor': normalized.nextCursor,
          ':notEnqueued': false,
          ':leaseOwner': normalized.leaseOwner,
          ':leaseExpiresAt': normalized.leaseExpiresAt,
          ':now': normalized.now,
        },
      }))
      return true
    } catch (error) {
      if (readErrorName(error) === 'ConditionalCheckFailedException') return false
      throw error
    }
  }

  /** Current continuation lease ownerだけがenqueue確認を保存します。 */
  async markContinuationEnqueued(request: WebhookProjectionCompletionRequest) {
    const normalized = readWebhookProjectionCompletionRequest(request)
    if (!normalized.nextCursor) {
      throw new TypeError('Webhook projection continuation cursor is required.')
    }
    try {
      await this.documentClient.send(new UpdateCommand({
        TableName: this.tableName,
        Key: createWebhookProjectionStateKey(normalized),
        UpdateExpression:
          'SET continuationEnqueued = :enqueued, updatedAt = :now ' +
          'REMOVE continuationLeaseOwner, continuationLeaseExpiresAt',
        ConditionExpression:
          '#entryType = :entryType AND eventId = :eventId AND ' +
          'cursorDigest = :cursorDigest AND #status = :completed AND ' +
          'nextCursor = :nextCursor AND continuationEnqueued = :notEnqueued AND ' +
          'continuationLeaseOwner = :leaseOwner',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#status': 'status',
        },
        ExpressionAttributeValues: {
          ':entryType': 'webhook-projection-state',
          ':eventId': normalized.eventId,
          ':cursorDigest': createWebhookProjectionCursorDigest(normalized.cursor),
          ':completed': 'completed',
          ':nextCursor': normalized.nextCursor,
          ':notEnqueued': false,
          ':enqueued': true,
          ':leaseOwner': normalized.leaseOwner,
          ':now': normalized.now,
        },
      }))
      return true
    } catch (error) {
      if (readErrorName(error) === 'ConditionalCheckFailedException') return false
      throw error
    }
  }
}

/** Project directory に保存したgrant cleanup locatorです。 */
type WebhookGrantCleanupLocator = {
  /** Locator partition keyです。 */
  directoryId: string
  /** Locator sort keyです。 */
  entryKey: string
  /** Locator discriminatorです。 */
  entryType: 'webhook-team-grant-cleanup'
  /** Grantが属するWorkspace IDです。 */
  workspaceId: string
  /** Grantが属するTeam IDです。 */
  teamId: string
  /** Grantが属するProject IDです。 */
  projectId: string
  /** Grant subject member keyです。 */
  memberKey: string
  /** 削除対象grant partition keyです。 */
  grantDirectoryId: string
  /** 削除対象grant sort keyです。 */
  grantEntryKey: string
}

/** Primary-key locatorを使ってarchived resource grantsをbounded削除します。 */
export class DynamoDbWebhookGrantCleanupStore
implements WebhookGrantCleanupStore {
  /** DynamoDB DocumentClient です。 */
  private readonly documentClient: DynamoDBDocumentClient
  /** Project directory table名です。 */
  private readonly tableName: string

  /** DynamoDB-backed cleanup storeを作成します。 */
  constructor(
    documentClient: DynamoDBDocumentClient = createWebhookDocumentClient(),
    tableName = readWebhookProjectDirectoryTableName(),
  ) {
    this.documentClient = documentClient
    this.tableName = readIdentifier(tableName, 'Project directory table name')
  }

  /** Locatorをstrong queryし、grantとのpairをtransactionalに削除します。 */
  async deletePage(request: WebhookGrantCleanupPageRequest) {
    const workspaceId = readIdentifier(request.workspaceId, 'Workspace ID')
    const teamId = readIdentifier(request.teamId, 'Webhook Team ID')
    const projectId = request.projectId === undefined
      ? undefined
      : readIdentifier(request.projectId, 'Webhook Project ID')
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > WEBHOOK_GRANT_CLEANUP_PAGE_SIZE
    ) {
      throw new TypeError('Webhook grant cleanup page limit is invalid.')
    }
    const directoryId = createWebhookGrantCleanupDirectoryId(workspaceId, teamId)
    const entryKeyPrefix = projectId
      ? createWebhookGrantCleanupEntryKeyPrefix(projectId)
      : undefined
    const exclusiveStartKey = request.cursor
      ? decodeWebhookGrantCleanupCursor(
          request.cursor,
          directoryId,
          entryKeyPrefix,
        )
      : undefined
    const response = await this.documentClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: entryKeyPrefix
        ? 'directoryId = :directoryId AND begins_with(entryKey, :entryKeyPrefix)'
        : 'directoryId = :directoryId',
      ExpressionAttributeValues: {
        ':directoryId': directoryId,
        ...(entryKeyPrefix ? { ':entryKeyPrefix': entryKeyPrefix } : {}),
      },
      ConsistentRead: true,
      Limit: request.limit,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }))
    const locators = (response.Items ?? []).map((value) =>
      readWebhookGrantCleanupLocator(
        value,
        workspaceId,
        teamId,
        projectId,
      )
    )
    if (locators.length > 0) {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: locators.flatMap((locator) => [
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                directoryId: locator.grantDirectoryId,
                entryKey: locator.grantEntryKey,
              },
            },
          },
          {
            Delete: {
              TableName: this.tableName,
              Key: {
                directoryId: locator.directoryId,
                entryKey: locator.entryKey,
              },
              ConditionExpression:
                '#entryType = :entryType AND workspaceId = :workspaceId AND ' +
                'teamId = :teamId AND projectId = :projectId AND ' +
                'memberKey = :memberKey AND ' +
                'grantDirectoryId = :grantDirectoryId AND ' +
                'grantEntryKey = :grantEntryKey',
              ExpressionAttributeNames: { '#entryType': 'entryType' },
              ExpressionAttributeValues: {
                ':entryType': 'webhook-team-grant-cleanup',
                ':workspaceId': locator.workspaceId,
                ':teamId': locator.teamId,
                ':projectId': locator.projectId,
                ':memberKey': locator.memberKey,
                ':grantDirectoryId': locator.grantDirectoryId,
                ':grantEntryKey': locator.grantEntryKey,
              },
            },
          },
        ]),
      }))
    }
    return response.LastEvaluatedKey
      ? {
          nextCursor: encodeWebhookGrantCleanupCursor(
            response.LastEvaluatedKey,
            directoryId,
            entryKeyPrefix,
          ),
        }
      : {}
  }
}

/** Environment に束縛された SQS Webhook queue adapter を作成します。 */
export function createSqsWebhookDeliveryQueue(): WebhookDeliveryQueue {
  let sqsClient: SQSClient | undefined
  return {
    async enqueue(message) {
      const queueUrl = process.env.WEBHOOK_DELIVERY_QUEUE_URL?.trim()
      if (!queueUrl) {
        throw new DeveloperPlatformError(
          503,
          'WebhookQueueUnavailable',
          'Webhook delivery queue is not configured.',
        )
      }
      const delaySeconds = normalizeQueueDelay(
        message.kind === 'delivery' ? message.delaySeconds : undefined,
      )
      sqsClient ??= createSqsClient()
      await sqsClient.send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(createSerializedWebhookQueueMessage(message)),
        ...(delaySeconds > 0 ? { DelaySeconds: delaySeconds } : {}),
      }))
    },
  }
}

function createSqsClient() {
  const endpoint = process.env.SQS_ENDPOINT ??
    process.env.AWS_ENDPOINT_URL_SQS ??
    process.env.AWS_ENDPOINT_URL
  return new SQSClient({
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
}

function createWebhookDocumentClient() {
  const client = createConfiguredDynamoDbClient()
  return createWorkspaceSearchWriterDynamoDbDocumentClient(client)
}

function readWebhookAuditTableName() {
  const configured = getConfiguredAuditTableName()
  if (configured) return configured
  if (
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME?.trim()) ||
    Boolean(process.env.AWS_EXECUTION_ENV?.trim())
  ) {
    throw new TypeError('Audit event table name is required in production.')
  }
  return 'mukuroji-audit-events'
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

function readWebhookProjectDirectoryTableName() {
  const configured = process.env.PROJECT_DIRECTORY_TABLE_NAME?.trim()
  if (configured) return configured
  if (
    process.env.NODE_ENV === 'production' ||
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME?.trim()) ||
    Boolean(process.env.AWS_EXECUTION_ENV?.trim())
  ) {
    throw new TypeError('Project directory table name is required in production.')
  }
  return 'mukuroji-project-directory-local'
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

function readWebhookProjectionClaimRequest(
  request: WebhookProjectionClaimRequest,
): WebhookProjectionClaimRequest {
  const now = readTimestamp(request.now, 'Webhook projection claim time')
  const leaseExpiresAt = readTimestamp(
    request.leaseExpiresAt,
    'Webhook projection claim expiry',
  )
  if (Date.parse(leaseExpiresAt) <= Date.parse(now)) {
    throw new TypeError(
      'Webhook projection claim expiry must be after its claim time.',
    )
  }
  return {
    workspaceId: readIdentifier(request.workspaceId, 'Workspace ID'),
    eventId: readIdentifier(request.eventId, 'Audit event ID'),
    ...(request.cursor === undefined
      ? {}
      : { cursor: readOpaqueCursor(request.cursor) }),
    leaseOwner: readIdentifier(request.leaseOwner, 'Webhook projection claim owner'),
    now,
    leaseExpiresAt,
  }
}

function readWebhookProjectionCompletionRequest(
  request: WebhookProjectionCompletionRequest,
): WebhookProjectionCompletionRequest {
  return {
    ...readWebhookProjectionClaimRequest(request),
    ...(request.nextCursor === undefined
      ? {}
      : { nextCursor: readOpaqueCursor(request.nextCursor) }),
  }
}

function createWebhookProjectionCursorDigest(cursor: string | undefined) {
  return createHash('sha256')
    .update(cursor ?? 'FIRST_PAGE', 'utf8')
    .digest('hex')
}

function createWebhookProjectionStateKey(
  request: Pick<WebhookProjectionClaimRequest, 'workspaceId' | 'eventId' | 'cursor'>,
) {
  const pageDigest = createHash('sha256')
    .update(`${request.eventId}\0${request.cursor ?? 'FIRST_PAGE'}`, 'utf8')
    .digest('hex')
  return {
    workspaceId: request.workspaceId,
    recordKey: `WEBHOOKPROJECTION#${pageDigest}`,
  }
}

function readWebhookProjectionClaimResult(
  value: Record<string, unknown> | undefined,
  eventId: string,
  cursorDigest: string,
): WebhookProjectionClaimResult {
  if (
    !value ||
    value.entryType !== 'webhook-projection-state' ||
    value.eventId !== eventId ||
    value.cursorDigest !== cursorDigest
  ) {
    throw new TypeError('Webhook projection state is invalid.')
  }
  if (value.status === 'processing' && typeof value.leaseExpiresAt === 'string') {
    return { status: 'busy' }
  }
  if (
    value.status === 'completed' &&
    typeof value.continuationEnqueued === 'boolean' &&
    (
      value.nextCursor === undefined ||
      typeof value.nextCursor === 'string'
    )
  ) {
    return {
      status: 'completed',
      ...(typeof value.nextCursor === 'string'
        ? { nextCursor: readOpaqueCursor(value.nextCursor) }
        : {}),
      continuationEnqueued: value.continuationEnqueued,
    }
  }
  throw new TypeError('Webhook projection state is invalid.')
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
  const workspaceId = readIdentifier(value.workspaceId, 'Workspace ID')
  if (value.kind === 'delivery') {
    return {
      kind: 'delivery',
      workspaceId,
      deliveryId: readIdentifier(value.deliveryId, 'Webhook delivery ID'),
    }
  }
  if (value.kind === 'projection') {
    return {
      kind: 'projection',
      workspaceId,
      eventId: readIdentifier(value.eventId, 'Audit event ID'),
      ...(value.cursor === undefined
        ? {}
        : { cursor: readOpaqueCursor(value.cursor) }),
    }
  }
  if (value.kind === 'grant-cleanup') {
    return {
      kind: 'grant-cleanup',
      workspaceId,
      archiveEventId: readIdentifier(value.archiveEventId, 'Audit event ID'),
      teamId: readIdentifier(value.teamId, 'Webhook Team ID'),
      ...(value.projectId === undefined
        ? {}
        : { projectId: readIdentifier(value.projectId, 'Webhook Project ID') }),
      ...(value.cursor === undefined
        ? {}
        : { cursor: readOpaqueCursor(value.cursor) }),
    }
  }
  throw new TypeError('Webhook queue message kind is invalid.')
}

function createSerializedWebhookQueueMessage(message: WebhookQueueMessage) {
  const workspaceId = readIdentifier(message.workspaceId, 'Workspace ID')
  if (message.kind === 'delivery') {
    return {
      kind: message.kind,
      workspaceId,
      deliveryId: readIdentifier(message.deliveryId, 'Webhook delivery ID'),
    }
  }
  if (message.kind === 'grant-cleanup') {
    return {
      kind: message.kind,
      workspaceId,
      archiveEventId: readIdentifier(message.archiveEventId, 'Audit event ID'),
      teamId: readIdentifier(message.teamId, 'Webhook Team ID'),
      ...(message.projectId === undefined
        ? {}
        : {
            projectId: readIdentifier(
              message.projectId,
              'Webhook Project ID',
            ),
          }),
      ...(message.cursor === undefined
        ? {}
        : { cursor: readOpaqueCursor(message.cursor) }),
    }
  }
  return {
    kind: message.kind,
    workspaceId,
    eventId: readIdentifier(message.eventId, 'Audit event ID'),
    ...(message.cursor === undefined
      ? {}
      : { cursor: readOpaqueCursor(message.cursor) }),
  }
}

function readOpaqueCursor(value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 4_096 ||
    value.trim() !== value
  ) {
    throw new TypeError('Webhook subscription cursor is invalid.')
  }
  return value
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

function readWebhookGrantCleanupScope(event: AuditEventV1) {
  if (event.eventType !== 'project.archived' || !isRecord(event.metadata)) {
    return undefined
  }
  const teamId = readIdentifier(event.metadata.teamId, 'Webhook Team ID')
  if (event.metadata.kind === 'team') return { teamId }
  if (event.metadata.kind === 'project') {
    return {
      teamId,
      projectId: readIdentifier(event.metadata.projectId, 'Webhook Project ID'),
    }
  }
  return undefined
}

function readWebhookGrantCleanupLocator(
  value: Record<string, unknown>,
  workspaceId: string,
  teamId: string,
  expectedProjectId?: string,
): WebhookGrantCleanupLocator {
  if (
    value.entryType !== 'webhook-team-grant-cleanup' ||
    typeof value.projectId !== 'string' ||
    typeof value.memberKey !== 'string'
  ) {
    throw new TypeError('Webhook grant cleanup locator is invalid.')
  }
  const expected = createWebhookGrantCleanupItem({
    workspaceId,
    teamId,
    projectId: value.projectId,
    memberKey: value.memberKey,
  })
  if (
    (expectedProjectId !== undefined && value.projectId !== expectedProjectId) ||
    Object.entries(expected).some(([key, expectedValue]) =>
      value[key] !== expectedValue
    )
  ) {
    throw new TypeError('Webhook grant cleanup locator is invalid.')
  }
  return expected
}

function encodeWebhookGrantCleanupCursor(
  value: Record<string, unknown>,
  expectedDirectoryId: string,
  expectedEntryKeyPrefix?: string,
) {
  if (
    value.directoryId !== expectedDirectoryId ||
    typeof value.entryKey !== 'string' ||
    (
      expectedEntryKeyPrefix !== undefined &&
      !value.entryKey.startsWith(expectedEntryKeyPrefix)
    )
  ) {
    throw new TypeError('Webhook grant cleanup cursor is invalid.')
  }
  return Buffer.from(JSON.stringify({
    version: 1,
    directoryId: expectedDirectoryId,
    entryKey: value.entryKey,
    ...(expectedEntryKeyPrefix
      ? { entryKeyPrefix: expectedEntryKeyPrefix }
      : {}),
  }), 'utf8').toString('base64url')
}

function decodeWebhookGrantCleanupCursor(
  value: string,
  expectedDirectoryId: string,
  expectedEntryKeyPrefix?: string,
) {
  try {
    const encoded = readOpaqueCursor(value)
    const decoded = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    ) as unknown
    if (
      !isRecord(decoded) ||
      decoded.version !== 1 ||
      decoded.directoryId !== expectedDirectoryId ||
      typeof decoded.entryKey !== 'string' ||
      decoded.entryKeyPrefix !== expectedEntryKeyPrefix ||
      (
        expectedEntryKeyPrefix !== undefined &&
        !decoded.entryKey.startsWith(expectedEntryKeyPrefix)
      ) ||
      Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url') !== encoded
    ) {
      throw new Error('invalid')
    }
    return {
      directoryId: expectedDirectoryId,
      entryKey: decoded.entryKey,
    }
  } catch {
    throw new TypeError('Webhook grant cleanup cursor is invalid.')
  }
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

async function mapWithConcurrency<Value, Result>(
  values: readonly Value[],
  concurrency: number,
  task: (value: Value) => Promise<Result>,
) {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new TypeError('Webhook worker concurrency must be a positive integer.')
  }
  const results: Result[] = []
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await task(values[currentIndex]!)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, worker),
  )
  return results
}

function chunkValues<Value>(values: readonly Value[], size: number) {
  const chunks: Value[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
