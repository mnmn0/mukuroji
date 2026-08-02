import { createHmac, timingSafeEqual } from 'node:crypto'
import { types } from 'node:util'
import {
  CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
} from '../../data-integrity/cross-domain-integrity'
import {
  createMigrationDigest,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'
import {
  readWorkspaceSearchMigrationRehearsalRateSegmentEvidence,
  type WorkspaceSearchMigrationRehearsalRateAggregate,
  type WorkspaceSearchMigrationRehearsalRateEvidence,
  type WorkspaceSearchMigrationRehearsalRateSegmentEvidence,
} from './migration-rehearsal-rate-evidence'
import {
  readWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
  sameWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
  type WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
} from './migration-rehearsal-integrity-evidence'
import type {
  WorkspaceSearchMigrationRehearsalFailpoint,
} from './migration-rehearsal-faults'

export type {
  WorkspaceSearchMigrationRehearsalFailpoint,
} from './migration-rehearsal-faults'

export type {
  WorkspaceSearchMigrationRehearsalRateAggregate,
  WorkspaceSearchMigrationRehearsalRateEvidence,
} from './migration-rehearsal-rate-evidence'

/** Stable discriminator for one authenticated external rehearsal evidence index. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_KIND =
  'mukuroji-workspace-search-migration-rehearsal-index'

/** First strict Workspace Search migration rehearsal evidence contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_VERSION = 1

/** Maximum canonical UTF-8 bytes accepted for one rehearsal evidence index. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_MAX_BYTES =
  256 * 1_024

/** Required scenario labels in canonical evidence order. */
export type WorkspaceSearchMigrationRehearsalScenarioName =
  | 'happy-path-verified'
  | 'cursor-before-commit-kill'
  | 'cursor-after-commit-kill'
  | 'artifact-before-checkpoint-kill'
  | 'transaction-response-loss'
  | 'lease-expiry-takeover'
  | 'partial-apply-rollback'
  | 'complete-apply-rollback'

/** Canonical complete scenario set required by contract version one. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS:
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

/** Finite process-attempt outcomes retained without raw owner identifiers. */
export type WorkspaceSearchMigrationRehearsalAttemptOutcome =
  | 'completed'
  | 'killed-at-fault'
  | 'response-loss-reconciled'
  | 'takeover-completed'

/** One ordered process attempt using only a secret-free owner locator. */
export type WorkspaceSearchMigrationRehearsalAttemptEvidence = {
  /** One-based attempt ordinal within the isolated scenario. */
  readonly ordinal: number
  /** Domain-separated digest of the restricted process attempt identifier. */
  readonly attemptLocatorDigest: string
  /** Domain-separated digest of the restricted process owner identifier. */
  readonly ownerLocatorDigest: string
  /** Domain-separated digest of the durable writer-fence token. */
  readonly writerFenceDigest: string
  /** Canonical UTC process start time. */
  readonly startedAt: string
  /** Canonical UTC completion or externally confirmed kill time. */
  readonly completedAt: string
  /** Exact bounded process outcome. */
  readonly outcome: WorkspaceSearchMigrationRehearsalAttemptOutcome
  /** Matching safe fault receipt digest, or null for an unfaulted attempt. */
  readonly faultReceiptDigest: string | null
}

/** Terminal migration evidence safe to expose outside restricted state. */
export type WorkspaceSearchMigrationRehearsalTerminalEvidence = {
  /** Finite authoritative terminal classification. */
  readonly kind: 'verified' | 'rolled-back'
  /** Persistence contract version of the authoritative terminal root. */
  readonly version: 1 | 2
  /** Digest of the complete restricted authoritative terminal root. */
  readonly rootDigest: string
  /** Digest proving that the terminal writer fence was released. */
  readonly releasedFenceDigest: string
}

/** One required interruption, recovery, or rollback rehearsal outcome. */
export type WorkspaceSearchMigrationRehearsalScenarioEvidence = {
  /** Canonical scenario label. */
  readonly name: WorkspaceSearchMigrationRehearsalScenarioName
  /** Mandatory successful rehearsal outcome. */
  readonly status: 'pass'
  /** Canonical UTC scenario start time. */
  readonly startedAt: string
  /** Canonical UTC scenario completion time. */
  readonly completedAt: string
  /** Exact injected fault boundary, or null for an uninterrupted/manual path. */
  readonly failpoint: WorkspaceSearchMigrationRehearsalFailpoint | null
  /** Digest of the safe trigger receipt, or null when no failpoint was used. */
  readonly triggerDigest: string | null
  /** Domain-separated digest of the restricted run identifier. */
  readonly runLocatorDigest: string
  /** Digest binding the supervisor receipt, process exit, and lease transition. */
  readonly lifecycleDigest: string
  /** Canonical fault-receipt time, or null for an uninterrupted scenario. */
  readonly faultReachedAt: string | null
  /** Canonical externally confirmed SIGKILL time, or null when not killed. */
  readonly killConfirmedAt: string | null
  /** Canonical predecessor lease expiry, or null when no takeover occurred. */
  readonly predecessorLeaseExpiresAt: string | null
  /** Canonical durable successor takeover time, or null without takeover. */
  readonly takeoverAcquiredAt: string | null
  /** Canonical response-loss reconciliation time, or null otherwise. */
  readonly reconciledAt: string | null
  /** Exact process attempts proving kill, restart, and fresh-owner takeover. */
  readonly attempts:
    readonly WorkspaceSearchMigrationRehearsalAttemptEvidence[]
  /** Duplicate target applications observed after reconciliation. */
  readonly duplicateApplyCount: number
  /** Expected target applications missing after reconciliation. */
  readonly lostItemCount: number
  /** Durable authorities left without an owning operation. */
  readonly orphanAuthorityCount: number
  /** Authoritative verified or rolled-back terminal projection. */
  readonly terminal: WorkspaceSearchMigrationRehearsalTerminalEvidence
}

/** Exact authenticated #163 result retained by one reconciliation summary. */
export type WorkspaceSearchMigrationRehearsalReconciliationResultEvidence = {
  /** Canonical observation time authenticated by the #163 result. */
  readonly checkedAt: string
  /** SHA-256 digest of the exact canonical #163 result bytes. */
  readonly contentDigest: string
  /** Exact positive canonical #163 result byte length. */
  readonly byteLength: number
  /** Canonical digest of the complete strictly parsed #163 result. */
  readonly resultDigest: string
  /** Whole-result HMAC retained by the authenticated #163 result. */
  readonly resultMac: string
  /** Exact live-runtime provenance authenticated by the #163 result. */
  readonly runtimeProvenance:
    WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection[
      'runtimeProvenance'
    ]
  /** Fixed immutable-incarnation scheme authenticated by the live result. */
  readonly resourceIdentityScheme:
    WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection[
      'resourceIdentityScheme'
    ]
  /** Canonical seven-entry keyed immutable resource identity vector. */
  readonly resourceIdentities:
    WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection[
      'resourceIdentities'
    ]
  /** Cross-domain aggregate authenticated inside the complete #163 result. */
  readonly integrityAggregateDigest: string
  /** Exact physical-resource identity digest authenticated by #163. */
  readonly resourceIdentityDigest: string
}

/** Passing post-terminal #163 evidence for one verified scenario. */
export type WorkspaceSearchMigrationRehearsalVerifiedReconciliationEvidence = {
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
    WorkspaceSearchMigrationRehearsalReconciliationResultEvidence
  /** Verified migration root bound by the #163 result context. */
  readonly terminalRootDigest: string
  /** Cross-domain aggregate authenticated by the #163 result. */
  readonly integrityAggregateDigest: string
  /** Digest binding the result file to its scenario and terminal context. */
  readonly resultContextDigest: string
  /** Digest of the exact migration terminal context shared with #163. */
  readonly migrationContextDigest: string
}

/** Passing before/after #163 evidence for one rollback scenario. */
export type WorkspaceSearchMigrationRehearsalRollbackReconciliationEvidence = {
  /** Fixed before/after rollback comparison discriminator. */
  readonly kind: 'rollback-comparison'
  /** Exact rollback purpose preventing cross-scenario replay. */
  readonly purpose: 'complete-rollback' | 'partial-rollback'
  /** Mandatory passing #163 comparison classification. */
  readonly status: 'pass'
  /** Mandatory absence of #163 comparison failures. */
  readonly failureCount: 0
  /** Inclusive beginning of the authenticated comparison window. */
  readonly startedAt: string
  /** Trusted apply start strictly after the complete before observation. */
  readonly applyStartedAt: string
  /** Authoritative rollback terminal strictly before the after observation. */
  readonly terminalAt: string
  /** Inclusive completion of the authenticated comparison window. */
  readonly completedAt: string
  /** Exact authenticated pre-migration #163 result binding. */
  readonly before:
    WorkspaceSearchMigrationRehearsalReconciliationResultEvidence
  /** Exact authenticated post-rollback #163 result binding. */
  readonly after:
    WorkspaceSearchMigrationRehearsalReconciliationResultEvidence
  /** Purpose-bound digest of the successful before/after comparison. */
  readonly comparisonDigest: string
  /** Digest binding the purpose, window, and exact result files. */
  readonly comparisonContextDigest: string
  /** Rolled-back migration root bound by the comparison context. */
  readonly terminalRootDigest: string
  /** Independently retained pre-apply target aggregate digest. */
  readonly targetPreimageAggregateDigest: string
  /** Independently observed post-rollback target aggregate digest. */
  readonly targetRestoredAggregateDigest: string
  /** Mandatory exact target-preimage equality classification. */
  readonly targetPreimageStatus: 'equal'
  /** Digest of the exact migration terminal context shared with #163. */
  readonly migrationContextDigest: string
}

/** Scenario-specific authenticated #163 reconciliation evidence. */
export type WorkspaceSearchMigrationRehearsalReconciliationIntegrityEvidence =
  | WorkspaceSearchMigrationRehearsalRollbackReconciliationEvidence
  | WorkspaceSearchMigrationRehearsalVerifiedReconciliationEvidence

/** Public digest-only projection of one authenticated rollback target audit. */
export type WorkspaceSearchMigrationRehearsalReconciliationTargetAuditEvidence = {
  /** Exact scenario-specific preimage or restored purpose. */
  readonly purpose:
    | 'complete-rollback-preimage'
    | 'complete-rollback-restored'
    | 'partial-rollback-preimage'
    | 'partial-rollback-restored'
  /** SHA-256 digest of the exact canonical target-audit bytes. */
  readonly contentDigest: string
  /** Exact positive canonical target-audit byte length. */
  readonly byteLength: number
  /** Canonical sample taken before the first external target read. */
  readonly startedAt: string
  /** Canonical completion time of the independently authenticated scan. */
  readonly observedAt: string
  /** Contextual digest of the observed target state. */
  readonly observationDigest: string
  /** Pagination-independent target aggregate digest. */
  readonly aggregateDigest: string
  /** Exact pre-apply #163 projection for a preimage, otherwise null. */
  readonly integrityBefore:
    WorkspaceSearchMigrationRehearsalReconciliationResultEvidence | null
  /** Digest of the full parent-authenticated target planning context. */
  readonly contextDigest: string
  /** Exact authenticated auxiliary rate segment and ledger binding. */
  readonly rate: WorkspaceSearchMigrationRehearsalRateSegmentEvidence
}

/** Public authenticated preimage/restored target pair for one rollback. */
export type WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPairEvidence = {
  /** Target state captured before apply admission. */
  readonly preimage:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditEvidence
  /** Target state captured after authoritative rollback publication. */
  readonly restored:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditEvidence
}

/** Public digest-only summary of one authenticated reconciliation artifact. */
export type WorkspaceSearchMigrationRehearsalReconciliationSummaryEvidence = {
  /** Canonical isolated rehearsal scenario. */
  readonly scenario: WorkspaceSearchMigrationRehearsalScenarioName
  /** Mandatory successful reconciliation classification. */
  readonly status: 'pass'
  /** Domain-separated digest of the restricted run identifier. */
  readonly runLocatorDigest: string
  /** Digest of the exact measured configuration and resource generation. */
  readonly configurationBindingDigest: string
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
  /** Exact complete or committed-prefix operation count applied. */
  readonly appliedOperationCount: number
  /** Canonical publication time of the authoritative terminal root. */
  readonly terminalAt: string
  /** Canonical completion after all strong reconciliation reads. */
  readonly checkedAt: string
  /** Scenario-specific terminal #163 result or rollback comparison. */
  readonly integrity:
    WorkspaceSearchMigrationRehearsalReconciliationIntegrityEvidence
  /** Authenticated target equality pair for rollback, otherwise null. */
  readonly targetAudits:
    WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPairEvidence |
    null
  /** Digest of the complete marker reconciliation summary. */
  readonly markerSummaryDigest: string
  /** Digest of the complete durable-authority reconciliation summary. */
  readonly authoritySummaryDigest: string
  /** Digest of the complete source/target reconciliation summary. */
  readonly sourceTargetSummaryDigest: string
  /** Fingerprint of the key authenticating this auxiliary rate segment. */
  readonly rateAuthenticationKeyFingerprint: string
  /** Opaque locator of this auxiliary rate segment. */
  readonly rateSegmentLocatorDigest: string
  /** Zero-based ordinal of this auxiliary rate segment. */
  readonly rateSegmentOrdinal: number
  /** Digest of the exact auxiliary rate segment. */
  readonly rateSegmentDigest: string
  /** Duplicate operation applications observed at reconciliation. */
  readonly duplicateApplyCount: 0
  /** Expected target items absent at reconciliation. */
  readonly lostItemCount: 0
  /** Durable authorities without an owning operation. */
  readonly orphanAuthorityCount: 0
  /** SHA-256 digest of the exact canonical reconciliation artifact bytes. */
  readonly contentDigest: string
  /** Exact positive canonical reconciliation artifact byte length. */
  readonly byteLength: number
  /** Digest of the complete authenticated reconciliation semantics. */
  readonly auditDigest: string
}

/** Canonical eight-scenario authenticated reconciliation evidence vector. */
export type WorkspaceSearchMigrationRehearsalReconciliationEvidence =
  readonly WorkspaceSearchMigrationRehearsalReconciliationSummaryEvidence[]

/** Exact migration alarm labels required by the non-production rehearsal. */
export type WorkspaceSearchMigrationRehearsalAlarmName =
  | 'throttle'
  | 'budget-stop'
  | 'budget-exhaustion'
  | 'checkpoint-stall'
  | 'quarantine'
  | 'terminal-failure'

/** Canonical complete alarm set required by contract version one. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS:
  readonly WorkspaceSearchMigrationRehearsalAlarmName[] = Object.freeze([
    'throttle',
    'budget-stop',
    'budget-exhaustion',
    'checkpoint-stall',
    'quarantine',
    'terminal-failure',
  ])

/** One real CloudWatch alarm transition and dual-route delivery result. */
export type WorkspaceSearchMigrationRehearsalAlarmEvidence = {
  /** Canonical alarm label. */
  readonly name: WorkspaceSearchMigrationRehearsalAlarmName
  /** Mandatory successful delivery rehearsal outcome. */
  readonly status: 'pass'
  /** State observed before the synthetic EMF signal. */
  readonly initialState: 'OK'
  /** State observed after the alarm evaluation. */
  readonly alarmState: 'ALARM'
  /** State observed after the later recovery evaluation window. */
  readonly recoveredState: 'OK'
  /** Canonical UTC time of the OK-to-ALARM history event. */
  readonly alarmObservedAt: string
  /** Canonical UTC time of the later ALARM-to-OK history event. */
  readonly recoveredAt: string
  /** Digest of the identifier-free EMF signal record. */
  readonly signalDigest: string
  /** Digest of the normalized OK-to-ALARM-to-OK history. */
  readonly historyDigest: string
  /** Digest of the normalized primary subscription receipt. */
  readonly primaryReceiptDigest: string
  /** Canonical UTC time at which the primary subscriber received ALARM. */
  readonly primaryReceivedAt: string
  /** Digest of the normalized secondary subscription receipt. */
  readonly secondaryReceiptDigest: string
  /** Canonical UTC time at which the secondary subscriber received ALARM. */
  readonly secondaryReceivedAt: string
}

/** Permit and AWS identity attestations proving non-production isolation. */
export type WorkspaceSearchMigrationRehearsalAttestationEvidence = {
  /** Exact stage authenticated by the short-lived rehearsal permit. */
  readonly stage: 'non-production'
  /** Digest of the exact authenticated short-lived permit. */
  readonly permitDigest: string
  /** Digest of the exact STS caller/account attestation. */
  readonly callerAttestationDigest: string
  /** Digest of the journal tag and requested-resource identity attestation. */
  readonly resourceAttestationDigest: string
  /** Digest of the reviewed production-resource deny proof. */
  readonly productionIsolationDigest: string
}

/** Explicit absence of a DLQ for the synchronous migration executable. */
export type WorkspaceSearchMigrationRehearsalDlqEvidence = {
  /** Fixed applicability result. */
  readonly status: 'not-applicable'
  /** Fixed execution model explaining why no DLQ exists. */
  readonly executionModel: 'synchronous-migration'
}

/** Finite child artifact labels retained by the immutable evidence index. */
export type WorkspaceSearchMigrationRehearsalArtifactKind =
  | 'scenario-results'
  | 'integrity-before'
  | 'integrity-after'
  | 'integrity-comparison'
  | 'target-preimage'
  | 'target-rollback-comparison'
  | 'rate-observations'
  | 'alarm-delivery'
  | 'lifecycle-ledger'
  | 'non-production-attestation'

/** Canonical complete child artifact set required by contract version one. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS:
  readonly WorkspaceSearchMigrationRehearsalArtifactKind[] = Object.freeze([
    'scenario-results',
    'integrity-before',
    'integrity-after',
    'integrity-comparison',
    'target-preimage',
    'target-rollback-comparison',
    'rate-observations',
    'alarm-delivery',
    'lifecycle-ledger',
    'non-production-attestation',
  ])

/** One immutable child artifact reference without bucket or object identifiers. */
export type WorkspaceSearchMigrationRehearsalArtifactEvidence = {
  /** Canonical finite artifact purpose. */
  readonly kind: WorkspaceSearchMigrationRehearsalArtifactKind
  /** Digest of the exact immutable canonical artifact bytes. */
  readonly contentDigest: string
  /** Exact canonical artifact byte length. */
  readonly byteLength: number
  /** Digest of the immutable object version identifier. */
  readonly immutableVersionDigest: string
  /** Canonical UTC Object Lock retention deadline. */
  readonly retainedUntil: string
}

/** HMAC metadata authenticating every other evidence index field. */
export type WorkspaceSearchMigrationRehearsalEvidenceAuthentication = {
  /** Fixed evidence authentication algorithm. */
  readonly algorithm: 'HMAC-SHA-256'
  /** Domain-separated fingerprint of the dedicated evidence key. */
  readonly keyFingerprint: string
  /** Domain-separated HMAC over every claim and authentication metadata field. */
  readonly indexMac: string
}

/** Complete secret-free claims authenticated by the rehearsal evidence index. */
export type WorkspaceSearchMigrationRehearsalEvidenceClaims = {
  /** Stable external evidence discriminator. */
  readonly kind: typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_KIND
  /** Strict external evidence contract version. */
  readonly contractVersion:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_VERSION
  /** Exact reviewed lowercase Git commit OID. */
  readonly commit: string
  /** Permit, STS, resource-tag, and production-isolation attestations. */
  readonly attestation:
    WorkspaceSearchMigrationRehearsalAttestationEvidence
  /** Digest of the measured migration configuration. */
  readonly configurationHash: string
  /** Digest of the reviewed DescribeTable rate-policy document. */
  readonly ratePolicyVersion: string
  /** Canonical UTC start of the complete rehearsal suite. */
  readonly startedAt: string
  /** Canonical UTC completion of the complete rehearsal suite. */
  readonly completedAt: string
  /** Exact complete scenario vector in canonical order. */
  readonly scenarios: readonly WorkspaceSearchMigrationRehearsalScenarioEvidence[]
  /** Canonical eight authenticated terminal reconciliation summaries. */
  readonly reconciliation:
    WorkspaceSearchMigrationRehearsalReconciliationEvidence
  /** Actual bounded DescribeTable rate observations. */
  readonly rate: WorkspaceSearchMigrationRehearsalRateEvidence
  /** Exact complete alarm delivery vector in canonical order. */
  readonly alarms: readonly WorkspaceSearchMigrationRehearsalAlarmEvidence[]
  /** Explicit synchronous-migration DLQ classification. */
  readonly dlq: WorkspaceSearchMigrationRehearsalDlqEvidence
  /** Exact complete immutable child artifact manifest. */
  readonly artifacts: readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[]
  /** Mandatory success after every required semantic check passes. */
  readonly overallStatus: 'pass'
}

/** Authenticated immutable Workspace Search migration rehearsal evidence index. */
export type WorkspaceSearchMigrationRehearsalEvidenceIndex =
  WorkspaceSearchMigrationRehearsalEvidenceClaims & {
    /** HMAC metadata authenticating every external evidence claim. */
    readonly authentication:
      WorkspaceSearchMigrationRehearsalEvidenceAuthentication
  }

/** Input used to authenticate one complete validated rehearsal claim set. */
export type CreateWorkspaceSearchMigrationRehearsalEvidenceInput = {
  /** Complete secret-free evidence claims. */
  readonly evidence: WorkspaceSearchMigrationRehearsalEvidenceClaims
  /** Dedicated 32-byte in-memory HMAC signing key. */
  readonly signingKey: Uint8Array
}

/** Stable raw-value-free failure raised at every evidence trust boundary. */
export class WorkspaceSearchMigrationRehearsalEvidenceError extends Error {
  /** Stable machine-readable evidence failure code. */
  readonly code = 'INVALID_MIGRATION_REHEARSAL_EVIDENCE'

  /** Creates the sole external evidence validation failure. */
  constructor() {
    super('INVALID_MIGRATION_REHEARSAL_EVIDENCE')
    this.name = 'WorkspaceSearchMigrationRehearsalEvidenceError'
  }
}

/** Exact claim fields authenticated by the version-one index. */
const claimKeys: readonly string[] = Object.freeze([
  'alarms',
  'artifacts',
  'attestation',
  'commit',
  'completedAt',
  'configurationHash',
  'contractVersion',
  'dlq',
  'kind',
  'overallStatus',
  'rate',
  'ratePolicyVersion',
  'reconciliation',
  'scenarios',
  'startedAt',
])

/** Exact authenticated index fields including HMAC metadata. */
const indexKeys: readonly string[] = Object.freeze([
  ...claimKeys,
  'authentication',
])

/** HMAC domain separating the index from every other migration artifact. */
const indexMacDomain =
  'mukuroji-workspace-search-migration-rehearsal-index/v1/index-mac\0'

/** HMAC domain separating the evidence-key fingerprint. */
const keyFingerprintDomain =
  'mukuroji-workspace-search-migration-rehearsal-index/v1/key-fingerprint\0'

/** Exact byte length of the dedicated evidence authentication key. */
const evidenceKeyByteLength = 32

/** Largest accepted count in identifier-free external evidence. */
const maximumEvidenceCount = 10_000_000

/** Largest accepted child artifact byte length. */
const maximumChildArtifactByteLength = 64 * 1_024 * 1_024

/** Largest accepted observed request rate per second. */
const maximumObservedRatePerSecond = 10_000

/** Minimum Object Lock retention required after suite completion. */
const minimumArtifactRetentionMilliseconds = 365 * 24 * 60 * 60 * 1_000

/** Strict data-property guards bound to this module's stable failure. */
const evidenceGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failEvidence,
)

