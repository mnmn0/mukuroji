import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  processEnterpriseIdentityMaintenanceBatch,
} from '../../modules/enterprise-identity/adapter-in/events/identity-maintenance'
import {
  DynamoDbEnterpriseIdentityMaintenanceClient,
} from '../../modules/enterprise-identity/enterprise-identity'
import type { DynamoStreamEvent } from '../../infrastructure/aws/dynamodb-stream'

/**
 * Creates the production Enterprise Identity maintenance handler.
 *
 * @returns A handler for Enterprise Identity control-stream batches.
 */
export function createProductionEnterpriseIdentityMaintenanceHandler() {
  const dynamoDbClient = new DynamoDBClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
  })
  const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
    marshallOptions: { removeUndefinedValues: true },
  })
  const client = new DynamoDbEnterpriseIdentityMaintenanceClient(
    process.env.ENTERPRISE_IDENTITY_TABLE_NAME ??
      'mukuroji-enterprise-identity',
    documentClient,
  )

  return (event: DynamoStreamEvent) =>
    processEnterpriseIdentityMaintenanceBatch(event, client)
}
