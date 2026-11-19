import {
  addDataMigrationCounters,
  assertValidDataMigrationDefinition,
  classifyDataMigrationRow,
  createEmptyDataMigrationCounters,
  DATA_MIGRATION_MAX_PAGE_SIZE,
  DataMigrationFailure,
  extractDataMigrationRowKey,
  transformDataMigrationRow,
  type DataMigrationCheckpoint,
  type DataMigrationCounters,
  type DataMigrationDefinition,
  type DataMigrationFailureCode,
  type DataMigrationRow,
} from '../../domain/data-migration'
import type {
  DataMigrationCheckpointStore,
  DataMigrationClock,
  DataMigrationRowStore,
} from '../ports/data-migration-ports'

/** Default lease length; a page must finish well within it. */
const DEFAULT_LEASE_MILLISECONDS = 5 * 60 * 1000

/** Attempts to replace one row before reporting a write conflict. */
const MAX_REPLACE_ATTEMPTS = 3

/** Input of one bounded migration run. */
export type RunDataMigrationInput = {
  /** Migration to run. */
  readonly definition: DataMigrationDefinition
  /** Target table rows. */
  readonly rowStore: DataMigrationRowStore
  /** Durable checkpoints; unused in `dry-run`. */
  readonly checkpointStore: DataMigrationCheckpointStore
  /** Time source and delay. */
  readonly clock: DataMigrationClock
  /** Unique identifier of this run; used as the lease owner. */
  readonly runId: string
  /** `apply` writes rows and checkpoints; `dry-run` reads from the start and writes nothing. */
  readonly mode: 'apply' | 'dry-run'
  /** Rows per page, 1 to {@link DATA_MIGRATION_MAX_PAGE_SIZE}. */
  readonly pageSize: number
  /** Page budget of this run; the run pauses when it is spent. */
  readonly maxPages: number
  /** Upper bound on row replacements per second. */
  readonly maxWritesPerSecond: number
  /** Lease length in milliseconds; defaults to five minutes. */
  readonly leaseMilliseconds?: number
}

/** Result of one partition within one run. */
export type DataMigrationPartitionReport = {
  /** Partition identifier. */
  readonly partitionId: string
  /** Partition state after the run. */
  readonly status: 'completed' | 'in-progress' | 'not-started'
  /** Counts from this run only. */
  readonly counters: DataMigrationCounters
}

/** Content-free evidence of one run; it holds no keys, rows or table names. */
export type DataMigrationRunReport = {
  /** Migration identifier. */
  readonly migrationId: string
  /** Logical table name from the definition. */
  readonly table: string
  /** Schema version read. */
  readonly fromSchemaVersion: number
  /** Schema version written. */
  readonly toSchemaVersion: number
  /** Run mode. */
  readonly mode: 'apply' | 'dry-run'
  /** Run identifier. */
  readonly runId: string
  /** `completed` when every partition is done, `paused` when the page budget ran out. */
  readonly status: 'completed' | 'paused' | 'failed'
  /** Stable failure code when `status` is `failed`. */
  readonly failureCode?: DataMigrationFailureCode
  /** Upstream error class name for `UPSTREAM_FAILURE`, when known. */
  readonly failureDetail?: string
  /** Pages read by this run. */
  readonly pagesRead: number
  /** Counts from this run across partitions; in `dry-run`, `migrated` counts rows that would be replaced. */
  readonly counters: DataMigrationCounters
  /** Per-partition results in plan order. */
  readonly partitions: readonly DataMigrationPartitionReport[]
  /** ISO start time. */
  readonly startedAt: string
  /** ISO finish time. */
  readonly finishedAt: string
}

/** Mutable state shared by the partitions of one run. */
type RunState = {
  /** Pages read so far. */
  pagesRead: number
  /** Epoch milliseconds before which the next write must wait. */
  nextWriteAt: number
  /** Partition results collected so far. */
  partitions: DataMigrationPartitionReport[]
}

