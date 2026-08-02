import { createHash, createHmac } from 'node:crypto'
import {
  DescribeTableCommand,
  type DescribeTableCommandOutput,
} from '@aws-sdk/client-dynamodb'
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
  type CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
import type {
  CrossDomainIntegrityAwsTransport,
  CrossDomainIntegrityTableNames,
} from '../../data-integrity/verify-cross-domain-integrity'
import {
  createMigrationDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  deriveWorkspaceSearchMigrationRehearsalKeys,
} from './migration-rehearsal-key-derivation'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalAlarmEvidence,
  type WorkspaceSearchMigrationRehearsalAlarmName,
  type WorkspaceSearchMigrationRehearsalAttestationEvidence,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import type {
  WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-fault-observation'
import {
  createWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
  createWorkspaceSearchMigrationRehearsalAlarmSharedClaimsBinding,
  finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_VERSION,
  type WorkspaceSearchMigrationRehearsalAlarmAuthorization,
  type WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact,
} from './migration-rehearsal-alarm-evidence'
import {
  consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
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
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  finalizeWorkspaceSearchMigrationRehearsalRateEvidence,
  finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor,
  type WorkspaceSearchMigrationRehearsalFinalizedRateEvidence,
  type WorkspaceSearchMigrationRehearsalRateCommittedSegment,
  type WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
} from './migration-rehearsal-rate-evidence'
import {
  authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes,
  finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact,
  finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence,
  type WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence,
  type FinalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidenceInput,
  type WorkspaceSearchMigrationRehearsalReconciliationAuditContext,
  type WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
  type WorkspaceSearchMigrationRehearsalReconciliationCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  type WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult,
  type WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair,
} from './migration-rehearsal-reconciliation-audit'
import type {
  WorkspaceSearchMigrationRehearsalSelectedStage,
} from './migration-rehearsal-stage-manifest'
import {
  createWorkspaceSearchMigrationRehearsalStageManifest,
  createWorkspaceSearchMigrationRehearsalStageReceipt,
  createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest,
  deriveWorkspaceSearchMigrationRehearsalStageChainEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
  type WorkspaceSearchMigrationRehearsalApplyStageEvidence,
  type WorkspaceSearchMigrationRehearsalFaultStageEvidence,
  type WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageEvidence,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestClaims,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
  type WorkspaceSearchMigrationRehearsalStageRateSegment,
  type WorkspaceSearchMigrationRehearsalStageReceipt,
  type WorkspaceSearchMigrationRehearsalStageReceiptClaims,
} from './migration-rehearsal-stage-receipt'
import {
  createWorkspaceSearchMigrationRehearsalStageReservation,
  type WorkspaceSearchMigrationRehearsalStageReservation,
} from './migration-rehearsal-stage-reservation'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  createWorkspaceSearchMigrationRehearsalStageChildMaterialRatePolicyBytes,
} from './migration-rehearsal-stage-child-material.test-fixture'
import {
  assembleWorkspaceSearchMigrationRehearsalAuthenticatedSuite,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_VERSION,
  type AssembleWorkspaceSearchMigrationRehearsalAuthenticatedSuiteInput,
  type AssembleWorkspaceSearchMigrationRehearsalSuitePreparationInput,
  type WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation,
  type WorkspaceSearchMigrationRehearsalSuitePublicationBindings,
} from './migration-rehearsal-suite-finalizer'
import {
  ingestWorkspaceSearchMigrationRehearsalAlarmSignal,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmIngestionTarget,
  type WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort,
} from './migration-rehearsal-alarm-ingestion'
import {
  createWorkspaceSearchMigrationTelemetryRecorder,
} from './migration-telemetry'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
  type FinalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidenceInput,
  type WorkspaceSearchMigrationRehearsalTargetAuditContext,
  type WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding,
} from './migration-rehearsal-target-audit'
import {
  createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest,
  createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings,
  createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
  runWorkspaceSearchMigrationTelemetryRehearsal,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER,
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
  type WorkspaceSearchMigrationTelemetryRehearsalSignal,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalBinding,
  type WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact,
} from './migration-telemetry-rehearsal'

/** Optional authenticated negative-path variants for the shared fixture. */
export type AuthenticWorkspaceSearchMigrationRehearsalSuiteFixtureOptions = {
  /** Phase carried by the sole unassigned final rate segment. */
  readonly finalMeasurementPhase?: 'checkpoint-page' | 'measurement'
  /** Authenticated raw-stream defect used to exercise integrity inventory. */
  readonly integrityInventoryVariant?:
    | 'integrity-budget-stop'
    | 'integrity-throttle'
    | 'unclaimed-integrity-operation'
  /** Authenticated raw-stream defect for the final publication exercise. */
  readonly rateExerciseVariant?:
    | 'after-stop-event'
    | 'aws-service-substitution'
    | 'backoff-mismatch'
    | 'early-injection'
    | 'nonconsecutive'
    | 'sequence-mismatch'
    | 'source-mismatch'
    | 'two-injections'
    | 'zero-injection'
  /** Optional authentic omission or addition around the exact 50 segments. */
  readonly rateSegmentCountOffset?: -1 | 0 | 1
}

/** Fresh raw assembler material and its publication-facing expectations. */
export type AuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture = {
  /** Fresh one-shot capabilities and restricted bytes accepted by assembler. */
  readonly input: AssembleWorkspaceSearchMigrationRehearsalSuitePreparationInput
  /** Same fresh capabilities routed through the operator-claim-free assembler. */
  readonly authenticatedInput:
    AssembleWorkspaceSearchMigrationRehearsalAuthenticatedSuiteInput
  /** Expected identity, time, attestation, and live-rate publication bindings. */
  readonly expected: WorkspaceSearchMigrationRehearsalSuitePublicationBindings
}

/** Fresh opaque suite capability and independently known expected bindings. */
export type AuthenticWorkspaceSearchMigrationRehearsalSuiteFixture = {
  /** Genuine one-shot suite capability returned by production assembly. */
  readonly suite: WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation
  /** Expected identity, time, attestation, and live-rate publication bindings. */
  readonly expected: WorkspaceSearchMigrationRehearsalSuitePublicationBindings
}

/** Commit-gate fixture variants supported by the shared genuine factory. */
export type AuthenticWorkspaceSearchMigrationRehearsalCommitGateFixtureKind =
  | 'target-preimage'
  | 'terminal-reconciliation'

/** Genuine rollback-planning input for one target-preimage commit gate. */
export type AuthenticWorkspaceSearchMigrationRehearsalTargetPreimageCommitGateFixture = {
  /** Fixed target-preimage variant discriminator. */
  readonly kind: 'target-preimage'
  /** Exact selected complete-rollback planning stage. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Fresh authenticated reservation matching the returned receipt. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Signed immediate predecessor required by non-first-stage stores. */
  readonly previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Fresh signed prospective planning receipt matching the reservation. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Exact canonical dual-key target-preimage artifact bytes. */
  readonly artifactBytes: Uint8Array
  /** Child rate segment including the canonical bytes used by parent auth. */
  readonly committedRateSegment:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Fresh runtime key owned by the caller. */
  readonly runtimeAuthenticationKey: Uint8Array
  /** Fresh parent publication key owned by the caller. */
  readonly publicationAuthenticationKey: Uint8Array
  /** Exact public production input issuing the target-preimage capability. */
  readonly finalizationInput:
    FinalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidenceInput
}

/** Genuine terminal input for one reconciliation commit gate. */
export type AuthenticWorkspaceSearchMigrationRehearsalTerminalCommitGateFixture = {
  /** Fixed terminal-reconciliation variant discriminator. */
  readonly kind: 'terminal-reconciliation'
  /** Exact selected happy-path terminal stage. */
  readonly selection: WorkspaceSearchMigrationRehearsalSelectedStage
  /** Fresh authenticated reservation matching the returned receipt. */
  readonly reservation: WorkspaceSearchMigrationRehearsalStageReservation
  /** Signed immediate apply predecessor required by the store. */
  readonly previousReceipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Fresh signed terminal receipt matching the reservation. */
  readonly receipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Exact canonical dual-key reconciliation artifact bytes. */
  readonly artifactBytes: Uint8Array
  /** Child rate segment including the canonical bytes used by parent auth. */
  readonly committedRateSegment:
    WorkspaceSearchMigrationRehearsalRateCommittedSegment
  /** Fresh runtime key owned by the caller. */
  readonly runtimeAuthenticationKey: Uint8Array
  /** Fresh parent publication key owned by the caller. */
  readonly publicationAuthenticationKey: Uint8Array
  /** Exact public production input issuing the terminal capability. */
  readonly finalizationInput:
    FinalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidenceInput
}

/** Either genuine special commit-gate fixture returned by the shared factory. */
export type AuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture =
  | AuthenticWorkspaceSearchMigrationRehearsalTargetPreimageCommitGateFixture
  | AuthenticWorkspaceSearchMigrationRehearsalTerminalCommitGateFixture

/** Scenarios whose genuine terminal receipt is immediately before release. */
export type AuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalScenario =
  | 'happy-path-verified'
  | 'partial-apply-rollback'
  | 'complete-apply-rollback'

/** Stable owner role for one segment in the exact 50-segment composition. */
export type AuthenticWorkspaceSearchMigrationRehearsalRateSegmentRoleName =
  | 'integrity-root'
  | 'stage'
  | 'target-preimage'
  | 'target-restored'
  | 'terminal-reconciliation'
  | 'final-publication'

