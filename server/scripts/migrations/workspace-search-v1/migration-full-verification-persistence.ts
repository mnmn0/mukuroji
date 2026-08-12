import { Buffer } from 'node:buffer'
import { types as nodeUtilTypes } from 'node:util'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  type EncodedAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createWorkspaceSearchMigrationApplyCheckpointSnapshot,
  decodeWorkspaceSearchMigrationApplyCheckpointSnapshot,
  type WorkspaceSearchMigrationApplyCheckpointSnapshot,
} from './migration-apply-checkpoint-receipt'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  MigrationDigestAccumulator,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type MigrationDigestState,
  type MigrationScanAggregate,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTableRole,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  type WorkspaceSearchMigrationFullVerificationProgress,
  type WorkspaceSearchMigrationFullVerificationResult,
  type WorkspaceSearchMigrationVerificationBindingAggregate,
  WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
} from './migration-full-verification'
import {
  createWorkspaceSearchMigrationSourceCheckpointDigest,
} from './migration-source-evidence'
import {
  createEmptyWorkspaceSearchMigrationTraversal,
  type WorkspaceSearchMigrationCheckpointLocation,
  validateWorkspaceSearchMigrationCheckpoint,
} from './migration-state-machine'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Schema version of every full-verification persistence contract. */
export const WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION =
  1

/** Maximum canonical bytes accepted for one compact plan-artifact binding. */
export const WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PLAN_BINDING_MAX_BYTES =
  32 * 1024

/** Maximum canonical bytes accepted for one resumable verification state. */
export const WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_STATE_MAX_BYTES =
  256 * 1024

/** Maximum canonical bytes accepted for one immutable page receipt. */
export const WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RECEIPT_MAX_BYTES =
  384 * 1024

/** Maximum canonical bytes accepted for one immutable verified root. */
export const WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_ROOT_MAX_BYTES =
  128 * 1024

/** Maximum canonical bytes accepted for one terminal verification result. */
export const WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RESULT_MAX_BYTES =
  512 * 1024

const maximumSafeGraphDepth = 64
const maximumSafeGraphNodes = 100_000
const maximumReferenceTextLength = 1_024
const tableRoles: readonly WorkspaceSearchMigrationTableRole[] = [
  ...workspaceSearchMigrationSourceNames,
  'workspace-search',
  'migration-state',
]

/**
 * Stable raw-value-free failure for an invalid verification persistence value.
 */
export class WorkspaceSearchMigrationFullVerificationPersistenceError
  extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code = 'INVALID_FULL_VERIFICATION_PERSISTENCE'

  /** Creates one stable persistence-contract failure. */
  constructor() {
    super('INVALID_FULL_VERIFICATION_PERSISTENCE')
    this.name =
      'WorkspaceSearchMigrationFullVerificationPersistenceError'
  }
}

/**
 * Exact immutable object reference retained by verification persistence.
 */
export type WorkspaceSearchMigrationFullVerificationArtifactReference = {
  /** Exact content-addressed object key. */
  readonly objectKey: string
  /** Exact immutable object version identifier. */
  readonly versionId: string
  /** SHA-256 digest of the exact stored bytes. */
  readonly contentDigest: string
  /** Exact stored byte length. */
  readonly byteLength: number
  /** Canonical immutable-retention deadline. */
  readonly retainUntil: string
}

/**
 * Rich exact-version reference to one semantic verification-result envelope.
 */
export type WorkspaceSearchMigrationFullVerificationResultArtifactReference = {
  /** Verification-result reference discriminator. */
  readonly kind:
    'workspace-search-migration-verification-result-artifact-reference'
  /** Verification-result reference schema version. */
  readonly artifactVersion: 1
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Applied root bound into the stored semantic envelope. */
  readonly appliedRootDigest: string
  /** Semantic successful verification-result digest. */
  readonly verificationResultDigest: string
  /** Self digest of the exact stored semantic envelope. */
  readonly envelopeDigest: string
  /** Exact content-addressed object key. */
  readonly objectKey: string
  /** Exact immutable object version identifier. */
  readonly versionId: string
  /** SHA-256 digest of the exact stored envelope bytes. */
  readonly contentDigest: string
  /** Exact stored envelope byte length. */
  readonly byteLength: number
  /** Canonical immutable-retention deadline. */
  readonly retainUntil: string
}

/**
 * Fixed physical table incarnations owned by one verification run.
 */
export type WorkspaceSearchMigrationFullVerificationTableIds = Readonly<
  Record<WorkspaceSearchMigrationTableRole, string>
>

/**
 * Compact exact binding to the reviewed plan seal and replay manifest.
 */
export type WorkspaceSearchMigrationFullVerificationPlanArtifactBinding = {
  /** Plan-binding discriminator. */
  readonly kind:
    'workspace-search-migration-full-verification-plan-artifact-binding'
  /** Plan-binding schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** Digest of the exact plan-derived verification expectation. */
  readonly verificationPlanDigest: string
  /** Digest of the exact sealed planning authority that published the plan. */
  readonly sealedPlanningAuthorityDigest: string
  /** Exact immutable reference to the canonical plan seal. */
  readonly planSealReference:
    WorkspaceSearchMigrationFullVerificationArtifactReference
  /** Exact immutable reference to the compact plan manifest head. */
  readonly planManifestHeadReference:
    WorkspaceSearchMigrationFullVerificationArtifactReference
  /** Digest of every preceding plan-artifact binding field. */
  readonly bindingDigest: string
}

/**
 * JSON-safe source-and-target traversal retained in durable verification state.
 */
export type WorkspaceSearchMigrationFullVerificationTraversalSnapshot = {
  /** Per-source checkpoint snapshots with tagged DynamoDB cursors. */
  readonly sources: Readonly<
    Record<
      WorkspaceSearchMigrationSourceName,
      WorkspaceSearchMigrationApplyCheckpointSnapshot
    >
  >
  /** Target checkpoint snapshot with an optional tagged DynamoDB cursor. */
  readonly target: WorkspaceSearchMigrationApplyCheckpointSnapshot
}

/**
 * Lossless JSON-safe snapshot of the complete pure-kernel progress value.
 */
export type WorkspaceSearchMigrationFullVerificationProgressSnapshot = {
  /** Verification-progress discriminator. */
  readonly kind: 'workspace-search-migration-full-verification-progress'
  /** Verification-progress schema version. */
  readonly verificationVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** Digest of the exact plan-derived verification expectation. */
  readonly verificationPlanDigest: string
  /** Complete five-location traversal with tagged checkpoint cursors. */
  readonly traversal:
    WorkspaceSearchMigrationFullVerificationTraversalSnapshot
  /** Observed source-binding accumulator states. */
  readonly sourceBindings: Readonly<
    Record<WorkspaceSearchMigrationSourceName, MigrationDigestState>
  >
  /** Observed target-binding accumulator state. */
  readonly targetPresentBindings: MigrationDigestState
}

/**
 * Identifies the immutable root immediately preceding a verification state.
 */
export type WorkspaceSearchMigrationFullVerificationStatePredecessorKind =
  | 'applied-root'
  | 'verification-state'

/**
 * Resumable state whose complete progress is chained to one immutable apply.
 */
export type WorkspaceSearchMigrationFullVerificationPersistenceState = {
  /** Verification-state discriminator. */
  readonly kind: 'workspace-search-migration-full-verification-state'
  /** Verification-state schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** Digest of the compact exact plan-artifact binding. */
  readonly planArtifactBindingDigest: string
  /** Digest of the exact sealed planning authority that published the plan. */
  readonly sealedPlanningAuthorityDigest: string
  /** Immutable applied root verified by every page. */
  readonly appliedRootDigest: string
  /** Digest of the exact plan-derived verification expectation. */
  readonly verificationPlanDigest: string
  /** Positive successor revision after one committed verification page. */
  readonly revision: number
  /** Kind of immutable predecessor consumed by the page command. */
  readonly predecessorKind:
    WorkspaceSearchMigrationFullVerificationStatePredecessorKind
  /** Exact applied-root or predecessor-state digest. */
  readonly predecessorDigest: string
  /** Deterministic digest of the page command that created this state. */
  readonly lastCommandDigest: string
  /** Complete lossless verification progress after that page. */
  readonly progress:
    WorkspaceSearchMigrationFullVerificationProgressSnapshot
  /** Digest of the exact complete progress snapshot. */
  readonly progressDigest: string
  /** Digest of every preceding resumable state field. */
  readonly stateDigest: string
}

/**
 * Input used to create one compact exact plan-artifact binding.
 */
export type CreateWorkspaceSearchMigrationFullVerificationPlanArtifactBindingInput = {
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** Digest of the exact plan-derived verification expectation. */
  readonly verificationPlanDigest: string
  /** Digest of the exact sealed planning authority that published the plan. */
  readonly sealedPlanningAuthorityDigest: string
  /** Exact immutable canonical plan-seal reference. */
  readonly planSealReference:
    WorkspaceSearchMigrationFullVerificationArtifactReference
  /** Exact immutable compact plan-manifest-head reference. */
  readonly planManifestHeadReference:
    WorkspaceSearchMigrationFullVerificationArtifactReference
}

/**
 * Input used to create one resumable verification state.
 */
export type CreateWorkspaceSearchMigrationFullVerificationPersistenceStateInput = {
  /** Compact exact binding to the replayed plan artifacts. */
  readonly planArtifactBinding:
    WorkspaceSearchMigrationFullVerificationPlanArtifactBinding
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
  /** Immutable applied root being independently verified. */
  readonly appliedRootDigest: string
  /** Positive successor revision after the committed page. */
  readonly revision: number
  /** Kind of immutable predecessor consumed by the page command. */
  readonly predecessorKind:
    WorkspaceSearchMigrationFullVerificationStatePredecessorKind
  /** Exact applied-root or predecessor-state digest. */
  readonly predecessorDigest: string
  /** Deterministic digest of the committed page command. */
  readonly lastCommandDigest: string
  /** Complete pure-kernel successor progress. */
  readonly progress: WorkspaceSearchMigrationFullVerificationProgress
}

/**
 * Input used to derive one deterministic verification-page command identity.
 */
export type CreateWorkspaceSearchMigrationFullVerificationPageCommandIdentityInput = {
  /** Compact exact binding to the replayed plan artifacts. */
  readonly planArtifactBinding:
    WorkspaceSearchMigrationFullVerificationPlanArtifactBinding
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
  /** Immutable applied root being independently verified. */
  readonly appliedRootDigest: string
  /** Source or target traversal selected by this command. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
  /** Exact predecessor revision, zero for the applied root. */
  readonly expectedRevision: number
  /** Exact applied-root or predecessor-state digest. */
  readonly predecessorDigest: string
  /** Complete pure-kernel predecessor progress. */
  readonly predecessorProgress:
    WorkspaceSearchMigrationFullVerificationProgress
}

/**
 * Deterministic identity of one exact verification-page transition.
 */
export type WorkspaceSearchMigrationFullVerificationPageCommandIdentity = {
  /** Verification-page command discriminator. */
  readonly kind:
    'workspace-search-migration-full-verification-page-command'
  /** Command schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** Digest of the compact exact plan-artifact binding. */
  readonly planArtifactBindingDigest: string
  /** Digest of the exact sealed planning authority that published the plan. */
  readonly sealedPlanningAuthorityDigest: string
  /** Immutable applied root being independently verified. */
  readonly appliedRootDigest: string
  /** Digest of the exact plan-derived verification expectation. */
  readonly verificationPlanDigest: string
  /** Source or target traversal selected by this command. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
  /** Exact predecessor revision, zero for the applied root. */
  readonly expectedRevision: number
  /** Exact applied-root or predecessor-state digest. */
  readonly predecessorDigest: string
  /** Digest of the complete predecessor progress snapshot. */
  readonly predecessorProgressDigest: string
  /** Digest of every preceding deterministic command field. */
  readonly commandDigest: string
}

/**
 * Applied-root predecessor material for the first verification page.
 */
export type WorkspaceSearchMigrationFullVerificationAppliedRootPredecessor = {
  /** Direct applied-root predecessor discriminator. */
  readonly kind: 'applied-root'
  /** Exact canonical initial pure-kernel progress. */
  readonly progress: WorkspaceSearchMigrationFullVerificationProgress
}

/**
 * Resumable-state predecessor material for a later verification page.
 */
export type WorkspaceSearchMigrationFullVerificationStatePredecessor = {
  /** Resumable verification-state predecessor discriminator. */
  readonly kind: 'verification-state'
  /** Exact strict predecessor state consumed by the transaction. */
  readonly state:
    WorkspaceSearchMigrationFullVerificationPersistenceState
}

/**
 * Exact predecessor supplied while constructing one immutable page receipt.
 */
export type WorkspaceSearchMigrationFullVerificationPagePredecessor =
  | WorkspaceSearchMigrationFullVerificationAppliedRootPredecessor
  | WorkspaceSearchMigrationFullVerificationStatePredecessor

/**
 * Input used to create one immutable verification-page receipt.
 */
