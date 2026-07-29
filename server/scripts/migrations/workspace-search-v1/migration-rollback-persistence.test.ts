import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import {
  createAttributeMapDigest,
  encodeAttributeMap,
} from './dynamodb-attribute-codec'
import {
  serializeWorkspaceSearchPlanSeal,
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
  type WorkspaceSearchJournalReference,
  type WorkspaceSearchJournalSegment,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationRunState,
  type WorkspaceSearchMigrationSourceName,
  type WorkspaceSearchMigrationTraversalProgress,
  type WorkspaceSearchOperationReceipt,
  type WorkspaceSearchPlanSeal,
  WORKSPACE_SEARCH_MIGRATION_ID,
  WORKSPACE_SEARCH_MIGRATION_VERSION,
  zeroHexDigest,
} from './migration-contract'
import {
  parseWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationAppliedRoot,
  serializeWorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationAppliedRoot,
  type WorkspaceSearchMigrationCompleteApplySeal,
  type WorkspaceSearchMigrationCompleteApplySealReference,
} from './migration-apply-seal'
import {
  parseWorkspaceSearchMigrationExecutionRun,
  serializeWorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRun,
  type WorkspaceSearchMigrationExecutionRunBinding,
} from './migration-execution-run'
import {
  createAbsentMigrationItemDigest,
  serializeWorkspaceSearchJournalSegment,
  WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES,
} from './migration-journal'
import {
  WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX,
} from './migration-plan-artifact'
import type {
  WorkspaceSearchMigrationPrePlanAuthority,
} from './migration-pre-plan-authority-aws'
import {
  WorkspaceSearchMigrationRollbackPersistenceError,
  WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_MAX_BYTES,
  createWorkspaceSearchMigrationRollbackOperationCommandIdentity,
  createWorkspaceSearchMigrationRollbackOperationTransition,
  createWorkspaceSearchMigrationRollbackPureSealBinding,
  createWorkspaceSearchMigrationRollbackStartRoot,
  decodeWorkspaceSearchMigrationRollbackRunState,
  finishWorkspaceSearchMigrationRollback,
  parseWorkspaceSearchMigrationRollbackOperationReceipt,
  parseWorkspaceSearchMigrationRollbackPersistenceState,
  parseWorkspaceSearchMigrationRollbackStartRoot,
  parseWorkspaceSearchMigrationRolledBackRoot,
  serializeWorkspaceSearchMigrationRollbackOperationReceipt,
  serializeWorkspaceSearchMigrationRollbackPersistenceState,
  serializeWorkspaceSearchMigrationRollbackStartRoot,
  serializeWorkspaceSearchMigrationRolledBackRoot,
  validateWorkspaceSearchMigrationRollbackOperationReceiptTransition,
  type WorkspaceSearchMigrationRollbackOperationReceipt,
  type WorkspaceSearchMigrationRollbackPersistenceState,
  type WorkspaceSearchMigrationRolledBackRoot,
  type WorkspaceSearchMigrationRollbackStartRoot,
} from './migration-rollback-persistence'
import type {
  WorkspaceSearchMigrationSealedPlanningTableIds,
} from './migration-sealed-planning-authority'
import {
  parseWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2,
  type WorkspaceSearchMigrationSealedPlanningAuthorityV2,
} from './migration-sealed-planning-authority-v2'
import {
  createEmptyWorkspaceSearchPlanDigest,
  createWorkspaceSearchMigrationRunState,
  validateWorkspaceSearchMigrationRunState,
} from './migration-state-machine'
import {
  createWorkspaceSearchDocumentRecordKey,
} from '../../../src/modules/workspace-search'

const runId = 'rollback-persistence-test'
const ownerId = 'rollback-owner'
const createdAt = '2026-07-29T01:10:00.000Z'
const appliedAt = '2026-07-29T01:10:10.000Z'
const startAt = '2026-07-29T01:10:20.000Z'
const secondRollbackAt = '2026-07-29T01:10:30.000Z'
const firstRollbackAt = '2026-07-29T01:10:40.000Z'
const finishedAt = '2026-07-29T01:10:50.000Z'
const retainUntil = '2026-08-30T01:00:00.000Z'

/**
 * Complete correlated fixture for one complete applied-root rollback.
 */
type RollbackFixture = {
  /** Exact immutable execution admission. */
  readonly executionRun: WorkspaceSearchMigrationExecutionRun
  /** Exact immutable version-two planning authority. */
  readonly sealedPlanningAuthority:
    WorkspaceSearchMigrationSealedPlanningAuthorityV2
  /** Exact immutable complete applied root. */
  readonly appliedRoot: WorkspaceSearchMigrationAppliedRoot
  /** Exact applied pure state represented by the applied root. */
  readonly appliedState: WorkspaceSearchMigrationRunState
  /** Fresh authority used by rollback transactions. */
  readonly currentAuthority: WorkspaceSearchMigrationPrePlanAuthority
  /** Forward mutation receipts in increasing sequence order. */
  readonly applyReceipts: readonly WorkspaceSearchOperationReceipt[]
  /** Exact immutable journal segments in increasing sequence order. */
  readonly journalSegments: readonly WorkspaceSearchJournalSegment[]
}

/**
 * Optional forward-evidence times used by chronology test fixtures.
 */
type RollbackFixtureOptions = {
  /** Replacement creation time for the second journal segment. */
  readonly secondJournalCreatedAt?: string
  /** Replacement commit time for the second apply receipt. */
  readonly secondApplyCommittedAt?: string
}

