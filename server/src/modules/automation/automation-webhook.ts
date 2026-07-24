import { createHash, createHmac } from 'node:crypto'
import { lookup as lookupHostname } from 'node:dns/promises'
import type { ClientRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager'
import type { AutomationAction } from '@mukuroji/contracts'
import {
  type AutomationActionExecutionContext,
} from './application/ports'
import { AutomationError } from './domain/automation-error'
import {
  isAutomationWebhookSecretAlias,
  isPublicAutomationWebhookAddress,
  normalizeAutomationWebhookHostname,
  readAutomationWebhookEndpoint,
} from './automation-webhook-policy'

/** Secrets Manager で automation webhook secret を隔離する prefix です。 */
export const AUTOMATION_WEBHOOK_SECRET_PREFIX = 'mukuroji/automation-webhooks'

/** Webhook secret を解決する callback です。 */
export type AutomationWebhookSecretResolver = (
  workspaceId: string,
  secretAlias: string,
) => Promise<Uint8Array>

/** 検証済み webhook request の transport input です。 */
export type AutomationWebhookRequest = {
  /** JSON request body です。 */
  body: string
  /** Secret 本文や reference を含まない request headers です。 */
  headers: Record<string, string>
  /** DNS 解決を含む request 全体の timeout milliseconds です。 */
  timeoutMs: number
}

/** Webhook endpoint へ request を送る callback です。 */
export type AutomationWebhookSender = (
  endpoint: URL,
  request: AutomationWebhookRequest,
) => Promise<number>

/** Webhook delivery の差し替え可能 dependency です。 */
export type AutomationWebhookDeliveryDependencies = {
  /** Signing timestamp を決める clock です。 */
  now?: () => Date
  /** Workspace-scoped signing secret resolver です。 */
  resolveSecret?: AutomationWebhookSecretResolver
  /** Public IP に固定して送信する transport です。 */
  sendRequest?: AutomationWebhookSender
}

/** DNS lookup が返す一つの address です。 */
export type AutomationWebhookResolvedAddress = {
  /** IPv4 または IPv6 address です。 */
  address: string
  /** IP address family です。 */
  family: 4 | 6
}

/** Hostname の全 address を一度に返す DNS lookup です。 */
export type AutomationWebhookLookup = (
  hostname: string,
) => Promise<AutomationWebhookResolvedAddress[]>

let secretsManagerClient: SecretsManagerClient | undefined

/** Secret alias を workspace hash 配下の固定 Secrets Manager ID へ変換します。 */
export function createAutomationWebhookSecretId(
  workspaceId: string,
  secretAlias: string,
  prefix = readSecretPrefix(),
) {
  if (!workspaceId.trim() || !isAutomationWebhookSecretAlias(secretAlias)) {
    throw new AutomationError(
      'invalid-input',
      'AutomationWebhookSecretReferenceInvalid',
      'Automation webhook secret reference is invalid.',
    )
  }
  const workspaceHash = createHash('sha256').update(workspaceId.trim()).digest('hex')
  return `${prefix}/${workspaceHash}/${secretAlias}`
}

/** Timestamp と raw JSON body を HMAC-SHA256 で署名します。 */
export function createAutomationWebhookSignature(
  secret: Uint8Array,
  timestamp: string,
  body: string,
) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`
}

/** Secret 解決、署名、SSRF-safe transport を組み合わせて webhook を配送します。 */
export async function deliverAutomationWebhook(
  action: Extract<AutomationAction, { type: 'webhook' }>,
  context: AutomationActionExecutionContext,
  dependencies: AutomationWebhookDeliveryDependencies = {},
) {
  const endpoint = readAutomationWebhookEndpoint(action.url)
  if (!endpoint) {
    throw new AutomationError(
      'unprocessable',
      'AutomationWebhookEndpointRejected',
      'Automation webhook endpoint is not allowed.',
    )
  }
  const body = JSON.stringify(action.body ?? {
    event: context.event,
    executionId: context.execution.id,
  })
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Idempotency-Key': context.idempotencyKey,
    'X-Mukuroji-Event': context.event.eventType,
  }
  if (action.secretReference) {
    let secret: Uint8Array
    try {
      secret = await (dependencies.resolveSecret ?? resolveAutomationWebhookSecret)(
        context.execution.workspaceId,
        action.secretReference,
      )
      if (secret.byteLength === 0) throw new Error('Empty signing secret.')
    } catch {
      throw secretUnavailable()
    }
    const timestamp = String(Math.floor((dependencies.now?.() ?? new Date()).getTime() / 1_000))
    headers['X-Mukuroji-Timestamp'] = timestamp
    headers['X-Mukuroji-Signature'] = createAutomationWebhookSignature(secret, timestamp, body)
  }
  let status: number
  try {
    status = await (dependencies.sendRequest ?? sendAutomationWebhookRequest)(endpoint, {
      body,
      headers,
      timeoutMs: 10_000,
    })
  } catch (error) {
    if (error instanceof AutomationError) throw error
    throw new AutomationError(
      'unavailable',
      'AutomationWebhookUnavailable',
      'Automation webhook request failed.',
      true,
    )
  }
  if (status >= 300 && status < 400) {
    throw new AutomationError(
      'unprocessable',
      'AutomationWebhookRedirectRejected',
      'Automation webhook redirects are not allowed.',
    )
  }
  if (status < 200 || status >= 300) {
    throw new AutomationError(
      status === 429 || status >= 500 ? 'unavailable' : 'unprocessable',
      'AutomationWebhookFailed',
      `Automation webhook returned HTTP ${status}.`,
      status === 429 || status >= 500,
    )
  }
}

/** Hostname を一度だけ解決し、全 address が public の場合に接続先を返します。 */
export async function resolveAutomationWebhookAddress(
  hostname: string,
  lookup: AutomationWebhookLookup = defaultAutomationWebhookLookup,
) {
  const normalizedHostname = normalizeAutomationWebhookHostname(hostname)
  const literalFamily = isIP(normalizedHostname)
  if (literalFamily > 0) {
    if (!isPublicAutomationWebhookAddress(normalizedHostname)) throw endpointRejected()
    return {
      address: normalizedHostname,
      family: literalFamily as 4 | 6,
    }
  }
  let addresses: AutomationWebhookResolvedAddress[]
  try {
    addresses = await lookup(normalizedHostname)
  } catch {
    throw new AutomationError(
      'unavailable',
      'AutomationWebhookDnsUnavailable',
      'Automation webhook endpoint DNS resolution failed.',
      true,
    )
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      isIP(address) !== family || !isPublicAutomationWebhookAddress(address)
    )
  ) {
    throw endpointRejected()
  }
  return addresses[0]!
}

/** DNS で検証した public IP へ HTTPS socket を固定して request を送ります。 */
export async function sendAutomationWebhookRequest(
  endpoint: URL,
  request: AutomationWebhookRequest,
  lookup: AutomationWebhookLookup = defaultAutomationWebhookLookup,
) {
  return await new Promise<number>((resolve, reject) => {
    let clientRequest: ClientRequest | undefined
    let settled = false
    const settle = (error: AutomationError | undefined, status?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(status ?? 0)
    }
    const timeout = setTimeout(() => {
      clientRequest?.destroy()
      settle(new AutomationError(
        'unavailable',
        'AutomationWebhookTimeout',
        'Automation webhook request timed out.',
        true,
      ))
    }, request.timeoutMs)

    void resolveAutomationWebhookAddress(endpoint.hostname, lookup).then((resolvedAddress) => {
      if (settled) return
      try {
        clientRequest = httpsRequest(endpoint, {
          agent: false,
          headers: {
            ...request.headers,
            'Content-Length': String(Buffer.byteLength(request.body)),
          },
          lookup: (_hostname, _options, callback) => {
            callback(null, resolvedAddress.address, resolvedAddress.family)
          },
          method: 'POST',
        }, (response) => {
          const status = response.statusCode ?? 0
          response.destroy()
          settle(undefined, status)
        })
        clientRequest.once('error', () => {
          settle(new AutomationError(
            'unavailable',
            'AutomationWebhookUnavailable',
            'Automation webhook request failed.',
            true,
          ))
        })
        clientRequest.end(request.body)
      } catch {
        settle(new AutomationError(
          'unavailable',
          'AutomationWebhookUnavailable',
          'Automation webhook request failed.',
          true,
        ))
      }
    }, (error: unknown) => {
      settle(error instanceof AutomationError
        ? error
        : new AutomationError(
            'unavailable',
            'AutomationWebhookDnsUnavailable',
            'Automation webhook endpoint DNS resolution failed.',
            true,
          ))
    })
  })
}

async function resolveAutomationWebhookSecret(workspaceId: string, secretAlias: string) {
  const secretId = createAutomationWebhookSecretId(workspaceId, secretAlias)
  try {
    const response = await getSecretsManagerClient().send(new GetSecretValueCommand({
      SecretId: secretId,
    }))
    const secret = response.SecretString !== undefined
      ? Buffer.from(response.SecretString)
      : response.SecretBinary !== undefined
        ? Buffer.from(response.SecretBinary)
        : undefined
    if (!secret || secret.byteLength === 0) throw new Error('Secret value is empty.')
    return secret
  } catch {
    throw secretUnavailable()
  }
}

async function defaultAutomationWebhookLookup(
  hostname: string,
): Promise<AutomationWebhookResolvedAddress[]> {
  const addresses = await lookupHostname(hostname, { all: true, verbatim: true })
  return addresses.flatMap<AutomationWebhookResolvedAddress>(({ address, family }) =>
    isAutomationWebhookAddressFamily(family)
      ? [{ address, family }]
      : []
  )
}

/**
 * Narrows a DNS address family to the IPv4 and IPv6 values accepted by webhook delivery.
 *
 * @param family - Address family returned by the DNS resolver.
 * @returns Whether the family is IPv4 or IPv6.
 */
function isAutomationWebhookAddressFamily(family: number): family is 4 | 6 {
  return family === 4 || family === 6
}

function getSecretsManagerClient() {
  secretsManagerClient ??= new SecretsManagerClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
  })
  return secretsManagerClient
}

function readSecretPrefix() {
  const configured = process.env.AUTOMATION_WEBHOOK_SECRET_PREFIX?.trim().replace(/^\/+|\/+$/g, '')
  return configured || AUTOMATION_WEBHOOK_SECRET_PREFIX
}

function endpointRejected() {
  return new AutomationError(
    'unprocessable',
    'AutomationWebhookEndpointRejected',
    'Automation webhook endpoint is not allowed.',
  )
}

function secretUnavailable() {
  return new AutomationError(
    'unavailable',
    'AutomationWebhookSecretUnavailable',
    'Automation webhook signing secret is unavailable.',
    true,
  )
}
