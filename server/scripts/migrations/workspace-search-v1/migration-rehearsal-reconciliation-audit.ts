import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationRehearsalScenarioName,
} from './migration-rehearsal-evidence'
import {
  readWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
  sameWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
  type WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
} from './migration-rehearsal-integrity-evidence'
import {
  consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION,
  type WorkspaceSearchMigrationRehearsalIntegrityRateInterval,
  type WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  readWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput,
  type WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
} from './migration-rehearsal-rate-evidence'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import type {
  WorkspaceSearchMigrationRehearsalTargetAuditContext,
  WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding,
} from './migration-rehearsal-target-audit'

/** Stable discriminator for one terminal reconciliation-audit artifact. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-reconciliation-audit'

/** Complete terminal reconciliation-audit artifact contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_VERSION =
  3

/** Maximum exact canonical bytes accepted for one reconciliation audit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES =
  64 * 1_024

/** Exact byte length of the permit-bound rehearsal runtime HMAC key. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_KEY_BYTES =
  32

/** Canonical eight-scenario order required by finalized reconciliation evidence. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS:
  readonly WorkspaceSearchMigrationRehearsalScenarioName[] = Object.freeze([
    'happy-path-verified',
    'cursor-before-commit-kill',
    'cursor-after-commit-kill',
    'artifact-before-checkpoint-kill',
    'transaction-response-loss',
    'lease-expiry-takeover',
    'partial-apply-rollback',
    'complete-apply-rollback',
  ])

/** Stable raw-value-free reconciliation-audit validation failure. */
export class WorkspaceSearchMigrationRehearsalReconciliationAuditError
  extends Error {
  /** Stable machine-readable failure code. */
  readonly code = 'REHEARSAL_RECONCILIATION_AUDIT_INVALID'

  /** Creates one failure that never reflects untrusted artifact material. */
  constructor() {
    super('REHEARSAL_RECONCILIATION_AUDIT_INVALID')
    this.name =
      'WorkspaceSearchMigrationRehearsalReconciliationAuditError'
  }
}

/** Canonical scenarios that end in an authoritative verified root. */
export type WorkspaceSearchMigrationRehearsalVerifiedReconciliationScenario =
  | 'artifact-before-checkpoint-kill'
  | 'cursor-after-commit-kill'
  | 'cursor-before-commit-kill'
  | 'happy-path-verified'
  | 'lease-expiry-takeover'
  | 'transaction-response-loss'

/** Exact terminal context excluding its independently checked #163 result. */
export type WorkspaceSearchMigrationRehearsalReconciliationCoreContext = {
  /** Canonical isolated rehearsal scenario. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Domain-separated digest of the restricted run identifier. */
  readonly runLocatorDigest: string
  /** Digest of the exact measured configuration and resource generation. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable policy digest shared by all live rate evidence. */
  readonly policyVersion: string
  /** Permit-authenticated immutable #163 resource-identity digest. */
  readonly integrityResourceIdentityDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Digest of the immutable execution admission. */
  readonly executionRunDigest: string
  /** Merkle root of the exact ordered plan. */
  readonly planDigest: string
  /** Digest of the exact admitted apply boundary. */
  readonly applyBoundaryDigest: string
  /** Authoritative terminal root classification. */
  readonly terminalRootKind: 'rolled-back' | 'verified'
  /** Persistence version of the authoritative terminal root. */
  readonly terminalRootVersion: 1 | 2
  /** Digest of the complete authoritative terminal root. */
  readonly terminalRootDigest: string
  /** Exact positive operation count in the immutable plan seal. */
  readonly sealedPlanOperationCount: number
  /** Exact complete or committed-prefix operation count that was applied. */
  readonly appliedOperationCount: number
  /** Canonical publication time of the authoritative terminal root. */
  readonly terminalAt: string
  /** Canonical completion time sampled after all strong reconciliation reads. */
  readonly checkedAt: string
}

/** Digest-only exact binding of one independently authenticated #163 result. */
export type WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding = {
  /** Canonical observation time authenticated inside the #163 result. */
  readonly checkedAt: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['checkedAt']
  /** SHA-256 digest of the exact canonical #163 result bytes. */
  readonly contentDigest: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['contentDigest']
  /** Exact canonical #163 result byte length. */
  readonly byteLength: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['byteLength']
  /** Canonical digest of the complete strictly parsed #163 result. */
  readonly resultDigest: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['resultDigest']
  /** Whole-result HMAC retained by the authenticated #163 result. */
  readonly resultMac: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['resultMac']
  /** Exact trusted wall-clock provenance around all external reads. */
  readonly runtimeProvenance: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['runtimeProvenance']
  /** Cross-domain aggregate authenticated by the complete #163 result. */
  readonly integrityAggregateDigest: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['integrityAggregateDigest']
  /** Immutable physical-resource identity scheme authenticated by the result. */
  readonly resourceIdentityScheme: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['resourceIdentityScheme']
  /** Canonical frozen immutable physical-resource identity vector. */
  readonly resourceIdentities: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['resourceIdentities']
  /** Exact permit-pinned physical-resource identity digest. */
  readonly resourceIdentityDigest: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection['resourceIdentityDigest']
}

/** Verified-terminal #163 material accepted from an authenticated collector. */
export type WorkspaceSearchMigrationRehearsalVerifiedIntegrityCollectorResult = {
  /** Fixed single-result verified-terminal discriminator. */
  readonly kind: 'verified-result'
  /** Mandatory passing #163 classification. */
  readonly status: 'pass'
  /** Mandatory absence of #163 verification failures. */
  readonly failureCount: 0
  /** Canonical completion of independent #163 result authentication. */
  readonly completedAt: string
  /** Exact independently authenticated terminal #163 result binding. */
  readonly result:
    WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding
  /** Verified migration root bound by the #163 result context. */
  readonly terminalRootDigest: string
  /** Cross-domain aggregate independently authenticated by the #163 result. */
  readonly integrityAggregateDigest: string
}

/** Rollback-terminal #163 pair accepted from an authenticated collector. */
export type WorkspaceSearchMigrationRehearsalRollbackIntegrityCollectorResult = {
  /** Fixed before/after rollback comparison discriminator. */
  readonly kind: 'rollback-comparison'
  /** Exact rollback purpose preventing cross-scenario replay. */
  readonly purpose: 'complete-rollback' | 'partial-rollback'
  /** Mandatory passing #163 comparison classification. */
  readonly status: 'pass'
  /** Mandatory absence of #163 comparison failures. */
  readonly failureCount: 0
  /** Inclusive beginning of the authenticated #163 comparison window. */
  readonly startedAt: string
  /** Trusted apply start strictly after the complete before observation. */
  readonly applyStartedAt: string
  /** Authoritative rollback terminal strictly before the after observation. */
  readonly terminalAt: string
  /** Inclusive completion of the authenticated #163 comparison window. */
  readonly completedAt: string
  /** Exact authenticated pre-migration #163 result binding. */
  readonly before:
    WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding
  /** Exact authenticated post-rollback #163 result binding. */
  readonly after:
    WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding
  /** Purpose-bound digest of the successful before/after comparison. */
  readonly comparisonDigest: string
  /** Digest binding the comparison purpose, window, and exact result files. */
  readonly comparisonContextDigest: string
  /** Rolled-back migration root bound by the #163 comparison context. */
  readonly terminalRootDigest: string
  /** Independently retained pre-apply target aggregate digest. */
  readonly targetPreimageAggregateDigest: string
  /** Independently observed post-rollback target aggregate digest. */
  readonly targetRestoredAggregateDigest: string
  /** Mandatory exact target-preimage equality classification. */
  readonly targetPreimageStatus: 'equal'
}

/** Scenario-specific independently authenticated #163 collector material. */
export type WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult =
  | WorkspaceSearchMigrationRehearsalRollbackIntegrityCollectorResult
  | WorkspaceSearchMigrationRehearsalVerifiedIntegrityCollectorResult

/** Verified-terminal #163 projection bound into this artifact context. */
export type WorkspaceSearchMigrationRehearsalVerifiedIntegritySummary =
  Omit<
    WorkspaceSearchMigrationRehearsalVerifiedIntegrityCollectorResult,
    'result'
  > & {
    /** Genuine one-shot rate-bound live result that authorized this summary. */
    readonly result: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
    /** Digest binding the result file to its scenario and terminal context. */
    readonly resultContextDigest: string
    /** Digest of the exact migration terminal context shared with #163. */
    readonly migrationContextDigest: string
  }

/** Rollback-terminal #163 projection bound into this artifact context. */
export type WorkspaceSearchMigrationRehearsalRollbackIntegritySummary =
  WorkspaceSearchMigrationRehearsalRollbackIntegrityCollectorResult & {
    /** Digest of the exact migration terminal context shared with #163. */
    readonly migrationContextDigest: string
  }

/** Scenario-specific #163 projection authenticated by this artifact. */
export type WorkspaceSearchMigrationRehearsalReconciliationIntegritySummary =
  | WorkspaceSearchMigrationRehearsalRollbackIntegritySummary
  | WorkspaceSearchMigrationRehearsalVerifiedIntegritySummary

/** Exact authenticated target-audit summary retained for one rollback side. */
export type WorkspaceSearchMigrationRehearsalReconciliationTargetAuditSummary = {
  /** Scenario-specific preimage or restored target-audit purpose. */
  readonly purpose:
    | 'complete-rollback-preimage'
    | 'complete-rollback-restored'
    | 'partial-rollback-preimage'
    | 'partial-rollback-restored'
  /** Canonical sample taken before the first external target read. */
  readonly startedAt: string
  /** SHA-256 digest of the exact canonical target-audit bytes. */
  readonly contentDigest: string
  /** Exact positive canonical target-audit byte length. */
  readonly byteLength: number
  /** Canonical completion of the independently authenticated target scan. */
  readonly observedAt: string
  /** Contextual digest of the exact observed target state. */
  readonly observationDigest: string
  /** Pagination-independent digest of the observed target aggregate. */
  readonly aggregateDigest: string
  /** Digest of the full parent-authenticated target planning context. */
  readonly contextDigest: string
  /** Full parent-authenticated target planning context. */
  readonly context: WorkspaceSearchMigrationRehearsalTargetAuditContext
  /** Purpose-bound rollback terminal, absent only for the preimage side. */
  readonly terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null
  /** Exact full rate-bound live #163 result authenticated by target audit v4. */
  readonly integrity: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
  /** Exact authenticated auxiliary rate segment and final ledger binding. */
  readonly rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence
}

/** Authenticated target preimage and restored pair for one rollback. */
export type WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair = {
  /** Target state captured before apply admission. */
  readonly preimage:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditSummary
  /** Target state captured after the authoritative rollback root. */
  readonly restored:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditSummary
}

/** Exact terminal and independent #163 context authenticated by one audit. */
export type WorkspaceSearchMigrationRehearsalReconciliationAuditContext =
  WorkspaceSearchMigrationRehearsalReconciliationCoreContext & {
    /** Scenario-specific terminal #163 result or rollback comparison. */
    readonly integrity:
      WorkspaceSearchMigrationRehearsalReconciliationIntegritySummary
    /** Authenticated target pair for rollback, otherwise strict null. */
    readonly targetAudits:
      WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null
  }

/** Collector-owned marker comparison before artifact digest derivation. */
export type WorkspaceSearchMigrationRehearsalReconciliationMarkerCollectorResult = {
  /** Expected marker count from the complete or committed-prefix seal. */
  readonly expectedCount: number
  /** Aggregate digest from the complete or committed-prefix marker seal. */
  readonly expectedAggregateDigest: string
  /** Actual marker count from terminal strongly consistent reads. */
  readonly observedCount: number
  /** Aggregate digest from terminal strongly consistent marker reads. */
  readonly observedAggregateDigest: string
  /** Unique expected markers matched by a terminal read. */
  readonly matchedCount: number
  /** Additional applications of already matched operations. */
  readonly duplicateCount: number
  /** Expected operation markers absent at terminal reconciliation. */
  readonly missingCount: number
  /** Observed markers outside the sealed complete or prefix set. */
  readonly unexpectedCount: number
}

/** Collector-owned durable-authority comparison before digest derivation. */
export type WorkspaceSearchMigrationRehearsalReconciliationAuthorityCollectorResult = {
  /** Expected canonical durable-authority chain digest. */
  readonly expectedChainDigest: string
  /** Observed canonical durable-authority chain digest. */
  readonly observedChainDigest: string
  /** Expected durable-authority entry count. */
  readonly expectedCount: number
  /** Observed durable-authority entry count. */
  readonly observedCount: number
  /** Expected authority entries matched by the observed chain. */
  readonly matchedCount: number
  /** Expected authority entries absent from the observed chain. */
  readonly missingCount: number
  /** Observed authorities that have no owning operation. */
  readonly orphanCount: number
}

/** Collector-owned source/target comparison before digest derivation. */
export type WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult = {
  /** Expected canonical source-derived target aggregate digest. */
  readonly expectedAggregateDigest: string
  /** Observed canonical terminal target aggregate digest. */
  readonly observedAggregateDigest: string
  /** Expected source-derived target item count. */
  readonly expectedCount: number
  /** Observed terminal target item count. */
  readonly observedCount: number
  /** Expected target items matched by strongly consistent reads. */
  readonly matchedCount: number
  /** Expected target items absent from the terminal target state. */
  readonly lostCount: number
  /** Observed terminal target items outside the expected source set. */
  readonly unexpectedCount: number
}

/** Normalized measured reconciliation result accepted by the finalizer. */
export type WorkspaceSearchMigrationRehearsalReconciliationCollectorResult = {
  /** Complete exact context captured around the terminal measurement. */
  readonly context:
    WorkspaceSearchMigrationRehearsalReconciliationCoreContext
  /** Independent terminal #163 result or rollback comparison. */
  readonly integrity:
    WorkspaceSearchMigrationRehearsalReconciliationIntegrityCollectorResult
  /** Genuine dual-key-authenticated rollback target summaries, else null. */
  readonly targetAudits:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null
  /** Complete or prefix-seal marker comparison. */
  readonly markerSummary:
    WorkspaceSearchMigrationRehearsalReconciliationMarkerCollectorResult
  /** Durable-authority chain comparison. */
  readonly authoritySummary:
    WorkspaceSearchMigrationRehearsalReconciliationAuthorityCollectorResult
  /** Source-derived expected target and observed target comparison. */
  readonly sourceTargetSummary:
    WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult
}

/** Input that finalizes one measured terminal reconciliation result. */
export type FinalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput = {
  /** Normalized collector result whose summary digests are derived here. */
  readonly collectorResult:
    WorkspaceSearchMigrationRehearsalReconciliationCollectorResult
  /** Fresh raw-segment proof, final closed ledger, and completion instant. */
  readonly rate:
    FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput
  /** Fresh verified live result for verified scenarios, otherwise strict null. */
  readonly verifiedIntegrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult | null
}

/** Marker seal selected by the authenticated apply boundary. */
export type WorkspaceSearchMigrationRehearsalReconciliationMarkerSealKind =
  | 'committed-prefix'
  | 'complete-plan'

