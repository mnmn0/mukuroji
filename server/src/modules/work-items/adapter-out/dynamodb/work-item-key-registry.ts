import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
import {
  isCanonicalWorkItemKey,
  parseWorkItemKey,
  WORK_ITEM_KEY_MAX_NUMBER,
  type ParsedWorkItemKey,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../../directory'
import { createWorkItemKeyPrefixCandidates } from '../../domain/work-item-key'

/**
 * Partition key suffix of the per-Workspace Work Item key registry in the Work Items table.
 *
 * The registry shares the Work Items table so every runtime that can create Work Items can also
 * allocate keys. Its rows never carry `sortOrder`, `updatedAt`, or `directoryProjectId`, so they
 * stay out of every Work Item index, and their partition key never has the `#team#` shape of a
 * Work Item partition.
 */
const REGISTRY_PARTITION_SUFFIX = '#work-item-key-registry'

/** Sort key prefix of the row that maps a key prefix to its Team. */
const PREFIX_RECORD_PREFIX = 'prefix#'

/** Sort key prefix of the row that holds a Team's prefix and last allocated number. */
const COUNTER_RECORD_PREFIX = 'team#'

/** Sort key prefix of the row that maps one allocated key to its Work Item. */
const KEY_RECORD_PREFIX = 'key#'

/** Prefix candidates tried before a Team's first allocation gives up: 10 numbered, then 30 hashed. */
const PREFIX_CANDIDATE_LIMIT = 40

/** Counter initialisation rounds tried before an allocation gives up. */
const ALLOCATION_ATTEMPT_LIMIT = 3

/** Row that reserves a key prefix for one Team in the Workspace. */
type WorkItemKeyPrefixRecord = {
  /** Registry partition key. */
  directoryTeamId: string
  /** `prefix#<PREFIX>`. */
  issueId: string
  /** Row discriminator. */
  entryType: 'work-item-key-prefix'
  /** Workspace that owns the registry. */
  directoryId: string
  /** Reserved key prefix. */
  keyPrefix: string
  /** Team that owns the prefix. */
  teamId: string
  /** ISO 8601 instant the prefix was reserved. */
  registeredAt: string
}

/** Row that holds a Team's key prefix and its last allocated sequence number. */
type WorkItemKeyCounterRecord = {
  /** Registry partition key. */
  directoryTeamId: string
  /** `team#<encoded Team ID>`. */
  issueId: string
  /** Row discriminator. */
  entryType: 'work-item-key-counter'
  /** Workspace that owns the registry. */
  directoryId: string
  /** Team whose Work Items take keys from this counter. */
  teamId: string
  /** Immutable key prefix of the Team. */
  keyPrefix: string
  /** Highest number handed out so far; numbers burned by failed creates are not reused. */
  lastNumber: number
  /** ISO 8601 instant the counter was created. */
  registeredAt: string
  /** ISO 8601 instant of the latest allocation, absent before the first. */
  lastAllocatedAt?: string
}

/** Row that maps one allocated key to the Work Item that holds it. */
type WorkItemKeyRecord = {
  /** Registry partition key. */
  directoryTeamId: string
  /** `key#<KEY>`. */
  issueId: string
  /** Row discriminator. */
  entryType: 'work-item-key'
  /** Workspace that owns the registry. */
  directoryId: string
  /** Canonical uppercase key. */
  key: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID within the Team. */
  workItemId: string
  /** ISO 8601 instant the Work Item was created with this key. */
  registeredAt: string
}

/** Where a Work Item key points. */
export type WorkItemKeyLocation = {
  /** Canonical uppercase key. */
  key: string
  /** Team that owns the Work Item. */
  teamId: string
  /** Work Item ID within the Team. */
  workItemId: string
}

/** A key prefix reserved in the Workspace and the Team it belongs to. */
export type WorkItemKeyPrefixAssignment = {
  /** Reserved key prefix, such as `ABC`. */
  keyPrefix: string
  /** Team that owns the prefix. */
  teamId: string
}

/**
 * Builds the registry partition key of a Workspace.
 *
 * @param directoryId - Workspace ID.
 * @returns The partition key shared by every registry row of the Workspace.
 */
function createRegistryPartitionKey(directoryId: string): string {
  return `${directoryId}${REGISTRY_PARTITION_SUFFIX}`
}

/**
 * Builds the sort key of a Team's counter row.
 *
 * @param teamId - Team ID.
 * @returns `team#` followed by the URI-encoded Team ID.
 */
function createCounterRecordKey(teamId: string): string {
  return `${COUNTER_RECORD_PREFIX}${encodeURIComponent(teamId)}`
}

/**
 * Reports whether a Work Items table row is a key registry row with a valid shape.
 *
 * Whole-table readers use this to tell registry rows apart from Work Items; anything else
 * that is not a canonical Work Item stays a failure for them.
 *
 * @param value - Raw Work Items table row.
 * @returns Whether the row is a well-formed key registry row.
 */
export function isWorkItemKeyRegistryRecord(value: unknown): boolean {
  return isWorkItemKeyPrefixRecord(value) ||
    isWorkItemKeyCounterRecord(value) ||
    isWorkItemKeyRecord(value)
}

/**
 * Checks the fields every registry row shares.
 *
 * @param value - Raw row.
 * @param entryType - Expected discriminator.
 * @returns Whether the row is a record of that type in a matching registry partition.
 */
function hasRegistryBase(
  value: unknown,
  entryType: string,
): value is Record<string, unknown> & { directoryId: string; issueId: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Reflect.get(value, 'entryType') === entryType &&
    isText(Reflect.get(value, 'directoryId')) &&
    Reflect.get(value, 'directoryTeamId') ===
      createRegistryPartitionKey(String(Reflect.get(value, 'directoryId'))) &&
    isText(Reflect.get(value, 'issueId')) &&
    isCanonicalUtcTimestamp(Reflect.get(value, 'registeredAt')) &&
    Reflect.get(value, 'sortOrder') === undefined &&
    Reflect.get(value, 'updatedAt') === undefined &&
    Reflect.get(value, 'directoryProjectId') === undefined
}

/**
 * Validates a prefix reservation row.
 *
 * @param value - Raw row.
 * @returns Whether the row is a prefix reservation.
 */
function isWorkItemKeyPrefixRecord(value: unknown): value is WorkItemKeyPrefixRecord {
  if (!hasRegistryBase(value, 'work-item-key-prefix')) return false
  const keyPrefix = value.keyPrefix
  return isText(value.teamId) &&
    typeof keyPrefix === 'string' &&
    parseWorkItemKey(`${keyPrefix}-1`)?.prefix === keyPrefix &&
    value.issueId === `${PREFIX_RECORD_PREFIX}${keyPrefix}`
}

/**
 * Validates a Team counter row.
 *
 * @param value - Raw row.
 * @returns Whether the row is a Team counter.
 */
function isWorkItemKeyCounterRecord(value: unknown): value is WorkItemKeyCounterRecord {
  if (!hasRegistryBase(value, 'work-item-key-counter')) return false
  const keyPrefix = value.keyPrefix
  return isText(value.teamId) &&
    value.issueId === createCounterRecordKey(value.teamId) &&
    typeof keyPrefix === 'string' &&
    parseWorkItemKey(`${keyPrefix}-1`)?.prefix === keyPrefix &&
    typeof value.lastNumber === 'number' &&
    Number.isSafeInteger(value.lastNumber) &&
    value.lastNumber >= 0 &&
    value.lastNumber <= WORK_ITEM_KEY_MAX_NUMBER &&
    (value.lastAllocatedAt === undefined || isCanonicalUtcTimestamp(value.lastAllocatedAt))
}

/**
 * Validates a key reservation row.
 *
 * @param value - Raw row.
 * @returns Whether the row is a key reservation.
 */
function isWorkItemKeyRecord(value: unknown): value is WorkItemKeyRecord {
  if (!hasRegistryBase(value, 'work-item-key')) return false
  return isCanonicalWorkItemKey(value.key) &&
    value.issueId === `${KEY_RECORD_PREFIX}${value.key}` &&
    isText(value.teamId) &&
    isText(value.workItemId)
}

/**
 * Allocates the next key of a Team, reserving the Team's prefix on its first allocation.
 *
 * The number comes from an atomic counter, so concurrent creates never share a key. A create
 * that fails after this call leaves a gap in the sequence instead of reusing the number.
 *
 * @param documentClient - DynamoDB document client.
 * @param tableName - Work Items table name.
 * @param directoryId - Workspace ID.
 * @param teamId - Team that will own the Work Item.
 * @param now - ISO 8601 instant of the create.
 * @returns The newly allocated key.
 * @throws ProjectDataError when the Team has no free prefix or its sequence is exhausted.
 */
export async function allocateWorkItemKey(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  directoryId: string,
  teamId: string,
  now: string,
): Promise<ParsedWorkItemKey> {
  const counterKey = {
    directoryTeamId: createRegistryPartitionKey(directoryId),
    issueId: createCounterRecordKey(teamId),
  }
  for (let attempt = 0; attempt < ALLOCATION_ATTEMPT_LIMIT; attempt += 1) {
    try {
      const response = await documentClient.send(new UpdateCommand({
        TableName: tableName,
        Key: counterKey,
        UpdateExpression: 'SET #lastNumber = #lastNumber + :one, #lastAllocatedAt = :now',
        ConditionExpression: '#entryType = :counter AND #lastNumber < :maxNumber',
        ExpressionAttributeNames: {
          '#entryType': 'entryType',
          '#lastAllocatedAt': 'lastAllocatedAt',
          '#lastNumber': 'lastNumber',
        },
        ExpressionAttributeValues: {
          ':counter': 'work-item-key-counter',
          ':maxNumber': WORK_ITEM_KEY_MAX_NUMBER,
          ':now': now,
          ':one': 1,
        },
        ReturnValues: 'ALL_NEW',
      }))
      const counter = response.Attributes
      if (!isWorkItemKeyCounterRecord(counter) || counter.teamId !== teamId) {
        throw createRegistryInvalidError()
      }
      const key = parseWorkItemKey(`${counter.keyPrefix}-${counter.lastNumber}`)
      if (!key) throw createRegistryInvalidError()
      return key
    } catch (error) {
      if (!isNamedError(error, 'ConditionalCheckFailedException')) throw error
    }
    const existing = await documentClient.send(new GetCommand({
      TableName: tableName,
      Key: counterKey,
      ConsistentRead: true,
    }))
    if (existing.Item !== undefined) {
      if (!isWorkItemKeyCounterRecord(existing.Item)) throw createRegistryInvalidError()
      if (existing.Item.lastNumber >= WORK_ITEM_KEY_MAX_NUMBER) {
        throw new ProjectDataError(
          409,
          'WorkItemKeySequenceExhausted',
          'The Team has used every Work Item key number.',
        )
      }
      continue
    }
    await initializeTeamCounter(documentClient, tableName, directoryId, teamId, now)
  }
  throw new ProjectDataError(
    503,
    'WorkItemKeyAllocationUnavailable',
    'A Work Item key could not be allocated. Retry the request.',
  )
}

/**
 * Reserves the first free prefix for a Team and creates its counter.
 *
 * Returns without writing when another create initialised the counter first.
 *
 * @param documentClient - DynamoDB document client.
 * @param tableName - Work Items table name.
 * @param directoryId - Workspace ID.
 * @param teamId - Team ID.
 * @param now - ISO 8601 instant of the create.
 * @throws ProjectDataError when every prefix candidate belongs to another Team.
 */
async function initializeTeamCounter(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  directoryId: string,
  teamId: string,
  now: string,
): Promise<void> {
  const partitionKey = createRegistryPartitionKey(directoryId)
  for (const keyPrefix of createWorkItemKeyPrefixCandidates(teamId, PREFIX_CANDIDATE_LIMIT)) {
    const prefixRecord: WorkItemKeyPrefixRecord = {
      directoryTeamId: partitionKey,
      issueId: `${PREFIX_RECORD_PREFIX}${keyPrefix}`,
      entryType: 'work-item-key-prefix',
      directoryId,
      keyPrefix,
      teamId,
      registeredAt: now,
    }
    const counterRecord: WorkItemKeyCounterRecord = {
      directoryTeamId: partitionKey,
      issueId: createCounterRecordKey(teamId),
      entryType: 'work-item-key-counter',
      directoryId,
      teamId,
      keyPrefix,
      lastNumber: 0,
      registeredAt: now,
    }
    try {
      await documentClient.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: prefixRecord,
              ConditionExpression: 'attribute_not_exists(issueId)',
            },
          },
          {
            Put: {
              TableName: tableName,
              Item: counterRecord,
              ConditionExpression: 'attribute_not_exists(issueId)',
            },
          },
        ],
      }))
      return
    } catch (error) {
      if (!isNamedError(error, 'TransactionCanceledException')) throw error
      const reasons = readCancellationReasonCodes(error)
      if (reasons[1] === 'ConditionalCheckFailed') return
      // A concurrent first create for the same Team touched these rows; nothing was written, so
      // return and let the caller's bounded loop read the counter again.
      if (reasons.includes('TransactionConflict')) return
      if (reasons[0] !== 'ConditionalCheckFailed') throw error
    }
  }
  throw new ProjectDataError(
    409,
    'WorkItemKeyPrefixUnavailable',
    'No free Work Item key prefix was found for the Team.',
  )
}

