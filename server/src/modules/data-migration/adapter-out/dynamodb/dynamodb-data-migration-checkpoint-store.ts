import {
  CreateTableCommand,
  DescribeTableCommand,
  type DynamoDBClient,
  type TableDescription,
} from '@aws-sdk/client-dynamodb'
import {
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  DataMigrationFailure,
  type DataMigrationCheckpoint,
  type DataMigrationCounters,
} from '../../domain/data-migration'
import type { DataMigrationCheckpointStore } from '../../application/ports/data-migration-ports'
import { isConditionalCheckFailure } from './dynamodb-data-migration-row-store'

/** Partition key attribute of the checkpoint table. */
const PARTITION_KEY = 'migrationId'

/** Sort key attribute of the checkpoint table. */
const SORT_KEY = 'partitionId'

/** Stored checkpoint row format version. */
const CHECKPOINT_SCHEMA_VERSION = 1

/** Counter names in stored order. */
const COUNTER_NAMES = ['scanned', 'migrated', 'alreadyMigrated', 'unrelated', 'vanished'] as const

/**
 * Creates a checkpoint store on a table keyed by `migrationId` and
 * `partitionId`. Every save is a conditional put on the stored revision.
 *
 * @param options - Client and physical table name.
 * @returns The checkpoint store.
 */
export function createDynamoDbDataMigrationCheckpointStore(options: {
  /** Document client used for every call. */
  readonly documentClient: DynamoDBDocumentClient
  /** Physical name of the checkpoint table. */
  readonly tableName: string
}): DataMigrationCheckpointStore {
  const { documentClient, tableName } = options
  if (tableName.trim().length === 0) throw new DataMigrationFailure('DEFINITION_INVALID')
  return {
    list: async (migrationId) => {
      const checkpoints: DataMigrationCheckpoint[] = []
      let exclusiveStartKey: Record<string, unknown> | undefined
      const seen = new Set<string>()
      do {
        let output
        try {
          output = await documentClient.send(new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: '#migrationId = :migrationId',
            ExpressionAttributeNames: { '#migrationId': PARTITION_KEY },
            ExpressionAttributeValues: { ':migrationId': migrationId },
            ConsistentRead: true,
            ...(exclusiveStartKey === undefined ? {} : { ExclusiveStartKey: exclusiveStartKey }),
          }))
        } catch (error: unknown) {
          throw new DataMigrationFailure('UPSTREAM_FAILURE', error)
        }
        for (const item of output.Items ?? []) {
          checkpoints.push(parseDataMigrationCheckpoint(item, migrationId))
        }
        exclusiveStartKey = output.LastEvaluatedKey
        if (exclusiveStartKey !== undefined) {
          const marker = JSON.stringify(exclusiveStartKey)
          if (seen.has(marker)) throw new DataMigrationFailure('CURSOR_REPEATED')
          seen.add(marker)
        }
      } while (exclusiveStartKey !== undefined)
      return checkpoints
    },
    save: async (checkpoint, expectedRevision) => {
      try {
        await documentClient.send(new PutCommand({
          TableName: tableName,
          Item: { ...checkpoint, schemaVersion: CHECKPOINT_SCHEMA_VERSION },
          ...(expectedRevision === undefined
            ? {
                ConditionExpression: 'attribute_not_exists(#migrationId)',
                ExpressionAttributeNames: { '#migrationId': PARTITION_KEY },
              }
            : {
                ConditionExpression: '#revision = :expectedRevision',
                ExpressionAttributeNames: { '#revision': 'revision' },
                ExpressionAttributeValues: { ':expectedRevision': expectedRevision },
              }),
        }))
        return true
      } catch (error: unknown) {
        if (isConditionalCheckFailure(error)) return false
        throw new DataMigrationFailure('UPSTREAM_FAILURE', error)
      }
    },
  }
}

/**
 * Parses one stored checkpoint row strictly.
 *
 * @param item - Stored row.
 * @param migrationId - Migration the row was queried for.
 * @returns The checkpoint.
 * @throws DataMigrationFailure with `CHECKPOINT_INVALID` for a malformed row.
 */
