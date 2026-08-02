import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  parseCrossDomainIntegrityResourceAttestation,
  serializeCrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceAttestation,
} from '../../data-integrity/cross-domain-integrity'
import {
  authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult,
  consumeWorkspaceSearchMigrationRehearsalIntegrityPreimageResult,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RESULT_MAX_BYTES,
  type WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection,
} from './migration-rehearsal-integrity-evidence'
import {
  createMigrationDigest,
  isHexDigest,
  isCanonicalTimestamp,
  serializeCanonicalJson,
  type WorkspaceSearchMigrationConfiguration,
  type WorkspaceSearchMigrationTableRole,
} from './migration-contract'
import {
  createWorkspaceSearchMigrationRequestedResourcesBinding,
} from './migration-identity'
import type {
  WorkspaceSearchMigrationDescribeTablePhase,
  WorkspaceSearchMigrationDescribeTableRateEvidence,
} from './migration-describe-table-rate-budget'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
} from './migration-describe-table-rate-budget'
import {
  consumeWorkspaceSearchMigrationRehearsalIntegrityRateSequence,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE,
  type WorkspaceSearchMigrationRehearsalIntegrityRateSequence,
} from './migration-rehearsal-integrity-rate-adapter'
import {
  consumeWorkspaceSearchMigrationRehearsalRootMeasurement,
  type WorkspaceSearchMigrationRehearsalRootMeasurementCapability,
} from './migration-rehearsal-root-measurement'
import {
  consumeWorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor,
  createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_KEY_BYTES,
  WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES,
  verifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessor,
  verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor,
  type WorkspaceSearchMigrationRehearsalVerifiedRateSegment,
} from './migration-rehearsal-rate-evidence'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Version of the exact authenticated integrity-rate interval contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION =
  1

/** Fixed identifier-free evidence label for one exact integrity interval. */
const integrityRateIntervalKind =
  'mukuroji-workspace-search-migration-rehearsal-integrity-rate-interval'

/** Stable raw-value-free failure for every malformed or inconsistent input. */
const invalidIntegrityRateEvidenceMessage =
  'INVALID_REHEARSAL_INTEGRITY_RATE_EVIDENCE'

/** Maximum event records re-read after exact segment authentication. */
const maximumIntegrityRateEvents = 100_000

/** Maximum exact canonical owner-only root file size accepted on reentry. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_ATTESTATION_ROOT_MAX_BYTES =
  1 * 1_024 * 1_024

/** Domain separating private table order from every externally visible digest. */
const tableOrderBindingMacDomain =
  'mukuroji:workspace-search-migration:integrity-table-order-binding:v1\0'

/** Domain separating a rate-bound live result from other runtime evidence. */
const rateBoundIntegrityResultMacDomain =
  'mukuroji:workspace-search-migration:rate-bound-integrity-result:v1\0'

/** Domain separating exact private attestation content from other evidence. */
const rootAttestationContentMacDomain =
  'mukuroji:workspace-search-migration:root-attestation-content:v1\0'

/** Domain separating the complete owner-only pre-permit root. */
const integrityAttestationRootMacDomain =
  'mukuroji:workspace-search-migration:integrity-attestation-root:v1\0'

/** Fixed discriminator for the one-shot permit-purpose root token. */
const integrityAttestationRootPermitAuthorizationKind =
  'mukuroji-workspace-search-migration-rehearsal-integrity-root-permit-authorization'

/** Fixed discriminator for the one-shot inventory-purpose root token. */
const integrityAttestationRootInventoryAuthorizationKind =
  'mukuroji-workspace-search-migration-rehearsal-integrity-root-inventory-authorization'

/** Private brand retaining genuine interval claims for one downstream use. */
const authenticatedPrivateIntegrityRateBindings = new WeakMap<
  object,
  AuthenticatedPrivateIntegrityRateBindingState
>()

/** Genuine same-process rate-bound live results awaiting one collector. */
const authenticatedRateBoundIntegrityResults = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult
>()

/** Genuine same-process finalized roots awaiting token separation once. */
const authenticatedIntegrityAttestationRoots = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot
>()

/** Permit-only tokens that cannot authorize complete-stream inventory. */
const integrityAttestationRootPermitAuthorizations = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot
>()

/** Inventory-only tokens that cannot authorize permit issuance. */
const integrityAttestationRootInventoryAuthorizations = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot
>()

/** Supported authenticated rate-event labels. */
type AuthenticatedRateEventKind =
  | 'attempt-charged'
  | 'attempt-forfeited'
  | 'attempt-started'
  | 'attempt-throttled'
  | 'budget-stop'
  | 'cadence-wait'
  | 'reservation-forfeited'

/** Minimal authenticated event projection required to isolate one operation. */
type AuthenticatedRateEventProjection = {
  /** Exact durable event label. */
  readonly kind: AuthenticatedRateEventKind
  /** Global one-based durable event sequence. */
  readonly eventSequence: number
  /** Non-negative offset from the authenticated segment UTC anchor. */
  readonly offsetMilliseconds: number
  /** Semantic phase when the authenticated event owns one. */
  readonly phase?: WorkspaceSearchMigrationDescribeTablePhase
  /** Global durable attempt sequence when the event owns one. */
  readonly attemptSequence?: number
  /** Exact cadence delay when the event records admission waiting. */
  readonly delayMilliseconds?: number
}

/** Authenticated header projection required to derive absolute event times. */
type AuthenticatedRateHeaderProjection = {
  /** Canonical UTC anchor authenticated by the segment record chain. */
  readonly anchorUtc: string
}

/** Parsed exact segment projection authenticated before it is interpreted. */
type AuthenticatedRateSegmentProjection = {
  /** Authenticated UTC header projection. */
  readonly header: AuthenticatedRateHeaderProjection
  /** Exact durable event order from the authenticated canonical bytes. */
  readonly events: readonly AuthenticatedRateEventProjection[]
}

/** Input for isolating one exact rate-owned integrity operation. */
export type VerifyWorkspaceSearchMigrationRehearsalIntegrityRateIntervalInput = {
  /** Exact canonical bytes of the closed segment containing the operation. */
  readonly canonicalSegmentBytes: Uint8Array
  /** Derived runtime evidence key authenticating every raw segment record. */
  readonly authenticationKey: Uint8Array
  /** Exact raw predecessor bytes, or null only for the ordinal-zero root. */
  readonly predecessorSegmentBytes: Uint8Array | null
  /** Reviewed durable DescribeTable policy digest. */
  readonly expectedPolicyVersion: string
  /** Exact measured session/configuration binding digest. */
  readonly expectedConfigurationBindingDigest: string
  /** Trusted operation start sampled before any selected external read. */
  readonly expectedStartedAt: string
  /** Trusted operation completion sampled after every selected external read. */
  readonly expectedCompletedAt: string
  /** Fresh one-shot adapter capability for this exact operation. */
  readonly sequence: WorkspaceSearchMigrationRehearsalIntegrityRateSequence
  /** Exact object reference causally returned by the adapter-owned task. */
  readonly taskResult: object
}

/** Exact identifier-free authenticated interval owned by one integrity run. */
export type WorkspaceSearchMigrationRehearsalIntegrityRateInterval = {
  /** Fixed interval evidence discriminator. */
  readonly kind: typeof integrityRateIntervalKind
  /** Initial exact interval evidence version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION
  /** Sole semantic phase admitted for every selected event. */
  readonly phase:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE
  /** One root attestation pass or two live preflight/postflight passes. */
  readonly tablePassCount: 1 | 2
  /** Exact number of successfully completed rate-owned DescribeTable calls. */
  readonly describeTableCallCount: 6 | 12
  /** First global durable attempt sequence selected by the adapter. */
  readonly firstAttemptSequence: number
  /** Last global durable attempt sequence selected by the adapter. */
  readonly lastAttemptSequence: number
  /** Exact contiguous global attempt vector for the selected operation. */
  readonly attemptSequences: readonly number[]
  /** First authenticated durable event in the exact selected interval. */
  readonly firstEventSequence: number
  /** Last authenticated durable event in the exact selected interval. */
  readonly lastEventSequence: number
  /** Exact contiguous durable event vector, including cadence waits. */
  readonly eventSequences: readonly number[]
  /** Number of authenticated cadence waits owned by this operation. */
  readonly cadenceWaitCount: number
  /** Total authenticated cadence delay owned by this operation. */
  readonly cadenceWaitMilliseconds: number
  /** Absolute UTC timestamp of the first selected authenticated event. */
  readonly startedAt: string
  /** Absolute UTC timestamp of the last selected authenticated event. */
  readonly completedAt: string
}

/** Private exact-order claims consumed only by an owner-side HMAC finalizer. */
export type WorkspaceSearchMigrationRehearsalPrivateIntegrityRateBinding = {
  /** Independently authenticated predecessor, or null for the root segment. */
  readonly predecessor:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null
  /** Independently authenticated exact segment summary. */
  readonly segment: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Exact authenticated identifier-free operation interval. */
  readonly interval: WorkspaceSearchMigrationRehearsalIntegrityRateInterval
  /** Owner-only digest of logical targets plus exact physical table names. */
  readonly tableOrderBindingDigest: string
  /** Reviewed durable DescribeTable policy digest authenticated by the header. */
  readonly policyVersion: string
  /** Measured session/configuration digest authenticated by the header. */
  readonly configurationBindingDigest: string
  /** Trusted operation start used when selecting the event interval. */
  readonly operationStartedAt: string
  /** Trusted operation completion used when selecting the event interval. */
  readonly operationCompletedAt: string
}

/** Input for binding one exact live #163 result to its authenticated rate calls. */
export type FinalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResultInput = {
  /** Fresh private interval capability from the raw segment verifier. */
  readonly rateBinding:
    WorkspaceSearchMigrationRehearsalPrivateIntegrityRateBinding
  /** Exact complete #163 result object returned by the adapter-owned task. */
  readonly result: object
  /** Owner-only raw immutable resource attestation used by that checker. */
  readonly resourceAttestation: unknown
  /** Dedicated 32-byte #163 result HMAC key consumed by authentication. */
  readonly integrityDigestKey: Uint8Array
  /** Derived runtime evidence key used to authenticate the raw rate segment. */
  readonly rateAuthenticationKey: Uint8Array
  /** Permit/manifest physical-resource identity digest required by #163. */
  readonly expectedResourceIdentityDigest: string
  /** Trusted clock sampled after complete result authentication. */
  readonly clock: () => Date
}

/** Public-safe exact live-result and authenticated rate-interval projection. */
export type WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult = {
  /** Fixed rate-bound live-result discriminator. */
  readonly kind:
    'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result'
  /** Initial rate-bound live-result contract. */
  readonly version: 1
  /** Exact authenticated raw-file and complete #163 result projection. */
  readonly result:
    WorkspaceSearchMigrationRehearsalIntegrityLiveResultProjection
  /** Authenticated immediate predecessor summary for the shared segment. */
  readonly predecessor: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Authenticated exact segment containing this result's external reads. */
  readonly segment: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Exact authenticated call/cadence interval inside result provenance. */
  readonly interval: WorkspaceSearchMigrationRehearsalIntegrityRateInterval
  /** Reviewed durable DescribeTable policy digest. */
  readonly policyVersion: string
  /** Exact measured session/configuration binding digest. */
  readonly configurationBindingDigest: string
  /** Opaque keyed binding of canonical logical targets and physical names. */
  readonly tableOrderBindingMac: string
  /** HMAC covering every public field and the private exact-order binding. */
  readonly bindingMac: string
}

