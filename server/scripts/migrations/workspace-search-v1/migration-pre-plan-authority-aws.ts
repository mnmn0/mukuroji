import {
  GetItemCommand,
  ResourceNotFoundException,
  TransactionCanceledException,
  TransactionConflictException,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type TransactWriteItem,
  type TransactWriteItemsCommandOutput,
} from '@aws-sdk/client-dynamodb'
import {
  isThrottlingError,
  isTransientError,
} from '@smithy/core/retry'
import {
  decodeAttributeMap,
  encodeUnknownAttributeMap,
  validateDynamoDbItemSize,
} from './dynamodb-attribute-codec'
import {
  createMigrationDigest,
  isCanonicalTimestamp,
  isHexDigest,
  isWorkspaceSearchMigrationFailureCode,
  type MigrationTableIdentity,
  type WorkspaceSearchMaintenanceEvidenceReceipt,
  type WorkspaceSearchMigrationFailureCode,
  type WorkspaceSearchMigrationLease,
  WorkspaceSearchMigrationFailure,
  WORKSPACE_SEARCH_MIGRATION_ID,
} from './migration-contract'
import {
  MAINTENANCE_EVIDENCE_MAX_BYTES,
} from './maintenance-evidence'
import {
  assertWorkspaceSearchMigrationLeaseAuthority,
  createWorkspaceSearchMaintenanceEvidenceReceipt,
  type AcquireWorkspaceSearchMigrationLeaseInput,
  type HeartbeatWorkspaceSearchMigrationLeaseInput,
  type WorkspaceSearchMigrationLeaseClaim,
  validateWorkspaceSearchMaintenanceEvidenceReceipt,
  validateWorkspaceSearchMigrationLease,
  WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS,
  WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
} from './migration-state-machine'

const prePlanAuthorityRecordVersion = 1
const prePlanAuthorityRecordKeyPrefix = 'pre-plan-authority/v1'
const prePlanLeaseKind = 'workspace-search-pre-plan-global-lease'
const prePlanPointerKind =
  'workspace-search-pre-plan-maintenance-pointer'
const prePlanReceiptKind =
  'workspace-search-pre-plan-maintenance-receipt'

/**
 * Narrow migration-state transport used by pre-plan authority persistence.
 */
export interface WorkspaceSearchMigrationPrePlanAuthorityAwsTransport {
  /**
   * Strongly reads one exact authority record.
   *
   * @param command - Adapter-owned GetItem command.
   * @returns Raw low-level DynamoDB response.
   */
  getPrePlanAuthority(
    command: GetItemCommand,
  ): Promise<GetItemCommandOutput>

  /**
   * Completes the state-incarnation guard immediately before commit time.
   */
  preparePrePlanAuthorityWrite(): Promise<void>

  /**
   * Atomically commits one lease or maintenance-authority transition.
   *
   * @param command - Adapter-owned TransactWriteItems command.
   * @returns Raw low-level DynamoDB response.
   */
  transactWritePrePlanAuthority(
    command: TransactWriteItemsCommand,
  ): Promise<TransactWriteItemsCommandOutput>
}

/**
 * Adapter-owned source of trusted commit time.
 */
export type WorkspaceSearchMigrationPrePlanAuthorityClock = () => Date

/**
 * Dependencies for one measured pre-plan authority adapter.
 */
export type CreateWorkspaceSearchMigrationPrePlanAuthorityAwsPortInput = {
  /** Exact measured migration-state table incarnation. */
  readonly stateTable: MigrationTableIdentity
  /** Exact measured configuration digest bound to the lease holder. */
  readonly configurationHash: string
  /** Narrow strongly consistent and transactional DynamoDB transport. */
  readonly transport: WorkspaceSearchMigrationPrePlanAuthorityAwsTransport
  /** Adapter-owned trusted clock. */
  readonly clock: WorkspaceSearchMigrationPrePlanAuthorityClock
}

/**
 * Exact active lease and current immutable maintenance receipt.
 */
export type WorkspaceSearchMigrationPrePlanAuthority = {
  /** Exact measured configuration digest authorized by the lease. */
  readonly configurationHash: string
  /** Immutable physical migration-state TableId. */
  readonly stateTableId: string
  /** Exact current durable global lease. */
  readonly lease: WorkspaceSearchMigrationLease
  /** Digest addressing the current immutable receipt row. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Positive optimistic revision of the current receipt pointer. */
  readonly maintenanceEvidencePointerRevision: number
  /** Exact current durable maintenance-evidence receipt. */
  readonly maintenanceEvidenceReceipt:
    WorkspaceSearchMaintenanceEvidenceReceipt
  /** Adapter-owned time at which lease and receipt freshness were evaluated. */
  readonly evaluatedAt: string
}

/**
 * Immutable historical maintenance receipt with its durable authority binding.
 */
export type WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding = {
  /** Exact measured configuration digest stored with the receipt. */
  readonly configurationHash: string
  /** Immutable physical migration-state TableId that owns the receipt row. */
  readonly stateTableId: string
  /** Lease owner that validated and persisted the receipt. */
  readonly ownerId: string
  /** Digest addressing the exact immutable receipt row. */
  readonly receiptDigest: string
  /** Exact historical maintenance-evidence receipt payload. */
  readonly receipt: WorkspaceSearchMaintenanceEvidenceReceipt
}

/**
 * Inputs required to bind one planning transaction to current authority rows.
 */
export type CreateWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecksInput = {
  /** Exact measured migration-state table incarnation. */
  readonly stateTable: MigrationTableIdentity
  /** Exact measured configuration digest bound to the authority rows. */
  readonly configurationHash: string
  /** Exact current durable pre-plan authority aggregate. */
  readonly authority: WorkspaceSearchMigrationPrePlanAuthority
  /** Adapter-owned trusted time captured immediately before the transaction. */
  readonly commitAt: Date
}

/**
 * Claim used to resolve one exact current pre-plan authority.
 */
export type WorkspaceSearchMigrationPrePlanAuthorityClaim = {
  /** Exact run, owner, and fence expected in the global lease. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
  /** Exact immutable receipt selected by the current pointer. */
  readonly maintenanceEvidenceReceiptDigest: string
  /** Exact optimistic revision of the current receipt pointer. */
  readonly maintenanceEvidencePointerRevision: number
}

/**
 * Exact predecessor pointer required by a same-fence receipt renewal.
 */
export type WorkspaceSearchMigrationPrePlanMaintenancePointerClaim = {
  /** Fence that selected the expected pointer. */
  readonly fenceToken: number
  /** Positive optimistic pointer revision. */
  readonly revision: number
  /** Digest of the exact immutable current receipt. */
  readonly receiptDigest: string
}

/**
 * Exact evidence bytes renewed under one active lease.
 */
export type RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput = {
  /** Exact current durable lease identity. */
  readonly lease: WorkspaceSearchMigrationLeaseClaim
  /**
   * Exact same-fence predecessor, or null for an absent/older-fence pointer
   * immediately after first acquisition or takeover.
   */
  readonly expectedPointer:
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null
  /** Exact untrusted maintenance-evidence file bytes. */
  readonly evidenceBytes: Uint8Array
}

/**
 * Durable global authority operations used before sealed planning.
 */
export interface WorkspaceSearchMigrationPrePlanAuthorityAwsPort {
  /**
   * Acquires an absent lease, takes over an expired lease, or recovers an
   * identical active acquisition retry.
   *
   * @param input - Operator-selected run and process-unique owner.
   * @returns Exact durable fenced lease owned by this acquisition identity.
   */
  acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease>

