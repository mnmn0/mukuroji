import { types as nodeUtilTypes } from 'node:util'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
} from './dynamodb-attribute-codec'
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
  type WorkspaceSearchAlreadyCurrentOperationMarker,
  type WorkspaceSearchMigrationTraversalProgress,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchOperationMarker,
  type WorkspaceSearchOperationReceipt,
  workspaceSearchMigrationSourceNames,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  zeroHexDigest,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES,
} from './migration-journal'
import {
  createEmptyWorkspaceSearchMigrationTraversal,
  reduceWorkspaceSearchMigrationRunState,
  validateWorkspaceSearchMigrationCheckpoint,
  validateWorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationAuthority,
  type WorkspaceSearchMigrationCheckpointLocation,
} from './migration-state-machine'
import {
  hasCanonicalDenseArrayShape,
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/**
 * Maximum canonical bytes accepted for one mutable operation-phase envelope.
 */
export const WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES =
  64 * 1024

const maximumTextLength = 1_024

/**
 * Stable raw-value-free failure raised for an invalid mutable execution state.
 */
export class WorkspaceSearchMigrationExecutionStateError extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code = 'INVALID_MIGRATION_EXECUTION_STATE'

  /** Creates one stable mutable-state contract failure. */
  constructor() {
    super('INVALID_MIGRATION_EXECUTION_STATE')
    this.name = 'WorkspaceSearchMigrationExecutionStateError'
  }
}

/** Shared flat mutable fields persisted by every execution-state version. */
type WorkspaceSearchMigrationExecutionStateFields = {
  /** Mutable execution-state envelope discriminator. */
  readonly kind: 'workspace-search-migration-execution-state'
  /** Stable migration identifier. */
  readonly migrationId: typeof WORKSPACE_SEARCH_MIGRATION_ID
  /** Migration behavior version. */
  readonly migrationVersion: typeof WORKSPACE_SEARCH_MIGRATION_VERSION
  /** Digest of the exact immutable revision-one admission row. */
  readonly executionRunDigest: string
  /** Operator-selected migration run bound by admission. */
  readonly runId: string
  /** Reviewed measured-configuration digest bound by admission. */
  readonly configurationHash: string
  /** Positive optimistic-concurrency revision after this durable progress. */
  readonly revision: number
  /** Operation-phase lifecycle status supported by this codec revision. */
  readonly status: 'applying'
  /** Exact number of durable apply markers after this operation. */
  readonly appliedOperationCount: number
  /** Restorable digest accumulator containing every durable apply marker. */
  readonly applyMarkerDigestState: MigrationDigestState
  /** Highest committed mutating journal sequence. */
  readonly journalSequence: number
  /** Hash-chain head for the highest committed mutating journal sequence. */
  readonly journalHeadDigest: string
  /**
   * Earliest immutable journal retention deadline among committed mutations.
   */
  readonly minimumJournalRetainUntil?: string
  /** Canonical UTC time of the durable progress represented by this state. */
  readonly updatedAt: string
  /** Digest of the complete losslessly encoded reconstructed run state. */
  readonly runStateDigest: string
  /** Digest of every preceding canonical envelope field. */
  readonly executionStateDigest: string
}

/**
 * Legacy operation-only mutable state rooted in one immutable admission row.
 */
export type WorkspaceSearchMigrationExecutionStateV1 =
  WorkspaceSearchMigrationExecutionStateFields & {
    /** Legacy operation-only envelope schema version. */
    readonly executionStateVersion: 1
  }

/**
 * Mutable applying state that durably retains complete apply traversal.
 */
export type WorkspaceSearchMigrationExecutionStateV2 =
  WorkspaceSearchMigrationExecutionStateFields & {
    /** Traversal-capable mutable envelope schema version. */
    readonly executionStateVersion: 2
    /** Complete durable source and target apply traversal. */
    readonly apply: WorkspaceSearchMigrationTraversalProgress
  }

/**
 * Supported legacy operation-only and traversal-capable mutable state.
 */
export type WorkspaceSearchMigrationExecutionState =
  | WorkspaceSearchMigrationExecutionStateV1
  | WorkspaceSearchMigrationExecutionStateV2

/**
 * Exact material consumed by one pure mutable operation-state reduction.
 */
export type CreateWorkspaceSearchMigrationExecutionStateInput = {
  /** Immutable revision-one admission row that roots the mutable state. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** Previous mutable operation state, absent only for the first operation. */
  readonly predecessor?: WorkspaceSearchMigrationExecutionState
  /** Complete state-machine result expected after exactly one operation. */
  readonly nextRunState: WorkspaceSearchMigrationRunState
  /** Exact no-op or mutating marker responsible for the state transition. */
  readonly marker: WorkspaceSearchOperationMarker
}

/**
 * Exact material consumed by one pure apply-checkpoint reduction.
 */
export type CreateWorkspaceSearchMigrationCheckpointExecutionStateInput = {
  /** Immutable revision-one admission row that roots the mutable state. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** Previous mutable state, absent only before the first durable progress. */
  readonly predecessor?: WorkspaceSearchMigrationExecutionState
  /** Active fenced lease and trusted checkpoint commit time. */
  readonly authority: WorkspaceSearchMigrationAuthority
  /** Source or target traversal advanced by the checkpoint. */
  readonly location: WorkspaceSearchMigrationCheckpointLocation
  /** Complete cumulative checkpoint produced after one bounded page. */
  readonly checkpoint: MigrationSourceCheckpoint
}

/**
 * Reduces one immutable admission or mutable predecessor by exactly one marker.
 *
 * This operation accepts only the operation-phase fields changed by the
 * existing state-machine reducer. Traversal remains canonical-empty,
 * maintenance evidence remains admission-bound, and lifecycle status remains
 * applying in this codec revision.
 *
 * @param input - Admission, optional predecessor, next state, and exact marker.
 * @returns Detached canonical mutable execution-state envelope.
 */
export function createWorkspaceSearchMigrationExecutionState(
  input: CreateWorkspaceSearchMigrationExecutionStateInput,
): WorkspaceSearchMigrationExecutionStateV1 {
  return atExecutionStateBoundary(() => {
    const inputRecord = requireRecord(input)
    const hasPredecessor = hasOwnDataProperty(
      inputRecord,
      'predecessor',
    )
    requireExactKeys(
      inputRecord,
      hasPredecessor
        ? ['admission', 'marker', 'nextRunState', 'predecessor']
        : ['admission', 'marker', 'nextRunState'],
    )

    const admission = detachAdmission(input.admission)
    const predecessor = hasPredecessor
      ? readRuntimeExecutionState(input.predecessor)
      : undefined
    if (
      predecessor !== undefined &&
      predecessor.executionStateVersion !== 1
    ) {
      return failExecutionState()
    }
    const current = predecessor === undefined
      ? admission.runState
      : reconstructRunState(admission, predecessor)
    requireOperationPhaseBase(admission, current)

    const marker = readOperationMarker(input.marker)
    requireMarkerTransition(current, marker)
    if (
      current.revision === Number.MAX_SAFE_INTEGER ||
      current.appliedOperationCount === Number.MAX_SAFE_INTEGER
    ) {
      return failExecutionState()
    }

    const markerAccumulator = MigrationDigestAccumulator.fromState(
      current.applyMarkerDigestState,
    )
    markerAccumulator.add(createMigrationDigest(marker))
    const markerDigestState = markerAccumulator.exportState()
    const markerTime = marker.kind ===
        'workspace-search-operation-applied'
      ? marker.committedAt
      : marker.recordedAt
    const minimumJournalRetainUntil = nextMinimumJournalRetainUntil(
      predecessor?.minimumJournalRetainUntil,
      marker,
    )
    if (
      minimumJournalRetainUntil !== undefined &&
      Date.parse(minimumJournalRetainUntil) <=
        Date.parse(markerTime)
    ) {
      return failExecutionState()
    }
    const next = createExpectedNextRunState(
      current,
      marker,
      markerDigestState,
      markerTime,
    )
    requireExactJsonValue(input.nextRunState, next)
    validateWorkspaceSearchMigrationRunState(next)

    const runStateDigest = createMigrationDigest(next)
    return createV1ExecutionStateEnvelope(
      admission,
      next,
      minimumJournalRetainUntil,
      runStateDigest,
    )
  })
}

