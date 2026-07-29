import { Buffer } from 'node:buffer'
import { types as nodeUtilTypes } from 'node:util'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  type EncodedAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  workspaceSearchMigrationSourceNames,
  type MigrationDigestState,
  type MigrationScanAggregate,
  type MigrationSourceCheckpoint,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  validateWorkspaceSearchMigrationCheckpoint,
  type WorkspaceSearchMigrationCheckpointLocation,
} from './migration-state-machine'
import {
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Maximum canonical bytes accepted for one immutable apply-checkpoint receipt. */
export const WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_MAX_BYTES =
  64 * 1024

/** Stable prefix for deterministic apply-checkpoint receipt record keys. */
export const WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_RECORD_KEY_PREFIX =
  'apply-checkpoint/v1'

const applyCheckpointCommandVersion = 1
const applyCheckpointReceiptVersion = 1
const maximumGraphDepth = 64
const maximumGraphNodes = 100_000

/**
 * Stable raw-value-free failure raised for an invalid apply-checkpoint receipt.
 */
export class WorkspaceSearchMigrationApplyCheckpointReceiptError
  extends Error {
  /** Secret-free machine-readable receipt failure code. */
  readonly code = 'INVALID_MIGRATION_APPLY_CHECKPOINT_RECEIPT'

  /** Creates one stable receipt validation failure. */
  constructor() {
    super('INVALID_MIGRATION_APPLY_CHECKPOINT_RECEIPT')
    this.name =
      'WorkspaceSearchMigrationApplyCheckpointReceiptError'
  }
}

/**
 * Input used to derive one deterministic checkpoint-command identity.
 */
export type CreateWorkspaceSearchMigrationApplyCheckpointCommandIdentityInput = {
  /** Immutable physical migration-state TableId. */
  readonly stateTableId: string
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Operator-selected run that owns the checkpoint. */
  readonly runId: string
  /** Digest of the immutable revision-one execution admission. */
  readonly executionRunDigest: string
  /** Source or target traversal advanced by the command. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
  /** Exact mutable predecessor revision expected by the command. */
  readonly expectedRevision: number
}

/**
 * Content-addressed identity of one adapter-owned apply-checkpoint command.
 */
export type WorkspaceSearchMigrationApplyCheckpointCommandIdentity = {
  /** Checkpoint-command identity discriminator. */
  readonly kind: 'workspace-search-apply-checkpoint-command'
  /** Checkpoint-command identity schema version. */
  readonly commandVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Stable migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Immutable physical migration-state TableId. */
  readonly stateTableId: string
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Operator-selected run that owns the checkpoint. */
  readonly runId: string
  /** Digest of the immutable revision-one execution admission. */
  readonly executionRunDigest: string
  /** Migration phase whose traversal is advanced. */
  readonly phase: 'apply'
  /** Source or target traversal advanced by the command. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
  /** Exact mutable predecessor revision expected by the command. */
  readonly expectedRevision: number
  /** Digest of every preceding command-identity field. */
  readonly commandDigest: string
}

/**
 * Identifies which durable root preceded one checkpoint transition.
 */
export type WorkspaceSearchMigrationApplyCheckpointPredecessorKind =
  | 'execution-run-admission'
  | 'mutable-execution-state'

/**
 * JSON-safe canonical snapshot of one durable traversal checkpoint.
 */
export type WorkspaceSearchMigrationApplyCheckpointSnapshot = {
  /** Whether the complete selected table traversal finished. */
  readonly completed: boolean
  /** Losslessly encoded DynamoDB LastEvaluatedKey for the next page. */
  readonly cursor?: EncodedAttributeMap
  /** Cumulative secret-free counters and row digests. */
  readonly aggregate: MigrationScanAggregate
  /** Restorable accumulator state for physical key digests. */
  readonly keyDigestState: MigrationDigestState
  /** Restorable accumulator state for full row-content digests. */
  readonly contentDigestState: MigrationDigestState
}

/**
 * Immutable receipt written atomically with one checkpoint-state successor.
 */
export type WorkspaceSearchMigrationApplyCheckpointReceipt = {
  /** Apply-checkpoint receipt discriminator. */
  readonly kind: 'workspace-search-migration-apply-checkpoint-receipt'
  /** Apply-checkpoint receipt schema version. */
  readonly receiptVersion: 1
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Stable migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Immutable physical migration-state TableId. */
  readonly stateTableId: string
  /** Digest of the exact measured migration configuration. */
  readonly configurationHash: string
  /** Operator-selected run that owns the checkpoint. */
  readonly runId: string
  /** Digest of the immutable revision-one execution admission. */
  readonly executionRunDigest: string
  /** Migration phase whose traversal was advanced. */
  readonly phase: 'apply'
  /** Source or target traversal advanced by the committed command. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
  /** Digest of the deterministic command identity and durable row key. */
  readonly commandDigest: string
  /** Exact mutable predecessor revision consumed by the transaction. */
  readonly predecessorRevision: number
  /** Whether the predecessor was the admission root or a mutable state row. */
  readonly predecessorKind:
    WorkspaceSearchMigrationApplyCheckpointPredecessorKind
  /**
   * Digest of the predecessor mutable envelope, or the admission digest when
   * `predecessorKind` is `execution-run-admission`.
   */
  readonly predecessorExecutionStateDigest: string
  /** Exact next mutable revision written by the transaction. */
  readonly successorRevision: number
  /** Digest of the exact successor mutable execution-state envelope. */
  readonly successorExecutionStateDigest: string
  /** Digest of the complete reconstructed successor run state. */
  readonly successorRunStateDigest: string
  /** Digest of the exact canonical checkpoint snapshot. */
  readonly checkpointDigest: string
  /** Exact canonical checkpoint committed by the transition. */
  readonly checkpoint: WorkspaceSearchMigrationApplyCheckpointSnapshot
  /** Adapter-owned canonical UTC transaction time. */
  readonly committedAt: string
  /** Digest of every preceding immutable receipt field. */
  readonly receiptDigest: string
}

/**
 * Material used to create one immutable apply-checkpoint receipt.
 */
export type CreateWorkspaceSearchMigrationApplyCheckpointReceiptInput = {
  /** Strict deterministic identity of the checkpoint command. */
  readonly commandIdentity:
    WorkspaceSearchMigrationApplyCheckpointCommandIdentity
  /** Whether the predecessor was the admission root or a mutable state row. */
  readonly predecessorKind:
    WorkspaceSearchMigrationApplyCheckpointPredecessorKind
  /**
   * Digest of the predecessor mutable envelope, or the admission digest when
   * the immutable admission is the direct predecessor.
   */
  readonly predecessorExecutionStateDigest: string
  /** Exact next mutable revision written by the transaction. */
  readonly successorRevision: number
  /** Digest of the exact successor mutable execution-state envelope. */
  readonly successorExecutionStateDigest: string
  /** Digest of the complete reconstructed successor run state. */
  readonly successorRunStateDigest: string
  /** Adapter-derived cumulative checkpoint after one bounded strong scan. */
  readonly checkpoint: MigrationSourceCheckpoint
  /** Adapter-owned canonical UTC transaction time. */
  readonly committedAt: string
}

/**
 * Creates one deterministic checkpoint-command identity.
 *
 * @param input - Exact run binding, location, and expected revision.
 * @returns Detached content-addressed command identity.
 */
export function createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
  input:
    CreateWorkspaceSearchMigrationApplyCheckpointCommandIdentityInput,
): WorkspaceSearchMigrationApplyCheckpointCommandIdentity {
  return atApplyCheckpointReceiptBoundary(() => {
    const record = requireExactRecord(input, [
      'configurationHash',
      'executionRunDigest',
      'expectedRevision',
      'location',
      'runId',
      'stateTableId',
    ])
    const fields = {
      kind: 'workspace-search-apply-checkpoint-command',
      commandVersion: applyCheckpointCommandVersion,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      stateTableId: readIdentifier(
        readOwn(record, 'stateTableId'),
      ),
      configurationHash: readDigest(
        readOwn(record, 'configurationHash'),
      ),
      runId: readIdentifier(readOwn(record, 'runId')),
      executionRunDigest: readDigest(
        readOwn(record, 'executionRunDigest'),
      ),
      phase: 'apply',
      location: readLocation(readOwn(record, 'location')),
      expectedRevision: readPositiveSafeInteger(
        readOwn(record, 'expectedRevision'),
      ),
    } satisfies Omit<
      WorkspaceSearchMigrationApplyCheckpointCommandIdentity,
      'commandDigest'
    >
    return {
      ...fields,
      commandDigest: createMigrationDigest(fields),
    }
  })
}

