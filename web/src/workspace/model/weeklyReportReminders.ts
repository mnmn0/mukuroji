import type { WeeklyReportReminderSettings } from '@mukuroji/contracts'

/**
 * Tells whether both notices are on in the same weekday and hour, which the server rejects.
 *
 * @param settings - Settings being edited.
 * @returns Whether the two slots collide.
 */
export function hasWeeklyReportReminderConflict(settings: WeeklyReportReminderSettings): boolean {
  return settings.enabled && settings.escalationEnabled &&
    settings.reminder.weekday === settings.escalation.weekday &&
    settings.reminder.hour === settings.escalation.hour
}