/**
 * Reduces admission or one v1/v2 predecessor by one apply checkpoint.
 *
 * The state-machine reducer owns authority, lifecycle, operation durability,
 * cursor-schema, and monotonic-progress validation. The expected revision and
 * complete successor are derived internally rather than supplied by callers.
 *
 * @param input - Admission root, predecessor, authority, location, and page.
 * @returns Detached canonical traversal-capable mutable state.
 */
export function createWorkspaceSearchMigrationCheckpointExecutionState(
  input: CreateWorkspaceSearchMigrationCheckpointExecutionStateInput,
): WorkspaceSearchMigrationExecutionStateV2 {
  return atExecutionStateBoundary(() => {
    const inputRecord = requireRecord(input)
    const hasPredecessor = hasOwnDataProperty(
      inputRecord,
      'predecessor',
    )
    requireExactKeys(
      inputRecord,
      hasPredecessor
        ? [
            'admission',
            'authority',
            'checkpoint',
            'location',
            'predecessor',
          ]
        : ['admission', 'authority', 'checkpoint', 'location'],
    )

    const admission = detachAdmission(input.admission)
    const predecessor = hasPredecessor
      ? readRuntimeExecutionState(
          readOwn(inputRecord, 'predecessor'),
        )
      : undefined
    const current = predecessor === undefined
      ? admission.runState
      : reconstructRunState(admission, predecessor)
    requireAdmissionBoundApplyingState(admission, current)

    const authority = readAuthority(
      readOwn(inputRecord, 'authority'),
    )
    const location = readCheckpointLocation(
      readOwn(inputRecord, 'location'),
    )
    const checkpoint = readRuntimeCheckpoint(
      readOwn(inputRecord, 'checkpoint'),
    )
    const next = reduceWorkspaceSearchMigrationRunState({
      current,
      expectedRevision: current.revision,
      authority,
      event: {
        kind: 'apply-checkpoint-recorded',
        location,
        checkpoint,
      },
    })
    requireAdmissionBoundApplyingState(admission, next)
    requireV2RevisionShape(next)

    return createV2ExecutionStateEnvelope(
      admission,
      next,
      predecessor?.minimumJournalRetainUntil,
      createV2RunStateDigest(next),
    )
  })
}

/**
 * Reconstructs a complete validated run state from admission and flat mutation.
 *
 * @param admission - Exact immutable revision-one execution admission.
 * @param executionState - Candidate mutable operation-phase envelope.
 * @returns Complete detached state-machine value.
 */
export function reconstructWorkspaceSearchMigrationRunState(
  admission: WorkspaceSearchMigrationExecutionRun,
  executionState: WorkspaceSearchMigrationExecutionState,
): WorkspaceSearchMigrationRunState {
  return atExecutionStateBoundary(() => {
    const detachedAdmission = detachAdmission(admission)
    const detachedState = readRuntimeExecutionState(executionState)
    return reconstructRunState(detachedAdmission, detachedState)
  })
}

/**
 * Serializes one strict mutable execution state as canonical UTF-8 JSON.
 *
 * @param value - Candidate mutable execution-state envelope.
 * @returns Exact bounded canonical JSON bytes without a trailing newline.
 */
export function serializeWorkspaceSearchMigrationExecutionState(
  value: WorkspaceSearchMigrationExecutionState,
): Uint8Array {
  return atExecutionStateBoundary(() =>
    encodeCanonicalExecutionState(readRuntimeExecutionState(value))
  )
}

/**
 * Parses one exact canonical mutable execution-state document.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict mutable execution-state envelope.
 */
export function parseWorkspaceSearchMigrationExecutionState(
  bytes: Uint8Array,
): WorkspaceSearchMigrationExecutionState {
  return atExecutionStateBoundary(() => {
    const snapshot = copyBoundedBytes(bytes)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot)
    } catch {
      return failExecutionState()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failExecutionState()
    }
    const executionState = readEncodedExecutionState(parsed)
    const canonical = encodeCanonicalExecutionState(executionState)
    if (!equalBytes(snapshot, canonical)) return failExecutionState()
    return executionState
  })
}

/**
 * Serializes one strict durable operation marker as canonical UTF-8 JSON.
 *
 * @param value - Candidate no-op or mutating operation marker.
 * @returns Exact bounded canonical JSON bytes without a trailing newline.
 */
export function serializeWorkspaceSearchMigrationOperationMarker(
  value: WorkspaceSearchOperationMarker,
): Uint8Array {
  return atExecutionStateBoundary(() =>
    encodeCanonicalOperationMarker(readOperationMarker(value))
  )
}

/**
 * Parses one exact canonical durable operation-marker document.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict no-op or mutating operation marker.
 */
export function parseWorkspaceSearchMigrationOperationMarker(
  bytes: Uint8Array,
): WorkspaceSearchOperationMarker {
  return atExecutionStateBoundary(() => {
    const snapshot = copyBoundedBytes(bytes)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(snapshot)
    } catch {
      return failExecutionState()
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failExecutionState()
    }
    const marker = readOperationMarker(parsed)
    const canonical = encodeCanonicalOperationMarker(marker)
    if (!equalBytes(snapshot, canonical)) return failExecutionState()
    return marker
  })
}

/**
 * Detaches one immutable admission through its strict canonical codec.
 *
 * @param admission - Candidate immutable execution admission.
 * @returns Detached strict revision-one admission.
 */
function detachAdmission(
  admission: WorkspaceSearchMigrationExecutionRun,
): WorkspaceSearchMigrationExecutionRun {
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(admission),
  )
}

/**
 * Reconstructs one complete state without remapping boundary failures.
 *
 * @param admission - Detached immutable admission.
 * @param executionState - Detached mutable flat state.
 * @returns Complete validated operation-phase state.
 */
