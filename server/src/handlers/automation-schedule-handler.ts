import {
  createProductionAutomationScheduleHandler,
} from '../app/composition/automation-workers'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  type AutomationScheduleEvent,
} from '../modules/automation'

const getProductionHandler = createLazySingleton(
  createProductionAutomationScheduleHandler,
)

/**
 * Materializes admitted Automation work according to timezone and DST policy.
 *
 * @param event - Automation schedule invocation event.
 * @returns The Automation schedule result.
 */
async function processAutomationSchedule(event: AutomationScheduleEvent = {}) {
  return await getProductionHandler()(event)
}

/**
 * Runtime-control guarded Automation schedule entrypoint.
 *
 * @param event - Automation schedule invocation event.
 * @returns The Automation schedule result.
 */
export const handler = createRuntimeControlGuardedHandler(
  'automation-schedule',
  processAutomationSchedule,
)

export {
  processAutomationSchedule,
  processDueAutomationExecution,
  processInboundWebhookSecretCleanup,
  processRecurringWorkDefinition,
  processScheduledAutomationRule,
  resolveAutomationScheduleProcessingTime,
  type AutomationScheduleDependencies,
  type AutomationScheduleEvent,
  type AutomationSchedulePort,
} from '../modules/automation'
