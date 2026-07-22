const calendarDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u
const millisecondsPerDay = 24 * 60 * 60 * 1_000
const localDateFormatterCache = new Map<string, Intl.DateTimeFormat>()

/**
 * UTC instant を analytics report timezone の `YYYY-MM-DD` に変換します。
 *
 * @param instant - Filter に保存された ISO 8601 UTC instant です。
 * @param timeZone - Calendar date を解釈する IANA timezone です。
 * @returns Date input に渡せる local calendar date です。
 */
export function formatAnalyticsCalendarDate(
  instant: string,
  timeZone: string,
) {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return instant.slice(0, 10)

  return formatLocalCalendarDate(date.getTime(), timeZone)
}

/**
 * Report timezone の local calendar date 境界を UTC instant に変換します。
 *
 * DST の23時間日・25時間日でも、start は最初の instant、end は次の
 * local date の直前を返します。
 *
 * @param calendarDate - Date input の `YYYY-MM-DD` です。
 * @param timeZone - Calendar date を解釈する IANA timezone です。
 * @param boundary - Local date の開始または inclusive な終了です。
 * @returns Analytics filter に保存する ISO 8601 UTC instant です。
 */
export function analyticsCalendarDateBoundaryToInstant(
  calendarDate: string,
  timeZone: string,
  boundary: 'start' | 'end',
) {
  const dateParts = parseCalendarDate(calendarDate)
  const start = findFirstInstantForLocalDate(calendarDate, dateParts, timeZone)

  if (boundary === 'start') {
    return new Date(start).toISOString()
  }

  const nextDate = addCalendarDays(dateParts, 1)
  const nextStart = findFirstInstantAtOrAfterLocalDate(
    nextDate.value,
    nextDate.utcEpoch,
    timeZone,
  )
  return new Date(nextStart - 1).toISOString()
}

function findFirstInstantForLocalDate(
  calendarDate: string,
  dateParts: ReturnType<typeof parseCalendarDate>,
  timeZone: string,
) {
  const instant = findFirstInstantAtOrAfterLocalDate(
    calendarDate,
    dateParts.utcEpoch,
    timeZone,
  )
  if (formatLocalCalendarDate(instant, timeZone) !== calendarDate) {
    throw new RangeError(`Calendar date ${calendarDate} does not exist in ${timeZone}.`)
  }
  return instant
}

function findFirstInstantAtOrAfterLocalDate(
  calendarDate: string,
  approximateUtcEpoch: number,
  timeZone: string,
) {
  let low = approximateUtcEpoch - millisecondsPerDay * 3
  let high = approximateUtcEpoch + millisecondsPerDay * 3

  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (formatLocalCalendarDate(middle, timeZone) < calendarDate) {
      low = middle + 1
    } else {
      high = middle
    }
  }

  return low
}

function formatLocalCalendarDate(epoch: number, timeZone: string) {
  const parts = getLocalDateFormatter(timeZone).formatToParts(new Date(epoch))
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  const day = parts.find((part) => part.type === 'day')?.value
  return `${year ?? '0000'}-${month ?? '00'}-${day ?? '00'}`
}

function getLocalDateFormatter(timeZone: string) {
  const normalizedTimeZone = normalizeTimeZone(timeZone)
  const cached = localDateFormatterCache.get(normalizedTimeZone)
  if (cached) return cached

  const formatter = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: normalizedTimeZone,
    year: 'numeric',
  })
  localDateFormatterCache.set(normalizedTimeZone, formatter)
  return formatter
}

function normalizeTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format()
    return timeZone
  } catch {
    return 'UTC'
  }
}

function parseCalendarDate(calendarDate: string) {
  const match = calendarDatePattern.exec(calendarDate)
  if (!match) throw new RangeError(`Invalid calendar date: ${calendarDate}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const utcEpoch = Date.UTC(year, month - 1, day)
  const normalized = new Date(utcEpoch).toISOString().slice(0, 10)
  if (normalized !== calendarDate) {
    throw new RangeError(`Invalid calendar date: ${calendarDate}`)
  }
  return { day, month, utcEpoch, year }
}

function addCalendarDays(
  dateParts: ReturnType<typeof parseCalendarDate>,
  days: number,
) {
  const date = new Date(dateParts.utcEpoch + days * millisecondsPerDay)
  return {
    utcEpoch: date.getTime(),
    value: date.toISOString().slice(0, 10),
  }
}
