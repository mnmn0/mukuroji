import {
  isSlackChannelId,
  parseUpdateSlackChannelTargetRequest,
  parseUpdateSlackIngestSettingsRequest,
  type SlackChannelTarget,
} from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import { ProjectDataError } from '../../modules/directory'
import {
  listWorkItemSlackMessages,
  readSlackIngestStatus,
  receiveSlackEvent,
  SlackIngestError,
  updateSlackChannelTarget,
  updateSlackIngestSettings,
  type SlackIngestErrorCategory,
} from '../../modules/slack-ingest'
import { developerPlatformDependencies, workspaceDependencies } from '../shared/app-dependencies'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  canAccessAssignedProject,
  createApiMutationContext,
  requireTeamPermission,
  requireWorkspaceAdministration,
  requireWorkspaceBusinessRead,
  requireWorkspaceBusinessWrite,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import { loadAuthorizedTeamIssue } from '../shared/work-item-access'
import { enforceActiveTenantForWorkspace } from '../shared/workspace-access'

/** HTTP status of each Slack ingest error category. */
const CATEGORY_STATUS = {
  'invalid-input': 400,
  'not-found': 404,
  conflict: 409,
  'not-configured': 503,
  unavailable: 503,
} as const satisfies Record<SlackIngestErrorCategory, number>

/**
 * Registers the Slack channel ingest routes (#828, ADR 0113).
 *
 * `/api/public/slack/events` is Slack's Events API request URL: it needs no sign-in and accepts
 * only requests signed with the Slack app's signing secret. The Workspace routes let an
 * administrator map channels and set the retention, and the Work Item route lists the messages
 * that mention the Work Item's key in channels the caller can read.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerSlackIngestRoutes(routeApp: Hono): void {
  /** Receives one Slack Events API request. */
  routeApp.post('/api/public/slack/events', async (c) => {
    c.header('Cache-Control', 'no-store')
    try {
      const deps = developerPlatformDependencies.slackIngest
      const response = await receiveSlackEvent({
        rawBody: await c.req.text(),
        timestamp: c.req.header('X-Slack-Request-Timestamp'),
        signature: c.req.header('X-Slack-Signature'),
        now: new Date(),
      }, {
        config: deps.config,
        queue: deps.queue,
        assertWorkspaceActive: enforceActiveTenantForWorkspace,
      })
      return c.json(response.body, response.status)
    } catch (error) {
      console.error('Slack event request failed.', {
        requestId: c.req.header('X-Request-Id'),
        error: error instanceof Error ? { name: error.name, message: error.message } : 'unknown',
      })
      // Slack retries a failed delivery, and the worker's writes make a retry harmless.
      return c.json({ code: 'SlackEventUnavailable' }, 503)
    }
  })

  /** Returns the Slack app status, the retention, and the channels the bot has joined. */
  routeApp.get('/api/workspace/slack-ingest', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      requireWorkspaceAdministration(principal)
      c.header('Cache-Control', 'no-store')
      return c.json(await readSlackIngestStatus(principal.directoryId, developerPlatformDependencies.slackIngest))
    } catch (error) {
      return toSlackIngestErrorResponse(c, error)
    }
  })

  /** Changes how long messages are kept. */
  routeApp.put('/api/workspace/slack-ingest/settings', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const body = await readJson<unknown>(c.req)
      const request = parseBody(() => parseUpdateSlackIngestSettingsRequest(body))
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      requireWorkspaceAdministration(principal)
      return c.json(await updateSlackIngestSettings(
        principal.directoryId,
        request,
        developerPlatformDependencies.slackIngest,
        { context: createApiMutationContext(c, principal, request), now: new Date().toISOString() },
      ))
    } catch (error) {
      return toSlackIngestErrorResponse(c, error)
    }
  })

  /** Maps a channel to a Team or Project, or unmaps it. */
  routeApp.put('/api/workspace/slack-ingest/channels/:channelId/target', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const channelId = c.req.param('channelId')
      if (!isSlackChannelId(channelId)) {
        throw new SlackIngestError('invalid-input', 'InvalidSlackChannel', 'The channel ID is invalid.')
      }
      const body = await readJson<unknown>(c.req)
      const request = parseBody(() => parseUpdateSlackChannelTargetRequest(body))
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessWrite(principal)
      requireWorkspaceAdministration(principal)
      if (request.target) await requireTargetExists(principal, request.target)
      return c.json(await updateSlackChannelTarget(
        principal.directoryId,
        channelId,
        request.target,
        developerPlatformDependencies.slackIngest,
        {
          context: createApiMutationContext(c, principal, { channelId, target: request.target }),
          now: new Date().toISOString(),
        },
      ))
    } catch (error) {
      return toSlackIngestErrorResponse(c, error)
    }
  })

  /** Lists the Slack messages that mention a Work Item's key. */
  routeApp.get('/api/teams/:teamId/issues/:issueId/slack-messages', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const teamId = c.req.param('teamId')
      const issueId = c.req.param('issueId')
      if (!teamId || !issueId) {
        throw new SlackIngestError('invalid-input', 'InvalidWorkItem', 'Team ID and Work Item ID are required.')
      }
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      requireWorkspaceBusinessRead(principal)
      const { detail } = await loadAuthorizedTeamIssue(principal, teamId, issueId, 'viewer')
      c.header('Cache-Control', 'no-store')
      const key = detail.issue.key
      if (!key) return c.json({ messages: [], truncated: false })
      return c.json(await listWorkItemSlackMessages(principal.directoryId, key, {
        store: developerPlatformDependencies.slackIngest.store,
        canReadTarget: (target) => canReadTarget(principal, target),
        now: () => new Date(),
      }))
    } catch (error) {
      return toSlackIngestErrorResponse(c, error)
    }
  })
}

