import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import { createWorkItemDependencySummaries } from '../../work-items/model/workItemDependencies'
import { TaskTableView } from './TaskTableView'
import {
  taskViewStoryConfigurationsByTeam,
  taskViewStoryPlanningSnapshot,
  taskViewStoryTasks,
} from './TaskView.stories.fixtures'

const t = createTranslator('ja')
const selectedBulkItem = {
  expectedRevision: 1,
  label: taskViewStoryTasks[0].title,
  selectionKey: 'refero:core-team:wireframe',
  teamId: 'core-team',
  workItemId: 'wireframe',
}

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
    dependencySummaries: createWorkItemDependencySummaries(taskViewStoryPlanningSnapshot),
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

/** Compact grouped table with a minimal visible-column set and wrapped titles. */
export const SavedViewPresentation: Story = {
  args: {
    presentation: {
      columns: [
        { field: 'title', pin: 'start', width: 320 },
        { field: 'priority', pin: 'end', width: 150 },
      ],
      density: 'compact',
      display: {
        showArchived: false,
        showAssigneeAvatars: true,
        showCompleted: true,
        showEmptyGroups: true,
        showSubtasks: true,
        wrapTitles: true,
      },
      groupBy: 'priority',
      subgroupBy: 'assignee',
    },
  },
}

/** Canonical Assign request consumed once while retaining the initialized toolbar mode. */
export const CanonicalAssignEntrance: Story = {
  args: {
    bulkWorkspaceId: 'workspace-1',
    bulkTaskActionEpoch: 7,
    bulkTaskActionRequest: {
      actionId: 'assign',
      projectId: 'refero',
      requestId: 7,
    },
    onBulkApply: fn(),
    onBulkPreview: fn(),
    onBulkTaskActionRequestConsumed: fn(),
    selectedBulkItems: [selectedBulkItem],
    selectedTaskKeys: [selectedBulkItem.selectionKey],
    visibleBulkItems: [selectedBulkItem],
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', {
      name: t('taskViews.action.assign'),
    })).toHaveAttribute('aria-pressed', 'true')
    await expect(canvas.getByRole('textbox', {
      name: t('bulk.edit.field.assigneeUserId'),
    })).toBeInTheDocument()
    await expect(args.onBulkTaskActionRequestConsumed).toHaveBeenCalledTimes(1)
    await expect(args.onBulkTaskActionRequestConsumed).toHaveBeenCalledWith(7)
  },
}

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
