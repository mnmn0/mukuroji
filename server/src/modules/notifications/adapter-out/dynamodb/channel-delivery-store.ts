import { GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { ChannelDelivery, ChannelDeliveryBatch, ChannelDeliveryStore, ChannelDigestCompanions } from '../../application/channel-delivery'
import { EXTERNAL_DELIVERY_CHANNELS, channelDeliveryShard, channelFailedDeliveryShard, type ExternalDeliveryChannel } from '../../domain/channel-delivery'
import { NOTIFICATION_PREFERENCES_KEY, parseStoredNotificationPreferences, toNotificationItem, type NotificationFrequency } from '../../notifications'

/** Furthest ahead of now a digest companion may be scheduled: the longest digest frequency, a week, plus a day of quiet hours. */
const DIGEST_COMPANION_HORIZON_MS = 8 * 24 * 60 * 60 * 1_000

/** Frequencies a stored row may record. */
const NOTIFICATION_FREQUENCIES: readonly NotificationFrequency[] = ['instant', 'hourly', 'daily', 'weekly']

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

  /**
   * Lists the recipient's other queued digest rows in the same shard, including ones not yet due,
   * so the first due row of a digest window carries everything gathered since. A not-yet-due row
   * is taken only while it is pending and was never attempted, so retry backoff and other
   * workers' leases are kept. Corrupt rows are skipped here; the due scan reports them.
   * @param delivery - Due row that opens the digest.
   * @param now - Current time.
   * @param limit - Most companions to return.
   * @returns Companion deliveries, oldest scheduled first.
   */
  async listCompanions(delivery: ChannelDelivery, now: Date, limit: number): Promise<ChannelDigestCompanions> {
    const names = this.#names
    const shard = channelDeliveryShard(names.channel, delivery.recipientKey)
    const horizon = new Date(now.getTime() + DIGEST_COMPANION_HORIZON_MS)
    const companions: ChannelDelivery[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    const cursors = new Set<string>()
    let corrupt = false
    for (let pageNumber = 0; pageNumber < 10 && companions.length < limit; pageNumber += 1) {
      const page = await this.#client.send(new QueryCommand({
        TableName: this.#tableName, IndexName: names.index,
        KeyConditionExpression: `${names.shard} = :shard AND ${names.next} <= :horizon`,
        FilterExpression: 'recipientKey = :recipientKey',
        ExpressionAttributeValues: { ':shard': shard, ':horizon': horizon.toISOString(), ':recipientKey': delivery.recipientKey },
        // Without Limit each page reads up to 1 MB of the keys-only index.
        ExclusiveStartKey: exclusiveStartKey,
      }))
      for (const candidate of page.Items ?? []) {
        if (companions.length >= limit) break
        if (candidate.recipientKey !== delivery.recipientKey || typeof candidate.notificationKey !== 'string' ||
          candidate.notificationKey === delivery.notificationKey) continue
        const result = await this.#client.send(new GetCommand({
          TableName: this.#tableName, ConsistentRead: true,
          Key: { recipientKey: delivery.recipientKey, notificationKey: candidate.notificationKey },
        }))
        try {
          const companion = parseDelivery(names, result.Item, delivery.recipientKey, candidate.notificationKey, shard, now, horizon)
          if (!companion || !companion.deliveryFrequency || companion.deliveryFrequency === 'instant') continue
          if (companion.nextAttemptAt > now.toISOString() && (result.Item?.[names.status] !== 'pending' || companion.attempts !== 0)) continue
          companions.push(companion)
        } catch {
          // A corrupt row may not come due for days; report it now instead of a healthy digest.
          corrupt = true
        }
      }
      exclusiveStartKey = page.LastEvaluatedKey
      if (!exclusiveStartKey) return { deliveries: companions, complete: !corrupt }
      const cursor = JSON.stringify(exclusiveStartKey)
      if (cursors.has(cursor)) return { deliveries: companions, complete: false }
      cursors.add(cursor)
    }
    // Reaching the limit is complete; running out of pages with more rows left is not.
    return { deliveries: companions, complete: !corrupt && companions.length >= limit }
  }

  /** Fences slow authorization reads before sending and renews the transport lease. */
  async renew(delivery: ChannelDelivery, token: string, now: Date, leaseMs = 60_000): Promise<boolean> {
    const names = this.#names
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: key(delivery),
        ConditionExpression: `${names.lease} = :token AND ${names.next} > :now AND #version = :claimedVersion`,
        UpdateExpression: `SET ${names.next} = :lease ADD #version :one`,
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':token': token, ':now': now.toISOString(),
          ':lease': new Date(now.getTime() + leaseMs).toISOString(),
          ':claimedVersion': delivery.version + 1, ':one': 1,
        },
      }))
      return true
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false
      throw error
    }
  }

  /**
   * Claims only the revision and due time that were read, and only while no other channel holds an
   * unexpired lease on the row, so two channels never cancel each other's final version fence.
   */
  async claim(delivery: ChannelDelivery, token: string, leaseUntil: Date, now: Date = new Date()): Promise<boolean> {
    const names = this.#names
    const otherLeases = EXTERNAL_DELIVERY_CHANNELS.filter((channel) => channel !== names.channel).map(channelAttributes)
      .map((other) => ` AND (attribute_not_exists(${other.lease}) OR ${other.next} <= :now)`).join('')
    try {
      await this.#client.send(new UpdateCommand({
        TableName: this.#tableName, Key: key(delivery),
        // The own-lease guard keeps a digest from taking a not-yet-due row another worker leased.
        ConditionExpression: `#version = :version AND ${names.next} = :due AND attribute_exists(${names.shard}) AND (attribute_not_exists(${names.lease}) OR ${names.next} <= :now)${otherLeases}`,
        UpdateExpression: `SET ${names.lease} = :token, ${names.next} = :lease, ${names.status} = :sending ADD #version :one, ${names.attempts} :one`,
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: {
          ':version': delivery.version, ':due': delivery.nextAttemptAt, ':token': token,
          ':lease': leaseUntil.toISOString(), ':sending': 'sending', ':one': 1, ':now': now.toISOString(),
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

/**
 * Validates one canonical delivery, allowing eventually consistent index removals and leases.
 * @param names - Channel attribute names.
 * @param row - Strongly read row.
 * @param recipientKey - Expected recipient partition.
 * @param notificationKey - Expected notification key.
 * @param shard - Queue shard the row was found in.
 * @param now - Current time, used for the Inbox state.
 * @param dueBy - Latest due time accepted; later rows are skipped.
 * @returns The delivery, or undefined when it is no longer queued or not yet due.
 */
function parseDelivery(names: ChannelAttributes, row: Record<string, unknown> | undefined, recipientKey: string, notificationKey: string, shard: string, now: Date, dueBy: Date = now): ChannelDelivery | undefined {
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
  const deliveryFrequency = NOTIFICATION_FREQUENCIES.find((frequency) => frequency === row.deliveryFrequency)
  if (nextAttemptAt > dueBy.toISOString()) return undefined
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
  if (
    row.weeklyReportAuthorMemberKey !== undefined &&
    (typeof row.weeklyReportAuthorMemberKey !== 'string' || !row.weeklyReportAuthorMemberKey.trim())
  ) throw invalidRow()
  if (
    row.weeklyReportWeekStart !== undefined &&
    (typeof row.weeklyReportWeekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.weeklyReportWeekStart))
  ) throw invalidRow()
  if (
    row.accessExpiryMemberKey !== undefined &&
    (typeof row.accessExpiryMemberKey !== 'string' || !row.accessExpiryMemberKey.trim())
  ) throw invalidRow()
  if (
    row.accessExpiresAt !== undefined &&
    (typeof row.accessExpiresAt !== 'string' || !Number.isFinite(Date.parse(row.accessExpiresAt)))
  ) throw invalidRow()
  if (
    row.timeEntryIds !== undefined &&
    (!Array.isArray(row.timeEntryIds) ||
      row.timeEntryIds.length === 0 ||
      !row.timeEntryIds.every((entryId) => typeof entryId === 'string' && entryId.trim()))
  ) throw invalidRow()
  if (
    row.timesheetDueBefore !== undefined &&
    (typeof row.timesheetDueBefore !== 'string' || !Number.isFinite(Date.parse(row.timesheetDueBefore)))
  ) throw invalidRow()
  const timeEntryIds = readTimeEntryIds(row.timeEntryIds)
  return {
    workspaceId: row.workspaceId, memberKey: row.recipientMemberKey, recipientKey, notificationKey,
    attempts, version: row.version, nextAttemptAt,
    scheduledAt: typeof row.deliveryAfter === 'string' ? row.deliveryAfter : nextAttemptAt,
    notification, expiresAt: row.expiresAt,
    ...(deliveryFrequency ? { deliveryFrequency } : {}),
    ...(typeof row.dueDate === 'string' ? { dueDate: row.dueDate } : {}),
    ...(typeof row.workItemUpdatedAt === 'string'
      ? { workItemUpdatedAt: row.workItemUpdatedAt }
      : {}),
    ...(typeof row.daysUntilDue === 'number' ? { daysUntilDue: row.daysUntilDue } : {}),
    ...(typeof row.workItemReopenedAt === 'string' ? { workItemReopenedAt: row.workItemReopenedAt } : {}),
    ...(typeof row.weeklyReportAuthorMemberKey === 'string'
      ? { weeklyReportAuthorMemberKey: row.weeklyReportAuthorMemberKey }
      : {}),
    ...(typeof row.weeklyReportWeekStart === 'string' ? { weeklyReportWeekStart: row.weeklyReportWeekStart } : {}),
    ...(typeof row.accessExpiryMemberKey === 'string' ? { accessExpiryMemberKey: row.accessExpiryMemberKey } : {}),
    ...(typeof row.accessExpiresAt === 'string' ? { accessExpiresAt: row.accessExpiresAt } : {}),
    ...(timeEntryIds ? { timeEntryIds } : {}),
    ...(typeof row.timesheetDueBefore === 'string' ? { timesheetDueBefore: row.timesheetDueBefore } : {}),
    ...(typeof row.fileId === 'string' ? { fileId: row.fileId } : {}),
    ...(typeof row.targetId === 'string' ? { targetId: row.targetId } : {}),
  }
}

/**
 * Copies a stored timesheet reminder's entry IDs.
 * @param value - Raw `timeEntryIds` attribute, already checked to be absent or a non-empty string list.
 * @returns The entry IDs, or undefined when the row has none.
 */
function readTimeEntryIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entryId) => typeof entryId === 'string' ? [entryId] : [])
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
