import { useCallback, useRef, useState } from 'react'
import useSWR from 'swr'
import type { PushConfiguration, PushSubscriptionInput, PushSubscriptionRemovalInput } from '@mukuroji/contracts'
import { clearAuthSession } from '../../auth/session'
import { NotificationsApiError } from '../api/errors'
import {
  getPushConfiguration,
  registerPushSubscription,
  removePushSubscription,
} from '../api/push'
import {
  decodeBase64Url,
  matchesApplicationServerKey,
  readPushEnvironment,
  readPushSubscriptionInput,
  type PushEnvironment,
} from '../../shared/lib/pwa/pushSubscription'

/**
 * Push state of this device: `unsupported` without the browser APIs or a service worker,
 * `disabled` when the deployment has no push key, `blocked` when notifications are denied,
 * and `load-error` when the configuration could not be read.
 */
export type PushDeviceStatus = 'loading' | 'unsupported' | 'disabled' | 'blocked' | 'off' | 'on' | 'load-error'

/** Outcome of the latest enable or disable action on this page. */
export type PushDeviceResult = 'enabled' | 'disabled' | 'dismissed' | 'denied' | 'failed'

/** Server calls the push device controller makes. */
export type PushDeviceApi = {
  /** Loads the deployment's push configuration. */
  getConfiguration: (accessToken: string) => Promise<PushConfiguration>
  /** Registers this device for the signed-in member. */
  register: (accessToken: string, subscription: PushSubscriptionInput) => Promise<void>
  /** Removes this device for the signed-in member. */
  remove: (accessToken: string, removal: PushSubscriptionRemovalInput) => Promise<void>
}

/** Default push API calls. */
const defaultPushDeviceApi: PushDeviceApi = {
  getConfiguration: getPushConfiguration,
  register: registerPushSubscription,
  remove: removePushSubscription,
}

/** Settled push state of this device and the key it is bound to. */
export type PushDeviceSnapshot = {
  /** Current status. */
  status: Exclude<PushDeviceStatus, 'loading'>
  /** VAPID public key when the deployment accepts push. */
  vapidPublicKey?: string
}

/**
 * Reads this device's push status and refreshes an active registration on the server.
 *
 * Refreshing keeps the server's retention window and endpoint ownership current, so a device
 * that is used keeps receiving the signed-in member's notifications.
 *
 * @param accessToken - Access token for the API.
 * @param environment - Browser capabilities.
 * @param api - Server calls.
 * @param refresh - Whether to refresh an active registration; skipped right after an action.
 * @returns The device status.
 */
export async function loadPushDevice(
  accessToken: string,
  environment: PushEnvironment,
  api: PushDeviceApi,
  refresh = true,
): Promise<PushDeviceSnapshot> {
  if (!environment.supported) return { status: 'unsupported' }
  let configuration: PushConfiguration
  try {
    configuration = await api.getConfiguration(accessToken)
  } catch {
    return { status: 'load-error' }
  }
  const vapidPublicKey = configuration.vapidPublicKey
  if (!configuration.enabled || !vapidPublicKey) return { status: 'disabled' }
  const pushManager = await environment.getPushManager().catch(() => undefined)
  if (!pushManager) return { status: 'unsupported' }
  if (environment.notification?.permission === 'denied') return { status: 'blocked', vapidPublicKey }
  let subscription: Awaited<ReturnType<typeof pushManager.getSubscription>>
  try {
    subscription = await pushManager.getSubscription()
  } catch {
    // An unreadable push store is not the same as no subscription; let the person retry.
    return { status: 'load-error', vapidPublicKey }
  }
  const input = subscription ? readPushSubscriptionInput(subscription) : undefined
  if (
    !subscription ||
    !input ||
    environment.notification?.permission !== 'granted' ||
    !matchesApplicationServerKey(subscription, vapidPublicKey)
  ) {
    return { status: 'off', vapidPublicKey }
  }
  if (refresh) {
    try {
      await api.register(accessToken, input)
    } catch (error: unknown) {
      return { status: readRefreshFailureStatus(error), vapidPublicKey }
    }
  }
  return { status: 'on', vapidPublicKey }
}

/**
 * Maps a failed registration refresh to the device status it reveals.
 *
 * A network error or server failure says nothing about the registration, so the device stays
 * on and the next visit retries. A refusal means the server does not hold this device: the
 * deployment turned push off, or the subscription is invalid, not allowed, over the device
 * limit, or lost an ownership race. Any other refusal leaves the state unknown.
 *
 * @param error - Error thrown by the refresh.
 * @returns The status to show.
 */
