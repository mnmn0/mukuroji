import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import { createAttributeMapDigest } from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  createWorkspaceSearchConfigurationHash,
  isHexDigest,
  serializeCanonicalJson,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationFailureCode,
  WorkspaceSearchMigrationFailure,
} from './migration-contract'
import {
  readWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
  type WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
} from './migration-rehearsal-integrity-evidence'
import {
  consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION,
  type WorkspaceSearchMigrationRehearsalIntegrityRateInterval,
  type WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
} from './migration-rehearsal-integrity-rate-evidence'
import type {
  WorkspaceSearchMigrationRehearsalEvidenceSessionBinding,
} from './migration-rehearsal-evidence-aws'
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
import {
  createEmptyWorkspaceSearchMigrationTargetScanCheckpoint,
  type WorkspaceSearchMigrationTargetScanCheckpoint,
  type WorkspaceSearchMigrationTargetScanContextInput,
  validateWorkspaceSearchMigrationTargetScanCheckpoint,
} from './migration-target-scan-context'
import type {
  WorkspaceSearchMigrationTargetScanPageResult,
} from './migration-target-scan-page'

/** Stable discriminator for one authenticated target-audit artifact. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND =
  'mukuroji-workspace-search-migration-rehearsal-target-audit'

/** Dual-authenticated rate-bound four-artifact target-audit contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION = 4

/** Maximum exact canonical bytes accepted for one target-audit artifact. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES =
  256 * 1_024

/** Hard ceiling for one complete target audit, including all page reads. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_DURATION_MILLISECONDS =
  15 * 60 * 1_000

/** Hard ceiling for bounded target pages in one independent audit. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_PAGES =
  100_000

/** Finite semantic purpose owned by one target audit. */
export type WorkspaceSearchMigrationRehearsalTargetAuditPurpose =
  | 'complete-rollback-preimage'
  | 'complete-rollback-restored'
  | 'partial-rollback-preimage'
  | 'partial-rollback-restored'

/** Parent-authenticated scenario and planning identity for one target audit. */
export type WorkspaceSearchMigrationRehearsalTargetAuditContext = {
  /** Exact isolated rollback scenario selected by the stage manifest. */
  readonly scenario:
    | 'complete-apply-rollback'
    | 'partial-apply-rollback'
  /** Domain-separated locator of the restricted scenario run identifier. */
  readonly runLocatorDigest: string
  /** Digest of the exact authenticated rehearsal manifest. */
  readonly manifestDigest: string
  /** Digest of the exact authenticated non-production permit. */
  readonly permitDigest: string
  /** Exact permit-approved resource selection binding. */
  readonly requestedResourcesBinding: string
  /** Digest of the measured configuration and resource generation. */
  readonly configurationBindingDigest: string
  /** Reviewed DescribeTable policy digest shared by live and audit evidence. */
  readonly policyVersion: string
  /** Permit-authenticated immutable #163 resource-identity digest. */
  readonly integrityResourceIdentityDigest: string
  /** Digest of the exact prospective or committed close-replan receipt. */
  readonly planningReceiptDigest: string
  /** Digest of the admitted closed-fence execution boundary. */
  readonly executionBoundaryDigest: string
  /** Digest of the immutable sealed planning authority. */
  readonly sealedPlanningAuthorityDigest: string
  /** Merkle root of the exact ordered plan. */
  readonly planDigest: string
  /** Digest of the exact closed writer fence protecting the plan. */
  readonly writerFenceDigest: string
}

/** Terminal root that closes the partial-apply rollback scenario. */
export type WorkspaceSearchMigrationRehearsalPartialRollbackTerminalBinding = {
  /** Exact scenario whose preimage and restored state are compared. */
  readonly scenario: 'partial-apply-rollback'
  /** Authoritative terminal classification required for rollback. */
  readonly kind: 'rolled-back'
  /** Partial-rollback persistence contract version. */
  readonly version: 2
  /** Digest of the complete authoritative partial-rollback root. */
  readonly rootDigest: string
  /** Canonical instant at which the admitted apply began. */
  readonly applyStartedAt: string
  /** Canonical publication time of the authoritative rollback root. */
  readonly terminalAt: string
}

/** Terminal root that closes the complete-apply rollback scenario. */
export type WorkspaceSearchMigrationRehearsalCompleteRollbackTerminalBinding = {
  /** Exact scenario whose restored state is independently audited. */
  readonly scenario: 'complete-apply-rollback'
  /** Authoritative terminal classification required for rollback. */
  readonly kind: 'rolled-back'
  /** Complete-rollback persistence contract version. */
  readonly version: 1
  /** Digest of the complete authoritative complete-rollback root. */
  readonly rootDigest: string
  /** Canonical instant at which the admitted apply began. */
  readonly applyStartedAt: string
  /** Canonical publication time of the authoritative rollback root. */
  readonly terminalAt: string
}

/** Scenario terminal accepted by a finalized target-audit artifact. */
export type WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding =
  | WorkspaceSearchMigrationRehearsalCompleteRollbackTerminalBinding
  | WorkspaceSearchMigrationRehearsalPartialRollbackTerminalBinding

/**
 * Narrow measured-session capability required by the rehearsal target audit.
 */
export interface WorkspaceSearchMigrationRehearsalTargetAuditSession {
  /**
   * Reads and reduces one bounded target page through a measured session.
   *
   * @param input - Measured configuration and exact predecessor checkpoint.
   * @param signal - Optional collector deadline or caller cancellation.
   * @returns Detached cumulative checkpoint and page classifications.
   */
  scanTargetPage(
    input: WorkspaceSearchMigrationTargetScanContextInput,
    signal?: AbortSignal,
  ): Promise<WorkspaceSearchMigrationTargetScanPageResult>

  /**
   * Reads the digest of the exact requested physical resource inventory.
   *
   * @returns Lowercase requested-resource binding digest.
   */
  readRequestedResourcesBinding(): string

  /**
   * Reads the authenticated permit, session, commit, and measurement binding.
   *
   * @returns Frozen non-production evidence-session binding.
   */
  readRehearsalEvidenceSessionBinding():
    WorkspaceSearchMigrationRehearsalEvidenceSessionBinding
}

/** Inputs for one independent complete target-table observation. */
export type CollectWorkspaceSearchMigrationRehearsalTargetAuditInput = {
  /** Managed measured session that owns all target-page reads and bindings. */
  readonly session: WorkspaceSearchMigrationRehearsalTargetAuditSession
  /** Exact measured migration configuration for this scan. */
  readonly configuration: WorkspaceSearchMigrationConfiguration
  /** Reviewed digest of the exact measured configuration. */
  readonly configurationHash: string
  /** Maximum number of bounded pages the audit may consume. */
  readonly maximumPages: number
  /** Caller-selected total deadline no greater than fifteen minutes. */
  readonly maximumDurationMilliseconds: number
  /** Trusted clock sampled after the complete scan and binding recheck. */
  readonly clock: () => Date
  /** Trusted monotonic clock checked around every page admission. */
  readonly monotonicClock: () => number
  /** Optional caller cancellation propagated to every page read. */
  readonly signal?: AbortSignal
}

/** Secret-free exact aggregate retained by an independent target audit. */
export type WorkspaceSearchMigrationRehearsalTargetAuditAggregate = {
  /** Exact number of complete low-level target rows consumed. */
  readonly scanned: number
  /** Exact number of rows owned by migration version one. */
  readonly owned: number
  /** Exact number of recognized rows outside migration ownership. */
  readonly ignored: number
  /** Order-independent digest of exact physical target keys. */
  readonly keyDigest: string
  /** Order-independent digest of exact low-level target content. */
  readonly contentDigest: string
  /** Exact number of bounded target pages consumed. */
  readonly pageCount: number
}

/** Module-created opaque capability for one actual complete paginated scan. */
export class WorkspaceSearchMigrationRehearsalCollectedTargetAudit {
  /** Unforgeable module-private construction brand. */
  readonly #brand = collectedTargetAuditToken

  /**
   * Creates one capability only for this module's measured collector.
   *
   * @param token - Module-private construction token.
   */
  constructor(token: symbol) {
    if (token !== collectedTargetAuditToken) {
      throwPublicTargetAuditFailure('INVALID_ARGUMENT')
    }
    Object.freeze(this)
  }

  /**
   * Checks the private construction brand without exposing it.
   *
   * @param token - Module-private token supplied by the artifact finalizer.
   * @returns Whether this capability came from the measured collector.
   */
  isAuthentic(token: symbol): boolean {
    return this.#brand === token
  }
}

/** Inputs shared by every finalized target-audit artifact. */
type FinalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifactBaseInput = {
  /** Opaque actual paginated observation to consume exactly once. */
  readonly audit: WorkspaceSearchMigrationRehearsalCollectedTargetAudit
  /** Parent-authenticated scenario, run, planning, and apply identity. */
  readonly context: WorkspaceSearchMigrationRehearsalTargetAuditContext
  /** Genuine rate-bound live #163 result consumed exactly once. */
  readonly integrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
  /** Fresh enclosing rate proof and final close-drained ledger snapshot. */
  readonly rate:
    FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput
}

/** Inputs binding one actual observation to its semantic rollback role. */
export type FinalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifactInput =
  FinalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifactBaseInput & (
    | {
      /** Selects the baseline captured before committed-prefix apply. */
      readonly purpose: 'partial-rollback-preimage'
      /** A pre-apply baseline is deliberately independent of a later root. */
      readonly terminal: null
    }
    | {
      /** Selects the target state restored by committed-prefix rollback. */
      readonly purpose: 'partial-rollback-restored'
      /** Exact authoritative committed-prefix rollback root. */
      readonly terminal:
        WorkspaceSearchMigrationRehearsalPartialRollbackTerminalBinding
    }
    | {
      /** Selects the baseline captured before complete-plan apply. */
      readonly purpose: 'complete-rollback-preimage'
      /** A pre-apply baseline is deliberately independent of a later root. */
      readonly terminal: null
    }
    | {
      /** Selects the target state restored by complete-plan rollback. */
      readonly purpose: 'complete-rollback-restored'
      /** Exact authoritative complete-plan rollback root. */
      readonly terminal:
        WorkspaceSearchMigrationRehearsalCompleteRollbackTerminalBinding
    }
  )

/** Canonical authenticated artifact ready for a restricted mode-0600 file. */
export type WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact = {
  /** Detached exact canonical UTF-8 bytes containing the complete audit. */
  readonly canonicalBytes: Uint8Array
  /** Exact canonical artifact byte length. */
  readonly byteLength: number
  /** SHA-256 digest of the exact canonical artifact bytes. */
  readonly contentDigest: string
}

/** Canonical target-audit artifact and expected semantic context to authenticate. */
type AuthenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifactBaseInput = {
  /** Exact canonical authenticated target-audit artifact bytes. */
  readonly artifactBytes: Uint8Array
  /** Exact parent-authenticated scenario, run, and planning context. */
  readonly expectedContext:
    WorkspaceSearchMigrationRehearsalTargetAuditContext
}

/**
 * Input for independently authenticating one purpose-bound target audit.
 */
export type AuthenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifactInput =
  AuthenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifactBaseInput & (
    | {
      /** Requires the baseline captured before committed-prefix apply. */
      readonly purpose: 'partial-rollback-preimage'
      /** Preimage artifacts must carry no terminal root. */
      readonly terminal: null
    }
    | {
      /** Requires target state after committed-prefix rollback. */
      readonly purpose: 'partial-rollback-restored'
      /** Exact authoritative committed-prefix rollback terminal. */
      readonly terminal:
        WorkspaceSearchMigrationRehearsalPartialRollbackTerminalBinding
    }
    | {
      /** Requires the baseline captured before complete-plan apply. */
      readonly purpose: 'complete-rollback-preimage'
      /** Preimage artifacts must carry no terminal root. */
      readonly terminal: null
    }
    | {
      /** Requires target state after complete-plan rollback. */
      readonly purpose: 'complete-rollback-restored'
      /** Exact authoritative complete-plan rollback terminal. */
      readonly terminal:
        WorkspaceSearchMigrationRehearsalCompleteRollbackTerminalBinding
    }
  )

