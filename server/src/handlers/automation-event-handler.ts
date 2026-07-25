import {
  createProductionAutomationEventHandler,
} from '../app/composition/automation-workers'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  type BatchResponse,
  type DynamoStreamEvent,
} from '../modules/automation'

let productionHandler: ReturnType<typeof createProductionAutomationEventHandler> | undefined

/**
 * Delivers an admitted Audit event batch to version-pinned Automation executions.
 *
 * @param event - DynamoDB stream batch.
 * @returns Partial batch failure information.
 */
async function processAutomationEvent(
  event: DynamoStreamEvent,
): Promise<BatchResponse> {
  productionHandler ??= createProductionAutomationEventHandler()
  return await productionHandler(event)
}

/**
 * Runtime-control guarded Automation event-stream entrypoint.
 *
 * @param event - DynamoDB stream batch.
 * @returns Partial batch failure information.
 */
export const handler = createRuntimeControlGuardedHandler(
  'automation-event',
  processAutomationEvent,
)

export {
  createAutomationEventProcessor,
  parseAutomationStreamRecord,
  processAutomationEventBatch,
  type AutomationEventPort,
  type AutomationEventProcessor,
  type AutomationWorkItemReader,
  type BatchResponse,
  type DynamoStreamEvent,
} from '../modules/automation'
