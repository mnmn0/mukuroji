import { Hono, type Context } from 'hono'
import type { PushConfiguration } from '@mukuroji/contracts'
import {
  registerPushDevice,
  removePushDevice,
  type PushSubscriptionPrincipal,
  type PushSubscriptionStore,
} from '../../application/push-subscriptions'

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
 * Creates the routes that let a member register this device for Web Push. The routes only
 * authenticate and parse the request; the use cases decide who may register and what is stored.
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
      const principal = await dependencies.authenticate(accessToken, context)
      await registerPushDevice(
        dependencies.getStore(),
        dependencies.getConfiguration(),
        principal,
        await dependencies.readJson(context.req),
        dependencies.now(),
      )
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  router.delete('/api/push-subscriptions', async (context) => {
    const accessToken = readBearerAccessToken(context)
    if (!accessToken) return context.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await dependencies.authenticate(accessToken, context)
      await removePushDevice(dependencies.getStore(), principal, await dependencies.readJson(context.req))
      return context.body(null, 204)
    } catch (error) {
      return dependencies.mapError(context, error)
    }
  })

  return router
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
