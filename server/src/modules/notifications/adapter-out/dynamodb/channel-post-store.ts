import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  NOTIFICATION_MESSAGE_LOCALES,
  isNotificationChannelPostEventType,
  parseNotificationMessage,
  type NotificationMessageLocale,
} from '@mukuroji/contracts'
import { createWorkspaceMemberAuditEntityId, type AuditTransactWriteItem } from '../../../audit'
import type {
  ChannelDestinationState,
  ChannelDestinationStore,
  ChannelPost,
  ChannelPostContent,
  ChannelPostSource,
  ChannelPostStore,
  DeleteChannelDestinationInput,
  SaveChannelDestinationInput,
} from '../../application/ports/channel-posts'
import {
  channelDestinationTargetKey,
  isChannelDestinationSecretVersion,
  type ChannelDestinationRecord,
  type ChannelDestinationTarget,
} from '../../domain/channel-destination'
import { NotificationError } from '../../domain/notification-error'

/**
 * Partition suffix of a Workspace's channel destination rows. Member partitions always contain an
 * `@`, so `!`-prefixed suffixes never collide with them, and the `<workspaceId>#` prefix keeps the
 * rows inside the Workspace's tenant deletion and export range.
 */
const destinationPartitionSuffix = '!channel-destinations'

/** Partition suffix of a Workspace's queued channel posts. */
const postPartitionSuffix = '!channel-posts'

/** Item type of a destination row. */
const destinationItemType = 'channel-destination'

/** Item type of a queued post row. */
const postItemType = 'channel-post'

/**
 * Number of queue partitions for channel posts. Posts share the personal Slack due index under
 * their own `slack-channel#<n>` partitions, which the personal Slack worker never reads.
 */
export const CHANNEL_POST_SHARDS = 4

/** Days a queued or sent post row is kept before DynamoDB TTL removes it. */
const postRetentionSeconds = 30 * 24 * 60 * 60

/** Index pages read per partition per run before the rest waits for the next run. */
const maximumDuePages = 4

/**
 * Lists the queue partitions of channel posts.
 * @returns `slack-channel#0` to `slack-channel#<n-1>`.
 */
export function channelPostShards(): string[] {
  return Array.from({ length: CHANNEL_POST_SHARDS }, (_, index) => `slack-channel#${index}`)
}

/**
 * Picks the queue partition of a post from its event ID.
 * @param eventId - Audit event ID.
 * @returns Stable queue partition.
 */
