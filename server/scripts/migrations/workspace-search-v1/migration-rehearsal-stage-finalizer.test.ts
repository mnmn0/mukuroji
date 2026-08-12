import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  calculateCrossDomainIntegrityResourceBindingDigest,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  createCrossDomainIntegrityInvocationDeadline,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS,
  runCrossDomainIntegrityCheck,
  type CrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import {
  DescribeTableCommand,
  type DescribeTableCommandOutput,
} from '@aws-sdk/client-dynamodb'
import type {
  CrossDomainIntegrityAwsTransport,
  CrossDomainIntegrityTableNames,
} from '../../data-integrity/verify-cross-domain-integrity'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  type WorkspaceSearchMigrationRehearsalFaultPlan,
  type WorkspaceSearchMigrationRehearsalFaultReceipt,
} from './migration-rehearsal-faults'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
} from './migration-rehearsal-permit'
import {
  authenticateWorkspaceSearchMigrationRehearsalCollectionContext,
  authenticateWorkspaceSearchMigrationRehearsalStageParentAuthorization,
  createWorkspaceSearchMigrationRehearsalStageParentAuthentication,
  finalizeWorkspaceSearchMigrationRehearsalStageReceipt,
  isWorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage,
  readWorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim,
  readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding,
  snapshotWorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext,
  WorkspaceSearchMigrationRehearsalStageFinalizerError,
  type WorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage,
  type WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageParentAuthentication,
  type WorkspaceSearchMigrationRehearsalStageFinalizationProof,
} from './migration-rehearsal-stage-finalizer'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  createWorkspaceSearchMigrationRehearsalRateRecorder,
  finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor,
  type FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
} from './migration-rehearsal-rate-evidence'
import {
  finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval,
  type WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
} from './migration-rehearsal-integrity-rate-adapter'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
  type WorkspaceSearchMigrationDescribeTablePhase,
  type WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import type {
  WorkspaceSearchMigrationManagedDescribeTableRate,
} from './migration-describe-table-rate-managed-session'
import {
  finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact,
  type WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  type WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding,
  type WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair,
} from './migration-rehearsal-reconciliation-audit'
import {
  cleanupWorkspaceSearchMigrationRehearsalRuntimeKey,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
  type WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization,
} from './migration-rehearsal-runtime-key-cleanup'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterial,
  type WorkspaceSearchMigrationRehearsalCapturedMutationObservation,
  type WorkspaceSearchMigrationRehearsalChildMutationResult,
  type WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
} from './migration-rehearsal-stage-child-material'
import {
  createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial,
  createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial,
  type WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-stage-fault-material'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence,
  createWorkspaceSearchMigrationRehearsalStageManifest,
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  deriveWorkspaceSearchMigrationRehearsalStageChainEvidence,
  selectWorkspaceSearchMigrationRehearsalStage,
  verifyWorkspaceSearchMigrationRehearsalStageReceipt,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestClaims,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
} from './migration-rehearsal-stage-receipt'
import {
  authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
  type WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding,
  type WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  type WorkspaceSearchMigrationRehearsalTargetAuditContext,
  type WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding,
} from './migration-rehearsal-target-audit'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS,
} from './migration-rehearsal-stage-reservation'
import type {
  WorkspaceSearchMigrationRehearsalStageHead,
} from './migration-rehearsal-stage-reservation-aws'

/** Main stage key retained by the fixture and copied for owned calls. */
const mainKey = new Uint8Array(32).fill(31)

/** Parent-only publication key retained by the fixture and copied for calls. */
const publicationKey = new Uint8Array(32).fill(37)

/** Dedicated #163 result key retained by the fixture. */
const integrityKey = new Uint8Array(32).fill(47)

/** Dedicated target-audit key retained by the fixture. */
const targetAuditKey = new Uint8Array(32).fill(59)

/** Private physical-resource authority shared by genuine live fixture checks. */
const integrityResourceAttestation:
  CrossDomainIntegrityResourceAttestation = Object.freeze({
    kind: 'mukuroji-cross-domain-integrity-resource-attestation',
    version: 1,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account: '123456789012',
    region: 'ap-northeast-1',
    bucket: Object.freeze({
      target: 'bucket:file',
      bucketName: 'mukuroji-stage-finalizer-files',
      marker: Object.freeze({
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'stage-finalizer-marker-version-1',
        checksumSha256: Buffer.alloc(32, 0x61).toString('base64'),
        size: 128,
      }),
    }),
    tables: Object.freeze(
      CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS.map((target, index) => {
        const tableName = `stage-finalizer-${index + 1}`
        return Object.freeze({
          target,
          tableName,
          tableArn:
            `arn:aws:dynamodb:ap-northeast-1:123456789012:table/${tableName}`,
          tableId: `stage-finalizer-table-id-${index + 1}`,
          creationTime: `2026-01-0${index + 1}T00:00:00.000Z`,
        })
      }),
    ),
  })

/** Canonical keyed identities derived from the private fixture authority. */
const integrityResourceIdentities =
  createCrossDomainIntegrityImmutableResourceIdentities(
    integrityResourceAttestation,
    integrityKey,
  )

/** Reviewed implementation commit shared by every fixture artifact. */
const fixtureCommit = 'a'.repeat(40)

/** One concise manifest stage before global ordinals are assigned. */
type FixtureStage = {
  /** Exact reviewed control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Expected finite process outcome. */
  readonly outcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Whether the position owns the reviewed fault plan. */
  readonly fault: boolean
  /** One-based logical attempt ordinal. */
  readonly attemptOrdinal: number
}

/** Returns the exact reviewed runtime fault plan for one fault scenario. */
function fixtureFaultPlan(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalFaultPlan {
  const common: {
    /** Fixed non-production runtime boundary. */
    readonly stage: 'non-production'
    /** Exact reviewed acknowledgement literal. */
    readonly approval: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL
  } = {
    stage: 'non-production',
    approval: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_APPROVAL,
  }
  switch (scenario) {
    case 'cursor-before-commit-kill':
    case 'cursor-after-commit-kill':
      return Object.freeze({
        ...common,
        failpoint: scenario === 'cursor-before-commit-kill'
          ? 'apply-checkpoint-cursor-captured-before-commit'
          : 'apply-checkpoint-cursor-committed-before-return',
        target: Object.freeze({
          kind: 'apply-checkpoint',
          location: 'documents',
          pageSequence: 2,
          cursorState: 'present',
        }),
      })
    case 'artifact-before-checkpoint-kill':
    case 'transaction-response-loss':
      return Object.freeze({
        ...common,
        failpoint: scenario === 'artifact-before-checkpoint-kill'
          ? 'planning-page-artifact-uploaded-before-checkpoint-commit'
          : 'planning-page-transaction-response-lost',
        target: Object.freeze({
          kind: 'source',
          source: 'documents',
          pageSequence: 2,
          cursorState: 'present',
        }),
      })
    case 'lease-expiry-takeover':
      return Object.freeze({
        ...common,
        failpoint: 'lease-acquired-before-first-heartbeat',
        target: Object.freeze({ kind: 'planning-lease' }),
      })
    case 'partial-apply-rollback':
      return Object.freeze({
        ...common,
        failpoint: 'apply-operation-committed-before-return',
        target: Object.freeze({
          kind: 'apply-operation',
          planSequence: 1,
          remainingOperations: 'present',
        }),
      })
    case 'complete-apply-rollback':
    case 'happy-path-verified':
      throw new Error('Expected a fault scenario.')
  }
}

/** Persisted generic-success files prepared for one finalizer call. */
type PersistedSuccessFixture = {
  /** Exact authenticated child material nested in the persisted wrapper. */
  readonly material: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageChildMaterial
  >
  /** Parent-persisted authenticated child-material wrapper. */
  readonly materialEvidence: unknown
  /** Parent-persisted successful lifecycle wrapper. */
  readonly lifecycleEvidence: unknown
  /** Parent-origin HMAC binding both persisted wrappers. */
  readonly parentAuthentication:
    WorkspaceSearchMigrationRehearsalStageParentAuthentication
}

/** Shared authenticated manifest and fixture bindings. */
type ManifestFixture = {
  /** Complete reviewed authenticated manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Manifest claims used for expected fixture values. */
  readonly claims: WorkspaceSearchMigrationRehearsalStageManifestClaims
}

/** Fresh authenticated reservation and claimed durable head for one stage. */
type StageContextFixture = {
  /** Exact authenticated reservation installed before child execution. */
  readonly stageReservation: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageReservation
  >
  /** Durable head returned by the successful reservation claim. */
  readonly claimedStageHead: WorkspaceSearchMigrationRehearsalStageHead
}

/** Persisted authenticated material for a stopped fault boundary. */
type PersistedFaultBoundaryFixture = {
  /** Selects a confirmed-SIGKILL boundary protocol. */
  readonly kind: 'fault-boundary'
  /** Exact producer-authenticated boundary material. */
  readonly material: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial
  >
  /** Parent-persisted boundary-material evidence wrapper. */
  readonly materialEvidence: unknown
  /** Parent-persisted confirmed-SIGKILL lifecycle wrapper. */
  readonly lifecycleEvidence: unknown
  /** Reviewed runtime fault plan. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Exact authenticated durable rate prefix bytes. */
  readonly boundaryRateSegmentBytes: Uint8Array
  /** Parent-origin HMAC binding the complete persisted protocol. */
  readonly parentAuthentication:
    WorkspaceSearchMigrationRehearsalStageParentAuthentication
}

/** Persisted authenticated two-phase transaction response-loss material. */
type PersistedFaultCompletionFixture = {
  /** Selects the reconciled two-phase completion protocol. */
  readonly kind: 'fault-completion'
  /** Exact producer-authenticated final completion material. */
  readonly material: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial
  >
  /** Parent-persisted completion-material evidence wrapper. */
  readonly materialEvidence: unknown
  /** Parent-persisted first boundary-material evidence wrapper. */
  readonly boundaryMaterialEvidence: unknown
  /** Parent-persisted response-loss lifecycle wrapper. */
  readonly lifecycleEvidence: unknown
  /** Reviewed transaction response-loss fault plan. */
  readonly faultPlan: WorkspaceSearchMigrationRehearsalFaultPlan
  /** Exact authenticated first durable rate prefix bytes. */
  readonly boundaryRateSegmentBytes: Uint8Array
  /** Exact authenticated final durable rate segment bytes. */
  readonly finalRateSegmentBytes: Uint8Array
  /** Parent-origin HMAC binding the complete persisted protocol. */
  readonly parentAuthentication:
    WorkspaceSearchMigrationRehearsalStageParentAuthentication
}

/** Either finite authenticated fault-material protocol. */
type PersistedFaultFixture =
  | PersistedFaultBoundaryFixture
  | PersistedFaultCompletionFixture

/** One command proof plus every ownership-transferred evidence key. */
type StageProofFixture = {
  /** Exact command-specific finalization proof. */
  readonly proof: WorkspaceSearchMigrationRehearsalStageFinalizationProof
  /** Dedicated keys that must be cleared by the finalizer. */
  readonly ownedEvidenceKeys: readonly Uint8Array[]
}

/** Returns one deterministic lowercase SHA-256 digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Returns a canonical fixture timestamp from a normalized second offset. */
function at(second: number): string {
  return new Date(Date.UTC(2026, 7, 1, 0, 0, second)).toISOString()
}

/** Creates the strict clean ordinal-zero root used by stage fixtures. */
function createIntegrityAttestationRoot():
  WorkspaceSearchMigrationRehearsalStageManifestClaims[
    'integrityAttestationRoot'
  ] {
  const policyVersion = digest('rate-policy')
  const aggregate = Object.freeze({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion,
    attemptCount: 12,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    awsServiceThrottleCount: 0,
    rehearsalInjectedThrottleCount: 0,
    budgetStopCount: 0,
    operationalBudgetStopCount: 0,
    awsServiceThrottleBudgetStopCount: 0,
    rehearsalInjectedBudgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  })
  return Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId: 'stage-finalizer-fixture',
    productionAccountDigest: digest('production-account'),
    configurationBindingDigest: digest('configuration'),
    policyVersion,
    attestation: Object.freeze({
      contentMac: digest('root-attestation-content'),
      byteLength: 1_024,
    }),
    segment: Object.freeze({
      authenticationKeyFingerprint:
        createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
          mainKey,
        ),
      segmentLocatorDigest: digest('root-segment-locator'),
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac: digest('root-terminal-record'),
      segmentDigest: digest('root-segment'),
    }),
    interval: Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
      version: 1,
      phase: 'integrity-check',
      tablePassCount: 1,
      describeTableCallCount: 6,
      firstAttemptSequence: 7,
      lastAttemptSequence: 12,
      attemptSequences: Object.freeze([7, 8, 9, 10, 11, 12]),
      firstEventSequence: 13,
      lastEventSequence: 24,
      eventSequences: Object.freeze(
        Array.from({ length: 12 }, (_value, index) => index + 13),
      ),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: at(-0.8),
      completedAt: at(-0.2),
    }),
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac: digest('root-table-order'),
    rootMac: digest('root'),
    startedAt: at(-1),
    completedAt: at(0),
  })
}

/** Returns the base second assigned to one global stage ordinal. */
function stageBase(ordinal: number): number {
  return (ordinal - 1) * 20
}

/** Creates one genuine durable cleanup capability for an exact stage. */
async function createRuntimeKeyCleanupAuthorization(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  reservation: ReturnType<
    typeof createWorkspaceSearchMigrationRehearsalStageReservation
  >,
): Promise<WorkspaceSearchMigrationRehearsalRuntimeKeyCleanupAuthorization> {
  const directory = await mkdtemp(join(
    tmpdir(),
    'mukuroji-stage-finalizer-cleanup-',
  ))
  const base = stageBase(selection.entry.ordinal)
  const times = Object.freeze([
    new Date(at(base + 14)),
    new Date(at(base + 15)),
  ])
  let clockIndex = 0
  try {
    await writeFile(
      join(
        directory,
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RUNTIME_KEY_FILENAME,
      ),
      mainKey,
      { mode: 0o600 },
    )
    return await cleanupWorkspaceSearchMigrationRehearsalRuntimeKey({
      evidenceDirectory: directory,
      reservation,
      selection,
      expectedRuntimeKey: mainKey,
      publicationAuthenticationKey: publicationKey,
      now: (): Date => {
        const value = times[clockIndex]
        clockIndex += 1
        if (value === undefined) {
          throw new Error('Unexpected cleanup clock read.')
        }
        return value
      },
    })
  } finally {
    await rm(directory, { force: true, recursive: true })
  }
}

/** Returns whether one caller-owned key was overwritten completely. */
function isZeroized(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0)
}

/**
 * Encodes one exact canonical document for the byte-oriented collection API.
 *
 * @param value - JSON-compatible fixture document.
 * @returns Exact UTF-8 canonical bytes without a trailing newline.
 */
function encodeCollectionDocument(value: unknown): Uint8Array {
  return new TextEncoder().encode(serializeCanonicalJson(value))
}

/** Returns the canonical reviewed shape for one required scenario. */
function fixtureStages(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): readonly FixtureStage[] {
  /** Creates one ordinary completed fixture stage. */
  const completed = (
    command: WorkspaceSearchMigrationRehearsalStageCommand,
    attemptOrdinal: number,
  ): FixtureStage => ({
    command,
    outcome: 'completed',
    fault: false,
    attemptOrdinal,
  })
  if (scenario === 'happy-path-verified') {
    return [
      completed('close-replan', 1),
      completed('apply', 1),
      completed('verify', 1),
      completed('release', 1),
    ]
  }
  if (scenario === 'complete-apply-rollback') {
    return [
      completed('close-replan', 1),
      completed('apply', 1),
      completed('rollback-complete', 1),
      completed('release', 1),
    ]
  }
  if (scenario === 'partial-apply-rollback') {
    return [
      completed('close-replan', 1),
      {
        command: 'apply',
        outcome: 'fault-reached',
        fault: true,
        attemptOrdinal: 1,
      },
      {
        command: 'rollback-partial',
        outcome: 'takeover-completed',
        fault: false,
        attemptOrdinal: 2,
      },
      completed('release', 2),
    ]
  }
  if (scenario === 'transaction-response-loss') {
    return [
      {
        command: 'close-replan',
        outcome: 'response-loss-reconciled',
        fault: true,
        attemptOrdinal: 1,
      },
      completed('apply', 1),
      completed('verify', 1),
      completed('release', 1),
    ]
  }
  const faultCommand =
    scenario === 'artifact-before-checkpoint-kill' ||
      scenario === 'lease-expiry-takeover'
      ? 'close-replan'
      : 'apply'
  const stages: FixtureStage[] = []
  if (faultCommand === 'apply') stages.push(completed('close-replan', 1))
  stages.push({
    command: faultCommand,
    outcome: 'fault-reached',
    fault: true,
    attemptOrdinal: 1,
  })
  stages.push({
    command: faultCommand,
    outcome: 'takeover-completed',
    fault: false,
    attemptOrdinal: 2,
  })
  if (faultCommand === 'close-replan') {
    stages.push(completed('apply', 2))
  }
  stages.push(completed('verify', 2), completed('release', 2))
  return stages
}

