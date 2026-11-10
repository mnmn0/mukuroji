import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  timeTrackingFixtureEntries,
  timeTrackingFixtureEstimate,
  timeTrackingFixtureNow,
  timeTrackingFixtureRejectionReasons,
  timeTrackingFixtureTimer,
} from '../fixtures'
import { WorkItemTimePanel } from './WorkItemTimePanel'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Metadata of the Work Item time panel stories. */
const meta = {
  title: 'Application/Time Tracking/Work Item Time Panel',
  component: WorkItemTimePanel,
  decorators: [(Story) => <div className="max-w-xl bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    formatters: createTimeTrackingFormatters('ja'),
    now: timeTrackingFixtureNow,
    canEditEstimate: true,
    workItemId: 'onboarding',
    timer: null,
    estimate: timeTrackingFixtureEstimate,
    actualMinutes: 540,
    entries: timeTrackingFixtureEntries.filter((entry) => entry.workItemId === 'onboarding').reverse(),
    rejectionReasons: timeTrackingFixtureRejectionReasons,
    timesheetHref: '/teams/core-team/timesheet',
    onRetry: fn(),
    onStartTimer: fn(async () => undefined),
    onStopTimer: fn(async () => undefined),
    onDiscardTimer: fn(async () => undefined),
    onSaveEstimate: fn(async () => undefined),
    onCreateEntry: fn(async () => undefined),
    onUpdateEntry: fn(async () => undefined),
    onSubmitEntry: fn(async () => undefined),
  },
} satisfies Meta<typeof WorkItemTimePanel>

export default meta
/** Typed Work Item time panel story. */
type Story = StoryObj<typeof meta>

/** Estimate exceeded by the actual time, with no timer running. */
export const OverEstimate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: 'タイマー開始' })).toBeEnabled()
    await expect(canvas.getByText('超過')).toBeVisible()
  },
}

/** A timer running on this Work Item. */
export const TimerRunning: Story = {
  args: { timer: timeTrackingFixtureTimer },
}

/** No estimate and no entries yet. */
export const Empty: Story = {
  args: { estimate: null, actualMinutes: 0, entries: [] },
}

/** Phone width with a running timer. */
export const Phone: Story = {
  args: { timer: timeTrackingFixtureTimer },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