export function parseDataMigrationCheckpoint(
  item: Readonly<Record<string, unknown>>,
  migrationId: string,
): DataMigrationCheckpoint {
  const counters = parseCounters(item.counters)
  const {
    partitionId,
    partitionCount,
    fromSchemaVersion,
    toSchemaVersion,
    status,
    cursor,
    revision,
    leaseOwner,
    leaseExpiresAt,
    updatedAt,
  } = item
  if (
    item.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
    item.migrationId !== migrationId ||
    typeof partitionId !== 'string' ||
    !isPositiveInteger(partitionCount) ||
    !isPositiveInteger(fromSchemaVersion) ||
    !isPositiveInteger(toSchemaVersion) ||
    (status !== 'in-progress' && status !== 'completed') ||
    !isPositiveInteger(revision) ||
    !isIsoTime(updatedAt) ||
    !isOptionalText(cursor) ||
    (status === 'completed' && cursor !== undefined) ||
    !isOptionalText(leaseOwner) ||
    (leaseExpiresAt !== undefined && !isIsoTime(leaseExpiresAt)) ||
    (leaseOwner === undefined) !== (leaseExpiresAt === undefined)
  ) {
    throw new DataMigrationFailure('CHECKPOINT_INVALID')
  }
  return {
    migrationId,
    partitionId,
    partitionCount,
    fromSchemaVersion,
    toSchemaVersion,
    status,
    ...(cursor === undefined ? {} : { cursor }),
    counters,
    revision,
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
    updatedAt,
  }
}

/**
 * Parses the stored counters map.
 *
 * @param value - Stored counters.
 * @returns The counters.
 */
function parseCounters(value: unknown): DataMigrationCounters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DataMigrationFailure('CHECKPOINT_INVALID')
  }
  const stored = new Map(Object.entries(value))
  if (stored.size !== COUNTER_NAMES.length) throw new DataMigrationFailure('CHECKPOINT_INVALID')
  const read = (name: typeof COUNTER_NAMES[number]): number => {
    const count = stored.get(name)
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      throw new DataMigrationFailure('CHECKPOINT_INVALID')
    }
    return count
  }
  return {
    scanned: read('scanned'),
    migrated: read('migrated'),
    alreadyMigrated: read('alreadyMigrated'),
    unrelated: read('unrelated'),
    vanished: read('vanished'),
  }
}

/**
 * Checks for a positive safe integer.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a positive safe integer.
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * Checks for absent or non-empty text.
 *
 * @param value - Candidate value.
 * @returns Whether the value is undefined or a non-empty string.
 */
function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0)
}

/**
 * Checks for an ISO-8601 UTC timestamp as produced by `Date#toISOString`.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a canonical ISO time.
 */
function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

/**
 * Creates the checkpoint table on a local emulator when it does not exist.
 * Only the CLI calls this, and only for an explicit local endpoint.
 *
 * @param dynamoDbClient - Low-level client bound to the local endpoint.
 * @param tableName - Checkpoint table name.
 */
export async function ensureLocalDataMigrationCheckpointTable(
  dynamoDbClient: DynamoDBClient,
  tableName: string,
): Promise<void> {
  try {
    const described = await dynamoDbClient.send(new DescribeTableCommand({ TableName: tableName }))
    if (!hasCheckpointKeySchema(described.Table)) throw new DataMigrationFailure('CHECKPOINT_INVALID')
    return
  } catch (error: unknown) {
    if (error instanceof DataMigrationFailure) throw error
    if (!isNamedError(error, 'ResourceNotFoundException')) throw new DataMigrationFailure('UPSTREAM_FAILURE', error)
  }
  try {
    await dynamoDbClient.send(new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: PARTITION_KEY, AttributeType: 'S' },
        { AttributeName: SORT_KEY, AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: PARTITION_KEY, KeyType: 'HASH' },
        { AttributeName: SORT_KEY, KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }))
  } catch (error: unknown) {
    if (!isNamedError(error, 'ResourceInUseException')) throw new DataMigrationFailure('UPSTREAM_FAILURE', error)
  }
}

/**
 * Checks that a table has the checkpoint key schema.
 *
 * @param table - Table description.
 * @returns Whether the key schema matches.
 */
function hasCheckpointKeySchema(table: TableDescription | undefined): boolean {
  const keys = table?.KeySchema ?? []
  return keys.length === 2 &&
    keys.some((key) => key.AttributeName === PARTITION_KEY && key.KeyType === 'HASH') &&
    keys.some((key) => key.AttributeName === SORT_KEY && key.KeyType === 'RANGE')
}

/**
 * Checks the `name` of a thrown SDK error.
 *
 * @param error - Thrown value.
 * @param name - Expected error name.
 * @returns Whether the error has that name.
 */
function isNamedError(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}
