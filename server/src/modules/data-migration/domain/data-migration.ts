/**
 * Pure contract for versioned, resumable row migrations.
 *
 * A migration moves rows of one table from one stored schema version to the
 * next. The contract is documented in `docs/data-migration.md`.
 */

/** Pattern for a migration identifier: a four-digit sequence and a kebab-case name. */
const MIGRATION_ID_PATTERN = /^[0-9]{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Pattern for a DynamoDB attribute name a definition may reference. */
const ATTRIBUTE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u

/** Upper bound on rows read in one page, matching the bounded-page rule. */
export const DATA_MIGRATION_MAX_PAGE_SIZE = 100

/** One stored row, as read from the table. */
export type DataMigrationRow = Readonly<Record<string, unknown>>

/**
 * How a definition sees one stored row.
 *
 * - `pending`: the row is at `fromSchemaVersion` and must be transformed.
 * - `migrated`: the row is already at `toSchemaVersion`.
 * - `unrelated`: the row is another entity in the same table.
 * - `unknown`: the row claims to be the target entity but matches neither version.
 *   The runner stops on it instead of skipping it.
 */
export type DataMigrationRowClass = 'pending' | 'migrated' | 'unrelated' | 'unknown'

/**
 * How live writers relate to the migration.
 *
 * - `pause-writers`: every writer of the target entity is stopped while the migration runs.
 * - `revision-fenced`: writers keep running; every row carries a revision that each writer
 *   advances, and the migration only replaces a row whose revision it read.
 */
export type DataMigrationWriterPolicy = 'pause-writers' | 'revision-fenced'

/** A versioned, idempotent transformation of one table's rows. */
export type DataMigrationDefinition = {
  /** Stable identifier such as `0001-work-item-estimate`; also the checkpoint partition. */
  readonly id: string
  /** One-line purpose shown by the CLI. */
  readonly description: string
  /** Logical table the migration targets, such as `work-items`; never a physical table name. */
  readonly table: string
  /** Primary key attribute names of the table; the transform must keep their values. */
  readonly keyAttributes: readonly string[]
  /** Attribute that stores the schema version of the target entity. */
  readonly versionAttribute: string
  /** Schema version rows are migrated from. */
  readonly fromSchemaVersion: number
  /** Schema version rows are migrated to; exactly `fromSchemaVersion + 1`. */
  readonly toSchemaVersion: number
  /** How live writers relate to this migration. */
  readonly writerPolicy: DataMigrationWriterPolicy
  /** Revision attribute each writer advances; required for `revision-fenced`. */
  readonly revisionAttribute?: string
  /**
   * Classifies a stored row. Must be pure and must not throw for a row of
   * another entity.
   *
   * @param row - Stored row.
   * @returns How the migration sees the row.
   */
  readonly classify: (row: DataMigrationRow) => DataMigrationRowClass
  /**
   * Transforms a `pending` row into its `toSchemaVersion` form. Must be pure
   * and deterministic so that a retried page writes the same row.
   *
   * @param row - Row classified as `pending`.
   * @returns The complete replacement row.
   */
  readonly transform: (row: DataMigrationRow) => Record<string, unknown>
}

/** Stable failure codes reported by the migration runner, verifier and CLI. */
export type DataMigrationFailureCode =
  | 'DEFINITION_INVALID'
  | 'DEFINITION_MISMATCH'
  | 'PARTITION_PLAN_MISMATCH'
  | 'LEASE_HELD'
  | 'CHECKPOINT_CONFLICT'
  | 'CHECKPOINT_INVALID'
  | 'UNKNOWN_ROW'
  | 'TRANSFORM_INVALID'
  | 'WRITE_CONFLICT'
  | 'CURSOR_REPEATED'
  | 'UPSTREAM_FAILURE'

/** Error carrying a stable migration failure code and no row data. */
export class DataMigrationFailure extends Error {
  /** Stable failure code. */
  readonly code: DataMigrationFailureCode

  /**
   * Creates a failure with a stable code.
   *
   * @param code - Stable failure code.
   */
  constructor(code: DataMigrationFailureCode) {
    super(code)
    this.name = 'DataMigrationFailure'
    this.code = code
  }
}

/** Row counts for one partition or for a whole run. */
export type DataMigrationCounters = {
  /** Rows read. */
  scanned: number
  /** Rows replaced with their `toSchemaVersion` form by this migration. */
  migrated: number
  /** Rows found at `toSchemaVersion` without a write. */
  alreadyMigrated: number
  /** Rows of other entities. */
  unrelated: number
  /** Pending rows deleted by a writer before the migration replaced them. */
  vanished: number
}

/** Durable progress of one migration over one partition. */
export type DataMigrationCheckpoint = {
  /** Migration identifier. */
  readonly migrationId: string
  /** Partition identifier inside the migration. */
  readonly partitionId: string
  /** Number of partitions in the plan the checkpoint was created with. */
  readonly partitionCount: number
  /** Schema version the migration reads. */
  readonly fromSchemaVersion: number
  /** Schema version the migration writes. */
  readonly toSchemaVersion: number
  /** Whether the partition still has rows to read. */
  readonly status: 'in-progress' | 'completed'
  /** Opaque store cursor for the next page; absent before the first page and when completed. */
  readonly cursor?: string
  /** Cumulative counts across every run of this partition. */
  readonly counters: DataMigrationCounters
  /** Compare-and-set revision; advanced by every save. */
  readonly revision: number
  /** Run that holds the lease, if any. */
  readonly leaseOwner?: string
  /** ISO time the lease expires. */
  readonly leaseExpiresAt?: string
  /** ISO time of the last save. */
  readonly updatedAt: string
}

/**
 * Returns zeroed counters.
 *
 * @returns Counters with every count at zero.
 */
export function createEmptyDataMigrationCounters(): DataMigrationCounters {
  return { scanned: 0, migrated: 0, alreadyMigrated: 0, unrelated: 0, vanished: 0 }
}

/**
 * Adds two counter sets.
 *
 * @param left - First counters.
 * @param right - Second counters.
 * @returns The element-wise sum.
 */
export function addDataMigrationCounters(
  left: DataMigrationCounters,
  right: DataMigrationCounters,
): DataMigrationCounters {
  return {
    scanned: left.scanned + right.scanned,
    migrated: left.migrated + right.migrated,
    alreadyMigrated: left.alreadyMigrated + right.alreadyMigrated,
    unrelated: left.unrelated + right.unrelated,
    vanished: left.vanished + right.vanished,
  }
}

/**
 * Validates the static shape of a definition.
 *
 * @param definition - Definition to validate.
 * @throws DataMigrationFailure with `DEFINITION_INVALID` when a rule is broken.
 */
export function assertValidDataMigrationDefinition(definition: DataMigrationDefinition): void {
  const valid = MIGRATION_ID_PATTERN.test(definition.id) &&
    definition.description.trim().length > 0 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(definition.table) &&
    definition.keyAttributes.length >= 1 &&
    definition.keyAttributes.length <= 2 &&
    new Set(definition.keyAttributes).size === definition.keyAttributes.length &&
    definition.keyAttributes.every((name) => ATTRIBUTE_NAME_PATTERN.test(name)) &&
    ATTRIBUTE_NAME_PATTERN.test(definition.versionAttribute) &&
    !definition.keyAttributes.includes(definition.versionAttribute) &&
    Number.isSafeInteger(definition.fromSchemaVersion) &&
    definition.fromSchemaVersion >= 1 &&
    definition.toSchemaVersion === definition.fromSchemaVersion + 1 &&
    isValidWriterPolicy(definition)
  if (!valid) throw new DataMigrationFailure('DEFINITION_INVALID')
}

/**
 * Validates a set of definitions, including unique identifiers.
 *
 * @param definitions - Registered definitions.
 * @throws DataMigrationFailure with `DEFINITION_INVALID` when a rule is broken.
 */
export function assertValidDataMigrationRegistry(
  definitions: readonly DataMigrationDefinition[],
): void {
  for (const definition of definitions) assertValidDataMigrationDefinition(definition)
  const ids = new Set(definitions.map((definition) => definition.id))
  if (ids.size !== definitions.length) throw new DataMigrationFailure('DEFINITION_INVALID')
}

/**
 * Checks that the writer policy and revision attribute agree.
 *
 * @param definition - Definition to check.
 * @returns Whether the writer policy is consistent.
 */
function isValidWriterPolicy(definition: DataMigrationDefinition): boolean {
  if (definition.writerPolicy === 'pause-writers') return definition.revisionAttribute === undefined
  const revision = definition.revisionAttribute
  return revision !== undefined &&
    ATTRIBUTE_NAME_PATTERN.test(revision) &&
    revision !== definition.versionAttribute &&
    !definition.keyAttributes.includes(revision)
}

/**
 * Transforms a pending row and checks the result against the contract: the
 * keys and revision are unchanged, the version is `toSchemaVersion`, and the
 * definition classifies the result as `migrated`.
 *
 * @param definition - Migration definition.
 * @param row - Row classified as `pending`.
 * @returns The validated replacement row.
 * @throws DataMigrationFailure with `TRANSFORM_INVALID` when the result breaks the contract.
 */
export function transformDataMigrationRow(
  definition: DataMigrationDefinition,
  row: DataMigrationRow,
): Record<string, unknown> {
  let next: Record<string, unknown>
  try {
    next = definition.transform(row)
  } catch {
    throw new DataMigrationFailure('TRANSFORM_INVALID')
  }
  const keysKept = definition.keyAttributes.every((name) =>
    isKeyValue(row[name]) && next[name] === row[name])
  const revisionKept = definition.revisionAttribute === undefined ||
    next[definition.revisionAttribute] === row[definition.revisionAttribute]
  let resultClass: DataMigrationRowClass
  try {
    resultClass = definition.classify(next)
  } catch {
    throw new DataMigrationFailure('TRANSFORM_INVALID')
  }
  if (
    !keysKept ||
    !revisionKept ||
    next[definition.versionAttribute] !== definition.toSchemaVersion ||
    resultClass !== 'migrated'
  ) {
    throw new DataMigrationFailure('TRANSFORM_INVALID')
  }
  return next
}

/**
 * Classifies a row, treating a throwing classifier as an unknown row.
 *
 * @param definition - Migration definition.
 * @param row - Stored row.
 * @returns The row class.
 */
export function classifyDataMigrationRow(
  definition: DataMigrationDefinition,
  row: DataMigrationRow,
): DataMigrationRowClass {
  try {
    return definition.classify(row)
  } catch {
    return 'unknown'
  }
}

/**
 * Extracts the primary key of a row.
 *
 * @param definition - Migration definition naming the key attributes.
 * @param row - Stored row.
 * @returns The key attributes and their values.
 * @throws DataMigrationFailure with `UNKNOWN_ROW` when a key value is missing.
 */
export function extractDataMigrationRowKey(
  definition: DataMigrationDefinition,
  row: DataMigrationRow,
): Record<string, string | number> {
  const key: Record<string, string | number> = {}
  for (const name of definition.keyAttributes) {
    const value = row[name]
    if (!isKeyValue(value)) throw new DataMigrationFailure('UNKNOWN_ROW')
    key[name] = value
  }
  return key
}

/**
 * Checks whether a value can be a DynamoDB key attribute value.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a non-empty string or a finite number.
 */
function isKeyValue(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0) ||
    (typeof value === 'number' && Number.isFinite(value))
}
