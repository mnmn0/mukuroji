import type { TenantOperationStepProof } from '@mukuroji/contracts'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import { createProductionTenantOperationExecutor } from '../app/composition/tenant-operation-execution'
import {
  createRuntimeControlGuardedHandler,
  type RuntimeControlGuardDependencies,
} from '../app/composition/runtime-control'
import type { DynamoStreamEvent } from '../infrastructure/aws/dynamodb-stream'
import {
  processTenantOperationExecutionBatch,
  type TenantOperationExecutionProcessor,
} from '../modules/tenant-administration/adapter-in/events/tenant-operation-execution'
import {
  TenantAdministrationError,
  validateTenantOperationEvidenceReference,
  type ExecuteTenantOperationInput,
} from '../modules/tenant-administration'

/** Internal Lambda entrypoint accepted by stream and proof-producing executors. */
export type TenantOperationExecutionHandler = (event: unknown) => Promise<unknown>

/**
 * Creates a runtime-controlled tenant operation execution boundary.
 *
 * @param getProcessor - Lazy trusted lifecycle processor resolver.
 * @param runtimeControl - Optional runtime-control replacements for tests.
 * @returns A handler accepting durable stream starts and direct evidence commands.
 */
export function createTenantOperationExecutionEntrypoint(
  getProcessor: () => TenantOperationExecutionProcessor,
  runtimeControl: RuntimeControlGuardDependencies = {},
): TenantOperationExecutionHandler {
  return createRuntimeControlGuardedHandler(
    'tenant-operation-execution',
    async (event: unknown): Promise<unknown> => {
      const processor = getProcessor()
      if (isDynamoStreamEvent(event)) {
        return await processTenantOperationExecutionBatch(event, processor)
      }
      return await processor.execute(readDirectExecutionInput(event))
    },
    runtimeControl,
  )
}

/** Returns true when an invocation has the DynamoDB stream event shape. */
function isDynamoStreamEvent(value: unknown): value is DynamoStreamEvent {
  return isRecord(value) && Array.isArray(value.Records)
}

/**
 * Validates a direct evidence command received through IAM-authorized invocation.
 *
 * @param value - Untrusted direct Lambda invocation payload.
 * @returns A normalized trusted executor command.
 */
function readDirectExecutionInput(value: unknown): ExecuteTenantOperationInput {
  if (
    !isRecord(value) ||
    typeof value.workspaceId !== 'string' ||
    typeof value.operationId !== 'string'
  ) {
    throw new TenantAdministrationError(
      400,
      'TenantOperationExecutionInputInvalid',
      'Tenant operation execution input is invalid.',
    )
  }
  const proof = value.proof === undefined ? undefined : readStepProof(value.proof)
  return {
    workspaceId: value.workspaceId,
    operationId: value.operationId,
    executorId: 'executor:tenant-operation-capability',
    ...(proof ? { proof } : {}),
  }
}

/**
 * Validates immutable evidence supplied by a capability executor.
 *
 * @param value - Candidate step proof.
 * @returns A validated step proof.
 */
function readStepProof(value: unknown): TenantOperationStepProof {
  if (
    !isRecord(value) ||
    !isTenantOperationStep(value.step) ||
    typeof value.evidenceReference !== 'string'
  ) {
    throw new TenantAdministrationError(
      400,
      'TenantOperationStepProofInvalid',
      'Tenant operation step proof is invalid.',
    )
  }
  return {
    step: value.step,
    evidenceReference: validateTenantOperationEvidenceReference(
      value.evidenceReference,
    ),
  }
}

/** Returns true when a value is one bounded tenant lifecycle step. */
function isTenantOperationStep(
  value: unknown,
): value is TenantOperationStepProof['step'] {
  return value === 'snapshot' ||
    value === 'prepare-artifact' ||
    value === 'verify-artifact' ||
    value === 'export' ||
    value === 'revoke-access' ||
    value === 'anonymize-members' ||
    value === 'delete-data' ||
    value === 'delete-secrets' ||
    value === 'verify'
}

/** Returns true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getProductionProcessor = createLazySingleton(
  createProductionTenantOperationExecutor,
)

/** Runtime-controlled tenant operation stream and evidence entrypoint. */
export const handler = createTenantOperationExecutionEntrypoint(
  getProductionProcessor,
)
