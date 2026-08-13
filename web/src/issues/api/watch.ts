import { createMutationHeaders, type MutationRequestContext } from '../../shared/api/mutationHeaders'
import { TeamIssuesApiError } from './errors'
import {
  createTeamIssuePath,
  readApiError,
  readJson,
  trimTrailingSlash,
} from './http'

/**
 * Work Item の watcher 状態です。
 */
export type TeamIssueWatchState = {
  /**
   * 現在のユーザーが有効な watcher かどうかです。
   */
  subscribed: boolean
  /**
   * 明示的な subscribe 設定があるかどうかです。
   */
  explicit: boolean
  /**
   * 自動 watch 条件で有効になっているかどうかです。
   */
  automatic: boolean
  /**
   * 自動 watch になった理由です。
   */
  reasons: string[]
  /**
   * Work Item の watcher 数です。
   */
  watcherCount: number
  /**
   * 割り当て先 project を現在のユーザーが watch しているかどうかです。
   */
  projectSubscribed?: boolean
  /**
   * 割り当て先 project の watcher 数です。
   */
  projectWatcherCount?: number
}

/**
 * watcher API が返す response body です。
 */
type TeamIssueWatchResponse = {
  /**
   * 更新後の watcher 状態です。
   */
  watch: TeamIssueWatchState
}

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * Work Item の現在の watcher 状態を取得します。
 */
export async function getTeamIssueWatch(teamId: string, issueId: string, accessToken: string) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/watch`,
    accessToken,
  )

  return response.watch
}

/**
 * 現在のユーザーを Work Item watcher に追加します。
 */
export async function subscribeTeamIssueWatch(
  teamId: string,
  issueId: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/watch`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  )

  return response.watch
}

/**
 * 現在のユーザーを Work Item watcher から外します。
 */
export async function unsubscribeTeamIssueWatch(
  teamId: string,
  issueId: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${createTeamIssuePath(issuesApiBaseUrl, teamId, issueId)}/watch`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )

  return response.watch
}

/**
 * 現在のユーザーに対する Project watcher 状態を取得します。
 */
export async function getProjectWatch(projectId: string, accessToken: string) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/watch`,
    accessToken,
  )

  return response.watch
}

/**
 * 現在のユーザーを Project watcher に追加します。
 */
export async function subscribeProjectWatch(
  projectId: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/watch`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'PUT',
    },
  )

  return response.watch
}

/**
 * 現在のユーザーを Project watcher から外します。
 */
export async function unsubscribeProjectWatch(
  projectId: string,
  accessToken: string,
  mutationContext: MutationRequestContext,
) {
  const response = await requestJson<TeamIssueWatchResponse>(
    `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/watch`,
    accessToken,
    {
      headers: createMutationHeaders(mutationContext),
      method: 'DELETE',
    },
  )

  return response.watch
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
