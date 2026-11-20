import type { Hono } from 'hono'
import {
  createNotificationRouter,
} from '../../modules/notifications/adapter-in/http/notification-router'
import { createPushSubscriptionRouter } from '../../modules/notifications/adapter-in/http/push-subscription-router'
import { createTeamReminderSettingsRouter } from '../../modules/notifications/adapter-in/http/team-reminder-settings-router'
import { readReminderPolicyDefaultsFromEnvironment } from '../../modules/notifications'
import { createMutationAuditEventPut, getConfiguredAuditTableName } from '../../modules/audit/audit'
import { NOTIFICATION_REMINDER_DAY_FIELDS } from '@mukuroji/contracts'
import { createPushConfiguration } from '../../modules/notifications/domain/push-subscription'
import { loadServerConfig } from '../../infrastructure/config/server-config'
import { workItemDependencies } from '../shared/app-dependencies'
import { createRequestMutationContext, readJson } from '../shared/http'
import {
  canWorkspaceBusinessWrite,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  resolveEnterpriseAuditActorKind,
} from '../shared/project-access'
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
  routeApp.route('/', createTeamReminderSettingsRouter({
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    async requireTeamAccess(principal, teamId, access) {
      if (access === 'manage') requireWorkspaceBusinessWrite(principal)
      await requireTeamPermission(principal, teamId, access === 'manage' ? 'manager' : 'viewer')
    },
    async canManageTeam(principal, teamId) {
      if (!canWorkspaceBusinessWrite(principal)) return false
      try {
        await requireTeamPermission(principal, teamId, 'manager')
        return true
      } catch {
        return false
      }
    },
    getStore: () => workItemDependencies.teamReminderSettings,
    getDefaults: readReminderPolicyDefaultsFromEnvironment,
    createAuditPut(context, principal, input) {
      return createMutationAuditEventPut(
        getConfiguredAuditTableName(),
        createRequestMutationContext(
          context,
          principal.directoryId,
          principal.actorId,
          principal.userKey,
          input.body,
          undefined,
          // Service accounts and break-glass principals keep their Enterprise actor in the audit.
          resolveEnterpriseAuditActorKind(principal),
          principal.enterpriseBreakGlassActivationId,
        ),
        {
          directoryId: principal.directoryId,
          eventType: 'notification-reminders.updated',
          entityType: 'notification-reminders',
          entityId: `team/${input.teamId}/notification-reminders`,
          action: 'updated',
          summary: 'Team reminder settings were updated.',
          changes: NOTIFICATION_REMINDER_DAY_FIELDS
            .map((field) => ({
              field,
              before: input.before[field] ?? '',
              after: input.after[field] ?? '',
            }))
            .filter((change) => change.before !== change.after),
          metadata: {
            adapter: 'notification-reminders',
            teamId: input.teamId,
            beforeRevision: input.beforeRevision,
          },
        },
      )
    },
    mapError: toNotificationErrorResponse,
    readJson,
    now: () => new Date(),
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

