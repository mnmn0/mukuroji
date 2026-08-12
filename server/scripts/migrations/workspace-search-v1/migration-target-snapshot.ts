import type { AttributeValue } from '@aws-sdk/client-dynamodb'
import {
  readWorkspaceSearchDocument,
  type WorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  type DynamoAttributeMap,
  type MigrationItemSnapshot,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import { createAbsentMigrationItemDigest } from './migration-journal'

/**
 * Encodes one canonical Workspace Search document into its exact low-level
 * DynamoDB representation.
 *
 * The document is revalidated before encoding so the migration cannot seal a
 * caller-forged projection digest or a persistence shape that differs from the
 * live Workspace Search writer.
 *
 * @param document - Canonical native Workspace Search projection.
 * @returns Exact low-level DynamoDB item.
 */
export function encodeWorkspaceSearchMigrationDocument(
  document: WorkspaceSearchDocument,
): DynamoAttributeMap {
  let normalized: WorkspaceSearchDocument
  try {
    const suppliedProjectionDigest = document.projectionDigest
    if (typeof suppliedProjectionDigest !== 'string') {
      throw new Error('Missing projection digest.')
    }
    normalized = readWorkspaceSearchDocument({ ...document })
    if (normalized.projectionDigest !== suppliedProjectionDigest) {
      throw new Error('Projection digest mismatch.')
    }
  } catch {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Workspace Search migration document is not canonical.',
    )
  }
  return encodeNativeRecord({ ...normalized })
}

/**
 * Captures one exact existing low-level target item for source/target CAS.
 *
 * @param item - Exact item returned by a strongly consistent target read.
 * @returns Present target snapshot and its canonical attribute-map digest.
 */
export function createWorkspaceSearchMigrationExistingSnapshot(
  item: DynamoAttributeMap,
): MigrationItemSnapshot {
  let clonedItem: DynamoAttributeMap
  try {
    clonedItem = decodeAttributeMap(encodeAttributeMap(item))
  } catch {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_STATE',
      'Workspace Search migration target item is not canonical.',
    )
  }
  return {
    exists: true,
    item: clonedItem,
    digest: createAttributeMapDigest(clonedItem),
  }
}

/**
 * Creates the canonical absent target snapshot used by planning and rollback.
 *
 * @returns Canonical absent item snapshot.
 */
export function createWorkspaceSearchMigrationAbsentSnapshot():
  MigrationItemSnapshot {
  return {
    exists: false,
    digest: createAbsentMigrationItemDigest(),
  }
}

/**
 * Creates the canonical intended target snapshot for one projected document.
 *
 * @param document - Canonical document emitted by the migration mapper.
 * @returns Exact low-level target item and digest.
 */
export function createWorkspaceSearchMigrationDocumentSnapshot(
  document: WorkspaceSearchDocument,
): MigrationItemSnapshot {
  const item = encodeWorkspaceSearchMigrationDocument(document)
  return createWorkspaceSearchMigrationExistingSnapshot(item)
}

/**
 * Encodes a normalized native record without lossy DocumentClient coercion.
 *
 * @param record - Normalized Workspace Search document or nested map.
 * @returns Exact low-level DynamoDB attribute map.
 */
function encodeNativeRecord(
  record: Readonly<Record<string, unknown>>,
): DynamoAttributeMap {
  const encoded: DynamoAttributeMap = {}
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue
    Object.defineProperty(encoded, key, {
      configurable: true,
      enumerable: true,
      value: encodeNativeValue(value),
      writable: true,
    })
  }
  return encoded
}

/**
 * Encodes one normalized Workspace Search value as a DynamoDB attribute.
 *
 * @param value - Normalized JSON-compatible projection value.
 * @returns Exact low-level attribute value.
 */
function encodeNativeValue(value: unknown): AttributeValue {
  if (typeof value === 'string') return { S: value }
  if (typeof value === 'boolean') return { BOOL: value }
  if (value === null) return { NULL: true }
  if (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= Number.MIN_SAFE_INTEGER
    && value <= Number.MAX_SAFE_INTEGER
  ) {
    return { N: String(value) }
  }
  if (Array.isArray(value)) {
    return { L: value.map((entry) => encodeNativeValue(entry)) }
  }
  if (isPlainRecord(value)) {
    return { M: encodeNativeRecord(value) }
  }
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_STATE',
    'Normalized search projection contains an unsupported value.',
  )
}

/**
 * Checks whether one unknown value is a plain string-keyed record.
 *
 * @param value - Candidate nested projection value.
 * @returns Whether the value is a plain record.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
