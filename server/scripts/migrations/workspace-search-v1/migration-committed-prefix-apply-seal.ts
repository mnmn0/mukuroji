import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  MigrationDigestAccumulator,
  requireMigrationIdentifier,
  serializeCanonicalJson,
  type WorkspaceSearchApplySeal,
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
  parseWorkspaceSearchMigrationExecutionState,
  reconstructWorkspaceSearchMigrationRunState,
  serializeWorkspaceSearchMigrationExecutionState,
  type WorkspaceSearchMigrationExecutionState,
} from './migration-execution-state'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'
import {
  hasOnlyPairedSurrogates,
} from './migration-value-guards'

/**
 * Maximum canonical bytes accepted for one committed-prefix apply seal.
 */
export const WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_MAX_BYTES =
  64 * 1024

const maximumTextLength = 8_192
const maximumVersionIdLength = 1_024

/**
 * Stable raw-value-free failure raised for an invalid committed-prefix seal.
 */
export class WorkspaceSearchMigrationCommittedPrefixApplySealError
  extends Error {
  /** Secret-free machine-readable contract failure code. */
  readonly code =
    'INVALID_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL'

  /** Creates one stable committed-prefix seal failure. */
  constructor() {
    super('INVALID_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL')
    this.name =
      'WorkspaceSearchMigrationCommittedPrefixApplySealError'
  }
}

/**
 * Identifies the immutable admission as a direct seal predecessor.
 */
export type WorkspaceSearchMigrationCommittedPrefixAdmissionPredecessor = {
  /** Direct immutable admission predecessor discriminator. */
  readonly kind: 'execution-run-admission'
}

/**
 * Identifies one exact mutable execution state as the seal predecessor.
 */
export type WorkspaceSearchMigrationCommittedPrefixMutablePredecessor = {
  /** Mutable execution-state predecessor discriminator. */
  readonly kind: 'mutable-execution-state'
  /** Exact legacy-v1 or traversal-capable-v2 mutable state. */
  readonly executionState: WorkspaceSearchMigrationExecutionState
}

/**
 * Explicit admission-only or mutable committed-prefix predecessor.
 */
export type WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor =
  | WorkspaceSearchMigrationCommittedPrefixAdmissionPredecessor
  | WorkspaceSearchMigrationCommittedPrefixMutablePredecessor

/**
 * Rich exact-version immutable reference to pure committed-prefix seal bytes.
 */
export type WorkspaceSearchMigrationCommittedPrefixApplySealReference = {
  /** Reference scope fixed to a committed apply prefix. */
  readonly scope: 'committed-prefix'
  /** Exact content-addressed immutable object key. */
  readonly objectKey: string
  /** Exact immutable object version. */
  readonly versionId: string
  /** SHA-256 digest of the exact canonical stored seal bytes. */
  readonly contentDigest: string
  /** Exact stored byte length. */
  readonly byteLength: number
  /** Exact canonical UTC Object Lock deadline. */
  readonly retainUntil: string
}

/**
 * Material required to create one strict pure committed-prefix seal.
 */
export type CreateWorkspaceSearchMigrationCommittedPrefixApplySealInput = {
  /** Immutable revision-one execution admission. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** Explicit immutable admission or exact mutable state predecessor. */
  readonly predecessor:
    WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
  /** Exact immutable version-two planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Adapter-owned canonical seal creation time. */
  readonly createdAt: string
}

/**
 * Material used to verify a pure seal and its rich immutable reference.
 */
export type RequireWorkspaceSearchMigrationCommittedPrefixApplySealBindingInput =
  {
    /** Immutable revision-one execution admission. */
    readonly admission: WorkspaceSearchMigrationExecutionRun
    /** Explicit immutable admission or exact mutable state predecessor. */
    readonly predecessor:
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    /** Exact immutable version-two planning authority. */
    readonly sealedPlanningAuthority:
      WorkspaceSearchMigrationSealedPlanningAuthorityV2
    /** Exact strict pure committed-prefix seal. */
    readonly seal: WorkspaceSearchApplySeal
    /** Rich reference to the exact canonical pure seal bytes. */
    readonly reference:
      WorkspaceSearchMigrationCommittedPrefixApplySealReference
  }

