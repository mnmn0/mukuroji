import { describe, expect, test } from 'bun:test'
import {
  applyWorkCalendarOverrides,
  haveSameWorkCalendarRules,
  isEmptyWorkCalendarOverrides,
  readWorkCalendarOverrides,
  resolveSharedWorkItemCalendarPolicy,
  WORK_CALENDAR_MAX_ADDITIONAL_HOLIDAYS,
} from '../src/work-calendars'
import { DEFAULT_WORKSPACE_CALENDAR_SETTINGS, type WorkspaceCalendarSettings } from '../src/workspace-calendar'

/** Workspace settings without national holidays, so the expected days off are short. */
const workspace: WorkspaceCalendarSettings = {
  ...DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  holidays: ['2026-12-30'],
  publicHolidays: 'none',
}

describe('readWorkCalendarOverrides', () => {
  test('sorts weekdays and holidays and treats missing fields as inherited', () => {
    expect(readWorkCalendarOverrides({})).toEqual({ additionalHolidays: [] })
    expect(readWorkCalendarOverrides({
      workingWeekdays: ['friday', 'monday', 'monday'],
      publicHolidays: 'none',
      additionalHolidays: ['2026-12-29', '2026-12-28', '2026-12-29'],
    })).toEqual({
      workingWeekdays: ['monday', 'friday'],
      publicHolidays: 'none',
      additionalHolidays: ['2026-12-28', '2026-12-29'],
    })
  })

  test('rejects unknown fields, empty weekdays, invalid dates, and too many holidays', () => {
    expect(readWorkCalendarOverrides({ timeZone: 'UTC' })).toBeUndefined()
    expect(readWorkCalendarOverrides({ workingWeekdays: [] })).toBeUndefined()
    expect(readWorkCalendarOverrides({ additionalHolidays: ['2026-02-30'] })).toBeUndefined()
    expect(readWorkCalendarOverrides({ publicHolidays: 'usa' })).toBeUndefined()
    const many = Array.from({ length: WORK_CALENDAR_MAX_ADDITIONAL_HOLIDAYS + 1 }, (_, index) =>
      new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10))
    expect(readWorkCalendarOverrides({ additionalHolidays: many })).toBeUndefined()
  })
})

describe('resolveSharedWorkItemCalendarPolicy', () => {
  test('lets the Project override the Team and adds every layer\'s days off', () => {
    const settings = applyWorkCalendarOverrides(workspace, [
      { workingWeekdays: ['monday', 'tuesday', 'wednesday'], additionalHolidays: ['2026-12-28'] },
      { workingWeekdays: ['monday'], additionalHolidays: ['2026-12-29'] },
    ])
    expect(settings.workingWeekdays).toEqual(['monday'])
    expect(settings.holidays).toEqual(['2026-12-28', '2026-12-29', '2026-12-30'])
    expect(resolveSharedWorkItemCalendarPolicy(workspace, [undefined, undefined])).toEqual({
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: ['2026-12-30'],
      calendarSource: 'shared',
    })
  })

  test('compares rules without the calendar source', () => {
    const shared = resolveSharedWorkItemCalendarPolicy(workspace, [])
    const own = { timeZone: shared.timeZone, workingWeekdays: shared.workingWeekdays, holidays: shared.holidays }
    expect(haveSameWorkCalendarRules(shared, own)).toBe(true)
    expect(haveSameWorkCalendarRules(shared, { ...own, holidays: [] })).toBe(false)
    expect(isEmptyWorkCalendarOverrides({ additionalHolidays: [] })).toBe(true)
    expect(isEmptyWorkCalendarOverrides({ publicHolidays: 'none', additionalHolidays: [] })).toBe(false)
  })
})
