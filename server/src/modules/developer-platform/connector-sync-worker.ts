import { createHash } from 'node:crypto'
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs'
import { upcastAuditEvent, type AuditEventV1 } from '../audit'
import type { DeveloperPlatformClient } from './developer-platform'
import type {
  ConnectorSyncEngine,
  ConnectorWorkItemResourceType,
} from './connector-sync-runtime'

/** Connector sync queue payload の schema version です。 */
export const CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION = 1

const maximumQueueBodyBytes = 16 * 1024
const maximumIdentifierLength = 256
const maximumProviderCursorLength = 8 * 1024

/** Work Item audit event を current external links へ展開する ID-only message です。 */
export type ConnectorWorkItemChangedMessage = {
  /** Queue payload schema version です。 */
  version: typeof CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION
  /** Work Item change message discriminator です。 */
  kind: 'work-item-changed'
  /** Work Item が属する Workspace ID です。 */
  workspaceId: string
  /** Work Item を所有する Team ID です。 */
  teamId: string
  /** Canonical Work Item ID です。 */
  workItemId: string
  /** Stable audit event ID です。 */
  sourceEventId: string
}

/** Current Work Item を current external link へ push する ID-only message です。 */
export type ConnectorOutboundMessage = {
  /** Queue payload schema version です。 */
  version: typeof CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION
  /** Outbound message discriminator です。 */
  kind: 'outbound'
  /** Link が属する Workspace ID です。 */
  workspaceId: string
  /** Authoritative reload する external link ID です。 */
  linkId: string
  /** Stable operation ID の seed にする source audit event ID です。 */
  sourceEventId: string
}

/** Installation/resource の provider page を poll する ID-only message です。 */
export type ConnectorPollMessage = {
  /** Queue payload schema version です。 */
  version: typeof CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION
  /** Poll message discriminator です。 */
  kind: 'poll'
  /** Installation が属する Workspace ID です。 */
  workspaceId: string
  /** Authoritative reload する connector installation ID です。 */
  installationId: string
  /** Poll する provider resource type です。 */
  resourceType: ConnectorWorkItemResourceType
}

/** Global external-link inventory の走査を durable queue から再開する message です。 */
export type ConnectorPollInventoryMessage = {
  /** Queue payload schema version です。 */
  version: typeof CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION
  /** Inventory continuation message discriminator です。 */
  kind: 'poll-inventory'
  /** Secret-free global inventory の opaque continuation cursor です。 */
  cursor: string
}

/** Disconnected installation の links をbounded pageでpauseするmessageです。 */
export type ConnectorDisconnectLinksMessage = {
  /** Queue payload schema version です。 */
  version: typeof CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION
  /** Disconnect cleanup message discriminator です。 */
  kind: 'disconnect-links'
  /** Installation が属する Workspace ID です。 */
  workspaceId: string
  /** Pause対象 connector installation ID です。 */
  installationId: string
  /** Disconnect transitionを束縛する lifecycle revision です。 */
  lifecycleRevision: number
  /** Lifecycle auditへ記録するactor User IDです。 */
  updatedByUserId?: string
  /** 前pageが返した内部cursorです。 */
  cursor?: string
}

/** Connector sync worker が受け付ける versioned secret-free payload です。 */
export type ConnectorSyncQueueMessage =
  | ConnectorWorkItemChangedMessage
  | ConnectorOutboundMessage
  | ConnectorPollMessage
  | ConnectorPollInventoryMessage
  | ConnectorDisconnectLinksMessage

/** Connector sync queue への書き込み境界です。 */
export interface ConnectorSyncQueue {
  /** ID locator だけを durable queue へ enqueue します。 */
  enqueue(message: ConnectorSyncQueueMessage): Promise<void>
}

/** Standard SQS queue に ID-only connector sync message を送る adapter です。 */
export class SqsConnectorSyncQueue implements ConnectorSyncQueue {
  /** AWS SDK SQS client です。 */
  private readonly client: SQSClient
  /** Connector sync queue URL です。 */
  private readonly queueUrl: string

  /** SQS connector sync queue adapter を作成します。 */
  constructor(client: SQSClient, queueUrl: string) {
    this.client = client
    this.queueUrl = readQueueUrl(queueUrl)
  }

