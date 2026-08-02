import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  parseWorkspaceSearchMigrationRehearsalStageReservationDocument,
  verifyWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
  WorkspaceSearchMigrationRehearsalStageReservationError,
} from './migration-rehearsal-stage-reservation'

/** Canonical reservation creation time used by focused tests. */
const reservedAt = '2026-08-02T00:00:00.000Z'

/** Canonical reservation expiry used by focused tests. */
const expiresAt = '2026-08-02T01:30:00.000Z'

describe('Workspace Search migration rehearsal stage reservation', () => {
  test('fixes the claim, recovery, and abandonment-runway durations', () => {
    expect(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS,
    ).toBe(90 * 60 * 1_000)
    expect(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
    ).toBe(15 * 60 * 1_000)
    expect(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_ABANDONMENT_RUNWAY_MILLISECONDS,
    ).toBe(15 * 60 * 1_000)
    expect(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS,
    ).toBeGreaterThan(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_PERMIT_RECOVERY_WINDOW_MILLISECONDS,
    )
  })

  test('authenticates one exact manifest selection and fresh nonce digest', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const nonce = new Uint8Array(32).fill(4)
    const reservation =
      createWorkspaceSearchMigrationRehearsalStageReservation({
        selection: fixture.selection,
        nonce,
        reservedAt,
        expiresAt,
        expectedPreviousRateSegment: null,
        expectedCurrentRateSegmentOrdinal: 0,
        expectedTargetPreimageArtifactContentDigest: null,
        signingKey: fixture.authenticationKey,
      })

    expect(reservation.stageOrdinal).toBe(1)
    expect(reservation.previousStageReceiptDigest).toBeNull()
    expect(reservation.nonceDigest).toHaveLength(64)
    expect(nonce).toEqual(new Uint8Array(32).fill(4))
    expect(
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation,
        selection: fixture.selection,
        verificationKey: fixture.authenticationKey,
      }),
    ).toEqual(reservation)
    expect(
      parseWorkspaceSearchMigrationRehearsalStageReservationDocument(
        new TextEncoder().encode(serializeCanonicalJson(reservation)),
        fixture.selection,
        fixture.authenticationKey,
      ),
    ).toEqual(reservation)
  })

  test('requires a target-preimage digest only for rollback apply', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const entry = fixture.manifest.entries.find((candidate) =>
      candidate.scenario === 'complete-apply-rollback' &&
        candidate.command === 'apply'
    )
    if (entry === undefined) throw new Error('Expected rollback apply entry.')
    const selection = Object.freeze({
      manifest: fixture.manifest,
      manifestDigest: createMigrationDigest(fixture.manifest),
      entry,
      previousStageReceiptDigest: '8'.repeat(64),
    })
    const {
      canonicalBytes: _canonicalBytes,
      ...expectedPreviousRateSegment
    } = fixture.committedRateSegment
    const contentDigest = '7'.repeat(64)
    const reservation =
      createWorkspaceSearchMigrationRehearsalStageReservation({
        selection,
        nonce: new Uint8Array(32).fill(0x44),
        reservedAt,
        expiresAt,
        expectedPreviousRateSegment,
        expectedCurrentRateSegmentOrdinal:
          expectedPreviousRateSegment.segmentOrdinal + 1,
        expectedTargetPreimageArtifactContentDigest: contentDigest,
        signingKey: fixture.authenticationKey,
      })
    expect(reservation.expectedTargetPreimageArtifactContentDigest).toBe(
      contentDigest,
    )
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageReservation({
        selection,
        nonce: new Uint8Array(32).fill(0x45),
        reservedAt,
        expiresAt,
        expectedPreviousRateSegment,
        expectedCurrentRateSegmentOrdinal:
          expectedPreviousRateSegment.segmentOrdinal + 1,
        expectedTargetPreimageArtifactContentDigest: null,
        signingKey: fixture.authenticationKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReservationError)
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageReservation({
        selection: fixture.selection,
        nonce: new Uint8Array(32).fill(0x46),
        reservedAt,
        expiresAt,
        expectedPreviousRateSegment: null,
        expectedCurrentRateSegmentOrdinal: 0,
        expectedTargetPreimageArtifactContentDigest: contentDigest,
        signingKey: fixture.authenticationKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReservationError)
  })

  test('rejects wrong keys, selection substitution, and claim tampering', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const reservation =
      createWorkspaceSearchMigrationRehearsalStageReservation({
        selection: fixture.selection,
        nonce: new Uint8Array(32).fill(5),
        reservedAt,
        expiresAt,
        expectedPreviousRateSegment: null,
        expectedCurrentRateSegmentOrdinal: 0,
        expectedTargetPreimageArtifactContentDigest: null,
        signingKey: fixture.authenticationKey,
      })
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation,
        selection: fixture.selection,
        verificationKey: new Uint8Array(32).fill(9),
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReservationError)
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation,
        selection: {
          ...fixture.selection,
          previousStageReceiptDigest: 'a'.repeat(64),
        },
        verificationKey: fixture.authenticationKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReservationError)
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageReservation({
        reservation: {
          ...reservation,
          controlArgumentsDigest: 'b'.repeat(64),
        },
        selection: fixture.selection,
        verificationKey: fixture.authenticationKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReservationError)
  })

  test('requires a positive interval no longer than the claim ceiling', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    for (const invalidExpiry of [
      reservedAt,
      '2026-08-02T01:30:00.001Z',
      'not-a-time',
    ]) {
      expect(() =>
        createWorkspaceSearchMigrationRehearsalStageReservation({
          selection: fixture.selection,
          nonce: new Uint8Array(32).fill(6),
          reservedAt,
          expiresAt: invalidExpiry,
          expectedPreviousRateSegment: null,
          expectedCurrentRateSegmentOrdinal: 0,
          expectedTargetPreimageArtifactContentDigest: null,
          signingKey: fixture.authenticationKey,
        })
      ).toThrow(WorkspaceSearchMigrationRehearsalStageReservationError)
    }
    expect(() =>
      createWorkspaceSearchMigrationRehearsalStageReservation({
        selection: fixture.selection,
        nonce: new Uint8Array(31),
        reservedAt,
        expiresAt,
        expectedPreviousRateSegment: null,
        expectedCurrentRateSegmentOrdinal: 0,
        expectedTargetPreimageArtifactContentDigest: null,
        signingKey: fixture.authenticationKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReservationError)
  })

  test('rejects noncanonical or newline-terminated reservation documents', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
    const reservation =
      createWorkspaceSearchMigrationRehearsalStageReservation({
        selection: fixture.selection,
        nonce: new Uint8Array(32).fill(7),
        reservedAt,
        expiresAt,
        expectedPreviousRateSegment: null,
        expectedCurrentRateSegmentOrdinal: 0,
        expectedTargetPreimageArtifactContentDigest: null,
        signingKey: fixture.authenticationKey,
      })
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalStageReservationDocument(
        new TextEncoder().encode(
          `${serializeCanonicalJson(reservation)}\n`,
        ),
        fixture.selection,
        fixture.authenticationKey,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageReservationError)
  })
})
