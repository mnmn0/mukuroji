import {
  createProductionNotificationScheduleHandler,
} from '../app/composition/notification-schedule'

/**
 * Processes a canonical Work Item due-date notification schedule event.
 *
 * @param event - Optional EventBridge schedule time override.
 * @returns The notification schedule processing summary.
 */
export const handler = createProductionNotificationScheduleHandler()

export * from '../modules/notifications/adapter-in/schedules/notification-schedule'
