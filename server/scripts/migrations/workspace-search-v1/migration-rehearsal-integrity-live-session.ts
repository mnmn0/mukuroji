import { timingSafeEqual } from 'node:crypto'
import { types as nodeUtilTypes } from 'node:util'
import type {
  DescribeTableCommand,
  DescribeTableCommandOutput,
  ScanCommand,
  ScanCommandOutput,
} from '@aws-sdk/client-dynamodb'
import type {
  GetBucketVersioningCommand,
  GetBucketVersioningCommandOutput,
  GetObjectAttributesCommand,
  GetObjectAttributesCommandOutput,
  GetObjectTaggingCommand,
  GetObjectTaggingCommandOutput,
  HeadObjectCommand,
  HeadObjectCommandOutput,
} from '@aws-sdk/client-s3'
import type {
  GetCallerIdentityCommand,
  GetCallerIdentityCommandOutput,
} from '@aws-sdk/client-sts'
import {
  calculateCrossDomainIntegrityResourceBindingDigest,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  createCrossDomainIntegrityInvocationDeadline,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_MAX_DURATION_MILLISECONDS,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
  disposeCrossDomainIntegrityInvocationDeadline,
  parseCrossDomainIntegrityResourceAttestation,
  requireCrossDomainIntegrityInvocationDeadline,
  runCrossDomainIntegrityRequestWithinDeadline,
  serializeCrossDomainIntegrityResourceAttestation,
  validateCrossDomainIntegrityLimits,
  type CrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceIdentity,
  type CrossDomainIntegrityResult,
} from '../../data-integrity/cross-domain-integrity'
import {
  runCrossDomainIntegrityAwsCheck,
} from '../../data-integrity/cross-domain-integrity-aws'
import {
  AwsCrossDomainIntegrityReader,
  type CrossDomainIntegrityAwsTransport,
  type CrossDomainIntegrityBucketNames,
  type CrossDomainIntegrityTableNames,
} from '../../data-integrity/verify-cross-domain-integrity'
import {
  createMigrationDigest,
} from './migration-contract'
import type {
  WorkspaceSearchMigrationManagedDescribeTableRate,
} from './migration-describe-table-rate-managed-session'
import {
  createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
  type WorkspaceSearchMigrationRehearsalIntegrityRateAdapter,
  type WorkspaceSearchMigrationRehearsalIntegrityRateSequence,
} from './migration-rehearsal-integrity-rate-adapter'
import {
  finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
  verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval,
  type WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult,
} from './migration-rehearsal-integrity-rate-evidence'
import {
  WorkspaceSearchMigrationStrictRecordGuards,
} from './migration-strict-record-guards'

/** Maximum page size accepted by the production #163 checker. */
const maximumPageSize = 1_000

/** Maximum total page count accepted by the production #163 checker. */
const maximumPageCount = 10_000

/** Maximum total item count accepted by the production #163 checker. */
const maximumItemCount = 1_000_000

/** Exact byte length of every transferred HMAC key. */
const digestKeyByteLength = 32

/** Stable raw-value-free live-session failure. */
const invalidIntegrityLiveSessionMessage =
  'INVALID_REHEARSAL_INTEGRITY_LIVE_SESSION'

/** Exact top-level fields accepted by one live checker invocation. */
const liveSessionInputKeys = Object.freeze([
  'account',
  'auditPseudonymKey',
  'buckets',
  'expectedResourceIdentityDigest',
  'integrityDigestKey',
  'maxItems',
  'maxPages',
  'maximumDurationMilliseconds',
  'monotonicClock',
  'pageSize',
  'profile',
  'rate',
  'region',
  'resourceAttestationBytes',
  'role',
  'tables',
  'transport',
  'wallClock',
])

/** Exact fields accepted when sealing one completed live checker. */
const liveSessionFinalizerInputKeys = Object.freeze([
  'canonicalSegmentBytes',
  'expectedConfigurationBindingDigest',
  'expectedPolicyVersion',
  'pending',
  'predecessorSegmentBytes',
  'rateAuthenticationKey',
])

/** Required methods of the caller-owned read-only AWS transport. */
const transportMethodNames = Object.freeze([
  'close',
  'getBucketVersioning',
  'getObjectAttributes',
  'getObjectTagging',
  'headObject',
  'readCallerIdentity',
  'scan',
])

/** Required methods of the shared managed DescribeTable rate owner. */
const managedRateMethodNames = Object.freeze([
  'assertNewDataIoAllowed',
  'claimAfterLease',
  'close',
  'closeAndReadEvidence',
  'describeTable',
  'interrupt',
  'quarantine',
  'readEvidence',
  'runCheckpointPage',
  'runMandatoryCleanup',
  'runNonPageOperation',
  'runWithMutationAdmissionGuard',
])

