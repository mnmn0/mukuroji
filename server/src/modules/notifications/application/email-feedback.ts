import { decodeEmailRecipientTag, EMAIL_RECIPIENT_TAG, hashEmailAddress, type EmailSuppression } from '../domain/email-suppression'

/** One provider feedback message waiting in the queue. */
export type EmailFeedbackMessage = {
  /** Queue handle used to acknowledge the message. */
  handle: string
  /** Raw message body, the provider's event as JSON text. */
  body: string
}

/** Queue of bounce and complaint events the provider published. */
export type EmailFeedbackQueue = {
  /** Receives at most `limit` messages; transient failures reject. */
  receive(limit: number): Promise<EmailFeedbackMessage[]>
  /** Removes handled messages so they are not received again. */
  acknowledge(messages: EmailFeedbackMessage[]): Promise<void>
}

/** Writes the recipient's suppression; an older event never replaces a newer one. */
export type EmailSuppressionRecorder = {
  /** Records or refreshes the suppression; transient failures reject. */
  record(recipientKey: string, suppression: EmailSuppression): Promise<void>
}

/** Safe logs and metrics for feedback processing, without addresses or recipient keys. */
export type EmailFeedbackTelemetry = {
  /** Reports one recorded suppression. */
  reportSuppression(reason: EmailSuppression['reason']): void
  /** Reports a message that cannot be read; it stays queued until the dead-letter queue takes it. */
  reportInvalid(): void
}

/** Ports of the feedback drain. */
export type EmailFeedbackDependencies = {
  /** Provider feedback queue. */
  queue: EmailFeedbackQueue
  /** Suppression writer. */
  store: EmailSuppressionRecorder
  /** Safe telemetry. */
  telemetry: EmailFeedbackTelemetry
  /** Clock used for the run deadline. */
  now(): Date
}

/** What one feedback event means for notification email. */
export type EmailFeedback =
  | {
    /** The event suppresses the recipient's address. */
    kind: 'suppress'
    /** Recipient partition the message was sent to. */
    recipientKey: string
    /** Suppression to record. */
    suppression: EmailSuppression
  }
  | {
    /** The event needs no action: a transient bounce, or mail this service did not send. */
    kind: 'ignore'
  }
  | {
    /** The event is malformed and needs operator attention. */
    kind: 'invalid'
  }

/** Most receive calls in one run; each takes at most ten messages. */
const MAX_RECEIVES_PER_RUN = 10

/** Time after which a run starts no new receive. */
const RUN_DEADLINE_MS = 30_000

/**
 * Records every queued bounce and complaint as a suppression, then acknowledges the messages.
 * A malformed message is left in the queue, so it reaches the dead-letter queue and its alarm.
 * @param dependencies - Queue, store, telemetry, and clock.
 * @returns Number of suppressions recorded.
 */
export async function drainEmailFeedback(dependencies: EmailFeedbackDependencies): Promise<number> {
  const deadline = dependencies.now().getTime() + RUN_DEADLINE_MS
  let recorded = 0
  let failed = false
  for (let receive = 0; receive < MAX_RECEIVES_PER_RUN && dependencies.now().getTime() < deadline; receive += 1) {
    const messages = await dependencies.queue.receive(10)
    if (messages.length === 0) break
    const handled: EmailFeedbackMessage[] = []
    for (const message of messages) {
      const feedback = parseEmailFeedback(message.body)
      if (feedback.kind === 'invalid') {
        dependencies.telemetry.reportInvalid()
        continue
      }
      if (feedback.kind === 'suppress') {
        try {
          await dependencies.store.record(feedback.recipientKey, feedback.suppression)
        } catch {
          // The message stays queued and is received again after its visibility timeout.
          failed = true
          continue
        }
        dependencies.telemetry.reportSuppression(feedback.suppression.reason)
        recorded += 1
      }
      handled.push(message)
    }
    if (handled.length > 0) await dependencies.queue.acknowledge(handled)
  }
  if (failed) throw new Error('Email feedback processing requires attention.')
  return recorded
}

/**
 * Reads one SES bounce or complaint event, as delivered by EventBridge or SNS.
 * @param body - Raw message body.
 * @returns The suppression to record, or why none is.
 */
export function parseEmailFeedback(body: string): EmailFeedback {
  let event: unknown
  try {
    event = JSON.parse(body)
  } catch {
    return { kind: 'invalid' }
  }
  if (!isRecord(event)) return { kind: 'invalid' }
  // EventBridge wraps the SES event in `detail`; SNS delivers it as the message itself.
  const detail = event.source === 'aws.ses' ? event.detail : event
  if (!isRecord(detail) || !isRecord(detail.mail)) return { kind: 'invalid' }
  const type = detail.eventType ?? detail.notificationType
  let reason: EmailSuppression['reason']
  let feedback: unknown
  let recipients: unknown
  if (type === 'Bounce') {
    if (!isRecord(detail.bounce)) return { kind: 'invalid' }
    // Transient and undetermined bounces may succeed later, so only a permanent one suppresses.
    if (detail.bounce.bounceType !== 'Permanent') return { kind: 'ignore' }
    reason = 'bounce'
    feedback = detail.bounce
    recipients = detail.bounce.bouncedRecipients
  } else if (type === 'Complaint') {
    if (!isRecord(detail.complaint)) return { kind: 'invalid' }
    if (detail.complaint.complaintFeedbackType === 'not-spam') return { kind: 'ignore' }
    reason = 'complaint'
    feedback = detail.complaint
    recipients = detail.complaint.complainedRecipients
  } else {
    return { kind: 'ignore' }
  }
  const tags = isRecord(detail.mail.tags) ? detail.mail.tags[EMAIL_RECIPIENT_TAG] : undefined
  // Mail sent through the configuration set without this tag was not a notification.
  if (tags === undefined) return { kind: 'ignore' }
  const recipientKey = Array.isArray(tags) && tags.length === 1 ? decodeEmailRecipientTag(tags[0]) : undefined
  const address = Array.isArray(recipients) && recipients.length === 1 && isRecord(recipients[0])
    ? readMailbox(recipients[0].emailAddress)
    : undefined
  const timestamp = isRecord(feedback) && typeof feedback.timestamp === 'string' ? feedback.timestamp : detail.mail.timestamp
  if (!recipientKey || !address || typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return { kind: 'invalid' }
  return {
    kind: 'suppress', recipientKey,
    suppression: { addressHash: hashEmailAddress(address), reason, suppressedAt: new Date(timestamp).toISOString() },
  }
}

/**
 * Extracts the mailbox from `addr` or `Name <addr>`.
 * @param value - Recipient field of the feedback event.
 * @returns The address, or undefined when it is not one.
 */
function readMailbox(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const bracketed = /<([^<>]+)>\s*$/.exec(value)
  const address = (bracketed?.[1] ?? value).trim()
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+$/.test(address) ? address : undefined
}

/**
 * Narrows an unknown value to a plain object.
 * @param value - Parsed JSON value.
 * @returns Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
