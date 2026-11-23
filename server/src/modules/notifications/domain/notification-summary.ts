import { formatNotificationMessage, type NotificationMessage, type NotificationMessageLocale } from '@mukuroji/contracts'

/** Notification fields that hold its system-written summary. */
export type NotificationSummarySource = {
  /** Stored English summary, kept for rows written before message codes existed. */
  summary?: string
  /** Code and values of the summary, when the row has them. */
  message?: NotificationMessage
}

/** Language used when the recipient has not chosen one. */
export const DEFAULT_NOTIFICATION_LOCALE: NotificationMessageLocale = 'ja'

/**
 * Writes a notification summary in the recipient's language.
 *
 * @param notification - Stored summary and its optional message code.
 * @param locale - Recipient language.
 * @returns The summary from the message code, or the stored text when the row has no code.
 */
export function resolveNotificationSummaryText(
  notification: NotificationSummarySource,
  locale: NotificationMessageLocale,
): string | undefined {
  return notification.message ? formatNotificationMessage(notification.message, locale) : notification.summary
}
