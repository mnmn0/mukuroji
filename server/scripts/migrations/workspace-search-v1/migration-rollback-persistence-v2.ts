import { Buffer } from 'node:buffer'
import { types as nodeUtilTypes } from 'node:util'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  type EncodedAttributeMap,
} from './dynamodb-attribute-codec'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
} from './migration-artifacts'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type MigrationDigestState,
  type MigrationScanAggregate,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchApplySealReference,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationTableRole,
  type WorkspaceSearchMigrationTraversalProgress,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchRollbackReceipt,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationCommittedPrefixApplySeal,
  readWorkspaceSearchMigrationCommittedPrefixApplySealReference,
  requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding,
  serializeWorkspaceSearchMigrationCommittedPrefixApplySeal,
  type WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor,
  type WorkspaceSearchMigrationCommittedPrefixApplySealReference,
} from './migration-committed-prefix-apply-seal'
import {
  detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary,
} from './migration-execution-boundary'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  parseWorkspaceSearchMigrationExecutionState,
  parseWorkspaceSearchMigrationOperationMarker,
  reconstructWorkspaceSearchMigrationRunState,
  serializeWorkspaceSearchMigrationOperationMarker,
  serializeWorkspaceSearchMigrationExecutionState,
  type WorkspaceSearchMigrationExecutionState,
} from './migration-execution-state'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  parseWorkspaceSearchJournalSegment,
  serializeWorkspaceSearchJournalSegment,
  WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES,
} from './migration-journal'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createWorkspaceSearchRollbackOperationRecordedEvent,
  reduceWorkspaceSearchMigrationRunState,
  validateWorkspaceSearchMigrationCheckpoint,
  validateWorkspaceSearchMigrationRunState,
  WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationAuthority,
} from './migration-state-machine'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Schema version reserved for committed-prefix rollback persistence. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION = 2

/** Maximum canonical bytes accepted for one committed-prefix origin. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_ORIGIN_V2_MAX_BYTES =
  96 * 1024

/** Maximum canonical bytes accepted for one v2 rollback lifecycle state. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_V2_MAX_BYTES =
  192 * 1024

/** Maximum canonical bytes accepted for one v2 rollback-start root. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_START_ROOT_V2_MAX_BYTES =
  320 * 1024

/** Maximum canonical bytes accepted for one v2 reverse-operation receipt. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_V2_MAX_BYTES =
  128 * 1024

/** Maximum canonical bytes accepted for one immutable v2 rolled-back root. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLED_BACK_ROOT_V2_MAX_BYTES =
  320 * 1024

const rollbackOriginVersion = 1
const zeroDigest = '0'.repeat(64)
const maximumSafeGraphArrayLength = 4_096
const maximumSafeGraphDepth = 64
const maximumSafeGraphNodes = 100_000
const maximumSafeGraphObjectProperties = 1_024
const maximumSafeGraphTextBytes =
  WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES
const planSealRole = 'plan-seals'
const tableRoles: readonly WorkspaceSearchMigrationTableRole[] = [
  ...workspaceSearchMigrationSourceNames,
  'workspace-search',
  'migration-state',
]

/**
 * Stable raw-value-free failure for invalid v2 rollback persistence.
 */
export class WorkspaceSearchMigrationRollbackPersistenceV2Error
  extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code = 'INVALID_ROLLBACK_PERSISTENCE_V2'

  /** Creates one stable committed-prefix persistence failure. */
  constructor() {
    super('INVALID_ROLLBACK_PERSISTENCE_V2')
    this.name = 'WorkspaceSearchMigrationRollbackPersistenceV2Error'
  }
}

const strictGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failRollbackPersistenceV2,
)

/**
 * Exact admission predecessor fixed by one committed-prefix origin.
 */
export type WorkspaceSearchMigrationRollbackAdmissionPredecessorV2 = {
  /** Immutable admission predecessor discriminator. */
  readonly kind: 'execution-run-admission'
  /** Exact revision represented by the immutable admission. */
  readonly revision: 1
  /** Digest of the exact immutable execution admission. */
  readonly predecessorDigest: string
  /** Digest of the exact initial applying run state. */
  readonly predecessorRunStateDigest: string
}

/**
 * Exact mutable predecessor fixed by one committed-prefix origin.
 */
export type WorkspaceSearchMigrationRollbackMutablePredecessorV2 = {
  /** Mutable execution-state predecessor discriminator. */
  readonly kind: 'mutable-execution-state'
  /** Exact mutable envelope schema version. */
  readonly executionStateVersion: 1 | 2
  /** Exact optimistic-concurrency revision represented by the state. */
  readonly revision: number
  /** Digest of the exact mutable execution-state envelope. */
  readonly predecessorDigest: string
  /** Digest of the exact reconstructed applying run state. */
  readonly predecessorRunStateDigest: string
}

/**
 * Exact external predecessor identity fixed by a v2 rollback origin.
 */
export type WorkspaceSearchMigrationRollbackPredecessorV2 =
  | WorkspaceSearchMigrationRollbackAdmissionPredecessorV2
  | WorkspaceSearchMigrationRollbackMutablePredecessorV2

/**
 * Immutable committed-prefix apply-chain origin for rollback v2.
 */
export type WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2 = {
  /** Committed-prefix rollback-origin discriminator. */
  readonly kind:
    'workspace-search-migration-committed-prefix-rollback-origin'
  /** Nested rollback-origin schema version. */
  readonly originVersion: typeof rollbackOriginVersion
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Exact immutable plan root. */
  readonly planDigest: string
  /** Exact immutable plan operation count. */
  readonly planOperationCount: number
  /** Rich exact-version reference to the admitted plan seal. */
  readonly planSealReference:
    WorkspaceSearchMigrationExecutionRun['binding']['planSealReference']
  /** Earliest retained journal deadline, or null for no mutations. */
  readonly minimumJournalRetainUntil: string | null
  /** Exact external admission or mutable predecessor identity. */
  readonly predecessor: WorkspaceSearchMigrationRollbackPredecessorV2
  /** Exact pure committed-prefix seal stored in immutable object storage. */
  readonly seal: WorkspaceSearchApplySeal
  /** Rich exact-version reference to the canonical seal bytes. */
  readonly sealReference:
    WorkspaceSearchMigrationCommittedPrefixApplySealReference
  /** Digest of every preceding immutable origin field. */
  readonly originDigest: string
}

/**
 * Compact fresh authority atomically consumed by one rollback transaction.
 */
export type WorkspaceSearchMigrationRollbackAuthorityBindingV2 = {
  /** Lease owner condition-checked by the transaction. */
  readonly ownerId: string
  /** Lease takeover fence condition-checked by the transaction. */
  readonly fenceToken: number
  /** Current maintenance-evidence pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the exact current immutable maintenance receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Adapter-owned time at which current authority was evaluated. */
  readonly evaluatedAt: string
}

/**
 * Durable rollback lifecycle state rooted in one committed prefix.
 */
export type WorkspaceSearchMigrationRollbackPersistenceStateV2 = {
  /** Rollback-state discriminator. */
  readonly kind: 'workspace-search-migration-rollback-state'
  /** Committed-prefix rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the exact committed-prefix rollback origin. */
  readonly originDigest: string
  /** Digest of the exact immutable rollback-start root. */
  readonly startRootDigest: string
  /** Fresh authority atomically adopted by this durable state. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBindingV2
  /** Rolling-back or terminal rolled-back lifecycle status. */
  readonly status: 'rolling-back' | 'rolled-back'
  /** Exact optimistic-concurrency revision of the pure run state. */
  readonly revision: number
  /** Kind of immutable predecessor consumed by this transition. */
  readonly predecessorKind:
    | 'committed-prefix-origin'
    | 'rollback-state'
  /** Exact committed-prefix origin or predecessor-state digest. */
  readonly predecessorDigest: string
  /** Final committed mutation sequence fixed by the origin seal. */
  readonly upperBoundSequence: number
  /** Next reverse sequence, or zero after the journal reaches its root. */
  readonly nextSequence: number
  /** Journal head expected by the next reverse operation. */
  readonly expectedHeadDigest: string
  /** Exact count of reverse operations already restored. */
  readonly restored: number
  /**
   * Digest of the last pure rollback marker, or null before any restore.
   *
   * The logical marker digest intentionally excludes the enclosing durable
   * receipt self digest, avoiding a cycle through the successor state digest.
   */
  readonly lastRollbackReceiptDigest: string | null
  /** Complete validated rolling-back or rolled-back pure run state. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Digest of the losslessly encoded complete pure run state. */
  readonly runStateDigest: string
  /** Digest of every preceding canonical state field. */
  readonly stateDigest: string
}

/**
 * Immutable root that atomically starts rollback from a committed prefix.
 */
export type WorkspaceSearchMigrationRollbackStartRootV2 = {
  /** Rollback-start root discriminator. */
  readonly kind: 'workspace-search-migration-rollback-start-root'
  /** Committed-prefix rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Complete immutable committed-prefix origin. */
  readonly origin:
    WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2
  /** Digest of the exact committed-prefix origin. */
  readonly originDigest: string
  /** Exact applying predecessor revision consumed by rollback start. */
  readonly predecessorRevision: number
  /** Digest of the exact external predecessor admission or state. */
  readonly predecessorDigest: string
  /** Digest of the exact applying predecessor pure run state. */
  readonly predecessorRunStateDigest: string
  /** Final forward mutation sequence captured at rollback start. */
  readonly originalJournalSequence: number
  /** Final forward journal head captured at rollback start. */
  readonly originalJournalHeadDigest: string
  /** Fresh authority atomically consumed by rollback start. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBindingV2
  /** Canonical adapter-owned rollback-start transaction time. */
  readonly startedAt: string
  /** Complete initial rolling-back persistence state. */
  readonly initialState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Digest of the complete initial rolling-back state. */
  readonly initialStateDigest: string
  /** Digest of the exact initial rolling-back pure run state. */
  readonly initialRunStateDigest: string
  /** Digest of every non-circular immutable root field. */
  readonly startRootDigest: string
}

/**
 * Deterministic identity of one exact v2 reverse journal operation.
 */
export type WorkspaceSearchMigrationRollbackOperationCommandIdentityV2 = {
  /** Rollback-command discriminator. */
  readonly kind: 'workspace-search-migration-rollback-operation-command'
  /** Committed-prefix rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable committed-prefix origin. */
  readonly originDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the immutable rollback-start root. */
  readonly startRootDigest: string
  /** Exact predecessor optimistic-concurrency revision. */
  readonly expectedRevision: number
  /** Digest of the exact predecessor rollback state. */
  readonly predecessorStateDigest: string
  /** Reverse journal sequence consumed by the command. */
  readonly sequence: number
  /** Stable forward operation identifier restored by the command. */
  readonly operationId: string
  /** Digest of the exact immutable forward apply receipt. */
  readonly applyReceiptDigest: string
  /** Digest of the exact rich journal object reference. */
  readonly journalReferenceDigest: string
  /** Digest of every preceding deterministic command field. */
  readonly commandDigest: string
}

/**
 * Immutable durable v2 receipt for one exact reverse target restoration.
 */
export type WorkspaceSearchMigrationRollbackOperationReceiptV2 = {
  /** Durable rollback-receipt discriminator. */
  readonly kind: 'workspace-search-migration-rollback-operation-receipt'
  /** Committed-prefix rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable committed-prefix origin. */
  readonly originDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the immutable rollback-start root. */
  readonly startRootDigest: string
  /** Fresh authority atomically consumed by this reverse operation. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBindingV2
  /** Reverse journal sequence restored by this receipt. */
  readonly sequence: number
  /** Stable forward operation identifier restored by this receipt. */
  readonly operationId: string
  /** Digest of the deterministic reverse command. */
  readonly commandDigest: string
  /** Exact immutable forward operation receipt. */
  readonly applyReceipt: WorkspaceSearchOperationReceipt
  /** Digest of the exact immutable forward operation receipt. */
  readonly applyReceiptDigest: string
  /** Digest of the exact rich journal object reference. */
  readonly journalReferenceDigest: string
  /** Previous journal head reached after this restoration. */
  readonly previousJournalHeadDigest: string
  /** Exact pure rollback marker committed with target restoration. */
  readonly rollbackReceipt: WorkspaceSearchRollbackReceipt
  /** Digest of the exact pure rollback marker. */
  readonly rollbackReceiptDigest: string
  /** Exact predecessor optimistic-concurrency revision. */
  readonly predecessorRevision: number
  /** Digest of the exact predecessor rollback state. */
  readonly predecessorStateDigest: string
  /** Exact successor optimistic-concurrency revision. */
  readonly successorRevision: number
  /** Digest of the exact successor rollback state. */
  readonly successorStateDigest: string
  /** Canonical adapter-owned rollback transaction time. */
  readonly committedAt: string
  /** Digest of every preceding immutable receipt field. */
  readonly receiptDigest: string
}

/**
 * Immutable v2 terminal root proving rollback reached the zero journal head.
 */
export type WorkspaceSearchMigrationRolledBackRootV2 = {
  /** Rolled-back root discriminator. */
  readonly kind: 'workspace-search-migration-rolled-back-root'
  /** Committed-prefix rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable committed-prefix origin. */
  readonly originDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the immutable rollback-start root. */
  readonly startRootDigest: string
  /** Complete terminal rolled-back persistence state. */
  readonly terminalState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Digest of the exact terminal rolled-back state. */
  readonly terminalStateDigest: string
  /** Final reverse receipt, or null for a zero-mutation prefix. */
  readonly terminalReceipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2 | null
  /** Digest of the final reverse receipt, or null when absent. */
  readonly terminalReceiptDigest: string | null
  /** Digest of the exact terminal rolled-back pure run state. */
  readonly finalRunStateDigest: string
  /** Fresh authority atomically consumed by terminal publication. */
  readonly finalAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBindingV2
  /** Canonical rollback-start time fixed by the immutable start root. */
  readonly rollbackStartedAt: string
  /** Canonical adapter-owned terminal transaction time. */
  readonly finishedAt: string
  /** Digest of every preceding immutable terminal-root field. */
  readonly rootDigest: string
}

/**
 * Material required to create one strict committed-prefix origin.
 */
export type CreateWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2Input =
  {
    /** Immutable revision-one execution admission. */
    readonly admission: WorkspaceSearchMigrationExecutionRun
    /** Explicit admission or exact mutable execution-state predecessor. */
    readonly predecessor:
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    /** Exact immutable version-two planning authority. */
    readonly sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2
    /** Exact strict pure committed-prefix seal. */
    readonly seal: WorkspaceSearchApplySeal
    /** Rich exact-version reference to the canonical seal bytes. */
    readonly sealReference:
      WorkspaceSearchMigrationCommittedPrefixApplySealReference
  }

/**
 * Material required to create one v2 committed-prefix rollback start.
 */
export type CreateWorkspaceSearchMigrationRollbackStartRootV2Input =
  CreateWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2Input & {
    /** Fresh current authority consumed by the start transaction. */
    readonly currentAuthority:
      WorkspaceSearchMigrationPrePlanAuthority
    /** Adapter-owned canonical rollback-start transaction time. */
    readonly startedAt: string
  }

/**
 * Material required to derive one deterministic v2 reverse command.
 */
export type CreateWorkspaceSearchMigrationRollbackOperationCommandIdentityV2Input = {
  /** Immutable committed-prefix rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Exact current rolling-back predecessor state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Exact durable forward operation receipt at the reverse cursor. */
  readonly applyReceipt: WorkspaceSearchOperationReceipt
}

/**
 * Material required to create one v2 reverse-operation transition.
 */
export type CreateWorkspaceSearchMigrationRollbackOperationTransitionV2Input = {
  /** Immutable committed-prefix rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Exact current rolling-back predecessor state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Fresh current authority consumed by the reverse transaction. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Exact durable forward operation receipt at the reverse cursor. */
  readonly applyReceipt: WorkspaceSearchOperationReceipt
  /** Exact-version journal segment referenced by the forward receipt. */
  readonly journalSegment: WorkspaceSearchJournalSegment
  /** Adapter-owned canonical reverse transaction time. */
  readonly committedAt: string
}

/**
 * Complete pure and durable result of one v2 reverse operation.
 */
export type WorkspaceSearchMigrationRollbackOperationTransitionV2 = {
  /** Deterministic identity of the exact reverse command. */
  readonly commandIdentity:
    WorkspaceSearchMigrationRollbackOperationCommandIdentityV2
  /** Immutable durable reverse-operation receipt. */
  readonly receipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2
  /** Complete pure successor run state. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Complete resumable successor rollback state. */
  readonly state:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
}

/**
 * Material required to finish v2 rollback at the zero journal root.
 */
export type FinishWorkspaceSearchMigrationRollbackV2Input = {
  /** Immutable committed-prefix rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Exact zero-head rolling-back predecessor state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Fresh current authority consumed by terminal publication. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
  /** Final reverse receipt, or null for a zero-mutation prefix. */
  readonly terminalReceipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2 | null
  /** Adapter-owned canonical terminal transaction time. */
  readonly finishedAt: string
}

/**
 * Complete pure and durable terminal v2 rollback result.
 */
export type WorkspaceSearchMigrationRollbackFinishedTransitionV2 = {
  /** Immutable authoritative v2 rolled-back root. */
  readonly root: WorkspaceSearchMigrationRolledBackRootV2
  /** Complete terminal pure run state. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Complete terminal rolled-back persistence state. */
  readonly state:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
}

/**
 * Resolved exact origin together with its external applying predecessor.
 */
type ResolvedOrigin = {
  /** Strict immutable committed-prefix origin. */
  readonly origin:
    WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2
  /** Exact applying pure run state represented by the predecessor. */
  readonly predecessorRunState: WorkspaceSearchMigrationRunState
}

/**
 * JSON-safe checkpoint whose optional cursor uses the tagged DynamoDB codec.
 */
type EncodedCheckpoint = {
  /** Whether the scan represented by this checkpoint completed. */
  readonly completed: boolean
  /** Optional losslessly encoded DynamoDB continuation key. */
  readonly cursor?: EncodedAttributeMap
  /** Complete cumulative scan aggregate. */
  readonly aggregate: MigrationScanAggregate
  /** Restorable physical-key digest accumulator. */
  readonly keyDigestState: MigrationDigestState
  /** Restorable row-content digest accumulator. */
  readonly contentDigestState: MigrationDigestState
}

/**
 * JSON-safe source and target traversal.
 */
type EncodedTraversal = {
  /** Per-source encoded checkpoints. */
  readonly sources: Readonly<
    Record<
      (typeof workspaceSearchMigrationSourceNames)[number],
      EncodedCheckpoint
    >
  >
  /** Encoded target checkpoint. */
  readonly target: EncodedCheckpoint
}

/**
 * Internal state shape before its self digest is attached.
 */
type RollbackStateV2Common = Omit<
  WorkspaceSearchMigrationRollbackPersistenceStateV2,
  'stateDigest'
>

/**
 * Internal root shape before its self digest is attached.
 */
