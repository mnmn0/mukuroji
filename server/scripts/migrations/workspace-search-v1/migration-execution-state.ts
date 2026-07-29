import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  MigrationDigestAccumulator,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type MigrationDigestState,
  type WorkspaceSearchAlreadyCurrentOperationMarker,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchOperationMarker,
  type WorkspaceSearchOperationReceipt,
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
  validateWorkspaceSearchMigrationRunState,
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

/**
 * Flat mutable operation-phase state rooted in one immutable admission row.
 */
export type WorkspaceSearchMigrationExecutionState = {
  /** Mutable execution-state envelope discriminator. */
  readonly kind: 'workspace-search-migration-execution-state'
  /** Mutable execution-state envelope schema version. */
  readonly executionStateVersion: 1
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
  /** Positive optimistic-concurrency revision after this operation. */
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
  /** Canonical UTC time of the operation represented by this state. */
  readonly updatedAt: string
  /** Digest of the complete reconstructed state-machine value. */
  readonly runStateDigest: string
  /** Digest of every preceding flat envelope field. */
  readonly executionStateDigest: string
}

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
): WorkspaceSearchMigrationExecutionState {
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
      ? readExecutionState(input.predecessor)
      : undefined
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
    return createExecutionStateEnvelope(
      admission,
      next,
      minimumJournalRetainUntil,
      runStateDigest,
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
    const detachedState = readExecutionState(executionState)
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
    encodeCanonicalExecutionState(readExecutionState(value))
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
    const executionState = readExecutionState(parsed)
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
    updatedAt: executionState.updatedAt,
  }
  requireOperationPhaseBase(admission, runState)
  if (
    executionState.appliedOperationCount >
      admission.runState.planOperationCount ||
    executionState.runStateDigest !==
      createMigrationDigest(runState)
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
    apply: admission.runState.apply,
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
    apply: state.apply,
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
function createExecutionStateEnvelope(
  admission: WorkspaceSearchMigrationExecutionRun,
  next: WorkspaceSearchMigrationRunState,
  minimumJournalRetainUntil: string | undefined,
  runStateDigest: string,
): WorkspaceSearchMigrationExecutionState {
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
      WorkspaceSearchMigrationExecutionState,
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
    WorkspaceSearchMigrationExecutionState,
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
 * Reads and validates one strict flat mutable execution-state envelope.
 *
 * @param value - Candidate runtime or parsed envelope.
 * @returns Detached strict mutable execution state.
 */
function readExecutionState(
  value: unknown,
): WorkspaceSearchMigrationExecutionState {
  const record = requireRecord(value)
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
    WorkspaceSearchMigrationExecutionState,
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
      WorkspaceSearchMigrationExecutionState,
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
    WorkspaceSearchMigrationExecutionState,
    'executionStateDigest'
  >
  if (executionStateDigest !== createMigrationDigest(fields)) {
    return failExecutionState()
  }
  return { ...fields, executionStateDigest }
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
  const actual = Object.keys(record).sort()
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
