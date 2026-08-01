import { createHmac, timingSafeEqual } from 'node:crypto'

/** Maximum accepted recovery point objective in seconds. */
export const RESTORE_DRILL_RPO_TARGET_SECONDS = 300

/** Maximum accepted recovery time objective in seconds. */
export const RESTORE_DRILL_RTO_TARGET_SECONDS = 14_400

/** Maximum interval authorized by one cleanup approval receipt. */
export const RESTORE_DRILL_CLEANUP_APPROVAL_MAXIMUM_MILLISECONDS = 86_400_000

/** A stateful DynamoDB resource that participates in every restore drill. */
export type RestoreDrillTableTarget =
  | 'table:audit-events'
  | 'table:file-proofing'
  | 'table:project-directory'
  | 'table:work-item-configuration'
  | 'table:work-items'
  | 'table:workspace-access'

/** Canonical fixed order for the six DynamoDB restore targets. */
export const RESTORE_DRILL_TABLE_TARGETS: readonly RestoreDrillTableTarget[] = Object.freeze([
  'table:audit-events',
  'table:file-proofing',
  'table:project-directory',
  'table:work-item-configuration',
  'table:work-items',
  'table:workspace-access',
])

/** A physical resource whose isolated identity is bound into drill evidence. */
export type RestoreDrillResourceTarget = 'bucket:file' | RestoreDrillTableTarget

/** Canonical fixed order for the file bucket followed by all six DynamoDB tables. */
export const RESTORE_DRILL_RESOURCE_TARGETS: readonly RestoreDrillResourceTarget[] =
  Object.freeze([
    'bucket:file',
    ...RESTORE_DRILL_TABLE_TARGETS,
  ])

/** Durable orchestration phases for one restore drill. */
export type RestoreDrillRunPhase =
  | 'awaiting-cleanup-approval'
  | 'cleaning-up'
  | 'completed'
  | 'copying-file-versions'
  | 'discovering-pitr-windows'
  | 'failed'
  | 'restoring-tables'
  | 'scheduled'
  | 'verifying'

/** Current or terminal outcome associated with a durable run phase. */
export type RestoreDrillRunOutcome = 'fail' | 'in-progress' | 'pass'

/** Strict phase and outcome pair persisted by an orchestration adapter. */
export type RestoreDrillRunState = {
  /** Current durable orchestration phase. */
  phase: RestoreDrillRunPhase
  /** Current or terminal drill outcome. */
  outcome: RestoreDrillRunOutcome
}

/** Stable, secret-free failure categories owned by the restore-drill domain. */
export type RestoreDrillFailureCode =
  | 'AGGREGATE_CONTENT_MISMATCH'
  | 'AGGREGATE_DESCRIPTOR_MISMATCH'
  | 'AGGREGATE_INVALID'
  | 'AGGREGATE_KEY_MISMATCH'
  | 'AGGREGATE_METADATA_MISMATCH'
  | 'AGGREGATE_PARTITION_COUNT_MISMATCH'
  | 'AGGREGATE_RECORD_COUNT_MISMATCH'
  | 'AGGREGATE_RESOURCE_MISMATCH'
  | 'AGGREGATE_RESTORE_POINT_MISMATCH'
  | 'AGGREGATE_ROLE_MISMATCH'
  | 'APPROVAL_APPROVER_UNAUTHORIZED'
  | 'APPROVAL_AUTHENTICATION_FAILED'
  | 'APPROVAL_CHANGE_MISMATCH'
  | 'APPROVAL_DRILL_MISMATCH'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_NOT_YET_VALID'
  | 'APPROVAL_POLICY_MISMATCH'
  | 'APPROVAL_RECEIPT_INVALID'
  | 'APPROVAL_RESOURCE_MISMATCH'
  | 'APPROVAL_RESULT_MISMATCH'
  | 'CADENCE_OVERDUE'
  | 'CLEANUP_CONTEXT_INVALID'
  | 'CLEANUP_FAILED'
  | 'CROSS_DOMAIN_INTEGRITY_FAILED'
  | 'DIGEST_DOMAIN_INVALID'
  | 'DIGEST_KEY_INVALID'
  | 'DYNAMODB_RESTORE_FAILED'
  | 'EVIDENCE_INVALID'
  | 'EVIDENCE_PERSIST_FAILED'
  | 'OBJECTIVE_TIMELINE_INVALID'
  | 'PITR_WINDOW_INVALID'
  | 'PITR_WINDOW_NO_OVERLAP'
  | 'PITR_WINDOW_TARGET_MISMATCH'
  | 'RESOURCE_IDENTITY_INVALID'
  | 'RPO_TARGET_MISSED'
  | 'RTO_TARGET_MISSED'
  | 'RUN_STATE_INVALID'
  | 'S3_VERSION_RESTORE_FAILED'
  | 'WORKFLOW_POLL_BUDGET_EXCEEDED'
  | 'WORKFLOW_TASK_FAILED'

/** One source table point-in-time recovery window. */
export type RestoreDrillPitrWindow = {
  /** Earliest timestamp that the source table can restore. */
  earliestRestorableTime: string
  /** Latest timestamp that the source table can restore. */
  latestRestorableTime: string
  /** Logical table target in canonical drill order. */
  target: RestoreDrillTableTarget
}

/** Latest point shared by every required DynamoDB recovery window. */
export type RestoreDrillRestorePointSelection = {
  /** Maximum of all earliest-restorable timestamps. */
  commonEarliestRestorableTime: string
  /** Minimum of all latest-restorable timestamps. */
  commonLatestRestorableTime: string
  /** Selected restore point, equal to the common latest timestamp. */
  restorePoint: string
}

/** Timestamp inputs used to calculate RPO and RTO. */
export type CalculateRestoreDrillObjectivesInput = {
  /** UTC time at which verification completed or terminally failed. */
  completedAt: string
  /** Common point selected for every DynamoDB restore and S3 version set. */
  restorePoint: string
  /** UTC time at which the drill began. */
  startedAt: string
}

/** Machine-calculated RPO and RTO evidence. */
export type RestoreDrillObjectiveResult = {
  /** Stable target failures, empty only when both objectives are met. */
  failureCodes: RestoreDrillFailureCode[]
  /** Conservative elapsed seconds from restore point to drill start. */
  rpoSeconds: number
  /** Whether the five-minute recovery point target was met. */
  rpoMet: boolean
  /** Fixed five-minute recovery point target. */
  rpoTargetSeconds: typeof RESTORE_DRILL_RPO_TARGET_SECONDS
  /** Conservative elapsed seconds from drill start to verification completion. */
  rtoSeconds: number
  /** Whether the four-hour recovery time target was met. */
  rtoMet: boolean
  /** Fixed four-hour recovery time target. */
  rtoTargetSeconds: typeof RESTORE_DRILL_RTO_TARGET_SECONDS
}

/** Keyed, order-independent multiset digest evidence. */
export type RestoreDrillMultisetDigest = {
  /** Fixed digest algorithm. */
  algorithm: 'HMAC-SHA-256'
  /** Aggregate digest over a mergeable modular sum and the exact multiplicity. */
  aggregateDigest: string
  /** Digest contract version. */
  digestVersion: 2
  /** Number of values added, including duplicate values. */
  itemCount: number
  /** Non-secret proof that compared aggregates used the same in-memory key. */
  keyFingerprint: string
}

/** Compact authenticated merge state for one keyed multiset accumulator. */
export type RestoreDrillKeyedMultisetDigestCheckpoint = {
  /** HMAC authenticating the count and modular sum in the accumulator domain. */
  readonly checkpointMac: string
  /** Fixed compact checkpoint contract version. */
  readonly checkpointVersion: 1
  /** Number of values represented by the modular sum. */
  readonly itemCount: number
  /** Non-secret proof that compared checkpoints use the same in-memory key. */
  readonly keyFingerprint: string
  /** Big-endian 256-bit sum of per-element HMAC outputs modulo 2^256. */
  readonly modularSum: string
}

