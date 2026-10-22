import type { Context, Hono } from 'hono'
import { CognitoServiceError } from '../../modules/authentication'
import { AgentRunError, readAgentRunId } from '../../modules/agent-runs'
import { ProjectDataError } from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { createRequestMutationContext, readBearerAccessToken, readJson } from '../shared/http'
import { toProjectDataErrorResponse } from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { toWorkspaceAccessErrorResponse } from '../shared/workspace-access'
import {
  getWebAgentSettings,
  listWebWorkItemAgentRuns,
  releaseWebAgentRun,
  updateWebAgentSettings,
} from './web-agent-run-service'

/** Default number of runs in a Work Item history page. */
const defaultHistoryPageSize = 20

/**
 * Converts Agent Run route failures to safe API responses.
 *
 * @param c - Request context.
 * @param error - Thrown value.
 * @returns Error response.
 */
function toAgentRunErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof CognitoServiceError) return toCognitoDirectoryErrorResponse(c, error)
  if (error instanceof WorkspaceAccessError) return toWorkspaceAccessErrorResponse(c, error)
  if (error instanceof ProjectDataError || isTeamIssueNotFoundError(error)) return toProjectDataErrorResponse(c, error)
  if (!(error instanceof AgentRunError)) {
    console.error(error)
    return c.json({ code: 'AgentRunsUnavailable', message: 'Agent Runs are unavailable.' }, 502)
  }
  if (error.status >= 500) console.error(error)
  const status = error.status === 400 || error.status === 403 || error.status === 404 ||
    error.status === 409 || error.status === 429 || error.status === 503
    ? error.status
    : 502
  return c.json({ code: error.reason ?? error.category, message: error.message }, status)
}

/**
 * Reads an optional history page size.
 *
 * @param value - Raw query value.
 * @returns Page size.
 */
function readHistoryLimit(value: string | undefined): number {
  if (value === undefined) return defaultHistoryPageSize
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AgentRunError('validation_failed', 'limit must be an integer from 1 to 100.', { pointer: '/limit' })
  }
  return limit
}

/**
 * Registers the Web application's Agent Run routes.
 *
 * @param routeApp - Hono application that receives the routes.
 */
export function registerAgentRunRoutes(routeApp: Hono): void {
  routeApp.get('/api/teams/:teamId/work-items/:workItemId/agent-runs', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await listWebWorkItemAgentRuns(
        principal,
        c.req.param('teamId'),
        c.req.param('workItemId'),
        readHistoryLimit(c.req.query('limit')),
      ))
    } catch (error) {
      return toAgentRunErrorResponse(c, error)
    }
  })

  routeApp.post('/api/teams/:teamId/agent-runs/:runId/release', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const runId = readAgentRunId(c.req.param('runId'), '/runId')
      return c.json(await releaseWebAgentRun(
        principal,
        c.req.param('teamId'),
        runId,
        createRequestMutationContext(c, principal.directoryId, principal.actorId, principal.userKey, { runId }),
      ))
    } catch (error) {
      return toAgentRunErrorResponse(c, error)
    }
  })

  routeApp.get('/api/teams/:teamId/agent-settings', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await getWebAgentSettings(principal, c.req.param('teamId')))
    } catch (error) {
      return toAgentRunErrorResponse(c, error)
    }
  })

  routeApp.put('/api/teams/:teamId/agent-settings', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const body = await readJson(c.req)
      return c.json(await updateWebAgentSettings(
        principal,
        c.req.param('teamId'),
        body,
        createRequestMutationContext(c, principal.directoryId, principal.actorId, principal.userKey, body),
      ))
    } catch (error) {
      return toAgentRunErrorResponse(c, error)
    }
  })
}