/** Input for sealing the dedicated ordinal-zero pre-permit root. */
export type FinalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRootInput = {
  /** Fresh root interval capability produced from the ordinal-zero segment. */
  readonly rateBinding:
    WorkspaceSearchMigrationRehearsalPrivateIntegrityRateBinding
  /** Fresh causal authority for the first six configuration measurements. */
  readonly measurementCapability:
    WorkspaceSearchMigrationRehearsalRootMeasurementCapability
  /** Exact configuration object returned by the managed measurement port. */
  readonly measuredConfiguration: WorkspaceSearchMigrationConfiguration
  /** Exact raw immutable resource attestation returned by the adapter task. */
  readonly resourceAttestation: unknown
  /** Exact owner-only attestation file bytes written by root preflight. */
  readonly resourceAttestationBytes: Uint8Array
  /** Dedicated 32-byte #163 identity key transferred to the finalizer. */
  readonly integrityDigestKey: Uint8Array
  /** Derived runtime key authenticating root records and binding HMACs. */
  readonly rateAuthenticationKey: Uint8Array
  /** Source-controlled non-production deployment target identifier. */
  readonly deploymentTargetId: string
  /** Canonical digest of the reviewed source-controlled target claims. */
  readonly deploymentTrustRootDigest: string
  /** Source-controlled digest of the protected production account. */
  readonly productionAccountDigest: string
  /** Exact isolated non-production account selected by the target. */
  readonly account: string
  /** Exact deployment Region selected by the target. */
  readonly region: string
  /** Exact STS assumed-role caller authorized for root measurement. */
  readonly callerArn: string
  /** Exact reviewed lowercase Git commit OID. */
  readonly commit: string
  /** Digest binding every operator-selected migration resource. */
  readonly requestedResourcesBinding: string
  /** SHA-256 digest of the exact derived runtime evidence key. */
  readonly evidenceKeyDigest: string
  /** SHA-256 digest of the isolated parent-only publication key. */
  readonly publicationKeyDigest: string
  /** Final durable aggregate read after closing root admissions. */
  readonly durableEvidence: WorkspaceSearchMigrationDescribeTableRateEvidence
}

/** Exact root identity fields recovered from the consumed measurement result. */
type RootMeasuredConfigurationIdentity = {
  /** Exact measured AWS account. */
  readonly account: string
  /** Exact measured AWS Region. */
  readonly region: string
  /** Exact measured STS caller ARN. */
  readonly callerArn: string
  /** Exact measured reviewed Git commit. */
  readonly commit: string
}

/** Owner-only attestation projection without raw physical resource names. */
export type WorkspaceSearchMigrationRehearsalIntegrityAttestationProjection = {
  /** Opaque HMAC of the exact canonical private attestation bytes. */
  readonly contentMac: string
  /** Exact canonical private attestation byte length. */
  readonly byteLength: number
  /** Fixed immutable-incarnation scheme authenticated by the attestation. */
  readonly resourceIdentityScheme:
    'immutable-incarnation-v1'
  /** Canonical seven-entry keyed immutable physical-resource vector. */
  readonly resourceIdentities: readonly {
    /** Fixed logical resource target. */
    readonly target: string
    /** HMAC identifying one exact immutable physical incarnation. */
    readonly identityDigest: string
  }[]
  /** Keyed digest of the exact canonical physical-resource vector. */
  readonly resourceIdentityDigest: string
}

/** Owner-only authenticated pre-permit root retained by permit issuance. */
export type WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot = {
  /** Fixed owner-only root discriminator. */
  readonly kind:
    'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root'
  /** Initial root contract version. */
  readonly version: 1
  /** Exact source-controlled deployment target identifier. */
  readonly deploymentTargetId: string
  /** Canonical reviewed deployment trust-root digest. */
  readonly deploymentTrustRootDigest: string
  /** Source-controlled digest of the unreachable production account. */
  readonly productionAccountDigest: string
  /** Exact isolated non-production account retained only in owner state. */
  readonly account: string
  /** Exact target Region retained only in owner state. */
  readonly region: string
  /** Exact authorized STS caller retained only in owner state. */
  readonly callerArn: string
  /** Exact reviewed implementation commit. */
  readonly commit: string
  /** Digest binding every requested migration resource. */
  readonly requestedResourcesBinding: string
  /** Measured session/configuration binding authenticated by the root header. */
  readonly configurationBindingDigest: string
  /** Reviewed durable DescribeTable policy digest. */
  readonly policyVersion: string
  /** SHA-256 digest of the derived runtime evidence key. */
  readonly evidenceKeyDigest: string
  /** SHA-256 digest of the distinct parent-only publication key. */
  readonly publicationKeyDigest: string
  /** Owner-only attestation projection with no physical names. */
  readonly attestation:
    WorkspaceSearchMigrationRehearsalIntegrityAttestationProjection
  /** Mandatory absence of a predecessor for the ordinal-zero segment. */
  readonly predecessor: null
  /** Exact authenticated ordinal-zero segment summary. */
  readonly segment: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Exact six-call integrity interval after six migration measurements. */
  readonly interval: WorkspaceSearchMigrationRehearsalIntegrityRateInterval
  /** Final durable root rate aggregate independently matched to raw events. */
  readonly aggregate: WorkspaceSearchMigrationDescribeTableRateEvidence
  /** Canonical digest of the exact final durable root aggregate. */
  readonly aggregateDigest: string
  /** Trusted root operation start preceding all selected reads. */
  readonly startedAt: string
  /** Trusted root completion after all selected reads and rate close. */
  readonly completedAt: string
  /** Opaque keyed binding of canonical logical targets and physical names. */
  readonly tableOrderBindingMac: string
  /** HMAC authenticating every owner-only root claim. */
  readonly rootMac: string
}

/** Exact persisted inputs required to reauthenticate one owner-only root. */
export type VerifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRootInput = {
  /** Exact canonical newline-terminated owner-only root file bytes. */
  readonly rootBytes: Uint8Array
  /** Exact canonical ordinal-zero rate segment bytes retained separately. */
  readonly canonicalSegmentBytes: Uint8Array
  /** Exact canonical private resource-attestation file bytes. */
  readonly resourceAttestationBytes: Uint8Array
  /** Derived runtime evidence key authenticating the root and raw segment. */
  readonly rateAuthenticationKey: Uint8Array
}

/** Opaque same-process authorization consumable only by permit issuance. */
export type WorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization = {
  /** Fixed permit-purpose capability discriminator. */
  readonly kind: typeof integrityAttestationRootPermitAuthorizationKind
  /** Initial one-shot capability version. */
  readonly version: 1
  /** Root MAC retained only as a non-authoritative diagnostic binding. */
  readonly rootMac: string
}

/** Opaque same-process authorization consumable only by stream inventory. */
export type WorkspaceSearchMigrationRehearsalIntegrityRootInventoryAuthorization = {
  /** Fixed inventory-purpose capability discriminator. */
  readonly kind: typeof integrityAttestationRootInventoryAuthorizationKind
  /** Initial one-shot capability version. */
  readonly version: 1
  /** Root MAC retained only as a non-authoritative diagnostic binding. */
  readonly rootMac: string
}

/** Purpose-separated one-shot authorizations for one authenticated root. */
export type WorkspaceSearchMigrationRehearsalIntegrityRootAuthorizations = {
  /** Permit-only one-shot root authorization. */
  readonly permit:
    WorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization
  /** Complete-stream-inventory-only one-shot root authorization. */
  readonly inventory:
    WorkspaceSearchMigrationRehearsalIntegrityRootInventoryAuthorization
}

/** Minimal durable owner projection copied into permit and manifest chains. */
export type WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection = {
  /** Fixed durable projection discriminator. */
  readonly kind:
    'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection'
  /** Initial exact durable projection version. */
  readonly version: 1
  /** Exact source-controlled deployment target identifier. */
  readonly deploymentTargetId: string
  /** Source-controlled digest of the protected production account. */
  readonly productionAccountDigest: string
  /** Measured configuration digest authenticated by the root header. */
  readonly configurationBindingDigest: string
  /** Reviewed durable DescribeTable policy digest. */
  readonly policyVersion: string
  /** Opaque exact private-attestation content binding and byte length. */
  readonly attestation: {
    /** Runtime-keyed HMAC of the exact owner-only canonical file bytes. */
    readonly contentMac: string
    /** Exact canonical owner-only file byte length. */
    readonly byteLength: number
  }
  /** Exact authenticated ordinal-zero segment summary. */
  readonly segment: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Exact six-call integrity interval after six migration measurements. */
  readonly interval: WorkspaceSearchMigrationRehearsalIntegrityRateInterval
  /** Exact final clean twelve-attempt root aggregate. */
  readonly aggregate: WorkspaceSearchMigrationDescribeTableRateEvidence
  /** Canonical digest of the exact final root aggregate. */
  readonly aggregateDigest: string
  /** Opaque runtime-keyed exact physical table-order binding. */
  readonly tableOrderBindingMac: string
  /** Runtime-keyed HMAC authenticating the complete owner-only root. */
  readonly rootMac: string
  /** Trusted complete root operation start. */
  readonly startedAt: string
  /** Trusted complete root operation completion. */
  readonly completedAt: string
}

/** Trusted top-level permit claims compared with the private full root. */
export type WorkspaceSearchMigrationRehearsalIntegrityRootPermitExpectedClaims = {
  /** Exact source-controlled deployment target identifier. */
  readonly deploymentTargetId: string
  /** Canonical reviewed deployment trust-root digest. */
  readonly deploymentTrustRootDigest: string
  /** Source-controlled digest of the protected production account. */
  readonly productionAccountDigest: string
  /** Exact isolated non-production AWS account. */
  readonly account: string
  /** Exact isolated target AWS Region. */
  readonly region: string
  /** Exact authorized STS assumed-role caller. */
  readonly callerArn: string
  /** Exact reviewed lowercase Git commit OID. */
  readonly commit: string
  /** Digest binding all requested migration resources. */
  readonly requestedResourcesBinding: string
  /** Exact measured configuration binding digest. */
  readonly configurationBindingDigest: string
  /** Reviewed durable DescribeTable policy digest. */
  readonly policyVersion: string
  /** SHA-256 digest of the runtime evidence key. */
  readonly evidenceKeyDigest: string
  /** SHA-256 digest of the distinct publication key. */
  readonly publicationKeyDigest: string
  /** Fixed immutable physical-resource identity scheme. */
  readonly resourceIdentityScheme: 'immutable-incarnation-v1'
  /** Canonical seven-entry keyed immutable resource vector. */
  readonly resourceIdentities: readonly {
    /** Fixed logical resource target. */
    readonly target: string
    /** HMAC identifying one exact physical incarnation. */
    readonly identityDigest: string
  }[]
  /** Keyed digest of the exact seven-entry identity vector. */
  readonly resourceIdentityDigest: string
  /** Canonical permit issue time at or after root completion. */
  readonly issuedAt: string
}

/** Input consuming permit authority only after exact full-root comparison. */
export type ConsumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorizationInput = {
  /** Genuine one-shot permit-purpose root token. */
  readonly authorization:
    WorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization
  /** Trusted top-level permit claims and exact issue boundary. */
  readonly expected:
    WorkspaceSearchMigrationRehearsalIntegrityRootPermitExpectedClaims
}

/** Stable fail-closed error without raw resource names or evidence content. */
export class WorkspaceSearchMigrationRehearsalIntegrityRateEvidenceError
  extends Error {
  /** Stable machine-readable failure code. */
  readonly code = invalidIntegrityRateEvidenceMessage

  /** Creates the sole public evidence failure. */
  constructor() {
    super(invalidIntegrityRateEvidenceMessage)
    this.name =
      'WorkspaceSearchMigrationRehearsalIntegrityRateEvidenceError'
  }
}

/** Detached exact input snapshot captured without invoking accessors. */
type IntegrityRateIntervalInputSnapshot = {
  /** Copied exact current segment bytes. */
  readonly canonicalSegmentBytes: Uint8Array
  /** Copied exact raw predecessor bytes, or null for root. */
  readonly predecessorSegmentBytes: Uint8Array | null
  /** Copied exact derived runtime authentication key. */
  readonly authenticationKey: Uint8Array
  /** Reviewed durable rate-policy digest. */
  readonly expectedPolicyVersion: string
  /** Measured session/configuration binding digest. */
  readonly expectedConfigurationBindingDigest: string
  /** Trusted operation start boundary. */
  readonly expectedStartedAt: string
  /** Trusted operation completion boundary. */
  readonly expectedCompletedAt: string
  /** Untrusted candidate one-shot adapter capability. */
  readonly sequence: unknown
  /** Exact object reference returned by the adapter-owned task. */
  readonly taskResult: object
}

/** Genuine private binding plus its causally associated task result. */
type AuthenticatedPrivateIntegrityRateBindingState = {
  /** Detached authenticated rate binding claims. */
  readonly binding:
    WorkspaceSearchMigrationRehearsalPrivateIntegrityRateBinding
  /** Exact object reference returned inside the adapter boundary. */
  readonly taskResult: object
  /** Canonical task-result digest sampled when the sequence was consumed. */
  readonly taskResultBindingDigest: string
  /** Copied exact authenticated current-segment bytes. */
  readonly canonicalSegmentBytes: Uint8Array
}

/** Exact copied owner-only attestation file and its canonical parsed value. */
type ExactResourceAttestationFile = {
  /** Exact canonical bytes copied without retaining a caller alias. */
  readonly bytes: Uint8Array
  /** Detached deeply frozen attestation parsed from those exact bytes. */
  readonly attestation: CrossDomainIntegrityResourceAttestation
}

