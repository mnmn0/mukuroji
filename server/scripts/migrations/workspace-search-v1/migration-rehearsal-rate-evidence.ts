import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  serializeCanonicalJson,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationDescribeTablePhase,
  WorkspaceSearchMigrationDescribeTableBudgetStopProvenance,
  WorkspaceSearchMigrationDescribeTableRateEvidence,
  WorkspaceSearchMigrationDescribeTableRateObservation,
  WorkspaceSearchMigrationDescribeTableRateRecorder,
  WorkspaceSearchMigrationDescribeTableRateStopReason,
  WorkspaceSearchMigrationDescribeTableThrottleProvenance,
} from './migration-describe-table-rate-budget'
import {
  WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
} from './migration-describe-table-rate-budget'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Version of the authenticated rehearsal rate-segment contract. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION = 2

/** Exact HMAC key length accepted by the rate evidence stream. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_KEY_BYTES = 32

/** Maximum number of immutable process segments in one rehearsal stream. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENTS = 256

/** Maximum number of durable events in one complete rehearsal stream. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_EVENTS = 100_000

/** Maximum exact bytes accepted for one append-only process segment. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES =
  4 * 1_024 * 1_024

/** Maximum exact bytes accepted across all process segments. */
export const WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_TOTAL_BYTES =
  16 * 1_024 * 1_024

/** Maximum canonical bytes accepted for one header or event record. */
const maximumRateRecordBytes = 4 * 1_024

/** Maximum monotonic duration represented by one process segment. */
const maximumSegmentOffsetMilliseconds = 24 * 60 * 60 * 1_000

/** Maximum identifier-free count accepted in one rate field. */
const maximumRateCount = 10_000_000

/** Domain separating rate-record HMACs from all other migration artifacts. */
const rateRecordMacDomain =
  'mukuroji:workspace-search-migration:rehearsal-rate-record:v2'

/** Domain separating the secret-free rate authentication-key fingerprint. */
const rateAuthenticationKeyFingerprintDomain =
  'mukuroji:workspace-search-migration:rehearsal-rate-authentication-key-fingerprint:v2'

/** Stable public failure used for malformed or inconsistent evidence. */
const invalidRateEvidenceMessage = 'Invalid migration rehearsal rate evidence.'

/** Stable public failure used when a durable append is not confirmed. */
const durableAppendFailureMessage =
  'Migration rehearsal rate evidence append was not confirmed.'

/** Canonical stream artifact label. */
const rateArtifactKind =
  'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-stream'

/** Canonical process-segment header label. */
const rateSegmentHeaderKind =
  'mukuroji-workspace-search-migration-rehearsal-describe-table-rate-segment'

/** Actual identifier-free DescribeTable rate aggregate. */
export type WorkspaceSearchMigrationRehearsalRateAggregate = {
  /** Secret-free rate observation contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
  /** Digest of the reviewed rate-policy document. */
  readonly policyVersion: string
  /** Conservatively charged physical attempts. */
  readonly attemptCount: number
  /** Charged permits forfeited while recovering interrupted pages. */
  readonly forfeitedAttemptCount: number
  /** Total attempts classified as throttled from every explicit provenance. */
  readonly throttleCount: number
  /** Throttles returned by the genuine AWS service. */
  readonly awsServiceThrottleCount: number
  /** Deterministic throttles injected only after one physical AWS success. */
  readonly rehearsalInjectedThrottleCount: number
  /** Total fail-closed admission stops from every explicit provenance. */
  readonly budgetStopCount: number
  /** Admission stops unrelated to a classified throttle. */
  readonly operationalBudgetStopCount: number
  /** Admission stops caused by genuine AWS-service throttles. */
  readonly awsServiceThrottleBudgetStopCount: number
  /** Admission stops caused by deterministic post-success injection. */
  readonly rehearsalInjectedBudgetStopCount: number
  /** Admission cadence waits before external I/O. */
  readonly cadenceWaitCount: number
  /** Total requested cadence delay in milliseconds. */
  readonly cadenceWaitMilliseconds: number
  /** Maximum charged in-flight attempt count. */
  readonly maximumInFlight: 1
}

/** Actual rate observations and their immutable aggregate binding. */
export type WorkspaceSearchMigrationRehearsalRateEvidence = {
  /** Exact identifier-free runtime rate aggregate. */
  readonly aggregate: WorkspaceSearchMigrationRehearsalRateAggregate
  /** Deterministic digest computed from the exact aggregate. */
  readonly aggregateDigest: string
  /** Digest of the canonical monotonic observation stream artifact. */
  readonly observationStreamDigest: string
  /** Exact number of observations in the immutable stream. */
  readonly observationCount: number
  /**
   * Actual maximum physical AWS request-start rate per second.
   *
   * This is calculated only from authenticated `attempt-started` events and
   * therefore includes a successful request later classified by the
   * deterministic post-success throttle exercise.
   */
  readonly observedMaximumRatePerSecond: number
}

/** Exact event kinds persisted by the fail-closed rehearsal recorder. */
export type WorkspaceSearchMigrationRehearsalRateEventKind =
  | 'attempt-charged'
  | 'attempt-forfeited'
  | 'attempt-started'
  | 'attempt-throttled'
  | 'budget-stop'
  | 'cadence-wait'
  | 'reservation-forfeited'

/** Input for conservatively closing a charge lost at a process boundary. */
export type AppendWorkspaceSearchMigrationRehearsalForfeitedAttemptInput = {
  /** Monotonic DescribeTable attempt sequence being conservatively forfeited. */
  readonly attemptSequence: number
  /** Identifier-free migration phase that owned the interrupted charge. */
  readonly phase: WorkspaceSearchMigrationDescribeTablePhase
  /** Trusted process-monotonic time at which recovery classified the charge. */
  readonly observedAtMilliseconds: number
}

/** Input for recording unused checkpoint-page permits lost on recovery. */
export type AppendWorkspaceSearchMigrationRehearsalForfeitedReservationInput = {
  /** Positive number of reserved permits conservatively consumed by recovery. */
  readonly forfeitedAttemptCount: number
  /** Trusted process-monotonic time at which recovery consumed the permits. */
  readonly observedAtMilliseconds: number
}

/** Exact canonical bytes durably appended as one complete record. */
export type WorkspaceSearchMigrationRehearsalRateDurableAppend = (
  /** Header or event bytes including exactly one trailing LF. */
  canonicalRecordBytes: Uint8Array,
) => Promise<void>

/** Construction input for one process-local durable segment recorder. */
export type CreateWorkspaceSearchMigrationRehearsalRateRecorderInput = {
  /** Opaque SHA-256 locator for this process segment. */
  readonly segmentLocatorDigest: string
  /** Zero-based process segment ordinal in the complete stream. */
  readonly segmentOrdinal: number
  /** Digest of the exact preceding segment bytes, or null for segment zero. */
  readonly previousSegmentDigest: string | null
  /** Terminal record MAC of the preceding segment, or null for segment zero. */
  readonly previousRecordMac: string | null
  /** Global one-based event sequence assigned to the first appended event. */
  readonly firstEventSequence: number
  /** Canonical UTC wall-clock anchor corresponding to the monotonic anchor. */
  readonly anchorUtc: string
  /** Trusted process-monotonic clock value corresponding to the UTC anchor. */
  readonly monotonicAnchorMilliseconds: number
  /** SHA-256 digest of the reviewed DescribeTable rate policy. */
  readonly policyVersion: string
  /** Opaque digest binding the measured non-production configuration. */
  readonly configurationBindingDigest: string
  /** Dedicated 32-byte HMAC key copied into and owned by this recorder. */
  readonly authenticationKey: Uint8Array
  /** Callback resolving only after one exact record is durably appended. */
  readonly appendDurably: WorkspaceSearchMigrationRehearsalRateDurableAppend
}

/** Durable identifier-free metadata for one flushed process segment. */
export type WorkspaceSearchMigrationRehearsalRateCommittedSegment = {
  /** Domain-separated fingerprint of the segment authentication key. */
  readonly authenticationKeyFingerprint: string
  /** Opaque locator copied from the authenticated segment header. */
  readonly segmentLocatorDigest: string
  /** Zero-based authenticated segment ordinal. */
  readonly segmentOrdinal: number
  /** Global event sequence allocated by the authenticated segment header. */
  readonly firstEventSequence: number
  /** Number of event records whose durable append callback resolved. */
  readonly eventCount: number
  /** First global event sequence, or null when the segment has no events. */
  readonly firstCommittedEventSequence: number | null
  /** Last global event sequence, or null when the segment has no events. */
  readonly lastCommittedEventSequence: number | null
  /** MAC of the last durable record, including the header for an empty segment. */
  readonly terminalRecordMac: string
  /** SHA-256 digest of the exact canonical append-only segment bytes. */
  readonly segmentDigest: string
  /** Detached exact bytes containing only confirmed durable records. */
  readonly canonicalBytes: Uint8Array
}

/** Input for independently authenticating one closed process rate segment. */
export type VerifyWorkspaceSearchMigrationRehearsalRateSegmentInput = {
  /** Exact canonical LF-delimited closed segment bytes. */
  readonly canonicalBytes: Uint8Array
  /** Shared 32-byte evidence key used by every record HMAC. */
  readonly authenticationKey: Uint8Array
  /** Exact zero-based segment ordinal selected by the stage chain. */
  readonly expectedSegmentOrdinal: number
  /** Reviewed policy digest required from the authenticated header. */
  readonly expectedPolicyVersion: string
  /** Measured configuration digest required from the authenticated header. */
  readonly expectedConfigurationBindingDigest: string
}

/** Input for authenticating one segment against its durable predecessor. */
export type VerifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessorInput = {
  /** Exact canonical LF-delimited bytes of the newly closed segment. */
  readonly canonicalBytes: Uint8Array
  /** Shared 32-byte runtime evidence key authenticating the segment. */
  readonly authenticationKey: Uint8Array
  /** Exact durable predecessor summary, or null for segment zero. */
  readonly expectedPreviousSegment:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegment | null
  /** Reviewed policy digest required from the authenticated header. */
  readonly expectedPolicyVersion: string
  /** Measured configuration digest required from the authenticated header. */
  readonly expectedConfigurationBindingDigest: string
}

/** Independently authenticated closed-segment summary. */
export type WorkspaceSearchMigrationRehearsalVerifiedRateSegment = {
  /** Domain-separated fingerprint of the key authenticating this segment. */
  readonly authenticationKeyFingerprint: string
  /** Opaque authenticated process-segment locator. */
  readonly segmentLocatorDigest: string
  /** Exact zero-based authenticated segment ordinal. */
  readonly segmentOrdinal: number
  /** Global event sequence allocated by the authenticated segment header. */
  readonly firstEventSequence: number
  /** Exact number of authenticated durable event records. */
  readonly eventCount: number
  /** First global authenticated event sequence, or null when empty. */
  readonly firstCommittedEventSequence: number | null
  /** Last global authenticated event sequence, or null when empty. */
  readonly lastCommittedEventSequence: number | null
  /** HMAC of the final event, or the header for an empty segment. */
  readonly terminalRecordMac: string
  /** SHA-256 digest of the exact canonical segment bytes. */
  readonly segmentDigest: string
}

/** Input for authenticating one exact predecessor/successor segment link. */
export type VerifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessorInput = {
  /** Exact canonical LF-delimited bytes of the immediate predecessor. */
  readonly predecessorSegmentBytes: Uint8Array
  /** Exact canonical LF-delimited bytes of the newly closed successor. */
  readonly successorSegmentBytes: Uint8Array
  /** Shared 32-byte runtime evidence key used by both segment record chains. */
  readonly authenticationKey: Uint8Array
  /** Reviewed policy digest required from both authenticated headers. */
  readonly expectedPolicyVersion: string
  /** Measured configuration digest required from both authenticated headers. */
  readonly expectedConfigurationBindingDigest: string
}

/** Authenticated header fields proving the immediate predecessor link. */
export type WorkspaceSearchMigrationRehearsalVerifiedRateSegmentLink = {
  /** Digest of the exact authenticated predecessor bytes. */
  readonly previousSegmentDigest: string
  /** Terminal record MAC of the authenticated predecessor. */
  readonly previousRecordMac: string
  /** First global event sequence allocated by the successor header. */
  readonly firstEventSequence: number
  /** Reviewed policy digest authenticated by both segment headers. */
  readonly policyVersion: string
  /** Measured configuration digest authenticated by both segment headers. */
  readonly configurationBindingDigest: string
}

/** Same-process authenticated proof of one exact immediate segment successor. */
export type WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor = {
  /** Shared domain-separated fingerprint authenticated by both headers. */
  readonly authenticationKeyFingerprint: string
  /** Independently authenticated predecessor segment summary. */
  readonly predecessor: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Independently authenticated newly closed successor segment summary. */
  readonly successor: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Authenticated successor-header fields that bind the two exact segments. */
  readonly link: WorkspaceSearchMigrationRehearsalVerifiedRateSegmentLink
}

/** Input binding one verified auxiliary segment to its final durable ledger. */
export type FinalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidenceInput = {
  /** Fresh same-process proof for the exact predecessor and successor bytes. */
  readonly verifiedSuccessor:
    WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor
  /** Final durable aggregate read only after admissions stop and the rate closes. */
  readonly durableEvidence: WorkspaceSearchMigrationDescribeTableRateEvidence
  /** Canonical completion sampled after rate close and final aggregate capture. */
  readonly completedAt: string
}