  /** Runtime validation 済みの ID-only JSON message を送信します。 */
  async enqueue(message: ConnectorSyncQueueMessage) {
    const normalized = normalizeQueueMessage(message)
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(normalized),
    }))
  }
}

/** Poll cursor を queue 外で保持する optimistic-concurrency checkpoint です。 */
export type ConnectorPollCheckpoint = {
  /** Store-level CAS revision です。 */
  revision: number
  /** Provider が返した opaque continuation cursor です。 */
  cursor?: string
}

/** Poll checkpoint の tenant/resource locator です。 */
export type ConnectorPollCheckpointKey = {
  /** Checkpoint が属する Workspace ID です。 */
  workspaceId: string
  /** Poll 対象 connector installation ID です。 */
  installationId: string
  /** Poll 対象 provider resource type です。 */
  resourceType: ConnectorWorkItemResourceType
}

/** Poll checkpoint の compare-and-set 入力です。 */
export type CommitConnectorPollCheckpointInput = ConnectorPollCheckpointKey & {
  /** Existing checkpoint が存在する場合の expected revision です。 */
  expectedRevision?: number
  /** 次 invocation が読む provider cursor です。完了時は省略します。 */
  nextCursor?: string
}

/** Provider cursor を queue payload から分離して保持する durable store です。 */
export interface ConnectorPollCheckpointStore {
  /**
   * Current checkpoint を consistent read します。
   *
   * @remarks
   * Cursor は provider data のため、production 実装では暗号化された保存領域を使います。
   */
  get(key: ConnectorPollCheckpointKey): Promise<ConnectorPollCheckpoint | undefined>
  /** Expected revision と一致する場合だけ次 cursor/revision を保存します。 */
  compareAndSet(input: CommitConnectorPollCheckpointInput): Promise<boolean>
}

/** Connector worker が current state の再読込に使う platform subset です。 */
export type ConnectorSyncWorkerPlatform = Pick<
  DeveloperPlatformClient,
  | 'listConnectors'
  | 'listExternalWorkItemLinks'
  | 'pauseConnectorExternalLinksPage'
>

/** Durable worker が呼び出す connector sync engine subset です。 */
export type ConnectorSyncWorkerEngine = Pick<
  ConnectorSyncEngine,
  'processOutbound' | 'pollInstallation'
>

/** Connector sync queue worker の注入可能 dependencies です。 */
export type ConnectorSyncWorkerDependencies = {
  /** Current installation/link state を返す authoritative store です。 */
  platform: ConnectorSyncWorkerPlatform
  /** Provider 処理が必要な message だけで sync engine を遅延取得します。 */
  getEngine: () => Promise<ConnectorSyncWorkerEngine>
  /** Follow-up outbound/poll message を送る durable queue です。 */
  queue: ConnectorSyncQueue
  /** Provider cursor を secret-free queue の外で保持する store です。 */
  checkpoints: ConnectorPollCheckpointStore
  /** Inventory continuation message を処理する global secret-free inventory です。 */
  inventory?: ConnectorPollInventory
  /** 1 poll message で読む provider page 上限です。 */
  maximumPollPages?: number
  /** 1 inventory continuation message で読む global inventory page 上限です。 */
  maximumInventoryPages?: number
  /** 1 disconnect continuation message でpauseする link 上限です。 */
  maximumDisconnectLinks?: number
}

/** Global schedule inventory が返す secret-free poll target です。 */
export type ConnectorPollInventoryTarget = {
  /** Installation が属する Workspace ID です。 */
  workspaceId: string
  /** Connected connector installation ID です。 */
  installationId: string
  /** Inbound link が存在する provider resource type です。 */
  resourceType: ConnectorWorkItemResourceType
}

/** Global connector poll inventory の1 page です。 */
export type ConnectorPollInventoryPage = {
  /** Secret-free installation/resource locators です。 */
  targets: ConnectorPollInventoryTarget[]
  /** Global index の次 page を読む internal cursor です。 */
  nextCursor?: string
}

