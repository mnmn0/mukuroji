import type { SearchEntityType } from '@mukuroji/contracts'
import {
  createWorkspaceSearchDocumentRecordKey,
} from '../../../src/modules/workspace-search'
import {
  createAttributeMapDigest,
  decodeAttributeMap,
  encodeAttributeMap,
  serializeCanonicalAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  type EncodedMigrationItemSnapshot,
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
  type WorkspaceSearchJournalSegment,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'

/** Maximum exact UTF-8 size accepted for one single-request journal upload. */
export const WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES = 2 * 1024 * 1024

/**
 * Creates the canonical digest used for an absent DynamoDB item snapshot.
 *
 * @returns Lowercase SHA-256 digest of the versioned absent-state marker.
 */
export function createAbsentMigrationItemDigest(): string {
  return createMigrationDigest({
    exists: false,
    snapshotVersion: 1,
  })
}

/**
 * Serializes one validated journal segment into canonical exact bytes.
 *
 * @param value - Candidate journal segment assembled by the migration engine.
 * @returns Canonical JSON text without a trailing newline.
 */
export function serializeWorkspaceSearchJournalSegment(
  value: WorkspaceSearchJournalSegment,
): string {
  try {
    const validated = readWorkspaceSearchJournalSegment(value)
    const serialized = serializeCanonicalJson(validated)
    if (
      Buffer.byteLength(serialized, 'utf8') >
      WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES
    ) {
      return failJournal()
    }
    return serialized
  } catch (error) {
    return wrapJournalFailure(error)
  }
}

/**
 * Parses strict canonical journal JSON and validates every digest and target key.
 *
 * @param text - Exact canonical journal object bytes decoded as UTF-8.
 * @returns Fully validated JSON-safe journal segment.
 */
export function parseWorkspaceSearchJournalSegment(
  text: string,
): WorkspaceSearchJournalSegment {
  try {
    if (
      text.length === 0 ||
      Buffer.byteLength(text, 'utf8') >
        WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES
    ) {
      return failJournal()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failJournal()
    }

    const segment = readWorkspaceSearchJournalSegment(parsed)
    if (serializeCanonicalJson(segment) !== text) {
      return failJournal()
    }
    return segment
  } catch (error) {
    return wrapJournalFailure(error)
  }
}

/**
 * Reads a strict journal segment from untrusted parsed data.
 *
 * @param value - Candidate parsed journal document.
 * @returns Reconstructed canonical segment.
 */
function readWorkspaceSearchJournalSegment(
  value: unknown,
): WorkspaceSearchJournalSegment {
  const record = requireRecord(value)
  requireExactKeys(
    record,
    [
      'after',
      'before',
      'configurationHash',
      'createdAt',
      'kind',
      'migrationId',
      'migrationVersion',
      'operationId',
      'preparedFenceToken',
      'previousHeadDigest',
      'runId',
      'segmentVersion',
      'sequence',
      'targetKey',
      'targetKeyDigest',
    ],
    ['sourceDigest'],
  )

  if (
    record.kind !== 'workspace-search-preimage-segment' ||
    record.segmentVersion !== 1 ||
    record.migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    record.migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failJournal()
  }

  const runId = requireIdentifier(record.runId)
  const configurationHash = requireDigest(record.configurationHash)
  const sequence = requirePositiveSafeInteger(record.sequence)
  const preparedFenceToken = requirePositiveSafeInteger(
    record.preparedFenceToken,
  )
  const operationId = requireDigest(record.operationId)
  const sourceDigest = record.sourceDigest === undefined
    ? undefined
    : requireDigest(record.sourceDigest)
  const previousHeadDigest = requireDigest(record.previousHeadDigest)
  const targetKey = readTargetKey(record.targetKey)
  const targetKeyDigest = requireDigest(record.targetKeyDigest)
  const rawTargetKey = decodeAttributeMap(targetKey)

  if (createAttributeMapDigest(rawTargetKey) !== targetKeyDigest) {
    return failJournal()
  }

  const before = readSnapshot(record.before, rawTargetKey)
  const after = readSnapshot(record.after, rawTargetKey)
  if (before.digest === after.digest) {
    return failJournal()
  }

  const createdAt = requireCanonicalTimestamp(record.createdAt)

  return {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    sequence,
    preparedFenceToken,
    operationId,
    ...(sourceDigest ? { sourceDigest } : {}),
    previousHeadDigest,
    targetKey,
    targetKeyDigest,
    before,
    after,
    createdAt,
  }
}

/**
 * Reads and canonicalizes the exact Workspace Search primary key.
 *
 * @param value - Candidate encoded key.
 * @returns Canonical encoded key.
 */
function readTargetKey(value: unknown) {
  const raw = decodeAttributeMap(value)
  const keys = Object.keys(raw).sort()
  const workspaceId = readNonBlankStringAttribute(raw.workspaceId)
  const recordKey = readNonBlankStringAttribute(raw.recordKey)
  if (
    keys.length !== 2 ||
    keys[0] !== 'recordKey' ||
    keys[1] !== 'workspaceId' ||
    workspaceId === undefined ||
    workspaceId.length > 1_024 ||
    recordKey === undefined
  ) {
    return failJournal()
  }
  requireCanonicalTargetRecordKey(recordKey)
  return encodeAttributeMap(raw)
}

/**
 * Requires a canonical Workspace Search document key in a migration-owned family.
 *
 * @param recordKey - Candidate target sort key.
 */
function requireCanonicalTargetRecordKey(recordKey: string): void {
  const parts = recordKey.split('#')
  const encodedEntityId = parts[2]
  if (
    parts.length !== 3 ||
    parts[0] !== 'DOCUMENT' ||
    encodedEntityId === undefined ||
    encodedEntityId.length === 0
  ) {
    return failJournal()
  }

  const entityType = requireMigrationEntityType(parts[1])
  const entityId = Buffer.from(encodedEntityId, 'base64url').toString('utf8')
  requireCanonicalMigrationEntityId(entityType, entityId)
  if (
    createWorkspaceSearchDocumentRecordKey(entityType, entityId) !== recordKey
  ) {
    return failJournal()
  }
}

/**
 * Requires the unambiguous entity ID grammar emitted by the migration mapper.
 *
 * @param entityType - Migration-owned Search entity family.
 * @param entityId - Decoded canonical entity identity.
 */
function requireCanonicalMigrationEntityId(
  entityType: SearchEntityType,
  entityId: string,
): void {
  if (entityId.length === 0 || entityId !== entityId.trim()) {
    return failJournal()
  }
  if (entityType === 'document') return

  const parts = entityId.split('/')
  if (
    entityType === 'team' &&
    parts.length === 2 &&
    parts[0] === 'team' &&
    isCanonicalEntityIdPart(parts[1])
  ) {
    return
  }
  if (
    (entityType === 'project' || entityType === 'work-item') &&
    parts.length === 4 &&
    parts[0] === 'team' &&
    isCanonicalEntityIdPart(parts[1]) &&
    parts[2] === (entityType === 'project' ? 'project' : 'issue') &&
    isCanonicalEntityIdPart(parts[3])
  ) {
    return
  }
  if (
    entityType === 'comment' &&
    parts.length === 6 &&
    parts[0] === 'team' &&
    isCanonicalEntityIdPart(parts[1]) &&
    parts[2] === 'issue' &&
    isCanonicalEntityIdPart(parts[3]) &&
    parts[4] === 'comment' &&
    isCanonicalEntityIdPart(parts[5])
  ) {
    return
  }
  return failJournal()
}

/**
 * Checks one nonempty exact-trimmed structured entity ID segment.
 *
 * @param value - Candidate path segment.
 * @returns Whether the segment is canonical.
 */
function isCanonicalEntityIdPart(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value === value.trim()
}

/**
 * Requires an entity family covered by Workspace Search migration v1.
 *
 * @param value - Candidate family decoded from a target record key or item.
 * @returns Validated migration-owned Search entity family.
 */
function requireMigrationEntityType(value: unknown): SearchEntityType {
  if (
    value === 'comment' ||
    value === 'document' ||
    value === 'project' ||
    value === 'team' ||
    value === 'work-item'
  ) {
    return value
  }
  return failJournal()
}

/**
 * Reads one encoded present or absent item snapshot.
 *
 * @param value - Candidate snapshot.
 * @param rawTargetKey - Validated raw target key.
 * @returns Validated canonical snapshot.
 */
function readSnapshot(
  value: unknown,
  rawTargetKey: ReturnType<typeof decodeAttributeMap>,
): EncodedMigrationItemSnapshot {
  const record = requireRecord(value)

  if (record.exists === false) {
    requireExactKeys(record, ['digest', 'exists'])
    const digest = requireDigest(record.digest)
    if (digest !== createAbsentMigrationItemDigest()) {
      return failJournal()
    }
    return {
      exists: false,
      digest,
    }
  }

  if (record.exists !== true) {
    return failJournal()
  }
  requireExactKeys(record, ['digest', 'exists', 'item'])
  const rawItem = decodeAttributeMap(record.item)
  requireItemTargetKey(rawItem, rawTargetKey)
  const digest = requireDigest(record.digest)
  if (createAttributeMapDigest(rawItem) !== digest) {
    return failJournal()
  }
  return {
    exists: true,
    item: encodeAttributeMap(rawItem),
    digest,
  }
}

/**
 * Confirms that a present snapshot carries the exact journal target key.
 *
 * @param rawItem - Decoded complete target item.
 * @param rawTargetKey - Decoded exact target key.
 */
function requireItemTargetKey(
  rawItem: ReturnType<typeof decodeAttributeMap>,
  rawTargetKey: ReturnType<typeof decodeAttributeMap>,
): void {
  const itemWorkspaceId = rawItem.workspaceId
  const itemRecordKey = rawItem.recordKey
  const itemEntryType = readNonBlankStringAttribute(rawItem.entryType)
  const itemEntityType = requireMigrationEntityType(
    readNonBlankStringAttribute(rawItem.entityType),
  )
  const itemEntityId = readNonBlankStringAttribute(rawItem.entityId)
  const targetWorkspaceId = rawTargetKey.workspaceId
  const targetRecordKey = rawTargetKey.recordKey
  if (
    !itemWorkspaceId ||
    !itemRecordKey ||
    itemEntryType !== 'search-document' ||
    itemEntityId === undefined ||
    !targetWorkspaceId ||
    !targetRecordKey
  ) {
    return failJournal()
  }

  if (
    createWorkspaceSearchDocumentRecordKey(itemEntityType, itemEntityId) !==
      readNonBlankStringAttribute(targetRecordKey) ||
    serializeCanonicalAttributeMap({
      workspaceId: itemWorkspaceId,
      recordKey: itemRecordKey,
    }) !==
    serializeCanonicalAttributeMap({
      workspaceId: targetWorkspaceId,
      recordKey: targetRecordKey,
    })
  ) {
    return failJournal()
  }
}

/**
 * Reads a nonblank low-level DynamoDB string attribute.
 *
 * @param value - Candidate AttributeValue.
 * @returns Original string value when the attribute is exact and nonblank.
 */
function readNonBlankStringAttribute(
  value: ReturnType<typeof decodeAttributeMap>[string] | undefined,
): string | undefined {
  if (
    value !== undefined &&
    Object.keys(value).length === 1 &&
    typeof value.S === 'string' &&
    value.S.length > 0 &&
    value.S === value.S.trim()
  ) {
    return value.S
  }
  return undefined
}

/**
 * Requires a safe run identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function requireIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failJournal()
  }
  return value
}

/**
 * Requires a lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function requireDigest(value: unknown): string {
  if (!isHexDigest(value)) return failJournal()
  return value
}

/**
 * Requires a positive safe integer.
 *
 * @param value - Candidate number.
 * @returns Validated integer.
 */
function requirePositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failJournal()
  }
  return value
}