/** Strict production inputs for one actual live #163 checker invocation. */
export type RunWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput = {
  /** Exact expected AWS account identifier. */
  readonly account: string
  /** Caller-owned Workspace Audit pseudonym key transferred to this invocation. */
  readonly auditPseudonymKey: Uint8Array
  /** Complete exact File bucket allowlist. */
  readonly buckets: CrossDomainIntegrityBucketNames
  /** Expected keyed digest of the immutable seven-resource identity vector. */
  readonly expectedResourceIdentityDigest: string
  /** Caller-owned dedicated #163 result key transferred to this session. */
  readonly integrityDigestKey: Uint8Array
  /** Total normalized checker item bound. */
  readonly maxItems: number
  /** Total DynamoDB scan-page bound. */
  readonly maxPages: number
  /** Non-resettable invocation duration bound in milliseconds. */
  readonly maximumDurationMilliseconds: number
  /** Trusted non-negative process-monotonic clock. */
  readonly monotonicClock: () => number
  /** Fixed DynamoDB Scan item limit. */
  readonly pageSize: number
  /** Explicit shared-configuration credential profile. */
  readonly profile: string
  /** Shared managed maxAttempts=1 DescribeTable rate owner. */
  readonly rate: WorkspaceSearchMigrationManagedDescribeTableRate
  /** Exact AWS Region containing every selected resource. */
  readonly region: string
  /** Exact canonical owner-only immutable resource-attestation file bytes. */
  readonly resourceAttestationBytes: Uint8Array
  /** Protected source role required by migration rehearsal checks. */
  readonly role: 'source'
  /** Optional caller cancellation shared by every bounded external read. */
  readonly signal?: AbortSignal
  /** Complete exact six-table #163 allowlist. */
  readonly tables: CrossDomainIntegrityTableNames
  /** Borrowed non-DescribeTable AWS transport owned by the outer session. */
  readonly transport:
    WorkspaceSearchMigrationRehearsalIntegrityLiveReadTransport
  /** Trusted canonical wall clock for start, completion, and sealing. */
  readonly wallClock: () => Date
}

/** Borrowed AWS transport without any unmanaged DescribeTable authority. */
export type WorkspaceSearchMigrationRehearsalIntegrityLiveReadTransport = Pick<
  CrossDomainIntegrityAwsTransport,
  | 'close'
  | 'getBucketVersioning'
  | 'getObjectAttributes'
  | 'getObjectTagging'
  | 'headObject'
  | 'readCallerIdentity'
  | 'scan'
>

/** Inputs that bind one pending live result to its raw authenticated rate segment. */
export type FinalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput = {
  /** Exact canonical bytes of the segment containing this live checker. */
  readonly canonicalSegmentBytes: Uint8Array
  /** Measured session/configuration digest authenticated by the segment. */
  readonly expectedConfigurationBindingDigest: string
  /** Reviewed durable DescribeTable policy digest authenticated by the segment. */
  readonly expectedPolicyVersion: string
  /** Genuine one-shot pending capability returned by the live runner. */
  readonly pending: WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending
  /** Exact canonical bytes of the immediate authenticated predecessor. */
  readonly predecessorSegmentBytes: Uint8Array
  /** Caller-owned runtime rate authentication key transferred for sealing. */
  readonly rateAuthenticationKey: Uint8Array
}

/** Stable live-session error that never includes AWS data or secret material. */
export class WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError
  extends Error {
  /** Stable machine-readable failure code. */
  readonly code = invalidIntegrityLiveSessionMessage

  /** Creates the sole public live-session failure. */
  constructor() {
    super(invalidIntegrityLiveSessionMessage)
    this.name = 'WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError'
  }
}

const pendingCapabilityToken = Symbol(
  'workspace-search-migration-rehearsal-integrity-live-session-pending',
)

/** Opaque one-shot authority for one causally executed actual #163 checker. */
export class WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending {
  /**
   * Constructs only capabilities minted by the actual live-session runner.
   *
   * @param token - Module-private construction authority.
   */
  constructor(token: symbol) {
    if (token !== pendingCapabilityToken) {
      throw new TypeError('Invalid integrity live-session capability.')
    }
    Object.freeze(this)
  }
}

/** Monotonic trusted wall-clock sampler retained across run and finalization. */
type TrustedWallClock = {
  /** Samples one canonical non-regressing UTC timestamp. */
  readonly sampleTimestamp: () => string
  /** Samples one detached non-regressing Date for downstream authentication. */
  readonly sampleDate: () => Date
}

