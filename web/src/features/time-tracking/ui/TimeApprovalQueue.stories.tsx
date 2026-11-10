import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  timeTrackingFixtureMemberNames,
  timeTrackingFixtureTeamEntries,
  timeTrackingFixtureTeamTimesheet,
  timeTrackingFixtureWeekStart,
  timeTrackingFixtureWorkItems,
} from '../fixtures'
import { createWeekPeriod } from '../model/timePeriod'
import { TimeApprovalQueue } from './TimeApprovalQueue'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Metadata of the approval queue stories. */
const meta = {
  title: 'Application/Time Tracking/Approval Queue',
  component: TimeApprovalQueue,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    formatters: createTimeTrackingFormatters('ja'),
    week: createWeekPeriod(timeTrackingFixtureWeekStart),
    canManage: true,
    entries: timeTrackingFixtureTeamEntries,
    teamTimesheet: timeTrackingFixtureTeamTimesheet,
    memberNames: timeTrackingFixtureMemberNames,
    workItemTitles: Object.fromEntries(timeTrackingFixtureWorkItems.map((item) => [item.id, item.title])),
    onMoveWeek: fn(),
    onRetry: fn(),
    onTransitionEntry: fn(async () => undefined),
    onTransitionWeek: fn(async () => ({ count: 1, failedEntryIds: ['entry-ren-submitted'], partialFailure: true, entries: [] })),
  },
} satisfies Meta<typeof TimeApprovalQueue>

export default meta
/** Typed approval queue story. */
type Story = StoryObj<typeof meta>

/** Submitted entries from two members and approved entries waiting for a lock. */
export const Manager: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('heading', { name: '承認待ち（2 件）' })).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'この週の提出分をすべて承認' })).toBeEnabled()
  },
}

/** A member who does not manage the Team. */
export const NotManager: Story = {
  args: { canManage: false, entries: [] },
}

/** Phone width. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
}