/** Exact aggregate evidence for one source or isolated resource. */
export type RestoreDrillResourceAggregate = {
  /** Keyed digest of schema, GSI, TTL, encryption, or bucket configuration. */
  descriptorDigest: string
  /** Keyed digest of normalized content with physical restore IDs removed. */
  contentDigest: string
  /** Exact count of logical partitions represented by the aggregate. */
  logicalPartitionCount: number
  /** Keyed digest of normalized item or object metadata. */
  metadataDigest: string
  /** Exact item or object-version count, including duplicate values. */
  recordCount: number
  /** Logical resource target in canonical evidence order. */
  target: RestoreDrillResourceTarget
}

/** Role of one exact source-export or isolated-restore aggregate. */
export type RestoreDrillDatasetRole = 'isolated-restore' | 'source-export'

/** Complete exact aggregate for all required DynamoDB and S3 resources. */
export type RestoreDrillDatasetAggregate = {
  /** Fingerprint proving every per-resource digest used the same key. */
  keyFingerprint: string
  /** Complete resource aggregate vector in canonical fixed order. */
  resources: RestoreDrillResourceAggregate[]
  /** Point in time represented by every aggregate. */
  restorePoint: string
  /** Source export or isolated restore role. */
  role: RestoreDrillDatasetRole
}

/** Exact comparison result for authenticated source and restore aggregates. */
export type RestoreDrillAggregateComparison = {
  /** Sorted unique stable mismatch categories without raw data. */
  failureCodes: RestoreDrillFailureCode[]
  /** Overall exact-comparison status. */
  status: 'fail' | 'pass'
}

/** One secret-free identity for an exact physical restore resource. */
export type RestoreDrillResourceIdentity = {
  /** HMAC of the exact account, Region, service, and physical resource name. */
  identityDigest: string
  /** Logical resource target in canonical evidence order. */
  target: RestoreDrillResourceTarget
}

/** Final secret-free evidence bound by the cleanup approval result digest. */
export type RestoreDrillResultEvidence = {
  /** UTC time at which verification completed or terminally failed. */
  completedAt: string
  /** Exact source/restore comparison result. */
  comparison: RestoreDrillAggregateComparison
  /** Stable drill identifier. */
  drillId: string
  /** Sorted unique terminal failure categories. */
  failureCodes: RestoreDrillFailureCode[]
  /** Fixed evidence discriminator. */
  kind: 'mukuroji-restore-drill-result'
  /** Machine-calculated RPO and RTO evidence. */
  objectives: RestoreDrillObjectiveResult
  /** HMAC digest over the exact isolated physical resource identity vector. */
  resourceDigest: string
  /** Common selected point in time represented by the restore. */
  restorePoint: string
  /** HMAC digest over the isolated-restore dataset aggregate. */
  restoreAggregateDigest: string
  /** Terminal phase and outcome. */
  runState: RestoreDrillRunState
  /** Evidence contract version. */
  resultVersion: 1
  /** HMAC digest over the source-export dataset aggregate. */
  sourceAggregateDigest: string
  /** UTC time at which the drill began. */
  startedAt: string
}

/** Fields authenticated by one explicit cleanup approval. */
export type RestoreDrillCleanupApprovalBinding = {
  /** Canonical identity of the approving operator or service principal. */
  approver: string
  /** UTC timestamp at which the approval was issued. */
  approvedAt: string
  /** Immutable change request or change-set locator authorizing cleanup. */
  changeLocator: string
  /** Stable drill identifier. */
  drillId: string
  /** UTC timestamp after which the approval is unusable. */
  expiresAt: string
  /** Cleanup policy version evaluated by the approver. */
  policyVersion: string
  /** Digest of the exact isolated physical resources eligible for deletion. */
  resourceDigest: string
  /** Digest of the exact final drill evidence reviewed by the approver. */
  resultDigest: string
}

/** Authenticated, narrowly scoped cleanup approval receipt. */
export type RestoreDrillCleanupApprovalReceipt = RestoreDrillCleanupApprovalBinding & {
  /** Fixed receipt digest algorithm. */
  algorithm: 'HMAC-SHA-256'
  /** HMAC authenticating every other receipt field. */
  approvalMac: string
  /** Non-secret fingerprint of the key used for the receipt HMAC. */
  keyFingerprint: string
  /** Fixed receipt discriminator. */
  kind: 'mukuroji-restore-drill-cleanup-approval'
  /** Receipt contract version. */
  receiptVersion: 1
}

/** Exact expected cleanup scope and authorized approvers. */
export type RestoreDrillCleanupExpectation = {
  /** Canonical principals authorized to approve this cleanup. */
  authorizedApprovers: readonly string[]
  /** Expected immutable change request or change-set locator. */
  changeLocator: string
  /** Expected stable drill identifier. */
  drillId: string
  /** Expected cleanup policy version. */
  policyVersion: string
  /** Expected exact isolated physical-resource digest. */
  resourceDigest: string
  /** Expected exact final evidence digest. */
  resultDigest: string
}

/** Inputs for a fail-closed cleanup approval decision. */
export type EvaluateRestoreDrillCleanupApprovalInput = {
  /** In-memory 32-byte HMAC key. */
  digestKey: Uint8Array
  /** Expected cleanup scope and authorized approvers. */
  expected: RestoreDrillCleanupExpectation
  /** Canonical UTC decision time. */
  now: string
  /** Untrusted serialized or in-memory receipt. */
  receipt: unknown
}

/** Secret-free result of evaluating cleanup authorization. */
export type RestoreDrillCleanupDecision = {
  /** Whether destructive cleanup is authorized at the supplied time. */
  eligible: boolean
  /** Sorted unique stable denial reasons, empty only when eligible. */
  failureCodes: RestoreDrillFailureCode[]
}

/** Stable restore-drill validation failure without raw input in its message. */
export class RestoreDrillFailure extends Error {
  /** Stable machine-readable failure category. */
  readonly code: RestoreDrillFailureCode

  /**
   * Creates a restore-drill validation failure.
   *
   * @param code - Stable failure category.
   */
  constructor(code: RestoreDrillFailureCode) {
    super(code)
    this.name = 'RestoreDrillFailure'
    this.code = code
  }
}

/**
 * Accumulates keyed element digests and never retains or returns the supplied raw values.
 *
 * Multiplicity is preserved through a 256-bit modular sum of PRF outputs plus an exact count.
 * The compact state is associative across pages without XOR duplicate cancellation.
 */
export class RestoreDrillKeyedMultisetDigestAccumulator {
  /** Private copy of the in-memory HMAC key. */
  private readonly digestKey: Uint8Array
  /** Versioned domain that prevents digest reuse across evidence purposes. */
  private readonly domain: string
  /** Fixed-size modular sum of per-element HMAC outputs. */
  private readonly modularSum = Buffer.alloc(32)
  /** Maximum exact number of elements accepted before finalization. */
  private readonly maxItemCount: number
  /** Exact number of elements represented by the modular sum. */
  private itemCount = 0
  /** Cached evidence after key material and intermediate digests are zeroized. */
  private finalizedEvidence?: RestoreDrillMultisetDigest
  /** Whether key material was explicitly cleared before finalization. */
  private disposed = false

  /**
   * Creates an empty keyed multiset accumulator.
   *
   * @param digestKey - Exactly 32 bytes of in-memory HMAC key material.
   * @param domain - Canonical versioned lowercase digest domain.
   * @param maxItemCount - Positive bound on retained element digests.
   */
  constructor(digestKey: Uint8Array, domain: string, maxItemCount = 1_000_000) {
    validateDigestKey(digestKey)
    validateDigestDomain(domain)
    if (!Number.isSafeInteger(maxItemCount) || maxItemCount <= 0) {
      throw new RestoreDrillFailure('AGGREGATE_INVALID')
    }
    this.digestKey = Uint8Array.from(digestKey)
    this.domain = domain
    this.maxItemCount = maxItemCount
  }

