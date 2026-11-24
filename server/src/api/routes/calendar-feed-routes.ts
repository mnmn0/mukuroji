import {
  DEFAULT_WORKSPACE_TIME_ZONE,
  parseIssueCalendarFeedRequest,
  type PlanningEntity,
} from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import {
  CalendarFeedError,
  calendarFeedName,
  issueCalendarFeedUseCase,
  listCalendarFeedsUseCase,
  renderCalendarFeed,
  resolveCalendarFeedTokenUseCase,
  revokeCalendarFeedUseCase,
  toPlanningFeedEvent,
  toWorkItemFeedEvent,
  type CalendarFeedEvent,
  type CalendarFeedRecord,
} from '../../modules/calendar-feeds'
import { ProjectDataError } from '../../modules/directory'
import type { TeamIssueResponseItem } from '../../modules/work-items'
import { readReadableLivePlanningEntities } from '../shared/analytics-milestones'
import {
  developerPlatformDependencies,
  enforceActiveTenantForRequest,
  workItemDependencies,
  workspaceDependencies,
} from '../shared/app-dependencies'
import { resolveDeveloperCredentialPrincipal } from '../shared/developer-platform-access'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  canAccessAssignedProject,
  createApiMutationContext,
  requireTeamPermission,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'
import {
  readAccessibleWorkItemPage,
  resolveAccessibleWorkItemTeamContexts,
  type WorkItemAggregateFilter,
} from '../shared/work-item-aggregate-read'
import type { TeamPermissionContext } from '../shared/workspace-access'

/** Largest number of Work Item events one feed returns. */
export const CALENDAR_FEED_WORK_ITEM_LIMIT = 1_000

/** Largest number of Milestone and Cycle events one feed returns. */
export const CALENDAR_FEED_PLANNING_LIMIT = 300

/** Largest number of Work Item pages one feed reads, bounding the rows it evaluates. */
const CALENDAR_FEED_WORK_ITEM_PAGE_LIMIT = 10

/** Requests one feed may make within {@link CALENDAR_FEED_RATE_WINDOW_SECONDS}. */
const CALENDAR_FEED_RATE_LIMIT = 30

/** Rate limit window of one feed. */
const CALENDAR_FEED_RATE_WINDOW_SECONDS = 300

/** Seconds a calendar client or shared cache may reuse a feed response. */
const CALENDAR_FEED_CACHE_SECONDS = 300

/** Refresh interval the feed suggests to calendar clients. */
const CALENDAR_FEED_REFRESH_MINUTES = 60

/**
 * Registers the calendar feed routes (#352).
 *
 * `/api/me/calendar-feeds` lists, issues, and revokes the caller's feeds with the usual sign-in.
 * `/api/public/calendar-feeds/:token` serves a feed to calendar clients without a sign-in: the
 * token names the feed, and the feed is evaluated with its owner's current permissions on every
 * read, so a Project the owner can no longer read leaves the feed.
 *
 * @param routeApp - Hono app the routes are added to.
 */
