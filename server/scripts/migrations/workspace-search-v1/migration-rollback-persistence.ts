import { Buffer } from 'node:buffer'
import { types as nodeUtilTypes } from 'node:util'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchApplySealReference,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationTableRole,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchRollbackReceipt,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationAppliedRoot,
  type WorkspaceSearchMigrationAppliedRoot,
} from './migration-apply-seal'
import {
  detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary,
} from './migration-execution-boundary'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  parseWorkspaceSearchMigrationOperationMarker,
  serializeWorkspaceSearchMigrationOperationMarker,
} from './migration-execution-state'
import {
  parseWorkspaceSearchJournalSegment,
  serializeWorkspaceSearchJournalSegment,
  WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES,
} from './migration-journal'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createWorkspaceSearchRollbackOperationRecordedEvent,
  reduceWorkspaceSearchMigrationRunState,
  validateWorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationAuthority,
  WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/** Schema version shared by every complete-applied-root rollback record. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION = 1

/** Maximum canonical bytes accepted for one resumable rollback state. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_MAX_BYTES =
  192 * 1024

/** Maximum canonical bytes accepted for one immutable rollback start root. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_START_ROOT_MAX_BYTES =
  320 * 1024

/** Maximum canonical bytes accepted for one immutable rollback receipt. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_MAX_BYTES =
  128 * 1024

/** Maximum canonical bytes accepted for one immutable rolled-back root. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLED_BACK_ROOT_MAX_BYTES =
  320 * 1024

const maximumTextLength = 1_024
const maximumSafeGraphArrayLength = 4_096
const maximumSafeGraphDepth = 64
const maximumSafeGraphNodes = 100_000
const maximumSafeGraphObjectProperties = 1_024
const maximumSafeGraphTextBytes =
  WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES
const tableRoles: readonly WorkspaceSearchMigrationTableRole[] = [
  ...workspaceSearchMigrationSourceNames,
  'workspace-search',
  'migration-state',
]

/**
 * Stable raw-value-free failure for an invalid rollback persistence value.
 */
export class WorkspaceSearchMigrationRollbackPersistenceError
  extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code = 'INVALID_ROLLBACK_PERSISTENCE'

  /** Creates one stable rollback persistence failure. */
  constructor() {
    super('INVALID_ROLLBACK_PERSISTENCE')
    this.name = 'WorkspaceSearchMigrationRollbackPersistenceError'
  }
}

/**
 * Exact current authority consumed by one rollback transaction.
 */
export type WorkspaceSearchMigrationRollbackAuthorityBinding = {
  /** Lease owner condition-checked by the transaction. */
  readonly ownerId: string
  /** Lease takeover fence condition-checked by the transaction. */
  readonly fenceToken: number
  /** Current maintenance-evidence pointer revision. */
  readonly maintenanceEvidencePointerRevision: number
  /** Digest of the exact current immutable maintenance receipt. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Adapter-owned time at which authority was strongly evaluated. */
  readonly evaluatedAt: string
}

/**
 * Physical table incarnations fixed for one rollback chain.
 */
export type WorkspaceSearchMigrationRollbackTableIds = Readonly<
  Record<WorkspaceSearchMigrationTableRole, string>
>

/**
 * Identifies the exact predecessor consumed by a rollback state.
 */
export type WorkspaceSearchMigrationRollbackStatePredecessorKind =
  | 'applied-root'
  | 'rollback-state'

/**
 * Mutable resumable rollback state with a complete validated pure state.
 */
export type WorkspaceSearchMigrationRollbackPersistenceState = {
  /** Rollback-state discriminator. */
  readonly kind: 'workspace-search-migration-rollback-state'
  /** Rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationRollbackTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable complete applied root. */
  readonly appliedRootDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the exact immutable rollback-start root. */
  readonly startRootDigest: string
  /** Fresh authority atomically adopted by this durable state. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBinding
  /** Rolling-back or terminal rolled-back lifecycle status. */
  readonly status: 'rolling-back' | 'rolled-back'
  /** Exact optimistic-concurrency revision of the pure run state. */
  readonly revision: number
  /** Kind of predecessor consumed by this state transition. */
  readonly predecessorKind:
    WorkspaceSearchMigrationRollbackStatePredecessorKind
  /** Exact applied-root or predecessor-state digest. */
  readonly predecessorDigest: string
  /** Final forward journal sequence fixed when rollback began. */
  readonly upperBoundSequence: number
  /** Next reverse sequence, or zero at the journal root. */
  readonly nextSequence: number
  /** Journal head expected by the next reverse operation. */
  readonly expectedHeadDigest: string
  /** Exact count of reverse operations already restored. */
  readonly restored: number
  /**
   * Digest of the last pure rollback marker, or null before any restore.
   *
   * This intentionally does not use the enclosing durable receipt self
   * digest, which would create a cycle with the successor state digest.
   */
  readonly lastRollbackReceiptDigest: string | null
  /** Complete validated pure run state needed for restart. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Digest of the complete pure run state. */
  readonly runStateDigest: string
  /** Digest of every preceding rollback-state field. */
  readonly stateDigest: string
}

/**
 * Immutable root that atomically starts rollback from one complete apply.
 */
export type WorkspaceSearchMigrationRollbackStartRoot = {
  /** Rollback-start root discriminator. */
  readonly kind: 'workspace-search-migration-rollback-start-root'
  /** Rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationRollbackTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable complete applied root. */
  readonly appliedRootDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Exact applied predecessor revision consumed by rollback start. */
  readonly predecessorRevision: number
  /** Digest of the exact applied predecessor pure state. */
  readonly predecessorRunStateDigest: string
  /** Final forward journal sequence captured at rollback start. */
  readonly originalJournalSequence: number
  /** Final forward journal head captured at rollback start. */
  readonly originalJournalHeadDigest: string
  /** Fresh authority atomically consumed by rollback start. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBinding
  /** Canonical adapter-owned rollback-start transaction time. */
  readonly startedAt: string
  /** Complete initial rolling-back persistence state. */
  readonly initialState:
    WorkspaceSearchMigrationRollbackPersistenceState
  /** Digest of the complete initial rolling-back state. */
  readonly initialStateDigest: string
  /** Digest of the exact initial rolling-back pure run state. */
  readonly initialRunStateDigest: string
  /** Digest of every non-circular immutable start-root field. */
  readonly startRootDigest: string
}

/**
 * Deterministic identity of one exact reverse journal operation.
 */