/**
 * Creates and authenticates one detached rehearsal evidence index.
 *
 * @param input - Complete secret-free claims and a dedicated signing key.
 * @returns Strict evidence index carrying a domain-separated HMAC.
 */
export function createWorkspaceSearchMigrationRehearsalEvidenceIndex(
  input: CreateWorkspaceSearchMigrationRehearsalEvidenceInput,
): WorkspaceSearchMigrationRehearsalEvidenceIndex {
  try {
    let evidence: unknown
    let signingKey: unknown
    try {
      evidence = input.evidence
      signingKey = input.signingKey
    } catch {
      return failEvidence()
    }
    const claims = readClaims(evidence)
    const key = copyEvidenceKey(signingKey)
    try {
      const keyFingerprint = createKeyFingerprint(key)
      return {
        ...claims,
        authentication: {
          algorithm: 'HMAC-SHA-256',
          keyFingerprint,
          indexMac: createIndexMac(claims, keyFingerprint, key),
        },
      }
    } finally {
      key.fill(0)
    }
  } catch {
    return failEvidence()
  }
}

/**
 * Serializes one structurally valid index as bounded canonical UTF-8 JSON.
 *
 * Authentication is checked separately by the verifier so offline storage
 * adapters can preserve exact already-authenticated bytes.
 *
 * @param value - Candidate in-memory authenticated index.
 * @returns Exact canonical UTF-8 JSON bytes without a trailing newline.
 */
