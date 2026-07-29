import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  type DynamoAttributeMap,
  MigrationDigestAccumulator,
  serializeCanonicalJson,
  type MigrationKeyAttribute,
  type MigrationSourceCheckpoint,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchOperationMarker,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
} from './migration-contract'
import {
  type WorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRunBinding,
  serializeWorkspaceSearchMigrationExecutionRun,
} from './migration-execution-run'
import {
  createWorkspaceSearchMigrationCheckpointExecutionState,
  createWorkspaceSearchMigrationExecutionState,
  parseWorkspaceSearchMigrationOperationMarker,
  parseWorkspaceSearchMigrationExecutionState,
  reconstructWorkspaceSearchMigrationRunState,
  serializeWorkspaceSearchMigrationOperationMarker,
  serializeWorkspaceSearchMigrationExecutionState,
  type WorkspaceSearchMigrationExecutionState,
  type WorkspaceSearchMigrationExecutionStateV1,
  type WorkspaceSearchMigrationExecutionStateV2,
  WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES,
  WorkspaceSearchMigrationExecutionStateError,
} from './migration-execution-state'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationAuthority,
  type WorkspaceSearchMigrationCheckpointLocation,
} from './migration-state-machine'

const runId = 'mutable-execution-state-test'
const ownerId = 'mutable-state-owner'
const configurationTime = '2026-07-30T00:00:00.000Z'
const planCreatedAt = '2026-07-30T00:00:30.000Z'
const receiptValidatedAt = '2026-07-30T00:01:00.000Z'
const admissionCreatedAt = '2026-07-30T00:02:00.000Z'
const planRetainUntil = '2026-08-30T00:02:00.000Z'

