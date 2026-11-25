import type { FormEvent } from 'react'
import type { Locale } from '../../../shared/i18n/i18n'

/** Feedback line shown after an action. */
export type Feedback = {
  /** Whether the line reports a failure. */
  tone: 'error' | 'status'
  /** Text to show. */
  text: string
}

/** A `YYYY-MM` month. */
export const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/u

/**
 * Reads a trimmed reason from a submitted form.
 *
 * @param event - Form submission.
 * @returns The reason, or an empty string.
 */
export function readReason(event: FormEvent<HTMLFormElement>): string {
  const value = new FormData(event.currentTarget).get('reason')
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Returns the month before the given time, in the browser's local calendar, which is the month a
 * manager usually closes.
 *
 * @param now - Current time.
 * @returns Previous month as `YYYY-MM`.
 */
export function previousMonth(now: Date): string {
  const date = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Creates a formatter of `YYYY-MM` months for display that falls back to the raw text.
 *
 * @param locale - Display locale.
 * @returns Month formatter.
 */
export function createMonthFormatter(locale: Locale): (month: string) => string {
  const formatter = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' })
  return (month) => {
    const match = /^(\d{4})-(\d{2})$/u.exec(month)
    return match ? formatter.format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))) : month
  }
}
