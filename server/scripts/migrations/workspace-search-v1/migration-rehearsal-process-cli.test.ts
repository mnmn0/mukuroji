import { createHash, createHmac } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  workspaceSearchMigrationControlApprovalLiterals,
} from './migration-control-coordinator'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import {
  createWorkspaceSearchMigrationRehearsalChildSpawnSpecification,
  createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive,
  createWorkspaceSearchMigrationRehearsalExpectedFaultReceipt,
  parseWorkspaceSearchMigrationRehearsalCanonicalFaultPlan,
  parseWorkspaceSearchMigrationRehearsalProcessCliArguments,
  runWorkspaceSearchMigrationRehearsalNoFaultProcess,
  runWorkspaceSearchMigrationRehearsalProcessCli,
  removeWorkspaceSearchMigrationRehearsalRuntimeKeyFile,
  spawnWorkspaceSearchMigrationRehearsalControlChild,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_CHILD_SCRIPT,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_PROCESS_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_FAULT_PLAN_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZATION_SAFETY_MARGIN_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROCESS_APPROVAL,
  validateWorkspaceSearchMigrationRehearsalReservationOnlyDirectory,
  writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive,
  writeWorkspaceSearchMigrationRehearsalRuntimeKeyFileExclusive,
  type WorkspaceSearchMigrationRehearsalEvidenceFilename,
  type WorkspaceSearchMigrationRehearsalEvidencePublicationCheckpoint,
  type WorkspaceSearchMigrationRehearsalInstallSignalHandler,
  type WorkspaceSearchMigrationRehearsalParentSignal,
  type WorkspaceSearchMigrationRehearsalProcessCliDependencies,
} from './migration-rehearsal-process-cli'
import {
  parseWorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_KIND,
  type WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt,
  type WorkspaceSearchMigrationRehearsalNoFaultScenario,
} from './migration-rehearsal-control-cli'
import {
  runWorkspaceSearchMigrationRehearsalProcess,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
  type WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence,
  type WorkspaceSearchMigrationRehearsalProcessExitResult,
  type WorkspaceSearchMigrationRehearsalProcessPort,
} from './migration-rehearsal-process-runner'
import type {
  WorkspaceSearchMigrationRehearsalFaultPlan,
  WorkspaceSearchMigrationRehearsalFaultReceipt,
} from './migration-rehearsal-faults'
import {
  captureWorkspaceSearchMigrationRehearsalChildMutationObservation,
  createWorkspaceSearchMigrationRehearsalStageChildMaterial,
} from './migration-rehearsal-stage-child-material'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture,
  createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
  type WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  type WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  type WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
} from './migration-rehearsal-stage-fault-material'
import {
  createWorkspaceSearchMigrationRehearsalStageParentAuthentication,
} from './migration-rehearsal-stage-finalizer'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS,
  verifyWorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  createWorkspaceSearchMigrationRehearsalStageManifest,
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  selectWorkspaceSearchMigrationRehearsalStage,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
  type WorkspaceSearchMigrationRehearsalStageReceiptClaims,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
} from './migration-rehearsal-stage-receipt'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation-aws'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
  type CleanupWorkspaceSearchMigrationRehearsalRuntimeKeyInput,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  verifyWorkspaceSearchMigrationRehearsalRateSegment,
  verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor,
  type WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
} from './migration-rehearsal-rate-evidence'
import {
  authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
  type WorkspaceSearchMigrationRehearsalTargetAuditContext,
} from './migration-rehearsal-target-audit'
import {
  CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
} from '../../data-integrity/cross-domain-integrity'

/** Private path canary that must never be reproduced in process output. */
const permitPath = '/private/permit-canary.json'

/** Private key path canary that must never be reproduced in process output. */
const keyPath = '/private/key-canary.bin'

/** Reviewed fault-plan fixture path. */
const faultPlanPath = '/private/fault-plan-canary.json'

/** Reviewed authenticated stage manifest path. */
const stageManifestPath = '/private/stage-manifest.json'

/** Authenticated immediate-predecessor stage receipt path. */
const previousStageReceiptPath = '/private/previous-stage-receipt.json'

/** Dual-key authenticated rollback preimage selected before apply spawn. */
const targetPreimageAuditPath = '/private/target-preimage-audit.json'

/** Canonical authenticated rate segment summarized by that predecessor. */
const previousRateSegmentPath = '/private/previous-rate-segment.ndjson'

/** Fresh evidence-directory fixture path. */
const evidenceDirectory = '/private/evidence-directory-canary'

/** Reviewed measured non-production configuration fixture digest. */
const rateConfigurationHash = '9'.repeat(64)

/** Exact child wall-time budget left by a newly created reservation. */
const freshReservationRuntimeMilliseconds =
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS -
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_FINALIZATION_SAFETY_MARGIN_MILLISECONDS -
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS

/** Authentic rollback-apply inputs whose preimage bytes have two valid forms. */
type RollbackApplyPreimageProcessFixture = {
  /** Exact rollback scenario selected by the authenticated manifest. */
  readonly scenario:
    | 'complete-apply-rollback'
    | 'partial-apply-rollback'
  /** Parent-held key deriving the exact runtime and publication keys. */
  readonly masterAuthenticationKey: Uint8Array
  /** Runtime key authenticating permit, manifest, receipt, rate, and target. */
  readonly runtimeAuthenticationKey: Uint8Array
  /** Parent-only key authenticating the outer target document. */
  readonly publicationAuthenticationKey: Uint8Array
  /** Exact authenticated rehearsal permit read by the process parent. */
  readonly permit: unknown
  /** Exact authenticated manifest containing the selected apply stage. */
  readonly manifest: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageManifest
  >
  /** Immediate authenticated planning receipt preceding apply. */
  readonly previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Exact selected apply control arguments. */
  readonly controlArguments: readonly string[]
  /** Optional reviewed partial-apply fault plan. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan | null
  /** Canonical target-owned rate segment immediately after planning. */
  readonly previousRateSegmentBytes: Uint8Array
  /** Independently verified summary of that target-owned rate segment. */
  readonly expectedPreviousRateSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Genuine expected target preimage bytes A. */
  readonly artifactA: Uint8Array
  /** Genuine same-context substituted target preimage bytes B. */
  readonly artifactB: Uint8Array
  /** Authentic preimage whose integrity vector differs from the manifest. */
  readonly artifactWithForgedIntegrityVector: Uint8Array
}

/** Both rollback scenarios whose apply admission requires a preimage. */
const rollbackApplyPreimageScenarios: RollbackApplyPreimageProcessFixture[
  'scenario'
][] = [
  'complete-apply-rollback',
  'partial-apply-rollback',
]

/** Returns one conventional SHA-256 digest for deterministic test material. */
function digestProcessFixture(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Returns one required manifest entry selected by scenario and command. */
function requireProcessFixtureEntry(
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
  scenario: RollbackApplyPreimageProcessFixture['scenario'],
  command: 'close-replan' | 'apply',
): WorkspaceSearchMigrationRehearsalStageManifestEntry {
  const entry = entries.find(
    (candidate) =>
      candidate.scenario === scenario && candidate.command === command,
  )
  if (entry === undefined) throw new Error('Expected rollback fixture entry.')
  return entry
}

/** Creates one canonical target-owned empty rate successor. */
function createProcessFixtureRateSuccessor(
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  predecessorBytes: Uint8Array,
  runtimeKey: Uint8Array,
): {
  /** Exact canonical successor bytes. */
  readonly bytes: Uint8Array
  /** Finalized target-audit rate evidence over that successor. */
  readonly evidence: WorkspaceSearchMigrationRehearsalRateSegmentEvidence
  /** Independently verified successor summary used by reservations. */
  readonly verified: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
} {
  const predecessor = previousReceipt.rateSegment
  const headerClaims = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 1,
    segmentLocatorDigest: digestProcessFixture('target-rate-successor'),
    segmentOrdinal: predecessor.segmentOrdinal + 1,
    previousSegmentDigest: predecessor.segmentDigest,
    previousRecordMac: predecessor.terminalRecordMac,
    firstEventSequence:
      predecessor.firstEventSequence + predecessor.eventCount,
    anchorUtc: '2026-08-02T00:20:00.000Z',
    authenticationKeyFingerprint:
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        runtimeKey,
      ),
    policyVersion: previousReceipt.policyVersion,
    configurationBindingDigest:
      previousReceipt.configurationBindingDigest,
  })
  const mac = createHmac('sha256', runtimeKey)
    .update(
      'mukuroji:workspace-search-migration:rehearsal-rate-record:v1',
      'utf8',
    )
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(headerClaims), 'utf8')
    .digest('hex')
  const bytes = new TextEncoder().encode(
    `${serializeCanonicalJson({ ...headerClaims, mac })}\n`,
  )
  const evidence =
    finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence({
      verifiedSuccessor:
        verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
          predecessorSegmentBytes: predecessorBytes,
          successorSegmentBytes: bytes,
          authenticationKey: new Uint8Array(runtimeKey),
          expectedPolicyVersion: previousReceipt.policyVersion,
          expectedConfigurationBindingDigest:
            previousReceipt.configurationBindingDigest,
        }),
      durableEvidence: Object.freeze({
        version: 1,
        policyVersion: previousReceipt.policyVersion,
        attemptCount: 1,
        forfeitedAttemptCount: 0,
        throttleCount: 0,
        budgetStopCount: 0,
        cadenceWaitCount: 0,
        cadenceWaitMilliseconds: 0,
        maximumInFlight: 1,
      }),
      completedAt: '2026-08-02T00:20:30.000Z',
    })
  const verified = verifyWorkspaceSearchMigrationRehearsalRateSegment({
    canonicalBytes: bytes,
    authenticationKey: new Uint8Array(runtimeKey),
    expectedSegmentOrdinal: predecessor.segmentOrdinal + 1,
    expectedPolicyVersion: previousReceipt.policyVersion,
    expectedConfigurationBindingDigest:
      previousReceipt.configurationBindingDigest,
  })
  return Object.freeze({ bytes, evidence, verified })
}

/** Creates one canonical dual-key target preimage artifact variant. */
function createProcessFixtureTargetArtifact(
  manifest: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageManifest
  >,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  scenario: RollbackApplyPreimageProcessFixture['scenario'],
  rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
  variant: 'a' | 'b' | 'forged-integrity-vector',
): Uint8Array {
  if (previousReceipt.evidence.kind !== 'planning-sealed') {
    throw new Error('Expected planning receipt.')
  }
  const context: WorkspaceSearchMigrationRehearsalTargetAuditContext =
    Object.freeze({
      scenario,
      runLocatorDigest: previousReceipt.runLocatorDigest,
      manifestDigest: createMigrationDigest(manifest),
      permitDigest: manifest.permitDigest,
      requestedResourcesBinding: manifest.requestedResourcesBinding,
      configurationBindingDigest: manifest.configurationBindingDigest,
      planningReceiptDigest: createMigrationDigest(previousReceipt),
      executionBoundaryDigest:
        previousReceipt.evidence.executionBoundaryDigest,
      sealedPlanningAuthorityDigest:
        previousReceipt.evidence.sealedPlanningAuthorityDigest,
      planDigest: previousReceipt.evidence.planDigest,
      writerFenceDigest: previousReceipt.writerFenceDigest,
    })
  const aggregate = Object.freeze({
    scanned: 2,
    owned: 2,
    ignored: 0,
    keyDigest: digestProcessFixture('target-keys'),
    contentDigest: digestProcessFixture(`target-content:${variant}`),
    pageCount: 1,
  })
  const aggregateDigest = createMigrationDigest({
    scanned: aggregate.scanned,
    owned: aggregate.owned,
    ignored: aggregate.ignored,
    keyDigest: aggregate.keyDigest,
    contentDigest: aggregate.contentDigest,
  })
  const observationFields = Object.freeze({
    startedAt: '2026-08-02T00:20:00.000Z',
    observedAt: '2026-08-02T00:20:20.000Z',
    commit: manifest.commit,
    configurationHash: manifest.configurationBindingDigest,
    evidenceKeyDigest: createHash('sha256')
      .update(runtimeKey)
      .digest('hex'),
    sourceSessionBindingDigest:
      digestProcessFixture('target-source-session'),
    sourceResourceBindingDigest: manifest.requestedResourcesBinding,
    aggregate,
    aggregateDigest,
  })
  const observationDigest = createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-target-observation',
    version: 2,
    startedAt: observationFields.startedAt,
    observedAt: observationFields.observedAt,
    commit: observationFields.commit,
    configurationHash: observationFields.configurationHash,
    evidenceKeyDigest: observationFields.evidenceKeyDigest,
    sourceSessionBindingDigest:
      observationFields.sourceSessionBindingDigest,
    sourcePermitDigest: context.permitDigest,
    sourceResourceBindingDigest:
      observationFields.sourceResourceBindingDigest,
    aggregate,
    aggregateDigest,
  })
  const resourceIdentities = variant === 'forged-integrity-vector'
    ? Object.freeze(manifest.integrityResourceIdentities.map(
        (identity, index) => index === 0
          ? Object.freeze({
              ...identity,
              identityDigest:
                digestProcessFixture('forged-integrity-identity'),
            })
          : identity,
      ))
    : manifest.integrityResourceIdentities
  const integrityBefore = Object.freeze({
    checkedAt: '2026-08-02T00:19:00.000Z',
    contentDigest: digestProcessFixture('integrity-content'),
    byteLength: 1_024,
    resultDigest: digestProcessFixture('integrity-result'),
    resultMac: digestProcessFixture('integrity-mac'),
    runtimeProvenance: Object.freeze({
      kind: CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
      version: 1,
      mode: 'migration-rehearsal-live',
      startedAt: '2026-08-02T00:18:30.000Z',
      completedAt: '2026-08-02T00:19:00.000Z',
      checkedAtSource: 'trusted-wall-clock-after-external-reads',
    }),
    resourceIdentityScheme: manifest.integrityResourceIdentityScheme,
    resourceIdentities,
    integrityAggregateDigest: digestProcessFixture('integrity-aggregate'),
    resourceIdentityDigest: manifest.integrityResourceIdentityDigest,
  })
  const runtimeKeyFingerprint = createHmac('sha256', runtimeKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-key/v3\n',
      'utf8',
    )
    .digest('hex')
  const purpose:
    | 'complete-rollback-preimage'
    | 'partial-rollback-preimage' =
      scenario === 'complete-apply-rollback'
        ? 'complete-rollback-preimage'
        : 'partial-rollback-preimage'
  const unsigned = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
    purpose,
    ...observationFields,
    integrityBefore,
    context,
    terminal: null,
    observationDigest,
    rate,
    authentication: Object.freeze({
      algorithm: 'HMAC-SHA-256',
      runtimeKeyFingerprint,
    }),
  })
  const runtimeMac = createHmac('sha256', runtimeKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-mac/v3\n',
      'utf8',
    )
    .update(serializeCanonicalJson(unsigned), 'utf8')
    .digest('hex')
  const publicationKeyFingerprint = createHmac('sha256', publicationKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-key/v3\n',
      'utf8',
    )
    .digest('hex')
  const publicationUnsigned = Object.freeze({
    ...unsigned,
    authentication: Object.freeze({
      ...unsigned.authentication,
      runtimeMac,
      publicationKeyFingerprint,
    }),
  })
  const publicationMac = createHmac('sha256', publicationKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-mac/v3\n',
      'utf8',
    )
    .update(serializeCanonicalJson(publicationUnsigned), 'utf8')
    .digest('hex')
  return new TextEncoder().encode(serializeCanonicalJson({
    ...publicationUnsigned,
    authentication: {
      ...publicationUnsigned.authentication,
      publicationMac,
    },
  }))
}

