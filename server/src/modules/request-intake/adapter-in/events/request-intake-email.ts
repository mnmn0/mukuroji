import { createHmac, timingSafeEqual } from 'node:crypto'
import type { RequestEmailEnvelope, RequestRequesterReplyReceipt } from '@mukuroji/contracts'
import {
  RequestIntakeError,
  type RequestIntakeClient,
} from '../../request-intake'

/** Signed email adapter invocation の最大 clock skew 秒です。 */
export const REQUEST_EMAIL_SIGNATURE_TOLERANCE_SECONDS = 300

/** Email provider adapter が専用 ingestion Lambda へ渡す signed event です。 */
export type SignedRequestEmailEvent = {
  /** HMAC 対象 envelope を作成した Unix epoch seconds です。 */
  timestamp: number
  /** Request thread へ保存する allowlist 済み email envelope です。 */
  envelope: RequestEmailEnvelope
  /** `timestamp.envelope` に対する lowercase hex HMAC-SHA256 です。 */
  signature: string
}

/** Adapter と Lambda が共有する deterministic email event signature を作成します。 */
export function createRequestEmailSignature(
  timestamp: number,
  envelope: RequestEmailEnvelope,
  secret: string,
) {
  return createHmac('sha256', requireEmailSecret(secret))
    .update(`${timestamp}.${stableStringify(envelope)}`)
    .digest('hex')
}

/** 明示的な ingestion client に束縛された signed email handler を作成します。 */
export function createRequestEmailHandler(
  client: RequestIntakeClient,
  readSecret: () => unknown = () =>
    readEnvironment('REQUEST_EMAIL_WEBHOOK_SECRET'),
) {
  return async (
    event: SignedRequestEmailEvent,
  ): Promise<RequestRequesterReplyReceipt> => {
    const secret = requireEmailSecret(readSecret())
    validateSignedEmailEvent(event, secret, new Date())
    return client.ingestEmail(event.envelope)
  }
}

/** Signed email event の HMAC と replay window を検証します。 */
export function validateSignedEmailEvent(
  event: SignedRequestEmailEvent,
  secret: string,
  now: Date,
) {
  if (!Number.isSafeInteger(event?.timestamp) || event.timestamp <= 0) {
    throw new RequestIntakeError(400, 'InvalidRequestEmailEvent', 'Email event timestamp is invalid.')
  }
  const ageSeconds = Math.abs(Math.floor(now.getTime() / 1_000) - event.timestamp)
  if (ageSeconds > REQUEST_EMAIL_SIGNATURE_TOLERANCE_SECONDS) {
    throw new RequestIntakeError(401, 'RequestEmailEventExpired', 'Email event signature has expired.')
  }
  if (!event.envelope || typeof event.envelope !== 'object') {
    throw new RequestIntakeError(400, 'InvalidRequestEmailEvent', 'Email envelope is required.')
  }
  const expected = createRequestEmailSignature(event.timestamp, event.envelope, secret)
  const actual = typeof event.signature === 'string' ? event.signature.toLowerCase() : ''
  const expectedBytes = Buffer.from(expected, 'hex')
  const actualBytes = /^[a-f0-9]{64}$/u.test(actual) ? Buffer.from(actual, 'hex') : Buffer.alloc(0)
  if (
    expectedBytes.length !== actualBytes.length ||
    !timingSafeEqual(expectedBytes, actualBytes)
  ) {
    throw new RequestIntakeError(401, 'RequestEmailSignatureInvalid', 'Email event signature is invalid.')
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function requireEmailSecret(value: unknown) {
  if (typeof value !== 'string' || value.length < 32) {
    throw new Error('REQUEST_EMAIL_WEBHOOK_SECRET must contain at least 32 characters.')
  }
  return value
}

function readEnvironment(name: string) {
  if (typeof Bun !== 'undefined') return Bun.env[name]
  return typeof process !== 'undefined' ? process.env[name] : undefined
}
