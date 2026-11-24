import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import { teamWeeklySummaryFixture, teamWeeklySummaryFixtureProjectNames, timeTrackingFixtureWeekStart } from '../fixtures'
import { createWeekPeriod } from '../model/timePeriod'
import { TeamWeeklySummary } from './TeamWeeklySummary'
import { TimeWeekNavigator } from './TimeWeekNavigator'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Metadata of the Team weekly summary stories. */
const meta = {
  title: 'Application/Time Tracking/Team Weekly Summary',
  component: TeamWeeklySummary,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    formatters: createTimeTrackingFormatters('ja'),
    navigation: (
      <TimeWeekNavigator
        formatters={createTimeTrackingFormatters('ja')}
        onMove={fn()}
        t={createTranslator('ja')}
        week={createWeekPeriod(timeTrackingFixtureWeekStart)}
      />
    ),
    teamId: 'core-team',
    summary: teamWeeklySummaryFixture,
    projectNames: teamWeeklySummaryFixtureProjectNames,
    hasLoadError: false,
    isTooLarge: false,
    onRetry: fn(),
    onCopy: fn(async () => undefined),
  },
} satisfies Meta<typeof TeamWeeklySummary>

export default meta
/** Typed Team weekly summary story. */
type Story = StoryObj<typeof meta>

/** A Project with a baseline, one without, and Team-level Work Items. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('Refero')).toBeVisible()
    await expect(canvas.getByText('ベースラインがないため遅れは測れません。')).toBeVisible()
  },
}

/** The summary failed to load. */
export const LoadError: Story = {
  args: { hasLoadError: true, summary: undefined },
}

/** The monthly summary, with last month's counts under each total. */
export const Monthly: Story = {
  args: {
    period: 'month',
    navigation: <h3 className="text-base font-semibold">2026年11月</h3>,
    summary: {
      ...teamWeeklySummaryFixture,
      previousTotals: { completed: 4, delayed: 1, overdue: 0, milestonesReached: 1 },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('前月 4')).toBeVisible()
  },
}
