import { createHash, createHmac, randomUUID } from 'node:crypto'
import type {
  TenantOperation,
  TenantOperationStepProof,
} from '@mukuroji/contracts'
import {
  TenantAdministrationError,
} from '../domain/tenant-administration'
import {
  TenantOperationExecutor,
  type TenantOperationStatePort,
} from './tenant-operation-executor'

/** Version of the durable tenant resource-owner queue protocol. */
export const TENANT_OPERATION_EXECUTION_JOB_VERSION = 1 as const

/** Capability-isolated owner responsible for one tenant lifecycle resource set. */
export type TenantOperationResourceOwnerKind =
  | 'export'
  | 'access'
  | 'identity'
  | 'data'
  | 'secrets'
  | 'verification'

/** Opaque, secret-free cursor carried between bounded resource-owner pages. */
export type TenantOperationExecutionCursor = {
  /** Zero-based resource target currently being processed. */
  targetIndex: number
  /** Opaque adapter cursor for the current target. */
  position?: string
  /** Export sub-phase used by the closure-owned aggregate export step. */
  phase?: 'snapshot' | 'prepare' | 'verify'
  /** Number of records or objects successfully handled so far. */
  processedCount: number
}

/** ID-only durable job sent from the tenant stream dispatcher to one owner queue. */
export type TenantOperationExecutionJob = {
  /** Queue protocol version. */
  version: typeof TENANT_OPERATION_EXECUTION_JOB_VERSION
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Durable tenant operation identifier. */
  operationId: string
  /** Exact lifecycle step assigned to the owner queue. */
  step: TenantOperationStepProof['step']
  /** Optional bounded-page continuation state. */
  cursor?: TenantOperationExecutionCursor
}

/** Result of processing one bounded resource-owner page. */
export type TenantOperationResourceOwnerResult =
  | {
      /** Indicates that another queue page is required. */
      status: 'continuing'
      /** Secret-free continuation job for the same operation step. */
      nextJob: TenantOperationExecutionJob
      /** Optional SQS delay used for bounded closure quiescence. */
      delaySeconds?: number
    }
  | {
      /** Indicates that the resource owner durably completed its step. */
      status: 'completed'
      /** SHA-256 digest of the immutable execution evidence record. */
      evidenceDigest: string
    }
  | {
      /** Indicates a safe terminal outcome that should fail the workflow. */
      status: 'failed'
      /** Stable secret-free failure classification. */
      failureCode: string
    }
  | {
      /** Indicates that verified residual state must be cleaned up again. */
      status: 'repair'
      /** Earliest cleanup step that must be replayed before verification. */
      step: 'delete-data' | 'delete-secrets'
    }

/** Resource-specific page executor behind one capability-isolated Lambda. */
export interface TenantOperationResourceOwner {
  /**
   * Processes one bounded page without advancing control-plane state directly.
   *
   * @param job - Validated ID-only lifecycle job.
   * @param operation - Current strongly read lifecycle operation.
   * @returns A continuation or immutable evidence digest.
   */
  execute(
    job: TenantOperationExecutionJob,
    operation: TenantOperation,
  ): Promise<TenantOperationResourceOwnerResult>
}

/** Durable queue used by a resource owner to continue bounded work. */
export interface TenantOperationContinuationQueue {
  /**
   * Enqueues the next ID-only page.
   *
   * @param job - Validated continuation job.
   * @param delaySeconds - Optional bounded queue delay.
   */
  send(job: TenantOperationExecutionJob, delaySeconds?: number): Promise<void>
}