/** Fully detached live invocation state validated before the first AWS read. */
type IntegrityLiveSessionSnapshot = {
  /** Exact expected AWS account identifier. */
  readonly account: string
  /** Detached Workspace Audit pseudonym key. */
  readonly auditPseudonymKey: Uint8Array
  /** Detached exact File bucket allowlist. */
  readonly buckets: CrossDomainIntegrityBucketNames
  /** Expected immutable seven-resource identity digest. */
  readonly expectedResourceIdentityDigest: string
  /** Detached dedicated #163 result HMAC key. */
  readonly integrityDigestKey: Uint8Array
  /** Total normalized checker item bound. */
  readonly maxItems: number
  /** Total scan-page bound. */
  readonly maxPages: number
  /** Total non-resettable deadline in milliseconds. */
  readonly maximumDurationMilliseconds: number
  /** Captured trusted monotonic clock. */
  readonly monotonicClock: () => number
  /** Fixed scan page size. */
  readonly pageSize: number
  /** Exact shared-configuration credential profile. */
  readonly profile: string
  /** Captured shared managed DescribeTable rate owner. */
  readonly rate: WorkspaceSearchMigrationManagedDescribeTableRate
  /** Exact AWS Region. */
  readonly region: string
  /** Detached deeply frozen immutable resource attestation. */
  readonly resourceAttestation: CrossDomainIntegrityResourceAttestation
  /** Detached keyed immutable seven-resource vector. */
  readonly resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[]
  /** Protected source role. */
  readonly role: 'source'
  /** Optional validated caller cancellation. */
  readonly signal?: AbortSignal
  /** Detached complete six-table allowlist. */
  readonly tables: CrossDomainIntegrityTableNames
  /** No-op-close wrapper over the borrowed read-only transport. */
  readonly transport: CrossDomainIntegrityAwsTransport
  /** Captured trusted wall clock shared through final sealing. */
  readonly wallClock: TrustedWallClock
}

/** Private exact checker state retained behind one pending capability. */
type PendingIntegrityLiveSessionState = {
  /** Expected immutable resource identity digest. */
  readonly expectedResourceIdentityDigest: string
  /** Dedicated #163 result key retained until sealing or failure. */
  readonly integrityDigestKey: Uint8Array
  /** Exact actual checker result object hidden from the caller. */
  readonly result: CrossDomainIntegrityResult
  /** Full digest detecting mutation of the hidden result. */
  readonly resultBindingDigest: string
  /** Detached private immutable resource attestation used by the checker. */
  readonly resourceAttestation: CrossDomainIntegrityResourceAttestation
  /** Genuine exact-twelve adapter sequence capability. */
  readonly sequence: WorkspaceSearchMigrationRehearsalIntegrityRateSequence
  /** Trusted actual completion timestamp returned by the checker bridge. */
  readonly completedAt: string
  /** Trusted actual start timestamp sampled before STS. */
  readonly startedAt: string
  /** Captured non-regressing wall clock for post-result authentication. */
  readonly wallClock: TrustedWallClock
}

/** Genuine pending capabilities awaiting exactly one finalization attempt. */
const pendingIntegrityLiveSessions = new WeakMap<
  object,
  PendingIntegrityLiveSessionState
>()

/** Strict guards replacing every malformed value with the stable session error. */
const liveSessionGuards = new WorkspaceSearchMigrationStrictRecordGuards(
  failIntegrityLiveSession,
)

/**
 * Runs the actual production #163 AWS checker inside an exact-twelve rate gate.
 *
 * The trusted start is sampled before STS. Caller-account verification and all
 * checker reads share one non-resettable deadline. The checker itself is
 * composed here and runs exactly once inside the managed adapter; callers
 * cannot inject a prebuilt result or an operation closure. The result, exact
 * adapter sequence, private attestation, and provenance remain behind an
 * opaque process-local capability.
 *
 * @param input - Strict resources, borrowed transport, managed rate, keys, and clocks.
 * @returns Fresh one-shot pending authority without exposing the checker result.
 */
