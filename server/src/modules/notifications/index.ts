/** Notifications module public application and domain surface. */
export {
  NOTIFICATION_PREFERENCES_KEY,
  NotificationError,
  createNotificationDeliveryPlan,
  createNotificationRecipientKey,
  parseStoredNotificationPreferences,
  requiresCurrentWorkItemAssignee,
  requiresCurrentWorkItemContributor,
  isSlackNotificationEligible,
  isEmailNotificationEligible,
  isNotificationRoutedToChannel,
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
/** Exposes how one notification is routed to channels for one member. */
export {
  classifyNotificationCategory,
  resolveNotificationRouting,
  type NotificationRoutingSubject,
} from './domain/notification-routing'
/** Exposes the deterministic shard key used when queuing Slack notifications. */
export { slackDeliveryShard } from './domain/slack-delivery'
/** Exposes the application workflow that delivers due Slack notifications. */
export { deliverDueSlackNotifications } from './application/slack-delivery'
/** Exposes the deterministic shard key used when queuing Email notifications. */
export { emailDeliveryShard } from './domain/channel-delivery'
/** Exposes the application workflow that delivers due Email notifications. */
export { deliverDueEmailNotifications } from './application/email-delivery'
/** Exposes the shared delivery ports the Email composition implements. */
export type { ChannelDelivery, NotificationLocaleReader } from './application/channel-delivery'
/** Exposes the verified-address Email transport factory. */
export { createEmailNotificationSender, type EmailRecipientLookup } from './adapter-out/email/email-sender'
/** Exposes safe per-channel delivery logs and backlog metrics. */
export { createChannelDeliveryTelemetry } from './adapter-out/channel-delivery-telemetry'
/** Exposes the DynamoDB due queue for one external channel. */
export { DynamoDbChannelDeliveryStore } from './adapter-out/dynamodb/channel-delivery-store'
/** Exposes the Project manager reader port used by overdue escalation. */
export type { ScheduledProjectManagerReader } from './application/ports/project-manager-reader'
/** Exposes the Project Directory adapter that resolves overdue escalation managers. */
export { createDynamoDbProjectManagerReader } from './adapter-out/dynamodb/project-manager-reader'
export { createDynamoDbScheduledWorkItemSource } from './adapter-out/dynamodb/scheduled-work-item-source'
export type { ScheduledWorkItemSource } from './application/ports/scheduled-work-item-source'
/** Exposes the recipient-scoped Incoming Webhook transport factory. */
export { createSlackNotificationSender } from './adapter-out/slack/slack-sender'
/** Exposes safe Slack delivery logs and backlog metrics. */
export { createSlackDeliveryTelemetry } from './adapter-out/slack/slack-delivery-telemetry'
/** Exposes recipient-bound document visibility checks for external notifications. */
export { isDocumentDeliveryVisible, resolveDocumentDeliveryAccess, resolveNotificationRecipientBoundary } from './application/document-delivery'
/** Exposes the reminder override and unsubmitted time entry reader ports of the schedule. */
export type {
  ScheduledReminderSettingsReader,
  TeamReminderSettingsRecord,
  TeamReminderSettingsStore,
} from './application/ports/reminder-settings-reader'
export type { ScheduledTimesheetReader } from './application/ports/timesheet-reminder-reader'
export type { UnsubmittedTimeEntry } from './application/timesheet-reminders'
/** Exposes the weekly report reminder reader port and its Project Directory roster adapter. */
export type { ScheduledWeeklyReportReader } from './application/ports/weekly-report-reminder-reader'
export type { WeeklyReportTeamRoster } from './application/weekly-report-reminders'
export { createDynamoDbWeeklyReportRosterReader } from './adapter-out/dynamodb/weekly-report-roster-reader'
/** Exposes the member access expiry notice reader port and its Project Directory adapter. */
export type {
  ExpiringMemberProject,
  ExpiringWorkspaceMember,
  ScheduledMemberAccessExpiryReader,
} from './application/member-access-expiry-notices'
export { createDynamoDbMemberProjectReader } from './adapter-out/dynamodb/member-project-reader'
/** Exposes reminder override validation shared by HTTP adapters. */
export { normalizeTeamReminderDays } from './domain/reminder-days'
export {
  MEMBER_ACCESS_EXPIRING_EVENT_TYPE,
  MEMBER_ACCESS_EXPIRY_REASON,
  TIMESHEET_REMINDER_EVENT_TYPE,
  WEEKLY_REPORT_ESCALATION_EVENT_TYPE,
  WEEKLY_REPORT_ESCALATION_REASON,
  WEEKLY_REPORT_REMINDER_EVENT_TYPE,
  WEEKLY_REPORT_REMINDER_REASON,
  createNotificationScheduleHandler,
  readReminderPolicyDefaultsFromEnvironment,
  parsePlanningUpdateTargetScheduleProjection,
  type CustomerCompletionPreparation,
  type CustomerCompletionPreparationHandler,
  type PlanningScheduledNotificationKind,
  type PlanningUpdateNotificationCadence,
  type PlanningUpdateTargetReference,
  type PlanningUpdateTargetScheduleProjection,
} from './adapter-in/schedules/notification-schedule'