  /**
   * Adds one canonical text or byte value without retaining the raw input.
   *
   * @param value - Canonical raw value to hash immediately.
   */
  add(value: string | Uint8Array): void {
    if (
      this.disposed ||
      this.finalizedEvidence !== undefined ||
      this.itemCount >= this.maxItemCount ||
      (typeof value !== 'string' && !(value instanceof Uint8Array))
    ) {
      throw new RestoreDrillFailure('AGGREGATE_INVALID')
    }
    const hmac = createDomainHmac(this.digestKey, `${this.domain}/element-v1`)
    if (typeof value === 'string') {
      hmac.update(`text:${Buffer.byteLength(value, 'utf8')}:`, 'utf8')
      hmac.update(value, 'utf8')
    } else {
      hmac.update(`bytes:${value.byteLength}:`, 'utf8')
      hmac.update(value)
    }
    const elementDigest = hmac.digest()
    addDigestModulo256(this.modularSum, elementDigest)
    elementDigest.fill(0)
    this.itemCount += 1
  }

  /**
   * Merges one authenticated compact checkpoint into this accumulator.
   *
   * @param checkpoint - Untrusted durable compact state in the same digest domain.
   */
  mergeCheckpoint(checkpoint: RestoreDrillKeyedMultisetDigestCheckpoint): void {
    if (
      this.disposed ||
      this.finalizedEvidence !== undefined ||
      checkpoint.checkpointVersion !== 1 ||
      !Number.isSafeInteger(checkpoint.itemCount) ||
      checkpoint.itemCount < 0 ||
      this.itemCount + checkpoint.itemCount > this.maxItemCount ||
      !/^[a-f0-9]{64}$/.test(checkpoint.modularSum) ||
      !/^[a-f0-9]{64}$/.test(checkpoint.checkpointMac) ||
      checkpoint.keyFingerprint !== calculateKeyFingerprint(this.digestKey)
    ) {
      throw new RestoreDrillFailure('AGGREGATE_INVALID')
    }
    const expectedMac = this.calculateCheckpointMac(
      checkpoint.itemCount,
      checkpoint.modularSum,
    )
    if (checkpoint.checkpointMac !== expectedMac) {
      throw new RestoreDrillFailure('AGGREGATE_INVALID')
    }
    const sum = Buffer.from(checkpoint.modularSum, 'hex')
    addDigestModulo256(this.modularSum, sum)
    sum.fill(0)
    this.itemCount += checkpoint.itemCount
  }

  /**
   * Returns authenticated constant-size state suitable for a durable page checkpoint.
   *
   * @returns Detached compact state without plaintext values or key bytes.
   */
  checkpoint(): RestoreDrillKeyedMultisetDigestCheckpoint {
    if (this.disposed || this.finalizedEvidence !== undefined) {
      throw new RestoreDrillFailure('AGGREGATE_INVALID')
    }
    const modularSum = this.modularSum.toString('hex')
    return {
      checkpointMac: this.calculateCheckpointMac(this.itemCount, modularSum),
      checkpointVersion: 1,
      itemCount: this.itemCount,
      keyFingerprint: calculateKeyFingerprint(this.digestKey),
      modularSum,
    }
  }

  /**
   * Returns a fresh secret-free aggregate for all values added so far.
   *
   * @returns Order-independent keyed multiset evidence.
   */
  finalize(): RestoreDrillMultisetDigest {
    if (this.finalizedEvidence) return { ...this.finalizedEvidence }
    if (this.disposed) throw new RestoreDrillFailure('AGGREGATE_INVALID')
    const aggregate = createDomainHmac(this.digestKey, `${this.domain}/aggregate-v2`)
    aggregate.update(`${this.itemCount}\n`, 'utf8')
    aggregate.update(this.modularSum)
    const evidence: RestoreDrillMultisetDigest = {
      algorithm: 'HMAC-SHA-256',
      aggregateDigest: aggregate.digest('hex'),
      digestVersion: 2,
      itemCount: this.itemCount,
      keyFingerprint: calculateKeyFingerprint(this.digestKey),
    }
    this.dispose()
    this.finalizedEvidence = evidence
    return { ...evidence }
  }

  /** Calculates the domain-bound MAC for one compact checkpoint. */
  private calculateCheckpointMac(itemCount: number, modularSum: string): string {
    return createDomainHmac(this.digestKey, `${this.domain}/checkpoint-v1`)
      .update(`${itemCount}\n${modularSum}`, 'utf8')
      .digest('hex')
  }

  /** Clears all process-local key material and makes an unfinished accumulator unusable. */
  dispose(): void {
    this.digestKey.fill(0)
    this.modularSum.fill(0)
    this.disposed = true
  }
}

/** Adds one 256-bit big-endian digest modulo 2^256 without retaining the input. */
function addDigestModulo256(accumulator: Uint8Array, digest: Uint8Array): void {
  if (accumulator.byteLength !== 32 || digest.byteLength !== 32) {
    throw new RestoreDrillFailure('AGGREGATE_INVALID')
  }
  let carry = 0
  for (let index = 31; index >= 0; index -= 1) {
    const sum = (accumulator[index] ?? 0) + (digest[index] ?? 0) + carry
    accumulator[index] = sum & 0xff
    carry = sum >>> 8
  }
}

/**
 * Strictly parses a durable phase/outcome pair and rejects impossible combinations.
 *
 * @param value - Untrusted run state.
 * @returns Validated run state.
 * @throws {RestoreDrillFailure} When fields or phase/outcome invariants are invalid.
 */
export function parseRestoreDrillRunState(value: unknown): RestoreDrillRunState {
  const record = readExactRecord(value, ['outcome', 'phase'], 'RUN_STATE_INVALID')
  const phase = readRunPhase(record.phase)
  const outcome = readRunOutcome(record.outcome)
  const terminal = phase === 'completed' || phase === 'failed'
  if ((terminal && outcome === 'in-progress') || (!terminal && outcome !== 'in-progress')) {
    throw new RestoreDrillFailure('RUN_STATE_INVALID')
  }
  if (phase === 'failed' && outcome !== 'fail') {
    throw new RestoreDrillFailure('RUN_STATE_INVALID')
  }
  return { phase, outcome }
}

/**
 * Selects the latest point contained by every required DynamoDB PITR window.
 *
 * @param value - Untrusted six-entry window vector in canonical table order.
 * @returns Common interval and its latest point.
 * @throws {RestoreDrillFailure} When a window is invalid, incomplete, reordered, or disjoint.
 */
export function selectLatestCommonRestorePoint(
  value: unknown,
): RestoreDrillRestorePointSelection {
  if (!Array.isArray(value) || value.length !== RESTORE_DRILL_TABLE_TARGETS.length) {
    throw new RestoreDrillFailure('PITR_WINDOW_TARGET_MISMATCH')
  }
  const windows: RestoreDrillPitrWindow[] = []
  for (let index = 0; index < value.length; index += 1) {
    const expectedTarget = RESTORE_DRILL_TABLE_TARGETS[index]
    if (!expectedTarget) throw new RestoreDrillFailure('PITR_WINDOW_TARGET_MISMATCH')
    const record = readExactRecord(
      value[index],
      ['earliestRestorableTime', 'latestRestorableTime', 'target'],
      'PITR_WINDOW_INVALID',
    )
    if (record.target !== expectedTarget) {
      throw new RestoreDrillFailure('PITR_WINDOW_TARGET_MISMATCH')
    }
    const earliestRestorableTime = readCanonicalTimestamp(
      record.earliestRestorableTime,
      'PITR_WINDOW_INVALID',
    )
    const latestRestorableTime = readCanonicalTimestamp(
      record.latestRestorableTime,
      'PITR_WINDOW_INVALID',
    )
    if (Date.parse(earliestRestorableTime) > Date.parse(latestRestorableTime)) {
      throw new RestoreDrillFailure('PITR_WINDOW_INVALID')
    }
    windows.push({ target: expectedTarget, earliestRestorableTime, latestRestorableTime })
  }

  let commonEarliestRestorableTime = windows[0]?.earliestRestorableTime
  let commonLatestRestorableTime = windows[0]?.latestRestorableTime
  if (!commonEarliestRestorableTime || !commonLatestRestorableTime) {
    throw new RestoreDrillFailure('PITR_WINDOW_TARGET_MISMATCH')
  }
  for (const window of windows.slice(1)) {
    if (Date.parse(window.earliestRestorableTime) > Date.parse(commonEarliestRestorableTime)) {
      commonEarliestRestorableTime = window.earliestRestorableTime
    }
    if (Date.parse(window.latestRestorableTime) < Date.parse(commonLatestRestorableTime)) {
      commonLatestRestorableTime = window.latestRestorableTime
    }
  }
  if (Date.parse(commonEarliestRestorableTime) > Date.parse(commonLatestRestorableTime)) {
    throw new RestoreDrillFailure('PITR_WINDOW_NO_OVERLAP')
  }
  return {
    commonEarliestRestorableTime,
    commonLatestRestorableTime,
    restorePoint: commonLatestRestorableTime,
  }
}

