import type { Meta, StoryObj } from '@storybook/react-vite'
import { createPlanningLabels } from './labels'
import { PlanningMilestoneWatchButton } from './PlanningMilestoneWatch'

const labels = createPlanningLabels('ja')

const meta = {
  title: 'Application/Planning/MilestoneWatch',
  component: PlanningMilestoneWatchButton,
  args: {
    labels: labels.milestoneWatch,
    watch: { subscribed: false, watcherCount: 2 },
    onToggle: () => undefined,
  },
  decorators: [
    (Story) => (
      <div className="max-w-[720px] p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof PlanningMilestoneWatchButton>

export default meta

type Story = StoryObj<typeof meta>

/** The viewer does not watch the Milestone yet. */
export const NotWatching: Story = {}

/** The viewer watches the Milestone. */
export const Watching: Story = {
  args: { watch: { subscribed: true, watcherCount: 3 } },
}

/** The watch state could not be read or changed. */
export const Failed: Story = {
  args: { watch: undefined, hasError: true },
}
