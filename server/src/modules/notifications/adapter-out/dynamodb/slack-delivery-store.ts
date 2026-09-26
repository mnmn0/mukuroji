import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { SlackDelivery, SlackDeliveryBatch, SlackDeliveryStore } from '../../application/slack-delivery'
import { slackDeliveryShard, slackFailedDeliveryShard } from '../../domain/slack-delivery'
import { NOTIFICATION_PREFERENCES_KEY, parseStoredNotificationPreferences, toNotificationItem } from '../../notifications'

/** Minimal DynamoDB command boundary used by the delivery queue. */
type SlackDocumentClient = {
  /** Sends one queue read or conditional update. */
  send(command: GetCommand | QueryCommand | UpdateCommand): Promise<{
    /** Strongly read canonical row. */
    Item?: Record<string, unknown>
    /** Due-index candidate keys. */
    Items?: Record<string, unknown>[]
    /** Continuation key from the bounded due-index query. */
    LastEvaluatedKey?: Record<string, unknown>
  }>
}

/** DynamoDB-backed due queue with per-notification delivery leases. */
export class DynamoDbSlackDeliveryStore implements SlackDeliveryStore {
  /** Document client configured by the composition root. */
  readonly #client: SlackDocumentClient
  /** Notification and preference table. */
  readonly #tableName: string

  /** Creates the queue adapter for the existing Notifications table. */
  constructor(client: SlackDocumentClient, tableName: string) {
    this.#client = client
    this.#tableName = tableName
  }

  /** Reads candidate keys from the sparse index, then checks strong canonical rows. */
  async listDue(shard: string, now: Date, limit: number): Promise<SlackDeliveryBatch> {
    const deliveries: SlackDelivery[] = []
    let invalidCount = 0
    let exclusiveStartKey: Record<string, unknown> | undefined
    const cursors = new Set<string>()
    // Bound inspection to ten pages while continuing beyond stale or corrupt index candidates.
    for (let pageNumber = 0; pageNumber < 10 && deliveries.length < limit; pageNumber += 1) {
      const page = await this.#client.send(new QueryCommand({
        TableName: this.#tableName, IndexName: 'SlackDeliveryIndex',
        KeyConditionExpression: 'slackQueueShard = :shard AND slackNextAttemptAt <= :now',
        ExpressionAttributeValues: { ':shard': shard, ':now': now.toISOString() },
        Limit: limit - deliveries.length, ExclusiveStartKey: exclusiveStartKey,
      }))
      for (const candidate of page.Items ?? []) {
        if (typeof candidate.recipientKey !== 'string' || typeof candidate.notificationKey !== 'string') {
          invalidCount += 1
          continue
        }
        const result = await this.#client.send(new GetCommand({
          TableName: this.#tableName, ConsistentRead: true,
          Key: { recipientKey: candidate.recipientKey, notificationKey: candidate.notificationKey },
        }))
        try {
          const delivery = parseDelivery(result.Item, candidate.recipientKey, candidate.notificationKey, shard, now)
          if (delivery) deliveries.push(delivery)
        } catch {
          // Corrupt data is reported, never silently treated as a successful empty queue.
          invalidCount += 1
        }
      }
      exclusiveStartKey = page.LastEvaluatedKey
      if (!exclusiveStartKey) break
      const cursor = JSON.stringify(exclusiveStartKey)
      if (cursors.has(cursor)) { invalidCount += 1; break }
      cursors.add(cursor)
    }
    return { deliveries, invalidCount }
  }

  /** Fences slow authorization reads before sending and renews the transport lease. */
  async renew(delivery: SlackDelivery, token: string, now: Date): Promise<boolean> {
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: key(delivery),
        ConditionExpression: 'slackLeaseToken = :token AND slackNextAttemptAt > :now AND #version = :claimedVersion',
        UpdateExpression: 'SET slackNextAttemptAt = :lease ADD #version :one',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':token': token, ':now': now.toISOString(),
          ':lease': new Date(now.getTime() + 60_000).toISOString(),
          ':claimedVersion': delivery.version + 1, ':one': 1,
        },
      }))
      return true
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false
      throw error
    }
  }

  /** Claims only the revision and due time that were read. */
  async claim(delivery: SlackDelivery, token: string, leaseUntil: Date): Promise<boolean> {
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: key(delivery),
        ConditionExpression: '#version = :version AND slackNextAttemptAt = :due AND attribute_exists(slackQueueShard)',
        UpdateExpression: 'SET slackLeaseToken = :token, slackNextAttemptAt = :lease, slackDeliveryStatus = :sending ADD #version :one, slackAttempts :one',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':version': delivery.version, ':due': delivery.nextAttemptAt, ':token': token,
          ':lease': leaseUntil.toISOString(), ':sending': 'sending', ':one': 1,
        },
      }))
      return true
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false
      throw error
    }
  }

  /** Releases only this worker's unsent claim; a newer owner is never modified. */
  async release(delivery: SlackDelivery, token: string, now: Date): Promise<void> {
    try {
      await this.finish(delivery, token, 'pending', now)
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return
      throw error
    }
  }

  /** Updates delivery fields without replacing concurrent Inbox state. */
  async finish(delivery: SlackDelivery, token: string, status: 'sent' | 'suppressed' | 'failed' | 'pending', nextAttemptAt?: Date, code?: string): Promise<void> {
    if ((status === 'pending') !== Boolean(nextAttemptAt)) throw invalidRow()
    const failed = status === 'failed'
    await this.#client.send(new UpdateCommand({
      TableName: this.#tableName, Key: key(delivery),
      ConditionExpression: 'slackLeaseToken = :token',
      UpdateExpression: `SET slackDeliveryStatus = :status, slackLastCode = :code${nextAttemptAt || failed ? ', slackNextAttemptAt = :next' : ''}${failed ? ', slackQueueShard = :failedShard, slackFailureReference = :token' : ''} REMOVE slackLeaseToken${nextAttemptAt || failed ? '' : ', slackQueueShard, slackNextAttemptAt'} ADD #version :one${status === 'pending' && !code ? ', slackAttempts :minusOne' : ''}`,
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: {
        ':token': token, ':status': status, ':code': code ?? status, ':one': 1,
        ...(nextAttemptAt ? { ':next': nextAttemptAt.toISOString() } : {}),
        ...(failed ? { ':next': delivery.nextAttemptAt, ':failedShard': slackFailedDeliveryShard(delivery.recipientKey) } : {}),
        ...(status === 'pending' && !code ? { ':minusOne': -1 } : {}),
      },
    }))
  }

  /** Reads the latest recipient opt-in before each delivery. */
  async getPreferences(delivery: SlackDelivery) {
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName, ConsistentRead: true,
      Key: { recipientKey: delivery.recipientKey, notificationKey: NOTIFICATION_PREFERENCES_KEY },
    }))
    return parseStoredNotificationPreferences(result.Item, true)
  }
}

