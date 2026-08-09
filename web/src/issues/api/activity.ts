import { TeamIssuesApiError } from './errors'

/**
 * チーム所有 Issue の活動種別です。
 */
export type TeamIssueActivityType =
  | 'created'
  | 'updated'
  | 'commented'
  | 'triage-context-merged'

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

const defaultIssuesApiErrorMessage = 'Unable to complete the Work Item request.'

/**
 * append-only audit 基盤から Work Item activity を cursor 付きで取得します。
 */
export function getTeamIssueActivity(
  teamId: string,
  issueId: string,
  accessToken: string,
  options: { limit?: number; cursor?: string } = {},
) {
  const query = new URLSearchParams()

  if (options.limit !== undefined) {
    query.set('limit', String(options.limit))
  }

  if (options.cursor) {
    query.set('cursor', options.cursor)
  }

  const queryString = query.toString()

  return requestJson<TeamIssueActivityPage>(
    `${createTeamIssuePath(teamId, issueId)}/activity${queryString ? `?${queryString}` : ''}`,
    accessToken,
  )
}

function createTeamIssuePath(teamId: string, issueId: string) {
  return `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`
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

function readApiError(data: unknown) {
  const message = typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string' &&
    data.message.trim().length > 0
    ? data.message
    : defaultIssuesApiErrorMessage
  const code = typeof data === 'object' &&
    data !== null &&
    'code' in data &&
    typeof data.code === 'string'
    ? data.code
    : undefined

  return { code, message }
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    return {} as T
  }
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
