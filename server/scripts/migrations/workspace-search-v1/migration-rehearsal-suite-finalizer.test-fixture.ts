import { createHash, createHmac } from 'node:crypto'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  type CrossDomainIntegrityResourceIdentity,
} from '../../data-integrity/cross-domain-integrity'
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
  type WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding,
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
  assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_VERSION,
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
} from './migration-rehearsal-target-audit'
import type {
  WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
} from './migration-rehearsal-integrity-evidence'
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
}

/** Fresh raw assembler material and its publication-facing expectations. */
export type AuthenticWorkspaceSearchMigrationRehearsalAssemblerFixture = {
  /** Fresh one-shot capabilities and restricted bytes accepted by assembler. */
  readonly input: AssembleWorkspaceSearchMigrationRehearsalSuitePreparationInput
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
  /** Strict stage-receipt binding derived from those bytes. */
  readonly binding: WorkspaceSearchMigrationRehearsalStageRateSegment
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

/** Exact global 49-segment ordering used by an authentic suite fixture. */
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
  'mukuroji:workspace-search-migration:rehearsal-rate-record:v1'

/** Deterministic permit digest shared with every stage receipt. */
const permitDigest = digest('main-permit')

/** Deterministic main requested-resource binding. */
const requestedResourcesBinding = digest('main-requested-resources')

/** Deterministic measured configuration binding. */
const configurationHash = digest('measured-configuration')

/** Deterministic reviewed actual-rate policy binding. */
const ratePolicyVersion = digest('reviewed-rate-policy')

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
function createManifestClaims():
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
    integrityResourceIdentityDigest:
      calculateCrossDomainIntegrityResourceIdentityDigest(
        createIntegrityResourceIdentities(),
        integrityAuthenticationKey,
      ),
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
    stageOrdinals.set(entry.ordinal, anchors.length)
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
      preimage = anchors.length
      anchors.push(stageTimestamp(first.ordinal, 20.1))
    }
    for (let index = 1; index < scenarioEntries.length - 1; index += 1) {
      const entry = scenarioEntries[index]
      if (entry === undefined) throw new Error('Expected scenario stage.')
      appendStage(entry)
    }
    if (rollback) {
      restored = anchors.length
      anchors.push(stageTimestamp(terminal.ordinal, 18.5))
    }
    const reconciliation = anchors.length
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