/** Exact copied canonical root file and its strict detached root claims. */
type ExactIntegrityAttestationRootFile = {
  /** Exact canonical newline-terminated copied file bytes. */
  readonly bytes: Uint8Array
  /** Strict detached root parsed from those exact bytes. */
  readonly root: WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot
}

/** Strict guards used for intrinsic typed-array and input record reads. */
const integrityRateGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failIntegrityRateEvidence,
)

/**
 * Authenticates one exact raw rate segment and isolates the adapter-owned calls.
 *
 * The one-shot adapter capability selects a globally unique attempt interval.
 * The raw segment is copied, HMAC-authenticated with the runtime evidence key,
 * linked to its exact predecessor, and only then re-read. Every selected call
 * must be an adjacent charged/started pair in the `integrity-check` phase; no
 * measurement or reconciliation event can substitute for one of the calls.
 *
 * The returned table-order digest remains owner-only. A downstream finalizer
 * must compare it with the raw resource attestation and expose only a keyed,
 * opaque projection outside the private permit boundary.
 *
 * @param input - Raw segment, runtime key, chain, timestamps, and capability.
 * @returns Frozen authenticated segment, exact interval, and private order claim.
 */
export function verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval(
  input: unknown,
): WorkspaceSearchMigrationRehearsalPrivateIntegrityRateBinding {
  let key: Uint8Array | undefined
  try {
    const snapshot = readIntervalInput(input)
    const canonicalSegmentBytes = snapshot.canonicalSegmentBytes
    key = snapshot.authenticationKey
    const expectedStartedAt = snapshot.expectedStartedAt
    const expectedCompletedAt = snapshot.expectedCompletedAt
    if (Date.parse(expectedStartedAt) > Date.parse(expectedCompletedAt)) {
      return failIntegrityRateEvidence()
    }
    const sequence =
      consumeWorkspaceSearchMigrationRehearsalIntegrityRateSequence(
        snapshot.sequence,
        snapshot.taskResult,
      )
    let predecessor:
      WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null
    let segment: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
    if (snapshot.predecessorSegmentBytes === null) {
      predecessor = null
      segment = verifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessor({
        canonicalBytes: canonicalSegmentBytes,
        authenticationKey: key,
        expectedPreviousSegment: null,
        expectedPolicyVersion: snapshot.expectedPolicyVersion,
        expectedConfigurationBindingDigest:
          snapshot.expectedConfigurationBindingDigest,
      })
    } else {
      const verified =
        consumeWorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor(
          verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor({
            predecessorSegmentBytes: snapshot.predecessorSegmentBytes,
            successorSegmentBytes: canonicalSegmentBytes,
            authenticationKey: key,
            expectedPolicyVersion: snapshot.expectedPolicyVersion,
            expectedConfigurationBindingDigest:
              snapshot.expectedConfigurationBindingDigest,
          }),
        )
      predecessor = verified.predecessor
      segment = verified.successor
    }
    const projection = readAuthenticatedSegmentProjection(
      canonicalSegmentBytes,
    )
    const interval = selectIntegrityRateInterval(
      projection,
      sequence,
      expectedStartedAt,
      expectedCompletedAt,
    )
    const claims = Object.freeze({
      predecessor,
      segment,
      interval,
      tableOrderBindingDigest: sequence.tableOrderBindingDigest,
      policyVersion: snapshot.expectedPolicyVersion,
      configurationBindingDigest:
        snapshot.expectedConfigurationBindingDigest,
      operationStartedAt: snapshot.expectedStartedAt,
      operationCompletedAt: snapshot.expectedCompletedAt,
    })
    const capability = Object.freeze({ ...claims })
    authenticatedPrivateIntegrityRateBindings.set(capability, {
      binding: claims,
      taskResult: snapshot.taskResult,
      taskResultBindingDigest: createMigrationDigest(snapshot.taskResult),
      canonicalSegmentBytes: snapshot.canonicalSegmentBytes.slice(),
    })
    return capability
  } catch {
    return failIntegrityRateEvidence()
  } finally {
    key?.fill(0)
  }
}

/**
 * Authenticates and HMAC-binds one live #163 result to its exact rate interval.
 *
 * This is the sole consumer of the private interval brand. It authenticates
 * the complete raw #163 result with the dedicated integrity key, consumes the
 * resulting live preimage capability, requires the exact 12-call interval to
 * fit inside the authenticated runtime provenance, and verifies that the same
 * derived runtime key authenticated the raw rate segment. The unkeyed digest
 * containing physical table names is replaced with an opaque keyed MAC before
 * any result leaves this owner-only boundary.
 *
 * @param input - Private rate capability, raw result, keys, resources, clock.
 * @returns Frozen public-safe result/rate projection and whole-binding HMAC.
 */
export function finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
  input: unknown,
): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult {
  let rateKey: Uint8Array | undefined
  let integrityKey: Uint8Array | undefined
  try {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'clock',
      'expectedResourceIdentityDigest',
      'integrityDigestKey',
      'rateAuthenticationKey',
      'rateBinding',
      'resourceAttestation',
      'result',
    ])
    const privateState = consumePrivateIntegrityRateBinding(
      readOwn(record, 'rateBinding'),
    )
    const privateRateBinding = privateState.binding
    if (
      privateRateBinding.predecessor === null ||
      privateRateBinding.interval.tablePassCount !== 2 ||
      privateRateBinding.interval.describeTableCallCount !== 12
    ) return failIntegrityRateEvidence()
    rateKey = copyAuthenticationKey(
      readOwn(record, 'rateAuthenticationKey'),
    )
    const transferredIntegrityKey = readOwn(record, 'integrityDigestKey')
    integrityKey = copyFixedKey(transferredIntegrityKey)
    zeroizeTransferredKey(transferredIntegrityKey)
    const expectedResourceIdentityDigest = readDigest(
      readOwn(record, 'expectedResourceIdentityDigest'),
    )
    const resourceAttestation =
      parseCrossDomainIntegrityResourceAttestation(
        readOwn(record, 'resourceAttestation'),
      )
    const attestedResourceIdentities =
      createCrossDomainIntegrityImmutableResourceIdentities(
        resourceAttestation,
        integrityKey,
      )
    if (
      calculateCrossDomainIntegrityResourceIdentityDigest(
        attestedResourceIdentities,
        integrityKey,
      ) !== expectedResourceIdentityDigest ||
      createMigrationDigest(resourceAttestation.tables.map((table) => ({
        target: table.target,
        tableName: table.tableName,
      }))) !== privateRateBinding.tableOrderBindingDigest
    ) return failIntegrityRateEvidence()
    const clock = readClock(readOwn(record, 'clock'))
    const taskResult = readTaskResult(readOwn(record, 'result'))
    if (
      taskResult !== privateState.taskResult ||
      createMigrationDigest(taskResult) !==
        privateState.taskResultBindingDigest
    ) {
      return failIntegrityRateEvidence()
    }
    const resultBytes = serializeTaskResultBytes(taskResult)
    if (
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        rateKey,
      ) !== privateRateBinding.segment.authenticationKeyFingerprint
    ) return failIntegrityRateEvidence()
    const preimage =
      authenticateWorkspaceSearchMigrationRehearsalIntegrityPreimageResult({
        resultBytes,
        expectedResourceIdentityDigest,
        clock,
      }, integrityKey)
    integrityKey = undefined
    const result =
      consumeWorkspaceSearchMigrationRehearsalIntegrityPreimageResult(preimage)
    const provenance = result.runtimeProvenance
    if (
      privateRateBinding.operationStartedAt !== provenance.startedAt ||
      privateRateBinding.operationCompletedAt !== provenance.completedAt ||
      Date.parse(privateRateBinding.interval.startedAt) <
        Date.parse(provenance.startedAt) ||
      Date.parse(privateRateBinding.interval.completedAt) >
        Date.parse(provenance.completedAt) ||
      serializeCanonicalJson(result.resourceIdentities) !==
        serializeCanonicalJson(attestedResourceIdentities)
    ) return failIntegrityRateEvidence()
    const tableOrderBindingMac = createDomainMac(
      rateKey,
      tableOrderBindingMacDomain,
      privateRateBinding.tableOrderBindingDigest,
    )
    const claims = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-rate-bound-integrity-result',
      version: 1,
      result,
      predecessor: privateRateBinding.predecessor,
      segment: privateRateBinding.segment,
      interval: privateRateBinding.interval,
      policyVersion: privateRateBinding.policyVersion,
      configurationBindingDigest:
        privateRateBinding.configurationBindingDigest,
      tableOrderBindingMac,
    })
    const finalized = Object.freeze({
      ...claims,
      bindingMac: createDomainMac(
        rateKey,
        rateBoundIntegrityResultMacDomain,
        serializeCanonicalJson(claims),
      ),
    })
    const capability = Object.freeze({ ...finalized })
    authenticatedRateBoundIntegrityResults.set(capability, finalized)
    return capability
  } catch {
    return failIntegrityRateEvidence()
  } finally {
    rateKey?.fill(0)
    integrityKey?.fill(0)
  }
}

/**
 * Consumes one genuine same-process rate-bound live result exactly once.
 *
 * @param value - Exact object returned by the combined live finalizer.
 * @returns Detached frozen result safe for immediate authenticated collection.
 */
export function consumeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return failIntegrityRateEvidence()
  const finalized = authenticatedRateBoundIntegrityResults.get(value)
  if (finalized === undefined) return failIntegrityRateEvidence()
  authenticatedRateBoundIntegrityResults.delete(value)
  return Object.freeze({ ...finalized })
}

/**
 * Seals the dedicated ordinal-zero attestation and rate segment before permit.
 *
 * The exact attestation object must be the object causally returned by the
 * adapter task. This boundary consumes the private interval brand, rechecks
 * the task digest, authenticates the same runtime rate key, derives the public
 * seven-resource #163 vector with the transferred integrity key, compares the
 * private canonical table order, and independently matches the final durable
 * root aggregate to every authenticated raw event. Raw resource names and an
 * unkeyed content digest never leave the boundary.
 *
 * @param input - Root capability, raw attestation, target claims, keys, ledger.
 * @returns Owner-only complete root authenticated by the runtime evidence key.
 */