/** Workspace ID を事前に知らない schedule 用 global inventory boundary です。 */
export interface ConnectorPollInventory {
  /**
   * Connected installation または inbound external link の global index を列挙します。
   *
   * @remarks
   * Credential、external URL、provider cursor は返さず、ID locator だけを返します。
   */
  listPollTargets(cursor?: string): Promise<ConnectorPollInventoryPage>
}

/** EventBridge などから受ける connector poll schedule input です。 */
export type ConnectorPollScheduleEvent = {
  /** Durable continuation job が引き継いだ global inventory cursor です。 */
  cursor?: string
  /** 1 invocation で列挙する global inventory page 上限です。 */
  maximumPages?: number
}

/** Global poll inventory schedule の dependencies です。 */
export type ConnectorPollScheduleDependencies = {
  /** Workspace 横断の secret-free poll inventory です。 */
  inventory: ConnectorPollInventory
  /** ID-only poll messages を送る durable queue です。 */
  queue: ConnectorSyncQueue
  /** Event input が省略した場合の inventory page 上限です。 */
  maximumPages?: number
}

/** Global poll inventory schedule の処理結果です。 */
export type ConnectorPollScheduleResult = {
  /** 読み終えた inventory page 数です。 */
  pages: number
  /** 重複排除後に enqueue した poll target 数です。 */
  enqueued: number
  /** Page 上限後の continuation job を durable queue へ保存したかです。 */
  continuationQueued: boolean
}

/** DynamoDB Streams image の必要最小 AttributeValue 表現です。 */
export type ConnectorSyncDynamoAttributeValue = {
  /** String value です。 */
  S?: string
  /** Number を表す string value です。 */
  N?: string
  /** Boolean value です。 */
  BOOL?: boolean
  /** Null marker です。 */
  NULL?: boolean
  /** List value です。 */
  L?: ConnectorSyncDynamoAttributeValue[]
  /** Map value です。 */
  M?: Record<string, ConnectorSyncDynamoAttributeValue>
  /** String set です。 */
  SS?: string[]
  /** Number set です。 */
  NS?: string[]
}

/** AuditEventsTable stream の1 record です。 */
export type ConnectorSyncDynamoStreamRecord = {
  /** INSERT、MODIFY、REMOVE の event kind です。 */
  eventName?: string
  /** Mutation 後 image と partial-batch checkpoint です。 */
  dynamodb?: {
    /** Mutation 後の Audit event image です。 */
    NewImage?: Record<string, ConnectorSyncDynamoAttributeValue>
    /** Partial batch failure に返す stream sequence number です。 */
    SequenceNumber?: string
  }
}

/** AuditEventsTable stream Lambda event の最小表現です。 */
export type ConnectorSyncDynamoStreamEvent = {
  /** 同じ batch に含まれる stream records です。 */
  Records?: ConnectorSyncDynamoStreamRecord[]
}

/** SQS Lambda event の1 record です。 */
export type ConnectorSyncSqsRecord = {
  /** Partial batch failure に返す SQS message ID です。 */
  messageId?: string
  /** Serialized ConnectorSyncQueueMessage です。 */
  body?: string
}

/** SQS Lambda event の最小表現です。 */
export type ConnectorSyncSqsEvent = {
  /** 同じ batch に含まれる queue records です。 */
  Records?: ConnectorSyncSqsRecord[]
}

/** Lambda partial batch response の1 failure です。 */
export type ConnectorSyncBatchItemFailure = {
  /** Retry する stream sequence number または SQS message ID です。 */
  itemIdentifier: string
}

/** DynamoDB Streams/SQS 共通の Lambda partial batch response です。 */
export type ConnectorSyncBatchResponse = {
  /** Retry 対象 records です。 */
  batchItemFailures: ConnectorSyncBatchItemFailure[]
}

/** Audit projection が必要とする dependencies です。 */
export type ConnectorSyncAuditProjectionDependencies = {
  /** Work Item change locator を送る durable queue です。 */
  queue: ConnectorSyncQueue
}

/**
 * AuditEventsTable の Work Item/link changes を ID-only queue message へ射影します。
 *
 * @remarks
 * `/connector-sync` route または connector-sync request ID の event は loop 抑止のため skip します。
 */
