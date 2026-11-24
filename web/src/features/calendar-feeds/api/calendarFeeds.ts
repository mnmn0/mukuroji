import type {
  CalendarFeed,
  CalendarFeedListResponse,
  IssueCalendarFeedRequest,
  IssueCalendarFeedResponse,
} from '@mukuroji/contracts'
import { resolveApiBaseUrl } from '../../../shared/api/apiBaseUrl'
import { createMutationHeaders, type MutationRequestContext } from '../../../shared/api/mutationHeaders'

/** Base URL of the calendar feed API, shared with the member's own Developer Platform routes. */
const calendarFeedApiBaseUrl = resolveApiBaseUrl('workspaceWithoutProjects')

/** Error of a calendar feed request with its HTTP status. */
export class CalendarFeedsApiError extends Error {
  /** HTTP status of the response, or 0 when the request did not reach the server. */
  readonly status: number

  /**
   * Creates the error.
   *
   * @param status - HTTP status.
   * @param message - Server message, or a generic one.
   */
  constructor(status: number, message: string) {
    super(message)
    this.name = 'CalendarFeedsApiError'
    this.status = status
  }
}

/**
 * Lists the signed-in member's calendar feeds.
 *
 * @param accessToken - Access token of the member.
 * @returns The feeds without their URLs.
 */
export async function listCalendarFeeds(accessToken: string): Promise<CalendarFeedListResponse> {
  const body = await requestJson('/me/calendar-feeds', accessToken)
  if (!isRecord(body) || !Array.isArray(body.feeds)) throw invalidResponse()
  return { feeds: body.feeds.map(parseFeed) }
}

/**
 * Issues a feed, or replaces its URL when it already exists.
 *
 * @param accessToken - Access token of the member.
 * @param input - Feed to issue.
 * @param context - Mutation context shared with retries.
 * @returns The feed and its tokenized path, shown once.
 */
export async function issueCalendarFeed(
  accessToken: string,
  input: IssueCalendarFeedRequest,
  context: MutationRequestContext,
): Promise<IssueCalendarFeedResponse> {
  const body = await requestJson('/me/calendar-feeds', accessToken, {
    method: 'POST',
    body: JSON.stringify(input),
    headers: { 'Content-Type': 'application/json', ...createMutationHeaders(context) },
  })
  if (!isRecord(body) || typeof body.feedPath !== 'string') throw invalidResponse()
  return { feed: parseFeed(body.feed), feedPath: body.feedPath }
}

/**
 * Revokes a feed so that its URL stops working.
 *
 * @param accessToken - Access token of the member.
 * @param feedId - Feed to revoke.
 * @param context - Mutation context shared with retries.
 */
export async function revokeCalendarFeed(
  accessToken: string,
  feedId: string,
  context: MutationRequestContext,
): Promise<void> {
  await requestJson(`/me/calendar-feeds/${encodeURIComponent(feedId)}`, accessToken, {
    method: 'DELETE',
    headers: createMutationHeaders(context),
  })
}

/**
 * Builds the absolute feed URL a calendar client subscribes to.
 *
 * The server returns the path under `/api`; the configured API base URL may live on another
 * origin or under a prefix, so the path is joined to it.
 *
 * @param feedPath - Path returned by the server.
 * @param pageOrigin - Origin of the current page.
 * @param apiBaseUrl - Configured API base URL.
 * @returns The `https` URL of the feed.
 */
export function toCalendarFeedUrl(
  feedPath: string,
  pageOrigin: string,
  apiBaseUrl: string = calendarFeedApiBaseUrl,
): string {
  const relative = feedPath.startsWith('/api/') ? feedPath.slice('/api'.length) : feedPath
  return new URL(`${apiBaseUrl}${relative}`, pageOrigin).toString()
}

/**
 * Builds the `webcal:` URL that opens the feed in the device's calendar app.
 *
 * @param feedUrl - Absolute `https` or `http` feed URL.
 * @returns The same URL with the `webcal:` scheme.
 */
export function toWebcalUrl(feedUrl: string): string {
  return feedUrl.replace(/^https?:/u, 'webcal:')
}

/**
 * Sends an authenticated request and reads its JSON body.
 *
 * @param path - Path under the API base URL.
 * @param accessToken - Access token of the member.
 * @param init - Request options.
 * @returns The parsed body, or `undefined` for an empty response.
 * @throws CalendarFeedsApiError when the request fails.
 */
async function requestJson(path: string, accessToken: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${calendarFeedApiBaseUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...init.headers },
    })
  } catch {
    throw new CalendarFeedsApiError(0, 'Calendar feed request failed.')
  }
  let text: string
  try {
    text = await response.text()
  } catch {
    // The body was lost in transit, so the request may have committed: keep it retryable.
    throw new CalendarFeedsApiError(0, 'Calendar feed response was interrupted.')
  }
  let body: unknown
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    throw new CalendarFeedsApiError(response.status, 'Calendar feed response was malformed.')
  }
  if (!response.ok) {
    throw new CalendarFeedsApiError(
      response.status,
      isRecord(body) && typeof body.message === 'string' ? body.message : 'Calendar feed request failed.',
    )
  }
  return body
}

/**
 * Validates one feed of a response.
 *
 * @param value - Raw feed.
 * @returns The feed.
 * @throws CalendarFeedsApiError when the value is not a feed.
 */
function parseFeed(value: unknown): CalendarFeed {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    (value.kind !== 'member' && value.kind !== 'project') ||
    (value.locale !== 'ja' && value.locale !== 'en') ||
    typeof value.issuedAt !== 'string' ||
    typeof value.createdAt !== 'string'
  ) {
    throw invalidResponse()
  }
  return {
    id: value.id,
    kind: value.kind,
    ...(typeof value.teamId === 'string' ? { teamId: value.teamId } : {}),
    ...(typeof value.projectId === 'string' ? { projectId: value.projectId } : {}),
    locale: value.locale,
    issuedAt: value.issuedAt,
    createdAt: value.createdAt,
  }
}

/**
 * Creates the error for a response that does not match the contract.
 *
 * @returns The error.
 */
function invalidResponse(): CalendarFeedsApiError {
  return new CalendarFeedsApiError(502, 'Calendar feed response was malformed.')
}

/**
 * Returns whether a value is a plain object.
 *
 * @param value - Value to check.
 * @returns Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
