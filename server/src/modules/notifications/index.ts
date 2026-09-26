/** Notifications module public application and domain surface. */
export {
  NOTIFICATION_PREFERENCES_KEY,
  NotificationError,
  createNotificationDeliveryPlan,
  createNotificationRecipientKey,
  parseStoredNotificationPreferences,
  requiresCurrentWorkItemAssignee,
  isSlackNotificationEligible,
  toNotificationItem,
  type CountUnreadNotificationsInput,
  type ListNotificationsInput,
  type MarkAllNotificationsReadInput,
  type NotificationAction,
  type NotificationChannels,
  type NotificationClient,
  type NotificationDeliveryPlan,
  type NotificationFilter,
  type NotificationFrequency,
  type NotificationItem,
  type NotificationPage,
  type NotificationPreferences,
  type NotificationQuietHours,
  type NotificationRecipientInput,
  type NotificationState,
  type NotificationVisibilityFilter,
  type SaveNotificationPreferencesInput,
  type UpdateNotificationInput,
  type UpdateNotificationPreferencesInput,
} from './notifications'
/** Exposes the deterministic shard key used when queuing Slack notifications. */
export { slackDeliveryShard } from './domain/slack-delivery'
/** Exposes the application workflow that delivers due Slack notifications. */
export { deliverDueSlackNotifications } from './application/slack-delivery'
/** Exposes the recipient-scoped Incoming Webhook transport factory. */
export { createSlackNotificationSender } from './adapter-out/slack/slack-sender'
/** Exposes safe Slack delivery logs and backlog metrics. */
export { createSlackDeliveryTelemetry } from './adapter-out/slack/slack-delivery-telemetry'
/** Exposes recipient-bound document visibility checks for external notifications. */
export { isDocumentDeliveryVisible, resolveDocumentDeliveryAccess, resolveNotificationRecipientBoundary } from './application/document-delivery'
export {
  createNotificationScheduleHandler,
  parsePlanningUpdateTargetScheduleProjection,
  type CustomerCompletionPreparation,
  type CustomerCompletionPreparationHandler,
  type PlanningScheduledNotificationKind,
  type PlanningUpdateNotificationCadence,
  type PlanningUpdateTargetReference,
  type PlanningUpdateTargetScheduleProjection,
} from './adapter-in/schedules/notification-schedule'