export async function processConnectorSyncAuditProjectionBatch(
  event: ConnectorSyncDynamoStreamEvent,
  dependencies: ConnectorSyncAuditProjectionDependencies,
): Promise<ConnectorSyncBatchResponse> {
  const results = await Promise.all((event.Records ?? []).map(async (record) => {
    try {
      await projectAuditRecord(record, dependencies)
      return undefined
    } catch (error) {
      console.error('Connector sync audit projection failed.', readSafeError(error))
      return createDynamoBatchFailure(record)
    }
  }))
  return { batchItemFailures: results.filter(isDefined) }
}

/** SQS batch を message 単位で処理し、失敗した message だけを再試行します。 */
export async function processConnectorSyncWorkerBatch(
  event: ConnectorSyncSqsEvent,
  dependencies: ConnectorSyncWorkerDependencies,
): Promise<ConnectorSyncBatchResponse> {
  const results = await Promise.all((event.Records ?? []).map(async (record) => {
    try {
      await processConnectorSyncMessage(
        parseConnectorSyncQueueMessage(record.body),
        dependencies,
      )
      return undefined
    } catch (error) {
      console.error('Connector sync worker failed.', readSafeError(error))
      return createSqsBatchFailure(record)
    }
  }))
  return { batchItemFailures: results.filter(isDefined) }
}

/**
 * Validated queue message を current installation/link state の再読込付きで処理します。
 */
export async function processConnectorSyncMessage(
  message: ConnectorSyncQueueMessage,
  dependencies: ConnectorSyncWorkerDependencies,
): Promise<void> {
  const normalized = normalizeQueueMessage(message)
  if (normalized.kind === 'work-item-changed') {
    await enqueueCurrentOutboundLinks(normalized, dependencies)
    return
  }
  if (normalized.kind === 'outbound') {
    await processCurrentOutboundLink(normalized, dependencies)
    return
  }
  if (normalized.kind === 'poll-inventory') {
    if (!dependencies.inventory) {
      throw new TypeError('Connector poll inventory is not configured.')
    }
    await scheduleConnectorPollInventory({
      cursor: normalized.cursor,
      ...(dependencies.maximumInventoryPages === undefined
        ? {}
        : { maximumPages: dependencies.maximumInventoryPages }),
    }, {
      inventory: dependencies.inventory,
      queue: dependencies.queue,
    })
    return
  }
  if (normalized.kind === 'disconnect-links') {
    const page = await dependencies.platform.pauseConnectorExternalLinksPage({
      workspaceId: normalized.workspaceId,
      installationId: normalized.installationId,
      expectedLifecycleRevision: normalized.lifecycleRevision,
      ...(normalized.updatedByUserId
        ? { updatedByUserId: normalized.updatedByUserId }
        : {}),
      limit: readPageLimit(
        dependencies.maximumDisconnectLinks ?? 25,
        'Connector disconnect page limit',
      ),
      ...(normalized.cursor ? { cursor: normalized.cursor } : {}),
    })
    if (page.nextCursor) {
      await dependencies.queue.enqueue({
        ...normalized,
        cursor: page.nextCursor,
      })
    }
    return
  }
  await pollCurrentInstallation(normalized, dependencies)
}

/**
 * Workspace を事前に知らない schedule から global inventory を列挙し、poll を enqueue します。
 */