/** Canonical auxiliary rate binding embedded in a parent-authenticated audit. */
export type WorkspaceSearchMigrationRehearsalRateSegmentEvidence = {
  /** Domain-separated fingerprint of the exact runtime authentication key. */
  readonly authenticationKeyFingerprint: string
  /** Independently authenticated immediate predecessor summary. */
  readonly predecessor: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Independently authenticated newly closed auxiliary segment summary. */
  readonly successor: WorkspaceSearchMigrationRehearsalVerifiedRateSegment
  /** Authenticated successor-header link between the two exact segments. */
  readonly link: WorkspaceSearchMigrationRehearsalVerifiedRateSegmentLink
  /** Final durable rate-ledger aggregate after the auxiliary session closed. */
  readonly aggregate: WorkspaceSearchMigrationDescribeTableRateEvidence
  /** Canonical digest of the complete final durable aggregate. */
  readonly aggregateDigest: string
  /** Canonical completion after session and rate-ledger close. */
  readonly completedAt: string
}

/** Input for recovering the next process segment from one durable predecessor. */
export type RecoverWorkspaceSearchMigrationRehearsalRateContinuationInput = {
  /** Exact predecessor file bytes, optionally ending in one interrupted record. */
  readonly previousSegmentBytes: Uint8Array
  /** Dedicated 32-byte key authenticating the predecessor record chain. */
  readonly authenticationKey: Uint8Array
  /** Reviewed policy digest required from the authenticated predecessor header. */
  readonly expectedPolicyVersion: string
  /** Measured configuration digest required from the predecessor header. */
  readonly expectedConfigurationBindingDigest: string
}

