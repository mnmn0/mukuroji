import { describe, expect, test } from 'bun:test'
import {
  serializeWorkspaceSearchPlanSeal,
} from './migration-artifacts'
import {
  createJournalHeadDigest,
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  MigrationDigestAccumulator,
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
  parseWorkspaceSearchMigrationCommittedPrefixApplySeal,
  readWorkspaceSearchMigrationCommittedPrefixApplySealReference,
  requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding,
  serializeWorkspaceSearchMigrationCommittedPrefixApplySeal,
  type WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor,
  type WorkspaceSearchMigrationCommittedPrefixApplySealReference,
  WorkspaceSearchMigrationCommittedPrefixApplySealError,
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
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import type {
  WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationRunState,
  reduceWorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationAuthority,
} from './migration-state-machine'

const runId = 'committed-prefix-seal-test'
const ownerId = 'committed-prefix-owner'
const configurationTime = '2026-07-30T00:00:00.000Z'
const planCreatedAt = '2026-07-30T00:00:30.000Z'
const sealedAt = '2026-07-30T00:01:30.000Z'
const admissionCreatedAt = '2026-07-30T00:02:00.000Z'
const sealCreatedAt = '2026-07-30T00:03:00.000Z'
const retainUntil = '2026-09-01T00:00:00.000Z'

/**
 * Correlated admission and sealed planning-authority fixture.
 */
type CommittedPrefixFixture = {
  /** Strict immutable execution admission. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** Strict immutable version-two planning authority. */
  readonly authority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
}

describe('Workspace Search committed-prefix apply seal', () => {
  test('creates admission-only bytes and binds their exact rich reference', () => {
    const fixture = createFixture()
    const seal =
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor: { kind: 'execution-run-admission' },
        sealedPlanningAuthority: fixture.authority,
        createdAt: sealCreatedAt,
      })
    const bytes =
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        seal,
      )
    const reference = {
      scope: 'committed-prefix',
      objectKey:
        `workspace-search/v1/apply-seals/${createMigrationDigest(seal)}.json`,
      versionId: 'committed-prefix-version-1',
      contentDigest: createMigrationDigest(seal),
      byteLength: bytes.byteLength,
      retainUntil,
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealReference

    expect(
      parseWorkspaceSearchMigrationCommittedPrefixApplySeal(
        bytes,
      ),
    ).toEqual(seal)
    expect(seal).toMatchObject({
      scope: 'committed-prefix',
      planOperationCount: 0,
      markerCount: 0,
      journalSequence: 0,
      journalHeadDigest: '0'.repeat(64),
    })
    expect(
      requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding({
        admission: fixture.admission,
        predecessor: { kind: 'execution-run-admission' },
        sealedPlanningAuthority: fixture.authority,
        seal,
        reference,
      }),
    ).toEqual(reference)
  })

  test('rejects noncanonical bytes and mismatched identity or reference', () => {
    const fixture = createFixture()
    const seal =
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor: { kind: 'execution-run-admission' },
        sealedPlanningAuthority: fixture.authority,
        createdAt: sealCreatedAt,
      })
    const bytes =
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        seal,
      )
    const noncanonical = new TextEncoder().encode(
      `${new TextDecoder().decode(bytes)}\n`,
    )
    expectFailure(() =>
      parseWorkspaceSearchMigrationCommittedPrefixApplySeal(
        noncanonical,
      )
    )

    const foreign = createFixture('foreign-authority')
    expectFailure(() =>
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor: { kind: 'execution-run-admission' },
        sealedPlanningAuthority: foreign.authority,
        createdAt: sealCreatedAt,
      })
    )

    const wrongReference = {
      scope: 'committed-prefix',
      objectKey: 'workspace-search/v1/apply-seals/wrong.json',
      versionId: 'committed-prefix-version-1',
      contentDigest: digest('wrong-seal-bytes'),
      byteLength: bytes.byteLength,
      retainUntil,
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealReference
    expectFailure(() =>
      requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding({
        admission: fixture.admission,
        predecessor: { kind: 'execution-run-admission' },
        sealedPlanningAuthority: fixture.authority,
        seal,
        reference: wrongReference,
      })
    )
  })

  test('rejects unsafe retention and malformed rich references', () => {
    const fixture = createFixture()
    expectFailure(() =>
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor: { kind: 'execution-run-admission' },
        sealedPlanningAuthority: fixture.authority,
        createdAt: '2026-09-01T00:00:00.000Z',
      })
    )
    expectFailure(() =>
      readWorkspaceSearchMigrationCommittedPrefixApplySealReference({
        scope: 'committed-prefix',
        objectKey: 'workspace-search/v1/apply-seals/seal.json',
        versionId: 'null',
        contentDigest: digest('seal'),
        byteLength: 1,
        retainUntil,
      })
    )
    const maximumObjectKeyReference = {
      scope: 'committed-prefix',
      objectKey: 'é'.repeat(512),
      versionId: 'committed-prefix-version-1',
      contentDigest: digest('seal'),
      byteLength: 1,
      retainUntil,
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealReference
    expect(
      readWorkspaceSearchMigrationCommittedPrefixApplySealReference(
        maximumObjectKeyReference,
      ),
    ).toEqual(maximumObjectKeyReference)
    expectFailure(() =>
      readWorkspaceSearchMigrationCommittedPrefixApplySealReference({
        scope: 'committed-prefix',
        objectKey: 'é'.repeat(513),
        versionId: 'committed-prefix-version-1',
        contentDigest: digest('seal'),
        byteLength: 1,
        retainUntil,
      })
    )
    const seal =
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor: { kind: 'execution-run-admission' },
        sealedPlanningAuthority: fixture.authority,
        createdAt: sealCreatedAt,
      })
    const bytes =
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        seal,
      )
    expectFailure(() =>
      requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding({
        admission: fixture.admission,
        predecessor: { kind: 'execution-run-admission' },
        sealedPlanningAuthority: fixture.authority,
        seal,
        reference: {
          scope: 'committed-prefix',
          objectKey:
            'workspace-search/v1/apply-seals/short.json',
          versionId: 'short-retention-version-1',
          contentDigest: createMigrationDigest(seal),
          byteLength: bytes.byteLength,
          retainUntil: '2026-07-30T00:03:10.000Z',
        },
      })
    )
  })

  test('accepts strict mutable v1 marker progress', () => {
    const fixture = createFixture('v1-authority', 1)
    const marker = createNoOpMarker(
      fixture.admission,
      '2026-07-30T00:02:30.000Z',
    )
    const next = advanceRunState(
      fixture.admission.runState,
      marker,
    )
    const executionState =
      createWorkspaceSearchMigrationExecutionState({
        admission: fixture.admission,
        nextRunState: next,
        marker,
      })
    const seal =
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor: {
          kind: 'mutable-execution-state',
          executionState,
        },
        sealedPlanningAuthority: fixture.authority,
        createdAt: '2026-07-30T00:03:30.000Z',
      })

    expect(seal).toMatchObject({
      markerCount: 1,
      journalSequence: 0,
      planOperationCount: 1,
    })
  })

  test('accepts v2 traversal and rejects tampered traversal digest', () => {
    const fixture = createFixture('v2-authority', 1)
    const marker = createNoOpMarker(
      fixture.admission,
      '2026-07-30T00:02:30.000Z',
    )
    const v1State =
      createWorkspaceSearchMigrationExecutionState({
        admission: fixture.admission,
        nextRunState: advanceRunState(
          fixture.admission.runState,
          marker,
        ),
        marker,
      })
    const checkpoint = createCheckpoint()
    const authority = createAuthority(fixture.admission)
    const executionState =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission: fixture.admission,
        predecessor: v1State,
        authority,
        location: 'project-directory',
        checkpoint,
      })
    const seal =
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor: {
          kind: 'mutable-execution-state',
          executionState,
        },
        sealedPlanningAuthority: fixture.authority,
        createdAt: sealCreatedAt,
      })
    expect(seal.markerCount).toBe(1)

    const tampered = structuredClone(executionState)
    Reflect.set(
      tampered.apply.sources['project-directory'].aggregate,
      'pageCount',
      2,
    )
    expectFailure(() =>
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor: {
          kind: 'mutable-execution-state',
          executionState: tampered,
        },
        sealedPlanningAuthority: fixture.authority,
        createdAt: sealCreatedAt,
      })
    )
  })

  test('binds mutation-backed v1 journal evidence and rejects unsafe variants', () => {
    const fixture = createFixture('mutation-v1-authority', 1)
    const marker = createMutationMarker(
      fixture.admission,
      '2026-07-30T00:02:30.000Z',
      '2026-09-05T00:00:00.000Z',
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
    const predecessor = {
      kind: 'mutable-execution-state',
      executionState,
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const seal =
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor,
        sealedPlanningAuthority: fixture.authority,
        createdAt: sealCreatedAt,
      })
    const reference = createCommittedPrefixReference(seal)

    expect(executionState).toMatchObject({
      executionStateVersion: 1,
      journalSequence: 1,
      journalHeadDigest: marker.journal.headDigest,
      minimumJournalRetainUntil: marker.journal.retainUntil,
    })
    expect(seal).toMatchObject({
      markerCount: 1,
      journalSequence: 1,
      journalHeadDigest: marker.journal.headDigest,
    })
    expect(
      requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding({
        admission: fixture.admission,
        predecessor,
        sealedPlanningAuthority: fixture.authority,
        seal,
        reference,
      }),
    ).toEqual(reference)

    const invalidJournalPair = {
      ...seal,
      journalSequence: 0,
    }
    expectFailure(() =>
      serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
        invalidJournalPair,
      )
    )

    const wrongHeadSeal = {
      ...seal,
      journalHeadDigest: digest('wrong-journal-head'),
    }
    expectFailure(() =>
      requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding({
        admission: fixture.admission,
        predecessor,
        sealedPlanningAuthority: fixture.authority,
        seal: wrongHeadSeal,
        reference:
          createCommittedPrefixReference(wrongHeadSeal),
      })
    )

    const shortMarker = createMutationMarker(
      fixture.admission,
      '2026-07-30T00:02:30.000Z',
      '2026-08-31T00:00:00.000Z',
    )
    const shortExecutionState =
      createWorkspaceSearchMigrationExecutionState({
        admission: fixture.admission,
        nextRunState: advanceRunState(
          fixture.admission.runState,
          shortMarker,
        ),
        marker: shortMarker,
      })
    expectFailure(() =>
      createWorkspaceSearchMigrationCommittedPrefixApplySeal({
        admission: fixture.admission,
        predecessor: {
          kind: 'mutable-execution-state',
          executionState: shortExecutionState,
        },
        sealedPlanningAuthority: fixture.authority,
        createdAt: sealCreatedAt,
      })
    )
  })

  test('transitions admission-only, v1, and v2 seals through rollback-started', () => {
    const admissionFixture =
      createFixture('admission-rollback-authority', 1)
    expectRollbackStartedTransition(
      admissionFixture,
      { kind: 'execution-run-admission' },
      admissionFixture.admission.runState,
    )

    const mutableFixture =
      createFixture('mutable-rollback-authority', 1)
    const marker = createMutationMarker(
      mutableFixture.admission,
      '2026-07-30T00:02:30.000Z',
      '2026-09-05T00:00:00.000Z',
    )
    const v1RunState = advanceRunState(
      mutableFixture.admission.runState,
      marker,
    )
    const v1State =
      createWorkspaceSearchMigrationExecutionState({
        admission: mutableFixture.admission,
        nextRunState: v1RunState,
        marker,
      })
    expectRollbackStartedTransition(
      mutableFixture,
      {
        kind: 'mutable-execution-state',
        executionState: v1State,
      },
      v1RunState,
    )

    const v2State =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission: mutableFixture.admission,
        predecessor: v1State,
        authority: createAuthority(mutableFixture.admission),
        location: 'project-directory',
        checkpoint: createCheckpoint(),
      })
    expectRollbackStartedTransition(
      mutableFixture,
      {
        kind: 'mutable-execution-state',
        executionState: v2State,
      },
      reconstructWorkspaceSearchMigrationRunState(
        mutableFixture.admission,
        v2State,
      ),
    )
  })
})