export async function scheduleConnectorPollInventory(
  event: ConnectorPollScheduleEvent,
  dependencies: ConnectorPollScheduleDependencies,
): Promise<ConnectorPollScheduleResult> {
  const maximumPages = readPageLimit(
    event.maximumPages ?? dependencies.maximumPages ?? 100,
    'Connector poll inventory page limit',
  )
  const enqueuedTargets = new Set<string>()
  let cursor = event.cursor === undefined
    ? undefined
    : readProviderCursor(event.cursor, 'Connector poll inventory cursor')
  const visitedCursors = new Set(cursor ? [cursor] : [])
  let pages = 0
  while (pages < maximumPages) {
    const page = await dependencies.inventory.listPollTargets(cursor)
    pages += 1
    const messages = page.targets.flatMap((target) => {
      const message = normalizeQueueMessage({
        version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
        kind: 'poll',
        workspaceId: target.workspaceId,
        installationId: target.installationId,
        resourceType: target.resourceType,
      })
      if (message.kind !== 'poll') {
        throw new TypeError('Connector poll inventory produced an invalid target.')
      }
      const targetKey = createPollTargetKey(message)
      if (enqueuedTargets.has(targetKey)) return []
      enqueuedTargets.add(targetKey)
      return [message]
    })
    await Promise.all(messages.map((message) => dependencies.queue.enqueue(message)))
    if (page.nextCursor === undefined) {
      return {
        pages,
        enqueued: enqueuedTargets.size,
        continuationQueued: false,
      }
    }
    const nextCursor = readProviderCursor(page.nextCursor, 'Connector poll inventory cursor')
    if (nextCursor === cursor || visitedCursors.has(nextCursor)) {
      throw new TypeError('Connector poll inventory cursor did not advance.')
    }
    visitedCursors.add(nextCursor)
    cursor = nextCursor
  }
  if (!cursor) {
    throw new TypeError('Connector poll inventory continuation cursor is missing.')
  }
  await dependencies.queue.enqueue({
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'poll-inventory',
    cursor,
  })
  return {
    pages,
    enqueued: enqueuedTargets.size,
    continuationQueued: true,
  }
}

/** Outbound retries で固定する deterministic operation ID を作成します。 */
export function createConnectorOutboundOperationId(
  message: ConnectorOutboundMessage,
): string {
  const normalized = normalizeQueueMessage(message)
  if (normalized.kind !== 'outbound') {
    throw new TypeError('Connector outbound message is required.')
  }
  return createHash('sha256')
    .update(
      `connector-sync-outbound-worker-v1\0${normalized.workspaceId}\0` +
      `${normalized.linkId}\0${normalized.sourceEventId}`,
    )
    .digest('hex')
}

/** JSON body を strict versioned connector sync message として検証します。 */
export function parseConnectorSyncQueueMessage(
  body: string | undefined,
): ConnectorSyncQueueMessage {
  if (body === undefined || body.length === 0) {
    throw new TypeError('Connector sync queue body is required.')
  }
  if (Buffer.byteLength(body, 'utf8') > maximumQueueBodyBytes) {
    throw new TypeError('Connector sync queue body is too large.')
  }
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    throw new TypeError('Connector sync queue body must be valid JSON.')
  }
  return normalizeQueueMessage(value)
}

async function projectAuditRecord(
  record: ConnectorSyncDynamoStreamRecord,
  dependencies: ConnectorSyncAuditProjectionDependencies,
) {
  if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) return
  const stored = unmarshalDynamoMap(record.dynamodb.NewImage)
  if (stored.outboxStatus !== 'pending') return
  const event = upcastAuditEvent(stored)
  if (event.outboxStatus !== 'pending') return
  if (event.eventType === 'connector.status.updated') {
    const disconnect = readAuditConnectorDisconnectIdentity(event)
    if (disconnect) {
      await dependencies.queue.enqueue({
        version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
        kind: 'disconnect-links',
        workspaceId: event.workspaceId,
        installationId: disconnect.installationId,
        lifecycleRevision: disconnect.lifecycleRevision,
        ...(event.actor.kind === 'user'
          ? { updatedByUserId: readIdentifier(event.actor.id, 'Audit actor User ID') }
          : {}),
      })
    }
    return
  }
  if (isConnectorSyncOrigin(event)) return
  if (event.eventType === 'work-item.updated') {
    const identity = readAuditWorkItemIdentity(event)
    await dependencies.queue.enqueue({
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'work-item-changed',
      workspaceId: event.workspaceId,
      teamId: identity.teamId,
      workItemId: identity.workItemId,
      sourceEventId: event.eventId,
    })
    return
  }
  if (
    event.eventType !== 'external-link.created' &&
    event.eventType !== 'external-link.updated'
  ) return
  const link = readAuditExternalLinkIdentity(event)
  if (
    event.metadata?.cause === 'connector-disconnected' &&
    event.metadata.syncStatus === 'paused'
  ) return
  const messages: ConnectorSyncQueueMessage[] = []
  if (link.syncDirection === 'outbound' || link.syncDirection === 'bidirectional') {
    messages.push({
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'outbound',
      workspaceId: event.workspaceId,
      linkId: link.linkId,
      sourceEventId: event.eventId,
    })
  }
  if (link.syncDirection === 'inbound' || link.syncDirection === 'bidirectional') {
    messages.push({
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'poll',
      workspaceId: event.workspaceId,
      installationId: link.installationId,
      resourceType: link.resourceType,
    })
  }
  await Promise.all(messages.map((message) => dependencies.queue.enqueue(message)))
}

