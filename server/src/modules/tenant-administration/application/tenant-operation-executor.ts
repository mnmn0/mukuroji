import type {
  TenantOperation,
  TenantOperationStepProof,
} from '@mukuroji/contracts'
import { TenantAdministrationError } from '../domain/tenant-administration'

/** Trusted command accepted by the internal tenant lifecycle executor. */
export type ExecuteTenantOperationInput = {
  /** Canonical Workspace identifier. */
  workspaceId: string
  /** Durable tenant operation identifier. */
  operationId: string
  /** Stable service identity recorded in lifecycle audit history. */
  executorId: string
  /** Immutable evidence for the currently running workflow step. */
  proof?: TenantOperationStepProof
  /** Safe terminal failure code reported by the current step capability. */
  failureCode?: string
  /** Workflow steps assigned to the invoked IAM capability. */
  allowedSteps?: readonly TenantOperationStepProof['step'][]
}

/** Minimal durable state capability required by the trusted executor. */
export interface TenantOperationStatePort {
  /** Reads one operation belonging to the supplied Workspace. */
  getOperation(workspaceId: string, operationId: string): Promise<TenantOperation>
  /** Starts or completes one operation step under optimistic concurrency. */
  advanceOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    proof: TenantOperationStepProof | undefined,
  ): Promise<TenantOperation>
  /** Records a safe terminal failure for the current operation step. */
  failOperation(
    workspaceId: string,
    actorMemberKey: string,
    operationId: string,
    failureCode: string,
  ): Promise<TenantOperation>
}

/**
 * Advances tenant lifecycle state only from a capability-scoped executor.
 */
export class TenantOperationExecutor {
  /** Durable tenant lifecycle application port. */
  private readonly client: TenantOperationStatePort

  /**
   * Creates a trusted lifecycle executor.
   *
   * @param client - Durable tenant lifecycle application port.
   */
  constructor(client: TenantOperationStatePort) {
    this.client = client
  }

  /**
   * Starts a requested workflow or completes its current step with evidence.
   *
   * @param input - Trusted execution command.
   * @returns The latest durable operation state.
   */
  async execute(input: ExecuteTenantOperationInput): Promise<TenantOperation> {
    const workspaceId = readExecutorIdentifier(input.workspaceId, 'TenantOperationWorkspaceInvalid')
    const operationId = readExecutorIdentifier(input.operationId, 'TenantOperationIdInvalid')
    const executorId = input.executorId.trim()
    if (!/^executor:[a-zA-Z0-9._/-]{1,119}$/u.test(executorId)) {
      throw new TenantAdministrationError(
        403,
        'TenantOperationExecutorInvalid',
        'A trusted tenant operation executor identity is required.',
      )
    }
    if (input.proof !== undefined && input.failureCode !== undefined) {
      throw new TenantAdministrationError(
        400,
        'TenantOperationExecutionInputInvalid',
        'Tenant operation proof and failure cannot be reported together.',
      )
    }
    let operation = await this.client.getOperation(workspaceId, operationId)
    if (operation.status === 'requested') {
      operation = await this.client.advanceOperation(
        workspaceId,
        executorId,
        operationId,
        undefined,
      )
    }
    const commandedStep = input.proof?.step ?? operation.currentStep
    if (
      (input.proof !== undefined || input.failureCode !== undefined) &&
      (
        commandedStep === undefined ||
        !input.allowedSteps?.includes(commandedStep)
      )
    ) {
      throw new TenantAdministrationError(
        403,
        'TenantOperationCapabilityDenied',
        'The invoked tenant operation capability does not own the commanded step.',
      )
    }
    if (
      input.proof !== undefined &&
      operation.completedSteps.includes(input.proof.step) &&
      operation.lastEvidenceReference === input.proof.evidenceReference.trim()
    ) {
      return operation
    }
    if (
      operation.status === 'failed' &&
      input.failureCode?.trim() === operation.failureCode
    ) {
      return operation
    }
    if (input.proof === undefined && input.failureCode === undefined) return operation
    if (operation.status !== 'running' || operation.currentStep === undefined) return operation
    if (input.failureCode !== undefined) {
      return await this.client.failOperation(
        workspaceId,
        executorId,
        operationId,
        input.failureCode,
      )
    }
    return await this.client.advanceOperation(
      workspaceId,
      executorId,
      operationId,
      input.proof,
    )
  }
}

/**
 * Validates one identifier accepted by the trusted executor boundary.
 *
 * @param value - Candidate identifier.
 * @param code - Stable failure code.
 * @returns A normalized identifier.
 */
function readExecutorIdentifier(value: string, code: string): string {
  const normalized = value.trim()
  if (!/^[a-zA-Z0-9#@._/-]{1,256}$/u.test(normalized)) {
    throw new TenantAdministrationError(400, code, 'Tenant operation identifier is invalid.')
  }
  return normalized
}