/**
 * Creates the bounded deterministic state-table sort key for one command.
 *
 * @param identity - Strict checkpoint-command identity.
 * @returns Content-independent immutable receipt record key.
 */
export function createWorkspaceSearchMigrationApplyCheckpointReceiptRecordKey(
  identity: WorkspaceSearchMigrationApplyCheckpointCommandIdentity,
): string {
  return atApplyCheckpointReceiptBoundary(() => {
    const strict = readCommandIdentity(identity)
    return `${WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_RECORD_KEY_PREFIX}/${strict.commandDigest}/receipt`
  })
}

/**
 * Creates one immutable receipt from adapter-owned checkpoint evidence.
 *
 * @param input - Exact command, predecessor, successor, checkpoint, and time.
 * @returns Detached strict immutable receipt.
 */
export function createWorkspaceSearchMigrationApplyCheckpointReceipt(
  input: CreateWorkspaceSearchMigrationApplyCheckpointReceiptInput,
): WorkspaceSearchMigrationApplyCheckpointReceipt {
  return atApplyCheckpointReceiptBoundary(() => {
    const record = requireExactRecord(input, [
      'checkpoint',
      'commandIdentity',
      'committedAt',
      'predecessorExecutionStateDigest',
      'predecessorKind',
      'successorExecutionStateDigest',
      'successorRevision',
      'successorRunStateDigest',
    ])
    const command = readCommandIdentity(
      readOwn(record, 'commandIdentity'),
    )
    const predecessorKind = readPredecessorKind(
      readOwn(record, 'predecessorKind'),
    )
    const predecessorExecutionStateDigest = readDigest(
      readOwn(record, 'predecessorExecutionStateDigest'),
    )
    const successorRevision = readPositiveSafeInteger(
      readOwn(record, 'successorRevision'),
    )
    if (
      command.expectedRevision === Number.MAX_SAFE_INTEGER ||
      successorRevision !== command.expectedRevision + 1
    ) {
      return failApplyCheckpointReceipt()
    }
    if (
      predecessorKind === 'execution-run-admission' &&
      (
        command.expectedRevision !== 1 ||
        predecessorExecutionStateDigest !==
          command.executionRunDigest
      )
    ) {
      return failApplyCheckpointReceipt()
    }
    if (
      command.expectedRevision === 1 &&
      predecessorKind !== 'execution-run-admission'
    ) {
      return failApplyCheckpointReceipt()
    }
    const checkpoint = snapshotCheckpoint(
      readOwn(record, 'checkpoint'),
    )
    const fields = {
      kind:
        'workspace-search-migration-apply-checkpoint-receipt',
      receiptVersion: applyCheckpointReceiptVersion,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      stateTableId: command.stateTableId,
      configurationHash: command.configurationHash,
      runId: command.runId,
      executionRunDigest: command.executionRunDigest,
      phase: 'apply',
      location: command.location,
      commandDigest: command.commandDigest,
      predecessorRevision: command.expectedRevision,
      predecessorKind,
      predecessorExecutionStateDigest,
      successorRevision,
      successorExecutionStateDigest: readDigest(
        readOwn(record, 'successorExecutionStateDigest'),
      ),
      successorRunStateDigest: readDigest(
        readOwn(record, 'successorRunStateDigest'),
      ),
      checkpointDigest: createMigrationDigest(checkpoint),
      checkpoint,
      committedAt: readTimestamp(
        readOwn(record, 'committedAt'),
      ),
    } satisfies Omit<
      WorkspaceSearchMigrationApplyCheckpointReceipt,
      'receiptDigest'
    >
    const receipt = {
      ...fields,
      receiptDigest: createMigrationDigest(fields),
    }
    void encodeReceipt(receipt)
    return receipt
  })
}