async function enqueueCurrentOutboundLinks(
  message: ConnectorWorkItemChangedMessage,
  dependencies: ConnectorSyncWorkerDependencies,
) {
  const links = await dependencies.platform.listExternalWorkItemLinks({
    workspaceId: message.workspaceId,
    teamId: message.teamId,
    workItemId: message.workItemId,
  })
  const current = links.filter((link) =>
    link.teamId === message.teamId &&
    link.workItemId === message.workItemId &&
    link.syncStatus !== 'paused' &&
    link.syncStatus !== 'conflict' &&
    (link.syncDirection === 'outbound' || link.syncDirection === 'bidirectional')
  )
  await Promise.all(current.map((link) => dependencies.queue.enqueue({
    version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
    kind: 'outbound',
    workspaceId: message.workspaceId,
    linkId: link.id,
    sourceEventId: message.sourceEventId,
  })))
}

async function processCurrentOutboundLink(
  message: ConnectorOutboundMessage,
  dependencies: ConnectorSyncWorkerDependencies,
) {
  const link = (await dependencies.platform.listExternalWorkItemLinks({
    workspaceId: message.workspaceId,
    linkId: message.linkId,
  }))[0]
  if (
    !link ||
    link.syncStatus === 'paused' ||
    link.syncStatus === 'conflict' ||
    (
      link.syncDirection !== 'outbound' &&
      link.syncDirection !== 'bidirectional'
    )
  ) return
  const engine = await dependencies.getEngine()
  await engine.processOutbound({
    workspaceId: message.workspaceId,
    link,
    operationId: createConnectorOutboundOperationId(message),
  })
}

async function pollCurrentInstallation(
  message: ConnectorPollMessage,
  dependencies: ConnectorSyncWorkerDependencies,
) {
  const key: ConnectorPollCheckpointKey = {
    workspaceId: message.workspaceId,
    installationId: message.installationId,
    resourceType: message.resourceType,
  }
  const [installations, storedCheckpoint] = await Promise.all([
    dependencies.platform.listConnectors(message.workspaceId),
    dependencies.checkpoints.get(key),
  ])
  const installation = installations.find((candidate) => candidate.id === message.installationId)
  if (!installation || installation.status !== 'connected') return
  const checkpoint = normalizeCheckpoint(storedCheckpoint)
  const engine = await dependencies.getEngine()
  const result = await engine.pollInstallation({
    ...key,
    ...(checkpoint?.cursor ? { cursor: checkpoint.cursor } : {}),
    maximumPages: readPageLimit(
      dependencies.maximumPollPages ?? 10,
      'Connector poll page limit',
    ),
  })
  const nextCursor = result.nextCursor === undefined
    ? undefined
    : readProviderCursor(result.nextCursor, 'Connector poll cursor')
  if (nextCursor !== undefined && nextCursor === checkpoint?.cursor) {
    throw new TypeError('Connector poll cursor did not advance.')
  }
  const committed = await dependencies.checkpoints.compareAndSet({
    ...key,
    ...(checkpoint ? { expectedRevision: checkpoint.revision } : {}),
    ...(nextCursor ? { nextCursor } : {}),
  })
  if (committed && nextCursor) await dependencies.queue.enqueue(message)
}

