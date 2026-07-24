import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { AutomationError } from './domain/automation-error'

export type {
  AutomationInboundWebhookSecretReference,
  AutomationInboundWebhookSecretStore,
} from './application/ports'

export {
  AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX,
  createAutomationInboundWebhookSecretId,
} from './adapter-out/inbound-webhook-secret-id'
export {
  SecretsManagerAutomationInboundWebhookSecretStore,
} from './adapter-out/secrets-manager/inbound-webhook-secret-store'

/** Public inbound webhook が受け付ける raw body 上限です。 */
export const AUTOMATION_INBOUND_WEBHOOK_MAX_BODY_BYTES = 256 * 1_024

/** Sender timestamp に許容する clock skew 秒数です。 */
export const AUTOMATION_INBOUND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

/** Operation ID から AWS が許可する deterministic immutable secret VersionId を作ります。 */
export function createAutomationInboundWebhookSecretVersionId(
  operationId: string,
  secretGeneration: number,
) {
  if (!Number.isSafeInteger(secretGeneration) || secretGeneration < 1) {
    throw new AutomationError(
      'invalid-input',
      'InvalidAutomationInput',
      'Inbound webhook secret generation is invalid.',
    )
  }
  return createHash('sha256')
    .update(`${readIdentifier(operationId, 'Inbound webhook operation ID')}\0${secretGeneration}`)
    .digest('hex')
}

/** JSON media type を charset parameter 付きで厳格に判定します。 */
export function isAutomationInboundWebhookJsonContentType(value: string | undefined) {
  if (!value) return false
  const [mediaType, ...parameters] = value.split(';').map((part) => part.trim().toLowerCase())
  if (mediaType !== 'application/json') return false
  return parameters.every((parameter) => /^charset\s*=\s*utf-8$/.test(parameter))
}

/** Sender timestamp を検証して正規化します。 */
export function readAutomationInboundWebhookTimestamp(
  value: string | undefined,
  now = new Date(),
) {
  if (!value || !/^\d{10}$/.test(value)) {
    throw signatureRejected('Inbound webhook timestamp is invalid.')
  }
  const epochSeconds = Number(value)
  if (!Number.isSafeInteger(epochSeconds)) {
    throw signatureRejected('Inbound webhook timestamp is invalid.')
  }
  const nowSeconds = Math.floor(now.getTime() / 1_000)
  if (
    !Number.isFinite(now.getTime()) ||
    Math.abs(nowSeconds - epochSeconds) > AUTOMATION_INBOUND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
  ) {
    throw signatureRejected('Inbound webhook timestamp is outside the allowed window.')
  }
  return value
}

/** Raw bytes を HMAC-SHA256 で検証し、保存用 signature fingerprint を返します。 */
export function verifyAutomationInboundWebhookSignature(
  secret: Uint8Array,
  timestamp: string,
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
) {
  const match = /^sha256=([a-f0-9]{64})$/.exec(signatureHeader ?? '')
  if (!match) throw signatureRejected('Inbound webhook signature is invalid.')
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest()
  const received = Buffer.from(match[1]!, 'hex')
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
    throw signatureRejected('Inbound webhook signature is invalid.')
  }
  return hashText(signatureHeader!.toLowerCase())
}

/** Raw body stream を上限を超えずに読み取ります。 */
export async function readAutomationInboundWebhookBody(
  request: Request,
  maximumBytes = AUTOMATION_INBOUND_WEBHOOK_MAX_BODY_BYTES,
) {
  const contentLength = request.headers.get('Content-Length')
  if (contentLength !== null) {
    const parsed = Number(contentLength)
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new AutomationError('invalid-input', 'AutomationInboundWebhookLengthInvalid', 'Content-Length is invalid.')
    }
    if (parsed > maximumBytes) throw bodyTooLarge()
  }
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw bodyTooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** Raw JSON bytes を canonical parsing せず UTF-8 JSON value として検証します。 */
export function parseAutomationInboundWebhookJson(rawBody: Uint8Array) {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(rawBody)
  } catch {
    throw new AutomationError('invalid-input', 'AutomationInboundWebhookJsonInvalid', 'Request body must be UTF-8 JSON.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AutomationError('invalid-input', 'AutomationInboundWebhookJsonInvalid', 'Request body must be valid JSON.')
  }
}

function readIdentifier(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9._:@#+/-]+$/.test(normalized)) {
    throw new AutomationError('invalid-input', 'InvalidAutomationInput', `${label} is invalid.`)
  }
  return normalized
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function signatureRejected(message: string) {
  return new AutomationError('unauthenticated', 'AutomationInboundWebhookSignatureInvalid', message)
}

function bodyTooLarge() {
  return new AutomationError(
    'payload-too-large',
    'AutomationInboundWebhookBodyTooLarge',
    'Inbound webhook body exceeds the configured limit.',
  )
}