/** Creates one complete rollback-apply process preimage fixture. */
function createRollbackApplyPreimageProcessFixture(
  scenario: RollbackApplyPreimageProcessFixture['scenario'],
): RollbackApplyPreimageProcessFixture {
  const base =
    createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture()
  const faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan | null =
    scenario === 'partial-apply-rollback'
      ? Object.freeze({
          stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
          approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
          failpoint: 'apply-operation-committed-before-return',
          target: Object.freeze({
            kind: 'apply-operation',
            planSequence: 1,
            remainingOperations: 'present',
          }),
        })
      : null
  const closeOnlyFlagIndex = base.controlArguments.indexOf(
    '--reviewed-dry-run-file',
  )
  const approvalIndex = base.controlArguments.indexOf('--approval')
  if (closeOnlyFlagIndex < 0 || approvalIndex < 0) {
    throw new Error('Expected close-replan control fixture fields.')
  }
  const controlArguments = base.controlArguments.slice(0, closeOnlyFlagIndex)
  controlArguments[0] = 'apply'
  controlArguments[approvalIndex + 1] =
    workspaceSearchMigrationControlApprovalLiterals.apply
  Object.freeze(controlArguments)
  const entries = base.manifest.entries.map((entry) =>
    entry.scenario === scenario && entry.command === 'apply'
      ? Object.freeze({
          ...entry,
          controlArgumentsDigest: createMigrationDigest(controlArguments),
          faultPlanDigest: faultPlan === null
            ? null
            : createMigrationDigest(faultPlan),
        })
      : entry
  )
  const { manifestMac: _manifestMac, ...manifestClaims } = base.manifest
  const manifest = createWorkspaceSearchMigrationRehearsalStageManifest({
    claims: Object.freeze({ ...manifestClaims, entries }),
    signingKey: new Uint8Array(base.authenticationKey),
  })
  const planningEntry = requireProcessFixtureEntry(
    manifest.entries,
    scenario,
    'close-replan',
  )
  requireProcessFixtureEntry(manifest.entries, scenario, 'apply')
  const { canonicalBytes: predecessorBytes, ...rateSegment } =
    base.committedRateSegment
  const leaseIdentityDigest = digestProcessFixture(`lease:${scenario}`)
  const receiptClaims: WorkspaceSearchMigrationRehearsalStageReceiptClaims = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
    receiptVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    scenario,
    stageOrdinal: planningEntry.ordinal,
    scenarioStageOrdinal: planningEntry.scenarioStageOrdinal,
    command: 'close-replan',
    controlArgumentsDigest: planningEntry.controlArgumentsDigest,
    serializedOutputLineDigest: digestProcessFixture('planning-output'),
    manifestDigest: createMigrationDigest(manifest),
    manifestEntryDigest: createMigrationDigest(planningEntry),
    permitDigest: manifest.permitDigest,
    commit: manifest.commit,
    requestedResourcesBinding: manifest.requestedResourcesBinding,
    integrityResourceIdentityScheme:
      manifest.integrityResourceIdentityScheme,
    integrityResourceIdentities: manifest.integrityResourceIdentities,
    integrityResourceIdentityDigest:
      manifest.integrityResourceIdentityDigest,
    configurationBindingDigest: manifest.configurationBindingDigest,
    policyVersion: manifest.policyVersion,
    runLocatorDigest: digestProcessFixture(`run:${scenario}`),
    attemptOrdinal: planningEntry.attemptOrdinal,
    attemptLocatorDigest: digestProcessFixture(`attempt:${scenario}`),
    ownerLocatorDigest: digestProcessFixture(`owner:${scenario}`),
    leaseIdentityDigest,
    leaseObservation: Object.freeze({
      kind: 'acquired',
      predecessorLeaseIdentityDigest: null,
      predecessorLeaseExpiresAt: null,
      acquiredAt: '2026-08-02T00:00:00.000Z',
      successorLeaseIdentityDigest: leaseIdentityDigest,
      successorLeaseExpiresAt: '2026-08-02T01:30:00.000Z',
    }),
    expectedAuthorities: Object.freeze([]),
    writerFenceDigest: digestProcessFixture(`closed-fence:${scenario}`),
    previousStageReceiptDigest: planningEntry.ordinal === 1
      ? null
      : digestProcessFixture('prior-stage-receipt'),
    stageReservationDigest: digestProcessFixture('planning-reservation'),
    stageReservationClaimRevision: planningEntry.ordinal * 2 - 1,
    stageReservationCommitRevision: planningEntry.ordinal * 2,
    stageReservationAbandonmentCount: 0,
    stageReservationAbandonmentRootDigest:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
    startedAt: '2026-08-02T00:00:00.000Z',
    completedAt: '2026-08-02T00:18:00.000Z',
    processLifecycle: Object.freeze({
      lifecycleDigest: digestProcessFixture('planning-lifecycle'),
      runnerStartedAt: '2026-08-02T00:00:00.000Z',
      receiptObservedAt: '2026-08-02T00:17:30.000Z',
      receiptPersistedAt: '2026-08-02T00:17:40.000Z',
      parentDecisionRecordedAt: null,
      processExitedAt: '2026-08-02T00:17:50.000Z',
      exitClass: 'successful-no-fault',
    }),
    outcome: 'completed',
    faultReceiptDigest: null,
    faultBoundary: null,
    predecessorLeaseExpiresAt: null,
    takeoverAcquiredAt: null,
    reconciledAt: null,
    evidence: Object.freeze({
      kind: 'planning-sealed',
      executionBoundaryDigest: digestProcessFixture(`boundary:${scenario}`),
      closedWriterFenceRecordDigest:
        digestProcessFixture(`closed-fence:${scenario}`),
      sealedPlanningAuthorityDigest:
        digestProcessFixture(`authority:${scenario}`),
      planDigest: digestProcessFixture(`plan:${scenario}`),
      sealedPlanOperationCount: 3,
      sourceOperationCount: 2,
      orphanOperationCount: 1,
      closedAt: '2026-08-02T00:01:00.000Z',
      drainStartedAt: '2026-08-02T00:01:15.000Z',
      drainCompletedAt: '2026-08-02T00:16:15.000Z',
      admittedAt: '2026-08-02T00:16:30.000Z',
      planCreatedAt: '2026-08-02T00:17:00.000Z',
      sealedAt: '2026-08-02T00:17:30.000Z',
    }),
    rateSegment: Object.freeze(rateSegment),
  }
  const previousReceipt =
    createWorkspaceSearchMigrationRehearsalStageReceipt({
      claims: receiptClaims,
      signingKey: new Uint8Array(base.authenticationKey),
    })
  const rate = createProcessFixtureRateSuccessor(
    previousReceipt,
    predecessorBytes,
    base.authenticationKey,
  )
  return Object.freeze({
    scenario,
    masterAuthenticationKey:
      new Uint8Array(base.masterAuthenticationKey),
    runtimeAuthenticationKey: new Uint8Array(base.authenticationKey),
    publicationAuthenticationKey:
      new Uint8Array(base.publicationAuthenticationKey),
    permit: base.permit,
    manifest,
    previousReceipt,
    controlArguments,
    faultPlan,
    previousRateSegmentBytes: new Uint8Array(rate.bytes),
    expectedPreviousRateSegment: rate.verified,
    artifactA: createProcessFixtureTargetArtifact(
      manifest,
      previousReceipt,
      scenario,
      rate.evidence,
      base.authenticationKey,
      base.publicationAuthenticationKey,
      'a',
    ),
    artifactB: createProcessFixtureTargetArtifact(
      manifest,
      previousReceipt,
      scenario,
      rate.evidence,
      base.authenticationKey,
      base.publicationAuthenticationKey,
      'b',
    ),
    artifactWithForgedIntegrityVector: createProcessFixtureTargetArtifact(
      manifest,
      previousReceipt,
      scenario,
      rate.evidence,
      base.authenticationKey,
      base.publicationAuthenticationKey,
      'forged-integrity-vector',
    ),
  })
}

/** Creates a genuine cleanup capability for one isolated dependency harness. */
async function createProcessCliTestCleanupAuthorization(
  input: CleanupWorkspaceSearchMigrationRehearsalRuntimeKeyInput,
  persistedMaterialReservation: unknown,
): Promise<WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization> {
  const directory = await mkdtemp(join(tmpdir(), 'mukuroji-process-cleanup-'))
  const timestamps = [
    '2026-08-02T01:00:00.008Z',
    '2026-08-02T01:00:00.009Z',
  ]
  let clockIndex = 0
  try {
    await writeFile(
      join(directory, WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME),
      input.expectedRuntimeKey,
      { mode: 0o600 },
    )
    return await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
      ...input,
      evidenceDirectory: directory,
      reservation: persistedMaterialReservation,
      now: (): Date => {
        const timestamp = timestamps[clockIndex]
        clockIndex += 1
        if (timestamp === undefined) throw new Error('Unexpected clock read.')
        return new Date(timestamp)
      },
    })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

/** Private child output canary that must be retained only through a digest. */
const childOutputCanary = 'raw-child-output-must-not-escape'

/** Promise paired with one explicit idempotent resolver. */
type Deferred<Value> = {
  /** Pending Promise controlled by the resolver. */
  readonly promise: Promise<Value>
  /** Resolves the pending Promise with one value. */
  readonly resolve: (value: Value) => void
}

/** Captured immutable evidence-file write. */
type EvidenceWrite = {
  /** Exact fixed filename selected by the parent. */
  readonly filename: WorkspaceSearchMigrationRehearsalEvidenceFilename
  /** Detached canonical evidence bytes. */
  readonly bytes: Uint8Array
}

/** Integration harness for one fake isolated child. */
type ChildHarness = {
  /** Strict process port consumed by the real lifecycle runner. */
  readonly port: WorkspaceSearchMigrationRehearsalProcessPort
  /** Ordered externally visible protocol events. */
  readonly events: string[]
}

/** Complete dependency harness with captured side effects. */
type DependencyHarness = {
  /** Injectable CLI dependencies. */
  readonly dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies
  /** Ordered immutable evidence writes. */
  readonly evidenceWrites: EvidenceWrite[]
  /** Captured safe stdout lines. */
  readonly stdoutLines: string[]
  /** Captured safe stderr lines. */
  readonly stderrLines: string[]
  /** Captured exact child wrapper arguments. */
  readonly childArguments: string[][]
  /** Returns the currently installed interruption listener. */
  readonly readSignalHandler: () =>
    | ((signal: WorkspaceSearchMigrationRehearsalParentSignal) => void)
    | undefined
}

/**
 * Creates one deterministic externally resolved Promise.
 *
 * @returns Promise and explicit idempotent resolver.
 */
function createDeferred<Value>(): Deferred<Value> {
  let resolver: ((value: Value) => void) | undefined
  let settled = false
  const promise = new Promise<Value>((resolvePromise) => {
    resolver = resolvePromise
  })
  return Object.freeze({
    promise,
    resolve: (value: Value): void => {
      if (settled) return
      settled = true
      if (resolver === undefined) throw new Error('missing resolver')
      resolver(value)
    },
  })
}

/**
 * Creates one valid reviewed canonical fault plan.
 *
 * @param responseLoss - Whether to select the response-loss boundary.
 * @returns Strict one-shot fault plan fixture.
 */
function createFaultPlan(
  responseLoss = false,
): WorkspaceSearchMigrationRehearsalFaultPlan {
  return {
    stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
    failpoint: responseLoss
      ? 'planning-page-transaction-response-lost'
      : 'planning-page-artifact-uploaded-before-checkpoint-commit',
    target: {
      kind: 'source',
      source: 'documents',
      pageSequence: 2,
      cursorState: 'present',
    },
  }
}

/**
 * Encodes one exact canonical plan file.
 *
 * @param plan - Strict reviewed plan fixture.
 * @returns Canonical UTF-8 bytes.
 */
function encodeFaultPlan(
  plan: WorkspaceSearchMigrationRehearsalFaultPlan,
): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(plan))
}

/**
 * Authenticates a parent-created token and returns its exact claimed head.
 *
 * @param candidate - Reservation candidate passed to the fake AWS boundary.
 * @param fixture - Independently authenticated expected stage fixture.
 * @param verificationKey - Runtime key passed to the fake AWS boundary.
 * @returns Exact active durable-head projection for the candidate token.
 */
function createClaimedHeadForParentReservation(
  candidate: unknown,
  fixture:
    | ReturnType<
      typeof createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture
    >
    | WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageHead {
  const reservation =
    verifyWorkspaceSearchMigrationRehearsalStageReservation({
      reservation: candidate,
      selection: fixture.selection,
      verificationKey,
    })
  return Object.freeze({
    ...fixture.claimedStageHead,
    activeReservationDigest: createMigrationDigest(reservation),
    activeExpiresAt: reservation.expiresAt,
  })
}

/**
 * Creates one runtime receipt matching a reviewed plan.
 *
 * @param plan - Strict reviewed plan fixture.
 * @returns Canonical runtime receipt fixture.
 */
function createFaultReceipt(
  plan: WorkspaceSearchMigrationRehearsalFaultPlan,
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  const expected =
    createWorkspaceSearchMigrationRehearsalExpectedFaultReceipt(plan)
  return {
    ...expected,
    reachedAt: '2026-08-02T01:00:00.000Z',
  }
}

/** Returns the strict terminal command for one no-fault scenario fixture. */
function readNoFaultCommand(
  scenario: WorkspaceSearchMigrationRehearsalNoFaultScenario,
): 'verify' | 'rollback-complete' {
  return scenario === 'happy-path-verified' ? 'verify' : 'rollback-complete'
}

/** Creates one strict child no-fault completion receipt fixture. */
function createNoFaultReceipt(
  scenario: WorkspaceSearchMigrationRehearsalNoFaultScenario,
): WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt {
  const terminalCommand = readNoFaultCommand(scenario)
  return parseWorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_RECEIPT_KIND,
    lifecycleVersion: 1,
    scenario,
    purpose: scenario === 'happy-path-verified'
      ? 'verified'
      : 'complete-rollback',
    terminalCommand,
    terminalKind: scenario === 'happy-path-verified'
      ? 'verified'
      : 'rolled-back',
    permitDigest: '1'.repeat(64),
    controlArgumentsDigest: createMigrationDigest([terminalCommand]),
    requestedResourcesBinding: '2'.repeat(64),
    policyVersion: '3'.repeat(64),
    configurationBindingDigest: rateConfigurationHash,
    rateSegment: {
      authenticationKeyFingerprint: '7'.repeat(64),
      segmentLocatorDigest: '4'.repeat(64),
      segmentOrdinal: 0,
      eventCount: 2,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 2,
      terminalRecordMac: '5'.repeat(64),
      segmentDigest: '6'.repeat(64),
    },
  })
}

/** Encodes one exact LF-terminated no-fault FD3 receipt line. */
function encodeNoFaultReceiptLine(
  receipt: WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt,
): Uint8Array {
  return new TextEncoder().encode(`${serializeCanonicalJson(receipt)}\n`)
}

/**
 * Yields finite chunks and remains open until the process termination event.
 *
 * @param chunks - Ordered process-output chunks.
 * @param terminated - Final process termination Promise.
 */
async function* createProcessStream(
  chunks: readonly Uint8Array[],
  terminated: Promise<WorkspaceSearchMigrationRehearsalProcessExitResult>,
): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk
  await terminated
}

/** Yields finite chunks and then closes without waiting for process exit. */
async function* createFiniteProcessStream(
  chunks: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk
}

/**
 * Collects one finite process byte stream without decoding private content.
 *
 * @param stream - Finite isolated process stream.
 * @returns Exact observed byte count.
 */
async function countProcessBytes(
  stream: AsyncIterable<Uint8Array>,
): Promise<number> {
  let byteLength = 0
  for await (const chunk of stream) byteLength += chunk.byteLength
  return byteLength
}

/** Creates one no-fault child that exits only after the durable parent ACK. */
function createNoFaultChildHarness(
  receipt: WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt,
): ChildHarness {
  const terminated =
    createDeferred<WorkspaceSearchMigrationRehearsalProcessExitResult>()
  const events: string[] = []
  let acknowledged = false
  let killed = false
  const port: WorkspaceSearchMigrationRehearsalProcessPort = {
    stdout: createProcessStream(
      [new TextEncoder().encode(childOutputCanary)],
      terminated.promise,
    ),
    stderr: createProcessStream(
      [encodeNoFaultReceiptLine(receipt)],
      terminated.promise,
    ),
    exited: terminated.promise,
    kill: (signal): void => {
      events.push(`kill:${signal}`)
      if (killed || acknowledged) throw new Error('duplicate termination')
      killed = true
      terminated.resolve({ kind: 'signal', signal })
    },
    acknowledgeResponseLoss: (receiptSha256): void => {
      events.push(`ack:${receiptSha256}`)
      if (killed || acknowledged) throw new Error('duplicate acknowledgement')
      acknowledged = true
      terminated.resolve({ kind: 'exit-code', exitCode: 0 })
    },
  }
  return { port, events }
}

/**
 * Creates the exact reviewed parent CLI argument vector.
 *
 * @returns Exact ordered preamble and existing control arguments.
 */
function createCliArguments(): readonly string[] {
  return [
    '--rehearsal-permit-file',
    permitPath,
    '--rehearsal-authentication-key-file',
    keyPath,
    '--rehearsal-fault-plan-file',
    faultPlanPath,
    '--rehearsal-evidence-directory',
    evidenceDirectory,
    '--rehearsal-rate-configuration-hash',
    rateConfigurationHash,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL,
    '--',
    'apply',
    '--evidence',
    '/private/control-evidence-canary.json',
  ]
}