/**
 * Internally resolved exact predecessor evidence.
 */
type ResolvedCommittedPrefixPredecessor = {
  /** Exact durable marker count at the predecessor. */
  readonly markerCount: number
  /** Exact order-independent aggregate of every durable marker. */
  readonly markerAggregateDigest: string
  /** Highest committed mutating journal sequence. */
  readonly journalSequence: number
  /** Hash-chain head for the highest mutating journal sequence. */
  readonly journalHeadDigest: string
  /** Earliest retained committed journal deadline. */
  readonly minimumJournalRetainUntil?: string
  /** Exact canonical predecessor state update time. */
  readonly updatedAt: string
}

/**
 * Creates one strict legacy-compatible committed-prefix seal.
 *
 * The returned value is the exact canonical document stored in immutable
 * object storage and consumed by the existing pure state-machine reducer.
 * Admission, execution-state, planning, table, traversal, marker, journal,
 * digest, and retention evidence is validated before this projection.
 *
 * @param input - Admission, explicit predecessor, planning root, and time.
 * @returns Detached strict pure committed-prefix seal.
 */
export function createWorkspaceSearchMigrationCommittedPrefixApplySeal(
  input:
    CreateWorkspaceSearchMigrationCommittedPrefixApplySealInput,
): WorkspaceSearchApplySeal {
  return atCommittedPrefixApplySealBoundary(() => {
    const resolved = resolveCreationInput(input)
    const seal: WorkspaceSearchApplySeal = {
      kind: 'workspace-search-apply-seal',
      sealVersion: 1,
      migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
      migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
      runId: resolved.admission.runId,
      configurationHash:
        resolved.admission.configurationHash,
      scope: 'committed-prefix',
      planDigest: resolved.authority.planDigest,
      planOperationCount:
        resolved.authority.planOperationCount,
      journalSequence: resolved.predecessor.journalSequence,
      journalHeadDigest:
        resolved.predecessor.journalHeadDigest,
      markerCount: resolved.predecessor.markerCount,
      applyMarkerAggregateDigest:
        resolved.predecessor.markerAggregateDigest,
      createdAt: resolved.createdAt,
    }
    return readCommittedPrefixApplySeal(seal)
  })
}

/**
 * Serializes one strict committed-prefix seal as canonical UTF-8 JSON.
 *
 * @param value - Candidate pure committed-prefix seal.
 * @returns Exact bounded canonical bytes.
 */
export function serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
  value: WorkspaceSearchApplySeal,
): Uint8Array {
  return atCommittedPrefixApplySealBoundary(() =>
    encodeDocument(readCommittedPrefixApplySeal(value))
  )
}

/**
 * Parses one exact canonical committed-prefix seal document.
 *
 * @param bytes - Untrusted bounded canonical UTF-8 bytes.
 * @returns Detached strict pure committed-prefix seal.
 */
export function parseWorkspaceSearchMigrationCommittedPrefixApplySeal(
  bytes: Uint8Array,
): WorkspaceSearchApplySeal {
  return atCommittedPrefixApplySealBoundary(() => {
    const snapshot = copyBoundedBytes(bytes)
    const parsed = parseJson(snapshot)
    const seal = readCommittedPrefixApplySeal(parsed)
    if (!equalBytes(snapshot, encodeDocument(seal))) {
      return failCommittedPrefixApplySeal()
    }
    return seal
  })
}

/**
 * Validates and detaches one rich committed-prefix seal reference.
 *
 * @param value - Candidate rich immutable reference.
 * @returns Detached strict committed-prefix reference.
 */
