import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import { TaskGanttView } from './TaskGanttView'
import {
  taskViewStoryConfigurationsByTeam,
  taskViewStoryTasks,
} from './TaskView.stories.fixtures'

const t = createTranslator('ja')

/** Storybook metadata for the independent project task Gantt view. */
const meta = {
  title: 'Application/Projects/Task Views/Gantt',
  component: TaskGanttView,
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
    configuration: teamWorkItemConfigurationFixture,
    configurationsByTeam: taskViewStoryConfigurationsByTeam,
    t,
    tasks: taskViewStoryTasks,
  },
} satisfies Meta<typeof TaskGanttView>

export default meta

/** Story type for the independent task Gantt view. */
type Story = StoryObj<typeof meta>

/** Standard due-date-ordered project task list. */
export const Default: Story = {}