function reconstructRunState(
  admission: WorkspaceSearchMigrationExecutionRun,
  executionState: WorkspaceSearchMigrationExecutionState,
): WorkspaceSearchMigrationRunState {
  if (
    executionState.executionRunDigest !==
      admission.executionRunDigest ||
    executionState.runId !== admission.runId ||
    executionState.configurationHash !==
      admission.configurationHash
  ) {
    return failExecutionState()
  }
  const runState: WorkspaceSearchMigrationRunState = {
    ...admission.runState,
    revision: executionState.revision,
    status: executionState.status,
    appliedOperationCount:
      executionState.appliedOperationCount,
    applyMarkerDigestState:
      executionState.applyMarkerDigestState,
    journalSequence: executionState.journalSequence,
    journalHeadDigest: executionState.journalHeadDigest,
    apply: executionState.executionStateVersion === 1
      ? admission.runState.apply
      : executionState.apply,
    updatedAt: executionState.updatedAt,
  }
  if (executionState.executionStateVersion === 1) {
    requireOperationPhaseBase(admission, runState)
  } else {
    requireAdmissionBoundApplyingState(admission, runState)
    requireV2RevisionShape(runState)
  }
  if (
    executionState.appliedOperationCount >
      admission.runState.planOperationCount ||
    executionState.runStateDigest !==
      (
        executionState.executionStateVersion === 1
          ? createMigrationDigest(runState)
          : createV2RunStateDigest(runState)
      )
  ) {
    return failExecutionState()
  }
  validateWorkspaceSearchMigrationRunState(runState)
  return runState
}

/**
 * Requires all immutable and non-operation fields to remain admission-bound.
 *
 * @param admission - Immutable revision-one admission.
 * @param state - Complete candidate operation-phase state.
 */
function requireOperationPhaseBase(
  admission: WorkspaceSearchMigrationExecutionRun,
  state: WorkspaceSearchMigrationRunState,
): void {
  if (
    state.status !== 'applying' ||
    serializeCanonicalJson(state.apply) !==
      serializeCanonicalJson(
        createEmptyWorkspaceSearchMigrationTraversal(),
      )
  ) {
    return failExecutionState()
  }
  requireAdmissionBoundApplyingState(admission, state)
}

/**
 * Requires every admission-immutable field to remain exactly bound.
 *
 * @param admission - Immutable revision-one admission.
 * @param state - Complete candidate applying state.
 */
function requireAdmissionBoundApplyingState(
  admission: WorkspaceSearchMigrationExecutionRun,
  state: WorkspaceSearchMigrationRunState,
): void {
  if (state.status !== 'applying') return failExecutionState()
  const immutableExpected = {
    runId: admission.runState.runId,
    configurationHash:
      admission.runState.configurationHash,
    configuration: admission.runState.configuration,
    maintenanceEvidenceDigest:
      admission.runState.maintenanceEvidenceDigest,
    maintenanceEvidenceLocator:
      admission.runState.maintenanceEvidenceLocator,
    maintenanceEvidenceReceipt:
      admission.runState.maintenanceEvidenceReceipt,
    dryRunEvidenceDigest:
      admission.runState.dryRunEvidenceDigest,
    planDigest: admission.runState.planDigest,
    planOperationCount:
      admission.runState.planOperationCount,
    planSealReference:
      admission.runState.planSealReference,
    createdAt: admission.runState.createdAt,
  }
  const immutableActual = {
    runId: state.runId,
    configurationHash: state.configurationHash,
    configuration: state.configuration,
    maintenanceEvidenceDigest:
      state.maintenanceEvidenceDigest,
    maintenanceEvidenceLocator:
      state.maintenanceEvidenceLocator,
    maintenanceEvidenceReceipt:
      state.maintenanceEvidenceReceipt,
    dryRunEvidenceDigest: state.dryRunEvidenceDigest,
    planDigest: state.planDigest,
    planOperationCount: state.planOperationCount,
    planSealReference: state.planSealReference,
    createdAt: state.createdAt,
  }
  if (
    serializeCanonicalJson(immutableActual) !==
      serializeCanonicalJson(immutableExpected)
  ) {
    return failExecutionState()
  }
}

/**
 * Requires one marker to describe the next contiguous applying operation.
 *
 * @param current - Complete current applying state.
 * @param marker - Detached strict operation marker.
 */
function requireMarkerTransition(
  current: WorkspaceSearchMigrationRunState,
  marker: WorkspaceSearchOperationMarker,
): void {
  const markerTime = marker.kind ===
      'workspace-search-operation-applied'
    ? marker.committedAt
    : marker.recordedAt
  if (
    marker.runId !== current.runId ||
    marker.configurationHash !== current.configurationHash ||
    marker.planSequence !==
      current.appliedOperationCount + 1 ||
    marker.planSequence > current.planOperationCount ||
    marker.fenceToken !==
      current.maintenanceEvidenceReceipt.fenceToken ||
    marker.maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(current.maintenanceEvidenceReceipt) ||
    Date.parse(markerTime) < Date.parse(current.updatedAt)
  ) {
    return failExecutionState()
  }
  if (
    marker.kind === 'workspace-search-operation-applied' &&
    (
      marker.sequence !== current.journalSequence + 1 ||
      Date.parse(marker.journal.retainUntil) <=
        Date.parse(marker.committedAt)
    )
  ) {
    return failExecutionState()
  }
}

/**
 * Creates the exact next state implied by one already-validated marker.
 *
 * @param current - Complete current applying state.
 * @param marker - Exact marker responsible for the operation.
 * @param markerDigestState - Accumulator after adding the marker digest.
 * @param markerTime - Canonical marker commit or record time.
 * @returns Complete expected next state-machine value.
 */
function createExpectedNextRunState(
  current: WorkspaceSearchMigrationRunState,
  marker: WorkspaceSearchOperationMarker,
  markerDigestState: MigrationDigestState,
  markerTime: string,
): WorkspaceSearchMigrationRunState {
  if (marker.kind === 'workspace-search-operation-applied') {
    return {
      ...current,
      revision: current.revision + 1,
      appliedOperationCount:
        current.appliedOperationCount + 1,
      applyMarkerDigestState: markerDigestState,
      journalSequence: marker.sequence,
      journalHeadDigest: marker.journal.headDigest,
      updatedAt: markerTime,
    }
  }
  return {
    ...current,
    revision: current.revision + 1,
    appliedOperationCount:
      current.appliedOperationCount + 1,
    applyMarkerDigestState: markerDigestState,
    updatedAt: markerTime,
  }
}

/**
 * Selects the cumulative earliest retention deadline for journal evidence.
 *
 * @param previous - Previous cumulative minimum, when any mutation exists.
 * @param marker - Current no-op or mutating marker.
 * @returns Unchanged or newly accumulated minimum retention deadline.
 */
function nextMinimumJournalRetainUntil(
  previous: string | undefined,
  marker: WorkspaceSearchOperationMarker,
): string | undefined {
  if (marker.kind === 'workspace-search-operation-already-current') {
    return previous
  }
  if (
    previous === undefined ||
    Date.parse(marker.journal.retainUntil) <
      Date.parse(previous)
  ) {
    return marker.journal.retainUntil
  }
  return previous
}

/**
 * Creates one flat envelope and its final self-digest.
 *
 * @param admission - Immutable admission root.
 * @param next - Complete validated next state.
 * @param minimumJournalRetainUntil - Cumulative journal deadline.
 * @param runStateDigest - Digest of the complete next state.
 * @returns Strict mutable execution-state envelope.
 */
