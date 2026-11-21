import { createHash } from 'node:crypto'
import { listJapanesePublicHolidays } from '@mukuroji/contracts'
import {
  InvalidStoredJapanesePublicHolidaysError,
  JapanesePublicHolidaySourceError,
  lastJapanesePublicHolidayYear,
  parseCabinetOfficeHolidayCsv,
  selectSyncedJapanesePublicHolidays,
  toJapanDate,
  type StoredJapanesePublicHolidays,
} from '../domain/japanese-public-holidays'

/** Durable copy of the latest synced Japanese national holidays. */
export interface JapanesePublicHolidayStore {
  /** Reads the stored list, or undefined before the first sync. */
  get(): Promise<StoredJapanesePublicHolidays | undefined>
  /** Replaces the stored list. */
  put(holidays: StoredJapanesePublicHolidays): Promise<void>
}

/** Where the national holiday list is fetched from. */
export interface JapanesePublicHolidaySource {
  /** Fetches the source file and returns its bytes. */
  fetch(): Promise<Uint8Array>
  /** Decodes the bytes the source returned. */
  decode(bytes: Uint8Array): string
}

/** What one sync run did. */
export type JapanesePublicHolidaySyncResult =
  | {
    /** This month's list is already stored. */
    status: 'current'
    /** Month of the stored fetch. */
    fetchedMonth: string
  }
  | {
    /** A new list was fetched and stored. */
    status: 'updated'
    /** Number of stored days off. */
    holidayCount: number
    /** Last year the stored list covers. */
    lastYear: number
  }

/** Dependencies of {@link syncJapanesePublicHolidays}. */
export type JapanesePublicHolidaySyncDependencies = {
  /** Durable copy of the list. */
  store: JapanesePublicHolidayStore
  /** Cabinet Office source. */
  source: JapanesePublicHolidaySource
  /** Clock. */
  now: () => Date
}

/**
 * Fetches the Cabinet Office holiday list once a month and stores it.
 *
 * The scheduled job runs several times a day; only the first run of a month in Japan fetches, and a
 * failed fetch is tried again on the next run. A list that fails validation, or ends before the
 * stored one, is never stored, so the previous month's list stays in use, and the error reaches the
 * job's dead-letter queue. A malformed stored row is replaced by the next valid list.
 *
 * @param dependencies - Store, source, and clock.
 * @returns Whether the stored list was already current or was replaced.
 */
export async function syncJapanesePublicHolidays(
  dependencies: JapanesePublicHolidaySyncDependencies,
): Promise<JapanesePublicHolidaySyncResult> {
  const now = dependencies.now()
  const today = toJapanDate(now)
  const month = today.slice(0, 7)
  const stored = await readStoredOrUndefined(dependencies.store)
  if (stored?.fetchedMonth === month) return { status: 'current', fetchedMonth: month }
  const bytes = await dependencies.source.fetch()
  const holidays = selectSyncedJapanesePublicHolidays(
    parseCabinetOfficeHolidayCsv(dependencies.source.decode(bytes)),
    today,
  )
  const storedLastYear = stored ? lastJapanesePublicHolidayYear(stored.holidays) : undefined
  const fetchedLastYear = lastJapanesePublicHolidayYear(holidays)
  if (storedLastYear !== undefined && (fetchedLastYear === undefined || fetchedLastYear < storedLastYear)) {
    // A shorter list would drop holidays already known, such as next year's.
    throw new JapanesePublicHolidaySourceError(
      `The list ends in ${fetchedLastYear}, before the stored list (${storedLastYear}).`,
    )
  }
  await dependencies.store.put({
    holidays,
    fetchedAt: now.toISOString(),
    fetchedMonth: month,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
  })
  return {
    status: 'updated',
    holidayCount: holidays.length,
    lastYear: Number(holidays.at(-1)?.date.slice(0, 4)),
  }
}