export async function runWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
  input: RunWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput,
): Promise<WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending> {
  let auditPseudonymKey: Uint8Array | undefined
  let adapter:
    WorkspaceSearchMigrationRehearsalIntegrityRateAdapter | undefined
  let deadline: ReturnType<
    typeof createCrossDomainIntegrityInvocationDeadline
  > | undefined
  let integrityDigestKey: Uint8Array | undefined
  let reader: AwsCrossDomainIntegrityReader | undefined
  try {
    const snapshot = readIntegrityLiveSessionInput(input)
    auditPseudonymKey = snapshot.auditPseudonymKey
    integrityDigestKey = snapshot.integrityDigestKey
    const activeAuditPseudonymKey = snapshot.auditPseudonymKey
    const activeIntegrityDigestKey = snapshot.integrityDigestKey
    deadline = createCrossDomainIntegrityInvocationDeadline({
      maximumDurationMilliseconds: snapshot.maximumDurationMilliseconds,
      monotonicClock: snapshot.monotonicClock,
      ...(snapshot.signal === undefined ? {} : { signal: snapshot.signal }),
    })
    const startedAt = snapshot.wallClock.sampleTimestamp()
    let completedAt: string | undefined
    let completionSampleCount = 0
    const liveRuntime = Object.freeze({
      startedAt,
      sampleCompletedAt: (): string => {
        completionSampleCount += 1
        if (completionSampleCount !== 1) return failIntegrityLiveSession()
        completedAt = snapshot.wallClock.sampleTimestamp()
        return completedAt
      },
    })
    const activeAdapter =
      createWorkspaceSearchMigrationRehearsalIntegrityRateAdapter({
        tableNames: snapshot.tables,
        tablePassCount: 2,
        baseTransport: snapshot.transport,
        rate: snapshot.rate,
      })
    adapter = activeAdapter
    reader = new AwsCrossDomainIntegrityReader(
      {
        buckets: snapshot.buckets,
        expectedAccount: snapshot.account,
        maxPages: snapshot.maxPages,
        pageSize: snapshot.pageSize,
        profile: snapshot.profile,
        region: snapshot.region,
        tables: snapshot.tables,
      },
      () => activeAdapter,
    )
    const activeDeadline = deadline
    const activeReader = reader
    const callerAccount =
      await runCrossDomainIntegrityRequestWithinDeadline(
        activeDeadline,
        (signal) => activeReader.readCallerAccount(signal),
      )
    if (callerAccount !== snapshot.account) {
      return failIntegrityLiveSession()
    }
    const result = await activeAdapter.run(async () =>
      await runCrossDomainIntegrityAwsCheck({
        auditPseudonymKey: activeAuditPseudonymKey,
        checkedAt: startedAt,
        deadline: activeDeadline,
        digestKey: activeIntegrityDigestKey,
        liveRuntime,
        maxItems: snapshot.maxItems,
        maxPages: snapshot.maxPages,
        observationMode: 'migration-rehearsal-live',
        pageSize: snapshot.pageSize,
        reader: activeReader,
        resourceAttestation: snapshot.resourceAttestation,
        resourceBindingDigest:
          calculateCrossDomainIntegrityResourceBindingDigest(),
        resourceIdentities: snapshot.resourceIdentities,
        resourceIdentityDigest: snapshot.expectedResourceIdentityDigest,
        resourceIdentityScheme:
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        role: snapshot.role,
      })
    )
    requireCrossDomainIntegrityInvocationDeadline(activeDeadline)
    const authenticatedCompletedAt = completedAt
    const provenance = result.runtimeProvenance
    if (
      completionSampleCount !== 1 ||
      authenticatedCompletedAt === undefined ||
      provenance === undefined ||
      provenance.startedAt !== startedAt ||
      provenance.completedAt !== authenticatedCompletedAt ||
      result.checkedAt !== authenticatedCompletedAt
    ) return failIntegrityLiveSession()
    const sequence = activeAdapter.takeCompletedSequence(result)
    const resultBindingDigest = createMigrationDigest(result)
    activeReader.close()
    reader = undefined
    adapter = undefined
    disposeCrossDomainIntegrityInvocationDeadline(activeDeadline)
    deadline = undefined
    auditPseudonymKey.fill(0)
    auditPseudonymKey = undefined

    const capability =
      new WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending(
        pendingCapabilityToken,
      )
    pendingIntegrityLiveSessions.set(capability, Object.freeze({
      expectedResourceIdentityDigest:
        snapshot.expectedResourceIdentityDigest,
      integrityDigestKey,
      result,
      resultBindingDigest,
      resourceAttestation: snapshot.resourceAttestation,
      sequence,
      completedAt: authenticatedCompletedAt,
      startedAt,
      wallClock: snapshot.wallClock,
    }))
    integrityDigestKey = undefined
    return capability
  } catch {
    return failIntegrityLiveSession()
  } finally {
    auditPseudonymKey?.fill(0)
    integrityDigestKey?.fill(0)
    reader?.close()
    adapter?.close()
    if (deadline !== undefined) {
      disposeCrossDomainIntegrityInvocationDeadline(deadline)
    }
  }
}

/**
 * Burns an unsealed live-session capability and overwrites its retained key.
 *
 * Callers must invoke this during cleanup when a successful checker cannot be
 * finalized against its durable rate segment. A genuine pending capability is
 * consumed exactly once; forged, cloned, or already consumed values fail
 * closed.
 *
 * @param pending - Genuine unsealed pending authority returned by the runner.
 */
export function disposeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
  pending: WorkspaceSearchMigrationRehearsalIntegrityLiveSessionPending,
): void {
  let state: PendingIntegrityLiveSessionState | undefined
  try {
    state = consumePendingIntegrityLiveSession(pending)
  } catch {
    return failIntegrityLiveSession()
  } finally {
    state?.integrityDigestKey.fill(0)
  }
}

/**
 * Burns and seals one pending actual checker against its authenticated segment.
 *
 * The pending brand is consumed before segment, policy, or key validation, so
 * every genuine finalization attempt is one-shot. The adapter sequence is
 * immediately consumed by the raw interval verifier, and that private binding
 * is immediately consumed by the rate-bound result finalizer. Both the runtime
 * rate key and retained #163 result key are overwritten on every path.
 *
 * @param input - Pending authority, linked raw segments, policy, config, and key.
 * @returns Fresh authenticated rate-bound #163 result capability.
 */
