import {
  processAuditProjectionBatch,
} from '../modules/audit/adapter-in/events/audit-projection'
import {
  handler as processCollaborationProjection,
} from '../modules/collaboration/adapter-in/events/collaboration-projection'
import {
  projectionHandler as processWebhookProjection,
} from '../modules/developer-platform/adapter-in/events/webhook-processing'
import {
  auditProjectionHandler as processConnectorProjection,
} from './connector-handler'
import type {
  BatchResponse,
  DynamoStreamEvent,
} from '../infrastructure/aws/dynamodb-stream'

/** AuditEvents stream を全 downstream projection へ fan-out します。 */
export async function handler(event: DynamoStreamEvent): Promise<BatchResponse> {
  return await processAuditProjectionBatch(event, [
    processCollaborationProjection,
    processWebhookProjection,
    processConnectorProjection,
  ])
}

export * from '../modules/audit/adapter-in/events/audit-projection'
