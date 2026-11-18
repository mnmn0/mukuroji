/**
 * Day thresholds the notification schedule uses for Work Item and timesheet reminders, in the
 * order they are shown in settings screens.
 */
export const NOTIFICATION_REMINDER_DAY_FIELDS = [
  'dueSoonDays',
  'overdueReminderIntervalDays',
  'overdueEscalationDays',
  'staleStartedDays',
  'timesheetReminderDays',
] as const

/** One day threshold of the notification reminder policy. */
export type NotificationReminderDayField = (typeof NOTIFICATION_REMINDER_DAY_FIELDS)[number]

/**
 * Thresholds a member may set for themselves. Overdue escalation notifies Project managers, so
 * only a Team manager sets it.
 */
export const PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS = [
  'dueSoonDays',
  'overdueReminderIntervalDays',
  'staleStartedDays',
  'timesheetReminderDays',
] as const

/** One day threshold a member may override for their own reminders. */
export type PersonalNotificationReminderDayField =
  (typeof PERSONAL_NOTIFICATION_REMINDER_DAY_FIELDS)[number]

/** Largest accepted value for any reminder day threshold. */
export const NOTIFICATION_REMINDER_DAYS_MAXIMUM = 365

/** Complete set of reminder day thresholds. */
export type NotificationReminderDays = {
  /** Days before the due date when the owner gets the due-soon notification. */
  dueSoonDays: number
  /** Interval in days between repeated overdue notifications to the owner. */
  overdueReminderIntervalDays: number
  /** Days past the due date after which Project managers are notified once. */
  overdueEscalationDays: number
  /** Days without an update after which a started Work Item's owner is reminded. */
  staleStartedDays: number
  /**
   * Days after a time entry ends before its owner is reminded to submit it. The reminder repeats
   * every this many days while draft or rejected entries remain.
   */
  timesheetReminderDays: number
}

/** Team overrides of the reminder thresholds; an omitted field uses the deployment default. */
export type TeamNotificationReminderDays = Partial<NotificationReminderDays>

/** A member's own overrides; an omitted field uses the Team setting, then the default. */
export type PersonalNotificationReminderDays = Partial<
  Pick<NotificationReminderDays, PersonalNotificationReminderDayField>
>

/** Team reminder settings returned by `GET /api/teams/:teamId/notification-reminders`. */
export type TeamNotificationReminderSettings = {
  /** Team the settings belong to. */
  teamId: string
  /** Thresholds the Team overrides. */
  days: TeamNotificationReminderDays
  /** Deployment defaults used for every field the Team leaves unset. */
  defaults: NotificationReminderDays
  /** Optimistic concurrency revision; 0 before the Team saves settings. */
  revision: number
  /** When the settings were last saved. */
  updatedAt?: string
  /** Whether the caller may change the settings (Team manager). */
  canManage: boolean
}

/** Body of `PUT /api/teams/:teamId/notification-reminders`. */
export type UpdateTeamNotificationReminderSettingsRequest = {
  /** Revision the caller read; a different stored revision is a conflict. */
  expectedRevision: number
  /** Complete replacement of the Team overrides; omit a field to use the default. */
  days: TeamNotificationReminderDays
}
