import {
  createProductionAutomationEventHandler,
} from '../app/composition/automation-workers'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  type BatchResponse,
  type DynamoStreamEvent,
} from '../modules/automation'

const getProductionHandler = createLazySingleton(
  createProductionAutomationEventHandler,
)

/**
 * Delivers an admitted Audit event batch to version-pinned Automation executions.
 *
 * @param event - DynamoDB stream batch.
 * @returns Partial batch failure information.
 */
async function processAutomationEvent(
  event: DynamoStreamEvent,
): Promise<BatchResponse> {
  return await getProductionHandler()(event)
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
  type CustomerCompletionNotificationPreparation,
  type AutomationWorkItemReader,
  type BatchResponse,
  type DynamoStreamEvent,
} from '../modules/automation'
