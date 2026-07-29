import { types as nodeUtilTypes } from 'node:util'
import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  serializeCanonicalAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  type MigrationItemSnapshot,
  type MigrationKeyAttribute,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import { createAbsentMigrationItemDigest } from './migration-journal'
import { hasOnlyPairedSurrogates } from './migration-value-guards'

const maximumConditionExpressionBytes = 4 * 1024
const maximumExpressionSubstitutionBytes = 2 * 1024 * 1024
const maximumDynamoDbAttributeNameBytes = 65_535
const maximumDynamoDbDocumentDepth = 32

/**
 * Drift failure selected by an apply or rollback strong-read caller.
 */
export type WorkspaceSearchMigrationItemDriftCode =
  | 'ROLLBACK_TARGET_DRIFT'
  | 'SOURCE_DRIFT'
  | 'TARGET_DRIFT'

/**
 * Exact low-level DynamoDB CAS material for one migration item.
 *
 * For a present item, every observed top-level attribute is compared and every
 * schema-known attribute that was absent is guarded with
 * `attribute_not_exists`. For an absent item, every physical key attribute is
 * guarded with `attribute_not_exists`.
 *
 * DynamoDB condition expressions cannot quantify over unknown attribute names.
 * Consequently, a transaction-time addition of a top-level attribute that is
 * neither in the planned item nor in `schemaKnownAttributeNames` cannot be
 * detected by this material. Callers must pair it with the exported strong-read
 * verifier immediately before the transaction and keep the schema-known list
 * complete.
 */
export type WorkspaceSearchMigrationItemConditionMaterial = {
  /** Detached exact physical DynamoDB item key. */
  readonly Key: Readonly<Record<string, AttributeValue>>
  /** Bounded exact condition expression. */
  readonly ConditionExpression: string
  /** Attribute-name substitutions used by the condition. */
  readonly ExpressionAttributeNames: Readonly<Record<string, string>>
  /** Attribute-value substitutions, omitted for an absent-item condition. */
  readonly ExpressionAttributeValues?: Readonly<Record<string, AttributeValue>>
}

/**
 * Builds exact-observed CAS material for one source or target migration item.
 *
 * Present snapshots bind every top-level AttributeValue and known-but-absent
 * attribute. Absent snapshots bind every physical key attribute. The returned
 * key and values are detached from caller-owned state.
 *
 * DynamoDB has no condition-expression primitive for rejecting every possible
 * unknown top-level attribute. A concurrent addition whose name is absent from
 * both the planned item and `schemaKnownAttributeNames` therefore remains
 * outside the transaction-time condition and must be mitigated by the paired
 * strong read and a complete schema-known list.
 *
 * @param table - Measured table identity whose exact base-table key is binding.
 * @param key - Exact physical item key.
 * @param snapshot - Planned exact present or absent item state.
 * @param schemaKnownAttributeNames - Complete known top-level schema names.
 * @returns Bounded adapter-owned DynamoDB condition material.
 */
export function createWorkspaceSearchMigrationItemConditionMaterial(
  table: MigrationTableIdentity,
  key: Readonly<Record<string, AttributeValue>>,
  snapshot: MigrationItemSnapshot,
  schemaKnownAttributeNames: readonly string[],
): WorkspaceSearchMigrationItemConditionMaterial {
  try {
    const descriptor = readMigrationTableKeyDescriptor(table)
    const detachedKey = readExactMigrationItemKey(
      key,
      descriptor,
      'INVALID_ARGUMENT',
    )
    const detachedSnapshot = readMigrationItemSnapshot(
      snapshot,
      descriptor,
      detachedKey,
      'INVALID_ARGUMENT',
    )
    const knownNames = readSchemaKnownAttributeNames(
      schemaKnownAttributeNames,
    )
    return createConditionMaterial(
      detachedKey,
      descriptor,
      detachedSnapshot,
      knownNames,
    )
  } catch (error: unknown) {
    return mapConstructionFailure(error)
  }
}