/** Creates one exact authenticated fault parent argument vector. */
function createAuthenticatedFaultCliArguments(
  fixture: WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
): readonly string[] {
  return [
    '--rehearsal-permit-file',
    permitPath,
    '--rehearsal-authentication-key-file',
    keyPath,
    '--rehearsal-fault-plan-file',
    faultPlanPath,
    '--rehearsal-evidence-directory',
    evidenceDirectory,
    '--rehearsal-rate-configuration-hash',
    fixture.configurationBindingDigest,
    '--rehearsal-rate-previous-segment-file',
    previousRateSegmentPath,
    '--rehearsal-stage-manifest-file',
    stageManifestPath,
    '--rehearsal-previous-stage-receipt-file',
    previousStageReceiptPath,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL,
    '--',
    ...fixture.controlArguments,
  ]
}

/** Creates one exact rollback-apply invocation with its pinned preimage. */
function createRollbackApplyPreimageCliArguments(
  fixture: RollbackApplyPreimageProcessFixture,
  includeTargetPreimage = true,
): readonly string[] {
  const execution = fixture.faultPlan === null
    ? [
        '--rehearsal-success-protocol',
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION,
      ]
    : ['--rehearsal-fault-plan-file', faultPlanPath]
  const approval = fixture.faultPlan === null
    ? WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROCESS_APPROVAL
    : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL
  return Object.freeze([
    '--rehearsal-permit-file',
    permitPath,
    '--rehearsal-authentication-key-file',
    keyPath,
    ...execution,
    '--rehearsal-evidence-directory',
    evidenceDirectory,
    '--rehearsal-rate-configuration-hash',
    fixture.manifest.configurationBindingDigest,
    '--rehearsal-rate-previous-segment-file',
    previousRateSegmentPath,
    '--rehearsal-stage-manifest-file',
    stageManifestPath,
    '--rehearsal-previous-stage-receipt-file',
    previousStageReceiptPath,
    ...(includeTargetPreimage
      ? ['--target-preimage-audit-file', targetPreimageAuditPath]
      : []),
    '--approval',
    approval,
    '--',
    ...fixture.controlArguments,
  ])
}

/** Creates the bounded reader for one rollback preimage process test. */
function createRollbackApplyPreimageReader(
  fixture: RollbackApplyPreimageProcessFixture,
  artifactBytes: Uint8Array,
  reservationBytes?: Uint8Array,
): WorkspaceSearchMigrationRehearsalProcessCliDependencies['readInputFile'] {
  return async (path): Promise<Uint8Array> => {
    if (path === permitPath) {
      return new TextEncoder().encode(serializeCanonicalJson(fixture.permit))
    }
    if (path === stageManifestPath) {
      return new TextEncoder().encode(
        serializeCanonicalJson(fixture.manifest),
      )
    }
    if (path === previousStageReceiptPath) {
      return new TextEncoder().encode(
        serializeCanonicalJson(fixture.previousReceipt),
      )
    }
    if (path === previousRateSegmentPath) {
      return new Uint8Array(fixture.previousRateSegmentBytes)
    }
    if (path === targetPreimageAuditPath) {
      return new Uint8Array(artifactBytes)
    }
    if (path === faultPlanPath && fixture.faultPlan !== null) {
      return encodeFaultPlan(fixture.faultPlan)
    }
    if (
      reservationBytes !== undefined &&
      path === join(
        evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
      )
    ) return new Uint8Array(reservationBytes)
    throw new Error('Unexpected rollback preimage input path.')
  }
}

/** Creates one exact reviewed no-fault parent argument vector. */
function createNoFaultCliArguments(
  scenario: WorkspaceSearchMigrationRehearsalNoFaultScenario,
): readonly string[] {
  return [
    '--rehearsal-permit-file',
    permitPath,
    '--rehearsal-authentication-key-file',
    keyPath,
    '--rehearsal-no-fault-scenario',
    scenario,
    '--rehearsal-evidence-directory',
    evidenceDirectory,
    '--rehearsal-rate-configuration-hash',
    rateConfigurationHash,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_PROCESS_APPROVAL,
    '--',
    readNoFaultCommand(scenario),
  ]
}

/** Creates one stage-bound no-fault parent argument vector for parser tests. */
function createAuthenticatedNoFaultCliArguments(
  scenario: WorkspaceSearchMigrationRehearsalNoFaultScenario,
): readonly string[] {
  const legacy = createNoFaultCliArguments(scenario)
  const approvalIndex = legacy.indexOf('--approval')
  if (approvalIndex < 0) throw new Error('Missing no-fault approval fixture.')
  return Object.freeze([
    ...legacy.slice(0, approvalIndex),
    '--rehearsal-stage-manifest-file',
    stageManifestPath,
    ...legacy.slice(approvalIndex),
  ])
}

/** Creates one exact reviewed authenticated generic-success parent command. */
function createSuccessfulCliArguments(
  controlArguments: readonly string[],
  configurationBindingDigest: string,
  targetEvidenceDirectory: string = evidenceDirectory,
): readonly string[] {
  return [
    '--rehearsal-permit-file',
    permitPath,
    '--rehearsal-authentication-key-file',
    keyPath,
    '--rehearsal-success-protocol',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROTOCOL_VERSION,
    '--rehearsal-evidence-directory',
    targetEvidenceDirectory,
    '--rehearsal-rate-configuration-hash',
    configurationBindingDigest,
    '--rehearsal-stage-manifest-file',
    stageManifestPath,
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUCCESS_PROCESS_APPROVAL,
    '--',
    ...controlArguments,
  ]
}

/**
 * Re-signs the global first entry for one exact control argument vector.
 *
 * @param fixture - Authentic global-stage-one fixture owning the stage key.
 * @param controlArguments - Exact candidate first-stage control vector.
 * @returns Authentic manifest whose first entry binds those arguments.
 */
function createProcessCliManifestForControlArguments(
  fixture: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture
  >,
  controlArguments: readonly string[],
): ReturnType<typeof createWorkspaceSearchMigrationRehearsalStageManifest> {
  const entries = fixture.manifest.entries.map((entry, index) =>
    index === 0
      ? Object.freeze({
          ...entry,
          controlArgumentsDigest: createMigrationDigest(controlArguments),
        })
      : entry
  )
  const { manifestMac: _manifestMac, ...claims } = fixture.manifest
  return createWorkspaceSearchMigrationRehearsalStageManifest({
    claims: Object.freeze({ ...claims, entries: Object.freeze(entries) }),
    signingKey: new Uint8Array(fixture.authenticationKey),
  })
}

/**
 * Creates captured dependencies around one fake child and plan.
 *
 * @param plan - Canonical plan returned by the bounded file reader.
 * @param childHarness - Fake isolated child.
 * @returns Complete captured dependency harness.
 */
function createDependencyHarness(
  plan: WorkspaceSearchMigrationRehearsalFaultPlan,
  childHarness: ChildHarness,
): DependencyHarness {
  const evidenceWrites: EvidenceWrite[] = []
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  const childArguments: string[][] = []
  let signalHandler:
    | ((signal: WorkspaceSearchMigrationRehearsalParentSignal) => void)
    | undefined
  const installSignalHandler:
    WorkspaceSearchMigrationRehearsalInstallSignalHandler = (handler) => {
      signalHandler = handler
      return (): void => {
        signalHandler = undefined
      }
    }
  const dependencies:
    WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      readInputFile: async (path, maximumBytes): Promise<Uint8Array> => {
        expect(path).toBe(faultPlanPath)
        expect(maximumBytes).toBe(
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_FAULT_PLAN_MAX_BYTES,
        )
        return encodeFaultPlan(plan)
      },
      createEvidenceDirectoryExclusive: async (path) => {
        expect(path).toBe(evidenceDirectory)
        return 'created'
      },
      writeEvidenceFileExclusive: async (path, filename, bytes) => {
        expect(path).toBe(evidenceDirectory)
        evidenceWrites.push({ filename, bytes: bytes.slice() })
        childHarness.events.push(`write:${filename}`)
        return 'created'
      },
      spawnControlChild: (arguments_) => {
        childArguments.push([...arguments_])
        return childHarness.port
      },
      runProcess: runWorkspaceSearchMigrationRehearsalProcess,
      runNoFaultProcess:
        runWorkspaceSearchMigrationRehearsalNoFaultProcess,
      installSignalHandler,
      writeStdoutLine: (line): void => {
        stdoutLines.push(line)
      },
      writeStderrLine: (line): void => {
        stderrLines.push(line)
      },
    }
  return {
    dependencies,
    evidenceWrites,
    stdoutLines,
    stderrLines,
    childArguments,
    readSignalHandler: () => signalHandler,
  }
}

/** Complete authenticated fault parent harness and its trusted materials. */
type AuthenticatedFaultDependencyHarness = DependencyHarness & {
  /** Ordered fake-runner and durable-writer events. */
  readonly events: string[]
  /** Authenticated first-phase material persisted by the fake runner. */
  readonly boundary:
    WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  /** Optional authenticated response-loss completion material. */
  readonly completion?:
    WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial
}

/**
 * Creates a parent harness over fully authenticated selection-bound material.
 *
 * @param fixture - Authentic barrier or response-loss selected-stage fixture.
 * @returns Captured CLI effects plus the exact injected runner materials.
 */
function createAuthenticatedFaultDependencyHarness(
  fixture: WorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture,
): AuthenticatedFaultDependencyHarness {
  const receipt = createFaultReceipt(fixture.faultPlan)
  const boundary =
    createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
      selection: fixture.selection,
      faultPlan: fixture.faultPlan,
      faultReceipt: receipt,
      committedRateSegment: fixture.committedRateSegment,
      stageReservation: fixture.stageReservation,
      claimedStageHead: fixture.claimedStageHead,
      leaseAcquisitionObservation:
        fixture.leaseAcquisitionObservation,
      faultObservation: fixture.faultObservation,
      authenticationKey: fixture.authenticationKey,
    })
  const responseLoss = receipt.action === 'response-loss'
  const completion = responseLoss
    ? createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        selection: fixture.selection,
        faultPlan: fixture.faultPlan,
        boundaryMaterial: boundary,
        boundaryRateSegmentBytes:
          fixture.committedRateSegment.canonicalBytes,
        observation:
          captureWorkspaceSearchMigrationRehearsalChildMutationObservation({
            selection: fixture.selection,
            authenticationKey: fixture.authenticationKey,
            observation: fixture.observation,
          }),
        committedRateSegment: fixture.committedRateSegment,
        authenticationKey: fixture.authenticationKey,
      })
    : undefined
  const evidenceWrites: EvidenceWrite[] = []
  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  const childArguments: string[][] = []
  const events: string[] = []
  let signalHandler:
    | ((signal: WorkspaceSearchMigrationRehearsalParentSignal) => void)
    | undefined
  const masterKey = new Uint8Array(fixture.masterAuthenticationKey)
  const dummyPort: WorkspaceSearchMigrationRehearsalProcessPort = {
    stdout: createFiniteProcessStream([]),
    stderr: createFiniteProcessStream([]),
    exited: Promise.resolve({ kind: 'exit-code', exitCode: 0 }),
    kill: (signal): void => {
      events.push(`kill:${signal}`)
    },
    acknowledgeResponseLoss: (digestValue, final): void => {
      events.push(`ack:${final === false ? 'boundary' : 'completion'}:${digestValue}`)
    },
  }
  const lifecycle = createAuthenticatedFaultLifecycleFixture(
    boundary,
    completion,
  )
  const dependencies:
    WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      readInputFile: async (path): Promise<Uint8Array> => {
        if (path === faultPlanPath) return encodeFaultPlan(fixture.faultPlan)
        if (path === permitPath) {
          return new TextEncoder().encode(
            serializeCanonicalJson(fixture.permit),
          )
        }
        if (path === stageManifestPath) {
          return new TextEncoder().encode(
            serializeCanonicalJson(fixture.manifest),
          )
        }
        if (path === previousStageReceiptPath) {
          return new TextEncoder().encode(
            serializeCanonicalJson(fixture.previousReceipt),
          )
        }
        if (path === previousRateSegmentPath) {
          return new Uint8Array(
            fixture.previousCommittedRateSegment.canonicalBytes,
          )
        }
        if (path === fixture.ratePolicyFile) {
          return new Uint8Array(fixture.ratePolicyBytes)
        }
        if (
          path === join(
            evidenceDirectory,
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
          )
        ) return fixture.committedRateSegment.canonicalBytes
        throw new Error('Unexpected authenticated input path.')
      },
      readStageKeyFile: async (path): Promise<Uint8Array> => {
        if (path === keyPath) return masterKey
        throw new Error('Unexpected authenticated key path.')
      },
      createEvidenceDirectoryExclusive: async (): Promise<'created'> =>
        'created',
      writeEvidenceFileExclusive: async (_path, filename, bytes) => {
        evidenceWrites.push({ filename, bytes: bytes.slice() })
        events.push(`write:${filename}`)
        return 'created'
      },
      claimStageReservation: async (input) =>
        createClaimedHeadForParentReservation(
          input.stageReservationClaim.reservation,
          fixture,
          input.stageReservationClaim.stageKey,
        ),
      writeRuntimeKeyFileExclusive: async (_path, key) => {
        expect(key).toEqual(fixture.authenticationKey)
        events.push('write:runtime-key')
        return 'created'
      },
      cleanupRuntimeKeyFile: async (input) => {
        events.push('remove:runtime-key')
        return await createProcessCliTestCleanupAuthorization(
          input,
          boundary.stageReservation,
        )
      },
      now: (): Date => new Date('2026-08-02T00:10:30.000Z'),
      randomBytes: (): Uint8Array => new Uint8Array(32).fill(0x42),
      spawnControlChild: (arguments_) => {
        childArguments.push([...arguments_])
        return dummyPort
      },
      runProcess: runWorkspaceSearchMigrationRehearsalProcess,
      runAuthenticatedFaultProcess: async (input) => {
        expect(input.runtimeTimeoutMilliseconds).toBe(
          freshReservationRuntimeMilliseconds,
        )
        expect(input.containmentTimeoutMilliseconds).toBe(
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
        )
        expect(input.now?.()).toBe('2026-08-02T00:10:30.000Z')
        await input.persistBoundaryMaterialDurably(
          Object.freeze({
            material: boundary,
            materialDigest: createMigrationDigest(boundary),
            observedAt: '2026-08-02T01:00:00.001Z',
          }),
          new AbortController().signal,
        )
        events.push(responseLoss ? 'ack:boundary' : 'kill:SIGKILL')
        if (completion !== undefined) {
          await input.persistCompletionMaterialDurably(
            Object.freeze({
              material: completion,
              materialDigest: createMigrationDigest(completion),
              observedAt: '2026-08-02T01:00:00.004Z',
            }),
            new AbortController().signal,
          )
          events.push('ack:completion')
        }
        return lifecycle
      },
      runNoFaultProcess:
        runWorkspaceSearchMigrationRehearsalNoFaultProcess,
      installSignalHandler: (handler) => {
        signalHandler = handler
        return (): void => {
          signalHandler = undefined
        }
      },
      writeStdoutLine: (line): void => {
        stdoutLines.push(line)
      },
      writeStderrLine: (line): void => {
        stderrLines.push(line)
      },
    }
  return Object.freeze({
    dependencies,
    evidenceWrites,
    stdoutLines,
    stderrLines,
    childArguments,
    readSignalHandler: () => signalHandler,
    events,
    boundary,
    ...(completion === undefined ? {} : { completion }),
  })
}

/**
 * Creates deterministic lifecycle evidence matching authenticated materials.
 *
 * @param boundary - Persisted authenticated boundary material.
 * @param completion - Optional persisted response-loss completion material.
 * @returns Exact digest-only authenticated fault lifecycle fixture.
 */
