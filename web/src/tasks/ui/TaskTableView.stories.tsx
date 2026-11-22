import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import { createWorkItemDependencySummaries } from '../../work-items/model/workItemDependencies'
import {
  createWorkItemBaselineLookup,
  WORK_ITEM_BASELINE_END_DELAY_COLUMN,
} from '../../work-items/model/workItemScheduleBaselines'
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

/** Planned due dates beside the recorded actual dates and the completion delay. */
export const PlanAndActual: Story = {
  args: {
    presentation: {
      columns: [
        { field: 'title' },
        { field: 'status' },
        { field: 'dueDate' },
        { field: 'actualStartDate' },
        { field: 'actualEndDate' },
        { field: 'completionDelayDays' },
      ],
      density: 'comfortable',
      display: {
        showArchived: false,
        showAssigneeAvatars: true,
        showCompleted: true,
        showEmptyGroups: true,
        showSubtasks: true,
        wrapTitles: false,
      },
    },
    tasks: [
      {
        ...taskViewStoryTasks[0],
        actualStartDate: '2026-06-01',
        actualEndDate: '2026-06-08',
        statusCategory: 'completed',
      },
      { ...taskViewStoryTasks[1], actualStartDate: '2026-06-02' },
      taskViewStoryTasks[2],
    ],
  },
}

/** Columns of the baseline delay stories. */
const baselineDelayPresentation = {
  columns: [
    { field: 'title' },
    { field: 'status' },
    { field: 'dueDate' },
    { field: WORK_ITEM_BASELINE_END_DELAY_COLUMN },
  ],
  density: 'comfortable' as const,
  display: {
    showArchived: false,
    showAssigneeAvatars: true,
    showCompleted: true,
    showEmptyGroups: true,
    showSubtasks: true,
    wrapTitles: false,
  },
}

/**
 * WBS rows beside how far each ends behind the Project baseline: one late, one early, one added
 * after the baseline, and one without a planned end.
 */
export const BaselineDelay: Story = {
  args: {
    presentation: baselineDelayPresentation,
    scheduleBaselineFor: createWorkItemBaselineLookup([{
      teamId: 'core-team',
      projectId: 'refero',
      baseline: {
        revision: 1,
        capturedAt: '2026-05-25T00:00:00.000Z',
        entries: [
          { workItemId: 'wireframe', startDate: '2026-05-28', endDate: '2026-06-01' },
          { workItemId: 'brand-guideline', endDate: '2026-06-07' },
          { workItemId: 'competitor-report' },
        ],
      },
    }]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByText('ベースライン比の遅れ').length).toBeGreaterThan(0)
    await expect(canvas.getByTestId('task-baseline-delay-wireframe')).toHaveTextContent('2 日遅れ')
    await expect(canvas.getByTestId('task-baseline-delay-brand-guideline')).toHaveTextContent('2 日前倒し')
    await expect(canvas.getByTestId('task-baseline-delay-seo-research')).toHaveTextContent('—')
    await expect(canvas.getByTestId('task-baseline-delay-competitor-report')).toHaveTextContent('—')
  },
}

/**
 * The table as its print buttons prepare it for A3 landscape paper. Turn on print media emulation
 * (for example DevTools "Emulate CSS media type: print") to inspect the paper layout: the row
 * action column is not rendered, so the last data column ends at the table's right edge.
 */
export const PrintLayout: Story = {
  beforeEach: () => {
    document.documentElement.dataset.printTarget = 'task-table'
    return () => {
      delete document.documentElement.dataset.printTarget
      document.querySelector<HTMLElement>('[data-print-root="task-table"]')?.removeAttribute('data-print-paper')
    }
  },
  play: async ({ canvasElement }) => {
    const root = canvasElement.querySelector<HTMLElement>('[data-print-root="task-table"]')
    await expect(root).not.toBeNull()
    root?.setAttribute('data-print-paper', 'a3')
    const table = within(canvasElement).getByRole('table')
    const headers = Array.from(table.querySelectorAll('thead th'))
    const columns = Array.from(table.querySelectorAll('colgroup col'))
    // Only the row action column, the last one, is left off the paper.
    await expect(headers.at(-1)).toHaveAttribute('data-print-hidden')
    await expect(columns.at(-1)).toHaveAttribute('data-print-hidden')
    await expect(headers.filter((header) => header.hasAttribute('data-print-hidden'))).toHaveLength(1)
    await expect(columns.filter((column) => column.hasAttribute('data-print-hidden'))).toHaveLength(1)
    for (const row of Array.from(table.querySelectorAll('tbody tr[data-testid^="task-row-"]'))) {
      await expect(row.lastElementChild).toHaveAttribute('data-print-hidden')
    }
  },
}

/** The baseline delay column while the baselines are still loading. */
export const BaselineDelayLoading: Story = {
  args: {
    presentation: baselineDelayPresentation,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('task-baseline-delay-wireframe')).toHaveTextContent('—')
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