  /**
   * Extends one exact active global lease without refreshing maintenance data.
   *
   * @param input - Exact run, owner, and fence being heartbeated.
   * @returns Exact durable successor lease.
   */
  heartbeatLease(
    input: HeartbeatWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease>

  /**
   * Persists one immutable fresh receipt and advances its current pointer.
   *
   * @param input - Exact lease and untrusted evidence bytes.
   * @returns Exact current pre-plan authority.
   */
  renewMaintenanceEvidence(
    input: RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority>

  /**
   * Strongly resolves one exact current lease and receipt claim.
   *
   * @param claim - Exact lease identity and current receipt digest.
   * @returns Current authority evaluated at the adapter clock.
   */
  readAuthority(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority>

  /**
   * Strongly reads one immutable historical receipt.
   *
   * @param runId - Run that owns the receipt.
   * @param receiptDigest - Digest addressing the immutable receipt.
   * @returns Exact receipt or undefined when it does not exist.
   */
  readMaintenanceEvidenceReceipt(
    runId: string,
    receiptDigest: string,
  ): Promise<WorkspaceSearchMaintenanceEvidenceReceipt | undefined>

  /**
   * Strongly reads one immutable historical receipt and its durable envelope.
   *
   * Unlike a current-authority read, this operation deliberately does not
   * require the historical receipt to remain fresh.
   *
   * @param runId - Run that owns the receipt.
   * @param receiptDigest - Digest addressing the immutable receipt.
   * @returns Exact historical binding or undefined when it does not exist.
   */
  readHistoricalMaintenanceEvidenceBinding(
    runId: string,
    receiptDigest: string,
  ): Promise<
    WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding | undefined
  >
}

/**
 * Immutable adapter binding copied at construction.
 */
type PrePlanAuthorityBinding = {
  /** Exact physical migration-state table name. */
  readonly stateTableName: string
  /** Stable digest of the migration-state physical incarnation. */
  readonly stateIncarnationDigest: string
  /** Immutable migration-state TableId. */
  readonly stateTableId: string
  /** Exact measured configuration digest. */
  readonly configurationHash: string
}

/**
 * Complete durable global lease envelope.
 */
type DurablePrePlanLease = PrePlanAuthorityBinding & {
  /** Exact durable lease payload. */
  readonly lease: WorkspaceSearchMigrationLease
  /** Digest covering the complete lease envelope. */
  readonly recordDigest: string
}

/**
 * Complete current maintenance-receipt pointer.
 */
type DurablePrePlanMaintenancePointer = PrePlanAuthorityBinding & {
  /** Run whose receipt is current. */
  readonly runId: string
  /** Lease owner that selected the receipt. */
  readonly ownerId: string
  /** Fence token that selected the receipt. */
  readonly fenceToken: number
  /** Positive optimistic pointer revision. */
  readonly revision: number
  /** Digest of the exact immutable current receipt. */
  readonly receiptDigest: string
  /** Exclusive receipt validity deadline in epoch milliseconds. */
  readonly receiptValidUntilEpochMilliseconds: number
  /** Digest covering the complete pointer envelope. */
  readonly recordDigest: string
}

/**
 * Complete immutable maintenance-receipt envelope.
 */
type DurablePrePlanMaintenanceReceipt = PrePlanAuthorityBinding & {
  /** Lease owner that validated this receipt. */
  readonly ownerId: string
  /** Digest of the exact receipt payload. */
  readonly receiptDigest: string
  /** Exact canonical receipt payload. */
  readonly receipt: WorkspaceSearchMaintenanceEvidenceReceipt
  /** Digest covering the receipt and immutable binding metadata. */
  readonly recordDigest: string
}

/**
 * Adapter-owned canonical clock snapshot.
 */
type PrePlanAuthorityClockSnapshot = {
  /** Canonical UTC time. */
  readonly at: string
  /** Exact finite epoch milliseconds. */
  readonly epochMilliseconds: number
}

/**
 * Failure codes deliberately emitted by the private authority adapter.
 */
type PrePlanAuthorityAwsFailureCode =
  | 'AMBIGUOUS_OPERATION_UNRESOLVED'
  | 'CONFIGURATION_DRIFT'
  | 'INVALID_ARGUMENT'
  | 'INVALID_MAINTENANCE_EVIDENCE'
  | 'INVALID_STATE'
  | 'LEASE_CONFLICT'
  | 'LEASE_LOST'
  | 'TRANSIENT_INFRASTRUCTURE_FAILURE'

/**
 * Secret-free structural AWS error supplied only to Smithy's classifiers.
 */
type PrePlanAuthorityAwsErrorClassificationInput =
  Parameters<typeof isTransientError>[0] & {
    /** Optional Node.js network or timeout error code. */
    readonly code?: string
  }

/**
 * Privately branded fixed-code authority failure.
 */
class PrePlanAuthorityAwsFailure extends Error {
  /** Stable operator-safe code selected inside the adapter. */
  readonly code: PrePlanAuthorityAwsFailureCode

  /**
   * Creates one private pre-plan authority failure.
   *
   * @param code - Stable operator-safe failure code.
   */
  constructor(code: PrePlanAuthorityAwsFailureCode) {
    super(code)
    this.name = 'PrePlanAuthorityAwsFailure'
    this.code = code
  }
}

/**
 * DynamoDB adapter for one global fenced lease and immutable receipts.
 */
class AwsWorkspaceSearchMigrationPrePlanAuthorityPort
  implements WorkspaceSearchMigrationPrePlanAuthorityAwsPort {
  /** Immutable measured state/configuration binding. */
  private readonly binding: PrePlanAuthorityBinding

  /** Narrow migration-state transport. */
  private readonly transport:
    WorkspaceSearchMigrationPrePlanAuthorityAwsTransport

  /** Adapter-owned trusted clock. */
  private readonly clock: WorkspaceSearchMigrationPrePlanAuthorityClock

  /**
   * Creates one adapter from already validated construction input.
   *
   * @param binding - Exact measured state/configuration binding.
   * @param transport - Narrow migration-state transport.
   * @param clock - Adapter-owned trusted clock.
   */
  constructor(
    binding: PrePlanAuthorityBinding,
    transport: WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
    clock: WorkspaceSearchMigrationPrePlanAuthorityClock,
  ) {
    this.binding = binding
    this.transport = transport
    this.clock = clock
  }

  /**
   * Acquires, takes over, or idempotently recovers one global lease.
   *
   * @param input - Operator-selected run and owner.
   * @returns Exact durable lease owned by this acquisition identity.
   */
  async acquireLease(
    input: AcquireWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    return runPrePlanAuthorityAwsBoundary(async () => {
      const runId = readMigrationIdentifier(input.runId)
      const ownerId = readMigrationIdentifier(input.ownerId)
      const predecessor = await this.readLease()
      const observedClock = readClock(this.clock)
      if (
        predecessor !== undefined &&
        observedClock.epochMilliseconds <
          Date.parse(predecessor.lease.expiresAt)
      ) {
        if (
          isMatchingActiveAcquisitionRetry(
            this.binding,
            predecessor,
            runId,
            ownerId,
            observedClock,
          )
        ) {
          return cloneLease(predecessor.lease)
        }
        return failPrePlanAuthorityAws('LEASE_CONFLICT')
      }
      await this.transport.preparePrePlanAuthorityWrite()
      const clock = readClock(this.clock)
      if (
        predecessor !== undefined &&
        clock.epochMilliseconds <
          Date.parse(predecessor.lease.expiresAt)
      ) {
        return failPrePlanAuthorityAws('LEASE_CONFLICT')
      }
      const predecessorFence = predecessor?.lease.fenceToken ?? 0
      if (predecessorFence >= Number.MAX_SAFE_INTEGER) {
        return failPrePlanAuthorityAws('INVALID_STATE')
      }
      const successor = createDurableLease(
        this.binding,
        {
          runId,
          ownerId,
          fenceToken: predecessorFence + 1,
          heartbeatAt: clock.at,
          expiresAt: new Date(
            clock.epochMilliseconds +
              WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS,
          ).toISOString(),
        },
      )
      const command = createLeaseCommitCommand({
        operation: 'acquire',
        binding: this.binding,
        predecessor,
        successor,
        clock,
      })
      try {
        await this.transport.transactWritePrePlanAuthority(command)
      } catch (error: unknown) {
        return this.reconcileLeaseCommit(
          'acquire',
          predecessor,
          successor,
          error,
        )
      }
      return cloneLease(successor.lease)
    })
  }

  /**
   * Extends one exact active global lease.
   *
   * @param input - Exact lease claim.
   * @returns Exact durable successor lease.
   */
  async heartbeatLease(
    input: HeartbeatWorkspaceSearchMigrationLeaseInput,
  ): Promise<WorkspaceSearchMigrationLease> {
    return runPrePlanAuthorityAwsBoundary(async () => {
      const claim = readLeaseClaim(input.lease)
      const predecessor = await this.requireClaimedLease(claim)
      await this.transport.preparePrePlanAuthorityWrite()
      const clock = readClock(this.clock)
      requireHeartbeatLease(predecessor, claim, clock)
      const successor = createDurableLease(
        this.binding,
        {
          ...predecessor.lease,
          heartbeatAt: clock.at,
          expiresAt: new Date(
            clock.epochMilliseconds +
              WORKSPACE_SEARCH_MIGRATION_LEASE_DURATION_MILLISECONDS,
          ).toISOString(),
        },
      )
      const command = createLeaseCommitCommand({
        operation: 'heartbeat',
        binding: this.binding,
        predecessor,
        successor,
        clock,
      })
      try {
        await this.transport.transactWritePrePlanAuthority(command)
      } catch (error: unknown) {
        return this.reconcileLeaseCommit(
          'heartbeat',
          predecessor,
          successor,
          error,
        )
      }
      return cloneLease(successor.lease)
    })
  }

  /**
   * Persists one immutable receipt and atomically advances its pointer.
   *
   * @param input - Exact lease claim and maintenance evidence bytes.
   * @returns Exact current pre-plan authority.
   */
  async renewMaintenanceEvidence(
    input: RenewWorkspaceSearchMigrationPrePlanMaintenanceEvidenceInput,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    return runPrePlanAuthorityAwsBoundary(async () => {
      const claim = readLeaseClaim(input.lease)
      const expectedPointer = readExpectedPointerClaim(
        input.expectedPointer,
      )
      const evidenceBytes = cloneEvidenceBytes(input.evidenceBytes)
      const lease = await this.requireClaimedLease(claim)
      const pointer = await this.readPointer(claim.runId)
      const validationClock = readClock(this.clock)
      requireActiveLease(lease, claim, validationClock.at)
      const receipt = createReceiptSafely({
        runId: claim.runId,
        lease: lease.lease,
        evidenceBytes,
        validatedAt: validationClock.at,
      })
      const durableReceipt = createDurableReceipt(
        this.binding,
        claim.ownerId,
        receipt,
      )
      if (
        !isExpectedRenewalPointer(pointer, claim, expectedPointer)
      ) {
        const recovered = await this.recoverMatchingReceiptRetry(
          claim,
          pointer,
          expectedPointer,
          durableReceipt,
        )
        if (recovered !== undefined) return recovered
        requireExpectedRenewalPointer(
          pointer,
          claim,
          expectedPointer,
        )
      }
      if (
        pointer?.ownerId === claim.ownerId &&
        pointer.fenceToken === claim.fenceToken &&
        pointer.receiptDigest === durableReceipt.receiptDigest
      ) {
        return this.readAuthority({
          lease: claim,
          maintenanceEvidenceReceiptDigest:
            durableReceipt.receiptDigest,
          maintenanceEvidencePointerRevision: pointer.revision,
        })
      }
      await this.transport.preparePrePlanAuthorityWrite()
      const commitClock = readClock(this.clock)
      requireActiveLease(lease, claim, commitClock.at)
      validateWorkspaceSearchMaintenanceEvidenceReceipt(
        durableReceipt.receipt,
        claim.runId,
        claim.fenceToken,
        commitClock.at,
      )
      const successorPointer = createDurablePointer(
        this.binding,
        pointer,
        claim,
        durableReceipt,
      )
      const command = createReceiptCommitCommand({
        binding: this.binding,
        lease,
        predecessorPointer: pointer,
        successorPointer,
        receipt: durableReceipt,
        clock: commitClock,
      })
      try {
        await this.transport.transactWritePrePlanAuthority(command)
      } catch (error: unknown) {
        return this.reconcileReceiptCommit(
          claim,
          pointer,
          successorPointer,
          durableReceipt,
          error,
        )
      }
      return this.readAuthority({
        lease: claim,
        maintenanceEvidenceReceiptDigest:
          durableReceipt.receiptDigest,
        maintenanceEvidencePointerRevision:
          successorPointer.revision,
      })
    })
  }

  /**
   * Recovers an exact renewal retry whose first response and reconciliation
   * read were both lost.
   *
   * Receipt validation time is adapter-owned and therefore changes across
   * retries. Recovery compares every evidence-derived field while requiring
   * the current pointer to be the direct successor of a supplied predecessor.
   * A null predecessor may recover only a same-fence no-op selecting the same
   * exact evidence, so it cannot overwrite or adopt different evidence.
   *
   * @param claim - Exact active lease claim.
   * @param pointer - Current durable pointer observed by the retry.
   * @param expectedPointer - Original predecessor supplied by the caller.
   * @param intendedReceipt - Newly validated receipt for the same input bytes.
   * @returns Current authority when an exact durable retry is proven.
   */
  private async recoverMatchingReceiptRetry(
    claim: WorkspaceSearchMigrationLeaseClaim,
    pointer: DurablePrePlanMaintenancePointer | undefined,
    expectedPointer:
      WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null,
    intendedReceipt: DurablePrePlanMaintenanceReceipt,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority | undefined> {
    if (
      !isRecoverableReceiptRetryPointer(
        pointer,
        claim,
        expectedPointer,
      )
    ) {
      return undefined
    }
    const authority = await this.readAuthority({
      lease: claim,
      maintenanceEvidenceReceiptDigest: pointer.receiptDigest,
      maintenanceEvidencePointerRevision: pointer.revision,
    })
    if (
      !sameMaintenanceEvidence(
        authority.maintenanceEvidenceReceipt,
        intendedReceipt.receipt,
      )
    ) {
      return undefined
    }
    return authority
  }

  /**
   * Strongly resolves one current lease/pointer/receipt tuple.
   *
   * @param claim - Exact current authority claim.
   * @returns Exact authority evaluated after all reads.
   */
  async readAuthority(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    return runPrePlanAuthorityAwsBoundary(async () => {
      const snapshot = readAuthorityClaim(claim)
      const firstLease = await this.requireClaimedLease(snapshot.lease)
      const pointer = await this.requireCurrentPointer(snapshot)
      const receipt = await this.requireCurrentReceipt(snapshot, pointer)
      const finalLease = await this.requireClaimedLease(snapshot.lease)
      const finalPointer = await this.requireCurrentPointer(snapshot)
      if (
        finalPointer.recordDigest !== pointer.recordDigest
      ) {
        return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
      }
      const clock = readClock(this.clock)
      const authority = createCurrentAuthority(
        this.binding,
        finalLease,
        finalPointer,
        receipt,
        clock.at,
      )
      if (!sameLeaseClaim(firstLease.lease, finalLease.lease)) {
        return failPrePlanAuthorityAws('LEASE_LOST')
      }
      return cloneAuthority(authority)
    })
  }

  /**
   * Strongly reads one immutable historical receipt.
   *
   * @param runId - Run that owns the receipt.
   * @param receiptDigest - Exact immutable receipt digest.
   * @returns Exact receipt or undefined when absent.
   */
  async readMaintenanceEvidenceReceipt(
    runId: string,
    receiptDigest: string,
  ): Promise<WorkspaceSearchMaintenanceEvidenceReceipt | undefined> {
    const binding = await this.readHistoricalMaintenanceEvidenceBinding(
      runId,
      receiptDigest,
    )
    return binding === undefined
      ? undefined
      : cloneReceipt(binding.receipt)
  }

  /**
   * Strongly reads one immutable historical receipt and its durable envelope.
   *
   * Historical freshness is intentionally not evaluated: the immutable row is
   * evidence that a planning page was authorized at its original commit time.
   *
   * @param runId - Run that owns the receipt.
   * @param receiptDigest - Exact immutable receipt digest.
   * @returns Exact historical binding or undefined when absent.
   */
  async readHistoricalMaintenanceEvidenceBinding(
    runId: string,
    receiptDigest: string,
  ): Promise<
    WorkspaceSearchMigrationHistoricalMaintenanceEvidenceBinding | undefined
  > {
    return runPrePlanAuthorityAwsBoundary(async () => {
      const validatedRunId = readMigrationIdentifier(runId)
      const validatedDigest = readDigest(receiptDigest)
      const durable = await this.readReceipt(
        validatedRunId,
        validatedDigest,
      )
      if (durable === undefined) return undefined
      requireBinding(this.binding, durable)
      if (durable.receipt.runId !== validatedRunId) {
        return failPrePlanAuthorityAws('INVALID_STATE')
      }
      return {
        configurationHash: durable.configurationHash,
        stateTableId: durable.stateTableId,
        ownerId: durable.ownerId,
        receiptDigest: durable.receiptDigest,
        receipt: cloneReceipt(durable.receipt),
      }
    })
  }

  /**
   * Reads the exact global lease with strong consistency.
   *
   * @returns Strict durable lease or undefined when absent.
   */
  private async readLease(): Promise<DurablePrePlanLease | undefined> {
    const output = await this.transport.getPrePlanAuthority(
      createStrongGetCommand(
        this.binding.stateTableName,
        createLeaseRecordKey(this.binding),
      ),
    )
    if (output.Item === undefined) return undefined
    return parseLeaseItem(output.Item, this.binding)
  }

  /**
   * Reads one run/configuration pointer with strong consistency.
   *
   * @param runId - Run whose current receipt pointer is requested.
   * @returns Strict durable pointer or undefined when absent.
   */
  private async readPointer(
    runId: string,
  ): Promise<DurablePrePlanMaintenancePointer | undefined> {
    const output = await this.transport.getPrePlanAuthority(
      createStrongGetCommand(
        this.binding.stateTableName,
        createPointerRecordKey(this.binding, runId),
      ),
    )
    if (output.Item === undefined) return undefined
    return parsePointerItem(output.Item, this.binding, runId)
  }

  /**
   * Reads one immutable receipt with strong consistency.
   *
   * @param runId - Run that owns the receipt.
   * @param receiptDigest - Exact receipt digest.
   * @returns Strict durable receipt or undefined when absent.
   */
  private async readReceipt(
    runId: string,
    receiptDigest: string,
  ): Promise<DurablePrePlanMaintenanceReceipt | undefined> {
    const output = await this.transport.getPrePlanAuthority(
      createStrongGetCommand(
        this.binding.stateTableName,
        createReceiptRecordKey(this.binding, runId, receiptDigest),
      ),
    )
    if (output.Item === undefined) return undefined
    return parseReceiptItem(
      output.Item,
      this.binding,
      runId,
      receiptDigest,
    )
  }

  /**
   * Strongly resolves and validates one exact lease claim.
   *
   * @param claim - Expected run, owner, and fence.
   * @returns Strict current durable lease.
   */
  private async requireClaimedLease(
    claim: WorkspaceSearchMigrationLeaseClaim,
  ): Promise<DurablePrePlanLease> {
    const lease = await this.readLease()
    if (lease === undefined) return failPrePlanAuthorityAws('LEASE_LOST')
    requireBinding(this.binding, lease)
    if (!sameLeaseClaim(lease.lease, claim)) {
      return failPrePlanAuthorityAws('LEASE_LOST')
    }
    return lease
  }

  /**
   * Strongly resolves the exact claimed current pointer.
   *
   * @param claim - Exact lease and receipt digest.
   * @returns Strict current durable pointer.
   */
  private async requireCurrentPointer(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
  ): Promise<DurablePrePlanMaintenancePointer> {
    const pointer = await this.readPointer(claim.lease.runId)
    if (pointer === undefined) {
      return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
    }
    requireBinding(this.binding, pointer)
    if (
      pointer.runId !== claim.lease.runId ||
      pointer.ownerId !== claim.lease.ownerId ||
      pointer.fenceToken !== claim.lease.fenceToken ||
      pointer.receiptDigest !== claim.maintenanceEvidenceReceiptDigest ||
      pointer.revision !==
        claim.maintenanceEvidencePointerRevision
    ) {
      return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
    }
    return pointer
  }

  /**
   * Strongly resolves the immutable receipt selected by a current pointer.
   *
   * @param claim - Exact lease and receipt digest.
   * @param pointer - Strict current pointer.
   * @returns Strict immutable durable receipt.
   */
  private async requireCurrentReceipt(
    claim: WorkspaceSearchMigrationPrePlanAuthorityClaim,
    pointer: DurablePrePlanMaintenancePointer,
  ): Promise<DurablePrePlanMaintenanceReceipt> {
    const receipt = await this.readReceipt(
      claim.lease.runId,
      pointer.receiptDigest,
    )
    if (receipt === undefined) {
      return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
    }
    requireBinding(this.binding, receipt)
    if (
      receipt.ownerId !== claim.lease.ownerId ||
      receipt.receipt.fenceToken !== claim.lease.fenceToken ||
      receipt.receiptDigest !== pointer.receiptDigest
    ) {
      return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
    }
    return receipt
  }

  /**
   * Reconciles one failed acquire or heartbeat transaction.
   *
   * @param operation - Lease operation being reconciled.
   * @param predecessor - Exact pre-transaction lease.
   * @param successor - Exact intended successor lease.
   * @param transactionError - Raw transaction error retained for classification.
   * @returns Intended or later same-fence durable lease when proven.
   */
  private async reconcileLeaseCommit(
    operation: 'acquire' | 'heartbeat',
    predecessor: DurablePrePlanLease | undefined,
    successor: DurablePrePlanLease,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationLease> {
    let durable: DurablePrePlanLease | undefined
    try {
      durable = await this.readLease()
    } catch (reconciliationError: unknown) {
      return failPrePlanAuthorityAws(
        reconciliationError instanceof ResourceNotFoundException
          ? 'CONFIGURATION_DRIFT'
          : 'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }
    if (
      durable !== undefined &&
      durable.configurationHash === successor.configurationHash &&
      durable.stateTableId === successor.stateTableId &&
      sameLeaseClaim(durable.lease, successor.lease) &&
      Date.parse(durable.lease.heartbeatAt) >=
        Date.parse(successor.lease.heartbeatAt)
    ) {
      return cloneLease(durable.lease)
    }
    if (
      (durable === undefined && predecessor === undefined) ||
      (
        durable !== undefined &&
        predecessor !== undefined &&
        durable.recordDigest === predecessor.recordDigest
      )
    ) {
      return failPrePlanAuthorityAws(
        classifyLeaseTransactionError(transactionError, operation),
      )
    }
    return failPrePlanAuthorityAws(
      operation === 'acquire' ? 'LEASE_CONFLICT' : 'LEASE_LOST',
    )
  }

  /**
   * Reconciles one failed immutable-receipt and pointer transaction.
   *
   * @param claim - Exact lease claim used by the transaction.
   * @param predecessorPointer - Exact pre-transaction pointer.
   * @param successorPointer - Exact intended pointer.
   * @param intendedReceipt - Exact intended immutable receipt.
   * @param transactionError - Raw transaction error retained for classification.
   * @returns Intended authority only when both durable records prove success.
   */
  private async reconcileReceiptCommit(
    claim: WorkspaceSearchMigrationLeaseClaim,
    predecessorPointer:
      DurablePrePlanMaintenancePointer | undefined,
    successorPointer: DurablePrePlanMaintenancePointer,
    intendedReceipt: DurablePrePlanMaintenanceReceipt,
    transactionError: unknown,
  ): Promise<WorkspaceSearchMigrationPrePlanAuthority> {
    let firstPointer: DurablePrePlanMaintenancePointer | undefined
    let finalPointer: DurablePrePlanMaintenancePointer | undefined
    let durableReceipt: DurablePrePlanMaintenanceReceipt | undefined
    let durableLease: DurablePrePlanLease | undefined
    let reconciliationClock: PrePlanAuthorityClockSnapshot
    try {
      firstPointer = await this.readPointer(claim.runId)
      durableReceipt = await this.readReceipt(
        claim.runId,
        intendedReceipt.receiptDigest,
      )
      durableLease = await this.readLease()
      finalPointer = await this.readPointer(claim.runId)
      reconciliationClock = readClock(this.clock)
    } catch (reconciliationError: unknown) {
      return failPrePlanAuthorityAws(
        reconciliationError instanceof ResourceNotFoundException
          ? 'CONFIGURATION_DRIFT'
          : 'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }
    const leaseRemainsAuthoritative = leaseHasCommitAuthority(
      this.binding,
      durableLease,
      claim,
      reconciliationClock,
    )
    if (!samePointerRecord(firstPointer, finalPointer)) {
      return failPrePlanAuthorityAws(
        leaseRemainsAuthoritative
          ? 'INVALID_MAINTENANCE_EVIDENCE'
          : 'LEASE_LOST',
      )
    }
    if (
      finalPointer?.recordDigest === successorPointer.recordDigest &&
      durableReceipt?.recordDigest === intendedReceipt.recordDigest
    ) {
      return this.readAuthority({
        lease: claim,
        maintenanceEvidenceReceiptDigest:
          intendedReceipt.receiptDigest,
        maintenanceEvidencePointerRevision:
          successorPointer.revision,
      })
    }
    if (
      finalPointer?.recordDigest === successorPointer.recordDigest
    ) {
      return failPrePlanAuthorityAws(
        'AMBIGUOUS_OPERATION_UNRESOLVED',
      )
    }
    if (
      (
        finalPointer === undefined &&
        predecessorPointer === undefined
      ) ||
      (
        finalPointer !== undefined &&
        predecessorPointer !== undefined &&
        finalPointer.recordDigest === predecessorPointer.recordDigest
      )
    ) {
      if (durableReceipt !== undefined) {
        if (
          durableReceipt.recordDigest === intendedReceipt.recordDigest
        ) {
          return failPrePlanAuthorityAws(
            'INVALID_MAINTENANCE_EVIDENCE',
          )
        }
        return failPrePlanAuthorityAws(
          'AMBIGUOUS_OPERATION_UNRESOLVED',
        )
      }
      if (
        !leaseRemainsAuthoritative &&
        !(transactionError instanceof ResourceNotFoundException)
      ) {
        return failPrePlanAuthorityAws('LEASE_LOST')
      }
      return failPrePlanAuthorityAws(
        classifyReceiptTransactionError(transactionError),
      )
    }
    return failPrePlanAuthorityAws(
      leaseRemainsAuthoritative
        ? 'INVALID_MAINTENANCE_EVIDENCE'
        : 'LEASE_LOST',
    )
  }
}

/**
 * Creates one measured pre-plan authority adapter.
 *
 * @param input - Exact state incarnation, configuration, transport, and clock.
 * @returns Durable global authority port.
 */
export function createAwsWorkspaceSearchMigrationPrePlanAuthorityPort(
  input: CreateWorkspaceSearchMigrationPrePlanAuthorityAwsPortInput,
): WorkspaceSearchMigrationPrePlanAuthorityAwsPort {
  try {
    const binding = createBinding(
      input.stateTable,
      input.configurationHash,
    )
    if (typeof input.clock !== 'function') {
      return failPrePlanAuthorityAws('INVALID_ARGUMENT')
    }
    requirePrePlanAuthorityTransport(input.transport)
    return new AwsWorkspaceSearchMigrationPrePlanAuthorityPort(
      binding,
      input.transport,
      input.clock,
    )
  } catch (error: unknown) {
    throw createPrePlanAuthorityBoundaryFailure(
      readPrePlanAuthorityAwsFailureCode(error),
    )
  }
}

/**
 * Fixed cancellation-reason positions prepended to every planning transaction.
 */
export const workspaceSearchMigrationPrePlanAuthorityCommitConditionIndex =
  Object.freeze({
    lease: 0,
    pointer: 1,
    receipt: 2,
    count: 3,
  })

/**
 * Creates the fixed lease, current-pointer, and immutable-receipt conditions
 * that a planning transaction must prepend to its own writes.
 *
 * @param input - Exact measured binding, current authority, and commit time.
 * @returns Three condition checks ordered as lease, pointer, then receipt.
 */
export function createWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecks(
  input:
    CreateWorkspaceSearchMigrationPrePlanAuthorityCommitConditionChecksInput,
): readonly [TransactWriteItem, TransactWriteItem, TransactWriteItem] {
  try {
    const inputRecord = requireInputRecord(input)
    requireExactInputKeys(inputRecord, [
      'authority',
      'commitAt',
      'configurationHash',
      'stateTable',
    ])
    const binding = createBinding(
      Reflect.get(inputRecord, 'stateTable'),
      Reflect.get(inputRecord, 'configurationHash'),
    )
    const authority = readAuthorityAggregateForCommit(
      Reflect.get(inputRecord, 'authority'),
      binding,
    )
    const commitClock = readCommitClock(
      Reflect.get(inputRecord, 'commitAt'),
    )
    requireAuthorityAtCommit(authority, commitClock)

    const durableLease = createDurableLease(
      binding,
      authority.lease,
    )
    const durableReceipt = createDurableReceipt(
      binding,
      authority.lease.ownerId,
      authority.maintenanceEvidenceReceipt,
    )
    const durablePointer = createDurableCurrentPointer(
      binding,
      authority,
      durableReceipt,
    )
    const leaseCondition = createReceiptLeaseCondition(
      durableLease,
      commitClock,
    )
    const pointerCondition =
      createCurrentPointerAuthorityCondition(
        durablePointer,
        commitClock,
      )
    const receiptCondition =
      createCurrentReceiptAuthorityCondition(
        binding,
        durableReceipt,
        commitClock,
      )
    const leaseConditionCheck =
      createPrePlanAuthorityConditionCheck(
        binding,
        createLeaseRecordKey(binding),
        leaseCondition,
      )
    const pointerConditionCheck =
      createPrePlanAuthorityConditionCheck(
        binding,
        createPointerRecordKey(
          binding,
          authority.lease.runId,
        ),
        pointerCondition,
      )
    const receiptConditionCheck =
      createPrePlanAuthorityConditionCheck(
        binding,
        createReceiptRecordKey(
          binding,
          authority.lease.runId,
          durableReceipt.receiptDigest,
        ),
        receiptCondition,
      )

    return [
      leaseConditionCheck,
      pointerConditionCheck,
      receiptConditionCheck,
    ]
  } catch (error: unknown) {
    throw createPrePlanAuthorityBoundaryFailure(
      readPrePlanAuthorityAwsFailureCode(error),
    )
  }
}

/**
 * Material needed to commit one global lease transition.
 */
type CreatePrePlanLeaseCommitCommandInput = {
  /** Lease operation whose conflict semantics are encoded. */
  readonly operation: 'acquire' | 'heartbeat'
  /** Current measured state/configuration binding. */
  readonly binding: PrePlanAuthorityBinding
  /** Exact predecessor, or absence for the first acquisition. */
  readonly predecessor: DurablePrePlanLease | undefined
  /** Exact intended durable successor. */
  readonly successor: DurablePrePlanLease
  /** Adapter-owned transaction clock. */
  readonly clock: PrePlanAuthorityClockSnapshot
}

/**
 * Material needed to commit one receipt and pointer transition.
 */
type CreatePrePlanReceiptCommitCommandInput = {
  /** Current measured state/configuration binding. */
  readonly binding: PrePlanAuthorityBinding
  /** Active lease observed before evidence validation. */
  readonly lease: DurablePrePlanLease
  /** Exact predecessor pointer, or absence on first renewal. */
  readonly predecessorPointer:
    DurablePrePlanMaintenancePointer | undefined
  /** Exact intended pointer successor. */
  readonly successorPointer: DurablePrePlanMaintenancePointer
  /** Exact immutable receipt selected by the successor pointer. */
  readonly receipt: DurablePrePlanMaintenanceReceipt
  /** Adapter-owned transaction clock. */
  readonly clock: PrePlanAuthorityClockSnapshot
}

/**
 * DynamoDB condition expression with exact aliases and operands.
 */
type PrePlanAuthorityCondition = {
  /** Exact condition expression. */
  readonly expression: string
  /** Attribute-name aliases used by the condition. */
  readonly names: Readonly<Record<string, string>>
  /** Optional exact condition operands. */
  readonly values?: Readonly<Record<string, AttributeValue>>
}

/**
 * Inputs used to validate exact maintenance-evidence bytes.
 */
type CreatePrePlanReceiptInput = {
  /** Run whose lease owns the evidence. */
  readonly runId: string
  /** Exact active durable lease. */
  readonly lease: WorkspaceSearchMigrationLease
  /** Detached exact evidence bytes. */
  readonly evidenceBytes: Uint8Array
  /** Adapter-owned canonical validation time. */
  readonly validatedAt: string
}

/**
 * Creates one detached, validated adapter binding.
 *
 * Only immutable table-incarnation fields enter the incarnation digest. Moving
 * PITR windows and other mutable observations therefore cannot split the one
 * global lease for the same physical table.
 *
 * @param stateTable - Exact measured migration-state table.
 * @param configurationHash - Exact measured configuration digest.
 * @returns Detached immutable adapter binding.
 */
function createBinding(
  stateTable: unknown,
  configurationHash: unknown,
): PrePlanAuthorityBinding {
  const stateTableRecord = requireInputRecord(stateTable)
  if (Reflect.get(stateTableRecord, 'role') !== 'migration-state') {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  const stateTableName = readStateTableName(
    Reflect.get(stateTableRecord, 'tableName'),
  )
  const tableArn = readBoundedText(
    Reflect.get(stateTableRecord, 'tableArn'),
    2_048,
  )
  const stateTableId = readBoundedText(
    Reflect.get(stateTableRecord, 'tableId'),
    1_024,
  )
  const creationTime = readCanonicalInputTime(
    Reflect.get(stateTableRecord, 'creationTime'),
  )
  const account = readBoundedText(
    Reflect.get(stateTableRecord, 'account'),
    64,
  )
  const region = readBoundedText(
    Reflect.get(stateTableRecord, 'region'),
    64,
  )
  const validatedConfigurationHash = readDigest(configurationHash)
  const stateIncarnationDigest = createMigrationDigest({
    kind: 'workspace-search-migration-state-incarnation',
    version: prePlanAuthorityRecordVersion,
    role: 'migration-state',
    tableName: stateTableName,
    tableArn,
    tableId: stateTableId,
    creationTime,
    account,
    region,
  })
  return {
    stateTableName,
    stateIncarnationDigest,
    stateTableId,
    configurationHash: validatedConfigurationHash,
  }
}

/**
 * Validates the narrow transport without invoking caller-controlled methods.
 *
 * @param transport - Candidate transport dependency.
 */
function requirePrePlanAuthorityTransport(
  transport: WorkspaceSearchMigrationPrePlanAuthorityAwsTransport,
): void {
  if (
    typeof transport !== 'object' ||
    transport === null ||
    typeof Reflect.get(transport, 'getPrePlanAuthority') !== 'function' ||
    typeof Reflect.get(
      transport,
      'preparePrePlanAuthorityWrite',
    ) !== 'function' ||
    typeof Reflect.get(
      transport,
      'transactWritePrePlanAuthority',
    ) !== 'function'
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
}

/**
 * Captures one trusted clock result as canonical text and milliseconds.
 *
 * @param clock - Adapter-owned clock dependency.
 * @returns Detached canonical clock snapshot.
 */
function readClock(
  clock: WorkspaceSearchMigrationPrePlanAuthorityClock,
): PrePlanAuthorityClockSnapshot {
  const value = clock()
  if (!(value instanceof Date)) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  const epochMilliseconds = value.getTime()
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return {
    at: new Date(epochMilliseconds).toISOString(),
    epochMilliseconds,
  }
}

/**
 * Captures one caller-supplied commit Date without invoking an override.
 *
 * @param value - Candidate adapter-owned transaction time.
 * @returns Detached canonical commit clock.
 */
function readCommitClock(
  value: unknown,
): PrePlanAuthorityClockSnapshot {
  if (!(value instanceof Date)) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  let epochMilliseconds: number
  try {
    epochMilliseconds = Date.prototype.getTime.call(value)
  } catch {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return {
    at: new Date(epochMilliseconds).toISOString(),
    epochMilliseconds,
  }
}

/**
 * Validates and detaches one complete current-authority aggregate.
 *
 * @param value - Candidate authority aggregate.
 * @param binding - Exact measured state/configuration binding.
 * @returns Detached internally consistent authority.
 */
function readAuthorityAggregateForCommit(
  value: unknown,
  binding: PrePlanAuthorityBinding,
): WorkspaceSearchMigrationPrePlanAuthority {
  const record = requireInputRecord(value)
  requireExactInputKeys(record, [
    'configurationHash',
    'evaluatedAt',
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceipt',
    'maintenanceEvidenceReceiptDigest',
    'stateTableId',
  ])
  const configurationHash = readDigest(
    Reflect.get(record, 'configurationHash'),
  )
  const stateTableId = readBoundedText(
    Reflect.get(record, 'stateTableId'),
    1_024,
  )
  if (
    configurationHash !== binding.configurationHash ||
    stateTableId !== binding.stateTableId
  ) {
    return failPrePlanAuthorityAws('CONFIGURATION_DRIFT')
  }
  const lease = readAuthorityLease(
    Reflect.get(record, 'lease'),
  )
  const maintenanceEvidenceReceipt =
    readAuthorityReceipt(
      Reflect.get(record, 'maintenanceEvidenceReceipt'),
    )
  const maintenanceEvidenceReceiptDigest = readDigest(
    Reflect.get(record, 'maintenanceEvidenceReceiptDigest'),
  )
  const maintenanceEvidencePointerRevision = Reflect.get(
    record,
    'maintenanceEvidencePointerRevision',
  )
  if (
    !Number.isSafeInteger(maintenanceEvidencePointerRevision) ||
    maintenanceEvidencePointerRevision <= 0
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  const evaluatedAt = readCanonicalInputTime(
    Reflect.get(record, 'evaluatedAt'),
  )
  if (
    maintenanceEvidenceReceipt.runId !== lease.runId ||
    maintenanceEvidenceReceipt.fenceToken !== lease.fenceToken ||
    maintenanceEvidenceReceiptDigest !==
      createMigrationDigest(maintenanceEvidenceReceipt)
  ) {
    return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
  }
  assertWorkspaceSearchMigrationLeaseAuthority(lease.runId, {
    lease,
    ownerId: lease.ownerId,
    at: evaluatedAt,
  })
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    maintenanceEvidenceReceipt,
    lease.runId,
    lease.fenceToken,
    evaluatedAt,
  )
  return {
    configurationHash,
    stateTableId,
    lease: cloneLease(lease),
    maintenanceEvidenceReceiptDigest,
    maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceipt:
      cloneReceipt(maintenanceEvidenceReceipt),
    evaluatedAt,
  }
}

/**
 * Validates and detaches one complete lease embedded in authority input.
 *
 * @param value - Candidate lease.
 * @returns Detached validated lease.
 */
function readAuthorityLease(
  value: unknown,
): WorkspaceSearchMigrationLease {
  const record = requireInputRecord(value)
  requireExactInputKeys(record, [
    'expiresAt',
    'fenceToken',
    'heartbeatAt',
    'ownerId',
    'runId',
  ])
  const fenceToken = Reflect.get(record, 'fenceToken')
  if (!Number.isSafeInteger(fenceToken) || fenceToken <= 0) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  const lease = {
    runId: readMigrationIdentifier(Reflect.get(record, 'runId')),
    ownerId: readMigrationIdentifier(Reflect.get(record, 'ownerId')),
    fenceToken,
    expiresAt: readCanonicalInputTime(
      Reflect.get(record, 'expiresAt'),
    ),
    heartbeatAt: readCanonicalInputTime(
      Reflect.get(record, 'heartbeatAt'),
    ),
  }
  validateWorkspaceSearchMigrationLease(lease)
  return lease
}

/**
 * Validates and detaches one complete receipt embedded in authority input.
 *
 * @param value - Candidate receipt.
 * @returns Detached validated receipt.
 */
function readAuthorityReceipt(
  value: unknown,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  const record = requireInputRecord(value)
  requireExactInputKeys(record, [
    'evidenceDigest',
    'evidenceLocator',
    'fenceToken',
    'oldestObservationAt',
    'runId',
    'runtimeRevision',
    'validatedAt',
    'validUntil',
  ])
  const runtimeRevision = Reflect.get(record, 'runtimeRevision')
  const fenceToken = Reflect.get(record, 'fenceToken')
  if (
    !Number.isSafeInteger(runtimeRevision) ||
    runtimeRevision <= 0 ||
    !Number.isSafeInteger(fenceToken) ||
    fenceToken <= 0
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  const receipt = {
    runId: readMigrationIdentifier(Reflect.get(record, 'runId')),
    evidenceDigest: readDigest(
      Reflect.get(record, 'evidenceDigest'),
    ),
    evidenceLocator: readBoundedText(
      Reflect.get(record, 'evidenceLocator'),
      2_048,
    ),
    runtimeRevision,
    fenceToken,
    validatedAt: readCanonicalInputTime(
      Reflect.get(record, 'validatedAt'),
    ),
    oldestObservationAt: readCanonicalInputTime(
      Reflect.get(record, 'oldestObservationAt'),
    ),
    validUntil: readCanonicalInputTime(
      Reflect.get(record, 'validUntil'),
    ),
  }
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    receipt,
    receipt.runId,
  )
  return receipt
}

/**
 * Requires receipt freshness and monotonic time at transaction construction.
 *
 * The snapshot lease was already authoritative at `evaluatedAt`. Its expiry is
 * not rechecked here because a concurrent same-fence heartbeat may have safely
 * extended the live row. The emitted lease ConditionCheck verifies that live
 * row's exact identity and commit headroom atomically with the caller's writes.
 *
 * @param authority - Strict detached current authority.
 * @param commitClock - Adapter-owned time immediately before the transaction.
 */
function requireAuthorityAtCommit(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  commitClock: PrePlanAuthorityClockSnapshot,
): void {
  if (
    commitClock.epochMilliseconds <
      Date.parse(authority.evaluatedAt)
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    authority.maintenanceEvidenceReceipt,
    authority.lease.runId,
    authority.lease.fenceToken,
    commitClock.at,
  )
}

/**
 * Validates and detaches one operator-selected migration identifier.
 *
 * @param value - Candidate identifier.
 * @returns Exact safe identifier.
 */
function readMigrationIdentifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Validates one caller-supplied lowercase SHA-256 digest.
 *
 * @param value - Candidate digest.
 * @returns Exact validated digest.
 */
function readDigest(value: unknown): string {
  if (!isHexDigest(value)) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Validates one physical migration-state table name.
 *
 * @param value - Candidate table name.
 * @returns Exact validated name.
 */
function readStateTableName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 3 ||
    value.length > 255 ||
    !/^[A-Za-z0-9_.-]+$/u.test(value)
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Validates one nonempty bounded construction-time text field.
 *
 * @param value - Candidate text.
 * @param maximumLength - Maximum accepted UTF-16 code-unit length.
 * @returns Exact validated text.
 */
function readBoundedText(
  value: unknown,
  maximumLength: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Validates one canonical construction-time timestamp.
 *
 * @param value - Candidate timestamp.
 * @returns Exact canonical timestamp.
 */
function readCanonicalInputTime(value: unknown): string {
  if (!isCanonicalTimestamp(value)) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  const epochMilliseconds = Date.parse(value)
  if (
    !Number.isSafeInteger(epochMilliseconds) ||
    epochMilliseconds < 0
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Validates and detaches one exact lease claim.
 *
 * @param value - Candidate claim.
 * @returns Detached exact claim.
 */
function readLeaseClaim(
  value: unknown,
): WorkspaceSearchMigrationLeaseClaim {
  const record = requireInputRecord(value)
  requireExactInputKeys(record, [
    'fenceToken',
    'ownerId',
    'runId',
  ])
  const fenceToken = Reflect.get(record, 'fenceToken')
  if (!Number.isSafeInteger(fenceToken) || fenceToken <= 0) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return {
    runId: readMigrationIdentifier(Reflect.get(record, 'runId')),
    ownerId: readMigrationIdentifier(Reflect.get(record, 'ownerId')),
    fenceToken,
  }
}

/**
 * Validates and detaches one current-authority claim.
 *
 * @param value - Candidate authority claim.
 * @returns Detached exact authority claim.
 */
function readAuthorityClaim(
  value: unknown,
): WorkspaceSearchMigrationPrePlanAuthorityClaim {
  const record = requireInputRecord(value)
  requireExactInputKeys(record, [
    'lease',
    'maintenanceEvidencePointerRevision',
    'maintenanceEvidenceReceiptDigest',
  ])
  const pointerRevision = Reflect.get(
    record,
    'maintenanceEvidencePointerRevision',
  )
  if (!Number.isSafeInteger(pointerRevision) || pointerRevision <= 0) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return {
    lease: readLeaseClaim(Reflect.get(record, 'lease')),
    maintenanceEvidenceReceiptDigest: readDigest(
      Reflect.get(record, 'maintenanceEvidenceReceiptDigest'),
    ),
    maintenanceEvidencePointerRevision: pointerRevision,
  }
}

/**
 * Validates and detaches one optional predecessor pointer claim.
 *
 * @param value - Candidate exact claim or explicit null.
 * @returns Detached predecessor claim or null.
 */
function readExpectedPointerClaim(
  value: unknown,
): WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null {
  if (value === null) return null
  const record = requireInputRecord(value)
  requireExactInputKeys(record, [
    'fenceToken',
    'receiptDigest',
    'revision',
  ])
  const fenceToken = Reflect.get(record, 'fenceToken')
  const revision = Reflect.get(record, 'revision')
  if (
    !Number.isSafeInteger(fenceToken) ||
    fenceToken <= 0 ||
    !Number.isSafeInteger(revision) ||
    revision <= 0
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return {
    fenceToken,
    revision,
    receiptDigest: readDigest(
      Reflect.get(record, 'receiptDigest'),
    ),
  }
}

/**
 * Requires one plain object-like input record.
 *
 * @param value - Candidate input.
 * @returns Object suitable for safe reflection.
 */
function requireInputRecord(value: unknown): object {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  return value
}

/**
 * Requires an input record to contain exactly the declared own keys.
 *
 * @param value - Candidate input record.
 * @param expected - Exact allowed key names.
 */
function requireExactInputKeys(
  value: object,
  expected: readonly string[],
): void {
  let keys: string[]
  try {
    keys = Object.keys(value).sort()
  } catch {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  const sortedExpected = [...expected].sort()
  if (
    keys.length !== sortedExpected.length ||
    keys.some((key, index) => key !== sortedExpected[index])
  ) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
}

/**
 * Detaches exact caller-owned evidence bytes before the first await.
 *
 * @param value - Candidate byte sequence.
 * @returns Detached exact bytes.
 */
function cloneEvidenceBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    return failPrePlanAuthorityAws('INVALID_ARGUMENT')
  }
  if (
    value.byteLength === 0 ||
    value.byteLength > MAINTENANCE_EVIDENCE_MAX_BYTES
  ) {
    return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
  }
  return new Uint8Array(value)
}

/**
 * Creates and validates one complete durable lease envelope.
 *
 * @param binding - Current adapter binding.
 * @param lease - Exact intended lease.
 * @returns Complete durable lease.
 */
function createDurableLease(
  binding: PrePlanAuthorityBinding,
  lease: WorkspaceSearchMigrationLease,
): DurablePrePlanLease {
  validateWorkspaceSearchMigrationLease(lease)
  const detachedLease = cloneLease(lease)
  const recordDigest = createLeaseRecordDigest(
    binding.stateIncarnationDigest,
    binding.stateTableId,
    binding.configurationHash,
    detachedLease,
  )
  return {
    ...binding,
    lease: detachedLease,
    recordDigest,
  }
}

/**
 * Parses strict evidence bytes through the shared state-machine contract.
 *
 * @param input - Run, lease, exact bytes, and adapter time.
 * @returns Detached validated receipt.
 */
function createReceiptSafely(
  input: CreatePrePlanReceiptInput,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  const receipt = createWorkspaceSearchMaintenanceEvidenceReceipt({
    runId: input.runId,
    lease: cloneLease(input.lease),
    evidenceBytes: new Uint8Array(input.evidenceBytes),
    validatedAt: input.validatedAt,
  })
  return cloneReceipt(receipt)
}

/**
 * Creates one immutable durable receipt envelope.
 *
 * @param binding - Current adapter binding.
 * @param ownerId - Lease owner that validated the evidence.
 * @param receipt - Exact validated receipt.
 * @returns Complete immutable durable receipt.
 */
function createDurableReceipt(
  binding: PrePlanAuthorityBinding,
  ownerId: string,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
): DurablePrePlanMaintenanceReceipt {
  const validatedOwnerId = readMigrationIdentifier(ownerId)
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    receipt,
    receipt.runId,
    receipt.fenceToken,
    receipt.validatedAt,
  )
  const detachedReceipt = cloneReceipt(receipt)
  const receiptDigest = createMigrationDigest(detachedReceipt)
  const recordDigest = createReceiptRecordDigest(
    binding,
    validatedOwnerId,
    receiptDigest,
    detachedReceipt,
  )
  return {
    ...binding,
    ownerId: validatedOwnerId,
    receiptDigest,
    receipt: detachedReceipt,
    recordDigest,
  }
}

/**
 * Creates one next current-receipt pointer.
 *
 * @param binding - Current adapter binding.
 * @param predecessor - Exact previous pointer, when present.
 * @param claim - Exact active lease claim.
 * @param receipt - Exact immutable receipt selected by the pointer.
 * @returns Complete durable successor pointer.
 */
function createDurablePointer(
  binding: PrePlanAuthorityBinding,
  predecessor: DurablePrePlanMaintenancePointer | undefined,
  claim: WorkspaceSearchMigrationLeaseClaim,
  receipt: DurablePrePlanMaintenanceReceipt,
): DurablePrePlanMaintenancePointer {
  if (predecessor !== undefined) requireBinding(binding, predecessor)
  requireBinding(binding, receipt)
  if (
    receipt.receipt.runId !== claim.runId ||
    receipt.ownerId !== claim.ownerId ||
    receipt.receipt.fenceToken !== claim.fenceToken
  ) {
    return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
  }
  if (
    predecessor !== undefined &&
    (
      predecessor.fenceToken > claim.fenceToken ||
      (
        predecessor.fenceToken === claim.fenceToken &&
        predecessor.ownerId !== claim.ownerId
      )
    )
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  const predecessorRevision = predecessor?.revision ?? 0
  if (predecessorRevision >= Number.MAX_SAFE_INTEGER) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  const revision = predecessorRevision + 1
  const receiptValidUntilEpochMilliseconds = Date.parse(
    receipt.receipt.validUntil,
  )
  const pointerWithoutDigest = {
    ...binding,
    runId: claim.runId,
    ownerId: claim.ownerId,
    fenceToken: claim.fenceToken,
    revision,
    receiptDigest: receipt.receiptDigest,
    receiptValidUntilEpochMilliseconds,
  }
  return {
    ...pointerWithoutDigest,
    recordDigest: createPointerRecordDigest(pointerWithoutDigest),
  }
}

/**
 * Reconstructs the exact current pointer selected by a resolved authority.
 *
 * @param binding - Current measured state/configuration binding.
 * @param authority - Strict detached current authority.
 * @param receipt - Exact immutable receipt selected by the pointer.
 * @returns Complete durable current pointer envelope.
 */
function createDurableCurrentPointer(
  binding: PrePlanAuthorityBinding,
  authority: WorkspaceSearchMigrationPrePlanAuthority,
  receipt: DurablePrePlanMaintenanceReceipt,
): DurablePrePlanMaintenancePointer {
  requireBinding(binding, receipt)
  if (
    receipt.ownerId !== authority.lease.ownerId ||
    receipt.receipt.runId !== authority.lease.runId ||
    receipt.receipt.fenceToken !== authority.lease.fenceToken ||
    receipt.receiptDigest !==
      authority.maintenanceEvidenceReceiptDigest
  ) {
    return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
  }
  const pointerWithoutDigest = {
    ...binding,
    runId: authority.lease.runId,
    ownerId: authority.lease.ownerId,
    fenceToken: authority.lease.fenceToken,
    revision: authority.maintenanceEvidencePointerRevision,
    receiptDigest: receipt.receiptDigest,
    receiptValidUntilEpochMilliseconds:
      Date.parse(receipt.receipt.validUntil),
  }
  return {
    ...pointerWithoutDigest,
    recordDigest: createPointerRecordDigest(pointerWithoutDigest),
  }
}

/**
 * Detects one active durable lease created by an identical acquisition.
 *
 * The configuration binding is required because the global lease key is shared
 * across configurations. Returning a lease from another measured configuration
 * would incorrectly transfer its authority even when run and owner text match.
 *
 * @param binding - Current measured adapter binding.
 * @param durable - Active durable lease read by the acquisition retry.
 * @param runId - Retry run identifier.
 * @param ownerId - Retry owner identifier.
 * @param clock - Adapter-owned retry observation time.
 * @returns Whether returning the durable lease is an exact idempotent success.
 */
function isMatchingActiveAcquisitionRetry(
  binding: PrePlanAuthorityBinding,
  durable: DurablePrePlanLease,
  runId: string,
  ownerId: string,
  clock: PrePlanAuthorityClockSnapshot,
): boolean {
  return durable.stateTableName === binding.stateTableName &&
    durable.stateIncarnationDigest === binding.stateIncarnationDigest &&
    durable.stateTableId === binding.stateTableId &&
    durable.configurationHash === binding.configurationHash &&
    durable.lease.runId === runId &&
    durable.lease.ownerId === ownerId &&
    Date.parse(durable.lease.heartbeatAt) <= clock.epochMilliseconds &&
    clock.epochMilliseconds < Date.parse(durable.lease.expiresAt)
}

/**
 * Tests whether one durable pointer exactly matches the caller's predecessor.
 *
 * @param current - Current durable pointer, when present.
 * @param lease - Exact active lease claim.
 * @param expected - Caller-observed predecessor or explicit null.
 * @returns Whether normal renewal may proceed from this pointer.
 */
function isExpectedRenewalPointer(
  current: DurablePrePlanMaintenancePointer | undefined,
  lease: WorkspaceSearchMigrationLeaseClaim,
  expected:
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null,
): boolean {
  if (expected === null) {
    return current === undefined ||
      current.fenceToken < lease.fenceToken
  }
  return expected.fenceToken === lease.fenceToken &&
    current !== undefined &&
    current.ownerId === lease.ownerId &&
    current.fenceToken === lease.fenceToken &&
    current.revision === expected.revision &&
    current.receiptDigest === expected.receiptDigest
}

/**
 * Detects a current pointer that can represent the caller's committed retry.
 *
 * An exact predecessor must advance by one revision. A null predecessor cannot
 * reconstruct the older-fence revision, so recovery additionally relies on the
 * same-fence owner and exact evidence comparison and remains a read-only no-op.
 *
 * @param current - Current durable pointer, when present.
 * @param lease - Exact active lease claim.
 * @param expected - Original predecessor or explicit null.
 * @returns Whether the pointer may be checked for exact retry recovery.
 */
function isRecoverableReceiptRetryPointer(
  current: DurablePrePlanMaintenancePointer | undefined,
  lease: WorkspaceSearchMigrationLeaseClaim,
  expected:
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null,
): current is DurablePrePlanMaintenancePointer {
  if (
    current === undefined ||
    current.ownerId !== lease.ownerId ||
    current.fenceToken !== lease.fenceToken
  ) {
    return false
  }
  if (expected === null) return true
  return expected.fenceToken === lease.fenceToken &&
    expected.revision < Number.MAX_SAFE_INTEGER &&
    current.revision === expected.revision + 1 &&
    current.receiptDigest !== expected.receiptDigest
}

/**
 * Requires the caller's pointer expectation before parsing new evidence.
 *
 * A null expectation is accepted only when no pointer exists or the current
 * pointer belongs to an older fence after takeover. Same-fence renewal always
 * supplies an exact revision/digest predecessor, preventing stale evidence
 * from overwriting a newer successful renewal.
 *
 * @param current - Current durable pointer, when present.
 * @param lease - Exact active lease claim.
 * @param expected - Caller-observed predecessor or explicit null.
 */
function requireExpectedRenewalPointer(
  current: DurablePrePlanMaintenancePointer | undefined,
  lease: WorkspaceSearchMigrationLeaseClaim,
  expected:
    WorkspaceSearchMigrationPrePlanMaintenancePointerClaim | null,
): void {
  if (!isExpectedRenewalPointer(current, lease, expected)) {
    return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
  }
}

/**
 * Compares every maintenance-evidence-derived receipt field.
 *
 * Adapter-owned validation time is deliberately excluded because an identical
 * retry necessarily revalidates the same bytes at a later time.
 *
 * @param left - Durable receipt selected by the current pointer.
 * @param right - Newly validated receipt created from retry bytes.
 * @returns Whether both receipts represent the same exact maintenance evidence.
 */
function sameMaintenanceEvidence(
  left: WorkspaceSearchMaintenanceEvidenceReceipt,
  right: WorkspaceSearchMaintenanceEvidenceReceipt,
): boolean {
  return left.runId === right.runId &&
    left.evidenceDigest === right.evidenceDigest &&
    left.evidenceLocator === right.evidenceLocator &&
    left.runtimeRevision === right.runtimeRevision &&
    left.fenceToken === right.fenceToken &&
    left.oldestObservationAt === right.oldestObservationAt &&
    left.validUntil === right.validUntil
}

/**
 * Constructs and validates one current authority aggregate.
 *
 * @param binding - Current adapter binding.
 * @param lease - Active durable global lease.
 * @param pointer - Exact current receipt pointer.
 * @param receipt - Exact immutable current receipt.
 * @param evaluatedAt - Adapter-owned evaluation time.
 * @returns Detached current authority.
 */
function createCurrentAuthority(
  binding: PrePlanAuthorityBinding,
  lease: DurablePrePlanLease,
  pointer: DurablePrePlanMaintenancePointer,
  receipt: DurablePrePlanMaintenanceReceipt,
  evaluatedAt: string,
): WorkspaceSearchMigrationPrePlanAuthority {
  requireBinding(binding, lease)
  requireBinding(binding, pointer)
  requireBinding(binding, receipt)
  assertWorkspaceSearchMigrationLeaseAuthority(
    lease.lease.runId,
    {
      lease: lease.lease,
      ownerId: lease.lease.ownerId,
      at: evaluatedAt,
    },
  )
  validateWorkspaceSearchMaintenanceEvidenceReceipt(
    receipt.receipt,
    lease.lease.runId,
    lease.lease.fenceToken,
    evaluatedAt,
  )
  if (
    pointer.runId !== lease.lease.runId ||
    pointer.ownerId !== lease.lease.ownerId ||
    pointer.fenceToken !== lease.lease.fenceToken ||
    receipt.ownerId !== lease.lease.ownerId ||
    pointer.receiptDigest !== receipt.receiptDigest ||
    pointer.receiptValidUntilEpochMilliseconds !==
      Date.parse(receipt.receipt.validUntil)
  ) {
    return failPrePlanAuthorityAws('INVALID_MAINTENANCE_EVIDENCE')
  }
  return {
    configurationHash: binding.configurationHash,
    stateTableId: binding.stateTableId,
    lease: cloneLease(lease.lease),
    maintenanceEvidenceReceiptDigest: receipt.receiptDigest,
    maintenanceEvidencePointerRevision: pointer.revision,
    maintenanceEvidenceReceipt: cloneReceipt(receipt.receipt),
    evaluatedAt,
  }
}

/**
 * Requires one claimed lease to retain the strict atomic commit window.
 *
 * @param durable - Exact durable lease envelope.
 * @param claim - Exact expected lease identity.
 * @param at - Adapter-owned canonical evaluation time.
 */
function requireActiveLease(
  durable: DurablePrePlanLease,
  claim: WorkspaceSearchMigrationLeaseClaim,
  at: string,
): void {
  if (!sameLeaseClaim(durable.lease, claim)) {
    return failPrePlanAuthorityAws('LEASE_LOST')
  }
  assertWorkspaceSearchMigrationLeaseAuthority(claim.runId, {
    lease: durable.lease,
    ownerId: claim.ownerId,
    at,
  })
}

/**
 * Requires one exact unexpired lease for a heartbeat transition.
 *
 * Heartbeats remain legal until the exclusive expiry instant because their
 * purpose is to restore the full lease duration. The ten-second commit window
 * applies to work authorized by a lease, not to the heartbeat itself.
 *
 * @param durable - Exact durable lease envelope.
 * @param claim - Exact expected lease identity.
 * @param clock - Adapter-owned heartbeat time.
 */
function requireHeartbeatLease(
  durable: DurablePrePlanLease,
  claim: WorkspaceSearchMigrationLeaseClaim,
  clock: PrePlanAuthorityClockSnapshot,
): void {
  if (
    !sameLeaseClaim(durable.lease, claim) ||
    Date.parse(durable.lease.heartbeatAt) >
      clock.epochMilliseconds ||
    clock.epochMilliseconds >= Date.parse(durable.lease.expiresAt)
  ) {
    return failPrePlanAuthorityAws('LEASE_LOST')
  }
}

/**
 * Compares two leases or claims by their exact fenced identity.
 *
 * @param left - First lease or claim.
 * @param right - Second lease or claim.
 * @returns Whether run, owner, and fence all match.
 */
function sameLeaseClaim(
  left: WorkspaceSearchMigrationLease | WorkspaceSearchMigrationLeaseClaim,
  right: WorkspaceSearchMigrationLease | WorkspaceSearchMigrationLeaseClaim,
): boolean {
  return left.runId === right.runId &&
    left.ownerId === right.ownerId &&
    left.fenceToken === right.fenceToken
}

/**
 * Compares two optional pointer reads by their strict record digest.
 *
 * @param left - First optional pointer.
 * @param right - Second optional pointer.
 * @returns Whether both reads represent the same physical pointer state.
 */
function samePointerRecord(
  left: DurablePrePlanMaintenancePointer | undefined,
  right: DurablePrePlanMaintenancePointer | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === undefined && right === undefined
  }
  return left.recordDigest === right.recordDigest
}

/**
 * Tests whether a reread lease still authorizes an atomic receipt commit.
 *
 * @param binding - Current adapter binding.
 * @param durable - Reread durable lease, when present.
 * @param claim - Exact attempted lease claim.
 * @param clock - Adapter-owned reconciliation time.
 * @returns Whether identity and strict commit headroom remain current.
 */
function leaseHasCommitAuthority(
  binding: PrePlanAuthorityBinding,
  durable: DurablePrePlanLease | undefined,
  claim: WorkspaceSearchMigrationLeaseClaim,
  clock: PrePlanAuthorityClockSnapshot,
): boolean {
  if (durable === undefined) return false
  return durable.stateTableName === binding.stateTableName &&
    durable.stateIncarnationDigest ===
      binding.stateIncarnationDigest &&
    durable.stateTableId === binding.stateTableId &&
    durable.configurationHash === binding.configurationHash &&
    sameLeaseClaim(durable.lease, claim) &&
    Date.parse(durable.lease.heartbeatAt) <=
      clock.epochMilliseconds &&
    clock.epochMilliseconds +
      WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS <
        Date.parse(durable.lease.expiresAt)
}

/**
 * Requires a durable envelope to match the current adapter binding.
 *
 * @param expected - Current adapter binding.
 * @param actual - Candidate durable binding.
 */
function requireBinding(
  expected: PrePlanAuthorityBinding,
  actual: PrePlanAuthorityBinding,
): void {
  if (
    actual.stateTableName !== expected.stateTableName ||
    actual.stateIncarnationDigest !== expected.stateIncarnationDigest ||
    actual.stateTableId !== expected.stateTableId ||
    actual.configurationHash !== expected.configurationHash
  ) {
    return failPrePlanAuthorityAws('CONFIGURATION_DRIFT')
  }
}

/**
 * Detaches one validated durable lease.
 *
 * @param lease - Exact lease.
 * @returns Detached lease.
 */
function cloneLease(
  lease: WorkspaceSearchMigrationLease,
): WorkspaceSearchMigrationLease {
  return {
    runId: lease.runId,
    ownerId: lease.ownerId,
    fenceToken: lease.fenceToken,
    expiresAt: lease.expiresAt,
    heartbeatAt: lease.heartbeatAt,
  }
}

/**
 * Detaches one validated maintenance receipt.
 *
 * @param receipt - Exact receipt.
 * @returns Detached receipt.
 */
function cloneReceipt(
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
): WorkspaceSearchMaintenanceEvidenceReceipt {
  return {
    runId: receipt.runId,
    evidenceDigest: receipt.evidenceDigest,
    evidenceLocator: receipt.evidenceLocator,
    runtimeRevision: receipt.runtimeRevision,
    fenceToken: receipt.fenceToken,
    validatedAt: receipt.validatedAt,
    oldestObservationAt: receipt.oldestObservationAt,
    validUntil: receipt.validUntil,
  }
}

/**
 * Detaches one current authority result.
 *
 * @param authority - Exact authority aggregate.
 * @returns Detached authority.
 */
function cloneAuthority(
  authority: WorkspaceSearchMigrationPrePlanAuthority,
): WorkspaceSearchMigrationPrePlanAuthority {
  return {
    configurationHash: authority.configurationHash,
    stateTableId: authority.stateTableId,
    lease: cloneLease(authority.lease),
    maintenanceEvidenceReceiptDigest:
      authority.maintenanceEvidenceReceiptDigest,
    maintenanceEvidencePointerRevision:
      authority.maintenanceEvidencePointerRevision,
    maintenanceEvidenceReceipt: cloneReceipt(
      authority.maintenanceEvidenceReceipt,
    ),
    evaluatedAt: authority.evaluatedAt,
  }
}

/**
 * Creates the canonical digest for one complete lease envelope.
 *
 * @param stateIncarnationDigest - Stable table-incarnation digest.
 * @param stateTableId - Immutable migration-state TableId.
 * @param configurationHash - Exact measured configuration digest.
 * @param lease - Exact durable lease.
 * @returns Lowercase SHA-256 record digest.
 */
function createLeaseRecordDigest(
  stateIncarnationDigest: string,
  stateTableId: string,
  configurationHash: string,
  lease: WorkspaceSearchMigrationLease,
): string {
  return createMigrationDigest({
    kind: prePlanLeaseKind,
    version: prePlanAuthorityRecordVersion,
    stateIncarnationDigest,
    stateTableId,
    configurationHash,
    lease,
  })
}

/**
 * Creates the canonical digest for one complete pointer envelope.
 *
 * @param pointer - Complete pointer fields excluding record digest.
 * @returns Lowercase SHA-256 record digest.
 */
function createPointerRecordDigest(
  pointer: Omit<DurablePrePlanMaintenancePointer, 'recordDigest'>,
): string {
  return createMigrationDigest({
    kind: prePlanPointerKind,
    version: prePlanAuthorityRecordVersion,
    stateIncarnationDigest: pointer.stateIncarnationDigest,
    stateTableId: pointer.stateTableId,
    configurationHash: pointer.configurationHash,
    runId: pointer.runId,
    ownerId: pointer.ownerId,
    fenceToken: pointer.fenceToken,
    revision: pointer.revision,
    receiptDigest: pointer.receiptDigest,
    receiptValidUntilEpochMilliseconds:
      pointer.receiptValidUntilEpochMilliseconds,
  })
}

/**
 * Creates the canonical digest for one immutable receipt envelope.
 *
 * @param binding - Exact durable binding.
 * @param ownerId - Lease owner that validated the receipt.
 * @param receiptDigest - Digest of the exact receipt payload.
 * @param receipt - Exact receipt payload.
 * @returns Lowercase SHA-256 record digest.
 */
function createReceiptRecordDigest(
  binding: PrePlanAuthorityBinding,
  ownerId: string,
  receiptDigest: string,
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
): string {
  return createMigrationDigest({
    kind: prePlanReceiptKind,
    version: prePlanAuthorityRecordVersion,
    stateIncarnationDigest: binding.stateIncarnationDigest,
    stateTableId: binding.stateTableId,
    configurationHash: binding.configurationHash,
    ownerId,
    receiptDigest,
    receipt,
  })
}

/**
 * Creates the single global lease key for one physical state incarnation.
 *
 * The key deliberately excludes configuration and run identifiers so all
 * operators targeting the same state-table incarnation compete on one lease.
 *
 * @param binding - Current state-table binding.
 * @returns Deterministic bounded sort key.
 */
function createLeaseRecordKey(
  binding: PrePlanAuthorityBinding,
): string {
  return `${prePlanAuthorityRecordKeyPrefix}/${binding.stateIncarnationDigest}/lease`
}

/**
 * Creates the stable digest binding one run and configuration.
 *
 * @param binding - Current state/configuration binding.
 * @param runId - Exact operator-selected run.
 * @returns Lowercase SHA-256 binding digest.
 */
function createRunConfigurationBindingDigest(
  binding: PrePlanAuthorityBinding,
  runId: string,
): string {
  return createMigrationDigest({
    kind: 'workspace-search-pre-plan-run-configuration',
    version: prePlanAuthorityRecordVersion,
    stateIncarnationDigest: binding.stateIncarnationDigest,
    stateTableId: binding.stateTableId,
    configurationHash: binding.configurationHash,
    runId,
  })
}

/**
 * Creates one run/configuration current-receipt pointer key.
 *
 * @param binding - Current state/configuration binding.
 * @param runId - Exact operator-selected run.
 * @returns Deterministic bounded sort key.
 */
function createPointerRecordKey(
  binding: PrePlanAuthorityBinding,
  runId: string,
): string {
  const validatedRunId = readMigrationIdentifier(runId)
  return `${prePlanAuthorityRecordKeyPrefix}/${binding.stateIncarnationDigest}/${createRunConfigurationBindingDigest(binding, validatedRunId)}/current`
}

/**
 * Creates one immutable receipt key.
 *
 * @param binding - Current state/configuration binding.
 * @param runId - Exact operator-selected run.
 * @param receiptDigest - Digest of the exact receipt payload.
 * @returns Deterministic bounded sort key.
 */
function createReceiptRecordKey(
  binding: PrePlanAuthorityBinding,
  runId: string,
  receiptDigest: string,
): string {
  const validatedRunId = readMigrationIdentifier(runId)
  const validatedDigest = readDigest(receiptDigest)
  return `${prePlanAuthorityRecordKeyPrefix}/${binding.stateIncarnationDigest}/${createRunConfigurationBindingDigest(binding, validatedRunId)}/receipt/${validatedDigest}`
}

/**
 * Creates one strongly consistent exact-record read.
 *
 * @param stateTableName - Exact physical migration-state table name.
 * @param recordKey - Adapter-owned deterministic record key.
 * @returns Adapter-owned GetItem command.
 */
function createStrongGetCommand(
  stateTableName: string,
  recordKey: string,
): GetItemCommand {
  return new GetItemCommand({
    TableName: stateTableName,
    ConsistentRead: true,
    Key: {
      migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
      recordKey: { S: recordKey },
    },
  })
}

/**
 * Creates one complete global lease item.
 *
 * @param binding - Current adapter binding.
 * @param durable - Exact durable lease envelope.
 * @returns Validated low-level DynamoDB item.
 */
function createLeaseItem(
  binding: PrePlanAuthorityBinding,
  durable: DurablePrePlanLease,
): Readonly<Record<string, AttributeValue>> {
  if (
    durable.stateTableName !== binding.stateTableName ||
    durable.stateIncarnationDigest !== binding.stateIncarnationDigest ||
    durable.stateTableId !== binding.stateTableId ||
    durable.configurationHash !== binding.configurationHash
  ) {
    return failPrePlanAuthorityAws('CONFIGURATION_DRIFT')
  }
  const heartbeatEpochMilliseconds = Date.parse(
    durable.lease.heartbeatAt,
  )
  const expiresEpochMilliseconds = Date.parse(durable.lease.expiresAt)
  const item: Record<string, AttributeValue> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: { S: createLeaseRecordKey(binding) },
    kind: { S: prePlanLeaseKind },
    version: { N: String(prePlanAuthorityRecordVersion) },
    stateIncarnationDigest: {
      S: durable.stateIncarnationDigest,
    },
    stateTableId: { S: durable.stateTableId },
    configurationHash: { S: durable.configurationHash },
    runId: { S: durable.lease.runId },
    ownerId: { S: durable.lease.ownerId },
    fenceToken: { N: String(durable.lease.fenceToken) },
    heartbeatAt: { S: durable.lease.heartbeatAt },
    heartbeatEpochMilliseconds: {
      N: String(heartbeatEpochMilliseconds),
    },
    expiresAt: { S: durable.lease.expiresAt },
    expiresEpochMilliseconds: {
      N: String(expiresEpochMilliseconds),
    },
    recordDigest: { S: durable.recordDigest },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Creates one complete current receipt pointer item.
 *
 * @param binding - Current adapter binding.
 * @param pointer - Exact durable pointer.
 * @returns Validated low-level DynamoDB item.
 */
function createPointerItem(
  binding: PrePlanAuthorityBinding,
  pointer: DurablePrePlanMaintenancePointer,
): Readonly<Record<string, AttributeValue>> {
  requireBinding(binding, pointer)
  const item: Record<string, AttributeValue> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createPointerRecordKey(binding, pointer.runId),
    },
    kind: { S: prePlanPointerKind },
    version: { N: String(prePlanAuthorityRecordVersion) },
    stateIncarnationDigest: {
      S: pointer.stateIncarnationDigest,
    },
    stateTableId: { S: pointer.stateTableId },
    configurationHash: { S: pointer.configurationHash },
    runId: { S: pointer.runId },
    ownerId: { S: pointer.ownerId },
    fenceToken: { N: String(pointer.fenceToken) },
    revision: { N: String(pointer.revision) },
    receiptDigest: { S: pointer.receiptDigest },
    receiptValidUntilEpochMilliseconds: {
      N: String(pointer.receiptValidUntilEpochMilliseconds),
    },
    recordDigest: { S: pointer.recordDigest },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Creates one complete immutable receipt item.
 *
 * @param binding - Current adapter binding.
 * @param durable - Exact durable receipt envelope.
 * @returns Validated low-level DynamoDB item.
 */
function createReceiptItem(
  binding: PrePlanAuthorityBinding,
  durable: DurablePrePlanMaintenanceReceipt,
): Readonly<Record<string, AttributeValue>> {
  requireBinding(binding, durable)
  const receipt = durable.receipt
  const item: Record<string, AttributeValue> = {
    migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
    recordKey: {
      S: createReceiptRecordKey(
        binding,
        receipt.runId,
        durable.receiptDigest,
      ),
    },
    kind: { S: prePlanReceiptKind },
    version: { N: String(prePlanAuthorityRecordVersion) },
    stateIncarnationDigest: {
      S: durable.stateIncarnationDigest,
    },
    stateTableId: { S: durable.stateTableId },
    configurationHash: { S: durable.configurationHash },
    runId: { S: receipt.runId },
    ownerId: { S: durable.ownerId },
    receiptDigest: { S: durable.receiptDigest },
    evidenceDigest: { S: receipt.evidenceDigest },
    evidenceLocator: { S: receipt.evidenceLocator },
    runtimeRevision: { N: String(receipt.runtimeRevision) },
    fenceToken: { N: String(receipt.fenceToken) },
    validatedAt: { S: receipt.validatedAt },
    validatedEpochMilliseconds: {
      N: String(Date.parse(receipt.validatedAt)),
    },
    oldestObservationAt: { S: receipt.oldestObservationAt },
    oldestObservationEpochMilliseconds: {
      N: String(Date.parse(receipt.oldestObservationAt)),
    },
    validUntil: { S: receipt.validUntil },
    validUntilEpochMilliseconds: {
      N: String(Date.parse(receipt.validUntil)),
    },
    recordDigest: { S: durable.recordDigest },
  }
  validateDynamoDbItemSize(item)
  return item
}

/**
 * Creates the atomic lease transition transaction.
 *
 * @param input - Exact predecessor, successor, binding, and clock.
 * @returns Adapter-owned TransactWriteItems command.
 */
function createLeaseCommitCommand(
  input: CreatePrePlanLeaseCommitCommandInput,
): TransactWriteItemsCommand {
  const condition = input.predecessor === undefined
    ? createAbsentRecordCondition()
    : createExistingLeaseCondition(
      input.operation,
      input.predecessor,
      input.clock,
    )
  if (
    input.operation === 'heartbeat' &&
    input.predecessor === undefined
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  const successorItem = createLeaseItem(
    input.binding,
    input.successor,
  )
  const put: NonNullable<TransactWriteItem['Put']> = {
    TableName: input.binding.stateTableName,
    Item: successorItem,
    ConditionExpression: condition.expression,
    ExpressionAttributeNames: condition.names,
    ...(condition.values === undefined
      ? {}
      : { ExpressionAttributeValues: condition.values }),
  }
  return new TransactWriteItemsCommand({
    ClientRequestToken: createLeaseTransactionToken(
      input.operation,
      input.predecessor,
      input.successor,
    ),
    TransactItems: [{ Put: put }],
  })
}

/**
 * Creates the atomic lease-check, immutable-receipt, and pointer transaction.
 *
 * @param input - Exact lease, predecessor pointer, receipt, and clock.
 * @returns Adapter-owned TransactWriteItems command.
 */
function createReceiptCommitCommand(
  input: CreatePrePlanReceiptCommitCommandInput,
): TransactWriteItemsCommand {
  requireBinding(input.binding, input.lease)
  requireBinding(input.binding, input.successorPointer)
  requireBinding(input.binding, input.receipt)
  const leaseCondition = createReceiptLeaseCondition(
    input.lease,
    input.clock,
  )
  const pointerCondition =
    input.predecessorPointer === undefined
      ? createAbsentRecordCondition()
      : createExistingPointerCondition(input.predecessorPointer)
  const receiptItem = createReceiptItem(
    input.binding,
    input.receipt,
  )
  const pointerItem = createPointerItem(
    input.binding,
    input.successorPointer,
  )
  const conditionCheck:
    NonNullable<TransactWriteItem['ConditionCheck']> = {
      TableName: input.binding.stateTableName,
      Key: {
        migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
        recordKey: {
          S: createLeaseRecordKey(input.binding),
        },
      },
      ConditionExpression: leaseCondition.expression,
      ExpressionAttributeNames: leaseCondition.names,
      ExpressionAttributeValues: leaseCondition.values,
    }
  const receiptPut: NonNullable<TransactWriteItem['Put']> = {
    TableName: input.binding.stateTableName,
    Item: receiptItem,
    ConditionExpression:
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    ExpressionAttributeNames: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
  }
  const pointerPut: NonNullable<TransactWriteItem['Put']> = {
    TableName: input.binding.stateTableName,
    Item: pointerItem,
    ConditionExpression: pointerCondition.expression,
    ExpressionAttributeNames: pointerCondition.names,
    ...(pointerCondition.values === undefined
      ? {}
      : { ExpressionAttributeValues: pointerCondition.values }),
  }
  return new TransactWriteItemsCommand({
    ClientRequestToken: createReceiptTransactionToken(input),
    TransactItems: [
      { ConditionCheck: conditionCheck },
      { Put: receiptPut },
      { Put: pointerPut },
    ],
  })
}

/**
 * Creates an absence condition for a first immutable record.
 *
 * @returns Exact absence condition.
 */
function createAbsentRecordCondition(): PrePlanAuthorityCondition {
  return {
    expression:
      'attribute_not_exists(#migrationId) AND attribute_not_exists(#recordKey)',
    names: {
      '#migrationId': 'migrationId',
      '#recordKey': 'recordKey',
    },
  }
}

/**
 * Creates the exact predecessor and expiry condition for a lease transition.
 *
 * @param operation - Acquire/takeover or heartbeat.
 * @param predecessor - Exact validated predecessor.
 * @param clock - Adapter-owned transaction time.
 * @returns Exact full-fingerprint condition.
 */
function createExistingLeaseCondition(
  operation: 'acquire' | 'heartbeat',
  predecessor: DurablePrePlanLease,
  clock: PrePlanAuthorityClockSnapshot,
): PrePlanAuthorityCondition {
  const expiryComparison = operation === 'acquire'
    ? '#expiresEpochMilliseconds <= :clock'
    : '#expiresEpochMilliseconds > :clock'
  return {
    expression: [
      '#kind = :kind',
      '#version = :version',
      '#stateIncarnationDigest = :stateIncarnationDigest',
      '#stateTableId = :stateTableId',
      '#configurationHash = :configurationHash',
      '#runId = :runId',
      '#ownerId = :ownerId',
      '#fenceToken = :fenceToken',
      '#heartbeatEpochMilliseconds = :heartbeatEpochMilliseconds',
      '#expiresEpochMilliseconds = :expiresEpochMilliseconds',
      '#recordDigest = :recordDigest',
      expiryComparison,
    ].join(' AND '),
    names: {
      '#kind': 'kind',
      '#version': 'version',
      '#stateIncarnationDigest': 'stateIncarnationDigest',
      '#stateTableId': 'stateTableId',
      '#configurationHash': 'configurationHash',
      '#runId': 'runId',
      '#ownerId': 'ownerId',
      '#fenceToken': 'fenceToken',
      '#heartbeatEpochMilliseconds': 'heartbeatEpochMilliseconds',
      '#expiresEpochMilliseconds': 'expiresEpochMilliseconds',
      '#recordDigest': 'recordDigest',
    },
    values: {
      ':kind': { S: prePlanLeaseKind },
      ':version': { N: String(prePlanAuthorityRecordVersion) },
      ':stateIncarnationDigest': {
        S: predecessor.stateIncarnationDigest,
      },
      ':stateTableId': { S: predecessor.stateTableId },
      ':configurationHash': {
        S: predecessor.configurationHash,
      },
      ':runId': { S: predecessor.lease.runId },
      ':ownerId': { S: predecessor.lease.ownerId },
      ':fenceToken': {
        N: String(predecessor.lease.fenceToken),
      },
      ':heartbeatEpochMilliseconds': {
        N: String(Date.parse(predecessor.lease.heartbeatAt)),
      },
      ':expiresEpochMilliseconds': {
        N: String(Date.parse(predecessor.lease.expiresAt)),
      },
      ':recordDigest': { S: predecessor.recordDigest },
      ':clock': { N: String(clock.epochMilliseconds) },
    },
  }
}

/**
 * Creates the exact active-lease condition for one receipt commit.
 *
 * Heartbeat timestamps and lease expiry are deliberately not CASed. A
 * concurrent same-fence heartbeat may safely lengthen the lease while the
 * transaction still verifies the exact owner/fence and required headroom.
 *
 * @param lease - Exact active durable lease.
 * @param clock - Adapter-owned transaction time.
 * @returns Exact active-authority condition.
 */
function createReceiptLeaseCondition(
  lease: DurablePrePlanLease,
  clock: PrePlanAuthorityClockSnapshot,
): PrePlanAuthorityCondition & {
  /** Receipt lease checks always require exact operands. */
  readonly values: Readonly<Record<string, AttributeValue>>
} {
  const minimumExpiry =
    clock.epochMilliseconds +
    WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  return {
    expression: [
      '#kind = :kind',
      '#version = :version',
      '#stateIncarnationDigest = :stateIncarnationDigest',
      '#stateTableId = :stateTableId',
      '#configurationHash = :configurationHash',
      '#runId = :runId',
      '#ownerId = :ownerId',
      '#fenceToken = :fenceToken',
      '#expiresEpochMilliseconds > :minimumExpiry',
    ].join(' AND '),
    names: {
      '#kind': 'kind',
      '#version': 'version',
      '#stateIncarnationDigest': 'stateIncarnationDigest',
      '#stateTableId': 'stateTableId',
      '#configurationHash': 'configurationHash',
      '#runId': 'runId',
      '#ownerId': 'ownerId',
      '#fenceToken': 'fenceToken',
      '#expiresEpochMilliseconds': 'expiresEpochMilliseconds',
    },
    values: {
      ':kind': { S: prePlanLeaseKind },
      ':version': { N: String(prePlanAuthorityRecordVersion) },
      ':stateIncarnationDigest': {
        S: lease.stateIncarnationDigest,
      },
      ':stateTableId': { S: lease.stateTableId },
      ':configurationHash': { S: lease.configurationHash },
      ':runId': { S: lease.lease.runId },
      ':ownerId': { S: lease.lease.ownerId },
      ':fenceToken': { N: String(lease.lease.fenceToken) },
      ':minimumExpiry': { N: String(minimumExpiry) },
    },
  }
}

/**
 * Creates the exact predecessor CAS for a current receipt pointer.
 *
 * @param predecessor - Exact validated predecessor pointer.
 * @returns Exact pointer fingerprint condition.
 */
function createExistingPointerCondition(
  predecessor: DurablePrePlanMaintenancePointer,
): PrePlanAuthorityCondition {
  return {
    expression: [
      '#kind = :kind',
      '#version = :version',
      '#stateIncarnationDigest = :stateIncarnationDigest',
      '#stateTableId = :stateTableId',
      '#configurationHash = :configurationHash',
      '#runId = :runId',
      '#ownerId = :ownerId',
      '#fenceToken = :fenceToken',
      '#revision = :revision',
      '#receiptDigest = :receiptDigest',
      '#receiptValidUntilEpochMilliseconds = :receiptValidUntilEpochMilliseconds',
      '#recordDigest = :recordDigest',
    ].join(' AND '),
    names: {
      '#kind': 'kind',
      '#version': 'version',
      '#stateIncarnationDigest': 'stateIncarnationDigest',
      '#stateTableId': 'stateTableId',
      '#configurationHash': 'configurationHash',
      '#runId': 'runId',
      '#ownerId': 'ownerId',
      '#fenceToken': 'fenceToken',
      '#revision': 'revision',
      '#receiptDigest': 'receiptDigest',
      '#receiptValidUntilEpochMilliseconds':
        'receiptValidUntilEpochMilliseconds',
      '#recordDigest': 'recordDigest',
    },
    values: {
      ':kind': { S: prePlanPointerKind },
      ':version': { N: String(prePlanAuthorityRecordVersion) },
      ':stateIncarnationDigest': {
        S: predecessor.stateIncarnationDigest,
      },
      ':stateTableId': { S: predecessor.stateTableId },
      ':configurationHash': {
        S: predecessor.configurationHash,
      },
      ':runId': { S: predecessor.runId },
      ':ownerId': { S: predecessor.ownerId },
      ':fenceToken': { N: String(predecessor.fenceToken) },
      ':revision': { N: String(predecessor.revision) },
      ':receiptDigest': { S: predecessor.receiptDigest },
      ':receiptValidUntilEpochMilliseconds': {
        N: String(predecessor.receiptValidUntilEpochMilliseconds),
      },
      ':recordDigest': { S: predecessor.recordDigest },
    },
  }
}

/**
 * Extends the exact current-pointer fingerprint with receipt headroom.
 *
 * @param pointer - Exact current durable pointer.
 * @param clock - Adapter-owned transaction time.
 * @returns Exact pointer authority condition.
 */
function createCurrentPointerAuthorityCondition(
  pointer: DurablePrePlanMaintenancePointer,
  clock: PrePlanAuthorityClockSnapshot,
): PrePlanAuthorityCondition & {
  /** Current pointer checks always require exact operands. */
  readonly values: Readonly<Record<string, AttributeValue>>
} {
  const exact = createExistingPointerCondition(pointer)
  if (exact.values === undefined) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  const minimumExpiry =
    clock.epochMilliseconds +
    WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS
  return {
    expression: [
      exact.expression,
      '#receiptValidUntilEpochMilliseconds > :minimumExpiry',
    ].join(' AND '),
    names: exact.names,
    values: {
      ...exact.values,
      ':minimumExpiry': { N: String(minimumExpiry) },
    },
  }
}

/**
 * Creates the complete immutable-receipt fingerprint and freshness condition.
 *
 * The exact operands come from the canonical row encoder so the exported
 * planning boundary cannot drift from private durable schema or digest rules.
 *
 * @param binding - Current measured state/configuration binding.
 * @param receipt - Exact immutable durable receipt.
 * @param clock - Adapter-owned transaction time.
 * @returns Exact immutable-receipt authority condition.
 */
function createCurrentReceiptAuthorityCondition(
  binding: PrePlanAuthorityBinding,
  receipt: DurablePrePlanMaintenanceReceipt,
  clock: PrePlanAuthorityClockSnapshot,
): PrePlanAuthorityCondition & {
  /** Current receipt checks always require exact operands. */
  readonly values: Readonly<Record<string, AttributeValue>>
} {
  const item = createReceiptItem(binding, receipt)
  const clauses: string[] = []
  const names: Record<string, string> = {}
  const values: Record<string, AttributeValue> = {}
  for (const attributeName of Object.keys(item).sort()) {
    if (
      attributeName === 'migrationId' ||
      attributeName === 'recordKey'
    ) {
      continue
    }
    const attributeValue = item[attributeName]
    if (attributeValue === undefined) {
      return failPrePlanAuthorityAws('INVALID_STATE')
    }
    const nameAlias = `#${attributeName}`
    const valueAlias = `:${attributeName}`
    clauses.push(`${nameAlias} = ${valueAlias}`)
    names[nameAlias] = attributeName
    values[valueAlias] = attributeValue
  }
  names['#validUntilEpochMilliseconds'] =
    'validUntilEpochMilliseconds'
  clauses.push('#validUntilEpochMilliseconds > :minimumExpiry')
  values[':minimumExpiry'] = {
    N: String(
      clock.epochMilliseconds +
        WORKSPACE_SEARCH_MIGRATION_MINIMUM_COMMIT_WINDOW_MILLISECONDS,
    ),
  }
  return {
    expression: clauses.join(' AND '),
    names,
    values,
  }
}

/**
 * Wraps one adapter-owned condition around one canonical authority key.
 *
 * @param binding - Current measured state/configuration binding.
 * @param recordKey - Adapter-owned canonical record key.
 * @param condition - Exact fingerprint and freshness condition.
 * @returns One low-level transaction condition check.
 */
function createPrePlanAuthorityConditionCheck(
  binding: PrePlanAuthorityBinding,
  recordKey: string,
  condition: PrePlanAuthorityCondition,
): TransactWriteItem {
  const conditionCheck:
    NonNullable<TransactWriteItem['ConditionCheck']> = {
      TableName: binding.stateTableName,
      Key: {
        migrationId: { S: WORKSPACE_SEARCH_MIGRATION_ID },
        recordKey: { S: recordKey },
      },
      ConditionExpression: condition.expression,
      ExpressionAttributeNames: condition.names,
      ...(condition.values === undefined
        ? {}
        : { ExpressionAttributeValues: condition.values }),
    }
  return { ConditionCheck: conditionCheck }
}

/**
 * Creates one bounded deterministic lease transaction token.
 *
 * @param operation - Acquire/takeover or heartbeat.
 * @param predecessor - Exact predecessor or absence.
 * @param successor - Exact intended successor.
 * @returns Stable token of at most 36 ASCII characters.
 */
function createLeaseTransactionToken(
  operation: 'acquire' | 'heartbeat',
  predecessor: DurablePrePlanLease | undefined,
  successor: DurablePrePlanLease,
): string {
  const digest = createMigrationDigest({
    kind: 'workspace-search-pre-plan-lease-commit',
    version: prePlanAuthorityRecordVersion,
    operation,
    predecessor: predecessor?.recordDigest ?? null,
    successor: successor.recordDigest,
  })
  return `wsm1-${digest.slice(0, 31)}`
}

/**
 * Creates one bounded deterministic receipt transaction token.
 *
 * @param input - Exact receipt transaction material.
 * @returns Stable token of at most 36 ASCII characters.
 */
function createReceiptTransactionToken(
  input: CreatePrePlanReceiptCommitCommandInput,
): string {
  const digest = createMigrationDigest({
    kind: 'workspace-search-pre-plan-receipt-commit',
    version: prePlanAuthorityRecordVersion,
    leaseClaim: {
      runId: input.lease.lease.runId,
      ownerId: input.lease.lease.ownerId,
      fenceToken: input.lease.lease.fenceToken,
    },
    predecessor:
      input.predecessorPointer?.recordDigest ?? null,
    successor: input.successorPointer.recordDigest,
    receipt: input.receipt.recordDigest,
  })
  return `wsm1-${digest.slice(0, 31)}`
}

/**
 * Parses one strict durable global lease item.
 *
 * A predecessor configuration may differ from the current adapter so an
 * expired global lease can be taken over after a reviewed configuration
 * change. State-table incarnation mismatches always fail closed.
 *
 * @param rawItem - Untrusted low-level DynamoDB item.
 * @param expected - Current measured adapter binding.
 * @returns Detached strict durable lease.
 */
function parseLeaseItem(
  rawItem: Readonly<Record<string, AttributeValue>>,
  expected: PrePlanAuthorityBinding,
): DurablePrePlanLease {
  const item = clonePrePlanAuthorityItem(rawItem)
  requireExactItemKeys(item, [
    'configurationHash',
    'expiresAt',
    'expiresEpochMilliseconds',
    'fenceToken',
    'heartbeatAt',
    'heartbeatEpochMilliseconds',
    'kind',
    'migrationId',
    'ownerId',
    'recordDigest',
    'recordKey',
    'runId',
    'stateIncarnationDigest',
    'stateTableId',
    'version',
  ])
  requireBaseRecord(
    item,
    createLeaseRecordKey(expected),
    prePlanLeaseKind,
  )
  const stateIncarnationDigest =
    readRequiredDigestAttribute(item, 'stateIncarnationDigest')
  const stateTableId =
    readRequiredNonemptyStringAttribute(item, 'stateTableId')
  requireStateIncarnation(
    expected,
    stateIncarnationDigest,
    stateTableId,
  )
  const configurationHash =
    readRequiredDigestAttribute(item, 'configurationHash')
  const lease: WorkspaceSearchMigrationLease = {
    runId: readStoredMigrationIdentifierAttribute(item, 'runId'),
    ownerId: readStoredMigrationIdentifierAttribute(item, 'ownerId'),
    fenceToken: readRequiredPositiveNumberAttribute(
      item,
      'fenceToken',
    ),
    heartbeatAt: readStoredCanonicalTimePair(
      item,
      'heartbeatAt',
      'heartbeatEpochMilliseconds',
    ),
    expiresAt: readStoredCanonicalTimePair(
      item,
      'expiresAt',
      'expiresEpochMilliseconds',
    ),
  }
  validateStoredLease(lease)
  const recordDigest =
    readRequiredDigestAttribute(item, 'recordDigest')
  if (
    recordDigest !== createLeaseRecordDigest(
      stateIncarnationDigest,
      stateTableId,
      configurationHash,
      lease,
    )
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return {
    stateTableName: expected.stateTableName,
    stateIncarnationDigest,
    stateTableId,
    configurationHash,
    lease: cloneLease(lease),
    recordDigest,
  }
}

/**
 * Parses one strict current maintenance-receipt pointer.
 *
 * @param rawItem - Untrusted low-level DynamoDB item.
 * @param expected - Current measured adapter binding.
 * @param expectedRunId - Exact run addressed by the record key.
 * @returns Detached strict durable pointer.
 */
function parsePointerItem(
  rawItem: Readonly<Record<string, AttributeValue>>,
  expected: PrePlanAuthorityBinding,
  expectedRunId: string,
): DurablePrePlanMaintenancePointer {
  const item = clonePrePlanAuthorityItem(rawItem)
  requireExactItemKeys(item, [
    'configurationHash',
    'fenceToken',
    'kind',
    'migrationId',
    'ownerId',
    'receiptDigest',
    'receiptValidUntilEpochMilliseconds',
    'recordDigest',
    'recordKey',
    'revision',
    'runId',
    'stateIncarnationDigest',
    'stateTableId',
    'version',
  ])
  requireBaseRecord(
    item,
    createPointerRecordKey(expected, expectedRunId),
    prePlanPointerKind,
  )
  const binding = readExactStoredBinding(item, expected)
  const runId = readStoredMigrationIdentifierAttribute(item, 'runId')
  if (runId !== expectedRunId) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  const pointerWithoutDigest = {
    ...binding,
    runId,
    ownerId:
      readStoredMigrationIdentifierAttribute(item, 'ownerId'),
    fenceToken: readRequiredPositiveNumberAttribute(
      item,
      'fenceToken',
    ),
    revision: readRequiredPositiveNumberAttribute(item, 'revision'),
    receiptDigest:
      readRequiredDigestAttribute(item, 'receiptDigest'),
    receiptValidUntilEpochMilliseconds:
      readRequiredNaturalNumberAttribute(
        item,
        'receiptValidUntilEpochMilliseconds',
      ),
  }
  const recordDigest =
    readRequiredDigestAttribute(item, 'recordDigest')
  if (
    recordDigest !== createPointerRecordDigest(pointerWithoutDigest)
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return {
    ...pointerWithoutDigest,
    recordDigest,
  }
}

/**
 * Parses one strict immutable maintenance receipt.
 *
 * @param rawItem - Untrusted low-level DynamoDB item.
 * @param expected - Current measured adapter binding.
 * @param expectedRunId - Exact run addressed by the record key.
 * @param expectedReceiptDigest - Exact digest addressed by the record key.
 * @returns Detached strict durable receipt.
 */
function parseReceiptItem(
  rawItem: Readonly<Record<string, AttributeValue>>,
  expected: PrePlanAuthorityBinding,
  expectedRunId: string,
  expectedReceiptDigest: string,
): DurablePrePlanMaintenanceReceipt {
  const item = clonePrePlanAuthorityItem(rawItem)
  requireExactItemKeys(item, [
    'configurationHash',
    'evidenceDigest',
    'evidenceLocator',
    'fenceToken',
    'kind',
    'migrationId',
    'oldestObservationAt',
    'oldestObservationEpochMilliseconds',
    'ownerId',
    'receiptDigest',
    'recordDigest',
    'recordKey',
    'runId',
    'runtimeRevision',
    'stateIncarnationDigest',
    'stateTableId',
    'validatedAt',
    'validatedEpochMilliseconds',
    'validUntil',
    'validUntilEpochMilliseconds',
    'version',
  ])
  requireBaseRecord(
    item,
    createReceiptRecordKey(
      expected,
      expectedRunId,
      expectedReceiptDigest,
    ),
    prePlanReceiptKind,
  )
  const binding = readExactStoredBinding(item, expected)
  const runId = readStoredMigrationIdentifierAttribute(item, 'runId')
  if (runId !== expectedRunId) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  const ownerId =
    readStoredMigrationIdentifierAttribute(item, 'ownerId')
  const receipt: WorkspaceSearchMaintenanceEvidenceReceipt = {
    runId,
    evidenceDigest:
      readRequiredDigestAttribute(item, 'evidenceDigest'),
    evidenceLocator:
      readRequiredNonemptyStringAttribute(item, 'evidenceLocator'),
    runtimeRevision: readRequiredPositiveNumberAttribute(
      item,
      'runtimeRevision',
    ),
    fenceToken: readRequiredPositiveNumberAttribute(
      item,
      'fenceToken',
    ),
    validatedAt: readStoredCanonicalTimePair(
      item,
      'validatedAt',
      'validatedEpochMilliseconds',
    ),
    oldestObservationAt: readStoredCanonicalTimePair(
      item,
      'oldestObservationAt',
      'oldestObservationEpochMilliseconds',
    ),
    validUntil: readStoredCanonicalTimePair(
      item,
      'validUntil',
      'validUntilEpochMilliseconds',
    ),
  }
  validateStoredReceipt(receipt, runId)
  const receiptDigest =
    readRequiredDigestAttribute(item, 'receiptDigest')
  if (
    receiptDigest !== expectedReceiptDigest ||
    receiptDigest !== createMigrationDigest(receipt)
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  const recordDigest =
    readRequiredDigestAttribute(item, 'recordDigest')
  if (
    recordDigest !== createReceiptRecordDigest(
      binding,
      ownerId,
      receiptDigest,
      receipt,
    )
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return {
    ...binding,
    ownerId,
    receiptDigest,
    receipt: cloneReceipt(receipt),
    recordDigest,
  }
}

/**
 * Requires exact migration key, record key, kind, and version attributes.
 *
 * @param item - Strict detached low-level item.
 * @param expectedRecordKey - Exact deterministic record key.
 * @param expectedKind - Exact record kind.
 */
function requireBaseRecord(
  item: Readonly<Record<string, AttributeValue>>,
  expectedRecordKey: string,
  expectedKind: string,
): void {
  if (
    readRequiredStringAttribute(item, 'migrationId') !==
      WORKSPACE_SEARCH_MIGRATION_ID ||
    readRequiredStringAttribute(item, 'recordKey') !==
      expectedRecordKey ||
    readRequiredStringAttribute(item, 'kind') !== expectedKind ||
    readRequiredNaturalNumberAttribute(item, 'version') !==
      prePlanAuthorityRecordVersion
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
}

/**
 * Reads and requires the exact current binding from a stored record.
 *
 * @param item - Strict detached low-level item.
 * @param expected - Current measured adapter binding.
 * @returns Detached exact stored binding.
 */
function readExactStoredBinding(
  item: Readonly<Record<string, AttributeValue>>,
  expected: PrePlanAuthorityBinding,
): PrePlanAuthorityBinding {
  const stateIncarnationDigest =
    readRequiredDigestAttribute(item, 'stateIncarnationDigest')
  const stateTableId =
    readRequiredNonemptyStringAttribute(item, 'stateTableId')
  requireStateIncarnation(
    expected,
    stateIncarnationDigest,
    stateTableId,
  )
  const configurationHash =
    readRequiredDigestAttribute(item, 'configurationHash')
  if (configurationHash !== expected.configurationHash) {
    return failPrePlanAuthorityAws('CONFIGURATION_DRIFT')
  }
  return {
    stateTableName: expected.stateTableName,
    stateIncarnationDigest,
    stateTableId,
    configurationHash,
  }
}

/**
 * Requires stored state identity to match the measured physical incarnation.
 *
 * @param expected - Current measured binding.
 * @param stateIncarnationDigest - Stored incarnation digest.
 * @param stateTableId - Stored immutable TableId.
 */
function requireStateIncarnation(
  expected: PrePlanAuthorityBinding,
  stateIncarnationDigest: string,
  stateTableId: string,
): void {
  if (
    stateIncarnationDigest !== expected.stateIncarnationDigest ||
    stateTableId !== expected.stateTableId
  ) {
    return failPrePlanAuthorityAws('CONFIGURATION_DRIFT')
  }
}

/**
 * Detaches and validates one untrusted low-level DynamoDB item.
 *
 * @param item - Raw SDK response item.
 * @returns Strict detached low-level item.
 */
function clonePrePlanAuthorityItem(
  item: unknown,
): Record<string, AttributeValue> {
  const detached =
    decodeAttributeMap(encodeUnknownAttributeMap(item))
  validateDynamoDbItemSize(detached)
  return detached
}

/**
 * Requires an item to contain exactly the declared attributes.
 *
 * @param item - Strict detached low-level item.
 * @param required - Exact required attribute names.
 */
function requireExactItemKeys(
  item: Readonly<Record<string, AttributeValue>>,
  required: readonly string[],
): void {
  const keys = Object.keys(item).sort()
  const expected = [...required].sort()
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
}

/**
 * Reads one exact required string attribute.
 *
 * @param item - Strict detached low-level item.
 * @param name - Required attribute name.
 * @returns Exact string.
 */
function readRequiredStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const value = item[name]
  if (
    value === undefined ||
    value.S === undefined ||
    Object.keys(value).length !== 1
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return value.S
}

/**
 * Reads one nonempty exact required string attribute.
 *
 * @param item - Strict detached low-level item.
 * @param name - Required attribute name.
 * @returns Exact nonempty string.
 */
function readRequiredNonemptyStringAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const value = readRequiredStringAttribute(item, name)
  if (value.length === 0) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return value
}

/**
 * Reads one required lowercase SHA-256 attribute.
 *
 * @param item - Strict detached low-level item.
 * @param name - Required attribute name.
 * @returns Exact validated digest.
 */
function readRequiredDigestAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const value = readRequiredStringAttribute(item, name)
  if (!isHexDigest(value)) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return value
}

/**
 * Reads one required nonnegative safe-integer number attribute.
 *
 * @param item - Strict detached low-level item.
 * @param name - Required attribute name.
 * @returns Exact nonnegative safe integer.
 */
function readRequiredNaturalNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const value = item[name]
  if (
    value === undefined ||
    value.N === undefined ||
    Object.keys(value).length !== 1 ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value.N)
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  const parsed = Number(value.N)
  if (!Number.isSafeInteger(parsed)) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return parsed
}

/**
 * Reads one required positive safe-integer number attribute.
 *
 * @param item - Strict detached low-level item.
 * @param name - Required attribute name.
 * @returns Exact positive safe integer.
 */
function readRequiredPositiveNumberAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): number {
  const value = readRequiredNaturalNumberAttribute(item, name)
  if (value <= 0) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return value
}

/**
 * Reads one strict stored migration identifier.
 *
 * @param item - Strict detached low-level item.
 * @param name - Required attribute name.
 * @returns Exact validated identifier.
 */
function readStoredMigrationIdentifierAttribute(
  item: Readonly<Record<string, AttributeValue>>,
  name: string,
): string {
  const value = readRequiredStringAttribute(item, name)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return value
}

/**
 * Reads a canonical timestamp and verifies its paired epoch-millisecond value.
 *
 * @param item - Strict detached low-level item.
 * @param timestampName - Required canonical timestamp attribute.
 * @param epochName - Required exact epoch-millisecond attribute.
 * @returns Exact canonical timestamp.
 */
function readStoredCanonicalTimePair(
  item: Readonly<Record<string, AttributeValue>>,
  timestampName: string,
  epochName: string,
): string {
  const timestamp = readRequiredStringAttribute(item, timestampName)
  const epochMilliseconds =
    readRequiredNaturalNumberAttribute(item, epochName)
  if (
    !isCanonicalTimestamp(timestamp) ||
    Date.parse(timestamp) !== epochMilliseconds
  ) {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
  return timestamp
}

/**
 * Maps any malformed stored lease to a corruption failure.
 *
 * @param lease - Candidate strict lease.
 */
function validateStoredLease(
  lease: WorkspaceSearchMigrationLease,
): void {
  try {
    validateWorkspaceSearchMigrationLease(lease)
  } catch {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
}

/**
 * Maps any malformed stored receipt to a corruption failure.
 *
 * @param receipt - Candidate strict receipt.
 * @param runId - Exact expected run.
 */
function validateStoredReceipt(
  receipt: WorkspaceSearchMaintenanceEvidenceReceipt,
  runId: string,
): void {
  try {
    validateWorkspaceSearchMaintenanceEvidenceReceipt(receipt, runId)
  } catch {
    return failPrePlanAuthorityAws('INVALID_STATE')
  }
}

/**
 * Runs one authority operation behind a fixed raw-error replacement boundary.
 *
 * @param operation - Exact validation and AWS operation.
 * @returns Detached successful operation result.
 */
async function runPrePlanAuthorityAwsBoundary<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw createPrePlanAuthorityBoundaryFailure(
      readPrePlanAuthorityAwsFailureCode(error),
    )
  }
}

/**
 * Reads one trusted private or public migration failure code.
 *
 * @param error - Arbitrary validation or AWS error.
 * @returns Stable fail-closed migration failure code.
 */
function readPrePlanAuthorityAwsFailureCode(
  error: unknown,
): WorkspaceSearchMigrationFailureCode {
  try {
    if (error instanceof PrePlanAuthorityAwsFailure) return error.code
    if (error instanceof WorkspaceSearchMigrationFailure) {
      const code: unknown = error.code
      return isWorkspaceSearchMigrationFailureCode(code)
        ? code
        : 'INVALID_STATE'
    }
    if (error instanceof ResourceNotFoundException) {
      return 'CONFIGURATION_DRIFT'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    if (isTransactionInProgressErrorName(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const classificationInput =
      createPrePlanAuthorityAwsErrorClassificationInput(error)
    if (
      isThrottlingError(classificationInput) ||
      isTransientError(classificationInput)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Classifies a lease transaction only after reread proved no commit occurred.
 *
 * @param error - Raw transaction error retained inside the private boundary.
 * @param operation - Acquire/takeover or heartbeat.
 * @returns Stable retryable, conflict, or fail-closed code.
 */
function classifyLeaseTransactionError(
  error: unknown,
  operation: 'acquire' | 'heartbeat',
): PrePlanAuthorityAwsFailureCode {
  try {
    if (error instanceof ResourceNotFoundException) {
      return 'CONFIGURATION_DRIFT'
    }
    if (
      error instanceof TransactionConflictException ||
      isTransactionConflictErrorName(error)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (error instanceof TransactionCanceledException) {
      if (
        readTransactionCancellationReasonCode(error, 0) ===
          'ConditionalCheckFailed'
      ) {
        return operation === 'acquire'
          ? 'LEASE_CONFLICT'
          : 'LEASE_LOST'
      }
      return transactionCancellationWasTransient(error)
        ? 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        : 'INVALID_STATE'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    if (isTransactionInProgressErrorName(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const classificationInput =
      createPrePlanAuthorityAwsErrorClassificationInput(error)
    if (
      isThrottlingError(classificationInput)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return isTransientError(classificationInput)
      ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
      : 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Classifies a receipt transaction only after reread proved no commit occurred.
 *
 * Any conditional failure means the exact lease or predecessor pointer is no
 * longer authoritative. Infrastructure conflicts remain explicitly retryable.
 *
 * @param error - Raw transaction error retained inside the private boundary.
 * @returns Stable retryable, lost-authority, or fail-closed code.
 */
function classifyReceiptTransactionError(
  error: unknown,
): PrePlanAuthorityAwsFailureCode {
  try {
    if (error instanceof ResourceNotFoundException) {
      return 'CONFIGURATION_DRIFT'
    }
    if (
      error instanceof TransactionConflictException ||
      isTransactionConflictErrorName(error)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    if (error instanceof TransactionCanceledException) {
      const leaseReason =
        readTransactionCancellationReasonCode(error, 0)
      const receiptReason =
        readTransactionCancellationReasonCode(error, 1)
      const pointerReason =
        readTransactionCancellationReasonCode(error, 2)
      if (leaseReason === 'ConditionalCheckFailed') return 'LEASE_LOST'
      if (receiptReason === 'ConditionalCheckFailed') {
        return 'AMBIGUOUS_OPERATION_UNRESOLVED'
      }
      if (pointerReason === 'ConditionalCheckFailed') {
        return 'INVALID_MAINTENANCE_EVIDENCE'
      }
      if (transactionCancellationHasConditionalFailure(error)) {
        return 'INVALID_STATE'
      }
      return transactionCancellationWasTransient(error)
        ? 'TRANSIENT_INFRASTRUCTURE_FAILURE'
        : 'INVALID_STATE'
    }
    if (!(error instanceof Error)) return 'INVALID_STATE'
    if (isTransactionInProgressErrorName(error)) {
      return 'AMBIGUOUS_OPERATION_UNRESOLVED'
    }
    const classificationInput =
      createPrePlanAuthorityAwsErrorClassificationInput(error)
    if (
      isThrottlingError(classificationInput)
    ) {
      return 'TRANSIENT_INFRASTRUCTURE_FAILURE'
    }
    return isTransientError(classificationInput)
      ? 'AMBIGUOUS_OPERATION_UNRESOLVED'
      : 'INVALID_STATE'
  } catch {
    return 'INVALID_STATE'
  }
}

/**
 * Detects a retryable DynamoDB transaction-conflict error name.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether its stable name represents a transaction race.
 */
function isTransactionConflictErrorName(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name: unknown = Reflect.get(error, 'name')
  return name === 'TransactionConflictException'
}

/**
 * Detects a transaction whose idempotent request may still commit.
 *
 * @param error - Candidate raw SDK error.
 * @returns Whether its stable name denotes an in-progress transaction.
 */
function isTransactionInProgressErrorName(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const name: unknown = Reflect.get(error, 'name')
  return name === 'TransactionInProgressException'
}

/**
 * Detects one conditional-check cancellation reason.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @returns Whether any transaction item rejected its condition.
 */
function transactionCancellationHasConditionalFailure(
  error: TransactionCanceledException,
): boolean {
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return false
  for (const reason of reasons) {
    if (typeof reason !== 'object' || reason === null) continue
    const code: unknown = Reflect.get(reason, 'Code')
    if (code === 'ConditionalCheckFailed') return true
  }
  return false
}

/**
 * Reads one stable cancellation reason code by transaction item index.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @param index - Zero-based transaction item index.
 * @returns Stable reason code or undefined.
 */
function readTransactionCancellationReasonCode(
  error: TransactionCanceledException,
  index: number,
): string | undefined {
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return undefined
  const reason: unknown = reasons[index]
  if (typeof reason !== 'object' || reason === null) return undefined
  const code: unknown = Reflect.get(reason, 'Code')
  return typeof code === 'string' ? code : undefined
}

/**
 * Detects safe retryable DynamoDB transaction cancellation reasons.
 *
 * @param error - Raw DynamoDB transaction cancellation.
 * @returns Whether any stable reason denotes transient infrastructure.
 */
function transactionCancellationWasTransient(
  error: TransactionCanceledException,
): boolean {
  const reasons: unknown = Reflect.get(error, 'CancellationReasons')
  if (!Array.isArray(reasons)) return false
  for (const reason of reasons) {
    if (typeof reason !== 'object' || reason === null) continue
    const code: unknown = Reflect.get(reason, 'Code')
    if (
      code === 'ThrottlingError' ||
      code === 'ProvisionedThroughputExceeded' ||
      code === 'TransactionConflict'
    ) {
      return true
    }
  }
  return false
}

/**
 * Copies only fields required by Smithy's retry classifiers.
 *
 * @param error - Raw SDK or Node.js transport error.
 * @param depth - Bounded wrapped-cause depth already copied.
 * @returns Detached secret-free classifier input.
 */
function createPrePlanAuthorityAwsErrorClassificationInput(
  error: Error,
  depth = 0,
): PrePlanAuthorityAwsErrorClassificationInput {
  const nameValue: unknown = Reflect.get(error, 'name')
  const codeValue: unknown = Reflect.get(error, 'code')
  const metadataValue: unknown = Reflect.get(error, '$metadata')
  const retryableValue: unknown = Reflect.get(error, '$retryable')
  const causeValue: unknown =
    depth <= 10 ? Reflect.get(error, 'cause') : undefined
  const httpStatusCode = readOptionalNumericProperty(
    metadataValue,
    'httpStatusCode',
  )
  const throttling = readOptionalBooleanProperty(
    retryableValue,
    'throttling',
  )
  const hasRetryableTrait =
    typeof retryableValue === 'object' && retryableValue !== null
  return {
    name: typeof nameValue === 'string' ? nameValue : '',
    message: '',
    ...(typeof codeValue === 'string' ? { code: codeValue } : {}),
    ...(httpStatusCode === undefined
      ? {}
      : { $metadata: { httpStatusCode } }),
    ...(hasRetryableTrait
      ? {
          $retryable:
            throttling === undefined ? {} : { throttling },
        }
      : {}),
    ...(causeValue instanceof Error
      ? {
          cause:
            createPrePlanAuthorityAwsErrorClassificationInput(
              causeValue,
              depth + 1,
            ),
        }
      : {}),
  }
}

/**
 * Reads one optional finite numeric classifier property.
 *
 * @param value - Candidate object containing the property.
 * @param property - Exact property name.
 * @returns Finite number or undefined.
 */
function readOptionalNumericProperty(
  value: unknown,
  property: string,
): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'number' &&
      Number.isFinite(propertyValue)
    ? propertyValue
    : undefined
}

/**
 * Reads one optional Boolean classifier property.
 *
 * @param value - Candidate object containing the property.
 * @param property - Exact property name.
 * @returns Boolean or undefined.
 */
function readOptionalBooleanProperty(
  value: unknown,
  property: string,
): boolean | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const propertyValue: unknown = Reflect.get(value, property)
  return typeof propertyValue === 'boolean'
    ? propertyValue
    : undefined
}

/**
 * Raises one privately branded adapter failure.
 *
 * @param code - Stable trusted failure code.
 * @returns Never returns.
 */
function failPrePlanAuthorityAws(
  code: PrePlanAuthorityAwsFailureCode,
): never {
  throw new PrePlanAuthorityAwsFailure(code)
}

/**
 * Creates one public fixed-message adapter boundary failure.
 *
 * @param code - Stable operator-safe migration failure code.
 * @returns Secret-free pre-plan authority failure.
 */
function createPrePlanAuthorityBoundaryFailure(
  code: WorkspaceSearchMigrationFailureCode,
): WorkspaceSearchMigrationFailure {
  return new WorkspaceSearchMigrationFailure(
    code,
    `Workspace Search pre-plan authority stopped safely (${code}).`,
  )
}
