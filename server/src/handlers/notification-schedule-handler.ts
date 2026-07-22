import {
  createProductionNotificationScheduleHandler,
} from '../app/composition/notification-schedule'

/** Production handler for canonical Work Item due-date notifications. */
export const handler = createProductionNotificationScheduleHandler()

export * from '../modules/notifications/adapter-in/schedules/notification-schedule'