export function finalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSession(
  input: FinalizeWorkspaceSearchMigrationRehearsalIntegrityLiveSessionInput,
): WorkspaceSearchMigrationRehearsalRateBoundIntegrityResult {
  let pendingState: PendingIntegrityLiveSessionState | undefined
  let rateAuthenticationKey: Uint8Array | undefined
  let transferredRateAuthenticationKey: unknown
  try {
    const record = liveSessionGuards.requireRecord(input)
    transferredRateAuthenticationKey = readOwnDataCandidate(
      record,
      'rateAuthenticationKey',
    )
    liveSessionGuards.requireExactKeys(
      record,
      liveSessionFinalizerInputKeys,
    )
    transferredRateAuthenticationKey = liveSessionGuards.readOwn(
      record,
      'rateAuthenticationKey',
    )
    pendingState = consumePendingIntegrityLiveSession(
      liveSessionGuards.readOwn(record, 'pending'),
    )
    rateAuthenticationKey = copyFixedKey(
      transferredRateAuthenticationKey,
    )
    zeroizeCandidateKey(transferredRateAuthenticationKey)
    const expectedPolicyVersion = liveSessionGuards.readDigest(
      liveSessionGuards.readOwn(record, 'expectedPolicyVersion'),
    )
    const expectedConfigurationBindingDigest =
      liveSessionGuards.readDigest(
        liveSessionGuards.readOwn(
          record,
          'expectedConfigurationBindingDigest',
        ),
      )
    if (
      createMigrationDigest(pendingState.result) !==
        pendingState.resultBindingDigest
    ) return failIntegrityLiveSession()
    const rateBinding =
      verifyWorkspaceSearchMigrationRehearsalIntegrityRateInterval({
        canonicalSegmentBytes: liveSessionGuards.readOwn(
          record,
          'canonicalSegmentBytes',
        ),
        authenticationKey: rateAuthenticationKey,
        predecessorSegmentBytes: liveSessionGuards.readOwn(
          record,
          'predecessorSegmentBytes',
        ),
        expectedPolicyVersion,
        expectedConfigurationBindingDigest,
        expectedStartedAt: pendingState.startedAt,
        expectedCompletedAt: pendingState.completedAt,
        sequence: pendingState.sequence,
        taskResult: pendingState.result,
      })
    return finalizeWorkspaceSearchMigrationRehearsalRateBoundIntegrityResult({
      rateBinding,
      result: pendingState.result,
      resourceAttestation: pendingState.resourceAttestation,
      integrityDigestKey: pendingState.integrityDigestKey,
      rateAuthenticationKey,
      expectedResourceIdentityDigest:
        pendingState.expectedResourceIdentityDigest,
      clock: pendingState.wallClock.sampleDate,
    })
  } catch {
    return failIntegrityLiveSession()
  } finally {
    zeroizeCandidateKey(transferredRateAuthenticationKey)
    rateAuthenticationKey?.fill(0)
    pendingState?.integrityDigestKey.fill(0)
  }
}