function channelPostShard(eventId: string): string {
  let hash = 0
  for (const character of eventId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0
  return `slack-channel#${hash % CHANNEL_POST_SHARDS}`
}

/** DynamoDB store for channel destination settings and the channel post queue. */
export class DynamoDbChannelPostStore implements ChannelDestinationStore, ChannelPostStore {
  /** DocumentClient used for reads and writes. */
  readonly #client: Pick<DynamoDBDocumentClient, 'send'>
  /** NotificationsTable name. */
  readonly #tableName: string
  /** Workspace Audit pseudonym key, needed only when audit events name a member. */
  readonly #auditPseudonymKey: string | undefined

  /**
   * Creates the store.
   * @param client - DocumentClient bound to the NotificationsTable region.
   * @param tableName - NotificationsTable name.
   * @param auditPseudonymKey - Workspace Audit pseudonym key, used for member audit entity IDs.
   */
  constructor(client: Pick<DynamoDBDocumentClient, 'send'>, tableName: string, auditPseudonymKey?: string) {
    const name = tableName.trim()
    if (!name) throw new Error('Notifications table name is required.')
    this.#client = client
    this.#tableName = name
    this.#auditPseudonymKey = auditPseudonymKey
  }

  /** @inheritdoc */
  async get(workspaceId: string, target: ChannelDestinationTarget): Promise<ChannelDestinationRecord | undefined> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName, Key: destinationKey(workspaceId, target), ConsistentRead: true,
    }))
    return parseDestinationRow(response.Item, workspaceId, target)
  }

  /** @inheritdoc */
  async getRevision(workspaceId: string, target: ChannelDestinationTarget): Promise<number> {
    return (await this.getState(workspaceId, target)).revision
  }

  /** @inheritdoc */
  async getState(workspaceId: string, target: ChannelDestinationTarget): Promise<ChannelDestinationState> {
    const response = await this.#client.send(new GetCommand({
      TableName: this.#tableName, Key: destinationKey(workspaceId, target), ConsistentRead: true,
    }))
    if (!response.Item) return { revision: 0 }
    const record = parseDestinationRow(response.Item, workspaceId, target)
    const revision: unknown = response.Item.revision
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) throw new Error('Invalid notification channel destination row.')
    return record ? { record, revision } : { revision }
  }

  /** @inheritdoc */
  personalAuditEntityId(workspaceId: string, memberKey: string): string {
    if (!this.#auditPseudonymKey) throw new NotificationError(503, 'NotificationAuditUnavailable', 'Notification audit is not configured.')
    return `${createWorkspaceMemberAuditEntityId(workspaceId, memberKey, this.#auditPseudonymKey)}/slack-destination`
  }

  /** @inheritdoc */
  async save(input: SaveChannelDestinationInput): Promise<ChannelDestinationRecord> {
    const record: ChannelDestinationRecord = {
      target: input.target,
      provider: 'slack',
      ...(input.label ? { label: input.label } : {}),
      locale: input.locale,
      revision: input.expectedRevision + 1,
      updatedAt: input.now.toISOString(),
      updatedBy: input.updatedBy,
      secretVersion: input.secretVersion,
    }
    const checks = input.authorizationConditionChecks ?? []
    await this.#transact([
      {
        Put: {
          TableName: this.#tableName,
          Item: {
            ...destinationKey(input.workspaceId, input.target),
            itemType: destinationItemType,
            workspaceId: input.workspaceId,
            scope: input.target.scope,
            teamId: input.target.teamId,
            ...(input.target.scope === 'project' ? { projectId: input.target.projectId } : {}),
            provider: record.provider,
            ...(record.label ? { label: record.label } : {}),
            locale: record.locale,
            revision: record.revision,
            updatedAt: record.updatedAt,
            updatedBy: record.updatedBy,
            secretVersion: record.secretVersion,
          },
          ...revisionCondition(input.expectedRevision),
        },
      },
      ...checks,
      ...(input.auditPut ? [input.auditPut] : []),
    ], checks.length)
    return record
  }

  /** @inheritdoc */
  async delete(input: DeleteChannelDestinationInput): Promise<void> {
    const checks = input.authorizationConditionChecks ?? []
    await this.#transact([
      {
        // A removed destination keeps its revision, so a request read before the removal can
        // never change a destination registered again later.
        Put: {
          TableName: this.#tableName,
          Item: {
            ...destinationKey(input.workspaceId, input.target),
            itemType: destinationItemType,
            workspaceId: input.workspaceId,
            scope: input.target.scope,
            teamId: input.target.teamId,
            ...(input.target.scope === 'project' ? { projectId: input.target.projectId } : {}),
            removed: true,
            revision: input.expectedRevision + 1,
          },
          ...revisionCondition(input.expectedRevision),
        },
      },
      ...checks,
      ...(input.auditPut ? [input.auditPut] : []),
    ], checks.length)
  }

  /** @inheritdoc */
  async enqueue(post: ChannelPostContent, now: Date): Promise<void> {
    const shard = channelPostShard(post.eventId)
    try {
      await this.#client.send(new PutCommand({
        TableName: this.#tableName,
        Item: {
          ...postKey(post.workspaceId, post.eventId),
          itemType: postItemType,
          workspaceId: post.workspaceId,
          eventId: post.eventId,
          eventType: post.eventType,
          scope: post.target.scope,
          teamId: post.target.teamId,
          ...(post.target.scope === 'project' ? { projectId: post.target.projectId } : {}),
          ...(post.title ? { title: post.title } : {}),
          ...(post.workItemKey ? { workItemKey: post.workItemKey } : {}),
          ...(post.summary ? { summary: post.summary } : {}),
          ...(post.message ? { message: post.message } : {}),
          ...(post.deepLink ? { deepLink: post.deepLink } : {}),
          occurredAt: post.occurredAt,
          source: {
            teamId: post.source.teamId,
            ...(post.source.projectId ? { projectId: post.source.projectId } : {}),
            ...(post.source.issueId ? { issueId: post.source.issueId } : {}),
            ...(post.source.dueDate ? { dueDate: post.source.dueDate } : {}),
            ...(post.source.entityId ? { entityId: post.source.entityId } : {}),
            ...(post.source.planningTargetRecordKey ? { planningTargetRecordKey: post.source.planningTargetRecordKey } : {}),
          },
          version: 1,
          slackQueueShard: shard,
          slackNextAttemptAt: now.toISOString(),
          slackDeliveryStatus: 'pending',
          slackAttempts: 0,
          expiresAt: Math.floor(now.getTime() / 1_000) + postRetentionSeconds,
        },
        ConditionExpression: 'attribute_not_exists(recipientKey)',
      }))
    } catch (error) {
      // A retried projection queues the same event again; the first post stands.
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return
      throw error
    }
  }

  /** @inheritdoc */
  async listDue(shard: string, now: Date, limit: number) {
    const posts: ChannelPost[] = []
    let invalidCount = 0
    let startKey: Record<string, unknown> | undefined
    // Unreadable rows stay queued and fail the run; later pages keep valid posts moving past them.
    for (let pageCount = 0; pageCount < maximumDuePages && posts.length < limit; pageCount += 1) {
      const page = await this.#client.send(new QueryCommand({
        TableName: this.#tableName, IndexName: 'SlackDeliveryIndex',
        KeyConditionExpression: 'slackQueueShard = :shard AND slackNextAttemptAt <= :now',
        ExpressionAttributeValues: { ':shard': shard, ':now': now.toISOString() },
        Limit: limit - posts.length,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }))
      for (const candidate of page.Items ?? []) {
        if (typeof candidate.recipientKey !== 'string' || typeof candidate.notificationKey !== 'string') {
          invalidCount += 1
          continue
        }
        const response = await this.#client.send(new GetCommand({
          TableName: this.#tableName, ConsistentRead: true,
          Key: { recipientKey: candidate.recipientKey, notificationKey: candidate.notificationKey },
        }))
        try {
          const post = parsePostRow(response.Item, shard, now)
          if (post) posts.push(post)
        } catch {
          invalidCount += 1
        }
      }
      startKey = page.LastEvaluatedKey
      if (!startKey) break
    }
    return { posts, invalidCount }
  }

  /** @inheritdoc */
  async claim(post: ChannelPost, token: string, leaseUntil: Date): Promise<boolean> {
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: postKey(post.workspaceId, post.eventId),
        ConditionExpression: '#version = :version AND slackNextAttemptAt = :due AND slackQueueShard = :shard',
        UpdateExpression: 'SET slackLeaseToken = :token, slackNextAttemptAt = :lease, slackDeliveryStatus = :sending ADD #version :one, slackAttempts :one',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':version': post.version, ':due': post.nextAttemptAt, ':shard': post.shard, ':token': token,
          ':lease': leaseUntil.toISOString(), ':sending': 'sending', ':one': 1,
        },
      }))
      return true
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false
      throw error
    }
  }

  /** @inheritdoc */
  async renew(post: ChannelPost, token: string, now: Date): Promise<boolean> {
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: postKey(post.workspaceId, post.eventId),
        ConditionExpression: 'slackLeaseToken = :token AND slackNextAttemptAt > :now AND #version = :version',
        UpdateExpression: 'SET slackNextAttemptAt = :lease ADD #version :one',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':token': token, ':now': now.toISOString(), ':version': post.version,
          ':lease': new Date(now.getTime() + 60_000).toISOString(), ':one': 1,
        },
      }))
      return true
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false
      throw error
    }
  }

  /** @inheritdoc */
  async finish(
    post: ChannelPost,
    token: string,
    status: 'sent' | 'suppressed' | 'failed' | 'pending',
    nextAttemptAt?: Date,
    code?: string,
  ): Promise<void> {
    if ((status === 'pending') !== Boolean(nextAttemptAt)) throw new Error('A pending channel post needs a retry time.')
    const failed = status === 'failed'
    const keepsQueue = status === 'pending' || failed
    await this.#client.send(new UpdateCommand({
      TableName: this.#tableName, Key: postKey(post.workspaceId, post.eventId),
      ConditionExpression: 'slackLeaseToken = :token',
      UpdateExpression: `SET slackDeliveryStatus = :status, slackLastCode = :code${keepsQueue ? ', slackNextAttemptAt = :next' : ''}${failed ? ', slackQueueShard = :failedShard, slackFailureReference = :token' : ''} REMOVE slackLeaseToken${keepsQueue ? '' : ', slackQueueShard, slackNextAttemptAt'} ADD #version :one`,
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: {
        ':token': token, ':status': status, ':code': code ?? status, ':one': 1,
        ...(nextAttemptAt ? { ':next': nextAttemptAt.toISOString() } : {}),
        ...(failed ? { ':next': post.nextAttemptAt, ':failedShard': post.shard.replace('slack-channel#', 'slack-channel-failed#') } : {}),
      },
    }))
  }

  /**
   * Writes a standalone audit event.
   * @param auditPut - Audit put without the webhook URL.
   */
  async recordAudit(auditPut: AuditTransactWriteItem): Promise<void> {
    await this.#client.send(new TransactWriteCommand({ TransactItems: [auditPut] }))
  }

  /**
   * Runs a settings transaction and maps lost conditions to stable conflicts.
   * @param items - Settings write, authorization checks, then the audit put.
   * @param checkCount - Number of authorization checks after the settings write.
   */
  async #transact(items: NonNullable<TransactWriteCommandInput['TransactItems']>, checkCount: number) {
    try {
      await this.#client.send(new TransactWriteCommand({ TransactItems: items }))
    } catch (error) {
      const failed = readFailedConditionIndexes(error)
      if (!failed) throw error
      if (!failed.includes(0) && failed.some((index) => index >= 1 && index <= checkCount)) {
        throw new NotificationError(409, 'NotificationDestinationAuthorizationChanged', 'Permissions changed before this change was saved. Reload and try again.')
      }
      throw new NotificationError(409, 'NotificationDestinationConflict', 'The destination changed before this change was saved. Reload and try again.')
    }
  }
}