/**
 * Verifies a strongly consistent GetItem response against one planned snapshot.
 *
 * The response must expose `Item`, when present, as an own enumerable data
 * property. The item is descriptor-checked, losslessly detached, size-checked,
 * correlated to the exact measured key, and compared by both canonical bytes
 * and canonical digest. Proxies, accessors, symbols, arrays, malformed
 * AttributeValues, and oversized items fail closed without including raw data
 * in the public error.
 *
 * @param table - Measured table identity whose exact base-table key is binding.
 * @param key - Exact requested physical item key.
 * @param plannedSnapshot - Planned exact present or absent state.
 * @param output - Untrusted low-level GetItem output.
 * @param driftCode - Stable apply or rollback drift classification.
 * @returns Detached exact observed snapshot when it matches the plan.
 */
export function verifyWorkspaceSearchMigrationItemStrongRead(
  table: MigrationTableIdentity,
  key: Readonly<Record<string, AttributeValue>>,
  plannedSnapshot: MigrationItemSnapshot,
  output: unknown,
  driftCode: WorkspaceSearchMigrationItemDriftCode,
): MigrationItemSnapshot {
  try {
    const validatedDriftCode = readMigrationItemDriftCode(driftCode)
    const descriptor = readMigrationTableKeyDescriptor(table)
    const detachedKey = readExactMigrationItemKey(
      key,
      descriptor,
      'INVALID_ARGUMENT',
    )
    const planned = readMigrationItemSnapshot(
      plannedSnapshot,
      descriptor,
      detachedKey,
      'INVALID_ARGUMENT',
    )
    const rawItem = readStrongReadOutputItem(output)
    const observed = rawItem === undefined
      ? createAbsentSnapshot()
      : readObservedMigrationItemSnapshot(
          rawItem,
          descriptor,
          detachedKey,
        )
    if (!migrationItemSnapshotsEqual(planned, observed)) {
      return failItemCondition(validatedDriftCode)
    }
    return observed
  } catch (error: unknown) {
    return mapVerifierFailure(error)
  }
}

/**
 * Internal stable failure that cannot be supplied through a public input.
 */
class MigrationItemConditionBoundaryFailure extends Error {
  /** Stable migration failure classification. */
  readonly code: WorkspaceSearchMigrationFailureCode

  /**
   * Creates one raw-value-free internal failure.
   *
   * @param code - Stable migration failure classification.
   */
  constructor(code: WorkspaceSearchMigrationFailureCode) {
    super('MIGRATION_ITEM_CONDITION_BOUNDARY_FAILURE')
    this.name = 'MigrationItemConditionBoundaryFailure'
    this.code = code
  }
}

/**
 * Reads the measured table's strict base-key descriptor.
 *
 * @param table - Candidate measured table identity.
 * @returns Detached ordered hash and optional range descriptors.
 */
function readMigrationTableKeyDescriptor(
  table: MigrationTableIdentity,
): readonly MigrationKeyAttribute[] {
  const record = requirePlainRecord(table, 'INVALID_ARGUMENT')
  const rawKey = readOwnEnumerableDataValue(
    record,
    'key',
    'INVALID_ARGUMENT',
  )
  const entries = readDenseArray(rawKey, 'INVALID_ARGUMENT')
  if (entries.length !== 1 && entries.length !== 2) {
    return failItemCondition('INVALID_ARGUMENT')
  }
  const descriptors: MigrationKeyAttribute[] = []
  entries.forEach((entry, index) => {
    const candidate = requireExactPlainRecord(
      entry,
      ['name', 'role', 'type'],
      'INVALID_ARGUMENT',
    )
    const name = readAttributeName(
      readOwnEnumerableDataValue(
        candidate,
        'name',
        'INVALID_ARGUMENT',
      ),
      'INVALID_ARGUMENT',
    )
    const role = readOwnEnumerableDataValue(
      candidate,
      'role',
      'INVALID_ARGUMENT',
    )
    const type = readOwnEnumerableDataValue(
      candidate,
      'type',
      'INVALID_ARGUMENT',
    )
    if (type !== 'B' && type !== 'N' && type !== 'S') {
      return failItemCondition('INVALID_ARGUMENT')
    }
    if (index === 0 && role === 'HASH') {
      descriptors.push({ name, role: 'HASH', type })
      return
    }
    if (index === 1 && role === 'RANGE') {
      descriptors.push({ name, role: 'RANGE', type })
      return
    }
    return failItemCondition('INVALID_ARGUMENT')
  })
  if (
    descriptors.length === 2 &&
    descriptors[0]?.name === descriptors[1]?.name
  ) {
    return failItemCondition('INVALID_ARGUMENT')
  }
  return descriptors
}

