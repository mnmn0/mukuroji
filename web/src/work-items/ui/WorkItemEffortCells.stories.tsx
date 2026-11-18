import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorkItemEffortCell } from './WorkItemEffortCells'

/** Metadata of the effort column cell stories. */
const meta = {
  title: 'Application/Work Items/Effort Cell',
  component: WorkItemEffortCell,
  decorators: [(Story) => <div className="w-48 bg-[var(--workbench-canvas)] p-4 text-sm"><Story /></div>],
  args: {
    field: 'estimate',
    hoursLabel: '{hours} 時間',
    item: {
      statusCategory: 'started',
      schedule: { plannedEffortMinutes: 480 },
      remainingEffortMinutes: 120,
    },
  },
} satisfies Meta<typeof WorkItemEffortCell>

export default meta
/** Typed effort cell story. */
type Story = StoryObj<typeof meta>

/** Canonical estimate in hours. */
export const Estimate: Story = {}

/** Remaining effort in hours. */
export const RemainingEffort: Story = { args: { field: 'remainingEffort' } }

/** Progress derived with the Team's remaining-effort mode. */
export const Progress: Story = {
  args: { field: 'progress', configuration: { progressMode: 'remaining-effort' } },
}

/** No estimate recorded. */
export const Unknown: Story = { args: { item: { statusCategory: 'unstarted', schedule: {} } } }