/**
 * Serializes one strict receipt as bounded canonical UTF-8 JSON.
 *
 * @param value - Candidate immutable checkpoint receipt.
 * @returns Exact canonical receipt bytes without a trailing newline.
 */
export function serializeWorkspaceSearchMigrationApplyCheckpointReceipt(
  value: WorkspaceSearchMigrationApplyCheckpointReceipt,
): Uint8Array {
  return atApplyCheckpointReceiptBoundary(() =>
    encodeReceipt(readReceipt(value))
  )
}

/**
 * Parses one exact canonical immutable checkpoint receipt.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 receipt bytes.
 * @returns Detached strict immutable checkpoint receipt.
 */
export function parseWorkspaceSearchMigrationApplyCheckpointReceipt(
  bytes: Uint8Array,
): WorkspaceSearchMigrationApplyCheckpointReceipt {
  return atApplyCheckpointReceiptBoundary(() => {
    const snapshot = copyBoundedBytes(bytes)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        snapshot,
      )
    } catch {
      return failApplyCheckpointReceipt()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failApplyCheckpointReceipt()
    }
    const receipt = readReceipt(parsed)
    const canonical = encodeReceipt(receipt)
    if (!equalBytes(snapshot, canonical)) {
      return failApplyCheckpointReceipt()
    }
    return receipt
  })
}

