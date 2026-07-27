import {
  createAttributeMapDigest,
  decodeAttributeMapToNativeRecord,
  encodeAttributeMap,
  serializeCanonicalAttributeMap,
} from './dynamodb-attribute-codec'
import {
  createAbsentMigrationItemDigest,
  isCanonicalWorkspaceSearchMigrationEntityId,
  serializeWorkspaceSearchJournalSegment,
} from './migration-journal'
import { mapWorkspaceSearchMigrationRow } from './migration-mapper'
import { encodeWorkspaceSearchMigrationDocument } from './migration-target-snapshot'
import {
  MAINTENANCE_EVIDENCE_CLOCK_SKEW_SECONDS,
  MAINTENANCE_EVIDENCE_MAX_AGE_SECONDS,
  MaintenanceEvidenceError,
  parseMaintenanceEvidence,
  type ParsedWorkspaceSearchMaintenanceEvidence,
} from './maintenance-evidence'
import {
  createWorkspaceSearchDocumentRecordKey,
  readWorkspaceSearchDocument,
  type WorkspaceSearchDocument,
} from '../../../src/modules/workspace-search'
import {
  createEmptyMigrationScanAggregate,
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  createWorkspaceSearchOperationId,
  isCanonicalTimestamp,
  isHexDigest,
  MigrationDigestAccumulator,
  type MigrationDigestState,
  type MigrationItemSnapshot,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchApplySealReference,
  type WorkspaceSearchJournalReference,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  WorkspaceSearchMigrationFailure,
  type WorkspaceSearchMigrationLease,
  type WorkspaceSearchMigrationOperation,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTraversalProgress,
  type WorkspaceSearchOperationMarker,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchPlanSeal,
  type WorkspaceSearchPlanSealReference,
  type WorkspaceSearchRollbackReceipt,
  type WorkspaceSearchVerificationEvidence,
  type WorkspaceSearchVerificationEvidenceReference,
  workspaceSearchMigrationSourceNames,
  zeroHexDigest,
} from './migration-contract'

/** Fixed fenced-lease duration assigned by the persistence adapter clock. */
export const WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS = 60_000

/** Required deadline headroom before an adapter starts one atomic commit. */
export const WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS =
  10_000

/** One sibling hash used to prove an operation's ordered plan membership. */
export type WorkspaceSearchPlanMembershipProofStep = {
  /** Side on which the sibling is combined with the current Merkle node. */
  side: 'left' | 'right'
  /** Exact sibling leaf or internal-node digest. */
  digest: string
}

/** Exact immutable operation stored under one sealed migration plan. */
export type WorkspaceSearchPlannedOperation = {
  /** Operator-selected run identifier that owns the plan. */
  runId: string
  /** Reviewed configuration digest bound to the plan. */
  configurationHash: string
  /** Digest of the complete immutable plan. */
  planDigest: string
  /** One-based stable position in the complete plan. */
  planSequence: number
  /** Digest of the exact losslessly encoded operation. */
  operationDigest: string
  /** Ordered Merkle path from this operation leaf to the reviewed plan root. */
  membershipProof: readonly WorkspaceSearchPlanMembershipProofStep[]
  /** Exact source condition and target transition approved by the plan. */
  operation: WorkspaceSearchMigrationOperation
}

/** Active lease and trusted commit time supplied to one state transition. */
export type WorkspaceSearchMigrationAuthority = {
  /** Exact active lease observed by the caller. */
  lease: WorkspaceSearchMigrationLease
  /** Owner that must still hold the exact lease. */
  ownerId: string
  /**
   * Canonical UTC time captured from the adapter-owned trusted clock
   * immediately before the atomic transaction.
   */
  at: string
}

/** Exact durable lease identity expected by one adapter command. */
export type WorkspaceSearchMigrationLeaseClaim = {
  /** Run that must own the durable lease. */
  runId: string
  /** Owner that must still hold the lease. */
  ownerId: string
  /** Exact monotonically increasing fence token. */
  fenceToken: number
}

/** Inputs required to create the first durable run state. */
export type CreateWorkspaceSearchMigrationRunStateInput = {
  /** Operator-selected run identifier. */
  runId: string
  /** Exact active lease authorizing run creation. */
  lease: WorkspaceSearchMigrationLease
  /** Owner that must hold the lease at creation time. */
  ownerId: string
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Exact measured migration configuration. */
  configuration: WorkspaceSearchMigrationConfiguration
  /** Fresh maintenance evidence bound to the lease fence. */
  maintenanceEvidenceReceipt: WorkspaceSearchMaintenanceEvidenceReceipt
  /** Digest of the exact reviewed dry-run evidence bytes. */
  dryRunEvidenceDigest: string
  /** Digest of the immutable sealed operation plan. */
  planDigest: string
  /** Exact number of entries in the immutable sealed plan. */
  planOperationCount: number
  /** Exact immutable plan-seal document reviewed before run creation. */
  planSeal: WorkspaceSearchPlanSeal
  /** Immutable object version that stores the exact plan-seal bytes. */
  planSealReference: WorkspaceSearchPlanSealReference
  /** Canonical UTC creation time and authority evaluation time. */
  createdAt: string
}

/** Inputs used to validate exact evidence bytes at one active lease fence. */
export type CreateWorkspaceSearchMaintenanceEvidenceReceiptInput = {
  /** Operator-selected run identifier. */
  runId: string
  /** Exact active lease whose fence may consume the evidence. */
  lease: WorkspaceSearchMigrationLease
  /** Exact untrusted maintenance-evidence file bytes. */
  evidenceBytes: Uint8Array
  /** Adapter-owned canonical UTC validation time. */
  validatedAt: string
}

/** Traversal checkpoint location within one apply or verification phase. */
export type WorkspaceSearchMigrationCheckpointLocation =
  | WorkspaceSearchMigrationSourceName
  | 'target'

/** Replaces the current fresh maintenance evidence under the same active lease. */
export type WorkspaceSearchMaintenanceEvidenceRenewedEvent = {
  /** State-machine event discriminator. */
  kind: 'maintenance-evidence-renewed'
  /** Newly validated evidence receipt bound to the current lease fence. */
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt
}

/** Caller request whose exact bytes are validated inside the persistence boundary. */
export type WorkspaceSearchMaintenanceEvidenceRenewalCommandEvent = {
  /** Adapter-command discriminator. */
  kind: 'maintenance-evidence-renewal-requested'
  /** Exact untrusted maintenance-evidence file bytes. */
  evidenceBytes: Uint8Array
}

/** Records one exact sealed-plan operation marker. */
export type WorkspaceSearchApplyOperationRecordedEvent = {
  /** State-machine event discriminator. */
  kind: 'apply-operation-recorded'
  /** Exact persisted plan entry whose membership is condition-checked atomically. */
  plannedOperation: WorkspaceSearchPlannedOperation
  /** Durable no-op or mutation marker committed atomically with run progress. */
  marker: WorkspaceSearchOperationMarker
  /** Exact immutable preimage segment required by a mutating marker. */
  journalSegment?: WorkspaceSearchJournalSegment
}

/** Saves one monotonic apply checkpoint. */
export type WorkspaceSearchApplyCheckpointRecordedEvent = {
  /** State-machine event discriminator. */
  kind: 'apply-checkpoint-recorded'
  /** Source or target traversal whose checkpoint advances. */
  location: WorkspaceSearchMigrationCheckpointLocation
  /** Complete cumulative checkpoint after one bounded page. */
  checkpoint: MigrationSourceCheckpoint
}

/** Seals a fully applied plan before verification begins. */
export type WorkspaceSearchApplySealedEvent = {
  /** State-machine event discriminator. */
  kind: 'apply-sealed'
  /** Canonical complete-plan seal uploaded before the state transition. */
  seal: WorkspaceSearchApplySeal
  /** Immutable S3 version that stores the exact canonical seal bytes. */
  reference: WorkspaceSearchApplySealReference
}

/** Starts an independent full verification traversal. */
export type WorkspaceSearchVerificationStartedEvent = {
  /** State-machine event discriminator. */
  kind: 'verification-started'
}

/** Saves one monotonic verification checkpoint. */
export type WorkspaceSearchVerificationCheckpointRecordedEvent = {
  /** State-machine event discriminator. */
  kind: 'verification-checkpoint-recorded'
  /** Source or target traversal whose checkpoint advances. */
  location: WorkspaceSearchMigrationCheckpointLocation
  /** Complete cumulative checkpoint after one bounded verification page. */
  checkpoint: MigrationSourceCheckpoint
}

/** Marks complete verification evidence as successful. */
export type WorkspaceSearchVerificationPassedEvent = {
  /** State-machine event discriminator. */
  kind: 'verification-passed'
  /** Exact canonical complete full-scan verification evidence. */
  evidence: WorkspaceSearchVerificationEvidence
  /** Immutable object version that stores the exact evidence bytes. */
  reference: WorkspaceSearchVerificationEvidenceReference
}

/** Starts reverse rollback from a complete apply or a sealed partial prefix. */
export type WorkspaceSearchRollbackStartedEvent = {
  /** State-machine event discriminator. */
  kind: 'rollback-started'
  /** Exact complete-plan or committed-prefix seal revalidated before rollback. */
  seal: WorkspaceSearchApplySeal
  /** Immutable object version that stores the exact supplied seal. */
  reference: WorkspaceSearchApplySealReference
}

/** Records one exact reverse-order rollback mutation. */
export type WorkspaceSearchRollbackOperationRecordedEvent = {
  /** State-machine event discriminator. */
  kind: 'rollback-operation-recorded'
  /** Exact apply receipt at the current reverse journal sequence. */
  applyReceipt: WorkspaceSearchOperationReceipt
  /** Exact immutable journal segment referenced by the apply receipt. */
  journalSegment: WorkspaceSearchJournalSegment
  /** Durable rollback marker committed atomically with target restoration. */
  receipt: WorkspaceSearchRollbackReceipt
}

/** Caller payload for one apply command before adapter-owned authority is read. */
export type WorkspaceSearchApplyOperationCommandEvent = {
  /** Adapter-command discriminator. */
  kind: 'apply-operation-requested'
  /** Exact persisted plan entry whose membership must be condition-checked. */
  plannedOperation: WorkspaceSearchPlannedOperation
  /**
   * Immutable preimage bytes and reference for a target mutation. This is
   * absent only when the planned before and after snapshots are identical.
   */
  journal?: {
    /** Exact immutable preimage segment uploaded before the transaction. */
    segment: WorkspaceSearchJournalSegment
    /** Exact immutable object version containing the segment bytes. */
    reference: WorkspaceSearchJournalReference
  }
}

/** Caller payload for one reverse command before adapter authority is read. */
export type WorkspaceSearchRollbackOperationCommandEvent = {
  /** Adapter-command discriminator. */
  kind: 'rollback-operation-requested'
  /** Exact durable forward receipt at the current reverse sequence. */
  applyReceipt: WorkspaceSearchOperationReceipt
  /** Exact immutable preimage segment referenced by the forward receipt. */
  journalSegment: WorkspaceSearchJournalSegment
}

/** Completes rollback after the journal chain reaches its zero root. */
export type WorkspaceSearchRollbackFinishedEvent = {
  /** State-machine event discriminator. */
  kind: 'rollback-finished'
}

/** Every supported durable migration lifecycle transition. */
export type WorkspaceSearchMigrationStateEvent =
  | WorkspaceSearchApplyCheckpointRecordedEvent
  | WorkspaceSearchApplyOperationRecordedEvent
  | WorkspaceSearchApplySealedEvent
  | WorkspaceSearchMaintenanceEvidenceRenewedEvent
  | WorkspaceSearchRollbackFinishedEvent
  | WorkspaceSearchRollbackOperationRecordedEvent
  | WorkspaceSearchRollbackStartedEvent
  | WorkspaceSearchVerificationCheckpointRecordedEvent
  | WorkspaceSearchVerificationPassedEvent
  | WorkspaceSearchVerificationStartedEvent

/** State events callers may request without supplying adapter-owned evidence. */
export type WorkspaceSearchMigrationDirectStateEvent = Exclude<
  WorkspaceSearchMigrationStateEvent,
  | WorkspaceSearchApplyCheckpointRecordedEvent
  | WorkspaceSearchApplyOperationRecordedEvent
  | WorkspaceSearchMaintenanceEvidenceRenewedEvent
  | WorkspaceSearchRollbackOperationRecordedEvent
  | WorkspaceSearchVerificationCheckpointRecordedEvent
>

/** Every event accepted at the persistence adapter command boundary. */
export type WorkspaceSearchMigrationCommandEvent =
  | WorkspaceSearchApplyOperationCommandEvent
  | WorkspaceSearchMigrationDirectStateEvent
  | WorkspaceSearchMaintenanceEvidenceRenewalCommandEvent
  | WorkspaceSearchRollbackOperationCommandEvent

/** One optimistic, fenced transition from a previously validated run state. */
export type WorkspaceSearchMigrationTransitionInput<
  Event extends WorkspaceSearchMigrationStateEvent =
    WorkspaceSearchMigrationStateEvent,
> = {
  /** Exact current durable state read before the transition. */
  current: WorkspaceSearchMigrationRunState
  /** Revision that persistence must compare atomically. */
  expectedRevision: number
  /** Active lease and trusted transition time. */
  authority: WorkspaceSearchMigrationAuthority
  /** Exact lifecycle event to apply. */
  event: Event
}

/** Request to acquire or take over an expired migration lease. */
export type AcquireWorkspaceSearchMigrationLeaseInput = {
  /** Operator-selected run identifier. */
  runId: string
  /** Operator-selected owner identifier. */
  ownerId: string
}

/** Request to extend one exact active migration lease. */
export type HeartbeatWorkspaceSearchMigrationLeaseInput = {
  /** Exact lease identity and fence token being extended. */
  lease: WorkspaceSearchMigrationLeaseClaim
}

/** Atomic creation request for a run whose immutable plan is already sealed. */
export type PersistWorkspaceSearchMigrationRunInput = {
  /** Operator-selected run identifier. */
  runId: string
  /** Exact active lease identity expected at adapter-owned commit time. */
  lease: WorkspaceSearchMigrationLeaseClaim
  /** Reviewed configuration digest. */
  configurationHash: string
  /** Exact measured migration configuration. */
  configuration: WorkspaceSearchMigrationConfiguration
  /** Exact untrusted maintenance-evidence file bytes. */
  maintenanceEvidenceBytes: Uint8Array
  /** Digest of the exact reviewed dry-run evidence bytes. */
  dryRunEvidenceDigest: string
  /** Digest of the immutable sealed operation plan. */
  planDigest: string
  /** Exact number of entries in the immutable sealed plan. */
  planOperationCount: number
  /** Exact immutable plan-seal document reviewed before run creation. */
  planSeal: WorkspaceSearchPlanSeal
  /** Immutable object version that stores the exact plan-seal bytes. */
  planSealReference: WorkspaceSearchPlanSealReference
}