/** Complete compact marker summary stored in the canonical artifact. */
export type WorkspaceSearchMigrationRehearsalReconciliationMarkerSummary =
  WorkspaceSearchMigrationRehearsalReconciliationMarkerCollectorResult & {
    /** Whether expected markers came from the full plan or committed prefix. */
    readonly expectedSealKind:
      WorkspaceSearchMigrationRehearsalReconciliationMarkerSealKind
    /** Context-bound digest of the exact expected marker seal summary. */
    readonly expectedSealBindingDigest: string
    /** Digest of every exact marker comparison field. */
    readonly summaryDigest: string
  }

/** Complete compact durable-authority summary in the canonical artifact. */
export type WorkspaceSearchMigrationRehearsalReconciliationAuthoritySummary =
  WorkspaceSearchMigrationRehearsalReconciliationAuthorityCollectorResult & {
    /** Digest of every exact durable-authority comparison field. */
    readonly summaryDigest: string
  }

/** Complete compact source/target summary in the canonical artifact. */
export type WorkspaceSearchMigrationRehearsalReconciliationSourceTargetSummary =
  WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult & {
    /** Digest of every exact source/target comparison field. */
    readonly summaryDigest: string
  }

/** Canonical authenticated artifact ready for restricted persistence. */
export type WorkspaceSearchMigrationRehearsalFinalizedReconciliationAuditArtifact = {
  /** Detached exact canonical UTF-8 bytes containing the complete audit. */
  readonly canonicalBytes: Uint8Array
  /** Exact canonical artifact byte length. */
  readonly byteLength: number
  /** SHA-256 digest of the exact canonical artifact bytes. */
  readonly contentDigest: string
  /** Exact derived context required for later independent authentication. */
  readonly context:
    WorkspaceSearchMigrationRehearsalReconciliationAuditContext
}

/** Exact canonical artifact and context required for authentication. */
export type AuthenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput = {
  /** Exact canonical authenticated reconciliation-audit bytes. */
  readonly artifactBytes: Uint8Array
  /** Trusted exact scenario, run, boundary, root, counts, and check time. */
  readonly expectedContext:
    WorkspaceSearchMigrationRehearsalReconciliationAuditContext
}

/** Secret-free authenticated reconciliation artifact binding. */
export type WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding =
  WorkspaceSearchMigrationRehearsalReconciliationAuditContext & {
    /** SHA-256 digest of the exact supplied canonical artifact bytes. */
    readonly contentDigest: string
    /** Exact supplied canonical artifact byte length. */
    readonly byteLength: number
    /** Complete marker seal and strong-read comparison. */
    readonly markerSummary:
      WorkspaceSearchMigrationRehearsalReconciliationMarkerSummary
    /** Complete expected and observed durable-authority comparison. */
    readonly authoritySummary:
      WorkspaceSearchMigrationRehearsalReconciliationAuthoritySummary
    /** Complete expected and observed source/target comparison. */
    readonly sourceTargetSummary:
      WorkspaceSearchMigrationRehearsalReconciliationSourceTargetSummary
    /** Exact authenticated auxiliary rate segment and final ledger binding. */
    readonly rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence
    /** Duplicate operation applications derived from marker material. */
    readonly duplicateApplyCount: number
    /** Lost target items derived from source/target material. */
    readonly lostItemCount: number
    /** Orphan durable authorities derived from authority material. */
    readonly orphanAuthorityCount: number
    /** Digest of the complete semantic document before authentication. */
    readonly auditDigest: string
  }

/** One canonical artifact and its exact trusted context in an eight-item batch. */
export type WorkspaceSearchMigrationRehearsalReconciliationArtifactExpectation = {
  /** Exact canonical authenticated reconciliation-audit bytes. */
  readonly artifactBytes: Uint8Array
  /** Exact trusted context for this position in canonical scenario order. */
  readonly expectedContext:
    WorkspaceSearchMigrationRehearsalReconciliationAuditContext
}

/** Input finalizing the exact complete ordered reconciliation evidence set. */
export type FinalizeWorkspaceSearchMigrationRehearsalReconciliationEvidenceInput = {
  /** Exactly eight artifacts in canonical scenario order. */
  readonly artifacts:
    readonly WorkspaceSearchMigrationRehearsalReconciliationArtifactExpectation[]
}

/** Input issuing one terminal-only reconciliation commit capability. */
export type FinalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidenceInput = {
  /** Exact dual-key artifact and parent-authenticated terminal context. */
  readonly artifact:
    AuthenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput
  /** Exact authenticated rate segment that the audit must immediately follow. */
  readonly expectedRatePredecessor:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment
}

/** Opaque one-shot proof admitting one successful terminal reconciliation. */
export class WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence {
  /** Unforgeable module-private construction brand. */
  readonly #brand = finalizedTerminalReconciliationEvidenceToken

  /**
   * Creates one capability only for this module's terminal verifier.
   *
   * @param token - Module-private construction token.
   */
  constructor(token: symbol) {
    if (token !== finalizedTerminalReconciliationEvidenceToken) {
      return failReconciliationAudit()
    }
    Object.freeze(this)
  }

  /**
   * Checks the private brand without revealing stored evidence.
   *
   * @param token - Module-private token supplied by the consumer.
   * @returns Whether this capability came from the terminal verifier.
   */
  isAuthentic(token: symbol): boolean {
    return this.#brand === token
  }
}

/** Opaque one-shot proof that all eight reconciliation artifacts authenticated. */
export class WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence {
  /** Unforgeable module-private construction brand. */
  readonly #brand = finalizedReconciliationEvidenceToken

  /**
   * Creates one capability only for this module's eight-artifact verifier.
   *
   * @param token - Module-private construction token.
   */
  constructor(token: symbol) {
    if (token !== finalizedReconciliationEvidenceToken) {
      return failReconciliationAudit()
    }
    Object.freeze(this)
  }

  /**
   * Checks the private brand without revealing stored evidence.
   *
   * @param token - Module-private token supplied by the consumer.
   * @returns Whether this capability came from the batch verifier.
   */
  isAuthentic(token: symbol): boolean {
    return this.#brand === token
  }
}

/** Runtime semantic and parent-publication HMAC metadata for one audit. */
type ReconciliationAuditAuthentication = {
  /** Fixed authentication algorithm. */
  readonly algorithm: 'HMAC-SHA-256'
  /** Domain-separated fingerprint of the permit-bound runtime HMAC key. */
  readonly runtimeKeyFingerprint: string
  /** Runtime HMAC over the semantic audit and runtime-key fingerprint. */
  readonly runtimeMac: string
  /** Domain-separated fingerprint of the parent-held publication key. */
  readonly publicationKeyFingerprint: string
  /** Parent HMAC over the complete runtime-authenticated audit. */
  readonly publicationMac: string
}

/** Complete semantic reconciliation document covered by its audit digest. */
type ReconciliationAuditSemanticDocument =
  WorkspaceSearchMigrationRehearsalReconciliationAuditContext & {
    /** Stable reconciliation-audit artifact discriminator. */
    readonly kind:
      typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_KIND
    /** Strict reconciliation-audit artifact contract version. */
    readonly auditVersion:
      typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_VERSION
    /** Complete marker seal and strong-read comparison. */
    readonly markerSummary:
      WorkspaceSearchMigrationRehearsalReconciliationMarkerSummary
    /** Complete durable-authority chain comparison. */
    readonly authoritySummary:
      WorkspaceSearchMigrationRehearsalReconciliationAuthoritySummary
    /** Complete source-derived and observed target comparison. */
    readonly sourceTargetSummary:
      WorkspaceSearchMigrationRehearsalReconciliationSourceTargetSummary
    /** Exact authenticated auxiliary rate segment and final ledger binding. */
    readonly rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence
    /** Duplicate operation applications derived from marker material. */
    readonly duplicateApplyCount: number
    /** Lost target items derived from source/target material. */
    readonly lostItemCount: number
    /** Orphan durable authorities derived from authority material. */
    readonly orphanAuthorityCount: number
  }

/** Complete strict authenticated terminal reconciliation document. */
type ReconciliationAuditDocument =
  ReconciliationAuditSemanticDocument & {
    /** Digest of the complete semantic reconciliation document. */
    readonly auditDigest: string
    /** Dedicated whole-document authentication metadata. */
    readonly authentication: ReconciliationAuditAuthentication
  }

/** Runtime-HMAC projection before either authentication MAC is attached. */
type RuntimeUnsignedReconciliationAuditDocument = Omit<
  ReconciliationAuditDocument,
  'authentication'
> & {
  /** Algorithm and runtime-key fingerprint covered by the runtime HMAC. */
  readonly authentication: Pick<
    ReconciliationAuditAuthentication,
    'algorithm' | 'runtimeKeyFingerprint'
  >
}

/** Parent HMAC projection covering the complete runtime authentication. */
type PublicationUnsignedReconciliationAuditDocument = Omit<
  ReconciliationAuditDocument,
  'authentication'
> & {
  /** Runtime authentication plus parent publication-key fingerprint. */
  readonly authentication: Omit<
    ReconciliationAuditAuthentication,
    'publicationMac'
  >
}

/** Strict document plus exact supplied raw-file identity. */
type AuthenticatedReconciliationAuditArtifact = {
  /** Complete strictly parsed and authenticated audit document. */
  readonly document: ReconciliationAuditDocument
  /** SHA-256 digest of the exact supplied canonical bytes. */
  readonly contentDigest: string
  /** Exact supplied canonical byte length. */
  readonly byteLength: number
}

/** Fixed document context fields. */
const contextKeys = Object.freeze([
  'appliedOperationCount',
  'applyBoundaryDigest',
  'checkedAt',
  'configurationBindingDigest',
  'executionRunDigest',
  'integrity',
  'integrityResourceIdentityDigest',
  'planDigest',
  'policyVersion',
  'runLocatorDigest',
  'scenario',
  'sealedPlanOperationCount',
  'sealedPlanningAuthorityDigest',
  'targetAudits',
  'terminalRootDigest',
  'terminalRootKind',
  'terminalRootVersion',
  'terminalAt',
])

/** Exact complete canonical document fields. */
const documentKeys = Object.freeze([
  'appliedOperationCount',
  'applyBoundaryDigest',
  'auditDigest',
  'auditVersion',
  'authentication',
  'authoritySummary',
  'checkedAt',
  'configurationBindingDigest',
  'duplicateApplyCount',
  'executionRunDigest',
  'integrity',
  'integrityResourceIdentityDigest',
  'kind',
  'lostItemCount',
  'markerSummary',
  'orphanAuthorityCount',
  'planDigest',
  'policyVersion',
  'rate',
  'runLocatorDigest',
  'scenario',
  'sealedPlanOperationCount',
  'sealedPlanningAuthorityDigest',
  'sourceTargetSummary',
  'targetAudits',
  'terminalRootDigest',
  'terminalRootKind',
  'terminalRootVersion',
  'terminalAt',
])

/** Domain separating marker-seal binding digests from other artifacts. */
const markerSealBindingDomain =
  'mukuroji-workspace-search-migration-rehearsal-marker-seal/v1'

/** Domain separating marker summary digests from other artifacts. */
const markerSummaryDomain =
  'mukuroji-workspace-search-migration-rehearsal-marker-summary/v1'

/** Domain separating authority summary digests from other artifacts. */
const authoritySummaryDomain =
  'mukuroji-workspace-search-migration-rehearsal-authority-summary/v1'

/** Domain separating source/target summary digests from other artifacts. */
const sourceTargetSummaryDomain =
  'mukuroji-workspace-search-migration-rehearsal-source-target-summary/v1'

/** Domain separating a complete embedded rate-bound #163 result HMAC. */
const reconciliationIntegrityBindingMacDomain =
  'mukuroji:workspace-search-migration:rate-bound-integrity-result:v1\0'

/** v3 context domain binding a verified live result to one terminal. */
const verifiedIntegrityResultContextDomain =
  'workspace-search-migration-rehearsal-terminal-integrity-result-context/v3'

/** v3 context kind binding one rollback before/after comparison. */
const rollbackIntegrityComparisonContextKind =
  'workspace-search-migration-rehearsal-integrity-context/v3'

/** v3 context kind binding terminal migration provenance to #163. */
const migrationIntegrityContextKind =
  'workspace-search-migration-rehearsal-terminal-integrity-migration-context/v3'

/** Domain separating runtime-key fingerprints from all other uses. */
const reconciliationAuditRuntimeKeyFingerprintDomain =
  'mukuroji-workspace-search-migration-rehearsal-reconciliation-audit-runtime-key/v3\n'

/** Domain separating runtime semantic HMAC values from all other uses. */
const reconciliationAuditRuntimeMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-reconciliation-audit-runtime-mac/v3\n'

/** Domain separating parent publication-key fingerprints. */
const reconciliationAuditPublicationKeyFingerprintDomain =
  'mukuroji-workspace-search-migration-rehearsal-reconciliation-audit-publication-key/v3\n'

/** Domain separating parent outer-authorization HMAC values. */
const reconciliationAuditPublicationMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-reconciliation-audit-publication-mac/v3\n'

/** Module-private token for one successful terminal reconciliation proof. */
const finalizedTerminalReconciliationEvidenceToken = Symbol(
  'workspace-search-migration-rehearsal-finalized-terminal-reconciliation-evidence',
)

/** Authenticated terminal bindings retained behind one-shot capabilities. */
const finalizedTerminalReconciliationEvidenceValues = new WeakMap<
  WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence,
  WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding
>()

/** Module-private construction token for finalized eight-scenario evidence. */
const finalizedReconciliationEvidenceToken = Symbol(
  'workspace-search-migration-rehearsal-finalized-reconciliation-evidence',
)

/** Ordered bindings retained behind live one-shot batch capabilities. */
const finalizedReconciliationEvidenceValues = new WeakMap<
  WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence,
  readonly WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[]
>()

/** Strict guards bound to the sole public reconciliation failure. */
const reconciliationAuditGuards =
  new WorkspaceSearchMigrationStrictRecordGuards(
    failReconciliationAudit,
  )

/**
 * Finalizes one measured terminal reconciliation into canonical HMAC evidence.
 *
 * The three public failure counters are derived exclusively from the marker,
 * source/target, and authority submaterial. The runtime key authenticates the
 * measured child semantics, while the parent-held publication key adds an
 * outer authorization that the runtime child cannot forge. Ownership of both
 * keys transfers to this invocation.
 *
 * @param input - Exact normalized collector result.
 * @param runtimeSigningKey - Caller-owned permit-bound runtime HMAC key.
 * @param publicationSigningKey - Caller-owned parent publication HMAC key.
 * @returns Detached exact canonical artifact bytes and their file identity.
 */
