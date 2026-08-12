import {
  decodeAttributeMap,
  encodeAttributeMap,
  serializeCanonicalAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createWorkspaceSearchConfigurationHash,
  isHexDigest,
  MigrationDigestAccumulator,
  type DynamoAttributeMap,
  type MigrationDigestState,
  type MigrationTableIdentity,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  cloneWorkspaceSearchMigrationExactTableKey,
} from './migration-source-scan-context'
import { hasCanonicalDenseArrayShape } from './migration-value-guards'

/**
 * Classification and digest summary accumulated before the target join.
 */
export type WorkspaceSearchMigrationTargetScanAggregate = {
  /** Exact number of full target rows consumed. */
  readonly scanned: number
  /** Number of rows owned by migration v1. */
  readonly owned: number
  /** Number of recognized rows outside migration v1 ownership. */
  readonly ignored: number
  /** Number of malformed or ownership-conflicting rows. */
  readonly invalid: number
  /** Order-independent digest of exact physical target keys. */
  readonly keyDigest: string
  /** Order-independent digest of exact low-level target rows. */
  readonly contentDigest: string
  /** Number of bounded DynamoDB pages consumed. */
  readonly pageCount: number
}

/**
 * Cursor and target-observation state before source/target join.
 *
 * Target `projected` and `deleted` outcomes are deliberately absent because
 * they can only be derived after joining the complete target observation with
 * all four complete source scans. This checkpoint alone cannot resume a join;
 * every preceding raw page must also be durably retained and revalidated.
 */
export type WorkspaceSearchMigrationTargetScanCheckpoint = {
  /** Reviewed measured-configuration digest that owns this checkpoint. */
  readonly configurationHash: string
  /** Whether the complete target base-table traversal finished. */
  readonly completed: boolean
  /** Low-level DynamoDB LastEvaluatedKey for the next page. */
  readonly cursor?: DynamoAttributeMap
  /** Cumulative target-only classifications and digests. */
  readonly aggregate: WorkspaceSearchMigrationTargetScanAggregate
  /** Restorable accumulator state for physical target-key digests. */
  readonly keyDigestState: MigrationDigestState
  /** Restorable accumulator state for full target-row digests. */
  readonly contentDigestState: MigrationDigestState
}

/**
 * Measured context required before one target page can be consumed.
 */
export type WorkspaceSearchMigrationTargetScanContextInput = {
  /** Complete measured configuration that owns the target checkpoint. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Previously committed cumulative target checkpoint. */
  readonly previousCheckpoint: WorkspaceSearchMigrationTargetScanCheckpoint
}

/**
 * Fixed codes returned by target Scan preflight validation.
 */
export type WorkspaceSearchMigrationTargetScanPreflightFailureCode =
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_STATE'
  | 'TABLE_SCHEMA_MISMATCH'

/**
 * Detached target context shared by the AWS reader and pure page reducer.
 */
export type PreparedWorkspaceSearchMigrationTargetScanContext = {
  /** Detached exact measured configuration. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed configuration hash captured exactly once. */
  readonly configurationHash: string
  /** Detached validated predecessor checkpoint. */
  readonly previousCheckpoint: WorkspaceSearchMigrationTargetScanCheckpoint
  /** Validated measured Workspace Search target table identity. */
  readonly table: MigrationTableIdentity
}

/**
 * Successful target Scan preflight result.
 */
type WorkspaceSearchMigrationTargetScanPreflightSuccess = {
  /** Successful-result discriminator. */
  readonly ok: true
  /** Detached validated target context. */
  readonly context: PreparedWorkspaceSearchMigrationTargetScanContext
}

/**
 * Failed target Scan preflight result.
 */
type WorkspaceSearchMigrationTargetScanPreflightFailure = {
  /** Failed-result discriminator. */
  readonly ok: false
  /** Stable operator-safe failure code. */
  readonly code: WorkspaceSearchMigrationTargetScanPreflightFailureCode
}

/**
 * Result of validating and detaching one target Scan context.
 */
export type WorkspaceSearchMigrationTargetScanPreflightResult =
  | WorkspaceSearchMigrationTargetScanPreflightFailure
  | WorkspaceSearchMigrationTargetScanPreflightSuccess

/**
 * Creates the canonical checkpoint used before the first target page.
 *
 * @param configurationHash - Reviewed measured configuration that owns it.
 * @returns Empty incomplete target checkpoint with zero digest states.
 */
