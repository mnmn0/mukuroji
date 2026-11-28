import { createHmac, timingSafeEqual } from 'node:crypto'

/** Seconds a signed Slack request stays acceptable, as Slack recommends. */
export const SLACK_SIGNATURE_TOLERANCE_SECONDS = 300

/** Signed fields of one Slack request. */
export type SlackSignedRequest = {
  /** `X-Slack-Request-Timestamp` header value. */
  timestamp: string | undefined
  /** `X-Slack-Signature` header value. */
  signature: string | undefined
  /** Raw request body exactly as received. */
  rawBody: string
}

/**
 * Verifies a Slack request signature: `v0=` and the hex HMAC-SHA256 of `v0:<timestamp>:<body>`
 * keyed with the app's signing secret, compared in constant time.
 *
 * @param signingSecret - Slack app signing secret.
 * @param request - Signed header values and raw body.
 * @param nowSeconds - Current Unix time in seconds.
 * @returns Whether the request is fresh and signed with the secret.
 */
export function verifySlackSignature(
  signingSecret: string,
  request: SlackSignedRequest,
  nowSeconds: number,
): boolean {
  const { timestamp, signature, rawBody } = request
  if (!signingSecret || !timestamp || !signature) return false
  if (!/^[0-9]{1,12}$/u.test(timestamp)) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > SLACK_SIGNATURE_TOLERANCE_SECONDS) return false
  if (!/^v0=[0-9a-f]{64}$/u.test(signature)) return false
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(signature, 'utf8'))
}
