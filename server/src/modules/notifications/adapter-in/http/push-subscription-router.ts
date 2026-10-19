import { Hono, type Context } from 'hono'
import type { PushConfiguration } from '@mukuroji/contracts'
import type { PushSubscriptionStore } from '../../adapter-out/dynamodb/push-subscription-store'
import {
  readPushSubscriptionInput,
  readPushSubscriptionRemoval,
} from '../../domain/push-subscription'
import { NotificationError } from '../../notifications'

/** Authenticated principal fields the push subscription routes use. */
export type PushSubscriptionPrincipal = {
  /** Canonical Workspace ID. */
  directoryId: string
  /** Canonical Workspace member key. */
  userKey: string
  /** Kind of principal; only people may register devices. */
  principalKind?: string
}

/** Dependencies of the push subscription routes. */
export type PushSubscriptionRouterDependencies<Principal extends PushSubscriptionPrincipal> = {
  /** Resolves a bearer token to the current Workspace principal. */
  authenticate(accessToken: string, context: Context): Promise<Principal>
  /** Returns the push subscription store. */
  getStore(): PushSubscriptionStore
  /** Returns the deployment's push configuration. */
  getConfiguration(): PushConfiguration
  /** Converts an error to the API's error response. */
  mapError(context: Context, error: unknown): Response
  /** Parses a request body, returning `undefined` when it is not JSON. */
  readJson(request: { json: () => Promise<unknown> }): Promise<unknown>
  /** Clock used for retention. */
  now(): Date
}

/**
 * Creates the routes that let a member register this device for Web Push.
 *
 * Subscriptions are always stored for the authenticated member; the request never names a
 * member or Workspace.
 *
 * @param dependencies - Authentication, store, configuration, and HTTP helpers.
 * @returns Hono router with the push routes.
 */
export function createPushSubscriptionRouter<Principal extends PushSubscriptionPrincipal>(
  dependencies: PushSubscriptionRouterDependencies<Principal>,
) {
  const router = new Hono()

  router.get('/api/push/config', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) return context.json({ message: 'Bearer token is required.' }, 401)
    try {
      await dependencies.authenticate(accessToken, context)
      return context.json(dependencies.getConfiguration())
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.put('/api/push-subscriptions', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) return context.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = requirePerson(await dependencies.authenticate(accessToken, context))
      requireEnabled(dependencies.getConfiguration())
      const subscription = readPushSubscriptionInput(await dependencies.readJson(context.req))
      await dependencies.getStore().register(principal.directoryId, principal.userKey, subscription, dependencies.now())
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/push-subscriptions', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) return context.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = requirePerson(await dependencies.authenticate(accessToken, context))
      const endpoint = readPushSubscriptionRemoval(await dependencies.readJson(context.req))
      await dependencies.getStore().remove(principal.directoryId, principal.userKey, endpoint)
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
}

/**
 * Rejects service accounts and other non-person principals.
 *
 * @param principal - Authenticated principal.
 * @returns The principal when it is a person.
 */
function requirePerson<Principal extends PushSubscriptionPrincipal>(principal: Principal): Principal {
  if (principal.principalKind !== undefined && principal.principalKind !== 'member') {
    throw new NotificationError(403, 'PushSubscriptionForbidden', 'Only people can register devices for push notifications.')
  }
  return principal
}

/**
 * Rejects registration while the deployment has no VAPID key.
 *
 * @param configuration - Push configuration.
 */
function requireEnabled(configuration: PushConfiguration): void {
  if (!configuration.enabled) {
    throw new NotificationError(409, 'PushNotificationsDisabled', 'Push notifications are not enabled.')
  }
}

/**
 * Reads the bearer token from the Authorization header.
 *
 * @param context - Request context.
 * @returns The token, or `undefined` when missing.
 */
function readBearerAccessToken(context: Context): string | undefined {
  const match = context.req.header('Authorization')?.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || undefined
}