/**
 * Builds the condition that a save or delete replaces the revision the caller read.
 * @param expectedRevision - Revision the caller read; 0 for a row that must not exist yet.
 * @returns DynamoDB condition fields.
 */
function revisionCondition(expectedRevision: number) {
  return expectedRevision === 0
    ? { ConditionExpression: 'attribute_not_exists(recipientKey)' }
    : {
        ConditionExpression: '#revision = :revision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':revision': expectedRevision },
      }
}

/**
 * Builds the key of a destination row.
 * @param workspaceId - Canonical Workspace ID.
 * @param target - Team or Project.
 * @returns Partition and sort key.
 */
function destinationKey(workspaceId: string, target: ChannelDestinationTarget) {
  const workspace = workspaceId.trim()
  if (!workspace || !target.teamId.trim() || (target.scope === 'project' && !target.projectId.trim())) {
    throw new Error('Workspace, Team, and Project IDs are required.')
  }
  return {
    recipientKey: `${workspace}#${destinationPartitionSuffix}`,
    notificationKey: channelDestinationTargetKey(target),
  }
}

/**
 * Builds the key of a queued post row.
 * @param workspaceId - Canonical Workspace ID.
 * @param eventId - Audit event ID.
 * @returns Partition and sort key.
 */
function postKey(workspaceId: string, eventId: string) {
  return { recipientKey: `${workspaceId.trim()}#${postPartitionSuffix}`, notificationKey: `POST#${eventId}` }
}

