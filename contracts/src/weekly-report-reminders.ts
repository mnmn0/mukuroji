/** One weekly local time, in the Workspace time zone, at which a weekly report notice goes out. */
export type WeeklyReportReminderSlot = {
  /** Local weekday, 0 (Sunday) to 6 (Saturday). */
  weekday: number
  /** Local hour, 0 to 23. Notices are sent by an hourly schedule, so there are no minutes. */
  hour: number
}

/** Workspace settings that decide whether and when unsubmitted weekly reports are reminded. */
export type WeeklyReportReminderSettings = {
  /** Whether authors of unsubmitted reports are reminded at all. */
  enabled: boolean
  /** When the author is reminded; the reminder is about the week that contains this day. */
  reminder: WeeklyReportReminderSlot
  /** Whether the author's Project managers are told when the report is still unsubmitted. */
  escalationEnabled: boolean
  /** When the managers are told, about the week of the most recent reminder. */
  escalation: WeeklyReportReminderSlot
}

/** Settings of a Workspace that has not chosen its own: Friday 17:00 and Monday 10:00. */
export const DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS: WeeklyReportReminderSettings = {
  enabled: true,
  reminder: { weekday: 5, hour: 17 },
  escalationEnabled: true,
  escalation: { weekday: 1, hour: 10 },
}

/**
 * Validates one weekly slot.
 *
 * @param value - Untrusted slot.
 * @returns The slot, or undefined when the weekday or hour is invalid.
 */
function readWeeklyReportReminderSlot(value: unknown): WeeklyReportReminderSlot | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const weekday: unknown = Reflect.get(value, 'weekday')
  const hour: unknown = Reflect.get(value, 'hour')
  if (
    typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
    typeof hour !== 'number' || !Number.isInteger(hour) || hour < 0 || hour > 23
  ) {
    return undefined
  }
  return { weekday, hour }
}

/**
 * Validates weekly report reminder settings.
 *
 * Both slots are kept even while turned off, so turning one on again restores its time. When both
 * are on they must not be the same hour.
 *
 * @param value - Untrusted settings.
 * @returns The settings, or undefined when any field is invalid.
 */
export function readWeeklyReportReminderSettings(value: unknown): WeeklyReportReminderSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const enabled: unknown = Reflect.get(value, 'enabled')
  const escalationEnabled: unknown = Reflect.get(value, 'escalationEnabled')
  const reminder = readWeeklyReportReminderSlot(Reflect.get(value, 'reminder'))
  const escalation = readWeeklyReportReminderSlot(Reflect.get(value, 'escalation'))
  if (typeof enabled !== 'boolean' || typeof escalationEnabled !== 'boolean' || !reminder || !escalation) {
    return undefined
  }
  if (
    enabled && escalationEnabled &&
    reminder.weekday === escalation.weekday && reminder.hour === escalation.hour
  ) {
    return undefined
  }
  return { enabled, reminder, escalationEnabled, escalation }
}
