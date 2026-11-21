import { describe, expect, test } from 'bun:test'
import {
  JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR,
  japanesePublicHolidayYears,
  listJapanesePublicHolidays,
} from '../src/japanese-public-holidays'
import { createWorkspaceWorkItemCalendarPolicy } from '../src/work-items'
import {
  DEFAULT_WORKSPACE_CALENDAR_SETTINGS,
  WORKSPACE_CALENDAR_MAX_HOLIDAYS,
  WORKSPACE_NATIONAL_HOLIDAY_DATES_MAX,
  listWorkspaceDaysOff,
  readWorkspaceCalendarSettings,
  readWorkspaceNationalHolidayDates,
} from '../src/workspace-calendar'

/** Milliseconds in one UTC day. */
const DAY = 86_400_000

/**
 * Formats a UTC-midnight epoch as a `YYYY-MM-DD` date.
 *
 * @param epoch - Epoch milliseconds at UTC midnight.
 * @returns The calendar date.
 */
function isoDate(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10)
}

/**
 * Finds the nth Monday of a month.
 *
 * @param year - Calendar year.
 * @param month - Month from 1 to 12.
 * @param nth - Which Monday, from 1.
 * @returns The Monday as a UTC-midnight epoch.
 */
function nthMonday(year: number, month: number, nth: number): number {
  const first = Date.UTC(year, month - 1, 1)
  const weekday = new Date(first).getUTCDay()
  return first + (((8 - weekday) % 7) + 7 * (nth - 1)) * DAY
}

/**
 * Derives a year's days off independently from the Act on National Holidays, so a typo in the
 * bundled data fails the test. Equinox days use the long-standing approximation that matches the
 * 暦要項 for 1980 to 2099.
 *
 * @param year - Calendar year from 2020 onward with the current Article 2 holidays.
 * @returns Every day off of the year, sorted.
 */
function deriveJapaneseDaysOff(year: number): string[] {
  const offset = year - 1980
  const vernal = Math.floor(20.8431 + 0.242194 * offset - Math.floor(offset / 4))
  const autumnal = Math.floor(23.2488 + 0.242194 * offset - Math.floor(offset / 4))
  const date = (month: number, day: number) => Date.UTC(year, month - 1, day)
  const holidays = new Set([
    date(1, 1), nthMonday(year, 1, 2), date(2, 11), date(2, 23), date(3, vernal), date(4, 29),
    date(5, 3), date(5, 4), date(5, 5), nthMonday(year, 7, 3), date(8, 11), nthMonday(year, 9, 3),
    date(9, autumnal), nthMonday(year, 10, 2), date(11, 3), date(11, 23),
  ].map(isoDate))
  const daysOff = new Set(holidays)
  for (const holiday of holidays) {
    const epoch = Date.parse(`${holiday}T00:00:00.000Z`)
    if (new Date(epoch).getUTCDay() !== 0) continue
    let substitute = epoch + DAY
    while (daysOff.has(isoDate(substitute))) substitute += DAY
    daysOff.add(isoDate(substitute))
  }
  for (let epoch = date(1, 2); epoch < date(12, 31); epoch += DAY) {
    if (
      !daysOff.has(isoDate(epoch)) &&
      new Date(epoch).getUTCDay() !== 0 &&
      holidays.has(isoDate(epoch - DAY)) &&
      holidays.has(isoDate(epoch + DAY))
    ) {
      daysOff.add(isoDate(epoch))
    }
  }
  return [...daysOff].sort()
}

describe('Japanese public holidays', () => {
  test('bundles every day off the Act on National Holidays gives for each bundled year', () => {
    const { first, last } = japanesePublicHolidayYears()
    expect(first).toBe(2024)
    expect(last).toBeGreaterThanOrEqual(2027)
    for (let year = first; year <= last; year += 1) {
      const holidays = JAPANESE_PUBLIC_HOLIDAYS_BY_YEAR[year] ?? []
      expect(holidays.map((holiday) => holiday.date)).toEqual(deriveJapaneseDaysOff(year))
      expect(holidays.every((holiday) => holiday.date.startsWith(`${year}-`) && holiday.name.length > 0)).toBe(true)
    }
  })

  test('names substitute holidays and bridge days as 休日', () => {
    const holidays = listJapanesePublicHolidays()
    expect(holidays.find((holiday) => holiday.date === '2026-05-06')?.name).toBe('休日')
    expect(holidays.find((holiday) => holiday.date === '2026-09-22')?.name).toBe('休日')
    expect(holidays.find((holiday) => holiday.date === '2027-03-22')?.name).toBe('休日')
    const dates = holidays.map((holiday) => holiday.date)
    expect(dates).toEqual([...dates].sort())
  })

  test('returns copies so callers cannot change the bundled data', () => {
    const [first] = listJapanesePublicHolidays()
    if (!first) throw new Error('expected bundled holidays')
    first.name = 'changed'
    expect(listJapanesePublicHolidays()[0]?.name).toBe('元日')
  })
})