export function finalizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
  input: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot {
  let rateKey: Uint8Array | undefined
  let integrityKey: Uint8Array | undefined
  try {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'account',
      'callerArn',
      'commit',
      'deploymentTargetId',
      'deploymentTrustRootDigest',
      'durableEvidence',
      'evidenceKeyDigest',
      'integrityDigestKey',
      'measuredConfiguration',
      'measurementCapability',
      'productionAccountDigest',
      'publicationKeyDigest',
      'rateAuthenticationKey',
      'rateBinding',
      'region',
      'requestedResourcesBinding',
      'resourceAttestation',
      'resourceAttestationBytes',
    ])
    const measuredConfigurationCandidate = readOwn(
      record,
      'measuredConfiguration',
    )
    const measurement =
      consumeWorkspaceSearchMigrationRehearsalRootMeasurement(
        readOwn(record, 'measurementCapability'),
        measuredConfigurationCandidate,
      )
    const measuredConfiguration = readRootMeasuredConfigurationIdentity(
      measuredConfigurationCandidate,
    )
    const privateState = consumePrivateIntegrityRateBinding(
      readOwn(record, 'rateBinding'),
    )
    const binding = privateState.binding
    const resourceAttestationCandidate = readTaskResult(
      readOwn(record, 'resourceAttestation'),
    )
    if (
      binding.predecessor !== null ||
      binding.segment.segmentOrdinal !== 0 ||
      binding.segment.firstEventSequence !== 1 ||
      binding.interval.tablePassCount !== 1 ||
      binding.interval.describeTableCallCount !== 6 ||
      measurement.firstAttemptSequence !== 1 ||
      measurement.lastAttemptSequence !== 6 ||
      measurement.configurationBindingDigest !==
        binding.configurationBindingDigest ||
      measurement.policyVersion !== binding.policyVersion ||
      resourceAttestationCandidate !== privateState.taskResult ||
      createMigrationDigest(resourceAttestationCandidate) !==
        privateState.taskResultBindingDigest
    ) return failIntegrityRateEvidence()
    rateKey = copyAuthenticationKey(
      readOwn(record, 'rateAuthenticationKey'),
    )
    const transferredIntegrityKey = readOwn(record, 'integrityDigestKey')
    integrityKey = copyFixedKey(transferredIntegrityKey)
    zeroizeTransferredKey(transferredIntegrityKey)
    const deploymentTargetId = readDeploymentTargetId(
      readOwn(record, 'deploymentTargetId'),
    )
    const deploymentTrustRootDigest = readDigest(
      readOwn(record, 'deploymentTrustRootDigest'),
    )
    const productionAccountDigest = readDigest(
      readOwn(record, 'productionAccountDigest'),
    )
    const account = readAwsAccount(readOwn(record, 'account'))
    const region = readAwsRegion(readOwn(record, 'region'))
    const callerArn = readCallerArn(readOwn(record, 'callerArn'), account)
    const commit = readCommit(readOwn(record, 'commit'))
    if (
      measuredConfiguration.account !== account ||
      measuredConfiguration.region !== region ||
      measuredConfiguration.callerArn !== callerArn ||
      measuredConfiguration.commit !== commit
    ) return failIntegrityRateEvidence()
    const requestedResourcesBinding = readDigest(
      readOwn(record, 'requestedResourcesBinding'),
    )
    if (
      createRootMeasuredRequestedResourcesBinding(
        measuredConfigurationCandidate,
      ) !== requestedResourcesBinding
    ) return failIntegrityRateEvidence()
    const evidenceKeyDigest = readDigest(
      readOwn(record, 'evidenceKeyDigest'),
    )
    const publicationKeyDigest = readDigest(
      readOwn(record, 'publicationKeyDigest'),
    )
    if (
      publicationKeyDigest === evidenceKeyDigest ||
      createHash('sha256').update(rateKey).digest('hex') !==
        evidenceKeyDigest ||
      createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
        rateKey,
      ) !== binding.segment.authenticationKeyFingerprint
    ) return failIntegrityRateEvidence()
    const attestationFile = readExactResourceAttestationBytes(
      readOwn(record, 'resourceAttestationBytes'),
    )
    const resourceAttestation = attestationFile.attestation
    if (
      serializeCanonicalJson(resourceAttestation) !==
        serializeCanonicalJson(resourceAttestationCandidate) ||
      resourceAttestation.account !== account ||
      resourceAttestation.region !== region ||
      createMigrationDigest(resourceAttestation.tables.map((table) => ({
        target: table.target,
        tableName: table.tableName,
      }))) !== binding.tableOrderBindingDigest
    ) return failIntegrityRateEvidence()
    const resourceIdentities =
      createCrossDomainIntegrityImmutableResourceIdentities(
        resourceAttestation,
        integrityKey,
      )
    const resourceIdentityDigest =
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        integrityKey,
      )
    const rawProjection = readAuthenticatedSegmentProjection(
      privateState.canonicalSegmentBytes,
    )
    const aggregate = calculateRootRateAggregate(
      rawProjection,
      binding.policyVersion,
      binding.interval,
      binding.operationStartedAt,
      binding.operationCompletedAt,
    )
    const durableEvidence = readMatchingDurableEvidence(
      readOwn(record, 'durableEvidence'),
      aggregate,
    )
    const tableOrderBindingMac = createDomainMac(
      rateKey,
      tableOrderBindingMacDomain,
      binding.tableOrderBindingDigest,
    )
    const claims = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root',
      version: 1,
      deploymentTargetId,
      deploymentTrustRootDigest,
      productionAccountDigest,
      account,
      region,
      callerArn,
      commit,
      requestedResourcesBinding,
      configurationBindingDigest: binding.configurationBindingDigest,
      policyVersion: binding.policyVersion,
      evidenceKeyDigest,
      publicationKeyDigest,
      attestation: Object.freeze({
        contentMac: createBytesMac(
          rateKey,
          rootAttestationContentMacDomain,
          attestationFile.bytes,
        ),
        byteLength: attestationFile.bytes.byteLength,
        resourceIdentityScheme: resourceAttestation.scheme,
        resourceIdentities,
        resourceIdentityDigest,
      }),
      predecessor: null,
      segment: binding.segment,
      interval: binding.interval,
      aggregate: durableEvidence,
      aggregateDigest: createMigrationDigest(durableEvidence),
      startedAt: binding.operationStartedAt,
      completedAt: binding.operationCompletedAt,
      tableOrderBindingMac,
    })
    const root = Object.freeze({
      ...claims,
      rootMac: createDomainMac(
        rateKey,
        integrityAttestationRootMacDomain,
        serializeCanonicalJson(claims),
      ),
    })
    authenticatedIntegrityAttestationRoots.set(root, root)
    return root
  } catch {
    return failIntegrityRateEvidence()
  } finally {
    rateKey?.fill(0)
    integrityKey?.fill(0)
  }
}

/**
 * Serializes one structurally strict owner-only root into exact file text.
 *
 * This function does not authenticate the root. Persisted consumers must use
 * the root verifier with the exact returned bytes and the runtime evidence key.
 *
 * @param value - Strict root value, normally returned by the root finalizer.
 * @returns Canonical compact JSON followed by exactly one LF.
 */
export function serializeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
  value: unknown,
): string {
  const root = readIntegrityAttestationRoot(value)
  return `${serializeCanonicalJson(root)}\n`
}

/**
 * Parses exact canonical root file bytes without claiming authentication.
 *
 * Duplicate keys, alternate JSON formatting, CRLF, trailing whitespace,
 * accessors, proxies, shared buffers, typed-array subclasses, and oversized
 * values fail closed. Use the persisted root verifier to mint authority.
 *
 * @param value - Exact canonical newline-terminated owner-only root bytes.
 * @returns Detached structurally strict root claims without an authority brand.
 */
export function parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootBytes(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot {
  return readExactIntegrityAttestationRootBytes(value).root
}

/**
 * Structurally parses the minimal root projection embedded in signed claims.
 *
 * This parser does not mint root authority. Permit issuance must obtain the
 * projection by consuming a genuine permit-purpose root authorization, while
 * permit verification authenticates it through the outer permit HMAC.
 *
 * @param value - Untrusted minimal durable root projection candidate.
 * @returns Detached structurally strict projection without an authority brand.
 */
export function parseWorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection {
  return readIntegrityAttestationRootProjection(value)
}

/**
 * Separates one freshly finalized root into purpose-specific one-shot tokens.
 *
 * @param value - Exact same-process root returned by the root finalizer.
 * @returns Distinct permit-only and inventory-only opaque authorizations.
 */
export function authorizeWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityRootAuthorizations {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return failIntegrityRateEvidence()
  const root = authenticatedIntegrityAttestationRoots.get(value)
  if (root === undefined) return failIntegrityRateEvidence()
  authenticatedIntegrityAttestationRoots.delete(value)
  return mintIntegrityAttestationRootAuthorizations(root)
}

/**
 * Reauthenticates one persisted root and mints fresh purpose-separated tokens.
 *
 * Exact root fields, HMAC, runtime-key digests, canonical private attestation,
 * and raw ordinal-zero segment are independently checked. The raw segment must
 * reproduce the exact six-measurement/six-integrity aggregate and interval.
 *
 * @param input - Persisted root, exact private bytes, raw segment, runtime key.
 * @returns Distinct permit-only and inventory-only opaque authorizations.
 */
export function verifyWorkspaceSearchMigrationRehearsalIntegrityAttestationRoot(
  input: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityRootAuthorizations {
  let rateKey: Uint8Array | undefined
  try {
    const record = requireRecord(input)
    requireExactKeys(record, [
      'canonicalSegmentBytes',
      'rateAuthenticationKey',
      'resourceAttestationBytes',
      'rootBytes',
    ])
    const canonicalSegmentBytes = copyBytes(
      readOwn(record, 'canonicalSegmentBytes'),
    )
    rateKey = copyAuthenticationKey(
      readOwn(record, 'rateAuthenticationKey'),
    )
    const attestationFile = readExactResourceAttestationBytes(
      readOwn(record, 'resourceAttestationBytes'),
    )
    const root = readExactIntegrityAttestationRootBytes(
      readOwn(record, 'rootBytes'),
    ).root
    verifyPersistedIntegrityAttestationRoot(
      root,
      canonicalSegmentBytes,
      attestationFile,
      rateKey,
    )
    return mintIntegrityAttestationRootAuthorizations(root)
  } catch {
    return failIntegrityRateEvidence()
  } finally {
    rateKey?.fill(0)
  }
}

/**
 * Consumes a genuine permit-purpose root token exactly once.
 *
 * Full owner-only root claims are compared with independently trusted permit
 * claims before the minimal durable projection leaves this boundary.
 *
 * @param input - One-shot token and exact trusted top-level permit claims.
 * @returns Minimal durable root projection for permit and manifest claims.
 */
export function consumeWorkspaceSearchMigrationRehearsalIntegrityRootPermitAuthorization(
  input: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection {
  const record = requireRecord(input)
  requireExactKeys(record, ['authorization', 'expected'])
  const root = consumeIntegrityAttestationRootAuthorization(
    readOwn(record, 'authorization'),
    integrityAttestationRootPermitAuthorizations,
  )
  const expected = readIntegrityRootPermitExpectedClaims(
    readOwn(record, 'expected'),
  )
  requireIntegrityRootPermitExpectedClaims(root, expected)
  return createIntegrityAttestationRootProjection(root)
}

/** Creates the minimal durable permit/manifest projection from one root. */
function createIntegrityAttestationRootProjection(
  root: WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection {
  return Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId: root.deploymentTargetId,
    productionAccountDigest: root.productionAccountDigest,
    configurationBindingDigest: root.configurationBindingDigest,
    policyVersion: root.policyVersion,
    attestation: Object.freeze({
      contentMac: root.attestation.contentMac,
      byteLength: root.attestation.byteLength,
    }),
    segment: root.segment,
    interval: root.interval,
    aggregate: root.aggregate,
    aggregateDigest: root.aggregateDigest,
    tableOrderBindingMac: root.tableOrderBindingMac,
    rootMac: root.rootMac,
    startedAt: root.startedAt,
    completedAt: root.completedAt,
  })
}

/**
 * Consumes a genuine stream-inventory-purpose root token exactly once.
 *
 * @param value - Exact inventory authorization minted by root authentication.
 * @returns Detached authenticated owner-only root claims.
 */
export function consumeWorkspaceSearchMigrationRehearsalIntegrityRootInventoryAuthorization(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot {
  return consumeIntegrityAttestationRootAuthorization(
    value,
    integrityAttestationRootInventoryAuthorizations,
  )
}

/** Mints two non-interchangeable one-shot tokens for one authenticated root. */
function mintIntegrityAttestationRootAuthorizations(
  root: WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
): WorkspaceSearchMigrationRehearsalIntegrityRootAuthorizations {
  const permit = Object.freeze({
    kind: integrityAttestationRootPermitAuthorizationKind,
    version: 1,
    rootMac: root.rootMac,
  })
  const inventory = Object.freeze({
    kind: integrityAttestationRootInventoryAuthorizationKind,
    version: 1,
    rootMac: root.rootMac,
  })
  integrityAttestationRootPermitAuthorizations.set(permit, root)
  integrityAttestationRootInventoryAuthorizations.set(inventory, root)
  return Object.freeze({ permit, inventory })
}

/** Consumes one exact capability from only its purpose-specific private map. */
function consumeIntegrityAttestationRootAuthorization(
  value: unknown,
  authorizations: WeakMap<
    object,
    WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot
  >,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return failIntegrityRateEvidence()
  const root = authorizations.get(value)
  if (root === undefined) return failIntegrityRateEvidence()
  authorizations.delete(value)
  return root
}

/** Consumes one genuine private rate binding exactly once. */
function consumePrivateIntegrityRateBinding(
  value: unknown,
): AuthenticatedPrivateIntegrityRateBindingState {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return failIntegrityRateEvidence()
  const state = authenticatedPrivateIntegrityRateBindings.get(value)
  if (state === undefined) return failIntegrityRateEvidence()
  authenticatedPrivateIntegrityRateBindings.delete(value)
  return state
}

/** Captures and validates one exact own-data-property verifier input. */
function readIntervalInput(
  value: unknown,
): IntegrityRateIntervalInputSnapshot {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'authenticationKey',
    'canonicalSegmentBytes',
    'expectedCompletedAt',
    'expectedConfigurationBindingDigest',
    'expectedPolicyVersion',
    'expectedStartedAt',
    'predecessorSegmentBytes',
    'sequence',
    'taskResult',
  ])
  const predecessorCandidate = readOwn(record, 'predecessorSegmentBytes')
  return Object.freeze({
    canonicalSegmentBytes: copyBytes(
      readOwn(record, 'canonicalSegmentBytes'),
    ),
    predecessorSegmentBytes: predecessorCandidate === null
      ? null
      : copyBytes(predecessorCandidate),
    authenticationKey: copyAuthenticationKey(
      readOwn(record, 'authenticationKey'),
    ),
    expectedPolicyVersion: readDigest(
      readOwn(record, 'expectedPolicyVersion'),
    ),
    expectedConfigurationBindingDigest: readDigest(
      readOwn(record, 'expectedConfigurationBindingDigest'),
    ),
    expectedStartedAt: readCanonicalTimestamp(
      readOwn(record, 'expectedStartedAt'),
    ),
    expectedCompletedAt: readCanonicalTimestamp(
      readOwn(record, 'expectedCompletedAt'),
    ),
    sequence: readOwn(record, 'sequence'),
    taskResult: readTaskResult(readOwn(record, 'taskResult')),
  })
}

/** Copies one exact non-proxy byte vector before authentication. */
function copyBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return failIntegrityRateEvidence()
  const buffer = integrityRateGuards.readIntrinsicBuffer(value)
  const byteLength = integrityRateGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength === 0 ||
    byteLength > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES
  ) return failIntegrityRateEvidence()
  const copied = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copied, [value])
  } catch {
    copied.fill(0)
    return failIntegrityRateEvidence()
  }
  return copied
}