export function finalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
  input:
    FinalizeWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactInput,
  runtimeSigningKey: Uint8Array,
  publicationSigningKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalFinalizedReconciliationAuditArtifact {
  let runtimeWorkingKey: Uint8Array | undefined
  let publicationWorkingKey: Uint8Array | undefined
  try {
    runtimeWorkingKey = copyReconciliationAuditKey(runtimeSigningKey)
    publicationWorkingKey = copyReconciliationAuditKey(
      publicationSigningKey,
    )
    zeroizeBytes(runtimeSigningKey)
    zeroizeBytes(publicationSigningKey)
    requireDistinctReconciliationAuditKeys(
      runtimeWorkingKey,
      publicationWorkingKey,
    )
    const inputRecord = reconciliationAuditGuards.requireRecord(input)
    reconciliationAuditGuards.requireExactKeys(inputRecord, [
      'collectorResult',
      'rate',
      'verifiedIntegrity',
    ])
    const rate = finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
      reconciliationAuditGuards.readOwn(inputRecord, 'rate'),
    )
    if (
      !safeDigestEqual(
        rate.authenticationKeyFingerprint,
        createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
          runtimeWorkingKey,
        ),
      )
    ) return failReconciliationAudit()
    const semantic = readReconciliationCollectorResult(
      reconciliationAuditGuards.readOwn(inputRecord, 'collectorResult'),
      rate,
      reconciliationAuditGuards.readOwn(inputRecord, 'verifiedIntegrity'),
      runtimeWorkingKey,
    )
    const auditDigest = createMigrationDigest(semantic)
    const runtimeKeyFingerprint =
      createReconciliationAuditRuntimeKeyFingerprint(
        runtimeWorkingKey,
      )
    const runtimeUnsigned:
      RuntimeUnsignedReconciliationAuditDocument = Object.freeze({
        ...semantic,
        auditDigest,
        authentication: Object.freeze({
          algorithm: 'HMAC-SHA-256',
          runtimeKeyFingerprint,
        }),
      })
    const runtimeMac = createReconciliationAuditRuntimeMac(
      runtimeUnsigned,
      runtimeWorkingKey,
    )
    const publicationKeyFingerprint =
      createReconciliationAuditPublicationKeyFingerprint(
        publicationWorkingKey,
      )
    const publicationUnsigned:
      PublicationUnsignedReconciliationAuditDocument = Object.freeze({
        ...semantic,
        auditDigest,
        authentication: Object.freeze({
          algorithm: 'HMAC-SHA-256',
          runtimeKeyFingerprint,
          runtimeMac,
          publicationKeyFingerprint,
        }),
      })
    const document: ReconciliationAuditDocument = Object.freeze({
      ...semantic,
      auditDigest,
      authentication: Object.freeze({
        ...publicationUnsigned.authentication,
        publicationMac: createReconciliationAuditPublicationMac(
          publicationUnsigned,
          publicationWorkingKey,
        ),
      }),
    })
    const canonicalBytes = new TextEncoder().encode(
      serializeCanonicalJson(document),
    )
    if (
      canonicalBytes.byteLength === 0 ||
      canonicalBytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES
    ) {
      return failReconciliationAudit()
    }
    return Object.freeze({
      canonicalBytes,
      byteLength: canonicalBytes.byteLength,
      contentDigest: createHash('sha256')
        .update(canonicalBytes)
        .digest('hex'),
      context: createContextFromSemanticDocument(semantic),
    })
  } catch (error) {
    return replaceReconciliationAuditFailure(error)
  } finally {
    zeroizeBytes(runtimeWorkingKey)
    zeroizeBytes(publicationWorkingKey)
    zeroizeBytes(runtimeSigningKey)
    zeroizeBytes(publicationSigningKey)
  }
}

/**
 * Authenticates one canonical audit against its exact trusted context.
 *
 * Canonical encoding, exact key sets, every internal arithmetic identity,
 * every summary digest, the semantic audit digest, key fingerprint, and
 * runtime HMAC, and parent publication HMAC are checked before context
 * equality. Nonzero measured failure counts remain valid authenticated
 * evidence for a terminal caller to reject. Ownership of both keys transfers.
 *
 * @param input - Canonical artifact bytes and exact expected context.
 * @param runtimeVerificationKey - Caller-owned permit-bound runtime key.
 * @param publicationVerificationKey - Caller-owned parent publication key.
 * @returns Frozen secret-free exact artifact and measurement binding.
 */
export function authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
  input: unknown,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding {
  let runtimeWorkingKey: Uint8Array | undefined
  let publicationWorkingKey: Uint8Array | undefined
  try {
    runtimeWorkingKey = copyReconciliationAuditKey(runtimeVerificationKey)
    publicationWorkingKey = copyReconciliationAuditKey(
      publicationVerificationKey,
    )
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
    requireDistinctReconciliationAuditKeys(
      runtimeWorkingKey,
      publicationWorkingKey,
    )
    return authenticateReconciliationAuditWithWorkingKeys(
      input,
      runtimeWorkingKey,
      publicationWorkingKey,
    )
  } catch (error) {
    return replaceReconciliationAuditFailure(error)
  } finally {
    zeroizeBytes(runtimeWorkingKey)
    zeroizeBytes(publicationWorkingKey)
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
  }
}

/**
 * Authenticates actual canonical audit bytes without a pre-synthesized context.
 *
 * This boundary is reserved for actual-artifact-first terminal finalization:
 * the dual-key-authenticated artifact becomes the source of its context rather
 * than asking a caller to predict a strong-read completion timestamp. All
 * canonical, semantic, rate, runtime-MAC, and publication-MAC checks performed
 * by the context-bound authenticator still apply. Ownership of both keys
 * transfers to this invocation.
 *
 * @param artifactBytes - Exact canonical reconciliation artifact bytes.
 * @param runtimeVerificationKey - Caller-owned permit-bound runtime key.
 * @param publicationVerificationKey - Caller-owned parent publication key.
 * @returns Frozen secret-free exact artifact and measurement binding.
 */
export function authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBytes(
  artifactBytes: unknown,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding {
  let runtimeWorkingKey: Uint8Array | undefined
  let publicationWorkingKey: Uint8Array | undefined
  try {
    runtimeWorkingKey = copyReconciliationAuditKey(runtimeVerificationKey)
    publicationWorkingKey = copyReconciliationAuditKey(
      publicationVerificationKey,
    )
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
    requireDistinctReconciliationAuditKeys(
      runtimeWorkingKey,
      publicationWorkingKey,
    )
    return createReconciliationAuditBinding(
      readAuthenticatedReconciliationAuditDocument(
        artifactBytes,
        runtimeWorkingKey,
        publicationWorkingKey,
      ),
    )
  } catch (error) {
    return replaceReconciliationAuditFailure(error)
  } finally {
    zeroizeBytes(runtimeWorkingKey)
    zeroizeBytes(publicationWorkingKey)
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
  }
}

/**
 * Authenticates one successful terminal audit and issues a one-shot commit gate.
 *
 * The artifact must match the exact parent-owned context, carry zero safety
 * discrepancies, and immediately succeed the supplied authenticated rate
 * predecessor. Ownership of both verification keys transfers to this call.
 *
 * @param input - Exact artifact, terminal context, and rate predecessor.
 * @param runtimeVerificationKey - Caller-owned permit-bound runtime key.
 * @param publicationVerificationKey - Caller-owned parent publication key.
 * @returns Opaque one-shot capability accepted by the irreversible commit gate.
 */
export function finalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidence(
  input:
    FinalizeWorkspaceSearchMigrationRehearsalTerminalReconciliationEvidenceInput,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence {
  try {
    const record = reconciliationAuditGuards.requireRecord(input)
    reconciliationAuditGuards.requireExactKeys(record, [
      'artifact',
      'expectedRatePredecessor',
    ])
    const expectedRatePredecessor =
      readTerminalReconciliationRatePredecessor(
        reconciliationAuditGuards.readOwn(
          record,
          'expectedRatePredecessor',
        ),
      )
    const binding =
      authenticateWorkspaceSearchMigrationRehearsalReconciliationAuditArtifact(
        reconciliationAuditGuards.readOwn(record, 'artifact'),
        runtimeVerificationKey,
        publicationVerificationKey,
      )
    requireZeroBatchDiscrepancies([binding])
    if (
      serializeCanonicalJson(binding.rate.predecessor) !==
        serializeCanonicalJson(expectedRatePredecessor)
    ) {
      return failReconciliationAudit()
    }
    const capability =
      new WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
        finalizedTerminalReconciliationEvidenceToken,
      )
    finalizedTerminalReconciliationEvidenceValues.set(capability, binding)
    return capability
  } catch (error) {
    return replaceReconciliationAuditFailure(error)
  } finally {
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
  }
}

/**
 * Reads one genuine unconsumed terminal reconciliation capability.
 *
 * This non-consuming boundary lets a preflight verify the exact binding while
 * reserving the one-shot consume operation for the irreversible store CAS.
 *
 * @param value - Candidate opaque capability from the terminal verifier.
 * @returns Frozen authenticated artifact binding without consuming the gate.
 */
export function readWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidenceBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding {
  try {
    if (
      nodeUtilTypes.isProxy(value) ||
      !(value instanceof
        WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence) ||
      !value.isAuthentic(finalizedTerminalReconciliationEvidenceToken)
    ) {
      return failReconciliationAudit()
    }
    const binding = finalizedTerminalReconciliationEvidenceValues.get(value)
    if (binding === undefined) return failReconciliationAudit()
    return binding
  } catch (error) {
    return replaceReconciliationAuditFailure(error)
  }
}

/**
 * Consumes one terminal reconciliation commit capability exactly once.
 *
 * @param value - Candidate opaque capability from the terminal verifier.
 * @returns Frozen authenticated artifact binding for the commit adapter.
 */
export function consumeWorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding {
  try {
    if (
      nodeUtilTypes.isProxy(value) ||
      !(value instanceof
        WorkspaceSearchMigrationRehearsalFinalizedTerminalReconciliationEvidence) ||
      !value.isAuthentic(finalizedTerminalReconciliationEvidenceToken)
    ) {
      return failReconciliationAudit()
    }
    const binding = finalizedTerminalReconciliationEvidenceValues.get(value)
    if (binding === undefined) return failReconciliationAudit()
    finalizedTerminalReconciliationEvidenceValues.delete(value)
    return binding
  } catch (error) {
    return replaceReconciliationAuditFailure(error)
  }
}

/**
 * Snapshots one strict parent-authenticated reconciliation expectation.
 *
 * Stage receipt construction and parsing use this single boundary so the
 * context expected before a later artifact exists cannot drift from artifact
 * authentication semantics.
 *
 * @param value - Candidate complete reconciliation audit context.
 * @returns Frozen strict context snapshot for a parent-authenticated receipt.
 */
export function snapshotWorkspaceSearchMigrationRehearsalReconciliationAuditContext(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationAuditContext {
  try {
    return readReconciliationAuditContext(value)
  } catch (error) {
    return replaceReconciliationAuditFailure(error)
  }
}

/**
 * Authenticates the exact complete eight-scenario reconciliation evidence set.
 *
 * Artifacts must appear in canonical scenario order under the same permit-
 * bound runtime and parent-held publication keys.
 * Duplicate content, run, execution, or terminal-root bindings are rejected
 * as replay before an opaque one-shot capability is returned. Ownership of
 * both verification keys transfers to this invocation.
 *
 * @param input - Exactly eight canonical artifacts and trusted contexts.
 * @param runtimeVerificationKey - Caller-owned permit-bound runtime key.
 * @param publicationVerificationKey - Caller-owned parent publication key.
 * @returns Opaque one-shot proof of the complete authenticated batch.
 */
export function finalizeWorkspaceSearchMigrationRehearsalReconciliationEvidence(
  input:
    FinalizeWorkspaceSearchMigrationRehearsalReconciliationEvidenceInput,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence {
  let runtimeWorkingKey: Uint8Array | undefined
  let publicationWorkingKey: Uint8Array | undefined
  try {
    runtimeWorkingKey = copyReconciliationAuditKey(runtimeVerificationKey)
    publicationWorkingKey = copyReconciliationAuditKey(
      publicationVerificationKey,
    )
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
    requireDistinctReconciliationAuditKeys(
      runtimeWorkingKey,
      publicationWorkingKey,
    )
    const inputRecord = reconciliationAuditGuards.requireRecord(input)
    reconciliationAuditGuards.requireExactKeys(inputRecord, ['artifacts'])
    const artifacts = readExactBatch(
      reconciliationAuditGuards.readOwn(inputRecord, 'artifacts'),
    )
    const bindings:
      WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[] =
        []
    for (let index = 0; index < artifacts.length; index += 1) {
      const artifact = artifacts[index]
      const scenario =
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS[
          index
        ]
      if (
        artifact === undefined ||
        scenario === undefined ||
        artifact.expectedContext.scenario !== scenario
      ) {
        return failReconciliationAudit()
      }
      bindings.push(
        authenticateReconciliationAuditWithWorkingKeys(
          artifact,
          runtimeWorkingKey,
          publicationWorkingKey,
        ),
      )
    }
    requireZeroBatchDiscrepancies(bindings)
    requireUniqueBatchBindings(bindings)
    const frozenBindings = Object.freeze([...bindings])
    const finalized =
      new WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence(
        finalizedReconciliationEvidenceToken,
      )
    finalizedReconciliationEvidenceValues.set(finalized, frozenBindings)
    return finalized
  } catch (error) {
    return replaceReconciliationAuditFailure(error)
  } finally {
    zeroizeBytes(runtimeWorkingKey)
    zeroizeBytes(publicationWorkingKey)
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
  }
}

/**
 * Consumes one finalized eight-scenario capability exactly once.
 *
 * @param value - Candidate opaque capability from the batch verifier.
 * @returns Frozen canonical-order secret-free authenticated bindings.
 */
export function consumeWorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[] {
  try {
    if (
      !(value instanceof
        WorkspaceSearchMigrationRehearsalFinalizedReconciliationEvidence) ||
      !value.isAuthentic(finalizedReconciliationEvidenceToken)
    ) {
      return failReconciliationAudit()
    }
    const bindings = finalizedReconciliationEvidenceValues.get(value)
    if (bindings === undefined) return failReconciliationAudit()
    finalizedReconciliationEvidenceValues.delete(value)
    return bindings
  } catch (error) {
    return replaceReconciliationAuditFailure(error)
  }
}

/** Rejects every authenticated reconciliation discrepancy before publication. */
function requireZeroBatchDiscrepancies(
  bindings:
    readonly WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[],
): void {
  for (const binding of bindings) {
    if (
      binding.duplicateApplyCount !== 0 ||
      binding.lostItemCount !== 0 ||
      binding.orphanAuthorityCount !== 0 ||
      binding.markerSummary.duplicateCount !== 0 ||
      binding.markerSummary.missingCount !== 0 ||
      binding.markerSummary.unexpectedCount !== 0 ||
      binding.authoritySummary.missingCount !== 0 ||
      binding.authoritySummary.orphanCount !== 0 ||
      binding.sourceTargetSummary.lostCount !== 0 ||
      binding.sourceTargetSummary.unexpectedCount !== 0
    ) {
      return failReconciliationAudit()
    }
  }
}

/** Reads one finalizer input and derives all public digests and counters. */
function readReconciliationCollectorResult(
  value: unknown,
  rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  verifiedIntegrityValue: unknown,
  runtimeKey: Uint8Array,
): ReconciliationAuditSemanticDocument {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'authoritySummary',
    'context',
    'integrity',
    'markerSummary',
    'sourceTargetSummary',
    'targetAudits',
  ])
  const coreContext = readReconciliationCoreContext(
    reconciliationAuditGuards.readOwn(record, 'context'),
  )
  const markerSummary = readMarkerCollectorResult(
    reconciliationAuditGuards.readOwn(record, 'markerSummary'),
    coreContext,
  )
  const authoritySummary = readAuthorityCollectorResult(
    reconciliationAuditGuards.readOwn(record, 'authoritySummary'),
  )
  const sourceTargetSummary = readSourceTargetCollectorResult(
    reconciliationAuditGuards.readOwn(record, 'sourceTargetSummary'),
  )
  const targetAudits = readReconciliationTargetAudits(
    reconciliationAuditGuards.readOwn(record, 'targetAudits'),
    coreContext,
    sourceTargetSummary,
  )
  if (
    rate.link.configurationBindingDigest !==
      coreContext.configurationBindingDigest ||
    rate.link.policyVersion !== coreContext.policyVersion ||
    Date.parse(rate.completedAt) < Date.parse(coreContext.checkedAt)
  ) return failReconciliationAudit()
  let integrity:
    WorkspaceSearchMigrationRehearsalReconciliationIntegritySummary
  const collectorIntegrityRecord = reconciliationAuditGuards.requireRecord(
    reconciliationAuditGuards.readOwn(record, 'integrity'),
  )
  if (isVerifiedScenario(coreContext.scenario)) {
    if (targetAudits !== null) return failReconciliationAudit()
    let consumedIntegrity:
      WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
    try {
      consumedIntegrity =
        consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
          verifiedIntegrityValue,
        )
    } catch {
      return failReconciliationAudit()
    }
    const verifiedIntegrity = readRateBoundIntegrityResult(
      consumedIntegrity,
    )
    requireIntegrityRuntimeBinding(verifiedIntegrity, runtimeKey)
    requireVerifiedIntegrityRateAndContext(
      verifiedIntegrity,
      rate,
      coreContext,
    )
    reconciliationAuditGuards.requireExactKeys(collectorIntegrityRecord, [
      'completedAt',
      'failureCount',
      'integrityAggregateDigest',
      'kind',
      'result',
      'status',
      'terminalRootDigest',
    ])
    integrity = readVerifiedIntegrityCollector(
      collectorIntegrityRecord,
      coreContext,
      verifiedIntegrity,
      readIntegrityResultBinding(
        reconciliationAuditGuards.readOwn(
          collectorIntegrityRecord,
          'result',
        ),
      ),
    )
  } else {
    if (verifiedIntegrityValue !== null || targetAudits === null) {
      return failReconciliationAudit()
    }
    requireTargetIntegrityRuntimeBindings(targetAudits, runtimeKey)
    reconciliationAuditGuards.requireExactKeys(collectorIntegrityRecord, [
      'after',
      'applyStartedAt',
      'before',
      'comparisonContextDigest',
      'comparisonDigest',
      'completedAt',
      'failureCount',
      'kind',
      'purpose',
      'startedAt',
      'status',
      'targetPreimageAggregateDigest',
      'targetPreimageStatus',
      'targetRestoredAggregateDigest',
      'terminalAt',
      'terminalRootDigest',
    ])
    integrity = readRollbackIntegrityCollector(
      collectorIntegrityRecord,
      coreContext,
      sourceTargetSummary,
      targetAudits,
    )
  }
  return Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_KIND,
    auditVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_VERSION,
    ...coreContext,
    integrity,
    targetAudits,
    markerSummary,
    authoritySummary,
    sourceTargetSummary,
    rate,
    duplicateApplyCount: markerSummary.duplicateCount,
    lostItemCount: sourceTargetSummary.lostCount,
    orphanAuthorityCount: authoritySummary.orphanCount,
  })
}

