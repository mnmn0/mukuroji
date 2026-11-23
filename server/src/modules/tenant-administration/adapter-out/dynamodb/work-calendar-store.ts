import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import type { WorkCalendar } from '@mukuroji/contracts'
import {
  InvalidStoredWorkCalendarError,
  WorkCalendarAuthorizationChangedError,
  WorkCalendarRevisionConflictError,
  createStoredWorkCalendar,
  createTeamWorkCalendarRecordPrefix,
  createWorkCalendarRecordKey,
  readStoredWorkCalendar,
  toStoredWorkCalendarFields,
  type StoredWorkCalendarScope,
  type WorkCalendarAuthorizationFence,
  type WorkCalendarStore,
  type WorkCalendarWrite,
} from '../../domain/work-calendars'

/** Entry type that tells calendar rows apart from the other tenant records. */
const ENTRY_TYPE = 'work-calendar'

/** Most calendar rows one Team query reads: the Team's own and one per Project. */
const TEAM_CALENDAR_QUERY_PAGE_LIMIT = 100

/**
 * Keeps Team and Project calendars in the Workspace partition of the tenant administration table
 * (ADR 0058), so tenant export and closure handle them with the rest of the partition.
 */
export class DynamoDbWorkCalendarStore implements WorkCalendarStore {
  /** Tenant administration table. */
  private readonly tableName: string
  /** DynamoDB document client. */
  private readonly documentClient: DynamoDBDocumentClient

  /**
   * @param tableName - Tenant administration table.
   * @param documentClient - DynamoDB document client.
   */
  constructor(tableName: string, documentClient: DynamoDBDocumentClient) {
    this.tableName = tableName
    this.documentClient = documentClient
  }

  /** @inheritdoc */
  async get(workspaceId: string, scope: StoredWorkCalendarScope): Promise<WorkCalendar | undefined> {
    const result = await this.documentClient.send(new GetCommand({
      TableName: this.tableName,
      Key: { workspaceId, recordKey: createWorkCalendarRecordKey(scope) },
      ConsistentRead: true,
    }))
    return result.Item ? readCalendarRow(result.Item) : undefined
  }

  /** @inheritdoc */
  async listTeam(workspaceId: string, teamId: string): Promise<WorkCalendar[]> {
    const calendars: WorkCalendar[] = []
    let exclusiveStartKey: Record<string, unknown> | undefined
    do {
      const result = await this.documentClient.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'workspaceId = :workspaceId AND begins_with(recordKey, :prefix)',
        ExpressionAttributeValues: {
          ':workspaceId': workspaceId,
          ':prefix': createTeamWorkCalendarRecordPrefix(teamId),
        },
        ConsistentRead: true,
        Limit: TEAM_CALENDAR_QUERY_PAGE_LIMIT,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }))
      for (const item of result.Items ?? []) calendars.push(readCalendarRow(item))
      exclusiveStartKey = result.LastEvaluatedKey
    } while (exclusiveStartKey)
    return calendars
  }

  /** @inheritdoc */
  async save(
    workspaceId: string,
    write: WorkCalendarWrite,
    expectedRevision: number,
    actorMemberKey: string,
    now: string,
    authorizationFences: readonly WorkCalendarAuthorizationFence[] = [],
  ): Promise<WorkCalendar> {
    const calendar = createStoredWorkCalendar(write, expectedRevision + 1, actorMemberKey, now)
    const put = {
      TableName: this.tableName,
      Item: {
        workspaceId,
        recordKey: createWorkCalendarRecordKey(write.scope),
        entryType: ENTRY_TYPE,
        ...toStoredWorkCalendarFields(calendar),
      },
      ...(expectedRevision === 0
        ? { ConditionExpression: 'attribute_not_exists(recordKey)' }
        : {
            ConditionExpression: 'entryType = :entryType AND revision = :expectedRevision',
            ExpressionAttributeValues: {
              ':entryType': ENTRY_TYPE,
              ':expectedRevision': expectedRevision,
            },
          }),
    }
    if (authorizationFences.length === 0) {
      try {
        await this.documentClient.send(new PutCommand(put))
      } catch (error) {
        if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
          throw new WorkCalendarRevisionConflictError()
        }
        throw error
      }
      return calendar
    }
    try {
      await this.documentClient.send(new TransactWriteCommand({
        TransactItems: [
          { Put: put },
          ...authorizationFences.map((fence) => ({ ConditionCheck: { ...fence.ConditionCheck } })),
        ],
      }))
    } catch (error) {
      throw readTransactionFailure(error)
    }
    return calendar
  }
}

/**
 * Names the failure of a fenced calendar save.
 *
 * @param error - Error the transaction raised.
 * @returns A revision conflict when the calendar row moved on, an authorization change when a
 *   fence failed, or the error itself.
 */
function readTransactionFailure(error: unknown): unknown {
  if (!(error instanceof Error) || error.name !== 'TransactionCanceledException') return error
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return error
  const failed = (index: number) => {
    const reason: unknown = reasons[index]
    return typeof reason === 'object' && reason !== null &&
      Reflect.get(reason, 'Code') === 'ConditionalCheckFailed'
  }
  if (failed(0)) return new WorkCalendarRevisionConflictError()
  if (reasons.some((_, index) => index > 0 && failed(index))) return new WorkCalendarAuthorizationChangedError()
  return error
}

/**
 * Reads one stored calendar row.
 *
 * @param item - Stored row.
 * @returns The calendar.
 * @throws InvalidStoredWorkCalendarError when the row is malformed.
 */
function readCalendarRow(item: Record<string, unknown>): WorkCalendar {
  const calendar = item.entryType === ENTRY_TYPE ? readStoredWorkCalendar(item) : undefined
  if (!calendar || item.recordKey !== createWorkCalendarRecordKey(calendar.scope)) {
    throw new InvalidStoredWorkCalendarError()
  }
  return calendar
}