function createAuthenticatedFaultLifecycleFixture(
  boundary: WorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  completion:
    WorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial | undefined,
): WorkspaceSearchMigrationRehearsalAuthenticatedFaultProcessLifecycleEvidence {
  return Object.freeze({
    lifecycleVersion: 1,
    manifestDigest: boundary.manifestDigest,
    manifestEntryDigest: boundary.manifestEntryDigest,
    previousStageReceiptDigest: boundary.previousStageReceiptDigest,
    stageOrdinal: boundary.stageOrdinal,
    scenario: boundary.scenario,
    command: boundary.command,
    attemptOrdinal: boundary.attemptOrdinal,
    expectedOutcome: boundary.expectedOutcome,
    faultPlanDigest: boundary.faultPlanDigest,
    faultReceiptDigest: boundary.faultReceiptDigest,
    boundaryMaterialDigest: createMigrationDigest(boundary),
    completionMaterialDigest: completion === undefined
      ? null
      : createMigrationDigest(completion),
    stdoutSha256: 'b'.repeat(64),
    materialStreamSha256: 'c'.repeat(64),
    runnerStartedAt: '2026-08-02T01:00:00.000Z',
    boundaryMaterialObservedAt: '2026-08-02T01:00:00.001Z',
    boundaryMaterialPersistedAt: '2026-08-02T01:00:00.002Z',
    boundaryDecisionRecordedAt: '2026-08-02T01:00:00.003Z',
    completionMaterialObservedAt: completion === undefined
      ? null
      : '2026-08-02T01:00:00.004Z',
    completionMaterialPersistedAt: completion === undefined
      ? null
      : '2026-08-02T01:00:00.005Z',
    completionDecisionRecordedAt: completion === undefined
      ? null
      : '2026-08-02T01:00:00.006Z',
    processExitedAt: completion === undefined
      ? '2026-08-02T01:00:00.004Z'
      : '2026-08-02T01:00:00.007Z',
    exitClass: completion === undefined
      ? 'confirmed-sigkill'
      : 'successful-response-loss',
  })
}

describe('migration rehearsal process CLI arguments', () => {
  test('accepts only the exact ordered preamble and preserves control arguments', () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    expect(
      parseWorkspaceSearchMigrationRehearsalProcessCliArguments(
        createAuthenticatedFaultCliArguments(fixture),
      ),
    ).toEqual({
      permitFile: permitPath,
      authenticationKeyFile: keyPath,
      executionMode: 'fault',
      faultPlanFile: faultPlanPath,
      evidenceDirectory,
      rateConfigurationHash: fixture.configurationBindingDigest,
      ratePreviousSegmentFile: previousRateSegmentPath,
      stageManifestFile: stageManifestPath,
      previousStageReceiptFile: previousStageReceiptPath,
      approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL,
      controlArguments: fixture.controlArguments,
    })
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalProcessCliArguments(
        createNoFaultCliArguments('happy-path-verified'),
      )
    ).toThrow('INVALID_USAGE')
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalProcessCliArguments(
        createAuthenticatedNoFaultCliArguments('happy-path-verified'),
      )
    ).toThrow('INVALID_USAGE')
  })

  test('rejects malformed, reordered, or unsafe commands', () => {
    const invalidCommands: readonly (readonly string[])[] = [
      createCliArguments(),
      createCliArguments().slice(0, 11),
      [
        '--rehearsal-authentication-key-file',
        keyPath,
        '--rehearsal-permit-file',
        permitPath,
        ...createCliArguments().slice(4),
      ],
      createCliArguments().filter((value) => value !== '--'),
      createCliArguments().map((value) =>
        value === faultPlanPath ? `${faultPlanPath}\0suffix` : value
      ),
      [
        ...createNoFaultCliArguments('complete-apply-rollback').slice(0, -1),
        'verify',
      ],
      createCliArguments().map((value) =>
        value === WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_APPROVAL
          ? WORKSPACE_SEARCH_MIGRATION_REHEARSAL_NO_FAULT_PROCESS_APPROVAL
          : value
      ),
    ]
    for (const arguments_ of invalidCommands) {
      expect(() =>
        parseWorkspaceSearchMigrationRehearsalProcessCliArguments(arguments_)
      ).toThrow('INVALID_USAGE')
    }
  })
})

describe('migration rehearsal rollback apply preimage admission', () => {
  test.each(rollbackApplyPreimageScenarios)(
    'authenticates %s preimage A before creating its reservation',
    async (scenario) => {
      const fixture =
        createRollbackApplyPreimageProcessFixture(scenario)
      expect(() => parseWorkspaceSearchMigrationRehearsalProcessCliArguments(
        createRollbackApplyPreimageCliArguments(fixture),
      )).not.toThrow()
      expect(() => selectWorkspaceSearchMigrationRehearsalStage({
        manifest: fixture.manifest,
        verificationKey: new Uint8Array(fixture.runtimeAuthenticationKey),
        previousReceipt: fixture.previousReceipt,
        controlArguments: fixture.controlArguments,
        faultPlanDigest: fixture.faultPlan === null
          ? null
          : createMigrationDigest(fixture.faultPlan),
      })).not.toThrow()
      if (fixture.previousReceipt.evidence.kind !== 'planning-sealed') {
        throw new Error('Expected planning fixture.')
      }
      const expectedContext = Object.freeze({
        scenario,
        runLocatorDigest: fixture.previousReceipt.runLocatorDigest,
        manifestDigest: createMigrationDigest(fixture.manifest),
        permitDigest: fixture.manifest.permitDigest,
        requestedResourcesBinding:
          fixture.manifest.requestedResourcesBinding,
        configurationBindingDigest:
          fixture.manifest.configurationBindingDigest,
        planningReceiptDigest:
          createMigrationDigest(fixture.previousReceipt),
        executionBoundaryDigest:
          fixture.previousReceipt.evidence.executionBoundaryDigest,
        sealedPlanningAuthorityDigest:
          fixture.previousReceipt.evidence.sealedPlanningAuthorityDigest,
        planDigest: fixture.previousReceipt.evidence.planDigest,
        writerFenceDigest: fixture.previousReceipt.writerFenceDigest,
      })
      expect(() =>
        authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
          artifactBytes: fixture.artifactA,
          expectedContext,
          purpose: scenario === 'complete-apply-rollback'
            ? 'complete-rollback-preimage'
            : 'partial-rollback-preimage',
          terminal: null,
        }, new Uint8Array(fixture.runtimeAuthenticationKey),
        new Uint8Array(fixture.publicationAuthenticationKey))
      ).not.toThrow()
      let directoryCalls = 0
      let reservationWrites = 0
      let claimCalls = 0
      let spawnCalls = 0
      const stderrLines: string[] = []
      const exitCode = await runWorkspaceSearchMigrationRehearsalProcessCli(
        createRollbackApplyPreimageCliArguments(fixture),
        {
          readInputFile: createRollbackApplyPreimageReader(
            fixture,
            fixture.artifactA,
          ),
          readStageKeyFile: async () =>
            new Uint8Array(fixture.masterAuthenticationKey),
          createEvidenceDirectoryExclusive: async () => {
            directoryCalls += 1
            return 'created'
          },
          writeEvidenceFileExclusive: async (_directory, filename, bytes) => {
            expect(filename).toBe(
              WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
            )
            reservationWrites += 1
            const selection = selectWorkspaceSearchMigrationRehearsalStage({
              manifest: fixture.manifest,
              verificationKey:
                new Uint8Array(fixture.runtimeAuthenticationKey),
              previousReceipt: fixture.previousReceipt,
              controlArguments: fixture.controlArguments,
              faultPlanDigest: fixture.faultPlan === null
                ? null
                : createMigrationDigest(fixture.faultPlan),
            })
            const reservation =
              verifyWorkspaceSearchMigrationRehearsalStageReservation(
                {
                  reservation:
                    JSON.parse(new TextDecoder().decode(bytes)),
                  selection,
                  verificationKey:
                    new Uint8Array(fixture.runtimeAuthenticationKey),
                },
              )
            expect(
              reservation.expectedTargetPreimageArtifactContentDigest,
            ).toBe(createHash('sha256').update(fixture.artifactA).digest('hex'))
            return 'created'
          },
          claimStageReservation: async () => {
            claimCalls += 1
            throw new Error('Claim must not be reached by fixture arguments.')
          },
          now: () => new Date('2026-08-02T00:21:00.000Z'),
          randomBytes: () => new Uint8Array(32).fill(0x31),
          spawnControlChild: () => {
            spawnCalls += 1
            throw new Error('Spawn must not be reached.')
          },
          runProcess: runWorkspaceSearchMigrationRehearsalProcess,
          runNoFaultProcess:
            runWorkspaceSearchMigrationRehearsalNoFaultProcess,
          installSignalHandler: () => () => undefined,
          writeStdoutLine: () => undefined,
          writeStderrLine: (line) => {
            stderrLines.push(line)
          },
        },
      )
      expect({
        exitCode,
        directoryCalls,
        reservationWrites,
        claimCalls,
        spawnCalls,
        stderrLines,
      }).toEqual({
        exitCode: 2,
        directoryCalls: 1,
        reservationWrites: 1,
        claimCalls: 0,
        spawnCalls: 0,
        stderrLines: [
          '{"code":"INVALID_STAGE_SELECTION","kind":"mukuroji-workspace-search-migration-rehearsal-process-result","status":"error"}',
        ],
      })
    },
  )

  test.each(rollbackApplyPreimageScenarios)(
    'rejects missing, malformed, or integrity-mismatched %s preimages before reservation or spawn',
    async (scenario) => {
      const fixture =
        createRollbackApplyPreimageProcessFixture(scenario)
      for (const candidate of [
        Object.freeze({ include: false, bytes: fixture.artifactA }),
        Object.freeze({
          include: true,
          bytes: new TextEncoder().encode('{"wrong":true}'),
        }),
        Object.freeze({
          include: true,
          bytes: fixture.artifactWithForgedIntegrityVector,
        }),
      ]) {
        let directoryCalls = 0
        let spawnCalls = 0
        const exitCode =
          await runWorkspaceSearchMigrationRehearsalProcessCli(
            createRollbackApplyPreimageCliArguments(
              fixture,
              candidate.include,
            ),
            {
              readInputFile: createRollbackApplyPreimageReader(
                fixture,
                candidate.bytes,
              ),
              readStageKeyFile: async () =>
                new Uint8Array(fixture.masterAuthenticationKey),
              createEvidenceDirectoryExclusive: async () => {
                directoryCalls += 1
                return 'created'
              },
              writeEvidenceFileExclusive: async () => 'created',
              spawnControlChild: () => {
                spawnCalls += 1
                throw new Error('Spawn must not be reached.')
              },
              runProcess: runWorkspaceSearchMigrationRehearsalProcess,
              runNoFaultProcess:
                runWorkspaceSearchMigrationRehearsalNoFaultProcess,
              installSignalHandler: () => () => undefined,
              writeStdoutLine: () => undefined,
              writeStderrLine: () => undefined,
            },
          )
        expect({ exitCode, directoryCalls, spawnCalls }).toEqual({
          exitCode: 2,
          directoryCalls: 0,
          spawnCalls: 0,
        })
      }
    },
  )

  test.each(rollbackApplyPreimageScenarios)(
    'rejects authentic %s preimage B against recovered reservation A',
    async (scenario) => {
      const fixture =
        createRollbackApplyPreimageProcessFixture(scenario)
      const selection = selectWorkspaceSearchMigrationRehearsalStage({
        manifest: fixture.manifest,
        verificationKey: new Uint8Array(fixture.runtimeAuthenticationKey),
        previousReceipt: fixture.previousReceipt,
        controlArguments: fixture.controlArguments,
        faultPlanDigest: fixture.faultPlan === null
          ? null
          : createMigrationDigest(fixture.faultPlan),
      })
      const reservationA =
        createWorkspaceSearchMigrationRehearsalStageReservation({
          selection,
          nonce: new Uint8Array(32).fill(0x32),
          reservedAt: '2026-08-02T00:21:00.000Z',
          expiresAt: '2026-08-02T01:51:00.000Z',
          expectedPreviousRateSegment:
            fixture.expectedPreviousRateSegment,
          expectedCurrentRateSegmentOrdinal:
            fixture.expectedPreviousRateSegment.segmentOrdinal + 1,
          expectedTargetPreimageArtifactContentDigest:
            createHash('sha256').update(fixture.artifactA).digest('hex'),
          signingKey: new Uint8Array(fixture.runtimeAuthenticationKey),
        })
      let claimCalls = 0
      let spawnCalls = 0
      const exitCode = await runWorkspaceSearchMigrationRehearsalProcessCli(
        createRollbackApplyPreimageCliArguments(fixture),
        {
          readInputFile: createRollbackApplyPreimageReader(
            fixture,
            fixture.artifactB,
            new TextEncoder().encode(serializeCanonicalJson(reservationA)),
          ),
          readStageKeyFile: async () =>
            new Uint8Array(fixture.masterAuthenticationKey),
          createEvidenceDirectoryExclusive: async () => 'exists',
          validateReservationOnlyDirectory: async () => undefined,
          writeEvidenceFileExclusive: async () => {
            throw new Error('Recovered reservation must not be rewritten.')
          },
          claimStageReservation: async () => {
            claimCalls += 1
            throw new Error('Claim must not be reached.')
          },
          now: () => new Date('2026-08-02T00:21:00.000Z'),
          spawnControlChild: () => {
            spawnCalls += 1
            throw new Error('Spawn must not be reached.')
          },
          runProcess: runWorkspaceSearchMigrationRehearsalProcess,
          runNoFaultProcess:
            runWorkspaceSearchMigrationRehearsalNoFaultProcess,
          installSignalHandler: () => () => undefined,
          writeStdoutLine: () => undefined,
          writeStderrLine: () => undefined,
        },
      )
      expect({ exitCode, claimCalls, spawnCalls }).toEqual({
        exitCode: 2,
        claimCalls: 0,
        spawnCalls: 0,
      })
    },
  )
})

describe('migration rehearsal parent fault-plan validation', () => {
  test('accepts canonical bytes and derives the exact response-loss action', () => {
    const plan = createFaultPlan(true)
    const parsed = parseWorkspaceSearchMigrationRehearsalCanonicalFaultPlan(
      encodeFaultPlan(plan),
    )
    expect(parsed).toEqual(plan)
    expect(
      createWorkspaceSearchMigrationRehearsalExpectedFaultReceipt(parsed),
    ).toEqual({
      receiptVersion: 1,
      stage: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
      failpoint: 'planning-page-transaction-response-lost',
      action: 'response-loss',
      target: plan.target,
      occurrence: 1,
    })
  })

  test.each([
    new TextEncoder().encode(` ${serializeCanonicalJson(createFaultPlan())}`),
    new TextEncoder().encode(`${serializeCanonicalJson(createFaultPlan())}\n`),
    new TextEncoder().encode('{"stage":"non-production"}'),
    new Uint8Array(
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_FAULT_PLAN_MAX_BYTES + 1,
    ),
  ])('rejects noncanonical, incomplete, or oversized plan bytes', (bytes) => {
    expect(() =>
      parseWorkspaceSearchMigrationRehearsalCanonicalFaultPlan(bytes)
    ).toThrow('INVALID_FAULT_PLAN')
  })
})

describe('migration rehearsal fixed child process boundary', () => {
  test('fixes executable, sibling script, protocol pipes, and silent fd4 liveness', () => {
    const specification =
      createWorkspaceSearchMigrationRehearsalChildSpawnSpecification([
        '--rehearsal-permit-file',
        permitPath,
        '--rehearsal-permit-key-file',
        keyPath,
        '--rehearsal-rate-segment-file',
        '/private/rate-segment.ndjson',
        '--rehearsal-rate-configuration-hash',
        rateConfigurationHash,
        '--rehearsal-fault-plan-file',
        faultPlanPath,
        '--',
        'plan',
      ])
    expect(specification).toEqual({
      executable: process.execPath,
      arguments: [
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CONTROL_CHILD_SCRIPT,
        '--rehearsal-permit-file',
        permitPath,
        '--rehearsal-permit-key-file',
        keyPath,
        '--rehearsal-rate-segment-file',
        '/private/rate-segment.ndjson',
        '--rehearsal-rate-configuration-hash',
        rateConfigurationHash,
        '--rehearsal-fault-plan-file',
        faultPlanPath,
        '--',
        'plan',
      ],
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'ignore',
      faultReceiptDescriptor: 3,
      faultReceipt: 'pipe',
      parentLivenessDescriptor: 4,
      parentLiveness: 'pipe',
      parentLivenessProtocol: 'silent-fd4-v1',
    })
  })

  test('discards ordinary child stderr instead of mapping it to the fd3 protocol stream', async () => {
    const port = spawnWorkspaceSearchMigrationRehearsalControlChild([
      '--invalid-one',
      'value-one',
      '--invalid-two',
      'value-two',
      '--invalid-three',
      'value-three',
      '--invalid-four',
      'value-four',
      '--invalid-five',
      'value-five',
      '--',
      'plan',
    ])
    const [stdoutBytes, protocolBytes, exit] = await Promise.all([
      countProcessBytes(port.stdout),
      countProcessBytes(port.stderr),
      port.exited,
    ])
    expect(stdoutBytes).toBe(0)
    expect(protocolBytes).toBe(0)
    expect(exit).toEqual({ kind: 'exit-code', exitCode: 2 })
  })
})

