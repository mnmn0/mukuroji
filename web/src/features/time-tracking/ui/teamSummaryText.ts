import type { WeeklySummaryItem, WeeklySummarySectionName } from '@mukuroji/contracts'
import type { Locale, MessageKey } from '../../../shared/i18n/i18n'
import type { TimeTrackingFormatters, TimeTrackingTranslator } from './timeTrackingText'

/** Message key of each section heading. */
export const TEAM_SUMMARY_SECTION_TITLES: Record<WeeklySummarySectionName, MessageKey> = {
  completed: 'timeTracking.weeklySummary.completed',
  delayed: 'timeTracking.weeklySummary.delayed',
  overdue: 'timeTracking.weeklySummary.overdue',
  milestonesReached: 'timeTracking.weeklySummary.milestonesReached',
}

/**
 * Describes the date that put a Work Item in a section; also used by the Markdown copy.
 *
 * @param name - Section.
 * @param item - Listed Work Item.
 * @param t - Translator.
 * @param formatters - Date formatters.
 * @returns Short description, or an empty string when the Work Item has no such date.
 */
export function describeTeamSummaryItem(name: WeeklySummarySectionName, item: WeeklySummaryItem, t: TimeTrackingTranslator, formatters: TimeTrackingFormatters) {
  switch (name) {
    case 'completed':
    case 'milestonesReached':
      return item.actualEndDate ? t('timeTracking.weeklySummary.completedOn').replace('{date}', formatters.day(item.actualEndDate)) : ''
    case 'overdue':
      return item.plannedEndDate ? t('timeTracking.weeklySummary.dueOn').replace('{date}', formatters.day(item.plannedEndDate)) : ''
    case 'delayed':
      return t('timeTracking.weeklySummary.delayDays').replace('{days}', String(item.delayDays ?? 0))
  }
}

/**
 * Formats a calendar month for display.
 *
 * @param month - Month as `YYYY-MM`.
 * @param locale - Display locale.
 * @returns Such as `2026年11月` or `November 2026`.
 */
export function formatMonth(month: string, locale: Locale): string {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, 1)))
}
