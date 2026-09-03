import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { DEFAULT_WORK_ITEM_TYPE_ID } from '@mukuroji/contracts'
import type {
  CrossDomainAuditReference,
  CrossDomainConfigurationItem,
  CrossDomainFileMetadata,
  CrossDomainFileObject,
  CrossDomainIntegrityFailureCode,
  CrossDomainIntegrityItem,
  CrossDomainProject,
  CrossDomainRelation,
  CrossDomainRelationType,
  CrossDomainWorkflowStatus,
  CrossDomainWorkItem,
} from './cross-domain-integrity-contract'
import {
  calculateCrossDomainIntegrityResourceIdentityDigest,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  parseCrossDomainIntegrityResourceIdentities,
  type CrossDomainIntegrityResourceIdentity,
} from './cross-domain-integrity-resource-attestation'

/** Public normalized cross-domain record contracts owned by data-integrity. */
export type {
  CrossDomainAuditReference,
  CrossDomainAuditResourceType,
  CrossDomainConfigurationItem,
  CrossDomainFileMetadata,
  CrossDomainFileObject,
  CrossDomainFileScanStatus,
  CrossDomainIntegrityFailureCode,
  CrossDomainIntegrityItem,
  CrossDomainProject,
  CrossDomainRelation,
  CrossDomainRelationType,
  CrossDomainTeam,
  CrossDomainWorkflowStatus,
  CrossDomainWorkItemTypeWorkflow,
  CrossDomainWorkflowStatusCategory,
  CrossDomainWorkItem,
  CrossDomainWorkspaceMember,
} from './cross-domain-integrity-contract'
/** Immutable resource-attestation contracts retained on the checker surface. */
export {
  calculateCrossDomainIntegrityImmutableResourceIdentity,
  calculateCrossDomainIntegrityResourceIdentityDigest,
  createCrossDomainIntegrityImmutableResourceIdentities,
  CROSS_DOMAIN_INTEGRITY_FILE_BUCKET_MARKER_KEY,
  CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_KIND,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_MAX_BYTES,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_ATTESTATION_VERSION,
  CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS,
  CROSS_DOMAIN_INTEGRITY_TABLE_RESOURCE_TARGETS,
  parseCrossDomainIntegrityResourceAttestation,
  parseCrossDomainIntegrityResourceIdentities,
  sameCrossDomainIntegrityResourceAttestation,
  serializeCrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityFileBucketMarkerAttestation,
  type CrossDomainIntegrityFileBucketResourceAttestation,
  type CrossDomainIntegrityImmutableResourceIdentityInput,
  type CrossDomainIntegrityResourceAttestation,
  type CrossDomainIntegrityResourceIdentity,
  type CrossDomainIntegrityResourceTarget,
  type CrossDomainIntegrityTableResourceAttestation,
  type CrossDomainIntegrityTableResourceTarget,
} from './cross-domain-integrity-resource-attestation'

/** Current cross-domain checker contract version. */
export const CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION = 2

/** Machine-readable result discriminator. */
export const CROSS_DOMAIN_INTEGRITY_RESULT_KIND = 'mukuroji-cross-domain-integrity-result'

/** Machine-readable source/restore comparison discriminator. */
export const CROSS_DOMAIN_INTEGRITY_COMPARISON_KIND =
  'mukuroji-cross-domain-integrity-comparison'

/** Machine-readable same-resource migration rehearsal comparison discriminator. */
export const CROSS_DOMAIN_INTEGRITY_MIGRATION_REHEARSAL_COMPARISON_KIND =
  'mukuroji-cross-domain-integrity-migration-rehearsal-comparison'

/** Machine-readable provenance discriminator emitted only by live rehearsal checks. */
export const CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND =
  'mukuroji-cross-domain-integrity-rehearsal-live-provenance'

const DIGEST_KEY_BYTE_LENGTH = 32
const MAX_PAGE_SIZE = 1_000
const MAX_PAGE_COUNT = 10_000
const MAX_ITEM_COUNT = 1_000_000

/** Maximum caller-selected duration for one complete integrity invocation. */
export const CROSS_DOMAIN_INTEGRITY_MAX_DURATION_MILLISECONDS = 15 * 60 * 1_000

/** Stable failure categories emitted by the invocation deadline capability. */
export type CrossDomainIntegrityDeadlineFailureCode =
  | 'CANCELLED'
  | 'CLOCK_INVALID'
  | 'DEADLINE_EXCEEDED'

/** Safe failure raised when one invocation can no longer continue. */
export class CrossDomainIntegrityDeadlineFailure extends Error {
  /** Stable raw-data-free failure category. */
  readonly code: CrossDomainIntegrityDeadlineFailureCode

  /**
   * Creates one stable deadline failure.
   *
   * @param code - Raw-data-free cancellation, clock, or timeout category.
   */
  constructor(code: CrossDomainIntegrityDeadlineFailureCode) {
    super(code)
    this.name = 'CrossDomainIntegrityDeadlineFailure'
    this.code = code
  }
}

/** Inputs used to create one non-resettable total invocation deadline. */
export type CreateCrossDomainIntegrityInvocationDeadlineInput = {
  /** Caller-selected total duration no greater than fifteen minutes. */
  readonly maximumDurationMilliseconds: number
  /** Trusted non-negative, integer, monotonic clock. */
  readonly monotonicClock: () => number
  /** Optional caller cancellation propagated to every external request. */
  readonly signal?: AbortSignal
}

/** Private mutable state retained outside the frozen deadline capability. */
type CrossDomainIntegrityInvocationDeadlineState = {
  /** Controller shared by every external request in this invocation. */
  readonly controller: AbortController
  /** Absolute monotonic expiration instant. */
  readonly deadlineMilliseconds: number
  /** Removes the optional caller-cancellation listener. */
  readonly disposeCallerSignal: () => void
  /** Trusted clock captured once at capability creation. */
  readonly monotonicClock: () => number
  /** Initial monotonic sample. */
  readonly startedAtMilliseconds: number
  /** Failure responsible for aborting the invocation, when known. */
  failure?: CrossDomainIntegrityDeadlineFailure
  /** Latest accepted monotonic sample. */
  lastObservedMilliseconds: number
}

const crossDomainIntegrityInvocationDeadlineStates =
  new WeakMap<CrossDomainIntegrityInvocationDeadline,
    CrossDomainIntegrityInvocationDeadlineState>()
const crossDomainIntegrityInvocationDeadlineToken = Symbol(
  'cross-domain-integrity-invocation-deadline',
)

/** Opaque, non-resettable capability for one complete integrity invocation. */
export class CrossDomainIntegrityInvocationDeadline {
  /** Caller-selected total duration authenticated by construction. */
  readonly maximumDurationMilliseconds: number

  /**
   * Creates a capability only for this module's deadline factory.
   *
   * @param token - Module-private construction authority.
   * @param maximumDurationMilliseconds - Validated total duration.
   */
  constructor(token: symbol, maximumDurationMilliseconds: number) {
    if (token !== crossDomainIntegrityInvocationDeadlineToken) {
      throw new TypeError('Cross-domain integrity invocation deadline is invalid.')
    }
    this.maximumDurationMilliseconds = maximumDurationMilliseconds
    Object.freeze(this)
  }
}
const KNOWN_FAILURE_CODES = new Set<string>([
  'AUDIT_RESOURCE_MISSING',
  'AUDIT_TENANT_MISMATCH',
  'CONFIGURATION_DUPLICATE_SCOPE',
  'CURSOR_LOOP',
  'DUPLICATE_RECORD',
  'FILE_METADATA_OBJECT_MISMATCH',
  'FILE_METADATA_OBJECT_MISSING',
  'FILE_METADATA_REFERENCE_MISSING',
  'FILE_METADATA_TENANT_MISMATCH',
  'FILE_OBJECT_METADATA_MISSING',
  'INTEGRITY_LIMIT_EXCEEDED',
  'RELATION_ENDPOINT_MISSING',
  'RELATION_ENDPOINT_TEAM_MISMATCH',
  'RELATION_PROJECT_MISSING',
  'RELATION_PROJECT_TEAM_MISMATCH',
  'RELATION_RECIPROCAL_MISSING',
  'RELATION_TEAM_MISSING',
  'RELATION_TENANT_MISMATCH',
  'RESTORE_AUDIT_DIFFERENCE',
  'RESTORE_CHECK_FAILED',
  'RESTORE_CONFIGURATION_DIFFERENCE',
  'RESTORE_FILE_DIFFERENCE',
  'RESTORE_RELATION_DIFFERENCE',
  'RESTORE_RESOURCE_DIFFERENCE',
  'RESTORE_RESULT_AUTHENTICATION_FAILED',
  'RESTORE_WORK_ITEM_DIFFERENCE',
  'SOURCE_CHECK_FAILED',
  'SOURCE_RESULT_AUTHENTICATION_FAILED',
  'SOURCE_RESTORE_CHECKED_AT_MISMATCH',
  'SOURCE_RESTORE_KEY_MISMATCH',
  'SOURCE_RESTORE_LIMITS_MISMATCH',
  'SOURCE_RESTORE_RESOURCE_BINDING_MISMATCH',
  'SOURCE_RESTORE_RESOURCE_IDENTITY_REUSED',
  'SOURCE_RESTORE_ROLE_MISMATCH',
  'WORK_ITEM_CREATOR_MEMBER_MISSING',
  'WORK_ITEM_CREATOR_TENANT_MISMATCH',
  'WORK_ITEM_PROJECT_MISSING',
  'WORK_ITEM_PROJECT_TEAM_MISMATCH',
  'WORK_ITEM_RELATION_PROJECTION_MISMATCH',
  'WORK_ITEM_STATUS_CATEGORY_MISMATCH',
  'WORK_ITEM_TEAM_MISSING',
  'WORK_ITEM_TENANT_MISMATCH',
  'WORK_ITEM_TYPE_UNKNOWN',
  'WORK_ITEM_WORKFLOW_STATUS_UNKNOWN',
])

/** Stable invariant names owned by this checker. */
export const CROSS_DOMAIN_INTEGRITY_TARGETS = Object.freeze([
  'audit-known-resource-tenant',
  'configuration-workflow-status',
  'file-metadata-work-item-project-tenant',
  'relation-work-item-team-project',
  'work-item-creator-membership',
])

/** Stable exclusions that belong to another verifier or quality gate. */
export const CROSS_DOMAIN_INTEGRITY_NON_TARGETS = Object.freeze([
  'authorization-and-policy-correctness',
  'file-content-and-malware-engine-accuracy',
  'historical-audit-resource-liveness',
  'single-table-physical-integrity',
])

/**
 * Calculates the versioned logical-resource binding shared by source and
 * isolated-restore checks.
 *
 * Physical names are deliberately excluded so differently named isolated
 * resources remain comparable.
 *
 * @returns Lowercase SHA-256 digest of the fixed logical allowlist.
 */
export function calculateCrossDomainIntegrityResourceBindingDigest(): string {
  const binding = [
    'mukuroji-cross-domain-integrity-resource-binding/v1',
    'bucket:file',
    'table:work-items',
    'table:work-item-configuration',
    'table:project-directory',
    'table:workspace-access',
    'table:audit-events',
    'table:file-proofing',
  ].join('\n')
  return createHash('sha256').update(`${binding}\n`, 'utf8').digest('hex')
}

/** Identifies the protected source or an isolated restore dataset. */
export type CrossDomainIntegrityRole = 'source' | 'restore'

/** Failure categories accepted from the independently implemented file checker. */
export type CrossDomainExternalFileFailureCode =
  | 'FILE_METADATA_OBJECT_MISMATCH'
  | 'FILE_METADATA_OBJECT_MISSING'
  | 'FILE_METADATA_REFERENCE_MISSING'
  | 'FILE_METADATA_TENANT_MISMATCH'

/** Domains with independently comparable aggregate evidence. */
export type CrossDomainIntegrityDomain =
  | 'audit'
  | 'configuration'
  | 'file'
  | 'relation'
  | 'resource'
  | 'work-item'

/** Bounded page request issued to a normalized read adapter. */
export type CrossDomainIntegrityPageRequest = {
  /** Dataset role being read. */
  role: CrossDomainIntegrityRole
  /** Adapter-private continuation cursor from the previous page. */
  cursor?: string
  /** Maximum number of normalized items requested for this page. */
  pageSize: number
  /** Invocation-wide cancellation bound to this finite page request. */
  signal: AbortSignal
}

