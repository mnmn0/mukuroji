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

/** IAM-scoped direct-execution capability configured on one Lambda function. */
export type TenantOperationExecutionCapability = {
  /** Stable service identity recorded in lifecycle audit history. */
  executorId: string
  /** Workflow steps that the function ARN is allowed to complete or fail. */
  allowedSteps: readonly TenantOperationStepProof['step'][]
}

/**
 * Creates a runtime-controlled tenant operation execution boundary.
 *
 * @param getProcessor - Lazy trusted lifecycle processor resolver.
 * @param runtimeControl - Optional runtime-control replacements for tests.
 * @param directCapability - Optional IAM-bound direct execution capability.
 * @returns A handler accepting exactly one configured invocation mode.
 */
export function createTenantOperationExecutionEntrypoint(
  getProcessor: () => TenantOperationExecutionProcessor,
  runtimeControl: RuntimeControlGuardDependencies = {},
  directCapability?: TenantOperationExecutionCapability,
): TenantOperationExecutionHandler {
  return createRuntimeControlGuardedHandler(
    'tenant-operation-execution',
    async (event: unknown): Promise<unknown> => {
      const processor = getProcessor()
      if (isDynamoStreamEvent(event)) {
        if (directCapability) {
          throw new TenantAdministrationError(
            403,
            'TenantOperationStreamInvocationDenied',
            'This tenant operation capability does not accept stream events.',
          )
        }
        return await processTenantOperationExecutionBatch(event, processor)
      }
      if (!directCapability) {
        throw new TenantAdministrationError(
          403,
          'TenantOperationDirectInvocationDenied',
          'This tenant operation worker does not accept direct execution commands.',
        )
      }
      return await processor.execute(
        readDirectExecutionInput(event, directCapability),
      )
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
function readDirectExecutionInput(
  value: unknown,
  capability: TenantOperationExecutionCapability,
): ExecuteTenantOperationInput {
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
  const failureCode = value.failureCode === undefined
    ? undefined
    : readFailureCode(value.failureCode)
  if ((proof === undefined) === (failureCode === undefined)) {
    throw new TenantAdministrationError(
      400,
      'TenantOperationExecutionInputInvalid',
      'A tenant operation proof or failure code is required.',
    )
  }
  return {
    workspaceId: value.workspaceId,
    operationId: value.operationId,
    executorId: capability.executorId,
    allowedSteps: capability.allowedSteps,
    ...(proof ? { proof } : {}),
    ...(failureCode ? { failureCode } : {}),
  }
}

/**
 * Validates a stable non-sensitive failure code supplied by an executor.
 *
 * @param value - Candidate direct-command failure code.
 * @returns A normalized failure code.
 */
function readFailureCode(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(normalized)) {
    throw new TenantAdministrationError(
      400,
      'TenantOperationFailureCodeInvalid',
      'Tenant operation failure code is invalid.',
    )
  }
  return normalized
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

/** Returns true when every configured value is a tenant lifecycle step. */
function areTenantOperationSteps(
  values: string[],
): values is TenantOperationStepProof['step'][] {
  return values.every(isTenantOperationStep)
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

const getProductionCapabilityHandler = createLazySingleton(() =>
  createTenantOperationExecutionEntrypoint(
    getProductionProcessor,
    {},
    readConfiguredExecutionCapability(),
  )
)

/** IAM-scoped direct proof and failure entrypoint used by capability functions. */
export const capabilityHandler: TenantOperationExecutionHandler = async (event) =>
  await getProductionCapabilityHandler()(event)

/**
 * Reads the immutable capability binding injected into one Lambda function.
 *
 * @returns A validated executor identity and non-empty step set.
 */
function readConfiguredExecutionCapability(): TenantOperationExecutionCapability {
  const executorId = process.env.TENANT_OPERATION_EXECUTOR_ID?.trim() ?? ''
  const allowedSteps = (process.env.TENANT_OPERATION_ALLOWED_STEPS ?? '')
    .split(',')
    .map((step) => step.trim())
    .filter((step) => step.length > 0)
  if (
    !/^executor:[a-zA-Z0-9._/-]{1,119}$/u.test(executorId) ||
    allowedSteps.length === 0 ||
    new Set(allowedSteps).size !== allowedSteps.length ||
    !areTenantOperationSteps(allowedSteps)
  ) {
    throw new TenantAdministrationError(
      503,
      'TenantOperationCapabilityConfigurationInvalid',
      'Tenant operation capability configuration is invalid.',
    )
  }
  return { executorId, allowedSteps }
}
