import { describe, expect, test } from 'bun:test'
import type {
  TenantOperation,
  TenantOperationStepProof,
} from '@mukuroji/contracts'
import {
  advanceTenantOperation,
  failTenantOperation,
  repairTenantClosureOperation,
} from '../domain/tenant-administration'
import {
  TENANT_OPERATION_EXECUTION_JOB_VERSION,
  TenantOperationResourceOwnerExecutor,
  createTenantDeletedMemberAlias,
  createTenantOperationEvidenceDigest,
  createTenantOperationEvidenceRecordKey,
  resolveTenantOperationResourceOwner,
  type TenantOperationContinuationQueue,
  type TenantOperationExecutionJob,
  type TenantOperationExecutionStatePort,
  type TenantOperationResourceOwner,
  type TenantOperationResourceOwnerResult,
} from './tenant-operation-resource-owner'

/** Mutable in-memory state used to exercise resource-owner orchestration. */
class InMemoryExecutionState implements TenantOperationExecutionStatePort {
  /** Current durable operation. */
  private operation: TenantOperation
  /** Whether bounded side effects are currently permitted. */
  executionAllowed = true
  /** Whether the invocation may acquire the current operation lease. */
  leaseAvailable = true
  /** Proofs committed through the control-plane executor. */
  readonly proofs: Array<TenantOperationStepProof | undefined> = []
  /** Safe terminal failure codes committed through the control plane. */
  readonly failureCodes: string[] = []
  /** Number of successfully acquired execution leases. */
  acquiredLeases = 0
  /** Number of execution leases released by the executor. */
  releasedLeases = 0

  /**
   * Creates an in-memory execution state.
   *
   * @param operation - Initial running operation.
   */
  constructor(operation: TenantOperation) {
    this.operation = operation
  }

  /**
   * Reads the current operation after checking its durable scope.
   *
   * @param workspaceId - Expected Workspace identifier.
   * @param operationId - Expected operation identifier.
   * @returns Current operation.
   */
  async getOperation(
    workspaceId: string,
    operationId: string,
  ): Promise<TenantOperation> {
    if (
      workspaceId !== this.operation.workspaceId ||
      operationId !== this.operation.operationId
    ) {
      throw new Error('operation not found')
    }
    return this.operation
  }

  /**
   * Applies an evidence-backed domain transition.
   *
   * @param workspaceId - Expected Workspace identifier.
   * @param actorMemberKey - Trusted executor identity.
   * @param operationId - Expected operation identifier.
   * @param proof - Optional proof for the current step.
   * @returns Updated operation.
   */
  async advanceOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    proof: TenantOperationStepProof | undefined,
  ): Promise<TenantOperation> {
    await this.getOperation(workspaceId, operationId)
    this.proofs.push(proof)
    this.operation = {
      ...advanceTenantOperation(
        this.operation,
        proof,
        `2026-08-02T00:0${String(this.operation.revision + 1)}:00.000Z`,
      ),
      updatedBy: actorMemberKey,
    }
    return this.operation
  }

  /**
   * Applies a safe terminal failure transition.
   *
   * @param workspaceId - Expected Workspace identifier.
   * @param actorMemberKey - Trusted executor identity.
   * @param operationId - Expected operation identifier.
   * @param failureCode - Stable safe failure classification.
   * @returns Updated operation.
   */
  async failOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    failureCode: string,
  ): Promise<TenantOperation> {
    await this.getOperation(workspaceId, operationId)
    const failed = {
      ...failTenantOperation(
        this.operation,
        failureCode,
        `2026-08-02T00:0${String(this.operation.revision + 1)}:00.000Z`,
      ),
      updatedBy: actorMemberKey,
    }
    this.failureCodes.push(failureCode)
    this.operation = failed
    return this.operation
  }

  /**
   * Returns the test-controlled pause and legal-hold decision.
   *
   * @returns Whether side effects may run.
   */
  async isOperationExecutionAllowed(): Promise<boolean> {
    return this.executionAllowed
  }

  /** Acquires a test execution lease when side effects are enabled. */
  async acquireOperationExecutionLease(): Promise<boolean> {
    if (!this.executionAllowed || !this.leaseAvailable) return false
    this.acquiredLeases += 1
    return true
  }

  /** Records release of one test execution lease. */
  async releaseOperationExecutionLease(): Promise<void> {
    this.releasedLeases += 1
  }

  /** Rewinds the test closure to one cleanup step. */
  async repairOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    step: 'delete-data' | 'delete-secrets',
  ): Promise<TenantOperation> {
    await this.getOperation(workspaceId, operationId)
    this.operation = {
      ...repairTenantClosureOperation(
        this.operation,
        step,
        step === 'delete-data'
          ? createEvidenceReference(1)
          : createEvidenceReference(4),
        `2026-08-02T00:0${String(this.operation.revision + 1)}:00.000Z`,
      ),
      updatedBy: actorMemberKey,
    }
    return this.operation
  }
}