/** Strict next-segment metadata recovered from one authenticated durable prefix. */
export type WorkspaceSearchMigrationRehearsalRateContinuation = {
  /** Zero-based ordinal allocated to the fresh successor process segment. */
  readonly segmentOrdinal: number
  /** Digest of the exact complete canonical predecessor prefix. */
  readonly previousSegmentDigest: string
  /** Terminal HMAC of the predecessor prefix's last complete record. */
  readonly previousRecordMac: string
  /** Global sequence allocated to the successor's first event. */
  readonly firstEventSequence: number
  /** Exact authenticated predecessor bytes excluding an interrupted suffix. */
  readonly canonicalPreviousSegmentBytes: Uint8Array
  /** Number of non-LF-terminated bytes excluded after a process cutoff. */
  readonly discardedTrailingByteLength: number
  /** Authenticated charge requiring conservative forfeiture on restart. */
  readonly pendingAttempt: {
    /** Monotonic DescribeTable attempt sequence from the durable charge. */
    readonly attemptSequence: number
    /** Identifier-free migration phase from the durable charge. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
  } | null
}

/**
 * Fail-closed recorder used only by the non-production rehearsal harness.
 *
 * The synchronous `record` method is deliberately compatible with the
 * production controller's best-effort observation surface, while `flush`
 * turns any asynchronous durability failure into a rehearsal failure.
 */
export interface WorkspaceSearchMigrationRehearsalRateRecorder
  extends WorkspaceSearchMigrationDescribeTableRateRecorder {
  /**
   * Enqueues a conservative terminal event for a charge lacking a durable
   * physical-start observation after process restart.
   *
   * @param input - Exact pending charge and trusted recovery time.
   */
  appendForfeitedAttempt(
    input: AppendWorkspaceSearchMigrationRehearsalForfeitedAttemptInput,
  ): Promise<void>

  /**
   * Enqueues unused page permits forfeited by durable checkpoint recovery.
   *
   * @param input - Positive forfeiture and trusted recovery time.
   */
  appendForfeitedReservation(
    input: AppendWorkspaceSearchMigrationRehearsalForfeitedReservationInput,
  ): Promise<void>

  /**
   * Waits for all queued durable appends and returns only confirmed bytes.
   *
   * @returns Frozen digest metadata plus detached canonical segment bytes.
   */
  flush(): Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment>

  /** Waits for pending appends, zeroizes the owned key, and closes the recorder. */
  close(): Promise<void>
}

/** Input for strict finalization of all process segments. */
export type FinalizeWorkspaceSearchMigrationRehearsalRateEvidenceInput = {
  /** Ordered exact segment byte streams recovered from durable storage. */
  readonly segments: readonly Uint8Array[]
  /** Dedicated 32-byte key used to authenticate every segment record. */
  readonly authenticationKey: Uint8Array
  /** Reviewed policy digest that every segment and checkpoint must match. */
  readonly expectedPolicyVersion: string
  /** Measured non-production configuration binding required on every segment. */
  readonly expectedConfigurationBindingDigest: string
  /** Final durable rate-ledger aggregate independently read from the controller. */
  readonly durableEvidence: WorkspaceSearchMigrationDescribeTableRateEvidence
}

/** Final immutable actual-rate artifact and evidence-index projection. */
export type WorkspaceSearchMigrationRehearsalFinalizedRateEvidence = {
  /** Exact canonical JSON bytes for the complete authenticated segment vector. */
  readonly canonicalArtifactBytes: Uint8Array
  /** SHA-256 digest of the exact canonical artifact bytes. */
  readonly artifactDigest: string
  /** Number of authenticated durable event records in the artifact. */
  readonly observationCount: number
  /** Number of authenticated process segments in the artifact. */
  readonly segmentCount: number
  /** Number of physical attempt-start observations used for actual rate. */
  readonly startedAttemptCount: number
  /** Evidence shape accepted directly by `migration-rehearsal-evidence.ts`. */
  readonly evidence: WorkspaceSearchMigrationRehearsalRateEvidence
}

/** Common authenticated fields on every durable event. */
type RateEventBase = {
  /** Contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION
  /** Global one-based event sequence across all process segments. */
  readonly eventSequence: number
  /** Non-decreasing offset from the segment's UTC anchor. */
  readonly offsetMilliseconds: number
  /** HMAC of the preceding durable record. */
  readonly previousRecordMac: string
}

/** Authenticated event stored without its terminal HMAC. */
type RateEventPayload = RateEventBase & (
  | {
    /** A durable ledger charge was observed. */
    readonly kind: 'attempt-charged'
    /** Monotonic DescribeTable attempt sequence. */
    readonly attemptSequence: number
    /** Identifier-free migration phase. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
  }
  | {
    /** A charge was conservatively forfeited at a segment cutoff. */
    readonly kind: 'attempt-forfeited'
    /** Monotonic DescribeTable attempt sequence. */
    readonly attemptSequence: number
    /** Identifier-free migration phase. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
    /** Fixed reason proving no caller-provided diagnostic was persisted. */
    readonly reason: 'segment-cutoff-before-durable-start'
  }
  | {
    /** A physical DescribeTable request began. */
    readonly kind: 'attempt-started'
    /** Monotonic DescribeTable attempt sequence. */
    readonly attemptSequence: number
    /** Identifier-free migration phase. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
    /** Normal-admission attempts remaining after cleanup headroom. */
    readonly remainingNormalAdmissionAttempts: number
    /** Physical permits remaining in the rolling policy window. */
    readonly remainingWindowAttempts: number
    /** Reserved page attempts remaining, or zero outside a page. */
    readonly remainingPageAttempts: number
    /** Exact controller observation proving a charged start. */
    readonly inFlight: 1
  }
  | {
    /** DynamoDB throttled one already started attempt. */
    readonly kind: 'attempt-throttled'
    /** Monotonic DescribeTable attempt sequence. */
    readonly attemptSequence: number
    /** Identifier-free migration phase. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
    /** Bounded cooldown selected by the controller. */
    readonly backoffMilliseconds: number
    /** Authenticated origin of this controller-classified throttle. */
    readonly provenance:
      WorkspaceSearchMigrationDescribeTableThrottleProvenance
  }
  | {
    /** Admission stopped before another external operation. */
    readonly kind: 'budget-stop'
    /** Identifier-free migration phase. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
    /** Stable fail-closed stop classification. */
    readonly reason: WorkspaceSearchMigrationDescribeTableRateStopReason
    /** Permits requested by the rejected admission. */
    readonly requiredAttempts: number
    /** Normal-admission attempts remaining after cleanup headroom. */
    readonly remainingNormalAdmissionAttempts: number
    /** Physical permits remaining in the rolling policy window. */
    readonly remainingWindowAttempts: number
    /** Bounded delay before explicit retry. */
    readonly retryAfterMilliseconds: number
    /** Authenticated operational or throttle-specific stop origin. */
    readonly provenance:
      WorkspaceSearchMigrationDescribeTableBudgetStopProvenance
  }
  | {
    /** Admission waited before starting external I/O. */
    readonly kind: 'cadence-wait'
    /** Identifier-free migration phase. */
    readonly phase: WorkspaceSearchMigrationDescribeTablePhase
    /** Exact bounded delay requested from the injected waiter. */
    readonly delayMilliseconds: number
  }
  | {
    /** Interrupted checkpoint-page permits were conservatively consumed. */
    readonly kind: 'reservation-forfeited'
    /** Positive number of unused permits consumed by recovery. */
    readonly forfeitedAttemptCount: number
  }
)

/** Complete authenticated durable event. */
type RateEvent = RateEventPayload & {
  /** HMAC-SHA-256 authenticating this payload and prior-record chain. */
  readonly mac: string
}

/** Authenticated process-segment header without its terminal HMAC. */
type RateSegmentHeaderPayload = {
  /** Canonical process-segment header label. */
  readonly kind: typeof rateSegmentHeaderKind
  /** Segment contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION
  /** Domain-separated fingerprint of the record-chain authentication key. */
  readonly authenticationKeyFingerprint: string
  /** Opaque SHA-256 segment locator. */
  readonly segmentLocatorDigest: string
  /** Zero-based strict segment ordinal. */
  readonly segmentOrdinal: number
  /** Digest of the preceding exact segment bytes. */
  readonly previousSegmentDigest: string | null
  /** Terminal record MAC of the preceding segment. */
  readonly previousRecordMac: string | null
  /** Global sequence assigned to this segment's first event. */
  readonly firstEventSequence: number
  /** Canonical UTC wall-clock segment anchor. */
  readonly anchorUtc: string
  /** Reviewed DescribeTable rate-policy digest. */
  readonly policyVersion: string
  /** Measured non-production configuration binding. */
  readonly configurationBindingDigest: string
}

/** Complete authenticated segment header. */
type RateSegmentHeader = RateSegmentHeaderPayload & {
  /** HMAC-SHA-256 authenticating the segment header and prior chain. */
  readonly mac: string
}

/** Strict normalized process segment consumed by the finalizer. */
type ParsedRateSegment = {
  /** Authenticated segment header. */
  readonly header: RateSegmentHeader
  /** Authenticated durable events in exact append order. */
  readonly events: readonly RateEvent[]
  /** Digest of the exact canonical append-only bytes. */
  readonly segmentDigest: string
  /** Exact byte count used for suite bounds. */
  readonly byteLength: number
}

/** Distributively removes recorder-owned fields from one event variant. */
type RecorderOwnedRateFieldsRemoved<Event> = Event extends RateEventPayload
  ? Omit<Event,
    'eventSequence' | 'offsetMilliseconds' | 'previousRecordMac' | 'version'>
  : never

/** Recorder-owned event input detached before asynchronous persistence. */
type PendingRateEvent = RecorderOwnedRateFieldsRemoved<RateEventPayload> & {
    /** Trusted process-monotonic event time. */
    readonly observedAtMilliseconds: number
  }

/** Mutable strict finalizer accounting state. */
type RateAggregationState = {
  /** Number of charged attempts. */
  attemptCount: number
  /** Number of interrupted checkpoint-page reservation permits forfeited. */
  forfeitedAttemptCount: number
  /** Total number of throttled physical attempts. */
  throttleCount: number
  /** Number of genuine AWS-service throttles. */
  awsServiceThrottleCount: number
  /** Number of deterministic post-success injected throttles. */
  rehearsalInjectedThrottleCount: number
  /** Total number of fail-closed stops. */
  budgetStopCount: number
  /** Number of non-throttle admission stops. */
  operationalBudgetStopCount: number
  /** Number of stops caused by genuine AWS-service throttles. */
  awsServiceThrottleBudgetStopCount: number
  /** Number of stops caused by deterministic post-success injection. */
  rehearsalInjectedBudgetStopCount: number
  /** Number of cadence waits. */
  cadenceWaitCount: number
  /** Sum of requested cadence waits. */
  cadenceWaitMilliseconds: number
  /** Maximum outstanding charged-attempt count. */
  maximumInFlight: 0 | 1
  /** Charged attempt not yet durably started or forfeited. */
  pendingAttemptSequence: number | null
  /** Absolute start time retained from the source attempt observation. */
  pendingAttemptChargedAtEpochMilliseconds: number | null
  /** Expected next monotonic attempt sequence. */
  nextAttemptSequence: number
  /** Physical attempt sequences already started. */
  readonly startedAttemptSequences: Set<number>
  /** Physical attempt sequences already classified as throttled. */
  readonly throttledAttemptSequences: Set<number>
  /** Throttle provenance that the immediately following stop must close. */
  pendingThrottleProvenance:
    WorkspaceSearchMigrationDescribeTableThrottleProvenance | null
  /** Most recent started attempt sequence. */
  lastStartedAttemptSequence: number | null
  /** Absolute UTC millisecond timestamps for physical starts. */
  readonly attemptStartedAtEpochMilliseconds: number[]
}

/** Final canonical stream artifact before serialization. */
type RateArtifact = {
  /** Canonical complete-stream label. */
  readonly kind: typeof rateArtifactKind
  /** Complete-stream contract version. */
  readonly version:
    typeof WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION
  /** Reviewed rate-policy digest shared by all segments. */
  readonly policyVersion: string
  /** Measured non-production configuration binding shared by all segments. */
  readonly configurationBindingDigest: string
  /** Strict ordered authenticated segment vector. */
  readonly segments: readonly {
    /** Exact authenticated process header. */
    readonly header: RateSegmentHeader
    /** Exact authenticated durable events. */
    readonly events: readonly RateEvent[]
  }[]
}

/** Strict guards sharing the module's stable public failure. */
const rateGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failInvalidRateEvidence,
)

/** Same-process authenticity brand for finalized rate evidence objects. */
const authenticatedFinalizedRateEvidence = new WeakSet<object>()

/** One-shot same-process values for exact predecessor/successor link proofs. */
const authenticatedRateSegmentSuccessors = new WeakMap<
  object,
  WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor
>()

/**
 * Creates the secret-free locator of one rate record-chain authentication key.
 *
 * The caller retains ownership of its key. This boundary validates and copies
 * the key, derives a domain-separated HMAC fingerprint, and overwrites only its
 * private working copy.
 *
 * @param authenticationKey - Exact 32-byte rate authentication key.
 * @returns Lowercase domain-separated HMAC-SHA-256 key fingerprint.
 */
export function createWorkspaceSearchMigrationRehearsalRateAuthenticationKeyFingerprint(
  authenticationKey: Uint8Array,
): string {
  let key: Uint8Array | undefined
  try {
    key = copyAuthenticationKey(authenticationKey)
    return createRateAuthenticationKeyFingerprint(key)
  } catch {
    return failInvalidRateEvidence()
  } finally {
    key?.fill(0)
  }
}

/**
 * Creates one authenticated append-only recorder after durably writing its
 * segment header.
 *
 * @param input - Exact segment chain, clock anchors, key, and durable sink.
 * @returns Recorder compatible with the existing observation surface.
 */
export async function createWorkspaceSearchMigrationRehearsalRateRecorder(
  input: CreateWorkspaceSearchMigrationRehearsalRateRecorderInput,
): Promise<WorkspaceSearchMigrationRehearsalRateRecorder> {
  const snapshot = readRecorderInput(input)
  const key = copyAuthenticationKey(snapshot.authenticationKey)
  const headerPayload = createSegmentHeaderPayload(
    snapshot,
    createRateAuthenticationKeyFingerprint(key),
  )
  const header = Object.freeze({
    ...headerPayload,
    mac: createRateRecordMac(key, headerPayload),
  })
  const canonicalHeaderBytes = encodeRateRecord(header)
  try {
    await callDurableAppend(snapshot.appendDurably, canonicalHeaderBytes)
  } catch {
    key.fill(0)
    throw new Error(durableAppendFailureMessage)
  }
  return new DurableWorkspaceSearchMigrationRehearsalRateRecorder(
    snapshot,
    key,
    header,
    canonicalHeaderBytes,
  )
}

/**
 * Recovers strict successor metadata from the last authenticated complete
 * record prefix of one process segment.
 *
 * A SIGKILL may leave a bounded non-LF-terminated write suffix. Only the
 * HMAC-authenticated canonical prefix is admitted into the chain; a complete
 * newline-terminated but invalid record remains a hard failure.
 *
 * @param input - Predecessor bytes, dedicated key, and reviewed bindings.
 * @returns Frozen successor metadata and the exact admitted predecessor bytes.
 */
export function recoverWorkspaceSearchMigrationRehearsalRateContinuation(
  input: RecoverWorkspaceSearchMigrationRehearsalRateContinuationInput,
): WorkspaceSearchMigrationRehearsalRateContinuation {
  let key: Uint8Array | undefined
  try {
    key = copyAuthenticationKey(input.authenticationKey)
    const bytes = copyRecoverableSegmentBytes(input.previousSegmentBytes)
    const lastLineFeedIndex = bytes.lastIndexOf(0x0a)
    if (lastLineFeedIndex < 0) return failInvalidRateEvidence()
    const discardedTrailingByteLength =
      bytes.byteLength - lastLineFeedIndex - 1
    if (discardedTrailingByteLength >= maximumRateRecordBytes) {
      return failInvalidRateEvidence()
    }
    const canonicalPreviousSegmentBytes = bytes.slice(
      0,
      lastLineFeedIndex + 1,
    )
    const segment = parseSegment(canonicalPreviousSegmentBytes, key)
    const expectedPolicyVersion = readDigest(input.expectedPolicyVersion)
    const expectedConfigurationBindingDigest = readDigest(
      input.expectedConfigurationBindingDigest,
    )
    if (
      segment.header.policyVersion !== expectedPolicyVersion ||
      segment.header.configurationBindingDigest !==
        expectedConfigurationBindingDigest ||
      segment.header.segmentOrdinal >=
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENTS - 1
    ) {
      return failInvalidRateEvidence()
    }
    const lastEvent = segment.events.at(-1)
    const firstEventSequence = readPositiveCount(
      segment.header.firstEventSequence + segment.events.length,
    )
    const pendingAttempt = lastEvent?.kind === 'attempt-charged'
      ? Object.freeze({
          attemptSequence: lastEvent.attemptSequence,
          phase: lastEvent.phase,
        })
      : null
    return Object.freeze({
      segmentOrdinal: segment.header.segmentOrdinal + 1,
      previousSegmentDigest: segment.segmentDigest,
      previousRecordMac: lastEvent?.mac ?? segment.header.mac,
      firstEventSequence,
      canonicalPreviousSegmentBytes,
      discardedTrailingByteLength,
      pendingAttempt,
    })
  } catch {
    return failInvalidRateEvidence()
  } finally {
    key?.fill(0)
  }
}

/**
 * Independently authenticates one closed segment and derives its exact summary.
 *
 * This boundary verifies every canonical header/event HMAC and the internal
 * record chain without requiring preceding segment bytes. The authenticated
 * header still commits the predecessor digest and MAC for later full-chain
 * finalization.
 *
 * @param input - Exact segment bytes, shared key, ordinal, and bindings.
 * @returns Frozen authenticated summary derived only from exact bytes.
 */
export function verifyWorkspaceSearchMigrationRehearsalRateSegment(
  input: VerifyWorkspaceSearchMigrationRehearsalRateSegmentInput,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  let key: Uint8Array | undefined
  try {
    key = copyAuthenticationKey(input.authenticationKey)
    const expectedSegmentOrdinal = readNonNegativeCount(
      input.expectedSegmentOrdinal,
    )
    const expectedPolicyVersion = readDigest(input.expectedPolicyVersion)
    const expectedConfigurationBindingDigest = readDigest(
      input.expectedConfigurationBindingDigest,
    )
    const segment = parseSegment(input.canonicalBytes, key)
    return authenticateParsedRateSegment(
      segment,
      expectedSegmentOrdinal,
      expectedPolicyVersion,
      expectedConfigurationBindingDigest,
    )
  } catch {
    return failInvalidRateEvidence()
  } finally {
    key?.fill(0)
  }
}

/**
 * Authenticates one closed segment and its durable predecessor header link.
 *
 * The predecessor digest, terminal MAC, ordinal, key fingerprint, and known
 * next event sequence are checked against the exact durable summary.
 *
 * @param input - Current bytes, exact predecessor, key, and reviewed bindings.
 * @returns Frozen authenticated current summary linked to that predecessor.
 */
export function verifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessor(
  input: VerifyWorkspaceSearchMigrationRehearsalRateSegmentPredecessorInput,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  let key: Uint8Array | undefined
  try {
    key = copyAuthenticationKey(input.authenticationKey)
    const expectedPreviousSegment = input.expectedPreviousSegment === null
      ? null
      : readVerifiedRateSegmentSummary(input.expectedPreviousSegment)
    const expectedPolicyVersion = readDigest(input.expectedPolicyVersion)
    const expectedConfigurationBindingDigest = readDigest(
      input.expectedConfigurationBindingDigest,
    )
    const segment = parseSegment(input.canonicalBytes, key)
    const expectedSegmentOrdinal = expectedPreviousSegment === null
      ? 0
      : expectedPreviousSegment.segmentOrdinal + 1
    const authenticated = authenticateParsedRateSegment(
      segment,
      expectedSegmentOrdinal,
      expectedPolicyVersion,
      expectedConfigurationBindingDigest,
    )
    const header = segment.header
    const expectedFirstEventSequence = expectedPreviousSegment === null
      ? 1
      : expectedPreviousSegment.firstEventSequence +
        expectedPreviousSegment.eventCount
    if (
      header.previousSegmentDigest !==
        (expectedPreviousSegment?.segmentDigest ?? null) ||
      header.previousRecordMac !==
        (expectedPreviousSegment?.terminalRecordMac ?? null) ||
      (expectedPreviousSegment !== null &&
        expectedPreviousSegment.authenticationKeyFingerprint !==
          authenticated.authenticationKeyFingerprint) ||
      header.firstEventSequence !== expectedFirstEventSequence
    ) return failInvalidRateEvidence()
    return authenticated
  } catch {
    return failInvalidRateEvidence()
  } finally {
    key?.fill(0)
  }
}

/**
 * Authenticates two exact closed segments and proves immediate succession.
 *
 * Both canonical record streams are independently HMAC-authenticated before
 * the successor header is required to carry the predecessor's exact byte
 * digest, terminal record MAC, next ordinal, and next global event sequence.
 * The returned frozen value has a one-shot same-process authenticity brand so
 * a downstream artifact finalizer can reject structural substitutes.
 *
 * @param input - Exact adjacent segment bytes, shared key, and fixed bindings.
 * @returns Frozen predecessor, successor, and authenticated link proof.
 */
export function verifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessor(
  input: VerifyWorkspaceSearchMigrationRehearsalRateSegmentSuccessorInput,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor {
  let key: Uint8Array | undefined
  try {
    key = copyAuthenticationKey(input.authenticationKey)
    const expectedPolicyVersion = readDigest(input.expectedPolicyVersion)
    const expectedConfigurationBindingDigest = readDigest(
      input.expectedConfigurationBindingDigest,
    )
    const predecessor = parseSegment(input.predecessorSegmentBytes, key)
    const successor = parseSegment(input.successorSegmentBytes, key)
    const predecessorHeader = predecessor.header
    const successorHeader = successor.header
    if (
      predecessor.byteLength + successor.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_TOTAL_BYTES ||
      predecessor.events.length + successor.events.length >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_EVENTS ||
      predecessorHeader.segmentOrdinal >=
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENTS - 1 ||
      successorHeader.segmentOrdinal !==
        predecessorHeader.segmentOrdinal + 1 ||
      successorHeader.segmentOrdinal >=
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENTS ||
      predecessorHeader.segmentLocatorDigest ===
        successorHeader.segmentLocatorDigest ||
      (
        predecessorHeader.segmentOrdinal === 0
          ? predecessorHeader.previousSegmentDigest !== null ||
            predecessorHeader.previousRecordMac !== null ||
            predecessorHeader.firstEventSequence !== 1
          : predecessorHeader.previousSegmentDigest === null ||
            predecessorHeader.previousRecordMac === null
      )
    ) return failInvalidRateEvidence()
    const predecessorSummary = authenticateParsedRateSegment(
      predecessor,
      predecessorHeader.segmentOrdinal,
      expectedPolicyVersion,
      expectedConfigurationBindingDigest,
    )
    const successorSummary = authenticateParsedRateSegment(
      successor,
      successorHeader.segmentOrdinal,
      expectedPolicyVersion,
      expectedConfigurationBindingDigest,
    )
    const authenticationKeyFingerprint =
      createRateAuthenticationKeyFingerprint(key)
    const predecessorTerminalRecordMac =
      predecessorSummary.terminalRecordMac
    const expectedFirstEventSequence = readPositiveCount(
      predecessorHeader.firstEventSequence + predecessor.events.length,
    )
    const predecessorAnchorEpochMilliseconds = Date.parse(
      predecessorHeader.anchorUtc,
    )
    const successorAnchorEpochMilliseconds = Date.parse(
      successorHeader.anchorUtc,
    )
    const predecessorLastEvent = predecessor.events.at(-1)
    const predecessorTerminalEpochMilliseconds =
      predecessorAnchorEpochMilliseconds +
        (predecessorLastEvent?.offsetMilliseconds ?? 0)
    if (
      successorHeader.previousSegmentDigest !==
        predecessorSummary.segmentDigest ||
      successorHeader.previousRecordMac !== predecessorTerminalRecordMac ||
      !areDigestsEqual(
        predecessorSummary.authenticationKeyFingerprint,
        authenticationKeyFingerprint,
      ) ||
      !areDigestsEqual(
        successorSummary.authenticationKeyFingerprint,
        authenticationKeyFingerprint,
      ) ||
      successorHeader.firstEventSequence !== expectedFirstEventSequence ||
      successorAnchorEpochMilliseconds < predecessorAnchorEpochMilliseconds ||
      successorAnchorEpochMilliseconds < predecessorTerminalEpochMilliseconds
    ) return failInvalidRateEvidence()
    const link = Object.freeze({
      previousSegmentDigest: successorHeader.previousSegmentDigest,
      previousRecordMac: successorHeader.previousRecordMac,
      firstEventSequence: successorHeader.firstEventSequence,
      policyVersion: successorHeader.policyVersion,
      configurationBindingDigest:
        successorHeader.configurationBindingDigest,
    }) satisfies WorkspaceSearchMigrationRehearsalVerifiedRateSegmentLink
    const verified = Object.freeze({
      authenticationKeyFingerprint,
      predecessor: predecessorSummary,
      successor: successorSummary,
      link,
    }) satisfies WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor
    authenticatedRateSegmentSuccessors.set(verified, verified)
    return verified
  } catch {
    return failInvalidRateEvidence()
  } finally {
    key?.fill(0)
  }
}

/**
 * Consumes the same-process authenticity brand of one successor proof.
 *
 * @param value - Exact proof returned by the two-segment verifier.
 * @returns The frozen authenticated proof retained behind the one-shot brand.
 * @throws {WorkspaceSearchMigrationRehearsalRateEvidenceError} When the value
 * is forged, cloned, proxied, or has already been consumed.
 */
export function consumeWorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) {
    return failInvalidRateEvidence()
  }
  const verified = authenticatedRateSegmentSuccessors.get(value)
  if (verified === undefined) return failInvalidRateEvidence()
  authenticatedRateSegmentSuccessors.delete(value)
  return verified
}

