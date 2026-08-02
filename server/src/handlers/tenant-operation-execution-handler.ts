import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  createProductionTenantOperationExecutor,
  createProductionTenantOperationResourceOwner,
} from '../app/composition/tenant-operation-execution'
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
  processTenantOperationResourceOwnerBatch,
  type TenantOperationResourceOwnerProcessor,
  type TenantOperationSqsEvent,
} from '../modules/tenant-administration/adapter-in/events/tenant-operation-resource-owner'
import { TenantAdministrationError } from '../modules/tenant-administration'

/** Internal Lambda entrypoint accepted by stream and queued resource owners. */
export type TenantOperationExecutionHandler = (event: unknown) => Promise<unknown>

/**
 * Creates a runtime-controlled tenant operation execution boundary.
 *
 * @param getProcessor - Lazy trusted lifecycle processor resolver.
 * @param runtimeControl - Optional runtime-control replacements for tests.
 * @returns A handler accepting only DynamoDB stream events.
 */
export function createTenantOperationExecutionEntrypoint(
  getProcessor: () => TenantOperationExecutionProcessor,
  runtimeControl: RuntimeControlGuardDependencies = {},
): TenantOperationExecutionHandler {
  return createRuntimeControlGuardedHandler(
    'tenant-operation-execution',
    async (event: unknown): Promise<unknown> => {
      if (!isDynamoStreamEvent(event)) {
        throw new TenantAdministrationError(
          403,
          'TenantOperationDirectInvocationDenied',
          'This tenant operation worker does not accept direct execution commands.',
        )
      }
      return await processTenantOperationExecutionBatch(
        event,
        getProcessor(),
      )
    },
    runtimeControl,
  )
}

/** Returns true when an invocation has the DynamoDB stream event shape. */
function isDynamoStreamEvent(value: unknown): value is DynamoStreamEvent {
  return isRecord(value) && Array.isArray(value.Records)
}

/** Returns true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const getProductionProcessor = createLazySingleton(
  createProductionTenantOperationExecutor,
)

/** Runtime-controlled tenant operation stream-dispatch entrypoint. */
export const handler = createTenantOperationExecutionEntrypoint(
  getProductionProcessor,
)

const getProductionResourceOwner = createLazySingleton(
  createProductionTenantOperationResourceOwner,
)

/**
 * Creates a runtime-controlled SQS resource-owner boundary.
 *
 * @param getProcessor - Lazy capability-isolated owner resolver.
 * @param runtimeControl - Optional runtime-control replacements for tests.
 * @returns A handler accepting only SQS resource-owner records.
 */
export function createTenantOperationResourceOwnerEntrypoint(
  getProcessor: () => TenantOperationResourceOwnerProcessor,
  runtimeControl: RuntimeControlGuardDependencies = {},
): TenantOperationExecutionHandler {
  return createRuntimeControlGuardedHandler(
    'tenant-operation-execution',
    async (event: unknown): Promise<unknown> => {
      if (!isSqsEvent(event)) {
        throw new TenantAdministrationError(
          403,
          'TenantOperationResourceOwnerInvocationDenied',
          'Tenant operation resource owners accept only SQS events.',
        )
      }
      return await processTenantOperationResourceOwnerBatch(
        event,
        getProcessor(),
      )
    },
    runtimeControl,
  )
}

/** Capability-isolated SQS resource owner that performs one bounded page. */
export const resourceOwnerHandler = createTenantOperationResourceOwnerEntrypoint(
  getProductionResourceOwner,
)

/** Returns true for the minimal SQS event shape accepted by resource owners. */
function isSqsEvent(value: unknown): value is TenantOperationSqsEvent {
  return isRecord(value) && Array.isArray(value.Records)
}