export function serializeWorkspaceSearchMigrationRehearsalEvidenceIndex(
  value: unknown,
): Uint8Array {
  try {
    const index = readIndex(value)
    const bytes = new TextEncoder().encode(serializeCanonicalJson(index))
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_MAX_BYTES
    ) {
      return failEvidence()
    }
    return bytes
  } catch {
    return failEvidence()
  }
}

/**
 * Parses exact bounded canonical JSON without authenticating its HMAC.
 *
 * @param value - Untrusted immutable artifact bytes.
 * @returns Detached strict evidence index ready for authentication.
 */
export function parseWorkspaceSearchMigrationRehearsalEvidenceIndex(
  value: unknown,
): WorkspaceSearchMigrationRehearsalEvidenceIndex {
  try {
    const bytes = copyEvidenceBytes(value)
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return failEvidence()
    }
    const index = readIndex(parsed)
    const canonical = new TextEncoder().encode(serializeCanonicalJson(index))
    if (!bytesEqual(bytes, canonical)) return failEvidence()
    return index
  } catch {
    return failEvidence()
  }
}

/**
 * Strictly parses and authenticates one immutable rehearsal evidence index.
 *
 * @param value - Untrusted exact canonical artifact bytes.
 * @param verificationKey - Dedicated 32-byte in-memory HMAC verification key.
 * @returns Detached authenticated evidence index.
 */
export function verifyWorkspaceSearchMigrationRehearsalEvidenceIndex(
  value: unknown,
  verificationKey: unknown,
): WorkspaceSearchMigrationRehearsalEvidenceIndex {
  try {
    const index = parseWorkspaceSearchMigrationRehearsalEvidenceIndex(value)
    const key = copyEvidenceKey(verificationKey)
    try {
      const keyFingerprint = createKeyFingerprint(key)
      const expectedMac = createIndexMac(index, keyFingerprint, key)
      if (
        index.authentication.keyFingerprint !== keyFingerprint ||
        !safeDigestEqual(index.authentication.indexMac, expectedMac)
      ) {
        return failEvidence()
      }
      return index
    } finally {
      key.fill(0)
    }
  } catch {
    return failEvidence()
  }
}

/**
 * Strictly verifies main-session attestations outside a complete index.
 *
 * @param value Candidate permit, caller, resource, and isolation claims.
 * @returns Detached exact non-production attestation evidence.
 */
export function verifyWorkspaceSearchMigrationRehearsalAttestationEvidence(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAttestationEvidence {
  try {
    return Object.freeze(readAttestation(value))
  } catch {
    return failEvidence()
  }
}

/**
 * Strictly verifies all eight authenticated reconciliation summaries.
 *
 * @param value - Candidate canonical reconciliation summary vector.
 * @returns Detached exact summaries after semantic digest reproduction.
 */
export function verifyWorkspaceSearchMigrationRehearsalReconciliationEvidence(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationEvidence {
  try {
    return Object.freeze(readReconciliation(value))
  } catch {
    return failEvidence()
  }
}

/** Reads and detaches exact claim fields. */
function readClaims(
  value: unknown,
): WorkspaceSearchMigrationRehearsalEvidenceClaims {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, claimKeys)
  return readClaimFields(record)
}

/** Reads and detaches one complete authenticated index. */
function readIndex(
  value: unknown,
): WorkspaceSearchMigrationRehearsalEvidenceIndex {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, indexKeys)
  return {
    ...readClaimFields(record),
    authentication: readAuthentication(
      evidenceGuards.readOwn(record, 'authentication'),
    ),
  }
}

/** Reads every exact claim after its parent key set was validated. */
function readClaimFields(
  record: object,
): WorkspaceSearchMigrationRehearsalEvidenceClaims {
  const kind = evidenceGuards.readOwn(record, 'kind')
  const contractVersion = evidenceGuards.readOwn(record, 'contractVersion')
  const overallStatus = evidenceGuards.readOwn(record, 'overallStatus')
  if (
    kind !== WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_KIND ||
    contractVersion !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_VERSION ||
    overallStatus !== 'pass'
  ) {
    return failEvidence()
  }
  const commit = readCommit(evidenceGuards.readOwn(record, 'commit'))
  const configurationHash = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'configurationHash'),
  )
  const ratePolicyVersion = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'ratePolicyVersion'),
  )
  const startedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'startedAt'),
  )
  const completedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'completedAt'),
  )
  if (Date.parse(startedAt) >= Date.parse(completedAt)) {
    return failEvidence()
  }
  return {
    kind,
    contractVersion,
    commit,
    attestation: readAttestation(
      evidenceGuards.readOwn(record, 'attestation'),
    ),
    configurationHash,
    ratePolicyVersion,
    startedAt,
    completedAt,
    scenarios: readScenarios(
      evidenceGuards.readOwn(record, 'scenarios'),
      startedAt,
      completedAt,
    ),
    reconciliation: readReconciliation(
      evidenceGuards.readOwn(record, 'reconciliation'),
    ),
    rate: readRate(
      evidenceGuards.readOwn(record, 'rate'),
      ratePolicyVersion,
    ),
    alarms: readAlarms(
      evidenceGuards.readOwn(record, 'alarms'),
      startedAt,
      completedAt,
    ),
    dlq: readDlq(evidenceGuards.readOwn(record, 'dlq')),
    artifacts: readArtifacts(
      evidenceGuards.readOwn(record, 'artifacts'),
      completedAt,
    ),
    overallStatus,
  }
}

/** Reads exact non-production permit and AWS identity attestations. */
function readAttestation(
  value: unknown,
): WorkspaceSearchMigrationRehearsalAttestationEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
    'callerAttestationDigest',
    'permitDigest',
    'productionIsolationDigest',
    'resourceAttestationDigest',
    'stage',
  ])
  if (evidenceGuards.readOwn(record, 'stage') !== 'non-production') {
    return failEvidence()
  }
  const permitDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'permitDigest'),
  )
  const callerAttestationDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'callerAttestationDigest'),
  )
  const resourceAttestationDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'resourceAttestationDigest'),
  )
  const productionIsolationDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'productionIsolationDigest'),
  )
  if (
    new Set([
      permitDigest,
      callerAttestationDigest,
      resourceAttestationDigest,
      productionIsolationDigest,
    ]).size !== 4
  ) {
    return failEvidence()
  }
  return {
    stage: 'non-production',
    permitDigest,
    callerAttestationDigest,
    resourceAttestationDigest,
    productionIsolationDigest,
  }
}

/** Reads the exact complete scenario vector. */
function readScenarios(
  value: unknown,
  rehearsalStartedAt: string,
  rehearsalCompletedAt: string,
): readonly WorkspaceSearchMigrationRehearsalScenarioEvidence[] {
  const values = readExactArray(
    value,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS.length,
  )
  const scenarios: WorkspaceSearchMigrationRehearsalScenarioEvidence[] = []
  const ownerLocatorDigests = new Set<string>()
  const attemptLocatorDigests = new Set<string>()
  const writerFenceDigests = new Set<string>()
  const runLocatorDigests = new Set<string>()
  const lifecycleDigests = new Set<string>()
  const triggerDigests = new Set<string>()
  const terminalRootDigests = new Set<string>()
  const releasedFenceDigests = new Set<string>()
  for (let index = 0; index < values.length; index += 1) {
    const name = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS[index]
    if (name === undefined) return failEvidence()
    scenarios.push(readScenario(
      values[index],
      name,
      rehearsalStartedAt,
      rehearsalCompletedAt,
      ownerLocatorDigests,
      attemptLocatorDigests,
      writerFenceDigests,
      runLocatorDigests,
      lifecycleDigests,
      triggerDigests,
      terminalRootDigests,
      releasedFenceDigests,
    ))
  }
  return scenarios
}

