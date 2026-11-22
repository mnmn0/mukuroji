import type { Context, Hono } from 'hono'
import {
  isProjectScheduleBaselineId,
  normalizeProjectScheduleBaselineName,
  PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH,
} from '@mukuroji/contracts'
import { ProjectDataError } from '../../modules/directory'
import {
  activateProjectScheduleBaselineUseCase,
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
  createApiMutationContext,
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
 * reader may currently see; `?baselineId=` reads a saved baseline instead of the active one.
 * Capturing and switching the active baseline need manager access to the Project, because the
 * active baseline is the approved plan that later slips are measured against, and every write
 * is recorded in the audit log in the same transaction.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerScheduleBaselineRoutes(routeApp: Hono): void {
  /** Returns the active, or one saved, schedule baseline of one Project with the saved list. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/schedule-baseline', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readBaselineRoute(c)
      const baselineId = readBaselineIdQuery(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      requireProjectAccess(principal, context, teamId, projectId, 'viewer')
      return c.json(await readProjectScheduleBaselineUseCase(
        createBaselineDependencies(principal.directoryId, teamId),
        { workspaceId: principal.directoryId, teamId, projectId },
        (issue) => canAccessTeamProject(principal, context, teamId, issue.assignedProjectId, 'viewer'),
        baselineId,
      ))
    } catch (error) {
      return toScheduleBaselineErrorResponse(c, error)
    }
  })

  /** Captures the current plan of every Work Item in one Project as its new active baseline. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/schedule-baseline', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readBaselineRoute(c)
      const name = readCaptureName(await readJsonBody(c))
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      await requireProjectManager(principal, context, teamId, projectId)
      const response = await captureProjectScheduleBaselineUseCase(
        createBaselineDependencies(principal.directoryId, teamId),
        { workspaceId: principal.directoryId, teamId, projectId },
        {
          capturedAt: new Date().toISOString(),
          ...(name === undefined ? {} : { name }),
          callerAuthorization: createPlanningCallerAuthorizationConditionChecks(
            principal,
            [],
            principal.principalKind !== 'service-account',
          ),
          auditContext: createApiMutationContext(c, principal, {}),
        },
      )
      return c.json(response, 201)
    } catch (error) {
      return toScheduleBaselineErrorResponse(c, error)
    }
  })

  /** Makes a saved baseline the active one of the Project. */
  routeApp.put('/api/teams/:teamId/projects/:projectId/schedule-baseline/active', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readBaselineRoute(c)
      const request = readActivateRequest(await readJsonBody(c))
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      await requireProjectManager(principal, context, teamId, projectId)
      return c.json(await activateProjectScheduleBaselineUseCase(
        createBaselineDependencies(principal.directoryId, teamId),
        { workspaceId: principal.directoryId, teamId, projectId },
        request,
        {
          capturedAt: new Date().toISOString(),
          callerAuthorization: createPlanningCallerAuthorizationConditionChecks(
            principal,
            [],
            principal.principalKind !== 'service-account',
          ),
          auditContext: createApiMutationContext(c, principal, request),
        },
        (issue) => canAccessTeamProject(principal, context, teamId, issue.assignedProjectId, 'viewer'),
      ))
    } catch (error) {
      return toScheduleBaselineErrorResponse(c, error)
    }
  })
}

/** Largest request body the baseline writes accept, in UTF-16 code units. */
const MAX_BASELINE_BODY_LENGTH = 4096

/**
 * Reads an optional JSON request body.
 *
 * @param c - Hono request context.
 * @returns The parsed body, or undefined when the body is empty.
 * @throws ProjectDataError 400 when the body is too large or not JSON.
 */
async function readJsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text()
  if (text.trim().length === 0) return undefined
  if (text.length > MAX_BASELINE_BODY_LENGTH) throw invalidRequest('The request body is too large.')
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed
  } catch {
    throw invalidRequest('The request body must be JSON.')
  }
}

/**
 * Reads the optional name of a capture.
 *
 * @param body - Parsed body, or undefined for none.
 * @returns The trimmed name, or undefined when none was given.
 * @throws ProjectDataError 400 when the body or the name is invalid.
 */
function readCaptureName(body: unknown): string | undefined {
  if (body === undefined) return undefined
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidRequest('The request body must be an object.')
  const name = normalizeProjectScheduleBaselineName(Reflect.get(body, 'name'))
  if (name === null) {
    throw invalidRequest(`The baseline name must be text of at most ${PROJECT_SCHEDULE_BASELINE_NAME_MAX_LENGTH} characters without control characters.`)
  }
  return name
}

