import {
  type ScanCommand,
  type ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  serializeCanonicalAttributeMap,
} from './dynamodb-attribute-codec'
import {
  type DynamoAttributeMap,
  type MigrationTableIdentity,
  WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationSourceScanPage,
} from './migration-source-scan-page'
import {
  cloneWorkspaceSearchMigrationExactTableKey,
  cloneWorkspaceSearchMigrationExactTableKeyFromItem,
  type WorkspaceSearchMigrationSourceScanContextInput,
} from './migration-source-scan-context'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/**
 * Measured context required by the managed AWS session for one source Scan.
 */
export type WorkspaceSearchMigrationSourceScanReadInput =
  WorkspaceSearchMigrationSourceScanContextInput

/**
 * Narrow AWS transport containing only the source Scan data-plane read.
 */
export interface WorkspaceSearchMigrationSourceScanAwsTransport {
  /**
   * Sends one exact unfiltered base-table Scan command.
   *
   * @param command - Adapter-owned read-only command.
   * @returns Raw low-level DynamoDB page.
   */
  scanSource(command: ScanCommand): Promise<ScanCommandOutput>
}

/**
 * Failure codes emitted while normalizing one untrusted SDK Scan response.
 */
export type WorkspaceSearchMigrationSourceScanOutputFailureCode =
  | 'INVALID_STATE'
  | 'TABLE_SCHEMA_MISMATCH'

/**
 * Successful source Scan output normalization.
 */
type WorkspaceSearchMigrationSourceScanOutputSuccess = {
  /** Successful-result discriminator. */
  readonly ok: true
  /** Detached full-item page. */
  readonly page: WorkspaceSearchMigrationSourceScanPage
}

/**
 * Failed source Scan output normalization.
 */
type WorkspaceSearchMigrationSourceScanOutputFailure = {
  /** Failed-result discriminator. */
  readonly ok: false
  /** Stable raw-value-free failure code. */
  readonly code: WorkspaceSearchMigrationSourceScanOutputFailureCode
}

/**
 * Result of normalizing one low-level DynamoDB Scan response.
 */
export type WorkspaceSearchMigrationSourceScanOutputResult =
  | WorkspaceSearchMigrationSourceScanOutputFailure
  | WorkspaceSearchMigrationSourceScanOutputSuccess

/**
 * Validates and detaches one low-level DynamoDB Scan response.
 *
 * This helper performs no I/O and grants no source-read authority. The managed
 * AWS session owns command construction, identity binding, and lifecycle checks.
 *
 * @param output - Arbitrary SDK response page.
 * @param table - Exact measured source table identity.
 * @returns Detached page or a fixed raw-value-free failure code.
 */
export function normalizeWorkspaceSearchMigrationSourceScanOutput(
  output: ScanCommandOutput,
  table: MigrationTableIdentity,
): WorkspaceSearchMigrationSourceScanOutputResult {
  try {
    return normalizeSourceScanOutputUnchecked(output, table)
  } catch {
    return sourceScanOutputFailure('INVALID_STATE')
  }
}

/**
 * Normalizes one response after entering the raw-error replacement boundary.
 *
 * @param output - Arbitrary SDK response page.
 * @param table - Exact measured source table identity.
 * @returns Detached page or a deliberate validation failure.
 */
function normalizeSourceScanOutputUnchecked(
  output: ScanCommandOutput,
  table: MigrationTableIdentity,
): WorkspaceSearchMigrationSourceScanOutputResult {
  const outputItemsValue = output.Items
  const count = output.Count
  const scannedCount = output.ScannedCount
  const lastEvaluatedKey = output.LastEvaluatedKey
  const outputItems = outputItemsValue === undefined ? [] : outputItemsValue
  const itemCount = outputItems.length
  if (
    !hasCanonicalDenseArrayShape(outputItems) ||
    itemCount > WORKSPACE_SEARCH_MIGRATION_PAGE_SIZE ||
    !isExactResponseCount(count, itemCount) ||
    !isExactResponseCount(scannedCount, itemCount)
  ) {
    return sourceScanOutputFailure('INVALID_STATE')
  }

  const items: DynamoAttributeMap[] = []
  for (let index = 0; index < itemCount; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      outputItems,
      String(index),
    )
    const item: unknown =
      descriptor !== undefined &&
      descriptor.enumerable === true &&
      Object.prototype.hasOwnProperty.call(descriptor, 'value')
        ? descriptor.value
        : undefined
    if (item === undefined) {
      return sourceScanOutputFailure('INVALID_STATE')
    }
    items.push(cloneAttributeMap(item))
  }
  if (
    outputItems.length !== itemCount ||
    !hasCanonicalDenseArrayShape(outputItems)
  ) {
    return sourceScanOutputFailure('INVALID_STATE')
  }

  if (lastEvaluatedKey === undefined) {
    return {
      ok: true,
      page: { items },
    }
  }
  const cursorResult = cloneWorkspaceSearchMigrationExactTableKey(
    lastEvaluatedKey,
    table,
  )
  if (!cursorResult.ok) return sourceScanOutputFailure(cursorResult.code)
  const lastItem = items[itemCount - 1]
  if (lastItem === undefined) {
    return sourceScanOutputFailure('INVALID_STATE')
  }
  const lastItemKeyResult =
    cloneWorkspaceSearchMigrationExactTableKeyFromItem(lastItem, table)
  if (!lastItemKeyResult.ok) {
    return sourceScanOutputFailure(lastItemKeyResult.code)
  }
  if (
    serializeCanonicalAttributeMap(cursorResult.key) !==
      serializeCanonicalAttributeMap(lastItemKeyResult.key)
  ) {
    return sourceScanOutputFailure('INVALID_STATE')
  }
  return {
    ok: true,
    page: {
      items,
      lastEvaluatedKey: cursorResult.key,
    },
  }
}

/**
 * Checks one mandatory response count against the unfiltered item count.
 *
 * @param value - Runtime Count or ScannedCount field.
 * @param itemCount - Exact full-item page length.
 * @returns Whether the field is an exact nonnegative safe integer count.
 */
function isExactResponseCount(
  value: number | undefined,
  itemCount: number,
): boolean {
  return Number.isSafeInteger(value) && value === itemCount
}

/**
 * Clones one low-level attribute map through the strict lossless codec.
 *
 * @param value - SDK-owned item.
 * @returns Detached canonical low-level map.
 */
function cloneAttributeMap(value: unknown): DynamoAttributeMap {
  return decodeAttributeMap(encodeUnknownAttributeMap(value))
}

/**
 * Creates one failed response-normalization result.
 *
 * @param code - Stable raw-value-free failure code.
 * @returns Failed normalization result.
 */
function sourceScanOutputFailure(
  code: WorkspaceSearchMigrationSourceScanOutputFailureCode,
): WorkspaceSearchMigrationSourceScanOutputFailure {
  return {
    ok: false,
    code,
  }
}
