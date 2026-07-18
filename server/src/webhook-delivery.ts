import { createHmac, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as sendHttpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'

/** Webhook request の署名 header prefix です。 */
export const WEBHOOK_SIGNATURE_VERSION = 'v1'

/** Webhook receiver が受け入れる既定 replay window です。 */
export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60

/** Webhook worker の1 HTTP request timeout です。 */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000

/** DNS 解決後の address です。 */
export type ResolvedWebhookAddress = {
  /** IPv4 または IPv6 address です。 */
  address: string
  /** Address family です。 */
  family: number
}

/** Webhook hostname を全 address へ解決する dependency です。 */
export type WebhookAddressResolver = (hostname: string) => Promise<ResolvedWebhookAddress[]>

/** Signed webhook request の入力です。 */
export type WebhookRequestInput = {
  /** Delivery を安定して識別する ID です。 */
  deliveryId: string
  /** Event envelope を安定して識別する ID です。 */
  eventId: string
  /** Subscription の HTTPS endpoint です。 */
  url: string
  /** 暗号化 storage から一時的に復号した signing secret です。 */
  signingSecret: string
  /** JSON serialized event envelope です。 */
  payload: string
  /** Unix seconds 形式の署名 timestamp です。 */
  timestamp?: number
}

/** Webhook HTTP attempt の正規化結果です。 */
export type WebhookRequestResult = {
  /** 2xx response を受け取った場合は true です。 */
  succeeded: boolean
  /** SQS retry の対象にする場合は true です。 */
  retryable: boolean
  /** Receiver が返した HTTP status です。 */
  responseStatus?: number
  /** Retry-After header が指定した待機秒数です。 */
  retryAfterSeconds?: number
  /** Secret や response body を含まない安全な error summary です。 */
  error?: string
}

/** DNS 検証済み address に固定して送る HTTPS request です。 */
export type WebhookTransportRequest = {
  /** TLS certificate と Host header で検証する元の hostname です。 */
  hostname: string
  /** DNS 検証済みで接続先に固定する address です。 */
  address: ResolvedWebhookAddress
  /** Request path と query を含む URL です。 */
  url: URL
  /** Secret を含むため log へ出してはいけない request header です。 */
  headers: Record<string, string>
  /** Raw JSON request body です。 */
  body: string
  /** Timeout 時に transport を中断する signal です。 */
  signal: AbortSignal
}

/** Webhook transport が利用する最小 response です。 */
export type WebhookTransportResponse = {
  /** Receiver の HTTP status です。 */
  status: number
  /** Receiver の Retry-After header です。 */
  retryAfter: string | null
}

/** DNS 検証済み address へ request を送る dependency です。 */
export type WebhookRequestTransport = (
  request: WebhookTransportRequest,
) => Promise<WebhookTransportResponse>

/** Webhook delivery の network dependency です。 */
export type WebhookDeliveryDependencies = {
  /** Hostname を delivery ごとに解決する resolver です。 */
  resolveAddresses?: WebhookAddressResolver
  /** 検証済み address へ固定して送信する transport です。 */
  transport?: WebhookRequestTransport
  /** 1 attempt の timeout です。 */
  timeoutMs?: number
}

/** Webhook URL が public HTTPS endpoint ではない場合に返す error です。 */
export class UnsafeWebhookUrlError extends Error {
  /** Stable API error code です。 */
  readonly code = 'UnsafeWebhookUrl'

  /** User-facing error を作成します。 */
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeWebhookUrlError'
  }
}

/** Payload と timestamp を HMAC-SHA256 で署名します。 */
export function createWebhookSignature(
  signingSecret: string,
  timestamp: number,
  payload: string,
) {
  const digest = createHmac('sha256', signingSecret)
    .update(`${timestamp}.${payload}`)
    .digest('hex')
  return `${WEBHOOK_SIGNATURE_VERSION}=${digest}`
}

/** Webhook signature を timing-safe に検証し、古い payload replay を拒否します。 */
export function verifyWebhookSignature(input: {
  /** Receiver が保持する signing secret です。 */
  signingSecret: string
  /** X-Mukuroji-Timestamp header の Unix seconds です。 */
  timestamp: number
  /** Raw request body です。 */
  payload: string
  /** X-Mukuroji-Signature header です。 */
  signature: string
  /** 検証時刻の Unix seconds です。 */
  now?: number
  /** 許容する replay window 秒数です。 */
  toleranceSeconds?: number
}) {
  const now = input.now ?? Math.floor(Date.now() / 1_000)
  const tolerance = input.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS
  if (!Number.isSafeInteger(input.timestamp) || Math.abs(now - input.timestamp) > tolerance) {
    return false
  }
  const expected = Buffer.from(
    createWebhookSignature(input.signingSecret, input.timestamp, input.payload),
  )
  const received = Buffer.from(input.signature)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

/** Webhook URL の scheme、port、hostname と解決先 address を SSRF policy で検証します。 */
export async function assertSafeWebhookUrl(
  value: string,
  resolveAddresses: WebhookAddressResolver = resolveWebhookAddresses,
) {
  return (await resolveSafeWebhookUrl(value, resolveAddresses)).url
}

async function resolveSafeWebhookUrl(
  value: string,
  resolveAddresses: WebhookAddressResolver,
) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new UnsafeWebhookUrlError('Webhook URL is invalid.')
  }
  if (url.protocol !== 'https:') {
    throw new UnsafeWebhookUrlError('Webhook URL must use HTTPS.')
  }
  if (url.username || url.password || url.hash) {
    throw new UnsafeWebhookUrlError('Webhook URL cannot contain credentials or a fragment.')
  }
  if (url.port && url.port !== '443') {
    throw new UnsafeWebhookUrlError('Webhook URL must use the default HTTPS port.')
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new UnsafeWebhookUrlError('Webhook URL must use a public hostname.')
  }
  if (isForbiddenNetworkAddress(hostname)) {
    throw new UnsafeWebhookUrlError('Webhook URL cannot use a private or reserved address.')
  }
  let addresses: ResolvedWebhookAddress[]
  try {
    addresses = await resolveAddresses(hostname)
  } catch {
    throw new UnsafeWebhookUrlError('Webhook hostname could not be resolved.')
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      (family !== 4 && family !== 6) ||
      isIP(address) !== family ||
      isForbiddenNetworkAddress(address)
    )
  ) {
    throw new UnsafeWebhookUrlError('Webhook hostname resolved to a private or reserved address.')
  }
  return { addresses, hostname, url }
}

