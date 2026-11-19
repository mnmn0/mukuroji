import type { AnalyticsSeriesPoint } from '@mukuroji/contracts'
import { useMemo } from 'react'
import type { Locale, MessageKey } from '../../shared/i18n/i18n'
import {
  createAnalyticsFlowChartModel,
  type AnalyticsFlowChartLayer,
  type AnalyticsFlowGranularity,
  type AnalyticsFlowVisualization,
} from '../model/flowChart'

/** Props of {@link AnalyticsFlowChart}. */
export type AnalyticsFlowChartProps = {
  /** Accessible chart name. */
  label: string
  /** Display locale for numbers. */
  locale: Locale
  /** Series points of a `remaining-scope` or `cumulative-flow` widget. */
  series: readonly AnalyticsSeriesPoint[]
  /** Translator of the current locale. */
  t: (key: MessageKey) => string
  /** IANA timezone that the series buckets were built in. */
  timeZone: string
  /** Flow visualization to draw. */
  visualization: AnalyticsFlowVisualization
  /** Optional last local date (`YYYY-MM-DD`) of the chart, such as a Cycle end date. */
  plannedEndDate?: string
  /** Chart height in SVG units; smaller values suit embedded charts. */
  height?: number
  /** Calendar bucket size of the series; defaults to `day`. */
  granularity?: AnalyticsFlowGranularity
}

const WIDTH = 640
const PADDING = 28

/** Fill opacity of each cumulative flow layer, so categories stay apart in one hue. */
const AREA_OPACITY: Readonly<Record<string, number>> = {
  completed: 0.95,
  started: 0.65,
  unstarted: 0.4,
  backlog: 0.2,
  canceled: 0.35,
}

const LAYER_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  backlog: 'workItems.statusCategory.backlog',
  canceled: 'workItems.statusCategory.canceled',
  completed: 'workItems.statusCategory.completed',
  ideal: 'analytics.flow.ideal',
  remaining: 'analytics.flow.remaining',
  scope: 'analytics.flow.scope',
  started: 'workItems.statusCategory.started',
  unstarted: 'workItems.statusCategory.unstarted',
}

/**
 * Draws a burndown (with ideal line), burnup, or stacked cumulative flow chart with a legend,
 * per-day hover titles, and a table view.
 *
 * @param props - Chart props.
 * @returns The chart.
 */
