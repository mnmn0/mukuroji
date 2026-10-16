import type { Hono } from 'hono'
import { validateWorkItemConfiguration } from '../../modules/work-items/work-item-configuration'
import {
  createWorkItemConfigurationRouter,
} from '../../modules/work-items/adapter-in/http/work-item-configuration-router'
import { workItemDependencies } from '../shared/app-dependencies'
import { validateWorkItemConfigurationUsage } from '../shared/automation-access'
import { toWorkItemConfigurationErrorResponse } from '../shared/collaboration-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  createWorkspaceMutationContext,
  requireTeamConfigurationAdministration,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessWrite,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { validateWorkItemConfigurationReferences } from '../shared/work-item-configuration'

/**
 * Registers the work item configuration HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerWorkItemConfigurationRoutes(routeApp: Hono): void {
  routeApp.route('/', createWorkItemConfigurationRouter<WorkspacePrincipal>({
    getWorkItemConfigurations: () => workItemDependencies.workItemConfigurations,
    readBearerAccessToken,
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    requireWorkspaceAdministration,
    createAuditContext: (context, principal, body) =>
      createWorkspaceMutationContext(context, principal, body),
    requireWorkspaceBusinessWrite,
    requireTeamPermission: async (principal, teamId, minimum) => {
      await requireTeamPermission(principal, teamId, minimum)
    },
    requireTeamConfigurationAdministration,
    readJson,
    validateConfiguration: validateWorkItemConfiguration,
    validateReferences: validateWorkItemConfigurationReferences,
    validateUsage: validateWorkItemConfigurationUsage,
    mapError: toWorkItemConfigurationErrorResponse,
  }))
}
