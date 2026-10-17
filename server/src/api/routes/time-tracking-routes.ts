import type { Hono } from 'hono'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  createTimeTrackingRouter,
} from '../../modules/time-tracking/adapter-in/http/time-tracking-router'
import { TimeTrackingError } from '../../modules/time-tracking'
import { requireAppDependencies } from '../shared/app-dependencies'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import { requireTeamPermission, toProjectDataErrorResponse } from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { loadAuthorizedTeamIssue } from '../shared/work-item-access'
import { projectAccessAllows, toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

const timeTrackingDependencies = {
  get timeTrackingService() {
    return requireAppDependencies().timeTracking.timeTrackingService
  },
}

/** Converts time tracking domain failures to safe API responses. */
function toTimeTrackingErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) return toCognitoDirectoryErrorResponse(c, error)
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(c, error)
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) {
    return toProjectDataErrorResponse(c, error)
  }
  if (!(error instanceof TimeTrackingError)) {
    console.error(error)
    return c.json({ code: 'TimeTrackingUnavailable', message: 'Time tracking is unavailable.' }, 502)
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 409 ||
    error.status === 413 ||
    error.status === 422 ||
    error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.code, message: error.message }, status)
}

/**
 * Registers the time tracking HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerTimeTrackingRoutes(routeApp: Hono): void {
  routeApp.route('/', createTimeTrackingRouter({
    readBearerAccessToken,
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    requireTeamPermission: async (principal, teamId, minimum) => {
      await requireTeamPermission(principal, teamId, minimum)
    },
    canManageRates: async (principal, teamId) => {
      try {
        await requireTeamPermission(principal, teamId, 'manager')
        return true
      } catch (error) {
        if (error instanceof ProjectDataError && error.status === 403) return false
        throw error
      }
    },
    getAccessibleProjectIds: async (principal, teamId) => {
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      if (principal.isSystemAdmin) return undefined
      return new Set(
        (context.projectAccesses ?? [])
          .filter((access) => projectAccessAllows(access, 'viewer'))
          .map((access) => access.projectId),
      )
    },
    getManagedProjectIds: async (principal, teamId) => {
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      if (principal.isSystemAdmin) return undefined
      return new Set(
        (context.projectAccesses ?? [])
          .filter((access) => projectAccessAllows(access, 'manager'))
          .map((access) => access.projectId),
      )
    },
    verifyProject: async (principal, teamId, projectId, minimum) => {
      const context = await requireTeamPermission(principal, teamId, minimum)
      if (
        !principal.isSystemAdmin &&
        !(context.projectAccesses ?? []).some((access) =>
          access.projectId === projectId && projectAccessAllows(access, minimum)
        )
      ) {
        throw new ProjectDataError(
          403,
          'ProjectAccessDenied',
          `User "${principal.userKey}" cannot access project "${projectId}".`,
        )
      }
    },
    verifyWorkItem: async (principal, teamId, workItemId, minimum = 'member') => {
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, minimum)
      return detail.issue.assignedProjectId ?? undefined
    },
    getTimeTracking: () => timeTrackingDependencies.timeTrackingService,
    readJson,
    mapError: toTimeTrackingErrorResponse,
  }))
}
