import { createECDH, createHash } from 'node:crypto'
import type { PushConfiguration, PushSubscriptionInput } from '@mukuroji/contracts'
import { NotificationError } from './notification-error'

/** Longest push endpoint accepted; real push service URLs are far shorter. */
const maxEndpointLength = 2_048

/**
 * Push service hosts a subscription may point at. The delivery worker posts to these URLs, so
 * an arbitrary host would let a member make the server send requests anywhere.
 */
const pushServiceHostSuffixes: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
]

/** Length of an uncompressed P-256 public key. */
const p256dhByteLength = 65

/** Length of a Web Push authentication secret. */
const authByteLength = 16

/** Maximum push subscriptions kept for one member across their devices. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_MEMBER = 20

/** A validated push subscription, ready to store. */
export type ValidatedPushSubscription = PushSubscriptionInput & {
  /** Stable identifier derived from the endpoint. */
  subscriptionId: string
}

/**
 * Returns whether a host is one of the supported push services or their subdomains.
 *
 * @param host - Lower-case URL host name.
 * @returns `true` for an allowlisted push service host.
 */
export function isPushServiceHost(host: string): boolean {
  return pushServiceHostSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/**
 * Derives the stable identifier of a subscription from its endpoint.
 *
 * @param endpoint - Push service URL.
 * @returns Hex SHA-256 of the endpoint.
 */
export function createPushSubscriptionId(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex')
}

/**
 * Validates a push endpoint: an HTTPS URL on a supported push service, without credentials.
 *
 * @param value - Untrusted endpoint.
 * @returns The endpoint.
 */
export function readPushEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxEndpointLength) {
    throw invalidSubscription()
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalidSubscription()
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    // Fragments never reach the push service, so they would let one endpoint take several IDs.
    url.hash !== '' ||
    url.href !== value ||
    !isPushServiceHost(url.hostname)
  ) {
    throw invalidSubscription()
  }
  return value
}

/**
 * Validates a push subscription body sent by a browser.
 *
 * @param value - Untrusted request body.
 * @returns The subscription with its stable identifier.
 */
export function readPushSubscriptionInput(value: unknown): ValidatedPushSubscription {
  if (!isRecord(value) || !hasOnlyKeys(value, ['endpoint', 'keys'])) throw invalidSubscription()
  const endpoint = readPushEndpoint(value.endpoint)
  const keys = value.keys
  if (!isRecord(keys) || !hasOnlyKeys(keys, ['p256dh', 'auth'])) throw invalidSubscription()
  const p256dh = readBase64UrlKey(keys.p256dh, p256dhByteLength)
  const auth = readBase64UrlKey(keys.auth, authByteLength)
  // A key off the curve would be stored but fail every later encryption.
  const point = Buffer.from(p256dh, 'base64url')
  // Only the uncompressed form (0x04) is accepted; ECDH also accepts the hybrid forms.
  if (point[0] !== 0x04 || !isP256Point(point)) throw invalidSubscription()
  return { endpoint, keys: { p256dh, auth }, subscriptionId: createPushSubscriptionId(endpoint) }
}

/**
 * Validates the body of a subscription removal.
 *
 * @param value - Untrusted request body.
 * @returns The endpoint to remove.
 */
export function readPushSubscriptionRemoval(value: unknown): string {
  if (!isRecord(value) || !hasOnlyKeys(value, ['endpoint'])) throw invalidSubscription()
  return readPushEndpoint(value.endpoint)
}

/**
 * Validates an unpadded base64url key of an exact decoded length.
 *
 * @param value - Untrusted key.
 * @param byteLength - Expected decoded length.
 * @returns The key.
 */
function readBase64UrlKey(value: unknown, byteLength: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalidSubscription()
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== byteLength || decoded.toString('base64url') !== value) throw invalidSubscription()
  return value
}

/**
 * Returns whether a value is a plain object.
 *
 * @param value - Value to check.
 * @returns `true` for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Returns whether an object has no keys other than the allowed ones.
 *
 * @param value - Object to check.
 * @param allowed - Allowed keys.
 * @returns `true` when every key is allowed.
 */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

/**
 * Creates the error for a malformed or unsupported subscription.
 *
 * @returns A 400 notification error.
 */
function invalidSubscription(): NotificationError {
  return new NotificationError(400, 'InvalidPushSubscription', 'The push subscription is invalid.')
}

/**
 * Builds the push configuration from the deployment's VAPID public key.
 *
 * A missing or malformed key, or one that is not a point on P-256, disables push instead of
 * handing browsers a key they cannot use.
 *
 * @param vapidPublicKey - Configured base64url-encoded uncompressed P-256 public key.
 * @returns Push configuration for clients.
 */
export function createPushConfiguration(vapidPublicKey: string | undefined): PushConfiguration {
  const key = vapidPublicKey?.trim() ?? ''
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return { enabled: false }
  const decoded = Buffer.from(key, 'base64url')
  if (
    decoded.length !== p256dhByteLength ||
    decoded[0] !== 0x04 ||
    decoded.toString('base64url') !== key ||
    !isP256Point(decoded)
  ) {
    return { enabled: false }
  }
  return { enabled: true, vapidPublicKey: key }
}

/**
 * Returns whether bytes encode a point on the P-256 curve, so a mistyped key that browsers
 * would reject leaves push disabled instead of offering a feature that cannot subscribe.
 *
 * @param publicKey - Uncompressed point bytes.
 * @returns `true` when ECDH accepts the point.
 */
function isP256Point(publicKey: Buffer): boolean {
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    ecdh.computeSecret(publicKey)
    return true
  } catch {
    return false
  }
}
