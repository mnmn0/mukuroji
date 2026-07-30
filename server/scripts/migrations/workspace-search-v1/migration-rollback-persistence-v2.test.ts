import { describe, expect, test } from 'bun:test'
import {
  serializeWorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES,
} from './migration-artifacts'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchApplySeal,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchOperationMarker,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationCommittedPrefixApplySeal,
  serializeWorkspaceSearchMigrationCommittedPrefixApplySeal,
  type WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor,
  type WorkspaceSearchMigrationCommittedPrefixApplySealReference,
} from './migration-committed-prefix-apply-seal'
import {
  createWorkspaceSearchMigrationCheckpointExecutionState,
  createWorkspaceSearchMigrationExecutionState,
  reconstructWorkspaceSearchMigrationRunState,
} from './migration-execution-state'
import {
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRunBinding,
} from './migration-execution-run'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import {
  createWorkspaceSearchMigrationPlanningProvenanceObjectKey,
} from './migration-planning-provenance-manifest'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  createWorkspaceSearchMigrationRollbackStartRootV2,
  parseWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  parseWorkspaceSearchMigrationRollbackPersistenceStateV2,
  parseWorkspaceSearchMigrationRollbackStartRootV2,
  serializeWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  serializeWorkspaceSearchMigrationRollbackPersistenceStateV2,
  serializeWorkspaceSearchMigrationRollbackStartRootV2,
  WorkspaceSearchMigrationRollbackPersistenceV2Error,
  type WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  type WorkspaceSearchMigrationRollbackStartRootV2,
} from './migration-rollback-persistence-v2'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationAuthority,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'

const runId = 'rollback-persistence-v2-test'
const ownerId = 'rollback-persistence-v2-owner'
const configurationTime = '2026-07-30T00:00:00.000Z'
const planCreatedAt = '2026-07-30T00:00:30.000Z'
const sealedAt = '2026-07-30T00:01:30.000Z'
const admissionCreatedAt = '2026-07-30T00:02:00.000Z'
const firstMarkerAt = '2026-07-30T00:02:30.000Z'
const secondMarkerAt = '2026-07-30T00:02:45.000Z'
const checkpointAt = '2026-07-30T00:03:00.000Z'
const authorityEvaluatedAt = '2026-07-30T00:03:15.000Z'
const sealCreatedAt = '2026-07-30T00:03:30.000Z'
const startedAt = '2026-07-30T00:04:00.000Z'
const retainUntil = '2026-09-01T00:00:00.000Z'

/**
 * Correlated immutable and current authority fixture.
 */
type RollbackPersistenceFixture = {
  /** Strict immutable execution admission. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** Strict immutable version-two planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Fresh current rollback-start authority. */
  readonly currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority
}

/**
 * Correlated pure seal and exact-version reference.
 */
type PrefixEvidence = {
  /** Strict pure committed-prefix seal. */
  readonly seal: WorkspaceSearchApplySeal
  /** Rich exact-version reference to the canonical seal. */
  readonly sealReference:
    WorkspaceSearchMigrationCommittedPrefixApplySealReference
}

