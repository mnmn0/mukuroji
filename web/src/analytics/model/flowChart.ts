import type {
  AnalyticsSeriesPoint,
  AnalyticsVisualization,
} from '@mukuroji/contracts'
import { formatAnalyticsCalendarDate } from './timeZone'

/** Visualizations drawn by the flow chart instead of the single-series chart. */
export type AnalyticsFlowVisualization = Extract<AnalyticsVisualization, 'area' | 'burndown' | 'burnup'>

/** Status categories of a cumulative flow chart, from the bottom of the stack. */
export const ANALYTICS_FLOW_STATUS_CATEGORIES = [
  'completed',
  'started',
  'unstarted',
  'backlog',
  'canceled',
] as const

/** One drawable layer of a flow chart. */
export type AnalyticsFlowChartLayer = {
  /** Stable layer key: a status category, `remaining`, `ideal`, `scope`, or `completed`. */
  key: string
  /** How the layer is drawn. */
  kind: 'area' | 'line' | 'ideal'
  /** Upper value of the layer at each slot; `null` where the slot has no data. */
  values: Array<number | null>
  /** Lower value of a stacked area at each slot. */
  baseValues?: Array<number | null>
  /** Value of the layer itself (not stacked) at each slot, for tooltips and the table view. */
  ownValues: Array<number | null>
}

/** Chart-ready model of a burndown, burnup, or cumulative flow chart. */
export type AnalyticsFlowChartModel = {
  /** Local calendar date (`YYYY-MM-DD`) of each slot. */
  dates: string[]
  /** Layers drawn from the back to the front. */
  layers: AnalyticsFlowChartLayer[]
  /** Largest value of every layer, at least 1. */
  maximum: number
}

/** Options of {@link createAnalyticsFlowChartModel}. */
export type AnalyticsFlowChartOptions = {
  /** IANA timezone that the series buckets were built in. */
  timeZone: string
  /**
   * Last local calendar date (`YYYY-MM-DD`) of the chart. Days after the last series point up
   * to this date are drawn empty, and the burndown ideal line reaches zero on it.
   */
  plannedEndDate?: string
}

const MAX_PADDING_DAYS = 366

/**
 * Builds the drawable model of a flow chart from analytics series points.
 *
 * @param series - Series points of a `remaining-scope` or `cumulative-flow` widget.
 * @param visualization - Flow visualization to draw.
 * @param options - Timezone and optional planned end date.
 * @returns The chart model.
 */
export function createAnalyticsFlowChartModel(
  series: readonly AnalyticsSeriesPoint[],
  visualization: AnalyticsFlowVisualization,
  options: AnalyticsFlowChartOptions,
): AnalyticsFlowChartModel {
  const dates = series.map((point) => formatAnalyticsCalendarDate(point.from, options.timeZone))
  const padding = createPaddingDates(dates.at(-1), options.plannedEndDate)
  const slotCount = dates.length + padding.length
  const pad = (values: Array<number | null>) => [
    ...values,
    ...padding.map((): number | null => null),
  ]
  const layers = visualization === 'area'
    ? createStackedLayers(series).map((layer) => ({
        ...layer,
        values: pad(layer.values),
        baseValues: pad(layer.baseValues ?? []),
        ownValues: pad(layer.ownValues),
      }))
    : visualization === 'burnup'
      ? (['scope', 'completed'] as const).map((key): AnalyticsFlowChartLayer => {
          const values = pad(series.map((point) => readSegment(point, key)))
          return { key, kind: 'line', values, ownValues: values }
        })
      : createBurndownLayers(series, slotCount, pad)
  const maximum = Math.max(
    1,
    ...layers.flatMap((layer) => layer.values.filter(isFiniteNumber)),
  )
  return { dates: [...dates, ...padding], layers, maximum }
}

/**
 * Returns whether a widget visualization is drawn by the flow chart.
 *
 * @param visualization - Widget visualization.
 * @returns Whether it is `area`, `burndown`, or `burnup`.
 */
export function isAnalyticsFlowVisualization(
  visualization: unknown,
): visualization is AnalyticsFlowVisualization {
  return visualization === 'area' || visualization === 'burndown' || visualization === 'burnup'
}

/**
 * Builds the remaining line and the ideal line of a burndown.
 *
 * @param series - Remaining scope series.
 * @param slotCount - Number of slots including padding.
 * @param pad - Pads series values with empty slots.
 * @returns Ideal and remaining layers.
 */
function createBurndownLayers(
  series: readonly AnalyticsSeriesPoint[],
  slotCount: number,
  pad: (values: Array<number | null>) => Array<number | null>,
): AnalyticsFlowChartLayer[] {
  const remaining = pad(series.map((point) => isFiniteNumber(point.value) ? point.value : null))
  const start = remaining.find(isFiniteNumber)
  const ideal = Array.from({ length: slotCount }, (_, index): number | null => {
    if (start === undefined) return null
    if (slotCount === 1) return start
    return Math.max(0, start - start * index / (slotCount - 1))
  })
  return [
    { key: 'ideal', kind: 'ideal', values: ideal, ownValues: ideal },
    { key: 'remaining', kind: 'line', values: remaining, ownValues: remaining },
  ]
}

/**
 * Stacks cumulative flow segments by status category.
 *
 * @param series - Cumulative flow series.
 * @returns Area layers from the bottom of the stack.
 */
function createStackedLayers(series: readonly AnalyticsSeriesPoint[]): AnalyticsFlowChartLayer[] {
  const totals = series.map((): number => 0)
  return ANALYTICS_FLOW_STATUS_CATEGORIES.map((category) => {
    const ownValues = series.map((point) => readSegment(point, category))
    const baseValues = totals.map((total, index) => ownValues[index] === null ? null : total)
    const values = ownValues.map((value, index) => {
      if (value === null) return null
      totals[index] = (totals[index] ?? 0) + value
      return totals[index] ?? null
    })
    return { key: category, kind: 'area', values, baseValues, ownValues }
  })
}

/**
 * Reads one segment value of a series point.
 *
 * @param point - Series point.
 * @param key - Segment key.
 * @returns The value, or `null` when the point has no such segment.
 */
function readSegment(point: AnalyticsSeriesPoint, key: string): number | null {
  const value = point.segments?.find((segment) => segment.key === key)?.value
  return isFiniteNumber(value) ? value : null
}

/**
 * Lists the local dates after the last series date up to the planned end date.
 *
 * @param lastDate - Local date of the last series point.
 * @param plannedEndDate - Planned last date of the chart.
 * @returns Padding dates in order.
 */
function createPaddingDates(lastDate: string | undefined, plannedEndDate: string | undefined) {
  if (lastDate === undefined || plannedEndDate === undefined) return []
  const last = Date.parse(`${lastDate}T00:00:00Z`)
  const end = Date.parse(`${plannedEndDate}T00:00:00Z`)
  if (!Number.isFinite(last) || !Number.isFinite(end)) return []
  const dates: string[] = []
  for (
    let day = last + 86_400_000;
    day <= end && dates.length < MAX_PADDING_DAYS;
    day += 86_400_000
  ) {
    dates.push(new Date(day).toISOString().slice(0, 10))
  }
  return dates
}

/**
 * Returns whether a value is a finite number.
 *
 * @param value - Value to check.
 * @returns Whether the value is a finite number.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
