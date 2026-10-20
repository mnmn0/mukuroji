import type { PushSubscriptionInput } from '@mukuroji/contracts'
import type { NotificationPermissionSource } from './badgePermission'

/** Browser push subscription fields the app reads. */
export type BrowserPushSubscription = {
  /** Push service URL issued by the browser. */
  readonly endpoint: string
  /** Options the subscription was created with. */
  readonly options?: {
    /** Application server key the subscription is bound to. */
    readonly applicationServerKey: ArrayBuffer | null
  }
  /**
   * Serializes the subscription, including its encryption keys.
   *
   * @returns Endpoint and base64url keys.
   */
  toJSON: () => {
    /** Push service URL. */
    endpoint?: string
    /** base64url-encoded encryption keys. */
    keys?: Record<string, string>
  }
  /**
   * Cancels the subscription at the push service.
   *
   * @returns Whether a subscription was cancelled.
   */
  unsubscribe: () => Promise<boolean>
}

/** Push manager fields the app uses. */
export type BrowserPushManager = {
  /**
   * Reads this browser's current subscription.
   *
   * @returns The subscription, or `null` when none exists.
   */
  getSubscription: () => Promise<BrowserPushSubscription | null>
  /**
   * Creates a subscription bound to an application server key.
   *
   * @param options - Visibility promise and application server key.
   * @returns The new subscription.
   */
  subscribe: (options: {
    /** Every push shows a notification; browsers require it. */
    userVisibleOnly: true
    /** Decoded VAPID public key. */
    applicationServerKey: Uint8Array<ArrayBuffer>
  }) => Promise<BrowserPushSubscription>
}

/** Browser capabilities Web Push needs on this page. */
export type PushEnvironment = {
  /** Whether the browser has the Push API, service workers, and notifications. */
  supported: boolean
  /** Notification API used for permission, when the browser has one. */
  notification: NotificationPermissionSource | undefined
  /**
   * Resolves the push manager of the registered service worker.
   *
   * @returns The push manager, or `undefined` when no worker is registered.
   */
  getPushManager: () => Promise<BrowserPushManager | undefined>
  /**
   * Lists the notifications this app is currently showing; omitted where there are none to read.
   *
   * @returns Notifications that can be closed.
   */
  getDisplayedNotifications?: () => Promise<readonly DisplayedNotification[]>
}

/** Notification the app is currently showing. */
export type DisplayedNotification = {
  /** Removes the notification from the system's notification list. */
  close: () => void
}

/**
 * Reads the running page's Web Push capabilities.
 *
 * @returns The environment; unsupported outside a browser or without a service worker API.
 */
export function readPushEnvironment(): PushEnvironment {
  if (
    typeof window === 'undefined' ||
    typeof navigator === 'undefined' ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    typeof Notification === 'undefined'
  ) {
    return { supported: false, notification: undefined, getPushManager: async () => undefined }
  }
  return {
    supported: true,
    notification: Notification,
    getPushManager: async () => (await readServiceWorkerRegistration(navigator.serviceWorker))?.pushManager,
    getDisplayedNotifications: async () =>
      (await readServiceWorkerRegistration(navigator.serviceWorker))?.getNotifications() ?? [],
  }
}

/** How long to wait for the app's first service worker registration before giving up. */
export const serviceWorkerRegistrationWaitMilliseconds = 10_000

/**
 * Resolves the page's service worker registration, waiting for the first registration.
 *
 * The app registers its worker after the window `load` event, so on a first visit the settings
 * can mount before any registration exists. Waiting for `ready` covers that; the bounded wait
 * keeps pages without a worker, such as the development server, from loading forever.
 *
 * @param container - Service worker container of the page, or an equivalent.
 * @param waitMilliseconds - Longest wait for a first registration.
 * @returns The registration, or `undefined` when none appeared in time.
 */
export async function readServiceWorkerRegistration<Registration>(
  container: {
    /** Resolves the current registration, if any. */
    getRegistration: () => Promise<Registration | undefined>
    /** Settles once a registration is active. */
    ready: Promise<Registration>
  },
  waitMilliseconds = serviceWorkerRegistrationWaitMilliseconds,
): Promise<Registration | undefined> {
  const registration = await container.getRegistration()
  if (registration) return registration
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      container.ready,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), waitMilliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Decodes an unpadded base64url string into bytes.
 *
 * @param value - base64url text.
 * @returns The decoded bytes.
 */
export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/**
 * Returns whether a subscription is bound to the given application server key.
 *
 * A subscription made for an earlier VAPID key cannot receive pushes signed with the current
 * one. Browsers that do not expose the key are trusted to match.
 *
 * @param subscription - Existing browser subscription.
 * @param vapidPublicKey - Current base64url-encoded VAPID public key.
 * @returns Whether the subscription uses that key.
 */
export function matchesApplicationServerKey(subscription: BrowserPushSubscription, vapidPublicKey: string): boolean {
  const current = subscription.options?.applicationServerKey
  if (!current) return true
  const expected = decodeBase64Url(vapidPublicKey)
  const actual = new Uint8Array(current)
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
}

/**
 * Reads the endpoint and keys the server needs from a browser subscription.
 *
 * @param subscription - Browser subscription.
 * @returns The registration body, or `undefined` when the browser omitted a key.
 */
export function readPushSubscriptionInput(subscription: BrowserPushSubscription): PushSubscriptionInput | undefined {
  const { keys } = subscription.toJSON()
  const p256dh = keys?.p256dh
  const auth = keys?.auth
  if (!subscription.endpoint || !p256dh || !auth) return undefined
  return { endpoint: subscription.endpoint, keys: { p256dh, auth } }
}
