import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  timeTrackingFixtureEntries,
  timeTrackingFixtureRejectionReasons,
  timeTrackingFixtureWeekStart,
  timeTrackingFixtureWorkItems,
} from '../fixtures'
import { createWeekPeriod } from '../model/timePeriod'
import { PersonalTimesheet } from './PersonalTimesheet'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Metadata of the member timesheet stories. */
const meta = {
  title: 'Application/Time Tracking/Personal Timesheet',
  component: PersonalTimesheet,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    formatters: createTimeTrackingFormatters('ja'),
    week: createWeekPeriod(timeTrackingFixtureWeekStart),
    today: '2026-11-10',
    entries: timeTrackingFixtureEntries,
    rejectionReasons: timeTrackingFixtureRejectionReasons,
    workItemOptions: timeTrackingFixtureWorkItems,
    workItemTitles: Object.fromEntries(timeTrackingFixtureWorkItems.map((item) => [item.id, item.title])),
    onMoveWeek: fn(),
    onRetry: fn(),
    onCreateEntry: fn(async () => undefined),
    onUpdateEntry: fn(async () => undefined),
    onSubmitEntry: fn(async () => undefined),
    onSubmitWeek: fn(async () => ({ count: 2, failedEntryIds: [], partialFailure: false, entries: [] })),
  },
} satisfies Meta<typeof PersonalTimesheet>

export default meta
/** Typed timesheet story. */
type Story = StoryObj<typeof meta>

/** A week with every lifecycle state and a rejected entry to fix. */
export const Week: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('table', { name: 'タスク別・日別の工数' })).toBeVisible()
    await expect(canvas.getByRole('button', { name: '下書きをまとめて提出（2 件）' })).toBeEnabled()
  },
}

/** An empty week. */
export const EmptyWeek: Story = {
  args: { entries: [] },
}

/** Phone width; the table scrolls inside its frame. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