/**
 * Runs one bounded slice of a migration. Re-running with the same definition
 * resumes from the stored checkpoints; a partially applied page is safe to
 * repeat because migrated rows classify as `migrated`.
 *
 * @param input - Definition, ports and bounds.
 * @returns Content-free evidence of the run.
 */
export async function runDataMigration(input: RunDataMigrationInput): Promise<DataMigrationRunReport> {
  const startedAt = new Date(input.clock.now()).toISOString()
  const state: RunState = { pagesRead: 0, nextWriteAt: 0, partitions: [] }
  let status: DataMigrationRunReport['status'] = 'completed'
  let failureCode: DataMigrationFailureCode | undefined
  let failureDetail: string | undefined
  try {
    assertRunInput(input)
    const partitionIds = input.rowStore.listPartitions()
    const checkpoints = input.mode === 'apply'
      ? await loadCheckpoints(input, partitionIds)
      : new Map<string, DataMigrationCheckpoint>()
    for (const partitionId of partitionIds) {
      if (state.pagesRead >= input.maxPages) {
        status = 'paused'
        state.partitions.push(notStartedReport(partitionId, checkpoints.get(partitionId)))
        continue
      }
      const partitionStatus = input.mode === 'apply'
        ? await applyPartition(input, state, partitionId, partitionIds.length, checkpoints.get(partitionId))
        : await dryRunPartition(input, state, partitionId)
      if (partitionStatus !== 'completed') status = 'paused'
    }
  } catch (error: unknown) {
    status = 'failed'
    failureCode = error instanceof DataMigrationFailure ? error.code : 'UPSTREAM_FAILURE'
    failureDetail = error instanceof DataMigrationFailure ? error.detail : undefined
  }
  const counters = state.partitions.reduce(
    (total, partition) => addDataMigrationCounters(total, partition.counters),
    createEmptyDataMigrationCounters(),
  )
  return {
    migrationId: input.definition.id,
    table: input.definition.table,
    fromSchemaVersion: input.definition.fromSchemaVersion,
    toSchemaVersion: input.definition.toSchemaVersion,
    mode: input.mode,
    runId: input.runId,
    status,
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureDetail === undefined ? {} : { failureDetail }),
    pagesRead: state.pagesRead,
    counters,
    partitions: state.partitions,
    startedAt,
    finishedAt: new Date(input.clock.now()).toISOString(),
  }
}

/**
 * Validates the definition and the run bounds.
 *
 * @param input - Run input.
 */
function assertRunInput(input: RunDataMigrationInput): void {
  assertValidDataMigrationDefinition(input.definition)
  const lease = input.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS
  const valid = input.runId.length > 0 &&
    Number.isSafeInteger(input.pageSize) &&
    input.pageSize >= 1 &&
    input.pageSize <= DATA_MIGRATION_MAX_PAGE_SIZE &&
    Number.isSafeInteger(input.maxPages) &&
    input.maxPages >= 1 &&
    Number.isFinite(input.maxWritesPerSecond) &&
    input.maxWritesPerSecond > 0 &&
    Number.isSafeInteger(lease) &&
    lease > 0
  if (!valid) throw new DataMigrationFailure('DEFINITION_INVALID')
}

/**
 * Loads checkpoints and checks that they belong to the same plan and versions.
 *
 * @param input - Run input.
 * @param partitionIds - Current partition plan.
 * @returns Checkpoints by partition identifier.
 */
async function loadCheckpoints(
  input: RunDataMigrationInput,
  partitionIds: readonly string[],
): Promise<Map<string, DataMigrationCheckpoint>> {
  const stored = await input.checkpointStore.list(input.definition.id)
  const checkpoints = new Map<string, DataMigrationCheckpoint>()
  for (const checkpoint of stored) {
    assertCheckpointMatches(input.definition, partitionIds, checkpoint)
    checkpoints.set(checkpoint.partitionId, checkpoint)
  }
  return checkpoints
}

/**
 * Checks that a stored checkpoint was written for the same definition and plan.
 *
 * @param definition - Migration definition.
 * @param partitionIds - Current partition plan.
 * @param checkpoint - Stored checkpoint.
 */
