import { createMigrationDigest } from './migration-contract'

const fullVerificationRecordKeyVersion = 1
const fullVerificationStateRecordKeyPrefix =
  'full-verification-state/v1'
const fullVerificationVerifiedRootRecordKeyPrefix =
  'full-verification-verified-root/v1'

/**
 * Exact immutable identity used to address full-verification conflict rows.
 */
export type WorkspaceSearchMigrationFullVerificationConflictRecordKeyInput = {
  /** Immutable physical migration-state table identifier. */
  readonly stateTableId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Operator-selected migration run. */
  readonly runId: string
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
}

/**
 * Deterministic full-verification binding and conflict record keys.
 */
export type WorkspaceSearchMigrationFullVerificationConflictRecordKeys = {
  /** Stable digest shared by every full-verification record key. */
  readonly bindingDigest: string
  /** Deterministic mutable verification-state record key. */
  readonly state: string
  /** Deterministic immutable verified-root record key. */
  readonly root: string
}

/**
 * Creates the canonical record keys that mutually exclude verification and rollback.
 *
 * @param input - Exact immutable run and state-table identity.
 * @returns Stable binding digest and mutable/terminal conflict keys.
 */
export function createWorkspaceSearchMigrationFullVerificationConflictRecordKeys(
  input:
    WorkspaceSearchMigrationFullVerificationConflictRecordKeyInput,
): WorkspaceSearchMigrationFullVerificationConflictRecordKeys {
  const bindingDigest = createMigrationDigest({
    kind: 'workspace-search-full-verification-run-binding',
    version: fullVerificationRecordKeyVersion,
    stateTableId: input.stateTableId,
    configurationHash: input.configurationHash,
    runId: input.runId,
    executionRunDigest: input.executionRunDigest,
    sealedPlanningAuthorityDigest:
      input.sealedPlanningAuthorityDigest,
  })
  return {
    bindingDigest,
    state: `${fullVerificationStateRecordKeyPrefix}/${bindingDigest}`,
    root:
      `${fullVerificationVerifiedRootRecordKeyPrefix}/${bindingDigest}`,
  }
}