/**
 * Creates one canonical JSON-safe snapshot from a low-level checkpoint.
 *
 * @param checkpoint - Candidate cumulative state-machine checkpoint.
 * @returns Detached strict snapshot used by receipts and reconciliation.
 */
export function createWorkspaceSearchMigrationApplyCheckpointSnapshot(
  checkpoint: MigrationSourceCheckpoint,
): WorkspaceSearchMigrationApplyCheckpointSnapshot {
  return atApplyCheckpointReceiptBoundary(() =>
    snapshotCheckpoint(checkpoint)
  )
}

/**
 * Decodes and validates one canonical receipt checkpoint snapshot.
 *
 * @param snapshot - Candidate JSON-safe canonical checkpoint.
 * @returns Detached low-level checkpoint for state-machine validation.
 */
export function decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
  snapshot: WorkspaceSearchMigrationApplyCheckpointSnapshot,
): MigrationSourceCheckpoint {
  return atApplyCheckpointReceiptBoundary(() =>
    decodeCheckpointSnapshot(readCheckpointSnapshot(snapshot))
  )
}

/**
 * Reads and reconstructs one strict deterministic command identity.
 *
 * @param value - Candidate command identity.
 * @returns Detached strict identity.
 */
function readCommandIdentity(
  value: unknown,
): WorkspaceSearchMigrationApplyCheckpointCommandIdentity {
  const record = requireExactRecord(value, [
    'commandDigest',
    'commandVersion',
    'configurationHash',
    'executionRunDigest',
    'expectedRevision',
    'kind',
    'location',
    'migrationId',
    'migrationVersion',
    'phase',
    'runId',
    'stateTableId',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-apply-checkpoint-command' ||
    readOwn(record, 'commandVersion') !==
      applyCheckpointCommandVersion ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    readOwn(record, 'phase') !== 'apply'
  ) {
    return failApplyCheckpointReceipt()
  }
  const fields = {
    kind: 'workspace-search-apply-checkpoint-command',
    commandVersion: applyCheckpointCommandVersion,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    stateTableId: readIdentifier(
      readOwn(record, 'stateTableId'),
    ),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    runId: readIdentifier(readOwn(record, 'runId')),
    executionRunDigest: readDigest(
      readOwn(record, 'executionRunDigest'),
    ),
    phase: 'apply',
    location: readLocation(readOwn(record, 'location')),
    expectedRevision: readPositiveSafeInteger(
      readOwn(record, 'expectedRevision'),
    ),
  } satisfies Omit<
    WorkspaceSearchMigrationApplyCheckpointCommandIdentity,
    'commandDigest'
  >
  const commandDigest = readDigest(
    readOwn(record, 'commandDigest'),
  )
  if (commandDigest !== createMigrationDigest(fields)) {
    return failApplyCheckpointReceipt()
  }
  return { ...fields, commandDigest }
}

/**
 * Reads and reconstructs one strict immutable checkpoint receipt.
 *
 * @param value - Candidate runtime or parsed receipt.
 * @returns Detached strict immutable receipt.
 */
function readReceipt(
  value: unknown,
): WorkspaceSearchMigrationApplyCheckpointReceipt {
  const record = requireExactRecord(value, [
    'checkpoint',
    'checkpointDigest',
    'commandDigest',
    'committedAt',
    'configurationHash',
    'executionRunDigest',
    'kind',
    'location',
    'migrationId',
    'migrationVersion',
    'phase',
    'predecessorExecutionStateDigest',
    'predecessorKind',
    'predecessorRevision',
    'receiptDigest',
    'receiptVersion',
    'runId',
    'stateTableId',
    'successorExecutionStateDigest',
    'successorRevision',
    'successorRunStateDigest',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-apply-checkpoint-receipt' ||
    readOwn(record, 'receiptVersion') !==
      applyCheckpointReceiptVersion ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    readOwn(record, 'phase') !== 'apply'
  ) {
    return failApplyCheckpointReceipt()
  }
  const predecessorRevision = readPositiveSafeInteger(
    readOwn(record, 'predecessorRevision'),
  )
  const successorRevision = readPositiveSafeInteger(
    readOwn(record, 'successorRevision'),
  )
  if (
    predecessorRevision === Number.MAX_SAFE_INTEGER ||
    successorRevision !== predecessorRevision + 1
  ) {
    return failApplyCheckpointReceipt()
  }
  const stateTableId = readIdentifier(
    readOwn(record, 'stateTableId'),
  )
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const runId = readIdentifier(readOwn(record, 'runId'))
  const executionRunDigest = readDigest(
    readOwn(record, 'executionRunDigest'),
  )
  const location = readLocation(readOwn(record, 'location'))
  const command = createWorkspaceSearchMigrationApplyCheckpointCommandIdentity(
    {
      stateTableId,
      configurationHash,
      runId,
      executionRunDigest,
      location,
      expectedRevision: predecessorRevision,
    },
  )
  const commandDigest = readDigest(
    readOwn(record, 'commandDigest'),
  )
  if (commandDigest !== command.commandDigest) {
    return failApplyCheckpointReceipt()
  }
  const predecessorKind = readPredecessorKind(
    readOwn(record, 'predecessorKind'),
  )
  const predecessorExecutionStateDigest = readDigest(
    readOwn(record, 'predecessorExecutionStateDigest'),
  )
  if (
    predecessorKind === 'execution-run-admission' &&
    (
      predecessorRevision !== 1 ||
      predecessorExecutionStateDigest !== executionRunDigest
    )
  ) {
    return failApplyCheckpointReceipt()
  }
  if (
    predecessorRevision === 1 &&
    predecessorKind !== 'execution-run-admission'
  ) {
    return failApplyCheckpointReceipt()
  }
  const checkpoint = readCheckpointSnapshot(
    readOwn(record, 'checkpoint'),
  )
  const checkpointDigest = readDigest(
    readOwn(record, 'checkpointDigest'),
  )
  if (checkpointDigest !== createMigrationDigest(checkpoint)) {
    return failApplyCheckpointReceipt()
  }
  const fields = {
    kind:
      'workspace-search-migration-apply-checkpoint-receipt',
    receiptVersion: applyCheckpointReceiptVersion,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    stateTableId,
    configurationHash,
    runId,
    executionRunDigest,
    phase: 'apply',
    location,
    commandDigest,
    predecessorRevision,
    predecessorKind,
    predecessorExecutionStateDigest,
    successorRevision,
    successorExecutionStateDigest: readDigest(
      readOwn(record, 'successorExecutionStateDigest'),
    ),
    successorRunStateDigest: readDigest(
      readOwn(record, 'successorRunStateDigest'),
    ),
    checkpointDigest,
    checkpoint,
    committedAt: readTimestamp(readOwn(record, 'committedAt')),
  } satisfies Omit<
    WorkspaceSearchMigrationApplyCheckpointReceipt,
    'receiptDigest'
  >
  const receiptDigest = readDigest(
    readOwn(record, 'receiptDigest'),
  )
  if (receiptDigest !== createMigrationDigest(fields)) {
    return failApplyCheckpointReceipt()
  }
  return { ...fields, receiptDigest }
}

/**
 * Converts one runtime checkpoint to its canonical JSON-safe snapshot.
 *
 * @param value - Candidate low-level cumulative checkpoint.
 * @returns Detached canonical checkpoint snapshot.
 */
function snapshotCheckpoint(
  value: unknown,
): WorkspaceSearchMigrationApplyCheckpointSnapshot {
  const record = requireCheckpointRecord(value)
  const common = {
    completed: readBoolean(readOwn(record, 'completed')),
    aggregate: readAggregate(readOwn(record, 'aggregate')),
    keyDigestState: readDigestState(
      readOwn(record, 'keyDigestState'),
    ),
    contentDigestState: readDigestState(
      readOwn(record, 'contentDigestState'),
    ),
  }
  const cursorValue = hasOwnDataProperty(record, 'cursor')
    ? readOwn(record, 'cursor')
    : undefined
  if (
    hasOwnDataProperty(record, 'cursor') &&
    cursorValue === undefined
  ) {
    return failApplyCheckpointReceipt()
  }
  const snapshot: WorkspaceSearchMigrationApplyCheckpointSnapshot =
    cursorValue === undefined
      ? common
      : {
          ...common,
          cursor: snapshotRawAttributeMap(cursorValue),
        }
  void decodeCheckpointSnapshot(snapshot)
  return snapshot
}

/**
 * Reads one JSON-safe canonical checkpoint snapshot.
 *
 * @param value - Candidate parsed or runtime snapshot.
 * @returns Detached strict canonical checkpoint snapshot.
 */
function readCheckpointSnapshot(
  value: unknown,
): WorkspaceSearchMigrationApplyCheckpointSnapshot {
  const record = requireCheckpointRecord(value)
  const common = {
    completed: readBoolean(readOwn(record, 'completed')),
    aggregate: readAggregate(readOwn(record, 'aggregate')),
    keyDigestState: readDigestState(
      readOwn(record, 'keyDigestState'),
    ),
    contentDigestState: readDigestState(
      readOwn(record, 'contentDigestState'),
    ),
  }
  const cursorValue = hasOwnDataProperty(record, 'cursor')
    ? readOwn(record, 'cursor')
    : undefined
  if (
    hasOwnDataProperty(record, 'cursor') &&
    cursorValue === undefined
  ) {
    return failApplyCheckpointReceipt()
  }
  let snapshot: WorkspaceSearchMigrationApplyCheckpointSnapshot
  if (cursorValue === undefined) {
    snapshot = common
  } else {
    requireSafeDataGraph(cursorValue)
    const decoded = decodeAttributeMap(cursorValue)
    snapshot = {
      ...common,
      cursor: encodeUnknownAttributeMap(decoded),
    }
  }
  void decodeCheckpointSnapshot(snapshot)
  return snapshot
}

/**
 * Reconstructs and validates one low-level checkpoint from its snapshot.
 *
 * @param snapshot - Strict JSON-safe checkpoint snapshot.
 * @returns Detached validated low-level checkpoint.
 */
function decodeCheckpointSnapshot(
  snapshot: WorkspaceSearchMigrationApplyCheckpointSnapshot,
): MigrationSourceCheckpoint {
  const common = {
    completed: snapshot.completed,
    aggregate: snapshot.aggregate,
    keyDigestState: snapshot.keyDigestState,
    contentDigestState: snapshot.contentDigestState,
  }
  const checkpoint: MigrationSourceCheckpoint =
    snapshot.cursor === undefined
      ? common
      : {
          ...common,
          cursor: decodeAttributeMap(snapshot.cursor),
        }
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  return checkpoint
}

/**
 * Requires a checkpoint record with exactly its optional cursor shape.
 *
 * @param value - Candidate checkpoint.
 * @returns Strict checkpoint record.
 */
function requireCheckpointRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const record = requirePlainRecord(value)
  const hasCursor = hasOwnDataProperty(record, 'cursor')
  return requireExactRecord(
    record,
    hasCursor
      ? [
          'aggregate',
          'completed',
          'contentDigestState',
          'cursor',
          'keyDigestState',
        ]
      : [
          'aggregate',
          'completed',
          'contentDigestState',
          'keyDigestState',
        ],
  )
}

/**
 * Reads one complete cumulative scan aggregate.
 *
 * @param value - Candidate checkpoint aggregate.
 * @returns Detached strict aggregate.
 */
function readAggregate(value: unknown): MigrationScanAggregate {
  const record = requireExactRecord(value, [
    'contentDigest',
    'deleted',
    'ignored',
    'invalid',
    'keyDigest',
    'mapped',
    'pageCount',
    'projected',
    'scanned',
  ])
  return {
    scanned: readNonNegativeSafeInteger(
      readOwn(record, 'scanned'),
    ),
    mapped: readNonNegativeSafeInteger(
      readOwn(record, 'mapped'),
    ),
    ignored: readNonNegativeSafeInteger(
      readOwn(record, 'ignored'),
    ),
    invalid: readNonNegativeSafeInteger(
      readOwn(record, 'invalid'),
    ),
    projected: readNonNegativeSafeInteger(
      readOwn(record, 'projected'),
    ),
    deleted: readNonNegativeSafeInteger(
      readOwn(record, 'deleted'),
    ),
    keyDigest: readDigest(readOwn(record, 'keyDigest')),
    contentDigest: readDigest(
      readOwn(record, 'contentDigest'),
    ),
    pageCount: readNonNegativeSafeInteger(
      readOwn(record, 'pageCount'),
    ),
  }
}

/**
 * Reads one restorable order-independent digest state.
 *
 * @param value - Candidate accumulator state.
 * @returns Detached strict digest state.
 */
function readDigestState(value: unknown): MigrationDigestState {
  const record = requireExactRecord(value, [
    'count',
    'sumHex',
    'xorHex',
  ])
  return {
    count: readNonNegativeSafeInteger(readOwn(record, 'count')),
    sumHex: readDigest(readOwn(record, 'sumHex')),
    xorHex: readDigest(readOwn(record, 'xorHex')),
  }
}

/**
 * Encodes and detaches one raw low-level DynamoDB attribute map.
 *
 * @param value - Candidate raw DynamoDB key.
 * @returns Canonical JSON-safe attribute map.
 */
function snapshotRawAttributeMap(value: unknown): EncodedAttributeMap {
  requireSafeDataGraph(value)
  return encodeUnknownAttributeMap(value)
}

/**
 * Rejects accessors, Proxies, symbols, cycles, and unbounded data graphs.
 *
 * @param value - Candidate nested DynamoDB value graph.
 */
function requireSafeDataGraph(value: unknown): void {
  const visited = new Set<object>()
  const nodeCount = visitSafeDataGraph(value, visited, 0)
  if (nodeCount > maximumGraphNodes) {
    return failApplyCheckpointReceipt()
  }
}

/**
 * Visits one strict data graph without invoking caller accessors.
 *
 * @param value - Candidate graph node.
 * @param ancestors - Objects on the current recursive path.
 * @param depth - Current recursive depth.
 * @returns Number of graph nodes consumed below this value.
 */
function visitSafeDataGraph(
  value: unknown,
  ancestors: Set<object>,
  depth: number,
): number {
  if (depth > maximumGraphDepth) {
    return failApplyCheckpointReceipt()
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      return failApplyCheckpointReceipt()
    }
    return 1
  }
  if (typeof value === 'string') {
    if (!hasOnlyPairedSurrogates(value)) {
      return failApplyCheckpointReceipt()
    }
    return 1
  }
  if (typeof value !== 'object') {
    return failApplyCheckpointReceipt()
  }
  if (nodeUtilTypes.isProxy(value)) {
    return failApplyCheckpointReceipt()
  }
  if (isSupportedBinaryValue(value)) {
    if (
      value.byteLength >
      WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_MAX_BYTES
    ) {
      return failApplyCheckpointReceipt()
    }
    requireExactTypedArrayKeys(value)
    return value.byteLength + 1
  }
  if (ancestors.has(value)) {
    return failApplyCheckpointReceipt()
  }
  ancestors.add(value)
  let consumed = 1
  if (Array.isArray(value)) {
    const length = value.length
    if (
      !Number.isSafeInteger(length) ||
      length > maximumGraphNodes
    ) {
      return failApplyCheckpointReceipt()
    }
    const keys = Reflect.ownKeys(value)
    if (keys.some((key) => typeof key === 'symbol')) {
      return failApplyCheckpointReceipt()
    }
    const stringKeys = keys.filter(
      (key): key is string => typeof key === 'string',
    )
    if (
      stringKeys.length !== length + 1 ||
      !stringKeys.includes('length')
    ) {
      return failApplyCheckpointReceipt()
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        value,
        String(index),
      )
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return failApplyCheckpointReceipt()
      }
      consumed += visitSafeDataGraph(
        descriptor.value,
        ancestors,
        depth + 1,
      )
      if (consumed > maximumGraphNodes) {
        return failApplyCheckpointReceipt()
      }
    }
  } else {
    const record = requirePlainRecord(value)
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key === 'symbol') {
        return failApplyCheckpointReceipt()
      }
      const descriptor = Object.getOwnPropertyDescriptor(
        record,
        key,
      )
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return failApplyCheckpointReceipt()
      }
      consumed += visitSafeDataGraph(
        descriptor.value,
        ancestors,
        depth + 1,
      )
      if (consumed > maximumGraphNodes) {
        return failApplyCheckpointReceipt()
      }
    }
  }
  ancestors.delete(value)
  return consumed
}