export function assertCheckpointMatches(
  definition: DataMigrationDefinition,
  partitionIds: readonly string[],
  checkpoint: DataMigrationCheckpoint,
): void {
  if (
    checkpoint.migrationId !== definition.id ||
    checkpoint.fromSchemaVersion !== definition.fromSchemaVersion ||
    checkpoint.toSchemaVersion !== definition.toSchemaVersion
  ) {
    throw new DataMigrationFailure('DEFINITION_MISMATCH')
  }
  if (checkpoint.partitionCount !== partitionIds.length || !partitionIds.includes(checkpoint.partitionId)) {
    throw new DataMigrationFailure('PARTITION_PLAN_MISMATCH')
  }
}

/**
 * Builds the report of a partition the run did not reach.
 *
 * @param partitionId - Partition identifier.
 * @param checkpoint - Stored checkpoint, if any.
 * @returns A report with zero counts.
 */
function notStartedReport(
  partitionId: string,
  checkpoint: DataMigrationCheckpoint | undefined,
): DataMigrationPartitionReport {
  return {
    partitionId,
    status: checkpoint?.status ?? 'not-started',
    counters: createEmptyDataMigrationCounters(),
  }
}

/**
 * Applies the migration to one partition until it is exhausted or the page
 * budget runs out, saving a checkpoint after every page.
 *
 * @param input - Run input.
 * @param state - Shared run state.
 * @param partitionId - Partition to process.
 * @param partitionCount - Number of partitions in the plan.
 * @param stored - Stored checkpoint, if any.
 * @returns The partition state after the run.
 */
async function applyPartition(
  input: RunDataMigrationInput,
  state: RunState,
  partitionId: string,
  partitionCount: number,
  stored: DataMigrationCheckpoint | undefined,
): Promise<DataMigrationPartitionReport['status']> {
  if (stored?.status === 'completed') {
    state.partitions.push(notStartedReport(partitionId, stored))
    return 'completed'
  }
  const leaseMilliseconds = input.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS
  const now = input.clock.now()
  if (
    stored?.leaseOwner !== undefined &&
    stored.leaseOwner !== input.runId &&
    stored.leaseExpiresAt !== undefined &&
    Date.parse(stored.leaseExpiresAt) > now
  ) {
    throw new DataMigrationFailure('LEASE_HELD')
  }
  let current = await saveCheckpoint(input, stored, {
    migrationId: input.definition.id,
    partitionId,
    partitionCount,
    fromSchemaVersion: input.definition.fromSchemaVersion,
    toSchemaVersion: input.definition.toSchemaVersion,
    status: 'in-progress',
    ...(stored?.cursor === undefined ? {} : { cursor: stored.cursor }),
    counters: stored?.counters ?? createEmptyDataMigrationCounters(),
    leaseOwner: input.runId,
    leaseExpiresAt: new Date(now + leaseMilliseconds).toISOString(),
  })
  let runCounters = createEmptyDataMigrationCounters()
  const report = (): DataMigrationPartitionReport => ({
    partitionId,
    status: current.status,
    counters: runCounters,
  })
  try {
    while (state.pagesRead < input.maxPages) {
      const page = await input.rowStore.readPage({
        partitionId,
        ...(current.cursor === undefined ? {} : { cursor: current.cursor }),
        limit: input.pageSize,
      })
      state.pagesRead += 1
      if (page.nextCursor !== undefined && page.nextCursor === current.cursor) {
        throw new DataMigrationFailure('CURSOR_REPEATED')
      }
      const pageCounters = await applyRows(input, state, page.rows)
      runCounters = addDataMigrationCounters(runCounters, pageCounters)
      const completed = page.nextCursor === undefined
      current = await saveCheckpoint(input, current, {
        ...withoutLeaseAndCursor(current),
        status: completed ? 'completed' : 'in-progress',
        ...(page.nextCursor === undefined ? {} : { cursor: page.nextCursor }),
        counters: addDataMigrationCounters(current.counters, pageCounters),
        ...(completed
          ? {}
          : {
              leaseOwner: input.runId,
              leaseExpiresAt: new Date(input.clock.now() + leaseMilliseconds).toISOString(),
            }),
      })
      if (completed) break
    }
  } catch (error: unknown) {
    state.partitions.push(report())
    await releaseLease(input, current)
    throw error
  }
  state.partitions.push(report())
  if (current.status === 'completed') return 'completed'
  await releaseLease(input, current)
  return 'in-progress'
}