/** One normalized page returned by a read adapter. */
export type CrossDomainIntegrityPage = {
  /** Normalized cross-domain records. */
  items: readonly CrossDomainIntegrityItem[]
  /** Adapter-private continuation cursor, omitted on the final page. */
  nextCursor?: string
}

/** Port used by restore, migration, and deployment hooks. */
export interface CrossDomainIntegrityReadPort {
  /**
   * Reads one bounded normalized page.
   *
   * @param request - Dataset role, opaque cursor, and requested page size.
   * @returns One page and an optional opaque continuation cursor.
   */
  readPage(request: CrossDomainIntegrityPageRequest): Promise<CrossDomainIntegrityPage>
}

/** Aggregate output from the independently implemented file checker. */
export type CrossDomainExternalFileEvidence = {
  /** Evidence contract version. */
  contractVersion: typeof CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION
  /** Exact number of file versions inspected by that checker. */
  checkedItemCount: number
  /** Aggregate HMAC digest; no per-file digest is accepted. */
  aggregateDigest: string
  /** Stable file failure categories. */
  failureCodes: readonly CrossDomainExternalFileFailureCode[]
}

/** Configured upper bounds captured in every authenticated result. */
export type CrossDomainIntegrityLimits = {
  /** Maximum normalized items accepted from one adapter page. */
  pageSize: number
  /** Maximum number of adapter pages read. */
  maxPages: number
  /** Maximum total normalized records read. */
  maxItems: number
}

/** Supported checker observation modes. */
export type CrossDomainIntegrityObservationMode =
  | 'logical'
  | 'migration-rehearsal-live'

/** Authenticated provenance emitted only for an actual live rehearsal invocation. */
export type CrossDomainIntegrityRehearsalLiveRuntimeProvenance = {
  /** Fixed provenance discriminator. */
  kind: typeof CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND
  /** Provenance contract version. */
  version: 1
  /** Explicit live migration-rehearsal mode. */
  mode: 'migration-rehearsal-live'
  /** Trusted wall-clock sample immediately before the actual checker run. */
  startedAt: string
  /** Trusted wall-clock sample after all external reads completed. */
  completedAt: string
  /** Trusted source of the result's checkedAt timestamp. */
  checkedAtSource: 'trusted-wall-clock-after-external-reads'
}

/** Trusted live timestamps supplied after the bridge completes external reads. */
export type CrossDomainIntegrityLiveRuntimeObservation = {
  /** Trusted wall-clock sample immediately before the checker bridge starts. */
  readonly startedAt: string
  /** Trusted wall-clock sample after every external read completes. */
  readonly completedAt: string
}

/** Versioned input shared by source and restore checks. */
export type RunCrossDomainIntegrityCheckInput = {
  /** Input contract version. */
  contractVersion: typeof CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION
  /** Protected source or isolated restore role. */
  role: CrossDomainIntegrityRole
  /** Caller-supplied canonical UTC timestamp shared by paired source and restore checks. */
  checkedAt: string
  /** Logical mode by default, or explicit actual-runtime rehearsal provenance. */
  observationMode?: CrossDomainIntegrityObservationMode
  /** Required trusted start/completion timestamps for explicit live mode. */
  liveRuntimeObservation?: CrossDomainIntegrityLiveRuntimeObservation
  /** In-memory 32-byte HMAC key. */
  digestKey: Uint8Array
  /** Secret-free digest that binds evidence to the intended logical resource allowlist. */
  resourceBindingDigest: string
  /** Canonical keyed identities for each exact physical resource used by this role. */
  resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[]
  /** Required immutable-incarnation scheme for an actual live rehearsal. */
  resourceIdentityScheme?:
    typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  /** Keyed digest of the exact account, Region, physical tables, and bucket used by this role. */
  resourceIdentityDigest: string
  /** Configured reader limits captured in the authenticated result. */
  limits: CrossDomainIntegrityLimits
  /** Non-resettable total deadline shared with every upstream external read. */
  deadline: CrossDomainIntegrityInvocationDeadline
  /** Bounded normalized reader. */
  reader: CrossDomainIntegrityReadPort
  /** Optional aggregate result from the independent file checker. */
  externalFileEvidence?: CrossDomainExternalFileEvidence
}

/** Aggregate evidence for one independently comparable domain. */
export type CrossDomainDomainEvidence = {
  /** Stable domain name. */
  domain: CrossDomainIntegrityDomain
  /** Exact normalized item count included in the aggregate. */
  itemCount: number
  /** Aggregate HMAC digest with no row-level digests. */
  aggregateDigest: string
}

/** Secret-free aggregate evidence emitted by a check. */
export type CrossDomainIntegrityEvidence = {
  /** HMAC construction identifier. */
  algorithm: 'HMAC-SHA-256'
  /** Aggregate evidence format version. */
  digestVersion: 1
  /** Safe fingerprint proving the same in-memory key was used. */
  keyFingerprint: string
  /** Secret-free digest binding the result to the intended logical resources. */
  resourceBindingDigest: string
  /** Canonical keyed identities for every exact physical resource. */
  resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[]
  /** Present only for live results derived from immutable resource attestations. */
  resourceIdentityScheme?:
    typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
  /** Keyed digest identifying the exact physical resources without exposing their names. */
  resourceIdentityDigest: string
  /** Per-domain aggregates sorted by domain. */
  domains: CrossDomainDomainEvidence[]
  /** Aggregate across all normalized domain digests. */
  aggregateDigest: string
  /** Exact total number of normalized items read. */
  itemCount: number
}

/** Versioned checker result fields authenticated by resultMac. */
export type UnsignedCrossDomainIntegrityResult = {
  /** Result discriminator. */
  kind: typeof CROSS_DOMAIN_INTEGRITY_RESULT_KIND
  /** Result contract version. */
  contractVersion: typeof CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION
  /** Dataset role checked. */
  role: CrossDomainIntegrityRole
  /** Canonical UTC timestamp supplied for this paired check. */
  checkedAt: string
  /** Present only when checkedAt came from the trusted live checker wall clock. */
  runtimeProvenance?: CrossDomainIntegrityRehearsalLiveRuntimeProvenance
  /** Configured read bounds used by this check. */
  limits: CrossDomainIntegrityLimits
  /** Overall result derived from failureCodes. */
  status: 'pass' | 'fail'
  /** Stable failure codes in lexical order. */
  failureCodes: CrossDomainIntegrityFailureCode[]
  /** Explicit invariant ownership. */
  scope: {
    /** Invariants evaluated by this checker. */
    targets: string[]
    /** Explicitly excluded checks. */
    nonTargets: string[]
  }
  /** Aggregate, raw-data-free evidence. */
  evidence: CrossDomainIntegrityEvidence
}

/** Versioned, secret-free checker result with whole-document authentication. */
export type CrossDomainIntegrityResult = UnsignedCrossDomainIntegrityResult & {
  /** HMAC-SHA-256 over every other result field in canonical contract order. */
  resultMac: string
}

/** Versioned comparison result for a source and isolated restore. */
export type CrossDomainIntegrityComparisonResult = {
  /** Comparison discriminator. */
  kind: typeof CROSS_DOMAIN_INTEGRITY_COMPARISON_KIND
  /** Comparison contract version. */
  contractVersion: typeof CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION
  /** Overall result derived from failureCodes. */
  status: 'pass' | 'fail'
  /** Stable failure codes in lexical order. */
  failureCodes: CrossDomainIntegrityFailureCode[]
}

/** Stable failures emitted only by a same-resource migration rehearsal comparison. */
export type CrossDomainIntegrityMigrationRehearsalFailureCode =
  | 'REHEARSAL_AFTER_CHECK_FAILED'
  | 'REHEARSAL_AFTER_RESULT_AUTHENTICATION_FAILED'
  | 'REHEARSAL_AUDIT_DIFFERENCE'
  | 'REHEARSAL_BEFORE_CHECK_FAILED'
  | 'REHEARSAL_BEFORE_RESULT_AUTHENTICATION_FAILED'
  | 'REHEARSAL_CHECKED_AT_ORDER_INVALID'
  | 'REHEARSAL_CONFIGURATION_DIFFERENCE'
  | 'REHEARSAL_FILE_DIFFERENCE'
  | 'REHEARSAL_KEY_MISMATCH'
  | 'REHEARSAL_LIMITS_MISMATCH'
  | 'REHEARSAL_RELATION_DIFFERENCE'
  | 'REHEARSAL_RESOURCE_BINDING_MISMATCH'
  | 'REHEARSAL_RESOURCE_DIFFERENCE'
  | 'REHEARSAL_RESOURCE_IDENTITIES_MISMATCH'
  | 'REHEARSAL_ROLE_MISMATCH'
  | 'REHEARSAL_WORK_ITEM_DIFFERENCE'

/** Versioned comparison result for migration rehearsal checks over one source. */
export type CrossDomainIntegrityMigrationRehearsalComparisonResult = {
  /** Migration rehearsal comparison discriminator. */
  kind: typeof CROSS_DOMAIN_INTEGRITY_MIGRATION_REHEARSAL_COMPARISON_KIND
  /** Comparison contract version. */
  contractVersion: typeof CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION
  /** Overall result derived from failureCodes. */
  status: 'pass' | 'fail'
  /** Stable migration rehearsal failure codes in lexical order. */
  failureCodes: CrossDomainIntegrityMigrationRehearsalFailureCode[]
}

/**
 * Creates one total, non-resettable deadline shared by a complete invocation.
 *
 * @param input - Caller duration, trusted monotonic clock, and cancellation.
 * @returns Opaque deadline capability for every checker and AWS read boundary.
 */
export function createCrossDomainIntegrityInvocationDeadline(
  input: CreateCrossDomainIntegrityInvocationDeadlineInput,
): CrossDomainIntegrityInvocationDeadline {
  if (
    !Number.isSafeInteger(input.maximumDurationMilliseconds) ||
    input.maximumDurationMilliseconds < 1 ||
    input.maximumDurationMilliseconds >
      CROSS_DOMAIN_INTEGRITY_MAX_DURATION_MILLISECONDS ||
    typeof input.monotonicClock !== 'function' ||
    (
      input.signal !== undefined &&
      !(input.signal instanceof AbortSignal)
    )
  ) {
    throw new TypeError('Cross-domain integrity invocation deadline is invalid.')
  }
  const startedAtMilliseconds = readCrossDomainIntegrityMonotonicClock(
    input.monotonicClock,
  )
  const deadlineMilliseconds =
    startedAtMilliseconds + input.maximumDurationMilliseconds
  if (!Number.isSafeInteger(deadlineMilliseconds)) {
    throw new TypeError('Cross-domain integrity invocation deadline is invalid.')
  }
  const capability = new CrossDomainIntegrityInvocationDeadline(
    crossDomainIntegrityInvocationDeadlineToken,
    input.maximumDurationMilliseconds,
  )
  const controller = new AbortController()
  const callerSignal = input.signal
  /** Propagates caller cancellation into the invocation-wide controller. */
  const handleCallerAbort = (): void => {
    const state = crossDomainIntegrityInvocationDeadlineStates.get(capability)
    if (state !== undefined) abortCrossDomainIntegrityDeadline(state, 'CANCELLED')
  }
  const state: CrossDomainIntegrityInvocationDeadlineState = {
    controller,
    deadlineMilliseconds,
    disposeCallerSignal: (): void => {
      callerSignal?.removeEventListener('abort', handleCallerAbort)
    },
    monotonicClock: input.monotonicClock,
    startedAtMilliseconds,
    lastObservedMilliseconds: startedAtMilliseconds,
  }
  crossDomainIntegrityInvocationDeadlineStates.set(capability, state)
  callerSignal?.addEventListener('abort', handleCallerAbort, { once: true })
  if (callerSignal?.aborted === true) handleCallerAbort()
  return capability
}

/**
 * Fails closed when a shared deadline expired, regressed, or was cancelled.
 *
 * @param deadline - Opaque invocation deadline capability.
 */
export function requireCrossDomainIntegrityInvocationDeadline(
  deadline: CrossDomainIntegrityInvocationDeadline,
): void {
  const state = requireCrossDomainIntegrityDeadlineState(deadline)
  readCrossDomainIntegrityDeadlineSample(state, false)
}

/**
 * Reads the positive duration remaining before another bounded operation.
 *
 * @param deadline - Opaque invocation deadline capability.
 * @returns Positive remaining duration in integer milliseconds.
 */