describe('Workspace Search rollback persistence v2', () => {
  test('round-trips admission origin, start root, and initial state', () => {
    const fixture = createFixture(2)
    const predecessor = {
      kind: 'execution-run-admission',
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const evidence = createPrefixEvidence(fixture, predecessor)
    const origin = createOrigin(fixture, predecessor, evidence)
    const root = createRoot(fixture, predecessor, evidence)

    expect(
      parseWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
        serializeWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
          origin,
        ),
      ),
    ).toEqual(origin)
    expect(
      parseWorkspaceSearchMigrationRollbackStartRootV2(
        serializeWorkspaceSearchMigrationRollbackStartRootV2(root),
      ),
    ).toEqual(root)
    expect(
      parseWorkspaceSearchMigrationRollbackPersistenceStateV2(
        serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
          root.initialState,
        ),
      ),
    ).toEqual(root.initialState)
    expect(root).toMatchObject({
      predecessorRevision: 1,
      originalJournalSequence: 0,
      initialState: {
        revision: 2,
        upperBoundSequence: 0,
        nextSequence: 0,
        expectedHeadDigest: '0'.repeat(64),
      },
    })
  })

  test('accepts no-op-only v1 and mixed mutation-plus-no-op prefixes', () => {
    const noOpFixture = createFixture(1)
    const noOpMarker = createNoOpMarker(
      noOpFixture.admission,
      1,
      firstMarkerAt,
    )
    const noOpState = createWorkspaceSearchMigrationExecutionState({
      admission: noOpFixture.admission,
      nextRunState: advanceRunState(
        noOpFixture.admission.runState,
        noOpMarker,
      ),
      marker: noOpMarker,
    })
    const noOpPredecessor = {
      kind: 'mutable-execution-state',
      executionState: noOpState,
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const noOpEvidence = createPrefixEvidence(
      noOpFixture,
      noOpPredecessor,
    )
    const noOpRoot = createRoot(
      noOpFixture,
      noOpPredecessor,
      noOpEvidence,
    )
    expect(noOpRoot).toMatchObject({
      originalJournalSequence: 0,
      initialState: {
        upperBoundSequence: 0,
        nextSequence: 0,
      },
    })

    const mixedFixture = createFixture(2)
    const mutationMarker = createMutationMarker(
      mixedFixture.admission,
      1,
      1,
      firstMarkerAt,
      retainUntil,
      '0'.repeat(64),
    )
    const mutationState =
      createWorkspaceSearchMigrationExecutionState({
        admission: mixedFixture.admission,
        nextRunState: advanceRunState(
          mixedFixture.admission.runState,
          mutationMarker,
        ),
        marker: mutationMarker,
      })
    const trailingNoOp = createNoOpMarker(
      mixedFixture.admission,
      2,
      secondMarkerAt,
    )
    const mixedRunState = advanceRunState(
      reconstructWorkspaceSearchMigrationRunState(
        mixedFixture.admission,
        mutationState,
      ),
      trailingNoOp,
    )
    const mixedState =
      createWorkspaceSearchMigrationExecutionState({
        admission: mixedFixture.admission,
        predecessor: mutationState,
        nextRunState: mixedRunState,
        marker: trailingNoOp,
      })
    const mixedPredecessor = {
      kind: 'mutable-execution-state',
      executionState: mixedState,
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const mixedEvidence = createPrefixEvidence(
      mixedFixture,
      mixedPredecessor,
    )
    const mixedRoot = createRoot(
      mixedFixture,
      mixedPredecessor,
      mixedEvidence,
    )
    expect(mixedRoot).toMatchObject({
      originalJournalSequence: 1,
      originalJournalHeadDigest: mutationMarker.journal.headDigest,
      initialState: {
        upperBoundSequence: 1,
        nextSequence: 1,
        expectedHeadDigest: mutationMarker.journal.headDigest,
      },
    })
  })

  test('accepts a v2 checkpoint and round-trips a binary cursor losslessly', () => {
    const fixture = createFixture(1)
    const marker = createNoOpMarker(
      fixture.admission,
      1,
      firstMarkerAt,
    )
    const v1State = createWorkspaceSearchMigrationExecutionState({
      admission: fixture.admission,
      nextRunState: advanceRunState(
        fixture.admission.runState,
        marker,
      ),
      marker,
    })
    const v2State =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission: fixture.admission,
        predecessor: v1State,
        authority: createCheckpointAuthority(fixture.admission),
        location: 'project-directory',
        checkpoint: createBinaryCheckpoint(),
      })
    const predecessor = {
      kind: 'mutable-execution-state',
      executionState: v2State,
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const evidence = createPrefixEvidence(fixture, predecessor)
    const root = createRoot(fixture, predecessor, evidence)
    const bytes =
      serializeWorkspaceSearchMigrationRollbackStartRootV2(root)
    const parsed =
      parseWorkspaceSearchMigrationRollbackStartRootV2(bytes)

    expect(parsed.origin.predecessor).toMatchObject({
      kind: 'mutable-execution-state',
      executionStateVersion: 2,
    })
    expect(
      parsed.initialState.runState.apply.sources[
        'project-directory'
      ].cursor,
    ).toEqual(createBinaryCheckpoint().cursor)
    expect(
      serializeWorkspaceSearchMigrationRollbackStartRootV2(parsed),
    ).toEqual(bytes)
  })

  test('rejects start-window retention at the exact boundary', () => {
    const boundary = new Date(
      Date.parse(startedAt) +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
    ).toISOString()
    const sealFixture = createFixture(1)
    const admissionPredecessor = {
      kind: 'execution-run-admission',
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const sealEvidence = createPrefixEvidence(
      sealFixture,
      admissionPredecessor,
      boundary,
    )
    expectV2Failure(() =>
      createRoot(
        sealFixture,
        admissionPredecessor,
        sealEvidence,
      )
    )

    const lateStartedAt = new Date(
      Date.parse(retainUntil) -
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
    ).toISOString()
    const lateAuthorityAt = new Date(
      Date.parse(lateStartedAt) - 20_000,
    ).toISOString()
    const lateSealAt = new Date(
      Date.parse(lateStartedAt) -
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS -
        1_000,
    ).toISOString()
    const planFixture = withCurrentAuthority(
      createFixture(1),
      lateAuthorityAt,
      lateStartedAt,
    )
    const planEvidence = createPrefixEvidence(
      planFixture,
      admissionPredecessor,
      '2026-09-02T00:00:00.000Z',
      lateSealAt,
    )
    expectV2Failure(() =>
      createRoot(
        planFixture,
        admissionPredecessor,
        planEvidence,
        lateStartedAt,
      )
    )

    const journalFixture = withCurrentAuthority(
      createFixture(1),
      lateAuthorityAt,
      lateStartedAt,
    )
    const marker = createMutationMarker(
      journalFixture.admission,
      1,
      1,
      firstMarkerAt,
      retainUntil,
      '0'.repeat(64),
    )
    const state = createWorkspaceSearchMigrationExecutionState({
      admission: journalFixture.admission,
      nextRunState: advanceRunState(
        journalFixture.admission.runState,
        marker,
      ),
      marker,
    })
    const predecessor = {
      kind: 'mutable-execution-state',
      executionState: state,
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const evidence = createPrefixEvidence(
      journalFixture,
      predecessor,
      '2026-09-02T00:00:00.000Z',
      lateSealAt,
    )
    expectV2Failure(() =>
      createRoot(
        journalFixture,
        predecessor,
        evidence,
        lateStartedAt,
      )
    )
  })

  test('rejects noncanonical and tampered origin, state, and root bytes', () => {
    const fixture = createFixture(1)
    const predecessor = {
      kind: 'execution-run-admission',
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const evidence = createPrefixEvidence(fixture, predecessor)
    const origin = createOrigin(fixture, predecessor, evidence)
    const root = createRoot(fixture, predecessor, evidence)
    const originBytes =
      serializeWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
        origin,
      )
    const noncanonicalOrigin = new TextEncoder().encode(
      `${new TextDecoder().decode(originBytes)}\n`,
    )
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
        noncanonicalOrigin,
      )
    )
    expectTamperRejected(
      originBytes,
      'planOperationCount',
      99,
      parseWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
    )
    expectTamperRejected(
      serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
        root.initialState,
      ),
      'nextSequence',
      1,
      parseWorkspaceSearchMigrationRollbackPersistenceStateV2,
    )
    expectTamperRejected(
      serializeWorkspaceSearchMigrationRollbackStartRootV2(root),
      'originalJournalSequence',
      1,
      parseWorkspaceSearchMigrationRollbackStartRootV2,
    )
  })

  test('rejects authority regression and extra runtime run-state fields', () => {
    const fixture = createFixture(1)
    const predecessor = {
      kind: 'execution-run-admission',
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const evidence = createPrefixEvidence(fixture, predecessor)
    const regressedAuthority =
      structuredClone(fixture.currentAuthority)
    Reflect.set(
      regressedAuthority,
      'maintenanceEvidencePointerRevision',
      3,
    )
    expectV2Failure(() =>
      createRoot(
        {
          ...fixture,
          currentAuthority: regressedAuthority,
        },
        predecessor,
        evidence,
      )
    )

    const root = createRoot(fixture, predecessor, evidence)
    const stateWithExtraRunField =
      structuredClone(root.initialState)
    Reflect.set(
      stateWithExtraRunField.runState,
      'untrustedExtraField',
      true,
    )
    expectV2Failure(() =>
      serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
        stateWithExtraRunField,
      )
    )
  })

  test('rejects recomputed retention and origin-seal mismatch roots', () => {
    const fixture = createFixture(1)
    const admissionPredecessor = {
      kind: 'execution-run-admission',
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const admissionEvidence = createPrefixEvidence(
      fixture,
      admissionPredecessor,
    )
    const admissionRoot = createRoot(
      fixture,
      admissionPredecessor,
      admissionEvidence,
    )
    const lateDocument = decodeCanonicalRecord(
      serializeWorkspaceSearchMigrationRollbackStartRootV2(
        admissionRoot,
      ),
    )
    const lateState = readTestRecord(
      Reflect.get(lateDocument, 'initialState'),
    )
    const lateRunState = readTestRecord(
      Reflect.get(lateState, 'runState'),
    )
    const lateStartedAt = new Date(
      Date.parse(retainUntil) -
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
    ).toISOString()
    Reflect.set(lateDocument, 'startedAt', lateStartedAt)
    Reflect.set(lateRunState, 'updatedAt', lateStartedAt)
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationRollbackStartRootV2(
        redigestRootDocument(lateDocument),
      )
    )

    const marker = createNoOpMarker(
      fixture.admission,
      1,
      firstMarkerAt,
    )
    const executionState =
      createWorkspaceSearchMigrationExecutionState({
        admission: fixture.admission,
        nextRunState: advanceRunState(
          fixture.admission.runState,
          marker,
        ),
        marker,
      })
    const mutablePredecessor = {
      kind: 'mutable-execution-state',
      executionState,
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const mutableEvidence = createPrefixEvidence(
      fixture,
      mutablePredecessor,
    )
    const mutableRoot = createRoot(
      fixture,
      mutablePredecessor,
      mutableEvidence,
    )
    const mismatchDocument = decodeCanonicalRecord(
      serializeWorkspaceSearchMigrationRollbackStartRootV2(
        mutableRoot,
      ),
    )
    const mismatchState = readTestRecord(
      Reflect.get(mismatchDocument, 'initialState'),
    )
    const mismatchRunState = readTestRecord(
      Reflect.get(mismatchState, 'runState'),
    )
    Reflect.set(mismatchRunState, 'appliedOperationCount', 0)
    Reflect.set(
      mismatchRunState,
      'applyMarkerDigestState',
      fixture.admission.runState.applyMarkerDigestState,
    )
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationRollbackStartRootV2(
        redigestRootDocument(mismatchDocument),
      )
    )
  })

  test('rejects re-digested noncanonical plan-seal references', () => {
    const fixture = createFixture(1)
    const predecessor = {
      kind: 'execution-run-admission',
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const evidence = createPrefixEvidence(fixture, predecessor)
    const origin = createOrigin(fixture, predecessor, evidence)
    const originDocument = decodeCanonicalRecord(
      serializeWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
        origin,
      ),
    )
    const planReference = readTestRecord(
      Reflect.get(originDocument, 'planSealReference'),
    )
    Reflect.set(
      planReference,
      'objectKey',
      `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/other/${planReference.contentDigest}.artifact`,
    )
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
        redigestOriginDocument(originDocument),
      )
    )

    const root = createRoot(fixture, predecessor, evidence)
    const rootDocument = decodeCanonicalRecord(
      serializeWorkspaceSearchMigrationRollbackStartRootV2(root),
    )
    const embeddedOrigin = readTestRecord(
      Reflect.get(rootDocument, 'origin'),
    )
    const embeddedPlanReference = readTestRecord(
      Reflect.get(embeddedOrigin, 'planSealReference'),
    )
    Reflect.set(
      embeddedPlanReference,
      'byteLength',
      WORKSPACE_SEARCH_MIGRATION_PLAN_SEAL_MAX_BYTES + 1,
    )
    const replacementOriginDigest =
      redigestOriginRecord(embeddedOrigin)
    Reflect.set(
      rootDocument,
      'originDigest',
      replacementOriginDigest,
    )
    const initialState = readTestRecord(
      Reflect.get(rootDocument, 'initialState'),
    )
    Reflect.set(
      initialState,
      'originDigest',
      replacementOriginDigest,
    )
    Reflect.set(
      initialState,
      'predecessorDigest',
      replacementOriginDigest,
    )
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationRollbackStartRootV2(
        redigestRootDocument(rootDocument),
      )
    )
  })
})