/**
 * Creates the transaction item that records which Work Item holds a key.
 *
 * It belongs in the Work Item create transaction, so a key never points at a Work Item that
 * was not created, and it fails if the key was somehow recorded before.
 *
 * @param tableName - Work Items table name.
 * @param directoryId - Workspace ID.
 * @param location - Key, Team, and Work Item ID to record.
 * @param now - ISO 8601 instant of the create.
 * @returns The conditional Put transaction item.
 */
export function createWorkItemKeyReservationPut(
  tableName: string,
  directoryId: string,
  location: WorkItemKeyLocation,
  now: string,
): NonNullable<TransactWriteCommandInput['TransactItems']>[number] {
  const record: WorkItemKeyRecord = {
    directoryTeamId: createRegistryPartitionKey(directoryId),
    issueId: `${KEY_RECORD_PREFIX}${location.key}`,
    entryType: 'work-item-key',
    directoryId,
    key: location.key,
    teamId: location.teamId,
    workItemId: location.workItemId,
    registeredAt: now,
  }
  return {
    Put: {
      TableName: tableName,
      Item: record,
      ConditionExpression: 'attribute_not_exists(issueId)',
    },
  }
}

/**
 * Reads where a key points.
 *
 * @param documentClient - DynamoDB document client.
 * @param tableName - Work Items table name.
 * @param directoryId - Workspace ID.
 * @param key - Canonical uppercase key.
 * @returns The Team and Work Item holding the key, or `undefined` when no Work Item holds it.
 * @throws ProjectDataError when the stored row is malformed.
 */
