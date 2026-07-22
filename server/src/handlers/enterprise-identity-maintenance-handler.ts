import {
  createProductionEnterpriseIdentityMaintenanceHandler,
} from '../app/composition/enterprise-identity-maintenance'
import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../infrastructure/aws/dynamodb-stream'

const processBatch = createProductionEnterpriseIdentityMaintenanceHandler()

/**
 * Passes Enterprise Identity control-stream records to the compaction worker.
 *
 * @param event - DynamoDB stream batch.
 * @returns Partial batch failure information.
 */
export async function handler(
  event: DynamoStreamEvent,
): Promise<BatchResponse> {
  return await processBatch(event)
}

export * from '../modules/enterprise-identity/adapter-in/events/identity-maintenance'
