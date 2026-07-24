import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, within } from 'storybook/test'
import { createTranslator } from '../../shared/i18n/i18n'
import {
  enterpriseProvisioningImpactFixture,
  enterpriseScimTokenResponseFixture,
  enterpriseSecuritySnapshotFixture,
} from '../fixtures'
import { SecurityProvisioningTab } from './SecurityProvisioningTab'

/** Storybook metadata for the independently rendered provisioning tab. */
const meta = {
  title: 'Application/Settings/Enterprise Security/Tabs/Provisioning',
  component: SecurityProvisioningTab,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-page)] p-6">
        <Story />
      </main>
    ),
  ],
  args: {
    impact: {
      ...enterpriseProvisioningImpactFixture,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    },
    locale: 'en',
    snapshot: enterpriseSecuritySnapshotFixture,
    t: createTranslator('en'),
    onPreview: fn(async () => ({
      ...enterpriseProvisioningImpactFixture,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    })),
    onRequestApply: fn(),
    onRequestRotateToken: fn(),
    onRetryLog: fn(async () => undefined),
    onRotateToken: fn(async () => enterpriseScimTokenResponseFixture),
  },
} satisfies Meta<typeof SecurityProvisioningTab>

export default meta

/** Story type for the enterprise security provisioning tab. */
type Story = StoryObj<typeof meta>

/** Previews reconciliation and routes apply through confirmation. */
export const PreviewInteraction: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByTestId('security-provisioning-preview'),
    )
    await expect(args.onPreview).toHaveBeenCalledTimes(1)
    const preview = canvas.getByTestId('security-provisioning-impact')
    await expect(preview).toBeInTheDocument()
    await userEvent.click(canvas.getByTestId('security-provisioning-apply'))
    await expect(args.onRequestApply).toHaveBeenCalledTimes(1)
  },
}