export function registerCalendarFeedRoutes(routeApp: Hono): void {
  /** Lists the caller's feeds without their secrets. */
  routeApp.get('/api/me/calendar-feeds', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      return c.json(await listCalendarFeedsUseCase(workItemDependencies.calendarFeeds, toOwner(principal)))
    } catch (error) {
      return toCalendarFeedErrorResponse(c, error)
    }
  })

  /** Issues the member feed or a Project feed, or replaces its token. */
  routeApp.post('/api/me/calendar-feeds', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      const body = await readJson<unknown>(c.req)
      const request = parseRequest(body)
      const owner = toOwner(principal)
      // The check uses the same rule as the feed read, so a feed is issued only for what it shows.
      const feedPrincipal = await resolveFeedPrincipal(
        owner.workspaceId,
        owner.memberKey,
        request.kind === 'project' ? request : undefined,
      )
      if (request.kind === 'project' && !await readFeedProjectContext(feedPrincipal, request.teamId, request.projectId)) {
        throw new ProjectDataError(404, 'ProjectNotFound', `Project "${request.projectId}" was not found.`)
      }
      const response = await issueCalendarFeedUseCase(workItemDependencies.calendarFeeds, owner, request, {
        now: new Date().toISOString(),
        auditContext: createApiMutationContext(c, principal, body),
      })
      c.header('Cache-Control', 'no-store')
      return c.json(response, 201)
    } catch (error) {
      return toCalendarFeedErrorResponse(c, error)
    }
  })

  /** Revokes one of the caller's feeds. */
  routeApp.delete('/api/me/calendar-feeds/:feedId', async (c) => {
    const accessToken = readBearerAccessToken(c)
    if (!accessToken) return c.json({ message: 'Bearer token is required.' }, 401)
    try {
      const feedId = c.req.param('feedId')?.trim()
      if (!feedId) throw new CalendarFeedError(400, 'InvalidCalendarFeed', 'Feed ID is required.')
      const principal = await authenticateWorkspacePrincipal(accessToken, undefined, c)
      await revokeCalendarFeedUseCase(workItemDependencies.calendarFeeds, toOwner(principal), feedId, {
        now: new Date().toISOString(),
        auditContext: createApiMutationContext(c, principal, { feedId }),
      })
      return c.body(null, 204)
    } catch (error) {
      return toCalendarFeedErrorResponse(c, error)
    }
  })

  /** Serves one feed as iCalendar to a calendar client. */
  routeApp.get('/api/public/calendar-feeds/:token', async (c) => {
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Robots-Tag', 'noindex, nofollow')
    try {
      const resolved = await resolveCalendarFeedTokenUseCase(workItemDependencies.calendarFeeds, c.req.param('token'))
      if (!resolved) return feedNotFound(c)
      const { workspaceId, record } = resolved
      const rateLimit = await developerPlatformDependencies.rateLimits.consumeRateLimit({
        workspaceId,
        credentialId: `calendar-feed:${record.id}`,
        limit: CALENDAR_FEED_RATE_LIMIT,
        windowSeconds: CALENDAR_FEED_RATE_WINDOW_SECONDS,
      })
      if (!rateLimit.allowed) {
        c.header('Retry-After', String(rateLimit.retryAfterSeconds ?? CALENDAR_FEED_RATE_WINDOW_SECONDS))
        c.header('Cache-Control', 'no-store')
        return c.text('Too Many Requests', 429)
      }
      const body = await renderFeed(c, workspaceId, record)
      if (body === undefined) return feedNotFound(c)
      c.header('Cache-Control', `private, max-age=${CALENDAR_FEED_CACHE_SECONDS}`)
      c.header('Content-Disposition', 'inline; filename="mukuroji.ics"')
      return c.body(body, 200, { 'Content-Type': 'text/calendar; charset=utf-8' })
    } catch (error) {
      if (isAccessLoss(error)) return feedNotFound(c)
      console.error('Calendar feed request failed.', {
        requestId: c.req.header('X-Request-Id'),
        error,
      })
      c.header('Cache-Control', 'no-store')
      return c.text('Service Unavailable', 503)
    }
  })
}

/**
 * Builds the feed owner from an authenticated principal.
 *
 * @param principal - Authenticated principal.
 * @returns Workspace and member key.
 */
function toOwner(principal: WorkspacePrincipal) {
  return { workspaceId: principal.directoryId, memberKey: principal.userKey }
}

/**
 * Validates an issue request body.
 *
 * @param body - Parsed JSON body.
 * @returns The request.
 * @throws CalendarFeedError 400 when the body is invalid.
 */
function parseRequest(body: unknown) {
  try {
    return parseIssueCalendarFeedRequest(body)
  } catch (error) {
    if (error instanceof TypeError) throw new CalendarFeedError(400, 'InvalidCalendarFeed', error.message)
    throw error
  }
}

/**
 * Resolves the owner's current Workspace principal, the way a Public API key of the owner is
 * resolved: an inactive or deprovisioned member, or one without `work-items.read` at the
 * Workspace or the Project, is refused.
 *
 * @param workspaceId - Workspace of the feed.
 * @param memberKey - Owner member key.
 * @param project - Team and Project of a Project feed.
 * @returns The owner's principal.
 */
