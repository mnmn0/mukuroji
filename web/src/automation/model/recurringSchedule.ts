import type {
  RecurringCatchUpPolicy,
  RecurringSchedule,
} from '@mukuroji/contracts'

/** Recurring schedule builder の入力です。 */
export type RecurringScheduleInput = {
  /** Daily、weekly、monthly の cadence です。 */
  frequency: RecurringSchedule['frequency']
  /** IANA time zone ID です。 */
  timeZone: string
  /** `HH:mm` 形式の local wall-clock time です。 */
  localTime: string
  /** `YYYY-MM-DD` 形式の開始 local date です。 */
  startDate: string
  /** Missed occurrence の catch-up policy です。 */
  catchUpPolicy: RecurringCatchUpPolicy
  /** Weekly cadence で実行する曜日です。0 が Sunday です。 */
  dayOfWeek?: number
  /** Monthly cadence で実行する日です。 */
  dayOfMonth?: number
}

/**
 * Cadence 固有の曜日または月日を開始日から補完した schedule を作成します。
 *
 * @param input - Editor で選択された schedule 値です。
 * @returns Server validation を満たす recurring schedule です。
 */
export function createRecurringSchedule(input: RecurringScheduleInput): RecurringSchedule {
  const schedule = {
    catchUpPolicy: input.catchUpPolicy,
    frequency: input.frequency,
    interval: 1,
    localTime: input.localTime,
    startDate: input.startDate,
    timeZone: input.timeZone,
  } satisfies RecurringSchedule

  if (input.frequency === 'weekly') {
    const dayOfWeek = input.dayOfWeek ?? weekdayFromLocalDate(input.startDate)
    if (!isRecurringCadenceConfigurationValid(input.frequency, dayOfWeek, 1)) {
      throw new RangeError('The recurring weekday must be an integer from 0 through 6.')
    }
    return {
      ...schedule,
      daysOfWeek: [dayOfWeek],
    }
  }

  if (input.frequency === 'monthly') {
    const dayOfMonth = input.dayOfMonth ?? dayOfMonthFromLocalDate(input.startDate)
    if (!isRecurringCadenceConfigurationValid(input.frequency, 0, dayOfMonth)) {
      throw new RangeError('The recurring day of month must be an integer from 1 through 31.')
    }
    return {
      ...schedule,
      dayOfMonth,
    }
  }

  return schedule
}

/** 指定 IANA timezone における現在 local date を `YYYY-MM-DD` で返します。 */
export function currentDateInTimeZone(timeZone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timeZone.trim(),
    year: 'numeric',
  }).formatToParts(now)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  const year = values.get('year')
  const month = values.get('month')
  const day = values.get('day')
  if (!year || !month || !day) throw new RangeError('The time zone local date could not be resolved.')
  return `${year}-${month}-${day}`
}

/** Local ISO date の曜日を timezone 変換せずに返します。0 が Sunday です。 */
export function weekdayFromLocalDate(startDate: string) {
  const [year, month, day] = readLocalDateParts(startDate)

  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCDay()
}

/** Local ISO date から 1〜31 の月日を返します。 */
export function dayOfMonthFromLocalDate(startDate: string) {
  return readLocalDateParts(startDate)[2]
}

/** Cadence 固有の weekday/day-of-month が有効か返します。 */
export function isRecurringCadenceConfigurationValid(
  frequency: RecurringSchedule['frequency'],
  dayOfWeek: number,
  dayOfMonth: number,
) {
  if (frequency === 'weekly') return Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek <= 6
  if (frequency === 'monthly') return Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31
  return true
}

function readLocalDateParts(startDate: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate)
  if (!match) throw new RangeError('The local start date must use YYYY-MM-DD.')
  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new RangeError('The local start date is invalid.')
  }

  return [year, month, day]
}