/**
 * Adapter command that excludes caller-supplied state and commit time.
 *
 * The adapter must strongly read the durable state for `expectedRevision`
 * immediately before reducing the event.
 */
export type WorkspaceSearchMigrationCommandInput<
  Event extends WorkspaceSearchMigrationCommandEvent =
    WorkspaceSearchMigrationCommandEvent,
> = {
  /** Revision that persistence must compare atomically. */
  expectedRevision: number
  /** Exact active lease identity expected by the command. */
  lease: WorkspaceSearchMigrationLeaseClaim
  /** Exact state event or adapter-bound operation request to commit. */
  event: Event
}

/** Adapter-owned request to scan and persist one bounded checkpoint page. */
export type WorkspaceSearchMigrationCheckpointCommandInput = {
  /** Revision that persistence must compare atomically. */
  expectedRevision: number
  /** Exact active lease identity expected by the command. */
  lease: WorkspaceSearchMigrationLeaseClaim
  /** Source or target table whose next page the adapter must strongly scan. */
  location: WorkspaceSearchMigrationCheckpointLocation
}

/**
 * Persistence boundary for the Workspace Search migration state machine.
 *
 * Implementations must use condition-aware, strongly consistent operations.
 * No method permits an unrestricted state replacement. Every target mutation,
 * marker, receipt, and run revision change must commit in one atomic transaction.
 * Every command strongly re-reads the durable state instead of accepting a
 * caller-owned state object. Initial and renewed maintenance evidence is parsed
 * from exact bytes inside this boundary, and checkpoint methods derive progress
 * only from pages read by the adapter itself.
 * The adapter, not the command caller, owns the trusted clock. It captures time
 * after prerequisite reads/uploads immediately before the transaction, requires
 * the minimum deadline headroom, and configures request timeout below that margin.
 */
export interface WorkspaceSearchMigrationStateMachinePort {
  /**
   * Acquires an absent lease or takes over an expired lease with a strictly
   * increasing fence token. The adapter sets heartbeat and expiry from its own
   * clock and the fixed lease duration.
   *
   * @param input - Run and owner requested by the operator.
   * @returns Exact durable lease after acquisition.
   */
  acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease>