type RollbackStartRootV2Common = Omit<
  WorkspaceSearchMigrationRollbackStartRootV2,
  'startRootDigest'
>

/**
 * Immutable identity repeated across one v2 rollback chain.
 */
type RollbackBindingV2 = {
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationSealedPlanningTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable committed-prefix origin. */
  readonly originDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
}

/**
 * Exact material used to create one mutable v2 rollback state.
 */
type CreatePersistenceStateV2Input = {
  /** Shared immutable v2 rollback identity. */
  readonly binding: RollbackBindingV2
  /** Digest of the exact immutable rollback-start root. */
  readonly startRootDigest: string
  /** Fresh authority atomically adopted by this state. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBindingV2
  /** Complete pure successor state. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Kind of predecessor consumed by this transition. */
  readonly predecessorKind:
    WorkspaceSearchMigrationRollbackPersistenceStateV2['predecessorKind']
  /** Exact predecessor digest. */
  readonly predecessorDigest: string
  /** Digest of the last pure rollback marker, or null. */
  readonly lastRollbackReceiptDigest: string | null
}

/**
 * Exact strict values used to construct one durable v2 reverse receipt.
 */
type CreateOperationReceiptV2Input = {
  /** Immutable committed-prefix rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Exact rolling-back predecessor state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Exact rolling-back successor state. */
  readonly successorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Fresh compact authority consumed by the reverse transaction. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBindingV2
  /** Deterministic reverse-command identity. */
  readonly commandIdentity:
    WorkspaceSearchMigrationRollbackOperationCommandIdentityV2
  /** Exact immutable forward apply receipt. */
  readonly applyReceipt: WorkspaceSearchOperationReceipt
  /** Exact immutable journal segment used by the reducer. */
  readonly journalSegment: WorkspaceSearchJournalSegment
  /** Exact pure rollback marker produced by the reducer. */
  readonly rollbackReceipt: WorkspaceSearchRollbackReceipt
  /** Canonical reverse transaction commit time. */
  readonly committedAt: string
}

/**
 * Bounded descriptor-safe graph traversal state.
 */
type SafeGraphBudget = {
  /** Number of inspected nodes and own entries. */
  nodes: number
  /** Total bytes across trusted binary values. */
  binaryBytes: number
  /** Total UTF-8 bytes across string values and property keys. */
  textBytes: number
  /** Nodes active in the current recursion stack. */
  active: WeakSet<object>
  /** Nodes already fully inspected. */
  visited: WeakSet<object>
}

/**
 * Creates one immutable committed-prefix rollback origin.
 *
 * @param input - Admission, explicit predecessor, planning root, seal, and reference.
 * @returns Detached strict committed-prefix origin.
 */
export function createWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
  input:
    CreateWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2Input,
): WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2 {
  return atRollbackPersistenceV2Boundary(
    () => resolveOrigin(input).origin,
  )
}

/**
 * Creates one immutable v2 rollback-start root and initial durable state.
 *
 * @param input - Exact committed-prefix evidence, authority, and transaction time.
 * @returns Detached strict rollback-start root.
 */
export function createWorkspaceSearchMigrationRollbackStartRootV2(
  input: CreateWorkspaceSearchMigrationRollbackStartRootV2Input,
): WorkspaceSearchMigrationRollbackStartRootV2 {
  return atRollbackPersistenceV2Boundary(() => {
    const inputRecord = strictGuards.requireRecord(input)
    strictGuards.requireExactKeys(inputRecord, [
      'admission',
      'currentAuthority',
      'predecessor',
      'seal',
      'sealReference',
      'sealedPlanningAuthority',
      'startedAt',
    ])
    const admission = requireAdmission(
      strictGuards.readOwn(inputRecord, 'admission'),
    )
    const predecessorInput = requirePredecessor(
      strictGuards.readOwn(inputRecord, 'predecessor'),
    )
    const sealedPlanningAuthority =
      requireSealedPlanningAuthority(
        strictGuards.readOwn(
          inputRecord,
          'sealedPlanningAuthority',
        ),
      )
    const seal = requireSeal(
      strictGuards.readOwn(inputRecord, 'seal'),
    )
    const sealReference =
      readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
        strictGuards.readOwn(inputRecord, 'sealReference'),
      )
    const resolved = resolveOrigin({
      admission,
      predecessor: predecessorInput,
      sealedPlanningAuthority,
      seal,
      sealReference,
    })
    const currentAuthority =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        requireCurrentAuthority(
          strictGuards.readOwn(inputRecord, 'currentAuthority'),
        ),
      )
    const startedAt = strictGuards.readTimestamp(
      strictGuards.readOwn(inputRecord, 'startedAt'),
    )
    const predecessor = resolved.predecessorRunState
    requireStartAuthority(
      resolved.origin,
      predecessor,
      admission,
      currentAuthority,
      startedAt,
    )
    requireStartRetention(
      resolved.origin,
      startedAt,
    )
    const authorityBinding = createAuthorityBinding(currentAuthority)
    const effectivePredecessor = createAuthorityAdoptedPredecessor(
      predecessor,
      currentAuthority,
      resolved.origin.seal.createdAt,
    )
    const pureReference = createPureSealReference(
      resolved.origin.sealReference,
    )
    const transitionAuthority:
      WorkspaceSearchMigrationAuthority = {
        lease: currentAuthority.lease,
        ownerId: currentAuthority.lease.ownerId,
        at: startedAt,
      }
    const runState = reduceWorkspaceSearchMigrationRunState({
      current: effectivePredecessor,
      expectedRevision: predecessor.revision,
      authority: transitionAuthority,
      event: {
        kind: 'rollback-started',
        seal: resolved.origin.seal,
        reference: pureReference,
      },
    })
    const tableIds = readTableIds(
      admission.binding.tableIds,
    )
    const stateInput = {
      runId: resolved.origin.runId,
      configurationHash: resolved.origin.configurationHash,
      tableIds,
      executionRunDigest: resolved.origin.executionRunDigest,
      sealedPlanningAuthorityDigest:
        resolved.origin.sealedPlanningAuthorityDigest,
      originDigest: resolved.origin.originDigest,
      currentAuthority: authorityBinding,
      runState,
    }
    const provisionalState = createInitialState(
      stateInput,
      zeroDigest,
    )
    const provisionalCommon = {
      kind: 'workspace-search-migration-rollback-start-root',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: resolved.origin.runId,
      configurationHash: resolved.origin.configurationHash,
      tableIds,
      executionRunDigest: resolved.origin.executionRunDigest,
      sealedPlanningAuthorityDigest:
        resolved.origin.sealedPlanningAuthorityDigest,
      origin: resolved.origin,
      originDigest: resolved.origin.originDigest,
      predecessorRevision: resolved.origin.predecessor.revision,
      predecessorDigest:
        resolved.origin.predecessor.predecessorDigest,
      predecessorRunStateDigest:
        resolved.origin.predecessor.predecessorRunStateDigest,
      originalJournalSequence:
        resolved.origin.seal.journalSequence,
      originalJournalHeadDigest:
        resolved.origin.seal.journalHeadDigest,
      currentAuthority: authorityBinding,
      startedAt,
      initialState: provisionalState,
      initialStateDigest: provisionalState.stateDigest,
      initialRunStateDigest: provisionalState.runStateDigest,
    } satisfies RollbackStartRootV2Common
    const startRootDigest =
      createRollbackStartRootDigest(provisionalCommon)
    const initialState = createInitialState(
      stateInput,
      startRootDigest,
    )
    const root = readStartRootRuntime({
      ...provisionalCommon,
      initialState,
      initialStateDigest: initialState.stateDigest,
      initialRunStateDigest: initialState.runStateDigest,
      startRootDigest,
    })
    encodeStartRoot(root)
    return root
  })
}

/**
 * Serializes one strict committed-prefix origin as canonical UTF-8 JSON.
 *
 * @param value - Candidate committed-prefix origin.
 * @returns Exact bounded canonical bytes.
 */
export function serializeWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
  value: WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
): Uint8Array {
  return atRollbackPersistenceV2Boundary(() =>
    encodeCanonical(
      readOrigin(value),
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_ORIGIN_V2_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical committed-prefix origin.
 *
 * @param bytes - Untrusted bounded canonical bytes.
 * @returns Detached strict committed-prefix origin.
 */
export function parseWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
  bytes: Uint8Array,
): WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2 {
  return parseCanonical(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_ORIGIN_V2_MAX_BYTES,
    readOrigin,
    (value) =>
      encodeCanonical(
        value,
        WORKSPACE_SEARCH_MIGRATION_ROLLBACK_ORIGIN_V2_MAX_BYTES,
      ),
  )
}

/**
 * Serializes one strict v2 rollback lifecycle state.
 *
 * @param value - Candidate committed-prefix rollback lifecycle state.
 * @returns Exact bounded canonical bytes with lossless checkpoint cursors.
 */
export function serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
  value: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): Uint8Array {
  return atRollbackPersistenceV2Boundary(() => {
    const state = readStateRuntime(value)
    return encodeCanonical(
      createStateDocument(state),
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_V2_MAX_BYTES,
    )
  })
}

/**
 * Parses one exact canonical v2 rollback lifecycle state.
 *
 * @param bytes - Untrusted bounded canonical state bytes.
 * @returns Detached strict committed-prefix rollback lifecycle state.
 */
export function parseWorkspaceSearchMigrationRollbackPersistenceStateV2(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
  return parseCanonical(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_V2_MAX_BYTES,
    readStateDocument,
    (value) =>
      encodeCanonical(
        createStateDocument(value),
        WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_V2_MAX_BYTES,
      ),
  )
}

/**
 * Serializes one strict immutable v2 rollback-start root.
 *
 * @param value - Candidate committed-prefix rollback-start root.
 * @returns Exact bounded canonical bytes.
 */
export function serializeWorkspaceSearchMigrationRollbackStartRootV2(
  value: WorkspaceSearchMigrationRollbackStartRootV2,
): Uint8Array {
  return atRollbackPersistenceV2Boundary(() =>
    encodeStartRoot(readStartRootRuntime(value))
  )
}

/**
 * Parses one exact canonical immutable v2 rollback-start root.
 *
 * @param bytes - Untrusted bounded canonical root bytes.
 * @returns Detached strict committed-prefix rollback-start root.
 */
export function parseWorkspaceSearchMigrationRollbackStartRootV2(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRollbackStartRootV2 {
  return parseCanonical(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_START_ROOT_V2_MAX_BYTES,
    readStartRootDocument,
    encodeStartRoot,
  )
}

/**
 * Creates the deterministic identity of one exact v2 reverse operation.
 *
 * @param input - Start root, predecessor state, and forward receipt.
 * @returns Detached deterministic reverse-command identity.
 */
export function createWorkspaceSearchMigrationRollbackOperationCommandIdentityV2(
  input:
    CreateWorkspaceSearchMigrationRollbackOperationCommandIdentityV2Input,
): WorkspaceSearchMigrationRollbackOperationCommandIdentityV2 {
  return atRollbackPersistenceV2Boundary(() => {
    const record = strictGuards.requireRecord(input)
    strictGuards.requireExactKeys(record, [
      'applyReceipt',
      'predecessorState',
      'startRoot',
    ])
    const startRoot = readStartRootRuntime(
      strictGuards.readOwn(record, 'startRoot'),
    )
    const predecessorState = readStateRuntime(
      strictGuards.readOwn(record, 'predecessorState'),
    )
    const applyReceipt = readApplyReceipt(
      strictGuards.readOwn(record, 'applyReceipt'),
    )
    requireStateBelongsToStart(startRoot, predecessorState)
    requirePendingRollbackSequence(predecessorState, applyReceipt)
    return createCommandIdentity(
      startRoot,
      predecessorState,
      applyReceipt,
    )
  })
}

/**
 * Reduces and binds one exact v2 reverse operation.
 *
 * @param input - Start root, predecessor, authority, receipt, and journal.
 * @returns Exact pure successor, durable state, command, and receipt.
 */
export function createWorkspaceSearchMigrationRollbackOperationTransitionV2(
  input:
    CreateWorkspaceSearchMigrationRollbackOperationTransitionV2Input,
): WorkspaceSearchMigrationRollbackOperationTransitionV2 {
  return atRollbackPersistenceV2Boundary(() => {
    const record = strictGuards.requireRecord(input)
    strictGuards.requireExactKeys(record, [
      'applyReceipt',
      'committedAt',
      'currentAuthority',
      'journalSegment',
      'predecessorState',
      'startRoot',
    ])
    const startRoot = readStartRootRuntime(
      strictGuards.readOwn(record, 'startRoot'),
    )
    const predecessorState = readStateRuntime(
      strictGuards.readOwn(record, 'predecessorState'),
    )
    const currentAuthority =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        requireCurrentAuthority(
          strictGuards.readOwn(record, 'currentAuthority'),
        ),
      )
    const applyReceipt = readApplyReceipt(
      strictGuards.readOwn(record, 'applyReceipt'),
    )
    const journalSegment = readJournalSegment(
      strictGuards.readOwn(record, 'journalSegment'),
    )
    const committedAt = strictGuards.readTimestamp(
      strictGuards.readOwn(record, 'committedAt'),
    )
    requireStateBelongsToStart(startRoot, predecessorState)
    requirePendingRollbackSequence(predecessorState, applyReceipt)
    requireRollbackEvidence(
      startRoot,
      applyReceipt,
      journalSegment,
      committedAt,
    )
    requireAuthorityForRunState(
      createBindingFromStartRoot(startRoot),
      predecessorState.runState,
      predecessorState.currentAuthority,
      currentAuthority,
      committedAt,
    )
    const authority = createPureAuthority(
      currentAuthority,
      committedAt,
    )
    const authorizedPredecessor = createAuthorityAdoptedRunState(
      predecessorState.runState,
      currentAuthority,
      committedAt,
    )
    const event = createWorkspaceSearchRollbackOperationRecordedEvent(
      authorizedPredecessor,
      authority,
      {
        kind: 'rollback-operation-requested',
        applyReceipt,
        journalSegment,
      },
    )
    const runState = reduceWorkspaceSearchMigrationRunState({
      current: authorizedPredecessor,
      expectedRevision: predecessorState.revision,
      authority,
      event,
    })
    const rollbackReceiptDigest = createMigrationDigest(event.receipt)
    const state = createPersistenceState({
      binding: createBindingFromStartRoot(startRoot),
      startRootDigest: startRoot.startRootDigest,
      currentAuthority: createAuthorityBinding(currentAuthority),
      runState,
      predecessorKind: 'rollback-state',
      predecessorDigest: predecessorState.stateDigest,
      lastRollbackReceiptDigest: rollbackReceiptDigest,
    })
    const commandIdentity = createCommandIdentity(
      startRoot,
      predecessorState,
      applyReceipt,
    )
    const receipt = createOperationReceipt({
      startRoot,
      predecessorState,
      successorState: state,
      currentAuthority: createAuthorityBinding(currentAuthority),
      commandIdentity,
      applyReceipt,
      journalSegment,
      rollbackReceipt: event.receipt,
      committedAt,
    })
    validateWorkspaceSearchMigrationRollbackOperationReceiptTransitionV2({
      startRoot,
      receipt,
      journalSegment,
      predecessorState,
      successorState: state,
    })
    return {
      commandIdentity,
      receipt,
      runState,
      state,
    }
  })
}

/**
 * Completes v2 rollback only after the pure state reaches the zero journal root.
 *
 * @param input - Start root, zero-head predecessor, authority, and final receipt.
 * @returns Exact pure terminal state, durable state, and immutable root.
 */
export function finishWorkspaceSearchMigrationRollbackV2(
  input: FinishWorkspaceSearchMigrationRollbackV2Input,
): WorkspaceSearchMigrationRollbackFinishedTransitionV2 {
  return atRollbackPersistenceV2Boundary(() => {
    const record = strictGuards.requireRecord(input)
    strictGuards.requireExactKeys(record, [
      'currentAuthority',
      'finishedAt',
      'predecessorState',
      'startRoot',
      'terminalReceipt',
    ])
    const startRoot = readStartRootRuntime(
      strictGuards.readOwn(record, 'startRoot'),
    )
    const predecessorState = readStateRuntime(
      strictGuards.readOwn(record, 'predecessorState'),
    )
    const currentAuthority =
      detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
        requireCurrentAuthority(
          strictGuards.readOwn(record, 'currentAuthority'),
        ),
      )
    const terminalReceiptValue = strictGuards.readOwn(
      record,
      'terminalReceipt',
    )
    const terminalReceipt = terminalReceiptValue === null
      ? null
      : readOperationReceipt(terminalReceiptValue)
    const finishedAt = strictGuards.readTimestamp(
      strictGuards.readOwn(record, 'finishedAt'),
    )
    requireStateBelongsToStart(startRoot, predecessorState)
    requireFinishReceipt(
      startRoot,
      predecessorState,
      terminalReceipt,
    )
    if (
      Date.parse(finishedAt) < Date.parse(startRoot.startedAt) ||
      Date.parse(finishedAt) <
        Date.parse(predecessorState.runState.updatedAt) ||
      (
        terminalReceipt !== null &&
        Date.parse(finishedAt) <
          Date.parse(terminalReceipt.committedAt)
      )
    ) {
      return failRollbackPersistenceV2()
    }
    requireAuthorityBindingSuccessor(
      startRoot.currentAuthority,
      createAuthorityBinding(currentAuthority),
    )
    requireAuthorityForRunState(
      createBindingFromStartRoot(startRoot),
      predecessorState.runState,
      predecessorState.currentAuthority,
      currentAuthority,
      finishedAt,
    )
    const authority = createPureAuthority(
      currentAuthority,
      finishedAt,
    )
    const authorizedPredecessor = createAuthorityAdoptedRunState(
      predecessorState.runState,
      currentAuthority,
      finishedAt,
    )
    const runState = reduceWorkspaceSearchMigrationRunState({
      current: authorizedPredecessor,
      expectedRevision: predecessorState.revision,
      authority,
      event: { kind: 'rollback-finished' },
    })
    const state = createPersistenceState({
      binding: createBindingFromStartRoot(startRoot),
      startRootDigest: startRoot.startRootDigest,
      currentAuthority: createAuthorityBinding(currentAuthority),
      runState,
      predecessorKind: 'rollback-state',
      predecessorDigest: predecessorState.stateDigest,
      lastRollbackReceiptDigest:
        predecessorState.lastRollbackReceiptDigest,
    })
    const common = {
      kind: 'workspace-search-migration-rolled-back-root',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: startRoot.runId,
      configurationHash: startRoot.configurationHash,
      tableIds: startRoot.tableIds,
      executionRunDigest: startRoot.executionRunDigest,
      originDigest: startRoot.originDigest,
      sealedPlanningAuthorityDigest:
        startRoot.sealedPlanningAuthorityDigest,
      startRootDigest: startRoot.startRootDigest,
      terminalState: state,
      terminalStateDigest: state.stateDigest,
      terminalReceipt,
      terminalReceiptDigest:
        terminalReceipt?.receiptDigest ?? null,
      finalRunStateDigest: state.runStateDigest,
      finalAuthority: createAuthorityBinding(currentAuthority),
      rollbackStartedAt: startRoot.startedAt,
      finishedAt,
    } satisfies Omit<
      WorkspaceSearchMigrationRolledBackRootV2,
      'rootDigest'
    >
    const root = readRolledBackRootRuntime({
      ...common,
      rootDigest: createMigrationDigest(
        createRolledBackRootCommonDocument(common),
      ),
    })
    encodeRolledBackRoot(root)
    return { root, runState, state }
  })
}