/** Exact authenticated raw artifact binding retained for stage cross-checks. */
export type WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding = {
  /** SHA-256 digest of the exact supplied canonical artifact bytes. */
  readonly contentDigest: string
  /** Exact supplied canonical artifact byte length. */
  readonly byteLength: number
  /** Fixed semantic purpose authenticated inside the artifact. */
  readonly purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose
  /** Canonical wall-clock sample taken before the first external read. */
  readonly startedAt: string
  /** Canonical completion time of the actual paginated target scan. */
  readonly observedAt: string
  /** Exact reviewed commit authenticated by the measured session. */
  readonly commit: string
  /** Exact measured configuration hash. */
  readonly configurationHash: string
  /** SHA-256 digest of the session-approved rehearsal runtime HMAC key. */
  readonly evidenceKeyDigest: string
  /** Digest of the complete authenticated source session. */
  readonly sourceSessionBindingDigest: string
  /** Exact session-owned requested-resource binding digest. */
  readonly sourceResourceBindingDigest: string
  /** Full genuine live #163 result and its exact authenticated rate interval. */
  readonly integrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
  /** Parent-authenticated scenario, run, planning, and apply identity. */
  readonly context: WorkspaceSearchMigrationRehearsalTargetAuditContext
  /** Exact authenticated terminal root, absent for a scenario preimage. */
  readonly terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null
  /** Detached complete target aggregate authenticated inside the artifact. */
  readonly aggregate: WorkspaceSearchMigrationRehearsalTargetAuditAggregate
  /** Pagination-independent digest of the observed target state. */
  readonly aggregateDigest: string
  /** Contextual digest including observation time and pagination metadata. */
  readonly observationDigest: string
  /** Exact auxiliary rate segment and close-drained ledger binding. */
  readonly rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence
}

/** Target-audit purposes admitted before a rollback apply can begin. */
export type WorkspaceSearchMigrationRehearsalTargetPreimagePurpose =
  | 'complete-rollback-preimage'
  | 'partial-rollback-preimage'

/** Exact preimage artifact expectation authenticated by the planning parent. */
export type WorkspaceSearchMigrationRehearsalTargetPreimageArtifactExpectation = {
  /** Canonical dual-key-authenticated target-audit artifact bytes. */
  readonly artifactBytes: Uint8Array
  /** Exact prospective planning context reconstructed by the parent. */
  readonly expectedContext:
    WorkspaceSearchMigrationRehearsalTargetAuditContext
  /** Scenario-specific rollback preimage purpose. */
  readonly purpose: WorkspaceSearchMigrationRehearsalTargetPreimagePurpose
  /** A pre-apply target observation must not carry a terminal root. */
  readonly terminal: null
}

/** Inputs issuing one genuine rollback-preimage planning-commit gate. */
export type FinalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidenceInput = {
  /** Exact dual-key artifact and prospective parent-owned context. */
  readonly artifact:
    WorkspaceSearchMigrationRehearsalTargetPreimageArtifactExpectation
  /** Digest of the prospective planning receipt that remains self-reference-free. */
  readonly expectedProspectivePlanningReceiptDigest: string
  /** Authenticated child completion time retained by that planning receipt. */
  readonly expectedPlanningReceiptCompletedAt: string
  /** Exact planning-child rate segment immediately preceding the target audit. */
  readonly expectedRatePredecessor:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Trusted time at which the parent admitted this preimage commit gate. */
  readonly commitGateObservedAt: string
}

/** Full secret-free target preimage binding retained by a commit capability. */
export type WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding =
  Omit<
    WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding,
    'purpose' | 'terminal'
  > & {
    /** Scenario-specific authenticated rollback preimage purpose. */
    readonly purpose: WorkspaceSearchMigrationRehearsalTargetPreimagePurpose
    /** A pre-apply observation carries no later rollback terminal. */
    readonly terminal: null
    /** Digest of the complete parent-authenticated target-audit context. */
    readonly contextDigest: string
    /** Exact self-reference-free prospective planning-receipt digest. */
    readonly prospectivePlanningReceiptDigest: string
    /** Authenticated completion time copied from the prospective receipt. */
    readonly expectedPlanningReceiptCompletedAt: string
    /** Trusted planning-commit gate observation after the target rate closed. */
    readonly commitGateObservedAt: string
    /** Stable digest of every secret-free field in this capability binding. */
    readonly bindingDigest: string
  }

/** Opaque one-shot capability proving a real rollback preimage is commit-ready. */
export class WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence {
  /** Unforgeable module-private construction brand. */
  readonly #brand = finalizedTargetPreimageEvidenceToken

  /**
   * Creates one capability only for this module's preimage verifier.
   *
   * @param token - Module-private construction token.
   */
  constructor(token: symbol) {
    if (token !== finalizedTargetPreimageEvidenceToken) {
      throwPublicTargetAuditFailure('INVALID_ARGUMENT')
    }
    Object.freeze(this)
  }

  /**
   * Checks the private construction brand without exposing it.
   *
   * @param token - Module-private token supplied by a commit boundary.
   * @returns Whether this capability was constructed by this module.
   */
  isAuthentic(token: symbol): boolean {
    return this.#brand === token
  }
}

/** Complete contextual observation retained behind an opaque capability. */
type TargetAuditObservation = {
  /** Canonical wall-clock sample taken before the first external read. */
  readonly startedAt: string
  /** Canonical completion time sampled after the full scan. */
  readonly observedAt: string
  /** Exact reviewed commit authenticated by the measured session. */
  readonly commit: string
  /** Exact measured configuration hash. */
  readonly configurationHash: string
  /** Digest of the authenticated source session and resource selection. */
  readonly sourceSessionBindingDigest: string
  /** Exact session-owned requested-resource binding digest. */
  readonly sourceResourceBindingDigest: string
  /** Exact authenticated permit digest retained by the measured session. */
  readonly sourcePermitDigest: string
  /** Session-approved digest of the permit-bound runtime HMAC key. */
  readonly evidenceKeyDigest: string
  /** Exact invalid-free complete target aggregate. */
  readonly aggregate: WorkspaceSearchMigrationRehearsalTargetAuditAggregate
  /** Pagination-independent target-state digest. */
  readonly aggregateDigest: string
  /** Digest of every contextual observation field including pagination. */
  readonly observationDigest: string
}

/** Strict detached authenticated source-session binding. */
type ParsedSourceSessionBinding = {
  /** Exact reviewed commit authenticated by the permit. */
  readonly commit: string
  /** Exact measured configuration hash. */
  readonly configurationHash: string
  /** SHA-256 digest of the dedicated evidence key. */
  readonly evidenceKeyDigest: string
  /** SHA-256 digest of the distinct parent publication key. */
  readonly publicationKeyDigest: string
  /** Exact digest-only non-production session attestations. */
  readonly attestation: {
    /** Fixed non-production stage. */
    readonly stage: 'non-production'
    /** Digest of the authenticated permit. */
    readonly permitDigest: string
    /** Digest authenticating the exact AWS caller. */
    readonly callerAttestationDigest: string
    /** Digest authenticating the measured AWS resources. */
    readonly resourceAttestationDigest: string
    /** Digest proving production-account isolation. */
    readonly productionIsolationDigest: string
  }
}

/** Runtime-semantic and parent-publication authentication metadata. */
type TargetAuditAuthentication = {
  /** Fixed artifact authentication algorithm. */
  readonly algorithm: 'HMAC-SHA-256'
  /** Domain-separated fingerprint of the permit-bound runtime key. */
  readonly runtimeKeyFingerprint: string
  /** Runtime HMAC over the semantic document and runtime fingerprint. */
  readonly runtimeMac: string
  /** Domain-separated fingerprint of the parent-held publication key. */
  readonly publicationKeyFingerprint: string
  /** Parent HMAC over the complete runtime-authenticated document. */
  readonly publicationMac: string
}

/** Complete strict authenticated target-audit document. */
type TargetAuditDocument = {
  /** Stable target-audit artifact discriminator. */
  readonly kind:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND
  /** Strict target-audit artifact contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION
  /** Fixed semantic role in rollback comparison. */
  readonly purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose
  /** Canonical wall-clock sample taken before the first external read. */
  readonly startedAt: string
  /** Canonical completion time of the actual full scan. */
  readonly observedAt: string
  /** Exact reviewed commit authenticated by the measured session. */
  readonly commit: string
  /** Exact measured configuration hash. */
  readonly configurationHash: string
  /** SHA-256 digest of the session-approved rehearsal runtime HMAC key. */
  readonly evidenceKeyDigest: string
  /** Digest of the authenticated source session and resource selection. */
  readonly sourceSessionBindingDigest: string
  /** Exact session-owned requested-resource binding digest. */
  readonly sourceResourceBindingDigest: string
  /** Full genuine live #163 result and its exact authenticated rate interval. */
  readonly integrity:
    WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
  /** Parent-authenticated scenario, run, planning, and apply identity. */
  readonly context: WorkspaceSearchMigrationRehearsalTargetAuditContext
  /** Scenario terminal root, absent for the pre-apply baseline. */
  readonly terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null
  /** Exact complete invalid-free target aggregate. */
  readonly aggregate: WorkspaceSearchMigrationRehearsalTargetAuditAggregate
  /** Pagination-independent target-state digest. */
  readonly aggregateDigest: string
  /** Digest of every contextual observation field including pagination. */
  readonly observationDigest: string
  /** Exact auxiliary rate segment and close-drained ledger binding. */
  readonly rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence
  /** Dedicated whole-document HMAC metadata. */
  readonly authentication: TargetAuditAuthentication
}

/** Strict authenticated document plus its exact supplied raw-file identity. */
type AuthenticatedTargetAuditArtifact = {
  /** Complete strictly parsed and HMAC-authenticated audit document. */
  readonly document: TargetAuditDocument
  /** SHA-256 digest of the exact supplied canonical file bytes. */
  readonly contentDigest: string
  /** Exact supplied canonical file byte length. */
  readonly byteLength: number
}

/** One authenticated target artifact paired with its exact immutable binding. */
type BoundAuthenticatedTargetAuditArtifact = {
  /** Complete strictly parsed and HMAC-authenticated artifact. */
  readonly artifact: AuthenticatedTargetAuditArtifact
  /** Identifier-free exact canonical artifact and semantic binding. */
  readonly binding: WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding
}

/** Every document field covered by HMAC except the final MAC itself. */
type UnsignedTargetAuditDocument = Omit<
  TargetAuditDocument,
  'authentication'
> & {
  /** Algorithm and runtime fingerprint covered by the runtime HMAC. */
  readonly authentication: Pick<
    TargetAuditAuthentication,
    'algorithm' | 'runtimeKeyFingerprint'
  >
}

/** Parent-HMAC projection covering the complete runtime authentication. */
type PublicationUnsignedTargetAuditDocument = Omit<
  TargetAuditDocument,
  'authentication'
> & {
  /** Runtime authentication plus parent publication-key fingerprint. */
  readonly authentication: Omit<
    TargetAuditAuthentication,
    'publicationMac'
  >
}

/** Internal raw-value-free audit failure classifications. */
type WorkspaceSearchMigrationRehearsalTargetAuditFailureCode =
  | 'CONFIGURATION_HASH_MISMATCH'
  | 'DRY_RUN_INVALID_ROWS'
  | 'IDENTITY_MISMATCH'
  | 'INVALID_ARGUMENT'
  | 'INVALID_STATE'

/** Mutable trusted monotonic state for one total target-audit deadline. */
type TargetAuditDeadlineState = {
  /** First trusted monotonic sample. */
  readonly startedAtMilliseconds: number
  /** Inclusive final trusted monotonic deadline. */
  readonly deadlineMilliseconds: number
  /** Most recent accepted sample used to reject clock regression. */
  lastObservedMilliseconds: number
}

/** Privately distinguishable expected audit failure. */
class RehearsalTargetAuditFailure extends Error {
  /** Stable migration failure code selected by trusted audit logic. */
  readonly code: WorkspaceSearchMigrationRehearsalTargetAuditFailureCode

