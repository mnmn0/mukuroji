import { describe, expect, test } from 'bun:test'
import { listAnalyticsScheduleWeekdays } from '../src/analytics/model/scheduleWeekdays'

describe('weekly report delivery weekdays', () => {
  test('lists weekdays from the Workspace week start', () => {
    expect(listAnalyticsScheduleWeekdays(1).map((weekday) => weekday.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 0])
    expect(listAnalyticsScheduleWeekdays(0)[0]).toEqual({ dayOfWeek: 0, key: 'analytics.schedule.sunday' })
    expect(listAnalyticsScheduleWeekdays(6).at(-1)).toEqual({ dayOfWeek: 5, key: 'analytics.schedule.friday' })
  })

  test('starts on Sunday for an invalid week start', () => {
    expect(listAnalyticsScheduleWeekdays(9)[0]?.dayOfWeek).toBe(0)
  })
})
