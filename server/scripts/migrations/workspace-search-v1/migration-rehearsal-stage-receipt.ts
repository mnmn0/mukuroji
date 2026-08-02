import { createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  parseCrossDomainIntegrityResourceIdentities,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS,
  type WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAILPOINTS,
  type WorkspaceSearchMigrationRehearsalFailpoint,
} from './migration-rehearsal-faults'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST,
} from './migration-rehearsal-stage-reservation-chain'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  readWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
} from './migration-rehearsal-rate-evidence'
import {
  verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment,
} from './migration-rehearsal-stage-reservation-abandonment'
import {
  snapshotWorkspaceSearchMigrationRehearsalFaultObservation,
  type WorkspaceSearchMigrationRehearsalFaultObservation,
} from './migration-rehearsal-fault-observation'
import {
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE,
} from './migration-rehearsal-permit'
import {
  verifyWorkspaceSearchMigrationRehearsalStageManifest,
  WorkspaceSearchMigrationRehearsalStageReceiptError,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
} from './migration-rehearsal-stage-manifest'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import {
  snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext,
  type WorkspaceSearchMigrationRehearsalReconciliationAuditContext,
} from './migration-rehearsal-reconciliation-audit'
import type {
  WorkspaceSearchMigrationRehearsalExpectedAuthority,
} from './migration-rehearsal-reconciliation-aws'

export {
  createWorkspaceSearchMigrationRehearsalStageManifest,
  parseWorkspaceSearchMigrationRehearsalStageManifestDocument,
  verifyWorkspaceSearchMigrationRehearsalStageManifest,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_KIND,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_MAX_ENTRIES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_MANIFEST_VERSION,
  WorkspaceSearchMigrationRehearsalStageReceiptError,
  type CreateWorkspaceSearchMigrationRehearsalStageManifestInput,
  type WorkspaceSearchMigrationRehearsalSelectedStage,
  type WorkspaceSearchMigrationRehearsalStageCommand,
  type WorkspaceSearchMigrationRehearsalStageManifest,
  type WorkspaceSearchMigrationRehearsalStageManifestClaims,
  type WorkspaceSearchMigrationRehearsalStageManifestEntry,
  type WorkspaceSearchMigrationRehearsalStageOutcome,
} from './migration-rehearsal-stage-manifest'

/** Stable discriminator for one authenticated stage receipt. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-receipt'

/** First authenticated stage-receipt contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION = 1

/** Runtime-only discriminator for one finalized one-shot stage chain. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_STAGE_CHAIN_KIND =
  'mukuroji-workspace-search-migration-rehearsal-finalized-stage-chain'

/** Stable domain for one terminal reconciliation-audit binding. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECONCILIATION_AUDIT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-stage-reconciliation-audit'

/** First exact terminal reconciliation-audit binding contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECONCILIATION_AUDIT_VERSION =
  1

/** Maximum accepted canonical bytes for one stage receipt. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES =
  128 * 1_024

/** External finite process-attempt outcome derived from parent lifecycle. */
export type WorkspaceSearchMigrationRehearsalStageChainAttemptOutcome =
  | 'completed'
  | 'killed-at-fault'
  | 'response-loss-reconciled'
  | 'takeover-completed'

/** Identifier-free committed rate-segment binding stored in every receipt. */
export type WorkspaceSearchMigrationRehearsalStageRateSegment = {
  /** Domain-separated fingerprint of the key authenticating this segment. */
  readonly authenticationKeyFingerprint: string
  /** Opaque authenticated segment locator. */
  readonly segmentLocatorDigest: string
  /** Zero-based process segment ordinal. */
  readonly segmentOrdinal: number
  /** Global event sequence allocated by the authenticated segment header. */
  readonly firstEventSequence: number
  /** Number of durably committed DescribeTable events. */
  readonly eventCount: number
  /** First global event sequence, or null for an empty segment. */
  readonly firstCommittedEventSequence: number | null
  /** Last global event sequence, or null for an empty segment. */
  readonly lastCommittedEventSequence: number | null
  /** HMAC of the final durable segment record. */
  readonly terminalRecordMac: string
  /** Digest of the exact complete durable segment prefix. */
  readonly segmentDigest: string
}

/** Parent-observed process lifecycle bound before final receipt HMAC. */
export type WorkspaceSearchMigrationRehearsalStageProcessLifecycle = {
  /** Digest of the exact canonical trusted parent lifecycle object. */
  readonly lifecycleDigest: string
  /** Parent-clock beginning of lifecycle supervision. */
  readonly runnerStartedAt: string
  /** Parent-clock observation of the complete child evidence line. */
  readonly receiptObservedAt: string
  /** Parent-clock completion of exclusive receipt persistence and fsync. */
  readonly receiptPersistedAt: string
  /** Parent decision time for kill or response-loss ACK, else null. */
  readonly parentDecisionRecordedAt: string | null
  /** Parent-clock observation of the final contained child exit. */
  readonly processExitedAt: string
  /** Exact verified process termination class. */
  readonly exitClass:
    | 'confirmed-sigkill'
    | 'successful-no-fault'
    | 'successful-response-loss'
}

/** Canonical cycle-free durable lease observation bound to one stage receipt. */
export type WorkspaceSearchMigrationRehearsalStageLeaseObservation =
  | {
    /** Fixed discriminator for a newly acquired lease. */
    readonly kind: 'acquired'
    /** Previous lease identity digest, or null for an initial acquisition. */
    readonly predecessorLeaseIdentityDigest: string | null
    /** Previous lease expiry, or null for an initial acquisition. */
    readonly predecessorLeaseExpiresAt: string | null
    /** Canonical durable acquisition time. */
    readonly acquiredAt: string
    /** Newly acquired lease identity digest. */
    readonly successorLeaseIdentityDigest: string
    /** Canonical newly acquired lease expiry. */
    readonly successorLeaseExpiresAt: string
  }
  | {
    /** Fixed discriminator for observing an already active lease. */
    readonly kind: 'reused-active'
    /** Current active lease identity digest. */
    readonly currentLeaseIdentityDigest: string
    /** Canonical time at which the active lease was evaluated. */
    readonly evaluatedAt: string
    /** Canonical current lease expiry, which may include a renewal. */
    readonly currentLeaseExpiresAt: string
  }

/** Durable planning graph projected without resource or owner identifiers. */
export type WorkspaceSearchMigrationRehearsalPlanningStageEvidence = {
  /** Fixed planning evidence discriminator. */
  readonly kind: 'planning-sealed'
  /** Digest of the admitted execution boundary. */
  readonly executionBoundaryDigest: string
  /** Digest of the exact closed writer-fence record. */
  readonly closedWriterFenceRecordDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Merkle root of the exact ordered plan. */
  readonly planDigest: string
  /** Exact non-zero sealed plan operation count. */
  readonly sealedPlanOperationCount: number
  /** Exact source-derived operation count. */
  readonly sourceOperationCount: number
  /** Exact target-orphan operation count. */
  readonly orphanOperationCount: number
  /** Canonical writer-fence close time. */
  readonly closedAt: string
  /** Canonical beginning of the observed zero-writer drain. */
  readonly drainStartedAt: string
  /** Canonical completion of the observed zero-writer drain. */
  readonly drainCompletedAt: string
  /** Canonical planning-admission commit time. */
  readonly admittedAt: string
  /** Canonical immutable plan creation time. */
  readonly planCreatedAt: string
  /** Canonical sealed-authority publication time. */
  readonly sealedAt: string
}

/** Complete applied-root evidence projected without resource identifiers. */
export type WorkspaceSearchMigrationRehearsalApplyStageEvidence = {
  /** Fixed full-apply evidence discriminator. */
  readonly kind: 'apply-complete'
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Merkle root of the exact ordered plan. */
  readonly planDigest: string
  /** Exact non-zero sealed plan operation count. */
  readonly sealedPlanOperationCount: number
  /** Exact applied operation count, equal to the complete plan count. */
  readonly appliedOperationCount: number
  /** Digest of the immutable complete applied root. */
  readonly appliedRootDigest: string
  /** Content digest of the independently captured pre-apply target audit. */
  readonly targetPreimageArtifactContentDigest: string | null
  /** Canonical complete applied-root publication time. */
  readonly appliedAt: string
}

/** Runtime fault boundary projected without checkpoint cursor material. */
export type WorkspaceSearchMigrationRehearsalFaultStageEvidence = {
  /** Fixed fault-boundary evidence discriminator. */
  readonly kind: 'fault-boundary'
  /** Exact reviewed failpoint reached by the runtime. */
  readonly failpoint: WorkspaceSearchMigrationRehearsalFailpoint
  /** Digest of the strict semantic fault target, excluding raw cursors. */
  readonly targetDigest: string
  /** Digest of the exact safe runtime fault receipt. */
  readonly faultReceiptDigest: string
  /** Digest of the complete normalized adapter-proven fault observation. */
  readonly faultObservationDigest: string
  /** Complete secret-free adapter observation at the selected boundary. */
  readonly faultObservation:
    WorkspaceSearchMigrationRehearsalFaultObservation
  /** Digest of the predecessor lease identity observed at the fault boundary. */
  readonly leaseIdentityDigest: string
  /** Zero before planning, a complete checkpoint count, or a strict apply prefix. */
  readonly appliedOperationCount: number
  /** Exact positive sealed count for apply faults, or null before planning seals it. */
  readonly sealedPlanOperationCount: number | null
  /** Pre-apply target-audit content digest only for a partial-apply boundary. */
  readonly targetPreimageArtifactContentDigest: string | null
  /** Canonical runtime time at which the failpoint was reached. */
  readonly reachedAt: string
}

/** Verified or rolled-back immutable terminal graph evidence. */
export type WorkspaceSearchMigrationRehearsalTerminalStageEvidence = {
  /** Fixed terminal evidence discriminator. */
  readonly kind: 'terminal'
  /** Exact terminal command that published or recovered the root. */
  readonly command: 'rollback-complete' | 'rollback-partial' | 'verify'
  /** Authoritative terminal outcome. */
  readonly terminalKind: 'rolled-back' | 'verified'
  /** Persistence version of the authoritative terminal root. */
  readonly terminalPersistenceVersion: 1 | 2
  /** Digest of the authoritative terminal root. */
  readonly terminalRootDigest: string
  /** Digest of the admitted execution boundary. */
  readonly executionBoundaryDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Merkle root of the exact ordered plan. */
  readonly planDigest: string
  /** Exact non-zero sealed plan operation count. */
  readonly sealedPlanOperationCount: number
  /** Exact prefix that was applied before the terminal action. */
  readonly appliedOperationCount: number
  /** Purpose preventing integrity evidence from cross-scenario replay. */
  readonly integrityPurpose:
    | 'complete-rollback'
    | 'partial-rollback'
    | 'verified'
  /** Authenticated pre-migration integrity result digest, when required. */
  readonly integrityBeforeResultDigest: string | null
  /** Authenticated post-release integrity result digest, when required. */
  readonly integrityAfterResultDigest: string | null
  /** Purpose-bound exact integrity comparison digest, when required. */
  readonly integrityComparisonDigest: string | null
  /** Finalized purpose-bound integrity context digest, when required. */
  readonly integrityContextDigest: string | null
  /** Target-audit content digest for the rollback terminal, when required. */
  readonly targetRollbackArtifactContentDigest: string | null
  /** Target-audit semantic observation digest for rollback, when required. */
  readonly targetRollbackObservationDigest: string | null
  /** Mandatory duplicate target applications observed by terminal audit. */
  readonly duplicateApplyCount: 0
  /** Mandatory expected target applications missing at terminal audit. */
  readonly lostItemCount: 0
  /** Mandatory durable authorities without an owning operation. */
  readonly orphanAuthorityCount: 0
  /** Complete parent-authenticated expectation for the later audit artifact. */
  readonly reconciliationContext:
    WorkspaceSearchMigrationRehearsalReconciliationAuditContext
  /** Digest of the complete secret-free authenticated artifact binding. */
  readonly reconciliationArtifactBindingDigest: string
  /** SHA-256 digest of the exact canonical reconciliation artifact bytes. */
  readonly reconciliationArtifactContentDigest: string
  /** Exact positive canonical reconciliation artifact byte length. */
  readonly reconciliationArtifactByteLength: number
  /** Digest of the complete authenticated reconciliation semantics. */
  readonly reconciliationArtifactAuditDigest: string
  /** Exact auxiliary reconciliation rate segment and ledger binding. */
  readonly reconciliationRate:
    WorkspaceSearchMigrationRehearsalRateSegmentEvidence
  /** Digest of the terminal reconciliation expectation binding. */
  readonly reconciliationAuditDigest: string
  /** Canonical authoritative terminal publication time. */
  readonly terminalAt: string
}

/** Released writer-fence evidence bound to one exact terminal graph. */
export type WorkspaceSearchMigrationRehearsalReleaseStageEvidence = {
  /** Fixed released-fence evidence discriminator. */
  readonly kind: 'released'
  /** Authoritative terminal outcome consumed by release. */
  readonly terminalKind: 'rolled-back' | 'verified'
  /** Persistence version of the authoritative terminal root. */
  readonly terminalPersistenceVersion: 1 | 2
  /** Digest of the authoritative terminal root. */
  readonly terminalRootDigest: string
  /** Digest of the exact canonical released writer-fence record. */
  readonly releasedWriterFenceRecordDigest: string
  /** Canonical completion time observed by the authenticated child. */
  readonly releasedAt: string
}

/** Every exact durable boundary admitted into a stage receipt. */
export type WorkspaceSearchMigrationRehearsalStageEvidence =
  | WorkspaceSearchMigrationRehearsalApplyStageEvidence
  | WorkspaceSearchMigrationRehearsalFaultStageEvidence
  | WorkspaceSearchMigrationRehearsalPlanningStageEvidence
  | WorkspaceSearchMigrationRehearsalReleaseStageEvidence
  | WorkspaceSearchMigrationRehearsalTerminalStageEvidence

/** Canonical authenticated claims produced by one actual control stage. */
export type WorkspaceSearchMigrationRehearsalStageReceiptClaims = {
  /** Fixed receipt discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND
  /** Stage-receipt schema version. */
  readonly receiptVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION
  /** Fixed non-production environment. */
  readonly stage: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  /** Canonical scenario owning the stage. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Globally contiguous one-based stage ordinal. */
  readonly stageOrdinal: number
  /** Contiguous one-based scenario stage ordinal. */
  readonly scenarioStageOrdinal: number
  /** Exact existing mutating control command. */
  readonly command: WorkspaceSearchMigrationRehearsalStageCommand
  /** Digest of the exact existing control argument vector. */
  readonly controlArgumentsDigest: string
  /** Digest of the exact trusted serialized control or fault output line. */
  readonly serializedOutputLineDigest: string
  /** Digest of the exact authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Digest of the selected detached manifest entry. */
  readonly manifestEntryDigest: string
  /** Digest of the exact authenticated rehearsal permit. */
  readonly permitDigest: string
  /** Exact reviewed implementation commit OID. */
  readonly commit: string
  /** Requested-resource binding authenticated by the permit. */
  readonly requestedResourcesBinding: string
  /** Exact immutable resource identity scheme authenticated by the manifest. */
  readonly integrityResourceIdentityScheme:
    WorkspaceSearchMigrationRehearsalStageManifest[
      'integrityResourceIdentityScheme'
    ]
  /** Exact canonical seven-entry resource vector authenticated by the manifest. */
  readonly integrityResourceIdentities:
    WorkspaceSearchMigrationRehearsalStageManifest[
      'integrityResourceIdentities'
    ]
  /** Aggregate keyed resource identity digest authenticated by the manifest. */
  readonly integrityResourceIdentityDigest: string
  /** Reviewed measured configuration binding. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable policy digest. */
  readonly policyVersion: string
  /** Domain-separated digest of the restricted run identifier. */
  readonly runLocatorDigest: string
  /** One-based process attempt ordinal within the scenario. */
  readonly attemptOrdinal: number
  /** Domain-separated digest of the restricted process attempt. */
  readonly attemptLocatorDigest: string
  /** Domain-separated digest of the restricted owner identifier. */
  readonly ownerLocatorDigest: string
  /** Digest of the current durable lease identity for this stage. */
  readonly leaseIdentityDigest: string
  /** Exact acquisition or active-lease observation for this stage. */
  readonly leaseObservation:
    WorkspaceSearchMigrationRehearsalStageLeaseObservation
  /** Cumulative FIFO authority-adoption chain for this scenario run. */
  readonly expectedAuthorities:
    readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[]
  /** Digest of the durable writer-fence identity for this stage. */
  readonly writerFenceDigest: string
  /** Digest of the exact preceding stage receipt, or null for stage one. */
  readonly previousStageReceiptDigest: string | null
  /** Digest of the exact authenticated reservation that owned this stage. */
  readonly stageReservationDigest: string
  /** Durable head revision at which that reservation became active. */
  readonly stageReservationClaimRevision: number
  /** Expected durable successor revision after this receipt is committed. */
  readonly stageReservationCommitRevision: number
  /** Cumulative explicit abandonment count at reservation claim time. */
  readonly stageReservationAbandonmentCount: number
  /** Cumulative abandonment root at reservation claim time. */
  readonly stageReservationAbandonmentRootDigest: string
  /** Canonical authenticated-child start time. */
  readonly startedAt: string
  /** Canonical offline finalization time covering process and external proof. */
  readonly completedAt: string
  /** Exact trusted parent process lifecycle bound before final HMAC. */
  readonly processLifecycle:
    WorkspaceSearchMigrationRehearsalStageProcessLifecycle
  /** Exact finite process outcome. */
  readonly outcome: WorkspaceSearchMigrationRehearsalStageOutcome
  /** Matching safe fault-receipt digest, or null for an unfaulted stage. */
  readonly faultReceiptDigest: string | null
  /** Exact current fault boundary, or null for success and later takeover. */
  readonly faultBoundary:
    WorkspaceSearchMigrationRehearsalFaultStageEvidence | null
  /** Predecessor lease expiry for takeover, otherwise null. */
  readonly predecessorLeaseExpiresAt: string | null
  /** Durable successor takeover time, otherwise null. */
  readonly takeoverAcquiredAt: string | null
  /** Durable response-loss reconciliation time, otherwise null. */
  readonly reconciledAt: string | null
  /** Exact durable stage evidence derived from trusted control results. */
  readonly evidence: WorkspaceSearchMigrationRehearsalStageEvidence
  /** Exact confirmed durable actual-rate segment binding. */
  readonly rateSegment: WorkspaceSearchMigrationRehearsalStageRateSegment
}