  /**
   * Creates one private raw-value-free audit failure.
   *
   * @param code - Stable failure classification.
   */
  constructor(
    code: WorkspaceSearchMigrationRehearsalTargetAuditFailureCode,
  ) {
    super(code)
    this.name = 'RehearsalTargetAuditFailure'
    this.code = code
  }
}

/** Exact byte length of the permit-bound rehearsal runtime HMAC key. */
const targetAuditKeyByteLength = 32

/** Domain separating the target-audit runtime-key fingerprint. */
const targetAuditRuntimeKeyFingerprintDomain =
  'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-key/v4\n'

/** Domain separating the target-audit runtime semantic HMAC. */
const targetAuditRuntimeMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-target-audit-runtime-mac/v4\n'

/** Domain separating the target-audit parent-key fingerprint. */
const targetAuditPublicationKeyFingerprintDomain =
  'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-key/v4\n'

/** Domain separating the target-audit parent outer HMAC. */
const targetAuditPublicationMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-target-audit-publication-mac/v4\n'

/** Domain separating the embedded live-result rate binding from outer HMACs. */
const targetAuditIntegrityBindingMacDomain =
  'mukuroji:workspace-search-migration:rate-bound-integrity-result:v1\0'

/** Module-private construction token for actual collected observations. */
const collectedTargetAuditToken = Symbol(
  'workspace-search-migration-rehearsal-collected-target-audit',
)

/** Module-private construction token for finalized target preimage evidence. */
const finalizedTargetPreimageEvidenceToken = Symbol(
  'workspace-search-migration-rehearsal-finalized-target-preimage',
)

/** Actual observations retained behind live collector capabilities. */
const collectedTargetAuditValues = new WeakMap<
  WorkspaceSearchMigrationRehearsalCollectedTargetAudit,
  TargetAuditObservation
>()

/** Authenticated target preimages retained behind live commit capabilities. */
const finalizedTargetPreimageEvidenceValues = new WeakMap<
  WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence,
  WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding
>()

/** Strict guards bound to this module's public failure boundary. */
const targetAuditGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  () => failRehearsalTargetAudit('INVALID_ARGUMENT'),
)

/**
 * Collects one independent complete target-table observation.
 *
 * The returned capability has no serializable fields and can only be consumed
 * by the artifact finalizer in this module. Session and resource bindings are
 * captured before the first page and rechecked after the terminal page.
 *
 * @param input - Measured session, configuration, page ceiling, and clock.
 * @returns Opaque capability proving one actual complete paginated scan.
 */
export async function collectWorkspaceSearchMigrationRehearsalTargetAudit(
  input: CollectWorkspaceSearchMigrationRehearsalTargetAuditInput,
): Promise<WorkspaceSearchMigrationRehearsalCollectedTargetAudit> {
  try {
    const observation = await collectRehearsalTargetAuditUnchecked(input)
    const collected =
      new WorkspaceSearchMigrationRehearsalCollectedTargetAudit(
        collectedTargetAuditToken,
      )
    collectedTargetAuditValues.set(collected, observation)
    return collected
  } catch (error) {
    return replaceRehearsalTargetAuditFailure(error)
  }
}

/**
 * Authenticates one actual observation with its semantic baseline or root.
 *
 * The runtime key authenticates measured child semantics and the parent-held
 * publication key adds an outer authorization. Ownership of both keys
 * transfers, and every caller and working buffer is overwritten. The opaque
 * observation and rate proof are consumed only by this finalization boundary.
 *
 * @param input - Actual observation, fixed purpose, and purpose-bound root.
 * @param runtimeSigningKey - Caller-owned permit-bound runtime HMAC key.
 * @param publicationSigningKey - Caller-owned parent publication HMAC key.
 * @returns Canonical authenticated artifact for one restricted file.
 */
export function finalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
  input: FinalizeWorkspaceSearchMigrationRehearsalTargetAuditArtifactInput,
  runtimeSigningKey: Uint8Array,
  publicationSigningKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalFinalizedTargetAuditArtifact {
  let runtimeWorkingKey: Uint8Array | undefined
  let publicationWorkingKey: Uint8Array | undefined
  try {
    runtimeWorkingKey = copyTargetAuditKey(runtimeSigningKey)
    publicationWorkingKey = copyTargetAuditKey(publicationSigningKey)
    zeroizeBytes(runtimeSigningKey)
    zeroizeBytes(publicationSigningKey)
    requireDistinctTargetAuditKeys(runtimeWorkingKey, publicationWorkingKey)
    const record = targetAuditGuards.requireRecord(input)
    targetAuditGuards.requireExactKeys(record, [
      'audit',
      'context',
      'integrity',
      'purpose',
      'rate',
      'terminal',
    ])
    const audit = targetAuditGuards.readOwn(record, 'audit')
    const purpose = readTargetAuditPurpose(
      targetAuditGuards.readOwn(record, 'purpose'),
    )
    const terminal = readTargetAuditTerminal(
      targetAuditGuards.readOwn(record, 'terminal'),
      purpose,
    )
    const context = readTargetAuditContext(
      targetAuditGuards.readOwn(record, 'context'),
    )
    requirePurposeContext(purpose, context, terminal)
    const integrity = consumeTargetAuditIntegrity(
      targetAuditGuards.readOwn(record, 'integrity'),
      purpose,
      terminal,
    )
    const rate = finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
      targetAuditGuards.readOwn(record, 'rate'),
    )
    if (
      !safeTargetAuditDigestEqual(
        rate.authenticationKeyFingerprint,
        createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
          runtimeWorkingKey,
        ),
      )
    ) return failRehearsalTargetAudit('IDENTITY_MISMATCH')
    if (
      !(audit instanceof
        WorkspaceSearchMigrationRehearsalCollectedTargetAudit) ||
      !audit.isAuthentic(collectedTargetAuditToken)
    ) {
      return failRehearsalTargetAudit('INVALID_ARGUMENT')
    }
    const observation = collectedTargetAuditValues.get(audit)
    if (observation === undefined) {
      return failRehearsalTargetAudit('INVALID_STATE')
    }
    if (
      createHash('sha256').update(runtimeWorkingKey).digest('hex') !==
        observation.evidenceKeyDigest
    ) {
      return failRehearsalTargetAudit('IDENTITY_MISMATCH')
    }
    if (
      observation.configurationHash !==
        context.configurationBindingDigest ||
      observation.sourcePermitDigest !== context.permitDigest ||
      observation.sourceResourceBindingDigest !==
        context.requestedResourcesBinding ||
      integrity.configurationBindingDigest !==
        context.configurationBindingDigest ||
      integrity.policyVersion !== context.policyVersion ||
      integrity.result.resourceIdentityDigest !==
        context.integrityResourceIdentityDigest ||
      !safeTargetAuditDigestEqual(
        integrity.bindingMac,
        createTargetAuditIntegrityBindingMac(
          integrity,
          runtimeWorkingKey,
        ),
      ) ||
      rate.link.configurationBindingDigest !==
        context.configurationBindingDigest ||
      rate.link.policyVersion !== context.policyVersion ||
      !sameVerifiedTargetAuditRateSegment(
        integrity.predecessor,
        rate.predecessor,
      ) ||
      !sameVerifiedTargetAuditRateSegment(
        integrity.segment,
        rate.successor,
      ) ||
      Date.parse(rate.completedAt) < Date.parse(observation.observedAt)
    ) return failRehearsalTargetAudit('IDENTITY_MISMATCH')
    requireTargetAuditObservationWindow(
      purpose,
      observation.startedAt,
      observation.observedAt,
      terminal,
      'INVALID_STATE',
    )
    requireTargetAuditIntegrityWindow(
      integrity,
      purpose,
      observation.observedAt,
      terminal,
    )
    const runtimeKeyFingerprint = createTargetAuditRuntimeKeyFingerprint(
      runtimeWorkingKey,
    )
    const unsigned = createUnsignedTargetAuditDocument(
      observation,
      purpose,
      terminal,
      context,
      integrity,
      rate,
      runtimeKeyFingerprint,
    )
    const runtimeMac = createTargetAuditRuntimeMac(
      unsigned,
      runtimeWorkingKey,
    )
    const publicationKeyFingerprint =
      createTargetAuditPublicationKeyFingerprint(publicationWorkingKey)
    const publicationUnsigned: PublicationUnsignedTargetAuditDocument =
      Object.freeze({
        ...unsigned,
        authentication: Object.freeze({
          ...unsigned.authentication,
          runtimeMac,
          publicationKeyFingerprint,
        }),
      })
    const document: TargetAuditDocument = Object.freeze({
      ...unsigned,
      authentication: Object.freeze({
        ...publicationUnsigned.authentication,
        publicationMac: createTargetAuditPublicationMac(
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
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES
    ) {
      return failRehearsalTargetAudit('INVALID_STATE')
    }
    collectedTargetAuditValues.delete(audit)
    return Object.freeze({
      canonicalBytes,
      byteLength: canonicalBytes.byteLength,
      contentDigest: createHash('sha256')
        .update(canonicalBytes)
        .digest('hex'),
    })
  } catch (error) {
    return replaceRehearsalTargetAuditFailure(error)
  } finally {
    zeroizeBytes(runtimeWorkingKey)
    zeroizeBytes(publicationWorkingKey)
    zeroizeBytes(runtimeSigningKey)
    zeroizeBytes(publicationSigningKey)
  }
}

/**
 * Authenticates one canonical target-audit artifact in an expected context.
 *
 * Ownership of both verification keys transfers to this invocation. Canonical
 * bytes, strict document keys, runtime and parent HMACs, purpose, exact
 * context, and terminal binding are verified before returning a frozen
 * identifier-free binding.
 *
 * @param input - Canonical artifact bytes and exact expected semantic context.
 * @param runtimeVerificationKey - Caller-owned permit-bound runtime key.
 * @param publicationVerificationKey - Caller-owned parent publication key.
 * @returns Frozen exact canonical artifact and authenticated context binding.
 */
export function authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
  input:
    AuthenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifactInput,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding {
  let runtimeWorkingKey: Uint8Array | undefined
  let publicationWorkingKey: Uint8Array | undefined
  try {
    runtimeWorkingKey = copyTargetAuditKey(runtimeVerificationKey)
    publicationWorkingKey = copyTargetAuditKey(publicationVerificationKey)
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
    requireDistinctTargetAuditKeys(runtimeWorkingKey, publicationWorkingKey)
    const record = targetAuditGuards.requireRecord(input)
    targetAuditGuards.requireExactKeys(record, [
      'artifactBytes',
      'expectedContext',
      'purpose',
      'terminal',
    ])
    const purpose = readTargetAuditPurpose(
      targetAuditGuards.readOwn(record, 'purpose'),
    )
    const terminal = readTargetAuditTerminal(
      targetAuditGuards.readOwn(record, 'terminal'),
      purpose,
    )
    const expectedContext = readTargetAuditContext(
      targetAuditGuards.readOwn(record, 'expectedContext'),
    )
    requirePurposeContext(purpose, expectedContext, terminal)
    const authenticated = readBoundAuthenticatedTargetAuditArtifact(
      targetAuditGuards.readOwn(record, 'artifactBytes'),
      runtimeWorkingKey,
      publicationWorkingKey,
    )
    const document = authenticated.artifact.document
    if (
      document.purpose !== purpose ||
      !sameTargetAuditTerminal(document.terminal, terminal) ||
      !sameTargetAuditContext(document.context, expectedContext)
    ) {
      return failRehearsalTargetAudit('INVALID_STATE')
    }
    return authenticated.binding
  } catch (error) {
    return replaceRehearsalTargetAuditFailure(error)
  } finally {
    zeroizeBytes(runtimeWorkingKey)
    zeroizeBytes(publicationWorkingKey)
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
  }
}

/**
 * Authenticates one preimage and issues a one-shot planning-commit gate.
 *
 * The target observation must follow the prospective planning receipt and its
 * auxiliary rate segment must immediately follow the planning child's exact
 * authenticated rate segment. The gate time closes this operation before a
 * later apply reservation can be admitted by the durable stage chain.
 * Ownership of both verification keys transfers to this invocation.
 *
 * @param input - Exact artifact, prospective receipt, rate, and gate time.
 * @param runtimeVerificationKey - Caller-owned permit-bound runtime key.
 * @param publicationVerificationKey - Caller-owned parent publication key.
 * @returns Opaque one-shot capability accepted by the planning commit store.
 */
export function finalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidence(
  input: FinalizeWorkspaceSearchMigrationRehearsalTargetPreimageEvidenceInput,
  runtimeVerificationKey: Uint8Array,
  publicationVerificationKey: Uint8Array,
): WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence {
  let artifactBytes: Uint8Array | undefined
  try {
    const record = targetAuditGuards.requireRecord(input)
    targetAuditGuards.requireExactKeys(record, [
      'artifact',
      'commitGateObservedAt',
      'expectedPlanningReceiptCompletedAt',
      'expectedProspectivePlanningReceiptDigest',
      'expectedRatePredecessor',
    ])
    const artifactRecord = targetAuditGuards.requireRecord(
      targetAuditGuards.readOwn(record, 'artifact'),
    )
    targetAuditGuards.requireExactKeys(artifactRecord, [
      'artifactBytes',
      'expectedContext',
      'purpose',
      'terminal',
    ])
    const purpose = readTargetPreimagePurpose(
      targetAuditGuards.readOwn(artifactRecord, 'purpose'),
    )
    if (targetAuditGuards.readOwn(artifactRecord, 'terminal') !== null) {
      return failRehearsalTargetAudit('INVALID_ARGUMENT')
    }
    const expectedContext = readTargetAuditContext(
      targetAuditGuards.readOwn(artifactRecord, 'expectedContext'),
    )
    requirePurposeContext(purpose, expectedContext, null)
    artifactBytes = copyTargetAuditBytes(
      targetAuditGuards.readOwn(artifactRecord, 'artifactBytes'),
    )
    const expectedProspectivePlanningReceiptDigest =
      targetAuditGuards.readDigest(
        targetAuditGuards.readOwn(
          record,
          'expectedProspectivePlanningReceiptDigest',
        ),
      )
    const expectedPlanningReceiptCompletedAt =
      targetAuditGuards.readTimestamp(
        targetAuditGuards.readOwn(
          record,
          'expectedPlanningReceiptCompletedAt',
        ),
      )
    const expectedRatePredecessor = readTargetPreimageRatePredecessor(
      targetAuditGuards.readOwn(record, 'expectedRatePredecessor'),
    )
    const commitGateObservedAt = targetAuditGuards.readTimestamp(
      targetAuditGuards.readOwn(record, 'commitGateObservedAt'),
    )
    if (
      expectedContext.planningReceiptDigest !==
        expectedProspectivePlanningReceiptDigest
    ) return failRehearsalTargetAudit('INVALID_STATE')
    const binding =
      authenticateWorkspaceSearchMigrationRehearsalTargetAuditArtifact(
        {
          artifactBytes,
          expectedContext,
          purpose,
          terminal: null,
        },
        runtimeVerificationKey,
        publicationVerificationKey,
      )
    const integrity = binding.integrity
    if (
      binding.purpose !== purpose ||
      binding.terminal !== null ||
      !sameVerifiedTargetAuditRateSegment(
        integrity.predecessor,
        expectedRatePredecessor,
      ) ||
      Date.parse(expectedPlanningReceiptCompletedAt) >
        Date.parse(integrity.result.runtimeProvenance.startedAt) ||
      Date.parse(integrity.result.runtimeProvenance.completedAt) >
        Date.parse(binding.observedAt) ||
      Date.parse(binding.observedAt) > Date.parse(binding.rate.completedAt) ||
      Date.parse(binding.rate.completedAt) >
        Date.parse(commitGateObservedAt)
    ) return failRehearsalTargetAudit('INVALID_STATE')
    const contextDigest = createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-target-preimage-context',
      version: 2,
      context: binding.context,
    })
    const bindingWithoutDigest = Object.freeze({
      ...binding,
      purpose,
      terminal: null,
      contextDigest,
      prospectivePlanningReceiptDigest:
        expectedProspectivePlanningReceiptDigest,
      expectedPlanningReceiptCompletedAt,
      commitGateObservedAt,
    })
    const finalizedBinding = Object.freeze({
      ...bindingWithoutDigest,
      bindingDigest: createMigrationDigest({
        kind:
          'workspace-search-migration-rehearsal-target-preimage-evidence-binding',
        version: 2,
        binding: bindingWithoutDigest,
      }),
    })
    const capability =
      new WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
        finalizedTargetPreimageEvidenceToken,
      )
    finalizedTargetPreimageEvidenceValues.set(capability, finalizedBinding)
    return capability
  } catch (error) {
    return replaceRehearsalTargetAuditFailure(error)
  } finally {
    zeroizeBytes(artifactBytes)
    zeroizeBytes(runtimeVerificationKey)
    zeroizeBytes(publicationVerificationKey)
  }
}