/** Resource owner whose next outcome is controlled by each test. */
class StubResourceOwner implements TenantOperationResourceOwner {
  /** Number of bounded pages executed. */
  executionCount = 0
  /** Next resource-specific result. */
  result: TenantOperationResourceOwnerResult

  /**
   * Creates a stub resource owner.
   *
   * @param result - Result returned by the next execution.
   */
  constructor(result: TenantOperationResourceOwnerResult) {
    this.result = result
  }

  /**
   * Returns the configured bounded-page result.
   *
   * @returns Configured continuation, completion, or failure.
   */
  async execute(): Promise<TenantOperationResourceOwnerResult> {
    this.executionCount += 1
    return this.result
  }
}

/** In-memory continuation queue that records ID-only jobs. */
class RecordingContinuationQueue implements TenantOperationContinuationQueue {
  /** Jobs emitted by the resource owner. */
  readonly jobs: TenantOperationExecutionJob[] = []
  /** Optional delays recorded with continuation jobs. */
  readonly delays: Array<number | undefined> = []

  /**
   * Records a same-capability continuation.
   *
   * @param job - Validated continuation job.
   */
  async send(job: TenantOperationExecutionJob, delaySeconds?: number): Promise<void> {
    this.jobs.push(job)
    this.delays.push(delaySeconds)
  }
}

/** Creates a running closure operation at the data-deletion step. */
function createRunningOperation(): TenantOperation {
  return {
    operationId: 'operation-1',
    workspaceId: 'workspace-1',
    kind: 'closure',
    status: 'running',
    requestedBy: 'owner-1',
    requestedAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:04:00.000Z',
    updatedBy: 'executor:tenant-member-anonymization',
    currentStep: 'delete-data',
    completedSteps: [
      'export',
      'revoke-access',
      'anonymize-members',
    ],
    lastEvidenceReference: createEvidenceReference(1),
    revision: 4,
  }
}

/** Creates the ID-only queue job for the current fixture step. */
function createJob(): TenantOperationExecutionJob {
  return {
    version: TENANT_OPERATION_EXECUTION_JOB_VERSION,
    workspaceId: 'workspace-1',
    operationId: 'operation-1',
    step: 'delete-data',
  }
}

/** Creates one lowercase SHA-256 digest for test evidence. */
function createEvidenceDigest(value: number): string {
  return value.toString(16).padStart(64, '0')
}

/** Creates one content-addressed evidence reference for operation fixtures. */
function createEvidenceReference(value: number): string {
  return `evidence:sha256:${createEvidenceDigest(value)}`
}