/** Complete authenticated stage receipt. */
export type WorkspaceSearchMigrationRehearsalStageReceipt =
  WorkspaceSearchMigrationRehearsalStageReceiptClaims & {
    /** HMAC-SHA-256 over the exact canonical receipt claims. */
    readonly receiptMac: string
  }

/** Input for an authenticated child creating one actual stage receipt. */
export type CreateWorkspaceSearchMigrationRehearsalStageReceiptInput = {
  /** Exact claims built only from trusted in-process results. */
  readonly claims: WorkspaceSearchMigrationRehearsalStageReceiptClaims
  /** Main 32-byte rehearsal evidence authentication key. */
  readonly signingKey: Uint8Array
}

/** Expected bindings used when selecting the next reviewed stage. */
export type SelectWorkspaceSearchMigrationRehearsalStageInput = {
  /** Untrusted serialized or in-memory reviewed manifest. */
  readonly manifest: unknown
  /** Main 32-byte rehearsal evidence verification key. */
  readonly verificationKey: Uint8Array
  /** Previous untrusted stage receipt, or null before global stage one. */
  readonly previousReceipt: unknown | null
  /** Exact operator-provided control argument vector for the next child. */
  readonly controlArguments: readonly string[]
  /** Digest of the selected fault plan, or null for an unfaulted stage. */
  readonly faultPlanDigest: string | null
}

/** One exact rate segment assigned to one authenticated stage receipt. */
export type WorkspaceSearchMigrationRehearsalStageRateSegmentBinding =
  WorkspaceSearchMigrationRehearsalStageRateSegment & {
    /** Global stage ordinal owning this segment. */
    readonly stageOrdinal: number
    /** Digest of the exact stage receipt owning this segment. */
    readonly stageReceiptDigest: string
  }

/** One identifier-free process attempt derived from contiguous receipts. */
export type WorkspaceSearchMigrationRehearsalStageChainAttempt = {
  /** One-based scenario attempt ordinal. */
  readonly ordinal: number
  /** Domain-separated restricted attempt locator. */
  readonly attemptLocatorDigest: string
  /** Domain-separated restricted owner locator. */
  readonly ownerLocatorDigest: string
  /** Every durable writer-fence digest observed by this attempt. */
  readonly writerFenceDigests: readonly string[]
  /** Canonical beginning of the first stage in the attempt. */
  readonly startedAt: string
  /** Canonical final parent-observed process exit in the attempt. */
  readonly completedAt: string
  /** Final finite outcome of the attempt. */
  readonly outcome: WorkspaceSearchMigrationRehearsalStageChainAttemptOutcome
  /** Matching predecessor or reached fault receipt, otherwise null. */
  readonly faultReceiptDigest: string | null
  /** Exact parent process lifecycle digests assigned to this attempt. */
  readonly processLifecycleDigests: readonly string[]
  /** Parent-clock observation of the final process exit in this attempt. */
  readonly processExitedAt: string
}

/** Complete authenticated chain projection for one isolated scenario. */
export type WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence = {
  /** Canonical required scenario label. */
  readonly name: WorkspaceSearchMigrationRehearsalScenarioName
  /** Canonical first stage start time. */
  readonly startedAt: string
  /** Canonical parent-observed exit of the final release process. */
  readonly completedAt: string
  /** Lower integrity-window bound at successful close-replan completion. */
  readonly integrityWindowStartedAt: string
  /** Upper integrity-window bound before the terminal fence is reopened. */
  readonly integrityWindowCompletedAt: string
  /** Canonical durable writer-fence close time. */
  readonly writersClosedAt: string
  /** Digest of the exact canonical closed writer-fence record. */
  readonly closeEvidenceDigest: string
  /** Canonical beginning of the observed zero-writer drain. */
  readonly drainStartedAt: string
  /** Canonical completion of the observed zero-writer drain. */
  readonly drainCompletedAt: string
  /** Digest of the admitted boundary carrying the exact drain evidence. */
  readonly drainEvidenceDigest: string
  /** Canonical planning-admission commit time. */
  readonly planningAdmittedAt: string
  /** Canonical immutable plan creation time. */
  readonly planCreatedAt: string
  /** Canonical sealed-authority publication time. */
  readonly replannedAt: string
  /** Canonical beginning of the apply or committed-prefix attempt. */
  readonly applyStartedAt: string
  /** Canonical durable complete-apply or committed-prefix boundary time. */
  readonly applyBoundaryAt: string
  /** Canonical beginning of terminal verification or rollback. */
  readonly terminalStartedAt: string
  /** Canonical publication time of the authoritative terminal root. */
  readonly terminalRootPublishedAt: string
  /** Canonical completion of terminal verification or rollback. */
  readonly terminalCompletedAt: string
  /** Digest of the exact immutable terminal evidence projection. */
  readonly terminalEvidenceDigest: string
  /** Canonical durable terminal-bound writer-fence release time. */
  readonly releasedAt: string
  /** Digest of the ordered receipt chain and identifier-free attempts. */
  readonly attemptLifecycleDigest: string
  /** Domain-separated restricted run locator shared by every stage. */
  readonly runLocatorDigest: string
  /** Every exact stage receipt digest in scenario ordinal order. */
  readonly stageReceiptDigests: readonly string[]
  /** Every unique authenticated durable-stage reservation digest in order. */
  readonly stageReservationDigests: readonly string[]
  /** Durable claim-head revisions corresponding one-to-one with receipts. */
  readonly stageReservationClaimRevisions: readonly number[]
  /** Durable committed-head revisions corresponding one-to-one with receipts. */
  readonly stageReservationCommitRevisions: readonly number[]
  /** Every exact trusted serialized output-line digest in stage order. */
  readonly serializedOutputLineDigests: readonly string[]
  /** Every exact rate segment assigned once in stage ordinal order. */
  readonly rateSegmentBindings:
    readonly WorkspaceSearchMigrationRehearsalStageRateSegmentBinding[]
  /** Contiguous identifier-free process attempts. */
  readonly attempts:
    readonly WorkspaceSearchMigrationRehearsalStageChainAttempt[]
  /** Exact non-zero sealed plan operation count. */
  readonly sealedPlanOperationCount: number
  /** Exact complete-plan or committed-prefix applied count. */
  readonly appliedOperationCount: number
  /** Exact immutable sealed plan digest. */
  readonly sealedPlanDigest: string
  /** Digest of the durable admitted planning boundary. */
  readonly planningEvidenceDigest: string
  /** Digest of the exact apply or committed-prefix boundary. */
  readonly applyEvidenceDigest: string
  /** Exact injected failpoint, or null for an unfaulted scenario. */
  readonly failpoint: WorkspaceSearchMigrationRehearsalFailpoint | null
  /** Digest of the exact safe fault receipt, or null when unfaulted. */
  readonly faultReceiptDigest: string | null
  /** Digest of the normalized adapter fault observation, or null. */
  readonly faultObservationDigest: string | null
  /** Secret-free adapter fault observation, or null when unfaulted. */
  readonly faultObservation:
    WorkspaceSearchMigrationRehearsalFaultObservation | null
  /** Canonical runtime fault time, or null when unfaulted. */
  readonly faultReachedAt: string | null
  /** Canonical parent-confirmed SIGKILL exit time, or null otherwise. */
  readonly killConfirmedAt: string | null
  /** Every exact parent process lifecycle digest in stage order. */
  readonly processLifecycleDigests: readonly string[]
  /** Canonical predecessor lease expiry, or null without takeover. */
  readonly predecessorLeaseExpiresAt: string | null
  /** Canonical successor lease acquisition, or null without takeover. */
  readonly takeoverAcquiredAt: string | null
  /** Canonical response-loss reconciliation time, or null otherwise. */
  readonly reconciledAt: string | null
  /** Exact terminal action. */
  readonly terminalAction:
    'rollback-complete' | 'rollback-partial' | 'verify'
  /** Authoritative terminal kind. */
  readonly terminalKind: 'rolled-back' | 'verified'
  /** Authoritative terminal persistence version. */
  readonly terminalPersistenceVersion: 1 | 2
  /** Digest of the complete authoritative terminal root. */
  readonly terminalRootDigest: string
  /** Digest of the exact canonical released writer-fence record. */
  readonly releasedFenceDigest: string
  /** Pre-apply target-audit artifact content digest when required. */
  readonly targetPreimageArtifactContentDigest: string | null
  /** Rollback target-audit artifact content digest when required. */
  readonly targetRollbackArtifactContentDigest: string | null
  /** Rollback target-audit semantic observation digest when required. */
  readonly targetRollbackObservationDigest: string | null
  /** Purpose-bound integrity classification when required. */
  readonly integrityPurpose:
    | 'complete-rollback'
    | 'partial-rollback'
    | 'verified'
    | null
  /** Authenticated before-result digest when required. */
  readonly integrityBeforeResultDigest: string | null
  /** Authenticated after-result digest when required. */
  readonly integrityAfterResultDigest: string | null
  /** Purpose-bound comparison digest when required. */
  readonly integrityComparisonDigest: string | null
  /** Finalized purpose-bound integrity context digest when required. */
  readonly integrityContextDigest: string | null
  /** Mandatory duplicate applications observed by terminal audit. */
  readonly duplicateApplyCount: 0
  /** Mandatory expected applications missing at terminal audit. */
  readonly lostItemCount: 0
  /** Mandatory orphan durable authorities at terminal audit. */
  readonly orphanAuthorityCount: 0
  /** Complete parent-authenticated expectation for the later audit artifact. */
  readonly reconciliationContext:
    WorkspaceSearchMigrationRehearsalReconciliationAuditContext
  /** Digest of the complete secret-free authenticated artifact binding. */
  readonly reconciliationArtifactBindingDigest: string
  /** SHA-256 digest of the actual canonical reconciliation artifact bytes. */
  readonly reconciliationArtifactContentDigest: string
  /** Exact positive canonical reconciliation artifact byte length. */
  readonly reconciliationArtifactByteLength: number
  /** Digest of the complete authenticated reconciliation semantics. */
  readonly reconciliationArtifactAuditDigest: string
  /** Exact auxiliary reconciliation rate segment and ledger binding. */
  readonly reconciliationRate:
    WorkspaceSearchMigrationRehearsalRateSegmentEvidence
  /** Digest of the terminal reconciliation expectation binding. */
  readonly reconciliationAuditDigest: string
}

/** Fully authenticated exact stage chain across all eight scenarios. */
export type WorkspaceSearchMigrationRehearsalStageChainEvidence = {
  /** Digest of the authenticated reviewed manifest. */
  readonly manifestDigest: string
  /** Exact reviewed implementation commit OID. */
  readonly commit: string
  /** Source-controlled CDK deployment trust root for the complete chain. */
  readonly deploymentTrustRootDigest: string
  /** Digest of the authenticated rehearsal permit. */
  readonly permitDigest: string
  /** Requested-resource binding authenticated by the permit. */
  readonly requestedResourcesBinding: string
  /** Exact immutable resource identity scheme authenticated by the manifest. */
  readonly integrityResourceIdentityScheme:
    WorkspaceSearchMigrationRehearsalStageManifest[
      'integrityResourceIdentityScheme'
    ]
  /** Exact canonical seven-entry resource vector authenticated by the manifest. */
  readonly integrityResourceIdentities:
    WorkspaceSearchMigrationRehearsalStageManifest[
      'integrityResourceIdentities'
    ]
  /** Aggregate keyed resource identity digest authenticated by the manifest. */
  readonly integrityResourceIdentityDigest: string
  /** Reviewed measured configuration binding. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable policy digest. */
  readonly policyVersion: string
  /** Canonical protected-review time from the signed manifest. */
  readonly reviewedAt: string
  /** Digest of global stage receipt one. */
  readonly firstStageReceiptDigest: string
  /** Digest of the final global release receipt. */
  readonly terminalStageReceiptDigest: string
  /** Expected durable manifest-head revision after the final receipt commit. */
  readonly terminalStageHeadRevision: number
  /** Exact number of authenticated stage receipts. */
  readonly receiptCount: number
  /** Canonical beginning of global stage one. */
  readonly startedAt: string
  /** Canonical parent-observed exit of the final global release process. */
  readonly completedAt: string
  /** Exact eight scenario projections in canonical order. */
  readonly scenarios:
    readonly WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence[]
}

/** Input for deriving one complete authenticated full-suite stage chain. */
export type DeriveWorkspaceSearchMigrationRehearsalStageChainEvidenceInput = {
  /** Untrusted serialized or in-memory reviewed manifest. */
  readonly manifest: unknown
  /** Untrusted receipts supplied in exact global ordinal order. */
  readonly receipts: readonly unknown[]
  /** Main 32-byte rehearsal evidence verification key. */
  readonly verificationKey: Uint8Array
  /** Ordered immutable abandonment artifacts and their reservation documents. */
  readonly reservationAbandonments?:
    readonly WorkspaceSearchMigrationRehearsalReservationAbandonmentInput[]
  /** Parent-only key required when any reservation was abandoned. */
  readonly publicationVerificationKey?: Uint8Array
}

/** One persisted abandonment artifact paired with its runtime reservation. */
export type WorkspaceSearchMigrationRehearsalReservationAbandonmentInput = {
  /** Parent-authenticated immutable abandonment artifact. */
  readonly abandonment: unknown
  /** Runtime-authenticated reservation named by the artifact. */
  readonly reservation: unknown
}

