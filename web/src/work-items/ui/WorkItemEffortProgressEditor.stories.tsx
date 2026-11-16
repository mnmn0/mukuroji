import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, within } from 'storybook/test'
import { WorkItemEffortProgressEditor } from './WorkItemEffortProgressEditor'

/** Metadata of the Work Item effort and progress editor stories. */
const meta = {
  title: 'Application/Work Items/Effort and Progress Editor',
  component: WorkItemEffortProgressEditor,
  decorators: [(Story) => <div className="max-w-xl bg-[var(--workbench-canvas)] p-4"><Story /></div>],
  args: {
    editorIdentity: 'core-team:onboarding:3',
    item: {
      statusCategory: 'started',
      schedule: { plannedEffortMinutes: 480 },
      remainingEffortMinutes: 120,
      progressPercent: 40,
    },
    locale: 'ja',
    onSave: fn(async () => undefined),
  },
} satisfies Meta<typeof WorkItemEffortProgressEditor>

export default meta
/** Typed effort and progress editor story. */
type Story = StoryObj<typeof meta>

/** Progress derived from the status category, the default mode. */
export const StatusCategory: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('50%')).toBeVisible()
    await expect(canvas.queryByLabelText('進捗率（%）')).toBeNull()
  },
}

/** Progress derived from the estimate and the recorded remaining effort. */
export const RemainingEffort: Story = {
  args: { progressMode: 'remaining-effort' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText('75%')).toBeVisible()
  },
}

/** Progress recorded by hand, with its own input. */
export const Manual: Story = {
  args: { progressMode: 'manual' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('40%')).toBeVisible()
    await expect(canvas.getByLabelText('進捗率（%）')).toBeVisible()
  },
}

/** A Work Item without an estimate, shown read-only. */
export const ReadOnlyWithoutEstimate: Story = {
  args: {
    item: { statusCategory: 'unstarted', schedule: {} },
    readOnly: true,
  },
}