/** Secret-free ownership metadata indexed by exact rate-segment ordinal. */
export type AuthenticWorkspaceSearchMigrationRehearsalRateSegmentRole = {
  /** Exact zero-based global segment ordinal. */
  readonly segmentOrdinal: number
  /** Semantic owner of this exact segment. */
  readonly role: AuthenticWorkspaceSearchMigrationRehearsalRateSegmentRoleName
  /** Owning scenario, or null for suite-global segments. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName | null
  /** Owning one-based stage ordinal, or null for auxiliary segments. */
  readonly stageOrdinal: number | null
  /** Owning control command, or null for auxiliary segments. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand | null
}

/** Genuine release predecessor plus its exact complete rate composition. */
export type AuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalFixture = {
  /** Scenario whose terminal reconciliation authorizes release. */
  readonly scenario:
    AuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalScenario
  /** Exact authenticated reviewed manifest containing the release entry. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Fresh canonical reviewed rate-policy bytes matching the manifest. */
  readonly ratePolicyBytes: Uint8Array
  /** Genuine signed terminal receipt immediately preceding release. */
  readonly terminalReceipt: WorkspaceSearchMigrationRehearsalStageReceipt
  /** Exact raw stage segment authenticated by the terminal receipt. */
  readonly terminalRateSegmentBytes: Uint8Array
  /** Exact raw auxiliary successor authenticated by reconciliation evidence. */
  readonly reconciliationSuccessorSegmentBytes: Uint8Array
  /** Exact raw segments indexed by global ordinal zero through forty-nine. */
  readonly allRateSegmentBytes: readonly Uint8Array[]
  /** Exact secret-free ownership metadata indexed by segment ordinal. */
  readonly rateSegmentRoles:
    readonly AuthenticWorkspaceSearchMigrationRehearsalRateSegmentRole[]
  /** Fresh runtime key authenticating the manifest, receipts, and segments. */
  readonly runtimeAuthenticationKey: Uint8Array
}

/** One reviewed manifest entry before its global ordinal is assigned. */
type FixtureStage = {
  /** Exact finite control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Expected authenticated process outcome. */
  readonly outcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Whether this exact entry owns the reviewed fault plan. */
  readonly fault: boolean
  /** One-based logical process attempt. */
  readonly attemptOrdinal: number
}

/** One authenticated rate segment plus its exact stage binding. */
type RateSegmentFixture = {
  /** Exact durable segment bytes. */
  readonly bytes: Uint8Array
  /** Canonical UTC anchor authenticated by the segment header. */
  readonly anchorUtc: string
  /** Strict stage-receipt binding derived from those bytes. */
  readonly binding: WorkspaceSearchMigrationRehearsalStageRateSegment
  /** First global attempt sequence charged inside this segment. */
  readonly firstAttemptSequence: number
  /** Exact number of attempts charged inside this segment. */
  readonly attemptCount: number
}

/** Auxiliary rate positions owned by one scenario's terminal evidence. */
type ScenarioAuxiliaryRateOrdinals = {
  /** Reconciliation segment immediately preceding writer-fence release. */
  readonly reconciliation: number
  /** Rollback preimage segment, otherwise null. */
  readonly preimage: number | null
  /** Rollback restored-state segment, otherwise null. */
  readonly restored: number | null
}

/** Exact 49-segment post-root ordering used by an authentic suite fixture. */
type RateLayout = {
  /** Canonical anchor timestamp for every exact segment ordinal. */
  readonly anchors: readonly string[]
  /** Global segment ordinal assigned to each one-based stage ordinal. */
  readonly stageOrdinals: ReadonlyMap<number, number>
  /** Auxiliary segment ordinals assigned to every canonical scenario. */
  readonly auxiliaryOrdinals: ReadonlyMap<
    WorkspaceSearchMigrationRehearsalScenarioName,
    ScenarioAuxiliaryRateOrdinals
  >
}

/** Actual artifact bytes and fully authenticated secret-free binding. */
type ReconciliationArtifactFixture = {
  /** Exact canonical dual-key-authenticated artifact bytes. */
  readonly bytes: Uint8Array
  /** Fully authenticated binding derived from those actual bytes. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding
}

/** All-eight actual reconciliation artifacts and one-shot suite capability. */
type ReconciliationFixture = {
  /** Artifacts indexed by canonical scenario label. */
  readonly artifacts: ReadonlyMap<
    WorkspaceSearchMigrationRehearsalScenarioName,
    ReconciliationArtifactFixture
  >
  /** Fresh opaque all-eight reconciliation capability. */
  readonly capability:
    WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence
}

/** Collector material paired with its fresh verified one-shot authority. */
type PreparedReconciliationCollector = {
  /** Exact normalized collector result for the audit finalizer. */
  readonly collectorResult:
    WorkspaceSearchMigrationRehearsalReconciliationCollectorResult
  /** Fresh live authority for verified scenarios, otherwise strict null. */
  readonly verifiedIntegrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult | null
}

/** Authenticated stage artifacts retained alongside the one-shot chain cap. */
type StageChainFixture = {
  /** Exact authenticated reviewed manifest. */
  readonly manifest: WorkspaceSearchMigrationRehearsalStageManifest
  /** Exact authenticated receipts in global stage order. */
  readonly receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[]
  /** Fresh opaque complete stage-chain capability. */
  readonly capability: WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence
}

/** Stable reviewed commit used by every authentic fixture. */
const fixtureCommit = 'a'.repeat(40)

/** Exact beginning of the first authenticated stage process. */
const fixtureStartedAt = '2026-08-02T00:00:00.000Z'

/** Twenty-one-minute global slot separating every process receipt. */
const stageSlotMilliseconds = 21 * 60_000

/** CLI-compatible master key shared with the stage-material fixture. */
const stageMasterAuthenticationKey = new Uint8Array(32).fill(0x37)

/** Purpose-separated runtime and publication keys for suite artifacts. */
const stageAuthenticationKeys =
  deriveWorkspaceSearchMigrationRehearsalKeys(
    stageMasterAuthenticationKey,
  )

/** Dedicated main stage-chain HMAC key. */
const stageAuthenticationKey = stageAuthenticationKeys.runtimeKey

/** Dedicated #163 whole-result HMAC key. */
const integrityAuthenticationKey = new Uint8Array(32).fill(0x23)

/** Dedicated durable rate-record HMAC key. */
const rateAuthenticationKey = stageAuthenticationKey

/** Canonical owner-only physical-resource attestation for live #163 fixtures. */
const integrityResourceAttestation = createIntegrityResourceAttestation()

/** Canonical public immutable identities derived from the raw attestation. */
const integrityResourceIdentities =
  createCrossDomainIntegrityImmutableResourceIdentities(
    integrityResourceAttestation,
    integrityAuthenticationKey,
  )

/** Permit-facing keyed digest of the exact immutable resource vector. */
const integrityResourceIdentityDigest =
  calculateCrossDomainIntegrityResourceIdentityDigest(
    integrityResourceIdentities,
    integrityAuthenticationKey,
  )

/** Distinct parent-held reconciliation artifact publication key. */
const reconciliationPublicationKey =
  stageAuthenticationKeys.publicationKey

/** CLI-compatible distinct runtime and parent publication alarm keys. */
const alarmAuthenticationKeys =
  deriveWorkspaceSearchMigrationRehearsalKeys(
    new Uint8Array(32).fill(7),
  )

/** Dedicated authenticated alarm-signal HMAC key. */
const alarmSignalAuthenticationKey = alarmAuthenticationKeys.runtimeKey

/** Distinct parent-held alarm artifact publication key. */
const alarmPublicationAuthenticationKey =
  alarmAuthenticationKeys.publicationKey

/** Exact digest-only CloudWatch Logs target used by ingestion fixtures. */
const alarmIngestionTarget:
WorkspaceSearchMigrationRehearsalAlarmIngestionTarget = Object.freeze({
  account: '111122223333',
  region: 'ap-northeast-1',
  logGroupName: '/mukuroji/test/workspace-search-migration/rehearsal',
  logStreamName: 'alarm-signals-v1',
  logStreamArn:
    'arn:aws:logs:ap-northeast-1:111122223333:log-group:' +
    '/mukuroji/test/workspace-search-migration/rehearsal:' +
    'log-stream:alarm-signals-v1',
})

/** Domain separator owned by the durable rate record contract. */
const rateRecordMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-rate-record:v2'

/** Deterministic permit digest shared with every stage receipt. */
const permitDigest = digest('main-permit')

/** Deterministic main requested-resource binding. */
const requestedResourcesBinding = digest('main-requested-resources')

/** Deterministic measured configuration binding. */
const configurationHash = digest('measured-configuration')

/** Canonical reviewed policy bytes shared with strict stage CLI fixtures. */
const ratePolicyBytes =
  createWorkspaceSearchMigrationRehearsalStageChildMaterialRatePolicyBytes()

/** Deterministic reviewed actual-rate policy binding. */
const ratePolicyVersion = createHash('sha256')
  .update(ratePolicyBytes)
  .digest('hex')

/** Deterministic non-production attestation shared with target artifacts. */
const attestation: WorkspaceSearchMigrationRehearsalAttestationEvidence =
  Object.freeze({
    stage: 'non-production',
    permitDigest,
    callerAttestationDigest: digest('caller-attestation'),
    resourceAttestationDigest: digest('resource-attestation'),
    productionIsolationDigest: digest('production-isolation'),
  })

/** Returns one deterministic conventional SHA-256 digest. */
function digest(label: string): string {
  return createHash('sha256').update(label, 'utf8').digest('hex')
}

/** Returns one canonical timestamp at a millisecond offset from suite start. */
function timestamp(offsetMilliseconds: number): string {
  return new Date(
    Date.parse(fixtureStartedAt) + offsetMilliseconds,
  ).toISOString()
}

/** Returns one canonical timestamp within a global stage slot. */
function stageTimestamp(stageOrdinal: number, minuteOffset: number): string {
  return timestamp(
    (stageOrdinal - 1) * stageSlotMilliseconds + minuteOffset * 60_000,
  )
}

/** Returns one copied non-zero authentication key. */
function copyKey(value: Uint8Array): Uint8Array {
  return new Uint8Array(value)
}

/** Returns the exact reviewed process stages for one canonical scenario. */
function fixtureStages(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): readonly FixtureStage[] {
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
  if (faultCommand === 'close-replan') stages.push(completed('apply', 2))
  stages.push(completed('verify', 2), completed('release', 2))
  return stages
}

/** Returns exact control arguments bound into one manifest entry. */
function fixtureControlArguments(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  scenarioStageOrdinal: number,
  command: WorkspaceSearchMigrationRehearsalStageCommand,
): readonly string[] {
  return Object.freeze([
    command,
    '--fixture-stage',
    `${scenario}-${scenarioStageOrdinal}`,
  ])
}

/** Creates complete explicit reviewed manifest claims. */
function createManifestClaims(
  integrityAttestationRoot:
    WorkspaceSearchMigrationRehearsalStageManifestClaims[
      'integrityAttestationRoot'
    ],
):
WorkspaceSearchMigrationRehearsalStageManifestClaims {
  const entries: WorkspaceSearchMigrationRehearsalStageManifestEntry[] = []
  let ordinal = 1
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const stages = fixtureStages(scenario)
    for (let index = 0; index < stages.length; index += 1) {
      const stage = stages[index]
      if (stage === undefined) throw new Error('Expected fixture stage.')
      const controlArguments = fixtureControlArguments(
        scenario,
        index + 1,
        stage.command,
      )
      entries.push(Object.freeze({
        ordinal,
        scenario,
        scenarioStageOrdinal: index + 1,
        command: stage.command,
        controlArgumentsDigest: createMigrationDigest(controlArguments),
        attemptOrdinal: stage.attemptOrdinal,
        faultPlanDigest: stage.fault
          ? digest(`fault-plan:${scenario}`)
          : null,
        expectedOutcome: stage.outcome,
      }))
      ordinal += 1
    }
  }
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
    manifestVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
    stage: 'non-production',
    commit: fixtureCommit,
    permitDigest,
    evidenceKeyDigest: createHash('sha256')
      .update(stageAuthenticationKey)
      .digest('hex'),
    publicationKeyDigest: createHash('sha256')
      .update(reconciliationPublicationKey)
      .digest('hex'),
    deploymentTrustRootDigest: digest('deployment-trust-root'),
    requestedResourcesBinding,
    integrityResourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    integrityResourceIdentities: createIntegrityResourceIdentities(),
    integrityResourceIdentityDigest,
    integrityAttestationRoot,
    configurationBindingDigest: configurationHash,
    policyVersion: ratePolicyVersion,
    reviewedAt: timestamp(-60_000),
    entries: Object.freeze(entries),
  })
}

/** Creates a production-compatible HMAC for one durable rate record. */
function createRateRecordMac(payload: unknown): string {
  return createHmac('sha256', rateAuthenticationKey)
    .update(rateRecordMacDomain, 'utf8')
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(payload), 'utf8')
    .digest('hex')
}

/** Creates the clean authentic twelve-attempt ordinal-zero rate root. */
function createIntegrityAttestationRootSegment(): RateSegmentFixture {
  const authenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      rateAuthenticationKey,
    )
  const segmentLocatorDigest = digest('rate-segment:0')
  const anchorUtc = timestamp(-120_000)
  const headerPayload = Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
    version: 2,
    segmentLocatorDigest,
    segmentOrdinal: 0,
    previousSegmentDigest: null,
    previousRecordMac: null,
    firstEventSequence: 1,
    anchorUtc,
    authenticationKeyFingerprint,
    policyVersion: ratePolicyVersion,
    configurationBindingDigest: configurationHash,
  })
  const headerMac = createRateRecordMac(headerPayload)
  const header = Object.freeze({ ...headerPayload, mac: headerMac })
  const events: Readonly<Record<string, unknown>>[] = []
  let previousRecordMac = headerMac
  for (let attemptSequence = 1; attemptSequence <= 12;
    attemptSequence += 1) {
    const firstEventSequence = (attemptSequence - 1) * 2 + 1
    const phase = attemptSequence <= 6 ? 'measurement' : 'integrity-check'
    const chargedPayload = Object.freeze({
      version: 2,
      eventSequence: firstEventSequence,
      offsetMilliseconds: (attemptSequence - 1) * 100,
      previousRecordMac,
      kind: 'attempt-charged',
      attemptSequence,
      phase,
    })
    const chargedMac = createRateRecordMac(chargedPayload)
    events.push(Object.freeze({ ...chargedPayload, mac: chargedMac }))
    const startedPayload = Object.freeze({
      version: 2,
      eventSequence: firstEventSequence + 1,
      offsetMilliseconds: (attemptSequence - 1) * 100,
      previousRecordMac: chargedMac,
      kind: 'attempt-started',
      attemptSequence,
      phase,
      remainingNormalAdmissionAttempts: 100,
      remainingWindowAttempts: 100,
      remainingPageAttempts: 0,
      inFlight: 1,
    })
    const startedMac = createRateRecordMac(startedPayload)
    events.push(Object.freeze({ ...startedPayload, mac: startedMac }))
    previousRecordMac = startedMac
  }
  const canonicalText = [header, ...events]
    .map((record) => `${serializeCanonicalJson(record)}\n`)
    .join('')
  const bytes = new TextEncoder().encode(canonicalText)
  return Object.freeze({
    bytes,
    anchorUtc,
    binding: Object.freeze({
      authenticationKeyFingerprint,
      segmentLocatorDigest,
      segmentOrdinal: 0,
      firstEventSequence: 1,
      eventCount: 24,
      firstCommittedEventSequence: 1,
      lastCommittedEventSequence: 24,
      terminalRecordMac: previousRecordMac,
      segmentDigest: createHash('sha256').update(bytes).digest('hex'),
    }),
    firstAttemptSequence: 1,
    attemptCount: 12,
  })
}

/** Creates the frozen manifest projection for the exact raw root segment. */
function createIntegrityAttestationRootProjection(
  rootSegment: RateSegmentFixture,
): WorkspaceSearchMigrationRehearsalStageManifestClaims[
  'integrityAttestationRoot'
] {
  const aggregate = Object.freeze({
    version: 2,
    policyVersion: ratePolicyVersion,
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
    deploymentTargetId: 'suite-finalizer-fixture',
    productionAccountDigest: digest('production-account'),
    configurationBindingDigest: configurationHash,
    policyVersion: ratePolicyVersion,
    attestation: Object.freeze({
      contentMac: digest('root-attestation-content'),
      byteLength: 1_024,
    }),
    segment: rootSegment.binding,
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
      startedAt: timestamp(-119_400),
      completedAt: timestamp(-118_900),
    }),
    aggregate,
    aggregateDigest: createMigrationDigest(aggregate),
    tableOrderBindingMac: digest('root-table-order'),
    rootMac: digest('integrity-root'),
    startedAt: timestamp(-120_000),
    completedAt: timestamp(-118_000),
  })
}

/**
 * Creates the exact global stage/target/reconciliation/publication ordering.
 *
 * @param entries - Complete canonical 36-stage manifest entries.
 * @returns Exact 49-segment layout with every auxiliary gap made explicit.
 */
function createRateLayout(
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
): RateLayout {
  const anchors: string[] = []
  const stageOrdinals = new Map<number, number>()
  const auxiliaryOrdinals = new Map<
    WorkspaceSearchMigrationRehearsalScenarioName,
    ScenarioAuxiliaryRateOrdinals
  >()
  const appendStage = (
    entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  ): void => {
    stageOrdinals.set(entry.ordinal, anchors.length + 1)
    anchors.push(stageTimestamp(entry.ordinal, 0))
  }
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const scenarioEntries = entries.filter(
      (entry) => entry.scenario === scenario,
    )
    const first = scenarioEntries[0]
    const terminal = scenarioEntries.at(-2)
    const release = scenarioEntries.at(-1)
    if (
      first === undefined ||
      terminal === undefined ||
      release === undefined ||
      scenarioEntries.length < 3
    ) {
      throw new Error('Expected complete scenario stage layout.')
    }
    const rollback = scenario === 'partial-apply-rollback' ||
      scenario === 'complete-apply-rollback'
    let preimage: number | null = null
    let restored: number | null = null
    appendStage(first)
    if (rollback) {
      preimage = anchors.length + 1
      anchors.push(stageTimestamp(first.ordinal, 20.1))
    }
    for (let index = 1; index < scenarioEntries.length - 1; index += 1) {
      const entry = scenarioEntries[index]
      if (entry === undefined) throw new Error('Expected scenario stage.')
      appendStage(entry)
    }
    if (rollback) {
      restored = anchors.length + 1
      anchors.push(stageTimestamp(terminal.ordinal, 18.5))
    }
    const reconciliation = anchors.length + 1
    anchors.push(stageTimestamp(terminal.ordinal, 20.2))
    appendStage(release)
    auxiliaryOrdinals.set(scenario, Object.freeze({
      reconciliation,
      preimage,
      restored,
    }))
  }
  const finalStage = entries.at(-1)
  if (finalStage === undefined) throw new Error('Expected final stage.')
  anchors.push(stageTimestamp(finalStage.ordinal, 20.25))
  if (anchors.length !== 49 || stageOrdinals.size !== entries.length) {
    throw new Error('Expected exact 49-segment suite layout.')
  }
  return Object.freeze({
    anchors: Object.freeze(anchors),
    stageOrdinals,
    auxiliaryOrdinals,
  })
}