/** Strictly detaches every run input before any trusted clock or AWS read. */
function readIntegrityLiveSessionInput(
  value: unknown,
): IntegrityLiveSessionSnapshot {
  let auditPseudonymKey: Uint8Array | undefined
  let integrityDigestKey: Uint8Array | undefined
  let transferredAuditKey: unknown
  let transferredIntegrityKey: unknown
  try {
    const record = liveSessionGuards.requireRecord(value)
    transferredAuditKey = readOwnDataCandidate(
      record,
      'auditPseudonymKey',
    )
    transferredIntegrityKey = readOwnDataCandidate(
      record,
      'integrityDigestKey',
    )
    const expectedKeys = Object.hasOwn(record, 'signal')
      ? [...liveSessionInputKeys, 'signal']
      : liveSessionInputKeys
    liveSessionGuards.requireExactKeys(record, expectedKeys)
    const account = liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'account'),
    )
    const region = liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'region'),
    )
    const profile = liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'profile'),
    )
    const role = readSourceRole(liveSessionGuards.readOwn(record, 'role'))
    const tables = readTableNames(
      liveSessionGuards.readOwn(record, 'tables'),
    )
    const buckets = readBucketNames(
      liveSessionGuards.readOwn(record, 'buckets'),
    )
    const transport = readBorrowedTransport(
      liveSessionGuards.readOwn(record, 'transport'),
    )
    const rate = readManagedRate(
      liveSessionGuards.readOwn(record, 'rate'),
    )
    const maxItems = readPositiveBoundedInteger(
      liveSessionGuards.readOwn(record, 'maxItems'),
      maximumItemCount,
    )
    const maxPages = readPositiveBoundedInteger(
      liveSessionGuards.readOwn(record, 'maxPages'),
      maximumPageCount,
    )
    const pageSize = readPositiveBoundedInteger(
      liveSessionGuards.readOwn(record, 'pageSize'),
      maximumPageSize,
    )
    validateCrossDomainIntegrityLimits({
      maxItems,
      maxPages,
      pageSize,
    })
    const maximumDurationMilliseconds = readPositiveBoundedInteger(
      liveSessionGuards.readOwn(record, 'maximumDurationMilliseconds'),
      CROSS_DOMAIN_INTEGRITY_MAX_DURATION_MILLISECONDS,
    )
    const monotonicClock = readMonotonicClock(
      liveSessionGuards.readOwn(record, 'monotonicClock'),
    )
    const wallClock = createTrustedWallClock(
      liveSessionGuards.readOwn(record, 'wallClock'),
    )
    const signal = Object.hasOwn(record, 'signal')
      ? readAbortSignal(liveSessionGuards.readOwn(record, 'signal'))
      : undefined
    const expectedResourceIdentityDigest = liveSessionGuards.readDigest(
      liveSessionGuards.readOwn(record, 'expectedResourceIdentityDigest'),
    )
    const resourceAttestation = readCanonicalResourceAttestation(
      liveSessionGuards.readOwn(record, 'resourceAttestationBytes'),
    )
    requireExactResourceConfiguration(
      resourceAttestation,
      account,
      region,
      tables,
      buckets,
    )
    transferredIntegrityKey = liveSessionGuards.readOwn(
      record,
      'integrityDigestKey',
    )
    transferredAuditKey = liveSessionGuards.readOwn(
      record,
      'auditPseudonymKey',
    )
    integrityDigestKey = copyFixedKey(transferredIntegrityKey)
    auditPseudonymKey = copyFixedKey(transferredAuditKey)
    if (timingSafeEqual(integrityDigestKey, auditPseudonymKey)) {
      return failIntegrityLiveSession()
    }
    const resourceIdentities =
      createCrossDomainIntegrityImmutableResourceIdentities(
        resourceAttestation,
        integrityDigestKey,
      )
    if (
      calculateCrossDomainIntegrityResourceIdentityDigest(
        resourceIdentities,
        integrityDigestKey,
      ) !== expectedResourceIdentityDigest
    ) return failIntegrityLiveSession()
    const snapshot = Object.freeze({
      account,
      auditPseudonymKey,
      buckets,
      expectedResourceIdentityDigest,
      integrityDigestKey,
      maxItems,
      maxPages,
      maximumDurationMilliseconds,
      monotonicClock,
      pageSize,
      profile,
      rate,
      region,
      resourceAttestation,
      resourceIdentities,
      role,
      ...(signal === undefined ? {} : { signal }),
      tables,
      transport,
      wallClock,
    })
    auditPseudonymKey = undefined
    integrityDigestKey = undefined
    return snapshot
  } catch {
    return failIntegrityLiveSession()
  } finally {
    zeroizeCandidateKey(transferredAuditKey)
    zeroizeCandidateKey(transferredIntegrityKey)
    auditPseudonymKey?.fill(0)
    integrityDigestKey?.fill(0)
  }
}

/** Reads and snapshots one exact six-table mapping. */
function readTableNames(value: unknown): CrossDomainIntegrityTableNames {
  const record = liveSessionGuards.requireRecord(value)
  liveSessionGuards.requireExactKeys(record, [
    'audit-events',
    'file-proofing',
    'project-directory',
    'work-item-configuration',
    'work-items',
    'workspace-access',
  ])
  return Object.freeze({
    'audit-events': liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'audit-events'),
    ),
    'file-proofing': liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'file-proofing'),
    ),
    'project-directory': liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'project-directory'),
    ),
    'work-item-configuration': liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'work-item-configuration'),
    ),
    'work-items': liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'work-items'),
    ),
    'workspace-access': liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'workspace-access'),
    ),
  })
}

/** Reads and snapshots the exact File bucket mapping. */
function readBucketNames(value: unknown): CrossDomainIntegrityBucketNames {
  const record = liveSessionGuards.requireRecord(value)
  liveSessionGuards.requireExactKeys(record, ['file'])
  return Object.freeze({
    file: liveSessionGuards.readText(
      liveSessionGuards.readOwn(record, 'file'),
    ),
  })
}

/** Reads the sole admitted source role. */
function readSourceRole(value: unknown): 'source' {
  if (value !== 'source') return failIntegrityLiveSession()
  return value
}

/** Reads one finite positive integer no greater than an explicit maximum. */
function readPositiveBoundedInteger(
  value: unknown,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) return failIntegrityLiveSession()
  return value
}

/** Reads one optional genuine non-proxy AbortSignal. */
function readAbortSignal(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal) || nodeUtilTypes.isProxy(value)) {
    return failIntegrityLiveSession()
  }
  return value
}

/** Captures a trusted monotonic callback without retaining an input accessor. */
function readMonotonicClock(value: unknown): () => number {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failIntegrityLiveSession()
  }
  return (): number => {
    let sample: unknown
    try {
      sample = Reflect.apply(value, undefined, [])
    } catch {
      return failIntegrityLiveSession()
    }
    if (
      typeof sample !== 'number' ||
      !Number.isSafeInteger(sample) ||
      sample < 0
    ) return failIntegrityLiveSession()
    return sample
  }
}

