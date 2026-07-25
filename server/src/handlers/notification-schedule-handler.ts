import {
  createProductionNotificationScheduleHandler,
} from '../app/composition/notification-schedule'
import { createLazySingleton } from '../app/composition/lazy-singleton'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import type {
  NotificationScheduleEvent,
} from '../modules/notifications/adapter-in/schedules/notification-schedule'

const getProductionHandler = createLazySingleton(
  createProductionNotificationScheduleHandler,
)

/**
 * Processes an admitted Work Item due-date notification schedule event.
 *
 * @param event - Optional EventBridge schedule time override.
 * @returns The notification schedule processing summary.
 */
async function processNotificationSchedule(
  event: NotificationScheduleEvent = {},
) {
  return await getProductionHandler()(event)
}

/**
 * Runtime-control guarded Notification schedule entrypoint.
 *
 * @param event - Optional EventBridge schedule time override.
 * @returns The notification schedule processing summary.
 */
export const handler = createRuntimeControlGuardedHandler(
  'notification-schedule',
  processNotificationSchedule,
)

export * from '../modules/notifications/adapter-in/schedules/notification-schedule'