export function readCrossDomainIntegrityInvocationRemainingMilliseconds(
  deadline: CrossDomainIntegrityInvocationDeadline,
): number {
  const state = requireCrossDomainIntegrityDeadlineState(deadline)
  return readCrossDomainIntegrityDeadlineSample(state, true)
}

/**
 * Runs one external request behind the invocation's remaining finite duration.
 *
 * @param deadline - Opaque invocation deadline capability.
 * @param operation - Request issued with the shared invocation AbortSignal.
 * @returns Request result completed before the non-resettable deadline.
 */
export async function runCrossDomainIntegrityRequestWithinDeadline<Result>(
  deadline: CrossDomainIntegrityInvocationDeadline,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> {
  const state = requireCrossDomainIntegrityDeadlineState(deadline)
  const remainingMilliseconds =
    readCrossDomainIntegrityInvocationRemainingMilliseconds(deadline)
  let timeout: ReturnType<typeof setTimeout> | undefined
  /** Rejects the request race with the deadline's stable failure. */
  const rejectForAbort = (
    reject: (reason?: unknown) => void,
  ): (() => void) => () => {
    reject(state.failure ?? new CrossDomainIntegrityDeadlineFailure('CANCELLED'))
  }
  let handleAbort: (() => void) | undefined
  try {
    const cancelled = new Promise<Result>((_resolve, reject) => {
      handleAbort = rejectForAbort(reject)
      state.controller.signal.addEventListener('abort', handleAbort, {
        once: true,
      })
      if (state.controller.signal.aborted) handleAbort()
    })
    timeout = setTimeout(() => {
      abortCrossDomainIntegrityDeadline(state, 'DEADLINE_EXCEEDED')
    }, remainingMilliseconds)
    const result = await Promise.race([
      cancelled,
      Promise.resolve().then(() => operation(state.controller.signal)),
    ])
    readCrossDomainIntegrityDeadlineSample(state, false)
    return result
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    if (handleAbort !== undefined) {
      state.controller.signal.removeEventListener('abort', handleAbort)
    }
  }
}

/**
 * Disposes one invocation deadline and cancels any still-active request.
 *
 * @param deadline - Opaque invocation deadline capability.
 */
export function disposeCrossDomainIntegrityInvocationDeadline(
  deadline: CrossDomainIntegrityInvocationDeadline,
): void {
  const state = crossDomainIntegrityInvocationDeadlineStates.get(deadline)
  if (state === undefined) return
  state.disposeCallerSignal()
  abortCrossDomainIntegrityDeadline(state, 'CANCELLED')
  crossDomainIntegrityInvocationDeadlineStates.delete(deadline)
}

/** Collected records and invariant failures held only in process memory. */
type CrossDomainDataset = {
  /** All records, retained for invariant joins and aggregate hashing. */
  items: CrossDomainIntegrityItem[]
  /** Failures discovered while enforcing reader bounds. */
  readFailures: Set<CrossDomainIntegrityFailureCode>
}

/** In-memory indexes used by the invariant evaluator. */
type CrossDomainIndexes = {
  /** Configuration rows by Workspace/Team scope. */
  configurations: Map<string, CrossDomainConfigurationItem>
  /** Work Items by exact tenant and Team scope. */
  workItems: Map<string, CrossDomainWorkItem>
  /** Work Items grouped by globally repeated ID. */
  workItemsById: Map<string, CrossDomainWorkItem[]>
  /** Workspace members by exact tenant scope. */
  members: Set<string>
  /** Workspace members grouped by repeated key. */
  memberWorkspaces: Map<string, Set<string>>
  /** Teams by exact tenant scope. */
  teams: Set<string>
  /** Teams grouped by repeated ID. */
  teamWorkspaces: Map<string, Set<string>>
  /** Projects by exact tenant and Team scope. */
  projects: Set<string>
  /** Projects grouped by repeated ID. */
  projectsById: Map<string, CrossDomainProject[]>
  /** Relation projections by exact identity. */
  relations: Set<string>
  /** All relation projection rows. */
  relationItems: CrossDomainRelation[]
  /** Sorted relation projection values by exact source Work Item identity. */
  relationProjectionsBySource: Map<string, string[]>
  /** All audit references. */
  auditReferences: CrossDomainAuditReference[]
  /** File metadata by exact object identity. */
  fileMetadata: Map<string, CrossDomainFileMetadata>
  /** All file metadata rows. */
  fileMetadataItems: CrossDomainFileMetadata[]
  /** Object metadata by exact object identity. */
  fileObjects: Map<string, CrossDomainFileObject>
  /** All object metadata rows. */
  fileObjectItems: CrossDomainFileObject[]
  /** File resources by tenant and File ID. */
  files: Set<string>
}

/**
 * Runs the same bounded, read-only cross-domain check for a source or restore.
 *
 * @param input - Versioned role, limits, HMAC key, reader, and optional file evidence.
 * @returns Deterministic aggregate evidence and lexically sorted failures.
 */
export async function runCrossDomainIntegrityCheck(
  input: RunCrossDomainIntegrityCheckInput,
): Promise<CrossDomainIntegrityResult> {
  validateRunInput(input)
  requireCrossDomainIntegrityInvocationDeadline(input.deadline)
  const dataset = await readDataset(input)
  requireCrossDomainIntegrityInvocationDeadline(input.deadline)
  const failures = dataset.readFailures
  const indexes = buildIndexes(dataset.items, failures)
  requireCrossDomainIntegrityInvocationDeadline(input.deadline)
  checkWorkItems(indexes, failures)
  requireCrossDomainIntegrityInvocationDeadline(input.deadline)
  checkRelations(indexes, failures)
  requireCrossDomainIntegrityInvocationDeadline(input.deadline)
  checkAuditReferences(indexes, failures)
  requireCrossDomainIntegrityInvocationDeadline(input.deadline)
  checkFiles(indexes, failures)
  requireCrossDomainIntegrityInvocationDeadline(input.deadline)
  const acceptedExternalFileEvidence = input.externalFileEvidence &&
      input.externalFileEvidence.checkedItemCount <= input.limits.maxItems
    ? input.externalFileEvidence
    : undefined
  if (acceptedExternalFileEvidence) {
    for (const code of acceptedExternalFileEvidence.failureCodes) failures.add(code)
  }
  const evidence = createEvidence(
    dataset.items,
    input.digestKey,
    input.resourceBindingDigest,
    input.resourceIdentities,
    input.resourceIdentityScheme,
    input.resourceIdentityDigest,
    acceptedExternalFileEvidence,
  )
  requireCrossDomainIntegrityInvocationDeadline(input.deadline)
  const failureCodes = [...failures].sort(compareUtf8Ordinal)
  const unsignedResult: UnsignedCrossDomainIntegrityResult = {
    kind: CROSS_DOMAIN_INTEGRITY_RESULT_KIND,
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role: input.role,
    checkedAt: input.checkedAt,
    ...createRuntimeProvenanceFields(
      input.observationMode ?? 'logical',
      input.liveRuntimeObservation,
    ),
    limits: { ...input.limits },
    status: failureCodes.length === 0 ? 'pass' : 'fail',
    failureCodes,
    scope: {
      targets: [...CROSS_DOMAIN_INTEGRITY_TARGETS],
      nonTargets: [...CROSS_DOMAIN_INTEGRITY_NON_TARGETS],
    },
    evidence,
  }
  const result = authenticateCrossDomainIntegrityResult(
    unsignedResult,
    input.digestKey,
  )
  requireCrossDomainIntegrityInvocationDeadline(input.deadline)
  return result
}

/**
 * Adds a whole-result MAC after strict structural validation.
 *
 * @param result - Every result field except resultMac.
 * @param digestKey - In-memory 32-byte HMAC key.
 * @returns A normalized result authenticated over every other field.
 */
export function authenticateCrossDomainIntegrityResult(
  result: UnsignedCrossDomainIntegrityResult,
  digestKey: Uint8Array,
): CrossDomainIntegrityResult {
  validateDigestKey(digestKey)
  const parsed = parseCrossDomainIntegrityResult({
    ...result,
    resultMac: '0'.repeat(64),
  })
  const unsigned = createUnsignedResult(parsed)
  return {
    ...unsigned,
    resultMac: calculateResultMac(unsigned, digestKey),
  }
}

/**
 * Verifies strict result structure and its whole-document MAC.
 *
 * @param value - Untrusted parsed JSON or an in-memory result.
 * @param digestKey - In-memory 32-byte HMAC key.
 * @returns True only when strict parsing and MAC authentication both succeed.
 */
export function verifyCrossDomainIntegrityResult(value: unknown, digestKey: Uint8Array): boolean {
  return parseAuthenticatedResult(value, digestKey) !== undefined
}

/** Strictly parses and authenticates one result for trusted internal comparison. */
function parseAuthenticatedResult(
  value: unknown,
  digestKey: Uint8Array,
): CrossDomainIntegrityResult | undefined {
  if (digestKey.byteLength !== DIGEST_KEY_BYTE_LENGTH) return undefined
  try {
    const result = parseCrossDomainIntegrityResult(value)
    const expected = Buffer.from(calculateResultMac(createUnsignedResult(result), digestKey), 'hex')
    const actual = Buffer.from(result.resultMac, 'hex')
    if (!timingSafeEqual(expected, actual)) return undefined
    const resourceIdentityDigest =
      calculateCrossDomainIntegrityResourceIdentityDigest(
        result.evidence.resourceIdentities,
        digestKey,
      )
    if (resourceIdentityDigest !== result.evidence.resourceIdentityDigest) return undefined
    const aggregateDigest = calculateEvidenceAggregateDigest(
      digestKey,
      result.evidence.resourceBindingDigest,
      result.evidence.domains,
    )
    return aggregateDigest === result.evidence.aggregateDigest ? result : undefined
  } catch {
    return undefined
  }
}

/**
 * Strictly parses an untrusted serialized checker result without authenticating its MAC.
 *
 * @param value - Untrusted JSON-compatible value.
 * @returns A normalized exact-key result ready for MAC verification.
 */
export function parseCrossDomainIntegrityResult(value: unknown): CrossDomainIntegrityResult {
  const record = requireRecord(value, 'Cross-domain integrity result')
  const expectedKeys = [
    'checkedAt',
    'contractVersion',
    'evidence',
    'failureCodes',
    'kind',
    'limits',
    'resultMac',
    'role',
    'scope',
    'status',
  ]
  if (Object.hasOwn(record, 'runtimeProvenance')) {
    expectedKeys.push('runtimeProvenance')
  }
  requireExactKeys(record, expectedKeys, 'Cross-domain integrity result')
  if (record.kind !== CROSS_DOMAIN_INTEGRITY_RESULT_KIND) {
    throw new TypeError('Cross-domain integrity result kind is invalid.')
  }
  if (record.contractVersion !== CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION) {
    throw new TypeError('Cross-domain integrity result contract version is invalid.')
  }
  const role = parseRole(record.role)
  const checkedAt = parseCheckedAt(record.checkedAt)
  const runtimeProvenance = Object.hasOwn(record, 'runtimeProvenance')
    ? parseRehearsalLiveRuntimeProvenance(record.runtimeProvenance)
    : undefined
  if (
    runtimeProvenance !== undefined &&
    (
      runtimeProvenance.completedAt !== checkedAt ||
      Date.parse(runtimeProvenance.startedAt) >
        Date.parse(runtimeProvenance.completedAt)
    )
  ) {
    throw new TypeError(
      'Cross-domain integrity live runtime provenance timestamps are invalid.',
    )
  }
  const limits = parseLimits(record.limits)
  const failureCodes = parseFailureCodes(record.failureCodes)
  const status = parseResultStatus(record.status, failureCodes)
  const scope = parseResultScope(record.scope)
  const evidence = parseResultEvidence(record.evidence, limits)
  if (
    (runtimeProvenance !== undefined) !==
      (evidence.resourceIdentityScheme ===
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME)
  ) {
    throw new TypeError(
      'Cross-domain integrity live results require immutable resource identities.',
    )
  }
  const resultMac = requireHexDigest(record.resultMac, 'Cross-domain integrity result MAC')
  return {
    kind: CROSS_DOMAIN_INTEGRITY_RESULT_KIND,
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    role,
    checkedAt,
    ...(runtimeProvenance === undefined ? {} : { runtimeProvenance }),
    limits,
    status,
    failureCodes,
    scope,
    evidence,
    resultMac,
  }
}

/**
 * Strictly parses one exact live rehearsal runtime-provenance object.
 *
 * @param value - Untrusted optional result field.
 * @returns Normalized exact live provenance.
 */
function parseRehearsalLiveRuntimeProvenance(
  value: unknown,
): CrossDomainIntegrityRehearsalLiveRuntimeProvenance {
  const record = requireRecord(
    value,
    'Cross-domain integrity live runtime provenance',
  )
  requireExactKeys(record, [
    'checkedAtSource',
    'completedAt',
    'kind',
    'mode',
    'startedAt',
    'version',
  ], 'Cross-domain integrity live runtime provenance')
  if (
    record.kind !== CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND ||
    record.version !== 1 ||
    record.mode !== 'migration-rehearsal-live' ||
    record.checkedAtSource !== 'trusted-wall-clock-after-external-reads'
  ) {
    throw new TypeError(
      'Cross-domain integrity live runtime provenance is invalid.',
    )
  }
  return {
    kind: CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
    version: 1,
    mode: 'migration-rehearsal-live',
    startedAt: parseCheckedAt(record.startedAt),
    completedAt: parseCheckedAt(record.completedAt),
    checkedAtSource: 'trusted-wall-clock-after-external-reads',
  }
}

/** Parses a protected source or isolated restore role. */
function parseRole(value: unknown): CrossDomainIntegrityRole {
  if (value === 'source' || value === 'restore') return value
  throw new TypeError('Cross-domain integrity result role is invalid.')
}

/** Parses and normalizes the canonical result timestamp. */
function parseCheckedAt(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('Cross-domain integrity result checkedAt is invalid.')
  }
  validateCanonicalCheckedAt(value)
  return value
}

