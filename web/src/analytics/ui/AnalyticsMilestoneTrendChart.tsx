import type { AnalyticsGroup, AnalyticsSeriesPoint } from '@mukuroji/contracts'
import { useMemo } from 'react'
import type { MessageKey } from '../../shared/i18n/i18n'
import {
  createAnalyticsMilestoneTrendModel,
  formatAnalyticsMilestoneShift,
  formatAnalyticsMilestoneTrendDate,
  type AnalyticsMilestoneTrendLine,
} from '../model/milestoneTrend'

/** Props of {@link AnalyticsMilestoneTrendChart}. */
export type AnalyticsMilestoneTrendChartProps = {
  /** Accessible chart name. */
  label: string
  /** Series points of a `milestone-trend` widget. */
  series: readonly AnalyticsSeriesPoint[]
  /** Groups of the same widget, one per Milestone. */
  groups: readonly AnalyticsGroup[]
  /** Translator of the current locale. */
  t: (key: MessageKey) => string
  /** IANA timezone that the series buckets were built in. */
  timeZone: string
  /** Chart height in SVG units. */
  height?: number
}

const WIDTH = 640
const PADDING_LEFT = 76
const PADDING = 24

/**
 * Returns the CSS color of a Milestone line.
 *
 * @param line - Milestone line.
 * @returns The categorical chart color variable.
 */
function lineColor(line: AnalyticsMilestoneTrendLine) {
  return `var(--workbench-chart-category-${line.colorIndex})`
}

/**
 * Draws a Milestone trend: each Milestone's forecast end date (vertical) at every report date
 * (horizontal), with a legend that gives the shift in the period, per-date hover titles, and a
 * table view.
 *
 * @param props - Chart props.
 * @returns The chart.
 */
export function AnalyticsMilestoneTrendChart({
  groups,
  height = 240,
  label,
  series,
  t,
  timeZone,
}: AnalyticsMilestoneTrendChartProps) {
  const model = useMemo(
    () => createAnalyticsMilestoneTrendModel(series, groups, timeZone),
    [groups, series, timeZone],
  )
  const chartWidth = WIDTH - PADDING_LEFT - PADDING
  const chartHeight = height - PADDING * 2
  const slotCount = model.dates.length
  // Keep at least a week of vertical range so a flat line sits in the middle, not on an edge.
  const span = Math.max(7, model.maximum - model.minimum)
  const bottom = model.minimum - (span - (model.maximum - model.minimum)) / 2
  const xAt = (index: number) =>
    PADDING_LEFT + (slotCount <= 1 ? chartWidth / 2 : index * chartWidth / (slotCount - 1))
  const yAt = (value: number) => PADDING + chartHeight - (value - bottom) / span * chartHeight
  const slotWidth = chartWidth / Math.max(slotCount, 1)
  const ticks = [bottom + span, bottom + span / 2, bottom].map(Math.round)

  return (
    <div data-testid="analytics-milestone-trend-chart">
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-[var(--workbench-muted)]">
        {model.lines.map((line) => (
          <li className="flex items-center gap-1.5" key={line.key}>
            <span
              aria-hidden="true"
              className="inline-block w-4 border-t-2"
              style={{ borderColor: lineColor(line) }}
            />
            <span className="text-[var(--workbench-text)]">{line.label}</span>
            <span className="tabular-nums">
              {formatAnalyticsMilestoneShift(line.shiftDays)}
              {t('analytics.milestoneTrend.daysSuffix')}
            </span>
          </li>
        ))}
      </ul>
      <div aria-label={label} role="img">
        <svg className="h-auto w-full overflow-visible" viewBox={`0 0 ${WIDTH} ${height}`}>
          <title>{label}</title>
          {ticks.map((tick, index) => (
            <g key={`${tick}-${index}`}>
              <line
                strokeDasharray="4 5"
                style={{ stroke: 'var(--workbench-chart-grid)' }}
                x1={PADDING_LEFT}
                x2={WIDTH - PADDING}
                y1={yAt(tick)}
                y2={yAt(tick)}
              />
              <text
                className="text-[11px]"
                style={{ fill: 'var(--workbench-muted)' }}
                textAnchor="end"
                x={PADDING_LEFT - 6}
                y={yAt(tick) + 4}
              >
                {formatAnalyticsMilestoneTrendDate(tick)}
              </text>
            </g>
          ))}
          {model.lines.map((line) => (
            <g data-testid={`analytics-milestone-trend-line-${line.key}`} key={line.key}>
              <path
                d={createLinePath(line.values, xAt, yAt)}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                style={{ stroke: lineColor(line) }}
              />
              {line.values.map((value, index) => value === null ? null : (
                <circle
                  cx={xAt(index)}
                  cy={yAt(value)}
                  key={index}
                  r="3"
                  strokeWidth="2"
                  style={{ fill: 'var(--workbench-chart-point-fill)', stroke: lineColor(line) }}
                />
              ))}
            </g>
          ))}
          {model.dates.map((date, index) => (
            <rect
              fill="transparent"
              height={chartHeight}
              key={`${date}-${index}`}
              width={Math.max(4, slotWidth)}
              x={xAt(index) - slotWidth / 2}
              y={PADDING}
            >
              <title>
                {[
                  date,
                  ...model.lines.flatMap((line) => {
                    const value = line.values[index]
                    return value === null || value === undefined
                      ? []
                      : [`${line.label}: ${formatAnalyticsMilestoneTrendDate(value)}`]
                  }),
                ].join('\n')}
              </title>
            </rect>
          ))}
        </svg>
      </div>
      <div
        className="mt-2 flex items-center justify-between gap-3 text-xs font-semibold text-[var(--workbench-muted)]"
        style={{ paddingLeft: `${PADDING_LEFT / WIDTH * 100}%` }}
      >
        <span>{model.dates[0]}</span>
        <span>{model.dates.at(-1)}</span>
      </div>
      <details className="mt-4">
        <summary className="cursor-pointer text-xs font-semibold text-[var(--workbench-primary-text)]">
          {t('analytics.chart.tableFallback')}
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-left text-sm">
            <thead>
              <tr className="workbench-table-head">
                <th className="px-3 py-2" scope="col">{t('analytics.milestoneTrend.milestone')}</th>
                <th className="px-3 py-2" scope="col">{t('analytics.milestoneTrend.periodStart')}</th>
                <th className="px-3 py-2" scope="col">{t('analytics.milestoneTrend.latest')}</th>
                <th className="px-3 py-2 text-right" scope="col">{t('analytics.milestoneTrend.shift')}</th>
                <th className="px-3 py-2 text-right" scope="col">{t('analytics.milestoneTrend.changes')}</th>
              </tr>
            </thead>
            <tbody>
              {model.lines.map((line) => (
                <tr className="border-b border-[var(--workbench-border)]" key={line.key}>
                  <td className="px-3 py-2">{line.label}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatAnalyticsMilestoneTrendDate(line.periodStart)}
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatAnalyticsMilestoneTrendDate(line.latest)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatAnalyticsMilestoneShift(line.shiftDays)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{line.changeCount}</td>
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
 * Builds an SVG path through the known values, breaking where a value is unknown.
 *
 * @param values - Values per slot.
 * @param xAt - Horizontal position of a slot.
 * @param yAt - Vertical position of a value.
 * @returns The path data.
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
    path += `${drawing ? 'L' : 'M'}${xAt(index).toFixed(1)} ${yAt(value).toFixed(1)} `
    drawing = true
  })
  return path.trim()
}