/**
 * Calculates conservative whole-second RPO and RTO measurements and threshold failures.
 *
 * Fractional seconds are rounded upward so evidence never understates either objective.
 *
 * @param value - Untrusted restore point and start/completion timeline.
 * @returns Machine-calculated objective evidence.
 * @throws {RestoreDrillFailure} When timestamps are noncanonical or chronologically invalid.
 */
export function calculateRestoreDrillObjectives(
  value: unknown,
): RestoreDrillObjectiveResult {
  const record = readExactRecord(
    value,
    ['completedAt', 'restorePoint', 'startedAt'],
    'OBJECTIVE_TIMELINE_INVALID',
  )
  const completedAt = readCanonicalTimestamp(record.completedAt, 'OBJECTIVE_TIMELINE_INVALID')
  const restorePoint = readCanonicalTimestamp(record.restorePoint, 'OBJECTIVE_TIMELINE_INVALID')
  const startedAt = readCanonicalTimestamp(record.startedAt, 'OBJECTIVE_TIMELINE_INVALID')
  const restorePointMs = Date.parse(restorePoint)
  const startedAtMs = Date.parse(startedAt)
  const completedAtMs = Date.parse(completedAt)
  if (restorePointMs > startedAtMs || startedAtMs > completedAtMs) {
    throw new RestoreDrillFailure('OBJECTIVE_TIMELINE_INVALID')
  }
  const rpoSeconds = Math.ceil((startedAtMs - restorePointMs) / 1_000)
  const rtoSeconds = Math.ceil((completedAtMs - startedAtMs) / 1_000)
  const rpoMet = rpoSeconds <= RESTORE_DRILL_RPO_TARGET_SECONDS
  const rtoMet = rtoSeconds <= RESTORE_DRILL_RTO_TARGET_SECONDS
  const failureCodes: RestoreDrillFailureCode[] = []
  if (!rpoMet) failureCodes.push('RPO_TARGET_MISSED')
  if (!rtoMet) failureCodes.push('RTO_TARGET_MISSED')
  return {
    failureCodes,
    rpoSeconds,
    rpoMet,
    rpoTargetSeconds: RESTORE_DRILL_RPO_TARGET_SECONDS,
    rtoSeconds,
    rtoMet,
    rtoTargetSeconds: RESTORE_DRILL_RTO_TARGET_SECONDS,
  }
}

/**
 * Strictly parses a complete source-export or isolated-restore aggregate.
 *
 * @param value - Untrusted aggregate artifact.
 * @returns Canonically ordered validated aggregate.
 * @throws {RestoreDrillFailure} When any field, digest, count, or resource order is invalid.
 */
export function parseRestoreDrillDatasetAggregate(
  value: unknown,
): RestoreDrillDatasetAggregate {
  const record = readExactRecord(
    value,
    ['keyFingerprint', 'resources', 'restorePoint', 'role'],
    'AGGREGATE_INVALID',
  )
  const role = readDatasetRole(record.role)
  const restorePoint = readCanonicalTimestamp(record.restorePoint, 'AGGREGATE_INVALID')
  const keyFingerprint = readHexDigest(record.keyFingerprint, 'AGGREGATE_INVALID')
  if (
    !Array.isArray(record.resources) ||
    record.resources.length !== RESTORE_DRILL_RESOURCE_TARGETS.length
  ) {
    throw new RestoreDrillFailure('AGGREGATE_RESOURCE_MISMATCH')
  }
  const resources: RestoreDrillResourceAggregate[] = []
  for (let index = 0; index < record.resources.length; index += 1) {
    const expectedTarget = RESTORE_DRILL_RESOURCE_TARGETS[index]
    if (!expectedTarget) throw new RestoreDrillFailure('AGGREGATE_RESOURCE_MISMATCH')
    const resource = readExactRecord(
      record.resources[index],
      [
        'contentDigest',
        'descriptorDigest',
        'logicalPartitionCount',
        'metadataDigest',
        'recordCount',
        'target',
      ],
      'AGGREGATE_INVALID',
    )
    if (resource.target !== expectedTarget) {
      throw new RestoreDrillFailure('AGGREGATE_RESOURCE_MISMATCH')
    }
    resources.push({
      contentDigest: readHexDigest(resource.contentDigest, 'AGGREGATE_INVALID'),
      descriptorDigest: readHexDigest(resource.descriptorDigest, 'AGGREGATE_INVALID'),
      logicalPartitionCount: readNonNegativeInteger(
        resource.logicalPartitionCount,
        'AGGREGATE_INVALID',
      ),
      metadataDigest: readHexDigest(resource.metadataDigest, 'AGGREGATE_INVALID'),
      recordCount: readNonNegativeInteger(resource.recordCount, 'AGGREGATE_INVALID'),
      target: expectedTarget,
    })
  }
  return { keyFingerprint, resources, restorePoint, role }
}

/**
 * Compares complete source-export and isolated-restore aggregates exactly.
 *
 * @param sourceValue - Untrusted source-export aggregate.
 * @param restoreValue - Untrusted isolated-restore aggregate.
 * @returns Secret-free exact comparison with stable mismatch categories.
 */
export function compareRestoreDrillDatasetAggregates(
  sourceValue: unknown,
  restoreValue: unknown,
): RestoreDrillAggregateComparison {
  const source = parseRestoreDrillDatasetAggregate(sourceValue)
  const restore = parseRestoreDrillDatasetAggregate(restoreValue)
  const failureCodes: RestoreDrillFailureCode[] = []
  if (source.role !== 'source-export' || restore.role !== 'isolated-restore') {
    failureCodes.push('AGGREGATE_ROLE_MISMATCH')
  }
  if (source.restorePoint !== restore.restorePoint) {
    failureCodes.push('AGGREGATE_RESTORE_POINT_MISMATCH')
  }
  if (source.keyFingerprint !== restore.keyFingerprint) {
    failureCodes.push('AGGREGATE_KEY_MISMATCH')
  }
  for (let index = 0; index < source.resources.length; index += 1) {
    const sourceResource = source.resources[index]
    const restoreResource = restore.resources[index]
    if (!sourceResource || !restoreResource || sourceResource.target !== restoreResource.target) {
      failureCodes.push('AGGREGATE_RESOURCE_MISMATCH')
      continue
    }
    if (sourceResource.descriptorDigest !== restoreResource.descriptorDigest) {
      failureCodes.push('AGGREGATE_DESCRIPTOR_MISMATCH')
    }
    if (sourceResource.contentDigest !== restoreResource.contentDigest) {
      failureCodes.push('AGGREGATE_CONTENT_MISMATCH')
    }
    if (sourceResource.metadataDigest !== restoreResource.metadataDigest) {
      failureCodes.push('AGGREGATE_METADATA_MISMATCH')
    }
    if (sourceResource.recordCount !== restoreResource.recordCount) {
      failureCodes.push('AGGREGATE_RECORD_COUNT_MISMATCH')
    }
    if (sourceResource.logicalPartitionCount !== restoreResource.logicalPartitionCount) {
      failureCodes.push('AGGREGATE_PARTITION_COUNT_MISMATCH')
    }
  }
  const canonicalFailureCodes = canonicalizeFailureCodes(failureCodes)
  return {
    failureCodes: canonicalFailureCodes,
    status: canonicalFailureCodes.length === 0 ? 'pass' : 'fail',
  }
}