/** Parses exact configured reader limits. */
function parseLimits(value: unknown): CrossDomainIntegrityLimits {
  const record = requireRecord(value, 'Cross-domain integrity limits')
  requireExactKeys(record, ['maxItems', 'maxPages', 'pageSize'], 'Cross-domain integrity limits')
  const pageSize = record.pageSize
  const maxPages = record.maxPages
  const maxItems = record.maxItems
  if (
    typeof pageSize !== 'number' ||
    typeof maxPages !== 'number' ||
    typeof maxItems !== 'number'
  ) {
    throw new TypeError('Cross-domain integrity limits are invalid.')
  }
  const limits: CrossDomainIntegrityLimits = { pageSize, maxPages, maxItems }
  validateCrossDomainIntegrityLimits(limits)
  return limits
}

/** Parses known, unique failure codes in UTF-8 ordinal order. */
function parseFailureCodes(value: unknown): CrossDomainIntegrityFailureCode[] {
  if (!isUnknownArray(value)) {
    throw new TypeError('Cross-domain integrity failureCodes must be an array.')
  }
  const failureCodes: CrossDomainIntegrityFailureCode[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !isKnownFailureCode(entry)) {
      throw new TypeError('Cross-domain integrity failureCodes contains an unknown code.')
    }
    failureCodes.push(entry)
  }
  if (!isUtf8OrdinalSortedUnique(failureCodes)) {
    throw new TypeError('Cross-domain integrity failureCodes must be sorted and unique.')
  }
  return failureCodes
}

/** Parses status and verifies it agrees with the failure array. */
function parseResultStatus(
  value: unknown,
  failureCodes: readonly CrossDomainIntegrityFailureCode[],
): 'pass' | 'fail' {
  if (value !== 'pass' && value !== 'fail') {
    throw new TypeError('Cross-domain integrity result status is invalid.')
  }
  if ((value === 'pass') !== (failureCodes.length === 0)) {
    throw new TypeError('Cross-domain integrity result status does not match failureCodes.')
  }
  return value
}

/** Parses the exact documented invariant scope. */
function parseResultScope(value: unknown): CrossDomainIntegrityResult['scope'] {
  const record = requireRecord(value, 'Cross-domain integrity scope')
  requireExactKeys(record, ['nonTargets', 'targets'], 'Cross-domain integrity scope')
  return {
    targets: parseExactStringArray(
      record.targets,
      CROSS_DOMAIN_INTEGRITY_TARGETS,
      'Cross-domain integrity targets',
    ),
    nonTargets: parseExactStringArray(
      record.nonTargets,
      CROSS_DOMAIN_INTEGRITY_NON_TARGETS,
      'Cross-domain integrity nonTargets',
    ),
  }
}

/** Parses all aggregate evidence and enforces exact domain ordering and counts. */
function parseResultEvidence(
  value: unknown,
  limits: CrossDomainIntegrityLimits,
): CrossDomainIntegrityEvidence {
  const record = requireRecord(value, 'Cross-domain integrity evidence')
  const expectedKeys = [
    'aggregateDigest',
    'algorithm',
    'digestVersion',
    'domains',
    'itemCount',
    'keyFingerprint',
    'resourceBindingDigest',
    'resourceIdentities',
    'resourceIdentityDigest',
  ]
  if (Object.hasOwn(record, 'resourceIdentityScheme')) {
    expectedKeys.push('resourceIdentityScheme')
  }
  requireExactKeys(record, expectedKeys, 'Cross-domain integrity evidence')
  if (record.algorithm !== 'HMAC-SHA-256' || record.digestVersion !== 1) {
    throw new TypeError('Cross-domain integrity evidence algorithm or version is invalid.')
  }
  const domains = parseDomainEvidence(record.domains, limits.maxItems)
  const itemCount = requireNonNegativeInteger(
    record.itemCount,
    limits.maxItems,
    'Cross-domain integrity itemCount',
  )
  const domainItemCount = domains.reduce((total, domain) => total + domain.itemCount, 0)
  if (!Number.isSafeInteger(domainItemCount) || domainItemCount !== itemCount) {
    throw new TypeError('Cross-domain integrity domain counts do not match itemCount.')
  }
  return {
    algorithm: 'HMAC-SHA-256',
    digestVersion: 1,
    keyFingerprint: requireHexDigest(
      record.keyFingerprint,
      'Cross-domain integrity key fingerprint',
    ),
    resourceBindingDigest: requireHexDigest(
      record.resourceBindingDigest,
      'Cross-domain integrity resource binding digest',
    ),
    resourceIdentities: parseCrossDomainIntegrityResourceIdentities(
      record.resourceIdentities,
    ),
    ...(record.resourceIdentityScheme === undefined
      ? {}
      : record.resourceIdentityScheme ===
          CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME
      ? {
          resourceIdentityScheme:
            CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME,
        }
      : failResourceIdentityScheme()),
    resourceIdentityDigest: requireHexDigest(
      record.resourceIdentityDigest,
      'Cross-domain integrity resource identity digest',
    ),
    domains,
    aggregateDigest: requireHexDigest(
      record.aggregateDigest,
      'Cross-domain integrity aggregate digest',
    ),
    itemCount,
  }
}

/** Raises one stable strict-parser failure for an unknown identity scheme. */
function failResourceIdentityScheme(): never {
  throw new TypeError(
    'Cross-domain integrity resource identity scheme is invalid.',
  )
}

/** Parses the complete lexically ordered domain evidence vector. */
function parseDomainEvidence(
  value: unknown,
  maximumItemCount: number,
): CrossDomainDomainEvidence[] {
  if (!isUnknownArray(value)) {
    throw new TypeError('Cross-domain integrity domains must be an array.')
  }
  const expectedDomains = integrityDomains()
  if (value.length !== expectedDomains.length) {
    throw new TypeError('Cross-domain integrity domains are incomplete.')
  }
  const domains: CrossDomainDomainEvidence[] = []
  for (let index = 0; index < expectedDomains.length; index += 1) {
    const expectedDomain = expectedDomains[index]
    const record = requireRecord(value[index], 'Cross-domain integrity domain evidence')
    requireExactKeys(
      record,
      ['aggregateDigest', 'domain', 'itemCount'],
      'Cross-domain integrity domain evidence',
    )
    if (expectedDomain === undefined || record.domain !== expectedDomain) {
      throw new TypeError('Cross-domain integrity domains are not in canonical order.')
    }
    domains.push({
      domain: expectedDomain,
      itemCount: requireNonNegativeInteger(
        record.itemCount,
        maximumItemCount,
        'Cross-domain integrity domain itemCount',
      ),
      aggregateDigest: requireHexDigest(
        record.aggregateDigest,
        'Cross-domain integrity domain aggregate digest',
      ),
    })
  }
  return domains
}

/** Returns a normalized copy containing every MAC-authenticated field. */
function createUnsignedResult(
  result: CrossDomainIntegrityResult,
): UnsignedCrossDomainIntegrityResult {
  return {
    kind: result.kind,
    contractVersion: result.contractVersion,
    role: result.role,
    checkedAt: result.checkedAt,
    ...(result.runtimeProvenance === undefined
      ? {}
      : { runtimeProvenance: { ...result.runtimeProvenance } }),
    limits: { ...result.limits },
    status: result.status,
    failureCodes: [...result.failureCodes],
    scope: {
      targets: [...result.scope.targets],
      nonTargets: [...result.scope.nonTargets],
    },
    evidence: {
      ...result.evidence,
      domains: result.evidence.domains.map((domain) => ({ ...domain })),
      resourceIdentities: result.evidence.resourceIdentities.map((identity) => ({
        ...identity,
      })),
    },
  }
}

/** Calculates the whole-result domain-separated HMAC. */
function calculateResultMac(
  result: UnsignedCrossDomainIntegrityResult,
  digestKey: Uint8Array,
): string {
  return createDomainHmac(digestKey, 'result-mac-v1')
    .update(canonicalizeUnsignedResult(result), 'utf8')
    .digest('hex')
}

/** Canonicalizes every result field except resultMac in fixed contract order. */
function canonicalizeUnsignedResult(result: UnsignedCrossDomainIntegrityResult): string {
  const fields = [
    result.kind,
    String(result.contractVersion),
    result.role,
    result.checkedAt,
    String(result.limits.pageSize),
    String(result.limits.maxPages),
    String(result.limits.maxItems),
    result.status,
    String(result.failureCodes.length),
    ...result.failureCodes,
    String(result.scope.targets.length),
    ...result.scope.targets,
    String(result.scope.nonTargets.length),
    ...result.scope.nonTargets,
    result.evidence.algorithm,
    String(result.evidence.digestVersion),
    result.evidence.keyFingerprint,
    result.evidence.resourceBindingDigest,
  ]
  if (result.evidence.resourceIdentityScheme !== undefined) {
    fields.push(result.evidence.resourceIdentityScheme)
  }
  fields.push(String(result.evidence.resourceIdentities.length))
  for (const identity of result.evidence.resourceIdentities) {
    fields.push(identity.target, identity.identityDigest)
  }
  fields.push(
    result.evidence.resourceIdentityDigest,
    String(result.evidence.domains.length),
  )
  for (const domain of result.evidence.domains) {
    fields.push(domain.domain, String(domain.itemCount), domain.aggregateDigest)
  }
  fields.push(result.evidence.aggregateDigest, String(result.evidence.itemCount))
  if (result.runtimeProvenance !== undefined) {
    fields.push(
      result.runtimeProvenance.kind,
      String(result.runtimeProvenance.version),
      result.runtimeProvenance.mode,
      result.runtimeProvenance.startedAt,
      result.runtimeProvenance.completedAt,
      result.runtimeProvenance.checkedAtSource,
    )
  }
  return canonicalFields(fields)
}

/**
 * Creates the optional result fields for a validated observation mode.
 *
 * @param observationMode - Logical or explicit live observation mode.
 * @param liveRuntimeObservation - Trusted live timestamps when required.
 * @returns Empty logical fields or exact live runtime provenance.
 */
function createRuntimeProvenanceFields(
  observationMode: CrossDomainIntegrityObservationMode,
  liveRuntimeObservation: CrossDomainIntegrityLiveRuntimeObservation | undefined,
): { readonly runtimeProvenance?: CrossDomainIntegrityRehearsalLiveRuntimeProvenance } {
  if (observationMode === 'logical') return {}
  if (liveRuntimeObservation === undefined) {
    throw new TypeError(
      'Cross-domain integrity live runtime observation is required.',
    )
  }
  return {
    runtimeProvenance: {
      kind: CROSS_DOMAIN_INTEGRITY_REHEARSAL_LIVE_PROVENANCE_KIND,
      version: 1,
      mode: 'migration-rehearsal-live',
      startedAt: liveRuntimeObservation.startedAt,
      completedAt: liveRuntimeObservation.completedAt,
      checkedAtSource: 'trusted-wall-clock-after-external-reads',
    },
  }
}

