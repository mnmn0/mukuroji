import {
  createMigrationDigest,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'

const rollbackRecordKeyVersion = 1
const rollbackStartRecordKeyPrefix =
  `rollback-start/v${rollbackRecordKeyVersion}`
const rollbackStateV2RecordKeyPrefix = 'rollback-state/v2'
const rollbackReceiptV2RecordKeyPrefix = 'rollback-receipt/v2'
const rolledBackRootV2RecordKeyPrefix = 'rolled-back-root/v2'

/**
 * Exact immutable identity used to address one rollback chain.
 */
export type WorkspaceSearchMigrationRollbackRecordKeyInput = {
  /** Immutable physical migration-state table identifier. */
  readonly stateTableId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Operator-selected migration run. */
  readonly runId: string
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
}

/**
 * Deterministic rollback binding and phase-start sentinel key.
 */
export type WorkspaceSearchMigrationRollbackConflictRecordKeys = {
  /** Stable digest shared by every rollback persistence record key. */
  readonly bindingDigest: string
  /** Deterministic immutable rollback-start sentinel record key. */
  readonly start: string
}

/**
 * Creates one deterministic rollback-start sentinel record key.
 *
 * @param bindingDigest - Stable digest shared by the rollback key namespace.
 * @returns Deterministic immutable rollback-start record key.
 */
export function createWorkspaceSearchMigrationRollbackStartRecordKey(
  bindingDigest: string,
): string {
  return `${rollbackStartRecordKeyPrefix}/${bindingDigest}`
}

/**
 * Creates one deterministic version-two mutable rollback-state record key.
 *
 * @param bindingDigest - Stable digest shared by the rollback key namespace.
 * @returns Deterministic version-two rollback-state record key.
 */
export function createWorkspaceSearchMigrationRollbackStateV2RecordKey(
  bindingDigest: string,
): string {
  return `${rollbackStateV2RecordKeyPrefix}/${bindingDigest}`
}

/**
 * Creates one deterministic version-two immutable rollback receipt key.
 *
 * @param bindingDigest - Stable digest shared by the rollback key namespace.
 * @param sequence - Positive forward mutation sequence restored by the receipt.
 * @returns Deterministic version-two rollback receipt record key.
 */
export function createWorkspaceSearchMigrationRollbackReceiptV2RecordKey(
  bindingDigest: string,
  sequence: number,
): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new WorkspaceSearchMigrationFailure(
      'INVALID_ARGUMENT',
      'Rollback receipt sequence must be a positive safe integer.',
    )
  }
  return `${rollbackReceiptV2RecordKeyPrefix}/${bindingDigest}/${sequence}`
}

/**
 * Creates one deterministic version-two immutable rolled-back root key.
 *
 * @param bindingDigest - Stable digest shared by the rollback key namespace.
 * @returns Deterministic version-two terminal rolled-back root record key.
 */
export function createWorkspaceSearchMigrationRolledBackRootV2RecordKey(
  bindingDigest: string,
): string {
  return `${rolledBackRootV2RecordKeyPrefix}/${bindingDigest}`
}

/**
 * Creates the canonical rollback binding and phase-start sentinel key.
 *
 * Apply, verification, and rollback adapters use this shared key derivation
 * so a committed rollback start can atomically fence every later apply write.
 *
 * @param input - Exact immutable run and state-table identity.
 * @returns Stable binding digest and rollback-start sentinel key.
 */
export function createWorkspaceSearchMigrationRollbackConflictRecordKeys(
  input: WorkspaceSearchMigrationRollbackRecordKeyInput,
): WorkspaceSearchMigrationRollbackConflictRecordKeys {
  const bindingDigest = createMigrationDigest({
    kind: 'workspace-search-migration-rollback-operation-binding',
    version: rollbackRecordKeyVersion,
    stateTableId: input.stateTableId,
    configurationHash: input.configurationHash,
    runId: input.runId,
    executionRunDigest: input.executionRunDigest,
  })
  return {
    bindingDigest,
    start:
      createWorkspaceSearchMigrationRollbackStartRecordKey(
        bindingDigest,
      ),
  }
}
