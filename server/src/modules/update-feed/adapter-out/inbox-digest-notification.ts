import { createNotificationRecipientKey } from '../../notifications'
import type { InboxDigestMessage, InboxDigestRecipient } from '../application/inbox-digest'

/** Creates an existing-format Inbox row with no canonical report data or external channel.
 * This row and the delivery receipt MUST be inserted atomically by InboxDigestStore.
 * @param recipient - Server-resolved recipient.
 * @param message - Deterministic content-free delivery.
 * @param locale - Recipient language resolved by composition.
 * @param archived - Whether the member's category settings keep the row out of the unread Inbox.
 * @returns An ordinary Inbox row, readable by the existing Notification client.
 */
export function createInboxDigestNotification(recipient: InboxDigestRecipient, message: InboxDigestMessage, locale: 'ja' | 'en' = 'en', archived = false) {
  const recipientKey = createNotificationRecipientKey(recipient.workspaceId, recipient.memberKey)
  const inboxState = archived ? 'archived' : 'unread'
  return {
    recipientKey,
    notificationKey: `${message.occurredAt}#${message.id}`,
    recipientStatusKey: `${recipientKey}#${inboxState}`,
    itemType: 'notification',
    version: 1,
    inboxState,
    ...(archived ? { archivedAt: message.occurredAt } : {}),
    inAppVisible: true,
    eventId: message.id,
    eventType: 'update-feed.digest',
    occurredAt: message.occurredAt,
    createdAt: message.occurredAt,
    workspaceId: recipient.workspaceId,
    recipientMemberKey: recipient.memberKey,
    title: locale === 'ja' ? '更新ダイジェストを確認できます' : 'Update digest available',
    deepLink: message.deepLink,
    reasons: ['digest'],
    deliveryChannels: archived ? [] : ['inApp'],
    expiresAt: Math.floor(Date.parse(message.occurredAt) / 1000) + 365 * 86_400,
  }
}