/** Returns exact mutation arguments authenticated by one manifest entry. */
function controlArguments(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  scenarioStageOrdinal: number,
  command: WorkspaceSearchMigrationRehearsalStageCommand,
  attemptOrdinal: number,
): readonly string[] {
  return Object.freeze([
    command,
    '--run-id',
    `run-${scenario}`,
    '--owner-id',
    `owner-${scenario}-${attemptOrdinal}`,
    '--fixture-stage',
    `${scenario}-${scenarioStageOrdinal}`,
  ])
}

/** Creates the canonical #163 physical identity vector for one namespace. */
function fixtureIntegrityResourceIdentities(_namespace: string) {
  return integrityResourceIdentities.map((identity) => ({ ...identity }))
}

/** Creates a complete valid reviewed manifest and its detached claims. */
function createManifestFixture(): ManifestFixture {
  const entries: WorkspaceSearchMigrationRehearsalStageManifestEntry[] = []
  let ordinal = 1
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const stages = fixtureStages(scenario)
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]
      if (stage === undefined) throw new Error('Missing fixture stage.')
      entries.push(Object.freeze({
        ordinal,
        scenario,
        scenarioStageOrdinal: index + 1,
        command: stage.command,
        controlArgumentsDigest: createMigrationDigest(controlArguments(
          scenario,
          index + 1,
          stage.command,
          stage.attemptOrdinal,
        )),
        attemptOrdinal: stage.attemptOrdinal,
        faultPlanDigest: stage.fault
          ? createMigrationDigest(fixtureFaultPlan(scenario))
          : null,
        expectedOutcome: stage.outcome,
      }))
      ordinal += 1
    }
  }
  const claims: WorkspaceSearchMigrationRehearsalStageManifestClaims =
    Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
      manifestVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
      stage: 'non-production',
      commit: fixtureCommit,
      permitDigest: digest('permit'),
      evidenceKeyDigest: createHash('sha256')
        .update(mainKey)
        .digest('hex'),
      publicationKeyDigest: createHash('sha256')
        .update(publicationKey)
        .digest('hex'),
      deploymentTrustRootDigest: digest('deployment-trust-root'),
      requestedResourcesBinding: digest('requested-resources'),
      configurationBindingDigest: digest('configuration'),
      integrityResourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      integrityResourceIdentities:
        fixtureIntegrityResourceIdentities('resource'),
      integrityResourceIdentityDigest:
        calculateCrossDomainIntegrityResourceIdentityDigest(
          fixtureIntegrityResourceIdentities('resource'),
          integrityKey,
        ),
      integrityAttestationRoot: createIntegrityAttestationRoot(),
      policyVersion: digest('rate-policy'),
      reviewedAt: at(0),
      entries: Object.freeze(entries),
    })
  return Object.freeze({
    claims,
    manifest: createWorkspaceSearchMigrationRehearsalStageManifest({
      claims,
      signingKey: mainKey,
    }),
  })
}

/** Narrows one freshly authenticated selection to finalizer-supported paths. */
function requireSupportedSelection(
  selection: WorkspaceSearchMigrationRehearsalSelectedStage,
): WorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage {
  if (!isWorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage(
    selection,
  )) throw new Error('Expected a generic-success fixture selection.')
  return selection
}

/** Selects one exact supported successor from the fixture manifest. */
function selectSupportedStage(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalGenericSuccessSelectedStage {
  return requireSupportedSelection(
    selectWorkspaceSearchMigrationRehearsalStage({
      manifest,
      verificationKey: mainKey,
      previousReceipt,
      controlArguments: controlArguments(
        entry.scenario,
        entry.scenarioStageOrdinal,
        entry.command,
        entry.attemptOrdinal,
      ),
      faultPlanDigest: null,
    }),
  )
}

/** Selects any one exact entry in the reviewed complete manifest. */
function selectCompleteManifestStage(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalSupportedSelectedStage {
  return selectWorkspaceSearchMigrationRehearsalStage({
    manifest,
    verificationKey: mainKey,
    previousReceipt,
    controlArguments: controlArguments(
      entry.scenario,
      entry.scenarioStageOrdinal,
      entry.command,
      entry.attemptOrdinal,
    ),
    faultPlanDigest: entry.faultPlanDigest === null
      ? null
      : createMigrationDigest(fixtureFaultPlan(entry.scenario)),
  })
}

/** Creates the exact fresh reservation and claimed head for one selection. */
function createStageContext(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): StageContextFixture {
  const entry = selection.entry
  const base = stageBase(entry.ordinal)
  const claimSeconds =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RESERVATION_CLAIM_MILLISECONDS /
    1_000
  const expectedTargetPreimageArtifactContentDigest =
    entry.command === 'apply' &&
      (entry.scenario === 'complete-apply-rollback' ||
        entry.scenario === 'partial-apply-rollback')
      ? (() => {
          if (
            previousReceipt === null ||
            previousReceipt.evidence.kind !== 'planning-sealed'
          ) throw new Error('Expected rollback planning receipt.')
          return createHash('sha256').update(
            createScenarioPreimageArtifact(
              selection.manifest,
              entry.scenario,
              previousReceipt,
            ),
          ).digest('hex')
        })()
      : null
  const stageReservation =
    createWorkspaceSearchMigrationRehearsalStageReservation({
      selection,
      nonce: createHash('sha256')
        .update(`reservation:${entry.ordinal}`, 'utf8')
        .digest(),
      reservedAt: at(base - 2),
      expiresAt: at(base - 2 + claimSeconds),
      expectedPreviousRateSegment: previousReceipt?.rateSegment ??
        selection.manifest.integrityAttestationRoot.segment,
      expectedCurrentRateSegmentOrdinal:
        previousReceipt === null
          ? selection.manifest.integrityAttestationRoot.segment
              .segmentOrdinal + 1
          : previousReceipt.rateSegment.segmentOrdinal + 1,
      expectedTargetPreimageArtifactContentDigest,
      signingKey: mainKey,
    })
  return Object.freeze({
    stageReservation,
    claimedStageHead: Object.freeze({
      manifestDigest: selection.manifestDigest,
      completedStageOrdinal: entry.ordinal - 1,
      headReceiptDigest: selection.previousStageReceiptDigest,
      activeReservationDigest: createMigrationDigest(stageReservation),
      activeStageOrdinal: entry.ordinal,
      activeExpiresAt: stageReservation.expiresAt,
      abandonmentCount: 0,
      abandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      revision: entry.ordinal * 2 - 1,
    }),
  })
}

/** Creates the exact lease observation continuous with the prior receipt. */
function createLeaseObservation(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation {
  const entry = selection.entry
  const base = stageBase(entry.ordinal)
  const identity = digest(`lease:${entry.scenario}:${entry.attemptOrdinal}`)
  const sameAttempt = previousReceipt?.scenario === entry.scenario &&
    previousReceipt.attemptOrdinal === entry.attemptOrdinal
  if (sameAttempt) {
    return Object.freeze({
      kind: 'reused-active',
      currentLeaseIdentityDigest:
        previousReceipt.leaseIdentityDigest,
      evaluatedAt: at(base),
      currentLeaseExpiresAt: at(base + 3_599),
    })
  }
  return Object.freeze({
    kind: 'acquired',
    predecessorLeaseIdentityDigest:
      previousReceipt?.leaseIdentityDigest ?? null,
    predecessorLeaseExpiresAt: previousReceipt === null
      ? null
      : at(base - 2),
    acquiredAt: at(base),
    successorLeaseIdentityDigest: identity,
    successorLeaseExpiresAt: at(base + 3_599),
  })
}

/** Creates strict command-specific coordinator material for one selection. */
function createMutationResult(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null = null,
): WorkspaceSearchMigrationRehearsalChildMutationResult {
  const entry = selection.entry
  const base = stageBase(entry.ordinal)
  const scenario = entry.scenario
  const planDigest = digest(`plan:${scenario}`)
  const executionBoundaryDigest = digest(`boundary:${scenario}`)
  const closedWriterFenceRecordDigest = digest(`closed-fence:${scenario}`)
  const sealedPlanningAuthorityDigest = digest(`authority:${scenario}`)
  const executionRunDigest = digest(`execution:${scenario}`)
  const appliedRootDigest = digest(`applied:${scenario}`)
  const terminalRootDigest = digest(`terminal:${scenario}`)
  let coordinator:
    WorkspaceSearchMigrationRehearsalChildMutationResult['coordinator']
  if (entry.command === 'close-replan') {
    coordinator = Object.freeze({
      mode: 'close-replan',
      phase: 'planning-admitted',
      planning: Object.freeze({
        executionBoundaryDigest,
        closedWriterFenceRecordDigest,
        closedAt: at(base + 1),
        drainStartedAt: at(base + 2),
        drainCompletedAt: at(base + 3),
        admittedAt: at(base + 4),
        sealedPlanningAuthorityDigest,
        planDigest,
        planOperationCount: 3,
        sourceOperationCount: 2,
        orphanOperationCount: 1,
        planCreatedAt: at(base + 5),
        sealedAt: at(base + 6),
      }),
    })
  } else if (entry.command === 'apply') {
    const nextActions: readonly ['verify', 'complete-rollback'] =
      Object.freeze(['verify', 'complete-rollback'])
    coordinator = Object.freeze({
      mode: 'apply',
      execution: Object.freeze({
        phase: 'applied',
        nextAction: Object.freeze({
          kind: 'choose',
          options: nextActions,
        }),
      }),
      application: Object.freeze({
        executionRunDigest,
        planDigest,
        sealedPlanOperationCount: 3,
        appliedOperationCount: 3,
        appliedRootDigest,
        appliedAt: at(base + 5),
      }),
    })
  } else if (
    entry.command === 'verify' ||
    entry.command === 'rollback-complete' ||
    entry.command === 'rollback-partial'
  ) {
    const partial = entry.command === 'rollback-partial'
    if (
      previousReceipt === null ||
      (previousReceipt.evidence.kind !== 'apply-complete' &&
        previousReceipt.evidence.kind !== 'fault-boundary')
    ) {
      throw new Error('Expected authenticated apply boundary evidence.')
    }
    const applyBoundaryDigest = partial
      ? digest(`partial-origin:${scenario}`)
      : previousReceipt.evidence.kind === 'apply-complete'
      ? previousReceipt.evidence.appliedRootDigest
      : (() => {
          throw new Error('Expected complete applied-root evidence.')
        })()
    coordinator = Object.freeze({
      mode: entry.command,
      execution: Object.freeze({
        phase: entry.command === 'verify' ? 'verified' : 'rolled-back',
        nextAction: Object.freeze({ kind: 'none' }),
      }),
      terminal: Object.freeze({
        terminalKind:
          entry.command === 'verify' ? 'verified' : 'rolled-back',
        terminalPersistenceVersion: partial ? 2 : 1,
        terminalRootDigest,
        terminalAt: at(base + 5),
        executionBoundaryDigest,
        closedWriterFenceRecordDigest,
        sealedPlanningAuthorityDigest,
        executionRunDigest,
        planDigest,
        planOperationCount: 3,
        appliedOperationCount: partial ? 1 : 3,
        applyBoundaryDigest,
      }),
    })
  } else {
    const partial = scenario === 'partial-apply-rollback'
    coordinator = Object.freeze({
      mode: 'release',
      phase: 'released',
      terminalKind:
        scenario === 'partial-apply-rollback' ||
          scenario === 'complete-apply-rollback'
          ? 'rolled-back'
          : 'verified',
      terminalPersistenceVersion: partial ? 2 : 1,
      terminalRootDigest,
      writerFenceRecordDigest: digest(`released-fence:${scenario}`),
      releasedAt: at(base + 5),
    })
  }
  return Object.freeze({
    schemaVersion: 1,
    operation: entry.command,
    status: 'pass',
    configurationHash: selection.manifest.configurationBindingDigest,
    policyVersion: selection.manifest.policyVersion,
    coordinator,
    rateAggregate: Object.freeze({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      policyVersion: selection.manifest.policyVersion,
      attemptCount: 1,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      awsServiceThrottleCount: 0,
      rehearsalInjectedThrottleCount: 0,
      budgetStopCount: 0,
      operationalBudgetStopCount: 0,
      awsServiceThrottleBudgetStopCount: 0,
      rehearsalInjectedBudgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 1,
    }),
  })
}

/** Creates persisted material and lifecycle wrappers for one stage. */
async function createPersistedSuccessFixture(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  leaseObservationOverride:
    WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation | null = null,
): Promise<PersistedSuccessFixture> {
  const entry = selection.entry
  const base = stageBase(entry.ordinal)
  const observation: WorkspaceSearchMigrationRehearsalCapturedMutationObservation =
    Object.freeze({
      result: createMutationResult(selection, previousReceipt),
      serializedOutputLineDigest: digest(`stdout-line:${entry.ordinal}`),
    })
  const context = createStageContext(selection, previousReceipt)
  const material =
    createWorkspaceSearchMigrationRehearsalStageChildMaterial({
      selection,
      observation,
      committedRateSegment: await createCommittedRateSegment(
        selection,
        previousReceipt,
      ),
      stageReservation: context.stageReservation,
      claimedStageHead: context.claimedStageHead,
      leaseAcquisitionObservation:
        leaseObservationOverride ??
          createLeaseObservation(selection, previousReceipt),
      authenticationKey: mainKey,
    })
  const materialDigest = createMigrationDigest(material)
  const materialObservedAt = at(base + 10)
  const lifecycle = Object.freeze({
    lifecycleVersion: 1,
    manifestDigest: selection.manifestDigest,
    manifestEntryDigest: createMigrationDigest(entry),
    previousStageReceiptDigest: selection.previousStageReceiptDigest,
    stageOrdinal: entry.ordinal,
    scenario: entry.scenario,
    command: entry.command,
    attemptOrdinal: entry.attemptOrdinal,
    expectedOutcome: entry.expectedOutcome,
    materialDigest,
    stdoutSha256: digest(`stdout:${entry.ordinal}`),
    runnerStartedAt: at(base),
    materialObservedAt,
    materialPersistedAt: at(base + 11),
    processExitedAt: at(base + 12),
    exitClass: 'successful-no-fault',
  })
  const materialEvidence = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-child-material-evidence',
      evidenceVersion: 1,
      material,
      materialDigest,
      observedAt: materialObservedAt,
    })
  const lifecycleEvidence = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
      lifecycle,
      lifecycleSha256: createMigrationDigest(lifecycle),
    })
  const runtimeAuthenticationKey = new Uint8Array(mainKey)
  const publicationAuthenticationKey = new Uint8Array(publicationKey)
  const runtimeKeyCleanupAuthorization =
    await createRuntimeKeyCleanupAuthorization(
      selection,
      material.stageReservation,
    )
  const parentAuthentication =
    createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
      selection,
      materialKind: 'success',
      persistedMaterialEvidence: materialEvidence,
      persistedLifecycleEvidence: lifecycleEvidence,
      runtimeAuthenticationKey,
      publicationAuthenticationKey,
      runtimeKeyCleanupAuthorization,
    })
  if (
    !isZeroized(runtimeAuthenticationKey) ||
    !isZeroized(publicationAuthenticationKey)
  ) {
    throw new Error('Expected parent-authentication key zeroization.')
  }
  return Object.freeze({
    material,
    materialEvidence,
    lifecycleEvidence,
    parentAuthentication,
  })
}

/** Creates one real authenticated empty rate segment for child material. */
async function createCommittedRateSegment(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment> {
  const entry = selection.entry
  const ratePredecessor = previousReceipt?.rateSegment ??
    selection.manifest.integrityAttestationRoot.segment
  const recorder =
    await createWorkspaceSearchMigrationRehearsalRateRecorder({
      segmentLocatorDigest: digest(`segment-locator:${entry.ordinal}`),
      segmentOrdinal: ratePredecessor.segmentOrdinal + 1,
      previousSegmentDigest: ratePredecessor.segmentDigest,
      previousRecordMac: ratePredecessor.terminalRecordMac,
      firstEventSequence: ratePredecessor.firstEventSequence +
        ratePredecessor.eventCount,
      anchorUtc: at(stageBase(entry.ordinal)),
      monotonicAnchorMilliseconds: 0,
      policyVersion: selection.manifest.policyVersion,
      configurationBindingDigest:
        selection.manifest.configurationBindingDigest,
      authenticationKey: mainKey,
      /** Confirms each exact fixture header append immediately. */
      appendDurably: async () => {},
    })
  try {
    const committed = await recorder.flush()
    return Object.freeze({
      ...committed,
      authenticationKeyFingerprint:
        createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
          mainKey,
        ),
    })
  } finally {
    await recorder.close()
  }
}

/** Returns the stable current identity proven by one lease observation. */
function observedLeaseIdentityDigest(
  observation: WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation,
): string {
  return observation.kind === 'acquired'
    ? observation.successorLeaseIdentityDigest
    : observation.currentLeaseIdentityDigest
}

/** Creates the exact secret-free runtime receipt for one selected fault. */
function createFaultReceipt(
  plan: WorkspaceSearchMigrationRehearsalFaultPlan,
  reachedAt: string,
): WorkspaceSearchMigrationRehearsalFaultReceipt {
  return Object.freeze({
    receiptVersion: 1,
    stage: 'non-production',
    failpoint: plan.failpoint,
    action: plan.failpoint === 'planning-page-transaction-response-lost'
      ? 'response-loss'
      : 'barrier',
    target: plan.target,
    occurrence: 1,
    reachedAt,
  })
}

