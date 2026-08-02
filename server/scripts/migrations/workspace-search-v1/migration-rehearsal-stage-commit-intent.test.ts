import { describe, expect, test } from 'bun:test'
import { serializeCanonicalJson } from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalStageCommitIntent,
  parseWorkspaceSearchMigrationRehearsalStageCommitIntentDocument,
  verifyWorkspaceSearchMigrationRehearsalStageCommitIntent,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION,
  WorkspaceSearchMigrationRehearsalStageCommitIntentError,
  type WorkspaceSearchMigrationRehearsalStageCommitGate,
  type WorkspaceSearchMigrationRehearsalStageCommitIntentClaims,
} from './migration-rehearsal-stage-commit-intent'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'

/** Deterministic parent publication key for focused intent tests. */
const intentKey = new Uint8Array(32).fill(0x71)

/** Creates one exact empty authenticated rate successor. */
function createRateSuccessor() {
  return Object.freeze({
    authenticationKeyFingerprint: '1'.repeat(64),
    segmentLocatorDigest: '2'.repeat(64),
    segmentOrdinal: 0,
    firstEventSequence: 1,
    eventCount: 0,
    firstCommittedEventSequence: null,
    lastCommittedEventSequence: null,
    terminalRecordMac: '3'.repeat(64),
    segmentDigest: '4'.repeat(64),
  })
}

/** Creates one valid strict intent claim set with a selected compact gate. */
function createClaims(
  commitGate: WorkspaceSearchMigrationRehearsalStageCommitGate,
): WorkspaceSearchMigrationRehearsalStageCommitIntentClaims {
  const manifestDigest = 'a'.repeat(64)
  const receiptDigest = 'b'.repeat(64)
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_KIND,
    intentVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_INTENT_VERSION,
    stage: 'non-production',
    manifestDigest,
    permitDigest: 'c'.repeat(64),
    requestedResourcesBinding: 'd'.repeat(64),
    stateTableLocationBindingDigest: 'e'.repeat(64),
    publicationKeyDigest: 'f'.repeat(64),
    parentAuthenticationDigest: '0'.repeat(64),
    parentAuthorizationBindingDigest: '1'.repeat(64),
    stageOrdinal: 1,
    stageReservationDigest: '2'.repeat(64),
    stageReservationClaimRevision: 1,
    receiptDigest,
    commitRevision: 2,
    expectedHead: Object.freeze({
      manifestDigest,
      completedStageOrdinal: 1,
      headReceiptDigest: receiptDigest,
      activeReservationDigest: null,
      activeStageOrdinal: null,
      activeExpiresAt: null,
      abandonmentCount: 0,
      abandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      revision: 2,
    }),
    commitGate,
    recoveryAuthorization: Object.freeze({
      reservationExpiresAt: '2026-08-02T00:30:00.000Z',
      permitExpiresAt: '2026-08-02T01:00:00.000Z',
      recoveryDeadlineAt: '2026-08-02T00:45:00.000Z',
      receiptCompletedAt: '2026-08-02T00:28:00.000Z',
      processExitedAt: '2026-08-02T00:28:30.000Z',
      materialEvidenceDigest: '3'.repeat(64),
      boundaryMaterialEvidenceDigest: null,
      materialDigest: '4'.repeat(64),
      claimedStageHeadDigest: '5'.repeat(64),
      lifecycleEvidenceDigest: '6'.repeat(64),
      lifecycleDigest: '7'.repeat(64),
      runtimeKeyCleanupAuthorizationBindingDigest: '8'.repeat(64),
      cleanupIntentDigest: '9'.repeat(64),
      cleanupCompletionDigest: 'a'.repeat(64),
      cleanupPreparedAt: '2026-08-02T00:28:31.000Z',
      cleanupCompletedAt: '2026-08-02T00:29:00.000Z',
    }),
    preparedAt: '2026-08-02T00:29:30.000Z',
    intentStatus: 'prepared',
  })
}

