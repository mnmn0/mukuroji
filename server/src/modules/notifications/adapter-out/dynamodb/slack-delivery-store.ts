import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { SlackDelivery, SlackDeliveryStore } from '../../application/slack-delivery'
import { slackDeliveryShard } from '../../domain/slack-delivery'
import { NOTIFICATION_PREFERENCES_KEY, parseStoredNotificationPreferences, toNotificationItem } from '../../notifications'

/** Minimal DynamoDB command boundary used by the delivery queue. */
type SlackDocumentClient = {
  /** Sends one queue read or conditional update. */
  send(command: GetCommand | QueryCommand | UpdateCommand): Promise<{
    /** Strongly read canonical row. */
    Item?: Record<string, unknown>
    /** Due-index candidate keys. */
    Items?: Record<string, unknown>[]
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
  async listDue(shard: string, now: Date, limit: number): Promise<SlackDelivery[]> {
    const page = await this.#client.send(new QueryCommand({
      TableName: this.#tableName, IndexName: 'SlackDeliveryIndex',
      KeyConditionExpression: 'slackQueueShard = :shard AND slackNextAttemptAt <= :now',
      ExpressionAttributeValues: { ':shard': shard, ':now': now.toISOString() }, Limit: limit,
    }))
    const deliveries: SlackDelivery[] = []
    // Intentionally bounded: the next schedule resumes from the oldest remaining due entry.
    for (const candidate of page.Items ?? []) {
      if (typeof candidate.recipientKey !== 'string' || typeof candidate.notificationKey !== 'string') throw invalidRow()
      const result = await this.#client.send(new GetCommand({
        TableName: this.#tableName, ConsistentRead: true,
        Key: { recipientKey: candidate.recipientKey, notificationKey: candidate.notificationKey },
      }))
      const row = result.Item
      if (!row || row.slackQueueShard === undefined) continue
      if (row.slackQueueShard !== shard || typeof row.slackNextAttemptAt !== 'string') throw invalidRow()
      if (row.slackNextAttemptAt > now.toISOString()) continue
      if (typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt)) throw invalidRow()
      if (
        typeof row.workspaceId !== 'string' || typeof row.recipientMemberKey !== 'string' ||
        row.recipientKey !== `${row.workspaceId}#${row.recipientMemberKey.trim().toLowerCase()}` ||
        row.notificationKey !== candidate.notificationKey ||
        row.slackQueueShard !== slackDeliveryShard(candidate.recipientKey) ||
        !Number.isSafeInteger(row.version) || typeof row.version !== 'number' || row.version < 1 ||
        !Number.isSafeInteger(row.slackAttempts) || typeof row.slackAttempts !== 'number' || row.slackAttempts < 0 ||
        (row.slackDeliveryStatus !== 'pending' && row.slackDeliveryStatus !== 'sending') ||
        !Array.isArray(row.deliveryChannels) || !row.deliveryChannels.includes('slack') ||
        !Number.isFinite(Date.parse(row.slackNextAttemptAt))
      ) throw invalidRow()
      const notification = toNotificationItem(row, candidate.recipientKey, now, true)
      if (!notification) throw invalidRow()
      deliveries.push({
        workspaceId: row.workspaceId, memberKey: row.recipientMemberKey,
        recipientKey: candidate.recipientKey, notificationKey: candidate.notificationKey,
        attempts: row.slackAttempts, version: row.version, nextAttemptAt: row.slackNextAttemptAt,
        notification,
        expiresAt: row.expiresAt,
        ...(typeof row.dueDate === 'string' ? { dueDate: row.dueDate } : {}),
      })
    }
    return deliveries
  }

  /** Fences slow authorization reads before sending and renews the transport lease. */
  async renew(delivery: SlackDelivery, token: string, now: Date): Promise<boolean> {
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: key(delivery),
        ConditionExpression: 'slackLeaseToken = :token AND slackNextAttemptAt > :now',
        UpdateExpression: 'SET slackNextAttemptAt = :lease ADD #version :one',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':token': token, ':now': now.toISOString(), ':lease': new Date(now.getTime() + 60_000).toISOString(), ':one': 1 },
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

  /** Updates delivery fields without replacing concurrent Inbox state. */
  async finish(delivery: SlackDelivery, token: string, status: 'sent' | 'suppressed' | 'failed' | 'pending', nextAttemptAt?: Date, code?: string): Promise<void> {
    if ((status === 'pending') !== Boolean(nextAttemptAt)) throw invalidRow()
    await this.#client.send(new UpdateCommand({
      TableName: this.#tableName, Key: key(delivery),
      ConditionExpression: 'slackLeaseToken = :token',
      UpdateExpression: `SET slackDeliveryStatus = :status, slackLastCode = :code${nextAttemptAt ? ', slackNextAttemptAt = :next' : ''} REMOVE slackLeaseToken${nextAttemptAt ? '' : ', slackQueueShard, slackNextAttemptAt'} ADD #version :one${status === 'pending' && !code ? ', slackAttempts :minusOne' : ''}`,
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: {
        ':token': token, ':status': status, ':code': code ?? status, ':one': 1,
        ...(nextAttemptAt ? { ':next': nextAttemptAt.toISOString() } : {}),
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
    return parseStoredNotificationPreferences(result.Item)
  }
}

/** Builds the exact notification primary key. */
function key(delivery: SlackDelivery) {
  return { recipientKey: delivery.recipientKey, notificationKey: delivery.notificationKey }
}

/** Produces a safe failure for corrupt queue records. */
function invalidRow(): Error { return new Error('Invalid Slack notification delivery row.') }
