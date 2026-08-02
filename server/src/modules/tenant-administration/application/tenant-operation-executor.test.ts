import { describe, expect, test } from 'bun:test'
import type {
  TenantOperation,
  TenantOperationStepProof,
} from '@mukuroji/contracts'
import {
  advanceTenantOperation,
  failTenantOperation,
} from '../domain/tenant-administration'
import {
  TenantOperationExecutor,
  type ExecuteTenantOperationInput,
  type TenantOperationStatePort,
} from './tenant-operation-executor'

/** In-memory durable state port used by executor unit tests. */
class InMemoryTenantOperationState implements TenantOperationStatePort {
  /** Current durable operation. */
  private operation: TenantOperation
  /** Actors recorded for each transition. */
  readonly actors: string[] = []
  /** Proofs recorded for each transition. */
  readonly proofs: Array<TenantOperationStepProof | undefined> = []

  /** Creates the state port from one operation fixture. */
  constructor(operation: TenantOperation) {
    this.operation = operation
  }

  /** Returns the current operation after tenant and operation identity checks. */
  async getOperation(workspaceId: string, operationId: string): Promise<TenantOperation> {
    if (
      workspaceId !== this.operation.workspaceId ||
      operationId !== this.operation.operationId
    ) {
      throw new Error('operation not found')
    }
    return this.operation
  }

  /** Applies the same domain transition used by the DynamoDB adapter. */
  async advanceOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    proof: TenantOperationStepProof | undefined,
  ): Promise<TenantOperation> {
    await this.getOperation(workspaceId, operationId)
    this.actors.push(actorMemberKey)
    this.proofs.push(proof)
    this.operation = {
      ...advanceTenantOperation(
        this.operation,
        proof,
        `2026-08-02T00:0${this.operation.revision + 1}:00.000Z`,
      ),
      updatedBy: actorMemberKey,
    }
    return this.operation
  }

  /** Applies the same terminal failure transition used by the DynamoDB adapter. */
  async failOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    failureCode: string,
  ): Promise<TenantOperation> {
    await this.getOperation(workspaceId, operationId)
    this.actors.push(actorMemberKey)
    this.operation = {
      ...failTenantOperation(
        this.operation,
        failureCode,
        `2026-08-02T00:0${this.operation.revision + 1}:00.000Z`,
      ),
      updatedBy: actorMemberKey,
    }
    return this.operation
  }
}

/** Creates a requested export operation fixture. */
function createRequestedOperation(): TenantOperation {
  return {
    operationId: 'operation-1',
    workspaceId: 'workspace-1',
    kind: 'export',
    status: 'requested',
    requestedBy: 'owner-1',
    requestedAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    updatedBy: 'owner-1',
    completedSteps: [],
    exportFormat: 'jsonl',
    revision: 0,
  }
}

describe('TenantOperationExecutor', () => {
  test('starts a requested operation from the internal stream executor', async () => {
    const state = new InMemoryTenantOperationState(createRequestedOperation())
    const executor = new TenantOperationExecutor(state)

    const operation = await executor.execute({
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      executorId: 'executor:tenant-operation-stream',
    })

    expect(operation).toMatchObject({
      status: 'running',
      currentStep: 'snapshot',
      revision: 1,
    })
    expect(state.actors).toEqual(['executor:tenant-operation-stream'])
    expect(state.proofs).toEqual([undefined])
  })

  test('starts and completes the current step only with matching evidence', async () => {
    const state = new InMemoryTenantOperationState(createRequestedOperation())
    const executor = new TenantOperationExecutor(state)

    const operation = await executor.execute({
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      executorId: 'executor:data-export',
      allowedSteps: ['snapshot'],
      proof: {
        step: 'snapshot',
        evidenceReference: createEvidenceReference(1),
      },
    })

    expect(operation).toMatchObject({
      status: 'running',
      currentStep: 'prepare-artifact',
      completedSteps: ['snapshot'],
      lastEvidenceReference:
        createEvidenceReference(1),
      revision: 2,
    })
    expect(state.actors).toEqual([
      'executor:data-export',
      'executor:data-export',
    ])
  })

  test('replays a committed proof without advancing the next step', async () => {
    const state = new InMemoryTenantOperationState(createRequestedOperation())
    const executor = new TenantOperationExecutor(state)
    const input: ExecuteTenantOperationInput = {
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      executorId: 'executor:data-export',
      allowedSteps: ['snapshot'],
      proof: {
        step: 'snapshot',
        evidenceReference: createEvidenceReference(2),
      },
    }

    const committed = await executor.execute(input)
    const replayed = await executor.execute(input)

    expect(replayed).toEqual(committed)
    expect(replayed).toMatchObject({
      currentStep: 'prepare-artifact',
      completedSteps: ['snapshot'],
      revision: 2,
    })
    expect(state.actors).toEqual([
      'executor:data-export',
      'executor:data-export',
    ])
  })

  test('rejects a committed proof replay through a different step capability', async () => {
    const state = new InMemoryTenantOperationState(createRequestedOperation())
    const executor = new TenantOperationExecutor(state)
    const proof: TenantOperationStepProof = {
      step: 'snapshot',
      evidenceReference: createEvidenceReference(1),
    }
    await executor.execute({
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      executorId: 'executor:tenant-export',
      allowedSteps: ['snapshot'],
      proof,
    })

    await expect(executor.execute({
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      executorId: 'executor:tenant-access-revocation',
      allowedSteps: ['revoke-access'],
      proof,
    })).rejects.toMatchObject({
      code: 'TenantOperationCapabilityDenied',
      status: 403,
    })
    expect(state.actors).toEqual([
      'executor:tenant-export',
      'executor:tenant-export',
    ])
  })

  test('rejects untrusted actor identities before reading operation state', async () => {
    const state = new InMemoryTenantOperationState(createRequestedOperation())
    const executor = new TenantOperationExecutor(state)

    await expect(executor.execute({
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      executorId: 'owner-1',
    })).rejects.toMatchObject({
      code: 'TenantOperationExecutorInvalid',
      status: 403,
    })
  })

  test('rejects a proof when the invoked capability does not own the current step', async () => {
    const state = new InMemoryTenantOperationState(createRequestedOperation())
    const executor = new TenantOperationExecutor(state)

    await expect(executor.execute({
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      executorId: 'executor:tenant-secret-deletion',
      allowedSteps: ['delete-secrets'],
      proof: {
        step: 'snapshot',
        evidenceReference: createEvidenceReference(3),
      },
    })).rejects.toMatchObject({
      code: 'TenantOperationCapabilityDenied',
      status: 403,
    })
  })

  test('records a terminal failure from the capability owning the current step', async () => {
    const state = new InMemoryTenantOperationState(createRequestedOperation())
    const executor = new TenantOperationExecutor(state)

    const operation = await executor.execute({
      workspaceId: 'workspace-1',
      operationId: 'operation-1',
      executorId: 'executor:data-export',
      allowedSteps: ['snapshot'],
      failureCode: 'EXPORT_SNAPSHOT_FAILED',
    })

    expect(operation).toMatchObject({
      status: 'failed',
      currentStep: 'snapshot',
      failureCode: 'EXPORT_SNAPSHOT_FAILED',
      updatedBy: 'executor:data-export',
      revision: 2,
    })
  })
})

/** Creates one deterministic immutable evidence digest for executor tests. */
function createEvidenceReference(value: number): string {
  return `evidence:sha256:${value.toString(16).padStart(64, '0')}`
}
