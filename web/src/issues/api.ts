import type { MessageKey } from '../i18n'
import type { TaskPriority, TaskStatus } from '../tasks/api'

/**
 * チーム所有 Issue の活動種別です。
 */
export type TeamIssueActivityType = 'created' | 'updated' | 'commented'

/**
 * チーム所有 Issue の一覧行です。
 */
export type TeamIssue = {
  /**
   * チーム内で Issue を識別する ID です。
   */
  id: string
  /**
   * Issue の所有元チーム ID です。
   */
  teamId: string
  /**
   * Issue が遂行先として割り当てられたプロジェクト ID です。
   */
  assignedProjectId?: string
  /**
   * seed 由来の legacy task タイトルを解決する i18n key です。
   */
  titleKey?: MessageKey
  /**
   * API から取得した literal の Issue タイトルです。
   */
  title?: string
  /**
   * Issue 詳細説明です。
   */
  description?: string
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId: string
  /**
   * Cognito から解決した担当者メールアドレスです。
   */
  assigneeEmail?: string
  /**
   * Cognito から解決した担当者表示名です。
   */
  assigneeName?: string
  /**
   * Issue の状態コードです。
   */
  status: TaskStatus
  /**
   * 期限日として表示する文字列です。
   */
  dueDate: string
  /**
   * 優先度コードです。
   */
  priority: TaskPriority
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
  /**
   * 更新日時の ISO 8601 timestamp です。
   */
  updatedAt: string
}

/**
 * チーム所有 Issue のコメントです。
 */
export type TeamIssueComment = {
  /**
   * コメント ID です。
   */
  id: string
  /**
   * コメントを書いたユーザー ID です。
   */
  actorUserId: string
  /**
   * コメント本文です。
   */
  body: string
  /**
   * 作成日時の ISO 8601 timestamp です。
   */
  createdAt: string
}

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
 * チーム所有 Issue の詳細レスポンスです。
 */
export type TeamIssueDetail = {
  /**
   * Issue 本体です。
   */
  issue: TeamIssue
  /**
   * Issue コメント一覧です。
   */
  comments: TeamIssueComment[]
  /**
   * Issue 活動履歴一覧です。
   */
  activity: TeamIssueActivity[]
}

/**
 * チーム所有 Issue 作成 API へ送信する入力です。
 */
export type CreateTeamIssueInput = {
  /**
   * Issue タイトルです。
   */
  title: string
  /**
   * Issue 詳細説明です。
   */
  description?: string
  /**
   * 遂行先 project ID です。未指定なら未アサインです。
   */
  assignedProjectId?: string
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId: string
  /**
   * Issue の状態コードです。
   */
  status: TaskStatus
  /**
   * 期限日として保存する文字列です。
   */
  dueDate: string
  /**
   * 優先度コードです。
   */
  priority: TaskPriority
}

/**
 * チーム所有 Issue 更新 API へ送信する入力です。
 */
export type UpdateTeamIssueInput = {
  /**
   * Issue タイトルです。
   */
  title?: string
  /**
   * Issue 詳細説明です。
   */
  description?: string
  /**
   * 遂行先 project ID です。null または空文字で未アサインへ戻します。
   */
  assignedProjectId?: string | null
  /**
   * Cognito user を参照する担当者 ID です。
   */
  assigneeUserId?: string
  /**
   * Issue の状態コードです。
   */
  status?: TaskStatus
  /**
   * 期限日として保存する文字列です。
   */
  dueDate?: string
  /**
   * 優先度コードです。
   */
  priority?: TaskPriority
}

/**
 * Lambda が DynamoDB から取得して返すチーム Issue 一覧レスポンスです。
 */
type TeamIssuesResponse = {
  /**
   * 取得対象の team ID です。
   */
  teamId: string
  /**
   * チーム所有 Issue 一覧です。
   */
  issues: TeamIssue[]
}

/**
 * Lambda が DynamoDB から取得して返すプロジェクト Issue 一覧レスポンスです。
 */