/** Captures one wall clock and enforces canonical non-regressing samples. */
function createTrustedWallClock(value: unknown): TrustedWallClock {
  if (typeof value !== 'function' || nodeUtilTypes.isProxy(value)) {
    return failIntegrityLiveSession()
  }
  let lastMilliseconds: number | undefined
  /** Samples one detached finite millisecond value from the captured clock. */
  const sampleMilliseconds = (): number => {
    let observed: unknown
    let milliseconds: unknown
    try {
      observed = Reflect.apply(value, undefined, [])
      if (
        !(observed instanceof Date) ||
        nodeUtilTypes.isProxy(observed) ||
        Object.getPrototypeOf(observed) !== Date.prototype
      ) return failIntegrityLiveSession()
      milliseconds = Reflect.apply(Date.prototype.getTime, observed, [])
    } catch {
      return failIntegrityLiveSession()
    }
    if (
      typeof milliseconds !== 'number' ||
      !Number.isSafeInteger(milliseconds) ||
      (lastMilliseconds !== undefined && milliseconds < lastMilliseconds)
    ) return failIntegrityLiveSession()
    lastMilliseconds = milliseconds
    return milliseconds
  }
  return Object.freeze({
    sampleTimestamp: (): string => {
      try {
        return new Date(sampleMilliseconds()).toISOString()
      } catch {
        return failIntegrityLiveSession()
      }
    },
    sampleDate: (): Date => new Date(sampleMilliseconds()),
  })
}

/** Parses exact canonical owner-only resource-attestation bytes. */
function readCanonicalResourceAttestation(
  value: unknown,
): CrossDomainIntegrityResourceAttestation {
  const bytes = copyBytes(
    value,
    CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
  )
  let text: string
  let parsed: unknown
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    parsed = JSON.parse(text)
  } catch {
    bytes.fill(0)
    return failIntegrityLiveSession()
  }
  bytes.fill(0)
  let attestation: CrossDomainIntegrityResourceAttestation
  try {
    attestation = parseCrossDomainIntegrityResourceAttestation(parsed)
    if (serializeCrossDomainIntegrityResourceAttestation(attestation) !== text) {
      return failIntegrityLiveSession()
    }
  } catch {
    return failIntegrityLiveSession()
  }
  return attestation
}

/** Requires the raw attestation to reproduce every exact selected resource. */
function requireExactResourceConfiguration(
  attestation: CrossDomainIntegrityResourceAttestation,
  account: string,
  region: string,
  tables: CrossDomainIntegrityTableNames,
  buckets: CrossDomainIntegrityBucketNames,
): void {
  const expectedTableNames = [
    tables['audit-events'],
    tables['file-proofing'],
    tables['project-directory'],
    tables['work-item-configuration'],
    tables['work-items'],
    tables['workspace-access'],
  ]
  if (
    attestation.account !== account ||
    attestation.region !== region ||
    attestation.bucket.bucketName !== buckets.file ||
    attestation.tables.length !== expectedTableNames.length ||
    attestation.tables.some((table, index) =>
      table.tableName !== expectedTableNames[index])
  ) return failIntegrityLiveSession()
}

