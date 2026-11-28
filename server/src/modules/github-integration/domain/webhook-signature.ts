import { createHmac, timingSafeEqual } from 'node:crypto'

/** `X-Hub-Signature-256` value: `sha256=` and 64 lowercase hexadecimal digits. */
const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/u

/**
 * Verifies GitHub's `X-Hub-Signature-256` header of a webhook delivery (ADR 0079).
 *
 * GitHub signs the exact raw body with HMAC-SHA256 and the App's webhook secret. Every configured
 * secret is tried, so a rotation can keep the previous secret valid until GitHub uses the new one.
 * The comparison is constant-time for each secret.
 *
 * @param secrets - Current webhook secret, then the previous one during a rotation.
 * @param rawBody - Exact request body bytes.
 * @param header - Untrusted `X-Hub-Signature-256` header.
 * @returns True when one secret produced the signature.
 */
export function verifyGitHubWebhookSignature(
  secrets: readonly string[],
  rawBody: Uint8Array,
  header: string | undefined,
): boolean {
  const match = header === undefined ? null : SIGNATURE_PATTERN.exec(header.trim())
  if (!match) return false
  const received = Buffer.from(match[1], 'hex')
  let verified = false
  for (const secret of secrets) {
    if (secret.length === 0) continue
    const expected = createHmac('sha256', secret).update(rawBody).digest()
    // Every secret is compared, so the time does not tell which one matched.
    if (expected.length === received.length && timingSafeEqual(expected, received)) verified = true
  }
  return verified
}

/**
 * Signs a body as GitHub does, for tests and local delivery tools.
 *
 * @param secret - Webhook secret.
 * @param rawBody - Body bytes.
 * @returns The `X-Hub-Signature-256` header value.
 */
export function signGitHubWebhookBody(secret: string, rawBody: Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`
}
