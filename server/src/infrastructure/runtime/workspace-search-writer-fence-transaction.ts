import { Buffer } from 'node:buffer'
import {
  NumberValue,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb'
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
 * Exact ArrayBuffer view prototypes accepted by DynamoDBDocumentClient.
 */
const workspaceSearchWriterFenceDocumentBinaryViewPrototypes:
  ReadonlySet<object> = new Set([
    Buffer.prototype,
    BigInt64Array.prototype,
    BigUint64Array.prototype,
    DataView.prototype,
    Float32Array.prototype,
    Float64Array.prototype,
    Int8Array.prototype,
    Int16Array.prototype,
    Int32Array.prototype,
    Uint8Array.prototype,
    Uint8ClampedArray.prototype,
    Uint16Array.prototype,
    Uint32Array.prototype,
  ])

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
      !/^[0-9a-f]{64}$/u.test(strictMaterial.materialFingerprint)
    ) {
      return failTransactionPreparation()
    }
    const conditionCheck = readNativeConditionCheck(strictMaterial)
    const detachedItems =
      detachWorkspaceSearchWriterFenceDocumentTransactionItems(
        applicationItems,
      )
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
 * Detaches application items without changing DynamoDB marshalling semantics.
 *
 * @param items - Application-owned transaction items.
 * @returns Independently mutable transaction items with preserved semantics.
 */
function detachWorkspaceSearchWriterFenceDocumentTransactionItems(
  items: readonly WorkspaceSearchWriterFenceDocumentTransactionItem[],
): WorkspaceSearchWriterFenceDocumentTransactionItem[] {
  const detachedItems: WorkspaceSearchWriterFenceDocumentTransactionItem[] = []
  for (const item of items) {
    const detached = detachWorkspaceSearchWriterFenceDocumentValue(item)
    if (!isWorkspaceSearchWriterFenceDocumentTransactionItem(detached)) {
      return failTransactionPreparation()
    }
    detachedItems.push(detached)
  }
  return detachedItems
}

/**
 * Recursively detaches one DynamoDBDocumentClient value.
 *
 * Unknown class instances are rejected because their prototype and private
 * state cannot be reproduced without changing document-marshalling behavior.
 *
 * @param value - Candidate transaction structure or native attribute value.
 * @returns A detached value with supported native marshalling semantics.
 */
function detachWorkspaceSearchWriterFenceDocumentValue(
  value: unknown,
): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value
  }
  if (typeof value !== 'object') {
    return failTransactionPreparation()
  }
  if (value instanceof NumberValue) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      NumberValue.prototype,
    )
    return NumberValue.from(value.value)
  }
  if (value instanceof Boolean) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      Boolean.prototype,
    )
    return structuredClone(value)
  }
  if (value instanceof Number) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      Number.prototype,
    )
    return structuredClone(value)
  }
  if (value instanceof String) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      String.prototype,
    )
    return structuredClone(value)
  }
  if (Array.isArray(value)) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      Array.prototype,
    )
    return value.map((nested) =>
      detachWorkspaceSearchWriterFenceDocumentValue(nested)
    )
  }
  if (value instanceof Set) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      Set.prototype,
    )
    const source: Set<unknown> = value
    const detached = new Set<unknown>()
    for (const nested of source) {
      detached.add(
        detachWorkspaceSearchWriterFenceDocumentValue(nested),
      )
    }
    return detached
  }
  if (value instanceof Map) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      Map.prototype,
    )
    const source: Map<unknown, unknown> = value
    const detached = new Map<unknown, unknown>()
    for (const [key, nested] of source) {
      detached.set(
        detachWorkspaceSearchWriterFenceDocumentValue(key),
        detachWorkspaceSearchWriterFenceDocumentValue(nested),
      )
    }
    return detached
  }
  const detachedBinary =
    detachWorkspaceSearchWriterFenceDocumentBinary(value)
  if (detachedBinary !== undefined) {
    return detachedBinary
  }
  if (!isRecord(value)) {
    return failTransactionPreparation()
  }
  const prototype = readWorkspaceSearchWriterFenceDocumentPrototype(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return failTransactionPreparation()
  }
  const detached: Record<string, unknown> = {}
  if (prototype === null) {
    Object.setPrototypeOf(detached, null)
  }
  for (const [key, nested] of Object.entries(value)) {
    detached[key] =
      detachWorkspaceSearchWriterFenceDocumentValue(nested)
  }
  return detached
}

