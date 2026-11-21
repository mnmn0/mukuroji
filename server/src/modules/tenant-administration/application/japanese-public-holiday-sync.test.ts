import { describe, expect, test } from 'bun:test'
import { listJapanesePublicHolidays, type JapanesePublicHoliday } from '@mukuroji/contracts'
import {
  InvalidStoredJapanesePublicHolidaysError,
  JapanesePublicHolidaySourceError,
  parseCabinetOfficeHolidayCsv,
  readStoredJapanesePublicHolidays,
  selectSyncedJapanesePublicHolidays,
  toJapanDate,
  type StoredJapanesePublicHolidays,
} from '../domain/japanese-public-holidays'
import {
  createJapanesePublicHolidayDates,
  syncJapanesePublicHolidays,
  type JapanesePublicHolidaySource,
  type JapanesePublicHolidayStore,
} from './japanese-public-holiday-sync'

/**
 * Builds a CSV in the Cabinet Office format from the bundled holidays, so each year is plausible.
 *
 * @param holidays - Days off to list.
 * @returns CSV text with the header row and CRLF line ends.
 */
function toCabinetOfficeCsv(holidays: readonly JapanesePublicHoliday[]): string {
  const rows = holidays.map(({ date, name }) => {
    const [year, month, day] = date.split('-')
    return `${year}/${Number(month)}/${Number(day)},${name}`
  })
  return ['国民の祝日・休日月日,国民の祝日・休日名称', ...rows, ''].join('\r\n')
}

/**
 * Builds days off for a year by moving the 2026 dates, so a test can list years before 2024.
 *
 * @param year - Year to fill.
 * @returns Days off with plausible names and count.
 */
function shiftedYear(year: number): JapanesePublicHoliday[] {
  return listJapanesePublicHolidays()
    .filter((holiday) => holiday.date.startsWith('2026-'))
    .map((holiday) => ({ date: `${year}${holiday.date.slice(4)}`, name: holiday.name }))
}

/** Every year the sync keeps, from 2020 through 2027. */
const fullList = [
  ...[2020, 2021, 2022, 2023].flatMap(shiftedYear),
  ...listJapanesePublicHolidays(),
]

/**
 * Creates an in-memory store.
 *
 * @param initial - Stored list before the run.
 * @returns The store and the lists written to it.
 */
function memoryStore(initial?: StoredJapanesePublicHolidays) {
  let current = initial
  const written: StoredJapanesePublicHolidays[] = []
  const store: JapanesePublicHolidayStore = {
    async get() {
      return current
    },
    async put(holidays) {
      current = holidays
      written.push(holidays)
    },
  }
  return { store, written }
}

/**
 * Creates a source that returns UTF-8 text.
 *
 * @param text - Text the source serves.
 * @returns The source and how many times it was fetched.
 */
function textSource(text: string) {
  const calls = { count: 0 }
  const source: JapanesePublicHolidaySource = {
    async fetch() {
      calls.count += 1
      return new TextEncoder().encode(text)
    },
    decode(bytes) {
      return new TextDecoder().decode(bytes)
    },
  }
  return { source, calls }
}

describe('Cabinet Office holiday CSV', () => {
  test('reads dated rows after the header in date order', () => {
    expect(parseCabinetOfficeHolidayCsv('﻿国民の祝日・休日月日,国民の祝日・休日名称\r\n2026/2/11,建国記念の日\r\n2026/1/1,元日\r\n\r\n'))
      .toEqual([{ date: '2026-01-01', name: '元日' }, { date: '2026-02-11', name: '建国記念の日' }])
  })

  test('rejects a malformed row, an impossible date, an extra column, and a repeated date', () => {
    for (const csv of [
      'header\n2026/1/1,元日\nnot a date,休日\n',
      '2026/2/30,休日\n',
      '2026/1/1,\n',
      '2026/1/1,元日,extra\n',
      '2026/1/1,元日\n2026/1/1,元日\n',
    ]) {
      expect(() => parseCabinetOfficeHolidayCsv(csv)).toThrow(JapanesePublicHolidaySourceError)
    }
  })

  test('keeps 2020 onward and rejects a list that is short, missing a year, or out of date', () => {
    expect(selectSyncedJapanesePublicHolidays([
      { date: '2019-01-01', name: '元日' },
      ...fullList,
    ], '2026-11-21')).toEqual(fullList)

    expect(() => selectSyncedJapanesePublicHolidays(fullList, '2028-01-05'))
      .toThrow('does not reach the current year')
    expect(() => selectSyncedJapanesePublicHolidays(
      fullList.filter((holiday) => !holiday.date.startsWith('2022-')),
      '2026-11-21',
    )).toThrow('2022 has 0 days off')
    expect(() => selectSyncedJapanesePublicHolidays(
      fullList.filter((holiday) => holiday.date < '2027-06-01'),
      '2026-11-21',
    )).toThrow('2027 has')
  })
})