/**
 * Reads one genuine unconsumed target-preimage capability binding.
 *
 * A planning preflight may inspect this immutable secret-free binding while
 * leaving the one-shot consume operation for the irreversible store CAS.
 *
 * @param value - Candidate opaque capability from the preimage verifier.
 * @returns Full authenticated artifact and prospective planning binding.
 */
export function readWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidenceBinding(
  value: unknown,
): WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding {
  try {
    if (
      nodeUtilTypes.isProxy(value) ||
      !(value instanceof
        WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence) ||
      !value.isAuthentic(finalizedTargetPreimageEvidenceToken)
    ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
    const binding = finalizedTargetPreimageEvidenceValues.get(value)
    if (binding === undefined) {
      return failRehearsalTargetAudit('INVALID_STATE')
    }
    return binding
  } catch (error) {
    return replaceRehearsalTargetAuditFailure(error)
  }
}

/**
 * Consumes one target-preimage planning-commit capability exactly once.
 *
 * @param value - Candidate opaque capability from the preimage verifier.
 * @returns Full authenticated binding for the durable planning commit journal.
 */
export function consumeWorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence(
  value: unknown,
): WorkspaceSearchMigrationRehearsalTargetPreimageEvidenceBinding {
  try {
    if (
      nodeUtilTypes.isProxy(value) ||
      !(value instanceof
        WorkspaceSearchMigrationRehearsalFinalizedTargetPreimageEvidence) ||
      !value.isAuthentic(finalizedTargetPreimageEvidenceToken)
    ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
    const binding = finalizedTargetPreimageEvidenceValues.get(value)
    if (binding === undefined) {
      return failRehearsalTargetAudit('INVALID_STATE')
    }
    finalizedTargetPreimageEvidenceValues.delete(value)
    return binding
  } catch (error) {
    return replaceRehearsalTargetAuditFailure(error)
  }
}

/** Executes the bounded target-page loop after public input capture. */
async function collectRehearsalTargetAuditUnchecked(
  input: CollectWorkspaceSearchMigrationRehearsalTargetAuditInput,
): Promise<TargetAuditObservation> {
  const inputRecord = targetAuditGuards.requireRecord(input)
  const hasSignal = Object.hasOwn(inputRecord, 'signal')
  targetAuditGuards.requireExactKeys(inputRecord, [
    'clock',
    'configuration',
    'configurationHash',
    'maximumDurationMilliseconds',
    'maximumPages',
    'monotonicClock',
    'session',
    ...(hasSignal ? ['signal'] : []),
  ])
  const configuration = structuredClone(input.configuration)
  const configurationHash = input.configurationHash
  const maximumPages = input.maximumPages
  const maximumDurationMilliseconds = input.maximumDurationMilliseconds
  const session = input.session
  const clock = input.clock
  const monotonicClock = input.monotonicClock
  const signal = input.signal
  if (
    !Number.isSafeInteger(maximumPages) ||
    maximumPages < 1 ||
    maximumPages >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_PAGES ||
    !Number.isSafeInteger(maximumDurationMilliseconds) ||
    maximumDurationMilliseconds < 1 ||
    maximumDurationMilliseconds >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_DURATION_MILLISECONDS ||
    nodeUtilTypes.isProxy(session) ||
    typeof session.scanTargetPage !== 'function' ||
    typeof session.readRequestedResourcesBinding !== 'function' ||
    typeof session.readRehearsalEvidenceSessionBinding !== 'function' ||
    typeof clock !== 'function' ||
    nodeUtilTypes.isProxy(clock) ||
    typeof monotonicClock !== 'function' ||
    nodeUtilTypes.isProxy(monotonicClock) ||
    (
      signal !== undefined &&
      (!(signal instanceof AbortSignal) || nodeUtilTypes.isProxy(signal))
    )
  ) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  if (
    !isHexDigest(configurationHash) ||
    createWorkspaceSearchConfigurationHash(configuration) !==
      configurationHash
  ) {
    return failRehearsalTargetAudit('CONFIGURATION_HASH_MISMATCH')
  }
  const startedAtMilliseconds = readTrustedMonotonicClock(monotonicClock)
  const deadlineMilliseconds =
    startedAtMilliseconds + maximumDurationMilliseconds
  if (!Number.isSafeInteger(deadlineMilliseconds) || signal?.aborted === true) {
    return failRehearsalTargetAudit('INVALID_STATE')
  }
  const deadlineState: TargetAuditDeadlineState = {
    startedAtMilliseconds,
    deadlineMilliseconds,
    lastObservedMilliseconds: startedAtMilliseconds,
  }
  const controller = new AbortController()
  /** Propagates caller cancellation into the active page request. */
  const handleAbort = (): void => controller.abort()
  signal?.addEventListener('abort', handleAbort, { once: true })
  try {
    const startedAt = readTrustedClock(clock)
    requireTargetAuditDeadline(monotonicClock, deadlineState)
    const initialBinding = readSourceSessionObservationBinding(
      session,
      configuration,
      configurationHash,
    )
    const scanTargetPage = session.scanTargetPage.bind(session)
    const cursorDigests = new Set<string>()
    let checkpoint =
      createEmptyWorkspaceSearchMigrationTargetScanCheckpoint(
        configurationHash,
      )
    for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
      const remainingMilliseconds = readTargetAuditRemainingDuration(
        monotonicClock,
        deadlineState,
      )
      const previousCheckpoint = checkpoint
      const pageResult = structuredClone(
        await runTargetAuditPageWithinDeadline(
          () => scanTargetPage({
            configuration: structuredClone(configuration),
            configurationHash,
            previousCheckpoint: structuredClone(previousCheckpoint),
          }, controller.signal),
          remainingMilliseconds,
          controller,
        ),
      )
      requireTargetAuditDeadline(monotonicClock, deadlineState)
      checkpoint = pageResult.checkpoint
      validateTargetAuditPageResult(
        configurationHash,
        previousCheckpoint,
        pageResult,
      )
      if (checkpoint.completed) {
        const finalBinding = readSourceSessionObservationBinding(
          session,
          configuration,
          configurationHash,
        )
        requireTargetAuditDeadline(monotonicClock, deadlineState)
        if (!sourceObservationBindingsEqual(initialBinding, finalBinding)) {
          return failRehearsalTargetAudit('IDENTITY_MISMATCH')
        }
        const observedAt = readTrustedClock(clock)
        if (Date.parse(startedAt) > Date.parse(observedAt)) {
          return failRehearsalTargetAudit('INVALID_STATE')
        }
        return createTargetAuditObservation(
          startedAt,
          observedAt,
          initialBinding,
          checkpoint,
        )
      }
      const cursor = checkpoint.cursor
      if (cursor === undefined) {
        return failRehearsalTargetAudit('INVALID_STATE')
      }
      const cursorDigest = createAttributeMapDigest(cursor)
      if (cursorDigests.has(cursorDigest)) {
        return failRehearsalTargetAudit('INVALID_STATE')
      }
      cursorDigests.add(cursorDigest)
    }
    return failRehearsalTargetAudit('INVALID_STATE')
  } finally {
    signal?.removeEventListener('abort', handleAbort)
    controller.abort()
  }
}

/** Runs one page request within the remaining total target-audit deadline. */
async function runTargetAuditPageWithinDeadline<Result>(
  operation: () => Promise<Result>,
  remainingMilliseconds: number,
  controller: AbortController,
): Promise<Result> {
  if (controller.signal.aborted) {
    return failRehearsalTargetAudit('INVALID_STATE')
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  let handleAbort: (() => void) | undefined
  try {
    const aborted = new Promise<Result>((_resolve, reject) => {
      handleAbort = () => {
        reject(new RehearsalTargetAuditFailure('INVALID_STATE'))
      }
      if (controller.signal.aborted) {
        handleAbort()
        return
      }
      controller.signal.addEventListener('abort', handleAbort, { once: true })
    })
    return await Promise.race([
      Reflect.apply(operation, undefined, []),
      new Promise<Result>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort()
          reject(new RehearsalTargetAuditFailure('INVALID_STATE'))
        }, remainingMilliseconds)
      }),
      aborted,
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (handleAbort !== undefined) {
      controller.signal.removeEventListener('abort', handleAbort)
    }
  }
}

