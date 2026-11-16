import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { expect, within } from 'storybook/test'
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
      taskViewStoryTasks[2],
    ],
    windowStartMonth: '2026-06',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId(`task-gantt-actual-bar-${taskViewStoryTasks[0].id}`))
      .toHaveAccessibleName(t('tasks.gantt.actualBar').replace('{start}', '2026-06-01').replace('{end}', '2026-06-08'))
    await expect(canvas.queryByTestId(`task-gantt-actual-bar-${taskViewStoryTasks[2].id}`)).not.toBeInTheDocument()
  },
}