/**
 * Rejects custom properties on one binary value without reading its bytes.
 *
 * @param value - Candidate binary attribute bytes.
 */
function requireExactTypedArrayKeys(value: Uint8Array): void {
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key === 'symbol') ||
    keys.length !== value.byteLength
  ) {
    return failApplyCheckpointReceipt()
  }
  for (let index = 0; index < value.byteLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    )
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      return failApplyCheckpointReceipt()
    }
  }
}

/**
 * Narrows one binary value to a trusted built-in byte-array prototype.
 *
 * @param value - Candidate binary graph node.
 * @returns Whether the value is a plain Uint8Array or Node.js Buffer.
 */
function isSupportedBinaryValue(
  value: unknown,
): value is Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Uint8Array.prototype ||
    prototype === Buffer.prototype
}

/**
 * Reads one supported checkpoint location.
 *
 * @param value - Candidate source or target location.
 * @returns Strict checkpoint location.
 */
function readLocation(
  value: unknown,
): WorkspaceSearchMigrationCheckpointLocation {
  if (value === 'target') return value
  for (const source of workspaceSearchMigrationSourceNames) {
    if (value === source) return source
  }
  return failApplyCheckpointReceipt()
}

/**
 * Reads one supported predecessor-root discriminator.
 *
 * @param value - Candidate predecessor kind.
 * @returns Strict predecessor kind.
 */