describe('TenantOperationResourceOwnerExecutor', () => {
  test('queues a same-scope continuation without advancing control-plane state', async () => {
    const state = new InMemoryExecutionState(createRunningOperation())
    const queue = new RecordingContinuationQueue()
    const nextJob: TenantOperationExecutionJob = {
      ...createJob(),
      cursor: { targetIndex: 1, processedCount: 20 },
    }
    const owner = new StubResourceOwner({ status: 'continuing', nextJob })
    const executor = new TenantOperationResourceOwnerExecutor(
      state,
      owner,
      queue,
      'executor:tenant-data-deletion',
      ['delete-data'],
    )

    const operation = await executor.execute(createJob())

    expect(operation).toEqual(createRunningOperation())
    expect(queue.jobs).toEqual([nextJob])
    expect(state.proofs).toEqual([])
    expect(state.acquiredLeases).toBe(1)
    expect(state.releasedLeases).toBe(1)
  })

  test('forwards a bounded continuation delay while holding the execution lease', async () => {
    const state = new InMemoryExecutionState(createRunningOperation())
    const queue = new RecordingContinuationQueue()
    const nextJob: TenantOperationExecutionJob = {
      ...createJob(),
      cursor: { targetIndex: 0, processedCount: 0 },
    }
    const executor = new TenantOperationResourceOwnerExecutor(
      state,
      new StubResourceOwner({
        status: 'continuing',
        nextJob,
        delaySeconds: 900,
      }),
      queue,
      'executor:tenant-data-deletion',
      ['delete-data'],
    )

    await executor.execute(createJob())

    expect(queue.jobs).toEqual([nextJob])
    expect(queue.delays).toEqual([900])
    expect(state.releasedLeases).toBe(1)
  })

  test('commits content-addressed evidence only after the owner completes', async () => {
    const state = new InMemoryExecutionState(createRunningOperation())
    const queue = new RecordingContinuationQueue()
    const digest = createEvidenceDigest(2)
    const owner = new StubResourceOwner({ status: 'completed', evidenceDigest: digest })
    const executor = new TenantOperationResourceOwnerExecutor(
      state,
      owner,
      queue,
      'executor:tenant-data-deletion',
      ['delete-data'],
    )

    const operation = await executor.execute(createJob())

    expect(operation).toMatchObject({
      currentStep: 'delete-secrets',
      completedSteps: [
        'export',
        'revoke-access',
        'anonymize-members',
        'delete-data',
      ],
      lastEvidenceReference: `evidence:sha256:${digest}`,
      revision: 5,
    })
    expect(queue.jobs).toEqual([])
    expect(state.proofs).toEqual([{
      step: 'delete-data',
      evidenceReference: `evidence:sha256:${digest}`,
    }])
  })

  test('defers a running page while legal hold blocks execution', async () => {
    const state = new InMemoryExecutionState(createRunningOperation())
    state.executionAllowed = false
    const queue = new RecordingContinuationQueue()
    const owner = new StubResourceOwner({
      status: 'completed',
      evidenceDigest: createEvidenceDigest(3),
    })
    const executor = new TenantOperationResourceOwnerExecutor(
      state,
      owner,
      queue,
      'executor:tenant-data-deletion',
      ['delete-data'],
    )

    const operation = await executor.execute(createJob())

    expect(operation).toEqual(createRunningOperation())
    expect(owner.executionCount).toBe(0)
    expect(state.proofs).toEqual([])
    expect(queue.jobs).toEqual([createJob()])
    expect(queue.delays).toEqual([900])
  })

  test('requests a retry while another invocation owns the current execution lease', async () => {
    const state = new InMemoryExecutionState(createRunningOperation())
    state.leaseAvailable = false
    const owner = new StubResourceOwner({
      status: 'completed',
      evidenceDigest: createEvidenceDigest(3),
    })
    const executor = new TenantOperationResourceOwnerExecutor(
      state,
      owner,
      new RecordingContinuationQueue(),
      'executor:tenant-data-deletion',
      ['delete-data'],
    )

    await expect(executor.execute(createJob())).rejects.toMatchObject({
      code: 'TenantOperationExecutionLeaseBusy',
      status: 503,
    })
    expect(owner.executionCount).toBe(0)
    expect(state.proofs).toEqual([])
  })

  test('records only a failure code from a recoverable resource-owner step', async () => {
    const running: TenantOperation = {
      ...createRunningOperation(),
      currentStep: 'revoke-access',
      completedSteps: ['export'],
    }
    const state = new InMemoryExecutionState(running)
    const owner = new StubResourceOwner({
      status: 'failed',
      failureCode: 'ACCESS_REVOKE_FAILED',
    })
    const executor = new TenantOperationResourceOwnerExecutor(
      state,
      owner,
      new RecordingContinuationQueue(),
      'executor:tenant-access-revocation',
      ['revoke-access'],
    )

    const operation = await executor.execute({
      ...createJob(),
      step: 'revoke-access',
    })

    expect(operation).toMatchObject({
      status: 'failed',
      failureCode: 'ACCESS_REVOKE_FAILED',
      updatedBy: 'executor:tenant-access-revocation',
    })
    expect(state.failureCodes).toEqual(['ACCESS_REVOKE_FAILED'])
  })

  test('keeps an irreversible closure step sealed when its owner reports failure', async () => {
    const state = new InMemoryExecutionState(createRunningOperation())
    const executor = new TenantOperationResourceOwnerExecutor(
      state,
      new StubResourceOwner({
        status: 'failed',
        failureCode: 'VERIFIED_DELETION_INCOMPLETE',
      }),
      new RecordingContinuationQueue(),
      'executor:tenant-data-deletion',
      ['delete-data'],
    )

    await expect(executor.execute(createJob())).rejects.toMatchObject({
      code: 'TenantClosureRecoveryRequired',
      status: 409,
    })
    expect(state.failureCodes).toEqual([])
    expect(await state.getOperation('workspace-1', 'operation-1'))
      .toEqual(createRunningOperation())
  })

  test('rewinds verification to data cleanup when residual state is found', async () => {
    const operation: TenantOperation = {
      ...createRunningOperation(),
      currentStep: 'verify',
      completedSteps: [
        'export',
        'revoke-access',
        'anonymize-members',
        'delete-data',
        'delete-secrets',
      ],
      revision: 6,
    }
    const state = new InMemoryExecutionState(operation)
    const executor = new TenantOperationResourceOwnerExecutor(
      state,
      new StubResourceOwner({ status: 'repair', step: 'delete-data' }),
      new RecordingContinuationQueue(),
      'executor:tenant-closure-verification',
      ['verify'],
    )

    const repaired = await executor.execute({
      ...createJob(),
      step: 'verify',
    })

    expect(repaired).toMatchObject({
      status: 'running',
      currentStep: 'delete-data',
      completedSteps: ['export', 'revoke-access', 'anonymize-members'],
      updatedBy: 'executor:tenant-closure-verification',
    })
    expect(repaired?.lastEvidenceReference).toBe(createEvidenceReference(1))
    expect(state.releasedLeases).toBe(1)
  })

  test('rejects a continuation that changes tenant or protocol scope', async () => {
    const state = new InMemoryExecutionState(createRunningOperation())
    const owner = new StubResourceOwner({
      status: 'continuing',
      nextJob: {
        ...createJob(),
        workspaceId: 'workspace-2',
        cursor: { targetIndex: 1, processedCount: 20 },
      },
    })
    const executor = new TenantOperationResourceOwnerExecutor(
      state,
      owner,
      new RecordingContinuationQueue(),
      'executor:tenant-data-deletion',
      ['delete-data'],
    )

    await expect(executor.execute(createJob())).rejects.toMatchObject({
      code: 'TenantOperationContinuationInvalid',
      status: 503,
    })
  })
})

