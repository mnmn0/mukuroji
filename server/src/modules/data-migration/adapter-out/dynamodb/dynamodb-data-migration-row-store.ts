import {
  GetCommand,
  PutCommand,
  ScanCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb'
import {
  DataMigrationFailure,
  type DataMigrationRow,
  DATA_MIGRATION_MAX_SEGMENTS,
} from '../../domain/data-migration'
import type {
  DataMigrationReplaceOutcome,
  DataMigrationRowStore,
} from '../../application/ports/data-migration-ports'

/** Pattern of a scan-segment partition identifier. */
const SEGMENT_PARTITION_PATTERN = /^segment-([0-9]+)-of-([0-9]+)$/u

/** Options of the DynamoDB row store. */
export type DynamoDbDataMigrationRowStoreOptions = {
  /** Document client used for every call. */
  readonly documentClient: DynamoDBDocumentClient
  /** Physical name of the target table. */
  readonly tableName: string
  /** Number of parallel scan segments; each segment is one checkpoint partition. */
  readonly totalSegments: number
}

/**
 * Creates a row store that partitions a table into parallel scan segments.
 * Pages are strongly consistent scans, and replacements are conditional puts
 * on the stored schema version (and revision for fenced migrations).
 *
 * @param options - Client, table and segment count.
 * @returns The row store.
 */
export function createDynamoDbDataMigrationRowStore(
  options: DynamoDbDataMigrationRowStoreOptions,
): DataMigrationRowStore {
  const { documentClient, tableName, totalSegments } = options
  if (
    tableName.trim().length === 0 ||
    !Number.isSafeInteger(totalSegments) ||
    totalSegments < 1 ||
    totalSegments > DATA_MIGRATION_MAX_SEGMENTS
  ) {
    throw new DataMigrationFailure('DEFINITION_INVALID')
  }
  const partitionIds = Array.from(
    { length: totalSegments },
    (_, segment) => `segment-${segment}-of-${totalSegments}`,
  )
  return {
    targetTable: tableName,
    listPartitions: () => partitionIds,
    readPage: async ({ partitionId, cursor, limit }) => {
      const segment = parseSegment(partitionId, totalSegments)
      const output = await sendClassified(() => documentClient.send(new ScanCommand({
        TableName: tableName,
        Segment: segment,
        TotalSegments: totalSegments,
        Limit: limit,
        ConsistentRead: true,
        ...(cursor === undefined ? {} : { ExclusiveStartKey: decodeDataMigrationCursor(cursor) }),
      })))
      const rows: DataMigrationRow[] = output.Items ?? []
      return {
        rows,
        ...(output.LastEvaluatedKey === undefined
          ? {}
          : { nextCursor: encodeDataMigrationCursor(output.LastEvaluatedKey) }),
      }
    },
    getRow: async (key) => {
      const output = await sendClassified(() => documentClient.send(new GetCommand({
        TableName: tableName,
        Key: { ...key },
        ConsistentRead: true,
      })))
      return output.Item
    },
    replaceRow: async ({ definition, row, expectedRevision }): Promise<DataMigrationReplaceOutcome> => {
      const names: Record<string, string> = { '#version': definition.versionAttribute }
      const values: Record<string, unknown> = { ':fromVersion': definition.fromSchemaVersion }
      const conditions: string[] = []
      for (const [index, keyAttribute] of definition.keyAttributes.entries()) {
        names[`#key${index}`] = keyAttribute
        conditions.push(`attribute_exists(#key${index})`)
      }
      conditions.push('#version = :fromVersion')
      if (definition.revisionAttribute !== undefined) {
        names['#revision'] = definition.revisionAttribute
        if (expectedRevision === undefined) {
          conditions.push('attribute_not_exists(#revision)')
        } else {
          values[':expectedRevision'] = expectedRevision
          conditions.push('#revision = :expectedRevision')
        }
      }
      try {
        await documentClient.send(new PutCommand({
          TableName: tableName,
          Item: { ...row },
          ConditionExpression: conditions.join(' AND '),
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }))
        return 'replaced'
      } catch (error: unknown) {
        if (isConditionalCheckFailure(error)) return 'condition-failed'
        throw new DataMigrationFailure('UPSTREAM_FAILURE', error)
      }
    },
  }
}

/**
 * Encodes a DynamoDB `LastEvaluatedKey` as an opaque cursor.
 *
 * @param key - Last evaluated key.
 * @returns Cursor text.
 */
export function encodeDataMigrationCursor(key: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(validateCursorKey(key))
}

/**
 * Decodes a cursor produced by {@link encodeDataMigrationCursor}.
 *
 * @param cursor - Cursor text.
 * @returns The `ExclusiveStartKey` for the next scan.
 * @throws DataMigrationFailure with `CHECKPOINT_INVALID` for a malformed cursor.
 */
export function decodeDataMigrationCursor(cursor: string): Record<string, string | number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(cursor)
  } catch {
    throw new DataMigrationFailure('CHECKPOINT_INVALID')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DataMigrationFailure('CHECKPOINT_INVALID')
  }
  return validateCursorKey(Object.fromEntries(Object.entries(parsed)))
}

/**
 * Checks that a key has one or two string or number attributes.
 *
 * @param key - Candidate key.
 * @returns A copy with narrowed values.
 */
function validateCursorKey(key: Readonly<Record<string, unknown>>): Record<string, string | number> {
  const entries = Object.entries(key)
  if (entries.length < 1 || entries.length > 2) throw new DataMigrationFailure('CHECKPOINT_INVALID')
  const result: Record<string, string | number> = {}
  for (const [name, value] of entries) {
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) {
      throw new DataMigrationFailure('CHECKPOINT_INVALID')
    }
    result[name] = value
  }
  return result
}

/**
 * Parses a scan-segment partition identifier of this plan.
 *
 * @param partitionId - Partition identifier.
 * @param totalSegments - Segment count of the plan.
 * @returns The segment number.
 */
function parseSegment(partitionId: string, totalSegments: number): number {
  const match = SEGMENT_PARTITION_PATTERN.exec(partitionId)
  const segment = Number(match?.[1])
  if (!match || Number(match[2]) !== totalSegments || !Number.isSafeInteger(segment) || segment >= totalSegments) {
    throw new DataMigrationFailure('PARTITION_PLAN_MISMATCH')
  }
  return segment
}

/**
 * Sends a read and classifies any SDK error as an upstream failure.
 *
 * @param send - Call to make.
 * @returns The call output.
 */
async function sendClassified<T>(send: () => Promise<T>): Promise<T> {
  try {
    return await send()
  } catch (error: unknown) {
    throw new DataMigrationFailure('UPSTREAM_FAILURE', error)
  }
}

/**
 * Detects a DynamoDB conditional check failure.
 *
 * @param error - Thrown value.
 * @returns Whether the error is a conditional check failure.
 */
export function isConditionalCheckFailure(error: unknown): boolean {
  return typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'ConditionalCheckFailedException'
}