/** State capability needed to stop resource work under pause or legal hold. */
export interface TenantOperationExecutionStatePort extends TenantOperationStatePort {
  /**
   * Returns whether side effects remain allowed for the current operation revision.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param operationId - Durable tenant operation identifier.
   */
  isOperationExecutionAllowed(
    workspaceId: string,
    operationId: string,
  ): Promise<boolean>
  /**
   * Acquires the single tenant execution lease under operation and governance fences.
   *
   * @param operation - Strongly read operation revision and current step.
   * @param leaseOwner - Invocation-unique lease owner token.
   * @param leaseExpiresAtEpochSeconds - Lease expiry beyond the owner Lambda timeout.
   * @returns Whether the execution page owns the durable lease.
   */
  acquireOperationExecutionLease(
    operation: TenantOperation,
    leaseOwner: string,
    leaseExpiresAtEpochSeconds: number,
  ): Promise<boolean>
  /**
   * Releases a lease only when it is still owned by this invocation.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param operationId - Durable tenant operation identifier.
   * @param leaseOwner - Invocation-unique lease owner token.
   */
  releaseOperationExecutionLease(
    workspaceId: string,
    operationId: string,
    leaseOwner: string,
  ): Promise<void>
  /**
   * Rewinds a closure to the earliest cleanup step needed for verified repair.
   *
   * @param workspaceId - Canonical Workspace identifier.
   * @param actorMemberKey - Trusted verification executor identity.
   * @param operationId - Durable closure operation identifier.
   * @param step - Cleanup step selected by the verifier.
   * @returns Repaired running operation.
   */
  repairOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    step: 'delete-data' | 'delete-secrets',
  ): Promise<TenantOperation>
}

/** Optional deterministic dependencies for resource-owner orchestration. */
export type TenantOperationResourceOwnerExecutorOptions = {
  /** Clock used to calculate execution-lease expiry. */
  clock?: () => Date
  /** Invocation-unique execution-lease token factory. */
  createLeaseOwner?: () => string
}

/** Lease duration kept beyond the five-minute resource-owner Lambda timeout. */
const TENANT_OPERATION_EXECUTION_LEASE_SECONDS = 6 * 60
/** Delay used to preserve a running queue job while legal hold blocks execution. */
const TENANT_OPERATION_BLOCKED_RETRY_DELAY_SECONDS = 15 * 60

/**
 * Runs one resource-owner page and advances lifecycle state only with evidence.
 */
export class TenantOperationResourceOwnerExecutor {
  /** Durable tenant state and legal-hold guard. */
  private readonly state: TenantOperationExecutionStatePort
  /** Capability-isolated resource implementation. */
  private readonly owner: TenantOperationResourceOwner
  /** Queue used only for same-capability continuation pages. */
  private readonly continuationQueue: TenantOperationContinuationQueue
  /** Stable service identity stored in tenant audit history. */
  private readonly executorId: string
  /** Exact steps assigned to this capability. */
  private readonly allowedSteps: readonly TenantOperationStepProof['step'][]
  /** Control-plane executor used to commit evidence. */
  private readonly operationExecutor: TenantOperationExecutor
  /** Clock used to calculate execution-lease expiry. */
  private readonly clock: () => Date
  /** Invocation-unique execution-lease token factory. */
  private readonly createLeaseOwner: () => string

  /**
   * Creates a capability-isolated resource-owner executor.
   *
   * @param state - Durable tenant state and legal-hold guard.
   * @param owner - Resource-specific bounded page implementation.
   * @param continuationQueue - Queue for same-capability continuation pages.
   * @param executorId - Stable capability identity.
   * @param allowedSteps - Exact steps owned by the capability.
   * @param options - Optional deterministic clock and lease-token dependencies.
   */
  constructor(
    state: TenantOperationExecutionStatePort,
    owner: TenantOperationResourceOwner,
    continuationQueue: TenantOperationContinuationQueue,
    executorId: string,
    allowedSteps: readonly TenantOperationStepProof['step'][],
    options: TenantOperationResourceOwnerExecutorOptions = {},
  ) {
    this.state = state
    this.owner = owner
    this.continuationQueue = continuationQueue
    this.executorId = executorId
    this.allowedSteps = allowedSteps
    this.operationExecutor = new TenantOperationExecutor(state)
    this.clock = options.clock ?? (() => new Date())
    this.createLeaseOwner = options.createLeaseOwner ?? randomUUID
  }