/** Opaque runtime-branded one-shot handle to a verified complete stage chain. */
export type WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence = {
  /** Fixed runtime-only capability discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_STAGE_CHAIN_KIND
}

/** Purpose-bound integrity window read from a finalized stage capability. */
export type WorkspaceSearchMigrationRehearsalStageIntegrityWindow = {
  /** Exact scenario owning the required integrity comparison. */
  readonly scenario:
    | 'complete-apply-rollback'
    | 'happy-path-verified'
    | 'partial-apply-rollback'
  /** Purpose preventing comparison replay between scenario classes. */
  readonly purpose: 'complete-rollback' | 'partial-rollback' | 'verified'
  /** Successful close-replan receipt completion lower bound. */
  readonly startedAt: string
  /** Terminal verify or rollback receipt completion upper bound. */
  readonly completedAt: string
}

/** Exact values committed by one terminal reconciliation-audit digest. */
export type CreateWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigestInput = {
  /** Canonical scenario whose terminal state was audited. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Digest of the authoritative terminal root. */
  readonly terminalRootDigest: string
  /** Purpose-bound finalized integrity context, when required. */
  readonly integrityContextDigest: string | null
  /** Apply-before target artifact content digest, when required. */
  readonly targetPreimageArtifactContentDigest: string | null
  /** Rollback target artifact content digest, when required. */
  readonly targetRollbackArtifactContentDigest: string | null
  /** Rollback target semantic observation digest, when required. */
  readonly targetRollbackObservationDigest: string | null
  /** Mandatory duplicate-application terminal audit zero. */
  readonly duplicateApplyCount: 0
  /** Mandatory missing-application terminal audit zero. */
  readonly lostItemCount: 0
  /** Mandatory orphan-authority terminal audit zero. */
  readonly orphanAuthorityCount: 0
}

/** Exact stage receipt claim fields. */
const receiptClaimKeys = Object.freeze([
  'attemptLocatorDigest',
  'attemptOrdinal',
  'command',
  'commit',
  'completedAt',
  'configurationBindingDigest',
  'controlArgumentsDigest',
  'evidence',
  'faultBoundary',
  'faultReceiptDigest',
  'expectedAuthorities',
  'integrityResourceIdentities',
  'integrityResourceIdentityDigest',
  'integrityResourceIdentityScheme',
  'kind',
  'leaseIdentityDigest',
  'leaseObservation',
  'manifestDigest',
  'manifestEntryDigest',
  'outcome',
  'ownerLocatorDigest',
  'permitDigest',
  'policyVersion',
  'predecessorLeaseExpiresAt',
  'previousStageReceiptDigest',
  'processLifecycle',
  'rateSegment',
  'receiptVersion',
  'reconciledAt',
  'requestedResourcesBinding',
  'runLocatorDigest',
  'scenario',
  'scenarioStageOrdinal',
  'serializedOutputLineDigest',
  'stage',
  'stageOrdinal',
  'stageReservationClaimRevision',
  'stageReservationCommitRevision',
  'stageReservationAbandonmentCount',
  'stageReservationAbandonmentRootDigest',
  'stageReservationDigest',
  'startedAt',
  'takeoverAcquiredAt',
  'writerFenceDigest',
])

/** Exact authenticated receipt fields. */
const receiptKeys = Object.freeze([...receiptClaimKeys, 'receiptMac'])

/** Exact identifier-free rate segment fields. */
const rateSegmentKeys = Object.freeze([
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

/** Exact trusted parent process-lifecycle fields. */
const processLifecycleKeys = Object.freeze([
  'exitClass',
  'lifecycleDigest',
  'parentDecisionRecordedAt',
  'processExitedAt',
  'receiptObservedAt',
  'receiptPersistedAt',
  'runnerStartedAt',
])

/** HMAC domain separating stage receipts from all other evidence. */
const receiptMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-stage-receipt/v1\0'

/** HMAC domain separating restricted locator digests from receipts. */
const locatorMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-locator/v1\0'

/** Exact main evidence-key length. */
const evidenceKeyByteLength = 32

/** Strict guards converting every malformed input to one stable failure. */
const stageGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failStageReceipt,
)

/** Module-private provenance for finalized one-shot stage capabilities. */
const finalizedStageChains = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalStageChainEvidence
>()

/** Module-private replay guard for consumed stage capabilities. */
const consumedFinalizedStageChains = new WeakSet<object>()

/**
 * Creates one authenticated receipt over trusted in-process stage results.
 *
 * @param input - Strict receipt claims and main evidence key.
 * @returns Frozen canonical authenticated receipt.
 */
export function createWorkspaceSearchMigrationRehearsalStageReceipt(
  input: CreateWorkspaceSearchMigrationRehearsalStageReceiptInput,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  let claims: unknown
  let signingKey: unknown
  try {
    claims = input.claims
    signingKey = input.signingKey
  } catch {
    return failStageReceipt()
  }
  const normalizedClaims = readReceiptClaims(claims)
  const key = copyEvidenceKey(signingKey)
  try {
    requireReceiptRateAuthenticationKeyFingerprint(normalizedClaims, key)
    return Object.freeze({
      ...normalizedClaims,
      receiptMac: createReceiptMac(normalizedClaims, key),
    })
  } finally {
    key.fill(0)
  }
}

/**
 * Authenticates and validates one canonical stage receipt.
 *
 * @param value - Untrusted serialized or in-memory receipt.
 * @param verificationKey - Main 32-byte rehearsal evidence key.
 * @returns Frozen detached authenticated receipt.
 */
export function verifyWorkspaceSearchMigrationRehearsalStageReceipt(
  value: unknown,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const record = stageGuards.requireRecord(value)
  stageGuards.requireExactKeys(record, receiptKeys)
  const claims = readReceiptClaims(record)
  const receiptMac = stageGuards.readDigest(
    stageGuards.readOwn(record, 'receiptMac'),
  )
  const key = copyEvidenceKey(verificationKey)
  try {
    requireReceiptRateAuthenticationKeyFingerprint(claims, key)
    if (!safeDigestEqual(receiptMac, createReceiptMac(claims, key))) {
      return failStageReceipt()
    }
  } finally {
    key.fill(0)
  }
  return Object.freeze({ ...claims, receiptMac })
}

/**
 * Parses exact canonical receipt bytes and authenticates their HMAC.
 *
 * @param bytes - Untrusted bounded receipt file bytes without a trailing LF.
 * @param verificationKey - Main 32-byte rehearsal evidence key.
 * @returns Frozen detached authenticated stage receipt.
 */
export function parseWorkspaceSearchMigrationRehearsalStageReceiptDocument(
  bytes: Uint8Array,
  verificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalStageReceipt {
  const value = parseCanonicalStageDocument(
    bytes,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_MAX_BYTES,
  )
  const receipt = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
    value,
    verificationKey,
  )
  requireCanonicalStageDocument(bytes, receipt)
  return receipt
}

/**
 * Derives the exact complete eight-scenario chain from authenticated receipts.
 *
 * Every entry, previous-receipt digest, stage binding, actual-rate segment,
 * semantic count, terminal root, and recovery timestamp is validated before a
 * projection is returned. Partial chains and unreviewed advancement fail.
 *
 * @param input - Reviewed manifest, globally ordered receipts, and main key.
 * @returns Complete publication-safe chain evidence.
 */
export function deriveWorkspaceSearchMigrationRehearsalStageChainEvidence(
  input: DeriveWorkspaceSearchMigrationRehearsalStageChainEvidenceInput,
): WorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence {
  let manifestValue: unknown
  let receiptValues: unknown
  let verificationKey: unknown
  let reservationAbandonmentValues: unknown = []
  let publicationVerificationKey: unknown
  try {
    manifestValue = input.manifest
    receiptValues = input.receipts
    verificationKey = input.verificationKey
    reservationAbandonmentValues = input.reservationAbandonments ?? []
    publicationVerificationKey = input.publicationVerificationKey
  } catch {
    return failStageReceipt()
  }
  if (!Array.isArray(receiptValues) || nodeUtilTypes.isProxy(receiptValues)) {
    return failStageReceipt()
  }
  if (
    !Array.isArray(reservationAbandonmentValues) ||
    nodeUtilTypes.isProxy(reservationAbandonmentValues)
  ) return failStageReceipt()
  const key = copyEvidenceKey(verificationKey)
  let publicationKey: Uint8Array | undefined
  try {
    const manifest = verifyWorkspaceSearchMigrationRehearsalStageManifest(
      manifestValue,
      key,
    )
    if (
      receiptValues.length !== manifest.entries.length ||
      receiptValues.length === 0
    ) return failStageReceipt()
    const manifestDigest = createMigrationDigest(manifest)
    const receipts: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
    const receiptDigests: string[] = []
    let previousDigest: string | null = null
    let previousReceipt:
      WorkspaceSearchMigrationRehearsalStageReceipt | undefined
    let previousStageReservationCommitRevision = 0
    let previousStageReservationAbandonmentCount = 0
    let previousStageReservationAbandonmentRootDigest =
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INITIAL_ABANDONMENT_ROOT_DIGEST
    const rateSegmentLocators = new Set<string>()
    const rateSegmentDigests = new Set<string>()
    const rateSegmentMacs = new Set<string>()
    const processLifecycleDigests = new Set<string>()
    const stageReservationDigests = new Set<string>()
    let reservationAbandonmentIndex = 0
    for (let index = 0; index < receiptValues.length; index += 1) {
      const receipt = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        receiptValues[index],
        key,
      )
      const entry = manifest.entries[index]
      if (entry === undefined) return failStageReceipt()
      requireReceiptMatchesManifest(
        receipt,
        entry,
        manifest,
        manifestDigest,
        previousDigest,
        previousReceipt,
      )
      if (
        previousReceipt !== undefined &&
        (Date.parse(receipt.startedAt) <=
            Date.parse(previousReceipt.completedAt) ||
          Date.parse(receipt.startedAt) <=
            Date.parse(previousReceipt.processLifecycle.processExitedAt))
      ) return failStageReceipt()
      const abandonmentDelta =
        receipt.stageReservationAbandonmentCount -
        previousStageReservationAbandonmentCount
      if (abandonmentDelta > 0 && publicationKey === undefined) {
        publicationKey = copyEvidenceKey(publicationVerificationKey)
      }
      for (
        let abandonmentOffset = 0;
        abandonmentOffset < abandonmentDelta;
        abandonmentOffset += 1
      ) {
        const abandonmentInput = stageGuards.requireRecord(
          reservationAbandonmentValues[reservationAbandonmentIndex],
        )
        stageGuards.requireExactKeys(abandonmentInput, [
          'abandonment',
          'reservation',
        ])
        const abandonment =
          verifyWorkspaceSearchMigrationRehearsalStageReservationAbandonment({
            abandonment: stageGuards.readOwn(
              abandonmentInput,
              'abandonment',
            ),
            reservation: stageGuards.readOwn(
              abandonmentInput,
              'reservation',
            ),
            selection: Object.freeze({
              manifest,
              manifestDigest,
              entry,
              previousStageReceiptDigest: previousDigest,
            }),
            runtimeVerificationKey: key,
            publicationVerificationKey:
              publicationKey ?? failStageReceipt(),
          })
        if (
          abandonment.stageOrdinal !== receipt.stageOrdinal ||
          abandonment.previousAbandonmentCount !==
            previousStageReservationAbandonmentCount ||
          abandonment.previousAbandonmentRootDigest !==
            previousStageReservationAbandonmentRootDigest ||
          abandonment.reservationClaimRevision !==
            previousStageReservationCommitRevision + 1 ||
          abandonment.abandonmentRevision !==
            abandonment.reservationClaimRevision + 1 ||
          abandonment.reservationDigest ===
            receipt.stageReservationDigest
        ) return failStageReceipt()
        previousStageReservationCommitRevision =
          abandonment.abandonmentRevision
        previousStageReservationAbandonmentCount =
          abandonment.abandonmentCount
        previousStageReservationAbandonmentRootDigest =
          abandonment.abandonmentRootDigest
        reservationAbandonmentIndex += 1
      }
      if (
        abandonmentDelta < 0 ||
        receipt.stageReservationClaimRevision !==
          previousStageReservationCommitRevision + 1 ||
        receipt.stageReservationCommitRevision !==
          receipt.stageReservationClaimRevision + 1 ||
        receipt.stageReservationAbandonmentCount !==
          previousStageReservationAbandonmentCount ||
        receipt.stageReservationAbandonmentRootDigest !==
          previousStageReservationAbandonmentRootDigest ||
        stageReservationDigests.has(receipt.stageReservationDigest)
      ) return failStageReceipt()
      previousStageReservationCommitRevision =
        receipt.stageReservationCommitRevision
      previousStageReservationAbandonmentCount =
        receipt.stageReservationAbandonmentCount
      previousStageReservationAbandonmentRootDigest =
        receipt.stageReservationAbandonmentRootDigest
      stageReservationDigests.add(receipt.stageReservationDigest)
      requireGlobalRateSegment(
        receipt.rateSegment,
        previousReceipt?.rateSegment,
        rateSegmentLocators,
        rateSegmentDigests,
        rateSegmentMacs,
      )
      if (
        processLifecycleDigests.has(
          receipt.processLifecycle.lifecycleDigest,
        )
      ) return failStageReceipt()
      processLifecycleDigests.add(receipt.processLifecycle.lifecycleDigest)
      receipts.push(receipt)
      const digest = createMigrationDigest(receipt)
      receiptDigests.push(digest)
      previousDigest = digest
      previousReceipt = receipt
    }
    if (
      reservationAbandonmentIndex !==
        reservationAbandonmentValues.length
    ) return failStageReceipt()
    const scenarios: WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence[] = []
    const runLocators = new Set<string>()
    for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
      const firstIndex = manifest.entries.findIndex(
        (entry) => entry.scenario === scenario,
      )
      if (firstIndex < 0) return failStageReceipt()
      let endIndex = firstIndex
      while (manifest.entries[endIndex]?.scenario === scenario) endIndex += 1
      const scenarioProjection = deriveScenarioChainEvidence(
        scenario,
        receipts.slice(firstIndex, endIndex),
        receiptDigests.slice(firstIndex, endIndex),
      )
      if (runLocators.has(scenarioProjection.runLocatorDigest)) {
        return failStageReceipt()
      }
      runLocators.add(scenarioProjection.runLocatorDigest)
      scenarios.push(scenarioProjection)
    }
    const first = receipts[0]
    const terminal = receipts.at(-1)
    const firstDigest = receiptDigests[0]
    const terminalDigest = receiptDigests.at(-1)
    if (
      first === undefined ||
      terminal === undefined ||
      firstDigest === undefined ||
      terminalDigest === undefined ||
      terminal.command !== 'release'
    ) return failStageReceipt()
    const projection: WorkspaceSearchMigrationRehearsalStageChainEvidence =
      Object.freeze({
      manifestDigest,
      commit: manifest.commit,
      deploymentTrustRootDigest: manifest.deploymentTrustRootDigest,
      permitDigest: manifest.permitDigest,
      requestedResourcesBinding: manifest.requestedResourcesBinding,
      integrityResourceIdentityScheme:
        manifest.integrityResourceIdentityScheme,
      integrityResourceIdentities: manifest.integrityResourceIdentities,
      integrityResourceIdentityDigest:
        manifest.integrityResourceIdentityDigest,
      configurationBindingDigest: manifest.configurationBindingDigest,
      policyVersion: manifest.policyVersion,
      reviewedAt: manifest.reviewedAt,
      firstStageReceiptDigest: firstDigest,
      terminalStageReceiptDigest: terminalDigest,
      terminalStageHeadRevision:
        terminal.stageReservationCommitRevision,
      receiptCount: receipts.length,
      startedAt: first.startedAt,
      completedAt: terminal.processLifecycle.processExitedAt,
      scenarios: Object.freeze(scenarios),
    })
    const capability = Object.freeze({
      kind:
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_STAGE_CHAIN_KIND,
    })
    finalizedStageChains.set(capability, projection)
    return capability
  } finally {
    key.fill(0)
    publicationKey?.fill(0)
  }
}

/**
 * Reads only the three purpose-bound windows without consuming capability.
 *
 * @param value - Runtime-branded finalized stage-chain capability.
 * @returns Three immutable integrity windows in purpose order.
 */