/**
 * Reads rollback target summaries and binds them to integrity and strong reads.
 *
 * @param value - Candidate authenticated target pair or strict null.
 * @param context - Exact terminal reconciliation context.
 * @param sourceTarget - Strong-read source/target reconciliation summary.
 * @returns Strict target pair for rollback, otherwise null.
 */
function readReconciliationTargetAudits(
  value: unknown,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  sourceTarget:
    | WorkspaceSearchMigrationRehearsalReconciliationSourceTargetSummary
    | undefined,
): WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null {
  if (isVerifiedScenario(context.scenario)) {
    if (value !== null) return failReconciliationAudit()
    return null
  }
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'preimage',
    'restored',
  ])
  const purposePrefix = context.scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : context.scenario === 'complete-apply-rollback'
    ? 'complete-rollback'
    : null
  if (purposePrefix === null) return failReconciliationAudit()
  const preimage = readReconciliationTargetAuditSummary(
    reconciliationAuditGuards.readOwn(record, 'preimage'),
    `${purposePrefix}-preimage`,
  )
  const restored = readReconciliationTargetAuditSummary(
    reconciliationAuditGuards.readOwn(record, 'restored'),
    `${purposePrefix}-restored`,
  )
  const terminal = restored.terminal
  if (
    preimage.terminal !== null ||
    terminal === null ||
    preimage.contentDigest === restored.contentDigest ||
    preimage.observationDigest === restored.observationDigest ||
    preimage.aggregateDigest !== restored.aggregateDigest ||
    (sourceTarget !== undefined &&
      (preimage.aggregateDigest !== sourceTarget.expectedAggregateDigest ||
        restored.aggregateDigest !== sourceTarget.observedAggregateDigest)) ||
    preimage.contextDigest !== restored.contextDigest ||
    serializeCanonicalJson(preimage.context) !==
      serializeCanonicalJson(restored.context) ||
    preimage.context.scenario !== context.scenario ||
    preimage.context.runLocatorDigest !== context.runLocatorDigest ||
    preimage.context.configurationBindingDigest !==
      context.configurationBindingDigest ||
    preimage.context.policyVersion !== context.policyVersion ||
    preimage.context.integrityResourceIdentityDigest !==
      context.integrityResourceIdentityDigest ||
    preimage.context.sealedPlanningAuthorityDigest !==
      context.sealedPlanningAuthorityDigest ||
    preimage.context.planDigest !== context.planDigest ||
    terminal.scenario !== context.scenario ||
    terminal.kind !== 'rolled-back' ||
    terminal.version !== context.terminalRootVersion ||
    terminal.rootDigest !== context.terminalRootDigest ||
    terminal.terminalAt !== context.terminalAt ||
    Date.parse(terminal.applyStartedAt) >= Date.parse(terminal.terminalAt) ||
    Date.parse(preimage.observedAt) >=
      Date.parse(terminal.applyStartedAt) ||
    Date.parse(preimage.rate.completedAt) >=
      Date.parse(terminal.applyStartedAt) ||
    Date.parse(preimage.observedAt) >= Date.parse(context.terminalAt) ||
    Date.parse(restored.startedAt) <= Date.parse(context.terminalAt) ||
    Date.parse(restored.observedAt) <= Date.parse(context.terminalAt) ||
    Date.parse(restored.observedAt) > Date.parse(context.checkedAt) ||
    Date.parse(restored.rate.completedAt) > Date.parse(context.checkedAt) ||
    preimage.integrity.result.resourceIdentityScheme !==
      restored.integrity.result.resourceIdentityScheme ||
    serializeCanonicalJson(preimage.integrity.result.resourceIdentities) !==
      serializeCanonicalJson(restored.integrity.result.resourceIdentities) ||
    preimage.integrity.result.resourceIdentityDigest !==
      restored.integrity.result.resourceIdentityDigest ||
    preimage.integrity.result.integrityAggregateDigest !==
      restored.integrity.result.integrityAggregateDigest ||
    preimage.rate.successor.segmentDigest ===
      restored.rate.successor.segmentDigest ||
    preimage.rate.successor.segmentLocatorDigest ===
      restored.rate.successor.segmentLocatorDigest
  ) {
    return failReconciliationAudit()
  }
  return Object.freeze({ preimage, restored })
}

/**
 * Reads one exact target-audit summary embedded after dual-key authentication.
 *
 * @param value - Candidate full authenticated target summary.
 * @param expectedPurpose - Scenario and side fixed by the outer context.
 * @returns Frozen target summary with strict auxiliary rate evidence.
 */
function readReconciliationTargetAuditSummary(
  value: unknown,
  expectedPurpose:
    | 'complete-rollback-preimage'
    | 'complete-rollback-restored'
    | 'partial-rollback-preimage'
    | 'partial-rollback-restored',
): WorkspaceSearchMigrationRehearsalReconciliationTargetAuditSummary {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'aggregateDigest',
    'byteLength',
    'contentDigest',
    'context',
    'contextDigest',
    'integrity',
    'observationDigest',
    'observedAt',
    'purpose',
    'rate',
    'startedAt',
    'terminal',
  ])
  if (reconciliationAuditGuards.readOwn(record, 'purpose') !== expectedPurpose) {
    return failReconciliationAudit()
  }
  const startedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'startedAt'),
  )
  const observedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'observedAt'),
  )
  const rate = readWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
    reconciliationAuditGuards.readOwn(record, 'rate'),
  )
  const preimage = expectedPurpose === 'partial-rollback-preimage' ||
    expectedPurpose === 'complete-rollback-preimage'
  const context = readTargetAuditContext(
    reconciliationAuditGuards.readOwn(record, 'context'),
  )
  const terminal = readTargetAuditTerminal(
    reconciliationAuditGuards.readOwn(record, 'terminal'),
    expectedPurpose,
  )
  const integrity = readRateBoundIntegrityResult(
    reconciliationAuditGuards.readOwn(record, 'integrity'),
  )
  if (
    Date.parse(startedAt) > Date.parse(observedAt) ||
    Date.parse(rate.completedAt) < Date.parse(observedAt) ||
    Date.parse(integrity.result.runtimeProvenance.completedAt) >
      Date.parse(observedAt) ||
    integrity.configurationBindingDigest !==
      context.configurationBindingDigest ||
    integrity.policyVersion !== context.policyVersion ||
    integrity.result.resourceIdentityDigest !==
      context.integrityResourceIdentityDigest ||
    rate.link.configurationBindingDigest !==
      context.configurationBindingDigest ||
    rate.link.policyVersion !== context.policyVersion ||
    !sameVerifiedRateSegment(integrity.predecessor, rate.predecessor) ||
    !sameVerifiedRateSegment(integrity.segment, rate.successor) ||
    (preimage && terminal !== null) ||
    (!preimage &&
      (terminal === null ||
        Date.parse(startedAt) <= Date.parse(terminal.terminalAt) ||
        Date.parse(integrity.result.runtimeProvenance.startedAt) <
          Date.parse(terminal.terminalAt)))
  ) {
    return failReconciliationAudit()
  }
  const byteLength = readPositiveInteger(
    reconciliationAuditGuards.readOwn(record, 'byteLength'),
  )
  if (byteLength > 64 * 1_024 * 1_024) return failReconciliationAudit()
  const contextDigest = readDigestOwn(record, 'contextDigest')
  if (contextDigest !== createMigrationDigest(context)) {
    return failReconciliationAudit()
  }
  return Object.freeze({
    purpose: expectedPurpose,
    startedAt,
    contentDigest: readDigestOwn(record, 'contentDigest'),
    byteLength,
    observedAt,
    observationDigest: readDigestOwn(record, 'observationDigest'),
    aggregateDigest: readDigestOwn(record, 'aggregateDigest'),
    contextDigest,
    context,
    terminal,
    integrity,
    rate,
  })
}

/** Authenticates one artifact using invocation-owned runtime and parent keys. */
function authenticateReconciliationAuditWithWorkingKeys(
  value: unknown,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding {
  const inputRecord = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(inputRecord, [
    'artifactBytes',
    'expectedContext',
  ])
  const expectedContext = readReconciliationAuditContext(
    reconciliationAuditGuards.readOwn(inputRecord, 'expectedContext'),
  )
  const authenticated = readAuthenticatedReconciliationAuditDocument(
    reconciliationAuditGuards.readOwn(inputRecord, 'artifactBytes'),
    runtimeKey,
    publicationKey,
  )
  const document = authenticated.document
  if (!sameReconciliationAuditContext(document, expectedContext)) {
    return failReconciliationAudit()
  }
  return createReconciliationAuditBinding(authenticated)
}

/** Parses, canonicalizes, and authenticates one complete raw artifact. */
function readAuthenticatedReconciliationAuditDocument(
  value: unknown,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): AuthenticatedReconciliationAuditArtifact {
  let bytes: Uint8Array | undefined
  try {
    bytes = copyReconciliationAuditBytes(value)
    const byteLength = bytes.byteLength
    const contentDigest = createHash('sha256').update(bytes).digest('hex')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsedValue: unknown = JSON.parse(text)
    const document = readReconciliationAuditDocument(parsedValue)
    if (serializeCanonicalJson(document) !== text) {
      return failReconciliationAudit()
    }
    const runtimeKeyFingerprint =
      createReconciliationAuditRuntimeKeyFingerprint(runtimeKey)
    const publicationKeyFingerprint =
      createReconciliationAuditPublicationKeyFingerprint(publicationKey)
    requireDocumentIntegrityRuntimeBindings(document, runtimeKey)
    if (
      !safeDigestEqual(
        document.authentication.runtimeKeyFingerprint,
        runtimeKeyFingerprint,
      ) ||
      !safeDigestEqual(
        document.authentication.publicationKeyFingerprint,
        publicationKeyFingerprint,
      ) ||
      !safeDigestEqual(
        document.rate.authenticationKeyFingerprint,
        createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
          runtimeKey,
        ),
      )
    ) {
      return failReconciliationAudit()
    }
    const expectedRuntimeMac = createReconciliationAuditRuntimeMac(
      createRuntimeUnsignedReconciliationAuditDocument(document),
      runtimeKey,
    )
    if (
      !safeDigestEqual(
        document.authentication.runtimeMac,
        expectedRuntimeMac,
      )
    ) {
      return failReconciliationAudit()
    }
    const expectedPublicationMac = createReconciliationAuditPublicationMac(
      createPublicationUnsignedReconciliationAuditDocument(document),
      publicationKey,
    )
    if (
      !safeDigestEqual(
        document.authentication.publicationMac,
        expectedPublicationMac,
      )
    ) {
      return failReconciliationAudit()
    }
    return Object.freeze({
      document,
      contentDigest,
      byteLength,
    })
  } catch (error) {
    if (
      error instanceof
        WorkspaceSearchMigrationRehearsalReconciliationAuditError
    ) {
      throw error
    }
    return failReconciliationAudit()
  } finally {
    zeroizeBytes(bytes)
  }
}

/** Strictly reads one complete canonical reconciliation-audit document. */
function readReconciliationAuditDocument(
  value: unknown,
): ReconciliationAuditDocument {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, documentKeys)
  if (
    reconciliationAuditGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_KIND ||
    reconciliationAuditGuards.readOwn(record, 'auditVersion') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_VERSION
  ) {
    return failReconciliationAudit()
  }
  const coreContext = readReconciliationAuditCoreContextFields(record)
  const markerSummary = readMarkerSummary(
    reconciliationAuditGuards.readOwn(record, 'markerSummary'),
    coreContext,
  )
  const authoritySummary = readAuthoritySummary(
    reconciliationAuditGuards.readOwn(record, 'authoritySummary'),
  )
  const sourceTargetSummary = readSourceTargetSummary(
    reconciliationAuditGuards.readOwn(record, 'sourceTargetSummary'),
  )
  const rate = readWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
    reconciliationAuditGuards.readOwn(record, 'rate'),
  )
  if (
    rate.link.configurationBindingDigest !==
      coreContext.configurationBindingDigest ||
    rate.link.policyVersion !== coreContext.policyVersion ||
    Date.parse(rate.completedAt) < Date.parse(coreContext.checkedAt)
  ) return failReconciliationAudit()
  const targetAudits = readReconciliationTargetAudits(
    reconciliationAuditGuards.readOwn(record, 'targetAudits'),
    coreContext,
    sourceTargetSummary,
  )
  const integrity = readIntegritySummary(
    reconciliationAuditGuards.readOwn(record, 'integrity'),
    coreContext,
    sourceTargetSummary,
    targetAudits,
    rate,
  )
  const context = Object.freeze({ ...coreContext, integrity, targetAudits })
  const duplicateApplyCount = readNonNegativeInteger(
    reconciliationAuditGuards.readOwn(record, 'duplicateApplyCount'),
  )
  const lostItemCount = readNonNegativeInteger(
    reconciliationAuditGuards.readOwn(record, 'lostItemCount'),
  )
  const orphanAuthorityCount = readNonNegativeInteger(
    reconciliationAuditGuards.readOwn(record, 'orphanAuthorityCount'),
  )
  if (
    duplicateApplyCount !== markerSummary.duplicateCount ||
    lostItemCount !== sourceTargetSummary.lostCount ||
    orphanAuthorityCount !== authoritySummary.orphanCount
  ) {
    return failReconciliationAudit()
  }
  const semantic: ReconciliationAuditSemanticDocument = Object.freeze({
    kind:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_KIND,
    auditVersion:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_VERSION,
    ...context,
    markerSummary,
    authoritySummary,
    sourceTargetSummary,
    rate,
    duplicateApplyCount,
    lostItemCount,
    orphanAuthorityCount,
  })
  const auditDigest = reconciliationAuditGuards.readDigest(
    reconciliationAuditGuards.readOwn(record, 'auditDigest'),
  )
  if (auditDigest !== createMigrationDigest(semantic)) {
    return failReconciliationAudit()
  }
  return Object.freeze({
    ...semantic,
    auditDigest,
    authentication: readReconciliationAuditAuthentication(
      reconciliationAuditGuards.readOwn(record, 'authentication'),
    ),
  })
}