/**
 * Creates one strict immutable origin from correlated evidence.
 *
 * @param fixture - Correlated admission and planning authority.
 * @param predecessor - Exact admission or mutable predecessor.
 * @param evidence - Exact committed-prefix seal and reference.
 * @returns Strict immutable rollback origin.
 */
function createOrigin(
  fixture: RollbackPersistenceFixture,
  predecessor:
    WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor,
  evidence: PrefixEvidence,
): WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2 {
  return createWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2(
    {
      admission: fixture.admission,
      predecessor,
      sealedPlanningAuthority: fixture.sealedPlanningAuthority,
      seal: evidence.seal,
      sealReference: evidence.sealReference,
    },
  )
}

/**
 * Creates one strict immutable start root from correlated evidence.
 *
 * @param fixture - Correlated admission and current authority.
 * @param predecessor - Exact admission or mutable predecessor.
 * @param evidence - Exact committed-prefix seal and reference.
 * @param rootStartedAt - Optional adapter-owned start time.
 * @returns Strict immutable rollback-start root.
 */
function createRoot(
  fixture: RollbackPersistenceFixture,
  predecessor:
    WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor,
  evidence: PrefixEvidence,
  rootStartedAt = startedAt,
): WorkspaceSearchMigrationRollbackStartRootV2 {
  return createWorkspaceSearchMigrationRollbackStartRootV2({
    admission: fixture.admission,
    predecessor,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    seal: evidence.seal,
    sealReference: evidence.sealReference,
    currentAuthority: fixture.currentAuthority,
    startedAt: rootStartedAt,
  })
}