/**
 * Consumes one exact successor proof and binds its final durable rate ledger.
 *
 * The proof can be finalized only once. The aggregate must be a strict final
 * snapshot from the same reviewed policy, and the completion timestamp must
 * be canonical. Callers embed the returned immutable binding directly inside
 * a runtime-authenticated and parent-authorized audit artifact.
 *
 * @param input - Fresh proof, final durable aggregate, and close completion.
 * @returns Canonical secret-free auxiliary rate evidence.
 */
export function finalizeWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
  input: unknown,
): WorkspaceSearchMigrationRehearsalRateSegmentEvidence {
  try {
    const record = rateGuards.requireRecord(input)
    rateGuards.requireExactKeys(record, [
      'completedAt',
      'durableEvidence',
      'verifiedSuccessor',
    ])
    const verified =
      consumeWorkspaceSearchMigrationRehearsalVerifiedRateSegmentSuccessor(
        rateGuards.readOwn(record, 'verifiedSuccessor'),
      )
    const aggregate = readDurableEvidence(
      rateGuards.readOwn(record, 'durableEvidence'),
      verified.link.policyVersion,
    )
    const completedAt = rateGuards.readOwn(record, 'completedAt')
    if (
      typeof completedAt !== 'string' ||
      !isCanonicalTimestamp(completedAt)
    ) return failInvalidRateEvidence()
    return Object.freeze({
      authenticationKeyFingerprint:
        verified.authenticationKeyFingerprint,
      predecessor: verified.predecessor,
      successor: verified.successor,
      link: verified.link,
      aggregate,
      aggregateDigest: createMigrationDigest(aggregate),
      completedAt,
    })
  } catch {
    return failInvalidRateEvidence()
  }
}

/**
 * Strictly parses an auxiliary rate binding after parent artifact HMAC checks.
 *
 * This function validates only the secret-free canonical projection. It does
 * not replace raw segment HMAC verification or the one-shot finalizer above;
 * parent-authenticated artifact readers use it to reconstruct the exact rate
 * binding covered by their own HMAC.
 *
 * @param value - Candidate canonical auxiliary rate evidence record.
 * @returns Frozen normalized rate evidence with all arithmetic rechecked.
 */
export function readWorkspaceSearchMigrationRehearsalRateSegmentEvidence(
  value: unknown,
): WorkspaceSearchMigrationRehearsalRateSegmentEvidence {
  try {
    const record = rateGuards.requireRecord(value)
    rateGuards.requireExactKeys(record, [
      'aggregate',
      'aggregateDigest',
      'authenticationKeyFingerprint',
      'completedAt',
      'link',
      'predecessor',
      'successor',
    ])
    const predecessor = readVerifiedRateSegmentSummary(
      rateGuards.readOwn(record, 'predecessor'),
    )
    const successor = readVerifiedRateSegmentSummary(
      rateGuards.readOwn(record, 'successor'),
    )
    const link = readVerifiedRateSegmentLink(
      rateGuards.readOwn(record, 'link'),
    )
    const aggregate = readDurableEvidence(
      rateGuards.readOwn(record, 'aggregate'),
      link.policyVersion,
    )
    const aggregateDigest = readDigest(
      rateGuards.readOwn(record, 'aggregateDigest'),
    )
    const authenticationKeyFingerprint = readDigest(
      rateGuards.readOwn(record, 'authenticationKeyFingerprint'),
    )
    const completedAt = rateGuards.readOwn(record, 'completedAt')
    const predecessorNextEventSequence =
      predecessor.firstEventSequence + predecessor.eventCount
    if (
      typeof completedAt !== 'string' ||
      !isCanonicalTimestamp(completedAt) ||
      successor.segmentOrdinal !== predecessor.segmentOrdinal + 1 ||
      successor.segmentLocatorDigest === predecessor.segmentLocatorDigest ||
      !areDigestsEqual(
        predecessor.authenticationKeyFingerprint,
        authenticationKeyFingerprint,
      ) ||
      !areDigestsEqual(
        successor.authenticationKeyFingerprint,
        authenticationKeyFingerprint,
      ) ||
      link.previousSegmentDigest !== predecessor.segmentDigest ||
      link.previousRecordMac !== predecessor.terminalRecordMac ||
      successor.firstCommittedEventSequence !== null &&
        successor.firstCommittedEventSequence !== link.firstEventSequence ||
      predecessorNextEventSequence !== link.firstEventSequence ||
      aggregateDigest !== createMigrationDigest(aggregate)
    ) return failInvalidRateEvidence()
    return Object.freeze({
      authenticationKeyFingerprint,
      predecessor,
      successor,
      link,
      aggregate,
      aggregateDigest,
      completedAt,
    })
  } catch {
    return failInvalidRateEvidence()
  }
}

/**
 * Strictly authenticates, joins, and aggregates all durable process segments.
 *
 * @param input - Ordered segment bytes, expected bindings, key, and ledger sum.
 * @returns Frozen canonical artifact metadata and evidence-index projection.
 */
export function finalizeWorkspaceSearchMigrationRehearsalRateEvidence(
  input: FinalizeWorkspaceSearchMigrationRehearsalRateEvidenceInput,
): WorkspaceSearchMigrationRehearsalFinalizedRateEvidence {
  let key: Uint8Array | undefined
  try {
    key = copyAuthenticationKey(input.authenticationKey)
    const expectedPolicyVersion = readDigest(input.expectedPolicyVersion)
    const expectedConfigurationBindingDigest = readDigest(
      input.expectedConfigurationBindingDigest,
    )
    const durableEvidence = readDurableEvidence(
      input.durableEvidence,
      expectedPolicyVersion,
    )
    const segmentBytes = readSegmentVector(input.segments)
    const parsedSegments = parseAndJoinSegments(
      segmentBytes,
      key,
      expectedPolicyVersion,
      expectedConfigurationBindingDigest,
    )
    const aggregation = aggregateRateEvents(parsedSegments)
    const aggregate = createRateAggregate(
      aggregation,
      expectedPolicyVersion,
    )
    requireDurableAggregateMatch(aggregate, durableEvidence)
    const observedMaximumRatePerSecond = calculateMaximumAttemptStartRate(
      aggregation.attemptStartedAtEpochMilliseconds,
    )
    if (observedMaximumRatePerSecond < 1) return failInvalidRateEvidence()
    const artifact = createRateArtifact(
      parsedSegments,
      expectedPolicyVersion,
      expectedConfigurationBindingDigest,
    )
    const canonicalArtifactBytes = new TextEncoder().encode(
      serializeCanonicalJson(artifact),
    )
    if (
      canonicalArtifactBytes.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_TOTAL_BYTES
    ) {
      return failInvalidRateEvidence()
    }
    const artifactDigest = createHash('sha256')
      .update(canonicalArtifactBytes)
      .digest('hex')
    const observationCount = parsedSegments.reduce(
      (count, segment) => count + segment.events.length,
      0,
    )
    const evidence = Object.freeze({
      aggregate,
      aggregateDigest: createMigrationDigest(aggregate),
      observationStreamDigest: artifactDigest,
      observationCount,
      observedMaximumRatePerSecond,
    }) satisfies WorkspaceSearchMigrationRehearsalRateEvidence
    const finalized = Object.freeze({
      canonicalArtifactBytes,
      artifactDigest,
      observationCount,
      segmentCount: parsedSegments.length,
      startedAttemptCount:
        aggregation.attemptStartedAtEpochMilliseconds.length,
      evidence,
    })
    authenticatedFinalizedRateEvidence.add(finalized)
    return finalized
  } catch {
    return failInvalidRateEvidence()
  } finally {
    key?.fill(0)
  }
}

/**
 * Consumes the same-process authenticity brand of finalized rate evidence.
 *
 * The suite assembler calls this exactly once before detaching the rate
 * artifact. A structurally convincing object, a structured clone, or replay
 * after prior consumption has no brand and fails through the stable rate
 * evidence boundary.
 *
 * @param value - Exact finalized object returned by this module in this process.
 * @throws {WorkspaceSearchMigrationRehearsalRateEvidenceError} When the value
 * is not the fresh same-process result of authenticated segment finalization.
 */
export function consumeWorkspaceSearchMigrationRehearsalFinalizedRateEvidence(
  value: WorkspaceSearchMigrationRehearsalFinalizedRateEvidence,
): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value) ||
    !authenticatedFinalizedRateEvidence.delete(value)
  ) {
    return failInvalidRateEvidence()
  }
}