function normalizeQueueMessage(value: unknown): ConnectorSyncQueueMessage {
  if (!isRecord(value)) throw new TypeError('Connector sync queue message must be an object.')
  if (value.version !== CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION) {
    throw new TypeError('Connector sync queue message version is unsupported.')
  }
  if (value.kind === 'work-item-changed') {
    assertExactKeys(value, [
      'version',
      'kind',
      'workspaceId',
      'teamId',
      'workItemId',
      'sourceEventId',
    ])
    return {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'work-item-changed',
      workspaceId: readIdentifier(value.workspaceId, 'Workspace ID'),
      teamId: readIdentifier(value.teamId, 'Team ID'),
      workItemId: readIdentifier(value.workItemId, 'Work Item ID'),
      sourceEventId: readIdentifier(value.sourceEventId, 'Source event ID'),
    }
  }
  if (value.kind === 'outbound') {
    assertExactKeys(value, ['version', 'kind', 'workspaceId', 'linkId', 'sourceEventId'])
    return {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'outbound',
      workspaceId: readIdentifier(value.workspaceId, 'Workspace ID'),
      linkId: readIdentifier(value.linkId, 'External link ID'),
      sourceEventId: readIdentifier(value.sourceEventId, 'Source event ID'),
    }
  }
  if (value.kind === 'poll') {
    assertExactKeys(value, ['version', 'kind', 'workspaceId', 'installationId', 'resourceType'])
    return {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'poll',
      workspaceId: readIdentifier(value.workspaceId, 'Workspace ID'),
      installationId: readIdentifier(value.installationId, 'Connector installation ID'),
      resourceType: readResourceType(value.resourceType),
    }
  }
  if (value.kind === 'poll-inventory') {
    assertExactKeys(value, ['version', 'kind', 'cursor'])
    return {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'poll-inventory',
      cursor: readProviderCursor(value.cursor, 'Connector poll inventory cursor'),
    }
  }
  if (value.kind === 'disconnect-links') {
    assertExactKeys(value, [
      'version',
      'kind',
      'workspaceId',
      'installationId',
      'lifecycleRevision',
      ...(value.updatedByUserId === undefined ? [] : ['updatedByUserId']),
      ...(value.cursor === undefined ? [] : ['cursor']),
    ])
    return {
      version: CONNECTOR_SYNC_QUEUE_MESSAGE_VERSION,
      kind: 'disconnect-links',
      workspaceId: readIdentifier(value.workspaceId, 'Workspace ID'),
      installationId: readIdentifier(value.installationId, 'Connector installation ID'),
      lifecycleRevision: readPositiveInteger(
        value.lifecycleRevision,
        'Connector lifecycle revision',
      ),
      ...(value.updatedByUserId === undefined
        ? {}
        : { updatedByUserId: readIdentifier(value.updatedByUserId, 'Connector updater User ID') }),
      ...(value.cursor === undefined
        ? {}
        : { cursor: readProviderCursor(value.cursor, 'Connector disconnect cursor') }),
    }
  }
  throw new TypeError('Connector sync queue message kind is unsupported.')
}

function readAuditWorkItemIdentity(event: AuditEventV1) {
  const metadata = event.metadata
  const teamId = readOptionalIdentifier(metadata?.teamId, 'Audit Team ID')
  const workItemId = readOptionalIdentifier(metadata?.issueId, 'Audit Work Item ID')
  if (teamId && workItemId) return { teamId, workItemId }
  const match = /^team\/([^/]+)\/issue\/([^/]+)$/.exec(event.entity.id)
  if (!match?.[1] || !match[2]) {
    throw new TypeError('Work Item audit event is missing its Team/Work Item identity.')
  }
  return {
    teamId: readIdentifier(match[1], 'Audit Team ID'),
    workItemId: readIdentifier(match[2], 'Audit Work Item ID'),
  }
}

function readAuditExternalLinkIdentity(event: AuditEventV1) {
  const metadata = event.metadata
  const linkId = readOptionalIdentifier(
    metadata?.externalLinkId,
    'Audit external link ID',
  ) ?? readIdentifier(event.entity.id, 'Audit external link ID')
  const installationId = readIdentifier(
    metadata?.installationId,
    'Audit connector installation ID',
  )
  const resourceType = readResourceType(metadata?.resourceType)
  const syncDirection = metadata?.syncDirection
  if (
    syncDirection !== 'inbound' &&
    syncDirection !== 'outbound' &&
    syncDirection !== 'bidirectional' &&
    syncDirection !== 'none'
  ) throw new TypeError('Audit connector sync direction is invalid.')
  return { linkId, installationId, resourceType, syncDirection }
}