/**
 * Calculates a keyed digest over one strictly parsed dataset aggregate.
 *
 * @param value - Untrusted source-export or isolated-restore aggregate.
 * @param digestKey - Exactly 32 bytes of in-memory HMAC key material.
 * @returns Lowercase HMAC-SHA-256 digest.
 */
export function calculateRestoreDrillDatasetDigest(
  value: unknown,
  digestKey: Uint8Array,
): string {
  validateDigestKey(digestKey)
  const aggregate = parseRestoreDrillDatasetAggregate(value)
  const fields: string[] = [
    aggregate.role,
    aggregate.restorePoint,
    aggregate.keyFingerprint,
    String(aggregate.resources.length),
  ]
  for (const resource of aggregate.resources) {
    fields.push(
      resource.target,
      String(resource.recordCount),
      String(resource.logicalPartitionCount),
      resource.descriptorDigest,
      resource.contentDigest,
      resource.metadataDigest,
    )
  }
  return keyedDigest(digestKey, 'dataset-aggregate-v1', canonicalFields(fields))
}

/**
 * Calculates a keyed digest over the complete isolated physical-resource identity vector.
 *
 * @param value - Untrusted resource identity vector in canonical fixed order.
 * @param digestKey - Exactly 32 bytes of in-memory HMAC key material.
 * @returns Lowercase HMAC-SHA-256 resource digest without physical resource names.
 */
export function calculateRestoreDrillResourceDigest(
  value: unknown,
  digestKey: Uint8Array,
): string {
  validateDigestKey(digestKey)
  const identities = parseResourceIdentities(value)
  const fields: string[] = [String(identities.length)]
  for (const identity of identities) fields.push(identity.target, identity.identityDigest)
  return keyedDigest(digestKey, 'physical-resource-vector-v1', canonicalFields(fields))
}

/**
 * Calculates the approval-bound keyed digest for strict terminal evidence.
 *
 * @param value - Untrusted final restore-drill evidence.
 * @param digestKey - Exactly 32 bytes of in-memory HMAC key material.
 * @returns Lowercase HMAC-SHA-256 result digest.
 */
export function calculateRestoreDrillResultDigest(
  value: unknown,
  digestKey: Uint8Array,
): string {
  validateDigestKey(digestKey)
  const result = parseResultEvidence(value)
  const fields = [
    result.kind,
    String(result.resultVersion),
    result.drillId,
    result.runState.phase,
    result.runState.outcome,
    result.restorePoint,
    result.startedAt,
    result.completedAt,
    String(result.objectives.rpoSeconds),
    String(result.objectives.rpoTargetSeconds),
    String(result.objectives.rpoMet),
    String(result.objectives.rtoSeconds),
    String(result.objectives.rtoTargetSeconds),
    String(result.objectives.rtoMet),
    result.comparison.status,
    ...result.comparison.failureCodes,
    result.resourceDigest,
    result.sourceAggregateDigest,
    result.restoreAggregateDigest,
    ...result.failureCodes,
  ]
  return keyedDigest(digestKey, 'result-evidence-v1', canonicalFields(fields))
}

/**
 * Creates an authenticated cleanup approval bound to exact resources, evidence, and change.
 *
 * @param value - Approval fields that must all be authenticated.
 * @param digestKey - Exactly 32 bytes of in-memory HMAC key material.
 * @returns Strict authenticated cleanup approval receipt.
 */
export function createRestoreDrillCleanupApprovalReceipt(
  value: RestoreDrillCleanupApprovalBinding,
  digestKey: Uint8Array,
): RestoreDrillCleanupApprovalReceipt {
  validateDigestKey(digestKey)
  const bindingRecord = readExactRecord(
    value,
    APPROVAL_BINDING_KEYS,
    'APPROVAL_RECEIPT_INVALID',
  )
  const binding = parseApprovalBinding(bindingRecord, 'APPROVAL_RECEIPT_INVALID')
  const keyFingerprint = calculateKeyFingerprint(digestKey)
  const unsigned: UnsignedCleanupApprovalReceipt = {
    ...binding,
    algorithm: 'HMAC-SHA-256',
    keyFingerprint,
    kind: 'mukuroji-restore-drill-cleanup-approval',
    receiptVersion: 1,
  }
  return {
    ...unsigned,
    approvalMac: calculateApprovalMac(unsigned, digestKey),
  }
}

/**
 * Creates the one deterministic Standard Step Functions execution name for a receipt.
 *
 * @param receipt - Strict cleanup approval whose MAC uniquely identifies the admission.
 * @returns An 80-character Step Functions compatible execution name.
 */
export function createRestoreDrillCleanupExecutionName(
  receipt: RestoreDrillCleanupApprovalReceipt,
): string {
  const parsed = parseApprovalReceipt(receipt)
  return `restore-cleanup-${parsed.approvalMac}`
}

/**
 * Evaluates an untrusted cleanup receipt and denies cleanup on every validation uncertainty.
 *
 * @param input - Untrusted receipt, exact expected scope, decision time, and HMAC key.
 * @returns Secret-free eligibility decision with stable denial categories.
 */
export function evaluateRestoreDrillCleanupApproval(
  input: EvaluateRestoreDrillCleanupApprovalInput,
): RestoreDrillCleanupDecision {
  try {
    validateDigestKey(input.digestKey)
    const now = readCanonicalTimestamp(input.now, 'CLEANUP_CONTEXT_INVALID')
    const expected = parseCleanupExpectation(input.expected)
    const receipt = parseApprovalReceipt(input.receipt)
    const expectedFingerprint = calculateKeyFingerprint(input.digestKey)
    const expectedMac = calculateApprovalMac(receipt, input.digestKey)
    if (
      !safeHexEqual(receipt.keyFingerprint, expectedFingerprint) ||
      !safeHexEqual(receipt.approvalMac, expectedMac)
    ) {
      return denied('APPROVAL_AUTHENTICATION_FAILED')
    }

    const failures: RestoreDrillFailureCode[] = []
    if (receipt.drillId !== expected.drillId) failures.push('APPROVAL_DRILL_MISMATCH')
    if (receipt.resourceDigest !== expected.resourceDigest) {
      failures.push('APPROVAL_RESOURCE_MISMATCH')
    }
    if (receipt.resultDigest !== expected.resultDigest) failures.push('APPROVAL_RESULT_MISMATCH')
    if (receipt.changeLocator !== expected.changeLocator) {
      failures.push('APPROVAL_CHANGE_MISMATCH')
    }
    if (receipt.policyVersion !== expected.policyVersion) {
      failures.push('APPROVAL_POLICY_MISMATCH')
    }
    if (!expected.authorizedApprovers.includes(receipt.approver)) {
      failures.push('APPROVAL_APPROVER_UNAUTHORIZED')
    }
    const nowMs = Date.parse(now)
    if (nowMs < Date.parse(receipt.approvedAt)) failures.push('APPROVAL_NOT_YET_VALID')
    if (nowMs >= Date.parse(receipt.expiresAt)) failures.push('APPROVAL_EXPIRED')
    const failureCodes = canonicalizeFailureCodes(failures)
    return { eligible: failureCodes.length === 0, failureCodes }
  } catch (error: unknown) {
    if (error instanceof RestoreDrillFailure) return denied(error.code)
    return denied('CLEANUP_CONTEXT_INVALID')
  }
}

/** Unsigned portion of an approval receipt accepted by the MAC calculator. */
type UnsignedCleanupApprovalReceipt = RestoreDrillCleanupApprovalBinding & {
  /** Fixed receipt digest algorithm. */
  algorithm: 'HMAC-SHA-256'
  /** Non-secret fingerprint of the receipt HMAC key. */
  keyFingerprint: string
  /** Fixed receipt discriminator. */
  kind: 'mukuroji-restore-drill-cleanup-approval'
  /** Receipt contract version. */
  receiptVersion: 1
}

