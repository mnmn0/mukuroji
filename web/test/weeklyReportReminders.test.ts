import { expect, test } from 'bun:test'
import { DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS } from '@mukuroji/contracts'
import { hasWeeklyReportReminderConflict } from '../src/workspace/model/weeklyReportReminders'

test('flags the same weekday and hour only while both weekly report notices are on', () => {
  const same = { ...DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS, escalation: { weekday: 5, hour: 17 } }
  expect(hasWeeklyReportReminderConflict(DEFAULT_WEEKLY_REPORT_REMINDER_SETTINGS)).toBe(false)
  expect(hasWeeklyReportReminderConflict(same)).toBe(true)
  expect(hasWeeklyReportReminderConflict({ ...same, escalationEnabled: false })).toBe(false)
  expect(hasWeeklyReportReminderConflict({ ...same, enabled: false })).toBe(false)
  expect(hasWeeklyReportReminderConflict({ ...same, escalation: { weekday: 5, hour: 18 } })).toBe(false)
})
