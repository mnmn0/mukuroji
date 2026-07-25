import {
  createProductionEnterpriseIdentityMaintenanceHandler,
} from '../app/composition/enterprise-identity-maintenance'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../infrastructure/aws/dynamodb-stream'

let productionHandler:
  | ReturnType<typeof createProductionEnterpriseIdentityMaintenanceHandler>
  | undefined

/**
 * Passes an admitted Enterprise Identity control-stream batch to the worker.
 *
 * @param event - DynamoDB stream batch.
 * @returns Partial batch failure information.
 */
async function processEnterpriseIdentityMaintenance(
  event: DynamoStreamEvent,
): Promise<BatchResponse> {
  productionHandler ??= createProductionEnterpriseIdentityMaintenanceHandler()
  return await productionHandler(event)
}

/**
 * Runtime-control guarded Enterprise Identity maintenance entrypoint.
 *
 * @param event - DynamoDB stream batch.
 * @returns Partial batch failure information.
 */
export const handler = createRuntimeControlGuardedHandler(
  'enterprise-identity-maintenance',
  processEnterpriseIdentityMaintenance,
)

export * from '../modules/enterprise-identity/adapter-in/events/identity-maintenance'