describe('Workspace Search migration mutable execution state', () => {
  test('round-trips one mutation and reconstructs the complete run state', () => {
    const admission = createAdmission()
    const marker = createMutationMarker(
      admission,
      1,
      1,
      '2026-07-30T00:03:00.000Z',
      '2026-09-05T00:00:00.000Z',
    )
    const next = advanceRunState(admission.runState, marker)
    const executionState =
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: next,
        marker,
      })
    const bytes =
      serializeWorkspaceSearchMigrationExecutionState(
        executionState,
      )

    expect(executionState.executionStateVersion).toBe(1)
    expect(bytes).toEqual(encodeCanonicalJson(executionState))
    expect(
      parseWorkspaceSearchMigrationExecutionState(bytes),
    ).toEqual(executionState)
    expect(
      reconstructWorkspaceSearchMigrationRunState(
        admission,
        executionState,
      ),
    ).toEqual(next)
    expect(executionState).toMatchObject({
      executionRunDigest: admission.executionRunDigest,
      runId,
      configurationHash: admission.configurationHash,
      revision: 2,
      status: 'applying',
      appliedOperationCount: 1,
      journalSequence: 1,
      journalHeadDigest: marker.journal.headDigest,
      minimumJournalRetainUntil:
        marker.journal.retainUntil,
      updatedAt: marker.committedAt,
      runStateDigest: createMigrationDigest(next),
    })
    expect(executionState.executionStateDigest).toBe(
      digestExecutionState(executionState),
    )
  })

  test('accumulates the earliest mutation retention and preserves it across a no-op', () => {
    const admission = createAdmission()
    const firstMarker = createMutationMarker(
      admission,
      1,
      1,
      '2026-07-30T00:03:00.000Z',
      '2026-09-10T00:00:00.000Z',
    )
    const firstRunState = advanceRunState(
      admission.runState,
      firstMarker,
    )
    const first =
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: firstRunState,
        marker: firstMarker,
      })
    const secondMarker = createMutationMarker(
      admission,
      2,
      2,
      '2026-07-30T00:04:00.000Z',
      '2026-09-01T00:00:00.000Z',
    )
    const secondRunState = advanceRunState(
      firstRunState,
      secondMarker,
    )
    const second =
      createWorkspaceSearchMigrationExecutionState({
        admission,
        predecessor: first,
        nextRunState: secondRunState,
        marker: secondMarker,
      })
    const noOpMarker = createNoOpMarker(
      admission,
      3,
      '2026-07-30T00:05:00.000Z',
    )
    const thirdRunState = advanceRunState(
      secondRunState,
      noOpMarker,
    )
    const third =
      createWorkspaceSearchMigrationExecutionState({
        admission,
        predecessor: second,
        nextRunState: thirdRunState,
        marker: noOpMarker,
      })

    expect(first.minimumJournalRetainUntil).toBe(
      '2026-09-10T00:00:00.000Z',
    )
    expect(second.minimumJournalRetainUntil).toBe(
      '2026-09-01T00:00:00.000Z',
    )
    expect(third.minimumJournalRetainUntil).toBe(
      second.minimumJournalRetainUntil,
    )
    expect(third.journalSequence).toBe(second.journalSequence)
    expect(third.journalHeadDigest).toBe(
      second.journalHeadDigest,
    )
  })

  test('keeps journal state absent when the first operation is a no-op', () => {
    const admission = createAdmission()
    const marker = createNoOpMarker(
      admission,
      1,
      '2026-07-30T00:03:00.000Z',
    )
    const next = advanceRunState(admission.runState, marker)
    const state =
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: next,
        marker,
      })

    expect(state.journalSequence).toBe(0)
    expect(
      Object.prototype.hasOwnProperty.call(
        state,
        'minimumJournalRetainUntil',
      ),
    ).toBe(false)
    expect(
      reconstructWorkspaceSearchMigrationRunState(
        admission,
        state,
      ),
    ).toEqual(next)
  })

  test('rejects skipped, non-operation, and admission-drifting next states', () => {
    const admission = createAdmission()
    const marker = createMutationMarker(
      admission,
      1,
      1,
      '2026-07-30T00:03:00.000Z',
      '2026-09-05T00:00:00.000Z',
    )
    const next = advanceRunState(admission.runState, marker)

    const skippedRevision = structuredClone(next)
    Reflect.set(skippedRevision, 'revision', 3)
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: skippedRevision,
        marker,
      })
    )

    const changedMaintenance = structuredClone(next)
    Reflect.set(
      changedMaintenance,
      'maintenanceEvidenceLocator',
      'raw-tenant-secret',
    )
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: changedMaintenance,
        marker,
      })
    )

    const changedTraversal = structuredClone(next)
    Reflect.set(
      changedTraversal.apply.target,
      'completed',
      true,
    )
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: changedTraversal,
        marker,
      })
    )
  })

  test('rejects marker identity, sequence, and retention violations', () => {
    const admission = createAdmission()
    const marker = createMutationMarker(
      admission,
      1,
      1,
      '2026-07-30T00:03:00.000Z',
      '2026-09-05T00:00:00.000Z',
    )
    const next = advanceRunState(admission.runState, marker)

    const wrongRun = structuredClone(marker)
    Reflect.set(wrongRun, 'runId', 'another-run')
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: next,
        marker: wrongRun,
      })
    )

    const skippedSequence = structuredClone(marker)
    Reflect.set(skippedSequence, 'sequence', 2)
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: next,
        marker: skippedSequence,
      })
    )

    const expiredRetention = structuredClone(marker)
    Reflect.set(
      expiredRetention.journal,
      'retainUntil',
      expiredRetention.committedAt,
    )
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: next,
        marker: expiredRetention,
      })
    )

    const oversizedJournal = structuredClone(marker)
    Reflect.set(
      oversizedJournal.journal,
      'byteLength',
      2 * 1024 * 1024 + 1,
    )
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: next,
        marker: oversizedJournal,
      })
    )

    const shortRetentionMarker = createMutationMarker(
      admission,
      1,
      1,
      '2026-07-30T00:03:00.000Z',
      '2026-07-30T00:03:30.000Z',
    )
    const shortRetentionRunState = advanceRunState(
      admission.runState,
      shortRetentionMarker,
    )
    const shortRetentionState =
      createWorkspaceSearchMigrationExecutionState({
        admission,
        nextRunState: shortRetentionRunState,
        marker: shortRetentionMarker,
      })
    const lateNoOp = createNoOpMarker(
      admission,
      2,
      '2026-07-30T00:04:00.000Z',
    )
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationExecutionState({
        admission,
        predecessor: shortRetentionState,
        nextRunState: advanceRunState(
          shortRetentionRunState,
          lateNoOp,
        ),
        marker: lateNoOp,
      })
    )
  })

  test('rejects noncanonical, extra, digest-tampered, and oversized envelopes', () => {
    const { admission, state } = createFirstMutationState()
    const canonical =
      serializeWorkspaceSearchMigrationExecutionState(state)
    const noncanonical = new TextEncoder().encode(
      ` ${new TextDecoder().decode(canonical)}`,
    )
    expectExecutionStateFailure(() =>
      parseWorkspaceSearchMigrationExecutionState(noncanonical)
    )

    const extended = structuredClone(state)
    Reflect.set(extended, 'raw-tenant-secret', true)
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationExecutionState(extended)
    )

    const tampered = structuredClone(state)
    Reflect.set(tampered, 'runStateDigest', digest('tampered'))
    expectExecutionStateFailure(() =>
      parseWorkspaceSearchMigrationExecutionState(
        encodeCanonicalJson(tampered),
      )
    )

    const rebound = structuredClone(state)
    Reflect.set(
      rebound,
      'executionRunDigest',
      digest('different-admission'),
    )
    Reflect.set(
      rebound,
      'executionStateDigest',
      digestExecutionState(rebound),
    )
    const parsedRebound =
      parseWorkspaceSearchMigrationExecutionState(
        encodeCanonicalJson(rebound),
      )
    expectExecutionStateFailure(() =>
      reconstructWorkspaceSearchMigrationRunState(
        admission,
        parsedRebound,
      )
    )

    const runStateRewritten = structuredClone(state)
    Reflect.set(
      runStateRewritten,
      'runStateDigest',
      digest('different-run-state'),
    )
    Reflect.set(
      runStateRewritten,
      'executionStateDigest',
      digestExecutionState(runStateRewritten),
    )
    const parsedRunStateRewrite =
      parseWorkspaceSearchMigrationExecutionState(
        encodeCanonicalJson(runStateRewritten),
      )
    expectExecutionStateFailure(() =>
      reconstructWorkspaceSearchMigrationRunState(
        admission,
        parsedRunStateRewrite,
      )
    )

    const missingMinimum = structuredClone(state)
    Reflect.deleteProperty(
      missingMinimum,
      'minimumJournalRetainUntil',
    )
    Reflect.set(
      missingMinimum,
      'executionStateDigest',
      digestExecutionState(missingMinimum),
    )
    expectExecutionStateFailure(() =>
      parseWorkspaceSearchMigrationExecutionState(
        encodeCanonicalJson(missingMinimum),
      )
    )

    expectExecutionStateFailure(() =>
      parseWorkspaceSearchMigrationExecutionState(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES + 1,
        ),
      )
    )
  })

  test('rejects accessors and hostile proxies without exposing raw failures', () => {
    const { state } = createFirstMutationState()
    const accessor = structuredClone(state)
    let getterInvoked = false
    Object.defineProperty(accessor, 'runId', {
      enumerable: true,
      get() {
        getterInvoked = true
        return 'raw-getter-secret'
      },
    })
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationExecutionState(accessor)
    )
    expect(getterInvoked).toBe(false)

    const hostile = new Proxy(state, {
      ownKeys() {
        throw new Error('raw-proxy-secret')
      },
    })
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationExecutionState(hostile)
    )
  })

  test('creates the first v2 checkpoint directly from a zero-operation admission', () => {
    const admission = createAdmission(0)
    const checkpoint = createCheckpoint(
      'project-directory',
      1,
      false,
    )
    const state =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        authority: createAuthority(
          '2026-07-30T00:03:00.000Z',
        ),
        location: 'project-directory',
        checkpoint,
      })
    const bytes =
      serializeWorkspaceSearchMigrationExecutionState(state)
    const parsed =
      parseWorkspaceSearchMigrationExecutionState(bytes)
    const reconstructed =
      reconstructWorkspaceSearchMigrationRunState(
        admission,
        parsed,
      )

    expect(state.executionStateVersion).toBe(2)
    expect(state.revision).toBe(2)
    expect(state.appliedOperationCount).toBe(0)
    expect(state.apply.sources['project-directory']).toEqual(
      checkpoint,
    )
    expect(parsed).toEqual(state)
    expect(reconstructed).toMatchObject({
      revision: 2,
      status: 'applying',
      appliedOperationCount: 0,
      updatedAt: '2026-07-30T00:03:00.000Z',
    })
    expect(reconstructed.apply).toEqual(state.apply)
    expect(state.executionStateDigest).toBe(
      digestSerializedExecutionState(state),
    )
  })

  test('upgrades a complete v1 predecessor and preserves multi-page v2 traversal', () => {
    const admission = createAdmission()
    const applied = createFullyAppliedV1State(admission)
    const firstCheckpoint = createCheckpoint(
      'target',
      1,
      false,
    )
    const first =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        predecessor: applied.state,
        authority: createAuthority(
          '2026-07-30T00:04:00.000Z',
        ),
        location: 'target',
        checkpoint: firstCheckpoint,
      })
    const terminalCheckpoint = createCheckpoint(
      'target',
      2,
      true,
    )
    const second =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        predecessor: first,
        authority: createAuthority(
          '2026-07-30T00:04:30.000Z',
        ),
        location: 'target',
        checkpoint: terminalCheckpoint,
      })
    const parsed = parseWorkspaceSearchMigrationExecutionState(
      serializeWorkspaceSearchMigrationExecutionState(second),
    )
    const reconstructed =
      reconstructWorkspaceSearchMigrationRunState(
        admission,
        parsed,
      )

    expect(applied.state.executionStateVersion).toBe(1)
    expect(first).toMatchObject({
      executionStateVersion: 2,
      revision: 5,
      appliedOperationCount: 3,
    })
    expect(second).toMatchObject({
      executionStateVersion: 2,
      revision: 6,
      appliedOperationCount: 3,
      journalSequence: 1,
      journalHeadDigest: applied.state.journalHeadDigest,
      minimumJournalRetainUntil:
        applied.state.minimumJournalRetainUntil,
    })
    expect(second.apply.target).toEqual(terminalCheckpoint)
    expect(
      second.apply.sources['project-directory'].aggregate
        .pageCount,
    ).toBe(0)
    expect(parsed).toEqual(second)
    expect(reconstructed.apply).toEqual(second.apply)
    expect(reconstructed.revision).toBe(
      1 +
        reconstructed.appliedOperationCount +
        totalTraversalPageCount(reconstructed.apply),
    )

    const unsupportedMarker = createNoOpMarker(
      admission,
      4,
      '2026-07-30T00:04:40.000Z',
    )
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationExecutionState({
        admission,
        predecessor: second,
        nextRunState: advanceRunState(
          reconstructed,
          unsupportedMarker,
        ),
        marker: unsupportedMarker,
      })
    )
  })

  test('rejects premature, stale, schema-invalid, and non-advancing checkpoints', () => {
    const admission = createAdmission()
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        authority: createAuthority(
          '2026-07-30T00:03:00.000Z',
        ),
        location: 'project-directory',
        checkpoint: createCheckpoint(
          'project-directory',
          1,
          false,
        ),
      })
    )

    const applied = createFullyAppliedV1State(admission)
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        predecessor: applied.state,
        authority: createAuthority(
          '2026-07-30T00:04:00.000Z',
        ),
        location: 'project-directory',
        checkpoint: createCheckpoint('target', 1, false),
      })
    )

    const checkpoint = createCheckpoint(
      'project-directory',
      1,
      false,
    )
    const first =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        predecessor: applied.state,
        authority: createAuthority(
          '2026-07-30T00:04:00.000Z',
        ),
        location: 'project-directory',
        checkpoint,
      })
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        predecessor: first,
        authority: createAuthority(
          '2026-07-30T00:04:30.000Z',
        ),
        location: 'project-directory',
        checkpoint,
      })
    )
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        predecessor: first,
        authority: createAuthority(
          '2026-07-30T00:03:59.000Z',
        ),
        location: 'project-directory',
        checkpoint: createCheckpoint(
          'project-directory',
          2,
          true,
        ),
      })
    )

    const wrongOwner = createAuthority(
      '2026-07-30T00:04:30.000Z',
    )
    Reflect.set(wrongOwner, 'ownerId', 'another-owner')
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        predecessor: first,
        authority: wrongOwner,
        location: 'project-directory',
        checkpoint: createCheckpoint(
          'project-directory',
          2,
          true,
        ),
      })
    )
    expectExecutionStateFailure(() =>
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission: createAdmission(0),
        predecessor: first,
        authority: createAuthority(
          '2026-07-30T00:04:30.000Z',
        ),
        location: 'project-directory',
        checkpoint: createCheckpoint(
          'project-directory',
          2,
          true,
        ),
      })
    )
  })

  test('rejects v2 digest, revision, extra-key, accessor, symbol, cycle, and proxy attacks', () => {
    const admission = createAdmission(0)
    const state =
      createWorkspaceSearchMigrationCheckpointExecutionState({
        admission,
        authority: createAuthority(
          '2026-07-30T00:03:00.000Z',
        ),
        location: 'target',
        checkpoint: createCheckpoint('target', 1, false),
      })
    const document = parseJsonRecord(
      serializeWorkspaceSearchMigrationExecutionState(state),
    )
    Reflect.set(document, 'revision', state.revision + 1)
    Reflect.set(
      document,
      'executionStateDigest',
      digestExecutionDocument(document),
    )
    expectExecutionStateFailure(() =>
      parseWorkspaceSearchMigrationExecutionState(
        encodeCanonicalJson(document),
      )
    )

    const pageCountDocument = parseJsonRecord(
      serializeWorkspaceSearchMigrationExecutionState(state),
    )
    const apply = readTestRecord(pageCountDocument.apply)
    const target = readTestRecord(apply.target)
    const aggregate = readTestRecord(target.aggregate)
    Reflect.set(aggregate, 'pageCount', 2)
    Reflect.set(
      pageCountDocument,
      'executionStateDigest',
      digestExecutionDocument(pageCountDocument),
    )
    expectExecutionStateFailure(() =>
      parseWorkspaceSearchMigrationExecutionState(
        encodeCanonicalJson(pageCountDocument),
      )
    )

    const extended = structuredClone(state)
    Reflect.set(extended.apply, 'raw-extra-key', true)
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationExecutionState(extended)
    )

    const accessor = structuredClone(state)
    let getterInvoked = false
    Object.defineProperty(
      accessor.apply.target.aggregate,
      'pageCount',
      {
        enumerable: true,
        get() {
          getterInvoked = true
          return 1
        },
      },
    )
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationExecutionState(accessor)
    )
    expect(getterInvoked).toBe(false)

    const symbolic = structuredClone(state)
    Reflect.set(symbolic.apply.target, Symbol('raw-symbol'), true)
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationExecutionState(symbolic)
    )

    const cyclic = structuredClone(state)
    const cursor = cyclic.apply.target.cursor
    if (cursor === undefined) {
      throw new Error('Expected checkpoint cursor fixture.')
    }
    Reflect.set(cursor, 'loop', { M: cursor })
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationExecutionState(cyclic)
    )

    const hostile = new Proxy(state, {
      ownKeys() {
        throw new Error('raw-v2-proxy-secret')
      },
    })
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationExecutionState(hostile)
    )
  })

  test('round-trips strict mutation and no-op operation markers', () => {
    const admission = createAdmission()
    const mutation = createMutationMarker(
      admission,
      1,
      1,
      '2026-07-30T00:03:00.000Z',
      '2026-09-05T00:00:00.000Z',
    )
    const noOp = createNoOpMarker(
      admission,
      2,
      '2026-07-30T00:04:00.000Z',
    )

    expect(
      parseWorkspaceSearchMigrationOperationMarker(
        serializeWorkspaceSearchMigrationOperationMarker(
          mutation,
        ),
      ),
    ).toEqual(mutation)
    expect(
      parseWorkspaceSearchMigrationOperationMarker(
        serializeWorkspaceSearchMigrationOperationMarker(noOp),
      ),
    ).toEqual(noOp)
  })

  test('rejects noncanonical, tampered, accessor, proxy, and oversized markers', () => {
    const admission = createAdmission()
    const marker = createMutationMarker(
      admission,
      1,
      1,
      '2026-07-30T00:03:00.000Z',
      '2026-09-05T00:00:00.000Z',
    )
    const canonical =
      serializeWorkspaceSearchMigrationOperationMarker(marker)
    expectExecutionStateFailure(() =>
      parseWorkspaceSearchMigrationOperationMarker(
        new TextEncoder().encode(
          ` ${new TextDecoder().decode(canonical)}`,
        ),
      )
    )

    const tampered = structuredClone(marker)
    Reflect.set(tampered, 'planSequence', 0)
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationOperationMarker(tampered)
    )

    const accessor = structuredClone(marker)
    let getterInvoked = false
    Object.defineProperty(accessor, 'operationId', {
      enumerable: true,
      get() {
        getterInvoked = true
        return 'raw-marker-getter-secret'
      },
    })
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationOperationMarker(accessor)
    )
    expect(getterInvoked).toBe(false)

    const hostile = new Proxy(marker, {
      ownKeys() {
        throw new Error('raw-marker-proxy-secret')
      },
    })
    expectExecutionStateFailure(() =>
      serializeWorkspaceSearchMigrationOperationMarker(hostile)
    )

    expectExecutionStateFailure(() =>
      parseWorkspaceSearchMigrationOperationMarker(
        new Uint8Array(
          WORKSPACE_SEARCH_MIGRATION_EXECUTION_STATE_MAX_BYTES + 1,
        ),
      )
    )
  })
})

