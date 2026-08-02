import { createHash } from 'node:crypto'
import { types } from 'node:util'
import {
  createMigrationDigest,
  MINIMUM_MAINTENANCE_DRAIN_SECONDS,
  serializeCanonicalJson,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRehearsalEvidenceIndex,
  verifyWorkspaceSearchMigrationRehearsalAttestationEvidence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_VERSION,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalAlarmEvidence,
  type WorkspaceSearchMigrationRehearsalArtifactEvidence,
  type WorkspaceSearchMigrationRehearsalArtifactKind,
  type WorkspaceSearchMigrationRehearsalAttestationEvidence,
  type WorkspaceSearchMigrationRehearsalAttemptEvidence,
  type WorkspaceSearchMigrationRehearsalEvidenceClaims,
  type WorkspaceSearchMigrationRehearsalRateEvidence,
  type WorkspaceSearchMigrationRehearsalReconciliationEvidence,
  type WorkspaceSearchMigrationRehearsalReconciliationResultEvidence,
  type WorkspaceSearchMigrationRehearsalRollbackReconciliationEvidence,
  type WorkspaceSearchMigrationRehearsalReconciliationSummaryEvidence,
  type WorkspaceSearchMigrationRehearsalScenarioEvidence,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  type WorkspaceSearchMigrationRehearsalFailpoint,
  type WorkspaceSearchMigrationRehearsalFaultReceipt,
} from './migration-rehearsal-faults'
import {
  snapshotWorkspaceSearchMigrationRehearsalFaultObservation,
  type WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-fault-observation'
import type {
  WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence,
} from './migration-rehearsal-process-runner'
import {
  type WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt,
  type WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt,
} from './migration-rehearsal-control-cli'
import type {
  WorkspaceSearchMigrationRehearsalNoFaultProcessLifecycleEvidence,
} from './migration-rehearsal-process-cli'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedRateEvidence,
  type WorkspaceSearchMigrationRehearsalFinalizedRateEvidence,
  type WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
} from './migration-rehearsal-rate-evidence'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence,
  type WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence,
  type WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
} from './migration-rehearsal-reconciliation-audit'
import {
  consumeWorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence,
  createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest,
  type WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence,
  type WorkspaceSearchMigrationRehearsalStageChainAttempt,
  type WorkspaceSearchMigrationRehearsalStageChainEvidence,
  type WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence,
  type WorkspaceSearchMigrationRehearsalStageRateSegmentBinding,
} from './migration-rehearsal-stage-receipt'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import {
  createWorkspaceSearchMigrationRehearsalAlarmSharedClaimsBinding,
  finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence,
  serializeWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact,
  verifyWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact,
  type WorkspaceSearchMigrationRehearsalAlarmAuthorization,
  type WorkspaceSearchMigrationRehearsalFinalizedAlarmEvidence,
} from './migration-rehearsal-alarm-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPT_KEY_BYTES,
} from './migration-telemetry-rehearsal'

/** Stable discriminator for one complete digest-only rehearsal phase ledger. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_KIND =
  'mukuroji-workspace-search-migration-rehearsal-scenario-ledger'

/** First strict phase-ledger contract used by the suite finalizer. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_VERSION = 1

/** Exact minimum measured writer-drain duration in milliseconds. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MINIMUM_DRAIN_MILLISECONDS =
  MINIMUM_MAINTENANCE_DRAIN_SECONDS * 1_000

/** Maximum positive operation count accepted from one rehearsal ledger. */
const maximumOperationCount = 10_000_000

/** Maximum exact canonical bytes accepted by the immutable child publisher. */
const maximumPreparedArtifactByteLength = 64 * 1_024 * 1_024

/** Dedicated validation key used only to invoke the structural index reader. */
const structuralValidationKeyByteLength = 32

/** Canonical child-artifact envelope version owned by this finalizer. */
const childArtifactVersion = 1

/** Exact complete-stream kind emitted by the durable rate finalizer. */
const finalizedRateArtifactKind =
  'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-stream'

/** Terminal action selected after the scenario's apply boundary. */
export type WorkspaceSearchMigrationRehearsalSuiteTerminalAction =
  | 'rollback-complete'
  | 'rollback-partial'
  | 'verify'

/** Explicit digest-only proof that terminal release reopened the writer fence. */
export type WorkspaceSearchMigrationRehearsalSuiteReleaseBinding = {
  /** Exact coordinator stage that performed terminal release. */
  readonly mode: 'release'
  /** Exact coordinator result after the durable open record was reread. */
  readonly phase: 'released'
  /** Explicit durable writer-fence mode required after release. */
  readonly writerFenceMode: 'open'
  /** Writer-fence persistence schema containing the terminal release binding. */
  readonly writerFenceVersion: 2
  /** Terminal class that authorized the open transition. */
  readonly terminalKind: 'rolled-back' | 'verified'
  /** Terminal persistence version bound into the open record. */
  readonly terminalPersistenceVersion: 1 | 2
  /** Digest of the immutable terminal root bound into the open record. */
  readonly terminalRootDigest: string
  /** Digest of the exact canonical open writer-fence record. */
  readonly writerFenceRecordDigest: string
}

/** Complete phase ordering and semantic counts for one isolated scenario. */
export type WorkspaceSearchMigrationRehearsalSuitePhaseLedger = {
  /** Stable scenario-ledger discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_KIND
  /** Strict ledger schema version. */
  readonly ledgerVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_VERSION
  /** Fixed scenario whose lifecycle this ledger records. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Digest of the measured configuration used by every phase. */
  readonly configurationHash: string
  /** One same-run locator shared by close, replan, apply, and release. */
  readonly runLocatorDigest: string
  /** Canonical time at which application writers became closed. */
  readonly writersClosedAt: string
  /** Digest of the exact durable close-writer observation. */
  readonly closeEvidenceDigest: string
  /** Canonical start of the continuously observed writer-drain window. */
  readonly drainStartedAt: string
  /** Canonical completion of the continuously observed writer-drain window. */
  readonly drainCompletedAt: string
  /** Exact measured drain duration reproduced from both timestamps. */
  readonly drainDurationMilliseconds: number
  /** Mandatory zero active-writer count at the completed drain boundary. */
  readonly activeWriterCount: 0
  /** Digest of the fresh post-close zero-writer evidence. */
  readonly drainEvidenceDigest: string
  /** Canonical completion of same-run post-close replanning. */
  readonly replannedAt: string
  /** Digest of the admitted immutable same-run sealed plan. */
  readonly sealedPlanDigest: string
  /** Positive number of operations in the admitted sealed plan. */
  readonly sealedPlanOperationCount: number
  /** Canonical start of execution against the admitted plan. */
  readonly applyStartedAt: string
  /** Canonical time at which the required apply boundary was durable. */
  readonly applyBoundaryAt: string
  /** Complete-plan or strict committed-prefix apply classification. */
  readonly applyBoundary: 'committed-prefix' | 'complete'
  /** Positive number of operations durably represented at that boundary. */
  readonly appliedOperationCount: number
  /** Digest of the exact durable apply boundary. */
  readonly applyEvidenceDigest: string
  /** Digest of the normalized runtime fault observation, or null if unfaulted. */
  readonly faultObservationDigest: string | null
  /** Complete normalized runtime fault observation, or null if unfaulted. */
  readonly faultObservation:
    WorkspaceSearchMigrationRehearsalFaultObservation | null
  /** Explicit post-apply terminal operation. */
  readonly terminalAction:
    WorkspaceSearchMigrationRehearsalSuiteTerminalAction
  /** Canonical start of independent verification or rollback. */
  readonly terminalStartedAt: string
  /** Canonical completion of independent verification or rollback. */
  readonly terminalCompletedAt: string
  /** Digest of the exact immutable terminal graph. */
  readonly terminalEvidenceDigest: string
  /** Ordered HMAC-authenticated control-stage receipt digests. */
  readonly stageReceiptDigests: readonly string[]
  /** Ordered authenticated reservations that owned the control stages. */
  readonly stageReservationDigests: readonly string[]
  /** Ordered durable head revisions at which each stage was claimed. */
  readonly stageReservationClaimRevisions: readonly number[]
  /** Ordered durable head revisions expected after each receipt commit. */
  readonly stageReservationCommitRevisions: readonly number[]
  /** Exact durable rate segments owned by those control-stage receipts. */
  readonly rateSegmentBindings:
    readonly WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt[]
  /** Canonical time at which the terminal-bound fence became open. */
  readonly releasedAt: string
  /** Exact coordinator-derived open writer-fence binding. */
  readonly release: WorkspaceSearchMigrationRehearsalSuiteReleaseBinding
  /** Digest of every preceding canonical ledger field. */
  readonly ledgerDigest: string
}

/** Normalized fault observation paired with its exact digest. */
type WorkspaceSearchMigrationRehearsalBoundFaultObservation = {
  /** Digest of the complete normalized observation, or null if unfaulted. */
  readonly faultObservationDigest: string | null
  /** Detached normalized observation, or null if unfaulted. */
  readonly faultObservation:
    WorkspaceSearchMigrationRehearsalFaultObservation | null
}

/** Restart/takeover facts required after a parent-confirmed hard kill. */
export type WorkspaceSearchMigrationRehearsalSuiteRestartRecovery = {
  /** Selects lease-expiry recovery in a distinct successor attempt. */
  readonly kind: 'restart-takeover'
  /** Canonical predecessor lease expiry after confirmed process death. */
  readonly predecessorLeaseExpiresAt: string
  /** Canonical durable takeover time for the fresh successor owner. */
  readonly takeoverAcquiredAt: string
}

/** Reconciliation fact required after synthetic transaction response loss. */
export type WorkspaceSearchMigrationRehearsalSuiteResponseLossRecovery = {
  /** Selects same-attempt durable response-loss reconciliation. */
  readonly kind: 'response-loss-reconciled'
  /** Canonical time at which the durable response was reconciled. */
  readonly reconciledAt: string
}

/** Explicit absence of recovery for the two unfaulted scenarios. */
export type WorkspaceSearchMigrationRehearsalSuiteNoRecovery = {
  /** Selects the only valid recovery state for an unfaulted scenario. */
  readonly kind: 'none'
}

/** Scenario-specific recovery evidence retained without owner identifiers. */
export type WorkspaceSearchMigrationRehearsalSuiteRecovery =
  | WorkspaceSearchMigrationRehearsalSuiteNoRecovery
  | WorkspaceSearchMigrationRehearsalSuiteResponseLossRecovery
  | WorkspaceSearchMigrationRehearsalSuiteRestartRecovery

/** Exact post-recovery safety counters for one scenario. */
export type WorkspaceSearchMigrationRehearsalSuiteReconciliation = {
  /** Duplicate target applications observed after reconciliation. */
  readonly duplicateApplyCount: number
  /** Expected target applications missing after reconciliation. */
  readonly lostItemCount: number
  /** Durable authorities left without an owning operation. */
  readonly orphanAuthorityCount: number
}

/** All digest-only observations needed to finalize one scenario. */
export type WorkspaceSearchMigrationRehearsalSuiteScenarioInput = {
  /** Complete strict close-through-release phase ledger. */
  readonly ledger: WorkspaceSearchMigrationRehearsalSuitePhaseLedger
  /** Exact process attempts, including fresh owner/fence digests on restart. */
  readonly attempts:
    readonly WorkspaceSearchMigrationRehearsalAttemptEvidence[]
  /** Exact strict fault receipt, or null for an unfaulted scenario. */
  readonly faultReceipt:
    WorkspaceSearchMigrationRehearsalFaultReceipt | null
  /** No-fault completion receipt, or null for a faulted scenario. */
  readonly noFaultReceipt:
    WorkspaceSearchMigrationRehearsalNoFaultLifecycleReceipt | null
  /** Parent process lifecycle matching the selected fault or no-fault mode. */
  readonly processLifecycle:
    | WorkspaceSearchMigrationRehearsalProcessLifecycleEvidence
    | WorkspaceSearchMigrationRehearsalNoFaultProcessLifecycleEvidence
  /** Scenario-specific restart, takeover, or reconciliation facts. */
  readonly recovery: WorkspaceSearchMigrationRehearsalSuiteRecovery
  /** Exact zero-loss, zero-duplicate, zero-orphan safety counters. */
  readonly reconciliation:
    WorkspaceSearchMigrationRehearsalSuiteReconciliation
}

/** Stable canonical document used before final measurement and publication. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_KIND =
  'mukuroji-workspace-search-migration-rehearsal-suite-preparation'

/** First strict pre-publication document contract version. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_VERSION = 1

/** Inputs that finish a canonical suite document at the publication boundary. */
export type AssembleWorkspaceSearchMigrationRehearsalSuitePreparationInput = {
  /** Canonical JSON document containing only reviewed static suite bindings. */
  readonly document: unknown
  /** Exact canonical combined alarm artifact read from a restricted file. */
  readonly alarmArtifactBytes: Uint8Array
  /** Dedicated restricted key authenticating the actual EMF signal chain. */
  readonly alarmSignalVerificationKey: Uint8Array
  /** Distinct parent key authenticating the final alarm artifact. */
  readonly alarmPublicationVerificationKey: Uint8Array
  /** Authenticated complete control-stage chain consumed exactly once. */
  readonly stageChain:
    WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence
  /** Eight authenticated terminal reconciliation audits consumed once. */
  readonly reconciliation:
    WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence
  /** Finalized authenticated rate evidence including the publication session. */
  readonly rate: WorkspaceSearchMigrationRehearsalFinalizedRateEvidence
  /** Trusted completion time fixed after the final live measurement. */
  readonly completedAt: string
}

