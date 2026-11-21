import type { JapanesePublicHoliday } from '@mukuroji/contracts'

/** Cabinet Office CSV of the national holidays (内閣府「国民の祝日」について). */
export const CABINET_OFFICE_HOLIDAYS_CSV_URL = 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv'

/** Earliest year kept from the Cabinet Office list; older years are not needed for new schedules. */
export const JAPANESE_PUBLIC_HOLIDAY_SYNC_MIN_YEAR = 2020

/** Fewest days off a year has had since the Happy Monday system (2000). */
const MIN_HOLIDAYS_PER_YEAR = 15

/** Most days off a year can plausibly have, including substitute holidays and bridge days. */
const MAX_HOLIDAYS_PER_YEAR = 25

/** Longest holiday name accepted from the source. */
const MAX_HOLIDAY_NAME_LENGTH = 64

/** Japanese national holidays the scheduled sync stored, with where and when they came from. */
export type StoredJapanesePublicHolidays = {
  /** Days off in date order, from {@link JAPANESE_PUBLIC_HOLIDAY_SYNC_MIN_YEAR} onward. */
  holidays: JapanesePublicHoliday[]
  /** When the list was fetched, as an ISO 8601 instant. */
  fetchedAt: string
  /** Month of the fetch in Japan time (`YYYY-MM`); the sync fetches once a month. */
  fetchedMonth: string
  /** Lowercase SHA-256 of the source bytes. */
  sourceSha256: string
}

/** The source list is not a usable Japanese national holiday list. */
export class JapanesePublicHolidaySourceError extends Error {
  /**
   * @param message - What is wrong with the source.
   */
  constructor(message: string) {
    super(message)
    this.name = 'JapanesePublicHolidaySourceError'
  }
}

/**
 * Reads the Cabinet Office holiday CSV.
 *
 * Each data row is `YYYY/M/D,名称`. The header row and blank lines are skipped; any other row that
 * is not a real date with a name rejects the whole file, so a changed format is never half-read.
 *
 * @param text - CSV text, already decoded from Shift_JIS.
 * @returns Every listed day off in date order.
 * @throws JapanesePublicHolidaySourceError when a row is malformed or a date repeats.
 */
export function parseCabinetOfficeHolidayCsv(text: string): JapanesePublicHoliday[] {
  const holidays: JapanesePublicHoliday[] = []
  const lines = text.replace(/^﻿/u, '').split(/\r\n|\n|\r/u)
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim()
    if (line === '') continue
    const [rawDate = '', rawName = '', ...rest] = line.split(',')
    const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/u.exec(rawDate.trim())
    if (!match) {
      // Only the first row may be the header, such as 国民の祝日・休日月日,国民の祝日・休日名称.
      if (index === 0 && holidays.length === 0) continue
      throw new JapanesePublicHolidaySourceError(`Row ${index + 1} has no YYYY/M/D date.`)
    }
    const name = rawName.trim()
    if (rest.some((field) => field.trim() !== '') || name === '' || name.length > MAX_HOLIDAY_NAME_LENGTH) {
      throw new JapanesePublicHolidaySourceError(`Row ${index + 1} has no valid holiday name.`)
    }
    const date = toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]))
    if (!date) throw new JapanesePublicHolidaySourceError(`Row ${index + 1} is not a real date.`)
    holidays.push({ date, name })
  }
  holidays.sort((left, right) => left.date.localeCompare(right.date))
  for (let index = 1; index < holidays.length; index += 1) {
    if (holidays[index]?.date === holidays[index - 1]?.date) {
      throw new JapanesePublicHolidaySourceError('A date is listed twice.')
    }
  }
  return holidays
}

/**
 * Keeps the recent years of a source list after checking that it looks like the real calendar.
 *
 * Every kept year must be present, with a plausible count of days off, and the list must reach the
 * current year in Japan. A list that fails is never stored, so the previous one stays in use.
 *
 * @param holidays - Parsed days off in date order.
 * @param today - Today's `YYYY-MM-DD` date in Japan.
 * @returns The days off from {@link JAPANESE_PUBLIC_HOLIDAY_SYNC_MIN_YEAR} onward.
 * @throws JapanesePublicHolidaySourceError when a year is missing or implausible.
 */