/** Signed POST request を1回送り、retry policy に必要な結果だけを返します。 */
export async function deliverWebhookRequest(
  input: WebhookRequestInput,
  dependencies: WebhookDeliveryDependencies = {},
): Promise<WebhookRequestResult> {
  const resolved = await resolveSafeWebhookUrl(
    input.url,
    dependencies.resolveAddresses ?? resolveWebhookAddresses,
  )
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1_000)
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.timeoutMs ?? WEBHOOK_REQUEST_TIMEOUT_MS,
  )
  try {
    const response = await (dependencies.transport ?? deliverPinnedHttpsRequest)({
      hostname: resolved.hostname,
      address: resolved.addresses[0]!,
      url: resolved.url,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': input.deliveryId,
        'User-Agent': 'mukuroji-webhooks/1.0',
        'X-Mukuroji-Event-Id': input.eventId,
        'X-Mukuroji-Delivery-Id': input.deliveryId,
        'X-Mukuroji-Timestamp': String(timestamp),
        'X-Mukuroji-Signature': createWebhookSignature(
          input.signingSecret,
          timestamp,
          input.payload,
        ),
      },
      body: input.payload,
    })
    if (response.status >= 200 && response.status < 300) {
      return { succeeded: true, retryable: false, responseStatus: response.status }
    }
    const retryable = isRetryableWebhookStatus(response.status)
    return {
      succeeded: false,
      retryable,
      responseStatus: response.status,
      ...(retryable ? { retryAfterSeconds: readRetryAfterSeconds(response.retryAfter) } : {}),
      error: retryable ? 'Webhook endpoint is temporarily unavailable.' : 'Webhook endpoint rejected the delivery.',
    }
  } catch (error) {
    return {
      succeeded: false,
      retryable: true,
      error: error instanceof Error && error.name === 'AbortError'
        ? 'Webhook request timed out.'
        : 'Webhook request failed.',
    }
  } finally {
    clearTimeout(timeout)
  }
}

/** Attempt number から full-jitter exponential backoff 秒数を計算します。 */
export function createWebhookRetryDelaySeconds(
  attempt: number,
  retryAfterSeconds?: number,
  random = Math.random,
) {
  if (retryAfterSeconds !== undefined) return Math.min(43_200, Math.max(1, retryAfterSeconds))
  const cap = Math.min(43_200, 15 * (2 ** Math.max(0, attempt - 1)))
  return Math.max(1, Math.floor(random() * cap))
}

function isRetryableWebhookStatus(status: number) {
  return status === 408 || status === 425 || status === 429 || status >= 500
}

function readRetryAfterSeconds(value: string | null) {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) return Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000))
  return undefined
}

function isForbiddenNetworkAddress(value: string) {
  const address = value.toLowerCase().replace(/^\[|\]$/g, '')
  const family = isIP(address)
  return family === 4
    ? FORBIDDEN_WEBHOOK_IPV4_ADDRESSES.check(address, 'ipv4')
    : family === 6 && FORBIDDEN_WEBHOOK_IPV6_ADDRESSES.check(address, 'ipv6')
}

async function resolveWebhookAddresses(hostname: string) {
  return await lookup(hostname, { all: true, verbatim: true })
}

async function deliverPinnedHttpsRequest(
  input: WebhookTransportRequest,
): Promise<WebhookTransportResponse> {
  return await new Promise((resolve, reject) => {
    const request = sendHttpsRequest({
      family: input.address.family,
      headers: {
        ...input.headers,
        Host: input.url.host,
      },
      hostname: input.address.address,
      method: 'POST',
      path: `${input.url.pathname}${input.url.search}`,
      port: 443,
      rejectUnauthorized: true,
      servername: isIP(input.hostname) ? undefined : input.hostname,
      signal: input.signal,
    }, (response) => {
      const retryAfter = response.headers['retry-after']
      response.resume()
      resolve({
        status: response.statusCode ?? 502,
        retryAfter: Array.isArray(retryAfter) ? (retryAfter[0] ?? null) : (retryAfter ?? null),
      })
    })
    request.once('error', reject)
    request.end(input.body)
  })
}

const FORBIDDEN_WEBHOOK_IPV4_ADDRESSES = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  FORBIDDEN_WEBHOOK_IPV4_ADDRESSES.addSubnet(network, prefix, 'ipv4')
}
const FORBIDDEN_WEBHOOK_IPV6_ADDRESSES = new BlockList()
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  FORBIDDEN_WEBHOOK_IPV6_ADDRESSES.addSubnet(network, prefix, 'ipv6')
}
