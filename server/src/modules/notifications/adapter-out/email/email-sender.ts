import { formatNotificationReasons, type NotificationMessageLocale } from '@mukuroji/contracts'
import type { ChannelDelivery, ChannelSendResult, NotificationLocaleReader } from '../../application/channel-delivery'
import { DEFAULT_NOTIFICATION_LOCALE, resolveNotificationSummaryText } from '../../domain/notification-summary'
import { isEmailAddressSuppressed, type EmailSuppression } from '../../domain/email-suppression'
import { formatNotificationHeading, resolveNotificationLinks } from '../notification-links'

/** Current Cognito Email address of a recipient, or why none can be used. */
export type EmailRecipientLookup =
  | {
    /** The recipient has a verified address. */
    kind: 'verified'
    /** Verified address read from the recipient's Cognito profile. */
    address: string
  }
  | {
    /** The recipient no longer exists or has no verified address. */
    kind: 'missing' | 'unverified'
  }

/** Reads the recipient's current verified Email address within the deadline; transient failures throw. */
export type EmailRecipientReader = (delivery: ChannelDelivery, signal: AbortSignal) => Promise<EmailRecipientLookup>

/** One plain-text message handed to the Email provider. */
export type EmailMessage = {
  /** Verified sender identity configured at deploy time. */
  from: string
  /** Single recipient address. */
  to: string
  /** Single-line subject. */
  subject: string
  /** Plain-text body. */
  text: string
  /** Recipient partition, so a later bounce or complaint can be traced back without the address. */
  recipientKey: string
}

/** Provider boundary bound to the deadline; rejects with the provider's named error on failure. */
export type EmailTransport = (message: EmailMessage, signal: AbortSignal) => Promise<void>

/** Deploy-time configuration and ports for the Email sender. */
export type EmailNotificationSenderOptions = {
  /** Verified sender address. */
  sender: string
  /** Web application origin that resolves Inbox deep links. */
  appOrigin: string
  /** Current recipient address reader. */
  readRecipient: EmailRecipientReader
  /** Provider send operation. */
  sendEmail: EmailTransport
  /** Recipient language reader; without one the summary is written in Japanese. */
  readLocale?: NotificationLocaleReader
  /**
   * Reads the recipient's active bounce or complaint suppression; transient failures reject.
   * Without it, no address is suppressed.
   */
  readSuppression?: (delivery: ChannelDelivery, signal: AbortSignal) => Promise<EmailSuppression | undefined>
  /**
   * Deadline for the whole lookup and send, in milliseconds. It stays well inside the 60-second
   * lease renewed just before sending, so a slow lookup can never send after another worker
   * reclaims the notification.
   */
  deadlineMs?: number
}

/** Default deadline for lookup and send, half of the renewed delivery lease. */
const EMAIL_SEND_DEADLINE_MS = 30_000

/** Provider errors that a later attempt can fix without operator action. */
const RETRYABLE_PROVIDER_ERRORS = new Set([
  'TooManyRequestsException', 'LimitExceededException', 'SendingPausedException',
  'InternalFailure', 'ServiceUnavailable', 'ServiceUnavailableException', 'ThrottlingException', 'TimeoutError',
])

/** Provider errors that will fail again until an operator fixes the sender or account. */
const PERMANENT_PROVIDER_ERRORS = new Set([
  'MessageRejected', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException',
  'NotFoundException', 'BadRequestException', 'AccessDeniedException',
])

/** A recipient address and language that passed every pre-send check. */
type ResolvedEmailRecipient = {
  /** Verified, deliverable address. */
  address: string
  /** Recipient language for system-written text. */
  locale: NotificationMessageLocale
}

/**
 * Reads and checks the recipient's current address, suppression, and language within the deadline.
 * @param options - Sender ports.
 * @param delivery - Delivery whose recipient is resolved.
 * @param signal - Deadline signal; a lookup that outlives it never sends.
 * @returns The recipient, or the outcome to record instead of sending.
 */
