import type { Meta, StoryObj } from '@storybook/react-vite'
import { notificationPreferencesControllerFixture } from '../fixtures'
import { NotificationSettingsPanel } from './NotificationSettingsPanel'

/** Notification preferences, including opt-in Slack delivery. */
const meta = {
  title: 'Application/Notifications/Settings',
  component: NotificationSettingsPanel,
  parameters: { layout: 'padded' },
  args: { locale: 'ja', controller: notificationPreferencesControllerFixture },
} satisfies Meta<typeof NotificationSettingsPanel>

/** Registers the notification settings stories in Storybook. */
export default meta
/** Story type for notification settings. */
type Story = StoryObj<typeof meta>
/** Default settings with Slack disabled until explicitly selected. */
export const Default: Story = {}
/** Saved opt-in with the same delivery frequency and quiet hours. */
export const SlackEnabled: Story = {
  args: {
    controller: {
      ...notificationPreferencesControllerFixture,
      preferences: {
        ...notificationPreferencesControllerFixture.preferences!,
        channels: { inApp: true, email: false, push: false, slack: true },
      },
    },
  },
}
/**
 * Saved category channels and mutes: status changes stay out of Slack, one Project is muted with
 * approvals still delivered, and a mute for a Project no longer listed can be removed.
 */
export const RoutingAndMutes: Story = {
  args: {
    controller: {
      ...notificationPreferencesControllerFixture,
      preferences: {
        ...notificationPreferencesControllerFixture.preferences!,
        channels: { inApp: true, email: false, push: false, slack: true },
        categoryChannels: { status: { slack: false }, comment: { inApp: false } },
        mutes: { projectKeys: ['core-team#brand-guideline', 'core-team#archived-project'], teamIds: [], keepMentions: true, keepApprovals: false },
      },
    },
    muteTargets: [
      {
        id: 'core-team',
        name: 'Core',
        projects: [
          { id: 'product-roadmap', name: 'Product roadmap' },
          { id: 'brand-guideline', name: 'Brand guideline' },
        ],
      },
      { id: 'design-team', name: 'Design', projects: [] },
    ],
  },
}