export function readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
  value: unknown,
): WorkspaceSearchMigrationCommittedPrefixApplySealReference {
  return atCommittedPrefixApplySealBoundary(() => {
    const record = requireRecord(value)
    requireExactKeys(record, [
      'byteLength',
      'contentDigest',
      'objectKey',
      'retainUntil',
      'scope',
      'versionId',
    ])
    const scope = readOwn(record, 'scope')
    const byteLength = readPositiveSafeInteger(
      readOwn(record, 'byteLength'),
    )
    if (
      scope !== 'committed-prefix' ||
      byteLength >
        WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_MAX_BYTES
    ) {
      return failCommittedPrefixApplySeal()
    }
    return {
      scope,
      objectKey: readText(readOwn(record, 'objectKey')),
      versionId: readVersionId(readOwn(record, 'versionId')),
      contentDigest: readDigest(readOwn(record, 'contentDigest')),
      byteLength,
      retainUntil: readTimestamp(readOwn(record, 'retainUntil')),
    }
  })
}

/**
 * Requires roots, pure seal, and rich reference to form one exact binding.
 *
 * This re-derives the unique pure seal from all trusted roots, compares its
 * canonical bytes exactly, verifies content digest and length, and binds the
 * seal retention to both the admitted plan and every committed journal.
 *
 * @param input - Roots, exact pure seal, and candidate rich reference.
 * @returns Detached rich reference bound to the exact pure seal bytes.
 */
export function requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding(
  input:
    RequireWorkspaceSearchMigrationCommittedPrefixApplySealBindingInput,
): WorkspaceSearchMigrationCommittedPrefixApplySealReference {
  return atCommittedPrefixApplySealBoundary(() => {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'admission',
      'predecessor',
      'reference',
      'seal',
      'sealedPlanningAuthority',
    ])
    const seal = readCommittedPrefixApplySeal(
      readOwn(record, 'seal'),
    )
    const expected =
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: readRequiredAdmission(
          readOwn(record, 'admission'),
        ),
        predecessor: readPredecessor(
          readOwn(record, 'predecessor'),
        ),
        sealedPlanningAuthority:
          readRequiredSealedPlanningAuthority(
            readOwn(record, 'sealedPlanningAuthority'),
          ),
        createdAt: seal.createdAt,
      })
    if (
      serializeCanonicalJson(seal) !==
      serializeCanonicalJson(expected)
    ) {
      return failCommittedPrefixApplySeal()
    }
    const reference =
      readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
        readOwn(record, 'reference'),
      )
    const bytes = encodeDocument(seal)
    if (
      reference.contentDigest !== createMigrationDigest(seal) ||
      reference.byteLength !== bytes.byteLength ||
      Date.parse(reference.retainUntil) <=
        Date.parse(seal.createdAt) +
          WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
    ) {
      return failCommittedPrefixApplySeal()
    }
    return reference
  })
}

/**
 * Resolves, detaches, and validates all production creator inputs.
 *
 * @param input - Candidate creator input.
 * @returns Exact roots, predecessor evidence, and creation time.
 */
function resolveCreationInput(
  input: CreateWorkspaceSearchMigrationCommittedPrefixApplySealInput,
) {
  const record = requireRecord(input)
  requireExactKeys(record, [
    'admission',
    'createdAt',
    'predecessor',
    'sealedPlanningAuthority',
  ])
  const admission = readRequiredAdmission(
    readOwn(record, 'admission'),
  )
  const predecessorInput = readPredecessor(
    readOwn(record, 'predecessor'),
  )
  const authority = readRequiredSealedPlanningAuthority(
    readOwn(record, 'sealedPlanningAuthority'),
  )
  const createdAt = readTimestamp(readOwn(record, 'createdAt'))
  const predecessor = resolvePredecessor(
    admission,
    predecessorInput,
  )
  requireIdentityBinding(admission, authority)
  if (
    Date.parse(createdAt) < Date.parse(predecessor.updatedAt)
  ) {
    return failCommittedPrefixApplySeal()
  }
  requireRetentionInvariant(
    createdAt,
    admission.binding.planSealReference.retainUntil,
    predecessor.minimumJournalRetainUntil,
  )
  return {
    admission,
    authority,
    predecessor,
    createdAt,
  }
}