/**
 * Validates a stored destination row.
 * @param row - Stored row, or undefined.
 * @param workspaceId - Workspace the row was read for.
 * @param target - Target the row was read for.
 * @returns The settings, or undefined when no row exists.
 * @throws Error when the row is corrupt.
 */
function parseDestinationRow(
  row: Record<string, unknown> | undefined,
  workspaceId: string,
  target: ChannelDestinationTarget,
): ChannelDestinationRecord | undefined {
  if (!row) return undefined
  if (row.removed === true) {
    if (
      row.itemType !== destinationItemType || row.workspaceId !== workspaceId ||
      typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1
    ) throw new Error('Invalid notification channel destination row.')
    return undefined
  }
  const locale = readLocale(row.locale)
  if (
    row.itemType !== destinationItemType || row.workspaceId !== workspaceId || row.provider !== 'slack' ||
    row.scope !== target.scope || row.teamId !== target.teamId ||
    (target.scope === 'project' && row.projectId !== target.projectId) ||
    !locale || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1 ||
    typeof row.updatedAt !== 'string' || typeof row.updatedBy !== 'string' ||
    !isChannelDestinationSecretVersion(row.secretVersion) ||
    (row.label !== undefined && typeof row.label !== 'string')
  ) throw new Error('Invalid notification channel destination row.')
  return {
    target,
    provider: 'slack',
    ...(typeof row.label === 'string' && row.label ? { label: row.label } : {}),
    locale,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    secretVersion: row.secretVersion,
  }
}

/**
 * Reads a stored language.
 * @param value - Stored value.
 * @returns The language, or undefined when it is not one.
 */