/** Returns positive remaining duration before admitting another page read. */
function readTargetAuditRemainingDuration(
  clock: () => number,
  state: TargetAuditDeadlineState,
): number {
  const now = readTargetAuditMonotonicSample(clock, state)
  if (now >= state.deadlineMilliseconds) {
    return failRehearsalTargetAudit('INVALID_STATE')
  }
  return state.deadlineMilliseconds - now
}

/** Fails when a page or binding check crossed or regressed its total deadline. */
function requireTargetAuditDeadline(
  clock: () => number,
  state: TargetAuditDeadlineState,
): void {
  const now = readTargetAuditMonotonicSample(clock, state)
  if (now > state.deadlineMilliseconds) {
    return failRehearsalTargetAudit('INVALID_STATE')
  }
}

/** Reads one non-regressing sample and advances the trusted deadline state. */
function readTargetAuditMonotonicSample(
  clock: () => number,
  state: TargetAuditDeadlineState,
): number {
  const now = readTrustedMonotonicClock(clock)
  if (
    now < state.startedAtMilliseconds ||
    now < state.lastObservedMilliseconds
  ) {
    return failRehearsalTargetAudit('INVALID_STATE')
  }
  state.lastObservedMilliseconds = now
  return now
}

/** Reads one finite non-negative trusted monotonic-clock sample. */
function readTrustedMonotonicClock(clock: () => number): number {
  let value: unknown
  try {
    value = Reflect.apply(clock, undefined, [])
  } catch {
    return failRehearsalTargetAudit('INVALID_STATE')
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) return failRehearsalTargetAudit('INVALID_STATE')
  return value
}

/** Captures and validates the exact session/resource binding around a scan. */
function readSourceSessionObservationBinding(
  session: WorkspaceSearchMigrationRehearsalTargetAuditSession,
  configuration: WorkspaceSearchMigrationConfiguration,
  configurationHash: string,
): {
  /** Exact reviewed commit. */
  readonly commit: string
  /** Exact measured configuration hash. */
  readonly configurationHash: string
  /** Digest of the complete authenticated source session. */
  readonly sourceSessionBindingDigest: string
  /** Exact requested-resource binding. */
  readonly sourceResourceBindingDigest: string
  /** Exact authenticated permit digest. */
  readonly sourcePermitDigest: string
  /** Session-approved digest of the artifact HMAC key. */
  readonly evidenceKeyDigest: string
} {
  const sourceResourceBindingDigest =
    session.readRequestedResourcesBinding()
  const binding = readSourceSessionBinding(
    session.readRehearsalEvidenceSessionBinding(),
  )
  if (
    !isHexDigest(sourceResourceBindingDigest) ||
    binding.commit !== configuration.commit ||
    binding.configurationHash !== configurationHash
  ) {
    return failRehearsalTargetAudit('IDENTITY_MISMATCH')
  }
  return Object.freeze({
    commit: binding.commit,
    configurationHash,
    sourceSessionBindingDigest: createMigrationDigest({
      kind: 'workspace-search-migration-rehearsal-target-source-session',
      version: 1,
      sourceResourceBindingDigest,
      binding,
    }),
    sourceResourceBindingDigest,
    sourcePermitDigest: binding.attestation.permitDigest,
    evidenceKeyDigest: binding.evidenceKeyDigest,
  })
}

/** Strictly detaches one authenticated evidence-session binding. */
function readSourceSessionBinding(value: unknown): ParsedSourceSessionBinding {
  const record = targetAuditGuards.requireRecord(value)
  targetAuditGuards.requireExactKeys(record, [
    'attestation',
    'commit',
    'configurationHash',
    'evidenceKeyDigest',
    'publicationKeyDigest',
  ])
  const commit = targetAuditGuards.readOwn(record, 'commit')
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
    return failRehearsalTargetAudit('IDENTITY_MISMATCH')
  }
  const attestationRecord = targetAuditGuards.requireRecord(
    targetAuditGuards.readOwn(record, 'attestation'),
  )
  targetAuditGuards.requireExactKeys(attestationRecord, [
    'callerAttestationDigest',
    'permitDigest',
    'productionIsolationDigest',
    'resourceAttestationDigest',
    'stage',
  ])
  if (
    targetAuditGuards.readOwn(attestationRecord, 'stage') !==
      'non-production'
  ) {
    return failRehearsalTargetAudit('IDENTITY_MISMATCH')
  }
  return Object.freeze({
    commit,
    configurationHash: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'configurationHash'),
    ),
    evidenceKeyDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'evidenceKeyDigest'),
    ),
    publicationKeyDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'publicationKeyDigest'),
    ),
    attestation: Object.freeze({
      stage: 'non-production',
      permitDigest: targetAuditGuards.readDigest(
        targetAuditGuards.readOwn(attestationRecord, 'permitDigest'),
      ),
      callerAttestationDigest: targetAuditGuards.readDigest(
        targetAuditGuards.readOwn(
          attestationRecord,
          'callerAttestationDigest',
        ),
      ),
      resourceAttestationDigest: targetAuditGuards.readDigest(
        targetAuditGuards.readOwn(
          attestationRecord,
          'resourceAttestationDigest',
        ),
      ),
      productionIsolationDigest: targetAuditGuards.readDigest(
        targetAuditGuards.readOwn(
          attestationRecord,
          'productionIsolationDigest',
        ),
      ),
    }),
  })
}

/** Returns whether two pre/post scan session observations are identical. */
function sourceObservationBindingsEqual(
  left: {
    /** Exact commit. */
    readonly commit: string
    /** Exact configuration hash. */
    readonly configurationHash: string
    /** Exact session binding digest. */
    readonly sourceSessionBindingDigest: string
    /** Exact resource binding digest. */
    readonly sourceResourceBindingDigest: string
    /** Exact authenticated permit digest. */
    readonly sourcePermitDigest: string
    /** Exact evidence key digest. */
    readonly evidenceKeyDigest: string
  },
  right: {
    /** Exact commit. */
    readonly commit: string
    /** Exact configuration hash. */
    readonly configurationHash: string
    /** Exact session binding digest. */
    readonly sourceSessionBindingDigest: string
    /** Exact resource binding digest. */
    readonly sourceResourceBindingDigest: string
    /** Exact authenticated permit digest. */
    readonly sourcePermitDigest: string
    /** Exact evidence key digest. */
    readonly evidenceKeyDigest: string
  },
): boolean {
  return left.commit === right.commit &&
    left.configurationHash === right.configurationHash &&
    left.sourceSessionBindingDigest === right.sourceSessionBindingDigest &&
    left.sourceResourceBindingDigest === right.sourceResourceBindingDigest &&
    left.sourcePermitDigest === right.sourcePermitDigest &&
    left.evidenceKeyDigest === right.evidenceKeyDigest
}

/** Validates one injected page result and its exact predecessor transition. */
function validateTargetAuditPageResult(
  configurationHash: string,
  previous: WorkspaceSearchMigrationTargetScanCheckpoint,
  result: WorkspaceSearchMigrationTargetScanPageResult,
): void {
  const checkpoint = result.checkpoint
  if (checkpoint.configurationHash !== configurationHash) {
    return failRehearsalTargetAudit('CONFIGURATION_HASH_MISMATCH')
  }
  validateWorkspaceSearchMigrationTargetScanCheckpoint(
    checkpoint,
    previous,
  )
  const aggregate = checkpoint.aggregate
  const previousAggregate = previous.aggregate
  const scannedDelta = aggregate.scanned - previousAggregate.scanned
  const ownedDelta = aggregate.owned - previousAggregate.owned
  const ignoredDelta = aggregate.ignored - previousAggregate.ignored
  const invalidDelta = aggregate.invalid - previousAggregate.invalid
  if (
    !Array.isArray(result.targetRows) ||
    !Array.isArray(result.invalidRows) ||
    !Array.isArray(result.observedTargetBindings) ||
    result.targetRows.length !== ownedDelta + ignoredDelta ||
    result.invalidRows.length !== invalidDelta ||
    result.observedTargetBindings.length !== ownedDelta
  ) {
    return failRehearsalTargetAudit('INVALID_STATE')
  }
  if (aggregate.invalid !== 0 || result.invalidRows.length !== 0) {
    return failRehearsalTargetAudit('DRY_RUN_INVALID_ROWS')
  }
  const isInitialEmptyTerminalPage =
    previousAggregate.pageCount === 0 &&
    checkpoint.completed &&
    scannedDelta === 0
  if (scannedDelta === 0 && !isInitialEmptyTerminalPage) {
    return failRehearsalTargetAudit('INVALID_STATE')
  }
}

/** Creates one frozen contextual observation from a complete checkpoint. */
function createTargetAuditObservation(
  startedAt: string,
  observedAt: string,
  binding: {
    /** Exact reviewed commit. */
    readonly commit: string
    /** Exact measured configuration hash. */
    readonly configurationHash: string
    /** Exact session binding digest. */
    readonly sourceSessionBindingDigest: string
    /** Exact resource binding digest. */
    readonly sourceResourceBindingDigest: string
    /** Exact authenticated permit digest. */
    readonly sourcePermitDigest: string
    /** Exact evidence key digest. */
    readonly evidenceKeyDigest: string
  },
  checkpoint: WorkspaceSearchMigrationTargetScanCheckpoint,
): TargetAuditObservation {
  const checkpointAggregate = checkpoint.aggregate
  const aggregate = Object.freeze({
    scanned: checkpointAggregate.scanned,
    owned: checkpointAggregate.owned,
    ignored: checkpointAggregate.ignored,
    keyDigest: checkpointAggregate.keyDigest,
    contentDigest: checkpointAggregate.contentDigest,
    pageCount: checkpointAggregate.pageCount,
  })
  const aggregateDigest = createTargetAuditSemanticDigest(aggregate)
  const observationFields = {
    startedAt,
    observedAt,
    commit: binding.commit,
    configurationHash: binding.configurationHash,
    evidenceKeyDigest: binding.evidenceKeyDigest,
    sourceSessionBindingDigest: binding.sourceSessionBindingDigest,
    sourceResourceBindingDigest: binding.sourceResourceBindingDigest,
    sourcePermitDigest: binding.sourcePermitDigest,
    aggregate,
    aggregateDigest,
  }
  return Object.freeze({
    ...observationFields,
    observationDigest: createTargetAuditObservationDigest(
      observationFields,
    ),
  })
}

/** Creates the exact unsigned artifact projection covered by HMAC. */
function createUnsignedTargetAuditDocument(
  observation: TargetAuditObservation,
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  integrity: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  runtimeKeyFingerprint: string,
): UnsignedTargetAuditDocument {
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
    purpose,
    startedAt: observation.startedAt,
    observedAt: observation.observedAt,
    commit: observation.commit,
    configurationHash: observation.configurationHash,
    evidenceKeyDigest: observation.evidenceKeyDigest,
    sourceSessionBindingDigest: observation.sourceSessionBindingDigest,
    sourceResourceBindingDigest: observation.sourceResourceBindingDigest,
    integrity,
    context,
    terminal: terminal === null ? null : Object.freeze({ ...terminal }),
    aggregate: observation.aggregate,
    aggregateDigest: observation.aggregateDigest,
    observationDigest: observation.observationDigest,
    rate,
    authentication: Object.freeze({
      algorithm: 'HMAC-SHA-256',
      runtimeKeyFingerprint,
    }),
  })
}

