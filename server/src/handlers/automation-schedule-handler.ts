import {
  createProductionAutomationScheduleHandler,
} from '../app/composition/automation-workers'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  type AutomationScheduleEvent,
} from '../modules/automation'

let productionHandler: ReturnType<typeof createProductionAutomationScheduleHandler> | undefined

/**
 * Materializes admitted Automation work according to timezone and DST policy.
 *
 * @param event - Automation schedule invocation event.
 * @returns The Automation schedule result.
 */
async function processAutomationSchedule(event: AutomationScheduleEvent = {}) {
  productionHandler ??= createProductionAutomationScheduleHandler()
  return await productionHandler(event)
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