/**
 * Creates one exact committed-prefix seal and rich reference.
 *
 * @param fixture - Correlated admission and planning authority.
 * @param predecessor - Exact admission or mutable predecessor.
 * @param referenceRetainUntil - Optional exact seal retention deadline.
 * @param createdAt - Optional canonical seal creation time.
 * @returns Strict committed-prefix evidence.
 */
function createPrefixEvidence(
  fixture: RollbackPersistenceFixture,
  predecessor:
    WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor,
  referenceRetainUntil = retainUntil,
  createdAt = sealCreatedAt,
): PrefixEvidence {
  const seal =
    createWorkspaceSearchMigrationCommittedPrefixApplySeal({
      admission: fixture.admission,
      predecessor,
      sealedPlanningAuthority: fixture.sealedPlanningAuthority,
      createdAt,
    })
  const bytes =
    serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(seal)
  const contentDigest = createMigrationDigest(seal)
  return {
    seal,
    sealReference: {
      scope: 'committed-prefix',
      objectKey:
        `workspace-search/v1/apply-seals/${contentDigest}.json`,
      versionId: 'rollback-persistence-v2-seal-version',
      contentDigest,
      byteLength: bytes.byteLength,
      retainUntil: referenceRetainUntil,
    },
  }
}

/**
 * Creates one fully correlated strict persistence fixture.
 *
 * @param planOperationCount - Exact selected plan size.
 * @param planRetainUntil - Optional exact plan-artifact retention deadline.
 * @returns Immutable admission, planning root, and fresh authority.
 */
function createFixture(
  planOperationCount: number,
  planRetainUntil = retainUntil,
): RollbackPersistenceFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const tableIds = createTableIds(configuration)
  const planSeal = createPlanSeal(
    configurationHash,
    planOperationCount,
  )
  const sealedPlanningAuthority = createSealedAuthority(
    configurationHash,
    tableIds,
    planSeal,
    planRetainUntil,
  )
  const admittedReceipt = createMaintenanceReceipt(
    'admitted',
    '2026-07-30T00:01:00.000Z',
  )
  const runState = createWorkspaceSearchMigrationRunState({
    runId,
    lease: {
      runId,
      ownerId,
      fenceToken: 7,
      heartbeatAt: '2026-07-30T00:01:30.000Z',
      expiresAt: '2026-07-30T00:02:30.000Z',
    },
    ownerId,
    configurationHash,
    configuration,
    maintenanceEvidenceReceipt: admittedReceipt,
    dryRunEvidenceDigest: planSeal.dryRunEvidenceDigest,
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSeal,
    planSealReference: {
      objectKey:
        sealedPlanningAuthority.planSealReference.objectKey,
      versionId:
        sealedPlanningAuthority.planSealReference.versionId,
      contentDigest:
        sealedPlanningAuthority.planSealReference.contentDigest,
    },
    createdAt: admissionCreatedAt,
  })
  const bindingFields = {
    kind: 'workspace-search-migration-execution-run-binding',
    bindingVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds,
    executionBoundaryDigest: digest('execution-boundary'),
    closedWriterFenceRecordDigest:
      digest('closed-writer-fence'),
    sealedPlanningAuthorityDigest:
      sealedPlanningAuthority.authorityDigest,
    planDigest: sealedPlanningAuthority.planDigest,
    planOperationCount:
      sealedPlanningAuthority.planOperationCount,
    planSealReference:
      sealedPlanningAuthority.planSealReference,
    currentAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 4,
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(admittedReceipt),
      evaluatedAt: '2026-07-30T00:01:45.000Z',
    },
    planningAdmittedAt: '2026-07-30T00:00:15.000Z',
    sealedAt,
    createdAt: admissionCreatedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRunBinding,
    'bindingDigest'
  >
  const binding = {
    ...bindingFields,
    bindingDigest: createMigrationDigest(bindingFields),
  }
  const executionRunFields = {
    kind: 'workspace-search-migration-execution-run',
    executionRunVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    revision: 1,
    status: 'applying',
    binding,
    runState,
    stateDigest: createMigrationDigest(runState),
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRun,
    'executionRunDigest'
  >
  const admission = {
    ...executionRunFields,
    executionRunDigest: createMigrationDigest(executionRunFields),
  }
  serializeWorkspaceSearchMigrationExecutionRun(admission)
  const currentReceipt = createMaintenanceReceipt(
    'current',
    checkpointAt,
  )
  const currentAuthority:
    WorkspaceSearchMigrationPrePlanAuthority = {
      configurationHash,
      stateTableId: tableIds['migration-state'],
      lease: {
        runId,
        ownerId,
        fenceToken: 7,
        heartbeatAt: authorityEvaluatedAt,
        expiresAt: '2026-07-30T00:04:15.000Z',
      },
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(currentReceipt),
      maintenanceEvidencePointerRevision: 5,
      maintenanceEvidenceReceipt: currentReceipt,
      evaluatedAt: authorityEvaluatedAt,
    }
  return {
    admission,
    sealedPlanningAuthority,
    currentAuthority,
  }
}

