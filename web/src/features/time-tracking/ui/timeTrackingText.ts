import type { TimeEntryStatus } from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import { classifyTimeTrackingFailure } from '../model/timeTrackingFailure'

/** Translator used by the time tracking views. */
export type TimeTrackingTranslator = (key: MessageKey) => string

/** Locale-aware date and time formatters of the time tracking views. */
export type TimeTrackingFormatters = {
  /** Formats a local `YYYY-MM-DD` date as a short day with its weekday. */
  day: (localDate: string) => string
  /** Formats an ISO instant as a local `HH:MM` time. */
  time: (instant: string) => string
  /** Formats an ISO instant as a local date. */
  date: (instant: string) => string
}

/** Message key of each lifecycle state. */
export const timeEntryStatusKeys: Record<TimeEntryStatus, MessageKey> = {
  draft: 'timeTracking.status.draft',
  submitted: 'timeTracking.status.submitted',
  approved: 'timeTracking.status.approved',
  rejected: 'timeTracking.status.rejected',
  locked: 'timeTracking.status.locked',
}

/** Badge class of each lifecycle state. */
export const timeEntryStatusBadgeClasses: Record<TimeEntryStatus, string> = {
  draft: 'workbench-badge',
  submitted: 'workbench-badge-primary',
  approved: 'workbench-badge-success',
  rejected: 'workbench-badge-danger',
  locked: 'workbench-badge',
}

/**
 * Replaces `{name}` placeholders in a translated message.
 *
 * @param template - Translated message.
 * @param values - Placeholder values.
 * @returns Message with the values inserted.
 */
export function interpolate(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/gu, (match, name: string) => name in values ? String(values[name]) : match)
}

/**
 * Explains a failed time tracking request to the member.
 *
 * @param t - Translator.
 * @param error - Unknown failure.
 * @returns Safe, localized message.
 */
export function describeTimeTrackingFailure(t: TimeTrackingTranslator, error: unknown): string {
  switch (classifyTimeTrackingFailure(error)) {
    case 'offline':
      return t('timeTracking.error.offline')
    case 'conflict':
      return t('timeTracking.error.conflict')
    case 'forbidden':
      return t('timeTracking.error.forbidden')
    case 'invalid':
      return t('timeTracking.error.invalid')
    default:
      return t('timeTracking.error.failed')
  }
}

/**
 * Creates the date and time formatters of a locale in the browser timezone.
 *
 * @param locale - Display locale.
 * @returns Formatters.
 */
export function createTimeTrackingFormatters(locale: Locale): TimeTrackingFormatters {
  const tag = locale === 'ja' ? 'ja-JP' : 'en-US'
  const dayFormatter = new Intl.DateTimeFormat(tag, { month: 'numeric', day: 'numeric', weekday: 'short' })
  const timeFormatter = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const dateFormatter = new Intl.DateTimeFormat(tag, { dateStyle: 'medium' })
  return {
    day: (localDate) => {
      const [year, month, day] = localDate.split('-').map(Number)
      return dayFormatter.format(new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1))
    },
    time: (instant) => timeFormatter.format(new Date(instant)),
    date: (instant) => dateFormatter.format(new Date(instant)),
  }
}
