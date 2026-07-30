import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createAttributeMapDigest,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
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
  type WorkspaceSearchJournalSegment,
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
  createAbsentMigrationItemDigest,
  serializeWorkspaceSearchJournalSegment,
  WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES,
} from './migration-journal'
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
  createWorkspaceSearchMigrationRollbackOperationCommandIdentityV2,
  createWorkspaceSearchMigrationRollbackOperationTransitionV2,
  createWorkspaceSearchMigrationRollbackStartRootV2,
  decodeWorkspaceSearchMigrationRollbackRunStateV2,
  finishWorkspaceSearchMigrationRollbackV2,
  parseWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  parseWorkspaceSearchMigrationRollbackOperationCommandIdentityV2,
  parseWorkspaceSearchMigrationRollbackOperationReceiptV2,
  parseWorkspaceSearchMigrationRollbackPersistenceStateV2,
  parseWorkspaceSearchMigrationRollbackStartRootV2,
  parseWorkspaceSearchMigrationRolledBackRootV2,
  serializeWorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  serializeWorkspaceSearchMigrationRollbackOperationCommandIdentityV2,
  serializeWorkspaceSearchMigrationRollbackOperationReceiptV2,
  serializeWorkspaceSearchMigrationRollbackPersistenceStateV2,
  serializeWorkspaceSearchMigrationRollbackStartRootV2,
  serializeWorkspaceSearchMigrationRolledBackRootV2,
  validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2,
  validateWorkspaceSearchMigrationRollbackOperationReceiptTransitionV2,
  WorkspaceSearchMigrationRollbackPersistenceV2Error,
  type WorkspaceSearchMigrationCommittedPrefixRollbackOriginV2,
  type WorkspaceSearchMigrationRollbackStartRootV2,
} from './migration-rollback-persistence-v2'
import {
  createWorkspaceSearchDocumentRecordKey,
} from '../../../src/modules/workspace-search'
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
const secondRollbackAt = '2026-07-30T00:04:20.000Z'
const firstRollbackAt = '2026-07-30T00:04:30.000Z'
const finishedAt = '2026-07-30T00:04:40.000Z'
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

/**
 * Correlated two-link forward journal evidence for reverse tests.
 */
