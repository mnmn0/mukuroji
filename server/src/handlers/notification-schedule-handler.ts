import {
  createProductionNotificationScheduleHandler,
} from '../app/composition/notification-schedule'
import {
  createRuntimeControlGuardedHandler,
} from '../app/composition/runtime-control'
import type {
  NotificationScheduleEvent,
} from '../modules/notifications/adapter-in/schedules/notification-schedule'

let productionHandler:
  | ReturnType<typeof createProductionNotificationScheduleHandler>
  | undefined

/**
 * Processes an admitted Work Item due-date notification schedule event.
 *
 * @param event - Optional EventBridge schedule time override.
 * @returns The notification schedule processing summary.
 */
async function processNotificationSchedule(
  event: NotificationScheduleEvent = {},
) {
  productionHandler ??= createProductionNotificationScheduleHandler()
  return await productionHandler(event)
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
