import type {
  DataMigrationCheckpoint,
  DataMigrationTransformDefinition,
  DataMigrationRow,
  DataMigrationRunRecord,
} from '../domain/data-migration'
import type {
  DataMigrationCheckpointStore,
  DataMigrationClock,
  DataMigrationRowStore,
} from '../application/ports/data-migration-ports'

/**
 * Example migration used by tests: `task` rows move from a text `estimate`
 * (v1) to a numeric `estimatePoints` (v2).
 *
 * @param overrides - Fields to replace.
 * @returns The definition.
 */
export function createTaskEstimateMigration(
  overrides: Partial<DataMigrationTransformDefinition> = {},
): DataMigrationTransformDefinition {
  return {
    id: '0001-task-estimate-points',
    description: 'Store task estimates as points.',
    table: 'work-items',
    keyAttributes: ['pk', 'sk'],
    versionAttribute: 'schemaVersion',
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    writerPolicy: 'pause-writers',
    classify: (row) => {
      if (row.entity !== 'task') return 'unrelated'
      if (row.schemaVersion === 1 && typeof row.estimate === 'string') return 'pending'
      if (row.schemaVersion === 2 && typeof row.estimatePoints === 'number' && !('estimate' in row)) {
        return 'migrated'
      }
      return 'unknown'
    },
    transform: (row) => {
      const { estimate, ...rest } = row
      return { ...rest, schemaVersion: 2, estimatePoints: Number(estimate) }
    },
    ...overrides,
  }
}

/**
 * Creates a v1 task row.
 *
 * @param index - Row number used in the key.
 * @returns The row.
 */
export function createPendingTaskRow(index: number): Record<string, unknown> {
  return { pk: 'TEAM#a', sk: `TASK#${String(index).padStart(3, '0')}`, entity: 'task', schemaVersion: 1, estimate: String(index) }
}

/** In-memory row store whose partitions are fixed row lists. */
export type MemoryRowStore = DataMigrationRowStore & {
  /** Rows by `pk|sk`. */
  readonly rows: Map<string, Record<string, unknown>>
  /** Number of replace calls. */
  replaceCalls: number
  /** Hook run before a replace is applied; returning `false` makes it fail its condition. */
  beforeReplace?: (row: Readonly<Record<string, unknown>>) => boolean
}

/**
 * Creates an in-memory row store. Each partition holds the keys given for it;
 * a cursor is the index of the next row.
 *
 * @param partitions - Rows per partition.
 * @param targetTable - Identity of the simulated table.
 * @returns The store.
 */
