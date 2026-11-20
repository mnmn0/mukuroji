import type { TimeEntry, TimeEntryCategory, TimeEntryStatus } from '@mukuroji/contracts'
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

/** Message key of each work category. */
export const timeEntryCategoryKeys = {
  design: 'timeTracking.report.category.design',
  implementation: 'timeTracking.report.category.implementation',
  review: 'timeTracking.report.category.review',
  meeting: 'timeTracking.report.category.meeting',
  management: 'timeTracking.report.category.management',
  training: 'timeTracking.report.category.training',
  leave: 'timeTracking.report.category.leave',
} as const satisfies Record<TimeEntryCategory, MessageKey>

/**
 * Names what an entry was spent on: its Work Item, or its work category for indirect work.
 *
 * @param t - Translator.
 * @param entry - Entry to describe.
 * @param workItemTitles - Work Item titles keyed by identifier.
 * @returns The Work Item title (or identifier), or an indirect-work label with the category.
 */
export function describeTimeEntrySubject(
  t: TimeTrackingTranslator,
  entry: Pick<TimeEntry, 'category' | 'workItemId'>,
  workItemTitles: Readonly<Record<string, string>>,
): string {
  if (entry.workItemId !== undefined) return workItemTitles[entry.workItemId] ?? entry.workItemId
  const category = entry.category === undefined
    ? t('timeTracking.report.category.uncategorized')
    : t(timeEntryCategoryKeys[entry.category])
  return interpolate(t('timeTracking.entry.indirect'), { category })
}

/**
 * Formats the local time range of an entry.
 *
 * @param formatters - Date and time formatters.
 * @param entry - Entry to format.
 * @returns `HH:MM–HH:MM`, or an empty string for a date-and-minutes entry whose times carry no meaning.
 */
export function formatTimeEntryRange(
  formatters: TimeTrackingFormatters,
  entry: Pick<TimeEntry, 'durationOnly' | 'endAt' | 'startAt'>,
): string {
  return entry.durationOnly ? '' : `${formatters.time(entry.startAt)}–${formatters.time(entry.endAt)}`
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
    case 'closed':
      return t('timeTracking.error.closed')
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
