import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'
import { factoryAnalyticsFixture, factoryAnalyticsWithUsageFixture } from '../fixtures'
import type { FactoryAnalyticsPeriodDays } from '../model/factoryAnalytics'
import { FactoryAnalyticsSummary, type FactoryAnalyticsSummaryProps } from './FactoryAnalyticsSummary'
import { createFactoryAnalyticsLabels } from './factoryBoardLabels'

/** Number format of the stories. */
const numberFormat = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 1 })

/**
 * Keeps the period in story state, as the page does.
 *
 * @param props - Summary props; `periodDays` is the initial period.
 * @returns Summary with a local period.
 */
function StatefulFactoryAnalyticsSummary(props: FactoryAnalyticsSummaryProps) {
  const [periodDays, setPeriodDays] = useState<FactoryAnalyticsPeriodDays>(props.periodDays)
  return (
    <FactoryAnalyticsSummary
      {...props}
      onPeriodDaysChange={(days) => {
        setPeriodDays(days)
        props.onPeriodDaysChange(days)
      }}
      periodDays={periodDays}
    />
  )
}

/** Metadata of the Factory analytics summary stories. */
const meta = {
  title: 'Application/Factory Board/Analytics Summary',
  component: FactoryAnalyticsSummary,
  decorators: [(Story) => <div className="min-h-svh bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    analytics: factoryAnalyticsFixture,
    isLoading: false,
    labels: createFactoryAnalyticsLabels('ja'),
    formatNumber: (value) => numberFormat.format(value),
    periodDays: 30,
    onPeriodDaysChange: fn(),
    onRetry: fn(),
  },
  render: (args) => <StatefulFactoryAnalyticsSummary {...args} />,
} satisfies Meta<typeof FactoryAnalyticsSummary>

export default meta

/** Story type of the summary. */
type Story = StoryObj<typeof meta>

/** Rates, station medians, and runtimes of a busy Team; changing the period asks for new data. */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('78.9%')).toBeVisible()
    await userEvent.selectOptions(canvas.getByLabelText('期間'), '7')
    await expect(args.onPeriodDaysChange).toHaveBeenCalledWith(7)
  },
}

/** English text. */
export const English: Story = {
  args: { labels: createFactoryAnalyticsLabels('en'), formatNumber: (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value) },
}

/** Runs sent telemetry, so the summary adds up their tokens per Project and Work Item; a manager also sees the cost. */
export const WithUsage: Story = {
  args: { analytics: factoryAnalyticsWithUsageFixture, projectNames: { refero: 'Refero' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('トークン使用量')).toBeVisible()
    await expect(canvas.getByText('Refero')).toBeVisible()
    await expect(canvas.getByText('Project なし')).toBeVisible()
  },
}

/** A read bound was reached, so the counts leave runs out. */
export const Incomplete: Story = {
  args: { analytics: { ...factoryAnalyticsFixture, workItemsHasMore: true } },
}

/** No run finished in the period. */
export const Empty: Story = {
  args: {
    analytics: {
      ...factoryAnalyticsFixture,
      finishedRuns: 0,
      outcomes: { completed: 0, paused: 0, failed: 0, released: 0, superseded: 0 },
      successRate: null,
      reworkRuns: 0,
      reworkRate: null,
      interventions: 0,
      stageLeadTimes: factoryAnalyticsFixture.stageLeadTimes.map((stage) => ({ ...stage, medianHours: null, sampleSize: 0 })),
      runtimes: [],
    },
  },
}

/** First read in progress. */
export const Loading: Story = {
  args: { analytics: undefined, isLoading: true },
}

/** The read failed and can be retried. */
export const LoadError: Story = {
  args: { analytics: undefined, errorMessage: createFactoryAnalyticsLabels('ja').loadError },
}

/** Phone width. */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