/** Reads one scenario and enforces its fixed fault and terminal semantics. */
function readScenario(
  value: unknown,
  expectedName: WorkspaceSearchMigrationRehearsalScenarioName,
  rehearsalStartedAt: string,
  rehearsalCompletedAt: string,
  ownerLocatorDigests: Set<string>,
  attemptLocatorDigests: Set<string>,
  writerFenceDigests: Set<string>,
  runLocatorDigests: Set<string>,
  lifecycleDigests: Set<string>,
  triggerDigests: Set<string>,
  terminalRootDigests: Set<string>,
  releasedFenceDigests: Set<string>,
): WorkspaceSearchMigrationRehearsalScenarioEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
    'attempts',
    'completedAt',
    'duplicateApplyCount',
    'failpoint',
    'faultReachedAt',
    'killConfirmedAt',
    'lifecycleDigest',
    'lostItemCount',
    'name',
    'orphanAuthorityCount',
    'predecessorLeaseExpiresAt',
    'reconciledAt',
    'runLocatorDigest',
    'startedAt',
    'status',
    'takeoverAcquiredAt',
    'terminal',
    'triggerDigest',
  ])
  if (
    evidenceGuards.readOwn(record, 'name') !== expectedName ||
    evidenceGuards.readOwn(record, 'status') !== 'pass'
  ) {
    return failEvidence()
  }
  const startedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'startedAt'),
  )
  const completedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'completedAt'),
  )
  if (
    Date.parse(startedAt) < Date.parse(rehearsalStartedAt) ||
    Date.parse(completedAt) > Date.parse(rehearsalCompletedAt) ||
    Date.parse(startedAt) >= Date.parse(completedAt)
  ) {
    return failEvidence()
  }
  const failpoint = expectedFailpoint(expectedName)
  if (evidenceGuards.readOwn(record, 'failpoint') !== failpoint) {
    return failEvidence()
  }
  const triggerValue = evidenceGuards.readOwn(record, 'triggerDigest')
  const triggerDigest = failpoint === null
    ? readNull(triggerValue)
    : evidenceGuards.readDigest(triggerValue)
  if (
    triggerDigest !== null &&
    triggerDigests.has(triggerDigest)
  ) {
    return failEvidence()
  }
  const runLocatorDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'runLocatorDigest'),
  )
  const lifecycleDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'lifecycleDigest'),
  )
  if (
    runLocatorDigests.has(runLocatorDigest) ||
    lifecycleDigests.has(lifecycleDigest)
  ) {
    return failEvidence()
  }
  const lifecycle = readScenarioLifecycle(
    record,
    expectedName,
    startedAt,
    completedAt,
  )
  const attempts = readScenarioAttempts(
    evidenceGuards.readOwn(record, 'attempts'),
    expectedName,
    startedAt,
    completedAt,
    triggerDigest,
    ownerLocatorDigests,
    attemptLocatorDigests,
    writerFenceDigests,
    lifecycle,
  )
  if (
    evidenceGuards.readOwn(record, 'duplicateApplyCount') !== 0 ||
    evidenceGuards.readOwn(record, 'lostItemCount') !== 0 ||
    evidenceGuards.readOwn(record, 'orphanAuthorityCount') !== 0
  ) {
    return failEvidence()
  }
  const terminal = readTerminal(
    evidenceGuards.readOwn(record, 'terminal'),
    expectedName,
  )
  if (
    terminalRootDigests.has(terminal.rootDigest) ||
    releasedFenceDigests.has(terminal.releasedFenceDigest)
  ) {
    return failEvidence()
  }
  runLocatorDigests.add(runLocatorDigest)
  lifecycleDigests.add(lifecycleDigest)
  terminalRootDigests.add(terminal.rootDigest)
  releasedFenceDigests.add(terminal.releasedFenceDigest)
  if (triggerDigest !== null) triggerDigests.add(triggerDigest)
  return {
    name: expectedName,
    status: 'pass',
    startedAt,
    completedAt,
    failpoint,
    triggerDigest,
    runLocatorDigest,
    lifecycleDigest,
    faultReachedAt: lifecycle.faultReachedAt,
    killConfirmedAt: lifecycle.killConfirmedAt,
    predecessorLeaseExpiresAt: lifecycle.predecessorLeaseExpiresAt,
    takeoverAcquiredAt: lifecycle.takeoverAcquiredAt,
    reconciledAt: lifecycle.reconciledAt,
    attempts,
    duplicateApplyCount: 0,
    lostItemCount: 0,
    orphanAuthorityCount: 0,
    terminal,
  }
}

/**
 * Reads the exact process-attempt sequence required by one scenario.
 *
 * @param value - Candidate dense attempt vector.
 * @param scenarioName - Canonical scenario controlling expected outcomes.
 * @param scenarioStartedAt - Exact scenario start boundary.
 * @param scenarioCompletedAt - Exact scenario completion boundary.
 * @param triggerDigest - Scenario fault receipt digest, when present.
 * @param ownerLocatorDigests - Suite-wide owner-locator uniqueness set.
 * @returns Frozen-shape detached process-attempt evidence.
 */
function readScenarioAttempts(
  value: unknown,
  scenarioName: WorkspaceSearchMigrationRehearsalScenarioName,
  scenarioStartedAt: string,
  scenarioCompletedAt: string,
  triggerDigest: string | null,
  ownerLocatorDigests: Set<string>,
  attemptLocatorDigests: Set<string>,
  writerFenceDigests: Set<string>,
  lifecycle: Pick<
    WorkspaceSearchMigrationRehearsalScenarioEvidence,
    | 'faultReachedAt'
    | 'killConfirmedAt'
    | 'predecessorLeaseExpiresAt'
    | 'takeoverAcquiredAt'
    | 'reconciledAt'
  >,
): readonly WorkspaceSearchMigrationRehearsalAttemptEvidence[] {
  const expectedCount = expectedScenarioAttemptCount(scenarioName)
  const values = readExactArray(value, expectedCount)
  const attempts: WorkspaceSearchMigrationRehearsalAttemptEvidence[] = []
  let predecessorCompletedAt: string | undefined
  for (let index = 0; index < values.length; index += 1) {
    const record = evidenceGuards.requireRecord(values[index])
    evidenceGuards.requireExactKeys(record, [
      'attemptLocatorDigest',
      'completedAt',
      'faultReceiptDigest',
      'ordinal',
      'outcome',
      'ownerLocatorDigest',
      'startedAt',
      'writerFenceDigest',
    ])
    const ordinal = readPositiveCount(
      evidenceGuards.readOwn(record, 'ordinal'),
      expectedCount,
    )
    const ownerLocatorDigest = evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'ownerLocatorDigest'),
    )
    const attemptLocatorDigest = evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'attemptLocatorDigest'),
    )
    const writerFenceDigest = evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'writerFenceDigest'),
    )
    const startedAt = evidenceGuards.readTimestamp(
      evidenceGuards.readOwn(record, 'startedAt'),
    )
    const completedAt = evidenceGuards.readTimestamp(
      evidenceGuards.readOwn(record, 'completedAt'),
    )
    const outcome = expectedScenarioAttemptOutcome(
      scenarioName,
      index,
    )
    if (
      ordinal !== index + 1 ||
      evidenceGuards.readOwn(record, 'outcome') !== outcome ||
      Date.parse(startedAt) >= Date.parse(completedAt) ||
      (index === 0 && startedAt !== scenarioStartedAt) ||
      (index === values.length - 1 &&
        completedAt !== scenarioCompletedAt) ||
      (predecessorCompletedAt !== undefined &&
        Date.parse(startedAt) <= Date.parse(predecessorCompletedAt)) ||
      ownerLocatorDigests.has(ownerLocatorDigest) ||
      attemptLocatorDigests.has(attemptLocatorDigest) ||
      writerFenceDigests.has(writerFenceDigest)
    ) {
      return failEvidence()
    }
    const expectedFaultReceiptDigest =
      expectedAttemptFaultReceiptDigest(
        outcome,
        triggerDigest,
      )
    const candidateFaultReceiptDigest =
      evidenceGuards.readOwn(record, 'faultReceiptDigest')
    const faultReceiptDigest = expectedFaultReceiptDigest === null
      ? readNull(candidateFaultReceiptDigest)
      : evidenceGuards.readDigest(candidateFaultReceiptDigest)
    if (faultReceiptDigest !== expectedFaultReceiptDigest) {
      return failEvidence()
    }
    ownerLocatorDigests.add(ownerLocatorDigest)
    attemptLocatorDigests.add(attemptLocatorDigest)
    writerFenceDigests.add(writerFenceDigest)
    attempts.push({
      ordinal,
      attemptLocatorDigest,
      ownerLocatorDigest,
      writerFenceDigest,
      startedAt,
      completedAt,
      outcome,
      faultReceiptDigest,
    })
    predecessorCompletedAt = completedAt
  }
  requireAttemptLifecycle(attempts, lifecycle)
  return attempts
}

/**
 * Reads scenario-specific supervisor and lease-transition timestamps.
 *
 * @param record - Strict scenario record with an already validated time span.
 * @param scenarioName - Canonical scenario controlling lifecycle semantics.
 * @param scenarioStartedAt - Exact scenario start boundary.
 * @param scenarioCompletedAt - Exact scenario completion boundary.
 * @returns Exact nullable lifecycle projection for later attempt binding.
 */
function readScenarioLifecycle(
  record: object,
  scenarioName: WorkspaceSearchMigrationRehearsalScenarioName,
  scenarioStartedAt: string,
  scenarioCompletedAt: string,
): Pick<
  WorkspaceSearchMigrationRehearsalScenarioEvidence,
  | 'faultReachedAt'
  | 'killConfirmedAt'
  | 'predecessorLeaseExpiresAt'
  | 'takeoverAcquiredAt'
  | 'reconciledAt'