/**
 * Resolves and validates the explicit predecessor against admission.
 *
 * @param admission - Detached immutable execution admission.
 * @param predecessor - Detached explicit predecessor.
 * @returns Exact marker, journal, and time evidence.
 */
function resolvePredecessor(
  admission: WorkspaceSearchMigrationExecutionRun,
  predecessor:
    WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor,
): ResolvedCommittedPrefixPredecessor {
  const state = predecessor.kind === 'execution-run-admission'
    ? admission.runState
    : reconstructWorkspaceSearchMigrationRunState(
        admission,
        predecessor.executionState,
      )
  if (
    state.status !== 'applying' ||
    state.runId !== admission.runId ||
    state.configurationHash !== admission.configurationHash ||
    state.planDigest !== admission.binding.planDigest ||
    state.planOperationCount !==
      admission.binding.planOperationCount
  ) {
    return failCommittedPrefixApplySeal()
  }
  if (predecessor.kind === 'execution-run-admission') {
    if (
      state.revision !== 1 ||
      state.appliedOperationCount !== 0 ||
      state.journalSequence !== 0 ||
      state.journalHeadDigest !== zeroHexDigest() ||
      calculateTraversalPageCount(state) !== 0
    ) {
      return failCommittedPrefixApplySeal()
    }
  } else {
    requireMutablePredecessorInvariant(
      admission,
      predecessor.executionState,
      state,
    )
  }
  const accumulator = MigrationDigestAccumulator.fromState(
    state.applyMarkerDigestState,
  )
  if (
    state.appliedOperationCount > state.planOperationCount ||
    state.applyMarkerDigestState.count !==
      state.appliedOperationCount ||
    state.journalSequence > state.appliedOperationCount ||
    (state.journalSequence === 0) !==
      (state.journalHeadDigest === zeroHexDigest())
  ) {
    return failCommittedPrefixApplySeal()
  }
  const minimumJournalRetainUntil =
    predecessor.kind === 'mutable-execution-state'
      ? predecessor.executionState.minimumJournalRetainUntil
      : undefined
  if (
    (state.journalSequence === 0) !==
      (minimumJournalRetainUntil === undefined)
  ) {
    return failCommittedPrefixApplySeal()
  }
  return {
    markerCount: state.appliedOperationCount,
    markerAggregateDigest: accumulator.digest(),
    journalSequence: state.journalSequence,
    journalHeadDigest: state.journalHeadDigest,
    ...(minimumJournalRetainUntil === undefined
      ? {}
      : { minimumJournalRetainUntil }),
    updatedAt: state.updatedAt,
  }
}

/**
 * Requires mutable codec version, revision, traversal, and digests to agree.
 *
 * @param admission - Immutable execution admission owning the state.
 * @param executionState - Detached strict mutable envelope.
 * @param state - Exact reconstructed run state.
 */
function requireMutablePredecessorInvariant(
  admission: WorkspaceSearchMigrationExecutionRun,
  executionState: WorkspaceSearchMigrationExecutionState,
  state: ReturnType<
    typeof reconstructWorkspaceSearchMigrationRunState
  >,
): void {
  const pageCount = calculateTraversalPageCount(state)
  if (
    executionState.executionRunDigest !==
      admission.executionRunDigest ||
    executionState.runId !== state.runId ||
    executionState.configurationHash !== state.configurationHash ||
    executionState.revision !== state.revision ||
    executionState.appliedOperationCount !==
      state.appliedOperationCount ||
    executionState.updatedAt !== state.updatedAt
  ) {
    return failCommittedPrefixApplySeal()
  }
  if (
    executionState.executionStateVersion === 1 &&
    (
      pageCount !== 0 ||
      executionState.revision !==
        addSafeCounts(1, state.appliedOperationCount)
    )
  ) {
    return failCommittedPrefixApplySeal()
  }
  if (
    executionState.executionStateVersion === 2 &&
    (
      pageCount <= 0 ||
      executionState.revision !==
        addSafeCounts(
          addSafeCounts(1, state.appliedOperationCount),
          pageCount,
        )
    )
  ) {
    return failCommittedPrefixApplySeal()
  }
}