/**
 * Requires a canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function requireCanonicalTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failJournal()
  return value
}

/**
 * Requires one plain validation record.
 *
 * @param value - Candidate value.
 * @returns Plain string-keyed record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failJournal()
  return value
}

/**
 * Checks whether a value is a plain non-array record.
 *
 * @param value - Candidate value.
 * @returns Whether the value is suitable for strict field validation.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Requires exactly the allowed fields.
 *
 * @param record - Candidate record.
 * @param required - Required field names.
 * @param optional - Optional field names.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(record).sort()
  const allowed = [...required, ...optional].sort()
  if (
    actual.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    return failJournal()
  }
}

/**
 * Converts any lower-level validation failure into the stable journal boundary.
 *
 * @param error - Internal parse or codec failure.
 * @returns Never returns.
 */
function wrapJournalFailure(error: unknown): never {
  if (
    error instanceof WorkspaceSearchMigrationFailure &&
    error.code === 'INVALID_JOURNAL'
  ) {
    throw error
  }
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_JOURNAL',
    'Migration journal segment is invalid.',
  )
}

/**
 * Raises a stable raw-value-free journal failure.
 *
 * @returns Never returns.
 */
function failJournal(): never {
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_JOURNAL',
    'Migration journal segment is invalid.',
  )
}
