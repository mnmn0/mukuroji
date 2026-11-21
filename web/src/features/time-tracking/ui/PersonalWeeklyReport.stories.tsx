import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  timeTrackingFixtureEntries,
  timeTrackingFixtureWeekStart,
  timeTrackingFixtureWorkItems,
  weeklyReportFixtureSaved,
  weeklyReportFixtureWorkItems,
} from '../fixtures'
import { buildPersonalWeeklyReport } from '../model/personalWeeklyReport'
import { createWeekPeriod } from '../model/timePeriod'
import { PersonalWeeklyReport } from './PersonalWeeklyReport'
import { createTimeTrackingFormatters } from './timeTrackingText'

const week = createWeekPeriod(timeTrackingFixtureWeekStart)

/** Metadata of the member weekly report stories. */
const meta = {
  title: 'Application/Time Tracking/Personal Weekly Report',
  component: PersonalWeeklyReport,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    formatters: createTimeTrackingFormatters('ja'),
    week,
    report: buildPersonalWeeklyReport({
      weekDays: week.days,
      today: '2026-11-13',
      workItems: weeklyReportFixtureWorkItems,
      entries: timeTrackingFixtureEntries,
      workItemTitles: Object.fromEntries(timeTrackingFixtureWorkItems.map((item) => [item.id, item.title])),
    }),
    isLoading: false,
    hasLoadError: false,
    isPartial: false,
    onMoveWeek: fn(),
    onRetry: fn(),
    onCopy: fn(async () => undefined),
    savedReport: { teamId: 'core-team', memberKey: 'demo@example.com', weekStart: week.days[0] ?? '', submissionCount: 0 },
    history: [{ weekStart: '2026-11-02', submissionCount: 1, lastSubmittedAt: '2026-11-06T09:00:00.000Z' }],
    onSaveDraft: fn(async () => 'done' as const),
    onSubmit: fn(async () => 'done' as const),
    onOpenWeek: fn(),
  },
} satisfies Meta<typeof PersonalWeeklyReport>

export default meta
/** Typed weekly report story. */
type Story = StoryObj<typeof meta>

/** A week with a completed, a started, an overdue, and an upcoming task. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('weekly-report-markdown')).toHaveTextContent('CORE-12 Reduce onboarding friction')
  },
}

/** A week already submitted once, with its saved notes. */
export const Submitted: Story = {
  args: { savedReport: weeklyReportFixtureSaved },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('weekly-report-status')).toHaveTextContent('第1版')
    await expect(canvas.getByRole('button', { name: '再提出する' })).toBeVisible()
  },
}

/** A week with nothing recorded yet. */
export const Empty: Story = {
  args: {
    report: buildPersonalWeeklyReport({ weekDays: week.days, today: '2026-11-13', workItems: [], entries: [] }),
  },
}

/** Reads failed and the time entries were cut short. */
export const LoadError: Story = {
  args: { hasLoadError: true, isPartial: true },
}
