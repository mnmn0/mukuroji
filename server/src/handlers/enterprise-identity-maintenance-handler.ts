import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import {
  processEnterpriseIdentityMaintenanceBatch,
  type EnterpriseIdentityMaintenanceProcessor,
} from '../modules/enterprise-identity/adapter-in/events/identity-maintenance'
import {
  DynamoDbEnterpriseIdentityMaintenanceClient,
} from '../modules/enterprise-identity/enterprise-identity'
import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../infrastructure/aws/dynamodb-stream'

const dynamoDbClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
})
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const maintenanceClient: EnterpriseIdentityMaintenanceProcessor =
  new DynamoDbEnterpriseIdentityMaintenanceClient(
    process.env.ENTERPRISE_IDENTITY_TABLE_NAME ??
      'mukuroji-enterprise-identity',
    documentClient,
  )

/** Enterprise identity CONTROL stream を compaction worker へ渡します。 */
export async function handler(
  event: DynamoStreamEvent,
): Promise<BatchResponse> {
  return await processEnterpriseIdentityMaintenanceBatch(
    event,
    maintenanceClient,
  )
}

export * from '../modules/enterprise-identity/adapter-in/events/identity-maintenance'
