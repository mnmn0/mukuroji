import useSWR from 'swr'
import type { PushConfiguration, PushSubscriptionInput, PushSubscriptionRemovalInput } from '@mukuroji/contracts'
import { NotificationsApiError } from '../api/errors'
import {
  getPushConfiguration,
  registerPushSubscription,
  removePushSubscription,
} from '../api/push'
import {
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
export const defaultPushDeviceApi: PushDeviceApi = {
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
  let pushManager: Awaited<ReturnType<PushEnvironment['getPushManager']>>
  try {
    pushManager = await environment.getPushManager()
  } catch {
    // A failed service worker lookup is not a missing worker; let the person retry.
    return { status: 'load-error', vapidPublicKey }
  }
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

/** Options of the push device status query. */
type PushDeviceStatusQueryOptions = {
  /** Browser capabilities. */
  environment: PushEnvironment
  /** Server calls. */
  api: PushDeviceApi
}

/**
 * Loads this device's push status once per session; SWR deduplicates repeated mounts and keeps
 * one cached status per session.
 *
 * @param accessToken - Access token for the API.
 * @param options - Browser capabilities and server calls.
 * @returns SWR state for the device status.
 */
export function usePushDeviceStatusQuery(accessToken: string, { environment, api }: PushDeviceStatusQueryOptions) {
  return useSWR(
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
