import {
  processAuditProjectionBatch,
} from '../modules/audit/adapter-in/events/audit-projection'
import {
  handler as processCollaborationProjection,
} from './collaboration-projection-handler'
import {
  createProductionWebhookProjectionHandler,
} from '../app/composition/webhook'
import {
  auditProjectionHandler as processConnectorProjection,
} from './connector-handler'
import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../infrastructure/aws/dynamodb-stream'

let webhookProjectionHandler:
  | ReturnType<typeof createProductionWebhookProjectionHandler>
  | undefined

/** AuditEvents stream を全 downstream projection へ fan-out します。 */
export async function handler(event: DynamoStreamEvent): Promise<BatchResponse> {
  webhookProjectionHandler ??= createProductionWebhookProjectionHandler()
  return await processAuditProjectionBatch(event, [
    processCollaborationProjection,
    webhookProjectionHandler,
    processConnectorProjection,
  ])
}

export * from '../modules/audit/adapter-in/events/audit-projection'
