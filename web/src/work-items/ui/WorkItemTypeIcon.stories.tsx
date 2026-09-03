import type { Meta, StoryObj } from '@storybook/react-vite'
import { WorkItemTypeIcon } from './WorkItemTypeIcon'

/** Storybook metadata for the shared Work Item Type icon boundary. */
const meta = {
  title: 'Application/Work Items/Work Item Type Icon',
  component: WorkItemTypeIcon,
  args: {
    className: 'h-6 w-6 fill-none stroke-current stroke-2',
    iconToken: 'bug',
  },
  decorators: [
    (Story) => (
      <div className="flex min-h-24 items-center justify-center bg-[var(--workbench-page)] p-6 text-[var(--workbench-primary)]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkItemTypeIcon>

export default meta

/** Story type for one Work Item Type icon state. */
type Story = StoryObj<typeof meta>

/** A registered configuration token resolves to its shared icon. */
export const RegisteredToken: Story = {
  args: { iconToken: 'bug' },
}

/** An unknown configuration token resolves to the safe generic fallback icon. */
export const UnknownTokenFallback: Story = {
  args: { iconToken: 'unregistered-token' },
}