export function createEmptyWorkspaceSearchMigrationTargetScanCheckpoint(
  configurationHash: string,
): WorkspaceSearchMigrationTargetScanCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  return {
    configurationHash,
    completed: false,
    aggregate: {
      scanned: 0,
      owned: 0,
      ignored: 0,
      invalid: 0,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount: 0,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
}

/**
 * Detaches and validates one target context without exposing raw input errors.
 *
 * @param input - Caller-owned measured context and predecessor checkpoint.
 * @returns Detached target context or a fixed failure code.
 */
export function prepareWorkspaceSearchMigrationTargetScanContext(
  input: WorkspaceSearchMigrationTargetScanContextInput,
): WorkspaceSearchMigrationTargetScanPreflightResult {
  try {
    const configuration = structuredClone(input.configuration)
    const configurationHash = input.configurationHash
    if (
      !isHexDigest(configurationHash) ||
      createWorkspaceSearchConfigurationHash(configuration) !==
        configurationHash
    ) {
      return targetScanPreflightFailure('CONFIGURATION_HASH_MISMATCH')
    }
    const table = configuration.tables['workspace-search']
    const tableFailure = validateTargetTable(table)
    if (tableFailure !== undefined) {
      return targetScanPreflightFailure(tableFailure)
    }
    const checkpoint = cloneTargetCheckpoint(input.previousCheckpoint)
    validateWorkspaceSearchMigrationTargetScanCheckpoint(checkpoint)
    if (checkpoint.configurationHash !== configurationHash) {
      return targetScanPreflightFailure('CONFIGURATION_HASH_MISMATCH')
    }
    if (checkpoint.completed) {
      return targetScanPreflightFailure('INVALID_STATE')
    }
    let previousCheckpoint = checkpoint
    if (checkpoint.cursor !== undefined) {
      const cursorResult = cloneWorkspaceSearchMigrationExactTableKey(
        checkpoint.cursor,
        table,
      )
      if (!cursorResult.ok) {
        return targetScanPreflightFailure(cursorResult.code)
      }
      previousCheckpoint = {
        ...checkpoint,
        cursor: cursorResult.key,
      }
    }
    return {
      ok: true,
      context: {
        configuration,
        configurationHash,
        previousCheckpoint,
        table,
      },
    }
  } catch {
    return targetScanPreflightFailure('INVALID_STATE')
  }
}

/**
 * Validates one target-only checkpoint and an optional exact predecessor.
 *
 * @param checkpoint - Candidate cumulative target checkpoint.
 * @param previous - Exact checkpoint before consuming one page.
 */
export function validateWorkspaceSearchMigrationTargetScanCheckpoint(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
  previous?: WorkspaceSearchMigrationTargetScanCheckpoint,
): void {
  const aggregate = checkpoint.aggregate
  if (!isHexDigest(checkpoint.configurationHash)) {
    return failTargetCheckpoint()
  }
  requireNonNegativeSafeInteger(aggregate.scanned)
  requireNonNegativeSafeInteger(aggregate.owned)
  requireNonNegativeSafeInteger(aggregate.ignored)
  requireNonNegativeSafeInteger(aggregate.invalid)
  requireNonNegativeSafeInteger(aggregate.pageCount)
  if (
    aggregate.owned + aggregate.ignored + aggregate.invalid !==
      aggregate.scanned ||
    !isHexDigest(aggregate.keyDigest) ||
    !isHexDigest(aggregate.contentDigest)
  ) {
    return failTargetCheckpoint()
  }
  const keyAccumulator = MigrationDigestAccumulator.fromState(
    checkpoint.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    checkpoint.contentDigestState,
  )
  if (
    keyAccumulator.size() !== aggregate.scanned ||
    contentAccumulator.size() !== aggregate.scanned ||
    keyAccumulator.digest() !== aggregate.keyDigest ||
    contentAccumulator.digest() !== aggregate.contentDigest
  ) {
    return failTargetCheckpoint()
  }
  // Encoding validates that a retained cursor survives the strict codec.
  if (checkpoint.cursor !== undefined) {
    encodeAttributeMap(checkpoint.cursor)
  }
  if (checkpoint.completed && checkpoint.cursor !== undefined) {
    return failTargetCheckpoint()
  }
  if (
    (checkpoint.completed && aggregate.pageCount < 1) ||
    (
      checkpoint.cursor !== undefined &&
      (aggregate.pageCount < 1 || aggregate.scanned < 1)
    )
  ) {
    return failTargetCheckpoint()
  }
  if (
    !checkpoint.completed &&
    checkpoint.cursor === undefined &&
    !isCanonicalEmptyTargetCheckpoint(checkpoint)
  ) {
    return failTargetCheckpoint()
  }
  if (previous === undefined) return
  validateWorkspaceSearchMigrationTargetScanCheckpoint(previous)
  if (
    previous.completed ||
    checkpoint.configurationHash !== previous.configurationHash ||
    aggregate.scanned < previous.aggregate.scanned ||
    aggregate.owned < previous.aggregate.owned ||
    aggregate.ignored < previous.aggregate.ignored ||
    aggregate.invalid < previous.aggregate.invalid ||
    aggregate.pageCount !== previous.aggregate.pageCount + 1 ||
    checkpoint.keyDigestState.count < previous.keyDigestState.count ||
    checkpoint.contentDigestState.count <
      previous.contentDigestState.count
  ) {
    return failTargetCheckpoint()
  }
  requireStableDigestStateAtSameCount(
    checkpoint.keyDigestState,
    previous.keyDigestState,
  )
  requireStableDigestStateAtSameCount(
    checkpoint.contentDigestState,
    previous.contentDigestState,
  )
  if (
    checkpoint.cursor !== undefined &&
    previous.cursor !== undefined &&
    serializeCanonicalAttributeMap(checkpoint.cursor) ===
      serializeCanonicalAttributeMap(previous.cursor)
  ) {
    return failTargetCheckpoint()
  }
}

/**
 * Clones a target checkpoint before validation inspects mutable containers.
 *
 * @param checkpoint - Caller-owned predecessor checkpoint.
 * @returns Detached checkpoint with a losslessly cloned optional cursor.
 */
function cloneTargetCheckpoint(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
): WorkspaceSearchMigrationTargetScanCheckpoint {
  const clone = structuredClone(checkpoint)
  return clone.cursor === undefined
    ? clone
    : {
        ...clone,
        cursor: decodeAttributeMap(encodeAttributeMap(clone.cursor)),
      }
}

/**
 * Validates the target role and exact base-table key descriptor.
 *
 * @param table - Measured Workspace Search target table.
 * @returns Fixed failure code or undefined for a valid target identity.
 */
function validateTargetTable(
  table: MigrationTableIdentity,
): 'IDENTITY_MISMATCH' | 'TABLE_SCHEMA_MISMATCH' | undefined {
  if (table.role !== 'workspace-search') return 'IDENTITY_MISMATCH'
  if (
    !hasCanonicalDenseArrayShape(table.key) ||
    table.key.length !== 2
  ) {
    return 'TABLE_SCHEMA_MISMATCH'
  }
  const hashKey = table.key[0]
  const rangeKey = table.key[1]
  return hashKey?.name === 'workspaceId' &&
      hashKey.role === 'HASH' &&
      hashKey.type === 'S' &&
      rangeKey?.name === 'recordKey' &&
      rangeKey.role === 'RANGE' &&
      rangeKey.type === 'S'
    ? undefined
    : 'TABLE_SCHEMA_MISMATCH'
}

/**
 * Rejects accumulator substitution when no additional row was consumed.
 *
 * @param next - Candidate successor digest state.
 * @param previous - Exact predecessor digest state.
 */
function requireStableDigestStateAtSameCount(
  next: MigrationDigestState,
  previous: MigrationDigestState,
): void {
  if (
    next.count === previous.count &&
    (
      next.sumHex !== previous.sumHex ||
      next.xorHex !== previous.xorHex
    )
  ) {
    return failTargetCheckpoint()
  }
}

/**
 * Checks one counter before arithmetic or accumulator comparison.
 *
 * @param value - Candidate nonnegative counter.
 */
function requireNonNegativeSafeInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    return failTargetCheckpoint()
  }
}