/** Creates failpoint-specific adapter-proven durable runtime state. */
function createFaultObservation(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  plan: WorkspaceSearchMigrationRehearsalFaultPlan,
  leaseIdentityDigest: string,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): WorkspaceSearchMigrationRehearsalFaultObservation {
  const scenario = selection.entry.scenario
  switch (plan.failpoint) {
    case 'planning-page-artifact-uploaded-before-checkpoint-commit':
      return Object.freeze({
        observationVersion: 1,
        leaseIdentityDigest,
        kind: 'planning-page',
        failpoint: plan.failpoint,
        durableAppliedOperationCount: 0,
        sealedPlanOperationCount: null,
        closedWriterFenceRecordDigest:
          digest(`fault-closed-fence:${scenario}`),
        durableHeadPosition: 'predecessor',
        durableHeadPageSequence: plan.target.pageSequence - 1,
        durableHeadEvidenceDigest: digest(`head-evidence:${scenario}`),
        durableHeadCheckpointDigest:
          digest(`head-checkpoint:${scenario}`),
        durableHeadProgressDigest: digest(`head-progress:${scenario}`),
        durableHeadCursorState: 'present',
        durableHeadCompleted: false,
        planningTarget: plan.target,
      })
    case 'planning-page-transaction-response-lost':
      return Object.freeze({
        observationVersion: 1,
        leaseIdentityDigest,
        kind: 'planning-page',
        failpoint: plan.failpoint,
        durableAppliedOperationCount: 0,
        sealedPlanOperationCount: null,
        closedWriterFenceRecordDigest:
          digest(`closed-fence:${scenario}`),
        durableHeadPosition: 'committed-successor',
        durableHeadPageSequence: plan.target.pageSequence,
        durableHeadEvidenceDigest: digest(`head-evidence:${scenario}`),
        durableHeadCheckpointDigest:
          digest(`head-checkpoint:${scenario}`),
        durableHeadProgressDigest: digest(`head-progress:${scenario}`),
        durableHeadCursorState: 'present',
        durableHeadCompleted: false,
        planningTarget: plan.target,
      })
    case 'apply-checkpoint-cursor-captured-before-commit':
    case 'apply-checkpoint-cursor-committed-before-return': {
      const writerFenceDigest = previousReceipt?.writerFenceDigest
      if (writerFenceDigest === undefined) {
        throw new Error('Expected planning receipt before apply fault.')
      }
      const successor = plan.failpoint ===
        'apply-checkpoint-cursor-committed-before-return'
      return Object.freeze({
        observationVersion: 1,
        leaseIdentityDigest,
        kind: 'apply-checkpoint',
        failpoint: plan.failpoint,
        durableAppliedOperationCount: 3,
        sealedPlanOperationCount: 3,
        closedWriterFenceRecordDigest: writerFenceDigest,
        checkpointLocation: plan.target.location,
        durableStatePosition: successor
          ? 'committed-successor'
          : 'predecessor',
        durableStateRevision: selection.entry.ordinal * 10,
        durableStateStatus: 'applying',
        durableRunStateDigest: digest(`durable-run:${scenario}`),
        durableCheckpointDigest: digest(`apply-checkpoint:${scenario}`),
        durableCheckpointPageSequence: successor
          ? plan.target.pageSequence
          : plan.target.pageSequence - 1,
        durableCheckpointCursorState: 'present',
        durableCheckpointCompleted: false,
      })
    }
    case 'apply-operation-committed-before-return': {
      const writerFenceDigest = previousReceipt?.writerFenceDigest
      if (writerFenceDigest === undefined) {
        throw new Error('Expected planning receipt before partial apply.')
      }
      const revision = selection.entry.ordinal * 10
      const durableRunStateDigest = digest(`durable-run:${scenario}`)
      return Object.freeze({
        observationVersion: 1,
        leaseIdentityDigest,
        kind: 'apply-operation',
        failpoint: plan.failpoint,
        durableAppliedOperationCount: plan.target.planSequence,
        sealedPlanOperationCount: 3,
        closedWriterFenceRecordDigest: writerFenceDigest,
        returnedStateRevision: revision,
        returnedRunStateDigest: durableRunStateDigest,
        returnedAppliedOperationCount: plan.target.planSequence,
        returnedSealedPlanOperationCount: 3,
        durableStateRevision: revision,
        durableStateStatus: 'applying',
        durableRunStateDigest,
      })
    }
    case 'lease-acquired-before-first-heartbeat':
      return Object.freeze({
        observationVersion: 1,
        leaseIdentityDigest,
        kind: 'lease',
        failpoint: plan.failpoint,
        durableAppliedOperationCount: 0,
        sealedPlanOperationCount: null,
        closedWriterFenceRecordDigest: null,
      })
  }
}

/** Wraps one exact fault material at its trusted parent observation time. */
function createPersistedFaultMaterialEvidence(
  kind:
    | 'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence'
    | 'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence',
  material: unknown,
  observedAt: string,
): unknown {
  return Object.freeze({
    kind,
    evidenceVersion: 1,
    material,
    materialDigest: createMigrationDigest(material),
    observedAt,
  })
}

/** Creates one complete authenticated stopped or response-loss protocol. */
async function createPersistedFaultFixture(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
): Promise<PersistedFaultFixture> {
  const entry = selection.entry
  const base = stageBase(entry.ordinal)
  const faultPlan = fixtureFaultPlan(entry.scenario)
  const faultReceipt = createFaultReceipt(faultPlan, at(base + 4))
  const context = createStageContext(selection, previousReceipt)
  const leaseAcquisitionObservation =
    createLeaseObservation(selection, previousReceipt)
  const leaseIdentityDigest = observedLeaseIdentityDigest(
    leaseAcquisitionObservation,
  )
  const committedRateSegment = await createCommittedRateSegment(
    selection,
    previousReceipt,
  )
  const boundaryRateSegmentBytes = committedRateSegment.canonicalBytes
  const boundaryMaterial =
    createWorkspaceSearchMigrationRehearsalStageFaultBoundaryMaterial({
      selection,
      faultPlan,
      faultReceipt,
      committedRateSegment,
      stageReservation: context.stageReservation,
      claimedStageHead: context.claimedStageHead,
      leaseAcquisitionObservation,
      faultObservation: createFaultObservation(
        selection,
        faultPlan,
        leaseIdentityDigest,
        previousReceipt,
      ),
      authenticationKey: mainKey,
    })
  const boundaryMaterialEvidence = createPersistedFaultMaterialEvidence(
    'mukuroji-workspace-search-migration-rehearsal-fault-boundary-material-evidence',
    boundaryMaterial,
    at(base + 5),
  )
  if (entry.expectedOutcome === 'response-loss-reconciled') {
    const completionMaterial =
      createWorkspaceSearchMigrationRehearsalStageFaultCompletionMaterial({
        selection,
        faultPlan,
        boundaryMaterial,
        boundaryRateSegmentBytes,
        observation: Object.freeze({
          result: createMutationResult(selection),
          serializedOutputLineDigest:
            digest(`stdout-line:${entry.ordinal}`),
        }),
        committedRateSegment,
        authenticationKey: mainKey,
      })
    const materialEvidence = createPersistedFaultMaterialEvidence(
      'mukuroji-workspace-search-migration-rehearsal-fault-completion-material-evidence',
      completionMaterial,
      at(base + 10),
    )
    const lifecycle = Object.freeze({
      lifecycleVersion: 1,
      manifestDigest: selection.manifestDigest,
      manifestEntryDigest: createMigrationDigest(entry),
      previousStageReceiptDigest: selection.previousStageReceiptDigest,
      stageOrdinal: entry.ordinal,
      scenario: entry.scenario,
      command: entry.command,
      attemptOrdinal: entry.attemptOrdinal,
      expectedOutcome: entry.expectedOutcome,
      faultPlanDigest: createMigrationDigest(faultPlan),
      faultReceiptDigest: boundaryMaterial.faultReceiptDigest,
      boundaryMaterialDigest: createMigrationDigest(boundaryMaterial),
      completionMaterialDigest: createMigrationDigest(completionMaterial),
      stdoutSha256: digest(`stdout:${entry.ordinal}`),
      materialStreamSha256: digest(`material-stream:${entry.ordinal}`),
      runnerStartedAt: at(base),
      boundaryMaterialObservedAt: at(base + 5),
      boundaryMaterialPersistedAt: at(base + 6),
      boundaryDecisionRecordedAt: at(base + 7),
      completionMaterialObservedAt: at(base + 10),
      completionMaterialPersistedAt: at(base + 11),
      completionDecisionRecordedAt: at(base + 12),
      processExitedAt: at(base + 13),
      exitClass: 'successful-response-loss',
    })
    const lifecycleEvidence = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
      lifecycle,
      lifecycleSha256: createMigrationDigest(lifecycle),
    })
    const runtimeAuthenticationKey = new Uint8Array(mainKey)
    const publicationAuthenticationKey = new Uint8Array(publicationKey)
    const runtimeKeyCleanupAuthorization =
      await createRuntimeKeyCleanupAuthorization(
        selection,
        completionMaterial.stageReservation,
      )
    const parentAuthentication =
      createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
        selection,
        materialKind: 'fault-completion',
        persistedMaterialEvidence: materialEvidence,
        persistedBoundaryMaterialEvidence: boundaryMaterialEvidence,
        faultPlan,
        boundaryRateSegmentBytes,
        finalRateSegmentBytes: committedRateSegment.canonicalBytes,
        persistedLifecycleEvidence: lifecycleEvidence,
        runtimeAuthenticationKey,
        publicationAuthenticationKey,
        runtimeKeyCleanupAuthorization,
      })
    if (
      !isZeroized(runtimeAuthenticationKey) ||
      !isZeroized(publicationAuthenticationKey)
    ) {
      throw new Error('Expected parent-authentication key zeroization.')
    }
    return Object.freeze({
      kind: 'fault-completion',
      material: completionMaterial,
      materialEvidence,
      boundaryMaterialEvidence,
      lifecycleEvidence,
      faultPlan,
      boundaryRateSegmentBytes,
      finalRateSegmentBytes: committedRateSegment.canonicalBytes,
      parentAuthentication,
    })
  }
  const lifecycle = Object.freeze({
    lifecycleVersion: 1,
    manifestDigest: selection.manifestDigest,
    manifestEntryDigest: createMigrationDigest(entry),
    previousStageReceiptDigest: selection.previousStageReceiptDigest,
    stageOrdinal: entry.ordinal,
    scenario: entry.scenario,
    command: entry.command,
    attemptOrdinal: entry.attemptOrdinal,
    expectedOutcome: entry.expectedOutcome,
    faultPlanDigest: createMigrationDigest(faultPlan),
    faultReceiptDigest: boundaryMaterial.faultReceiptDigest,
    boundaryMaterialDigest: createMigrationDigest(boundaryMaterial),
    completionMaterialDigest: null,
    stdoutSha256: digest(`stdout:${entry.ordinal}`),
    materialStreamSha256: digest(`material-stream:${entry.ordinal}`),
    runnerStartedAt: at(base),
    boundaryMaterialObservedAt: at(base + 5),
    boundaryMaterialPersistedAt: at(base + 6),
    boundaryDecisionRecordedAt: at(base + 7),
    completionMaterialObservedAt: null,
    completionMaterialPersistedAt: null,
    completionDecisionRecordedAt: null,
    processExitedAt: at(base + 12),
    exitClass: 'confirmed-sigkill',
  })
  const lifecycleEvidence = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-process-lifecycle-evidence',
    lifecycle,
    lifecycleSha256: createMigrationDigest(lifecycle),
  })
  const runtimeAuthenticationKey = new Uint8Array(mainKey)
  const publicationAuthenticationKey = new Uint8Array(publicationKey)
  const runtimeKeyCleanupAuthorization =
    await createRuntimeKeyCleanupAuthorization(
      selection,
      boundaryMaterial.stageReservation,
    )
  const parentAuthentication =
    createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
      selection,
      materialKind: 'fault-boundary',
      persistedMaterialEvidence: boundaryMaterialEvidence,
      faultPlan,
      boundaryRateSegmentBytes,
      persistedLifecycleEvidence: lifecycleEvidence,
      runtimeAuthenticationKey,
      publicationAuthenticationKey,
      runtimeKeyCleanupAuthorization,
    })
  if (
    !isZeroized(runtimeAuthenticationKey) ||
    !isZeroized(publicationAuthenticationKey)
  ) {
    throw new Error('Expected parent-authentication key zeroization.')
  }
  return Object.freeze({
    kind: 'fault-boundary',
    material: boundaryMaterial,
    materialEvidence: boundaryMaterialEvidence,
    lifecycleEvidence,
    faultPlan,
    boundaryRateSegmentBytes,
    parentAuthentication,
  })
}

/** One fresh branded rate successor plus its reusable raw successor bytes. */
type RateSuccessorFixture = {
  /** One-shot input consumed by an artifact finalizer. */
  readonly input:
    FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput
  /** Exact canonical bytes immediately preceding the successor. */
  readonly predecessorSegmentBytes: Uint8Array
  /** Exact canonical bytes that can precede a later linked segment. */
  readonly successorSegmentBytes: Uint8Array
  /** Canonical successor anchor used to derive live interval timestamps. */
  readonly successorAnchorUtc: string
}

/** Actual dual-key target artifact and its authenticated projection. */
type TargetAuditArtifactFixture = {
  /** Exact canonical dual-key-authenticated target artifact bytes. */
  readonly artifactBytes: Uint8Array
  /** Independently authenticated digest-only target binding. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding
  /** Exact target-rate successor bytes used by rollback reconciliation. */
  readonly rateSuccessorSegmentBytes: Uint8Array
}

/** Creates one exact target context shared by both rollback observations. */
function createTargetAuditContextFixture(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  planningReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
): WorkspaceSearchMigrationRehearsalTargetAuditContext {
  if (planningReceipt.evidence.kind !== 'planning-sealed') {
    throw new Error('Expected a planning receipt for target audit context.')
  }
  return Object.freeze({
    scenario: purpose.startsWith('partial-rollback-')
      ? 'partial-apply-rollback'
      : 'complete-apply-rollback',
    runLocatorDigest: planningReceipt.runLocatorDigest,
    manifestDigest: planningReceipt.manifestDigest,
    permitDigest: manifest.permitDigest,
    requestedResourcesBinding: manifest.requestedResourcesBinding,
    configurationBindingDigest: manifest.configurationBindingDigest,
    policyVersion: manifest.policyVersion,
    integrityResourceIdentityDigest:
      manifest.integrityResourceIdentityDigest,
    planningReceiptDigest: createMigrationDigest(planningReceipt),
    executionBoundaryDigest:
      planningReceipt.evidence.executionBoundaryDigest,
    sealedPlanningAuthorityDigest:
      planningReceipt.evidence.sealedPlanningAuthorityDigest,
    planDigest: planningReceipt.evidence.planDigest,
    writerFenceDigest: planningReceipt.writerFenceDigest,
  })
}

