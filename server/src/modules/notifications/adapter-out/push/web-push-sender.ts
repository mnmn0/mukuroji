import type { NotificationMessageLocale, PushNotificationPayload } from '@mukuroji/contracts'
import type { ChannelDelivery, ChannelSendResult, NotificationLocaleReader } from '../../application/channel-delivery'
import type { PushDevice, PushDeviceDirectory } from '../../application/ports/push-device-directory'
import { readPushEndpoint } from '../../domain/push-subscription'
import { DEFAULT_NOTIFICATION_LOCALE, resolveNotificationSummaryText } from '../../domain/notification-summary'
import { formatNotificationHeading, resolveNotificationLinks } from '../notification-links'
import {
  MAX_WEB_PUSH_PLAINTEXT_BYTES,
  createVapidAuthorization,
  encryptWebPushPayload,
  type VapidKeys,
} from './web-push-crypto'

/** Minimal HTTP response the sender reads from a push service. */
export type WebPushResponse = {
  /** HTTP status code. */
  status: number
  /** Reads one response header. */
  headers: { get(name: string): string | null }
}

/** One encrypted Web Push request; rejects on network failure or when `signal` aborts. */
export type WebPushHttpClient = (
  endpoint: string,
  request: {
    /** Request headers, including the VAPID authorization. */
    headers: Record<string, string>
    /** Encrypted `aes128gcm` body. */
    body: Buffer
    /** Delivery deadline. */
    signal: AbortSignal
  },
) => Promise<WebPushResponse>

/** Deploy-time configuration and ports for the Web Push sender. */
export type WebPushNotificationSenderOptions = {
  /** Loads the validated VAPID key pair; rejections are retried as an unavailable transport. */
  loadKeys(): Promise<VapidKeys>
  /** Web application origin that resolves deep links and serves as the VAPID contact. */
  appOrigin: string
  /** Recipient device registrations. */
  devices: PushDeviceDirectory
  /** Push service request. */
  post: WebPushHttpClient
  /** Recipient language reader; without one the summary is written in Japanese. */
  readLocale?: NotificationLocaleReader
  /** Clock used for VAPID token expiry and subscription expiry. */
  now?: () => Date
  /** Deadline for the whole lookup and all device requests, well inside the 60-second lease. */
  deadlineMs?: number
}

/** Default deadline for lookup and sends, half of the renewed delivery lease. */
const PUSH_SEND_DEADLINE_MS = 30_000

/** Seconds a push service keeps a message for an offline device. */
const PUSH_TTL_SECONDS = 24 * 60 * 60

/** Longest body text placed in the payload. */
const MAX_BODY_CHARACTERS = 500

/** Outcome of one device request; `invalid` is a stored registration that cannot be used. */
type DeviceOutcome = 'accepted' | 'gone' | 'retryable' | 'rejected' | 'invalid'

/** Devices sent to at once, so one stalled push service cannot use the whole deadline alone. */
const DEVICE_CONCURRENCY = 4

/**
 * Creates a sender that encrypts one notification for every device the recipient still owns and
 * deletes registrations the push service reports as gone.
 *
 * The notification counts as sent once any device accepts it. A device that failed while another
 * accepted is not retried, so a retry never shows the notification twice on the accepting device.
 *
 * @param options - VAPID keys, application origin, device directory, and HTTP client.
 * @returns Recipient-bound notification sender.
 */
export function createWebPushNotificationSender(options: WebPushNotificationSenderOptions) {
  const now = options.now ?? (() => new Date())
  return async (delivery: ChannelDelivery): Promise<ChannelSendResult> => {
    const signal = AbortSignal.timeout(options.deadlineMs ?? PUSH_SEND_DEADLINE_MS)
    let keys: VapidKeys
    try {
      keys = await options.loadKeys()
    } catch {
      return { succeeded: false, retryable: true, code: 'PushKeysUnavailable' }
    }
    let devices: PushDevice[]
    try {
      devices = await options.devices.listDevices(delivery.workspaceId, delivery.memberKey, now(), signal)
    } catch {
      return { succeeded: false, retryable: true, code: 'PushDevicesUnavailable' }
    }
    if (signal.aborted) return { succeeded: false, retryable: true, code: 'PushDevicesUnavailable' }
    if (devices.length === 0) return { succeeded: false, retryable: false, suppressed: true, code: 'PushNoDevices' }
    let locale: NotificationMessageLocale
    try {
      locale = options.readLocale ? await options.readLocale(delivery, signal) : DEFAULT_NOTIFICATION_LOCALE
    } catch {
      return { succeeded: false, retryable: true, code: 'NotificationLocaleUnavailable' }
    }
    if (signal.aborted) return { succeeded: false, retryable: true, code: 'NotificationLocaleUnavailable' }
    const plaintext = Buffer.from(JSON.stringify(renderPushNotification(delivery, options.appOrigin, locale)))
    const outcomes: DeviceOutcome[] = []
    let retryAfterMs = 0
    const pending = [...devices]
    // A few workers share the deadline, so a stalled device never keeps the others from being tried.
    const worker = async () => {
      for (let device = pending.shift(); device; device = pending.shift()) {
        if (signal.aborted) { outcomes.push('retryable'); return }
        const result = await sendToDevice(options, keys, device, plaintext, signal, now())
        if (result.retryAfterMs) retryAfterMs = Math.max(retryAfterMs, result.retryAfterMs)
        if (result.outcome === 'gone') {
          try {
            await options.devices.removeGoneDevice(delivery.workspaceId, delivery.memberKey, device, signal)
          } catch { /* The next delivery reports the same status and removes it again. */ }
        }
        outcomes.push(result.outcome)
      }
    }
    await Promise.all(Array.from({ length: Math.min(DEVICE_CONCURRENCY, devices.length) }, worker))
    if (outcomes.includes('accepted')) return { succeeded: true, retryable: false }
    if (outcomes.includes('retryable')) {
      return { succeeded: false, retryable: true, code: 'PushDeliveryUnavailable', ...(retryAfterMs ? { retryAfterMs } : {}) }
    }
    // A corrupt registration is kept for an operator and fails loudly instead of being deleted.
    if (outcomes.includes('invalid')) return { succeeded: false, retryable: false, code: 'PushSubscriptionInvalid' }
    if (outcomes.includes('rejected')) return { succeeded: false, retryable: false, code: 'PushDeliveryRejected' }
    return { succeeded: false, retryable: false, suppressed: true, code: 'PushNoDevices' }
  }
}

