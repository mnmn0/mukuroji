import { createHash } from 'node:crypto'
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
   */
  send(job: TenantOperationExecutionJob): Promise<void>
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
}

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

  /**
   * Creates a capability-isolated resource-owner executor.
   *
   * @param state - Durable tenant state and legal-hold guard.
   * @param owner - Resource-specific bounded page implementation.
   * @param continuationQueue - Queue for same-capability continuation pages.
   * @param executorId - Stable capability identity.
   * @param allowedSteps - Exact steps owned by the capability.
   */
  constructor(
    state: TenantOperationExecutionStatePort,
    owner: TenantOperationResourceOwner,
    continuationQueue: TenantOperationContinuationQueue,
    executorId: string,
    allowedSteps: readonly TenantOperationStepProof['step'][],
  ) {
    this.state = state
    this.owner = owner
    this.continuationQueue = continuationQueue
    this.executorId = executorId
    this.allowedSteps = allowedSteps
    this.operationExecutor = new TenantOperationExecutor(state)
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
    if (!await this.state.isOperationExecutionAllowed(
      job.workspaceId,
      job.operationId,
    )) {
      return operation
    }
    const result = await this.owner.execute(job, operation)
    if (result.status === 'continuing') {
      assertSameOperationContinuation(job, result.nextJob)
      await this.continuationQueue.send(result.nextJob)
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
 * Creates a deterministic non-deliverable identity for closure history.
 *
 * @param workspaceId - Canonical Workspace identifier.
 * @param operationId - Closure operation that owns the anonymization.
 * @param memberKey - Member identity that must no longer be recoverable.
 * @returns Stable alias suitable for retained history and relationship keys.
 */
export function createTenantDeletedMemberAlias(
  workspaceId: string,
  operationId: string,
  memberKey: string,
): string {
  const digest = createHash('sha256')
    .update(`${workspaceId}\0${operationId}\0${memberKey}`)
    .digest('hex')
  return `deleted+${digest.slice(0, 24)}@invalid.example`
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
