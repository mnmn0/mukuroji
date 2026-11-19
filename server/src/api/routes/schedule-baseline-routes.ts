import type { Context, Hono } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  captureProjectScheduleBaselineUseCase,
  readProjectScheduleBaselineUseCase,
  type TeamIssueResponseItem,
} from '../../modules/work-items'
import { workItemDependencies } from '../shared/app-dependencies'
import { toWorkItemConfigurationErrorResponse } from '../shared/collaboration-access'
import { readBearerAccessToken } from '../shared/http'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  canAccessAssignedProject,
  requireTeamPermission,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { projectAccessAllows, type TeamPermissionContext } from '../shared/workspace-access'

/**
 * Registers the Project schedule baseline endpoints.
 *
 * Reading needs viewer access to the Project and returns only the entries of Work Items the
 * reader may currently see. Capturing needs manager access to the Project, because a baseline
 * is the approved plan that later slips are measured against.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerScheduleBaselineRoutes(routeApp: Hono): void {
  /** Returns the latest schedule baseline of one Project. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/schedule-baseline', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readBaselineRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      requireProjectAccess(principal, context, teamId, projectId, 'viewer')
      return c.json(await readProjectScheduleBaselineUseCase(
        createBaselineDependencies(principal.directoryId, teamId),
        { workspaceId: principal.directoryId, teamId, projectId },
        (issue) => canAccessTeamProject(principal, context, teamId, issue.assignedProjectId, 'viewer'),
      ))
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })

  /** Captures the current plan of every Work Item in one Project as its new baseline. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/schedule-baseline', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readBaselineRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      requireProjectAccess(principal, context, teamId, projectId, 'manager')
      const response = await captureProjectScheduleBaselineUseCase(
        createBaselineDependencies(principal.directoryId, teamId),
        { workspaceId: principal.directoryId, teamId, projectId },
        {
          capturedAt: new Date().toISOString(),
          callerAuthorization: createPlanningCallerAuthorizationConditionChecks(
            principal,
            [],
            principal.principalKind !== 'service-account',
          ),
        },
      )
      return c.json(response, 201)
    } catch (error) {
      return toWorkItemConfigurationErrorResponse(c, error)
    }
  })
}

/**
 * Reads and trims the Team and Project identifiers of a baseline route.
 *
 * @param c - Hono request context.
 * @returns The route identifiers.
 * @throws ProjectDataError when either identifier is missing.
 */
function readBaselineRoute(c: Context) {
  const teamId = c.req.param('teamId')?.trim()
  const projectId = c.req.param('projectId')?.trim()
  if (!teamId || !projectId) {
    throw new ProjectDataError(400, 'InvalidScheduleBaselineRequest', 'Team ID and Project ID are required.')
  }
  return { teamId, projectId }
}

/**
 * Reports whether the principal holds a role on a Project of this exact Team.
 *
 * Project IDs may repeat across Teams, so a grant counts only when its owner Team is the
 * requested Team, not merely when its Project ID matches.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context.
 * @param teamId - Requested Team.
 * @param projectId - Project ID, or undefined for a Work Item outside any Project.
 * @param minimumRole - Role the action needs.
 * @returns Whether the principal may act on the Project.
 */
function canAccessTeamProject(
  principal: Parameters<typeof canAccessAssignedProject>[0],
  context: TeamPermissionContext,
  teamId: string,
  projectId: string | undefined,
  minimumRole: 'viewer' | 'manager',
) {
  if (principal.isSystemAdmin) return true
  if (projectId === undefined) return canAccessAssignedProject(principal, context, undefined, minimumRole)
  return (context.projectAccesses ?? []).some((access) =>
    access.teamId === teamId && access.projectId === projectId && projectAccessAllows(access, minimumRole))
}

/**
 * Requires the Project to belong to the Team and the principal to hold a role on it there.
 *
 * A Project outside the Team and a Project the principal may not use both answer 404, so the
 * response does not reveal which Projects exist.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context.
 * @param teamId - Requested Team.
 * @param projectId - Project ID.
 * @param minimumRole - Role the action needs.
 */
function requireProjectAccess(
  principal: Parameters<typeof canAccessAssignedProject>[0],
  context: TeamPermissionContext,
  teamId: string,
  projectId: string,
  minimumRole: 'viewer' | 'manager',
) {
  const inTeam = context.team.id === teamId && context.team.projects.some((project) => project.id === projectId)
  if (!inTeam || !canAccessTeamProject(principal, context, teamId, projectId, 'viewer')) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }
  if (minimumRole === 'manager' && !canAccessTeamProject(principal, context, teamId, projectId, 'manager')) {
    throw new ProjectDataError(403, 'ScheduleBaselineForbidden', 'Only a Project manager can capture a schedule baseline.')
  }
}

/**
 * Binds the baseline use case dependencies to one Team.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team ID.
 * @returns The store and the Team Work Item reader.
 */
function createBaselineDependencies(directoryId: string, teamId: string) {
  return {
    store: workItemDependencies.scheduleBaselines,
    /**
     * Reads the Team's non-archived Work Items.
     *
     * @param limit - Most Work Items the use case can use; one more is read.
     * @returns Up to `limit + 1` Work Items.
     */
    async readTeamWorkItems(limit: number): Promise<TeamIssueResponseItem[]> {
      const { teamIssues } = workItemDependencies
      if (!teamIssues.getTeamHierarchyEntries) {
        throw new ProjectDataError(503, 'ScheduleBaselineUnavailable', 'Work Items cannot be read for the schedule baseline.')
      }
      const entries = await teamIssues.getTeamHierarchyEntries(directoryId, teamId, limit)
      return entries.map((entry) => entry.issue)
    },
  }
}