/**
 * Replaces a fixture's current authority with one valid near a later start.
 *
 * @param fixture - Exact immutable fixture to retain.
 * @param evaluatedAt - Canonical current-authority evaluation time.
 * @param rootStartedAt - Canonical later rollback-start time.
 * @returns Fixture carrying fresh late authority.
 */
function withCurrentAuthority(
  fixture: RollbackPersistenceFixture,
  evaluatedAt: string,
  rootStartedAt: string,
): RollbackPersistenceFixture {
  const oldestObservationAt = new Date(
    Date.parse(rootStartedAt) - 4 * 60_000,
  ).toISOString()
  const receipt = createMaintenanceReceipt(
    'late-current',
    evaluatedAt,
    oldestObservationAt,
  )
  return {
    ...fixture,
    currentAuthority: {
      configurationHash: fixture.admission.configurationHash,
      stateTableId:
        fixture.admission.binding.tableIds['migration-state'],
      lease: {
        runId,
        ownerId,
        fenceToken: 7,
        heartbeatAt: evaluatedAt,
        expiresAt: new Date(
          Date.parse(evaluatedAt) + 60_000,
        ).toISOString(),
      },
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(receipt),
      maintenanceEvidencePointerRevision: 6,
      maintenanceEvidenceReceipt: receipt,
      evaluatedAt,
    },
  }
}

/**
 * Creates one strict plan seal.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param planOperationCount - Exact selected plan size.
 * @returns Exact canonical plan seal.
 */
function createPlanSeal(
  configurationHash: string,
  planOperationCount: number,
): WorkspaceSearchPlanSeal {
  return {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest: planOperationCount === 0
      ? createEmptyWorkspaceSearchPlanDigest()
      : digest(`plan:${planOperationCount}`),
    planOperationCount,
    sourceOperationCount: planOperationCount,
    orphanOperationCount: 0,
    createdAt: planCreatedAt,
  }
}

/**
 * Creates one strict compact version-two planning authority.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - Exact physical table incarnations.
 * @param planSeal - Exact selected-plan seal.
 * @param planRetainUntil - Exact immutable plan retention deadline.
 * @returns Strict version-two planning root.
 */
function createSealedAuthority(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  planRetainUntil: string,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = createMigrationDigest(planSeal)
  const manifestDigest = digest('manifest')
  const provenanceDigest = digest('provenance')
  const fields = {
    kind: 'workspace-search-sealed-planning-authority',
    authorityVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    tableIds,
    planSealReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${planSealDigest}.artifact`,
      versionId: 'plan-seal-version-1',
      contentDigest: planSealDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil: planRetainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/manifest-heads/${manifestDigest}.artifact`,
      versionId: 'plan-manifest-version-1',
      contentDigest: manifestDigest,
      byteLength: 1,
      retainUntil,
    },
    planningProvenanceManifestHeadReference: {
      objectKey:
        createWorkspaceSearchMigrationPlanningProvenanceObjectKey(
          `workspace-search/v1/planning-provenance-artifacts/v1/${runId}/${configurationHash}`,
          'manifest-heads',
          provenanceDigest,
        ),
      versionId: 'provenance-manifest-version-1',
      contentDigest: provenanceDigest,
      byteLength: 1,
      retainUntil,
    },
    planDigest: planSeal.planDigest,
    planningSnapshotDigest: planSeal.planningSnapshotDigest,
    sourceOperationCount: planSeal.sourceOperationCount,
    orphanOperationCount: planSeal.orphanOperationCount,
    planOperationCount: planSeal.planOperationCount,
    planningAuthorityProvenanceDigest:
      digest('planning-authority-provenance'),
    historicalReceiptBindingDigest:
      digest('historical-receipts'),
    historicalReceiptCount: 1,
    evidenceHeads: [
      createEvidenceHead('project-directory'),
      createEvidenceHead('work-items'),
      createEvidenceHead('collaboration'),
      createEvidenceHead('documents'),
      createEvidenceHead('workspace-search'),
    ],
    currentAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        digest('sealed-maintenance-receipt'),
    },
    sealedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    'authorityDigest'
  >
  return {
    ...fields,
    authorityDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates one compact terminal planning evidence head.
 *
 * @param chain - Exact evidence-chain role.
 * @returns Exact terminal evidence commitment.
 */
function createEvidenceHead(
  chain:
    | 'collaboration'
    | 'documents'
    | 'project-directory'
    | 'work-items'
    | 'workspace-search',
) {
  return {
    chain,
    progressDigest: digest(`progress:${chain}`),
    pageCount: 1,
    terminalEvidenceDigest: digest(`evidence:${chain}`),
    terminalCheckpointDigest: digest(`checkpoint:${chain}`),
  }
}

/**
 * Creates one exact-window immutable maintenance receipt.
 *
 * @param salt - Stable receipt identity discriminator.
 * @param validatedAt - Canonical receipt validation time.
 * @param oldestObservationAt - Canonical oldest measurement time.
 * @returns Valid immutable maintenance evidence.
 */
function createMaintenanceReceipt(
  salt: string,
  validatedAt: string,
  oldestObservationAt = configurationTime,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest(`maintenance-evidence:${salt}`),
    evidenceLocator:
      `workspace-search/v1/maintenance/${salt}.json`,
    runtimeRevision: salt === 'admitted' ? 11 : 12,
    fenceToken: 7,
    validatedAt,
    oldestObservationAt,
    validUntil: new Date(
      Date.parse(oldestObservationAt) + 5 * 60_000 + 1,
    ).toISOString(),
  }
}

