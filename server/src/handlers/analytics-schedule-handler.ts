import {
  createProductionAnalyticsScheduleHandler,
} from '../app/composition/analytics-schedule'
import {
  type AnalyticsScheduleEvent,
} from '../modules/analytics/adapter-in/schedules/analytics-schedule'

let productionHandler: ReturnType<typeof createProductionAnalyticsScheduleHandler> | undefined

/**
 * Processes due Analytics reports from EventBridge.
 *
 * @param event - Analytics schedule invocation event.
 * @returns The Analytics schedule batch result.
 */
export async function handler(event: AnalyticsScheduleEvent = {}) {
  productionHandler ??= createProductionAnalyticsScheduleHandler()
  return await productionHandler(event)
}

export * from '../modules/analytics/adapter-in/schedules/analytics-schedule'