/** Parses, canonicalizes, and authenticates one complete raw audit artifact. */
function readAuthenticatedTargetAuditDocument(
  value: unknown,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): AuthenticatedTargetAuditArtifact {
  let bytes: Uint8Array | undefined
  try {
    bytes = copyTargetAuditBytes(value)
    const byteLength = bytes.byteLength
    const contentDigest = createHash('sha256').update(bytes).digest('hex')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const parsedValue: unknown = JSON.parse(text)
    const document = readTargetAuditDocument(parsedValue)
    if (serializeCanonicalJson(document) !== text) {
      return failRehearsalTargetAudit('INVALID_ARGUMENT')
    }
    const runtimeKeyFingerprint = createTargetAuditRuntimeKeyFingerprint(
      runtimeKey,
    )
    const publicationKeyFingerprint =
      createTargetAuditPublicationKeyFingerprint(publicationKey)
    const evidenceKeyDigest = createHash('sha256')
      .update(runtimeKey)
      .digest('hex')
    if (
      !safeTargetAuditDigestEqual(
        document.authentication.runtimeKeyFingerprint,
        runtimeKeyFingerprint,
      ) ||
      !safeTargetAuditDigestEqual(
        document.authentication.publicationKeyFingerprint,
        publicationKeyFingerprint,
      ) ||
      !safeTargetAuditDigestEqual(
        document.evidenceKeyDigest,
        evidenceKeyDigest,
      ) ||
      !safeTargetAuditDigestEqual(
        document.rate.authenticationKeyFingerprint,
        createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
          runtimeKey,
        ),
      ) ||
      !safeTargetAuditDigestEqual(
        document.integrity.bindingMac,
        createTargetAuditIntegrityBindingMac(
          document.integrity,
          runtimeKey,
        ),
      )
    ) {
      return failRehearsalTargetAudit('IDENTITY_MISMATCH')
    }
    const expectedRuntimeMac = Buffer.from(
      createTargetAuditRuntimeMac(
        createUnsignedDocumentFromAuthenticated(document),
        runtimeKey,
      ),
      'hex',
    )
    const actualRuntimeMac = Buffer.from(
      document.authentication.runtimeMac,
      'hex',
    )
    if (!timingSafeEqual(expectedRuntimeMac, actualRuntimeMac)) {
      return failRehearsalTargetAudit('IDENTITY_MISMATCH')
    }
    const expectedPublicationMac = Buffer.from(
      createTargetAuditPublicationMac(
        createPublicationUnsignedTargetAuditDocument(document),
        publicationKey,
      ),
      'hex',
    )
    const actualPublicationMac = Buffer.from(
      document.authentication.publicationMac,
      'hex',
    )
    if (!timingSafeEqual(expectedPublicationMac, actualPublicationMac)) {
      return failRehearsalTargetAudit('IDENTITY_MISMATCH')
    }
    return Object.freeze({
      document,
      contentDigest,
      byteLength,
    })
  } catch (error) {
    if (error instanceof RehearsalTargetAuditFailure) throw error
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  } finally {
    zeroizeBytes(bytes)
  }
}

/**
 * Authenticates one canonical artifact and derives its exact binding once.
 *
 * @param value - Candidate exact canonical artifact bytes.
 * @param runtimeKey - Detached exact 32-byte runtime HMAC key.
 * @param publicationKey - Detached exact 32-byte parent HMAC key.
 * @returns Frozen authenticated document and identifier-free binding.
 */
function readBoundAuthenticatedTargetAuditArtifact(
  value: unknown,
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): BoundAuthenticatedTargetAuditArtifact {
  const artifact = readAuthenticatedTargetAuditDocument(
    value,
    runtimeKey,
    publicationKey,
  )
  return Object.freeze({
    artifact,
    binding: createTargetAuditArtifactBinding(artifact),
  })
}

/** Creates one rich stage-chain binding from an authenticated raw artifact. */
function createTargetAuditArtifactBinding(
  artifact: AuthenticatedTargetAuditArtifact,
): WorkspaceSearchMigrationRehearsalTargetAuditArtifactBinding {
  const document = artifact.document
  return Object.freeze({
    contentDigest: artifact.contentDigest,
    byteLength: artifact.byteLength,
    purpose: document.purpose,
    startedAt: document.startedAt,
    observedAt: document.observedAt,
    commit: document.commit,
    configurationHash: document.configurationHash,
    evidenceKeyDigest: document.evidenceKeyDigest,
    sourceSessionBindingDigest: document.sourceSessionBindingDigest,
    sourceResourceBindingDigest: document.sourceResourceBindingDigest,
    integrity: document.integrity,
    context: document.context,
    terminal: document.terminal,
    aggregate: Object.freeze({ ...document.aggregate }),
    aggregateDigest: document.aggregateDigest,
    observationDigest: document.observationDigest,
    rate: document.rate,
  })
}

/** Strictly reads one complete target-audit document. */
function readTargetAuditDocument(value: unknown): TargetAuditDocument {
  const record = targetAuditGuards.requireRecord(value)
  targetAuditGuards.requireExactKeys(record, [
    'aggregate',
    'aggregateDigest',
    'authentication',
    'commit',
    'configurationHash',
    'context',
    'evidenceKeyDigest',
    'integrity',
    'kind',
    'observationDigest',
    'observedAt',
    'purpose',
    'rate',
    'sourceResourceBindingDigest',
    'sourceSessionBindingDigest',
    'startedAt',
    'terminal',
    'version',
  ])
  if (
    targetAuditGuards.readOwn(record, 'kind') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND ||
    targetAuditGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION
  ) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  const purpose = readTargetAuditPurpose(
    targetAuditGuards.readOwn(record, 'purpose'),
  )
  const startedAt = targetAuditGuards.readTimestamp(
    targetAuditGuards.readOwn(record, 'startedAt'),
  )
  const observedAt = targetAuditGuards.readTimestamp(
    targetAuditGuards.readOwn(record, 'observedAt'),
  )
  const commit = targetAuditGuards.readOwn(record, 'commit')
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit)) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  const configurationHash = targetAuditGuards.readDigest(
    targetAuditGuards.readOwn(record, 'configurationHash'),
  )
  const evidenceKeyDigest = targetAuditGuards.readDigest(
    targetAuditGuards.readOwn(record, 'evidenceKeyDigest'),
  )
  const sourceSessionBindingDigest = targetAuditGuards.readDigest(
    targetAuditGuards.readOwn(record, 'sourceSessionBindingDigest'),
  )
  const sourceResourceBindingDigest = targetAuditGuards.readDigest(
    targetAuditGuards.readOwn(record, 'sourceResourceBindingDigest'),
  )
  const context = readTargetAuditContext(
    targetAuditGuards.readOwn(record, 'context'),
  )
  const terminal = readTargetAuditTerminal(
    targetAuditGuards.readOwn(record, 'terminal'),
    purpose,
  )
  requirePurposeContext(purpose, context, terminal)
  requireTargetAuditObservationWindow(
    purpose,
    startedAt,
    observedAt,
    terminal,
    'INVALID_ARGUMENT',
  )
  const integrity = readTargetAuditIntegrity(
    targetAuditGuards.readOwn(record, 'integrity'),
    purpose,
    observedAt,
    terminal,
  )
  const rate = readWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
    targetAuditGuards.readOwn(record, 'rate'),
  )
  const aggregate = readTargetAuditAggregate(
    targetAuditGuards.readOwn(record, 'aggregate'),
  )
  const aggregateDigest = targetAuditGuards.readDigest(
    targetAuditGuards.readOwn(record, 'aggregateDigest'),
  )
  if (createTargetAuditSemanticDigest(aggregate) !== aggregateDigest) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  if (
    configurationHash !== context.configurationBindingDigest ||
    sourceResourceBindingDigest !== context.requestedResourcesBinding ||
    integrity.configurationBindingDigest !==
      context.configurationBindingDigest ||
    integrity.policyVersion !== context.policyVersion ||
    integrity.result.resourceIdentityDigest !==
      context.integrityResourceIdentityDigest ||
    rate.link.configurationBindingDigest !==
      context.configurationBindingDigest ||
    rate.link.policyVersion !== context.policyVersion ||
    !sameVerifiedTargetAuditRateSegment(
      integrity.predecessor,
      rate.predecessor,
    ) ||
    !sameVerifiedTargetAuditRateSegment(
      integrity.segment,
      rate.successor,
    ) ||
    Date.parse(rate.completedAt) < Date.parse(observedAt)
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
  const observationDigest = targetAuditGuards.readDigest(
    targetAuditGuards.readOwn(record, 'observationDigest'),
  )
  if (
    createTargetAuditObservationDigest({
      startedAt,
      observedAt,
      commit,
      configurationHash,
      evidenceKeyDigest,
      sourceSessionBindingDigest,
      sourcePermitDigest: context.permitDigest,
      sourceResourceBindingDigest,
      aggregate,
      aggregateDigest,
    }) !== observationDigest
  ) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  return Object.freeze({
    kind: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_KIND,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_VERSION,
    purpose,
    startedAt,
    observedAt,
    commit,
    configurationHash,
    evidenceKeyDigest,
    sourceSessionBindingDigest,
    sourceResourceBindingDigest,
    integrity,
    context,
    terminal,
    aggregate,
    aggregateDigest,
    observationDigest,
    rate,
    authentication: readTargetAuditAuthentication(
      targetAuditGuards.readOwn(record, 'authentication'),
    ),
  })
}

/** Reads one exact target-audit aggregate. */
function readTargetAuditAggregate(
  value: unknown,
): WorkspaceSearchMigrationRehearsalTargetAuditAggregate {
  const record = targetAuditGuards.requireRecord(value)
  targetAuditGuards.requireExactKeys(record, [
    'contentDigest',
    'ignored',
    'keyDigest',
    'owned',
    'pageCount',
    'scanned',
  ])
  const scanned = readNonNegativeInteger(
    targetAuditGuards.readOwn(record, 'scanned'),
  )
  const owned = readNonNegativeInteger(
    targetAuditGuards.readOwn(record, 'owned'),
  )
  const ignored = readNonNegativeInteger(
    targetAuditGuards.readOwn(record, 'ignored'),
  )
  const pageCount = readPositiveInteger(
    targetAuditGuards.readOwn(record, 'pageCount'),
  )
  if (owned + ignored !== scanned) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  return Object.freeze({
    scanned,
    owned,
    ignored,
    keyDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'keyDigest'),
    ),
    contentDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'contentDigest'),
    ),
    pageCount,
  })
}

/** Reads exact target-audit HMAC metadata. */
function readTargetAuditAuthentication(
  value: unknown,
): TargetAuditAuthentication {
  const record = targetAuditGuards.requireRecord(value)
  targetAuditGuards.requireExactKeys(record, [
    'algorithm',
    'publicationKeyFingerprint',
    'publicationMac',
    'runtimeKeyFingerprint',
    'runtimeMac',
  ])
  if (
    targetAuditGuards.readOwn(record, 'algorithm') !== 'HMAC-SHA-256'
  ) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  return Object.freeze({
    algorithm: 'HMAC-SHA-256',
    runtimeKeyFingerprint: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'runtimeKeyFingerprint'),
    ),
    runtimeMac: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'runtimeMac'),
    ),
    publicationKeyFingerprint: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'publicationKeyFingerprint'),
    ),
    publicationMac: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'publicationMac'),
    ),
  })
}