/**
 * Counts every durable apply-checkpoint page without overflow.
 *
 * @param state - Exact reconstructed predecessor state.
 * @returns Safe total page count across four sources and target.
 */
function calculateTraversalPageCount(
  state: ReturnType<
    typeof reconstructWorkspaceSearchMigrationRunState
  >,
): number {
  let pageCount = 0
  for (const source of workspaceSearchMigrationSourceNames) {
    pageCount = addSafeCounts(
      pageCount,
      state.apply.sources[source].aggregate.pageCount,
    )
  }
  return addSafeCounts(
    pageCount,
    state.apply.target.aggregate.pageCount,
  )
}

/**
 * Requires execution admission and sealed planning identities to match.
 *
 * @param admission - Detached immutable execution admission.
 * @param authority - Detached immutable sealed planning authority.
 */
function requireIdentityBinding(
  admission: WorkspaceSearchMigrationExecutionRun,
  authority: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
): void {
  if (
    admission.binding.sealedPlanningAuthorityDigest !==
      authority.authorityDigest ||
    admission.runId !== authority.runId ||
    admission.configurationHash !== authority.configurationHash ||
    admission.binding.planDigest !== authority.planDigest ||
    admission.binding.planOperationCount !==
      authority.planOperationCount ||
    serializeCanonicalJson(admission.binding.tableIds) !==
      serializeCanonicalJson(authority.tableIds) ||
    serializeCanonicalJson(
      admission.binding.planSealReference,
    ) !== serializeCanonicalJson(authority.planSealReference) ||
    addSafeCounts(
      authority.sourceOperationCount,
      authority.orphanOperationCount,
    ) !== authority.planOperationCount
  ) {
    return failCommittedPrefixApplySeal()
  }
}

/**
 * Requires plan and committed journals to cover the rollback commit window.
 *
 * @param createdAt - Exact seal creation time.
 * @param planRetainUntil - Exact admitted plan retention deadline.
 * @param minimumJournalRetainUntil - Earliest committed journal deadline.
 */
function requireRetentionInvariant(
  createdAt: string,
  planRetainUntil: string,
  minimumJournalRetainUntil: string | undefined,
): void {
  const minimumDeadline =
    Date.parse(createdAt) +
    WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  if (Date.parse(planRetainUntil) <= minimumDeadline) {
    return failCommittedPrefixApplySeal()
  }
  if (
    minimumJournalRetainUntil !== undefined &&
    (
      Date.parse(minimumJournalRetainUntil) <
        Date.parse(planRetainUntil) ||
      Date.parse(minimumJournalRetainUntil) <= minimumDeadline
    )
  ) {
    return failCommittedPrefixApplySeal()
  }
}

/**
 * Reads one explicit admission or mutable predecessor input.
 *
 * @param value - Candidate explicit predecessor.
 * @returns Detached strict predecessor.
 */
function readPredecessor(
  value: unknown,
): WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor {
  const record = requireRecord(value)
  const kind = readOwn(record, 'kind')
  if (kind === 'execution-run-admission') {
    requireExactKeys(record, ['kind'])
    return { kind }
  }
  if (kind !== 'mutable-execution-state') {
    return failCommittedPrefixApplySeal()
  }
  requireExactKeys(record, ['executionState', 'kind'])
  return {
    kind,
    executionState: readRequiredExecutionState(
      readOwn(record, 'executionState'),
    ),
  }
}

