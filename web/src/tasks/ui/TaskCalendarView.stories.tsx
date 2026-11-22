import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { TaskCalendarView } from './TaskCalendarView'
import { taskViewStoryTasks } from './TaskView.stories.fixtures'

const t = createTranslator('ja')

/** Storybook metadata for the independent project task calendar view. */
const meta = {
  title: 'Application/Projects/Task Views/Calendar',
  component: TaskCalendarView,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6 max-[720px]:p-3">
        <Story />
      </main>
    ),
  ],
  args: {
    t,
    tasks: taskViewStoryTasks,
  },
} satisfies Meta<typeof TaskCalendarView>

export default meta

/** Story type for the independent task calendar view. */
type Story = StoryObj<typeof meta>

/** Calendar with scheduled and unscheduled project tasks. */
export const Default: Story = {}

/** Calendar that reads one month at a time and moves between months. */
export const MonthWindow: Story = {
  args: {
    month: '2026-06',
  },
  render: function MonthWindowStory(args) {
    const [month, setMonth] = useState(args.month ?? '2026-06')
    return <TaskCalendarView {...args} month={month} onMonthChange={setMonth} />
  },
}

/**
 * Month in a Workspace whose week starts on Sunday: the dates are grouped under Sunday-to-Saturday
 * week headings, and the first and last weeks show only the dates inside the month.
 */
export const SundayWeekStart: Story = {
  args: {
    calendarPeriods: { fiscalYearStartMonth: 4, weekStartDay: 0 },
    month: '2026-06',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('task-calendar-week-2026-05-31')).toBeVisible()
    await expect(canvas.getByText('2026-06-28 〜 2026-07-04 の週')).toBeVisible()
    await expect(canvas.queryByTestId('task-calendar-week-2026-06-01')).toBeNull()
  },
}
