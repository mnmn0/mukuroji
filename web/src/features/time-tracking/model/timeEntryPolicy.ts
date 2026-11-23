import { MAX_TIME_ENTRY_DAILY_LIMIT_MINUTES } from '@mukuroji/contracts'

/**
 * Converts typed hours to whole minutes within the allowed daily limit.
 *
 * @param hours - Typed hours, such as `10` or `7.5`.
 * @returns Minutes, or undefined when the value is not 1 minute to 24 hours.
 */
export function parseDailyLimitHours(hours: string): number | undefined {
  const trimmed = hours.trim()
  if (!/^\d+(?:\.\d+)?$/u.test(trimmed)) return undefined
  const minutes = Math.round(Number(trimmed) * 60)
  return minutes >= 1 && minutes <= MAX_TIME_ENTRY_DAILY_LIMIT_MINUTES ? minutes : undefined
}