function readPredecessorKind(
  value: unknown,
): WorkspaceSearchMigrationApplyCheckpointPredecessorKind {
  if (
    value !== 'execution-run-admission' &&
    value !== 'mutable-execution-state'
  ) {
    return failApplyCheckpointReceipt()
  }
  return value
}

/**
 * Reads one safe migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string') {
    return failApplyCheckpointReceipt()
  }
  requireMigrationIdentifier(
    value,
    'Apply checkpoint receipt identifier',
  )
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) {
    return failApplyCheckpointReceipt()
  }
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failApplyCheckpointReceipt()
  }
  return value
}

/**
 * Reads one Boolean.
 *
 * @param value - Candidate Boolean.
 * @returns Validated Boolean.
 */
function readBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    return failApplyCheckpointReceipt()
  }
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated positive integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failApplyCheckpointReceipt()
  }
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated nonnegative integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failApplyCheckpointReceipt()
  }
  return value
}

/**
 * Requires one strict plain record with exactly the expected own keys.
 *
 * @param value - Candidate record.
 * @param expectedKeys - Complete allowed string-key set.
 * @returns Strict caller-owned record.
 */
function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const record = requirePlainRecord(value)
  const keys = Reflect.ownKeys(record)
  if (
    keys.some((key) => typeof key === 'symbol') ||
    keys.length !== expectedKeys.length
  ) {
    return failApplyCheckpointReceipt()
  }
  const actual = keys.filter(
    (key): key is string => typeof key === 'string',
  ).sort()
  const expected = [...expectedKeys].sort()
  if (
    actual.some((key, index) => key !== expected[index])
  ) {
    return failApplyCheckpointReceipt()
  }
  for (const key of expected) {
    if (!hasOwnDataProperty(record, key)) {
      return failApplyCheckpointReceipt()
    }
  }
  return record
}