/** Creates all exact stage, auxiliary, and final measurement rate segments. */
function createRateSegments(
  layout: RateLayout,
  finalPhase: 'checkpoint-page' | 'measurement',
): readonly RateSegmentFixture[] {
  const fixtures: RateSegmentFixture[] = []
  let previousSegmentDigest: string | null = null
  let previousRecordMac: string | null = null
  let firstEventSequence = 1
  const authenticationKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      rateAuthenticationKey,
    )
  for (let segmentOrdinal = 0; segmentOrdinal < layout.anchors.length;
    segmentOrdinal += 1) {
    const isFinal = segmentOrdinal === layout.anchors.length - 1
    const anchorUtc = layout.anchors[segmentOrdinal]
    if (anchorUtc === undefined) throw new Error('Expected rate anchor.')
    const segmentLocatorDigest = digest(`rate-segment:${segmentOrdinal}`)
    const headerPayload = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment',
      version: 1,
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
    const phase = isFinal ? finalPhase : 'checkpoint-page'
    const attemptSequence = segmentOrdinal + 1
    const chargedPayload = Object.freeze({
      version: 1,
      eventSequence: firstEventSequence,
      offsetMilliseconds: 0,
      previousRecordMac: headerMac,
      kind: 'attempt-charged',
      attemptSequence,
      phase,
    })
    const chargedMac = createRateRecordMac(chargedPayload)
    const charged = Object.freeze({ ...chargedPayload, mac: chargedMac })
    const startedPayload = Object.freeze({
      version: 1,
      eventSequence: firstEventSequence + 1,
      offsetMilliseconds: 100,
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
    const started = Object.freeze({ ...startedPayload, mac: startedMac })
    const events: Readonly<Record<string, unknown>>[] = [charged, started]
    let terminalRecordMac = startedMac
    if (segmentOrdinal === 0) {
      const throttledPayload = Object.freeze({
        version: 1,
        eventSequence: firstEventSequence + 2,
        offsetMilliseconds: 200,
        previousRecordMac: terminalRecordMac,
        kind: 'attempt-throttled',
        attemptSequence,
        phase,
        backoffMilliseconds: 500,
      })
      const throttledMac = createRateRecordMac(throttledPayload)
      events.push(Object.freeze({ ...throttledPayload, mac: throttledMac }))
      const budgetPayload = Object.freeze({
        version: 1,
        eventSequence: firstEventSequence + 3,
        offsetMilliseconds: 300,
        previousRecordMac: throttledMac,
        kind: 'budget-stop',
        phase,
        reason: 'budget-capacity',
        requiredAttempts: 1,
        remainingNormalAdmissionAttempts: 0,
        remainingWindowAttempts: 0,
        retryAfterMilliseconds: 1_000,
      })
      const budgetMac = createRateRecordMac(budgetPayload)
      events.push(Object.freeze({ ...budgetPayload, mac: budgetMac }))
      terminalRecordMac = budgetMac
    }
    const canonicalText = [header, ...events]
      .map((record) => `${serializeCanonicalJson(record)}\n`)
      .join('')
    const bytes = new TextEncoder().encode(canonicalText)
    const segmentDigest = createHash('sha256').update(bytes).digest('hex')
    const eventCount = events.length
    fixtures.push(Object.freeze({
      bytes,
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
    }))
    previousSegmentDigest = segmentDigest
    previousRecordMac = terminalRecordMac
    firstEventSequence += eventCount
  }
  return Object.freeze(fixtures)
}

/** Finalizes one fresh authenticated complete rate stream. */
function createFinalizedRate(
  segments: readonly RateSegmentFixture[],
): WorkspaceSearchMigrationRehearsalFinalizedRateEvidence {
  return finalizeWorkspaceSearchMigrationRehearsalRateEvidence({
    segments: segments.map((segment) => segment.bytes),
    authenticationKey: copyKey(rateAuthenticationKey),
    expectedPolicyVersion: ratePolicyVersion,
    expectedConfigurationBindingDigest: configurationHash,
    durableEvidence: {
      version: 1,
      policyVersion: ratePolicyVersion,
      attemptCount: segments.length,
      forfeitedAttemptCount: 0,
      throttleCount: 1,
      budgetStopCount: 1,
      cadenceWaitCount: 0,
      cadenceWaitMilliseconds: 0,
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
  return Object.freeze(
    CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.map((target, index) =>
      Object.freeze({
        target,
        identityDigest: digest(`integrity-resource:${index}`),
      })
    ),
  )
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
      version: 1,
      policyVersion: ratePolicyVersion,
      attemptCount: 1,
      forfeitedAttemptCount: 0,
      throttleCount: 0,
      budgetStopCount: 0,
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

/** Creates one deterministic digest-only independently authenticated result. */
function createReconciliationIntegrityResult(
  label: string,
  checkedAt: string,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding {
  const scenario = label.replace(/:(?:after|before)$/u, '')
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
      startedAt: checkedAt,
      completedAt: checkedAt,
      checkedAtSource: 'trusted-wall-clock-after-external-reads',
    }),
    resourceIdentityScheme:
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
    resourceIdentities: createIntegrityResourceIdentities(),
    integrityAggregateDigest: digest(`integrity-aggregate:${scenario}`),
    resourceIdentityDigest:
      calculateCrossDomainIntegrityResourceIdentityDigest(
        createIntegrityResourceIdentities(),
        integrityAuthenticationKey,
      ),
  })
}

/** Creates the scenario-specific authenticated integrity collector projection. */
function createReconciliationIntegrity(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  aggregateDigest: string,
  planningEntry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  terminalEntry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult {
  const scenario = context.scenario
  const rollback = scenario === 'partial-apply-rollback' ||
    scenario === 'complete-apply-rollback'
  if (!rollback) {
    return Object.freeze({
      kind: 'verified-result',
      status: 'pass',
      failureCount: 0,
      completedAt: stageTimestamp(terminalEntry.ordinal, 19.8),
      result: createReconciliationIntegrityResult(
        `${scenario}:after`,
        stageTimestamp(terminalEntry.ordinal, 19.4),
      ),
      terminalRootDigest: context.terminalRootDigest,
      integrityAggregateDigest: digest(`integrity-aggregate:${scenario}`),
    })
  }
  const purpose = scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : 'complete-rollback'
  const startedAt = stageTimestamp(planningEntry.ordinal, 18)
  const applyStartedAt = stageTimestamp(planningEntry.ordinal + 1, 0)
  const terminalAt = context.terminalAt
  const completedAt = stageTimestamp(terminalEntry.ordinal, 19.8)
  const before = createReconciliationIntegrityResult(
    `${scenario}:before`,
    stageTimestamp(planningEntry.ordinal, 19),
  )
  const after = createReconciliationIntegrityResult(
    `${scenario}:after`,
    stageTimestamp(terminalEntry.ordinal, 19.4),
  )
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
      kind: 'workspace-search-migration-rehearsal-integrity-context',
      version: 1,
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
function createReconciliationTargetAudits(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  aggregateDigest: string,
  planningEntry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  terminalEntry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  layout: RateLayout,
  rateSegments: readonly RateSegmentFixture[],
): WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null {
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
  const contextDigest = digest(`target-context:${scenario}`)
  const integrityBefore = createReconciliationIntegrityResult(
    `${scenario}:before`,
    stageTimestamp(planningEntry.ordinal, 19),
  )
  return Object.freeze({
    preimage: Object.freeze({
      purpose: `${prefix}-preimage`,
      contentDigest: createTargetContentDigest(scenario, 'preimage'),
      byteLength: 2_048,
      startedAt: stageTimestamp(planningEntry.ordinal, 20),
      observedAt: stageTimestamp(planningEntry.ordinal, 20.2),
      observationDigest: digest(`target-observation:${scenario}:preimage`),
      aggregateDigest,
      integrityBefore,
      contextDigest,
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
      startedAt: stageTimestamp(terminalEntry.ordinal, 18.1),
      observedAt: stageTimestamp(terminalEntry.ordinal, 18.2),
      observationDigest: digest(`target-observation:${scenario}:restored`),
      aggregateDigest,
      integrityBefore: null,
      contextDigest,
      rate: createAuxiliaryRateEvidence(
        rateSegments,
        ordinals.restored,
        stageTimestamp(terminalEntry.ordinal, 19),
      ),
    }),
  })
}

/** Creates one internally consistent actual terminal reconciliation collector. */
function createReconciliationCollector(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
  layout: RateLayout,
  rateSegments: readonly RateSegmentFixture[],
): WorkspaceSearchMigrationRehearsalReconciliationCollectorResult {
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
  const targetAudits = createReconciliationTargetAudits(
    scenario,
    aggregateDigest,
    planningEntry,
    terminalEntry,
    layout,
    rateSegments,
  )
  const markerDigest = digest(`marker-aggregate:${scenario}`)
  const authorityDigest = digest(`authority-chain:${scenario}`)
  return Object.freeze({
    context,
    integrity: createReconciliationIntegrity(
      context,
      aggregateDigest,
      planningEntry,
      terminalEntry,
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
  })
}

/** Creates eight actual dual-key artifacts and the batch capability. */
function createReconciliationFixture(
  entries: readonly WorkspaceSearchMigrationRehearsalStageManifestEntry[],
  layout: RateLayout,
  rateSegments: readonly RateSegmentFixture[],
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
    const terminalCommand = scenario === 'partial-apply-rollback'
      ? 'rollback-partial'
      : scenario === 'complete-apply-rollback'
      ? 'rollback-complete'
      : 'verify'
    const terminalEntry = requireManifestEntry(entries, scenario, terminalCommand)
    const reconciliationOrdinal =
      requireAuxiliaryRateOrdinals(layout, scenario).reconciliation
    const finalized =
      finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact({
        collectorResult: createReconciliationCollector(
          scenario,
          entries,
          layout,
          rateSegments,
        ),
        rate: createAuxiliaryRateInput(
          rateSegments,
          reconciliationOrdinal,
          stageTimestamp(terminalEntry.ordinal, 20.5),
        ),
      }, copyKey(rateAuthenticationKey), copyKey(reconciliationPublicationKey))
    const bytes = new Uint8Array(finalized.canonicalBytes)
    const binding =
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes(
        bytes,
        copyKey(rateAuthenticationKey),
        copyKey(reconciliationPublicationKey),
      )
    artifacts.set(scenario, Object.freeze({ bytes, binding }))
    expectations.push({
      artifactBytes: new Uint8Array(bytes),
      expectedContext: finalized.context,
    })
  }
  const capability =
    finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence({
      artifacts: expectations,
    }, copyKey(rateAuthenticationKey), copyKey(reconciliationPublicationKey))
  return Object.freeze({ artifacts, capability })
}

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
    : integrity.result.resultDigest
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
  const startedAt = stageTimestamp(planningReceipt.stageOrdinal, 20)
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
  const evidenceKeyDigest = createHash('sha256')
    .update(stageAuthenticationKey)
    .digest('hex')
  const integrityBefore:
    WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection =
      Object.freeze({
        checkedAt: stageTimestamp(planningReceipt.stageOrdinal, 19),
        contentDigest: digest('special-target-integrity-content'),
        byteLength: 1_024,
        resultDigest: digest('special-target-integrity-result'),
        resultMac: digest('special-target-integrity-mac'),
        runtimeProvenance: Object.freeze({
          kind: CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
          version: 1,
          mode: 'migration-rehearsal-live',
          startedAt: stageTimestamp(planningReceipt.stageOrdinal, 18.5),
          completedAt: stageTimestamp(planningReceipt.stageOrdinal, 19),
          checkedAtSource:
            'trusted-wall-clock-after-external-reads',
        }),
        resourceIdentityScheme:
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        resourceIdentities: manifest.integrityResourceIdentities,
        integrityAggregateDigest:
          digest('special-target-integrity-aggregate'),
        resourceIdentityDigest: manifest.integrityResourceIdentityDigest,
      })
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
      'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-key/v3\n',
      'utf8',
    )
    .digest('hex')
  const unsigned = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
    purpose: 'complete-rollback-preimage' as const,
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
  const runtimeMac = createHmac('sha256', stageAuthenticationKey)
    .update(
      'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-mac/v3\n',
      'utf8',
    )
    .update(serializeCanonicalJson(unsigned), 'utf8')
    .digest('hex')
  const publicationKeyFingerprint = createHmac(
    'sha256',
    reconciliationPublicationKey,
  ).update(
    'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-key/v3\n',
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
      'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-mac/v3\n',
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
  const manifestClaims = createManifestClaims()
  const layout = createRateLayout(manifestClaims.entries)
  const rateSegments = createRateSegments(layout, 'measurement')
  const reconciliation = createReconciliationFixture(
    manifestClaims.entries,
    layout,
    rateSegments,
  )
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
  const manifestClaims = createManifestClaims()
  const stageCount = manifestClaims.entries.length
  const finalMeasurementPhase = options.finalMeasurementPhase ?? 'measurement'
  const layout = createRateLayout(manifestClaims.entries)
  const rateSegments = createRateSegments(layout, finalMeasurementPhase)
  const reconciliation = createReconciliationFixture(
    manifestClaims.entries,
    layout,
    rateSegments,
  )
  const stageChain = createStageChain(
    manifestClaims,
    layout,
    rateSegments,
    reconciliation,
  )
  const rate = createFinalizedRate(rateSegments)
  const alarm = await createFinalizedAlarm()
  const completedAt = stageTimestamp(stageCount, 22)
  const document = Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_VERSION,
    commit: fixtureCommit,
    attestation,
    configurationHash,
    ratePolicyVersion,
    startedAt: fixtureStartedAt,
    alarm: alarm.metadata,
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
    expected: Object.freeze({
      commit: fixtureCommit,
      configurationHash,
      ratePolicyVersion,
      startedAt: fixtureStartedAt,
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
    suite: assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput(
      fixture.input,
    ),
    expected: fixture.expected,
  })
}
