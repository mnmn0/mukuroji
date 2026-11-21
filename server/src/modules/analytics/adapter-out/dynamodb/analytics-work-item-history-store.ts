import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  createAnalyticsWorkItemHistoryRecordKey,
  parseStoredAnalyticsWorkItemHistoryRow,
  toStoredAnalyticsWorkItemHistoryRow,
  type AnalyticsWorkItemHistoryKey,
  type AnalyticsWorkItemHistoryRow,
  type AnalyticsWorkItemHistoryRowRead,
  type AnalyticsWorkItemHistoryStore,
} from '../../analytics-work-item-history'

/** DynamoDB implementation of {@link AnalyticsWorkItemHistoryStore} on the Analytics table. */
export class DynamoDbAnalyticsWorkItemHistoryStore implements AnalyticsWorkItemHistoryStore {
  /** Analytics table name. */
  private readonly tableName: string
  /** DynamoDB DocumentClient. */
  private readonly documentClient: DynamoDBDocumentClient

  /**
   * Creates the store.
   *
   * @param tableName - Analytics table name.
   * @param documentClient - Configured DocumentClient.
   */
  constructor(tableName: string, documentClient: DynamoDBDocumentClient) {
    if (!tableName.trim()) throw new TypeError('Analytics table name is required.')
    this.tableName = tableName
    this.documentClient = documentClient
  }

  /**
   * Reads one row with a strongly consistent read.
   *
   * @param key - Row identity.
   * @returns The parsed row and whether an item exists under the key.
   */
  async getRow(key: AnalyticsWorkItemHistoryKey): Promise<AnalyticsWorkItemHistoryRowRead> {
    const response = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: toKey(key),
      ConsistentRead: true,
    }))
    if (!response.Item) return { row: undefined, exists: false }
    const storedRowVersion = response.Item.rowVersion
    return {
      row: parseStoredAnalyticsWorkItemHistoryRow(response.Item),
      exists: true,
      ...(typeof storedRowVersion === 'number' ? { storedRowVersion } : {}),
    }
  }

  /**
   * Saves a row conditioned on the row that was read.
   *
   * A malformed stored row is overwritten only while it is still the item that was read: its
   * `rowVersion` must match, or stay absent when it had none.
   *
   * @param row - Row to save.
   * @param previous - Result of the read the row was built from.
   * @returns False when the conditional write lost to another writer.
   */
  async putRow(
    row: AnalyticsWorkItemHistoryRow,
    previous: AnalyticsWorkItemHistoryRowRead,
  ): Promise<boolean> {
    const readVersion = previous.row?.rowVersion ?? previous.storedRowVersion
    const condition = readVersion !== undefined
      ? {
          ConditionExpression: 'rowVersion = :rowVersion',
          ExpressionAttributeValues: { ':rowVersion': readVersion },
        }
      : previous.exists
        ? { ConditionExpression: 'attribute_exists(recordKey) AND attribute_not_exists(rowVersion)' }
        : { ConditionExpression: 'attribute_not_exists(recordKey)' }
    try {
      await this.documentClient.send(new PutCommand({
        TableName: this.tableName,
        Item: toStoredAnalyticsWorkItemHistoryRow(row),
        ...condition,
      }))
      return true
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false
      throw error
    }
  }

  /**
   * Deletes a row.
   *
   * @param key - Row identity.
   */
  async deleteRow(key: AnalyticsWorkItemHistoryKey): Promise<void> {
    await this.documentClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: toKey(key),
    }))
  }
}

/**
 * Builds the DynamoDB key of a history row.
 *
 * @param key - Row identity.
 * @returns The `workspaceId` and `recordKey` key.
 */
function toKey(key: AnalyticsWorkItemHistoryKey) {
  return {
    workspaceId: key.workspaceId,
    recordKey: createAnalyticsWorkItemHistoryRecordKey(key.teamId, key.workItemId),
  }
}

/**
 * Returns whether an error is a DynamoDB conditional check failure.
 *
 * @param error - Thrown value.
 * @returns True for `ConditionalCheckFailedException`.
 */
function isConditionalCheckFailure(error: unknown) {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ConditionalCheckFailedException'
}