/** Copies the exact derived runtime authentication key. */
function copyAuthenticationKey(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return failIntegrityRateEvidence()
  const buffer = integrityRateGuards.readIntrinsicBuffer(value)
  const byteLength = integrityRateGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_KEY_BYTES
  ) return failIntegrityRateEvidence()
  const copied = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copied, [value])
  } catch {
    copied.fill(0)
    return failIntegrityRateEvidence()
  }
  return copied
}

/** Copies one exact ordinary 32-byte key through intrinsic typed-array access. */
function copyFixedKey(value: unknown): Uint8Array {
  return copyAuthenticationKey(value)
}

/** Copies one exact bounded canonical #163 result without caller aliases. */
function copyResultBytes(value: unknown): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return failIntegrityRateEvidence()
  const buffer = integrityRateGuards.readIntrinsicBuffer(value)
  const byteLength = integrityRateGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength === 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RESULT_MAX_BYTES
  ) return failIntegrityRateEvidence()
  const copied = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copied, [value])
  } catch {
    copied.fill(0)
    return failIntegrityRateEvidence()
  }
  return copied
}

/** Copies and parses one exact canonical owner-only root file. */
function readExactIntegrityAttestationRootBytes(
  value: unknown,
): ExactIntegrityAttestationRootFile {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return failIntegrityRateEvidence()
  const buffer = integrityRateGuards.readIntrinsicBuffer(value)
  const byteLength = integrityRateGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength === 0 ||
    byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_ATTESTATION_ROOT_MAX_BYTES
  ) return failIntegrityRateEvidence()
  const bytes = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, bytes, [value])
  } catch {
    bytes.fill(0)
    return failIntegrityRateEvidence()
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    bytes.fill(0)
    return failIntegrityRateEvidence()
  }
  if (!text.endsWith('\n') || text.includes('\r')) {
    bytes.fill(0)
    return failIntegrityRateEvidence()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    bytes.fill(0)
    return failIntegrityRateEvidence()
  }
  const root = readIntegrityAttestationRoot(parsed)
  if (`${serializeCanonicalJson(root)}\n` !== text) {
    bytes.fill(0)
    return failIntegrityRateEvidence()
  }
  return Object.freeze({ bytes, root })
}

/** Copies and parses one exact canonical owner-only attestation file. */
function readExactResourceAttestationBytes(
  value: unknown,
): ExactResourceAttestationFile {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return failIntegrityRateEvidence()
  const buffer = integrityRateGuards.readIntrinsicBuffer(value)
  const byteLength = integrityRateGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength === 0 ||
    byteLength > CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES
  ) return failIntegrityRateEvidence()
  const bytes = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, bytes, [value])
  } catch {
    bytes.fill(0)
    return failIntegrityRateEvidence()
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    bytes.fill(0)
    return failIntegrityRateEvidence()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    bytes.fill(0)
    return failIntegrityRateEvidence()
  }
  const attestation = parseCrossDomainIntegrityResourceAttestation(parsed)
  if (serializeCrossDomainIntegrityResourceAttestation(attestation) !== text) {
    bytes.fill(0)
    return failIntegrityRateEvidence()
  }
  return Object.freeze({ bytes, attestation })
}

/** Reads one exact non-proxy object causally returned by the adapter task. */
function readTaskResult(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return failIntegrityRateEvidence()
  return value
}

/** Serializes only the exact causally returned #163 result object. */
function serializeTaskResultBytes(value: object): Uint8Array {
  let text: string
  try {
    text = `${JSON.stringify(value, undefined, 2)}\n`
  } catch {
    return failIntegrityRateEvidence()
  }
  return copyResultBytes(new TextEncoder().encode(text))
}

/** Zeroizes the transferred caller key through the intrinsic fill method. */
function zeroizeTransferredKey(value: unknown): void {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return failIntegrityRateEvidence()
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    return failIntegrityRateEvidence()
  }
}

/** Reads one non-proxy trusted clock callback. */
function readClock(value: unknown): () => Date {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failIntegrityRateEvidence()
  }
  return (): Date => {
    const result: unknown = Reflect.apply(value, undefined, [])
    if (!(result instanceof Date) || nodeUtilTypes.isProxy(result)) {
      return failIntegrityRateEvidence()
    }
    return result
  }
}

/** Creates one domain-separated HMAC over an already private projection. */
function createDomainMac(
  key: Uint8Array,
  domain: string,
  value: string,
): string {
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update(value, 'utf8')
    .digest('hex')
}

/** Creates one domain-separated HMAC over exact private canonical bytes. */
function createBytesMac(
  key: Uint8Array,
  domain: string,
  value: Uint8Array,
): string {
  return createHmac('sha256', key)
    .update(domain, 'utf8')
    .update(value)
    .digest('hex')
}

/** Reads one conventional lowercase SHA-256 digest. */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failIntegrityRateEvidence()
  return value
}

/** Strictly reads one trusted canonical timestamp. */
function readCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !isCanonicalTimestamp(value)) {
    return failIntegrityRateEvidence()
  }
  return value
}

/** Re-reads only fields already authenticated from the exact copied bytes. */
function readAuthenticatedSegmentProjection(
  canonicalSegmentBytes: Uint8Array,
): AuthenticatedRateSegmentProjection {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      canonicalSegmentBytes,
    )
  } catch {
    return failIntegrityRateEvidence()
  }
  if (!text.endsWith('\n') || text.includes('\r')) {
    return failIntegrityRateEvidence()
  }
  const lines = text.slice(0, -1).split('\n')
  if (
    lines.length < 2 ||
    lines.length - 1 > maximumIntegrityRateEvents
  ) return failIntegrityRateEvidence()
  const headerRecord = requireRecord(parseCanonicalLine(lines[0]))
  const header = Object.freeze({
    anchorUtc: readCanonicalTimestamp(readOwn(headerRecord, 'anchorUtc')),
  })
  const events: AuthenticatedRateEventProjection[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) return failIntegrityRateEvidence()
    events.push(readAuthenticatedEvent(parseCanonicalLine(line)))
  }
  return Object.freeze({ header, events: Object.freeze(events) })
}

/** Parses one exact canonical line already covered by segment authentication. */
function parseCanonicalLine(line: string | undefined): unknown {
  if (typeof line !== 'string' || line.length === 0) {
    return failIntegrityRateEvidence()
  }
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return failIntegrityRateEvidence()
  }
  if (serializeCanonicalJson(value) !== line) {
    return failIntegrityRateEvidence()
  }
  return value
}

/** Reads the minimal strict projection of one authenticated durable event. */
function readAuthenticatedEvent(
  value: unknown,
): AuthenticatedRateEventProjection {
  const record = requireRecord(value)
  const kind = readRateEventKind(readOwn(record, 'kind'))
  const eventSequence = readPositiveInteger(
    readOwn(record, 'eventSequence'),
  )
  const offsetMilliseconds = readNonNegativeInteger(
    readOwn(record, 'offsetMilliseconds'),
  )
  if (kind === 'reservation-forfeited') {
    return Object.freeze({ kind, eventSequence, offsetMilliseconds })
  }
  const phase = readPhase(readOwn(record, 'phase'))
  if (kind === 'budget-stop') {
    return Object.freeze({ kind, eventSequence, offsetMilliseconds, phase })
  }
  if (kind === 'cadence-wait') {
    return Object.freeze({
      kind,
      eventSequence,
      offsetMilliseconds,
      phase,
      delayMilliseconds: readPositiveInteger(
        readOwn(record, 'delayMilliseconds'),
      ),
    })
  }
  return Object.freeze({
    kind,
    eventSequence,
    offsetMilliseconds,
    phase,
    attemptSequence: readPositiveInteger(
      readOwn(record, 'attemptSequence'),
    ),
  })
}

/** Selects and validates the exact contiguous adapter-owned event interval. */
function selectIntegrityRateInterval(
  segment: AuthenticatedRateSegmentProjection,
  sequence: WorkspaceSearchMigrationRehearsalIntegrityRateSequence,
  expectedStartedAt: string,
  expectedCompletedAt: string,
): WorkspaceSearchMigrationRehearsalIntegrityRateInterval {
  const expectedCallCount = sequence.describeTableCallCount
  if (
    sequence.phase !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE ||
    (sequence.tablePassCount !== 1 && sequence.tablePassCount !== 2) ||
    expectedCallCount !== sequence.tablePassCount * 6 ||
    sequence.firstAttemptSequence < 1 ||
    sequence.lastAttemptSequence !==
      sequence.firstAttemptSequence + expectedCallCount - 1
  ) return failIntegrityRateEvidence()

  const firstChargedIndex = segment.events.findIndex((event) =>
    event.kind === 'attempt-charged' &&
    event.attemptSequence === sequence.firstAttemptSequence)
  if (firstChargedIndex < 0) return failIntegrityRateEvidence()
  let intervalStartIndex = firstChargedIndex
  while (intervalStartIndex > 0) {
    const preceding = segment.events[intervalStartIndex - 1]
    if (
      preceding?.kind !== 'cadence-wait' ||
      preceding.phase !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE
    ) break
    intervalStartIndex -= 1
  }
  const lastStartedIndex = segment.events.findIndex((event) =>
    event.kind === 'attempt-started' &&
    event.attemptSequence === sequence.lastAttemptSequence)
  if (lastStartedIndex < firstChargedIndex) return failIntegrityRateEvidence()
  const selected = segment.events.slice(intervalStartIndex, lastStartedIndex + 1)
  if (selected.length < expectedCallCount * 2) {
    return failIntegrityRateEvidence()
  }

  const attemptSequences: number[] = []
  const eventSequences: number[] = []
  let cadenceWaitCount = 0
  let cadenceWaitMilliseconds = 0
  let expectedAttemptSequence = sequence.firstAttemptSequence
  let pendingAttemptSequence: number | undefined
  let pendingAttemptOffsetMilliseconds: number | undefined
  let previousEventSequence: number | undefined
  for (const event of selected) {
    if (
      event.phase !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE ||
      (previousEventSequence !== undefined &&
        event.eventSequence !== previousEventSequence + 1)
    ) return failIntegrityRateEvidence()
    eventSequences.push(event.eventSequence)
    previousEventSequence = event.eventSequence
    switch (event.kind) {
      case 'cadence-wait':
        if (
          pendingAttemptSequence !== undefined ||
          expectedAttemptSequence > sequence.lastAttemptSequence ||
          event.delayMilliseconds === undefined
        ) return failIntegrityRateEvidence()
        cadenceWaitCount += 1
        cadenceWaitMilliseconds += event.delayMilliseconds
        if (!Number.isSafeInteger(cadenceWaitMilliseconds)) {
          return failIntegrityRateEvidence()
        }
        break
      case 'attempt-charged':
        if (
          pendingAttemptSequence !== undefined ||
          event.attemptSequence !== expectedAttemptSequence
        ) return failIntegrityRateEvidence()
        pendingAttemptSequence = expectedAttemptSequence
        pendingAttemptOffsetMilliseconds = event.offsetMilliseconds
        break
      case 'attempt-started':
        if (
          event.attemptSequence === undefined ||
          event.attemptSequence !== pendingAttemptSequence ||
          event.offsetMilliseconds !== pendingAttemptOffsetMilliseconds
        ) {
          return failIntegrityRateEvidence()
        }
        attemptSequences.push(event.attemptSequence)
        pendingAttemptSequence = undefined
        pendingAttemptOffsetMilliseconds = undefined
        expectedAttemptSequence += 1
        break
      default:
        return failIntegrityRateEvidence()
    }
  }
  if (
    pendingAttemptSequence !== undefined ||
    pendingAttemptOffsetMilliseconds !== undefined ||
    expectedAttemptSequence !== sequence.lastAttemptSequence + 1 ||
    attemptSequences.length !== expectedCallCount ||
    eventSequences.length !== selected.length
  ) return failIntegrityRateEvidence()

  const selectedEventSequences = new Set(eventSequences)
  for (const event of segment.events) {
    if (
      event.attemptSequence !== undefined &&
      event.attemptSequence >= sequence.firstAttemptSequence &&
      event.attemptSequence <= sequence.lastAttemptSequence &&
      (!selectedEventSequences.has(event.eventSequence) ||
        event.phase !==
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE ||
        (event.kind !== 'attempt-charged' &&
          event.kind !== 'attempt-started'))
    ) return failIntegrityRateEvidence()
  }

  const firstEvent = selected[0]
  const lastEvent = selected.at(-1)
  if (firstEvent === undefined || lastEvent === undefined) {
    return failIntegrityRateEvidence()
  }
  const anchorEpochMilliseconds = Date.parse(segment.header.anchorUtc)
  const startedAt = createEventTimestamp(
    anchorEpochMilliseconds,
    firstEvent.offsetMilliseconds,
  )
  const completedAt = createEventTimestamp(
    anchorEpochMilliseconds,
    lastEvent.offsetMilliseconds,
  )
  if (
    Date.parse(startedAt) < Date.parse(expectedStartedAt) ||
    Date.parse(completedAt) > Date.parse(expectedCompletedAt)
  ) return failIntegrityRateEvidence()

  return Object.freeze({
    kind: integrityRateIntervalKind,
    version:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION,
    phase: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE,
    tablePassCount: sequence.tablePassCount,
    describeTableCallCount: expectedCallCount,
    firstAttemptSequence: sequence.firstAttemptSequence,
    lastAttemptSequence: sequence.lastAttemptSequence,
    attemptSequences: Object.freeze(attemptSequences),
    firstEventSequence: firstEvent.eventSequence,
    lastEventSequence: lastEvent.eventSequence,
    eventSequences: Object.freeze(eventSequences),
    cadenceWaitCount,
    cadenceWaitMilliseconds,
    startedAt,
    completedAt,
  })
}