> {
  if (
    scenarioName === 'happy-path-verified' ||
    scenarioName === 'complete-apply-rollback'
  ) {
    return {
      faultReachedAt: readNull(
        evidenceGuards.readOwn(record, 'faultReachedAt'),
      ),
      killConfirmedAt: readNull(
        evidenceGuards.readOwn(record, 'killConfirmedAt'),
      ),
      predecessorLeaseExpiresAt: readNull(
        evidenceGuards.readOwn(record, 'predecessorLeaseExpiresAt'),
      ),
      takeoverAcquiredAt: readNull(
        evidenceGuards.readOwn(record, 'takeoverAcquiredAt'),
      ),
      reconciledAt: readNull(
        evidenceGuards.readOwn(record, 'reconciledAt'),
      ),
    }
  }
  const faultReachedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'faultReachedAt'),
  )
  if (
    Date.parse(faultReachedAt) <= Date.parse(scenarioStartedAt) ||
    Date.parse(faultReachedAt) >= Date.parse(scenarioCompletedAt)
  ) {
    return failEvidence()
  }
  if (scenarioName === 'transaction-response-loss') {
    const reconciledAt = evidenceGuards.readTimestamp(
      evidenceGuards.readOwn(record, 'reconciledAt'),
    )
    if (
      Date.parse(reconciledAt) <= Date.parse(faultReachedAt) ||
      Date.parse(reconciledAt) > Date.parse(scenarioCompletedAt)
    ) {
      return failEvidence()
    }
    return {
      faultReachedAt,
      killConfirmedAt: readNull(
        evidenceGuards.readOwn(record, 'killConfirmedAt'),
      ),
      predecessorLeaseExpiresAt: readNull(
        evidenceGuards.readOwn(record, 'predecessorLeaseExpiresAt'),
      ),
      takeoverAcquiredAt: readNull(
        evidenceGuards.readOwn(record, 'takeoverAcquiredAt'),
      ),
      reconciledAt,
    }
  }
  const killConfirmedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'killConfirmedAt'),
  )
  const predecessorLeaseExpiresAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'predecessorLeaseExpiresAt'),
  )
  const takeoverAcquiredAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'takeoverAcquiredAt'),
  )
  if (
    Date.parse(killConfirmedAt) <= Date.parse(faultReachedAt) ||
    Date.parse(predecessorLeaseExpiresAt) <= Date.parse(killConfirmedAt) ||
    Date.parse(takeoverAcquiredAt) <
      Date.parse(predecessorLeaseExpiresAt) ||
    Date.parse(takeoverAcquiredAt) >= Date.parse(scenarioCompletedAt)
  ) {
    return failEvidence()
  }
  return {
    faultReachedAt,
    killConfirmedAt,
    predecessorLeaseExpiresAt,
    takeoverAcquiredAt,
    reconciledAt: readNull(
      evidenceGuards.readOwn(record, 'reconciledAt'),
    ),
  }
}

/**
 * Binds attempt boundaries to the independently persisted supervisor ledger.
 *
 * @param attempts - Exact parsed process-attempt sequence.
 * @param lifecycle - Scenario-specific supervisor and lease timestamps.
 */
function requireAttemptLifecycle(
  attempts: readonly WorkspaceSearchMigrationRehearsalAttemptEvidence[],
  lifecycle: Pick<
    WorkspaceSearchMigrationRehearsalScenarioEvidence,
    | 'faultReachedAt'
    | 'killConfirmedAt'
    | 'predecessorLeaseExpiresAt'
    | 'takeoverAcquiredAt'
    | 'reconciledAt'
  >,
): void {
  const firstAttempt = attempts[0]
  if (firstAttempt === undefined) return failEvidence()
  if (lifecycle.faultReachedAt === null) return
  if (
    Date.parse(lifecycle.faultReachedAt) <=
      Date.parse(firstAttempt.startedAt) ||
    Date.parse(lifecycle.faultReachedAt) >=
      Date.parse(firstAttempt.completedAt)
  ) {
    return failEvidence()
  }
  if (lifecycle.reconciledAt !== null) {
    if (
      attempts.length !== 1 ||
      Date.parse(lifecycle.reconciledAt) >
        Date.parse(firstAttempt.completedAt)
    ) {
      return failEvidence()
    }
    return
  }
  const successorAttempt = attempts[1]
  if (
    attempts.length !== 2 ||
    successorAttempt === undefined ||
    lifecycle.killConfirmedAt === null ||
    lifecycle.predecessorLeaseExpiresAt === null ||
    lifecycle.takeoverAcquiredAt === null ||
    firstAttempt.completedAt !== lifecycle.killConfirmedAt ||
    Date.parse(successorAttempt.startedAt) <
      Date.parse(lifecycle.predecessorLeaseExpiresAt) ||
    Date.parse(lifecycle.takeoverAcquiredAt) <
      Date.parse(successorAttempt.startedAt) ||
    Date.parse(lifecycle.takeoverAcquiredAt) >=
      Date.parse(successorAttempt.completedAt)
  ) {
    return failEvidence()
  }
}

/** Returns the exact process-attempt count required by one scenario. */
function expectedScenarioAttemptCount(
  name: WorkspaceSearchMigrationRehearsalScenarioName,
): 1 | 2 {
  return name === 'happy-path-verified' ||
      name === 'transaction-response-loss' ||
      name === 'complete-apply-rollback'
    ? 1
    : 2
}

/** Returns one exact process outcome at a scenario attempt ordinal. */
function expectedScenarioAttemptOutcome(
  name: WorkspaceSearchMigrationRehearsalScenarioName,
  index: number,
): WorkspaceSearchMigrationRehearsalAttemptOutcome {
  if (name === 'transaction-response-loss') {
    if (index !== 0) return failEvidence()
    return 'response-loss-reconciled'
  }
  if (
    name === 'happy-path-verified' ||
    name === 'complete-apply-rollback'
  ) {
    if (index !== 0) return failEvidence()
    return 'completed'
  }
  if (index === 0) return 'killed-at-fault'
  if (index === 1) return 'takeover-completed'
  return failEvidence()
}

/** Returns the only fault receipt digest valid for one attempt outcome. */
function expectedAttemptFaultReceiptDigest(
  outcome: WorkspaceSearchMigrationRehearsalAttemptOutcome,
  triggerDigest: string | null,
): string | null {
  if (
    outcome === 'killed-at-fault' ||
    outcome === 'response-loss-reconciled'
  ) {
    if (triggerDigest === null) return failEvidence()
    return triggerDigest
  }
  return null
}

/** Reads one terminal projection and checks the scenario-specific root kind. */
function readTerminal(
  value: unknown,
  scenarioName: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalTerminalEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
    'kind',
    'releasedFenceDigest',
    'rootDigest',
    'version',
  ])
  const kind = expectedTerminalKind(scenarioName)
  const version = expectedTerminalVersion(scenarioName)
  if (
    evidenceGuards.readOwn(record, 'kind') !== kind ||
    evidenceGuards.readOwn(record, 'version') !== version
  ) {
    return failEvidence()
  }
  return {
    kind,
    version,
    rootDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'rootDigest'),
    ),
    releasedFenceDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'releasedFenceDigest'),
    ),
  }
}