export function readWorkspaceSearchMigrationRehearsalFinalizedStageChainIntegrityWindows(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalStageIntegrityWindow[] {
  const projection = requireFinalizedStageChain(value, false)
  const verified = requireStageChainScenario(
    projection,
    'happy-path-verified',
  )
  const partial = requireStageChainScenario(
    projection,
    'partial-apply-rollback',
  )
  const complete = requireStageChainScenario(
    projection,
    'complete-apply-rollback',
  )
  return Object.freeze([
    Object.freeze({
      scenario: verified.name,
      purpose: 'verified',
      startedAt: verified.integrityWindowStartedAt,
      completedAt: verified.integrityWindowCompletedAt,
    }),
    Object.freeze({
      scenario: partial.name,
      purpose: 'partial-rollback',
      startedAt: partial.integrityWindowStartedAt,
      completedAt: partial.integrityWindowCompletedAt,
    }),
    Object.freeze({
      scenario: complete.name,
      purpose: 'complete-rollback',
      startedAt: complete.integrityWindowStartedAt,
      completedAt: complete.integrityWindowCompletedAt,
    }),
  ])
}

/**
 * Reads the exact eight parent-authenticated reconciliation contexts.
 *
 * Every context is projected from the actual dual-key-authenticated
 * reconciliation artifact already bound into its terminal receipt HMAC. The
 * accessor returns detached snapshots in canonical scenario order without
 * consuming the stage-chain capability.
 *
 * @param value - Runtime-branded finalized stage-chain capability.
 * @returns Eight detached frozen contexts in canonical scenario order.
 */
export function readWorkspaceSearchMigrationRehearsalFinalizedStageChainReconciliationContexts(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalReconciliationAuditContext[] {
  const projection = requireFinalizedStageChain(value, false)
  if (
    projection.scenarios.length !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS.length
  ) return failStageReceipt()
  return Object.freeze(
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS.map(
      (expectedScenario, index) => {
        const scenario = projection.scenarios[index]
        if (
          scenario === undefined ||
          scenario.name !== expectedScenario ||
          scenario.reconciliationContext.scenario !== expectedScenario
        ) return failStageReceipt()
        return snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext(
          scenario.reconciliationContext,
        )
      },
    ),
  )
}

/**
 * Consumes one finalized capability and returns its immutable plain projection.
 *
 * @param value - Runtime-branded finalized stage-chain capability.
 * @returns Complete verified publication-safe stage-chain evidence once.
 */
export function consumeWorkspaceSearchMigrationRehearsalFinalizedStageChainEvidence(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageChainEvidence {
  const projection = requireFinalizedStageChain(value, true)
  const capability = stageGuards.requireRecord(value)
  consumedFinalizedStageChains.add(capability)
  finalizedStageChains.delete(capability)
  return projection
}

/** Requires a genuine unconsumed module-private finalized capability. */
function requireFinalizedStageChain(
  value: unknown,
  forConsumption: boolean,
): WorkspaceSearchMigrationRehearsalStageChainEvidence {
  if (
    !stageGuards.isRecord(value) ||
    consumedFinalizedStageChains.has(value)
  ) return failStageReceipt()
  stageGuards.requireExactKeys(value, ['kind'])
  if (
    stageGuards.readOwn(value, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FINALIZED_STAGE_CHAIN_KIND
  ) return failStageReceipt()
  const projection = finalizedStageChains.get(value)
  if (projection === undefined) return failStageReceipt()
  if (forConsumption && consumedFinalizedStageChains.has(value)) {
    return failStageReceipt()
  }
  return projection
}

/** Reads one required scenario from the canonical finalized projection. */
function requireStageChainScenario<
  Name extends
    | 'complete-apply-rollback'
    | 'happy-path-verified'
    | 'partial-apply-rollback',
>(
  projection: WorkspaceSearchMigrationRehearsalStageChainEvidence,
  name: Name,
): WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence & {
  readonly name: Name
} {
  const scenario = projection.scenarios.find(
    (candidate) => candidate.name === name,
  )
  if (scenario === undefined) return failStageReceipt()
  return Object.freeze({ ...scenario, name })
}

/**
 * Selects only the immediate reviewed successor and validates resume chaining.
 *
 * The operator-provided argument and fault-plan digests must match the signed
 * entry exactly. No stage is inferred from child stdout or durable status.
 *
 * @param input - Manifest, key, previous receipt, and exact next inputs.
 * @returns Authenticated next stage selection.
 */
export function selectWorkspaceSearchMigrationRehearsalStage(
  input: SelectWorkspaceSearchMigrationRehearsalStageInput,
): WorkspaceSearchMigrationRehearsalSelectedStage {
  let manifestValue: unknown
  let verificationKey: unknown
  let previousReceiptValue: unknown
  let controlArguments: unknown
  let faultPlanDigest: unknown
  try {
    manifestValue = input.manifest
    verificationKey = input.verificationKey
    previousReceiptValue = input.previousReceipt
    controlArguments = input.controlArguments
    faultPlanDigest = input.faultPlanDigest
  } catch {
    return failStageReceipt()
  }
  const key = copyEvidenceKey(verificationKey)
  try {
    const manifest = verifyWorkspaceSearchMigrationRehearsalStageManifest(
      manifestValue,
      key,
    )
    const manifestDigest = createMigrationDigest(manifest)
    let nextOrdinal = 1
    let previousStageReceiptDigest: string | null = null
    if (previousReceiptValue !== null) {
      const previous = verifyWorkspaceSearchMigrationRehearsalStageReceipt(
        previousReceiptValue,
        key,
      )
      const previousEntry = manifest.entries[previous.stageOrdinal - 1]
      if (
        previous.manifestDigest !== manifestDigest ||
        previous.stageOrdinal >= manifest.entries.length ||
        previousEntry === undefined
      ) {
        return failStageReceipt()
      }
      requireReceiptMatchesManifestEntry(
        previous,
        previousEntry,
        manifest,
        manifestDigest,
      )
      nextOrdinal = previous.stageOrdinal + 1
      previousStageReceiptDigest = createMigrationDigest(previous)
    }
    const entry = manifest.entries[nextOrdinal - 1]
    if (entry === undefined) return failStageReceipt()
    const argumentsSnapshot = readControlArguments(controlArguments)
    const selectedFaultPlanDigest = readNullableDigest(faultPlanDigest)
    if (
      entry.controlArgumentsDigest !==
        createMigrationDigest(argumentsSnapshot) ||
      entry.faultPlanDigest !== selectedFaultPlanDigest ||
      argumentsSnapshot[0] !== entry.command
    ) {
      return failStageReceipt()
    }
    return Object.freeze({
      manifest,
      manifestDigest,
      entry,
      previousStageReceiptDigest,
    })
  } finally {
    key.fill(0)
  }
}

/** Requires one receipt to match its exact signed manifest entry and chain. */
function requireReceiptMatchesManifest(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  manifestDigest: string,
  previousDigest: string | null,
  previousReceipt:
    WorkspaceSearchMigrationRehearsalStageReceipt | undefined,
): void {
  requireReceiptMatchesManifestEntry(
    receipt,
    entry,
    manifest,
    manifestDigest,
  )
  if (
    receipt.previousStageReceiptDigest !== previousDigest ||
    receipt.stageOrdinal !== entry.ordinal
  ) return failStageReceipt()
  requireReceiptLeaseChain(receipt, previousReceipt)
  if (previousReceipt === undefined) {
    if (entry.ordinal !== 1 || receipt.attemptOrdinal !== 1) {
      return failStageReceipt()
    }
    return
  }
  if (receipt.scenario === previousReceipt.scenario) {
    if (
      receipt.runLocatorDigest !== previousReceipt.runLocatorDigest ||
      (receipt.attemptOrdinal === previousReceipt.attemptOrdinal &&
        (receipt.attemptLocatorDigest !==
          previousReceipt.attemptLocatorDigest ||
          receipt.ownerLocatorDigest !== previousReceipt.ownerLocatorDigest)) ||
      (receipt.attemptOrdinal !== previousReceipt.attemptOrdinal &&
        (receipt.attemptOrdinal !== previousReceipt.attemptOrdinal + 1 ||
          receipt.attemptLocatorDigest ===
            previousReceipt.attemptLocatorDigest ||
          receipt.ownerLocatorDigest === previousReceipt.ownerLocatorDigest))
    ) return failStageReceipt()
  } else if (receipt.attemptOrdinal !== 1) {
    return failStageReceipt()
  }
  if (receipt.outcome === 'takeover-completed') {
    const leaseObservation = receipt.leaseObservation
    if (
      previousReceipt.scenario !== receipt.scenario ||
      previousReceipt.outcome !== 'fault-reached' ||
      previousReceipt.faultReceiptDigest === null ||
      previousReceipt.faultBoundary === null ||
      previousReceipt.faultBoundary.faultReceiptDigest !==
        previousReceipt.faultReceiptDigest ||
      leaseObservation.kind !== 'acquired' ||
      leaseObservation.predecessorLeaseIdentityDigest !==
        previousReceipt.faultBoundary.leaseIdentityDigest ||
      leaseObservation.predecessorLeaseExpiresAt === null ||
      Date.parse(leaseObservation.predecessorLeaseExpiresAt) >
        Date.parse(leaseObservation.acquiredAt) ||
      Date.parse(leaseObservation.acquiredAt) >=
        Date.parse(leaseObservation.successorLeaseExpiresAt) ||
      receipt.faultReceiptDigest !== previousReceipt.faultReceiptDigest ||
      receipt.attemptOrdinal !== previousReceipt.attemptOrdinal + 1 ||
      receipt.predecessorLeaseExpiresAt === null ||
      Date.parse(receipt.predecessorLeaseExpiresAt) <=
        Date.parse(previousReceipt.processLifecycle.processExitedAt)
    ) return failStageReceipt()
  }
}

/**
 * Requires authenticated lease continuity across stage and attempt boundaries.
 *
 * @param receipt - Current authenticated receipt.
 * @param previousReceipt - Immediate authenticated predecessor when present.
 */
function requireReceiptLeaseChain(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  previousReceipt:
    WorkspaceSearchMigrationRehearsalStageReceipt | undefined,
): void {
  const observation = receipt.leaseObservation
  if (previousReceipt === undefined) {
    if (
      receipt.attemptOrdinal !== 1 ||
      observation.kind !== 'acquired'
    ) return failStageReceipt()
    return
  }
  if (previousReceipt.scenario !== receipt.scenario) {
    if (
      receipt.attemptOrdinal !== 1 ||
      observation.kind !== 'acquired' ||
      observation.predecessorLeaseIdentityDigest !==
        previousReceipt.leaseIdentityDigest ||
      observation.predecessorLeaseExpiresAt === null ||
      Date.parse(observation.predecessorLeaseExpiresAt) <=
        Date.parse(previousReceipt.processLifecycle.processExitedAt) ||
      Date.parse(observation.predecessorLeaseExpiresAt) >
        Date.parse(observation.acquiredAt)
    ) return failStageReceipt()
    return
  }
  if (receipt.attemptOrdinal === previousReceipt.attemptOrdinal) {
    if (observation.kind === 'reused-active') {
      if (
        observation.currentLeaseIdentityDigest !==
          previousReceipt.leaseIdentityDigest
      ) return failStageReceipt()
      return
    }
    if (
      observation.predecessorLeaseIdentityDigest !==
        previousReceipt.leaseIdentityDigest ||
      observation.predecessorLeaseExpiresAt === null ||
      Date.parse(observation.predecessorLeaseExpiresAt) <=
        Date.parse(previousReceipt.processLifecycle.processExitedAt) ||
      Date.parse(observation.predecessorLeaseExpiresAt) >
        Date.parse(observation.acquiredAt)
    ) return failStageReceipt()
    return
  }
  if (
    observation.kind !== 'acquired' ||
    observation.predecessorLeaseIdentityDigest === null ||
    observation.predecessorLeaseExpiresAt === null
  ) return failStageReceipt()
}

/** Requires one authenticated receipt to match its signed manifest entry. */
function requireReceiptMatchesManifestEntry(
  receipt: WorkspaceSearchMigrationRehearsalStageReceipt,
  entry: WorkspaceSearchMigrationRehearsalStageManifestEntry,
  manifest: WorkspaceSearchMigrationRehearsalStageManifest,
  manifestDigest: string,
): void {
  if (
    receipt.stageOrdinal !== entry.ordinal ||
    receipt.scenario !== entry.scenario ||
    receipt.scenarioStageOrdinal !== entry.scenarioStageOrdinal ||
    receipt.command !== entry.command ||
    receipt.controlArgumentsDigest !== entry.controlArgumentsDigest ||
    receipt.attemptOrdinal !== entry.attemptOrdinal ||
    receipt.outcome !== entry.expectedOutcome ||
    receipt.manifestDigest !== manifestDigest ||
    receipt.manifestEntryDigest !== createMigrationDigest(entry) ||
    receipt.permitDigest !== manifest.permitDigest ||
    receipt.commit !== manifest.commit ||
    receipt.requestedResourcesBinding !==
      manifest.requestedResourcesBinding ||
    receipt.integrityResourceIdentityScheme !==
      manifest.integrityResourceIdentityScheme ||
    serializeCanonicalJson(receipt.integrityResourceIdentities) !==
      serializeCanonicalJson(manifest.integrityResourceIdentities) ||
    receipt.integrityResourceIdentityDigest !==
      manifest.integrityResourceIdentityDigest ||
    receipt.configurationBindingDigest !==
      manifest.configurationBindingDigest ||
    receipt.policyVersion !== manifest.policyVersion ||
    (entry.faultPlanDigest !== null) !==
      (receipt.faultBoundary !== null)
  ) return failStageReceipt()
}

/** Requires one globally unique forward-moving authenticated child segment. */
function requireGlobalRateSegment(
  segment: WorkspaceSearchMigrationRehearsalStageRateSegment,
  previous: WorkspaceSearchMigrationRehearsalStageRateSegment | undefined,
  segmentLocators: Set<string>,
  segmentDigests: Set<string>,
  segmentMacs: Set<string>,
): void {
  if (
    segmentLocators.has(segment.segmentLocatorDigest) ||
    segmentDigests.has(segment.segmentDigest) ||
    segmentMacs.has(segment.terminalRecordMac) ||
    (previous !== undefined &&
      (previous.authenticationKeyFingerprint !==
          segment.authenticationKeyFingerprint ||
        previous.segmentOrdinal >= segment.segmentOrdinal ||
        (previous.lastCommittedEventSequence !== null &&
          segment.firstCommittedEventSequence !== null &&
          previous.lastCommittedEventSequence >=
            segment.firstCommittedEventSequence)))
  ) return failStageReceipt()
  segmentLocators.add(segment.segmentLocatorDigest)
  segmentDigests.add(segment.segmentDigest)
  segmentMacs.add(segment.terminalRecordMac)
}

/** Derives and cross-validates one complete scenario's durable stage graph. */
function deriveScenarioChainEvidence(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[],
  receiptDigests: readonly string[],
): WorkspaceSearchMigrationRehearsalStageChainScenarioEvidence {
  if (
    receipts.length < 4 ||
    receipts.length !== receiptDigests.length ||
    receipts[0]?.scenario !== scenario ||
    receipts.at(-1)?.command !== 'release'
  ) return failStageReceipt()
  let planning:
    WorkspaceSearchMigrationRehearsalPlanningStageEvidence | undefined
  let apply:
    WorkspaceSearchMigrationRehearsalApplyStageEvidence | undefined
  let fault:
    WorkspaceSearchMigrationRehearsalFaultStageEvidence | undefined
  let terminal:
    WorkspaceSearchMigrationRehearsalTerminalStageEvidence | undefined
  let release:
    WorkspaceSearchMigrationRehearsalReleaseStageEvidence | undefined
  let planningReceipt:
    WorkspaceSearchMigrationRehearsalStageReceipt | undefined
  let releaseReceipt:
    WorkspaceSearchMigrationRehearsalStageReceipt | undefined
  let terminalReceipt:
    WorkspaceSearchMigrationRehearsalStageReceipt | undefined
  let applyBoundaryReceipt:
    WorkspaceSearchMigrationRehearsalStageReceipt | undefined
  let faultStageReceipt:
    WorkspaceSearchMigrationRehearsalStageReceipt | undefined
  const runLocatorDigest = receipts[0]?.runLocatorDigest
  if (runLocatorDigest === undefined) return failStageReceipt()
  const rateSegmentBindings:
    WorkspaceSearchMigrationRehearsalStageRateSegmentBinding[] = []
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = receipts[index]
    const receiptDigest = receiptDigests[index]
    if (
      receipt === undefined ||
      receiptDigest === undefined ||
      receipt.scenario !== scenario ||
      receipt.runLocatorDigest !== runLocatorDigest
    ) return failStageReceipt()
    const evidence = receipt.evidence
    if (receipt.faultBoundary !== null) {
      if (fault !== undefined) return failStageReceipt()
      fault = receipt.faultBoundary
      faultStageReceipt = receipt
    }
    if (evidence.kind === 'planning-sealed') {
      if (planning !== undefined) return failStageReceipt()
      planning = evidence
      planningReceipt = receipt
    } else if (evidence.kind === 'apply-complete') {
      if (apply !== undefined) return failStageReceipt()
      apply = evidence
      applyBoundaryReceipt = receipt
    } else if (evidence.kind === 'fault-boundary') {
      if (
        receipt.faultBoundary === null ||
        createMigrationDigest(receipt.faultBoundary) !==
          createMigrationDigest(evidence)
      ) return failStageReceipt()
      if (evidence.failpoint === 'apply-operation-committed-before-return') {
        applyBoundaryReceipt = receipt
      }
    } else if (evidence.kind === 'terminal') {
      if (terminal !== undefined) return failStageReceipt()
      terminal = evidence
      terminalReceipt = receipt
    } else {
      if (release !== undefined) return failStageReceipt()
      release = evidence
      releaseReceipt = receipt
    }
    rateSegmentBindings.push(Object.freeze({
      ...receipt.rateSegment,
      stageOrdinal: receipt.stageOrdinal,
      stageReceiptDigest: receiptDigest,
    }))
  }
  if (
    planning === undefined ||
    terminal === undefined ||
    release === undefined ||
    planningReceipt === undefined ||
    terminalReceipt === undefined ||
    applyBoundaryReceipt === undefined ||
    releaseReceipt === undefined ||
    planningReceipt.writerFenceDigest !==
      planning.closedWriterFenceRecordDigest ||
    releaseReceipt.writerFenceDigest !==
      release.releasedWriterFenceRecordDigest ||
    terminal.executionBoundaryDigest !== planning.executionBoundaryDigest ||
    terminal.sealedPlanningAuthorityDigest !==
      planning.sealedPlanningAuthorityDigest ||
    terminal.planDigest !== planning.planDigest ||
    terminal.sealedPlanOperationCount !==
      planning.sealedPlanOperationCount ||
    release.terminalKind !== terminal.terminalKind ||
    release.terminalPersistenceVersion !==
      terminal.terminalPersistenceVersion ||
    release.terminalRootDigest !== terminal.terminalRootDigest
  ) return failStageReceipt()
  const expectedTerminal = scenario === 'partial-apply-rollback'
    ? 'rollback-partial'
    : scenario === 'complete-apply-rollback'
    ? 'rollback-complete'
    : 'verify'
  if (terminal.command !== expectedTerminal) return failStageReceipt()
  const expectedFailpoint = expectedScenarioFailpoint(scenario)
  if (
    (expectedFailpoint === null) !== (fault === undefined) ||
    (fault !== undefined && fault.failpoint !== expectedFailpoint) ||
    (fault !== undefined &&
      fault.sealedPlanOperationCount !== null &&
      fault.sealedPlanOperationCount !== planning.sealedPlanOperationCount)
  ) return failStageReceipt()
  if (faultStageReceipt !== undefined) {
    const expectedExitClass = scenario === 'transaction-response-loss'
      ? 'successful-response-loss'
      : 'confirmed-sigkill'
    if (faultStageReceipt.processLifecycle.exitClass !== expectedExitClass) {
      return failStageReceipt()
    }
  }
  for (const receipt of receipts) {
    if (
      receipt !== faultStageReceipt &&
      receipt.processLifecycle.exitClass !== 'successful-no-fault'
    ) return failStageReceipt()
  }
  let appliedOperationCount: number
  let applyEvidenceDigest: string
  let reconciliationApplyBoundaryDigest: string
  let targetPreimageArtifactContentDigest: string | null
  if (scenario === 'partial-apply-rollback') {
    if (
      apply !== undefined ||
      fault === undefined ||
      fault.failpoint !== 'apply-operation-committed-before-return' ||
      fault.sealedPlanOperationCount !==
        planning.sealedPlanOperationCount ||
      fault.appliedOperationCount <= 0 ||
      fault.targetPreimageArtifactContentDigest === null
    ) return failStageReceipt()
    appliedOperationCount = fault.appliedOperationCount
    applyEvidenceDigest = createMigrationDigest(fault)
    reconciliationApplyBoundaryDigest =
      terminal.reconciliationContext.applyBoundaryDigest
    targetPreimageArtifactContentDigest =
      fault.targetPreimageArtifactContentDigest
  } else {
    if (
      apply === undefined ||
      apply.planDigest !== planning.planDigest ||
      apply.sealedPlanOperationCount !==
        planning.sealedPlanOperationCount ||
      apply.appliedOperationCount !== planning.sealedPlanOperationCount
    ) return failStageReceipt()
    appliedOperationCount = apply.appliedOperationCount
    applyEvidenceDigest = createMigrationDigest(apply)
    reconciliationApplyBoundaryDigest = apply.appliedRootDigest
    targetPreimageArtifactContentDigest =
      apply.targetPreimageArtifactContentDigest
  }
  if (
    terminal.appliedOperationCount !== appliedOperationCount ||
    (scenario === 'partial-apply-rollback' ||
      scenario === 'complete-apply-rollback') !==
      (targetPreimageArtifactContentDigest !== null)
  ) return failStageReceipt()
  requireScenarioAuditEvidence(
    scenario,
    terminal,
    targetPreimageArtifactContentDigest,
    runLocatorDigest,
    terminalReceipt.configurationBindingDigest,
    reconciliationApplyBoundaryDigest,
    terminalReceipt.completedAt,
    terminalReceipt.rateSegment,
  )
  const faultReceiptDigest = fault?.faultReceiptDigest ?? null
  const faultObservationDigest = fault?.faultObservationDigest ?? null
  const faultObservation = fault?.faultObservation ?? null
  const faultReachedAt = fault?.reachedAt ?? null
  const killConfirmedAt =
    faultStageReceipt?.processLifecycle.exitClass === 'confirmed-sigkill'
      ? faultStageReceipt.processLifecycle.processExitedAt
      : null
  const takeoverReceipts = receipts.filter(
    (receipt) => receipt.outcome === 'takeover-completed',
  )
  const reconciliationReceipts = receipts.filter(
    (receipt) => receipt.outcome === 'response-loss-reconciled',
  )
  const takeoverReceipt = takeoverReceipts[0]
  const reconciliationReceipt = reconciliationReceipts[0]
  if (
    takeoverReceipts.length !==
      (requiresSigkillTakeover(scenario) ? 1 : 0) ||
    reconciliationReceipts.length !==
      (scenario === 'transaction-response-loss' ? 1 : 0)
  ) return failStageReceipt()
  const attempts = deriveScenarioAttempts(receipts)
  requireScenarioAttemptShape(scenario, attempts)
  const first = receipts[0]
  const last = receipts.at(-1)
  if (first === undefined || last === undefined) return failStageReceipt()
  const processLifecycleDigests = receipts.map(
    (receipt) => receipt.processLifecycle.lifecycleDigest,
  )
  const stageReservationDigests = receipts.map(
    (receipt) => receipt.stageReservationDigest,
  )
  const stageReservationClaimRevisions = receipts.map(
    (receipt) => receipt.stageReservationClaimRevision,
  )
  const stageReservationCommitRevisions = receipts.map(
    (receipt) => receipt.stageReservationCommitRevision,
  )
  const attemptLifecycleDigest = createMigrationDigest({
    stageReceiptDigests: receiptDigests,
    stageReservationDigests,
    stageReservationClaimRevisions,
    stageReservationCommitRevisions,
    processLifecycleDigests,
    attempts,
  })
  return Object.freeze({
    name: scenario,
    startedAt: first.startedAt,
    completedAt: last.processLifecycle.processExitedAt,
    integrityWindowStartedAt: planningReceipt.completedAt,
    integrityWindowCompletedAt: terminalReceipt.completedAt,
    writersClosedAt: planning.closedAt,
    closeEvidenceDigest: planning.closedWriterFenceRecordDigest,
    drainStartedAt: planning.drainStartedAt,
    drainCompletedAt: planning.drainCompletedAt,
    drainEvidenceDigest: planning.executionBoundaryDigest,
    planningAdmittedAt: planning.admittedAt,
    planCreatedAt: planning.planCreatedAt,
    replannedAt: planning.sealedAt,
    applyStartedAt: applyBoundaryReceipt.startedAt,
    applyBoundaryAt: apply === undefined
      ? fault?.reachedAt ?? failStageReceipt()
      : apply.appliedAt,
    terminalStartedAt: terminalReceipt.startedAt,
    terminalRootPublishedAt: terminal.terminalAt,
    terminalCompletedAt: terminalReceipt.completedAt,
    terminalEvidenceDigest: createMigrationDigest(terminal),
    releasedAt: release.releasedAt,
    attemptLifecycleDigest,
    runLocatorDigest,
    stageReceiptDigests: Object.freeze([...receiptDigests]),
    stageReservationDigests: Object.freeze(stageReservationDigests),
    stageReservationClaimRevisions: Object.freeze(
      stageReservationClaimRevisions,
    ),
    stageReservationCommitRevisions: Object.freeze(
      stageReservationCommitRevisions,
    ),
    serializedOutputLineDigests: Object.freeze(
      receipts.map((receipt) => receipt.serializedOutputLineDigest),
    ),
    rateSegmentBindings: Object.freeze(rateSegmentBindings),
    attempts,
    sealedPlanOperationCount: planning.sealedPlanOperationCount,
    appliedOperationCount,
    sealedPlanDigest: planning.planDigest,
    planningEvidenceDigest: createMigrationDigest(planning),
    applyEvidenceDigest,
    failpoint: expectedFailpoint,
    faultReceiptDigest,
    faultObservationDigest,
    faultObservation,
    faultReachedAt,
    killConfirmedAt,
    processLifecycleDigests: Object.freeze(processLifecycleDigests),
    predecessorLeaseExpiresAt:
      takeoverReceipt?.predecessorLeaseExpiresAt ?? null,
    takeoverAcquiredAt: takeoverReceipt?.takeoverAcquiredAt ?? null,
    reconciledAt: reconciliationReceipt?.reconciledAt ?? null,
    terminalAction: terminal.command,
    terminalKind: terminal.terminalKind,
    terminalPersistenceVersion: terminal.terminalPersistenceVersion,
    terminalRootDigest: terminal.terminalRootDigest,
    releasedFenceDigest: release.releasedWriterFenceRecordDigest,
    targetPreimageArtifactContentDigest,
    targetRollbackArtifactContentDigest:
      terminal.targetRollbackArtifactContentDigest,
    targetRollbackObservationDigest:
      terminal.targetRollbackObservationDigest,
    integrityPurpose: terminal.integrityPurpose,
    integrityBeforeResultDigest: terminal.integrityBeforeResultDigest,
    integrityAfterResultDigest: terminal.integrityAfterResultDigest,
    integrityComparisonDigest: terminal.integrityComparisonDigest,
    integrityContextDigest: terminal.integrityContextDigest,
    duplicateApplyCount: terminal.duplicateApplyCount,
    lostItemCount: terminal.lostItemCount,
    orphanAuthorityCount: terminal.orphanAuthorityCount,
    reconciliationContext: terminal.reconciliationContext,
    reconciliationArtifactBindingDigest:
      terminal.reconciliationArtifactBindingDigest,
    reconciliationArtifactContentDigest:
      terminal.reconciliationArtifactContentDigest,
    reconciliationArtifactByteLength:
      terminal.reconciliationArtifactByteLength,
    reconciliationArtifactAuditDigest:
      terminal.reconciliationArtifactAuditDigest,
    reconciliationRate: terminal.reconciliationRate,
    reconciliationAuditDigest: terminal.reconciliationAuditDigest,
  })
}

/**
 * Requires exact purpose-bound terminal reconciliation expectations.
 *
 * @param scenario - Canonical scenario owning the terminal receipt.
 * @param terminal - Strict terminal evidence copied into that receipt.
 * @param targetPreimageArtifactContentDigest - Optional pre-apply target file.
 * @param runLocatorDigest - Authenticated scenario run locator.
 * @param configurationBindingDigest - Reviewed measured configuration.
 * @param applyBoundaryDigest - Exact admitted apply or prefix boundary.
 * @param terminalReceiptCompletedAt - Upper bound for expectation checks.
 * @param terminalRate - Exact child rate segment preceding reconciliation.
 */
function requireScenarioAuditEvidence(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  terminal: WorkspaceSearchMigrationRehearsalTerminalStageEvidence,
  targetPreimageArtifactContentDigest: string | null,
  runLocatorDigest: string,
  configurationBindingDigest: string,
  applyBoundaryDigest: string,
  terminalReceiptCompletedAt: string,
  terminalRate: WorkspaceSearchMigrationRehearsalStageRateSegment,
): void {
  const expectedPurpose = scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : scenario === 'complete-apply-rollback'
    ? 'complete-rollback'
    : 'verified'
  const hasRollbackTarget =
    terminal.targetRollbackArtifactContentDigest !== null
  const expectedReconciliationAuditDigest =
    createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest({
      scenario,
      terminalRootDigest: terminal.terminalRootDigest,
      integrityContextDigest: terminal.integrityContextDigest,
      targetPreimageArtifactContentDigest,
      targetRollbackArtifactContentDigest:
        terminal.targetRollbackArtifactContentDigest,
      targetRollbackObservationDigest:
        terminal.targetRollbackObservationDigest,
      duplicateApplyCount: terminal.duplicateApplyCount,
      lostItemCount: terminal.lostItemCount,
      orphanAuthorityCount: terminal.orphanAuthorityCount,
    })
  const reconciliationContext = terminal.reconciliationContext
  const rollbackTargetAudits = expectedPurpose === 'verified'
    ? null
    : reconciliationContext.targetAudits
  const reconciliationPredecessor = expectedPurpose === 'verified'
    ? terminalRate
    : rollbackTargetAudits?.restored.rate.successor
  if (
    reconciliationPredecessor === undefined ||
    serializeCanonicalJson(terminal.reconciliationRate.predecessor) !==
      serializeCanonicalJson(reconciliationPredecessor) ||
    reconciliationContext.scenario !== scenario ||
    reconciliationContext.runLocatorDigest !== runLocatorDigest ||
    reconciliationContext.configurationBindingDigest !==
      configurationBindingDigest ||
    reconciliationContext.applyBoundaryDigest !== applyBoundaryDigest ||
    Date.parse(reconciliationContext.checkedAt) >
      Date.parse(terminalReceiptCompletedAt) ||
    terminal.reconciliationRate.completedAt !== terminalReceiptCompletedAt ||
    terminal.reconciliationArtifactBindingDigest ===
      terminal.reconciliationArtifactContentDigest ||
    terminal.reconciliationArtifactBindingDigest ===
      terminal.reconciliationArtifactAuditDigest ||
    terminal.reconciliationArtifactContentDigest ===
      terminal.reconciliationArtifactAuditDigest ||
    terminal.integrityPurpose !== expectedPurpose ||
    (expectedPurpose === 'verified' &&
      (terminal.integrityBeforeResultDigest !== null ||
        terminal.integrityAfterResultDigest === null ||
        terminal.integrityComparisonDigest !== null ||
        terminal.integrityContextDigest === null ||
        reconciliationContext.integrity.kind !== 'verified-result' ||
        terminal.integrityAfterResultDigest !==
          reconciliationContext.integrity.result.resultDigest ||
        terminal.integrityContextDigest !==
          reconciliationContext.integrity.resultContextDigest)) ||
    (expectedPurpose !== 'verified' &&
      (terminal.integrityBeforeResultDigest === null ||
        terminal.integrityAfterResultDigest === null ||
        terminal.integrityComparisonDigest === null ||
        terminal.integrityContextDigest === null ||
        reconciliationContext.integrity.kind !== 'rollback-comparison' ||
        terminal.integrityBeforeResultDigest !==
          reconciliationContext.integrity.before.resultDigest ||
        terminal.integrityAfterResultDigest !==
          reconciliationContext.integrity.after.resultDigest ||
        terminal.integrityComparisonDigest !==
          reconciliationContext.integrity.comparisonDigest ||
        terminal.integrityContextDigest !==
          reconciliationContext.integrity.comparisonContextDigest)) ||
    ((scenario === 'partial-apply-rollback' ||
      scenario === 'complete-apply-rollback') !== hasRollbackTarget) ||
    ((scenario === 'partial-apply-rollback' ||
      scenario === 'complete-apply-rollback') !==
      (targetPreimageArtifactContentDigest !== null)) ||
    hasRollbackTarget !==
      (terminal.targetRollbackObservationDigest !== null) ||
    (expectedPurpose === 'verified') !==
      (reconciliationContext.targetAudits === null) ||
    (rollbackTargetAudits !== null &&
      (rollbackTargetAudits.preimage.contentDigest !==
          targetPreimageArtifactContentDigest ||
        rollbackTargetAudits.restored.contentDigest !==
          terminal.targetRollbackArtifactContentDigest ||
        rollbackTargetAudits.restored.observationDigest !==
          terminal.targetRollbackObservationDigest ||
        reconciliationContext.integrity.kind !== 'rollback-comparison' ||
        rollbackTargetAudits.preimage.aggregateDigest !==
          reconciliationContext.integrity.targetPreimageAggregateDigest ||
        rollbackTargetAudits.restored.aggregateDigest !==
          reconciliationContext.integrity.targetRestoredAggregateDigest)) ||
    terminal.reconciliationAuditDigest !==
      expectedReconciliationAuditDigest
  ) return failStageReceipt()
}

/** Derives contiguous identifier-free process attempts from stage receipts. */
function deriveScenarioAttempts(
  receipts: readonly WorkspaceSearchMigrationRehearsalStageReceipt[],
): readonly WorkspaceSearchMigrationRehearsalStageChainAttempt[] {
  const attempts: WorkspaceSearchMigrationRehearsalStageChainAttempt[] = []
  let cursor = 0
  while (cursor < receipts.length) {
    const first = receipts[cursor]
    if (first === undefined) return failStageReceipt()
    const ordinal = first.attemptOrdinal
    const group: WorkspaceSearchMigrationRehearsalStageReceipt[] = []
    while (receipts[cursor]?.attemptOrdinal === ordinal) {
      const receipt = receipts[cursor]
      if (receipt === undefined) return failStageReceipt()
      group.push(receipt)
      cursor += 1
    }
    const last = group.at(-1)
    if (last === undefined) return failStageReceipt()
    const writerFenceDigests: string[] = []
    for (const receipt of group) {
      if (
        receipt.attemptLocatorDigest !== first.attemptLocatorDigest ||
        receipt.ownerLocatorDigest !== first.ownerLocatorDigest
      ) return failStageReceipt()
      if (!writerFenceDigests.includes(receipt.writerFenceDigest)) {
        writerFenceDigests.push(receipt.writerFenceDigest)
      }
    }
    const killedReceipt = group.find(
      (receipt) =>
        receipt.processLifecycle.exitClass === 'confirmed-sigkill',
    )
    const takeover = group.find(
      (receipt) => receipt.outcome === 'takeover-completed',
    )
    const reconciliation = group.find(
      (receipt) => receipt.outcome === 'response-loss-reconciled',
    )
    const outcome:
      WorkspaceSearchMigrationRehearsalStageChainAttemptOutcome =
        killedReceipt === undefined
          ? takeover === undefined
            ? reconciliation === undefined
              ? 'completed'
              : 'response-loss-reconciled'
            : 'takeover-completed'
          : 'killed-at-fault'
    const faultReceiptDigest = killedReceipt?.faultReceiptDigest ??
      reconciliation?.faultReceiptDigest ??
      null
    const processLifecycleDigests = group.map(
      (receipt) => receipt.processLifecycle.lifecycleDigest,
    )
    attempts.push(Object.freeze({
      ordinal,
      attemptLocatorDigest: first.attemptLocatorDigest,
      ownerLocatorDigest: first.ownerLocatorDigest,
      writerFenceDigests: Object.freeze(writerFenceDigests),
      startedAt: first.startedAt,
      completedAt: last.processLifecycle.processExitedAt,
      outcome,
      faultReceiptDigest,
      processLifecycleDigests: Object.freeze(processLifecycleDigests),
      processExitedAt: last.processLifecycle.processExitedAt,
    }))
  }
  return Object.freeze(attempts)
}

/** Requires the public one- or two-attempt shape for one scenario. */
function requireScenarioAttemptShape(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  attempts: readonly WorkspaceSearchMigrationRehearsalStageChainAttempt[],
): void {
  const first = attempts[0]
  if (first === undefined) return failStageReceipt()
  if (
    scenario === 'happy-path-verified' ||
    scenario === 'complete-apply-rollback'
  ) {
    if (
      attempts.length !== 1 ||
      first.outcome !== 'completed' ||
      first.faultReceiptDigest !== null
    ) return failStageReceipt()
    return
  }
  if (scenario === 'transaction-response-loss') {
    if (
      attempts.length !== 1 ||
      first.outcome !== 'response-loss-reconciled' ||
      first.faultReceiptDigest === null
    ) return failStageReceipt()
    return
  }
  const successor = attempts[1]
  if (
    !requiresSigkillTakeover(scenario) ||
    attempts.length !== 2 ||
    successor === undefined ||
    first.outcome !== 'killed-at-fault' ||
    first.faultReceiptDigest === null ||
    successor.outcome !== 'takeover-completed' ||
    successor.faultReceiptDigest !== null ||
    Date.parse(successor.startedAt) <= Date.parse(first.completedAt)
  ) return failStageReceipt()
}

/** Returns whether one reviewed fault requires SIGKILL lease takeover. */
function requiresSigkillTakeover(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): boolean {
  switch (scenario) {
    case 'cursor-before-commit-kill':
    case 'cursor-after-commit-kill':
    case 'artifact-before-checkpoint-kill':
    case 'lease-expiry-takeover':
    case 'partial-apply-rollback':
      return true
    case 'happy-path-verified':
    case 'transaction-response-loss':
    case 'complete-apply-rollback':
      return false
  }
}

/** Maps each required fault scenario to its exact runtime failpoint. */
function expectedScenarioFailpoint(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalFailpoint | null {
  switch (scenario) {
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

/**
 * Creates a domain-separated opaque digest for one restricted identifier.
 *
 * @param kind - Finite locator purpose.
 * @param value - Restricted non-empty identifier never returned by this API.
 * @param authenticationKey - Main 32-byte rehearsal evidence key.
 * @returns HMAC-SHA-256 locator safe for external receipts.
 */
export function createWorkspaceSearchMigrationRehearsalLocatorDigest(
  kind: 'attempt' | 'owner' | 'run',
  value: string,
  authenticationKey: Uint8Array,
): string {
  if (
    (kind !== 'attempt' && kind !== 'owner' && kind !== 'run') ||
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 8_192 ||
    value !== value.trim() ||
    value.includes('\0')
  ) {
    return failStageReceipt()
  }
  const key = copyEvidenceKey(authenticationKey)
  try {
    return createHmac('sha256', key)
      .update(locatorMacDomain, 'utf8')
      .update(kind, 'utf8')
      .update('\0', 'utf8')
      .update(value, 'utf8')
      .digest('hex')
  } finally {
    key.fill(0)
  }
}

/**
 * Creates the exact domain-versioned terminal reconciliation-audit digest.
 *
 * @param input - Scenario, terminal, finalized audit bindings, and zero counts.
 * @returns Canonical SHA-256 reconciliation-audit binding.
 */
export function createWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigest(
  input:
    CreateWorkspaceSearchMigrationRehearsalStageReconciliationAuditDigestInput,
): string {
  let scenarioValue: unknown
  let terminalRootDigestValue: unknown
  let integrityContextDigestValue: unknown
  let targetPreimageArtifactContentDigestValue: unknown
  let targetRollbackArtifactContentDigestValue: unknown
  let targetRollbackObservationDigestValue: unknown
  let duplicateApplyCountValue: unknown
  let lostItemCountValue: unknown
  let orphanAuthorityCountValue: unknown
  try {
    scenarioValue = input.scenario
    terminalRootDigestValue = input.terminalRootDigest
    integrityContextDigestValue = input.integrityContextDigest
    targetPreimageArtifactContentDigestValue =
      input.targetPreimageArtifactContentDigest
    targetRollbackArtifactContentDigestValue =
      input.targetRollbackArtifactContentDigest
    targetRollbackObservationDigestValue =
      input.targetRollbackObservationDigest
    duplicateApplyCountValue = input.duplicateApplyCount
    lostItemCountValue = input.lostItemCount
    orphanAuthorityCountValue = input.orphanAuthorityCount
  } catch {
    return failStageReceipt()
  }
  const scenario = readScenario(scenarioValue)
  const terminalRootDigest = stageGuards.readDigest(
    terminalRootDigestValue,
  )
  const integrityContextDigest = readNullableDigest(
    integrityContextDigestValue,
  )
  const targetPreimageArtifactContentDigest = readNullableDigest(
    targetPreimageArtifactContentDigestValue,
  )
  const targetRollbackArtifactContentDigest = readNullableDigest(
    targetRollbackArtifactContentDigestValue,
  )
  const targetRollbackObservationDigest = readNullableDigest(
    targetRollbackObservationDigestValue,
  )
  const duplicateApplyCount = readRequiredZero(duplicateApplyCountValue)
  const lostItemCount = readRequiredZero(lostItemCountValue)
  const orphanAuthorityCount = readRequiredZero(orphanAuthorityCountValue)
  const rollbackAudit =
    scenario === 'partial-apply-rollback' ||
    scenario === 'complete-apply-rollback'
  if (
    integrityContextDigest === null ||
    rollbackAudit !== (targetPreimageArtifactContentDigest !== null) ||
    rollbackAudit !== (targetRollbackArtifactContentDigest !== null) ||
    rollbackAudit !== (targetRollbackObservationDigest !== null)
  ) return failStageReceipt()
  return createMigrationDigest({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECONCILIATION_AUDIT_KIND,
    auditVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECONCILIATION_AUDIT_VERSION,
    scenario,
    terminalRootDigest,
    integrityContextDigest,
    targetPreimageArtifactContentDigest,
    targetRollbackArtifactContentDigest,
    targetRollbackObservationDigest,
    duplicateApplyCount,
    lostItemCount,
    orphanAuthorityCount,
  })
}


/**
 * Reads one exact canonical acquisition or active-lease observation.
 *
 * @param value - Untrusted lease observation value.
 * @returns Frozen validated cycle-free lease observation.
 */
function readStageLeaseObservation(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageLeaseObservation {
  const record = stageGuards.requireRecord(value)
  const kind = stageGuards.readOwn(record, 'kind')
  if (kind === 'acquired') {
    stageGuards.requireExactKeys(record, [
      'acquiredAt',
      'kind',
      'predecessorLeaseExpiresAt',
      'predecessorLeaseIdentityDigest',
      'successorLeaseExpiresAt',
      'successorLeaseIdentityDigest',
    ])
    const predecessorLeaseIdentityDigest = readNullableDigest(
      stageGuards.readOwn(record, 'predecessorLeaseIdentityDigest'),
    )
    const predecessorLeaseExpiresAt = readNullableTimestamp(
      stageGuards.readOwn(record, 'predecessorLeaseExpiresAt'),
    )
    const acquiredAt = stageGuards.readTimestamp(
      stageGuards.readOwn(record, 'acquiredAt'),
    )
    const successorLeaseIdentityDigest = readDigestOwn(
      record,
      'successorLeaseIdentityDigest',
    )
    const successorLeaseExpiresAt = stageGuards.readTimestamp(
      stageGuards.readOwn(record, 'successorLeaseExpiresAt'),
    )
    if (
      (predecessorLeaseIdentityDigest === null) !==
        (predecessorLeaseExpiresAt === null) ||
      (predecessorLeaseExpiresAt !== null &&
        Date.parse(predecessorLeaseExpiresAt) > Date.parse(acquiredAt)) ||
      Date.parse(acquiredAt) >= Date.parse(successorLeaseExpiresAt)
    ) return failStageReceipt()
    return Object.freeze({
      kind,
      predecessorLeaseIdentityDigest,
      predecessorLeaseExpiresAt,
      acquiredAt,
      successorLeaseIdentityDigest,
      successorLeaseExpiresAt,
    })
  }
  if (kind === 'reused-active') {
    stageGuards.requireExactKeys(record, [
      'currentLeaseExpiresAt',
      'currentLeaseIdentityDigest',
      'evaluatedAt',
      'kind',
    ])
    const currentLeaseIdentityDigest = readDigestOwn(
      record,
      'currentLeaseIdentityDigest',
    )
    const evaluatedAt = stageGuards.readTimestamp(
      stageGuards.readOwn(record, 'evaluatedAt'),
    )
    const currentLeaseExpiresAt = stageGuards.readTimestamp(
      stageGuards.readOwn(record, 'currentLeaseExpiresAt'),
    )
    if (Date.parse(evaluatedAt) >= Date.parse(currentLeaseExpiresAt)) {
      return failStageReceipt()
    }
    return Object.freeze({
      kind,
      currentLeaseIdentityDigest,
      evaluatedAt,
      currentLeaseExpiresAt,
    })
  }
  return failStageReceipt()
}

/**
 * Returns the current identity represented by one validated lease observation.
 *
 * @param observation - Validated acquisition or active-lease observation.
 * @returns Current durable lease identity digest.
 */
function readStageLeaseObservationIdentity(
  observation: WorkspaceSearchMigrationRehearsalStageLeaseObservation,
): string {
  return observation.kind === 'acquired'
    ? observation.successorLeaseIdentityDigest
    : observation.currentLeaseIdentityDigest
}

/** Reads one exact cumulative FIFO authority-adoption chain. */
function readExpectedAuthorities(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalExpectedAuthority[] {
  if (
    !Array.isArray(value) ||
    nodeUtilTypes.isProxy(value) ||
    value.length > 100_000
  ) return failStageReceipt()
  const keys = Object.keys(value)
  if (
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index))
  ) return failStageReceipt()
  const authorities: WorkspaceSearchMigrationRehearsalExpectedAuthority[] = []
  const digests = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) return failStageReceipt()
    const record = stageGuards.requireRecord(descriptor.value)
    stageGuards.requireExactKeys(record, [
      'maintenanceEvidenceRenewalCount',
      'receiptDigest',
    ])
    const maintenanceEvidenceRenewalCount = readPositiveSafeInteger(
      stageGuards.readOwn(record, 'maintenanceEvidenceRenewalCount'),
    )
    const receiptDigest = readDigestOwn(record, 'receiptDigest')
    if (
      maintenanceEvidenceRenewalCount !== index + 1 ||
      digests.has(receiptDigest)
    ) return failStageReceipt()
    digests.add(receiptDigest)
    authorities.push(Object.freeze({
      maintenanceEvidenceRenewalCount,
      receiptDigest,
    }))
  }
  return Object.freeze(authorities)
}

/** Reads and validates exact detached receipt claims. */
function readReceiptClaims(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageReceiptClaims {
  const record = stageGuards.requireRecord(value)
  const keys = Object.keys(record)
  stageGuards.requireExactKeys(
    record,
    keys.includes('receiptMac') ? receiptKeys : receiptClaimKeys,
  )
  const kind = stageGuards.readOwn(record, 'kind')
  const receiptVersion = stageGuards.readOwn(record, 'receiptVersion')
  const stage = stageGuards.readOwn(record, 'stage')
  if (
    kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_KIND ||
    receiptVersion !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE_RECEIPT_VERSION ||
    stage !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_STAGE
  ) {
    return failStageReceipt()
  }
  const scenario = readScenario(stageGuards.readOwn(record, 'scenario'))
  const stageOrdinal = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'stageOrdinal'),
  )
  const scenarioStageOrdinal = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'scenarioStageOrdinal'),
  )
  const command = readStageCommand(stageGuards.readOwn(record, 'command'))
  const controlArgumentsDigest = readDigestOwn(record, 'controlArgumentsDigest')
  const serializedOutputLineDigest = readDigestOwn(
    record,
    'serializedOutputLineDigest',
  )
  const manifestDigest = readDigestOwn(record, 'manifestDigest')
  const manifestEntryDigest = readDigestOwn(record, 'manifestEntryDigest')
  const permitDigest = readDigestOwn(record, 'permitDigest')
  const commit = readCommit(stageGuards.readOwn(record, 'commit'))
  const requestedResourcesBinding = readDigestOwn(
    record,
    'requestedResourcesBinding',
  )
  const integrityResourceIdentityScheme = stageGuards.readOwn(
    record,
    'integrityResourceIdentityScheme',
  )
  if (
    integrityResourceIdentityScheme !==
      CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  ) return failStageReceipt()
  let integrityResourceIdentities:
    WorkspaceSearchMigrationRehearsalStageManifest[
      'integrityResourceIdentities'
    ]
  try {
    integrityResourceIdentities =
      parseCrossDomainIntegrityResourceIdentities(
        stageGuards.readOwn(record, 'integrityResourceIdentities'),
      )
  } catch {
    return failStageReceipt()
  }
  const integrityResourceIdentityDigest = readDigestOwn(
    record,
    'integrityResourceIdentityDigest',
  )
  const configurationBindingDigest = readDigestOwn(
    record,
    'configurationBindingDigest',
  )
  const policyVersion = readDigestOwn(record, 'policyVersion')
  const runLocatorDigest = readDigestOwn(record, 'runLocatorDigest')
  const attemptOrdinal = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'attemptOrdinal'),
  )
  const attemptLocatorDigest = readDigestOwn(record, 'attemptLocatorDigest')
  const ownerLocatorDigest = readDigestOwn(record, 'ownerLocatorDigest')
  const leaseIdentityDigest = readDigestOwn(record, 'leaseIdentityDigest')
  const leaseObservation = readStageLeaseObservation(
    stageGuards.readOwn(record, 'leaseObservation'),
  )
  const expectedAuthorities = readExpectedAuthorities(
    stageGuards.readOwn(record, 'expectedAuthorities'),
  )
  const writerFenceDigest = readDigestOwn(record, 'writerFenceDigest')
  const previousStageReceiptDigest = readNullableDigest(
    stageGuards.readOwn(record, 'previousStageReceiptDigest'),
  )
  const stageReservationDigest = readDigestOwn(
    record,
    'stageReservationDigest',
  )
  const stageReservationClaimRevision = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'stageReservationClaimRevision'),
  )
  const stageReservationCommitRevision = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'stageReservationCommitRevision'),
  )
  const stageReservationAbandonmentCount = readNonNegativeSafeInteger(
    stageGuards.readOwn(record, 'stageReservationAbandonmentCount'),
  )
  const stageReservationAbandonmentRootDigest = readDigestOwn(
    record,
    'stageReservationAbandonmentRootDigest',
  )
  const startedAt = stageGuards.readTimestamp(
    stageGuards.readOwn(record, 'startedAt'),
  )
  const completedAt = stageGuards.readTimestamp(
    stageGuards.readOwn(record, 'completedAt'),
  )
  const processLifecycle = readProcessLifecycle(
    stageGuards.readOwn(record, 'processLifecycle'),
  )
  const outcome = readStageOutcome(stageGuards.readOwn(record, 'outcome'))
  const faultReceiptDigest = readNullableDigest(
    stageGuards.readOwn(record, 'faultReceiptDigest'),
  )
  const faultBoundary = readNullableFaultEvidence(
    stageGuards.readOwn(record, 'faultBoundary'),
  )
  const predecessorLeaseExpiresAt = readNullableTimestamp(
    stageGuards.readOwn(record, 'predecessorLeaseExpiresAt'),
  )
  const takeoverAcquiredAt = readNullableTimestamp(
    stageGuards.readOwn(record, 'takeoverAcquiredAt'),
  )
  const reconciledAt = readNullableTimestamp(
    stageGuards.readOwn(record, 'reconciledAt'),
  )
  const evidence = readStageEvidence(stageGuards.readOwn(record, 'evidence'))
  const rateSegment = readRateSegment(
    stageGuards.readOwn(record, 'rateSegment'),
  )
  if (
    Date.parse(completedAt) < Date.parse(startedAt) ||
    Date.parse(processLifecycle.runnerStartedAt) > Date.parse(startedAt) ||
    evidenceCommand(evidence) !== command ||
    leaseIdentityDigest !==
      readStageLeaseObservationIdentity(leaseObservation) ||
    (stageOrdinal === 1) !== (previousStageReceiptDigest === null) ||
    stageReservationCommitRevision !==
      stageReservationClaimRevision + 1
  ) {
    return failStageReceipt()
  }
  requireOutcomeLifecycle({
    outcome,
    faultReceiptDigest,
    faultBoundary,
    predecessorLeaseExpiresAt,
    takeoverAcquiredAt,
    reconciledAt,
    startedAt,
    completedAt,
    processLifecycle,
    leaseIdentityDigest,
    leaseObservation,
    evidence,
  })
  return Object.freeze({
    kind,
    receiptVersion,
    stage,
    scenario,
    stageOrdinal,
    scenarioStageOrdinal,
    command,
    controlArgumentsDigest,
    serializedOutputLineDigest,
    manifestDigest,
    manifestEntryDigest,
    permitDigest,
    commit,
    requestedResourcesBinding,
    integrityResourceIdentityScheme,
    integrityResourceIdentities,
    integrityResourceIdentityDigest,
    configurationBindingDigest,
    policyVersion,
    runLocatorDigest,
    attemptOrdinal,
    attemptLocatorDigest,
    ownerLocatorDigest,
    leaseIdentityDigest,
    leaseObservation,
    expectedAuthorities,
    writerFenceDigest,
    previousStageReceiptDigest,
    stageReservationDigest,
    stageReservationClaimRevision,
    stageReservationCommitRevision,
    stageReservationAbandonmentCount,
    stageReservationAbandonmentRootDigest,
    startedAt,
    completedAt,
    processLifecycle,
    outcome,
    faultReceiptDigest,
    faultBoundary,
    predecessorLeaseExpiresAt,
    takeoverAcquiredAt,
    reconciledAt,
    evidence,
    rateSegment,
  })
}

