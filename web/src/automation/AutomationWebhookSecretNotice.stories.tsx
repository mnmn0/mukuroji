import type { Meta, StoryObj } from '@storybook/react-vite'
import { AutomationWebhookSecretNotice } from './AutomationInboundWebhooksPanel'

/** One-time Webhook secret notice の Storybook metadata です。 */
const meta = {
  title: 'Application/Automation/Inbound Webhook Secret',
  component: AutomationWebhookSecretNotice,
  parameters: { layout: 'padded' },
  args: {
    endpointName: 'Release events',
    locale: 'en',
    signingSecret: 'whsec_storybook_one_time_only',
    onDismiss: () => undefined,
  },
} satisfies Meta<typeof AutomationWebhookSecretNotice>

export default meta

/** AutomationWebhookSecretNotice stories の型です。 */
type Story = StoryObj<typeof meta>

/** Create/rotate response 直後だけ表示する secret です。 */
export const OneTimeSecret: Story = {}