/** Process-local implementation with a serial never-rejecting queue. */
class DurableWorkspaceSearchMigrationRehearsalRateRecorder
  implements WorkspaceSearchMigrationRehearsalRateRecorder {
  /** Detached validated construction input. */
  readonly #input: RecorderInputSnapshot

  /** Recorder-owned authentication key zeroized on close. */
  readonly #key: Uint8Array

  /** Exact confirmed canonical record chunks. */
  readonly #committedChunks: Uint8Array[]

  /** Exact confirmed bytes retained without repeatedly scanning all chunks. */
  #committedByteLength: number

  /** Serial append tail that always resolves after recording stable failure. */
  #tail: Promise<void> = Promise.resolve()

  /** First durable event sequence allocated to this segment. */
  readonly #firstEventSequence: number

  /** Next event sequence reserved in synchronous observation order. */
  #nextEventSequence: number

  /** MAC of the last append whose durability callback resolved. */
  #lastCommittedMac: string

  /** Number of event appends confirmed by the durable callback. */
  #committedEventCount = 0

  /** Stable asynchronous durability or validation failure. */
  #failure: Error | undefined

  /** Whether the recorder has been closed and its key zeroized. */
  #closed = false

  /**
   * Retains a durably initialized process segment.
   *
   * @param input - Detached validated construction input.
   * @param key - Recorder-owned authentication key.
   * @param header - Authenticated already durable header.
   * @param headerBytes - Exact canonical durable header bytes.
   */
  constructor(
    input: RecorderInputSnapshot,
    key: Uint8Array,
    header: RateSegmentHeader,
    headerBytes: Uint8Array,
  ) {
    this.#input = input
    this.#key = key
    this.#committedChunks = [headerBytes.slice()]
    this.#committedByteLength = headerBytes.byteLength
    this.#firstEventSequence = input.firstEventSequence
    this.#nextEventSequence = input.firstEventSequence
    this.#lastCommittedMac = header.mac
    Object.freeze(this)
  }

  /**
   * Detaches and enqueues one existing identifier-free rate observation.
   *
   * An `attempt` observation expands to a charge followed by its physical
   * start so the finalizer can prove that every start consumed one charge.
   *
   * @param observation - Existing production-safe rate observation.
   */
  record(
    observation: WorkspaceSearchMigrationDescribeTableRateObservation,
  ): void {
    if (this.#closed || this.#failure !== undefined) return
    try {
      const events = convertRateObservation(observation)
      this.#enqueue(events)
    } catch {
      this.#recordFailure(invalidRateEvidenceMessage)
    }
  }

  /**
   * Enqueues a conservative terminal event for an interrupted charge.
   *
   * @param input - Exact pending attempt sequence and recovery time.
   * @returns Promise rejecting when any queued append is not confirmed.
   */
  appendForfeitedAttempt(
    input: AppendWorkspaceSearchMigrationRehearsalForfeitedAttemptInput,
  ): Promise<void> {
    let event: PendingRateEvent
    try {
      event = Object.freeze({
        kind: 'attempt-forfeited',
        attemptSequence: readPositiveCount(input.attemptSequence),
        phase: readPhase(input.phase),
        reason: 'segment-cutoff-before-durable-start',
        observedAtMilliseconds: readMonotonicTime(
          input.observedAtMilliseconds,
        ),
      })
    } catch {
      this.#recordFailure(invalidRateEvidenceMessage)
      return Promise.reject(new Error(invalidRateEvidenceMessage))
    }
    return this.#enqueueForCaller([event])
  }

  /**
   * Enqueues unused page permits consumed by interrupted recovery.
   *
   * @param input - Positive forfeiture and trusted recovery time.
   * @returns Promise rejecting when any queued append is not confirmed.
   */
  appendForfeitedReservation(
    input: AppendWorkspaceSearchMigrationRehearsalForfeitedReservationInput,
  ): Promise<void> {
    let event: PendingRateEvent
    try {
      event = Object.freeze({
        kind: 'reservation-forfeited',
        forfeitedAttemptCount: readPositiveCount(
          input.forfeitedAttemptCount,
        ),
        observedAtMilliseconds: readMonotonicTime(
          input.observedAtMilliseconds,
        ),
      })
    } catch {
      this.#recordFailure(invalidRateEvidenceMessage)
      return Promise.reject(new Error(invalidRateEvidenceMessage))
    }
    return this.#enqueueForCaller([event])
  }

  /**
   * Waits for the durable queue and returns only confirmed records.
   *
   * @returns Frozen metadata and detached exact canonical segment bytes.
   */
  async flush(): Promise<WorkspaceSearchMigrationRehearsalRateCommittedSegment> {
    await this.#tail
    this.#throwFailureOrClosed(true)
    const canonicalBytes = concatenateByteChunks(this.#committedChunks)
    const firstCommittedEventSequence = this.#committedEventCount === 0
      ? null
      : this.#firstEventSequence
    const lastCommittedEventSequence = this.#committedEventCount === 0
      ? null
      : this.#firstEventSequence + this.#committedEventCount - 1
    return Object.freeze({
      authenticationKeyFingerprint:
        createRateAuthenticationKeyFingerprint(this.#key),
      segmentLocatorDigest: this.#input.segmentLocatorDigest,
      segmentOrdinal: this.#input.segmentOrdinal,
      firstEventSequence: this.#firstEventSequence,
      eventCount: this.#committedEventCount,
      firstCommittedEventSequence,
      lastCommittedEventSequence,
      terminalRecordMac: this.#lastCommittedMac,
      segmentDigest: createHash('sha256').update(canonicalBytes).digest('hex'),
      canonicalBytes,
    })
  }

  /** Waits for pending appends, records failure, and zeroizes the owned key. */
  async close(): Promise<void> {
    if (this.#closed) return
    await this.#tail
    this.#closed = true
    this.#key.fill(0)
    if (this.#failure !== undefined) throw this.#failure
  }

  /** Enqueues events for the synchronous best-effort recorder surface. */
  #enqueue(events: readonly PendingRateEvent[]): void {
    if (this.#closed) {
      this.#recordFailure(invalidRateEvidenceMessage)
      return
    }
    this.#appendToTail(events)
  }

  /** Enqueues events and exposes the eventual fail-closed outcome to callers. */
  #enqueueForCaller(events: readonly PendingRateEvent[]): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error(invalidRateEvidenceMessage))
    }
    const completion = this.#appendToTail(events)
    return completion.then(() => {
      if (this.#failure !== undefined) throw this.#failure
    })
  }

  /** Adds one immutable event group to the serial non-rejecting append tail. */
  #appendToTail(events: readonly PendingRateEvent[]): Promise<void> {
    const eventSnapshot = Object.freeze([...events])
    const operation = this.#tail.then(async () => {
      if (this.#failure !== undefined || this.#closed) return
      for (const event of eventSnapshot) {
        if (this.#committedEventCount >=
          WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_EVENTS) {
          this.#recordFailure(invalidRateEvidenceMessage)
          return
        }
        let payload: RateEventPayload
        let complete: RateEvent
        let bytes: Uint8Array
        try {
          payload = createEventPayload(
            event,
            this.#nextEventSequence,
            this.#lastCommittedMac,
            this.#input.monotonicAnchorMilliseconds,
          )
          complete = Object.freeze({
            ...payload,
            mac: createRateRecordMac(this.#key, payload),
          })
          bytes = encodeRateRecord(complete)
          const nextByteLength = addBoundedCounts(
            this.#committedByteLength,
            bytes.byteLength,
          )
          if (nextByteLength >
            WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES) {
            this.#recordFailure(invalidRateEvidenceMessage)
            return
          }
        } catch {
          this.#recordFailure(invalidRateEvidenceMessage)
          return
        }
        try {
          await callDurableAppend(this.#input.appendDurably, bytes)
        } catch {
          this.#recordFailure(durableAppendFailureMessage)
          return
        }
        this.#committedChunks.push(bytes.slice())
        this.#committedByteLength += bytes.byteLength
        this.#lastCommittedMac = complete.mac
        this.#committedEventCount += 1
        this.#nextEventSequence += 1
      }
    })
    this.#tail = operation.catch(() => {
      this.#recordFailure(durableAppendFailureMessage)
    })
    return this.#tail
  }

  /** Retains the first stable failure without exposing caller material. */
  #recordFailure(message: string): void {
    this.#failure ??= new Error(message)
  }

  /** Throws the retained stable failure or a closed-recorder failure. */
  #throwFailureOrClosed(requireOpen: boolean): void {
    if (this.#failure !== undefined) throw this.#failure
    if (requireOpen && this.#closed) throw new Error(invalidRateEvidenceMessage)
  }
}

/** Detached validated recorder construction input. */
type RecorderInputSnapshot = {
  /** Opaque segment locator. */
  readonly segmentLocatorDigest: string
  /** Strict zero-based segment ordinal. */
  readonly segmentOrdinal: number
  /** Exact previous segment digest. */
  readonly previousSegmentDigest: string | null
  /** Exact previous terminal record MAC. */
  readonly previousRecordMac: string | null
  /** First global event sequence. */
  readonly firstEventSequence: number
  /** Canonical UTC anchor. */
  readonly anchorUtc: string
  /** Process-monotonic anchor. */
  readonly monotonicAnchorMilliseconds: number
  /** Reviewed policy digest. */
  readonly policyVersion: string
  /** Non-production configuration binding. */
  readonly configurationBindingDigest: string
  /** Caller key copied later into recorder ownership. */
  readonly authenticationKey: Uint8Array
  /** Exact durable append callback. */
  readonly appendDurably: WorkspaceSearchMigrationRehearsalRateDurableAppend
}

/** Strictly snapshots recorder construction input before the first await. */
function readRecorderInput(
  input: CreateWorkspaceSearchMigrationRehearsalRateRecorderInput,
): RecorderInputSnapshot {
  try {
    const segmentOrdinal = readNonNegativeCount(input.segmentOrdinal)
    const firstEventSequence = readPositiveCount(input.firstEventSequence)
    const previousSegmentDigest = readOptionalDigest(
      input.previousSegmentDigest,
    )
    const previousRecordMac = readOptionalDigest(input.previousRecordMac)
    if (
      segmentOrdinal === 0
        ? previousSegmentDigest !== null ||
          previousRecordMac !== null ||
          firstEventSequence !== 1
        : previousSegmentDigest === null || previousRecordMac === null
    ) {
      return failInvalidRateEvidence()
    }
    if (
      typeof input.anchorUtc !== 'string' ||
      !isCanonicalTimestamp(input.anchorUtc) ||
      typeof input.appendDurably !== 'function'
    ) {
      return failInvalidRateEvidence()
    }
    return Object.freeze({
      segmentLocatorDigest: readDigest(input.segmentLocatorDigest),
      segmentOrdinal,
      previousSegmentDigest,
      previousRecordMac,
      firstEventSequence,
      anchorUtc: input.anchorUtc,
      monotonicAnchorMilliseconds: readMonotonicTime(
        input.monotonicAnchorMilliseconds,
      ),
      policyVersion: readDigest(input.policyVersion),
      configurationBindingDigest: readDigest(
        input.configurationBindingDigest,
      ),
      authenticationKey: input.authenticationKey,
      appendDurably: input.appendDurably,
    })
  } catch {
    return failInvalidRateEvidence()
  }
}

/** Creates the exact segment header authenticated before the first await. */
function createSegmentHeaderPayload(
  input: RecorderInputSnapshot,
  authenticationKeyFingerprint: string,
): RateSegmentHeaderPayload {
  return Object.freeze({
    kind: rateSegmentHeaderKind,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION,
    authenticationKeyFingerprint,
    segmentLocatorDigest: input.segmentLocatorDigest,
    segmentOrdinal: input.segmentOrdinal,
    previousSegmentDigest: input.previousSegmentDigest,
    previousRecordMac: input.previousRecordMac,
    firstEventSequence: input.firstEventSequence,
    anchorUtc: input.anchorUtc,
    policyVersion: input.policyVersion,
    configurationBindingDigest: input.configurationBindingDigest,
  })
}

/** Converts one existing sanitized controller observation to durable events. */
function convertRateObservation(
  observation: WorkspaceSearchMigrationDescribeTableRateObservation,
): readonly PendingRateEvent[] {
  if (
    observation.version !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION
  ) {
    return failInvalidRateEvidence()
  }
  switch (observation.kind) {
    case 'attempt': {
      const observedAtMilliseconds = readMonotonicTime(
        observation.observedAtMilliseconds,
      )
      const attemptSequence = readPositiveCount(observation.sequence)
      const phase = readPhase(observation.phase)
      return Object.freeze([
        Object.freeze({
          kind: 'attempt-charged',
          attemptSequence,
          phase,
          observedAtMilliseconds,
        }),
        Object.freeze({
          kind: 'attempt-started',
          attemptSequence,
          phase,
          remainingNormalAdmissionAttempts: readNonNegativeCount(
            observation.remainingNormalAdmissionAttempts,
          ),
          remainingWindowAttempts: readNonNegativeCount(
            observation.remainingWindowAttempts,
          ),
          remainingPageAttempts: readNonNegativeCount(
            observation.remainingPageAttempts,
          ),
          inFlight: readOne(observation.inFlight),
          observedAtMilliseconds,
        }),
      ])
    }
    case 'throttle':
      return Object.freeze([Object.freeze({
        kind: 'attempt-throttled',
        attemptSequence: readPositiveCount(observation.sequence),
        phase: readPhase(observation.phase),
        backoffMilliseconds: readNonNegativeCount(
          observation.backoffMilliseconds,
        ),
        provenance: readThrottleProvenance(observation.provenance),
        observedAtMilliseconds: readMonotonicTime(
          observation.observedAtMilliseconds,
        ),
      })])
    case 'budget-stop': {
      const reason = readStopReason(observation.reason)
      const provenance = readBudgetStopProvenance(observation.provenance)
      requireBudgetStopProvenanceMatchesReason(provenance, reason)
      return Object.freeze([Object.freeze({
        kind: 'budget-stop',
        phase: readPhase(observation.phase),
        reason,
        requiredAttempts: readNonNegativeCount(
          observation.requiredAttempts,
        ),
        remainingNormalAdmissionAttempts: readNonNegativeCount(
          observation.remainingNormalAdmissionAttempts,
        ),
        remainingWindowAttempts: readNonNegativeCount(
          observation.remainingWindowAttempts,
        ),
        retryAfterMilliseconds: readNonNegativeCount(
          observation.retryAfterMilliseconds,
        ),
        provenance,
        observedAtMilliseconds: readMonotonicTime(
          observation.observedAtMilliseconds,
        ),
      })])
    }
    case 'cadence-wait':
      return Object.freeze([Object.freeze({
        kind: 'cadence-wait',
        phase: readPhase(observation.phase),
        delayMilliseconds: readPositiveCount(
          observation.delayMilliseconds,
        ),
        observedAtMilliseconds: readMonotonicTime(
          observation.observedAtMilliseconds,
        ),
      })])
  }
}

/** Creates one exact event payload from a queued detached input. */
function createEventPayload(
  event: PendingRateEvent,
  eventSequence: number,
  previousRecordMac: string,
  monotonicAnchorMilliseconds: number,
): RateEventPayload {
  const offsetMilliseconds =
    event.observedAtMilliseconds - monotonicAnchorMilliseconds
  if (
    !Number.isSafeInteger(offsetMilliseconds) ||
    offsetMilliseconds < 0 ||
    offsetMilliseconds > maximumSegmentOffsetMilliseconds
  ) {
    return failInvalidRateEvidence()
  }
  const base: RateEventBase = {
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION,
    eventSequence: readPositiveCount(eventSequence),
    offsetMilliseconds,
    previousRecordMac: readDigest(previousRecordMac),
  }
  switch (event.kind) {
    case 'attempt-charged':
      return Object.freeze({
        ...base,
        kind: event.kind,
        attemptSequence: event.attemptSequence,
        phase: event.phase,
      })
    case 'attempt-forfeited':
      return Object.freeze({
        ...base,
        kind: event.kind,
        attemptSequence: event.attemptSequence,
        phase: event.phase,
        reason: event.reason,
      })
    case 'attempt-started':
      return Object.freeze({
        ...base,
        kind: event.kind,
        attemptSequence: event.attemptSequence,
        phase: event.phase,
        remainingNormalAdmissionAttempts:
          event.remainingNormalAdmissionAttempts,
        remainingWindowAttempts: event.remainingWindowAttempts,
        remainingPageAttempts: event.remainingPageAttempts,
        inFlight: event.inFlight,
      })
    case 'attempt-throttled':
      return Object.freeze({
        ...base,
        kind: event.kind,
        attemptSequence: event.attemptSequence,
        phase: event.phase,
        backoffMilliseconds: event.backoffMilliseconds,
        provenance: event.provenance,
      })
    case 'budget-stop':
      return Object.freeze({
        ...base,
        kind: event.kind,
        phase: event.phase,
        reason: event.reason,
        requiredAttempts: event.requiredAttempts,
        remainingNormalAdmissionAttempts:
          event.remainingNormalAdmissionAttempts,
        remainingWindowAttempts: event.remainingWindowAttempts,
        retryAfterMilliseconds: event.retryAfterMilliseconds,
        provenance: event.provenance,
      })
    case 'cadence-wait':
      return Object.freeze({
        ...base,
        kind: event.kind,
        phase: event.phase,
        delayMilliseconds: event.delayMilliseconds,
      })
    case 'reservation-forfeited':
      return Object.freeze({
        ...base,
        kind: event.kind,
        forfeitedAttemptCount: event.forfeitedAttemptCount,
      })
  }
}

/** Authenticates one parsed segment's bindings and internal record chain. */
function authenticateParsedRateSegment(
  segment: ParsedRateSegment,
  expectedSegmentOrdinal: number,
  expectedPolicyVersion: string,
  expectedConfigurationBindingDigest: string,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const header = segment.header
  if (
    header.segmentOrdinal !== expectedSegmentOrdinal ||
    header.policyVersion !== expectedPolicyVersion ||
    header.configurationBindingDigest !==
      expectedConfigurationBindingDigest
  ) return failInvalidRateEvidence()
  let expectedEventSequence = header.firstEventSequence
  let previousRecordMac = header.mac
  let previousOffsetMilliseconds = -1
  const anchorEpochMilliseconds = Date.parse(header.anchorUtc)
  if (!Number.isSafeInteger(anchorEpochMilliseconds)) {
    return failInvalidRateEvidence()
  }
  for (const event of segment.events) {
    if (
      event.eventSequence !== expectedEventSequence ||
      event.previousRecordMac !== previousRecordMac ||
      event.offsetMilliseconds < previousOffsetMilliseconds ||
      !Number.isSafeInteger(
        anchorEpochMilliseconds + event.offsetMilliseconds,
      )
    ) return failInvalidRateEvidence()
    expectedEventSequence += 1
    previousRecordMac = event.mac
    previousOffsetMilliseconds = event.offsetMilliseconds
  }
  const firstEvent = segment.events[0]
  const lastEvent = segment.events.at(-1)
  return Object.freeze({
    authenticationKeyFingerprint: header.authenticationKeyFingerprint,
    segmentLocatorDigest: header.segmentLocatorDigest,
    segmentOrdinal: header.segmentOrdinal,
    firstEventSequence: header.firstEventSequence,
    eventCount: segment.events.length,
    firstCommittedEventSequence: firstEvent?.eventSequence ?? null,
    lastCommittedEventSequence: lastEvent?.eventSequence ?? null,
    terminalRecordMac: lastEvent?.mac ?? header.mac,
    segmentDigest: segment.segmentDigest,
  })
}

/** Strictly parses and cross-authenticates the complete segment vector. */
function parseAndJoinSegments(
  segmentBytes: readonly Uint8Array[],
  key: Uint8Array,
  expectedPolicyVersion: string,
  expectedConfigurationBindingDigest: string,
): readonly ParsedRateSegment[] {
  const parsed: ParsedRateSegment[] = []
  const locators = new Set<string>()
  let previousSegmentDigest: string | null = null
  let previousRecordMac: string | null = null
  let expectedEventSequence = 1
  let previousAnchorEpochMilliseconds = -1
  let previousEventEpochMilliseconds = -1
  const authenticationKeyFingerprint =
    createRateAuthenticationKeyFingerprint(key)
  let totalByteLength = 0
  let totalEventCount = 0
  for (let index = 0; index < segmentBytes.length; index += 1) {
    const bytes = segmentBytes[index]
    if (bytes === undefined) return failInvalidRateEvidence()
    const segment = parseSegment(bytes, key)
    const header = segment.header
    totalByteLength += segment.byteLength
    totalEventCount += segment.events.length
    if (
      totalByteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_TOTAL_BYTES ||
      totalEventCount > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_EVENTS ||
      header.segmentOrdinal !== index ||
      header.previousSegmentDigest !== previousSegmentDigest ||
      header.previousRecordMac !== previousRecordMac ||
      header.firstEventSequence !== expectedEventSequence ||
      !areDigestsEqual(
        header.authenticationKeyFingerprint,
        authenticationKeyFingerprint,
      ) ||
      header.policyVersion !== expectedPolicyVersion ||
      header.configurationBindingDigest !==
        expectedConfigurationBindingDigest ||
      locators.has(header.segmentLocatorDigest)
    ) {
      return failInvalidRateEvidence()
    }
    const anchorEpochMilliseconds = Date.parse(header.anchorUtc)
    if (
      !Number.isSafeInteger(anchorEpochMilliseconds) ||
      anchorEpochMilliseconds < previousAnchorEpochMilliseconds ||
      anchorEpochMilliseconds < previousEventEpochMilliseconds
    ) {
      return failInvalidRateEvidence()
    }
    locators.add(header.segmentLocatorDigest)
    let eventPreviousMac = header.mac
    let previousOffsetMilliseconds = -1
    for (const event of segment.events) {
      if (
        event.eventSequence !== expectedEventSequence ||
        event.previousRecordMac !== eventPreviousMac ||
        event.offsetMilliseconds < previousOffsetMilliseconds
      ) {
        return failInvalidRateEvidence()
      }
      const eventEpochMilliseconds =
        anchorEpochMilliseconds + event.offsetMilliseconds
      if (
        !Number.isSafeInteger(eventEpochMilliseconds) ||
        eventEpochMilliseconds < previousEventEpochMilliseconds
      ) {
        return failInvalidRateEvidence()
      }
      previousEventEpochMilliseconds = eventEpochMilliseconds
      previousOffsetMilliseconds = event.offsetMilliseconds
      eventPreviousMac = event.mac
      expectedEventSequence += 1
    }
    previousAnchorEpochMilliseconds = anchorEpochMilliseconds
    previousRecordMac = eventPreviousMac
    previousSegmentDigest = segment.segmentDigest
    parsed.push(segment)
  }
  return Object.freeze(parsed)
}

/** Strictly parses one exact canonical LF-delimited segment. */
function parseSegment(
  bytes: Uint8Array,
  key: Uint8Array,
): ParsedRateSegment {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES
  ) {
    return failInvalidRateEvidence()
  }
  const exactBytes = bytes.slice()
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(exactBytes)
  } catch {
    return failInvalidRateEvidence()
  }
  if (!text.endsWith('\n') || text.includes('\r')) {
    return failInvalidRateEvidence()
  }
  const lines = text.slice(0, -1).split('\n')
  if (
    lines.length === 0 ||
    lines.length - 1 >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_EVENTS
  ) {
    return failInvalidRateEvidence()
  }
  for (const line of lines) {
    if (
      line.length === 0 ||
      new TextEncoder().encode(line).byteLength > maximumRateRecordBytes
    ) {
      return failInvalidRateEvidence()
    }
  }
  const headerValue = parseCanonicalLine(lines[0])
  const header = parseHeader(headerValue, key)
  const events: RateEvent[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) return failInvalidRateEvidence()
    events.push(parseEvent(parseCanonicalLine(line), key))
  }
  return Object.freeze({
    header,
    events: Object.freeze(events),
    segmentDigest: createHash('sha256').update(exactBytes).digest('hex'),
    byteLength: exactBytes.byteLength,
  })
}

