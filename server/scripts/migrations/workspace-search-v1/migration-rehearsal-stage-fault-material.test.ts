import { describe, expect, test } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRehearsalFaultPlan,
  WorkspaceSearchMigrationRehearsalFaultReceipt,
} from './migration-rehearsal-faults'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
} from './migration-rehearsal-permit'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
} from './migration-rehearsal-rate-evidence'
import {
  captureWorkspaceSearchMigrationRehearsalChildMutationObservation,
  type WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
} from './migration-rehearsal-stage-child-material'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  parseWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialDocument,
  verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  WorkspaceSearchMigrationRehearsalStageFaultMaterialError,
  type WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-stage-fault-material'
import {
  createWorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation-aws'

/** Complete deterministic response-loss material fixture. */
type FaultMaterialFixture = {
  /** Shared stage authentication key. */
  readonly key: Uint8Array
  /** Exact reviewed response-loss plan. */
  readonly plan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Exact selected response-loss stage. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Fresh authenticated selected-stage reservation. */
  readonly stageReservation:
    WorkspaceSearchMigrationRehearsalStageReservation
  /** Durable head matching the fresh reservation. */
  readonly claimedStageHead:
    WorkspaceSearchMigrationRehearsalStageHead
  /** Adapter-proven initial acquisition used by the faulting attempt. */
  readonly leaseAcquisitionObservation:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation
  /** Adapter-proven committed planning successor at response loss. */
  readonly faultObservation:
    WorkspaceSearchMigrationRehearsalFaultObservation
  /** Exact runtime receipt matching the plan. */
  readonly receipt: WorkspaceSearchMigrationRehearsalFaultReceipt
  /** Authenticated rate segment at both protocol boundaries. */
  readonly segment: WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Trusted strict post-reconciliation observation. */
  readonly observation: ReturnType<
    typeof captureWorkspaceSearchMigrationRehearsalChildMutationObservation
  >
}

/** Creates a stable SHA-256 fixture digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Creates one authenticated empty rate segment at the selected ordinal. */
function createRateSegment(
  ordinal: number,
  policyVersion: string,
  configurationBindingDigest: string,
  key: Uint8Array,
): WorkspaceSearchMigrationRehearsalRateCommittedSegment {
  const authenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      key,
    )
  const claims = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 2,
    segmentLocatorDigest: digest('fault-rate-segment'),
    segmentOrdinal: ordinal,
    previousSegmentDigest: ordinal === 0 ? null : digest('previous-segment'),
    previousRecordMac: ordinal === 0 ? null : digest('previous-record-mac'),
    firstEventSequence: 1,
    anchorUtc: '2026-08-02T00:00:00.000Z',
    authenticationKeyFingerprint,
    policyVersion,
    configurationBindingDigest,
  })
  const mac = createHmac('sha256', key)
    .update(
      'mukuroji:workspace-search-migration:rehearsal-rate-record:v2',
      'utf8',
    )
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
  const canonicalBytes = new TextEncoder().encode(
    `${serializeCanonicalJson({ ...claims, mac })}\n`,
  )
  return Object.freeze({
    authenticationKeyFingerprint,
    segmentLocatorDigest: claims.segmentLocatorDigest,
    segmentOrdinal: ordinal,
    firstEventSequence: claims.firstEventSequence,
    eventCount: 0,
    firstCommittedEventSequence: null,
    lastCommittedEventSequence: null,
    terminalRecordMac: mac,
    segmentDigest: createHash('sha256').update(canonicalBytes).digest('hex'),
    canonicalBytes,
  })
}