/**
 * Creates one valid immutable admission with a selected sealed-plan size.
 *
 * @param planOperationCount - Exact number of durable plan operations.
 * @returns Strict revision-one execution admission.
 */
function createAdmission(
  planOperationCount = 3,
): WorkspaceSearchMigrationExecutionRun {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const planSeal: WorkspaceSearchPlanSeal = {
    kind: 'workspace-search-plan-seal',
    sealVersion: 2,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash,
    dryRunEvidenceDigest: digest('dry-run-evidence'),
    planningSnapshotDigest: digest('planning-snapshot'),
    planDigest: planOperationCount === 0
      ? createEmptyWorkspaceSearchPlanDigest()
      : digest(`${planOperationCount}-operation-plan`),
    planOperationCount,
    sourceOperationCount: planOperationCount,
    orphanOperationCount: 0,
    createdAt: planCreatedAt,
  }
  const planSealContentDigest = createMigrationDigest(planSeal)
  const planSealObjectKey =
    `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/plan-seals/${planSealContentDigest}.artifact`
  const maintenanceEvidenceReceipt =
    createMaintenanceEvidenceReceipt()
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
    maintenanceEvidenceReceipt,
    dryRunEvidenceDigest: planSeal.dryRunEvidenceDigest,
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSeal,
    planSealReference: {
      objectKey: planSealObjectKey,
      versionId: 'plan-seal-version-1',
      contentDigest: planSealContentDigest,
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
    tableIds: createTableIds(configuration),
    executionBoundaryDigest: digest('execution-boundary'),
    closedWriterFenceRecordDigest: digest('closed-writer-fence'),
    sealedPlanningAuthorityDigest: digest('sealed-authority'),
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSealReference: {
      objectKey: planSealObjectKey,
      versionId: 'plan-seal-version-1',
      contentDigest: planSealContentDigest,
      byteLength: new TextEncoder().encode(
        serializeCanonicalJson(planSeal),
      ).byteLength,
      retainUntil: planRetainUntil,
    },
    currentAuthority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 4,
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(maintenanceEvidenceReceipt),
      evaluatedAt: '2026-07-30T00:01:45.000Z',
    },
    planningAdmittedAt: '2026-07-30T00:00:15.000Z',
    sealedAt: '2026-07-30T00:01:30.000Z',
    createdAt: admissionCreatedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRunBinding,
    'bindingDigest'
  >
  const binding = {
    ...bindingFields,
    bindingDigest: createMigrationDigest(bindingFields),
  }
  const stateDigest = createMigrationDigest(runState)
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
    stateDigest,
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
  return admission
}

