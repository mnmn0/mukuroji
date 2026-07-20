import { TeamIssuesApiError } from './errors'

/**
 * Work Item を開いている member の presence です。
 */
export type TeamIssuePresence = {
  /**
   * Workspace member key です。
   */
  memberKey: string
  /**
   * コメントを入力中かどうかです。
   */
  typing: boolean
  /**
   * 最終 heartbeat の ISO 8601 timestamp です。
   */
  lastSeenAt: string
}

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

const defaultIssuesApiErrorMessage = 'Unable to complete the Work Item request.'

/**
 * Work Item の presence heartbeat と typing 状態を更新します。
 */
export function updateTeamIssuePresence(
  teamId: string,
  issueId: string,
  accessToken: string,
  clientId: string,
  typing: boolean,
) {
  return requestJson<Record<string, never>>(
    `${createTeamIssuePath(teamId, issueId)}/presence`,
    accessToken,
    {
      body: JSON.stringify({ clientId, typing }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
    },
  )
}

/**
 * 閉じた browser tab の presence を削除します。
 */
export function deleteTeamIssuePresence(
  teamId: string,
  issueId: string,
  accessToken: string,
  clientId: string,
) {
  return requestJson<Record<string, never>>(
    `${createTeamIssuePath(teamId, issueId)}/presence/${encodeURIComponent(clientId)}`,
    accessToken,
    { method: 'DELETE' },
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
