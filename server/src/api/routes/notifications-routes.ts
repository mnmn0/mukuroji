import type { Hono } from 'hono'
import {
  createNotificationRouter,
} from '../../modules/notifications/adapter-in/http/notification-router'
import { workItemDependencies } from '../shared/app-dependencies'
import { readJson } from '../shared/http'
import {
  createNotificationVisibilityFilter,
  toNotificationErrorResponse,
} from '../shared/notification-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'

/**
 * Registers the notifications HTTP routes on the shared route application.
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
}