  /**
   * Processes one queue job idempotently.
   *
   * @param job - Validated resource-owner job.
   * @returns The latest operation, or undefined when the job became stale.
   */
  async execute(
    job: TenantOperationExecutionJob,
  ): Promise<TenantOperation | undefined> {
    if (!this.allowedSteps.includes(job.step)) {
      throw new TenantAdministrationError(
        403,
        'TenantOperationCapabilityDenied',
        'The tenant resource owner does not own the queued step.',
      )
    }
    const operation = await this.state.getOperation(
      job.workspaceId,
      job.operationId,
    )
    if (
      operation.status !== 'running' ||
      operation.currentStep !== job.step
    ) {
      return operation
    }
    const leaseOwner = this.createLeaseOwner()
    const leaseExpiresAtEpochSeconds = Math.floor(this.clock().getTime() / 1_000) +
      TENANT_OPERATION_EXECUTION_LEASE_SECONDS
    if (!await this.state.acquireOperationExecutionLease(
      operation,
      leaseOwner,
      leaseExpiresAtEpochSeconds,
    )) {
      const latest = await this.state.getOperation(
        job.workspaceId,
        job.operationId,
      )
      const remainsCurrent =
        latest.status === 'running' &&
        latest.currentStep === job.step
      if (remainsCurrent && await this.state.isOperationExecutionAllowed(
        job.workspaceId,
        job.operationId,
      )) {
        throw new TenantAdministrationError(
          503,
          'TenantOperationExecutionLeaseBusy',
          'Tenant operation execution lease is busy and must be retried.',
        )
      }
      if (remainsCurrent) {
        await this.continuationQueue.send(
          job,
          TENANT_OPERATION_BLOCKED_RETRY_DELAY_SECONDS,
        )
      }
      return latest
    }
    try {
      const result = await this.owner.execute(job, operation)
      if (result.status === 'continuing') {
        assertSameOperationContinuation(job, result.nextJob)
        await this.continuationQueue.send(
          result.nextJob,
          normalizeContinuationDelay(result.delaySeconds),
        )
        return operation
      }
      if (result.status === 'failed') {
        return await this.operationExecutor.execute({
          workspaceId: job.workspaceId,
          operationId: job.operationId,
          executorId: this.executorId,
          allowedSteps: this.allowedSteps,
          failureCode: result.failureCode,
        })
      }
      if (result.status === 'repair') {
        if (job.step !== 'verify') {
          throw new TenantAdministrationError(
            503,
            'TenantOperationRepairInvalid',
            'Only the verification capability can request tenant cleanup repair.',
          )
        }
        return await this.state.repairOperation(
          job.workspaceId,
          this.executorId,
          job.operationId,
          result.step,
        )
      }
      const evidenceDigest = normalizeEvidenceDigest(result.evidenceDigest)
      return await this.operationExecutor.execute({
        workspaceId: job.workspaceId,
        operationId: job.operationId,
        executorId: this.executorId,
        allowedSteps: this.allowedSteps,
        proof: {
          step: job.step,
          evidenceReference: `evidence:sha256:${evidenceDigest}`,
        },
      })
    } finally {
      await this.state.releaseOperationExecutionLease(
        job.workspaceId,
        job.operationId,
        leaseOwner,
      )
    }
  }
}

/**
 * Maps a lifecycle step to its capability-isolated resource owner.
 *
 * @param step - Current tenant lifecycle step.
 * @returns Resource owner kind that must receive the job.
 */
export function resolveTenantOperationResourceOwner(
  step: TenantOperationStepProof['step'],
): TenantOperationResourceOwnerKind {
  if (
    step === 'snapshot' ||
    step === 'prepare-artifact' ||
    step === 'verify-artifact' ||
    step === 'export'
  ) {
    return 'export'
  }
  if (step === 'revoke-access') return 'access'
  if (step === 'anonymize-members') return 'identity'
  if (step === 'delete-data') return 'data'
  if (step === 'delete-secrets') return 'secrets'
  return 'verification'
}

/**
 * Creates a deterministic evidence digest for one safe execution summary.
 *
 * @param summary - Secret-free execution evidence payload.
 * @returns Lowercase SHA-256 digest.
 */
export function createTenantOperationEvidenceDigest(
  summary: Readonly<Record<string, unknown>>,
): string {
  return createHash('sha256').update(JSON.stringify(summary)).digest('hex')
}

/**
 * Creates an immutable evidence key for one operation-step execution attempt.
 *
 * @param operationId - Durable tenant operation identifier.
 * @param step - Capability-owned operation step.
 * @param operationRevision - Operation revision held throughout this attempt.
 * @returns Lexically ordered tenant-administration evidence record key.
 */