/**
 * Detaches one immutable execution admission through its strict codec.
 *
 * @param value - Candidate immutable admission.
 * @returns Detached strict immutable admission.
 */
function readRequiredAdmission(
  value: unknown,
): WorkspaceSearchMigrationExecutionRun {
  if (!isExecutionRun(value)) {
    return failCommittedPrefixApplySeal()
  }
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun(value),
  )
}

/**
 * Minimally narrows a candidate admission for strict serialization.
 *
 * @param value - Candidate immutable admission.
 * @returns Whether the strict admission codec may consume it.
 */
function isExecutionRun(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionRun {
  return isOrdinaryObject(value)
}

/**
 * Detaches one mutable execution state through its strict codec.
 *
 * @param value - Candidate mutable execution state.
 * @returns Detached strict legacy-v1 or traversal-capable-v2 state.
 */
function readRequiredExecutionState(
  value: unknown,
): WorkspaceSearchMigrationExecutionState {
  if (!isExecutionState(value)) {
    return failCommittedPrefixApplySeal()
  }
  return parseWorkspaceSearchMigrationExecutionState(
    serializeWorkspaceSearchMigrationExecutionState(value),
  )
}

/**
 * Minimally narrows a candidate state for strict serialization.
 *
 * @param value - Candidate mutable execution state.
 * @returns Whether the strict state codec may consume it.
 */
function isExecutionState(
  value: unknown,
): value is WorkspaceSearchMigrationExecutionState {
  return isOrdinaryObject(value)
}

/**
 * Detaches one sealed planning authority through its strict codec.
 *
 * @param value - Candidate sealed planning authority.
 * @returns Detached strict version-two authority.
 */
function readRequiredSealedPlanningAuthority(
  value: unknown,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  if (!isSealedPlanningAuthority(value)) {
    return failCommittedPrefixApplySeal()
  }
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2(
      value,
    ),
  )
}

/**
 * Minimally narrows a candidate authority for strict serialization.
 *
 * @param value - Candidate planning authority.
 * @returns Whether the strict authority codec may consume it.
 */
function isSealedPlanningAuthority(
  value: unknown,
): value is WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  return isOrdinaryObject(value)
}

/**
 * Detaches and validates one pure committed-prefix seal.
 *
 * @param value - Candidate pure seal.
 * @returns Detached strict pure committed-prefix seal.
 */
function readCommittedPrefixApplySeal(
  value: unknown,
): WorkspaceSearchApplySeal {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'applyMarkerAggregateDigest',
    'configurationHash',
    'createdAt',
    'journalHeadDigest',
    'journalSequence',
    'kind',
    'markerCount',
    'migrationId',
    'migrationVersion',
    'planDigest',
    'planOperationCount',
    'runId',
    'scope',
    'sealVersion',
  ])
  if (
    readOwn(record, 'kind') !==
      'workspace-search-apply-seal' ||
    readOwn(record, 'sealVersion') !== 1 ||
    readOwn(record, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readOwn(record, 'migrationVersion') !==
      WORKSPACE_SEARCH_MIGRATION_VERSION ||
    readOwn(record, 'scope') !== 'committed-prefix'
  ) {
    return failCommittedPrefixApplySeal()
  }
  const markerCount = readNonNegativeSafeInteger(
    readOwn(record, 'markerCount'),
  )
  const planOperationCount = readNonNegativeSafeInteger(
    readOwn(record, 'planOperationCount'),
  )
  const journalSequence = readNonNegativeSafeInteger(
    readOwn(record, 'journalSequence'),
  )
  const journalHeadDigest = readDigest(
    readOwn(record, 'journalHeadDigest'),
  )
  if (
    markerCount > planOperationCount ||
    journalSequence > markerCount ||
    (journalSequence === 0) !==
      (journalHeadDigest === zeroHexDigest())
  ) {
    return failCommittedPrefixApplySeal()
  }
  return {
    kind: 'workspace-search-apply-seal',
    sealVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId: readIdentifier(readOwn(record, 'runId')),
    configurationHash: readDigest(
      readOwn(record, 'configurationHash'),
    ),
    scope: 'committed-prefix',
    planDigest: readDigest(readOwn(record, 'planDigest')),
    planOperationCount,
    journalSequence,
    journalHeadDigest,
    markerCount,
    applyMarkerAggregateDigest: readDigest(
      readOwn(record, 'applyMarkerAggregateDigest'),
    ),
    createdAt: readTimestamp(readOwn(record, 'createdAt')),
  }
}