/**
 * Creates one exact-window maintenance receipt for the admission fence.
 *
 * @returns Valid immutable maintenance-evidence receipt.
 */
function createMaintenanceEvidenceReceipt():
WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/fence-7.json',
    runtimeRevision: 11,
    fenceToken: 7,
    validatedAt: receiptValidatedAt,
    oldestObservationAt: '2026-07-30T00:00:00.000Z',
    validUntil: '2026-07-30T00:05:00.001Z',
  }
}

/**
 * Creates one strict mutating marker for the selected plan position.
 *
 * @param admission - Immutable admission owning the marker.
 * @param planSequence - One-based sealed-plan position.
 * @param sequence - One-based mutating journal sequence.
 * @param committedAt - Canonical operation commit time.
 * @param retainUntil - Canonical immutable journal retention deadline.
 * @returns Exact mutating operation marker.
 */
function createMutationMarker(
  admission: WorkspaceSearchMigrationExecutionRun,
  planSequence: number,
  sequence: number,
  committedAt: string,
  retainUntil: string,
): Extract<
  WorkspaceSearchOperationMarker,
  { readonly kind: 'workspace-search-operation-applied' }
> {
  return {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId,
    configurationHash: admission.configurationHash,
    operationId: digest(`operation:${planSequence}`),
    planSequence,
    planOperationDigest: digest(`plan-operation:${planSequence}`),
    sequence,
    targetKeyDigest: digest(`target-key:${planSequence}`),
    beforeDigest: digest(`before:${planSequence}`),
    afterDigest: digest(`after:${planSequence}`),
    fenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(
        admission.runState.maintenanceEvidenceReceipt,
      ),
    journal: {
      objectKey:
        `workspace-search/v1/journal/${runId}/${sequence}.json`,
      versionId: `journal-version-${sequence}`,
      contentDigest: digest(`journal-content:${sequence}`),
      byteLength: 512 + sequence,
      retainUntil,
      headDigest: digest(`journal-head:${sequence}`),
    },
    committedAt,
  }
}