/** Creates one actual canonical target-audit artifact without AWS I/O. */
function createTargetAuditArtifactFixture(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  planningReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  observedAt: string,
  terminal: WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
): TargetAuditArtifactFixture {
  const context = createTargetAuditContextFixture(
    manifest,
    planningReceipt,
    purpose,
  )
  const aggregate = Object.freeze({
    scanned: 2,
    owned: 2,
    ignored: 0,
    keyDigest: digest('target-keys'),
    contentDigest: digest('target-content'),
    pageCount: 1,
  })
  const aggregateDigest = createMigrationDigest({
    scanned: aggregate.scanned,
    owned: aggregate.owned,
    ignored: aggregate.ignored,
    keyDigest: aggregate.keyDigest,
    contentDigest: aggregate.contentDigest,
  })
  const evidenceKeyDigest = createHash('sha256')
    .update(mainKey)
    .digest('hex')
  const sourceSessionBindingDigest = digest('target-source-session')
  const startedAt = observedAt
  const integrityCompletedAt = observedAt
  const integrityStartedAt = new Date(
    Date.parse(observedAt) - 1_000,
  ).toISOString()
  const observationFields = Object.freeze({
    startedAt,
    observedAt,
    commit: manifest.commit,
    configurationHash: manifest.configurationBindingDigest,
    evidenceKeyDigest,
    sourceSessionBindingDigest,
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
    aggregate: observationFields.aggregate,
    aggregateDigest: observationFields.aggregateDigest,
  })
  const rateFixture = createTargetRateFixture(
    context,
    manifest.policyVersion,
    `${purpose}:${observedAt}`,
    observedAt,
    purpose.startsWith('partial-rollback-')
      ? purpose.endsWith('-preimage') ? 100 : 102
      : purpose.endsWith('-preimage') ? 110 : 112,
  )
  const rate = finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
    rateFixture.input,
  )
  const integrityResultBase = createReconciliationIntegrityResult(
    `${context.scenario}:${purpose.endsWith('-preimage') ? 'before' : 'after'}`,
    integrityCompletedAt,
  )
  const integrityResult = Object.freeze({
    ...integrityResultBase,
    runtimeProvenance: Object.freeze({
      ...integrityResultBase.runtimeProvenance,
      startedAt: integrityStartedAt,
      completedAt: integrityCompletedAt,
    }),
  })
  const firstIntegrityEventSequence = rate.successor.firstEventSequence
  const integrityClaims = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result',
    version: 1,
    result: integrityResult,
    predecessor: rate.predecessor,
    segment: rate.successor,
    interval: Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
      version: 1,
      phase: 'integrity-check',
      tablePassCount: 2,
      describeTableCallCount: 12,
      firstAttemptSequence: 2,
      lastAttemptSequence: 13,
      attemptSequences: Object.freeze(
        Array.from({ length: 12 }, (_, index) => index + 2),
      ),
      firstEventSequence: firstIntegrityEventSequence,
      lastEventSequence: firstIntegrityEventSequence + 23,
      eventSequences: Object.freeze(
        Array.from(
          { length: 24 },
          (_, index) => firstIntegrityEventSequence + index,
        ),
      ),
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      startedAt: new Date(
        Date.parse(integrityStartedAt) + 10,
      ).toISOString(),
      completedAt: new Date(
        Date.parse(integrityStartedAt) + 120,
      ).toISOString(),
    }),
    policyVersion: manifest.policyVersion,
    configurationBindingDigest: manifest.configurationBindingDigest,
    tableOrderBindingMac: digest('target-integrity-table-order-binding'),
  })
  const integrity = Object.freeze({
    ...integrityClaims,
    bindingMac: createHmac('sha256', mainKey)
      .update(
        'mukuroji:workspace-search-migration:rate-bound-integrity-result:v1\0',
        'utf8',
      )
      .update(serializeCanonicalJson(integrityClaims), 'utf8')
      .digest('hex'),
  })
  const runtimeKeyFingerprint = createHmac('sha256', mainKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-key/v4\n',
      'utf8',
    )
    .digest('hex')
  const unsigned = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
    purpose,
    ...observationFields,
    integrity,
    context,
    terminal,
    observationDigest,
    rate,
    authentication: Object.freeze({
      algorithm: 'HMAC-SHA-256',
      runtimeKeyFingerprint,
    }),
  })
  const runtimeMac = createHmac('sha256', mainKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-mac/v4\n',
      'utf8',
    )
    .update(serializeCanonicalJson(unsigned), 'utf8')
    .digest('hex')
  const publicationKeyFingerprint = createHmac('sha256', publicationKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-key/v4\n',
      'utf8',
    )
    .digest('hex')
  const publicationUnsigned = Object.freeze({
    ...unsigned,
    authentication: {
      ...unsigned.authentication,
      runtimeMac,
      publicationKeyFingerprint,
    },
  })
  const publicationMac = createHmac('sha256', publicationKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-mac/v4\n',
      'utf8',
    )
    .update(serializeCanonicalJson(publicationUnsigned), 'utf8')
    .digest('hex')
  const artifactBytes = new TextEncoder().encode(serializeCanonicalJson({
    ...publicationUnsigned,
    authentication: {
      ...publicationUnsigned.authentication,
      publicationMac,
    },
  }))
  let binding: WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding
  if (purpose === 'partial-rollback-preimage' && terminal === null) {
    binding = authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
      artifactBytes,
      expectedContext: context,
      purpose,
      terminal,
    }, new Uint8Array(mainKey), new Uint8Array(publicationKey))
  } else if (purpose === 'complete-rollback-preimage' && terminal === null) {
    binding = authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
      artifactBytes,
      expectedContext: context,
      purpose,
      terminal,
    }, new Uint8Array(mainKey), new Uint8Array(publicationKey))
  } else if (
    purpose === 'partial-rollback-restored' &&
    terminal?.scenario === 'partial-apply-rollback'
  ) {
    binding = authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
      artifactBytes,
      expectedContext: context,
      purpose,
      terminal,
    }, new Uint8Array(mainKey), new Uint8Array(publicationKey))
  } else if (
    purpose === 'complete-rollback-restored' &&
    terminal?.scenario === 'complete-apply-rollback'
  ) {
    binding = authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact({
      artifactBytes,
      expectedContext: context,
      purpose,
      terminal,
    }, new Uint8Array(mainKey), new Uint8Array(publicationKey))
  } else {
    throw new Error('Expected purpose-compatible target terminal binding.')
  }
  return Object.freeze({
    artifactBytes,
    binding,
    rateSuccessorSegmentBytes: rateFixture.successorSegmentBytes,
  })
}

/** Creates only the raw target artifact expected by an apply proof. */
function createTargetAuditArtifact(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  planningReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  observedAt: string,
  terminal: WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
): Uint8Array {
  return createTargetAuditArtifactFixture(
    manifest,
    planningReceipt,
    purpose,
    observedAt,
    terminal,
  ).artifactBytes
}

/** Creates one canonical HMAC-authenticated empty rate-segment header. */
function createTargetRateHeaderBytes(
  payload: object,
  authenticationKey: Uint8Array,
): Uint8Array {
  const mac = createHmac('sha256', authenticationKey)
    .update(
      'mukuroji:workspace-search-migration:rehearsal-rate-record:v2',
      'utf8',
    )
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(payload), 'utf8')
    .digest('hex')
  return new TextEncoder().encode(
    `${serializeCanonicalJson({ ...payload, mac })}\n`,
  )
}

/** Reads the exact MAC from one canonical target-rate header record. */
function readTargetRateHeaderMac(bytes: Uint8Array): string {
  const terminalLine = new TextDecoder().decode(bytes).trimEnd()
    .split('\n').at(-1)
  if (terminalLine === undefined) {
    throw new Error('Missing target-rate terminal record.')
  }
  const value: unknown = JSON.parse(terminalLine)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid target-rate header fixture.')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'mac')
  if (descriptor === undefined || typeof descriptor.value !== 'string') {
    throw new Error('Missing target-rate header fixture MAC.')
  }
  return descriptor.value
}

/** Concatenates exact target-rate records without retaining aliases. */
function concatenateTargetRateRecords(
  records: readonly Uint8Array[],
): Uint8Array {
  const byteLength = records.reduce(
    (total, record) => total + record.byteLength,
    0,
  )
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const record of records) {
    bytes.set(record, offset)
    offset += record.byteLength
  }
  return bytes
}

/** Creates one immediate authenticated successor for exact predecessor bytes. */
function createRateSuccessorFixture(
  predecessorSegmentBytes: Uint8Array,
  predecessorOrdinal: number,
  firstEventSequence: number,
  configurationBindingDigest: string,
  policyVersion: string,
  label: string,
  anchorUtc: string,
  completedAt: string,
  includeIntegrityCalls = false,
): RateSuccessorFixture {
  const authenticationKey = new Uint8Array(mainKey)
  const authenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      authenticationKey,
    )
  const successorPayload = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 2,
    segmentLocatorDigest: digest(`target-rate-successor:${label}`),
    segmentOrdinal: predecessorOrdinal + 1,
    previousSegmentDigest: createHash('sha256')
      .update(predecessorSegmentBytes)
      .digest('hex'),
    previousRecordMac: readTargetRateHeaderMac(predecessorSegmentBytes),
    firstEventSequence,
    anchorUtc,
    authenticationKeyFingerprint,
    policyVersion,
    configurationBindingDigest,
  })
  const headerBytes = createTargetRateHeaderBytes(
    successorPayload,
    authenticationKey,
  )
  const records: Uint8Array[] = [headerBytes]
  let previousRecordMac = readTargetRateHeaderMac(headerBytes)
  let eventSequence = firstEventSequence
  if (includeIntegrityCalls) {
    for (let index = 0; index < 12; index += 1) {
      const attemptSequence = index + 2
      const offsetMilliseconds = (index + 1) * 10
      const charged = createTargetRateHeaderBytes(Object.freeze({
        kind: 'attempt-charged',
        version: 2,
        eventSequence,
        offsetMilliseconds,
        previousRecordMac,
        phase: 'integrity-check',
        attemptSequence,
      }), authenticationKey)
      records.push(charged)
      previousRecordMac = readTargetRateHeaderMac(charged)
      eventSequence += 1
      const started = createTargetRateHeaderBytes(Object.freeze({
        kind: 'attempt-started',
        version: 2,
        eventSequence,
        offsetMilliseconds,
        previousRecordMac,
        phase: 'integrity-check',
        attemptSequence,
        remainingNormalAdmissionAttempts: 90 - index,
        remainingWindowAttempts: 9,
        remainingPageAttempts: 5,
        inFlight: 1,
      }), authenticationKey)
      records.push(started)
      previousRecordMac = readTargetRateHeaderMac(started)
      eventSequence += 1
    }
  }
  const successorSegmentBytes = concatenateTargetRateRecords(records)
  const input = Object.freeze({
    verifiedSuccessor:
      verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
        predecessorSegmentBytes,
        successorSegmentBytes,
        authenticationKey,
        expectedPolicyVersion: policyVersion,
        expectedConfigurationBindingDigest: configurationBindingDigest,
      }),
    durableEvidence: Object.freeze({
      version:
        WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
      policyVersion,
      attemptCount: includeIntegrityCalls ? 13 : 1,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      awsServiceThrottleCount: 0,
      rehearsalInjectedThrottleCount: 0,
      budgetStopCount: 0,
      operationalBudgetStopCount: 0,
      awsServiceThrottleBudgetStopCount: 0,
      rehearsalInjectedBudgetStopCount: 0,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
      maximumInFlight: 1,
    }),
    completedAt,
  })
  authenticationKey.fill(0)
  return Object.freeze({
    input,
    predecessorSegmentBytes: new Uint8Array(predecessorSegmentBytes),
    successorSegmentBytes,
    successorAnchorUtc: anchorUtc,
  })
}

/** Creates the exact logical-to-physical table allowlist for live checks. */
function createIntegrityTableNames(): CrossDomainIntegrityTableNames {
  return {
    'audit-events': integrityResourceAttestation.tables[0]?.tableName ?? '',
    'file-proofing': integrityResourceAttestation.tables[1]?.tableName ?? '',
    'project-directory':
      integrityResourceAttestation.tables[2]?.tableName ?? '',
    'work-item-configuration':
      integrityResourceAttestation.tables[3]?.tableName ?? '',
    'work-items': integrityResourceAttestation.tables[4]?.tableName ?? '',
    'workspace-access':
      integrityResourceAttestation.tables[5]?.tableName ?? '',
  }
}

/** Creates one clean cumulative managed-rate aggregate. */
function createIntegrityRateEvidence(
  policyVersion: string,
  attemptCount: number,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion,
    attemptCount,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    awsServiceThrottleCount: 0,
    rehearsalInjectedThrottleCount: 0,
    budgetStopCount: 0,
    operationalBudgetStopCount: 0,
    awsServiceThrottleBudgetStopCount: 0,
    rehearsalInjectedBudgetStopCount: 0,
    cadenceWaitCount: 0,
    cadenceWaitMilliseconds: 0,
    maximumInFlight: 1,
  }
}

/** Creates a minimal managed rate owner aligned to one integrity segment. */
function createIntegrityManagedRate(
  policyVersion: string,
): WorkspaceSearchMigrationManagedDescribeTableRate {
  let attemptCount = 1
  return {
    /** Answers one exact attested DescribeTable call and charges one attempt. */
    async describeTable(
      tableName: string,
      _phase: WorkspaceSearchMigrationDescribeTablePhase,
    ): Promise<DescribeTableCommandOutput> {
      const table = integrityResourceAttestation.tables.find((candidate) =>
        candidate.tableName === tableName)
      if (table === undefined) throw new Error('Unknown integrity table.')
      attemptCount += 1
      return {
        $metadata: {},
        Table: {
          TableName: table.tableName,
          TableArn: table.tableArn,
          TableId: table.tableId,
          TableStatus: 'ACTIVE',
          CreationDateTime: new Date(table.creationTime),
        },
      }
    },
    /** Runs an unused checkpoint-page task. */
    async runCheckpointPage(_input, task) {
      return await task()
    },
    /** Runs an unused mandatory-cleanup task. */
    async runMandatoryCleanup(task) {
      return await task()
    },
    /** Runs the complete two-pass checker under one non-page gate. */
    async runNonPageOperation(task) {
      return await task()
    },
    /** Runs an unused mutation-guard task. */
    async runWithMutationAdmissionGuard(_guard, task) {
      return await task()
    },
    /** Accepts fixture data I/O. */
    assertNewDataIoAllowed(): void {},
    /** Accepts an unused lease claim. */
    async claimAfterLease(): Promise<void> {},
    /** Leaves the fixture active. */
    interrupt(): void {},
    /** Leaves the fixture active. */
    quarantine(): void {},
    /** Reads the exact current cumulative attempt count. */
    readEvidence: () => createIntegrityRateEvidence(
      policyVersion,
      attemptCount,
    ),
    /** Reads the exact final cumulative attempt count. */
    async closeAndReadEvidence() {
      return createIntegrityRateEvidence(policyVersion, attemptCount)
    },
    /** Leaves the fixture lifecycle unchanged. */
    async close(): Promise<void> {},
  }
}

/** Creates the unused transport retained behind the managed live adapter. */
function createUnusedIntegrityTransport(): CrossDomainIntegrityAwsTransport {
  return {
    /** No-op fixture close. */
    close(): void {},
    /** Rejects every forbidden base DescribeTable fallback. */
    async describeTable(): Promise<DescribeTableCommandOutput> {
      throw new Error('Forbidden integrity DescribeTable fallback.')
    },
    /** Returns enabled versioning for an unused bucket read. */
    async getBucketVersioning() {
      return { $metadata: {}, Status: 'Enabled' }
    },
    /** Returns an unused object-attributes result. */
    async getObjectAttributes() {
      return { $metadata: {} }
    },
    /** Returns an unused empty tag set. */
    async getObjectTagging() {
      return { $metadata: {}, TagSet: [] }
    },
    /** Returns unused empty object headers. */
    async headObject() {
      return { $metadata: {} }
    },
    /** Returns the fixed fixture account. */
    async readCallerIdentity() {
      return { $metadata: {}, Account: integrityResourceAttestation.account }
    },
    /** Returns an unused empty table page. */
    async scan() {
      return { $metadata: {}, Items: [] }
    },
  }
}

/** Creates one genuine two-pass result bound to the reconciliation segment. */
async function createGenuineVerifiedIntegrity(
  rate: RateSuccessorFixture,
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  resourceIdentities = fixtureIntegrityResourceIdentities('resource'),
): Promise<WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult> {
  const startedAt = rate.successorAnchorUtc
  const completedAt = new Date(
    Date.parse(startedAt) + 120,
  ).toISOString()
  const adapter = createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter({
    tableNames: createIntegrityTableNames(),
    tablePassCount: 2,
    baseTransport: createUnusedIntegrityTransport(),
    rate: createIntegrityManagedRate(manifest.policyVersion),
  })
  const signal = new AbortController().signal
  const result = await adapter.run(async () => {
    const tableNames = createIntegrityTableNames()
    for (let passIndex = 0; passIndex < 2; passIndex += 1) {
      for (const tableName of Object.values(tableNames)) {
        await adapter.describeTable(
          new DescribeTableCommand({ TableName: tableName }),
          signal,
        )
      }
    }
    return await runCrossDomainIntegrityCheck({
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      deadline: createCrossDomainIntegrityInvocationDeadline({
        maximumDurationMilliseconds: 60_000,
        monotonicClock: () => 1_000,
      }),
      role: 'source',
      checkedAt: completedAt,
      observationMode: 'migration-rehearsal-live',
      liveRuntimeObservation: { startedAt, completedAt },
      resourceIdentityScheme:
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
      digestKey: new Uint8Array(integrityKey),
      resourceBindingDigest:
        calculateCrossDomainIntegrityResourceBindingDigest(),
      resourceIdentities,
      resourceIdentityDigest:
        calculateCrossDomainIntegrityResourceIdentityDigest(
          resourceIdentities,
          integrityKey,
        ),
      limits: { pageSize: 100, maxPages: 10, maxItems: 1_000 },
      reader: {
        /** Returns one valid empty page for every logical domain. */
        async readPage() {
          return { items: [] }
        },
      },
    })
  })
  const sequence = adapter.takeCompletedSequence(result)
  const rateBinding =
    verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval({
      canonicalSegmentBytes: new Uint8Array(rate.successorSegmentBytes),
      authenticationKey: new Uint8Array(mainKey),
      predecessorSegmentBytes:
        new Uint8Array(rate.predecessorSegmentBytes),
      expectedPolicyVersion: manifest.policyVersion,
      expectedConfigurationBindingDigest:
        manifest.configurationBindingDigest,
      expectedStartedAt: startedAt,
      expectedCompletedAt: completedAt,
      sequence,
      taskResult: result,
    })
  return finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult({
    rateBinding,
    result,
    resourceAttestation: integrityResourceAttestation,
    integrityDigestKey: new Uint8Array(integrityKey),
    rateAuthenticationKey: new Uint8Array(mainKey),
    expectedResourceIdentityDigest:
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        integrityKey,
      ),
    clock: () => new Date(completedAt),
  })
}

/** Creates one standalone target-owned rate successor at an exact time. */
function createTargetRateFixture(
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  policyVersion: string,
  label: string,
  completedAt: string,
  predecessorOrdinal: number,
): RateSuccessorFixture {
  const authenticationKey = new Uint8Array(mainKey)
  const successorAnchorUtc = new Date(
    Date.parse(completedAt) - 1_000,
  ).toISOString()
  const predecessorAnchorUtc = new Date(
    Date.parse(completedAt) - 2_000,
  ).toISOString()
  const predecessorPayload = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 2,
    segmentLocatorDigest: digest(`target-rate-predecessor:${label}`),
    segmentOrdinal: predecessorOrdinal,
    previousSegmentDigest: digest(`target-rate-prior-segment:${label}`),
    previousRecordMac: digest(`target-rate-prior-mac:${label}`),
    firstEventSequence: 1,
    anchorUtc: predecessorAnchorUtc,
    authenticationKeyFingerprint:
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        authenticationKey,
      ),
    policyVersion,
    configurationBindingDigest: context.configurationBindingDigest,
  })
  const predecessorSegmentBytes = createTargetRateHeaderBytes(
    predecessorPayload,
    authenticationKey,
  )
  authenticationKey.fill(0)
  return createRateSuccessorFixture(
    predecessorSegmentBytes,
    predecessorOrdinal,
    1,
    context.configurationBindingDigest,
    policyVersion,
    label,
    successorAnchorUtc,
    completedAt,
    true,
  )
}