/**
 * Adds two nonnegative counts without exceeding safe integer range.
 *
 * @param left - Existing exact count.
 * @param right - Additional exact count.
 * @returns Safe exact sum.
 */
function addSafeCounts(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum) || sum < 0) {
    return failCommittedPrefixApplySeal()
  }
  return sum
}

/**
 * Encodes one validated document as bounded canonical UTF-8 bytes.
 *
 * @param value - Validated canonical document.
 * @returns Exact bounded bytes.
 */
function encodeDocument(value: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(
    serializeCanonicalJson(value),
  )
  if (
    bytes.byteLength <= 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_MAX_BYTES
  ) {
    return failCommittedPrefixApplySeal()
  }
  return bytes
}

/**
 * Parses exact UTF-8 JSON without replacement characters.
 *
 * @param bytes - Detached bounded bytes.
 * @returns Untrusted parsed JSON value.
 */
function parseJson(bytes: Uint8Array): unknown {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return failCommittedPrefixApplySeal()
  }
  try {
    return JSON.parse(text)
  } catch {
    return failCommittedPrefixApplySeal()
  }
}

/**
 * Copies one bounded non-shared Uint8Array.
 *
 * @param value - Candidate document bytes.
 * @returns Detached exact bytes.
 */
function copyBoundedBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value)
  ) {
    return failCommittedPrefixApplySeal()
  }
  const buffer = readIntrinsicBuffer(value)
  const byteLength = readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_COMMITTED_PREFIX_APPLY_SEAL_MAX_BYTES
  ) {
    return failCommittedPrefixApplySeal()
  }
  const copy = new Uint8Array(byteLength)
  try {
    Uint8Array.prototype.set.call(copy, value)
  } catch {
    return failCommittedPrefixApplySeal()
  }
  return copy
}

/**
 * Reads the intrinsic backing buffer of one Uint8Array.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic ArrayBuffer or SharedArrayBuffer.
 */
function readIntrinsicBuffer(value: Uint8Array): ArrayBufferLike {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
        typedArrayPrototype,
        'buffer',
      )
  if (descriptor?.get === undefined) {
    return failCommittedPrefixApplySeal()
  }
  try {
    const result: unknown = Reflect.apply(descriptor.get, value, [])
    if (
      !nodeUtilTypes.isArrayBuffer(result) &&
      !nodeUtilTypes.isSharedArrayBuffer(result)
    ) {
      return failCommittedPrefixApplySeal()
    }
    return result
  } catch {
    return failCommittedPrefixApplySeal()
  }
}

/**
 * Reads the intrinsic byte length of one Uint8Array.
 *
 * @param value - Valid non-proxy Uint8Array.
 * @returns Exact intrinsic byte length.
 */
function readIntrinsicByteLength(value: Uint8Array): number {
  const typedArrayPrototype = Object.getPrototypeOf(
    Uint8Array.prototype,
  )
  const descriptor = typedArrayPrototype === null
    ? undefined
    : Object.getOwnPropertyDescriptor(
        typedArrayPrototype,
        'byteLength',
      )
  if (descriptor?.get === undefined) {
    return failCommittedPrefixApplySeal()
  }
  try {
    const result: unknown = Reflect.apply(descriptor.get, value, [])
    if (
      typeof result !== 'number' ||
      !Number.isSafeInteger(result)
    ) {
      return failCommittedPrefixApplySeal()
    }
    return result
  } catch {
    return failCommittedPrefixApplySeal()
  }
}