/**
 * Creates one strict already-current marker for the selected plan position.
 *
 * @param admission - Immutable admission owning the marker.
 * @param planSequence - One-based sealed-plan position.
 * @param recordedAt - Canonical no-op record time.
 * @returns Exact no-op operation marker.
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
    planOperationDigest: digest(`plan-operation:${planSequence}`),
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
 * Applies the operation-only run-state fields used by the production reducer.
 *
 * @param current - Complete current applying state.
 * @param marker - Exact next operation marker.
 * @returns Complete expected next state.
 */
function advanceRunState(
  current: WorkspaceSearchMigrationRunState,
  marker: WorkspaceSearchOperationMarker,
): WorkspaceSearchMigrationRunState {
  const accumulator = MigrationDigestAccumulator.fromState(
    current.applyMarkerDigestState,
  )
  accumulator.add(createMigrationDigest(marker))
  if (marker.kind === 'workspace-search-operation-applied') {
    return {
      ...current,
      revision: current.revision + 1,
      appliedOperationCount:
        current.appliedOperationCount + 1,
      applyMarkerDigestState: accumulator.exportState(),
      journalSequence: marker.sequence,
      journalHeadDigest: marker.journal.headDigest,
      updatedAt: marker.committedAt,
    }
  }
  return {
    ...current,
    revision: current.revision + 1,
    appliedOperationCount:
      current.appliedOperationCount + 1,
    applyMarkerDigestState: accumulator.exportState(),
    updatedAt: marker.recordedAt,
  }
}