/**
 * Reads and detaches one exact key matching the measured descriptor.
 *
 * @param key - Candidate physical key.
 * @param descriptor - Exact measured key descriptor.
 * @param failureCode - Failure classification for this boundary.
 * @returns Detached exact key.
 */
function readExactMigrationItemKey(
  key: unknown,
  descriptor: readonly MigrationKeyAttribute[],
  failureCode: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, AttributeValue>> {
  const detached = cloneAttributeMap(key, failureCode)
  const expectedNames = descriptor.map((attribute) => attribute.name).sort()
  const actualNames = Object.keys(detached).sort()
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    return failItemCondition(failureCode)
  }
  for (const attribute of descriptor) {
    const value = detached[attribute.name]
    if (
      value === undefined ||
      !keyAttributeMatchesDescriptor(
        value,
        attribute,
        failureCode,
      )
    ) {
      return failItemCondition(failureCode)
    }
  }
  return detached
}

/**
 * Checks one scalar key AttributeValue against its measured descriptor.
 *
 * @param value - Validated detached AttributeValue.
 * @param descriptor - Exact key attribute descriptor.
 * @param failureCode - Failure classification for malformed state.
 * @returns Whether the value is the required non-empty scalar variant.
 */
function keyAttributeMatchesDescriptor(
  value: AttributeValue,
  descriptor: MigrationKeyAttribute,
  failureCode: WorkspaceSearchMigrationFailureCode,
): boolean {
  const record = requirePlainRecord(value, failureCode)
  const keys = Reflect.ownKeys(record)
  if (keys.length !== 1 || keys[0] !== descriptor.type) return false
  const scalar = readOwnEnumerableDataValue(
    record,
    descriptor.type,
    failureCode,
  )
  if (descriptor.type === 'S') {
    return typeof scalar === 'string' && scalar.length > 0
  }
  if (descriptor.type === 'N') {
    return typeof scalar === 'string' && scalar.length > 0
  }
  return (
    nodeUtilTypes.isUint8Array(scalar) &&
    readIntrinsicUint8ArrayByteLength(
      scalar,
      failureCode,
    ) > 0
  )
}

/**
 * Reads, validates, and detaches one planned snapshot.
 *
 * @param snapshot - Candidate planned snapshot.
 * @param descriptor - Exact measured key descriptor.
 * @param key - Detached exact requested key.
 * @param failureCode - Failure classification for this boundary.
 * @returns Canonical detached snapshot.
 */
function readMigrationItemSnapshot(
  snapshot: unknown,
  descriptor: readonly MigrationKeyAttribute[],
  key: Readonly<Record<string, AttributeValue>>,
  failureCode: WorkspaceSearchMigrationFailureCode,
): MigrationItemSnapshot {
  const record = requirePlainRecord(snapshot, failureCode)
  const exists = readOwnEnumerableDataValue(
    record,
    'exists',
    failureCode,
  )
  if (exists === false) {
    requireExactPlainRecord(
      record,
      ['digest', 'exists'],
      failureCode,
    )
    const digest = readOwnEnumerableDataValue(
      record,
      'digest',
      failureCode,
    )
    if (
      typeof digest !== 'string' ||
      digest !== createAbsentMigrationItemDigest()
    ) {
      return failItemCondition(failureCode)
    }
    return createAbsentSnapshot()
  }
  if (exists !== true) return failItemCondition(failureCode)
  requireExactPlainRecord(
    record,
    ['digest', 'exists', 'item'],
    failureCode,
  )
  const item = cloneAttributeMap(
    readOwnEnumerableDataValue(record, 'item', failureCode),
    failureCode,
  )
  validateItemSize(item, failureCode)
  requireItemKey(item, descriptor, key, failureCode)
  const digest = readOwnEnumerableDataValue(
    record,
    'digest',
    failureCode,
  )
  const actualDigest = createCanonicalItemDigest(item, failureCode)
  if (typeof digest !== 'string' || digest !== actualDigest) {
    return failItemCondition(failureCode)
  }
  return {
    exists: true,
    item,
    digest: actualDigest,
  }
}