/** Returns the only fault boundary valid for one fixed scenario. */
function expectedFailpoint(
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

/** Returns the required terminal class for one scenario. */
function expectedTerminalKind(
  name: WorkspaceSearchMigrationRehearsalScenarioName,
): 'verified' | 'rolled-back' {
  if (
    name === 'partial-apply-rollback' ||
    name === 'complete-apply-rollback'
  ) {
    return 'rolled-back'
  }
  return 'verified'
}

/** Returns the authoritative persistence version required by one scenario. */
function expectedTerminalVersion(
  name: WorkspaceSearchMigrationRehearsalScenarioName,
): 1 | 2 {
  return name === 'partial-apply-rollback' ? 2 : 1
}

/** Reads the exact canonical eight-scenario reconciliation vector. */
function readReconciliation(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationEvidence {
  const values = readExactArray(
    value,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS.length,
  )
  const summaries = values.map((candidate, index) => {
    const scenario = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_SCENARIOS[index]
    if (scenario === undefined) return failEvidence()
    return readReconciliationSummary(candidate, scenario)
  })
  const resultDigests: string[] = []
  const auxiliaryRateSegmentDigests: string[] = []
  const auxiliaryRateSegmentLocators: string[] = []
  const auxiliaryRateKeyFingerprints: string[] = []
  const targetContentDigests: string[] = []
  const resourceIdentityBindings: string[] = []
  for (const summary of summaries) {
    auxiliaryRateSegmentDigests.push(summary.rateSegmentDigest)
    auxiliaryRateSegmentLocators.push(summary.rateSegmentLocatorDigest)
    auxiliaryRateKeyFingerprints.push(
      summary.rateAuthenticationKeyFingerprint,
    )
    if (summary.integrity.kind === 'verified-result') {
      resultDigests.push(summary.integrity.result.resultDigest)
      resourceIdentityBindings.push(serializeCanonicalJson({
        resourceIdentityScheme:
          summary.integrity.result.resourceIdentityScheme,
        resourceIdentities:
          summary.integrity.result.resourceIdentities,
        resourceIdentityDigest:
          summary.integrity.result.resourceIdentityDigest,
      }))
    } else {
      resultDigests.push(
        summary.integrity.before.resultDigest,
        summary.integrity.after.resultDigest,
      )
      for (const result of [
        summary.integrity.before,
        summary.integrity.after,
      ]) {
        resourceIdentityBindings.push(serializeCanonicalJson({
          resourceIdentityScheme: result.resourceIdentityScheme,
          resourceIdentities: result.resourceIdentities,
          resourceIdentityDigest: result.resourceIdentityDigest,
        }))
      }
      if (summary.targetAudits === null) return failEvidence()
      for (const target of [
        summary.targetAudits.preimage,
        summary.targetAudits.restored,
      ]) {
        targetContentDigests.push(target.contentDigest)
        auxiliaryRateSegmentDigests.push(target.rate.successor.segmentDigest)
        auxiliaryRateSegmentLocators.push(
          target.rate.successor.segmentLocatorDigest,
        )
        auxiliaryRateKeyFingerprints.push(
          target.rate.authenticationKeyFingerprint,
        )
      }
    }
  }
  if (
    new Set(summaries.map((summary) => summary.contentDigest)).size !== 8 ||
    new Set(summaries.map((summary) => summary.auditDigest)).size !== 8 ||
    new Set(summaries.map((summary) => summary.runLocatorDigest)).size !== 8 ||
    new Set(summaries.map((summary) => summary.executionRunDigest)).size !== 8 ||
    new Set(summaries.map((summary) => summary.terminalRootDigest)).size !== 8 ||
    new Set(auxiliaryRateSegmentDigests).size !== 12 ||
    new Set(auxiliaryRateSegmentLocators).size !== 12 ||
    new Set(auxiliaryRateKeyFingerprints).size !== 1 ||
    new Set(targetContentDigests).size !== 4 ||
    new Set(resultDigests).size !== 10 ||
    resourceIdentityBindings.length !== 10 ||
    new Set(resourceIdentityBindings).size !== 1
  ) {
    return failEvidence()
  }
  return Object.freeze(summaries)
}

/**
 * Reads one canonical successful reconciliation summary.
 *
 * @param value - Candidate summary from the authenticated evidence index.
 * @param expectedScenario - Scenario fixed by canonical vector position.
 * @returns Detached strict digest-only reconciliation summary.
 */
function readReconciliationSummary(
  value: unknown,
  expectedScenario: WorkspaceSearchMigrationRehearsalScenarioName,
): WorkspaceSearchMigrationRehearsalReconciliationSummaryEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
    'applyBoundaryDigest',
    'appliedOperationCount',
    'auditDigest',
    'authoritySummaryDigest',
    'byteLength',
    'checkedAt',
    'configurationBindingDigest',
    'contentDigest',
    'duplicateApplyCount',
    'executionRunDigest',
    'integrity',
    'lostItemCount',
    'markerSummaryDigest',
    'orphanAuthorityCount',
    'planDigest',
    'rateAuthenticationKeyFingerprint',
    'rateSegmentDigest',
    'rateSegmentLocatorDigest',
    'rateSegmentOrdinal',
    'runLocatorDigest',
    'scenario',
    'sealedPlanOperationCount',
    'sealedPlanningAuthorityDigest',
    'sourceTargetSummaryDigest',
    'status',
    'targetAudits',
    'terminalAt',
    'terminalRootDigest',
    'terminalRootKind',
    'terminalRootVersion',
  ])
  if (
    evidenceGuards.readOwn(record, 'scenario') !== expectedScenario ||
    evidenceGuards.readOwn(record, 'status') !== 'pass' ||
    evidenceGuards.readOwn(record, 'duplicateApplyCount') !== 0 ||
    evidenceGuards.readOwn(record, 'lostItemCount') !== 0 ||
    evidenceGuards.readOwn(record, 'orphanAuthorityCount') !== 0 ||
    evidenceGuards.readOwn(record, 'terminalRootKind') !==
      expectedTerminalKind(expectedScenario) ||
    evidenceGuards.readOwn(record, 'terminalRootVersion') !==
      expectedTerminalVersion(expectedScenario)
  ) {
    return failEvidence()
  }
  const sealedPlanOperationCount = readPositiveCount(
    evidenceGuards.readOwn(record, 'sealedPlanOperationCount'),
  )
  const appliedOperationCount = readPositiveCount(
    evidenceGuards.readOwn(record, 'appliedOperationCount'),
  )
  if (
    appliedOperationCount > sealedPlanOperationCount ||
    (expectedScenario === 'partial-apply-rollback' &&
      appliedOperationCount >= sealedPlanOperationCount) ||
    (expectedScenario !== 'partial-apply-rollback' &&
      appliedOperationCount !== sealedPlanOperationCount)
  ) {
    return failEvidence()
  }
  const terminalAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'terminalAt'),
  )
  const checkedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'checkedAt'),
  )
  if (Date.parse(terminalAt) >= Date.parse(checkedAt)) {
    return failEvidence()
  }
  const terminalRootKind = expectedTerminalKind(expectedScenario)
  const terminalRootVersion = expectedTerminalVersion(expectedScenario)
  const terminalRootDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'terminalRootDigest'),
  )
  const core = Object.freeze({
    scenario: expectedScenario,
    runLocatorDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'runLocatorDigest'),
    ),
    configurationBindingDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'configurationBindingDigest'),
    ),
    sealedPlanningAuthorityDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'sealedPlanningAuthorityDigest'),
    ),
    executionRunDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'executionRunDigest'),
    ),
    planDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'planDigest'),
    ),
    applyBoundaryDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'applyBoundaryDigest'),
    ),
    terminalRootKind,
    terminalRootVersion,
    terminalRootDigest,
    sealedPlanOperationCount,
    appliedOperationCount,
    terminalAt,
    checkedAt,
  })
  const migrationContextDigest = createMigrationDigest({
    kind:
      'workspace-search-migration-rehearsal-terminal-integrity-migration-context',
    version: 1,
    ...core,
  })
  const integrity = readReconciliationIntegrity(
    evidenceGuards.readOwn(record, 'integrity'),
    expectedScenario,
    terminalRootDigest,
    terminalAt,
    checkedAt,
    migrationContextDigest,
  )
  const targetAudits = readReconciliationTargetAudits(
    evidenceGuards.readOwn(record, 'targetAudits'),
    expectedScenario,
    integrity,
    core.configurationBindingDigest,
    terminalAt,
    checkedAt,
  )
  return Object.freeze({
    ...core,
    status: 'pass',
    integrity,
    targetAudits,
    markerSummaryDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'markerSummaryDigest'),
    ),
    authoritySummaryDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'authoritySummaryDigest'),
    ),
    sourceTargetSummaryDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'sourceTargetSummaryDigest'),
    ),
    rateAuthenticationKeyFingerprint: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'rateAuthenticationKeyFingerprint'),
    ),
    rateSegmentLocatorDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'rateSegmentLocatorDigest'),
    ),
    rateSegmentOrdinal: readCount(
      evidenceGuards.readOwn(record, 'rateSegmentOrdinal'),
      255,
    ),
    rateSegmentDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'rateSegmentDigest'),
    ),
    duplicateApplyCount: 0,
    lostItemCount: 0,
    orphanAuthorityCount: 0,
    contentDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'contentDigest'),
    ),
    byteLength: readPositiveCount(
      evidenceGuards.readOwn(record, 'byteLength'),
      64 * 1_024,
    ),
    auditDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'auditDigest'),
    ),
  })
}

/**
 * Reads the exact authenticated rollback target pair embedded in one audit.
 *
 * @param value - Candidate target pair or strict null.
 * @param scenario - Scenario fixed by the canonical reconciliation slot.
 * @param integrity - Authenticated #163 result or rollback comparison.
 * @param configurationBindingDigest - Exact measured configuration binding.
 * @param terminalAt - Authoritative terminal publication time.
 * @param checkedAt - Reconciliation completion time.
 * @returns Strict rollback target pair, otherwise null for verified scenarios.
 */
function readReconciliationTargetAudits(
  value: unknown,
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  integrity: WorkspaceSearchMigrationRehearsalReconciliationIntegrityEvidence,
  configurationBindingDigest: string,
  terminalAt: string,
  checkedAt: string,
): WorkspaceSearchMigrationRehearsalReconciliationTargetAuditPairEvidence |
  null {
  if (integrity.kind === 'verified-result') {
    if (value !== null) return failEvidence()
    return null
  }
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, ['preimage', 'restored'])
  const purposePrefix = scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : scenario === 'complete-apply-rollback'
    ? 'complete-rollback'
    : null
  if (purposePrefix === null || integrity.purpose !== purposePrefix) {
    return failEvidence()
  }
  const preimage = readReconciliationTargetAudit(
    evidenceGuards.readOwn(record, 'preimage'),
    `${purposePrefix}-preimage`,
    configurationBindingDigest,
  )
  const restored = readReconciliationTargetAudit(
    evidenceGuards.readOwn(record, 'restored'),
    `${purposePrefix}-restored`,
    configurationBindingDigest,
  )
  const integrityBefore = preimage.integrityBefore
  if (
    integrityBefore === null ||
    restored.integrityBefore !== null ||
    !sameWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
      integrityBefore,
      integrity.before,
    ) ||
    preimage.contentDigest === restored.contentDigest ||
    preimage.observationDigest === restored.observationDigest ||
    preimage.aggregateDigest !== restored.aggregateDigest ||
    preimage.aggregateDigest !== integrity.targetPreimageAggregateDigest ||
    restored.aggregateDigest !== integrity.targetRestoredAggregateDigest ||
    preimage.contextDigest !== restored.contextDigest ||
    Date.parse(preimage.observedAt) >=
      Date.parse(integrity.applyStartedAt) ||
    Date.parse(preimage.rate.completedAt) >=
      Date.parse(integrity.applyStartedAt) ||
    Date.parse(preimage.observedAt) >= Date.parse(terminalAt) ||
    Date.parse(restored.startedAt) <= Date.parse(terminalAt) ||
    Date.parse(restored.observedAt) <= Date.parse(terminalAt) ||
    Date.parse(restored.observedAt) > Date.parse(checkedAt) ||
    Date.parse(restored.rate.completedAt) > Date.parse(checkedAt) ||
    preimage.rate.authenticationKeyFingerprint !==
      restored.rate.authenticationKeyFingerprint ||
    preimage.rate.successor.segmentOrdinal >=
      restored.rate.successor.segmentOrdinal ||
    preimage.rate.successor.segmentDigest ===
      restored.rate.successor.segmentDigest ||
    preimage.rate.successor.segmentLocatorDigest ===
      restored.rate.successor.segmentLocatorDigest
  ) return failEvidence()
  return Object.freeze({ preimage, restored })
}

/** Reads one public digest-only authenticated target-audit projection. */
function readReconciliationTargetAudit(
  value: unknown,
  expectedPurpose:
    | 'complete-rollback-preimage'
    | 'complete-rollback-restored'
    | 'partial-rollback-preimage'
    | 'partial-rollback-restored',
  configurationBindingDigest: string,
): WorkspaceSearchMigrationRehearsalReconciliationTargetAuditEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
    'aggregateDigest',
    'byteLength',
    'contentDigest',
    'contextDigest',
    'integrityBefore',
    'observationDigest',
    'observedAt',
    'purpose',
    'rate',
    'startedAt',
  ])
  if (evidenceGuards.readOwn(record, 'purpose') !== expectedPurpose) {
    return failEvidence()
  }
  const startedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'startedAt'),
  )
  const observedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'observedAt'),
  )
  const rate = readWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
    evidenceGuards.readOwn(record, 'rate'),
  )
  if (
    Date.parse(startedAt) > Date.parse(observedAt) ||
    rate.link.configurationBindingDigest !== configurationBindingDigest ||
    Date.parse(rate.completedAt) < Date.parse(observedAt)
  ) return failEvidence()
  const integrityBeforeValue = evidenceGuards.readOwn(
    record,
    'integrityBefore',
  )
  const preimage = expectedPurpose === 'partial-rollback-preimage' ||
    expectedPurpose === 'complete-rollback-preimage'
  let integrityBefore:
    WorkspaceSearchMigrationRehearsalReconciliationResultEvidence | null
  if (preimage) {
    integrityBefore = readReconciliationResult(integrityBeforeValue)
    if (
      Date.parse(integrityBefore.runtimeProvenance.completedAt) >
        Date.parse(startedAt)
    ) return failEvidence()
  } else {
    if (integrityBeforeValue !== null) return failEvidence()
    integrityBefore = null
  }
  return Object.freeze({
    purpose: expectedPurpose,
    contentDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'contentDigest'),
    ),
    byteLength: readPositiveCount(
      evidenceGuards.readOwn(record, 'byteLength'),
      64 * 1_024 * 1_024,
    ),
    startedAt,
    observedAt,
    observationDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'observationDigest'),
    ),
    aggregateDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'aggregateDigest'),
    ),
    integrityBefore,
    contextDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'contextDigest'),
    ),
    rate,
  })
}