/** Validates one canonical delivery, allowing eventually consistent index removals and leases. */
function parseDelivery(row: Record<string, unknown> | undefined, recipientKey: string, notificationKey: string, shard: string, now: Date): SlackDelivery | undefined {
  if (!row || row.slackQueueShard === undefined) return undefined
  if (row.slackDeliveryStatus === 'failed' && row.slackQueueShard === slackFailedDeliveryShard(recipientKey)) return undefined
  if (row.slackQueueShard !== shard || typeof row.slackNextAttemptAt !== 'string') throw invalidRow()
  if (!Number.isFinite(Date.parse(row.slackNextAttemptAt))) throw invalidRow()
  if (row.deliveryAfter !== undefined && (typeof row.deliveryAfter !== 'string' || !Number.isFinite(Date.parse(row.deliveryAfter)))) throw invalidRow()
  if (row.slackNextAttemptAt > now.toISOString()) return undefined
  if (typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt)) throw invalidRow()
  if (
    typeof row.workspaceId !== 'string' || typeof row.recipientMemberKey !== 'string' ||
    row.recipientKey !== recipientKey || row.recipientKey !== `${row.workspaceId}#${row.recipientMemberKey.trim().toLowerCase()}` ||
    row.notificationKey !== notificationKey || row.slackQueueShard !== slackDeliveryShard(recipientKey) ||
    typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1 ||
    typeof row.slackAttempts !== 'number' || !Number.isSafeInteger(row.slackAttempts) || row.slackAttempts < 0 ||
    (row.slackDeliveryStatus !== 'pending' && row.slackDeliveryStatus !== 'sending') ||
    !Array.isArray(row.deliveryChannels) || !row.deliveryChannels.includes('slack')
  ) throw invalidRow()
  const notification = toNotificationItem(row, recipientKey, now, true)
  if (!notification) throw invalidRow()
  if ([row.fileId, row.targetId].some((value) => value !== undefined && (typeof value !== 'string' || !value.trim()))) throw invalidRow()
  return {
    workspaceId: row.workspaceId, memberKey: row.recipientMemberKey, recipientKey, notificationKey,
    attempts: row.slackAttempts, version: row.version, nextAttemptAt: row.slackNextAttemptAt,
    scheduledAt: typeof row.deliveryAfter === 'string' ? row.deliveryAfter : row.slackNextAttemptAt,
    notification, expiresAt: row.expiresAt,
    ...(typeof row.dueDate === 'string' ? { dueDate: row.dueDate } : {}),
    ...(typeof row.fileId === 'string' ? { fileId: row.fileId } : {}),
    ...(typeof row.targetId === 'string' ? { targetId: row.targetId } : {}),
  }
}

/** Builds the exact notification primary key. */
function key(delivery: SlackDelivery) {
  return { recipientKey: delivery.recipientKey, notificationKey: delivery.notificationKey }
}

/** Produces a safe failure for corrupt queue records. */
function invalidRow(): Error { return new Error('Invalid Slack notification delivery row.') }