/** Reads one detached exact context record. */
function readReconciliationAuditContext(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationAuditContext {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, contextKeys)
  const coreContext = readReconciliationAuditCoreContextFields(record)
  const targetAudits = readReconciliationTargetAudits(
    reconciliationAuditGuards.readOwn(record, 'targetAudits'),
    coreContext,
    undefined,
  )
  const integrity = readIntegritySummary(
    reconciliationAuditGuards.readOwn(record, 'integrity'),
    coreContext,
    undefined,
    targetAudits,
    undefined,
  )
  return Object.freeze({ ...coreContext, integrity, targetAudits })
}

/** Reads one detached exact core context record. */
function readReconciliationCoreContext(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationCoreContext {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(
    record,
    contextKeys.filter((key) =>
      key !== 'integrity' && key !== 'targetAudits'
    ),
  )
  return readReconciliationAuditCoreContextFields(record)
}

/** Reads core context properties from a context or complete document. */
function readReconciliationAuditCoreContextFields(
  record: object,
): WorkspaceSearchMigrationRehearsalReconciliationCoreContext {
  const scenario = readScenario(
    reconciliationAuditGuards.readOwn(record, 'scenario'),
  )
  const terminalRootKind = readTerminalRootKind(
    reconciliationAuditGuards.readOwn(record, 'terminalRootKind'),
  )
  const terminalRootVersion = readTerminalRootVersion(
    reconciliationAuditGuards.readOwn(record, 'terminalRootVersion'),
  )
  const sealedPlanOperationCount = readPositiveInteger(
    reconciliationAuditGuards.readOwn(
      record,
      'sealedPlanOperationCount',
    ),
  )
  const appliedOperationCount = readNonNegativeInteger(
    reconciliationAuditGuards.readOwn(record, 'appliedOperationCount'),
  )
  requireScenarioTerminal(
    scenario,
    terminalRootKind,
    terminalRootVersion,
    sealedPlanOperationCount,
    appliedOperationCount,
  )
  const terminalAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'terminalAt'),
  )
  const checkedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'checkedAt'),
  )
  if (Date.parse(terminalAt) >= Date.parse(checkedAt)) {
    return failReconciliationAudit()
  }
  return Object.freeze({
    scenario,
    runLocatorDigest: readDigestOwn(record, 'runLocatorDigest'),
    configurationBindingDigest: readDigestOwn(
      record,
      'configurationBindingDigest',
    ),
    policyVersion: readDigestOwn(record, 'policyVersion'),
    integrityResourceIdentityDigest: readDigestOwn(
      record,
      'integrityResourceIdentityDigest',
    ),
    sealedPlanningAuthorityDigest: readDigestOwn(
      record,
      'sealedPlanningAuthorityDigest',
    ),
    executionRunDigest: readDigestOwn(record, 'executionRunDigest'),
    planDigest: readDigestOwn(record, 'planDigest'),
    applyBoundaryDigest: readDigestOwn(record, 'applyBoundaryDigest'),
    terminalRootKind,
    terminalRootVersion,
    terminalRootDigest: readDigestOwn(record, 'terminalRootDigest'),
    sealedPlanOperationCount,
    appliedOperationCount,
    terminalAt,
    checkedAt,
  })
}

/** Reads raw marker material and derives its context-bound digests. */
function readMarkerCollectorResult(
  value: unknown,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
): WorkspaceSearchMigrationRehearsalReconciliationMarkerSummary {
  const material = readMarkerMaterial(value, false)
  requireMarkerArithmetic(material, context.appliedOperationCount)
  const expectedSealKind = deriveMarkerSealKind(context)
  const expectedSealBindingDigest = createMarkerSealBindingDigest(
    context,
    expectedSealKind,
    material.expectedCount,
    material.expectedAggregateDigest,
  )
  const summaryFields = Object.freeze({
    ...material,
    expectedSealKind,
    expectedSealBindingDigest,
  })
  return Object.freeze({
    ...summaryFields,
    summaryDigest: createMarkerSummaryDigest(summaryFields),
  })
}

/** Reads and validates one complete canonical marker summary. */
function readMarkerSummary(
  value: unknown,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
): WorkspaceSearchMigrationRehearsalReconciliationMarkerSummary {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'duplicateCount',
    'expectedAggregateDigest',
    'expectedCount',
    'expectedSealBindingDigest',
    'expectedSealKind',
    'matchedCount',
    'missingCount',
    'observedAggregateDigest',
    'observedCount',
    'summaryDigest',
    'unexpectedCount',
  ])
  const material = readMarkerMaterial(record, true)
  requireMarkerArithmetic(material, context.appliedOperationCount)
  const expectedSealKind = readMarkerSealKind(
    reconciliationAuditGuards.readOwn(record, 'expectedSealKind'),
  )
  if (expectedSealKind !== deriveMarkerSealKind(context)) {
    return failReconciliationAudit()
  }
  const expectedSealBindingDigest = readDigestOwn(
    record,
    'expectedSealBindingDigest',
  )
  if (
    expectedSealBindingDigest !== createMarkerSealBindingDigest(
      context,
      expectedSealKind,
      material.expectedCount,
      material.expectedAggregateDigest,
    )
  ) {
    return failReconciliationAudit()
  }
  const summaryFields = Object.freeze({
    ...material,
    expectedSealKind,
    expectedSealBindingDigest,
  })
  const summaryDigest = readDigestOwn(record, 'summaryDigest')
  if (summaryDigest !== createMarkerSummaryDigest(summaryFields)) {
    return failReconciliationAudit()
  }
  return Object.freeze({ ...summaryFields, summaryDigest })
}

/** Reads marker comparison fields from a collector or artifact record. */
function readMarkerMaterial(
  value: unknown,
  artifact: boolean,
): WorkspaceSearchMigrationRehearsalReconciliationMarkerCollectorResult {
  const record = reconciliationAuditGuards.requireRecord(value)
  if (!artifact) {
    reconciliationAuditGuards.requireExactKeys(record, [
      'duplicateCount',
      'expectedAggregateDigest',
      'expectedCount',
      'matchedCount',
      'missingCount',
      'observedAggregateDigest',
      'observedCount',
      'unexpectedCount',
    ])
  }
  return Object.freeze({
    expectedCount: readNonNegativeIntegerOwn(record, 'expectedCount'),
    expectedAggregateDigest: readDigestOwn(
      record,
      'expectedAggregateDigest',
    ),
    observedCount: readNonNegativeIntegerOwn(record, 'observedCount'),
    observedAggregateDigest: readDigestOwn(
      record,
      'observedAggregateDigest',
    ),
    matchedCount: readNonNegativeIntegerOwn(record, 'matchedCount'),
    duplicateCount: readNonNegativeIntegerOwn(record, 'duplicateCount'),
    missingCount: readNonNegativeIntegerOwn(record, 'missingCount'),
    unexpectedCount: readNonNegativeIntegerOwn(record, 'unexpectedCount'),
  })
}

/** Reads raw authority material and derives its exact summary digest. */
function readAuthorityCollectorResult(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationAuthoritySummary {
  const material = readAuthorityMaterial(value, false)
  requireAuthorityArithmetic(material)
  return Object.freeze({
    ...material,
    summaryDigest: createAuthoritySummaryDigest(material),
  })
}

/** Reads and validates one canonical durable-authority summary. */
function readAuthoritySummary(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationAuthoritySummary {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'expectedChainDigest',
    'expectedCount',
    'matchedCount',
    'missingCount',
    'observedChainDigest',
    'observedCount',
    'orphanCount',
    'summaryDigest',
  ])
  const material = readAuthorityMaterial(record, true)
  requireAuthorityArithmetic(material)
  const summaryDigest = readDigestOwn(record, 'summaryDigest')
  if (summaryDigest !== createAuthoritySummaryDigest(material)) {
    return failReconciliationAudit()
  }
  return Object.freeze({ ...material, summaryDigest })
}

/** Reads durable-authority comparison fields from one strict record. */
function readAuthorityMaterial(
  value: unknown,
  artifact: boolean,
): WorkspaceSearchMigrationRehearsalReconciliationAuthorityCollectorResult {
  const record = reconciliationAuditGuards.requireRecord(value)
  if (!artifact) {
    reconciliationAuditGuards.requireExactKeys(record, [
      'expectedChainDigest',
      'expectedCount',
      'matchedCount',
      'missingCount',
      'observedChainDigest',
      'observedCount',
      'orphanCount',
    ])
  }
  return Object.freeze({
    expectedChainDigest: readDigestOwn(record, 'expectedChainDigest'),
    observedChainDigest: readDigestOwn(record, 'observedChainDigest'),
    expectedCount: readNonNegativeIntegerOwn(record, 'expectedCount'),
    observedCount: readNonNegativeIntegerOwn(record, 'observedCount'),
    matchedCount: readNonNegativeIntegerOwn(record, 'matchedCount'),
    missingCount: readNonNegativeIntegerOwn(record, 'missingCount'),
    orphanCount: readNonNegativeIntegerOwn(record, 'orphanCount'),
  })
}

/** Reads raw source/target material and derives its exact summary digest. */
function readSourceTargetCollectorResult(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationSourceTargetSummary {
  const material = readSourceTargetMaterial(value, false)
  requireSourceTargetArithmetic(material)
  return Object.freeze({
    ...material,
    summaryDigest: createSourceTargetSummaryDigest(material),
  })
}

/** Reads and validates one canonical source/target summary. */
function readSourceTargetSummary(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationSourceTargetSummary {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'expectedAggregateDigest',
    'expectedCount',
    'lostCount',
    'matchedCount',
    'observedAggregateDigest',
    'observedCount',
    'summaryDigest',
    'unexpectedCount',
  ])
  const material = readSourceTargetMaterial(record, true)
  requireSourceTargetArithmetic(material)
  const summaryDigest = readDigestOwn(record, 'summaryDigest')
  if (summaryDigest !== createSourceTargetSummaryDigest(material)) {
    return failReconciliationAudit()
  }
  return Object.freeze({ ...material, summaryDigest })
}

/** Reads source/target comparison fields from one strict record. */
function readSourceTargetMaterial(
  value: unknown,
  artifact: boolean,
): WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult {
  const record = reconciliationAuditGuards.requireRecord(value)
  if (!artifact) {
    reconciliationAuditGuards.requireExactKeys(record, [
      'expectedAggregateDigest',
      'expectedCount',
      'lostCount',
      'matchedCount',
      'observedAggregateDigest',
      'observedCount',
      'unexpectedCount',
    ])
  }
  return Object.freeze({
    expectedAggregateDigest: readDigestOwn(
      record,
      'expectedAggregateDigest',
    ),
    observedAggregateDigest: readDigestOwn(
      record,
      'observedAggregateDigest',
    ),
    expectedCount: readNonNegativeIntegerOwn(record, 'expectedCount'),
    observedCount: readNonNegativeIntegerOwn(record, 'observedCount'),
    matchedCount: readNonNegativeIntegerOwn(record, 'matchedCount'),
    lostCount: readNonNegativeIntegerOwn(record, 'lostCount'),
    unexpectedCount: readNonNegativeIntegerOwn(record, 'unexpectedCount'),
  })
}

/** Strictly reads a derived #163 summary from an artifact or expectation. */
function readIntegritySummary(
  value: unknown,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  sourceTarget:
    | WorkspaceSearchMigrationRehearsalReconciliationSourceTargetSummary
    | undefined,
  targetAudits:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair | null,
  rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence | undefined,
): WorkspaceSearchMigrationRehearsalReconciliationIntegritySummary {
  const record = reconciliationAuditGuards.requireRecord(value)
  const kind = reconciliationAuditGuards.readOwn(record, 'kind')
  if (kind === 'verified-result') {
    reconciliationAuditGuards.requireExactKeys(record, [
      'completedAt',
      'failureCount',
      'kind',
      'migrationContextDigest',
      'result',
      'resultContextDigest',
      'integrityAggregateDigest',
      'status',
      'terminalRootDigest',
    ])
    if (targetAudits !== null) return failReconciliationAudit()
    const result = readRateBoundIntegrityResult(
      reconciliationAuditGuards.readOwn(record, 'result'),
    )
    if (rate !== undefined) {
      requireVerifiedIntegrityRateAndContext(result, rate, context)
    } else {
      requireIntegrityContext(result, context)
    }
    const parsed = readVerifiedIntegrityCollector(
      record,
      context,
      result,
      result.result,
    )
    const migrationContextDigest = readDigestOwn(
      record,
      'migrationContextDigest',
    )
    const resultContextDigest = readDigestOwn(
      record,
      'resultContextDigest',
    )
    if (
      parsed.migrationContextDigest !== migrationContextDigest ||
      parsed.resultContextDigest !== resultContextDigest
    ) {
      return failReconciliationAudit()
    }
    return parsed
  }
  if (kind === 'rollback-comparison') {
    reconciliationAuditGuards.requireExactKeys(record, [
      'after',
      'applyStartedAt',
      'before',
      'comparisonContextDigest',
      'comparisonDigest',
      'completedAt',
      'failureCount',
      'kind',
      'migrationContextDigest',
      'purpose',
      'startedAt',
      'status',
      'targetPreimageAggregateDigest',
      'targetPreimageStatus',
      'targetRestoredAggregateDigest',
      'terminalAt',
      'terminalRootDigest',
    ])
    if (targetAudits === null) return failReconciliationAudit()
    const parsed = readRollbackIntegrityCollector(
      record,
      context,
      sourceTarget,
      targetAudits,
    )
    if (
      parsed.migrationContextDigest !==
        readDigestOwn(record, 'migrationContextDigest')
    ) {
      return failReconciliationAudit()
    }
    return parsed
  }
  return failReconciliationAudit()
}

