import { createHash } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  createProjectRaidEntryUseCase,
  readProjectRaidLogUseCase,
  updateProjectRaidEntryUseCase,
} from '../../modules/project-raid-log'
import { workItemDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson } from '../shared/http'
import { createPlanningCallerAuthorizationConditionChecks } from '../shared/planning-access'
import {
  canAccessAssignedProject,
  createApiMutationContext,
  requireTeamPermission,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import type { TeamPermissionContext } from '../shared/workspace-access'

/**
 * Registers the Project risk, issue, and change request log endpoints.
 *
 * Reading needs viewer access to the Project. Adding, editing, closing, and reopening entries
 * needs member access, the same role that edits the Project's Work Items.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerProjectRaidLogRoutes(routeApp: Hono): void {
  /** Returns every entry of one Project log, newest first. */
  routeApp.get('/api/teams/:teamId/projects/:projectId/raid-log', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      requireProjectAccess(principal, context, projectId, 'viewer')
      return c.json(await readProjectRaidLogUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
      ))
    } catch (error) {
      return toProjectRaidLogErrorResponse(c, error)
    }
  })

  /** Adds one risk, issue, or change request to a Project log. */
  routeApp.post('/api/teams/:teamId/projects/:projectId/raid-log/entries', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      requireProjectAccess(principal, context, projectId, 'member')
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await createProjectRaidEntryUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: createCallerAuthorization(principal),
          auditContext,
          entryId: createEntryId(teamId, projectId, auditContext.actor.id, auditContext.idempotencyKeyHash),
          creationFingerprint: auditContext.requestFingerprint,
        },
      )
      return c.json(response, 201)
    } catch (error) {
      return toProjectRaidLogErrorResponse(c, error)
    }
  })

  /** Replaces one entry; closing and reopening are status changes. */
  routeApp.put('/api/teams/:teamId/projects/:projectId/raid-log/entries/:entryId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const { teamId, projectId } = readLogRoute(c)
      const entryId = c.req.param('entryId')?.trim()
      if (!entryId) throw new ProjectDataError(400, 'InvalidProjectRaidEntry', 'Entry ID is required.')
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const context = await requireTeamPermission(principal, teamId, 'viewer')
      requireProjectAccess(principal, context, projectId, 'member')
      const body = await readJson<unknown>(c.req)
      const response = await updateProjectRaidEntryUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        entryId,
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: createCallerAuthorization(principal),
          auditContext: createApiMutationContext(c, principal, body),
        },
      )
      return c.json(response)
    } catch (error) {
      return toProjectRaidLogErrorResponse(c, error)
    }
  })
}

/**
 * Reads and trims the Team and Project identifiers of a log route.
 *
 * @param c - Hono request context.
 * @returns The route identifiers.
 * @throws ProjectDataError when either identifier is missing.
 */
function readLogRoute(c: Context) {
  const teamId = c.req.param('teamId')?.trim()
  const projectId = c.req.param('projectId')?.trim()
  if (!teamId || !projectId) {
    throw new ProjectDataError(400, 'InvalidProjectRaidEntry', 'Team ID and Project ID are required.')
  }
  return { teamId, projectId }
}

/**
 * Requires the Project to belong to the Team and the principal to hold a role on it.
 *
 * A Project outside the Team and a Project the principal may not see both answer 404, so the
 * response does not reveal which Projects exist.
 *
 * @param principal - Authenticated principal.
 * @param context - Team permission context.
 * @param projectId - Project ID.
 * @param minimumRole - Role the action needs.
 */
function requireProjectAccess(
  principal: WorkspacePrincipal,
  context: TeamPermissionContext,
  projectId: string,
  minimumRole: 'viewer' | 'member',
) {
  const inTeam = context.team.projects.some((project) => project.id === projectId)
  if (!inTeam || !canAccessAssignedProject(principal, context, projectId, 'viewer')) {
    throw new ProjectDataError(404, 'ProjectNotFound', `Project "${projectId}" was not found.`)
  }
  if (minimumRole === 'member' && !canAccessAssignedProject(principal, context, projectId, 'member')) {
    throw new ProjectDataError(403, 'ProjectRaidLogForbidden', 'Only a Project member can change the Project log.')
  }
}

/**
 * Builds the commit-time fences that fail a log write when the caller lost access.
 *
 * @param principal - Authenticated principal.
 * @returns The condition checks.
 */
function createCallerAuthorization(principal: WorkspacePrincipal) {
  return createPlanningCallerAuthorizationConditionChecks(
    principal,
    [],
    principal.principalKind !== 'service-account',
  )
}

/**
 * Derives the ID of a new entry from the request's idempotency key, so a retried request finds
 * the entry it already created instead of adding a second one.
 *
 * @param teamId - Team ID.
 * @param projectId - Project ID.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @returns A 32-character hexadecimal entry ID.
 */
function createEntryId(teamId: string, projectId: string, actorId: string, idempotencyKeyHash: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-raid-entry', teamId, projectId, actorId, idempotencyKeyHash]))
    .digest('hex')
    .slice(0, 32)
}

/**
 * Converts a log failure to an HTTP response.
 *
 * @param c - Hono request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toProjectRaidLogErrorResponse(c: Context, error: unknown) {
  if (
    error instanceof ProjectDataError &&
    (error.code.startsWith('ProjectRaid') || error.code === 'InvalidProjectRaidEntry')
  ) {
    const status = toProjectRaidLogStatus(error.status)
    if (status >= 500) console.error(error)
    return c.json({ code: error.code, message: error.message }, status)
  }
  return toProjectDataErrorResponse(c, error)
}

/**
 * Narrows a Project log error status to the statuses the endpoints answer with.
 *
 * @param status - Status carried by the error.
 * @returns The same status when it is expected, otherwise 502.
 */
function toProjectRaidLogStatus(status: number): 400 | 403 | 404 | 409 | 413 | 502 | 503 {
  switch (status) {
    case 400:
    case 403:
    case 404:
    case 409:
    case 413:
    case 503:
      return status
    default:
      return 502
  }
}