/**
 * Creates one fully correlated strict fixture.
 *
 * @param authoritySalt - Optional value used to create a foreign authority.
 * @param planOperationCount - Exact selected plan size; defaults to an empty plan.
 * @returns Exact immutable admission and planning authority.
 */
function createFixture(
  authoritySalt = 'primary-authority',
  planOperationCount = 0,
): CommittedPrefixFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const tableIds = createTableIds(configuration)
  const planSeal = createPlanSeal(
    configurationHash,
    planOperationCount,
  )
  const authority = createSealedAuthority(
    configurationHash,
    tableIds,
    planSeal,
    authoritySalt,
  )
  const maintenanceReceipt = createMaintenanceReceipt()
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
    maintenanceEvidenceReceipt: maintenanceReceipt,
    dryRunEvidenceDigest: planSeal.dryRunEvidenceDigest,
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSeal,
    planSealReference: {
      objectKey: authority.planSealReference.objectKey,
      versionId: authority.planSealReference.versionId,
      contentDigest:
        authority.planSealReference.contentDigest,
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
    sealedPlanningAuthorityDigest: authority.authorityDigest,
    planDigest: authority.planDigest,
    planOperationCount: authority.planOperationCount,
    planSealReference: authority.planSealReference,
    currentAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 4,
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(maintenanceReceipt),
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
    executionRunDigest: createMigrationDigest(
      executionRunFields,
    ),
  }
  serializeWorkspaceSearchMigrationExecutionRun(admission)
  return { admission, authority }
}