/** Narrows an unknown value to a non-array record. */
function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${name} must be an object.`)
  return value
}

/** Returns whether an unknown value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Returns whether an unknown value is an array whose elements remain unknown. */
function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** Rejects both missing and unknown object fields. */
function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort(compareUtf8Ordinal)
  const expected = [...expectedKeys].sort(compareUtf8Ordinal)
  if (!sameStrings(actual, expected)) throw new TypeError(`${name} fields are invalid.`)
}

/** Parses one exact fixed-order string array. */
function parseExactStringArray(
  value: unknown,
  expected: readonly string[],
  name: string,
): string[] {
  if (!isUnknownArray(value) || value.length !== expected.length) {
    throw new TypeError(`${name} is invalid.`)
  }
  const parsed: string[] = []
  for (let index = 0; index < expected.length; index += 1) {
    const actual = value[index]
    const required = expected[index]
    if (typeof actual !== 'string' || required === undefined || actual !== required) {
      throw new TypeError(`${name} is invalid.`)
    }
    parsed.push(actual)
  }
  return parsed
}

/** Parses one lowercase 32-byte hexadecimal digest. */
function requireHexDigest(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${name} is invalid.`)
  }
  return value
}

/** Parses one non-negative safe integer within an explicit maximum. */
function requireNonNegativeInteger(value: unknown, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > maximum) {
    throw new TypeError(`${name} is invalid.`)
  }
  return value
}

/** Narrows a string to the complete stable failure-code set. */
function isKnownFailureCode(value: string): value is CrossDomainIntegrityFailureCode {
  return KNOWN_FAILURE_CODES.has(value)
}

/** Returns whether values are strictly increasing in UTF-8 ordinal order. */
function isUtf8OrdinalSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous === undefined || current === undefined || compareUtf8Ordinal(previous, current) >= 0) {
      return false
    }
  }
  return true
}

/** Returns whether both authenticated results used identical configured bounds. */
function sameLimits(left: CrossDomainIntegrityLimits, right: CrossDomainIntegrityLimits): boolean {
  return left.pageSize === right.pageSize &&
    left.maxPages === right.maxPages &&
    left.maxItems === right.maxItems
}

/**
 * Compares source and restore aggregate evidence without raw tenant data.
 *
 * @param sourceValue - Untrusted result created for the protected source.
 * @param restoreValue - Untrusted result created for an isolated restore.
 * @param digestKey - In-memory HMAC key used to authenticate both results.
 * @returns Deterministically classified domain differences.
 */
export function compareCrossDomainIntegrityResults(
  sourceValue: unknown,
  restoreValue: unknown,
  digestKey: Uint8Array,
): CrossDomainIntegrityComparisonResult {
  const failures = new Set<CrossDomainIntegrityFailureCode>()
  const source = parseAuthenticatedResult(sourceValue, digestKey)
  const restore = parseAuthenticatedResult(restoreValue, digestKey)
  if (!source) failures.add('SOURCE_RESULT_AUTHENTICATION_FAILED')
  if (!restore) failures.add('RESTORE_RESULT_AUTHENTICATION_FAILED')
  if (!source || !restore) {
    return createComparisonResult(failures)
  }
  if (source.role !== 'source' || restore.role !== 'restore') {
    failures.add('SOURCE_RESTORE_ROLE_MISMATCH')
  }
  if (source.checkedAt !== restore.checkedAt) {
    failures.add('SOURCE_RESTORE_CHECKED_AT_MISMATCH')
  }
  if (!sameLimits(source.limits, restore.limits)) {
    failures.add('SOURCE_RESTORE_LIMITS_MISMATCH')
  }
  if (source.status === 'fail') failures.add('SOURCE_CHECK_FAILED')
  if (restore.status === 'fail') failures.add('RESTORE_CHECK_FAILED')
  const keyMatches = source.evidence.keyFingerprint === restore.evidence.keyFingerprint
  if (!keyMatches) {
    failures.add('SOURCE_RESTORE_KEY_MISMATCH')
  }
  const resourceBindingMatches =
    source.evidence.resourceBindingDigest === restore.evidence.resourceBindingDigest
  if (!resourceBindingMatches) {
    failures.add('SOURCE_RESTORE_RESOURCE_BINDING_MISMATCH')
  }
  if (hasReusedResourceIdentity(
    source.evidence.resourceIdentities,
    restore.evidence.resourceIdentities,
  )) {
    failures.add('SOURCE_RESTORE_RESOURCE_IDENTITY_REUSED')
  }
  if (keyMatches && resourceBindingMatches) {
    const sourceDomains = new Map(source.evidence.domains.map((entry) => [entry.domain, entry]))
    const restoreDomains = new Map(restore.evidence.domains.map((entry) => [entry.domain, entry]))
    for (const domain of integrityDomains()) {
      const sourceDomain = sourceDomains.get(domain)
      const restoreDomain = restoreDomains.get(domain)
      if (
        !sourceDomain ||
        !restoreDomain ||
        sourceDomain.itemCount !== restoreDomain.itemCount ||
        sourceDomain.aggregateDigest !== restoreDomain.aggregateDigest
      ) {
        failures.add(domainDifferenceCode(domain))
      }
    }
  }
  return createComparisonResult(failures)
}

/**
 * Compares authenticated before and after checks over the same migration source.
 *
 * This contract is deliberately separate from the source/restore comparator:
 * rehearsal inputs must reuse the exact physical resources and the after check
 * must occur strictly later, while a restore comparison requires distinct
 * physical resources observed at the same checkedAt instant.
 *
 * @param beforeValue - Untrusted source result captured before migration.
 * @param afterValue - Untrusted source result captured after verify or rollback.
 * @param digestKey - In-memory HMAC key used to authenticate both results.
 * @returns Deterministically classified same-resource rehearsal differences.
 */
export function compareCrossDomainIntegrityMigrationRehearsalResults(
  beforeValue: unknown,
  afterValue: unknown,
  digestKey: Uint8Array,
): CrossDomainIntegrityMigrationRehearsalComparisonResult {
  const failures =
    new Set<CrossDomainIntegrityMigrationRehearsalFailureCode>()
  const before = parseAuthenticatedResult(beforeValue, digestKey)
  const after = parseAuthenticatedResult(afterValue, digestKey)
  if (!before) {
    failures.add('REHEARSAL_BEFORE_RESULT_AUTHENTICATION_FAILED')
  }
  if (!after) {
    failures.add('REHEARSAL_AFTER_RESULT_AUTHENTICATION_FAILED')
  }
  if (!before || !after) {
    return createMigrationRehearsalComparisonResult(failures)
  }
  if (before.role !== 'source' || after.role !== 'source') {
    failures.add('REHEARSAL_ROLE_MISMATCH')
  }
  if (Date.parse(after.checkedAt) <= Date.parse(before.checkedAt)) {
    failures.add('REHEARSAL_CHECKED_AT_ORDER_INVALID')
  }
  const limitsMatch = sameLimits(before.limits, after.limits)
  if (!limitsMatch) {
    failures.add('REHEARSAL_LIMITS_MISMATCH')
  }
  if (before.status === 'fail') {
    failures.add('REHEARSAL_BEFORE_CHECK_FAILED')
  }
  if (after.status === 'fail') {
    failures.add('REHEARSAL_AFTER_CHECK_FAILED')
  }
  const keyMatches =
    before.evidence.keyFingerprint === after.evidence.keyFingerprint
  if (!keyMatches) {
    failures.add('REHEARSAL_KEY_MISMATCH')
  }
  const resourceBindingMatches =
    before.evidence.resourceBindingDigest ===
      after.evidence.resourceBindingDigest
  if (!resourceBindingMatches) {
    failures.add('REHEARSAL_RESOURCE_BINDING_MISMATCH')
  }
  const resourceIdentitiesMatch =
    before.evidence.resourceIdentityDigest ===
      after.evidence.resourceIdentityDigest &&
    sameResourceIdentities(
      before.evidence.resourceIdentities,
      after.evidence.resourceIdentities,
    )
  if (!resourceIdentitiesMatch) {
    failures.add('REHEARSAL_RESOURCE_IDENTITIES_MISMATCH')
  }
  if (
    limitsMatch &&
    keyMatches &&
    resourceBindingMatches &&
    resourceIdentitiesMatch
  ) {
    const domains = integrityDomains()
    for (let index = 0; index < domains.length; index += 1) {
      const domain = domains[index]
      const beforeDomain = before.evidence.domains[index]
      const afterDomain = after.evidence.domains[index]
      if (
        domain === undefined ||
        beforeDomain === undefined ||
        afterDomain === undefined ||
        beforeDomain.domain !== domain ||
        afterDomain.domain !== domain ||
        beforeDomain.itemCount !== afterDomain.itemCount ||
        beforeDomain.aggregateDigest !== afterDomain.aggregateDigest
      ) {
        if (domain !== undefined) {
          failures.add(migrationRehearsalDomainDifferenceCode(domain))
        }
      }
    }
  }
  return createMigrationRehearsalComparisonResult(failures)
}

/**
 * Checks whether a source physical resource was reused for the same restore target.
 *
 * @param source - Authenticated canonical source identity vector.
 * @param restore - Authenticated canonical restore identity vector.
 * @returns True when any corresponding keyed physical identity is equal.
 */
function hasReusedResourceIdentity(
  source: readonly CrossDomainIntegrityResourceIdentity[],
  restore: readonly CrossDomainIntegrityResourceIdentity[],
): boolean {
  for (
    let index = 0;
    index < CROSS_DOMAIN_INTEGRITY_RESOURCE_TARGETS.length;
    index += 1
  ) {
    const sourceIdentity = source[index]
    const restoreIdentity = restore[index]
    if (
      sourceIdentity !== undefined &&
      restoreIdentity !== undefined &&
      sourceIdentity.target === restoreIdentity.target &&
      sourceIdentity.identityDigest === restoreIdentity.identityDigest
    ) {
      return true
    }
  }
  return false
}

/**
 * Compares complete canonical physical-resource identity vectors exactly.
 *
 * @param before - Authenticated resource identities captured before migration.
 * @param after - Authenticated resource identities captured after migration.
 * @returns Whether every target and keyed physical identity is unchanged.
 */
function sameResourceIdentities(
  before: readonly CrossDomainIntegrityResourceIdentity[],
  after: readonly CrossDomainIntegrityResourceIdentity[],
): boolean {
  if (before.length !== after.length) return false
  for (let index = 0; index < before.length; index += 1) {
    const beforeIdentity = before[index]
    const afterIdentity = after[index]
    if (
      beforeIdentity === undefined ||
      afterIdentity === undefined ||
      beforeIdentity.target !== afterIdentity.target ||
      beforeIdentity.identityDigest !== afterIdentity.identityDigest
    ) {
      return false
    }
  }
  return true
}

/** Creates one stable comparison result from accumulated failure codes. */
function createComparisonResult(
  failures: ReadonlySet<CrossDomainIntegrityFailureCode>,
): CrossDomainIntegrityComparisonResult {
  const failureCodes = [...failures].sort(compareUtf8Ordinal)
  return {
    kind: CROSS_DOMAIN_INTEGRITY_COMPARISON_KIND,
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    status: failureCodes.length === 0 ? 'pass' : 'fail',
    failureCodes,
  }
}

/**
 * Creates one stable same-resource migration rehearsal comparison result.
 *
 * @param failures - Accumulated dedicated rehearsal failures.
 * @returns Canonical bounded comparison result.
 */
function createMigrationRehearsalComparisonResult(
  failures: ReadonlySet<CrossDomainIntegrityMigrationRehearsalFailureCode>,
): CrossDomainIntegrityMigrationRehearsalComparisonResult {
  const failureCodes = [...failures].sort(compareUtf8Ordinal)
  return {
    kind: CROSS_DOMAIN_INTEGRITY_MIGRATION_REHEARSAL_COMPARISON_KIND,
    contractVersion: CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION,
    status: failureCodes.length === 0 ? 'pass' : 'fail',
    failureCodes,
  }
}

