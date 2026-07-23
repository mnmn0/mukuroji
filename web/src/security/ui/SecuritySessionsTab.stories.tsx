import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import { enterpriseSecuritySnapshotFixture } from '../fixtures'
import { SecuritySessionsTab } from './SecuritySessionsTab'

/** Storybook metadata for the independently rendered sessions tab. */
const meta = {
  title: 'Application/Settings/Enterprise Security/Tabs/Sessions',
  component: SecuritySessionsTab,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <Story />
      </main>
    ),
  ],
  args: {
    snapshot: enterpriseSecuritySnapshotFixture,
    t: createTranslator('en'),
    onPreview: fn(async () => ({
      callerAllowed: true,
      callerIp: '203.0.113.24',
      requiresConfirmation: false,
      warnings: [],
    })),
    onRequestConfirmation: fn(),
    onUpdate: fn(async () => undefined),
  },
} satisfies Meta<typeof SecuritySessionsTab>

export default meta

/** Story type for the enterprise security sessions tab. */
type Story = StoryObj<typeof meta>

/** Previews and saves a valid session-policy draft. */
export const SaveInteraction: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole('checkbox', { name: /Require multi-factor/i }),
    )
    await userEvent.click(
      canvas.getByTestId('security-session-policy-save'),
    )
    await expect(args.onPreview).toHaveBeenCalledTimes(1)
    await expect(args.onUpdate).toHaveBeenCalledTimes(1)
  },
}