/**
 * Detaches the complete pure run state retained by one v2 persistence state.
 *
 * @param state - Candidate strict v2 rollback persistence state.
 * @returns Detached validated pure run state suitable for restart.
 */
export function decodeWorkspaceSearchMigrationRollbackRunStateV2(
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): WorkspaceSearchMigrationRunState {
  return atRollbackPersistenceV2Boundary(() => {
    const strictState = readStateRuntime(state)
    return parseWorkspaceSearchMigrationRollbackPersistenceStateV2(
      serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
        strictState,
      ),
    ).runState
  })
}

/**
 * Validates that one compact v2 rollback authority succeeds another.
 *
 * @param predecessor - Authority already fixed by durable rollback evidence.
 * @param current - Candidate authority retained by a later record.
 */
export function validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
  predecessor: WorkspaceSearchMigrationRollbackAuthorityBindingV2,
  current: WorkspaceSearchMigrationRollbackAuthorityBindingV2,
): void {
  return atRollbackPersistenceV2Boundary(() =>
    requireAuthorityBindingSuccessor(
      readAuthorityBinding(predecessor),
      readAuthorityBinding(current),
    )
  )
}

/**
 * Serializes one deterministic v2 reverse-command identity.
 *
 * @param value - Candidate reverse-command identity.
 * @returns Exact bounded canonical UTF-8 JSON bytes.
 */