export function selectSyncedJapanesePublicHolidays(
  holidays: readonly JapanesePublicHoliday[],
  today: string,
): JapanesePublicHoliday[] {
  const kept = holidays.filter((holiday) => yearOf(holiday.date) >= JAPANESE_PUBLIC_HOLIDAY_SYNC_MIN_YEAR)
  const counts = new Map<number, number>()
  for (const holiday of kept) counts.set(yearOf(holiday.date), (counts.get(yearOf(holiday.date)) ?? 0) + 1)
  const lastYear = Math.max(...counts.keys())
  if (!Number.isFinite(lastYear) || lastYear < yearOf(today)) {
    throw new JapanesePublicHolidaySourceError('The list does not reach the current year.')
  }
  for (let year = JAPANESE_PUBLIC_HOLIDAY_SYNC_MIN_YEAR; year <= lastYear; year += 1) {
    const count = counts.get(year) ?? 0
    if (count < MIN_HOLIDAYS_PER_YEAR || count > MAX_HOLIDAYS_PER_YEAR) {
      throw new JapanesePublicHolidaySourceError(`${year} has ${count} days off.`)
    }
  }
  return kept.map((holiday) => ({ ...holiday }))
}

/**
 * Reads a stored holiday list, rejecting anything the sync could not have written.
 *
 * @param value - Stored item.
 * @returns The stored list, or undefined when it is missing or malformed.
 */
export function readStoredJapanesePublicHolidays(value: unknown): StoredJapanesePublicHolidays | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const holidays: unknown = Reflect.get(value, 'holidays')
  const fetchedAt: unknown = Reflect.get(value, 'fetchedAt')
  const fetchedMonth: unknown = Reflect.get(value, 'fetchedMonth')
  const sourceSha256: unknown = Reflect.get(value, 'sourceSha256')
  if (
    !Array.isArray(holidays) ||
    holidays.length === 0 ||
    typeof fetchedAt !== 'string' ||
    !Number.isFinite(Date.parse(fetchedAt)) ||
    typeof fetchedMonth !== 'string' ||
    !/^\d{4}-\d{2}$/u.test(fetchedMonth) ||
    typeof sourceSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(sourceSha256)
  ) {
    return undefined
  }
  const read: JapanesePublicHoliday[] = []
  for (const holiday of holidays) {
    if (typeof holiday !== 'object' || holiday === null) return undefined
    const date: unknown = Reflect.get(holiday, 'date')
    const name: unknown = Reflect.get(holiday, 'name')
    if (typeof date !== 'string' || !isIsoDate(date) || typeof name !== 'string' || name === '') return undefined
    const previous = read.at(-1)
    if (previous && previous.date >= date) return undefined
    read.push({ date, name })
  }
  return { holidays: read, fetchedAt, fetchedMonth, sourceSha256 }
}

/**
 * Formats a date in Japan time.
 *
 * @param instant - Moment to format.
 * @returns The `YYYY-MM-DD` date in Asia/Tokyo.
 */
export function toJapanDate(instant: Date): string {
  // Japan has no daylight saving time, so a fixed nine-hour offset is exact.
  return new Date(instant.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10)
}

/**
 * Builds a `YYYY-MM-DD` date when the parts name a real calendar day.
 *
 * @param year - Four-digit year.
 * @param month - Month from 1.
 * @param day - Day of month from 1.
 * @returns The date, or undefined when it does not exist.
 */
function toIsoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined
  }
  return date.toISOString().slice(0, 10)
}

/**
 * Checks a `YYYY-MM-DD` string names a real day.
 *
 * @param value - Candidate date.
 * @returns Whether it is a real calendar date.
 */
function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value)
  return Boolean(match && toIsoDate(Number(match[1]), Number(match[2]), Number(match[3])) === value)
}

/**
 * Reads the year of a `YYYY-MM-DD` date.
 *
 * @param date - Date to read.
 * @returns Its year.
 */
function yearOf(date: string): number {
  return Number(date.slice(0, 4))
}