function readRefreshFailureStatus(error: unknown): Exclude<PushDeviceStatus, 'loading'> {
  if (!(error instanceof NotificationsApiError) || error.status >= 500) return 'on'
  if (error.code === 'PushNotificationsDisabled') return 'disabled'
  if (
    error.code === 'InvalidPushSubscription' ||
    error.code === 'PushSubscriptionForbidden' ||
    error.code === 'PushSubscriptionLimitExceeded' ||
    error.code === 'PushSubscriptionConflict'
  ) {
    return 'off'
  }
  return 'load-error'
}

/**
 * Asks for notification permission, subscribes this browser, and registers it on the server.
 *
 * The permission dialog is requested before any await so it stays inside the user's click.
 * A subscription created here is cancelled again when the server rejects it, so the browser
 * never holds a subscription the server does not know. An unusable existing subscription, made
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
    if (
      subscription &&
      (!matchesApplicationServerKey(subscription, vapidPublicKey) || !readPushSubscriptionInput(subscription))
    ) {
      await api.remove(accessToken, { endpoint: subscription.endpoint }).catch(() => undefined)
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
      await api.register(accessToken, input)
    } catch (error) {
      if (created) await subscription.unsubscribe().catch(() => false)
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
 * @returns `disabled`, or `failed` when the browser subscription could not be cancelled.
 */
export async function disablePushDevice(
  accessToken: string,
  environment: PushEnvironment,
  api: PushDeviceApi,
): Promise<PushDeviceResult> {
  try {
    const subscription = await (await environment.getPushManager())?.getSubscription()
    if (!subscription) return 'disabled'
    await api.remove(accessToken, { endpoint: subscription.endpoint }).catch(() => undefined)
    await subscription.unsubscribe()
    return 'disabled'
  } catch {
    return 'failed'
  }
}

/**
 * Removes this device's push subscription when the member signs out, so a shared device does
 * not keep showing the previous member's notifications. Never rejects.
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
  try {
    const subscription = await (await environment.getPushManager())?.getSubscription()
    if (!subscription) return
    if (accessToken) await api.remove(accessToken, { endpoint: subscription.endpoint }).catch(() => undefined)
    await subscription.unsubscribe()
  } catch {
    // Sign-out never waits on or fails because of push cleanup.
  }
}

/**
 * Signs the member out on an explicit sign-out action. Every sign-out control uses this, so
 * this device's push registration is always removed with the token being discarded, before
 * the session is cleared. Expiry-driven session cleanup keeps calling `clearAuthSession`.
 *
 * @param accessToken - Access token of the session being signed out, if known.
 */
export function signOutWithPushCleanup(accessToken: string | undefined): void {
  void disconnectPushDeviceOnSignOut(accessToken)
  clearAuthSession()
}

/**
 * Refreshes this device's server registration when it already receives push, so a device in use
 * keeps its retention window and endpoint ownership without visiting the settings. Never rejects.
 *
 * Only an existing, permitted subscription triggers any request, so devices that never opted in
 * cost nothing.
 *
 * @param accessToken - Access token of the signed-in member.
 * @param environment - Browser capabilities; defaults to the running page.
 * @param api - Server calls; defaults to the push API.
 */
export async function refreshPushDevice(
  accessToken: string,
  environment: PushEnvironment = readPushEnvironment(),
  api: PushDeviceApi = defaultPushDeviceApi,
): Promise<void> {
  if (!environment.supported || environment.notification?.permission !== 'granted') return
  try {
    const subscription = await (await environment.getPushManager())?.getSubscription()
    if (!subscription) return
    await loadPushDevice(accessToken, environment, api)
  } catch {
    // A failed refresh is retried on the next app start.
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
  /** Reads the status again after a load error. */
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
  // SWR owns the load: it deduplicates repeated mounts and keeps one cached status per session.
  const query = useSWR(
    ['push-device', accessToken] as const,
    ([, token]) => loadPushDevice(token, environment, api),
    {
      dedupingInterval: 60_000,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  )
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
      const next = await loadPushDevice(accessToken, environment, api, false)
      await mutate(next, { revalidate: false })
      pendingRef.current = false
      setResult(outcome)
      setPending(false)
    })
  }, [accessToken, api, environment, mutate])

  const snapshot = query.data
  const vapidPublicKey = snapshot?.vapidPublicKey
  // A retry after a load error shows loading until the new read settles.
  const reloading = query.isValidating && snapshot?.status === 'load-error'
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

/**
 * Refreshes this device's registration once per signed-in session through SWR, so the shell
 * never sends it from an Effect and repeated mounts share one request.
 *
 * @param accessToken - Access token of the signed-in member, or `undefined` before sign-in.
 */
export function usePushDeviceRefresh(accessToken: string | undefined): void {
  useSWR(
    accessToken ? ['push-device-refresh', accessToken] as const : null,
    ([, token]) => refreshPushDevice(token),
    {
      dedupingInterval: 60 * 60_000,
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  )
}