type ReverseEvidence = {
  /** Forward mutation receipts in increasing sequence order. */
  readonly receipts: readonly [
    WorkspaceSearchOperationReceipt,
    WorkspaceSearchOperationReceipt,
  ]
  /** Immutable journal segments in increasing sequence order. */
  readonly segments: readonly [
    WorkspaceSearchJournalSegment,
    WorkspaceSearchJournalSegment,
  ]
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

  test('reverses a two-link prefix across restart and publishes a terminal root', () => {
    const context = createTwoMutationRollbackContext()
    const startRoot =
      parseWorkspaceSearchMigrationRollbackStartRootV2(
        serializeWorkspaceSearchMigrationRollbackStartRootV2(
          context.root,
        ),
      )
    const secondCommand =
      createWorkspaceSearchMigrationRollbackOperationCommandIdentityV2({
        startRoot,
        predecessorState: startRoot.initialState,
        applyReceipt: context.evidence.receipts[1],
      })
    expect(
      parseWorkspaceSearchMigrationRollbackOperationCommandIdentityV2(
        serializeWorkspaceSearchMigrationRollbackOperationCommandIdentityV2(
          secondCommand,
        ),
      ),
    ).toEqual(secondCommand)

    const second =
      createWorkspaceSearchMigrationRollbackOperationTransitionV2({
        startRoot,
        predecessorState: startRoot.initialState,
        currentAuthority: advanceAuthority(
          context.fixture.currentAuthority,
          secondRollbackAt,
        ),
        applyReceipt: context.evidence.receipts[1],
        journalSegment: context.evidence.segments[1],
        committedAt: secondRollbackAt,
      })
    expect(second.state).toMatchObject({
      status: 'rolling-back',
      predecessorKind: 'rollback-state',
      nextSequence: 1,
      restored: 1,
    })
    const restartedState =
      parseWorkspaceSearchMigrationRollbackPersistenceStateV2(
        serializeWorkspaceSearchMigrationRollbackPersistenceStateV2(
          second.state,
        ),
      )
    const restartedReceipt =
      parseWorkspaceSearchMigrationRollbackOperationReceiptV2(
        serializeWorkspaceSearchMigrationRollbackOperationReceiptV2(
          second.receipt,
        ),
      )
    expect(
      decodeWorkspaceSearchMigrationRollbackRunStateV2(
        restartedState,
      ),
    ).toEqual(second.runState)
    validateWorkspaceSearchMigrationRollbackOperationReceiptTransitionV2({
      startRoot,
      receipt: restartedReceipt,
      journalSegment: context.evidence.segments[1],
      predecessorState: startRoot.initialState,
      successorState: restartedState,
    })
    expectV2Failure(() =>
      validateWorkspaceSearchMigrationRollbackOperationReceiptTransitionV2({
        startRoot,
        receipt: restartedReceipt,
        journalSegment: context.evidence.segments[0],
        predecessorState: startRoot.initialState,
        successorState: restartedState,
      })
    )

    const first =
      createWorkspaceSearchMigrationRollbackOperationTransitionV2({
        startRoot,
        predecessorState: restartedState,
        currentAuthority: advanceAuthority(
          context.fixture.currentAuthority,
          firstRollbackAt,
        ),
        applyReceipt: context.evidence.receipts[0],
        journalSegment: context.evidence.segments[0],
        committedAt: firstRollbackAt,
      })
    expect(first.state).toMatchObject({
      status: 'rolling-back',
      nextSequence: 0,
      expectedHeadDigest: '0'.repeat(64),
      restored: 2,
    })
    expect(first.state.lastRollbackReceiptDigest)
      .toBe(first.receipt.rollbackReceiptDigest)
    expect(first.state.lastRollbackReceiptDigest)
      .not.toBe(first.receipt.receiptDigest)

    const terminal = finishWorkspaceSearchMigrationRollbackV2({
      startRoot,
      predecessorState: first.state,
      currentAuthority: advanceAuthority(
        context.fixture.currentAuthority,
        finishedAt,
      ),
      terminalReceipt: first.receipt,
      finishedAt,
    })
    expect(terminal.state).toMatchObject({
      status: 'rolled-back',
      predecessorKind: 'rollback-state',
      nextSequence: 0,
      restored: 2,
    })
    expect(terminal.root.terminalReceipt?.sequence).toBe(1)
    expect(
      parseWorkspaceSearchMigrationRolledBackRootV2(
        serializeWorkspaceSearchMigrationRolledBackRootV2(
          terminal.root,
        ),
      ),
    ).toEqual(terminal.root)
  })

  test('finishes a zero-mutation committed prefix without a receipt', () => {
    const fixture = createFixture(0)
    const predecessor = {
      kind: 'execution-run-admission',
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const evidence = createPrefixEvidence(fixture, predecessor)
    const root = createRoot(fixture, predecessor, evidence)

    const terminal = finishWorkspaceSearchMigrationRollbackV2({
      startRoot: root,
      predecessorState: root.initialState,
      currentAuthority: advanceAuthority(
        fixture.currentAuthority,
        finishedAt,
      ),
      terminalReceipt: null,
      finishedAt,
    })
    expect(terminal.root.terminalReceipt).toBeNull()
    expect(terminal.root.terminalReceiptDigest).toBeNull()
    expect(terminal.state).toMatchObject({
      status: 'rolled-back',
      restored: 0,
      lastRollbackReceiptDigest: null,
    })
    expect(
      parseWorkspaceSearchMigrationRolledBackRootV2(
        serializeWorkspaceSearchMigrationRolledBackRootV2(
          terminal.root,
        ),
      ),
    ).toEqual(terminal.root)
  })

  test('rejects out-of-order reverse evidence', () => {
    const context = createTwoMutationRollbackContext()
    expectV2Failure(() =>
      createWorkspaceSearchMigrationRollbackOperationCommandIdentityV2({
        startRoot: context.root,
        predecessorState: context.root.initialState,
        applyReceipt: context.evidence.receipts[0],
      })
    )
  })

  test('rejects a prematurely finished rollback', () => {
    const context = createTwoMutationRollbackContext()
    expectV2Failure(() =>
      finishWorkspaceSearchMigrationRollbackV2({
        startRoot: context.root,
        predecessorState: context.root.initialState,
        currentAuthority: advanceAuthority(
          context.fixture.currentAuthority,
          finishedAt,
        ),
        terminalReceipt: null,
        finishedAt,
      })
    )
  })

  test('rejects reverse evidence at the inclusive retention boundary', () => {
    const context = createTwoMutationRollbackContext()
    // Equality leaves no time beyond the minimum commit window, so it fails.
    const retentionBoundary = new Date(
      Date.parse(secondRollbackAt) +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
    ).toISOString()
    const expiringReceipt = {
      ...context.evidence.receipts[1],
      journal: {
        ...context.evidence.receipts[1].journal,
        retainUntil: retentionBoundary,
      },
    }
    expectV2Failure(() =>
      createWorkspaceSearchMigrationRollbackOperationTransitionV2({
        startRoot: context.root,
        predecessorState: context.root.initialState,
        currentAuthority: advanceAuthority(
          context.fixture.currentAuthority,
          secondRollbackAt,
        ),
        applyReceipt: expiringReceipt,
        journalSegment: context.evidence.segments[1],
        committedAt: secondRollbackAt,
      })
    )
  })

  test('rejects a non-transitive maintenance-authority replay at finish', () => {
    const context = createTwoMutationRollbackContext()
    const progressedReceipt = createMaintenanceReceipt(
      'progressed',
      '2026-07-30T00:04:10.000Z',
    )
    const progressedAuthority = advanceAuthority(
      {
        ...context.fixture.currentAuthority,
        maintenanceEvidencePointerRevision: 6,
        maintenanceEvidenceReceiptDigest:
          createMigrationDigest(progressedReceipt),
        maintenanceEvidenceReceipt: progressedReceipt,
      },
      secondRollbackAt,
    )
    const second =
      createWorkspaceSearchMigrationRollbackOperationTransitionV2({
        startRoot: context.root,
        predecessorState: context.root.initialState,
        currentAuthority: progressedAuthority,
        applyReceipt: context.evidence.receipts[1],
        journalSegment: context.evidence.segments[1],
        committedAt: secondRollbackAt,
      })
    const first =
      createWorkspaceSearchMigrationRollbackOperationTransitionV2({
        startRoot: context.root,
        predecessorState: second.state,
        currentAuthority: advanceAuthority(
          progressedAuthority,
          firstRollbackAt,
        ),
        applyReceipt: context.evidence.receipts[0],
        journalSegment: context.evidence.segments[0],
        committedAt: firstRollbackAt,
      })
    const replayedAuthority = advanceAuthority(
      {
        ...context.fixture.currentAuthority,
        maintenanceEvidencePointerRevision: 7,
      },
      finishedAt,
    )

    expectV2Failure(() =>
      finishWorkspaceSearchMigrationRollbackV2({
        startRoot: context.root,
        predecessorState: first.state,
        currentAuthority: replayedAuthority,
        terminalReceipt: first.receipt,
        finishedAt,
      })
    )
  })

  test('validates direct authority successors and rejects every regression', () => {
    const context = createTwoMutationRollbackContext()
    const predecessor = context.root.initialState.currentAuthority
    const advanced = {
      ...predecessor,
      maintenanceEvidencePointerRevision:
        predecessor.maintenanceEvidencePointerRevision + 1,
      maintenanceEvidenceReceiptDigest:
        digest('advanced-authority-receipt'),
      evaluatedAt: secondRollbackAt,
    }
    const takeover = {
      ...advanced,
      ownerId: 'rollback-persistence-v2-successor',
      fenceToken: advanced.fenceToken + 1,
    }

    validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
      predecessor,
      predecessor,
    )
    validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
      predecessor,
      advanced,
    )
    validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
      predecessor,
      takeover,
    )

    expectV2Failure(() =>
      validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
        predecessor,
        {
          ...predecessor,
          ownerId: 'same-fence-other-owner',
        },
      )
    )
    expectV2Failure(() =>
      validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
        predecessor,
        {
          ...predecessor,
          fenceToken: predecessor.fenceToken - 1,
        },
      )
    )
    expectV2Failure(() =>
      validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
        predecessor,
        {
          ...predecessor,
          maintenanceEvidencePointerRevision:
            predecessor.maintenanceEvidencePointerRevision - 1,
        },
      )
    )
    expectV2Failure(() =>
      validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
        predecessor,
        {
          ...predecessor,
          maintenanceEvidenceReceiptDigest:
            digest('same-revision-other-receipt'),
        },
      )
    )
    expectV2Failure(() =>
      validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
        predecessor,
        {
          ...predecessor,
          maintenanceEvidencePointerRevision:
            predecessor.maintenanceEvidencePointerRevision + 1,
        },
      )
    )
    expectV2Failure(() =>
      validateWorkspaceSearchMigrationRollbackAuthoritySuccessorV2(
        predecessor,
        {
          ...predecessor,
          evaluatedAt: '2026-07-30T00:03:14.000Z',
        },
      )
    )
  })

  test('rejects self-redigested invalid reverse receipts and terminal roots', () => {
    const context = createTwoMutationRollbackContext()
    const second =
      createWorkspaceSearchMigrationRollbackOperationTransitionV2({
        startRoot: context.root,
        predecessorState: context.root.initialState,
        currentAuthority: advanceAuthority(
          context.fixture.currentAuthority,
          secondRollbackAt,
        ),
        applyReceipt: context.evidence.receipts[1],
        journalSegment: context.evidence.segments[1],
        committedAt: secondRollbackAt,
      })
    const first =
      createWorkspaceSearchMigrationRollbackOperationTransitionV2({
        startRoot: context.root,
        predecessorState: second.state,
        currentAuthority: advanceAuthority(
          context.fixture.currentAuthority,
          firstRollbackAt,
        ),
        applyReceipt: context.evidence.receipts[0],
        journalSegment: context.evidence.segments[0],
        committedAt: firstRollbackAt,
      })
    const terminal = finishWorkspaceSearchMigrationRollbackV2({
      startRoot: context.root,
      predecessorState: first.state,
      currentAuthority: advanceAuthority(
        context.fixture.currentAuthority,
        finishedAt,
      ),
      terminalReceipt: first.receipt,
      finishedAt,
    })
    const receiptMutations:
      readonly (readonly [string, unknown])[] = [
        [
          'previousJournalHeadDigest',
          digest('invalid-previous-journal-head'),
        ],
        [
          'successorRevision',
          first.receipt.predecessorRevision + 2,
        ],
        ['committedAt', secondMarkerAt],
      ]
    for (const [key, value] of receiptMutations) {
      const receiptDocument = decodeCanonicalRecord(
        serializeWorkspaceSearchMigrationRollbackOperationReceiptV2(
          first.receipt,
        ),
      )
      Reflect.set(receiptDocument, key, value)
      expectV2Failure(() =>
        parseWorkspaceSearchMigrationRollbackOperationReceiptV2(
          redigestReceiptDocument(receiptDocument),
        )
      )
    }

    const lateStartDocument = decodeCanonicalRecord(
      serializeWorkspaceSearchMigrationRolledBackRootV2(
        terminal.root,
      ),
    )
    Reflect.set(
      lateStartDocument,
      'rollbackStartedAt',
      '2026-07-30T00:04:41.000Z',
    )
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationRolledBackRootV2(
        redigestRolledBackRootDocument(lateStartDocument),
      )
    )

    const missingReceiptDocument = decodeCanonicalRecord(
      serializeWorkspaceSearchMigrationRolledBackRootV2(
        terminal.root,
      ),
    )
    Reflect.set(missingReceiptDocument, 'terminalReceipt', null)
    Reflect.set(
      missingReceiptDocument,
      'terminalReceiptDigest',
      null,
    )
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationRolledBackRootV2(
        redigestRolledBackRootDocument(
          missingReceiptDocument,
        ),
      )
    )

    const mismatchedStateDocument = decodeCanonicalRecord(
      serializeWorkspaceSearchMigrationRolledBackRootV2(
        terminal.root,
      ),
    )
    const mismatchedTerminalState = readTestRecord(
      Reflect.get(mismatchedStateDocument, 'terminalState'),
    )
    Reflect.set(
      mismatchedTerminalState,
      'predecessorDigest',
      digest('invalid-terminal-predecessor'),
    )
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationRolledBackRootV2(
        redigestTerminalStateInRolledBackRootDocument(
          mismatchedStateDocument,
        ),
      )
    )
  })

  test('bounds hostile caller-owned reverse-journal graphs', () => {
    const context = createTwoMutationRollbackContext()
    const wideRecord: Record<string, boolean> = {}
    for (let index = 0; index < 1_025; index += 1) {
      wideRecord[`field${index}`] = true
    }
    let sharedAttribute: unknown = {
      type: 'S',
      value: 'leaf',
    }
    for (let depth = 0; depth < 20; depth += 1) {
      sharedAttribute = {
        type: 'M',
        value: {
          left: sharedAttribute,
          right: sharedAttribute,
        },
      }
    }
    const oversizedBinary = new Uint8Array(
      WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES + 1,
    )
    const oversizedString = 's'.repeat(
      WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES + 1,
    )
    const oversizedKeyRecord = {
      [
        'k'.repeat(
          WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES + 1,
        )
      ]: true,
    }
    const aggregateOversizedText = {
      first: 'a'.repeat(1_100_000),
      second: 'b'.repeat(1_100_000),
    }
    const aggregateOversizedBinary = [
      new Uint8Array(1_048_577),
      new Uint8Array(1_048_577),
    ]
    const sharedBinary = new Uint8Array(
      new SharedArrayBuffer(1),
    )
    let binaryAccessorInvoked = false
    const accessorBinary = Uint8Array.of(1)
    Object.defineProperty(accessorBinary, 'byteLength', {
      enumerable: true,
      get() {
        binaryAccessorInvoked = true
        return 1
      },
    })

    const aliasedJournalSegment = structuredClone(
      context.evidence.segments[1],
    )
    const aliasedAfter = readTestRecord(
      aliasedJournalSegment.after,
    )
    const aliasedItem = readTestRecord(
      Reflect.get(aliasedAfter, 'item'),
    )
    Reflect.set(
      aliasedItem,
      'hostileGraph',
      sharedAttribute,
    )
    expectV2Failure(() =>
      Reflect.apply(
        createWorkspaceSearchMigrationRollbackOperationTransitionV2,
        undefined,
        [{
          startRoot: context.root,
          predecessorState: context.root.initialState,
          currentAuthority: advanceAuthority(
            context.fixture.currentAuthority,
            secondRollbackAt,
          ),
          applyReceipt: context.evidence.receipts[1],
          journalSegment: aliasedJournalSegment,
          committedAt: secondRollbackAt,
        }],
      )
    )

    for (const hostileGraph of [
      wideRecord,
      oversizedBinary,
      oversizedString,
      oversizedKeyRecord,
      aggregateOversizedText,
      aggregateOversizedBinary,
      sharedBinary,
      accessorBinary,
    ]) {
      const hostileJournalSegment = structuredClone(
        context.evidence.segments[1],
      )
      const hostileAfter = readTestRecord(
        hostileJournalSegment.after,
      )
      const hostileItem = readTestRecord(
        Reflect.get(hostileAfter, 'item'),
      )
      Reflect.set(hostileItem, 'hostileGraph', hostileGraph)
      expectV2Failure(() =>
        Reflect.apply(
          createWorkspaceSearchMigrationRollbackOperationTransitionV2,
          undefined,
          [{
            startRoot: context.root,
            predecessorState: context.root.initialState,
            currentAuthority: advanceAuthority(
              context.fixture.currentAuthority,
              secondRollbackAt,
            ),
            applyReceipt: context.evidence.receipts[1],
            journalSegment: hostileJournalSegment,
            committedAt: secondRollbackAt,
          }],
        )
      )
    }
    expect(binaryAccessorInvoked).toBeFalse()
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
    const terminal = finishWorkspaceSearchMigrationRollbackV2({
      startRoot: parsed,
      predecessorState: parsed.initialState,
      currentAuthority: advanceAuthority(
        fixture.currentAuthority,
        finishedAt,
      ),
      terminalReceipt: null,
      finishedAt,
    })
    const restartedTerminal =
      parseWorkspaceSearchMigrationRolledBackRootV2(
        serializeWorkspaceSearchMigrationRolledBackRootV2(
          terminal.root,
        ),
      )
    expect(
      restartedTerminal.terminalState.runState.apply.sources[
        'project-directory'
      ].cursor,
    ).toEqual(createBinaryCheckpoint().cursor)
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

  test('keeps the embedded start state initial-only after lifecycle parsing broadens', () => {
    const fixture = createFixture(0)
    const predecessor = {
      kind: 'execution-run-admission',
    } satisfies
      WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
    const evidence = createPrefixEvidence(fixture, predecessor)
    const root = createRoot(fixture, predecessor, evidence)

    const advancedDocument = decodeCanonicalRecord(
      serializeWorkspaceSearchMigrationRollbackStartRootV2(root),
    )
    const advancedState = readTestRecord(
      Reflect.get(advancedDocument, 'initialState'),
    )
    Reflect.set(advancedState, 'predecessorKind', 'rollback-state')
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationRollbackStartRootV2(
        redigestRootDocument(advancedDocument),
      )
    )

    const terminalDocument = decodeCanonicalRecord(
      serializeWorkspaceSearchMigrationRollbackStartRootV2(root),
    )
    const terminalState = readTestRecord(
      Reflect.get(terminalDocument, 'initialState'),
    )
    const terminalRunState = readTestRecord(
      Reflect.get(terminalState, 'runState'),
    )
    Reflect.set(terminalState, 'status', 'rolled-back')
    Reflect.set(terminalState, 'predecessorKind', 'rollback-state')
    Reflect.set(terminalRunState, 'status', 'rolled-back')
    expectV2Failure(() =>
      parseWorkspaceSearchMigrationRollbackStartRootV2(
        redigestRootDocument(terminalDocument),
      )
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
 * Creates one correlated two-mutation committed-prefix rollback context.
 *
 * @returns Exact root, forward evidence, and fresh authority fixture.
 */
function createTwoMutationRollbackContext() {
  const fixture = createFixture(2)
  const evidence = createReverseEvidence(fixture.admission)
  const firstState =
    createWorkspaceSearchMigrationExecutionState({
      admission: fixture.admission,
      nextRunState: advanceRunState(
        fixture.admission.runState,
        evidence.receipts[0],
      ),
      marker: evidence.receipts[0],
    })
  const secondRunState = advanceRunState(
    reconstructWorkspaceSearchMigrationRunState(
      fixture.admission,
      firstState,
    ),
    evidence.receipts[1],
  )
  const secondState =
    createWorkspaceSearchMigrationExecutionState({
      admission: fixture.admission,
      predecessor: firstState,
      nextRunState: secondRunState,
      marker: evidence.receipts[1],
    })
  const predecessor = {
    kind: 'mutable-execution-state',
    executionState: secondState,
  } satisfies
    WorkspaceSearchMigrationCommittedPrefixApplySealPredecessor
  const prefixEvidence = createPrefixEvidence(
    fixture,
    predecessor,
  )
  return {
    fixture,
    evidence,
    root: createRoot(fixture, predecessor, prefixEvidence),
  }
}

/**
 * Creates two exact forward journal links in increasing sequence order.
 *
 * @param admission - Immutable execution admission owning both mutations.
 * @returns Two linked journal segments and matching forward receipts.
 */
function createReverseEvidence(
  admission: WorkspaceSearchMigrationExecutionRun,
): ReverseEvidence {
  const first = createJournalLink({
    admission,
    planSequence: 1,
    sequence: 1,
    entityId: 'document-1',
    previousHeadDigest: '0'.repeat(64),
    journalCreatedAt: '2026-07-30T00:02:25.000Z',
    committedAt: firstMarkerAt,
  })
  const second = createJournalLink({
    admission,
    planSequence: 2,
    sequence: 2,
    entityId: 'document-2',
    previousHeadDigest: first.receipt.journal.headDigest,
    journalCreatedAt: '2026-07-30T00:02:40.000Z',
    committedAt: secondMarkerAt,
  })
  return {
    receipts: [first.receipt, second.receipt],
    segments: [first.segment, second.segment],
  }
}

/**
 * Inputs for one exact immutable journal link fixture.
 */
type CreateJournalLinkInput = {
  /** Immutable execution admission owning the operation. */
  readonly admission: WorkspaceSearchMigrationExecutionRun
  /** One-based immutable plan position. */
  readonly planSequence: number
  /** One-based mutation-only journal sequence. */
  readonly sequence: number
  /** Stable target search-document entity identifier. */
  readonly entityId: string
  /** Exact preceding journal-chain head. */
  readonly previousHeadDigest: string
  /** Canonical immutable journal creation time. */
  readonly journalCreatedAt: string
  /** Canonical forward mutation commit time. */
  readonly committedAt: string
}

/**
 * Creates one exact immutable journal segment and matching apply receipt.
 *
 * @param input - Named immutable journal-link fixture values.
 * @returns Exact linked journal segment and durable apply receipt.
 */
function createJournalLink(input: CreateJournalLinkInput) {
  const {
    admission,
    planSequence,
    sequence,
    entityId,
    previousHeadDigest,
    journalCreatedAt,
    committedAt,
  } = input
  const recordKey = createWorkspaceSearchDocumentRecordKey(
    'document',
    entityId,
  )
  const targetKey = {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: recordKey },
  }
  const afterItem = {
    ...targetKey,
    entryType: { S: 'search-document' },
    entityType: { S: 'document' },
    entityId: { S: entityId },
    title: { S: `Title ${entityId}` },
  }
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const beforeDigest = createAbsentMigrationItemDigest()
  const afterDigest = createAttributeMapDigest(afterItem)
  const operationId = digest(`mutation:${planSequence}`)
  const sourceDigest = digest(`source:${planSequence}`)
  const segment: WorkspaceSearchJournalSegment = {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: admission.configurationHash,
    sequence,
    preparedFenceToken: 7,
    operationId,
    sourceDigest,
    previousHeadDigest,
    targetKey: encodeAttributeMap(targetKey),
    targetKeyDigest,
    before: {
      exists: false,
      digest: beforeDigest,
    },
    after: {
      exists: true,
      item: encodeAttributeMap(afterItem),
      digest: afterDigest,
    },
    createdAt: journalCreatedAt,
  }
  const journalText =
    serializeWorkspaceSearchJournalSegment(segment)
  const contentDigest = createHash('sha256')
    .update(journalText, 'utf8')
    .digest('hex')
  const versionId = `journal-version-${sequence}`
  const headDigest = createJournalHeadDigest({
    previousHeadDigest,
    sequence,
    operationId,
    contentDigest,
    versionId,
  })
  const receipt: WorkspaceSearchOperationReceipt = {
    kind: 'workspace-search-operation-applied',
    markerVersion: 1,
    runId,
    configurationHash: admission.configurationHash,
    operationId,
    planSequence,
    planOperationDigest:
      digest(`plan-operation:${planSequence}`),
    sequence,
    targetKeyDigest,
    sourceDigest,
    beforeDigest,
    afterDigest,
    fenceToken: 7,
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(
        admission.runState.maintenanceEvidenceReceipt,
      ),
    journal: {
      objectKey:
        `workspace-search/v1/runs/${runId}/segments/` +
        `${String(sequence).padStart(12, '0')}.json`,
      versionId,
      contentDigest,
      byteLength: new TextEncoder().encode(journalText).byteLength,
      retainUntil,
      headDigest,
    },
    committedAt,
  }
  return { segment, receipt }
}

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
 * @returns Immutable admission, planning root, and fresh authority.
 */
function createFixture(
  planOperationCount: number,
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
    retainUntil,
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
 * Advances one current authority to a fresh fixed-duration lease window.
 *
 * @param authority - Existing identity and maintenance evidence.
 * @param at - Transaction time that must have commit headroom.
 * @returns Exact authority with a one-minute lease around the transaction.
 */
function advanceAuthority(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  at: string,
): WorkspaceSearchMigrationPrePlanAuthority {
  const atMilliseconds = Date.parse(at)
  return {
    ...authority,
    lease: {
      ...authority.lease,
      heartbeatAt:
        new Date(atMilliseconds - 30_000).toISOString(),
      expiresAt:
        new Date(atMilliseconds + 30_000).toISOString(),
    },
    evaluatedAt:
      new Date(atMilliseconds - 1_000).toISOString(),
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
 * Recomputes one reverse-receipt self digest after a test mutation.
 *
 * @param receipt - Mutable canonical reverse-receipt document.
 * @returns Canonical bytes carrying the replacement receipt digest.
 */
function redigestReceiptDocument(
  receipt: Record<string, unknown>,
): Uint8Array {
  const common = copyRecordWithout(
    receipt,
    new Set(['receiptDigest']),
  )
  Reflect.set(
    receipt,
    'receiptDigest',
    createMigrationDigest(common),
  )
  return new TextEncoder().encode(
    serializeCanonicalJson(receipt),
  )
}

/**
 * Recomputes one terminal-root self digest after a test mutation.
 *
 * @param root - Mutable canonical terminal-root document.
 * @returns Canonical bytes carrying the replacement root digest.
 */
function redigestRolledBackRootDocument(
  root: Record<string, unknown>,
): Uint8Array {
  const common = copyRecordWithout(root, new Set(['rootDigest']))
  Reflect.set(root, 'rootDigest', createMigrationDigest(common))
  return new TextEncoder().encode(serializeCanonicalJson(root))
}

/**
 * Recomputes a mutated terminal state and its enclosing root digest.
 *
 * @param root - Mutable canonical terminal-root document.
 * @returns Canonical bytes carrying coherent state and root self digests.
 */
function redigestTerminalStateInRolledBackRootDocument(
  root: Record<string, unknown>,
): Uint8Array {
  const state = readTestRecord(
    Reflect.get(root, 'terminalState'),
  )
  const stateCommon = copyRecordWithout(
    state,
    new Set(['stateDigest']),
  )
  const stateDigest = createMigrationDigest(stateCommon)
  Reflect.set(state, 'stateDigest', stateDigest)
  Reflect.set(root, 'terminalStateDigest', stateDigest)
  return redigestRolledBackRootDocument(root)
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
