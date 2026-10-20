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
  /** Endpoint this device last registered; omitted where nothing can be remembered. */
  registeredEndpoint?: RegisteredEndpointMemory
  /** Cross-tab lock ordering registrations against sign-outs; omitted where the browser has none. */
  registrationLock?: RegistrationLock
}

/** Cross-tab lock that orders registrations of the shared subscription against sign-outs. */
export type RegistrationLock = {
  /**
   * Runs a registration while holding the lock, so other tabs see its claim settle first.
   *
   * @param task - Registration to run.
   * @returns The task's result.
   */
  hold: <Result>(task: () => Promise<Result>) => Promise<Result>
  /**
   * Runs a task once no tab holds the lock, or without it once the wait runs out.
   *
   * @param task - Task to run.
   * @param timeoutMilliseconds - Longest wait for the lock.
   * @returns The task's result.
   */
  afterRegistrations: <Result>(task: () => Promise<Result>, timeoutMilliseconds: number) => Promise<Result>
}

/** Name of the Web Lock held while this origin registers its push subscription. */
const registrationLockName = 'mukuroji.push.registration'

/**
 * Creates the registration lock from the browser's Web Locks API.
 *
 * @param locks - Lock manager of the page.
 * @returns The registration lock.
 */
export function createRegistrationLock(locks: Pick<LockManager, 'request'>): RegistrationLock {
  return {
    hold: (task) => locks.request(registrationLockName, task),
    afterRegistrations: async (task, timeoutMilliseconds) => {
      let acquired = false
      try {
        return await locks.request(registrationLockName, { signal: AbortSignal.timeout(timeoutMilliseconds) }, () => {
          acquired = true
          return task()
        })
      } catch (error: unknown) {
        // Only a lock that never came is retried without it; the task's own failure stays.
        if (acquired) throw error
        return await task()
      }
    },
  }
}

/** Endpoint this device last registered, with the account that registered it. */
export type RegisteredEndpoint = {
  /** Registered endpoint. */
  endpoint: string
  /** Subject of the account that registered it, when the token exposed one. */
  registrant?: string
  /** Whether the registration is still waiting for the server, so it does not prove ownership yet. */
  pending?: boolean
  /** Random token of the pending registration, so only that request may confirm or undo it. */
  claim?: string
}

/** Device-local memory of the endpoint last registered on the server. */
export type RegisteredEndpointMemory = {
  /**
   * Reads the remembered registration.
   *
   * @returns The registration, or `undefined` when none is remembered or storage is unavailable.
   */
  read: () => RegisteredEndpoint | undefined
  /**
   * Remembers a registration, or forgets it.
   *
   * @param registration - Registration to remember; `undefined` forgets it.
   */
  write: (registration: RegisteredEndpoint | undefined) => void
}

/** Storage key of the endpoint this device last registered. */
const registeredEndpointStorageKey = 'mukuroji.push.registeredEndpoint'

/**
 * Remembers the registered endpoint in local storage, so sign-out can still remove it on the
 * server when the browser's push store cannot be read. Local storage is shared by every tab, so
 * the registrant tells a sign-out whether another signed-in account registered the browser's
 * subscription after it. Storage failures are ignored.
 *
 * @param storage - Local storage of the page.
 * @returns The endpoint memory.
 */
export function createRegisteredEndpointMemory(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): RegisteredEndpointMemory {
  return {
    read: () => {
      try {
        return parseRegisteredEndpoint(storage.getItem(registeredEndpointStorageKey))
      } catch {
        return undefined
      }
    },
    write: (registration) => {
      try {
        if (registration === undefined) storage.removeItem(registeredEndpointStorageKey)
        else storage.setItem(registeredEndpointStorageKey, JSON.stringify(registration))
      } catch {
        // Remembering is best-effort; the browser subscription stays the primary source.
      }
    },
  }
}

/**
 * Reads a stored registration, ignoring values of any other shape.
 *
 * @param value - Stored text.
 * @returns The registration, or `undefined`.
 */
function parseRegisteredEndpoint(value: string | null): RegisteredEndpoint | undefined {
  if (!value) return undefined
  let data: unknown
  try {
    data = JSON.parse(value)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null || !('endpoint' in data) || typeof data.endpoint !== 'string') {
    return undefined
  }
  const registrant = 'registrant' in data && typeof data.registrant === 'string' ? data.registrant : undefined
  const pending = 'pending' in data && data.pending === true
  const claim = 'claim' in data && typeof data.claim === 'string' ? data.claim : undefined
  return {
    endpoint: data.endpoint,
    ...(registrant === undefined ? {} : { registrant }),
    ...(pending ? { pending } : {}),
    ...(claim === undefined ? {} : { claim }),
  }
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
    // Storage stays readable, so a sign-out can still remove an endpoint registered while push
    // was available.
    return {
      supported: false,
      notification: undefined,
      getPushManager: async () => undefined,
      ...withRegisteredEndpointMemory(),
    }
  }
  return {
    supported: true,
    notification: Notification,
    getPushManager: async () => (await readServiceWorkerRegistration(navigator.serviceWorker))?.pushManager,
    getDisplayedNotifications: async () =>
      (await readServiceWorkerRegistration(navigator.serviceWorker))?.getNotifications() ?? [],
    ...withRegisteredEndpointMemory(),
    ...('locks' in navigator && navigator.locks ? { registrationLock: createRegistrationLock(navigator.locks) } : {}),
  }
}

/**
 * Creates the endpoint memory, or none when the page cannot reach local storage, as when site
 * data is blocked and reading `window.localStorage` throws.
 *
 * @returns The memory, or `undefined` when storage cannot be reached.
 */
function readRegisteredEndpointMemory(): RegisteredEndpointMemory | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return createRegisteredEndpointMemory(window.localStorage)
  } catch {
    return undefined
  }
}

/**
 * Returns the environment's endpoint memory property, omitted when storage cannot be reached.
 *
 * @returns An object to spread into the environment.
 */
function withRegisteredEndpointMemory(): Pick<PushEnvironment, 'registeredEndpoint'> {
  const registeredEndpoint = readRegisteredEndpointMemory()
  return registeredEndpoint ? { registeredEndpoint } : {}
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