type ProjectIssuesResponse = {
  /**
   * 取得対象の project ID です。
   */
  projectId: string
  /**
   * プロジェクトにアサインされた Issue 一覧です。
   */
  issues: TeamIssue[]
}

/**
 * Issue 作成 API が返す response body です。
 */
type CreateTeamIssueResponse = {
  /**
   * 作成された Issue 行です。
   */
  issue: TeamIssue
}

/**
 * Issue 更新 API が返す response body です。
 */
type UpdateTeamIssueResponse = {
  /**
   * 更新された Issue 行です。
   */
  issue: TeamIssue
}

/**
 * Issue コメント作成 API が返す response body です。
 */
type CreateTeamIssueCommentResponse = {
  /**
   * 作成されたコメントです。
   */
  comment: TeamIssueComment
  /**
   * コメント作成に対応する活動履歴です。
   */
  activity: TeamIssueActivity
}

/**
 * Lambda API からエラーレスポンスが返ったときに投げる例外です。
 */
export class TeamIssuesApiError extends Error {
  /**
   * API レスポンスの HTTP status code です。
   */
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

const issuesApiBaseUrl = trimTrailingSlash(
  import.meta.env.VITE_TASKS_API_BASE_URL ?? import.meta.env.VITE_API_BASE_URL ?? '/api',
)

/**
 * DynamoDB に保存されたチーム所有 Issue を Lambda API 経由で取得します。
 */
export async function getTeamIssues(teamId: string, accessToken?: string) {
  const response = await requestJson<TeamIssuesResponse>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues`,
    accessToken,
  )

  return response.issues
}

/**
 * DynamoDB に保存されたプロジェクト遂行 Issue を Lambda API 経由で取得します。
 */
export async function getProjectIssues(projectId: string, accessToken?: string) {
  const response = await requestJson<ProjectIssuesResponse>(
    `${issuesApiBaseUrl}/projects/${encodeURIComponent(projectId)}/issues`,
    accessToken,
  )

  return response.issues
}

/**
 * DynamoDB に保存されたチーム所有 Issue 詳細を Lambda API 経由で取得します。
 */
export async function getTeamIssueDetail(
  teamId: string,
  issueId: string,
  accessToken?: string,
) {
  return requestJson<TeamIssueDetail>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`,
    accessToken,
  )
}

/**
 * DynamoDB にチーム所有 Issue を作成します。
 */
export async function createTeamIssue(
  teamId: string,
  accessToken: string,
  input: CreateTeamIssueInput,
) {
  const response = await requestJson<CreateTeamIssueResponse>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    },
  )

  return response.issue
}

/**
 * DynamoDB に保存されたチーム所有 Issue を更新します。
 */
export async function updateTeamIssue(
  teamId: string,
  issueId: string,
  accessToken: string,
  input: UpdateTeamIssueInput,
) {
  const response = await requestJson<UpdateTeamIssueResponse>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}`,
    accessToken,
    {
      body: JSON.stringify(input),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'PATCH',
    },
  )

  return response.issue
}

/**
 * DynamoDB にチーム所有 Issue コメントを作成します。
 */
export async function createTeamIssueComment(
  teamId: string,
  issueId: string,
  accessToken: string,
  body: string,
) {
  return requestJson<CreateTeamIssueCommentResponse>(
    `${issuesApiBaseUrl}/teams/${encodeURIComponent(teamId)}/issues/${encodeURIComponent(issueId)}/comments`,
    accessToken,
    {
      body: JSON.stringify({ body }),
      headers: {
        'Content-Type': 'application/json',
      },
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
    throw new TeamIssuesApiError(response.status, readErrorMessage(data))
  }

  return data as TResponse
}

function readErrorMessage(data: unknown) {
  return typeof data === 'object' &&
    data !== null &&
    'message' in data &&
    typeof data.message === 'string'
    ? data.message
    : 'issues.error.loading'
}

async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text()

  if (!text) {
    return {} as T
  }

  return JSON.parse(text) as T
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '')
}