/**
 * Reads schema-known attribute names as a detached sorted set.
 *
 * @param value - Candidate name list.
 * @returns Sorted unique exact attribute names.
 */
function readSchemaKnownAttributeNames(
  value: unknown,
): readonly string[] {
  const entries = readDenseArray(value, 'INVALID_ARGUMENT')
  const names = entries
    .map((entry) => readAttributeName(entry, 'INVALID_ARGUMENT'))
    .sort(compareUtf8Ordinal)
  if (new Set(names).size !== names.length) {
    return failItemCondition('INVALID_ARGUMENT')
  }
  return names
}

/**
 * Builds deterministic bounded expression material.
 *
 * @param key - Detached exact item key.
 * @param descriptor - Exact measured key descriptor.
 * @param snapshot - Detached canonical snapshot.
 * @param knownNames - Sorted unique schema-known attribute names.
 * @returns Adapter-owned expression material.
 */
function createConditionMaterial(
  key: Readonly<Record<string, AttributeValue>>,
  descriptor: readonly MigrationKeyAttribute[],
  snapshot: MigrationItemSnapshot,
  knownNames: readonly string[],
): WorkspaceSearchMigrationItemConditionMaterial {
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  const clauses: string[] = []
  if (!snapshot.exists) {
    descriptor.forEach((attribute, index) => {
      const nameToken = `#a${index}`
      defineOwnDataProperty(names, nameToken, attribute.name)
      clauses.push(`attribute_not_exists(${nameToken})`)
    })
  } else {
    const presentNames = Object.keys(snapshot.item).sort(compareUtf8Ordinal)
    const presentSet = new Set(presentNames)
    const guardedNames = [
      ...presentNames,
      ...knownNames.filter((name) => !presentSet.has(name)),
    ]
    guardedNames.forEach((attributeName, index) => {
      const nameToken = `#a${index}`
      defineOwnDataProperty(names, nameToken, attributeName)
      if (presentSet.has(attributeName)) {
        const value = snapshot.item[attributeName]
        if (value === undefined) {
          return failItemCondition('INVALID_ARGUMENT')
        }
        const valueToken = `:v${index}`
        defineOwnDataProperty(values, valueToken, value)
        clauses.push(`${nameToken} = ${valueToken}`)
      } else {
        clauses.push(`attribute_not_exists(${nameToken})`)
      }
    })
  }
  const expression = clauses.join(' AND ')
  validateExpressionBounds(expression, names, values)
  if (snapshot.exists) {
    return {
      Key: key,
      ConditionExpression: expression,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }
  }
  return {
    Key: key,
    ConditionExpression: expression,
    ExpressionAttributeNames: names,
  }
}

/**
 * Reads an optional own-data Item from an untrusted GetItem output.
 *
 * @param output - Candidate low-level GetItem output.
 * @returns Raw Item value or undefined for an absent response.
 */
function readStrongReadOutputItem(output: unknown): unknown {
  const record = requirePlainRecord(output, 'INVALID_STATE')
  if (Reflect.ownKeys(record).some((key) => typeof key === 'symbol')) {
    return failItemCondition('INVALID_STATE')
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, 'Item')
  if (descriptor === undefined) return undefined
  if (
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === undefined
  ) {
    return failItemCondition('INVALID_STATE')
  }
  return descriptor.value
}

