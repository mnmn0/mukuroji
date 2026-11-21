import { DATA_MIGRATION_MAX_PAGE_SIZE } from '../domain/data-migration'

/** Bounds an operator gets when an invocation leaves them out. */
export type DataMigrationInvocationDefaults = {
  /** Parallel scan segments. */
  readonly segments: number
  /** Rows per page for `run`. */
  readonly runPageSize: number
  /** Rows per page for `verify`. */
  readonly verifyPageSize: number
  /** Page budget for `run`. */
  readonly runMaxPages: number
  /** Page budget for `verify`. */
  readonly verifyMaxPages: number
  /** Row replacements per second for `run`. */
  readonly maxWritesPerSecond: number
  /** Largest accepted write budget. */
  readonly maxWritesPerSecondLimit: number
}

/**
 * Defaults shared by the operator CLI and the data migration Lambda, so the
 * same command reads and writes at the same pace on either path.
 */
export const DATA_MIGRATION_INVOCATION_DEFAULTS: DataMigrationInvocationDefaults = Object.freeze({
  segments: 4,
  runPageSize: 25,
  verifyPageSize: DATA_MIGRATION_MAX_PAGE_SIZE,
  runMaxPages: 200,
  verifyMaxPages: 10_000,
  maxWritesPerSecond: 25,
  maxWritesPerSecondLimit: 1000,
})
