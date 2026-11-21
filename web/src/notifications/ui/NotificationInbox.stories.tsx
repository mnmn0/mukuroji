import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import {
  blockerClearedNotificationFixture,
  notificationFixtures,
  notificationInboxControllerFixture,
} from '../fixtures'
import { NotificationInbox } from './NotificationInbox'

/** Inbox rows with their event labels, reasons, and localized summaries. */
const meta = {
  title: 'Application/Notifications/Inbox',
  component: NotificationInbox,
  parameters: { layout: 'padded' },
  args: { locale: 'ja', controller: notificationInboxControllerFixture },
} satisfies Meta<typeof NotificationInbox>

/** Registers the notification Inbox stories in Storybook. */
export default meta
/** Story type for the notification Inbox. */
type Story = StoryObj<typeof meta>

/** Inbox controller that lists a cleared blocker before the default notifications. */
const blockerClearedController = {
  ...notificationInboxControllerFixture,
  notifications: [blockerClearedNotificationFixture, ...notificationFixtures],
  availableEventTypes: [
    blockerClearedNotificationFixture.eventType,
    ...notificationInboxControllerFixture.availableEventTypes,
  ],
  unreadCount: notificationInboxControllerFixture.unreadCount + 1,
}

/** Default Inbox with mention, assignment, and automation notifications. */
export const Default: Story = {}

/** A cleared blocker shows a localized label and summary instead of the stored English summary. */
export const BlockerCleared: Story = {
  args: { controller: blockerClearedController },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByText('ブロック解除')[0]).toBeVisible()
    await expect(canvas.getByText('この Work Item をブロックしていた項目が解除されました。')).toBeVisible()
    await expect(canvas.queryByText('A blocker was removed.')).toBeNull()
  },
}

/** The cleared blocker in English. */
export const BlockerClearedEnglish: Story = {
  args: { controller: blockerClearedController, locale: 'en' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByText('Blocker cleared')[0]).toBeVisible()
    await expect(canvas.getByText('A blocker of this work item was removed.')).toBeVisible()
  },
}