/**
 * Creates one detached observed present snapshot.
 *
 * @param rawItem - Untrusted own-data Item.
 * @param descriptor - Exact measured key descriptor.
 * @param key - Detached exact requested key.
 * @returns Canonical detached present snapshot.
 */
function readObservedMigrationItemSnapshot(
  rawItem: unknown,
  descriptor: readonly MigrationKeyAttribute[],
  key: Readonly<Record<string, AttributeValue>>,
): MigrationItemSnapshot {
  const item = cloneAttributeMap(rawItem, 'INVALID_STATE')
  validateItemSize(item, 'INVALID_STATE')
  requireItemKey(item, descriptor, key, 'INVALID_STATE')
  return {
    exists: true,
    item,
    digest: createCanonicalItemDigest(item, 'INVALID_STATE'),
  }
}

/**
 * Compares two canonical snapshots by existence, digest, and full bytes.
 *
 * @param planned - Canonical planned snapshot.
 * @param observed - Canonical observed snapshot.
 * @returns Whether both snapshots represent the exact same state.
 */
function migrationItemSnapshotsEqual(
  planned: MigrationItemSnapshot,
  observed: MigrationItemSnapshot,
): boolean {
  if (planned.exists !== observed.exists) return false
  if (!planned.exists || !observed.exists) {
    return planned.digest === observed.digest
  }
  return planned.digest === observed.digest &&
    serializeCanonicalAttributeMap(planned.item) ===
      serializeCanonicalAttributeMap(observed.item)
}

/**
 * Requires an item's exact key to match the requested physical key.
 *
 * @param item - Detached canonical item.
 * @param descriptor - Exact measured key descriptor.
 * @param expectedKey - Detached requested key.
 * @param failureCode - Failure classification for this boundary.
 */
function requireItemKey(
  item: Readonly<Record<string, AttributeValue>>,
  descriptor: readonly MigrationKeyAttribute[],
  expectedKey: Readonly<Record<string, AttributeValue>>,
  failureCode: WorkspaceSearchMigrationFailureCode,
): void {
  const itemKey: Record<string, AttributeValue> = {}
  for (const attribute of descriptor) {
    const value = item[attribute.name]
    if (
      value === undefined ||
      !keyAttributeMatchesDescriptor(
        value,
        attribute,
        failureCode,
      )
    ) {
      return failItemCondition(failureCode)
    }
    defineOwnDataProperty(itemKey, attribute.name, value)
  }
  if (
    serializeCanonicalAttributeMap(itemKey) !==
      serializeCanonicalAttributeMap(expectedKey)
  ) {
    return failItemCondition(failureCode)
  }
}

/**
 * Creates the canonical absent snapshot.
 *
 * @returns Detached canonical absent snapshot.
 */
function createAbsentSnapshot(): MigrationItemSnapshot {
  return {
    exists: false,
    digest: createAbsentMigrationItemDigest(),
  }
}

/**
 * Clones one descriptor-safe low-level AttributeValue map.
 *
 * @param value - Candidate item or key map.
 * @param failureCode - Failure classification for malformed input.
 * @returns Detached validated attribute map.
 */