export function serializeWorkspaceSearchMigrationRollbackOperationCommandIdentityV2(
  value: WorkspaceSearchMigrationRollbackOperationCommandIdentityV2,
): Uint8Array {
  return atRollbackPersistenceV2Boundary(() =>
    encodeCanonical(
      readCommandIdentity(value),
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_V2_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical v2 reverse-command identity.
 *
 * @param bytes - Untrusted bounded canonical command bytes.
 * @returns Detached strict reverse-command identity.
 */
export function parseWorkspaceSearchMigrationRollbackOperationCommandIdentityV2(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRollbackOperationCommandIdentityV2 {
  return parseCanonical(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_V2_MAX_BYTES,
    readCommandIdentity,
    (value) =>
      encodeCanonical(
        value,
        WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_V2_MAX_BYTES,
      ),
  )
}

/**
 * Serializes one strict immutable v2 reverse-operation receipt.
 *
 * @param value - Candidate immutable reverse receipt.
 * @returns Exact bounded canonical UTF-8 JSON bytes.
 */
export function serializeWorkspaceSearchMigrationRollbackOperationReceiptV2(
  value: WorkspaceSearchMigrationRollbackOperationReceiptV2,
): Uint8Array {
  return atRollbackPersistenceV2Boundary(() =>
    encodeCanonical(
      readOperationReceipt(value),
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_V2_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical v2 reverse-operation receipt.
 *
 * @param bytes - Untrusted bounded canonical receipt bytes.
 * @returns Detached strict immutable reverse receipt.
 */
export function parseWorkspaceSearchMigrationRollbackOperationReceiptV2(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRollbackOperationReceiptV2 {
  return parseCanonical(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_V2_MAX_BYTES,
    readOperationReceipt,
    (value) =>
      encodeCanonical(
        value,
        WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_V2_MAX_BYTES,
      ),
  )
}

/**
 * Serializes one strict immutable v2 rolled-back root.
 *
 * @param value - Candidate immutable terminal root.
 * @returns Exact bounded canonical UTF-8 JSON bytes.
 */
export function serializeWorkspaceSearchMigrationRolledBackRootV2(
  value: WorkspaceSearchMigrationRolledBackRootV2,
): Uint8Array {
  return atRollbackPersistenceV2Boundary(() =>
    encodeRolledBackRoot(readRolledBackRootRuntime(value))
  )
}

/**
 * Parses one exact canonical immutable v2 rolled-back root.
 *
 * @param bytes - Untrusted bounded canonical terminal-root bytes.
 * @returns Detached strict immutable rolled-back root.
 */
export function parseWorkspaceSearchMigrationRolledBackRootV2(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRolledBackRootV2 {
  return parseCanonical(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLED_BACK_ROOT_V2_MAX_BYTES,
    readRolledBackRootDocument,
    encodeRolledBackRoot,
  )
}

/**
 * Exact values used to validate one durable v2 reverse transition.
 */
export type ValidateWorkspaceSearchMigrationRollbackOperationReceiptTransitionV2Input = {
  /** Immutable committed-prefix rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRootV2
  /** Immutable durable reverse-operation receipt. */
  readonly receipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2
  /** Exact immutable journal segment referenced by the apply receipt. */
  readonly journalSegment: WorkspaceSearchJournalSegment
  /** Exact rolling-back predecessor state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
  /** Exact rolling-back successor state. */
  readonly successorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2
}

/**
 * Validates both sides and immutable evidence of one v2 reverse transition.
 *
 * @param input - Start root, receipt, journal, predecessor, and successor.
 */
export function validateWorkspaceSearchMigrationRollbackOperationReceiptTransitionV2(
  input:
    ValidateWorkspaceSearchMigrationRollbackOperationReceiptTransitionV2Input,
): void {
  return atRollbackPersistenceV2Boundary(() => {
    const record = strictGuards.requireRecord(input)
    strictGuards.requireExactKeys(record, [
      'journalSegment',
      'predecessorState',
      'receipt',
      'startRoot',
      'successorState',
    ])
    const startRoot = readStartRootRuntime(
      strictGuards.readOwn(record, 'startRoot'),
    )
    const receipt = readOperationReceipt(
      strictGuards.readOwn(record, 'receipt'),
    )
    const journalSegment = readJournalSegment(
      strictGuards.readOwn(record, 'journalSegment'),
    )
    const predecessorState = readStateRuntime(
      strictGuards.readOwn(record, 'predecessorState'),
    )
    const successorState = readStateRuntime(
      strictGuards.readOwn(record, 'successorState'),
    )
    requireStateBelongsToStart(startRoot, predecessorState)
    requireStateBelongsToStart(startRoot, successorState)
    requireReceiptBelongsToStart(startRoot, receipt)
    requireRollbackEvidence(
      startRoot,
      receipt.applyReceipt,
      journalSegment,
      receipt.committedAt,
    )
    requireAuthorityBindingSuccessor(
      predecessorState.currentAuthority,
      receipt.currentAuthority,
    )
    const expectedCommand = createCommandIdentity(
      startRoot,
      predecessorState,
      receipt.applyReceipt,
    )
    if (
      receipt.commandDigest !== expectedCommand.commandDigest ||
      receipt.predecessorRevision !== predecessorState.revision ||
      receipt.predecessorStateDigest !==
        predecessorState.stateDigest ||
      receipt.successorRevision !== successorState.revision ||
      receipt.successorStateDigest !== successorState.stateDigest ||
      receipt.sequence !== predecessorState.nextSequence ||
      receipt.sequence !== receipt.applyReceipt.sequence ||
      receipt.operationId !== receipt.applyReceipt.operationId ||
      !sameAuthorityBinding(
        receipt.currentAuthority,
        successorState.currentAuthority,
      ) ||
      predecessorState.status !== 'rolling-back' ||
      successorState.status !== 'rolling-back' ||
      predecessorState.nextSequence < 1 ||
      successorState.revision !== predecessorState.revision + 1 ||
      successorState.predecessorKind !== 'rollback-state' ||
      successorState.predecessorDigest !==
        predecessorState.stateDigest ||
      successorState.upperBoundSequence !==
        predecessorState.upperBoundSequence ||
      successorState.nextSequence !==
        predecessorState.nextSequence - 1 ||
      successorState.expectedHeadDigest !==
        receipt.previousJournalHeadDigest ||
      successorState.restored !== predecessorState.restored + 1 ||
      successorState.lastRollbackReceiptDigest !==
        receipt.rollbackReceiptDigest ||
      predecessorState.expectedHeadDigest !==
        receipt.applyReceipt.journal.headDigest ||
      receipt.rollbackReceipt.journalHeadDigest !==
        predecessorState.expectedHeadDigest ||
      receipt.rollbackReceipt.fenceToken !==
        receipt.currentAuthority.fenceToken ||
      receipt.rollbackReceipt.maintenanceEvidenceReceiptDigest !==
        receipt.currentAuthority.maintenanceEvidenceReceiptDigest ||
      receipt.currentAuthority.maintenanceEvidenceReceiptDigest !==
        createMigrationDigest(
          successorState.runState.maintenanceEvidenceReceipt,
        )
    ) {
      return failRollbackPersistenceV2()
    }
    const authorizedPredecessor =
      createReceiptValidationPredecessor(
        predecessorState,
        successorState,
        receipt,
      )
    const authority = createReceiptValidationAuthority(
      predecessorState,
      receipt,
    )
    const expectedEvent =
      createWorkspaceSearchRollbackOperationRecordedEvent(
        authorizedPredecessor,
        authority,
        {
          kind: 'rollback-operation-requested',
          applyReceipt: receipt.applyReceipt,
          journalSegment,
        },
      )
    const expectedRunState =
      reduceWorkspaceSearchMigrationRunState({
        current: authorizedPredecessor,
        expectedRevision: predecessorState.revision,
        authority,
        event: expectedEvent,
      })
    const expectedRollbackReceiptDigest =
      createMigrationDigest(expectedEvent.receipt)
    const expectedSuccessorState = createPersistenceState({
      binding: createBindingFromStartRoot(startRoot),
      startRootDigest: startRoot.startRootDigest,
      currentAuthority: receipt.currentAuthority,
      runState: expectedRunState,
      predecessorKind: 'rollback-state',
      predecessorDigest: predecessorState.stateDigest,
      lastRollbackReceiptDigest:
        expectedRollbackReceiptDigest,
    })
    const expectedReceipt = createOperationReceipt({
      startRoot,
      predecessorState,
      successorState: expectedSuccessorState,
      currentAuthority: receipt.currentAuthority,
      commandIdentity: expectedCommand,
      applyReceipt: receipt.applyReceipt,
      journalSegment,
      rollbackReceipt: expectedEvent.receipt,
      committedAt: receipt.committedAt,
    })
    if (
      expectedRollbackReceiptDigest !==
        receipt.rollbackReceiptDigest ||
      !equalBytes(
        serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
          expectedSuccessorState,
        ),
        serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
          successorState,
        ),
      ) ||
      !equalBytes(
        serializeWorkspaceSearchMigrationRollbackOperationReceiptV2(
          expectedReceipt,
        ),
        serializeWorkspaceSearchMigrationRollbackOperationReceiptV2(
          receipt,
        ),
      )
    ) {
      return failRollbackPersistenceV2()
    }
  })
}

/**
 * Resolves and validates one exact external committed-prefix origin.
 *
 * @param input - Candidate origin material.
 * @returns Strict origin and represented applying predecessor.
 */
function resolveOrigin(
  input:
    CreateWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2Input,
): ResolvedOrigin {
  const record = strictGuards.requireRecord(input)
  strictGuards.requireExactKeys(record, [
    'admission',
    'predecessor',
    'seal',
    'sealReference',
    'sealedPlanningAuthority',
  ])
  const admission = requireAdmission(
    strictGuards.readOwn(record, 'admission'),
  )
  const predecessor = requirePredecessor(
    strictGuards.readOwn(record, 'predecessor'),
  )
  const sealedPlanningAuthority = requireSealedPlanningAuthority(
    strictGuards.readOwn(record, 'sealedPlanningAuthority'),
  )
  const seal = requireSeal(strictGuards.readOwn(record, 'seal'))
  const sealReference =
    readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
      strictGuards.readOwn(record, 'sealReference'),
    )
  const boundReference =
    requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding({
      admission,
      predecessor,
      sealedPlanningAuthority,
      seal,
      reference: sealReference,
    })
  const predecessorRunState =
    predecessor.kind === 'execution-run-admission'
      ? admission.runState
      : reconstructWorkspaceSearchMigrationRunState(
          admission,
          predecessor.executionState,
        )
  const predecessorIdentity =
    createPredecessorIdentity(admission, predecessor)
  const common = {
    kind:
      'workspace-search-migration-committed-prefix-rollback-origin',
    originVersion: rollbackOriginVersion,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: admission.runId,
    configurationHash: admission.configurationHash,
    executionRunDigest: admission.executionRunDigest,
    sealedPlanningAuthorityDigest:
      sealedPlanningAuthority.authorityDigest,
    planDigest: sealedPlanningAuthority.planDigest,
    planOperationCount:
      sealedPlanningAuthority.planOperationCount,
    planSealReference: readRichArtifactReference(
      admission.binding.planSealReference,
    ),
    minimumJournalRetainUntil:
      predecessor.kind === 'mutable-execution-state'
        ? predecessor.executionState.minimumJournalRetainUntil ?? null
        : null,
    predecessor: predecessorIdentity,
    seal,
    sealReference: boundReference,
  } satisfies Omit<
    WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
    'originDigest'
  >
  const origin = readOrigin({
    ...common,
    originDigest: createMigrationDigest(common),
  })
  encodeCanonical(
    origin,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_ORIGIN_V2_MAX_BYTES,
  )
  return {
    origin,
    predecessorRunState: readApplyingRunState(predecessorRunState),
  }
}

/**
 * Creates the immutable predecessor descriptor fixed by an origin.
 *
 * @param admission - Exact immutable execution admission.
 * @param predecessor - Explicit admission or mutable predecessor.
 * @returns Strict immutable predecessor identity.
 */
function createPredecessorIdentity(
  admission: WorkspaceSearchMigrationExecutionRun,
  predecessor:
    WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor,
): WorkspaceSearchMigrationRollbackPredecessorV2 {
  if (predecessor.kind === 'execution-run-admission') {
    return {
      kind: 'execution-run-admission',
      revision: 1,
      predecessorDigest: admission.executionRunDigest,
      predecessorRunStateDigest: admission.stateDigest,
    }
  }
  return {
    kind: 'mutable-execution-state',
    executionStateVersion:
      predecessor.executionState.executionStateVersion,
    revision: predecessor.executionState.revision,
    predecessorDigest:
      predecessor.executionState.executionStateDigest,
    predecessorRunStateDigest:
      predecessor.executionState.runStateDigest,
  }
}

/**
 * Creates the canonical initial v2 state for one fixed start-root digest.
 *
 * @param input - Exact immutable binding, authority, and pure run state.
 * @param startRootDigest - Provisional zero or final root digest.
 * @returns Strict self-digested initial persistence state.
 */
function createInitialState(
  input: {
    /** Operator-selected migration run. */
    readonly runId: string
    /** Reviewed measured-configuration digest. */
    readonly configurationHash: string
    /** All six immutable physical table incarnations. */
    readonly tableIds:
      WorkspaceSearchMigrationSealedPlanningTableIds
    /** Digest of the immutable execution admission. */
    readonly executionRunDigest: string
    /** Digest of the immutable planning authority. */
    readonly sealedPlanningAuthorityDigest: string
    /** Digest of the committed-prefix origin. */
    readonly originDigest: string
    /** Fresh compact authority binding. */
    readonly currentAuthority:
      WorkspaceSearchMigrationRollbackAuthorityBindingV2
    /** Complete initial rolling-back pure run state. */
    readonly runState: WorkspaceSearchMigrationRunState
  },
  startRootDigest: string,
): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
  const runState = readRollingBackRunState(input.runState)
  const rollback = runState.rollback
  if (rollback === undefined) return failRollbackPersistenceV2()
  const runStateDigest = createMigrationDigest(
    createRunStateDocument(runState),
  )
  const common = {
    kind: 'workspace-search-migration-rollback-state',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: input.runId,
    configurationHash: input.configurationHash,
    tableIds: input.tableIds,
    executionRunDigest: input.executionRunDigest,
    sealedPlanningAuthorityDigest:
      input.sealedPlanningAuthorityDigest,
    originDigest: input.originDigest,
    startRootDigest: strictGuards.readDigest(startRootDigest),
    currentAuthority: input.currentAuthority,
    status: 'rolling-back',
    revision: runState.revision,
    predecessorKind: 'committed-prefix-origin',
    predecessorDigest: input.originDigest,
    upperBoundSequence: rollback.upperBoundSequence,
    nextSequence: rollback.nextSequence,
    expectedHeadDigest: rollback.expectedHeadDigest,
    restored: 0,
    lastRollbackReceiptDigest: null,
    runState,
    runStateDigest,
  } satisfies RollbackStateV2Common
  const state = readStateRuntime({
    ...common,
    stateDigest: createMigrationDigest(
      createStateCommonDocument(common),
    ),
  })
  encodeCanonical(
    createStateDocument(state),
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_V2_MAX_BYTES,
  )
  return state
}

/**
 * Creates one strict v2 rollback persistence state from a pure state.
 *
 * @param input - Binding, pure state, predecessor, and last marker digest.
 * @returns Detached canonical v2 rollback persistence state.
 */
function createPersistenceState(
  input: CreatePersistenceStateV2Input,
): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
  const runState = readRollbackRunState(input.runState)
  const progress = runState.rollback
  if (progress === undefined) return failRollbackPersistenceV2()
  const common = {
    kind: 'workspace-search-migration-rollback-state',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: input.binding.runId,
    configurationHash: input.binding.configurationHash,
    tableIds: input.binding.tableIds,
    executionRunDigest: input.binding.executionRunDigest,
    sealedPlanningAuthorityDigest:
      input.binding.sealedPlanningAuthorityDigest,
    originDigest: input.binding.originDigest,
    startRootDigest: strictGuards.readDigest(
      input.startRootDigest,
    ),
    currentAuthority: readAuthorityBinding(
      input.currentAuthority,
    ),
    status: readRollbackStatus(runState.status),
    revision: runState.revision,
    predecessorKind: input.predecessorKind,
    predecessorDigest: strictGuards.readDigest(
      input.predecessorDigest,
    ),
    upperBoundSequence: progress.upperBoundSequence,
    nextSequence: progress.nextSequence,
    expectedHeadDigest: progress.expectedHeadDigest,
    restored: progress.restored,
    lastRollbackReceiptDigest: readNullableDigest(
      input.lastRollbackReceiptDigest,
    ),
    runState,
    runStateDigest: createMigrationDigest(
      createRunStateDocument(runState),
    ),
  } satisfies RollbackStateV2Common
  const state = readStateRuntime({
    ...common,
    stateDigest: createMigrationDigest(
      createStateCommonDocument(common),
    ),
  })
  encodeCanonical(
    createStateDocument(state),
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_V2_MAX_BYTES,
  )
  return state
}

/**
 * Requires current authority and causal time to permit rollback start.
 *
 * @param origin - Exact committed-prefix origin.
 * @param predecessor - Exact applying predecessor run state.
 * @param admission - Immutable execution admission owning the prefix.
 * @param authority - Fresh strongly resolved current authority.
 * @param startedAt - Adapter-owned transaction time.
 */
function requireStartAuthority(
  origin: WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  predecessor: WorkspaceSearchMigrationRunState,
  admission: WorkspaceSearchMigrationExecutionRun,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  startedAt: string,
): void {
  const predecessorFence =
    predecessor.maintenanceEvidenceReceipt.fenceToken
  const admittedAuthority = readAuthorityBinding(
    admission.binding.currentAuthority,
  )
  const currentAuthority = createAuthorityBinding(authority)
  requireAuthorityBindingSuccessor(
    admittedAuthority,
    currentAuthority,
  )
  if (
    authority.configurationHash !== origin.configurationHash ||
    authority.stateTableId !==
      admission.binding.tableIds['migration-state'] ||
    authority.stateTableId !==
      predecessor.configuration.tables['migration-state'].tableId ||
    authority.lease.runId !== origin.runId ||
    authority.lease.ownerId.length === 0 ||
    authority.lease.fenceToken <
      predecessorFence ||
    admittedAuthority.fenceToken !== predecessorFence ||
    admittedAuthority.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(
        predecessor.maintenanceEvidenceReceipt,
      ) ||
    authority.maintenanceEvidenceReceipt.fenceToken !==
      authority.lease.fenceToken ||
    createMigrationDigest(
      authority.maintenanceEvidenceReceipt,
    ) !== authority.maintenanceEvidenceReceiptDigest ||
    Date.parse(origin.seal.createdAt) <
      Date.parse(predecessor.updatedAt) ||
    Date.parse(origin.seal.createdAt) <
      Date.parse(authority.evaluatedAt) ||
    Date.parse(startedAt) < Date.parse(origin.seal.createdAt)
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Requires a current authority tuple to succeed an admitted tuple.
 *
 * @param predecessor - Authority fixed by immutable execution admission.
 * @param current - Fresh authority consumed by rollback start.
 */
function requireAuthorityBindingSuccessor(
  predecessor: WorkspaceSearchMigrationRollbackAuthorityBindingV2,
  current: WorkspaceSearchMigrationRollbackAuthorityBindingV2,
): void {
  if (
    Date.parse(current.evaluatedAt) <
      Date.parse(predecessor.evaluatedAt) ||
    current.fenceToken < predecessor.fenceToken ||
    current.maintenanceEvidencePointerRevision <
      predecessor.maintenanceEvidencePointerRevision ||
    (
      current.maintenanceEvidencePointerRevision ===
        predecessor.maintenanceEvidencePointerRevision &&
      current.maintenanceEvidenceReceiptDigest !==
        predecessor.maintenanceEvidenceReceiptDigest
    ) ||
    (
      current.maintenanceEvidencePointerRevision >
        predecessor.maintenanceEvidencePointerRevision &&
      current.maintenanceEvidenceReceiptDigest ===
        predecessor.maintenanceEvidenceReceiptDigest
    ) ||
    (
      current.fenceToken === predecessor.fenceToken &&
      current.ownerId !== predecessor.ownerId
    )
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Requires every immutable rollback dependency to survive the start window.
 *
 * @param origin - Exact committed-prefix origin and seal reference.
 * @param startedAt - Final adapter-owned transaction time.
 */
function requireStartRetention(
  origin: WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  startedAt: string,
): void {
  const minimumDeadline =
    Date.parse(startedAt) +
    WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  const minimumJournalRetainUntil =
    origin.minimumJournalRetainUntil
  if (
    !Number.isSafeInteger(minimumDeadline) ||
    Date.parse(origin.planSealReference.retainUntil) <=
      minimumDeadline ||
    Date.parse(origin.sealReference.retainUntil) <=
      minimumDeadline ||
    (
      origin.seal.journalSequence > 0 &&
      (
        minimumJournalRetainUntil === null ||
        Date.parse(minimumJournalRetainUntil) <= minimumDeadline
      )
    ) ||
    (
      origin.seal.journalSequence === 0 &&
      minimumJournalRetainUntil !== null
    )
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Atomically adopts the fresh maintenance receipt before pure rollback start.
 *
 * @param state - Exact applying durable predecessor.
 * @param authority - Fresh current authority.
 * @param adoptedAt - Seal creation time after authority evaluation.
 * @returns Applying predecessor carrying the current receipt.
 */
function createAuthorityAdoptedPredecessor(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  adoptedAt: string,
): WorkspaceSearchMigrationRunState {
  const adopted = {
    ...state,
    maintenanceEvidenceDigest:
      authority.maintenanceEvidenceReceipt.evidenceDigest,
    maintenanceEvidenceLocator:
      authority.maintenanceEvidenceReceipt.evidenceLocator,
    maintenanceEvidenceReceipt:
      authority.maintenanceEvidenceReceipt,
    updatedAt: adoptedAt,
  }
  return readApplyingRunState(adopted)
}

/**
 * Projects a rich prefix reference into the state-machine reference contract.
 *
 * @param reference - Exact rich immutable reference.
 * @returns Narrow reference accepted by the pure state machine.
 */
function createPureSealReference(
  reference:
    WorkspaceSearchMigrationCommittedPrefixApplySealReference,
): WorkspaceSearchApplySealReference {
  return {
    scope: 'committed-prefix',
    objectKey: reference.objectKey,
    versionId: reference.versionId,
    contentDigest: reference.contentDigest,
  }
}

/**
 * Creates one compact authority binding.
 *
 * @param authority - Fresh strict pre-plan authority.
 * @returns Detached compact authority tuple.
 */
function createAuthorityBinding(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationRollbackAuthorityBindingV2 {
  return readAuthorityBinding({
    ownerId: authority.lease.ownerId,
    fenceToken: authority.lease.fenceToken,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
    evaluatedAt: authority.evaluatedAt,
  })
}

/**
 * Reconstructs the immutable binding retained by one parsed v2 start root.
 *
 * @param startRoot - Exact strict committed-prefix start root.
 * @returns Detached common v2 rollback binding.
 */
function createBindingFromStartRoot(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
): RollbackBindingV2 {
  return {
    runId: startRoot.runId,
    configurationHash: startRoot.configurationHash,
    tableIds: readTableIds(startRoot.tableIds),
    executionRunDigest: startRoot.executionRunDigest,
    originDigest: startRoot.originDigest,
    sealedPlanningAuthorityDigest:
      startRoot.sealedPlanningAuthorityDigest,
  }
}

/**
 * Requires fresh authority to match one v2 run and immutable state table.
 *
 * @param binding - Exact common v2 rollback identity.
 * @param state - Exact pure run state being mutated.
 * @param predecessorAuthority - Authority adopted by the durable predecessor.
 * @param currentAuthority - Fresh strongly resolved authority.
 * @param committedAt - Adapter-owned transaction time.
 */
function requireAuthorityForRunState(
  binding: RollbackBindingV2,
  state: WorkspaceSearchMigrationRunState,
  predecessorAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBindingV2,
  currentAuthority: WorkspaceSearchMigrationPrePlanAuthority,
  committedAt: string,
): void {
  const currentBinding = createAuthorityBinding(currentAuthority)
  requireAuthorityBindingSuccessor(
    predecessorAuthority,
    currentBinding,
  )
  if (
    currentAuthority.configurationHash !== binding.configurationHash ||
    currentAuthority.stateTableId !==
      binding.tableIds['migration-state'] ||
    currentAuthority.lease.runId !== binding.runId ||
    currentAuthority.lease.ownerId.length === 0 ||
    predecessorAuthority.fenceToken !==
      state.maintenanceEvidenceReceipt.fenceToken ||
    predecessorAuthority.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(state.maintenanceEvidenceReceipt) ||
    createMigrationDigest(
      currentAuthority.maintenanceEvidenceReceipt,
    ) !== currentAuthority.maintenanceEvidenceReceiptDigest ||
    Date.parse(committedAt) < Date.parse(currentAuthority.evaluatedAt) ||
    Date.parse(committedAt) < Date.parse(state.updatedAt)
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Atomically adopts fresh maintenance evidence for one authorized mutation.
 *
 * @param state - Exact durable pure predecessor state.
 * @param authority - Fresh strongly resolved authority.
 * @param committedAt - Adapter-owned enclosing transaction time.
 * @returns Exact effective predecessor carrying current evidence.
 */
function createAuthorityAdoptedRunState(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  committedAt: string,
): WorkspaceSearchMigrationRunState {
  return createAuthorityAdoptedRunStateFromEvidence(
    state,
    createAuthorityBinding(authority),
    authority.maintenanceEvidenceReceipt,
    committedAt,
  )
}

/**
 * Reconstructs one evidence-adopted effective predecessor for pure replay.
 *
 * @param state - Exact durable pure predecessor state.
 * @param authority - Compact authority consumed by the mutation.
 * @param receipt - Full maintenance receipt selected by that authority.
 * @param committedAt - Adapter-owned enclosing transaction time.
 * @returns Exact validated effective predecessor.
 */
function createAuthorityAdoptedRunStateFromEvidence(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationRollbackAuthorityBindingV2,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  committedAt: string,
): WorkspaceSearchMigrationRunState {
  if (
    authority.fenceToken !== receipt.fenceToken ||
    authority.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(receipt) ||
    Date.parse(authority.evaluatedAt) > Date.parse(committedAt) ||
    Date.parse(state.updatedAt) > Date.parse(committedAt)
  ) {
    return failRollbackPersistenceV2()
  }
  return readRollbackRunState({
    ...state,
    maintenanceEvidenceDigest: receipt.evidenceDigest,
    maintenanceEvidenceLocator: receipt.evidenceLocator,
    maintenanceEvidenceReceipt: receipt,
    updatedAt: committedAt,
  })
}

/**
 * Creates the pure reducer authority from fresh durable authority.
 *
 * @param authority - Fresh exact current authority.
 * @param at - Adapter-owned transaction time.
 * @returns Exact pure transition authority.
 */
function createPureAuthority(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  at: string,
): WorkspaceSearchMigrationAuthority {
  return {
    lease: authority.lease,
    ownerId: authority.lease.ownerId,
    at,
  }
}

/**
 * Reconstructs pure authority facts retained by one v2 rollback receipt.
 *
 * @param predecessor - Exact rolling-back predecessor state.
 * @param receipt - Candidate durable reverse-operation receipt.
 * @returns Deterministic authority suitable for pure successor replay.
 */
function createReceiptValidationAuthority(
  predecessor:
    WorkspaceSearchMigrationRollbackPersistenceStateV2,
  receipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2,
): WorkspaceSearchMigrationAuthority {
  const committedMilliseconds = Date.parse(receipt.committedAt)
  const expiresMilliseconds =
    committedMilliseconds +
    WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS
  if (
    !Number.isSafeInteger(committedMilliseconds) ||
    !Number.isSafeInteger(expiresMilliseconds)
  ) {
    return failRollbackPersistenceV2()
  }
  const ownerId = receipt.currentAuthority.ownerId
  return {
    lease: {
      runId: predecessor.runId,
      ownerId,
      fenceToken: receipt.currentAuthority.fenceToken,
      heartbeatAt: receipt.committedAt,
      expiresAt: new Date(expiresMilliseconds).toISOString(),
    },
    ownerId,
    at: receipt.committedAt,
  }
}

/**
 * Reconstructs the effective predecessor used by an atomic v2 reverse step.
 *
 * @param predecessor - Exact durable state consumed by the transaction.
 * @param successor - Exact durable state stored by the transaction.
 * @param receipt - Immutable operation receipt retaining fresh authority.
 * @returns Pure predecessor with atomically adopted current evidence.
 */
function createReceiptValidationPredecessor(
  predecessor:
    WorkspaceSearchMigrationRollbackPersistenceStateV2,
  successor:
    WorkspaceSearchMigrationRollbackPersistenceStateV2,
  receipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2,
): WorkspaceSearchMigrationRunState {
  if (
    !sameAuthorityBinding(
      successor.currentAuthority,
      receipt.currentAuthority,
    )
  ) {
    return failRollbackPersistenceV2()
  }
  return createAuthorityAdoptedRunStateFromEvidence(
    predecessor.runState,
    receipt.currentAuthority,
    successor.runState.maintenanceEvidenceReceipt,
    receipt.committedAt,
  )
}

/**
 * Reads and validates one immutable committed-prefix origin.
 *
 * @param value - Candidate origin.
 * @returns Detached strict origin.
 */
function readOrigin(
  value: unknown,
): WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2 {
  requireSafeDataGraph(value)
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'configurationHash',
    'executionRunDigest',
    'kind',
    'migrationId',
    'migrationVersion',
    'minimumJournalRetainUntil',
    'originDigest',
    'originVersion',
    'planDigest',
    'planOperationCount',
    'planSealReference',
    'predecessor',
    'runId',
    'seal',
    'sealReference',
    'sealedPlanningAuthorityDigest',
  ])
  if (
    strictGuards.readOwn(record, 'kind') !==
      'workspace-search-migration-committed-prefix-rollback-origin' ||
    strictGuards.readOwn(record, 'originVersion') !==
      rollbackOriginVersion ||
    strictGuards.readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    strictGuards.readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistenceV2()
  }
  const seal = requireSeal(strictGuards.readOwn(record, 'seal'))
  const sealReference =
    readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
      strictGuards.readOwn(record, 'sealReference'),
    )
  const predecessor = readPredecessorIdentity(
    strictGuards.readOwn(record, 'predecessor'),
  )
  const minimumJournalRetainUntilValue = strictGuards.readOwn(
    record,
    'minimumJournalRetainUntil',
  )
  const minimumJournalRetainUntil =
    minimumJournalRetainUntilValue === null
      ? null
      : strictGuards.readTimestamp(minimumJournalRetainUntilValue)
  const common = {
    kind:
      'workspace-search-migration-committed-prefix-rollback-origin',
    originVersion: rollbackOriginVersion,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'runId'),
    ),
    configurationHash: strictGuards.readDigest(
      strictGuards.readOwn(record, 'configurationHash'),
    ),
    executionRunDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'executionRunDigest'),
    ),
    sealedPlanningAuthorityDigest: strictGuards.readDigest(
      strictGuards.readOwn(
        record,
        'sealedPlanningAuthorityDigest',
      ),
    ),
    planDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'planDigest'),
    ),
    planOperationCount: readNonNegativeSafeInteger(
      strictGuards.readOwn(record, 'planOperationCount'),
    ),
    planSealReference: readRichArtifactReference(
      strictGuards.readOwn(record, 'planSealReference'),
    ),
    minimumJournalRetainUntil,
    predecessor,
    seal,
    sealReference,
  } satisfies Omit<
    WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
    'originDigest'
  >
  const originDigest = strictGuards.readDigest(
    strictGuards.readOwn(record, 'originDigest'),
  )
  if (
    seal.scope !== 'committed-prefix' ||
    seal.runId !== common.runId ||
    seal.configurationHash !== common.configurationHash ||
    seal.planDigest !== common.planDigest ||
    seal.planOperationCount !== common.planOperationCount ||
    sealReference.contentDigest !== createMigrationDigest(seal) ||
    sealReference.byteLength !==
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        seal,
      ).byteLength ||
    Date.parse(common.planSealReference.retainUntil) <=
      Date.parse(seal.createdAt) +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS ||
    Date.parse(sealReference.retainUntil) <=
      Date.parse(seal.createdAt) +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS ||
    (
      predecessor.kind === 'execution-run-admission' &&
      (
        predecessor.predecessorDigest !==
          common.executionRunDigest ||
        seal.markerCount !== 0 ||
        seal.journalSequence !== 0 ||
        minimumJournalRetainUntil !== null
      )
    ) ||
    (
      predecessor.kind === 'mutable-execution-state' &&
      predecessor.revision < seal.markerCount + 1
    ) ||
    (
      seal.journalSequence === 0 &&
      minimumJournalRetainUntil !== null
    ) ||
    (
      seal.journalSequence > 0 &&
      (
        minimumJournalRetainUntil === null ||
        Date.parse(minimumJournalRetainUntil) <
          Date.parse(common.planSealReference.retainUntil) ||
        Date.parse(minimumJournalRetainUntil) <=
          Date.parse(seal.createdAt) +
            WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
      )
    ) ||
    originDigest !== createMigrationDigest(common)
  ) {
    return failRollbackPersistenceV2()
  }
  return { ...common, originDigest }
}

/**
 * Reads one exact immutable predecessor descriptor.
 *
 * @param value - Candidate predecessor identity.
 * @returns Detached strict predecessor identity.
 */
function readPredecessorIdentity(
  value: unknown,
): WorkspaceSearchMigrationRollbackPredecessorV2 {
  const record = strictGuards.requireRecord(value)
  const kind = strictGuards.readOwn(record, 'kind')
  if (kind === 'execution-run-admission') {
    strictGuards.requireExactKeys(record, [
      'kind',
      'predecessorDigest',
      'predecessorRunStateDigest',
      'revision',
    ])
    if (strictGuards.readOwn(record, 'revision') !== 1) {
      return failRollbackPersistenceV2()
    }
    return {
      kind,
      revision: 1,
      predecessorDigest: strictGuards.readDigest(
        strictGuards.readOwn(record, 'predecessorDigest'),
      ),
      predecessorRunStateDigest: strictGuards.readDigest(
        strictGuards.readOwn(
          record,
          'predecessorRunStateDigest',
        ),
      ),
    }
  }
  if (kind !== 'mutable-execution-state') {
    return failRollbackPersistenceV2()
  }
  strictGuards.requireExactKeys(record, [
    'executionStateVersion',
    'kind',
    'predecessorDigest',
    'predecessorRunStateDigest',
    'revision',
  ])
  const executionStateVersion = strictGuards.readOwn(
    record,
    'executionStateVersion',
  )
  if (
    executionStateVersion !== 1 &&
    executionStateVersion !== 2
  ) {
    return failRollbackPersistenceV2()
  }
  return {
    kind,
    executionStateVersion,
    revision: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'revision'),
    ),
    predecessorDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'predecessorDigest'),
    ),
    predecessorRunStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'predecessorRunStateDigest'),
    ),
  }
}

/**
 * Reads one runtime v2 rollback lifecycle state.
 *
 * @param value - Candidate runtime state.
 * @returns Detached strict v2 rollback state.
 */
function readStateRuntime(
  value: unknown,
): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
  return readState(value, readRuntimeRunState)
}

/**
 * Reads one canonical-document v2 rollback lifecycle state.
 *
 * @param value - Candidate JSON-safe state document.
 * @returns Detached strict v2 rollback state.
 */
function readStateDocument(
  value: unknown,
): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
  return readState(value, readRunStateDocument)
}