/**
 * Reads the body of a switch request.
 *
 * @param body - Parsed body.
 * @returns The baseline ID and the expected active revision.
 * @throws ProjectDataError 400 when either is missing or invalid.
 */
function readActivateRequest(body: unknown): { baselineId: string; expectedRevision: number } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalidRequest('The request body must be an object.')
  const baselineId: unknown = Reflect.get(body, 'baselineId')
  const expectedRevision: unknown = Reflect.get(body, 'expectedRevision')
  if (!isProjectScheduleBaselineId(baselineId)) throw invalidRequest('baselineId is invalid.')
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw invalidRequest('expectedRevision must be a positive integer.')
  }
  return { baselineId, expectedRevision }
}

/**
 * Reads the optional `baselineId` query of a read.
 *
 * @param c - Hono request context.
 * @returns The baseline ID, or undefined for the active baseline.
 * @throws ProjectDataError 400 when the ID is invalid.
 */
function readBaselineIdQuery(c: Context): string | undefined {
  const value = c.req.query('baselineId')
  if (value === undefined) return undefined
  if (!isProjectScheduleBaselineId(value)) throw invalidRequest('baselineId is invalid.')
  return value
}

/**
 * Creates the error for a malformed baseline request.
 *
 * @param message - Explanation.
 * @returns The error.
 */
function invalidRequest(message: string) {
  return new ProjectDataError(400, 'InvalidScheduleBaselineRequest', message)
}

/** HTTP status of each baseline-specific error code. */
const scheduleBaselineErrorStatuses = {
  InvalidScheduleBaselineRequest: 400,
  ScheduleBaselineForbidden: 403,
  ProjectNotFound: 404,
  ScheduleBaselineNotFound: 404,
  ScheduleBaselineConflict: 409,
  ScheduleBaselineTooLarge: 413,
  WorkItemListLimitExceeded: 413,
  ScheduleBaselineCorruptState: 502,
  ScheduleBaselineStorageFailure: 502,
  ScheduleBaselineAuthorizationUnavailable: 503,
  ScheduleBaselineRetryable: 503,
  ScheduleBaselineUnavailable: 503,
} as const satisfies Record<string, 400 | 403 | 404 | 409 | 413 | 502 | 503>

/**
 * Reports whether an error code is one of the baseline-specific codes.
 *
 * @param code - Error code.
 * @returns Whether the code has a baseline status.
 */
function isScheduleBaselineErrorCode(code: string): code is keyof typeof scheduleBaselineErrorStatuses {
  return Object.hasOwn(scheduleBaselineErrorStatuses, code)
}

/**
 * Maps baseline failures to their HTTP status and stable code, and delegates everything else.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The error response.
 */
function toScheduleBaselineErrorResponse(c: Context, error: unknown) {
  if (error instanceof ProjectDataError && isScheduleBaselineErrorCode(error.code)) {
    return c.json({ code: error.code, message: error.message }, scheduleBaselineErrorStatuses[error.code])
  }
  return toWorkItemConfigurationErrorResponse(c, error)
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
  minimumRole: 'viewer',
) {
  const inTeam = context.team.id === teamId && context.team.projects.some((project) => project.id === projectId)
  if (!inTeam || !canAccessTeamProject(principal, context, teamId, projectId, minimumRole)) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }
}

/**
 * Requires the principal to manage the Project in this Team.
 *
 * The route reads the Team context at viewer level, and a direct Team grant then reports every
 * Project role as viewer, which would hide a manager. The roles are read again at manager
 * level before refusing.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context read at viewer level.
 * @param teamId - Requested Team.
 * @param projectId - Project ID.
 */
async function requireProjectManager(
  principal: Parameters<typeof canAccessAssignedProject>[0],
  context: TeamPermissionContext,
  teamId: string,
  projectId: string,
) {
  requireProjectAccess(principal, context, teamId, projectId, 'viewer')
  if (canAccessTeamProject(principal, context, teamId, projectId, 'manager')) return
  const forbidden = new ProjectDataError(
    403,
    'ScheduleBaselineForbidden',
    'Only a Project manager can save or switch a schedule baseline.',
  )
  let managerContext: TeamPermissionContext
  try {
    managerContext = await requireTeamPermission(principal, teamId, 'manager')
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) throw forbidden
    throw error
  }
  if (managerContext.directTeamGrant) return
  if (canAccessTeamProject(principal, managerContext, teamId, projectId, 'manager')) return
  throw forbidden
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
