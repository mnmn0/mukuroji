import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import { AutomationError } from './automation'

/** Inbound webhook secret を outbound secret から隔離する既定 prefix です。 */
export const AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX =
  'mukuroji/automation-inbound-webhooks'

/** Public inbound webhook が受け付ける raw body 上限です。 */
export const AUTOMATION_INBOUND_WEBHOOK_MAX_BODY_BYTES = 256 * 1_024

/** Sender timestamp に許容する clock skew 秒数です。 */
export const AUTOMATION_INBOUND_WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60

/** Secrets Manager に固定する一つの endpoint secret generation です。 */
export type AutomationInboundWebhookSecretReference = {
  /** Endpoint が属する Workspace ID です。 */
  workspaceId: string
  /** Workspace 内の endpoint ID です。 */
  endpointId: string
  /** Secrets Manager secret resource ID です。 */
  secretId: string
  /** Secrets Manager の immutable version ID です。 */
  secretVersionId: string
  /** Endpoint の単調増加 secret generation です。 */
  secretGeneration: number
}

/** Inbound webhook signing secret store の contract です。 */
export type AutomationInboundWebhookSecretStore = {
  /** 予約済み generation を作成または response-loss recovery して plaintext を返します。 */
  provision(reference: AutomationInboundWebhookSecretReference): Promise<string>
  /** Public delivery 検証用に pinned generation を読みます。 */
  get(reference: AutomationInboundWebhookSecretReference): Promise<Uint8Array>
  /** Revoke 済み endpoint の全 secret generations を削除します。 */
  delete(reference: AutomationInboundWebhookSecretReference): Promise<void>
}

/** Secrets Manager を利用する inbound webhook secret store です。 */
export class SecretsManagerAutomationInboundWebhookSecretStore
implements AutomationInboundWebhookSecretStore {
  /** Secrets Manager client です。 */
  private readonly client: SecretsManagerClient

  /** Secrets Manager secret store を作成します。 */
  constructor(client = createSecretsManagerClient()) {
    this.client = client
  }

  /** 予約済み generation を作成または response-loss recovery します。 */
  async provision(reference: AutomationInboundWebhookSecretReference) {
    const existing = await this.read(reference, true)
    if (existing) return existing.toString('utf8')

    const signingSecret = randomBytes(32).toString('base64url')
    const secretExists = await this.describe(reference.secretId)
    try {
      if (secretExists) {
        await this.client.send(new PutSecretValueCommand({
          SecretId: reference.secretId,
          ClientRequestToken: reference.secretVersionId,
          SecretString: signingSecret,
        }))
      } else {
        await this.client.send(new CreateSecretCommand({
          Name: reference.secretId,
          ClientRequestToken: reference.secretVersionId,
          Description: 'mukuroji server-issued inbound webhook signing secret',
          SecretString: signingSecret,
        }))
      }
      return signingSecret
    } catch {
      const recovered = await this.read(reference, true)
      if (recovered) return recovered.toString('utf8')
      throw secretUnavailable()
    }
  }

  /** Pinned secret generation を読みます。 */
  async get(reference: AutomationInboundWebhookSecretReference) {
    const secret = await this.read(reference, false)
    if (!secret) throw secretUnavailable()
    return secret
  }

  /** Endpoint secret resource を削除します。 */
  async delete(reference: AutomationInboundWebhookSecretReference) {
    try {
      await this.client.send(new DeleteSecretCommand({
        SecretId: reference.secretId,
        ForceDeleteWithoutRecovery: true,
      }))
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) return
      throw secretUnavailable()
    }
  }

  private async describe(secretId: string) {
    try {
      await this.client.send(new DescribeSecretCommand({ SecretId: secretId }))
      return true
    } catch (error) {
      if (isNamedError(error, 'ResourceNotFoundException')) return false
      throw secretUnavailable()
    }
  }

  private async read(
    reference: AutomationInboundWebhookSecretReference,
    missingIsUndefined: boolean,
  ) {
    try {
      const response = await this.client.send(new GetSecretValueCommand({
        SecretId: reference.secretId,
        VersionId: reference.secretVersionId,
      }))
      const secret = response.SecretString !== undefined
        ? Buffer.from(response.SecretString, 'utf8')
        : response.SecretBinary !== undefined
          ? Buffer.from(response.SecretBinary)
          : undefined
      if (!secret || secret.byteLength === 0) throw secretUnavailable()
      return secret
    } catch (error) {
      if (missingIsUndefined && isNamedError(error, 'ResourceNotFoundException')) return undefined
      if (error instanceof AutomationError) throw error
      throw secretUnavailable()
    }
  }
}

/** Workspace/endpoint を inbound-only Secrets Manager resource ID へ変換します。 */
export function createAutomationInboundWebhookSecretId(
  workspaceId: string,
  endpointId: string,
  prefix = readInboundWebhookSecretPrefix(),
) {
  const normalizedWorkspaceId = readIdentifier(workspaceId, 'Workspace ID')
  const normalizedEndpointId = readIdentifier(endpointId, 'Inbound webhook endpoint ID')
  return `${prefix}/${hashText(normalizedWorkspaceId)}/${normalizedEndpointId}`
}

/** Operation ID から AWS が許可する deterministic immutable secret VersionId を作ります。 */
export function createAutomationInboundWebhookSecretVersionId(
  operationId: string,
  secretGeneration: number,
) {
  if (!Number.isSafeInteger(secretGeneration) || secretGeneration < 1) {
    throw new AutomationError(
      400,
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
      throw new AutomationError(400, 'AutomationInboundWebhookLengthInvalid', 'Content-Length is invalid.')
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
    throw new AutomationError(400, 'AutomationInboundWebhookJsonInvalid', 'Request body must be UTF-8 JSON.')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new AutomationError(400, 'AutomationInboundWebhookJsonInvalid', 'Request body must be valid JSON.')
  }
}

function createSecretsManagerClient() {
  const endpoint = [
    process.env.SECRETS_MANAGER_ENDPOINT,
    process.env.AWS_ENDPOINT_URL_SECRETSMANAGER,
    process.env.AWS_ENDPOINT_URL,
  ].map((value) => value?.trim()).find(Boolean)
  return new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  })
}

function readInboundWebhookSecretPrefix() {
  const prefix = process.env.AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX
    ?.trim()
    .replace(/^\/+|\/+$/g, '')
  return prefix || AUTOMATION_INBOUND_WEBHOOK_SECRET_PREFIX
}

function readIdentifier(value: string, label: string) {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || !/^[A-Za-z0-9._:@#+/-]+$/.test(normalized)) {
    throw new AutomationError(400, 'InvalidAutomationInput', `${label} is invalid.`)
  }
  return normalized
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function signatureRejected(message: string) {
  return new AutomationError(401, 'AutomationInboundWebhookSignatureInvalid', message)
}

function bodyTooLarge() {
  return new AutomationError(
    413,
    'AutomationInboundWebhookBodyTooLarge',
    'Inbound webhook body exceeds the configured limit.',
  )
}

function secretUnavailable() {
  return new AutomationError(
    503,
    'AutomationInboundWebhookSecretUnavailable',
    'Inbound webhook signing secret is unavailable.',
    true,
  )
}

function isNamedError(error: unknown, name: string) {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === name
}