test('creates keyed and idempotent deleted-member aliases', () => {
  const alias = createTenantDeletedMemberAlias(
    'workspace-1',
    'operation-1',
    'member@example.com',
    '1'.repeat(64),
  )
  const anotherKeyAlias = createTenantDeletedMemberAlias(
    'workspace-1',
    'operation-1',
    'member@example.com',
    '2'.repeat(64),
  )

  expect(alias).toMatch(/^deleted\+[a-f0-9]{16}\.[a-f0-9]{24}@invalid\.example$/u)
  expect(anotherKeyAlias).not.toBe(alias)
  expect(createTenantDeletedMemberAlias(
    'workspace-1',
    'operation-1',
    alias,
    '1'.repeat(64),
  )).toBe(alias)
  expect(() => createTenantDeletedMemberAlias(
    'workspace-1',
    'operation-1',
    'member@example.com',
  )).toThrow('Tenant pseudonym key is unavailable or invalid.')
})

test('versions immutable evidence keys by operation execution attempt', () => {
  expect(createTenantOperationEvidenceRecordKey(
    'operation-1',
    'delete-data',
    4,
  )).toBe(
    'EVIDENCE#operation-1#delete-data#REVISION#0000000000000004',
  )
})

test('maps every lifecycle step to exactly one resource owner', () => {
  expect([
    resolveTenantOperationResourceOwner('snapshot'),
    resolveTenantOperationResourceOwner('prepare-artifact'),
    resolveTenantOperationResourceOwner('verify-artifact'),
    resolveTenantOperationResourceOwner('export'),
    resolveTenantOperationResourceOwner('revoke-access'),
    resolveTenantOperationResourceOwner('anonymize-members'),
    resolveTenantOperationResourceOwner('delete-data'),
    resolveTenantOperationResourceOwner('delete-secrets'),
    resolveTenantOperationResourceOwner('verify'),
  ]).toEqual([
    'export',
    'export',
    'export',
    'export',
    'access',
    'identity',
    'data',
    'secrets',
    'verification',
  ])
  expect(createTenantOperationEvidenceDigest({ outcome: 'ok' }))
    .toMatch(/^[a-f0-9]{64}$/u)
})