export function AnalyticsFlowChart({
  granularity = 'day',
  height = 220,
  label,
  locale,
  plannedEndDate,
  series,
  t,
  timeZone,
  visualization,
}: AnalyticsFlowChartProps) {
  const model = useMemo(
    () => createAnalyticsFlowChartModel(series, visualization, {
      granularity,
      timeZone,
      ...(plannedEndDate === undefined ? {} : { plannedEndDate }),
    }),
    [granularity, plannedEndDate, series, timeZone, visualization],
  )
  const formatter = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }), [locale])
  const chartWidth = WIDTH - PADDING * 2
  const chartHeight = height - PADDING * 2
  const slotCount = model.dates.length
  const xAt = (index: number) => PADDING + (slotCount <= 1 ? chartWidth / 2 : index * chartWidth / (slotCount - 1))
  const yAt = (value: number) => PADDING + chartHeight - value / model.maximum * chartHeight
  const legendLayers = [...model.layers].reverse()
  const layerLabel = (layer: AnalyticsFlowChartLayer) => t(LAYER_LABEL_KEYS[layer.key] ?? 'analytics.chart.value')

  return (
    <div data-testid={`analytics-flow-chart-${visualization}`}>
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {legendLayers.map((layer) => (
          <li className="flex items-center gap-1.5" key={layer.key}>
            <LegendSwatch layer={layer} />
            {layerLabel(layer)}
          </li>
        ))}
      </ul>
      <div aria-label={label} role="img">
        <svg className="h-auto w-full overflow-visible" viewBox={`0 0 ${WIDTH} ${height}`}>
          <title>{label}</title>
          {[0, 0.5, 1].map((ratio) => (
            <line
              key={ratio}
              strokeDasharray="4 5"
              style={{ stroke: 'var(--workbench-chart-grid)' }}
              x1={PADDING}
              x2={WIDTH - PADDING}
              y1={PADDING + chartHeight * ratio}
              y2={PADDING + chartHeight * ratio}
            />
          ))}
          <text
            className="text-[11px]"
            style={{ fill: 'var(--workbench-muted)' }}
            x={PADDING - 6}
            y={PADDING + 4}
            textAnchor="end"
          >
            {formatter.format(model.maximum)}
          </text>
          {model.layers.map((layer) => layer.kind === 'area'
            ? (
              <path
                d={createAreaPath(layer, xAt, yAt, Math.min(24, chartWidth / Math.max(slotCount, 1) / 2))}
                data-testid={`analytics-flow-area-${layer.key}`}
                key={layer.key}
                stroke="var(--workbench-chart-point-fill)"
                strokeWidth="1"
                style={{
                  fill: layer.key === 'canceled' ? 'var(--workbench-chart-missing)' : 'var(--workbench-chart-series)',
                  fillOpacity: AREA_OPACITY[layer.key] ?? 0.5,
                }}
              />
            )
            : (
              <path
                d={createLinePath(layer.values, xAt, yAt)}
                data-testid={`analytics-flow-line-${layer.key}`}
                fill="none"
                key={layer.key}
                strokeDasharray={layer.kind === 'ideal' ? '6 6' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                style={{ stroke: isPrimaryLine(layer) ? 'var(--workbench-chart-series)' : 'var(--workbench-chart-missing)' }}
              />
            ))}
          {model.layers.flatMap((layer) => layer.kind === 'area'
            ? []
            : layer.values.flatMap((value, index) =>
                value === null || !isIsolatedPoint(layer.values, index)
                  ? []
                  : [
                      <circle
                        cx={xAt(index)}
                        cy={yAt(value)}
                        data-testid={`analytics-flow-point-${layer.key}-${index}`}
                        key={`${layer.key}-${index}`}
                        r="4"
                        strokeWidth="2"
                        style={{
                          fill: 'var(--workbench-chart-point-fill)',
                          stroke: isPrimaryLine(layer) ? 'var(--workbench-chart-series)' : 'var(--workbench-chart-missing)',
                        }}
                      />,
                    ]))}
          {model.dates.map((date, index) => (
            <rect
              fill="transparent"
              height={chartHeight}
              key={date}
              width={Math.max(4, chartWidth / Math.max(slotCount, 1))}
              x={xAt(index) - chartWidth / Math.max(slotCount, 1) / 2}
              y={PADDING}
            >
              <title>
                {[
                  date,
                  ...legendLayers.flatMap((layer) => {
                    const value = layer.ownValues[index]
                    return value === null || value === undefined
                      ? []
                      : [`${layerLabel(layer)}: ${formatter.format(value)}`]
                  }),
                ].join('\n')}
              </title>
            </rect>
          ))}
        </svg>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 text-xs font-semibold text-[var(--workbench-muted)]">
        <span>{model.dates[0]}</span>
        <span>{model.dates.at(-1)}</span>
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--workbench-primary-text)]">
          {t('analytics.chart.tableFallback')}
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[360px] border-collapse text-left text-sm">
            <thead>
              <tr className="workbench-table-head">
                <th className="px-3 py-2" scope="col">{t('analytics.chart.bucket')}</th>
                {legendLayers.map((layer) => (
                  <th className="px-3 py-2 text-right" key={layer.key} scope="col">{layerLabel(layer)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {model.dates.map((date, index) => (
                <tr className="border-b border-[var(--workbench-border)]" key={date}>
                  <td className="px-3 py-2">{date}</td>
                  {legendLayers.map((layer) => {
                    const value = layer.ownValues[index]
                    return (
                      <td className="px-3 py-2 text-right tabular-nums" key={layer.key}>
                        {value === null || value === undefined ? '—' : formatter.format(value)}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

/**
 * Draws the legend mark of one layer in the same style as the plot.
 *
 * @param props - Layer to draw.
 * @returns The legend swatch.
 */
function LegendSwatch({ layer }: { layer: AnalyticsFlowChartLayer }) {
  if (layer.kind === 'area') {
    return (
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{
          background: layer.key === 'canceled' ? 'var(--workbench-chart-missing)' : 'var(--workbench-chart-series)',
          opacity: AREA_OPACITY[layer.key] ?? 0.5,
        }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="inline-block w-4 border-t-2"
      style={{
        borderColor: isPrimaryLine(layer) ? 'var(--workbench-chart-series)' : 'var(--workbench-chart-missing)',
        borderStyle: layer.kind === 'ideal' ? 'dashed' : 'solid',
      }}
    />
  )
}

/**
 * Returns whether a line layer carries the chart's main measure.
 *
 * @param layer - Line layer.
 * @returns Whether it is drawn in the series color.
 */
function isPrimaryLine(layer: AnalyticsFlowChartLayer) {
  return layer.key === 'remaining' || layer.key === 'completed'
}

/**
 * Returns whether a value has no drawable neighbor, so a line through it would draw nothing.
 *
 * @param values - Values per slot.
 * @param index - Slot index.
 * @returns Whether both neighbors are empty or missing.
 */
function isIsolatedPoint(values: ReadonlyArray<number | null>, index: number) {
  const previous = index > 0 ? values[index - 1] : null
  const next = index < values.length - 1 ? values[index + 1] : null
  return (previous === null || previous === undefined) && (next === null || next === undefined)
}

/**
 * Builds an SVG path through the drawable values, breaking at empty slots.
 *
 * @param values - Values per slot.
 * @param xAt - Slot index to x coordinate.
 * @param yAt - Value to y coordinate.
 * @returns SVG path data.
 */
function createLinePath(
  values: ReadonlyArray<number | null>,
  xAt: (index: number) => number,
  yAt: (value: number) => number,
) {
  let path = ''
  let drawing = false
  values.forEach((value, index) => {
    if (value === null) {
      drawing = false
      return
    }
    path += `${drawing ? ' L' : ' M'} ${xAt(index).toFixed(2)} ${yAt(value).toFixed(2)}`
    drawing = true
  })
  return path.trim()
}

/**
 * Builds a closed SVG path for one stacked area over its drawable slots.
 *
 * A single drawable slot is drawn as a band of `bandHalfWidth` on each side, so the
 * breakdown of a one-bucket chart stays visible.
 *
 * @param layer - Area layer with base values.
 * @param xAt - Slot index to x coordinate.
 * @param yAt - Value to y coordinate.
 * @param bandHalfWidth - Half width of a single-slot band.
 * @returns SVG path data.
 */
function createAreaPath(
  layer: AnalyticsFlowChartLayer,
  xAt: (index: number) => number,
  yAt: (value: number) => number,
  bandHalfWidth: number,
) {
  const indexes = layer.values.flatMap((value, index) => value === null ? [] : [index])
  if (indexes.length === 0) return ''
  if (indexes.length === 1) {
    const index = indexes[0] ?? 0
    const left = (xAt(index) - bandHalfWidth).toFixed(2)
    const right = (xAt(index) + bandHalfWidth).toFixed(2)
    const top = yAt(layer.values[index] ?? 0).toFixed(2)
    const bottom = yAt(layer.baseValues?.[index] ?? 0).toFixed(2)
    return `M ${left} ${top} L ${right} ${top} L ${right} ${bottom} L ${left} ${bottom} Z`
  }
  const top = indexes.map((index) => `${xAt(index).toFixed(2)} ${yAt(layer.values[index] ?? 0).toFixed(2)}`)
  const bottom = [...indexes].reverse().map((index) =>
    `${xAt(index).toFixed(2)} ${yAt(layer.baseValues?.[index] ?? 0).toFixed(2)}`
  )
  return `M ${top.join(' L ')} L ${bottom.join(' L ')} Z`
}
