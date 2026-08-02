import { describe, expect, test } from 'bun:test'
import { serializeCanonicalJson } from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalStageCommitEvidence,
  parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument,
  verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
  WorkspaceSearchMigrationRehearsalStageCommitEvidenceError,
  type WorkspaceSearchMigrationRehearsalStageCommitEvidenceClaims,
} from './migration-rehearsal-stage-commit-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'

/** Shared deterministic stage evidence key. */
const evidenceKey = new Uint8Array(32).fill(0x63)

/** Returns one valid terminal-stage commit evidence claim set. */
function createClaims(): WorkspaceSearchMigrationRehearsalStageCommitEvidenceClaims {
  const manifestDigest = 'a'.repeat(64)
  const receiptDigest = 'b'.repeat(64)
  return Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_COMMIT_EVIDENCE_KIND,
    evidenceVersion: 1,
    stage: 'non-production',
    manifestDigest,
    permitDigest: 'c'.repeat(64),
    requestedResourcesBinding: 'd'.repeat(64),
    stateTableLocationBindingDigest: 'e'.repeat(64),
    publicationKeyDigest: '1'.repeat(64),
    parentAuthenticationDigest: '2'.repeat(64),
    parentAuthorizationBindingDigest: '3'.repeat(64),
    stageOrdinal: 36,
    stageReservationDigest: 'f'.repeat(64),
    stageReservationClaimRevision: 71,
    receiptDigest,
    commitRevision: 72,
    head: Object.freeze({
      manifestDigest,
      completedStageOrdinal: 36,
      headReceiptDigest: receiptDigest,
      activeReservationDigest: null,
      activeStageOrdinal: null,
      activeExpiresAt: null,
      abandonmentCount: 0,
      abandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      revision: 72,
    }),
    commitGate: Object.freeze({ kind: 'none' }),
    recoveryAuthorization: Object.freeze({
      reservationExpiresAt: '2026-08-02T00:30:00.000Z',
      permitExpiresAt: '2026-08-02T01:00:00.000Z',
      recoveryDeadlineAt: '2026-08-02T00:45:00.000Z',
      receiptCompletedAt: '2026-08-02T00:28:00.000Z',
      processExitedAt: '2026-08-02T00:28:30.000Z',
      materialEvidenceDigest: '4'.repeat(64),
      boundaryMaterialEvidenceDigest: null,
      materialDigest: '5'.repeat(64),
      claimedStageHeadDigest: '6'.repeat(64),
      lifecycleEvidenceDigest: '7'.repeat(64),
      lifecycleDigest: '8'.repeat(64),
      runtimeKeyCleanupAuthorizationBindingDigest: '9'.repeat(64),
      cleanupIntentDigest: '0'.repeat(64),
      cleanupCompletionDigest: 'a'.repeat(64),
      cleanupPreparedAt: '2026-08-02T00:28:31.000Z',
      cleanupCompletedAt: '2026-08-02T00:29:00.000Z',
    }),
    admissionMode: 'bounded-recovery',
    commitAdmittedAt: '2026-08-02T00:30:00.000Z',
    durableStatus: 'committed',
  })
}

