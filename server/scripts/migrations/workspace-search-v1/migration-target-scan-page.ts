import {
  createAttributeMapDigest,
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  serializeCanonicalAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  MigrationDigestAccumulator,
  type DynamoAttributeMap,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import {
  classifyWorkspaceSearchMigrationTargetRow,
} from './migration-planner'
import type {
  WorkspaceSearchMigrationObservedTargetBinding,
  WorkspaceSearchMigrationTargetScanRowEvidence,
} from './migration-planner'
import {
  cloneWorkspaceSearchMigrationExactTableKey,
  cloneWorkspaceSearchMigrationExactTableKeyFromItem,
} from './migration-source-scan-context'
import {
  prepareWorkspaceSearchMigrationTargetScanContext,
  type WorkspaceSearchMigrationTargetScanCheckpoint,
  type WorkspaceSearchMigrationTargetScanContextInput,
  validateWorkspaceSearchMigrationTargetScanCheckpoint,
} from './migration-target-scan-context'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/**
 * One unfiltered, full-item DynamoDB target Scan page.
 */
export type WorkspaceSearchMigrationTargetScanPage = {
  /** Exact low-level target items returned by the bounded Scan request. */
  readonly items: readonly DynamoAttributeMap[]
  /** Opaque key for the next page, absent only when the scan completed. */
  readonly lastEvaluatedKey?: DynamoAttributeMap
}

/**
 * Input for reducing one bounded target Scan page.
 */
export type ReduceWorkspaceSearchMigrationTargetScanPageInput =
  WorkspaceSearchMigrationTargetScanContextInput & {
    /** Exact unfiltered, full-item target page returned by DynamoDB. */
    readonly page: WorkspaceSearchMigrationTargetScanPage
  }

/**
 * Safe digest-only evidence for one target row rejected by classification.
 */
export type WorkspaceSearchMigrationInvalidTargetScanRowEvidence = {
  /** Invalid-row discriminator. */
  readonly classification: 'invalid'
  /** Digest of the exact physical target key. */
  readonly targetKeyDigest: string
  /** Digest of the exact low-level target item. */
  readonly targetItemDigest: string
  /** Stable raw-value-free target-classification reason. */
  readonly reasonCode: 'INVALID_TARGET_ROW'
}

/**
 * Result of reducing one bounded target Scan page.
 */
export type WorkspaceSearchMigrationTargetScanPageResult = {
  /** Cumulative target-only checkpoint after consuming exactly one page. */
  readonly checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint
  /** Planner-compatible evidence for every owned or ignored target row. */
  readonly targetRows: readonly WorkspaceSearchMigrationTargetScanRowEvidence[]
  /** Digest-only evidence for every invalid target row. */
  readonly invalidRows:
    readonly WorkspaceSearchMigrationInvalidTargetScanRowEvidence[]
  /** Exact target-key and preimage bindings for migration-owned rows. */
  readonly observedTargetBindings:
    readonly WorkspaceSearchMigrationObservedTargetBinding[]
}

/**
 * Failure codes deliberately emitted by the private target-page boundary.
 */
type TargetScanPageFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'
  | 'TABLE_SCHEMA_MISMATCH'

/**
 * Privately branded target-page failure that hostile input cannot forge.
 */
class TargetScanPageFailure extends Error {
  /** Stable operator-safe code selected inside the trusted reducer. */
  readonly code: TargetScanPageFailureCode

  /**
   * Creates one private fixed-code target Scan failure.
   *
   * @param code - Stable code selected by trusted reducer logic.
   */
  constructor(code: TargetScanPageFailureCode) {
    super(code)
    this.name = 'TargetScanPageFailure'
    this.code = code
  }
}

/**
 * Reduces one bounded target page into checkpoint and ownership evidence.
 *
 * The reducer performs no I/O and does not claim table-wide snapshot
 * isolation. The caller must persist the exact raw page before advancing the
 * checkpoint and must maintain the writer fence across the complete scan.
 *
 * @param input - Measured target identity, predecessor, and exact raw page.
 * @returns Detached cumulative checkpoint and digest-only page evidence.
 */
export function reduceWorkspaceSearchMigrationTargetScanPage(
  input: ReduceWorkspaceSearchMigrationTargetScanPageInput,
): WorkspaceSearchMigrationTargetScanPageResult {
  return runTargetScanPageBoundary(
    () => reduceWorkspaceSearchMigrationTargetScanPageUnchecked(input),
  )
}

/**
 * Reduces one target page inside the public fixed-error boundary.
 *
 * @param input - Measured target context and exact page.
 * @returns Detached cumulative checkpoint and page evidence.
 */
function reduceWorkspaceSearchMigrationTargetScanPageUnchecked(
  input: ReduceWorkspaceSearchMigrationTargetScanPageInput,
): WorkspaceSearchMigrationTargetScanPageResult {
  const preflight =
    prepareWorkspaceSearchMigrationTargetScanContext(input)
  if (!preflight.ok) return failTargetScanPage(preflight.code)
  const { configurationHash, previousCheckpoint, table } = preflight.context
  const pageItemsValue = input.page.items
  if (
    !hasCanonicalDenseArrayShape(pageItemsValue) ||
    pageItemsValue.length > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE
  ) {
    return failTargetScanPage('INVALID_ARGUMENT')
  }
  const pageItems = cloneTargetPageItems(pageItemsValue)
  const nextCursor = cloneAndValidateNextCursor(
    input.page.lastEvaluatedKey,
    pageItems,
    table,
  )
  rejectRepeatedCursor(previousCheckpoint.cursor, nextCursor)

  const keyAccumulator = MigrationDigestAccumulator.fromState(
    previousCheckpoint.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    previousCheckpoint.contentDigestState,
  )
  const targetRows: WorkspaceSearchMigrationTargetScanRowEvidence[] = []
  const invalidRows:
    WorkspaceSearchMigrationInvalidTargetScanRowEvidence[] = []
  const observedTargetBindings:
    WorkspaceSearchMigrationObservedTargetBinding[] = []
  const physicalKeys = new Map<string, string>()
  let ownedDelta = 0
  let ignoredDelta = 0
  let invalidDelta = 0

  for (const item of pageItems) {
    validateDynamoDbItemSize(item)
    const targetKey = extractTableKey(item, table)
    const targetKeyDigest = createAttributeMapDigest(targetKey)
    const targetItemDigest = createAttributeMapDigest(item)
    rejectDuplicatePhysicalKey(
      physicalKeys,
      targetKeyDigest,
      serializeCanonicalAttributeMap(targetKey),
    )
    keyAccumulator.add(targetKeyDigest)
    contentAccumulator.add(targetItemDigest)

    let classification
    try {
      classification = classifyWorkspaceSearchMigrationTargetRow(item)
    } catch {
      invalidDelta += 1
      invalidRows.push({
        classification: 'invalid',
        targetKeyDigest,
        targetItemDigest,
        reasonCode: 'INVALID_TARGET_ROW',
      })
      continue
    }
    if (classification.classification === 'owned') {
      if (
        classification.targetKeyDigest !== targetKeyDigest ||
        serializeCanonicalAttributeMap(classification.targetKey) !==
          serializeCanonicalAttributeMap(targetKey)
      ) {
        return failTargetScanPage('INVALID_STATE')
      }
      ownedDelta += 1
      targetRows.push({
        classification: 'owned',
        targetKeyDigest,
        targetItemDigest,
      })
      observedTargetBindings.push({
        targetKeyDigest,
        targetItemDigest,
      })
      continue
    }
    if (classification.classification === 'ignored') {
      ignoredDelta += 1
      targetRows.push({
        classification: 'ignored',
        targetKeyDigest,
        targetItemDigest,
      })
      continue
    }
    return failTargetScanPage('INVALID_STATE')
  }

  const checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint = {
    configurationHash,
    completed: nextCursor === undefined,
    ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
    aggregate: {
      scanned: addSafeCounter(
        previousCheckpoint.aggregate.scanned,
        pageItems.length,
      ),
      owned: addSafeCounter(
        previousCheckpoint.aggregate.owned,
        ownedDelta,
      ),
      ignored: addSafeCounter(
        previousCheckpoint.aggregate.ignored,
        ignoredDelta,
      ),
      invalid: addSafeCounter(
        previousCheckpoint.aggregate.invalid,
        invalidDelta,
      ),
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount: addSafeCounter(
        previousCheckpoint.aggregate.pageCount,
        1,
      ),
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
  validateWorkspaceSearchMigrationTargetScanCheckpoint(
    checkpoint,
    previousCheckpoint,
  )
  return {
    checkpoint,
    targetRows,
    invalidRows,
    observedTargetBindings,
  }
}

/**
 * Clones and validates an optional target cursor against the returned page.
 *
 * @param cursor - Candidate LastEvaluatedKey.
 * @param items - Detached exact target items.
 * @param table - Measured target table identity.
 * @returns Detached next cursor or undefined for a terminal page.
 */
function cloneAndValidateNextCursor(
  cursor: DynamoAttributeMap | undefined,
  items: readonly DynamoAttributeMap[],
  table: MigrationTableIdentity,
): DynamoAttributeMap | undefined {
  if (cursor === undefined) return undefined
  const cursorResult = cloneWorkspaceSearchMigrationExactTableKey(
    cursor,
    table,
  )
  if (!cursorResult.ok) return failTargetScanPage(cursorResult.code)
  const lastItem = items[items.length - 1]
  if (lastItem === undefined) return failTargetScanPage('INVALID_STATE')
  const lastItemKeyResult =
    cloneWorkspaceSearchMigrationExactTableKeyFromItem(lastItem, table)
  if (!lastItemKeyResult.ok) {
    return failTargetScanPage(lastItemKeyResult.code)
  }
  if (
    serializeCanonicalAttributeMap(cursorResult.key) !==
      serializeCanonicalAttributeMap(lastItemKeyResult.key)
  ) {
    return failTargetScanPage('INVALID_STATE')
  }
  return cursorResult.key
}

/**
 * Captures one canonical page array without invoking element accessors.
 *
 * @param value - Caller-owned dense target item array.
 * @returns Detached exact target item snapshot.
 */
function cloneTargetPageItems(
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
    if (item === undefined) return failTargetScanPage('INVALID_ARGUMENT')
    items.push(cloneAttributeMap(item))
  }
  if (
    value.length !== itemCount ||
    !hasCanonicalDenseArrayShape(value)
  ) {
    return failTargetScanPage('INVALID_ARGUMENT')
  }
  return items
}

/**
 * Clones one low-level map through the strict lossless codec.
 *
 * @param value - Caller-owned item.
 * @returns Detached canonical low-level target map.
 */
function cloneAttributeMap(value: unknown): DynamoAttributeMap {
  return decodeAttributeMap(encodeUnknownAttributeMap(value))
}

/**
 * Extracts the exact physical key described by the measured target table.
 *
 * @param item - Detached exact low-level target item.
 * @param table - Measured target table identity.
 * @returns Detached exact physical target key.
 */
function extractTableKey(
  item: DynamoAttributeMap,
  table: MigrationTableIdentity,
): DynamoAttributeMap {
  const keyResult =
    cloneWorkspaceSearchMigrationExactTableKeyFromItem(item, table)
  if (!keyResult.ok) return failTargetScanPage(keyResult.code)
  return keyResult.key
}

/**
 * Rejects a target cursor that did not advance after one page.
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
    return failTargetScanPage('INVALID_STATE')
  }
}

/**
 * Rejects duplicate exact keys and digest collisions within one page.
 *
 * @param physicalKeys - Previously observed key digests and canonical keys.
 * @param digest - Digest of the current target key.
 * @param canonicalKey - Canonical current target key bytes.
 */
function rejectDuplicatePhysicalKey(
  physicalKeys: Map<string, string>,
  digest: string,
  canonicalKey: string,
): void {
  const existingKey = physicalKeys.get(digest)
  if (existingKey === canonicalKey) {
    return failTargetScanPage('AMBIGUOUS_OPERATION_UNRESOLVED')
  }
  if (existingKey !== undefined) return failTargetScanPage('INVALID_STATE')
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
    return failTargetScanPage('INVALID_STATE')
  }
  return current + increment
}

/**
 * Runs the public reducer behind a fresh fixed-error replacement boundary.
 *
 * @param operation - Pure reducer work that may inspect hostile values.
 * @returns Exact reducer result.
 */
function runTargetScanPageBoundary<Result>(operation: () => Result): Result {
  try {
    return operation()
  } catch (error: unknown) {
    const code = readTargetScanPageFailureCode(error)
    throw new WorkspaceSearchMigrationFailure(
      code,
      `Workspace Search target Scan page stopped safely (${code}).`,
    )
  }
}

/**
 * Reads only a privately constructed target-page failure code.
 *
 * @param error - Arbitrary thrown value from inside the reducer boundary.
 * @returns Trusted private code or the fail-closed default.
 */
function readTargetScanPageFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    return error instanceof TargetScanPageFailure
      ? error.code
      : 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Raises one private fixed-code target-page failure.
 *
 * @param code - Stable trusted reducer failure code.
 * @returns Never returns.
 */
function failTargetScanPage(code: TargetScanPageFailureCode): never {
  throw new TargetScanPageFailure(code)
}