/** Derives exact owner metadata for every segment in the 50-part stream. */
function createRateSegmentRoles(
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
  layout: RateLayout,
  segments: readonly RateSegmentFixture[],
): readonly AuthenticWorkspaceSearchMigrationRehearsalRateSegmentRole[] {
  const roles = new Map<
    number,
    AuthenticWorkspaceSearchMigrationRehearsalRateSegmentRole
  >()
  /** Adds one exact ordinal once. */
  const add = (
    role: AuthenticWorkspaceSearchMigrationRehearsalRateSegmentRole,
  ): void => {
    if (
      roles.has(role.segmentOrdinal) ||
      role.segmentOrdinal < 0 ||
      role.segmentOrdinal >= segments.length
    ) {
      throw new Error('Expected one unique in-range rate owner.')
    }
    roles.set(role.segmentOrdinal, Object.freeze(role))
  }
  add({
    segmentOrdinal: 0,
    role: 'integrity-root',
    scenario: null,
    stageOrdinal: null,
    command: null,
  })
  for (const entry of entries) {
    const segmentOrdinal = layout.stageOrdinals.get(entry.ordinal)
    if (segmentOrdinal === undefined) {
      throw new Error('Expected stage-owned rate segment.')
    }
    add({
      segmentOrdinal,
      role: 'stage',
      scenario: entry.scenario,
      stageOrdinal: entry.ordinal,
      command: entry.command,
    })
  }
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const ordinals = requireAuxiliaryRateOrdinals(layout, scenario)
    add({
      segmentOrdinal: ordinals.reconciliation,
      role: 'terminal-reconciliation',
      scenario,
      stageOrdinal: null,
      command: null,
    })
    if (ordinals.preimage !== null) {
      add({
        segmentOrdinal: ordinals.preimage,
        role: 'target-preimage',
        scenario,
        stageOrdinal: null,
        command: null,
      })
    }
    if (ordinals.restored !== null) {
      add({
        segmentOrdinal: ordinals.restored,
        role: 'target-restored',
        scenario,
        stageOrdinal: null,
        command: null,
      })
    }
  }
  add({
    segmentOrdinal: segments.length - 1,
    role: 'final-publication',
    scenario: null,
    stageOrdinal: null,
    command: null,
  })
  if (segments.length !== 50 || roles.size !== segments.length) {
    throw new Error('Expected exact complete 50-segment ownership.')
  }
  return Object.freeze(segments.map((segment, segmentOrdinal) => {
    const role = roles.get(segmentOrdinal)
    if (
      role === undefined ||
      segment.binding.segmentOrdinal !== segmentOrdinal
    ) {
      throw new Error('Expected ordinal-indexed rate ownership.')
    }
    return role
  }))
}

/** Creates all exact stage, auxiliary, and final measurement rate segments. */
function createRateSegments(
  layout: RateLayout,
  finalPhase: 'checkpoint-page' | 'measurement',
  rootSegment: RateSegmentFixture,
  integrityInventoryVariant?:
    AuthenticWorkspaceSearchMigrationRehearsalSuiteFixtureOptions[
      'integrityInventoryVariant'
    ],
  rateExerciseVariant?:
    AuthenticWorkspaceSearchMigrationRehearsalSuiteFixtureOptions[
      'rateExerciseVariant'
    ],
): readonly RateSegmentFixture[] {
  const fixtures: RateSegmentFixture[] = [rootSegment]
  let previousSegmentDigest: string | null = rootSegment.binding.segmentDigest
  let previousRecordMac: string | null =
    rootSegment.binding.terminalRecordMac
  let firstEventSequence = 25
  let firstAttemptSequence = 13
  const integritySegmentOrdinals = new Set<number>()
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const ordinals = requireAuxiliaryRateOrdinals(layout, scenario)
    if (
      scenario === 'partial-apply-rollback' ||
      scenario === 'complete-apply-rollback'
    ) {
      if (ordinals.preimage === null || ordinals.restored === null) {
        throw new Error('Expected rollback integrity rate positions.')
      }
      integritySegmentOrdinals.add(ordinals.preimage)
      integritySegmentOrdinals.add(ordinals.restored)
    } else {
      integritySegmentOrdinals.add(ordinals.reconciliation)
    }
  }
  const earlyInjectionOrdinal = requireAuxiliaryRateOrdinals(
    layout,
    'complete-apply-rollback',
  ).reconciliation
  const authenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      rateAuthenticationKey,
    )
  for (let layoutIndex = 0; layoutIndex < layout.anchors.length;
    layoutIndex += 1) {
    const segmentOrdinal = layoutIndex + 1
    const isFinal = layoutIndex === layout.anchors.length - 1
    const anchorUtc = layout.anchors[layoutIndex]
    if (anchorUtc === undefined) throw new Error('Expected rate anchor.')
    const segmentLocatorDigest = digest(`rate-segment:${segmentOrdinal}`)
    const headerPayload = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
      version: 2,
      segmentLocatorDigest,
      segmentOrdinal,
      previousSegmentDigest,
      previousRecordMac,
      firstEventSequence,
      anchorUtc,
      authenticationKeyFingerprint,
      policyVersion: ratePolicyVersion,
      configurationBindingDigest: configurationHash,
    })
    const headerMac = createRateRecordMac(headerPayload)
    const header = Object.freeze({ ...headerPayload, mac: headerMac })
    const isIntegritySegment = integritySegmentOrdinals.has(segmentOrdinal)
    const phase = isIntegritySegment ||
        (integrityInventoryVariant === 'unclaimed-integrity-operation' &&
          segmentOrdinal === 2)
      ? 'integrity-check'
      : isFinal
      ? finalPhase
      : 'checkpoint-page'
    const attemptCount = isIntegritySegment ? 12 : 1
    const events: Readonly<Record<string, unknown>>[] = []
    let terminalRecordMac = headerMac
    for (let attemptIndex = 0; attemptIndex < attemptCount;
      attemptIndex += 1) {
      const attemptSequence = firstAttemptSequence + attemptIndex
      const chargedPayload = Object.freeze({
        version: 2,
        eventSequence: firstEventSequence + events.length,
        offsetMilliseconds: isIntegritySegment
          ? attemptIndex * 100
          : 0,
        previousRecordMac: terminalRecordMac,
        kind: 'attempt-charged',
        attemptSequence,
        phase,
      })
      const chargedMac = createRateRecordMac(chargedPayload)
      events.push(Object.freeze({ ...chargedPayload, mac: chargedMac }))
      const startedPayload = Object.freeze({
        version: 2,
        eventSequence: firstEventSequence + events.length,
        offsetMilliseconds: isIntegritySegment
          ? attemptIndex * 100
          : 100,
        previousRecordMac: chargedMac,
        kind: 'attempt-started',
        attemptSequence,
        phase,
        remainingNormalAdmissionAttempts: 100,
        remainingWindowAttempts: 100,
        remainingPageAttempts: 0,
        inFlight: 1,
      })
      const startedMac = createRateRecordMac(startedPayload)
      events.push(Object.freeze({ ...startedPayload, mac: startedMac }))
      terminalRecordMac = startedMac
    }
    const injectEarly = segmentOrdinal === earlyInjectionOrdinal &&
      (rateExerciseVariant === 'early-injection' ||
        rateExerciseVariant === 'two-injections')
    const injectAtPublication = isFinal &&
      rateExerciseVariant !== 'early-injection' &&
      rateExerciseVariant !== 'zero-injection'
    if (injectEarly || injectAtPublication) {
      const attemptSequence = rateExerciseVariant === 'sequence-mismatch'
        ? firstAttemptSequence + 1
        : firstAttemptSequence
      const throttleProvenance =
        rateExerciseVariant === 'aws-service-substitution' ||
          rateExerciseVariant === 'source-mismatch'
          ? 'aws-service'
          : 'rehearsal-after-success-injection'
      const budgetStopProvenance =
        rateExerciseVariant === 'aws-service-substitution'
          ? 'aws-service-throttle'
          : 'rehearsal-after-success-injection'
      const throttledPayload = Object.freeze({
        version: 2,
        eventSequence: firstEventSequence + events.length,
        offsetMilliseconds: 200,
        previousRecordMac: terminalRecordMac,
        kind: 'attempt-throttled',
        attemptSequence,
        phase: integrityInventoryVariant === 'integrity-throttle'
          ? 'integrity-check'
          : phase,
        backoffMilliseconds: 500,
        provenance: throttleProvenance,
      })
      const throttledMac = createRateRecordMac(throttledPayload)
      events.push(Object.freeze({ ...throttledPayload, mac: throttledMac }))
      terminalRecordMac = throttledMac
      if (rateExerciseVariant === 'nonconsecutive') {
        const cadencePayload = Object.freeze({
          version: 2,
          eventSequence: firstEventSequence + events.length,
          offsetMilliseconds: 250,
          previousRecordMac: terminalRecordMac,
          kind: 'cadence-wait',
          phase,
          delayMilliseconds: 25,
        })
        const cadenceMac = createRateRecordMac(cadencePayload)
        events.push(Object.freeze({ ...cadencePayload, mac: cadenceMac }))
        terminalRecordMac = cadenceMac
      }
      const budgetPayload = Object.freeze({
        version: 2,
        eventSequence: firstEventSequence + events.length,
        offsetMilliseconds: 300,
        previousRecordMac: terminalRecordMac,
        kind: 'budget-stop',
        phase: integrityInventoryVariant === 'integrity-budget-stop'
          ? 'integrity-check'
          : phase,
        reason: 'throttled',
        requiredAttempts: 0,
        remainingNormalAdmissionAttempts: 0,
        remainingWindowAttempts: 0,
        retryAfterMilliseconds:
          rateExerciseVariant === 'backoff-mismatch' ? 501 : 500,
        provenance: budgetStopProvenance,
      })
      const budgetMac = createRateRecordMac(budgetPayload)
      events.push(Object.freeze({ ...budgetPayload, mac: budgetMac }))
      terminalRecordMac = budgetMac
      if (rateExerciseVariant === 'after-stop-event') {
        const afterStopPayload = Object.freeze({
          version: 2,
          eventSequence: firstEventSequence + events.length,
          offsetMilliseconds: 350,
          previousRecordMac: terminalRecordMac,
          kind: 'cadence-wait',
          phase,
          delayMilliseconds: 25,
        })
        const afterStopMac = createRateRecordMac(afterStopPayload)
        events.push(Object.freeze({
          ...afterStopPayload,
          mac: afterStopMac,
        }))
        terminalRecordMac = afterStopMac
      }
    }
    const canonicalText = [header, ...events]
      .map((record) => `${serializeCanonicalJson(record)}\n`)
      .join('')
    const bytes = new TextEncoder().encode(canonicalText)
    const segmentDigest = createHash('sha256').update(bytes).digest('hex')
    const eventCount = events.length
    fixtures.push(Object.freeze({
      bytes,
      anchorUtc,
      binding: Object.freeze({
        authenticationKeyFingerprint,
        segmentLocatorDigest,
        segmentOrdinal,
        firstEventSequence,
        eventCount,
        firstCommittedEventSequence: firstEventSequence,
        lastCommittedEventSequence: firstEventSequence + eventCount - 1,
        terminalRecordMac,
        segmentDigest,
      }),
      firstAttemptSequence,
      attemptCount,
    }))
    previousSegmentDigest = segmentDigest
    previousRecordMac = terminalRecordMac
    firstEventSequence += eventCount
    firstAttemptSequence += attemptCount
  }
  return Object.freeze(fixtures)
}

/**
 * Finalizes one fresh authenticated complete rate stream.
 *
 * @param segments - Exact ordered raw rate-segment fixtures.
 * @param rateExerciseVariant - Optional authenticated negative-path variant.
 * @returns Genuine one-shot finalized rate evidence.
 */
function createFinalizedRate(
  segments: readonly RateSegmentFixture[],
  rateExerciseVariant?:
    AuthenticWorkspaceSearchMigrationRehearsalSuiteFixtureOptions[
      'rateExerciseVariant'
    ],
): WorkspaceSearchMigrationRehearsalFinalizedRateEvidence {
  const finalPublicationRemoved = segments.length === 49 &&
    rateExerciseVariant !== 'early-injection' &&
    rateExerciseVariant !== 'two-injections'
  const rehearsalThrottleCount = finalPublicationRemoved ||
      rateExerciseVariant === 'zero-injection' ||
      rateExerciseVariant === 'aws-service-substitution' ||
      rateExerciseVariant === 'source-mismatch'
    ? 0
    : rateExerciseVariant === 'two-injections'
    ? 2
    : 1
  const awsServiceThrottleCount =
    rateExerciseVariant === 'aws-service-substitution' ||
      rateExerciseVariant === 'source-mismatch'
      ? 1
      : 0
  const awsServiceThrottleBudgetStopCount =
    rateExerciseVariant === 'aws-service-substitution' ? 1 : 0
  const rehearsalBudgetStopCount = finalPublicationRemoved ||
      rateExerciseVariant === 'zero-injection' ||
      rateExerciseVariant === 'aws-service-substitution'
    ? 0
    : rateExerciseVariant === 'two-injections'
    ? 2
    : 1
  const cadenceWaitCount =
    rateExerciseVariant === 'nonconsecutive' ||
      rateExerciseVariant === 'after-stop-event'
      ? 1
      : 0
  return finalizeWorkspaceSearchMigrationRehearsalRateEvidence({
    segments: segments.map((segment) => segment.bytes),
    authenticationKey: copyKey(rateAuthenticationKey),
    expectedPolicyVersion: ratePolicyVersion,
    expectedConfigurationBindingDigest: configurationHash,
    durableEvidence: {
      version: 2,
      policyVersion: ratePolicyVersion,
      attemptCount: segments.reduce(
        (count, segment) => count + segment.attemptCount,
        0,
      ),
      forfeitedAttemptCount: 0,
      throttleCount: awsServiceThrottleCount + rehearsalThrottleCount,
      awsServiceThrottleCount,
      rehearsalInjectedThrottleCount: rehearsalThrottleCount,
      budgetStopCount:
        awsServiceThrottleBudgetStopCount + rehearsalBudgetStopCount,
      operationalBudgetStopCount: 0,
      awsServiceThrottleBudgetStopCount,
      rehearsalInjectedBudgetStopCount: rehearsalBudgetStopCount,
      cadenceWaitCount,
      cadenceWaitMilliseconds: cadenceWaitCount * 25,
      maximumInFlight: 1,
    },
  })
}