/** Runtime-only discriminator for one completely validated suite preparation. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_SUITE_KIND =
  'mukuroji-workspace-search-migration-rehearsal-finalized-suite'

/** Opaque one-shot suite capability accepted by immutable publication. */
export type WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation = {
  /** Fixed runtime-only capability discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_SUITE_KIND
}

/** One-shot publication material released only from an authentic suite. */
export interface WorkspaceSearchMigrationRehearsalSuitePublicationMaterial {
  /** Detached canonical child artifacts in their required publication order. */
  readonly artifacts:
    readonly WorkspaceSearchMigrationRehearsalPreparedArtifact[]
  /** Detached identity, permit-window, and live-rate publication bindings. */
  readonly bindings:
    WorkspaceSearchMigrationRehearsalSuitePublicationBindings

  /**
   * Binds actual immutable child references to the already validated claims.
   *
   * @param artifacts Exact immutable references returned by publication.
   * @returns Complete claims ready for the final HMAC evidence index.
   */
  finalize(
    artifacts: readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[],
  ): WorkspaceSearchMigrationRehearsalEvidenceClaims
}

/** Validated secret-free claims required before the first immutable write. */
export type WorkspaceSearchMigrationRehearsalSuitePublicationBindings = {
  /** Exact reviewed implementation commit authenticated by the suite. */
  readonly commit: string
  /** Exact measured non-production configuration digest. */
  readonly configurationHash: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly ratePolicyVersion: string
  /** Canonical beginning of the authenticated first stage process. */
  readonly startedAt: string
  /** Canonical completion after the fresh publication measurement. */
  readonly completedAt: string
  /** Exact permit, caller, resource, and isolation attestations. */
  readonly attestation:
    WorkspaceSearchMigrationRehearsalAttestationEvidence
  /** Exact finalized live DescribeTable aggregate. */
  readonly rateAggregate:
    WorkspaceSearchMigrationRehearsalRateEvidence['aggregate']
}

/** One detached canonical child artifact ready for immutable publication. */
export type WorkspaceSearchMigrationRehearsalPreparedArtifact = {
  /** Canonical finite artifact purpose supplied separately to the publisher. */
  readonly kind: WorkspaceSearchMigrationRehearsalArtifactKind
  /** Detached exact canonical UTF-8 JSON bytes owned by the caller. */
  readonly canonicalBytes: Uint8Array
  /** SHA-256 digest of the exact canonical bytes. */
  readonly contentDigest: string
  /** Exact canonical byte length. */
  readonly byteLength: number
}

/** Stable raw-value-free failure raised by the suite trust boundary. */
export class WorkspaceSearchMigrationRehearsalSuiteFinalizerError
  extends Error {
  /** Stable machine-readable failure without caller-owned values. */
  readonly code = 'INVALID_MIGRATION_REHEARSAL_SUITE_EVIDENCE'

  /** Creates the sole public suite-finalization failure. */
  constructor() {
    super('INVALID_MIGRATION_REHEARSAL_SUITE_EVIDENCE')
    this.name = 'WorkspaceSearchMigrationRehearsalSuiteFinalizerError'
  }
}

/** Strict guards bound to the suite's stable public failure. */
const suiteGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failSuiteFinalizer,
)

/** Exact public assembler envelope fields. */
const suiteAssemblyInputKeys = Object.freeze([
  'alarmArtifactBytes',
  'alarmPublicationVerificationKey',
  'alarmSignalVerificationKey',
  'completedAt',
  'document',
  'rate',
  'reconciliation',
  'stageChain',
])

/** Exact canonical pre-publication document fields. */
const suitePreparationDocumentKeys = Object.freeze([
  'alarm',
  'attestation',
  'commit',
  'configurationHash',
  'kind',
  'ratePolicyVersion',
  'startedAt',
  'version',
])

/** Exact alarm metadata copied beside separately restricted canonical bytes. */
const suitePreparationAlarmMetadataKeys = Object.freeze([
  'artifactByteLength',
  'artifactDigest',
  'authorization',
  'receiptCount',
])

/** Exact fields authenticated by one scenario ledger digest. */
const ledgerPayloadKeys = Object.freeze([
  'activeWriterCount',
  'applyBoundary',
  'applyBoundaryAt',
  'applyEvidenceDigest',
  'applyStartedAt',
  'appliedOperationCount',
  'closeEvidenceDigest',
  'configurationHash',
  'drainCompletedAt',
  'drainDurationMilliseconds',
  'drainEvidenceDigest',
  'drainStartedAt',
  'faultObservation',
  'faultObservationDigest',
  'kind',
  'ledgerVersion',
  'release',
  'releasedAt',
  'replannedAt',
  'runLocatorDigest',
  'rateSegmentBindings',
  'scenario',
  'sealedPlanDigest',
  'sealedPlanOperationCount',
  'terminalAction',
  'terminalCompletedAt',
  'terminalEvidenceDigest',
  'stageReceiptDigests',
  'stageReservationClaimRevisions',
  'stageReservationCommitRevisions',
  'stageReservationDigests',
  'terminalStartedAt',
  'writersClosedAt',
])

/** Exact ledger record fields, including its terminal digest. */
const ledgerKeys = Object.freeze([...ledgerPayloadKeys, 'ledgerDigest'])

/** Exact open writer-fence release binding fields. */
const releaseKeys = Object.freeze([
  'mode',
  'phase',
  'terminalKind',
  'terminalPersistenceVersion',
  'terminalRootDigest',
  'writerFenceMode',
  'writerFenceRecordDigest',
  'writerFenceVersion',
])

/** Exact finalized durable-rate fields. */
const finalizedRateKeys = Object.freeze([
  'artifactDigest',
  'canonicalArtifactBytes',
  'evidence',
  'observationCount',
  'segmentCount',
  'startedAttemptCount',
])

/** Exact durable rate-segment binding fields copied into stage receipts. */
const rateSegmentBindingKeys = Object.freeze([
  'authenticationKeyFingerprint',
  'eventCount',
  'firstCommittedEventSequence',
  'firstEventSequence',
  'lastCommittedEventSequence',
  'segmentDigest',
  'segmentLocatorDigest',
  'segmentOrdinal',
  'terminalRecordMac',
])

/** Exact publisher-facing rate evidence fields. */
const rateEvidenceKeys = Object.freeze([
  'aggregate',
  'aggregateDigest',
  'observationCount',
  'observationStreamDigest',
  'observedMaximumRatePerSecond',
])

/** Exact actual-rate aggregate fields inspected before nested property reads. */
const rateAggregateKeys = Object.freeze([
  'attemptCount',
  'budgetStopCount',
  'cadenceWaitCount',
  'cadenceWaitMilliseconds',
  'forfeitedAttemptCount',
  'maximumInFlight',
  'policyVersion',
  'throttleCount',
  'version',
])

/**
 * Assembles a canonical prestage document with final live publication facts.
 *
 * The document deliberately excludes the final DescribeTable stream and suite
 * completion time because the publication process must first open a fresh
 * continuation segment, measure the live session, durably finalize that
 * segment, and only then fix `completedAt`. Combined alarm bytes remain in a
 * separate restricted file and are re-derived rather than trusted from JSON.
 *
 * @param input Canonical document, restricted alarm bytes, final rate, and time.
 * @returns Detached complete suite input ready for two-phase publication.
 * @throws {WorkspaceSearchMigrationRehearsalSuiteFinalizerError} On any
 * malformed, self-asserted, mismatched, or incomplete evidence.
 */
export function assembleWorkspaceSearchMigrationRehearsalSuitePreparationInput(
  input: AssembleWorkspaceSearchMigrationRehearsalSuitePreparationInput,
): WorkspaceSearchMigrationRehearsalFinalizedSuitePreparation {
  let transferredAlarmSignalKey: unknown
  let transferredAlarmPublicationKey: unknown
  let workingAlarmSignalKey: Uint8Array | undefined
  let workingAlarmPublicationKey: Uint8Array | undefined
  try {
    const envelope = suiteGuards.requireRecord(input)
    suiteGuards.requireExactKeys(envelope, suiteAssemblyInputKeys)
    transferredAlarmSignalKey = suiteGuards.readOwn(
      envelope,
      'alarmSignalVerificationKey',
    )
    workingAlarmSignalKey = copyAlarmSignalVerificationKey(
      transferredAlarmSignalKey,
    )
    transferredAlarmPublicationKey = suiteGuards.readOwn(
      envelope,
      'alarmPublicationVerificationKey',
    )
    workingAlarmPublicationKey = copyAlarmSignalVerificationKey(
      transferredAlarmPublicationKey,
    )
    if (bytesEqual(workingAlarmSignalKey, workingAlarmPublicationKey)) {
      return failSuiteFinalizer()
    }
    const document = suiteGuards.requireRecord(
      suiteGuards.readOwn(envelope, 'document'),
    )
    suiteGuards.requireExactKeys(document, suitePreparationDocumentKeys)
    if (
      suiteGuards.readOwn(document, 'kind') !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_KIND ||
      suiteGuards.readOwn(document, 'version') !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_PREPARATION_VERSION
    ) {
      return failSuiteFinalizer()
    }
    const commit = readCommit(suiteGuards.readOwn(document, 'commit'))
    const configurationHash = suiteGuards.readDigest(
      suiteGuards.readOwn(document, 'configurationHash'),
    )
    const ratePolicyVersion = suiteGuards.readDigest(
      suiteGuards.readOwn(document, 'ratePolicyVersion'),
    )
    const startedAt = suiteGuards.readTimestamp(
      suiteGuards.readOwn(document, 'startedAt'),
    )
    const completedAt = suiteGuards.readTimestamp(
      suiteGuards.readOwn(envelope, 'completedAt'),
    )
    if (Date.parse(startedAt) >= Date.parse(completedAt)) {
      return failSuiteFinalizer()
    }
    const attestation =
      verifyWorkspaceSearchMigrationRehearsalAttestationEvidence(
        suiteGuards.readOwn(document, 'attestation'),
      )
    const alarm = readSuitePreparationAlarm(
      suiteGuards.readOwn(document, 'alarm'),
      suiteGuards.readOwn(envelope, 'alarmArtifactBytes'),
      workingAlarmSignalKey,
      workingAlarmPublicationKey,
    )
    const stageChain =
      consumeWorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence(
        suiteGuards.readOwn(envelope, 'stageChain'),
      )
    const reconciliation =
      consumeWorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence(
        suiteGuards.readOwn(envelope, 'reconciliation'),
      )
    consumeWorkspaceSearchMigrationRehearsalFinalizedRateEvidence(input.rate)
    const rate = structuredClone(input.rate)
    const state = prepareAuthenticatedStageSuiteState({
      alarm,
      alarmSignalVerificationKey: workingAlarmSignalKey,
      alarmPublicationVerificationKey: workingAlarmPublicationKey,
      attestation,
      commit,
      completedAt,
      configurationHash,
      rate,
      ratePolicyVersion,
      reconciliation,
      stageChain,
      startedAt,
    })
    const capability = Object.freeze({
      kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_SUITE_KIND,
    })
    finalizedSuitePreparations.set(capability, state)
    return capability
  } catch {
    return failSuiteFinalizer()
  } finally {
    zeroizeAlarmSignalVerificationKey(transferredAlarmSignalKey)
    zeroizeAlarmSignalVerificationKey(transferredAlarmPublicationKey)
    zeroizeAlarmSignalVerificationKey(workingAlarmSignalKey)
    zeroizeAlarmSignalVerificationKey(workingAlarmPublicationKey)
  }
}

/** Re-derives finalized alarm evidence from separate restricted bytes. */
function readSuitePreparationAlarm(
  metadataValue: unknown,
  bytesValue: unknown,
  signalVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalFinalizedAlarmEvidence {
  if (!types.isUint8Array(bytesValue) || types.isProxy(bytesValue)) {
    return failSuiteFinalizer()
  }
  const buffer = suiteGuards.readIntrinsicBuffer(bytesValue)
  if (types.isSharedArrayBuffer(buffer)) return failSuiteFinalizer()
  const bytes = new Uint8Array(bytesValue)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return failSuiteFinalizer()
  }
  if (serializeCanonicalJson(parsed) !== text) return failSuiteFinalizer()
  const artifact =
    verifyWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact(
      parsed,
      signalVerificationKey,
      publicationVerificationKey,
    )
  const finalized = finalizeWorkspaceSearchMigrationRehearsalAlarmEvidence({
    authorization: artifact.authorization,
    ingestionArtifact: artifact.ingestionArtifact,
    publicationSigningKey: publicationVerificationKey,
    receiptArtifact: artifact.receiptArtifact,
    signalArtifact: artifact.signalArtifact,
    signalVerificationKey,
    transitionArtifact: artifact.transitionArtifact,
  })
  const metadata = suiteGuards.requireRecord(metadataValue)
  suiteGuards.requireExactKeys(
    metadata,
    suitePreparationAlarmMetadataKeys,
  )
  const authorization = readFinalizedAlarmAuthorization(
    suiteGuards.readOwn(metadata, 'authorization'),
  )
  if (
    suiteGuards.readOwn(metadata, 'artifactByteLength') !==
      finalized.artifactByteLength ||
    suiteGuards.readDigest(
      suiteGuards.readOwn(metadata, 'artifactDigest'),
    ) !== finalized.artifactDigest ||
    suiteGuards.readOwn(metadata, 'receiptCount') !== 12 ||
    authorization.permitDigest !== finalized.authorization.permitDigest ||
    authorization.requestedResourcesBinding !==
      finalized.authorization.requestedResourcesBinding ||
    authorization.sharedSessionBindingDigest !==
      finalized.authorization.sharedSessionBindingDigest ||
    !bytesEqual(bytes, finalized.canonicalArtifactBytes)
  ) {
    return failSuiteFinalizer()
  }
  return finalized
}

/** Copies one exact transferred alarm signal key for synchronous validation. */
function copyAlarmSignalVerificationKey(value: unknown): Uint8Array {
  if (!types.isUint8Array(value) || types.isProxy(value)) {
    return failSuiteFinalizer()
  }
  const buffer = suiteGuards.readIntrinsicBuffer(value)
  if (
    types.isSharedArrayBuffer(buffer) ||
    suiteGuards.readIntrinsicByteLength(value) !==
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPT_KEY_BYTES
  ) {
    return failSuiteFinalizer()
  }
  const copied: unknown = Reflect.apply(
    Uint8Array.prototype.slice,
    value,
    [],
  )
  if (
    !(copied instanceof Uint8Array) ||
    copied.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_TELEMETRY_REHEARSAL_SIGNAL_RECEIPT_KEY_BYTES
  ) {
    return failSuiteFinalizer()
  }
  return copied
}

/** Best-effort overwrites one transferred or working alarm signal key. */
function zeroizeAlarmSignalVerificationKey(value: unknown): void {
  if (!types.isUint8Array(value) || types.isProxy(value)) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // The stable assembler boundary rejects malformed caller-owned values.
  }
}

/** Validated state shared by artifact preparation and final claims assembly. */
type PreparedSuiteState = {
  /** Complete validated claims excluding immutable publication references. */
  readonly claims: Omit<
    WorkspaceSearchMigrationRehearsalEvidenceClaims,
    'artifacts'
  >
  /** Exact canonical child artifacts in required publication order. */
  readonly artifacts: readonly InternalPreparedArtifact[]
}

