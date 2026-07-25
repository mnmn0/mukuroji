import {
  createProductionAnalyticsScheduleHandler,
} from '../app/composition/analytics-schedule'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import {
  type AnalyticsScheduleEvent,
} from '../modules/analytics/adapter-in/schedules/analytics-schedule'

const getProductionHandler = createLazySingleton(
  createProductionAnalyticsScheduleHandler,
)

/**
 * Processes due Analytics reports after the runtime control admits the invocation.
 *
 * @param event - Analytics schedule invocation event.
 * @returns The Analytics schedule batch result.
 */
async function processAnalyticsSchedule(event: AnalyticsScheduleEvent = {}) {
  return await getProductionHandler()(event)
}

/**
 * Runtime-control guarded Analytics schedule entrypoint.
 *
 * @param event - Analytics schedule invocation event.
 * @returns The Analytics schedule batch result.
 */
export const handler = createRuntimeControlGuardedHandler(
  'analytics-schedule',
  processAnalyticsSchedule,
)

export * from '../modules/analytics/adapter-in/schedules/analytics-schedule'