/** Creates an authentic manifest selection for the response-loss stage. */
function createFaultMaterialFixture(): FaultMaterialFixture {
  const base =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
  const key = new Uint8Array(base.authenticationKey)
  const plan: WorkspaceSearchMigrationRehearsalFaultPlan = Object.freeze({
    stage: 'non-production',
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
    failpoint: 'planning-page-transaction-response-lost',
    target: Object.freeze({
      kind: 'target',
      pageSequence: 2,
      cursorState: 'present',
    }),
  })
  const entries: WorkspaceSearchMigrationRehearsalStageManifestEntry[] =
    base.manifest.entries.map((entry) =>
      entry.scenario === 'transaction-response-loss' &&
          entry.scenarioStageOrdinal === 1
        ? Object.freeze({
            ...entry,
            faultPlanDigest: createMigrationDigest(plan),
          })
        : entry
    )
  const manifest = createWorkspaceSearchMigrationRehearsalStageManifest({
    claims: Object.freeze({
      kind: base.manifest.kind,
      manifestVersion: base.manifest.manifestVersion,
      stage: base.manifest.stage,
      commit: base.manifest.commit,
      permitDigest: base.manifest.permitDigest,
      evidenceKeyDigest: base.manifest.evidenceKeyDigest,
      publicationKeyDigest: base.manifest.publicationKeyDigest,
      deploymentTrustRootDigest:
        base.manifest.deploymentTrustRootDigest,
      requestedResourcesBinding: base.manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        base.manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities:
        base.manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        base.manifest.integrityResourceIdentityDigest,
      integrityAttestationRoot:
        base.manifest.integrityAttestationRoot,
      configurationBindingDigest:
        base.manifest.configurationBindingDigest,
      policyVersion: base.manifest.policyVersion,
      reviewedAt: base.manifest.reviewedAt,
      entries: Object.freeze(entries),
    }),
    signingKey: key,
  })
  const entry = manifest.entries.find((candidate) =>
    candidate.scenario === 'transaction-response-loss' &&
      candidate.scenarioStageOrdinal === 1
  )
  if (entry === undefined) throw new Error('Missing response-loss fixture entry.')
  const selection: WorkspaceSearchMigrationRehearsalSelectedStage =
    Object.freeze({
      manifest,
      manifestDigest: createMigrationDigest(manifest),
      entry,
      previousStageReceiptDigest: digest('previous-stage-receipt'),
    })
  const receipt: WorkspaceSearchMigrationRehearsalFaultReceipt =
    Object.freeze({
      receiptVersion: 1,
      stage: 'non-production',
      failpoint: plan.failpoint,
      action: 'response-loss',
      target: plan.target,
      occurrence: 1,
      reachedAt: '2026-08-02T00:10:00.000Z',
    })
  const expectedPreviousRateSegment = Object.freeze({
    authenticationKeyFingerprint:
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        key,
      ),
    segmentLocatorDigest: digest('previous-segment-locator'),
    segmentOrdinal: entry.ordinal - 2,
    firstEventSequence: 1,
    eventCount: 0,
    firstCommittedEventSequence: null,
    lastCommittedEventSequence: null,
    terminalRecordMac: digest('previous-record-mac'),
    segmentDigest: digest('previous-segment'),
  })
  const stageReservation =
    createWorkspaceSearchMigrationRehearsalStageReservation({
      selection,
      nonce: new Uint8Array(32).fill(0x42),
      reservedAt: '2026-08-02T00:05:00.000Z',
      expiresAt: '2026-08-02T00:20:00.000Z',
      expectedPreviousRateSegment,
      expectedCurrentRateSegmentOrdinal:
        expectedPreviousRateSegment.segmentOrdinal + 1,
      expectedTargetPreimageArtifactContentDigest: null,
      signingKey: key,
    })
  const claimedStageHead: WorkspaceSearchMigrationRehearsalStageHead =
    Object.freeze({
      manifestDigest: selection.manifestDigest,
      completedStageOrdinal: selection.entry.ordinal - 1,
      headReceiptDigest: selection.previousStageReceiptDigest,
      activeReservationDigest: createMigrationDigest(stageReservation),
      activeStageOrdinal: selection.entry.ordinal,
      activeExpiresAt: stageReservation.expiresAt,
      abandonmentCount: 0,
      abandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      revision: selection.entry.ordinal * 2 - 1,
    })
  const leaseIdentityDigest =
    base.leaseAcquisitionObservation.kind === 'acquired'
      ? base.leaseAcquisitionObservation.successorLeaseIdentityDigest
      : base.leaseAcquisitionObservation.currentLeaseIdentityDigest
  const faultObservation:
    WorkspaceSearchMigrationRehearsalFaultObservation = Object.freeze({
      observationVersion: 1,
      kind: 'planning-page',
      failpoint: plan.failpoint,
      leaseIdentityDigest,
      closedWriterFenceRecordDigest: digest('closed-fence'),
      durableAppliedOperationCount: 0,
      sealedPlanOperationCount: null,
      durableHeadPosition: 'committed-successor',
      durableHeadPageSequence: plan.target.pageSequence,
      durableHeadEvidenceDigest: digest('fault-head-evidence'),
      durableHeadCheckpointDigest: digest('fault-head-checkpoint'),
      durableHeadProgressDigest: digest('fault-head-progress'),
      durableHeadCursorState: 'present',
      durableHeadCompleted: false,
      planningTarget: plan.target,
    })
  return Object.freeze({
    key,
    plan,
    selection,
    stageReservation,
    claimedStageHead,
    leaseAcquisitionObservation: base.leaseAcquisitionObservation,
    faultObservation,
    receipt,
    segment: createRateSegment(
      entry.ordinal - 1,
      manifest.policyVersion,
      manifest.configurationBindingDigest,
      key,
    ),
    observation:
      captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
        selection,
        authenticationKey: key,
        observation: base.observation,
      }),
  })
}