/** Module-private provenance for completely validated suite capabilities. */
const finalizedSuitePreparations = new WeakMap<
  object,
  PreparedSuiteState
>()

/** Module-private replay guard for consumed suite capabilities. */
const consumedSuitePreparations = new WeakSet<object>()

/**
 * Consumes one authentic suite capability into immutable publication material.
 *
 * The returned material owns detached child bytes and permits exactly one
 * final immutable-reference binding. A plain object, structured clone, or
 * already consumed capability cannot enter the publication path.
 *
 * @param value Candidate capability returned by the suite assembler.
 * @returns Detached child artifacts and a one-shot final claims binder.
 */
export function consumeWorkspaceSearchMigrationRehearsalFinalizedSuitePreparation(
  value: unknown,
): WorkspaceSearchMigrationRehearsalSuitePublicationMaterial {
  try {
    const capability = suiteGuards.requireRecord(value)
    suiteGuards.requireExactKeys(capability, ['kind'])
    if (
      suiteGuards.readOwn(capability, 'kind') !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_SUITE_KIND ||
      consumedSuitePreparations.has(capability)
    ) {
      return failSuiteFinalizer()
    }
    const state = finalizedSuitePreparations.get(capability)
    if (state === undefined) return failSuiteFinalizer()
    finalizedSuitePreparations.delete(capability)
    consumedSuitePreparations.add(capability)
    let finalized = false
    return Object.freeze({
      artifacts: detachPreparedArtifacts(state.artifacts),
      bindings: detachSuitePublicationBindings(state.claims),
      finalize: (
        artifacts: readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[],
      ): WorkspaceSearchMigrationRehearsalEvidenceClaims => {
        if (finalized) return failSuiteFinalizer()
        finalized = true
        return finalizePreparedSuiteState(state, artifacts)
      },
    })
  } catch {
    return failSuiteFinalizer()
  }
}

/** Detaches the validated pre-write identity and measurement bindings. */
function detachSuitePublicationBindings(
  claims: Omit<WorkspaceSearchMigrationRehearsalEvidenceClaims, 'artifacts'>,
): WorkspaceSearchMigrationRehearsalSuitePublicationBindings {
  return Object.freeze({
    commit: claims.commit,
    configurationHash: claims.configurationHash,
    ratePolicyVersion: claims.ratePolicyVersion,
    startedAt: claims.startedAt,
    completedAt: claims.completedAt,
    attestation: Object.freeze({ ...claims.attestation }),
    rateAggregate: Object.freeze({ ...claims.rate.aggregate }),
  })
}

/** Detaches immutable publisher-facing bytes from one validated state. */
function detachPreparedArtifacts(
  artifacts: readonly InternalPreparedArtifact[],
): readonly WorkspaceSearchMigrationRehearsalPreparedArtifact[] {
  return Object.freeze(artifacts.map((artifact) => Object.freeze({
    kind: artifact.kind,
    canonicalBytes: new Uint8Array(artifact.canonicalBytes),
    contentDigest: artifact.contentDigest,
    byteLength: artifact.byteLength,
  })))
}

/** Binds one exact immutable publication result to validated suite state. */
function finalizePreparedSuiteState(
  state: PreparedSuiteState,
  artifacts: readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[],
): WorkspaceSearchMigrationRehearsalEvidenceClaims {
  const candidate: WorkspaceSearchMigrationRehearsalEvidenceClaims = {
    ...state.claims,
    artifacts,
  }
  const validated = validateAndDetachClaims(candidate)
  requireChildArtifactBindings(
    validated.artifacts,
    state.artifacts,
    state.claims.completedAt,
  )
  return Object.freeze(validated)
}

/** Inputs already authenticated by the suite assembler's one-shot boundaries. */
type PrepareAuthenticatedStageSuiteStateInput = {
  /** Re-derived real alarm transitions and dual-route receipts. */
  readonly alarm: WorkspaceSearchMigrationRehearsalFinalizedAlarmEvidence
  /** Working parent key authenticating the final combined alarm artifact. */
  readonly alarmPublicationVerificationKey: Uint8Array
  /** Working key authenticating the actual EMF signal receipt chain. */
  readonly alarmSignalVerificationKey: Uint8Array
  /** Verified non-production caller, resource, permit, and isolation claims. */
  readonly attestation: WorkspaceSearchMigrationRehearsalAttestationEvidence
  /** Exact reviewed implementation commit. */
  readonly commit: string
  /** Trusted completion after the final live rate measurement. */
  readonly completedAt: string
  /** Reviewed measured configuration digest. */
  readonly configurationHash: string
  /** Authenticated complete actual-rate stream including final measurement. */
  readonly rate: WorkspaceSearchMigrationRehearsalFinalizedRateEvidence
  /** Reviewed DescribeTable policy digest. */
  readonly ratePolicyVersion: string
  /** Canonical exact authenticated terminal reconciliation bindings. */
  readonly reconciliation:
    readonly WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[]
  /** Authenticated complete control-stage chain. */
  readonly stageChain: WorkspaceSearchMigrationRehearsalStageChainEvidence
  /** Canonical beginning of the first authenticated control stage. */
  readonly startedAt: string
}

/** Scenario claims and canonical ledgers derived from the stage chain. */
type StageBoundScenarioState = {
  /** Eight strict public scenario projections. */
  readonly scenarios:
    readonly WorkspaceSearchMigrationRehearsalScenarioEvidence[]
  /** Eight authenticated close-through-release ledgers. */
  readonly ledgers:
    readonly WorkspaceSearchMigrationRehearsalSuitePhaseLedger[]
}

/** Creates final state only from already authenticated one-shot capabilities. */
function prepareAuthenticatedStageSuiteState(
  input: PrepareAuthenticatedStageSuiteStateInput,
): PreparedSuiteState {
  if (
    input.stageChain.commit !== input.commit ||
    input.stageChain.permitDigest !== input.attestation.permitDigest ||
    input.stageChain.configurationBindingDigest !==
      input.configurationHash ||
    input.stageChain.policyVersion !== input.ratePolicyVersion ||
    input.stageChain.startedAt !== input.startedAt ||
    Date.parse(input.stageChain.reviewedAt) > Date.parse(input.startedAt) ||
    Date.parse(input.stageChain.completedAt) >= Date.parse(input.completedAt)
  ) {
    return failSuiteFinalizer()
  }
  const stageScenarios = requireCanonicalStageChainScenarios(input.stageChain)
  requireStageChainReconciliationBindings(
    stageScenarios,
    input.reconciliation,
    input.stageChain,
  )
  requireStageChainTargetBindings(
    stageScenarios,
    input.reconciliation,
  )
  const scenarioState = createStageBoundScenarioState(
    stageScenarios,
    input.configurationHash,
    input.startedAt,
    input.completedAt,
  )
  const rate = readFinalizedRate(
    input.rate,
    input.configurationHash,
    input.ratePolicyVersion,
    input.startedAt,
    input.completedAt,
  )
  requireStageChainRateBindings(
    stageScenarios,
    input.reconciliation,
    rate,
    input.completedAt,
  )
  const reconciliation = createPublicReconciliationEvidence(
    input.reconciliation,
  )
  const preliminary: WorkspaceSearchMigrationRehearsalEvidenceClaims = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_KIND,
    contractVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_VERSION,
    commit: input.commit,
    attestation: input.attestation,
    configurationHash: input.configurationHash,
    ratePolicyVersion: input.ratePolicyVersion,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    scenarios: scenarioState.scenarios,
    reconciliation,
    rate: rate.evidence,
    alarms: readAlarmEvidenceProjection(input.alarm),
    dlq: {
      status: 'not-applicable',
      executionModel: 'synchronous-migration',
    },
    artifacts: createStructuralArtifactReferences(input.completedAt),
    overallStatus: 'pass',
  }
  const structurallyValidated = validateAndDetachClaims(preliminary)
  const alarm = readFinalizedAlarmEvidence(
    input.alarm,
    structurallyValidated.alarms,
    structurallyValidated.commit,
    structurallyValidated.attestation,
    input.startedAt,
    input.completedAt,
    input.alarmSignalVerificationKey,
    input.alarmPublicationVerificationKey,
  )
  const claimsWithoutArtifacts: Omit<
    WorkspaceSearchMigrationRehearsalEvidenceClaims,
    'artifacts'
  > = {
    kind: structurallyValidated.kind,
    contractVersion: structurallyValidated.contractVersion,
    commit: structurallyValidated.commit,
    attestation: structurallyValidated.attestation,
    configurationHash: structurallyValidated.configurationHash,
    ratePolicyVersion: structurallyValidated.ratePolicyVersion,
    startedAt: structurallyValidated.startedAt,
    completedAt: structurallyValidated.completedAt,
    scenarios: structurallyValidated.scenarios,
    reconciliation: structurallyValidated.reconciliation,
    rate: structurallyValidated.rate,
    alarms: alarm.evidence,
    dlq: structurallyValidated.dlq,
    overallStatus: structurallyValidated.overallStatus,
  }
  const artifacts = createPreparedChildArtifacts(
    claimsWithoutArtifacts,
    scenarioState.ledgers,
    rate,
    alarm,
  )
  const finalValidation = validateAndDetachClaims({
    ...claimsWithoutArtifacts,
    artifacts: createValidationArtifactReferences(
      artifacts,
      input.completedAt,
    ),
  })
  requireChildArtifactBindings(
    finalValidation.artifacts,
    artifacts,
    input.completedAt,
  )
  return Object.freeze({
    claims: Object.freeze({
      kind: finalValidation.kind,
      contractVersion: finalValidation.contractVersion,
      commit: finalValidation.commit,
      attestation: finalValidation.attestation,
      configurationHash: finalValidation.configurationHash,
      ratePolicyVersion: finalValidation.ratePolicyVersion,
      startedAt: finalValidation.startedAt,
      completedAt: finalValidation.completedAt,
      scenarios: finalValidation.scenarios,
      reconciliation: finalValidation.reconciliation,
      rate: finalValidation.rate,
      alarms: finalValidation.alarms,
      dlq: finalValidation.dlq,
      overallStatus: finalValidation.overallStatus,
    }),
    artifacts,
  })
}

/** Requires the complete canonical chain order and its global receipt bounds. */
function requireCanonicalStageChainScenarios(
  chain: WorkspaceSearchMigrationRehearsalStageChainEvidence,
): readonly WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence[] {
  const scenarios = chain.scenarios
  if (
    scenarios.length !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS.length
  ) {
    return failSuiteFinalizer()
  }
  const receiptDigests: string[] = []
  const outputLineDigests = new Set<string>()
  const reservationDigests = new Set<string>()
  let previousCompletedAt: string | undefined
  let previousCommitRevision = 0
  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index]
    const expectedName = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS[index]
    if (
      scenario === undefined ||
      expectedName === undefined ||
      scenario.name !== expectedName ||
      scenario.stageReceiptDigests.length < 1 ||
      scenario.stageReceiptDigests.length !==
        scenario.serializedOutputLineDigests.length ||
      scenario.stageReceiptDigests.length !==
        scenario.rateSegmentBindings.length ||
      scenario.stageReceiptDigests.length !==
        scenario.stageReservationDigests.length ||
      scenario.stageReceiptDigests.length !==
        scenario.stageReservationClaimRevisions.length ||
      scenario.stageReceiptDigests.length !==
        scenario.stageReservationCommitRevisions.length ||
      (previousCompletedAt !== undefined &&
        Date.parse(scenario.startedAt) <= Date.parse(previousCompletedAt))
    ) {
      return failSuiteFinalizer()
    }
    readBoundFaultObservation(
      scenario.faultObservation,
      scenario.faultObservationDigest,
      readExpectedFailpoint(expectedName),
    )
    previousCompletedAt = scenario.completedAt
    receiptDigests.push(...scenario.stageReceiptDigests)
    for (const digest of scenario.serializedOutputLineDigests) {
      if (outputLineDigests.has(digest)) return failSuiteFinalizer()
      outputLineDigests.add(digest)
    }
    for (let stageIndex = 0;
      stageIndex < scenario.stageReservationDigests.length;
      stageIndex += 1) {
      const reservationDigest =
        scenario.stageReservationDigests[stageIndex]
      const claimRevision =
        scenario.stageReservationClaimRevisions[stageIndex]
      const commitRevision =
        scenario.stageReservationCommitRevisions[stageIndex]
      if (
        reservationDigest === undefined ||
        claimRevision === undefined ||
        commitRevision === undefined ||
        reservationDigests.has(reservationDigest) ||
        claimRevision <= previousCommitRevision ||
        commitRevision !== claimRevision + 1
      ) return failSuiteFinalizer()
      reservationDigests.add(reservationDigest)
      previousCommitRevision = commitRevision
    }
  }
  if (
    receiptDigests.length !== chain.receiptCount ||
    new Set(receiptDigests).size !== receiptDigests.length ||
    receiptDigests[0] !== chain.firstStageReceiptDigest ||
    receiptDigests.at(-1) !== chain.terminalStageReceiptDigest ||
    scenarios[0]?.startedAt !== chain.startedAt ||
    scenarios.at(-1)?.completedAt !== chain.completedAt
  ) {
    return failSuiteFinalizer()
  }
  return scenarios
}

/** Requires every authenticated reconciliation audit to match its terminal. */
function requireStageChainReconciliationBindings(
  scenarios:
    readonly WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence[],
  bindings:
    readonly WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[],
  chain: WorkspaceSearchMigrationRehearsalStageChainEvidence,
): void {
  if (bindings.length !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS.length) {
    return failSuiteFinalizer()
  }
  for (let index = 0; index < bindings.length; index += 1) {
    const scenario = scenarios[index]
    const binding = bindings[index]
    const expectedName = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS[index]
    if (
      scenario === undefined ||
      binding === undefined ||
      expectedName === undefined ||
      scenario.name !== expectedName ||
      binding.scenario !== expectedName ||
      binding.configurationBindingDigest !==
        chain.configurationBindingDigest ||
      serializeCanonicalJson(createReconciliationContext(binding)) !==
        serializeCanonicalJson(scenario.reconciliationContext) ||
      scenario.reconciliationArtifactBindingDigest !==
        createMigrationDigest(binding) ||
      scenario.reconciliationArtifactContentDigest !==
        binding.contentDigest ||
      scenario.reconciliationArtifactByteLength !== binding.byteLength ||
      scenario.reconciliationArtifactAuditDigest !== binding.auditDigest ||
      serializeCanonicalJson(scenario.reconciliationRate) !==
        serializeCanonicalJson(binding.rate) ||
      binding.duplicateApplyCount !== 0 ||
      binding.lostItemCount !== 0 ||
      binding.orphanAuthorityCount !== 0
    ) {
      return failSuiteFinalizer()
    }
    const integrityResults = binding.integrity.kind === 'verified-result'
      ? [binding.integrity.result]
      : [binding.integrity.before, binding.integrity.after]
    if (integrityResults.some((result) =>
      result.resourceIdentityScheme !==
        chain.integrityResourceIdentityScheme ||
      serializeCanonicalJson(result.resourceIdentities) !==
        serializeCanonicalJson(chain.integrityResourceIdentities) ||
      result.resourceIdentityDigest !==
        chain.integrityResourceIdentityDigest
    )) return failSuiteFinalizer()
    requireStageReconciliationIntegrityBinding(scenario, binding)
  }
}