async function resolveFeedPrincipal(
  workspaceId: string,
  memberKey: string,
  project: { teamId: string, projectId: string } | undefined,
): Promise<WorkspacePrincipal> {
  return resolveDeveloperCredentialPrincipal(
    {
      kind: 'api-key',
      workspaceId,
      credentialId: `calendar-feed:${memberKey}`,
      subjectUserId: memberKey,
      scopes: ['work-items:read'],
    },
    project
      ? { permission: 'work-items.read', teamId: project.teamId, projectId: project.projectId, evaluateProjectScopes: true }
      : { permission: 'work-items.read', evaluateProjectScopes: true },
  )
}

/**
 * Returns the Team context of a Project the owner can still read, with the Project name.
 *
 * @param principal - Owner's principal.
 * @param teamId - Team of the Project.
 * @param projectId - Project.
 * @returns The context and name, or `undefined` when the Project is missing or not readable.
 */
async function readFeedProjectContext(
  principal: WorkspacePrincipal,
  teamId: string,
  projectId: string,
): Promise<{ context: TeamPermissionContext, projectName: string } | undefined> {
  let context: TeamPermissionContext
  try {
    context = await requireTeamPermission(principal, teamId, 'viewer')
  } catch (error) {
    if (isAccessLoss(error)) return undefined
    throw error
  }
  const project = context.team.projects.find((candidate) => candidate.id === projectId)
  if (!project || !canAccessAssignedProject(principal, context, projectId, 'viewer')) return undefined
  return { context, projectName: project.name }
}

/**
 * Renders a feed with the owner's current permissions.
 *
 * @param c - Request context, used for the closed-Workspace check.
 * @param workspaceId - Workspace of the feed.
 * @param record - Feed.
 * @returns The iCalendar body, or `undefined` when the owner can no longer read the Project.
 */
async function renderFeed(c: Context, workspaceId: string, record: CalendarFeedRecord): Promise<string | undefined> {
  // A closed Workspace answers like a revoked token.
  await enforceActiveTenantForRequest(workspaceId, c)
  const project = record.kind === 'project' && record.teamId !== undefined && record.projectId !== undefined
    ? { teamId: record.teamId, projectId: record.projectId }
    : undefined
  const principal = await resolveFeedPrincipal(workspaceId, record.memberKey, project)
  const locale = record.locale
  let name: string
  let contexts: TeamPermissionContext[]
  let filter: WorkItemAggregateFilter
  if (project) {
    const readable = await readFeedProjectContext(principal, project.teamId, project.projectId)
    if (!readable) return undefined
    name = calendarFeedName('project', locale, readable.projectName)
    contexts = await resolveAccessibleWorkItemTeamContexts(principal, project)
    filter = { teamId: project.teamId, projectId: project.projectId, openOnly: true }
  } else {
    name = calendarFeedName('member', locale)
    contexts = await resolveAccessibleWorkItemTeamContexts(principal)
    filter = { openOnly: true, involvedMemberKeys: [...new Set([principal.userKey, principal.actorId])] }
  }
  const workItems = await readFeedWorkItems(principal, contexts, filter)
  const entities = await readFeedPlanningEntities(principal, record, workItems)
  const profile = await workspaceDependencies.tenantAdministration.getProfile(workspaceId)
  const events: CalendarFeedEvent[] = [
    ...workItems.flatMap((workItem) => toEvent(toWorkItemFeedEvent(workItem, locale))),
    ...entities.flatMap((entity) => toEvent(toPlanningFeedEvent(entity, locale))),
  ]
  return renderCalendarFeed({
    name,
    timeZone: profile?.calendar?.timeZone ?? DEFAULT_WORKSPACE_TIME_ZONE,
    refreshIntervalMinutes: CALENDAR_FEED_REFRESH_MINUTES,
    generatedAt: new Date(),
    events,
  })
}

/**
 * Wraps an optional event in an array for `flatMap`.
 *
 * @param event - Event, if any.
 * @returns An array of zero or one event.
 */
function toEvent(event: CalendarFeedEvent | undefined): CalendarFeedEvent[] {
  return event ? [event] : []
}

/**
 * Reads the open, scheduled Work Items of a feed, stopping at the event limit or after a fixed
 * number of pages so one feed cannot read the whole Workspace.
 *
 * @param principal - Owner's principal.
 * @param contexts - Readable Team contexts.
 * @param filter - Feed filter.
 * @returns Work Items with a date, at most {@link CALENDAR_FEED_WORK_ITEM_LIMIT}.
 */
