import {
  DynamoDbEnterpriseIdentityMaintenanceClient,
  processEnterpriseIdentityMaintenanceBatch,
} from '../../modules/enterprise-identity'
import type { DynamoStreamEvent } from '../../infrastructure/aws/dynamodb-stream'
import {
  createDynamoDbClient,
  createDynamoDbDocumentClient,
} from '../../infrastructure/aws/dynamodb-client'
import {
  loadServerDynamoDbResourceConfig,
} from '../../infrastructure/config/server-resource-config'

/**
 * Creates the production Enterprise Identity maintenance handler.
 *
 * @returns A handler for Enterprise Identity control-stream batches.
 */
export function createProductionEnterpriseIdentityMaintenanceHandler() {
  const resourceConfig = loadServerDynamoDbResourceConfig()
  const documentClient = createDynamoDbDocumentClient(createDynamoDbClient())
  const client = new DynamoDbEnterpriseIdentityMaintenanceClient(
    resourceConfig.enterpriseIdentityTableName,
    documentClient,
  )

  /**
   * Processes one Enterprise Identity control-stream batch.
   *
   * @param event - DynamoDB stream batch containing control-row changes.
   * @returns The partial-batch response for retryable records.
   */
  function handleEnterpriseIdentityMaintenance(event: DynamoStreamEvent) {
    return processEnterpriseIdentityMaintenanceBatch(event, client)
  }

  return handleEnterpriseIdentityMaintenance
}
