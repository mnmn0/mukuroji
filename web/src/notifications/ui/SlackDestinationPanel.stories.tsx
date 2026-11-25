import type { Meta, StoryObj } from '@storybook/react-vite'
import { createTranslator } from '../../shared/i18n/i18n'
import type { SlackDestinationController } from '../mutations/useSlackDestination'
import { SlackDestinationPanel } from './SlackDestinationPanel'

/** Controller whose first read has not finished, with no-op actions for stories. */
const loadingController: SlackDestinationController = {
  loadFailed: false,
  pending: false,
  retry: () => undefined,
  save: async () => true,
  remove: () => undefined,
  test: () => undefined,
}

/** Controller of a registered Team channel. */
const channelController: SlackDestinationController = {
  ...loadingController,
  view: { configured: true, label: '#core-team', locale: 'ja', canManage: true },
}

/** Registers, tests, and removes a Slack Incoming Webhook without showing the stored URL. */
const meta = {
  title: 'Application/Notifications/Slack Destination',
  component: SlackDestinationPanel,
  parameters: { layout: 'padded' },
  args: { kind: 'team', controller: channelController, t: createTranslator('ja') },
} satisfies Meta<typeof SlackDestinationPanel>

/** Registers the Slack destination stories in Storybook. */
export default meta
/** Story type for the Slack destination card. */
type Story = StoryObj<typeof meta>
/** A Team manager sees the registered Team channel. */
export const TeamChannel: Story = {}
/** A Project channel that is not registered yet. */
export const ProjectChannelEmpty: Story = {
  args: { kind: 'project', controller: { ...channelController, view: { configured: false, locale: 'en', canManage: true } } },
}
/** The member's own destination after a test reached Slack. */
export const Personal: Story = {
  args: { kind: 'personal', controller: { ...channelController, view: { configured: true, canManage: true }, outcome: { kind: 'tested' } } },
}
/** A Team viewer sees the channel read-only. */
export const ReadOnly: Story = {
  args: { controller: { ...channelController, view: { configured: true, label: '#core-team', locale: 'ja', canManage: false } } },
}
/** A change or test is running. */
export const Pending: Story = { args: { controller: { ...channelController, pending: true } } }
/** The state is still loading. */
export const Loading: Story = { args: { controller: loadingController } }
/** The first read failed. */
export const LoadError: Story = { args: { controller: { ...loadingController, loadFailed: true } } }
/** Slack did not accept the test message. */
export const TestFailed: Story = {
  args: { controller: { ...channelController, outcome: { kind: 'test-failed', code: 'SlackDeliveryRejected' } } },
}
/** A save was refused because someone else changed the channel first. */
export const Conflict: Story = {
  args: { controller: { ...channelController, outcome: { kind: 'error', code: 'NotificationDestinationConflict' } } },
}
