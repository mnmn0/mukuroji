import { randomUUID } from 'node:crypto'
import {
  DeleteCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER,
  createPushSubscriptionId,
  type ValidatedPushSubscription,
} from '../../domain/push-subscription'
import { NotificationError } from '../../domain/notification-error'
import type { PushSubscriptionStore } from '../../application/push-subscriptions'
import type { PushDevice, PushDeviceDirectory } from '../../application/ports/push-device-directory'

/** Days a subscription is kept without being registered again by its browser. */
const subscriptionRetentionDays = 180

/**
 * Extra days an endpoint owner row outlives the member rows it guards. DynamoDB deletes expired
 * items independently and late, so the margin keeps an owner from expiring before its member row
 * and letting another member register the endpoint without removing the earlier registration.
 */
const ownerRetentionMarginDays = 30

/** Attempts to win the endpoint ownership race before reporting a conflict. */
const maxOwnershipAttempts = 3

/** Sort key of a member's registration version, bumped by every new device registration. */
const memberVersionSortKey = 'devices'

/** Minimal DynamoDB command boundary used by the push subscription store. */
type PushSubscriptionDocumentClient = {
  /** Sends one read, query, or transaction. */
  send(command: GetCommand | QueryCommand | TransactWriteCommand | DeleteCommand, options?: {
    /** Cancels the request when the delivery deadline passes. */
    abortSignal?: AbortSignal
  }): Promise<{
    /** Strongly read item. */
    Item?: Record<string, unknown>
    /** Items read by a query. */
    Items?: Record<string, unknown>[]
    /** Number of items matched by a count query. */
    Count?: number
    /** Key of the last item read when the query stopped early. */
    LastEvaluatedKey?: Record<string, unknown>
  }>
}

/** Owner record of a push endpoint: its current or last member and when it last changed. */
type EndpointOwner = {
  /** Owning, or last owning, Workspace. */
  workspaceId: string
  /** Owning, or last owning, member. */
  memberKey: string
  /** Server time in epoch milliseconds of the last registration or removal. */
  changedAt: number
  /** Random token of the last write; owner writes compare it, so two writes never look alike. */
  revision: string
  /** Whether the last member removed the endpoint, leaving the record as a tombstone. */
  removed: boolean
}

/**
 * Builds the partition of a member's subscriptions.
 *
 * @param workspaceId - Workspace ID.
 * @param memberKey - Member key.
 * @returns Partition key.
 */
function memberPartition(workspaceId: string, memberKey: string): string {
  // Each component is encoded, so `#` inside an ID can never shift the boundary between them.
  return `member#${encodeURIComponent(workspaceId)}#${encodeURIComponent(memberKey)}`
}

/**
 * Builds the partition of an endpoint's owner record.
 *
 * @param subscriptionId - Endpoint-derived subscription ID.
 * @returns Partition key.
 */
function endpointPartition(subscriptionId: string): string {
  return `endpoint#${subscriptionId}`
}

/** DynamoDB-backed push subscriptions with exclusive endpoint ownership. */
export class DynamoDbPushSubscriptionStore implements PushSubscriptionStore, PushDeviceDirectory {
  /** Document client configured by the composition root. */
  readonly #client: PushSubscriptionDocumentClient
  /** Push subscriptions table. */
  readonly #tableName: string

  /**
   * Creates the store.
   *
   * @param client - DynamoDB document client.
   * @param tableName - Push subscriptions table name.
   */
  constructor(client: PushSubscriptionDocumentClient, tableName: string) {
    this.#client = client
    this.#tableName = tableName
  }