describe('monthly national holiday sync', () => {
  test('fetches once a Japan-time month and stores the checked list with its source hash', async () => {
    const { store, written } = memoryStore()
    const { source, calls } = textSource(toCabinetOfficeCsv(fullList))
    // 2026-11-30T15:30Z is already December 1 in Japan.
    const now = new Date('2026-11-30T15:30:00.000Z')

    expect(await syncJapanesePublicHolidays({ store, source, now: () => now }))
      .toEqual({ status: 'updated', holidayCount: fullList.length, lastYear: 2027 })
    expect(written[0]).toMatchObject({
      fetchedAt: now.toISOString(),
      fetchedMonth: '2026-12',
      sourceSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(written[0]?.holidays).toEqual(fullList)

    expect(await syncJapanesePublicHolidays({ store, source, now: () => new Date('2026-12-20T00:00:00.000Z') }))
      .toEqual({ status: 'current', fetchedMonth: '2026-12' })
    expect(calls.count).toBe(1)
  })

  test('keeps the previous list when the source is unreachable or invalid', async () => {
    const previous: StoredJapanesePublicHolidays = {
      holidays: fullList,
      fetchedAt: '2026-11-01T00:00:00.000Z',
      fetchedMonth: '2026-11',
      sourceSha256: 'a'.repeat(64),
    }
    const now = () => new Date('2026-12-01T00:00:00.000Z')
    const unreachable = memoryStore(previous)
    await expect(syncJapanesePublicHolidays({
      store: unreachable.store,
      source: {
        fetch: async () => {
          throw new Error('timeout')
        },
        decode: () => '',
      },
      now,
    })).rejects.toThrow('timeout')
    const invalid = memoryStore(previous)
    await expect(syncJapanesePublicHolidays({
      store: invalid.store,
      source: textSource('<html>maintenance</html>').source,
      now,
    })).rejects.toThrow(JapanesePublicHolidaySourceError)

    expect(unreachable.written).toEqual([])
    expect(invalid.written).toEqual([])
  })

  test('refuses a list that ends before the stored one, so next year is never dropped', async () => {
    const previous: StoredJapanesePublicHolidays = {
      holidays: fullList,
      fetchedAt: '2026-11-01T00:00:00.000Z',
      fetchedMonth: '2026-11',
      sourceSha256: 'a'.repeat(64),
    }
    const { store, written } = memoryStore(previous)
    await expect(syncJapanesePublicHolidays({
      store,
      source: textSource(toCabinetOfficeCsv(fullList.filter((holiday) => holiday.date < '2027-01-01'))).source,
      now: () => new Date('2026-12-01T00:00:00.000Z'),
    })).rejects.toThrow('before the stored list')
    expect(written).toEqual([])
  })

  test('replaces a malformed stored row with the next valid list', async () => {
    const written: StoredJapanesePublicHolidays[] = []
    const result = await syncJapanesePublicHolidays({
      store: {
        async get() {
          throw new InvalidStoredJapanesePublicHolidaysError()
        },
        async put(holidays) {
          written.push(holidays)
        },
      },
      source: textSource(toCabinetOfficeCsv(fullList)).source,
      now: () => new Date('2026-12-01T00:00:00.000Z'),
    })

    expect(result).toMatchObject({ status: 'updated', lastYear: 2027 })
    expect(written[0]?.holidays).toEqual(fullList)
  })

  test('reads stored rows strictly', () => {
    const stored = {
      holidays: fullList,
      fetchedAt: '2026-11-01T00:00:00.000Z',
      fetchedMonth: '2026-11',
      sourceSha256: 'b'.repeat(64),
    }
    expect(readStoredJapanesePublicHolidays(stored)).toEqual(stored)
    expect(readStoredJapanesePublicHolidays({ ...stored, holidays: [] })).toBeUndefined()
    expect(readStoredJapanesePublicHolidays({ ...stored, sourceSha256: 'x' })).toBeUndefined()
    expect(readStoredJapanesePublicHolidays({
      ...stored,
      holidays: [{ date: '2026-01-02', name: '休日' }, { date: '2026-01-01', name: '元日' }],
    })).toBeUndefined()
    // The years must pass the same checks as a fetched list and reach the year of the fetch.
    expect(readStoredJapanesePublicHolidays({ ...stored, holidays: [{ date: '2026-01-01', name: '元日' }] }))
      .toBeUndefined()
    expect(readStoredJapanesePublicHolidays({
      ...stored,
      holidays: fullList.filter((holiday) => holiday.date < '2026-01-01'),
    })).toBeUndefined()
    expect(readStoredJapanesePublicHolidays({
      ...stored,
      holidays: [{ date: '2019-01-01', name: '元日' }, ...fullList],
    })).toBeUndefined()
    expect(toJapanDate(new Date('2026-12-31T15:00:00.000Z'))).toBe('2027-01-01')
  })
})

describe('national holiday dates for new Work Items', () => {
  test('uses the synced list, reuses a read for its lifetime, and falls back on failure', async () => {
    let clock = 0
    let reads = 0
    let failing = false
    let stored: StoredJapanesePublicHolidays | undefined
    const errors: unknown[] = []
    const dates = createJapanesePublicHolidayDates({
      store: {
        async get() {
          reads += 1
          if (failing) throw new Error('throttled')
          return stored
        },
      },
      cacheMilliseconds: 3_600_000,
      now: () => clock,
      logError: (error) => errors.push(error),
    })
    const bundled = listJapanesePublicHolidays().map((holiday) => holiday.date)

    expect(await dates.listDates()).toEqual(bundled)
    stored = {
      holidays: [{ date: '2028-01-01', name: '元日' }],
      fetchedAt: '2027-02-01T00:00:00.000Z',
      fetchedMonth: '2027-02',
      sourceSha256: 'c'.repeat(64),
    }
    expect(await dates.listDates()).toEqual(bundled)
    clock = 3_600_000
    expect(await dates.listDates()).toEqual(['2028-01-01'])
    expect(reads).toBe(2)

    failing = true
    clock = 7_200_000
    expect(await dates.listDates()).toEqual(['2028-01-01'])
    expect(await dates.listDates()).toEqual(['2028-01-01'])
    expect(reads).toBe(3)
    expect(errors).toHaveLength(1)
  })

  test('adds the bundled years after the last synced year', async () => {
    const throughThisYear = fullList.filter((holiday) => holiday.date < '2027-01-01')
    const dates = createJapanesePublicHolidayDates({
      store: {
        async get() {
          return {
            holidays: throughThisYear,
            fetchedAt: '2026-11-01T00:00:00.000Z',
            fetchedMonth: '2026-11',
            sourceSha256: 'd'.repeat(64),
          }
        },
      },
      cacheMilliseconds: 3_600_000,
      now: () => 0,
      logError: () => undefined,
    })
    const bundledNextYear = listJapanesePublicHolidays()
      .filter((holiday) => holiday.date.startsWith('2027-'))
      .map((holiday) => holiday.date)

    expect(bundledNextYear.length).toBeGreaterThan(0)
    expect(await dates.listDates())
      .toEqual([...throughThisYear.map((holiday) => holiday.date), ...bundledNextYear])
  })

  test('uses the bundled list when the first read fails', async () => {
    const dates = createJapanesePublicHolidayDates({
      store: {
        async get() {
          throw new Error('unavailable')
        },
      },
      cacheMilliseconds: 3_600_000,
      now: () => 0,
      logError: () => undefined,
    })

    expect(await dates.listDates()).toEqual(listJapanesePublicHolidays().map((holiday) => holiday.date))
  })
})