function createV1ExecutionStateEnvelope(
  admission: WorkspaceSearchMigrationExecutionRun,
  next: WorkspaceSearchMigrationRunState,
  minimumJournalRetainUntil: string | undefined,
  runStateDigest: string,
): WorkspaceSearchMigrationExecutionStateV1 {
  if (minimumJournalRetainUntil === undefined) {
    const fields = {
      kind: 'workspace-search-migration-execution-state',
      executionStateVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      executionRunDigest: admission.executionRunDigest,
      runId: admission.runId,
      configurationHash: admission.configurationHash,
      revision: next.revision,
      status: 'applying',
      appliedOperationCount: next.appliedOperationCount,
      applyMarkerDigestState: next.applyMarkerDigestState,
      journalSequence: next.journalSequence,
      journalHeadDigest: next.journalHeadDigest,
      updatedAt: next.updatedAt,
      runStateDigest,
    } satisfies Omit<
      WorkspaceSearchMigrationExecutionStateV1,
      'executionStateDigest'
    >
    const envelope = {
      ...fields,
      executionStateDigest: createMigrationDigest(fields),
    }
    void encodeCanonicalExecutionState(envelope)
    return envelope
  }
  const fields = {
    kind: 'workspace-search-migration-execution-state',
    executionStateVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    executionRunDigest: admission.executionRunDigest,
    runId: admission.runId,
    configurationHash: admission.configurationHash,
    revision: next.revision,
    status: 'applying',
    appliedOperationCount: next.appliedOperationCount,
    applyMarkerDigestState: next.applyMarkerDigestState,
    journalSequence: next.journalSequence,
    journalHeadDigest: next.journalHeadDigest,
    minimumJournalRetainUntil,
    updatedAt: next.updatedAt,
    runStateDigest,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionStateV1,
    'executionStateDigest'
  >
  const envelope = {
    ...fields,
    executionStateDigest: createMigrationDigest(fields),
  }
  void encodeCanonicalExecutionState(envelope)
  return envelope
}

/**
 * Creates one traversal-capable envelope and its final self-digest.
 *
 * @param admission - Immutable admission root.
 * @param next - Complete validated next applying state.
 * @param minimumJournalRetainUntil - Cumulative journal deadline.
 * @param runStateDigest - Digest of the losslessly encoded complete next state.
 * @returns Strict traversal-capable mutable execution-state envelope.
 */
function createV2ExecutionStateEnvelope(
  admission: WorkspaceSearchMigrationExecutionRun,
  next: WorkspaceSearchMigrationRunState,
  minimumJournalRetainUntil: string | undefined,
  runStateDigest: string,
): WorkspaceSearchMigrationExecutionStateV2 {
  const common = {
    kind: 'workspace-search-migration-execution-state',
    executionStateVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    executionRunDigest: admission.executionRunDigest,
    runId: admission.runId,
    configurationHash: admission.configurationHash,
    revision: next.revision,
    status: 'applying',
    appliedOperationCount: next.appliedOperationCount,
    applyMarkerDigestState: next.applyMarkerDigestState,
    journalSequence: next.journalSequence,
    journalHeadDigest: next.journalHeadDigest,
    apply: next.apply,
  } satisfies Pick<
    WorkspaceSearchMigrationExecutionStateV2,
    | 'kind'
    | 'executionStateVersion'
    | 'migrationId'
    | 'migrationVersion'
    | 'executionRunDigest'
    | 'runId'
    | 'configurationHash'
    | 'revision'
    | 'status'
    | 'appliedOperationCount'
    | 'applyMarkerDigestState'
    | 'journalSequence'
    | 'journalHeadDigest'
    | 'apply'
  >
  const tail = {
    updatedAt: next.updatedAt,
    runStateDigest,
  }
  const fields = minimumJournalRetainUntil === undefined
    ? {
        ...common,
        ...tail,
      }
    : {
        ...common,
        minimumJournalRetainUntil,
        ...tail,
      }
  const envelope: WorkspaceSearchMigrationExecutionStateV2 = {
    ...fields,
    executionStateDigest: createV2ExecutionStateDigest(fields),
  }
  void encodeCanonicalExecutionState(
    readRuntimeExecutionState(envelope),
  )
  return envelope
}

/**
 * Reads a runtime envelope whose v2 cursor uses raw AttributeValue maps.
 *
 * @param value - Candidate runtime execution state.
 * @returns Detached strict supported execution state.
 */
function readRuntimeExecutionState(
  value: unknown,
): WorkspaceSearchMigrationExecutionState {
  const record = requireRecord(value)
  const version = readOwn(record, 'executionStateVersion')
  if (version === 1) return readV1ExecutionState(record)
  if (version === 2) {
    return readV2ExecutionState(
      record,
      readRuntimeTraversal(readOwn(record, 'apply')),
    )
  }
  return failExecutionState()
}

/**
 * Reads a canonical JSON document whose v2 cursor uses tagged attributes.
 *
 * @param value - Candidate parsed execution-state document.
 * @returns Detached strict supported execution state.
 */
function readEncodedExecutionState(
  value: unknown,
): WorkspaceSearchMigrationExecutionState {
  const record = requireRecord(value)
  const version = readOwn(record, 'executionStateVersion')
  if (version === 1) return readV1ExecutionState(record)
  if (version === 2) {
    return readV2ExecutionState(
      record,
      readEncodedTraversal(readOwn(record, 'apply')),
    )
  }
  return failExecutionState()
}

/**
 * Reads and validates one legacy operation-only mutable envelope.
 *
 * @param record - Candidate runtime or parsed legacy envelope.
 * @returns Detached strict legacy mutable execution state.
 */
function readV1ExecutionState(
  record: Readonly<Record<string, unknown>>,
): WorkspaceSearchMigrationExecutionStateV1 {
  const hasMinimum = hasOwnDataProperty(
    record,
    'minimumJournalRetainUntil',
  )
  requireExactKeys(record, [
    'appliedOperationCount',
    'applyMarkerDigestState',
    'configurationHash',
    'executionRunDigest',
    'executionStateDigest',
    'executionStateVersion',
    'journalHeadDigest',
    'journalSequence',
    'kind',
    'migrationId',
    'migrationVersion',
    ...(hasMinimum ? ['minimumJournalRetainUntil'] : []),
    'revision',
    'runId',
    'runStateDigest',
    'status',
    'updatedAt',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-execution-state' ||
    readOwn(record, 'executionStateVersion') !== 1 ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    readOwn(record, 'status') !== 'applying'
  ) {
    return failExecutionState()
  }
  const revision = readPositiveSafeInteger(
    readOwn(record, 'revision'),
  )
  const appliedOperationCount = readPositiveSafeInteger(
    readOwn(record, 'appliedOperationCount'),
  )
  const applyMarkerDigestState = readDigestState(
    readOwn(record, 'applyMarkerDigestState'),
  )
  const journalSequence = readNonNegativeSafeInteger(
    readOwn(record, 'journalSequence'),
  )
  const journalHeadDigest = readDigest(
    readOwn(record, 'journalHeadDigest'),
  )
  const minimumJournalRetainUntil = hasMinimum
    ? readTimestamp(
        readOwn(record, 'minimumJournalRetainUntil'),
      )
    : undefined
  if (
    revision !== appliedOperationCount + 1 ||
    applyMarkerDigestState.count !== appliedOperationCount ||
    journalSequence > appliedOperationCount ||
    (journalSequence === 0) !==
      (journalHeadDigest === zeroHexDigest()) ||
    (journalSequence === 0) !==
      (minimumJournalRetainUntil === undefined)
  ) {
    return failExecutionState()
  }
  const common = {
    kind: 'workspace-search-migration-execution-state',
    executionStateVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    executionRunDigest: readDigest(
      readOwn(record, 'executionRunDigest'),
    ),
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    revision,
    status: 'applying',
    appliedOperationCount,
    applyMarkerDigestState,
    journalSequence,
    journalHeadDigest,
  } satisfies Pick<
    WorkspaceSearchMigrationExecutionStateV1,
    | 'kind'
    | 'executionStateVersion'
    | 'migrationId'
    | 'migrationVersion'
    | 'executionRunDigest'
    | 'runId'
    | 'configurationHash'
    | 'revision'
    | 'status'
    | 'appliedOperationCount'
    | 'applyMarkerDigestState'
    | 'journalSequence'
    | 'journalHeadDigest'
  >
  const updatedAt = readTimestamp(readOwn(record, 'updatedAt'))
  if (
    minimumJournalRetainUntil !== undefined &&
    Date.parse(minimumJournalRetainUntil) <=
      Date.parse(updatedAt)
  ) {
    return failExecutionState()
  }
  const tail = {
    updatedAt,
    runStateDigest: readDigest(
      readOwn(record, 'runStateDigest'),
    ),
  }
  const executionStateDigest = readDigest(
    readOwn(record, 'executionStateDigest'),
  )
  if (minimumJournalRetainUntil === undefined) {
    const fields = {
      ...common,
      ...tail,
    } satisfies Omit<
      WorkspaceSearchMigrationExecutionStateV1,
      'executionStateDigest'
    >
    if (executionStateDigest !== createMigrationDigest(fields)) {
      return failExecutionState()
    }
    return { ...fields, executionStateDigest }
  }
  const fields = {
    ...common,
    minimumJournalRetainUntil,
    ...tail,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionStateV1,
    'executionStateDigest'
  >
  if (executionStateDigest !== createMigrationDigest(fields)) {
    return failExecutionState()
  }
  return { ...fields, executionStateDigest }
}

/**
 * Reads and validates one traversal-capable mutable envelope.
 *
 * @param record - Candidate runtime or parsed v2 envelope.
 * @param apply - Detached traversal decoded for the source representation.
 * @returns Detached strict traversal-capable mutable execution state.
 */
function readV2ExecutionState(
  record: Readonly<Record<string, unknown>>,
  apply: WorkspaceSearchMigrationTraversalProgress,
): WorkspaceSearchMigrationExecutionStateV2 {
  const hasMinimum = hasOwnDataProperty(
    record,
    'minimumJournalRetainUntil',
  )
  requireExactKeys(record, [
    'appliedOperationCount',
    'apply',
    'applyMarkerDigestState',
    'configurationHash',
    'executionRunDigest',
    'executionStateDigest',
    'executionStateVersion',
    'journalHeadDigest',
    'journalSequence',
    'kind',
    'migrationId',
    'migrationVersion',
    ...(hasMinimum ? ['minimumJournalRetainUntil'] : []),
    'revision',
    'runId',
    'runStateDigest',
    'status',
    'updatedAt',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-migration-execution-state' ||
    readOwn(record, 'executionStateVersion') !== 2 ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    readOwn(record, 'status') !== 'applying'
  ) {
    return failExecutionState()
  }

  const revision = readPositiveSafeInteger(
    readOwn(record, 'revision'),
  )
  const appliedOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'appliedOperationCount'),
  )
  const applyMarkerDigestState = readDigestState(
    readOwn(record, 'applyMarkerDigestState'),
  )
  const journalSequence = readNonNegativeSafeInteger(
    readOwn(record, 'journalSequence'),
  )
  const journalHeadDigest = readDigest(
    readOwn(record, 'journalHeadDigest'),
  )
  const minimumJournalRetainUntil = hasMinimum
    ? readTimestamp(
        readOwn(record, 'minimumJournalRetainUntil'),
      )
    : undefined
  const expectedRevision = calculateV2Revision(
    appliedOperationCount,
    apply,
  )
  if (
    revision !== expectedRevision ||
    expectedRevision <= appliedOperationCount + 1 ||
    applyMarkerDigestState.count !== appliedOperationCount ||
    journalSequence > appliedOperationCount ||
    (journalSequence === 0) !==
      (journalHeadDigest === zeroHexDigest()) ||
    (journalSequence === 0) !==
      (minimumJournalRetainUntil === undefined)
  ) {
    return failExecutionState()
  }

  const common = {
    kind: 'workspace-search-migration-execution-state',
    executionStateVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    executionRunDigest: readDigest(
      readOwn(record, 'executionRunDigest'),
    ),
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    revision,
    status: 'applying',
    appliedOperationCount,
    applyMarkerDigestState,
    journalSequence,
    journalHeadDigest,
    apply,
  } satisfies Pick<
    WorkspaceSearchMigrationExecutionStateV2,
    | 'kind'
    | 'executionStateVersion'
    | 'migrationId'
    | 'migrationVersion'
    | 'executionRunDigest'
    | 'runId'
    | 'configurationHash'
    | 'revision'
    | 'status'
    | 'appliedOperationCount'
    | 'applyMarkerDigestState'
    | 'journalSequence'
    | 'journalHeadDigest'
    | 'apply'
  >
  const updatedAt = readTimestamp(readOwn(record, 'updatedAt'))
  if (
    minimumJournalRetainUntil !== undefined &&
    Date.parse(minimumJournalRetainUntil) <=
      Date.parse(updatedAt)
  ) {
    return failExecutionState()
  }
  const tail = {
    updatedAt,
    runStateDigest: readDigest(
      readOwn(record, 'runStateDigest'),
    ),
  }
  const executionStateDigest = readDigest(
    readOwn(record, 'executionStateDigest'),
  )
  const fields = minimumJournalRetainUntil === undefined
    ? {
        ...common,
        ...tail,
      }
    : {
        ...common,
        minimumJournalRetainUntil,
        ...tail,
      }
  if (
    executionStateDigest !==
      createV2ExecutionStateDigest(fields)
  ) {
    return failExecutionState()
  }
  return { ...fields, executionStateDigest }
}

/**
 * Reads one strict runtime traversal with raw DynamoDB cursors.
 *
 * @param value - Candidate runtime traversal.
 * @returns Detached validated traversal.
 */
function readRuntimeTraversal(
  value: unknown,
): WorkspaceSearchMigrationTraversalProgress {
  return readTraversal(value, false)
}

/**
 * Reads one strict encoded traversal with tagged DynamoDB cursors.
 *
 * @param value - Candidate JSON-safe traversal.
 * @returns Detached validated traversal.
 */
function readEncodedTraversal(
  value: unknown,
): WorkspaceSearchMigrationTraversalProgress {
  return readTraversal(value, true)
}

/**
 * Reads one complete exact-key source and target traversal.
 *
 * @param value - Candidate traversal.
 * @param encoded - Whether cursor maps use the tagged JSON representation.
 * @returns Detached validated traversal.
 */
function readTraversal(
  value: unknown,
  encoded: boolean,
): WorkspaceSearchMigrationTraversalProgress {
  const record = requireRecord(value)
  requireExactKeys(record, ['sources', 'target'])
  const sources = requireRecord(readOwn(record, 'sources'))
  requireExactKeys(sources, workspaceSearchMigrationSourceNames)
  const readCheckpoint = encoded
    ? readEncodedCheckpoint
    : readRuntimeCheckpoint
  return {
    sources: {
      'project-directory': readCheckpoint(
        readOwn(sources, 'project-directory'),
      ),
      'work-items': readCheckpoint(
        readOwn(sources, 'work-items'),
      ),
      collaboration: readCheckpoint(
        readOwn(sources, 'collaboration'),
      ),
      documents: readCheckpoint(
        readOwn(sources, 'documents'),
      ),
    },
    target: readCheckpoint(readOwn(record, 'target')),
  }
}

/**
 * Reads one strict checkpoint whose cursor is a raw AttributeValue map.
 *
 * @param value - Candidate runtime checkpoint.
 * @returns Detached validated checkpoint.
 */
function readRuntimeCheckpoint(
  value: unknown,
): MigrationSourceCheckpoint {
  return readCheckpoint(value, false)
}

/**
 * Reads one strict checkpoint whose cursor is a tagged AttributeValue map.
 *
 * @param value - Candidate encoded checkpoint.
 * @returns Detached validated checkpoint.
 */
function readEncodedCheckpoint(
  value: unknown,
): MigrationSourceCheckpoint {
  return readCheckpoint(value, true)
}

/**
 * Reads one strict cumulative checkpoint representation.
 *
 * @param value - Candidate checkpoint.
 * @param encoded - Whether an optional cursor uses tagged attributes.
 * @returns Detached validated raw checkpoint.
 */
function readCheckpoint(
  value: unknown,
  encoded: boolean,
): MigrationSourceCheckpoint {
  const record = requireRecord(value)
  const hasCursor = hasOwnDataProperty(record, 'cursor')
  requireExactKeys(
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
  const completed = readBoolean(readOwn(record, 'completed'))
  const cursor = hasCursor
    ? readCheckpointCursor(
        readOwn(record, 'cursor'),
        encoded,
      )
    : undefined
  const checkpoint: MigrationSourceCheckpoint = cursor === undefined
    ? {
        completed,
        aggregate: readAggregate(readOwn(record, 'aggregate')),
        keyDigestState: readDigestState(
          readOwn(record, 'keyDigestState'),
        ),
        contentDigestState: readDigestState(
          readOwn(record, 'contentDigestState'),
        ),
      }
    : {
        completed,
        cursor,
        aggregate: readAggregate(readOwn(record, 'aggregate')),
        keyDigestState: readDigestState(
          readOwn(record, 'keyDigestState'),
        ),
        contentDigestState: readDigestState(
          readOwn(record, 'contentDigestState'),
        ),
      }
  validateWorkspaceSearchMigrationCheckpoint(checkpoint)
  return checkpoint
}

/**
 * Reads and detaches one raw or tagged checkpoint cursor.
 *
 * @param value - Candidate cursor representation.
 * @param encoded - Whether the cursor uses tagged attributes.
 * @returns Detached raw low-level DynamoDB key.
 */
function readCheckpointCursor(
  value: unknown,
  encoded: boolean,
): MigrationSourceCheckpoint['cursor'] {
  requireCanonicalDataGraph(value, new WeakSet<object>())
  if (encoded) return decodeAttributeMap(value)
  return decodeAttributeMap(encodeUnknownAttributeMap(value))
}

/**
 * Reads one strict cumulative scan aggregate.
 *
 * @param value - Candidate aggregate.
 * @returns Detached validated aggregate.
 */
function readAggregate(value: unknown): MigrationScanAggregate {
  const record = requireRecord(value)
  requireExactKeys(record, [
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
  const aggregate: MigrationScanAggregate = {
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
  return aggregate
}

/**
 * Reads one strict checkpoint transition authority.
 *
 * @param value - Candidate active authority.
 * @returns Detached authority for the state-machine reducer.
 */
function readAuthority(
  value: unknown,
): WorkspaceSearchMigrationAuthority {
  const record = requireRecord(value)
  requireExactKeys(record, ['at', 'lease', 'ownerId'])
  const leaseRecord = requireRecord(readOwn(record, 'lease'))
  requireExactKeys(leaseRecord, [
    'expiresAt',
    'fenceToken',
    'heartbeatAt',
    'ownerId',
    'runId',
  ])
  return {
    lease: {
      runId: readIdentifier(readOwn(leaseRecord, 'runId')),
      ownerId: readIdentifier(readOwn(leaseRecord, 'ownerId')),
      fenceToken: readPositiveSafeInteger(
        readOwn(leaseRecord, 'fenceToken'),
      ),
      heartbeatAt: readTimestamp(
        readOwn(leaseRecord, 'heartbeatAt'),
      ),
      expiresAt: readTimestamp(
        readOwn(leaseRecord, 'expiresAt'),
      ),
    },
    ownerId: readIdentifier(readOwn(record, 'ownerId')),
    at: readTimestamp(readOwn(record, 'at')),
  }
}

/**
 * Reads one exact apply-checkpoint location.
 *
 * @param value - Candidate source or target location.
 * @returns Valid checkpoint location.
 */
function readCheckpointLocation(
  value: unknown,
): WorkspaceSearchMigrationCheckpointLocation {
  if (
    value === 'project-directory' ||
    value === 'work-items' ||
    value === 'collaboration' ||
    value === 'documents' ||
    value === 'target'
  ) {
    return value
  }
  return failExecutionState()
}

/**
 * Reads one exact Boolean.
 *
 * @param value - Candidate Boolean.
 * @returns Validated Boolean.
 */
function readBoolean(value: unknown): boolean {
  if (value !== true && value !== false) {
    return failExecutionState()
  }
  return value
}

/**
 * Calculates the only structurally valid v2 revision.
 *
 * @param appliedOperationCount - Exact durable operation count.
 * @param apply - Complete five-location apply traversal.
 * @returns One plus operations plus every durable checkpoint page.
 */
function calculateV2Revision(
  appliedOperationCount: number,
  apply: WorkspaceSearchMigrationTraversalProgress,
): number {
  let revision = addSafeCounts(1, appliedOperationCount)
  for (const source of workspaceSearchMigrationSourceNames) {
    revision = addSafeCounts(
      revision,
      apply.sources[source].aggregate.pageCount,
    )
  }
  return addSafeCounts(
    revision,
    apply.target.aggregate.pageCount,
  )
}

/**
 * Requires a complete run state to satisfy the v2 revision formula.
 *
 * @param state - Candidate traversal-capable applying state.
 */
function requireV2RevisionShape(
  state: WorkspaceSearchMigrationRunState,
): void {
  const expected = calculateV2Revision(
    state.appliedOperationCount,
    state.apply,
  )
  if (
    state.revision !== expected ||
    expected <= state.appliedOperationCount + 1
  ) {
    return failExecutionState()
  }
}

/**
 * Adds two nonnegative counts without exceeding the safe integer range.
 *
 * @param left - Existing nonnegative count.
 * @param right - Additional nonnegative count.
 * @returns Safe exact sum.
 */
function addSafeCounts(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum) || sum < 0) {
    return failExecutionState()
  }
  return sum
}

/**
 * Creates the v2 digest of a complete reconstructed run state.
 *
 * @param state - Complete validated applying state.
 * @returns Digest of the losslessly encoded state.
 */
function createV2RunStateDigest(
  state: WorkspaceSearchMigrationRunState,
): string {
  return createMigrationDigest({
    ...state,
    apply: encodeTraversal(state.apply),
  })
}

/**
 * Creates one v2 envelope self-digest over its encoded preceding fields.
 *
 * @param fields - Every v2 envelope field except its self-digest.
 * @returns Lowercase digest of the canonical lossless representation.
 */
function createV2ExecutionStateDigest(
  fields: Omit<
    WorkspaceSearchMigrationExecutionStateV2,
    'executionStateDigest'
  >,
): string {
  return createMigrationDigest({
    ...fields,
    apply: encodeTraversal(fields.apply),
  })
}

/**
 * Encodes one complete traversal with lossless tagged cursor maps.
 *
 * @param traversal - Validated raw traversal.
 * @returns Canonical JSON-safe traversal representation.
 */
function encodeTraversal(
  traversal: WorkspaceSearchMigrationTraversalProgress,
) {
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
 * Encodes one checkpoint with an optional lossless tagged cursor.
 *
 * @param checkpoint - Validated raw checkpoint.
 * @returns Canonical JSON-safe checkpoint representation.
 */
function encodeCheckpoint(checkpoint: MigrationSourceCheckpoint) {
  return {
    completed: checkpoint.completed,
    ...(checkpoint.cursor === undefined
      ? {}
      : {
          cursor: encodeUnknownAttributeMap(
            checkpoint.cursor,
          ),
        }),
    aggregate: checkpoint.aggregate,
    keyDigestState: checkpoint.keyDigestState,
    contentDigestState: checkpoint.contentDigestState,
  }
}

/**
 * Rejects accessors, symbols, cycles, sparse arrays, and exotic prototypes.
 *
 * @param value - Candidate raw or tagged DynamoDB graph.
 * @param active - Objects on the current traversal path.
 */
function requireCanonicalDataGraph(
  value: unknown,
  active: WeakSet<object>,
): void {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string' ||
    value === undefined
  ) {
    return
  }
  if (
    typeof value !== 'object' ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failExecutionState()
  }
  if (active.has(value)) return failExecutionState()
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    return failExecutionState()
  }
  if (value instanceof Uint8Array) {
    const names = Object.getOwnPropertyNames(value)
    if (
      names.length !== value.byteLength ||
      names.some((name, index) => name !== String(index))
    ) {
      return failExecutionState()
    }
    return
  }
  active.add(value)
  if (Array.isArray(value)) {
    const names = Object.getOwnPropertyNames(value)
    if (!hasCanonicalDenseArrayShape(value)) {
      return failExecutionState()
    }
    if (
      names.length !== value.length + 1 ||
      names[value.length] !== 'length' ||
      names.some(
        (name, index) =>
          index < value.length && name !== String(index),
      )
    ) {
      return failExecutionState()
    }
    for (let index = 0; index < value.length; index += 1) {
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
        return failExecutionState()
      }
      requireCanonicalDataGraph(descriptor.value, active)
    }
    active.delete(value)
    return
  }
  if (!isRecord(value)) return failExecutionState()
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      descriptor.enumerable !== true
    ) {
      return failExecutionState()
    }
    requireCanonicalDataGraph(descriptor.value, active)
  }
  active.delete(value)
}