/**
 * Reads the stored list for the sync, treating a malformed row as missing so a valid list can
 * replace it.
 *
 * @param store - Durable copy of the list.
 * @returns The stored list, or undefined when none is stored or the row is malformed.
 */
async function readStoredOrUndefined(
  store: JapanesePublicHolidayStore,
): Promise<StoredJapanesePublicHolidays | undefined> {
  try {
    return await store.get()
  } catch (error) {
    if (error instanceof InvalidStoredJapanesePublicHolidaysError) return undefined
    throw error
  }
}

/** Pause before the store is read again after a failed read. */
const FAILED_READ_PAUSE_MILLISECONDS = 60_000

/** Reads the national holiday dates new Work Items use. */
export interface JapanesePublicHolidayDates {
  /**
   * Lists the national holiday dates: the latest synced list, the last one this process read when
   * the store cannot be read, or the bundled list before the first sync. Bundled years after the
   * synced list's last year are added, so a list fetched before next year is published keeps the
   * bundled next year.
   */
  listDates(): Promise<string[]>
}

/** Options of {@link createJapanesePublicHolidayDates}. */
export type JapanesePublicHolidayDatesOptions = {
  /** Durable copy of the synced list. */
  store: Pick<JapanesePublicHolidayStore, 'get'>
  /** How long a read is reused before the store is read again. */
  cacheMilliseconds: number
  /** Clock. */
  now: () => number
  /** Receives a failed store read; the previous or bundled dates are returned instead. */
  logError: (error: unknown) => void
}

/**
 * Creates the reader the API uses for national holiday dates.
 *
 * The stored list changes at most once a month, so each process reuses a read for a while. A
 * failed read never blocks Work Item creation: the last dates this process read, or the bundled
 * ones, are used.
 *
 * @param options - Store, cache lifetime, clock, and error log.
 * @returns The cached reader.
 */
export function createJapanesePublicHolidayDates(
  options: JapanesePublicHolidayDatesOptions,
): JapanesePublicHolidayDates {
  let cached: { dates: string[]; readAt: number } | undefined
  let pending: Promise<string[]> | undefined
  /**
   * Lists the bundled national holiday dates.
   *
   * @returns The bundled dates.
   */
  const bundled = () => listJapanesePublicHolidays().map((holiday) => holiday.date)
  /**
   * Adds the bundled dates of the years after the last synced year.
   *
   * @param synced - Synced dates in date order.
   * @returns The synced dates followed by the later bundled ones.
   */
  const withBundledLaterYears = (synced: string[]) => {
    const lastSyncedYear = synced.at(-1)?.slice(0, 4) ?? ''
    return [...synced, ...bundled().filter((date) => date.slice(0, 4) > lastSyncedYear)]
  }

  /**
   * Reads the store and refreshes the cache.
   *
   * @returns The stored dates, or the fallback when the read fails or nothing is stored.
   */
  async function read(): Promise<string[]> {
    try {
      const stored = await options.store.get()
      const dates = stored ? withBundledLaterYears(stored.holidays.map((holiday) => holiday.date)) : bundled()
      cached = { dates, readAt: options.now() }
      return [...dates]
    } catch (error) {
      options.logError(error)
      // Keep the previous dates, or the bundled ones, and read again after a short pause instead of
      // on every request while the store is unavailable.
      const dates = cached?.dates ?? bundled()
      cached = {
        dates,
        readAt: options.now() - options.cacheMilliseconds + Math.min(options.cacheMilliseconds, FAILED_READ_PAUSE_MILLISECONDS),
      }
      return [...dates]
    }
  }

  return {
    /**
     * Lists the national holiday dates, reading the store when the cached read has expired.
     *
     * @returns A copy of the dates.
     */
    async listDates() {
      if (cached && options.now() - cached.readAt < options.cacheMilliseconds) return [...cached.dates]
      pending ??= read().finally(() => {
        pending = undefined
      })
      return [...await pending]
    },
  }
}