/**
 * Reads one state with a caller-selected runtime or document run-state codec.
 *
 * @param value - Candidate state.
 * @param readRunState - Exact run-state reader for the representation.
 * @returns Detached strict v2 rollback state.
 */
function readState(
  value: unknown,
  readRunState: (value: unknown) => WorkspaceSearchMigrationRunState,
): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
  requireSafeDataGraph(value)
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'configurationHash',
    'currentAuthority',
    'executionRunDigest',
    'expectedHeadDigest',
    'kind',
    'lastRollbackReceiptDigest',
    'migrationId',
    'migrationVersion',
    'nextSequence',
    'originDigest',
    'persistenceVersion',
    'predecessorDigest',
    'predecessorKind',
    'restored',
    'revision',
    'runId',
    'runState',
    'runStateDigest',
    'sealedPlanningAuthorityDigest',
    'startRootDigest',
    'stateDigest',
    'status',
    'tableIds',
    'upperBoundSequence',
  ])
  if (
    strictGuards.readOwn(record, 'kind') !==
      'workspace-search-migration-rollback-state' ||
    strictGuards.readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION ||
    strictGuards.readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    strictGuards.readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistenceV2()
  }
  const runState = readRunState(
    strictGuards.readOwn(record, 'runState'),
  )
  const common = {
    kind: 'workspace-search-migration-rollback-state',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'runId'),
    ),
    configurationHash: strictGuards.readDigest(
      strictGuards.readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(
      strictGuards.readOwn(record, 'tableIds'),
    ),
    executionRunDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'executionRunDigest'),
    ),
    sealedPlanningAuthorityDigest: strictGuards.readDigest(
      strictGuards.readOwn(
        record,
        'sealedPlanningAuthorityDigest',
      ),
    ),
    originDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'originDigest'),
    ),
    startRootDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'startRootDigest'),
    ),
    currentAuthority: readAuthorityBinding(
      strictGuards.readOwn(record, 'currentAuthority'),
    ),
    status: readRollbackStatus(
      strictGuards.readOwn(record, 'status'),
    ),
    revision: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'revision'),
    ),
    predecessorKind: readStatePredecessorKind(
      strictGuards.readOwn(record, 'predecessorKind'),
    ),
    predecessorDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'predecessorDigest'),
    ),
    upperBoundSequence: readNonNegativeSafeInteger(
      strictGuards.readOwn(record, 'upperBoundSequence'),
    ),
    nextSequence: readNonNegativeSafeInteger(
      strictGuards.readOwn(record, 'nextSequence'),
    ),
    expectedHeadDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'expectedHeadDigest'),
    ),
    restored: readNonNegativeSafeInteger(
      strictGuards.readOwn(record, 'restored'),
    ),
    lastRollbackReceiptDigest: readNullableDigest(
      strictGuards.readOwn(record, 'lastRollbackReceiptDigest'),
    ),
    runState,
    runStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'runStateDigest'),
    ),
  } satisfies RollbackStateV2Common
  const stateDigest = strictGuards.readDigest(
    strictGuards.readOwn(record, 'stateDigest'),
  )
  requirePersistenceStateInvariants(common)
  if (
    common.runStateDigest !==
      createMigrationDigest(createRunStateDocument(runState)) ||
    stateDigest !==
      createMigrationDigest(createStateCommonDocument(common))
  ) {
    return failRollbackPersistenceV2()
  }
  return { ...common, stateDigest }
}

/**
 * Requires flattened fields to match the complete pure rollback state.
 *
 * @param state - Candidate state without its self digest.
 */
function requirePersistenceStateInvariants(
  state: RollbackStateV2Common,
): void {
  const progress = state.runState.rollback
  if (
    progress === undefined ||
    state.runState.status !== state.status ||
    state.runState.runId !== state.runId ||
    state.runState.configurationHash !== state.configurationHash ||
    state.runState.revision !== state.revision ||
    state.currentAuthority.fenceToken !==
      state.runState.maintenanceEvidenceReceipt.fenceToken ||
    state.currentAuthority.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(
        state.runState.maintenanceEvidenceReceipt,
      ) ||
    Date.parse(state.currentAuthority.evaluatedAt) >
      Date.parse(state.runState.updatedAt) ||
    !sameTableIds(
      state.tableIds,
      createTableIdsFromRunState(state.runState),
    ) ||
    progress.upperBoundSequence !== state.upperBoundSequence ||
    progress.nextSequence !== state.nextSequence ||
    progress.expectedHeadDigest !== state.expectedHeadDigest ||
    progress.restored !== state.restored ||
    state.nextSequence > state.upperBoundSequence ||
    state.restored > state.upperBoundSequence ||
    state.nextSequence + state.restored !==
      state.upperBoundSequence ||
    (state.restored === 0) !==
      (state.lastRollbackReceiptDigest === null) ||
    (
      state.predecessorKind === 'committed-prefix-origin' &&
      (
        state.status !== 'rolling-back' ||
        state.restored !== 0 ||
        state.predecessorDigest !== state.originDigest
      )
    ) ||
    (
      state.status === 'rolled-back' &&
      (
        state.nextSequence !== 0 ||
        state.expectedHeadDigest !== zeroDigest
      )
    )
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Reads one runtime immutable rollback-start root.
 *
 * @param value - Candidate runtime root.
 * @returns Detached strict root.
 */
function readStartRootRuntime(
  value: unknown,
): WorkspaceSearchMigrationRollbackStartRootV2 {
  return readStartRoot(value, readStateRuntime)
}

/**
 * Reads one JSON-safe immutable rollback-start root document.
 *
 * @param value - Candidate root document.
 * @returns Detached strict root.
 */
function readStartRootDocument(
  value: unknown,
): WorkspaceSearchMigrationRollbackStartRootV2 {
  return readStartRoot(value, readStateDocument)
}

/**
 * Reads one root with a caller-selected initial-state representation.
 *
 * @param value - Candidate root.
 * @param readInitialState - Runtime or document initial-state reader.
 * @returns Detached strict root.
 */
function readStartRoot(
  value: unknown,
  readInitialState: (
    value: unknown,
  ) => WorkspaceSearchMigrationRollbackPersistenceStateV2,
): WorkspaceSearchMigrationRollbackStartRootV2 {
  requireSafeDataGraph(value)
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'configurationHash',
    'currentAuthority',
    'executionRunDigest',
    'initialRunStateDigest',
    'initialState',
    'initialStateDigest',
    'kind',
    'migrationId',
    'migrationVersion',
    'origin',
    'originDigest',
    'originalJournalHeadDigest',
    'originalJournalSequence',
    'persistenceVersion',
    'predecessorDigest',
    'predecessorRevision',
    'predecessorRunStateDigest',
    'runId',
    'sealedPlanningAuthorityDigest',
    'startedAt',
    'startRootDigest',
    'tableIds',
  ])
  if (
    strictGuards.readOwn(record, 'kind') !==
      'workspace-search-migration-rollback-start-root' ||
    strictGuards.readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION ||
    strictGuards.readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    strictGuards.readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistenceV2()
  }
  const origin = readOrigin(strictGuards.readOwn(record, 'origin'))
  const initialState = readInitialState(
    strictGuards.readOwn(record, 'initialState'),
  )
  const common = {
    kind: 'workspace-search-migration-rollback-start-root',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'runId'),
    ),
    configurationHash: strictGuards.readDigest(
      strictGuards.readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(
      strictGuards.readOwn(record, 'tableIds'),
    ),
    executionRunDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'executionRunDigest'),
    ),
    sealedPlanningAuthorityDigest: strictGuards.readDigest(
      strictGuards.readOwn(
        record,
        'sealedPlanningAuthorityDigest',
      ),
    ),
    origin,
    originDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'originDigest'),
    ),
    predecessorRevision: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'predecessorRevision'),
    ),
    predecessorDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'predecessorDigest'),
    ),
    predecessorRunStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'predecessorRunStateDigest'),
    ),
    originalJournalSequence: readNonNegativeSafeInteger(
      strictGuards.readOwn(record, 'originalJournalSequence'),
    ),
    originalJournalHeadDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'originalJournalHeadDigest'),
    ),
    currentAuthority: readAuthorityBinding(
      strictGuards.readOwn(record, 'currentAuthority'),
    ),
    startedAt: strictGuards.readTimestamp(
      strictGuards.readOwn(record, 'startedAt'),
    ),
    initialState,
    initialStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'initialStateDigest'),
    ),
    initialRunStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'initialRunStateDigest'),
    ),
  } satisfies RollbackStartRootV2Common
  const startRootDigest = strictGuards.readDigest(
    strictGuards.readOwn(record, 'startRootDigest'),
  )
  const initialRunState = initialState.runState
  const markerAggregateDigest =
    MigrationDigestAccumulator.fromState(
      initialRunState.applyMarkerDigestState,
    ).digest()
  requireStartRetention(origin, common.startedAt)
  if (
    common.runId !== origin.runId ||
    common.configurationHash !== origin.configurationHash ||
    common.executionRunDigest !== origin.executionRunDigest ||
    common.sealedPlanningAuthorityDigest !==
      origin.sealedPlanningAuthorityDigest ||
    common.originDigest !== origin.originDigest ||
    common.predecessorRevision !== origin.predecessor.revision ||
    common.predecessorDigest !==
      origin.predecessor.predecessorDigest ||
    common.predecessorRunStateDigest !==
      origin.predecessor.predecessorRunStateDigest ||
    common.originalJournalSequence !== origin.seal.journalSequence ||
    common.originalJournalHeadDigest !==
      origin.seal.journalHeadDigest ||
    !sameTableIds(common.tableIds, initialState.tableIds) ||
    initialState.executionRunDigest !== common.executionRunDigest ||
    initialState.sealedPlanningAuthorityDigest !==
      common.sealedPlanningAuthorityDigest ||
    initialState.originDigest !== common.originDigest ||
    initialState.startRootDigest !== startRootDigest ||
    initialState.status !== 'rolling-back' ||
    initialState.predecessorKind !== 'committed-prefix-origin' ||
    initialState.predecessorDigest !== common.originDigest ||
    initialState.revision !== common.predecessorRevision + 1 ||
    initialState.upperBoundSequence !==
      common.originalJournalSequence ||
    initialState.nextSequence !== common.originalJournalSequence ||
    initialState.expectedHeadDigest !==
      common.originalJournalHeadDigest ||
    initialState.restored !== 0 ||
    initialState.lastRollbackReceiptDigest !== null ||
    !sameAuthorityBinding(
      common.currentAuthority,
      initialState.currentAuthority,
    ) ||
    common.initialStateDigest !== initialState.stateDigest ||
    common.initialRunStateDigest !== initialState.runStateDigest ||
    initialRunState.planDigest !== origin.planDigest ||
    initialRunState.planOperationCount !==
      origin.planOperationCount ||
    initialRunState.planSealReference.objectKey !==
      origin.planSealReference.objectKey ||
    initialRunState.planSealReference.versionId !==
      origin.planSealReference.versionId ||
    initialRunState.planSealReference.contentDigest !==
      origin.planSealReference.contentDigest ||
    initialRunState.appliedOperationCount !==
      origin.seal.markerCount ||
    markerAggregateDigest !==
      origin.seal.applyMarkerAggregateDigest ||
    initialRunState.journalSequence !==
      origin.seal.journalSequence ||
    initialRunState.journalHeadDigest !==
      origin.seal.journalHeadDigest ||
    initialRunState.updatedAt !== common.startedAt ||
    Date.parse(common.currentAuthority.evaluatedAt) >
      Date.parse(origin.seal.createdAt) ||
    Date.parse(origin.seal.createdAt) >
      Date.parse(common.startedAt) ||
    initialRunState.applySeal?.scope !== 'committed-prefix' ||
    initialRunState.applySeal.objectKey !==
      origin.sealReference.objectKey ||
    initialRunState.applySeal.versionId !==
      origin.sealReference.versionId ||
    initialRunState.applySeal.contentDigest !==
      origin.sealReference.contentDigest ||
    startRootDigest !== createRollbackStartRootDigest(common)
  ) {
    return failRollbackPersistenceV2()
  }
  return { ...common, startRootDigest }
}

/**
 * Requires one mutable v2 state to belong to an immutable start root.
 *
 * @param startRoot - Exact immutable committed-prefix start root.
 * @param state - Candidate mutable v2 state.
 */
function requireStateBelongsToStart(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): void {
  requireAuthorityBindingSuccessor(
    startRoot.currentAuthority,
    state.currentAuthority,
  )
  const rollingRevision =
    startRoot.predecessorRevision + 1 + state.restored
  const expectedRevision = state.status === 'rolled-back'
    ? rollingRevision + 1
    : rollingRevision
  if (
    !Number.isSafeInteger(rollingRevision) ||
    !Number.isSafeInteger(expectedRevision) ||
    state.runId !== startRoot.runId ||
    state.configurationHash !== startRoot.configurationHash ||
    !sameTableIds(state.tableIds, startRoot.tableIds) ||
    state.executionRunDigest !== startRoot.executionRunDigest ||
    state.originDigest !== startRoot.originDigest ||
    state.sealedPlanningAuthorityDigest !==
      startRoot.sealedPlanningAuthorityDigest ||
    state.startRootDigest !== startRoot.startRootDigest ||
    state.upperBoundSequence !== startRoot.originalJournalSequence ||
    state.revision !== expectedRevision ||
    (
      state.status === 'rolling-back' &&
      state.restored === 0 &&
      state.stateDigest !== startRoot.initialState.stateDigest
    ) ||
    (
      (state.status !== 'rolling-back' || state.restored !== 0) &&
      state.predecessorKind !== 'rollback-state'
    )
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Requires one apply receipt to be the exact next v2 reverse sequence.
 *
 * @param state - Exact rolling-back predecessor state.
 * @param receipt - Candidate forward apply receipt.
 */
function requirePendingRollbackSequence(
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
  receipt: WorkspaceSearchOperationReceipt,
): void {
  if (
    state.status !== 'rolling-back' ||
    state.nextSequence < 1 ||
    receipt.runId !== state.runId ||
    receipt.configurationHash !== state.configurationHash ||
    receipt.sequence !== state.nextSequence ||
    receipt.journal.headDigest !== state.expectedHeadDigest
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Requires immutable forward evidence chronology, retention, and exact linkage.
 *
 * @param startRoot - Immutable root fixing rollback start and origin evidence.
 * @param applyReceipt - Exact forward apply receipt being reversed.
 * @param journalSegment - Exact preimage segment referenced by the receipt.
 * @param committedAt - Canonical reverse transaction time.
 */
function requireRollbackEvidence(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  applyReceipt: WorkspaceSearchOperationReceipt,
  journalSegment: WorkspaceSearchJournalSegment,
  committedAt: string,
): void {
  if (
    Date.parse(applyReceipt.committedAt) >
      Date.parse(startRoot.startedAt) ||
    Date.parse(journalSegment.createdAt) >
      Date.parse(applyReceipt.committedAt) ||
    Date.parse(committedAt) < Date.parse(startRoot.startedAt) ||
    Date.parse(committedAt) < Date.parse(applyReceipt.committedAt) ||
    Date.parse(applyReceipt.journal.retainUntil) <=
      Date.parse(committedAt) +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS ||
    (
      startRoot.origin.minimumJournalRetainUntil !== null &&
      Date.parse(startRoot.origin.minimumJournalRetainUntil) <=
        Date.parse(committedAt) +
          WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
    )
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Requires one durable v2 receipt to repeat the immutable root binding.
 *
 * @param startRoot - Exact immutable rollback-start root.
 * @param receipt - Candidate durable reverse-operation receipt.
 */
function requireReceiptBelongsToStart(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  receipt: WorkspaceSearchMigrationRollbackOperationReceiptV2,
): void {
  requireAuthorityBindingSuccessor(
    startRoot.currentAuthority,
    receipt.currentAuthority,
  )
  if (
    receipt.runId !== startRoot.runId ||
    receipt.configurationHash !== startRoot.configurationHash ||
    !sameTableIds(receipt.tableIds, startRoot.tableIds) ||
    receipt.executionRunDigest !== startRoot.executionRunDigest ||
    receipt.originDigest !== startRoot.originDigest ||
    receipt.sealedPlanningAuthorityDigest !==
      startRoot.sealedPlanningAuthorityDigest ||
    receipt.startRootDigest !== startRoot.startRootDigest
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Requires the final v2 receipt to close the exact zero-head predecessor.
 *
 * @param startRoot - Exact immutable committed-prefix start root.
 * @param predecessor - Exact zero-head rolling-back predecessor.
 * @param terminalReceipt - Final reverse receipt, or null for zero mutations.
 */
function requireFinishReceipt(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  predecessor:
    WorkspaceSearchMigrationRollbackPersistenceStateV2,
  terminalReceipt:
    WorkspaceSearchMigrationRollbackOperationReceiptV2 | null,
): void {
  if (
    predecessor.status !== 'rolling-back' ||
    predecessor.nextSequence !== 0 ||
    predecessor.expectedHeadDigest !== zeroDigest ||
    predecessor.restored !== predecessor.upperBoundSequence
  ) {
    return failRollbackPersistenceV2()
  }
  if (startRoot.originalJournalSequence === 0) {
    if (
      terminalReceipt !== null ||
      predecessor.lastRollbackReceiptDigest !== null
    ) {
      return failRollbackPersistenceV2()
    }
    return
  }
  if (terminalReceipt !== null) {
    requireReceiptBelongsToStart(startRoot, terminalReceipt)
  }
  if (
    terminalReceipt === null ||
    terminalReceipt.sequence !== 1 ||
    terminalReceipt.previousJournalHeadDigest !== zeroDigest ||
    Date.parse(terminalReceipt.committedAt) <
      Date.parse(startRoot.startedAt) ||
    Date.parse(terminalReceipt.applyReceipt.committedAt) >
      Date.parse(startRoot.startedAt) ||
    terminalReceipt.successorRevision !== predecessor.revision ||
    terminalReceipt.successorStateDigest !==
      predecessor.stateDigest ||
    terminalReceipt.rollbackReceiptDigest !==
      predecessor.lastRollbackReceiptDigest
  ) {
    return failRollbackPersistenceV2()
  }
}

/**
 * Creates one deterministic v2 command identity from validated values.
 *
 * @param startRoot - Exact immutable rollback-start root.
 * @param predecessorState - Exact rolling-back predecessor.
 * @param applyReceipt - Exact durable forward apply receipt.
 * @returns Detached strict deterministic command identity.
 */
function createCommandIdentity(
  startRoot: WorkspaceSearchMigrationRollbackStartRootV2,
  predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceStateV2,
  applyReceipt: WorkspaceSearchOperationReceipt,
): WorkspaceSearchMigrationRollbackOperationCommandIdentityV2 {
  const common = {
    kind: 'workspace-search-migration-rollback-operation-command',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: startRoot.runId,
    configurationHash: startRoot.configurationHash,
    tableIds: startRoot.tableIds,
    executionRunDigest: startRoot.executionRunDigest,
    originDigest: startRoot.originDigest,
    sealedPlanningAuthorityDigest:
      startRoot.sealedPlanningAuthorityDigest,
    startRootDigest: startRoot.startRootDigest,
    expectedRevision: predecessorState.revision,
    predecessorStateDigest: predecessorState.stateDigest,
    sequence: applyReceipt.sequence,
    operationId: applyReceipt.operationId,
    applyReceiptDigest: createMigrationDigest(applyReceipt),
    journalReferenceDigest:
      createMigrationDigest(applyReceipt.journal),
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackOperationCommandIdentityV2,
    'commandDigest'
  >
  const command = readCommandIdentity({
    ...common,
    commandDigest: createMigrationDigest(common),
  })
  encodeCanonical(
    command,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_V2_MAX_BYTES,
  )
  return command
}

/**
 * Reads and validates one deterministic v2 reverse command identity.
 *
 * @param value - Candidate command identity.
 * @returns Detached strict command identity.
 */
function readCommandIdentity(
  value: unknown,
): WorkspaceSearchMigrationRollbackOperationCommandIdentityV2 {
  requireSafeDataGraph(value)
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'applyReceiptDigest',
    'commandDigest',
    'configurationHash',
    'executionRunDigest',
    'expectedRevision',
    'journalReferenceDigest',
    'kind',
    'migrationId',
    'migrationVersion',
    'operationId',
    'originDigest',
    'persistenceVersion',
    'predecessorStateDigest',
    'runId',
    'sealedPlanningAuthorityDigest',
    'sequence',
    'startRootDigest',
    'tableIds',
  ])
  if (
    strictGuards.readOwn(record, 'kind') !==
      'workspace-search-migration-rollback-operation-command' ||
    strictGuards.readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION ||
    strictGuards.readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    strictGuards.readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistenceV2()
  }
  const common = {
    kind: 'workspace-search-migration-rollback-operation-command',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'runId'),
    ),
    configurationHash: strictGuards.readDigest(
      strictGuards.readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(
      strictGuards.readOwn(record, 'tableIds'),
    ),
    executionRunDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'executionRunDigest'),
    ),
    originDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'originDigest'),
    ),
    sealedPlanningAuthorityDigest: strictGuards.readDigest(
      strictGuards.readOwn(
        record,
        'sealedPlanningAuthorityDigest',
      ),
    ),
    startRootDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'startRootDigest'),
    ),
    expectedRevision: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'expectedRevision'),
    ),
    predecessorStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'predecessorStateDigest'),
    ),
    sequence: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'sequence'),
    ),
    operationId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'operationId'),
    ),
    applyReceiptDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'applyReceiptDigest'),
    ),
    journalReferenceDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'journalReferenceDigest'),
    ),
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackOperationCommandIdentityV2,
    'commandDigest'
  >
  const commandDigest = strictGuards.readDigest(
    strictGuards.readOwn(record, 'commandDigest'),
  )
  if (commandDigest !== createMigrationDigest(common)) {
    return failRollbackPersistenceV2()
  }
  return { ...common, commandDigest }
}