/**
 * Reads one strict marker digest accumulator state.
 *
 * @param value - Candidate accumulator state.
 * @returns Detached validated accumulator state.
 */
function readDigestState(value: unknown): MigrationDigestState {
  const record = requireRecord(value)
  requireExactKeys(record, ['count', 'sumHex', 'xorHex'])
  const state: MigrationDigestState = {
    count: readNonNegativeSafeInteger(readOwn(record, 'count')),
    sumHex: readDigest(readOwn(record, 'sumHex')),
    xorHex: readDigest(readOwn(record, 'xorHex')),
  }
  MigrationDigestAccumulator.fromState(state)
  return state
}

/**
 * Reads one exact no-op or mutating operation marker.
 *
 * @param value - Candidate operation marker.
 * @returns Detached strict operation marker.
 */
function readOperationMarker(value: unknown): WorkspaceSearchOperationMarker {
  const record = requireRecord(value)
  const kind = readOwn(record, 'kind')
  if (kind === 'workspace-search-operation-already-current') {
    return readAlreadyCurrentMarker(record)
  }
  if (kind === 'workspace-search-operation-applied') {
    return readAppliedMarker(record)
  }
  return failExecutionState()
}

/**
 * Reads one strict already-current operation marker.
 *
 * @param record - Candidate marker record.
 * @returns Detached strict no-op marker.
 */