/** Reads and derives one verified-terminal independent #163 binding. */
function readVerifiedIntegrityCollector(
  record: object,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  result: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  reportedResult:
    WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
): WorkspaceSearchMigrationRehearsalVerifiedIntegritySummary {
  if (
    !isVerifiedScenario(context.scenario) ||
    reconciliationAuditGuards.readOwn(record, 'kind') !==
      'verified-result' ||
    reconciliationAuditGuards.readOwn(record, 'status') !== 'pass' ||
    reconciliationAuditGuards.readOwn(record, 'failureCount') !== 0
  ) {
    return failReconciliationAudit()
  }
  const completedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'completedAt'),
  )
  const terminalRootDigest = readDigestOwn(record, 'terminalRootDigest')
  const integrityAggregateDigest = readDigestOwn(
    record,
    'integrityAggregateDigest',
  )
  if (
    terminalRootDigest !== context.terminalRootDigest ||
    !sameWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
      reportedResult,
      result.result,
    ) ||
    integrityAggregateDigest !==
      result.result.integrityAggregateDigest ||
    Date.parse(result.result.runtimeProvenance.startedAt) <=
      Date.parse(context.terminalAt) ||
    Date.parse(result.result.checkedAt) <= Date.parse(context.terminalAt) ||
    Date.parse(result.result.checkedAt) > Date.parse(completedAt) ||
    Date.parse(completedAt) <= Date.parse(context.terminalAt) ||
    Date.parse(completedAt) > Date.parse(context.checkedAt)
  ) {
    return failReconciliationAudit()
  }
  const migrationContextDigest = createMigrationIntegrityContextDigest(
    context,
  )
  const fields: Omit<
    WorkspaceSearchMigrationRehearsalVerifiedIntegritySummary,
    'migrationContextDigest' | 'resultContextDigest'
  > = Object.freeze({
    kind: 'verified-result',
    status: 'pass',
    failureCount: 0,
    completedAt,
    result,
    terminalRootDigest,
    integrityAggregateDigest,
  })
  return Object.freeze({
    ...fields,
    resultContextDigest: createMigrationDigest({
      domain: verifiedIntegrityResultContextDomain,
      version: 3,
      scenario: context.scenario,
      migrationContextDigest,
      kind: fields.kind,
      status: fields.status,
      failureCount: fields.failureCount,
      completedAt: fields.completedAt,
      result: fields.result.result,
      terminalRootDigest: fields.terminalRootDigest,
      integrityAggregateDigest: fields.integrityAggregateDigest,
    }),
    migrationContextDigest,
  })
}

/** Reads and derives one rollback before/after #163 comparison binding. */
function readRollbackIntegrityCollector(
  record: object,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  sourceTarget:
    | WorkspaceSearchMigrationRehearsalReconciliationSourceTargetSummary
    | undefined,
  targetAudits:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair,
): WorkspaceSearchMigrationRehearsalRollbackIntegritySummary {
  const expectedPurpose = context.scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : context.scenario === 'complete-apply-rollback'
    ? 'complete-rollback'
    : null
  const purposeValue = reconciliationAuditGuards.readOwn(record, 'purpose')
  if (
    expectedPurpose === null ||
    purposeValue !== expectedPurpose ||
    reconciliationAuditGuards.readOwn(record, 'kind') !==
      'rollback-comparison' ||
    reconciliationAuditGuards.readOwn(record, 'status') !== 'pass' ||
    reconciliationAuditGuards.readOwn(record, 'failureCount') !== 0 ||
    reconciliationAuditGuards.readOwn(record, 'targetPreimageStatus') !==
      'equal'
  ) {
    return failReconciliationAudit()
  }
  const purpose = expectedPurpose
  const reportedStartedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'startedAt'),
  )
  const reportedApplyStartedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'applyStartedAt'),
  )
  const reportedTerminalAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'terminalAt'),
  )
  const reportedCompletedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'completedAt'),
  )
  const reportedBefore = readIntegrityResultBinding(
    reconciliationAuditGuards.readOwn(record, 'before'),
  )
  const reportedAfter = readIntegrityResultBinding(
    reconciliationAuditGuards.readOwn(record, 'after'),
  )
  const comparisonDigest = readDigestOwn(record, 'comparisonDigest')
  const comparisonContextDigest = readDigestOwn(
    record,
    'comparisonContextDigest',
  )
  const terminalRootDigest = readDigestOwn(record, 'terminalRootDigest')
  const targetPreimageAggregateDigest = readDigestOwn(
    record,
    'targetPreimageAggregateDigest',
  )
  const targetRestoredAggregateDigest = readDigestOwn(
    record,
    'targetRestoredAggregateDigest',
  )
  const terminal = targetAudits.restored.terminal
  if (terminal === null) return failReconciliationAudit()
  const before = targetAudits.preimage.integrity.result
  const after = targetAudits.restored.integrity.result
  const startedAt = before.runtimeProvenance.startedAt
  const applyStartedAt = terminal.applyStartedAt
  const terminalAt = terminal.terminalAt
  const completedAt = after.checkedAt
  if (
    terminalRootDigest !== context.terminalRootDigest ||
    reportedStartedAt !== startedAt ||
    reportedApplyStartedAt !== applyStartedAt ||
    reportedTerminalAt !== terminalAt ||
    reportedCompletedAt !== completedAt ||
    !sameWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
      reportedBefore,
      before,
    ) ||
    !sameWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
      reportedAfter,
      after,
    ) ||
    targetPreimageAggregateDigest !==
      targetAudits.preimage.aggregateDigest ||
    targetRestoredAggregateDigest !==
      targetAudits.restored.aggregateDigest ||
    targetPreimageAggregateDigest !== targetRestoredAggregateDigest ||
    (sourceTarget !== undefined &&
      (targetPreimageAggregateDigest !==
          sourceTarget.expectedAggregateDigest ||
        targetRestoredAggregateDigest !==
          sourceTarget.observedAggregateDigest)) ||
    before.contentDigest === after.contentDigest ||
    before.resultDigest === after.resultDigest ||
    before.resultMac === after.resultMac ||
    before.integrityAggregateDigest !== after.integrityAggregateDigest ||
    before.resourceIdentityScheme !== after.resourceIdentityScheme ||
    serializeCanonicalJson(before.resourceIdentities) !==
      serializeCanonicalJson(after.resourceIdentities) ||
    before.resourceIdentityDigest !== after.resourceIdentityDigest ||
    Date.parse(before.checkedAt) >= Date.parse(applyStartedAt) ||
    Date.parse(applyStartedAt) >= Date.parse(terminalAt) ||
    terminalAt !== context.terminalAt ||
    Date.parse(before.checkedAt) >= Date.parse(after.checkedAt) ||
    Date.parse(after.runtimeProvenance.startedAt) <= Date.parse(terminalAt) ||
    Date.parse(completedAt) <= Date.parse(context.terminalAt) ||
    Date.parse(completedAt) > Date.parse(context.checkedAt)
  ) {
    return failReconciliationAudit()
  }
  const expectedComparisonDigest = createMigrationDigest({
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
  const expectedComparisonContextDigest = createMigrationDigest({
    kind: rollbackIntegrityComparisonContextKind,
    version: 3,
    purpose,
    startedAt,
    applyStartedAt,
    terminalAt,
    completedAt,
    before,
    after,
    comparisonDigest,
  })
  if (
    comparisonDigest !== expectedComparisonDigest ||
    comparisonContextDigest !== expectedComparisonContextDigest
  ) {
    return failReconciliationAudit()
  }
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
    comparisonContextDigest,
    terminalRootDigest,
    targetPreimageAggregateDigest,
    targetRestoredAggregateDigest,
    targetPreimageStatus: 'equal',
    migrationContextDigest: createMigrationIntegrityContextDigest(context),
  })
}

/** Reads one exact digest-only #163 result file binding. */
function readIntegrityResultBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityResultBinding {
  try {
    return readWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
      value,
    )
  } catch {
    return failReconciliationAudit()
  }
}

/** Strictly reads one complete public rate-bound #163 projection. */
function readRateBoundIntegrityResult(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'bindingMac',
    'configurationBindingDigest',
    'interval',
    'kind',
    'policyVersion',
    'predecessor',
    'result',
    'segment',
    'tableOrderBindingMac',
    'version',
  ])
  if (
    reconciliationAuditGuards.readOwn(record, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result' ||
    reconciliationAuditGuards.readOwn(record, 'version') !== 1
  ) return failReconciliationAudit()
  const result = readIntegrityResultBinding(
    reconciliationAuditGuards.readOwn(record, 'result'),
  )
  const predecessor = readTerminalReconciliationRatePredecessor(
    reconciliationAuditGuards.readOwn(record, 'predecessor'),
  )
  const segment = readTerminalReconciliationRatePredecessor(
    reconciliationAuditGuards.readOwn(record, 'segment'),
  )
  const interval = readIntegrityRateInterval(
    reconciliationAuditGuards.readOwn(record, 'interval'),
  )
  const expectedFirstEventSequence =
    predecessor.firstEventSequence + predecessor.eventCount
  const segmentLastEventSequence =
    segment.firstEventSequence + segment.eventCount - 1
  if (
    predecessor.authenticationKeyFingerprint !==
      segment.authenticationKeyFingerprint ||
    segment.segmentOrdinal !== predecessor.segmentOrdinal + 1 ||
    segment.segmentLocatorDigest === predecessor.segmentLocatorDigest ||
    !Number.isSafeInteger(expectedFirstEventSequence) ||
    segment.firstEventSequence !== expectedFirstEventSequence ||
    segment.eventCount === 0 ||
    !Number.isSafeInteger(segmentLastEventSequence) ||
    interval.firstEventSequence < segment.firstEventSequence ||
    interval.lastEventSequence > segmentLastEventSequence ||
    Date.parse(interval.startedAt) <
      Date.parse(result.runtimeProvenance.startedAt) ||
    Date.parse(interval.completedAt) >
      Date.parse(result.runtimeProvenance.completedAt)
  ) return failReconciliationAudit()
  return Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result',
    version: 1,
    result,
    predecessor,
    segment,
    interval,
    policyVersion: readDigestOwn(record, 'policyVersion'),
    configurationBindingDigest: readDigestOwn(
      record,
      'configurationBindingDigest',
    ),
    tableOrderBindingMac: readDigestOwn(
      record,
      'tableOrderBindingMac',
    ),
    bindingMac: readDigestOwn(record, 'bindingMac'),
  })
}

/** Strictly reads one complete two-pass integrity rate interval. */
function readIntegrityRateInterval(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityRateInterval {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'attemptSequences',
    'cadenceWaitCount',
    'cadenceWaitMilliseconds',
    'completedAt',
    'describeTableCallCount',
    'eventSequences',
    'firstAttemptSequence',
    'firstEventSequence',
    'kind',
    'lastAttemptSequence',
    'lastEventSequence',
    'phase',
    'startedAt',
    'tablePassCount',
    'version',
  ])
  if (
    reconciliationAuditGuards.readOwn(record, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval' ||
    reconciliationAuditGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION ||
    reconciliationAuditGuards.readOwn(record, 'phase') !==
      'integrity-check' ||
    reconciliationAuditGuards.readOwn(record, 'tablePassCount') !== 2 ||
    reconciliationAuditGuards.readOwn(record, 'describeTableCallCount') !== 12
  ) return failReconciliationAudit()
  const attemptSequences = readIntegritySequenceVector(
    reconciliationAuditGuards.readOwn(record, 'attemptSequences'),
    12,
    12,
  )
  const eventSequences = readIntegritySequenceVector(
    reconciliationAuditGuards.readOwn(record, 'eventSequences'),
    24,
    100_000,
  )
  const firstAttemptSequence = readPositiveInteger(
    reconciliationAuditGuards.readOwn(record, 'firstAttemptSequence'),
  )
  const lastAttemptSequence = readPositiveInteger(
    reconciliationAuditGuards.readOwn(record, 'lastAttemptSequence'),
  )
  const firstEventSequence = readPositiveInteger(
    reconciliationAuditGuards.readOwn(record, 'firstEventSequence'),
  )
  const lastEventSequence = readPositiveInteger(
    reconciliationAuditGuards.readOwn(record, 'lastEventSequence'),
  )
  const cadenceWaitCount = readNonNegativeInteger(
    reconciliationAuditGuards.readOwn(record, 'cadenceWaitCount'),
  )
  const cadenceWaitMilliseconds = readNonNegativeInteger(
    reconciliationAuditGuards.readOwn(record, 'cadenceWaitMilliseconds'),
  )
  const startedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'startedAt'),
  )
  const completedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'completedAt'),
  )
  if (
    firstAttemptSequence !== attemptSequences[0] ||
    lastAttemptSequence !== attemptSequences.at(-1) ||
    attemptSequences.some((sequence, index) =>
      index > 0 && sequence !== (attemptSequences[index - 1] ?? 0) + 1) ||
    eventSequences.length !== 24 + cadenceWaitCount ||
    firstEventSequence !== eventSequences[0] ||
    lastEventSequence !== eventSequences.at(-1) ||
    eventSequences.some((sequence, index) =>
      index > 0 && sequence !== (eventSequences[index - 1] ?? 0) + 1) ||
    (cadenceWaitCount === 0) !== (cadenceWaitMilliseconds === 0) ||
    Date.parse(startedAt) > Date.parse(completedAt)
  ) return failReconciliationAudit()
  return Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval',
    version:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION,
    phase: 'integrity-check',
    tablePassCount: 2,
    describeTableCallCount: 12,
    firstAttemptSequence,
    lastAttemptSequence,
    attemptSequences,
    firstEventSequence,
    lastEventSequence,
    eventSequences,
    cadenceWaitCount,
    cadenceWaitMilliseconds,
    startedAt,
    completedAt,
  })
}

/** Reads one exact dense positive-integer sequence vector. */
function readIntegritySequenceVector(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): readonly number[] {
  if (
    nodeUtilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) return failReconciliationAudit()
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  const length: unknown = lengthDescriptor?.value
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < minimumLength ||
    length > maximumLength
  ) return failReconciliationAudit()
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== length + 1 || ownKeys[length] !== 'length') {
    return failReconciliationAudit()
  }
  const sequences: number[] = []
  for (let index = 0; index < length; index += 1) {
    if (ownKeys[index] !== String(index)) return failReconciliationAudit()
    sequences.push(readPositiveInteger(
      reconciliationAuditGuards.readOwn(value, String(index)),
    ))
  }
  return Object.freeze(sequences)
}

/** Requires a full live result to match the parent terminal context. */
function requireIntegrityContext(
  integrity: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
): void {
  if (
    integrity.configurationBindingDigest !==
      context.configurationBindingDigest ||
    integrity.policyVersion !== context.policyVersion ||
    integrity.result.resourceIdentityDigest !==
      context.integrityResourceIdentityDigest
  ) return failReconciliationAudit()
}

/** Requires verified #163 calls to be the reconciliation audit rate segment. */
function requireVerifiedIntegrityRateAndContext(
  integrity: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
): void {
  requireIntegrityContext(integrity, context)
  if (
    !sameVerifiedRateSegment(integrity.predecessor, rate.predecessor) ||
    !sameVerifiedRateSegment(integrity.segment, rate.successor) ||
    Date.parse(integrity.result.runtimeProvenance.startedAt) <=
      Date.parse(context.terminalAt) ||
    Date.parse(integrity.result.checkedAt) > Date.parse(context.checkedAt)
  ) return failReconciliationAudit()
}