/** Creates one deterministic digest-only independently authenticated result. */
function createReconciliationIntegrityResult(
  label: string,
  checkedAt: string,
  resourceIdentities = fixtureIntegrityResourceIdentities('resource'),
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding {
  const scenario = label.replace(/:(?:after|before)$/u, '')
  const startedAt = new Date(Date.parse(checkedAt) - 1_000).toISOString()
  return Object.freeze({
    checkedAt,
    contentDigest: digest(`integrity-content:${label}`),
    byteLength: 1_024,
    resultDigest: digest(`integrity-result:${label}`),
    resultMac: digest(`integrity-mac:${label}`),
    runtimeProvenance: Object.freeze({
      kind:
        'mukuroji-cross-domain-integrity-rehearsal-live-provenance',
      version: 1,
      mode: 'migration-rehearsal-live',
      startedAt,
      completedAt: checkedAt,
      checkedAtSource: 'trusted-wall-clock-after-external-reads',
    }),
    resourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    resourceIdentities,
    integrityAggregateDigest: digest(`integrity-aggregate:${scenario}`),
    resourceIdentityDigest:
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        integrityKey,
      ),
  })
}

/** Creates scenario-specific collector-authenticated integrity material. */
function createReconciliationIntegrity(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  targetAudits:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null,
  verifiedIntegrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult | null,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult {
  const rollback = context.scenario === 'partial-apply-rollback' ||
    context.scenario === 'complete-apply-rollback'
  if (!rollback) {
    if (verifiedIntegrity === null || targetAudits !== null) {
      throw new Error('Expected verified live integrity authority.')
    }
    return Object.freeze({
      kind: 'verified-result',
      status: 'pass',
      failureCount: 0,
      completedAt: verifiedIntegrity.result.checkedAt,
      result: verifiedIntegrity.result,
      terminalRootDigest: context.terminalRootDigest,
      integrityAggregateDigest:
        verifiedIntegrity.result.integrityAggregateDigest,
    })
  }
  if (targetAudits === null || verifiedIntegrity !== null) {
    throw new Error('Expected rollback target integrity authority.')
  }
  const purpose = context.scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : 'complete-rollback'
  const terminal = targetAudits.restored.terminal
  if (terminal === null) throw new Error('Expected rollback terminal binding.')
  const before = targetAudits.preimage.integrity.result
  const after = targetAudits.restored.integrity.result
  const startedAt = before.runtimeProvenance.startedAt
  const applyStartedAt = terminal.applyStartedAt
  const terminalAt = terminal.terminalAt
  const completedAt = after.checkedAt
  const comparisonDigest = createMigrationDigest({
    purpose,
    beforeResultDigest: before.resultDigest,
    afterResultDigest: after.resultDigest,
    comparison: {
      kind:
        'mukuroji-cross-domain-integrity-migration-rehearsal-comparison',
      contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
      status: 'pass',
    },
  })
  return Object.freeze({
    kind: 'rollback-comparison',
    purpose,
    status: 'pass',
    failureCount: 0,
    startedAt,
    applyStartedAt,
    terminalAt,
    completedAt,
    before,
    after,
    comparisonDigest,
    comparisonContextDigest: createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-integrity-context/v3',
      version: 3,
      purpose,
      startedAt,
      applyStartedAt,
      terminalAt,
      completedAt,
      before,
      after,
      comparisonDigest,
    }),
    terminalRootDigest: context.terminalRootDigest,
    targetPreimageAggregateDigest: targetAudits.preimage.aggregateDigest,
    targetRestoredAggregateDigest: targetAudits.restored.aggregateDigest,
    targetPreimageStatus: 'equal',
  })
}

/** Projects one actual authenticated target binding into reconciliation. */
function createReconciliationTargetSummary(
  binding: WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding,
): WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair['preimage'] {
  return Object.freeze({
    purpose: binding.purpose,
    contentDigest: binding.contentDigest,
    byteLength: binding.byteLength,
    startedAt: binding.startedAt,
    observedAt: binding.observedAt,
    observationDigest: binding.observationDigest,
    aggregateDigest: binding.aggregateDigest,
    context: binding.context,
    terminal: binding.terminal,
    integrity: binding.integrity,
    contextDigest: createMigrationDigest(binding.context),
    rate: binding.rate,
  })
}

/**
 * Creates one actual reconciliation artifact for a selected terminal child.
 *
 * @param selection - Selected terminal stage owning the artifact.
 * @param previousReceipt - Immediate apply or partial-fault predecessor.
 * @param planningReceipt - Authenticated planning receipt for the scenario.
 * @param applyBoundaryDigest - Optional artifact boundary used by negatives.
 * @returns Raw authenticated reconciliation artifact bytes.
 */
async function createTerminalReconciliationArtifact(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  planningReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  applyBoundaryDigest?: string,
  resourceIdentities = fixtureIntegrityResourceIdentities('resource'),
): Promise<Uint8Array> {
  const entry = selection.entry
  const coordinator = createMutationResult(
    selection,
    previousReceipt,
  ).coordinator
  if (
    (coordinator.mode !== 'verify' &&
      coordinator.mode !== 'rollback-complete' &&
      coordinator.mode !== 'rollback-partial') ||
    previousReceipt === null
  ) {
    throw new Error('Expected a selected terminal child fixture.')
  }
  const terminal = coordinator.terminal
  if (terminal === undefined) {
    throw new Error('Expected terminal coordinator evidence.')
  }
  const checkedAt = at(stageBase(entry.ordinal) + 15)
  const context = Object.freeze({
    scenario: entry.scenario,
    runLocatorDigest: planningReceipt.runLocatorDigest,
    configurationBindingDigest:
      selection.manifest.configurationBindingDigest,
    policyVersion: selection.manifest.policyVersion,
    integrityResourceIdentityDigest:
      selection.manifest.integrityResourceIdentityDigest,
    sealedPlanningAuthorityDigest:
      terminal.sealedPlanningAuthorityDigest,
    executionRunDigest: terminal.executionRunDigest,
    planDigest: terminal.planDigest,
    applyBoundaryDigest:
      applyBoundaryDigest ?? terminal.applyBoundaryDigest,
    terminalRootKind: terminal.terminalKind,
    terminalRootVersion: terminal.terminalPersistenceVersion,
    terminalRootDigest: terminal.terminalRootDigest,
    sealedPlanOperationCount: terminal.planOperationCount,
    appliedOperationCount: terminal.appliedOperationCount,
    terminalAt: terminal.terminalAt,
    checkedAt,
  }) satisfies WorkspaceSearchMigrationRehearsalReconciliationCoreContext
  const rollback = coordinator.mode !== 'verify'
  let targetAudits:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null =
      null
  let ratePredecessorBytes: Uint8Array
  let ratePredecessorOrdinal: number
  let rateFirstEventSequence: number
  let sourceTargetAggregateDigest: string
  if (rollback) {
    const partial = coordinator.mode === 'rollback-partial'
    const purposePrefix = partial
      ? 'partial-rollback'
      : 'complete-rollback'
    const terminalBinding:
      WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding = partial
        ? Object.freeze({
            scenario: 'partial-apply-rollback',
            kind: 'rolled-back',
            version: 2,
            rootDigest: terminal.terminalRootDigest,
            applyStartedAt: previousReceipt.startedAt,
            terminalAt: terminal.terminalAt,
          })
        : Object.freeze({
            scenario: 'complete-apply-rollback',
            kind: 'rolled-back',
            version: 1,
            rootDigest: terminal.terminalRootDigest,
            applyStartedAt: previousReceipt.startedAt,
            terminalAt: terminal.terminalAt,
          })
    const preimage = createTargetAuditArtifactFixture(
      selection.manifest,
      planningReceipt,
      `${purposePrefix}-preimage`,
      at(stageBase(planningReceipt.stageOrdinal) + 15),
      null,
    )
    const restored = createTargetAuditArtifactFixture(
      selection.manifest,
      planningReceipt,
      `${purposePrefix}-restored`,
      at(stageBase(entry.ordinal) + 13),
      terminalBinding,
    )
    targetAudits = Object.freeze({
      preimage: createReconciliationTargetSummary(preimage.binding),
      restored: createReconciliationTargetSummary(restored.binding),
    })
    sourceTargetAggregateDigest = preimage.binding.aggregateDigest
    ratePredecessorBytes = restored.rateSuccessorSegmentBytes
    ratePredecessorOrdinal = partial ? 103 : 113
    rateFirstEventSequence =
      restored.binding.rate.successor.firstEventSequence +
      restored.binding.rate.successor.eventCount
  } else {
    const committedRate = await createCommittedRateSegment(
      selection,
      previousReceipt,
    )
    sourceTargetAggregateDigest =
      digest(`source-target-aggregate:${entry.scenario}`)
    ratePredecessorBytes = committedRate.canonicalBytes
    ratePredecessorOrdinal = committedRate.segmentOrdinal
    rateFirstEventSequence = committedRate.firstEventSequence +
      committedRate.eventCount
  }
  const rate = createRateSuccessorFixture(
    ratePredecessorBytes,
    ratePredecessorOrdinal,
    rateFirstEventSequence,
    selection.manifest.configurationBindingDigest,
    selection.manifest.policyVersion,
    `reconciliation:${entry.scenario}:${entry.ordinal}`,
    at(stageBase(entry.ordinal) + (rollback ? 16 : 14)),
    at(stageBase(entry.ordinal) + (rollback ? 16 : 15)),
    !rollback,
  )
  const verifiedIntegrity = rollback
    ? null
    : await createGenuineVerifiedIntegrity(
        rate,
        selection.manifest,
        resourceIdentities,
      )
  const markerAggregateDigest =
    digest(`marker-aggregate:${entry.scenario}`)
  const authorityChainDigest =
    digest(`authority-chain:${entry.scenario}`)
  const collectorResult = Object.freeze({
    context,
    integrity: createReconciliationIntegrity(
      context,
      targetAudits,
      verifiedIntegrity,
    ),
    targetAudits,
    markerSummary: Object.freeze({
      expectedCount: context.appliedOperationCount,
      expectedAggregateDigest: markerAggregateDigest,
      observedCount: context.appliedOperationCount,
      observedAggregateDigest: markerAggregateDigest,
      matchedCount: context.appliedOperationCount,
      duplicateCount: 0,
      missingCount: 0,
      unexpectedCount: 0,
    }),
    authoritySummary: Object.freeze({
      expectedChainDigest: authorityChainDigest,
      observedChainDigest: authorityChainDigest,
      expectedCount: 1,
      observedCount: 1,
      matchedCount: 1,
      missingCount: 0,
      orphanCount: 0,
    }),
    sourceTargetSummary: Object.freeze({
      expectedAggregateDigest: sourceTargetAggregateDigest,
      observedAggregateDigest: sourceTargetAggregateDigest,
      expectedCount: context.appliedOperationCount,
      observedCount: context.appliedOperationCount,
      matchedCount: context.appliedOperationCount,
      lostCount: 0,
      unexpectedCount: 0,
    }),
  }) satisfies WorkspaceSearchMigrationRehearsalReconciliationCollectorResult
  const finalized =
    finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact({
      collectorResult,
      rate: rate.input,
      verifiedIntegrity,
    }, new Uint8Array(mainKey), new Uint8Array(publicationKey))
  return new Uint8Array(finalized.canonicalBytes)
}

/** Finds the unique successful planning receipt for one scenario. */
function requireScenarioPlanningReceipt(
  receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[],
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const receipt = receipts.find(
    (candidate) =>
      candidate.scenario === scenario &&
      candidate.evidence.kind === 'planning-sealed',
  )
  if (receipt === undefined) {
    throw new Error('Expected a finalized planning receipt.')
  }
  return receipt
}

/** Finds one exact manifest entry by scenario and command. */
function requireScenarioEntry(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  command: WorkspaceSearchMigrationRehearsalStageCommand,
): WorkspaceSearchMigrationRehearsalStageManifestEntry {
  const entry = manifest.entries.find(
    (candidate) =>
      candidate.scenario === scenario && candidate.command === command,
  )
  if (entry === undefined) throw new Error('Expected manifest entry.')
  return entry
}

/** Creates the common pre-apply target audit for one rollback scenario. */
function createScenarioPreimageArtifact(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  scenario: 'complete-apply-rollback' | 'partial-apply-rollback',
  planningReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
): Uint8Array {
  const planning = requireScenarioEntry(manifest, scenario, 'close-replan')
  return createTargetAuditArtifact(
    manifest,
    planningReceipt,
    scenario === 'partial-apply-rollback'
      ? 'partial-rollback-preimage'
      : 'complete-rollback-preimage',
    at(stageBase(planning.ordinal) + 15),
    null,
  )
}

/** Creates the exact proof profile for one stage in the complete chain. */
async function createCompleteManifestProof(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[],
): Promise<StageProofFixture> {
  const entry = selection.entry
  if (entry.command === 'close-replan') {
    return Object.freeze({
      proof: Object.freeze({ kind: 'planning' }),
      ownedEvidenceKeys: Object.freeze([]),
    })
  }
  if (entry.command === 'apply') {
    const partial = entry.scenario === 'partial-apply-rollback'
    const complete = entry.scenario === 'complete-apply-rollback'
    const rollbackPlanningReceipt = partial || complete
      ? requireScenarioPlanningReceipt(receipts, entry.scenario)
      : null
    const targetPreimageAudit = partial || complete
      ? Object.freeze({
          artifactBytes: createScenarioPreimageArtifact(
            selection.manifest,
            partial ? 'partial-apply-rollback' : 'complete-apply-rollback',
            rollbackPlanningReceipt ??
              (() => {
                throw new Error('Expected rollback planning receipt.')
              })(),
          ),
          verificationKey: new Uint8Array(targetAuditKey),
        })
      : null
    const planningReceipt = entry.expectedOutcome === 'takeover-completed'
      ? requireScenarioPlanningReceipt(receipts, entry.scenario)
      : null
    return Object.freeze({
      proof: Object.freeze({
        kind: 'apply',
        planningReceipt,
        targetPreimageAudit,
      }),
      ownedEvidenceKeys: targetPreimageAudit === null
        ? Object.freeze([])
        : Object.freeze([targetPreimageAudit.verificationKey]),
    })
  }
  if (
    entry.command === 'verify' ||
    entry.command === 'rollback-partial' ||
    entry.command === 'rollback-complete'
  ) {
    const planningReceipt = requireScenarioPlanningReceipt(
      receipts,
      entry.scenario,
    )
    return Object.freeze({
      proof: Object.freeze({
        kind: 'terminal',
        planningReceipt,
        reconciliationArtifactBytes:
          await createTerminalReconciliationArtifact(
            selection,
            previousReceipt,
            planningReceipt,
          ),
      }),
      ownedEvidenceKeys: Object.freeze([]),
    })
  }
  if (previousReceipt?.evidence.kind !== 'terminal') {
    throw new Error('Expected terminal receipt before release.')
  }
  return Object.freeze({
    proof: Object.freeze({ kind: 'release' }),
    ownedEvidenceKeys: Object.freeze([]),
  })
}