  /**
   * Extends only the exact unexpired run, owner, fence, and previous expiry,
   * using the adapter clock and fixed lease duration.
   *
   * @param input - Exact current lease identity.
   * @returns Exact durable lease after the heartbeat.
   */
  heartbeatLease(
    input: HeartbeatWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease>

  /**
   * Reads one run with strong consistency.
   *
   * @param runId - Operator-selected run identifier.
   * @returns Current run or undefined when it does not exist.
   */
  readRunState(
    runId: string,
  ): Promise<WorkspaceSearchMigrationRunState | undefined>

  /**
   * Strongly reads one immutable historical maintenance-evidence receipt.
   *
   * Initial run creation and every renewal must write the exact receipt under
   * its digest with an absent-row condition before updating the current pointer.
   *
   * @param runId - Run that owns the immutable receipt.
   * @param receiptDigest - Digest referenced by operation or rollback markers.
   * @returns Exact historical receipt or undefined when audit evidence is missing.
   */
  readMaintenanceEvidenceReceipt(
    runId: string,
    receiptDigest: string,
  ): Promise<WorkspaceSearchMaintenanceEvidenceReceipt | undefined>

  /**
   * Validates exact evidence bytes at the adapter clock, constructs the
   * canonical initial state, and creates it with its immutable receipt only
   * when the plan seal is durable, the run row is absent, and the lease is
   * current.
   *
   * @param input - Sealed plan, exact evidence bytes, and active authority.
   * @returns Exact durable initial run state.
   */
  createRunState(
    input: PersistWorkspaceSearchMigrationRunInput,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Reads and validates the exact immutable plan-seal object version.
   *
   * @param reference - Exact immutable S3 plan-seal reference.
   * @returns Canonical reviewed plan seal.
   */
  readPlanSeal(
    reference: WorkspaceSearchPlanSealReference,
  ): Promise<WorkspaceSearchPlanSeal>

  /**
   * Reads and validates one exact immutable verification-evidence version.
   *
   * @param reference - Exact immutable S3 verification-evidence reference.
   * @returns Canonical complete verification evidence.
   */
  readVerificationEvidence(
    reference: WorkspaceSearchVerificationEvidenceReference,
  ): Promise<WorkspaceSearchVerificationEvidence>

  /**
   * Strongly reads one exact immutable plan entry.
   *
   * @param runId - Run that owns the sealed plan.
   * @param planSequence - One-based plan position.
   * @returns Planned operation or undefined when the plan is incomplete.
   */
  readPlannedOperation(
    runId: string,
    planSequence: number,
  ): Promise<WorkspaceSearchPlannedOperation | undefined>

  /**
   * Strongly reads an operation marker before stale-revision reconciliation.
   *
   * @param runId - Run that owns the marker.
   * @param operationId - Stable operation identifier.
   * @returns Exact marker or undefined when the operation did not commit.
   */
  readOperationMarker(
    runId: string,
    operationId: string,
  ): Promise<WorkspaceSearchOperationMarker | undefined>

  /**
   * Strongly reads one mutation receipt by forward journal sequence.
   *
   * @param runId - Run that owns the apply receipt.
   * @param sequence - Positive mutation sequence.
   * @returns Exact receipt or undefined when the chain is incomplete.
   */
  readApplyReceipt(
    runId: string,
    sequence: number,
  ): Promise<WorkspaceSearchOperationReceipt | undefined>

  /**
   * Strongly reads one reverse marker before response-loss reconciliation.
   *
   * @param runId - Run that owns the rollback receipt.
   * @param sequence - Positive reverse journal sequence.
   * @returns Exact rollback receipt or undefined when restoration did not commit.
   */
  readRollbackReceipt(
    runId: string,
    sequence: number,
  ): Promise<WorkspaceSearchRollbackReceipt | undefined>

  /**
   * Atomically condition-checks the immutable plan entry, exact source state,
   * exact target state, absent marker, run revision, lease, fence, and fresh
   * evidence before writing the target, marker, and next run state.
   *
   * After reading live authority, the adapter must call
   * `createWorkspaceSearchApplyOperationRecordedEvent` to bind its own clock,
   * fence, and current evidence to the durable marker. A mutation additionally
   * requires the supplied immutable journal segment to exist before this
   * transaction. An already-current marker is valid only when the sealed
   * operation's before and after states are equal.
   *
   * @param input - Exact fenced apply transition.
   * @returns Next durable run state.
   */
  commitApplyOperation(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchApplyOperationCommandEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Strongly scans the next bounded apply page, derives its checkpoint inside
   * the adapter, and atomically saves it under the exact run revision, lease,
   * fence, and fresh evidence tuple.
   *
   * @param input - Exact revision, authority, and scan location.
   * @returns Next durable run state.
   */
  saveApplyCheckpoint(
    input: WorkspaceSearchMigrationCheckpointCommandInput,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Strictly validates exact evidence bytes at the adapter-owned clock,
   * atomically writes the resulting receipt to an immutable digest-keyed row,
   * and replaces current evidence while the exact lease is still active. The
   * previous evidence may already be expired because this method does not
   * mutate application data.
   *
   * @param input - Exact evidence bytes, revision, and active authority.
   * @returns Next durable run state.
   */
  renewMaintenanceEvidence(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchMaintenanceEvidenceRenewalCommandEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Atomically attaches a complete-plan apply seal and advances to applied.
   *
   * @param input - Exact complete-plan seal transition.
   * @returns Next durable run state.
   */
  sealApply(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchApplySealedEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Atomically starts a brand-new independent verification traversal.
   *
   * @param input - Exact verification-start transition.
   * @returns Next durable run state.
   */
  beginVerification(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchVerificationStartedEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Strongly scans the next bounded verification page, derives its checkpoint
   * inside the adapter, and atomically saves it under current authority.
   *
   * @param input - Exact revision, authority, and scan location.
   * @returns Next durable run state.
   */
  saveVerificationCheckpoint(
    input: WorkspaceSearchMigrationCheckpointCommandInput,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Atomically records independently persisted complete verification evidence.
   *
   * @param input - Exact verification-pass transition.
   * @returns Next durable run state.
   */
  completeVerification(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchVerificationPassedEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Atomically begins reverse rollback after re-reading and validating the
   * supplied canonical complete-plan or committed-prefix seal.
   *
   * @param input - Exact rollback-start transition.
   * @returns Next durable run state.
   */
  beginRollback(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchRollbackStartedEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Atomically validates the next reverse receipt and immutable journal bytes,
   * condition-checks the exact post-apply target, restores the exact preimage,
   * writes the rollback marker, and advances the reverse chain.
   *
   * After reading live authority, the adapter must call
   * `createWorkspaceSearchRollbackOperationRecordedEvent` so the rollback
   * receipt is bound to the adapter clock, current fence, and current evidence.
   *
   * @param input - Exact reverse operation transition.
   * @returns Next durable run state.
   */
  commitRollbackOperation(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchRollbackOperationCommandEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState>

  /**
   * Atomically marks rollback complete only at the zero journal root.
   *
   * @param input - Exact rollback-finish transition.
   * @returns Next durable run state.
   */
  finishRollback(
    input: WorkspaceSearchMigrationCommandInput<
      WorkspaceSearchRollbackFinishedEvent
    >,
  ): Promise<WorkspaceSearchMigrationRunState>
}

/**
 * Strictly parses exact maintenance evidence bytes at the adapter clock and
 * binds the validated result to one run and active lease fence.
 *
 * The exclusive validity deadline is derived from the oldest drain/surface
 * observation rather than validation time. One millisecond is added because
 * the evidence parser accepts the exact maximum-age millisecond while atomic
 * persistence conditions use `commitTime < validUntil`.
 *
 * @param input - Exact evidence bytes, lease, run, and validation time.
 * @returns Fresh receipt whose deadline cannot outlive any source observation.
 */
export function createWorkspaceSearchMaintenanceEvidenceReceipt(
  input: CreateWorkspaceSearchMaintenanceEvidenceReceiptInput,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  requireMigrationIdentifier(input.runId, 'Run ID')
  requireCanonicalTime(input.validatedAt, 'evidence validation time')
  validateMigrationLease(input.lease)
  if (input.lease.runId !== input.runId) {
    return failLease('Maintenance evidence lease belongs to another run.')
  }

  let parsed: ParsedWorkspaceSearchMaintenanceEvidence
  try {
    parsed = parseMaintenanceEvidence(input.evidenceBytes, {
      now: new Date(input.validatedAt),
    })
  } catch (error: unknown) {
    if (error instanceof MaintenanceEvidenceError) {
      return failEvidence('Maintenance evidence bytes are invalid.')
    }
    throw error
  }
  return createMaintenanceEvidenceReceiptFromParsed(
    input.runId,
    input.lease,
    parsed,
    input.validatedAt,
  )
}

/**
 * Creates one receipt from evidence parsed inside the trusted adapter boundary.
 *
 * @param runId - Run whose lease consumes the evidence.
 * @param lease - Exact active lease bound to the receipt.
 * @param parsed - Strict parser result for the exact source bytes.
 * @param validatedAt - Adapter-owned canonical UTC validation time.
 * @returns Fresh receipt whose deadline cannot outlive any observation.
 */
function createMaintenanceEvidenceReceiptFromParsed(
  runId: string,
  lease: WorkspaceSearchMigrationLease,
  parsed: ParsedWorkspaceSearchMaintenanceEvidence,
  validatedAt: string,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  requireCanonicalTime(
    parsed.evidence.drainCompletedAt,
    'maintenance drain completion time',
  )
  let oldestObservationMilliseconds = Date.parse(
    parsed.evidence.drainCompletedAt,
  )
  for (const surface of parsed.evidence.surfaces) {
    requireCanonicalTime(
      surface.observedAt,
      'maintenance surface observation time',
    )
    const observedMilliseconds = Date.parse(surface.observedAt)
    if (observedMilliseconds < oldestObservationMilliseconds) {
      oldestObservationMilliseconds = observedMilliseconds
    }
  }
  const exclusiveDeadlineMilliseconds =
    oldestObservationMilliseconds +
    MAINTENANCE_EVIDENCE_MAX_AGE_SECONDS * 1_000 +
    1
  const receipt: WorkspaceSearchMaintenanceEvidenceReceipt = {
    runId,
    evidenceDigest: parsed.fileSha256,
    evidenceLocator: parsed.evidence.locator,
    runtimeRevision: parsed.evidence.runtimeRevision,
    fenceToken: lease.fenceToken,
    validatedAt,
    oldestObservationAt: new Date(oldestObservationMilliseconds).toISOString(),
    validUntil: new Date(exclusiveDeadlineMilliseconds).toISOString(),
  }
  validateMaintenanceEvidenceReceipt(
    receipt,
    runId,
    lease.fenceToken,
    validatedAt,
  )
  return receipt
}

/**
 * Builds the exact durable apply event after the adapter reads live authority.
 *
 * The command caller supplies immutable plan and journal evidence only. The
 * adapter supplies the trusted clock, current lease fence, and current evidence
 * binding immediately before the atomic transaction, so none can be predicted
 * or forged by an earlier caller.
 *
 * @param state - Exact current durable run read by the adapter.
 * @param authority - Live fenced authority captured by the adapter.
 * @param command - Caller payload containing plan and optional journal evidence.
 * @returns Exact internal event consumed by the pure reducer and transaction.
 */
export function createWorkspaceSearchApplyOperationRecordedEvent(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationAuthority,
  command: WorkspaceSearchApplyOperationCommandEvent,
): WorkspaceSearchApplyOperationRecordedEvent {
  const planned = command.plannedOperation
  const operation = planned.operation
  const sourceDigest = operation.sourceCondition.exists
    ? operation.sourceCondition.itemDigest
    : undefined
  const maintenanceEvidenceReceiptDigest = createMigrationDigest(
    state.maintenanceEvidenceReceipt,
  )

  if (operation.before.digest === operation.after.digest) {
    if (command.journal !== undefined) {
      return failState('A true plan no-op cannot carry a journal segment.')
    }
    return {
      kind: 'apply-operation-recorded',
      plannedOperation: planned,
      marker: {
        kind: 'workspace-search-operation-already-current',
        markerVersion: 1,
        runId: state.runId,
        configurationHash: state.configurationHash,
        operationId: operation.operationId,
        planSequence: planned.planSequence,
        planOperationDigest: planned.operationDigest,
        targetKeyDigest: operation.targetKeyDigest,
        sourceDigest,
        afterDigest: operation.after.digest,
        fenceToken: authority.lease.fenceToken,
        maintenanceEvidenceReceiptDigest,
        recordedAt: authority.at,
      },
    }
  }

  if (!command.journal) {
    return failState('A target mutation requires immutable journal evidence.')
  }
  return {
    kind: 'apply-operation-recorded',
    plannedOperation: planned,
    marker: {
      kind: 'workspace-search-operation-applied',
      markerVersion: 1,
      runId: state.runId,
      configurationHash: state.configurationHash,
      operationId: operation.operationId,
      planSequence: planned.planSequence,
      planOperationDigest: planned.operationDigest,
      sequence: state.journalSequence + 1,
      targetKeyDigest: operation.targetKeyDigest,
      sourceDigest,
      beforeDigest: operation.before.digest,
      afterDigest: operation.after.digest,
      fenceToken: authority.lease.fenceToken,
      maintenanceEvidenceReceiptDigest,
      journal: command.journal.reference,
      committedAt: authority.at,
    },
    journalSegment: command.journal.segment,
  }
}

/**
 * Builds the exact durable rollback event after adapter authority is captured.
 *
 * @param state - Exact current rolling-back run read by the adapter.
 * @param authority - Live fenced authority captured by the adapter.
 * @param command - Caller-supplied immutable apply and journal evidence.
 * @returns Exact internal rollback event consumed atomically by the adapter.
 */
export function createWorkspaceSearchRollbackOperationRecordedEvent(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationAuthority,
  command: WorkspaceSearchRollbackOperationCommandEvent,
): WorkspaceSearchRollbackOperationRecordedEvent {
  const progress = state.rollback
  if (!progress) {
    return failState('Rollback command requires active reverse progress.')
  }
  const applyReceipt = command.applyReceipt
  const segment = command.journalSegment
  return {
    kind: 'rollback-operation-recorded',
    applyReceipt,
    journalSegment: segment,
    receipt: {
      kind: 'workspace-search-operation-rolled-back',
      markerVersion: 1,
      runId: state.runId,
      configurationHash: state.configurationHash,
      operationId: applyReceipt.operationId,
      sequence: progress.nextSequence,
      applyReceiptDigest: createMigrationDigest(applyReceipt),
      targetKeyDigest: segment.targetKeyDigest,
      beforeDigest: segment.before.digest,
      afterDigest: segment.after.digest,
      journalHeadDigest: progress.expectedHeadDigest,
      fenceToken: authority.lease.fenceToken,
      maintenanceEvidenceReceiptDigest: createMigrationDigest(
        state.maintenanceEvidenceReceipt,
      ),
      rolledBackAt: authority.at,
    },
  }
}

/**
 * Creates the Merkle leaf digest for one ordered exact plan operation.
 *
 * @param input - One-based position and exact encoded operation digest.
 * @returns Canonical plan leaf digest.
 */
export function createWorkspaceSearchPlanLeafDigest(input: {
  /** One-based stable operation position. */
  planSequence: number
  /** Digest of the exact losslessly encoded operation. */
  operationDigest: string
}): string {
  requirePositiveSafeInteger(input.planSequence, 'plan sequence')
  requireDigest(input.operationDigest, 'planned operation digest')
  return createMigrationDigest({
    kind: 'workspace-search-plan-leaf',
    leafVersion: 1,
    planSequence: input.planSequence,
    operationDigest: input.operationDigest,
  })
}

/**
 * Creates the canonical root digest for an empty reviewed operation plan.
 *
 * @returns Stable empty-plan digest.
 */
export function createEmptyWorkspaceSearchPlanDigest(): string {
  return createMigrationDigest({
    kind: 'workspace-search-empty-plan',
    planVersion: 1,
  })
}

/**
 * Creates the exact durable digest of one native planned operation.
 *
 * Attribute maps are losslessly encoded so binary values and DynamoDB number
 * spellings remain part of the sealed-plan identity.
 *
 * @param operation - Exact present/absent source condition and target transition.
 * @returns Lowercase SHA-256 digest of the canonical encoded operation.
 */
export function createWorkspaceSearchMigrationOperationDigest(
  operation: WorkspaceSearchMigrationOperation,
): string {
  requireExactObjectKeys(operation, [
    'after',
    'before',
    'entityType',
    'operationId',
    'sourceCondition',
    'targetKey',
    'targetKeyDigest',
  ], 'planned operation')
  requireDigest(operation.operationId, 'operation ID')
  validateSourceCondition(operation)
  validateTargetOperation(operation)
  validateDeterministicSourceProjection(operation)

  return createMigrationDigest({
    operationId: operation.operationId,
    sourceCondition: operation.sourceCondition.exists
      ? {
          exists: true,
          source: operation.sourceCondition.source,
          tableId: operation.sourceCondition.tableId,
          tableName: operation.sourceCondition.tableName,
          key: encodeAttributeMap(operation.sourceCondition.key),
          keyDigest: operation.sourceCondition.keyDigest,
          item: encodeAttributeMap(operation.sourceCondition.item),
          itemDigest: operation.sourceCondition.itemDigest,
        }
      : {
          exists: false,
          source: operation.sourceCondition.source,
          tableId: operation.sourceCondition.tableId,
          tableName: operation.sourceCondition.tableName,
          key: encodeAttributeMap(operation.sourceCondition.key),
          keyDigest: operation.sourceCondition.keyDigest,
        },
    targetKey: encodeAttributeMap(operation.targetKey),
    targetKeyDigest: operation.targetKeyDigest,
    before: encodeSnapshotForDigest(operation.before),
    after: encodeSnapshotForDigest(operation.after),
    entityType: operation.entityType,
  })
}

/**
 * Creates the canonical initial checkpoint before the first bounded page.
 *
 * @returns Empty incomplete checkpoint with restorable zero digest states.
 */
export function createEmptyWorkspaceSearchMigrationCheckpoint():
  MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  return {
    completed: false,
    aggregate: createEmptyMigrationScanAggregate(),
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
}

/**
 * Creates independent empty source and target traversal progress.
 *
 * @returns Canonical empty traversal for apply or verification.
 */
export function createEmptyWorkspaceSearchMigrationTraversal():
  WorkspaceSearchMigrationTraversalProgress {
  return {
    sources: {
      'project-directory': createEmptyWorkspaceSearchMigrationCheckpoint(),
      'work-items': createEmptyWorkspaceSearchMigrationCheckpoint(),
      collaboration: createEmptyWorkspaceSearchMigrationCheckpoint(),
      documents: createEmptyWorkspaceSearchMigrationCheckpoint(),
    },
    target: createEmptyWorkspaceSearchMigrationCheckpoint(),
  }
}

/**
 * Creates the first applying state from an already reviewed and sealed plan.
 *
 * Persistence must still atomically condition-check the exact sealed plan,
 * absent run row, active lease, and receipt tuple when storing this state.
 *
 * @param input - Reviewed configuration, plan, evidence, and active authority.
 * @returns Validated revision-one applying state.
 */
export function createWorkspaceSearchMigrationRunState(
  input: CreateWorkspaceSearchMigrationRunStateInput,
): WorkspaceSearchMigrationRunState {
  requireMigrationIdentifier(input.runId, 'Run ID')
  requireMigrationIdentifier(input.ownerId, 'Owner ID')
  requireDigest(input.configurationHash, 'configuration hash')
  if (
    createWorkspaceSearchConfigurationHash(input.configuration) !==
      input.configurationHash
  ) {
    return failState('Migration configuration hash does not match the run.')
  }
  requireDigest(input.dryRunEvidenceDigest, 'dry-run evidence digest')
  requireDigest(input.planDigest, 'plan digest')
  requireNonNegativeSafeInteger(
    input.planOperationCount,
    'plan operation count',
  )
  requireCanonicalTime(input.createdAt, 'run creation time')
  validatePlanSeal(
    input.planSeal,
    input.planSealReference,
    input.runId,
    input.configurationHash,
    input.dryRunEvidenceDigest,
    input.planDigest,
    input.planOperationCount,
    input.createdAt,
  )

  const authority: WorkspaceSearchMigrationAuthority = {
    lease: input.lease,
    ownerId: input.ownerId,
    at: input.createdAt,
  }
  assertWorkspaceSearchMigrationLeaseAuthority(input.runId, authority)
  validateMaintenanceEvidenceReceipt(
    input.maintenanceEvidenceReceipt,
    input.runId,
    input.lease.fenceToken,
    input.createdAt,
  )

  const markerAccumulator = new MigrationDigestAccumulator()
  const state: WorkspaceSearchMigrationRunState = {
    runId: input.runId,
    revision: 1,
    configurationHash: input.configurationHash,
    configuration: input.configuration,
    maintenanceEvidenceDigest:
      input.maintenanceEvidenceReceipt.evidenceDigest,
    maintenanceEvidenceLocator:
      input.maintenanceEvidenceReceipt.evidenceLocator,
    maintenanceEvidenceReceipt: input.maintenanceEvidenceReceipt,
    dryRunEvidenceDigest: input.dryRunEvidenceDigest,
    planDigest: input.planDigest,
    planOperationCount: input.planOperationCount,
    planSealReference: input.planSealReference,
    status: 'applying',
    appliedOperationCount: 0,
    applyMarkerDigestState: markerAccumulator.exportState(),
    journalSequence: 0,
    journalHeadDigest: zeroHexDigest(),
    apply: createEmptyWorkspaceSearchMigrationTraversal(),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  }
  validateWorkspaceSearchMigrationRunState(state)
  return state
}

/**
 * Validates one checkpoint and its optional monotonic predecessor.
 *
 * @param checkpoint - Candidate cumulative checkpoint.
 * @param previous - Previously committed checkpoint, when advancing a scan.
 */
export function validateWorkspaceSearchMigrationCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
  previous?: MigrationSourceCheckpoint,
): void {
  const counters = checkpoint.aggregate
  requireNonNegativeSafeInteger(counters.scanned, 'checkpoint scanned count')
  requireNonNegativeSafeInteger(counters.mapped, 'checkpoint mapped count')
  requireNonNegativeSafeInteger(counters.ignored, 'checkpoint ignored count')
  requireNonNegativeSafeInteger(counters.invalid, 'checkpoint invalid count')
  requireNonNegativeSafeInteger(counters.projected, 'checkpoint projected count')
  requireNonNegativeSafeInteger(counters.deleted, 'checkpoint deleted count')
  requireNonNegativeSafeInteger(counters.pageCount, 'checkpoint page count')

  if (
    counters.mapped + counters.ignored + counters.invalid !==
      counters.scanned
  ) {
    return failState('Checkpoint row classifications do not match scanned count.')
  }
  if (counters.projected + counters.deleted !== counters.mapped) {
    return failState('Checkpoint target outcomes do not match mapped count.')
  }

  const keyAccumulator = MigrationDigestAccumulator.fromState(
    checkpoint.keyDigestState,
  )
  const contentAccumulator = MigrationDigestAccumulator.fromState(
    checkpoint.contentDigestState,
  )
  if (
    keyAccumulator.size() !== counters.scanned ||
    contentAccumulator.size() !== counters.scanned ||
    keyAccumulator.digest() !== counters.keyDigest ||
    contentAccumulator.digest() !== counters.contentDigest
  ) {
    return failState('Checkpoint aggregate digest state is inconsistent.')
  }

  if (checkpoint.cursor !== undefined) {
    encodeAttributeMap(checkpoint.cursor)
  }
  if (checkpoint.completed && checkpoint.cursor !== undefined) {
    return failState('A completed checkpoint must not retain a cursor.')
  }
  if (
    !checkpoint.completed &&
    checkpoint.cursor === undefined &&
    !isCanonicalEmptyCheckpoint(checkpoint)
  ) {
    return failState(
      'Only the canonical initial checkpoint may be incomplete without a cursor.',
    )
  }

  if (previous === undefined) return
  validateWorkspaceSearchMigrationCheckpoint(previous)
  requireMonotonicCheckpoint(checkpoint, previous)
}

/**
 * Validates every durable run-state invariant independent of wall-clock freshness.
 *
 * @param state - Candidate run state read from durable storage.
 */
export function validateWorkspaceSearchMigrationRunState(
  state: WorkspaceSearchMigrationRunState,
): void {
  requireMigrationIdentifier(state.runId, 'Run ID')
  requirePositiveSafeInteger(state.revision, 'run revision')
  requireDigest(state.configurationHash, 'configuration hash')
  if (
    createWorkspaceSearchConfigurationHash(state.configuration) !==
      state.configurationHash
  ) {
    return failState('Migration configuration hash does not match durable state.')
  }
  requireDigest(
    state.maintenanceEvidenceDigest,
    'maintenance evidence digest',
  )
  requireNonEmptyText(
    state.maintenanceEvidenceLocator,
    'maintenance evidence locator',
  )
  validateMaintenanceEvidenceReceipt(
    state.maintenanceEvidenceReceipt,
    state.runId,
  )
  if (
    state.maintenanceEvidenceDigest !==
      state.maintenanceEvidenceReceipt.evidenceDigest ||
    state.maintenanceEvidenceLocator !==
      state.maintenanceEvidenceReceipt.evidenceLocator
  ) {
    return failState(
      'Current maintenance evidence fields do not match their receipt.',
    )
  }
  requireDigest(state.dryRunEvidenceDigest, 'dry-run evidence digest')
  requireDigest(state.planDigest, 'plan digest')
  requireNonNegativeSafeInteger(
    state.planOperationCount,
    'plan operation count',
  )
  validatePlanSealReference(state.planSealReference)
  if (
    (state.planOperationCount === 0) !==
      (state.planDigest === createEmptyWorkspaceSearchPlanDigest())
  ) {
    return failState('Migration plan count does not match its canonical root.')
  }
  requireNonNegativeSafeInteger(
    state.appliedOperationCount,
    'applied operation count',
  )
  if (state.appliedOperationCount > state.planOperationCount) {
    return failState('Applied operation count exceeds the sealed plan.')
  }

  const markerAccumulator = MigrationDigestAccumulator.fromState(
    state.applyMarkerDigestState,
  )
  if (markerAccumulator.size() !== state.appliedOperationCount) {
    return failState('Apply marker digest count does not match run progress.')
  }
  requireNonNegativeSafeInteger(state.journalSequence, 'journal sequence')
  if (state.journalSequence > state.appliedOperationCount) {
    return failState('Journal sequence exceeds applied operation count.')
  }
  requireDigest(state.journalHeadDigest, 'journal head digest')
  if (
    (state.journalSequence === 0) !==
      (state.journalHeadDigest === zeroHexDigest())
  ) {
    return failState('Journal sequence and chain head disagree.')
  }

  validateWorkspaceSearchMigrationTraversal(state.apply, state.configuration)
  if (
    state.appliedOperationCount < state.planOperationCount &&
    !isCanonicalEmptyTraversal(state.apply)
  ) {
    return failState(
      'Apply traversal advanced before every planned operation was durable.',
    )
  }
  if (state.verification !== undefined) {
    validateWorkspaceSearchMigrationTraversal(
      state.verification,
      state.configuration,
    )
  }
  validateApplySealReference(state.applySeal)
  validateRollbackProgress(state)

  requireCanonicalTime(state.createdAt, 'run creation time')
  requireCanonicalTime(state.updatedAt, 'run update time')
  if (Date.parse(state.createdAt) > Date.parse(state.updatedAt)) {
    return failState('Run update time precedes creation time.')
  }
  if (
    Date.parse(state.maintenanceEvidenceReceipt.validatedAt) >
      Date.parse(state.updatedAt)
  ) {
    return failState('Maintenance evidence was validated after durable state.')
  }

  validateLifecycleShape(state)
}

/**
 * Validates the exact active lease without requiring fresh maintenance evidence.
 *
 * This is the authority used only by evidence renewal and initial run creation.
 *
 * @param runId - Run that must own the lease.
 * @param authority - Exact owner, fence, and trusted time.
 */
export function assertWorkspaceSearchMigrationLeaseAuthority(
  runId: string,
  authority: WorkspaceSearchMigrationAuthority,
): void {
  requireMigrationIdentifier(runId, 'Run ID')
  requireMigrationIdentifier(authority.ownerId, 'Owner ID')
  validateMigrationLease(authority.lease)
  requireCanonicalTime(authority.at, 'authority time')

  if (
    authority.lease.runId !== runId ||
    authority.lease.ownerId !== authority.ownerId
  ) {
    return failLease('Migration lease identity no longer matches.')
  }
  const at = Date.parse(authority.at)
  if (
    Date.parse(authority.lease.heartbeatAt) > at ||
    at + WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS >=
      Date.parse(authority.lease.expiresAt)
  ) {
    return failLease('Migration lease lacks the required atomic commit window.')
  }
}

/**
 * Validates the durable shape of one active or historical migration lease.
 *
 * This public boundary lets persistence adapters reject malformed stored rows
 * before they evaluate expiry or construct a new fenced successor.
 *
 * @param lease - Candidate durable lease.
 */
export function validateWorkspaceSearchMigrationLease(
  lease: WorkspaceSearchMigrationLease,
): void {
  validateMigrationLease(lease)
}

/**
 * Validates one durable maintenance-evidence receipt and optional authority.
 *
 * Persistence adapters use this boundary for strict row parsing, historical
 * receipt reads, and current commit-time freshness checks without duplicating
 * the state-machine's window rules.
 *
 * @param receipt - Candidate durable receipt.
 * @param runId - Run that must own the receipt.
 * @param fenceToken - Optional current lease fence.
 * @param at - Optional trusted time requiring the minimum commit headroom.
 */
export function validateWorkspaceSearchMaintenanceEvidenceReceipt(
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  runId: string,
  fenceToken?: number,
  at?: string,
): void {
  validateMaintenanceEvidenceReceipt(receipt, runId, fenceToken, at)
}

/**
 * Validates the exact active lease and current fresh evidence for a mutation.
 *
 * @param state - Current run whose receipt must remain unchanged.
 * @param authority - Exact owner, fence, and trusted commit time.
 */
export function assertWorkspaceSearchMigrationMutationAuthority(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationAuthority,
): void {
  assertWorkspaceSearchMigrationLeaseAuthority(state.runId, authority)
  validateMaintenanceEvidenceReceipt(
    state.maintenanceEvidenceReceipt,
    state.runId,
    authority.lease.fenceToken,
    authority.at,
  )
}

/**
 * Applies one pure optimistic state transition after validating all invariants.
 *
 * Persistence remains responsible for evaluating the same run, plan, lease,
 * evidence, source, target, and marker conditions against live durable rows
 * before atomically storing the returned state.
 *
 * @param input - Current state, expected revision, authority, and exact event.
 * @returns Validated next state with revision incremented exactly once.
 */
export function reduceWorkspaceSearchMigrationRunState(
  input: WorkspaceSearchMigrationTransitionInput,
): WorkspaceSearchMigrationRunState {
  validateWorkspaceSearchMigrationRunState(input.current)
  requirePositiveSafeInteger(input.expectedRevision, 'expected run revision')
  if (input.current.revision !== input.expectedRevision) {
    return failState('Migration run revision changed before the transition.')
  }
  requireCanonicalTime(input.authority.at, 'transition time')
  if (
    Date.parse(input.authority.at) < Date.parse(input.current.updatedAt)
  ) {
    return failState('Migration transition time precedes durable state.')
  }

  let evolved: WorkspaceSearchMigrationRunState
  if (input.event.kind === 'maintenance-evidence-renewed') {
    assertWorkspaceSearchMigrationLeaseAuthority(
      input.current.runId,
      input.authority,
    )
    evolved = renewMaintenanceEvidence(
      input.current,
      input.authority,
      input.event,
    )
  } else {
    assertWorkspaceSearchMigrationMutationAuthority(
      input.current,
      input.authority,
    )
    evolved = applyAuthorizedEvent(input)
  }

  if (input.current.revision === Number.MAX_SAFE_INTEGER) {
    return failState('Migration run revision exceeds the safe integer range.')
  }
  const next: WorkspaceSearchMigrationRunState = {
    ...evolved,
    revision: input.current.revision + 1,
    updatedAt: input.authority.at,
  }
  validateWorkspaceSearchMigrationRunState(next)
  return next
}

/**
 * Applies one event that requires both lease and fresh-evidence authority.
 *
 * @param input - Already-authorized state transition.
 * @returns Evolved state before revision and timestamp advancement.
 */
function applyAuthorizedEvent(
  input: WorkspaceSearchMigrationTransitionInput,
): WorkspaceSearchMigrationRunState {
  const event = input.event
  if (event.kind === 'apply-operation-recorded') {
    return recordApplyOperation(input.current, input.authority, event)
  }
  if (event.kind === 'apply-checkpoint-recorded') {
    return recordApplyCheckpoint(input.current, event)
  }
  if (event.kind === 'apply-sealed') {
    return sealAppliedPlan(input.current, input.authority.at, event)
  }
  if (event.kind === 'verification-started') {
    return startVerification(input.current)
  }
  if (event.kind === 'verification-checkpoint-recorded') {
    return recordVerificationCheckpoint(input.current, event)
  }
  if (event.kind === 'verification-passed') {
    return passVerification(input.current, input.authority.at, event)
  }
  if (event.kind === 'rollback-started') {
    return startRollback(input.current, input.authority.at, event)
  }
  if (event.kind === 'rollback-operation-recorded') {
    return recordRollbackOperation(input.current, input.authority, event)
  }
  if (event.kind === 'rollback-finished') {
    return finishRollback(input.current)
  }
  if (event.kind === 'maintenance-evidence-renewed') {
    return failState('Maintenance evidence renewal used the wrong authority path.')
  }
  return failUnsupportedMigrationStateEvent(event)
}

/**
 * Preserves compile-time exhaustiveness for migration state events.
 *
 * @param event - Event variant omitted from the transition dispatcher.
 */
function failUnsupportedMigrationStateEvent(_event: never): never {
  return failState('Migration transition received an unsupported event.')
}

/**
 * Replaces all duplicated current-evidence fields atomically.
 *
 * @param input - Lease-authorized evidence-renewal transition.
 * @returns State with one new current evidence receipt.
 */
function renewMaintenanceEvidence(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationAuthority,
  event: WorkspaceSearchMaintenanceEvidenceRenewedEvent,
): WorkspaceSearchMigrationRunState {
  if (state.status === 'rolled-back') {
    return failState('Terminal rolled-back state cannot renew evidence.')
  }
  validateMaintenanceEvidenceReceipt(
    event.receipt,
    state.runId,
    authority.lease.fenceToken,
    authority.at,
  )
  return {
    ...state,
    maintenanceEvidenceDigest: event.receipt.evidenceDigest,
    maintenanceEvidenceLocator: event.receipt.evidenceLocator,
    maintenanceEvidenceReceipt: event.receipt,
  }
}

/**
 * Records one no-op or mutating marker from the exact sealed plan.
 *
 * @param state - Current applying state.
 * @param authority - Current fenced authority.
 * @param event - Plan entry, marker, and optional journal segment.
 * @returns State with one additional marker and optional journal link.
 */
function recordApplyOperation(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationAuthority,
  event: WorkspaceSearchApplyOperationRecordedEvent,
): WorkspaceSearchMigrationRunState {
  requireStatus(state, 'applying')
  validatePlannedOperation(state, event.plannedOperation)
  validateApplyMarker(
    state,
    authority,
    event.plannedOperation,
    event.marker,
    event.journalSegment,
  )
  if (state.appliedOperationCount === Number.MAX_SAFE_INTEGER) {
    return failState('Applied operation count exceeds the safe integer range.')
  }

  const markerAccumulator = MigrationDigestAccumulator.fromState(
    state.applyMarkerDigestState,
  )
  markerAccumulator.add(createMigrationDigest(event.marker))

  if (event.marker.kind === 'workspace-search-operation-applied') {
    return {
      ...state,
      appliedOperationCount: state.appliedOperationCount + 1,
      applyMarkerDigestState: markerAccumulator.exportState(),
      journalSequence: event.marker.sequence,
      journalHeadDigest: event.marker.journal.headDigest,
    }
  }
  return {
    ...state,
    appliedOperationCount: state.appliedOperationCount + 1,
    applyMarkerDigestState: markerAccumulator.exportState(),
  }
}

/**
 * Saves one monotonic apply traversal checkpoint.
 *
 * @param state - Current applying state.
 * @param event - Traversal location and cumulative checkpoint.
 * @returns State with the selected apply checkpoint replaced.
 */
function recordApplyCheckpoint(
  state: WorkspaceSearchMigrationRunState,
  event: WorkspaceSearchApplyCheckpointRecordedEvent,
): WorkspaceSearchMigrationRunState {
  requireStatus(state, 'applying')
  if (state.appliedOperationCount !== state.planOperationCount) {
    return failState(
      'Apply traversal cannot begin before every planned operation is durable.',
    )
  }
  return {
    ...state,
    apply: replaceTraversalCheckpoint(
      state.apply,
      event.location,
      event.checkpoint,
      state.configuration,
    ),
  }
}

/**
 * Attaches the exact complete-plan seal after all apply work is durable.
 *
 * @param state - Current applying state.
 * @param at - Trusted transition time.
 * @param event - Canonical seal and immutable reference.
 * @returns Applied state ready for verification or rollback.
 */
function sealAppliedPlan(
  state: WorkspaceSearchMigrationRunState,
  at: string,
  event: WorkspaceSearchApplySealedEvent,
): WorkspaceSearchMigrationRunState {
  requireStatus(state, 'applying')
  if (
    state.appliedOperationCount !== state.planOperationCount ||
    !isCompletedCleanTraversal(state.apply)
  ) {
    return failState('Apply cannot seal before the complete clean plan finishes.')
  }
  validateApplySeal(
    state,
    event.seal,
    event.reference,
    at,
    'complete-plan',
    'attaching',
  )
  return {
    ...state,
    status: 'applied',
    applySeal: event.reference,
  }
}

/**
 * Starts verification with fresh checkpoints independent from apply.
 *
 * @param state - Complete applied state.
 * @returns Verifying state with a canonical empty traversal.
 */
function startVerification(
  state: WorkspaceSearchMigrationRunState,
): WorkspaceSearchMigrationRunState {
  requireStatus(state, 'applied')
  return {
    ...state,
    status: 'verifying',
    verification: createEmptyWorkspaceSearchMigrationTraversal(),
  }
}

/**
 * Saves one monotonic verification traversal checkpoint.
 *
 * @param state - Current verifying state.
 * @param event - Traversal location and cumulative checkpoint.
 * @returns State with the selected verification checkpoint replaced.
 */
function recordVerificationCheckpoint(
  state: WorkspaceSearchMigrationRunState,
  event: WorkspaceSearchVerificationCheckpointRecordedEvent,
): WorkspaceSearchMigrationRunState {
  requireStatus(state, 'verifying')
  if (!state.verification) {
    return failState('Verifying state is missing independent checkpoints.')
  }
  return {
    ...state,
    verification: replaceTraversalCheckpoint(
      state.verification,
      event.location,
      event.checkpoint,
      state.configuration,
    ),
  }
}

/**
 * Marks independently persisted full verification evidence as successful.
 *
 * @param state - Current verifying state.
 * @param at - Trusted transition time.
 * @param event - Exact complete verification evidence and immutable reference.
 * @returns Verified state.
 */
function passVerification(
  state: WorkspaceSearchMigrationRunState,
  at: string,
  event: WorkspaceSearchVerificationPassedEvent,
): WorkspaceSearchMigrationRunState {
  requireStatus(state, 'verifying')
  if (
    !state.verification ||
    !isCompletedCleanTraversal(state.verification)
  ) {
    return failVerify('Verification cannot pass before every clean scan completes.')
  }
  validateVerificationEvidence(state, event.evidence, event.reference, at)
  return {
    ...state,
    status: 'verified',
    verificationEvidenceReference: event.reference,
  }
}

/**
 * Starts reverse rollback from a complete apply or a sealed partial prefix.
 *
 * @param state - Applying, applied, verifying, or verified state.
 * @param at - Trusted transition time.
 * @param event - Optional partial-prefix seal.
 * @returns Rolling-back state at the final committed mutation sequence.
 */
function startRollback(
  state: WorkspaceSearchMigrationRunState,
  at: string,
  event: WorkspaceSearchRollbackStartedEvent,
): WorkspaceSearchMigrationRunState {
  let applySeal = state.applySeal
  if (state.status === 'applying') {
    validateApplySeal(
      state,
      event.seal,
      event.reference,
      at,
      'committed-prefix',
      'attaching',
    )
    applySeal = event.reference
  } else {
    if (
      state.status !== 'applied' &&
      state.status !== 'verifying' &&
      state.status !== 'verified'
    ) {
      return failState('Rollback cannot start from the current lifecycle state.')
    }
    if (!applySeal || applySeal.scope !== 'complete-plan') {
      return failState('Rollback requires an existing complete-plan seal.')
    }
    validateApplySeal(
      state,
      event.seal,
      event.reference,
      at,
      'complete-plan',
      'revalidating',
    )
    if (
      serializeCanonicalJson(event.reference) !==
        serializeCanonicalJson(applySeal)
    ) {
      return failState('Rollback seal reference changed after apply sealing.')
    }
  }

  if (!applySeal) {
    return failState('Rollback is missing its immutable apply-chain seal.')
  }
  return {
    ...state,
    status: 'rolling-back',
    applySeal,
    rollback: {
      upperBoundSequence: state.journalSequence,
      nextSequence: state.journalSequence,
      expectedHeadDigest: state.journalHeadDigest,
      restored: 0,
    },
  }
}

/**
 * Consumes one exact apply-chain link and advances reverse progress.
 *
 * @param state - Current rolling-back state.
 * @param authority - Current fenced authority.
 * @param event - Apply receipt, journal bytes, and rollback receipt.
 * @returns State advanced to the preceding journal link.
 */
function recordRollbackOperation(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationAuthority,
  event: WorkspaceSearchRollbackOperationRecordedEvent,
): WorkspaceSearchMigrationRunState {
  requireStatus(state, 'rolling-back')
  const progress = state.rollback
  if (!progress || progress.nextSequence < 1) {
    return failState('Rollback has no remaining journal operation.')
  }
  validateRollbackReceipt(state, authority, progress, event)
  if (progress.restored === Number.MAX_SAFE_INTEGER) {
    return failState('Rollback restored count exceeds the safe integer range.')
  }

  return {
    ...state,
    rollback: {
      ...progress,
      nextSequence: progress.nextSequence - 1,
      expectedHeadDigest: event.journalSegment.previousHeadDigest,
      restored: progress.restored + 1,
    },
  }
}

/**
 * Completes rollback only after every reverse journal link was consumed.
 *
 * @param state - Current rolling-back state.
 * @returns Terminal rolled-back state.
 */
function finishRollback(
  state: WorkspaceSearchMigrationRunState,
): WorkspaceSearchMigrationRunState {
  requireStatus(state, 'rolling-back')
  if (
    !state.rollback ||
    state.rollback.nextSequence !== 0 ||
    state.rollback.restored !== state.rollback.upperBoundSequence ||
    state.rollback.expectedHeadDigest !== zeroHexDigest()
  ) {
    return failState('Rollback cannot finish before reaching the zero chain root.')
  }
  return {
    ...state,
    status: 'rolled-back',
  }
}

/**
 * Validates one exact sealed-plan entry against the current run.
 *
 * @param state - Current run owning the immutable plan.
 * @param planned - Exact persisted plan entry.
 */
function validatePlannedOperation(
  state: WorkspaceSearchMigrationRunState,
  planned: WorkspaceSearchPlannedOperation,
): void {
  if (
    planned.runId !== state.runId ||
    planned.configurationHash !== state.configurationHash ||
    planned.planDigest !== state.planDigest
  ) {
    return failState('Planned operation identity does not match the run.')
  }
  requirePositiveSafeInteger(planned.planSequence, 'plan sequence')
  if (planned.planSequence > state.planOperationCount) {
    return failState('Planned operation lies outside the sealed plan.')
  }
  if (planned.planSequence !== state.appliedOperationCount + 1) {
    return failState('Planned operations must commit in exact sealed-plan order.')
  }
  requireDigest(planned.operationDigest, 'planned operation digest')
  const operationDigest = createWorkspaceSearchMigrationOperationDigest(
    planned.operation,
  )
  if (planned.operationDigest !== operationDigest) {
    return failState('Planned operation digest does not match exact content.')
  }
  validatePlanMembershipProof(state, planned)

  const source = planned.operation.sourceCondition
  const table = state.configuration.tables[source.source]
  if (
    source.tableId !== table.tableId ||
    source.tableName !== table.tableName
  ) {
    return failState('Planned source identity differs from run configuration.')
  }
  validateSourceKeyAgainstTable(source, table)
  const expectedOperationId = createWorkspaceSearchOperationId({
    configurationHash: state.configurationHash,
    sourceTableId: source.tableId,
    sourceKeyDigest: source.keyDigest,
    targetKeyDigest: planned.operation.targetKeyDigest,
  })
  if (planned.operation.operationId !== expectedOperationId) {
    return failState('Planned operation ID does not match immutable identity.')
  }
}

/**
 * Recomputes one ordered Merkle path to the reviewed immutable plan root.
 *
 * Odd levels duplicate their final node, making the proof shape deterministic
 * for every one-based position and exact plan count.
 *
 * @param state - Run containing the reviewed plan root and leaf count.
 * @param planned - Exact operation leaf and sibling path.
 */
function validatePlanMembershipProof(
  state: WorkspaceSearchMigrationRunState,
  planned: WorkspaceSearchPlannedOperation,
): void {
  let currentDigest = createWorkspaceSearchPlanLeafDigest({
    planSequence: planned.planSequence,
    operationDigest: planned.operationDigest,
  })
  let zeroBasedIndex = planned.planSequence - 1
  let levelWidth = state.planOperationCount
  let proofIndex = 0

  while (levelWidth > 1) {
    const step = planned.membershipProof[proofIndex]
    if (!step) {
      return failState('Planned operation membership proof is incomplete.')
    }
    requireDigest(step.digest, 'plan membership sibling digest')
    const currentIsLeft = zeroBasedIndex % 2 === 0
    const expectedSide = currentIsLeft ? 'right' : 'left'
    if (step.side !== expectedSide) {
      return failState('Plan membership proof uses the wrong sibling side.')
    }
    if (
      currentIsLeft &&
      zeroBasedIndex + 1 >= levelWidth &&
      step.digest !== currentDigest
    ) {
      return failState('Plan membership proof has invalid odd-level padding.')
    }

    currentDigest = currentIsLeft
      ? createWorkspaceSearchPlanNodeDigest(currentDigest, step.digest)
      : createWorkspaceSearchPlanNodeDigest(step.digest, currentDigest)
    zeroBasedIndex = Math.floor(zeroBasedIndex / 2)
    levelWidth = Math.ceil(levelWidth / 2)
    proofIndex += 1
  }
  if (
    proofIndex !== planned.membershipProof.length ||
    currentDigest !== state.planDigest
  ) {
    return failState('Planned operation is not a member of the reviewed plan.')
  }
}

/**
 * Creates one domain-separated internal Merkle node digest.
 *
 * @param left - Exact left child digest.
 * @param right - Exact right child digest.
 * @returns Canonical ordered parent digest.
 */
export function createWorkspaceSearchPlanNodeDigest(
  left: string,
  right: string,
): string {
  requireDigest(left, 'left plan node digest')
  requireDigest(right, 'right plan node digest')
  return createMigrationDigest({
    kind: 'workspace-search-plan-node',
    nodeVersion: 1,
    left,
    right,
  })
}

/**
 * Validates an apply marker and its immutable journal evidence.
 *
 * @param state - Current applying run.
 * @param authority - Current fenced authority.
 * @param planned - Exact persisted plan entry.
 * @param marker - Candidate no-op or mutation marker.
 * @param segment - Candidate immutable journal segment for a mutation.
 */
function validateApplyMarker(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationAuthority,
  planned: WorkspaceSearchPlannedOperation,
  marker: WorkspaceSearchOperationMarker,
  segment: WorkspaceSearchJournalSegment | undefined,
): void {
  if (
    marker.markerVersion !== 1 ||
    marker.runId !== state.runId ||
    marker.configurationHash !== state.configurationHash ||
    marker.operationId !== planned.operation.operationId ||
    marker.planSequence !== planned.planSequence ||
    marker.planOperationDigest !== planned.operationDigest ||
    marker.targetKeyDigest !== planned.operation.targetKeyDigest ||
    marker.afterDigest !== planned.operation.after.digest
  ) {
    return failState('Apply marker does not match its sealed-plan entry.')
  }
  const expectedSourceDigest = planned.operation.sourceCondition.exists
    ? planned.operation.sourceCondition.itemDigest
    : undefined
  if (marker.sourceDigest !== expectedSourceDigest) {
    return failState('Apply marker does not match the planned source state.')
  }
  requirePositiveSafeInteger(marker.fenceToken, 'marker fence token')
  if (marker.fenceToken !== authority.lease.fenceToken) {
    return failLease('Apply marker uses a stale lease fence.')
  }
  const evidenceReceiptDigest = createMigrationDigest(
    state.maintenanceEvidenceReceipt,
  )
  if (
    marker.maintenanceEvidenceReceiptDigest !== evidenceReceiptDigest
  ) {
    return failState('Apply marker is not bound to current maintenance evidence.')
  }

  if (marker.kind === 'workspace-search-operation-already-current') {
    if (
      planned.operation.before.digest !== planned.operation.after.digest ||
      segment !== undefined ||
      marker.recordedAt !== authority.at
    ) {
      return failState('Already-current marker does not describe a true plan no-op.')
    }
    return
  }

  if (
    planned.operation.before.digest === planned.operation.after.digest ||
    marker.beforeDigest !== planned.operation.before.digest ||
    marker.sequence !== state.journalSequence + 1 ||
    marker.committedAt !== authority.at ||
    segment === undefined
  ) {
    return failState('Mutating apply marker does not advance the exact plan state.')
  }
  validateApplyJournalSegment(state, planned, marker, segment)
}

/**
 * Validates exact journal bytes and hash-chain metadata for one apply mutation.
 *
 * @param state - Current applying run and previous chain head.
 * @param planned - Exact sealed-plan operation.
 * @param receipt - Candidate atomic apply receipt.
 * @param segment - Exact immutable preimage segment.
 */
function validateApplyJournalSegment(
  state: WorkspaceSearchMigrationRunState,
  planned: WorkspaceSearchPlannedOperation,
  receipt: WorkspaceSearchOperationReceipt,
  segment: WorkspaceSearchJournalSegment,
): void {
  const operation = planned.operation
  const expectedSourceDigest = operation.sourceCondition.exists
    ? operation.sourceCondition.itemDigest
    : undefined
  if (
    segment.runId !== state.runId ||
    segment.configurationHash !== state.configurationHash ||
    segment.sequence !== receipt.sequence ||
    segment.operationId !== operation.operationId ||
    segment.sourceDigest !== expectedSourceDigest ||
    segment.previousHeadDigest !== state.journalHeadDigest ||
    segment.targetKeyDigest !== operation.targetKeyDigest ||
    segment.before.digest !== operation.before.digest ||
    segment.after.digest !== operation.after.digest ||
    segment.preparedFenceToken > receipt.fenceToken
  ) {
    return failState('Journal segment does not match the planned mutation.')
  }
  if (
    serializeCanonicalJson(segment.targetKey) !==
      serializeCanonicalJson(encodeAttributeMap(operation.targetKey)) ||
    serializeCanonicalJson(segment.before) !==
      serializeCanonicalJson(encodeSnapshotForDigest(operation.before)) ||
    serializeCanonicalJson(segment.after) !==
      serializeCanonicalJson(encodeSnapshotForDigest(operation.after))
  ) {
    return failState('Journal segment does not preserve the exact planned state.')
  }
  requireCanonicalTime(segment.createdAt, 'journal segment creation time')
  if (Date.parse(segment.createdAt) > Date.parse(receipt.committedAt)) {
    return failState('Journal segment was created after its target mutation.')
  }

  serializeWorkspaceSearchJournalSegment(segment)
  const contentDigest = createMigrationDigest(segment)
  if (receipt.journal.contentDigest !== contentDigest) {
    return failState('Apply receipt does not reference the exact journal bytes.')
  }
  requireNonEmptyText(receipt.journal.objectKey, 'journal object key')
  requireNonEmptyText(receipt.journal.versionId, 'journal version ID')
  const headDigest = createJournalHeadDigest({
    previousHeadDigest: segment.previousHeadDigest,
    sequence: segment.sequence,
    operationId: segment.operationId,
    contentDigest,
    versionId: receipt.journal.versionId,
  })
  if (receipt.journal.headDigest !== headDigest) {
    return failState('Apply receipt journal head does not extend the exact chain.')
  }
}

/**
 * Validates one reverse receipt against the current journal link.
 *
 * @param state - Current rolling-back state.
 * @param authority - Current fenced rollback authority.
 * @param progress - Exact reverse cursor before restoration.
 * @param event - Apply receipt, journal segment, and reverse marker.
 */
function validateRollbackReceipt(
  state: WorkspaceSearchMigrationRunState,
  authority: WorkspaceSearchMigrationAuthority,
  progress: NonNullable<WorkspaceSearchMigrationRunState['rollback']>,
  event: WorkspaceSearchRollbackOperationRecordedEvent,
): void {
  const applyReceipt = event.applyReceipt
  const segment = event.journalSegment
  const receipt = event.receipt
  if (
    applyReceipt.kind !== 'workspace-search-operation-applied' ||
    applyReceipt.markerVersion !== 1 ||
    applyReceipt.runId !== state.runId ||
    applyReceipt.configurationHash !== state.configurationHash ||
    applyReceipt.sequence !== progress.nextSequence ||
    applyReceipt.journal.headDigest !== progress.expectedHeadDigest
  ) {
    return failState('Apply receipt does not match the next reverse sequence.')
  }
  requirePositiveSafeInteger(applyReceipt.planSequence, 'apply plan sequence')
  requireDigest(applyReceipt.planOperationDigest, 'apply plan operation digest')
  requireDigest(
    applyReceipt.maintenanceEvidenceReceiptDigest,
    'apply maintenance evidence receipt digest',
  )
  requirePositiveSafeInteger(applyReceipt.fenceToken, 'apply fence token')
  requireCanonicalTime(applyReceipt.committedAt, 'apply commit time')

  if (
    segment.runId !== state.runId ||
    segment.configurationHash !== state.configurationHash ||
    segment.sequence !== applyReceipt.sequence ||
    segment.operationId !== applyReceipt.operationId ||
    segment.sourceDigest !== applyReceipt.sourceDigest ||
    segment.targetKeyDigest !== applyReceipt.targetKeyDigest ||
    segment.before.digest !== applyReceipt.beforeDigest ||
    segment.after.digest !== applyReceipt.afterDigest ||
    segment.preparedFenceToken > applyReceipt.fenceToken
  ) {
    return failState('Rollback journal segment does not match its apply receipt.')
  }
  serializeWorkspaceSearchJournalSegment(segment)
  const contentDigest = createMigrationDigest(segment)
  const expectedHeadDigest = createJournalHeadDigest({
    previousHeadDigest: segment.previousHeadDigest,
    sequence: segment.sequence,
    operationId: segment.operationId,
    contentDigest,
    versionId: applyReceipt.journal.versionId,
  })
  if (
    applyReceipt.journal.contentDigest !== contentDigest ||
    applyReceipt.journal.headDigest !== expectedHeadDigest
  ) {
    return failState('Rollback journal bytes do not reproduce the apply chain.')
  }

  if (
    receipt.kind !== 'workspace-search-operation-rolled-back' ||
    receipt.markerVersion !== 1 ||
    receipt.runId !== state.runId ||
    receipt.configurationHash !== state.configurationHash ||
    receipt.operationId !== applyReceipt.operationId ||
    receipt.sequence !== progress.nextSequence ||
    receipt.applyReceiptDigest !== createMigrationDigest(applyReceipt) ||
    receipt.targetKeyDigest !== segment.targetKeyDigest ||
    receipt.beforeDigest !== segment.before.digest ||
    receipt.afterDigest !== segment.after.digest ||
    receipt.journalHeadDigest !== progress.expectedHeadDigest ||
    receipt.fenceToken !== authority.lease.fenceToken ||
    receipt.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(state.maintenanceEvidenceReceipt) ||
    receipt.rolledBackAt !== authority.at
  ) {
    return failState('Rollback receipt does not describe the exact restoration.')
  }
}

/**
 * Validates one canonical apply or committed-prefix seal and reference.
 *
 * @param state - Run state represented by the seal.
 * @param seal - Exact canonical immutable seal document.
 * @param reference - Exact immutable object version.
 * @param at - Trusted transition time.
 * @param scope - Required complete-plan or committed-prefix scope.
 * @param mode - Whether this transition first attaches or revalidates the seal.
 */
function validateApplySeal(
  state: WorkspaceSearchMigrationRunState,
  seal: WorkspaceSearchApplySeal,
  reference: WorkspaceSearchApplySealReference,
  at: string,
  scope: WorkspaceSearchApplySeal['scope'],
  mode: 'attaching' | 'revalidating',
): void {
  const markerAggregateDigest = MigrationDigestAccumulator.fromState(
    state.applyMarkerDigestState,
  ).digest()
  if (
    seal.kind !== 'workspace-search-apply-seal' ||
    seal.sealVersion !== 1 ||
    seal.migrationId !== 'workspace-search-maintenance' ||
    seal.migrationVersion !== 1 ||
    seal.runId !== state.runId ||
    seal.configurationHash !== state.configurationHash ||
    seal.scope !== scope ||
    seal.planDigest !== state.planDigest ||
    seal.planOperationCount !== state.planOperationCount ||
    seal.journalSequence !== state.journalSequence ||
    seal.journalHeadDigest !== state.journalHeadDigest ||
    seal.markerCount !== state.appliedOperationCount ||
    seal.applyMarkerAggregateDigest !== markerAggregateDigest
  ) {
    return failState('Apply seal does not match current durable progress.')
  }
  requireCanonicalTime(seal.createdAt, 'apply seal creation time')
  if (
    (
      mode === 'attaching' &&
      Date.parse(seal.createdAt) < Date.parse(state.updatedAt)
    ) ||
    Date.parse(seal.createdAt) > Date.parse(at)
  ) {
    return failState('Apply seal creation time is outside its transition window.')
  }
  if (
    reference.scope !== scope ||
    reference.contentDigest !== createMigrationDigest(seal)
  ) {
    return failState('Apply seal reference does not identify the exact seal.')
  }
  validateApplySealReference(reference)
}

/**
 * Validates exact full-scan verification evidence and immutable storage identity.
 *
 * @param state - Current verifying state and completed checkpoints.
 * @param evidence - Canonical complete verification document.
 * @param reference - Exact immutable object version.
 * @param at - Trusted transition time after evidence persistence.
 */
function validateVerificationEvidence(
  state: WorkspaceSearchMigrationRunState,
  evidence: WorkspaceSearchVerificationEvidence,
  reference: WorkspaceSearchVerificationEvidenceReference,
  at: string,
): void {
  if (
    !state.verification ||
    !state.applySeal ||
    state.applySeal.scope !== 'complete-plan' ||
    evidence.kind !== 'workspace-search-verification-evidence' ||
    evidence.evidenceVersion !== 1 ||
    evidence.migrationId !== 'workspace-search-maintenance' ||
    evidence.migrationVersion !== 1 ||
    evidence.runId !== state.runId ||
    evidence.configurationHash !== state.configurationHash ||
    evidence.planDigest !== state.planDigest ||
    evidence.planOperationCount !== state.planOperationCount ||
    evidence.applySealContentDigest !== state.applySeal.contentDigest ||
    evidence.status !== 'pass' ||
    serializeCanonicalJson(evidence.verification) !==
      serializeCanonicalJson(state.verification)
  ) {
    return failVerify('Verification evidence does not match complete run state.')
  }
  requireCanonicalTime(
    evidence.completedAt,
    'verification evidence completion time',
  )
  if (
    Date.parse(evidence.completedAt) < Date.parse(state.updatedAt) ||
    Date.parse(evidence.completedAt) > Date.parse(at)
  ) {
    return failVerify('Verification evidence time is outside its transition window.')
  }
  validateVerificationEvidenceReference(reference)
  if (reference.contentDigest !== createMigrationDigest(evidence)) {
    return failVerify('Verification reference does not identify exact evidence.')
  }
}

/**
 * Validates source identity, exact key digest, and optional exact item digest.
 *
 * @param operation - Planned operation containing the source condition.
 */
function validateSourceCondition(
  operation: WorkspaceSearchMigrationOperation,
): void {
  const source = operation.sourceCondition
  if (source.exists !== true && source.exists !== false) {
    return failState('Planned source discriminator is invalid.')
  }
  requireExactObjectKeys(
    source,
    source.exists
      ? [
          'exists',
          'item',
          'itemDigest',
          'key',
          'keyDigest',
          'source',
          'tableId',
          'tableName',
        ]
      : [
          'exists',
          'key',
          'keyDigest',
          'source',
          'tableId',
          'tableName',
        ],
    'planned source condition',
  )
  if (!isWorkspaceSearchMigrationSourceName(source.source)) {
    return failState('Planned operation uses an unsupported source.')
  }
  if (source.source !== sourceForEntityType(operation.entityType)) {
    return failState('Planned entity family is bound to the wrong source table.')
  }
  requireNonEmptyText(source.tableId, 'source TableId')
  requireNonEmptyText(source.tableName, 'source table name')
  requireDigest(source.keyDigest, 'source key digest')
  if (createAttributeMapDigest(source.key) !== source.keyDigest) {
    return failState('Source key digest does not match exact key attributes.')
  }
  if (source.exists) {
    requireDigest(source.itemDigest, 'source item digest')
    if (createAttributeMapDigest(source.item) !== source.itemDigest) {
      return failState('Source item digest does not match exact source state.')
    }
  }
}

/**
 * Binds one planned target transition to the pure canonical source mapper.
 *
 * Present sources must reproduce the exact entity, key, and put/delete result.
 * An absent source represents orphan reconciliation and therefore cannot create
 * or update a target projection.
 *
 * @param operation - Candidate exact source condition and target transition.
 */
function validateDeterministicSourceProjection(
  operation: WorkspaceSearchMigrationOperation,
): void {
  const source = operation.sourceCondition
  if (!source.exists) {
    validateAbsentSourceTargetIdentity(operation)
    return
  }

  let mapped: ReturnType<typeof mapWorkspaceSearchMigrationRow>
  try {
    mapped = mapWorkspaceSearchMigrationRow(
      source.source,
      decodeAttributeMapToNativeRecord(source.item),
    )
  } catch {
    return failState('Planned source item cannot be mapped deterministically.')
  }
  if (
    mapped.classification !== 'mapped' ||
    mapped.entityType !== operation.entityType
  ) {
    return failState('Planned source item is not a mapped Search entity.')
  }

  const targetWorkspaceId = readNonEmptyStringAttribute(
    operation.targetKey.workspaceId,
  )
  const targetRecordKey = readNonEmptyStringAttribute(
    operation.targetKey.recordKey,
  )
  if (
    targetWorkspaceId !== mapped.targetKey.workspaceId ||
    targetRecordKey !== mapped.targetKey.recordKey
  ) {
    return failState('Planned target key differs from canonical source mapping.')
  }

  if (mapped.operation.action === 'delete') {
    if (operation.after.exists) {
      return failState('Canonical source deletion cannot write a target.')
    }
    return
  }
  if (!operation.after.exists) {
    return failState('Canonical source projection cannot delete its target.')
  }
  const expectedAfter = encodeWorkspaceSearchMigrationDocument(
    mapped.operation.document,
  )
  if (
    serializeCanonicalAttributeMap(expectedAfter) !==
      serializeCanonicalAttributeMap(operation.after.item)
  ) {
    return failState(
      'Planned target projection differs from canonical source mapping.',
    )
  }
}

/**
 * Binds one orphan deletion to the only physical source key for its target.
 *
 * @param operation - Candidate absent-source target deletion.
 */
function validateAbsentSourceTargetIdentity(
  operation: WorkspaceSearchMigrationOperation,
): void {
  const source = operation.sourceCondition
  if (source.exists) {
    return failState('Orphan identity validation requires an absent source.')
  }
  if (!operation.before.exists || operation.after.exists) {
    return failState(
      'An absent source can only delete an existing orphan target.',
    )
  }

  const workspaceId = readNonEmptyStringAttribute(
    operation.targetKey.workspaceId,
  )
  const entityId = readNonEmptyStringAttribute(
    operation.before.item.entityId,
  )
  if (workspaceId === undefined || entityId === undefined) {
    return failState('Orphan target identity is incomplete.')
  }
  const parts = entityId.split('/')

  if (source.source === 'project-directory') {
    return failState(
      'Project Directory orphan deletion requires complete source evidence.',
    )
  }
  if (source.source === 'work-items') {
    const teamId = parts[1]
    const issueId = parts[3]
    if (
      parts.length !== 4 ||
      parts[0] !== 'team' ||
      parts[2] !== 'issue' ||
      teamId === undefined ||
      issueId === undefined ||
      readNonEmptyStringAttribute(source.key.directoryTeamId) !==
        `${workspaceId}#team#${teamId}` ||
      readNonEmptyStringAttribute(source.key.issueId) !== issueId
    ) {
      return failState('Orphan Work Item source key differs from its target.')
    }
    return
  }
  if (source.source === 'collaboration') {
    const teamId = parts[1]
    const issueId = parts[3]
    const commentId = parts[5]
    if (
      parts.length !== 6 ||
      parts[0] !== 'team' ||
      parts[2] !== 'issue' ||
      parts[4] !== 'comment' ||
      teamId === undefined ||
      issueId === undefined ||
      commentId === undefined ||
      readNonEmptyStringAttribute(source.key.entityKey) !==
        `${workspaceId}#work-item#team/${teamId}/issue/${issueId}` ||
      readNonEmptyStringAttribute(source.key.recordKey) !==
        `COMMENT#${commentId}`
    ) {
      return failState(
        'Orphan Collaboration source key differs from its target.',
      )
    }
    return
  }
  if (source.source === 'documents') {
    if (
      readNonEmptyStringAttribute(source.key.workspaceId) !== workspaceId ||
      readNonEmptyStringAttribute(source.key.recordKey) !==
        `DOCUMENT#${entityId}`
    ) {
      return failState('Orphan Document source key differs from its target.')
    }
    return
  }
  return failState('Orphan deletion is unsupported for this source table.')
}

/**
 * Validates an exact source key against the measured table key descriptor.
 *
 * @param source - Planned present or absent source condition.
 * @param table - Measured immutable source-table identity.
 */
function validateSourceKeyAgainstTable(
  source: WorkspaceSearchMigrationOperation['sourceCondition'],
  table: MigrationTableIdentity,
): void {
  validateAttributeKeyAgainstTable(source.key, table, 'planned source key')
  for (const descriptor of table.key) {
    const keyAttribute = source.key[descriptor.name]
    if (!keyAttribute) return failState('Planned source key is incomplete.')
    if (source.exists) {
      const itemAttribute = source.item[descriptor.name]
      if (
        !itemAttribute ||
        serializeCanonicalAttributeMap({ key: itemAttribute }) !==
          serializeCanonicalAttributeMap({ key: keyAttribute })
      ) {
        return failState('Planned source item does not contain its exact key.')
      }
    }
  }
}

/**
 * Validates an exact key against one measured DynamoDB key descriptor.
 *
 * @param key - Candidate native DynamoDB key.
 * @param table - Measured immutable table identity.
 * @param label - Secret-free key purpose.
 */
function validateAttributeKeyAgainstTable(
  key: WorkspaceSearchMigrationOperation['targetKey'],
  table: MigrationTableIdentity,
  label: string,
): void {
  const keyNames = Object.keys(key)
  if (keyNames.length !== table.key.length) {
    return failState(`${label} does not match the measured table schema.`)
  }
  for (const descriptor of table.key) {
    const keyAttribute = key[descriptor.name]
    if (!keyAttribute || Object.keys(keyAttribute).length !== 1) {
      return failState(`${label} does not match the measured table schema.`)
    }
    if (
      (descriptor.type === 'S' && typeof keyAttribute.S !== 'string') ||
      (descriptor.type === 'N' && typeof keyAttribute.N !== 'string') ||
      (descriptor.type === 'B' && keyAttribute.B === undefined)
    ) {
      return failState(`${label} type differs from the measured table schema.`)
    }
  }
}

/**
 * Validates target key and snapshot digests for one planned operation.
 *
 * @param operation - Planned target transition.
 */
function validateTargetOperation(
  operation: WorkspaceSearchMigrationOperation,
): void {
  if (
    operation.entityType !== 'comment' &&
    operation.entityType !== 'document' &&
    operation.entityType !== 'project' &&
    operation.entityType !== 'team' &&
    operation.entityType !== 'work-item'
  ) {
    return failState('Planned operation uses an unsupported entity type.')
  }
  requireDigest(operation.targetKeyDigest, 'target key digest')
  if (createAttributeMapDigest(operation.targetKey) !== operation.targetKeyDigest) {
    return failState('Target key digest does not match exact key attributes.')
  }
  const targetKeys = Object.keys(operation.targetKey).sort()
  if (
    targetKeys.length !== 2 ||
    targetKeys[0] !== 'recordKey' ||
    targetKeys[1] !== 'workspaceId' ||
    readNonEmptyStringAttribute(operation.targetKey.recordKey) === undefined ||
    readNonEmptyStringAttribute(operation.targetKey.workspaceId) === undefined
  ) {
    return failState('Target key is not an exact Workspace Search primary key.')
  }
  validateTargetSnapshot(
    operation.before,
    operation.targetKey,
    operation.entityType,
    false,
    'before',
  )
  validateTargetSnapshot(
    operation.after,
    operation.targetKey,
    operation.entityType,
    true,
    'after',
  )
}

/**
 * Validates an exact present or absent target snapshot.
 *
 * @param snapshot - Candidate exact target state.
 * @param targetKey - Exact target primary key.
 * @param entityType - Entity family owned by the planned operation.
 * @param requireCurrentDigest - Whether a present snapshot must carry its digest.
 * @param label - Secret-free state label.
 */
function validateTargetSnapshot(
  snapshot: MigrationItemSnapshot,
  targetKey: WorkspaceSearchMigrationOperation['targetKey'],
  entityType: WorkspaceSearchMigrationOperation['entityType'],
  requireCurrentDigest: boolean,
  label: string,
): void {
  if (snapshot.exists !== true && snapshot.exists !== false) {
    return failState(`${label} target discriminator is invalid.`)
  }
  requireExactObjectKeys(
    snapshot,
    snapshot.exists
      ? ['digest', 'exists', 'item']
      : ['digest', 'exists'],
    `${label} target snapshot`,
  )
  requireDigest(snapshot.digest, `${label} target digest`)
  if (!snapshot.exists) {
    if (snapshot.digest !== createAbsentMigrationItemDigest()) {
      return failState(`${label} absent target digest is not canonical.`)
    }
    return
  }
  if (createAttributeMapDigest(snapshot.item) !== snapshot.digest) {
    return failState(`${label} target digest does not match exact item state.`)
  }
  const itemWorkspaceId = snapshot.item.workspaceId
  const itemRecordKey = snapshot.item.recordKey
  const itemEntryType = readNonEmptyStringAttribute(snapshot.item.entryType)
  const itemEntityType = readNonEmptyStringAttribute(snapshot.item.entityType)
  const itemEntityId = readNonEmptyStringAttribute(snapshot.item.entityId)
  if (
    !itemWorkspaceId ||
    !itemRecordKey ||
    itemEntryType !== 'search-document' ||
    itemEntityType !== entityType ||
    itemEntityId === undefined
  ) {
    return failState(`${label} target item is missing its exact primary key.`)
  }
  if (
    serializeCanonicalAttributeMap({
      workspaceId: itemWorkspaceId,
      recordKey: itemRecordKey,
    }) !== serializeCanonicalAttributeMap(targetKey)
  ) {
    return failState(`${label} target item does not match the planned key.`)
  }
  if (
    createWorkspaceSearchDocumentRecordKey(entityType, itemEntityId) !==
      readNonEmptyStringAttribute(itemRecordKey) ||
    !isCanonicalWorkspaceSearchMigrationEntityId(entityType, itemEntityId)
  ) {
    return failState(`${label} target item has inconsistent entity identity.`)
  }

  let document: WorkspaceSearchDocument
  const nativeItem = decodeAttributeMapToNativeRecord(snapshot.item)
  try {
    document = readWorkspaceSearchDocument(nativeItem)
  } catch {
    return failState(`${label} target item is not a valid search projection.`)
  }
  const storedProjectionDigest = nativeItem.projectionDigest
  if (
    requireCurrentDigest &&
    storedProjectionDigest !== document.projectionDigest
  ) {
    return failState(`${label} target item lacks its current projection digest.`)
  }
  const canonicalItem = encodeWorkspaceSearchMigrationDocument(document)
  const expectedItem = storedProjectionDigest === undefined
    ? withoutProjectionDigest(canonicalItem)
    : canonicalItem
  if (createAttributeMapDigest(expectedItem) !== snapshot.digest) {
    return failState(`${label} target item contains noncanonical fields.`)
  }
}

/**
 * Removes the server-owned digest only for a validated legacy preimage.
 *
 * @param item - Canonical current Workspace Search low-level item.
 * @returns Exact legacy shape without `projectionDigest`.
 */
function withoutProjectionDigest(
  item: WorkspaceSearchMigrationOperation['targetKey'],
): WorkspaceSearchMigrationOperation['targetKey'] {
  const legacy: WorkspaceSearchMigrationOperation['targetKey'] = {}
  for (const [key, value] of Object.entries(item)) {
    if (key !== 'projectionDigest') {
      Object.defineProperty(legacy, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      })
    }
  }
  return legacy
}

/**
 * Encodes an exact snapshot into the JSON-safe form used by plan digests.
 *
 * @param snapshot - Exact native target state.
 * @returns Canonical JSON-safe snapshot.
 */
function encodeSnapshotForDigest(snapshot: MigrationItemSnapshot) {
  if (!snapshot.exists) {
    return {
      exists: false,
      digest: snapshot.digest,
    }
  }
  return {
    exists: true,
    item: encodeAttributeMap(snapshot.item),
    digest: snapshot.digest,
  }
}

/**
 * Requires an object to contain exactly the named enumerable own properties.
 *
 * @param value - Candidate object at the operation-digest trust boundary.
 * @param expectedKeys - Complete allowed enumerable own-property set.
 * @param label - Secret-free object purpose used in failures.
 */
function requireExactObjectKeys(
  value: object,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actualKeys = Object.keys(value)
  const expectedKeySet = new Set(expectedKeys)
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => !expectedKeySet.has(key))
  ) {
    return failState(`${label} has an invalid shape.`)
  }
}

/**
 * Reads one nonempty exact DynamoDB string attribute.
 *
 * @param value - Candidate low-level attribute.
 * @returns Exact string value or undefined.
 */
function readNonEmptyStringAttribute(
  value: WorkspaceSearchMigrationOperation['targetKey'][string] | undefined,
): string | undefined {
  if (
    value !== undefined &&
    Object.keys(value).length === 1 &&
    typeof value.S === 'string' &&
    value.S.length > 0
  ) {
    return value.S
  }
  return undefined
}

/**
 * Narrows one untrusted source name to the migration source set.
 *
 * @param value - Candidate logical source name.
 * @returns Whether the value is a supported source.
 */
function isWorkspaceSearchMigrationSourceName(
  value: unknown,
): value is WorkspaceSearchMigrationSourceName {
  for (const source of workspaceSearchMigrationSourceNames) {
    if (value === source) return true
  }
  return false
}

/**
 * Returns the only source table that owns one Workspace Search entity family.
 *
 * @param entityType - Planned Workspace Search entity family.
 * @returns Required logical source name.
 */
function sourceForEntityType(
  entityType: WorkspaceSearchMigrationOperation['entityType'],
): WorkspaceSearchMigrationSourceName {
  if (entityType === 'comment') return 'collaboration'
  if (entityType === 'document') return 'documents'
  if (entityType === 'work-item') return 'work-items'
  return 'project-directory'
}

/**
 * Replaces one traversal checkpoint after enforcing monotonic progress.
 *
 * @param traversal - Current source and target checkpoints.
 * @param location - Source or target checkpoint to replace.
 * @param checkpoint - Candidate cumulative checkpoint.
 * @param configuration - Measured table schemas for cursor validation.
 * @returns Traversal with only the selected checkpoint replaced.
 */
function replaceTraversalCheckpoint(
  traversal: WorkspaceSearchMigrationTraversalProgress,
  location: WorkspaceSearchMigrationCheckpointLocation,
  checkpoint: MigrationSourceCheckpoint,
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationTraversalProgress {
  const previous = location === 'target'
    ? traversal.target
    : traversal.sources[location]
  validateWorkspaceSearchMigrationCheckpoint(checkpoint, previous)
  validateCheckpointCursor(
    checkpoint,
    location,
    configuration,
  )

  if (location === 'target') {
    return {
      ...traversal,
      target: checkpoint,
    }
  }
  return {
    ...traversal,
    sources: {
      ...traversal.sources,
      [location]: checkpoint,
    },
  }
}

/**
 * Validates all exact source keys and checkpoints in one traversal.
 *
 * @param traversal - Candidate apply or verification progress.
 * @param configuration - Measured table schemas for cursor validation.
 */
function validateWorkspaceSearchMigrationTraversal(
  traversal: WorkspaceSearchMigrationTraversalProgress,
  configuration: WorkspaceSearchMigrationConfiguration,
): void {
  const sourceKeys = Object.keys(traversal.sources)
  if (sourceKeys.length !== workspaceSearchMigrationSourceNames.length) {
    return failState('Migration traversal has an incomplete source set.')
  }
  for (const source of workspaceSearchMigrationSourceNames) {
    if (!Object.hasOwn(traversal.sources, source)) {
      return failState('Migration traversal has an incomplete source set.')
    }
    const checkpoint = traversal.sources[source]
    validateWorkspaceSearchMigrationCheckpoint(checkpoint)
    validateCheckpointCursor(checkpoint, source, configuration)
  }
  validateWorkspaceSearchMigrationCheckpoint(traversal.target)
  validateCheckpointCursor(traversal.target, 'target', configuration)
}

/**
 * Validates an opaque LastEvaluatedKey against its exact scanned table schema.
 *
 * @param checkpoint - Candidate checkpoint with an optional cursor.
 * @param location - Source or target table being scanned.
 * @param configuration - Measured immutable table identities.
 */
function validateCheckpointCursor(
  checkpoint: MigrationSourceCheckpoint,
  location: WorkspaceSearchMigrationCheckpointLocation,
  configuration: WorkspaceSearchMigrationConfiguration,
): void {
  if (checkpoint.cursor === undefined) return
  const table = location === 'target'
    ? configuration.tables['workspace-search']
    : configuration.tables[location]
  validateAttributeKeyAgainstTable(
    checkpoint.cursor,
    table,
    'migration checkpoint cursor',
  )
}

/**
 * Checks whether every traversal checkpoint completed without invalid rows.
 *
 * @param traversal - Candidate apply or verification traversal.
 * @returns Whether all sources and target are complete and clean.
 */
function isCompletedCleanTraversal(
  traversal: WorkspaceSearchMigrationTraversalProgress,
): boolean {
  for (const source of workspaceSearchMigrationSourceNames) {
    const checkpoint = traversal.sources[source]
    if (!checkpoint.completed || checkpoint.aggregate.invalid !== 0) {
      return false
    }
  }
  return traversal.target.completed && traversal.target.aggregate.invalid === 0
}

/**
 * Checks whether a traversal is still the exact untouched initial state.
 *
 * @param traversal - Candidate apply traversal.
 * @returns Whether every source and target checkpoint is canonical-empty.
 */
function isCanonicalEmptyTraversal(
  traversal: WorkspaceSearchMigrationTraversalProgress,
): boolean {
  for (const source of workspaceSearchMigrationSourceNames) {
    if (!isCanonicalEmptyCheckpoint(traversal.sources[source])) return false
  }
  return isCanonicalEmptyCheckpoint(traversal.target)
}

/**
 * Validates lifecycle-specific optional state and terminal invariants.
 *
 * @param state - Structurally validated durable run.
 */
function validateLifecycleShape(
  state: WorkspaceSearchMigrationRunState,
): void {
  if (state.status === 'applying') {
    if (
      state.applySeal !== undefined ||
      state.verification !== undefined ||
      state.verificationEvidenceReference !== undefined ||
      state.rollback !== undefined
    ) {
      return failState('Applying state contains a later-phase field.')
    }
    return
  }

  if (!state.applySeal) {
    return failState('Post-apply state is missing its immutable apply seal.')
  }
  if (state.applySeal.scope === 'complete-plan') {
    requireCompleteAppliedPlan(state)
  } else if (
    state.verification !== undefined ||
    state.verificationEvidenceReference !== undefined
  ) {
    return failState('Committed-prefix rollback cannot contain verification state.')
  }

  if (state.status === 'applied') {
    if (
      state.applySeal.scope !== 'complete-plan' ||
      state.verification !== undefined ||
      state.verificationEvidenceReference !== undefined ||
      state.rollback !== undefined
    ) {
      return failState('Applied state contains inconsistent phase data.')
    }
    return
  }
  if (state.status === 'verifying') {
    if (
      state.applySeal.scope !== 'complete-plan' ||
      state.verification === undefined ||
      state.verificationEvidenceReference !== undefined ||
      state.rollback !== undefined
    ) {
      return failState('Verifying state is missing independent progress.')
    }
    return
  }
  if (state.status === 'verified') {
    if (
      state.applySeal.scope !== 'complete-plan' ||
      state.verification === undefined ||
      state.verificationEvidenceReference === undefined ||
      state.rollback !== undefined ||
      !isCompletedCleanTraversal(state.verification)
    ) {
      return failState('Verified state lacks complete clean evidence.')
    }
    validateVerificationEvidenceReference(
      state.verificationEvidenceReference,
    )
    return
  }
  if (state.status !== 'rolling-back' && state.status !== 'rolled-back') {
    return failState('Migration run has an unsupported lifecycle status.')
  }
  if (!state.rollback) {
    return failState('Rollback lifecycle is missing reverse progress.')
  }
  validateRetainedVerificationDuringRollback(state)
  if (
    state.status === 'rolled-back' &&
    (
      state.rollback.nextSequence !== 0 ||
      state.rollback.expectedHeadDigest !== zeroHexDigest()
    )
  ) {
    return failState('Rolled-back state did not reach the zero journal root.')
  }
}

/**
 * Validates apply completeness required by a complete-plan seal.
 *
 * @param state - Candidate complete-plan state.
 */
function requireCompleteAppliedPlan(
  state: WorkspaceSearchMigrationRunState,
): void {
  if (
    state.appliedOperationCount !== state.planOperationCount ||
    !isCompletedCleanTraversal(state.apply)
  ) {
    return failState('Complete-plan seal does not cover a clean finished apply.')
  }
}

/**
 * Validates verification fields retained when rollback starts later.
 *
 * @param state - Rolling-back or rolled-back state.
 */
function validateRetainedVerificationDuringRollback(
  state: WorkspaceSearchMigrationRunState,
): void {
  if (state.applySeal?.scope === 'committed-prefix') {
    if (
      state.verification !== undefined ||
      state.verificationEvidenceReference !== undefined
    ) {
      return failState('Prefix rollback must not retain verification fields.')
    }
    return
  }
  if (
    state.verificationEvidenceReference !== undefined &&
    (
      state.verification === undefined ||
      !isCompletedCleanTraversal(state.verification)
    )
  ) {
    return failState('Retained verification evidence is incomplete.')
  }
  if (state.verificationEvidenceReference !== undefined) {
    validateVerificationEvidenceReference(
      state.verificationEvidenceReference,
    )
  }
}

/**
 * Validates one exact immutable reviewed plan seal and object reference.
 *
 * @param seal - Candidate canonical plan seal.
 * @param reference - Exact immutable object version.
 * @param runId - Run that must own the plan.
 * @param configurationHash - Reviewed configuration digest.
 * @param dryRunEvidenceDigest - Exact reviewed dry-run evidence digest.
 * @param planDigest - Expected Merkle root.
 * @param planOperationCount - Expected exact leaf count.
 * @param createdAt - Run creation time after plan sealing.
 */
function validatePlanSeal(
  seal: WorkspaceSearchPlanSeal,
  reference: WorkspaceSearchPlanSealReference,
  runId: string,
  configurationHash: string,
  dryRunEvidenceDigest: string,
  planDigest: string,
  planOperationCount: number,
  createdAt: string,
): void {
  if (
    seal.kind !== 'workspace-search-plan-seal' ||
    seal.sealVersion !== 2 ||
    seal.migrationId !== 'workspace-search-maintenance' ||
    seal.migrationVersion !== 1 ||
    seal.runId !== runId ||
    seal.configurationHash !== configurationHash ||
    seal.dryRunEvidenceDigest !== dryRunEvidenceDigest ||
    seal.planDigest !== planDigest ||
    seal.planOperationCount !== planOperationCount
  ) {
    return failState('Reviewed plan seal does not match run creation input.')
  }
  requireDigest(seal.dryRunEvidenceDigest, 'plan dry-run evidence digest')
  requireDigest(seal.planningSnapshotDigest, 'planning snapshot digest')
  requireNonNegativeSafeInteger(
    seal.planOperationCount,
    'plan operation count',
  )
  requireNonNegativeSafeInteger(
    seal.sourceOperationCount,
    'plan source operation count',
  )
  requireNonNegativeSafeInteger(
    seal.orphanOperationCount,
    'plan orphan operation count',
  )
  if (
    seal.sourceOperationCount + seal.orphanOperationCount !==
      seal.planOperationCount
  ) {
    return failState('Reviewed plan operation counts are inconsistent.')
  }
  requireCanonicalTime(seal.createdAt, 'plan seal creation time')
  if (Date.parse(seal.createdAt) > Date.parse(createdAt)) {
    return failState('Reviewed plan was sealed after run creation.')
  }
  validatePlanSealReference(reference)
  if (reference.contentDigest !== createMigrationDigest(seal)) {
    return failState('Plan seal reference does not identify the exact seal.')
  }
  if (
    (planOperationCount === 0) !==
      (planDigest === createEmptyWorkspaceSearchPlanDigest())
  ) {
    return failState('Reviewed plan count does not match its canonical root.')
  }
}

/**
 * Validates one immutable plan-seal object reference.
 *
 * @param reference - Candidate immutable S3 version.
 */
function validatePlanSealReference(
  reference: WorkspaceSearchPlanSealReference,
): void {
  requireNonEmptyText(reference.objectKey, 'plan seal object key')
  requireNonEmptyText(reference.versionId, 'plan seal version ID')
  requireDigest(reference.contentDigest, 'plan seal content digest')
}

/**
 * Validates one immutable verification-evidence object reference.
 *
 * @param reference - Candidate immutable S3 version.
 */
function validateVerificationEvidenceReference(
  reference: WorkspaceSearchVerificationEvidenceReference,
): void {
  requireNonEmptyText(reference.objectKey, 'verification evidence object key')
  requireNonEmptyText(reference.versionId, 'verification evidence version ID')
  requireDigest(
    reference.contentDigest,
    'verification evidence content digest',
  )
}

/**
 * Validates immutable apply-seal reference fields when present.
 *
 * @param reference - Candidate immutable S3 version reference.
 */
function validateApplySealReference(
  reference: WorkspaceSearchApplySealReference | undefined,
): void {
  if (reference === undefined) return
  if (
    reference.scope !== 'committed-prefix' &&
    reference.scope !== 'complete-plan'
  ) {
    return failState('Apply seal reference has an invalid scope.')
  }
  requireNonEmptyText(reference.objectKey, 'apply seal object key')
  requireNonEmptyText(reference.versionId, 'apply seal version ID')
  requireDigest(reference.contentDigest, 'apply seal content digest')
}

/**
 * Validates reverse progress against the immutable final apply chain.
 *
 * @param state - Candidate run with optional rollback progress.
 */
function validateRollbackProgress(
  state: WorkspaceSearchMigrationRunState,
): void {
  const rollback = state.rollback
  if (!rollback) return
  requireNonNegativeSafeInteger(
    rollback.upperBoundSequence,
    'rollback upper-bound sequence',
  )
  requireNonNegativeSafeInteger(
    rollback.nextSequence,
    'rollback next sequence',
  )
  requireNonNegativeSafeInteger(rollback.restored, 'rollback restored count')
  requireDigest(rollback.expectedHeadDigest, 'rollback expected journal head')
  if (
    rollback.upperBoundSequence !== state.journalSequence ||
    rollback.nextSequence > rollback.upperBoundSequence ||
    rollback.restored + rollback.nextSequence !==
      rollback.upperBoundSequence
  ) {
    return failState('Rollback progress does not match the sealed apply chain.')
  }
  if (
    (rollback.nextSequence === 0) !==
      (rollback.expectedHeadDigest === zeroHexDigest())
  ) {
    return failState('Rollback cursor and expected journal head disagree.')
  }
}

/**
 * Validates an active or historical lease shape.
 *
 * @param lease - Candidate durable lease.
 */
function validateMigrationLease(lease: WorkspaceSearchMigrationLease): void {
  requireMigrationIdentifier(lease.runId, 'Run ID')
  requireMigrationIdentifier(lease.ownerId, 'Owner ID')
  requirePositiveSafeInteger(lease.fenceToken, 'lease fence token')
  requireCanonicalTime(lease.heartbeatAt, 'lease heartbeat time')
  requireCanonicalTime(lease.expiresAt, 'lease expiry')
  if (
    Date.parse(lease.expiresAt) - Date.parse(lease.heartbeatAt) !==
      WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS
  ) {
    return failLease('Migration lease does not use the fixed fenced duration.')
  }
}

/**
 * Validates a fresh evidence receipt and optional current authority bindings.
 *
 * @param receipt - Candidate fresh evidence receipt.
 * @param runId - Run that must own the receipt.
 * @param fenceToken - Optional current lease fence.
 * @param at - Optional trusted commit time within the exclusive validity window.
 */
function validateMaintenanceEvidenceReceipt(
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  runId: string,
  fenceToken?: number,
  at?: string,
): void {
  requireMigrationIdentifier(receipt.runId, 'Run ID')
  requireDigest(receipt.evidenceDigest, 'maintenance evidence receipt digest')
  requireNonEmptyText(
    receipt.evidenceLocator,
    'maintenance evidence receipt locator',
  )
  requirePositiveSafeInteger(
    receipt.runtimeRevision,
    'maintenance runtime revision',
  )
  requirePositiveSafeInteger(
    receipt.fenceToken,
    'maintenance evidence fence token',
  )
  requireCanonicalTime(
    receipt.validatedAt,
    'maintenance evidence validation time',
  )
  requireCanonicalTime(
    receipt.oldestObservationAt,
    'maintenance evidence oldest observation time',
  )
  requireCanonicalTime(
    receipt.validUntil,
    'maintenance evidence validity deadline',
  )
  const validatedMilliseconds = Date.parse(receipt.validatedAt)
  const oldestObservationMilliseconds = Date.parse(
    receipt.oldestObservationAt,
  )
  if (
    receipt.runId !== runId ||
    validatedMilliseconds >= Date.parse(receipt.validUntil) ||
    oldestObservationMilliseconds >
      validatedMilliseconds +
        MAINTENANCE_EVIDENCE_CLOCK_SKEW_SECONDS * 1_000 ||
    validatedMilliseconds - oldestObservationMilliseconds >
      MAINTENANCE_EVIDENCE_MAX_AGE_SECONDS * 1_000 ||
    Date.parse(receipt.validUntil) !==
      oldestObservationMilliseconds +
        MAINTENANCE_EVIDENCE_MAX_AGE_SECONDS * 1_000 +
        1
  ) {
    return failState('Maintenance evidence receipt identity or window is invalid.')
  }
  if (fenceToken !== undefined && receipt.fenceToken !== fenceToken) {
    return failLease('Maintenance evidence receipt uses a stale lease fence.')
  }
  if (at !== undefined) {
    requireCanonicalTime(at, 'maintenance evidence evaluation time')
    const atMilliseconds = Date.parse(at)
    if (
      Date.parse(receipt.validatedAt) > atMilliseconds ||
      atMilliseconds +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS >=
        Date.parse(receipt.validUntil)
    ) {
      return failEvidence(
        'Maintenance evidence lacks the required atomic commit window.',
      )
    }
  }
}

/**
 * Enforces monotonic cumulative checkpoint progress.
 *
 * @param checkpoint - Candidate next checkpoint.
 * @param previous - Exact previously committed checkpoint.
 */
function requireMonotonicCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
  previous: MigrationSourceCheckpoint,
): void {
  const checkpointChanged =
    checkpointFingerprint(checkpoint) !== checkpointFingerprint(previous)
  if (previous.completed) {
    if (checkpointChanged) {
      return failState('A completed checkpoint cannot change.')
    }
    return
  }
  if (
    checkpoint.aggregate.scanned < previous.aggregate.scanned ||
    checkpoint.aggregate.mapped < previous.aggregate.mapped ||
    checkpoint.aggregate.ignored < previous.aggregate.ignored ||
    checkpoint.aggregate.invalid < previous.aggregate.invalid ||
    checkpoint.aggregate.projected < previous.aggregate.projected ||
    checkpoint.aggregate.deleted < previous.aggregate.deleted ||
    checkpoint.aggregate.pageCount < previous.aggregate.pageCount ||
    checkpoint.keyDigestState.count < previous.keyDigestState.count ||
    checkpoint.contentDigestState.count < previous.contentDigestState.count
  ) {
    return failState('Migration checkpoint counters moved backwards.')
  }
  if (
    checkpoint.aggregate.pageCount === previous.aggregate.pageCount &&
    checkpointChanged
  ) {
    return failState('Checkpoint changed without consuming another page.')
  }
  if (
    checkpoint.aggregate.pageCount >
      previous.aggregate.pageCount + 1
  ) {
    return failState('A checkpoint transition must consume exactly one page.')
  }
  if (
    checkpointChanged &&
    checkpoint.cursor !== undefined &&
    previous.cursor !== undefined &&
    serializeCanonicalAttributeMap(checkpoint.cursor) ===
      serializeCanonicalAttributeMap(previous.cursor)
  ) {
    return failState('A checkpoint cursor must advance after consuming a page.')
  }
  requireStableDigestStateAtSameCount(
    checkpoint.keyDigestState,
    previous.keyDigestState,
    'key',
  )
  requireStableDigestStateAtSameCount(
    checkpoint.contentDigestState,
    previous.contentDigestState,
    'content',
  )
}

/**
 * Prevents accumulator tampering when no new row was consumed.
 *
 * @param next - Candidate next digest state.
 * @param previous - Previously committed digest state.
 * @param label - Secret-free accumulator label.
 */
function requireStableDigestStateAtSameCount(
  next: MigrationDigestState,
  previous: MigrationDigestState,
  label: string,
): void {
  if (
    next.count === previous.count &&
    (
      next.sumHex !== previous.sumHex ||
      next.xorHex !== previous.xorHex
    )
  ) {
    return failState(`${label} digest state changed without new rows.`)
  }
}

/**
 * Produces a canonical JSON-safe checkpoint identity for equality checks.
 *
 * @param checkpoint - Candidate checkpoint.
 * @returns Canonical checkpoint text with an encoded opaque cursor.
 */
function checkpointFingerprint(checkpoint: MigrationSourceCheckpoint): string {
  return serializeCanonicalJson({
    completed: checkpoint.completed,
    ...(checkpoint.cursor === undefined
      ? {}
      : { cursor: encodeAttributeMap(checkpoint.cursor) }),
    aggregate: checkpoint.aggregate,
    keyDigestState: checkpoint.keyDigestState,
    contentDigestState: checkpoint.contentDigestState,
  })
}

/**
 * Checks whether a checkpoint is the exact canonical initial state.
 *
 * @param checkpoint - Candidate incomplete checkpoint.
 * @returns Whether it equals a newly created empty checkpoint.
 */
function isCanonicalEmptyCheckpoint(
  checkpoint: MigrationSourceCheckpoint,
): boolean {
  return checkpointFingerprint(checkpoint) === checkpointFingerprint(
    createEmptyWorkspaceSearchMigrationCheckpoint(),
  )
}

/**
 * Requires one exact lifecycle status.
 *
 * @param state - Current migration run.
 * @param status - Only permitted status for the transition.
 */
function requireStatus(
  state: WorkspaceSearchMigrationRunState,
  status: WorkspaceSearchMigrationRunState['status'],
): void {
  if (state.status !== status) {
    return failState(`Migration transition requires ${status} status.`)
  }
}

/**
 * Requires one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @param label - Secret-free field label.
 */
function requireCanonicalTime(value: string, label: string): void {
  if (!isCanonicalTimestamp(value)) {
    return failState(`${label} must be a canonical UTC timestamp.`)
  }
}

/**
 * Requires one positive safe integer.
 *
 * @param value - Candidate number.
 * @param label - Secret-free field label.
 */
function requirePositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    return failState(`${label} must be a positive safe integer.`)
  }
}

/**
 * Requires one non-negative safe integer.
 *
 * @param value - Candidate number.
 * @param label - Secret-free field label.
 */
function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    return failState(`${label} must be a non-negative safe integer.`)
  }
}

/**
 * Requires one canonical lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @param label - Secret-free field label.
 */
function requireDigest(value: string, label: string): void {
  if (!isHexDigest(value)) {
    return failState(`${label} must be a lowercase SHA-256 digest.`)
  }
}

/**
 * Requires one nonblank string without exposing its value.
 *
 * @param value - Candidate text.
 * @param label - Secret-free field label.
 */
function requireNonEmptyText(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    return failState(`${label} must be nonempty and exactly trimmed.`)
  }
}

/**
 * Raises a stable invalid-state failure.
 *
 * @param message - Secret-free operator guidance.
 */
function failState(message: string): never {
  throw new WorkspaceSearchMigrationFailure('INVALID_STATE', message)
}

/**
 * Raises a stable lost-lease failure.
 *
 * @param message - Secret-free operator guidance.
 */
function failLease(message: string): never {
  throw new WorkspaceSearchMigrationFailure('LEASE_LOST', message)
}

/**
 * Raises a stable invalid-maintenance-evidence failure.
 *
 * @param message - Secret-free operator guidance.
 */
function failEvidence(message: string): never {
  throw new WorkspaceSearchMigrationFailure(
    'INVALID_MAINTENANCE_EVIDENCE',
    message,
  )
}

/**
 * Raises a stable verification failure.
 *
 * @param message - Secret-free operator guidance.
 */
function failVerify(message: string): never {
  throw new WorkspaceSearchMigrationFailure('VERIFY_FAILED', message)
}