export type CreateWorkspaceSearchMigrationFullVerificationPageReceiptInput = {
  /** Deterministic identity of the exact page transition. */
  readonly commandIdentity:
    WorkspaceSearchMigrationFullVerificationPageCommandIdentity
  /** Exact applied-root or resumable-state predecessor. */
  readonly predecessor:
    WorkspaceSearchMigrationFullVerificationPagePredecessor
  /** Exact resumable successor state committed by the transaction. */
  readonly successorState:
    WorkspaceSearchMigrationFullVerificationPersistenceState
  /** Adapter-owned canonical UTC transaction time. */
  readonly committedAt: string
}

/**
 * Immutable receipt binding both sides of one verification-page transition.
 */
export type WorkspaceSearchMigrationFullVerificationPageReceipt = {
  /** Verification-page receipt discriminator. */
  readonly kind:
    'workspace-search-migration-full-verification-page-receipt'
  /** Receipt schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** Digest of the compact exact plan-artifact binding. */
  readonly planArtifactBindingDigest: string
  /** Digest of the exact sealed planning authority that published the plan. */
  readonly sealedPlanningAuthorityDigest: string
  /** Immutable applied root being independently verified. */
  readonly appliedRootDigest: string
  /** Digest of the exact plan-derived verification expectation. */
  readonly verificationPlanDigest: string
  /** Source or target traversal advanced by this receipt. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
  /** Digest of the deterministic page command. */
  readonly commandDigest: string
  /** Exact predecessor revision, zero for the applied root. */
  readonly predecessorRevision: number
  /** Kind of immutable predecessor consumed by the transaction. */
  readonly predecessorKind:
    WorkspaceSearchMigrationFullVerificationStatePredecessorKind
  /** Exact applied-root or predecessor-state digest. */
  readonly predecessorDigest: string
  /** Prior command digest for state predecessors, or null for applied root. */
  readonly predecessorCommandDigest: string | null
  /** Exact selected predecessor cursor, or null before/after no cursor. */
  readonly predecessorCursor: EncodedAttributeMap | null
  /** Exact selected predecessor checkpoint snapshot. */
  readonly predecessorCheckpoint:
    WorkspaceSearchMigrationApplyCheckpointSnapshot
  /** Digest of the exact selected predecessor checkpoint. */
  readonly predecessorCheckpointDigest: string
  /** Complete exact predecessor progress snapshot. */
  readonly predecessorProgress:
    WorkspaceSearchMigrationFullVerificationProgressSnapshot
  /** Digest of the complete predecessor progress snapshot. */
  readonly predecessorProgressDigest: string
  /** Exact positive successor-state revision. */
  readonly successorRevision: number
  /** Complete exact successor progress snapshot. */
  readonly successorProgress:
    WorkspaceSearchMigrationFullVerificationProgressSnapshot
  /** Digest of the complete successor progress snapshot. */
  readonly successorProgressDigest: string
  /** Digest of the exact successor verification state. */
  readonly successorStateDigest: string
  /** Adapter-owned canonical UTC transaction time. */
  readonly committedAt: string
  /** Digest of every preceding immutable receipt field. */
  readonly receiptDigest: string
}

/**
 * Exact authority condition retained by immutable verified publication.
 */
export type WorkspaceSearchMigrationFullVerificationPublicationAuthority = {
  /** Current exclusive migration owner. */
  readonly ownerId: string
  /** Current monotonically increasing lease fence. */
  readonly fenceToken: number
  /** Current maintenance-evidence pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the exact current immutable maintenance receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Canonical time at which this exact authority snapshot was evaluated. */
  readonly evaluatedAt: string
}

/**
 * Input used to construct one immutable authoritative verified root.
 */
export type CreateWorkspaceSearchMigrationFullVerificationVerifiedRootInput = {
  /** Compact exact binding to the replayed plan artifacts. */
  readonly planArtifactBinding:
    WorkspaceSearchMigrationFullVerificationPlanArtifactBinding
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
  /** Immutable applied root independently verified by every page. */
  readonly appliedRootDigest: string
  /** Strict terminal pure-kernel verification result. */
  readonly verificationResult:
    WorkspaceSearchMigrationFullVerificationResult
  /** Exact immutable object reference to the semantic result envelope. */
  readonly verificationResultReference:
    WorkspaceSearchMigrationFullVerificationResultArtifactReference
  /** Exact terminal resumable verification state. */
  readonly terminalState:
    WorkspaceSearchMigrationFullVerificationPersistenceState
  /** Exact immutable receipt that created the terminal state. */
  readonly terminalReceipt:
    WorkspaceSearchMigrationFullVerificationPageReceipt
  /** Digest of the exact sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Authority atomically checked during verified-root publication. */
  readonly publicationAuthority:
    WorkspaceSearchMigrationFullVerificationPublicationAuthority
  /** Adapter-owned canonical UTC publication time. */
  readonly verifiedAt: string
}

/**
 * Immutable authoritative root binding one applied root to one exact result.
 */
export type WorkspaceSearchMigrationFullVerificationVerifiedRoot = {
  /** Verified-root discriminator. */
  readonly kind:
    'workspace-search-migration-full-verification-verified-root'
  /** Verified-root schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
  /** Merkle root of the exact replayed operation plan. */
  readonly planDigest: string
  /** Digest of the exact plan-derived verification expectation. */
  readonly verificationPlanDigest: string
  /** Immutable applied root independently verified by every page. */
  readonly appliedRootDigest: string
  /** Domain digest of the exact successful verification result. */
  readonly verificationResultDigest: string
  /** Exact immutable reference to the semantic result envelope. */
  readonly verificationResultReference:
    WorkspaceSearchMigrationFullVerificationResultArtifactReference
  /** Digest of the exact terminal resumable verification state. */
  readonly terminalStateDigest: string
  /** Digest of the exact immutable terminal page receipt. */
  readonly terminalReceiptDigest: string
  /** Canonical commit time carried by the exact terminal page receipt. */
  readonly terminalReceiptCommittedAt: string
  /** Complete compact exact binding to the replayed plan artifacts. */
  readonly planArtifactBinding:
    WorkspaceSearchMigrationFullVerificationPlanArtifactBinding
  /** Digest of the exact sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Authority atomically checked during publication. */
  readonly publicationAuthority:
    WorkspaceSearchMigrationFullVerificationPublicationAuthority
  /** Adapter-owned canonical UTC publication time. */
  readonly verifiedAt: string
  /** Digest of every preceding immutable verified-root field. */
  readonly verifiedRootDigest: string
}

/**
 * Creates one compact exact binding to the two replay-critical plan artifacts.
 *
 * @param input - Exact run identity and immutable artifact references.
 * @returns Detached strict plan-artifact binding.
 */
export function createWorkspaceSearchMigrationFullVerificationPlanArtifactBinding(
  input:
    CreateWorkspaceSearchMigrationFullVerificationPlanArtifactBindingInput,
): WorkspaceSearchMigrationFullVerificationPlanArtifactBinding {
  return atPersistenceBoundary(() => {
    const record = requireExactRecord(input, [
      'configurationHash',
      'planDigest',
      'planManifestHeadReference',
      'planSealReference',
      'runId',
      'sealedPlanningAuthorityDigest',
      'verificationPlanDigest',
    ])
    const fields = {
      kind:
        'workspace-search-migration-full-verification-plan-artifact-binding',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: readIdentifier(readOwn(record, 'runId')),
      configurationHash: readDigest(
        readOwn(record, 'configurationHash'),
      ),
      planDigest: readDigest(readOwn(record, 'planDigest')),
      verificationPlanDigest: readDigest(
        readOwn(record, 'verificationPlanDigest'),
      ),
      sealedPlanningAuthorityDigest: readDigest(
        readOwn(record, 'sealedPlanningAuthorityDigest'),
      ),
      planSealReference: readArtifactReference(
        readOwn(record, 'planSealReference'),
      ),
      planManifestHeadReference: readArtifactReference(
        readOwn(record, 'planManifestHeadReference'),
      ),
    } satisfies Omit<
      WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
      'bindingDigest'
    >
    if (
      fields.planSealReference.retainUntil !==
        fields.planManifestHeadReference.retainUntil
    ) {
      return failPersistence()
    }
    const binding = {
      ...fields,
      bindingDigest: createMigrationDigest(fields),
    }
    void encodeValue(
      binding,
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PLAN_BINDING_MAX_BYTES,
    )
    return binding
  })
}

/**
 * Serializes one compact plan-artifact binding as exact canonical JSON bytes.
 *
 * @param value - Candidate strict plan-artifact binding.
 * @returns Exact bounded canonical UTF-8 bytes.
 */
