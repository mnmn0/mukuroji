import type {
  DataMigrationCheckpoint,
  DataMigrationDefinition,
  DataMigrationRow,
  DataMigrationRunRecord,
} from '../../domain/data-migration'

/** One bounded page of rows from one partition. */
export type DataMigrationRowPage = {
  /** Rows in store order. */
  readonly rows: readonly DataMigrationRow[]
  /** Opaque cursor for the next page; absent when the partition is exhausted. */
  readonly nextCursor?: string
}

/** Outcome of a conditional row replacement. */
export type DataMigrationReplaceOutcome = 'replaced' | 'condition-failed'

/**
 * Reads and conditionally replaces rows of the migration's target table.
 *
 * Adapters classify SDK errors as `DataMigrationFailure('UPSTREAM_FAILURE')`
 * and never expose raw keys or rows in error messages.
 */
export type DataMigrationRowStore = {
  /** Identity of the physical table, stored with every checkpoint and run record. */
  readonly targetTable: string
  /**
   * Partition identifiers of the read plan, in a stable order.
   *
   * @returns Partition identifiers.
   */
  readonly listPartitions: () => readonly string[]
  /**
   * Reads one strongly consistent page of a partition.
   *
   * @param request - Partition, cursor and page size.
   * @returns The page.
   */
  readonly readPage: (request: {
    /** Partition to read. */
    readonly partitionId: string
    /** Cursor returned by the previous page, or absent for the first page. */
    readonly cursor?: string
    /** Maximum rows to read. */
    readonly limit: number
  }) => Promise<DataMigrationRowPage>
  /**
   * Reads one row by key with a strongly consistent read.
   *
   * @param key - Primary key attributes.
   * @returns The row, or `undefined` when it does not exist.
   */
  readonly getRow: (key: Readonly<Record<string, string | number>>) => Promise<DataMigrationRow | undefined>
  /**
   * Replaces a row only when it still has the version (and revision, when
   * fenced) that the runner read.
   *
   * @param request - Replacement row and the expected stored values.
   * @returns Whether the row was replaced.
   */
  readonly replaceRow: (request: {
    /** Definition naming the key, version and revision attributes. */
    readonly definition: DataMigrationDefinition
    /** Complete replacement row. */
    readonly row: Readonly<Record<string, unknown>>
    /** Revision value read from the stored row, for `revision-fenced` definitions. */
    readonly expectedRevision?: unknown
  }) => Promise<DataMigrationReplaceOutcome>
  /**
   * Writes the derived rows of a source row in one transaction that also
   * checks the source row still exists with the revision (when fenced) that
   * the runner read. Derived rows overwrite rows with the same key.
   *
   * @param request - Source key, expected revision and derived rows.
   * @returns Whether the rows were written.
   */
  readonly writeDerivedRows: (request: {
    /** `derive` definition naming the key and revision attributes. */
    readonly definition: DataMigrationDefinition
    /** Primary key of the source row. */
    readonly sourceKey: Readonly<Record<string, string | number>>
    /** Revision value read from the source row, for `revision-fenced` definitions. */
    readonly expectedRevision?: unknown
    /** Complete derived rows. */
    readonly rows: readonly Readonly<Record<string, unknown>>[]
  }) => Promise<DataMigrationReplaceOutcome>
}

/** Durable, compare-and-set store of per-partition checkpoints. */
export type DataMigrationCheckpointStore = {
  /**
   * Lists every checkpoint of a migration.
   *
   * @param migrationId - Migration identifier.
   * @returns Checkpoints in any order.
   */
  readonly list: (migrationId: string) => Promise<readonly DataMigrationCheckpoint[]>
  /**
   * Writes a checkpoint when the stored revision matches.
   *
   * @param checkpoint - Checkpoint to store; its `revision` is the new revision.
   * @param expectedRevision - Stored revision, or `undefined` when the checkpoint must not exist yet.
   * @returns Whether the write was applied.
   */
  readonly save: (
    checkpoint: DataMigrationCheckpoint,
    expectedRevision: number | undefined,
  ) => Promise<boolean>
  /**
   * Writes the durable record of an applying run, replacing the earlier
   * version of the same run.
   *
   * @param record - Run record.
   */
  readonly saveRun: (record: DataMigrationRunRecord) => Promise<void>
}

/** Time source and delay used for leases and the write rate budget. */
export type DataMigrationClock = {
  /**
   * Returns the current time in epoch milliseconds.
   *
   * @returns Current time.
   */
  readonly now: () => number
  /**
   * Waits for a duration.
   *
   * @param milliseconds - Delay length.
   */
  readonly sleep: (milliseconds: number) => Promise<void>
}

/** Request to authenticate the operator of an applying invocation. */
export type DataMigrationOperatorProofRequest = {
  /** Operator-supplied identity proof; untrusted until verified. */
  readonly proof: string
  /** Digest of the invocation parameters the proof must be bound to. */
  readonly binding: string
  /** AWS account the operator must belong to. */
  readonly accountId: string
}

/**
 * Authenticates the operator of an applying invocation from an identity
 * proof, such as a presigned STS `GetCallerIdentity` request.
 *
 * @param request - Proof, expected binding and account.
 * @returns The authenticated principal ARN.
 * @throws When the proof is malformed, unbound, expired or from another account.
 */
export type DataMigrationOperatorVerifier = (request: DataMigrationOperatorProofRequest) => Promise<string>
