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
import {
  cloneWorkspaceSearchMigrationExactTableKey,
  cloneWorkspaceSearchMigrationExactTableKeyFromItem,
} from './migration-source-scan-context'
import type {
  WorkspaceSearchMigrationTargetScanContextInput,
} from './migration-target-scan-context'
import type {
  WorkspaceSearchMigrationTargetScanPage,
} from './migration-target-scan-page'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/**
 * Measured context required by the managed AWS session for one target Scan.
 */
export type WorkspaceSearchMigrationTargetScanReadInput =
  WorkspaceSearchMigrationTargetScanContextInput

/**
 * Narrow AWS transport containing only the target Scan data-plane read.
 */
export interface WorkspaceSearchMigrationTargetScanAwsTransport {
  /**
   * Sends one exact unfiltered base-table Scan command.
   *
   * @param command - Adapter-owned read-only command.
   * @returns Raw low-level DynamoDB page.
   */
  scanTarget(command: ScanCommand): Promise<ScanCommandOutput>
}

/**
 * Failure codes emitted while normalizing one untrusted target Scan response.
 */
export type WorkspaceSearchMigrationTargetScanOutputFailureCode =
  | 'INVALID_STATE'
  | 'TABLE_SCHEMA_MISMATCH'

/**
 * Successful target Scan output normalization.
 */
type WorkspaceSearchMigrationTargetScanOutputSuccess = {
  /** Successful-result discriminator. */
  readonly ok: true
  /** Detached full-item page. */
  readonly page: WorkspaceSearchMigrationTargetScanPage
}

/**
 * Failed target Scan output normalization.
 */
type WorkspaceSearchMigrationTargetScanOutputFailure = {
  /** Failed-result discriminator. */
  readonly ok: false
  /** Stable raw-value-free failure code. */
  readonly code: WorkspaceSearchMigrationTargetScanOutputFailureCode
}

/**
 * Result of normalizing one low-level DynamoDB target Scan response.
 */
export type WorkspaceSearchMigrationTargetScanOutputResult =
  | WorkspaceSearchMigrationTargetScanOutputFailure
  | WorkspaceSearchMigrationTargetScanOutputSuccess

/**
 * Validates and detaches one low-level DynamoDB target Scan response.
 *
 * This helper performs no I/O and grants no target-read authority. The managed
 * AWS session owns command construction, identity binding, and lifecycle checks.
 *
 * @param output - Arbitrary SDK response page.
 * @param table - Exact measured Workspace Search target table identity.
 * @returns Detached page or a fixed raw-value-free failure code.
 */
export function normalizeWorkspaceSearchMigrationTargetScanOutput(
  output: ScanCommandOutput,
  table: MigrationTableIdentity,
): WorkspaceSearchMigrationTargetScanOutputResult {
  try {
    return normalizeTargetScanOutputUnchecked(output, table)
  } catch {
    return targetScanOutputFailure('INVALID_STATE')
  }
}

/**
 * Normalizes one response after entering the raw-error replacement boundary.
 *
 * @param output - Arbitrary SDK response page.
 * @param table - Exact measured Workspace Search target table identity.
 * @returns Detached page or a deliberate validation failure.
 */
function normalizeTargetScanOutputUnchecked(
  output: ScanCommandOutput,
  table: MigrationTableIdentity,
): WorkspaceSearchMigrationTargetScanOutputResult {
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
    return targetScanOutputFailure('INVALID_STATE')
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
      return targetScanOutputFailure('INVALID_STATE')
    }
    items.push(cloneAttributeMap(item))
  }
  if (
    outputItems.length !== itemCount ||
    !hasCanonicalDenseArrayShape(outputItems)
  ) {
    return targetScanOutputFailure('INVALID_STATE')
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
  if (!cursorResult.ok) return targetScanOutputFailure(cursorResult.code)
  // This managed Scan has no filter or projection, so a continuation key must
  // identify the final full item counted and returned by the same response.
  const lastItem = items[itemCount - 1]
  if (lastItem === undefined) {
    return targetScanOutputFailure('INVALID_STATE')
  }
  const lastItemKeyResult =
    cloneWorkspaceSearchMigrationExactTableKeyFromItem(lastItem, table)
  if (!lastItemKeyResult.ok) {
    return targetScanOutputFailure(lastItemKeyResult.code)
  }
  if (
    serializeCanonicalAttributeMap(cursorResult.key) !==
      serializeCanonicalAttributeMap(lastItemKeyResult.key)
  ) {
    return targetScanOutputFailure('INVALID_STATE')
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
 * @param value - SDK-owned target item.
 * @returns Detached canonical low-level map.
 */
function cloneAttributeMap(value: unknown): DynamoAttributeMap {
  return decodeAttributeMap(encodeUnknownAttributeMap(value))
}

/**
 * Creates one failed target response-normalization result.
 *
 * @param code - Stable raw-value-free failure code.
 * @returns Failed normalization result.
 */
function targetScanOutputFailure(
  code: WorkspaceSearchMigrationTargetScanOutputFailureCode,
): WorkspaceSearchMigrationTargetScanOutputFailure {
  return {
    ok: false,
    code,
  }
}