/** Safely adds an authenticated offset to its canonical UTC anchor. */
function createEventTimestamp(
  anchorEpochMilliseconds: number,
  offsetMilliseconds: number,
): string {
  const epochMilliseconds = anchorEpochMilliseconds + offsetMilliseconds
  if (!Number.isSafeInteger(epochMilliseconds)) {
    return failIntegrityRateEvidence()
  }
  return new Date(epochMilliseconds).toISOString()
}

/** Requires one plain own-data-property record. */
function requireRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    nodeUtilTypes.isProxy(value)
  ) return failIntegrityRateEvidence()
  return value
}

/** Requires exactly the supplied own string-key data properties. */
function requireExactKeys(
  record: object,
  expectedKeys: readonly string[],
): void {
  const actualKeys = Reflect.ownKeys(record)
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) =>
      typeof key !== 'string' || !expectedKeys.includes(key))
  ) return failIntegrityRateEvidence()
}

/** Reads one own data property without invoking accessors. */
function readOwn(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key)
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, 'value') ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) return failIntegrityRateEvidence()
  return descriptor.value
}

/** Reads one exact ordinary dense array without invoking element accessors. */
function readOrdinaryArray(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
): readonly unknown[] {
  if (
    nodeUtilTypes.isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype
  ) return failIntegrityRateEvidence()
  const length = readOwn(value, 'length')
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < minimumLength ||
    length > maximumLength
  ) return failIntegrityRateEvidence()
  const ownKeys = Reflect.ownKeys(value)
  if (
    ownKeys.length !== length + 1 ||
    ownKeys[length] !== 'length'
  ) return failIntegrityRateEvidence()
  const detached: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const key = String(index)
    if (ownKeys[index] !== key) return failIntegrityRateEvidence()
    detached.push(readOwn(value, key))
  }
  return Object.freeze(detached)
}

/** Strictly reads one canonical seven-entry keyed resource identity vector. */
function readIntegrityResourceIdentities(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationProjection[
  'resourceIdentities'
] {
  const identityValues = readOrdinaryArray(
    value,
    CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.length,
    CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.length,
  )
  const resourceIdentities: {
    readonly target: (typeof CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS)[number]
    readonly identityDigest: string
  }[] = []
  for (let index = 0; index < identityValues.length; index += 1) {
    const identity = requireRecord(identityValues[index])
    requireExactKeys(identity, ['identityDigest', 'target'])
    const expectedTarget = CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS[index]
    if (
      expectedTarget === undefined ||
      readOwn(identity, 'target') !== expectedTarget
    ) return failIntegrityRateEvidence()
    resourceIdentities.push(Object.freeze({
      target: expectedTarget,
      identityDigest: readDigest(readOwn(identity, 'identityDigest')),
    }))
  }
  return Object.freeze(resourceIdentities)
}

/** Strictly reads the public-safe seven-entry root attestation projection. */
function readIntegrityAttestationProjection(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationProjection {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'byteLength',
    'contentMac',
    'resourceIdentities',
    'resourceIdentityDigest',
    'resourceIdentityScheme',
  ])
  const resourceIdentities = readIntegrityResourceIdentities(
    readOwn(record, 'resourceIdentities'),
  )
  const byteLength = readPositiveInteger(readOwn(record, 'byteLength'))
  if (byteLength > CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES) {
    return failIntegrityRateEvidence()
  }
  if (
    readOwn(record, 'resourceIdentityScheme') !==
      'immutable-incarnation-v1'
  ) return failIntegrityRateEvidence()
  return Object.freeze({
    contentMac: readDigest(readOwn(record, 'contentMac')),
    byteLength,
    resourceIdentityScheme: 'immutable-incarnation-v1',
    resourceIdentities,
    resourceIdentityDigest: readDigest(
      readOwn(record, 'resourceIdentityDigest'),
    ),
  })
}

/** Strictly reads one persisted authenticated rate-segment summary. */
function readPersistedRateSegment(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const record = requireRecord(value)
  requireExactKeys(record, [
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
  const firstCommitted = readOwn(record, 'firstCommittedEventSequence')
  const lastCommitted = readOwn(record, 'lastCommittedEventSequence')
  return Object.freeze({
    authenticationKeyFingerprint: readDigest(
      readOwn(record, 'authenticationKeyFingerprint'),
    ),
    segmentLocatorDigest: readDigest(
      readOwn(record, 'segmentLocatorDigest'),
    ),
    segmentOrdinal: readNonNegativeInteger(
      readOwn(record, 'segmentOrdinal'),
    ),
    firstEventSequence: readPositiveInteger(
      readOwn(record, 'firstEventSequence'),
    ),
    eventCount: readNonNegativeInteger(readOwn(record, 'eventCount')),
    firstCommittedEventSequence: firstCommitted === null
      ? null
      : readPositiveInteger(firstCommitted),
    lastCommittedEventSequence: lastCommitted === null
      ? null
      : readPositiveInteger(lastCommitted),
    terminalRecordMac: readDigest(readOwn(record, 'terminalRecordMac')),
    segmentDigest: readDigest(readOwn(record, 'segmentDigest')),
  })
}

/** Strictly reads one persisted exact root integrity interval. */
function readPersistedIntegrityRateInterval(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityRateInterval {
  const record = requireRecord(value)
  requireExactKeys(record, [
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
    readOwn(record, 'kind') !== integrityRateIntervalKind ||
    readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION ||
    readOwn(record, 'phase') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE ||
    readOwn(record, 'tablePassCount') !== 1 ||
    readOwn(record, 'describeTableCallCount') !== 6
  ) return failIntegrityRateEvidence()
  const attemptValues = readOrdinaryArray(
    readOwn(record, 'attemptSequences'),
    6,
    6,
  )
  const attemptSequences = attemptValues.map(readPositiveInteger)
  const eventValues = readOrdinaryArray(
    readOwn(record, 'eventSequences'),
    12,
    maximumIntegrityRateEvents,
  )
  const eventSequences = eventValues.map(readPositiveInteger)
  const firstAttemptSequence = readPositiveInteger(
    readOwn(record, 'firstAttemptSequence'),
  )
  const lastAttemptSequence = readPositiveInteger(
    readOwn(record, 'lastAttemptSequence'),
  )
  const firstEventSequence = readPositiveInteger(
    readOwn(record, 'firstEventSequence'),
  )
  const lastEventSequence = readPositiveInteger(
    readOwn(record, 'lastEventSequence'),
  )
  const cadenceWaitCount = readNonNegativeInteger(
    readOwn(record, 'cadenceWaitCount'),
  )
  const cadenceWaitMilliseconds = readNonNegativeInteger(
    readOwn(record, 'cadenceWaitMilliseconds'),
  )
  const startedAt = readCanonicalTimestamp(readOwn(record, 'startedAt'))
  const completedAt = readCanonicalTimestamp(readOwn(record, 'completedAt'))
  if (
    firstAttemptSequence !== 7 ||
    lastAttemptSequence !== 12 ||
    attemptSequences.some((sequence, index) => sequence !== index + 7) ||
    eventSequences.length !== 12 + cadenceWaitCount ||
    eventSequences.some((sequence, index) =>
      index > 0 && sequence !== (eventSequences[index - 1] ?? 0) + 1) ||
    firstEventSequence !== eventSequences[0] ||
    lastEventSequence !== eventSequences.at(-1) ||
    (cadenceWaitCount === 0) !== (cadenceWaitMilliseconds === 0) ||
    Date.parse(startedAt) > Date.parse(completedAt)
  ) return failIntegrityRateEvidence()
  return Object.freeze({
    kind: integrityRateIntervalKind,
    version:
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_INTERVAL_VERSION,
    phase: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE,
    tablePassCount: 1,
    describeTableCallCount: 6,
    firstAttemptSequence,
    lastAttemptSequence,
    attemptSequences: Object.freeze(attemptSequences),
    firstEventSequence,
    lastEventSequence,
    eventSequences: Object.freeze(eventSequences),
    cadenceWaitCount,
    cadenceWaitMilliseconds,
    startedAt,
    completedAt,
  })
}

/** Strictly detaches every canonical persisted owner-only root field. */
function readIntegrityAttestationRoot(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'account',
    'aggregate',
    'aggregateDigest',
    'attestation',
    'callerArn',
    'commit',
    'completedAt',
    'configurationBindingDigest',
    'deploymentTargetId',
    'deploymentTrustRootDigest',
    'evidenceKeyDigest',
    'interval',
    'kind',
    'policyVersion',
    'predecessor',
    'productionAccountDigest',
    'publicationKeyDigest',
    'region',
    'requestedResourcesBinding',
    'rootMac',
    'segment',
    'startedAt',
    'tableOrderBindingMac',
    'version',
  ])
  if (
    readOwn(record, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root' ||
    readOwn(record, 'version') !== 1 ||
    readOwn(record, 'predecessor') !== null
  ) return failIntegrityRateEvidence()
  const account = readAwsAccount(readOwn(record, 'account'))
  const aggregate = readDurableRateEvidence(readOwn(record, 'aggregate'))
  const startedAt = readCanonicalTimestamp(readOwn(record, 'startedAt'))
  const completedAt = readCanonicalTimestamp(readOwn(record, 'completedAt'))
  const evidenceKeyDigest = readDigest(
    readOwn(record, 'evidenceKeyDigest'),
  )
  const publicationKeyDigest = readDigest(
    readOwn(record, 'publicationKeyDigest'),
  )
  if (
    Date.parse(startedAt) > Date.parse(completedAt) ||
    createMigrationDigest(aggregate) !==
      readOwn(record, 'aggregateDigest') ||
    evidenceKeyDigest === publicationKeyDigest
  ) return failIntegrityRateEvidence()
  return Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root',
    version: 1,
    deploymentTargetId: readDeploymentTargetId(
      readOwn(record, 'deploymentTargetId'),
    ),
    deploymentTrustRootDigest: readDigest(
      readOwn(record, 'deploymentTrustRootDigest'),
    ),
    productionAccountDigest: readDigest(
      readOwn(record, 'productionAccountDigest'),
    ),
    account,
    region: readAwsRegion(readOwn(record, 'region')),
    callerArn: readCallerArn(readOwn(record, 'callerArn'), account),
    commit: readCommit(readOwn(record, 'commit')),
    requestedResourcesBinding: readDigest(
      readOwn(record, 'requestedResourcesBinding'),
    ),
    configurationBindingDigest: readDigest(
      readOwn(record, 'configurationBindingDigest'),
    ),
    policyVersion: readDigest(readOwn(record, 'policyVersion')),
    evidenceKeyDigest,
    publicationKeyDigest,
    attestation: readIntegrityAttestationProjection(
      readOwn(record, 'attestation'),
    ),
    predecessor: null,
    segment: readPersistedRateSegment(readOwn(record, 'segment')),
    interval: readPersistedIntegrityRateInterval(
      readOwn(record, 'interval'),
    ),
    aggregate,
    aggregateDigest: readDigest(readOwn(record, 'aggregateDigest')),
    startedAt,
    completedAt,
    tableOrderBindingMac: readDigest(
      readOwn(record, 'tableOrderBindingMac'),
    ),
    rootMac: readDigest(readOwn(record, 'rootMac')),
  })
}

/** Strictly detaches the minimal root projection embedded in signed claims. */
function readIntegrityAttestationRootProjection(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityAttestationRootProjection {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'aggregate',
    'aggregateDigest',
    'attestation',
    'completedAt',
    'configurationBindingDigest',
    'deploymentTargetId',
    'interval',
    'kind',
    'policyVersion',
    'productionAccountDigest',
    'rootMac',
    'segment',
    'startedAt',
    'tableOrderBindingMac',
    'version',
  ])
  if (
    readOwn(record, 'kind') !==
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection' ||
    readOwn(record, 'version') !== 1
  ) return failIntegrityRateEvidence()
  const attestationRecord = requireRecord(readOwn(record, 'attestation'))
  requireExactKeys(attestationRecord, ['byteLength', 'contentMac'])
  const attestationByteLength = readPositiveInteger(
    readOwn(attestationRecord, 'byteLength'),
  )
  if (
    attestationByteLength >
      CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES
  ) return failIntegrityRateEvidence()
  const policyVersion = readDigest(readOwn(record, 'policyVersion'))
  const segment = readPersistedRateSegment(readOwn(record, 'segment'))
  const interval = readPersistedIntegrityRateInterval(
    readOwn(record, 'interval'),
  )
  const aggregate = readDurableRateEvidence(readOwn(record, 'aggregate'))
  const aggregateDigest = readDigest(readOwn(record, 'aggregateDigest'))
  const startedAt = readCanonicalTimestamp(readOwn(record, 'startedAt'))
  const completedAt = readCanonicalTimestamp(readOwn(record, 'completedAt'))
  if (
    segment.segmentOrdinal !== 0 ||
    segment.firstEventSequence !== 1 ||
    aggregate.policyVersion !== policyVersion ||
    aggregate.attemptCount !== 12 ||
    aggregate.forfeitedAttemptCount !== 0 ||
    aggregate.throttleCount !== 0 ||
    aggregate.budgetStopCount !== 0 ||
    aggregate.maximumInFlight !== 1 ||
    createMigrationDigest(aggregate) !== aggregateDigest ||
    Date.parse(startedAt) > Date.parse(interval.startedAt) ||
    Date.parse(interval.completedAt) > Date.parse(completedAt) ||
    Date.parse(startedAt) > Date.parse(completedAt)
  ) return failIntegrityRateEvidence()
  return Object.freeze({
    kind:
      'mukuroji-workspace-search-migration-rehearsal-integrity-attestation-root-projection',
    version: 1,
    deploymentTargetId: readDeploymentTargetId(
      readOwn(record, 'deploymentTargetId'),
    ),
    productionAccountDigest: readDigest(
      readOwn(record, 'productionAccountDigest'),
    ),
    configurationBindingDigest: readDigest(
      readOwn(record, 'configurationBindingDigest'),
    ),
    policyVersion,
    attestation: Object.freeze({
      contentMac: readDigest(readOwn(attestationRecord, 'contentMac')),
      byteLength: attestationByteLength,
    }),
    segment,
    interval,
    aggregate,
    aggregateDigest,
    tableOrderBindingMac: readDigest(
      readOwn(record, 'tableOrderBindingMac'),
    ),
    rootMac: readDigest(readOwn(record, 'rootMac')),
    startedAt,
    completedAt,
  })
}