/**
 * Creates a complete legacy operation predecessor for a positive-size plan.
 *
 * @param admission - Immutable admission with one or more operations.
 * @returns Final v1 envelope and its complete reconstructed run state.
 */
function createFullyAppliedV1State(
  admission: WorkspaceSearchMigrationExecutionRun,
): {
  /** Final legacy operation envelope. */
  readonly state: WorkspaceSearchMigrationExecutionStateV1
  /** Complete operation-only run state. */
  readonly runState: WorkspaceSearchMigrationRunState
} {
  if (admission.runState.planOperationCount < 1) {
    throw new Error('Expected a positive operation count fixture.')
  }
  const firstMarker = createMutationMarker(
    admission,
    1,
    1,
    operationTime(1),
    '2026-09-05T00:00:00.000Z',
  )
  let runState = advanceRunState(
    admission.runState,
    firstMarker,
  )
  let state = createWorkspaceSearchMigrationExecutionState({
    admission,
    nextRunState: runState,
    marker: firstMarker,
  })
  for (
    let sequence = 2;
    sequence <= admission.runState.planOperationCount;
    sequence += 1
  ) {
    const marker = createNoOpMarker(
      admission,
      sequence,
      operationTime(sequence),
    )
    runState = advanceRunState(runState, marker)
    state = createWorkspaceSearchMigrationExecutionState({
      admission,
      predecessor: state,
      nextRunState: runState,
      marker,
    })
  }
  return { state, runState }
}

