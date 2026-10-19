import { useCallback, useEffect, useRef, useState } from 'react'
import type { PushConfiguration, PushSubscriptionInput, PushSubscriptionRemovalInput } from '@mukuroji/contracts'
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
  const subscription = await pushManager.getSubscription().catch(() => null)
  const input = subscription ? readPushSubscriptionInput(subscription) : undefined
  if (
    !subscription ||
    !input ||
    environment.notification?.permission !== 'granted' ||
    !matchesApplicationServerKey(subscription, vapidPublicKey)
  ) {
    return { status: 'off', vapidPublicKey }
  }
  // The device stays on even when the refresh fails; the next visit retries it.
  if (refresh) await api.register(accessToken, input).catch(() => undefined)
  return { status: 'on', vapidPublicKey }
}

/**
 * Asks for notification permission, subscribes this browser, and registers it on the server.
 *
 * The permission dialog is requested before any await so it stays inside the user's click.
 * A subscription created here is cancelled again when the server rejects it, so the browser
 * never holds a subscription the server does not know.
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
    if (subscription && !matchesApplicationServerKey(subscription, vapidPublicKey)) {
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
  const [loaded, setLoaded] = useState<{
    /** Load the snapshot belongs to. */
    key: string
    /** Settled status. */
    snapshot: PushDeviceSnapshot
  } | undefined>()
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<PushDeviceResult | undefined>()
  const [loadCount, setLoadCount] = useState(0)
  const pendingRef = useRef(false)

  const loadKey = `${accessToken}:${loadCount}`
  // A snapshot from an earlier token or attempt reads as loading until the current load settles.
  const snapshot = loaded?.key === loadKey ? loaded.snapshot : undefined

  useEffect(() => {
    let active = true
    void loadPushDevice(accessToken, environment, api).then((next) => {
      if (active) setLoaded({ key: loadKey, snapshot: next })
    })
    return () => {
      active = false
    }
  }, [accessToken, api, environment, loadKey])

  /**
   * Runs one action and reloads the status after it settles.
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
      pendingRef.current = false
      setLoaded({ key: loadKey, snapshot: next })
      setResult(outcome)
      setPending(false)
    })
  }, [accessToken, api, environment, loadKey])

  const vapidPublicKey = snapshot?.vapidPublicKey
  return {
    status: snapshot?.status ?? 'loading',
    pending,
    ...(result ? { result } : {}),
    enable: useCallback(() => {
      if (!vapidPublicKey) return
      run(() => enablePushDevice(accessToken, vapidPublicKey, environment, api))
    }, [accessToken, api, environment, run, vapidPublicKey]),
    disable: useCallback(() => {
      run(() => disablePushDevice(accessToken, environment, api))
    }, [accessToken, api, environment, run]),
    retry: useCallback(() => setLoadCount((count) => count + 1), []),
  }
}