/**
 * Compares two byte arrays exactly.
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
 * Requires one ordinary non-array, non-proxy record.
 *
 * @param value - Candidate record.
 * @returns Validated record.
 */
function requireRecord(value: unknown): object {
  if (!isOrdinaryObject(value)) {
    return failCommittedPrefixApplySeal()
  }
  return value
}

/**
 * Checks whether one value is an ordinary data object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is an ordinary non-proxy object.
 */
function isOrdinaryObject(value: unknown): value is object {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !nodeUtilTypes.isProxy(value)
}

/**
 * Requires exactly the declared enumerable own data properties.
 *
 * @param value - Validated record.
 * @param expected - Exact required key set.
 */
function requireExactKeys(
  value: object,
  expected: readonly string[],
): void {
  const keys = Object.keys(value).sort()
  const ownKeys = Reflect.ownKeys(value)
  const expectedKeys = [...expected].sort()
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== keys.length ||
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return failCommittedPrefixApplySeal()
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failCommittedPrefixApplySeal()
    }
  }
}

/**
 * Reads one required enumerable own data property.
 *
 * @param value - Validated record.
 * @param key - Required property name.
 * @returns Exact untrusted value.
 */
function readOwn(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value')
  ) {
    return failCommittedPrefixApplySeal()
  }
  return descriptor.value
}

/**
 * Reads one safe migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Exact identifier.
 */
function readIdentifier(value: unknown): string {
  if (typeof value !== 'string') {
    return failCommittedPrefixApplySeal()
  }
  try {
    requireMigrationIdentifier(value, 'Migration identifier')
  } catch {
    return failCommittedPrefixApplySeal()
  }
  return value
}

/**
 * Reads one lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Exact digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) {
    return failCommittedPrefixApplySeal()
  }
  return value
}

/**
 * Reads one positive safe integer.
 *
 * @param value - Candidate number.
 * @returns Exact positive safe integer.
 */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    return failCommittedPrefixApplySeal()
  }
  return value
}

/**
 * Reads one nonnegative safe integer.
 *
 * @param value - Candidate number.
 * @returns Exact nonnegative safe integer.
 */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failCommittedPrefixApplySeal()
  }
  return value
}

/**
 * Reads one canonical UTC millisecond timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Exact timestamp.
 */
function readTimestamp(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failCommittedPrefixApplySeal()
  }
  return value
}

/**
 * Reads one bounded nonempty safe text value.
 *
 * @param value - Candidate text.
 * @returns Exact text.
 */
function readText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumTextLength ||
    value !== value.trim() ||
    !hasOnlyPairedSurrogates(value)
  ) {
    return failCommittedPrefixApplySeal()
  }
  return value
}

/**
 * Reads one bounded immutable object version identifier.
 *
 * @param value - Candidate version identifier.
 * @returns Exact version identifier.
 */
function readVersionId(value: unknown): string {
  const versionId = readText(value)
  if (
    versionId.length > maximumVersionIdLength ||
    versionId === 'null'
  ) {
    return failCommittedPrefixApplySeal()
  }
  return versionId
}

/**
 * Runs one public operation behind the stable seal error boundary.
 *
 * @param operation - Exact synchronous operation.
 * @returns Successful result.
 */
function atCommittedPrefixApplySealBoundary<Result>(
  operation: () => Result,
): Result {
  try {
    return operation()
  } catch {
    throw new WorkspaceSearchMigrationCommittedPrefixApplySealError()
  }
}

/**
 * Raises the stable committed-prefix seal failure.
 *
 * @returns Never returns.
 */
function failCommittedPrefixApplySeal(): never {
  throw new WorkspaceSearchMigrationCommittedPrefixApplySealError()
}
