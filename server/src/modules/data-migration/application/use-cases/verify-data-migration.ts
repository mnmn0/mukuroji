import {
  assertValidDataMigrationDefinition,
  classifyDataMigrationRow,
  DATA_MIGRATION_MAX_PAGE_SIZE,
  DataMigrationFailure,
  type DataMigrationDefinition,
  type DataMigrationFailureCode,
} from '../../domain/data-migration'
import type {
  DataMigrationCheckpointStore,
  DataMigrationClock,
  DataMigrationRowStore,
} from '../ports/data-migration-ports'
import { assertCheckpointMatches } from './run-data-migration'

/** Input of a read-only completion check. */
export type VerifyDataMigrationInput = {
  /** Migration to verify. */
  readonly definition: DataMigrationDefinition
  /** Target table rows; only read. */
  readonly rowStore: DataMigrationRowStore
  /** Durable checkpoints; only read. */
  readonly checkpointStore: DataMigrationCheckpointStore
  /** Rows per page, 1 to {@link DATA_MIGRATION_MAX_PAGE_SIZE}. */
  readonly pageSize: number
  /** Page budget; the result is `incomplete` when it runs out. */
  readonly maxPages: number
  /**
   * Epoch milliseconds after which no new page is read; the result is then
   * `incomplete`. Requires `clock`.
   */
  readonly deadline?: number
  /** Time source for `deadline`. */
  readonly clock?: Pick<DataMigrationClock, 'now'>
}

/** Content-free evidence of a completion check. */
export type DataMigrationVerificationReport = {
  /** Migration identifier. */
  readonly migrationId: string
  /** Logical table name from the definition. */
  readonly table: string
  /** Schema version the migration writes. */
  readonly toSchemaVersion: number
  /**
   * `pass` when every partition checkpoint is completed and a full read finds
   * no pending or unknown row; `incomplete` when the page budget or the
   * deadline ran out.
   */
  readonly status: 'pass' | 'fail' | 'incomplete'
  /** Stable failure code when the check could not run. */
  readonly failureCode?: DataMigrationFailureCode
  /** Upstream error class name for `UPSTREAM_FAILURE`, when known. */
  readonly failureDetail?: string
  /** Partitions in the plan. */
  readonly partitions: number
  /** Partitions whose checkpoint is completed. */
  readonly completedPartitions: number
  /** Rows read. */
  readonly scanned: number
  /** Rows still at `fromSchemaVersion`. */
  readonly pendingRows: number
  /** Rows at `toSchemaVersion`. */
  readonly migratedRows: number
  /** Rows of other entities. */
  readonly unrelatedRows: number
  /** Rows the definition cannot classify. */
  readonly unknownRows: number
}

/**
 * Reads every partition and the checkpoints to decide whether a migration is
 * complete. It never writes.
 *
 * @param input - Definition, ports and bounds.
 * @returns Content-free evidence of the check.
 */
export async function verifyDataMigration(
  input: VerifyDataMigrationInput,
): Promise<DataMigrationVerificationReport> {
  const counts = { scanned: 0, pendingRows: 0, migratedRows: 0, unrelatedRows: 0, unknownRows: 0 }
  let partitions = 0
  let completedPartitions = 0
  let pagesRead = 0
  let exhausted = true
  const base = {
    migrationId: input.definition.id,
    table: input.definition.table,
    toSchemaVersion: input.definition.toSchemaVersion,
  }
  try {
    assertValidDataMigrationDefinition(input.definition)
    if (
      !Number.isSafeInteger(input.pageSize) ||
      input.pageSize < 1 ||
      input.pageSize > DATA_MIGRATION_MAX_PAGE_SIZE ||
      !Number.isSafeInteger(input.maxPages) ||
      input.maxPages < 1 ||
      (input.deadline !== undefined && (!Number.isFinite(input.deadline) || input.clock === undefined))
    ) {
      throw new DataMigrationFailure('DEFINITION_INVALID')
    }
    const partitionIds = input.rowStore.listPartitions()
    partitions = partitionIds.length
    for (const checkpoint of await input.checkpointStore.list(input.definition.id)) {
      assertCheckpointMatches(input.definition, input.rowStore.targetTable, partitionIds, checkpoint)
      if (checkpoint.status === 'completed') completedPartitions += 1
    }
    for (const partitionId of partitionIds) {
      let cursor: string | undefined
      do {
        if (pagesRead >= input.maxPages || deadlinePassed(input)) {
          exhausted = false
          break
        }
        const page = await input.rowStore.readPage({
          partitionId,
          ...(cursor === undefined ? {} : { cursor }),
          limit: input.pageSize,
        })
        pagesRead += 1
        if (page.nextCursor !== undefined && page.nextCursor === cursor) {
          throw new DataMigrationFailure('CURSOR_REPEATED')
        }
        for (const row of page.rows) {
          counts.scanned += 1
          const rowClass = classifyDataMigrationRow(input.definition, row)
          if (rowClass === 'pending') counts.pendingRows += 1
          else if (rowClass === 'migrated') counts.migratedRows += 1
          else if (rowClass === 'unrelated') counts.unrelatedRows += 1
          else counts.unknownRows += 1
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)
      if (!exhausted) break
    }
  } catch (error: unknown) {
    return {
      ...base,
      status: 'fail',
      failureCode: error instanceof DataMigrationFailure ? error.code : 'UPSTREAM_FAILURE',
      ...(error instanceof DataMigrationFailure && error.detail !== undefined ? { failureDetail: error.detail } : {}),
      partitions,
      completedPartitions,
      ...counts,
    }
  }
  const passed = completedPartitions === partitions &&
    counts.pendingRows === 0 &&
    counts.unknownRows === 0
  return {
    ...base,
    status: !exhausted ? 'incomplete' : passed ? 'pass' : 'fail',
    partitions,
    completedPartitions,
    ...counts,
  }
}

/**
 * Tells whether the verification deadline, when given, has passed.
 *
 * @param input - Verification input.
 * @returns Whether no new page may be read.
 */
function deadlinePassed(input: VerifyDataMigrationInput): boolean {
  if (input.deadline === undefined || input.clock === undefined) return false
  return input.clock.now() >= input.deadline
}
