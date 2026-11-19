import type { Meta, StoryObj } from '@storybook/react-vite'
import type { CanonicalWorkItem } from '@mukuroji/contracts'
import { expect, fn, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { TaskScheduleBaselineView } from './TaskScheduleBaselinePanel'
import { taskViewStoryTasks } from './TaskView.stories.fixtures'

const t = createTranslator('ja')

/** Work Item whose current deadline moved five days after the baseline. */
const slippedTask: CanonicalWorkItem = {
  ...taskViewStoryTasks[0],
  schedule: {
    mode: 'date-range',
    calendarPolicy: { timeZone: 'Asia/Tokyo', workingWeekdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'], holidays: [] },
    startDate: '2026-12-03',
    endDate: '2026-12-15',
    durationDays: 9,
  },
}

/** Storybook metadata for the baseline section of the task detail pane. */
const meta = {
  title: 'Application/Projects/Task Views/Schedule Baseline',
  component: TaskScheduleBaselineView,
  args: {
    canCapture: false,
    captureFailed: false,
    disabled: false,
    onCapture: fn(),
    state: {
      status: 'ready',
      baseline: {
        revision: 1,
        capturedAt: '2026-11-19T00:00:00.000Z',
        entries: [{ workItemId: slippedTask.id, startDate: '2026-12-01', endDate: '2026-12-10' }],
      },
    },
    t,
    task: slippedTask,
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
} satisfies Meta<typeof TaskScheduleBaselineView>

export default meta

/** Story type for the baseline section. */
type Story = StoryObj<typeof meta>

/** The current plan slipped from the saved baseline. */
export const Slipped: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByTestId('task-detail-baseline-end-slip')).toHaveTextContent('5 日遅れ')
  },
}

/** No baseline has been saved, seen by a manager who can save one. */
export const Empty: Story = {
  args: { canCapture: true, state: { status: 'ready', baseline: null } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(t('tasks.detail.baselineNone'))).toBeInTheDocument()
    await expect(canvas.getByRole('button', { name: t('tasks.detail.baselineCapture') })).toBeEnabled()
  },
}

/** The baseline is still loading. */
export const Loading: Story = {
  args: { canCapture: true, state: { status: 'loading' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByRole('button', { name: t('tasks.detail.baselineCapture') })).toBeDisabled()
  },
}

/** Reading or saving the baseline failed. */
export const Failed: Story = {
  args: { canCapture: true, captureFailed: true, state: { status: 'error' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(t('tasks.detail.baselineLoadError'))).toBeInTheDocument()
    await expect(canvas.getByRole('alert')).toHaveTextContent(t('tasks.detail.baselineCaptureError'))
  },
}
