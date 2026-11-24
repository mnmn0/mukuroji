import { createHash } from 'node:crypto'

/** Sort key of the one suppression row each recipient partition may hold on the Notifications table. */
export const EMAIL_SUPPRESSION_KEY = '!EMAIL_SUPPRESSION'

/** Item type of the suppression row, kept out of every Inbox listing. */
export const EMAIL_SUPPRESSION_ITEM_TYPE = 'email-suppression'

/** SES message tag that carries the encoded recipient partition of a notification email. */
export const EMAIL_RECIPIENT_TAG = 'mukuroji-recipient'

/** Why an address stopped receiving notification email. */
export type EmailSuppressionReason = 'bounce' | 'complaint'

/** A recipient address that bounced permanently or complained, stored without the address itself. */
export type EmailSuppression = {
  /** SHA-256 of the trimmed, lowercased address, hex. */
  addressHash: string
  /** Feedback type that caused the suppression. */
  reason: EmailSuppressionReason
  /** When the provider reported the feedback. */
  suppressedAt: string
}

/**
 * Hashes an address so a suppression can match it without storing the address.
 * @param address - Mailbox address.
 * @returns Hex SHA-256 of the trimmed, lowercased address.
 */
export function hashEmailAddress(address: string): string {
  return createHash('sha256').update(address.trim().toLowerCase()).digest('hex')
}

/**
 * Reports whether a suppression applies to the address about to be mailed.
 * @param suppression - Active suppression of the recipient.
 * @param address - Current verified address.
 * @returns `true` when the address is the one that bounced or complained.
 */
export function isEmailAddressSuppressed(suppression: EmailSuppression, address: string): boolean {
  return suppression.addressHash === hashEmailAddress(address)
}

/**
 * Encodes a recipient partition as an SES tag value, which allows only letters, digits, `_`, and `-`.
 * @param recipientKey - `<workspaceId>#<memberKey>` partition.
 * @returns Unpadded base64url text.
 */
export function encodeEmailRecipientTag(recipientKey: string): string {
  return Buffer.from(recipientKey, 'utf8').toString('base64url')
}

/**
 * Decodes a tag value written by {@link encodeEmailRecipientTag}.
 * @param value - Tag value from the provider's feedback event.
 * @returns The recipient partition, or undefined when the value is not one.
 */
export function decodeEmailRecipientTag(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url').toString('utf8')
  if (encodeEmailRecipientTag(decoded) !== value) return undefined
  const separator = decoded.indexOf('#')
  return separator > 0 && separator < decoded.length - 1 ? decoded : undefined
}
