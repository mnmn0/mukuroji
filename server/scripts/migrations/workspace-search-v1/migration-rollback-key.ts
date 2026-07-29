import { createMigrationDigest } from './migration-contract'

const rollbackRecordKeyVersion = 1
const rollbackStartRecordKeyPrefix =
  `rollback-start/v${rollbackRecordKeyVersion}`

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