/** Validates caller-controlled bounds and the in-memory digest key. */
function validateRunInput(input: RunCrossDomainIntegrityCheckInput): void {
  if (input.contractVersion !== CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION) {
    throw new TypeError('Unsupported cross-domain integrity contract version.')
  }
  validateCanonicalCheckedAt(input.checkedAt)
  if (
    input.observationMode !== undefined &&
    input.observationMode !== 'logical' &&
    input.observationMode !== 'migration-rehearsal-live'
  ) {
    throw new TypeError('Cross-domain integrity observation mode is invalid.')
  }
  if ((input.observationMode ?? 'logical') === 'logical') {
    if (
      input.liveRuntimeObservation !== undefined ||
      input.resourceIdentityScheme !== undefined
    ) {
      throw new TypeError(
        'Cross-domain integrity logical checks cannot carry live-only fields.',
      )
    }
  } else {
    const observation = input.liveRuntimeObservation
    if (observation === undefined) {
      throw new TypeError(
        'Cross-domain integrity live runtime observation is required.',
      )
    }
    validateCanonicalCheckedAt(observation.startedAt)
    validateCanonicalCheckedAt(observation.completedAt)
    if (
      input.resourceIdentityScheme !==
        CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME ||
      input.checkedAt !== observation.completedAt ||
      Date.parse(observation.startedAt) > Date.parse(observation.completedAt)
    ) {
      throw new TypeError(
        'Cross-domain integrity live runtime observation timestamps are invalid.',
      )
    }
  }
  validateDigestKey(input.digestKey)
  if (!/^[0-9a-f]{64}$/u.test(input.resourceBindingDigest)) {
    throw new TypeError('Cross-domain integrity resource binding digest must be 64 lowercase hex characters.')
  }
  if (!/^[0-9a-f]{64}$/u.test(input.resourceIdentityDigest)) {
    throw new TypeError('Cross-domain integrity resource identity digest must be 64 lowercase hex characters.')
  }
  const expectedResourceIdentityDigest =
    calculateCrossDomainIntegrityResourceIdentityDigest(
      input.resourceIdentities,
      input.digestKey,
    )
  if (input.resourceIdentityDigest !== expectedResourceIdentityDigest) {
    throw new TypeError(
      'Cross-domain integrity resource identity digest does not match its canonical vector.',
    )
  }
  validateCrossDomainIntegrityLimits(input.limits)
  if (input.externalFileEvidence) validateExternalFileEvidence(input.externalFileEvidence)
}

/** Validates the fixed-size in-memory HMAC key. */
function validateDigestKey(digestKey: Uint8Array): void {
  if (digestKey.byteLength !== DIGEST_KEY_BYTE_LENGTH) {
    throw new TypeError('Cross-domain integrity digest key must contain exactly 32 bytes.')
  }
}

/** Validates a canonical millisecond-precision UTC timestamp. */
function validateCanonicalCheckedAt(checkedAt: string): void {
  const milliseconds = Date.parse(checkedAt)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== checkedAt) {
    throw new TypeError('Cross-domain integrity checkedAt must be a canonical UTC timestamp.')
  }
}

/**
 * Validates all configured cross-domain integrity read bounds.
 *
 * @param limits - Caller-controlled page and normalized-item ceilings.
 */
export function validateCrossDomainIntegrityLimits(
  limits: CrossDomainIntegrityLimits,
): void {
  validatePositiveBound(limits.pageSize, MAX_PAGE_SIZE, 'pageSize')
  validatePositiveBound(limits.maxPages, MAX_PAGE_COUNT, 'maxPages')
  validatePositiveBound(limits.maxItems, MAX_ITEM_COUNT, 'maxItems')
  const rawPageCapacity = limits.maxPages * limits.pageSize
  if (rawPageCapacity > MAX_ITEM_COUNT) {
    throw new TypeError(
      `Configured raw page capacity must not exceed ${MAX_ITEM_COUNT}.`,
    )
  }
  if (limits.maxItems > rawPageCapacity) {
    throw new TypeError(
      'maxItems must not exceed the configured page capacity.',
    )
  }
}

