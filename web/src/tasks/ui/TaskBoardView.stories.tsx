import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import { TaskBoardView } from './TaskBoardView'
import {
  taskViewStoryConfigurationsByTeam,
  taskViewStoryStatusColumns,
  taskViewStoryTasks,
} from './TaskView.stories.fixtures'

const t = createTranslator('ja')

/** Storybook metadata for the independent project task board view. */
const meta = {
  title: 'Application/Projects/Task Views/Board',
  component: TaskBoardView,
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
    configurationFailedTeamIds: [],
    configurationsByTeam: taskViewStoryConfigurationsByTeam,
    locale: 'ja',
    personLabels: {
      'sato@example.com': '佐藤 花子',
      'suzuki@example.com': '鈴木 大輔',
    },
    selectedDetailTaskKey: 'refero:core-team:wireframe',
    statusColumns: taskViewStoryStatusColumns,
    t,
    tasks: taskViewStoryTasks,
    onSelectTask: () => undefined,
  },
} satisfies Meta<typeof TaskBoardView>

export default meta

/** Story type for the independent task board view. */
type Story = StoryObj<typeof meta>

/** Standard workflow-column board. */
export const Default: Story = {}

/** Board that retains work items whose team configuration failed. */
export const ConfigurationUnavailable: Story = {
  args: {
    configuration: undefined,
    configurationFailedTeamIds: ['core-team'],
    configurationsByTeam: {},
    statusColumns: [],
  },
}
