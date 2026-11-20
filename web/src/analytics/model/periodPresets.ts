import {
  resolveWorkspaceCalendarPeriod,
  WORKSPACE_CALENDAR_PERIOD_PRESETS,
  type AnalyticsDateRange,
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
 * Finds the preset whose local dates match a filter period, so the picker can show it.
 *
 * Only calendar dates are compared, which keeps a period chosen through the date inputs
 * matching the preset that covers the same days.
 *
 * @param period - Current Analytics filter period.
 * @param now - Current instant.
 * @param timeZone - IANA time zone the report reads calendar dates in.
 * @param calendar - Workspace fiscal year start month and week start day.
 * @returns The first matching preset, or undefined for a custom period.
 */
export function findAnalyticsPeriodPreset(
  period: AnalyticsDateRange,
  now: Date,
  timeZone: string,
  calendar: AnalyticsPeriodCalendar,
): WorkspaceCalendarPeriodPreset | undefined {
  const from = formatAnalyticsCalendarDate(period.from, timeZone)
  const to = formatAnalyticsCalendarDate(period.to, timeZone)
  const today = formatAnalyticsCalendarDate(now.toISOString(), timeZone)
  return WORKSPACE_CALENDAR_PERIOD_PRESETS.find((preset) => {
    const range = resolveWorkspaceCalendarPeriod(preset, today, calendar)
    return range.from === from && range.to === to
  })
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
