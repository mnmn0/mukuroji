import type { Context, Hono } from 'hono'
import {
  createProjectScheduleBaselineEntry,
  PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES,
  type ProjectScheduleBaselineResponse,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import type { TeamIssueResponseItem } from '../../modules/work-items'
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
import { filterAccessibleTeamIssues } from '../shared/work-item-access'
import type { TeamPermissionContext } from '../shared/workspace-access'

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
      requireProjectAccess(principal, context, projectId, 'viewer')
      const baseline = await workItemDependencies.scheduleBaselines.get(principal.directoryId, teamId, projectId)
      if (!baseline) {
        return c.json({ teamId, projectId, baseline: null } satisfies ProjectScheduleBaselineResponse)
      }
      const readableIds = new Set(
        filterAccessibleTeamIssues(await readTeamWorkItems(principal.directoryId, teamId), principal, context)
          .map((issue) => issue.id),
      )
      return c.json({
        teamId,
        projectId,
        baseline: {
          ...baseline,
          entries: baseline.entries.filter((entry) => readableIds.has(entry.workItemId)),
        },
      } satisfies ProjectScheduleBaselineResponse)
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
      requireProjectAccess(principal, context, projectId, 'manager')
      const workItems = (await readTeamWorkItems(principal.directoryId, teamId))
        .filter((issue) => issue.assignedProjectId === projectId)
      const baseline = await workItemDependencies.scheduleBaselines.capture({
        workspaceId: principal.directoryId,
        teamId,
        projectId,
        entries: workItems.map((issue) => createProjectScheduleBaselineEntry(issue.id, issue.schedule)),
        capturedAt: new Date().toISOString(),
        callerAuthorization: createPlanningCallerAuthorizationConditionChecks(
          principal,
          [],
          principal.principalKind !== 'service-account',
        ),
      })
      return c.json({ teamId, projectId, baseline } satisfies ProjectScheduleBaselineResponse, 201)
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
 * Requires the Project to belong to the Team and the principal to hold a role on it.
 *
 * A Project outside the Team and a Project the principal may not use both answer 404, so the
 * response does not reveal which Projects exist.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context.
 * @param projectId - Project ID.
 * @param minimumRole - Role the action needs.
 */
function requireProjectAccess(
  principal: Parameters<typeof canAccessAssignedProject>[0],
  context: TeamPermissionContext,
  projectId: string,
  minimumRole: 'viewer' | 'manager',
) {
  const inTeam = context.team.projects.some((project) => project.id === projectId)
  if (!inTeam || !canAccessAssignedProject(principal, context, projectId, 'viewer')) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }
  if (minimumRole === 'manager' && !canAccessAssignedProject(principal, context, projectId, 'manager')) {
    throw new ProjectDataError(403, 'ScheduleBaselineForbidden', 'Only a Project manager can capture a schedule baseline.')
  }
}

/**
 * Reads every non-archived Work Item of a Team, refusing a Team too large for one baseline.
 *
 * @param directoryId - Workspace directory ID.
 * @param teamId - Team ID.
 * @returns The Team's Work Items.
 */
async function readTeamWorkItems(directoryId: string, teamId: string): Promise<TeamIssueResponseItem[]> {
  const { teamIssues } = workItemDependencies
  if (!teamIssues.getTeamHierarchyEntries) {
    throw new ProjectDataError(503, 'ScheduleBaselineUnavailable', 'Work Items cannot be read for the schedule baseline.')
  }
  const entries = await teamIssues.getTeamHierarchyEntries(directoryId, teamId, PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES)
  if (entries.length > PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES) {
    throw new ProjectDataError(
      413,
      'WorkItemListLimitExceeded',
      `This Team has more than ${PROJECT_SCHEDULE_BASELINE_MAX_ENTRIES} Work Items, so its schedule baseline cannot be read at once.`,
    )
  }
  return entries.map((entry) => entry.issue)
}