async function resolveEmailRecipient(
  options: EmailNotificationSenderOptions,
  delivery: ChannelDelivery,
  signal: AbortSignal,
): Promise<ResolvedEmailRecipient | ChannelSendResult> {
  let recipient: EmailRecipientLookup
  try {
    recipient = await options.readRecipient(delivery, signal)
  } catch {
    return { succeeded: false, retryable: true, code: 'EmailRecipientUnavailable' }
  }
  // A lookup that outlived the deadline never sends; the lease may already belong to a newer claim.
  if (signal.aborted) return { succeeded: false, retryable: true, code: 'EmailRecipientUnavailable' }
  if (recipient.kind === 'missing') return { succeeded: false, retryable: false, suppressed: true, code: 'EmailRecipientMissing' }
  const address = recipient.kind === 'verified' ? recipient.address.trim() : ''
  if (!isDeliverableAddress(address)) {
    return { succeeded: false, retryable: false, suppressed: true, code: 'EmailRecipientUnverified' }
  }
  let suppression: EmailSuppression | undefined
  try {
    suppression = await options.readSuppression?.(delivery, signal)
  } catch {
    return { succeeded: false, retryable: true, code: 'EmailSuppressionUnavailable' }
  }
  if (signal.aborted) return { succeeded: false, retryable: true, code: 'EmailSuppressionUnavailable' }
  // Only the address that bounced or complained is suppressed; a changed address is mailed again.
  if (suppression && isEmailAddressSuppressed(suppression, address)) {
    return { succeeded: false, retryable: false, suppressed: true, code: 'EmailRecipientSuppressed' }
  }
  let locale: NotificationMessageLocale
  try {
    locale = options.readLocale ? await options.readLocale(delivery, signal) : DEFAULT_NOTIFICATION_LOCALE
  } catch {
    return { succeeded: false, retryable: true, code: 'NotificationLocaleUnavailable' }
  }
  if (signal.aborted) return { succeeded: false, retryable: true, code: 'NotificationLocaleUnavailable' }
  return { address, locale }
}

/**
 * Hands one rendered message to the provider and maps its outcome.
 * @param options - Sender identity and transport.
 * @param message - Rendered message.
 * @param signal - Deadline signal.
 * @returns Safe transport outcome.
 */
async function sendRenderedEmail(options: EmailNotificationSenderOptions, message: EmailMessage, signal: AbortSignal): Promise<ChannelSendResult> {
  try {
    await options.sendEmail(message, signal)
    return { succeeded: true, retryable: false }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (PERMANENT_PROVIDER_ERRORS.has(name)) return { succeeded: false, retryable: false, code: 'EmailDeliveryRejected' }
    if (RETRYABLE_PROVIDER_ERRORS.has(name)) return { succeeded: false, retryable: true, code: 'EmailRateLimited' }
    // An unknown failure may follow an accepted send; bounded retries accept a rare duplicate.
    return { succeeded: false, retryable: true, code: 'EmailDeliveryUnavailable' }
  }
}

/**
 * Creates a sender that mails one notification to the recipient's current verified Cognito address.
 * @param options - Sender identity, application origin, recipient reader, and provider transport.
 * @returns Recipient-bound notification sender.
 */
export function createEmailNotificationSender(options: EmailNotificationSenderOptions) {
  return async (delivery: ChannelDelivery): Promise<ChannelSendResult> => {
    const signal = AbortSignal.timeout(options.deadlineMs ?? EMAIL_SEND_DEADLINE_MS)
    const recipient = await resolveEmailRecipient(options, delivery, signal)
    if (!('address' in recipient)) return recipient
    return sendRenderedEmail(options, {
      from: options.sender, to: recipient.address, recipientKey: delivery.recipientKey,
      ...renderEmailNotification(delivery, options.appOrigin, recipient.locale),
    }, signal)
  }
}

/**
 * Creates a sender that mails several notifications of one recipient as one digest message.
 * @param options - Sender identity, application origin, recipient reader, and provider transport.
 * @returns Digest sender; every delivery must share one recipient.
 */
export function createEmailDigestSender(options: EmailNotificationSenderOptions) {
  return async (deliveries: ChannelDelivery[]): Promise<ChannelSendResult> => {
    const [first] = deliveries
    if (!first || deliveries.some((delivery) => delivery.recipientKey !== first.recipientKey)) {
      throw new Error('An Email digest needs deliveries of one recipient.')
    }
    const signal = AbortSignal.timeout(options.deadlineMs ?? EMAIL_SEND_DEADLINE_MS)
    const recipient = await resolveEmailRecipient(options, first, signal)
    if (!('address' in recipient)) return recipient
    return sendRenderedEmail(options, {
      from: options.sender, to: recipient.address, recipientKey: first.recipientKey,
      ...(deliveries.length === 1
        ? renderEmailNotification(first, options.appOrigin, recipient.locale)
        : renderEmailDigest(deliveries, options.appOrigin, recipient.locale)),
    }, signal)
  }
}