/** Requires one embedded full #163 result to retain its runtime-key HMAC. */
function requireIntegrityRuntimeBinding(
  integrity: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  runtimeKey: Uint8Array,
): void {
  const expectedKeyFingerprint =
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      runtimeKey,
    )
  if (
    integrity.predecessor.authenticationKeyFingerprint !==
      expectedKeyFingerprint ||
    integrity.segment.authenticationKeyFingerprint !==
      expectedKeyFingerprint ||
    !safeDigestEqual(
      integrity.bindingMac,
      createIntegrityBindingMac(integrity, runtimeKey),
    )
  ) return failReconciliationAudit()
}

/** Requires both rollback target results to retain runtime-key HMACs. */
function requireTargetIntegrityRuntimeBindings(
  targetAudits:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPair,
  runtimeKey: Uint8Array,
): void {
  requireIntegrityRuntimeBinding(targetAudits.preimage.integrity, runtimeKey)
  requireIntegrityRuntimeBinding(targetAudits.restored.integrity, runtimeKey)
}

/** Requires every scenario-authoritative embedded #163 HMAC in one document. */
function requireDocumentIntegrityRuntimeBindings(
  document: ReconciliationAuditDocument,
  runtimeKey: Uint8Array,
): void {
  if (document.integrity.kind === 'verified-result') {
    requireIntegrityRuntimeBinding(document.integrity.result, runtimeKey)
    return
  }
  if (document.targetAudits === null) return failReconciliationAudit()
  requireTargetIntegrityRuntimeBindings(document.targetAudits, runtimeKey)
}

/** Recomputes one embedded rate-bound result HMAC. */
function createIntegrityBindingMac(
  integrity: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  runtimeKey: Uint8Array,
): string {
  const claims = Object.freeze({
    kind: integrity.kind,
    version: integrity.version,
    result: integrity.result,
    predecessor: integrity.predecessor,
    segment: integrity.segment,
    interval: integrity.interval,
    policyVersion: integrity.policyVersion,
    configurationBindingDigest: integrity.configurationBindingDigest,
    tableOrderBindingMac: integrity.tableOrderBindingMac,
  })
  return createHmac('sha256', runtimeKey)
    .update(reconciliationIntegrityBindingMacDomain, 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/** Compares every field of two authenticated rate summaries exactly. */
function sameVerifiedRateSegment(
  left: WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
  right: WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
): boolean {
  return left.authenticationKeyFingerprint ===
      right.authenticationKeyFingerprint &&
    left.segmentLocatorDigest === right.segmentLocatorDigest &&
    left.segmentOrdinal === right.segmentOrdinal &&
    left.firstEventSequence === right.firstEventSequence &&
    left.eventCount === right.eventCount &&
    left.firstCommittedEventSequence ===
      right.firstCommittedEventSequence &&
    left.lastCommittedEventSequence === right.lastCommittedEventSequence &&
    left.terminalRecordMac === right.terminalRecordMac &&
    left.segmentDigest === right.segmentDigest
}

/** Strictly reads one parent-authenticated target planning context. */
function readTargetAuditContext(
  value: unknown,
): WorkspaceSearchMigrationRehearsalTargetAuditContext {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'configurationBindingDigest',
    'executionBoundaryDigest',
    'integrityResourceIdentityDigest',
    'manifestDigest',
    'permitDigest',
    'planDigest',
    'planningReceiptDigest',
    'policyVersion',
    'requestedResourcesBinding',
    'runLocatorDigest',
    'scenario',
    'sealedPlanningAuthorityDigest',
    'writerFenceDigest',
  ])
  const scenario = reconciliationAuditGuards.readOwn(record, 'scenario')
  if (
    scenario !== 'complete-apply-rollback' &&
    scenario !== 'partial-apply-rollback'
  ) return failReconciliationAudit()
  return Object.freeze({
    scenario,
    runLocatorDigest: readDigestOwn(record, 'runLocatorDigest'),
    manifestDigest: readDigestOwn(record, 'manifestDigest'),
    permitDigest: readDigestOwn(record, 'permitDigest'),
    requestedResourcesBinding: readDigestOwn(
      record,
      'requestedResourcesBinding',
    ),
    configurationBindingDigest: readDigestOwn(
      record,
      'configurationBindingDigest',
    ),
    policyVersion: readDigestOwn(record, 'policyVersion'),
    integrityResourceIdentityDigest: readDigestOwn(
      record,
      'integrityResourceIdentityDigest',
    ),
    planningReceiptDigest: readDigestOwn(record, 'planningReceiptDigest'),
    executionBoundaryDigest: readDigestOwn(record, 'executionBoundaryDigest'),
    sealedPlanningAuthorityDigest: readDigestOwn(
      record,
      'sealedPlanningAuthorityDigest',
    ),
    planDigest: readDigestOwn(record, 'planDigest'),
    writerFenceDigest: readDigestOwn(record, 'writerFenceDigest'),
  })
}

/** Strictly reads one purpose-bound rollback terminal or preimage null. */
function readTargetAuditTerminal(
  value: unknown,
  purpose:
    | 'complete-rollback-preimage'
    | 'complete-rollback-restored'
    | 'partial-rollback-preimage'
    | 'partial-rollback-restored',
): WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null {
  const preimage = purpose === 'complete-rollback-preimage' ||
    purpose === 'partial-rollback-preimage'
  if (preimage) {
    if (value !== null) return failReconciliationAudit()
    return null
  }
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'applyStartedAt',
    'kind',
    'rootDigest',
    'scenario',
    'terminalAt',
    'version',
  ])
  const partial = purpose === 'partial-rollback-restored'
  const scenario = partial
    ? 'partial-apply-rollback'
    : 'complete-apply-rollback'
  const version = partial ? 2 : 1
  if (
    reconciliationAuditGuards.readOwn(record, 'scenario') !== scenario ||
    reconciliationAuditGuards.readOwn(record, 'kind') !== 'rolled-back' ||
    reconciliationAuditGuards.readOwn(record, 'version') !== version
  ) return failReconciliationAudit()
  const rootDigest = readDigestOwn(record, 'rootDigest')
  const applyStartedAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'applyStartedAt'),
  )
  const terminalAt = reconciliationAuditGuards.readTimestamp(
    reconciliationAuditGuards.readOwn(record, 'terminalAt'),
  )
  if (partial) {
    return Object.freeze({
      scenario: 'partial-apply-rollback',
      kind: 'rolled-back',
      version: 2,
      rootDigest,
      applyStartedAt,
      terminalAt,
    })
  }
  return Object.freeze({
    scenario: 'complete-apply-rollback',
    kind: 'rolled-back',
    version: 1,
    rootDigest,
    applyStartedAt,
    terminalAt,
  })
}

/** Creates the exact migration context digest shared with #163 evidence. */
function createMigrationIntegrityContextDigest(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
): string {
  return createMigrationDigest({
    kind: migrationIntegrityContextKind,
    version: 3,
    ...context,
  })
}

/** Returns whether one scenario requires a verified-root #163 result. */
function isVerifiedScenario(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
): scenario is WorkspaceSearchMigrationRehearsalVerifiedReconciliationScenario {
  return scenario !== 'partial-apply-rollback' &&
    scenario !== 'complete-apply-rollback'
}

/** Enforces all marker counts, seal count, and aggregate equalities. */
function requireMarkerArithmetic(
  material:
    WorkspaceSearchMigrationRehearsalReconciliationMarkerCollectorResult,
  appliedOperationCount: number,
): void {
  const expectedCount = addCounts(
    material.matchedCount,
    material.missingCount,
  )
  const observedCount = addCounts(
    material.matchedCount,
    material.duplicateCount,
    material.unexpectedCount,
  )
  const discrepancyCount = addCounts(
    material.duplicateCount,
    material.missingCount,
    material.unexpectedCount,
  )
  if (
    material.expectedCount !== appliedOperationCount ||
    material.expectedCount !== expectedCount ||
    material.observedCount !== observedCount ||
    (discrepancyCount === 0) !==
      (material.expectedAggregateDigest ===
        material.observedAggregateDigest)
  ) {
    return failReconciliationAudit()
  }
}

/** Enforces durable-authority set arithmetic and aggregate equality. */
function requireAuthorityArithmetic(
  material:
    WorkspaceSearchMigrationRehearsalReconciliationAuthorityCollectorResult,
): void {
  const expectedCount = addCounts(
    material.matchedCount,
    material.missingCount,
  )
  const observedCount = addCounts(
    material.matchedCount,
    material.orphanCount,
  )
  const discrepancyCount = addCounts(
    material.missingCount,
    material.orphanCount,
  )
  if (
    material.expectedCount !== expectedCount ||
    material.observedCount !== observedCount ||
    (discrepancyCount === 0) !==
      (material.expectedChainDigest === material.observedChainDigest)
  ) {
    return failReconciliationAudit()
  }
}

/** Enforces source/target set arithmetic and aggregate equality. */
function requireSourceTargetArithmetic(
  material:
    WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult,
): void {
  const expectedCount = addCounts(
    material.matchedCount,
    material.lostCount,
  )
  const observedCount = addCounts(
    material.matchedCount,
    material.unexpectedCount,
  )
  const discrepancyCount = addCounts(
    material.lostCount,
    material.unexpectedCount,
  )
  if (
    material.expectedCount !== expectedCount ||
    material.observedCount !== observedCount ||
    (discrepancyCount === 0) !==
      (material.expectedAggregateDigest ===
        material.observedAggregateDigest)
  ) {
    return failReconciliationAudit()
  }
}

/** Requires scenario-specific root semantics and complete/prefix counts. */
function requireScenarioTerminal(
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  terminalRootKind: 'rolled-back' | 'verified',
  terminalRootVersion: 1 | 2,
  sealedPlanOperationCount: number,
  appliedOperationCount: number,
): void {
  if (appliedOperationCount > sealedPlanOperationCount) {
    return failReconciliationAudit()
  }
  if (scenario === 'partial-apply-rollback') {
    if (
      terminalRootKind !== 'rolled-back' ||
      terminalRootVersion !== 2 ||
      appliedOperationCount <= 0 ||
      appliedOperationCount >= sealedPlanOperationCount
    ) {
      return failReconciliationAudit()
    }
    return
  }
  if (scenario === 'complete-apply-rollback') {
    if (
      terminalRootKind !== 'rolled-back' ||
      terminalRootVersion !== 1 ||
      appliedOperationCount !== sealedPlanOperationCount
    ) {
      return failReconciliationAudit()
    }
    return
  }
  if (
    terminalRootKind !== 'verified' ||
    terminalRootVersion !== 1 ||
    appliedOperationCount !== sealedPlanOperationCount
  ) {
    return failReconciliationAudit()
  }
}

/** Derives whether the marker expectation is a full plan or strict prefix. */
function deriveMarkerSealKind(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
): WorkspaceSearchMigrationRehearsalReconciliationMarkerSealKind {
  return context.appliedOperationCount === context.sealedPlanOperationCount
    ? 'complete-plan'
    : 'committed-prefix'
}

/** Creates the context-bound expected marker seal digest. */
function createMarkerSealBindingDigest(
  context: WorkspaceSearchMigrationRehearsalReconciliationCoreContext,
  expectedSealKind:
    WorkspaceSearchMigrationRehearsalReconciliationMarkerSealKind,
  expectedCount: number,
  expectedAggregateDigest: string,
): string {
  return createMigrationDigest({
    domain: markerSealBindingDomain,
    scenario: context.scenario,
    runLocatorDigest: context.runLocatorDigest,
    sealedPlanningAuthorityDigest:
      context.sealedPlanningAuthorityDigest,
    executionRunDigest: context.executionRunDigest,
    planDigest: context.planDigest,
    applyBoundaryDigest: context.applyBoundaryDigest,
    expectedSealKind,
    expectedCount,
    expectedAggregateDigest,
  })
}

/** Creates the digest of every exact marker summary field. */
function createMarkerSummaryDigest(
  material: Omit<
    WorkspaceSearchMigrationRehearsalReconciliationMarkerSummary,
    'summaryDigest'
  >,
): string {
  return createMigrationDigest({
    domain: markerSummaryDomain,
    ...material,
  })
}

/** Creates the digest of every exact durable-authority summary field. */
function createAuthoritySummaryDigest(
  material:
    WorkspaceSearchMigrationRehearsalReconciliationAuthorityCollectorResult,
): string {
  return createMigrationDigest({
    domain: authoritySummaryDomain,
    ...material,
  })
}

/** Creates the digest of every exact source/target summary field. */
function createSourceTargetSummaryDigest(
  material:
    WorkspaceSearchMigrationRehearsalReconciliationSourceTargetCollectorResult,
): string {
  return createMigrationDigest({
    domain: sourceTargetSummaryDomain,
    ...material,
  })
}

/** Reads exact whole-document HMAC metadata. */
function readReconciliationAuditAuthentication(
  value: unknown,
): ReconciliationAuditAuthentication {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
    'algorithm',
    'publicationKeyFingerprint',
    'publicationMac',
    'runtimeKeyFingerprint',
    'runtimeMac',
  ])
  if (
    reconciliationAuditGuards.readOwn(record, 'algorithm') !==
      'HMAC-SHA-256'
  ) {
    return failReconciliationAudit()
  }
  return Object.freeze({
    algorithm: 'HMAC-SHA-256',
    runtimeKeyFingerprint: readDigestOwn(
      record,
      'runtimeKeyFingerprint',
    ),
    runtimeMac: readDigestOwn(record, 'runtimeMac'),
    publicationKeyFingerprint: readDigestOwn(
      record,
      'publicationKeyFingerprint',
    ),
    publicationMac: readDigestOwn(record, 'publicationMac'),
  })
}

/** Recreates the exact projection covered by the runtime semantic HMAC. */
function createRuntimeUnsignedReconciliationAuditDocument(
  document: ReconciliationAuditDocument,
): RuntimeUnsignedReconciliationAuditDocument {
  return Object.freeze({
    ...createReconciliationAuditMacFields(document),
    authentication: Object.freeze({
      algorithm: document.authentication.algorithm,
      runtimeKeyFingerprint:
        document.authentication.runtimeKeyFingerprint,
    }),
  })
}

/** Recreates the exact projection covered by the parent publication HMAC. */
function createPublicationUnsignedReconciliationAuditDocument(
  document: ReconciliationAuditDocument,
): PublicationUnsignedReconciliationAuditDocument {
  return Object.freeze({
    ...createReconciliationAuditMacFields(document),
    authentication: Object.freeze({
      algorithm: document.authentication.algorithm,
      runtimeKeyFingerprint:
        document.authentication.runtimeKeyFingerprint,
      runtimeMac: document.authentication.runtimeMac,
      publicationKeyFingerprint:
        document.authentication.publicationKeyFingerprint,
    }),
  })
}

/** Selects every non-authentication field covered by both audit HMACs. */
function createReconciliationAuditMacFields(
  document: ReconciliationAuditDocument,
): Omit<ReconciliationAuditDocument, 'authentication'> {
  const { authentication: _authentication, ...fields } = document
  return fields
}

