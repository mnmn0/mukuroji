/**
 * Contracts of the signed iCalendar feeds a member subscribes to from Google Calendar, Outlook,
 * or Apple Calendar (#352).
 *
 * A feed URL carries a secret token. The server keeps only the token's digest, so the URL is
 * shown once when the feed is issued; issuing again replaces the token and stops the old URL.
 */

/** What a feed lists. */
export type CalendarFeedKind = 'member' | 'project'

/** Language of the event titles the feed writes. */
export type CalendarFeedLocale = 'ja' | 'en'

/** Every supported feed kind. */
export const CALENDAR_FEED_KINDS: readonly CalendarFeedKind[] = Object.freeze(['member', 'project'])

/** Largest number of Project feeds one member can hold, besides the member feed. */
export const CALENDAR_FEED_PROJECT_LIMIT = 50

/** Path prefix of the public feed route; the token and `.ics` follow it. */
export const CALENDAR_FEED_PUBLIC_PATH_PREFIX = '/api/public/calendar-feeds/'

/** One feed the caller owns, without its secret. */
export type CalendarFeed = {
  /** Server-assigned feed ID. */
  id: string
  /** `member` lists the caller's Work Items; `project` lists one Project. */
  kind: CalendarFeedKind
  /** Team of the Project, for a Project feed. */
  teamId?: string
  /** Project, for a Project feed. */
  projectId?: string
  /** Language of the event titles. */
  locale: CalendarFeedLocale
  /** ISO 8601 time the current token was issued. */
  issuedAt: string
  /** ISO 8601 time the feed was first issued. */
  createdAt: string
}

/** Response of `GET /api/me/calendar-feeds`. */
export type CalendarFeedListResponse = {
  /** The caller's feeds: the member feed first, then Project feeds by Team and Project. */
  feeds: CalendarFeed[]
}

/** Body of `POST /api/me/calendar-feeds`, which issues a feed or replaces its token. */
export type IssueCalendarFeedRequest =
  | {
      /** The caller's own feed. */
      kind: 'member'
      /** Language of the event titles; Japanese when omitted. */
      locale?: CalendarFeedLocale
    }
  | {
      /** A feed of one Project the caller can read. */
      kind: 'project'
      /** Team of the Project. */
      teamId: string
      /** Project. */
      projectId: string
      /** Language of the event titles; Japanese when omitted. */
      locale?: CalendarFeedLocale
    }

/** Response of `POST /api/me/calendar-feeds`. */
export type IssueCalendarFeedResponse = {
  /** The issued feed. */
  feed: CalendarFeed
  /**
   * Path of the feed with its token, such as `/api/public/calendar-feeds/<token>.ics`. It is
   * returned only here; the client joins it to the API origin.
   */
  feedPath: string
}

/** Largest length of a Team or Project ID in a feed request. */
const CALENDAR_FEED_ID_MAX_LENGTH = 256

/**
 * Validates the body of `POST /api/me/calendar-feeds`.
 *
 * @param value - Parsed JSON body.
 * @returns The normalized request.
 * @throws TypeError when the body is not a valid feed request.
 */
export function parseIssueCalendarFeedRequest(value: unknown): IssueCalendarFeedRequest {
  if (!isRecord(value)) throw new TypeError('Calendar feed request must be an object.')
  const locale = parseLocale(value.locale)
  if (value.kind === 'member') {
    const unknownKey = Object.keys(value).find((key) => key !== 'kind' && key !== 'locale')
    if (unknownKey !== undefined) throw new TypeError(`Calendar feed request has an unknown field: ${unknownKey}.`)
    return { kind: 'member', ...(locale ? { locale } : {}) }
  }
  if (value.kind === 'project') {
    const unknownKey = Object.keys(value).find((key) =>
      key !== 'kind' && key !== 'locale' && key !== 'teamId' && key !== 'projectId'
    )
    if (unknownKey !== undefined) throw new TypeError(`Calendar feed request has an unknown field: ${unknownKey}.`)
    return {
      kind: 'project',
      teamId: parseId(value.teamId, 'teamId'),
      projectId: parseId(value.projectId, 'projectId'),
      ...(locale ? { locale } : {}),
    }
  }
  throw new TypeError('Calendar feed kind must be "member" or "project".')
}

/**
 * Validates an optional feed locale.
 *
 * @param value - Raw value.
 * @returns The locale, or `undefined` when omitted.
 * @throws TypeError when the value is not a supported locale.
 */
function parseLocale(value: unknown): CalendarFeedLocale | undefined {
  if (value === undefined) return undefined
  if (value === 'ja' || value === 'en') return value
  throw new TypeError('Calendar feed locale must be "ja" or "en".')
}

/**
 * Validates a required Team or Project ID.
 *
 * @param value - Raw value.
 * @param name - Field name used in the error message.
 * @returns The trimmed ID.
 * @throws TypeError when the value is not a non-empty bounded string.
 */
function parseId(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new TypeError(`${name} is required.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > CALENDAR_FEED_ID_MAX_LENGTH) {
    throw new TypeError(`${name} must be a non-empty ID of at most ${CALENDAR_FEED_ID_MAX_LENGTH} characters.`)
  }
  return trimmed
}

/**
 * Returns whether a value is a plain JSON object.
 *
 * @param value - Value to check.
 * @returns Whether the value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