/**
 * Creates one immutable durable v2 reverse-operation receipt.
 *
 * @param input - Exact root, transition, authority, and immutable evidence.
 * @returns Detached strict durable reverse receipt.
 */
function createOperationReceipt(
  input: CreateOperationReceiptV2Input,
): WorkspaceSearchMigrationRollbackOperationReceiptV2 {
  const rollbackReceiptDigest =
    createMigrationDigest(input.rollbackReceipt)
  const common = {
    kind: 'workspace-search-migration-rollback-operation-receipt',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: input.startRoot.runId,
    configurationHash: input.startRoot.configurationHash,
    tableIds: input.startRoot.tableIds,
    executionRunDigest: input.startRoot.executionRunDigest,
    originDigest: input.startRoot.originDigest,
    sealedPlanningAuthorityDigest:
      input.startRoot.sealedPlanningAuthorityDigest,
    startRootDigest: input.startRoot.startRootDigest,
    currentAuthority: readAuthorityBinding(input.currentAuthority),
    sequence: input.applyReceipt.sequence,
    operationId: input.applyReceipt.operationId,
    commandDigest: input.commandIdentity.commandDigest,
    applyReceipt: input.applyReceipt,
    applyReceiptDigest: createMigrationDigest(input.applyReceipt),
    journalReferenceDigest:
      createMigrationDigest(input.applyReceipt.journal),
    previousJournalHeadDigest:
      input.journalSegment.previousHeadDigest,
    rollbackReceipt: input.rollbackReceipt,
    rollbackReceiptDigest,
    predecessorRevision: input.predecessorState.revision,
    predecessorStateDigest: input.predecessorState.stateDigest,
    successorRevision: input.successorState.revision,
    successorStateDigest: input.successorState.stateDigest,
    committedAt: input.committedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackOperationReceiptV2,
    'receiptDigest'
  >
  const receipt = readOperationReceipt({
    ...common,
    receiptDigest: createMigrationDigest(common),
  })
  encodeCanonical(
    receipt,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_V2_MAX_BYTES,
  )
  return receipt
}

/**
 * Reads and validates one immutable durable v2 reverse-operation receipt.
 *
 * @param value - Candidate durable receipt.
 * @returns Detached strict durable receipt.
 */
function readOperationReceipt(
  value: unknown,
): WorkspaceSearchMigrationRollbackOperationReceiptV2 {
  requireSafeDataGraph(value)
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'applyReceipt',
    'applyReceiptDigest',
    'commandDigest',
    'committedAt',
    'configurationHash',
    'currentAuthority',
    'executionRunDigest',
    'journalReferenceDigest',
    'kind',
    'migrationId',
    'migrationVersion',
    'operationId',
    'originDigest',
    'persistenceVersion',
    'predecessorRevision',
    'predecessorStateDigest',
    'previousJournalHeadDigest',
    'receiptDigest',
    'rollbackReceipt',
    'rollbackReceiptDigest',
    'runId',
    'sealedPlanningAuthorityDigest',
    'sequence',
    'startRootDigest',
    'successorRevision',
    'successorStateDigest',
    'tableIds',
  ])
  if (
    strictGuards.readOwn(record, 'kind') !==
      'workspace-search-migration-rollback-operation-receipt' ||
    strictGuards.readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION ||
    strictGuards.readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    strictGuards.readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistenceV2()
  }
  const applyReceipt = readApplyReceipt(
    strictGuards.readOwn(record, 'applyReceipt'),
  )
  const rollbackReceipt = readRollbackReceipt(
    strictGuards.readOwn(record, 'rollbackReceipt'),
  )
  const common = {
    kind: 'workspace-search-migration-rollback-operation-receipt',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'runId'),
    ),
    configurationHash: strictGuards.readDigest(
      strictGuards.readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(
      strictGuards.readOwn(record, 'tableIds'),
    ),
    executionRunDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'executionRunDigest'),
    ),
    originDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'originDigest'),
    ),
    sealedPlanningAuthorityDigest: strictGuards.readDigest(
      strictGuards.readOwn(
        record,
        'sealedPlanningAuthorityDigest',
      ),
    ),
    startRootDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'startRootDigest'),
    ),
    currentAuthority: readAuthorityBinding(
      strictGuards.readOwn(record, 'currentAuthority'),
    ),
    sequence: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'sequence'),
    ),
    operationId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'operationId'),
    ),
    commandDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'commandDigest'),
    ),
    applyReceipt,
    applyReceiptDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'applyReceiptDigest'),
    ),
    journalReferenceDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'journalReferenceDigest'),
    ),
    previousJournalHeadDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'previousJournalHeadDigest'),
    ),
    rollbackReceipt,
    rollbackReceiptDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'rollbackReceiptDigest'),
    ),
    predecessorRevision: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'predecessorRevision'),
    ),
    predecessorStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'predecessorStateDigest'),
    ),
    successorRevision: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'successorRevision'),
    ),
    successorStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'successorStateDigest'),
    ),
    committedAt: strictGuards.readTimestamp(
      strictGuards.readOwn(record, 'committedAt'),
    ),
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackOperationReceiptV2,
    'receiptDigest'
  >
  const receiptDigest = strictGuards.readDigest(
    strictGuards.readOwn(record, 'receiptDigest'),
  )
  if (
    common.runId !== applyReceipt.runId ||
    common.runId !== rollbackReceipt.runId ||
    common.configurationHash !== applyReceipt.configurationHash ||
    common.configurationHash !== rollbackReceipt.configurationHash ||
    common.sequence !== applyReceipt.sequence ||
    common.sequence !== rollbackReceipt.sequence ||
    common.operationId !== applyReceipt.operationId ||
    common.operationId !== rollbackReceipt.operationId ||
    common.applyReceiptDigest !==
      createMigrationDigest(applyReceipt) ||
    common.applyReceiptDigest !== rollbackReceipt.applyReceiptDigest ||
    common.journalReferenceDigest !==
      createMigrationDigest(applyReceipt.journal) ||
    createJournalHeadDigest({
      previousHeadDigest: common.previousJournalHeadDigest,
      sequence: applyReceipt.sequence,
      operationId: applyReceipt.operationId,
      contentDigest: applyReceipt.journal.contentDigest,
      versionId: applyReceipt.journal.versionId,
    }) !== applyReceipt.journal.headDigest ||
    rollbackReceipt.targetKeyDigest !==
      applyReceipt.targetKeyDigest ||
    rollbackReceipt.beforeDigest !== applyReceipt.beforeDigest ||
    rollbackReceipt.afterDigest !== applyReceipt.afterDigest ||
    rollbackReceipt.journalHeadDigest !==
      applyReceipt.journal.headDigest ||
    common.rollbackReceiptDigest !==
      createMigrationDigest(rollbackReceipt) ||
    common.currentAuthority.fenceToken !==
      rollbackReceipt.fenceToken ||
    common.currentAuthority.maintenanceEvidenceReceiptDigest !==
      rollbackReceipt.maintenanceEvidenceReceiptDigest ||
    Date.parse(common.currentAuthority.evaluatedAt) >
      Date.parse(common.committedAt) ||
    common.committedAt !== rollbackReceipt.rolledBackAt ||
    Date.parse(common.committedAt) <
      Date.parse(applyReceipt.committedAt) ||
    Date.parse(applyReceipt.journal.retainUntil) <=
      Date.parse(common.committedAt) +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS ||
    common.successorRevision !== common.predecessorRevision + 1 ||
    receiptDigest !== createMigrationDigest(common)
  ) {
    return failRollbackPersistenceV2()
  }
  return { ...common, receiptDigest }
}

/**
 * Reads one runtime immutable v2 rolled-back root.
 *
 * @param value - Candidate runtime terminal root.
 * @returns Detached strict terminal root.
 */
function readRolledBackRootRuntime(
  value: unknown,
): WorkspaceSearchMigrationRolledBackRootV2 {
  return readRolledBackRoot(value, readStateRuntime)
}

/**
 * Reads one canonical-document immutable v2 rolled-back root.
 *
 * @param value - Candidate JSON-safe terminal root.
 * @returns Detached strict terminal root.
 */
function readRolledBackRootDocument(
  value: unknown,
): WorkspaceSearchMigrationRolledBackRootV2 {
  return readRolledBackRoot(value, readStateDocument)
}

/**
 * Reads one v2 terminal root with a caller-selected state representation.
 *
 * @param value - Candidate terminal root.
 * @param readTerminalState - Runtime or document state reader.
 * @returns Detached strict immutable v2 rolled-back root.
 */
function readRolledBackRoot(
  value: unknown,
  readTerminalState: (
    value: unknown,
  ) => WorkspaceSearchMigrationRollbackPersistenceStateV2,
): WorkspaceSearchMigrationRolledBackRootV2 {
  requireSafeDataGraph(value)
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'configurationHash',
    'executionRunDigest',
    'finalAuthority',
    'finalRunStateDigest',
    'finishedAt',
    'kind',
    'migrationId',
    'migrationVersion',
    'originDigest',
    'persistenceVersion',
    'rootDigest',
    'rollbackStartedAt',
    'runId',
    'sealedPlanningAuthorityDigest',
    'startRootDigest',
    'tableIds',
    'terminalReceipt',
    'terminalReceiptDigest',
    'terminalState',
    'terminalStateDigest',
  ])
  if (
    strictGuards.readOwn(record, 'kind') !==
      'workspace-search-migration-rolled-back-root' ||
    strictGuards.readOwn(record, 'persistenceVersion') !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION ||
    strictGuards.readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    strictGuards.readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistenceV2()
  }
  const terminalReceiptValue = strictGuards.readOwn(
    record,
    'terminalReceipt',
  )
  const terminalReceipt = terminalReceiptValue === null
    ? null
    : readOperationReceipt(terminalReceiptValue)
  const common = {
    kind: 'workspace-search-migration-rolled-back-root',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'runId'),
    ),
    configurationHash: strictGuards.readDigest(
      strictGuards.readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(
      strictGuards.readOwn(record, 'tableIds'),
    ),
    executionRunDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'executionRunDigest'),
    ),
    originDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'originDigest'),
    ),
    sealedPlanningAuthorityDigest: strictGuards.readDigest(
      strictGuards.readOwn(
        record,
        'sealedPlanningAuthorityDigest',
      ),
    ),
    startRootDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'startRootDigest'),
    ),
    terminalState: readTerminalState(
      strictGuards.readOwn(record, 'terminalState'),
    ),
    terminalStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'terminalStateDigest'),
    ),
    terminalReceipt,
    terminalReceiptDigest: readNullableDigest(
      strictGuards.readOwn(record, 'terminalReceiptDigest'),
    ),
    finalRunStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'finalRunStateDigest'),
    ),
    finalAuthority: readAuthorityBinding(
      strictGuards.readOwn(record, 'finalAuthority'),
    ),
    rollbackStartedAt: strictGuards.readTimestamp(
      strictGuards.readOwn(record, 'rollbackStartedAt'),
    ),
    finishedAt: strictGuards.readTimestamp(
      strictGuards.readOwn(record, 'finishedAt'),
    ),
  } satisfies Omit<
    WorkspaceSearchMigrationRolledBackRootV2,
    'rootDigest'
  >
  const rootDigest = strictGuards.readDigest(
    strictGuards.readOwn(record, 'rootDigest'),
  )
  const terminal = common.terminalState
  if (terminalReceipt !== null) {
    requireAuthorityBindingSuccessor(
      terminalReceipt.currentAuthority,
      common.finalAuthority,
    )
  }
  if (
    terminal.runId !== common.runId ||
    terminal.configurationHash !== common.configurationHash ||
    !sameTableIds(terminal.tableIds, common.tableIds) ||
    terminal.executionRunDigest !== common.executionRunDigest ||
    terminal.originDigest !== common.originDigest ||
    terminal.sealedPlanningAuthorityDigest !==
      common.sealedPlanningAuthorityDigest ||
    terminal.startRootDigest !== common.startRootDigest ||
    terminal.status !== 'rolled-back' ||
    terminal.nextSequence !== 0 ||
    terminal.expectedHeadDigest !== zeroDigest ||
    terminal.restored !== terminal.upperBoundSequence ||
    terminal.runState.updatedAt !== common.finishedAt ||
    !sameAuthorityBinding(
      common.finalAuthority,
      terminal.currentAuthority,
    ) ||
    common.finalAuthority.fenceToken !==
      terminal.runState.maintenanceEvidenceReceipt.fenceToken ||
    common.finalAuthority.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(
        terminal.runState.maintenanceEvidenceReceipt,
      ) ||
    Date.parse(common.finishedAt) <
      Date.parse(common.rollbackStartedAt) ||
    Date.parse(common.finalAuthority.evaluatedAt) >
      Date.parse(common.finishedAt) ||
    common.terminalStateDigest !== terminal.stateDigest ||
    common.finalRunStateDigest !== terminal.runStateDigest ||
    (
      terminal.upperBoundSequence === 0 &&
      (
        common.terminalReceipt !== null ||
        common.terminalReceiptDigest !== null ||
        terminal.lastRollbackReceiptDigest !== null
      )
    ) ||
    (
      terminal.upperBoundSequence > 0 &&
      (
        common.terminalReceipt === null ||
        common.terminalReceiptDigest !==
          common.terminalReceipt.receiptDigest ||
        common.terminalReceipt.runId !== common.runId ||
        common.terminalReceipt.configurationHash !==
          common.configurationHash ||
        !sameTableIds(
          common.terminalReceipt.tableIds,
          common.tableIds,
        ) ||
        common.terminalReceipt.executionRunDigest !==
          common.executionRunDigest ||
        common.terminalReceipt.originDigest !==
          common.originDigest ||
        common.terminalReceipt.sealedPlanningAuthorityDigest !==
          common.sealedPlanningAuthorityDigest ||
        common.terminalReceipt.startRootDigest !==
          common.startRootDigest ||
        common.terminalReceipt.sequence !== 1 ||
        common.terminalReceipt.previousJournalHeadDigest !==
          zeroDigest ||
        common.terminalReceipt.successorStateDigest !==
          terminal.predecessorDigest ||
        common.terminalReceipt.rollbackReceiptDigest !==
          terminal.lastRollbackReceiptDigest ||
        Date.parse(common.terminalReceipt.committedAt) <
          Date.parse(common.rollbackStartedAt) ||
        Date.parse(
          common.terminalReceipt.applyReceipt.committedAt,
        ) > Date.parse(common.rollbackStartedAt) ||
        Date.parse(common.finishedAt) <
          Date.parse(common.terminalReceipt.committedAt) ||
        common.terminalReceipt.successorRevision !==
          terminal.revision - 1
      )
    ) ||
    rootDigest !== createMigrationDigest(
      createRolledBackRootCommonDocument(common),
    )
  ) {
    return failRollbackPersistenceV2()
  }
  return { ...common, rootDigest }
}

/**
 * Creates canonical JSON-safe fields preceding a v2 terminal root digest.
 *
 * @param root - Strict terminal-root fields without their self digest.
 * @returns Exact JSON-safe terminal-root document.
 */
function createRolledBackRootCommonDocument(
  root: Omit<
    WorkspaceSearchMigrationRolledBackRootV2,
    'rootDigest'
  >,
): object {
  return {
    kind: root.kind,
    persistenceVersion: root.persistenceVersion,
    migrationId: root.migrationId,
    migrationVersion: root.migrationVersion,
    runId: root.runId,
    configurationHash: root.configurationHash,
    tableIds: root.tableIds,
    executionRunDigest: root.executionRunDigest,
    originDigest: root.originDigest,
    sealedPlanningAuthorityDigest:
      root.sealedPlanningAuthorityDigest,
    startRootDigest: root.startRootDigest,
    terminalState: createStateDocument(root.terminalState),
    terminalStateDigest: root.terminalStateDigest,
    terminalReceipt: root.terminalReceipt,
    terminalReceiptDigest: root.terminalReceiptDigest,
    finalRunStateDigest: root.finalRunStateDigest,
    finalAuthority: root.finalAuthority,
    rollbackStartedAt: root.rollbackStartedAt,
    finishedAt: root.finishedAt,
  }
}