/** Creates one secret-free binding from a fully authenticated artifact. */
function createReconciliationAuditBinding(
  artifact: AuthenticatedReconciliationAuditArtifact,
): WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding {
  const document = artifact.document
  return Object.freeze({
    scenario: document.scenario,
    runLocatorDigest: document.runLocatorDigest,
    configurationBindingDigest: document.configurationBindingDigest,
    policyVersion: document.policyVersion,
    integrityResourceIdentityDigest:
      document.integrityResourceIdentityDigest,
    sealedPlanningAuthorityDigest:
      document.sealedPlanningAuthorityDigest,
    executionRunDigest: document.executionRunDigest,
    integrity: document.integrity,
    targetAudits: document.targetAudits,
    planDigest: document.planDigest,
    applyBoundaryDigest: document.applyBoundaryDigest,
    terminalRootKind: document.terminalRootKind,
    terminalRootVersion: document.terminalRootVersion,
    terminalRootDigest: document.terminalRootDigest,
    sealedPlanOperationCount: document.sealedPlanOperationCount,
    appliedOperationCount: document.appliedOperationCount,
    terminalAt: document.terminalAt,
    checkedAt: document.checkedAt,
    contentDigest: artifact.contentDigest,
    byteLength: artifact.byteLength,
    markerSummary: document.markerSummary,
    authoritySummary: document.authoritySummary,
    sourceTargetSummary: document.sourceTargetSummary,
    rate: document.rate,
    duplicateApplyCount: document.duplicateApplyCount,
    lostItemCount: document.lostItemCount,
    orphanAuthorityCount: document.orphanAuthorityCount,
    auditDigest: document.auditDigest,
  })
}

/** Compares every trusted context field exactly. */
function sameReconciliationAuditContext(
  left: WorkspaceSearchMigrationRehearsalReconciliationAuditContext,
  right: WorkspaceSearchMigrationRehearsalReconciliationAuditContext,
): boolean {
  return left.scenario === right.scenario &&
    left.runLocatorDigest === right.runLocatorDigest &&
    left.configurationBindingDigest === right.configurationBindingDigest &&
    left.policyVersion === right.policyVersion &&
    left.integrityResourceIdentityDigest ===
      right.integrityResourceIdentityDigest &&
    left.sealedPlanningAuthorityDigest ===
      right.sealedPlanningAuthorityDigest &&
    left.executionRunDigest === right.executionRunDigest &&
    createMigrationDigest(left.integrity) ===
      createMigrationDigest(right.integrity) &&
    createMigrationDigest(left.targetAudits) ===
      createMigrationDigest(right.targetAudits) &&
    left.planDigest === right.planDigest &&
    left.applyBoundaryDigest === right.applyBoundaryDigest &&
    left.terminalRootKind === right.terminalRootKind &&
    left.terminalRootVersion === right.terminalRootVersion &&
    left.terminalRootDigest === right.terminalRootDigest &&
    left.sealedPlanOperationCount === right.sealedPlanOperationCount &&
    left.appliedOperationCount === right.appliedOperationCount &&
    left.terminalAt === right.terminalAt &&
    left.checkedAt === right.checkedAt
}

/** Creates the exact derived authentication context from a semantic document. */
function createContextFromSemanticDocument(
  document: ReconciliationAuditSemanticDocument,
): WorkspaceSearchMigrationRehearsalReconciliationAuditContext {
  return Object.freeze({
    scenario: document.scenario,
    runLocatorDigest: document.runLocatorDigest,
    configurationBindingDigest: document.configurationBindingDigest,
    policyVersion: document.policyVersion,
    integrityResourceIdentityDigest:
      document.integrityResourceIdentityDigest,
    sealedPlanningAuthorityDigest:
      document.sealedPlanningAuthorityDigest,
    executionRunDigest: document.executionRunDigest,
    planDigest: document.planDigest,
    applyBoundaryDigest: document.applyBoundaryDigest,
    terminalRootKind: document.terminalRootKind,
    terminalRootVersion: document.terminalRootVersion,
    terminalRootDigest: document.terminalRootDigest,
    sealedPlanOperationCount: document.sealedPlanOperationCount,
    appliedOperationCount: document.appliedOperationCount,
    terminalAt: document.terminalAt,
    checkedAt: document.checkedAt,
    integrity: document.integrity,
    targetAudits: document.targetAudits,
  })
}

/** Requires runtime and parent publication authority to use distinct keys. */
function requireDistinctReconciliationAuditKeys(
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): void {
  if (timingSafeEqual(runtimeKey, publicationKey)) {
    return failReconciliationAudit()
  }
}

/** Creates the domain-separated fingerprint of the runtime HMAC key. */
function createReconciliationAuditRuntimeKeyFingerprint(
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(reconciliationAuditRuntimeKeyFingerprintDomain, 'utf8')
    .digest('hex')
}

/** Creates the runtime HMAC over one complete semantic audit projection. */
function createReconciliationAuditRuntimeMac(
  document: RuntimeUnsignedReconciliationAuditDocument,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(reconciliationAuditRuntimeMacDomain, 'utf8')
    .update(serializeCanonicalJson(document), 'utf8')
    .digest('hex')
}

/** Creates the domain-separated parent publication-key fingerprint. */
function createReconciliationAuditPublicationKeyFingerprint(
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(reconciliationAuditPublicationKeyFingerprintDomain, 'utf8')
    .digest('hex')
}

/** Creates the parent HMAC over the complete runtime-authenticated audit. */
function createReconciliationAuditPublicationMac(
  document: PublicationUnsignedReconciliationAuditDocument,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(reconciliationAuditPublicationMacDomain, 'utf8')
    .update(serializeCanonicalJson(document), 'utf8')
    .digest('hex')
}

/** Reads an exact ordinary eight-element expectation array. */
function readExactBatch(
  value: unknown,
): readonly WorkspaceSearchMigrationRehearsalReconciliationArtifactExpectation[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return failReconciliationAudit()
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    lengthDescriptor.value !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS.length
  ) {
    return failReconciliationAudit()
  }
  const ownKeys = Reflect.ownKeys(value)
  const expectedOwnKeyCount =
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS.length +
    1
  if (
    ownKeys.length !== expectedOwnKeyCount ||
    ownKeys.some((key) =>
      typeof key !== 'string' ||
      (key !== 'length' && !/^(?:0|[1-7])$/u.test(key)))
  ) {
    return failReconciliationAudit()
  }
  const artifacts:
    WorkspaceSearchMigrationRehearsalReconciliationArtifactExpectation[] =
      []
  for (
    let index = 0;
    index <
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_SCENARIOS.length;
    index += 1
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      String(index),
    )
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failReconciliationAudit()
    }
    const record = reconciliationAuditGuards.requireRecord(descriptor.value)
    reconciliationAuditGuards.requireExactKeys(record, [
      'artifactBytes',
      'expectedContext',
    ])
    artifacts.push(Object.freeze({
      artifactBytes: copyReconciliationAuditBytes(
        reconciliationAuditGuards.readOwn(record, 'artifactBytes'),
      ),
      expectedContext: readReconciliationAuditContext(
        reconciliationAuditGuards.readOwn(record, 'expectedContext'),
      ),
    }))
  }
  return Object.freeze(artifacts)
}

/** Rejects replayed files, runs, roots, rate segments, or #163 results. */
function requireUniqueBatchBindings(
  bindings:
    readonly WorkspaceSearchMigrationRehearsalReconciliationAuditArtifactBinding[],
): void {
  const contentDigests = new Set<string>()
  const auditDigests = new Set<string>()
  const runDigests = new Set<string>()
  const executionDigests = new Set<string>()
  const rootDigests = new Set<string>()
  const integrityResultDigests = new Set<string>()
  const rateSuccessorDigests = new Set<string>()
  const rateSuccessorLocators = new Set<string>()
  const rateKeyFingerprints = new Set<string>()
  const targetContentDigests = new Set<string>()
  const targetObservationDigests = new Set<string>()
  const targetContextDigests = new Set<string>()
  let integrityResultCount = 0
  let targetAuditCount = 0
  for (const binding of bindings) {
    contentDigests.add(binding.contentDigest)
    auditDigests.add(binding.auditDigest)
    runDigests.add(binding.runLocatorDigest)
    executionDigests.add(binding.executionRunDigest)
    rootDigests.add(binding.terminalRootDigest)
    rateSuccessorDigests.add(binding.rate.successor.segmentDigest)
    rateSuccessorLocators.add(
      binding.rate.successor.segmentLocatorDigest,
    )
    rateKeyFingerprints.add(binding.rate.authenticationKeyFingerprint)
    if (binding.targetAudits !== null) {
      for (const target of [
        binding.targetAudits.preimage,
        binding.targetAudits.restored,
      ]) {
        targetAuditCount += 1
        targetContentDigests.add(target.contentDigest)
        targetObservationDigests.add(target.observationDigest)
        targetContextDigests.add(target.contextDigest)
        rateSuccessorDigests.add(target.rate.successor.segmentDigest)
        rateSuccessorLocators.add(
          target.rate.successor.segmentLocatorDigest,
        )
        rateKeyFingerprints.add(target.rate.authenticationKeyFingerprint)
      }
    }
    if (binding.integrity.kind === 'verified-result') {
      integrityResultDigests.add(
        binding.integrity.result.result.resultDigest,
      )
      integrityResultCount += 1
    } else {
      integrityResultDigests.add(binding.integrity.before.resultDigest)
      integrityResultDigests.add(binding.integrity.after.resultDigest)
      integrityResultCount += 2
    }
  }
  if (
    contentDigests.size !== bindings.length ||
    auditDigests.size !== bindings.length ||
    runDigests.size !== bindings.length ||
    executionDigests.size !== bindings.length ||
    rootDigests.size !== bindings.length ||
    targetAuditCount !== 4 ||
    targetContentDigests.size !== 4 ||
    targetObservationDigests.size !== 4 ||
    targetContextDigests.size !== 2 ||
    rateSuccessorDigests.size !== bindings.length + targetAuditCount ||
    rateSuccessorLocators.size !== bindings.length + targetAuditCount ||
    rateKeyFingerprints.size !== 1 ||
    integrityResultDigests.size !== integrityResultCount
  ) {
    return failReconciliationAudit()
  }
}

/** Reads one exact canonical scenario label. */
function readScenario(
  value: unknown,
): WorkspaceSearchMigrationRehearsalScenarioName {
  if (
    value === 'happy-path-verified' ||
    value === 'cursor-before-commit-kill' ||
    value === 'cursor-after-commit-kill' ||
    value === 'artifact-before-checkpoint-kill' ||
    value === 'transaction-response-loss' ||
    value === 'lease-expiry-takeover' ||
    value === 'partial-apply-rollback' ||
    value === 'complete-apply-rollback'
  ) {
    return value
  }
  return failReconciliationAudit()
}

/** Reads one exact terminal root classification. */
function readTerminalRootKind(
  value: unknown,
): 'rolled-back' | 'verified' {
  if (value === 'rolled-back' || value === 'verified') return value
  return failReconciliationAudit()
}

/** Reads one exact terminal persistence version. */
function readTerminalRootVersion(value: unknown): 1 | 2 {
  if (value === 1 || value === 2) return value
  return failReconciliationAudit()
}

/** Reads one exact marker seal classification. */
function readMarkerSealKind(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationMarkerSealKind {
  if (value === 'complete-plan' || value === 'committed-prefix') {
    return value
  }
  return failReconciliationAudit()
}

/** Reads one conventional SHA-256 digest from an own data property. */
function readDigestOwn(record: object, key: string): string {
  return reconciliationAuditGuards.readDigest(
    reconciliationAuditGuards.readOwn(record, key),
  )
}

/** Reads one exact authenticated rate predecessor supplied by the parent. */
function readTerminalReconciliationRatePredecessor(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const record = reconciliationAuditGuards.requireRecord(value)
  reconciliationAuditGuards.requireExactKeys(record, [
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
  const eventCount = readNonNegativeIntegerOwn(record, 'eventCount')
  const firstValue = reconciliationAuditGuards.readOwn(
    record,
    'firstCommittedEventSequence',
  )
  const lastValue = reconciliationAuditGuards.readOwn(
    record,
    'lastCommittedEventSequence',
  )
  const firstCommittedEventSequence = firstValue === null
    ? null
    : readPositiveInteger(firstValue)
  const lastCommittedEventSequence = lastValue === null
    ? null
    : readPositiveInteger(lastValue)
  const firstEventSequence = readPositiveInteger(
    reconciliationAuditGuards.readOwn(record, 'firstEventSequence'),
  )
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
    return failReconciliationAudit()
  }
  return Object.freeze({
    authenticationKeyFingerprint: readDigestOwn(
      record,
      'authenticationKeyFingerprint',
    ),
    segmentLocatorDigest: readDigestOwn(record, 'segmentLocatorDigest'),
    segmentOrdinal: readNonNegativeIntegerOwn(record, 'segmentOrdinal'),
    firstEventSequence,
    eventCount,
    firstCommittedEventSequence,
    lastCommittedEventSequence,
    terminalRecordMac: readDigestOwn(record, 'terminalRecordMac'),
    segmentDigest: readDigestOwn(record, 'segmentDigest'),
  })
}

/** Reads one nonnegative safe integer from an own data property. */
function readNonNegativeIntegerOwn(record: object, key: string): number {
  return readNonNegativeInteger(
    reconciliationAuditGuards.readOwn(record, key),
  )
}

/** Reads one nonnegative safe integer. */
function readNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    return failReconciliationAudit()
  }
  return value
}

/** Reads one positive safe integer. */
function readPositiveInteger(value: unknown): number {
  const parsed = readNonNegativeInteger(value)
  if (parsed === 0) return failReconciliationAudit()
  return parsed
}

/** Adds bounded counters without admitting safe-integer overflow. */
function addCounts(...values: readonly number[]): number {
  let total = 0
  for (const value of values) {
    total += value
    if (!Number.isSafeInteger(total)) return failReconciliationAudit()
  }
  return total
}

/** Copies one exact ordinary 32-byte authentication key. */
function copyReconciliationAuditKey(value: unknown): Uint8Array {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(
      reconciliationAuditGuards.readIntrinsicBuffer(value),
    ) ||
    reconciliationAuditGuards.readIntrinsicByteLength(value) !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_KEY_BYTES
  ) {
    return failReconciliationAudit()
  }
  const copy = new Uint8Array(
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_KEY_BYTES,
  )
  try {
    Reflect.apply(Uint8Array.prototype.set, copy, [value])
  } catch {
    zeroizeBytes(copy)
    return failReconciliationAudit()
  }
  return copy
}

/** Copies one exact bounded canonical artifact without retaining aliases. */
function copyReconciliationAuditBytes(value: unknown): Uint8Array {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failReconciliationAudit()
  }
  const buffer = reconciliationAuditGuards.readIntrinsicBuffer(value)
  const byteLength =
    reconciliationAuditGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RECONCILIATION_AUDIT_MAX_BYTES
  ) {
    return failReconciliationAudit()
  }
  const copy = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copy, [value])
  } catch {
    zeroizeBytes(copy)
    return failReconciliationAudit()
  }
  return copy
}

/** Compares two fixed-size lowercase digests without timing leakage. */
function safeDigestEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Best-effort overwrites one invocation-owned byte buffer. */
function zeroizeBytes(value: Uint8Array | undefined): void {
  if (value === undefined || nodeUtilTypes.isProxy(value)) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // The stable outer boundary rejects malformed caller-owned values.
  }
}

/** Replaces every lower-level failure with this module's stable boundary. */
function replaceReconciliationAuditFailure(error: unknown): never {
  if (
    error instanceof
      WorkspaceSearchMigrationRehearsalReconciliationAuditError
  ) {
    throw error
  }
  return failReconciliationAudit()
}

/** Raises the sole stable raw-value-free reconciliation-audit failure. */
function failReconciliationAudit(): never {
  throw new WorkspaceSearchMigrationRehearsalReconciliationAuditError()
}
