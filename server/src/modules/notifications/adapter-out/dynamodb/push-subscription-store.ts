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
import { NotificationError } from '../../notifications'

/** Days a subscription is kept without being registered again by its browser. */
const subscriptionRetentionDays = 180

/** Attempts to win the endpoint ownership race before reporting a conflict. */
const maxOwnershipAttempts = 3

/** Minimal DynamoDB command boundary used by the push subscription store. */
type PushSubscriptionDocumentClient = {
  /** Sends one read, query, delete, or transaction. */
  send(command: GetCommand | QueryCommand | DeleteCommand | TransactWriteCommand): Promise<{
    /** Strongly read item. */
    Item?: Record<string, unknown>
    /** Number of items matched by a count query. */
    Count?: number
  }>
}

/** Member that currently owns a push endpoint. */
type EndpointOwner = {
  /** Owning Workspace. */
  workspaceId: string
  /** Owning member. */
  memberKey: string
}

/** Push subscription storage used by the subscription routes. */
export type PushSubscriptionStore = {
  /**
   * Registers or refreshes a subscription for a member, taking the endpoint over from any other
   * member so one device never receives two people's notifications.
   */
  register(workspaceId: string, memberKey: string, subscription: ValidatedPushSubscription, now: Date): Promise<void>
  /** Removes a member's subscription for an endpoint; removing a missing one succeeds. */
  remove(workspaceId: string, memberKey: string, endpoint: string): Promise<void>
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
      if (!ownedByMember && await this.#countSubscriptions(partition) >= MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER) {
        throw new NotificationError(409, 'PushSubscriptionLimitExceeded', 'Too many devices receive push notifications.')
      }
      const ownerItem = {
        pk: endpointPartition(subscription.subscriptionId),
        sk: 'owner',
        workspaceId,
        memberKey,
        expiresAt,
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
              },
            },
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
    await this.#client.send(new DeleteCommand({
      TableName: this.#tableName,
      Key: { pk: memberPartition(workspaceId, memberKey), sk: `subscription#${subscriptionId}` },
    }))
    try {
      // Release the endpoint only while this member still owns it.
      await this.#client.send(new DeleteCommand({
        TableName: this.#tableName,
        Key: { pk: endpointPartition(subscriptionId), sk: 'owner' },
        ConditionExpression: 'workspaceId = :workspace AND memberKey = :member',
        ExpressionAttributeValues: { ':workspace': workspaceId, ':member': memberKey },
      }))
    } catch (error: unknown) {
      if (!isConditionalCheckFailure(error)) throw error
    }
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
    const { Count } = await this.#client.send(new QueryCommand({
      TableName: this.#tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': partition, ':prefix': 'subscription#' },
      Select: 'COUNT',
      ConsistentRead: true,
    }))
    return Count ?? 0
  }
}

/**
 * Returns whether an error is a conditional write failure.
 *
 * @param error - Error thrown by DynamoDB.
 * @returns `true` for `ConditionalCheckFailedException`.
 */
function isConditionalCheckFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException'
}

/**
 * Returns whether a transaction was cancelled by a failed condition or a concurrent write.
 *
 * @param error - Error thrown by DynamoDB.
 * @returns `true` for a cancelled transaction.
 */
function isTransactionConflict(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TransactionCanceledException' || error.name === 'TransactionConflictException')
}
