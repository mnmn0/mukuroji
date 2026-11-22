import {
  analyticsEpochDayToDate,
  type AnalyticsGroup,
  type AnalyticsSeriesPoint,
} from '@mukuroji/contracts'
import { formatAnalyticsCalendarDate } from './timeZone'

/** Number of categorical colors the Milestone trend cycles through. */
export const ANALYTICS_MILESTONE_TREND_COLOR_COUNT = 6

/** One Milestone line of the trend chart. */
export type AnalyticsMilestoneTrendLine = {
  /** Planning entity ID of the Milestone. */
  key: string
  /** Milestone title. */
  label: string
  /** Forecast end date at each slot as days since 1970-01-01; `null` where it is unknown. */
  values: Array<number | null>
  /** Days the date moved in the period (later is positive); `null` when unknown. */
  shiftDays: number | null
  /** Number of date changes in the period. */
  changeCount: number
  /** 1-based categorical color of the line. */
  colorIndex: number
}

/** Chart-ready model of a Milestone trend. */
export type AnalyticsMilestoneTrendModel = {
  /** Local calendar date (`YYYY-MM-DD`) each slot is evaluated at: the bucket's last day. */
  dates: string[]
  /** One line per Milestone, in the order the API returned them. */
  lines: AnalyticsMilestoneTrendLine[]
  /** Earliest drawn date as a day number; equals `maximum` when nothing is drawn. */
  minimum: number
  /** Latest drawn date as a day number. */
  maximum: number
}

/**
 * Builds the drawable model of a Milestone trend from its series and groups.
 *
 * Each series point carries one segment per Milestone whose date is known at the bucket end. The
 * groups give each Milestone's title and its shift in the period.
 *
 * @param series - Series points of a `milestone-trend` widget.
 * @param groups - Groups of the same widget, one per Milestone.
 * @param timeZone - IANA timezone that the buckets were built in.
 * @returns The chart model.
 */
export function createAnalyticsMilestoneTrendModel(
  series: readonly AnalyticsSeriesPoint[],
  groups: readonly AnalyticsGroup[],
  timeZone: string,
): AnalyticsMilestoneTrendModel {
  const dates = series.map((point) => formatAnalyticsCalendarDate(point.to, timeZone))
  const lines = groups.map((group, index): AnalyticsMilestoneTrendLine => ({
    key: group.key,
    label: group.label,
    values: series.map((point) =>
      point.segments?.find((segment) => segment.key === group.key)?.value ?? null
    ),
    shiftDays: group.value,
    changeCount: group.sampleSize,
    colorIndex: index % ANALYTICS_MILESTONE_TREND_COLOR_COUNT + 1,
  }))
  const drawn = lines.flatMap((line) => line.values.filter((value): value is number => value !== null))
  const minimum = drawn.length === 0 ? 0 : Math.min(...drawn)
  const maximum = drawn.length === 0 ? 0 : Math.max(...drawn)
  return { dates, lines, minimum, maximum }
}

/**
 * Formats a trend value as its calendar date.
 *
 * @param value - Days since 1970-01-01, or `null`.
 * @returns The `YYYY-MM-DD` date, or an em dash when unknown.
 */
export function formatAnalyticsMilestoneTrendDate(value: number | null | undefined) {
  return value === null || value === undefined ? '—' : analyticsEpochDayToDate(value) ?? '—'
}

/**
 * Formats a shift in days with an explicit sign.
 *
 * @param shiftDays - Days the date moved, or `null`.
 * @returns `+5`, `-3`, `0`, or an em dash when unknown.
 */
export function formatAnalyticsMilestoneShift(shiftDays: number | null) {
  if (shiftDays === null) return '—'
  return shiftDays > 0 ? `+${shiftDays}` : String(shiftDays)
}