/** Parses one exact canonical JSON line without accepting whitespace aliases. */
function parseCanonicalLine(line: string): unknown {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return failInvalidRateEvidence()
  }
  if (serializeCanonicalJson(value) !== line) {
    return failInvalidRateEvidence()
  }
  return value
}

/** Strictly parses and authenticates one exact segment header. */
function parseHeader(value: unknown, key: Uint8Array): RateSegmentHeader {
  const record = rateGuards.requireRecord(value)
  rateGuards.requireExactKeys(record, [
    'anchorUtc',
    'authenticationKeyFingerprint',
    'configurationBindingDigest',
    'firstEventSequence',
    'kind',
    'mac',
    'policyVersion',
    'previousRecordMac',
    'previousSegmentDigest',
    'segmentLocatorDigest',
    'segmentOrdinal',
    'version',
  ])
  const anchorUtc = rateGuards.readOwn(record, 'anchorUtc')
  const authenticationKeyFingerprint = readDigest(
    rateGuards.readOwn(record, 'authenticationKeyFingerprint'),
  )
  if (
    rateGuards.readOwn(record, 'kind') !== rateSegmentHeaderKind ||
    rateGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION ||
    typeof anchorUtc !== 'string' ||
    !isCanonicalTimestamp(anchorUtc) ||
    !areDigestsEqual(
      authenticationKeyFingerprint,
      createRateAuthenticationKeyFingerprint(key),
    )
  ) {
    return failInvalidRateEvidence()
  }
  const payload = Object.freeze({
    kind: rateSegmentHeaderKind,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION,
    authenticationKeyFingerprint,
    segmentLocatorDigest: readDigest(
      rateGuards.readOwn(record, 'segmentLocatorDigest'),
    ),
    segmentOrdinal: readNonNegativeCount(
      rateGuards.readOwn(record, 'segmentOrdinal'),
    ),
    previousSegmentDigest: readOptionalDigest(
      rateGuards.readOwn(record, 'previousSegmentDigest'),
    ),
    previousRecordMac: readOptionalDigest(
      rateGuards.readOwn(record, 'previousRecordMac'),
    ),
    firstEventSequence: readPositiveCount(
      rateGuards.readOwn(record, 'firstEventSequence'),
    ),
    anchorUtc,
    policyVersion: readDigest(rateGuards.readOwn(record, 'policyVersion')),
    configurationBindingDigest: readDigest(
      rateGuards.readOwn(record, 'configurationBindingDigest'),
    ),
  }) satisfies RateSegmentHeaderPayload
  const mac = readDigest(rateGuards.readOwn(record, 'mac'))
  if (!areDigestsEqual(mac, createRateRecordMac(key, payload))) {
    return failInvalidRateEvidence()
  }
  return Object.freeze({ ...payload, mac })
}

