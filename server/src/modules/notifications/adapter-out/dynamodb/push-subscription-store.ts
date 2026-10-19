import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER,
  createPushSubscriptionId,
  type ValidatedPushSubscription,
} from '../../domain/push-subscription'
import { NotificationError } from '../../notifications'
import type { PushSubscriptionStore } from '../../application/push-subscriptions'

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
  send(command: GetCommand | QueryCommand | TransactWriteCommand): Promise<{
    /** Strongly read item. */
    Item?: Record<string, unknown>
    /** Number of items matched by a count query. */
    Count?: number
    /** Key of the last item read when the query stopped early. */
    LastEvaluatedKey?: Record<string, unknown>
  }>
}

/** Member that currently owns a push endpoint. */
type EndpointOwner = {
  /** Owning Workspace. */
  workspaceId: string
  /** Owning member. */
  memberKey: string
}

/**
 * Builds the partition of a member's subscriptions.
 *
 * @param workspaceId - Workspace ID.
 * @param memberKey - Member key.
 * @returns Partition key.
 */
function memberPartition(workspaceId: string, memberKey: string): string {
  return `member#${workspaceId}#${memberKey}`
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
export class DynamoDbPushSubscriptionStore implements PushSubscriptionStore {
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
      const ownedByMember = owner?.workspaceId === workspaceId && owner.memberKey === memberKey
      // Only a stored subscription is refreshed. An owner can outlive an expired member row, and
      // that device counts again as new; the transaction re-checks the row still exists.
      const refresh = ownedByMember && await this.#hasSubscription(partition, subscription.subscriptionId)
      // A new device is counted against the limit and fenced by the member's registration
      // version, so two devices registering at once cannot both pass the same count.
      const version = refresh ? undefined : await this.#readMemberVersion(partition)
      if (version !== undefined && await this.#countSubscriptions(partition) >= MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER) {
        throw new NotificationError(409, 'PushSubscriptionLimitExceeded', 'Too many devices receive push notifications.')
      }
      const ownerItem = {
        pk: endpointPartition(subscription.subscriptionId),
        sk: 'owner',
        workspaceId,
        memberKey,
        expiresAt: expiresAt + ownerRetentionMarginDays * 86_400,
      }
      try {
        await this.#client.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.#tableName,
                Item: ownerItem,
                // Fence the owner read above so a concurrent takeover is retried, not overwritten.
                ...(owner
                  ? {
                      ConditionExpression: 'workspaceId = :ownerWorkspace AND memberKey = :ownerMember',
                      ExpressionAttributeValues: { ':ownerWorkspace': owner.workspaceId, ':ownerMember': owner.memberKey },
                    }
                  : { ConditionExpression: 'attribute_not_exists(pk)' }),
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
                ...(refresh ? { ConditionExpression: 'attribute_exists(sk)' } : {}),
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
            ...(owner && !ownedByMember
              ? [{
                  Delete: {
                    TableName: this.#tableName,
                    Key: {
                      pk: memberPartition(owner.workspaceId, owner.memberKey),
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
   * @param workspaceId - Workspace of the member.
   * @param memberKey - Member removing the device.
   * @param endpoint - Push service URL.
   */
  async remove(workspaceId: string, memberKey: string, endpoint: string): Promise<void> {
    const subscriptionId = createPushSubscriptionId(endpoint)
    const ownerKey = { pk: endpointPartition(subscriptionId), sk: 'owner' }
    for (let attempt = 0; attempt < maxOwnershipAttempts; attempt += 1) {
      const owner = await this.#readOwner(subscriptionId)
      const ownedByMember = owner?.workspaceId === workspaceId && owner.memberKey === memberKey
      // The member row and, while this member owns the endpoint, the owner row are deleted in one
      // transaction fenced on the owner read, so a concurrent refresh can never leave either alone.
      const ownerOperation = ownedByMember
        ? {
            Delete: {
              TableName: this.#tableName,
              Key: ownerKey,
              ConditionExpression: 'workspaceId = :workspace AND memberKey = :member',
              ExpressionAttributeValues: { ':workspace': workspaceId, ':member': memberKey },
            },
          }
        : {
            ConditionCheck: {
              TableName: this.#tableName,
              Key: ownerKey,
              ...(owner
                ? {
                    ConditionExpression: 'workspaceId = :workspace AND memberKey = :member',
                    ExpressionAttributeValues: { ':workspace': owner.workspaceId, ':member': owner.memberKey },
                  }
                : { ConditionExpression: 'attribute_not_exists(pk)' }),
            },
          }
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
   * Strongly checks whether a member still stores a subscription.
   *
   * @param partition - Member partition.
   * @param subscriptionId - Endpoint-derived subscription ID.
   * @returns `true` when the subscription row exists.
   */
  async #hasSubscription(partition: string, subscriptionId: string): Promise<boolean> {
    const { Item } = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: partition, sk: `subscription#${subscriptionId}` },
      ConsistentRead: true,
    }))
    return Item !== undefined
  }

  /**
   * Strongly reads the current owner of an endpoint.
   *
   * @param subscriptionId - Endpoint-derived subscription ID.
   * @returns The owner, or `undefined` when the endpoint is unowned.
   */
  async #readOwner(subscriptionId: string): Promise<EndpointOwner | undefined> {
    const { Item } = await this.#client.send(new GetCommand({
      TableName: this.#tableName,
      Key: { pk: endpointPartition(subscriptionId), sk: 'owner' },
      ConsistentRead: true,
    }))
    if (!Item) return undefined
    const { workspaceId, memberKey } = Item
    if (typeof workspaceId !== 'string' || typeof memberKey !== 'string') {
      throw new NotificationError(503, 'PushSubscriptionUnavailable', 'The push subscription record is invalid.')
    }
    return { workspaceId, memberKey }
  }

  /**
   * Counts a member's stored subscriptions.
   *
   * @param partition - Member partition.
   * @returns Number of subscriptions.
   */
  async #countSubscriptions(partition: string): Promise<number> {
    let total = 0
    let startKey: Record<string, unknown> | undefined
    do {
      const { Count, LastEvaluatedKey } = await this.#client.send(new QueryCommand({
        TableName: this.#tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': partition, ':prefix': 'subscription#' },
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
    const version = Item?.version
    if (version === undefined) return 0
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new NotificationError(503, 'PushSubscriptionUnavailable', 'The push subscription record is invalid.')
    }
    return version
  }
}

/** Cancellation reasons that mean another registration changed the guarded rows first. */
const raceCancellationCodes: readonly string[] = ['ConditionalCheckFailed', 'TransactionConflict']

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