describe('migration rehearsal process CLI protocol and durability', () => {
  test('persists authenticated child material before successful lifecycle', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
        configurationBindingDigest: rateConfigurationHash,
      })
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
    const materialDigest = createMigrationDigest(material)
    const masterKey = new Uint8Array(fixture.masterAuthenticationKey)
    const evidenceWrites: EvidenceWrite[] = []
    const childArguments: string[][] = []
    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    let directoryCalls = 0
    const dummyPort: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: createFiniteProcessStream([]),
      stderr: createFiniteProcessStream([]),
      exited: Promise.resolve({ kind: 'exit-code', exitCode: 0 }),
      kill: (): void => {},
      acknowledgeResponseLoss: (): void => {},
    }
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      readInputFile: async (path): Promise<Uint8Array> => {
        if (path === permitPath) {
          return new TextEncoder().encode(
            serializeCanonicalJson(fixture.permit),
          )
        }
        if (path === stageManifestPath) {
          return new TextEncoder().encode(
            serializeCanonicalJson(fixture.manifest),
          )
        }
        if (path === fixture.ratePolicyFile) {
          return new Uint8Array(fixture.ratePolicyBytes)
        }
        throw new Error('Unexpected test input path.')
      },
      readStageKeyFile: async (path): Promise<Uint8Array> => {
        if (path === keyPath) return masterKey
        throw new Error('Unexpected test key path.')
      },
      createEvidenceDirectoryExclusive: async (): Promise<'created'> => {
        directoryCalls += 1
        return 'created'
      },
      writeEvidenceFileExclusive: async (_directory, filename, bytes) => {
        evidenceWrites.push({ filename, bytes: bytes.slice() })
        return 'created'
      },
      claimStageReservation: async (input) =>
        createClaimedHeadForParentReservation(
          input.stageReservationClaim.reservation,
          fixture,
          input.stageReservationClaim.stageKey,
        ),
      writeRuntimeKeyFileExclusive: async (_path, key) => {
        expect(key).toEqual(fixture.authenticationKey)
        return 'created'
      },
      cleanupRuntimeKeyFile: async (input) =>
        await createProcessCliTestCleanupAuthorization(
          input,
          material.stageReservation,
        ),
      now: (): Date => new Date('2026-08-02T00:10:30.000Z'),
      randomBytes: (): Uint8Array => new Uint8Array(32).fill(0x41),
      spawnControlChild: (arguments_) => {
        childArguments.push([...arguments_])
        return dummyPort
      },
      runProcess: runWorkspaceSearchMigrationRehearsalProcess,
      runNoFaultProcess:
        runWorkspaceSearchMigrationRehearsalNoFaultProcess,
      runSuccessfulProcess: async (input) => {
        expect(input.runtimeTimeoutMilliseconds).toBe(
          freshReservationRuntimeMilliseconds,
        )
        expect(input.containmentTimeoutMilliseconds).toBe(
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MAX_CONTAINMENT_MILLISECONDS,
        )
        expect(input.now?.()).toBe('2026-08-02T00:10:30.000Z')
        await input.persistSuccessMaterialDurably(
          Object.freeze({
            material,
            materialDigest,
            observedAt: '2026-08-02T01:00:00.001Z',
          }),
          new AbortController().signal,
        )
        return Object.freeze({
          lifecycleVersion: 1,
          manifestDigest: material.manifestDigest,
          manifestEntryDigest: material.manifestEntryDigest,
          previousStageReceiptDigest:
            material.previousStageReceiptDigest,
          stageOrdinal: material.stageOrdinal,
          scenario: material.scenario,
          command: material.command,
          attemptOrdinal: material.attemptOrdinal,
          expectedOutcome: material.expectedOutcome,
          materialDigest,
          stdoutSha256: 'b'.repeat(64),
          runnerStartedAt: '2026-08-02T01:00:00.000Z',
          materialObservedAt: '2026-08-02T01:00:00.001Z',
          materialPersistedAt: '2026-08-02T01:00:00.002Z',
          processExitedAt: '2026-08-02T01:00:00.003Z',
          exitClass: 'successful-no-fault',
        })
      },
      installSignalHandler: () => (): void => {},
      writeStdoutLine: (line): void => {
        stdoutLines.push(line)
      },
      writeStderrLine: (line): void => {
        stderrLines.push(line)
      },
    }

    const exitCode = await runWorkspaceSearchMigrationRehearsalProcessCli(
      createSuccessfulCliArguments(
        fixture.controlArguments,
        fixture.configurationBindingDigest,
      ),
      dependencies,
    )

    expect(exitCode).toBe(0)
    expect(directoryCalls).toBe(1)
    expect(childArguments).toHaveLength(1)
    expect(evidenceWrites.map((write) => write.filename)).toEqual([
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
    ])
    const materialEvidence = JSON.parse(new TextDecoder().decode(
      evidenceWrites[1]?.bytes,
    ))
    expect(materialEvidence.material).toEqual(material)
    expect(materialEvidence.materialDigest).toBe(materialDigest)
    const parentAuthentication = JSON.parse(new TextDecoder().decode(
      evidenceWrites[3]?.bytes,
    ))
    expect(parentAuthentication).toMatchObject({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-stage-parent-authentication',
      authenticationVersion: 1,
      manifestDigest: fixture.selection.manifestDigest,
      materialEvidenceDigest: createMigrationDigest(materialEvidence),
      boundaryMaterialEvidenceDigest: null,
      faultPlanDigest: null,
      boundaryRateSegmentBytesDigest: null,
      finalRateSegmentBytesDigest: null,
      authenticationMac: expect.any(String),
    })
    expect(JSON.parse(stdoutLines[0] ?? '{}').receiptSha256).toBe(
      materialDigest,
    )
    expect(stderrLines).toEqual([])
    expect([...masterKey]).toEqual(Array.from({ length: 32 }, () => 0))
  })

  test('rejects rate bootstrap and command mismatch before every reservation effect', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
        configurationBindingDigest: rateConfigurationHash,
      })
    const candidates = [
      Object.freeze({
        label: 'rate-bootstrap',
        controlArguments: Object.freeze([
          ...fixture.controlArguments,
          '--rate-bootstrap',
          'true',
        ]),
      }),
      Object.freeze({
        label: 'command-mismatch',
        controlArguments: Object.freeze([
          'apply',
          ...fixture.controlArguments.slice(1),
        ]),
      }),
    ]

    for (const candidate of candidates) {
      const manifest = createProcessCliManifestForControlArguments(
        fixture,
        candidate.controlArguments,
      )
      let directoryCalls = 0
      let reservationWrites = 0
      let claimCalls = 0
      let runtimeKeyWrites = 0
      let spawnCalls = 0
      let runnerCalls = 0
      const stderrLines: string[] = []
      const exitCode = await runWorkspaceSearchMigrationRehearsalProcessCli(
        createSuccessfulCliArguments(
          candidate.controlArguments,
          fixture.configurationBindingDigest,
        ),
        {
          readInputFile: async (path): Promise<Uint8Array> => {
            if (path === permitPath) {
              return new TextEncoder().encode(
                serializeCanonicalJson(fixture.permit),
              )
            }
            if (path === stageManifestPath) {
              return new TextEncoder().encode(serializeCanonicalJson(manifest))
            }
            if (path === fixture.ratePolicyFile) {
              return new Uint8Array(fixture.ratePolicyBytes)
            }
            throw new Error('Unexpected control-admission input path.')
          },
          readStageKeyFile: async (): Promise<Uint8Array> =>
            new Uint8Array(fixture.masterAuthenticationKey),
          createEvidenceDirectoryExclusive: async (): Promise<'created'> => {
            directoryCalls += 1
            return 'created'
          },
          writeEvidenceFileExclusive: async (): Promise<'created'> => {
            reservationWrites += 1
            return 'created'
          },
          claimStageReservation: async () => {
            claimCalls += 1
            throw new Error('Rejected control must not be reserved.')
          },
          writeRuntimeKeyFileExclusive: async (): Promise<'created'> => {
            runtimeKeyWrites += 1
            return 'created'
          },
          spawnControlChild: () => {
            spawnCalls += 1
            throw new Error('Rejected control must not spawn.')
          },
          runProcess: runWorkspaceSearchMigrationRehearsalProcess,
          runNoFaultProcess:
            runWorkspaceSearchMigrationRehearsalNoFaultProcess,
          runSuccessfulProcess: async () => {
            runnerCalls += 1
            throw new Error('Rejected control must not run.')
          },
          installSignalHandler: () => (): void => {},
          writeStdoutLine: (): void => {},
          writeStderrLine: (line): void => {
            stderrLines.push(line)
          },
        },
      )

      expect({
        exitCode,
        directoryCalls,
        reservationWrites,
        claimCalls,
        runtimeKeyWrites,
        spawnCalls,
        runnerCalls,
      }, candidate.label).toEqual({
        exitCode: 2,
        directoryCalls: 0,
        reservationWrites: 0,
        claimCalls: 0,
        runtimeKeyWrites: 0,
        spawnCalls: 0,
        runnerCalls: 0,
      })
      expect(stderrLines, candidate.label).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_STAGE_SELECTION',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
          status: 'error',
        }),
      ])
      expect(stderrLines[0], candidate.label).not.toContain(permitPath)
      expect(stderrLines[0], candidate.label).not.toContain(keyPath)
    }
  })

  test('rejects Proxy, accessor, and inherited parent arguments without reading them', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
        configurationBindingDigest: rateConfigurationHash,
      })
    const validArguments = createSuccessfulCliArguments(
      fixture.controlArguments,
      fixture.configurationBindingDigest,
    )
    let proxyReads = 0
    const proxyArguments = new Proxy([...validArguments], {
      get: (target, property, receiver) => {
        proxyReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    let accessorReads = 0
    const accessorArguments = [...validArguments]
    Object.defineProperty(accessorArguments, '1', {
      configurable: true,
      enumerable: true,
      get: (): string => {
        accessorReads += 1
        return permitPath
      },
    })
    const inheritedArguments = [...validArguments]
    const inheritedPrototype = Object.create(Array.prototype)
    Object.defineProperty(inheritedPrototype, '1', {
      configurable: true,
      enumerable: true,
      value: inheritedArguments[1],
      writable: true,
    })
    delete inheritedArguments[1]
    Object.setPrototypeOf(inheritedArguments, inheritedPrototype)

    for (const arguments_ of [
      proxyArguments,
      accessorArguments,
      inheritedArguments,
    ]) {
      let inputReads = 0
      let directoryCalls = 0
      let reservationWrites = 0
      let claimCalls = 0
      let spawnCalls = 0
      const stderrLines: string[] = []
      const exitCode = await runWorkspaceSearchMigrationRehearsalProcessCli(
        arguments_,
        {
          readInputFile: async (): Promise<Uint8Array> => {
            inputReads += 1
            throw new Error('Hostile arguments must not start input reads.')
          },
          createEvidenceDirectoryExclusive: async (): Promise<'created'> => {
            directoryCalls += 1
            return 'created'
          },
          writeEvidenceFileExclusive: async (): Promise<'created'> => {
            reservationWrites += 1
            return 'created'
          },
          claimStageReservation: async () => {
            claimCalls += 1
            throw new Error('Hostile arguments must not reserve a stage.')
          },
          spawnControlChild: () => {
            spawnCalls += 1
            throw new Error('Hostile arguments must not spawn.')
          },
          runProcess: runWorkspaceSearchMigrationRehearsalProcess,
          runNoFaultProcess:
            runWorkspaceSearchMigrationRehearsalNoFaultProcess,
          installSignalHandler: () => (): void => {},
          writeStdoutLine: (): void => {},
          writeStderrLine: (line): void => {
            stderrLines.push(line)
          },
        },
      )
      expect({
        exitCode,
        inputReads,
        directoryCalls,
        reservationWrites,
        claimCalls,
        spawnCalls,
      }).toEqual({
        exitCode: 2,
        inputReads: 0,
        directoryCalls: 0,
        reservationWrites: 0,
        claimCalls: 0,
        spawnCalls: 0,
      })
      expect(stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_USAGE',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
          status: 'error',
        }),
      ])
      expect(stderrLines[0]).not.toContain(permitPath)
    }
    expect(proxyReads).toBe(0)
    expect(accessorReads).toBe(0)
  })

  test('retains the detached control vector after caller mutation', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    const arguments_ = [...createAuthenticatedFaultCliArguments(fixture)]
    const readInputFile = harness.dependencies.readInputFile
    let mutated = false
    const exitCode = await runWorkspaceSearchMigrationRehearsalProcessCli(
      arguments_,
      {
        ...harness.dependencies,
        readInputFile: async (path, maximumBytes) => {
          if (!mutated) {
            const separatorIndex = arguments_.indexOf('--')
            if (separatorIndex < 0) {
              throw new Error('Expected parent/control separator.')
            }
            arguments_.splice(
              separatorIndex + 2,
              0,
              '--rate-bootstrap',
              'true',
            )
            mutated = true
          }
          return await readInputFile(path, maximumBytes)
        },
      },
    )

    expect(exitCode).toBe(0)
    expect(mutated).toBe(true)
    expect(arguments_).toContain('--rate-bootstrap')
    expect(harness.childArguments).toHaveLength(1)
    expect(harness.childArguments[0]).not.toContain('--rate-bootstrap')
  })

  test('reconstructs parent authentication after cleanup without respawning the child', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
        configurationBindingDigest: rateConfigurationHash,
      })
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
        leaseAcquisitionObservation: fixture.leaseAcquisitionObservation,
        authenticationKey: fixture.authenticationKey,
      })
    const materialDigest = createMigrationDigest(material)
    const lifecycle = Object.freeze({
      lifecycleVersion: 1,
      manifestDigest: material.manifestDigest,
      manifestEntryDigest: material.manifestEntryDigest,
      previousStageReceiptDigest: material.previousStageReceiptDigest,
      stageOrdinal: material.stageOrdinal,
      scenario: material.scenario,
      command: material.command,
      attemptOrdinal: material.attemptOrdinal,
      expectedOutcome: material.expectedOutcome,
      materialDigest,
      stdoutSha256: 'b'.repeat(64),
      runnerStartedAt: '2026-08-02T00:59:59.980Z',
      materialObservedAt: '2026-08-02T00:59:59.981Z',
      materialPersistedAt: '2026-08-02T00:59:59.982Z',
      processExitedAt: '2026-08-02T00:59:59.983Z',
      exitClass: 'successful-no-fault',
    })
    const root = await mkdtemp(join(tmpdir(), 'mukuroji-process-recovery-'))
    const directory = join(root, 'evidence')
    let childPhaseComplete = false
    let postChildClockMilliseconds = 990
    let spawnCalls = 0
    let claimCalls = 0
    let parentAuthenticationWriteAttempts = 0
    let cleanupCompleted = false
    let capturedCleanupAuthorization:
      WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization |
      undefined
    let capturedProcessSelection:
      WorkspaceSearchMigrationRehearsalSelectedStage | undefined
    const stderrLines: string[] = []
    const firstStdoutLines: string[] = []
    const recoveredStdoutLines: string[] = []
    const persistedFilenames: WorkspaceSearchMigrationRehearsalEvidenceFilename[] = []
    const dummyPort: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: createFiniteProcessStream([]),
      stderr: createFiniteProcessStream([]),
      exited: Promise.resolve({ kind: 'exit-code', exitCode: 0 }),
      kill: (): void => {},
      acknowledgeResponseLoss: (): void => {},
    }
    const readRecoveryInput = async (path: string): Promise<Uint8Array> => {
      if (path === permitPath) {
        return new TextEncoder().encode(serializeCanonicalJson(fixture.permit))
      }
      if (path === stageManifestPath) {
        return new TextEncoder().encode(
          serializeCanonicalJson(fixture.manifest),
        )
      }
      if (path === fixture.ratePolicyFile) {
        return new Uint8Array(fixture.ratePolicyBytes)
      }
      if (path.startsWith(`${directory}/`)) {
        return new Uint8Array(await readFile(path))
      }
      throw new Error('Unexpected recovery input path.')
    }
    const arguments_ = createSuccessfulCliArguments(
      fixture.controlArguments,
      fixture.configurationBindingDigest,
      directory,
    )
    try {
      const firstDependencies:
        WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
          readInputFile: async (path) => await readRecoveryInput(path),
          readStageKeyFile: async (): Promise<Uint8Array> =>
            new Uint8Array(fixture.masterAuthenticationKey),
          createEvidenceDirectoryExclusive:
            createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive,
          writeEvidenceFileExclusive: async (
            targetDirectory,
            filename,
            bytes,
            signal,
          ) => {
            persistedFilenames.push(filename)
            if (
              filename ===
                WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME
            ) {
              parentAuthenticationWriteAttempts += 1
              return await writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
                targetDirectory,
                filename,
                bytes,
                signal,
                {
                  onCheckpoint: (checkpoint): void => {
                    if (checkpoint === 'temporary-file-durable') {
                      throw new Error('SIMULATED_PARENT_CRASH')
                    }
                  },
                },
              )
            }
            return await writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
              targetDirectory,
              filename,
              bytes,
              signal,
            )
          },
          claimStageReservation: async () => {
            claimCalls += 1
            return fixture.claimedStageHead
          },
          cleanupRuntimeKeyFile: async (input) => {
            const authorization =
              await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey(input)
            cleanupCompleted = true
            capturedProcessSelection = input.selection
            capturedCleanupAuthorization = authorization
            return capturedCleanupAuthorization
          },
          now: (): Date => {
            if (!childPhaseComplete) {
              return new Date('2026-08-02T00:10:00.000Z')
            }
            const timestamp = new Date(
              Date.parse('2026-08-02T00:59:59.000Z') +
                postChildClockMilliseconds,
            )
            postChildClockMilliseconds += 1
            return timestamp
          },
          randomBytes: (): Uint8Array =>
            createHash('sha256')
              .update('generic-success-stage-reservation', 'utf8')
              .digest(),
          spawnControlChild: () => {
            spawnCalls += 1
            return dummyPort
          },
          runProcess: runWorkspaceSearchMigrationRehearsalProcess,
          runNoFaultProcess:
            runWorkspaceSearchMigrationRehearsalNoFaultProcess,
          runSuccessfulProcess: async (input) => {
            childPhaseComplete = true
            await writeFile(
              join(
                directory,
                WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
              ),
              fixture.committedRateSegment.canonicalBytes,
              { mode: 0o600 },
            )
            await input.persistSuccessMaterialDurably(
              Object.freeze({
                material,
                materialDigest,
                observedAt: '2026-08-02T00:59:59.981Z',
              }),
              new AbortController().signal,
            )
            return lifecycle
          },
          installSignalHandler: () => (): void => {},
          writeStdoutLine: (line): void => {
            firstStdoutLines.push(line)
          },
          writeStderrLine: (line): void => {
            stderrLines.push(line)
          },
        }
      await expect(runWorkspaceSearchMigrationRehearsalProcessCli(
        arguments_,
        firstDependencies,
      )).resolves.toBe(1)
      expect(spawnCalls).toBe(1)
      expect(claimCalls).toBe(1)
      expect(cleanupCompleted).toBe(true)
      expect(parentAuthenticationWriteAttempts).toBe(1)
      expect(persistedFilenames).toEqual([
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
      ])
      expect(firstStdoutLines).toEqual([])
      expect(JSON.parse(await readFile(join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
      ), 'utf8'))).toEqual(fixture.stageReservation)
      if (
        capturedCleanupAuthorization === undefined ||
        capturedProcessSelection === undefined
      ) throw new Error('Missing captured cleanup recovery fixture.')
      const cleanupAuthorization = capturedCleanupAuthorization
      const processSelection = capturedProcessSelection
      const recoveredMaterialEvidence = JSON.parse(await readFile(join(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
        ), 'utf8'))
      const recoveredLifecycleEvidence = JSON.parse(await readFile(join(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
        ), 'utf8'))
      expect(() =>
        createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
          materialKind: 'success',
          selection: processSelection,
          persistedMaterialEvidence: recoveredMaterialEvidence,
          persistedLifecycleEvidence: recoveredLifecycleEvidence,
          runtimeKeyCleanupAuthorization: cleanupAuthorization,
          runtimeAuthenticationKey:
            new Uint8Array(fixture.authenticationKey),
          publicationAuthenticationKey:
            new Uint8Array(fixture.publicationAuthenticationKey),
        })
      ).not.toThrow()
      await expect(readFile(join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
      ))).rejects.toMatchObject({ code: 'ENOENT' })

      const recoveryDependencies:
        WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
          readInputFile: async (path) => await readRecoveryInput(path),
          readStageKeyFile: async (): Promise<Uint8Array> =>
            new Uint8Array(fixture.masterAuthenticationKey),
          createEvidenceDirectoryExclusive:
            createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive,
          writeEvidenceFileExclusive:
            writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive,
          now: (): Date => new Date('2026-08-02T01:40:00.001Z'),
          spawnControlChild: () => {
            spawnCalls += 1
            throw new Error('Recovery must not spawn.')
          },
          claimStageReservation: async () => {
            claimCalls += 1
            throw new Error('Recovery must not claim again.')
          },
          runProcess: runWorkspaceSearchMigrationRehearsalProcess,
          runNoFaultProcess:
            runWorkspaceSearchMigrationRehearsalNoFaultProcess,
          runSuccessfulProcess: async () => {
            throw new Error('Recovery must not run a child lifecycle.')
          },
          installSignalHandler: () => (): void => {},
          writeStdoutLine: (line): void => {
            recoveredStdoutLines.push(line)
          },
          writeStderrLine: (line): void => {
            stderrLines.push(line)
          },
        }
      const recoveryExitCode = await runWorkspaceSearchMigrationRehearsalProcessCli(
        arguments_,
        recoveryDependencies,
      )
      expect({ recoveryExitCode, stderrLines }).toEqual({
        recoveryExitCode: 0,
        stderrLines: [
          serializeCanonicalJson({
            code: 'PARENT_AUTHENTICATION_WRITE_FAILED',
            kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
            status: 'error',
          }),
        ],
      })
      expect(spawnCalls).toBe(1)
      expect(claimCalls).toBe(1)
      expect(recoveredStdoutLines).toHaveLength(1)
      expect(JSON.parse(recoveredStdoutLines[0] ?? '{}')).toMatchObject({
        exitClass: 'successful-no-fault',
        lifecycleSha256: createMigrationDigest(lifecycle),
        receiptSha256: materialDigest,
        status: 'succeeded',
      })
      expect(JSON.parse(await readFile(join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
      ), 'utf8'))).toMatchObject({
        runtimeKeyCleanupAuthorization: {
          reservationDigest: createMigrationDigest(fixture.stageReservation),
          cleanupCompletionDigest: expect.any(String),
        },
        authenticationMac: expect.any(String),
      })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('recovers every authenticated cleanup subphase without a child respawn', async () => {
    const phases = [
      'runtime-only',
      'lifecycle-linked',
      'intent-durable',
      'completion-durable',
      'intent-temporary',
      'completion-linked',
      'cleanup-complete',
    ] satisfies readonly (
      | 'runtime-only'
      | 'lifecycle-linked'
      | 'intent-durable'
      | 'completion-durable'
      | 'intent-temporary'
      | 'completion-linked'
      | 'cleanup-complete'
    )[]
    for (const phase of phases) {
      const fixture =
        createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
          configurationBindingDigest: rateConfigurationHash,
        })
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
          leaseAcquisitionObservation: fixture.leaseAcquisitionObservation,
          authenticationKey: fixture.authenticationKey,
        })
      const materialDigest = createMigrationDigest(material)
      const lifecycle = Object.freeze({
        lifecycleVersion: 1,
        manifestDigest: material.manifestDigest,
        manifestEntryDigest: material.manifestEntryDigest,
        previousStageReceiptDigest: material.previousStageReceiptDigest,
        stageOrdinal: material.stageOrdinal,
        scenario: material.scenario,
        command: material.command,
        attemptOrdinal: material.attemptOrdinal,
        expectedOutcome: material.expectedOutcome,
        materialDigest,
        stdoutSha256: 'b'.repeat(64),
        runnerStartedAt: '2026-08-02T00:59:59.980Z',
        materialObservedAt: '2026-08-02T00:59:59.981Z',
        materialPersistedAt: '2026-08-02T00:59:59.982Z',
        processExitedAt: '2026-08-02T00:59:59.983Z',
        exitClass: 'successful-no-fault',
      })
      const materialEvidence = Object.freeze({
        kind:
          'mukuroji-workspace-search-migration-rehearsal-child-material-evidence',
        evidenceVersion: 1,
        material,
        materialDigest,
        observedAt: '2026-08-02T00:59:59.981Z',
      })
      const lifecycleEvidence = Object.freeze({
        kind:
          'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
        lifecycle,
        lifecycleSha256: createMigrationDigest(lifecycle),
      })
      const root = await mkdtemp(join(tmpdir(), 'mukuroji-cleanup-phase-'))
      const directory = join(root, 'evidence')
      const runtimePath = join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      )
      let spawnCalls = 0
      let claimCalls = 0
      const stdoutLines: string[] = []
      const stderrLines: string[] = []
      try {
        await createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive(
          directory,
        )
        for (const [filename, value] of [
          [
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
            fixture.stageReservation,
          ],
          [
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
            materialEvidence,
          ],
          [
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
            lifecycleEvidence,
          ],
        ] satisfies readonly (readonly [
          WorkspaceSearchMigrationRehearsalEvidenceFilename,
          unknown,
        ])[]) {
          const write =
            writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
              directory,
              filename,
              new TextEncoder().encode(serializeCanonicalJson(value)),
              undefined,
              filename ===
                  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME &&
                phase === 'lifecycle-linked'
                ? {
                    onCheckpoint: (checkpoint): void => {
                      if (checkpoint === 'final-link-durable') {
                        throw new Error('SIMULATED_LIFECYCLE_PUBLICATION_CRASH')
                      }
                    },
                  }
                : undefined,
            )
          if (
            filename ===
                WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME &&
            phase === 'lifecycle-linked'
          ) {
            await expect(write).rejects.toThrow('OUTPUT_BOUNDARY_FAILED')
          } else {
            await write
          }
        }
        await writeFile(
          join(
            directory,
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
          ),
          fixture.committedRateSegment.canonicalBytes,
          { mode: 0o600 },
        )
        await writeWorkspaceSearchMigrationRehearsalRuntimeKeyFileExclusive(
          directory,
          fixture.authenticationKey,
        )
        if (phase !== 'runtime-only') {
          let clockIndex = 0
          const cleanupTimestamps = [
            '2026-08-02T01:10:00.000Z',
            '2026-08-02T01:10:00.001Z',
          ]
          const crashCheckpoint = phase === 'intent-durable'
            ? 'intent-durable'
            : phase === 'completion-durable'
              ? 'completion-durable'
              : phase === 'intent-temporary'
                ? 'intent-artifact-temp-durable'
                : phase === 'completion-linked'
                  ? 'completion-artifact-linked'
                  : undefined
          const cleanup = cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
            evidenceDirectory: directory,
            reservation: fixture.stageReservation,
            selection: fixture.selection,
            expectedRuntimeKey: fixture.authenticationKey,
            publicationAuthenticationKey:
              fixture.publicationAuthenticationKey,
            now: (): Date => {
              const timestamp = cleanupTimestamps[clockIndex]
              clockIndex += 1
              if (timestamp === undefined) {
                throw new Error('Unexpected cleanup phase clock read.')
              }
              return new Date(timestamp)
            },
            ...(crashCheckpoint === undefined
              ? {}
              : {
                  dependencies: {
                    onCheckpoint: (checkpoint): void => {
                      if (checkpoint === crashCheckpoint) {
                        throw new Error('SIMULATED_CLEANUP_PHASE_CRASH')
                      }
                    },
                  },
                }),
          })
          if (crashCheckpoint === undefined) {
            await cleanup
          } else {
            await expect(cleanup).rejects
              .toThrow('INVALID_REHEARSAL_RUNTIME_KEY_CLEANUP')
          }
        }
        const readRecoveryInput = async (path: string): Promise<Uint8Array> => {
          if (path === permitPath) {
            return new TextEncoder().encode(
              serializeCanonicalJson(fixture.permit),
            )
          }
          if (path === stageManifestPath) {
            return new TextEncoder().encode(
              serializeCanonicalJson(fixture.manifest),
            )
          }
          if (path.startsWith(`${directory}/`)) {
            return new Uint8Array(await readFile(path))
          }
          throw new Error('Unexpected cleanup recovery input path.')
        }
        const dependencies:
          WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
            readInputFile: async (path) => await readRecoveryInput(path),
            readStageKeyFile: async (): Promise<Uint8Array> =>
              new Uint8Array(fixture.masterAuthenticationKey),
            createEvidenceDirectoryExclusive:
              createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive,
            writeEvidenceFileExclusive:
              writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive,
            now: (): Date => new Date('2026-08-02T01:20:00.000Z'),
            spawnControlChild: () => {
              spawnCalls += 1
              throw new Error('Cleanup recovery must not spawn.')
            },
            claimStageReservation: async () => {
              claimCalls += 1
              throw new Error('Cleanup recovery must not claim.')
            },
            runProcess: runWorkspaceSearchMigrationRehearsalProcess,
            runNoFaultProcess:
              runWorkspaceSearchMigrationRehearsalNoFaultProcess,
            runSuccessfulProcess: async () => {
              throw new Error('Cleanup recovery must not run a child.')
            },
            installSignalHandler: () => (): void => {},
            writeStdoutLine: (line): void => {
              stdoutLines.push(line)
            },
            writeStderrLine: (line): void => {
              stderrLines.push(line)
            },
          }
        await expect(runWorkspaceSearchMigrationRehearsalProcessCli(
          createSuccessfulCliArguments(
            fixture.controlArguments,
            fixture.configurationBindingDigest,
            directory,
          ),
          dependencies,
        )).resolves.toBe(0)
        expect({ phase, spawnCalls, claimCalls, stderrLines }).toEqual({
          phase,
          spawnCalls: 0,
          claimCalls: 0,
          stderrLines: [],
        })
        expect(stdoutLines).toHaveLength(1)
        await expect(readFile(runtimePath)).rejects
          .toMatchObject({ code: 'ENOENT' })
        await expect(readFile(
          `${join(
            directory,
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
          )}.tmp`,
        )).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(
          `${join(
            directory,
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
          )}.tmp`,
        )).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(readFile(join(
          directory,
          `.${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME}.publication.tmp`,
        ))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(JSON.parse(await readFile(join(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
        ), 'utf8'))).toMatchObject({ authenticationMac: expect.any(String) })
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    }
  })

  test('durably cleans an interrupted pre-spawn runtime key without spawning', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
        configurationBindingDigest: rateConfigurationHash,
      })
    const root = await mkdtemp(join(tmpdir(), 'mukuroji-runtime-orphan-'))
    const directory = join(root, 'evidence')
    const runtimePath = join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
    )
    let spawnCalls = 0
    let claimCalls = 0
    const stderrLines: string[] = []
    try {
      await createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive(
        directory,
      )
      await writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
        new TextEncoder().encode(
          serializeCanonicalJson(fixture.stageReservation),
        ),
      )
      await expect(
        writeWorkspaceSearchMigrationRehearsalRuntimeKeyFileExclusive(
          directory,
          fixture.authenticationKey,
          {
            maximumWriteBytes: 7,
            onCheckpoint: (checkpoint): void => {
              if (checkpoint === 'runtime-key-write-progress') {
                throw new Error('SIMULATED_SIGKILL_AFTER_PARTIAL_WRITE')
              }
            },
          },
        ),
      ).rejects.toThrow('OUTPUT_BOUNDARY_FAILED')
      expect((await stat(runtimePath)).size).toBe(7)

      const dependencies:
        WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
          readInputFile: async (path): Promise<Uint8Array> => {
            if (path === permitPath) {
              return new TextEncoder().encode(
                serializeCanonicalJson(fixture.permit),
              )
            }
            if (path === stageManifestPath) {
              return new TextEncoder().encode(
                serializeCanonicalJson(fixture.manifest),
              )
            }
            if (path === fixture.ratePolicyFile) {
              return new Uint8Array(fixture.ratePolicyBytes)
            }
            return new Uint8Array(await readFile(path))
          },
          readStageKeyFile: async (): Promise<Uint8Array> =>
            new Uint8Array(fixture.masterAuthenticationKey),
          createEvidenceDirectoryExclusive:
            createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive,
          writeEvidenceFileExclusive:
            writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive,
          now: (): Date => new Date('2026-08-02T01:50:00.000Z'),
          spawnControlChild: () => {
            spawnCalls += 1
            throw new Error('Interrupted runtime recovery must not spawn.')
          },
          claimStageReservation: async () => {
            claimCalls += 1
            throw new Error('Interrupted runtime recovery must not reclaim.')
          },
          runProcess: runWorkspaceSearchMigrationRehearsalProcess,
          runNoFaultProcess:
            runWorkspaceSearchMigrationRehearsalNoFaultProcess,
          runSuccessfulProcess: async () => {
            throw new Error('Interrupted runtime recovery must not run.')
          },
          installSignalHandler: () => (): void => {},
          writeStdoutLine: (): void => {},
          writeStderrLine: (line): void => {
            stderrLines.push(line)
          },
        }
      await expect(runWorkspaceSearchMigrationRehearsalProcessCli(
        createSuccessfulCliArguments(
          fixture.controlArguments,
          fixture.configurationBindingDigest,
          directory,
        ),
        dependencies,
      )).resolves.toBe(1)
      expect({ spawnCalls, claimCalls }).toEqual({
        spawnCalls: 0,
        claimCalls: 0,
      })
      expect(stderrLines[0]).toContain('EVIDENCE_DIRECTORY_EXISTS')
      await expect(readFile(runtimePath)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(JSON.parse(await readFile(join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_INTENT_FILENAME,
      ), 'utf8'))).toMatchObject({ intentMac: expect.any(String) })
      expect(JSON.parse(await readFile(join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_CLEANUP_COMPLETION_FILENAME,
      ), 'utf8'))).toMatchObject({ completionMac: expect.any(String) })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('rejects a master key inconsistent with the permit before directory or spawn', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageChildMaterialTestFixture({
        configurationBindingDigest: rateConfigurationHash,
      })
    const masterKey = new Uint8Array(32).fill(0xa1)
    let directoryCalls = 0
    let spawnCalls = 0
    let successRunnerCalls = 0
    const stderrLines: string[] = []
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      readInputFile: async (path): Promise<Uint8Array> => {
        if (path === permitPath) {
          return new TextEncoder().encode(
            serializeCanonicalJson(fixture.permit),
          )
        }
        if (path === stageManifestPath) {
          return new TextEncoder().encode(
            serializeCanonicalJson(fixture.manifest),
          )
        }
        throw new Error('Unexpected test input path.')
      },
      readStageKeyFile: async (path): Promise<Uint8Array> => {
        if (path === keyPath) return masterKey
        throw new Error('Unexpected test key path.')
      },
      createEvidenceDirectoryExclusive: async (): Promise<'created'> => {
        directoryCalls += 1
        return 'created'
      },
      writeEvidenceFileExclusive: async (): Promise<'created'> => 'created',
      spawnControlChild: () => {
        spawnCalls += 1
        throw new Error('Spawn must not be reached.')
      },
      runProcess: runWorkspaceSearchMigrationRehearsalProcess,
      runNoFaultProcess:
        runWorkspaceSearchMigrationRehearsalNoFaultProcess,
      runSuccessfulProcess: async () => {
        successRunnerCalls += 1
        throw new Error('Success runner must not be reached.')
      },
      installSignalHandler: () => (): void => {},
      writeStdoutLine: (): void => {},
      writeStderrLine: (line): void => {
        stderrLines.push(line)
      },
    }

    const exitCode = await runWorkspaceSearchMigrationRehearsalProcessCli(
      createSuccessfulCliArguments(
        fixture.controlArguments,
        fixture.configurationBindingDigest,
      ),
      dependencies,
    )

    expect(exitCode).toBe(2)
    expect(directoryCalls).toBe(0)
    expect(spawnCalls).toBe(0)
    expect(successRunnerCalls).toBe(0)
    expect([...masterKey]).toEqual(Array.from({ length: 32 }, () => 0))
    expect(stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INVALID_STAGE_SELECTION',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
        status: 'error',
      }),
    ])
  })

  test('persists authenticated boundary before SIGKILL lifecycle evidence', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        harness.dependencies,
      ),
    ).resolves.toBe(0)

    expect(harness.evidenceWrites.map((write) => write.filename)).toEqual([
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
    ])
    expect(harness.childArguments).toEqual([[
      '--rehearsal-permit-file',
      permitPath,
      '--rehearsal-permit-key-file',
      join(
        evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ),
      '--rehearsal-rate-segment-file',
      join(
        evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_FILENAME,
      ),
      '--rehearsal-rate-configuration-hash',
      fixture.configurationBindingDigest,
      '--rehearsal-rate-previous-segment-file',
      previousRateSegmentPath,
      '--rehearsal-stage-manifest-file',
      stageManifestPath,
      '--rehearsal-previous-stage-receipt-file',
      previousStageReceiptPath,
      '--rehearsal-stage-key-file',
      join(
        evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ),
      '--rehearsal-stage-reservation-file',
      join(
        evidenceDirectory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
      ),
      '--rehearsal-fault-plan-file',
      faultPlanPath,
      '--',
      ...fixture.controlArguments,
    ]])
    const materialDocument = JSON.parse(
      new TextDecoder().decode(harness.evidenceWrites[2]?.bytes),
    )
    expect(materialDocument).toEqual({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence',
      evidenceVersion: 1,
      material: harness.boundary,
      materialDigest: createMigrationDigest(harness.boundary),
      observedAt: '2026-08-02T01:00:00.001Z',
    })
    expect(harness.evidenceWrites[1]?.bytes).toEqual(
      fixture.committedRateSegment.canonicalBytes,
    )
    expect(JSON.parse(new TextDecoder().decode(
      harness.evidenceWrites[4]?.bytes,
    ))).toMatchObject({
      materialEvidenceDigest: createMigrationDigest(materialDocument),
      boundaryMaterialEvidenceDigest: null,
      faultPlanDigest: createMigrationDigest(fixture.faultPlan),
      boundaryRateSegmentBytesDigest:
        fixture.committedRateSegment.segmentDigest,
      finalRateSegmentBytesDigest: null,
      authenticationMac: expect.any(String),
    })
    expect(harness.stderrLines).toEqual([])
    expect(harness.stdoutLines).toHaveLength(1)
    expect(harness.stdoutLines[0]).not.toContain(permitPath)
    expect(harness.stdoutLines[0]).not.toContain(keyPath)
    expect(harness.stdoutLines[0]).not.toContain(childOutputCanary)
    expect(harness.stdoutLines[0]).toContain('confirmed-sigkill')
    expect(harness.readSignalHandler()).toBeUndefined()
  })

  test('persists both response-loss materials before successful lifecycle', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture(
        true,
      )
    const harness = createAuthenticatedFaultDependencyHarness(fixture)

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        harness.dependencies,
      ),
    ).resolves.toBe(0)

    expect(harness.evidenceWrites.map((write) => write.filename)).toEqual([
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_COMPLETION_MATERIAL_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
    ])
    const completionDocument = JSON.parse(
      new TextDecoder().decode(harness.evidenceWrites[3]?.bytes),
    )
    expect(completionDocument.material).toEqual(harness.completion)
    expect(completionDocument.materialDigest).toBe(
      createMigrationDigest(harness.completion),
    )
    const boundaryDocument = JSON.parse(new TextDecoder().decode(
      harness.evidenceWrites[2]?.bytes,
    ))
    expect(harness.evidenceWrites[1]?.bytes).toEqual(
      fixture.committedRateSegment.canonicalBytes,
    )
    expect(JSON.parse(new TextDecoder().decode(
      harness.evidenceWrites[5]?.bytes,
    ))).toMatchObject({
      materialEvidenceDigest: createMigrationDigest(completionDocument),
      boundaryMaterialEvidenceDigest: createMigrationDigest(boundaryDocument),
      faultPlanDigest: createMigrationDigest(fixture.faultPlan),
      boundaryRateSegmentBytesDigest:
        fixture.committedRateSegment.segmentDigest,
      finalRateSegmentBytesDigest:
        fixture.committedRateSegment.segmentDigest,
      authenticationMac: expect.any(String),
    })
    expect(harness.stdoutLines[0]).toContain('successful-response-loss')
  })

  test('withholds success when parent-authentication persistence collides', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    const writeEvidenceFileExclusive =
      harness.dependencies.writeEvidenceFileExclusive
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      writeEvidenceFileExclusive: async (path, filename, bytes, signal) => {
        if (
          filename ===
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME
        ) return 'exists'
        return await writeEvidenceFileExclusive(path, filename, bytes, signal)
      },
    }

    await expect(runWorkspaceSearchMigrationRehearsalProcessCli(
      createAuthenticatedFaultCliArguments(fixture),
      dependencies,
    )).resolves.toBe(1)

    expect(harness.evidenceWrites.map((write) => write.filename)).toEqual([
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_MATERIAL_FILENAME,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_LIFECYCLE_FILENAME,
    ])
    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'PARENT_AUTHENTICATION_WRITE_FAILED',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
        status: 'error',
      }),
    ])
  })

  test('withholds success when interrupted during parent authentication write', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    const writeEvidenceFileExclusive =
      harness.dependencies.writeEvidenceFileExclusive
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      writeEvidenceFileExclusive: async (path, filename, bytes, signal) => {
        const outcome = await writeEvidenceFileExclusive(
          path,
          filename,
          bytes,
          signal,
        )
        if (
          filename ===
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME
        ) harness.readSignalHandler()?.('SIGTERM')
        return outcome
      },
    }

    await expect(runWorkspaceSearchMigrationRehearsalProcessCli(
      createAuthenticatedFaultCliArguments(fixture),
      dependencies,
    )).resolves.toBe(143)

    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INTERRUPTED',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
        status: 'error',
      }),
    ])
  })

  test('rejects lifecycle/material mismatch and duplicate boundary callback', async () => {
    const scenarios: readonly ('lifecycle-mismatch' | 'duplicate-boundary')[] = [
      'lifecycle-mismatch',
      'duplicate-boundary',
    ]
    for (const scenario of scenarios) {
      const fixture =
        createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
      const harness = createAuthenticatedFaultDependencyHarness(fixture)
      const runAuthenticatedFaultProcess =
        harness.dependencies.runAuthenticatedFaultProcess
      if (runAuthenticatedFaultProcess === undefined) {
        throw new Error('Missing authenticated fault runner fixture.')
      }
      const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
        ...harness.dependencies,
        runAuthenticatedFaultProcess: async (input) => {
          const lifecycle = await runAuthenticatedFaultProcess(input)
          if (scenario === 'lifecycle-mismatch') {
            return Object.freeze({
              ...lifecycle,
              materialDigest: '0'.repeat(64),
            })
          }
          await input.persistBoundaryMaterialDurably(
            Object.freeze({
              material: harness.boundary,
              materialDigest: createMigrationDigest(harness.boundary),
              observedAt: '2026-08-02T01:00:00.005Z',
            }),
            new AbortController().signal,
          )
          return lifecycle
        },
      }

      await expect(runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        dependencies,
      )).resolves.toBe(1)

      expect(harness.stdoutLines).toEqual([])
      expect(harness.evidenceWrites.some((write) =>
        write.filename ===
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME
      )).toBe(false)
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: scenario === 'lifecycle-mismatch'
            ? 'OPERATION_FAILED'
            : 'FAULT_MATERIAL_WRITE_FAILED',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
          status: 'error',
        }),
      ])
    }
  })

  test.each([
    'happy-path-verified',
    'complete-apply-rollback',
  ] satisfies readonly WorkspaceSearchMigrationRehearsalNoFaultScenario[])(
    'rejects legacy %s before evidence-directory creation or spawn',
    async (scenario) => {
      const childHarness = createNoFaultChildHarness(
        createNoFaultReceipt(scenario),
      )
      const harness = createDependencyHarness(
        createFaultPlan(),
        childHarness,
      )

      await expect(
        runWorkspaceSearchMigrationRehearsalProcessCli(
          createNoFaultCliArguments(scenario),
          harness.dependencies,
        ),
      ).resolves.toBe(2)

      expect(childHarness.events).toEqual([])
      expect(harness.evidenceWrites).toEqual([])
      expect(harness.childArguments).toEqual([])
      expect(harness.stdoutLines).toEqual([])
      expect(harness.stderrLines).toEqual([
        serializeCanonicalJson({
          code: 'INVALID_USAGE',
          kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
          status: 'error',
        }),
      ])
    },
  )

  test('does not reach legacy no-fault persistence or child containment', async () => {
    const receipt = createNoFaultReceipt('happy-path-verified')
    const childHarness = createNoFaultChildHarness(receipt)
    const harness = createDependencyHarness(createFaultPlan(), childHarness)
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      writeEvidenceFileExclusive: async (_path, filename) => {
        childHarness.events.push(`write:${filename}`)
        return 'exists'
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createNoFaultCliArguments('happy-path-verified'),
        dependencies,
      ),
    ).resolves.toBe(2)

    expect(childHarness.events).toEqual([])
    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INVALID_USAGE',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
        status: 'error',
      }),
    ])
  })

  test('contains the child and emits a stable code when material creation collides', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      writeEvidenceFileExclusive: async (path, filename, bytes, signal) => {
        harness.events.push(`write:${filename}`)
        if (
          filename ===
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME
        ) {
          return await harness.dependencies.writeEvidenceFileExclusive(
            path,
            filename,
            bytes,
            signal,
          )
        }
        return 'exists'
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        dependencies,
      ),
    ).resolves.toBe(1)

    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'FAULT_MATERIAL_WRITE_FAILED',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
        status: 'error',
      }),
    ])
    expect(harness.stderrLines[0]).not.toContain(permitPath)
  })

  test('contains a child when SIGTERM races with spawn and never starts the runner', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    let runnerCalls = 0
    const spawn = harness.dependencies.spawnControlChild
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      spawnControlChild: (arguments_) => {
        const port = spawn(arguments_)
        harness.readSignalHandler()?.('SIGTERM')
        return port
      },
      runAuthenticatedFaultProcess: async () => {
        runnerCalls += 1
        return createAuthenticatedFaultLifecycleFixture(
          harness.boundary,
          harness.completion,
        )
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        dependencies,
      ),
    ).resolves.toBe(143)

    expect(runnerCalls).toBe(0)
    expect(harness.events).toEqual([
      `write:${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME}`,
      'write:runtime-key',
      'kill:SIGKILL',
      'remove:runtime-key',
    ])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'INTERRUPTED',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
        status: 'error',
      }),
    ])
  })

  test('rejects an existing evidence directory before spawning', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    let spawnCalls = 0
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      createEvidenceDirectoryExclusive: async () => 'exists',
      spawnControlChild: () => {
        spawnCalls += 1
        return harness.dependencies.spawnControlChild([])
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        dependencies,
      ),
    ).resolves.toBe(1)
    expect(spawnCalls).toBe(0)
    expect(harness.stderrLines[0]).toContain('EVIDENCE_DIRECTORY_EXISTS')
  })

  test('rejects an expired reservation-only resume before claim or spawn', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    const readInputFile = harness.dependencies.readInputFile
    let claimCalls = 0
    let spawnCalls = 0
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      createEvidenceDirectoryExclusive: async () => 'exists',
      validateReservationOnlyDirectory: async (): Promise<void> => {},
      readInputFile: async (path, maximumBytes) => {
        if (
          path === join(
            evidenceDirectory,
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
          )
        ) {
          return new TextEncoder().encode(
            serializeCanonicalJson(fixture.stageReservation),
          )
        }
        return await readInputFile(path, maximumBytes)
      },
      now: (): Date => new Date(fixture.stageReservation.expiresAt),
      claimStageReservation: async (input) => {
        claimCalls += 1
        return await harness.dependencies.claimStageReservation?.(input) ??
          fixture.claimedStageHead
      },
      spawnControlChild: (arguments_) => {
        spawnCalls += 1
        return harness.dependencies.spawnControlChild(arguments_)
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        dependencies,
      ),
    ).resolves.toBe(2)

    expect(claimCalls).toBe(0)
    expect(spawnCalls).toBe(0)
    expect(harness.events).toEqual([])
    expect(harness.stderrLines[0]).toContain('INVALID_STAGE_SELECTION')
  })

  test('rejects a draining stage without enough reservation time before key release or spawn', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    const readInputFile = harness.dependencies.readInputFile
    let claimCalls = 0
    let runtimeKeyWrites = 0
    let spawnCalls = 0
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      createEvidenceDirectoryExclusive: async () => 'exists',
      validateReservationOnlyDirectory: async (): Promise<void> => {},
      readInputFile: async (path, maximumBytes) => {
        if (
          path === join(
            evidenceDirectory,
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
          )
        ) {
          return new TextEncoder().encode(
            serializeCanonicalJson(fixture.stageReservation),
          )
        }
        return await readInputFile(path, maximumBytes)
      },
      now: (): Date => new Date('2026-08-02T00:54:00.000Z'),
      claimStageReservation: async (input) => {
        claimCalls += 1
        return await harness.dependencies.claimStageReservation?.(input) ??
          fixture.claimedStageHead
      },
      writeRuntimeKeyFileExclusive: async (): Promise<'created'> => {
        runtimeKeyWrites += 1
        return 'created'
      },
      spawnControlChild: (arguments_) => {
        spawnCalls += 1
        return harness.dependencies.spawnControlChild(arguments_)
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        dependencies,
      ),
    ).resolves.toBe(2)

    expect(claimCalls).toBe(1)
    expect(runtimeKeyWrites).toBe(0)
    expect(spawnCalls).toBe(0)
    expect(harness.events).toEqual([])
    expect(harness.stderrLines[0]).toContain('INVALID_STAGE_SELECTION')
  })

  test('reserves the abandonment runway before a fresh remote claim', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    let claimCalls = 0
    let spawnCalls = 0
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      now: (): Date => new Date('2026-08-02T00:45:00.000Z'),
      claimStageReservation: async () => {
        claimCalls += 1
        throw new Error('Insufficient-runway claim must not be reached.')
      },
      spawnControlChild: () => {
        spawnCalls += 1
        throw new Error('Insufficient-runway spawn must not be reached.')
      },
    }

    await expect(runWorkspaceSearchMigrationRehearsalProcessCli(
      createAuthenticatedFaultCliArguments(fixture),
      dependencies,
    )).resolves.toBe(2)
    expect({ claimCalls, spawnCalls }).toEqual({
      claimCalls: 0,
      spawnCalls: 0,
    })
    expect(harness.stderrLines[0]).toContain('INVALID_STAGE_SELECTION')
  })

  test('contains a spawned child when the trusted clock reaches its reservation runtime deadline', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    let nowValue = '2026-08-02T00:10:30.000Z'
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      now: (): Date => new Date(nowValue),
      runAuthenticatedFaultProcess: async (input) => {
        if (input.now === undefined) {
          throw new Error('Missing reservation-bound runner clock.')
        }
        nowValue = '2026-08-02T01:00:00.000Z'
        input.now()
        throw new Error('Reservation deadline unexpectedly admitted.')
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        dependencies,
      ),
    ).resolves.toBe(1)

    expect(harness.events).toEqual([
      `write:${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME}`,
      'write:runtime-key',
      'kill:SIGKILL',
      'remove:runtime-key',
    ])
    expect(harness.evidenceWrites).toHaveLength(1)
    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines).toEqual([
      serializeCanonicalJson({
        code: 'PROCESS_FAILED',
        kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_PROCESS_RESULT_KIND,
        status: 'error',
      }),
    ])
  })

  test('fails a completed run when runtime-key unlink durability fails', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    let removeCalls = 0
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      cleanupRuntimeKeyFile: async () => {
        removeCalls += 1
        throw new Error('Injected unlink failure.')
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        dependencies,
      ),
    ).resolves.toBe(1)

    expect(removeCalls).toBe(2)
    expect(harness.stdoutLines).toEqual([])
    expect(harness.stderrLines[0]).toContain('OPERATION_FAILED')
  })

  test('rejects a noncanonical plan before creating the evidence directory', async () => {
    const fixture =
      createWorkspaceSearchMigrationRehearsalStageFaultMaterialTestFixture()
    const harness = createAuthenticatedFaultDependencyHarness(fixture)
    let directoryCalls = 0
    const readInputFile = harness.dependencies.readInputFile
    const dependencies: WorkspaceSearchMigrationRehearsalProcessCliDependencies = {
      ...harness.dependencies,
      readInputFile: async (path, maximumBytes) =>
        path === faultPlanPath
          ? new TextEncoder().encode(
              ` ${serializeCanonicalJson(fixture.faultPlan)}`,
            )
          : await readInputFile(path, maximumBytes),
      createEvidenceDirectoryExclusive: async () => {
        directoryCalls += 1
        return 'created'
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalProcessCli(
        createAuthenticatedFaultCliArguments(fixture),
        dependencies,
      ),
    ).resolves.toBe(2)
    expect(directoryCalls).toBe(0)
    expect(harness.stderrLines[0]).toContain('INVALID_FAULT_PLAN')
  })
})