/** Strictly reads trusted top-level permit claims for full-root comparison. */
function readIntegrityRootPermitExpectedClaims(
  value: unknown,
): WorkspaceSearchMigrationRehearsalIntegrityRootPermitExpectedClaims {
  const record = requireRecord(value)
  requireExactKeys(record, [
    'account',
    'callerArn',
    'commit',
    'configurationBindingDigest',
    'deploymentTargetId',
    'deploymentTrustRootDigest',
    'evidenceKeyDigest',
    'issuedAt',
    'policyVersion',
    'productionAccountDigest',
    'publicationKeyDigest',
    'region',
    'requestedResourcesBinding',
    'resourceIdentities',
    'resourceIdentityDigest',
    'resourceIdentityScheme',
  ])
  const account = readAwsAccount(readOwn(record, 'account'))
  if (
    readOwn(record, 'resourceIdentityScheme') !==
      'immutable-incarnation-v1'
  ) return failIntegrityRateEvidence()
  return Object.freeze({
    deploymentTargetId: readDeploymentTargetId(
      readOwn(record, 'deploymentTargetId'),
    ),
    deploymentTrustRootDigest: readDigest(
      readOwn(record, 'deploymentTrustRootDigest'),
    ),
    productionAccountDigest: readDigest(
      readOwn(record, 'productionAccountDigest'),
    ),
    account,
    region: readAwsRegion(readOwn(record, 'region')),
    callerArn: readCallerArn(readOwn(record, 'callerArn'), account),
    commit: readCommit(readOwn(record, 'commit')),
    requestedResourcesBinding: readDigest(
      readOwn(record, 'requestedResourcesBinding'),
    ),
    configurationBindingDigest: readDigest(
      readOwn(record, 'configurationBindingDigest'),
    ),
    policyVersion: readDigest(readOwn(record, 'policyVersion')),
    evidenceKeyDigest: readDigest(readOwn(record, 'evidenceKeyDigest')),
    publicationKeyDigest: readDigest(
      readOwn(record, 'publicationKeyDigest'),
    ),
    resourceIdentityScheme: 'immutable-incarnation-v1',
    resourceIdentities: readIntegrityResourceIdentities(
      readOwn(record, 'resourceIdentities'),
    ),
    resourceIdentityDigest: readDigest(
      readOwn(record, 'resourceIdentityDigest'),
    ),
    issuedAt: readCanonicalTimestamp(readOwn(record, 'issuedAt')),
  })
}

/** Requires independently trusted permit claims to equal the private root. */
function requireIntegrityRootPermitExpectedClaims(
  root: WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  expected: WorkspaceSearchMigrationRehearsalIntegrityRootPermitExpectedClaims,
): void {
  const actualClaims = Object.freeze({
    deploymentTargetId: root.deploymentTargetId,
    deploymentTrustRootDigest: root.deploymentTrustRootDigest,
    productionAccountDigest: root.productionAccountDigest,
    account: root.account,
    region: root.region,
    callerArn: root.callerArn,
    commit: root.commit,
    requestedResourcesBinding: root.requestedResourcesBinding,
    configurationBindingDigest: root.configurationBindingDigest,
    policyVersion: root.policyVersion,
    evidenceKeyDigest: root.evidenceKeyDigest,
    publicationKeyDigest: root.publicationKeyDigest,
    resourceIdentityScheme: root.attestation.resourceIdentityScheme,
    resourceIdentities: root.attestation.resourceIdentities,
    resourceIdentityDigest: root.attestation.resourceIdentityDigest,
  })
  const expectedClaims = Object.freeze({
    deploymentTargetId: expected.deploymentTargetId,
    deploymentTrustRootDigest: expected.deploymentTrustRootDigest,
    productionAccountDigest: expected.productionAccountDigest,
    account: expected.account,
    region: expected.region,
    callerArn: expected.callerArn,
    commit: expected.commit,
    requestedResourcesBinding: expected.requestedResourcesBinding,
    configurationBindingDigest: expected.configurationBindingDigest,
    policyVersion: expected.policyVersion,
    evidenceKeyDigest: expected.evidenceKeyDigest,
    publicationKeyDigest: expected.publicationKeyDigest,
    resourceIdentityScheme: expected.resourceIdentityScheme,
    resourceIdentities: expected.resourceIdentities,
    resourceIdentityDigest: expected.resourceIdentityDigest,
  })
  if (
    serializeCanonicalJson(actualClaims) !==
      serializeCanonicalJson(expectedClaims) ||
    Date.parse(root.completedAt) > Date.parse(expected.issuedAt)
  ) return failIntegrityRateEvidence()
}

/** Reconstructs the exact root-MAC payload without its MAC field. */
function createIntegrityAttestationRootMacClaims(
  root: WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
): object {
  return Object.freeze({
    kind: root.kind,
    version: root.version,
    deploymentTargetId: root.deploymentTargetId,
    deploymentTrustRootDigest: root.deploymentTrustRootDigest,
    productionAccountDigest: root.productionAccountDigest,
    account: root.account,
    region: root.region,
    callerArn: root.callerArn,
    commit: root.commit,
    requestedResourcesBinding: root.requestedResourcesBinding,
    configurationBindingDigest: root.configurationBindingDigest,
    policyVersion: root.policyVersion,
    evidenceKeyDigest: root.evidenceKeyDigest,
    publicationKeyDigest: root.publicationKeyDigest,
    attestation: root.attestation,
    predecessor: root.predecessor,
    segment: root.segment,
    interval: root.interval,
    aggregate: root.aggregate,
    aggregateDigest: root.aggregateDigest,
    startedAt: root.startedAt,
    completedAt: root.completedAt,
    tableOrderBindingMac: root.tableOrderBindingMac,
  })
}

/** Reauthenticates every persisted root binding against its separate bytes. */
function verifyPersistedIntegrityAttestationRoot(
  root: WorkspaceSearchMigrationRehearsalIntegrityAttestationRoot,
  canonicalSegmentBytes: Uint8Array,
  attestationFile: ExactResourceAttestationFile,
  rateKey: Uint8Array,
): void {
  const attestation = attestationFile.attestation
  const tableOrderBindingDigest = createMigrationDigest(
    attestation.tables.map((table) => ({
      target: table.target,
      tableName: table.tableName,
    })),
  )
  if (
    createHash('sha256').update(rateKey).digest('hex') !==
      root.evidenceKeyDigest ||
    createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
      rateKey,
    ) !== root.segment.authenticationKeyFingerprint ||
    attestation.account !== root.account ||
    attestation.region !== root.region ||
    attestationFile.bytes.byteLength !== root.attestation.byteLength ||
    attestation.scheme !== root.attestation.resourceIdentityScheme ||
    !sameDigest(
      createBytesMac(
        rateKey,
        rootAttestationContentMacDomain,
        attestationFile.bytes,
      ),
      root.attestation.contentMac,
    ) ||
    !sameDigest(
      createDomainMac(
        rateKey,
        tableOrderBindingMacDomain,
        tableOrderBindingDigest,
      ),
      root.tableOrderBindingMac,
    ) ||
    !sameDigest(
      createDomainMac(
        rateKey,
        integrityAttestationRootMacDomain,
        serializeCanonicalJson(createIntegrityAttestationRootMacClaims(root)),
      ),
      root.rootMac,
    )
  ) return failIntegrityRateEvidence()
  const authenticatedSegment =
    verifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessor({
      canonicalBytes: canonicalSegmentBytes,
      authenticationKey: rateKey,
      expectedPreviousSegment: null,
      expectedPolicyVersion: root.policyVersion,
      expectedConfigurationBindingDigest:
        root.configurationBindingDigest,
    })
  if (
    serializeCanonicalJson(authenticatedSegment) !==
      serializeCanonicalJson(root.segment)
  ) return failIntegrityRateEvidence()
  const rawProjection = readAuthenticatedSegmentProjection(
    canonicalSegmentBytes,
  )
  const expectedSequence:
    WorkspaceSearchMigrationRehearsalIntegrityRateSequence = Object.freeze({
      kind:
        'mukuroji-workspace-search-migration-rehearsal-integrity-rate-sequence',
      version: 1,
      phase: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE,
      tablePassCount: 1,
      describeTableCallCount: 6,
      firstAttemptSequence: 7,
      lastAttemptSequence: 12,
      tableOrderBindingDigest,
    })
  const interval = selectIntegrityRateInterval(
    rawProjection,
    expectedSequence,
    root.startedAt,
    root.completedAt,
  )
  if (
    serializeCanonicalJson(interval) !==
      serializeCanonicalJson(root.interval)
  ) return failIntegrityRateEvidence()
  const aggregate = calculateRootRateAggregate(
    rawProjection,
    root.policyVersion,
    interval,
    root.startedAt,
    root.completedAt,
  )
  if (
    serializeCanonicalJson(aggregate) !==
      serializeCanonicalJson(root.aggregate) ||
    createMigrationDigest(aggregate) !== root.aggregateDigest
  ) return failIntegrityRateEvidence()
}