  /**
   * Registers or refreshes a subscription for a member.
   *
   * @param workspaceId - Workspace of the member.
   * @param memberKey - Member registering the device.
   * @param subscription - Validated subscription.
   * @param now - Current time.
   */
  async register(
    workspaceId: string,
    memberKey: string,
    subscription: ValidatedPushSubscription,
    now: Date,
  ): Promise<void> {
    const partition = memberPartition(workspaceId, memberKey)
    const expiresAt = Math.floor(now.getTime() / 1_000) + subscriptionRetentionDays * 86_400
    for (let attempt = 0; attempt < maxOwnershipAttempts; attempt += 1) {
      const owner = await this.#readOwner(subscription.subscriptionId)
      // The endpoint was registered or removed after this request started, by any member, so the
      // request is stale and must not undo that change, including when it lost the race and retries.
      // Equal times count as newer too: two requests in the same millisecond cannot be ordered.
      if (owner && owner.changedAt >= now.getTime()) {
        // A newer registration by this member already holds the endpoint, so this request has
        // nothing left to do. A newer removal or another member's claim still wins.
        if (!owner.removed && owner.workspaceId === workspaceId && owner.memberKey === memberKey) return
        throw new NotificationError(409, 'PushSubscriptionConflict', 'A newer change owns this push subscription.')
      }
      const liveOwner = owner && !owner.removed ? owner : undefined
      const ownedByMember = liveOwner?.workspaceId === workspaceId && liveOwner.memberKey === memberKey
      // Only a stored, unexpired subscription is refreshed. An owner can outlive an expired member
      // row, and that device counts again as new, as does a row DynamoDB has yet to delete; the
      // transaction re-checks the row still exists and has not expired.
      const refresh = ownedByMember && await this.#hasSubscription(partition, subscription.subscriptionId, now)
      // A new device is counted against the limit and fenced by the member's registration
      // version, so two devices registering at once cannot both pass the same count.
      const version = refresh ? undefined : await this.#readMemberVersion(partition)
      if (version !== undefined && await this.#countSubscriptions(partition, now) >= MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER) {
        throw new NotificationError(409, 'PushSubscriptionLimitExceeded', 'Too many devices receive push notifications.')
      }
      const ownerItem = {
        pk: endpointPartition(subscription.subscriptionId),
        sk: 'owner',
        workspaceId,
        memberKey,
        changedAt: now.getTime(),
        revision: randomUUID(),
        expiresAt: expiresAt + ownerRetentionMarginDays * 86_400,
      }
      try {
        await this.#client.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.#tableName,
                Item: ownerItem,
                // Fence the exact owner record read above, so every change is applied in order and a
                // concurrent registration or removal is retried, never overwritten.
                ...ownerFence(owner),
              },
            },
            {
              Put: {
                TableName: this.#tableName,
                Item: {
                  pk: partition,
                  sk: `subscription#${subscription.subscriptionId}`,
                  workspaceId,
                  memberKey,
                  subscriptionId: subscription.subscriptionId,
                  endpoint: subscription.endpoint,
                  p256dh: subscription.keys.p256dh,
                  auth: subscription.keys.auth,
                  updatedAt: now.toISOString(),
                  expiresAt,
                },
                ...(refresh
                  ? {
                      ConditionExpression: 'attribute_exists(sk) AND expiresAt > :now',
                      ExpressionAttributeValues: { ':now': Math.floor(now.getTime() / 1_000) },
                    }
                  : {}),
              },
            },
            ...(version !== undefined
              ? [{
                  Update: {
                    TableName: this.#tableName,
                    Key: { pk: partition, sk: memberVersionSortKey },
                    UpdateExpression: 'SET version = :next, workspaceId = :workspace',
                    ConditionExpression: version === 0
                      ? 'attribute_not_exists(version)'
                      : 'version = :current',
                    ExpressionAttributeValues: {
                      ':next': version + 1,
                      ':workspace': workspaceId,
                      ...(version === 0 ? {} : { ':current': version }),
                    },
                  },
                }]
              : []),
            ...(liveOwner && !ownedByMember
              ? [{
                  Delete: {
                    TableName: this.#tableName,
                    Key: {
                      pk: memberPartition(liveOwner.workspaceId, liveOwner.memberKey),
                      sk: `subscription#${subscription.subscriptionId}`,
                    },
                  },
                }]
              : []),
          ],
        }))
        return
      } catch (error: unknown) {
        if (!isTransactionConflict(error)) throw error
      }
    }
    throw new NotificationError(409, 'PushSubscriptionConflict', 'The push subscription changed while it was being registered.')
  }

  /**
   * Removes a member's subscription for an endpoint.
   *
   * While the member owns the endpoint, the owner record becomes a tombstone carrying the removal
   * time instead of disappearing, so a registration that started earlier, from any tab or retry,
   * is recognised as stale and cannot recreate the registration afterwards. A removal that started
   * before the endpoint's last change is itself stale and leaves that newer state alone.
   *
   * @param workspaceId - Workspace of the member.
   * @param memberKey - Member removing the device.
   * @param endpoint - Endpoint to remove.
   * @param now - Current time.
   */
  async remove(workspaceId: string, memberKey: string, endpoint: string, now: Date): Promise<void> {
    const subscriptionId = createPushSubscriptionId(endpoint)
    const ownerKey = { pk: endpointPartition(subscriptionId), sk: 'owner' }
    for (let attempt = 0; attempt < maxOwnershipAttempts; attempt += 1) {
      const owner = await this.#readOwner(subscriptionId)
      if (owner && owner.changedAt >= now.getTime()) return
      const ownedByMember = owner !== undefined && !owner.removed &&
        owner.workspaceId === workspaceId && owner.memberKey === memberKey
      // The member row and the owner record change in one transaction fenced on the owner read,
      // so a concurrent registration can never leave either alone.
      const ownerOperation = ownedByMember
        ? {
            Put: {
              TableName: this.#tableName,
              Item: {
                ...ownerKey,
                workspaceId,
                memberKey,
                changedAt: now.getTime(),
                revision: randomUUID(),
                removed: true,
                expiresAt: Math.floor(now.getTime() / 1_000) + ownerRetentionMarginDays * 86_400,
              },
              ...ownerFence(owner),
            },
          }
        : { ConditionCheck: { TableName: this.#tableName, Key: ownerKey, ...ownerFence(owner) } }
      try {
        await this.#client.send(new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: this.#tableName,
                Key: { pk: memberPartition(workspaceId, memberKey), sk: `subscription#${subscriptionId}` },
              },
            },
            ownerOperation,
          ],
        }))
        return
      } catch (error: unknown) {
        if (!isTransactionConflict(error)) throw error
      }
    }
    throw new NotificationError(409, 'PushSubscriptionConflict', 'The push subscription changed while it was being removed.')
  }

  /**
   * Lists the member's unexpired devices whose endpoint owner record still names that member, so
   * a device another member took over, or one removed after this read began, receives nothing.
   *
   * @param workspaceId - Workspace of the recipient.
   * @param memberKey - Recipient member.
   * @param now - Delivery time.
   * @param signal - Delivery deadline.
   * @returns Devices to send to, at most the per-member limit.
   */
  async listDevices(workspaceId: string, memberKey: string, now: Date, signal: AbortSignal): Promise<PushDevice[]> {
    const partition = memberPartition(workspaceId, memberKey)
    const nowSeconds = Math.floor(now.getTime() / 1_000)
    const devices: PushDevice[] = []
    let startKey: Record<string, unknown> | undefined
    // The registration limit bounds live rows; the page bound keeps one delivery's reads finite.
    for (let page = 0; page < 5; page += 1) {
      const result = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': partition, ':prefix': 'subscription#' },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }), { abortSignal: signal })
      for (const item of result.Items ?? []) {
        const { subscriptionId, endpoint, p256dh, auth, updatedAt, expiresAt } = item
        // A row whose retention cannot be established fails closed instead of being sent to.
        if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) {
          throw new NotificationError(503, 'PushSubscriptionUnavailable', 'The push subscription record is invalid.')
        }
        if (expiresAt <= nowSeconds) continue
        if (
          typeof subscriptionId !== 'string' || typeof endpoint !== 'string' || typeof p256dh !== 'string' ||
          typeof auth !== 'string' || typeof updatedAt !== 'string' || createPushSubscriptionId(endpoint) !== subscriptionId
        ) {
          throw new NotificationError(503, 'PushSubscriptionUnavailable', 'The push subscription record is invalid.')
        }
        devices.push({ subscriptionId, endpoint, keys: { p256dh, auth }, updatedAt })
      }
      startKey = result.LastEvaluatedKey
      if (!startKey) break
    }
    // Expired rows awaiting TTL deletion are not bounded by the limit, so a partial list is not a result.
    if (startKey) {
      throw new NotificationError(503, 'PushSubscriptionUnavailable', 'The push subscription list could not be read completely.')
    }
    const owned: PushDevice[] = []
    for (const device of devices.slice(0, MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER)) {
      const owner = await this.#readOwner(device.subscriptionId, signal)
      if (owner && !owner.removed && owner.workspaceId === workspaceId && owner.memberKey === memberKey) owned.push(device)
    }
    return owned
  }

  /**
   * Strongly rechecks that the recipient still owns a device's endpoint right before a send.
   *
   * @param workspaceId - Workspace of the recipient.
   * @param memberKey - Recipient member key.
   * @param device - Device about to be sent to.
   * @param signal - Delivery deadline.
   * @returns `true` while the live owner record names the recipient.
   */
  async isDeviceOwned(workspaceId: string, memberKey: string, device: PushDevice, signal: AbortSignal): Promise<boolean> {
    const owner = await this.#readOwner(device.subscriptionId, signal)
    return Boolean(owner && !owner.removed && owner.workspaceId === workspaceId && owner.memberKey === memberKey)
  }

  /**
   * Deletes a device the push service reported as gone (`404` / `410`). Only the exact
   * registration that was sent to is deleted, so a browser that registered the endpoint again
   * meanwhile keeps its newer row.
   *
   * @param workspaceId - Workspace of the recipient.
   * @param memberKey - Recipient member.
   * @param device - Device read by {@link listDevices}.
   * @param signal - Delivery deadline.
   */
  async removeGoneDevice(workspaceId: string, memberKey: string, device: PushDevice, signal: AbortSignal): Promise<void> {
    try {
      await this.#client.send(new DeleteCommand({
        TableName: this.#tableName,
        Key: { pk: memberPartition(workspaceId, memberKey), sk: `subscription#${device.subscriptionId}` },
        ConditionExpression: 'updatedAt = :updatedAt',
        ExpressionAttributeValues: { ':updatedAt': device.updatedAt },
      }), { abortSignal: signal })
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return
      throw error
    }
  }

  /**
   * Strongly checks whether a member still stores an unexpired subscription.
   *
   * @param partition - Member partition.
   * @param subscriptionId - Endpoint-derived subscription ID.
   * @param now - Server time of the request.
   * @returns `true` when the subscription row exists and is within its retention.
   */
  async #hasSubscription(partition: string, subscriptionId: string, now: Date): Promise<boolean> {
    const { Item } = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: partition, sk: `subscription#${subscriptionId}` },
      ConsistentRead: true,
    }))
    const expiresAt: unknown = Item?.expiresAt
    return typeof expiresAt === 'number' && expiresAt > Math.floor(now.getTime() / 1_000)
  }

  /**
   * Strongly reads the owner record of an endpoint.
   *
   * @param subscriptionId - Endpoint-derived subscription ID.
   * @param signal - Optional deadline of a delivery read.
   * @returns The owner record, which may be a tombstone, or `undefined` when none exists.
   */
  async #readOwner(subscriptionId: string, signal?: AbortSignal): Promise<EndpointOwner | undefined> {
    const { Item } = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: endpointPartition(subscriptionId), sk: 'owner' },
      ConsistentRead: true,
    }), signal ? { abortSignal: signal } : undefined)
    if (!Item) return undefined
    const { workspaceId, memberKey, changedAt, revision, removed } = Item
    // Only the supported shapes are trusted; anything else fails closed instead of reading as a live owner.
    if (
      typeof workspaceId !== 'string' ||
      typeof memberKey !== 'string' ||
      typeof changedAt !== 'number' ||
      typeof revision !== 'string' ||
      (removed !== undefined && typeof removed !== 'boolean')
    ) {
      throw new NotificationError(503, 'PushSubscriptionUnavailable', 'The push subscription record is invalid.')
    }
    return { workspaceId, memberKey, changedAt, revision, removed: removed === true }
  }

  /**
   * Counts a member's stored subscriptions.
   *
   * Rows past their `expiresAt` are left out: DynamoDB deletes expired items only eventually, and
   * a subscription past its retention must not keep a member from registering a new device.
   * Rows whose expiry is missing or malformed are counted.
   *
   * @param partition - Member partition.
   * @param now - Server time of the request.
   * @returns Number of unexpired subscriptions.
   */
  async #countSubscriptions(partition: string, now: Date): Promise<number> {
    let total = 0
    let startKey: Record<string, unknown> | undefined
    do {
      const { Count, LastEvaluatedKey } = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        // Only a row with a numeric expiry in the past is left out; a row with a missing or
        // malformed expiry still takes a slot, so corrupt data never lets a member exceed the limit.
        FilterExpression: 'NOT (attribute_type(expiresAt, :number) AND expiresAt <= :now)',
        ExpressionAttributeValues: {
          ':pk': partition,
          ':prefix': 'subscription#',
          ':number': 'N',
          ':now': Math.floor(now.getTime() / 1_000),
        },
        Select: 'COUNT',
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }))
      total += Count ?? 0
      startKey = LastEvaluatedKey
    } while (startKey)
    return total
  }

  /**
   * Strongly reads a member's registration version.
   *
   * @param partition - Member partition.
   * @returns The version, or 0 before the first registration.
   */
  async #readMemberVersion(partition: string): Promise<number> {
    const { Item } = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: partition, sk: memberVersionSortKey },
      ConsistentRead: true,
    }))
    if (Item === undefined) return 0
    // An existing row without a valid version cannot fence anything, so it fails closed.
    const version: unknown = Item.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new NotificationError(503, 'PushSubscriptionUnavailable', 'The push subscription record is invalid.')
    }
    return version
  }
}

