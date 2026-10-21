import type { Hono } from 'hono'
import {
  createNotificationRouter,
} from '../../modules/notifications/adapter-in/http/notification-router'
import { createPushSubscriptionRouter } from '../../modules/notifications/adapter-in/http/push-subscription-router'
import { createPushConfiguration } from '../../modules/notifications/domain/push-subscription'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { workItemDependencies } from '../shared/app-dependencies'
import { readJson } from '../shared/http'
import {
  createNotificationVisibilityFilter,
  toNotificationErrorResponse,
} from '../shared/notification-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'

/**
 * Registers the notifications and Web Push subscription HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerNotificationsRoutes(routeApp: Hono): void {
  routeApp.route('/', createNotificationRouter({
    getNotifications: () => workItemDependencies.notifications,
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    createVisibilityFilter: createNotificationVisibilityFilter,
    mapError: toNotificationErrorResponse,
    readJson,
  }))
  routeApp.route('/', createPushSubscriptionRouter({
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    getStore: () => workItemDependencies.pushSubscriptions,
    getConfiguration: () => createPushConfiguration(loadServerConfig().environment.WEB_PUSH_VAPID_PUBLIC_KEY),
    mapError: toNotificationErrorResponse,
    readJson,
    now: () => new Date(),
  }))
}
