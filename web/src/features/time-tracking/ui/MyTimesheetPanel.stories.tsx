import type { Meta, StoryObj } from '@storybook/react-vite'
import type { MyTimesheet } from '@mukuroji/contracts'
import { fn } from 'storybook/test'
import { createTranslator } from '../../../shared/i18n/i18n'
import {
  createTimeEntryFixture,
  timeTrackingFixtureTeamTimesheet,
  timeTrackingFixtureWeekStart,
} from '../fixtures'
import { createWeekPeriod } from '../model/timePeriod'
import { MyTimesheetPanel } from './MyTimesheetPanel'

/** The member's own time in two Teams, with drafts in one and a rejected entry in the other. */
const timesheet: MyTimesheet = {
  timeZone: 'Asia/Tokyo',
  teams: [
    {
      teamId: 'team-core',
      name: 'Core',
      timesheet: { ...timeTrackingFixtureTeamTimesheet, canManageTeam: false, costsRedacted: true },
      entries: [
        createTimeEntryFixture({ id: 'core-draft', status: 'draft' }),
        createTimeEntryFixture({ id: 'core-submitted', status: 'submitted' }),
      ],
    },
    {
      teamId: 'team-mobile',
      name: 'Mobile',
      timesheet: {
        ...timeTrackingFixtureTeamTimesheet,
        days: [{ key: '2026-11-11', label: '2026-11-11', minutes: 120, billableMinutes: 0, entryCount: 1 }],
        canManageTeam: false,
        costsRedacted: true,
      },
      entries: [createTimeEntryFixture({ id: 'mobile-rejected', status: 'rejected' })],
    },
  ],
}

/** Metadata of the personal timesheet across Teams stories. */
const meta = {
  title: 'Application/Time Tracking/My Timesheet Across Teams',
  component: MyTimesheetPanel,
  decorators: [(Story) => <div className="bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    days: createWeekPeriod(timeTrackingFixtureWeekStart).days,
    failed: false,
    isLoading: false,
    isSubmitting: false,
    onMoveWeek: fn(),
    onRetry: fn(),
    onSubmit: fn(),
    t: createTranslator('ja'),
    timesheet,
  },
} satisfies Meta<typeof MyTimesheetPanel>

export default meta
/** Typed story of the personal timesheet across Teams. */
type Story = StoryObj<typeof meta>

/** One row per Team with drafts and a rejected entry ready to submit together. */
export const Week: Story = {}

/** While the week loads. */
export const Loading: Story = { args: { isLoading: true, timesheet: undefined } }

/** A failed load with the retry action. */
export const LoadError: Story = { args: { failed: true, timesheet: undefined } }

/** A member who belongs to no Team with time tracking. */
export const NoTeams: Story = { args: { timesheet: { timeZone: 'Asia/Tokyo', teams: [] } } }

/** While the submission runs. */
export const Submitting: Story = { args: { isSubmitting: true } }

/** Some Teams submitted and one entry still needs a retry. */
export const PartialFailure: Story = { args: { notice: { kind: 'partial', count: 1, failed: 1 } } }

/** Every draft submitted. */
export const Submitted: Story = { args: { notice: { kind: 'submitted', count: 2 } } }
