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
  createMigrationDigest,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type MigrationDigestState,
  type MigrationScanAggregate,
  type MigrationSourceCheckpoint,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchApplySealReference,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationTableRole,
  type WorkspaceSearchMigrationTraversalProgress,
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
  reconstructWorkspaceSearchMigrationRunState,
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
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  reduceWorkspaceSearchMigrationRunState,
  validateWorkspaceSearchMigrationCheckpoint,
  validateWorkspaceSearchMigrationRunState,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
  type WorkspaceSearchMigrationAuthority,
} from './migration-state-machine'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Schema version reserved for committed-prefix rollback persistence. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_PERSISTENCE_V2_VERSION = 2

/** Maximum canonical bytes accepted for one committed-prefix origin. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_ORIGIN_V2_MAX_BYTES =
  96 * 1024

/** Maximum canonical bytes accepted for one initial v2 rollback state. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_V2_MAX_BYTES =
  192 * 1024

/** Maximum canonical bytes accepted for one v2 rollback-start root. */
export const WORKSPACE_SEARCH_MIGRATION_ROLLBACK_START_ROOT_V2_MAX_BYTES =
  320 * 1024

const rollbackOriginVersion = 1
const zeroDigest = '0'.repeat(64)
const maximumSafeGraphDepth = 64
const maximumSafeGraphNodes = 100_000
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
 * Compact fresh authority atomically consumed by rollback start.
 */