/**
 * Reads scenario-specific #163 material within one reconciliation summary.
 *
 * @param value - Candidate #163 summary.
 * @param scenario - Scenario fixed by the outer canonical summary.
 * @param terminalRootDigest - Outer authoritative terminal root digest.
 * @param expectedTerminalAt - Outer authoritative terminal publication time.
 * @param checkedAt - Outer reconciliation completion time.
 * @param migrationContextDigest - Reproduced exact migration context digest.
 * @returns Detached verified-result or rollback-comparison evidence.
 */
function readReconciliationIntegrity(
  value: unknown,
  scenario: WorkspaceSearchMigrationRehearsalScenarioName,
  terminalRootDigest: string,
  expectedTerminalAt: string,
  checkedAt: string,
  migrationContextDigest: string,
): WorkspaceSearchMigrationRehearsalReconciliationIntegrityEvidence {
  const record = evidenceGuards.requireRecord(value)
  const kind = evidenceGuards.readOwn(record, 'kind')
  if (kind === 'verified-result') {
    if (expectedTerminalKind(scenario) !== 'verified') return failEvidence()
    evidenceGuards.requireExactKeys(record, [
      'completedAt',
      'failureCount',
      'integrityAggregateDigest',
      'kind',
      'migrationContextDigest',
      'result',
      'resultContextDigest',
      'status',
      'terminalRootDigest',
    ])
    if (
      evidenceGuards.readOwn(record, 'status') !== 'pass' ||
      evidenceGuards.readOwn(record, 'failureCount') !== 0 ||
      evidenceGuards.readOwn(record, 'terminalRootDigest') !==
        terminalRootDigest ||
      evidenceGuards.readOwn(record, 'migrationContextDigest') !==
        migrationContextDigest
    ) {
      return failEvidence()
    }
    const completedAt = evidenceGuards.readTimestamp(
      evidenceGuards.readOwn(record, 'completedAt'),
    )
    const result = readReconciliationResult(
      evidenceGuards.readOwn(record, 'result'),
    )
    const integrityAggregateDigest = evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'integrityAggregateDigest'),
    )
    if (
      integrityAggregateDigest !== result.integrityAggregateDigest ||
      Date.parse(result.runtimeProvenance.startedAt) <=
        Date.parse(expectedTerminalAt) ||
      Date.parse(result.checkedAt) <= Date.parse(expectedTerminalAt) ||
      Date.parse(result.checkedAt) > Date.parse(completedAt) ||
      Date.parse(completedAt) > Date.parse(checkedAt)
    ) {
      return failEvidence()
    }
    const resultContextDigest = createMigrationDigest({
      domain:
        'workspace-search-migration-rehearsal-terminal-integrity-result-context',
      version: 1,
      scenario,
      migrationContextDigest,
      kind: 'verified-result',
      status: 'pass',
      failureCount: 0,
      completedAt,
      result,
      terminalRootDigest,
      integrityAggregateDigest,
    })
    if (
      evidenceGuards.readOwn(record, 'resultContextDigest') !==
        resultContextDigest
    ) {
      return failEvidence()
    }
    return Object.freeze({
      kind: 'verified-result',
      status: 'pass',
      failureCount: 0,
      completedAt,
      result,
      terminalRootDigest,
      integrityAggregateDigest,
      resultContextDigest,
      migrationContextDigest,
    })
  }
  if (kind !== 'rollback-comparison') return failEvidence()
  if (expectedTerminalKind(scenario) !== 'rolled-back') return failEvidence()
  evidenceGuards.requireExactKeys(record, [
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
  const expectedPurpose = scenario === 'partial-apply-rollback'
    ? 'partial-rollback'
    : scenario === 'complete-apply-rollback'
    ? 'complete-rollback'
    : null
  if (
    expectedPurpose === null ||
    evidenceGuards.readOwn(record, 'purpose') !== expectedPurpose ||
    evidenceGuards.readOwn(record, 'status') !== 'pass' ||
    evidenceGuards.readOwn(record, 'failureCount') !== 0 ||
    evidenceGuards.readOwn(record, 'targetPreimageStatus') !== 'equal' ||
    evidenceGuards.readOwn(record, 'terminalRootDigest') !==
      terminalRootDigest ||
    evidenceGuards.readOwn(record, 'migrationContextDigest') !==
      migrationContextDigest
  ) {
    return failEvidence()
  }
  const startedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'startedAt'),
  )
  const applyStartedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'applyStartedAt'),
  )
  const terminalAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'terminalAt'),
  )
  const completedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'completedAt'),
  )
  const before = readReconciliationResult(
    evidenceGuards.readOwn(record, 'before'),
  )
  const after = readReconciliationResult(
    evidenceGuards.readOwn(record, 'after'),
  )
  const comparisonDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'comparisonDigest'),
  )
  const targetPreimageAggregateDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'targetPreimageAggregateDigest'),
  )
  const targetRestoredAggregateDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'targetRestoredAggregateDigest'),
  )
  const expectedComparisonDigest = createMigrationDigest({
    purpose: expectedPurpose,
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
    kind: 'workspace-search-migration-rehearsal-integrity-context',
    version: 1,
    purpose: expectedPurpose,
    startedAt,
    applyStartedAt,
    terminalAt,
    completedAt,
    before,
    after,
    comparisonDigest,
  })
  if (
    targetPreimageAggregateDigest !== targetRestoredAggregateDigest ||
    before.contentDigest === after.contentDigest ||
    before.resultDigest === after.resultDigest ||
    before.resultMac === after.resultMac ||
    before.integrityAggregateDigest !== after.integrityAggregateDigest ||
    before.resourceIdentityDigest !== after.resourceIdentityDigest ||
    Date.parse(startedAt) >
      Date.parse(before.runtimeProvenance.startedAt) ||
    Date.parse(before.checkedAt) >= Date.parse(applyStartedAt) ||
    Date.parse(applyStartedAt) >= Date.parse(terminalAt) ||
    terminalAt !== expectedTerminalAt ||
    Date.parse(before.checkedAt) >= Date.parse(after.checkedAt) ||
    Date.parse(after.runtimeProvenance.startedAt) <= Date.parse(terminalAt) ||
    Date.parse(after.checkedAt) <= Date.parse(terminalAt) ||
    Date.parse(after.checkedAt) > Date.parse(completedAt) ||
    Date.parse(completedAt) > Date.parse(checkedAt) ||
    comparisonDigest !== expectedComparisonDigest ||
    evidenceGuards.readOwn(record, 'comparisonContextDigest') !==
      expectedComparisonContextDigest
  ) {
    return failEvidence()
  }
  return Object.freeze({
    kind: 'rollback-comparison',
    purpose: expectedPurpose,
    status: 'pass',
    failureCount: 0,
    startedAt,
    applyStartedAt,
    terminalAt,
    completedAt,
    before,
    after,
    comparisonDigest,
    comparisonContextDigest: expectedComparisonContextDigest,
    terminalRootDigest,
    targetPreimageAggregateDigest,
    targetRestoredAggregateDigest,
    targetPreimageStatus: 'equal',
    migrationContextDigest,
  })
}

/** Reads one exact authenticated #163 result binding. */
function readReconciliationResult(
  value: unknown,
): WorkspaceSearchMigrationRehearsalReconciliationResultEvidence {
  try {
    return readWorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection(
      value,
    )
  } catch {
    return failEvidence()
  }
}

/** Reads actual rate evidence and binds it to the reviewed policy. */
function readRate(
  value: unknown,
  ratePolicyVersion: string,
): WorkspaceSearchMigrationRehearsalRateEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
    'aggregate',
    'aggregateDigest',
    'observationCount',
    'observationStreamDigest',
    'observedMaximumRatePerSecond',
  ])
  const aggregate = readRateAggregate(
    evidenceGuards.readOwn(record, 'aggregate'),
    ratePolicyVersion,
  )
  const aggregateDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'aggregateDigest'),
  )
  if (aggregateDigest !== createMigrationDigest(aggregate)) {
    return failEvidence()
  }
  const observationCount = readPositiveCount(
    evidenceGuards.readOwn(record, 'observationCount'),
  )
  if (observationCount < aggregate.attemptCount) return failEvidence()
  const observedMaximumRatePerSecond = evidenceGuards.readOwn(
    record,
    'observedMaximumRatePerSecond',
  )
  if (
    typeof observedMaximumRatePerSecond !== 'number' ||
    !Number.isFinite(observedMaximumRatePerSecond) ||
    observedMaximumRatePerSecond <= 0 ||
    observedMaximumRatePerSecond > maximumObservedRatePerSecond
  ) {
    return failEvidence()
  }
  return {
    aggregate,
    aggregateDigest,
    observationStreamDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'observationStreamDigest'),
    ),
    observationCount,
    observedMaximumRatePerSecond,
  }
}

/** Reads the exact identifier-free runtime rate aggregate. */
function readRateAggregate(
  value: unknown,
  ratePolicyVersion: string,
): WorkspaceSearchMigrationRehearsalRateAggregate {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
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
  if (
    evidenceGuards.readOwn(record, 'version') !== 1 ||
    evidenceGuards.readOwn(record, 'policyVersion') !== ratePolicyVersion ||
    evidenceGuards.readOwn(record, 'maximumInFlight') !== 1
  ) {
    return failEvidence()
  }
  const cadenceWaitCount = readCount(
    evidenceGuards.readOwn(record, 'cadenceWaitCount'),
  )
  const cadenceWaitMilliseconds = readCount(
    evidenceGuards.readOwn(record, 'cadenceWaitMilliseconds'),
  )
  if (
    (cadenceWaitCount === 0) !== (cadenceWaitMilliseconds === 0)
  ) {
    return failEvidence()
  }
  return {
    version: 1,
    policyVersion: ratePolicyVersion,
    attemptCount: readPositiveCount(
      evidenceGuards.readOwn(record, 'attemptCount'),
    ),
    forfeitedAttemptCount: readCount(
      evidenceGuards.readOwn(record, 'forfeitedAttemptCount'),
    ),
    throttleCount: readCount(
      evidenceGuards.readOwn(record, 'throttleCount'),
    ),
    budgetStopCount: readCount(
      evidenceGuards.readOwn(record, 'budgetStopCount'),
    ),
    cadenceWaitCount,
    cadenceWaitMilliseconds,
    maximumInFlight: 1,
  }
}

