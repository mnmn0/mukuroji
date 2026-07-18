import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  BatchResponse,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from './collaboration-projection-handler'
import { DynamoDbEnterpriseIdentityMaintenanceClient } from './enterprise-identity'

/**
 * Enterprise identity CONTROL stream processor の dependency です。
 */
export type EnterpriseIdentityMaintenanceProcessor = {
  /** 一つの Workspace の active generation chain を保守します。 */
  maintainWorkspace(workspaceId: string): Promise<unknown>
}

const dynamoDbClient = new DynamoDBClient({
  region: process.env.AWS_REGION ?? 'us-east-1',
})
const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
})
const maintenanceClient = new DynamoDbEnterpriseIdentityMaintenanceClient(
  process.env.ENTERPRISE_IDENTITY_TABLE_NAME ?? 'mukuroji-enterprise-identity',
  documentClient,
)

/**
 * Enterprise identity CONTROL stream を非同期 compaction/retirement へ配送します。
 */
export async function handler(event: DynamoStreamEvent): Promise<BatchResponse> {
  return await processEnterpriseIdentityMaintenanceBatch(event, maintenanceClient)
}

/**
 * Stream batch を record 単位で処理し、失敗した checkpoint だけを再配送します。
 */
export async function processEnterpriseIdentityMaintenanceBatch(
  event: DynamoStreamEvent,
  processor: EnterpriseIdentityMaintenanceProcessor,
): Promise<BatchResponse> {
  for (const record of event.Records ?? []) {
    try {
      const workspaceId = readEnterpriseIdentityControlWorkspace(record)
      if (workspaceId) await processor.maintainWorkspace(workspaceId)
    } catch (error) {
      console.error('Enterprise identity maintenance failed:', error)
      const sequenceNumber = record.dynamodb?.SequenceNumber
      if (!sequenceNumber) throw error
      return {
        batchItemFailures: [{ itemIdentifier: sequenceNumber }],
      }
    }
  }
  return { batchItemFailures: [] }
}

/**
 * CONTROL の INSERT/MODIFY stream record から Workspace ID を検証して返します。
 */
export function readEnterpriseIdentityControlWorkspace(
  record: DynamoStreamRecord,
) {
  if (record.eventName !== 'INSERT' && record.eventName !== 'MODIFY') {
    return undefined
  }
  const image = record.dynamodb?.NewImage
  if (
    image?.entryType?.S !== 'enterprise-identity-control' ||
    image.recordKey?.S !== 'CONTROL' ||
    !image.workspaceId?.S ||
    image.scopeKey?.S !== `WORKSPACE#${image.workspaceId.S}`
  ) {
    return undefined
  }
  return image.workspaceId.S
}
