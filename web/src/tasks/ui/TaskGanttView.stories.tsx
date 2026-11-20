import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'
import type { TeamWorkItemHierarchyNode } from '@mukuroji/contracts'
import { createWorkItemOutlineKey } from '../../work-items/model/workItemHierarchy'
import { createTranslator } from '../../shared/i18n/i18n'
import { teamWorkItemConfigurationFixture } from '../../work-items/fixtures'
import { TaskGanttView } from './TaskGanttView'
import {
  taskViewStoryConfigurationsByTeam,
  taskViewStoryPlanningSnapshot,
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
    allProjectTasks: taskViewStoryTasks,
    configuration: teamWorkItemConfigurationFixture,
    configurationsByTeam: taskViewStoryConfigurationsByTeam,
    planningSnapshot: taskViewStoryPlanningSnapshot,
    t,
    tasks: taskViewStoryTasks,
  },
} satisfies Meta<typeof TaskGanttView>

export default meta

/** Story type for the independent task Gantt view. */
type Story = StoryObj<typeof meta>

/** Standard due-date-ordered project task list. */
export const Default: Story = {}

/** Filtered Gantt where a hidden same-Project endpoint must not be classified as external. */
export const FilteredLocalDependency: Story = {
  args: {
    tasks: taskViewStoryTasks.slice(0, 1),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const dependency = canvas.getByTestId('task-gantt-dependency-story-wireframe-brand')

    await expect(dependency).not.toHaveTextContent(t('workItems.dependencies.external'))
    await expect(canvas.queryByTestId('task-gantt-external-lane')).not.toBeInTheDocument()
  },
}

/** Gantt that shows one three-month period and moves it a month at a time. */
export const PeriodWindow: Story = {
  args: {
    windowStartMonth: '2026-06',
  },
  render: function PeriodWindowStory(args) {
    const [windowStartMonth, setWindowStartMonth] = useState(args.windowStartMonth ?? '2026-06')
    return (
      <TaskGanttView
        {...args}
        onWindowStartMonthChange={setWindowStartMonth}
        windowStartMonth={windowStartMonth}
      />
    )
  },
}

/**
 * Workspace working calendar with Saturday as a working day and 6/4 as a company holiday: the
 * holiday and Sunday day columns are shaded under the bars, and Saturday is not.
 */
export const WorkingCalendar: Story = {
  args: {
    workingCalendar: {
      holidays: ['2026-06-04'],
      timeZone: 'Asia/Tokyo',
      workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const header = (date: string) =>
      canvasElement.querySelector(`[role="columnheader"][aria-label="${date}"]`)

    await expect(canvas.getAllByTestId('task-gantt-non-working-day').length).toBeGreaterThan(0)
    await expect(header('2026-06-04')).toHaveAttribute('data-non-working')
    await expect(header('2026-06-07')).toHaveAttribute('data-non-working')
    await expect(header('2026-06-06')).not.toHaveAttribute('data-non-working')
  },
}

/** Planned bars with the recorded actual bars below them, one completed late and one in progress. */
export const PlanAndActual: Story = {
  args: {
    tasks: [
      {
        ...taskViewStoryTasks[0],
        actualStartDate: '2026-06-01',
        actualEndDate: '2026-06-08',
        statusCategory: 'completed',
      },
      { ...taskViewStoryTasks[1], actualStartDate: '2026-06-02' },
      { ...taskViewStoryTasks[2], actualStartDate: '2026-06-03', statusCategory: 'canceled' },
    ],
    windowStartMonth: '2026-06',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId(`task-gantt-actual-bar-${taskViewStoryTasks[0].id}`))
      .toHaveAccessibleName(t('tasks.gantt.actualBar').replace('{start}', '2026-06-01').replace('{end}', '2026-06-08'))
    await expect(canvas.getByTestId(`task-gantt-actual-bar-${taskViewStoryTasks[1].id}`)).toBeInTheDocument()
    // A canceled Work Item keeps its recorded start but is not in progress, so it has no bar.
    await expect(canvas.queryByTestId(`task-gantt-actual-bar-${taskViewStoryTasks[2].id}`)).not.toBeInTheDocument()
  },
}

/** Without a selected period, the timeline widens to show actual work after the planned horizon. */
export const ActualAfterPlannedHorizon: Story = {
  args: {
    tasks: [
      {
        ...taskViewStoryTasks[0],
        actualStartDate: '2026-08-10',
        actualEndDate: '2026-08-12',
        statusCategory: 'completed',
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId(`task-gantt-actual-bar-${taskViewStoryTasks[0].id}`))
      .toHaveAccessibleName(t('tasks.gantt.actualBar').replace('{start}', '2026-08-10').replace('{end}', '2026-08-12'))
  },
}

/** Hierarchy of the story tasks: the wireframe phase holds the brand and SEO work. */
const outlineStoryNodes: TeamWorkItemHierarchyNode[] = [
  {
    workItemId: 'wireframe',
    parentWorkItemId: null,
    depth: 0,
    wbsNumber: '1',
    hierarchyRank: 'i',
    childWorkItemIds: ['brand-guideline', 'seo-research'],
    rollup: {
      childCount: 2,
      descendantCount: 2,
      statusCategoryCounts: { backlog: 0, unstarted: 1, started: 1, completed: 0, canceled: 0 },
      openDescendantCount: 2,
      plannedEffortMinutes: 0,
      estimatedDescendantCount: 0,
      remainingEffortMinutes: 0,
      startDate: '2026-06-05',
      endDate: '2026-06-09',
    },
  },
  { workItemId: 'brand-guideline', parentWorkItemId: 'wireframe', depth: 1, wbsNumber: '1.1', hierarchyRank: 'i', childWorkItemIds: [] },
  { workItemId: 'seo-research', parentWorkItemId: 'wireframe', depth: 1, wbsNumber: '1.2', hierarchyRank: 'r', childWorkItemIds: [] },
  { workItemId: 'competitor-report', parentWorkItemId: null, depth: 0, wbsNumber: '2', hierarchyRank: 'r', childWorkItemIds: [] },
]

/** Outline with WBS numbers, a summary bar over the children, and a collapse toggle. */
export const Outline: Story = {
  render: function OutlineStory(args) {
    const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(() => new Set())
    return (
      <TaskGanttView
        {...args}
        outline={{
          hierarchies: new Map([['core-team', outlineStoryNodes]]),
          collapsedKeys,
          onToggleCollapsed: (task) => {
            const key = createWorkItemOutlineKey(task.teamId, task.id)
            const next = new Set(collapsedKeys)
            if (!next.delete(key)) next.add(key)
            setCollapsedKeys(next)
          },
        }}
      />
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByTestId('task-gantt-summary-wireframe')).toBeInTheDocument()
    await expect(canvas.getByTestId('task-gantt-wbs-seo-research')).toHaveTextContent('1.2')
    await userEvent.click(canvas.getByTestId('task-gantt-outline-toggle-wireframe'))
    await expect(canvas.queryByTestId('task-gantt-wbs-seo-research')).not.toBeInTheDocument()
  },
}

/** Work Items of several Projects under one heading per Project. */
export const GroupedByProject: Story = {
  args: {
    group: {
      direction: 'asc',
      resolve: (task) => ({
        key: task.assignedProjectId ?? '',
        label: task.assignedProjectId === 'refero' ? 'Refero リニューアル' : '—',
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByTestId('task-gantt-group-refero')).toHaveTextContent('Refero リニューアル')
  },
}
