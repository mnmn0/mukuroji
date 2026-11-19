import type { ChannelDelivery, ChannelSendResult } from '../../application/channel-delivery'

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

/**
 * Creates a sender that mails one notification to the recipient's current verified Cognito address.
 * @param options - Sender identity, application origin, recipient reader, and provider transport.
 * @returns Recipient-bound notification sender.
 */
export function createEmailNotificationSender(options: EmailNotificationSenderOptions) {
  return async (delivery: ChannelDelivery): Promise<ChannelSendResult> => {
    const signal = AbortSignal.timeout(options.deadlineMs ?? EMAIL_SEND_DEADLINE_MS)
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
    try {
      await options.sendEmail({
        from: options.sender, to: address,
        ...renderEmailNotification(delivery, options.appOrigin),
      }, signal)
      return { succeeded: true, retryable: false }
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (PERMANENT_PROVIDER_ERRORS.has(name)) return { succeeded: false, retryable: false, code: 'EmailDeliveryRejected' }
      if (RETRYABLE_PROVIDER_ERRORS.has(name)) return { succeeded: false, retryable: true, code: 'EmailRateLimited' }
      // An unknown failure may follow an accepted send; bounded retries accept a rare duplicate.
      return { succeeded: false, retryable: true, code: 'EmailDeliveryUnavailable' }
    }
  }
}

/**
 * Renders the bilingual plain-text message for one notification.
 * Plain text only, so stored titles and summaries cannot inject markup.
 * @param delivery - Delivery with validated notification contents.
 * @param appOrigin - Web application origin for the deep link.
 * @returns Subject and body.
 */
export function renderEmailNotification(delivery: ChannelDelivery, appOrigin: string): Pick<EmailMessage, 'subject' | 'text'> {
  const notification = delivery.notification
  const heading = singleLine(notification.title) || singleLine(notification.summary) || 'mukuroji'
  const subject = `[mukuroji] ${heading}`.slice(0, 200)
  const link = resolveDeepLink(notification.deepLink, appOrigin)
  const text = [
    singleLine(notification.title),
    notification.summary?.replace(/\r\n?/g, '\n').trim().slice(0, 2_000),
    notification.reasons.length > 0 ? `通知の理由 / Reason: ${notification.reasons.join(', ')}` : undefined,
    '',
    `mukuroji で開く / Open in mukuroji: ${link}`,
    '',
    '--',
    'mukuroji の通知設定で Email を有効にしているため、このメールを送信しました。停止するには通知設定で Email を無効にしてください。',
    'You received this email because Email notifications are on in your mukuroji notification settings. Turn Email off there to stop these emails.',
  ].filter((line): line is string => line !== undefined).join('\n')
  return { subject, text }
}

/**
 * Resolves an Inbox deep link against the application origin, refusing links to other origins.
 * @param deepLink - Stored relative path.
 * @param appOrigin - Web application origin.
 * @returns Absolute URL on the application origin.
 */
function resolveDeepLink(deepLink: string | undefined, appOrigin: string): string {
  const origin = new URL(appOrigin).origin
  if (!deepLink || !deepLink.startsWith('/') || deepLink.startsWith('//') || deepLink.includes('\\')) return `${origin}/`
  const url = new URL(deepLink, origin)
  return url.origin === origin ? url.href : `${origin}/`
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