/**
 * Runs a contract parser and maps its failure to an input error.
 *
 * @param parse - Parser call.
 * @returns The parsed request.
 * @throws SlackIngestError `invalid-input` when the parser rejects the body.
 */
function parseBody<T>(parse: () => T): T {
  try {
    return parse()
  } catch (error) {
    if (error instanceof TypeError) throw new SlackIngestError('invalid-input', 'InvalidSlackIngestRequest', error.message)
    throw error
  }
}

/**
 * Requires a mapping target to name an existing Team, or a Project of that Team.
 *
 * @param principal - Administrator.
 * @param target - Requested target.
 * @throws SlackIngestError `invalid-input` when the Team or Project does not exist.
 */
async function requireTargetExists(principal: WorkspacePrincipal, target: SlackChannelTarget): Promise<void> {
  const directory = await workspaceDependencies.projectDirectory.getProjectDirectory(principal.directoryId, 'ja')
  const team = directory.teams.find((candidate) => candidate.id === target.teamId)
  const exists = team !== undefined &&
    (target.kind === 'team' || team.projects.some((project) => project.id === target.projectId))
  if (!exists) throw new SlackIngestError('invalid-input', 'SlackChannelTargetNotFound', 'The Team or Project does not exist.')
}

/**
 * Reports whether the caller is at least a viewer of a channel's Team or Project.
 *
 * @param principal - Caller.
 * @param target - Channel target.
 * @returns Whether the caller may read the channel.
 */
async function canReadTarget(principal: WorkspacePrincipal, target: SlackChannelTarget): Promise<boolean> {
  try {
    const context = await requireTeamPermission(principal, target.teamId, 'viewer')
    return target.kind === 'team' || canAccessAssignedProject(principal, context, target.projectId, 'viewer')
  } catch (error) {
    if (error instanceof ProjectDataError && (error.status === 403 || error.status === 404)) return false
    throw error
  }
}

/**
 * Maps a Slack ingest route error to its response.
 *
 * @param c - Request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toSlackIngestErrorResponse(c: Context, error: unknown) {
  if (error instanceof SlackIngestError) {
    const status = CATEGORY_STATUS[error.category]
    if (status >= 500) {
      console.error('Slack ingest request failed.', { requestId: c.req.header('X-Request-Id'), code: error.code })
    }
    return c.json({ code: error.code, message: error.message }, status)
  }
  return toProjectDataErrorResponse(c, error)
}
