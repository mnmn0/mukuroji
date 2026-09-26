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