/**
 * Creates one strict already-current marker.
 *
 * @param admission - Immutable admission owning the marker.
 * @param planSequence - Exact selected-plan sequence.
 * @param recordedAt - Canonical marker commit time.
 * @returns Exact no-op marker.
 */
function createNoOpMarker(
  admission: WorkspaceSearchMigrationExecutionRun,
  planSequence: number,
  recordedAt: string,
): Extract<
  WorkspaceSearchOperationMarker,
  {
    readonly kind:
      'workspace-search-operation-already-current'
  }
> {
  return {
    kind: 'workspace-search-operation-already-current',
    markerVersion: 1,
    runId,
    configurationHash: admission.configurationHash,
    operationId: digest(`operation:${planSequence}`),
    planSequence,
    planOperationDigest:
      digest(`plan-operation:${planSequence}`),
    targetKeyDigest: digest(`target-key:${planSequence}`),
    afterDigest: digest(`after:${planSequence}`),
    fenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(
        admission.runState.maintenanceEvidenceReceipt,
      ),
    recordedAt,
  }
}

/**
 * Creates one strict mutating marker and journal link.
 *
 * @param admission - Immutable admission owning the marker.
 * @param planSequence - Exact selected-plan sequence.
 * @param sequence - Exact mutation-only journal sequence.
 * @param committedAt - Canonical marker commit time.
 * @param journalRetainUntil - Exact journal retention deadline.
 * @param previousHeadDigest - Exact previous journal head.
 * @returns Exact mutating operation receipt.
 */
function createMutationMarker(
  admission: WorkspaceSearchMigrationExecutionRun,
  planSequence: number,
  sequence: number,
  committedAt: string,
  journalRetainUntil: string,
  previousHeadDigest: string,
): WorkspaceSearchOperationReceipt {
  const operationId = digest(`mutation:${planSequence}`)
  const contentDigest = digest(`journal:${sequence}`)
  const versionId = `journal-version-${sequence}`
  const headDigest = createJournalHeadDigest({
    previousHeadDigest,
    sequence,
    operationId,
    contentDigest,
    versionId,
  })
  return {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId,
    configurationHash: admission.configurationHash,
    operationId,
    planSequence,
    planOperationDigest:
      digest(`plan-operation:${planSequence}`),
    sequence,
    targetKeyDigest: digest(`target-key:${planSequence}`),
    sourceDigest: digest(`source:${planSequence}`),
    beforeDigest: digest(`before:${planSequence}`),
    afterDigest: digest(`after:${planSequence}`),
    fenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(
        admission.runState.maintenanceEvidenceReceipt,
      ),
    journal: {
      objectKey:
        `workspace-search/v1/journal/${operationId}.json`,
      versionId,
      contentDigest,
      byteLength: 1,
      retainUntil: journalRetainUntil,
      headDigest,
    },
    committedAt,
  }
}

/**
 * Advances operation-only run-state fields for one strict marker.
 *
 * @param current - Exact current applying state.
 * @param marker - Exact next durable operation marker.
 * @returns Complete expected successor run state.
 */
function advanceRunState(
  current: WorkspaceSearchMigrationRunState,
  marker: WorkspaceSearchOperationMarker,
): WorkspaceSearchMigrationRunState {
  const accumulator = MigrationDigestAccumulator.fromState(
    current.applyMarkerDigestState,
  )
  accumulator.add(createMigrationDigest(marker))
  return {
    ...current,
    revision: current.revision + 1,
    appliedOperationCount: current.appliedOperationCount + 1,
    applyMarkerDigestState: accumulator.exportState(),
    updatedAt: marker.kind ===
        'workspace-search-operation-applied'
      ? marker.committedAt
      : marker.recordedAt,
    ...(marker.kind === 'workspace-search-operation-applied'
      ? {
          journalSequence: marker.sequence,
          journalHeadDigest: marker.journal.headDigest,
        }
      : {}),
  }
}

/**
 * Creates one active checkpoint authority.
 *
 * @param admission - Immutable admission owning traversal progress.
 * @returns Exact active fenced checkpoint authority.
 */
function createCheckpointAuthority(
  admission: WorkspaceSearchMigrationExecutionRun,
): WorkspaceSearchMigrationAuthority {
  return {
    lease: {
      runId: admission.runId,
      ownerId,
      fenceToken: 7,
      heartbeatAt: firstMarkerAt,
      expiresAt: '2026-07-30T00:03:30.000Z',
    },
    ownerId,
    at: checkpointAt,
  }
}

/**
 * Creates one valid checkpoint carrying a binary range key.
 *
 * @returns Exact resumable one-page checkpoint.
 */
