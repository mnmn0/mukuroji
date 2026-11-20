import type { Meta, StoryObj } from '@storybook/react-vite'
import type { AnalyticsSeriesPoint } from '@mukuroji/contracts'
import { createTranslator } from '../../shared/i18n/i18n'
import { AnalyticsFlowChart } from './AnalyticsFlowChart'

const t = createTranslator('ja')

/**
 * Builds a daily series for stories.
 *
 * @param days - Remaining, scope, completed, and status counts of each day.
 * @returns Series points starting on 2026-11-12 in Asia/Tokyo.
 */
function createSeries(days: ReadonlyArray<{
  remaining: number
  scope: number
  completed: number
  started: number
  unstarted: number
  backlog: number
}>): AnalyticsSeriesPoint[] {
  return days.map((day, index) => {
    const from = new Date(Date.UTC(2026, 10, 11, 15) + index * 86_400_000)
    return {
      from: from.toISOString(),
      to: new Date(from.getTime() + 86_400_000 - 1).toISOString(),
      value: day.remaining,
      sampleSize: day.remaining,
      segments: [
        { key: 'scope', value: day.scope },
        { key: 'completed', value: day.completed },
        { key: 'started', value: day.started },
        { key: 'unstarted', value: day.unstarted },
        { key: 'backlog', value: day.backlog },
        { key: 'canceled', value: 0 },
      ],
    }
  })
}

const flowDays = [
  { remaining: 12, scope: 12, completed: 0, started: 2, unstarted: 6, backlog: 4 },
  { remaining: 11, scope: 12, completed: 1, started: 3, unstarted: 5, backlog: 3 },
  { remaining: 12, scope: 14, completed: 2, started: 4, unstarted: 5, backlog: 3 },
  { remaining: 9, scope: 14, completed: 5, started: 3, unstarted: 4, backlog: 2 },
  { remaining: 7, scope: 14, completed: 7, started: 3, unstarted: 3, backlog: 1 },
  { remaining: 6, scope: 14, completed: 8, started: 2, unstarted: 3, backlog: 1 },
]

const meta = {
  title: 'Application/Analytics/AnalyticsFlowChart',
  component: AnalyticsFlowChart,
  args: {
    label: 'Sprint 47',
    locale: 'ja',
    series: createSeries(flowDays),
    t,
    timeZone: 'Asia/Tokyo',
    visualization: 'burndown',
  },
  decorators: [(Story) => <div className="workbench-panel max-w-[720px] p-5"><Story /></div>],
} satisfies Meta<typeof AnalyticsFlowChart>

export default meta

type Story = StoryObj<typeof meta>

/** Remaining scope with the ideal line extended to the Cycle end. */
export const Burndown: Story = {
  args: { plannedEndDate: '2026-11-25' },
}

/** Total scope and completed lines; scope grows on day 3. */
export const Burnup: Story = {
  args: { visualization: 'burnup' },
}

/** Daily Work Item counts stacked by status category. */
export const CumulativeFlow: Story = {
  args: { visualization: 'area' },
}

/** First day of a Cycle: one observation is drawn as a point. */
export const BurndownFirstDay: Story = {
  args: { plannedEndDate: '2026-11-25', series: createSeries(flowDays.slice(0, 1)) },
}