/** Input for exact receipt lifecycle validation. */
type ReceiptLifecycleValidationInput = Pick<
  WorkspaceSearchMigrationRehearsalStageReceiptClaims,
  | 'completedAt'
  | 'faultBoundary'
  | 'faultReceiptDigest'
  | 'leaseIdentityDigest'
  | 'leaseObservation'
  | 'outcome'
  | 'predecessorLeaseExpiresAt'
  | 'processLifecycle'
  | 'reconciledAt'
  | 'startedAt'
  | 'takeoverAcquiredAt'
> & {
  /** Already validated exact durable stage evidence. */
  readonly evidence: WorkspaceSearchMigrationRehearsalStageEvidence
}

/** Requires outcome-specific fault, takeover, and reconciliation evidence. */
function requireOutcomeLifecycle(
  input: ReceiptLifecycleValidationInput,
): void {
  if (input.outcome === 'completed') {
    if (
      input.faultReceiptDigest !== null ||
      input.faultBoundary !== null ||
      input.predecessorLeaseExpiresAt !== null ||
      input.takeoverAcquiredAt !== null ||
      input.reconciledAt !== null ||
      input.evidence.kind === 'fault-boundary' ||
      input.processLifecycle.exitClass !== 'successful-no-fault'
    ) return failStageReceipt()
    return
  }
  if (input.outcome === 'fault-reached') {
    if (
      input.faultReceiptDigest === null ||
      input.faultBoundary === null ||
      input.evidence.kind !== 'fault-boundary' ||
      input.evidence.faultReceiptDigest !== input.faultReceiptDigest ||
      input.evidence.leaseIdentityDigest !== input.leaseIdentityDigest ||
      input.faultBoundary.faultReceiptDigest !== input.faultReceiptDigest ||
      input.faultBoundary.leaseIdentityDigest !==
        input.leaseIdentityDigest ||
      input.predecessorLeaseExpiresAt !== null ||
      input.takeoverAcquiredAt !== null ||
      input.reconciledAt !== null ||
      input.processLifecycle.exitClass !== 'confirmed-sigkill'
    ) return failStageReceipt()
    return
  }
  if (input.outcome === 'takeover-completed') {
    if (
      input.faultBoundary !== null ||
      input.evidence.kind === 'fault-boundary' ||
      input.faultReceiptDigest === null ||
      input.processLifecycle.exitClass !== 'successful-no-fault' ||
      input.leaseObservation.kind !== 'acquired' ||
      input.leaseObservation.predecessorLeaseIdentityDigest === null ||
      input.predecessorLeaseExpiresAt === null ||
      input.takeoverAcquiredAt === null ||
      input.leaseObservation.predecessorLeaseExpiresAt !==
        input.predecessorLeaseExpiresAt ||
      input.leaseObservation.acquiredAt !== input.takeoverAcquiredAt ||
      input.reconciledAt !== null ||
      Date.parse(input.startedAt) <
        Date.parse(input.predecessorLeaseExpiresAt) ||
      Date.parse(input.takeoverAcquiredAt) < Date.parse(input.startedAt) ||
      Date.parse(input.takeoverAcquiredAt) >= Date.parse(input.completedAt)
    ) return failStageReceipt()
    return
  }
  if (
    input.faultBoundary === null ||
    input.evidence.kind === 'fault-boundary' ||
    input.faultReceiptDigest === null ||
    input.faultBoundary.faultReceiptDigest !== input.faultReceiptDigest ||
    input.faultBoundary.leaseIdentityDigest !== input.leaseIdentityDigest ||
    input.processLifecycle.exitClass !== 'successful-response-loss' ||
    input.reconciledAt === null ||
    input.predecessorLeaseExpiresAt !== null ||
    input.takeoverAcquiredAt !== null ||
    Date.parse(input.reconciledAt) < Date.parse(input.startedAt) ||
    Date.parse(input.reconciledAt) > Date.parse(input.completedAt)
  ) return failStageReceipt()
}