function createBinaryCheckpoint(): MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  keyAccumulator.add(digest('binary-checkpoint-key'))
  contentAccumulator.add(digest('binary-checkpoint-content'))
  return {
    completed: false,
    cursor: {
      directoryId: { S: 'directory-1' },
      entryKey: { B: Uint8Array.of(0, 127, 255) },
    },
    aggregate: {
      scanned: 1,
      mapped: 1,
      ignored: 0,
      invalid: 0,
      projected: 1,
      deleted: 0,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount: 1,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
}

/**
 * Creates one complete measured migration configuration.
 *
 * @returns Stable measured configuration with a binary source range key.
 */
function createConfiguration():
WorkspaceSearchMigrationConfiguration {
  return {
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    account: '123456789012',
    region: 'ap-northeast-1',
    profile: 'production-operator',
    commit: 'a'.repeat(40),
    callerArn:
      'arn:aws:sts::123456789012:assumed-role/migration-operator/session',
    callerRoleId: 'AROA1234567890ABCDEFG',
    tables: {
      'project-directory':
        createSourceTable('project-directory'),
      'work-items': createSourceTable('work-items'),
      collaboration: createSourceTable('collaboration'),
      documents: createSourceTable('documents'),
      'workspace-search':
        createSupportingTable('workspace-search'),
      'migration-state':
        createSupportingTable('migration-state'),
    },
    journal: {
      bucketName:
        'mukuroji-workspace-search-migration-journal',
      keyArn:
        'arn:aws:kms:ap-northeast-1:123456789012:key/00000000-0000-0000-0000-000000000001',
      keyCreationTime: configurationTime,
      keyManager: 'CUSTOMER',
      keyState: 'Enabled',
      keySpec: 'SYMMETRIC_DEFAULT',
      keyUsage: 'ENCRYPT_DECRYPT',
      keyOrigin: 'AWS_KMS',
      keyMultiRegion: false,
      versioning: 'Enabled',
      objectLockMode: 'COMPLIANCE',
      defaultRetentionDays: 30,
      encryption: 'aws:kms',
      bucketKeyEnabled: true,
      accessLogBucket: 'mukuroji-access-logs',
      accessLogPrefix: 'workspace-search-migration/',
    },
    journalPrefix: 'workspace-search/v1',
  }
}

/**
 * Creates one measured source table.
 *
 * @param role - Logical source role.
 * @returns Complete source table identity.
 */
function createSourceTable(
  role: WorkspaceSearchMigrationSourceName,
): MigrationTableIdentity {
  return createTable(role, sourceKeyDescriptors(role), false)
}

/**
 * Creates one measured supporting table.
 *
 * @param role - Target or migration-state role.
 * @returns Complete supporting table identity.
 */
function createSupportingTable(
  role: 'migration-state' | 'workspace-search',
): MigrationTableIdentity {
  return createTable(
    role,
    role === 'workspace-search'
      ? [
          { name: 'workspaceId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ]
      : [
          { name: 'migrationId', role: 'HASH', type: 'S' },
          { name: 'recordKey', role: 'RANGE', type: 'S' },
        ],
    true,
  )
}

/**
 * Creates one complete measured table identity.
 *
 * @param role - Logical table role.
 * @param key - Exact base-table key schema.
 * @param deletionProtection - Measured protection status.
 * @returns Complete physical table identity.
 */
function createTable(
  role: MigrationTableIdentity['role'],
  key: readonly MigrationKeyAttribute[],
  deletionProtection: boolean,
): MigrationTableIdentity {
  return {
    role,
    tableName: `table-${role}`,
    tableArn:
      `arn:aws:dynamodb:ap-northeast-1:123456789012:table/table-${role}`,
    tableId: `table-id-${role}`,
    creationTime: '2026-01-01T00:00:00.000Z',
    account: '123456789012',
    region: 'ap-northeast-1',
    key,
    globalSecondaryIndexes: [],
    billingMode: 'PAY_PER_REQUEST',
    deletionProtection,
    encryption: role === 'documents' ? 'KMS' : 'AWS_OWNED',
    kmsKeyDigest: role === 'documents'
      ? digest('documents-key')
      : null,
    ttl: role === 'collaboration'
      ? { status: 'ENABLED', attribute: 'expiresAt' }
      : role === 'documents'
        ? { status: 'ENABLED', attribute: 'expiresAtEpoch' }
        : { status: 'DISABLED' },
    pitr: {
      status: 'ENABLED',
      earliestRestorableTime: '2026-07-01T00:00:00.000Z',
      latestRestorableTime: '2026-07-26T00:00:00.000Z',
    },
  }
}

/**
 * Returns one source table's ordered primary-key schema.
 *
 * @param role - Logical source role.
 * @returns Ordered key descriptors.
 */
function sourceKeyDescriptors(
  role: WorkspaceSearchMigrationSourceName,
): readonly MigrationKeyAttribute[] {
  if (role === 'project-directory') {
    return [
      { name: 'directoryId', role: 'HASH', type: 'S' },
      { name: 'entryKey', role: 'RANGE', type: 'B' },
    ]
  }
  if (role === 'work-items') {
    return [
      { name: 'directoryTeamId', role: 'HASH', type: 'S' },
      { name: 'issueId', role: 'RANGE', type: 'S' },
    ]
  }
  if (role === 'collaboration') {
    return [
      { name: 'entityKey', role: 'HASH', type: 'S' },
      { name: 'recordKey', role: 'RANGE', type: 'S' },
    ]
  }
  return [
    { name: 'workspaceId', role: 'HASH', type: 'S' },
    { name: 'recordKey', role: 'RANGE', type: 'S' },
  ]
}

/**
 * Creates all six exact physical TableIds.
 *
 * @param configuration - Exact measured configuration.
 * @returns Fixed-role physical table identities.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationSealedPlanningTableIds {
  return {
    'project-directory':
      configuration.tables['project-directory'].tableId,
    'work-items': configuration.tables['work-items'].tableId,
    collaboration:
      configuration.tables.collaboration.tableId,
    documents: configuration.tables.documents.tableId,
    'workspace-search':
      configuration.tables['workspace-search'].tableId,
    'migration-state':
      configuration.tables['migration-state'].tableId,
  }
}

/**
 * Creates one stable test digest.
 *
 * @param label - Nonsecret fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest({ label })
}

/**
 * Requires one callback to fail at the stable persistence boundary.
 *
 * @param operation - Candidate invalid operation.
 */
function expectV2Failure(operation: () => unknown): void {
  expect(operation).toThrow(
    WorkspaceSearchMigrationRollbackPersistenceV2Error,
  )
}

/**
 * Mutates one canonical top-level field without updating self digests.
 *
 * @param bytes - Exact canonical source bytes.
 * @param key - Top-level field to replace.
 * @param value - Replacement value.
 * @param parse - Strict parser expected to reject the tamper.
 */
function expectTamperRejected(
  bytes: Uint8Array,
  key: string,
  value: unknown,
  parse: (candidate: Uint8Array) => unknown,
): void {
  const decoded: unknown = JSON.parse(
    new TextDecoder().decode(bytes),
  )
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded)
  ) {
    throw new Error('Test fixture did not decode to an object.')
  }
  Reflect.set(decoded, key, value)
  const tampered = new TextEncoder().encode(
    serializeCanonicalJson(decoded),
  )
  expectV2Failure(() => parse(tampered))
}

/**
 * Decodes canonical test bytes into one ordinary record.
 *
 * @param bytes - Canonical JSON bytes produced by the tested codec.
 * @returns Mutable ordinary record used only for adversarial fixtures.
 */
function decodeCanonicalRecord(
  bytes: Uint8Array,
): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes))
  return readTestRecord(value)
}

