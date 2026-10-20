import { useCallback, useRef, useState } from 'react'
import { clearAuthSession, readAccessTokenSubject } from '../../auth/session'
import {
  decodeBase64Url,
  matchesApplicationServerKey,
  readPushEnvironment,
  readPushSubscriptionInput,
  type BrowserPushSubscription,
  type PushEnvironment,
} from '../../shared/lib/pwa/pushSubscription'
import {
  defaultPushDeviceApi,
  loadPushDevice,
  readRefreshFailureStatus,
  settlePushRegistrations,
  trackPushRegistration,
  usePushDeviceStatusQuery,
  type PushDeviceApi,
  type PushDeviceStatus,
} from '../queries/usePushDeviceStatus'

/** Outcome of the latest enable or disable action on this page. */
export type PushDeviceResult = 'enabled' | 'disabled' | 'dismissed' | 'denied' | 'failed'

/**
 * Asks for notification permission, subscribes this browser, and registers it on the server.
 *
 * The permission dialog is requested before any await so it stays inside the user's click.
 * A subscription created here is cancelled again when the server rejects it, and so is an
 * existing one the server refuses, so the browser never holds a subscription the server does not
 * know and the device never reads as on without a registration. An unusable existing subscription, made
 * for an earlier key or missing its keys, is removed on the server and replaced.
 *
 * @param accessToken - Access token for the API.
 * @param vapidPublicKey - Current VAPID public key.
 * @param environment - Browser capabilities.
 * @param api - Server calls.
 * @returns The outcome to announce.
 */
export async function enablePushDevice(
  accessToken: string,
  vapidPublicKey: string,
  environment: PushEnvironment,
  api: PushDeviceApi,
): Promise<PushDeviceResult> {
  const notification = environment.notification
  if (!notification) return 'failed'
  let permission: string
  try {
    permission = notification.permission === 'granted' ? 'granted' : await notification.requestPermission()
  } catch {
    return 'failed'
  }
  if (permission === 'denied') return 'denied'
  if (permission !== 'granted') return 'dismissed'
  let created = false
  try {
    const pushManager = await environment.getPushManager()
    if (!pushManager) return 'failed'
    let subscription = await pushManager.getSubscription()
    // A subscription for an earlier key, or one whose keys the browser no longer exposes, can
    // never be registered; remove it on the server and in the browser, then create a new one.
    // The server removal is best-effort and never holds up the replacement, which may stall.
    if (
      subscription &&
      (!matchesApplicationServerKey(subscription, vapidPublicKey) || !readPushSubscriptionInput(subscription))
    ) {
      void api.remove(accessToken, { endpoint: subscription.endpoint }).catch(() => undefined)
      await subscription.unsubscribe()
      subscription = null
    }
    if (!subscription) {
      subscription = await pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeBase64Url(vapidPublicKey),
      })
      created = true
    }
    const input = readPushSubscriptionInput(subscription)
    try {
      if (!input) throw new Error('The browser did not provide subscription keys.')
      await trackPushRegistration(api.register(accessToken, input))
      environment.registeredEndpoint?.write({ endpoint: input.endpoint, registrant: readAccessTokenSubject(accessToken) })
    } catch (error) {
      // A network failure says nothing about an existing registration, so only a refusal drops it.
      if (created || isRegistrationRefusal(error)) await subscription.unsubscribe().catch(() => false)
      throw error
    }
    return 'enabled'
  } catch {
    return 'failed'
  }
}

/**
 * Removes this device on the server and cancels the browser subscription.
 *
 * The browser subscription is cancelled even when the server call fails: a cancelled endpoint
 * can no longer receive anything, and the delivery worker drops endpoints the push service
 * reports as gone.
 *
 * @param accessToken - Access token for the API.
 * @param environment - Browser capabilities.
 * @param api - Server calls.
 * @returns `disabled`, or `failed` when the browser subscription could not be cancelled. The
 * remembered endpoint is kept on failure, so a later sign-out can still remove it on the server.
 */
