import {
  createAttributeMapDigest,
  decodeAttributeMap,
  decodeAttributeMapToNativeRecord,
  encodeUnknownAttributeMap,
  serializeCanonicalAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  MigrationDigestAccumulator,
  type DynamoAttributeMap,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationSourceName,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import {
  mapWorkspaceSearchMigrationRow,
  type WorkspaceSearchMigrationInvalidReason,
  type WorkspaceSearchMigrationRowClassification,
} from './migration-mapper'
import type {
  WorkspaceSearchMigrationSourceOwnershipBinding,
  WorkspaceSearchMigrationSourceScanRowEvidence,
} from './migration-planner'
import {
  cloneWorkspaceSearchMigrationExactTableKey,
  cloneWorkspaceSearchMigrationExactTableKeyFromItem,
  prepareWorkspaceSearchMigrationSourceScanContext,
  type WorkspaceSearchMigrationSourceScanContextInput,
} from './migration-source-scan-context'
import {
  validateWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/**
 * One unfiltered, full-item DynamoDB source scan page.
 */
export type WorkspaceSearchMigrationSourceScanPage = {
  /** Exact low-level items returned by the bounded Scan request. */
  readonly items: readonly DynamoAttributeMap[]
  /** Opaque key for the next page, absent only when the scan completed. */
  readonly lastEvaluatedKey?: DynamoAttributeMap
}

/**
 * Input for reducing one bounded source scan page.
 */
export type ReduceWorkspaceSearchMigrationSourceScanPageInput =
  WorkspaceSearchMigrationSourceScanContextInput & {
    /** Exact unfiltered, full-item source page returned by DynamoDB. */
    readonly page: WorkspaceSearchMigrationSourceScanPage
  }

/**
 * Safe digest-only evidence for one source row rejected by the pure mapper.
 */
export type WorkspaceSearchMigrationInvalidSourceScanRowEvidence = {
  /** Invalid-row discriminator. */
  readonly classification: 'invalid'
  /** Digest of the exact physical source key. */
  readonly sourceKeyDigest: string
  /** Digest of the exact low-level source item. */
  readonly sourceItemDigest: string
  /** Stable raw-value-free mapper reason. */
  readonly reasonCode: WorkspaceSearchMigrationInvalidReason
}

/**
 * Result of reducing one bounded source scan page.
 */
export type WorkspaceSearchMigrationSourceScanPageResult = {
  /** Cumulative checkpoint after consuming exactly one page. */
  readonly checkpoint: MigrationSourceCheckpoint
  /** Planner-compatible evidence for every mapped or ignored page row. */
  readonly sourceRows: readonly WorkspaceSearchMigrationSourceScanRowEvidence[]
  /** Digest-only evidence for every invalid page row. */
  readonly invalidRows:
    readonly WorkspaceSearchMigrationInvalidSourceScanRowEvidence[]
  /** Exact target-ownership bindings for mapped page rows. */
  readonly sourceBindings:
    readonly WorkspaceSearchMigrationSourceOwnershipBinding[]
}

/**
 * Failure codes deliberately emitted by the private scan-page boundary.
 */
type SourceScanPageFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'TABLE_SCHEMA_MISMATCH'

/**
 * Privately branded failure that cannot be forged by hostile input getters.
 */
class SourceScanPageFailure extends Error {
  /** Stable operator-safe code selected inside the trusted reducer. */
  readonly code: SourceScanPageFailureCode

  /**
   * Creates a private fixed-code failure.
   *
   * @param code - Stable failure code selected by trusted reducer logic.
   */
  constructor(code: SourceScanPageFailureCode) {
    super(code)
    this.name = 'SourceScanPageFailure'
    this.code = code
  }
}

/**
 * Reduces one bounded source page into cumulative checkpoint and planner evidence.
 *
 * The reducer performs no I/O and does not claim table-wide snapshot isolation.
 * The caller must durably store row evidence before committing the returned
 * checkpoint and must enforce the maintenance writer fence around the full scan.
 *
 * @param input - Measured source identity, previous checkpoint, and exact page.
 * @returns Detached cumulative checkpoint and digest-only page evidence.
 */
export function reduceWorkspaceSearchMigrationSourceScanPage(
  input: ReduceWorkspaceSearchMigrationSourceScanPageInput,
): WorkspaceSearchMigrationSourceScanPageResult {
  return runSourceScanPageBoundary(
    () => reduceWorkspaceSearchMigrationSourceScanPageUnchecked(input),
  )
}

/**
 * Reduces one source page inside the public fixed-error boundary.
 *
 * @param input - Measured source identity, previous checkpoint, and exact page.
 * @returns Detached cumulative checkpoint and digest-only page evidence.
 */
function reduceWorkspaceSearchMigrationSourceScanPageUnchecked(
  input: ReduceWorkspaceSearchMigrationSourceScanPageInput,
): WorkspaceSearchMigrationSourceScanPageResult {
  const preflight =
    prepareWorkspaceSearchMigrationSourceScanContext(input)
  if (!preflight.ok) {
    return failSourceScanPage(preflight.code)
  }
  const {
    previousCheckpoint,
    source,
    table,
  } = preflight.context

  const page = input.page
  const pageItemsValue = page.items
  if (
    !hasCanonicalDenseArrayShape(pageItemsValue) ||
    pageItemsValue.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failSourceScanPage('INVALID_ARGUMENT')
  }
  const pageItems = cloneSourcePageItems(pageItemsValue)
  const lastEvaluatedKey = page.lastEvaluatedKey
  let nextCursor: DynamoAttributeMap | undefined
  if (lastEvaluatedKey !== undefined) {
    const keyResult = cloneWorkspaceSearchMigrationExactTableKey(
      lastEvaluatedKey,
      table,
    )
    if (!keyResult.ok) return failSourceScanPage(keyResult.code)
    nextCursor = keyResult.key
    const lastItem = pageItems[pageItems.length - 1]
    if (lastItem === undefined) return failSourceScanPage('INVALID_STATE')
    const lastItemKeyResult =
      cloneWorkspaceSearchMigrationExactTableKeyFromItem(lastItem, table)
    if (!lastItemKeyResult.ok) {
      return failSourceScanPage(lastItemKeyResult.code)
    }
    if (
      serializeCanonicalAttributeMap(nextCursor) !==
        serializeCanonicalAttributeMap(lastItemKeyResult.key)
    ) {
      return failSourceScanPage('INVALID_STATE')
    }
  }
  rejectRepeatedCursor(previousCheckpoint.cursor, nextCursor)

  const scanned = addSafeCounter(
    previousCheckpoint.aggregate.scanned,
    pageItems.length,
  )
  const pageCount = addSafeCounter(
    previousCheckpoint.aggregate.pageCount,
    1,
  )
  const keyAccumulator = MigrationDigestAccumulator.fromState(
    previousCheckpoint.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    previousCheckpoint.contentDigestState,
  )
  const sourceRows: WorkspaceSearchMigrationSourceScanRowEvidence[] = []
  const invalidRows:
    WorkspaceSearchMigrationInvalidSourceScanRowEvidence[] = []
  const sourceBindings: WorkspaceSearchMigrationSourceOwnershipBinding[] = []
  const physicalKeys = new Map<string, string>()
  let mappedDelta = 0
  let ignoredDelta = 0
  let invalidDelta = 0
  let projectedDelta = 0
  let deletedDelta = 0

  for (let index = 0; index < pageItems.length; index += 1) {
    const item = pageItems[index]
    if (!item) return failSourceScanPage('INVALID_ARGUMENT')
    validateDynamoDbItemSize(item)
    const sourceKey = extractTableKey(item, table)
    const sourceKeyDigest = createAttributeMapDigest(sourceKey)
    const sourceItemDigest = createAttributeMapDigest(item)
    rejectDuplicatePhysicalKey(
      physicalKeys,
      sourceKeyDigest,
      serializeCanonicalAttributeMap(sourceKey),
    )
    keyAccumulator.add(sourceKeyDigest)
    contentAccumulator.add(sourceItemDigest)

    const classification = classifySourceItem(source, item)
    if (classification.classification === 'mapped') {
      mappedDelta += 1
      if (classification.operation.action === 'put') {
        projectedDelta += 1
      } else {
        deletedDelta += 1
      }
      sourceRows.push({
        classification: 'mapped',
        sourceKeyDigest,
        sourceItemDigest,
      })
      sourceBindings.push({
        sourceKeyDigest,
        sourceItemDigest,
        targetKeyDigest: createAttributeMapDigest({
          workspaceId: { S: classification.targetKey.workspaceId },
          recordKey: { S: classification.targetKey.recordKey },
        }),
        targetAction: classification.operation.action,
      })
      continue
    }
    if (classification.classification === 'ignored') {
      ignoredDelta += 1
      sourceRows.push({
        classification: 'ignored',
        sourceKeyDigest,
        sourceItemDigest,
      })
      continue
    }
    invalidDelta += 1
    invalidRows.push({
      classification: 'invalid',
      sourceKeyDigest,
      sourceItemDigest,
      reasonCode: classification.reasonCode,
    })
  }

  const mapped = addSafeCounter(
    previousCheckpoint.aggregate.mapped,
    mappedDelta,
  )
  const ignored = addSafeCounter(
    previousCheckpoint.aggregate.ignored,
    ignoredDelta,
  )
  const invalid = addSafeCounter(
    previousCheckpoint.aggregate.invalid,
    invalidDelta,
  )
  const projected = addSafeCounter(
    previousCheckpoint.aggregate.projected,
    projectedDelta,
  )
  const deleted = addSafeCounter(
    previousCheckpoint.aggregate.deleted,
    deletedDelta,
  )
  const checkpoint: MigrationSourceCheckpoint = {
    completed: nextCursor === undefined,
    ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    aggregate: {
      scanned,
      mapped,
      ignored,
      invalid,
      projected,
      deleted,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
  validateWorkspaceSearchMigrationCheckpoint(
    checkpoint,
    previousCheckpoint,
  )
  return {
    checkpoint,
    sourceRows,
    invalidRows,
    sourceBindings,
  }
}

/**
 * Captures one canonical page array without invoking element accessors.
 *
 * @param value - Caller-owned dense source item array.
 * @returns Detached exact item snapshot.
 */
function cloneSourcePageItems(
  value: readonly DynamoAttributeMap[],
): DynamoAttributeMap[] {
  const itemCount = value.length
  const items: DynamoAttributeMap[] = []
  for (let index = 0; index < itemCount; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    const item: unknown =
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : undefined
    if (item === undefined) return failSourceScanPage('INVALID_ARGUMENT')
    items.push(cloneAttributeMap(item))
  }
  if (
    value.length !== itemCount ||
    !hasCanonicalDenseArrayShape(value)
  ) {
    return failSourceScanPage('INVALID_ARGUMENT')
  }
  return items
}

/**
 * Classifies one already detached source item without allowing codec failures
 * to escape the row-level invalid evidence boundary.
 *
 * @param source - Logical source table being scanned.
 * @param item - Detached exact low-level item.
 * @returns Pure mapped, ignored, or fixed-reason invalid classification.
 */
function classifySourceItem(
  source: WorkspaceSearchMigrationSourceName,
  item: DynamoAttributeMap,
): WorkspaceSearchMigrationRowClassification {
  try {
    return mapWorkspaceSearchMigrationRow(
      source,
      decodeAttributeMapToNativeRecord(item),
    )
  } catch {
    return {
      classification: 'invalid',
      reasonCode: 'MAPPER_EXCEPTION',
    }
  }
}

/**
 * Clones one low-level map through the strict lossless attribute codec.
 *
 * @param value - Caller-owned item or key.
 * @returns Detached canonical low-level map.
 */
function cloneAttributeMap(value: unknown): DynamoAttributeMap {
  return decodeAttributeMap(encodeUnknownAttributeMap(value))
}

/**
 * Extracts the exact physical key described by a measured source table.
 *
 * @param item - Detached exact low-level source item.
 * @param table - Measured source table identity.
 * @returns Detached exact physical key.
 */
function extractTableKey(
  item: DynamoAttributeMap,
  table: MigrationTableIdentity,
): DynamoAttributeMap {
  const keyResult =
    cloneWorkspaceSearchMigrationExactTableKeyFromItem(item, table)
  if (!keyResult.ok) return failSourceScanPage(keyResult.code)
  return keyResult.key
}

/**
 * Rejects a cursor that did not advance after consuming one page.
 *
 * @param previous - Previous opaque cursor, when present.
 * @param next - Next opaque cursor, when present.
 */
function rejectRepeatedCursor(
  previous: DynamoAttributeMap | undefined,
  next: DynamoAttributeMap | undefined,
): void {
  if (
    previous !== undefined &&
    next !== undefined &&
    serializeCanonicalAttributeMap(previous) ===
      serializeCanonicalAttributeMap(next)
  ) {
    return failSourceScanPage('INVALID_STATE')
  }
}

/**
 * Rejects duplicate exact keys and digest collisions within one bounded page.
 *
 * @param physicalKeys - Previously observed key digest and canonical bytes.
 * @param digest - Digest of the current exact physical key.
 * @param canonicalKey - Canonical current physical key bytes.
 */
function rejectDuplicatePhysicalKey(
  physicalKeys: Map<string, string>,
  digest: string,
  canonicalKey: string,
): void {
  const existingKey = physicalKeys.get(digest)
  if (existingKey === canonicalKey) {
    return failSourceScanPage('AMBIGUOUS_OPERATION_UNRESOLVED')
  }
  if (existingKey !== undefined) return failSourceScanPage('INVALID_STATE')
  physicalKeys.set(digest, canonicalKey)
}

/**
 * Adds one nonnegative increment without exceeding the safe integer range.
 *
 * @param current - Previously validated cumulative counter.
 * @param increment - Nonnegative bounded increment.
 * @returns Exact safe cumulative counter.
 */
function addSafeCounter(current: number, increment: number): number {
  if (
    !Number.isSafeInteger(current) ||
    current < 0 ||
    !Number.isSafeInteger(increment) ||
    increment < 0 ||
    current > Number.MAX_SAFE_INTEGER - increment
  ) {
    return failSourceScanPage('INVALID_STATE')
  }
  return current + increment
}

/**
 * Runs the public reducer behind a fresh fixed-error replacement boundary.
 *
 * @param operation - Pure reducer work that may inspect hostile runtime values.
 * @returns Exact reducer result.
 */
function runSourceScanPageBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error: unknown) {
    const code = readSourceScanPageFailureCode(error)
    throw new WorkspaceSearchMigrationFailure(
      code,
      `Workspace Search source scan page stopped safely (${code}).`,
    )
  }
}

/**
 * Reads only a privately constructed scan-page failure code.
 *
 * @param error - Arbitrary thrown value from inside the reducer boundary.
 * @returns Trusted private code or the fail-closed default.
 */
function readSourceScanPageFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    return error instanceof SourceScanPageFailure
      ? error.code
      : 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Raises one private fixed-code scan-page failure.
 *
 * @param code - Stable trusted reducer failure code.
 * @returns Never returns.
 */
function failSourceScanPage(code: SourceScanPageFailureCode): never {
  throw new SourceScanPageFailure(code)
}