export async function readWorkItemKeyLocation(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  directoryId: string,
  key: string,
): Promise<WorkItemKeyLocation | undefined> {
  const response = await documentClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      directoryTeamId: createRegistryPartitionKey(directoryId),
      issueId: `${KEY_RECORD_PREFIX}${key}`,
    },
    ConsistentRead: true,
  }))
  if (response.Item === undefined) return undefined
  if (!isWorkItemKeyRecord(response.Item) || response.Item.key !== key) {
    throw createRegistryInvalidError()
  }
  return {
    key: response.Item.key,
    teamId: response.Item.teamId,
    workItemId: response.Item.workItemId,
  }
}

/**
 * Lists every key prefix reserved in a Workspace with the Team that owns it.
 *
 * The caller must filter the Teams it may reveal before returning the prefixes.
 *
 * @param documentClient - DynamoDB document client.
 * @param tableName - Work Items table name.
 * @param directoryId - Workspace ID.
 * @returns Prefix reservations in prefix order.
 * @throws ProjectDataError when a stored prefix row is malformed.
 */
export async function listWorkItemKeyPrefixes(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  directoryId: string,
): Promise<WorkItemKeyPrefixAssignment[]> {
  const assignments: WorkItemKeyPrefixAssignment[] = []
  let exclusiveStartKey: Record<string, unknown> | undefined
  do {
    const response = await documentClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: '#partition = :partition AND begins_with(#sort, :prefix)',
      ExpressionAttributeNames: { '#partition': 'directoryTeamId', '#sort': 'issueId' },
      ExpressionAttributeValues: {
        ':partition': createRegistryPartitionKey(directoryId),
        ':prefix': PREFIX_RECORD_PREFIX,
      },
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    }))
    for (const item of response.Items ?? []) {
      if (!isWorkItemKeyPrefixRecord(item) || item.directoryId !== directoryId) {
        throw createRegistryInvalidError()
      }
      assignments.push({ keyPrefix: item.keyPrefix, teamId: item.teamId })
    }
    exclusiveStartKey = response.LastEvaluatedKey
  } while (exclusiveStartKey)
  return assignments
}

