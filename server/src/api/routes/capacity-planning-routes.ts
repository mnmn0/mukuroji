import type { Hono } from 'hono'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  createCapacityPlanningRouter,
} from '../../modules/capacity-planning/adapter-in/http/capacity-planning-router'
import { CapacityPlanningError } from '../../modules/capacity-planning'
import { requireAppDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  requireTeamPermission,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { loadAuthorizedTeamIssue } from '../shared/work-item-access'
import { projectAccessAllows, toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

const capacityPlanningDependencies = {
  get capacityPlanningService() {
    return requireAppDependencies().capacityPlanning.capacityPlanningService
  },
}

const WORKLOAD_PROJECT_MEMBER_BATCH_SIZE = 20

/** Reads canonical members for workload visibility using bounded directory batches. */
async function readWorkloadProjectMemberIds(
  principal: WorkspacePrincipal,
  projectIds: readonly string[],
): Promise<Set<string>> {
  const memberIds = new Set<string>()
  for (let index = 0; index < projectIds.length; index += WORKLOAD_PROJECT_MEMBER_BATCH_SIZE) {
    const batch = projectIds.slice(index, index + WORKLOAD_PROJECT_MEMBER_BATCH_SIZE)
    const responses = await Promise.all(batch.map((projectId) =>
      workspaceDependencies.projectDirectory.getProjectMembers(principal.directoryId, projectId),
    ))
    for (const response of responses) {
      for (const member of response.members) memberIds.add(member.id)
    }
  }
  return memberIds
}

/** Converts capacity-planning failures to safe API responses. */
function toCapacityPlanningErrorResponse(c: Context, error: unknown) {
  if (error instanceof CognitoServiceError) return toCognitoDirectoryErrorResponse(c, error)
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(c, error)
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) {
    return toProjectDataErrorResponse(c, error)
  }
  if (!(error instanceof CapacityPlanningError)) {
    console.error(error)
    return c.json({ code: 'CapacityPlanningUnavailable', message: 'Capacity planning is unavailable.' }, 502)
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
 * Registers the capacity planning HTTP routes on the shared route application.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerCapacityPlanningRoutes(routeApp: Hono): void {
  routeApp.route('/', createCapacityPlanningRouter({
    readBearerAccessToken,
    authenticate: async (accessToken, context) =>
      await authenticateWorkspacePrincipal(accessToken, undefined, context),
    requireTeamPermission: async (principal, teamId, minimum) => {
      if (principal.workspaceRole === 'guest') {
        throw new ProjectDataError(403, 'ProjectAccessDenied', 'Guests cannot access workload planning.')
      }
      const context = await requireTeamPermission(principal, teamId, minimum)
      const isPrivileged = principal.isSystemAdmin || principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin'
      return {
        ...(isPrivileged ? {} : {
          visibleProjectIds: new Set(
            (context.projectAccesses ?? [])
              .filter((access) => projectAccessAllows(access, 'viewer'))
              .map((access) => access.projectId),
          ),
        }),
        teamProjectIds: context.team.projects.map((project) => project.id),
        canViewConfidential: isPrivileged || (context.projectAccesses ?? []).some((access) => projectAccessAllows(access, 'manager')),
      }
    },
    getWorkloadVisibility: async (principal, _teamId, permission) => {
      if (permission.visibleProjectIds === undefined) {
        return { canViewConfidential: permission.canViewConfidential ?? false }
      }
      const visibleMemberIds = await readWorkloadProjectMemberIds(
        principal,
        [...permission.visibleProjectIds],
      )
      visibleMemberIds.add(principal.userKey)
      return {
        visibleMemberIds,
        visibleProjectIds: permission.visibleProjectIds,
        canViewConfidential: permission.canViewConfidential ?? false,
      }
    },
    verifyMember: async (principal, _teamId, memberId, permission) => {
      const projectIds = permission.visibleProjectIds === undefined
        ? permission.teamProjectIds ?? []
        : [...permission.visibleProjectIds]
      const visibleMemberIds = await readWorkloadProjectMemberIds(principal, projectIds)
      if (!visibleMemberIds.has(memberId)) {
        throw new ProjectDataError(
          403,
          'ProjectAccessDenied',
          `User "${principal.userKey}" cannot manage workload member "${memberId}".`,
        )
      }
    },
    canManageMember: async (principal, teamId, memberId) => {
      if (principal.isSystemAdmin || principal.workspaceRole === 'owner' || principal.workspaceRole === 'admin') return true
      if (principal.userKey === memberId) return true
      try {
        await requireTeamPermission(principal, teamId, 'manager')
        return true
      } catch (error) {
        if (error instanceof ProjectDataError && error.status === 403) return false
        throw error
      }
    },
    verifyProject: async (principal, teamId, projectId, minimum) => {
      const context = await requireTeamPermission(principal, teamId, minimum)
      if (
        !principal.isSystemAdmin &&
        principal.workspaceRole !== 'owner' &&
        principal.workspaceRole !== 'admin' &&
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
    verifyWorkItem: async (principal, teamId, workItemId, minimum) =>
      (await loadAuthorizedTeamIssue(principal, teamId, workItemId, minimum)).detail.issue.assignedProjectId ?? undefined,
    getCapacityPlanning: () => capacityPlanningDependencies.capacityPlanningService,
    readJson,
    mapError: toCapacityPlanningErrorResponse,
  }))
}