describe('authenticated rehearsal stage commit evidence', () => {
  test('authenticates an exact inactive terminal stage-36 head proof', () => {
    const evidence =
      createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
        claims: createClaims(),
        signingKey: evidenceKey,
      })
    const bytes = new TextEncoder().encode(serializeCanonicalJson(evidence))

    expect(
      verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
        evidence,
        evidenceKey,
      ),
    ).toEqual(evidence)
    expect(
      parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument(
        bytes,
        evidenceKey,
      ),
    ).toEqual(evidence)
    expect(evidence.head).toEqual({
      manifestDigest: evidence.manifestDigest,
      completedStageOrdinal: 36,
      headReceiptDigest: evidence.receiptDigest,
      activeReservationDigest: null,
      activeStageOrdinal: null,
      activeExpiresAt: null,
      abandonmentCount: 0,
      abandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      revision: 72,
    })
  })

  test('authenticates the durable fact without a transport outcome', () => {
    const claims = createClaims()
    const evidence =
      createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
        claims,
        signingKey: evidenceKey,
      })

    expect(evidence.durableStatus).toBe('committed')
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
        Object.freeze({
          ...evidence,
          durableStatus: 'reconciled-after-transport-uncertain',
        }),
        evidenceKey,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceError)
  })

  test('rejects an admission mode inconsistent with the exact expiry boundary', () => {
    const claims = createClaims()
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
        claims: Object.freeze({
          ...claims,
          admissionMode: 'ordinary',
        }),
        signingKey: evidenceKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceError)
  })

  test('strictly authenticates and deeply freezes compact commit gates', () => {
    const rateSuccessor = Object.freeze({
      authenticationKeyFingerprint: '1'.repeat(64),
      segmentLocatorDigest: '2'.repeat(64),
      segmentOrdinal: 35,
      firstEventSequence: 1,
      eventCount: 0,
      firstCommittedEventSequence: null,
      lastCommittedEventSequence: null,
      terminalRecordMac: '3'.repeat(64),
      segmentDigest: '4'.repeat(64),
    })
    const gates = Object.freeze([
      Object.freeze({
        kind: 'target-preimage',
        artifactBindingDigest: '5'.repeat(64),
        contentDigest: '6'.repeat(64),
        byteLength: 1_024,
        purpose: 'complete-rollback-preimage',
        contextDigest: '7'.repeat(64),
        commitGateObservedAt: '2026-08-02T00:29:30.000Z',
        observationDigest: '8'.repeat(64),
        aggregateDigest: '9'.repeat(64),
        rateSuccessor,
        rateAggregateDigest: 'a'.repeat(64),
        rateCompletedAt: '2026-08-02T00:29:20.000Z',
      }),
      Object.freeze({
        kind: 'terminal-reconciliation',
        artifactBindingDigest: 'b'.repeat(64),
        contentDigest: 'c'.repeat(64),
        byteLength: 2_048,
        scenario: 'happy-path-verified',
        contextDigest: 'd'.repeat(64),
        auditDigest: 'e'.repeat(64),
        rateSuccessor,
        rateAggregateDigest: 'f'.repeat(64),
        rateCompletedAt: '2026-08-02T00:29:20.000Z',
      }),
    ])
    for (const commitGate of gates) {
      const evidence =
        createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
          claims: Object.freeze({
            ...createClaims(),
            commitGate,
            admissionMode: 'ordinary',
            commitAdmittedAt: '2026-08-02T00:29:59.999Z',
          }),
          signingKey: evidenceKey,
        })
      expect(evidence.commitGate).toEqual(commitGate)
      expect(Object.isFrozen(evidence.commitGate)).toBe(true)
      if (evidence.commitGate.kind === 'none') {
        throw new Error('Expected a rate-successor commit gate fixture.')
      }
      expect(Object.isFrozen(evidence.commitGate.rateSuccessor)).toBe(true)
      expect(() =>
        verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
          Object.freeze({
            ...evidence,
            commitGate: Object.freeze({ ...commitGate, extra: true }),
          }),
          evidenceKey,
        )
      ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceError)
      expect(() =>
        createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
          claims: Object.freeze({ ...createClaims(), commitGate }),
          signingKey: evidenceKey,
        })
      ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceError)
    }
  })

  test('rejects active, mismatched, noncanonical, and wrong-key evidence', () => {
    const evidence =
      createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
        claims: createClaims(),
        signingKey: evidenceKey,
      })
    const attempts: readonly unknown[] = [
      Object.freeze({
        ...evidence,
        head: Object.freeze({
          ...evidence.head,
          activeReservationDigest: 'c'.repeat(64),
        }),
      }),
      Object.freeze({
        ...evidence,
        head: Object.freeze({
          ...evidence.head,
          revision: evidence.commitRevision + 1,
        }),
      }),
      Object.freeze({ ...evidence, extra: true }),
    ]
    for (const attempt of attempts) {
      expect(() =>
        verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
          attempt,
          evidenceKey,
        )
      ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceError)
    }
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
        evidence,
        new Uint8Array(32).fill(0x64),
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceError)
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalStageCommitEvidenceDocument(
        new TextEncoder().encode(` ${serializeCanonicalJson(evidence)}`),
        evidenceKey,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageCommitEvidenceError)
  })

  test('does not mutate caller-owned signing or verification keys', () => {
    const signingKey = new Uint8Array(evidenceKey)
    const verificationKey = new Uint8Array(evidenceKey)
    const evidence =
      createWorkspaceSearchMigrationRehearsalStageCommitEvidence({
        claims: createClaims(),
        signingKey,
      })
    verifyWorkspaceSearchMigrationRehearsalStageCommitEvidence(
      evidence,
      verificationKey,
    )

    expect(signingKey).toEqual(evidenceKey)
    expect(verificationKey).toEqual(evidenceKey)
  })
})
