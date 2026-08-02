import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  captureWorkspaceSearchMigrationRehearsalChildMutationObservation,
  createWorkspaceSearchMigrationRehearsalStageChildMaterial,
  verifyWorkspaceSearchMigrationRehearsalStageChildMaterial,
  WorkspaceSearchMigrationRehearsalStageChildMaterialError,
} from './migration-rehearsal-stage-child-material'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import type {
  WorkspaceSearchMigrationRehearsalSelectedStage,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'

describe('authenticated rehearsal stage child material', () => {
  test('reauthenticates selection and binds strict result, stdout, and rate segment', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const captured =
      captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
        selection: fixture.selection,
        authenticationKey: fixture.authenticationKey,
        observation: fixture.observation,
      })
    const material =
      createWorkspaceSearchMigrationRehearsalStageChildMaterial({
        selection: fixture.selection,
        observation: captured,
        committedRateSegment: fixture.committedRateSegment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        authenticationKey: fixture.authenticationKey,
      })
    const verified =
      verifyWorkspaceSearchMigrationRehearsalStageChildMaterial({
        material,
        selection: fixture.selection,
        verificationKey: fixture.authenticationKey,
      })

    expect(verified).toEqual(material)
    expect(verified.serializedOutputLineDigest).toBe(
      fixture.observation.serializedOutputLineDigest,
    )
    expect(verified.rateSegment.segmentDigest).toBe(
      fixture.committedRateSegment.segmentDigest,
    )
    const serialized = serializeCanonicalJson(verified)
    expect(serialized).not.toContain('runId')
    expect(serialized).not.toContain('ownerId')
    expect(serialized).not.toContain('cursor')
    expect(serialized).not.toContain('canonicalBytes')
    expect(serialized).not.toContain('"serializedOutputLine":')
  })

  test('rejects a forged selection even when its scalar head appears valid', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const forgedSelection: WorkspaceSearchMigrationRehearsalSelectedStage =
      Object.freeze({
        ...fixture.selection,
        manifestDigest: 'f'.repeat(64),
      })

    expect(() =>
      captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
        selection: forgedSelection,
        authenticationKey: fixture.authenticationKey,
        observation: fixture.observation,
      }),
    ).toThrow(WorkspaceSearchMigrationRehearsalStageChildMaterialError)
  })

  test('rejects unknown coordinator fields instead of recursively copying them', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const result = Object.freeze({
      ...fixture.observation.result,
      coordinator: Object.freeze({
        ...fixture.observation.result.coordinator,
        runId: 'must-never-cross-the-boundary',
      }),
    })
    const line = serializeCanonicalJson(result)

    expect(() =>
      captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
        selection: fixture.selection,
        authenticationKey: fixture.authenticationKey,
        observation: Object.freeze({
          result,
          serializedOutputLine: line,
          serializedOutputLineDigest: createMigrationDigest(line),
        }),
      }),
    ).toThrow(WorkspaceSearchMigrationRehearsalStageChildMaterialError)
  })

  test('rejects wrong keys, altered segment bytes, and oversized UTF-8 stdout', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const captured =
      captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
        selection: fixture.selection,
        authenticationKey: fixture.authenticationKey,
        observation: fixture.observation,
      })
    const material =
      createWorkspaceSearchMigrationRehearsalStageChildMaterial({
        selection: fixture.selection,
        observation: captured,
        committedRateSegment: fixture.committedRateSegment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        authenticationKey: fixture.authenticationKey,
      })
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageChildMaterial({
        material,
        selection: fixture.selection,
        verificationKey: new Uint8Array(32).fill(0x99),
      }),
    ).toThrow(WorkspaceSearchMigrationRehearsalStageChildMaterialError)
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageChildMaterial({
        selection: fixture.selection,
        observation: captured,
        committedRateSegment: Object.freeze({
          ...fixture.committedRateSegment,
          canonicalBytes: new TextEncoder().encode('altered\n'),
        }),
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        authenticationKey: fixture.authenticationKey,
      }),
    ).toThrow(WorkspaceSearchMigrationRehearsalStageChildMaterialError)

    const oversizedLine = serializeCanonicalJson({ value: '界'.repeat(90_000) })
    expect(() =>
      captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
        selection: fixture.selection,
        authenticationKey: fixture.authenticationKey,
        observation: Object.freeze({
          result: fixture.observation.result,
          serializedOutputLine: oversizedLine,
          serializedOutputLineDigest: createMigrationDigest(oversizedLine),
        }),
      }),
    ).toThrow(WorkspaceSearchMigrationRehearsalStageChildMaterialError)
  })

  test('rejects absent, replayed, nonce-tampered, and wrong-head claims', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const captured =
      captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
        selection: fixture.selection,
        authenticationKey: fixture.authenticationKey,
        observation: fixture.observation,
      })
    const replayedReservation =
      createWorkspaceSearchMigrationRehearsalStageReservation({
        selection: fixture.selection,
        nonce: new Uint8Array(32).fill(0x93),
        reservedAt: fixture.stageReservation.reservedAt,
        expiresAt: fixture.stageReservation.expiresAt,
        expectedPreviousRateSegment: null,
        expectedCurrentRateSegmentOrdinal: 0,
        expectedTargetPreimageArtifactContentDigest: null,
        signingKey: fixture.authenticationKey,
      })
    const attempts: readonly (readonly [unknown, unknown])[] = [
      [undefined, fixture.claimedStageHead],
      [replayedReservation, fixture.claimedStageHead],
      [
        Object.freeze({
          ...fixture.stageReservation,
          nonceDigest: 'f'.repeat(64),
        }),
        fixture.claimedStageHead,
      ],
      [
        fixture.stageReservation,
        Object.freeze({
          ...fixture.claimedStageHead,
          manifestDigest: 'f'.repeat(64),
        }),
      ],
      [
        fixture.stageReservation,
        Object.freeze({
          ...fixture.claimedStageHead,
          activeStageOrdinal: fixture.selection.entry.ordinal + 1,
        }),
      ],
      [
        fixture.stageReservation,
        Object.freeze({
          ...fixture.claimedStageHead,
          activeExpiresAt: '2026-08-02T00:24:59.999Z',
        }),
      ],
    ]
    for (const [stageReservation, claimedStageHead] of attempts) {
      expect(() =>
        createWorkspaceSearchMigrationRehearsalStageChildMaterial({
          selection: fixture.selection,
          observation: captured,
          committedRateSegment: fixture.committedRateSegment,
          stageReservation,
          claimedStageHead,
          leaseAcquisitionObservation:
            fixture.leaseAcquisitionObservation,
          authenticationKey: fixture.authenticationKey,
        })
      ).toThrow(WorkspaceSearchMigrationRehearsalStageChildMaterialError)
    }
  })

  test('binds acquired and reused leases while rejecting invalid lease facts', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const captured =
      captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
        selection: fixture.selection,
        authenticationKey: fixture.authenticationKey,
        observation: fixture.observation,
      })
    const initialObservation = fixture.leaseAcquisitionObservation
    if (initialObservation.kind !== 'acquired') {
      throw new Error('Expected an acquired first-stage lease fixture.')
    }
    const predecessorLeaseIdentityDigest = 'b'.repeat(64)
    const acquiredWithPredecessor = Object.freeze({
      ...initialObservation,
      predecessorLeaseIdentityDigest,
      predecessorLeaseExpiresAt: '2026-08-02T00:10:00.000Z',
    })
    const material =
      createWorkspaceSearchMigrationRehearsalStageChildMaterial({
        selection: fixture.selection,
        observation: captured,
        committedRateSegment: fixture.committedRateSegment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation: acquiredWithPredecessor,
        authenticationKey: fixture.authenticationKey,
      })

    expect(material.leaseIdentityDigest).toBe(
      initialObservation.successorLeaseIdentityDigest,
    )
    expect(material.leaseAcquisitionObservation).toEqual(
      acquiredWithPredecessor,
    )
    const reusedActive = Object.freeze({
      kind: 'reused-active',
      currentLeaseIdentityDigest: 'a'.repeat(64),
      evaluatedAt: '2026-08-02T00:12:00.000Z',
      currentLeaseExpiresAt: '2026-08-02T00:26:00.000Z',
    })
    const reusedMaterial =
      createWorkspaceSearchMigrationRehearsalStageChildMaterial({
        selection: fixture.selection,
        observation: captured,
        committedRateSegment: fixture.committedRateSegment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation: reusedActive,
        authenticationKey: fixture.authenticationKey,
      })
    expect(reusedMaterial.leaseIdentityDigest).toBe(
      reusedActive.currentLeaseIdentityDigest,
    )
    expect(reusedMaterial.leaseAcquisitionObservation).toEqual(reusedActive)
    for (const invalidObservation of [
      Object.freeze({
        ...reusedActive,
        evaluatedAt: reusedActive.currentLeaseExpiresAt,
      }),
      Object.freeze({
        ...initialObservation,
        predecessorLeaseIdentityDigest,
      }),
      Object.freeze({
        ...acquiredWithPredecessor,
        predecessorLeaseIdentityDigest:
          acquiredWithPredecessor.successorLeaseIdentityDigest,
      }),
    ]) {
      expect(() =>
        createWorkspaceSearchMigrationRehearsalStageChildMaterial({
          selection: fixture.selection,
          observation: captured,
          committedRateSegment: fixture.committedRateSegment,
          stageReservation: fixture.stageReservation,
          claimedStageHead: fixture.claimedStageHead,
          leaseAcquisitionObservation: invalidObservation,
          authenticationKey: fixture.authenticationKey,
        })
      ).toThrow(WorkspaceSearchMigrationRehearsalStageChildMaterialError)
    }
  })
})