/** Reads one exact durable stage-evidence union. */
function readStageEvidence(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageEvidence {
  const record = stageGuards.requireRecord(value)
  const kind = stageGuards.readOwn(record, 'kind')
  if (kind === 'planning-sealed') return readPlanningEvidence(record)
  if (kind === 'apply-complete') return readApplyEvidence(record)
  if (kind === 'fault-boundary') return readFaultEvidence(record)
  if (kind === 'terminal') return readTerminalEvidence(record)
  if (kind === 'released') return readReleaseEvidence(record)
  return failStageReceipt()
}

/** Reads an optional exact runtime fault boundary. */
function readNullableFaultEvidence(
  value: unknown,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence | null {
  if (value === null) return null
  return readFaultEvidence(stageGuards.requireRecord(value))
}

/** Reads strict non-no-op planning evidence. */
function readPlanningEvidence(
  record: object,
): WorkspaceSearchMigrationRehearsalPlanningStageEvidence {
  stageGuards.requireExactKeys(record, [
    'admittedAt',
    'closedAt',
    'closedWriterFenceRecordDigest',
    'drainCompletedAt',
    'drainStartedAt',
    'executionBoundaryDigest',
    'kind',
    'orphanOperationCount',
    'planCreatedAt',
    'planDigest',
    'sealedAt',
    'sealedPlanOperationCount',
    'sealedPlanningAuthorityDigest',
    'sourceOperationCount',
  ])
  const executionBoundaryDigest = readDigestOwn(
    record,
    'executionBoundaryDigest',
  )
  const closedWriterFenceRecordDigest = readDigestOwn(
    record,
    'closedWriterFenceRecordDigest',
  )
  const sealedPlanningAuthorityDigest = readDigestOwn(
    record,
    'sealedPlanningAuthorityDigest',
  )
  const planDigest = readDigestOwn(record, 'planDigest')
  const sealedPlanOperationCount = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'sealedPlanOperationCount'),
  )
  const sourceOperationCount = readNonNegativeSafeInteger(
    stageGuards.readOwn(record, 'sourceOperationCount'),
  )
  const orphanOperationCount = readNonNegativeSafeInteger(
    stageGuards.readOwn(record, 'orphanOperationCount'),
  )
  const closedAt = readTimestampOwn(record, 'closedAt')
  const drainStartedAt = readTimestampOwn(record, 'drainStartedAt')
  const drainCompletedAt = readTimestampOwn(record, 'drainCompletedAt')
  const admittedAt = readTimestampOwn(record, 'admittedAt')
  const planCreatedAt = readTimestampOwn(record, 'planCreatedAt')
  const sealedAt = readTimestampOwn(record, 'sealedAt')
  if (
    sourceOperationCount + orphanOperationCount !==
      sealedPlanOperationCount ||
    Date.parse(drainStartedAt) < Date.parse(closedAt) ||
    Date.parse(drainCompletedAt) < Date.parse(drainStartedAt) ||
    Date.parse(admittedAt) < Date.parse(drainCompletedAt) ||
    Date.parse(planCreatedAt) < Date.parse(admittedAt) ||
    Date.parse(sealedAt) < Date.parse(planCreatedAt)
  ) return failStageReceipt()
  return Object.freeze({
    kind: 'planning-sealed',
    executionBoundaryDigest,
    closedWriterFenceRecordDigest,
    sealedPlanningAuthorityDigest,
    planDigest,
    sealedPlanOperationCount,
    sourceOperationCount,
    orphanOperationCount,
    closedAt,
    drainStartedAt,
    drainCompletedAt,
    admittedAt,
    planCreatedAt,
    sealedAt,
  })
}