describe('authenticated rehearsal stage commit intent gates', () => {
  test('round-trips none, target-preimage, and terminal gates exactly', () => {
    const rateSuccessor = createRateSuccessor()
    const gates: readonly WorkspaceSearchMigrationRehearsalStageCommitGate[] =
      Object.freeze([
        Object.freeze({ kind: 'none' }),
        Object.freeze({
          kind: 'target-preimage',
          artifactBindingDigest: 'b'.repeat(64),
          contentDigest: 'c'.repeat(64),
          byteLength: 1_024,
          purpose: 'partial-rollback-preimage',
          contextDigest: 'd'.repeat(64),
          commitGateObservedAt: '2026-08-02T00:29:20.000Z',
          observationDigest: 'e'.repeat(64),
          aggregateDigest: 'f'.repeat(64),
          rateSuccessor,
          rateAggregateDigest: '0'.repeat(64),
          rateCompletedAt: '2026-08-02T00:29:10.000Z',
        }),
        Object.freeze({
          kind: 'terminal-reconciliation',
          artifactBindingDigest: '1'.repeat(64),
          contentDigest: '2'.repeat(64),
          byteLength: 2_048,
          scenario: 'happy-path-verified',
          contextDigest: '3'.repeat(64),
          auditDigest: '4'.repeat(64),
          rateSuccessor,
          rateAggregateDigest: '5'.repeat(64),
          rateCompletedAt: '2026-08-02T00:29:10.000Z',
        }),
      ])
    for (const commitGate of gates) {
      const intent = createWorkspaceSearchMigrationRehearsalStageCommitIntent({
        claims: createClaims(commitGate),
        signingKey: intentKey,
      })
      const bytes = new TextEncoder().encode(serializeCanonicalJson(intent))
      expect(
        verifyWorkspaceSearchMigrationRehearsalStageCommitIntent(
          intent,
          intentKey,
        ),
      ).toEqual(intent)
      expect(
        parseWorkspaceSearchMigrationRehearsalStageCommitIntentDocument(
          bytes,
          intentKey,
        ),
      ).toEqual(intent)
      expect(Object.isFrozen(intent.commitGate)).toBe(true)
      if (intent.commitGate.kind !== 'none') {
        expect(Object.isFrozen(intent.commitGate.rateSuccessor)).toBe(true)
      }
    }
  })

  test('rejects extra fields, impossible rate shape, and zero byte length', () => {
    const targetGate: WorkspaceSearchMigrationRehearsalStageCommitGate =
      Object.freeze({
        kind: 'target-preimage',
        artifactBindingDigest: '6'.repeat(64),
        contentDigest: '7'.repeat(64),
        byteLength: 1,
        purpose: 'complete-rollback-preimage',
        contextDigest: '8'.repeat(64),
        commitGateObservedAt: '2026-08-02T00:29:20.000Z',
        observationDigest: '9'.repeat(64),
        aggregateDigest: 'a'.repeat(64),
        rateSuccessor: createRateSuccessor(),
        rateAggregateDigest: 'b'.repeat(64),
        rateCompletedAt: '2026-08-02T00:29:10.000Z',
      })
    const intent = createWorkspaceSearchMigrationRehearsalStageCommitIntent({
      claims: createClaims(targetGate),
      signingKey: intentKey,
    })
    for (const commitGate of [
      Object.freeze({ ...targetGate, extra: true }),
      Object.freeze({ ...targetGate, byteLength: 0 }),
      Object.freeze({
        ...targetGate,
        rateSuccessor: Object.freeze({
          ...targetGate.rateSuccessor,
          eventCount: 1,
        }),
      }),
    ]) {
      expect(() =>
        verifyWorkspaceSearchMigrationRehearsalStageCommitIntent(
          Object.freeze({ ...intent, commitGate }),
          intentKey,
        )
      ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitIntentError)
    }
  })
})