describe('migration rehearsal bounded no-fault process runner', () => {
  test('rejects a nonzero exit before receipt persistence or acknowledgement', async () => {
    const receipt = createNoFaultReceipt('happy-path-verified')
    const events: string[] = []
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: createFiniteProcessStream([]),
      stderr: createFiniteProcessStream([encodeNoFaultReceiptLine(receipt)]),
      exited: Promise.resolve({ kind: 'exit-code', exitCode: 1 }),
      kill: (signal): void => {
        events.push(`kill:${signal}`)
      },
      acknowledgeResponseLoss: (): void => {
        events.push('ack')
      },
    }
    let persistenceCalls = 0

    await expect(
      runWorkspaceSearchMigrationRehearsalNoFaultProcess({
        process: port,
        expectedScenario: 'happy-path-verified',
        expectedControlArgumentsDigest: createMigrationDigest(['verify']),
        expectedConfigurationBindingDigest: rateConfigurationHash,
        expectsPreviousRateSegment: false,
        persistNoFaultReceiptDurably: async () => {
          persistenceCalls += 1
        },
      }),
    ).rejects.toThrow('PROCESS_FAILED')

    expect(persistenceCalls).toBe(0)
    expect(events).not.toContain('ack')
  })

  test('rejects malformed, extra, and binding-mismatched FD3 output', async () => {
    const receipt = createNoFaultReceipt('happy-path-verified')
    const mismatched = {
      ...receipt,
      configurationBindingDigest: '7'.repeat(64),
    }
    const lines = [
      new TextEncoder().encode('{"not":"a receipt"}\n'),
      new TextEncoder().encode(
        `${serializeCanonicalJson(receipt)}\n${serializeCanonicalJson(receipt)}\n`,
      ),
      new TextEncoder().encode(`${serializeCanonicalJson(mismatched)}\n`),
    ]
    for (const line of lines) {
      const terminated =
        createDeferred<WorkspaceSearchMigrationRehearsalProcessExitResult>()
      const port: WorkspaceSearchMigrationRehearsalProcessPort = {
        stdout: createProcessStream([], terminated.promise),
        stderr: createProcessStream([line], terminated.promise),
        exited: terminated.promise,
        kill: (signal): void => {
          terminated.resolve({ kind: 'signal', signal })
        },
        acknowledgeResponseLoss: (): void => {
          throw new Error('unexpected acknowledgement')
        },
      }

      await expect(
        runWorkspaceSearchMigrationRehearsalNoFaultProcess({
          process: port,
          expectedScenario: 'happy-path-verified',
          expectedControlArgumentsDigest: createMigrationDigest(['verify']),
          expectedConfigurationBindingDigest: rateConfigurationHash,
          expectsPreviousRateSegment: false,
          persistNoFaultReceiptDurably: async () => {},
        }),
      ).rejects.toThrow('PROCESS_FAILED')
    }
  })

  test('aborts a pending receipt writer and contains the child on timeout', async () => {
    const receipt = createNoFaultReceipt('happy-path-verified')
    const terminated =
      createDeferred<WorkspaceSearchMigrationRehearsalProcessExitResult>()
    let persistenceSignal: AbortSignal | undefined
    const port: WorkspaceSearchMigrationRehearsalProcessPort = {
      stdout: createProcessStream([], terminated.promise),
      stderr: createProcessStream(
        [encodeNoFaultReceiptLine(receipt)],
        terminated.promise,
      ),
      exited: terminated.promise,
      kill: (signal): void => {
        terminated.resolve({ kind: 'signal', signal })
      },
      acknowledgeResponseLoss: (): void => {
        throw new Error('unexpected acknowledgement')
      },
    }

    await expect(
      runWorkspaceSearchMigrationRehearsalNoFaultProcess({
        process: port,
        expectedScenario: 'happy-path-verified',
        expectedControlArgumentsDigest: createMigrationDigest(['verify']),
        expectedConfigurationBindingDigest: rateConfigurationHash,
        expectsPreviousRateSegment: false,
        persistNoFaultReceiptDurably: async (_input, signal) => {
          persistenceSignal = signal
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')))
          })
        },
        runtimeTimeoutMilliseconds: 5,
        containmentTimeoutMilliseconds: 50,
      }),
    ).rejects.toThrow('PROCESS_FAILED')

    expect(persistenceSignal?.aborted).toBe(true)
  })
})