async function readFeedWorkItems(
  principal: WorkspacePrincipal,
  contexts: readonly TeamPermissionContext[],
  filter: WorkItemAggregateFilter,
): Promise<TeamIssueResponseItem[]> {
  const workItems: TeamIssueResponseItem[] = []
  let cursor: string | undefined
  for (let page = 0; page < CALENDAR_FEED_WORK_ITEM_PAGE_LIMIT; page += 1) {
    const result = await readAccessibleWorkItemPage(principal, contexts, {
      limit: CALENDAR_FEED_WORK_ITEM_LIMIT,
      ...(cursor ? { cursor } : {}),
      includeArchived: false,
      filter,
    })
    for (const workItem of result.workItems) {
      if (workItem.schedule.mode === 'unscheduled') continue
      workItems.push(workItem)
      if (workItems.length >= CALENDAR_FEED_WORK_ITEM_LIMIT) return workItems
    }
    cursor = result.nextCursor
    if (!cursor) break
  }
  return workItems
}

/**
 * Selects the Milestones and Cycles of a feed among those the owner can read.
 *
 * A Project feed shows the Project's Milestones and Cycles and its Team's Team-wide Cycles. A
 * member feed shows those of the Projects and Teams of the member's open Work Items, and the
 * Milestones and Cycles the member owns.
 *
 * @param principal - Owner's principal.
 * @param record - Feed.
 * @param workItems - The feed's Work Items.
 * @returns The entities, at most {@link CALENDAR_FEED_PLANNING_LIMIT}.
 */
async function readFeedPlanningEntities(
  principal: WorkspacePrincipal,
  record: CalendarFeedRecord,
  workItems: readonly TeamIssueResponseItem[],
): Promise<PlanningEntity[]> {
  const readable = await readReadableLivePlanningEntities(principal, ['milestone', 'cycle'])
  const projectKeys = new Set<string>()
  const teamIds = new Set<string>()
  if (record.kind === 'project' && record.teamId !== undefined && record.projectId !== undefined) {
    projectKeys.add(JSON.stringify([record.teamId, record.projectId]))
    teamIds.add(record.teamId)
  } else {
    for (const workItem of workItems) {
      teamIds.add(workItem.teamId)
      if (workItem.assignedProjectId) projectKeys.add(JSON.stringify([workItem.teamId, workItem.assignedProjectId]))
    }
  }
  const memberKeys = new Set([principal.userKey, principal.actorId])
  return readable
    .filter((entity) => {
      if (entity.projectId !== undefined) {
        if (entity.teamId !== undefined && projectKeys.has(JSON.stringify([entity.teamId, entity.projectId]))) return true
      } else if (entity.type === 'cycle' && entity.teamId !== undefined && teamIds.has(entity.teamId)) {
        return true
      }
      return record.kind === 'member' && memberKeys.has(entity.ownerMemberKey)
    })
    .sort((left, right) => left.forecast.startDate.localeCompare(right.forecast.startDate) || left.id.localeCompare(right.id))
    .slice(0, CALENDAR_FEED_PLANNING_LIMIT)
}

/**
 * Returns whether an error means the owner, the Workspace, or the Project is no longer available,
 * which the public route answers like an unknown token.
 *
 * @param error - Thrown error.
 * @returns Whether to answer 404.
 */
function isAccessLoss(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error)) return false
  const status = error.status
  return status === 401 || status === 403 || status === 404 || status === 410 || status === 423
}

/**
 * Answers 404 without saying whether the token ever existed.
 *
 * @param c - Request context.
 * @returns The response.
 */
function feedNotFound(c: Context) {
  c.header('Cache-Control', 'no-store')
  return c.text('Not Found', 404)
}

/**
 * Maps a management route error to its response.
 *
 * @param c - Request context.
 * @param error - Thrown error.
 * @returns The response.
 */
function toCalendarFeedErrorResponse(c: Context, error: unknown) {
  if (error instanceof CalendarFeedError) {
    if (error.status >= 500) console.error('Calendar feed request failed.', { code: error.code, error })
    return c.json({ code: error.code, message: error.message }, error.status)
  }
  return toProjectDataErrorResponse(c, error)
}