export function createMemoryRowStore(
  partitions: Record<string, Record<string, unknown>[]>,
  targetTable = 'work-items-table',
): MemoryRowStore {
  const rows = new Map<string, Record<string, unknown>>()
  const keysByPartition = new Map<string, string[]>()
  for (const [partitionId, partitionRows] of Object.entries(partitions)) {
    keysByPartition.set(partitionId, partitionRows.map((row) => {
      const key = `${String(row.pk)}|${String(row.sk)}`
      rows.set(key, { ...row })
      return key
    }))
  }
  const store: MemoryRowStore = {
    rows,
    replaceCalls: 0,
    targetTable,
    listPartitions: () => [...keysByPartition.keys()],
    readPage: async ({ partitionId, cursor, limit }) => {
      const keys = keysByPartition.get(partitionId) ?? []
      const start = cursor === undefined ? 0 : Number(cursor)
      const pageKeys = keys.slice(start, start + limit)
      const page: DataMigrationRow[] = pageKeys.flatMap((key) => {
        const row = rows.get(key)
        return row === undefined ? [] : [{ ...row }]
      })
      const next = start + limit
      return next < keys.length ? { rows: page, nextCursor: String(next) } : { rows: page }
    },
    getRow: async (key) => {
      const row = rows.get(`${String(key.pk)}|${String(key.sk)}`)
      return row === undefined ? undefined : { ...row }
    },
    replaceRow: async ({ definition, row, expectedRevision }) => {
      store.replaceCalls += 1
      if (store.beforeReplace !== undefined && !store.beforeReplace(row)) return 'condition-failed'
      const key = `${String(row.pk)}|${String(row.sk)}`
      const stored = rows.get(key)
      if (
        stored === undefined ||
        stored[definition.versionAttribute] !== definition.fromSchemaVersion ||
        (definition.revisionAttribute !== undefined && stored[definition.revisionAttribute] !== expectedRevision)
      ) {
        return 'condition-failed'
      }
      rows.set(key, { ...row })
      return 'replaced'
    },
    writeDerivedRows: async ({ definition, sourceKey, expectedRevision, rows: derivedRows }) => {
      store.replaceCalls += 1
      const sourceRowKey = `${String(sourceKey.pk)}|${String(sourceKey.sk)}`
      const before = rows.get(sourceRowKey)
      if (before === undefined) return 'condition-failed'
      if (store.beforeReplace !== undefined && !store.beforeReplace(before)) return 'condition-failed'
      // The hook may stand in for a concurrent writer, so check the source as it is now.
      const stored = rows.get(sourceRowKey)
      if (
        stored === undefined ||
        (definition.revisionAttribute !== undefined && stored[definition.revisionAttribute] !== expectedRevision)
      ) {
        return 'condition-failed'
      }
      for (const row of derivedRows) rows.set(`${String(row.pk)}|${String(row.sk)}`, { ...row })
      return 'replaced'
    },
  }
  return store
}

/** In-memory checkpoint store with compare-and-set. */
export type MemoryCheckpointStore = DataMigrationCheckpointStore & {
  /** Checkpoints by `migrationId|partitionId`. */
  readonly checkpoints: Map<string, DataMigrationCheckpoint>
  /** Run records by `runId`, latest version only. */
  readonly runs: Map<string, DataMigrationRunRecord>
  /** Every saved run record version, in order. */
  readonly runHistory: DataMigrationRunRecord[]
  /** Hook run before a run record is saved; throwing fails the save. */
  beforeSaveRun?: (record: DataMigrationRunRecord) => void
}

/**
 * Creates an in-memory checkpoint store.
 *
 * @returns The store.
 */
export function createMemoryCheckpointStore(): MemoryCheckpointStore {
  const checkpoints = new Map<string, DataMigrationCheckpoint>()
  const store: MemoryCheckpointStore = {
    checkpoints,
    runs: new Map(),
    runHistory: [],
    saveRun: async (record) => {
      store.beforeSaveRun?.(record)
      store.runs.set(record.runId, record)
      store.runHistory.push(record)
    },
    list: async (migrationId) =>
      [...checkpoints.values()].filter((checkpoint) => checkpoint.migrationId === migrationId),
    save: async (checkpoint, expectedRevision) => {
      const key = `${checkpoint.migrationId}|${checkpoint.partitionId}`
      const stored = checkpoints.get(key)
      if (stored?.revision !== expectedRevision) return false
      checkpoints.set(key, checkpoint)
      return true
    },
  }
  return store
}

/** Manual clock that records sleeps and advances on them. */
export type ManualClock = DataMigrationClock & {
  /** Sleeps requested, in milliseconds. */
  readonly sleeps: number[]
  /** Current epoch milliseconds. */
  current: number
}

/**
 * Creates a manual clock.
 *
 * @param start - Start time in epoch milliseconds.
 * @returns The clock.
 */
export function createManualClock(start = Date.parse('2026-11-20T00:00:00.000Z')): ManualClock {
  const clock: ManualClock = {
    current: start,
    sleeps: [],
    now: () => clock.current,
    sleep: async (milliseconds) => {
      clock.sleeps.push(milliseconds)
      clock.current += milliseconds
    },
  }
  return clock
}
