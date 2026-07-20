import type {
  BatchResponse,
  DynamoStreamEvent,
  DynamoStreamRecord,
} from '../../../../infrastructure/aws/dynamodb-stream'

/**
 * Enterprise identity CONTROL stream processor の dependency です。
 */
export type EnterpriseIdentityMaintenanceProcessor = {
  /** 一つの Workspace の active generation chain を保守します。 */
  maintainWorkspace(workspaceId: string): Promise<unknown>
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