/** Compares two fixed lowercase digests without content-dependent timing. */
function sameDigest(left: string, right: string): boolean {
  const encoder = new TextEncoder()
  return timingSafeEqual(encoder.encode(left), encoder.encode(right))
}

/** Recalculates the complete clean ordinal-zero aggregate from raw events. */
function calculateRootRateAggregate(
  segment: AuthenticatedRateSegmentProjection,
  policyVersion: string,
  interval: WorkspaceSearchMigrationRehearsalIntegrityRateInterval,
  operationStartedAt: string,
  operationCompletedAt: string,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  const selectedIntegrityEvents = new Set(interval.eventSequences)
  let attemptCount = 0
  let cadenceWaitCount = 0
  let cadenceWaitMilliseconds = 0
  let expectedAttemptSequence = 1
  let pendingAttemptSequence: number | undefined
  let pendingAttemptOffsetMilliseconds: number | undefined
  let pendingAttemptPhase: WorkspaceSearchMigrationDescribeTablePhase |
    undefined
  let measurementAttemptCount = 0
  let integrityAttemptCount = 0
  let observedIntegrityEventCount = 0
  const anchorEpochMilliseconds = Date.parse(segment.header.anchorUtc)
  if (
    interval.firstAttemptSequence !== 7 ||
    interval.lastAttemptSequence !== 12 ||
    interval.attemptSequences.length !== 6 ||
    interval.attemptSequences.some((sequence, index) => sequence !== index + 7)
  ) return failIntegrityRateEvidence()
  for (const event of segment.events) {
    const eventTimestamp = createEventTimestamp(
      anchorEpochMilliseconds,
      event.offsetMilliseconds,
    )
    if (
      Date.parse(eventTimestamp) < Date.parse(operationStartedAt) ||
      Date.parse(eventTimestamp) > Date.parse(operationCompletedAt) ||
      (event.phase ===
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE &&
        !selectedIntegrityEvents.has(event.eventSequence))
    ) return failIntegrityRateEvidence()
    if (
      event.phase ===
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE
    ) observedIntegrityEventCount += 1
    const expectedPhase: WorkspaceSearchMigrationDescribeTablePhase =
      expectedAttemptSequence <= 6
        ? 'measurement'
        : WORKSPACE_SEARCH_MIGRATION_REHEARSAL_INTEGRITY_RATE_PHASE
    switch (event.kind) {
      case 'cadence-wait':
        if (
          pendingAttemptSequence !== undefined ||
          event.delayMilliseconds === undefined ||
          event.phase !== expectedPhase
        ) return failIntegrityRateEvidence()
        cadenceWaitCount += 1
        cadenceWaitMilliseconds += event.delayMilliseconds
        if (
          !Number.isSafeInteger(cadenceWaitCount) ||
          !Number.isSafeInteger(cadenceWaitMilliseconds)
        ) return failIntegrityRateEvidence()
        break
      case 'attempt-charged':
        if (
          pendingAttemptSequence !== undefined ||
          event.attemptSequence !== expectedAttemptSequence ||
          event.phase !== expectedPhase
        ) return failIntegrityRateEvidence()
        pendingAttemptSequence = expectedAttemptSequence
        pendingAttemptOffsetMilliseconds = event.offsetMilliseconds
        pendingAttemptPhase = expectedPhase
        attemptCount += 1
        if (expectedPhase === 'measurement') {
          measurementAttemptCount += 1
        } else {
          integrityAttemptCount += 1
        }
        expectedAttemptSequence += 1
        break
      case 'attempt-started':
        if (
          event.attemptSequence === undefined ||
          event.attemptSequence !== pendingAttemptSequence ||
          event.offsetMilliseconds !== pendingAttemptOffsetMilliseconds ||
          event.phase !== pendingAttemptPhase
        ) return failIntegrityRateEvidence()
        pendingAttemptSequence = undefined
        pendingAttemptOffsetMilliseconds = undefined
        pendingAttemptPhase = undefined
        break
      default:
        return failIntegrityRateEvidence()
    }
  }
  if (
    attemptCount !== 12 ||
    expectedAttemptSequence !== 13 ||
    measurementAttemptCount !== 6 ||
    integrityAttemptCount !== 6 ||
    pendingAttemptSequence !== undefined ||
    pendingAttemptOffsetMilliseconds !== undefined ||
    pendingAttemptPhase !== undefined ||
    selectedIntegrityEvents.size !== interval.eventSequences.length ||
    observedIntegrityEventCount !== selectedIntegrityEvents.size
  ) return failIntegrityRateEvidence()
  return Object.freeze({
    version:
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion,
    attemptCount,
    forfeitedAttemptCount: 0,
    throttleCount: 0,
    budgetStopCount: 0,
    cadenceWaitCount,
    cadenceWaitMilliseconds,
    maximumInFlight: 1,
  })
}

/** Strictly matches the independently read durable root aggregate. */
function readMatchingDurableEvidence(
  value: unknown,
  expected: WorkspaceSearchMigrationDescribeTableRateEvidence,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  const durable = readDurableRateEvidence(value)
  if (serializeCanonicalJson(durable) !== serializeCanonicalJson(expected)) {
    return failIntegrityRateEvidence()
  }
  return durable
}

/** Strictly reads one detached complete durable rate aggregate. */
function readDurableRateEvidence(
  value: unknown,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  const record = requireRecord(value)
  requireExactKeys(record, [
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
  const durable = Object.freeze({
    version: readOne(readOwn(record, 'version')),
    policyVersion: readDigest(readOwn(record, 'policyVersion')),
    attemptCount: readPositiveInteger(readOwn(record, 'attemptCount')),
    forfeitedAttemptCount: readNonNegativeInteger(
      readOwn(record, 'forfeitedAttemptCount'),
    ),
    throttleCount: readNonNegativeInteger(
      readOwn(record, 'throttleCount'),
    ),
    budgetStopCount: readNonNegativeInteger(
      readOwn(record, 'budgetStopCount'),
    ),
    cadenceWaitCount: readNonNegativeInteger(
      readOwn(record, 'cadenceWaitCount'),
    ),
    cadenceWaitMilliseconds: readNonNegativeInteger(
      readOwn(record, 'cadenceWaitMilliseconds'),
    ),
    maximumInFlight: readOne(readOwn(record, 'maximumInFlight')),
  })
  return durable
}

/** Reads the exact current contract version or one-valued maximum in-flight. */
function readOne(value: unknown): 1 {
  if (value !== 1) return failIntegrityRateEvidence()
  return 1
}

/**
 * Reads the exact identity fields from an already consumed measurement result.
 *
 * @param value - Exact configuration object accepted by the causal consumer.
 * @returns Detached root identity fields for equality checks.
 */
function readRootMeasuredConfigurationIdentity(
  value: unknown,
): RootMeasuredConfigurationIdentity {
  const record = requireRecord(value)
  const account = readAwsAccount(readOwn(record, 'account'))
  return Object.freeze({
    account,
    region: readAwsRegion(readOwn(record, 'region')),
    callerArn: readCallerArn(readOwn(record, 'callerArn'), account),
    commit: readCommit(readOwn(record, 'commit')),
  })
}

/**
 * Reconstructs the operator-selected resource binding from one measurement.
 *
 * @param value - Exact configuration accepted by the causal measurement cap.
 * @returns Digest of its account, Region, profile, commit, and resources.
 */
function createRootMeasuredRequestedResourcesBinding(
  value: unknown,
): string {
  const record = requireRecord(value)
  const tables = requireRecord(readOwn(record, 'tables'))
  const journal = requireRecord(readOwn(record, 'journal'))
  return createWorkspaceSearchMigrationRequestedResourcesBinding({
    account: readAwsAccount(readOwn(record, 'account')),
    region: readAwsRegion(readOwn(record, 'region')),
    profile: readString(readOwn(record, 'profile')),
    commit: readCommit(readOwn(record, 'commit')),
    tables: {
      'project-directory': readRootMeasuredTableName(
        tables,
        'project-directory',
      ),
      'work-items': readRootMeasuredTableName(tables, 'work-items'),
      collaboration: readRootMeasuredTableName(tables, 'collaboration'),
      documents: readRootMeasuredTableName(tables, 'documents'),
      'workspace-search': readRootMeasuredTableName(
        tables,
        'workspace-search',
      ),
      'migration-state': readRootMeasuredTableName(
        tables,
        'migration-state',
      ),
    },
    journalBucket: readString(readOwn(journal, 'bucketName')),
    journalKeyArn: readString(readOwn(journal, 'keyArn')),
  })
}

/**
 * Reads one physical table name from a measured table identity.
 *
 * @param tables - Exact measured six-role table map.
 * @param role - Logical migration table role to read.
 * @returns Physical DynamoDB table name bound by the root.
 */
function readRootMeasuredTableName(
  tables: object,
  role: WorkspaceSearchMigrationTableRole,
): string {
  const table = requireRecord(readOwn(tables, role))
  return readString(readOwn(table, 'tableName'))
}

/** Reads one primitive string without coercion. */
function readString(value: unknown): string {
  if (typeof value !== 'string') return failIntegrityRateEvidence()
  return value
}

/** Reads one source-controlled deployment target identifier. */
function readDeploymentTargetId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z][a-z0-9-]{0,62}$/u.test(value)
  ) return failIntegrityRateEvidence()
  return value
}

/** Reads one exact concrete twelve-digit AWS account. */
function readAwsAccount(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d{12}$/u.test(value) ||
    value === '000000000000'
  ) return failIntegrityRateEvidence()
  return value
}

/** Reads one conservative explicit AWS Region. */
function readAwsRegion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[1-9][0-9]*$/u.test(value)
  ) return failIntegrityRateEvidence()
  return value
}

/** Reads one exact STS assumed-role caller in the selected account. */
function readCallerArn(value: unknown, account: string): string {
  if (typeof value !== 'string') return failIntegrityRateEvidence()
  const match = /^arn:(?:aws|aws-us-gov|aws-cn):sts::(\d{12}):assumed-role\/[A-Za-z0-9+=,.@_-]{1,64}\/[A-Za-z0-9+=,.@_-]{1,64}$/u.exec(
    value,
  )
  if (match?.[1] !== account) return failIntegrityRateEvidence()
  return value
}

/** Reads one exact lowercase Git commit OID. */
function readCommit(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/u.test(value)) {
    return failIntegrityRateEvidence()
  }
  return value
}

/** Reads one exact supported authenticated event label. */
function readRateEventKind(value: unknown): AuthenticatedRateEventKind {
  switch (value) {
    case 'attempt-charged':
    case 'attempt-forfeited':
    case 'attempt-started':
    case 'attempt-throttled':
    case 'budget-stop':
    case 'cadence-wait':
    case 'reservation-forfeited':
      return value
    default:
      return failIntegrityRateEvidence()
  }
}

/** Reads one exact supported identifier-free rate phase. */
function readPhase(value: unknown): WorkspaceSearchMigrationDescribeTablePhase {
  switch (value) {
    case 'measurement':
    case 'checkpoint-page':
    case 'integrity-check':
    case 'post-send-guard':
    case 'pre-send-guard':
    case 'reconciliation':
      return value
    default:
      return failIntegrityRateEvidence()
  }
}

/** Reads one positive bounded safe integer. */
function readPositiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1) {
    return failIntegrityRateEvidence()
  }
  return value
}

/** Reads one non-negative bounded safe integer. */
function readNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0) {
    return failIntegrityRateEvidence()
  }
  return value
}

/** Throws the stable raw-value-free integrity-rate evidence failure. */
function failIntegrityRateEvidence(): never {
  throw new WorkspaceSearchMigrationRehearsalIntegrityRateEvidenceError()
}