/**
 * Creates one strict empty plan seal.
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
 * Creates one strict already-current marker.
 *
 * @param admission - Immutable admission owning the marker.
 * @param recordedAt - Canonical durable marker time.
 * @returns Exact no-op operation marker.
 */
function createNoOpMarker(
  admission: WorkspaceSearchMigrationExecutionRun,
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
    operationId: digest('operation:1'),
    planSequence: 1,
    planOperationDigest: digest('plan-operation:1'),
    targetKeyDigest: digest('target-key:1'),
    afterDigest: digest('after:1'),
    fenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(
        admission.runState.maintenanceEvidenceReceipt,
      ),
    recordedAt,
  }
}

/**
 * Creates one strict mutating operation receipt with a journal link.
 *
 * @param admission - Immutable admission owning the marker.
 * @param committedAt - Canonical durable commit time.
 * @param journalRetainUntil - Exact journal retention deadline.
 * @returns Exact mutating operation marker.
 */
function createMutationMarker(
  admission: WorkspaceSearchMigrationExecutionRun,
  committedAt: string,
  journalRetainUntil: string,
): WorkspaceSearchOperationReceipt {
  const operationId = digest('mutation-operation:1')
  const contentDigest = digest('journal-content:1')
  const versionId = 'journal-version-1'
  const headDigest = createJournalHeadDigest({
    previousHeadDigest: '0'.repeat(64),
    sequence: 1,
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
    planSequence: 1,
    planOperationDigest: digest('mutation-plan-operation:1'),
    sequence: 1,
    targetKeyDigest: digest('mutation-target-key:1'),
    sourceDigest: digest('mutation-source:1'),
    beforeDigest: digest('mutation-before:1'),
    afterDigest: digest('mutation-after:1'),
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
 * Creates one rich reference for exact canonical committed-prefix bytes.
 *
 * @param seal - Exact pure committed-prefix seal.
 * @param referenceRetainUntil - Exact immutable reference retention deadline.
 * @returns Rich exact-version seal reference.
 */
function createCommittedPrefixReference(
  seal: WorkspaceSearchApplySeal,
  referenceRetainUntil = retainUntil,
): WorkspaceSearchMigrationCommittedPrefixApplySealReference {
  const bytes =
    serializeWorkspaceSearchMigrationCommittedPrefixApplySeal(
      seal,
    )
  const contentDigest = createMigrationDigest(seal)
  return {
    scope: 'committed-prefix',
    objectKey:
      `workspace-search/v1/apply-seals/${contentDigest}.json`,
    versionId: 'committed-prefix-version-1',
    contentDigest,
    byteLength: bytes.byteLength,
    retainUntil: referenceRetainUntil,
  }
}

/**
 * Requires one generated seal and rich reference to start real rollback.
 *
 * @param fixture - Correlated admission and sealed planning authority.
 * @param predecessor - Exact admission-only or mutable predecessor.
 * @param current - Complete state represented by the predecessor.
 */
function expectRollbackStartedTransition(
  fixture: CommittedPrefixFixture,
  predecessor:
    WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor,
  current: WorkspaceSearchMigrationRunState,
): void {
  const seal =
    createWorkspaceSearchMigrationCommittedPrefixApplySeal({
      admission: fixture.admission,
      predecessor,
      sealedPlanningAuthority: fixture.authority,
      createdAt: sealCreatedAt,
    })
  const reference = createCommittedPrefixReference(seal)
  const boundReference =
    requireWorkspaceSearchMigrationCommittedPrefixApplySealBinding({
      admission: fixture.admission,
      predecessor,
      sealedPlanningAuthority: fixture.authority,
      seal,
      reference,
    })
  const next = reduceWorkspaceSearchMigrationRunState({
    current,
    expectedRevision: current.revision,
    authority: createAuthority(fixture.admission),
    event: {
      kind: 'rollback-started',
      seal,
      reference: boundReference,
    },
  })

  expect(next).toMatchObject({
    status: 'rolling-back',
    applySeal: reference,
    rollback: {
      upperBoundSequence: current.journalSequence,
      nextSequence: current.journalSequence,
      expectedHeadDigest: current.journalHeadDigest,
      restored: 0,
    },
  })
  expect(next.revision).toBe(current.revision + 1)
}

/**
 * Advances the operation-only fields for one marker.
 *
 * @param current - Exact current applying state.
 * @param marker - Exact next durable marker.
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
 * Creates one active checkpoint authority for the admission lease.
 *
 * @param admission - Immutable admission owning the traversal.
 * @returns Exact active fenced checkpoint authority.
 */
function createAuthority(
  admission: WorkspaceSearchMigrationExecutionRun,
): WorkspaceSearchMigrationAuthority {
  return {
    lease: {
      runId: admission.runId,
      ownerId,
      fenceToken: 7,
      heartbeatAt: '2026-07-30T00:02:30.000Z',
      expiresAt: '2026-07-30T00:03:30.000Z',
    },
    ownerId,
    at: '2026-07-30T00:03:00.000Z',
  }
}

/**
 * Creates one valid resumable single-row page checkpoint.
 *
 * @returns Exact checkpoint with one committed page.
 */
function createCheckpoint(): MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  keyAccumulator.add(digest('checkpoint-key'))
  contentAccumulator.add(digest('checkpoint-content'))
  return {
    completed: false,
    cursor: {
      directoryId: { S: 'directory-1' },
      entryKey: { S: 'entry-1' },
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
 * Creates one strict compact sealed planning authority.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - Exact six physical table identities.
 * @param planSeal - Exact canonical plan seal.
 * @param salt - Value distinguishing otherwise equivalent roots.
 * @returns Exact strict version-two planning authority.
 */
function createSealedAuthority(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  salt: string,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = createMigrationDigest(planSeal)
  const manifestDigest = digest(`manifest:${salt}`)
  const provenanceDigest = digest(`provenance:${salt}`)
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
      retainUntil,
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
      digest(`authority-provenance:${salt}`),
    historicalReceiptBindingDigest:
      digest(`historical-receipts:${salt}`),
    historicalReceiptCount: 1,
    evidenceHeads: [
      createEvidenceHead('project-directory', salt),
      createEvidenceHead('work-items', salt),
      createEvidenceHead('collaboration', salt),
      createEvidenceHead('documents', salt),
      createEvidenceHead('workspace-search', salt),
    ],
    currentAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        digest(`sealed-receipt:${salt}`),
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
 * Creates one compact terminal evidence head.
 *
 * @param chain - Canonical evidence-chain role.
 * @param salt - Fixture root discriminator.
 * @returns Exact terminal evidence commitment.
 */
function createEvidenceHead(
  chain:
    | 'collaboration'
    | 'documents'
    | 'project-directory'
    | 'work-items'
    | 'workspace-search',
  salt: string,
) {
  return {
    chain,
    progressDigest: digest(`${salt}:progress:${chain}`),
    pageCount: 1,
    terminalEvidenceDigest:
      digest(`${salt}:evidence:${chain}`),
    terminalCheckpointDigest:
      digest(`${salt}:checkpoint:${chain}`),
  }
}

/**
 * Creates one exact-window maintenance evidence receipt.
 *
 * @returns Valid immutable maintenance evidence.
 */
function createMaintenanceReceipt():
WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/fence-7.json',
    runtimeRevision: 11,
    fenceToken: 7,
    validatedAt: '2026-07-30T00:01:00.000Z',
    oldestObservationAt: '2026-07-30T00:00:00.000Z',
    validUntil: '2026-07-30T00:05:00.001Z',
  }
}

/**
 * Creates one complete measured migration configuration.
 *
 * @returns Stable measured configuration.
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
 * @param key - Exact base key schema.
 * @param deletionProtection - Measured protection status.
 * @returns Complete table identity.
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
 * Returns the source primary-key schema for one role.
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
      { name: 'entryKey', role: 'RANGE', type: 'S' },
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
    collaboration: configuration.tables.collaboration.tableId,
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
 * Requires one callback to fail at the stable seal boundary.
 *
 * @param operation - Candidate invalid operation.
 */
function expectFailure(operation: () => unknown): void {
  expect(operation).toThrow(
    WorkspaceSearchMigrationCommittedPrefixApplySealError,
  )
}