describe('Workspace days off', () => {
  test('uses the Japanese holidays by default and for settings stored before the choice existed', () => {
    expect(DEFAULT_WORKSPACE_CALENDAR_SETTINGS.publicHolidays).toBe('japan')
    expect(readWorkspaceCalendarSettings({ fiscalYearStartMonth: 4, weekStartDay: 1 })?.publicHolidays).toBe('japan')
    expect(readWorkspaceCalendarSettings({ fiscalYearStartMonth: 4, weekStartDay: 1, publicHolidays: 'none' })?.publicHolidays)
      .toBe('none')
    expect(readWorkspaceCalendarSettings({ fiscalYearStartMonth: 4, weekStartDay: 1, publicHolidays: 'us' })).toBeUndefined()
  })

  test('merges company holidays with the national holidays without duplicates', () => {
    const daysOff = listWorkspaceDaysOff({ holidays: ['2026-01-01', '2026-12-29'], publicHolidays: 'japan' })
    expect(daysOff).toContain('2026-12-29')
    expect(daysOff).toContain('2026-11-23')
    expect(daysOff.filter((date) => date === '2026-01-01')).toHaveLength(1)
    expect(daysOff).toEqual([...daysOff].sort())
    expect(listWorkspaceDaysOff({ holidays: ['2026-12-29'], publicHolidays: 'none' })).toEqual(['2026-12-29'])
  })

  test('keeps the newest dates when the merged list exceeds the Work Item schedule limit', () => {
    const companyHolidays = Array.from({ length: WORKSPACE_CALENDAR_MAX_HOLIDAYS }, (_, index) =>
      isoDate(Date.UTC(2030, 0, 1) + index * DAY))
    const daysOff = listWorkspaceDaysOff({ holidays: companyHolidays, publicHolidays: 'japan' })
    expect(daysOff).toHaveLength(WORKSPACE_CALENDAR_MAX_HOLIDAYS)
    expect(daysOff).toEqual(companyHolidays)
  })

  test('creates the Work Item calendar policy from the Workspace settings', () => {
    const policy = createWorkspaceWorkItemCalendarPolicy({
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
      holidays: ['2026-12-29'],
      publicHolidays: 'japan',
    })
    expect(policy.timeZone).toBe('Asia/Tokyo')
    expect(policy.workingWeekdays).toContain('saturday')
    expect(policy.holidays).toContain('2026-12-29')
    expect(policy.holidays).toContain('2027-01-01')
  })

  test('uses the synced national holiday dates instead of the bundled ones when given', () => {
    const synced = ['2028-01-01', '2028-01-10']
    expect(listWorkspaceDaysOff({ holidays: ['2027-12-29'], publicHolidays: 'japan' }, synced))
      .toEqual(['2027-12-29', '2028-01-01', '2028-01-10'])
    expect(listWorkspaceDaysOff({ holidays: [], publicHolidays: 'none' }, synced)).toEqual([])
    const policy = createWorkspaceWorkItemCalendarPolicy({
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: [],
      publicHolidays: 'japan',
    }, synced)
    expect(policy.holidays).toEqual(synced)
  })

  test('reads the national holiday dates of a calendar settings response strictly', () => {
    expect(readWorkspaceNationalHolidayDates({ nationalHolidayDates: ['2026-01-12', '2026-01-01', '2026-01-01'] }))
      .toEqual(['2026-01-01', '2026-01-12'])
    expect(readWorkspaceNationalHolidayDates({})).toBeUndefined()
    expect(readWorkspaceNationalHolidayDates(null)).toBeUndefined()
    expect(readWorkspaceNationalHolidayDates({ nationalHolidayDates: ['2026-02-30'] })).toBeUndefined()
    expect(readWorkspaceNationalHolidayDates({ nationalHolidayDates: '2026-01-01' })).toBeUndefined()
    expect(readWorkspaceNationalHolidayDates({
      nationalHolidayDates: Array.from({ length: WORKSPACE_NATIONAL_HOLIDAY_DATES_MAX + 1 }, () => '2026-01-01'),
    })).toBeUndefined()
  })
})
