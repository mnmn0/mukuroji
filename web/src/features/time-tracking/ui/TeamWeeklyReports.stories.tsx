import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  teamWeeklyReportFixtureMembers,
  timeTrackingFixtureMemberNames,
  timeTrackingFixtureWeekStart,
  weeklyReportFixtureSaved,
} from '../fixtures'
import { createWeekPeriod } from '../model/timePeriod'
import { TeamWeeklyReports } from './TeamWeeklyReports'
import { createTimeTrackingFormatters } from './timeTrackingText'

/** Metadata of the Team weekly report stories. */
const meta = {
  title: 'Application/Time Tracking/Team Weekly Reports',
  component: TeamWeeklyReports,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    t: createTranslator('ja'),
    formatters: createTimeTrackingFormatters('ja'),
    week: createWeekPeriod(timeTrackingFixtureWeekStart),
    members: teamWeeklyReportFixtureMembers,
    memberNames: timeTrackingFixtureMemberNames,
    isForbidden: false,
    hasLoadError: false,
    selectedMemberKey: 'demo@example.com',
    selectedReport: { ...weeklyReportFixtureSaved, draft: undefined },
    hasSelectedReportError: false,
    onSelectMember: fn(),
    onMoveWeek: fn(),
    onRetry: fn(),
    onRetrySelectedReport: fn(),
  },
} satisfies Meta<typeof TeamWeeklyReports>

export default meta
/** Typed Team weekly report story. */
type Story = StoryObj<typeof meta>

/** One member submitted and one did not; the submitted report hides a task the manager cannot view. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('提出 1 / 2 人')).toBeVisible()
    await expect(canvas.getAllByText('閲覧権限のないタスク').length).toBeGreaterThan(0)
  },
}

/** The reader manages no Project of the Team. */
export const Forbidden: Story = {
  args: { isForbidden: true, members: undefined },
}