const KNOWN_FAILURE_CODES = new Set<string>([
  'AGGREGATE_CONTENT_MISMATCH',
  'AGGREGATE_DESCRIPTOR_MISMATCH',
  'AGGREGATE_INVALID',
  'AGGREGATE_KEY_MISMATCH',
  'AGGREGATE_METADATA_MISMATCH',
  'AGGREGATE_PARTITION_COUNT_MISMATCH',
  'AGGREGATE_RECORD_COUNT_MISMATCH',
  'AGGREGATE_RESOURCE_MISMATCH',
  'AGGREGATE_RESTORE_POINT_MISMATCH',
  'AGGREGATE_ROLE_MISMATCH',
  'APPROVAL_APPROVER_UNAUTHORIZED',
  'APPROVAL_AUTHENTICATION_FAILED',
  'APPROVAL_CHANGE_MISMATCH',
  'APPROVAL_DRILL_MISMATCH',
  'APPROVAL_EXPIRED',
  'APPROVAL_NOT_YET_VALID',
  'APPROVAL_POLICY_MISMATCH',
  'APPROVAL_RECEIPT_INVALID',
  'APPROVAL_RESOURCE_MISMATCH',
  'APPROVAL_RESULT_MISMATCH',
  'CADENCE_OVERDUE',
  'CLEANUP_CONTEXT_INVALID',
  'CLEANUP_FAILED',
  'CROSS_DOMAIN_INTEGRITY_FAILED',
  'DIGEST_DOMAIN_INVALID',
  'DIGEST_KEY_INVALID',
  'DYNAMODB_RESTORE_FAILED',
  'EVIDENCE_INVALID',
  'EVIDENCE_PERSIST_FAILED',
  'OBJECTIVE_TIMELINE_INVALID',
  'PITR_WINDOW_INVALID',
  'PITR_WINDOW_NO_OVERLAP',
  'PITR_WINDOW_TARGET_MISMATCH',
  'RESOURCE_IDENTITY_INVALID',
  'RPO_TARGET_MISSED',
  'RTO_TARGET_MISSED',
  'RUN_STATE_INVALID',
  'S3_VERSION_RESTORE_FAILED',
  'WORKFLOW_POLL_BUDGET_EXCEEDED',
  'WORKFLOW_TASK_FAILED',
])

/** Strict keys present in approval fields before receipt authentication metadata is added. */
const APPROVAL_BINDING_KEYS = [
  'approvedAt',
  'approver',
  'changeLocator',
  'drillId',
  'expiresAt',
  'policyVersion',
  'resourceDigest',
  'resultDigest',
]

/** Strict keys present in a serialized cleanup receipt. */
const APPROVAL_RECEIPT_KEYS = [
  'algorithm',
  'approvalMac',
  'approvedAt',
  'approver',
  'changeLocator',
  'drillId',
  'expiresAt',
  'keyFingerprint',
  'kind',
  'policyVersion',
  'receiptVersion',
  'resourceDigest',
  'resultDigest',
]

/**
 * Strictly parses terminal evidence and enforces cross-field result invariants.
 *
 * @param value - Untrusted terminal evidence.
 * @returns Validated evidence.
 */
function parseResultEvidence(value: unknown): RestoreDrillResultEvidence {
  const record = readExactRecord(
    value,
    [
      'completedAt',
      'comparison',
      'drillId',
      'failureCodes',
      'kind',
      'objectives',
      'resourceDigest',
      'restoreAggregateDigest',
      'restorePoint',
      'resultVersion',
      'runState',
      'sourceAggregateDigest',
      'startedAt',
    ],
    'EVIDENCE_INVALID',
  )
  if (record.kind !== 'mukuroji-restore-drill-result' || record.resultVersion !== 1) {
    throw new RestoreDrillFailure('EVIDENCE_INVALID')
  }
  const drillId = readIdentifier(record.drillId, 'EVIDENCE_INVALID')
  const runState = parseRestoreDrillRunState(record.runState)
  if (runState.phase !== 'completed' && runState.phase !== 'failed') {
    throw new RestoreDrillFailure('EVIDENCE_INVALID')
  }
  const restorePoint = readCanonicalTimestamp(record.restorePoint, 'EVIDENCE_INVALID')
  const startedAt = readCanonicalTimestamp(record.startedAt, 'EVIDENCE_INVALID')
  const completedAt = readCanonicalTimestamp(record.completedAt, 'EVIDENCE_INVALID')
  const objectives = parseObjectiveResult(record.objectives, { restorePoint, startedAt, completedAt })
  const comparison = parseAggregateComparison(record.comparison)
  const failureCodes = readFailureCodes(record.failureCodes, 'EVIDENCE_INVALID')
  const resourceDigest = readHexDigest(record.resourceDigest, 'EVIDENCE_INVALID')
  const sourceAggregateDigest = readHexDigest(record.sourceAggregateDigest, 'EVIDENCE_INVALID')
  const restoreAggregateDigest = readHexDigest(record.restoreAggregateDigest, 'EVIDENCE_INVALID')
  const requiredFailures = canonicalizeFailureCodes([
    ...objectives.failureCodes,
    ...comparison.failureCodes,
  ])
  if (!requiredFailures.every((code) => failureCodes.includes(code))) {
    throw new RestoreDrillFailure('EVIDENCE_INVALID')
  }
  const successful =
    runState.phase === 'completed' &&
    runState.outcome === 'pass' &&
    objectives.rpoMet &&
    objectives.rtoMet &&
    comparison.status === 'pass' &&
    failureCodes.length === 0
  if (runState.outcome === 'pass' && !successful) {
    throw new RestoreDrillFailure('EVIDENCE_INVALID')
  }
  if (runState.outcome === 'fail' && failureCodes.length === 0) {
    throw new RestoreDrillFailure('EVIDENCE_INVALID')
  }
  return {
    completedAt,
    comparison,
    drillId,
    failureCodes,
    kind: 'mukuroji-restore-drill-result',
    objectives,
    resourceDigest,
    restorePoint,
    restoreAggregateDigest,
    runState,
    resultVersion: 1,
    sourceAggregateDigest,
    startedAt,
  }
}

/**
 * Parses an objective result and verifies it against the canonical timeline calculation.
 *
 * @param value - Untrusted objective result.
 * @param timeline - Validated timeline used for recomputation.
 * @returns Validated objective result.
 */
function parseObjectiveResult(
  value: unknown,
  timeline: CalculateRestoreDrillObjectivesInput,
): RestoreDrillObjectiveResult {
  const record = readExactRecord(
    value,
    [
      'failureCodes',
      'rpoMet',
      'rpoSeconds',
      'rpoTargetSeconds',
      'rtoMet',
      'rtoSeconds',
      'rtoTargetSeconds',
    ],
    'EVIDENCE_INVALID',
  )
  const calculated = calculateRestoreDrillObjectives(timeline)
  const failureCodes = readFailureCodes(record.failureCodes, 'EVIDENCE_INVALID')
  if (
    record.rpoSeconds !== calculated.rpoSeconds ||
    record.rpoTargetSeconds !== calculated.rpoTargetSeconds ||
    record.rpoMet !== calculated.rpoMet ||
    record.rtoSeconds !== calculated.rtoSeconds ||
    record.rtoTargetSeconds !== calculated.rtoTargetSeconds ||
    record.rtoMet !== calculated.rtoMet ||
    failureCodes.join('\0') !== calculated.failureCodes.join('\0')
  ) {
    throw new RestoreDrillFailure('EVIDENCE_INVALID')
  }
  return calculated
}

/**
 * Strictly parses an aggregate comparison.
 *
 * @param value - Untrusted comparison result.
 * @returns Validated comparison.
 */
