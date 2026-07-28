import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb'
import {
  readWorkspaceSearchWriterFenceGuardMaterial,
  type WorkspaceSearchWriterFenceGuardMaterial,
} from './workspace-search-writer-fence'

/** Position reserved for the writer-fence ConditionCheck. */
export const workspaceSearchWriterFenceTransactionGuardIndex = 0

/** Offset applied to every application-owned transaction item index. */
export const workspaceSearchWriterFenceApplicationItemIndexOffset = 1

/** Maximum application-owned items after reserving the guard item. */
export const workspaceSearchWriterFenceMaximumApplicationTransactionItems = 99

/**
 * One native-value transaction item accepted by DynamoDBDocumentClient.
 */
export type WorkspaceSearchWriterFenceDocumentTransactionItem =
  NonNullable<TransactWriteCommandInput['TransactItems']>[number]

/**
 * Prepared transaction with immutable guard metadata.
 */
export type WorkspaceSearchWriterFenceGuardedTransaction = {
  /** Guard-first detached DynamoDBDocumentClient transaction items. */
  readonly transactItems: NonNullable<
    TransactWriteCommandInput['TransactItems']
  >
  /** Stable secret-free fingerprint of the retained guard. */
  readonly materialFingerprint: string
  /** Writer epoch retained by the current invocation. */
  readonly writerEpoch: number
  /** Control revision retained by the current invocation. */
  readonly controlRevision: number
}

/**
 * Stable failure for invalid material or exhausted transaction capacity.
 */
export class WorkspaceSearchWriterFenceTransactionPreparationError
extends Error {
  /** Machine-readable raw-value-free failure code. */
  readonly code = 'INVALID_WORKSPACE_SEARCH_WRITER_FENCE_TRANSACTION'

  /**
   * Creates one transaction-preparation failure.
   */
  constructor() {
    super('INVALID_WORKSPACE_SEARCH_WRITER_FENCE_TRANSACTION')
    this.name = 'WorkspaceSearchWriterFenceTransactionPreparationError'
  }
}

/**
 * Stable terminal failure when the retained open-row condition no longer holds.
 */
export class WorkspaceSearchWriterFenceBlockedError extends Error {
  /** Machine-readable raw-value-free failure code. */
  readonly code = 'WORKSPACE_SEARCH_WRITER_FENCE_BLOCKED'

  /**
   * Creates one blocked-writer failure.
   */
  constructor() {
    super('WORKSPACE_SEARCH_WRITER_FENCE_BLOCKED')
    this.name = 'WorkspaceSearchWriterFenceBlockedError'
  }
}

/**
 * Prepends a native-value open-row check to application transaction items.
 *
 * The canonical guard is expressed with low-level AttributeValue objects.
 * This boundary validates that exact shape and converts the values to strings
 * before DynamoDBDocumentClient marshalling, preventing double-marshalling.
 *
 * @param material - Exact open-row material acquired in this invocation.
 * @param applicationItems - Application-owned transaction items.
 * @returns Detached guard-first transaction and safe metadata.
 */
export function prependWorkspaceSearchWriterFenceGuard(
  material: WorkspaceSearchWriterFenceGuardMaterial,
  applicationItems: readonly WorkspaceSearchWriterFenceDocumentTransactionItem[],
): WorkspaceSearchWriterFenceGuardedTransaction {
  try {
    const strictMaterial = readWorkspaceSearchWriterFenceGuardMaterial(
      material,
    )
    if (
      applicationItems.length >
        workspaceSearchWriterFenceMaximumApplicationTransactionItems ||
      !/^[0-9a-f]{64}$/u.test(strictMaterial.materialFingerprint) ||
      strictMaterial.writerEpoch !== 1 ||
      strictMaterial.controlRevision !== 1
    ) {
      return failTransactionPreparation()
    }
    const conditionCheck = readNativeConditionCheck(strictMaterial)
    const detachedItems = structuredClone(applicationItems)
    const prepared: WorkspaceSearchWriterFenceGuardedTransaction = {
      transactItems: [
        { ConditionCheck: conditionCheck },
        ...detachedItems,
      ],
      materialFingerprint: strictMaterial.materialFingerprint,
      writerEpoch: strictMaterial.writerEpoch,
      controlRevision: strictMaterial.controlRevision,
    }
    freezeWorkspaceSearchWriterFenceTransactionValue(prepared)
    return prepared
  } catch (error: unknown) {
    if (
      error instanceof WorkspaceSearchWriterFenceTransactionPreparationError
    ) {
      throw error
    }
    return failTransactionPreparation()
  }
}

/**
 * Detects a transaction cancellation caused by the reserved guard item.
 *
 * @param error - Unknown DynamoDBDocumentClient failure.
 * @returns Whether cancellation reason zero rejected the writer-fence check.
 */
export function isWorkspaceSearchWriterFenceBlockedTransaction(
  error: unknown,
): boolean {
  if (
    !isRecord(error) ||
    Reflect.get(error, 'name') !== 'TransactionCanceledException'
  ) {
    return false
  }
  const reasons = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return false
  }
  const guardReason = reasons[workspaceSearchWriterFenceTransactionGuardIndex]
  return isRecord(guardReason) &&
    Reflect.get(guardReason, 'Code') === 'ConditionalCheckFailed'
}

