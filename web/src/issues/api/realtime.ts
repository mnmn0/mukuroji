import { TeamIssuesApiError } from './errors'
import {
  readApiError,
  readJson,
  trimTrailingSlash,
} from './http'

/**
 * WebSocket 接続用の短命 ticket です。
 */
export type TeamIssueRealtimeTicket = {
  /**
   * WebSocket authorizer が検証する one-time ticket です。
   */
  ticket: string
  /**
   * 接続先 WebSocket URL です。
   */
  websocketUrl: string
  /**
   * ticket の有効期限です。
   */
  expiresAt: string
}

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * Work Item の realtime channel に接続するための短命 ticket を発行します。
 */
export function createTeamIssueRealtimeTicket(
  teamId: string,
  issueId: string,
  accessToken: string,
) {
  return requestJson<TeamIssueRealtimeTicket>(
    `${issuesApiBaseUrl}/realtime/tickets`,
    accessToken,
    {
      body: JSON.stringify({ teamId, issueId }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    },
  )
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