export type WorkspaceSearchMigrationRollbackOperationCommandIdentity = {
  /** Rollback-command discriminator. */
  readonly kind: 'workspace-search-migration-rollback-operation-command'
  /** Rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationRollbackTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable complete applied root. */
  readonly appliedRootDigest: string
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
 * Immutable durable receipt for one exact reverse target restoration.
 */
export type WorkspaceSearchMigrationRollbackOperationReceipt = {
  /** Durable rollback-receipt discriminator. */
  readonly kind: 'workspace-search-migration-rollback-operation-receipt'
  /** Rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationRollbackTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable complete applied root. */
  readonly appliedRootDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the immutable rollback-start root. */
  readonly startRootDigest: string
  /** Fresh authority atomically consumed by this reverse operation. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBinding
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
 * Immutable terminal root proving that rollback reached the zero journal head.
 */
export type WorkspaceSearchMigrationRolledBackRoot = {
  /** Rolled-back root discriminator. */
  readonly kind: 'workspace-search-migration-rolled-back-root'
  /** Rollback persistence schema version. */
  readonly persistenceVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationRollbackTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable complete applied root. */
  readonly appliedRootDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the immutable rollback-start root. */
  readonly startRootDigest: string
  /** Complete terminal rolled-back persistence state. */
  readonly terminalState:
    WorkspaceSearchMigrationRollbackPersistenceState
  /** Digest of the exact terminal rolled-back state. */
  readonly terminalStateDigest: string
  /** Final reverse-operation receipt, or null for a zero-mutation apply. */
  readonly terminalReceipt:
    WorkspaceSearchMigrationRollbackOperationReceipt | null
  /** Digest of the final reverse-operation receipt, or null when absent. */
  readonly terminalReceiptDigest: string | null
  /** Digest of the exact terminal rolled-back pure run state. */
  readonly finalRunStateDigest: string
  /** Fresh authority atomically consumed by terminal publication. */
  readonly finalAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBinding
  /** Canonical rollback-start time fixed by the immutable start root. */
  readonly rollbackStartedAt: string
  /** Canonical adapter-owned terminal transaction time. */
  readonly finishedAt: string
  /** Digest of every preceding immutable terminal-root field. */
  readonly rootDigest: string
}

/**
 * Exact material required to start complete-applied-root rollback.
 */
export type CreateWorkspaceSearchMigrationRollbackStartRootInput = {
  /** Immutable revision-one execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Immutable complete applied phase root. */
  readonly appliedRoot: WorkspaceSearchMigrationAppliedRoot
  /** Immutable version-two sealed planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact applied pure state represented by the applied root. */
  readonly predecessorRunState: WorkspaceSearchMigrationRunState
  /** Fresh current authority consumed by the start transaction. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned canonical rollback-start time. */
  readonly startedAt: string
}

/**
 * Exact material required to derive one deterministic reverse command.
 */
export type CreateWorkspaceSearchMigrationRollbackOperationCommandIdentityInput = {
  /** Immutable rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRoot
  /** Exact current rolling-back predecessor state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceState
  /** Exact durable forward operation receipt at the reverse cursor. */
  readonly applyReceipt: WorkspaceSearchOperationReceipt
}

/**
 * Exact material required to create one reverse operation transition.
 */
export type CreateWorkspaceSearchMigrationRollbackOperationTransitionInput = {
  /** Immutable rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRoot
  /** Exact current rolling-back predecessor state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceState
  /** Fresh current authority consumed by the reverse transaction. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Exact durable forward operation receipt at the reverse cursor. */
  readonly applyReceipt: WorkspaceSearchOperationReceipt
  /** Exact-version journal segment referenced by the forward receipt. */
  readonly journalSegment: WorkspaceSearchJournalSegment
  /** Adapter-owned canonical reverse transaction time. */
  readonly committedAt: string
}

/**
 * Complete pure and durable result of one reverse operation reduction.
 */
export type WorkspaceSearchMigrationRollbackOperationTransition = {
  /** Deterministic identity of the exact reverse command. */
  readonly commandIdentity:
    WorkspaceSearchMigrationRollbackOperationCommandIdentity
  /** Immutable durable reverse-operation receipt. */
  readonly receipt: WorkspaceSearchMigrationRollbackOperationReceipt
  /** Complete pure successor run state. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Complete resumable successor rollback state. */
  readonly state: WorkspaceSearchMigrationRollbackPersistenceState
}

/**
 * Exact material required to finish rollback at the zero journal root.
 */
export type FinishWorkspaceSearchMigrationRollbackInput = {
  /** Immutable rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRoot
  /** Exact zero-head rolling-back predecessor state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceState
  /** Fresh current authority consumed by terminal publication. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Final reverse receipt, or null for a zero-mutation apply. */
  readonly terminalReceipt:
    WorkspaceSearchMigrationRollbackOperationReceipt | null
  /** Adapter-owned canonical terminal transaction time. */
  readonly finishedAt: string
}

/**
 * Complete pure and durable terminal rollback result.
 */
export type WorkspaceSearchMigrationRollbackFinishedTransition = {
  /** Immutable authoritative rolled-back root. */
  readonly root: WorkspaceSearchMigrationRolledBackRoot
  /** Complete terminal pure run state. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Complete terminal rolled-back persistence state. */
  readonly state: WorkspaceSearchMigrationRollbackPersistenceState
}

/**
 * Pure state-machine seal material reconstructed from a production root.
 */
export type WorkspaceSearchMigrationRollbackPureSealBinding = {
  /** Legacy complete-plan seal consumed by the pure rollback reducer. */
  readonly seal: WorkspaceSearchApplySeal
  /** Exact legacy seal reference consumed by the pure rollback reducer. */
  readonly reference: WorkspaceSearchApplySealReference
}

/**
 * Reconstructs the pure complete-plan rollback seal from an applied root.
 *
 * The production object identity is retained while the returned content digest
 * covers the legacy pure projection consumed by the existing reducer.
 *
 * @param appliedRoot - Candidate strict production complete applied root.
 * @returns Detached legacy seal and reference for the pure reducer.
 */
export function createWorkspaceSearchMigrationRollbackPureSealBinding(
  appliedRoot: WorkspaceSearchMigrationAppliedRoot,
): WorkspaceSearchMigrationRollbackPureSealBinding {
  return atRollbackPersistenceBoundary(() => {
    const root = readAppliedRoot(appliedRoot)
    return {
      seal: createLegacyCompleteApplySeal(root),
      reference: createLegacyCompleteApplySealReference(root),
    }
  })
}

/**
 * Creates an immutable start root and its initial rolling-back state.
 *
 * @param input - Exact complete applied root, state, authority, and bindings.
 * @returns Detached immutable rollback-start root.
 */
export function createWorkspaceSearchMigrationRollbackStartRoot(
  input: CreateWorkspaceSearchMigrationRollbackStartRootInput,
): WorkspaceSearchMigrationRollbackStartRoot {
  return atRollbackPersistenceBoundary(() => {
    const inputRecord = requireExactRecord(input, [
      'appliedRoot',
      'currentAuthority',
      'executionRun',
      'predecessorRunState',
      'sealedPlanningAuthority',
      'startedAt',
    ])
    const executionRun = readExecutionRun(
      readOwn(inputRecord, 'executionRun'),
    )
    const appliedRoot = readAppliedRoot(
      readOwn(inputRecord, 'appliedRoot'),
    )
    const sealedPlanningAuthority = readSealedPlanningAuthority(
      readOwn(inputRecord, 'sealedPlanningAuthority'),
    )
    const predecessorRunState = readAppliedRunState(
      readOwn(inputRecord, 'predecessorRunState'),
    )
    const currentAuthority = readCurrentAuthority(
      readOwn(inputRecord, 'currentAuthority'),
    )
    const startedAt = readTimestamp(readOwn(inputRecord, 'startedAt'))
    const binding = createBinding(
      executionRun,
      appliedRoot,
      sealedPlanningAuthority,
    )
    requireAppliedStartBindings(
      binding,
      executionRun,
      appliedRoot,
      sealedPlanningAuthority,
      predecessorRunState,
    )
    requireAuthorityBindingSuccessor(
      appliedRoot.authority,
      createAuthorityBinding(currentAuthority),
    )
    if (
      Date.parse(startedAt) < Date.parse(appliedRoot.committedAt) ||
      (
        appliedRoot.seal.journalSequence > 0 &&
        (
          appliedRoot.minimumJournalRetainUntil === undefined ||
          Date.parse(appliedRoot.minimumJournalRetainUntil) <=
            Date.parse(startedAt) +
              WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
        )
      )
    ) {
      return failRollbackPersistence()
    }
    requireAuthorityForRunState(
      binding,
      predecessorRunState,
      appliedRoot.authority,
      currentAuthority,
      startedAt,
    )
    const authority = createPureAuthority(currentAuthority, startedAt)
    const authorizedPredecessor = createAuthorityAdoptedRunState(
      predecessorRunState,
      currentAuthority,
      startedAt,
    )
    const pureSealBinding = {
      seal: createLegacyCompleteApplySeal(appliedRoot),
      reference:
        createLegacyCompleteApplySealReference(appliedRoot),
    }
    const purePredecessor: WorkspaceSearchMigrationRunState = {
      ...authorizedPredecessor,
      applySeal: pureSealBinding.reference,
    }
    const initialRunState = reduceWorkspaceSearchMigrationRunState({
      current: purePredecessor,
      expectedRevision: predecessorRunState.revision,
      authority,
      event: {
        kind: 'rollback-started',
        seal: pureSealBinding.seal,
        reference: pureSealBinding.reference,
      },
    })
    const provisionalInitialState = createPersistenceState({
      binding,
      startRootDigest: zeroDigest(),
      currentAuthority: createAuthorityBinding(currentAuthority),
      runState: initialRunState,
      predecessorKind: 'applied-root',
      predecessorDigest: appliedRoot.rootDigest,
      lastRollbackReceiptDigest: null,
    })
    const provisionalCommon = {
      kind: 'workspace-search-migration-rollback-start-root',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: binding.runId,
      configurationHash: binding.configurationHash,
      tableIds: binding.tableIds,
      executionRunDigest: binding.executionRunDigest,
      appliedRootDigest: binding.appliedRootDigest,
      sealedPlanningAuthorityDigest:
        binding.sealedPlanningAuthorityDigest,
      predecessorRevision: predecessorRunState.revision,
      predecessorRunStateDigest:
        createMigrationDigest(predecessorRunState),
      originalJournalSequence: appliedRoot.seal.journalSequence,
      originalJournalHeadDigest:
        appliedRoot.seal.journalHeadDigest,
      currentAuthority: createAuthorityBinding(currentAuthority),
      startedAt,
      initialState: provisionalInitialState,
      initialStateDigest: provisionalInitialState.stateDigest,
      initialRunStateDigest: provisionalInitialState.runStateDigest,
    } satisfies Omit<
      WorkspaceSearchMigrationRollbackStartRoot,
      'startRootDigest'
    >
    const startRootDigest = createStartRootDigest(provisionalCommon)
    const initialState = createPersistenceState({
      binding,
      startRootDigest,
      currentAuthority: createAuthorityBinding(currentAuthority),
      runState: initialRunState,
      predecessorKind: 'applied-root',
      predecessorDigest: appliedRoot.rootDigest,
      lastRollbackReceiptDigest: null,
    })
    const common = {
      ...provisionalCommon,
      initialState,
      initialStateDigest: initialState.stateDigest,
      initialRunStateDigest: initialState.runStateDigest,
    }
    const startRoot = readStartRoot({
      ...common,
      startRootDigest,
    })
    encodeValue(
      startRoot,
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_START_ROOT_MAX_BYTES,
    )
    return startRoot
  })
}

/**
 * Creates the deterministic identity of one exact reverse operation.
 *
 * @param input - Start root, predecessor state, and forward receipt.
 * @returns Detached deterministic reverse-command identity.
 */
export function createWorkspaceSearchMigrationRollbackOperationCommandIdentity(
  input:
    CreateWorkspaceSearchMigrationRollbackOperationCommandIdentityInput,
): WorkspaceSearchMigrationRollbackOperationCommandIdentity {
  return atRollbackPersistenceBoundary(() => {
    const inputRecord = requireExactRecord(input, [
      'applyReceipt',
      'predecessorState',
      'startRoot',
    ])
    const startRoot = readStartRoot(readOwn(inputRecord, 'startRoot'))
    const predecessorState = readPersistenceState(
      readOwn(inputRecord, 'predecessorState'),
    )
    const applyReceipt = readApplyReceipt(
      readOwn(inputRecord, 'applyReceipt'),
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
 * Reduces and binds one exact reverse operation without storing raw preimages.
 *
 * @param input - Start root, predecessor, authority, receipt, and journal bytes.
 * @returns Exact pure successor, durable state, command, and receipt.
 */
export function createWorkspaceSearchMigrationRollbackOperationTransition(
  input: CreateWorkspaceSearchMigrationRollbackOperationTransitionInput,
): WorkspaceSearchMigrationRollbackOperationTransition {
  return atRollbackPersistenceBoundary(() => {
    const inputRecord = requireExactRecord(input, [
      'applyReceipt',
      'committedAt',
      'currentAuthority',
      'journalSegment',
      'predecessorState',
      'startRoot',
    ])
    const startRoot = readStartRoot(readOwn(inputRecord, 'startRoot'))
    const predecessorState = readPersistenceState(
      readOwn(inputRecord, 'predecessorState'),
    )
    const currentAuthority = readCurrentAuthority(
      readOwn(inputRecord, 'currentAuthority'),
    )
    const applyReceipt = readApplyReceipt(
      readOwn(inputRecord, 'applyReceipt'),
    )
    const journalSegment = readJournalSegment(
      readOwn(inputRecord, 'journalSegment'),
    )
    const committedAt = readTimestamp(
      readOwn(inputRecord, 'committedAt'),
    )
    requireStateBelongsToStart(startRoot, predecessorState)
    requirePendingRollbackSequence(predecessorState, applyReceipt)
    requireRollbackEvidenceChronology(
      startRoot,
      applyReceipt,
      journalSegment,
    )
    requireAuthorityBindingSuccessor(
      startRoot.currentAuthority,
      createAuthorityBinding(currentAuthority),
    )
    if (
      Date.parse(applyReceipt.journal.retainUntil) <=
        Date.parse(committedAt) +
          WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
    ) {
      return failRollbackPersistence()
    }
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
    const common = {
      kind: 'workspace-search-migration-rollback-operation-receipt',
      persistenceVersion:
        WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: startRoot.runId,
      configurationHash: startRoot.configurationHash,
      tableIds: startRoot.tableIds,
      executionRunDigest: startRoot.executionRunDigest,
      appliedRootDigest: startRoot.appliedRootDigest,
      sealedPlanningAuthorityDigest:
        startRoot.sealedPlanningAuthorityDigest,
      startRootDigest: startRoot.startRootDigest,
      currentAuthority: createAuthorityBinding(currentAuthority),
      sequence: applyReceipt.sequence,
      operationId: applyReceipt.operationId,
      commandDigest: commandIdentity.commandDigest,
      applyReceipt,
      applyReceiptDigest: createMigrationDigest(applyReceipt),
      journalReferenceDigest:
        createMigrationDigest(applyReceipt.journal),
      previousJournalHeadDigest: journalSegment.previousHeadDigest,
      rollbackReceipt: event.receipt,
      rollbackReceiptDigest,
      predecessorRevision: predecessorState.revision,
      predecessorStateDigest: predecessorState.stateDigest,
      successorRevision: state.revision,
      successorStateDigest: state.stateDigest,
      committedAt,
    } satisfies Omit<
      WorkspaceSearchMigrationRollbackOperationReceipt,
      'receiptDigest'
    >
    const receipt = readOperationReceipt({
      ...common,
      receiptDigest: createMigrationDigest(common),
    })
    encodeValue(
      receipt,
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_MAX_BYTES,
    )
    validateWorkspaceSearchMigrationRollbackOperationReceiptTransition({
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
 * Completes rollback only after the pure state reaches the zero journal root.
 *
 * @param input - Start root, zero-head predecessor, authority, and final receipt.
 * @returns Exact pure terminal state, durable state, and immutable root.
 */
export function finishWorkspaceSearchMigrationRollback(
  input: FinishWorkspaceSearchMigrationRollbackInput,
): WorkspaceSearchMigrationRollbackFinishedTransition {
  return atRollbackPersistenceBoundary(() => {
    const inputRecord = requireExactRecord(input, [
      'currentAuthority',
      'finishedAt',
      'predecessorState',
      'startRoot',
      'terminalReceipt',
    ])
    const startRoot = readStartRoot(readOwn(inputRecord, 'startRoot'))
    const predecessorState = readPersistenceState(
      readOwn(inputRecord, 'predecessorState'),
    )
    const currentAuthority = readCurrentAuthority(
      readOwn(inputRecord, 'currentAuthority'),
    )
    const terminalReceiptValue = readOwn(
      inputRecord,
      'terminalReceipt',
    )
    const terminalReceipt = terminalReceiptValue === null
      ? null
      : readOperationReceipt(terminalReceiptValue)
    const finishedAt = readTimestamp(
      readOwn(inputRecord, 'finishedAt'),
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
      return failRollbackPersistence()
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
        WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: startRoot.runId,
      configurationHash: startRoot.configurationHash,
      tableIds: startRoot.tableIds,
      executionRunDigest: startRoot.executionRunDigest,
      appliedRootDigest: startRoot.appliedRootDigest,
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
      WorkspaceSearchMigrationRolledBackRoot,
      'rootDigest'
    >
    const root = readRolledBackRoot({
      ...common,
      rootDigest: createMigrationDigest(common),
    })
    encodeValue(
      root,
      WORKSPACE_SEARCH_MIGRATION_ROLLED_BACK_ROOT_MAX_BYTES,
    )
    return { root, runState, state }
  })
}

/**
 * Detaches the complete pure run state retained by a persistence state.
 *
 * @param state - Candidate strict rollback persistence state.
 * @returns Detached validated pure run state suitable for restart.
 */
export function decodeWorkspaceSearchMigrationRollbackRunState(
  state: WorkspaceSearchMigrationRollbackPersistenceState,
): WorkspaceSearchMigrationRunState {
  return atRollbackPersistenceBoundary(() =>
    readPersistenceState(state).runState
  )
}

/**
 * Validates that one compact rollback authority monotonically succeeds another.
 *
 * @param predecessor - Authority already fixed by durable rollback evidence.
 * @param current - Candidate authority retained by a later state or receipt.
 */
export function validateWorkspaceSearchMigrationRollbackAuthoritySuccessor(
  predecessor: WorkspaceSearchMigrationRollbackAuthorityBinding,
  current: WorkspaceSearchMigrationRollbackAuthorityBinding,
): void {
  return atRollbackPersistenceBoundary(() =>
    requireAuthorityBindingSuccessor(
      readAuthorityBinding(predecessor),
      readAuthorityBinding(current),
    )
  )
}

/**
 * Serializes one strict resumable rollback state.
 *
 * @param value - Candidate rollback persistence state.
 * @returns Exact bounded canonical UTF-8 JSON bytes.
 */
export function serializeWorkspaceSearchMigrationRollbackPersistenceState(
  value: WorkspaceSearchMigrationRollbackPersistenceState,
): Uint8Array {
  return atRollbackPersistenceBoundary(() =>
    encodeValue(
      readPersistenceState(value),
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical resumable rollback state.
 *
 * @param bytes - Untrusted bounded canonical state bytes.
 * @returns Detached strict rollback persistence state.
 */
export function parseWorkspaceSearchMigrationRollbackPersistenceState(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRollbackPersistenceState {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_MAX_BYTES,
    readPersistenceState,
  )
}

/**
 * Serializes one strict immutable rollback-start root.
 *
 * @param value - Candidate immutable start root.
 * @returns Exact bounded canonical UTF-8 JSON bytes.
 */
export function serializeWorkspaceSearchMigrationRollbackStartRoot(
  value: WorkspaceSearchMigrationRollbackStartRoot,
): Uint8Array {
  return atRollbackPersistenceBoundary(() =>
    encodeValue(
      readStartRoot(value),
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_START_ROOT_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical immutable rollback-start root.
 *
 * @param bytes - Untrusted bounded canonical start-root bytes.
 * @returns Detached strict immutable start root.
 */
export function parseWorkspaceSearchMigrationRollbackStartRoot(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRollbackStartRoot {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_START_ROOT_MAX_BYTES,
    readStartRoot,
  )
}

/**
 * Serializes one deterministic reverse-command identity.
 *
 * @param value - Candidate reverse-command identity.
 * @returns Exact bounded canonical UTF-8 JSON bytes.
 */
export function serializeWorkspaceSearchMigrationRollbackOperationCommandIdentity(
  value: WorkspaceSearchMigrationRollbackOperationCommandIdentity,
): Uint8Array {
  return atRollbackPersistenceBoundary(() =>
    encodeValue(
      readCommandIdentity(value),
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical reverse-command identity.
 *
 * @param bytes - Untrusted bounded canonical command bytes.
 * @returns Detached strict reverse-command identity.
 */
export function parseWorkspaceSearchMigrationRollbackOperationCommandIdentity(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRollbackOperationCommandIdentity {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_MAX_BYTES,
    readCommandIdentity,
  )
}

/**
 * Serializes one strict immutable reverse-operation receipt.
 *
 * @param value - Candidate immutable reverse receipt.
 * @returns Exact bounded canonical UTF-8 JSON bytes.
 */
export function serializeWorkspaceSearchMigrationRollbackOperationReceipt(
  value: WorkspaceSearchMigrationRollbackOperationReceipt,
): Uint8Array {
  return atRollbackPersistenceBoundary(() =>
    encodeValue(
      readOperationReceipt(value),
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical immutable reverse-operation receipt.
 *
 * @param bytes - Untrusted bounded canonical receipt bytes.
 * @returns Detached strict immutable reverse receipt.
 */
export function parseWorkspaceSearchMigrationRollbackOperationReceipt(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRollbackOperationReceipt {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_MAX_BYTES,
    readOperationReceipt,
  )
}

/**
 * Serializes one strict immutable rolled-back root.
 *
 * @param value - Candidate immutable terminal root.
 * @returns Exact bounded canonical UTF-8 JSON bytes.
 */
export function serializeWorkspaceSearchMigrationRolledBackRoot(
  value: WorkspaceSearchMigrationRolledBackRoot,
): Uint8Array {
  return atRollbackPersistenceBoundary(() =>
    encodeValue(
      readRolledBackRoot(value),
      WORKSPACE_SEARCH_MIGRATION_ROLLED_BACK_ROOT_MAX_BYTES,
    )
  )
}

/**
 * Parses one exact canonical immutable rolled-back root.
 *
 * @param bytes - Untrusted bounded canonical terminal-root bytes.
 * @returns Detached strict immutable rolled-back root.
 */
export function parseWorkspaceSearchMigrationRolledBackRoot(
  bytes: Uint8Array,
): WorkspaceSearchMigrationRolledBackRoot {
  return parseCanonicalBytes(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_ROLLED_BACK_ROOT_MAX_BYTES,
    readRolledBackRoot,
  )
}

/**
 * Exact values used to validate one durable reverse transition.
 */
export type ValidateWorkspaceSearchMigrationRollbackOperationReceiptTransitionInput = {
  /** Immutable rollback-start root. */
  readonly startRoot: WorkspaceSearchMigrationRollbackStartRoot
  /** Immutable durable reverse-operation receipt. */
  readonly receipt: WorkspaceSearchMigrationRollbackOperationReceipt
  /** Exact immutable journal segment referenced by the apply receipt. */
  readonly journalSegment: WorkspaceSearchJournalSegment
  /** Exact rolling-back predecessor state. */
  readonly predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceState
  /** Exact rolling-back successor state. */
  readonly successorState:
    WorkspaceSearchMigrationRollbackPersistenceState
}

/**
 * Validates both sides and immutable evidence of one reverse transition.
 *
 * @param input - Start root, receipt, predecessor, and successor state.
 */
export function validateWorkspaceSearchMigrationRollbackOperationReceiptTransition(
  input:
    ValidateWorkspaceSearchMigrationRollbackOperationReceiptTransitionInput,
): void {
  return atRollbackPersistenceBoundary(() => {
    const inputRecord = requireExactRecord(input, [
      'journalSegment',
      'predecessorState',
      'receipt',
      'startRoot',
      'successorState',
    ])
    const startRoot = readStartRoot(readOwn(inputRecord, 'startRoot'))
    const receipt = readOperationReceipt(
      readOwn(inputRecord, 'receipt'),
    )
    const journalSegment = readJournalSegment(
      readOwn(inputRecord, 'journalSegment'),
    )
    const predecessorState = readPersistenceState(
      readOwn(inputRecord, 'predecessorState'),
    )
    const successorState = readPersistenceState(
      readOwn(inputRecord, 'successorState'),
    )
    requireStateBelongsToStart(startRoot, predecessorState)
    requireStateBelongsToStart(startRoot, successorState)
    requireReceiptBelongsToStart(startRoot, receipt)
    requireRollbackEvidenceChronology(
      startRoot,
      receipt.applyReceipt,
      journalSegment,
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
      receipt.startRootDigest !== startRoot.startRootDigest ||
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
      return failRollbackPersistence()
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
    if (
      expectedRollbackReceiptDigest !==
        receipt.rollbackReceiptDigest
    ) {
      return failRollbackPersistence()
    }
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
    if (
      !equalBytes(
        encodeValue(
          expectedSuccessorState,
          WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_MAX_BYTES,
        ),
        encodeValue(
          successorState,
          WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_MAX_BYTES,
        ),
      )
    ) {
      return failRollbackPersistence()
    }
  })
}

/**
 * Detached immutable identity shared by every rollback persistence record.
 */
type RollbackBinding = {
  /** Operator-selected migration run. */
  readonly runId: string
  /** Reviewed measured-configuration digest. */
  readonly configurationHash: string
  /** All six immutable physical table incarnations. */
  readonly tableIds: WorkspaceSearchMigrationRollbackTableIds
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Digest of the immutable complete applied root. */
  readonly appliedRootDigest: string
  /** Digest of the immutable version-two planning authority. */
  readonly sealedPlanningAuthorityDigest: string
}

/**
 * Exact material used to create one mutable rollback state.
 */
type CreatePersistenceStateInput = {
  /** Shared immutable rollback identity. */
  readonly binding: RollbackBinding
  /** Digest of the exact immutable rollback-start root. */
  readonly startRootDigest: string
  /** Fresh authority atomically adopted by this state. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBinding
  /** Complete pure successor state. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Kind of predecessor consumed by this transition. */
  readonly predecessorKind:
    WorkspaceSearchMigrationRollbackStatePredecessorKind
  /** Exact predecessor digest. */
  readonly predecessorDigest: string
  /** Digest of the last pure rollback marker, or null. */
  readonly lastRollbackReceiptDigest: string | null
}

/**
 * Bounded graph traversal state used before cloning untrusted values.
 */
type SafeGraphBudget = {
  /** Number of graph nodes and own entries already charged. */
  nodes: number
  /** Total bytes across trusted binary values. */
  binaryBytes: number
  /** Total UTF-8 bytes across string values and property keys. */
  textBytes: number
  /** Nodes active in the current recursion stack. */
  active: WeakSet<object>
  /** Nodes already completely validated. */
  visited: WeakSet<object>
}

/**
 * Strictly detaches one immutable execution admission.
 *
 * @param value - Candidate execution admission.
 * @returns Detached strict execution admission.
 */
function readExecutionRun(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  if (!isExecutionRun(value)) return failRollbackPersistence()
  requireSafeDataGraph(value)
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(value),
  )
}

/**
 * Minimally narrows one candidate execution admission for its strict codec.
 *
 * @param value - Candidate value.
 * @returns Whether the execution-run codec may safely inspect it.
 */
function isExecutionRun(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  return isPlainRecord(value)
}

/**
 * Strictly detaches one immutable complete applied root.
 *
 * @param value - Candidate applied root.
 * @returns Detached strict applied root.
 */
function readAppliedRoot(
  value: unknown,
): WorkspaceSearchMigrationAppliedRoot {
  if (!isAppliedRoot(value)) return failRollbackPersistence()
  requireSafeDataGraph(value)
  return parseWorkspaceSearchMigrationAppliedRoot(
    serializeWorkspaceSearchMigrationAppliedRoot(value),
  )
}

/**
 * Minimally narrows one candidate applied root for its strict codec.
 *
 * @param value - Candidate value.
 * @returns Whether the applied-root codec may safely inspect it.
 */
function isAppliedRoot(
  value: unknown,
): value is WorkspaceSearchMigrationAppliedRoot {
  return isPlainRecord(value)
}

/**
 * Strictly detaches one immutable version-two planning authority.
 *
 * @param value - Candidate sealed planning authority.
 * @returns Detached strict version-two authority.
 */
function readSealedPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (!isSealedPlanningAuthority(value)) {
    return failRollbackPersistence()
  }
  requireSafeDataGraph(value)
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(value),
  )
}

/**
 * Minimally narrows one candidate planning authority for its strict codec.
 *
 * @param value - Candidate value.
 * @returns Whether the planning-authority codec may safely inspect it.
 */
function isSealedPlanningAuthority(
  value: unknown,
): value is WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return isPlainRecord(value)
}

/**
 * Strictly detaches one fresh current authority tuple.
 *
 * @param value - Candidate current authority.
 * @returns Detached strict current authority.
 */
function readCurrentAuthority(
  value: unknown,
): WorkspaceSearchMigrationPrePlanAuthority {
  if (!isCurrentAuthority(value)) return failRollbackPersistence()
  requireSafeDataGraph(value)
  return detachWorkspaceSearchMigrationPrePlanAuthorityForExecutionBoundary(
    value,
  )
}

/**
 * Minimally narrows one current authority for its strict detacher.
 *
 * @param value - Candidate value.
 * @returns Whether the authority detacher may safely inspect it.
 */
function isCurrentAuthority(
  value: unknown,
): value is WorkspaceSearchMigrationPrePlanAuthority {
  return isPlainRecord(value)
}

/**
 * Strictly detaches one exact-version journal segment.
 *
 * @param value - Candidate journal segment.
 * @returns Detached strict journal segment.
 */
function readJournalSegment(
  value: unknown,
): WorkspaceSearchJournalSegment {
  if (!isJournalSegment(value)) return failRollbackPersistence()
  requireSafeDataGraph(value)
  return parseWorkspaceSearchJournalSegment(
    serializeWorkspaceSearchJournalSegment(value),
  )
}

/**
 * Minimally narrows one journal segment for its strict codec.
 *
 * @param value - Candidate value.
 * @returns Whether the journal codec may safely inspect it.
 */
function isJournalSegment(
  value: unknown,
): value is WorkspaceSearchJournalSegment {
  return isPlainRecord(value)
}

/**
 * Creates the immutable cross-record binding after validating all roots.
 *
 * @param executionRun - Exact immutable execution admission.
 * @param appliedRoot - Exact immutable complete applied root.
 * @param sealedPlanningAuthority - Exact immutable planning authority.
 * @returns Detached common rollback binding.
 */
function createBinding(
  executionRun: WorkspaceSearchMigrationExecutionRun,
  appliedRoot: WorkspaceSearchMigrationAppliedRoot,
  sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): RollbackBinding {
  const tableIds = readTableIds(executionRun.binding.tableIds)
  if (
    executionRun.runId !== appliedRoot.runId ||
    executionRun.runId !== sealedPlanningAuthority.runId ||
    executionRun.configurationHash !==
      appliedRoot.configurationHash ||
    executionRun.configurationHash !==
      sealedPlanningAuthority.configurationHash ||
    executionRun.executionRunDigest !==
      appliedRoot.executionRunDigest ||
    executionRun.binding.bindingDigest !==
      appliedRoot.seal.executionRunBindingDigest ||
    executionRun.binding.sealedPlanningAuthorityDigest !==
      sealedPlanningAuthority.authorityDigest ||
    appliedRoot.seal.sealedPlanningAuthorityDigest !==
      sealedPlanningAuthority.authorityDigest ||
    executionRun.binding.planDigest !==
      sealedPlanningAuthority.planDigest ||
    executionRun.binding.planDigest !== appliedRoot.seal.planDigest ||
    executionRun.binding.planOperationCount !==
      sealedPlanningAuthority.planOperationCount ||
    executionRun.binding.planOperationCount !==
      appliedRoot.seal.planOperationCount ||
    sealedPlanningAuthority.sourceOperationCount !==
      appliedRoot.seal.sourceOperationCount ||
    sealedPlanningAuthority.orphanOperationCount !==
      appliedRoot.seal.orphanOperationCount ||
    !sameImmutableReference(
      executionRun.binding.planSealReference,
      sealedPlanningAuthority.planSealReference,
    ) ||
    !sameImmutableReference(
      executionRun.binding.planSealReference,
      appliedRoot.seal.planSealReference,
    ) ||
    !sameTableIds(tableIds, sealedPlanningAuthority.tableIds) ||
    !sameTableIds(tableIds, appliedRoot.seal.tableIds)
  ) {
    return failRollbackPersistence()
  }
  requireAuthorityBindingSuccessor(
    executionRun.binding.currentAuthority,
    appliedRoot.authority,
  )
  return {
    runId: executionRun.runId,
    configurationHash: executionRun.configurationHash,
    tableIds,
    executionRunDigest: executionRun.executionRunDigest,
    appliedRootDigest: appliedRoot.rootDigest,
    sealedPlanningAuthorityDigest:
      sealedPlanningAuthority.authorityDigest,
  }
}

/**
 * Reconstructs the common binding retained by a parsed start root.
 *
 * @param startRoot - Exact strict start root.
 * @returns Detached common rollback binding.
 */
function createBindingFromStartRoot(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
): RollbackBinding {
  return {
    runId: startRoot.runId,
    configurationHash: startRoot.configurationHash,
    tableIds: readTableIds(startRoot.tableIds),
    executionRunDigest: startRoot.executionRunDigest,
    appliedRootDigest: startRoot.appliedRootDigest,
    sealedPlanningAuthorityDigest:
      startRoot.sealedPlanningAuthorityDigest,
  }
}

/**
 * Correlates the applied predecessor with every immutable start root.
 *
 * @param binding - Exact common rollback identity.
 * @param executionRun - Immutable execution admission.
 * @param appliedRoot - Immutable complete applied root.
 * @param sealedPlanningAuthority - Immutable planning authority.
 * @param predecessor - Exact applied pure predecessor state.
 */
function requireAppliedStartBindings(
  binding: RollbackBinding,
  executionRun: WorkspaceSearchMigrationExecutionRun,
  appliedRoot: WorkspaceSearchMigrationAppliedRoot,
  sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  predecessor: WorkspaceSearchMigrationRunState,
): void {
  if (
    predecessor.status !== 'applied' ||
    predecessor.runId !== binding.runId ||
    predecessor.configurationHash !== binding.configurationHash ||
    predecessor.revision !== appliedRoot.successorRevision ||
    createMigrationDigest(predecessor) !==
      appliedRoot.successorRunStateDigest ||
    predecessor.journalSequence !==
      appliedRoot.seal.journalSequence ||
    predecessor.journalHeadDigest !==
      appliedRoot.seal.journalHeadDigest ||
    predecessor.appliedOperationCount !==
      appliedRoot.seal.markerCount ||
    predecessor.maintenanceEvidenceReceipt.fenceToken !==
      appliedRoot.authority.fenceToken ||
    createMigrationDigest(
      predecessor.maintenanceEvidenceReceipt,
    ) !== appliedRoot.authority.maintenanceEvidenceReceiptDigest ||
    predecessor.applyMarkerDigestState.count !==
      appliedRoot.seal.applyMarkerDigestState.count ||
    predecessor.applyMarkerDigestState.sumHex !==
      appliedRoot.seal.applyMarkerDigestState.sumHex ||
    predecessor.applyMarkerDigestState.xorHex !==
      appliedRoot.seal.applyMarkerDigestState.xorHex ||
    createMigrationDigest(predecessor.apply) !==
      appliedRoot.seal.applyTraversalDigest ||
    predecessor.applySeal?.scope !== 'complete-plan' ||
    predecessor.applySeal.objectKey !==
      appliedRoot.sealReference.objectKey ||
    predecessor.applySeal.versionId !==
      appliedRoot.sealReference.versionId ||
    predecessor.applySeal.contentDigest !==
      appliedRoot.sealReference.contentDigest ||
    predecessor.createdAt !== executionRun.runState.createdAt ||
    predecessor.dryRunEvidenceDigest !==
      executionRun.runState.dryRunEvidenceDigest ||
    predecessor.planSealReference.objectKey !==
      executionRun.binding.planSealReference.objectKey ||
    predecessor.planSealReference.versionId !==
      executionRun.binding.planSealReference.versionId ||
    predecessor.planSealReference.contentDigest !==
      executionRun.binding.planSealReference.contentDigest ||
    executionRun.binding.planDigest !== predecessor.planDigest ||
    sealedPlanningAuthority.planDigest !== predecessor.planDigest ||
    executionRun.binding.planOperationCount !==
      predecessor.planOperationCount ||
    sealedPlanningAuthority.planOperationCount !==
      predecessor.planOperationCount ||
    !sameTableIds(
      binding.tableIds,
      createTableIdsFromRunState(predecessor),
    )
  ) {
    return failRollbackPersistence()
  }
}

/**
 * Requires fresh authority to match one run and immutable state table.
 *
 * @param binding - Exact common rollback identity.
 * @param state - Exact pure run state being mutated.
 * @param predecessorAuthority - Authority adopted by the durable predecessor.
 * @param currentAuthority - Fresh strongly resolved authority.
 * @param committedAt - Adapter-owned transaction time.
 */
function requireAuthorityForRunState(
  binding: RollbackBinding,
  state: WorkspaceSearchMigrationRunState,
  predecessorAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBinding,
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
    return failRollbackPersistence()
  }
}

/**
 * Atomically adopts fresh maintenance evidence for one authorized mutation.
 *
 * The returned state is an in-transaction effective predecessor. It is never
 * stored separately and therefore does not advance the optimistic revision;
 * the enclosing start, reverse-step, or finish transaction stores only the
 * event successor while condition-checking the exact durable predecessor.
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
 * @param authority - Compact authority atomically consumed by the mutation.
 * @param receipt - Full maintenance receipt selected by that authority.
 * @param committedAt - Adapter-owned enclosing transaction time.
 * @returns Exact validated effective predecessor.
 */
function createAuthorityAdoptedRunStateFromEvidence(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationRollbackAuthorityBinding,
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
    return failRollbackPersistence()
  }
  return readRunState({
    ...state,
    maintenanceEvidenceDigest: receipt.evidenceDigest,
    maintenanceEvidenceLocator: receipt.evidenceLocator,
    maintenanceEvidenceReceipt: receipt,
    updatedAt: committedAt,
  })
}

/**
 * Creates the pure state-machine authority from fresh durable authority.
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
 * Reconstructs the only pure authority facts retained by a rollback receipt.
 *
 * The synthetic lease window exists only to replay the pure reducer. Durable
 * ownership comes from the compact authority stored in the immutable receipt.
 * Receipt validation separately binds its fence and maintenance evidence to
 * the exact adopted successor state.
 *
 * @param predecessor - Exact rolling-back predecessor state.
 * @param receipt - Candidate durable reverse-operation receipt.
 * @returns Deterministic authority suitable for pure successor replay.
 */
function createReceiptValidationAuthority(
  predecessor:
    WorkspaceSearchMigrationRollbackPersistenceState,
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
): WorkspaceSearchMigrationAuthority {
  const committedMilliseconds = Date.parse(receipt.committedAt)
  const expiresMilliseconds =
    committedMilliseconds +
    WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS
  if (
    !Number.isSafeInteger(committedMilliseconds) ||
    !Number.isSafeInteger(expiresMilliseconds)
  ) {
    return failRollbackPersistence()
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
 * Reconstructs the effective predecessor used by an atomic reverse operation.
 *
 * @param predecessor - Exact durable state consumed by the transaction.
 * @param successor - Exact durable state stored by the transaction.
 * @param receipt - Immutable operation receipt retaining fresh authority.
 * @returns Pure predecessor with the atomically adopted current evidence.
 */
function createReceiptValidationPredecessor(
  predecessor:
    WorkspaceSearchMigrationRollbackPersistenceState,
  successor:
    WorkspaceSearchMigrationRollbackPersistenceState,
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
): WorkspaceSearchMigrationRunState {
  if (
    !sameAuthorityBinding(
      successor.currentAuthority,
      receipt.currentAuthority,
    )
  ) {
    return failRollbackPersistence()
  }
  return createAuthorityAdoptedRunStateFromEvidence(
    predecessor.runState,
    receipt.currentAuthority,
    successor.runState.maintenanceEvidenceReceipt,
    receipt.committedAt,
  )
}

/**
 * Creates the compact authority tuple retained by immutable roots.
 *
 * @param authority - Fresh exact current authority.
 * @returns Detached compact authority binding.
 */
function createAuthorityBinding(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationRollbackAuthorityBinding {
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
 * Requires a current authority tuple to succeed an immutable predecessor.
 *
 * A takeover may advance the fence and owner. The pointer revision remains
 * globally monotonic, one revision cannot substitute different content, and
 * the owner remains immutable while the fence is unchanged.
 *
 * @param predecessor - Authority fixed by the preceding immutable root.
 * @param current - Fresh authority consumed by the next transaction.
 */
function requireAuthorityBindingSuccessor(
  predecessor: WorkspaceSearchMigrationRollbackAuthorityBinding,
  current: WorkspaceSearchMigrationRollbackAuthorityBinding,
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
    return failRollbackPersistence()
  }
}

/**
 * Compares two compact authority tuples exactly.
 *
 * @param left - First validated authority binding.
 * @param right - Second validated authority binding.
 * @returns Whether every owner, fence, pointer, digest, and time field matches.
 */
function sameAuthorityBinding(
  left: WorkspaceSearchMigrationRollbackAuthorityBinding,
  right: WorkspaceSearchMigrationRollbackAuthorityBinding,
): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.fenceToken === right.fenceToken &&
    left.maintenanceEvidencePointerRevision ===
      right.maintenanceEvidencePointerRevision &&
    left.maintenanceEvidenceReceiptDigest ===
      right.maintenanceEvidenceReceiptDigest &&
    left.evaluatedAt === right.evaluatedAt
  )
}

/**
 * Creates the legacy pure complete-plan seal represented by a production root.
 *
 * @param root - Exact immutable production applied root.
 * @returns Detached legacy pure seal.
 */
function createLegacyCompleteApplySeal(
  root: WorkspaceSearchMigrationAppliedRoot,
): WorkspaceSearchApplySeal {
  return {
    kind: 'workspace-search-apply-seal',
    sealVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: root.runId,
    configurationHash: root.configurationHash,
    scope: 'complete-plan',
    planDigest: root.seal.planDigest,
    planOperationCount: root.seal.planOperationCount,
    journalSequence: root.seal.journalSequence,
    journalHeadDigest: root.seal.journalHeadDigest,
    markerCount: root.seal.markerCount,
    applyMarkerAggregateDigest:
      root.seal.applyMarkerAggregateDigest,
    createdAt: root.seal.createdAt,
  }
}

/**
 * Creates the legacy pure seal reference represented by a production root.
 *
 * @param root - Exact immutable production applied root.
 * @returns Detached legacy pure complete-plan reference.
 */
function createLegacyCompleteApplySealReference(
  root: WorkspaceSearchMigrationAppliedRoot,
): WorkspaceSearchApplySealReference {
  const seal = createLegacyCompleteApplySeal(root)
  return {
    scope: 'complete-plan',
    objectKey: root.sealReference.objectKey,
    versionId: root.sealReference.versionId,
    contentDigest: createMigrationDigest(seal),
  }
}

/**
 * Creates one strict rollback persistence state from a pure state.
 *
 * @param input - Binding, pure state, predecessor, and last marker digest.
 * @returns Detached canonical rollback persistence state.
 */
function createPersistenceState(
  input: CreatePersistenceStateInput,
): WorkspaceSearchMigrationRollbackPersistenceState {
  const runState = readRollbackRunState(input.runState)
  const progress = runState.rollback
  if (progress === undefined) return failRollbackPersistence()
  const common = {
    kind: 'workspace-search-migration-rollback-state',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: input.binding.runId,
    configurationHash: input.binding.configurationHash,
    tableIds: input.binding.tableIds,
    executionRunDigest: input.binding.executionRunDigest,
    appliedRootDigest: input.binding.appliedRootDigest,
    sealedPlanningAuthorityDigest:
      input.binding.sealedPlanningAuthorityDigest,
    startRootDigest: readDigest(input.startRootDigest),
    currentAuthority: readAuthorityBinding(input.currentAuthority),
    status: readRollbackStatus(runState.status),
    revision: runState.revision,
    predecessorKind: input.predecessorKind,
    predecessorDigest: readDigest(input.predecessorDigest),
    upperBoundSequence: progress.upperBoundSequence,
    nextSequence: progress.nextSequence,
    expectedHeadDigest: progress.expectedHeadDigest,
    restored: progress.restored,
    lastRollbackReceiptDigest:
      readNullableDigest(input.lastRollbackReceiptDigest),
    runState,
    runStateDigest: createMigrationDigest(runState),
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackPersistenceState,
    'stateDigest'
  >
  const state = readPersistenceState({
    ...common,
    stateDigest: createMigrationDigest(common),
  })
  encodeValue(
    state,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_MAX_BYTES,
  )
  return state
}

/**
 * Reads and validates one complete mutable rollback state.
 *
 * @param value - Candidate rollback persistence state.
 * @returns Detached strict rollback persistence state.
 */
function readPersistenceState(
  value: unknown,
): WorkspaceSearchMigrationRollbackPersistenceState {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
    'configurationHash',
    'currentAuthority',
    'executionRunDigest',
    'expectedHeadDigest',
    'kind',
    'lastRollbackReceiptDigest',
    'migrationId',
    'migrationVersion',
    'nextSequence',
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
  const kind = readOwn(record, 'kind')
  const persistenceVersion = readOwn(record, 'persistenceVersion')
  const migrationId = readOwn(record, 'migrationId')
  const migrationVersion = readOwn(record, 'migrationVersion')
  if (
    kind !== 'workspace-search-migration-rollback-state' ||
    persistenceVersion !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION ||
    migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistence()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const tableIds = readTableIds(readOwn(record, 'tableIds'))
  const executionRunDigest = readDigest(
    readOwn(record, 'executionRunDigest'),
  )
  const appliedRootDigest = readDigest(
    readOwn(record, 'appliedRootDigest'),
  )
  const sealedPlanningAuthorityDigest = readDigest(
    readOwn(record, 'sealedPlanningAuthorityDigest'),
  )
  const startRootDigest = readDigest(
    readOwn(record, 'startRootDigest'),
  )
  const currentAuthority = readAuthorityBinding(
    readOwn(record, 'currentAuthority'),
  )
  const status = readRollbackStatus(readOwn(record, 'status'))
  const revision = readPositiveSafeInteger(
    readOwn(record, 'revision'),
  )
  const predecessorKind = readPredecessorKind(
    readOwn(record, 'predecessorKind'),
  )
  const predecessorDigest = readDigest(
    readOwn(record, 'predecessorDigest'),
  )
  const upperBoundSequence = readNonNegativeSafeInteger(
    readOwn(record, 'upperBoundSequence'),
  )
  const nextSequence = readNonNegativeSafeInteger(
    readOwn(record, 'nextSequence'),
  )
  const expectedHeadDigest = readDigest(
    readOwn(record, 'expectedHeadDigest'),
  )
  const restored = readNonNegativeSafeInteger(
    readOwn(record, 'restored'),
  )
  const lastRollbackReceiptDigest = readNullableDigest(
    readOwn(record, 'lastRollbackReceiptDigest'),
  )
  const runState = readRollbackRunState(readOwn(record, 'runState'))
  const runStateDigest = readDigest(
    readOwn(record, 'runStateDigest'),
  )
  const stateDigest = readDigest(readOwn(record, 'stateDigest'))
  const common = {
    kind,
    persistenceVersion,
    migrationId,
    migrationVersion,
    runId,
    configurationHash,
    tableIds,
    executionRunDigest,
    appliedRootDigest,
    sealedPlanningAuthorityDigest,
    startRootDigest,
    currentAuthority,
    status,
    revision,
    predecessorKind,
    predecessorDigest,
    upperBoundSequence,
    nextSequence,
    expectedHeadDigest,
    restored,
    lastRollbackReceiptDigest,
    runState,
    runStateDigest,
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackPersistenceState,
    'stateDigest'
  >
  requirePersistenceStateInvariants(common)
  if (
    runStateDigest !== createMigrationDigest(runState) ||
    stateDigest !== createMigrationDigest(common)
  ) {
    return failRollbackPersistence()
  }
  return { ...common, stateDigest }
}

/**
 * Validates flattened fields against one complete pure rollback state.
 *
 * @param state - Candidate state without its self digest.
 */
function requirePersistenceStateInvariants(
  state: Omit<
    WorkspaceSearchMigrationRollbackPersistenceState,
    'stateDigest'
  >,
): void {
  const progress = state.runState.rollback
  if (
    progress === undefined ||
    state.runState.runId !== state.runId ||
    state.runState.configurationHash !== state.configurationHash ||
    state.runState.status !== state.status ||
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
      state.predecessorKind === 'applied-root' &&
      (
        state.status !== 'rolling-back' ||
        state.restored !== 0
      )
    ) ||
    (
      state.status === 'rolled-back' &&
      (
        state.nextSequence !== 0 ||
        state.expectedHeadDigest !== zeroDigest()
      )
    )
  ) {
    return failRollbackPersistence()
  }
}

/**
 * Reads a complete strict applied pure state for rollback start.
 *
 * @param value - Candidate pure run state.
 * @returns Detached strict applied state.
 */
function readAppliedRunState(
  value: unknown,
): WorkspaceSearchMigrationRunState {
  const state = readRunState(value)
  if (state.status !== 'applied') return failRollbackPersistence()
  return state
}

/**
 * Reads a complete strict rolling-back or rolled-back pure state.
 *
 * @param value - Candidate pure run state.
 * @returns Detached strict rollback lifecycle state.
 */
function readRollbackRunState(
  value: unknown,
): WorkspaceSearchMigrationRunState {
  const state = readRunState(value)
  if (
    state.status !== 'rolling-back' &&
    state.status !== 'rolled-back'
  ) {
    return failRollbackPersistence()
  }
  return state
}

/**
 * Detaches and validates one pure run state without caller behavior.
 *
 * @param value - Candidate pure run state.
 * @returns Detached validated pure run state.
 */
function readRunState(
  value: unknown,
): WorkspaceSearchMigrationRunState {
  const detached = detachSafeGraph(value)
  if (!isRunState(detached)) return failRollbackPersistence()
  requireExactRunStateKeys(detached)
  validateWorkspaceSearchMigrationRunState(detached)
  return detached
}

/**
 * Minimally narrows one detached ordinary record to a run-state candidate.
 *
 * @param value - Detached candidate value.
 * @returns Whether the state-machine validator may inspect it.
 */
function isRunState(
  value: unknown,
): value is WorkspaceSearchMigrationRunState {
  return isPlainRecord(value)
}

/**
 * Requires exact top-level keys for the lifecycle states used here.
 *
 * @param state - Candidate applied or rollback run state.
 */
function requireExactRunStateKeys(
  state: WorkspaceSearchMigrationRunState,
): void {
  const common = [
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
    'runId',
    'status',
    'updatedAt',
  ]
  requireExactKeys(
    state,
    state.status === 'applied'
      ? common
      : [...common, 'rollback'],
  )
}

/**
 * Digests the complete non-circular content of one rollback-start root.
 *
 * The embedded initial state must itself bind the resulting root digest. The
 * root digest therefore normalizes only that self-reference, the state digest
 * that depends on it, and the root's copy of that dependent state digest. All
 * other initial-state and immutable-root fields remain covered.
 *
 * @param root - Candidate start root without its own digest field.
 * @returns Digest of every non-circular immutable start-root field.
 */
function createStartRootDigest(
  root: Omit<
    WorkspaceSearchMigrationRollbackStartRoot,
    'startRootDigest'
  >,
): string {
  const {
    startRootDigest: embeddedStartRootDigest,
    stateDigest: embeddedStateDigest,
    ...initialStateCore
  } = root.initialState
  if (
    !isHexDigest(embeddedStartRootDigest) ||
    !isHexDigest(embeddedStateDigest)
  ) {
    return failRollbackPersistence()
  }
  return createMigrationDigest({
    ...root,
    initialState: initialStateCore,
    initialStateDigest: createMigrationDigest(initialStateCore),
  })
}

/**
 * Reads and validates one immutable rollback-start root.
 *
 * @param value - Candidate start root.
 * @returns Detached strict start root.
 */
function readStartRoot(
  value: unknown,
): WorkspaceSearchMigrationRollbackStartRoot {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
    'configurationHash',
    'currentAuthority',
    'executionRunDigest',
    'initialRunStateDigest',
    'initialState',
    'initialStateDigest',
    'kind',
    'migrationId',
    'migrationVersion',
    'originalJournalHeadDigest',
    'originalJournalSequence',
    'persistenceVersion',
    'predecessorRevision',
    'predecessorRunStateDigest',
    'runId',
    'sealedPlanningAuthorityDigest',
    'startedAt',
    'startRootDigest',
    'tableIds',
  ])
  const kind = readOwn(record, 'kind')
  const persistenceVersion = readOwn(record, 'persistenceVersion')
  const migrationId = readOwn(record, 'migrationId')
  const migrationVersion = readOwn(record, 'migrationVersion')
  if (
    kind !== 'workspace-search-migration-rollback-start-root' ||
    persistenceVersion !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION ||
    migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistence()
  }
  const runId = readIdentifier(readOwn(record, 'runId'))
  const configurationHash = readDigest(
    readOwn(record, 'configurationHash'),
  )
  const tableIds = readTableIds(readOwn(record, 'tableIds'))
  const executionRunDigest = readDigest(
    readOwn(record, 'executionRunDigest'),
  )
  const appliedRootDigest = readDigest(
    readOwn(record, 'appliedRootDigest'),
  )
  const sealedPlanningAuthorityDigest = readDigest(
    readOwn(record, 'sealedPlanningAuthorityDigest'),
  )
  const predecessorRevision = readPositiveSafeInteger(
    readOwn(record, 'predecessorRevision'),
  )
  const predecessorRunStateDigest = readDigest(
    readOwn(record, 'predecessorRunStateDigest'),
  )
  const originalJournalSequence = readNonNegativeSafeInteger(
    readOwn(record, 'originalJournalSequence'),
  )
  const originalJournalHeadDigest = readDigest(
    readOwn(record, 'originalJournalHeadDigest'),
  )
  const currentAuthority = readAuthorityBinding(
    readOwn(record, 'currentAuthority'),
  )
  const startedAt = readTimestamp(readOwn(record, 'startedAt'))
  const initialState = readPersistenceState(
    readOwn(record, 'initialState'),
  )
  const initialStateDigest = readDigest(
    readOwn(record, 'initialStateDigest'),
  )
  const initialRunStateDigest = readDigest(
    readOwn(record, 'initialRunStateDigest'),
  )
  const startRootDigest = readDigest(
    readOwn(record, 'startRootDigest'),
  )
  const common = {
    kind,
    persistenceVersion,
    migrationId,
    migrationVersion,
    runId,
    configurationHash,
    tableIds,
    executionRunDigest,
    appliedRootDigest,
    sealedPlanningAuthorityDigest,
    predecessorRevision,
    predecessorRunStateDigest,
    originalJournalSequence,
    originalJournalHeadDigest,
    currentAuthority,
    startedAt,
    initialState,
    initialStateDigest,
    initialRunStateDigest,
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackStartRoot,
    'startRootDigest'
  >
  if (
    initialState.runId !== runId ||
    initialState.configurationHash !== configurationHash ||
    !sameTableIds(initialState.tableIds, tableIds) ||
    initialState.executionRunDigest !== executionRunDigest ||
    initialState.appliedRootDigest !== appliedRootDigest ||
    initialState.sealedPlanningAuthorityDigest !==
      sealedPlanningAuthorityDigest ||
    initialState.startRootDigest !== startRootDigest ||
    initialState.predecessorKind !== 'applied-root' ||
    initialState.predecessorDigest !== appliedRootDigest ||
    initialState.status !== 'rolling-back' ||
    initialState.revision !== predecessorRevision + 1 ||
    initialState.upperBoundSequence !== originalJournalSequence ||
    initialState.nextSequence !== originalJournalSequence ||
    initialState.expectedHeadDigest !==
      originalJournalHeadDigest ||
    initialState.restored !== 0 ||
    initialState.lastRollbackReceiptDigest !== null ||
    initialState.runState.updatedAt !== startedAt ||
    !sameAuthorityBinding(
      currentAuthority,
      initialState.currentAuthority,
    ) ||
    currentAuthority.fenceToken !==
      initialState.runState.maintenanceEvidenceReceipt.fenceToken ||
    currentAuthority.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(
        initialState.runState.maintenanceEvidenceReceipt,
      ) ||
    Date.parse(currentAuthority.evaluatedAt) >
      Date.parse(startedAt) ||
    initialStateDigest !== initialState.stateDigest ||
    initialRunStateDigest !== initialState.runStateDigest ||
    startRootDigest !== createStartRootDigest(common)
  ) {
    return failRollbackPersistence()
  }
  return { ...common, startRootDigest }
}

/**
 * Creates one deterministic command identity from validated values.
 *
 * @param startRoot - Exact immutable rollback-start root.
 * @param predecessorState - Exact rolling-back predecessor.
 * @param applyReceipt - Exact durable forward apply receipt.
 * @returns Detached strict deterministic command identity.
 */
function createCommandIdentity(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  predecessorState:
    WorkspaceSearchMigrationRollbackPersistenceState,
  applyReceipt: WorkspaceSearchOperationReceipt,
): WorkspaceSearchMigrationRollbackOperationCommandIdentity {
  const common = {
    kind: 'workspace-search-migration-rollback-operation-command',
    persistenceVersion:
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: startRoot.runId,
    configurationHash: startRoot.configurationHash,
    tableIds: startRoot.tableIds,
    executionRunDigest: startRoot.executionRunDigest,
    appliedRootDigest: startRoot.appliedRootDigest,
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
    WorkspaceSearchMigrationRollbackOperationCommandIdentity,
    'commandDigest'
  >
  const command = readCommandIdentity({
    ...common,
    commandDigest: createMigrationDigest(common),
  })
  encodeValue(
    command,
    WORKSPACE_SEARCH_MIGRATION_ROLLBACK_RECEIPT_MAX_BYTES,
  )
  return command
}

/**
 * Reads and validates one deterministic reverse command identity.
 *
 * @param value - Candidate command identity.
 * @returns Detached strict command identity.
 */
function readCommandIdentity(
  value: unknown,
): WorkspaceSearchMigrationRollbackOperationCommandIdentity {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
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
    'persistenceVersion',
    'predecessorStateDigest',
    'runId',
    'sealedPlanningAuthorityDigest',
    'sequence',
    'startRootDigest',
    'tableIds',
  ])
  const kind = readOwn(record, 'kind')
  const persistenceVersion = readOwn(record, 'persistenceVersion')
  const migrationId = readOwn(record, 'migrationId')
  const migrationVersion = readOwn(record, 'migrationVersion')
  if (
    kind !==
      'workspace-search-migration-rollback-operation-command' ||
    persistenceVersion !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION ||
    migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistence()
  }
  const common = {
    kind,
    persistenceVersion,
    migrationId,
    migrationVersion,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    executionRunDigest: readDigest(
      readOwn(record, 'executionRunDigest'),
    ),
    appliedRootDigest: readDigest(
      readOwn(record, 'appliedRootDigest'),
    ),
    sealedPlanningAuthorityDigest: readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    startRootDigest: readDigest(
      readOwn(record, 'startRootDigest'),
    ),
    expectedRevision: readPositiveSafeInteger(
      readOwn(record, 'expectedRevision'),
    ),
    predecessorStateDigest: readDigest(
      readOwn(record, 'predecessorStateDigest'),
    ),
    sequence: readPositiveSafeInteger(
      readOwn(record, 'sequence'),
    ),
    operationId: readIdentifier(readOwn(record, 'operationId')),
    applyReceiptDigest: readDigest(
      readOwn(record, 'applyReceiptDigest'),
    ),
    journalReferenceDigest: readDigest(
      readOwn(record, 'journalReferenceDigest'),
    ),
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackOperationCommandIdentity,
    'commandDigest'
  >
  const commandDigest = readDigest(
    readOwn(record, 'commandDigest'),
  )
  if (commandDigest !== createMigrationDigest(common)) {
    return failRollbackPersistence()
  }
  return { ...common, commandDigest }
}

/**
 * Reads and validates one immutable durable reverse-operation receipt.
 *
 * @param value - Candidate durable receipt.
 * @returns Detached strict durable receipt.
 */
function readOperationReceipt(
  value: unknown,
): WorkspaceSearchMigrationRollbackOperationReceipt {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
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
  const kind = readOwn(record, 'kind')
  const persistenceVersion = readOwn(record, 'persistenceVersion')
  const migrationId = readOwn(record, 'migrationId')
  const migrationVersion = readOwn(record, 'migrationVersion')
  if (
    kind !==
      'workspace-search-migration-rollback-operation-receipt' ||
    persistenceVersion !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION ||
    migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistence()
  }
  const applyReceipt = readApplyReceipt(
    readOwn(record, 'applyReceipt'),
  )
  const rollbackReceipt = readRollbackReceipt(
    readOwn(record, 'rollbackReceipt'),
  )
  const common = {
    kind,
    persistenceVersion,
    migrationId,
    migrationVersion,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    executionRunDigest: readDigest(
      readOwn(record, 'executionRunDigest'),
    ),
    appliedRootDigest: readDigest(
      readOwn(record, 'appliedRootDigest'),
    ),
    sealedPlanningAuthorityDigest: readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    startRootDigest: readDigest(
      readOwn(record, 'startRootDigest'),
    ),
    currentAuthority: readAuthorityBinding(
      readOwn(record, 'currentAuthority'),
    ),
    sequence: readPositiveSafeInteger(
      readOwn(record, 'sequence'),
    ),
    operationId: readIdentifier(readOwn(record, 'operationId')),
    commandDigest: readDigest(readOwn(record, 'commandDigest')),
    applyReceipt,
    applyReceiptDigest: readDigest(
      readOwn(record, 'applyReceiptDigest'),
    ),
    journalReferenceDigest: readDigest(
      readOwn(record, 'journalReferenceDigest'),
    ),
    previousJournalHeadDigest: readDigest(
      readOwn(record, 'previousJournalHeadDigest'),
    ),
    rollbackReceipt,
    rollbackReceiptDigest: readDigest(
      readOwn(record, 'rollbackReceiptDigest'),
    ),
    predecessorRevision: readPositiveSafeInteger(
      readOwn(record, 'predecessorRevision'),
    ),
    predecessorStateDigest: readDigest(
      readOwn(record, 'predecessorStateDigest'),
    ),
    successorRevision: readPositiveSafeInteger(
      readOwn(record, 'successorRevision'),
    ),
    successorStateDigest: readDigest(
      readOwn(record, 'successorStateDigest'),
    ),
    committedAt: readTimestamp(readOwn(record, 'committedAt')),
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackOperationReceipt,
    'receiptDigest'
  >
  const receiptDigest = readDigest(readOwn(record, 'receiptDigest'))
  if (
    common.runId !== applyReceipt.runId ||
    common.runId !== rollbackReceipt.runId ||
    common.configurationHash !== applyReceipt.configurationHash ||
    common.configurationHash !==
      rollbackReceipt.configurationHash ||
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
    return failRollbackPersistence()
  }
  return { ...common, receiptDigest }
}

/**
 * Reads and validates one immutable terminal rolled-back root.
 *
 * @param value - Candidate terminal root.
 * @returns Detached strict terminal root.
 */
function readRolledBackRoot(
  value: unknown,
): WorkspaceSearchMigrationRolledBackRoot {
  const record = requireExactRecord(value, [
    'appliedRootDigest',
    'configurationHash',
    'executionRunDigest',
    'finalAuthority',
    'finalRunStateDigest',
    'finishedAt',
    'kind',
    'migrationId',
    'migrationVersion',
    'persistenceVersion',
    'rootDigest',
    'runId',
    'rollbackStartedAt',
    'sealedPlanningAuthorityDigest',
    'startRootDigest',
    'tableIds',
    'terminalReceipt',
    'terminalReceiptDigest',
    'terminalState',
    'terminalStateDigest',
  ])
  const kind = readOwn(record, 'kind')
  const persistenceVersion = readOwn(record, 'persistenceVersion')
  const migrationId = readOwn(record, 'migrationId')
  const migrationVersion = readOwn(record, 'migrationVersion')
  if (
    kind !== 'workspace-search-migration-rolled-back-root' ||
    persistenceVersion !==
      WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_VERSION ||
    migrationId !== WORKSPACE_SEARCH_MIGRATION_ID ||
    migrationVersion !== WORKSPACE_SEARCH_MIGRATION_VERSION
  ) {
    return failRollbackPersistence()
  }
  const terminalReceiptValue = readOwn(record, 'terminalReceipt')
  const terminalReceipt = terminalReceiptValue === null
    ? null
    : readOperationReceipt(terminalReceiptValue)
  const common = {
    kind,
    persistenceVersion,
    migrationId,
    migrationVersion,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    tableIds: readTableIds(readOwn(record, 'tableIds')),
    executionRunDigest: readDigest(
      readOwn(record, 'executionRunDigest'),
    ),
    appliedRootDigest: readDigest(
      readOwn(record, 'appliedRootDigest'),
    ),
    sealedPlanningAuthorityDigest: readDigest(
      readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    startRootDigest: readDigest(
      readOwn(record, 'startRootDigest'),
    ),
    terminalState: readPersistenceState(
      readOwn(record, 'terminalState'),
    ),
    terminalStateDigest: readDigest(
      readOwn(record, 'terminalStateDigest'),
    ),
    terminalReceipt,
    terminalReceiptDigest: readNullableDigest(
      readOwn(record, 'terminalReceiptDigest'),
    ),
    finalRunStateDigest: readDigest(
      readOwn(record, 'finalRunStateDigest'),
    ),
    finalAuthority: readAuthorityBinding(
      readOwn(record, 'finalAuthority'),
    ),
    rollbackStartedAt: readTimestamp(
      readOwn(record, 'rollbackStartedAt'),
    ),
    finishedAt: readTimestamp(readOwn(record, 'finishedAt')),
  } satisfies Omit<
    WorkspaceSearchMigrationRolledBackRoot,
    'rootDigest'
  >
  const rootDigest = readDigest(readOwn(record, 'rootDigest'))
  const terminal = common.terminalState
  if (common.terminalReceipt !== null) {
    requireAuthorityBindingSuccessor(
      common.terminalReceipt.currentAuthority,
      common.finalAuthority,
    )
  }
  if (
    terminal.runId !== common.runId ||
    terminal.configurationHash !== common.configurationHash ||
    !sameTableIds(terminal.tableIds, common.tableIds) ||
    terminal.executionRunDigest !== common.executionRunDigest ||
    terminal.appliedRootDigest !== common.appliedRootDigest ||
    terminal.sealedPlanningAuthorityDigest !==
      common.sealedPlanningAuthorityDigest ||
    terminal.startRootDigest !== common.startRootDigest ||
    terminal.status !== 'rolled-back' ||
    terminal.nextSequence !== 0 ||
    terminal.expectedHeadDigest !== zeroDigest() ||
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
    (
      common.terminalReceipt !== null &&
      (
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
        common.terminalReceipt.appliedRootDigest !==
          common.appliedRootDigest ||
        common.terminalReceipt.sealedPlanningAuthorityDigest !==
          common.sealedPlanningAuthorityDigest ||
        common.terminalReceipt.startRootDigest !==
          common.startRootDigest ||
        common.terminalReceipt.sequence !== 1 ||
        common.terminalReceipt.previousJournalHeadDigest !==
          zeroDigest() ||
        common.terminalReceipt.successorStateDigest !==
          terminal.predecessorDigest ||
        common.terminalReceipt.rollbackReceiptDigest !==
          terminal.lastRollbackReceiptDigest
      )
    ) ||
    rootDigest !== createMigrationDigest(common)
  ) {
    return failRollbackPersistence()
  }
  return { ...common, rootDigest }
}

/**
 * Requires one mutable state to belong to an immutable start root.
 *
 * @param startRoot - Exact immutable start root.
 * @param state - Candidate mutable state.
 */
function requireStateBelongsToStart(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  state: WorkspaceSearchMigrationRollbackPersistenceState,
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
    state.appliedRootDigest !== startRoot.appliedRootDigest ||
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
    return failRollbackPersistence()
  }
}

/**
 * Requires one apply receipt to be the exact next reverse sequence.
 *
 * @param state - Exact rolling-back predecessor state.
 * @param receipt - Candidate forward apply receipt.
 */
function requirePendingRollbackSequence(
  state: WorkspaceSearchMigrationRollbackPersistenceState,
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
    return failRollbackPersistence()
  }
}

/**
 * Requires immutable forward evidence to predate rollback in causal order.
 *
 * @param startRoot - Immutable root fixing the rollback start time.
 * @param applyReceipt - Exact forward apply receipt being reversed.
 * @param journalSegment - Exact preimage segment referenced by the receipt.
 */
function requireRollbackEvidenceChronology(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  applyReceipt: WorkspaceSearchOperationReceipt,
  journalSegment: WorkspaceSearchJournalSegment,
): void {
  if (
    Date.parse(applyReceipt.committedAt) >
      Date.parse(startRoot.startedAt) ||
    Date.parse(journalSegment.createdAt) >
      Date.parse(applyReceipt.committedAt)
  ) {
    return failRollbackPersistence()
  }
}

/**
 * Requires one durable receipt to repeat the exact immutable root binding.
 *
 * @param startRoot - Exact immutable rollback-start root.
 * @param receipt - Candidate durable reverse-operation receipt.
 */
function requireReceiptBelongsToStart(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
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
    receipt.appliedRootDigest !== startRoot.appliedRootDigest ||
    receipt.sealedPlanningAuthorityDigest !==
      startRoot.sealedPlanningAuthorityDigest ||
    receipt.startRootDigest !== startRoot.startRootDigest
  ) {
    return failRollbackPersistence()
  }
}

/**
 * Requires the final receipt to close the exact zero-head predecessor.
 *
 * @param startRoot - Exact immutable start root.
 * @param predecessor - Exact zero-head rolling-back predecessor.
 * @param terminalReceipt - Final reverse receipt, or null for zero mutations.
 */
function requireFinishReceipt(
  startRoot: WorkspaceSearchMigrationRollbackStartRoot,
  predecessor:
    WorkspaceSearchMigrationRollbackPersistenceState,
  terminalReceipt:
    WorkspaceSearchMigrationRollbackOperationReceipt | null,
): void {
  if (
    predecessor.status !== 'rolling-back' ||
    predecessor.nextSequence !== 0 ||
    predecessor.expectedHeadDigest !== zeroDigest() ||
    predecessor.restored !== predecessor.upperBoundSequence
  ) {
    return failRollbackPersistence()
  }
  if (startRoot.originalJournalSequence === 0) {
    if (
      terminalReceipt !== null ||
      predecessor.lastRollbackReceiptDigest !== null
    ) {
      return failRollbackPersistence()
    }
    return
  }
  if (terminalReceipt !== null) {
    requireReceiptBelongsToStart(startRoot, terminalReceipt)
  }
  if (
    terminalReceipt === null ||
    terminalReceipt.startRootDigest !== startRoot.startRootDigest ||
    terminalReceipt.sequence !== 1 ||
    terminalReceipt.successorRevision !== predecessor.revision ||
    terminalReceipt.successorStateDigest !==
      predecessor.stateDigest ||
    terminalReceipt.rollbackReceiptDigest !==
      predecessor.lastRollbackReceiptDigest
  ) {
    return failRollbackPersistence()
  }
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
    return failRollbackPersistence()
  }
  let marker: ReturnType<
    typeof parseWorkspaceSearchMigrationOperationMarker
  >
  try {
    marker = parseWorkspaceSearchMigrationOperationMarker(
      serializeWorkspaceSearchMigrationOperationMarker(value),
    )
  } catch {
    return failRollbackPersistence()
  }
  if (marker.kind !== 'workspace-search-operation-applied') {
    return failRollbackPersistence()
  }
  return marker
}

/**
 * Minimally narrows one apply receipt for the strict marker codec.
 *
 * @param value - Candidate value already checked as a safe data graph.
 * @returns Whether the strict marker codec may inspect the candidate.
 */
function isApplyReceiptCandidate(
  value: unknown,
): value is WorkspaceSearchOperationReceipt {
  return isPlainRecord(value)
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
  const record = requireExactRecord(value, [
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
  const kind = readOwn(record, 'kind')
  const markerVersion = readOwn(record, 'markerVersion')
  if (
    kind !== 'workspace-search-operation-rolled-back' ||
    markerVersion !== 1
  ) {
    return failRollbackPersistence()
  }
  return {
    kind,
    markerVersion,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    operationId: readIdentifier(readOwn(record, 'operationId')),
    sequence: readPositiveSafeInteger(
      readOwn(record, 'sequence'),
    ),
    applyReceiptDigest: readDigest(
      readOwn(record, 'applyReceiptDigest'),
    ),
    targetKeyDigest: readDigest(
      readOwn(record, 'targetKeyDigest'),
    ),
    beforeDigest: readDigest(readOwn(record, 'beforeDigest')),
    afterDigest: readDigest(readOwn(record, 'afterDigest')),
    journalHeadDigest: readDigest(
      readOwn(record, 'journalHeadDigest'),
    ),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    rolledBackAt: readTimestamp(readOwn(record, 'rolledBackAt')),
  }
}

/**
 * Reads one compact current-authority binding.
 *
 * @param value - Candidate compact authority.
 * @returns Detached strict authority binding.
 */
function readAuthorityBinding(
  value: unknown,
): WorkspaceSearchMigrationRollbackAuthorityBinding {
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
    maintenanceEvidencePointerRevision: readPositiveSafeInteger(
      readOwn(record, 'maintenanceEvidencePointerRevision'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    evaluatedAt: readTimestamp(readOwn(record, 'evaluatedAt')),
  }
}

/**
 * Reads all six exact role-indexed physical TableIds.
 *
 * @param value - Candidate role-indexed TableIds.
 * @returns Detached strict role-indexed TableIds.
 */
function readTableIds(
  value: unknown,
): WorkspaceSearchMigrationRollbackTableIds {
  const record = requireExactRecord(value, tableRoles)
  return {
    'project-directory': readBoundedText(
      readOwn(record, 'project-directory'),
    ),
    'work-items': readBoundedText(readOwn(record, 'work-items')),
    collaboration: readBoundedText(
      readOwn(record, 'collaboration'),
    ),
    documents: readBoundedText(readOwn(record, 'documents')),
    'workspace-search': readBoundedText(
      readOwn(record, 'workspace-search'),
    ),
    'migration-state': readBoundedText(
      readOwn(record, 'migration-state'),
    ),
  }
}

/**
 * Extracts all six physical TableIds from one validated pure state.
 *
 * @param state - Exact validated pure migration run state.
 * @returns Detached role-indexed TableIds.
 */
function createTableIdsFromRunState(
  state: WorkspaceSearchMigrationRunState,
): WorkspaceSearchMigrationRollbackTableIds {
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
 * Compares one complete immutable plan-seal object reference.
 *
 * @param left - First rich exact-version plan-seal reference.
 * @param right - Second rich exact-version plan-seal reference.
 * @returns Whether object identity, content, size, and retention all match.
 */
function sameImmutableReference(
  left:
    WorkspaceSearchMigrationExecutionRun['binding']['planSealReference'],
  right:
    WorkspaceSearchMigrationExecutionRun['binding']['planSealReference'],
): boolean {
  return (
    left.objectKey === right.objectKey &&
    left.versionId === right.versionId &&
    left.contentDigest === right.contentDigest &&
    left.byteLength === right.byteLength &&
    left.retainUntil === right.retainUntil
  )
}

/**
 * Compares all six exact physical TableIds.
 *
 * @param left - First role-indexed identity set.
 * @param right - Second role-indexed identity set.
 * @returns Whether every role has the same TableId.
 */
function sameTableIds(
  left: WorkspaceSearchMigrationRollbackTableIds,
  right: WorkspaceSearchMigrationSealedPlanningTableIds,
): boolean {
  return tableRoles.every((role) => left[role] === right[role])
}

/**
 * Reads one supported rollback lifecycle status.
 *
 * @param value - Candidate status.
 * @returns Strict rollback lifecycle status.
 */
function readRollbackStatus(
  value: unknown,
): 'rolling-back' | 'rolled-back' {
  if (value !== 'rolling-back' && value !== 'rolled-back') {
    return failRollbackPersistence()
  }
  return value
}

/**
 * Reads one supported rollback-state predecessor kind.
 *
 * @param value - Candidate predecessor kind.
 * @returns Strict predecessor kind.
 */
function readPredecessorKind(
  value: unknown,
): WorkspaceSearchMigrationRollbackStatePredecessorKind {
  if (value !== 'applied-root' && value !== 'rollback-state') {
    return failRollbackPersistence()
  }
  return value
}

/**
 * Reads one migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Strict bounded migration identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !hasOnlyPairedSurrogates(value)) {
    return failRollbackPersistence()
  }
  try {
    requireMigrationIdentifier(value, 'rollback persistence identifier')
  } catch {
    return failRollbackPersistence()
  }
  return value
}

/**
 * Reads one bounded non-empty text field.
 *
 * @param value - Candidate text.
 * @returns Strict bounded text.
 */
function readBoundedText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumTextLength ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failRollbackPersistence()
  }
  return value
}

/**
 * Reads one canonical lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Strict digest.
 */
function readDigest(value: unknown): string {
  if (typeof value !== 'string' || !isHexDigest(value)) {
    return failRollbackPersistence()
  }
  return value
}

/**
 * Reads one canonical digest or null.
 *
 * @param value - Candidate optional digest.
 * @returns Strict digest or null.
 */
function readNullableDigest(value: unknown): string | null {
  return value === null ? null : readDigest(value)
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Strict canonical timestamp.
 */
function readTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !isCanonicalTimestamp(value)) {
    return failRollbackPersistence()
  }
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate number.
 * @returns Strict positive safe integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number') {
    return failRollbackPersistence()
  }
  if (value < 1) return failRollbackPersistence()
  return value
}

/**
 * Reads one non-negative safe integer.
 *
 * @param value - Candidate number.
 * @returns Strict non-negative safe integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number') {
    return failRollbackPersistence()
  }
  if (value < 0 || Object.is(value, -0)) {
    return failRollbackPersistence()
  }
  return value
}

/**
 * Returns the canonical zero SHA-256 digest.
 *
 * @returns Sixty-four lowercase zero hexadecimal characters.
 */
function zeroDigest(): string {
  return '0'.repeat(64)
}

/**
 * Requires one strict plain record with exactly the expected own keys.
 *
 * @param value - Candidate record.
 * @param expectedKeys - Complete expected key set.
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
 * Requires one record to contain exactly the expected data properties.
 *
 * @param record - Strict caller-owned record.
 * @param expectedKeys - Complete expected key set.
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
    return failRollbackPersistence()
  }
  const actual = keys.filter(
    (key): key is string => typeof key === 'string',
  ).sort()
  const expected = [...expectedKeys].sort()
  if (
    actual.some((key, index) => key !== expected[index])
  ) {
    return failRollbackPersistence()
  }
  for (const key of expected) {
    if (!hasOwnDataProperty(record, key)) {
      return failRollbackPersistence()
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
  if (!isPlainRecord(value)) return failRollbackPersistence()
  return value
}

/**
 * Checks whether one value is a supported non-Proxy plain record.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a strict plain record.
 */
function isPlainRecord(
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
 * Checks one enumerable own data property without invoking accessors.
 *
 * @param record - Candidate record.
 * @param key - Expected property name.
 * @returns Whether the exact own data property exists.
 */
function hasOwnDataProperty(record: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return false
  if (
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return failRollbackPersistence()
  }
  return true
}

/**
 * Reads one validated own data property without invoking accessors.
 *
 * @param record - Strict caller-owned record.
 * @param key - Exact property name.
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
    return failRollbackPersistence()
  }
  return descriptor.value
}

/**
 * Detaches one bounded caller-owned graph after rejecting active behavior.
 *
 * @param value - Candidate graph.
 * @returns Detached graph with the same static type.
 */
function detachSafeGraph<Value>(value: Value): Value {
  requireSafeDataGraph(value)
  return structuredClone(value)
}

/**
 * Rejects accessors, Proxies, symbols, cycles, and unbounded data graphs.
 *
 * @param value - Candidate caller-owned graph.
 */
function requireSafeDataGraph(value: unknown): void {
  inspectSafeDataGraph(value, {
    nodes: 0,
    binaryBytes: 0,
    textBytes: 0,
    active: new WeakSet<object>(),
    visited: new WeakSet<object>(),
  }, 0)
}

/**
 * Recursively inspects one strict finite caller-owned data graph.
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
    return failRollbackPersistence()
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
    return failRollbackPersistence()
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      return failRollbackPersistence()
    }
    return
  }
  if (
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value) ||
    budget.active.has(value) ||
    budget.visited.has(value)
  ) {
    return failRollbackPersistence()
  }
  if (isSupportedBinaryValue(value)) {
    chargeSafeGraphBinary(budget, value.byteLength)
    requireExactTypedArrayKeys(value)
    budget.visited.add(value)
    return
  }
  budget.active.add(value)
  if (Array.isArray(value)) {
    if (
      !hasCanonicalDenseArrayShape(value) ||
      value.length > maximumSafeGraphArrayLength
    ) {
      return failRollbackPersistence()
    }
    chargeSafeGraphBudget(budget, value.length)
    for (const child of value) {
      inspectSafeDataGraph(child, budget, depth + 1)
    }
  } else {
    const record = requirePlainRecord(value)
    const keys = Reflect.ownKeys(record)
    if (keys.length > maximumSafeGraphObjectProperties) {
      return failRollbackPersistence()
    }
    chargeSafeGraphBudget(budget, keys.length)
    for (const key of keys) {
      if (typeof key !== 'string') {
        return failRollbackPersistence()
      }
      chargeSafeGraphText(budget, key)
      const descriptor = Object.getOwnPropertyDescriptor(record, key)
      if (
        descriptor === undefined ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        descriptor.enumerable !== true
      ) {
        return failRollbackPersistence()
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
    return failRollbackPersistence()
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
    return failRollbackPersistence()
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
    return failRollbackPersistence()
  }
  const byteLength = Buffer.byteLength(value, 'utf8')
  if (
    byteLength > maximumSafeGraphTextBytes ||
    budget.textBytes > maximumSafeGraphTextBytes - byteLength
  ) {
    return failRollbackPersistence()
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
 */
function requireExactTypedArrayKeys(value: Uint8Array): void {
  const keys = Reflect.ownKeys(value)
  if (
    keys.some((key) => typeof key === 'symbol') ||
    keys.length !== value.byteLength
  ) {
    return failRollbackPersistence()
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
      return failRollbackPersistence()
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
  requireSafeDataGraph(value)
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(value),
  )
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes
  ) {
    return failRollbackPersistence()
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
  return atRollbackPersistenceBoundary(() => {
    const snapshot = copyBoundedBytes(bytes, maximumBytes)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        snapshot,
      )
    } catch {
      return failRollbackPersistence()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failRollbackPersistence()
    }
    const value = reader(parsed)
    const canonical = encodeValue(value, maximumBytes)
    if (!equalBytes(snapshot, canonical)) {
      return failRollbackPersistence()
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
    return failRollbackPersistence()
  }
  requireExactTypedArrayKeys(bytes)
  return new Uint8Array(bytes)
}

/**
 * Compares two byte arrays without string coercion.
 *
 * @param left - First byte array.
 * @param right - Second byte array.
 * @returns Whether both arrays contain identical bytes.
 */
function equalBytes(
  left: Uint8Array,
  right: Uint8Array,
): boolean {
  if (left.byteLength !== right.byteLength) return false
  return left.every((value, index) => value === right[index])
}

/**
 * Converts every internal failure into one stable public contract error.
 *
 * @param operation - Persistence operation to execute.
 * @returns Successful operation result.
 */
function atRollbackPersistenceBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationRollbackPersistenceError()
  }
}

/**
 * Throws the stable rollback persistence failure.
 *
 * @returns Never returns.
 */
function failRollbackPersistence(): never {
  throw new WorkspaceSearchMigrationRollbackPersistenceError()
}
