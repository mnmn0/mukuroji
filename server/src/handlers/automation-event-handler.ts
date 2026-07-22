import {
  createProductionAutomationEventHandler,
} from '../app/composition/automation-workers'
import {
  type BatchResponse,
  type DynamoStreamEvent,
} from '../modules/automation/adapter-in/events/automation-event'

let productionHandler: ReturnType<typeof createProductionAutomationEventHandler> | undefined

/**
 * Delivers Audit event stream records to version-pinned Automation executions.
 *
 * @param event - DynamoDB stream batch.
 * @returns Partial batch failure information.
 */
export async function handler(event: DynamoStreamEvent): Promise<BatchResponse> {
  productionHandler ??= createProductionAutomationEventHandler()
  return await productionHandler(event)
}

export * from '../modules/automation/adapter-in/events/automation-event'
