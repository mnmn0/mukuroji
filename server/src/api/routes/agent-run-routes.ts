import type { Context, Hono } from 'hono'
import type {
  AgentRunView,
  AgentSettings,
  WorkItemAgentRunsResponse,
} from '@mukuroji/contracts'
import { CognitoServiceError } from '../../modules/authentication'
import {
  AgentRunError,
  createAgentRunNotActiveError,
  finishAgentRun,
  readAgentRunId,
  readUpdateAgentSettingsRequest,
  toAgentRun,
  type StoredAgentRun,
} from '../../modules/agent-runs'
import { createMutationAuditEventPut, getConfiguredAuditTableName } from '../../modules/audit/audit'
import { ProjectDataError } from '../../modules/directory'
import { isTeamIssueNotFoundError } from '../../modules/work-items'
import { WorkspaceAccessError } from '../../modules/workspace-access/workspace-access'
import { createAgentRunAuditPut } from '../shared/agent-run-access'
import { workItemDependencies } from '../shared/app-dependencies'
import { toCognitoDirectoryErrorResponse } from '../shared/enterprise-access'
import { createRequestMutationContext, readBearerAccessToken, readJson } from '../shared/http'
import {
  canWorkspaceBusinessWrite,
  requireAssignedProjectPermission,
  requireTeamPermission,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { loadAuthorizedTeamIssue } from '../shared/work-item-access'
import { toWorkspaceAccessErrorResponse } from '../shared/workspace-access'

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
 * Checks whether the principal manages the Team.
 *
 * @param principal - Authorized principal.
 * @param teamId - Team ID.
 * @returns True for Team managers and system administrators.
 */
async function isTeamManager(principal: WorkspacePrincipal, teamId: string): Promise<boolean> {
  try {
    await requireTeamPermission(principal, teamId, 'manager')
    return true
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
}

/**
 * Checks the write access the release route requires before it applies {@link mayRelease}, so the
 * history never offers a release that the release route would reject.
 *
 * @param principal - Viewer.
 * @param teamId - Team ID.
 * @param assignedProjectId - Project the run's Work Item is assigned to.
 * @returns True when the viewer may write the Work Item.
 */
async function canWriteForRelease(
  principal: WorkspacePrincipal,
  teamId: string,
  assignedProjectId: string | undefined,
): Promise<boolean> {
  if (!canWorkspaceBusinessWrite(principal)) return false
  try {
    const context = await requireTeamPermission(principal, teamId, 'member')
    requireAssignedProjectPermission(principal, context, assignedProjectId, 'member')
    return true
  } catch (error) {
    if (error instanceof ProjectDataError && error.status === 403) return false
    throw error
  }
}

/**
 * Checks whether a member may release a run: a Team manager, the member who started it, or the
 * Work Item's current assignee, who is responsible for the work after a reassignment.
 *
 * @param run - Stored run.
 * @param principal - Viewer.
 * @param manager - Whether the viewer manages the Team.
 * @param workItemAssigneeUserId - Current assignee of the run's Work Item.
 * @returns True when the viewer may release the run.
 */
function mayRelease(run: StoredAgentRun, principal: WorkspacePrincipal, manager: boolean, workItemAssigneeUserId: string): boolean {
  return manager || run.assigneeUserId === principal.userKey || workItemAssigneeUserId === principal.userKey
}

/**
 * Projects a run for the Web application with the actions the viewer may take.
 *
 * @param run - Stored run.
 * @param canRelease - Whether the viewer may release the run while it is active.
 * @param now - Read time.
 * @returns Run view.
 */
function toAgentRunView(run: StoredAgentRun, canRelease: boolean, now: Date): AgentRunView {
  return { ...toAgentRun(run, now), canRelease: run.state === 'active' && canRelease }
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
      const teamId = c.req.param('teamId')
      const workItemId = c.req.param('workItemId')
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, workItemId, 'viewer')
      // The Web shows only the newest runs, so no store cursor, which encodes table keys, leaves the server.
      const page = await workItemDependencies.agentRuns.listWorkItemRuns(
        principal.directoryId,
        teamId,
        workItemId,
        undefined,
        readHistoryLimit(c.req.query('limit')),
      )
      const [manager, writable] = await Promise.all([
        isTeamManager(principal, teamId),
        canWriteForRelease(principal, teamId, detail.issue.assignedProjectId),
      ])
      const now = new Date()
      const response: WorkItemAgentRunsResponse = {
        items: page.runs.map((run) => toAgentRunView(
          run,
          writable && mayRelease(run, principal, manager, detail.issue.assigneeUserId),
          now,
        )),
        hasMore: page.nextCursor !== undefined,
      }
      return c.json(response)
    } catch (error) {
      return toAgentRunErrorResponse(c, error)
    }
  })

  routeApp.post('/api/teams/:teamId/agent-runs/:runId/release', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const teamId = c.req.param('teamId')
      const runId = readAgentRunId(c.req.param('runId'), '/runId')
      const store = workItemDependencies.agentRuns
      const run = await store.getRun(principal.directoryId, teamId, runId)
      if (!run) throw new AgentRunError('not_found', 'Agent Run was not found.')
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, run.workItemId, 'member')
      const manager = await isTeamManager(principal, teamId)
      if (!mayRelease(run, principal, manager, detail.issue.assigneeUserId)) {
        throw new AgentRunError('forbidden', 'Only the Work Item assignee or a Team manager can release an Agent Run.')
      }
      const now = new Date()
      if (run.state !== 'active') {
        if (run.outcome === 'released') return c.json(toAgentRunView(run, true, now))
        throw createAgentRunNotActiveError()
      }
      const released = finishAgentRun(run, 'released', principal.userKey, now)
      const auditPut = createAgentRunAuditPut(
        createRequestMutationContext(c, principal.directoryId, principal.actorId, principal.userKey, { runId }),
        released,
        'released',
        'Agent Run was released by a member.',
      )
      const closeItems = store.createCloseItems(released)
      await store.commit([...closeItems, ...(auditPut ? [auditPut] : [])], closeItems.length)
      return c.json(toAgentRunView(released, true, now))
    } catch (error) {
      return toAgentRunErrorResponse(c, error)
    }
  })

  routeApp.get('/api/teams/:teamId/agent-settings', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const teamId = c.req.param('teamId')
      await requireTeamPermission(principal, teamId, 'viewer')
      const settings: AgentSettings = await workItemDependencies.agentRuns.getSettings(principal.directoryId, teamId)
      return c.json(settings)
    } catch (error) {
      return toAgentRunErrorResponse(c, error)
    }
  })

  routeApp.put('/api/teams/:teamId/agent-settings', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      const teamId = c.req.param('teamId')
      await requireTeamPermission(principal, teamId, 'manager')
      const body = await readJson(c.req)
      const update = readUpdateAgentSettingsRequest(body)
      const store = workItemDependencies.agentRuns
      const before = await store.getSettings(principal.directoryId, teamId)
      const now = new Date()
      const auditPut = createMutationAuditEventPut(
        getConfiguredAuditTableName(),
        createRequestMutationContext(c, principal.directoryId, principal.actorId, principal.userKey, body),
        {
          directoryId: principal.directoryId,
          eventType: 'agent-settings.updated',
          entityType: 'agent-settings',
          entityId: `team/${teamId}/agent-settings`,
          action: 'updated',
          occurredAt: now.toISOString(),
          summary: 'Agent settings were updated.',
          changes: [
            { field: 'leaseMinutes', before: before.leaseMinutes, after: update.leaseMinutes },
            {
              field: 'allowTakeoverAfterLeaseExpiry',
              before: before.allowTakeoverAfterLeaseExpiry,
              after: update.allowTakeoverAfterLeaseExpiry,
            },
          ].filter((change) => change.before !== change.after),
          metadata: { adapter: 'agent-settings', teamId, beforeRevision: update.expectedRevision },
        },
      )
      const saved = await store.saveSettings(
        principal.directoryId,
        teamId,
        update,
        principal.userKey,
        now,
        auditPut ? [auditPut] : [],
      )
      return c.json(saved)
    } catch (error) {
      return toAgentRunErrorResponse(c, error)
    }
  })
}