describe('Workspace Search rollback persistence contract', () => {
  test(
    'persists start, strict 2 to 1 reverse steps, restart, and terminal root',
    () => {
      const fixture = createFixture(2)
      const startRoot = createStartRoot(fixture)

      expect(startRoot.originalJournalSequence).toBe(2)
      expect(startRoot.initialState.nextSequence).toBe(2)
      expect(
        startRoot.initialState.runState.applySeal,
      ).toEqual(
        createWorkspaceSearchMigrationRollbackPureSealBinding(
          fixture.appliedRoot,
        ).reference,
      )

      const restartedRoot =
        parseWorkspaceSearchMigrationRollbackStartRoot(
          serializeWorkspaceSearchMigrationRollbackStartRoot(
            startRoot,
          ),
        )
      const second = createWorkspaceSearchMigrationRollbackOperationTransition({
        startRoot: restartedRoot,
        predecessorState: restartedRoot.initialState,
        currentAuthority: advanceAuthority(
          fixture.currentAuthority,
          secondRollbackAt,
        ),
        applyReceipt: requireArrayEntry(fixture.applyReceipts, 1),
        journalSegment: requireArrayEntry(fixture.journalSegments, 1),
        committedAt: secondRollbackAt,
      })
      expect(second.state.nextSequence).toBe(1)
      expect(second.state.restored).toBe(1)

      const restartedState =
        parseWorkspaceSearchMigrationRollbackPersistenceState(
          serializeWorkspaceSearchMigrationRollbackPersistenceState(
            second.state,
          ),
        )
      const restartedReceipt =
        parseWorkspaceSearchMigrationRollbackOperationReceipt(
          serializeWorkspaceSearchMigrationRollbackOperationReceipt(
            second.receipt,
          ),
        )
      const receiptText = new TextDecoder().decode(
        serializeWorkspaceSearchMigrationRollbackOperationReceipt(
          second.receipt,
        ),
      )
      expect(receiptText).not.toContain('"journalSegment":')
      expect(receiptText).not.toContain('"targetKey":')
      expect(receiptText).not.toContain('"item":')
      expect(
        captureRollbackFailure(() =>
          serializeWorkspaceSearchMigrationRollbackOperationReceipt(
            replaceRollbackReceiptPreviousHeadDigest(
              second.receipt,
              digest('substituted-previous-journal-head'),
            ),
          )
        ).code,
      ).toBe('INVALID_ROLLBACK_PERSISTENCE')
      expect(
        decodeWorkspaceSearchMigrationRollbackRunState(restartedState),
      ).toEqual(second.runState)

      const first = createWorkspaceSearchMigrationRollbackOperationTransition({
        startRoot: restartedRoot,
        predecessorState: restartedState,
        currentAuthority: advanceAuthority(
          fixture.currentAuthority,
          firstRollbackAt,
        ),
        applyReceipt: requireArrayEntry(fixture.applyReceipts, 0),
        journalSegment: requireArrayEntry(fixture.journalSegments, 0),
        committedAt: firstRollbackAt,
      })
      expect(first.state.nextSequence).toBe(0)
      expect(first.state.expectedHeadDigest).toBe(zeroHexDigest())
      expect(first.state.restored).toBe(2)
      expect(restartedReceipt.sequence).toBe(2)

      const terminal = finishWorkspaceSearchMigrationRollback({
        startRoot: restartedRoot,
        predecessorState: first.state,
        currentAuthority: advanceAuthority(
          fixture.currentAuthority,
          finishedAt,
        ),
        terminalReceipt: first.receipt,
        finishedAt,
      })
      expect(terminal.state.status).toBe('rolled-back')
      expect(terminal.root.terminalReceipt?.sequence).toBe(1)
      expect(
        parseWorkspaceSearchMigrationRolledBackRoot(
          serializeWorkspaceSearchMigrationRolledBackRoot(
            terminal.root,
          ),
        ),
      ).toEqual(terminal.root)
    },
  )

  test('finishes a zero-mutation complete apply without a receipt', () => {
    const fixture = createFixture(0)
    const startRoot = createStartRoot(fixture)
    expect(startRoot.initialState.nextSequence).toBe(0)

    const terminal = finishWorkspaceSearchMigrationRollback({
      startRoot,
      predecessorState: startRoot.initialState,
      currentAuthority: advanceAuthority(
        fixture.currentAuthority,
        finishedAt,
      ),
      terminalReceipt: null,
      finishedAt,
    })
    expect(terminal.root.terminalReceipt).toBeNull()
    expect(terminal.state.status).toBe('rolled-back')
    expect(terminal.state.restored).toBe(0)
  })

  test('rejects out-of-order and substituted forward evidence', () => {
    const fixture = createFixture(2)
    const startRoot = createStartRoot(fixture)
    const otherStartRoot = createStartRoot(createFixture(0))
    const substitutedState = replaceRollbackStateStartRootDigest(
      startRoot.initialState,
      otherStartRoot.startRootDigest,
    )
    expect(
      parseWorkspaceSearchMigrationRollbackPersistenceState(
        serializeWorkspaceSearchMigrationRollbackPersistenceState(
          substitutedState,
        ),
      ),
    ).toEqual(substitutedState)
    expect(
      captureRollbackFailure(() =>
        createWorkspaceSearchMigrationRollbackOperationTransition({
          startRoot,
          predecessorState: substitutedState,
          currentAuthority: advanceAuthority(
            fixture.currentAuthority,
            secondRollbackAt,
          ),
          applyReceipt: requireArrayEntry(fixture.applyReceipts, 1),
          journalSegment: requireArrayEntry(
            fixture.journalSegments,
            1,
          ),
          committedAt: secondRollbackAt,
        })
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')
    expect(
      captureRollbackFailure(() =>
        createWorkspaceSearchMigrationRollbackOperationTransition({
          startRoot,
          predecessorState: startRoot.initialState,
          currentAuthority: advanceAuthority(
            fixture.currentAuthority,
            secondRollbackAt,
          ),
          applyReceipt: requireArrayEntry(fixture.applyReceipts, 0),
          journalSegment: requireArrayEntry(fixture.journalSegments, 0),
          committedAt: secondRollbackAt,
        })
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const secondReceipt = requireArrayEntry(
      fixture.applyReceipts,
      1,
    )
    const substituted = {
      ...secondReceipt,
      journal: {
        ...secondReceipt.journal,
        versionId: 'substituted-version',
      },
    }
    expect(
      captureRollbackFailure(() =>
        createWorkspaceSearchMigrationRollbackOperationTransition({
          startRoot,
          predecessorState: startRoot.initialState,
          currentAuthority: advanceAuthority(
            fixture.currentAuthority,
            secondRollbackAt,
          ),
          applyReceipt: substituted,
          journalSegment: requireArrayEntry(
            fixture.journalSegments,
            1,
          ),
          committedAt: secondRollbackAt,
        })
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')
  })

  test(
    'replays the exact pure rollback successor and rejects self-rehashed substitutions',
    () => {
      const fixture = createFixture(2)
      const startRoot = createStartRoot(fixture)
      const journalSegment = requireArrayEntry(
        fixture.journalSegments,
        1,
      )
      const transition =
        createWorkspaceSearchMigrationRollbackOperationTransition({
          startRoot,
          predecessorState: startRoot.initialState,
          currentAuthority: advanceAuthority(
            fixture.currentAuthority,
            secondRollbackAt,
          ),
          applyReceipt: requireArrayEntry(
            fixture.applyReceipts,
            1,
          ),
          journalSegment,
          committedAt: secondRollbackAt,
        })

      expect(() =>
        validateWorkspaceSearchMigrationRollbackOperationReceiptTransition({
          startRoot,
          receipt: transition.receipt,
          journalSegment,
          predecessorState: startRoot.initialState,
          successorState: transition.state,
        })
      ).not.toThrow()

      const substitutedState = rehashRollbackState({
        state: transition.state,
        runState: {
          ...transition.state.runState,
          updatedAt: '2026-07-29T01:10:31.000Z',
        },
        lastRollbackReceiptDigest:
          transition.state.lastRollbackReceiptDigest,
      })
      const substitutedReceipt = rehashRollbackOperationReceipt({
        receipt: transition.receipt,
        rollbackReceipt: transition.receipt.rollbackReceipt,
        successorStateDigest: substitutedState.stateDigest,
      })
      expect(
        captureRollbackFailure(() =>
          validateWorkspaceSearchMigrationRollbackOperationReceiptTransition({
            startRoot,
            receipt: substitutedReceipt,
            journalSegment,
            predecessorState: startRoot.initialState,
            successorState: substitutedState,
          })
        ).code,
      ).toBe('INVALID_ROLLBACK_PERSISTENCE')

      const impossibleAuthority = {
        ...transition.state.currentAuthority,
        maintenanceEvidencePointerRevision:
          transition.state.currentAuthority
            .maintenanceEvidencePointerRevision + 1,
      }
      const impossibleAuthorityState = rehashRollbackState({
        state: transition.state,
        currentAuthority: impossibleAuthority,
        runState: transition.state.runState,
        lastRollbackReceiptDigest:
          transition.state.lastRollbackReceiptDigest,
      })
      const impossibleAuthorityReceipt =
        rehashRollbackOperationReceipt({
          receipt: transition.receipt,
          currentAuthority: impossibleAuthority,
          rollbackReceipt: transition.receipt.rollbackReceipt,
          successorStateDigest:
            impossibleAuthorityState.stateDigest,
        })
      expect(
        captureRollbackFailure(() =>
          validateWorkspaceSearchMigrationRollbackOperationReceiptTransition({
            startRoot,
            receipt: impossibleAuthorityReceipt,
            journalSegment,
            predecessorState: startRoot.initialState,
            successorState: impossibleAuthorityState,
          })
        ).code,
      ).toBe('INVALID_ROLLBACK_PERSISTENCE')

      const substitutedFenceReceipt = {
        ...transition.receipt.rollbackReceipt,
        fenceToken:
          transition.receipt.rollbackReceipt.fenceToken + 1,
      }
      const substitutedFenceDigest =
        createMigrationDigest(substitutedFenceReceipt)
      const substitutedFenceState = rehashRollbackState({
        state: transition.state,
        runState: transition.state.runState,
        lastRollbackReceiptDigest: substitutedFenceDigest,
      })
      expect(
        captureRollbackFailure(() =>
          validateWorkspaceSearchMigrationRollbackOperationReceiptTransition({
            startRoot,
            receipt: rehashRollbackOperationReceipt({
              receipt: transition.receipt,
              rollbackReceipt: substitutedFenceReceipt,
              successorStateDigest:
                substitutedFenceState.stateDigest,
            }),
            journalSegment,
            predecessorState: startRoot.initialState,
            successorState: substitutedFenceState,
          })
        ).code,
      ).toBe('INVALID_ROLLBACK_PERSISTENCE')

      const substitutedEvidenceReceipt = {
        ...transition.receipt.rollbackReceipt,
        maintenanceEvidenceReceiptDigest:
          digest('substituted-maintenance-evidence'),
      }
      const substitutedEvidenceDigest =
        createMigrationDigest(substitutedEvidenceReceipt)
      const substitutedEvidenceState = rehashRollbackState({
        state: transition.state,
        runState: transition.state.runState,
        lastRollbackReceiptDigest: substitutedEvidenceDigest,
      })
      expect(
        captureRollbackFailure(() =>
          validateWorkspaceSearchMigrationRollbackOperationReceiptTransition({
            startRoot,
            receipt: rehashRollbackOperationReceipt({
              receipt: transition.receipt,
              rollbackReceipt: substitutedEvidenceReceipt,
              successorStateDigest:
                substitutedEvidenceState.stateDigest,
            }),
            journalSegment,
            predecessorState: startRoot.initialState,
            successorState: substitutedEvidenceState,
          })
        ).code,
      ).toBe('INVALID_ROLLBACK_PERSISTENCE')
    },
  )

  test('uses the canonical apply marker codec at rollback boundaries', () => {
    const fixture = createFixture(2)
    const startRoot = createStartRoot(fixture)
    const transition =
      createWorkspaceSearchMigrationRollbackOperationTransition({
        startRoot,
        predecessorState: startRoot.initialState,
        currentAuthority: advanceAuthority(
          fixture.currentAuthority,
          secondRollbackAt,
        ),
        applyReceipt: requireArrayEntry(fixture.applyReceipts, 1),
        journalSegment: requireArrayEntry(
          fixture.journalSegments,
          1,
        ),
        committedAt: secondRollbackAt,
      })
    const applyReceipt = transition.receipt.applyReceipt
    const invalidOperationId = 'not-a-canonical-operation-digest'
    const invalidVersionId = 'null'
    const invalidVersionJournal = {
      ...applyReceipt.journal,
      versionId: invalidVersionId,
    }
    const candidates: readonly WorkspaceSearchOperationReceipt[] = [
      {
        ...applyReceipt,
        operationId: invalidOperationId,
      },
      {
        ...applyReceipt,
        journal: invalidVersionJournal,
      },
      {
        ...applyReceipt,
        journal: {
          ...applyReceipt.journal,
          byteLength:
            WORKSPACE_SEARCH_JOURNAL_SEGMENT_MAX_BYTES + 1,
        },
      },
    ]

    for (const candidate of candidates) {
      expect(
        captureRollbackFailure(() =>
          createWorkspaceSearchMigrationRollbackOperationCommandIdentity({
            startRoot,
            predecessorState: startRoot.initialState,
            applyReceipt: candidate,
          })
        ).code,
      ).toBe('INVALID_ROLLBACK_PERSISTENCE')
    }

    const alreadyCurrentMarker = {
      kind: 'workspace-search-operation-already-current',
      markerVersion: 1,
      runId: applyReceipt.runId,
      configurationHash: applyReceipt.configurationHash,
      operationId: applyReceipt.operationId,
      planSequence: applyReceipt.planSequence,
      planOperationDigest: applyReceipt.planOperationDigest,
      targetKeyDigest: applyReceipt.targetKeyDigest,
      afterDigest: applyReceipt.afterDigest,
      fenceToken: applyReceipt.fenceToken,
      maintenanceEvidenceReceiptDigest:
        applyReceipt.maintenanceEvidenceReceiptDigest,
      recordedAt: applyReceipt.committedAt,
    }
    expect(
      captureRollbackFailure(() =>
        Reflect.apply(
          createWorkspaceSearchMigrationRollbackOperationCommandIdentity,
          undefined,
          [{
            startRoot,
            predecessorState: startRoot.initialState,
            applyReceipt: alreadyCurrentMarker,
          }],
        )
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    for (const markerWithUndefined of [
      {
        ...applyReceipt,
        unexpected: undefined,
      },
      {
        ...applyReceipt,
        journal: {
          ...applyReceipt.journal,
          unexpected: undefined,
        },
      },
    ]) {
      expect(
        captureRollbackFailure(() =>
          createWorkspaceSearchMigrationRollbackOperationCommandIdentity({
            startRoot,
            predecessorState: startRoot.initialState,
            applyReceipt: markerWithUndefined,
          })
        ).code,
      ).toBe('INVALID_ROLLBACK_PERSISTENCE')
    }
  })

  test('rejects forward evidence outside causal chronology', () => {
    const fixture = createFixture(2)
    const startRoot = createStartRoot(fixture)
    const secondApplyReceipt = requireArrayEntry(
      fixture.applyReceipts,
      1,
    )
    expect(
      captureRollbackFailure(() =>
        createWorkspaceSearchMigrationRollbackOperationTransition({
          startRoot,
          predecessorState: startRoot.initialState,
          currentAuthority: advanceAuthority(
            fixture.currentAuthority,
            secondRollbackAt,
          ),
          applyReceipt: {
            ...secondApplyReceipt,
            committedAt: '2026-07-29T01:10:20.001Z',
          },
          journalSegment: requireArrayEntry(
            fixture.journalSegments,
            1,
          ),
          committedAt: secondRollbackAt,
        })
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const reversedChronologyFixture = createFixture(2, {
      secondJournalCreatedAt: '2026-07-29T01:10:04.001Z',
      secondApplyCommittedAt: '2026-07-29T01:10:04.000Z',
    })
    const reversedStartRoot = createStartRoot(
      reversedChronologyFixture,
    )
    expect(
      captureRollbackFailure(() =>
        createWorkspaceSearchMigrationRollbackOperationTransition({
          startRoot: reversedStartRoot,
          predecessorState: reversedStartRoot.initialState,
          currentAuthority: advanceAuthority(
            reversedChronologyFixture.currentAuthority,
            secondRollbackAt,
          ),
          applyReceipt: requireArrayEntry(
            reversedChronologyFixture.applyReceipts,
            1,
          ),
          journalSegment: requireArrayEntry(
            reversedChronologyFixture.journalSegments,
            1,
          ),
          committedAt: secondRollbackAt,
        })
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')
  })

  test('rejects self-rehashed terminal roots with time travel', () => {
    const fixture = createFixture(2)
    const startRoot = createStartRoot(fixture)
    const second =
      createWorkspaceSearchMigrationRollbackOperationTransition({
        startRoot,
        predecessorState: startRoot.initialState,
        currentAuthority: advanceAuthority(
          fixture.currentAuthority,
          secondRollbackAt,
        ),
        applyReceipt: requireArrayEntry(fixture.applyReceipts, 1),
        journalSegment: requireArrayEntry(
          fixture.journalSegments,
          1,
        ),
        committedAt: secondRollbackAt,
      })
    const first =
      createWorkspaceSearchMigrationRollbackOperationTransition({
        startRoot,
        predecessorState: second.state,
        currentAuthority: advanceAuthority(
          fixture.currentAuthority,
          firstRollbackAt,
        ),
        applyReceipt: requireArrayEntry(fixture.applyReceipts, 0),
        journalSegment: requireArrayEntry(
          fixture.journalSegments,
          0,
        ),
        committedAt: firstRollbackAt,
      })
    const terminal = finishWorkspaceSearchMigrationRollback({
      startRoot,
      predecessorState: first.state,
      currentAuthority: advanceAuthority(
        fixture.currentAuthority,
        finishedAt,
      ),
      terminalReceipt: first.receipt,
      finishedAt,
    })
    const beforeReceipt = rehashRolledBackRootAt(
      terminal.root,
      '2026-07-29T01:10:39.999Z',
    )
    expect(
      captureRollbackFailure(() =>
        parseWorkspaceSearchMigrationRolledBackRoot(
          encodeCanonicalValue(beforeReceipt),
        )
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const applyAfterStart =
      rehashRolledBackRootTerminalApplyReceiptAt(
        terminal.root,
        '2026-07-29T01:10:20.001Z',
      )
    expect(
      captureRollbackFailure(() =>
        parseWorkspaceSearchMigrationRolledBackRoot(
          encodeCanonicalValue(applyAfterStart),
        )
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const receiptBeforeStart =
      rehashRolledBackRootTerminalReceiptAt(
        terminal.root,
        '2026-07-29T01:10:19.999Z',
      )
    expect(
      captureRollbackFailure(() =>
        parseWorkspaceSearchMigrationRolledBackRoot(
          encodeCanonicalValue(receiptBeforeStart),
        )
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const substitutedReceiptRevision =
      rehashRolledBackRootTerminalReceiptRevision(terminal.root)
    expect(
      captureRollbackFailure(() =>
        parseWorkspaceSearchMigrationRolledBackRoot(
          encodeCanonicalValue(substitutedReceiptRevision),
        )
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const substitutedPreviousHead =
      rehashRolledBackRootTerminalReceiptPreviousHead(
        terminal.root,
        digest('substituted-terminal-previous-head'),
      )
    expect(
      captureRollbackFailure(() =>
        parseWorkspaceSearchMigrationRolledBackRoot(
          encodeCanonicalValue(substitutedPreviousHead),
        )
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const zeroFixture = createFixture(0)
    const zeroStartRoot = createStartRoot(zeroFixture)
    const zeroTerminal = finishWorkspaceSearchMigrationRollback({
      startRoot: zeroStartRoot,
      predecessorState: zeroStartRoot.initialState,
      currentAuthority: advanceAuthority(
        zeroFixture.currentAuthority,
        finishedAt,
      ),
      terminalReceipt: null,
      finishedAt,
    })
    const beforeStart = rehashRolledBackRootAt(
      zeroTerminal.root,
      '2026-07-29T01:10:19.999Z',
    )
    expect(
      captureRollbackFailure(() =>
        parseWorkspaceSearchMigrationRolledBackRoot(
          encodeCanonicalValue(beforeStart),
        )
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')
  })

  test('rejects noncanonical, oversized, Proxy, and accessor input', () => {
    const fixture = createFixture(0)
    const root = createStartRoot(fixture)
    const canonical =
      serializeWorkspaceSearchMigrationRollbackStartRoot(root)
    const noncanonical = new TextEncoder().encode(
      `${new TextDecoder().decode(canonical)}\n`,
    )
    expect(
      captureRollbackFailure(() =>
        parseWorkspaceSearchMigrationRollbackStartRoot(noncanonical)
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')
    expect(
      captureRollbackFailure(() =>
        parseWorkspaceSearchMigrationRollbackPersistenceState(
          new Uint8Array(
            WORKSPACE_SEARCH_MIGRATION_ROLLBACK_STATE_MAX_BYTES + 1,
          ),
        )
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const proxied = new Proxy(root, {})
    expect(
      captureRollbackFailure(() =>
        serializeWorkspaceSearchMigrationRollbackStartRoot(proxied)
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const checkpointWithUndefinedCursor = {
      ...root.initialState,
      runState: {
        ...root.initialState.runState,
        apply: {
          ...root.initialState.runState.apply,
          sources: {
            ...root.initialState.runState.apply.sources,
            'project-directory': {
              ...root.initialState.runState.apply.sources[
                'project-directory'
              ],
              cursor: undefined,
            },
          },
        },
      },
    }
    expect(
      captureRollbackFailure(() =>
        Reflect.apply(
          serializeWorkspaceSearchMigrationRollbackPersistenceState,
          undefined,
          [checkpointWithUndefinedCursor],
        )
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    let accessorInvoked = false
    const accessorInput = {
      appliedRoot: fixture.appliedRoot,
      currentAuthority: fixture.currentAuthority,
      executionRun: fixture.executionRun,
      predecessorRunState: fixture.appliedState,
      sealedPlanningAuthority: fixture.sealedPlanningAuthority,
      get startedAt() {
        accessorInvoked = true
        return startAt
      },
    }
    expect(
      captureRollbackFailure(() =>
        createWorkspaceSearchMigrationRollbackStartRoot(accessorInput)
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')
    expect(accessorInvoked).toBeFalse()
  })

  test('bounds wide, aliased, and binary caller-owned graphs', () => {
    const fixture = createFixture(0)
    const wideRecord: Record<string, boolean> = {}
    for (let index = 0; index < 1_025; index += 1) {
      wideRecord[`field${index}`] = true
    }
    let sharedDag: unknown = { leaf: true }
    for (let depth = 0; depth < 40; depth += 1) {
      sharedDag = {
        left: sharedDag,
        right: sharedDag,
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

    for (const hostileGraph of [
      wideRecord,
      sharedDag,
      oversizedBinary,
      oversizedString,
      oversizedKeyRecord,
      aggregateOversizedText,
      aggregateOversizedBinary,
    ]) {
      const hostileExecutionRun = {
        ...fixture.executionRun,
        binding: {
          ...fixture.executionRun.binding,
          hostileGraph,
        },
      }
      expect(
        captureRollbackFailure(() =>
          Reflect.apply(
            createWorkspaceSearchMigrationRollbackStartRoot,
            undefined,
            [{
              executionRun: hostileExecutionRun,
              appliedRoot: fixture.appliedRoot,
              sealedPlanningAuthority:
                fixture.sealedPlanningAuthority,
              predecessorRunState: fixture.appliedState,
              currentAuthority: fixture.currentAuthority,
              startedAt: startAt,
            }],
          )
        ).code,
      ).toBe('INVALID_ROLLBACK_PERSISTENCE')
    }
  })

  test('rejects expired start and per-step exact-version windows', () => {
    const fixture = createFixture(2)
    const boundaryFixture =
      createRetentionBoundaryFixture(fixture)
    expect(
      createWorkspaceSearchMigrationRollbackStartRoot({
        executionRun: boundaryFixture.executionRun,
        appliedRoot: boundaryFixture.appliedRoot,
        sealedPlanningAuthority:
          boundaryFixture.sealedPlanningAuthority,
        predecessorRunState: boundaryFixture.appliedState,
        currentAuthority: boundaryFixture.currentAuthority,
        startedAt: '2026-08-30T00:59:49.999Z',
      }).initialState.nextSequence,
    ).toBe(2)
    expect(
      captureRollbackFailure(() =>
        createWorkspaceSearchMigrationRollbackStartRoot({
          executionRun: boundaryFixture.executionRun,
          appliedRoot: boundaryFixture.appliedRoot,
          sealedPlanningAuthority:
            boundaryFixture.sealedPlanningAuthority,
          predecessorRunState: boundaryFixture.appliedState,
          currentAuthority: boundaryFixture.currentAuthority,
          startedAt: '2026-08-30T00:59:50.000Z',
        })
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')

    const startRoot = createStartRoot(fixture)
    const applyReceipt = requireArrayEntry(fixture.applyReceipts, 1)
    const nearExpiryReceipt = {
      ...applyReceipt,
      journal: {
        ...applyReceipt.journal,
        retainUntil: '2026-07-29T01:10:39.999Z',
      },
    }
    expect(
      captureRollbackFailure(() =>
        createWorkspaceSearchMigrationRollbackOperationTransition({
          startRoot,
          predecessorState: startRoot.initialState,
          currentAuthority: advanceAuthority(
            fixture.currentAuthority,
            secondRollbackAt,
          ),
          applyReceipt: nearExpiryReceipt,
          journalSegment: requireArrayEntry(
            fixture.journalSegments,
            1,
          ),
          committedAt: secondRollbackAt,
        })
      ).code,
    ).toBe('INVALID_ROLLBACK_PERSISTENCE')
  })
})

/**
 * Creates one complete correlated zero- or two-mutation fixture.
 *
 * @param mutationCount - Supported number of forward mutations.
 * @param options - Optional forward-evidence chronology substitutions.
 * @returns Exact immutable roots, applied state, authority, and journals.
 */
function createFixture(
  mutationCount: 0 | 2,
  options: RollbackFixtureOptions = {},
): RollbackFixture {
  const configuration = createConfiguration()
  const configurationHash =
    createWorkspaceSearchConfigurationHash(configuration)
  const maintenanceReceipt = createMaintenanceReceipt()
  const planSeal = createPlanSeal(
    configurationHash,
    mutationCount,
  )
  const tableIds = createTableIds(configuration)
  const sealedPlanningAuthority = createSealedAuthority(
    configurationHash,
    tableIds,
    planSeal,
    createMigrationDigest(maintenanceReceipt),
  )
  const executionRun = createExecutionRun(
    configuration,
    configurationHash,
    planSeal,
    sealedPlanningAuthority,
    maintenanceReceipt,
  )
  const journal = mutationCount === 0
    ? { receipts: [], segments: [] }
    : createJournalChain(
      configurationHash,
      maintenanceReceipt,
      options,
    )
  const apply = createTerminalTraversal(mutationCount)
  const markerAccumulator = new MigrationDigestAccumulator()
  for (const receipt of journal.receipts) {
    markerAccumulator.add(createMigrationDigest(receipt))
  }
  const terminalApplyingState: WorkspaceSearchMigrationRunState = {
    ...executionRun.runState,
    revision: 1 + mutationCount + 5,
    appliedOperationCount: mutationCount,
    applyMarkerDigestState: markerAccumulator.exportState(),
    journalSequence: mutationCount,
    journalHeadDigest: mutationCount === 0
      ? zeroHexDigest()
      : requireArrayEntry(journal.receipts, 1).journal.headDigest,
    apply,
    updatedAt: '2026-07-29T01:10:07.000Z',
  }
  validateWorkspaceSearchMigrationRunState(terminalApplyingState)
  const seal = createCompleteApplySeal(
    executionRun,
    sealedPlanningAuthority,
    terminalApplyingState,
    markerAccumulator,
    mutationCount,
  )
  const sealReference = createCompleteSealReference(seal)
  const appliedState: WorkspaceSearchMigrationRunState = {
    ...terminalApplyingState,
    revision: terminalApplyingState.revision + 1,
    status: 'applied',
    applySeal: {
      scope: 'complete-plan',
      objectKey: sealReference.objectKey,
      versionId: sealReference.versionId,
      contentDigest: sealReference.contentDigest,
    },
    updatedAt: appliedAt,
  }
  validateWorkspaceSearchMigrationRunState(appliedState)
  const appliedRoot = createAppliedRoot(
    executionRun,
    seal,
    sealReference,
    appliedState,
    mutationCount,
  )
  return {
    executionRun,
    sealedPlanningAuthority,
    appliedRoot,
    appliedState,
    currentAuthority: createCurrentAuthority(
      configuration,
      configurationHash,
      maintenanceReceipt,
    ),
    applyReceipts: journal.receipts,
    journalSegments: journal.segments,
  }
}

/**
 * Creates one immutable rollback start root from a fixture.
 *
 * @param fixture - Complete correlated rollback fixture.
 * @returns Exact immutable rollback-start root.
 */
function createStartRoot(
  fixture: RollbackFixture,
): WorkspaceSearchMigrationRollbackStartRoot {
  return createWorkspaceSearchMigrationRollbackStartRoot({
    executionRun: fixture.executionRun,
    appliedRoot: fixture.appliedRoot,
    sealedPlanningAuthority: fixture.sealedPlanningAuthority,
    predecessorRunState: fixture.appliedState,
    currentAuthority: fixture.currentAuthority,
    startedAt: startAt,
  })
}

/**
 * Creates one strict plan seal for the selected mutation count.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param mutationCount - Zero or two forward mutations.
 * @returns Exact canonical plan seal.
 */
function createPlanSeal(
  configurationHash: string,
  mutationCount: 0 | 2,
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
    planDigest: mutationCount === 0
      ? createEmptyWorkspaceSearchPlanDigest()
      : digest('two-operation-plan'),
    planOperationCount: mutationCount,
    sourceOperationCount: mutationCount,
    orphanOperationCount: 0,
    createdAt: '2026-07-29T00:55:00.000Z',
  }
}

/**
 * Creates one strict immutable execution admission.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param planSeal - Exact canonical plan seal.
 * @param sealedAuthority - Exact immutable planning authority.
 * @param maintenanceReceipt - Exact current maintenance receipt.
 * @returns Detached strict execution run.
 */
function createExecutionRun(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  planSeal: WorkspaceSearchPlanSeal,
  sealedAuthority: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  maintenanceReceipt: WorkspaceSearchMaintenanceEvidenceReceipt,
): WorkspaceSearchMigrationExecutionRun {
  const planSealReference = sealedAuthority.planSealReference
  const lease = {
    runId,
    ownerId,
    fenceToken: 7,
    heartbeatAt: '2026-07-29T01:09:30.000Z',
    expiresAt: '2026-07-29T01:10:30.000Z',
  }
  const runState = createWorkspaceSearchMigrationRunState({
    runId,
    lease,
    ownerId,
    configurationHash,
    configuration,
    maintenanceEvidenceReceipt: maintenanceReceipt,
    dryRunEvidenceDigest: planSeal.dryRunEvidenceDigest,
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSeal,
    planSealReference: {
      objectKey: planSealReference.objectKey,
      versionId: planSealReference.versionId,
      contentDigest: planSealReference.contentDigest,
    },
    createdAt,
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
    sealedPlanningAuthorityDigest: sealedAuthority.authorityDigest,
    planDigest: planSeal.planDigest,
    planOperationCount: planSeal.planOperationCount,
    planSealReference,
    currentAuthority: {
      ownerId,
      fenceToken: lease.fenceToken,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(maintenanceReceipt),
      evaluatedAt: createdAt,
    },
    planningAdmittedAt: '2026-07-29T00:58:00.000Z',
    sealedAt: sealedAuthority.sealedAt,
    createdAt,
  } satisfies Omit<
    WorkspaceSearchMigrationExecutionRunBinding,
    'bindingDigest'
  >
  const binding: WorkspaceSearchMigrationExecutionRunBinding = {
    ...bindingFields,
    bindingDigest: createMigrationDigest(bindingFields),
  }
  const envelopeFields = {
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
  return parseWorkspaceSearchMigrationExecutionRun(
    serializeWorkspaceSearchMigrationExecutionRun({
      ...envelopeFields,
      executionRunDigest: createMigrationDigest(envelopeFields),
    }),
  )
}

/**
 * Creates one strict compact version-two sealed planning authority.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param tableIds - All six exact physical table incarnations.
 * @param planSeal - Exact canonical plan seal.
 * @param receiptDigest - Exact current maintenance receipt digest.
 * @returns Detached strict version-two planning authority.
 */
function createSealedAuthority(
  configurationHash: string,
  tableIds: WorkspaceSearchMigrationSealedPlanningTableIds,
  planSeal: WorkspaceSearchPlanSeal,
  receiptDigest: string,
): WorkspaceSearchMigrationSealedPlanningAuthorityV2 {
  const planSealBytes = serializeWorkspaceSearchPlanSeal(planSeal)
  const planSealDigest = digestBytes(planSealBytes)
  const planManifestDigest = digest('plan-manifest')
  const provenanceManifestDigest = digest('provenance-manifest')
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
      versionId: 'plan-seal-version',
      contentDigest: planSealDigest,
      byteLength: planSealBytes.byteLength,
      retainUntil,
    },
    planManifestHeadReference: {
      objectKey:
        `${WORKSPACE_SEARCH_MIGRATION_PLAN_ARTIFACT_OBJECT_KEY_PREFIX}/manifest-heads/${planManifestDigest}.artifact`,
      versionId: 'plan-manifest-version',
      contentDigest: planManifestDigest,
      byteLength: 1,
      retainUntil,
    },
    planningProvenanceManifestHeadReference: {
      objectKey:
        `workspace-search/v1/planning-provenance-artifacts/v1/` +
        `${runId}/${configurationHash}/manifest-heads/` +
        `${provenanceManifestDigest}.artifact`,
      versionId: 'provenance-manifest-version',
      contentDigest: provenanceManifestDigest,
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
      digest('historical-receipt-binding'),
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
      maintenanceEvidenceReceiptDigest: receiptDigest,
    },
    sealedAt: '2026-07-29T00:59:00.000Z',
  } satisfies Omit<
    WorkspaceSearchMigrationSealedPlanningAuthorityV2,
    'authorityDigest'
  >
  return parseWorkspaceSearchMigrationSealedPlanningAuthorityV2(
    serializeWorkspaceSearchMigrationSealedPlanningAuthorityV2({
      ...fields,
      authorityDigest: createMigrationDigest(fields),
    }),
  )
}

/**
 * Creates one compact terminal evidence head.
 *
 * @param chain - Canonical evidence-chain role.
 * @returns Exact terminal evidence head.
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
 * Creates the exact fresh authority used by rollback transactions.
 *
 * @param configuration - Exact measured configuration.
 * @param configurationHash - Reviewed configuration digest.
 * @param receipt - Exact current maintenance receipt.
 * @returns Exact fresh current authority.
 */
function createCurrentAuthority(
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
): WorkspaceSearchMigrationPrePlanAuthority {
  return {
    configurationHash,
    stateTableId:
      configuration.tables['migration-state'].tableId,
    lease: {
      runId,
      ownerId,
      fenceToken: 7,
      heartbeatAt: '2026-07-29T01:09:50.000Z',
      expiresAt: '2026-07-29T01:10:50.000Z',
    },
    maintenanceEvidenceReceiptDigest:
      createMigrationDigest(receipt),
    maintenanceEvidencePointerRevision: 12,
    maintenanceEvidenceReceipt: receipt,
    evaluatedAt: '2026-07-29T01:10:19.000Z',
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
 * Creates one fresh exact-window maintenance receipt.
 *
 * @returns Exact maintenance receipt bound to fence seven.
 */
function createMaintenanceReceipt():
  WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId,
    evidenceDigest: digest('maintenance-evidence'),
    evidenceLocator:
      'workspace-search/v1/maintenance/current.json',
    runtimeRevision: 41,
    fenceToken: 7,
    validatedAt: '2026-07-29T01:10:00.000Z',
    oldestObservationAt: '2026-07-29T01:09:00.000Z',
    validUntil: '2026-07-29T01:14:00.001Z',
  }
}

/**
 * Creates two exact forward journal links and durable apply receipts.
 *
 * @param configurationHash - Reviewed configuration digest.
 * @param maintenanceReceipt - Exact current maintenance receipt.
 * @param options - Optional forward-evidence chronology substitutions.
 * @returns Two linked segments and forward receipts.
 */
function createJournalChain(
  configurationHash: string,
  maintenanceReceipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  options: RollbackFixtureOptions,
): {
  /** Forward receipts in increasing sequence order. */
  readonly receipts: readonly WorkspaceSearchOperationReceipt[]
  /** Journal segments in increasing sequence order. */
  readonly segments: readonly WorkspaceSearchJournalSegment[]
} {
  const first = createJournalLink({
    configurationHash,
    maintenanceReceipt,
    sequence: 1,
    previousHeadDigest: zeroHexDigest(),
    entityId: 'document-1',
  })
  const second = createJournalLink({
    configurationHash,
    maintenanceReceipt,
    sequence: 2,
    previousHeadDigest: first.receipt.journal.headDigest,
    entityId: 'document-2',
    createdAt: options.secondJournalCreatedAt,
    committedAt: options.secondApplyCommittedAt,
  })
  return {
    receipts: [first.receipt, second.receipt],
    segments: [first.segment, second.segment],
  }
}

/**
 * Exact inputs used to build one immutable forward journal link.
 */
type CreateJournalLinkInput = {
  /** Reviewed configuration digest. */
  readonly configurationHash: string
  /** Exact current maintenance receipt. */
  readonly maintenanceReceipt:
    WorkspaceSearchMaintenanceEvidenceReceipt
  /** Positive forward journal sequence. */
  readonly sequence: number
  /** Exact predecessor journal head. */
  readonly previousHeadDigest: string
  /** Stable target entity identifier. */
  readonly entityId: string
  /** Optional replacement journal creation time. */
  readonly createdAt?: string
  /** Optional replacement forward apply commit time. */
  readonly committedAt?: string
}

/**
 * Creates one exact forward journal segment and matching durable receipt.
 *
 * @param input - Sequence, predecessor head, entity, and authority.
 * @returns Exact immutable segment and forward receipt.
 */
function createJournalLink(
  input: CreateJournalLinkInput,
): {
  /** Exact immutable journal segment. */
  readonly segment: WorkspaceSearchJournalSegment
  /** Exact durable forward apply receipt. */
  readonly receipt: WorkspaceSearchOperationReceipt
} {
  const recordKey = createWorkspaceSearchDocumentRecordKey(
    'document',
    input.entityId,
  )
  const targetKey = {
    workspaceId: { S: 'workspace-1' },
    recordKey: { S: recordKey },
  }
  const afterItem = {
    ...targetKey,
    entryType: { S: 'search-document' },
    entityType: { S: 'document' },
    entityId: { S: input.entityId },
    title: { S: `Title ${input.entityId}` },
  }
  const targetKeyDigest = createAttributeMapDigest(targetKey)
  const beforeDigest = createAbsentMigrationItemDigest()
  const afterDigest = createAttributeMapDigest(afterItem)
  const operationId = digest(`operation-${input.sequence}`)
  const segment: WorkspaceSearchJournalSegment = {
    kind: 'workspace-search-preimage-segment',
    segmentVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    runId,
    configurationHash: input.configurationHash,
    sequence: input.sequence,
    preparedFenceToken: 7,
    operationId,
    previousHeadDigest: input.previousHeadDigest,
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
    createdAt: input.createdAt ??
      `2026-07-29T01:10:0${input.sequence}.000Z`,
  }
  const segmentText = serializeWorkspaceSearchJournalSegment(segment)
  const contentDigest = digestText(segmentText)
  const versionId = `journal-version-${input.sequence}`
  const journal: WorkspaceSearchJournalReference = {
    objectKey:
      `workspace-search/v1/runs/${runId}/segments/` +
      `${String(input.sequence).padStart(12, '0')}.json`,
    versionId,
    contentDigest,
    byteLength: new TextEncoder().encode(segmentText).byteLength,
    retainUntil,
    headDigest: createJournalHeadDigest({
      previousHeadDigest: input.previousHeadDigest,
      sequence: input.sequence,
      operationId,
      contentDigest,
      versionId,
    }),
  }
  return {
    segment,
    receipt: {
      kind: 'workspace-search-operation-applied',
      markerVersion: 1,
      runId,
      configurationHash: input.configurationHash,
      operationId,
      planSequence: input.sequence,
      planOperationDigest:
        digest(`plan-operation-${input.sequence}`),
      sequence: input.sequence,
      targetKeyDigest,
      beforeDigest,
      afterDigest,
      fenceToken: 7,
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(input.maintenanceReceipt),
      journal,
      committedAt: input.committedAt ??
        `2026-07-29T01:10:0${input.sequence + 2}.000Z`,
    },
  }
}

/**
 * Creates one strict complete production apply seal.
 *
 * @param executionRun - Exact immutable execution admission.
 * @param sealedAuthority - Exact immutable planning authority.
 * @param predecessor - Exact terminal applying state.
 * @param markerAccumulator - Exact aggregate of durable apply receipts.
 * @param mutationCount - Zero or two forward mutations.
 * @returns Exact strict complete apply seal.
 */
function createCompleteApplySeal(
  executionRun: WorkspaceSearchMigrationExecutionRun,
  sealedAuthority: WorkspaceSearchMigrationSealedPlanningAuthorityV2,
  predecessor: WorkspaceSearchMigrationRunState,
  markerAccumulator: MigrationDigestAccumulator,
  mutationCount: 0 | 2,
): WorkspaceSearchMigrationCompleteApplySeal {
  const fields = {
    kind: 'workspace-search-migration-complete-apply-seal',
    sealVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    scope: 'complete-plan',
    runId,
    configurationHash: executionRun.configurationHash,
    executionRunDigest: executionRun.executionRunDigest,
    executionRunBindingDigest: executionRun.binding.bindingDigest,
    sealedPlanningAuthorityDigest: sealedAuthority.authorityDigest,
    tableIds: executionRun.binding.tableIds,
    planSealReference: executionRun.binding.planSealReference,
    planDigest: predecessor.planDigest,
    sourceOperationCount: mutationCount,
    orphanOperationCount: 0,
    planOperationCount: mutationCount,
    predecessorRevision: predecessor.revision,
    predecessorExecutionStateDigest:
      digest('terminal-execution-state'),
    predecessorRunStateDigest: createMigrationDigest(predecessor),
    markerCount: mutationCount,
    applyMarkerDigestState: markerAccumulator.exportState(),
    applyMarkerAggregateDigest: markerAccumulator.digest(),
    journalSequence: mutationCount,
    journalHeadDigest: predecessor.journalHeadDigest,
    ...(mutationCount === 0
      ? {}
      : { minimumJournalRetainUntil: retainUntil }),
    apply: predecessor.apply,
    applyTraversalDigest: createMigrationDigest(predecessor.apply),
    createdAt: '2026-07-29T01:10:08.000Z',
  } satisfies Omit<
    WorkspaceSearchMigrationCompleteApplySeal,
    'sealDigest'
  >
  return {
    ...fields,
    sealDigest: createMigrationDigest(fields),
  }
}

/**
 * Creates the exact immutable object reference for a complete apply seal.
 *
 * @param seal - Exact strict complete apply seal.
 * @returns Exact rich immutable seal reference.
 */
function createCompleteSealReference(
  seal: WorkspaceSearchMigrationCompleteApplySeal,
): WorkspaceSearchMigrationCompleteApplySealReference {
  const bytes =
    serializeWorkspaceSearchMigrationCompleteApplySeal(seal)
  return {
    scope: 'complete-plan',
    objectKey:
      `workspace-search/v1/apply-seals/${digestBytes(bytes)}.artifact`,
    versionId: 'apply-seal-version',
    contentDigest: createMigrationDigest(seal),
    byteLength: bytes.byteLength,
    retainUntil,
  }
}

/**
 * Creates one strict immutable applied phase root.
 *
 * @param executionRun - Exact immutable execution admission.
 * @param seal - Exact complete apply seal.
 * @param sealReference - Exact immutable seal reference.
 * @param appliedState - Exact applied pure successor state.
 * @param mutationCount - Zero or two forward mutations.
 * @returns Detached strict applied root.
 */
function createAppliedRoot(
  executionRun: WorkspaceSearchMigrationExecutionRun,
  seal: WorkspaceSearchMigrationCompleteApplySeal,
  sealReference:
    WorkspaceSearchMigrationCompleteApplySealReference,
  appliedState: WorkspaceSearchMigrationRunState,
  mutationCount: 0 | 2,
): WorkspaceSearchMigrationAppliedRoot {
  const fields = {
    kind: 'workspace-search-migration-applied-root',
    rootVersion: 1,
    migrationId: WORKSPACE_SEARCH_MIGRATION_ID,
    migrationVersion: WORKSPACE_SEARCH_MIGRATION_VERSION,
    stateTableId:
      executionRun.binding.tableIds['migration-state'],
    configurationHash: executionRun.configurationHash,
    runId,
    executionRunDigest: executionRun.executionRunDigest,
    predecessorRevision: seal.predecessorRevision,
    predecessorExecutionStateDigest:
      seal.predecessorExecutionStateDigest,
    predecessorRunStateDigest: seal.predecessorRunStateDigest,
    seal,
    sealReference,
    authority: {
      ownerId,
      fenceToken: 7,
      maintenanceEvidencePointerRevision: 12,
      maintenanceEvidenceReceiptDigest:
        executionRun.binding.currentAuthority
          .maintenanceEvidenceReceiptDigest,
      evaluatedAt: '2026-07-29T01:10:09.000Z',
    },
    ...(mutationCount === 0
      ? {}
      : { minimumJournalRetainUntil: retainUntil }),
    successorRevision: appliedState.revision,
    status: 'applied',
    successorRunStateDigest: createMigrationDigest(appliedState),
    committedAt: appliedAt,
  } satisfies Omit<
    WorkspaceSearchMigrationAppliedRoot,
    'rootDigest'
  >
  return parseWorkspaceSearchMigrationAppliedRoot(
    serializeWorkspaceSearchMigrationAppliedRoot({
      ...fields,
      rootDigest: createMigrationDigest(fields),
    }),
  )
}

/**
 * Creates one complete cursor-free apply traversal.
 *
 * @param mutationCount - Zero or two mapped source/target rows.
 * @returns Exact terminal traversal.
 */
function createTerminalTraversal(
  mutationCount: 0 | 2,
): WorkspaceSearchMigrationTraversalProgress {
  return {
    sources: {
      'project-directory':
        createTerminalCheckpoint(mutationCount),
      'work-items': createTerminalCheckpoint(0),
      collaboration: createTerminalCheckpoint(0),
      documents: createTerminalCheckpoint(0),
    },
    target: createTerminalCheckpoint(mutationCount),
  }
}

/**
 * Creates one cursor-free completed checkpoint with consistent accumulators.
 *
 * @param mapped - Zero or two mapped rows represented by the checkpoint.
 * @returns Exact terminal checkpoint.
 */
function createTerminalCheckpoint(
  mapped: 0 | 2,
): MigrationSourceCheckpoint {
  const keyAccumulator = new MigrationDigestAccumulator()
  const contentAccumulator = new MigrationDigestAccumulator()
  for (let index = 0; index < mapped; index += 1) {
    keyAccumulator.add(digest(`checkpoint-key-${index}`))
    contentAccumulator.add(digest(`checkpoint-content-${index}`))
  }
  return {
    completed: true,
    aggregate: {
      scanned: mapped,
      mapped,
      ignored: 0,
      invalid: 0,
      projected: mapped,
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
 * Rebinds one otherwise valid mutable state to a different start root.
 *
 * @param state - Exact canonical rollback persistence state.
 * @param replacement - Digest of a substituted immutable start root.
 * @returns Standalone-valid re-digested state for cross-root rejection.
 */
function replaceRollbackStateStartRootDigest(
  state: WorkspaceSearchMigrationRollbackPersistenceState,
  replacement: string,
): WorkspaceSearchMigrationRollbackPersistenceState {
  const fields = {
    kind: state.kind,
    persistenceVersion: state.persistenceVersion,
    migrationId: state.migrationId,
    migrationVersion: state.migrationVersion,
    runId: state.runId,
    configurationHash: state.configurationHash,
    tableIds: state.tableIds,
    executionRunDigest: state.executionRunDigest,
    appliedRootDigest: state.appliedRootDigest,
    sealedPlanningAuthorityDigest:
      state.sealedPlanningAuthorityDigest,
    startRootDigest: replacement,
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
    runState: state.runState,
    runStateDigest: state.runStateDigest,
  } satisfies Omit<
    WorkspaceSearchMigrationRollbackPersistenceState,
    'stateDigest'
  >
  return {
    ...fields,
    stateDigest: createMigrationDigest(fields),
  }
}

/**
 * Re-digests a durable receipt after substituting its predecessor journal head.
 *
 * @param receipt - Exact immutable reverse-operation receipt.
 * @param replacement - Substituted predecessor journal head digest.
 * @returns Self-digest-consistent receipt with an invalid chain relation.
 */
function replaceRollbackReceiptPreviousHeadDigest(
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
  replacement: string,
): WorkspaceSearchMigrationRollbackOperationReceipt {
  const digestFields: Record<string, unknown> = {
    ...receipt,
    previousJournalHeadDigest: replacement,
  }
  if (!Reflect.deleteProperty(digestFields, 'receiptDigest')) {
    throw new Error('Expected a configurable receipt digest field.')
  }
  return {
    ...receipt,
    previousJournalHeadDigest: replacement,
    receiptDigest: createMigrationDigest(digestFields),
  }
}

/**
 * Exact fields used to rebuild one standalone-valid rollback state.
 */
type RehashRollbackStateInput = {
  /** Existing strict state whose chain fields remain unchanged. */
  readonly state: WorkspaceSearchMigrationRollbackPersistenceState
  /** Optional replacement compact authority adopted by the state. */
  readonly currentAuthority?:
    WorkspaceSearchMigrationRollbackPersistenceState['currentAuthority']
  /** Replacement complete pure run state. */
  readonly runState: WorkspaceSearchMigrationRunState
  /** Replacement digest of the last pure rollback marker. */
  readonly lastRollbackReceiptDigest: string | null
}

/**
 * Recomputes every digest affected by selected rollback-state substitutions.
 *
 * @param input - Existing state, replacement pure state, and marker digest.
 * @returns Standalone-valid self-rehashed rollback state.
 */
function rehashRollbackState(
  input: RehashRollbackStateInput,
): WorkspaceSearchMigrationRollbackPersistenceState {
  const {
    stateDigest: previousStateDigest,
    ...previousFields
  } = input.state
  void previousStateDigest
  const fields = {
    ...previousFields,
    currentAuthority:
      input.currentAuthority ?? previousFields.currentAuthority,
    lastRollbackReceiptDigest:
      input.lastRollbackReceiptDigest,
    runState: input.runState,
    runStateDigest: createMigrationDigest(input.runState),
  }
  return {
    ...fields,
    stateDigest: createMigrationDigest(fields),
  }
}

/**
 * Exact fields used to rebuild one standalone-valid reverse receipt.
 */
type RehashRollbackOperationReceiptInput = {
  /** Existing strict durable reverse receipt. */
  readonly receipt: WorkspaceSearchMigrationRollbackOperationReceipt
  /** Optional replacement compact authority consumed by the receipt. */
  readonly currentAuthority?:
    WorkspaceSearchMigrationRollbackOperationReceipt['currentAuthority']
  /** Replacement pure rollback marker. */
  readonly rollbackReceipt:
    WorkspaceSearchMigrationRollbackOperationReceipt['rollbackReceipt']
  /** Digest of the replacement durable successor state. */
  readonly successorStateDigest: string
}

/**
 * Recomputes every receipt digest affected by marker or successor changes.
 *
 * @param input - Existing receipt, replacement marker, and successor digest.
 * @returns Standalone-valid self-rehashed durable reverse receipt.
 */
function rehashRollbackOperationReceipt(
  input: RehashRollbackOperationReceiptInput,
): WorkspaceSearchMigrationRollbackOperationReceipt {
  const {
    receiptDigest: previousReceiptDigest,
    ...previousFields
  } = input.receipt
  void previousReceiptDigest
  const fields = {
    ...previousFields,
    currentAuthority:
      input.currentAuthority ?? previousFields.currentAuthority,
    rollbackReceipt: input.rollbackReceipt,
    rollbackReceiptDigest:
      createMigrationDigest(input.rollbackReceipt),
    successorStateDigest: input.successorStateDigest,
  }
  return {
    ...fields,
    receiptDigest: createMigrationDigest(fields),
  }
}

/**
 * Rebuilds a terminal root whose state and authority share a replacement time.
 *
 * @param root - Existing strict terminal root.
 * @param replacement - Canonical replacement terminal time.
 * @returns Self-rehashed terminal root for chronology rejection tests.
 */
function rehashRolledBackRootAt(
  root: WorkspaceSearchMigrationRolledBackRoot,
  replacement: string,
): WorkspaceSearchMigrationRolledBackRoot {
  const runState = {
    ...root.terminalState.runState,
    updatedAt: replacement,
  }
  validateWorkspaceSearchMigrationRunState(runState)
  const terminalState = rehashRollbackState({
    state: root.terminalState,
    runState,
    lastRollbackReceiptDigest:
      root.terminalState.lastRollbackReceiptDigest,
  })
  const {
    rootDigest: previousRootDigest,
    ...previousFields
  } = root
  void previousRootDigest
  const fields = {
    ...previousFields,
    terminalState,
    terminalStateDigest: terminalState.stateDigest,
    finalRunStateDigest: terminalState.runStateDigest,
    finalAuthority: {
      ...root.finalAuthority,
      evaluatedAt: replacement,
    },
    finishedAt: replacement,
  }
  return {
    ...fields,
    rootDigest: createMigrationDigest(fields),
  }
}

/**
 * Moves a terminal receipt before rollback start while preserving its digests.
 *
 * @param root - Existing nonzero-mutation terminal root.
 * @param replacement - Canonical replacement receipt time.
 * @returns Self-rehashed root with a self-consistent backdated receipt.
 */
function rehashRolledBackRootTerminalReceiptAt(
  root: WorkspaceSearchMigrationRolledBackRoot,
  replacement: string,
): WorkspaceSearchMigrationRolledBackRoot {
  const previousReceipt = root.terminalReceipt
  if (previousReceipt === null) {
    throw new Error('Expected a nonzero-mutation terminal receipt.')
  }
  const rollbackReceipt = {
    ...previousReceipt.rollbackReceipt,
    rolledBackAt: replacement,
  }
  const rollbackReceiptDigest =
    createMigrationDigest(rollbackReceipt)
  const {
    receiptDigest: previousReceiptDigest,
    ...previousReceiptFields
  } = previousReceipt
  void previousReceiptDigest
  const receiptFields = {
    ...previousReceiptFields,
    rollbackReceipt,
    rollbackReceiptDigest,
    committedAt: replacement,
  }
  const receipt = {
    ...receiptFields,
    receiptDigest: createMigrationDigest(receiptFields),
  }
  const terminalState = rehashRollbackState({
    state: root.terminalState,
    runState: root.terminalState.runState,
    lastRollbackReceiptDigest: rollbackReceiptDigest,
  })
  return rehashRolledBackRootWithTerminalReceipt(
    root,
    terminalState,
    receipt,
  )
}

/**
 * Substitutes a standalone-valid terminal receipt revision pair.
 *
 * @param root - Existing nonzero-mutation terminal root.
 * @returns Self-rehashed root whose receipt is not the terminal predecessor.
 */
function rehashRolledBackRootTerminalReceiptRevision(
  root: WorkspaceSearchMigrationRolledBackRoot,
): WorkspaceSearchMigrationRolledBackRoot {
  const previousReceipt = root.terminalReceipt
  if (previousReceipt === null) {
    throw new Error('Expected a nonzero-mutation terminal receipt.')
  }
  const {
    receiptDigest: previousReceiptDigest,
    ...previousReceiptFields
  } = previousReceipt
  void previousReceiptDigest
  const receiptFields = {
    ...previousReceiptFields,
    predecessorRevision: previousReceipt.predecessorRevision + 1,
    successorRevision: previousReceipt.successorRevision + 1,
  }
  const receipt = {
    ...receiptFields,
    receiptDigest: createMigrationDigest(receiptFields),
  }
  return rehashRolledBackRootWithTerminalReceipt(
    root,
    root.terminalState,
    receipt,
  )
}

/**
 * Moves the terminal receipt's nested apply marker after rollback start.
 *
 * @param root - Existing nonzero-mutation terminal root.
 * @param replacement - Canonical replacement forward commit time.
 * @returns Self-rehashed root with a causally late apply marker.
 */
function rehashRolledBackRootTerminalApplyReceiptAt(
  root: WorkspaceSearchMigrationRolledBackRoot,
  replacement: string,
): WorkspaceSearchMigrationRolledBackRoot {
  const previousReceipt = root.terminalReceipt
  if (previousReceipt === null) {
    throw new Error('Expected a nonzero-mutation terminal receipt.')
  }
  const applyReceipt = {
    ...previousReceipt.applyReceipt,
    committedAt: replacement,
  }
  const applyReceiptDigest = createMigrationDigest(applyReceipt)
  const rollbackReceipt = {
    ...previousReceipt.rollbackReceipt,
    applyReceiptDigest,
  }
  const rollbackReceiptDigest =
    createMigrationDigest(rollbackReceipt)
  const {
    receiptDigest: previousReceiptDigest,
    ...previousReceiptFields
  } = previousReceipt
  void previousReceiptDigest
  const receiptFields = {
    ...previousReceiptFields,
    applyReceipt,
    applyReceiptDigest,
    rollbackReceipt,
    rollbackReceiptDigest,
  }
  const receipt = {
    ...receiptFields,
    receiptDigest: createMigrationDigest(receiptFields),
  }
  const terminalState = rehashRollbackState({
    state: root.terminalState,
    runState: root.terminalState.runState,
    lastRollbackReceiptDigest: rollbackReceiptDigest,
  })
  return rehashRolledBackRootWithTerminalReceipt(
    root,
    terminalState,
    receipt,
  )
}

/**
 * Substitutes the terminal receipt's predecessor journal head consistently.
 *
 * @param root - Existing nonzero-mutation terminal root.
 * @param replacement - Nonzero substituted predecessor head.
 * @returns Self-rehashed root whose sequence-one receipt does not reach zero.
 */
function rehashRolledBackRootTerminalReceiptPreviousHead(
  root: WorkspaceSearchMigrationRolledBackRoot,
  replacement: string,
): WorkspaceSearchMigrationRolledBackRoot {
  const previousReceipt = root.terminalReceipt
  if (previousReceipt === null) {
    throw new Error('Expected a nonzero-mutation terminal receipt.')
  }
  const previousApplyReceipt = previousReceipt.applyReceipt
  const journal = {
    ...previousApplyReceipt.journal,
    headDigest: createJournalHeadDigest({
      previousHeadDigest: replacement,
      sequence: previousApplyReceipt.sequence,
      operationId: previousApplyReceipt.operationId,
      contentDigest: previousApplyReceipt.journal.contentDigest,
      versionId: previousApplyReceipt.journal.versionId,
    }),
  }
  const applyReceipt = {
    ...previousApplyReceipt,
    journal,
  }
  const applyReceiptDigest = createMigrationDigest(applyReceipt)
  const rollbackReceipt = {
    ...previousReceipt.rollbackReceipt,
    applyReceiptDigest,
    journalHeadDigest: journal.headDigest,
  }
  const rollbackReceiptDigest =
    createMigrationDigest(rollbackReceipt)
  const {
    receiptDigest: previousReceiptDigest,
    ...previousReceiptFields
  } = previousReceipt
  void previousReceiptDigest
  const receiptFields = {
    ...previousReceiptFields,
    applyReceipt,
    applyReceiptDigest,
    journalReferenceDigest: createMigrationDigest(journal),
    previousJournalHeadDigest: replacement,
    rollbackReceipt,
    rollbackReceiptDigest,
  }
  const receipt = {
    ...receiptFields,
    receiptDigest: createMigrationDigest(receiptFields),
  }
  const terminalState = rehashRollbackState({
    state: root.terminalState,
    runState: root.terminalState.runState,
    lastRollbackReceiptDigest: rollbackReceiptDigest,
  })
  return rehashRolledBackRootWithTerminalReceipt(
    root,
    terminalState,
    receipt,
  )
}

/**
 * Recomputes one root around a replacement terminal state and receipt.
 *
 * @param root - Existing strict terminal root.
 * @param terminalState - Replacement terminal persistence state.
 * @param receipt - Replacement final reverse receipt.
 * @returns Self-rehashed terminal root.
 */
function rehashRolledBackRootWithTerminalReceipt(
  root: WorkspaceSearchMigrationRolledBackRoot,
  terminalState: WorkspaceSearchMigrationRollbackPersistenceState,
  receipt: WorkspaceSearchMigrationRollbackOperationReceipt,
): WorkspaceSearchMigrationRolledBackRoot {
  const {
    rootDigest: previousRootDigest,
    ...previousRootFields
  } = root
  void previousRootDigest
  const fields = {
    ...previousRootFields,
    terminalState,
    terminalStateDigest: terminalState.stateDigest,
    terminalReceipt: receipt,
    terminalReceiptDigest: receipt.receiptDigest,
    finalRunStateDigest: terminalState.runStateDigest,
  }
  return {
    ...fields,
    rootDigest: createMigrationDigest(fields),
  }
}

/**
 * Encodes one test-only self-rehashed value without invoking its strict codec.
 *
 * @param value - JSON-safe value.
 * @returns Canonical UTF-8 bytes.
 */
function encodeCanonicalValue(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/**
 * Moves current state and authority beside the immutable retention deadline.
 *
 * @param fixture - Complete ordinary rollback fixture.
 * @returns Correlated fixture whose start time can exercise exact headroom.
 */
function createRetentionBoundaryFixture(
  fixture: RollbackFixture,
): RollbackFixture {
  const maintenanceReceipt = {
    ...fixture.appliedState.maintenanceEvidenceReceipt,
    validatedAt: '2026-08-30T00:58:00.000Z',
    oldestObservationAt: '2026-08-30T00:57:00.000Z',
    validUntil: '2026-08-30T01:02:00.001Z',
  }
  const appliedState: WorkspaceSearchMigrationRunState = {
    ...fixture.appliedState,
    maintenanceEvidenceReceipt: maintenanceReceipt,
    updatedAt: '2026-08-30T00:59:40.000Z',
  }
  validateWorkspaceSearchMigrationRunState(appliedState)
  const root = fixture.appliedRoot
  const fields = {
    kind: root.kind,
    rootVersion: root.rootVersion,
    migrationId: root.migrationId,
    migrationVersion: root.migrationVersion,
    stateTableId: root.stateTableId,
    configurationHash: root.configurationHash,
    runId: root.runId,
    executionRunDigest: root.executionRunDigest,
    predecessorRevision: root.predecessorRevision,
    predecessorExecutionStateDigest:
      root.predecessorExecutionStateDigest,
    predecessorRunStateDigest: root.predecessorRunStateDigest,
    seal: root.seal,
    sealReference: root.sealReference,
    authority: {
      ...root.authority,
      maintenanceEvidencePointerRevision: 13,
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(maintenanceReceipt),
      evaluatedAt: '2026-08-30T00:59:39.000Z',
    },
    minimumJournalRetainUntil:
      root.minimumJournalRetainUntil,
    successorRevision: root.successorRevision,
    status: root.status,
    successorRunStateDigest: createMigrationDigest(appliedState),
    committedAt: '2026-08-30T00:59:40.000Z',
  } satisfies Omit<
    WorkspaceSearchMigrationAppliedRoot,
    'rootDigest'
  >
  const appliedRoot = parseWorkspaceSearchMigrationAppliedRoot(
    serializeWorkspaceSearchMigrationAppliedRoot({
      ...fields,
      rootDigest: createMigrationDigest(fields),
    }),
  )
  return {
    ...fixture,
    appliedRoot,
    appliedState,
    currentAuthority: {
      ...fixture.currentAuthority,
      lease: {
        ...fixture.currentAuthority.lease,
        heartbeatAt: '2026-08-30T00:59:20.000Z',
        expiresAt: '2026-08-30T01:00:20.000Z',
      },
      maintenanceEvidenceReceiptDigest:
        createMigrationDigest(maintenanceReceipt),
      maintenanceEvidencePointerRevision: 13,
      maintenanceEvidenceReceipt: maintenanceReceipt,
      evaluatedAt: '2026-08-30T00:59:49.000Z',
    },
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
      keyCreationTime: '2026-01-01T00:00:00.000Z',
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
 * Creates one measured target or migration-state table.
 *
 * @param role - Supporting table role.
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
 * @param deletionProtection - Measured deletion-protection status.
 * @returns Complete immutable table identity.
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
 * @param configuration - Complete measured configuration.
 * @returns Fixed-role physical table incarnations.
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
 * Returns one required array entry without a type assertion.
 *
 * @param values - Candidate readonly array.
 * @param index - Required zero-based index.
 * @returns Exact array entry.
 */
function requireArrayEntry<Value>(
  values: readonly Value[],
  index: number,
): Value {
  const value = values[index]
  if (value === undefined) {
    throw new Error('Expected one fixture array entry.')
  }
  return value
}

/**
 * Captures one expected stable rollback persistence failure.
 *
 * @param operation - Synchronous operation expected to fail.
 * @returns Exact stable public rollback persistence error.
 */
function captureRollbackFailure(
  operation: () => unknown,
): WorkspaceSearchMigrationRollbackPersistenceError {
  try {
    operation()
  } catch (error: unknown) {
    if (
      error instanceof
        WorkspaceSearchMigrationRollbackPersistenceError
    ) {
      return error
    }
    throw error
  }
  throw new Error('Expected one rollback persistence failure.')
}

/**
 * Computes one stable fixture digest from text.
 *
 * @param value - Stable fixture label.
 * @returns Lowercase SHA-256 digest.
 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Computes the SHA-256 digest of exact UTF-8 text.
 *
 * @param value - Exact text.
 * @returns Lowercase SHA-256 digest.
 */
function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Computes the SHA-256 digest of exact bytes.
 *
 * @param value - Exact bytes.
 * @returns Lowercase SHA-256 digest.
 */
function digestBytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