/** Returns one required manifest entry for a scenario and command. */
function requireManifestEntry(
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  command: WorkspaceSearchMigrationRehearsalStageCommand,
): WorkspaceSearchMigrationRehearsalStageManifestEntry {
  const entry = entries.find(
    (candidate) =>
      candidate.scenario === scenario && candidate.command === command,
  )
  if (entry === undefined) throw new Error('Expected manifest entry.')
  return entry
}

/** Creates stable keyed physical-resource identities for one #163 pair. */
function createIntegrityResourceIdentities():
readonly CrossDomainIntegrityResourceIdentity[] {
  return Object.freeze(integrityResourceIdentities.map((identity) =>
    Object.freeze({ ...identity })
  ))
}

/** Creates the exact private physical-resource attestation used by #163. */
function createIntegrityResourceAttestation():
CrossDomainIntegrityResourceAttestation {
  const account = '123456789012'
  const region = 'ap-northeast-1'
  const tableNames = [
    'audit-events-suite-finalizer-table',
    'file-proofing-suite-finalizer-table',
    'project-directory-suite-finalizer-table',
    'work-item-configuration-suite-finalizer-table',
    'work-items-suite-finalizer-table',
    'workspace-access-suite-finalizer-table',
  ]
  return {
    kind: 'mukuroji-cross-domain-integrity-resource-attestation',
    version: 1,
    scheme: CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    account,
    region,
    bucket: {
      target: 'bucket:file',
      bucketName: 'mukuroji-suite-finalizer-files',
      marker: {
        key: CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
        versionId: 'suite-finalizer-marker-version-1',
        checksumSha256: Buffer.alloc(32, 0x61).toString('base64'),
        size: 128,
      },
    },
    tables: CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS.map(
      (target, index) => {
        const tableName = tableNames[index] ?? ''
        return {
          target,
          tableName,
          tableArn:
            `arn:aws:dynamodb:${region}:${account}:table/${tableName}`,
          tableId: `immutable-suite-finalizer-table-id-${index + 1}`,
          creationTime: `2026-01-0${index + 1}T00:00:00.000Z`,
        }
      },
    ),
  }
}

/** Returns the deterministic target-audit file identity for one rollback side. */
function createTargetContentDigest(
  scenario: 'complete-apply-rollback' | 'partial-apply-rollback',
  side: 'preimage' | 'restored',
): string {
  return digest(`target-audit-content:${scenario}:${side}`)
}