/** Validates one positive bounded integer. */
function validatePositiveBound(value: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}.`)
  }
}

/** Reads the private state for one authentic, active deadline capability. */
function requireCrossDomainIntegrityDeadlineState(
  deadline: CrossDomainIntegrityInvocationDeadline,
): CrossDomainIntegrityInvocationDeadlineState {
  const state = crossDomainIntegrityInvocationDeadlineStates.get(deadline)
  if (state === undefined) {
    throw new TypeError('Cross-domain integrity invocation deadline is invalid.')
  }
  if (state.controller.signal.aborted) {
    throw state.failure ?? new CrossDomainIntegrityDeadlineFailure('CANCELLED')
  }
  return state
}

/** Reads one monotonic sample and enforces the invocation deadline. */
function readCrossDomainIntegrityDeadlineSample(
  state: CrossDomainIntegrityInvocationDeadlineState,
  requirePositiveRemainingDuration: boolean,
): number {
  if (state.controller.signal.aborted) {
    throw state.failure ?? new CrossDomainIntegrityDeadlineFailure('CANCELLED')
  }
  let now: number
  try {
    now = readCrossDomainIntegrityMonotonicClock(state.monotonicClock)
  } catch {
    abortCrossDomainIntegrityDeadline(state, 'CLOCK_INVALID')
    throw state.failure
  }
  if (state.controller.signal.aborted) {
    throw state.failure ?? new CrossDomainIntegrityDeadlineFailure('CANCELLED')
  }
  if (
    now < state.startedAtMilliseconds ||
    now < state.lastObservedMilliseconds
  ) {
    abortCrossDomainIntegrityDeadline(state, 'CLOCK_INVALID')
    throw state.failure
  }
  state.lastObservedMilliseconds = now
  if (
    now > state.deadlineMilliseconds ||
    (requirePositiveRemainingDuration && now === state.deadlineMilliseconds)
  ) {
    abortCrossDomainIntegrityDeadline(state, 'DEADLINE_EXCEEDED')
    throw state.failure
  }
  return state.deadlineMilliseconds - now
}

/** Reads one finite, non-negative, safe integer monotonic-clock sample. */
function readCrossDomainIntegrityMonotonicClock(
  monotonicClock: () => number,
): number {
  let value: unknown
  try {
    value = Reflect.apply(monotonicClock, undefined, [])
  } catch {
    throw new CrossDomainIntegrityDeadlineFailure('CLOCK_INVALID')
  }
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new CrossDomainIntegrityDeadlineFailure('CLOCK_INVALID')
  }
  return value
}

/** Aborts a deadline exactly once with one stable failure category. */
function abortCrossDomainIntegrityDeadline(
  state: CrossDomainIntegrityInvocationDeadlineState,
  code: CrossDomainIntegrityDeadlineFailureCode,
): void {
  if (state.failure === undefined) {
    state.failure = new CrossDomainIntegrityDeadlineFailure(code)
  }
  if (!state.controller.signal.aborted) state.controller.abort()
}

/** Validates externally aggregated file evidence before incorporating it. */
function validateExternalFileEvidence(evidence: CrossDomainExternalFileEvidence): void {
  if (
    evidence.contractVersion !== CROSS_DOMAIN_INTEGRITY_CONTRACT_VERSION ||
    !Number.isSafeInteger(evidence.checkedItemCount) ||
    evidence.checkedItemCount < 0 ||
    evidence.checkedItemCount > MAX_ITEM_COUNT ||
    !/^[0-9a-f]{64}$/u.test(evidence.aggregateDigest) ||
    !evidence.failureCodes.every(isExternalFileFailureCode) ||
    !isLexicallySortedUnique(evidence.failureCodes)
  ) {
    throw new TypeError('External file integrity evidence is invalid.')
  }
}

/** Reads every page while enforcing item, page, and cursor-loop bounds. */
async function readDataset(input: RunCrossDomainIntegrityCheckInput): Promise<CrossDomainDataset> {
  const items: CrossDomainIntegrityItem[] = []
  const readFailures = new Set<CrossDomainIntegrityFailureCode>()
  const seenCursors = new Set<string>()
  const externalItemCount = input.externalFileEvidence?.checkedItemCount ?? 0
  if (externalItemCount > input.limits.maxItems) {
    readFailures.add('INTEGRITY_LIMIT_EXCEEDED')
    return { items, readFailures }
  }
  let cursor: string | undefined
  let pageCount = 0
  do {
    if (pageCount >= input.limits.maxPages) {
      readFailures.add('INTEGRITY_LIMIT_EXCEEDED')
      break
    }
    const page = await runCrossDomainIntegrityRequestWithinDeadline(
      input.deadline,
      (signal) => input.reader.readPage({
        role: input.role,
        ...(cursor === undefined ? {} : { cursor }),
        pageSize: input.limits.pageSize,
        signal,
      }),
    )
    pageCount += 1
    if (page.items.length > input.limits.pageSize) {
      readFailures.add('INTEGRITY_LIMIT_EXCEEDED')
      break
    }
    if (items.length + page.items.length + externalItemCount > input.limits.maxItems) {
      readFailures.add('INTEGRITY_LIMIT_EXCEEDED')
      break
    }
    items.push(...page.items)
    cursor = page.nextCursor
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        readFailures.add('CURSOR_LOOP')
        break
      }
      seenCursors.add(cursor)
    }
  } while (cursor !== undefined)
  return { items, readFailures }
}

/** Builds deterministic lookup indexes and identifies duplicate normalized rows. */
function buildIndexes(
  items: readonly CrossDomainIntegrityItem[],
  failures: Set<CrossDomainIntegrityFailureCode>,
): CrossDomainIndexes {
  const indexes: CrossDomainIndexes = {
    configurations: new Map(),
    workItems: new Map(),
    workItemsById: new Map(),
    members: new Set(),
    memberWorkspaces: new Map(),
    teams: new Set(),
    teamWorkspaces: new Map(),
    projects: new Set(),
    projectsById: new Map(),
    relations: new Set(),
    relationItems: [],
    relationProjectionsBySource: new Map(),
    auditReferences: [],
    fileMetadata: new Map(),
    fileMetadataItems: [],
    fileObjects: new Map(),
    fileObjectItems: [],
    files: new Set(),
  }
  const sortedItems = [...items].sort((left, right) =>
    compareUtf8Ordinal(canonicalizeItem(left), canonicalizeItem(right))
  )
  for (const item of sortedItems) indexItem(indexes, item, failures)
  for (const projections of indexes.relationProjectionsBySource.values()) {
    projections.sort(compareUtf8Ordinal)
  }
  return indexes
}

/** Adds one normalized item to its exact and cross-tenant lookup indexes. */
function indexItem(
  indexes: CrossDomainIndexes,
  item: CrossDomainIntegrityItem,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  if (item.kind === 'configuration') {
    const key = configurationKey(item.workspaceId, item.teamId)
    if (indexes.configurations.has(key)) failures.add('CONFIGURATION_DUPLICATE_SCOPE')
    else indexes.configurations.set(key, item)
    return
  }
  if (item.kind === 'work-item') {
    putUnique(indexes.workItems, workItemKey(item.workspaceId, item.teamId, item.workItemId), item, failures)
    appendGrouped(indexes.workItemsById, item.workItemId, item)
    return
  }
  if (item.kind === 'workspace-member') {
    const key = memberKey(item.workspaceId, item.memberKey)
    if (indexes.members.has(key)) failures.add('DUPLICATE_RECORD')
    indexes.members.add(key)
    appendSet(indexes.memberWorkspaces, item.memberKey, item.workspaceId)
    return
  }
  if (item.kind === 'team') {
    const key = teamKey(item.workspaceId, item.teamId)
    if (indexes.teams.has(key)) failures.add('DUPLICATE_RECORD')
    indexes.teams.add(key)
    appendSet(indexes.teamWorkspaces, item.teamId, item.workspaceId)
    return
  }
  if (item.kind === 'project') {
    const key = projectKey(item.workspaceId, item.teamId, item.projectId)
    if (indexes.projects.has(key)) failures.add('DUPLICATE_RECORD')
    indexes.projects.add(key)
    appendGrouped(indexes.projectsById, item.projectId, item)
    return
  }
  if (item.kind === 'relation') {
    const key = relationKey(item)
    if (indexes.relations.has(key)) failures.add('DUPLICATE_RECORD')
    indexes.relations.add(key)
    indexes.relationItems.push(item)
    appendGrouped(
      indexes.relationProjectionsBySource,
      workItemKey(item.workspaceId, item.teamId, item.sourceWorkItemId),
      `${item.relationType}:${item.targetWorkItemId}`,
    )
    return
  }
  if (item.kind === 'audit-reference') {
    indexes.auditReferences.push(item)
    return
  }
  if (item.kind === 'file-metadata') {
    putUnique(indexes.fileMetadata, objectKey(item.objectKey, item.objectVersionId), item, failures)
    indexes.fileMetadataItems.push(item)
    indexes.files.add(fileKey(item.workspaceId, item.fileId))
    return
  }
  putUnique(indexes.fileObjects, objectKey(item.objectKey, item.objectVersionId), item, failures)
  indexes.fileObjectItems.push(item)
}

/** Adds a value to a unique map and records repeated normalized identity. */
function putUnique<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  if (map.has(key)) failures.add('DUPLICATE_RECORD')
  else map.set(key, value)
}

/** Appends one value to a grouped map. */
function appendGrouped<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? []
  values.push(value)
  map.set(key, values)
}

/** Appends one string to a grouped set. */
function appendSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>()
  values.add(value)
  map.set(key, values)
}

/** Evaluates configuration/status and Work Item creator membership invariants. */
function checkWorkItems(
  indexes: CrossDomainIndexes,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  for (const item of indexes.workItems.values()) {
    const teamConfiguration = indexes.configurations.get(configurationKey(item.workspaceId, item.teamId))
    const workspaceConfiguration = indexes.configurations.get(configurationKey(item.workspaceId, null))
    const configuration = teamConfiguration ?? workspaceConfiguration
    let statuses: readonly CrossDomainWorkflowStatus[] = []
    let shouldCheckStatus = true
    if (configuration) {
      const typeWorkflow = configuration.workItemTypeWorkflows.find((candidate) =>
        candidate.workItemTypeId === item.workItemTypeId,
      )
      if (!typeWorkflow) {
        failures.add('WORK_ITEM_TYPE_UNKNOWN')
        shouldCheckStatus = false
      } else {
        statuses = configuration.workflowStatuses.filter((status) =>
          status.workflowId === typeWorkflow.workflowId,
        )
      }
    } else if (item.workItemTypeId === DEFAULT_WORK_ITEM_TYPE_ID) {
      statuses = builtInWorkflowStatuses()
    } else {
      failures.add('WORK_ITEM_TYPE_UNKNOWN')
      shouldCheckStatus = false
    }
    if (shouldCheckStatus) {
      const status = statuses.find((candidate) => candidate.statusId === item.workflowStatusId)
      if (!status) {
        failures.add('WORK_ITEM_WORKFLOW_STATUS_UNKNOWN')
      } else if (status.category !== item.statusCategory) {
        failures.add('WORK_ITEM_STATUS_CATEGORY_MISMATCH')
      }
    }
    if (!indexes.members.has(memberKey(item.workspaceId, item.creatorMemberKey))) {
      const otherWorkspaces = indexes.memberWorkspaces.get(item.creatorMemberKey)
      failures.add(
        otherWorkspaces && !otherWorkspaces.has(item.workspaceId)
          ? 'WORK_ITEM_CREATOR_TENANT_MISMATCH'
          : 'WORK_ITEM_CREATOR_MEMBER_MISSING',
      )
    }
    checkWorkItemOwnership(indexes, item, failures)
    const expectedRelations = indexes.relationProjectionsBySource.get(
      workItemKey(item.workspaceId, item.teamId, item.workItemId),
    ) ?? []
    const projectedRelations = [...item.relationIds].sort(compareUtf8Ordinal)
    if (!sameStrings(expectedRelations, projectedRelations)) {
      failures.add('WORK_ITEM_RELATION_PROJECTION_MISMATCH')
    }
  }
}

/** Verifies every Work Item Team and assigned Project, even when it has no relation rows. */
function checkWorkItemOwnership(
  indexes: CrossDomainIndexes,
  item: CrossDomainWorkItem,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  if (!indexes.teams.has(teamKey(item.workspaceId, item.teamId))) {
    const workspaces = indexes.teamWorkspaces.get(item.teamId)
    failures.add(
      workspaces && !workspaces.has(item.workspaceId)
        ? 'WORK_ITEM_TENANT_MISMATCH'
        : 'WORK_ITEM_TEAM_MISSING',
    )
  }
  if (item.projectId === null) return
  if (indexes.projects.has(projectKey(item.workspaceId, item.teamId, item.projectId))) return
  const projects = indexes.projectsById.get(item.projectId) ?? []
  if (projects.some((project) => project.workspaceId === item.workspaceId)) {
    failures.add('WORK_ITEM_PROJECT_TEAM_MISMATCH')
  } else if (projects.length > 0) {
    failures.add('WORK_ITEM_TENANT_MISMATCH')
  } else {
    failures.add('WORK_ITEM_PROJECT_MISSING')
  }
}

/** Evaluates reciprocal relation, endpoint, Team, and Project invariants. */
function checkRelations(
  indexes: CrossDomainIndexes,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  for (const relation of indexes.relationItems) {
    checkRelationTeam(indexes, relation, failures)
    const source = findRelationEndpoint(indexes, relation, relation.sourceWorkItemId, failures)
    const target = findRelationEndpoint(indexes, relation, relation.targetWorkItemId, failures)
    if (source) checkRelationProject(indexes, source, failures)
    if (target) checkRelationProject(indexes, target, failures)
    const reciprocal: CrossDomainRelation = {
      kind: 'relation',
      workspaceId: relation.workspaceId,
      teamId: relation.teamId,
      sourceWorkItemId: relation.targetWorkItemId,
      targetWorkItemId: relation.sourceWorkItemId,
      relationType: reciprocalRelationType(relation.relationType),
    }
    if (!indexes.relations.has(relationKey(reciprocal))) {
      failures.add('RELATION_RECIPROCAL_MISSING')
    }
  }
}

/** Checks that a relation Team belongs to the event Workspace. */
function checkRelationTeam(
  indexes: CrossDomainIndexes,
  relation: CrossDomainRelation,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  if (indexes.teams.has(teamKey(relation.workspaceId, relation.teamId))) return
  const workspaces = indexes.teamWorkspaces.get(relation.teamId)
  failures.add(
    workspaces && !workspaces.has(relation.workspaceId)
      ? 'RELATION_TENANT_MISMATCH'
      : 'RELATION_TEAM_MISSING',
  )
}

/** Finds one exact relation endpoint and classifies Team or tenant drift. */
function findRelationEndpoint(
  indexes: CrossDomainIndexes,
  relation: CrossDomainRelation,
  workItemId: string,
  failures: Set<CrossDomainIntegrityFailureCode>,
): CrossDomainWorkItem | undefined {
  const exact = indexes.workItems.get(workItemKey(relation.workspaceId, relation.teamId, workItemId))
  if (exact) return exact
  const candidates = indexes.workItemsById.get(workItemId) ?? []
  if (candidates.some((candidate) => candidate.workspaceId === relation.workspaceId)) {
    failures.add('RELATION_ENDPOINT_TEAM_MISMATCH')
  } else if (candidates.length > 0) {
    failures.add('RELATION_TENANT_MISMATCH')
  } else {
    failures.add('RELATION_ENDPOINT_MISSING')
  }
  return undefined
}

/** Verifies an endpoint's assigned Project remains in the same tenant and Team. */
function checkRelationProject(
  indexes: CrossDomainIndexes,
  item: CrossDomainWorkItem,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  if (item.projectId === null) return
  if (indexes.projects.has(projectKey(item.workspaceId, item.teamId, item.projectId))) return
  const candidates = indexes.projectsById.get(item.projectId) ?? []
  if (candidates.some((candidate) => candidate.workspaceId === item.workspaceId)) {
    failures.add('RELATION_PROJECT_TEAM_MISMATCH')
  } else if (candidates.length > 0) {
    failures.add('RELATION_TENANT_MISMATCH')
  } else {
    failures.add('RELATION_PROJECT_MISSING')
  }
}

/** Evaluates tenant equality and lifecycle-aware known resource references for audit. */
function checkAuditReferences(
  indexes: CrossDomainIndexes,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  for (const reference of indexes.auditReferences) {
    if (reference.workspaceId !== reference.referencedWorkspaceId) {
      failures.add('AUDIT_TENANT_MISMATCH')
      continue
    }
    if (reference.resourceState === 'historical') continue
    if (!hasAuditResource(indexes, reference)) failures.add('AUDIT_RESOURCE_MISSING')
  }
}

/** Resolves a normalized current audit reference against known canonical resources. */
function hasAuditResource(indexes: CrossDomainIndexes, reference: CrossDomainAuditReference): boolean {
  if (reference.resourceType === 'workspace-member') {
    return indexes.members.has(memberKey(reference.workspaceId, reference.resourceId))
  }
  if (reference.resourceType === 'team') {
    return indexes.teams.has(teamKey(reference.workspaceId, reference.resourceId))
  }
  if (reference.resourceType === 'project') {
    return reference.teamId !== null &&
      indexes.projects.has(projectKey(reference.workspaceId, reference.teamId, reference.resourceId))
  }
  if (reference.resourceType === 'work-item') {
    return reference.teamId !== null &&
      indexes.workItems.has(workItemKey(reference.workspaceId, reference.teamId, reference.resourceId))
  }
  return indexes.files.has(fileKey(reference.workspaceId, reference.resourceId))
}

/** Evaluates file target, tenant, and exact object-version metadata invariants. */
function checkFiles(
  indexes: CrossDomainIndexes,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  for (const metadata of indexes.fileMetadataItems) {
    checkFileReference(indexes, metadata, failures)
    const object = indexes.fileObjects.get(objectKey(metadata.objectKey, metadata.objectVersionId))
    if (!object) {
      failures.add('FILE_METADATA_OBJECT_MISSING')
      continue
    }
    if (metadata.workspaceId !== object.workspaceId) {
      failures.add('FILE_METADATA_TENANT_MISMATCH')
    }
    if (
      metadata.fileId !== object.fileId ||
      metadata.versionId !== object.versionId ||
      metadata.contentType !== object.contentType ||
      metadata.sizeBytes !== object.sizeBytes ||
      metadata.scanStatus !== object.scanStatus
    ) {
      failures.add('FILE_METADATA_OBJECT_MISMATCH')
    }
  }
  for (const object of indexes.fileObjectItems) {
    if (!indexes.fileMetadata.has(objectKey(object.objectKey, object.objectVersionId))) {
      failures.add('FILE_OBJECT_METADATA_MISSING')
    }
  }
}

/** Verifies a file attachment target in the same Workspace and Team. */
function checkFileReference(
  indexes: CrossDomainIndexes,
  metadata: CrossDomainFileMetadata,
  failures: Set<CrossDomainIntegrityFailureCode>,
): void {
  if (!indexes.teams.has(teamKey(metadata.workspaceId, metadata.teamId))) {
    const workspaces = indexes.teamWorkspaces.get(metadata.teamId)
    failures.add(
      workspaces && !workspaces.has(metadata.workspaceId)
        ? 'FILE_METADATA_TENANT_MISMATCH'
        : 'FILE_METADATA_REFERENCE_MISSING',
    )
  }
  if (metadata.targetType === 'work-item') {
    if (indexes.workItems.has(workItemKey(metadata.workspaceId, metadata.teamId, metadata.targetId))) return
    const candidates = indexes.workItemsById.get(metadata.targetId) ?? []
    failures.add(
      candidates.length > 0 && candidates.every((candidate) => candidate.workspaceId !== metadata.workspaceId)
        ? 'FILE_METADATA_TENANT_MISMATCH'
        : 'FILE_METADATA_REFERENCE_MISSING',
    )
    return
  }
  if (indexes.projects.has(projectKey(metadata.workspaceId, metadata.teamId, metadata.targetId))) return
  const projects = indexes.projectsById.get(metadata.targetId) ?? []
  failures.add(
    projects.length > 0 && projects.every((project) => project.workspaceId !== metadata.workspaceId)
      ? 'FILE_METADATA_TENANT_MISMATCH'
      : 'FILE_METADATA_REFERENCE_MISSING',
  )
}

/** Creates page-boundary-independent HMAC aggregates for each domain and all data. */
function createEvidence(
  items: readonly CrossDomainIntegrityItem[],
  digestKey: Uint8Array,
  resourceBindingDigest: string,
  resourceIdentities: readonly CrossDomainIntegrityResourceIdentity[],
  resourceIdentityScheme:
    typeof CROSS_DOMAIN_INTEGRITY_IMMUTABLE_RESOURCE_IDENTITY_SCHEME |
    undefined,
  resourceIdentityDigest: string,
  externalFileEvidence: CrossDomainExternalFileEvidence | undefined,
): CrossDomainIntegrityEvidence {
  const digestsByDomain = new Map<CrossDomainIntegrityDomain, Buffer[]>()
  const itemCountsByDomain = new Map<CrossDomainIntegrityDomain, number>()
  for (const domain of integrityDomains()) {
    digestsByDomain.set(domain, [])
    itemCountsByDomain.set(domain, 0)
  }
  for (const item of items) {
    const domain = itemDomain(item)
    const digests = digestsByDomain.get(domain)
    if (digests) {
      digests.push(keyedDigest(
        digestKey,
        `item-${domain}-v1`,
        canonicalizeItemForEvidence(item),
      ))
    }
    itemCountsByDomain.set(domain, (itemCountsByDomain.get(domain) ?? 0) + 1)
  }
  if (externalFileEvidence) {
    const digests = digestsByDomain.get('file')
    if (digests) {
      digests.push(keyedDigest(
        digestKey,
        'external-file-evidence-v1',
        `${externalFileEvidence.checkedItemCount}\0${externalFileEvidence.aggregateDigest}`,
      ))
    }
    itemCountsByDomain.set(
      'file',
      (itemCountsByDomain.get('file') ?? 0) + externalFileEvidence.checkedItemCount,
    )
  }
  const domains = integrityDomains().map((domain) => {
    const digests = digestsByDomain.get(domain) ?? []
    digests.sort(Buffer.compare)
    return {
      domain,
      itemCount: itemCountsByDomain.get(domain) ?? 0,
      aggregateDigest: aggregateDigests(
        digestKey,
        `aggregate-${domain}-v1`,
        resourceBindingDigest,
        digests,
      ),
    }
  })
  return {
    algorithm: 'HMAC-SHA-256',
    digestVersion: 1,
    keyFingerprint: keyedDigest(digestKey, 'key-fingerprint-v1', 'cross-domain').toString('hex'),
    resourceBindingDigest,
    resourceIdentities: resourceIdentities.map((identity) => ({ ...identity })),
    ...(resourceIdentityScheme === undefined
      ? {}
      : { resourceIdentityScheme }),
    resourceIdentityDigest,
    domains,
    aggregateDigest: calculateEvidenceAggregateDigest(
      digestKey,
      resourceBindingDigest,
      domains,
    ),
    itemCount: items.length + (externalFileEvidence?.checkedItemCount ?? 0),
  }
}

/**
 * Recomputes the total aggregate from the complete canonical domain vector.
 *
 * @param digestKey - In-memory HMAC key.
 * @param resourceBindingDigest - Shared logical-resource binding digest.
 * @param domains - Complete canonical per-domain aggregate vector.
 * @returns Total evidence HMAC used for semantic authentication.
 */
function calculateEvidenceAggregateDigest(
  digestKey: Uint8Array,
  resourceBindingDigest: string,
  domains: readonly CrossDomainDomainEvidence[],
): string {
  const totalHmac = createDomainHmac(digestKey, 'cross-domain-aggregate-v1')
  totalHmac.update(`${resourceBindingDigest}\n`, 'utf8')
  for (const domain of domains) {
    totalHmac.update(`${domain.domain}\0${domain.itemCount}\0${domain.aggregateDigest}\n`, 'utf8')
  }
  return totalHmac.digest('hex')
}

/** Narrows untrusted external file failure strings to the shared stable set. */
function isExternalFileFailureCode(value: string): value is CrossDomainExternalFileFailureCode {
  return value === 'FILE_METADATA_OBJECT_MISMATCH' ||
    value === 'FILE_METADATA_OBJECT_MISSING' ||
    value === 'FILE_METADATA_REFERENCE_MISSING' ||
    value === 'FILE_METADATA_TENANT_MISMATCH'
}

/** Returns every evidence domain in stable lexical order. */
function integrityDomains(): CrossDomainIntegrityDomain[] {
  return ['audit', 'configuration', 'file', 'relation', 'resource', 'work-item']
}

/** Maps one normalized item to its aggregate evidence domain. */
function itemDomain(item: CrossDomainIntegrityItem): CrossDomainIntegrityDomain {
  if (item.kind === 'configuration') return 'configuration'
  if (item.kind === 'work-item') return 'work-item'
  if (item.kind === 'relation') return 'relation'
  if (item.kind === 'audit-reference') return 'audit'
  if (item.kind === 'file-metadata' || item.kind === 'file-object') return 'file'
  return 'resource'
}

/** Maps one evidence domain to its stable source/restore difference code. */
function domainDifferenceCode(domain: CrossDomainIntegrityDomain): CrossDomainIntegrityFailureCode {
  if (domain === 'audit') return 'RESTORE_AUDIT_DIFFERENCE'
  if (domain === 'configuration') return 'RESTORE_CONFIGURATION_DIFFERENCE'
  if (domain === 'file') return 'RESTORE_FILE_DIFFERENCE'
  if (domain === 'relation') return 'RESTORE_RELATION_DIFFERENCE'
  if (domain === 'resource') return 'RESTORE_RESOURCE_DIFFERENCE'
  return 'RESTORE_WORK_ITEM_DIFFERENCE'
}

/** Maps one evidence domain to its same-resource rehearsal difference code. */
function migrationRehearsalDomainDifferenceCode(
  domain: CrossDomainIntegrityDomain,
): CrossDomainIntegrityMigrationRehearsalFailureCode {
  if (domain === 'audit') return 'REHEARSAL_AUDIT_DIFFERENCE'
  if (domain === 'configuration') {
    return 'REHEARSAL_CONFIGURATION_DIFFERENCE'
  }
  if (domain === 'file') return 'REHEARSAL_FILE_DIFFERENCE'
  if (domain === 'relation') return 'REHEARSAL_RELATION_DIFFERENCE'
  if (domain === 'resource') return 'REHEARSAL_RESOURCE_DIFFERENCE'
  return 'REHEARSAL_WORK_ITEM_DIFFERENCE'
}

/** Produces a stable canonical string for one normalized item. */
function canonicalizeItem(item: CrossDomainIntegrityItem): string {
  if (item.kind === 'configuration') {
    return canonicalFields([
      item.kind,
      item.workspaceId,
      item.teamId ?? '',
      ...item.workItemTypeWorkflows
        .map((mapping) => `${mapping.workItemTypeId}\0${mapping.workflowId}`)
        .sort(compareUtf8Ordinal),
      ...item.workflowStatuses
        .map((status) => `${status.workflowId}\0${status.statusId}\0${status.category}`)
        .sort(compareUtf8Ordinal),
    ])
  }
  if (item.kind === 'work-item') {
    return canonicalFields([
      item.kind,
      item.workspaceId,
      item.teamId,
      item.workItemId,
      item.creatorMemberKey,
      item.workItemTypeId,
      item.workflowStatusId,
      item.statusCategory,
      item.projectId ?? '',
      ...[...item.relationIds].sort(compareUtf8Ordinal),
    ])
  }
  if (item.kind === 'workspace-member') {
    return canonicalFields([item.kind, item.workspaceId, item.memberKey])
  }
  if (item.kind === 'team') return canonicalFields([item.kind, item.workspaceId, item.teamId])
  if (item.kind === 'project') {
    return canonicalFields([item.kind, item.workspaceId, item.teamId, item.projectId])
  }
  if (item.kind === 'relation') {
    return canonicalFields([
      item.kind,
      item.workspaceId,
      item.teamId,
      item.sourceWorkItemId,
      item.targetWorkItemId,
      item.relationType,
    ])
  }
  if (item.kind === 'audit-reference') {
    return canonicalFields([
      item.kind,
      item.workspaceId,
      item.referencedWorkspaceId,
      item.resourceType,
      item.resourceId,
      item.teamId ?? '',
      item.resourceState,
    ])
  }
  if (item.kind === 'file-metadata') {
    return canonicalFields([
      item.kind,
      item.workspaceId,
      item.teamId,
      item.fileId,
      item.versionId,
      item.targetType,
      item.targetId,
      item.objectKey,
      item.objectVersionId,
      item.contentType,
      String(item.sizeBytes),
      item.scanStatus,
    ])
  }
  return canonicalFields([
    item.kind,
    item.objectKey,
    item.objectVersionId,
    item.workspaceId,
    item.fileId,
    item.versionId,
    item.contentType,
    String(item.sizeBytes),
    item.scanStatus,
  ])
}

/**
 * Produces restore-portable aggregate input while preserving exact local joins.
 *
 * @param item - One normalized integrity item.
 * @returns Canonical evidence text with physical object Version IDs normalized.
 */
function canonicalizeItemForEvidence(item: CrossDomainIntegrityItem): string {
  if (item.kind === 'file-metadata') {
    return canonicalFields([
      item.kind,
      item.workspaceId,
      item.teamId,
      item.fileId,
      item.versionId,
      item.targetType,
      item.targetId,
      item.objectKey,
      item.contentType,
      String(item.sizeBytes),
      item.scanStatus,
    ])
  }
  if (item.kind === 'file-object') {
    return canonicalFields([
      item.kind,
      item.objectKey,
      item.workspaceId,
      item.fileId,
      item.versionId,
      item.contentType,
      String(item.sizeBytes),
      item.scanStatus,
    ])
  }
  return canonicalizeItem(item)
}

/** Encodes strings without delimiter ambiguity. */
function canonicalFields(fields: readonly string[]): string {
  return fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('|')
}

/** Creates a domain-separated HMAC digest for one canonical value. */
function keyedDigest(key: Uint8Array, domain: string, value: string): Buffer {
  return createDomainHmac(key, domain).update(value, 'utf8').digest()
}

/** Creates a domain-separated HMAC instance. */
function createDomainHmac(key: Uint8Array, domain: string) {
  return createHmac('sha256', key).update(`mukuroji-cross-domain-integrity\0${domain}\0`, 'utf8')
}

/** Aggregates sorted row digests without exposing any row-level digest. */
function aggregateDigests(
  key: Uint8Array,
  domain: string,
  resourceBindingDigest: string,
  digests: readonly Buffer[],
): string {
  const hmac = createDomainHmac(key, domain)
  hmac.update(`${resourceBindingDigest}\n`, 'utf8')
  hmac.update(`${digests.length}\n`, 'utf8')
  for (const digest of digests) hmac.update(digest)
  return hmac.digest('hex')
}

/** Returns built-in fallback statuses with their canonical categories. */
function builtInWorkflowStatuses(): CrossDomainWorkflowStatus[] {
  return [
    { statusId: 'done', category: 'completed', workflowId: 'default-workflow' },
    { statusId: 'in-progress', category: 'started', workflowId: 'default-workflow' },
    { statusId: 'review', category: 'started', workflowId: 'default-workflow' },
    { statusId: 'todo', category: 'unstarted', workflowId: 'default-workflow' },
  ]
}

/** Returns whether a string list is already lexical, unique, and stable. */
function isLexicallySortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]
    const current = values[index]
    if (previous === undefined || current === undefined || compareUtf8Ordinal(previous, current) >= 0) {
      return false
    }
  }
  return true
}

/** Compares strings by their UTF-8 byte sequence without locale-dependent collation. */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/** Returns whether two ordered string lists are identical. */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Creates an unambiguous in-memory composite key. */
function compositeKey(parts: readonly string[]): string {
  return canonicalFields(parts)
}

/** Creates a configuration scope key. */
function configurationKey(workspaceId: string, teamId: string | null): string {
  return compositeKey([workspaceId, teamId ?? ''])
}

/** Creates a Work Item identity key. */
function workItemKey(workspaceId: string, teamId: string, workItemId: string): string {
  return compositeKey([workspaceId, teamId, workItemId])
}

/** Creates a member identity key. */
function memberKey(workspaceId: string, value: string): string {
  return compositeKey([workspaceId, value])
}

/** Creates a Team identity key. */
function teamKey(workspaceId: string, teamId: string): string {
  return compositeKey([workspaceId, teamId])
}

/** Creates a Project identity key. */
function projectKey(workspaceId: string, teamId: string, projectId: string): string {
  return compositeKey([workspaceId, teamId, projectId])
}

/** Creates a File identity key. */
function fileKey(workspaceId: string, fileId: string): string {
  return compositeKey([workspaceId, fileId])
}

/** Creates an exact object-version identity key. */
function objectKey(value: string, versionId: string): string {
  return compositeKey([value, versionId])
}

/** Creates an exact relation projection identity key. */
function relationKey(relation: CrossDomainRelation): string {
  return compositeKey([
    relation.workspaceId,
    relation.teamId,
    relation.sourceWorkItemId,
    relation.relationType,
    relation.targetWorkItemId,
  ])
}

/** Returns the required reciprocal relation type. */
function reciprocalRelationType(type: CrossDomainRelationType): CrossDomainRelationType {
  if (type === 'parent') return 'child'
  if (type === 'child') return 'parent'
  if (type === 'blocks') return 'blockedBy'
  if (type === 'blockedBy') return 'blocks'
  return type
}