/** Strictly parses and authenticates one exact durable rate event. */
function parseEvent(value: unknown, key: Uint8Array): RateEvent {
  const record = rateGuards.requireRecord(value)
  const kind = rateGuards.readOwn(record, 'kind')
  const commonKeys = [
    'eventSequence',
    'kind',
    'mac',
    'offsetMilliseconds',
    'previousRecordMac',
    'version',
  ]
  let payload: RateEventPayload
  switch (kind) {
    case 'attempt-charged':
      rateGuards.requireExactKeys(record, [
        ...commonKeys,
        'attemptSequence',
        'phase',
      ])
      payload = Object.freeze({
        ...readEventBase(record),
        kind,
        attemptSequence: readPositiveCount(
          rateGuards.readOwn(record, 'attemptSequence'),
        ),
        phase: readPhase(rateGuards.readOwn(record, 'phase')),
      })
      break
    case 'attempt-forfeited':
      rateGuards.requireExactKeys(record, [
        ...commonKeys,
        'attemptSequence',
        'phase',
        'reason',
      ])
      if (
        rateGuards.readOwn(record, 'reason') !==
          'segment-cutoff-before-durable-start'
      ) {
        return failInvalidRateEvidence()
      }
      payload = Object.freeze({
        ...readEventBase(record),
        kind,
        attemptSequence: readPositiveCount(
          rateGuards.readOwn(record, 'attemptSequence'),
        ),
        phase: readPhase(rateGuards.readOwn(record, 'phase')),
        reason: 'segment-cutoff-before-durable-start',
      })
      break
    case 'attempt-started':
      rateGuards.requireExactKeys(record, [
        ...commonKeys,
        'attemptSequence',
        'inFlight',
        'phase',
        'remainingNormalAdmissionAttempts',
        'remainingPageAttempts',
        'remainingWindowAttempts',
      ])
      payload = Object.freeze({
        ...readEventBase(record),
        kind,
        attemptSequence: readPositiveCount(
          rateGuards.readOwn(record, 'attemptSequence'),
        ),
        phase: readPhase(rateGuards.readOwn(record, 'phase')),
        remainingNormalAdmissionAttempts: readNonNegativeCount(
          rateGuards.readOwn(record, 'remainingNormalAdmissionAttempts'),
        ),
        remainingWindowAttempts: readNonNegativeCount(
          rateGuards.readOwn(record, 'remainingWindowAttempts'),
        ),
        remainingPageAttempts: readNonNegativeCount(
          rateGuards.readOwn(record, 'remainingPageAttempts'),
        ),
        inFlight: readOne(rateGuards.readOwn(record, 'inFlight')),
      })
      break
    case 'attempt-throttled':
      rateGuards.requireExactKeys(record, [
        ...commonKeys,
        'attemptSequence',
        'backoffMilliseconds',
        'phase',
        'provenance',
      ])
      payload = Object.freeze({
        ...readEventBase(record),
        kind,
        attemptSequence: readPositiveCount(
          rateGuards.readOwn(record, 'attemptSequence'),
        ),
        phase: readPhase(rateGuards.readOwn(record, 'phase')),
        backoffMilliseconds: readPositiveCount(
          rateGuards.readOwn(record, 'backoffMilliseconds'),
        ),
        provenance: readThrottleProvenance(
          rateGuards.readOwn(record, 'provenance'),
        ),
      })
      break
    case 'budget-stop':
      rateGuards.requireExactKeys(record, [
        ...commonKeys,
        'phase',
        'reason',
        'remainingNormalAdmissionAttempts',
        'remainingWindowAttempts',
        'requiredAttempts',
        'retryAfterMilliseconds',
        'provenance',
      ])
      const reason = readStopReason(rateGuards.readOwn(record, 'reason'))
      const provenance = readBudgetStopProvenance(
        rateGuards.readOwn(record, 'provenance'),
      )
      requireBudgetStopProvenanceMatchesReason(provenance, reason)
      payload = Object.freeze({
        ...readEventBase(record),
        kind,
        phase: readPhase(rateGuards.readOwn(record, 'phase')),
        reason,
        requiredAttempts: readNonNegativeCount(
          rateGuards.readOwn(record, 'requiredAttempts'),
        ),
        remainingNormalAdmissionAttempts: readNonNegativeCount(
          rateGuards.readOwn(record, 'remainingNormalAdmissionAttempts'),
        ),
        remainingWindowAttempts: readNonNegativeCount(
          rateGuards.readOwn(record, 'remainingWindowAttempts'),
        ),
        retryAfterMilliseconds: readNonNegativeCount(
          rateGuards.readOwn(record, 'retryAfterMilliseconds'),
        ),
        provenance,
      })
      break
    case 'cadence-wait':
      rateGuards.requireExactKeys(record, [
        ...commonKeys,
        'delayMilliseconds',
        'phase',
      ])
      payload = Object.freeze({
        ...readEventBase(record),
        kind,
        phase: readPhase(rateGuards.readOwn(record, 'phase')),
        delayMilliseconds: readPositiveCount(
          rateGuards.readOwn(record, 'delayMilliseconds'),
        ),
      })
      break
    case 'reservation-forfeited':
      rateGuards.requireExactKeys(record, [
        ...commonKeys,
        'forfeitedAttemptCount',
      ])
      payload = Object.freeze({
        ...readEventBase(record),
        kind,
        forfeitedAttemptCount: readPositiveCount(
          rateGuards.readOwn(record, 'forfeitedAttemptCount'),
        ),
      })
      break
    default:
      return failInvalidRateEvidence()
  }
  const mac = readDigest(rateGuards.readOwn(record, 'mac'))
  if (!areDigestsEqual(mac, createRateRecordMac(key, payload))) {
    return failInvalidRateEvidence()
  }
  return Object.freeze({ ...payload, mac })
}

/** Reads and validates common event fields. */
function readEventBase(record: object): RateEventBase {
  if (
    rateGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION
  ) {
    return failInvalidRateEvidence()
  }
  const offsetMilliseconds = readNonNegativeCount(
    rateGuards.readOwn(record, 'offsetMilliseconds'),
  )
  if (offsetMilliseconds > maximumSegmentOffsetMilliseconds) {
    return failInvalidRateEvidence()
  }
  return Object.freeze({
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION,
    eventSequence: readPositiveCount(
      rateGuards.readOwn(record, 'eventSequence'),
    ),
    offsetMilliseconds,
    previousRecordMac: readDigest(
      rateGuards.readOwn(record, 'previousRecordMac'),
    ),
  })
}

/** Recalculates all identifier-free counts and lifecycle consistency. */
function aggregateRateEvents(
  segments: readonly ParsedRateSegment[],
): RateAggregationState {
  const state: RateAggregationState = {
    attemptCount: 0,
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
    maximumInFlight: 0,
    pendingAttemptSequence: null,
    pendingAttemptChargedAtEpochMilliseconds: null,
    nextAttemptSequence: 1,
    startedAttemptSequences: new Set<number>(),
    throttledAttemptSequences: new Set<number>(),
    pendingThrottleProvenance: null,
    lastStartedAttemptSequence: null,
    attemptStartedAtEpochMilliseconds: [],
  }
  for (const segment of segments) {
    const anchorEpochMilliseconds = Date.parse(segment.header.anchorUtc)
    for (const event of segment.events) {
      if (
        state.pendingAttemptSequence !== null &&
        event.kind !== 'attempt-started' &&
        event.kind !== 'attempt-forfeited'
      ) {
        return failInvalidRateEvidence()
      }
      if (
        state.pendingThrottleProvenance !== null &&
        event.kind !== 'budget-stop' &&
        event.kind !== 'cadence-wait'
      ) {
        return failInvalidRateEvidence()
      }
      switch (event.kind) {
        case 'attempt-charged':
          if (
            state.pendingAttemptSequence !== null ||
            event.attemptSequence !== state.nextAttemptSequence
          ) {
            return failInvalidRateEvidence()
          }
          state.pendingAttemptSequence = event.attemptSequence
          state.pendingAttemptChargedAtEpochMilliseconds =
            anchorEpochMilliseconds + event.offsetMilliseconds
          state.nextAttemptSequence += 1
          state.attemptCount = addBoundedCounts(state.attemptCount, 1)
          state.maximumInFlight = 1
          break
        case 'attempt-started':
          if (
            state.pendingAttemptSequence !== event.attemptSequence ||
            state.startedAttemptSequences.has(event.attemptSequence)
          ) {
            return failInvalidRateEvidence()
          }
          state.pendingAttemptSequence = null
          state.pendingAttemptChargedAtEpochMilliseconds = null
          state.startedAttemptSequences.add(event.attemptSequence)
          state.lastStartedAttemptSequence = event.attemptSequence
          state.attemptStartedAtEpochMilliseconds.push(
            anchorEpochMilliseconds + event.offsetMilliseconds,
          )
          break
        case 'attempt-forfeited':
          if (
            state.pendingAttemptSequence !== event.attemptSequence ||
            state.pendingAttemptChargedAtEpochMilliseconds === null
          ) {
            return failInvalidRateEvidence()
          }
          state.pendingAttemptSequence = null
          state.pendingAttemptChargedAtEpochMilliseconds = null
          break
        case 'attempt-throttled':
          if (
            state.lastStartedAttemptSequence !== event.attemptSequence ||
            !state.startedAttemptSequences.has(event.attemptSequence) ||
            state.throttledAttemptSequences.has(event.attemptSequence)
          ) {
            return failInvalidRateEvidence()
          }
          state.throttledAttemptSequences.add(event.attemptSequence)
          state.throttleCount = addBoundedCounts(state.throttleCount, 1)
          if (event.provenance === 'aws-service') {
            state.awsServiceThrottleCount = addBoundedCounts(
              state.awsServiceThrottleCount,
              1,
            )
          } else {
            state.rehearsalInjectedThrottleCount = addBoundedCounts(
              state.rehearsalInjectedThrottleCount,
              1,
            )
          }
          state.pendingThrottleProvenance = event.provenance
          break
        case 'reservation-forfeited':
          state.forfeitedAttemptCount = addBoundedCounts(
            state.forfeitedAttemptCount,
            event.forfeitedAttemptCount,
          )
          break
        case 'budget-stop':
          if (
            event.provenance === 'operational'
              ? state.pendingThrottleProvenance !== null
              : state.pendingThrottleProvenance === null ||
                !doesBudgetStopCloseThrottle(
                  event.provenance,
                  state.pendingThrottleProvenance,
                )
          ) {
            return failInvalidRateEvidence()
          }
          state.budgetStopCount = addBoundedCounts(
            state.budgetStopCount,
            1,
          )
          switch (event.provenance) {
            case 'operational':
              state.operationalBudgetStopCount = addBoundedCounts(
                state.operationalBudgetStopCount,
                1,
              )
              break
            case 'aws-service-throttle':
              state.awsServiceThrottleBudgetStopCount = addBoundedCounts(
                state.awsServiceThrottleBudgetStopCount,
                1,
              )
              break
            case 'rehearsal-after-success-injection':
              state.rehearsalInjectedBudgetStopCount = addBoundedCounts(
                state.rehearsalInjectedBudgetStopCount,
                1,
              )
              break
          }
          state.pendingThrottleProvenance = null
          break
        case 'cadence-wait':
          state.cadenceWaitCount = addBoundedCounts(
            state.cadenceWaitCount,
            1,
          )
          state.cadenceWaitMilliseconds = addBoundedCounts(
            state.cadenceWaitMilliseconds,
            event.delayMilliseconds,
          )
          break
      }
    }
  }
  if (
    state.pendingAttemptSequence !== null ||
    state.pendingAttemptChargedAtEpochMilliseconds !== null ||
    state.pendingThrottleProvenance !== null ||
    state.attemptCount < 1 ||
    state.attemptStartedAtEpochMilliseconds.length < 1 ||
    state.throttleCount !== addBoundedCounts(
      state.awsServiceThrottleCount,
      state.rehearsalInjectedThrottleCount,
    ) ||
    state.budgetStopCount !== addBoundedCounts(
      addBoundedCounts(
        state.operationalBudgetStopCount,
        state.awsServiceThrottleBudgetStopCount,
      ),
      state.rehearsalInjectedBudgetStopCount,
    )
  ) {
    return failInvalidRateEvidence()
  }
  return state
}

/** Creates the exact evidence aggregate consumed by the top-level index. */
function createRateAggregate(
  state: RateAggregationState,
  policyVersion: string,
): WorkspaceSearchMigrationRehearsalRateAggregate {
  if (state.maximumInFlight !== 1) return failInvalidRateEvidence()
  return Object.freeze({
    version: WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion,
    attemptCount: state.attemptCount,
    forfeitedAttemptCount: state.forfeitedAttemptCount,
    throttleCount: state.throttleCount,
    awsServiceThrottleCount: state.awsServiceThrottleCount,
    rehearsalInjectedThrottleCount: state.rehearsalInjectedThrottleCount,
    budgetStopCount: state.budgetStopCount,
    operationalBudgetStopCount: state.operationalBudgetStopCount,
    awsServiceThrottleBudgetStopCount:
      state.awsServiceThrottleBudgetStopCount,
    rehearsalInjectedBudgetStopCount:
      state.rehearsalInjectedBudgetStopCount,
    cadenceWaitCount: state.cadenceWaitCount,
    cadenceWaitMilliseconds: state.cadenceWaitMilliseconds,
    maximumInFlight: state.maximumInFlight,
  })
}