/**
 * Converts a reserved guard cancellation into a stable terminal error.
 *
 * Callers must invoke this before idempotency reconciliation, conditional
 * conflict mapping, or retry classification.
 *
 * @param error - Unknown transaction failure.
 */
export function throwIfWorkspaceSearchWriterFenceBlocked(
  error: unknown,
): void {
  if (isWorkspaceSearchWriterFenceBlockedTransaction(error)) {
    throw new WorkspaceSearchWriterFenceBlockedError()
  }
}

/**
 * Native-value condition shape emitted for DynamoDBDocumentClient.
 */
type WorkspaceSearchWriterFenceNativeConditionCheck = NonNullable<
  WorkspaceSearchWriterFenceDocumentTransactionItem['ConditionCheck']
>

/**
 * Reads and converts one exact low-level guard condition.
 *
 * @param material - Candidate canonical guard material.
 * @returns Detached native-value condition check.
 */
function readNativeConditionCheck(
  material: WorkspaceSearchWriterFenceGuardMaterial,
): WorkspaceSearchWriterFenceNativeConditionCheck {
  const conditionCheck = material.conditionCheck.ConditionCheck
  if (
    !conditionCheck ||
    conditionCheck.ConditionExpression !==
      '#canonicalBytes = :canonicalBytes AND #recordDigest = :recordDigest' ||
    conditionCheck.ReturnValuesOnConditionCheckFailure !== 'NONE'
  ) {
    return failTransactionPreparation()
  }
  const names = requireExactRecord(
    conditionCheck.ExpressionAttributeNames,
    ['#canonicalBytes', '#recordDigest'],
  )
  if (
    Reflect.get(names, '#canonicalBytes') !== 'canonicalBytes' ||
    Reflect.get(names, '#recordDigest') !== 'recordDigest'
  ) {
    return failTransactionPreparation()
  }
  const key = requireExactRecord(
    conditionCheck.Key,
    ['migrationId', 'recordKey'],
  )
  const values = requireExactRecord(
    conditionCheck.ExpressionAttributeValues,
    [':canonicalBytes', ':recordDigest'],
  )
  const migrationId = readExactStringAttribute(
    Reflect.get(key, 'migrationId'),
  )
  const recordKey = readExactStringAttribute(
    Reflect.get(key, 'recordKey'),
  )
  const canonicalBytes = readExactStringAttribute(
    Reflect.get(values, ':canonicalBytes'),
  )
  const recordDigest = readExactStringAttribute(
    Reflect.get(values, ':recordDigest'),
  )
  if (
    migrationId !== 'workspace-search-maintenance' ||
    !recordKey.startsWith('application-writer-fence/v1/') ||
    canonicalBytes.length === 0 ||
    !/^[0-9a-f]{64}$/u.test(recordDigest)
  ) {
    return failTransactionPreparation()
  }
  if (
    typeof conditionCheck.TableName !== 'string' ||
    conditionCheck.TableName.trim().length === 0
  ) {
    return failTransactionPreparation()
  }
  return {
    TableName: conditionCheck.TableName,
    Key: { migrationId, recordKey },
    ConditionExpression: conditionCheck.ConditionExpression,
    ExpressionAttributeNames: {
      '#canonicalBytes': 'canonicalBytes',
      '#recordDigest': 'recordDigest',
    },
    ExpressionAttributeValues: {
      ':canonicalBytes': canonicalBytes,
      ':recordDigest': recordDigest,
    },
    ReturnValuesOnConditionCheckFailure: 'NONE',
  }
}

/**
 * Reads one record with an exact enumerable key set.
 *
 * @param value - Candidate record.
 * @param expectedKeys - Complete expected keys.
 * @returns Exact candidate record.
 */
function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    return failTransactionPreparation()
  }
  const actualKeys = Object.keys(value).sort()
  const sortedExpectedKeys = [...expectedKeys].sort()
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    return failTransactionPreparation()
  }
  return value
}

/**
 * Reads one exact DynamoDB string AttributeValue.
 *
 * @param value - Candidate low-level AttributeValue.
 * @returns Non-empty string payload.
 */
function readExactStringAttribute(value: unknown): string {
  const record = requireExactRecord(value, ['S'])
  const stringValue = Reflect.get(record, 'S')
  if (typeof stringValue !== 'string' || stringValue.length === 0) {
    return failTransactionPreparation()
  }
  return stringValue
}

/**
 * Determines whether one value is a non-array object record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is a record.
 */
function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Recursively freezes one detached prepared transaction.
 *
 * @param value - Prepared transaction value.
 */
function freezeWorkspaceSearchWriterFenceTransactionValue(
  value: unknown,
): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }
  if (!Array.isArray(value)) {
    let prototype: unknown
    try {
      prototype = Object.getPrototypeOf(value)
    } catch {
      return failTransactionPreparation()
    }
    if (prototype !== Object.prototype && prototype !== null) {
      return
    }
  }
  for (const nested of Object.values(value)) {
    freezeWorkspaceSearchWriterFenceTransactionValue(nested)
  }
  Object.freeze(value)
}

/**
 * Throws the stable transaction-preparation failure.
 *
 * @returns Never returns.
 */
function failTransactionPreparation(): never {
  throw new WorkspaceSearchWriterFenceTransactionPreparationError()
}