/** Creates a valid stage-32 predecessor sufficient for fresh reselection. */
function createCompleteRollbackPredecessor(
  fixture: ManifestFixture,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const entry = fixture.manifest.entries[31]
  if (entry === undefined || entry.command !== 'release') {
    throw new Error('Expected the stage-32 release fixture.')
  }
  return createWorkspaceSearchMigrationRehearsalStageReceipt({
    claims: {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
      receiptVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
      stage: 'non-production',
      scenario: entry.scenario,
      stageOrdinal: entry.ordinal,
      scenarioStageOrdinal: entry.scenarioStageOrdinal,
      command: entry.command,
      controlArgumentsDigest: entry.controlArgumentsDigest,
      serializedOutputLineDigest: digest('stage-32-output'),
      manifestDigest: createMigrationDigest(fixture.manifest),
      manifestEntryDigest: createMigrationDigest(entry),
      permitDigest: fixture.manifest.permitDigest,
      commit: fixture.manifest.commit,
      requestedResourcesBinding:
        fixture.manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        fixture.manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities:
        fixture.manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        fixture.manifest.integrityResourceIdentityDigest,
      configurationBindingDigest:
        fixture.manifest.configurationBindingDigest,
      policyVersion: fixture.manifest.policyVersion,
      runLocatorDigest: digest('stage-32-run'),
      attemptOrdinal: entry.attemptOrdinal,
      attemptLocatorDigest: digest('stage-32-attempt'),
      ownerLocatorDigest: digest('stage-32-owner'),
      leaseIdentityDigest: digest('lease:partial-apply-rollback'),
      leaseObservation: {
        kind: 'reused-active',
        currentLeaseIdentityDigest: digest('lease:partial-apply-rollback'),
        evaluatedAt: at(stageBase(entry.ordinal) - 1),
        currentLeaseExpiresAt: at(stageBase(entry.ordinal) + 3_599),
      },
      expectedAuthorities: Object.freeze([]),
      writerFenceDigest: digest('stage-32-released-fence'),
      previousStageReceiptDigest: digest('stage-31-receipt'),
      stageReservationDigest: digest('stage-32-reservation'),
      stageReservationClaimRevision: entry.ordinal * 2 - 1,
      stageReservationCommitRevision: entry.ordinal * 2,
      stageReservationAbandonmentCount: 0,
      stageReservationAbandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      startedAt: at(stageBase(entry.ordinal)),
      completedAt: at(stageBase(entry.ordinal) + 5),
      processLifecycle: {
        lifecycleDigest: digest('stage-32-lifecycle'),
        runnerStartedAt: at(stageBase(entry.ordinal)),
        receiptObservedAt: at(stageBase(entry.ordinal) + 6),
        receiptPersistedAt: at(stageBase(entry.ordinal) + 7),
        parentDecisionRecordedAt: null,
        processExitedAt: at(stageBase(entry.ordinal) + 8),
        exitClass: 'successful-no-fault',
      },
      outcome: 'completed',
      faultReceiptDigest: null,
      faultBoundary: null,
      predecessorLeaseExpiresAt: null,
      takeoverAcquiredAt: null,
      reconciledAt: null,
      evidence: {
        kind: 'released',
        terminalKind: 'rolled-back',
        terminalPersistenceVersion: 2,
        terminalRootDigest: digest('stage-32-terminal'),
        releasedWriterFenceRecordDigest: digest('stage-32-released-fence'),
        releasedAt: at(stageBase(entry.ordinal) + 4),
      },
      rateSegment: {
        authenticationKeyFingerprint:
          createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
            mainKey,
          ),
        segmentLocatorDigest: digest('stage-32-segment-locator'),
        segmentOrdinal: entry.ordinal - 1,
        firstEventSequence: entry.ordinal,
        eventCount: 1,
        firstCommittedEventSequence: entry.ordinal,
        lastCommittedEventSequence: entry.ordinal,
        terminalRecordMac: digest('stage-32-segment-mac'),
        segmentDigest: digest('stage-32-segment'),
      },
    },
    signingKey: mainKey,
  })
}

/** Finalizes one supported fixture stage with a fresh owned main key. */
function finalizeFixtureStage(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  persisted: PersistedSuccessFixture,
  proof: WorkspaceSearchMigrationRehearsalStageFinalizationProof,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const ownedMainKey = new Uint8Array(mainKey)
  const receipt = finalizeWorkspaceSearchMigrationRehearsalStageReceipt({
    selection,
    previousReceipt,
    controlArguments: controlArguments(
      selection.entry.scenario,
      selection.entry.scenarioStageOrdinal,
      selection.entry.command,
      selection.entry.attemptOrdinal,
    ),
    materialKind: 'success',
    persistedMaterialEvidence: persisted.materialEvidence,
    persistedLifecycleEvidence: persisted.lifecycleEvidence,
    parentAuthentication: persisted.parentAuthentication,
    proof,
    runtimeAuthenticationKey: ownedMainKey,
    publicationAuthenticationKey: new Uint8Array(publicationKey),
  })
  expect(isZeroized(ownedMainKey)).toBe(true)
  expect(
    verifyWorkspaceSearchMigrationRehearsalStageReceipt(receipt, mainKey),
  ).toEqual(receipt)
  return receipt
}

/** Finalizes one authenticated finite fault-material protocol. */
function finalizeFaultFixtureStage(
  selection: WorkspaceSearchMigrationRehearsalSupportedSelectedStage,
  previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt | null,
  persisted: PersistedFaultFixture,
  proof: WorkspaceSearchMigrationRehearsalStageFinalizationProof,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const ownedMainKey = new Uint8Array(mainKey)
  const common = {
    selection,
    previousReceipt,
    controlArguments: controlArguments(
      selection.entry.scenario,
      selection.entry.scenarioStageOrdinal,
      selection.entry.command,
      selection.entry.attemptOrdinal,
    ),
    persistedLifecycleEvidence: persisted.lifecycleEvidence,
    parentAuthentication: persisted.parentAuthentication,
    proof,
    runtimeAuthenticationKey: ownedMainKey,
    publicationAuthenticationKey: new Uint8Array(publicationKey),
  }
  const receipt = persisted.kind === 'fault-boundary'
    ? finalizeWorkspaceSearchMigrationRehearsalStageReceipt({
        ...common,
        materialKind: persisted.kind,
        persistedMaterialEvidence: persisted.materialEvidence,
        faultPlan: persisted.faultPlan,
        boundaryRateSegmentBytes: persisted.boundaryRateSegmentBytes,
      })
    : finalizeWorkspaceSearchMigrationRehearsalStageReceipt({
        ...common,
        materialKind: persisted.kind,
        persistedMaterialEvidence: persisted.materialEvidence,
        persistedBoundaryMaterialEvidence:
          persisted.boundaryMaterialEvidence,
        faultPlan: persisted.faultPlan,
        boundaryRateSegmentBytes: persisted.boundaryRateSegmentBytes,
        finalRateSegmentBytes: persisted.finalRateSegmentBytes,
      })
  expect(isZeroized(ownedMainKey)).toBe(true)
  expect(
    verifyWorkspaceSearchMigrationRehearsalStageReceipt(receipt, mainKey),
  ).toEqual(receipt)
  return receipt
}

/** Invokes the typed finalizer with a deliberately unknown boundary value. */
function finalizeUnknown(value: unknown): unknown {
  return Reflect.apply(
    finalizeWorkspaceSearchMigrationRehearsalStageReceipt,
    undefined,
    [value],
  )
}

/** Recomputes the wrapper digest after altering one persisted lifecycle field. */
function tamperPersistedLifecycleEvidence(value: unknown): unknown {
  const cloned: unknown = structuredClone(value)
  if (typeof cloned !== 'object' || cloned === null) {
    throw new Error('Expected an object lifecycle evidence wrapper.')
  }
  const lifecycle: unknown = Reflect.get(cloned, 'lifecycle')
  if (typeof lifecycle !== 'object' || lifecycle === null) {
    throw new Error('Expected an object persisted lifecycle.')
  }
  if (!Reflect.set(lifecycle, 'processExitedAt', at(13))) {
    throw new Error('Failed to alter the persisted lifecycle.')
  }
  if (
    !Reflect.set(
      cloned,
      'lifecycleSha256',
      createMigrationDigest(lifecycle),
    )
  ) {
    throw new Error('Failed to recompute the persisted lifecycle digest.')
  }
  return Object.freeze(cloned)
}

/** Rewrites one successful runner start and preserves wrapper self-digests. */
function rewritePersistedLifecycleRunnerStartedAt(
  value: unknown,
  runnerStartedAt: string,
): unknown {
  const cloned: unknown = structuredClone(value)
  if (typeof cloned !== 'object' || cloned === null) {
    throw new Error('Expected an object lifecycle evidence wrapper.')
  }
  const lifecycle: unknown = Reflect.get(cloned, 'lifecycle')
  if (typeof lifecycle !== 'object' || lifecycle === null) {
    throw new Error('Expected an object persisted lifecycle.')
  }
  if (!Reflect.set(lifecycle, 'runnerStartedAt', runnerStartedAt)) {
    throw new Error('Failed to alter the persisted runner start.')
  }
  if (
    !Reflect.set(
      cloned,
      'lifecycleSha256',
      createMigrationDigest(lifecycle),
    )
  ) {
    throw new Error('Failed to recompute the persisted lifecycle digest.')
  }
  return Object.freeze(cloned)
}

/** Alters one nested fault-observation field without regenerating its MAC. */
function tamperPersistedFaultObservation(
  value: unknown,
  field: string,
  replacement: unknown,
): unknown {
  const cloned: unknown = structuredClone(value)
  if (typeof cloned !== 'object' || cloned === null) {
    throw new Error('Expected a persisted fault wrapper.')
  }
  const material: unknown = Reflect.get(cloned, 'material')
  if (typeof material !== 'object' || material === null) {
    throw new Error('Expected nested fault material.')
  }
  const observation: unknown = Reflect.get(material, 'faultObservation')
  if (typeof observation !== 'object' || observation === null) {
    throw new Error('Expected nested fault observation.')
  }
  if (!Reflect.set(observation, field, replacement)) {
    throw new Error('Failed to alter the persisted fault observation.')
  }
  return Object.freeze(cloned)
}