export function createTenantOperationEvidenceRecordKey(
  operationId: string,
  step: TenantOperationStepProof['step'],
  operationRevision: number,
): string {
  if (!Number.isSafeInteger(operationRevision) || operationRevision < 0) {
    throw new TenantAdministrationError(
      500,
      'TenantOperationEvidenceRevisionInvalid',
      'Tenant operation evidence revision is invalid.',
    )
  }
  return `${createTenantOperationEvidenceRecordPrefix(operationId, step)}${String(operationRevision).padStart(16, '0')}`
}

/**
 * Creates the query prefix shared by every attempt of one operation step.
 *
 * @param operationId - Durable tenant operation identifier.
 * @param step - Capability-owned operation step.
 * @returns Tenant-administration evidence record prefix.
 */
export function createTenantOperationEvidenceRecordPrefix(
  operationId: string,
  step: TenantOperationStepProof['step'],
): string {
  return `EVIDENCE#${operationId}#${step}#REVISION#`
}

/**
 * Creates a deterministic non-deliverable identity for closure history.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param operationId - Closure operation that owns the anonymization.
 * @param memberKey - Member identity that must no longer be recoverable.
 * @param pseudonymKey - Stable secret key used to authenticate the tombstone.
 * @returns Stable alias suitable for retained history and relationship keys.
 */
export function createTenantDeletedMemberAlias(
  workspaceId: string,
  operationId: string,
  memberKey: string,
  pseudonymKey?: string,
): string {
  const normalizedKey = validateTenantPseudonymKey(pseudonymKey)
  const normalizedMemberKey = memberKey.trim().toLowerCase()
  const operationTag = createHmac('sha256', Buffer.from(normalizedKey, 'hex'))
    .update('mukuroji-tenant-deleted-operation-v1\0')
    .update(workspaceId)
    .update('\0')
    .update(operationId)
    .digest('hex')
    .slice(0, 16)
  const aliasMatch = /^deleted\+([a-f0-9]{16})\.[a-f0-9]{24}@invalid\.example$/u
    .exec(normalizedMemberKey)
  if (aliasMatch?.[1] === operationTag) {
    return normalizedMemberKey
  }
  const digest = createHmac('sha256', Buffer.from(normalizedKey, 'hex'))
    .update('mukuroji-tenant-deleted-member-v1\0')
    .update(workspaceId)
    .update('\0')
    .update(operationId)
    .update('\0')
    .update(memberKey)
    .digest('hex')
  return `deleted+${operationTag}.${digest.slice(0, 24)}@invalid.example`
}

/**
 * Validates stable HMAC key material used for closure pseudonyms and cursors.
 *
 * @param value - Candidate 32-byte lowercase hexadecimal key.
 * @returns Exact validated key without normalization.
 */
export function validateTenantPseudonymKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TenantAdministrationError(
      503,
      'TenantPseudonymKeyInvalid',
      'Tenant pseudonym key is unavailable or invalid.',
    )
  }
  return value
}

/** Ensures a continuation cannot cross tenant, operation, step, or protocol boundaries. */
function assertSameOperationContinuation(
  current: TenantOperationExecutionJob,
  next: TenantOperationExecutionJob,
): void {
  if (
    next.version !== TENANT_OPERATION_EXECUTION_JOB_VERSION ||
    next.workspaceId !== current.workspaceId ||
    next.operationId !== current.operationId ||
    next.step !== current.step
  ) {
    throw new TenantAdministrationError(
      503,
      'TenantOperationContinuationInvalid',
      'Tenant operation continuation changed its durable scope.',
    )
  }
}

/** Normalizes one adapter-produced evidence digest. */
function normalizeEvidenceDigest(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new TenantAdministrationError(
      503,
      'TenantOperationEvidenceInvalid',
      'Tenant operation evidence digest is invalid.',
    )
  }
  return normalized
}

/** Normalizes one optional SQS delay without allowing an unbounded retry pause. */
function normalizeContinuationDelay(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0 || value > 900) {
    throw new TenantAdministrationError(
      503,
      'TenantOperationContinuationDelayInvalid',
      'Tenant operation continuation delay is invalid.',
    )
  }
  return value
}
