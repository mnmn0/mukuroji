import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  analyticsDateToEpochDay,
  type AnalyticsGroup,
  type AnalyticsSeriesPoint,
} from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { AnalyticsMilestoneTrendChart } from './AnalyticsMilestoneTrendChart'

const t = createTranslator('ja')

/**
 * Returns the day number of a date for story data.
 *
 * @param date - `YYYY-MM-DD` date.
 * @returns Days since 1970-01-01.
 */
function day(date: string) {
  return analyticsDateToEpochDay(date) ?? 0
}

/**
 * Builds weekly series points whose segments carry each Milestone's date.
 *
 * @param weeks - Milestone dates of each week; an omitted Milestone has no date that week.
 * @returns Series points starting on Monday 2026-10-05 in Asia/Tokyo.
 */
function createSeries(weeks: ReadonlyArray<Readonly<Record<string, string>>>): AnalyticsSeriesPoint[] {
  return weeks.map((dates, index) => {
    const from = new Date(Date.UTC(2026, 9, 4, 15) + index * 7 * 86_400_000)
    const segments = Object.entries(dates).map(([key, date]) => ({ key, value: day(date) }))
    return {
      from: from.toISOString(),
      to: new Date(from.getTime() + 7 * 86_400_000 - 1).toISOString(),
      value: segments.length,
      sampleSize: segments.length,
      segments,
    }
  })
}

const groups: AnalyticsGroup[] = [
  { key: 'design', label: '設計レビュー完了', value: 0, sampleSize: 0 },
  { key: 'beta', label: 'ベータ公開', value: 14, sampleSize: 2 },
  { key: 'launch', label: '正式リリース', value: 7, sampleSize: 1 },
]

const meta = {
  title: 'Application/Analytics/AnalyticsMilestoneTrendChart',
  component: AnalyticsMilestoneTrendChart,
  args: {
    label: 'Milestone の予定日推移',
    groups,
    series: createSeries([
      { design: '2026-10-30', beta: '2026-11-20' },
      { design: '2026-10-30', beta: '2026-11-20' },
      { design: '2026-10-30', beta: '2026-11-27', launch: '2026-12-18' },
      { design: '2026-10-30', beta: '2026-11-27', launch: '2026-12-18' },
      { design: '2026-10-30', beta: '2026-12-04', launch: '2026-12-25' },
      { design: '2026-10-30', beta: '2026-12-04', launch: '2026-12-25' },
    ]),
    t,
    timeZone: 'Asia/Tokyo',
  },
} satisfies Meta<typeof AnalyticsMilestoneTrendChart>

export default meta

type Story = StoryObj<typeof meta>

/** Several Milestones slipping at different times; Launch starts mid-period, leaving a gap. */
export const Slipping: Story = {}

/** One Milestone whose date never moved. */
export const Steady: Story = {
  args: {
    groups: [{ key: 'design', label: '設計レビュー完了', value: 0, sampleSize: 0 }],
    series: createSeries([
      { design: '2026-10-30' },
      { design: '2026-10-30' },
      { design: '2026-10-30' },
    ]),
  },
}