function parseAggregateComparison(value: unknown): RestoreDrillAggregateComparison {
  const record = readExactRecord(value, ['failureCodes', 'status'], 'EVIDENCE_INVALID')
  if (record.status !== 'pass' && record.status !== 'fail') {
    throw new RestoreDrillFailure('EVIDENCE_INVALID')
  }
  const failureCodes = readFailureCodes(record.failureCodes, 'EVIDENCE_INVALID')
  if ((record.status === 'pass') !== (failureCodes.length === 0)) {
    throw new RestoreDrillFailure('EVIDENCE_INVALID')
  }
  return { failureCodes, status: record.status }
}

/**
 * Strictly parses the canonical physical-resource identity vector.
 *
 * @param value - Untrusted identity vector.
 * @returns Validated identities in canonical order.
 */
function parseResourceIdentities(value: unknown): RestoreDrillResourceIdentity[] {
  if (!Array.isArray(value) || value.length !== RESTORE_DRILL_RESOURCE_TARGETS.length) {
    throw new RestoreDrillFailure('RESOURCE_IDENTITY_INVALID')
  }
  const identities: RestoreDrillResourceIdentity[] = []
  for (let index = 0; index < value.length; index += 1) {
    const expectedTarget = RESTORE_DRILL_RESOURCE_TARGETS[index]
    if (!expectedTarget) throw new RestoreDrillFailure('RESOURCE_IDENTITY_INVALID')
    const record = readExactRecord(
      value[index],
      ['identityDigest', 'target'],
      'RESOURCE_IDENTITY_INVALID',
    )
    if (record.target !== expectedTarget) {
      throw new RestoreDrillFailure('RESOURCE_IDENTITY_INVALID')
    }
    identities.push({
      identityDigest: readHexDigest(record.identityDigest, 'RESOURCE_IDENTITY_INVALID'),
      target: expectedTarget,
    })
  }
  return identities
}

/**
 * Strictly parses the authenticated cleanup approval receipt.
 *
 * @param value - Untrusted receipt.
 * @returns Validated receipt.
 */
function parseApprovalReceipt(value: unknown): RestoreDrillCleanupApprovalReceipt {
  const record = readExactRecord(value, APPROVAL_RECEIPT_KEYS, 'APPROVAL_RECEIPT_INVALID')
  if (
    record.algorithm !== 'HMAC-SHA-256' ||
    record.kind !== 'mukuroji-restore-drill-cleanup-approval' ||
    record.receiptVersion !== 1
  ) {
    throw new RestoreDrillFailure('APPROVAL_RECEIPT_INVALID')
  }
  const binding = parseApprovalBinding(record, 'APPROVAL_RECEIPT_INVALID')
  return {
    ...binding,
    algorithm: 'HMAC-SHA-256',
    approvalMac: readHexDigest(record.approvalMac, 'APPROVAL_RECEIPT_INVALID'),
    keyFingerprint: readHexDigest(record.keyFingerprint, 'APPROVAL_RECEIPT_INVALID'),
    kind: 'mukuroji-restore-drill-cleanup-approval',
    receiptVersion: 1,
  }
}

/**
 * Parses fields covered by the approval MAC and validates the approval interval.
 *
 * @param value - Untrusted approval binding.
 * @param failureCode - Stable failure used for malformed values.
 * @returns Validated approval binding.
 */
function parseApprovalBinding(
  value: unknown,
  failureCode: RestoreDrillFailureCode,
): RestoreDrillCleanupApprovalBinding {
  if (!isRecord(value)) throw new RestoreDrillFailure(failureCode)
  const approvedAt = readCanonicalTimestamp(value.approvedAt, failureCode)
  const expiresAt = readCanonicalTimestamp(value.expiresAt, failureCode)
  const approvalWindowMilliseconds = Date.parse(expiresAt) - Date.parse(approvedAt)
  if (
    approvalWindowMilliseconds <= 0 ||
    approvalWindowMilliseconds > RESTORE_DRILL_CLEANUP_APPROVAL_MAXIMUM_MILLISECONDS
  ) {
    throw new RestoreDrillFailure(failureCode)
  }
  return {
    approver: readIdentifier(value.approver, failureCode),
    approvedAt,
    changeLocator: readChangeLocator(value.changeLocator, failureCode),
    drillId: readIdentifier(value.drillId, failureCode),
    expiresAt,
    policyVersion: readPolicyVersion(value.policyVersion, failureCode),
    resourceDigest: readHexDigest(value.resourceDigest, failureCode),
    resultDigest: readHexDigest(value.resultDigest, failureCode),
  }
}

/**
 * Strictly validates the expected cleanup scope.
 *
 * @param value - Caller-supplied expected scope.
 * @returns Validated expected scope.
 */
function parseCleanupExpectation(
  value: RestoreDrillCleanupExpectation,
): RestoreDrillCleanupExpectation {
  const record = readExactRecord(
    value,
    [
      'authorizedApprovers',
      'changeLocator',
      'drillId',
      'policyVersion',
      'resourceDigest',
      'resultDigest',
    ],
    'CLEANUP_CONTEXT_INVALID',
  )
  if (!Array.isArray(record.authorizedApprovers) || record.authorizedApprovers.length === 0) {
    throw new RestoreDrillFailure('CLEANUP_CONTEXT_INVALID')
  }
  const authorizedApprovers: string[] = []
  for (const approver of record.authorizedApprovers) {
    authorizedApprovers.push(readIdentifier(approver, 'CLEANUP_CONTEXT_INVALID'))
  }
  if (new Set(authorizedApprovers).size !== authorizedApprovers.length) {
    throw new RestoreDrillFailure('CLEANUP_CONTEXT_INVALID')
  }
  return {
    authorizedApprovers,
    changeLocator: readChangeLocator(record.changeLocator, 'CLEANUP_CONTEXT_INVALID'),
    drillId: readIdentifier(record.drillId, 'CLEANUP_CONTEXT_INVALID'),
    policyVersion: readPolicyVersion(record.policyVersion, 'CLEANUP_CONTEXT_INVALID'),
    resourceDigest: readHexDigest(record.resourceDigest, 'CLEANUP_CONTEXT_INVALID'),
    resultDigest: readHexDigest(record.resultDigest, 'CLEANUP_CONTEXT_INVALID'),
  }
}

/**
 * Calculates an approval MAC over every unsigned receipt field.
 *
 * @param receipt - Receipt fields excluding the MAC.
 * @param digestKey - In-memory HMAC key.
 * @returns Lowercase HMAC-SHA-256 approval MAC.
 */
function calculateApprovalMac(
  receipt: UnsignedCleanupApprovalReceipt,
  digestKey: Uint8Array,
): string {
  return keyedDigest(digestKey, 'cleanup-approval-v1', canonicalFields([
    receipt.kind,
    String(receipt.receiptVersion),
    receipt.algorithm,
    receipt.keyFingerprint,
    receipt.drillId,
    receipt.resourceDigest,
    receipt.resultDigest,
    receipt.approver,
    receipt.approvedAt,
    receipt.expiresAt,
    receipt.changeLocator,
    receipt.policyVersion,
  ]))
}

/**
 * Creates a canonical denial decision for one stable failure.
 *
 * @param failureCode - Stable denial category.
 * @returns Fail-closed cleanup decision.
 */
function denied(failureCode: RestoreDrillFailureCode): RestoreDrillCleanupDecision {
  return { eligible: false, failureCodes: [failureCode] }
}

/**
 * Validates an exactly 32-byte HMAC key.
 *
 * @param digestKey - Candidate key material.
 */
function validateDigestKey(digestKey: Uint8Array): void {
  if (!(digestKey instanceof Uint8Array) || digestKey.byteLength !== 32) {
    throw new RestoreDrillFailure('DIGEST_KEY_INVALID')
  }
}

/**
 * Validates a lowercase versioned digest domain.
 *
 * @param domain - Candidate digest domain.
 */
function validateDigestDomain(domain: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$/.test(domain)) {
    throw new RestoreDrillFailure('DIGEST_DOMAIN_INVALID')
  }
}

/**
 * Calculates the non-secret fingerprint for one HMAC key.
 *
 * @param digestKey - Validated 32-byte HMAC key.
 * @returns Lowercase key fingerprint.
 */