/**
 * Narrows one adversarial fixture node to an ordinary record.
 *
 * @param value - Candidate parsed fixture node.
 * @returns Exact ordinary record.
 */
function readTestRecord(
  value: unknown,
): Record<string, unknown> {
  if (!isTestRecord(value)) {
    throw new Error('Test fixture node is not an object.')
  }
  return value
}

/**
 * Checks whether one adversarial fixture node is an ordinary record.
 *
 * @param value - Candidate parsed fixture node.
 * @returns Whether string-key access is safe for this test helper.
 */
function isTestRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
}

/**
 * Copies enumerable record fields except for selected keys.
 *
 * @param value - Source ordinary record.
 * @param excluded - Keys omitted from the copy.
 * @returns Detached ordinary record.
 */
function copyRecordWithout(
  value: Readonly<Record<string, unknown>>,
  excluded: ReadonlySet<string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!excluded.has(key)) result[key] = entry
  }
  return result
}

/**
 * Recomputes one origin self-digest after an adversarial test mutation.
 *
 * @param origin - Mutable canonical origin document.
 * @returns Replacement canonical origin digest.
 */
function redigestOriginRecord(
  origin: Record<string, unknown>,
): string {
  const common = copyRecordWithout(
    origin,
    new Set(['originDigest']),
  )
  const originDigest = createMigrationDigest(common)
  Reflect.set(origin, 'originDigest', originDigest)
  return originDigest
}

/**
 * Recomputes one origin digest and returns canonical mutated bytes.
 *
 * @param origin - Mutable canonical origin document.
 * @returns Canonical bytes with the replacement digest.
 */
function redigestOriginDocument(
  origin: Record<string, unknown>,
): Uint8Array {
  redigestOriginRecord(origin)
  return new TextEncoder().encode(serializeCanonicalJson(origin))
}

/**
 * Recomputes all state and non-circular root digests after a test mutation.
 *
 * @param root - Mutable canonical root document.
 * @returns Canonical bytes carrying internally coherent replacement digests.
 */
function redigestRootDocument(
  root: Record<string, unknown>,
): Uint8Array {
  const state = readTestRecord(Reflect.get(root, 'initialState'))
  const runState = readTestRecord(Reflect.get(state, 'runState'))
  const runStateDigest = createMigrationDigest(runState)
  Reflect.set(state, 'runStateDigest', runStateDigest)

  const provisionalStateCommon = copyRecordWithout(
    state,
    new Set(['stateDigest']),
  )
  Reflect.set(
    state,
    'stateDigest',
    createMigrationDigest(provisionalStateCommon),
  )
  Reflect.set(root, 'initialRunStateDigest', runStateDigest)

  const rootCommon = copyRecordWithout(
    root,
    new Set(['startRootDigest']),
  )
  const initialCore = copyRecordWithout(
    state,
    new Set(['startRootDigest', 'stateDigest']),
  )
  Reflect.set(rootCommon, 'initialState', initialCore)
  Reflect.set(
    rootCommon,
    'initialStateDigest',
    createMigrationDigest(initialCore),
  )
  const startRootDigest = createMigrationDigest(rootCommon)

  Reflect.set(state, 'startRootDigest', startRootDigest)
  const finalStateCommon = copyRecordWithout(
    state,
    new Set(['stateDigest']),
  )
  const stateDigest = createMigrationDigest(finalStateCommon)
  Reflect.set(state, 'stateDigest', stateDigest)
  Reflect.set(root, 'initialStateDigest', stateDigest)
  Reflect.set(root, 'startRootDigest', startRootDigest)
  return new TextEncoder().encode(serializeCanonicalJson(root))
}
