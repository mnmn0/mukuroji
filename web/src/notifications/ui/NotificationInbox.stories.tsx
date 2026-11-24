import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import {
  blockerClearedNotificationFixture,
  notificationFixtures,
  notificationInboxControllerFixture,
  overdueMessageNotificationFixture,
} from '../fixtures'
import type { InboxNotification } from '../api'
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

/** The stored English summary of the coded notification, as an older row without a code has it. */
const legacyOverdueNotification: InboxNotification = { ...overdueMessageNotificationFixture, message: undefined }

/** Inbox controller that lists a coded overdue notification and the same notification without its code. */
const messageSummaryController = {
  ...notificationInboxControllerFixture,
  notifications: [
    overdueMessageNotificationFixture,
    { ...legacyOverdueNotification, id: 'notification-overdue-legacy', eventId: 'event-overdue-legacy' },
  ],
  availableEventTypes: [overdueMessageNotificationFixture.eventType],
  unreadCount: 2,
}

/** A coded summary is written in Japanese; a row without a code keeps its stored English text. */
export const MessageSummary: Story = {
  args: { controller: messageSummaryController },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText('「リリース手順を作る」は期限を過ぎています。')).toBeVisible()
    await expect(canvas.getByText('Work Item "リリース手順を作る" is overdue.')).toBeVisible()
  },
}

/** The coded summary in English. */
export const MessageSummaryEnglish: Story = {
  args: { controller: messageSummaryController, locale: 'en' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getAllByText('Work Item "リリース手順を作る" is overdue.')).toHaveLength(2)
    await expect(canvas.queryByText('「リリース手順を作る」は期限を過ぎています。')).toBeNull()
  },
}