function cloneAttributeMap(
  value: unknown,
  failureCode: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<string, AttributeValue>> {
  requireDescriptorSafeGraph(
    value,
    new WeakSet<object>(),
    0,
    failureCode,
  )
  try {
    return decodeAttributeMap(encodeUnknownAttributeMap(value))
  } catch {
    return failItemCondition(failureCode)
  }
}

/**
 * Rejects hostile object graphs before the codec can read their values.
 *
 * @param value - Candidate graph node.
 * @param ancestors - Active ancestor set used to reject cycles.
 * @param depth - Current document depth.
 * @param failureCode - Failure classification for malformed state.
 */
function requireDescriptorSafeGraph(
  value: unknown,
  ancestors: WeakSet<object>,
  depth: number,
  failureCode: WorkspaceSearchMigrationFailureCode,
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === undefined
  ) {
    return
  }
  if (typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    return failItemCondition(failureCode)
  }
  if (depth > maximumDynamoDbDocumentDepth || ancestors.has(value)) {
    return failItemCondition(failureCode)
  }
  if (nodeUtilTypes.isUint8Array(value)) {
    requireSafeUint8Array(value, failureCode)
    return
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      const entries = readDenseArray(value, failureCode)
      for (const entry of entries) {
        requireDescriptorSafeGraph(
          entry,
          ancestors,
          depth + 1,
          failureCode,
        )
      }
      return
    }
    const record = requirePlainRecord(value, failureCode)
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== 'string') {
        return failItemCondition(failureCode)
      }
      requireDescriptorSafeGraph(
        readOwnEnumerableDataValue(record, key, failureCode),
        ancestors,
        depth + 1,
        failureCode,
      )
    }
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Requires one non-shared intrinsic Uint8Array without side properties.
 *
 * @param value - Candidate binary AttributeValue payload.
 * @param failureCode - Failure classification for malformed bytes.
 */
function requireSafeUint8Array(
  value: Uint8Array,
  failureCode: WorkspaceSearchMigrationFailureCode,
): void {
  const prototype = Object.getPrototypeOf(value)
  if (
    prototype !== Uint8Array.prototype &&
    prototype !== Buffer.prototype
  ) {
    return failItemCondition(failureCode)
  }
  const byteLength = readIntrinsicUint8ArrayByteLength(
    value,
    failureCode,
  )
  const buffer = readIntrinsicUint8ArrayBuffer(value, failureCode)
  if (nodeUtilTypes.isSharedArrayBuffer(buffer)) {
    return failItemCondition(failureCode)
  }
  const keys = Reflect.ownKeys(value)
  if (
    keys.length !== byteLength ||
    keys.some((key, index) => key !== String(index))
  ) {
    return failItemCondition(failureCode)
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failItemCondition(failureCode)
    }
  }
}

/**
 * Reads an intrinsic Uint8Array byte length without consulting its prototype.
 *
 * @param value - Validated non-Proxy Uint8Array.
 * @param failureCode - Failure classification for invalid intrinsic state.
 * @returns Exact intrinsic view length.
 */
function readIntrinsicUint8ArrayByteLength(
  value: Uint8Array,
  failureCode: WorkspaceSearchMigrationFailureCode,
): number {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) {
    return failItemCondition(failureCode)
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'byteLength',
  )
  if (descriptor?.get === undefined) {
    return failItemCondition(failureCode)
  }
  const byteLength: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    typeof byteLength !== 'number' ||
    !Number.isSafeInteger(byteLength) ||
    byteLength < 0
  ) {
    return failItemCondition(failureCode)
  }
  return byteLength
}

/**
 * Reads an intrinsic Uint8Array backing buffer.
 *
 * @param value - Validated non-Proxy Uint8Array.
 * @param failureCode - Failure classification for invalid intrinsic state.
 * @returns Exact intrinsic backing buffer.
 */
function readIntrinsicUint8ArrayBuffer(
  value: Uint8Array,
  failureCode: WorkspaceSearchMigrationFailureCode,
): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
  if (typedArrayPrototype === null) {
    return failItemCondition(failureCode)
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    typedArrayPrototype,
    'buffer',
  )
  if (descriptor?.get === undefined) {
    return failItemCondition(failureCode)
  }
  const buffer: unknown = Reflect.apply(descriptor.get, value, [])
  if (
    !nodeUtilTypes.isArrayBuffer(buffer) &&
    !nodeUtilTypes.isSharedArrayBuffer(buffer)
  ) {
    return failItemCondition(failureCode)
  }
  return buffer
}

/**
 * Reads one strict dense non-Proxy array without invoking accessors.
 *
 * @param value - Candidate array.
 * @param failureCode - Failure classification for malformed state.
 * @returns Detached element list.
 */
