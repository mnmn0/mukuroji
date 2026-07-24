import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { enterpriseSecuritySnapshotFixture } from '../fixtures'
import { resolveEnterpriseSsoPrerequisites } from '../model/enterpriseSecurityReadiness'
import { SecurityOverviewTab } from './SecurityOverviewTab'

/** Storybook metadata for the independently rendered overview tab. */
const meta = {
  title: 'Application/Settings/Enterprise Security/Tabs/Overview',
  component: SecurityOverviewTab,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <Story />
      </main>
    ),
  ],
  args: {
    prerequisites: resolveEnterpriseSsoPrerequisites(
      enterpriseSecuritySnapshotFixture,
    ),
    snapshot: enterpriseSecuritySnapshotFixture,
    t: createTranslator('en'),
    onSelectTab: fn(),
  },
} satisfies Meta<typeof SecurityOverviewTab>

export default meta

/** Story type for the enterprise security overview tab. */
type Story = StoryObj<typeof meta>

/** Exercises the overview shortcut into identity administration. */
export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole('button', { name: /Review identity connections/i }),
    )
    await expect(args.onSelectTab).toHaveBeenCalledWith('identity')
  },
}
