import type { PushConfiguration } from '@mukuroji/contracts'
import {
  readPushSubscriptionInput,
  readPushSubscriptionRemoval,
  type ValidatedPushSubscription,
} from '../domain/push-subscription'
import { NotificationError } from '../notifications'

/** Push subscription storage the use cases require. */
export type PushSubscriptionStore = {
  /**
   * Registers or refreshes a subscription for a member, taking the endpoint over from any other
   * member so one device never receives two people's notifications.
   */
  register(workspaceId: string, memberKey: string, subscription: ValidatedPushSubscription, now: Date): Promise<void>
  /** Removes a member's subscription for an endpoint; removing a missing one succeeds. */
  remove(workspaceId: string, memberKey: string, endpoint: string): Promise<void>
}

/** Authenticated principal a device is registered for. */
export type PushSubscriptionPrincipal = {
  /** Canonical Workspace ID. */
  directoryId: string
  /** Canonical Workspace member key. */
  userKey: string
  /** Kind of principal; only people may register devices. */
  principalKind?: string
}

/**
 * Registers the caller's device for Web Push.
 *
 * The subscription is always stored for the authenticated member; the request never names a
 * member or Workspace. Service accounts and other non-person principals are refused, and
 * registration is refused while the deployment has no VAPID key.
 *
 * @param store - Subscription storage.
 * @param configuration - Deployment push configuration.
 * @param principal - Authenticated principal.
 * @param body - Untrusted request body.
 * @param now - Current time.
 */
export async function registerPushDevice(
  store: PushSubscriptionStore,
  configuration: PushConfiguration,
  principal: PushSubscriptionPrincipal,
  body: unknown,
  now: Date,
): Promise<void> {
  requirePerson(principal)
  if (!configuration.enabled) {
    throw new NotificationError(409, 'PushNotificationsDisabled', 'Push notifications are not enabled.')
  }
  await store.register(principal.directoryId, principal.userKey, readPushSubscriptionInput(body), now)
}

/**
 * Removes the caller's device registration for an endpoint.
 *
 * @param store - Subscription storage.
 * @param principal - Authenticated principal.
 * @param body - Untrusted request body.
 */
export async function removePushDevice(
  store: PushSubscriptionStore,
  principal: PushSubscriptionPrincipal,
  body: unknown,
): Promise<void> {
  requirePerson(principal)
  await store.remove(principal.directoryId, principal.userKey, readPushSubscriptionRemoval(body))
}

/**
 * Rejects service accounts and other non-person principals.
 *
 * @param principal - Authenticated principal.
 */
function requirePerson(principal: PushSubscriptionPrincipal): void {
  if (principal.principalKind !== undefined && principal.principalKind !== 'member') {
    throw new NotificationError(403, 'PushSubscriptionForbidden', 'Only people can register devices for push notifications.')
  }
}