describe('authenticated stage fault material', () => {
  test('creates and independently verifies one exact boundary', () => {
    const fixture = createFaultMaterialFixture()
    const material =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.plan,
        faultReceipt: fixture.receipt,
        committedRateSegment: fixture.segment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.key,
      })

    expect(
      verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        material,
        selection: fixture.selection,
        faultPlan: fixture.plan,
        rateSegmentBytes: fixture.segment.canonicalBytes,
        verificationKey: fixture.key,
      }),
    ).toEqual(material)
    expect(JSON.stringify(material)).not.toContain('cursor":"')
  })

  test('rejects a wrong key, replayed selection, target, and outer tamper', () => {
    const fixture = createFaultMaterialFixture()
    const material =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.plan,
        faultReceipt: fixture.receipt,
        committedRateSegment: fixture.segment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.key,
      })
    const wrongKey = new Uint8Array(32).fill(0x91)
    const replayedSelection = Object.freeze({
      ...fixture.selection,
      previousStageReceiptDigest: digest('replayed-predecessor'),
    })
    const wrongTargetPlan: WorkspaceSearchMigrationRehearsalFaultPlan =
      Object.freeze({
        stage: 'non-production',
        approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
        failpoint: 'planning-page-transaction-response-lost',
        target: Object.freeze({
          kind: 'target',
          pageSequence: 3,
          cursorState: 'present',
        }),
      })

    for (const attempt of [
      (): unknown =>
        verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
          material,
          selection: fixture.selection,
          faultPlan: fixture.plan,
          rateSegmentBytes: fixture.segment.canonicalBytes,
          verificationKey: wrongKey,
        }),
      (): unknown =>
        verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
          material,
          selection: replayedSelection,
          faultPlan: fixture.plan,
          rateSegmentBytes: fixture.segment.canonicalBytes,
          verificationKey: fixture.key,
        }),
      (): unknown =>
        verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
          material,
          selection: fixture.selection,
          faultPlan: wrongTargetPlan,
          rateSegmentBytes: fixture.segment.canonicalBytes,
          verificationKey: fixture.key,
        }),
      (): unknown =>
        verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
          material: Object.freeze({
            ...material,
            faultReceiptDigest: digest('tampered'),
          }),
          selection: fixture.selection,
          faultPlan: fixture.plan,
          rateSegmentBytes: fixture.segment.canonicalBytes,
          verificationKey: fixture.key,
        }),
    ]) {
      expect(attempt).toThrow(
        WorkspaceSearchMigrationRehearsalStageFaultMaterialError,
      )
    }
  })

  test('rejects noncanonical, duplicate, and trailing boundary documents', () => {
    const fixture = createFaultMaterialFixture()
    const material =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.plan,
        faultReceipt: fixture.receipt,
        committedRateSegment: fixture.segment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.key,
      })
    const canonical = serializeCanonicalJson(material)
    const input = Object.freeze({
      selection: fixture.selection,
      faultPlan: fixture.plan,
      rateSegmentBytes: fixture.segment.canonicalBytes,
      verificationKey: fixture.key,
    })

    for (const text of [
      `${canonical}\n`,
      `${canonical}${canonical}`,
      ` ${canonical}`,
    ]) {
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterialDocument(
          new TextEncoder().encode(text),
          input,
        )
      ).toThrow(WorkspaceSearchMigrationRehearsalStageFaultMaterialError)
    }
  })

  test('binds response-loss completion to boundary, stdout, result, and rate', () => {
    const fixture = createFaultMaterialFixture()
    const boundary =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.plan,
        faultReceipt: fixture.receipt,
        committedRateSegment: fixture.segment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.key,
      })
    const completion =
      createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        selection: fixture.selection,
        faultPlan: fixture.plan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes: fixture.segment.canonicalBytes,
        observation: fixture.observation,
        committedRateSegment: fixture.segment,
        authenticationKey: fixture.key,
      })

    expect(
      verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        material: completion,
        selection: fixture.selection,
        faultPlan: fixture.plan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes: fixture.segment.canonicalBytes,
        finalRateSegmentBytes: fixture.segment.canonicalBytes,
        verificationKey: fixture.key,
      }),
    ).toEqual(completion)
    expect(completion.boundaryMaterialDigest).toBe(
      createMigrationDigest(boundary),
    )
    expect(completion.faultReceiptDigest).toBe(
      boundary.faultReceiptDigest,
    )
    expect(completion.serializedOutputLineDigest).toBe(
      fixture.observation.serializedOutputLineDigest,
    )
  })

  test('rejects completion replay and inner rate tamper', () => {
    const fixture = createFaultMaterialFixture()
    const boundary =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.plan,
        faultReceipt: fixture.receipt,
        committedRateSegment: fixture.segment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.key,
      })
    const completion =
      createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        selection: fixture.selection,
        faultPlan: fixture.plan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes: fixture.segment.canonicalBytes,
        observation: fixture.observation,
        committedRateSegment: fixture.segment,
        authenticationKey: fixture.key,
      })
    const tamperedRate = new Uint8Array(fixture.segment.canonicalBytes)
    tamperedRate[0] = 0x5b

    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        material: Object.freeze({
          ...completion,
          boundaryMaterialDigest: digest('other-boundary'),
        }),
        selection: fixture.selection,
        faultPlan: fixture.plan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes: fixture.segment.canonicalBytes,
        finalRateSegmentBytes: fixture.segment.canonicalBytes,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageFaultMaterialError)
    expect(() =>
      verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        material: completion,
        selection: fixture.selection,
        faultPlan: fixture.plan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes: fixture.segment.canonicalBytes,
        finalRateSegmentBytes: tamperedRate,
        verificationKey: fixture.key,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageFaultMaterialError)
  })

  test('rejects missing and additional boundary or completion keys', () => {
    const fixture = createFaultMaterialFixture()
    const boundary =
      createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
        selection: fixture.selection,
        faultPlan: fixture.plan,
        faultReceipt: fixture.receipt,
        committedRateSegment: fixture.segment,
        stageReservation: fixture.stageReservation,
        claimedStageHead: fixture.claimedStageHead,
        leaseAcquisitionObservation:
          fixture.leaseAcquisitionObservation,
        faultObservation: fixture.faultObservation,
        authenticationKey: fixture.key,
      })
    const completion =
      createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        selection: fixture.selection,
        faultPlan: fixture.plan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes: fixture.segment.canonicalBytes,
        observation: fixture.observation,
        committedRateSegment: fixture.segment,
        authenticationKey: fixture.key,
      })
    const {
      faultObservation: omittedBoundaryFaultObservation,
      ...boundaryWithoutFaultObservation
    } = boundary
    const {
      faultObservation: omittedCompletionFaultObservation,
      ...completionWithoutFaultObservation
    } = completion
    expect(omittedBoundaryFaultObservation).toEqual(
      fixture.faultObservation,
    )
    expect(omittedCompletionFaultObservation).toEqual(
      fixture.faultObservation,
    )

    for (const material of [
      boundaryWithoutFaultObservation,
      Object.freeze({ ...boundary, unexpected: true }),
    ]) {
      expect(() =>
        verifyWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
          material,
          selection: fixture.selection,
          faultPlan: fixture.plan,
          rateSegmentBytes: fixture.segment.canonicalBytes,
          verificationKey: fixture.key,
        })
      ).toThrow(WorkspaceSearchMigrationRehearsalStageFaultMaterialError)
    }
    for (const material of [
      completionWithoutFaultObservation,
      Object.freeze({ ...completion, unexpected: true }),
    ]) {
      expect(() =>
        verifyWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
          material,
          selection: fixture.selection,
          faultPlan: fixture.plan,
          boundaryMaterial: boundary,
          boundaryRateSegmentBytes: fixture.segment.canonicalBytes,
          finalRateSegmentBytes: fixture.segment.canonicalBytes,
          verificationKey: fixture.key,
        })
      ).toThrow(WorkspaceSearchMigrationRehearsalStageFaultMaterialError)
    }
  })
})