function calculateKeyFingerprint(digestKey: Uint8Array): string {
  return keyedDigest(digestKey, 'key-fingerprint-v1', 'restore-drill')
}

/**
 * Calculates one domain-separated HMAC digest.
 *
 * @param digestKey - Validated HMAC key.
 * @param domain - Internal versioned digest purpose.
 * @param value - Canonical payload.
 * @returns Lowercase HMAC-SHA-256 digest.
 */
function keyedDigest(digestKey: Uint8Array, domain: string, value: string): string {
  return createDomainHmac(digestKey, domain).update(value, 'utf8').digest('hex')
}

/**
 * Creates an HMAC initialized with the global restore-drill domain.
 *
 * @param digestKey - Validated HMAC key.
 * @param domain - Internal versioned digest purpose.
 * @returns Initialized HMAC instance.
 */
function createDomainHmac(digestKey: Uint8Array, domain: string) {
  return createHmac('sha256', digestKey)
    .update(`mukuroji-restore-drill\0${domain}\0`, 'utf8')
}

/**
 * Encodes fields with UTF-8 byte lengths and no delimiter ambiguity.
 *
 * @param fields - Canonically ordered fields.
 * @returns Unambiguous canonical representation.
 */
function canonicalFields(fields: readonly string[]): string {
  return fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('|')
}

/**
 * Sorts and deduplicates stable failure codes.
 *
 * @param values - Failure codes in arbitrary discovery order.
 * @returns Canonical failure-code vector.
 */
function canonicalizeFailureCodes(
  values: readonly RestoreDrillFailureCode[],
): RestoreDrillFailureCode[] {
  return [...new Set(values)].sort(compareUtf8Ordinal)
}

/**
 * Compares strings by their UTF-8 ordinal byte representation.
 *
 * @param left - Left string.
 * @param right - Right string.
 * @returns Negative, zero, or positive comparison result.
 */
function compareUtf8Ordinal(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

/**
 * Compares canonical hex values without data-dependent early exit.
 *
 * @param left - First lowercase SHA-256 hex value.
 * @param right - Second lowercase SHA-256 hex value.
 * @returns Whether both byte sequences are equal.
 */
function safeHexEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'hex')
  const rightBytes = Buffer.from(right, 'hex')
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes)
}

/**
 * Reads an object with an exact key set.
 *
 * @param value - Untrusted value.
 * @param expectedKeys - Complete accepted key set.
 * @param failureCode - Stable parse failure.
 * @returns Validated object record.
 */
function readExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  failureCode: RestoreDrillFailureCode,
): Record<string, unknown> {
  if (!isRecord(value)) throw new RestoreDrillFailure(failureCode)
  const actualKeys = Object.keys(value).sort(compareUtf8Ordinal)
  const canonicalExpectedKeys = [...expectedKeys].sort(compareUtf8Ordinal)
  if (actualKeys.join('\0') !== canonicalExpectedKeys.join('\0')) {
    throw new RestoreDrillFailure(failureCode)
  }
  return value
}

/**
 * Narrows a value to a plain non-array object.
 *
 * @param value - Candidate value.
 * @returns Whether the value is a plain record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Reads a canonical millisecond-precision UTC timestamp.
 *
 * @param value - Untrusted timestamp.
 * @param failureCode - Stable parse failure.
 * @returns Validated timestamp.
 */
function readCanonicalTimestamp(
  value: unknown,
  failureCode: RestoreDrillFailureCode,
): string {
  if (typeof value !== 'string') throw new RestoreDrillFailure(failureCode)
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new RestoreDrillFailure(failureCode)
  }
  return value
}

/**
 * Reads a lowercase SHA-256 hex digest.
 *
 * @param value - Untrusted digest.
 * @param failureCode - Stable parse failure.
 * @returns Validated digest.
 */
function readHexDigest(value: unknown, failureCode: RestoreDrillFailureCode): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new RestoreDrillFailure(failureCode)
  }
  return value
}

/**
 * Reads a non-negative safe integer.
 *
 * @param value - Untrusted count.
 * @param failureCode - Stable parse failure.
 * @returns Validated count.
 */
function readNonNegativeInteger(
  value: unknown,
  failureCode: RestoreDrillFailureCode,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RestoreDrillFailure(failureCode)
  }
  return value
}

/**
 * Reads a bounded, trimmed identifier without control characters.
 *
 * @param value - Untrusted identifier.
 * @param failureCode - Stable parse failure.
 * @returns Validated identifier.
 */
function readIdentifier(value: unknown, failureCode: RestoreDrillFailureCode): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    throw new RestoreDrillFailure(failureCode)
  }
  return value
}

/**
 * Reads a bounded immutable change locator without control characters.
 *
 * @param value - Untrusted change locator.
 * @param failureCode - Stable parse failure.
 * @returns Validated change locator.
 */
function readChangeLocator(value: unknown, failureCode: RestoreDrillFailureCode): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    hasControlCharacters(value)
  ) {
    throw new RestoreDrillFailure(failureCode)
  }
  return value
}

/**
 * Reads a canonical cleanup policy version token.
 *
 * @param value - Untrusted policy version.
 * @param failureCode - Stable parse failure.
 * @returns Validated policy version.
 */
function readPolicyVersion(value: unknown, failureCode: RestoreDrillFailureCode): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new RestoreDrillFailure(failureCode)
  }
  return value
}

/**
 * Checks for C0 or delete control characters without embedding them in a regular expression.
 *
 * @param value - Candidate human-readable evidence field.
 * @returns Whether the field contains a control character.
 */
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}

/**
 * Reads a known durable phase.
 *
 * @param value - Untrusted phase.
 * @returns Validated phase.
 */
function readRunPhase(value: unknown): RestoreDrillRunPhase {
  if (
    value === 'awaiting-cleanup-approval' ||
    value === 'cleaning-up' ||
    value === 'completed' ||
    value === 'copying-file-versions' ||
    value === 'discovering-pitr-windows' ||
    value === 'failed' ||
    value === 'restoring-tables' ||
    value === 'scheduled' ||
    value === 'verifying'
  ) {
    return value
  }
  throw new RestoreDrillFailure('RUN_STATE_INVALID')
}

/**
 * Reads a known run outcome.
 *
 * @param value - Untrusted outcome.
 * @returns Validated outcome.
 */
function readRunOutcome(value: unknown): RestoreDrillRunOutcome {
  if (value === 'fail' || value === 'in-progress' || value === 'pass') return value
  throw new RestoreDrillFailure('RUN_STATE_INVALID')
}

/**
 * Reads a source-export or isolated-restore role.
 *
 * @param value - Untrusted role.
 * @returns Validated role.
 */
function readDatasetRole(value: unknown): RestoreDrillDatasetRole {
  if (value === 'source-export' || value === 'isolated-restore') return value
  throw new RestoreDrillFailure('AGGREGATE_INVALID')
}

/**
 * Reads a canonical sorted unique stable failure-code vector.
 *
 * @param value - Untrusted failure list.
 * @param failureCode - Stable parse failure.
 * @returns Validated failure list.
 */
function readFailureCodes(
  value: unknown,
  failureCode: RestoreDrillFailureCode,
): RestoreDrillFailureCode[] {
  if (!Array.isArray(value)) throw new RestoreDrillFailure(failureCode)
  const values: RestoreDrillFailureCode[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !isRestoreDrillFailureCode(entry)) {
      throw new RestoreDrillFailure(failureCode)
    }
    values.push(entry)
  }
  const canonical = canonicalizeFailureCodes(values)
  if (canonical.join('\0') !== values.join('\0')) {
    throw new RestoreDrillFailure(failureCode)
  }
  return values
}

/**
 * Narrows one string to the stable failure-code union.
 *
 * @param value - Candidate failure code.
 * @returns Whether the value is a known stable failure code.
 */
function isRestoreDrillFailureCode(value: string): value is RestoreDrillFailureCode {
  return KNOWN_FAILURE_CODES.has(value)
}