/**
 * Releases a lease held by this run, ignoring a lost compare-and-set because
 * the lease then already belongs to someone else.
 *
 * @param input - Run input.
 * @param current - Checkpoint as last saved by this run.
 */
async function releaseLease(input: RunDataMigrationInput, current: DataMigrationCheckpoint): Promise<void> {
  if (current.leaseOwner !== input.runId) return
  try {
    await saveCheckpoint(input, current, {
      ...withoutLeaseAndCursor(current),
      ...(current.cursor === undefined ? {} : { cursor: current.cursor }),
    })
  } catch {
    // The lease expires on its own; the original outcome is reported instead.
  }
}

/**
 * Copies a checkpoint without the fields that a save sets explicitly.
 *
 * @param checkpoint - Checkpoint to copy.
 * @returns The checkpoint without lease, cursor, revision and update time.
 */
function withoutLeaseAndCursor(
  checkpoint: DataMigrationCheckpoint,
): Omit<DataMigrationCheckpoint, 'revision' | 'updatedAt' | 'leaseOwner' | 'leaseExpiresAt' | 'cursor'> {
  return {
    migrationId: checkpoint.migrationId,
    partitionId: checkpoint.partitionId,
    partitionCount: checkpoint.partitionCount,
    fromSchemaVersion: checkpoint.fromSchemaVersion,
    toSchemaVersion: checkpoint.toSchemaVersion,
    status: checkpoint.status,
    counters: checkpoint.counters,
  }
}

/**
 * Saves the next checkpoint revision with compare-and-set.
 *
 * @param input - Run input.
 * @param previous - Checkpoint the save replaces, if any.
 * @param next - Checkpoint fields without revision and update time.
 * @returns The saved checkpoint.
 */
async function saveCheckpoint(
  input: RunDataMigrationInput,
  previous: DataMigrationCheckpoint | undefined,
  next: Omit<DataMigrationCheckpoint, 'revision' | 'updatedAt'>,
): Promise<DataMigrationCheckpoint> {
  const checkpoint: DataMigrationCheckpoint = {
    ...next,
    revision: (previous?.revision ?? 0) + 1,
    updatedAt: new Date(input.clock.now()).toISOString(),
  }
  const saved = await input.checkpointStore.save(checkpoint, previous?.revision)
  if (!saved) throw new DataMigrationFailure('CHECKPOINT_CONFLICT')
  return checkpoint
}

/**
 * Classifies a page and replaces its pending rows. The whole page is
 * classified before any write so an unknown row stops the run without a
 * partial page.
 *
 * @param input - Run input.
 * @param state - Shared run state.
 * @param rows - Page rows.
 * @returns Counts for the page.
 */
async function applyRows(
  input: RunDataMigrationInput,
  state: RunState,
  rows: readonly DataMigrationRow[],
): Promise<DataMigrationCounters> {
  const classes = classifyPage(input.definition, rows)
  const counters = createEmptyDataMigrationCounters()
  counters.scanned = rows.length
  for (const [index, row] of rows.entries()) {
    const rowClass = classes[index]
    if (rowClass === 'unrelated') counters.unrelated += 1
    else if (rowClass === 'migrated') counters.alreadyMigrated += 1
    else counters[await replacePendingRow(input, state, row)] += 1
  }
  return counters
}

/**
 * Classifies every row of a page and rejects unknown rows.
 *
 * @param definition - Migration definition.
 * @param rows - Page rows.
 * @returns Row classes in page order.
 */