export type WorkspaceSearchMigrationRollbackAuthorityBindingV2 = {
  /** Lease owner condition-checked by the start transaction. */
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
 * Initial durable rolling-back state rooted in one committed prefix.
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
  /** Fresh authority atomically adopted by this initial state. */
  readonly currentAuthority:
    WorkspaceSearchMigrationRollbackAuthorityBindingV2
  /** Initial v2 state is always actively rolling back. */
  readonly status: 'rolling-back'
  /** Exact optimistic-concurrency revision after rollback start. */
  readonly revision: number
  /** Initial state consumes the committed-prefix origin directly. */
  readonly predecessorKind: 'committed-prefix-origin'
  /** Exact committed-prefix origin digest consumed by this state. */
  readonly predecessorDigest: string
  /** Final committed mutation sequence fixed by the origin seal. */
  readonly upperBoundSequence: number
  /** Next reverse sequence, or zero for a zero-mutation prefix. */
  readonly nextSequence: number
  /** Journal head expected by the first reverse operation. */
  readonly expectedHeadDigest: string
  /** Initial state has restored no target mutations. */
  readonly restored: 0
  /** Initial state has no preceding rollback marker. */
  readonly lastRollbackReceiptDigest: null
  /** Complete validated rolling-back pure run state. */
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
 * Bounded descriptor-safe graph traversal state.
 */
type SafeGraphBudget = {
  /** Number of inspected nodes and own entries. */
  nodes: number
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
 * Serializes one strict initial v2 rollback state.
 *
 * @param value - Candidate initial committed-prefix rollback state.
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
 * Parses one exact canonical initial v2 rollback state.
 *
 * @param bytes - Untrusted bounded canonical state bytes.
 * @returns Detached strict initial committed-prefix rollback state.
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
 * Reads one runtime initial v2 state.
 *
 * @param value - Candidate runtime state.
 * @returns Detached strict initial v2 state.
 */
function readStateRuntime(
  value: unknown,
): WorkspaceSearchMigrationRollbackPersistenceStateV2 {
  return readState(value, readRuntimeRunState)
}

/**
 * Reads one canonical-document initial v2 state.
 *
 * @param value - Candidate JSON-safe state document.
 * @returns Detached strict initial v2 state.
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
 * @returns Detached strict initial v2 state.
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
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    strictGuards.readOwn(record, 'status') !== 'rolling-back' ||
    strictGuards.readOwn(record, 'predecessorKind') !==
      'committed-prefix-origin' ||
    strictGuards.readOwn(record, 'restored') !== 0 ||
    strictGuards.readOwn(record, 'lastRollbackReceiptDigest') !== null
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
    status: 'rolling-back',
    revision: readPositiveSafeInteger(
      strictGuards.readOwn(record, 'revision'),
    ),
    predecessorKind: 'committed-prefix-origin',
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
    restored: 0,
    lastRollbackReceiptDigest: null,
    runState,
    runStateDigest: strictGuards.readDigest(
      strictGuards.readOwn(record, 'runStateDigest'),
    ),
  } satisfies RollbackStateV2Common
  const stateDigest = strictGuards.readDigest(
    strictGuards.readOwn(record, 'stateDigest'),
  )
  requireInitialStateInvariants(common)
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
 * Requires flattened state fields to match the complete pure run state.
 *
 * @param state - Candidate state without its self digest.
 */
function requireInitialStateInvariants(
  state: RollbackStateV2Common,
): void {
  const progress = state.runState.rollback
  if (
    progress === undefined ||
    state.runState.status !== 'rolling-back' ||
    state.runState.runId !== state.runId ||
    state.runState.configurationHash !== state.configurationHash ||
    state.runState.revision !== state.revision ||
    state.predecessorDigest !== state.originDigest ||
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
    progress.restored !== 0 ||
    state.nextSequence !== state.upperBoundSequence
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
    initialState.predecessorDigest !== common.originDigest ||
    initialState.revision !== common.predecessorRevision + 1 ||
    initialState.upperBoundSequence !==
      common.originalJournalSequence ||
    initialState.nextSequence !== common.originalJournalSequence ||
    initialState.expectedHeadDigest !==
      common.originalJournalHeadDigest ||
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
 * Creates one JSON-safe rolling-back run-state document.
 *
 * @param state - Strict runtime rolling-back state.
 * @returns Exact document with losslessly encoded traversal cursors.
 */
function createRunStateDocument(
  state: WorkspaceSearchMigrationRunState,
): object {
  const strict = readRollingBackRunState(state)
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
 * Reads one JSON-safe rolling-back run-state document.
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
  return readRollingBackRunState(state)
}

/**
 * Reads one runtime rolling-back run state.
 *
 * @param value - Candidate runtime run state.
 * @returns Strict rolling-back committed-prefix state.
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
  return readRollingBackRunState(value)
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
    0,
    {
      nodes: 0,
      active: new WeakSet<object>(),
      visited: new WeakSet<object>(),
    },
  )
}

/**
 * Recursively rejects proxies, accessors, cycles, and exotic objects.
 *
 * @param value - Current graph node.
 * @param depth - Current recursive depth.
 * @param budget - Shared traversal budget.
 */
function inspectSafeDataGraph(
  value: unknown,
  depth: number,
  budget: SafeGraphBudget,
): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    value === undefined
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return failRollbackPersistenceV2()
    }
    return
  }
  if (typeof value !== 'object' || nodeUtilTypes.isProxy(value)) {
    return failRollbackPersistenceV2()
  }
  if (depth > maximumSafeGraphDepth) {
    return failRollbackPersistenceV2()
  }
  if (
    nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isArrayBuffer(value)
  ) {
    if (
      nodeUtilTypes.isSharedArrayBuffer(
        nodeUtilTypes.isUint8Array(value)
          ? strictGuards.readIntrinsicBuffer(value)
          : value,
      )
    ) {
      return failRollbackPersistenceV2()
    }
    return
  }
  if (budget.visited.has(value)) return
  if (budget.active.has(value)) {
    return failRollbackPersistenceV2()
  }
  budget.nodes += 1
  if (budget.nodes > maximumSafeGraphNodes) {
    return failRollbackPersistenceV2()
  }
  budget.active.add(value)
  const isArray = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (
    (!isArray &&
      prototype !== Object.prototype &&
      prototype !== null) ||
    (isArray && prototype !== Array.prototype)
  ) {
    return failRollbackPersistenceV2()
  }
  const keys = Reflect.ownKeys(value)
  if (keys.some((key) => typeof key !== 'string')) {
    return failRollbackPersistenceV2()
  }
  if (isArray) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, String(index))) {
        return failRollbackPersistenceV2()
      }
    }
  }
  for (const key of keys) {
    if (isArray && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failRollbackPersistenceV2()
    }
    budget.nodes += 1
    if (budget.nodes > maximumSafeGraphNodes) {
      return failRollbackPersistenceV2()
    }
    inspectSafeDataGraph(descriptor.value, depth + 1, budget)
  }
  budget.active.delete(value)
  budget.visited.add(value)
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