function readAuditConnectorDisconnectIdentity(event: AuditEventV1) {
  const metadata = event.metadata
  if (
    metadata?.adapter !== 'developer-platform' ||
    metadata.status !== 'disconnected'
  ) return undefined
  if (event.entity.type !== 'connector-installation') {
    throw new TypeError('Connector disconnect audit entity type is invalid.')
  }
  return {
    installationId: readIdentifier(
      event.entity.id,
      'Audit connector installation ID',
    ),
    lifecycleRevision: readPositiveInteger(
      metadata.disconnectCleanupRevision,
      'Audit connector disconnect cleanup revision',
    ),
  }
}

function isConnectorSyncOrigin(event: AuditEventV1) {
  const route = event.sourceDetails?.route
  if (route === '/connector-sync' || route?.startsWith('/connector-sync/')) return true
  return event.source === 'system' &&
    event.sourceDetails?.requestId?.startsWith('connector-sync-') === true
}

function normalizeCheckpoint(
  value: ConnectorPollCheckpoint | undefined,
): ConnectorPollCheckpoint | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new TypeError('Connector poll checkpoint revision is invalid.')
  }
  return {
    revision: value.revision,
    ...(value.cursor === undefined
      ? {}
      : { cursor: readProviderCursor(value.cursor, 'Connector poll checkpoint cursor') }),
  }
}

function readResourceType(value: unknown): ConnectorWorkItemResourceType {
  if (
    value === 'issue' ||
    value === 'merge-request' ||
    value === 'commit' ||
    value === 'deploy'
  ) return value
  throw new TypeError('Connector resource type is invalid.')
}

function readIdentifier(value: unknown, label: string) {
  if (typeof value !== 'string') throw new TypeError(`${label} is required.`)
  const normalized = value.trim()
  if (
    !normalized ||
    normalized.length > maximumIdentifierLength ||
    hasControlCharacter(normalized)
  ) {
    throw new TypeError(`${label} is invalid.`)
  }
  return normalized
}

function readOptionalIdentifier(value: unknown, label: string) {
  return value === undefined ? undefined : readIdentifier(value, label)
}

function readProviderCursor(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximumProviderCursorLength ||
    hasControlCharacter(value)
  ) {
    throw new TypeError(`${label} is invalid.`)
  }
  return value
}

function readPageLimit(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new RangeError(`${label} must be an integer between 1 and 100.`)
  }
  return value
}

function readPositiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new RangeError(`${label} must be a positive integer.`)
  }
  return Number(value)
}

function readQueueUrl(value: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 2_048) {
    throw new TypeError('Connector sync queue URL is invalid.')
  }
  return normalized
}

function createPollTargetKey(message: ConnectorPollMessage) {
  return `${message.workspaceId}\0${message.installationId}\0${message.resourceType}`
}

function hasControlCharacter(value: string) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f)
  })
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
) {
  const expected = new Set(expectedKeys)
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new TypeError('Connector sync queue message contains unsupported fields.')
  }
}

function unmarshalDynamoMap(
  value: Record<string, ConnectorSyncDynamoAttributeValue>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, attribute]) => [
      key,
      unmarshalDynamoAttribute(attribute),
    ]),
  )
}

function unmarshalDynamoAttribute(value: ConnectorSyncDynamoAttributeValue): unknown {
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
  record: ConnectorSyncDynamoStreamRecord,
): ConnectorSyncBatchItemFailure {
  const identifier = record.dynamodb?.SequenceNumber?.trim()
  if (!identifier) throw new TypeError('DynamoDB stream sequence number is required.')
  return { itemIdentifier: identifier }
}

function createSqsBatchFailure(
  record: ConnectorSyncSqsRecord,
): ConnectorSyncBatchItemFailure {
  const identifier = record.messageId?.trim()
  if (!identifier) throw new TypeError('SQS message ID is required.')
  return { itemIdentifier: identifier }
}

function readSafeError(error: unknown) {
  if (!isRecord(error)) return { name: 'UnknownError' }
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined
}