/** Cancellation reasons that mean another registration changed the guarded rows first. */
const raceCancellationCodes: readonly string[] = ['ConditionalCheckFailed', 'TransactionConflict']

/**
 * Builds the condition that the owner record is still exactly the one read, compared by its
 * random revision so two writes can never be mistaken for each other, so owner changes apply in order.
 *
 * @param owner - Owner record read before the write, if any.
 * @returns Condition expression and values for the owner record.
 */
function ownerFence(owner: EndpointOwner | undefined): {
  /** Condition on the owner record. */
  ConditionExpression: string
  /** Values the condition refers to. */
  ExpressionAttributeValues?: Record<string, unknown>
} {
  return owner
    ? { ConditionExpression: 'revision = :ownerRevision', ExpressionAttributeValues: { ':ownerRevision': owner.revision } }
    : { ConditionExpression: 'attribute_not_exists(pk)' }
}

/**
 * Returns whether a transaction lost a race with a concurrent registration.
 *
 * Only failed conditions and transaction conflicts are retried. A cancellation caused by
 * throttling, validation, or capacity is rethrown so it stays a retryable infrastructure failure
 * instead of becoming an ownership conflict.
 *
 * @param error - Error thrown by DynamoDB.
 * @returns `true` when every reported reason is a race.
 */
function isTransactionConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'TransactionConflictException') return true
  if (error.name !== 'TransactionCanceledException') return false
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return false
  const codes = reasons.map((reason: unknown) =>
    typeof reason === 'object' && reason !== null ? Reflect.get(reason, 'Code') : undefined)
  return codes.some((code) => typeof code === 'string' && raceCancellationCodes.includes(code)) &&
    codes.every((code) => code === undefined || code === 'None' || (typeof code === 'string' && raceCancellationCodes.includes(code)))
}