export function serializeWorkspaceSearchMigrationFullVerificationPlanArtifactBinding(
  value: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
): Uint8Array {
  return atPersistenceBoundary(() =>
    encodeValue(
      readPlanArtifactBinding(value),
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PLAN_BINDING_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical compact plan-artifact binding.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict plan-artifact binding.
 */
export function parseWorkspaceSearchMigrationFullVerificationPlanArtifactBinding(
  bytes: Uint8Array,
): WorkspaceSearchMigrationFullVerificationPlanArtifactBinding {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PLAN_BINDING_MAX_BYTES,
    readPlanArtifactBinding,
  )
}

/**
 * Validates and detaches one rich verification-result envelope reference.
 *
 * @param value - Candidate exact-version semantic-envelope reference.
 * @returns Detached strict rich result-artifact reference.
 */
export function validateWorkspaceSearchMigrationFullVerificationResultArtifactReference(
  value: WorkspaceSearchMigrationFullVerificationResultArtifactReference,
): WorkspaceSearchMigrationFullVerificationResultArtifactReference {
  return atPersistenceBoundary(() =>
    readVerificationResultArtifactReference(value)
  )
}

/**
 * Creates one lossless JSON-safe snapshot from pure-kernel progress.
 *
 * @param progress - Candidate complete progress with raw DynamoDB cursors.
 * @returns Detached strict progress snapshot with tagged cursors.
 */
export function createWorkspaceSearchMigrationFullVerificationProgressSnapshot(
  progress: WorkspaceSearchMigrationFullVerificationProgress,
): WorkspaceSearchMigrationFullVerificationProgressSnapshot {
  return atPersistenceBoundary(() => snapshotProgress(progress))
}

/**
 * Restores pure-kernel progress from one tagged-cursor persistence snapshot.
 *
 * @param snapshot - Candidate complete JSON-safe progress snapshot.
 * @returns Detached strict pure-kernel progress with raw DynamoDB cursors.
 */
export function decodeWorkspaceSearchMigrationFullVerificationProgressSnapshot(
  snapshot: WorkspaceSearchMigrationFullVerificationProgressSnapshot,
): WorkspaceSearchMigrationFullVerificationProgress {
  return atPersistenceBoundary(() => restoreProgress(snapshot))
}

/**
 * Creates one deterministic identity for an exact verification-page command.
 *
 * @param input - Exact root, plan, table, predecessor, revision, and location.
 * @returns Detached content-addressed command identity.
 */
export function createWorkspaceSearchMigrationFullVerificationPageCommandIdentity(
  input:
    CreateWorkspaceSearchMigrationFullVerificationPageCommandIdentityInput,
): WorkspaceSearchMigrationFullVerificationPageCommandIdentity {
  return atPersistenceBoundary(() => {
    const record = requireExactRecord(input, [
      'appliedRootDigest',
      'expectedRevision',
      'location',
      'planArtifactBinding',
      'predecessorDigest',
      'predecessorProgress',
      'tableIds',
    ])
    const binding = readPlanArtifactBinding(
      readOwn(record, 'planArtifactBinding'),
    )
    const tableIds = readTableIds(readOwn(record, 'tableIds'))
    const appliedRootDigest = readDigest(
      readOwn(record, 'appliedRootDigest'),
    )
    const expectedRevision = readNonNegativeSafeInteger(
      readOwn(record, 'expectedRevision'),
    )
    if (expectedRevision === Number.MAX_SAFE_INTEGER) {
      return failPersistence()
    }
    const predecessorDigest = readDigest(
      readOwn(record, 'predecessorDigest'),
    )
    if (
      expectedRevision === 0 &&
      predecessorDigest !== appliedRootDigest
    ) {
      return failPersistence()
    }
    const predecessorProgress = snapshotProgress(
      readOwn(record, 'predecessorProgress'),
    )
    requireProgressIdentity(predecessorProgress, binding)
    if (
      expectedRevision === 0 &&
      !isInitialProgress(predecessorProgress, binding)
    ) {
      return failPersistence()
    }
    const fields = {
      kind:
        'workspace-search-migration-full-verification-page-command',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: binding.runId,
      configurationHash: binding.configurationHash,
      tableIds,
      planDigest: binding.planDigest,
      planArtifactBindingDigest: binding.bindingDigest,
      sealedPlanningAuthorityDigest:
        binding.sealedPlanningAuthorityDigest,
      appliedRootDigest,
      verificationPlanDigest: binding.verificationPlanDigest,
      location: readLocation(readOwn(record, 'location')),
      expectedRevision,
      predecessorDigest,
      predecessorProgressDigest:
        createMigrationDigest(predecessorProgress),
    } satisfies Omit<
      WorkspaceSearchMigrationFullVerificationPageCommandIdentity,
      'commandDigest'
    >
    return {
      ...fields,
      commandDigest: createMigrationDigest(fields),
    }
  })
}

/**
 * Creates one resumable verification state after a committed page.
 *
 * @param input - Exact predecessor, command, root, plan, tables, and progress.
 * @returns Detached strict resumable state.
 */
export function createWorkspaceSearchMigrationFullVerificationPersistenceState(
  input:
    CreateWorkspaceSearchMigrationFullVerificationPersistenceStateInput,
): WorkspaceSearchMigrationFullVerificationPersistenceState {
  return atPersistenceBoundary(() => {
    const record = requireExactRecord(input, [
      'appliedRootDigest',
      'lastCommandDigest',
      'planArtifactBinding',
      'predecessorDigest',
      'predecessorKind',
      'progress',
      'revision',
      'tableIds',
    ])
    const binding = readPlanArtifactBinding(
      readOwn(record, 'planArtifactBinding'),
    )
    const appliedRootDigest = readDigest(
      readOwn(record, 'appliedRootDigest'),
    )
    const revision = readPositiveSafeInteger(
      readOwn(record, 'revision'),
    )
    const predecessorKind = readPredecessorKind(
      readOwn(record, 'predecessorKind'),
    )
    const predecessorDigest = readDigest(
      readOwn(record, 'predecessorDigest'),
    )
    if (
      (
        revision === 1 &&
        (
          predecessorKind !== 'applied-root' ||
          predecessorDigest !== appliedRootDigest
        )
      ) ||
      (
        revision > 1 &&
        predecessorKind !== 'verification-state'
      )
    ) {
      return failPersistence()
    }
    const progress = snapshotProgress(
      readOwn(record, 'progress'),
    )
    requireProgressIdentity(progress, binding)
    const fields = {
      kind: 'workspace-search-migration-full-verification-state',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: binding.runId,
      configurationHash: binding.configurationHash,
      tableIds: readTableIds(readOwn(record, 'tableIds')),
      planDigest: binding.planDigest,
      planArtifactBindingDigest: binding.bindingDigest,
      sealedPlanningAuthorityDigest:
        binding.sealedPlanningAuthorityDigest,
      appliedRootDigest,
      verificationPlanDigest: binding.verificationPlanDigest,
      revision,
      predecessorKind,
      predecessorDigest,
      lastCommandDigest: readDigest(
        readOwn(record, 'lastCommandDigest'),
      ),
      progress,
      progressDigest: createMigrationDigest(progress),
    } satisfies Omit<
      WorkspaceSearchMigrationFullVerificationPersistenceState,
      'stateDigest'
    >
    const state = {
      ...fields,
      stateDigest: createMigrationDigest(fields),
    }
    void encodeValue(
      state,
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_STATE_MAX_BYTES,
    )
    return state
  })
}

/**
 * Serializes one resumable verification state as exact canonical JSON bytes.
 *
 * @param value - Candidate strict resumable state.
 * @returns Exact bounded canonical UTF-8 bytes.
 */
export function serializeWorkspaceSearchMigrationFullVerificationPersistenceState(
  value: WorkspaceSearchMigrationFullVerificationPersistenceState,
): Uint8Array {
  return atPersistenceBoundary(() =>
    encodeValue(
      readPersistenceState(value),
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_STATE_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical resumable verification state.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict resumable state.
 */
export function parseWorkspaceSearchMigrationFullVerificationPersistenceState(
  bytes: Uint8Array,
): WorkspaceSearchMigrationFullVerificationPersistenceState {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_STATE_MAX_BYTES,
    readPersistenceState,
  )
}

/**
 * Creates one immutable receipt for an exact verification-page transition.
 *
 * @param input - Exact command, predecessor, successor, and commit time.
 * @returns Detached strict immutable page receipt.
 */
export function createWorkspaceSearchMigrationFullVerificationPageReceipt(
  input:
    CreateWorkspaceSearchMigrationFullVerificationPageReceiptInput,
): WorkspaceSearchMigrationFullVerificationPageReceipt {
  return atPersistenceBoundary(() => {
    const record = requireExactRecord(input, [
      'commandIdentity',
      'committedAt',
      'predecessor',
      'successorState',
    ])
    const command = readCommandIdentity(
      readOwn(record, 'commandIdentity'),
    )
    const successorState = readPersistenceState(
      readOwn(record, 'successorState'),
    )
    const predecessor = readPagePredecessor(
      readOwn(record, 'predecessor'),
      command,
    )
    requireSuccessorForCommand(
      command,
      predecessor,
      successorState,
    )
    const predecessorCheckpoint = selectCheckpoint(
      predecessor.progress,
      command.location,
    )
    const predecessorCursor =
      predecessorCheckpoint.cursor === undefined
        ? null
        : cloneEncodedCursor(predecessorCheckpoint.cursor)
    const fields = {
      kind:
        'workspace-search-migration-full-verification-page-receipt',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: command.runId,
      configurationHash: command.configurationHash,
      tableIds: command.tableIds,
      planDigest: command.planDigest,
      planArtifactBindingDigest:
        command.planArtifactBindingDigest,
      sealedPlanningAuthorityDigest:
        command.sealedPlanningAuthorityDigest,
      appliedRootDigest: command.appliedRootDigest,
      verificationPlanDigest: command.verificationPlanDigest,
      location: command.location,
      commandDigest: command.commandDigest,
      predecessorRevision: command.expectedRevision,
      predecessorKind: predecessor.kind,
      predecessorDigest: command.predecessorDigest,
      predecessorCommandDigest: predecessor.commandDigest,
      predecessorCursor,
      predecessorCheckpoint,
      predecessorCheckpointDigest:
        createMigrationDigest(predecessorCheckpoint),
      predecessorProgress: predecessor.progress,
      predecessorProgressDigest:
        command.predecessorProgressDigest,
      successorRevision: successorState.revision,
      successorProgress: successorState.progress,
      successorProgressDigest: successorState.progressDigest,
      successorStateDigest: successorState.stateDigest,
      committedAt: readTimestamp(readOwn(record, 'committedAt')),
    } satisfies Omit<
      WorkspaceSearchMigrationFullVerificationPageReceipt,
      'receiptDigest'
    >
    const receipt = {
      ...fields,
      receiptDigest: createMigrationDigest(fields),
    }
    void encodeValue(
      receipt,
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RECEIPT_MAX_BYTES,
    )
    return receipt
  })
}

/**
 * Serializes one immutable page receipt as exact canonical JSON bytes.
 *
 * @param value - Candidate strict page receipt.
 * @returns Exact bounded canonical UTF-8 bytes.
 */
export function serializeWorkspaceSearchMigrationFullVerificationPageReceipt(
  value: WorkspaceSearchMigrationFullVerificationPageReceipt,
): Uint8Array {
  return atPersistenceBoundary(() =>
    encodeValue(
      readPageReceipt(value),
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RECEIPT_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical immutable verification-page receipt.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict immutable page receipt.
 */
export function parseWorkspaceSearchMigrationFullVerificationPageReceipt(
  bytes: Uint8Array,
): WorkspaceSearchMigrationFullVerificationPageReceipt {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RECEIPT_MAX_BYTES,
    readPageReceipt,
  )
}

/**
 * Replays one receipt against its exact predecessor and successor state.
 *
 * This cross-link check is required after independently parsing a receipt and
 * its adjacent state records.
 *
 * @param receipt - Candidate strict immutable page receipt.
 * @param predecessor - Exact applied-root or state predecessor.
 * @param successorState - Exact resumable successor state.
 * @returns Detached strict receipt after full transition replay.
 */
export function validateWorkspaceSearchMigrationFullVerificationPageReceiptTransition(
  receipt: WorkspaceSearchMigrationFullVerificationPageReceipt,
  predecessor: WorkspaceSearchMigrationFullVerificationPagePredecessor,
  successorState:
    WorkspaceSearchMigrationFullVerificationPersistenceState,
): WorkspaceSearchMigrationFullVerificationPageReceipt {
  return atPersistenceBoundary(() => {
    const strict = readPageReceipt(receipt)
    const command = commandIdentityFromReceipt(strict)
    const replayed =
      createWorkspaceSearchMigrationFullVerificationPageReceipt({
        commandIdentity: command,
        predecessor,
        successorState,
        committedAt: strict.committedAt,
      })
    if (!sameCanonical(strict, replayed)) {
      return failPersistence()
    }
    return strict
  })
}

/**
 * Serializes one strict terminal verification result artifact.
 *
 * @param value - Candidate successful pure-kernel verification result.
 * @returns Exact bounded canonical UTF-8 result bytes.
 */
export function serializeWorkspaceSearchMigrationFullVerificationResultArtifact(
  value: WorkspaceSearchMigrationFullVerificationResult,
): Uint8Array {
  return atPersistenceBoundary(() =>
    encodeValue(
      readVerificationResult(value),
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RESULT_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical terminal verification result artifact.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 result bytes.
 * @returns Detached strict successful verification result.
 */
export function parseWorkspaceSearchMigrationFullVerificationResultArtifact(
  bytes: Uint8Array,
): WorkspaceSearchMigrationFullVerificationResult {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_RESULT_MAX_BYTES,
    readVerificationResult,
  )
}

/**
 * Creates one immutable authoritative root for a successful verification.
 *
 * Precondition: the concrete persistence adapter has replayed the complete
 * applied-root-to-terminal receipt chain. This constructor cross-checks the
 * supplied terminal edge and immutable publication bindings, but it does not
 * replace adapter-owned reads of every predecessor receipt and state.
 *
 * @param input - Exact plan, apply, result, terminal chain, and authority.
 * @returns Detached strict immutable verified root.
 */
export function createWorkspaceSearchMigrationFullVerificationVerifiedRoot(
  input:
    CreateWorkspaceSearchMigrationFullVerificationVerifiedRootInput,
): WorkspaceSearchMigrationFullVerificationVerifiedRoot {
  return atPersistenceBoundary(() => {
    const record = requireExactRecord(input, [
      'appliedRootDigest',
      'planArtifactBinding',
      'publicationAuthority',
      'sealedPlanningAuthorityDigest',
      'tableIds',
      'terminalReceipt',
      'terminalState',
      'verificationResult',
      'verificationResultReference',
      'verifiedAt',
    ])
    const binding = readPlanArtifactBinding(
      readOwn(record, 'planArtifactBinding'),
    )
    const tableIds = readTableIds(readOwn(record, 'tableIds'))
    const appliedRootDigest = readDigest(
      readOwn(record, 'appliedRootDigest'),
    )
    const result = readVerificationResult(
      readOwn(record, 'verificationResult'),
    )
    const terminalState = readPersistenceState(
      readOwn(record, 'terminalState'),
    )
    const terminalReceipt = readPageReceipt(
      readOwn(record, 'terminalReceipt'),
    )
    const sealedPlanningAuthorityDigest = readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    )
    const verifiedAt = readTimestamp(readOwn(record, 'verifiedAt'))
    const publicationAuthority = readPublicationAuthority(
      readOwn(record, 'publicationAuthority'),
    )
    const resultReference = readVerificationResultArtifactReference(
      readOwn(record, 'verificationResultReference'),
    )
    if (
      resultReference.runId !== binding.runId ||
      resultReference.configurationHash !== binding.configurationHash ||
      resultReference.appliedRootDigest !== appliedRootDigest ||
      resultReference.verificationResultDigest !== result.resultDigest ||
      resultReference.retainUntil !==
        binding.planSealReference.retainUntil ||
      Date.parse(binding.planSealReference.retainUntil) <=
        Date.parse(verifiedAt) ||
      Date.parse(binding.planManifestHeadReference.retainUntil) <=
        Date.parse(verifiedAt) ||
      Date.parse(terminalReceipt.committedAt) >
        Date.parse(publicationAuthority.evaluatedAt) ||
      Date.parse(publicationAuthority.evaluatedAt) >
        Date.parse(verifiedAt)
    ) {
      return failPersistence()
    }
    requireTerminalPublicationBindings({
      appliedRootDigest,
      binding,
      result,
      sealedPlanningAuthorityDigest,
      tableIds,
      terminalReceipt,
      terminalState,
    })
    const fields = {
      kind:
        'workspace-search-migration-full-verification-verified-root',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: binding.runId,
      configurationHash: binding.configurationHash,
      tableIds,
      planDigest: binding.planDigest,
      verificationPlanDigest: binding.verificationPlanDigest,
      appliedRootDigest,
      verificationResultDigest: result.resultDigest,
      verificationResultReference: resultReference,
      terminalStateDigest: terminalState.stateDigest,
      terminalReceiptDigest: terminalReceipt.receiptDigest,
      terminalReceiptCommittedAt: terminalReceipt.committedAt,
      planArtifactBinding: binding,
      sealedPlanningAuthorityDigest,
      publicationAuthority,
      verifiedAt,
    } satisfies Omit<
      WorkspaceSearchMigrationFullVerificationVerifiedRoot,
      'verifiedRootDigest'
    >
    const root = {
      ...fields,
      verifiedRootDigest: createMigrationDigest(fields),
    }
    void encodeValue(
      root,
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_ROOT_MAX_BYTES,
    )
    return root
  })
}

/**
 * Serializes one immutable verified root as exact canonical JSON bytes.
 *
 * @param value - Candidate strict immutable verified root.
 * @returns Exact bounded canonical UTF-8 bytes.
 */
export function serializeWorkspaceSearchMigrationFullVerificationVerifiedRoot(
  value: WorkspaceSearchMigrationFullVerificationVerifiedRoot,
): Uint8Array {
  return atPersistenceBoundary(() =>
    encodeValue(
      readVerifiedRoot(value),
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_ROOT_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical immutable verified root.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict immutable verified root.
 */
export function parseWorkspaceSearchMigrationFullVerificationVerifiedRoot(
  bytes: Uint8Array,
): WorkspaceSearchMigrationFullVerificationVerifiedRoot {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_ROOT_MAX_BYTES,
    readVerifiedRoot,
  )
}

/**
 * Detached predecessor material used while constructing one page receipt.
 */
type DetachedPagePredecessor = {
  /** Exact predecessor-root discriminator. */
  readonly kind:
    WorkspaceSearchMigrationFullVerificationStatePredecessorKind
  /** Complete exact predecessor progress snapshot. */
  readonly progress:
    WorkspaceSearchMigrationFullVerificationProgressSnapshot
  /** Exact applied-root or predecessor-state digest. */
  readonly digest: string
  /** Prior command digest, or null for the direct applied-root predecessor. */
  readonly commandDigest: string | null
  /** Exact predecessor revision, zero for the applied root. */
  readonly revision: number
}

/**
 * Complete terminal-publication material checked before root construction.
 */
type TerminalPublicationBindings = {
  /** Immutable applied root independently verified by every page. */
  readonly appliedRootDigest: string
  /** Compact exact binding to the replayed plan artifacts. */
  readonly binding:
    WorkspaceSearchMigrationFullVerificationPlanArtifactBinding
  /** Strict successful pure-kernel verification result. */
  readonly result: WorkspaceSearchMigrationFullVerificationResult
  /** Digest of the exact sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
  /** Immutable receipt that created the terminal state. */
  readonly terminalReceipt:
    WorkspaceSearchMigrationFullVerificationPageReceipt
  /** Exact terminal resumable state. */
  readonly terminalState:
    WorkspaceSearchMigrationFullVerificationPersistenceState
}

/**
 * Mutable limits used while rejecting active or cyclic caller-owned graphs.
 */
type SafeGraphBudget = {
  /** Number of object nodes already inspected. */
  nodes: number
  /** Objects on the active traversal path. */
  readonly active: WeakSet<object>
  /** Objects whose complete descendants were inspected. */
  readonly visited: WeakSet<object>
}

/**
 * Reads and reconstructs one strict compact plan-artifact binding.
 *
 * @param value - Candidate runtime or parsed binding.
 * @returns Detached strict binding.
 */
function readPlanArtifactBinding(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationPlanArtifactBinding {
  const record = requireExactRecord(value, [
    'bindingDigest',
    'configurationHash',
    'kind',
    'migrationId',
    'migrationVersion',
    'persistenceVersion',
    'planDigest',
    'planManifestHeadReference',
    'planSealReference',
    'runId',
    'sealedPlanningAuthorityDigest',
    'verificationPlanDigest',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-full-verification-plan-artifact-binding' ||
    readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failPersistence()
  }
  const fields = {
    kind:
      'workspace-search-migration-full-verification-plan-artifact-binding',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    verificationPlanDigest: readDigest(
      readOwn(record, 'verificationPlanDigest'),
    ),
    sealedPlanningAuthorityDigest: readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    planSealReference: readArtifactReference(
      readOwn(record, 'planSealReference'),
    ),
    planManifestHeadReference: readArtifactReference(
      readOwn(record, 'planManifestHeadReference'),
    ),
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
    'bindingDigest'
  >
  if (
    fields.planSealReference.retainUntil !==
      fields.planManifestHeadReference.retainUntil
  ) {
    return failPersistence()
  }
  const bindingDigest = readDigest(
    readOwn(record, 'bindingDigest'),
  )
  if (bindingDigest !== createMigrationDigest(fields)) {
    return failPersistence()
  }
  return { ...fields, bindingDigest }
}

/**
 * Reads and reconstructs one strict deterministic command identity.
 *
 * @param value - Candidate runtime command identity.
 * @returns Detached strict command identity.
 */
function readCommandIdentity(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationPageCommandIdentity {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
    'commandDigest',
    'configurationHash',
    'expectedRevision',
    'kind',
    'location',
    'migrationId',
    'migrationVersion',
    'persistenceVersion',
    'planArtifactBindingDigest',
    'planDigest',
    'predecessorDigest',
    'predecessorProgressDigest',
    'runId',
    'sealedPlanningAuthorityDigest',
    'tableIds',
    'verificationPlanDigest',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-full-verification-page-command' ||
    readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failPersistence()
  }
  const expectedRevision = readNonNegativeSafeInteger(
    readOwn(record, 'expectedRevision'),
  )
  if (expectedRevision === Number.MAX_SAFE_INTEGER) {
    return failPersistence()
  }
  const appliedRootDigest = readDigest(
    readOwn(record, 'appliedRootDigest'),
  )
  const predecessorDigest = readDigest(
    readOwn(record, 'predecessorDigest'),
  )
  if (
    expectedRevision === 0 &&
    predecessorDigest !== appliedRootDigest
  ) {
    return failPersistence()
  }
  const fields = {
    kind:
      'workspace-search-migration-full-verification-page-command',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    planArtifactBindingDigest: readDigest(
      readOwn(record, 'planArtifactBindingDigest'),
    ),
    sealedPlanningAuthorityDigest: readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    appliedRootDigest,
    verificationPlanDigest: readDigest(
      readOwn(record, 'verificationPlanDigest'),
    ),
    location: readLocation(readOwn(record, 'location')),
    expectedRevision,
    predecessorDigest,
    predecessorProgressDigest: readDigest(
      readOwn(record, 'predecessorProgressDigest'),
    ),
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationPageCommandIdentity,
    'commandDigest'
  >
  const commandDigest = readDigest(
    readOwn(record, 'commandDigest'),
  )
  if (commandDigest !== createMigrationDigest(fields)) {
    return failPersistence()
  }
  return { ...fields, commandDigest }
}

/**
 * Reads and reconstructs one strict resumable verification state.
 *
 * @param value - Candidate runtime or parsed verification state.
 * @returns Detached strict resumable state.
 */
function readPersistenceState(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationPersistenceState {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
    'configurationHash',
    'kind',
    'lastCommandDigest',
    'migrationId',
    'migrationVersion',
    'persistenceVersion',
    'planArtifactBindingDigest',
    'planDigest',
    'predecessorDigest',
    'predecessorKind',
    'progress',
    'progressDigest',
    'revision',
    'runId',
    'sealedPlanningAuthorityDigest',
    'stateDigest',
    'tableIds',
    'verificationPlanDigest',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-full-verification-state' ||
    readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failPersistence()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const planDigest = readDigest(readOwn(record, 'planDigest'))
  const verificationPlanDigest = readDigest(
    readOwn(record, 'verificationPlanDigest'),
  )
  const appliedRootDigest = readDigest(
    readOwn(record, 'appliedRootDigest'),
  )
  const revision = readPositiveSafeInteger(
    readOwn(record, 'revision'),
  )
  const predecessorKind = readPredecessorKind(
    readOwn(record, 'predecessorKind'),
  )
  const predecessorDigest = readDigest(
    readOwn(record, 'predecessorDigest'),
  )
  if (
    (
      revision === 1 &&
      (
        predecessorKind !== 'applied-root' ||
        predecessorDigest !== appliedRootDigest
      )
    ) ||
    (
      revision > 1 &&
      predecessorKind !== 'verification-state'
    )
  ) {
    return failPersistence()
  }
  const progress = readProgressSnapshot(
    readOwn(record, 'progress'),
  )
  requireProgressIdentityFields(progress, {
    configurationHash,
    planDigest,
    runId,
    verificationPlanDigest,
  })
  const progressDigest = readDigest(
    readOwn(record, 'progressDigest'),
  )
  if (progressDigest !== createMigrationDigest(progress)) {
    return failPersistence()
  }
  const fields = {
    kind: 'workspace-search-migration-full-verification-state',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    planDigest,
    planArtifactBindingDigest: readDigest(
      readOwn(record, 'planArtifactBindingDigest'),
    ),
    sealedPlanningAuthorityDigest: readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    appliedRootDigest,
    verificationPlanDigest,
    revision,
    predecessorKind,
    predecessorDigest,
    lastCommandDigest: readDigest(
      readOwn(record, 'lastCommandDigest'),
    ),
    progress,
    progressDigest,
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationPersistenceState,
    'stateDigest'
  >
  const stateDigest = readDigest(readOwn(record, 'stateDigest'))
  if (stateDigest !== createMigrationDigest(fields)) {
    return failPersistence()
  }
  return { ...fields, stateDigest }
}

/**
 * Reads one exact predecessor and proves its command bindings.
 *
 * @param value - Candidate predecessor union.
 * @param command - Exact command consuming the predecessor.
 * @returns Detached predecessor material.
 */
function readPagePredecessor(
  value: unknown,
  command: WorkspaceSearchMigrationFullVerificationPageCommandIdentity,
): DetachedPagePredecessor {
  const record = requirePlainRecord(value)
  const kind = readOwn(record, 'kind')
  if (kind === 'applied-root') {
    requireExactKeys(record, ['kind', 'progress'])
    if (
      command.expectedRevision !== 0 ||
      command.predecessorDigest !== command.appliedRootDigest
    ) {
      return failPersistence()
    }
    const progress = snapshotProgress(readOwn(record, 'progress'))
    requireProgressIdentityFields(progress, command)
    if (
      !isInitialProgressForFields(progress, command) ||
      createMigrationDigest(progress) !==
        command.predecessorProgressDigest
    ) {
      return failPersistence()
    }
    return {
      kind,
      progress,
      digest: command.appliedRootDigest,
      commandDigest: null,
      revision: 0,
    }
  }
  if (kind !== 'verification-state') {
    return failPersistence()
  }
  requireExactKeys(record, ['kind', 'state'])
  const state = readPersistenceState(readOwn(record, 'state'))
  if (
    command.expectedRevision !== state.revision ||
    command.predecessorDigest !== state.stateDigest ||
    command.predecessorProgressDigest !== state.progressDigest ||
    !sameIdentity(command, state)
  ) {
    return failPersistence()
  }
  return {
    kind,
    progress: state.progress,
    digest: state.stateDigest,
    commandDigest: state.lastCommandDigest,
    revision: state.revision,
  }
}

/**
 * Requires one successor state to be the exact result of one command.
 *
 * @param command - Deterministic page command.
 * @param predecessor - Exact predecessor material.
 * @param successor - Candidate successor state.
 */
function requireSuccessorForCommand(
  command: WorkspaceSearchMigrationFullVerificationPageCommandIdentity,
  predecessor: DetachedPagePredecessor,
  successor: WorkspaceSearchMigrationFullVerificationPersistenceState,
): void {
  if (
    successor.revision !== command.expectedRevision + 1 ||
    successor.predecessorKind !== predecessor.kind ||
    successor.predecessorDigest !== predecessor.digest ||
    successor.lastCommandDigest !== command.commandDigest ||
    !sameIdentity(command, successor)
  ) {
    return failPersistence()
  }
  requireSingleLocationTransition(
    predecessor.progress,
    successor.progress,
    command.location,
  )
}

/**
 * Reads and reconstructs one strict immutable verification-page receipt.
 *
 * @param value - Candidate runtime or parsed receipt.
 * @returns Detached strict immutable receipt.
 */
function readPageReceipt(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationPageReceipt {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
    'commandDigest',
    'committedAt',
    'configurationHash',
    'kind',
    'location',
    'migrationId',
    'migrationVersion',
    'persistenceVersion',
    'planArtifactBindingDigest',
    'planDigest',
    'predecessorCheckpoint',
    'predecessorCheckpointDigest',
    'predecessorCommandDigest',
    'predecessorCursor',
    'predecessorDigest',
    'predecessorKind',
    'predecessorProgress',
    'predecessorProgressDigest',
    'predecessorRevision',
    'receiptDigest',
    'runId',
    'sealedPlanningAuthorityDigest',
    'successorProgress',
    'successorProgressDigest',
    'successorRevision',
    'successorStateDigest',
    'tableIds',
    'verificationPlanDigest',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-full-verification-page-receipt' ||
    readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failPersistence()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const planDigest = readDigest(readOwn(record, 'planDigest'))
  const verificationPlanDigest = readDigest(
    readOwn(record, 'verificationPlanDigest'),
  )
  const appliedRootDigest = readDigest(
    readOwn(record, 'appliedRootDigest'),
  )
  const location = readLocation(readOwn(record, 'location'))
  const predecessorRevision = readNonNegativeSafeInteger(
    readOwn(record, 'predecessorRevision'),
  )
  if (predecessorRevision === Number.MAX_SAFE_INTEGER) {
    return failPersistence()
  }
  const successorRevision = readPositiveSafeInteger(
    readOwn(record, 'successorRevision'),
  )
  if (successorRevision !== predecessorRevision + 1) {
    return failPersistence()
  }
  const predecessorKind = readPredecessorKind(
    readOwn(record, 'predecessorKind'),
  )
  const predecessorDigest = readDigest(
    readOwn(record, 'predecessorDigest'),
  )
  if (
    (
      predecessorRevision === 0 &&
      (
        predecessorKind !== 'applied-root' ||
        predecessorDigest !== appliedRootDigest
      )
    ) ||
    (
      predecessorRevision > 0 &&
      predecessorKind !== 'verification-state'
    )
  ) {
    return failPersistence()
  }
  const commonIdentity = {
    runId,
    configurationHash,
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    planDigest,
    planArtifactBindingDigest: readDigest(
      readOwn(record, 'planArtifactBindingDigest'),
    ),
    sealedPlanningAuthorityDigest: readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    appliedRootDigest,
    verificationPlanDigest,
  }
  const predecessorProgress = readProgressSnapshot(
    readOwn(record, 'predecessorProgress'),
  )
  requireProgressIdentityFields(predecessorProgress, commonIdentity)
  const predecessorProgressDigest = readDigest(
    readOwn(record, 'predecessorProgressDigest'),
  )
  if (
    predecessorProgressDigest !==
      createMigrationDigest(predecessorProgress) ||
    (
      predecessorRevision === 0 &&
      !isInitialProgressForFields(
        predecessorProgress,
        commonIdentity,
      )
    )
  ) {
    return failPersistence()
  }
  const commandFields = {
    kind:
      'workspace-search-migration-full-verification-page-command',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    ...commonIdentity,
    location,
    expectedRevision: predecessorRevision,
    predecessorDigest,
    predecessorProgressDigest,
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationPageCommandIdentity,
    'commandDigest'
  >
  const commandDigest = readDigest(
    readOwn(record, 'commandDigest'),
  )
  if (commandDigest !== createMigrationDigest(commandFields)) {
    return failPersistence()
  }
  const predecessorCheckpoint = readCheckpointSnapshot(
    readOwn(record, 'predecessorCheckpoint'),
  )
  const predecessorCommandDigest = readNullableDigest(
    readOwn(record, 'predecessorCommandDigest'),
  )
  if (
    (predecessorRevision === 0) !==
      (predecessorCommandDigest === null)
  ) {
    return failPersistence()
  }
  const selectedPredecessor = selectCheckpoint(
    predecessorProgress,
    location,
  )
  const predecessorCheckpointDigest = readDigest(
    readOwn(record, 'predecessorCheckpointDigest'),
  )
  const predecessorCursor = readNullableEncodedCursor(
    readOwn(record, 'predecessorCursor'),
  )
  if (
    predecessorCheckpointDigest !==
      createMigrationDigest(predecessorCheckpoint) ||
    !sameCanonical(predecessorCheckpoint, selectedPredecessor) ||
    !sameCanonical(
      predecessorCursor,
      selectedPredecessor.cursor ?? null,
    )
  ) {
    return failPersistence()
  }
  const successorProgress = readProgressSnapshot(
    readOwn(record, 'successorProgress'),
  )
  requireProgressIdentityFields(successorProgress, commonIdentity)
  const successorProgressDigest = readDigest(
    readOwn(record, 'successorProgressDigest'),
  )
  if (
    successorProgressDigest !== createMigrationDigest(successorProgress)
  ) {
    return failPersistence()
  }
  requireSingleLocationTransition(
    predecessorProgress,
    successorProgress,
    location,
  )
  const fields = {
    kind:
      'workspace-search-migration-full-verification-page-receipt',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    ...commonIdentity,
    location,
    commandDigest,
    predecessorRevision,
    predecessorKind,
    predecessorDigest,
    predecessorCommandDigest,
    predecessorCursor,
    predecessorCheckpoint,
    predecessorCheckpointDigest,
    predecessorProgress,
    predecessorProgressDigest,
    successorRevision,
    successorProgress,
    successorProgressDigest,
    successorStateDigest: readDigest(
      readOwn(record, 'successorStateDigest'),
    ),
    committedAt: readTimestamp(readOwn(record, 'committedAt')),
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationPageReceipt,
    'receiptDigest'
  >
  const receiptDigest = readDigest(
    readOwn(record, 'receiptDigest'),
  )
  if (receiptDigest !== createMigrationDigest(fields)) {
    return failPersistence()
  }
  return { ...fields, receiptDigest }
}

/**
 * Reconstructs the deterministic command identity embedded by one receipt.
 *
 * @param receipt - Strict immutable page receipt.
 * @returns Detached strict command identity.
 */
function commandIdentityFromReceipt(
  receipt: WorkspaceSearchMigrationFullVerificationPageReceipt,
): WorkspaceSearchMigrationFullVerificationPageCommandIdentity {
  return readCommandIdentity({
    kind:
      'workspace-search-migration-full-verification-page-command',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: receipt.runId,
    configurationHash: receipt.configurationHash,
    tableIds: receipt.tableIds,
    planDigest: receipt.planDigest,
    planArtifactBindingDigest: receipt.planArtifactBindingDigest,
    sealedPlanningAuthorityDigest:
      receipt.sealedPlanningAuthorityDigest,
    appliedRootDigest: receipt.appliedRootDigest,
    verificationPlanDigest: receipt.verificationPlanDigest,
    location: receipt.location,
    expectedRevision: receipt.predecessorRevision,
    predecessorDigest: receipt.predecessorDigest,
    predecessorProgressDigest:
      receipt.predecessorProgressDigest,
    commandDigest: receipt.commandDigest,
  })
}

/**
 * Reads and reconstructs one strict successful full-verification result.
 *
 * @param value - Candidate runtime or parsed result.
 * @returns Detached strict successful result.
 */
function readVerificationResult(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationResult {
  const record = requireExactRecord(value, [
    'applySealDigest',
    'configurationHash',
    'expectedSourceBindings',
    'expectedTargetPresentBindings',
    'kind',
    'migrationId',
    'migrationVersion',
    'observedSourceBindings',
    'observedTargetPresentBindings',
    'orphanOperationCount',
    'planDigest',
    'planOperationCount',
    'resultDigest',
    'runId',
    'sealedPlanningAuthorityDigest',
    'sourceCheckpointDigests',
    'sourceOperationCount',
    'status',
    'targetCheckpointDigest',
    'verification',
    'verificationPlanDigest',
    'verificationVersion',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-full-verification-result' ||
    readOwn(record, 'verificationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    readOwn(record, 'status') !== 'pass'
  ) {
    return failPersistence()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const planDigest = readDigest(readOwn(record, 'planDigest'))
  const verificationPlanDigest = readDigest(
    readOwn(record, 'verificationPlanDigest'),
  )
  const planOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'planOperationCount'),
  )
  const sourceOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'sourceOperationCount'),
  )
  const orphanOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'orphanOperationCount'),
  )
  if (
    sourceOperationCount + orphanOperationCount !==
      planOperationCount
  ) {
    return failPersistence()
  }
  const progress = restoreProgress(
    snapshotProgress(readOwn(record, 'verification')),
  )
  requireProgressIdentityFields(progress, {
    configurationHash,
    planDigest,
    runId,
    verificationPlanDigest,
  })
  const expectedSourceBindings = readSourceBindingAggregates(
    readOwn(record, 'expectedSourceBindings'),
  )
  const observedSourceBindings = readSourceBindingAggregates(
    readOwn(record, 'observedSourceBindings'),
  )
  const expectedTargetPresentBindings = readBindingAggregate(
    readOwn(record, 'expectedTargetPresentBindings'),
  )
  const observedTargetPresentBindings = readBindingAggregate(
    readOwn(record, 'observedTargetPresentBindings'),
  )
  let expectedSourceCount = 0
  for (const source of workspaceSearchMigrationSourceNames) {
    const checkpoint = progress.traversal.sources[source]
    const progressBinding = createBindingAggregateFromState(
      progress.sourceBindings[source],
    )
    requireTerminalCheckpoint(checkpoint)
    expectedSourceCount += expectedSourceBindings[source].count
    if (
      !sameCanonical(
        expectedSourceBindings[source],
        observedSourceBindings[source],
      ) ||
      !sameCanonical(
        progressBinding,
        observedSourceBindings[source],
      ) ||
      checkpoint.aggregate.mapped !==
        expectedSourceBindings[source].count ||
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        checkpoint,
      ) !==
        readSourceDigest(
          readOwn(record, 'sourceCheckpointDigests'),
          source,
        )
    ) {
      return failPersistence()
    }
  }
  const targetCheckpoint = progress.traversal.target
  const progressTargetBinding = createBindingAggregateFromState(
    progress.targetPresentBindings,
  )
  requireTerminalCheckpoint(targetCheckpoint)
  if (
    expectedSourceCount !== sourceOperationCount ||
    !sameCanonical(
      expectedTargetPresentBindings,
      observedTargetPresentBindings,
    ) ||
    !sameCanonical(
      progressTargetBinding,
      observedTargetPresentBindings,
    ) ||
    targetCheckpoint.aggregate.mapped !==
      expectedTargetPresentBindings.count ||
    expectedTargetPresentBindings.count > planOperationCount
  ) {
    return failPersistence()
  }
  const sourceCheckpointDigests = readSourceDigestRecord(
    readOwn(record, 'sourceCheckpointDigests'),
  )
  const targetCheckpointDigest = readDigest(
    readOwn(record, 'targetCheckpointDigest'),
  )
  if (
    targetCheckpointDigest !==
      createWorkspaceSearchMigrationSourceCheckpointDigest(
        targetCheckpoint,
      )
  ) {
    return failPersistence()
  }
  const fields = {
    kind: 'workspace-search-migration-full-verification-result',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    planDigest,
    verificationPlanDigest,
    planOperationCount,
    sourceOperationCount,
    orphanOperationCount,
    applySealDigest: readDigest(
      readOwn(record, 'applySealDigest'),
    ),
    sealedPlanningAuthorityDigest: readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    sourceCheckpointDigests,
    targetCheckpointDigest,
    verification: progress,
    expectedSourceBindings,
    observedSourceBindings,
    expectedTargetPresentBindings,
    observedTargetPresentBindings,
    status: 'pass',
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationResult,
    'resultDigest'
  >
  const resultDigest = readDigest(
    readOwn(record, 'resultDigest'),
  )
  if (resultDigest !== createMigrationDigest(fields)) {
    return failPersistence()
  }
  return { ...fields, resultDigest }
}

/**
 * Reads and reconstructs one strict immutable verified root.
 *
 * @param value - Candidate runtime or parsed verified root.
 * @returns Detached strict immutable root.
 */
function readVerifiedRoot(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationVerifiedRoot {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
    'configurationHash',
    'kind',
    'migrationId',
    'migrationVersion',
    'persistenceVersion',
    'planArtifactBinding',
    'planDigest',
    'publicationAuthority',
    'runId',
    'sealedPlanningAuthorityDigest',
    'tableIds',
    'terminalReceiptCommittedAt',
    'terminalReceiptDigest',
    'terminalStateDigest',
    'verificationPlanDigest',
    'verificationResultDigest',
    'verificationResultReference',
    'verifiedAt',
    'verifiedRootDigest',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-full-verification-verified-root' ||
    readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failPersistence()
  }
  const binding = readPlanArtifactBinding(
    readOwn(record, 'planArtifactBinding'),
  )
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const planDigest = readDigest(readOwn(record, 'planDigest'))
  const verificationPlanDigest = readDigest(
    readOwn(record, 'verificationPlanDigest'),
  )
  const sealedPlanningAuthorityDigest = readDigest(
    readOwn(record, 'sealedPlanningAuthorityDigest'),
  )
  if (
    runId !== binding.runId ||
    configurationHash !== binding.configurationHash ||
    planDigest !== binding.planDigest ||
    verificationPlanDigest !== binding.verificationPlanDigest ||
    sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthorityDigest
  ) {
    return failPersistence()
  }
  const verifiedAt = readTimestamp(readOwn(record, 'verifiedAt'))
  const verificationResultReference =
    readVerificationResultArtifactReference(
    readOwn(record, 'verificationResultReference'),
    )
  const appliedRootDigest = readDigest(
    readOwn(record, 'appliedRootDigest'),
  )
  const verificationResultDigest = readDigest(
    readOwn(record, 'verificationResultDigest'),
  )
  const terminalReceiptCommittedAt = readTimestamp(
    readOwn(record, 'terminalReceiptCommittedAt'),
  )
  if (
    verificationResultReference.runId !== runId ||
    verificationResultReference.configurationHash !== configurationHash ||
    verificationResultReference.appliedRootDigest !== appliedRootDigest ||
    verificationResultReference.verificationResultDigest !==
      verificationResultDigest ||
    verificationResultReference.retainUntil !==
      binding.planSealReference.retainUntil ||
    Date.parse(binding.planSealReference.retainUntil) <=
      Date.parse(verifiedAt) ||
    Date.parse(binding.planManifestHeadReference.retainUntil) <=
      Date.parse(verifiedAt)
  ) {
    return failPersistence()
  }
  const publicationAuthority = readPublicationAuthority(
    readOwn(record, 'publicationAuthority'),
  )
  if (
    Date.parse(terminalReceiptCommittedAt) >
      Date.parse(publicationAuthority.evaluatedAt) ||
    Date.parse(publicationAuthority.evaluatedAt) >
      Date.parse(verifiedAt)
  ) {
    return failPersistence()
  }
  const fields = {
    kind:
      'workspace-search-migration-full-verification-verified-root',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    planDigest,
    verificationPlanDigest,
    appliedRootDigest,
    verificationResultDigest,
    verificationResultReference,
    terminalStateDigest: readDigest(
      readOwn(record, 'terminalStateDigest'),
    ),
    terminalReceiptDigest: readDigest(
      readOwn(record, 'terminalReceiptDigest'),
    ),
    terminalReceiptCommittedAt,
    planArtifactBinding: binding,
    sealedPlanningAuthorityDigest,
    publicationAuthority,
    verifiedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationFullVerificationVerifiedRoot,
    'verifiedRootDigest'
  >
  const verifiedRootDigest = readDigest(
    readOwn(record, 'verifiedRootDigest'),
  )
  if (verifiedRootDigest !== createMigrationDigest(fields)) {
    return failPersistence()
  }
  return { ...fields, verifiedRootDigest }
}

/**
 * Requires every terminal artifact to identify the same immutable execution.
 *
 * @param input - Complete terminal publication bindings.
 */
function requireTerminalPublicationBindings(
  input: TerminalPublicationBindings,
): void {
  const {
    appliedRootDigest,
    binding,
    result,
    sealedPlanningAuthorityDigest,
    tableIds,
    terminalReceipt,
    terminalState,
  } = input
  if (
    sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthorityDigest ||
    result.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthorityDigest ||
    terminalState.runId !== binding.runId ||
    terminalState.configurationHash !== binding.configurationHash ||
    terminalState.planDigest !== binding.planDigest ||
    terminalState.planArtifactBindingDigest !==
      binding.bindingDigest ||
    terminalState.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthorityDigest ||
    terminalState.appliedRootDigest !== appliedRootDigest ||
    terminalState.verificationPlanDigest !==
      binding.verificationPlanDigest ||
    !sameCanonical(terminalState.tableIds, tableIds) ||
    result.runId !== binding.runId ||
    result.configurationHash !== binding.configurationHash ||
    result.planDigest !== binding.planDigest ||
    result.verificationPlanDigest !==
      binding.verificationPlanDigest ||
    terminalState.progressDigest !==
      createMigrationDigest(
        snapshotProgress(result.verification),
      ) ||
    !sameCanonical(
      terminalState.progress,
      snapshotProgress(result.verification),
    ) ||
    terminalReceipt.successorRevision !== terminalState.revision ||
    terminalReceipt.successorStateDigest !==
      terminalState.stateDigest ||
    terminalReceipt.successorProgressDigest !==
      terminalState.progressDigest ||
    !sameCanonical(
      terminalReceipt.successorProgress,
      terminalState.progress,
    ) ||
    terminalReceipt.appliedRootDigest !== appliedRootDigest ||
    terminalReceipt.planArtifactBindingDigest !==
      binding.bindingDigest ||
    terminalReceipt.sealedPlanningAuthorityDigest !==
      binding.sealedPlanningAuthorityDigest ||
    terminalReceipt.verificationPlanDigest !==
      binding.verificationPlanDigest ||
    !sameIdentity(terminalReceipt, terminalState)
  ) {
    return failPersistence()
  }
  requireTerminalProgress(terminalState.progress)
}

/**
 * Converts one pure-kernel progress graph to a strict JSON-safe snapshot.
 *
 * @param value - Candidate runtime progress with raw DynamoDB cursors.
 * @returns Detached strict progress snapshot.
 */
function snapshotProgress(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationProgressSnapshot {
  const detached = detachSafeGraph(value)
  const record = requireExactRecord(detached, [
    'configurationHash',
    'kind',
    'planDigest',
    'runId',
    'sourceBindings',
    'targetPresentBindings',
    'traversal',
    'verificationPlanDigest',
    'verificationVersion',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-full-verification-progress' ||
    readOwn(record, 'verificationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION
  ) {
    return failPersistence()
  }
  const traversalRecord = requireExactRecord(
    readOwn(record, 'traversal'),
    ['sources', 'target'],
  )
  const sourcesRecord = requireExactRecord(
    readOwn(traversalRecord, 'sources'),
    workspaceSearchMigrationSourceNames,
  )
  const sourceBindingsRecord = requireExactRecord(
    readOwn(record, 'sourceBindings'),
    workspaceSearchMigrationSourceNames,
  )
  const snapshot: WorkspaceSearchMigrationFullVerificationProgressSnapshot = {
    kind: 'workspace-search-migration-full-verification-progress',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    verificationPlanDigest: readDigest(
      readOwn(record, 'verificationPlanDigest'),
    ),
    traversal: {
      sources: {
        'project-directory': snapshotRuntimeCheckpoint(
          readOwn(sourcesRecord, 'project-directory'),
        ),
        'work-items': snapshotRuntimeCheckpoint(
          readOwn(sourcesRecord, 'work-items'),
        ),
        collaboration: snapshotRuntimeCheckpoint(
          readOwn(sourcesRecord, 'collaboration'),
        ),
        documents: snapshotRuntimeCheckpoint(
          readOwn(sourcesRecord, 'documents'),
        ),
      },
      target: snapshotRuntimeCheckpoint(
        readOwn(traversalRecord, 'target'),
      ),
    },
    sourceBindings: {
      'project-directory': readDigestState(
        readOwn(sourceBindingsRecord, 'project-directory'),
      ),
      'work-items': readDigestState(
        readOwn(sourceBindingsRecord, 'work-items'),
      ),
      collaboration: readDigestState(
        readOwn(sourceBindingsRecord, 'collaboration'),
      ),
      documents: readDigestState(
        readOwn(sourceBindingsRecord, 'documents'),
      ),
    },
    targetPresentBindings: readDigestState(
      readOwn(record, 'targetPresentBindings'),
    ),
  }
  validateProgressSnapshot(snapshot)
  return snapshot
}

/**
 * Reads one strict JSON-safe progress snapshot.
 *
 * @param value - Candidate runtime or parsed progress snapshot.
 * @returns Detached strict progress snapshot.
 */
function readProgressSnapshot(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationProgressSnapshot {
  const record = requireExactRecord(value, [
    'configurationHash',
    'kind',
    'planDigest',
    'runId',
    'sourceBindings',
    'targetPresentBindings',
    'traversal',
    'verificationPlanDigest',
    'verificationVersion',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-full-verification-progress' ||
    readOwn(record, 'verificationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION
  ) {
    return failPersistence()
  }
  const traversalRecord = requireExactRecord(
    readOwn(record, 'traversal'),
    ['sources', 'target'],
  )
  const sourcesRecord = requireExactRecord(
    readOwn(traversalRecord, 'sources'),
    workspaceSearchMigrationSourceNames,
  )
  const sourceBindingsRecord = requireExactRecord(
    readOwn(record, 'sourceBindings'),
    workspaceSearchMigrationSourceNames,
  )
  const snapshot: WorkspaceSearchMigrationFullVerificationProgressSnapshot = {
    kind: 'workspace-search-migration-full-verification-progress',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    planDigest: readDigest(readOwn(record, 'planDigest')),
    verificationPlanDigest: readDigest(
      readOwn(record, 'verificationPlanDigest'),
    ),
    traversal: {
      sources: {
        'project-directory': readCheckpointSnapshot(
          readOwn(sourcesRecord, 'project-directory'),
        ),
        'work-items': readCheckpointSnapshot(
          readOwn(sourcesRecord, 'work-items'),
        ),
        collaboration: readCheckpointSnapshot(
          readOwn(sourcesRecord, 'collaboration'),
        ),
        documents: readCheckpointSnapshot(
          readOwn(sourcesRecord, 'documents'),
        ),
      },
      target: readCheckpointSnapshot(
        readOwn(traversalRecord, 'target'),
      ),
    },
    sourceBindings: {
      'project-directory': readDigestState(
        readOwn(sourceBindingsRecord, 'project-directory'),
      ),
      'work-items': readDigestState(
        readOwn(sourceBindingsRecord, 'work-items'),
      ),
      collaboration: readDigestState(
        readOwn(sourceBindingsRecord, 'collaboration'),
      ),
      documents: readDigestState(
        readOwn(sourceBindingsRecord, 'documents'),
      ),
    },
    targetPresentBindings: readDigestState(
      readOwn(record, 'targetPresentBindings'),
    ),
  }
  validateProgressSnapshot(snapshot)
  return snapshot
}

/**
 * Restores one pure-kernel progress value from its tagged-cursor snapshot.
 *
 * @param snapshot - Exact strict JSON-safe progress snapshot.
 * @returns Detached pure-kernel progress.
 */
function restoreProgress(
  snapshot: WorkspaceSearchMigrationFullVerificationProgressSnapshot,
): WorkspaceSearchMigrationFullVerificationProgress {
  const strict = readProgressSnapshot(snapshot)
  return {
    kind: strict.kind,
    verificationVersion: strict.verificationVersion,
    runId: strict.runId,
    configurationHash: strict.configurationHash,
    planDigest: strict.planDigest,
    verificationPlanDigest: strict.verificationPlanDigest,
    traversal: {
      sources: {
        'project-directory':
          decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
            strict.traversal.sources['project-directory'],
          ),
        'work-items':
          decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
            strict.traversal.sources['work-items'],
          ),
        collaboration:
          decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
            strict.traversal.sources.collaboration,
          ),
        documents:
          decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
            strict.traversal.sources.documents,
          ),
      },
      target:
        decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
          strict.traversal.target,
        ),
    },
    sourceBindings: {
      'project-directory': strict.sourceBindings['project-directory'],
      'work-items': strict.sourceBindings['work-items'],
      collaboration: strict.sourceBindings.collaboration,
      documents: strict.sourceBindings.documents,
    },
    targetPresentBindings: strict.targetPresentBindings,
  }
}

/**
 * Validates accumulator counts against every decoded checkpoint.
 *
 * @param snapshot - Candidate strict progress snapshot.
 */
function validateProgressSnapshot(
  snapshot: WorkspaceSearchMigrationFullVerificationProgressSnapshot,
): void {
  for (const source of workspaceSearchMigrationSourceNames) {
    const checkpoint =
      decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
        snapshot.traversal.sources[source],
      )
    const accumulator = MigrationDigestAccumulator.fromState(
      snapshot.sourceBindings[source],
    )
    if (accumulator.size() !== checkpoint.aggregate.mapped) {
      return failPersistence()
    }
  }
  const target =
    decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
      snapshot.traversal.target,
    )
  const targetAccumulator = MigrationDigestAccumulator.fromState(
    snapshot.targetPresentBindings,
  )
  if (targetAccumulator.size() !== target.aggregate.mapped) {
    return failPersistence()
  }
}

/**
 * Converts one raw checkpoint into its lossless tagged-cursor snapshot.
 *
 * @param value - Candidate raw pure-kernel checkpoint.
 * @returns Detached strict checkpoint snapshot.
 */
function snapshotRuntimeCheckpoint(
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
  const cursorValue = readOptionalOwn(record, 'cursor')
  const checkpoint: MigrationSourceCheckpoint =
    cursorValue === undefined
      ? common
      : {
          ...common,
          cursor: decodeAttributeMap(
            encodeUnknownAttributeMap(cursorValue),
          ),
        }
  return createWorkspaceSearchMigrationApplyCheckpointSnapshot(
    checkpoint,
  )
}

/**
 * Reads one strict tagged-cursor checkpoint snapshot.
 *
 * @param value - Candidate runtime or parsed checkpoint snapshot.
 * @returns Detached strict checkpoint snapshot.
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
  const cursorValue = readOptionalOwn(record, 'cursor')
  const snapshot: WorkspaceSearchMigrationApplyCheckpointSnapshot =
    cursorValue === undefined
      ? common
      : {
          ...common,
          cursor: cloneEncodedCursor(cursorValue),
        }
  void decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(snapshot)
  return snapshot
}

/**
 * Requires one checkpoint record with exactly its optional cursor shape.
 *
 * @param value - Candidate checkpoint record.
 * @returns Strict checkpoint record.
 */
function requireCheckpointRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const record = requirePlainRecord(value)
  const hasCursor = hasOwnDataProperty(record, 'cursor')
  if (
    hasCursor &&
    readOwn(record, 'cursor') === undefined
  ) {
    return failPersistence()
  }
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
 * Reads one exact restorable order-independent digest state.
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
  const state = {
    count: readNonNegativeSafeInteger(readOwn(record, 'count')),
    sumHex: readDigest(readOwn(record, 'sumHex')),
    xorHex: readDigest(readOwn(record, 'xorHex')),
  }
  void MigrationDigestAccumulator.fromState(state)
  return state
}

/**
 * Requires only the command-selected location to advance by exactly one page.
 *
 * @param predecessor - Complete predecessor progress.
 * @param successor - Complete successor progress.
 * @param location - Source or target location selected by the command.
 */
function requireSingleLocationTransition(
  predecessor:
    WorkspaceSearchMigrationFullVerificationProgressSnapshot,
  successor:
    WorkspaceSearchMigrationFullVerificationProgressSnapshot,
  location: WorkspaceSearchMigrationCheckpointLocation,
): void {
  requireProgressIdentityFields(successor, predecessor)
  for (const source of workspaceSearchMigrationSourceNames) {
    if (location === source) {
      if (
        !sameCanonical(
          predecessor.traversal.target,
          successor.traversal.target,
        ) ||
        !sameCanonical(
          predecessor.targetPresentBindings,
          successor.targetPresentBindings,
        )
      ) {
        return failPersistence()
      }
      for (const other of workspaceSearchMigrationSourceNames) {
        if (other === source) continue
        if (
          !sameCanonical(
            predecessor.traversal.sources[other],
            successor.traversal.sources[other],
          ) ||
          !sameCanonical(
            predecessor.sourceBindings[other],
            successor.sourceBindings[other],
          )
        ) {
          return failPersistence()
        }
      }
      requireSelectedBindingAdvance(
        predecessor.traversal.sources[source],
        successor.traversal.sources[source],
        predecessor.sourceBindings[source],
        successor.sourceBindings[source],
      )
      requireCheckpointAdvance(
        predecessor.traversal.sources[source],
        successor.traversal.sources[source],
      )
      return
    }
  }
  for (const source of workspaceSearchMigrationSourceNames) {
    if (
      !sameCanonical(
        predecessor.traversal.sources[source],
        successor.traversal.sources[source],
      ) ||
      !sameCanonical(
        predecessor.sourceBindings[source],
        successor.sourceBindings[source],
      )
    ) {
      return failPersistence()
    }
  }
  requireSelectedBindingAdvance(
    predecessor.traversal.target,
    successor.traversal.target,
    predecessor.targetPresentBindings,
    successor.targetPresentBindings,
  )
  requireCheckpointAdvance(
    predecessor.traversal.target,
    successor.traversal.target,
  )
}

/**
 * Rejects a selected binding-state substitution without a mapped-row delta.
 *
 * @param predecessorCheckpoint - Exact selected predecessor checkpoint.
 * @param successorCheckpoint - Exact selected successor checkpoint.
 * @param predecessorBinding - Selected predecessor binding state.
 * @param successorBinding - Selected successor binding state.
 */
function requireSelectedBindingAdvance(
  predecessorCheckpoint:
    WorkspaceSearchMigrationApplyCheckpointSnapshot,
  successorCheckpoint:
    WorkspaceSearchMigrationApplyCheckpointSnapshot,
  predecessorBinding: MigrationDigestState,
  successorBinding: MigrationDigestState,
): void {
  if (
    predecessorCheckpoint.aggregate.mapped ===
      successorCheckpoint.aggregate.mapped &&
    !sameCanonical(predecessorBinding, successorBinding)
  ) {
    return failPersistence()
  }
}

/**
 * Requires one selected checkpoint to advance monotonically by one page.
 *
 * @param predecessor - Exact selected predecessor checkpoint.
 * @param successor - Exact selected successor checkpoint.
 */
function requireCheckpointAdvance(
  predecessor: WorkspaceSearchMigrationApplyCheckpointSnapshot,
  successor: WorkspaceSearchMigrationApplyCheckpointSnapshot,
): void {
  const previous =
    decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
      predecessor,
    )
  const next =
    decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
      successor,
    )
  if (
    previous.completed ||
    next.aggregate.pageCount !== previous.aggregate.pageCount + 1 ||
    sameCanonical(previous, next)
  ) {
    return failPersistence()
  }
  validateWorkspaceSearchMigrationCheckpoint(next, previous)
}

/**
 * Selects one exact checkpoint from a complete progress snapshot.
 *
 * @param progress - Complete progress snapshot.
 * @param location - Requested source or target location.
 * @returns Exact selected checkpoint snapshot.
 */
function selectCheckpoint(
  progress: WorkspaceSearchMigrationFullVerificationProgressSnapshot,
  location: WorkspaceSearchMigrationCheckpointLocation,
): WorkspaceSearchMigrationApplyCheckpointSnapshot {
  if (location === 'target') return progress.traversal.target
  return progress.traversal.sources[location]
}

/**
 * Requires one progress snapshot to match a compact plan-artifact binding.
 *
 * @param progress - Candidate complete progress snapshot.
 * @param binding - Exact plan-artifact binding.
 */
function requireProgressIdentity(
  progress: WorkspaceSearchMigrationFullVerificationProgressSnapshot,
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
): void {
  requireProgressIdentityFields(progress, binding)
}

/**
 * Requires one progress snapshot to match exact identity-bearing fields.
 *
 * @param progress - Candidate complete progress snapshot or runtime progress.
 * @param identity - Exact run, configuration, plan, and verification digests.
 */
function requireProgressIdentityFields(
  progress: {
    /** Operator-selected migration run. */
    readonly runId: string
    /** Reviewed configuration digest. */
    readonly configurationHash: string
    /** Exact operation-plan digest. */
    readonly planDigest: string
    /** Exact plan-derived verification digest. */
    readonly verificationPlanDigest: string
  },
  identity: {
    /** Operator-selected migration run. */
    readonly runId: string
    /** Reviewed configuration digest. */
    readonly configurationHash: string
    /** Exact operation-plan digest. */
    readonly planDigest: string
    /** Exact plan-derived verification digest. */
    readonly verificationPlanDigest: string
  },
): void {
  if (
    progress.runId !== identity.runId ||
    progress.configurationHash !== identity.configurationHash ||
    progress.planDigest !== identity.planDigest ||
    progress.verificationPlanDigest !==
      identity.verificationPlanDigest
  ) {
    return failPersistence()
  }
}

/**
 * Compares every persistence identity field shared by two records.
 *
 * @param left - First complete identity-bearing record.
 * @param right - Second complete identity-bearing record.
 * @returns Whether every root, plan, authority, and table binding is exact.
 */
function sameIdentity(
  left: {
    /** Operator-selected migration run. */
    readonly runId: string
    /** Reviewed configuration digest. */
    readonly configurationHash: string
    /** Complete physical TableId record. */
    readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
    /** Exact operation-plan digest. */
    readonly planDigest: string
    /** Compact plan-artifact binding digest. */
    readonly planArtifactBindingDigest: string
    /** Sealed planning-authority digest. */
    readonly sealedPlanningAuthorityDigest: string
    /** Immutable applied-root digest. */
    readonly appliedRootDigest: string
    /** Exact plan-derived verification digest. */
    readonly verificationPlanDigest: string
  },
  right: {
    /** Operator-selected migration run. */
    readonly runId: string
    /** Reviewed configuration digest. */
    readonly configurationHash: string
    /** Complete physical TableId record. */
    readonly tableIds: WorkspaceSearchMigrationFullVerificationTableIds
    /** Exact operation-plan digest. */
    readonly planDigest: string
    /** Compact plan-artifact binding digest. */
    readonly planArtifactBindingDigest: string
    /** Sealed planning-authority digest. */
    readonly sealedPlanningAuthorityDigest: string
    /** Immutable applied-root digest. */
    readonly appliedRootDigest: string
    /** Exact plan-derived verification digest. */
    readonly verificationPlanDigest: string
  },
): boolean {
  return (
    left.runId === right.runId &&
    left.configurationHash === right.configurationHash &&
    sameCanonical(left.tableIds, right.tableIds) &&
    left.planDigest === right.planDigest &&
    left.planArtifactBindingDigest ===
      right.planArtifactBindingDigest &&
    left.sealedPlanningAuthorityDigest ===
      right.sealedPlanningAuthorityDigest &&
    left.appliedRootDigest === right.appliedRootDigest &&
    left.verificationPlanDigest ===
      right.verificationPlanDigest
  )
}

/**
 * Checks one progress snapshot against the unique canonical initial value.
 *
 * @param progress - Candidate complete progress snapshot.
 * @param binding - Exact plan binding owning the initial progress.
 * @returns Whether the progress is the exact canonical initial value.
 */
function isInitialProgress(
  progress: WorkspaceSearchMigrationFullVerificationProgressSnapshot,
  binding: WorkspaceSearchMigrationFullVerificationPlanArtifactBinding,
): boolean {
  return isInitialProgressForFields(progress, binding)
}

/**
 * Checks one progress snapshot against its identity-derived initial value.
 *
 * @param progress - Candidate complete progress snapshot.
 * @param identity - Exact run, configuration, plan, and verification digests.
 * @returns Whether the progress is the exact canonical initial value.
 */
function isInitialProgressForFields(
  progress: WorkspaceSearchMigrationFullVerificationProgressSnapshot,
  identity: {
    /** Operator-selected migration run. */
    readonly runId: string
    /** Reviewed configuration digest. */
    readonly configurationHash: string
    /** Exact operation-plan digest. */
    readonly planDigest: string
    /** Exact plan-derived verification digest. */
    readonly verificationPlanDigest: string
  },
): boolean {
  const empty = new MigrationDigestAccumulator().exportState()
  const expected: WorkspaceSearchMigrationFullVerificationProgress = {
    kind: 'workspace-search-migration-full-verification-progress',
    verificationVersion:
      WORKSPACE_SEARCH_MIGRATION_FULL_VERIFICATION_VERSION,
    runId: identity.runId,
    configurationHash: identity.configurationHash,
    planDigest: identity.planDigest,
    verificationPlanDigest: identity.verificationPlanDigest,
    traversal: createEmptyWorkspaceSearchMigrationTraversal(),
    sourceBindings: {
      'project-directory': empty,
      'work-items': empty,
      collaboration: empty,
      documents: empty,
    },
    targetPresentBindings: empty,
  }
  return sameCanonical(progress, snapshotProgress(expected))
}

/**
 * Requires all five checkpoints in one progress snapshot to be terminal.
 *
 * @param progress - Candidate terminal complete progress snapshot.
 */
function requireTerminalProgress(
  progress: WorkspaceSearchMigrationFullVerificationProgressSnapshot,
): void {
  for (const source of workspaceSearchMigrationSourceNames) {
    requireTerminalCheckpoint(
      decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
        progress.traversal.sources[source],
      ),
    )
  }
  requireTerminalCheckpoint(
    decodeWorkspaceSearchMigrationApplyCheckpointSnapshot(
      progress.traversal.target,
    ),
  )
}

/**
 * Requires one checkpoint to be complete, cursor-free, and invalid-free.
 *
 * @param checkpoint - Candidate terminal checkpoint.
 */
function requireTerminalCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
): void {
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  if (
    !checkpoint.completed ||
    checkpoint.cursor !== undefined ||
    checkpoint.aggregate.invalid !== 0
  ) {
    return failPersistence()
  }
}

/**
 * Reads exact source binding aggregates in the fixed source order.
 *
 * @param value - Candidate aggregate record.
 * @returns Detached strict source aggregates.
 */
function readSourceBindingAggregates(
  value: unknown,
): Readonly<
  Record<
    WorkspaceSearchMigrationSourceName,
    WorkspaceSearchMigrationVerificationBindingAggregate
  >
> {
  const record = requireExactRecord(
    value,
    workspaceSearchMigrationSourceNames,
  )
  return {
    'project-directory': readBindingAggregate(
      readOwn(record, 'project-directory'),
    ),
    'work-items': readBindingAggregate(
      readOwn(record, 'work-items'),
    ),
    collaboration: readBindingAggregate(
      readOwn(record, 'collaboration'),
    ),
    documents: readBindingAggregate(
      readOwn(record, 'documents'),
    ),
  }
}

/**
 * Reads one internally consistent verification binding aggregate.
 *
 * @param value - Candidate binding aggregate.
 * @returns Detached strict aggregate.
 */
function readBindingAggregate(
  value: unknown,
): WorkspaceSearchMigrationVerificationBindingAggregate {
  const record = requireExactRecord(value, [
    'count',
    'digest',
    'digestState',
  ])
  const digestState = readDigestState(
    readOwn(record, 'digestState'),
  )
  const accumulator = MigrationDigestAccumulator.fromState(
    digestState,
  )
  const count = readNonNegativeSafeInteger(
    readOwn(record, 'count'),
  )
  const digest = readDigest(readOwn(record, 'digest'))
  if (
    count !== accumulator.size() ||
    digest !== accumulator.digest()
  ) {
    return failPersistence()
  }
  return { count, digestState, digest }
}

/**
 * Derives one exact verification binding aggregate from persisted progress.
 *
 * @param state - Exact restorable binding accumulator state.
 * @returns Count, detached state, and derived aggregate digest.
 */
function createBindingAggregateFromState(
  state: MigrationDigestState,
): WorkspaceSearchMigrationVerificationBindingAggregate {
  const detached = readDigestState(state)
  const accumulator = MigrationDigestAccumulator.fromState(detached)
  return {
    count: accumulator.size(),
    digestState: accumulator.exportState(),
    digest: accumulator.digest(),
  }
}

/**
 * Reads source checkpoint digests in the fixed source order.
 *
 * @param value - Candidate source digest record.
 * @returns Detached strict source digest record.
 */
function readSourceDigestRecord(
  value: unknown,
): Readonly<Record<WorkspaceSearchMigrationSourceName, string>> {
  const record = requireExactRecord(
    value,
    workspaceSearchMigrationSourceNames,
  )
  return {
    'project-directory': readDigest(
      readOwn(record, 'project-directory'),
    ),
    'work-items': readDigest(readOwn(record, 'work-items')),
    collaboration: readDigest(
      readOwn(record, 'collaboration'),
    ),
    documents: readDigest(readOwn(record, 'documents')),
  }
}

/**
 * Reads one source digest from an exact fixed-role record.
 *
 * @param value - Candidate source digest record.
 * @param source - Exact source role to read.
 * @returns Strict lowercase digest.
 */
function readSourceDigest(
  value: unknown,
  source: WorkspaceSearchMigrationSourceName,
): string {
  return readSourceDigestRecord(value)[source]
}

/**
 * Reads one exact rich immutable artifact reference.
 *
 * @param value - Candidate immutable object reference.
 * @returns Detached strict artifact reference.
 */
function readArtifactReference(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationArtifactReference {
  const record = requireExactRecord(value, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const versionId = readBoundedText(
    readOwn(record, 'versionId'),
    maximumReferenceTextLength,
  )
  if (versionId === 'null') {
    return failPersistence()
  }
  return {
    objectKey: readBoundedText(
      readOwn(record, 'objectKey'),
      maximumReferenceTextLength,
    ),
    versionId,
    contentDigest: readDigest(
      readOwn(record, 'contentDigest'),
    ),
    byteLength: readPositiveSafeInteger(
      readOwn(record, 'byteLength'),
    ),
    retainUntil: readTimestamp(
      readOwn(record, 'retainUntil'),
    ),
  }
}

/**
 * Reads one rich exact-version verification-result envelope reference.
 *
 * @param value - Candidate semantic-envelope reference.
 * @returns Detached strict rich result-artifact reference.
 */
function readVerificationResultArtifactReference(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationResultArtifactReference {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
    'artifactVersion',
    'byteLength',
    'configurationHash',
    'contentDigest',
    'envelopeDigest',
    'kind',
    'objectKey',
    'retainUntil',
    'runId',
    'verificationResultDigest',
    'versionId',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-verification-result-artifact-reference' ||
    readOwn(record, 'artifactVersion') !== 1
  ) {
    return failPersistence()
  }
  const objectReference = readArtifactReference({
    objectKey: readOwn(record, 'objectKey'),
    versionId: readOwn(record, 'versionId'),
    contentDigest: readOwn(record, 'contentDigest'),
    byteLength: readOwn(record, 'byteLength'),
    retainUntil: readOwn(record, 'retainUntil'),
  })
  return {
    kind:
      'workspace-search-migration-verification-result-artifact-reference',
    artifactVersion: 1,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    appliedRootDigest: readDigest(
      readOwn(record, 'appliedRootDigest'),
    ),
    verificationResultDigest: readDigest(
      readOwn(record, 'verificationResultDigest'),
    ),
    envelopeDigest: readDigest(
      readOwn(record, 'envelopeDigest'),
    ),
    ...objectReference,
  }
}

/**
 * Reads all six exact physical table incarnations.
 *
 * @param value - Candidate fixed-role TableId record.
 * @returns Detached strict table identities.
 */
function readTableIds(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationTableIds {
  const record = requireExactRecord(value, tableRoles)
  return {
    'project-directory': readBoundedText(
      readOwn(record, 'project-directory'),
      maximumReferenceTextLength,
    ),
    'work-items': readBoundedText(
      readOwn(record, 'work-items'),
      maximumReferenceTextLength,
    ),
    collaboration: readBoundedText(
      readOwn(record, 'collaboration'),
      maximumReferenceTextLength,
    ),
    documents: readBoundedText(
      readOwn(record, 'documents'),
      maximumReferenceTextLength,
    ),
    'workspace-search': readBoundedText(
      readOwn(record, 'workspace-search'),
      maximumReferenceTextLength,
    ),
    'migration-state': readBoundedText(
      readOwn(record, 'migration-state'),
      maximumReferenceTextLength,
    ),
  }
}

/**
 * Reads one exact authority snapshot retained by verified publication.
 *
 * @param value - Candidate publication authority.
 * @returns Detached strict authority snapshot.
 */
function readPublicationAuthority(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationPublicationAuthority {
  const record = requireExactRecord(value, [
    'evaluatedAt',
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
  ])
  return {
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidencePointerRevision:
      readPositiveSafeInteger(
        readOwn(record, 'maintenanceEvidencePointerRevision'),
      ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    evaluatedAt: readTimestamp(readOwn(record, 'evaluatedAt')),
  }
}

/**
 * Reads one source or target checkpoint location.
 *
 * @param value - Candidate checkpoint location.
 * @returns Strict supported location.
 */
function readLocation(
  value: unknown,
): WorkspaceSearchMigrationCheckpointLocation {
  if (value === 'target') return value
  for (const source of workspaceSearchMigrationSourceNames) {
    if (value === source) return source
  }
  return failPersistence()
}

/**
 * Reads one supported predecessor-root discriminator.
 *
 * @param value - Candidate predecessor kind.
 * @returns Strict predecessor kind.
 */
function readPredecessorKind(
  value: unknown,
): WorkspaceSearchMigrationFullVerificationStatePredecessorKind {
  if (
    value !== 'applied-root' &&
    value !== 'verification-state'
  ) {
    return failPersistence()
  }
  return value
}

/**
 * Clones and validates one tagged DynamoDB checkpoint cursor.
 *
 * @param value - Candidate encoded attribute map.
 * @returns Detached canonical encoded cursor.
 */
function cloneEncodedCursor(value: unknown): EncodedAttributeMap {
  requireSafeDataGraph(value)
  return encodeUnknownAttributeMap(decodeAttributeMap(value))
}

/**
 * Reads one nullable tagged DynamoDB checkpoint cursor.
 *
 * @param value - Candidate encoded cursor or null.
 * @returns Detached canonical cursor or null.
 */
function readNullableEncodedCursor(
  value: unknown,
): EncodedAttributeMap | null {
  if (value === null) return null
  return cloneEncodedCursor(value)
}

/**
 * Reads one nullable lowercase digest.
 *
 * @param value - Candidate digest or null.
 * @returns Strict digest or null.
 */
function readNullableDigest(value: unknown): string | null {
  if (value === null) return null
  return readDigest(value)
}

/**
 * Reads one safe migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string') return failPersistence()
  requireMigrationIdentifier(value, 'verification persistence identifier')
  return value
}

/**
 * Reads one bounded nonempty text value.
 *
 * @param value - Candidate text.
 * @param maximumLength - Maximum accepted UTF-16 code-unit count.
 * @returns Validated bounded text.
 */
function readBoundedText(
  value: unknown,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumLength ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failPersistence()
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failPersistence()
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failPersistence()
  return value
}

/**
 * Reads one Boolean.
 *
 * @param value - Candidate Boolean.
 * @returns Validated Boolean.
 */
function readBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') return failPersistence()
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated positive safe integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failPersistence()
  }
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated nonnegative safe integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failPersistence()
  }
  return value
}

/**
 * Reads one optional own property without accepting explicit undefined.
 *
 * @param record - Strict caller-owned record.
 * @param key - Optional own property key.
 * @returns Stored property value or undefined when absent.
 */
function readOptionalOwn(
  record: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  if (!hasOwnDataProperty(record, key)) return undefined
  const value = readOwn(record, key)
  if (value === undefined) return failPersistence()
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
  requireExactKeys(record, expectedKeys)
  return record
}

/**
 * Requires a strict record to contain exactly the expected own keys.
 *
 * @param record - Strict caller-owned record.
 * @param expectedKeys - Complete expected own-string-key set.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
): void {
  const keys = Reflect.ownKeys(record)
  if (
    keys.some((key) => typeof key === 'symbol') ||
    keys.length !== expectedKeys.length
  ) {
    return failPersistence()
  }
  const actual = keys.filter(
    (key): key is string => typeof key === 'string',
  ).sort()
  const expected = [...expectedKeys].sort()
  if (
    actual.some((key, index) => key !== expected[index])
  ) {
    return failPersistence()
  }
  for (const key of expected) {
    if (!hasOwnDataProperty(record, key)) {
      return failPersistence()
    }
  }
}

/**
 * Requires one non-Proxy ordinary or null-prototype record.
 *
 * @param value - Candidate value.
 * @returns Strict plain record.
 */
function requirePlainRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    return failPersistence()
  }
  return value
}

/**
 * Checks whether one value is a non-Proxy ordinary or null-prototype record.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a supported plain record.
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
 * @returns Whether one strict own data property exists.
 */
function hasOwnDataProperty(record: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return false
  if (
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return failPersistence()
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
    return failPersistence()
  }
  return descriptor.value
}

/**
 * Detaches one bounded caller-owned graph after rejecting active behavior.
 *
 * @param value - Candidate data graph.
 * @returns Detached graph with the same static type.
 */
function detachSafeGraph<Value>(value: Value): Value {
  requireSafeDataGraph(value)
  return structuredClone(value)
}

/**
 * Rejects accessors, Proxies, symbols, cycles, and unbounded data graphs.
 *
 * @param value - Candidate caller-owned data graph.
 */
function requireSafeDataGraph(value: unknown): void {
  inspectSafeDataGraph(value, {
    nodes: 0,
    active: new WeakSet<object>(),
    visited: new WeakSet<object>(),
  }, 0)
}

/**
 * Visits one strict data graph without invoking caller-defined behavior.
 *
 * @param value - Current graph node.
 * @param budget - Shared traversal budget.
 * @param depth - Current recursive depth.
 */
function inspectSafeDataGraph(
  value: unknown,
  budget: SafeGraphBudget,
  depth: number,
): void {
  if (depth > maximumSafeGraphDepth) {
    return failPersistence()
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    if (
      typeof value === 'string' &&
      !hasOnlyPairedSurrogates(value)
    ) {
      return failPersistence()
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return failPersistence()
    return
  }
  if (
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    budget.active.has(value)
  ) {
    return failPersistence()
  }
  if (budget.visited.has(value)) return
  budget.nodes += 1
  if (budget.nodes > maximumSafeGraphNodes) {
    return failPersistence()
  }
  if (isSupportedBinaryValue(value)) {
    requireExactTypedArrayKeys(value)
    budget.visited.add(value)
    return
  }
  budget.active.add(value)
  if (Array.isArray(value)) {
    if (
      !hasCanonicalDenseArrayShape(value) ||
      value.length > maximumSafeGraphNodes
    ) {
      return failPersistence()
    }
    for (const child of value) {
      inspectSafeDataGraph(child, budget, depth + 1)
    }
  } else {
    const record = requirePlainRecord(value)
    for (const key of Reflect.ownKeys(record)) {
      if (typeof key !== 'string') return failPersistence()
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return failPersistence()
      }
      inspectSafeDataGraph(
        descriptor.value,
        budget,
        depth + 1,
      )
    }
  }
  budget.active.delete(value)
  budget.visited.add(value)
}

/**
 * Narrows one binary graph node to a built-in Uint8Array or Buffer.
 *
 * @param value - Candidate binary graph node.
 * @returns Whether the value uses a trusted binary prototype.
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
  return (
    prototype === Uint8Array.prototype ||
    prototype === Buffer.prototype
  )
}

/**
 * Rejects custom own properties on one binary value.
 *
 * @param value - Candidate trusted-prototype binary value.
 */
function requireExactTypedArrayKeys(value: Uint8Array): void {
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key === 'symbol') ||
    keys.length !== value.byteLength
  ) {
    return failPersistence()
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
      return failPersistence()
    }
  }
}

/**
 * Encodes one strict value as bounded canonical UTF-8 JSON bytes.
 *
 * @param value - Strict JSON-compatible value.
 * @param maximumBytes - Maximum accepted canonical byte length.
 * @returns Exact canonical bytes without a trailing newline.
 */
function encodeValue(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(value),
  )
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    return failPersistence()
  }
  return bytes
}

/**
 * Parses and re-encodes one exact canonical bounded JSON artifact.
 *
 * @param bytes - Untrusted bounded artifact bytes.
 * @param maximumBytes - Maximum accepted byte length.
 * @param reader - Strict value-specific reader.
 * @returns Detached strict parsed value.
 */
function parseCanonicalBytes<Result>(
  bytes: Uint8Array,
  maximumBytes: number,
  reader: (value: unknown) => Result,
): Result {
  return atPersistenceBoundary(() => {
    const snapshot = copyBoundedBytes(bytes, maximumBytes)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        snapshot,
      )
    } catch {
      return failPersistence()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failPersistence()
    }
    const value = reader(parsed)
    const canonical = encodeValue(value, maximumBytes)
    if (!equalBytes(snapshot, canonical)) {
      return failPersistence()
    }
    return value
  })
}

/**
 * Copies untrusted binary input after enforcing its finite byte ceiling.
 *
 * @param bytes - Candidate artifact bytes.
 * @param maximumBytes - Maximum accepted byte length.
 * @returns Detached bounded byte array.
 */
function copyBoundedBytes(
  bytes: Uint8Array,
  maximumBytes: number,
): Uint8Array {
  if (
    !isSupportedBinaryValue(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    return failPersistence()
  }
  return new Uint8Array(bytes)
}

/**
 * Compares two values through their unique canonical JSON representation.
 *
 * @param left - First strict JSON-compatible value.
 * @param right - Second strict JSON-compatible value.
 * @returns Whether both canonical representations are identical.
 */
function sameCanonical(left: unknown, right: unknown): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right)
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
 * Maps all implementation failures to the stable public contract error.
 *
 * @param operation - Persistence-contract operation.
 * @returns Successful operation result.
 */
function atPersistenceBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationFullVerificationPersistenceError
    ) {
      throw error
    }
    throw new WorkspaceSearchMigrationFullVerificationPersistenceError()
  }
}

/**
 * Raises the only public persistence-contract validation failure.
 *
 * @returns Never returns.
 */
function failPersistence(): never {
  throw new WorkspaceSearchMigrationFullVerificationPersistenceError()
}