/**
 * Requires one non-Proxy plain record.
 *
 * @param value - Candidate value.
 * @returns Plain record with an ordinary or null prototype.
 */
function requirePlainRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return failApplyCheckpointReceipt()
  }
  return value
}

/**
 * Checks whether one value is a supported non-Proxy plain record.
 *
 * @param value - Candidate value.
 * @returns Whether the value has an ordinary or null prototype.
 */
function isPlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Checks one enumerable own data property without invoking accessors.
 *
 * @param record - Candidate record.
 * @param key - Expected own property name.
 * @returns Whether a strict own data property exists.
 */
function hasOwnDataProperty(record: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return false
  if (
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return failApplyCheckpointReceipt()
  }
  return true
}

/**
 * Reads one validated own data property without invoking accessors.
 *
 * @param record - Strict record.
 * @param key - Exact own property name.
 * @returns Stored property value.
 */
function readOwn(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return failApplyCheckpointReceipt()
  }
  return descriptor.value
}

/**
 * Encodes one validated immutable receipt under its byte ceiling.
 *
 * @param receipt - Strict immutable receipt.
 * @returns Canonical bounded UTF-8 JSON bytes.
 */
function encodeReceipt(
  receipt: WorkspaceSearchMigrationApplyCheckpointReceipt,
): Uint8Array {
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(receipt),
  )
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_MAX_BYTES
  ) {
    return failApplyCheckpointReceipt()
  }
  return bytes
}

/**
 * Copies untrusted input after enforcing its finite byte bound.
 *
 * @param bytes - Candidate receipt bytes.
 * @returns Detached bounded bytes.
 */
function copyBoundedBytes(bytes: Uint8Array): Uint8Array {
  if (
    !isSupportedBinaryValue(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_APPLY_CHECKPOINT_RECEIPT_MAX_BYTES
  ) {
    return failApplyCheckpointReceipt()
  }
  return new Uint8Array(bytes)
}

/**
 * Compares two byte arrays without decoding untrusted input.
 *
 * @param left - First byte array.
 * @param right - Second byte array.
 * @returns Whether both arrays are byte-for-byte identical.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Maps every implementation failure to the stable public receipt error.
 *
 * @param operation - Receipt contract operation.
 * @returns Successful operation result.
 */
function atApplyCheckpointReceiptBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationApplyCheckpointReceiptError
    ) {
      throw error
    }
    throw new WorkspaceSearchMigrationApplyCheckpointReceiptError()
  }
}

/**
 * Raises the only public receipt validation failure.
 *
 * @returns Never returns.
 */
function failApplyCheckpointReceipt(): never {
  throw new WorkspaceSearchMigrationApplyCheckpointReceiptError()
}
