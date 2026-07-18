import type { Meta, StoryObj } from '@storybook/react-vite'
import { AutomationInboundWebhooksPanel } from './AutomationInboundWebhooksPanel'
import {
  activeInboundWebhookEndpointFixture,
  inboundWebhookSecretResponseFixture,
  pausedInboundWebhookEndpointFixture,
  provisioningInboundWebhookEndpointFixture,
  revokedInboundWebhookEndpointFixture,
} from './fixtures'

/** Inbound Webhook lifecycle panel の Storybook metadata です。 */
const meta = {
  title: 'Application/Automation/Inbound Webhooks',
  component: AutomationInboundWebhooksPanel,
  parameters: { layout: 'padded' },
  args: {
    endpoints: [
      provisioningInboundWebhookEndpointFixture,
      activeInboundWebhookEndpointFixture,
      pausedInboundWebhookEndpointFixture,
      revokedInboundWebhookEndpointFixture,
    ],
    locale: 'en',
    readOnly: false,
    onCreate: async () => inboundWebhookSecretResponseFixture,
    onPause: async () => undefined,
    onResume: async () => undefined,
    onRevoke: async () => undefined,
    onRotate: async () => inboundWebhookSecretResponseFixture,
  },
} satisfies Meta<typeof AutomationInboundWebhooksPanel>

export default meta

/** AutomationInboundWebhooksPanel stories の型です。 */
type Story = StoryObj<typeof meta>

/** Active、paused、revoked endpoint と lifecycle controls を表示します。 */
export const Lifecycle: Story = {}

/** Provisioning が完了しない endpoint の abort/reconfiguration 警告を表示します。 */
export const ProvisioningRecovery: Story = {
  args: {
    endpoints: [provisioningInboundWebhookEndpointFixture],
  },
}

/** Provisioning abort/reconfiguration 警告の日本語表示です。 */
export const ProvisioningRecoveryJapanese: Story = {
  args: {
    endpoints: [provisioningInboundWebhookEndpointFixture],
    locale: 'ja',
  },
}

/** Mutation controls と secret 発行導線を隠す参照専用状態です。 */
export const ReadOnly: Story = {
  args: { readOnly: true },
}