function readDenseArray(
  value: unknown,
  failureCode: WorkspaceSearchMigrationFailureCode,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return failItemCondition(failureCode)
  }
  const length = value.length
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== length + 1 ||
    ownKeys[length] !== 'length'
  ) {
    return failItemCondition(failureCode)
  }
  const entries: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    if (ownKeys[index] !== key) {
      return failItemCondition(failureCode)
    }
    entries.push(
      readOwnEnumerableDataValue(value, key, failureCode),
    )
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(
    value,
    'length',
  )
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable !== false ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    lengthDescriptor.value !== length
  ) {
    return failItemCondition(failureCode)
  }
  return entries
}

/**
 * Requires one plain non-Proxy record.
 *
 * @param value - Candidate record.
 * @param failureCode - Failure classification for malformed state.
 * @returns Narrowed safe record.
 */
function requirePlainRecord(
  value: unknown,
  failureCode: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<PropertyKey, unknown>> {
  if (!isPlainRecord(value)) {
    return failItemCondition(failureCode)
  }
  return value
}

/**
 * Checks for a plain non-array, non-Proxy record.
 *
 * @param value - Candidate runtime value.
 * @returns Whether the value is safe for descriptor-only property reads.
 */
function isPlainRecord(
  value: unknown,
): value is Readonly<Record<PropertyKey, unknown>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires exactly the requested own enumerable data properties.
 *
 * @param value - Candidate record.
 * @param expectedKeys - Exact sorted-independent key set.
 * @param failureCode - Failure classification for malformed state.
 * @returns Narrowed safe record.
 */
function requireExactPlainRecord(
  value: unknown,
  expectedKeys: readonly string[],
  failureCode: WorkspaceSearchMigrationFailureCode,
): Readonly<Record<PropertyKey, unknown>> {
  const record = requirePlainRecord(value, failureCode)
  const ownKeys = Reflect.ownKeys(record)
  if (ownKeys.some((key) => typeof key !== 'string')) {
    return failItemCondition(failureCode)
  }
  const actualKeys = Object.keys(record).sort()
  const expected = [...expectedKeys].sort()
  if (
    ownKeys.length !== actualKeys.length ||
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    return failItemCondition(failureCode)
  }
  for (const key of actualKeys) {
    readOwnEnumerableDataValue(record, key, failureCode)
  }
  return record
}

/**
 * Reads one own enumerable data property without invoking accessors.
 *
 * @param value - Descriptor-safe containing object.
 * @param key - Exact property key.
 * @param failureCode - Failure classification for malformed state.
 * @returns Untrusted descriptor value.
 */
function readOwnEnumerableDataValue(
  value: object,
  key: PropertyKey,
  failureCode: WorkspaceSearchMigrationFailureCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    descriptor.enumerable !== true ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failItemCondition(failureCode)
  }
  return descriptor.value
}

/**
 * Reads one bounded well-formed DynamoDB attribute name.
 *
 * @param value - Candidate attribute name.
 * @param failureCode - Failure classification for malformed state.
 * @returns Exact validated name.
 */
function readAttributeName(
  value: unknown,
  failureCode: WorkspaceSearchMigrationFailureCode,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !hasOnlyPairedSurrogates(value) ||
    Buffer.byteLength(value, 'utf8') >
      maximumDynamoDbAttributeNameBytes
  ) {
    return failItemCondition(failureCode)
  }
  return value
}

/**
 * Reads one allowed drift failure classification.
 *
 * @param value - Candidate caller-selected drift code.
 * @returns Validated apply or rollback drift code.
 */
