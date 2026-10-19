import type {
  PushConfiguration,
  PushSubscriptionInput,
  PushSubscriptionRemovalInput,
} from '@mukuroji/contracts'
import { NotificationsApiError } from './errors'

const pushApiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? '/api').replace(/\/+$/, '')

/**
 * Loads whether this deployment accepts Web Push subscriptions.
 *
 * @param accessToken - Access token for the API.
 * @returns The push configuration; a response without a usable key reads as disabled.
 */
export async function getPushConfiguration(accessToken: string): Promise<PushConfiguration> {
  const data = await requestPush(`${pushApiBaseUrl}/push/config`, accessToken)
  if (
    typeof data === 'object' &&
    data !== null &&
    'enabled' in data &&
    data.enabled === true &&
    'vapidPublicKey' in data &&
    typeof data.vapidPublicKey === 'string' &&
    data.vapidPublicKey.length > 0
  ) {
    return { enabled: true, vapidPublicKey: data.vapidPublicKey }
  }
  return { enabled: false }
}

/**
 * Registers or refreshes this device's push subscription for the signed-in member.
 *
 * @param accessToken - Access token for the API.
 * @param subscription - Endpoint and keys issued by the browser.
 */
export async function registerPushSubscription(
  accessToken: string,
  subscription: PushSubscriptionInput,
): Promise<void> {
  await requestPush(`${pushApiBaseUrl}/push-subscriptions`, accessToken, 'PUT', subscription)
}

/**
 * Removes this device's push subscription for the signed-in member.
 *
 * @param accessToken - Access token for the API.
 * @param removal - Endpoint to remove.
 */
export async function removePushSubscription(
  accessToken: string,
  removal: PushSubscriptionRemovalInput,
): Promise<void> {
  await requestPush(`${pushApiBaseUrl}/push-subscriptions`, accessToken, 'DELETE', removal)
}

/**
 * Sends one push API request and parses its JSON body.
 *
 * @param url - Request URL.
 * @param accessToken - Access token for the API.
 * @param method - HTTP method.
 * @param body - JSON body, if any.
 * @returns The parsed body, or `undefined` when it is empty or not JSON.
 */
async function requestPush(
  url: string,
  accessToken: string,
  method: 'GET' | 'PUT' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const record = typeof data === 'object' && data !== null ? data : {}
    const message = 'message' in record && typeof record.message === 'string' && record.message.trim()
      ? record.message
      : 'Unable to complete the push notification request.'
    const code = 'code' in record && typeof record.code === 'string' ? record.code : undefined
    throw new NotificationsApiError(response.status, message, code)
  }
  return data
}