/**
 * Checks whether an incomplete cursorless checkpoint is exactly initial.
 *
 * @param checkpoint - Validated candidate checkpoint.
 * @returns Whether the checkpoint is the canonical empty target state.
 */
function isCanonicalEmptyTargetCheckpoint(
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
): boolean {
  const empty = createEmptyWorkspaceSearchMigrationTargetScanCheckpoint(
    checkpoint.configurationHash,
  )
  return checkpoint.completed === false &&
    checkpoint.cursor === undefined &&
    checkpoint.aggregate.scanned === 0 &&
    checkpoint.aggregate.owned === 0 &&
    checkpoint.aggregate.ignored === 0 &&
    checkpoint.aggregate.invalid === 0 &&
    checkpoint.aggregate.pageCount === 0 &&
    checkpoint.aggregate.keyDigest === empty.aggregate.keyDigest &&
    checkpoint.aggregate.contentDigest === empty.aggregate.contentDigest &&
    checkpoint.keyDigestState.count === empty.keyDigestState.count &&
    checkpoint.keyDigestState.sumHex === empty.keyDigestState.sumHex &&
    checkpoint.keyDigestState.xorHex === empty.keyDigestState.xorHex &&
    checkpoint.contentDigestState.count ===
      empty.contentDigestState.count &&
    checkpoint.contentDigestState.sumHex ===
      empty.contentDigestState.sumHex &&
    checkpoint.contentDigestState.xorHex ===
      empty.contentDigestState.xorHex
}

/**
 * Creates one fixed failed target preflight result.
 *
 * @param code - Stable operator-safe failure code.
 * @returns Failed target preflight result.
 */
function targetScanPreflightFailure(
  code: WorkspaceSearchMigrationTargetScanPreflightFailureCode,
): WorkspaceSearchMigrationTargetScanPreflightFailure {
  return {
    ok: false,
    code,
  }
}

/**
 * Raises one fixed target-checkpoint validation failure.
 *
 * @returns Never returns.
 */
function failTargetCheckpoint(): never {
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_STATE',
    'Workspace Search target Scan checkpoint is invalid.',
  )
}