/**
 * Detaches one exact binary value supported by DynamoDBDocumentClient.
 *
 * @param value - Candidate object value.
 * @returns Independent binary bytes, or undefined for a non-binary value.
 */
function detachWorkspaceSearchWriterFenceDocumentBinary(
  value: object,
): object | undefined {
  if (value instanceof ArrayBuffer) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      ArrayBuffer.prototype,
    )
    return value.slice(0)
  }
  if (ArrayBuffer.isView(value)) {
    requireWorkspaceSearchWriterFenceDocumentPrototypeIn(
      value,
      workspaceSearchWriterFenceDocumentBinaryViewPrototypes,
    )
    const sourceBytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    )
    return Uint8Array.from(sourceBytes)
  }
  if (typeof File !== 'undefined' && value instanceof File) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      File.prototype,
    )
    return structuredClone(value)
  }
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    requireWorkspaceSearchWriterFenceDocumentPrototype(
      value,
      Blob.prototype,
    )
    return structuredClone(value)
  }
  return undefined
}

/**
 * Reads one runtime prototype at the fail-closed transaction boundary.
 *
 * @param value - Candidate object value.
 * @returns Exact runtime prototype, including a null prototype.
 */
function readWorkspaceSearchWriterFenceDocumentPrototype(
  value: object,
): object | null {
  let prototype: unknown
  try {
    prototype = Object.getPrototypeOf(value)
  } catch {
    return failTransactionPreparation()
  }
  if (
    prototype !== null &&
    typeof prototype !== 'object'
  ) {
    return failTransactionPreparation()
  }
  return prototype
}

/**
 * Requires one exact supported runtime prototype.
 *
 * @param value - Candidate object value.
 * @param expectedPrototype - Sole accepted prototype.
 */
function requireWorkspaceSearchWriterFenceDocumentPrototype(
  value: object,
  expectedPrototype: object,
): void {
  if (
    readWorkspaceSearchWriterFenceDocumentPrototype(value) !==
      expectedPrototype
  ) {
    return failTransactionPreparation()
  }
}

/**
 * Requires one runtime prototype from an exact supported allowlist.
 *
 * @param value - Candidate object value.
 * @param expectedPrototypes - Complete accepted prototype allowlist.
 */
function requireWorkspaceSearchWriterFenceDocumentPrototypeIn(
  value: object,
  expectedPrototypes: ReadonlySet<object>,
): void {
  const prototype =
    readWorkspaceSearchWriterFenceDocumentPrototype(value)
  if (prototype === null || !expectedPrototypes.has(prototype)) {
    return failTransactionPreparation()
  }
}

/**
 * Validates the detached top-level transaction item shape.
 *
 * @param value - Candidate detached value.
 * @returns Whether exactly one DynamoDB transaction action is present.
 */
function isWorkspaceSearchWriterFenceDocumentTransactionItem(
  value: unknown,
): value is WorkspaceSearchWriterFenceDocumentTransactionItem {
  if (!isRecord(value)) {
    return false
  }
  const actionNames = ['ConditionCheck', 'Delete', 'Put', 'Update']
  let actionCount = 0
  for (const actionName of actionNames) {
    const action = Reflect.get(value, actionName)
    if (action === undefined) {
      continue
    }
    if (!isRecord(action)) {
      return false
    }
    actionCount += 1
  }
  return actionCount === 1 &&
    Object.keys(value).every((key) => actionNames.includes(key))
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
    const prototype =
      readWorkspaceSearchWriterFenceDocumentPrototype(value)
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