/**
 * Creates one complete canonical JSON-safe v2 terminal-root document.
 *
 * @param root - Strict immutable v2 terminal root.
 * @returns Exact JSON-safe terminal-root document.
 */
function createRolledBackRootDocument(
  root: WorkspaceSearchMigrationRolledBackRootV2,
): object {
  return {
    ...createRolledBackRootCommonDocument(root),
    rootDigest: root.rootDigest,
  }
}

/**
 * Encodes one strict immutable v2 terminal root.
 *
 * @param root - Strict runtime v2 terminal root.
 * @returns Exact bounded canonical bytes.
 */
function encodeRolledBackRoot(
  root: WorkspaceSearchMigrationRolledBackRootV2,
): Uint8Array {
  return encodeCanonical(
    createRolledBackRootDocument(root),
    WORKSPACE_SEARCH_MIGRATION_ROLLED_BACK_ROOT_V2_MAX_BYTES,
  )
}

/**
 * Creates the non-circular digest of one v2 rollback-start root.
 *
 * @param root - Candidate root without its own digest field.
 * @returns Digest covering every non-circular root and initial-state field.
 */
function createRollbackStartRootDigest(
  root: RollbackStartRootV2Common,
): string {
  const rootDocument = createStartRootCommonDocument(root)
  const initialRecord = strictGuards.requireRecord(
    strictGuards.readOwn(rootDocument, 'initialState'),
  )
  const initialCore: Record<string, unknown> = {}
  for (const key of Object.keys(initialRecord)) {
    if (key === 'startRootDigest' || key === 'stateDigest') continue
    Object.defineProperty(initialCore, key, {
      configurable: true,
      enumerable: true,
      value: strictGuards.readOwn(initialRecord, key),
      writable: true,
    })
  }
  return createMigrationDigest({
    ...rootDocument,
    initialState: initialCore,
    initialStateDigest: createMigrationDigest(initialCore),
  })
}

/**
 * Creates the canonical JSON-safe document for one complete root.
 *
 * @param root - Strict runtime root.
 * @returns Exact canonical root document.
 */
function createStartRootDocument(
  root: WorkspaceSearchMigrationRollbackStartRootV2,
): object {
  return {
    ...createStartRootCommonDocument(root),
    startRootDigest: root.startRootDigest,
  }
}

/**
 * Creates the canonical JSON-safe document for root fields before self digest.
 *
 * @param root - Strict root fields.
 * @returns Exact JSON-safe common root document.
 */
function createStartRootCommonDocument(
  root: RollbackStartRootV2Common,
): object {
  return {
    kind: root.kind,
    persistenceVersion: root.persistenceVersion,
    migrationId: root.migrationId,
    migrationVersion: root.migrationVersion,
    runId: root.runId,
    configurationHash: root.configurationHash,
    tableIds: root.tableIds,
    executionRunDigest: root.executionRunDigest,
    sealedPlanningAuthorityDigest:
      root.sealedPlanningAuthorityDigest,
    origin: root.origin,
    originDigest: root.originDigest,
    predecessorRevision: root.predecessorRevision,
    predecessorDigest: root.predecessorDigest,
    predecessorRunStateDigest:
      root.predecessorRunStateDigest,
    originalJournalSequence: root.originalJournalSequence,
    originalJournalHeadDigest:
      root.originalJournalHeadDigest,
    currentAuthority: root.currentAuthority,
    startedAt: root.startedAt,
    initialState: createStateDocument(root.initialState),
    initialStateDigest: root.initialStateDigest,
    initialRunStateDigest: root.initialRunStateDigest,
  }
}

/**
 * Encodes one strict start root.
 *
 * @param root - Strict runtime root.
 * @returns Exact bounded canonical bytes.
 */
function encodeStartRoot(
  root: WorkspaceSearchMigrationRollbackStartRootV2,
): Uint8Array {
  return encodeCanonical(
    createStartRootDocument(root),
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_START_ROOT_V2_MAX_BYTES,
  )
}

/**
 * Creates one canonical JSON-safe state document.
 *
 * @param state - Strict runtime state.
 * @returns Exact canonical document with encoded checkpoint cursors.
 */
function createStateDocument(
  state: WorkspaceSearchMigrationRollbackPersistenceStateV2,
): object {
  return {
    ...createStateCommonDocument(state),
    stateDigest: state.stateDigest,
  }
}

/**
 * Creates the canonical state fields preceding the self digest.
 *
 * @param state - Strict runtime state fields.
 * @returns Exact JSON-safe common state document.
 */
function createStateCommonDocument(
  state: RollbackStateV2Common,
): object {
  return {
    kind: state.kind,
    persistenceVersion: state.persistenceVersion,
    migrationId: state.migrationId,
    migrationVersion: state.migrationVersion,
    runId: state.runId,
    configurationHash: state.configurationHash,
    tableIds: state.tableIds,
    executionRunDigest: state.executionRunDigest,
    sealedPlanningAuthorityDigest:
      state.sealedPlanningAuthorityDigest,
    originDigest: state.originDigest,
    startRootDigest: state.startRootDigest,
    currentAuthority: state.currentAuthority,
    status: state.status,
    revision: state.revision,
    predecessorKind: state.predecessorKind,
    predecessorDigest: state.predecessorDigest,
    upperBoundSequence: state.upperBoundSequence,
    nextSequence: state.nextSequence,
    expectedHeadDigest: state.expectedHeadDigest,
    restored: state.restored,
    lastRollbackReceiptDigest:
      state.lastRollbackReceiptDigest,
    runState: createRunStateDocument(state.runState),
    runStateDigest: state.runStateDigest,
  }
}

/**
 * Creates one JSON-safe rollback-lifecycle run-state document.
 *
 * @param state - Strict runtime rolling-back or rolled-back state.
 * @returns Exact document with losslessly encoded traversal cursors.
 */
function createRunStateDocument(
  state: WorkspaceSearchMigrationRunState,
): object {
  const strict = readRollbackRunState(state)
  return {
    runId: strict.runId,
    revision: strict.revision,
    configurationHash: strict.configurationHash,
    configuration: strict.configuration,
    maintenanceEvidenceDigest: strict.maintenanceEvidenceDigest,
    maintenanceEvidenceLocator: strict.maintenanceEvidenceLocator,
    maintenanceEvidenceReceipt: strict.maintenanceEvidenceReceipt,
    dryRunEvidenceDigest: strict.dryRunEvidenceDigest,
    planDigest: strict.planDigest,
    planOperationCount: strict.planOperationCount,
    planSealReference: strict.planSealReference,
    status: strict.status,
    appliedOperationCount: strict.appliedOperationCount,
    applyMarkerDigestState: strict.applyMarkerDigestState,
    journalSequence: strict.journalSequence,
    journalHeadDigest: strict.journalHeadDigest,
    apply: encodeTraversal(strict.apply),
    applySeal: strict.applySeal,
    rollback: strict.rollback,
    createdAt: strict.createdAt,
    updatedAt: strict.updatedAt,
  }
}

/**
 * Reads one JSON-safe rollback-lifecycle run-state document.
 *
 * @param value - Candidate encoded run-state document.
 * @returns Detached runtime state with native DynamoDB cursors.
 */
function readRunStateDocument(
  value: unknown,
): WorkspaceSearchMigrationRunState {
  requireSafeDataGraph(value)
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'appliedOperationCount',
    'apply',
    'applyMarkerDigestState',
    'applySeal',
    'configuration',
    'configurationHash',
    'createdAt',
    'dryRunEvidenceDigest',
    'journalHeadDigest',
    'journalSequence',
    'maintenanceEvidenceDigest',
    'maintenanceEvidenceLocator',
    'maintenanceEvidenceReceipt',
    'planDigest',
    'planOperationCount',
    'planSealReference',
    'revision',
    'rollback',
    'runId',
    'status',
    'updatedAt',
  ])
  if (!isRunStateCandidate(value)) {
    return failRollbackPersistenceV2()
  }
  const state = {
    ...value,
    apply: decodeTraversal(
      strictGuards.readOwn(record, 'apply'),
    ),
  }
  return readRollbackRunState(state)
}

/**
 * Reads one runtime rollback-lifecycle run state.
 *
 * @param value - Candidate runtime run state.
 * @returns Strict rolling-back or rolled-back committed-prefix state.
 */
function readRuntimeRunState(
  value: unknown,
): WorkspaceSearchMigrationRunState {
  requireSafeDataGraph(value)
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'appliedOperationCount',
    'apply',
    'applyMarkerDigestState',
    'applySeal',
    'configuration',
    'configurationHash',
    'createdAt',
    'dryRunEvidenceDigest',
    'journalHeadDigest',
    'journalSequence',
    'maintenanceEvidenceDigest',
    'maintenanceEvidenceLocator',
    'maintenanceEvidenceReceipt',
    'planDigest',
    'planOperationCount',
    'planSealReference',
    'revision',
    'rollback',
    'runId',
    'status',
    'updatedAt',
  ])
  if (!isRunStateCandidate(value)) {
    return failRollbackPersistenceV2()
  }
  return readRollbackRunState(value)
}

/**
 * Reads and validates one applying predecessor run state.
 *
 * @param value - Candidate applying run state.
 * @returns Strict applying run state.
 */
function readApplyingRunState(
  value: unknown,
): WorkspaceSearchMigrationRunState {
  requireSafeDataGraph(value)
  if (!isRunStateCandidate(value)) {
    return failRollbackPersistenceV2()
  }
  validateWorkspaceSearchMigrationRunState(value)
  if (
    value.status !== 'applying' ||
    value.applySeal !== undefined ||
    value.rollback !== undefined
  ) {
    return failRollbackPersistenceV2()
  }
  return value
}

/**
 * Reads and validates one rolling-back committed-prefix run state.
 *
 * @param value - Candidate run state.
 * @returns Strict rolling-back state.
 */
function readRollingBackRunState(
  value: unknown,
): WorkspaceSearchMigrationRunState {
  requireSafeDataGraph(value)
  if (!isRunStateCandidate(value)) {
    return failRollbackPersistenceV2()
  }
  validateWorkspaceSearchMigrationRunState(value)
  if (
    value.status !== 'rolling-back' ||
    value.applySeal?.scope !== 'committed-prefix' ||
    value.rollback === undefined ||
    value.verification !== undefined ||
    value.verificationEvidenceReference !== undefined
  ) {
    return failRollbackPersistenceV2()
  }
  return value
}

/**
 * Reads and validates one rolling-back or rolled-back committed-prefix state.
 *
 * @param value - Candidate rollback-lifecycle run state.
 * @returns Strict committed-prefix rollback lifecycle state.
 */
function readRollbackRunState(
  value: unknown,
): WorkspaceSearchMigrationRunState {
  requireSafeDataGraph(value)
  if (!isRunStateCandidate(value)) {
    return failRollbackPersistenceV2()
  }
  validateWorkspaceSearchMigrationRunState(value)
  if (
    (
      value.status !== 'rolling-back' &&
      value.status !== 'rolled-back'
    ) ||
    value.applySeal?.scope !== 'committed-prefix' ||
    value.rollback === undefined ||
    value.verification !== undefined ||
    value.verificationEvidenceReference !== undefined
  ) {
    return failRollbackPersistenceV2()
  }
  return value
}

/**
 * Minimally narrows a safe record before the state-machine validator.
 *
 * @param value - Candidate run state.
 * @returns Whether the validator may inspect the ordinary record.
 */
function isRunStateCandidate(
  value: unknown,
): value is WorkspaceSearchMigrationRunState {
  return strictGuards.isRecord(value)
}

/**
 * Losslessly encodes complete source and target traversal.
 *
 * @param traversal - Runtime traversal with native DynamoDB cursors.
 * @returns JSON-safe tagged traversal.
 */
function encodeTraversal(
  traversal: WorkspaceSearchMigrationTraversalProgress,
): EncodedTraversal {
  return {
    sources: {
      'project-directory': encodeCheckpoint(
        traversal.sources['project-directory'],
      ),
      'work-items': encodeCheckpoint(
        traversal.sources['work-items'],
      ),
      collaboration: encodeCheckpoint(
        traversal.sources.collaboration,
      ),
      documents: encodeCheckpoint(
        traversal.sources.documents,
      ),
    },
    target: encodeCheckpoint(traversal.target),
  }
}

/**
 * Decodes complete source and target traversal.
 *
 * @param value - Candidate tagged traversal.
 * @returns Runtime traversal with native DynamoDB cursors.
 */
function decodeTraversal(
  value: unknown,
): WorkspaceSearchMigrationTraversalProgress {
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, ['sources', 'target'])
  const sources = strictGuards.requireRecord(
    strictGuards.readOwn(record, 'sources'),
  )
  strictGuards.requireExactKeys(
    sources,
    workspaceSearchMigrationSourceNames,
  )
  return {
    sources: {
      'project-directory': decodeCheckpoint(
        strictGuards.readOwn(sources, 'project-directory'),
      ),
      'work-items': decodeCheckpoint(
        strictGuards.readOwn(sources, 'work-items'),
      ),
      collaboration: decodeCheckpoint(
        strictGuards.readOwn(sources, 'collaboration'),
      ),
      documents: decodeCheckpoint(
        strictGuards.readOwn(sources, 'documents'),
      ),
    },
    target: decodeCheckpoint(
      strictGuards.readOwn(record, 'target'),
    ),
  }
}

/**
 * Losslessly encodes one runtime checkpoint.
 *
 * @param checkpoint - Strict checkpoint with an optional native cursor.
 * @returns JSON-safe tagged checkpoint.
 */
function encodeCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
): EncodedCheckpoint {
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  return checkpoint.cursor === undefined
    ? {
        completed: checkpoint.completed,
        aggregate: checkpoint.aggregate,
        keyDigestState: checkpoint.keyDigestState,
        contentDigestState: checkpoint.contentDigestState,
      }
    : {
        completed: checkpoint.completed,
        cursor: encodeUnknownAttributeMap(checkpoint.cursor),
        aggregate: checkpoint.aggregate,
        keyDigestState: checkpoint.keyDigestState,
        contentDigestState: checkpoint.contentDigestState,
      }
}

/**
 * Decodes one strict tagged checkpoint.
 *
 * @param value - Candidate JSON-safe checkpoint.
 * @returns Runtime checkpoint with an optional native cursor.
 */
function decodeCheckpoint(
  value: unknown,
): MigrationSourceCheckpoint {
  const record = strictGuards.requireRecord(value)
  const hasCursor = hasOwnDataProperty(record, 'cursor')
  strictGuards.requireExactKeys(
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
  const completed = strictGuards.readOwn(record, 'completed')
  const aggregate = strictGuards.readOwn(record, 'aggregate')
  const keyDigestState =
    strictGuards.readOwn(record, 'keyDigestState')
  const contentDigestState =
    strictGuards.readOwn(record, 'contentDigestState')
  if (
    typeof completed !== 'boolean' ||
    !isMigrationScanAggregate(aggregate) ||
    !isMigrationDigestState(keyDigestState) ||
    !isMigrationDigestState(contentDigestState)
  ) {
    return failRollbackPersistenceV2()
  }
  const checkpoint: MigrationSourceCheckpoint = hasCursor
    ? {
        completed,
        cursor: decodeAttributeMap(
          strictGuards.readOwn(record, 'cursor'),
        ),
        aggregate,
        keyDigestState,
        contentDigestState,
      }
    : {
        completed,
        aggregate,
        keyDigestState,
        contentDigestState,
      }
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  return checkpoint
}

/**
 * Minimally narrows one aggregate before checkpoint validation.
 *
 * @param value - Candidate scan aggregate.
 * @returns Whether the checkpoint validator may inspect it.
 */
function isMigrationScanAggregate(
  value: unknown,
): value is MigrationScanAggregate {
  return strictGuards.isRecord(value)
}

/**
 * Minimally narrows one digest state before checkpoint validation.
 *
 * @param value - Candidate digest state.
 * @returns Whether the checkpoint validator may inspect it.
 */
function isMigrationDigestState(
  value: unknown,
): value is MigrationDigestState {
  return strictGuards.isRecord(value)
}

/**
 * Reads one exact immutable forward apply receipt.
 *
 * @param value - Candidate apply receipt.
 * @returns Detached strict forward apply receipt.
 */
function readApplyReceipt(
  value: unknown,
): WorkspaceSearchOperationReceipt {
  requireSafeDataGraph(value)
  if (!isApplyReceiptCandidate(value)) {
    return failRollbackPersistenceV2()
  }
  let marker: ReturnType<
    typeof parseWorkspaceSearchMigrationOperationMarker
  >
  try {
    marker = parseWorkspaceSearchMigrationOperationMarker(
      serializeWorkspaceSearchMigrationOperationMarker(value),
    )
  } catch {
    return failRollbackPersistenceV2()
  }
  if (marker.kind !== 'workspace-search-operation-applied') {
    return failRollbackPersistenceV2()
  }
  return marker
}

/**
 * Minimally narrows one apply receipt for its strict marker codec.
 *
 * @param value - Candidate value already checked as a safe data graph.
 * @returns Whether the strict marker codec may inspect the candidate.
 */
function isApplyReceiptCandidate(
  value: unknown,
): value is WorkspaceSearchOperationReceipt {
  return strictGuards.isRecord(value)
}

/**
 * Reads one exact-version immutable journal segment.
 *
 * @param value - Candidate journal segment.
 * @returns Detached strict journal segment.
 */
function readJournalSegment(
  value: unknown,
): WorkspaceSearchJournalSegment {
  requireSafeDataGraph(value)
  if (!isJournalSegmentCandidate(value)) {
    return failRollbackPersistenceV2()
  }
  try {
    return parseWorkspaceSearchJournalSegment(
      serializeWorkspaceSearchJournalSegment(value),
    )
  } catch {
    return failRollbackPersistenceV2()
  }
}

/**
 * Minimally narrows one journal segment for its strict canonical codec.
 *
 * @param value - Candidate exact-version journal segment.
 * @returns Whether the strict journal codec may inspect the candidate.
 */
function isJournalSegmentCandidate(
  value: unknown,
): value is WorkspaceSearchJournalSegment {
  return strictGuards.isRecord(value)
}

/**
 * Reads one exact pure rollback marker.
 *
 * @param value - Candidate pure rollback receipt.
 * @returns Detached strict pure rollback receipt.
 */
function readRollbackReceipt(
  value: unknown,
): WorkspaceSearchRollbackReceipt {
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'afterDigest',
    'applyReceiptDigest',
    'beforeDigest',
    'configurationHash',
    'fenceToken',
    'journalHeadDigest',
    'kind',
    'maintenanceEvidenceReceiptDigest',
    'markerVersion',
    'operationId',
    'rolledBackAt',
    'runId',
    'sequence',
    'targetKeyDigest',
  ])
  if (
    strictGuards.readOwn(record, 'kind') !==
      'workspace-search-operation-rolled-back' ||
    strictGuards.readOwn(record, 'markerVersion') !== 1
  ) {
    return failRollbackPersistenceV2()
  }
  return {
    kind: 'workspace-search-operation-rolled-back',
    markerVersion: 1,
    runId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'runId'),
    ),
    configurationHash: strictGuards.readDigest(
      strictGuards.readOwn(record, 'configurationHash'),
    ),
    operationId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'operationId'),
    ),
    sequence: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'sequence'),
    ),
    applyReceiptDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'applyReceiptDigest'),
    ),
    targetKeyDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'targetKeyDigest'),
    ),
    beforeDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'beforeDigest'),
    ),
    afterDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'afterDigest'),
    ),
    journalHeadDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'journalHeadDigest'),
    ),
    fenceToken: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidenceReceiptDigest: strictGuards.readDigest(
      strictGuards.readOwn(
        record,
        'maintenanceEvidenceReceiptDigest',
      ),
    ),
    rolledBackAt: strictGuards.readTimestamp(
      strictGuards.readOwn(record, 'rolledBackAt'),
    ),
  }
}

