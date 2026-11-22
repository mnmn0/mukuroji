/** Weekday label keys of the delivery schedule, indexed the way `Date#getDay()` numbers weekdays. */
const analyticsScheduleWeekdayKeys = [
  'analytics.schedule.sunday',
  'analytics.schedule.monday',
  'analytics.schedule.tuesday',
  'analytics.schedule.wednesday',
  'analytics.schedule.thursday',
  'analytics.schedule.friday',
  'analytics.schedule.saturday',
] as const

/** One weekday choice of a weekly report delivery. */
export type AnalyticsScheduleWeekday = {
  /** Weekday as `Date#getDay()` numbers it: 0 is Sunday. */
  dayOfWeek: number
  /** Message key of the weekday's label. */
  key: (typeof analyticsScheduleWeekdayKeys)[number]
}

/**
 * Lists the weekdays a weekly delivery can go out on, starting from the Workspace week start, so
 * the choices read in the same order as the Workspace week.
 *
 * @param weekStartDay - First weekday of the Workspace week, from 0 (Sunday) to 6; other values
 *   start the list on Sunday.
 * @returns All seven weekdays in Workspace week order.
 */
export function listAnalyticsScheduleWeekdays(weekStartDay: number): AnalyticsScheduleWeekday[] {
  const start = Number.isInteger(weekStartDay) && weekStartDay >= 0 && weekStartDay <= 6 ? weekStartDay : 0
  return analyticsScheduleWeekdayKeys.map((_, offset) => {
    const dayOfWeek = (start + offset) % 7
    return { dayOfWeek, key: analyticsScheduleWeekdayKeys[dayOfWeek] ?? 'analytics.schedule.sunday' }
  })
}