/**
 * Creates one canonical operation time before checkpoint fixtures begin.
 *
 * @param sequence - One-based operation sequence.
 * @returns Canonical UTC marker time.
 */
function operationTime(sequence: number): string {
  return new Date(
    Date.parse('2026-07-30T00:03:00.000Z') +
      sequence * 10_000,
  ).toISOString()
}

/**
 * Creates one active authority for a checkpoint transition.
 *
 * @param at - Trusted checkpoint commit time.
 * @returns Exact active fence-seven authority.
 */
function createAuthority(
  at: string,
): WorkspaceSearchMigrationAuthority {
  const atMilliseconds = Date.parse(at)
  return {
    lease: {
      runId,
      ownerId,
      fenceToken: 7,
      heartbeatAt: new Date(
        atMilliseconds - 30_000,
      ).toISOString(),
      expiresAt: new Date(
        atMilliseconds + 30_000,
      ).toISOString(),
    },
    ownerId,
    at,
  }
}

/**
 * Creates one cumulative valid checkpoint with one row per page.
 *
 * @param location - Table whose exact cursor schema is required.
 * @param pageCount - Positive cumulative page and row count.
 * @param completed - Whether the cumulative scan is terminal.
 * @returns Valid cumulative checkpoint.
 */
function createCheckpoint(
  location: WorkspaceSearchMigrationCheckpointLocation,
  pageCount: number,
  completed: boolean,
): MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  for (let page = 1; page <= pageCount; page += 1) {
    keyAccumulator.add(digest(`${location}:key:${page}`))
    contentAccumulator.add(
      digest(`${location}:content:${page}`),
    )
  }
  const common = {
    completed,
    aggregate: {
      scanned: pageCount,
      mapped: pageCount,
      ignored: 0,
      invalid: 0,
      projected: pageCount,
      deleted: 0,
      keyDigest: keyAccumulator.digest(),
      contentDigest: contentAccumulator.digest(),
      pageCount,
    },
    keyDigestState: keyAccumulator.exportState(),
    contentDigestState: contentAccumulator.exportState(),
  }
  return completed
    ? common
    : {
        ...common,
        cursor: createCheckpointCursor(location, pageCount),
      }
}

/**
 * Creates one exact raw DynamoDB key for a traversal location.
 *
 * @param location - Source or target table role.
 * @param pageCount - Cumulative page used to vary the cursor.
 * @returns Exact low-level key matching the measured table schema.
 */
function createCheckpointCursor(
  location: WorkspaceSearchMigrationCheckpointLocation,
  pageCount: number,
): DynamoAttributeMap {
  if (location === 'project-directory') {
    return {
      directoryId: { S: `directory-${pageCount}` },
      entryKey: { S: `entry-${pageCount}` },
    }
  }
  if (location === 'work-items') {
    return {
      directoryTeamId: { S: `team-${pageCount}` },
      issueId: { S: `issue-${pageCount}` },
    }
  }
  if (location === 'collaboration') {
    return {
      entityKey: { S: `entity-${pageCount}` },
      recordKey: { S: `record-${pageCount}` },
    }
  }
  return {
    workspaceId: { S: `workspace-${pageCount}` },
    recordKey: { S: `record-${pageCount}` },
  }
}

/**
 * Sums all four source and one target traversal page counts.
 *
 * @param traversal - Complete apply traversal.
 * @returns Exact five-location page total.
 */
function totalTraversalPageCount(
  traversal: WorkspaceSearchMigrationRunState['apply'],
): number {
  return traversal.sources['project-directory'].aggregate
    .pageCount +
    traversal.sources['work-items'].aggregate.pageCount +
    traversal.sources.collaboration.aggregate.pageCount +
    traversal.sources.documents.aggregate.pageCount +
    traversal.target.aggregate.pageCount
}

/**
 * Creates the common first mutation fixture.
 *
 * @returns Admission and its first mutable state.
 */