/**
 * Reads one compact current-authority tuple.
 *
 * @param value - Candidate authority binding.
 * @returns Detached strict authority binding.
 */
function readAuthorityBinding(
  value: unknown,
): WorkspaceSearchMigrationRollbackAuthorityBindingV2 {
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'evaluatedAt',
    'fenceToken',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
    'ownerId',
  ])
  return {
    ownerId: strictGuards.readIdentifier(
      strictGuards.readOwn(record, 'ownerId'),
    ),
    fenceToken: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidencePointerRevision:
      readPositiveSafeInteger(
        strictGuards.readOwn(
          record,
          'maintenanceEvidencePointerRevision',
        ),
      ),
    maintenanceEvidenceReceiptDigest: strictGuards.readDigest(
      strictGuards.readOwn(
        record,
        'maintenanceEvidenceReceiptDigest',
      ),
    ),
    evaluatedAt: strictGuards.readTimestamp(
      strictGuards.readOwn(record, 'evaluatedAt'),
    ),
  }
}

/**
 * Reads one rich immutable exact-version artifact reference.
 *
 * @param value - Candidate retained immutable artifact reference.
 * @returns Detached strict rich reference.
 */
function readRichArtifactReference(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun['binding']['planSealReference'] {
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, [
    'byteLength',
    'contentDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const reference = {
    objectKey: strictGuards.readS3ObjectKey(
      strictGuards.readOwn(record, 'objectKey'),
    ),
    versionId: strictGuards.readVersionId(
      strictGuards.readOwn(record, 'versionId'),
    ),
    contentDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'contentDigest'),
    ),
    byteLength: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'byteLength'),
    ),
    retainUntil: strictGuards.readTimestamp(
      strictGuards.readOwn(record, 'retainUntil'),
    ),
  }
  if (
    reference.byteLength >
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES ||
    reference.objectKey !==
      `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/${planSealRole}/${reference.contentDigest}.artifact`
  ) {
    return failRollbackPersistenceV2()
  }
  return reference
}

/**
 * Reads all six exact physical table identifiers.
 *
 * @param value - Candidate role-indexed identifiers.
 * @returns Detached strict table identifiers.
 */
function readTableIds(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  const record = strictGuards.requireRecord(value)
  strictGuards.requireExactKeys(record, tableRoles)
  return {
    'project-directory': strictGuards.readText(
      strictGuards.readOwn(record, 'project-directory'),
    ),
    'work-items': strictGuards.readText(
      strictGuards.readOwn(record, 'work-items'),
    ),
    collaboration: strictGuards.readText(
      strictGuards.readOwn(record, 'collaboration'),
    ),
    documents: strictGuards.readText(
      strictGuards.readOwn(record, 'documents'),
    ),
    'workspace-search': strictGuards.readText(
      strictGuards.readOwn(record, 'workspace-search'),
    ),
    'migration-state': strictGuards.readText(
      strictGuards.readOwn(record, 'migration-state'),
    ),
  }
}

/**
 * Projects table identifiers from one validated pure run state.
 *
 * @param state - Exact pure run state.
 * @returns Role-indexed physical table identifiers.
 */
function createTableIdsFromRunState(
  state: WorkspaceSearchMigrationRunState,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory':
      state.configuration.tables['project-directory'].tableId,
    'work-items':
      state.configuration.tables['work-items'].tableId,
    collaboration:
      state.configuration.tables.collaboration.tableId,
    documents: state.configuration.tables.documents.tableId,
    'workspace-search':
      state.configuration.tables['workspace-search'].tableId,
    'migration-state':
      state.configuration.tables['migration-state'].tableId,
  }
}

/**
 * Compares two role-indexed table identity maps.
 *
 * @param left - First exact table map.
 * @param right - Second exact table map.
 * @returns Whether every physical table identifier matches.
 */
function sameTableIds(
  left: WorkspaceSearchMigrationSealedPlanningTableIds,
  right: WorkspaceSearchMigrationSealedPlanningTableIds,
): boolean {
  return tableRoles.every((role) => left[role] === right[role])
}

/**
 * Compares two compact current-authority bindings.
 *
 * @param left - First compact authority.
 * @param right - Second compact authority.
 * @returns Whether every authority component is identical.
 */
function sameAuthorityBinding(
  left: WorkspaceSearchMigrationRollbackAuthorityBindingV2,
  right: WorkspaceSearchMigrationRollbackAuthorityBindingV2,
): boolean {
  return left.ownerId === right.ownerId &&
    left.fenceToken === right.fenceToken &&
    left.maintenanceEvidencePointerRevision ===
      right.maintenanceEvidencePointerRevision &&
    left.maintenanceEvidenceReceiptDigest ===
      right.maintenanceEvidenceReceiptDigest &&
    left.evaluatedAt === right.evaluatedAt
}

/**
 * Strictly detaches one immutable execution admission.
 *
 * @param value - Candidate execution admission.
 * @returns Detached strict admission.
 */
function requireAdmission(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  if (!isExecutionRun(value)) {
    return failRollbackPersistenceV2()
  }
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(value),
  )
}

/**
 * Strictly detaches one committed-prefix predecessor.
 *
 * @param value - Candidate predecessor union.
 * @returns Detached strict predecessor.
 */
function requirePredecessor(
  value: unknown,
): WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor {
  const record = strictGuards.requireRecord(value)
  const kind = strictGuards.readOwn(record, 'kind')
  if (kind === 'execution-run-admission') {
    strictGuards.requireExactKeys(record, ['kind'])
    return { kind }
  }
  if (kind !== 'mutable-execution-state') {
    return failRollbackPersistenceV2()
  }
  strictGuards.requireExactKeys(record, ['executionState', 'kind'])
  const stateValue = strictGuards.readOwn(record, 'executionState')
  if (!isExecutionState(stateValue)) {
    return failRollbackPersistenceV2()
  }
  return {
    kind,
    executionState: parseWorkspaceSearchMigrationExecutionState(
      serializeWorkspaceSearchMigrationExecutionState(stateValue),
    ),
  }
}

/**
 * Strictly detaches one version-two sealed planning authority.
 *
 * @param value - Candidate sealed planning authority.
 * @returns Detached strict planning authority.
 */
function requireSealedPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (!isSealedPlanningAuthority(value)) {
    return failRollbackPersistenceV2()
  }
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
      value,
    ),
  )
}

/**
 * Strictly detaches one pure committed-prefix seal.
 *
 * @param value - Candidate pure seal.
 * @returns Detached strict committed-prefix seal.
 */
function requireSeal(value: unknown): WorkspaceSearchApplySeal {
  if (!isCommittedPrefixApplySeal(value)) {
    return failRollbackPersistenceV2()
  }
  return parseWorkspaceSearchMigrationCommittedPrefixApplySeal(
    serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
      value,
    ),
  )
}

/**
 * Minimally narrows fresh authority before its strict shared detacher.
 *
 * @param value - Candidate fresh authority.
 * @returns Candidate typed for the strict detacher.
 */
function requireCurrentAuthority(
  value: unknown,
): WorkspaceSearchMigrationPrePlanAuthority {
  if (!isCurrentAuthority(value)) {
    return failRollbackPersistenceV2()
  }
  return value
}

/**
 * Minimally narrows an execution admission before its strict codec.
 *
 * @param value - Candidate execution admission.
 * @returns Whether the strict execution-run codec may inspect it.
 */
function isExecutionRun(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  return strictGuards.isRecord(value)
}

/**
 * Minimally narrows a mutable state before its strict codec.
 *
 * @param value - Candidate mutable execution state.
 * @returns Whether the strict execution-state codec may inspect it.
 */
function isExecutionState(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionState {
  return strictGuards.isRecord(value)
}

/**
 * Minimally narrows a planning authority before its strict codec.
 *
 * @param value - Candidate version-two planning authority.
 * @returns Whether the strict planning-authority codec may inspect it.
 */
function isSealedPlanningAuthority(
  value: unknown,
): value is WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return strictGuards.isRecord(value)
}

/**
 * Minimally narrows a committed-prefix seal before its strict codec.
 *
 * @param value - Candidate pure committed-prefix seal.
 * @returns Whether the strict seal codec may inspect it.
 */
function isCommittedPrefixApplySeal(
  value: unknown,
): value is WorkspaceSearchApplySeal {
  return strictGuards.isRecord(value)
}

/**
 * Minimally narrows current authority before its strict detacher.
 *
 * @param value - Candidate current authority.
 * @returns Whether the shared authority detacher may inspect it.
 */
function isCurrentAuthority(
  value: unknown,
): value is WorkspaceSearchMigrationPrePlanAuthority {
  return strictGuards.isRecord(value)
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @returns Exact positive safe integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failRollbackPersistenceV2()
  }
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate integer.
 * @returns Exact nonnegative safe integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failRollbackPersistenceV2()
  }
  return value
}

/**
 * Reads one supported v2 rollback lifecycle status.
 *
 * @param value - Candidate status.
 * @returns Strict rollback lifecycle status.
 */
function readRollbackStatus(
  value: unknown,
): WorkspaceSearchMigrationRollbackPersistenceStateV2['status'] {
  if (value !== 'rolling-back' && value !== 'rolled-back') {
    return failRollbackPersistenceV2()
  }
  return value
}

/**
 * Reads one supported v2 rollback-state predecessor kind.
 *
 * @param value - Candidate predecessor kind.
 * @returns Strict predecessor kind.
 */
function readStatePredecessorKind(
  value: unknown,
): WorkspaceSearchMigrationRollbackPersistenceStateV2['predecessorKind'] {
  if (
    value !== 'committed-prefix-origin' &&
    value !== 'rollback-state'
  ) {
    return failRollbackPersistenceV2()
  }
  return value
}

/**
 * Reads one digest or explicit absence.
 *
 * @param value - Candidate digest or null.
 * @returns Strict lowercase digest or null.
 */
function readNullableDigest(value: unknown): string | null {
  return value === null
    ? null
    : strictGuards.readDigest(value)
}

/**
 * Checks whether an enumerable own data property exists.
 *
 * @param value - Candidate object.
 * @param key - Property name to inspect.
 * @returns Whether the exact data property exists.
 */
function hasOwnDataProperty(value: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined &&
    descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value')
}

/**
 * Encodes one strict JSON-safe document within a finite byte bound.
 *
 * @param value - Strict JSON-compatible document.
 * @param maximumBytes - Maximum accepted canonical byte length.
 * @returns Exact canonical UTF-8 bytes.
 */
function encodeCanonical(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  requireSafeDataGraph(value)
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(value),
  )
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > maximumBytes
  ) {
    return failRollbackPersistenceV2()
  }
  return bytes
}

/**
 * Parses, validates, and re-encodes one exact canonical document.
 *
 * @param bytes - Candidate canonical bytes.
 * @param maximumBytes - Maximum accepted byte length.
 * @param reader - Strict value reader.
 * @param encoder - Canonical encoder for the strict value.
 * @returns Detached strict value.
 */
function parseCanonical<Result>(
  bytes: Uint8Array,
  maximumBytes: number,
  reader: (value: unknown) => Result,
  encoder: (value: Result) => Uint8Array,
): Result {
  return atRollbackPersistenceV2Boundary(() => {
    const snapshot = copyBoundedBytes(bytes, maximumBytes)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        snapshot,
      )
    } catch {
      return failRollbackPersistenceV2()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failRollbackPersistenceV2()
    }
    const value = reader(parsed)
    if (!equalBytes(snapshot, encoder(value))) {
      return failRollbackPersistenceV2()
    }
    return value
  })
}

/**
 * Copies one bounded non-shared byte array.
 *
 * @param value - Candidate byte array.
 * @param maximumBytes - Maximum accepted byte length.
 * @returns Detached exact bytes.
 */
function copyBoundedBytes(
  value: unknown,
  maximumBytes: number,
): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failRollbackPersistenceV2()
  }
  const buffer = strictGuards.readIntrinsicBuffer(value)
  const byteLength = strictGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength < 1 ||
    byteLength > maximumBytes
  ) {
    return failRollbackPersistenceV2()
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failRollbackPersistenceV2()
  }
  return copy
}

/**
 * Compares two exact byte arrays.
 *
 * @param left - First byte array.
 * @param right - Second byte array.
 * @returns Whether every byte is identical.
 */
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/**
 * Requires a bounded acyclic graph of own data properties.
 *
 * @param value - Candidate public input graph.
 */
function requireSafeDataGraph(value: unknown): void {
  inspectSafeDataGraph(
    value,
    {
      nodes: 0,
      binaryBytes: 0,
      textBytes: 0,
      active: new WeakSet<object>(),
      visited: new WeakSet<object>(),
    },
    0,
  )
}

/**
 * Recursively rejects proxies, accessors, cycles, and exotic objects.
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
    return failRollbackPersistenceV2()
  }
  chargeSafeGraphBudget(budget, 1)
  if (
    value === null ||
    typeof value === 'boolean'
  ) {
    return
  }
  if (typeof value === 'string') {
    chargeSafeGraphText(budget, value)
    return
  }
  if (value === undefined) {
    return failRollbackPersistenceV2()
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      return failRollbackPersistenceV2()
    }
    return
  }
  if (
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    budget.active.has(value) ||
    budget.visited.has(value)
  ) {
    return failRollbackPersistenceV2()
  }
  if (isSupportedBinaryValue(value)) {
    if (
      nodeUtilTypes.isSharedArrayBuffer(
        strictGuards.readIntrinsicBuffer(value),
      )
    ) {
      return failRollbackPersistenceV2()
    }
    const byteLength =
      strictGuards.readIntrinsicByteLength(value)
    chargeSafeGraphBinary(budget, byteLength)
    requireExactTypedArrayKeys(value, byteLength)
    budget.visited.add(value)
    return
  }
  budget.active.add(value)
  if (Array.isArray(value)) {
    if (
      !hasCanonicalDenseArrayShape(value) ||
      value.length > maximumSafeGraphArrayLength
    ) {
      return failRollbackPersistenceV2()
    }
    chargeSafeGraphBudget(budget, value.length)
    for (const child of value) {
      inspectSafeDataGraph(child, budget, depth + 1)
    }
  } else {
    const record = requireSafePlainRecord(value)
    const keys = Reflect.ownKeys(record)
    if (keys.length > maximumSafeGraphObjectProperties) {
      return failRollbackPersistenceV2()
    }
    chargeSafeGraphBudget(budget, keys.length)
    for (const key of keys) {
      if (typeof key !== 'string') {
        return failRollbackPersistenceV2()
      }
      chargeSafeGraphText(budget, key)
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return failRollbackPersistenceV2()
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
 * Requires one non-Proxy ordinary or null-prototype record.
 *
 * @param value - Candidate graph node.
 * @returns Strict plain record.
 */
function requireSafePlainRecord(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (!isSafePlainRecord(value)) {
    return failRollbackPersistenceV2()
  }
  return value
}

/**
 * Checks whether one graph node is an ordinary non-Proxy record.
 *
 * @param value - Candidate graph node.
 * @returns Whether the value is safe to inspect as a record.
 */
function isSafePlainRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value) ||
    Array.isArray(value)
  ) {
    return false
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Charges one bounded amount against the shared graph traversal budget.
 *
 * @param budget - Shared traversal budget.
 * @param amount - Non-negative nodes or own entries encountered.
 */
function chargeSafeGraphBudget(
  budget: SafeGraphBudget,
  amount: number,
): void {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    budget.nodes > maximumSafeGraphNodes - amount
  ) {
    return failRollbackPersistenceV2()
  }
  budget.nodes += amount
}

/**
 * Charges one binary value against the shared aggregate byte budget.
 *
 * @param budget - Shared traversal budget.
 * @param byteLength - Positive trusted binary byte length.
 */
function chargeSafeGraphBinary(
  budget: SafeGraphBudget,
  byteLength: number,
): void {
  if (
    !Number.isSafeInteger(byteLength) ||
    byteLength < 1 ||
    byteLength > WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES ||
    budget.binaryBytes >
      WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES - byteLength
  ) {
    return failRollbackPersistenceV2()
  }
  budget.binaryBytes += byteLength
}

/**
 * Charges one bounded canonical string against the shared UTF-8 budget.
 *
 * @param budget - Shared traversal budget.
 * @param value - String value or own property key.
 */
function chargeSafeGraphText(
  budget: SafeGraphBudget,
  value: string,
): void {
  if (
    value.length > maximumSafeGraphTextBytes ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failRollbackPersistenceV2()
  }
  const byteLength = Buffer.byteLength(value, 'utf8')
  if (
    byteLength > maximumSafeGraphTextBytes ||
    budget.textBytes > maximumSafeGraphTextBytes - byteLength
  ) {
    return failRollbackPersistenceV2()
  }
  budget.textBytes += byteLength
}

/**
 * Narrows one binary graph node to a trusted Uint8Array or Buffer.
 *
 * @param value - Candidate graph node.
 * @returns Whether the value has a trusted binary prototype.
 */
function isSupportedBinaryValue(
  value: unknown,
): value is Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !(value instanceof Uint8Array)
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
 * Rejects custom own properties on one trusted binary value.
 *
 * @param value - Candidate trusted binary value.
 * @param byteLength - Intrinsic byte length read without own accessors.
 */
function requireExactTypedArrayKeys(
  value: Uint8Array,
  byteLength: number,
): void {
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key === 'symbol') ||
    keys.length !== byteLength
  ) {
    return failRollbackPersistenceV2()
  }
  for (let index = 0; index < byteLength; index += 1) {
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
      return failRollbackPersistenceV2()
    }
  }
}

/**
 * Runs one public synchronous operation behind the stable v2 boundary.
 *
 * @param operation - Exact synchronous operation.
 * @returns Successful result.
 */
function atRollbackPersistenceV2Boundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationRollbackPersistenceV2Error()
  }
}

/**
 * Raises the stable v2 rollback persistence failure.
 *
 * @returns Never returns.
 */
function failRollbackPersistenceV2(): never {
  throw new WorkspaceSearchMigrationRollbackPersistenceV2Error()
}