describe('migration rehearsal evidence filesystem boundary', () => {
  test('uses exclusive mode-0700 directory and mode-0600 immutable files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mukuroji-rehearsal-process-'))
    const directory = join(root, 'evidence')
    try {
      await chmod(root, 0o700)
      await expect(
        createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive(
          directory,
        ),
      ).resolves.toBe('created')
      expect((await stat(directory)).mode & 0o777).toBe(0o700)
      await expect(
        createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive(
          directory,
        ),
      ).resolves.toBe('exists')

      const bytes = new TextEncoder().encode('{"safe":true}')
      await expect(
        writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FILENAME,
          bytes,
        ),
      ).resolves.toBe('created')
      const path = join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FILENAME,
      )
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect(new Uint8Array(await readFile(path))).toEqual(bytes)
      await expect(
        writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_RECEIPT_FILENAME,
          new TextEncoder().encode('{"overwrite":true}'),
        ),
      ).resolves.toBe('exists')
      expect(new Uint8Array(await readFile(path))).toEqual(bytes)
      const childMaterialBytes = new TextEncoder().encode(
        '{"material":"authenticated"}',
      )
      await expect(
        writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
          childMaterialBytes,
        ),
      ).resolves.toBe('created')
      const childMaterialPath = join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_CHILD_MATERIAL_FILENAME,
      )
      expect((await stat(childMaterialPath)).mode & 0o777).toBe(0o600)
      expect(new Uint8Array(await readFile(childMaterialPath))).toEqual(
        childMaterialBytes,
      )
      const additionalFilenames:
        readonly WorkspaceSearchMigrationRehearsalEvidenceFilename[] = [
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAULT_BOUNDARY_RATE_SEGMENT_FILENAME,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
      ]
      for (const filename of additionalFilenames) {
        const fileBytes = new TextEncoder().encode(`evidence:${filename}`)
        await expect(
          writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
            directory,
            filename,
            fileBytes,
          ),
        ).resolves.toBe('created')
        const filePath = join(directory, filename)
        expect((await stat(filePath)).mode & 0o777).toBe(0o600)
        expect(new Uint8Array(await readFile(filePath))).toEqual(fileBytes)
      }
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('recovers every parent-authentication atomic publication crash state', async () => {
    for (const crashCheckpoint of [
      'temporary-file-durable',
      'final-link-created',
      'final-link-durable',
      'temporary-link-removed',
    ] satisfies readonly WorkspaceSearchMigrationRehearsalEvidencePublicationCheckpoint[]) {
      const root = await mkdtemp(join(tmpdir(), 'mukuroji-parent-auth-publish-'))
      const directory = join(root, 'evidence')
      const finalPath = join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
      )
      const temporaryPath = join(
        directory,
        `.${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME}.publication.tmp`,
      )
      const bytes = new TextEncoder().encode('{"parent":"authenticated"}')
      try {
        await createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive(
          directory,
        )
        await expect(
          writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
            directory,
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
            bytes,
            undefined,
            {
              onCheckpoint: (checkpoint): void => {
                if (checkpoint === crashCheckpoint) {
                  throw new Error('SIMULATED_PUBLICATION_CRASH')
                }
              },
            },
          ),
        ).rejects.toThrow('OUTPUT_BOUNDARY_FAILED')
        if (crashCheckpoint === 'temporary-file-durable') {
          await expect(readFile(finalPath)).rejects
            .toMatchObject({ code: 'ENOENT' })
        } else {
          expect(new Uint8Array(await readFile(finalPath))).toEqual(bytes)
        }

        await expect(
          writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
            directory,
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
            bytes,
          ),
        ).resolves.toBe(
          crashCheckpoint === 'temporary-file-durable'
            ? 'created'
            : 'exists',
        )
        expect(new Uint8Array(await readFile(finalPath))).toEqual(bytes)
        expect((await stat(finalPath)).nlink).toBe(1)
        await expect(readFile(temporaryPath)).rejects
          .toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(root, { force: true, recursive: true })
      }
    }
  })

  test('recovers an interrupted partial parent-authentication temporary file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mukuroji-parent-auth-partial-'))
    const directory = join(root, 'evidence')
    const finalPath = join(
      directory,
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
    )
    const temporaryPath = join(
      directory,
      `.${WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME}.publication.tmp`,
    )
    const bytes = new TextEncoder().encode('{"parent":"authenticated"}')
    try {
      await createWorkspaceSearchMigrationRehearsalEvidenceDirectoryExclusive(
        directory,
      )
      await writeFile(temporaryPath, '{"partial":', { mode: 0o600 })
      await expect(readFile(finalPath)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        writeWorkspaceSearchMigrationRehearsalEvidenceFileExclusive(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_PARENT_AUTHENTICATION_FILENAME,
          bytes,
        ),
      ).resolves.toBe('created')
      expect(new Uint8Array(await readFile(finalPath))).toEqual(bytes)
      await expect(readFile(temporaryPath)).rejects
        .toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  test('accepts only an owner-only reservation regular-file resume inode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mukuroji-resume-dir-'))
    try {
      const directory = join(root, 'evidence')
      await mkdir(directory, { mode: 0o700 })
      const reservationPath = join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
      )
      await writeFile(reservationPath, '{}', { mode: 0o600 })
      await chmod(directory, 0o700)
      await chmod(reservationPath, 0o600)
      await expect(
        validateWorkspaceSearchMigrationRehearsalReservationOnlyDirectory(
          directory,
        ),
      ).resolves.toBeUndefined()

      await writeFile(
        join(
          directory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
        ),
        'partial',
        { mode: 0o600 },
      )
      await expect(
        validateWorkspaceSearchMigrationRehearsalReservationOnlyDirectory(
          directory,
        ),
      ).rejects.toThrow('OUTPUT_BOUNDARY_FAILED')
      await rm(join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ))

      await chmod(directory, 0o755)
      await expect(
        validateWorkspaceSearchMigrationRehearsalReservationOnlyDirectory(
          directory,
        ),
      ).rejects.toThrow('OUTPUT_BOUNDARY_FAILED')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects symlinked resume directories and reservation inodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mukuroji-resume-link-'))
    try {
      const targetDirectory = join(root, 'target')
      await mkdir(targetDirectory, { mode: 0o700 })
      const targetFile = join(root, 'target-reservation')
      await writeFile(targetFile, '{}', { mode: 0o600 })
      await symlink(
        targetFile,
        join(
          targetDirectory,
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_FILENAME,
        ),
      )
      await expect(
        validateWorkspaceSearchMigrationRehearsalReservationOnlyDirectory(
          targetDirectory,
        ),
      ).rejects.toThrow('OUTPUT_BOUNDARY_FAILED')

      const directoryLink = join(root, 'directory-link')
      await symlink(targetDirectory, directoryLink)
      await expect(
        validateWorkspaceSearchMigrationRehearsalReservationOnlyDirectory(
          directoryLink,
        ),
      ).rejects.toThrow('OUTPUT_BOUNDARY_FAILED')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('durably creates, collides, and removes the owner-only runtime key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mukuroji-runtime-key-'))
    try {
      const directory = join(root, 'evidence')
      await mkdir(directory, { mode: 0o700 })
      const key = new Uint8Array(32).fill(0x6a)
      await expect(
        writeWorkspaceSearchMigrationRehearsalRuntimeKeyFileExclusive(
          directory,
          key,
        ),
      ).resolves.toBe('created')
      const runtimePath = join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      )
      expect((await stat(runtimePath)).mode & 0o777).toBe(0o600)
      expect(new Uint8Array(await readFile(runtimePath))).toEqual(key)
      await expect(
        writeWorkspaceSearchMigrationRehearsalRuntimeKeyFileExclusive(
          directory,
          key,
        ),
      ).resolves.toBe('exists')
      await expect(
        removeWorkspaceSearchMigrationRehearsalRuntimeKeyFile(directory),
      ).resolves.toBeUndefined()
      await expect(readFile(runtimePath)).rejects.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
