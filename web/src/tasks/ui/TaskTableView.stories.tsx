import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import { TaskTableView } from './TaskTableView'
import {
  taskViewStoryConfigurationsByTeam,
  taskViewStoryTasks,
} from './TaskView.stories.fixtures'

const t = createTranslator('ja')

/** Storybook metadata for the independent project task table view. */
const meta = {
  title: 'Application/Projects/Task Views/Table',
  component: TaskTableView,
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
    bulkProjectOptions: [{ id: 'refero', label: 'Refero' }],
    bulkWorkspaceId: '',
    configuration: teamWorkItemConfigurationFixture,
    configurationsByTeam: taskViewStoryConfigurationsByTeam,
    locale: 'ja',
    personLabels: {
      'sato@example.com': '佐藤 花子',
      'suzuki@example.com': '鈴木 大輔',
    },
    projectId: 'refero',
    selectedBulkItems: [],
    selectedDetailTaskKey: 'refero:core-team:wireframe',
    selectedTaskKeys: [],
    t,
    tasks: taskViewStoryTasks,
    visibleBulkItems: [],
    onBulkOperationComplete: () => undefined,
    onCreateTaskOpen: () => undefined,
    onSelectTask: () => undefined,
    onTaskSelectionChange: () => undefined,
    onVisibleTaskSelectionChange: () => undefined,
  },
} satisfies Meta<typeof TaskTableView>

export default meta

/** Story type for the independent task table view. */
type Story = StoryObj<typeof meta>

/** Standard populated project task table. */
export const Default: Story = {}

/** Empty project task table. */
export const Empty: Story = {
  args: {
    tasks: [],
  },
}

/** Project task table with a list loading error. */
export const LoadingError: Story = {
  args: {
    taskErrorMessage: 'Lambda returned 500.',
    tasks: [],
  },
}