/** Creates one complete apply evidence projection shared by audit and receipt. */
function createApplyStageEvidence(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalApplyStageEvidence {
  const scenario = entry.scenario
  return Object.freeze({
    kind: 'apply-complete',
    executionRunDigest: digest(`execution:${scenario}`),
    planDigest: digest(`plan:${scenario}`),
    sealedPlanOperationCount: 3,
    appliedOperationCount: 3,
    appliedRootDigest: digest(`applied:${scenario}`),
    targetPreimageArtifactContentDigest:
      scenario === 'complete-apply-rollback'
        ? createTargetContentDigest(scenario, 'preimage')
        : null,
    appliedAt: stageTimestamp(entry.ordinal, 10),
  })
}

/** Returns one scenario's exact auxiliary rate positions. */
function requireAuxiliaryRateOrdinals(
  layout: RateLayout,
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): ScenarioAuxiliaryRateOrdinals {
  const value = layout.auxiliaryOrdinals.get(scenario)
  if (value === undefined) throw new Error('Expected auxiliary rate layout.')
  return value
}

/** Creates a fresh one-shot successor proof for one global auxiliary segment. */
function createAuxiliaryRateInput(
  rateSegments: readonly RateSegmentFixture[],
  successorOrdinal: number,
  completedAt: string,
) {
  const predecessor = rateSegments[successorOrdinal - 1]
  const successor = rateSegments[successorOrdinal]
  if (predecessor === undefined || successor === undefined) {
    throw new Error('Expected adjacent auxiliary rate segments.')
  }
  return Object.freeze({
    verifiedSuccessor:
      verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
        predecessorSegmentBytes: predecessor.bytes,
        successorSegmentBytes: successor.bytes,
        authenticationKey: copyKey(rateAuthenticationKey),
        expectedPolicyVersion: ratePolicyVersion,
        expectedConfigurationBindingDigest: configurationHash,
      }),
    durableEvidence: Object.freeze({
      version: 2,
      policyVersion: ratePolicyVersion,
      attemptCount: successor.attemptCount,
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
}

/** Creates one finalized target-owned auxiliary rate binding. */
function createAuxiliaryRateEvidence(
  rateSegments: readonly RateSegmentFixture[],
  successorOrdinal: number,
  completedAt: string,
): WorkspaceSearchMigrationRehearsalRateSegmentEvidence {
  return finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
    createAuxiliaryRateInput(rateSegments, successorOrdinal, completedAt),
  )
}

/** Creates one genuine rate-bound two-pass #163 result for a global segment. */
async function createGenuineRateBoundIntegrityResult(
  rateSegments: readonly RateSegmentFixture[],
  successorOrdinal: number,
): Promise<WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult> {
  const predecessor = rateSegments[successorOrdinal - 1]
  const segment = rateSegments[successorOrdinal]
  if (
    predecessor === undefined ||
    segment === undefined ||
    segment.attemptCount !== 12
  ) {
    throw new Error('Expected exact live integrity rate segment.')
  }
  const startedAt = segment.anchorUtc
  const completedAt = new Date(Date.parse(startedAt) + 1_100).toISOString()
  const adapter = createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter({
    tableNames: createIntegrityTableNames(),
    tablePassCount: 2,
    baseTransport: createUnusedIntegrityTransport(),
    rate: createIntegrityManagedRate(segment),
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
      digestKey: integrityAuthenticationKey,
      resourceBindingDigest:
        calculateCrossDomainIntegrityResourceBindingDigest(),
      resourceIdentities: createIntegrityResourceIdentities(),
      resourceIdentityDigest: integrityResourceIdentityDigest,
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
      canonicalSegmentBytes: new Uint8Array(segment.bytes),
      authenticationKey: copyKey(rateAuthenticationKey),
      predecessorSegmentBytes: new Uint8Array(predecessor.bytes),
      expectedPolicyVersion: ratePolicyVersion,
      expectedConfigurationBindingDigest: configurationHash,
      expectedStartedAt: startedAt,
      expectedCompletedAt: completedAt,
      sequence,
      taskResult: result,
    })
  return finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult({
    rateBinding,
    result,
    resourceAttestation: integrityResourceAttestation,
    integrityDigestKey: copyKey(integrityAuthenticationKey),
    rateAuthenticationKey: copyKey(rateAuthenticationKey),
    expectedResourceIdentityDigest: integrityResourceIdentityDigest,
    clock: () => new Date(completedAt),
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

/** Creates a minimal managed rate owner aligned to one raw global segment. */
function createIntegrityManagedRate(
  segment: RateSegmentFixture,
): WorkspaceSearchMigrationManagedDescribeTableRate {
  let attemptCount = segment.firstAttemptSequence - 1
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
    readEvidence: () => createIntegrityRateEvidence(attemptCount),
    /** Reads the exact final cumulative attempt count. */
    async closeAndReadEvidence() {
      return createIntegrityRateEvidence(attemptCount)
    },
    /** Leaves the fixture lifecycle unchanged. */
    async close(): Promise<void> {},
  }
}

/** Creates one clean cumulative managed-rate aggregate. */
function createIntegrityRateEvidence(
  attemptCount: number,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  return {
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion: ratePolicyVersion,
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

/** Creates the unused transport retained behind the managed live adapter. */
function createUnusedIntegrityTransport(): CrossDomainIntegrityAwsTransport {
  return {
    /** No-op fixture close. */
    close(): void {},
    /** Rejects every forbidden base DescribeTable fallback. */
    async describeTable(): Promise<DescribeTableCommandOutput> {
      throw new Error('Forbidden suite integrity DescribeTable fallback.')
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

/** Creates the scenario-specific authenticated integrity collector projection. */
function createReconciliationIntegrity(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  aggregateDigest: string,
  targetAudits: WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null,
  verifiedIntegrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult | null,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult {
  const scenario = context.scenario
  const rollback = scenario === 'partial-apply-rollback' ||
    scenario === 'complete-apply-rollback'
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
  const purpose = scenario === 'partial-apply-rollback'
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
    targetPreimageAggregateDigest: aggregateDigest,
    targetRestoredAggregateDigest: aggregateDigest,
    targetPreimageStatus: 'equal',
  })
}

/** Creates both actual rollback target summaries with distinct rate segments. */
async function createReconciliationTargetAudits(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  aggregateDigest: string,
  planningEntry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  terminalEntry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  layout: RateLayout,
  rateSegments: readonly RateSegmentFixture[],
): Promise<
  WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null
> {
  const scenario = context.scenario
  if (
    scenario !== 'partial-apply-rollback' &&
    scenario !== 'complete-apply-rollback'
  ) return null
  const ordinals = requireAuxiliaryRateOrdinals(layout, scenario)
  if (ordinals.preimage === null || ordinals.restored === null) {
    throw new Error('Expected rollback target rate positions.')
  }
  const prefix = scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : 'complete-rollback'
  const targetContext: WorkspaceSearchMigrationRehearsalTargetAuditContext =
    Object.freeze({
      scenario,
      runLocatorDigest: context.runLocatorDigest,
      manifestDigest: digest(`target-manifest:${scenario}`),
      permitDigest,
      requestedResourcesBinding,
      configurationBindingDigest: context.configurationBindingDigest,
      policyVersion: context.policyVersion,
      integrityResourceIdentityDigest:
        context.integrityResourceIdentityDigest,
      planningReceiptDigest: digest(`planning-receipt:${scenario}`),
      executionBoundaryDigest: context.applyBoundaryDigest,
      sealedPlanningAuthorityDigest:
        context.sealedPlanningAuthorityDigest,
      planDigest: context.planDigest,
      writerFenceDigest: digest(`writer-fence:${scenario}`),
    })
  const contextDigest = createMigrationDigest(targetContext)
  const preimageIntegrity =
    consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
      await createGenuineRateBoundIntegrityResult(
        rateSegments,
        ordinals.preimage,
      ),
    )
  const restoredIntegrity =
    consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
      await createGenuineRateBoundIntegrityResult(
        rateSegments,
        ordinals.restored,
      ),
    )
  const terminal: WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding =
    scenario === 'partial-apply-rollback'
    ? Object.freeze({
        scenario: 'partial-apply-rollback',
        kind: 'rolled-back',
        version: 2,
        rootDigest: context.terminalRootDigest,
        applyStartedAt: stageTimestamp(planningEntry.ordinal + 1, 0),
        terminalAt: context.terminalAt,
      })
    : Object.freeze({
        scenario: 'complete-apply-rollback',
        kind: 'rolled-back',
        version: 1,
        rootDigest: context.terminalRootDigest,
        applyStartedAt: stageTimestamp(planningEntry.ordinal + 1, 0),
        terminalAt: context.terminalAt,
      })
  return Object.freeze({
    preimage: Object.freeze({
      purpose: `${prefix}-preimage`,
      contentDigest: createTargetContentDigest(scenario, 'preimage'),
      byteLength: 2_048,
      startedAt: stageTimestamp(planningEntry.ordinal, 20.15),
      observedAt: stageTimestamp(planningEntry.ordinal, 20.2),
      observationDigest: digest(`target-observation:${scenario}:preimage`),
      aggregateDigest,
      contextDigest,
      context: targetContext,
      terminal: null,
      integrity: preimageIntegrity,
      rate: createAuxiliaryRateEvidence(
        rateSegments,
        ordinals.preimage,
        stageTimestamp(planningEntry.ordinal, 20.4),
      ),
    }),
    restored: Object.freeze({
      purpose: `${prefix}-restored`,
      contentDigest: createTargetContentDigest(scenario, 'restored'),
      byteLength: 2_049,
      startedAt: stageTimestamp(terminalEntry.ordinal, 18.53),
      observedAt: stageTimestamp(terminalEntry.ordinal, 18.55),
      observationDigest: digest(`target-observation:${scenario}:restored`),
      aggregateDigest,
      contextDigest,
      context: targetContext,
      terminal,
      integrity: restoredIntegrity,
      rate: createAuxiliaryRateEvidence(
        rateSegments,
        ordinals.restored,
        stageTimestamp(terminalEntry.ordinal, 19),
      ),
    }),
  })
}

/** Creates one internally consistent actual terminal reconciliation collector. */
async function createReconciliationCollector(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
  layout: RateLayout,
  rateSegments: readonly RateSegmentFixture[],
): Promise<PreparedReconciliationCollector> {
  const planningEntry = requireManifestEntry(entries, scenario, 'close-replan')
  const applyEntry = entries.filter(
    (entry) => entry.scenario === scenario && entry.command === 'apply',
  ).at(-1)
  if (applyEntry === undefined) throw new Error('Expected apply boundary entry.')
  const terminalCommand = scenario === 'partial-apply-rollback'
    ? 'rollback-partial'
    : scenario === 'complete-apply-rollback'
    ? 'rollback-complete'
    : 'verify'
  const terminalEntry = requireManifestEntry(entries, scenario, terminalCommand)
  const partial = scenario === 'partial-apply-rollback'
  const rollback = partial || scenario === 'complete-apply-rollback'
  const applyBoundaryDigest = partial
    ? digest(`partial-origin:${scenario}`)
    : createApplyStageEvidence(applyEntry).appliedRootDigest
  const context = Object.freeze({
    scenario,
    runLocatorDigest: digest(`run:${scenario}`),
    configurationBindingDigest: configurationHash,
    policyVersion: ratePolicyVersion,
    integrityResourceIdentityDigest,
    sealedPlanningAuthorityDigest: digest(`authority:${scenario}`),
    executionRunDigest: digest(`execution:${scenario}`),
    planDigest: digest(`plan:${scenario}`),
    applyBoundaryDigest,
    terminalRootKind: rollback ? 'rolled-back' : 'verified',
    terminalRootVersion: partial ? 2 : 1,
    terminalRootDigest: digest(`terminal:${scenario}`),
    sealedPlanOperationCount: 3,
    appliedOperationCount: partial ? 1 : 3,
    terminalAt: stageTimestamp(terminalEntry.ordinal, 10),
    checkedAt: stageTimestamp(terminalEntry.ordinal, 20.25),
  }) satisfies WorkspaceSearchMigrationRehearsalReconciliationCoreContext
  const aggregateDigest = digest(`source-target-aggregate:${scenario}`)
  const targetAudits = await createReconciliationTargetAudits(
    context,
    aggregateDigest,
    planningEntry,
    terminalEntry,
    layout,
    rateSegments,
  )
  const verifiedIntegrity = rollback
    ? null
    : await createGenuineRateBoundIntegrityResult(
        rateSegments,
        requireAuxiliaryRateOrdinals(layout, scenario).reconciliation,
      )
  const markerDigest = digest(`marker-aggregate:${scenario}`)
  const authorityDigest = digest(`authority-chain:${scenario}`)
  return Object.freeze({
    collectorResult: Object.freeze({
      context,
      integrity: createReconciliationIntegrity(
        context,
        aggregateDigest,
        targetAudits,
        verifiedIntegrity,
      ),
      targetAudits,
      markerSummary: Object.freeze({
        expectedCount: context.appliedOperationCount,
        expectedAggregateDigest: markerDigest,
        observedCount: context.appliedOperationCount,
        observedAggregateDigest: markerDigest,
        matchedCount: context.appliedOperationCount,
        duplicateCount: 0,
        missingCount: 0,
        unexpectedCount: 0,
      }),
      authoritySummary: Object.freeze({
        expectedChainDigest: authorityDigest,
        observedChainDigest: authorityDigest,
        expectedCount: 4,
        observedCount: 4,
        matchedCount: 4,
        missingCount: 0,
        orphanCount: 0,
      }),
      sourceTargetSummary: Object.freeze({
        expectedAggregateDigest: aggregateDigest,
        observedAggregateDigest: aggregateDigest,
        expectedCount: context.appliedOperationCount,
        observedCount: context.appliedOperationCount,
        matchedCount: context.appliedOperationCount,
        lostCount: 0,
        unexpectedCount: 0,
      }),
    }),
    verifiedIntegrity,
  })
}

/** Creates eight genuine v3 dual-key artifacts from live rate authority. */
async function createReconciliationArtifacts(
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
  layout: RateLayout,
  rateSegments: readonly RateSegmentFixture[],
): Promise<ReadonlyMap<
  WorkspaceSearchMigrationRehearsalScenarioName,
  ReconciliationArtifactFixture
>> {
  const artifacts = new Map<
    WorkspaceSearchMigrationRehearsalScenarioName,
    ReconciliationArtifactFixture
  >()
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const terminalCommand = scenario === 'partial-apply-rollback'
      ? 'rollback-partial'
      : scenario === 'complete-apply-rollback'
      ? 'rollback-complete'
      : 'verify'
    const terminalEntry = requireManifestEntry(entries, scenario, terminalCommand)
    const reconciliationOrdinal =
      requireAuxiliaryRateOrdinals(layout, scenario).reconciliation
    const prepared = await createReconciliationCollector(
      scenario,
      entries,
      layout,
      rateSegments,
    )
    const finalized =
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact({
        collectorResult: prepared.collectorResult,
        rate: createAuxiliaryRateInput(
          rateSegments,
          reconciliationOrdinal,
          stageTimestamp(terminalEntry.ordinal, 20.5),
        ),
        verifiedIntegrity: prepared.verifiedIntegrity,
      }, copyKey(rateAuthenticationKey), copyKey(reconciliationPublicationKey))
    const bytes = new Uint8Array(finalized.canonicalBytes)
    const binding =
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes(
        bytes,
        copyKey(rateAuthenticationKey),
        copyKey(reconciliationPublicationKey),
      )
    artifacts.set(scenario, Object.freeze({ bytes, binding }))
  }
  return artifacts
}

/** Creates a fresh batch capability over genuine deterministic artifacts. */
function createReconciliationFixtureFromArtifacts(
  source: ReadonlyMap<
    WorkspaceSearchMigrationRehearsalScenarioName,
    ReconciliationArtifactFixture
  >,
): ReconciliationFixture {
  const artifacts = new Map<
    WorkspaceSearchMigrationRehearsalScenarioName,
    ReconciliationArtifactFixture
  >()
  const expectations: {
    artifactBytes: Uint8Array
    expectedContext:
      WorkspaceSearchMigrationRehearsalReconciliationAuditContext
  }[] = []
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    const cached = source.get(scenario)
    if (cached === undefined) throw new Error('Expected cached audit artifact.')
    const bytes = new Uint8Array(cached.bytes)
    artifacts.set(scenario, Object.freeze({
      bytes,
      binding: cached.binding,
    }))
    expectations.push(Object.freeze({
      artifactBytes: new Uint8Array(bytes),
      expectedContext: createReconciliationContextProjection(cached.binding),
    }))
  }
  const capability =
    finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence({
      artifacts: expectations,
    }, copyKey(rateAuthenticationKey), copyKey(reconciliationPublicationKey))
  return Object.freeze({ artifacts, capability })
}

/** Creates a fresh batch capability over cached happy-path artifacts. */
function createReconciliationFixture(): ReconciliationFixture {
  return createReconciliationFixtureFromArtifacts(
    cachedReconciliationArtifacts,
  )
}

/** Generates the deterministic genuine artifact cache once per test process. */
async function createCachedReconciliationArtifacts(): Promise<ReadonlyMap<
  WorkspaceSearchMigrationRehearsalScenarioName,
  ReconciliationArtifactFixture
>> {
  const rootSegment = createIntegrityAttestationRootSegment()
  const manifest = createManifestClaims(
    createIntegrityAttestationRootProjection(rootSegment),
  )
  const layout = createRateLayout(manifest.entries)
  const rateSegments = createRateSegments(layout, 'measurement', rootSegment)
  return await createReconciliationArtifacts(
    manifest.entries,
    layout,
    rateSegments,
  )
}

/** Genuine deterministic reconciliation bytes reusable across fresh batches. */
const cachedReconciliationArtifacts =
  await createCachedReconciliationArtifacts()

/** Maps one fault scenario to its exact runtime failpoint. */
function fixtureFailpoint(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence['failpoint'] {
  switch (scenario) {
    case 'cursor-before-commit-kill':
      return 'apply-checkpoint-cursor-captured-before-commit'
    case 'cursor-after-commit-kill':
      return 'apply-checkpoint-cursor-committed-before-return'
    case 'artifact-before-checkpoint-kill':
      return 'planning-page-artifact-uploaded-before-checkpoint-commit'
    case 'transaction-response-loss':
      return 'planning-page-transaction-response-lost'
    case 'lease-expiry-takeover':
      return 'lease-acquired-before-first-heartbeat'
    case 'partial-apply-rollback':
      return 'apply-operation-committed-before-return'
    case 'complete-apply-rollback':
    case 'happy-path-verified':
      throw new Error('Expected faulted fixture scenario.')
  }
}

/**
 * Creates one complete secret-free fault observation for suite fixtures.
 *
 * @param entry - Exact fault-bearing manifest entry.
 * @returns Failpoint-specific normalized adapter observation.
 */
function createFaultObservation(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalFaultObservation {
  const scenario = entry.scenario
  const failpoint = fixtureFailpoint(scenario)
  const leaseIdentityDigest =
    digest(`lease:${scenario}:${entry.attemptOrdinal}`)
  const common = {
    leaseIdentityDigest,
  }
  if (
    failpoint ===
      'planning-page-artifact-uploaded-before-checkpoint-commit' ||
    failpoint === 'planning-page-transaction-response-lost'
  ) {
    const committed =
      failpoint === 'planning-page-transaction-response-lost'
    return Object.freeze({
      ...common,
      observationVersion: 1,
      kind: 'planning-page',
      failpoint,
      durableAppliedOperationCount: 0,
      sealedPlanOperationCount: null,
      closedWriterFenceRecordDigest: digest(`closed-fence:${scenario}`),
      durableHeadPosition: committed ? 'committed-successor' : 'predecessor',
      durableHeadPageSequence: committed ? 2 : 1,
      durableHeadEvidenceDigest: digest(`fault-head-evidence:${scenario}`),
      durableHeadCheckpointDigest:
        digest(`fault-head-checkpoint:${scenario}`),
      durableHeadProgressDigest: digest(`fault-head-progress:${scenario}`),
      durableHeadCursorState: 'present',
      durableHeadCompleted: false,
      planningTarget: Object.freeze({
        kind: 'source',
        source: 'documents',
        pageSequence: 2,
        cursorState: 'present',
      }),
    })
  }
  if (
    failpoint === 'apply-checkpoint-cursor-captured-before-commit' ||
    failpoint === 'apply-checkpoint-cursor-committed-before-return'
  ) {
    const committed =
      failpoint === 'apply-checkpoint-cursor-committed-before-return'
    return Object.freeze({
      ...common,
      observationVersion: 1,
      kind: 'apply-checkpoint',
      failpoint,
      durableAppliedOperationCount: 3,
      sealedPlanOperationCount: 3,
      closedWriterFenceRecordDigest: digest(`closed-fence:${scenario}`),
      checkpointLocation: 'documents',
      durableStatePosition: committed ? 'committed-successor' : 'predecessor',
      durableStateRevision: entry.ordinal * 2,
      durableStateStatus: 'applying',
      durableRunStateDigest: digest(`fault-run-state:${scenario}`),
      durableCheckpointDigest: digest(`fault-checkpoint:${scenario}`),
      durableCheckpointPageSequence: committed ? 2 : 1,
      durableCheckpointCursorState: 'present',
      durableCheckpointCompleted: false,
    })
  }
  if (failpoint === 'apply-operation-committed-before-return') {
    const runStateDigest = digest(`fault-run-state:${scenario}`)
    return Object.freeze({
      ...common,
      observationVersion: 1,
      kind: 'apply-operation',
      failpoint,
      durableAppliedOperationCount: 1,
      sealedPlanOperationCount: 3,
      closedWriterFenceRecordDigest: digest(`closed-fence:${scenario}`),
      returnedStateRevision: entry.ordinal * 2,
      returnedRunStateDigest: runStateDigest,
      returnedAppliedOperationCount: 1,
      returnedSealedPlanOperationCount: 3,
      durableStateRevision: entry.ordinal * 2,
      durableStateStatus: 'applying',
      durableRunStateDigest: runStateDigest,
    })
  }
  if (failpoint !== 'lease-acquired-before-first-heartbeat') {
    throw new Error('Expected a fault observation fixture.')
  }
  return Object.freeze({
    ...common,
    observationVersion: 1,
    kind: 'lease',
    failpoint,
    durableAppliedOperationCount: 0,
    sealedPlanOperationCount: null,
    closedWriterFenceRecordDigest: null,
  })
}

/** Creates one exact cursor-free fault boundary. */
function createFaultEvidence(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  targetPreimageArtifactContentDigest: string | null,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence {
  const failpoint = fixtureFailpoint(entry.scenario)
  const planningFault =
    failpoint ===
      'planning-page-artifact-uploaded-before-checkpoint-commit' ||
    failpoint === 'planning-page-transaction-response-lost' ||
    failpoint === 'lease-acquired-before-first-heartbeat'
  const faultObservation = createFaultObservation(entry)
  return Object.freeze({
    kind: 'fault-boundary',
    failpoint,
    targetDigest: digest(`fault-target:${entry.scenario}`),
    faultReceiptDigest: digest(`fault-receipt:${entry.scenario}`),
    faultObservationDigest: createMigrationDigest(faultObservation),
    faultObservation,
    leaseIdentityDigest:
      digest(`lease:${entry.scenario}:${entry.attemptOrdinal}`),
    appliedOperationCount: planningFault
      ? 0
      : failpoint === 'apply-operation-committed-before-return'
      ? 1
      : 3,
    sealedPlanOperationCount: planningFault ? null : 3,
    targetPreimageArtifactContentDigest:
      failpoint === 'apply-operation-committed-before-return'
        ? targetPreimageArtifactContentDigest
        : null,
    reachedAt: stageTimestamp(entry.ordinal, 4),
  })
}

/** Creates the strict context projection already authenticated by an artifact. */
function createReconciliationContextProjection(
  binding: WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
): WorkspaceSearchMigrationRehearsalReconciliationAuditContext {
  return Object.freeze({
    scenario: binding.scenario,
    runLocatorDigest: binding.runLocatorDigest,
    configurationBindingDigest: binding.configurationBindingDigest,
    policyVersion: binding.policyVersion,
    integrityResourceIdentityDigest:
      binding.integrityResourceIdentityDigest,
    sealedPlanningAuthorityDigest: binding.sealedPlanningAuthorityDigest,
    executionRunDigest: binding.executionRunDigest,
    planDigest: binding.planDigest,
    applyBoundaryDigest: binding.applyBoundaryDigest,
    terminalRootKind: binding.terminalRootKind,
    terminalRootVersion: binding.terminalRootVersion,
    terminalRootDigest: binding.terminalRootDigest,
    sealedPlanOperationCount: binding.sealedPlanOperationCount,
    appliedOperationCount: binding.appliedOperationCount,
    terminalAt: binding.terminalAt,
    checkedAt: binding.checkedAt,
    integrity: binding.integrity,
    targetAudits: binding.targetAudits,
  })
}

/** Creates one exact trusted durable stage evidence projection. */
function createStageEvidence(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  reconciliation: ReconciliationFixture,
): WorkspaceSearchMigrationRehearsalStageEvidence {
  const scenario = entry.scenario
  if (entry.command === 'close-replan') {
    return Object.freeze({
      kind: 'planning-sealed',
      executionBoundaryDigest: digest(`boundary:${scenario}`),
      closedWriterFenceRecordDigest: digest(`closed-fence:${scenario}`),
      sealedPlanningAuthorityDigest: digest(`authority:${scenario}`),
      planDigest: digest(`plan:${scenario}`),
      sealedPlanOperationCount: 3,
      sourceOperationCount: 2,
      orphanOperationCount: 1,
      closedAt: stageTimestamp(entry.ordinal, 1),
      drainStartedAt: stageTimestamp(entry.ordinal, 1.25),
      drainCompletedAt: stageTimestamp(entry.ordinal, 16.25),
      admittedAt: stageTimestamp(entry.ordinal, 16.5),
      planCreatedAt: stageTimestamp(entry.ordinal, 17),
      sealedAt: stageTimestamp(entry.ordinal, 17.5),
    })
  }
  if (entry.command === 'apply') return createApplyStageEvidence(entry)
  if (entry.command === 'release') {
    const rollback = scenario === 'partial-apply-rollback' ||
      scenario === 'complete-apply-rollback'
    return Object.freeze({
      kind: 'released',
      terminalKind: rollback ? 'rolled-back' : 'verified',
      terminalPersistenceVersion:
        scenario === 'partial-apply-rollback' ? 2 : 1,
      terminalRootDigest: digest(`terminal:${scenario}`),
      releasedWriterFenceRecordDigest: digest(`released-fence:${scenario}`),
      releasedAt: stageTimestamp(entry.ordinal, 10),
    })
  }
  const artifact = reconciliation.artifacts.get(scenario)
  if (artifact === undefined) {
    throw new Error('Expected actual reconciliation artifact fixture.')
  }
  const binding = artifact.binding
  const integrity = binding.integrity
  const targetAudits = binding.targetAudits
  const rollback = integrity.kind === 'rollback-comparison'
  const integrityPurpose = rollback ? integrity.purpose : 'verified'
  const integrityBeforeResultDigest = rollback
    ? integrity.before.resultDigest
    : null
  const integrityAfterResultDigest = rollback
    ? integrity.after.resultDigest
    : integrity.result.result.resultDigest
  const integrityComparisonDigest = rollback
    ? integrity.comparisonDigest
    : null
  const integrityContextDigest = rollback
    ? integrity.comparisonContextDigest
    : integrity.resultContextDigest
  const targetPreimageArtifactContentDigest =
    targetAudits?.preimage.contentDigest ?? null
  const targetRollbackArtifactContentDigest =
    targetAudits?.restored.contentDigest ?? null
  const targetRollbackObservationDigest =
    targetAudits?.restored.observationDigest ?? null
  return Object.freeze({
    kind: 'terminal',
    command: entry.command,
    terminalKind: binding.terminalRootKind,
    terminalPersistenceVersion: binding.terminalRootVersion,
    terminalRootDigest: binding.terminalRootDigest,
    executionBoundaryDigest: digest(`boundary:${scenario}`),
    sealedPlanningAuthorityDigest: binding.sealedPlanningAuthorityDigest,
    executionRunDigest: binding.executionRunDigest,
    planDigest: binding.planDigest,
    sealedPlanOperationCount: binding.sealedPlanOperationCount,
    appliedOperationCount: binding.appliedOperationCount,
    integrityPurpose,
    integrityBeforeResultDigest,
    integrityAfterResultDigest,
    integrityComparisonDigest,
    integrityContextDigest,
    targetRollbackArtifactContentDigest,
    targetRollbackObservationDigest,
    duplicateApplyCount: 0,
    lostItemCount: 0,
    orphanAuthorityCount: 0,
    reconciliationContext: createReconciliationContextProjection(binding),
    reconciliationArtifactBindingDigest: createMigrationDigest(binding),
    reconciliationArtifactContentDigest: binding.contentDigest,
    reconciliationArtifactByteLength: binding.byteLength,
    reconciliationArtifactAuditDigest: binding.auditDigest,
    reconciliationRate: binding.rate,
    reconciliationAuditDigest:
      createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest({
        scenario,
        terminalRootDigest: binding.terminalRootDigest,
        integrityContextDigest,
        targetPreimageArtifactContentDigest,
        targetRollbackArtifactContentDigest,
        targetRollbackObservationDigest,
        duplicateApplyCount: 0,
        lostItemCount: 0,
        orphanAuthorityCount: 0,
      }),
    terminalAt: binding.terminalAt,
  })
}

/** Creates one exact trusted parent lifecycle for a stage process. */
function createStageProcessLifecycle(
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalStageReceiptClaims['processLifecycle'] {
  const responseLoss = entry.expectedOutcome === 'response-loss-reconciled'
  const killed = entry.expectedOutcome === 'fault-reached'
  return Object.freeze({
    lifecycleDigest: digest(`process-lifecycle:${entry.ordinal}`),
    runnerStartedAt: stageTimestamp(entry.ordinal, 0),
    receiptObservedAt: stageTimestamp(entry.ordinal, responseLoss ? 15 : 18),
    receiptPersistedAt:
      stageTimestamp(entry.ordinal, responseLoss ? 16 : 18.5),
    parentDecisionRecordedAt: killed || responseLoss
      ? stageTimestamp(entry.ordinal, responseLoss ? 16.5 : 19)
      : null,
    processExitedAt: stageTimestamp(entry.ordinal, 20),
    exitClass: killed
      ? 'confirmed-sigkill'
      : responseLoss
      ? 'successful-response-loss'
      : 'successful-no-fault',
  })
}

/**
 * Creates one cycle-free lease observation with global receipt continuity.
 *
 * @param manifest - Authenticated manifest containing the predecessor entry.
 * @param entry - Exact current stage entry.
 * @returns Adapter-shaped lease observation for the fixture receipt.
 */
function createStageLeaseObservation(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalStageReceiptClaims['leaseObservation'] {
  const currentIdentity =
    digest(`lease:${entry.scenario}:${entry.attemptOrdinal}`)
  const previous = manifest.entries[entry.ordinal - 2]
  const installsLease = previous === undefined ||
    previous.scenario !== entry.scenario ||
    previous.attemptOrdinal !== entry.attemptOrdinal
  if (!installsLease) {
    return Object.freeze({
      kind: 'reused-active',
      currentLeaseIdentityDigest: currentIdentity,
      evaluatedAt: stageTimestamp(entry.ordinal, 0.25),
      currentLeaseExpiresAt: stageTimestamp(entry.ordinal, 60),
    })
  }
  return Object.freeze({
    kind: 'acquired',
    predecessorLeaseIdentityDigest: previous === undefined
      ? null
      : digest(`lease:${previous.scenario}:${previous.attemptOrdinal}`),
    predecessorLeaseExpiresAt: previous === undefined
      ? null
      : stageTimestamp(entry.ordinal, 0),
    acquiredAt: stageTimestamp(entry.ordinal, 1),
    successorLeaseIdentityDigest: currentIdentity,
    successorLeaseExpiresAt: stageTimestamp(entry.ordinal, 60),
  })
}

/** Creates all authentic stage receipts and their fresh chain capability. */
function createStageChain(
  manifestClaims: WorkspaceSearchMigrationRehearsalStageManifestClaims,
  layout: RateLayout,
  rateSegments: readonly RateSegmentFixture[],
  reconciliation: ReconciliationFixture,
): StageChainFixture {
  const manifest = createWorkspaceSearchMigrationRehearsalStageManifest({
    claims: manifestClaims,
    signingKey: copyKey(stageAuthenticationKey),
  })
  const manifestDigest = createMigrationDigest(manifest)
  const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
  let previousStageReceiptDigest: string | null = null
  for (const entry of manifest.entries) {
    const stage = fixtureStages(entry.scenario)[
      entry.scenarioStageOrdinal - 1
    ]
    const rateOrdinal = layout.stageOrdinals.get(entry.ordinal)
    const rateSegment = rateOrdinal === undefined
      ? undefined
      : rateSegments[rateOrdinal]
    if (stage === undefined || rateSegment === undefined) {
      throw new Error('Expected stage and rate fixtures.')
    }
    const faultBoundary = entry.faultPlanDigest === null
      ? null
      : createFaultEvidence(
          entry,
          entry.scenario === 'partial-apply-rollback'
            ? createTargetContentDigest(entry.scenario, 'preimage')
            : null,
        )
    const evidence = entry.expectedOutcome === 'fault-reached'
      ? faultBoundary ?? (() => {
          throw new Error('Expected fault boundary.')
        })()
      : createStageEvidence(entry, reconciliation)
    const faultReceiptDigest = faultBoundary?.faultReceiptDigest ??
      (entry.expectedOutcome === 'takeover-completed'
        ? digest(`fault-receipt:${entry.scenario}`)
        : null)
    const claims: WorkspaceSearchMigrationRehearsalStageReceiptClaims = {
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND,
      receiptVersion:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION,
      stage: 'non-production',
      scenario: entry.scenario,
      stageOrdinal: entry.ordinal,
      scenarioStageOrdinal: entry.scenarioStageOrdinal,
      command: entry.command,
      controlArgumentsDigest: entry.controlArgumentsDigest,
      serializedOutputLineDigest: digest(`output-line:${entry.ordinal}`),
      manifestDigest,
      manifestEntryDigest: createMigrationDigest(entry),
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
      runLocatorDigest: digest(`run:${entry.scenario}`),
      attemptOrdinal: entry.attemptOrdinal,
      attemptLocatorDigest:
        digest(`attempt:${entry.scenario}:${entry.attemptOrdinal}`),
      ownerLocatorDigest:
        digest(`owner:${entry.scenario}:${entry.attemptOrdinal}`),
      leaseIdentityDigest:
        digest(`lease:${entry.scenario}:${entry.attemptOrdinal}`),
      leaseObservation: createStageLeaseObservation(manifest, entry),
      expectedAuthorities: Object.freeze([]),
      writerFenceDigest: entry.command === 'release'
        ? digest(`released-fence:${entry.scenario}`)
        : digest(`closed-fence:${entry.scenario}`),
      previousStageReceiptDigest,
      stageReservationDigest: digest(`stage-reservation:${entry.ordinal}`),
      stageReservationClaimRevision: entry.ordinal * 2 - 1,
      stageReservationCommitRevision: entry.ordinal * 2,
      stageReservationAbandonmentCount: 0,
      stageReservationAbandonmentRootDigest:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
      startedAt: stageTimestamp(entry.ordinal, 0),
      completedAt: evidence.kind === 'terminal'
        ? evidence.reconciliationRate.completedAt
        : stageTimestamp(entry.ordinal, 18),
      processLifecycle: createStageProcessLifecycle(entry),
      outcome: entry.expectedOutcome,
      faultReceiptDigest,
      faultBoundary,
      predecessorLeaseExpiresAt:
        entry.expectedOutcome === 'takeover-completed'
          ? stageTimestamp(entry.ordinal, 0)
          : null,
      takeoverAcquiredAt:
        entry.expectedOutcome === 'takeover-completed'
          ? stageTimestamp(entry.ordinal, 1)
          : null,
      reconciledAt:
        entry.expectedOutcome === 'response-loss-reconciled'
          ? stageTimestamp(entry.ordinal, 17)
          : null,
      evidence,
      rateSegment: rateSegment.binding,
    }
    let receipt: WorkspaceSearchMigrationRehearsalStageReceipt
    try {
      receipt = createWorkspaceSearchMigrationRehearsalStageReceipt({
        claims,
        signingKey: copyKey(stageAuthenticationKey),
      })
    } catch {
      throw new Error(`Failed to create fixture stage receipt ${entry.ordinal}.`)
    }
    receipts.push(receipt)
    previousStageReceiptDigest = createMigrationDigest(receipt)
  }
  return Object.freeze({
    manifest,
    receipts: Object.freeze(receipts),
    capability: deriveWorkspaceSearchMigrationRehearsalStageChainEvidence({
      manifest,
      receipts,
      verificationKey: copyKey(stageAuthenticationKey),
    }),
  })
}

/** Creates one exact existing-recorder EMF line for alarm authentication. */
function createAlarmSignalLine(
  signal: WorkspaceSearchMigrationTelemetryRehearsalSignal,
  timestampMilliseconds: number,
  correlation: string,
): string {
  const output: string[] = []
  const errors: string[] = []
  const exitCode = runWorkspaceSearchMigrationTelemetryRehearsal([
    '--approval',
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_APPROVAL,
    '--stage',
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_STAGE,
    '--signal',
    signal,
    '--configuration-hash',
    configurationHash,
    '--policy-version',
    ratePolicyVersion,
  ], {
    createRecorder: (context, sink) =>
      createWorkspaceSearchMigrationTelemetryRecorder(context, {
        clock: () => timestampMilliseconds,
        sequence: () => 1,
        correlationSource: () => correlation,
        sink,
      }),
    writeStandardOutput: (line) => output.push(line),
    writeStandardError: (line) => errors.push(line),
  })
  const line = output[0]
  if (
    exitCode !== 0 ||
    line === undefined ||
    output.length !== 1 ||
    errors.length !== 0
  ) {
    throw new Error('Expected one exact alarm signal line.')
  }
  return line
}

/** Creates the purpose-specific alarm authorization bound to this suite. */
function createAlarmAuthorization():
WorkspaceSearchMigrationRehearsalAlarmAuthorization {
  return Object.freeze({
    permitDigest: digest('alarm-permit'),
    requestedResourcesBinding: digest('alarm-requested-resources'),
    sharedSessionBindingDigest:
      createWorkspaceSearchMigrationRehearsalAlarmSharedClaimsBinding({
        commit: fixtureCommit,
        callerAttestationDigest: attestation.callerAttestationDigest,
        productionIsolationDigest: attestation.productionIsolationDigest,
        resourceAttestationDigest: attestation.resourceAttestationDigest,
      }),
  })
}

/** Creates every authenticated prefix in the positive-plus-recovery chain. */
function createAlarmSignalPrefixes():
readonly WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact[] {
  const evidenceLocatorDigest =
    createWorkspaceSearchMigrationTelemetryRehearsalEvidenceLocatorDigest(
      configurationHash,
      ratePolicyVersion,
    )
  const offsets = [30_000, 60_000, 90_000, 120_000, 150_000, 600_000]
  let artifact:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact |
    undefined
  const artifacts:
    WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact[] = []
  for (const [index, signal] of
    WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_ORDER.entries()) {
    const offset = offsets[index]
    if (offset === undefined) throw new Error('Expected signal offset.')
    artifact =
      createWorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact({
        serializedEmfLine: createAlarmSignalLine(
          signal,
          Date.parse(fixtureStartedAt) + offset,
          String(index + 1).repeat(32),
        ),
        authorizationBindingDigest:
          createAlarmAuthorization().requestedResourcesBinding,
        evidenceLocatorDigest,
        ...(artifact === undefined ? {} : { previousArtifact: artifact }),
      }, copyKey(alarmSignalAuthenticationKey))
    artifacts.push(artifact)
  }
  if (artifact === undefined) throw new Error('Expected signal artifact.')
  return Object.freeze(artifacts)
}

/** Creates the complete authenticated positive-plus-recovery signal chain. */
function createAlarmSignalArtifact():
WorkspaceSearchMigrationTelemetryRehearsalSignalReceiptArtifact {
  const artifact = createAlarmSignalPrefixes().at(-1)
  if (artifact === undefined) throw new Error('Expected signal artifact.')
  return artifact
}

/** Creates the complete six-entry authenticated Logs ingestion chain. */
async function createAlarmIngestionArtifact():
Promise<WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact> {
  const port: WorkspaceSearchMigrationRehearsalAlarmLogIngestionPort = {
    /** Accepts one deterministic fixture event without external I/O. */
    async putLogEvent() {
      return undefined
    },
  }
  let artifact:
    WorkspaceSearchMigrationRehearsalAlarmIngestionArtifact | undefined
  for (const signalArtifact of createAlarmSignalPrefixes()) {
    const latest = signalArtifact.receipts.at(-1)
    if (latest === undefined) throw new Error('Expected signal receipt.')
    artifact = await ingestWorkspaceSearchMigrationRehearsalAlarmSignal({
      signalArtifact,
      ...(artifact === undefined ? {} : { previousArtifact: artifact }),
      target: alarmIngestionTarget,
      authorizationBindingDigest:
        createAlarmAuthorization().requestedResourcesBinding,
      verificationKey: copyKey(alarmSignalAuthenticationKey),
      requestTimeoutMilliseconds: 1_000,
    }, {
      port,
      clock: () => new Date(latest.timestampMilliseconds + 100),
    })
  }
  if (artifact === undefined) throw new Error('Expected ingestion artifact.')
  return artifact
}

/** Creates one real-transition, dual-delivery alarm projection. */
function createAlarm(
  name: WorkspaceSearchMigrationRehearsalAlarmName,
  index: number,
  signal: WorkspaceSearchMigrationTelemetryRehearsalSignalBinding,
): WorkspaceSearchMigrationRehearsalAlarmEvidence {
  if (signal.name !== name) throw new Error('Expected matching alarm signal.')
  const alarmObservedAt = new Date(
    Date.parse(signal.observedAt) + (index + 1) * 10_000,
  ).toISOString()
  const recoveredAt = timestamp(660_000 + index * 10_000)
  return Object.freeze({
    name,
    status: 'pass',
    initialState: 'OK',
    alarmState: 'ALARM',
    recoveredState: 'OK',
    alarmObservedAt,
    recoveredAt,
    signalDigest: signal.signalDigest,
    historyDigest: digest(`alarm-history:${name}`),
    primaryReceiptDigest: digest(`alarm-primary:${name}`),
    primaryReceivedAt: new Date(
      Date.parse(alarmObservedAt) + 2_000,
    ).toISOString(),
    secondaryReceiptDigest: digest(`alarm-secondary:${name}`),
    secondaryReceivedAt: new Date(
      Date.parse(alarmObservedAt) + 4_000,
    ).toISOString(),
  })
}

/** Creates exact twelve-receipt alarm delivery evidence. */
function createAlarmReceiptArtifact(
  alarms: readonly WorkspaceSearchMigrationRehearsalAlarmEvidence[],
): WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact {
  const receipts:
    WorkspaceSearchMigrationRehearsalAlarmReceiptArtifact['receipts'] =
    alarms.flatMap((alarm) => [{
      name: alarm.name,
      alarmIdentityDigest: digest(`alarm-identity:${alarm.name}`),
      route: 'primary',
      receivedAt: alarm.primaryReceivedAt,
      alarmObservedAt: alarm.alarmObservedAt,
      messageIdDigest: digest(`alarm-primary-message:${alarm.name}`),
      receiptDigest: alarm.primaryReceiptDigest,
    }, {
      name: alarm.name,
      alarmIdentityDigest: digest(`alarm-identity:${alarm.name}`),
      route: 'secondary',
      receivedAt: alarm.secondaryReceivedAt,
      alarmObservedAt: alarm.alarmObservedAt,
      messageIdDigest: digest(`alarm-secondary-message:${alarm.name}`),
      receiptDigest: alarm.secondaryReceiptDigest,
    }])
  return createWorkspaceSearchMigrationRehearsalAlarmReceiptArtifact({
    collectionBindingDigest:
      createAlarmAuthorization().requestedResourcesBinding,
    startedAt: fixtureStartedAt,
    completedAt: alarms.at(-1)?.recoveredAt ?? fixtureStartedAt,
    receipts,
  }, alarmSignalAuthenticationKey)
}

/** Creates six collector-authenticated CloudWatch transition projections. */
function createAlarmTransitionArtifact(
  alarms: readonly WorkspaceSearchMigrationRehearsalAlarmEvidence[],
  signals: readonly WorkspaceSearchMigrationTelemetryRehearsalSignalBinding[],
): WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact {
  const transitions = alarms.map((alarm, index) => {
    const signal = signals[index]
    if (signal === undefined || signal.name !== alarm.name) {
      throw new Error('Expected canonical signal binding.')
    }
    return Object.freeze({
      name: alarm.name,
      alarmIdentityDigest: digest(`alarm-identity:${alarm.name}`),
      initialState: alarm.initialState,
      alarmState: alarm.alarmState,
      recoveredState: alarm.recoveredState,
      alarmObservedAt: alarm.alarmObservedAt,
      recoveredAt: alarm.recoveredAt,
      signalDigest: signal.signalDigest,
      signalObservedAt: signal.observedAt,
      signalMetricName: signal.metricName,
      metricEvaluationDigest: digest(`alarm-evaluation:${alarm.name}`),
      historyDigest: alarm.historyDigest,
    })
  })
  const claims: Omit<
    WorkspaceSearchMigrationRehearsalAlarmTransitionArtifact,
    'artifactDigest'
  > = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARM_HISTORY_VERSION,
    startedAt: fixtureStartedAt,
    completedAt: alarms.at(-1)?.recoveredAt ?? fixtureStartedAt,
    transitions,
  }
  return Object.freeze({
    ...claims,
    artifactDigest: createMigrationDigest(claims),
  })
}

/** Creates one finalized combined alarm artifact and a fresh key copy. */
async function createFinalizedAlarm(): Promise<{
  /** Exact canonical combined alarm bytes. */
  readonly bytes: Uint8Array
  /** Fresh key copy for suite assembly. */
  readonly verificationKey: Uint8Array
  /** Fresh distinct parent publication key for suite assembly. */
  readonly publicationVerificationKey: Uint8Array
  /** Metadata copied into the static prestage document. */
  readonly metadata: {
    /** Alarm-purpose authorization. */
    readonly authorization:
      WorkspaceSearchMigrationRehearsalAlarmAuthorization
    /** SHA-256 digest of exact combined bytes. */
    readonly artifactDigest: string
    /** Exact combined byte length. */
    readonly artifactByteLength: number
    /** Exact dual-route receipt count. */
    readonly receiptCount: 12
  }
}> {
  const signalArtifact = createAlarmSignalArtifact()
  const signals =
    createWorkspaceSearchMigrationTelemetryRehearsalSignalBindings(
      signalArtifact,
      alarmSignalAuthenticationKey,
    )
  const alarms = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.map(
    (name, index) => {
      const signal = signals[index]
      if (signal === undefined) throw new Error('Expected alarm signal.')
      return createAlarm(name, index, signal)
    },
  )
  const authorization = createAlarmAuthorization()
  const finalized = finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
    authorization,
    ingestionArtifact: await createAlarmIngestionArtifact(),
    publicationSigningKey: copyKey(alarmPublicationAuthenticationKey),
    receiptArtifact: createAlarmReceiptArtifact(alarms),
    signalArtifact,
    signalVerificationKey: copyKey(alarmSignalAuthenticationKey),
    transitionArtifact: createAlarmTransitionArtifact(alarms, signals),
  })
  return Object.freeze({
    bytes: new Uint8Array(finalized.canonicalArtifactBytes),
    verificationKey: copyKey(alarmSignalAuthenticationKey),
    publicationVerificationKey:
      copyKey(alarmPublicationAuthenticationKey),
    metadata: Object.freeze({
      authorization,
      artifactDigest: finalized.artifactDigest,
      artifactByteLength: finalized.artifactByteLength,
      receiptCount: finalized.receiptCount,
    }),
  })
}

/** Creates one exact target-preimage artifact expectation without AWS I/O. */
function createTargetPreimageArtifactExpectation(
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  planningReceipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  layout: RateLayout,
  rateSegments: readonly RateSegmentFixture[],
): FinalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidenceInput['artifact'] {
  if (planningReceipt.evidence.kind !== 'planning-sealed') {
    throw new Error('Expected complete-rollback planning evidence.')
  }
  const scenario = 'complete-apply-rollback'
  const context: WorkspaceSearchMigrationRehearsalTargetAuditContext =
    Object.freeze({
      scenario,
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
  const aggregate = Object.freeze({
    scanned: 2,
    owned: 2,
    ignored: 0,
    keyDigest: digest('special-target-keys'),
    contentDigest: digest('special-target-content'),
    pageCount: 1,
  })
  const aggregateDigest = createMigrationDigest({
    scanned: aggregate.scanned,
    owned: aggregate.owned,
    ignored: aggregate.ignored,
    keyDigest: aggregate.keyDigest,
    contentDigest: aggregate.contentDigest,
  })
  const startedAt = stageTimestamp(planningReceipt.stageOrdinal, 20.15)
  const observedAt = stageTimestamp(planningReceipt.stageOrdinal, 20.2)
  const preimageOrdinal =
    requireAuxiliaryRateOrdinals(layout, scenario).preimage
  if (preimageOrdinal === null) {
    throw new Error('Expected complete-rollback preimage rate segment.')
  }
  const rate = createAuxiliaryRateEvidence(
    rateSegments,
    preimageOrdinal,
    stageTimestamp(planningReceipt.stageOrdinal, 20.4),
  )
  const cachedCompleteRollback = cachedReconciliationArtifacts.get(scenario)
  const cachedTargetAudits = cachedCompleteRollback?.binding.targetAudits
  if (cachedTargetAudits === null || cachedTargetAudits === undefined) {
    throw new Error('Expected genuine complete target integrity authority.')
  }
  const integrity = structuredClone(cachedTargetAudits.preimage.integrity)
  const evidenceKeyDigest = createHash('sha256')
    .update(stageAuthenticationKey)
    .digest('hex')
  const observationFields = Object.freeze({
    startedAt,
    observedAt,
    commit: manifest.commit,
    configurationHash: manifest.configurationBindingDigest,
    evidenceKeyDigest,
    sourceSessionBindingDigest: digest('special-target-source-session'),
    sourceResourceBindingDigest: manifest.requestedResourcesBinding,
    aggregate,
    aggregateDigest,
  })
  const observationDigest = createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-target-observation',
    version: 2,
    startedAt: observationFields.startedAt,
    observedAt,
    commit: observationFields.commit,
    configurationHash: observationFields.configurationHash,
    evidenceKeyDigest,
    sourceSessionBindingDigest:
      observationFields.sourceSessionBindingDigest,
    sourcePermitDigest: context.permitDigest,
    sourceResourceBindingDigest:
      observationFields.sourceResourceBindingDigest,
    aggregate,
    aggregateDigest,
  })
  const runtimeKeyFingerprint = createHmac('sha256', stageAuthenticationKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-key/v4\n',
      'utf8',
    )
    .digest('hex')
  const unsigned = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
    purpose: 'complete-rollback-preimage',
    ...observationFields,
    integrity,
    context,
    terminal: null,
    observationDigest,
    rate,
    authentication: Object.freeze({
      algorithm: 'HMAC-SHA-256',
      runtimeKeyFingerprint,
    }),
  })
  const runtimeMac = createHmac('sha256', stageAuthenticationKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-mac/v4\n',
      'utf8',
    )
    .update(serializeCanonicalJson(unsigned), 'utf8')
    .digest('hex')
  const publicationKeyFingerprint = createHmac(
    'sha256',
    reconciliationPublicationKey,
  ).update(
    'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-key/v4\n',
    'utf8',
  ).digest('hex')
  const publicationUnsigned = Object.freeze({
    ...unsigned,
    authentication: Object.freeze({
      ...unsigned.authentication,
      runtimeMac,
      publicationKeyFingerprint,
    }),
  })
  const publicationMac = createHmac('sha256', reconciliationPublicationKey)
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
  return Object.freeze({
    artifactBytes,
    expectedContext: context,
    purpose: 'complete-rollback-preimage',
    terminal: null,
  })
}

/**
 * Re-signs one suite receipt against a fresh genuine reservation.
 *
 * @param stageChain - Authenticated manifest and original receipt chain.
 * @param entry - Exact special stage selected for the fixture.
 * @param layout - Global stage and auxiliary rate layout.
 * @param rateSegments - Exact canonical rate segments for the suite.
 * @returns Selection, reservation, predecessor, receipt, and child rate bytes.
 */
function createReservedCommitGateReceipt(
  stageChain: StageChainFixture,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  layout: RateLayout,
  rateSegments: readonly RateSegmentFixture[],
): readonly [
  WorkspaceSearchMigrationRehearsalSelectedStage,
  WorkspaceSearchMigrationRehearsalStageReservation,
  WorkspaceSearchMigrationRehearsalStageReceipt,
  WorkspaceSearchMigrationRehearsalStageReceipt,
  WorkspaceSearchMigrationRehearsalRateCommittedSegment,
] {
  const previousReceipt = stageChain.receipts[entry.ordinal - 2]
  const sourceReceipt = stageChain.receipts[entry.ordinal - 1]
  const rateOrdinal = layout.stageOrdinals.get(entry.ordinal)
  const rateSegment = rateOrdinal === undefined
    ? undefined
    : rateSegments[rateOrdinal]
  const previousRateSegment = rateOrdinal === undefined || rateOrdinal === 0
    ? undefined
    : rateSegments[rateOrdinal - 1]
  if (
    previousReceipt === undefined ||
    sourceReceipt === undefined ||
    rateSegment === undefined ||
    previousRateSegment === undefined
  ) throw new Error('Expected non-first special stage fixtures.')
  const selection: WorkspaceSearchMigrationRehearsalSelectedStage =
    Object.freeze({
      manifest: stageChain.manifest,
      manifestDigest: createMigrationDigest(stageChain.manifest),
      entry,
      previousStageReceiptDigest: createMigrationDigest(previousReceipt),
    })
  const reservation = createWorkspaceSearchMigrationRehearsalStageReservation({
    selection,
    nonce: createHash('sha256')
      .update(`special-gate:${entry.ordinal}`, 'utf8')
      .digest(),
    reservedAt: stageTimestamp(entry.ordinal, -1),
    expiresAt: stageTimestamp(entry.ordinal, 60),
    expectedPreviousRateSegment: previousRateSegment.binding,
    expectedCurrentRateSegmentOrdinal: rateSegment.binding.segmentOrdinal,
    expectedTargetPreimageArtifactContentDigest:
      entry.command === 'apply' &&
        (entry.scenario === 'complete-apply-rollback' ||
          entry.scenario === 'partial-apply-rollback')
        ? createTargetContentDigest(entry.scenario, 'preimage')
        : null,
    signingKey: copyKey(stageAuthenticationKey),
  })
  const { receiptMac: _receiptMac, ...sourceClaims } = sourceReceipt
  const receipt = createWorkspaceSearchMigrationRehearsalStageReceipt({
    claims: {
      ...sourceClaims,
      stageReservationDigest: createMigrationDigest(reservation),
    },
    signingKey: copyKey(stageAuthenticationKey),
  })
  return Object.freeze([
    selection,
    reservation,
    previousReceipt,
    receipt,
    Object.freeze({
      ...receipt.rateSegment,
      canonicalBytes: new Uint8Array(rateSegment.bytes),
    }),
  ])
}

/**
 * Creates one fresh genuine special commit-gate fixture.
 *
 * @param kind - Target-preimage planning or terminal reconciliation variant.
 * @returns Fresh selection, reservation, receipt, raw artifact, keys, and input.
 */
export function createAuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture(
  kind: AuthenticWorkspaceSearchMigrationRehearsalCommitGateFixtureKind,
): AuthenticWorkspaceSearchMigrationRehearsalCommitGateFixture {
  const integrityAttestationRootSegment =
    createIntegrityAttestationRootSegment()
  const manifestClaims = createManifestClaims(
    createIntegrityAttestationRootProjection(
      integrityAttestationRootSegment,
    ),
  )
  const layout = createRateLayout(manifestClaims.entries)
  const rateSegments = createRateSegments(
    layout,
    'measurement',
    integrityAttestationRootSegment,
  )
  const reconciliation = createReconciliationFixture()
  const stageChain = createStageChain(
    manifestClaims,
    layout,
    rateSegments,
    reconciliation,
  )
  const scenario = kind === 'target-preimage'
    ? 'complete-apply-rollback'
    : 'happy-path-verified'
  const command = kind === 'target-preimage' ? 'close-replan' : 'verify'
  const entry = requireManifestEntry(
    stageChain.manifest.entries,
    scenario,
    command,
  )
  const [
    selection,
    reservation,
    previousReceipt,
    receipt,
    committedRateSegment,
  ] = createReservedCommitGateReceipt(
    stageChain,
    entry,
    layout,
    rateSegments,
  )
  if (kind === 'target-preimage') {
    const artifact = createTargetPreimageArtifactExpectation(
      stageChain.manifest,
      receipt,
      layout,
      rateSegments,
    )
    const artifactBytes = new Uint8Array(artifact.artifactBytes)
    const finalizationInput:
      FinalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidenceInput =
        Object.freeze({
          artifact: Object.freeze({
            ...artifact,
            artifactBytes: new Uint8Array(artifact.artifactBytes),
          }),
          expectedProspectivePlanningReceiptDigest:
            createMigrationDigest(receipt),
          expectedPlanningReceiptCompletedAt: receipt.completedAt,
          expectedRatePredecessor: receipt.rateSegment,
          commitGateObservedAt: stageTimestamp(entry.ordinal, 20.6),
        })
    return Object.freeze({
      kind,
      selection,
      reservation,
      previousReceipt,
      receipt,
      artifactBytes,
      committedRateSegment,
      runtimeAuthenticationKey: copyKey(stageAuthenticationKey),
      publicationAuthenticationKey:
        copyKey(reconciliationPublicationKey),
      finalizationInput,
    })
  }
  const artifact = reconciliation.artifacts.get(scenario)
  if (artifact === undefined || receipt.evidence.kind !== 'terminal') {
    throw new Error('Expected genuine terminal reconciliation fixture.')
  }
  const artifactBytes = new Uint8Array(artifact.bytes)
  const finalizationInput:
    FinalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidenceInput =
      Object.freeze({
        artifact: Object.freeze({
          artifactBytes: new Uint8Array(artifact.bytes),
          expectedContext:
            createReconciliationContextProjection(artifact.binding),
        }),
        expectedRatePredecessor: receipt.rateSegment,
      })
  return Object.freeze({
    kind,
    selection,
    reservation,
    previousReceipt,
    receipt,
    artifactBytes,
    committedRateSegment,
    runtimeAuthenticationKey: copyKey(stageAuthenticationKey),
    publicationAuthenticationKey: copyKey(reconciliationPublicationKey),
    finalizationInput,
  })
}

/**
 * Creates one genuine terminal receipt and the complete ordinal-indexed rate.
 *
 * @param scenario - Verified or rollback scenario immediately before release.
 * @returns Genuine manifest, terminal receipt, exact raw segments, and key.
 */
export function createAuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalFixture(
  scenario:
    AuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalScenario,
): AuthenticWorkspaceSearchMigrationRehearsalReleaseTerminalFixture {
  const integrityAttestationRootSegment =
    createIntegrityAttestationRootSegment()
  const manifestClaims = createManifestClaims(
    createIntegrityAttestationRootProjection(
      integrityAttestationRootSegment,
    ),
  )
  const layout = createRateLayout(manifestClaims.entries)
  const rateSegments = createRateSegments(
    layout,
    'measurement',
    integrityAttestationRootSegment,
  )
  const reconciliation = createReconciliationFixture()
  const stageChain = createStageChain(
    manifestClaims,
    layout,
    rateSegments,
    reconciliation,
  )
  const terminalCommand = scenario === 'partial-apply-rollback'
    ? 'rollback-partial'
    : scenario === 'complete-apply-rollback'
    ? 'rollback-complete'
    : 'verify'
  const terminalEntry = requireManifestEntry(
    stageChain.manifest.entries,
    scenario,
    terminalCommand,
  )
  const releaseEntry = requireManifestEntry(
    stageChain.manifest.entries,
    scenario,
    'release',
  )
  const terminalReceipt = stageChain.receipts[terminalEntry.ordinal - 1]
  if (
    terminalReceipt === undefined ||
    releaseEntry.ordinal !== terminalEntry.ordinal + 1 ||
    terminalReceipt.evidence.kind !== 'terminal'
  ) {
    throw new Error('Expected terminal receipt immediately before release.')
  }
  const terminalRateSegment =
    rateSegments[terminalReceipt.rateSegment.segmentOrdinal]
  const reconciliationSuccessorOrdinal =
    terminalReceipt.evidence.reconciliationRate.successor.segmentOrdinal
  const reconciliationSuccessorSegment =
    rateSegments[reconciliationSuccessorOrdinal]
  if (
    terminalRateSegment === undefined ||
    reconciliationSuccessorSegment === undefined ||
    reconciliationSuccessorOrdinal !==
      requireAuxiliaryRateOrdinals(layout, scenario).reconciliation ||
    serializeCanonicalJson(terminalRateSegment.binding) !==
      serializeCanonicalJson(terminalReceipt.rateSegment) ||
    serializeCanonicalJson(reconciliationSuccessorSegment.binding) !==
      serializeCanonicalJson(
        terminalReceipt.evidence.reconciliationRate.successor,
      )
  ) {
    throw new Error('Expected exact terminal and reconciliation segments.')
  }
  return Object.freeze({
    scenario,
    manifest: stageChain.manifest,
    ratePolicyBytes: new Uint8Array(ratePolicyBytes),
    terminalReceipt,
    terminalRateSegmentBytes:
      new Uint8Array(terminalRateSegment.bytes),
    reconciliationSuccessorSegmentBytes:
      new Uint8Array(reconciliationSuccessorSegment.bytes),
    allRateSegmentBytes: Object.freeze(rateSegments.map(
      (segment) => new Uint8Array(segment.bytes),
    )),
    rateSegmentRoles: createRateSegmentRoles(
      stageChain.manifest.entries,
      layout,
      rateSegments,
    ),
    runtimeAuthenticationKey: copyKey(stageAuthenticationKey),
  })
}

/**
 * Creates fresh authentic raw material for one suite assembler invocation.
 *
 * Every call reconstructs all process-local one-shot capabilities. The caller
 * may therefore use separate invocations for replay and tampering tests.
 *
 * @param options Optional authenticated negative-path fixture variants.
 * @returns Fresh assembler input and independently known expected bindings.
 */
export async function createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture(
  options: AuthenticWorkspaceSearchMigrationRehearsalSuiteFixtureOptions = {},
): Promise<AuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture> {
  const integrityAttestationRootSegment =
    createIntegrityAttestationRootSegment()
  const integrityAttestationRoot =
    createIntegrityAttestationRootProjection(
      integrityAttestationRootSegment,
    )
  const manifestClaims = createManifestClaims(
    integrityAttestationRoot,
  )
  const stageCount = manifestClaims.entries.length
  const finalMeasurementPhase = options.finalMeasurementPhase ?? 'measurement'
  const layout = createRateLayout(manifestClaims.entries)
  const rateLayout = options.rateSegmentCountOffset === 1
    ? Object.freeze({
        ...layout,
        anchors: Object.freeze([
          ...layout.anchors,
          stageTimestamp(stageCount, 20.75),
        ]),
      })
    : layout
  const rateSegments = createRateSegments(
    rateLayout,
    finalMeasurementPhase,
    integrityAttestationRootSegment,
    options.integrityInventoryVariant,
    options.rateExerciseVariant,
  )
  const reconciliation = options.integrityInventoryVariant === undefined
    ? createReconciliationFixture()
    : createReconciliationFixtureFromArtifacts(
        await createReconciliationArtifacts(
          manifestClaims.entries,
          layout,
          rateSegments,
        ),
      )
  const stageChain = createStageChain(
    manifestClaims,
    layout,
    rateSegments,
    reconciliation,
  )
  const finalizedRateSegments = options.rateSegmentCountOffset === -1
    ? rateSegments.slice(0, -1)
    : rateSegments
  const rate = createFinalizedRate(
    finalizedRateSegments,
    options.rateExerciseVariant,
  )
  const alarm = await createFinalizedAlarm()
  const completedAt = stageTimestamp(stageCount, 22)
  const document = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_VERSION,
    commit: fixtureCommit,
    attestation,
    configurationHash,
    ratePolicyVersion,
    startedAt: integrityAttestationRoot.startedAt,
    alarm: alarm.metadata,
  })
  const expectedEvidenceKeyDigest = manifestClaims.evidenceKeyDigest
  const expectedPublicationKeyDigest = manifestClaims.publicationKeyDigest
  const sessionBinding = Object.freeze({
    commit: fixtureCommit,
    configurationHash,
    evidenceKeyDigest: expectedEvidenceKeyDigest,
    publicationKeyDigest: expectedPublicationKeyDigest,
    attestation,
  })
  return Object.freeze({
    input: {
      document,
      alarmArtifactBytes: alarm.bytes,
      alarmSignalVerificationKey: alarm.verificationKey,
      alarmPublicationVerificationKey:
        alarm.publicationVerificationKey,
      stageChain: stageChain.capability,
      reconciliation: reconciliation.capability,
      rate,
      completedAt,
    },
    authenticatedInput: {
      alarmArtifactBytes: alarm.bytes,
      alarmSignalVerificationKey: alarm.verificationKey,
      alarmPublicationVerificationKey:
        alarm.publicationVerificationKey,
      stageChain: stageChain.capability,
      reconciliation: reconciliation.capability,
      rate,
      completedAt,
      sessionBinding,
      expectedEvidenceKeyDigest,
      expectedPublicationKeyDigest,
    },
    expected: Object.freeze({
      commit: fixtureCommit,
      configurationHash,
      ratePolicyVersion,
      startedAt: integrityAttestationRoot.startedAt,
      firstStageStartedAt: fixtureStartedAt,
      completedAt,
      attestation,
      rateAggregate: rate.evidence.aggregate,
    }),
  })
}

/**
 * Creates one fresh genuine opaque suite capability for publication tests.
 *
 * @param options Optional authenticated negative-path fixture variants.
 * @returns Fresh suite capability and independently known expected bindings.
 */
export async function createAuthenticWorkspaceSearchMigrationRehearsalSuiteFixture(
  options: AuthenticWorkspaceSearchMigrationRehearsalSuiteFixtureOptions = {},
): Promise<AuthenticWorkspaceSearchMigrationRehearsalSuiteFixture> {
  const fixture =
    await createAuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture(
      options,
    )
  return Object.freeze({
    suite: assembleWorkspaceSearchMigrationRehearsalAuthenticatedSuite(
      fixture.authenticatedInput,
    ),
    expected: fixture.expected,
  })
}