/** Closing lines of every notification email. */
const EMAIL_FOOTER = [
  '--',
  'mukuroji の通知設定で Email を有効にしているため、このメールを送信しました。停止するには通知設定で Email を無効にしてください。',
  'You received this email because Email notifications are on in your mukuroji notification settings. Turn Email off there to stop these emails.',
]

/**
 * Renders one plain-text digest listing several notifications, oldest first.
 * @param deliveries - Deliveries of one recipient with validated notification contents.
 * @param appOrigin - Web application origin for the deep links.
 * @param locale - Recipient language for the system-written summaries.
 * @returns Subject and body.
 */
export function renderEmailDigest(
  deliveries: ChannelDelivery[],
  appOrigin: string,
  locale: NotificationMessageLocale = DEFAULT_NOTIFICATION_LOCALE,
): Pick<EmailMessage, 'subject' | 'text'> {
  const ordered = [...deliveries].sort((left, right) => left.notification.occurredAt.localeCompare(right.notification.occurredAt))
  const entries = ordered.flatMap((delivery, index) => {
    const notification = delivery.notification
    const summary = resolveNotificationSummaryText(notification, locale)
    const heading = singleLine(formatNotificationHeading(notification)) || singleLine(summary) || 'mukuroji'
    const links = resolveNotificationLinks(notification, appOrigin)
    return [
      `${index + 1}. ${heading}`,
      ...(summary && singleLine(summary) !== heading ? [`   ${singleLine(summary)}`] : []),
      `   ${links.open}`,
      '',
    ]
  })
  return {
    subject: `[mukuroji] 通知のまとめ（${ordered.length} 件） / Notification digest (${ordered.length})`,
    text: [
      `mukuroji の新しい通知が ${ordered.length} 件あります。 / You have ${ordered.length} new mukuroji notifications.`,
      '',
      ...entries,
      ...EMAIL_FOOTER,
    ].join('\n'),
  }
}

/**
 * Renders the bilingual plain-text message for one notification.
 * Plain text only, so stored titles and summaries cannot inject markup.
 * @param delivery - Delivery with validated notification contents.
 * @param appOrigin - Web application origin for the deep link.
 * @param locale - Recipient language for the system-written summary.
 * @returns Subject and body.
 */
export function renderEmailNotification(
  delivery: ChannelDelivery,
  appOrigin: string,
  locale: NotificationMessageLocale = DEFAULT_NOTIFICATION_LOCALE,
): Pick<EmailMessage, 'subject' | 'text'> {
  const notification = delivery.notification
  const summary = resolveNotificationSummaryText(notification, locale)
  const title = singleLine(formatNotificationHeading(notification))
  const heading = title || singleLine(summary) || 'mukuroji'
  const subject = `[mukuroji] ${heading}`.slice(0, 200)
  const links = resolveNotificationLinks(notification, appOrigin)
  const link = links.open
  const reasons = formatNotificationReasons(notification.reasons, locale)
  const text = [
    title,
    summary?.replace(/\r\n?/g, '\n').trim().slice(0, 2_000),
    reasons ? `${locale === 'ja' ? '通知の理由' : 'Reason'}: ${reasons}` : undefined,
    '',
    `mukuroji で開く / Open in mukuroji: ${link}`,
    ...(links.workItemKey ? [`${links.workItemKey.key}: ${links.workItemKey.url}`] : []),
    '',
    ...EMAIL_FOOTER,
  ].filter((line): line is string => line !== undefined).join('\n')
  return { subject, text }
}

/**
 * Collapses a stored value to one header-safe line.
 * @param value - Stored title or summary.
 * @returns Trimmed single line, or an empty string.
 */
function singleLine(value: string | undefined): string {
  const characters = [...(value ?? '')].map((character) => {
    const code = character.charCodeAt(0)
    return code < 0x20 || code === 0x7f ? ' ' : character
  })
  return characters.join('').replace(/ {2,}/g, ' ').trim().slice(0, 180)
}

/**
 * Rejects addresses the provider would treat as several recipients or headers.
 * @param address - Address read from the identity profile.
 * @returns Whether the value is a single plausible mailbox.
 */
function isDeliverableAddress(address: string): boolean {
  return address.length <= 254 && /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(address)
}