function classifyPage(
  definition: DataMigrationDefinition,
  rows: readonly DataMigrationRow[],
): ('pending' | 'migrated' | 'unrelated')[] {
  return rows.map((row) => {
    const rowClass = classifyDataMigrationRow(definition, row)
    if (rowClass === 'unknown') throw new DataMigrationFailure('UNKNOWN_ROW')
    if (rowClass === 'pending') extractDataMigrationRowKey(definition, row)
    return rowClass
  })
}

/**
 * Replaces one pending row, re-reading it after a lost condition.
 *
 * @param input - Run input.
 * @param state - Shared run state.
 * @param pending - Row classified as `pending`.
 * @returns The counter the row adds to.
 */
async function replacePendingRow(
  input: RunDataMigrationInput,
  state: RunState,
  pending: DataMigrationRow,
): Promise<'migrated' | 'alreadyMigrated' | 'vanished'> {
  const { definition } = input
  const key = extractDataMigrationRowKey(definition, pending)
  let row = pending
  for (let attempt = 0; attempt < MAX_REPLACE_ATTEMPTS; attempt += 1) {
    const next = transformDataMigrationRow(definition, row)
    await acquireWrite(input, state)
    const outcome = await input.rowStore.replaceRow({
      definition,
      row: next,
      ...(definition.revisionAttribute === undefined
        ? {}
        : { expectedRevision: row[definition.revisionAttribute] }),
    })
    if (outcome === 'replaced') return 'migrated'
    const fresh = await input.rowStore.getRow(key)
    if (fresh === undefined) return 'vanished'
    const freshClass = classifyDataMigrationRow(definition, fresh)
    if (freshClass === 'migrated') return 'alreadyMigrated'
    if (freshClass !== 'pending') throw new DataMigrationFailure('UNKNOWN_ROW')
    row = fresh
  }
  throw new DataMigrationFailure('WRITE_CONFLICT')
}

/**
 * Waits until the write rate budget allows the next replacement.
 *
 * @param input - Run input.
 * @param state - Shared run state.
 */
async function acquireWrite(input: RunDataMigrationInput, state: RunState): Promise<void> {
  const interval = 1000 / input.maxWritesPerSecond
  const now = input.clock.now()
  if (state.nextWriteAt > now) await input.clock.sleep(state.nextWriteAt - now)
  state.nextWriteAt = Math.max(now, state.nextWriteAt) + interval
}

/**
 * Reads one partition from the start without writing, validating every
 * transform.
 *
 * @param input - Run input.
 * @param state - Shared run state.
 * @param partitionId - Partition to read.
 * @returns The partition state: `completed` when every page was read.
 */
async function dryRunPartition(
  input: RunDataMigrationInput,
  state: RunState,
  partitionId: string,
): Promise<DataMigrationPartitionReport['status']> {
  let counters = createEmptyDataMigrationCounters()
  let cursor: string | undefined
  let status: DataMigrationPartitionReport['status'] = 'in-progress'
  try {
    while (state.pagesRead < input.maxPages) {
      const page = await input.rowStore.readPage({
        partitionId,
        ...(cursor === undefined ? {} : { cursor }),
        limit: input.pageSize,
      })
      state.pagesRead += 1
      if (page.nextCursor !== undefined && page.nextCursor === cursor) {
        throw new DataMigrationFailure('CURSOR_REPEATED')
      }
      const classes = classifyPage(input.definition, page.rows)
      const pageCounters = createEmptyDataMigrationCounters()
      pageCounters.scanned = page.rows.length
      for (const [index, row] of page.rows.entries()) {
        const rowClass = classes[index]
        if (rowClass === 'unrelated') pageCounters.unrelated += 1
        else if (rowClass === 'migrated') pageCounters.alreadyMigrated += 1
        else {
          transformDataMigrationRow(input.definition, row)
          pageCounters.migrated += 1
        }
      }
      counters = addDataMigrationCounters(counters, pageCounters)
      cursor = page.nextCursor
      if (cursor === undefined) {
        status = 'completed'
        break
      }
    }
  } finally {
    state.partitions.push({ partitionId, status, counters })
  }
  return status
}
