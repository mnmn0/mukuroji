import {
  createProductionAutomationScheduleHandler,
} from '../app/composition/automation-workers'
import {
  type AutomationScheduleEvent,
} from '../modules/automation/adapter-in/schedules/automation-schedule'

let productionHandler: ReturnType<typeof createProductionAutomationScheduleHandler> | undefined

/**
 * Materializes due Automation work according to timezone and DST policy.
 *
 * @param event - Automation schedule invocation event.
 * @returns The Automation schedule result.
 */
export async function handler(event: AutomationScheduleEvent = {}) {
  productionHandler ??= createProductionAutomationScheduleHandler()
  return await productionHandler(event)
}

export * from '../modules/automation/adapter-in/schedules/automation-schedule'