function readAlreadyCurrentMarker(
  record: Readonly<Record<string, unknown>>,
): WorkspaceSearchOperationMarker {
  const hasSourceDigest = hasOwnDataProperty(record, 'sourceDigest')
  requireExactKeys(record, [
    'afterDigest',
    'configurationHash',
    'fenceToken',
    'kind',
    'maintenanceEvidenceReceiptDigest',
    'markerVersion',
    'operationId',
    'planOperationDigest',
    'planSequence',
    'recordedAt',
    'runId',
    ...(hasSourceDigest ? ['sourceDigest'] : []),
    'targetKeyDigest',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-operation-already-current' ||
    readOwn(record, 'markerVersion') !== 1
  ) {
    return failExecutionState()
  }
  const sourceDigest = hasSourceDigest
    ? readDigest(readOwn(record, 'sourceDigest'))
    : undefined
  const common = {
    kind: 'workspace-search-operation-already-current',
    markerVersion: 1,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    operationId: readDigest(readOwn(record, 'operationId')),
    planSequence: readPositiveSafeInteger(
      readOwn(record, 'planSequence'),
    ),
    planOperationDigest: readDigest(
      readOwn(record, 'planOperationDigest'),
    ),
    targetKeyDigest: readDigest(
      readOwn(record, 'targetKeyDigest'),
    ),
  } satisfies Pick<
    WorkspaceSearchAlreadyCurrentOperationMarker,
    | 'kind'
    | 'markerVersion'
    | 'runId'
    | 'configurationHash'
    | 'operationId'
    | 'planSequence'
    | 'planOperationDigest'
    | 'targetKeyDigest'
  >
  const tail = {
    afterDigest: readDigest(readOwn(record, 'afterDigest')),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    recordedAt: readTimestamp(readOwn(record, 'recordedAt')),
  }
  return sourceDigest === undefined
    ? { ...common, ...tail }
    : { ...common, sourceDigest, ...tail }
}

/**
 * Reads one strict mutating operation marker.
 *
 * @param record - Candidate marker record.
 * @returns Detached strict mutation marker.
 */
function readAppliedMarker(
  record: Readonly<Record<string, unknown>>,
): WorkspaceSearchOperationMarker {
  const hasSourceDigest = hasOwnDataProperty(record, 'sourceDigest')
  requireExactKeys(record, [
    'afterDigest',
    'beforeDigest',
    'committedAt',
    'configurationHash',
    'fenceToken',
    'journal',
    'kind',
    'maintenanceEvidenceReceiptDigest',
    'markerVersion',
    'operationId',
    'planOperationDigest',
    'planSequence',
    'runId',
    'sequence',
    ...(hasSourceDigest ? ['sourceDigest'] : []),
    'targetKeyDigest',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-operation-applied' ||
    readOwn(record, 'markerVersion') !== 1
  ) {
    return failExecutionState()
  }
  const sourceDigest = hasSourceDigest
    ? readDigest(readOwn(record, 'sourceDigest'))
    : undefined
  const common = {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    operationId: readDigest(readOwn(record, 'operationId')),
    planSequence: readPositiveSafeInteger(
      readOwn(record, 'planSequence'),
    ),
    planOperationDigest: readDigest(
      readOwn(record, 'planOperationDigest'),
    ),
    sequence: readPositiveSafeInteger(
      readOwn(record, 'sequence'),
    ),
    targetKeyDigest: readDigest(
      readOwn(record, 'targetKeyDigest'),
    ),
  } satisfies Pick<
    WorkspaceSearchOperationReceipt,
    | 'kind'
    | 'markerVersion'
    | 'runId'
    | 'configurationHash'
    | 'operationId'
    | 'planSequence'
    | 'planOperationDigest'
    | 'sequence'
    | 'targetKeyDigest'
  >
  const tail = {
    beforeDigest: readDigest(readOwn(record, 'beforeDigest')),
    afterDigest: readDigest(readOwn(record, 'afterDigest')),
    fenceToken: readPositiveSafeInteger(
      readOwn(record, 'fenceToken'),
    ),
    maintenanceEvidenceReceiptDigest: readDigest(
      readOwn(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    journal: readJournalReference(readOwn(record, 'journal')),
    committedAt: readTimestamp(readOwn(record, 'committedAt')),
  }
  return sourceDigest === undefined
    ? { ...common, ...tail }
    : { ...common, sourceDigest, ...tail }
}

/**
 * Reads one exact immutable journal object reference.
 *
 * @param value - Candidate journal reference.
 * @returns Detached strict exact-version reference.
 */
function readJournalReference(
  value: unknown,
): Extract<
  WorkspaceSearchOperationMarker,
  { readonly kind: 'workspace-search-operation-applied' }
>['journal'] {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'byteLength',
    'contentDigest',
    'headDigest',
    'objectKey',
    'retainUntil',
    'versionId',
  ])
  const versionId = readBoundedText(readOwn(record, 'versionId'))
  const byteLength = readPositiveSafeInteger(
    readOwn(record, 'byteLength'),
  )
  if (
    versionId === 'null' ||
    byteLength > WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES
  ) {
    return failExecutionState()
  }
  return {
    objectKey: readBoundedText(readOwn(record, 'objectKey')),
    versionId,
    contentDigest: readDigest(readOwn(record, 'contentDigest')),
    byteLength,
    retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
    headDigest: readDigest(readOwn(record, 'headDigest')),
  }
}

/**
 * Requires a candidate JSON graph to equal one canonical expected graph.
 *
 * @param actual - Candidate graph.
 * @param expected - Exact canonical expected graph.
 */
function requireExactJsonValue(
  actual: unknown,
  expected: unknown,
): void {
  if (
    typeof actual === 'object' &&
    actual !== null &&
    nodeUtilTypes.isProxy(actual)
  ) {
    return failExecutionState()
  }
  if (
    expected === null ||
    typeof expected === 'boolean' ||
    typeof expected === 'number' ||
    typeof expected === 'string'
  ) {
    if (actual !== expected) return failExecutionState()
    return
  }
  if (Array.isArray(expected)) {
    if (
      !Array.isArray(actual) ||
      !hasCanonicalDenseArrayShape(actual) ||
      actual.length !== expected.length
    ) {
      return failExecutionState()
    }
    for (let index = 0; index < expected.length; index += 1) {
      requireExactJsonValue(actual[index], expected[index])
    }
    return
  }
  const expectedRecord = requireRecord(expected)
  const actualRecord = requireRecord(actual)
  const keys = Object.keys(expectedRecord)
  requireExactKeys(actualRecord, keys)
  for (const key of keys) {
    requireExactJsonValue(
      readOwn(actualRecord, key),
      readOwn(expectedRecord, key),
    )
  }
}

/**
 * Reads one plain record.
 *
 * @param value - Candidate value.
 * @returns Plain string-keyed record.
 */
function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return failExecutionState()
  return value
}

/**
 * Checks whether one value is a plain string-keyed record.
 *
 * @param value - Candidate value.
 * @returns Whether the candidate has a supported plain-record prototype.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
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
 * Requires exactly the listed own enumerable data properties.
 *
 * @param record - Candidate record.
 * @param expected - Complete expected field names.
 */
function requireExactKeys(
  record: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): void {
  if (Object.getOwnPropertySymbols(record).length !== 0) {
    return failExecutionState()
  }
  const actual = Object.getOwnPropertyNames(record).sort()
  const wanted = [...expected].sort()
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    return failExecutionState()
  }
  for (const key of wanted) {
    if (!hasOwnDataProperty(record, key)) {
      return failExecutionState()
    }
  }
}