function createFirstMutationState(): {
  /** Immutable admission root. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** First mutable operation state. */
  readonly state: WorkspaceSearchMigrationExecutionState
} {
  const admission = createAdmission()
  const marker = createMutationMarker(
    admission,
    1,
    1,
    '2026-07-30T00:03:00.000Z',
    '2026-09-05T00:00:00.000Z',
  )
  return {
    admission,
    state: createWorkspaceSearchMigrationExecutionState({
      admission,
      nextRunState: advanceRunState(admission.runState, marker),
      marker,
    }),
  }
}

/**
 * Creates a complete measured migration configuration.
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
 * Creates all six exact TableIds from measured configuration.
 *
 * @param configuration - Exact measured configuration.
 * @returns Fixed-role physical table identities.
 */
function createTableIds(
  configuration: WorkspaceSearchMigrationConfiguration,
): WorkspaceSearchMigrationExecutionRun['binding']['tableIds'] {
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
 * Creates a stable test digest.
 *
 * @param label - Nonsecret fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(label: string): string {
  return createMigrationDigest({ label })
}

/**
 * Encodes one JSON-compatible value using canonical contract ordering.
 *
 * @param value - JSON-compatible value.
 * @returns Canonical UTF-8 bytes.
 */
function encodeCanonicalJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Parses test-owned execution-state bytes into a mutable plain record.
 *
 * @param bytes - Canonical JSON fixture bytes.
 * @returns Parsed plain record.
 */
function parseJsonRecord(
  bytes: Uint8Array,
): Record<string, unknown> {
  const parsed: unknown = JSON.parse(
    new TextDecoder().decode(bytes),
  )
  return readTestRecord(parsed)
}

/**
 * Narrows one test fixture value to a plain record.
 *
 * @param value - Candidate fixture value.
 * @returns Plain record.
 */
function readTestRecord(
  value: unknown,
): Record<string, unknown> {
  if (!isTestRecord(value)) {
    throw new Error('Expected a plain test record.')
  }
  return value
}

/**
 * Checks whether one test fixture value is a plain record.
 *
 * @param value - Candidate fixture value.
 * @returns Whether the value is a plain record.
 */
function isTestRecord(
  value: unknown,
): value is Record<string, unknown> {
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
 * Recomputes a parsed v2 document self-digest after test tampering.
 *
 * @param document - Mutable encoded v2 document.
 * @returns Digest of every encoded field except the self-digest.
 */
function digestExecutionDocument(
  document: Readonly<Record<string, unknown>>,
): string {
  const fields = structuredClone(document)
  Reflect.deleteProperty(fields, 'executionStateDigest')
  return createMigrationDigest(fields)
}

/**
 * Recomputes one valid v2 state self-digest from its serialized document.
 *
 * @param state - Strict traversal-capable runtime state.
 * @returns Digest of every encoded field except the self-digest.
 */
function digestSerializedExecutionState(
  state: WorkspaceSearchMigrationExecutionStateV2,
): string {
  return digestExecutionDocument(
    parseJsonRecord(
      serializeWorkspaceSearchMigrationExecutionState(state),
    ),
  )
}

/**
 * Recomputes an envelope digest after an intentional test mutation.
 *
 * @param state - Mutable test envelope.
 * @returns Digest of every field except the final self-digest.
 */
function digestExecutionState(
  state: WorkspaceSearchMigrationExecutionState,
): string {
  const fields = {
    kind: state.kind,
    executionStateVersion: state.executionStateVersion,
    migrationId: state.migrationId,
    migrationVersion: state.migrationVersion,
    executionRunDigest: state.executionRunDigest,
    runId: state.runId,
    configurationHash: state.configurationHash,
    revision: state.revision,
    status: state.status,
    appliedOperationCount: state.appliedOperationCount,
    applyMarkerDigestState: state.applyMarkerDigestState,
    journalSequence: state.journalSequence,
    journalHeadDigest: state.journalHeadDigest,
    minimumJournalRetainUntil:
      state.minimumJournalRetainUntil,
    updatedAt: state.updatedAt,
    runStateDigest: state.runStateDigest,
  }
  if (state.minimumJournalRetainUntil === undefined) {
    Reflect.deleteProperty(fields, 'minimumJournalRetainUntil')
  }
  return createMigrationDigest(fields)
}

/**
 * Requires one operation to fail only through the stable public boundary.
 *
 * @param operation - Candidate invalid contract operation.
 */
function expectExecutionStateFailure(
  operation: () => unknown,
): void {
  try {
    operation()
    throw new Error('Expected mutable execution-state failure.')
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(
      WorkspaceSearchMigrationExecutionStateError,
    )
    if (
      error instanceof
        WorkspaceSearchMigrationExecutionStateError
    ) {
      expect(error.code).toBe(
        'INVALID_MIGRATION_EXECUTION_STATE',
      )
      expect(error.message).toBe(
        'INVALID_MIGRATION_EXECUTION_STATE',
      )
      expect(error.message).not.toContain('raw-')
    }
  }
}