/** Reads strict complete-apply evidence. */
function readApplyEvidence(
  record: object,
): WorkspaceSearchMigrationRehearsalApplyStageEvidence {
  stageGuards.requireExactKeys(record, [
    'appliedAt',
    'appliedOperationCount',
    'appliedRootDigest',
    'executionRunDigest',
    'kind',
    'planDigest',
    'sealedPlanOperationCount',
    'targetPreimageArtifactContentDigest',
  ])
  const executionRunDigest = readDigestOwn(record, 'executionRunDigest')
  const planDigest = readDigestOwn(record, 'planDigest')
  const sealedPlanOperationCount = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'sealedPlanOperationCount'),
  )
  const appliedOperationCount = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'appliedOperationCount'),
  )
  const appliedRootDigest = readDigestOwn(record, 'appliedRootDigest')
  const targetPreimageArtifactContentDigest = readNullableDigest(
    stageGuards.readOwn(record, 'targetPreimageArtifactContentDigest'),
  )
  const appliedAt = readTimestampOwn(record, 'appliedAt')
  if (appliedOperationCount !== sealedPlanOperationCount) {
    return failStageReceipt()
  }
  return Object.freeze({
    kind: 'apply-complete',
    executionRunDigest,
    planDigest,
    sealedPlanOperationCount,
    appliedOperationCount,
    appliedRootDigest,
    targetPreimageArtifactContentDigest,
    appliedAt,
  })
}

/** Reads strict cursor-free fault-boundary evidence. */
function readFaultEvidence(
  record: object,
): WorkspaceSearchMigrationRehearsalFaultStageEvidence {
  stageGuards.requireExactKeys(record, [
    'appliedOperationCount',
    'failpoint',
    'faultObservation',
    'faultObservationDigest',
    'faultReceiptDigest',
    'kind',
    'leaseIdentityDigest',
    'reachedAt',
    'sealedPlanOperationCount',
    'targetPreimageArtifactContentDigest',
    'targetDigest',
  ])
  const failpoint = readFailpoint(stageGuards.readOwn(record, 'failpoint'))
  const targetDigest = readDigestOwn(record, 'targetDigest')
  const faultReceiptDigest = readDigestOwn(record, 'faultReceiptDigest')
  const faultObservation =
    snapshotWorkspaceSearchMigrationRehearsalFaultObservation(
      stageGuards.readOwn(record, 'faultObservation'),
    )
  const faultObservationDigest = readDigestOwn(
    record,
    'faultObservationDigest',
  )
  const leaseIdentityDigest = readDigestOwn(record, 'leaseIdentityDigest')
  const appliedOperationCount = readNonNegativeSafeInteger(
    stageGuards.readOwn(record, 'appliedOperationCount'),
  )
  const sealedPlanOperationCount = readNullablePositiveSafeInteger(
    stageGuards.readOwn(record, 'sealedPlanOperationCount'),
  )
  const targetPreimageArtifactContentDigest = readNullableDigest(
    stageGuards.readOwn(record, 'targetPreimageArtifactContentDigest'),
  )
  const reachedAt = readTimestampOwn(record, 'reachedAt')
  if (
    faultObservationDigest !== createMigrationDigest(faultObservation) ||
    faultObservation.failpoint !== failpoint ||
    faultObservation.leaseIdentityDigest !== leaseIdentityDigest ||
    faultObservation.durableAppliedOperationCount !== appliedOperationCount ||
    faultObservation.sealedPlanOperationCount !== sealedPlanOperationCount
  ) return failStageReceipt()
  switch (failpoint) {
    case 'planning-page-artifact-uploaded-before-checkpoint-commit':
    case 'planning-page-transaction-response-lost':
    case 'lease-acquired-before-first-heartbeat':
      if (
        sealedPlanOperationCount !== null ||
        appliedOperationCount !== 0 ||
        targetPreimageArtifactContentDigest !== null
      ) return failStageReceipt()
      break
    case 'apply-checkpoint-cursor-captured-before-commit':
    case 'apply-checkpoint-cursor-committed-before-return':
      if (
        sealedPlanOperationCount === null ||
        appliedOperationCount === 0 ||
        appliedOperationCount !== sealedPlanOperationCount ||
        targetPreimageArtifactContentDigest !== null
      ) return failStageReceipt()
      break
    case 'apply-operation-committed-before-return':
      if (
        sealedPlanOperationCount === null ||
        appliedOperationCount === 0 ||
        appliedOperationCount >= sealedPlanOperationCount ||
        targetPreimageArtifactContentDigest === null
      ) return failStageReceipt()
      break
  }
  return Object.freeze({
    kind: 'fault-boundary',
    failpoint,
    targetDigest,
    faultReceiptDigest,
    faultObservationDigest,
    faultObservation,
    leaseIdentityDigest,
    appliedOperationCount,
    sealedPlanOperationCount,
    targetPreimageArtifactContentDigest,
    reachedAt,
  })
}

