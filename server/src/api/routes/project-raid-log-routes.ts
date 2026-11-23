import { createHash } from 'node:crypto'
import type { ProjectRaidLogResponse } from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  createProjectRaidEntryUseCase,
  readProjectRaidLogUseCase,
  updateProjectRaidEntryUseCase,
} from '../../modules/project-raid-log'
import { workItemDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  createApiMutationContext,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  canWriteTeamProject,
  createTeamProjectCallerAuthorization,
  requireTeamProjectRead,
} from '../shared/team-project-access'

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
      await requireTeamProjectRead(principal, teamId, projectId)
      const log = await readProjectRaidLogUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
      )
      return c.json({
        ...log,
        viewer: { canEdit: await canWriteTeamProject(principal, teamId, projectId) },
      } satisfies ProjectRaidLogResponse)
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
      await requireTeamProjectRead(principal, teamId, projectId)
      if (!await canWriteTeamProject(principal, teamId, projectId)) {
        throw new ProjectDataError(403, 'ProjectRaidLogForbidden', 'Only a Project member can change the Project log.')
      }
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await createProjectRaidEntryUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createTeamProjectCallerAuthorization(principal, teamId, projectId, 'ProjectRaidLogAuthorizationUnavailable'),
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
      await requireTeamProjectRead(principal, teamId, projectId)
      if (!await canWriteTeamProject(principal, teamId, projectId)) {
        throw new ProjectDataError(403, 'ProjectRaidLogForbidden', 'Only a Project member can change the Project log.')
      }
      const body = await readJson<unknown>(c.req)
      const auditContext = createApiMutationContext(c, principal, body)
      const response = await updateProjectRaidEntryUseCase(
        workItemDependencies.projectRaidLogs,
        { workspaceId: principal.directoryId, teamId, projectId },
        entryId,
        body,
        {
          now: new Date().toISOString(),
          callerAuthorization: await createTeamProjectCallerAuthorization(principal, teamId, projectId, 'ProjectRaidLogAuthorizationUnavailable'),
          auditContext,
          updateReceipt: createUpdateReceipt(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash, auditContext.requestFingerprint),
          updateKey: createUpdateKey(entryId, auditContext.actor.id, auditContext.idempotencyKeyHash),
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
 * Derives the receipt of an update request, so a retry of the same request with the same
 * Idempotency-Key is recognized after its first attempt committed.
 *
 * @param entryId - Entry being updated.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @param requestFingerprint - Fingerprint of the request method, path, and body.
 * @returns A hexadecimal receipt.
 */
function createUpdateReceipt(entryId: string, actorId: string, idempotencyKeyHash: string, requestFingerprint: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-raid-entry-update', entryId, actorId, idempotencyKeyHash, requestFingerprint]))
    .digest('hex')
}

/**
 * Derives the key of an update request without its content, so the same Idempotency-Key sent
 * again with other content is told apart from a retry.
 *
 * @param entryId - Entry being updated.
 * @param actorId - Requesting actor.
 * @param idempotencyKeyHash - Hash of the request's idempotency key.
 * @returns A hexadecimal key.
 */
function createUpdateKey(entryId: string, actorId: string, idempotencyKeyHash: string) {
  return createHash('sha256')
    .update(JSON.stringify(['project-raid-entry-update-key', entryId, actorId, idempotencyKeyHash]))
    .digest('hex')
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
    if (status >= 500) {
      // Request headers tie the failure to the request log; the body is not recorded.
      console.error('Project log request failed.', {
        status,
        code: error.code,
        requestId: c.req.header('X-Request-Id'),
        correlationId: c.req.header('X-Correlation-Id')?.trim(),
        error,
      })
    }
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
