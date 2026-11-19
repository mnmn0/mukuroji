import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { ChannelDelivery, ChannelDeliveryBatch, ChannelDeliveryStore } from '../../application/channel-delivery'
import { channelDeliveryShard, channelFailedDeliveryShard, type ExternalDeliveryChannel } from '../../domain/channel-delivery'
import { NOTIFICATION_PREFERENCES_KEY, parseStoredNotificationPreferences, toNotificationItem } from '../../notifications'

/** Minimal DynamoDB command boundary used by the delivery queue. */
type ChannelDocumentClient = {
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

/** Channel-prefixed attribute and index names on the Notifications table; fixed identifiers, never input. */
type ChannelAttributes = {
  /** External channel that owns the queue. */
  channel: ExternalDeliveryChannel
  /** Sparse due index name. */
  index: string
  /** Queue partition attribute. */
  shard: string
  /** Due time attribute. */
  next: string
  /** Delivery status attribute. */
  status: string
  /** Claimed attempt count attribute. */
  attempts: string
  /** Lease token attribute. */
  lease: string
  /** Safe last outcome code attribute. */
  lastCode: string
  /** Failed-row lookup reference attribute. */
  failureReference: string
  /** PascalCase label used in safe errors. */
  label: string
}

/**
 * Derives the attribute names one channel's queue uses on a shared notification row.
 * @param channel - External channel that owns the queue.
 * @returns Attribute and index names, for example `slackQueueShard` and `SlackDeliveryIndex`.
 */
function channelAttributes(channel: ExternalDeliveryChannel): ChannelAttributes {
  const label = `${channel.charAt(0).toUpperCase()}${channel.slice(1)}`
  return {
    channel, label, index: `${label}DeliveryIndex`, shard: `${channel}QueueShard`, next: `${channel}NextAttemptAt`,
    status: `${channel}DeliveryStatus`, attempts: `${channel}Attempts`, lease: `${channel}LeaseToken`,
    lastCode: `${channel}LastCode`, failureReference: `${channel}FailureReference`,
  }
}

/** DynamoDB-backed due queue with per-notification delivery leases. */
export class DynamoDbChannelDeliveryStore implements ChannelDeliveryStore {
  /** Document client configured by the composition root. */
  readonly #client: ChannelDocumentClient
  /** Notification and preference table. */
  readonly #tableName: string
  /** Channel-prefixed queue attribute names. */
  readonly #names: ChannelAttributes

  /**
   * Creates the queue adapter for one channel on the existing Notifications table.
   * @param client - Document client configured by the composition root.
   * @param tableName - Notifications table name.
   * @param channel - External channel whose queue attributes this adapter owns.
   */
  constructor(client: ChannelDocumentClient, tableName: string, channel: ExternalDeliveryChannel) {
    this.#client = client
    this.#tableName = tableName
    this.#names = channelAttributes(channel)
  }

  /** Reads candidate keys from the sparse index, then checks strong canonical rows. */
  async listDue(shard: string, now: Date, limit: number): Promise<ChannelDeliveryBatch> {
    const names = this.#names
    const deliveries: ChannelDelivery[] = []
    let invalidCount = 0
    let exclusiveStartKey: Record<string, unknown> | undefined
    const cursors = new Set<string>()
    // Bound inspection to ten pages while continuing beyond stale or corrupt index candidates.
    for (let pageNumber = 0; pageNumber < 10 && deliveries.length < limit; pageNumber += 1) {
      const page = await this.#client.send(new QueryCommand({
        TableName: this.#tableName, IndexName: names.index,
        KeyConditionExpression: `${names.shard} = :shard AND ${names.next} <= :now`,
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
          const delivery = parseDelivery(names, result.Item, candidate.recipientKey, candidate.notificationKey, shard, now)
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
  async renew(delivery: ChannelDelivery, token: string, now: Date): Promise<boolean> {
    const names = this.#names
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: key(delivery),
        ConditionExpression: `${names.lease} = :token AND ${names.next} > :now AND #version = :claimedVersion`,
        UpdateExpression: `SET ${names.next} = :lease ADD #version :one`,
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
  async claim(delivery: ChannelDelivery, token: string, leaseUntil: Date): Promise<boolean> {
    const names = this.#names
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: key(delivery),
        ConditionExpression: `#version = :version AND ${names.next} = :due AND attribute_exists(${names.shard})`,
        UpdateExpression: `SET ${names.lease} = :token, ${names.next} = :lease, ${names.status} = :sending ADD #version :one, ${names.attempts} :one`,
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
  async release(delivery: ChannelDelivery, token: string, now: Date): Promise<void> {
    try {
      await this.finish(delivery, token, 'pending', now)
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return
      throw error
    }
  }

  /** Updates delivery fields without replacing concurrent Inbox state. */
  async finish(delivery: ChannelDelivery, token: string, status: 'sent' | 'suppressed' | 'failed' | 'pending', nextAttemptAt?: Date, code?: string): Promise<void> {
    const names = this.#names
    if ((status === 'pending') !== Boolean(nextAttemptAt)) throw invalidChannelRow(names)
    const failed = status === 'failed'
    const keepsQueue = Boolean(nextAttemptAt) || failed
    const decrementsAttempts = status === 'pending' && !code
    await this.#client.send(new UpdateCommand({
      TableName: this.#tableName, Key: key(delivery),
      ConditionExpression: `${names.lease} = :token`,
      UpdateExpression: `SET ${names.status} = :status, ${names.lastCode} = :code${keepsQueue ? `, ${names.next} = :next` : ''}${failed ? `, ${names.shard} = :failedShard, ${names.failureReference} = :token` : ''} REMOVE ${names.lease}${keepsQueue ? '' : `, ${names.shard}, ${names.next}`} ADD #version :one${decrementsAttempts ? `, ${names.attempts} :minusOne` : ''}`,
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: {
        ':token': token, ':status': status, ':code': code ?? status, ':one': 1,
        ...(nextAttemptAt ? { ':next': nextAttemptAt.toISOString() } : {}),
        ...(failed ? { ':next': delivery.nextAttemptAt, ':failedShard': channelFailedDeliveryShard(names.channel, delivery.recipientKey) } : {}),
        ...(decrementsAttempts ? { ':minusOne': -1 } : {}),
      },
    }))
  }

  /** Reads the latest recipient opt-in before each delivery. */
  async getPreferences(delivery: ChannelDelivery) {
    const result = await this.#client.send(new GetCommand({
      TableName: this.#tableName, ConsistentRead: true,
      Key: { recipientKey: delivery.recipientKey, notificationKey: NOTIFICATION_PREFERENCES_KEY },
    }))
    return parseStoredNotificationPreferences(result.Item, true)
  }
}

