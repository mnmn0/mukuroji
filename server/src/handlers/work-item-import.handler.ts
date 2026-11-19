import {
  createProductionWorkItemImportHandler,
} from '../app/composition/work-item-import'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  createWorkerSecretEnvironmentHydrator,
} from '../app/composition/worker-secret-environment'
import type {
  WorkItemImportSqsEvent,
} from '../modules/work-items/work-item-import'

const hydrateSecrets = createWorkerSecretEnvironmentHydrator([
  'ENTERPRISE_IDENTITY_TOKEN_HASH_SECRET',
])

let productionHandler:
  | ReturnType<typeof createProductionWorkItemImportHandler>
  | undefined

/**
 * Processes one admitted Work Item import SQS batch.
 *
 * @param event - Work Item import SQS batch.
 * @returns The partial-batch response containing retryable record identifiers.
 */
async function processWorkItemImport(event: WorkItemImportSqsEvent) {
  await hydrateSecrets()
  productionHandler ??= createProductionWorkItemImportHandler()
  return await productionHandler(event)
}

/**
 * Runtime-control guarded Work Item import SQS entrypoint.
 *
 * @param event - Work Item import SQS batch.
 * @returns The partial-batch response containing retryable record identifiers.
 */
export const workItemImportHandler = createRuntimeControlGuardedHandler(
  'work-item-import',
  processWorkItemImport,
)