export async function disablePushDevice(
  accessToken: string,
  environment: PushEnvironment,
  api: PushDeviceApi,
): Promise<PushDeviceResult> {
  try {
    const subscription = await (await environment.getPushManager())?.getSubscription()
    if (!subscription) return 'disabled'
    // The browser unsubscribe stops notifications on this device, so it never waits on the
    // best-effort server removal, which may stall.
    void api.remove(accessToken, { endpoint: subscription.endpoint }).catch(() => undefined)
    // `false` means nothing was cancelled, so the subscription may still be live.
    if (!await subscription.unsubscribe()) return 'failed'
    environment.registeredEndpoint?.write(undefined)
    return 'disabled'
  } catch {
    return 'failed'
  }
}

/** Longest time a sign-out waits for push cleanup before clearing the session. */
export const signOutPushCleanupWaitMilliseconds = 3_000

/**
 * Removes this device's push subscription when the member signs out, so a shared device does
 * not keep showing the previous member's notifications. Never rejects.
 *
 * Notifications already on screen are closed, and the browser subscription is cancelled
 * straight away, so the steps that stop notifications on this device never wait on the network.
 * The server removal also starts at once, so it is sent even when a registration never settles;
 * when registrations were still in flight it is sent again once they have settled, so an older
 * refresh that reached the server after the first removal cannot keep the registration. When the
 * browser's push store cannot be read, the endpoint this device last registered is removed on the
 * server instead.
 *
 * Every tab shares the browser's one subscription. When another signed-in account registered it
 * after this one, in another tab, it belongs to that account now: this sign-out removes only its
 * own registration on the server and leaves the subscription and the memory to that account.
 *
 * @param accessToken - Access token of the session being signed out, if still known.
 * @param environment - Browser capabilities; defaults to the running page.
 * @param api - Server calls; defaults to the push API.
 */
export async function disconnectPushDeviceOnSignOut(
  accessToken: string | undefined,
  environment: PushEnvironment = readPushEnvironment(),
  api: PushDeviceApi = defaultPushDeviceApi,
): Promise<void> {
  if (!environment.supported) return
  const remembered = environment.registeredEndpoint?.read()
  const registrant = accessToken ? readAccessTokenSubject(accessToken) : undefined
  const registeredElsewhere =
    remembered?.registrant !== undefined && registrant !== undefined && remembered.registrant !== registrant
  if (!registeredElsewhere) environment.registeredEndpoint?.write(undefined)
  await Promise.allSettled([
    closeDisplayedNotifications(environment),
    (async () => {
      let subscription: BrowserPushSubscription | null | undefined
      try {
        subscription = await (await environment.getPushManager())?.getSubscription()
      } catch {
        // The push store could not be read; the remembered endpoint still lets the server forget it.
      }
      const endpoint = subscription?.endpoint ?? remembered?.endpoint
      const ownedByAnotherAccount = registeredElsewhere && subscription?.endpoint === remembered?.endpoint
      await Promise.allSettled([
        ownedByAnotherAccount ? undefined : subscription?.unsubscribe(),
        (async () => {
          if (!accessToken || !endpoint) return
          const removal = api.remove(accessToken, { endpoint })
          if (await settlePushRegistrations()) {
            await removal.catch(() => undefined)
            await api.remove(accessToken, { endpoint })
          } else {
            await removal
          }
        })(),
      ])
    })(),
  ])
}

/**
 * Closes the app's notifications still on screen, so the previous member's titles and bodies
 * do not stay in the system's notification list after sign-out.
 *
 * @param environment - Browser capabilities.
 */
async function closeDisplayedNotifications(environment: PushEnvironment): Promise<void> {
  const notifications = await environment.getDisplayedNotifications?.() ?? []
  for (const notification of notifications) notification.close()
}

/**
 * Returns whether the server refused to hold this device's registration, as opposed to being
 * unreachable, failing, or rejecting the session.
 *
 * @param error - Error thrown by the registration.
 * @returns Whether the device cannot be registered as it is.
 */