/**
 * Creates the exact context projection authenticated before artifact creation.
 *
 * @param binding - Fully authenticated reconciliation artifact binding.
 * @returns Exact stage-owned reconciliation context projection.
 */
function createReconciliationContext(
  binding: WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
) {
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

/** Requires one scenario's legacy stage digest fields to match its audit. */
function requireStageReconciliationIntegrityBinding(
  scenario: WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence,
  binding: WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding,
): void {
  const integrity = binding.integrity
  if (integrity.kind === 'verified-result') {
    if (
      scenario.integrityPurpose !== 'verified' ||
      scenario.integrityBeforeResultDigest !== null ||
      scenario.integrityAfterResultDigest !== integrity.result.resultDigest ||
      scenario.integrityComparisonDigest !== null ||
      scenario.integrityContextDigest !== integrity.resultContextDigest
    ) {
      return failSuiteFinalizer()
    }
    return
  }
  if (
    scenario.integrityPurpose !== integrity.purpose ||
    scenario.integrityBeforeResultDigest !== integrity.before.resultDigest ||
    scenario.integrityAfterResultDigest !== integrity.after.resultDigest ||
    scenario.integrityComparisonDigest !== integrity.comparisonDigest ||
    scenario.integrityContextDigest !== integrity.comparisonContextDigest
  ) {
    return failSuiteFinalizer()
  }
}

/** Creates canonical public summaries from authenticated audit bindings. */
function createPublicReconciliationEvidence(
  bindings:
    readonly WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[],
): WorkspaceSearchMigrationRehearsalReconciliationEvidence {
  return Object.freeze(bindings.map(
    (binding): WorkspaceSearchMigrationRehearsalReconciliationSummaryEvidence =>
      Object.freeze({
        scenario: binding.scenario,
        status: 'pass',
        runLocatorDigest: binding.runLocatorDigest,
        configurationBindingDigest: binding.configurationBindingDigest,
        sealedPlanningAuthorityDigest:
          binding.sealedPlanningAuthorityDigest,
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
        markerSummaryDigest: binding.markerSummary.summaryDigest,
        authoritySummaryDigest: binding.authoritySummary.summaryDigest,
        sourceTargetSummaryDigest: binding.sourceTargetSummary.summaryDigest,
        rateAuthenticationKeyFingerprint:
          binding.rate.successor.authenticationKeyFingerprint,
        rateSegmentLocatorDigest:
          binding.rate.successor.segmentLocatorDigest,
        rateSegmentOrdinal: binding.rate.successor.segmentOrdinal,
        rateSegmentDigest: binding.rate.successor.segmentDigest,
        duplicateApplyCount: 0,
        lostItemCount: 0,
        orphanAuthorityCount: 0,
        contentDigest: binding.contentDigest,
        byteLength: binding.byteLength,
        auditDigest: binding.auditDigest,
      }),
  ))
}

/** Requires four independent authenticated target audits to match rollbacks. */
function requireStageChainTargetBindings(
  scenarios:
    readonly WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence[],
  reconciliation:
    readonly WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[],
): void {
  const partialScenario = requireStageScenarioAt(
    scenarios,
    6,
    'partial-apply-rollback',
  )
  const completeScenario = requireStageScenarioAt(
    scenarios,
    7,
    'complete-apply-rollback',
  )
  const partialReconciliation = reconciliation[6]
  const completeReconciliation = reconciliation[7]
  if (
    partialReconciliation?.integrity.kind !== 'rollback-comparison' ||
    completeReconciliation?.integrity.kind !== 'rollback-comparison' ||
    partialReconciliation.targetAudits === null ||
    completeReconciliation.targetAudits === null
  ) {
    return failSuiteFinalizer()
  }
  const partialAudits = partialReconciliation.targetAudits
  const completeAudits = completeReconciliation.targetAudits
  const audits = [
    partialAudits.preimage,
    partialAudits.restored,
    completeAudits.preimage,
    completeAudits.restored,
  ]
  if (
    new Set(audits.map((audit) => audit.contentDigest)).size !== 4 ||
    new Set(audits.map((audit) => audit.observationDigest)).size !== 4 ||
    new Set(audits.map((audit) =>
      audit.rate.successor.segmentDigest
    )).size !== 4 ||
    new Set(audits.map((audit) =>
      audit.rate.successor.segmentLocatorDigest
    )).size !== 4 ||
    partialAudits.preimage.purpose !== 'partial-rollback-preimage' ||
    partialAudits.restored.purpose !== 'partial-rollback-restored' ||
    completeAudits.preimage.purpose !== 'complete-rollback-preimage' ||
    completeAudits.restored.purpose !== 'complete-rollback-restored' ||
    partialReconciliation.integrity.purpose !== 'partial-rollback' ||
    completeReconciliation.integrity.purpose !== 'complete-rollback' ||
    partialReconciliation.integrity.targetPreimageAggregateDigest !==
      partialAudits.preimage.aggregateDigest ||
    partialReconciliation.integrity.targetRestoredAggregateDigest !==
      partialAudits.restored.aggregateDigest ||
    completeReconciliation.integrity.targetPreimageAggregateDigest !==
      completeAudits.preimage.aggregateDigest ||
    completeReconciliation.integrity.targetRestoredAggregateDigest !==
      completeAudits.restored.aggregateDigest ||
    partialAudits.preimage.contextDigest !==
      partialAudits.restored.contextDigest ||
    completeAudits.preimage.contextDigest !==
      completeAudits.restored.contextDigest ||
    partialAudits.preimage.contextDigest ===
      completeAudits.preimage.contextDigest ||
    partialScenario.targetPreimageArtifactContentDigest !==
      partialAudits.preimage.contentDigest ||
    completeScenario.targetPreimageArtifactContentDigest !==
      completeAudits.preimage.contentDigest ||
    partialScenario.targetRollbackArtifactContentDigest !==
      partialAudits.restored.contentDigest ||
    completeScenario.targetRollbackArtifactContentDigest !==
      completeAudits.restored.contentDigest ||
    partialScenario.targetRollbackObservationDigest !==
      partialAudits.restored.observationDigest ||
    completeScenario.targetRollbackObservationDigest !==
      completeAudits.restored.observationDigest ||
    Date.parse(partialAudits.preimage.observedAt) <
      Date.parse(partialScenario.integrityWindowStartedAt) ||
    Date.parse(partialAudits.preimage.observedAt) >=
      Date.parse(partialScenario.applyStartedAt) ||
    Date.parse(completeAudits.preimage.observedAt) <
      Date.parse(completeScenario.integrityWindowStartedAt) ||
    Date.parse(completeAudits.preimage.observedAt) >=
      Date.parse(completeScenario.applyStartedAt) ||
    !timestampWithinInclusiveWindow(
      partialAudits.restored.observedAt,
      partialScenario.terminalRootPublishedAt,
      partialScenario.releasedAt,
    ) ||
    !timestampWithinInclusiveWindow(
      completeAudits.restored.observedAt,
      completeScenario.terminalRootPublishedAt,
      completeScenario.releasedAt,
    )
  ) {
    return failSuiteFinalizer()
  }
  for (let index = 0; index <= 5; index += 1) {
    const scenario = scenarios[index]
    const audit = reconciliation[index]
    if (
      scenario === undefined ||
      audit === undefined ||
      audit.targetAudits !== null ||
      scenario.targetPreimageArtifactContentDigest !== null ||
      scenario.targetRollbackArtifactContentDigest !== null ||
      scenario.targetRollbackObservationDigest !== null
    ) {
      return failSuiteFinalizer()
    }
  }
}

/** Returns whether one timestamp falls inside an inclusive canonical window. */
function timestampWithinInclusiveWindow(
  value: string,
  startedAt: string,
  completedAt: string,
): boolean {
  const observed = Date.parse(value)
  return observed >= Date.parse(startedAt) &&
    observed <= Date.parse(completedAt)
}

/** Reads one already ordered stage scenario at its fixed canonical position. */
function requireStageScenarioAt(
  scenarios:
    readonly WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence[],
  index: number,
  name: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence {
  const scenario = scenarios[index]
  if (scenario === undefined || scenario.name !== name) {
    return failSuiteFinalizer()
  }
  return scenario
}

/** Derives public scenarios and strict lifecycle ledgers from stage receipts. */
function createStageBoundScenarioState(
  stageScenarios:
    readonly WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence[],
  configurationHash: string,
  suiteStartedAt: string,
  suiteCompletedAt: string,
): StageBoundScenarioState {
  const scenarios: WorkspaceSearchMigrationRehearsalScenarioEvidence[] = []
  const ledgers: WorkspaceSearchMigrationRehearsalSuitePhaseLedger[] = []
  const suiteDigests = new Set<string>()
  let previousProcessCompletedAt: string | undefined
  for (let index = 0; index < stageScenarios.length; index += 1) {
    const stage = stageScenarios[index]
    const expectedName = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS[index]
    if (
      stage === undefined ||
      expectedName === undefined ||
      stage.name !== expectedName ||
      stage.failpoint !== readExpectedFailpoint(expectedName) ||
      stage.attempts.length < 1 ||
      stage.attempts.length > 2
    ) {
      return failSuiteFinalizer()
    }
    requireStageScenarioReconciliationAudit(stage)
    const ledger = createStageScenarioLedger(
      stage,
      configurationHash,
      suiteStartedAt,
      suiteCompletedAt,
    )
    const attempts = Object.freeze(stage.attempts.map((attempt) =>
      createStageAttemptEvidence(stage.name, attempt)
    ))
    const firstAttempt = attempts[0]
    const lastAttempt = attempts.at(-1)
    if (
      firstAttempt === undefined ||
      lastAttempt === undefined ||
      firstAttempt.startedAt !== stage.startedAt ||
      lastAttempt.completedAt !== stage.completedAt ||
      Date.parse(lastAttempt.completedAt) >= Date.parse(suiteCompletedAt) ||
      (index === 0 && firstAttempt.startedAt !== suiteStartedAt) ||
      (previousProcessCompletedAt !== undefined &&
        Date.parse(firstAttempt.startedAt) <=
          Date.parse(previousProcessCompletedAt))
    ) {
      return failSuiteFinalizer()
    }
    previousProcessCompletedAt = lastAttempt.completedAt
    const scenario: WorkspaceSearchMigrationRehearsalScenarioEvidence =
      Object.freeze({
        name: stage.name,
        status: 'pass',
        startedAt: firstAttempt.startedAt,
        completedAt: lastAttempt.completedAt,
        failpoint: stage.failpoint,
        triggerDigest: stage.faultReceiptDigest,
        runLocatorDigest: stage.runLocatorDigest,
        lifecycleDigest: stage.attemptLifecycleDigest,
        faultReachedAt: stage.faultReachedAt,
        killConfirmedAt: stage.killConfirmedAt,
        predecessorLeaseExpiresAt: stage.predecessorLeaseExpiresAt,
        takeoverAcquiredAt: stage.takeoverAcquiredAt,
        reconciledAt: stage.reconciledAt,
        attempts,
        duplicateApplyCount: stage.duplicateApplyCount,
        lostItemCount: stage.lostItemCount,
        orphanAuthorityCount: stage.orphanAuthorityCount,
        terminal: Object.freeze({
          kind: stage.terminalKind,
          version: stage.terminalPersistenceVersion,
          rootDigest: stage.terminalRootDigest,
          releasedFenceDigest: stage.releasedFenceDigest,
        }),
      })
    for (const digest of [
      stage.runLocatorDigest,
      stage.attemptLifecycleDigest,
      ledger.ledgerDigest,
      ledger.closeEvidenceDigest,
      ledger.drainEvidenceDigest,
      ledger.sealedPlanDigest,
      ledger.applyEvidenceDigest,
      ledger.terminalEvidenceDigest,
      stage.terminalRootDigest,
      stage.releasedFenceDigest,
      stage.reconciliationAuditDigest,
      ...attempts.flatMap((attempt) => [
        attempt.attemptLocatorDigest,
        attempt.ownerLocatorDigest,
        attempt.writerFenceDigest,
      ]),
      ...(stage.faultReceiptDigest === null
        ? []
        : [stage.faultReceiptDigest]),
      ...(stage.faultObservationDigest === null
        ? []
        : [stage.faultObservationDigest]),
    ]) {
      if (suiteDigests.has(digest)) return failSuiteFinalizer()
      suiteDigests.add(digest)
    }
    ledgers.push(ledger)
    scenarios.push(scenario)
  }
  return Object.freeze({
    scenarios: Object.freeze(scenarios),
    ledgers: Object.freeze(ledgers),
  })
}

/** Reproduces the exact strict phase ledger from one authenticated projection. */
function createStageScenarioLedger(
  stage: WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence,
  configurationHash: string,
  suiteStartedAt: string,
  suiteCompletedAt: string,
): WorkspaceSearchMigrationRehearsalSuitePhaseLedger {
  const drainDurationMilliseconds =
    Date.parse(stage.drainCompletedAt) - Date.parse(stage.drainStartedAt)
  const faultObservation = readBoundFaultObservation(
    stage.faultObservation,
    stage.faultObservationDigest,
    readExpectedFailpoint(stage.name),
  )
  const payload: Omit<
    WorkspaceSearchMigrationRehearsalSuitePhaseLedger,
    'ledgerDigest'
  > = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_KIND,
    ledgerVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_VERSION,
    scenario: stage.name,
    configurationHash,
    runLocatorDigest: stage.runLocatorDigest,
    writersClosedAt: stage.writersClosedAt,
    closeEvidenceDigest: stage.closeEvidenceDigest,
    drainStartedAt: stage.drainStartedAt,
    drainCompletedAt: stage.drainCompletedAt,
    drainDurationMilliseconds,
    activeWriterCount: 0,
    drainEvidenceDigest: stage.drainEvidenceDigest,
    replannedAt: stage.replannedAt,
    sealedPlanDigest: stage.sealedPlanDigest,
    sealedPlanOperationCount: stage.sealedPlanOperationCount,
    applyStartedAt: stage.applyStartedAt,
    applyBoundaryAt: stage.applyBoundaryAt,
    applyBoundary: stage.name === 'partial-apply-rollback'
      ? 'committed-prefix'
      : 'complete',
    appliedOperationCount: stage.appliedOperationCount,
    applyEvidenceDigest: stage.applyEvidenceDigest,
    faultObservationDigest: faultObservation.faultObservationDigest,
    faultObservation: faultObservation.faultObservation,
    terminalAction: stage.terminalAction,
    terminalStartedAt: stage.terminalStartedAt,
    terminalCompletedAt: stage.terminalCompletedAt,
    terminalEvidenceDigest: stage.terminalEvidenceDigest,
    stageReceiptDigests: Object.freeze([...stage.stageReceiptDigests]),
    stageReservationDigests: Object.freeze([
      ...stage.stageReservationDigests,
    ]),
    stageReservationClaimRevisions: Object.freeze([
      ...stage.stageReservationClaimRevisions,
    ]),
    stageReservationCommitRevisions: Object.freeze([
      ...stage.stageReservationCommitRevisions,
    ]),
    rateSegmentBindings: Object.freeze(
      stage.rateSegmentBindings.map(detachStageRateSegmentBinding),
    ),
    releasedAt: stage.releasedAt,
    release: Object.freeze({
      mode: 'release',
      phase: 'released',
      writerFenceMode: 'open',
      writerFenceVersion: 2,
      terminalKind: stage.terminalKind,
      terminalPersistenceVersion: stage.terminalPersistenceVersion,
      terminalRootDigest: stage.terminalRootDigest,
      writerFenceRecordDigest: stage.releasedFenceDigest,
    }),
  }
  return readPhaseLedger(
    Object.freeze({
      ...payload,
      ledgerDigest: createMigrationDigest(payload),
    }),
    stage.name,
    configurationHash,
    suiteStartedAt,
    suiteCompletedAt,
  )
}

/** Removes stage ownership fields from one authenticated rate binding. */
function detachStageRateSegmentBinding(
  binding: WorkspaceSearchMigrationRehearsalStageRateSegmentBinding,
): WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt {
  return Object.freeze({
    authenticationKeyFingerprint: binding.authenticationKeyFingerprint,
    segmentLocatorDigest: binding.segmentLocatorDigest,
    segmentOrdinal: binding.segmentOrdinal,
    firstEventSequence: binding.firstEventSequence,
    eventCount: binding.eventCount,
    firstCommittedEventSequence: binding.firstCommittedEventSequence,
    lastCommittedEventSequence: binding.lastCommittedEventSequence,
    terminalRecordMac: binding.terminalRecordMac,
    segmentDigest: binding.segmentDigest,
  })
}

/** Derives one external attempt while retaining all authenticated fence facts. */
function createStageAttemptEvidence(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  attempt: WorkspaceSearchMigrationRehearsalStageChainAttempt,
): WorkspaceSearchMigrationRehearsalAttemptEvidence {
  if (
    attempt.writerFenceDigests.length < 1 ||
    attempt.processLifecycleDigests.length < 1 ||
    Date.parse(attempt.startedAt) >= Date.parse(attempt.processExitedAt) ||
    Date.parse(attempt.completedAt) > Date.parse(attempt.processExitedAt)
  ) {
    return failSuiteFinalizer()
  }
  return Object.freeze({
    ordinal: attempt.ordinal,
    attemptLocatorDigest: attempt.attemptLocatorDigest,
    ownerLocatorDigest: attempt.ownerLocatorDigest,
    writerFenceDigest: createMigrationDigest({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-attempt-writer-fences',
      version: 1,
      scenario,
      ordinal: attempt.ordinal,
      writerFenceDigests: attempt.writerFenceDigests,
      processLifecycleDigests: attempt.processLifecycleDigests,
    }),
    startedAt: attempt.startedAt,
    completedAt: attempt.processExitedAt,
    outcome: attempt.outcome,
    faultReceiptDigest: attempt.faultReceiptDigest,
  })
}

/** Reproduces the terminal audit digest committed by one stage scenario. */
function requireStageScenarioReconciliationAudit(
  scenario: WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence,
): void {
  const expected =
    createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest({
      scenario: scenario.name,
      terminalRootDigest: scenario.terminalRootDigest,
      integrityContextDigest: scenario.integrityContextDigest,
      targetPreimageArtifactContentDigest:
        scenario.targetPreimageArtifactContentDigest,
      targetRollbackArtifactContentDigest:
        scenario.targetRollbackArtifactContentDigest,
      targetRollbackObservationDigest:
        scenario.targetRollbackObservationDigest,
      duplicateApplyCount: scenario.duplicateApplyCount,
      lostItemCount: scenario.lostItemCount,
      orphanAuthorityCount: scenario.orphanAuthorityCount,
    })
  if (scenario.reconciliationAuditDigest !== expected) {
    return failSuiteFinalizer()
  }
}

/** Requires all 48 scenario segments plus one fresh publication measurement. */
function requireStageChainRateBindings(
  scenarios:
    readonly WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence[],
  reconciliation:
    readonly WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[],
  rate: ParsedFinalizedRate,
  suiteCompletedAt: string,
): void {
  const expected: WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt[] =
    []
  for (let index = 0; index < scenarios.length; index += 1) {
    const scenario = scenarios[index]
    const audit = reconciliation[index]
    if (scenario === undefined || audit === undefined) {
      return failSuiteFinalizer()
    }
    const stages = scenario.rateSegmentBindings
    if (stages.length < 2) return failSuiteFinalizer()
    if (
      scenario.name === 'partial-apply-rollback' ||
      scenario.name === 'complete-apply-rollback'
    ) {
      const targetAudits = audit.targetAudits
      if (targetAudits === null) return failSuiteFinalizer()
      appendStageRateSegment(expected, stages[0])
      appendAuxiliaryRateSegment(expected, targetAudits.preimage.rate)
      for (let stageIndex = 1; stageIndex < stages.length - 1; stageIndex += 1) {
        appendStageRateSegment(expected, stages[stageIndex])
      }
      appendAuxiliaryRateSegment(expected, targetAudits.restored.rate)
      appendAuxiliaryRateSegment(expected, audit.rate)
      appendStageRateSegment(expected, stages.at(-1))
      continue
    }
    for (let stageIndex = 0; stageIndex < stages.length - 1; stageIndex += 1) {
      appendStageRateSegment(expected, stages[stageIndex])
    }
    appendAuxiliaryRateSegment(expected, audit.rate)
    appendStageRateSegment(expected, stages.at(-1))
  }
  if (expected.length !== 48 || rate.segmentBindings.length !== 49) {
    return failSuiteFinalizer()
  }
  const locators = new Set<string>()
  const digests = new Set<string>()
  const macs = new Set<string>()
  const fingerprint = rate.segmentBindings[0]?.authenticationKeyFingerprint
  for (let index = 0; index < rate.segmentBindings.length; index += 1) {
    const expectedBinding = expected[index]
    const finalized = rate.segmentBindings[index]
    if (
      finalized === undefined ||
      finalized.segmentOrdinal !== index ||
      finalized.authenticationKeyFingerprint !== fingerprint ||
      locators.has(finalized.segmentLocatorDigest) ||
      digests.has(finalized.segmentDigest) ||
      macs.has(finalized.terminalRecordMac) ||
      (index < expected.length &&
        (expectedBinding === undefined ||
          !sameRateSegment(expectedBinding, finalized)))
    ) {
      return failSuiteFinalizer()
    }
    locators.add(finalized.segmentLocatorDigest)
    digests.add(finalized.segmentDigest)
    macs.add(finalized.terminalRecordMac)
  }
  const finalScenario = scenarios.at(-1)
  const finalAttempt = finalScenario?.attempts.at(-1)
  if (finalAttempt === undefined) return failSuiteFinalizer()
  requireFreshPublicationRateSegment(
    rate,
    expected.length,
    finalAttempt.processExitedAt,
    suiteCompletedAt,
  )
}

/** Appends one stage-owned segment at its exact global stream position. */
function appendStageRateSegment(
  expected: WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt[],
  binding: WorkspaceSearchMigrationRehearsalStageRateSegmentBinding | undefined,
): void {
  if (
    binding === undefined ||
    binding.segmentOrdinal !== expected.length ||
    binding.stageReceiptDigest.length !== 64
  ) {
    return failSuiteFinalizer()
  }
  expected.push(detachStageRateSegmentBinding(binding))
}

/** Appends one authenticated auxiliary successor and verifies its predecessor. */
function appendAuxiliaryRateSegment(
  expected: WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt[],
  evidence: WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
): void {
  const predecessor = expected.at(-1)
  if (
    predecessor === undefined ||
    !sameRateSegment(predecessor, evidence.predecessor) ||
    evidence.successor.segmentOrdinal !== expected.length ||
    evidence.authenticationKeyFingerprint !==
      predecessor.authenticationKeyFingerprint ||
    evidence.authenticationKeyFingerprint !==
      evidence.successor.authenticationKeyFingerprint
  ) {
    return failSuiteFinalizer()
  }
  expected.push(Object.freeze({
    authenticationKeyFingerprint:
      evidence.successor.authenticationKeyFingerprint,
    segmentLocatorDigest: evidence.successor.segmentLocatorDigest,
    segmentOrdinal: evidence.successor.segmentOrdinal,
    firstEventSequence: evidence.successor.firstEventSequence,
    eventCount: evidence.successor.eventCount,
    firstCommittedEventSequence:
      evidence.successor.firstCommittedEventSequence,
    lastCommittedEventSequence:
      evidence.successor.lastCommittedEventSequence,
    terminalRecordMac: evidence.successor.terminalRecordMac,
    segmentDigest: evidence.successor.segmentDigest,
  }))
}

/** Returns whether two authenticated rate summaries are exactly identical. */
function sameRateSegment(
  left: WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt,
  right:
    | WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt
    | WorkspaceSearchMigrationRehearsalRateSegmentEvidence['predecessor'],
): boolean {
  return serializeCanonicalJson(left) === serializeCanonicalJson(right)
}

/** Requires the only unassigned segment to be a fresh measurement session. */
function requireFreshPublicationRateSegment(
  rate: ParsedFinalizedRate,
  expectedOrdinal: number,
  stageProcessesCompletedAt: string,
  suiteCompletedAt: string,
): void {
  const finalized = rate.segmentBindings[expectedOrdinal]
  if (
    finalized === undefined ||
    finalized.segmentOrdinal !== expectedOrdinal ||
    finalized.eventCount < 1
  ) {
    return failSuiteFinalizer()
  }
  const text = new TextDecoder('utf-8', { fatal: true })
    .decode(rate.artifactBytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return failSuiteFinalizer()
  }
  const artifact = suiteGuards.requireRecord(parsed)
  const segments = readExactArray(
    suiteGuards.readOwn(artifact, 'segments'),
    rate.segmentBindings.length,
  )
  const segment = suiteGuards.requireRecord(segments[expectedOrdinal])
  suiteGuards.requireExactKeys(segment, ['events', 'header'])
  const header = suiteGuards.requireRecord(
    suiteGuards.readOwn(segment, 'header'),
  )
  const anchorUtc = suiteGuards.readTimestamp(
    suiteGuards.readOwn(header, 'anchorUtc'),
  )
  if (
    suiteGuards.readOwn(header, 'segmentOrdinal') !== expectedOrdinal ||
    Date.parse(anchorUtc) < Date.parse(stageProcessesCompletedAt) ||
    Date.parse(anchorUtc) > Date.parse(suiteCompletedAt)
  ) {
    return failSuiteFinalizer()
  }
  const events = readExactArray(
    suiteGuards.readOwn(segment, 'events'),
    finalized.eventCount,
  )
  let startedAttemptCount = 0
  for (const eventValue of events) {
    const event = suiteGuards.requireRecord(eventValue)
    const offsetMilliseconds = readNonNegativeCount(
      suiteGuards.readOwn(event, 'offsetMilliseconds'),
      24 * 60 * 60 * 1_000,
    )
    const eventTime = Date.parse(anchorUtc) + offsetMilliseconds
    if (
      suiteGuards.readOwn(event, 'phase') !== 'measurement' ||
      !Number.isSafeInteger(eventTime) ||
      eventTime < Date.parse(stageProcessesCompletedAt) ||
      eventTime > Date.parse(suiteCompletedAt)
    ) {
      return failSuiteFinalizer()
    }
    if (suiteGuards.readOwn(event, 'kind') === 'attempt-started') {
      startedAttemptCount += 1
    }
  }
  if (startedAttemptCount < 1) return failSuiteFinalizer()
}

/** Actual alarm evidence paired with its collector-authenticated receipts. */
type ParsedFinalizedAlarm = {
  /** Six strict transition and dual-delivery evidence records. */
  readonly evidence: readonly WorkspaceSearchMigrationRehearsalAlarmEvidence[]
  /** Detached combined authorization, history, and twelve-receipt bytes. */
  readonly artifactBytes: Uint8Array
  /** SHA-256 digest of the exact combined alarm artifact bytes. */
  readonly artifactDigest: string
  /** Exact canonical combined alarm artifact byte length. */
  readonly artifactByteLength: number
}

/** Verifies finalized alarm evidence against exact authorized collector bytes. */
function readFinalizedAlarmEvidence(
  value: WorkspaceSearchMigrationRehearsalFinalizedAlarmEvidence,
  alarms: readonly WorkspaceSearchMigrationRehearsalAlarmEvidence[],
  commit: string,
  attestation: WorkspaceSearchMigrationRehearsalAttestationEvidence,
  suiteStartedAt: string,
  suiteCompletedAt: string,
  signalVerificationKey?: Uint8Array,
  publicationVerificationKey?: Uint8Array,
): ParsedFinalizedAlarm {
  if (
    signalVerificationKey === undefined ||
    publicationVerificationKey === undefined ||
    bytesEqual(signalVerificationKey, publicationVerificationKey)
  ) return failSuiteFinalizer()
  const record = suiteGuards.requireRecord(value)
  suiteGuards.requireExactKeys(record, [
    'artifactByteLength',
    'artifactDigest',
    'authorization',
    'canonicalArtifactBytes',
    'evidence',
    'receiptCount',
  ])
  const bytes = suiteGuards.readOwn(record, 'canonicalArtifactBytes')
  if (!(bytes instanceof Uint8Array) || types.isProxy(bytes)) {
    return failSuiteFinalizer()
  }
  const byteLength = suiteGuards.readIntrinsicByteLength(bytes)
  const artifactDigest = createHash('sha256').update(bytes).digest('hex')
  if (
    suiteGuards.readOwn(record, 'receiptCount') !== 12 ||
    suiteGuards.readOwn(record, 'artifactByteLength') !== byteLength ||
    suiteGuards.readOwn(record, 'artifactDigest') !== artifactDigest
  ) {
    return failSuiteFinalizer()
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return failSuiteFinalizer()
  }
  const artifact =
    verifyWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact(
      parsed,
      signalVerificationKey,
      publicationVerificationKey,
    )
  const authorization = readFinalizedAlarmAuthorization(
    suiteGuards.readOwn(record, 'authorization'),
  )
  const expectedSharedSessionBinding =
    createWorkspaceSearchMigrationRehearsalAlarmSharedClaimsBinding({
      commit,
      callerAttestationDigest: attestation.callerAttestationDigest,
      productionIsolationDigest: attestation.productionIsolationDigest,
      resourceAttestationDigest: attestation.resourceAttestationDigest,
    })
  if (
    !bytesEqual(
      bytes,
      serializeWorkspaceSearchMigrationRehearsalAlarmDeliveryArtifact(
        artifact,
        signalVerificationKey,
        publicationVerificationKey,
      ),
    ) ||
    artifact.receiptArtifact.receipts.length !== 12 ||
    artifact.authorization.permitDigest !== authorization.permitDigest ||
    artifact.authorization.requestedResourcesBinding !==
      authorization.requestedResourcesBinding ||
    artifact.authorization.sharedSessionBindingDigest !==
      authorization.sharedSessionBindingDigest ||
    authorization.sharedSessionBindingDigest !==
      expectedSharedSessionBinding ||
    authorization.permitDigest === attestation.permitDigest
  ) {
    return failSuiteFinalizer()
  }
  const receiptArtifact = artifact.receiptArtifact
  const transitionArtifact = artifact.transitionArtifact
  const alarmIdentityDigests = new Set<string>()
  for (let index = 0; index < alarms.length; index += 1) {
    const alarm = alarms[index]
    const primary = receiptArtifact.receipts[index * 2]
    const secondary = receiptArtifact.receipts[(index * 2) + 1]
    const transition = transitionArtifact.transitions[index]
    if (
      alarm === undefined ||
      primary === undefined ||
      secondary === undefined ||
      transition === undefined ||
      primary.name !== alarm.name ||
      primary.alarmIdentityDigest !== secondary.alarmIdentityDigest ||
      primary.alarmIdentityDigest !== transition.alarmIdentityDigest ||
      alarmIdentityDigests.has(primary.alarmIdentityDigest) ||
      primary.route !== 'primary' ||
      primary.alarmObservedAt !== alarm.alarmObservedAt ||
      primary.receiptDigest !== alarm.primaryReceiptDigest ||
      primary.receivedAt !== alarm.primaryReceivedAt ||
      secondary.name !== alarm.name ||
      secondary.route !== 'secondary' ||
      secondary.alarmObservedAt !== alarm.alarmObservedAt ||
      secondary.receiptDigest !== alarm.secondaryReceiptDigest ||
      secondary.receivedAt !== alarm.secondaryReceivedAt ||
      transition.name !== alarm.name ||
      transition.initialState !== alarm.initialState ||
      transition.alarmState !== alarm.alarmState ||
      transition.recoveredState !== alarm.recoveredState ||
      transition.alarmObservedAt !== alarm.alarmObservedAt ||
      transition.recoveredAt !== alarm.recoveredAt ||
      transition.signalDigest !== alarm.signalDigest ||
      transition.historyDigest !== alarm.historyDigest
    ) {
      return failSuiteFinalizer()
    }
    alarmIdentityDigests.add(primary.alarmIdentityDigest)
  }
  if (
    receiptArtifact.startedAt < suiteStartedAt ||
    transitionArtifact.completedAt > suiteCompletedAt ||
    serializeCanonicalJson(value.evidence) !== serializeCanonicalJson(alarms)
  ) {
    return failSuiteFinalizer()
  }
  return {
    evidence: alarms,
    artifactBytes: new Uint8Array(bytes),
    artifactDigest,
    artifactByteLength: byteLength,
  }
}

/** Parses the exact purpose-specific authorization copied beside its bytes. */
function readFinalizedAlarmAuthorization(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAlarmAuthorization {
  const record = suiteGuards.requireRecord(value)
  suiteGuards.requireExactKeys(record, [
    'permitDigest',
    'requestedResourcesBinding',
    'sharedSessionBindingDigest',
  ])
  return Object.freeze({
    permitDigest: suiteGuards.readDigest(
      suiteGuards.readOwn(record, 'permitDigest'),
    ),
    requestedResourcesBinding: suiteGuards.readDigest(
      suiteGuards.readOwn(record, 'requestedResourcesBinding'),
    ),
    sharedSessionBindingDigest: suiteGuards.readDigest(
      suiteGuards.readOwn(record, 'sharedSessionBindingDigest'),
    ),
  })
}

/** Reads only the alarm evidence vector for preliminary structural parsing. */
function readAlarmEvidenceProjection(
  value: WorkspaceSearchMigrationRehearsalFinalizedAlarmEvidence,
): readonly WorkspaceSearchMigrationRehearsalAlarmEvidence[] {
  const record = suiteGuards.requireRecord(value)
  suiteGuards.requireExactKeys(record, [
    'artifactByteLength',
    'artifactDigest',
    'authorization',
    'canonicalArtifactBytes',
    'evidence',
    'receiptCount',
  ])
  return value.evidence
}

/** Reads one strict phase ledger and reproduces its canonical digest. */
function readPhaseLedger(
  value: unknown,
  name: WorkspaceSearchMigrationRehearsalScenarioName,
  configurationHash: string,
  suiteStartedAt: string,
  suiteCompletedAt: string,
): WorkspaceSearchMigrationRehearsalSuitePhaseLedger {
  const record = suiteGuards.requireRecord(value)
  suiteGuards.requireExactKeys(record, ledgerKeys)
  if (
    suiteGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_KIND ||
    suiteGuards.readOwn(record, 'ledgerVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_VERSION ||
    suiteGuards.readOwn(record, 'scenario') !== name ||
    suiteGuards.readOwn(record, 'activeWriterCount') !== 0
  ) {
    return failSuiteFinalizer()
  }
  const ledgerConfigurationHash = suiteGuards.readDigest(
    suiteGuards.readOwn(record, 'configurationHash'),
  )
  if (ledgerConfigurationHash !== configurationHash) {
    return failSuiteFinalizer()
  }
  const runLocatorDigest = suiteGuards.readDigest(
    suiteGuards.readOwn(record, 'runLocatorDigest'),
  )
  const writersClosedAt = suiteGuards.readTimestamp(
    suiteGuards.readOwn(record, 'writersClosedAt'),
  )
  const drainStartedAt = suiteGuards.readTimestamp(
    suiteGuards.readOwn(record, 'drainStartedAt'),
  )
  const drainCompletedAt = suiteGuards.readTimestamp(
    suiteGuards.readOwn(record, 'drainCompletedAt'),
  )
  const replannedAt = suiteGuards.readTimestamp(
    suiteGuards.readOwn(record, 'replannedAt'),
  )
  const applyStartedAt = suiteGuards.readTimestamp(
    suiteGuards.readOwn(record, 'applyStartedAt'),
  )
  const applyBoundaryAt = suiteGuards.readTimestamp(
    suiteGuards.readOwn(record, 'applyBoundaryAt'),
  )
  const terminalStartedAt = suiteGuards.readTimestamp(
    suiteGuards.readOwn(record, 'terminalStartedAt'),
  )
  const terminalCompletedAt = suiteGuards.readTimestamp(
    suiteGuards.readOwn(record, 'terminalCompletedAt'),
  )
  const releasedAt = suiteGuards.readTimestamp(
    suiteGuards.readOwn(record, 'releasedAt'),
  )
  const orderedTimes = [
    writersClosedAt,
    drainStartedAt,
    drainCompletedAt,
    replannedAt,
    applyStartedAt,
    applyBoundaryAt,
    terminalStartedAt,
    terminalCompletedAt,
    releasedAt,
  ].map(Date.parse)
  if (
    writersClosedAt < suiteStartedAt ||
    releasedAt > suiteCompletedAt ||
    orderedTimes.some((time, index) =>
      index > 0 && time <= (orderedTimes[index - 1] ?? time))
  ) {
    return failSuiteFinalizer()
  }
  const drainDurationMilliseconds = readPositiveCount(
    suiteGuards.readOwn(record, 'drainDurationMilliseconds'),
    24 * 60 * 60 * 1_000,
  )
  if (
    drainDurationMilliseconds <
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_MINIMUM_DRAIN_MILLISECONDS ||
    Date.parse(drainCompletedAt) - Date.parse(drainStartedAt) !==
      drainDurationMilliseconds
  ) {
    return failSuiteFinalizer()
  }
  const sealedPlanOperationCount = readPositiveCount(
    suiteGuards.readOwn(record, 'sealedPlanOperationCount'),
    maximumOperationCount,
  )
  const appliedOperationCount = readPositiveCount(
    suiteGuards.readOwn(record, 'appliedOperationCount'),
    maximumOperationCount,
  )
  const applyBoundary = readApplyBoundary(
    suiteGuards.readOwn(record, 'applyBoundary'),
  )
  const terminalAction = readTerminalAction(
    suiteGuards.readOwn(record, 'terminalAction'),
  )
  const faultObservation = readBoundFaultObservation(
    suiteGuards.readOwn(record, 'faultObservation'),
    suiteGuards.readOwn(record, 'faultObservationDigest'),
    readExpectedFailpoint(name),
  )
  requireScenarioExecutionSemantics(
    name,
    applyBoundary,
    appliedOperationCount,
    sealedPlanOperationCount,
    terminalAction,
  )
  const release = readReleaseBinding(
    suiteGuards.readOwn(record, 'release'),
    name,
  )
  const stageReceiptDigests = readLedgerDigestVector(
    suiteGuards.readOwn(record, 'stageReceiptDigests'),
  )
  const stageReservationDigests = readLedgerDigestVector(
    suiteGuards.readOwn(record, 'stageReservationDigests'),
  )
  const stageReservationClaimRevisions = readLedgerRevisionVector(
    suiteGuards.readOwn(record, 'stageReservationClaimRevisions'),
  )
  const stageReservationCommitRevisions = readLedgerRevisionVector(
    suiteGuards.readOwn(record, 'stageReservationCommitRevisions'),
  )
  const rateSegmentBindings = readLedgerRateSegmentBindings(
    suiteGuards.readOwn(record, 'rateSegmentBindings'),
  )
  if (
    stageReceiptDigests.length !== rateSegmentBindings.length ||
    stageReceiptDigests.length !== stageReservationDigests.length ||
    stageReceiptDigests.length !==
      stageReservationClaimRevisions.length ||
    stageReceiptDigests.length !==
      stageReservationCommitRevisions.length
  ) {
    return failSuiteFinalizer()
  }
  let previousCommitRevision = 0
  for (let index = 0;
    index < stageReservationClaimRevisions.length;
    index += 1) {
    const claimRevision = stageReservationClaimRevisions[index]
    const commitRevision = stageReservationCommitRevisions[index]
    if (
      claimRevision === undefined ||
      commitRevision === undefined ||
      claimRevision <= previousCommitRevision ||
      commitRevision !== claimRevision + 1
    ) return failSuiteFinalizer()
    previousCommitRevision = commitRevision
  }
  const digestFields = [
    suiteGuards.readDigest(suiteGuards.readOwn(record, 'closeEvidenceDigest')),
    suiteGuards.readDigest(suiteGuards.readOwn(record, 'drainEvidenceDigest')),
    suiteGuards.readDigest(suiteGuards.readOwn(record, 'sealedPlanDigest')),
    suiteGuards.readDigest(suiteGuards.readOwn(record, 'applyEvidenceDigest')),
    suiteGuards.readDigest(suiteGuards.readOwn(record, 'terminalEvidenceDigest')),
  ]
  if (new Set(digestFields).size !== digestFields.length) {
    return failSuiteFinalizer()
  }
  const payload: Omit<
    WorkspaceSearchMigrationRehearsalSuitePhaseLedger,
    'ledgerDigest'
  > = {
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_KIND,
    ledgerVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SUITE_LEDGER_VERSION,
    scenario: name,
    configurationHash,
    runLocatorDigest,
    writersClosedAt,
    closeEvidenceDigest: requireArrayValue(digestFields, 0),
    drainStartedAt,
    drainCompletedAt,
    drainDurationMilliseconds,
    activeWriterCount: 0,
    drainEvidenceDigest: requireArrayValue(digestFields, 1),
    replannedAt,
    sealedPlanDigest: requireArrayValue(digestFields, 2),
    sealedPlanOperationCount,
    applyStartedAt,
    applyBoundaryAt,
    applyBoundary,
    appliedOperationCount,
    applyEvidenceDigest: requireArrayValue(digestFields, 3),
    faultObservationDigest: faultObservation.faultObservationDigest,
    faultObservation: faultObservation.faultObservation,
    terminalAction,
    terminalStartedAt,
    terminalCompletedAt,
    terminalEvidenceDigest: requireArrayValue(digestFields, 4),
    stageReceiptDigests,
    stageReservationDigests,
    stageReservationClaimRevisions,
    stageReservationCommitRevisions,
    rateSegmentBindings,
    releasedAt,
    release,
  }
  const ledgerDigest = suiteGuards.readDigest(
    suiteGuards.readOwn(record, 'ledgerDigest'),
  )
  if (ledgerDigest !== createMigrationDigest(payload)) {
    return failSuiteFinalizer()
  }
  return Object.freeze({ ...payload, ledgerDigest })
}

/** Reads a nonempty unique ordered vector of authenticated stage digests. */
function readLedgerDigestVector(value: unknown): readonly string[] {
  if (!Array.isArray(value) || types.isProxy(value)) {
    return failSuiteFinalizer()
  }
  const values = readExactArray(value, value.length)
  if (values.length < 1 || values.length > 64) return failSuiteFinalizer()
  const digests = values.map((candidate) => suiteGuards.readDigest(candidate))
  if (new Set(digests).size !== digests.length) return failSuiteFinalizer()
  return Object.freeze(digests)
}

/** Reads one nonempty ordered vector of positive durable head revisions. */
function readLedgerRevisionVector(value: unknown): readonly number[] {
  if (!Array.isArray(value) || types.isProxy(value)) {
    return failSuiteFinalizer()
  }
  const values = readExactArray(value, value.length)
  if (values.length < 1 || values.length > 64) {
    return failSuiteFinalizer()
  }
  return Object.freeze(values.map((entry) =>
    readPositiveCount(entry, Number.MAX_SAFE_INTEGER)
  ))
}

/** Reads exact rate segments assigned one-to-one to control-stage receipts. */
function readLedgerRateSegmentBindings(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt[] {
  if (!Array.isArray(value) || types.isProxy(value)) {
    return failSuiteFinalizer()
  }
  const values = readExactArray(value, value.length)
  if (values.length < 1 || values.length > 64) return failSuiteFinalizer()
  const locators = new Set<string>()
  const segmentDigests = new Set<string>()
  return Object.freeze(values.map((candidate) => {
    const record = suiteGuards.requireRecord(candidate)
    suiteGuards.requireExactKeys(record, rateSegmentBindingKeys)
    const segmentLocatorDigest = suiteGuards.readDigest(
      suiteGuards.readOwn(record, 'segmentLocatorDigest'),
    )
    const segmentDigest = suiteGuards.readDigest(
      suiteGuards.readOwn(record, 'segmentDigest'),
    )
    if (
      locators.has(segmentLocatorDigest) ||
      segmentDigests.has(segmentDigest)
    ) {
      return failSuiteFinalizer()
    }
    locators.add(segmentLocatorDigest)
    segmentDigests.add(segmentDigest)
    const segmentOrdinal = readNonNegativeCount(
      suiteGuards.readOwn(record, 'segmentOrdinal'),
      255,
    )
    const eventCount = readNonNegativeCount(
      suiteGuards.readOwn(record, 'eventCount'),
      100_000,
    )
    const firstEventSequence = readPositiveCount(
      suiteGuards.readOwn(record, 'firstEventSequence'),
      100_000,
    )
    const firstValue = suiteGuards.readOwn(
      record,
      'firstCommittedEventSequence',
    )
    const lastValue = suiteGuards.readOwn(
      record,
      'lastCommittedEventSequence',
    )
    const firstCommittedEventSequence = firstValue === null
      ? null
      : readPositiveCount(firstValue, 100_000)
    const lastCommittedEventSequence = lastValue === null
      ? null
      : readPositiveCount(lastValue, 100_000)
    if (
      (eventCount === 0 &&
        (firstCommittedEventSequence !== null ||
          lastCommittedEventSequence !== null)) ||
      (eventCount > 0 &&
        (firstCommittedEventSequence === null ||
          lastCommittedEventSequence === null ||
          firstCommittedEventSequence !== firstEventSequence ||
          lastCommittedEventSequence - firstCommittedEventSequence + 1 !==
            eventCount))
    ) {
      return failSuiteFinalizer()
    }
    return Object.freeze({
      authenticationKeyFingerprint: suiteGuards.readDigest(
        suiteGuards.readOwn(record, 'authenticationKeyFingerprint'),
      ),
      segmentLocatorDigest,
      segmentOrdinal,
      firstEventSequence,
      eventCount,
      firstCommittedEventSequence,
      lastCommittedEventSequence,
      terminalRecordMac: suiteGuards.readDigest(
        suiteGuards.readOwn(record, 'terminalRecordMac'),
      ),
      segmentDigest,
    })
  }))
}

/** Reads and validates one exact open writer-fence release binding. */
function readReleaseBinding(
  value: unknown,
  name: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalSuiteReleaseBinding {
  const record = suiteGuards.requireRecord(value)
  suiteGuards.requireExactKeys(record, releaseKeys)
  const expectedKind = isRollbackScenario(name) ? 'rolled-back' : 'verified'
  const expectedVersion = name === 'partial-apply-rollback' ? 2 : 1
  if (
    suiteGuards.readOwn(record, 'mode') !== 'release' ||
    suiteGuards.readOwn(record, 'phase') !== 'released' ||
    suiteGuards.readOwn(record, 'writerFenceMode') !== 'open' ||
    suiteGuards.readOwn(record, 'writerFenceVersion') !== 2 ||
    suiteGuards.readOwn(record, 'terminalKind') !== expectedKind ||
    suiteGuards.readOwn(record, 'terminalPersistenceVersion') !==
      expectedVersion
  ) {
    return failSuiteFinalizer()
  }
  return Object.freeze({
    mode: 'release',
    phase: 'released',
    writerFenceMode: 'open',
    writerFenceVersion: 2,
    terminalKind: expectedKind,
    terminalPersistenceVersion: expectedVersion,
    terminalRootDigest: suiteGuards.readDigest(
      suiteGuards.readOwn(record, 'terminalRootDigest'),
    ),
    writerFenceRecordDigest: suiteGuards.readDigest(
      suiteGuards.readOwn(record, 'writerFenceRecordDigest'),
    ),
  })
}

/** Requires nonempty complete apply or a strict partial committed prefix. */
function requireScenarioExecutionSemantics(
  name: WorkspaceSearchMigrationRehearsalScenarioName,
  boundary: 'committed-prefix' | 'complete',
  appliedOperationCount: number,
  sealedPlanOperationCount: number,
  terminalAction: WorkspaceSearchMigrationRehearsalSuiteTerminalAction,
): void {
  const expectedTerminalAction = name === 'partial-apply-rollback'
    ? 'rollback-partial'
    : name === 'complete-apply-rollback'
      ? 'rollback-complete'
      : 'verify'
  const expectsPartial = name === 'partial-apply-rollback'
  if (
    terminalAction !== expectedTerminalAction ||
    appliedOperationCount > sealedPlanOperationCount ||
    (expectsPartial &&
      (boundary !== 'committed-prefix' ||
        appliedOperationCount >= sealedPlanOperationCount)) ||
    (!expectsPartial &&
      (boundary !== 'complete' ||
        appliedOperationCount !== sealedPlanOperationCount))
  ) {
    return failSuiteFinalizer()
  }
}

/** Detached durable-rate material used by claims and artifact validation. */
type ParsedFinalizedRate = {
  /** Strict external rate evidence projection. */
  readonly evidence: WorkspaceSearchMigrationRehearsalRateEvidence
  /** Digest of the exact authenticated observation artifact bytes. */
  readonly artifactDigest: string
  /** Exact canonical artifact byte length. */
  readonly artifactByteLength: number
  /** Detached exact canonical authenticated observation bytes. */
  readonly artifactBytes: Uint8Array
  /** Recalculated exact per-process segment bindings. */
  readonly segmentBindings:
    readonly WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt[]
}

/** Requires nonempty, digest-matched actual-rate finalizer output. */
function readFinalizedRate(
  value: WorkspaceSearchMigrationRehearsalFinalizedRateEvidence,
  configurationHash: string,
  ratePolicyVersion: string,
  suiteStartedAt: string,
  suiteCompletedAt: string,
): ParsedFinalizedRate {
  const record = suiteGuards.requireRecord(value)
  suiteGuards.requireExactKeys(record, finalizedRateKeys)
  const bytes = value.canonicalArtifactBytes
  if (!(bytes instanceof Uint8Array) || types.isProxy(bytes)) {
    return failSuiteFinalizer()
  }
  const byteLength = suiteGuards.readIntrinsicByteLength(bytes)
  if (byteLength < 1) return failSuiteFinalizer()
  const evidenceRecord = suiteGuards.requireRecord(
    suiteGuards.readOwn(record, 'evidence'),
  )
  suiteGuards.requireExactKeys(evidenceRecord, rateEvidenceKeys)
  const aggregateRecord = suiteGuards.requireRecord(
    suiteGuards.readOwn(evidenceRecord, 'aggregate'),
  )
  suiteGuards.requireExactKeys(aggregateRecord, rateAggregateKeys)
  const observationStreamDigest = suiteGuards.readDigest(
    suiteGuards.readOwn(evidenceRecord, 'observationStreamDigest'),
  )
  const evidenceObservationCount = readPositiveCount(
    suiteGuards.readOwn(evidenceRecord, 'observationCount'),
    100_000,
  )
  const aggregatePolicyVersion = suiteGuards.readDigest(
    suiteGuards.readOwn(aggregateRecord, 'policyVersion'),
  )
  const aggregateAttemptCount = readPositiveCount(
    suiteGuards.readOwn(aggregateRecord, 'attemptCount'),
    maximumOperationCount,
  )
  const artifactDigest = createHash('sha256').update(bytes).digest('hex')
  if (
    artifactDigest !== suiteGuards.readDigest(value.artifactDigest) ||
    artifactDigest !== observationStreamDigest ||
    readPositiveCount(value.observationCount, 100_000) !==
      evidenceObservationCount ||
    readPositiveCount(value.segmentCount, 256) < 1 ||
    readPositiveCount(value.startedAttemptCount, 100_000) < 1 ||
    aggregatePolicyVersion !== ratePolicyVersion ||
    aggregateAttemptCount < 1
  ) {
    return failSuiteFinalizer()
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return failSuiteFinalizer()
  }
  if (serializeCanonicalJson(parsed) !== text) {
    return failSuiteFinalizer()
  }
  const segmentBindings = requireFinalizedRateArtifact(
    parsed,
    configurationHash,
    ratePolicyVersion,
    value.segmentCount,
    value.observationCount,
    value.startedAttemptCount,
    suiteStartedAt,
    suiteCompletedAt,
  )
  return {
    evidence: value.evidence,
    artifactDigest,
    artifactByteLength: byteLength,
    artifactBytes: new Uint8Array(bytes),
    segmentBindings,
  }
}

/** Requires the complete canonical rate artifact to match its finalizer counts. */
function requireFinalizedRateArtifact(
  value: unknown,
  configurationHash: string,
  ratePolicyVersion: string,
  segmentCount: number,
  observationCount: number,
  startedAttemptCount: number,
  suiteStartedAt: string,
  suiteCompletedAt: string,
): readonly WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt[] {
  const record = suiteGuards.requireRecord(value)
  suiteGuards.requireExactKeys(record, [
    'configurationBindingDigest',
    'kind',
    'policyVersion',
    'segments',
    'version',
  ])
  if (
    suiteGuards.readOwn(record, 'kind') !== finalizedRateArtifactKind ||
    suiteGuards.readOwn(record, 'version') !== 1 ||
    suiteGuards.readOwn(record, 'policyVersion') !== ratePolicyVersion ||
    suiteGuards.readOwn(record, 'configurationBindingDigest') !==
      configurationHash
  ) {
    return failSuiteFinalizer()
  }
  const segmentValue = suiteGuards.readOwn(record, 'segments')
  const segments = readExactArray(segmentValue, segmentCount)
  let observedEvents = 0
  let observedStarts = 0
  const bindings: WorkspaceSearchMigrationRehearsalNoFaultRateSegmentReceipt[] =
    []
  let expectedEventSequence = 1
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segmentValue = segments[segmentIndex]
    const segment = suiteGuards.requireRecord(segmentValue)
    suiteGuards.requireExactKeys(segment, ['events', 'header'])
    const header = suiteGuards.requireRecord(
      suiteGuards.readOwn(segment, 'header'),
    )
    const anchorUtc = suiteGuards.readTimestamp(
      suiteGuards.readOwn(header, 'anchorUtc'),
    )
    if (anchorUtc < suiteStartedAt || anchorUtc > suiteCompletedAt) {
      return failSuiteFinalizer()
    }
    const segmentOrdinal = suiteGuards.readOwn(header, 'segmentOrdinal')
    const firstEventSequence = suiteGuards.readOwn(
      header,
      'firstEventSequence',
    )
    if (
      segmentOrdinal !== segmentIndex ||
      firstEventSequence !== expectedEventSequence
    ) {
      return failSuiteFinalizer()
    }
    const eventValue = suiteGuards.readOwn(segment, 'events')
    if (!Array.isArray(eventValue) || types.isProxy(eventValue)) {
      return failSuiteFinalizer()
    }
    const events = readExactArray(eventValue, eventValue.length)
    observedEvents += events.length
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const eventValue = events[eventIndex]
      const event = suiteGuards.requireRecord(eventValue)
      if (
        suiteGuards.readOwn(event, 'eventSequence') !==
          expectedEventSequence + eventIndex
      ) {
        return failSuiteFinalizer()
      }
      const offsetMilliseconds = readNonNegativeCount(
        suiteGuards.readOwn(event, 'offsetMilliseconds'),
        24 * 60 * 60 * 1_000,
      )
      const eventTime = Date.parse(anchorUtc) + offsetMilliseconds
      if (
        !Number.isSafeInteger(eventTime) ||
        eventTime < Date.parse(suiteStartedAt) ||
        eventTime > Date.parse(suiteCompletedAt)
      ) {
        return failSuiteFinalizer()
      }
      if (suiteGuards.readOwn(event, 'kind') === 'attempt-started') {
        observedStarts += 1
      }
    }
    const terminal = events.at(-1) ?? header
    const terminalRecordMac = suiteGuards.readDigest(
      suiteGuards.readOwn(terminal, 'mac'),
    )
    const canonicalSegmentText = [header, ...events]
      .map((record) => `${serializeCanonicalJson(record)}\n`)
      .join('')
    bindings.push(Object.freeze({
      authenticationKeyFingerprint: suiteGuards.readDigest(
        suiteGuards.readOwn(header, 'authenticationKeyFingerprint'),
      ),
      segmentLocatorDigest: suiteGuards.readDigest(
        suiteGuards.readOwn(header, 'segmentLocatorDigest'),
      ),
      segmentOrdinal,
      firstEventSequence: expectedEventSequence,
      eventCount: events.length,
      firstCommittedEventSequence: events.length === 0
        ? null
        : expectedEventSequence,
      lastCommittedEventSequence: events.length === 0
        ? null
        : expectedEventSequence + events.length - 1,
      terminalRecordMac,
      segmentDigest: createHash('sha256')
        .update(canonicalSegmentText, 'utf8')
        .digest('hex'),
    }))
    expectedEventSequence += events.length
  }
  if (
    observedEvents !== observationCount ||
    observedStarts !== startedAttemptCount
  ) {
    return failSuiteFinalizer()
  }
  return Object.freeze(bindings)
}

/** Validates claims through the canonical evidence reader and detaches them. */
function validateAndDetachClaims(
  claims: WorkspaceSearchMigrationRehearsalEvidenceClaims,
): WorkspaceSearchMigrationRehearsalEvidenceClaims {
  const key = new Uint8Array(structuralValidationKeyByteLength)
  key.fill(0xa5)
  try {
    const index = createWorkspaceSearchMigrationRehearsalEvidenceIndex({
      evidence: claims,
      signingKey: key,
    })
    return {
      kind: index.kind,
      contractVersion: index.contractVersion,
      commit: index.commit,
      attestation: index.attestation,
      configurationHash: index.configurationHash,
      ratePolicyVersion: index.ratePolicyVersion,
      startedAt: index.startedAt,
      completedAt: index.completedAt,
      scenarios: index.scenarios,
      reconciliation: index.reconciliation,
      rate: index.rate,
      alarms: index.alarms,
      dlq: index.dlq,
      artifacts: index.artifacts,
      overallStatus: index.overallStatus,
    }
  } finally {
    key.fill(0)
  }
}

/** Requires every immutable reference to match its prepared child artifact. */
function requireChildArtifactBindings(
  references: readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[],
  expected: readonly InternalPreparedArtifact[],
  completedAt: string,
): void {
  const contentDigests = new Set<string>()
  const completedAtMilliseconds = Date.parse(completedAt)
  const minimumRetention =
    completedAtMilliseconds + 365 * 24 * 60 * 60 * 1_000
  const maximumRetention =
    completedAtMilliseconds + 366 * 24 * 60 * 60 * 1_000
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index]
    const binding = expected[index]
    if (
      reference === undefined ||
      binding === undefined ||
      reference.kind !== binding.kind ||
      reference.contentDigest !== binding.contentDigest ||
      reference.byteLength !== binding.byteLength ||
      Date.parse(reference.retainedUntil) < minimumRetention ||
      Date.parse(reference.retainedUntil) > maximumRetention ||
      contentDigests.has(reference.contentDigest)
    ) {
      return failSuiteFinalizer()
    }
    contentDigests.add(reference.contentDigest)
  }
}

/** Internal canonical child artifact retained across the two-phase flow. */
type InternalPreparedArtifact = {
  /** Canonical child artifact purpose. */
  readonly kind: WorkspaceSearchMigrationRehearsalArtifactKind
  /** Detached exact canonical bytes. */
  readonly canonicalBytes: Uint8Array
  /** SHA-256 digest of exact canonical bytes. */
  readonly contentDigest: string
  /** Exact canonical UTF-8 byte length. */
  readonly byteLength: number
}

/**
 * Reads one rollback comparison from its fixed public reconciliation slot.
 *
 * @param evidence - Canonical eight-scenario reconciliation vector.
 * @param index - Fixed rollback scenario position.
 * @param purpose - Exact rollback purpose required at that position.
 * @returns Exact authenticated rollback comparison projection.
 */
function requireRollbackPublicReconciliation(
  evidence: WorkspaceSearchMigrationRehearsalReconciliationEvidence,
  index: 6 | 7,
  purpose: 'complete-rollback' | 'partial-rollback',
): WorkspaceSearchMigrationRehearsalRollbackReconciliationEvidence {
  const integrity = evidence[index]?.integrity
  if (
    integrity?.kind !== 'rollback-comparison' ||
    integrity.purpose !== purpose
  ) {
    return failSuiteFinalizer()
  }
  return integrity
}

/**
 * Reads one scenario's authenticated post-terminal #163 result.
 *
 * @param summary - Canonical public reconciliation summary.
 * @returns Exact post-terminal result for artifact publication.
 */
function readPublicTerminalIntegrityResult(
  summary: WorkspaceSearchMigrationRehearsalReconciliationSummaryEvidence | undefined,
): WorkspaceSearchMigrationRehearsalReconciliationResultEvidence {
  if (summary === undefined) return failSuiteFinalizer()
  return summary.integrity.kind === 'verified-result'
    ? summary.integrity.result
    : summary.integrity.after
}

/** Creates all ten exact canonical child artifacts. */
function createPreparedChildArtifacts(
  claims: Omit<
    WorkspaceSearchMigrationRehearsalEvidenceClaims,
    'artifacts'
  >,
  ledgers: readonly WorkspaceSearchMigrationRehearsalSuitePhaseLedger[],
  rate: ParsedFinalizedRate,
  alarm: ParsedFinalizedAlarm,
): readonly InternalPreparedArtifact[] {
  const partialRollback = requireRollbackPublicReconciliation(
    claims.reconciliation,
    6,
    'partial-rollback',
  )
  const completeRollback = requireRollbackPublicReconciliation(
    claims.reconciliation,
    7,
    'complete-rollback',
  )
  const before = {
    partialRollback: partialRollback.before,
    completeRollback: completeRollback.before,
  }
  const after = {
    happyPathVerified: readPublicTerminalIntegrityResult(
      claims.reconciliation[0],
    ),
    cursorBeforeCommitKill: readPublicTerminalIntegrityResult(
      claims.reconciliation[1],
    ),
    cursorAfterCommitKill: readPublicTerminalIntegrityResult(
      claims.reconciliation[2],
    ),
    artifactBeforeCheckpointKill: readPublicTerminalIntegrityResult(
      claims.reconciliation[3],
    ),
    transactionResponseLoss: readPublicTerminalIntegrityResult(
      claims.reconciliation[4],
    ),
    leaseExpiryTakeover: readPublicTerminalIntegrityResult(
      claims.reconciliation[5],
    ),
    partialRollback: partialRollback.after,
    completeRollback: completeRollback.after,
  }
  const comparisons = {
    partialRollback,
    completeRollback,
  }
  const artifacts = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS.map(
    (kind): InternalPreparedArtifact => {
      let bytes: Uint8Array
      if (kind === 'rate-observations') {
        bytes = new Uint8Array(rate.artifactBytes)
      } else if (kind === 'alarm-delivery') {
        bytes = new Uint8Array(alarm.artifactBytes)
      } else {
        const payload = createChildArtifactPayload(
          kind,
          claims,
          ledgers,
          before,
          after,
          comparisons,
        )
        bytes = new TextEncoder().encode(serializeCanonicalJson(payload))
      }
      const contentDigest = createHash('sha256').update(bytes).digest('hex')
      if (
        bytes.byteLength < 1 ||
        bytes.byteLength > maximumPreparedArtifactByteLength ||
        (kind === 'rate-observations' &&
          (contentDigest !== rate.artifactDigest ||
            bytes.byteLength !== rate.artifactByteLength)) ||
        (kind === 'alarm-delivery' &&
          (contentDigest !== alarm.artifactDigest ||
            bytes.byteLength !== alarm.artifactByteLength))
      ) {
        return failSuiteFinalizer()
      }
      return Object.freeze({
        kind,
        canonicalBytes: bytes,
        contentDigest,
        byteLength: bytes.byteLength,
      })
    },
  )
  if (
    new Set(artifacts.map((artifact) => artifact.contentDigest)).size !==
      artifacts.length
  ) {
    return failSuiteFinalizer()
  }
  return Object.freeze(artifacts)
}

/** Creates structurally valid placeholder references for semantic parsing. */
function createStructuralArtifactReferences(
  completedAt: string,
): readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[] {
  const retainedUntil = createValidationRetention(completedAt)
  return WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS.map((kind) => ({
    kind,
    contentDigest: createMigrationDigest({ kind, purpose: 'structure' }),
    byteLength: 1,
    immutableVersionDigest: createMigrationDigest({
      kind,
      purpose: 'structure-version',
    }),
    retainedUntil,
  }))
}

/** Creates synthetic references used only to re-run the strict claims reader. */
function createValidationArtifactReferences(
  artifacts: readonly InternalPreparedArtifact[],
  completedAt: string,
): readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[] {
  const retainedUntil = createValidationRetention(completedAt)
  return artifacts.map((artifact) => ({
    kind: artifact.kind,
    contentDigest: artifact.contentDigest,
    byteLength: artifact.byteLength,
    immutableVersionDigest: createMigrationDigest({
      kind: artifact.kind,
      contentDigest: artifact.contentDigest,
      purpose: 'validation-version',
    }),
    retainedUntil,
  }))
}

/** Returns a canonical retention time safely beyond the 365-day minimum. */
function createValidationRetention(completedAt: string): string {
  return new Date(
    Date.parse(completedAt) + 366 * 24 * 60 * 60 * 1_000,
  ).toISOString()
}

/** Creates one exact digest-only canonical child artifact envelope. */
function createChildArtifactPayload(
  kind: Exclude<
    WorkspaceSearchMigrationRehearsalArtifactKind,
    'alarm-delivery' | 'rate-observations'
  >,
  claims: Omit<
    WorkspaceSearchMigrationRehearsalEvidenceClaims,
    'artifacts'
  >,
  ledgers: readonly WorkspaceSearchMigrationRehearsalSuitePhaseLedger[],
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
  comparisons: Readonly<Record<string, unknown>>,
): unknown {
  const envelope = {
    kind,
    artifactVersion: childArtifactVersion,
  }
  switch (kind) {
    case 'scenario-results':
      return { ...envelope, scenarios: claims.scenarios }
    case 'integrity-before':
      return { ...envelope, results: before }
    case 'integrity-after':
      return { ...envelope, results: after }
    case 'integrity-comparison':
      return { ...envelope, comparisons }
    case 'target-preimage': {
      const partialRollback = requireRollbackPublicReconciliation(
        claims.reconciliation,
        6,
        'partial-rollback',
      )
      const completeRollback = requireRollbackPublicReconciliation(
        claims.reconciliation,
        7,
        'complete-rollback',
      )
      return {
        ...envelope,
        partialRollbackAggregateDigest:
          partialRollback.targetPreimageAggregateDigest,
        completeRollbackAggregateDigest:
          completeRollback.targetPreimageAggregateDigest,
      }
    }
    case 'target-rollback-comparison':
      return {
        ...envelope,
        comparison: {
          partialRollback: requireRollbackPublicReconciliation(
            claims.reconciliation,
            6,
            'partial-rollback',
          ),
          completeRollback: requireRollbackPublicReconciliation(
            claims.reconciliation,
            7,
            'complete-rollback',
          ),
          status: 'equal',
        },
      }
    case 'lifecycle-ledger':
      return { ...envelope, ledgers }
    case 'non-production-attestation':
      return {
        ...envelope,
        commit: claims.commit,
        configurationHash: claims.configurationHash,
        attestation: claims.attestation,
      }
  }
}

/**
 * Reads one complete normalized fault observation and verifies its digest.
 *
 * @param observationValue - Untrusted normalized observation or null.
 * @param digestValue - Untrusted observation digest or null.
 * @param expectedFailpoint - Scenario-owned failpoint or null if unfaulted.
 * @returns Detached observation and exact digest with matched nullability.
 */
function readBoundFaultObservation(
  observationValue: unknown,
  digestValue: unknown,
  expectedFailpoint: WorkspaceSearchMigrationRehearsalFailpoint | null,
): WorkspaceSearchMigrationRehearsalBoundFaultObservation {
  if (expectedFailpoint === null) {
    if (observationValue !== null || digestValue !== null) {
      return failSuiteFinalizer()
    }
    return Object.freeze({
      faultObservationDigest: null,
      faultObservation: null,
    })
  }
  if (observationValue === null || digestValue === null) {
    return failSuiteFinalizer()
  }
  const faultObservation =
    snapshotWorkspaceSearchMigrationRehearsalFaultObservation(
      observationValue,
    )
  const faultObservationDigest = suiteGuards.readDigest(digestValue)
  if (
    faultObservation.failpoint !== expectedFailpoint ||
    faultObservationDigest !== createMigrationDigest(faultObservation)
  ) {
    return failSuiteFinalizer()
  }
  return Object.freeze({ faultObservationDigest, faultObservation })
}

/** Returns the fixed failpoint selected by one scenario. */
function readExpectedFailpoint(
  name: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalFailpoint | null {
  switch (name) {
    case 'happy-path-verified':
    case 'complete-apply-rollback':
      return null
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
  }
}

/** Reads one finite apply-boundary literal. */
function readApplyBoundary(value: unknown): 'committed-prefix' | 'complete' {
  if (value !== 'committed-prefix' && value !== 'complete') {
    return failSuiteFinalizer()
  }
  return value
}

/** Reads one finite terminal-action literal. */
function readTerminalAction(
  value: unknown,
): WorkspaceSearchMigrationRehearsalSuiteTerminalAction {
  if (
    value !== 'rollback-complete' &&
    value !== 'rollback-partial' &&
    value !== 'verify'
  ) {
    return failSuiteFinalizer()
  }
  return value
}

/** Returns whether one fixed scenario must end in rollback. */
function isRollbackScenario(
  name: WorkspaceSearchMigrationRehearsalScenarioName,
): boolean {
  return name === 'partial-apply-rollback' ||
    name === 'complete-apply-rollback'
}

/** Reads a positive bounded safe integer. */
function readPositiveCount(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    return failSuiteFinalizer()
  }
  return value
}

/** Reads a non-negative bounded safe integer. */
function readNonNegativeCount(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    return failSuiteFinalizer()
  }
  return value
}

/** Reads one exact lowercase 40-character commit OID. */
function readCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return failSuiteFinalizer()
  }
  return value
}

/** Returns one required array member without a type assertion. */
function requireArrayValue(values: readonly string[], index: number): string {
  const value = values[index]
  if (value === undefined) return failSuiteFinalizer()
  return value
}

/** Compares two exact byte vectors without decoding their contents. */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Reads one dense ordinary array without accessors or extra properties. */
function readExactArray(
  value: unknown,
  expectedLength: number,
): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value)) {
    return failSuiteFinalizer()
  }
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== expectedLength + 1) return failSuiteFinalizer()
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    lengthDescriptor.value !== expectedLength
  ) {
    return failSuiteFinalizer()
  }
  const result: unknown[] = []
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failSuiteFinalizer()
    }
    result.push(descriptor.value)
  }
  return result
}

/** Raises the stable raw-value-free suite finalization failure. */
function failSuiteFinalizer(): never {
  throw new WorkspaceSearchMigrationRehearsalSuiteFinalizerError()
}