/** Strictly parses one authenticated segment's secret-free summary. */
function readVerifiedRateSegmentSummary(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegment {
  const record = rateGuards.requireRecord(value)
  rateGuards.requireExactKeys(record, [
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
  const segmentOrdinal = readNonNegativeCount(
    rateGuards.readOwn(record, 'segmentOrdinal'),
  )
  const eventCount = readNonNegativeCount(
    rateGuards.readOwn(record, 'eventCount'),
  )
  if (
    segmentOrdinal >=
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENTS ||
    eventCount > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_EVENTS
  ) return failInvalidRateEvidence()
  const firstEventSequence = readPositiveCount(
    rateGuards.readOwn(record, 'firstEventSequence'),
  )
  const firstCommittedEventSequence = readOptionalPositiveCount(
    rateGuards.readOwn(record, 'firstCommittedEventSequence'),
  )
  const lastCommittedEventSequence = readOptionalPositiveCount(
    rateGuards.readOwn(record, 'lastCommittedEventSequence'),
  )
  if (
    eventCount === 0
      ? firstCommittedEventSequence !== null ||
        lastCommittedEventSequence !== null
      : firstCommittedEventSequence === null ||
        lastCommittedEventSequence === null ||
        firstCommittedEventSequence !== firstEventSequence ||
        lastCommittedEventSequence - firstEventSequence + 1 !== eventCount
  ) return failInvalidRateEvidence()
  return Object.freeze({
    authenticationKeyFingerprint: readDigest(
      rateGuards.readOwn(record, 'authenticationKeyFingerprint'),
    ),
    segmentLocatorDigest: readDigest(
      rateGuards.readOwn(record, 'segmentLocatorDigest'),
    ),
    segmentOrdinal,
    firstEventSequence,
    eventCount,
    firstCommittedEventSequence,
    lastCommittedEventSequence,
    terminalRecordMac: readDigest(
      rateGuards.readOwn(record, 'terminalRecordMac'),
    ),
    segmentDigest: readDigest(
      rateGuards.readOwn(record, 'segmentDigest'),
    ),
  })
}

/** Strictly parses one authenticated successor-header link projection. */
function readVerifiedRateSegmentLink(
  value: unknown,
): WorkspaceSearchMigrationRehearsalVerifiedRateSegmentLink {
  const record = rateGuards.requireRecord(value)
  rateGuards.requireExactKeys(record, [
    'configurationBindingDigest',
    'firstEventSequence',
    'policyVersion',
    'previousRecordMac',
    'previousSegmentDigest',
  ])
  return Object.freeze({
    previousSegmentDigest: readDigest(
      rateGuards.readOwn(record, 'previousSegmentDigest'),
    ),
    previousRecordMac: readDigest(
      rateGuards.readOwn(record, 'previousRecordMac'),
    ),
    firstEventSequence: readPositiveCount(
      rateGuards.readOwn(record, 'firstEventSequence'),
    ),
    policyVersion: readDigest(rateGuards.readOwn(record, 'policyVersion')),
    configurationBindingDigest: readDigest(
      rateGuards.readOwn(record, 'configurationBindingDigest'),
    ),
  })
}

/** Strictly parses the independent durable ledger aggregate. */
function readDurableEvidence(
  value: unknown,
  expectedPolicyVersion: string,
): WorkspaceSearchMigrationDescribeTableRateEvidence {
  const record = rateGuards.requireRecord(value)
  rateGuards.requireExactKeys(record, [
    'attemptCount',
    'awsServiceThrottleBudgetStopCount',
    'awsServiceThrottleCount',
    'budgetStopCount',
    'cadenceWaitCount',
    'cadenceWaitMilliseconds',
    'forfeitedAttemptCount',
    'maximumInFlight',
    'operationalBudgetStopCount',
    'policyVersion',
    'rehearsalInjectedBudgetStopCount',
    'rehearsalInjectedThrottleCount',
    'throttleCount',
    'version',
  ])
  const maximumInFlight = rateGuards.readOwn(record, 'maximumInFlight')
  if (
    rateGuards.readOwn(record, 'version') !==
      WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION ||
    rateGuards.readOwn(record, 'policyVersion') !== expectedPolicyVersion ||
    (maximumInFlight !== 0 && maximumInFlight !== 1)
  ) {
    return failInvalidRateEvidence()
  }
  const throttleCount = readNonNegativeCount(
    rateGuards.readOwn(record, 'throttleCount'),
  )
  const awsServiceThrottleCount = readNonNegativeCount(
    rateGuards.readOwn(record, 'awsServiceThrottleCount'),
  )
  const rehearsalInjectedThrottleCount = readNonNegativeCount(
    rateGuards.readOwn(record, 'rehearsalInjectedThrottleCount'),
  )
  const budgetStopCount = readNonNegativeCount(
    rateGuards.readOwn(record, 'budgetStopCount'),
  )
  const operationalBudgetStopCount = readNonNegativeCount(
    rateGuards.readOwn(record, 'operationalBudgetStopCount'),
  )
  const awsServiceThrottleBudgetStopCount = readNonNegativeCount(
    rateGuards.readOwn(record, 'awsServiceThrottleBudgetStopCount'),
  )
  const rehearsalInjectedBudgetStopCount = readNonNegativeCount(
    rateGuards.readOwn(record, 'rehearsalInjectedBudgetStopCount'),
  )
  if (
    throttleCount !== addBoundedCounts(
      awsServiceThrottleCount,
      rehearsalInjectedThrottleCount,
    ) ||
    budgetStopCount !== addBoundedCounts(
      addBoundedCounts(
        operationalBudgetStopCount,
        awsServiceThrottleBudgetStopCount,
      ),
      rehearsalInjectedBudgetStopCount,
    )
  ) return failInvalidRateEvidence()
  return Object.freeze({
    version: WORKSPACE_SEARCH_MIGRATION_DESCRIBE_TABLE_RATE_OBSERVATION_VERSION,
    policyVersion: expectedPolicyVersion,
    attemptCount: readPositiveCount(
      rateGuards.readOwn(record, 'attemptCount'),
    ),
    forfeitedAttemptCount: readNonNegativeCount(
      rateGuards.readOwn(record, 'forfeitedAttemptCount'),
    ),
    throttleCount,
    awsServiceThrottleCount,
    rehearsalInjectedThrottleCount,
    budgetStopCount,
    operationalBudgetStopCount,
    awsServiceThrottleBudgetStopCount,
    rehearsalInjectedBudgetStopCount,
    cadenceWaitCount: readNonNegativeCount(
      rateGuards.readOwn(record, 'cadenceWaitCount'),
    ),
    cadenceWaitMilliseconds: readNonNegativeCount(
      rateGuards.readOwn(record, 'cadenceWaitMilliseconds'),
    ),
    maximumInFlight,
  })
}

/** Requires exact equality between event-derived and durable ledger counts. */
function requireDurableAggregateMatch(
  aggregate: WorkspaceSearchMigrationRehearsalRateAggregate,
  durable: WorkspaceSearchMigrationDescribeTableRateEvidence,
): void {
  if (serializeCanonicalJson(aggregate) !== serializeCanonicalJson(durable)) {
    return failInvalidRateEvidence()
  }
}

/** Calculates the largest number of physical starts in any 1,000 ms window. */
function calculateMaximumAttemptStartRate(
  startedAt: readonly number[],
): number {
  let maximum = 0
  let windowStart = 0
  for (let windowEnd = 0; windowEnd < startedAt.length; windowEnd += 1) {
    const end = startedAt[windowEnd]
    if (end === undefined) return failInvalidRateEvidence()
    while (windowStart <= windowEnd) {
      const start = startedAt[windowStart]
      if (start === undefined) return failInvalidRateEvidence()
      if (end - start < 1_000) break
      windowStart += 1
    }
    maximum = Math.max(maximum, windowEnd - windowStart + 1)
  }
  return maximum
}

/** Creates a deeply frozen normalized complete stream artifact. */
function createRateArtifact(
  segments: readonly ParsedRateSegment[],
  policyVersion: string,
  configurationBindingDigest: string,
): RateArtifact {
  const artifactSegments = segments.map((segment) => Object.freeze({
    header: segment.header,
    events: segment.events,
  }))
  return Object.freeze({
    kind: rateArtifactKind,
    version: WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_SEGMENT_VERSION,
    policyVersion,
    configurationBindingDigest,
    segments: Object.freeze(artifactSegments),
  })
}

/** Reads and defensively copies the bounded exact segment vector. */
function readSegmentVector(value: readonly Uint8Array[]): readonly Uint8Array[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENTS
  ) {
    return failInvalidRateEvidence()
  }
  const segments: Uint8Array[] = []
  let byteLength = 0
  for (const candidate of value) {
    if (!(candidate instanceof Uint8Array)) {
      return failInvalidRateEvidence()
    }
    const copy = candidate.slice()
    byteLength += copy.byteLength
    if (
      copy.byteLength === 0 ||
      copy.byteLength >
        WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES ||
      byteLength > WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_TOTAL_BYTES
    ) {
      return failInvalidRateEvidence()
    }
    segments.push(copy)
  }
  return Object.freeze(segments)
}

/** Copies one bounded predecessor file before complete-prefix recovery. */
function copyRecoverableSegmentBytes(value: Uint8Array): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength === 0 ||
    value.byteLength >
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_MAX_SEGMENT_BYTES
  ) {
    return failInvalidRateEvidence()
  }
  return value.slice()
}

/** Calls the injected durable sink without reflecting untrusted failures. */
async function callDurableAppend(
  appendDurably: WorkspaceSearchMigrationRehearsalRateDurableAppend,
  bytes: Uint8Array,
): Promise<void> {
  await Reflect.apply(appendDurably, undefined, [bytes.slice()])
}

/** Serializes one exact record as canonical UTF-8 plus exactly one LF. */
function encodeRateRecord(record: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(`${serializeCanonicalJson(record)}\n`)
  if (bytes.byteLength > maximumRateRecordBytes) {
    return failInvalidRateEvidence()
  }
  return bytes
}

/** Creates a domain-separated HMAC for one record without its MAC field. */
function createRateRecordMac(key: Uint8Array, payload: unknown): string {
  return createHmac('sha256', key)
    .update(rateRecordMacDomain, 'utf8')
    .update('\0', 'utf8')
    .update(serializeCanonicalJson(payload), 'utf8')
    .digest('hex')
}

/** Creates the domain-separated secret-free locator of one validated key. */
function createRateAuthenticationKeyFingerprint(key: Uint8Array): string {
  return createHmac('sha256', key)
    .update(rateAuthenticationKeyFingerprintDomain, 'utf8')
    .digest('hex')
}

/** Copies and validates a dedicated authentication key. */
function copyAuthenticationKey(value: Uint8Array): Uint8Array {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !==
      WORKSPACE_SEARCH_MIGRATION_REHEARSAL_RATE_KEY_BYTES
  ) {
    return failInvalidRateEvidence()
  }
  return value.slice()
}

/** Concatenates confirmed canonical chunks without exposing internal buffers. */
function concatenateByteChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const byteLength = chunks.reduce(
    (count, chunk) => count + chunk.byteLength,
    0,
  )
  const combined = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined
}

/** Reads one conventional lowercase SHA-256 digest. */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) return failInvalidRateEvidence()
  return value
}

/** Reads a digest-or-null segment chain field. */
function readOptionalDigest(value: unknown): string | null {
  return value === null ? null : readDigest(value)
}

/** Reads a non-negative bounded safe integer. */
function readNonNegativeCount(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > maximumRateCount
  ) {
    return failInvalidRateEvidence()
  }
  return value
}

/** Reads a positive bounded safe integer. */
function readPositiveCount(value: unknown): number {
  const count = readNonNegativeCount(value)
  if (count < 1) return failInvalidRateEvidence()
  return count
}

/** Reads a positive bounded safe integer or the exact null sentinel. */
function readOptionalPositiveCount(value: unknown): number | null {
  return value === null ? null : readPositiveCount(value)
}

/** Reads one non-negative trusted process-monotonic timestamp. */
function readMonotonicTime(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return failInvalidRateEvidence()
  }
  return value
}

/** Reads the exact literal in-flight count carried by attempt observations. */
function readOne(value: unknown): 1 {
  if (value !== 1) return failInvalidRateEvidence()
  return 1
}

/** Reads one exact identifier-free rate phase. */
function readPhase(value: unknown): WorkspaceSearchMigrationDescribeTablePhase {
  switch (value) {
    case 'measurement':
    case 'checkpoint-page':
    case 'integrity-check':
    case 'pre-send-guard':
    case 'post-send-guard':
    case 'reconciliation':
      return value
    default:
      return failInvalidRateEvidence()
  }
}

/** Reads one exact identifier-free stop classification. */
function readStopReason(
  value: unknown,
): WorkspaceSearchMigrationDescribeTableRateStopReason {
  switch (value) {
    case 'budget-capacity':
    case 'cadence-bound':
    case 'interrupted':
    case 'invalid-lifecycle':
    case 'page-capacity':
    case 'quarantined':
    case 'throttled':
    case 'taken-over':
      return value
    default:
      return failInvalidRateEvidence()
  }
}

/**
 * Reads one exact source classification for a throttled physical attempt.
 *
 * @param value - Candidate provenance from a controller observation or record.
 * @returns Validated finite physical-throttle provenance.
 */
function readThrottleProvenance(
  value: unknown,
): WorkspaceSearchMigrationDescribeTableThrottleProvenance {
  switch (value) {
    case 'aws-service':
    case 'rehearsal-after-success-injection':
      return value
    default:
      return failInvalidRateEvidence()
  }
}

/**
 * Reads one exact operational or throttle-derived budget-stop provenance.
 *
 * @param value - Candidate provenance from a controller observation or record.
 * @returns Validated finite budget-stop provenance.
 */
function readBudgetStopProvenance(
  value: unknown,
): WorkspaceSearchMigrationDescribeTableBudgetStopProvenance {
  switch (value) {
    case 'operational':
    case 'aws-service-throttle':
    case 'rehearsal-after-success-injection':
      return value
    default:
      return failInvalidRateEvidence()
  }
}

/**
 * Requires a stop reason to agree with its explicit source classification.
 *
 * @param provenance - Validated explicit stop source.
 * @param reason - Validated stable admission-stop reason.
 */
function requireBudgetStopProvenanceMatchesReason(
  provenance: WorkspaceSearchMigrationDescribeTableBudgetStopProvenance,
  reason: WorkspaceSearchMigrationDescribeTableRateStopReason,
): void {
  if (
    (provenance === 'operational' && reason === 'throttled') ||
    (provenance !== 'operational' && reason !== 'throttled')
  ) return failInvalidRateEvidence()
}

/**
 * Returns whether one throttle-derived stop closes the same source event.
 *
 * @param budgetStopProvenance - Validated throttle-derived stop source.
 * @param throttleProvenance - Pending physical-throttle source.
 * @returns Whether both classifications describe the same causal throttle.
 */
function doesBudgetStopCloseThrottle(
  budgetStopProvenance:
    WorkspaceSearchMigrationDescribeTableBudgetStopProvenance,
  throttleProvenance:
    WorkspaceSearchMigrationDescribeTableThrottleProvenance,
): boolean {
  return throttleProvenance === 'aws-service'
    ? budgetStopProvenance === 'aws-service-throttle'
    : budgetStopProvenance === 'rehearsal-after-success-injection'
}

/** Adds two bounded counts without permitting safe-integer overflow. */
function addBoundedCounts(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total) || total > maximumRateCount) {
    return failInvalidRateEvidence()
  }
  return total
}

/** Compares two validated SHA-256 or HMAC digests in constant time. */
function areDigestsEqual(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

/** Throws the stable identifier-free malformed-evidence failure. */
function failInvalidRateEvidence(): never {
  throw new Error(invalidRateEvidenceMessage)
}