/** Validates one canonical delivery, allowing eventually consistent index removals and leases. */
function parseDelivery(names: ChannelAttributes, row: Record<string, unknown> | undefined, recipientKey: string, notificationKey: string, shard: string, now: Date): ChannelDelivery | undefined {
  if (!row || row[names.shard] === undefined) return undefined
  const invalidRow = () => invalidChannelRow(names)
  const rowShard = row[names.shard]
  const nextAttemptAt = row[names.next]
  const status = row[names.status]
  const attempts = row[names.attempts]
  if (status === 'failed' && rowShard === channelFailedDeliveryShard(names.channel, recipientKey)) return undefined
  if (rowShard !== shard || typeof nextAttemptAt !== 'string') throw invalidRow()
  if (!Number.isFinite(Date.parse(nextAttemptAt))) throw invalidRow()
  if (row.deliveryAfter !== undefined && (typeof row.deliveryAfter !== 'string' || !Number.isFinite(Date.parse(row.deliveryAfter)))) throw invalidRow()
  if (nextAttemptAt > now.toISOString()) return undefined
  if (typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt)) throw invalidRow()
  if (
    typeof row.workspaceId !== 'string' || typeof row.recipientMemberKey !== 'string' ||
    row.recipientKey !== recipientKey || row.recipientKey !== `${row.workspaceId}#${row.recipientMemberKey.trim().toLowerCase()}` ||
    row.notificationKey !== notificationKey || rowShard !== channelDeliveryShard(names.channel, recipientKey) ||
    typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1 ||
    typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 0 ||
    (status !== 'pending' && status !== 'sending') ||
    !Array.isArray(row.deliveryChannels) || !row.deliveryChannels.includes(names.channel)
  ) throw invalidRow()
  const notification = toNotificationItem(row, recipientKey, now, true)
  if (!notification) throw invalidRow()
  if ([row.fileId, row.targetId].some((value) => value !== undefined && (typeof value !== 'string' || !value.trim()))) throw invalidRow()
  // Rows from older projections carry no day count; a present one must be a safe integer.
  if (row.daysUntilDue !== undefined && !Number.isSafeInteger(row.daysUntilDue)) throw invalidRow()
  if (
    row.workItemReopenedAt !== undefined &&
    (typeof row.workItemReopenedAt !== 'string' || !Number.isFinite(Date.parse(row.workItemReopenedAt)))
  ) throw invalidRow()
  return {
    workspaceId: row.workspaceId, memberKey: row.recipientMemberKey, recipientKey, notificationKey,
    attempts, version: row.version, nextAttemptAt,
    scheduledAt: typeof row.deliveryAfter === 'string' ? row.deliveryAfter : nextAttemptAt,
    notification, expiresAt: row.expiresAt,
    ...(typeof row.dueDate === 'string' ? { dueDate: row.dueDate } : {}),
    ...(typeof row.workItemUpdatedAt === 'string'
      ? { workItemUpdatedAt: row.workItemUpdatedAt }
      : {}),
    ...(typeof row.daysUntilDue === 'number' ? { daysUntilDue: row.daysUntilDue } : {}),
    ...(typeof row.workItemReopenedAt === 'string' ? { workItemReopenedAt: row.workItemReopenedAt } : {}),
    ...(typeof row.fileId === 'string' ? { fileId: row.fileId } : {}),
    ...(typeof row.targetId === 'string' ? { targetId: row.targetId } : {}),
  }
}

/** Builds the exact notification primary key. */
function key(delivery: ChannelDelivery) {
  return { recipientKey: delivery.recipientKey, notificationKey: delivery.notificationKey }
}

/**
 * Produces a safe failure for corrupt queue records.
 * @param names - Channel whose queue row was corrupt.
 * @returns Error without row contents.
 */
function invalidChannelRow(names: ChannelAttributes): Error { return new Error(`Invalid ${names.label} notification delivery row.`) }
