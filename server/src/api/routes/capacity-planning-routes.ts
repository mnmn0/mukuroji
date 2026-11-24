import type { Hono } from 'hono'
import type { Context } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { ProjectDataError } from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import {
  createCapacityPlanningRouter,
  type CapacityPlanningTeamPermission,
} from '../../modules/capacity-planning/adapter-in/http/capacity-planning-router'
import { CapacityPlanningError } from '../../modules/capacity-planning'
import { requireAppDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import { readWorkspaceCalendarSettingsOf, readWorkspaceWorkloadCalendarPolicy } from '../shared/workspace-calendar'
import {
  listPermittedTeams,
  requireTeamPermission,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { loadAuthorizedTeamIssue } from '../shared/work-item-access'
import {
  projectAccessAllows,
  toWorkspaceAccessErrorResponse,
  type TeamPermissionContext,
} from '../shared/workspace-access'

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

/**
 * Rejects Workspace guests, who have no workload access.
 *
 * @param principal - Authenticated Workspace principal.
 * @throws ProjectDataError for a guest.
 */
function requireWorkloadAccess(principal: WorkspacePrincipal): void {
  if (principal.workspaceRole === 'guest') {
    throw new ProjectDataError(403, 'ProjectAccessDenied', 'Guests cannot access workload planning.')
  }
}

/**
 * Converts a checked Team permission into the workload visibility inputs.
 *
 * System administrators and Workspace owners / admins see every Project and confidential record;
 * other principals see the Projects they can view, and confidential records only when they
 * manage a Project of the Team.
 *
 * @param principal - Authenticated Workspace principal.
 * @param context - Team permission context returned by the Team check.
 * @returns The workload Team permission.
 */
function toWorkloadTeamPermission(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
): CapacityPlanningTeamPermission {
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
    // Profiles that inherit the Workspace calendar follow every Workspace day off, uncapped.
    readWorkspaceCalendar: async (principal) =>
      await readWorkspaceWorkloadCalendarPolicy(principal.directoryId),
    // Weekly buckets begin on the Workspace week start day.
    readWeekStartDay: async (principal) =>
      (await readWorkspaceCalendarSettingsOf(principal.directoryId)).weekStartDay,
    requireTeamPermission: async (principal, teamId, minimum) => {
      requireWorkloadAccess(principal)
      return toWorkloadTeamPermission(principal, await requireTeamPermission(principal, teamId, minimum))
    },
    // The directory lists only Teams that are not archived.
    listActiveTeamIds: async (principal) => new Set(
      (await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')).teams
        .map((team) => team.id),
    ),
    listWorkloadTeams: async (principal) => {
      requireWorkloadAccess(principal)
      return (await listPermittedTeams(principal, 'viewer')).map((context) => ({
        teamId: context.team.id,
        name: context.team.name,
        permission: toWorkloadTeamPermission(principal, context),
      }))
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
