import type { Meta, StoryObj } from '@storybook/react-vite'
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
