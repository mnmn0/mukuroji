import {
  resolveWorkspaceCalendarPeriod,
  WORKSPACE_CALENDAR_PERIOD_PRESETS,
  type AnalyticsDateRange,
  type AnalyticsFilter,
  type WorkspaceCalendarPeriodPreset,
  type WorkspaceCalendarSettings,
} from '@mukuroji/contracts'
import {
  analyticsCalendarDateBoundaryToInstant,
  formatAnalyticsCalendarDate,
} from './timeZone'

/** Workspace settings an Analytics period preset needs: the fiscal year start and the week start. */
export type AnalyticsPeriodCalendar = Pick<WorkspaceCalendarSettings, 'fiscalYearStartMonth' | 'weekStartDay'>

/**
 * Builds the Analytics filter period of a preset on the report's calendar.
 *
 * "Today" is the current date in the report time zone, and the period covers whole local days
 * from the first day's start to the last day's end. A period that ends after today is kept as
 * is; the API clips it to the query's `asOf`.
 *
 * @param preset - Period preset to apply.
 * @param now - Current instant.
 * @param timeZone - IANA time zone the report reads calendar dates in.
 * @param calendar - Workspace fiscal year start month and week start day.
 * @returns The period as UTC instants for the Analytics filter.
 */
export function createAnalyticsPresetPeriod(
  preset: WorkspaceCalendarPeriodPreset,
  now: Date,
  timeZone: string,
  calendar: AnalyticsPeriodCalendar,
): AnalyticsDateRange {
  const today = formatAnalyticsCalendarDate(now.toISOString(), timeZone)
  const range = resolveWorkspaceCalendarPeriod(preset, today, calendar)
  return {
    from: analyticsCalendarDateBoundaryToInstant(range.from, timeZone, 'start'),
    to: analyticsCalendarDateBoundaryToInstant(range.to, timeZone, 'end'),
  }
}

/**
 * Applies a preset to a filter and remembers it, so a saved report keeps the relative period.
 *
 * @param filter - Current Analytics filter.
 * @param preset - Period preset the viewer picked.
 * @param now - Current instant.
 * @param timeZone - IANA time zone the report reads calendar dates in.
 * @param calendar - Workspace fiscal year start month and week start day.
 * @returns The filter with the preset's period and `periodPreset`.
 */
export function applyAnalyticsPeriodPreset(
  filter: AnalyticsFilter,
  preset: WorkspaceCalendarPeriodPreset,
  now: Date,
  timeZone: string,
  calendar: AnalyticsPeriodCalendar,
): AnalyticsFilter {
  return {
    ...filter,
    period: createAnalyticsPresetPeriod(preset, now, timeZone, calendar),
    periodPreset: preset,
  }
}

/**
 * Sets fixed dates on a filter, dropping any relative period it was chosen with.
 *
 * @param filter - Current Analytics filter.
 * @param period - Dates the viewer entered.
 * @returns The filter with the fixed period and no `periodPreset`.
 */
export function applyAnalyticsFixedPeriod(
  filter: AnalyticsFilter,
  period: AnalyticsDateRange,
): AnalyticsFilter {
  const fixed: AnalyticsFilter = { ...filter, period }
  delete fixed.periodPreset
  return fixed
}

/**
 * Re-resolves the relative period of a filter for the given day.
 *
 * A saved "this week" report opened next week shows next week's dates, the same as the API
 * resolves when it runs the saved report.
 *
 * @param filter - Filter from a saved report or the URL.
 * @param now - Instant the report is read at.
 * @param timeZone - IANA time zone the report reads calendar dates in.
 * @param calendar - Workspace fiscal year start month and week start day.
 * @returns The same filter when it has fixed dates or its period is already current, otherwise
 *   a copy with the period for that day.
 */
export function refreshAnalyticsPresetPeriod(
  filter: AnalyticsFilter,
  now: Date,
  timeZone: string,
  calendar: AnalyticsPeriodCalendar,
): AnalyticsFilter {
  if (!filter.periodPreset) return filter
  const period = createAnalyticsPresetPeriod(filter.periodPreset, now, timeZone, calendar)
  return period.from === filter.period.from && period.to === filter.period.to
    ? filter
    : { ...filter, period }
}

/**
 * Picks the preset the period picker shows for a filter.
 *
 * Only a remembered `periodPreset` is shown, so fixed dates that happen to cover "this week"
 * read as custom and save as fixed dates. The preset is shown while its dates are the current
 * ones; an immutable snapshot taken last week keeps last week's dates and reads as custom.
 *
 * @param filter - Current Analytics filter.
 * @param now - Current instant.
 * @param timeZone - IANA time zone the report reads calendar dates in.
 * @param calendar - Workspace fiscal year start month and week start day.
 * @returns The preset to show, or undefined for a custom period.
 */
export function selectAnalyticsPeriodPreset(
  filter: AnalyticsFilter,
  now: Date,
  timeZone: string,
  calendar: AnalyticsPeriodCalendar,
): WorkspaceCalendarPeriodPreset | undefined {
  if (!filter.periodPreset) return undefined
  const remembered = createAnalyticsPresetPeriod(filter.periodPreset, now, timeZone, calendar)
  const current =
    formatAnalyticsCalendarDate(remembered.from, timeZone) ===
      formatAnalyticsCalendarDate(filter.period.from, timeZone) &&
    formatAnalyticsCalendarDate(remembered.to, timeZone) ===
      formatAnalyticsCalendarDate(filter.period.to, timeZone)
  return current ? filter.periodPreset : undefined
}

/**
 * Narrows a picker value to a period preset.
 *
 * @param value - Value of the period picker.
 * @returns Whether the value names a preset.
 */
export function isAnalyticsPeriodPreset(value: string): value is WorkspaceCalendarPeriodPreset {
  return WORKSPACE_CALENDAR_PERIOD_PRESETS.some((preset) => preset === value)
}