/** Copies one plain non-shared Uint8Array under a finite byte limit. */
function copyBytes(value: unknown, maximumByteLength: number): Uint8Array {
  if (
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return failIntegrityLiveSession()
  const buffer = liveSessionGuards.readIntrinsicBuffer(value)
  const byteLength = liveSessionGuards.readIntrinsicByteLength(value)
  if (
    nodeUtilTypes.isSharedArrayBuffer(buffer) ||
    byteLength < 1 ||
    byteLength > maximumByteLength
  ) return failIntegrityLiveSession()
  const copied = new Uint8Array(byteLength)
  try {
    Reflect.apply(Uint8Array.prototype.set, copied, [value])
  } catch {
    copied.fill(0)
    return failIntegrityLiveSession()
  }
  return copied
}

/** Copies one exact plain non-shared 32-byte HMAC key. */
function copyFixedKey(value: unknown): Uint8Array {
  const copied = copyBytes(value, digestKeyByteLength)
  if (copied.byteLength !== digestKeyByteLength) {
    copied.fill(0)
    return failIntegrityLiveSession()
  }
  return copied
}

/** Best-effort intrinsic zeroization for a transferred candidate key. */
function zeroizeCandidateKey(value: unknown): void {
  if (
    value === undefined ||
    nodeUtilTypes.isProxy(value) ||
    !nodeUtilTypes.isUint8Array(value) ||
    Object.getPrototypeOf(value) !== Uint8Array.prototype
  ) return
  try {
    Reflect.apply(Uint8Array.prototype.fill, value, [0])
  } catch {
    return
  }
}

/** Reads one own data value without invoking an accessor or failing the input. */
function readOwnDataCandidate(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined
}

/** Reads the genuine pending state and burns its brand before other validation. */
function consumePendingIntegrityLiveSession(
  value: unknown,
): PendingIntegrityLiveSessionState {
  if (
    typeof value !== 'object' ||
    value === null ||
    nodeUtilTypes.isProxy(value)
  ) return failIntegrityLiveSession()
  const state = pendingIntegrityLiveSessions.get(value)
  if (state === undefined) return failIntegrityLiveSession()
  pendingIntegrityLiveSessions.delete(value)
  return state
}

/** Reads and snapshots the complete managed rate interface. */
function readManagedRate(
  value: unknown,
): WorkspaceSearchMigrationManagedDescribeTableRate {
  if (!isManagedRate(value)) return failIntegrityLiveSession()
  return Object.freeze({
    assertNewDataIoAllowed: value.assertNewDataIoAllowed.bind(value),
    claimAfterLease: value.claimAfterLease.bind(value),
    close: value.close.bind(value),
    closeAndReadEvidence: value.closeAndReadEvidence.bind(value),
    describeTable: value.describeTable.bind(value),
    interrupt: value.interrupt.bind(value),
    quarantine: value.quarantine.bind(value),
    readEvidence: value.readEvidence.bind(value),
    runCheckpointPage: value.runCheckpointPage.bind(value),
    runMandatoryCleanup: value.runMandatoryCleanup.bind(value),
    runNonPageOperation: value.runNonPageOperation.bind(value),
    runWithMutationAdmissionGuard:
      value.runWithMutationAdmissionGuard.bind(value),
  })
}

/** Narrows one non-proxy object to the complete managed rate contract. */
function isManagedRate(
  value: unknown,
): value is WorkspaceSearchMigrationManagedDescribeTableRate {
  return liveSessionGuards.isRecord(value) &&
    managedRateMethodNames.every((name) => hasDataMethod(value, name))
}

/** Reads a no-op-close wrapper around one borrowed AWS transport. */
function readBorrowedTransport(
  value: unknown,
): CrossDomainIntegrityAwsTransport {
  if (!isAwsTransport(value)) return failIntegrityLiveSession()
  const getBucketVersioning = value.getBucketVersioning.bind(value)
  const getObjectAttributes = value.getObjectAttributes.bind(value)
  const getObjectTagging = value.getObjectTagging.bind(value)
  const headObject = value.headObject.bind(value)
  const readCallerIdentity = value.readCallerIdentity.bind(value)
  const scan = value.scan.bind(value)
  return Object.freeze({
    /** Leaves the caller-owned transport open for the outer session owner. */
    close(): void {},
    /** Fails closed if an invariant violation reaches this forbidden fallback. */
    async describeTable(
      _command: DescribeTableCommand,
      _signal: AbortSignal,
    ): Promise<DescribeTableCommandOutput> {
      return failIntegrityLiveSession()
    },
    /** Delegates one exact bucket-versioning read. */
    getBucketVersioning(
      command: GetBucketVersioningCommand,
      signal: AbortSignal,
    ): Promise<GetBucketVersioningCommandOutput> {
      return getBucketVersioning(command, signal)
    },
    /** Delegates one exact object-attributes read. */
    getObjectAttributes(
      command: GetObjectAttributesCommand,
      signal: AbortSignal,
    ): Promise<GetObjectAttributesCommandOutput> {
      return getObjectAttributes(command, signal)
    },
    /** Delegates one exact object-tagging read. */
    getObjectTagging(
      command: GetObjectTaggingCommand,
      signal: AbortSignal,
    ): Promise<GetObjectTaggingCommandOutput> {
      return getObjectTagging(command, signal)
    },
    /** Delegates one exact object HEAD read. */
    headObject(
      command: HeadObjectCommand,
      signal: AbortSignal,
    ): Promise<HeadObjectCommandOutput> {
      return headObject(command, signal)
    },
    /** Delegates one STS caller-identity read. */
    readCallerIdentity(
      command: GetCallerIdentityCommand,
      signal: AbortSignal,
    ): Promise<GetCallerIdentityCommandOutput> {
      return readCallerIdentity(command, signal)
    },
    /** Delegates one bounded strongly consistent scan. */
    scan(
      command: ScanCommand,
      signal: AbortSignal,
    ): Promise<ScanCommandOutput> {
      return scan(command, signal)
    },
  })
}

/** Narrows one non-proxy object to the complete read-only AWS transport. */
function isAwsTransport(
  value: unknown,
): value is WorkspaceSearchMigrationRehearsalIntegrityLiveReadTransport {
  return liveSessionGuards.isRecord(value) &&
    transportMethodNames.every((name) => hasDataMethod(value, name))
}

/** Finds one callable non-proxy data method without invoking accessors. */
function hasDataMethod(value: object, name: string): boolean {
  let current: object | null = value
  try {
    while (current !== null) {
      if (nodeUtilTypes.isProxy(current)) return false
      const descriptor = Object.getOwnPropertyDescriptor(current, name)
      if (descriptor !== undefined) {
        return Object.hasOwn(descriptor, 'value') &&
          typeof descriptor.value === 'function' &&
          !nodeUtilTypes.isProxy(descriptor.value)
      }
      current = Object.getPrototypeOf(current)
    }
  } catch {
    return false
  }
  return false
}

/** Throws the stable live-session error. */
function failIntegrityLiveSession(): never {
  throw new WorkspaceSearchMigrationRehearsalIntegrityLiveSessionError()
}
