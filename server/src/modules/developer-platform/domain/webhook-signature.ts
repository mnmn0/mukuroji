import { createHmac } from 'node:crypto'
import { DeveloperPlatformError } from '../errors'
import { readPositiveInteger, readRequiredText } from './validation'

/** Version prefix used by Mukuroji Webhook signatures. */
export const WEBHOOK_SIGNATURE_VERSION = 'v1'

/**
 * Creates an HMAC-SHA256 Webhook signature for a timestamped payload.
 *
 * @param signingSecret - Subscription signing secret.
 * @param timestamp - Integer epoch seconds included in the signed message.
 * @param payload - Exact request body bytes represented as a string.
 * @returns A version-prefixed hexadecimal signature.
 */
export function createWebhookSignature(
  signingSecret: string,
  timestamp: number,
  payload: string,
) {
  const secret = readRequiredText(signingSecret, 'Webhook signing secret')
  if (typeof payload !== 'string') {
    throw new DeveloperPlatformError(
      400,
      'WebhookPayloadInvalid',
      'Webhook payload must be a string.',
    )
  }
  const normalizedTimestamp = readPositiveInteger(
    timestamp,
    'Webhook signature timestamp',
  )
  const digest = createHmac('sha256', secret)
    .update(`${normalizedTimestamp}.${payload}`)
    .digest('hex')
  return `${WEBHOOK_SIGNATURE_VERSION}=${digest}`
}