/**
 * Checks for one enumerable own data property without invoking accessors.
 *
 * @param record - Candidate object.
 * @param key - Property name to inspect.
 * @returns Whether the exact own enumerable data property exists.
 */
function hasOwnDataProperty(record: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (descriptor === undefined) return false
  if (
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return failExecutionState()
  }
  return true
}

/**
 * Reads one own data property without invoking accessors.
 *
 * @param record - Validated record.
 * @param key - Exact property name.
 * @returns Own property value.
 */
function readOwn(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (
    descriptor === undefined ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined ||
    descriptor.enumerable !== true
  ) {
    return failExecutionState()
  }
  return descriptor.value
}

/**
 * Reads one safe migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string') return failExecutionState()
  requireMigrationIdentifier(value, 'Execution state identifier')
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failExecutionState()
  return value
}

/**
 * Reads one canonical UTC timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Validated timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) return failExecutionState()
  return value
}

/**
 * Reads one bounded nonempty Unicode string.
 *
 * @param value - Candidate string.
 * @returns Validated string.
 */
function readBoundedText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumTextLength ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failExecutionState()
  }
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    return failExecutionState()
  }
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate integer.
 * @returns Validated integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failExecutionState()
  }
  return value
}

/**
 * Encodes one validated execution state and enforces its byte ceiling.
 *
 * @param value - Validated mutable execution state.
 * @returns Canonical bounded UTF-8 bytes.
 */
