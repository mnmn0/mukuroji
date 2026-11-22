import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
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

/** Month whose weekends and a company holiday (2026-06-03) are shaded as Workspace days off. */
export const WorkspaceDaysOff: Story = {
  args: {
    month: '2026-06',
    workingCalendar: {
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
      holidays: ['2026-06-03'],
    },
  },
}