function readLocale(value: unknown): NotificationMessageLocale | undefined {
  return NOTIFICATION_MESSAGE_LOCALES.find((locale) => locale === value)
}

/**
 * Validates a queued post row read through the due index.
 * @param row - Strongly read row, or undefined when it is gone.
 * @param shard - Partition the candidate was listed under.
 * @param now - Current time.
 * @returns The due post, or undefined when it left the queue or is not due yet.
 * @throws Error when the row is corrupt.
 */
function parsePostRow(row: Record<string, unknown> | undefined, shard: string, now: Date): ChannelPost | undefined {
  if (!row || row.slackQueueShard !== shard) return undefined
  const invalid = () => new Error('Invalid notification channel post row.')
  const next = row.slackNextAttemptAt
  if (typeof next !== 'string' || !Number.isFinite(Date.parse(next))) throw invalid()
  if (next > now.toISOString()) return undefined
  const eventType = typeof row.eventType === 'string' ? row.eventType : ''
  if (
    row.itemType !== postItemType || typeof row.workspaceId !== 'string' || typeof row.eventId !== 'string' ||
    !isNotificationChannelPostEventType(eventType) || typeof row.teamId !== 'string' || !row.teamId ||
    (row.scope !== 'team' && row.scope !== 'project') ||
    (row.scope === 'project' && (typeof row.projectId !== 'string' || !row.projectId)) ||
    typeof row.occurredAt !== 'string' ||
    typeof row.version !== 'number' || !Number.isSafeInteger(row.version) ||
    typeof row.slackAttempts !== 'number' || !Number.isSafeInteger(row.slackAttempts) ||
    (row.slackDeliveryStatus !== 'pending' && row.slackDeliveryStatus !== 'sending')
  ) throw invalid()
  const target: ChannelDestinationTarget = row.scope === 'project' && typeof row.projectId === 'string'
    ? { scope: 'project', teamId: row.teamId, projectId: row.projectId }
    : { scope: 'team', teamId: row.teamId }
  const source = parsePostSource(row.source)
  // The worker rechecks the source but sends to the target, so the two must name the same scope.
  if (!source || source.teamId !== target.teamId || (target.scope === 'project' && source.projectId !== target.projectId)) {
    throw invalid()
  }
  const message = parseNotificationMessage(row.message)
  return {
    workspaceId: row.workspaceId,
    eventId: row.eventId,
    eventType,
    target,
    ...(typeof row.title === 'string' ? { title: row.title } : {}),
    ...(typeof row.workItemKey === 'string' ? { workItemKey: row.workItemKey } : {}),
    ...(typeof row.summary === 'string' ? { summary: row.summary } : {}),
    ...(message ? { message } : {}),
    ...(typeof row.deepLink === 'string' ? { deepLink: row.deepLink } : {}),
    occurredAt: row.occurredAt,
    source,
    shard,
    attempts: row.slackAttempts,
    version: row.version,
    nextAttemptAt: next,
  }
}

/** Optional fields of a post's source identity. */
const postSourceOptionalFields: ReadonlyArray<Exclude<keyof ChannelPostSource, 'teamId'>> = [
  'projectId', 'issueId', 'dueDate', 'entityId', 'planningTargetRecordKey',
]

/**
 * Validates the stored source identity of a post.
 * @param value - Stored `source` map.
 * @returns The source, or undefined when it is malformed.
 */
function parsePostSource(value: unknown): ChannelPostSource | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const teamId: unknown = Reflect.get(value, 'teamId')
  if (typeof teamId !== 'string' || !teamId) return undefined
  const source: ChannelPostSource = { teamId }
  for (const field of postSourceOptionalFields) {
    const fieldValue: unknown = Reflect.get(value, field)
    if (fieldValue === undefined) continue
    if (typeof fieldValue !== 'string' || !fieldValue) return undefined
    source[field] = fieldValue
  }
  return source
}

/**
 * Lists the transaction items whose condition failed.
 * @param error - Caught error.
 * @returns Failed item indexes, or undefined for any other error.
 */
function readFailedConditionIndexes(error: unknown) {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return undefined
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return undefined
  const failed = reasons.flatMap((reason: unknown, index) =>
    typeof reason === 'object' && reason !== null && Reflect.get(reason, 'Code') === 'ConditionalCheckFailed' ? [index] : [])
  return failed.length > 0 ? failed : undefined
}