function encodeCanonicalExecutionState(
  value: WorkspaceSearchMigrationExecutionState,
): Uint8Array {
  const document = value.executionStateVersion === 1
    ? value
    : {
        ...value,
        apply: encodeTraversal(value.apply),
      }
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(document),
  )
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES
  ) {
    return failExecutionState()
  }
  return bytes
}

/**
 * Encodes one validated operation marker under the mutable-state byte ceiling.
 *
 * @param value - Validated no-op or mutating marker.
 * @returns Canonical bounded UTF-8 bytes.
 */
function encodeCanonicalOperationMarker(
  value: WorkspaceSearchOperationMarker,
): Uint8Array {
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(value),
  )
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES
  ) {
    return failExecutionState()
  }
  return bytes
}

/**
 * Copies untrusted input after enforcing its finite byte bound.
 *
 * @param bytes - Candidate input bytes.
 * @returns Detached bounded bytes.
 */
function copyBoundedBytes(bytes: Uint8Array): Uint8Array {
  if (
    nodeUtilTypes.isProxy(bytes) ||
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES
  ) {
    return failExecutionState()
  }
  return new Uint8Array(bytes)
}

/**
 * Compares two byte arrays without converting untrusted data to text.
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
 * Maps every implementation failure to the stable public boundary error.
 *
 * @param operation - Contract operation.
 * @returns Successful operation result.
 */
function atExecutionStateBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationExecutionStateError
    ) {
      throw error
    }
    throw new WorkspaceSearchMigrationExecutionStateError()
  }
}

/**
 * Raises the only public mutable execution-state validation failure.
 *
 * @returns Never returns.
 */
function failExecutionState(): never {
  throw new WorkspaceSearchMigrationExecutionStateError()
}