function isRegistrationRefusal(error: unknown): boolean {
  const status = readRefreshFailureStatus(error)
  return status === 'off' || status === 'disabled'
}

/**
 * Signs the member out on an explicit sign-out action. Every sign-out control uses this and
 * navigates once it settles, so this device's push registration is removed with the token
 * being discarded before the session is cleared and the page can go away. The wait is bounded,
 * so a slow service worker or network never blocks signing out. Expiry-driven session cleanup
 * keeps calling `clearAuthSession`.
 *
 * @param accessToken - Access token of the session being signed out, if known.
 * @param cleanup - Push cleanup; defaults to removing this device's subscription.
 * @param waitMilliseconds - Longest wait for the cleanup.
 * @returns A promise that settles once the session is cleared.
 */
export async function signOutWithPushCleanup(
  accessToken: string | undefined,
  cleanup: (accessToken: string | undefined) => Promise<void> = disconnectPushDeviceOnSignOut,
  waitMilliseconds = signOutPushCleanupWaitMilliseconds,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      cleanup(accessToken),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, waitMilliseconds)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    clearAuthSession()
  }
}

/** Push device controller used by the notification settings. */
export type PushDeviceController = {
  /** Current device status. */
  status: PushDeviceStatus
  /** Whether an enable or disable action is running. */
  pending: boolean
  /** Outcome of the latest action on this page. */
  result?: PushDeviceResult
  /** Turns push on for this device; call only from a user action such as a click. */
  enable: () => void
  /** Turns push off for this device. */
  disable: () => void
  /** Reads the status again after a load error or a permission change outside the app. */
  retry: () => void
}

/** Optional dependencies of the push device controller. */
export type PushDeviceOptions = {
  /** Browser capabilities; defaults to the running page. */
  environment?: PushEnvironment
  /** Server calls; defaults to the push API. */
  api?: PushDeviceApi
}

/**
 * Tracks and changes whether this device receives the signed-in member's push notifications.
 *
 * @param accessToken - Access token for the API.
 * @param options - Browser capabilities and server calls.
 * @returns The device status and its actions.
 */
export function usePushDevice(accessToken: string, options: PushDeviceOptions = {}): PushDeviceController {
  const [environment] = useState(() => options.environment ?? readPushEnvironment())
  const [api] = useState(() => options.api ?? defaultPushDeviceApi)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<PushDeviceResult | undefined>()
  const pendingRef = useRef(false)
  const query = usePushDeviceStatusQuery(accessToken, { environment, api })
  const { mutate } = query

  /**
   * Runs one action and stores the status read after it settles.
   *
   * @param action - Enable or disable action.
   */
  const run = useCallback((action: () => Promise<PushDeviceResult>) => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setResult(undefined)
    void action().then(async (outcome) => {
      // A failed action proves nothing new, so the last confirmed status stays; reading it again
      // would infer `on` from a browser subscription the server never confirmed.
      if (outcome !== 'failed') {
        const next = await loadPushDevice(accessToken, environment, api, false)
        await mutate(next, { revalidate: false })
      }
      pendingRef.current = false
      setResult(outcome)
      setPending(false)
    })
  }, [accessToken, api, environment, mutate])

  const snapshot = query.data
  const vapidPublicKey = snapshot?.vapidPublicKey
  // A retry after a load error or a permission recheck shows loading until the new read settles.
  const reloading = query.isValidating && (snapshot?.status === 'load-error' || snapshot?.status === 'blocked')
  return {
    status: reloading || !snapshot ? 'loading' : snapshot.status,
    pending,
    ...(result ? { result } : {}),
    enable: useCallback(() => {
      if (!vapidPublicKey) return
      run(() => enablePushDevice(accessToken, vapidPublicKey, environment, api))
    }, [accessToken, api, environment, run, vapidPublicKey]),
    disable: useCallback(() => {
      run(() => disablePushDevice(accessToken, environment, api))
    }, [accessToken, api, environment, run]),
    retry: useCallback(() => {
      void mutate()
    }, [mutate]),
  }
}