/**
 * Creates the error for a registry row that does not have the expected shape.
 *
 * @returns A 503 project data error.
 */
function createRegistryInvalidError(): ProjectDataError {
  return new ProjectDataError(
    503,
    'InvalidWorkItemKeyRegistry',
    'The Work Item key registry is missing or invalid.',
  )
}

/**
 * Reports whether a value is a non-empty string.
 *
 * @param value - Candidate value.
 * @returns Whether it is a string with at least one character.
 */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * Checks a canonical millisecond-precision UTC ISO timestamp, such as `2026-11-16T00:00:00.000Z`.
 *
 * @param value - Candidate timestamp.
 * @returns True when parsing and canonical serialization are lossless.
 */
function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = new Date(value)
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value
}

/**
 * Reports whether an error is an AWS error with the given name.
 *
 * @param error - Caught error.
 * @param name - AWS error name.
 * @returns Whether the names match.
 */
function isNamedError(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'name') === name
}

/**
 * Reads the per-item cancellation codes of a cancelled transaction.
 *
 * @param error - `TransactionCanceledException`.
 * @returns The code of each transaction item, in order; empty when absent.
 */
function readCancellationReasonCodes(error: unknown): unknown[] {
  if (typeof error !== 'object' || error === null) return []
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return []
  return reasons.map((reason: unknown) =>
    typeof reason === 'object' && reason !== null ? Reflect.get(reason, 'Code') : undefined
  )
}