/**
 * Sends one encrypted message to one device and classifies the push service response.
 * @param options - Sender options holding the HTTP client and contact origin.
 * @param keys - VAPID key pair.
 * @param device - Registered device.
 * @param plaintext - JSON payload bytes.
 * @param signal - Delivery deadline.
 * @param issuedAt - VAPID token issue time.
 * @returns Outcome and any requested retry delay.
 */
async function sendToDevice(
  options: WebPushNotificationSenderOptions,
  keys: VapidKeys,
  device: PushDevice,
  plaintext: Buffer,
  signal: AbortSignal,
  issuedAt: Date,
): Promise<{
  /** Classified device outcome. */
  outcome: DeviceOutcome
  /** Receiver-requested delay, when it sent `Retry-After`. */
  retryAfterMs?: number
}> {
  let endpoint: string
  let body: Buffer
  try {
    // The registration boundary is checked again, so a corrupt row never directs a request elsewhere.
    endpoint = readPushEndpoint(device.endpoint)
    body = encryptWebPushPayload(plaintext, device.keys)
  } catch {
    return { outcome: 'invalid' }
  }
  let response: WebPushResponse
  try {
    response = await options.post(endpoint, {
      headers: {
        Authorization: createVapidAuthorization(keys, endpoint, options.appOrigin, issuedAt),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: 'normal',
      },
      body,
      signal,
    })
  } catch {
    return { outcome: 'retryable' }
  }
  if (response.status >= 200 && response.status < 300) return { outcome: 'accepted' }
  if (response.status === 404 || response.status === 410) return { outcome: 'gone' }
  if (response.status === 429 || response.status >= 500) {
    const retryAfterMs = readRetryAfterMs(response.headers.get('retry-after'), issuedAt)
    return { outcome: 'retryable', ...(retryAfterMs ? { retryAfterMs } : {}) }
  }
  // 400, 401, 403 and 413 mean a VAPID or payload problem an operator must fix.
  return { outcome: 'rejected' }
}

/**
 * Reads a `Retry-After` header given in seconds or as an HTTP date, capped at one hour.
 * @param value - Header value.
 * @param now - Current time.
 * @returns Delay in milliseconds, or undefined when absent or invalid.
 */
function readRetryAfterMs(value: string | null, now: Date): number | undefined {
  if (!value) return undefined
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) * 1_000 : Date.parse(value) - now.getTime()
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60 * 60 * 1_000) : undefined
}

/**
 * Renders the payload the service worker shows. The title and body are plain text, and the path
 * is a same-origin path the service worker checks again before opening it.
 * @param delivery - Delivery with validated notification contents.
 * @param appOrigin - Web application origin.
 * @param locale - Recipient language for the system-written summary.
 * @returns Payload that fits one Web Push record.
 */
export function renderPushNotification(
  delivery: ChannelDelivery,
  appOrigin: string,
  locale: NotificationMessageLocale = DEFAULT_NOTIFICATION_LOCALE,
): PushNotificationPayload {
  const notification = delivery.notification
  const summary = singleLine(resolveNotificationSummaryText(notification, locale)).slice(0, MAX_BODY_CHARACTERS)
  const heading = singleLine(formatNotificationHeading(notification)).slice(0, 180)
  const open = new URL(resolveNotificationLinks(notification, appOrigin).open)
  const payload: PushNotificationPayload = {
    title: heading || summary || 'mukuroji',
    ...(heading && summary ? { body: summary } : {}),
    path: `${open.pathname}${open.search}${open.hash}`,
    tag: notification.id,
  }
  // Very long multibyte text is cut down until the payload fits; the path and tag stay intact.
  while (Buffer.byteLength(JSON.stringify(payload)) > MAX_WEB_PUSH_PLAINTEXT_BYTES) {
    if (payload.body) payload.body = payload.body.slice(0, Math.floor(payload.body.length / 2))
    else if (payload.title.length > 1) payload.title = payload.title.slice(0, Math.floor(payload.title.length / 2))
    else { payload.path = '/'; break }
  }
  return payload
}

/**
 * Collapses stored text to one line without control characters.
 * @param value - Stored title or summary.
 * @returns Trimmed single line, or an empty string.
 */
function singleLine(value: string | undefined): string {
  return [...(value ?? '')]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code < 0x20 || code === 0x7f ? ' ' : character
    })
    .join('')
    .replace(/ {2,}/g, ' ')
    .trim()
}