function readMigrationItemDriftCode(
  value: unknown,
): WorkspaceSearchMigrationItemDriftCode {
  if (
    value !== 'ROLLBACK_TARGET_DRIFT' &&
    value !== 'SOURCE_DRIFT' &&
    value !== 'TARGET_DRIFT'
  ) {
    return failItemCondition('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Validates one item against DynamoDB's 400 KiB boundary.
 *
 * @param item - Detached canonical item.
 * @param failureCode - Failure classification for invalid size.
 */
function validateItemSize(
  item: Readonly<Record<string, AttributeValue>>,
  failureCode: WorkspaceSearchMigrationFailureCode,
): void {
  try {
    validateDynamoDbItemSize(item)
  } catch {
    return failItemCondition(failureCode)
  }
}

/**
 * Creates one canonical item digest under a stable failure boundary.
 *
 * @param item - Detached canonical item.
 * @param failureCode - Failure classification for codec failure.
 * @returns Lowercase exact canonical digest.
 */
function createCanonicalItemDigest(
  item: Readonly<Record<string, AttributeValue>>,
  failureCode: WorkspaceSearchMigrationFailureCode,
): string {
  try {
    return createAttributeMapDigest(item)
  } catch {
    return failItemCondition(failureCode)
  }
}

/**
 * Enforces DynamoDB expression and substitution byte bounds.
 *
 * @param expression - Complete condition expression.
 * @param names - Complete attribute-name substitutions.
 * @param values - Complete attribute-value substitutions.
 */
function validateExpressionBounds(
  expression: string,
  names: Readonly<Record<string, string>>,
  values: Readonly<Record<string, AttributeValue>>,
): void {
  if (
    expression.length === 0 ||
    Buffer.byteLength(expression, 'utf8') >
      maximumConditionExpressionBytes
  ) {
    return failItemCondition('INVALID_ARGUMENT')
  }
  let substitutionBytes: number
  try {
    substitutionBytes =
      Buffer.byteLength(JSON.stringify(names), 'utf8') +
      Buffer.byteLength(
        serializeCanonicalAttributeMap(values),
        'utf8',
      )
  } catch {
    return failItemCondition('INVALID_ARGUMENT')
  }
  if (substitutionBytes > maximumExpressionSubstitutionBytes) {
    return failItemCondition('INVALID_ARGUMENT')
  }
}

/**
 * Defines one own enumerable data property without legacy setter invocation.
 *
 * @param record - Destination record.
 * @param key - Exact property name.
 * @param value - Exact property value.
 */
function defineOwnDataProperty<Value>(
  record: Record<string, Value>,
  key: string,
  value: Value,
): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  })
}

/**
 * Compares strings by UTF-8 ordinal bytes.
 *
 * @param left - First string.
 * @param right - Second string.
 * @returns Negative, zero, or positive byte ordering.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Converts an internal construction failure into the public stable error.
 *
 * @param error - Unknown failure captured at the public boundary.
 * @returns Never returns.
 */
function mapConstructionFailure(error: unknown): never {
  void error
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_ARGUMENT',
    'Workspace Search migration item condition input is invalid.',
  )
}

/**
 * Converts an internal verifier failure into a public stable error.
 *
 * @param error - Unknown failure captured at the public boundary.
 * @returns Never returns.
 */
function mapVerifierFailure(error: unknown): never {
  const code = error instanceof MigrationItemConditionBoundaryFailure
    ? error.code
    : 'INVALID_STATE'
  if (code === 'INVALID_ARGUMENT') {
    throw new WorkspaceSearchMigrationFailure(
      code,
      'Workspace Search migration item verification input is invalid.',
    )
  }
  if (code === 'SOURCE_DRIFT') {
    throw new WorkspaceSearchMigrationFailure(
      code,
      'Workspace Search migration source item drifted.',
    )
  }
  if (code === 'TARGET_DRIFT') {
    throw new WorkspaceSearchMigrationFailure(
      code,
      'Workspace Search migration target item drifted.',
    )
  }
  if (code === 'ROLLBACK_TARGET_DRIFT') {
    throw new WorkspaceSearchMigrationFailure(
      code,
      'Workspace Search migration rollback target item drifted.',
    )
  }
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_STATE',
    'Workspace Search migration strong-read output is invalid.',
  )
}

/**
 * Raises one raw-value-free internal failure.
 *
 * @param code - Stable migration failure classification.
 * @returns Never returns.
 */
function failItemCondition(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new MigrationItemConditionBoundaryFailure(code)
}