/** Reads the exact complete alarm vector and distinct dual-route receipts. */
function readAlarms(
  value: unknown,
  rehearsalStartedAt: string,
  rehearsalCompletedAt: string,
): readonly WorkspaceSearchMigrationRehearsalAlarmEvidence[] {
  const values = readExactArray(
    value,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS.length,
  )
  const alarms: WorkspaceSearchMigrationRehearsalAlarmEvidence[] = []
  const receiptDigests = new Set<string>()
  for (let index = 0; index < values.length; index += 1) {
    const name = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ALARMS[index]
    if (name === undefined) return failEvidence()
    const alarm = readAlarm(
      values[index],
      name,
      rehearsalStartedAt,
      rehearsalCompletedAt,
    )
    if (
      receiptDigests.has(alarm.primaryReceiptDigest) ||
      receiptDigests.has(alarm.secondaryReceiptDigest)
    ) {
      return failEvidence()
    }
    receiptDigests.add(alarm.primaryReceiptDigest)
    receiptDigests.add(alarm.secondaryReceiptDigest)
    alarms.push(alarm)
  }
  return alarms
}

/** Reads one OK-to-ALARM-to-OK transition with two distinct receipts. */
function readAlarm(
  value: unknown,
  expectedName: WorkspaceSearchMigrationRehearsalAlarmName,
  rehearsalStartedAt: string,
  rehearsalCompletedAt: string,
): WorkspaceSearchMigrationRehearsalAlarmEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
    'alarmObservedAt',
    'alarmState',
    'historyDigest',
    'initialState',
    'name',
    'primaryReceiptDigest',
    'primaryReceivedAt',
    'recoveredAt',
    'recoveredState',
    'secondaryReceiptDigest',
    'secondaryReceivedAt',
    'signalDigest',
    'status',
  ])
  if (
    evidenceGuards.readOwn(record, 'name') !== expectedName ||
    evidenceGuards.readOwn(record, 'status') !== 'pass' ||
    evidenceGuards.readOwn(record, 'initialState') !== 'OK' ||
    evidenceGuards.readOwn(record, 'alarmState') !== 'ALARM' ||
    evidenceGuards.readOwn(record, 'recoveredState') !== 'OK'
  ) {
    return failEvidence()
  }
  const alarmObservedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'alarmObservedAt'),
  )
  const recoveredAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'recoveredAt'),
  )
  if (
    Date.parse(alarmObservedAt) < Date.parse(rehearsalStartedAt) ||
    Date.parse(recoveredAt) > Date.parse(rehearsalCompletedAt) ||
    Date.parse(alarmObservedAt) >= Date.parse(recoveredAt)
  ) {
    return failEvidence()
  }
  const primaryReceiptDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'primaryReceiptDigest'),
  )
  const secondaryReceiptDigest = evidenceGuards.readDigest(
    evidenceGuards.readOwn(record, 'secondaryReceiptDigest'),
  )
  const primaryReceivedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'primaryReceivedAt'),
  )
  const secondaryReceivedAt = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'secondaryReceivedAt'),
  )
  if (
    primaryReceiptDigest === secondaryReceiptDigest ||
    Date.parse(primaryReceivedAt) < Date.parse(alarmObservedAt) ||
    Date.parse(primaryReceivedAt) >= Date.parse(recoveredAt) ||
    Date.parse(secondaryReceivedAt) < Date.parse(alarmObservedAt) ||
    Date.parse(secondaryReceivedAt) >= Date.parse(recoveredAt)
  ) {
    return failEvidence()
  }
  return {
    name: expectedName,
    status: 'pass',
    initialState: 'OK',
    alarmState: 'ALARM',
    recoveredState: 'OK',
    alarmObservedAt,
    recoveredAt,
    signalDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'signalDigest'),
    ),
    historyDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'historyDigest'),
    ),
    primaryReceiptDigest,
    primaryReceivedAt,
    secondaryReceiptDigest,
    secondaryReceivedAt,
  }
}

/** Reads the fixed synchronous-migration DLQ classification. */
function readDlq(
  value: unknown,
): WorkspaceSearchMigrationRehearsalDlqEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, ['executionModel', 'status'])
  if (
    evidenceGuards.readOwn(record, 'status') !== 'not-applicable' ||
    evidenceGuards.readOwn(record, 'executionModel') !==
      'synchronous-migration'
  ) {
    return failEvidence()
  }
  return {
    status: 'not-applicable',
    executionModel: 'synchronous-migration',
  }
}

/** Reads the exact complete immutable child artifact manifest. */
function readArtifacts(
  value: unknown,
  rehearsalCompletedAt: string,
): readonly WorkspaceSearchMigrationRehearsalArtifactEvidence[] {
  const values = readExactArray(
    value,
    WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS.length,
  )
  const artifacts: WorkspaceSearchMigrationRehearsalArtifactEvidence[] = []
  const versionDigests = new Set<string>()
  for (let index = 0; index < values.length; index += 1) {
    const kind = WORKSPACE_SEARCH_MIGRATION_REHEARSAL_ARTIFACTS[index]
    if (kind === undefined) return failEvidence()
    const artifact = readArtifact(
      values[index],
      kind,
      rehearsalCompletedAt,
    )
    if (versionDigests.has(artifact.immutableVersionDigest)) {
      return failEvidence()
    }
    versionDigests.add(artifact.immutableVersionDigest)
    artifacts.push(artifact)
  }
  return artifacts
}

/** Reads one child artifact reference without raw storage identifiers. */
function readArtifact(
  value: unknown,
  expectedKind: WorkspaceSearchMigrationRehearsalArtifactKind,
  rehearsalCompletedAt: string,
): WorkspaceSearchMigrationRehearsalArtifactEvidence {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
    'byteLength',
    'contentDigest',
    'immutableVersionDigest',
    'kind',
    'retainedUntil',
  ])
  if (evidenceGuards.readOwn(record, 'kind') !== expectedKind) {
    return failEvidence()
  }
  const retainedUntil = evidenceGuards.readTimestamp(
    evidenceGuards.readOwn(record, 'retainedUntil'),
  )
  if (
    Date.parse(retainedUntil) <
      Date.parse(rehearsalCompletedAt) +
        minimumArtifactRetentionMilliseconds
  ) {
    return failEvidence()
  }
  return {
    kind: expectedKind,
    contentDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'contentDigest'),
    ),
    byteLength: readPositiveCount(
      evidenceGuards.readOwn(record, 'byteLength'),
      maximumChildArtifactByteLength,
    ),
    immutableVersionDigest: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'immutableVersionDigest'),
    ),
    retainedUntil,
  }
}

/** Reads exact HMAC metadata without authenticating it. */
function readAuthentication(
  value: unknown,
): WorkspaceSearchMigrationRehearsalEvidenceAuthentication {
  const record = evidenceGuards.requireRecord(value)
  evidenceGuards.requireExactKeys(record, [
    'algorithm',
    'indexMac',
    'keyFingerprint',
  ])
  if (evidenceGuards.readOwn(record, 'algorithm') !== 'HMAC-SHA-256') {
    return failEvidence()
  }
  return {
    algorithm: 'HMAC-SHA-256',
    keyFingerprint: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'keyFingerprint'),
    ),
    indexMac: evidenceGuards.readDigest(
      evidenceGuards.readOwn(record, 'indexMac'),
    ),
  }
}

/** Creates the HMAC over every claim and non-MAC authentication field. */
function createIndexMac(
  claims: WorkspaceSearchMigrationRehearsalEvidenceClaims,
  keyFingerprint: string,
  key: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(indexMacDomain, 'utf8')
    .update(serializeCanonicalJson({
      ...claims,
      authentication: {
        algorithm: 'HMAC-SHA-256',
        keyFingerprint,
      },
    }), 'utf8')
    .digest('hex')
}

/** Creates a domain-separated fingerprint for the dedicated HMAC key. */
function createKeyFingerprint(key: Uint8Array): string {
  return createHmac('sha256', key)
    .update(keyFingerprintDomain, 'utf8')
    .digest('hex')
}

/** Copies one exact ordinary 32-byte Uint8Array authentication key. */
function copyEvidenceKey(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    types.isProxy(value) ||
    evidenceGuards.readIntrinsicByteLength(value) !== evidenceKeyByteLength
  ) {
    return failEvidence()
  }
  try {
    const copied: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      value,
      [],
    )
    if (
      !(copied instanceof Uint8Array) ||
      copied.byteLength !== evidenceKeyByteLength
    ) {
      return failEvidence()
    }
    return copied
  } catch {
    return failEvidence()
  }
}

/** Copies bounded candidate bytes without retaining caller-owned storage. */
function copyEvidenceBytes(value: unknown): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    types.isProxy(value)
  ) {
    return failEvidence()
  }
  const byteLength = evidenceGuards.readIntrinsicByteLength(value)
  if (
    byteLength === 0 ||
    byteLength > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_EVIDENCE_MAX_BYTES
  ) {
    return failEvidence()
  }
  try {
    const copied: unknown = Reflect.apply(
      Uint8Array.prototype.slice,
      value,
      [],
    )
    if (!(copied instanceof Uint8Array) || copied.byteLength !== byteLength) {
      return failEvidence()
    }
    return copied
  } catch {
    return failEvidence()
  }
}

/** Reads one dense ordinary array with no extra or accessor properties. */
function readExactArray(
  value: unknown,
  expectedLength: number,
): readonly unknown[] {
  if (!Array.isArray(value) || types.isProxy(value)) {
    return failEvidence()
  }
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.length !== expectedLength + 1) return failEvidence()
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  if (
    lengthDescriptor === undefined ||
    !Object.hasOwn(lengthDescriptor, 'value') ||
    lengthDescriptor.value !== expectedLength
  ) {
    return failEvidence()
  }
  const result: unknown[] = []
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value')
    ) {
      return failEvidence()
    }
    result.push(descriptor.value)
  }
  return result
}

/** Reads a literal null value. */
function readNull(value: unknown): null {
  if (value !== null) return failEvidence()
  return null
}

/** Reads one bounded nonnegative safe integer count. */
function readCount(
  value: unknown,
  maximum: number = maximumEvidenceCount,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximum
  ) {
    return failEvidence()
  }
  return value
}

/** Reads one bounded positive safe integer count. */
function readPositiveCount(
  value: unknown,
  maximum: number = maximumEvidenceCount,
): number {
  const count = readCount(value, maximum)
  if (count === 0) return failEvidence()
  return count
}

/** Reads one exact lowercase 40-character Git commit OID. */
function readCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return failEvidence()
  }
  return value
}

/** Compares two fixed-size lowercase digests without timing leakage. */
function safeDigestEqual(left: string, right: string): boolean {
  if (!isHexDigest(left) || !isHexDigest(right)) return false
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Compares two byte sequences exactly. */
function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

/** Raises the sole raw-value-free evidence failure. */
function failEvidence(): never {
  throw new WorkspaceSearchMigrationRehearsalEvidenceError()
}
