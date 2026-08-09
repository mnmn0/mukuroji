import { TeamIssuesApiError } from './errors'
import {
  createTeamIssuePath,
  readApiError,
  readJson,
  trimTrailingSlash,
} from './http'

/**
 * チーム所有 Issue の活動種別です。
 */
export type TeamIssueActivityType = 'created' | 'updated' | 'commented'

/**
 * チーム所有 Issue の活動履歴です。
 */
export type TeamIssueActivity = {
  /**
   * 活動履歴 ID です。
   */
  id: string
  /**
   * 活動種別です。
   */
  type: TeamIssueActivityType
  /**
   * 活動したユーザー ID です。
   */
  actorUserId: string
  /**
   * 活動概要です。
   */
  summary: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
}

/**
 * append-only audit 基盤から取得する Work Item activity です。
 */
export type TeamIssueActivityEvent = {
  /**
   * audit event ID です。
   */
  eventId: string
  /**
   * `comment.edited` などの event type です。
   */
  eventType: string
  /**
   * event 発生日時の ISO 8601 timestamp です。
   */
  occurredAt: string
  /**
   * event を発生させた Workspace member key です。
   */
  actorUserId: string
  /**
   * 既知でない event の fallback 表示に使う概要です。
   */
  summary?: string
  /**
   * UI 表示に許可された event metadata です。
   */
  metadata?: Record<string, unknown>
}

/**
 * Work Item activity API の cursor page です。
 */
export type TeamIssueActivityPage = {
  /**
   * activity event 一覧です。
   */
  events: TeamIssueActivityEvent[]
  /**
   * 次 page の opaque cursor です。
   */
  nextCursor?: string
}

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * Loads one cursor page of Work Item activity from the append-only audit log.
 *
 * @param teamId - Team that owns the Work Item.
 * @param issueId - Work Item identifier.
 * @param accessToken - Access token for the Issues API.
 * @param options - Opaque cursor and page-size options.
 * @returns A runtime-validated activity page.
 */
export async function getTeamIssueActivity(
  teamId: string,
  issueId: string,
  accessToken: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<TeamIssueActivityPage> {
  const query = new URLSearchParams()

  if (options.limit !== undefined) {
    query.set('limit', String(options.limit))
  }

  if (options.cursor) {
    query.set('cursor', options.cursor)
  }

  const queryString = query.toString()

  const data = await requestJson<unknown>(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/activity${queryString ? `?${queryString}` : ''}`,
    accessToken,
  )

  if (!isTeamIssueActivityPage(data)) {
    throw new TeamIssuesApiError(
      502,
      'The issue activity response was invalid.',
      'InvalidIssueActivityResponse',
    )
  }

  return data
}

/**
 * Validates a cursor page of Work Item activity at the API boundary.
 *
 * @param value - Untrusted decoded JSON.
 * @returns Whether the value is a complete activity page.
 */
function isTeamIssueActivityPage(
  value: unknown,
): value is TeamIssueActivityPage {
  return (
    isRecord(value) &&
    Array.isArray(value.events) &&
    value.events.every(isTeamIssueActivityEvent) &&
    (value.nextCursor === undefined || typeof value.nextCursor === 'string')
  )
}

/**
 * Validates one Work Item activity event.
 *
 * @param value - Untrusted activity event candidate.
 * @returns Whether the value contains the complete activity event shape.
 */
function isTeamIssueActivityEvent(
  value: unknown,
): value is TeamIssueActivityEvent {
  return (
    isRecord(value) &&
    typeof value.eventId === 'string' &&
    typeof value.eventType === 'string' &&
    typeof value.occurredAt === 'string' &&
    typeof value.actorUserId === 'string' &&
    (value.summary === undefined || typeof value.summary === 'string') &&
    (value.metadata === undefined || isRecord(value.metadata))
  )
}

/**
 * Narrows an unknown JSON value to a non-array object.
 *
 * @param value - Untrusted decoded JSON.
 * @returns Whether the value is a JSON object candidate.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function requestJson<TResponse>(
  url: string,
  accessToken?: string,
  init: RequestInit = {},
) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(accessToken
        ? {
            Authorization: `Bearer ${accessToken}`,
          }
        : {}),
      ...init.headers,
    },
  })
  const data = await readJson<unknown>(response)

  if (!response.ok) {
    const error = readApiError(data)

    throw new TeamIssuesApiError(response.status, error.message, error.code)
  }

  return data as TResponse
}
