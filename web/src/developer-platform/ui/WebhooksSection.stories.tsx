import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import {
  deliveryFailureDeveloperPlatformResourcesFixture,
  developerPlatformLabelsFixture,
  developerPlatformResourcesFixture,
  emptyDeveloperPlatformResourcesFixture,
  readOnlyDeveloperPlatformResourcesFixture,
} from '../fixtures'
import { formatDeveloperTimestamp } from '../model/displayFormatting'
import { WebhooksSection } from './WebhooksSection'

/**
 * Storybook metadata for the standalone Developer Platform webhooks section.
 */
const meta = {
  title: 'Application/Developer Platform/Webhooks',
  component: WebhooksSection,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-[var(--workbench-canvas)] p-6 max-[720px]:p-3">
        <section className="workbench-panel p-5">
          <Story />
        </section>
      </main>
    ),
  ],
  args: {
    canManage:
      developerPlatformResourcesFixture.capabilities.canManageWebhooks,
    deliveries: developerPlatformResourcesFixture.webhookDeliveries,
    formatDateTime: formatDeveloperTimestamp,
    labels: developerPlatformLabelsFixture,
    subscriptions: developerPlatformResourcesFixture.webhookSubscriptions,
    onCreate: fn(),
    onReplay: fn(),
    onRevoke: fn(),
    onRotate: fn(),
  },
} satisfies Meta<typeof WebhooksSection>

export default meta

/**
 * Story type for the standalone webhooks section.
 */
type Story = StoryObj<typeof meta>

/**
 * Displays active webhook subscriptions and successful delivery history.
 */
export const Default: Story = {}

/**
 * Displays first-use empty states for subscriptions and deliveries.
 */
export const Empty: Story = {
  args: {
    deliveries: emptyDeveloperPlatformResourcesFixture.webhookDeliveries,
    subscriptions:
      emptyDeveloperPlatformResourcesFixture.webhookSubscriptions,
  },
}

/**
 * Displays webhook metadata without creation, rotation, revoke, or replay actions.
 */
export const ReadOnly: Story = {
  args: {
    canManage:
      readOnlyDeveloperPlatformResourcesFixture.capabilities.canManageWebhooks,
    deliveries: readOnlyDeveloperPlatformResourcesFixture.webhookDeliveries,
    subscriptions:
      readOnlyDeveloperPlatformResourcesFixture.webhookSubscriptions,
  },
}

/**
 * Displays a failed delivery with its replay action and failure count.
 */
export const DeliveryFailure: Story = {
  args: {
    deliveries:
      deliveryFailureDeveloperPlatformResourcesFixture.webhookDeliveries,
    subscriptions:
      deliveryFailureDeveloperPlatformResourcesFixture.webhookSubscriptions,
  },
}
