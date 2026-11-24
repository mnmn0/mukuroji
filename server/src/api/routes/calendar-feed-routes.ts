import { parseIssueCalendarFeedRequest } from '@mukuroji/contracts'
import type { Context, Hono } from 'hono'
import {
  CalendarFeedError,
  issueCalendarFeedUseCase,
  listCalendarFeedsUseCase,
  readCalendarFeedUseCase,
  revokeCalendarFeedUseCase,
  type CalendarFeedErrorCategory,
} from '../../modules/calendar-feeds'
import { workItemDependencies } from '../shared/app-dependencies'
import {
  CALENDAR_FEED_RATE_WINDOW_SECONDS,
  canReadCalendarFeedProject,
  createCalendarFeedIssueReceipts,
  createCalendarFeedReader,
} from '../shared/calendar-feed-ports'
import { readBearerAccessToken, readJson } from '../shared/http'
import {
  createApiMutationContext,
  toProjectDataErrorResponse,
  type WorkspacePrincipal,
} from '../shared/project-access'
import { authenticateWorkspacePrincipal } from '../shared/request-authorization'

/** Seconds a calendar client or shared cache may reuse a feed response. */
const CALENDAR_FEED_CACHE_SECONDS = 300

/** HTTP status of each calendar feed error category. */
const CATEGORY_STATUS = {
  'invalid-input': 400,
  'not-found': 404,
  conflict: 409,
  'limit-exceeded': 413,
  unavailable: 503,
} as const satisfies Record<CalendarFeedErrorCategory, number>

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
      const idempotencyKey = c.req.header('Idempotency-Key')?.trim()
      const response = await issueCalendarFeedUseCase(workItemDependencies.calendarFeeds, owner, request, {
        now: new Date().toISOString(),
        auditContext: createApiMutationContext(c, principal, body),
        canReadProject: (candidate, teamId, projectId) => canReadCalendarFeedProject(c, candidate, teamId, projectId),
        ...(idempotencyKey ? { idempotency: { receipts: createCalendarFeedIssueReceipts(), key: idempotencyKey } } : {}),
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
      if (!feedId) throw new CalendarFeedError('invalid-input', 'InvalidCalendarFeed', 'Feed ID is required.')
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
      const result = await readCalendarFeedUseCase(
        workItemDependencies.calendarFeeds,
        createCalendarFeedReader(c),
        c.req.param('token'),
        new Date(),
      )
      if (result.kind === 'not-found') return feedNotFound(c)
      if (result.kind === 'rate-limited') {
        c.header('Retry-After', String(result.retryAfterSeconds ?? CALENDAR_FEED_RATE_WINDOW_SECONDS))
        c.header('Cache-Control', 'no-store')
        return c.text('Too Many Requests', 429)
      }
      c.header('Cache-Control', `private, max-age=${CALENDAR_FEED_CACHE_SECONDS}`)
      c.header('Content-Disposition', 'inline; filename="mukuroji.ics"')
      return c.body(result.body, 200, { 'Content-Type': 'text/calendar; charset=utf-8' })
    } catch (error) {
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
 * @throws CalendarFeedError `invalid-input` when the body is invalid.
 */
function parseRequest(body: unknown) {
  try {
    return parseIssueCalendarFeedRequest(body)
  } catch (error) {
    if (error instanceof TypeError) throw new CalendarFeedError('invalid-input', 'InvalidCalendarFeed', error.message)
    throw error
  }
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
    const status = CATEGORY_STATUS[error.category]
    if (status >= 500) {
      console.error('Calendar feed request failed.', {
        requestId: c.req.header('X-Request-Id'),
        code: error.code,
        error,
      })
    }
    return c.json({ code: error.code, message: error.message }, status)
  }
  return toProjectDataErrorResponse(c, error)
}