describe('Workspace Search migration rehearsal stage finalizer', () => {
  test('brands exact runtime-verified parent-only publication authorization', async () => {
    const fixture = createManifestFixture()
    const firstEntry = fixture.manifest.entries[0]
    if (firstEntry === undefined) throw new Error('Missing first fixture stage.')
    const selection = selectCompleteManifestStage(
      fixture.manifest,
      null,
      firstEntry,
    )
    const persisted = await createPersistedSuccessFixture(selection, null)
    const runtimeAuthenticationKey = new Uint8Array(mainKey)
    const publicationAuthenticationKey = new Uint8Array(publicationKey)
    const authorization =
      authenticateWorkspaceSearchMigrationRehearsalStageParentAuthorization({
        selection,
        materialKind: 'success',
        persistedMaterialEvidence: persisted.materialEvidence,
        persistedLifecycleEvidence: persisted.lifecycleEvidence,
        parentAuthentication: persisted.parentAuthentication,
        runtimeAuthenticationKey,
        publicationAuthenticationKey,
      })
    const binding =
      readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding(
        authorization,
      )

    expect(isZeroized(runtimeAuthenticationKey)).toBe(true)
    expect(isZeroized(publicationAuthenticationKey)).toBe(true)
    expect(authorization.bindingDigest).toBe(createMigrationDigest(binding))
    expect(binding).toMatchObject({
      parentAuthenticationDigest:
        createMigrationDigest(persisted.parentAuthentication),
      publicationKeyDigest: fixture.manifest.publicationKeyDigest,
      manifestDigest: selection.manifestDigest,
      manifestEntryDigest: createMigrationDigest(selection.entry),
      previousStageReceiptDigest: null,
      stageOrdinal: 1,
      materialDigest: createMigrationDigest(persisted.material),
      stageReservationDigest:
        createMigrationDigest(persisted.material.stageReservation),
      claimedStageHeadDigest:
        createMigrationDigest(persisted.material.claimedStageHead),
    })
    expect(() =>
      readWorkspaceSearchMigrationRehearsalStageParentAuthorizationBinding(
        Object.freeze({ ...authorization }),
      )
    ).toThrow('INVALID_REHEARSAL_STAGE_PARENT_AUTHORIZATION')

    const rejectedRuntimeKey = new Uint8Array(mainKey)
    const rejectedPublicationKey = new Uint8Array(32).fill(0x99)
    expect(() =>
      authenticateWorkspaceSearchMigrationRehearsalStageParentAuthorization({
        selection,
        materialKind: 'success',
        persistedMaterialEvidence: persisted.materialEvidence,
        persistedLifecycleEvidence: persisted.lifecycleEvidence,
        parentAuthentication: persisted.parentAuthentication,
        runtimeAuthenticationKey: rejectedRuntimeKey,
        publicationAuthenticationKey: rejectedPublicationKey,
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
    expect(isZeroized(rejectedRuntimeKey)).toBe(true)
    expect(isZeroized(rejectedPublicationKey)).toBe(true)
  })

  test('re-presents a stage claim only from its genuine collection brand', async () => {
    const fixture = createManifestFixture()
    const previous = createCompleteRollbackPredecessor(fixture)
    const entry = fixture.manifest.entries[32]
    if (
      entry === undefined ||
      entry.scenario !== 'complete-apply-rollback' ||
      entry.command !== 'close-replan'
    ) throw new Error('Expected complete rollback planning stage.')
    const selection = selectSupportedStage(
      fixture.manifest,
      previous,
      entry,
    )
    const persisted = await createPersistedSuccessFixture(
      selection,
      previous,
    )
    const runtimeVerificationKey = new Uint8Array(mainKey)
    const publicationVerificationKey = new Uint8Array(publicationKey)
    const authenticated =
      authenticateWorkspaceSearchMigrationRehearsalCollectionContext({
        mode: 'target-preimage',
        material: {
          manifestBytes: encodeCollectionDocument(fixture.manifest),
          previousReceiptBytes: encodeCollectionDocument(previous),
          materialBytes: encodeCollectionDocument(persisted.materialEvidence),
          lifecycleBytes: encodeCollectionDocument(
            persisted.lifecycleEvidence,
          ),
          parentAuthenticationBytes: encodeCollectionDocument(
            persisted.parentAuthentication,
          ),
          controlArgumentsBytes: encodeCollectionDocument(
            controlArguments(
              entry.scenario,
              entry.scenarioStageOrdinal,
              entry.command,
              entry.attemptOrdinal,
            ),
          ),
        },
        runtimeVerificationKey,
        publicationVerificationKey,
      })
    const claim =
      readWorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim(
        authenticated,
      )
    const snapshot =
      snapshotWorkspaceSearchMigrationRehearsalAuthenticatedCollectionContext(
        authenticated,
      )

    expect(isZeroized(runtimeVerificationKey)).toBe(true)
    expect(isZeroized(publicationVerificationKey)).toBe(true)
    expect(Object.isFrozen(claim)).toBe(true)
    expect(createMigrationDigest(claim.reservation)).toBe(
      createMigrationDigest(persisted.material.stageReservation),
    )
    expect(claim.selection.manifestDigest).toBe(selection.manifestDigest)
    expect(createMigrationDigest(claim.selection.entry)).toBe(
      createMigrationDigest(selection.entry),
    )
    expect(() =>
      readWorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim(
        Object.freeze({ ...authenticated }),
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
    expect(() =>
      readWorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim(
        snapshot,
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
    expect(() =>
      readWorkspaceSearchMigrationRehearsalAuthenticatedCollectionStageClaim(
        new Proxy(authenticated, {}),
      )
    ).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
  })

  test('finalizes and derives the exact complete 36-stage chain', async () => {
    const fixture = createManifestFixture()
    const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
    let previous: WorkspaceSearchMigrationRehearsalStageReceipt | null = null
    expect(fixture.manifest.entries).toHaveLength(36)
    for (const entry of fixture.manifest.entries) {
      const selection = selectCompleteManifestStage(
        fixture.manifest,
        previous,
        entry,
      )
      const proofFixture = await createCompleteManifestProof(
        selection,
        previous,
        receipts,
      )
      let receipt: WorkspaceSearchMigrationRehearsalStageReceipt
      try {
        receipt = entry.faultPlanDigest === null
          ? finalizeFixtureStage(
              selection,
              previous,
              await createPersistedSuccessFixture(selection, previous),
              proofFixture.proof,
            )
          : finalizeFaultFixtureStage(
              selection,
              previous,
              await createPersistedFaultFixture(selection, previous),
              proofFixture.proof,
            )
      } catch {
        throw new Error(
          `Failed complete-chain fixture stage ${entry.ordinal} (${entry.scenario}/${entry.command}).`,
        )
      }
      expect(proofFixture.ownedEvidenceKeys.every(isZeroized)).toBe(true)
      receipts.push(receipt)
      previous = receipt
    }
    const capability =
      deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
        manifest: fixture.manifest,
        receipts,
        verificationKey: mainKey,
      })
    const chain =
      consumeWorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence(
        capability,
      )
    expect(receipts).toHaveLength(36)
    expect(chain.receiptCount).toBe(36)
    expect(chain.scenarios).toHaveLength(8)
    expect(chain.scenarios.map((scenario) => scenario.name)).toEqual(
      [...WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS],
    )
    const faultReceipts = receipts.filter(
      (receipt) => receipt.faultBoundary !== null,
    )
    expect(faultReceipts).toHaveLength(6)
    for (const receipt of faultReceipts) {
      const faultBoundary = receipt.faultBoundary
      if (faultBoundary === null) {
        throw new Error('Expected projected fault boundary.')
      }
      expect(faultBoundary.faultObservationDigest).toBe(
        createMigrationDigest(faultBoundary.faultObservation),
      )
      if (receipt.evidence.kind === 'fault-boundary') {
        expect(receipt.evidence.faultObservation).toEqual(
          faultBoundary.faultObservation,
        )
        expect(receipt.evidence.faultObservationDigest).toBe(
          faultBoundary.faultObservationDigest,
        )
      }
      const scenario = chain.scenarios.find(
        (candidate) => candidate.name === receipt.scenario,
      )
      if (scenario === undefined) {
        throw new Error('Expected finalized fault scenario projection.')
      }
      expect(scenario.faultObservation).toEqual(
        faultBoundary.faultObservation,
      )
      expect(scenario.faultObservationDigest).toBe(
        faultBoundary.faultObservationDigest,
      )
    }
    const auditedScenarios:
      readonly WorkspaceSearchMigrationRehearsalScenarioName[] =
        Object.freeze([
          'happy-path-verified',
          'partial-apply-rollback',
          'complete-apply-rollback',
        ])
    for (const scenario of auditedScenarios) {
      const planning = requireScenarioPlanningReceipt(receipts, scenario)
      const applyBoundary = receipts.find(
        (receipt) =>
          receipt.scenario === scenario && receipt.command === 'apply',
      )
      const terminal = receipts.find(
        (receipt) =>
          receipt.scenario === scenario &&
          (receipt.command === 'verify' ||
            receipt.command === 'rollback-partial' ||
            receipt.command === 'rollback-complete'),
      )
      if (applyBoundary === undefined || terminal === undefined) {
        throw new Error('Expected audited scenario boundaries.')
      }
      const beforeCheckedAt = at(stageBase(planning.stageOrdinal) + 15)
      const afterCheckedAt = at(stageBase(terminal.stageOrdinal) + 14)
      expect(Date.parse(beforeCheckedAt)).toBeLessThan(
        Date.parse(applyBoundary.startedAt),
      )
      expect(Date.parse(beforeCheckedAt)).toBeLessThanOrEqual(
        Date.parse(terminal.completedAt),
      )
      if (terminal.evidence.kind !== 'terminal') {
        throw new Error('Expected terminal receipt evidence.')
      }
      expect(Date.parse(terminal.evidence.terminalAt)).toBeLessThanOrEqual(
        Date.parse(afterCheckedAt),
      )
      expect(Date.parse(afterCheckedAt)).toBeGreaterThan(
        Date.parse(terminal.processLifecycle.processExitedAt),
      )
      expect(Date.parse(afterCheckedAt)).toBeLessThanOrEqual(
        Date.parse(terminal.completedAt),
      )
      if (scenario !== 'happy-path-verified') {
        const rollbackObservedAt = at(stageBase(terminal.stageOrdinal) + 13)
        expect(Date.parse(terminal.evidence.terminalAt)).toBeLessThanOrEqual(
          Date.parse(rollbackObservedAt),
        )
        expect(Date.parse(rollbackObservedAt)).toBeGreaterThan(
          Date.parse(terminal.processLifecycle.processExitedAt),
        )
        expect(Date.parse(rollbackObservedAt)).toBeLessThanOrEqual(
          Date.parse(terminal.completedAt),
        )
      }
    }
    const partialFaultReceipt = receipts.find(
      (receipt) =>
        receipt.scenario === 'partial-apply-rollback' &&
        receipt.evidence.kind === 'fault-boundary',
    )
    const partialTerminalReceipt = receipts.find(
      (receipt) =>
        receipt.scenario === 'partial-apply-rollback' &&
        receipt.evidence.kind === 'terminal',
    )
    if (
      partialFaultReceipt?.evidence.kind !== 'fault-boundary' ||
      partialFaultReceipt.evidence.faultObservation.kind !==
        'apply-operation' ||
      partialTerminalReceipt?.evidence.kind !== 'terminal'
    ) throw new Error('Expected genuine partial reconciliation fixtures.')
    expect(
      partialTerminalReceipt.evidence.reconciliationContext
        .applyBoundaryDigest,
    ).not.toBe(
      partialFaultReceipt.evidence.faultObservation.durableRunStateDigest,
    )

    const releaseEntry = requireScenarioEntry(
      fixture.manifest,
      'happy-path-verified',
      'release',
    )
    const happyTerminal = receipts[releaseEntry.ordinal - 2]
    if (happyTerminal === undefined) {
      throw new Error('Expected happy-path terminal predecessor.')
    }
    const releaseSelection = selectCompleteManifestStage(
      fixture.manifest,
      happyTerminal,
      releaseEntry,
    )
    const releasePersisted = await createPersistedSuccessFixture(
      releaseSelection,
      happyTerminal,
    )
    const nonAdvancingLifecycle =
      rewritePersistedLifecycleRunnerStartedAt(
        releasePersisted.lifecycleEvidence,
        happyTerminal.completedAt,
      )
    const parentKey = new Uint8Array(mainKey)
    const runtimeKeyCleanupAuthorization =
      await createRuntimeKeyCleanupAuthorization(
        releaseSelection,
        releasePersisted.material.stageReservation,
      )
    const nonAdvancingParentAuthentication =
      createWorkspaceSearchMigrationRehearsalStageParentAuthentication({
        selection: releaseSelection,
        materialKind: 'success',
        persistedMaterialEvidence: releasePersisted.materialEvidence,
        persistedLifecycleEvidence: nonAdvancingLifecycle,
        runtimeAuthenticationKey: parentKey,
        publicationAuthenticationKey: new Uint8Array(publicationKey),
        runtimeKeyCleanupAuthorization,
      })
    expect(isZeroized(parentKey)).toBe(true)
    const nonAdvancingMainKey = new Uint8Array(mainKey)
    expect(() => finalizeUnknown({
      selection: releaseSelection,
      previousReceipt: happyTerminal,
      controlArguments: controlArguments(
        releaseEntry.scenario,
        releaseEntry.scenarioStageOrdinal,
        releaseEntry.command,
        releaseEntry.attemptOrdinal,
      ),
      materialKind: 'success',
      persistedMaterialEvidence: releasePersisted.materialEvidence,
      persistedLifecycleEvidence: nonAdvancingLifecycle,
      parentAuthentication: nonAdvancingParentAuthentication,
      proof: { kind: 'release' },
      runtimeAuthenticationKey: nonAdvancingMainKey,
      publicationAuthenticationKey: new Uint8Array(publicationKey),
    })).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
    expect(isZeroized(nonAdvancingMainKey)).toBe(true)

    const artifactEntry = fixture.manifest.entries.find(
      (entry) =>
        entry.scenario === 'artifact-before-checkpoint-kill' &&
        entry.expectedOutcome === 'fault-reached',
    )
    if (artifactEntry === undefined) {
      throw new Error('Expected artifact fault entry.')
    }
    const artifactPrevious = receipts[artifactEntry.ordinal - 2]
    if (artifactPrevious === undefined) {
      throw new Error('Expected artifact fault predecessor.')
    }
    const artifactSelection = selectCompleteManifestStage(
      fixture.manifest,
      artifactPrevious,
      artifactEntry,
    )
    const artifactPersisted = await createPersistedFaultFixture(
      artifactSelection,
      artifactPrevious,
    )
    if (artifactPersisted.kind !== 'fault-boundary') {
      throw new Error('Expected stopped artifact boundary material.')
    }
    const artifactTamperCases = Object.freeze([
      Object.freeze({
        field: 'closedWriterFenceRecordDigest',
        replacement: digest('tampered-artifact-writer-fence'),
      }),
      Object.freeze({
        field: 'durableHeadProgressDigest',
        replacement: digest('tampered-artifact-durable-head'),
      }),
    ])
    for (const tamper of artifactTamperCases) {
      const ownedMainKey = new Uint8Array(mainKey)
      expect(() => finalizeUnknown({
        selection: artifactSelection,
        previousReceipt: artifactPrevious,
        controlArguments: controlArguments(
          artifactEntry.scenario,
          artifactEntry.scenarioStageOrdinal,
          artifactEntry.command,
          artifactEntry.attemptOrdinal,
        ),
        materialKind: 'fault-boundary',
        persistedMaterialEvidence: tamperPersistedFaultObservation(
          artifactPersisted.materialEvidence,
          tamper.field,
          tamper.replacement,
        ),
        persistedLifecycleEvidence: artifactPersisted.lifecycleEvidence,
        parentAuthentication: artifactPersisted.parentAuthentication,
        faultPlan: artifactPersisted.faultPlan,
        boundaryRateSegmentBytes:
          artifactPersisted.boundaryRateSegmentBytes,
        proof: { kind: 'planning' },
        runtimeAuthenticationKey: ownedMainKey,
        publicationAuthenticationKey: new Uint8Array(publicationKey),
      })).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
      expect(isZeroized(ownedMainKey)).toBe(true)
    }

    const partialEntry = fixture.manifest.entries.find(
      (entry) =>
        entry.scenario === 'partial-apply-rollback' &&
        entry.expectedOutcome === 'fault-reached',
    )
    if (partialEntry === undefined) {
      throw new Error('Expected partial apply fault entry.')
    }
    const partialPrevious = receipts[partialEntry.ordinal - 2]
    if (partialPrevious === undefined) {
      throw new Error('Expected partial apply planning predecessor.')
    }
    const partialSelection = selectCompleteManifestStage(
      fixture.manifest,
      partialPrevious,
      partialEntry,
    )
    const partialPersisted = await createPersistedFaultFixture(
      partialSelection,
      partialPrevious,
    )
    if (partialPersisted.kind !== 'fault-boundary') {
      throw new Error('Expected stopped partial-apply boundary material.')
    }
    const partialTamperCases = Object.freeze([
      Object.freeze({
        field: 'durableAppliedOperationCount',
        replacement: 2,
      }),
      Object.freeze({
        field: 'durableRunStateDigest',
        replacement: digest('tampered-partial-durable-state'),
      }),
    ])
    for (const tamper of partialTamperCases) {
      const proofFixture = await createCompleteManifestProof(
        partialSelection,
        partialPrevious,
        receipts,
      )
      const ownedMainKey = new Uint8Array(mainKey)
      expect(() => finalizeUnknown({
        selection: partialSelection,
        previousReceipt: partialPrevious,
        controlArguments: controlArguments(
          partialEntry.scenario,
          partialEntry.scenarioStageOrdinal,
          partialEntry.command,
          partialEntry.attemptOrdinal,
        ),
        materialKind: 'fault-boundary',
        persistedMaterialEvidence: tamperPersistedFaultObservation(
          partialPersisted.materialEvidence,
          tamper.field,
          tamper.replacement,
        ),
        persistedLifecycleEvidence: partialPersisted.lifecycleEvidence,
        parentAuthentication: partialPersisted.parentAuthentication,
        faultPlan: partialPersisted.faultPlan,
        boundaryRateSegmentBytes:
          partialPersisted.boundaryRateSegmentBytes,
        proof: proofFixture.proof,
        runtimeAuthenticationKey: ownedMainKey,
        publicationAuthenticationKey: new Uint8Array(publicationKey),
      })).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
      expect(isZeroized(ownedMainKey)).toBe(true)
      expect(proofFixture.ownedEvidenceKeys.every(isZeroized)).toBe(true)
    }

    const takeoverEntry = fixture.manifest.entries.find(
      (entry) =>
        entry.scenario === 'cursor-before-commit-kill' &&
        entry.expectedOutcome === 'takeover-completed',
    )
    if (takeoverEntry === undefined) {
      throw new Error('Expected cursor takeover entry.')
    }
    const takeoverPrevious = receipts[takeoverEntry.ordinal - 2]
    if (takeoverPrevious === undefined) {
      throw new Error('Expected killed cursor predecessor.')
    }
    const takeoverSelection = selectCompleteManifestStage(
      fixture.manifest,
      takeoverPrevious,
      takeoverEntry,
    )
    const takeoverBase = stageBase(takeoverEntry.ordinal)
    const takeoverSuccessorIdentity =
      digest(`lease:${takeoverEntry.scenario}:${takeoverEntry.attemptOrdinal}`)
    const invalidTakeoverObservations:
      readonly WorkspaceSearchMigrationRehearsalLeaseAcquisitionObservation[] =
        Object.freeze([
          Object.freeze({
            kind: 'acquired',
            predecessorLeaseIdentityDigest:
              digest('mismatched-predecessor-lease'),
            predecessorLeaseExpiresAt: at(takeoverBase - 2),
            acquiredAt: at(takeoverBase),
            successorLeaseIdentityDigest: takeoverSuccessorIdentity,
            successorLeaseExpiresAt: at(takeoverBase + 3_599),
          }),
          Object.freeze({
            kind: 'acquired',
            predecessorLeaseIdentityDigest:
              takeoverPrevious.leaseIdentityDigest,
            predecessorLeaseExpiresAt:
              takeoverPrevious.processLifecycle.processExitedAt,
            acquiredAt: at(takeoverBase),
            successorLeaseIdentityDigest: takeoverSuccessorIdentity,
            successorLeaseExpiresAt: at(takeoverBase + 3_599),
          }),
        ])
    for (const observation of invalidTakeoverObservations) {
      const persisted = await createPersistedSuccessFixture(
        takeoverSelection,
        takeoverPrevious,
        observation,
      )
      const proofFixture = await createCompleteManifestProof(
        takeoverSelection,
        takeoverPrevious,
        receipts,
      )
      const ownedMainKey = new Uint8Array(mainKey)
      expect(() => finalizeUnknown({
        selection: takeoverSelection,
        previousReceipt: takeoverPrevious,
        controlArguments: controlArguments(
          takeoverEntry.scenario,
          takeoverEntry.scenarioStageOrdinal,
          takeoverEntry.command,
          takeoverEntry.attemptOrdinal,
        ),
        materialKind: 'success',
        persistedMaterialEvidence: persisted.materialEvidence,
        persistedLifecycleEvidence: persisted.lifecycleEvidence,
        parentAuthentication: persisted.parentAuthentication,
        proof: proofFixture.proof,
        runtimeAuthenticationKey: ownedMainKey,
        publicationAuthenticationKey: new Uint8Array(publicationKey),
      })).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
      expect(isZeroized(ownedMainKey)).toBe(true)
      expect(proofFixture.ownedEvidenceKeys.every(isZeroized)).toBe(true)
    }
  })

  test('derives all happy-path receipts without accepting receipt claims', async () => {
    const fixture = createManifestFixture()
    const entries = fixture.manifest.entries.slice(0, 4)
    const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
    let previous: WorkspaceSearchMigrationRehearsalStageReceipt | null = null
    for (const entry of entries) {
      const selection = selectSupportedStage(
        fixture.manifest,
        previous,
        entry,
      )
      const persisted = await createPersistedSuccessFixture(
        selection,
        previous,
      )
      let proof: WorkspaceSearchMigrationRehearsalStageFinalizationProof
      if (entry.command === 'close-replan') {
        proof = { kind: 'planning' }
      } else if (entry.command === 'apply') {
        proof = {
          kind: 'apply',
          planningReceipt: null,
          targetPreimageAudit: null,
        }
      } else if (entry.command === 'verify') {
        const planningReceipt = receipts[0]
        if (planningReceipt === undefined) {
          throw new Error('Expected happy-path planning receipt.')
        }
        proof = {
          kind: 'terminal',
          planningReceipt,
          reconciliationArtifactBytes:
            await createTerminalReconciliationArtifact(
              selection,
              previous,
              planningReceipt,
            ),
        }
      } else {
        proof = { kind: 'release' }
      }
      const receipt = finalizeFixtureStage(
        selection,
        previous,
        persisted,
        proof,
      )
      receipts.push(receipt)
      previous = receipt
    }
    const planning = receipts[0]
    const terminal = receipts[2]
    const release = receipts[3]
    expect(planning?.evidence.kind).toBe('planning-sealed')
    expect(terminal?.evidence.kind).toBe('terminal')
    expect(terminal?.evidence.kind === 'terminal'
      ? terminal.evidence.integrityPurpose
      : null).toBe('verified')
    expect(terminal?.evidence.kind === 'terminal'
      ? [
        terminal.evidence.duplicateApplyCount,
        terminal.evidence.lostItemCount,
        terminal.evidence.orphanAuthorityCount,
      ]
      : []).toEqual([0, 0, 0])
    expect(release?.evidence.kind).toBe('released')
    expect(new Set(receipts.map((receipt) => receipt.runLocatorDigest)).size)
      .toBe(1)
    expect(new Set(
      receipts.map((receipt) => receipt.attemptLocatorDigest),
    ).size).toBe(1)
    expect(serializeCanonicalJson(receipts)).not.toContain(
      'run-happy-path-verified',
    )
    expect(serializeCanonicalJson(receipts)).not.toContain(
      'owner-happy-path-verified-1',
    )
  })

  test('authenticates preimage and actual rollback reconciliation internally', async () => {
    const fixture = createManifestFixture()
    let previous = createCompleteRollbackPredecessor(fixture)
    const entries = fixture.manifest.entries.slice(32, 36)
    const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
    const consumedEvidenceKeys: Uint8Array[] = []
    let preimageArtifact: Uint8Array | undefined
    for (const entry of entries) {
      const selection = selectSupportedStage(
        fixture.manifest,
        previous,
        entry,
      )
      const persisted = await createPersistedSuccessFixture(
        selection,
        previous,
      )
      let proof: WorkspaceSearchMigrationRehearsalStageFinalizationProof
      if (entry.command === 'close-replan') {
        proof = { kind: 'planning' }
      } else if (entry.command === 'apply') {
        if (previous.evidence.kind !== 'planning-sealed') {
          throw new Error('Expected complete-rollback planning receipt.')
        }
        preimageArtifact = createTargetAuditArtifact(
          fixture.manifest,
          previous,
          'complete-rollback-preimage',
          at(stageBase(33) + 15),
          null,
        )
        const verificationKey = new Uint8Array(targetAuditKey)
        consumedEvidenceKeys.push(verificationKey)
        proof = {
          kind: 'apply',
          planningReceipt: null,
          targetPreimageAudit: {
            artifactBytes: preimageArtifact,
            verificationKey,
          },
        }
      } else if (entry.command === 'rollback-complete') {
        const planningReceipt = receipts[0]
        if (planningReceipt === undefined) {
          throw new Error('Expected complete-rollback planning receipt.')
        }
        const mismatchedPersisted = await createPersistedSuccessFixture(
          selection,
          previous,
        )
        const mismatchedRuntimeKey = new Uint8Array(mainKey)
        const mismatchedReconciliationArtifact =
          await createTerminalReconciliationArtifact(
            selection,
            previous,
            planningReceipt,
            digest('mismatched-complete-applied-root'),
          )
        expect(() => finalizeUnknown({
          selection,
          previousReceipt: previous,
          controlArguments: controlArguments(
            entry.scenario,
            entry.scenarioStageOrdinal,
            entry.command,
            entry.attemptOrdinal,
          ),
          materialKind: 'success',
          persistedMaterialEvidence:
            mismatchedPersisted.materialEvidence,
          persistedLifecycleEvidence:
            mismatchedPersisted.lifecycleEvidence,
          parentAuthentication:
            mismatchedPersisted.parentAuthentication,
          proof: {
            kind: 'terminal',
            planningReceipt,
            reconciliationArtifactBytes:
              mismatchedReconciliationArtifact,
          },
          runtimeAuthenticationKey: mismatchedRuntimeKey,
          publicationAuthenticationKey: new Uint8Array(publicationKey),
        })).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
        expect(isZeroized(mismatchedRuntimeKey)).toBe(true)
        proof = {
          kind: 'terminal',
          planningReceipt,
          reconciliationArtifactBytes:
            await createTerminalReconciliationArtifact(
              selection,
              previous,
              planningReceipt,
            ),
        }
      } else {
        proof = { kind: 'release' }
      }
      const receipt = finalizeFixtureStage(
        selection,
        previous,
        persisted,
        proof,
      )
      receipts.push(receipt)
      previous = receipt
    }
    const apply = receipts[1]
    const terminal = receipts[2]
    if (preimageArtifact === undefined) {
      throw new Error('Expected complete-rollback preimage artifact.')
    }
    expect(apply?.evidence.kind).toBe('apply-complete')
    expect(apply?.evidence.kind === 'apply-complete'
      ? apply.evidence.targetPreimageArtifactContentDigest
      : null).toBe(digestBytes(preimageArtifact))
    expect(terminal?.evidence.kind).toBe('terminal')
    if (terminal?.evidence.kind !== 'terminal') {
      throw new Error('Expected complete rollback terminal evidence.')
    }
    expect(terminal.evidence.integrityPurpose).toBe('complete-rollback')
    expect(terminal.evidence.targetRollbackArtifactContentDigest).not.toBeNull()
    expect(terminal.evidence.targetRollbackObservationDigest).not.toBeNull()
    expect(terminal.evidence.duplicateApplyCount).toBe(0)
    expect(terminal.evidence.lostItemCount).toBe(0)
    expect(terminal.evidence.orphanAuthorityCount).toBe(0)
    expect(consumedEvidenceKeys.every(isZeroized)).toBe(true)
  })

  test('rejects an authentic rollback preimage substituted after reservation', async () => {
    const fixture = createManifestFixture()
    const predecessor = createCompleteRollbackPredecessor(fixture)
    const planningEntry = requireScenarioEntry(
      fixture.manifest,
      'complete-apply-rollback',
      'close-replan',
    )
    const planningSelection = selectSupportedStage(
      fixture.manifest,
      predecessor,
      planningEntry,
    )
    const planningPersisted = await createPersistedSuccessFixture(
      planningSelection,
      predecessor,
    )
    const planningReceipt = finalizeFixtureStage(
      planningSelection,
      predecessor,
      planningPersisted,
      { kind: 'planning' },
    )
    const applyEntry = requireScenarioEntry(
      fixture.manifest,
      'complete-apply-rollback',
      'apply',
    )
    const applySelection = selectSupportedStage(
      fixture.manifest,
      planningReceipt,
      applyEntry,
    )
    const applyPersisted = await createPersistedSuccessFixture(
      applySelection,
      planningReceipt,
    )
    const substitutedArtifact = createTargetAuditArtifact(
      fixture.manifest,
      planningReceipt,
      'complete-rollback-preimage',
      at(stageBase(planningEntry.ordinal) + 16),
      null,
    )
    const rejectedRuntimeKey = new Uint8Array(mainKey)
    const rejectedPreimageKey = new Uint8Array(targetAuditKey)
    expect(() =>
      finalizeWorkspaceSearchMigrationRehearsalStageReceipt({
        selection: applySelection,
        previousReceipt: planningReceipt,
        controlArguments: controlArguments(
          applyEntry.scenario,
          applyEntry.scenarioStageOrdinal,
          applyEntry.command,
          applyEntry.attemptOrdinal,
        ),
        materialKind: 'success',
        persistedMaterialEvidence: applyPersisted.materialEvidence,
        persistedLifecycleEvidence: applyPersisted.lifecycleEvidence,
        parentAuthentication: applyPersisted.parentAuthentication,
        proof: {
          kind: 'apply',
          planningReceipt: null,
          targetPreimageAudit: {
            artifactBytes: substitutedArtifact,
            verificationKey: rejectedPreimageKey,
          },
        },
        runtimeAuthenticationKey: rejectedRuntimeKey,
        publicationAuthenticationKey: new Uint8Array(publicationKey),
      })
    ).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
    expect(isZeroized(rejectedRuntimeKey)).toBe(true)
    expect(isZeroized(rejectedPreimageKey)).toBe(true)

    const matchingArtifact = createScenarioPreimageArtifact(
      fixture.manifest,
      'complete-apply-rollback',
      planningReceipt,
    )
    expect(() =>
      finalizeFixtureStage(
        applySelection,
        planningReceipt,
        applyPersisted,
        {
          kind: 'apply',
          planningReceipt: null,
          targetPreimageAudit: {
            artifactBytes: matchingArtifact,
            verificationKey: new Uint8Array(targetAuditKey),
          },
        },
      )
    ).not.toThrow()
  })

  test('rejects unsupported post-fault scenarios before material acceptance', () => {
    const fixture = createManifestFixture()
    const entry = fixture.manifest.entries.find(
      (candidate) =>
        candidate.scenario === 'transaction-response-loss' &&
        candidate.command === 'verify',
    )
    if (entry === undefined) throw new Error('Missing unsupported fixture.')
    const previous = createArbitraryPreviousReceipt(fixture, entry)
    const selection = selectWorkspaceSearchMigrationRehearsalStage({
      manifest: fixture.manifest,
      verificationKey: mainKey,
      previousReceipt: previous,
      controlArguments: controlArguments(
        entry.scenario,
        entry.scenarioStageOrdinal,
        entry.command,
        entry.attemptOrdinal,
      ),
      faultPlanDigest: null,
    })
    const ownedMainKey = new Uint8Array(mainKey)
    expect(() => finalizeUnknown({
      selection,
      previousReceipt: previous,
      controlArguments: controlArguments(
        entry.scenario,
        entry.scenarioStageOrdinal,
        entry.command,
        entry.attemptOrdinal,
      ),
      persistedMaterialEvidence: {},
      persistedLifecycleEvidence: {},
      parentAuthentication: {},
      proof: {
        kind: 'terminal',
        planningReceipt: {},
        reconciliationArtifactBytes: new Uint8Array(),
      },
      runtimeAuthenticationKey: ownedMainKey,
      publicationAuthenticationKey: new Uint8Array(publicationKey),
    })).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
    expect(isZeroized(ownedMainKey)).toBe(true)
  })

  test('rejects a rehashed lifecycle that lacks matching parent authentication', async () => {
    const fixture = createManifestFixture()
    const entry = fixture.manifest.entries[0]
    if (entry === undefined) throw new Error('Missing initial happy-path stage.')
    const selection = selectSupportedStage(fixture.manifest, null, entry)
    const persisted = await createPersistedSuccessFixture(selection, null)
    const ownedMainKey = new Uint8Array(mainKey)
    expect(() => finalizeUnknown({
      selection,
      previousReceipt: null,
      controlArguments: controlArguments(
        entry.scenario,
        entry.scenarioStageOrdinal,
        entry.command,
        entry.attemptOrdinal,
      ),
      persistedMaterialEvidence: persisted.materialEvidence,
      persistedLifecycleEvidence: tamperPersistedLifecycleEvidence(
        persisted.lifecycleEvidence,
      ),
      parentAuthentication: persisted.parentAuthentication,
      proof: { kind: 'planning' },
      runtimeAuthenticationKey: ownedMainKey,
      publicationAuthenticationKey: new Uint8Array(publicationKey),
    })).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
    expect(isZeroized(ownedMainKey)).toBe(true)
  })

  test('rejects a different incarnation and tampered reconciliation artifact', async () => {
    const fixture = createManifestFixture()
    const entries = fixture.manifest.entries.slice(0, 3)
    const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
    let previous: WorkspaceSearchMigrationRehearsalStageReceipt | null = null
    for (const entry of entries.slice(0, 2)) {
      const selection = selectSupportedStage(
        fixture.manifest,
        previous,
        entry,
      )
      const persisted = await createPersistedSuccessFixture(
        selection,
        previous,
      )
      const proof: WorkspaceSearchMigrationRehearsalStageFinalizationProof =
        entry.command === 'close-replan'
          ? { kind: 'planning' }
          : {
              kind: 'apply',
              planningReceipt: null,
              targetPreimageAudit: null,
            }
      const receipt = finalizeFixtureStage(
        selection,
        previous,
        persisted,
        proof,
      )
      receipts.push(receipt)
      previous = receipt
    }
    const terminalEntry = entries[2]
    const planningReceipt = receipts[0]
    if (terminalEntry === undefined || planningReceipt === undefined) {
      throw new Error('Missing happy-path terminal fixture.')
    }
    const selection = selectSupportedStage(
      fixture.manifest,
      previous,
      terminalEntry,
    )
    const replacementResourceIdentities =
      fixtureIntegrityResourceIdentities('resource').map((identity) =>
        identity.target === 'table:audit-events'
          ? Object.freeze({
              ...identity,
              identityDigest: digest('replacement-audit-events-incarnation'),
            })
          : identity
      )
    await expect(
      createTerminalReconciliationArtifact(
        selection,
        previous,
        planningReceipt,
        undefined,
        replacementResourceIdentities,
      ),
    ).rejects.toThrow()
    const persisted = await createPersistedSuccessFixture(
      selection,
      previous,
    )
    const reconciliationArtifactBytes =
      await createTerminalReconciliationArtifact(
        selection,
        previous,
        planningReceipt,
      )
    reconciliationArtifactBytes[
      reconciliationArtifactBytes.byteLength - 1
    ] ^= 1
    const ownedMainKey = new Uint8Array(mainKey)
    expect(() => finalizeUnknown({
      selection,
      previousReceipt: previous,
      controlArguments: controlArguments(
        terminalEntry.scenario,
        terminalEntry.scenarioStageOrdinal,
        terminalEntry.command,
        terminalEntry.attemptOrdinal,
      ),
      materialKind: 'success',
      persistedMaterialEvidence: persisted.materialEvidence,
      persistedLifecycleEvidence: persisted.lifecycleEvidence,
      parentAuthentication: persisted.parentAuthentication,
      proof: {
        kind: 'terminal',
        planningReceipt,
        reconciliationArtifactBytes,
      },
      runtimeAuthenticationKey: ownedMainKey,
      publicationAuthenticationKey: new Uint8Array(publicationKey),
    })).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
    expect(isZeroized(ownedMainKey)).toBe(true)
  })

  test('rejects operator-supplied reconciliation binding fields', async () => {
    const fixture = createManifestFixture()
    let previous = createCompleteRollbackPredecessor(fixture)
    const entries = fixture.manifest.entries.slice(32, 35)
    const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
    for (const entry of entries.slice(0, 2)) {
      const selection = selectSupportedStage(fixture.manifest, previous, entry)
      const persisted = await createPersistedSuccessFixture(
        selection,
        previous,
      )
      let proof: WorkspaceSearchMigrationRehearsalStageFinalizationProof
      if (entry.command === 'close-replan') {
        proof = { kind: 'planning' }
      } else {
        if (previous.evidence.kind !== 'planning-sealed') {
          throw new Error('Expected complete-rollback planning receipt.')
        }
        proof = {
          kind: 'apply',
          planningReceipt: null,
          targetPreimageAudit: {
            artifactBytes: createScenarioPreimageArtifact(
              fixture.manifest,
              'complete-apply-rollback',
              previous,
            ),
            verificationKey: new Uint8Array(targetAuditKey),
          },
        }
      }
      const receipt = finalizeFixtureStage(
        selection,
        previous,
        persisted,
        proof,
      )
      receipts.push(receipt)
      previous = receipt
    }
    const terminalEntry = entries[2]
    const planningReceipt = receipts[0]
    if (terminalEntry === undefined || planningReceipt === undefined) {
      throw new Error('Expected complete-rollback terminal fixture.')
    }
    const selection = selectSupportedStage(
      fixture.manifest,
      previous,
      terminalEntry,
    )
    const persisted = await createPersistedSuccessFixture(
      selection,
      previous,
    )
    const reconciliationArtifactBytes =
      await createTerminalReconciliationArtifact(
        selection,
        previous,
        planningReceipt,
      )
    const ownedMainKey = new Uint8Array(mainKey)
    expect(() => finalizeUnknown({
      selection,
      previousReceipt: previous,
      controlArguments: controlArguments(
        terminalEntry.scenario,
        terminalEntry.scenarioStageOrdinal,
        terminalEntry.command,
        terminalEntry.attemptOrdinal,
      ),
      materialKind: 'success',
      persistedMaterialEvidence: persisted.materialEvidence,
      persistedLifecycleEvidence: persisted.lifecycleEvidence,
      parentAuthentication: persisted.parentAuthentication,
      proof: {
        kind: 'terminal',
        planningReceipt,
        reconciliationArtifactBytes,
        binding: { status: 'operator-asserted' },
      },
      runtimeAuthenticationKey: ownedMainKey,
      publicationAuthenticationKey: new Uint8Array(publicationKey),
    })).toThrow(WorkspaceSearchMigrationRehearsalStageFinalizerError)
    expect(isZeroized(ownedMainKey)).toBe(true)
  })
})

/** Returns SHA-256 over exact raw fixture bytes. */
function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Creates a valid immediate receipt for an otherwise unsupported entry. */
function createArbitraryPreviousReceipt(
  fixture: ManifestFixture,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const previousEntry = fixture.manifest.entries[entry.ordinal - 2]
  if (previousEntry === undefined || previousEntry.command !== 'apply') {
    throw new Error('Expected a completed apply predecessor.')
  }
  const base = stageBase(previousEntry.ordinal)
  return createWorkspaceSearchMigrationRehearsalStageReceipt({
    claims: {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
      receiptVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
      stage: 'non-production',
      scenario: previousEntry.scenario,
      stageOrdinal: previousEntry.ordinal,
      scenarioStageOrdinal: previousEntry.scenarioStageOrdinal,
      command: previousEntry.command,
      controlArgumentsDigest: previousEntry.controlArgumentsDigest,
      serializedOutputLineDigest: digest('unsupported-previous-output'),
      manifestDigest: createMigrationDigest(fixture.manifest),
      manifestEntryDigest: createMigrationDigest(previousEntry),
      permitDigest: fixture.manifest.permitDigest,
      commit: fixture.manifest.commit,
      requestedResourcesBinding:
        fixture.manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        fixture.manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities:
        fixture.manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        fixture.manifest.integrityResourceIdentityDigest,
      configurationBindingDigest:
        fixture.manifest.configurationBindingDigest,
      policyVersion: fixture.manifest.policyVersion,
      runLocatorDigest: digest('unsupported-run'),
      attemptOrdinal: previousEntry.attemptOrdinal,
      attemptLocatorDigest: digest('unsupported-attempt'),
      ownerLocatorDigest: digest('unsupported-owner'),
      leaseIdentityDigest: digest('unsupported-lease'),
      leaseObservation: {
        kind: 'reused-active',
        currentLeaseIdentityDigest: digest('unsupported-lease'),
        evaluatedAt: at(base - 1),
        currentLeaseExpiresAt: at(base + 3_599),
      },
      expectedAuthorities: Object.freeze([]),
      writerFenceDigest: digest('unsupported-closed-fence'),
      previousStageReceiptDigest: digest('unsupported-predecessor'),
      stageReservationDigest:
        digest(`unsupported-reservation:${previousEntry.ordinal}`),
      stageReservationClaimRevision: previousEntry.ordinal * 2 - 1,
      stageReservationCommitRevision: previousEntry.ordinal * 2,
      stageReservationAbandonmentCount: 0,
      stageReservationAbandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      startedAt: at(base),
      completedAt: at(base + 6),
      processLifecycle: {
        lifecycleDigest: digest('unsupported-lifecycle'),
        runnerStartedAt: at(base),
        receiptObservedAt: at(base + 7),
        receiptPersistedAt: at(base + 8),
        parentDecisionRecordedAt: null,
        processExitedAt: at(base + 9),
        exitClass: 'successful-no-fault',
      },
      outcome: 'completed',
      faultReceiptDigest: null,
      faultBoundary: null,
      predecessorLeaseExpiresAt: null,
      takeoverAcquiredAt: null,
      reconciledAt: null,
      evidence: {
        kind: 'apply-complete',
        executionRunDigest: digest('unsupported-execution'),
        planDigest: digest('unsupported-plan'),
        sealedPlanOperationCount: 1,
        appliedOperationCount: 1,
        appliedRootDigest: digest('unsupported-applied-root'),
        targetPreimageArtifactContentDigest: null,
        appliedAt: at(base + 5),
      },
      rateSegment: {
        authenticationKeyFingerprint:
          createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
            mainKey,
          ),
        segmentLocatorDigest: digest('unsupported-segment-locator'),
        segmentOrdinal: previousEntry.ordinal - 1,
        firstEventSequence: previousEntry.ordinal,
        eventCount: 1,
        firstCommittedEventSequence: previousEntry.ordinal,
        lastCommittedEventSequence: previousEntry.ordinal,
        terminalRecordMac: digest('unsupported-segment-mac'),
        segmentDigest: digest('unsupported-segment'),
      },
    },
    signingKey: mainKey,
  })
}