/** Strictly reads the parent-authenticated close-replan provenance. */
function readTargetAuditContext(
  value: unknown,
): WorkspaceSearchMigrationRehearsalTargetAuditContext {
  const record = targetAuditGuards.requireRecord(value)
  targetAuditGuards.requireExactKeys(record, [
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
  const scenario = targetAuditGuards.readOwn(record, 'scenario')
  if (
    scenario !== 'partial-apply-rollback' &&
    scenario !== 'complete-apply-rollback'
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
  return Object.freeze({
    scenario,
    runLocatorDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'runLocatorDigest'),
    ),
    manifestDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'manifestDigest'),
    ),
    permitDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'permitDigest'),
    ),
    requestedResourcesBinding: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'requestedResourcesBinding'),
    ),
    configurationBindingDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'configurationBindingDigest'),
    ),
    policyVersion: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'policyVersion'),
    ),
    integrityResourceIdentityDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(
        record,
        'integrityResourceIdentityDigest',
      ),
    ),
    planningReceiptDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'planningReceiptDigest'),
    ),
    executionBoundaryDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'executionBoundaryDigest'),
    ),
    sealedPlanningAuthorityDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    planDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'planDigest'),
    ),
    writerFenceDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'writerFenceDigest'),
    ),
  })
}

/** Requires one purpose and terminal to match the common scenario context. */
function requirePurposeContext(
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  context: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
): void {
  const partial = purpose.startsWith('partial-rollback-')
  const expectedScenario = partial
    ? 'partial-apply-rollback'
    : 'complete-apply-rollback'
  if (
    context.scenario !== expectedScenario ||
    (terminal !== null && terminal.scenario !== expectedScenario)
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
}

/**
 * Requires the complete target read to remain on the correct terminal side.
 *
 * @param purpose - Fixed baseline or restored target purpose.
 * @param startedAt - Trusted sample before the first external target read.
 * @param observedAt - Trusted sample after the complete target observation.
 * @param terminal - Purpose-correlated rollback terminal or null.
 * @param failureCode - Stable caller-appropriate failure classification.
 */
function requireTargetAuditObservationWindow(
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  startedAt: string,
  observedAt: string,
  terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
  failureCode: WorkspaceSearchMigrationRehearsalTargetAuditFailureCode,
): void {
  if (Date.parse(startedAt) > Date.parse(observedAt)) {
    return failRehearsalTargetAudit(failureCode)
  }
  if (
    (purpose === 'partial-rollback-restored' ||
      purpose === 'complete-rollback-restored') &&
    (
      terminal === null ||
      Date.parse(startedAt) <= Date.parse(terminal.terminalAt)
    )
  ) return failRehearsalTargetAudit(failureCode)
}

/** Compares every parent-authenticated close-replan provenance field. */
function sameTargetAuditContext(
  left: WorkspaceSearchMigrationRehearsalTargetAuditContext,
  right: WorkspaceSearchMigrationRehearsalTargetAuditContext,
): boolean {
  return left.scenario === right.scenario &&
    left.runLocatorDigest === right.runLocatorDigest &&
    left.manifestDigest === right.manifestDigest &&
    left.permitDigest === right.permitDigest &&
    left.requestedResourcesBinding === right.requestedResourcesBinding &&
    left.configurationBindingDigest === right.configurationBindingDigest &&
    left.policyVersion === right.policyVersion &&
    left.integrityResourceIdentityDigest ===
      right.integrityResourceIdentityDigest &&
    left.planningReceiptDigest === right.planningReceiptDigest &&
    left.executionBoundaryDigest === right.executionBoundaryDigest &&
    left.sealedPlanningAuthorityDigest ===
      right.sealedPlanningAuthorityDigest &&
    left.planDigest === right.planDigest &&
    left.writerFenceDigest === right.writerFenceDigest
}

/** Reads and validates one purpose-specific terminal binding. */
function readTargetAuditTerminal(
  value: unknown,
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
): WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null {
  if (
    purpose === 'partial-rollback-preimage' ||
    purpose === 'complete-rollback-preimage'
  ) {
    if (value !== null) {
      return failRehearsalTargetAudit('INVALID_ARGUMENT')
    }
    return null
  }
  const record = targetAuditGuards.requireRecord(value)
  targetAuditGuards.requireExactKeys(record, [
    'applyStartedAt',
    'kind',
    'rootDigest',
    'scenario',
    'terminalAt',
    'version',
  ])
  const rootDigest = targetAuditGuards.readDigest(
    targetAuditGuards.readOwn(record, 'rootDigest'),
  )
  const applyStartedAt = targetAuditGuards.readTimestamp(
    targetAuditGuards.readOwn(record, 'applyStartedAt'),
  )
  const terminalAt = targetAuditGuards.readTimestamp(
    targetAuditGuards.readOwn(record, 'terminalAt'),
  )
  if (Date.parse(applyStartedAt) > Date.parse(terminalAt)) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  if (purpose === 'complete-rollback-restored') {
    if (
      targetAuditGuards.readOwn(record, 'scenario') !==
        'complete-apply-rollback' ||
      targetAuditGuards.readOwn(record, 'kind') !== 'rolled-back' ||
      targetAuditGuards.readOwn(record, 'version') !== 1
    ) {
      return failRehearsalTargetAudit('INVALID_ARGUMENT')
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
  if (
    targetAuditGuards.readOwn(record, 'scenario') !==
      'partial-apply-rollback' ||
    targetAuditGuards.readOwn(record, 'kind') !== 'rolled-back' ||
    targetAuditGuards.readOwn(record, 'version') !== 2
  ) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  return Object.freeze({
    scenario: 'partial-apply-rollback',
    kind: 'rolled-back',
    version: 2,
    rootDigest,
    applyStartedAt,
    terminalAt,
  })
}

/** Compares two purpose-validated terminal bindings exactly. */
function sameTargetAuditTerminal(
  left:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
  right:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
): boolean {
  if (left === null || right === null) return left === right
  return left.scenario === right.scenario &&
    left.kind === right.kind &&
    left.version === right.version &&
    left.rootDigest === right.rootDigest &&
    left.applyStartedAt === right.applyStartedAt &&
    left.terminalAt === right.terminalAt
}

/** Reads one exact finite target-audit purpose. */
function readTargetAuditPurpose(
  value: unknown,
): WorkspaceSearchMigrationRehearsalTargetAuditPurpose {
  if (
    value === 'partial-rollback-preimage' ||
    value === 'partial-rollback-restored' ||
    value === 'complete-rollback-preimage' ||
    value === 'complete-rollback-restored'
  ) {
    return value
  }
  return failRehearsalTargetAudit('INVALID_ARGUMENT')
}

/** Reads one exact rollback preimage purpose and rejects restored artifacts. */
function readTargetPreimagePurpose(
  value: unknown,
): WorkspaceSearchMigrationRehearsalTargetPreimagePurpose {
  if (
    value === 'partial-rollback-preimage' ||
    value === 'complete-rollback-preimage'
  ) return value
  return failRehearsalTargetAudit('INVALID_ARGUMENT')
}

/**
 * Consumes one genuine same-process rate-bound #163 result exactly once.
 *
 * @param value - Candidate one-shot result from the live rate finalizer.
 * @param purpose - Fixed target-audit semantic purpose.
 * @param terminal - Purpose-bound rollback terminal, if restored.
 * @returns Detached strict rate-bound live-result projection.
 */
function consumeTargetAuditIntegrity(
  value: unknown,
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult {
  let consumed: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
  try {
    consumed =
      consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(value)
  } catch {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  const integrity = readTargetAuditIntegrityProjection(consumed)
  if (
    (purpose === 'partial-rollback-restored' ||
      purpose === 'complete-rollback-restored') &&
    (
      terminal === null ||
      Date.parse(integrity.result.runtimeProvenance.startedAt) <
        Date.parse(terminal.terminalAt)
    )
  ) return failRehearsalTargetAudit('INVALID_STATE')
  return integrity
}

/**
 * Reads one complete rate-bound #163 projection from an authenticated audit.
 *
 * @param value - Candidate published rate-bound live-result projection.
 * @param purpose - Fixed target-audit semantic purpose.
 * @param observedAt - Canonical completion of the target observation.
 * @param terminal - Purpose-bound rollback terminal, if restored.
 * @returns Strict detached rate-bound live-result projection.
 */
function readTargetAuditIntegrity(
  value: unknown,
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  observedAt: string,
  terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult {
  const integrity = readTargetAuditIntegrityProjection(value)
  requireTargetAuditIntegrityWindow(
    integrity,
    purpose,
    observedAt,
    terminal,
    'INVALID_ARGUMENT',
  )
  return integrity
}

/** Strictly reads every public field of one rate-bound live result. */
function readTargetAuditIntegrityProjection(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult {
  const record = targetAuditGuards.requireRecord(value)
  targetAuditGuards.requireExactKeys(record, [
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
    targetAuditGuards.readOwn(record, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result' ||
    targetAuditGuards.readOwn(record, 'version') !== 1
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
  let result: WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection
  try {
    result =
      readWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
        targetAuditGuards.readOwn(record, 'result'),
      )
  } catch {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  const predecessor = readTargetPreimageRatePredecessor(
    targetAuditGuards.readOwn(record, 'predecessor'),
  )
  const segment = readTargetPreimageRatePredecessor(
    targetAuditGuards.readOwn(record, 'segment'),
  )
  const interval = readTargetAuditIntegrityInterval(
    targetAuditGuards.readOwn(record, 'interval'),
  )
  const segmentLastEventSequence =
    segment.firstEventSequence + segment.eventCount - 1
  const expectedSegmentFirstEventSequence =
    predecessor.firstEventSequence + predecessor.eventCount
  if (
    predecessor.authenticationKeyFingerprint !==
      segment.authenticationKeyFingerprint ||
    segment.segmentOrdinal !== predecessor.segmentOrdinal + 1 ||
    segment.segmentLocatorDigest === predecessor.segmentLocatorDigest ||
    !Number.isSafeInteger(expectedSegmentFirstEventSequence) ||
    segment.firstEventSequence !== expectedSegmentFirstEventSequence ||
    segment.eventCount === 0 ||
    !Number.isSafeInteger(segmentLastEventSequence) ||
    interval.firstEventSequence < segment.firstEventSequence ||
    interval.lastEventSequence > segmentLastEventSequence ||
    Date.parse(interval.startedAt) <
      Date.parse(result.runtimeProvenance.startedAt) ||
    Date.parse(interval.completedAt) >
      Date.parse(result.runtimeProvenance.completedAt)
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
  return Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result',
    version: 1,
    result,
    predecessor,
    segment,
    interval,
    policyVersion: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'policyVersion'),
    ),
    configurationBindingDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'configurationBindingDigest'),
    ),
    tableOrderBindingMac: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'tableOrderBindingMac'),
    ),
    bindingMac: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'bindingMac'),
    ),
  })
}

/** Strictly reads one complete two-pass integrity rate interval. */
function readTargetAuditIntegrityInterval(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityRateInterval {
  const record = targetAuditGuards.requireRecord(value)
  targetAuditGuards.requireExactKeys(record, [
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
    targetAuditGuards.readOwn(record, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval' ||
    targetAuditGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION ||
    targetAuditGuards.readOwn(record, 'phase') !== 'integrity-check' ||
    targetAuditGuards.readOwn(record, 'tablePassCount') !== 2 ||
    targetAuditGuards.readOwn(record, 'describeTableCallCount') !== 12
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
  const attemptSequences = readTargetAuditSequenceVector(
    targetAuditGuards.readOwn(record, 'attemptSequences'),
    12,
    12,
  )
  const eventSequences = readTargetAuditSequenceVector(
    targetAuditGuards.readOwn(record, 'eventSequences'),
    24,
    100_000,
  )
  const firstAttemptSequence = readPositiveInteger(
    targetAuditGuards.readOwn(record, 'firstAttemptSequence'),
  )
  const lastAttemptSequence = readPositiveInteger(
    targetAuditGuards.readOwn(record, 'lastAttemptSequence'),
  )
  const firstEventSequence = readPositiveInteger(
    targetAuditGuards.readOwn(record, 'firstEventSequence'),
  )
  const lastEventSequence = readPositiveInteger(
    targetAuditGuards.readOwn(record, 'lastEventSequence'),
  )
  const cadenceWaitCount = readNonNegativeInteger(
    targetAuditGuards.readOwn(record, 'cadenceWaitCount'),
  )
  const cadenceWaitMilliseconds = readNonNegativeInteger(
    targetAuditGuards.readOwn(record, 'cadenceWaitMilliseconds'),
  )
  const startedAt = targetAuditGuards.readTimestamp(
    targetAuditGuards.readOwn(record, 'startedAt'),
  )
  const completedAt = targetAuditGuards.readTimestamp(
    targetAuditGuards.readOwn(record, 'completedAt'),
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
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
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

/** Reads one exact ordinary dense positive-integer sequence vector. */
function readTargetAuditSequenceVector(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): readonly number[] {
  if (
    nodeUtilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
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
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== length + 1 || ownKeys[length] !== 'length') {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  const detached: number[] = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    if (ownKeys[index] !== key) {
      return failRehearsalTargetAudit('INVALID_ARGUMENT')
    }
    detached.push(readPositiveInteger(
      targetAuditGuards.readOwn(value, key),
    ))
  }
  return Object.freeze(detached)
}

/** Requires the live result to occupy the audit's purpose-bound time window. */
function requireTargetAuditIntegrityWindow(
  integrity: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  purpose: WorkspaceSearchMigrationRehearsalTargetAuditPurpose,
  observedAt: string,
  terminal:
    WorkspaceSearchMigrationRehearsalTargetAuditTerminalBinding | null,
  failureCode: WorkspaceSearchMigrationRehearsalTargetAuditFailureCode =
    'INVALID_STATE',
): void {
  if (
    Date.parse(integrity.result.runtimeProvenance.completedAt) >
      Date.parse(observedAt) ||
    (
      purpose === 'partial-rollback-restored' ||
      purpose === 'complete-rollback-restored'
    ) &&
      (
        terminal === null ||
        Date.parse(integrity.result.runtimeProvenance.startedAt) <
          Date.parse(terminal.terminalAt)
      )
  ) return failRehearsalTargetAudit(failureCode)
}

/** Recreates the unsigned authenticated document projection. */
function createUnsignedDocumentFromAuthenticated(
  document: TargetAuditDocument,
): UnsignedTargetAuditDocument {
  return Object.freeze({
    kind: document.kind,
    version: document.version,
    purpose: document.purpose,
    startedAt: document.startedAt,
    observedAt: document.observedAt,
    commit: document.commit,
    configurationHash: document.configurationHash,
    evidenceKeyDigest: document.evidenceKeyDigest,
    sourceSessionBindingDigest: document.sourceSessionBindingDigest,
    sourceResourceBindingDigest: document.sourceResourceBindingDigest,
    integrity: document.integrity,
    context: document.context,
    terminal: document.terminal,
    aggregate: document.aggregate,
    aggregateDigest: document.aggregateDigest,
    observationDigest: document.observationDigest,
    rate: document.rate,
    authentication: Object.freeze({
      algorithm: document.authentication.algorithm,
      runtimeKeyFingerprint:
        document.authentication.runtimeKeyFingerprint,
    }),
  })
}

/** Recreates the exact projection covered by the parent publication HMAC. */
function createPublicationUnsignedTargetAuditDocument(
  document: TargetAuditDocument,
): PublicationUnsignedTargetAuditDocument {
  return Object.freeze({
    ...createUnsignedDocumentFromAuthenticated(document),
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

/** Strictly reads all nine fields of one parent-owned rate predecessor. */
function readTargetPreimageRatePredecessor(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const record = targetAuditGuards.requireRecord(value)
  targetAuditGuards.requireExactKeys(record, [
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
  const eventCount = readNonNegativeInteger(
    targetAuditGuards.readOwn(record, 'eventCount'),
  )
  const firstValue = targetAuditGuards.readOwn(
    record,
    'firstCommittedEventSequence',
  )
  const lastValue = targetAuditGuards.readOwn(
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
    targetAuditGuards.readOwn(record, 'firstEventSequence'),
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
  ) return failRehearsalTargetAudit('INVALID_ARGUMENT')
  return Object.freeze({
    authenticationKeyFingerprint: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'authenticationKeyFingerprint'),
    ),
    segmentLocatorDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'segmentLocatorDigest'),
    ),
    segmentOrdinal: readNonNegativeInteger(
      targetAuditGuards.readOwn(record, 'segmentOrdinal'),
    ),
    firstEventSequence,
    eventCount,
    firstCommittedEventSequence,
    lastCommittedEventSequence,
    terminalRecordMac: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'terminalRecordMac'),
    ),
    segmentDigest: targetAuditGuards.readDigest(
      targetAuditGuards.readOwn(record, 'segmentDigest'),
    ),
  })
}

/** Compares all nine authenticated rate-segment summary fields exactly. */
function sameVerifiedTargetAuditRateSegment(
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

/** Digests the pagination-independent semantic target projection. */
function createTargetAuditSemanticDigest(
  aggregate: WorkspaceSearchMigrationRehearsalTargetAuditAggregate,
): string {
  return createMigrationDigest({
    scanned: aggregate.scanned,
    owned: aggregate.owned,
    ignored: aggregate.ignored,
    keyDigest: aggregate.keyDigest,
    contentDigest: aggregate.contentDigest,
  })
}

/** Digests all actual observation context including page measurement. */
function createTargetAuditObservationDigest(
  observation: {
    /** Canonical sample before the first external target read. */
    readonly startedAt: string
    /** Canonical observation completion time. */
    readonly observedAt: string
    /** Exact reviewed commit. */
    readonly commit: string
    /** Exact measured configuration hash. */
    readonly configurationHash: string
    /** SHA-256 digest of the session-approved runtime HMAC key. */
    readonly evidenceKeyDigest: string
    /** Exact source session binding digest. */
    readonly sourceSessionBindingDigest: string
    /** Exact permit digest observed through the source session. */
    readonly sourcePermitDigest: string
    /** Exact requested-resource binding digest. */
    readonly sourceResourceBindingDigest: string
    /** Exact target audit aggregate. */
    readonly aggregate: WorkspaceSearchMigrationRehearsalTargetAuditAggregate
    /** Pagination-independent aggregate digest. */
    readonly aggregateDigest: string
  },
): string {
  return createMigrationDigest({
    kind: 'workspace-search-migration-rehearsal-target-observation',
    version: 2,
    startedAt: observation.startedAt,
    observedAt: observation.observedAt,
    commit: observation.commit,
    configurationHash: observation.configurationHash,
    evidenceKeyDigest: observation.evidenceKeyDigest,
    sourceSessionBindingDigest: observation.sourceSessionBindingDigest,
    sourcePermitDigest: observation.sourcePermitDigest,
    sourceResourceBindingDigest: observation.sourceResourceBindingDigest,
    aggregate: observation.aggregate,
    aggregateDigest: observation.aggregateDigest,
  })
}

/** Requires runtime and parent publication authority to use distinct keys. */
function requireDistinctTargetAuditKeys(
  runtimeKey: Uint8Array,
  publicationKey: Uint8Array,
): void {
  if (timingSafeEqual(runtimeKey, publicationKey)) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
}

/** Compares two fixed-size lowercase digests without timing leakage. */
function safeTargetAuditDigestEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Creates the domain-separated fingerprint of the runtime HMAC key. */
function createTargetAuditRuntimeKeyFingerprint(key: Uint8Array): string {
  return createHmac('sha256', key)
    .update(targetAuditRuntimeKeyFingerprintDomain, 'utf8')
    .digest('hex')
}

/** Creates the runtime HMAC over the complete semantic target audit. */
function createTargetAuditRuntimeMac(
  document: UnsignedTargetAuditDocument,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(targetAuditRuntimeMacDomain, 'utf8')
    .update(serializeCanonicalJson(document), 'utf8')
    .digest('hex')
}

/** Recomputes the embedded rate-bound result HMAC with the runtime key. */
function createTargetAuditIntegrityBindingMac(
  integrity: WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  key: Uint8Array,
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
  return createHmac('sha256', key)
    .update(targetAuditIntegrityBindingMacDomain, 'utf8')
    .update(serializeCanonicalJson(claims), 'utf8')
    .digest('hex')
}

/** Creates the domain-separated fingerprint of the parent publication key. */
function createTargetAuditPublicationKeyFingerprint(
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(targetAuditPublicationKeyFingerprintDomain, 'utf8')
    .digest('hex')
}

/** Creates the parent HMAC over the runtime-authenticated target audit. */
function createTargetAuditPublicationMac(
  document: PublicationUnsignedTargetAuditDocument,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(targetAuditPublicationMacDomain, 'utf8')
    .update(serializeCanonicalJson(document), 'utf8')
    .digest('hex')
}

/** Copies one exact ordinary 32-byte authentication key. */
function copyTargetAuditKey(value: unknown): Uint8Array {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value) ||
    nodeUtilTypes.isSharedArrayBuffer(
      targetAuditGuards.readIntrinsicBuffer(value),
    ) ||
    targetAuditGuards.readIntrinsicByteLength(value) !==
      targetAuditKeyByteLength
  ) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  const copy = new Uint8Array(targetAuditKeyByteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copy, [value])
  } catch {
    zeroizeBytes(copy)
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  return copy
}

/** Copies one exact bounded target-audit artifact without aliases. */
function copyTargetAuditBytes(value: unknown): Uint8Array {
  if (
    !nodeUtilTypes.isUint8Array(value) ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  const buffer = targetAuditGuards.readIntrinsicBuffer(value)
  const byteLength = targetAuditGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength <= 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_TARGET_AUDIT_MAX_BYTES
  ) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  const copy = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copy, [value])
  } catch {
    zeroizeBytes(copy)
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  return copy
}

/** Reads one canonical timestamp from a trusted native Date-returning clock. */
function readTrustedClock(clock: () => Date): string {
  try {
    const value: unknown = Reflect.apply(clock, undefined, [])
    if (!(value instanceof Date) || nodeUtilTypes.isProxy(value)) {
      return failRehearsalTargetAudit('INVALID_ARGUMENT')
    }
    const milliseconds = Reflect.apply(Date.prototype.getTime, value, [])
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds)) {
      return failRehearsalTargetAudit('INVALID_ARGUMENT')
    }
    return new Date(milliseconds).toISOString()
  } catch (error) {
    if (error instanceof RehearsalTargetAuditFailure) throw error
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
}

/** Reads one non-negative safe integer. */
function readNonNegativeInteger(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failRehearsalTargetAudit('INVALID_ARGUMENT')
  }
  return value
}

/** Reads one positive safe integer. */
function readPositiveInteger(value: unknown): number {
  const parsed = readNonNegativeInteger(value)
  if (parsed === 0) return failRehearsalTargetAudit('INVALID_ARGUMENT')
  return parsed
}

/** Best-effort overwrites one caller-owned or working byte buffer. */
function zeroizeBytes(value: Uint8Array | undefined): void {
  if (value === undefined || nodeUtilTypes.isProxy(value)) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    // Stable public boundaries replace malformed caller values.
  }
}

/** Raises one privately classified target-audit failure. */
function failRehearsalTargetAudit(
  code: WorkspaceSearchMigrationRehearsalTargetAuditFailureCode,
): never {
  throw new RehearsalTargetAuditFailure(code)
}

/** Throws a stable public failure from a directly invoked opaque constructor. */
function throwPublicTargetAuditFailure(
  code: WorkspaceSearchMigrationFailureCode,
): never {
  throw new WorkspaceSearchMigrationFailure(
    code,
    'Workspace Search migration rehearsal target audit failed.',
  )
}

/** Replaces every audit-boundary failure with one operator-safe failure. */
function replaceRehearsalTargetAuditFailure(error: unknown): never {
  let code: WorkspaceSearchMigrationFailureCode = 'INVALID_STATE'
  if (
    error instanceof RehearsalTargetAuditFailure ||
    error instanceof WorkspaceSearchMigrationFailure
  ) {
    code = error.code
  }
  return throwPublicTargetAuditFailure(code)
}
