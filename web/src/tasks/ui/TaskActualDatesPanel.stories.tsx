import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { TaskActualDatesPanel } from './TaskActualDatesPanel'
import { taskViewStoryTasks } from './TaskView.stories.fixtures'

const t = createTranslator('ja')

/** Completed Work Item that finished after its planned due date. */
const completedLateTask: CanonicalWorkItem = {
  ...taskViewStoryTasks[0],
  actualStartDate: '2026-06-01',
  actualEndDate: '2026-06-08',
  statusCategory: 'completed',
}

/** Storybook metadata for the plan-versus-actual section of the task detail pane. */
const meta = {
  title: 'Application/Projects/Task Views/Actual Dates',
  component: TaskActualDatesPanel,
  args: {
    canCorrect: false,
    disabled: false,
    onCorrect: fn(),
    t,
    task: completedLateTask,
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <section className="workbench-panel mx-auto max-w-md p-5">
          <Story />
        </section>
      </main>
    ),
  ],
} satisfies Meta<typeof TaskActualDatesPanel>

export default meta

/** Story type for the plan-versus-actual section. */
type Story = StoryObj<typeof meta>

/** Completed late, read by a member who cannot correct the dates. */
export const CompletedLate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('task-detail-completion-delay')).toHaveTextContent('5 日遅れ')
    await expect(canvas.queryByRole('button', { name: t('tasks.detail.actualDatesSave') })).not.toBeInTheDocument()
  },
}

/** Work in progress without an actual end date. */
export const InProgress: Story = {
  args: {
    task: { ...taskViewStoryTasks[1], actualStartDate: '2026-06-02' },
  },
}

/** Existing Work Item recorded before actual dates existed. */
export const NotRecorded: Story = {
  args: {
    task: taskViewStoryTasks[2],
  },
}

/** Manager correction sends only the changed date. */
export const ManagerCorrection: Story = {
  args: {
    canCorrect: true,
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    const start = canvas.getByLabelText(t('tasks.column.actualStartDate'), { selector: 'input' })
    await userEvent.clear(start)
    await userEvent.type(start, '2026-05-29')
    await userEvent.click(canvas.getByRole('button', { name: t('tasks.detail.actualDatesSave') }))
    await expect(args.onCorrect).toHaveBeenCalledWith({ actualStartDate: '2026-05-29' })
  },
}