/** Reads strict terminal root/count evidence. */
function readTerminalEvidence(
  record: object,
): WorkspaceSearchMigrationRehearsalTerminalStageEvidence {
  stageGuards.requireExactKeys(record, [
    'appliedOperationCount',
    'command',
    'duplicateApplyCount',
    'executionBoundaryDigest',
    'executionRunDigest',
    'integrityAfterResultDigest',
    'integrityBeforeResultDigest',
    'integrityComparisonDigest',
    'integrityContextDigest',
    'integrityPurpose',
    'kind',
    'lostItemCount',
    'orphanAuthorityCount',
    'planDigest',
    'reconciliationAuditDigest',
    'reconciliationArtifactAuditDigest',
    'reconciliationArtifactBindingDigest',
    'reconciliationArtifactByteLength',
    'reconciliationArtifactContentDigest',
    'reconciliationContext',
    'reconciliationRate',
    'sealedPlanOperationCount',
    'sealedPlanningAuthorityDigest',
    'terminalAt',
    'terminalKind',
    'terminalPersistenceVersion',
    'terminalRootDigest',
    'targetRollbackArtifactContentDigest',
    'targetRollbackObservationDigest',
  ])
  const command = readTerminalCommand(stageGuards.readOwn(record, 'command'))
  const terminalKind = readTerminalKind(
    stageGuards.readOwn(record, 'terminalKind'),
  )
  const terminalPersistenceVersion = readTerminalVersion(
    stageGuards.readOwn(record, 'terminalPersistenceVersion'),
  )
  const terminalRootDigest = readDigestOwn(record, 'terminalRootDigest')
  const executionBoundaryDigest = readDigestOwn(
    record,
    'executionBoundaryDigest',
  )
  const sealedPlanningAuthorityDigest = readDigestOwn(
    record,
    'sealedPlanningAuthorityDigest',
  )
  const executionRunDigest = readDigestOwn(record, 'executionRunDigest')
  const planDigest = readDigestOwn(record, 'planDigest')
  const sealedPlanOperationCount = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'sealedPlanOperationCount'),
  )
  const appliedOperationCount = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'appliedOperationCount'),
  )
  const integrityPurpose = readIntegrityPurpose(
    stageGuards.readOwn(record, 'integrityPurpose'),
  )
  const integrityBeforeResultDigest = readNullableDigest(
    stageGuards.readOwn(record, 'integrityBeforeResultDigest'),
  )
  const integrityAfterResultDigest = readNullableDigest(
    stageGuards.readOwn(record, 'integrityAfterResultDigest'),
  )
  const integrityComparisonDigest = readNullableDigest(
    stageGuards.readOwn(record, 'integrityComparisonDigest'),
  )
  const integrityContextDigest = readNullableDigest(
    stageGuards.readOwn(record, 'integrityContextDigest'),
  )
  const targetRollbackArtifactContentDigest = readNullableDigest(
    stageGuards.readOwn(record, 'targetRollbackArtifactContentDigest'),
  )
  const targetRollbackObservationDigest = readNullableDigest(
    stageGuards.readOwn(record, 'targetRollbackObservationDigest'),
  )
  const duplicateApplyCount = readRequiredZero(
    stageGuards.readOwn(record, 'duplicateApplyCount'),
  )
  const lostItemCount = readRequiredZero(
    stageGuards.readOwn(record, 'lostItemCount'),
  )
  const orphanAuthorityCount = readRequiredZero(
    stageGuards.readOwn(record, 'orphanAuthorityCount'),
  )
  const reconciliationContext =
    snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext(
      stageGuards.readOwn(record, 'reconciliationContext'),
    )
  const reconciliationAuditDigest = readDigestOwn(
    record,
    'reconciliationAuditDigest',
  )
  const reconciliationArtifactBindingDigest = readDigestOwn(
    record,
    'reconciliationArtifactBindingDigest',
  )
  const reconciliationArtifactContentDigest = readDigestOwn(
    record,
    'reconciliationArtifactContentDigest',
  )
  const reconciliationArtifactByteLength = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'reconciliationArtifactByteLength'),
  )
  const reconciliationArtifactAuditDigest = readDigestOwn(
    record,
    'reconciliationArtifactAuditDigest',
  )
  const reconciliationRate =
    readWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
      stageGuards.readOwn(record, 'reconciliationRate'),
    )
  const terminalAt = readTimestampOwn(record, 'terminalAt')
  const reconciliationIntegrity = reconciliationContext.integrity
  const expectsRollbackComparison = command !== 'verify'
  if (
    appliedOperationCount > sealedPlanOperationCount ||
    reconciliationContext.terminalRootKind !== terminalKind ||
    reconciliationContext.terminalRootVersion !==
      terminalPersistenceVersion ||
    reconciliationContext.terminalRootDigest !== terminalRootDigest ||
    reconciliationContext.sealedPlanningAuthorityDigest !==
      sealedPlanningAuthorityDigest ||
    reconciliationContext.executionRunDigest !== executionRunDigest ||
    reconciliationContext.planDigest !== planDigest ||
    reconciliationContext.sealedPlanOperationCount !==
      sealedPlanOperationCount ||
    reconciliationContext.appliedOperationCount !== appliedOperationCount ||
    reconciliationContext.terminalAt !== terminalAt ||
    Date.parse(reconciliationContext.checkedAt) < Date.parse(terminalAt) ||
    reconciliationIntegrity.terminalRootDigest !== terminalRootDigest ||
    reconciliationArtifactByteLength > 64 * 1_024 * 1_024 ||
    Date.parse(reconciliationRate.completedAt) <
      Date.parse(reconciliationContext.checkedAt) ||
    reconciliationRate.link.configurationBindingDigest !==
      reconciliationContext.configurationBindingDigest ||
    expectsRollbackComparison !==
      (reconciliationIntegrity.kind === 'rollback-comparison') ||
    (reconciliationIntegrity.kind === 'rollback-comparison' &&
      reconciliationIntegrity.purpose !==
        (command === 'rollback-partial'
          ? 'partial-rollback'
          : 'complete-rollback')) ||
    integrityAfterResultDigest === null ||
    integrityContextDigest === null ||
    (command === 'verify' &&
      (integrityPurpose !== 'verified' ||
        integrityBeforeResultDigest !== null ||
        integrityComparisonDigest !== null ||
        reconciliationIntegrity.kind !== 'verified-result' ||
        integrityAfterResultDigest !==
          reconciliationIntegrity.result.resultDigest ||
        integrityContextDigest !==
          reconciliationIntegrity.resultContextDigest)) ||
    (command !== 'verify' &&
      (integrityPurpose !==
          (command === 'rollback-partial'
            ? 'partial-rollback'
            : 'complete-rollback') ||
        integrityBeforeResultDigest === null ||
        integrityComparisonDigest === null ||
        reconciliationIntegrity.kind !== 'rollback-comparison' ||
        integrityBeforeResultDigest !==
          reconciliationIntegrity.before.resultDigest ||
        integrityAfterResultDigest !==
          reconciliationIntegrity.after.resultDigest ||
        integrityComparisonDigest !==
          reconciliationIntegrity.comparisonDigest ||
        integrityContextDigest !==
          reconciliationIntegrity.comparisonContextDigest)) ||
    (command === 'verify' &&
      (terminalKind !== 'verified' ||
        terminalPersistenceVersion !== 1 ||
        appliedOperationCount !== sealedPlanOperationCount)) ||
    (command === 'rollback-complete' &&
      (terminalKind !== 'rolled-back' ||
        terminalPersistenceVersion !== 1 ||
        appliedOperationCount !== sealedPlanOperationCount)) ||
    (command === 'rollback-partial' &&
      (terminalKind !== 'rolled-back' ||
        terminalPersistenceVersion !== 2 ||
        appliedOperationCount >= sealedPlanOperationCount))
  ) return failStageReceipt()
  return Object.freeze({
    kind: 'terminal',
    command,
    terminalKind,
    terminalPersistenceVersion,
    terminalRootDigest,
    executionBoundaryDigest,
    sealedPlanningAuthorityDigest,
    executionRunDigest,
    planDigest,
    sealedPlanOperationCount,
    appliedOperationCount,
    integrityPurpose,
    integrityBeforeResultDigest,
    integrityAfterResultDigest,
    integrityComparisonDigest,
    integrityContextDigest,
    targetRollbackArtifactContentDigest,
    targetRollbackObservationDigest,
    duplicateApplyCount,
    lostItemCount,
    orphanAuthorityCount,
    reconciliationContext,
    reconciliationArtifactBindingDigest,
    reconciliationArtifactContentDigest,
    reconciliationArtifactByteLength,
    reconciliationArtifactAuditDigest,
    reconciliationRate,
    reconciliationAuditDigest,
    terminalAt,
  })
}

/** Reads strict terminal-bound writer-fence release evidence. */
function readReleaseEvidence(
  record: object,
): WorkspaceSearchMigrationRehearsalReleaseStageEvidence {
  stageGuards.requireExactKeys(record, [
    'kind',
    'releasedAt',
    'releasedWriterFenceRecordDigest',
    'terminalKind',
    'terminalPersistenceVersion',
    'terminalRootDigest',
  ])
  const terminalKind = readTerminalKind(
    stageGuards.readOwn(record, 'terminalKind'),
  )
  const terminalPersistenceVersion = readTerminalVersion(
    stageGuards.readOwn(record, 'terminalPersistenceVersion'),
  )
  const terminalRootDigest = readDigestOwn(record, 'terminalRootDigest')
  const releasedWriterFenceRecordDigest = readDigestOwn(
    record,
    'releasedWriterFenceRecordDigest',
  )
  const releasedAt = readTimestampOwn(record, 'releasedAt')
  if (
    terminalKind === 'verified' && terminalPersistenceVersion !== 1
  ) return failStageReceipt()
  return Object.freeze({
    kind: 'released',
    terminalKind,
    terminalPersistenceVersion,
    terminalRootDigest,
    releasedWriterFenceRecordDigest,
    releasedAt,
  })
}

/** Reads strict identifier-free durable rate-segment metadata. */
function readRateSegment(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageRateSegment {
  const record = stageGuards.requireRecord(value)
  stageGuards.requireExactKeys(record, rateSegmentKeys)
  const segmentLocatorDigest = readDigestOwn(record, 'segmentLocatorDigest')
  const authenticationKeyFingerprint = readDigestOwn(
    record,
    'authenticationKeyFingerprint',
  )
  const segmentOrdinal = readNonNegativeSafeInteger(
    stageGuards.readOwn(record, 'segmentOrdinal'),
  )
  const eventCount = readNonNegativeSafeInteger(
    stageGuards.readOwn(record, 'eventCount'),
  )
  const firstEventSequence = readPositiveSafeInteger(
    stageGuards.readOwn(record, 'firstEventSequence'),
  )
  const firstCommittedEventSequence = readNullablePositiveSafeInteger(
    stageGuards.readOwn(record, 'firstCommittedEventSequence'),
  )
  const lastCommittedEventSequence = readNullablePositiveSafeInteger(
    stageGuards.readOwn(record, 'lastCommittedEventSequence'),
  )
  const terminalRecordMac = readDigestOwn(record, 'terminalRecordMac')
  const segmentDigest = readDigestOwn(record, 'segmentDigest')
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
  ) return failStageReceipt()
  return Object.freeze({
    authenticationKeyFingerprint,
    segmentLocatorDigest,
    segmentOrdinal,
    firstEventSequence,
    eventCount,
    firstCommittedEventSequence,
    lastCommittedEventSequence,
    terminalRecordMac,
    segmentDigest,
  })
}

/** Reads one exact trusted parent process lifecycle. */
function readProcessLifecycle(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageProcessLifecycle {
  const record = stageGuards.requireRecord(value)
  stageGuards.requireExactKeys(record, processLifecycleKeys)
  const lifecycleDigest = readDigestOwn(record, 'lifecycleDigest')
  const runnerStartedAt = readTimestampOwn(record, 'runnerStartedAt')
  const receiptObservedAt = readTimestampOwn(record, 'receiptObservedAt')
  const receiptPersistedAt = readTimestampOwn(record, 'receiptPersistedAt')
  const parentDecisionRecordedAt = readNullableTimestamp(
    stageGuards.readOwn(record, 'parentDecisionRecordedAt'),
  )
  const processExitedAt = readTimestampOwn(record, 'processExitedAt')
  const exitClass = readProcessExitClass(
    stageGuards.readOwn(record, 'exitClass'),
  )
  if (
    Date.parse(receiptObservedAt) < Date.parse(runnerStartedAt) ||
    Date.parse(receiptPersistedAt) < Date.parse(receiptObservedAt) ||
    Date.parse(processExitedAt) < Date.parse(receiptPersistedAt) ||
    (exitClass === 'successful-no-fault') !==
      (parentDecisionRecordedAt === null) ||
    (parentDecisionRecordedAt !== null &&
      (Date.parse(parentDecisionRecordedAt) <
          Date.parse(receiptPersistedAt) ||
        Date.parse(processExitedAt) <
          Date.parse(parentDecisionRecordedAt)))
  ) return failStageReceipt()
  return Object.freeze({
    lifecycleDigest,
    runnerStartedAt,
    receiptObservedAt,
    receiptPersistedAt,
    parentDecisionRecordedAt,
    processExitedAt,
    exitClass,
  })
}

/** Maps evidence to the only compatible existing control command. */
function evidenceCommand(
  evidence: WorkspaceSearchMigrationRehearsalStageEvidence,
): WorkspaceSearchMigrationRehearsalStageCommand {
  if (evidence.kind === 'planning-sealed') return 'close-replan'
  if (evidence.kind === 'apply-complete') return 'apply'
  if (evidence.kind === 'terminal') return evidence.command
  if (evidence.kind === 'released') return 'release'
  if (
    evidence.failpoint ===
      'planning-page-artifact-uploaded-before-checkpoint-commit' ||
    evidence.failpoint === 'planning-page-transaction-response-lost' ||
    evidence.failpoint === 'lease-acquired-before-first-heartbeat'
  ) return 'close-replan'
  return 'apply'
}

/** Creates one receipt HMAC. */
function createReceiptMac(
  claims: WorkspaceSearchMigrationRehearsalStageReceiptClaims,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(receiptMacDomain, 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/**
 * Requires the receipt's rate segment to use the receipt authentication key.
 *
 * @param claims - Strict detached stage receipt claims.
 * @param key - Exact runtime key used to authenticate the receipt.
 */
function requireReceiptRateAuthenticationKeyFingerprint(
  claims: WorkspaceSearchMigrationRehearsalStageReceiptClaims,
  key: Uint8Array,
): void {
  const expected =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      key,
    )
  if (!safeDigestEqual(
    claims.rateSegment.authenticationKeyFingerprint,
    expected,
  )) return failStageReceipt()
}

/** Parses one bounded UTF-8 JSON document before strict record validation. */
function parseCanonicalStageDocument(
  value: unknown,
  maximumBytes: number,
): unknown {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    stageGuards.readIntrinsicByteLength(value) === 0 ||
    stageGuards.readIntrinsicByteLength(value) > maximumBytes
  ) return failStageReceipt()
  let copied: Uint8Array
  try {
    const candidate: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      value,
      [],
    )
    if (!(candidate instanceof Uint8Array)) return failStageReceipt()
    copied = candidate
  } catch {
    return failStageReceipt()
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(copied)
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    return failStageReceipt()
  }
}

/** Requires source bytes to equal the exact normalized canonical document. */
function requireCanonicalStageDocument(
  source: Uint8Array,
  normalized: unknown,
): void {
  const canonical = new TextEncoder().encode(
    serializeCanonicalJson(normalized),
  )
  let sourceLength: number
  try {
    sourceLength = stageGuards.readIntrinsicByteLength(source)
  } catch {
    return failStageReceipt()
  }
  if (sourceLength !== canonical.byteLength) return failStageReceipt()
  try {
    for (let index = 0; index < canonical.byteLength; index += 1) {
      const sourceByte: unknown = Reflect.get(source, index)
      if (sourceByte !== canonical[index]) return failStageReceipt()
    }
  } catch {
    return failStageReceipt()
  }
}

/** Copies one ordinary exact-length evidence key. */
function copyEvidenceKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    nodeUtilTypes.isProxy(value) ||
    stageGuards.readIntrinsicByteLength(value) !== evidenceKeyByteLength
  ) return failStageReceipt()
  try {
    const copied: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      value,
      [],
    )
    if (
      !(copied instanceof Uint8Array) ||
      copied.byteLength !== evidenceKeyByteLength
    ) return failStageReceipt()
    return copied
  } catch {
    return failStageReceipt()
  }
}

/** Reads one exact lowercase Git commit OID. */
function readCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return failStageReceipt()
  }
  return value
}

/** Reads one canonical required scenario. */
function readScenario(value: unknown): WorkspaceSearchMigrationRehearsalScenarioName {
  for (const scenario of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS) {
    if (value === scenario) return scenario
  }
  return failStageReceipt()
}

/** Reads one finite existing control command. */
function readStageCommand(value: unknown): WorkspaceSearchMigrationRehearsalStageCommand {
  if (
    value === 'apply' ||
    value === 'close-replan' ||
    value === 'release' ||
    value === 'rollback-complete' ||
    value === 'rollback-partial' ||
    value === 'verify'
  ) return value
  return failStageReceipt()
}

/** Reads one terminal-producing command. */
function readTerminalCommand(
  value: unknown,
): 'rollback-complete' | 'rollback-partial' | 'verify' {
  if (
    value === 'rollback-complete' ||
    value === 'rollback-partial' ||
    value === 'verify'
  ) return value
  return failStageReceipt()
}

/** Reads one finite stage outcome. */
function readStageOutcome(value: unknown): WorkspaceSearchMigrationRehearsalStageOutcome {
  if (
    value === 'completed' ||
    value === 'fault-reached' ||
    value === 'response-loss-reconciled' ||
    value === 'takeover-completed'
  ) return value
  return failStageReceipt()
}

/** Reads one exact supported failpoint. */
function readFailpoint(value: unknown): WorkspaceSearchMigrationRehearsalFailpoint {
  for (const failpoint of WORKSPACE_SEARCH_MIGRATION_REHEARSAL_FAILPOINTS) {
    if (value === failpoint) return failpoint
  }
  return failStageReceipt()
}

/** Reads one authoritative terminal outcome. */
function readTerminalKind(value: unknown): 'rolled-back' | 'verified' {
  if (value === 'rolled-back' || value === 'verified') return value
  return failStageReceipt()
}

/** Reads one supported terminal persistence version. */
function readTerminalVersion(value: unknown): 1 | 2 {
  if (value === 1 || value === 2) return value
  return failStageReceipt()
}

/** Reads one verified parent process termination class. */
function readProcessExitClass(
  value: unknown,
): WorkspaceSearchMigrationRehearsalStageProcessLifecycle['exitClass'] {
  if (
    value === 'confirmed-sigkill' ||
    value === 'successful-no-fault' ||
    value === 'successful-response-loss'
  ) return value
  return failStageReceipt()
}

/** Reads one mandatory purpose-bound integrity classification. */
function readIntegrityPurpose(
  value: unknown,
): 'complete-rollback' | 'partial-rollback' | 'verified' {
  if (
    value === 'complete-rollback' ||
    value === 'partial-rollback' ||
    value === 'verified'
  ) return value
  return failStageReceipt()
}

/** Reads a positive safe integer. */
function readPositiveSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) return failStageReceipt()
  return value
}

/** Reads a non-negative safe integer. */
function readNonNegativeSafeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failStageReceipt()
  return value
}

/** Reads the exact mandatory terminal audit zero literal. */
function readRequiredZero(value: unknown): 0 {
  if (value !== 0) return failStageReceipt()
  return 0
}

/** Reads a nullable positive safe integer. */
function readNullablePositiveSafeInteger(value: unknown): number | null {
  if (value === null) return null
  return readPositiveSafeInteger(value)
}

/** Reads a digest from one required own field. */
function readDigestOwn(record: object, key: string): string {
  return stageGuards.readDigest(stageGuards.readOwn(record, key))
}

/** Reads a timestamp from one required own field. */
function readTimestampOwn(record: object, key: string): string {
  return stageGuards.readTimestamp(stageGuards.readOwn(record, key))
}

/** Reads a nullable conventional digest. */
function readNullableDigest(value: unknown): string | null {
  if (value === null) return null
  return stageGuards.readDigest(value)
}

/** Reads a nullable canonical timestamp. */
function readNullableTimestamp(value: unknown): string | null {
  if (value === null) return null
  return stageGuards.readTimestamp(value)
}

/** Reads a bounded exact control argument vector. */
function readControlArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return failStageReceipt()
  }
  if (value.length === 0 || value.length > 512) return failStageReceipt()
  const snapshot: string[] = []
  for (const argument of value) {
    if (
      typeof argument !== 'string' ||
      argument.length === 0 ||
      argument.length > 8_192 ||
      argument.includes('\0')
    ) return failStageReceipt()
    snapshot.push(argument)
  }
  return Object.freeze(snapshot)
}

/** Compares two fixed-size lowercase digests without timing leakage. */
function safeDigestEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Raises the sole raw-value-free stage receipt failure. */
function failStageReceipt(): never {
  throw new WorkspaceSearchMigrationRehearsalStageReceiptError()
}
